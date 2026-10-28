"""
엔카(encar.com) 중고차 전체 크롤러
=====================================
수집 탭: 국산 / 수입 / 전기·친환경

[1단계] List API  → 전체 차량 ID + 기본 정보 수집
[2단계] SSR 파싱  → fem.encar.com 상세 페이지 __PRELOADED_STATE__ 추출
[3단계] Playwright → 성능점검기록부 (외판/골격/특기사항 등) 수집

수집 필드:
    차대번호, 차량번호, 제조사, 모델, 연식, 주행거리, 지역, 사용연료,
    변속기, 색상, 차량출고가(소비자가), 엔카판매가, 주요옵션,
    사고이력플래그, 성능점검유무,
    [3단계] 최초등록일, 단순수리, 외판상태, 주요골격, 자동차세부상태,
            특기사항및점검자의견

설치:
    pip install aiohttp aiofiles tqdm pandas playwright
    playwright install chromium

실행:
    python crawler.py --stage 1          # ID 수집만
    python crawler.py --stage 2          # 기본 상세 수집
    python crawler.py --stage 3          # 성능점검기록부 수집
    python crawler.py --stage all        # 전체 실행
    python crawler.py --stage 2 --limit 100  # 테스트: 100대만
"""

import asyncio
import aiohttp
import json
import os
import re
import csv
import time
import random
import argparse
import logging
from collections import Counter
from pathlib import Path
from typing import Optional, Dict, Any, List

try:
    from tqdm.asyncio import tqdm as atqdm
    from tqdm import tqdm
except ImportError:
    atqdm = tqdm = None

from option_codes import decode_options

# ─────────────────────────────────────────────────────
#  설정값
# ─────────────────────────────────────────────────────
LIST_API     = "https://api.encar.com/search/car/list/general"
DETAIL_BASE  = "https://fem.encar.com/cars/detail/{}"
INSPECT_BASE = "https://fem.encar.com/cars/report/inspect/{}"

OUTPUT_DIR = Path("encar_output")
OUTPUT_DIR.mkdir(exist_ok=True)

PAGE_SIZE          = 100   # 리스트 API 페이지 크기
CONCURRENCY_LIST   = 5     # 리스트 API 동시 요청
CONCURRENCY_DETAIL = 8     # 상세 페이지 동시 요청
CONCURRENCY_INSPECT = 20   # aiohttp 동시 요청 수
DELAY_MIN  = 0.5
DELAY_MAX  = 1.2
MAX_RETRY  = 3
# 2단계: 한 배치(1000대)에서 네트워크 실패가 이 비율 이상이면 세션(연결)을 새로 만들고 잠시 대기 후 계속
NET_FAIL_PAUSE_RATIO = 0.5
NET_FAIL_PAUSE_SEC   = 300
# 위 상황이 이 횟수만큼 연속되면 2단계 중단(exit 3) → 이후 단계(이력·빌드·배포) 진행 안 함, --resume 으로 재개
NET_FAIL_MAX_CONSEC  = 3

# ─────────────────────────────────────────────────────
#  API 페이지네이션 실제 한계: ~10,000 unique/쿼리
#  해결책: 각 서브쿼리가 10k 미만이 되도록 지역×제조사×연료 조합
#  (그래도 넘는 조회는 1단계가 첫 페이지 대수를 보고 자동으로 더 나눔 → SPLIT_LIMIT)
# ─────────────────────────────────────────────────────

# 전국 지역값 (목록 API OfficeCityState 값 그대로)
#  '전남광주': 2026-07 사이 광주·전남 매물 대부분이 이 값으로 바뀜. 7/29 회차부터 광주·전남 조회가
#  1/10로 줄어든 원인이고, 지역별로 나눠 받는 제조사(현대·기아·제네시스·KG·벤츠·BMW)에서 빠져 있었다.
#  목록에 여기 없는 지역값이 보이면 1단계가 같은 회차에 그 지역 조회를 추가한다(_discover_regions).
ALL_REGIONS = [
    "서울", "경기", "인천", "부산", "대구", "경남", "광주",
    "대전", "전북", "충남", "울산", "충북", "경북", "전남",
    "강원", "제주", "세종", "전남광주",
]
# 경기 제외 지역
NON_GYEONGGI = [r for r in ALL_REGIONS if r != "경기"]


def _q(base: str, *extra: str) -> str:
    """RYVUSS 쿼리 생성 헬퍼"""
    parts = base.rstrip(".").lstrip("(") + "." + "._.".join(extra) + ".)"
    return "(" + parts


def _dom_region(region: str) -> str:
    return f"(And.Hidden.N._.CarType.Y._.OfficeCityState.{region}.)"


def _dom_mfr_region(mfr: str, region: str) -> str:
    return f"(And.Hidden.N._.CarType.Y._.Manufacturer.{mfr}._.OfficeCityState.{region}.)"


def _dom_mfr_region_green(mfr: str, region: str, green: str) -> str:
    return f"(And.Hidden.N._.CarType.Y._.Manufacturer.{mfr}._.OfficeCityState.{region}._.GreenType.{green}.)"


def _dom_mfr_region_green_fuel(mfr: str, region: str, green: str, fuel: str) -> str:
    return f"(And.Hidden.N._.CarType.Y._.Manufacturer.{mfr}._.OfficeCityState.{region}._.GreenType.{green}._.FuelType.{fuel}.)"


def _imp_mfr(mfr: str) -> str:
    return f"(And.Hidden.N._.CarType.N._.Manufacturer.{mfr}.)"


def _imp_mfr_green(mfr: str, green: str) -> str:
    return f"(And.Hidden.N._.CarType.N._.Manufacturer.{mfr}._.GreenType.{green}.)"


def _imp_mfr_green_region(mfr: str, green: str, region: str) -> str:
    return f"(And.Hidden.N._.CarType.N._.Manufacturer.{mfr}._.GreenType.{green}._.OfficeCityState.{region}.)"


def _and(q: str, cond: str) -> str:
    """조회식 끝에 조건 하나를 더함: (And.….)  →  (And.…._.cond.)"""
    return q[:-1] + "_." + cond + ".)"


def build_subqueries(regions: Optional[List[str]] = None) -> List[Dict]:
    regions = regions or ALL_REGIONS
    non_gyeonggi = [r for r in regions if r != "경기"]
    q_list = []

    def add(tab: str, label: str, q: str):
        q_list.append({"tab": tab, "label": label, "q": q})

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 국산 (domestic)
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    # ── 현대·기아 (경기 제외) ─ 지역별 단순 쿼리
    for mfr in ["현대", "기아", "제네시스"]:
        for region in non_gyeonggi:
            add("domestic", f"국산_{mfr}_{region}",
                _dom_mfr_region(mfr, region))

    # ── 현대·기아 경기 ─ GreenType + FuelType 세분화
    for mfr in ["현대", "기아"]:
        # 친환경 (EV/HEV) 경기 → 단일 쿼리
        add("domestic", f"국산_{mfr}_경기_친환경",
            _dom_mfr_region_green(mfr, "경기", "Y"))
        # 비친환경 경기 → 연료별 분리 (가솔린+LPG·기타는 그동안 빠져 있던 소수 연료)
        for fuel, flabel in [
            ("가솔린",         "가솔린"),
            ("디젤",           "디젤"),
            ("LPG(일반인 구입)", "LPG"),
            ("가솔린+LPG",     "가솔린LPG"),
            ("기타",           "기타연료"),
        ]:
            add("domestic", f"국산_{mfr}_경기_비친환경_{flabel}",
                _dom_mfr_region_green_fuel(mfr, "경기", "N", fuel))

    # 제네시스 경기 → 단일 쿼리 (6.7k, 한계 이내)
    add("domestic", "국산_제네시스_경기",
        _dom_mfr_region("제네시스", "경기"))

    # ── KG모빌리티(쌍용) ─ 지역별 분리 (전국 10,693 > 10k 한계)
    for region in regions:
        add("domestic", f"국산_KG모빌리티_{region}",
            _dom_mfr_region("KG모빌리티(쌍용)", region))

    # ── 르노코리아(삼성) ─ 전국 단일 쿼리 (7,977 < 10k)
    add("domestic", "국산_르노코리아_전국",
        "(And.Hidden.N._.CarType.Y._.Manufacturer.르노코리아(삼성).)")

    # ── 쉐보레(GM대우) ─ 전국 단일 쿼리 (2026-10-27 7,869 < 10k, 9,000을 넘으면 1단계가 지역별로 자동 분할)
    #    2026-10까지 조회가 없어 스파크·말리부·트랙스 등이 빠지고 전기차만 친환경_국산으로 들어왔다
    add("domestic", "국산_쉐보레_전국",
        "(And.Hidden.N._.CarType.Y._.Manufacturer.쉐보레(GM대우).)")

    # ── 기타 제조사(국산) ─ 전국 단일 쿼리 (2026-10 목록에는 친환경_국산으로 들어온 10대만 보임)
    add("domestic", "국산_기타제조사_전국",
        "(And.Hidden.N._.CarType.Y._.Manufacturer.기타 제조사.)")

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 수입 (imported)
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    # ── 벤츠·BMW ─ GreenType.Y 단일 + GreenType.N 지역별
    for mfr in ["벤츠", "BMW"]:
        add("imported", f"수입_{mfr}_친환경", _imp_mfr_green(mfr, "Y"))
        for region in regions:
            add("imported", f"수입_{mfr}_비친환경_{region}",
                _imp_mfr_green_region(mfr, "N", region))

    # ── 아우디 ─ GreenType별 (아우디 전체 ~5.7k)
    add("imported", "수입_아우디_친환경", _imp_mfr_green("아우디", "Y"))
    add("imported", "수입_아우디_비친환경", _imp_mfr_green("아우디", "N"))

    # ── 나머지 수입 브랜드 ─ 전국 단일 쿼리
    other_imports = [
        "볼보", "포르쉐", "렉서스", "도요타", "혼다", "포드",
        "랜드로버", "미니", "폭스바겐", "재규어",
        "링컨", "캐딜락", "푸조", "마세라티", "페라리",
        "람보르기니", "벤틀리", "롤스로이스", "시트로엥",
        "닛산", "인피니티", "쉐보레", "알파 로메오", "지프",
        "닷지", "크라이슬러", "사브",
        # 2026-10 목록에 친환경_수입으로만 들어오던 브랜드 (비친환경 모델은 빠져 있었음)
        "테슬라", "폴스타", "BYD", "GMC", "맥라렌", "로터스",
        "피아트", "스마트", "지리", "신위안", "동풍소콘",
    ]
    for mfr in other_imports:
        add("imported", f"수입_{mfr}", _imp_mfr(mfr))

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 전기·친환경 (eco) ─ 국산/수입 분리
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    add("eco", "친환경_국산", "(And.Hidden.N._.GreenType.Y._.CarType.Y.)")
    add("eco", "친환경_수입", "(And.Hidden.N._.GreenType.Y._.CarType.N.)")

    return q_list


SUB_QUERIES = build_subqueries()

CATEGORIES = {
    "domestic": "(And.Hidden.N._.CarType.Y.)",
    "imported": "(And.Hidden.N._.CarType.N.)",
    "eco":      "(And.Hidden.N._.GreenType.Y.)",
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
    "Referer": "https://www.encar.com/",
}

# ─────────────────────────────────────────────────────
#  로깅
# ─────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(OUTPUT_DIR / "crawler.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────
#  유틸리티
# ─────────────────────────────────────────────────────
def load_json(path: Path) -> Any:
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return None


def save_json(data: Any, path: Path):
    # 원자적 저장: 임시파일에 쓴 뒤 교체 → 저장 중 강제종료돼도 원본 보존
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def save_csv(rows: List[Dict], path: Path):
    if not rows:
        return
    keys = list(rows[0].keys())
    # 원자적 저장: 임시파일에 쓴 뒤 교체
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    log.info(f"저장: {path}  ({len(rows):,}행)")


def progress(iterable, **kwargs):
    if tqdm:
        return tqdm(iterable, **kwargs)
    return iterable


async def async_progress(coros, **kwargs):
    if atqdm:
        return await atqdm.gather(*coros, **kwargs)
    return await asyncio.gather(*coros)


_last_net_error = ""   # 마지막 네트워크 오류 요약 (실패율 높은 배치의 원인 로그용)


async def _fetch_raw(session: aiohttp.ClientSession, url: str,
                     params: dict = None, headers: dict = None,
                     as_json: bool = False, info: dict = None) -> tuple:
    """재시도 포함 HTTP GET → (결과, 일시적실패여부)
    일시적실패=True : 타임아웃·연결오류 재시도 소진, 429 소진, 5xx/403/408 → 다음에 다시 시도할 대상
    일시적실패=False: 성공, 또는 삭제 리다이렉트·404 등 영구적인 응답
    info(dict)를 주면 마지막 응답의 status·최종 url·리다이렉트 여부를 채운다 (상세 실패 원인 구분용)"""
    global _last_net_error
    h = headers or HEADERS
    for attempt in range(MAX_RETRY):
        try:
            async with session.get(
                url, params=params, headers=h,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if info is not None:
                    info.update(status=resp.status, url=str(resp.url),
                                redirected=bool(resp.history) or resp.status in (301, 302, 307, 308))
                if resp.status == 429:
                    wait = 60 * (attempt + 1)
                    log.warning(f"Rate limit → {wait}s 대기")
                    _last_net_error = "HTTP 429"
                    await asyncio.sleep(wait)
                    continue
                if resp.status in (301, 302, 307, 308):
                    # 리다이렉트 추적 (fem → encar 메인으로 가는 경우)
                    loc = resp.headers.get("Location", "")
                    if "encar.com/index" in loc:
                        return None, False  # 차량 삭제됨
                if resp.status != 200:
                    transient = resp.status >= 500 or resp.status in (403, 408)
                    if transient:
                        _last_net_error = f"HTTP {resp.status}"
                    return None, transient
                if as_json:
                    return await resp.json(content_type=None), False
                return await resp.text(encoding="utf-8"), False
        except asyncio.TimeoutError:
            log.debug(f"Timeout (시도 {attempt+1}): {url}")
            _last_net_error = "Timeout(30s)"
        except aiohttp.ClientError as e:
            log.debug(f"ClientError (시도 {attempt+1}): {e}")
            _last_net_error = f"{type(e).__name__}: {e}"[:200]
        await asyncio.sleep(1.5 ** attempt)
    return None, True


async def fetch(session: aiohttp.ClientSession, url: str,
                params: dict = None, headers: dict = None,
                as_json: bool = False) -> Optional[Any]:
    """재시도 포함 HTTP GET (실패 시 None)"""
    data, _ = await _fetch_raw(session, url, params=params,
                               headers=headers, as_json=as_json)
    return data


# ─────────────────────────────────────────────────────
#  1단계: 전체 차량 ID 수집
# ─────────────────────────────────────────────────────
def _list_params(query: str, offset: int) -> dict:
    return {
        "count": "true",
        "q": query,
        "sr": f"|ModifiedDate|{offset}|{PAGE_SIZE}",
    }


async def fetch_list_page(session: aiohttp.ClientSession,
                          query: str, offset: int) -> Optional[dict]:
    return await fetch(session, LIST_API, params=_list_params(query, offset), as_json=True)


async def fetch_list_count(session: aiohttp.ClientSession, query: str) -> tuple:
    """첫 페이지 → (응답, 일시적실패여부). 나눈 조회의 대수 확인용 — 조건이 거부된 것(영구)과 네트워크 오류(일시)를 구분"""
    try:
        return await _fetch_raw(session, LIST_API, params=_list_params(query, 0), as_json=True)
    except ValueError:      # 200인데 JSON이 아닌 응답
        return None, False


def _parse_list_item(car: dict, category: str) -> dict:
    return {
        "id":           str(car.get("Id", "")),
        "category":     category,
        "manufacturer": car.get("Manufacturer", ""),
        "model":        car.get("Model", ""),
        "badge":        car.get("Badge", ""),
        "badge_detail": car.get("BadgeDetail", ""),
        "year":         car.get("Year", ""),
        "mileage":      car.get("Mileage", ""),
        "price":        car.get("Price", ""),
        "region":       car.get("OfficeCityState", ""),
        "fuel_type":    car.get("FuelType", ""),
        "green_type":   car.get("GreenType", ""),
        "separation":   ",".join(car.get("Separation", [])),
        "condition_flags": ",".join(car.get("Condition", [])),  # Inspection/Record/Resume
    }


MAX_OFFSET = 28000   # 안전한 최대 offset (API 한계 약 30k)

# 1단계 실패 서브쿼리 재시도 라운드 간 대기(초). 테더링 끊김·일시 차단(약 10여 분) 회복용
STAGE1_RETRY_WAITS = [120, 300, 600]

# 조회 1건으로 끝까지 받을 수 있는 대수는 약 1만(offset 10,000부터 앞 결과가 반복 → '중복 감지 → 조기 종료').
# 첫 페이지 대수가 이 값을 넘으면 지역 → 친환경 → 연료 → 연식 순으로 더 나눠 받는다(_collect_split)
SPLIT_LIMIT = 9000
# 직전 회차보다 대수가 이 비율 미만으로 줄면(직전 DROP_MIN_PREV대 이상) 급감으로 보고 재시도 라운드로 미룬다.
# 마지막 라운드까지 그대로면 받아들이고 경고를 남긴다(실제 변화일 수도 있음). 평소 주간 변동은 0.88배 이상
DROP_RATIO    = 0.5
DROP_MIN_PREV = 200
# 조회별 대수 기록(급감 기준·범위 점검). 'ids_'로 시작하지 않아 주간 캐시 삭제 대상이 아니다
QUERY_TOTALS = OUTPUT_DIR / "list_query_totals.json"

# 비친환경 연료 분할 — 목록에 나온 연료값 전부(빠진 값은 합계 점검에서 드러남)
_FUEL_SPLIT_N = [("가솔린", "가솔린"), ("디젤", "디젤"), ("LPG(일반인 구입)", "LPG"),
                 ("가솔린+LPG", "가솔린LPG"), ("가솔린+CNG", "가솔린CNG"), ("기타", "기타연료")]
# 연식(YYYYMM) 분할 — 지역·친환경·연료로 나눠도 넘을 때. 양쪽이 막힌 구간(201800..201912)은 2026-10-27 실제 조회로
# 확인했고, 한쪽이 열린 구간(..201412, 202400..)은 미확인 → 나눈 대수 합계가 전체와 맞지 않으면 원래 조회로 받는다
_YEAR_SPLIT = [("..201412", "연식~2014"), ("201500..201712", "연식2015-2017"),
               ("201800..201912", "연식2018-2019"), ("202000..202112", "연식2020-2021"),
               ("202200..202312", "연식2022-2023"), ("202400..", "연식2024~")]
# 범위 점검: 국산·수입 전체 대수 vs 제조사별 조회 합계 (빠진 제조사·지역·연료가 있으면 차이로 드러남)
_COVERAGE = [("국산", "domestic", "(And.Hidden.N._.CarType.Y.)"),
             ("수입", "imported", "(And.Hidden.N._.CarType.N.)")]
_REGION_OK = re.compile(r"^[가-힣]{2,8}$")


class _ListRun:
    """1단계 회차 상태 — 조회별 대수(직전·이번 회차), 급감·상한·범위 점검 결과 → QUERY_TOTALS"""

    def __init__(self, fresh: bool):
        st = load_json(QUERY_TOTALS) or {}
        self.totals: Dict[str, dict] = st.get("totals", {})
        # 이어받기(--resume)는 중단된 회차를 이어 가므로 회차 표시를 그대로 쓴다
        self.run = st["run"] if st.get("run") and not fresh else time.strftime("%Y-%m-%dT%H:%M:%S")
        same = self.run == st.get("run")
        self.drops: Dict[str, dict] = st.get("drops", {}) if same else {}
        self.capped: Dict[str, dict] = st.get("capped", {}) if same else {}
        self.checks: Dict[str, dict] = st.get("checks", {}) if same else {}
        self.regions = list(ALL_REGIONS)

    def prev(self, label: str) -> Optional[int]:
        e = self.totals.get(label)
        return e["n"] if e and e.get("run") != self.run else None

    def cur(self, label: str) -> Optional[int]:
        e = self.totals.get(label)
        return e["n"] if e and e.get("run") == self.run else None

    def record(self, label: str, n: int, got: int):
        # n = 첫 페이지 대수, got = 실제로 받은 고유 매물 수 (평소에도 2~3% 모자람 → 회차별 추이 확인용)
        self.totals[label] = {"n": n, "got": got, "run": self.run}

    def save(self):
        save_json({"run": self.run, "totals": self.totals, "drops": self.drops,
                   "capped": self.capped, "checks": self.checks}, QUERY_TOTALS)


def _split_spec(q: str, regions: List[str]) -> tuple:
    """더 나눌 기준 → (이름, [(조건, 라벨 접미사)]). 이미 쓴 조건은 건너뛴다"""
    if "OfficeCityState." not in q:
        return "지역", [(f"OfficeCityState.{r}", r) for r in regions]
    if "GreenType." not in q:
        return "친환경", [("GreenType.Y", "친환경"), ("GreenType.N", "비친환경")]
    if "GreenType.N" in q and "FuelType." not in q:
        return "연료", [(f"FuelType.{v}", lab) for v, lab in _FUEL_SPLIT_N]
    if "Year.range" not in q:
        return "연식", [(f"Year.range({v})", lab) for v, lab in _YEAR_SPLIT]
    return None, []


async def _collect_split(session: aiohttp.ClientSession, sub: dict, total: int,
                         run: _ListRun, accept_drop: bool) -> Optional[tuple]:
    """대수가 SPLIT_LIMIT를 넘는 조회를 나눠 받는다 → (상태, 목록).
    나눌 기준이 없거나, 나눈 조회가 거부되거나, 나눈 대수 합계가 전체와 10% 넘게 다르면 None
    → 호출한 쪽이 원래 조회로 상한까지 받는다(지금까지와 같은 결과)."""
    label = sub["label"]
    dim, conds = _split_spec(sub["q"], run.regions)
    if not conds:
        log.warning(f"[{label}] {total:,}대 > {SPLIT_LIMIT:,}인데 더 나눌 기준이 없음 → 상한까지만 수집")
        return None
    children = [{"tab": sub["tab"], "label": f"{label}_{suf}", "q": _and(sub["q"], cond)}
                for cond, suf in conds]
    s = 0
    for ch in children:
        await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        first, transient = await fetch_list_count(session, ch["q"])
        if not first:
            if transient:
                log.warning(f"[{label}] 나눈 조회 {ch['label']} API 실패")
                return "fail", None
            log.warning(f"[{label}] {dim}별로 나눈 조회가 거부됨 → 나누지 않고 상한까지 수집")
            return None
        ch["_first"] = first
        s += first.get("Count", 0)
    if not 0.9 * total <= s <= 1.1 * total:
        log.warning(f"[{label}] {dim}별 합계 {s:,}대가 전체 {total:,}대와 맞지 않음 → 나누지 않고 상한까지 수집")
        return None
    msg = f"[{label}] {total:,}대 > {SPLIT_LIMIT:,} → {dim}별 {len(children)}개로 나눠 수집 (합계 {s:,}대)"
    if abs(s - total) > max(50, total * 0.01):
        log.warning(f"{msg} · 차이 {s - total:+,}대 — 목록에 없는 {dim}값이 있을 수 있음")
    else:
        log.info(msg)
    items: List[dict] = []
    seen: set = set()
    for ch in children:
        st, got = await collect_subquery(session, ch, run, accept_drop)
        if st != "ok":
            return st, None
        for it in got:
            if it["id"] not in seen:
                seen.add(it["id"])
                items.append(it)
        await asyncio.sleep(1.0)
    return "ok", items


async def collect_subquery(session: aiohttp.ClientSession, sub: dict,
                           run: _ListRun, accept_drop: bool = False) -> tuple:
    """
    단일 서브쿼리에 대한 ID 수집 → (상태, 목록). 상태: 'ok' | 'fail' | 'drop'
    MAX_OFFSET 초과 시 경고 로그 출력 (누락 가능성).
    API 실패(첫 페이지 또는 중간 페이지)면 'fail' + 캐시 저장 안 함
    → 부분 수집분이 '완료'로 남아 재고가 과소집계되는 것을 막는다.
    직전 회차보다 대수가 급감하면 'drop'(재시도 라운드로 미룸), accept_drop이면 그대로 받는다.
    대수가 SPLIT_LIMIT를 넘으면 나눠 받는다(_collect_split).
    """
    label = sub["label"]
    query = sub["q"]
    tab   = sub["tab"]
    cache = OUTPUT_DIR / f"ids_{label}.json"

    if cache.exists():
        data = load_json(cache)
        log.info(f"[{label}] 캐시: {len(data):,}대")
        return "ok", data

    # 총 개수 확인 (나눈 조회는 합계 점검 때 받은 첫 페이지를 그대로 쓴다)
    first = sub.pop("_first", None) or await fetch_list_page(session, query, 0)
    if not first:
        log.warning(f"[{label}] API 실패")
        return "fail", None

    total = first.get("Count", 0)
    prev = run.prev(label)
    if prev and prev >= DROP_MIN_PREV and total < prev * DROP_RATIO:
        if not accept_drop:
            log.warning(f"[{label}] 대수 급감: 직전 회차 {prev:,}대 → {total:,}대 → 재시도 라운드로 미룸")
            return "drop", None
        log.warning(f"[{label}] 대수 급감 지속: 직전 회차 {prev:,}대 → {total:,}대 → 그대로 수집(목록 누락 가능)")
        run.drops[label] = {"prev": prev, "now": total}

    if total == 0:
        save_json([], cache)
        run.record(label, 0, 0)
        return "ok", []

    if total > SPLIT_LIMIT:
        res = await _collect_split(session, sub, total, run, accept_drop)
        if res is not None:
            st, items = res
            if st == "ok":
                save_json(items, cache)
                run.record(label, total, len(items))
                log.info(f"[{label}] 완료: {len(items):,}대 (unique, 나눠 받은 합)")
            return st, items

    if total > MAX_OFFSET + PAGE_SIZE:
        log.warning(f"[{label}] 총 {total:,}대 → 한계({MAX_OFFSET:,}) 초과! 일부 누락될 수 있음")

    effective_total = min(total, MAX_OFFSET)
    offsets = list(range(0, effective_total, PAGE_SIZE))
    log.info(f"[{label}] {total:,}대 → {len(offsets)}페이지 수집")

    results: List[dict] = []
    seen_ids: set = set()
    sem = asyncio.Semaphore(CONCURRENCY_LIST)

    async def fetch_page(offset: int) -> Optional[List[dict]]:
        async with sem:
            await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
            data = await fetch_list_page(session, query, offset)
            if not data:
                return None
            return [_parse_list_item(c, tab) for c in data.get("SearchResults", [])]

    # 순차 처리로 중복 조기 감지
    consecutive_dupe_pages = 0
    for offset in offsets:
        page_items = await fetch_page(offset)
        if page_items is None:
            log.warning(f"[{label}] offset={offset:,} 페이지 API 실패 → 부분 수집 폐기")
            return "fail", None
        new_items = []
        for item in page_items:
            if item["id"] not in seen_ids:
                seen_ids.add(item["id"])
                new_items.append(item)

        if page_items and len(new_items) == 0:
            consecutive_dupe_pages += 1
            if consecutive_dupe_pages >= 3:
                log.warning(f"[{label}] offset={offset:,}에서 중복 감지 → 조기 종료 "
                            f"(전체 {total:,}대 중 {len(results):,}대만 수집, 상한)")
                run.capped[label] = {"total": total, "got": len(results)}
                break
        else:
            consecutive_dupe_pages = 0
            results.extend(new_items)

    save_json(results, cache)
    run.record(label, total, len(results))
    log.info(f"[{label}] 완료: {len(results):,}대 (unique)")
    return "ok", results


async def _run_round(session: aiohttp.ClientSession, subs: List[dict], run: _ListRun,
                     results: Dict[str, List[dict]], accept_drop: bool) -> List[dict]:
    """서브쿼리를 한 바퀴 수집 → 다시 해야 할 것(실패·급감) 목록"""
    again = []
    for sub in subs:
        st, items = await collect_subquery(session, sub, run, accept_drop)
        if st == "ok":
            results[sub["label"]] = items
        else:
            sub["_status"] = st
            again.append(sub)
        run.save()
        await asyncio.sleep(1.0)  # 서브쿼리 사이 휴식
    return again


def _discover_regions(results: Dict[str, List[dict]], subs: List[dict], run: _ListRun) -> List[dict]:
    """목록 결과에 ALL_REGIONS 밖 지역값이 있으면 그 지역의 지역별 조회를 만들어 돌려준다(같은 회차에 수집).
    지역별로 나눠 받는 제조사는 새 지역값 매물을 통째로 놓치기 때문(2026-07 '전남광주' 사례)"""
    seen = Counter(it.get("region") or "" for items in results.values() for it in items)
    new = sorted(r for r in seen if r not in run.regions and _REGION_OK.match(r))
    if not new:
        return []
    log.warning("목록에 새 지역값 " + ", ".join(f"{r}({seen[r]:,}대)" for r in new)
                + " → 지역별 조회에 더해 이번 회차에 함께 수집 (crawler.py ALL_REGIONS에 추가 필요)")
    run.regions += new
    known = {s["label"] for s in subs}
    return [dict(s, optional=True) for s in build_subqueries(run.regions) if s["label"] not in known]


async def _coverage_check(session: aiohttp.ClientSession, subs: List[dict], run: _ListRun):
    """국산·수입 전체 대수와 제조사별 조회 합계를 비교해 로그로 남긴다 (빠진 제조사·지역·연료 감지용)"""
    for name, tab, q in _COVERAGE:
        first = await fetch_list_page(session, q, 0)
        if not first:
            log.warning(f"[범위 점검] {name} 전체 대수 조회 실패 → 생략")
            continue
        whole = first.get("Count", 0)
        parts = [run.cur(s["label"]) for s in subs if s["tab"] == tab]
        if None in parts:
            log.info(f"[범위 점검] {name}: 이번 회차 대수가 없는 조회가 있어 생략")
            continue
        got = sum(parts)
        run.checks[name] = {"whole": whole, "sum": got, "gap": whole - got}
        msg = f"[범위 점검] {name} 전체 {whole:,}대 · 조회 합계 {got:,}대 · 차이 {whole - got:+,}대"
        if abs(whole - got) > max(100, whole * 0.005):
            log.warning(msg + " → 빠진 제조사·지역·연료가 있을 수 있음")
        else:
            log.info(msg)
        await asyncio.sleep(1.0)
    run.save()


async def stage1_collect_ids(fresh: bool = False) -> List[dict]:
    merged = OUTPUT_DIR / "ids_all.json"
    if merged.exists() and not fresh:
        data = load_json(merged)
        log.info(f"전체 ID 캐시 로드: {len(data):,}대  (새로 수집하려면 --fresh 사용)")
        return data
    if fresh and merged.exists():
        merged.unlink()
        log.info("--fresh 모드: ids_all.json 삭제 후 재수집 시작")

    run = _ListRun(fresh)
    subs = [dict(s) for s in SUB_QUERIES]
    results: Dict[str, List[dict]] = {}
    connector = aiohttp.TCPConnector(limit=10)
    async with aiohttp.ClientSession(connector=connector) as session:
        pending = await _run_round(session, subs, run, results, accept_drop=False)
        extra = _discover_regions(results, subs, run)
        if extra:
            subs += extra
            pending += await _run_round(session, extra, run, results, accept_drop=False)

        # 실패·급감분만 대기 후 재시도 (성공분은 캐시돼 있어 재조회 안 함). 마지막 라운드는 급감도 그대로 받는다
        for i, wait in enumerate(STAGE1_RETRY_WAITS):
            if not pending:
                break
            n_drop = sum(s.get("_status") == "drop" for s in pending)
            log.warning(f"1단계 실패 서브쿼리 {len(pending) - n_drop}개 · 급감 {n_drop}개 → {wait}초 대기 후 재시도")
            await asyncio.sleep(wait)
            pending = await _run_round(session, pending, run, results,
                                       accept_drop=(i == len(STAGE1_RETRY_WAITS) - 1))

        for sub in pending:
            if sub.get("optional"):
                log.warning(f"[{sub['label']}] 추가 조회 실패 → 이번 회차는 건너뜀")
        failed = [s for s in pending if not s.get("optional")]
        if not failed:
            await _coverage_check(session, subs, run)

    if failed:
        # ids_all.json을 만들지 않고 비정상 종료 → run.py/auto_update가 이후 단계(이력·빌드·배포)를 중단.
        # 성공한 서브쿼리는 캐시돼 있으므로 'python auto_update.py --resume' 로 실패분만 다시 조회된다.
        log.error(f"1단계 실패: 서브쿼리 {len(failed)}개 미수집 → 파이프라인 중단 "
                  f"({', '.join(s['label'] for s in failed[:10])}{' ...' if len(failed) > 10 else ''})")
        raise SystemExit(2)

    if run.drops:
        log.warning("급감한 채 받은 조회: " + ", ".join(
            f"{k} {v['prev']:,}→{v['now']:,}" for k, v in run.drops.items()))
    if run.capped:
        log.warning("1만 건 상한으로 덜 받은 조회: " + ", ".join(
            f"{k} {v['got']:,}/{v['total']:,}" for k, v in run.capped.items()))
    cur = [run.totals[s["label"]] for s in subs if run.cur(s["label"]) is not None]
    n_tot, n_got = sum(e["n"] for e in cur), sum(e.get("got", 0) for e in cur)
    if n_tot:
        log.info(f"조회 대수 합계 {n_tot:,}대 · 받은 고유 매물 합계 {n_got:,}대 ({n_got / n_tot:.1%})")

    # 전체 중복 제거 (동일 ID가 여러 서브쿼리에 중복 가능)
    all_items = [item for items in results.values() for item in items]
    seen: Dict[str, dict] = {}
    for item in all_items:
        cid = item["id"]
        if cid in seen:
            existing_tabs = set(seen[cid]["category"].split(","))
            existing_tabs.add(item["category"])
            seen[cid]["category"] = ",".join(sorted(existing_tabs))
        else:
            seen[cid] = item

    unique = list(seen.values())
    save_json(unique, merged)
    log.info(f"═══ 1단계 완료: {len(unique):,}대 (중복 제거 전: {len(all_items):,}대) ═══")
    return unique


# ─────────────────────────────────────────────────────
#  2단계: 상세 페이지 SSR 파싱
# ─────────────────────────────────────────────────────
_PRELOADED_RE = re.compile(
    r'__PRELOADED_STATE__\s*=\s*(\{[\s\S]+?\})\s*</script>',
)


def _parse_preloaded_state(html: str) -> Optional[dict]:
    m = _PRELOADED_RE.search(html)
    if not m:
        return None
    raw = m.group(1)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 일부 페이지에서 JS 이스케이프 처리 필요
        try:
            raw2 = raw.replace("\\'", "'").replace('\\"', '"')
            return json.loads(raw2)
        except Exception:
            return None


def _extract_from_state(car_id: str, state: dict, base_info: dict) -> dict:
    cars  = state.get("cars", {})
    base  = cars.get("base", {})
    cat   = base.get("category", {})
    spec  = base.get("spec", {})
    adv   = base.get("advertisement", {})
    cond  = base.get("condition", {})
    cont  = base.get("contact", {})
    opts  = base.get("options", {})
    mgmt  = base.get("manage", {})

    # 옵션 코드 → 이름
    std_codes    = opts.get("standard", [])
    etc_codes    = opts.get("etc", [])
    choice_codes = [str(x) for x in opts.get("choice", [])]
    option_names = decode_options(std_codes, etc_codes, choice_codes)

    return {
        # ── 식별
        "vehicle_id":        str(base.get("vehicleId") or car_id),
        "category":          base_info.get("category", ""),
        "condition_flags":   base_info.get("condition_flags", ""),
        # ── 법적 식별 번호
        "vin":               base.get("vin", ""),               # 차대번호
        "vehicle_no":        base.get("vehicleNo", ""),         # 차량번호
        # ── 차량 기본정보
        "manufacturer":      cat.get("manufacturerName", ""),   # 제조사
        "model_group":       cat.get("modelGroupName", ""),     # 모델 그룹
        "model":             cat.get("modelName", ""),          # 모델
        "grade":             cat.get("gradeName", ""),          # 등급
        "grade_detail":      cat.get("gradeDetailName", ""),    # 세부등급
        "year_month":        cat.get("yearMonth", ""),          # 연식(YYYYMM)
        "form_year":         cat.get("formYear", ""),
        "domestic":          cat.get("domestic", ""),
        # ── 스펙
        "mileage":           spec.get("mileage", ""),           # 주행거리(km)
        "displacement":      spec.get("displacement", ""),      # 배기량(cc)
        "transmission":      spec.get("transmissionName", ""),  # 변속기
        "fuel":              spec.get("fuelName", ""),          # 사용연료
        "color":             spec.get("colorName", ""),         # 색상
        "body_type":         spec.get("bodyName", ""),          # 차체형태
        "seat_count":        spec.get("seatCount", ""),
        # ── 가격
        "origin_price":      cat.get("originPrice", ""),        # 출고가(소비자가, 만원)
        "sale_price":        adv.get("price", ""),              # 엔카 판매가(만원)
        # ── 지역
        "region":            cont.get("address", ""),
        # ── 사고/압류/저당
        "accident_record_view":  cond.get("accident", {}).get("recordView", ""),
        "accident_resume_view":  cond.get("accident", {}).get("resumeView", ""),
        "seizing_count":         cond.get("seizing", {}).get("seizingCount", 0),
        "pledge_count":          cond.get("seizing", {}).get("pledgeCount", 0),
        # ── 성능점검 존재 여부
        "inspection_format":     ",".join(cond.get("inspection", {}).get("formats", [])),
        # ── 옵션 (이름으로 변환)
        "options":               option_names,
        "options_std_codes":     ",".join(std_codes),
        # ── 엔카 등록일
        "encar_regist_dt":       mgmt.get("registDateTime", ""),
        # ── 상세 크롤링 여부
        "detail_crawled": True,
        # ── 3단계에서 채워지는 성능점검기록부 필드
        "first_reg_date":    "",  # 최초등록일
        "simple_repair":     "",  # 단순수리
        "outer_panel":       "",  # 외판 상태
        "main_frame":        "",  # 주요골격
        "detail_condition":  "",  # 자동차세부상태
        "inspector_note":    "",  # 특기사항 및 점검자의견
        "inspect_crawled":   False,
    }


# 2단계 상세 실패(네트워크 실패 제외)는 done으로 두되 details_failed.json에 사유·횟수를 남기고,
# 목록에 남아 있으면 다음 회차(새 목록)에 다시 받는다 — 첫 시도 포함 DETAIL_MAX_TRIES회까지.
DETAIL_MAX_TRIES = 3
# 재시도 성공률이 이보다 낮으면(최소 DETAIL_RETRY_CHECK_MIN대 시도 후) 구조적 실패로 보고 그 회차 재시도를 멈춘다
DETAIL_RETRY_CHECK_MIN = 2000
DETAIL_RETRY_MIN_RATE  = 0.05
# 실패 사유별 HTML 표본(원인 확인용, 회차마다 덮어씀) → encar_output/detail_fail_samples/
DETAIL_FAIL_SAMPLES = 3
DETAIL_FAIL_REASONS = {
    "redirect": "리다이렉트(판매완료·삭제 추정)",
    "http":     "HTTP 오류",
    "empty":    "빈 응답(차단 의심)",
    "no_state": "state 없는 페이지(차단·다른 형식)",
    "parse":    "state 파싱 실패",
    "no_car":   "차량 정보 없음(판매완료 추정)",
}
_LEGACY_REASON = "이관(사유 미기록)"
_fail_samples: Counter = Counter()


def _save_fail_sample(why: str, cid: str, html: str, info: dict):
    if _fail_samples[why] >= DETAIL_FAIL_SAMPLES:
        return
    _fail_samples[why] += 1
    d = OUTPUT_DIR / "detail_fail_samples"
    d.mkdir(exist_ok=True)
    head = (f"<!-- id={cid} why={why} status={info.get('status')} url={info.get('url')} "
            f"redirected={info.get('redirected')} at={time.strftime('%Y-%m-%d %H:%M')} -->\n")
    try:
        (d / f"{why}_{_fail_samples[why]}.html").write_text(head + html[:300_000], encoding="utf-8")
    except OSError:
        pass


async def fetch_detail_one(session: aiohttp.ClientSession,
                           car_info: dict,
                           sem: asyncio.Semaphore) -> tuple:
    """→ (car id, 레코드, 실패 사유, 응답 정보). 성공이면 사유 None.
    네트워크 실패면 레코드 None·사유 'net' (done 처리하지 않고 다음 실행 때 재수집).
    그 밖의 실패는 레코드 None·사유 DETAIL_FAIL_REASONS 키 (done + details_failed.json → 다음 회차 재시도).
    응답 정보 = 마지막 응답의 status·최종 url·리다이렉트 여부 (실패 기록에 함께 남김)"""
    cid = car_info["id"]
    info: dict = {}
    try:
        async with sem:
            await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
            html, transient = await _fetch_raw(
                session, DETAIL_BASE.format(cid),
                headers={**HEADERS, "Accept": "text/html"}, info=info)
    except Exception as e:
        log.debug(f"상세 요청 예외: {cid} {e!r}")
        return cid, None, "net", info
    if transient:
        return cid, None, "net", info

    # 판매완료·삭제는 엔카 메인 등 상세가 아닌 주소로 리다이렉트된다(aiohttp가 따라가서 그 페이지를 받음)
    if html is None:
        why = "redirect" if info.get("redirected") else "http"
    elif info.get("redirected") and "/cars/detail/" not in info.get("url", ""):
        why = "redirect"
    elif not html.strip():
        why = "empty"
    elif "__PRELOADED_STATE__" not in html:
        why = "no_state"
    else:
        state = _parse_preloaded_state(html)
        base = ((state or {}).get("cars") or {}).get("base") or {}
        if state is None:
            why = "parse"
        elif not (base.get("category") or {}).get("manufacturerName"):
            why = "no_car"
        else:
            try:
                return cid, _extract_from_state(cid, state, car_info), None, info
            except Exception as e:
                log.debug(f"상세 추출 오류: {cid} {e!r}")
                why = "parse"
    if html:
        _save_fail_sample(why, cid, html, info)
    return cid, None, why, info


def _list_stamp() -> str:
    """지금 목록(ids_all.json)을 받은 시각 — 같은 목록으로 이어받기할 때 실패 ID를 거듭 재시도하지 않는 기준"""
    p = OUTPUT_DIR / "ids_all.json"
    t = p.stat().st_mtime if p.exists() else time.time()
    return time.strftime("%Y-%m-%dT%H:%M", time.localtime(t))


def _migrate_legacy_failures(car_list: List[dict], done_ids: set, existing: dict, failed: dict):
    """details_failed.json 도입 전에는 상세 실패도 done으로만 남았다(2026-10-21 목록 178,714대 중 57,516대).
    그중 대부분은 같은 차의 재등록 광고(새 매물ID)로, 상세 페이지가 원래 매물의 vehicleId를 돌려줘
    상세가 그 ID로 저장돼 있다 → 제조사·모델·주행·가격·연식이 같은 상세 보유 매물이 목록에 있으면 빼고,
    나머지만 실패로 등록해 다음 수집 때 다시 받는다."""
    key = lambda c: (c.get("manufacturer"), c.get("model"), c.get("mileage"), c.get("price"), c.get("year"))
    have = {key(c) for c in car_list if c["id"] in existing}
    legacy = [c for c in car_list if c["id"] in done_ids and c["id"] not in existing]
    n_dup = 0
    for c in legacy:
        if key(c) in have:
            n_dup += 1
        else:
            failed[c["id"]] = {"why": "legacy", "tries": 1, "list": ""}
    log.info(f"[상세 실패 이관] 상세 없이 done인 목록 매물 {len(legacy):,}대 → 재등록 광고 추정 {n_dup:,}대(재시도 안 함) "
             f"· 재시도 등록 {len(legacy) - n_dup:,}대")


async def stage2_collect_details(car_list: List[dict],
                                 limit: Optional[int] = None) -> List[dict]:
    done_path    = OUTPUT_DIR / "details_done_ids.json"
    result_path  = OUTPUT_DIR / "details.json"
    failed_path  = OUTPUT_DIR / "details_failed.json"   # {목록ID: {why, tries, list}} — 상세 실패, 재시도 대상
    alias_path   = OUTPUT_DIR / "details_alias.json"    # {목록ID: vehicleId} — 상세가 다른 매물ID로 저장된 재등록 광고

    done_ids   = set(load_json(done_path) or [])
    existing   = {r["vehicle_id"]: r for r in (load_json(result_path) or []) if "vehicle_id" in r}
    listed     = {c["id"] for c in car_list}
    # 목록에서 빠진(판매된) ID는 정리
    failed = {k: v for k, v in (load_json(failed_path) or {}).items() if k in listed}
    alias  = {k: v for k, v in (load_json(alias_path) or {}).items() if k in listed}
    if not failed_path.exists():
        _migrate_legacy_failures(car_list, done_ids, existing, failed)
    stamp = _list_stamp()

    if limit:
        car_list = car_list[:limit]

    pending = [c for c in car_list if c["id"] not in done_ids]
    log.info(f"상세 수집 대상: {len(pending):,}대  (완료: {len(done_ids):,}대)")

    sem = asyncio.Semaphore(CONCURRENCY_DETAIL)

    def new_session() -> aiohttp.ClientSession:
        return aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=30, force_close=False))

    def save_state():
        save_json(failed, failed_path)
        save_json(alias, alias_path)

    net_fail_total = 0
    consec_bad = 0
    session = None
    landed: Counter = Counter()      # 리다이렉트 도착지별 건수
    BATCH = 1000

    async def run_batches(cars: List[dict], retry: bool) -> Counter:
        """cars를 BATCH대씩 받아 저장 → 결과 집계. retry면 재시도 성공률이 낮을 때 멈춘다"""
        nonlocal session, consec_bad, net_fail_total
        tot: Counter = Counter()
        for batch_start in range(0, len(cars), BATCH):
            batch = cars[batch_start: batch_start + BATCH]
            tasks = [fetch_detail_one(session, c, sem) for c in batch]

            label = f"상세 [{batch_start+1}~{min(batch_start+BATCH, len(cars))}]"
            if atqdm:
                results = []
                for fut in atqdm(asyncio.as_completed(tasks),
                                 total=len(tasks), desc=label):
                    r = await fut
                    results.append(r)
            else:
                results = await asyncio.gather(*tasks)

            b: Counter = Counter()
            for cid, r, why, info in results:
                if why == "net":
                    # 네트워크 실패 → 저장·done 기록 안 함 (다음 실행 때 재수집)
                    b["net"] += 1
                    continue
                done_ids.add(cid)
                if info.get("redirected"):
                    # 리다이렉트 도착지(쿼리·매물ID 제외) 집계 → 판매완료(메인 이동)·다른 매물 상세 이동 구분
                    landed[re.sub(r"/\d+$", "/<id>", info.get("url", "").split("?")[0])] += 1
                if r is None:
                    # 판매완료·차단·파싱 실패 → done + 실패 기록 (목록에 남아 있으면 다음 회차에 재시도)
                    tries = failed.get(cid, {}).get("tries", 0) + 1
                    failed[cid] = {"why": why, "tries": tries, "list": stamp, "status": info.get("status"),
                                   **({"url": info.get("url")} if info.get("redirected") else {})}
                    b["fail"] += 1
                    b[why] += 1
                    continue
                vid = str(r.get("vehicle_id") or cid)
                existing[vid] = r
                done_ids.add(vid)
                failed.pop(cid, None)
                b["ok"] += 1
                if vid != cid:
                    # 같은 차의 다른 광고 → 상세는 원래 매물ID(vehicleId)로 저장됨
                    alias[cid] = vid
                    b["alias"] += 1
            tot.update(b)
            net_fail_total += b["net"]

            # 배치마다 중간 저장
            all_rows = list(existing.values())
            save_json(all_rows, result_path)
            save_json(list(done_ids), done_path)
            save_state()
            save_csv(all_rows, OUTPUT_DIR / "encar_details.csv")
            why_txt = ", ".join(f"{DETAIL_FAIL_REASONS[k]} {b[k]:,}" for k in DETAIL_FAIL_REASONS if b[k])
            log.info(f"중간 저장: {len(all_rows):,}대  (이번 배치 네트워크 실패: {b['net']:,}대 · "
                     f"상세 실패 {b['fail']:,}대{f' [{why_txt}]' if why_txt else ''} · 다른 매물ID로 저장 {b['alias']:,}대)")

            # 실패율이 높으면(테더링 끊김·IP 변경 등) 연결을 새로 만들고 잠시 쉬었다가 계속.
            # 2026-10-20: 테더링 중 세션이 망가져 1시간 넘게 100% 실패한 사례 → 새 연결이면 정상이었음
            has_next = batch_start + BATCH < len(cars)
            if b["net"] >= len(batch) * NET_FAIL_PAUSE_RATIO:
                consec_bad += 1
                log.warning(f"네트워크 실패율 {b['net']/len(batch):.0%} "
                            f"(연속 {consec_bad}/{NET_FAIL_MAX_CONSEC}회, 마지막 오류: {_last_net_error or '-'})")
                if consec_bad >= NET_FAIL_MAX_CONSEC:
                    # 체크포인트는 저장됨. 미완료분을 실패 상태로 배포하지 않도록 파이프라인 중단
                    log.error(f"상세 수집 네트워크 실패 {consec_bad}회 연속 → 2단계 중단 "
                              f"(남은 {len(cars) - batch_start - len(batch):,}대 + 실패분은 --resume 으로 재개)")
                    raise SystemExit(3)
                if has_next:
                    await session.close()
                    log.warning(f"→ 연결(세션) 새로 만들고 {NET_FAIL_PAUSE_SEC}s 대기 후 계속")
                    await asyncio.sleep(NET_FAIL_PAUSE_SEC)
                    session = new_session()
            else:
                consec_bad = 0
            if not retry and b["fail"] >= len(batch) * NET_FAIL_PAUSE_RATIO:
                log.warning(f"상세 실패율 {b['fail']/len(batch):.0%} [{why_txt}] → 차단·페이지 형식 변경 확인 필요 "
                            f"(표본: encar_output/detail_fail_samples)")

            tried = tot["ok"] + tot["fail"]
            if retry and has_next and tried >= DETAIL_RETRY_CHECK_MIN and tot["ok"] < tried * DETAIL_RETRY_MIN_RATE:
                rest = cars[batch_start + BATCH:]
                for c in rest:              # 이번 목록에서는 더 시도하지 않음(횟수는 그대로)
                    failed[c["id"]]["list"] = stamp
                save_state()
                log.warning(f"재시도 성공률 {tot['ok']/tried:.1%} ({tot['ok']:,}/{tried:,}) → 이번 회차 재시도 중단, "
                            f"남은 {len(rest):,}대는 다음 회차에")
                break
        return tot

    try:
        session = new_session()
        if pending:
            r = await run_batches(pending, retry=False)
            log.info(f"상세 신규 결과: 성공 {r['ok']:,}대(다른 매물ID {r['alias']:,}) · 실패 {r['fail']:,}대 "
                     f"· 네트워크 실패 {r['net']:,}대")

        # 지난 회차(다른 목록)에서 실패한 매물 중 아직 목록에 있는 것 재시도
        retry_list = [c for c in car_list
                      if c["id"] in failed and c["id"] in done_ids
                      and failed[c["id"]]["tries"] < DETAIL_MAX_TRIES and failed[c["id"]]["list"] != stamp]
        if retry_list:
            log.info(f"상세 수집 대상: {len(retry_list):,}대  (재시도 · 지난 회차 실패, {DETAIL_MAX_TRIES}회까지)")
            r = await run_batches(retry_list, retry=True)
            log.info(f"상세 재시도 결과: 성공 {r['ok']:,}대(다른 매물ID {r['alias']:,}) · 다시 실패 {r['fail']:,}대 "
                     f"· 네트워크 실패 {r['net']:,}대")
    finally:
        if session is not None:
            await session.close()
        save_state()

    if failed:
        left = Counter(v["why"] for v in failed.values() if v["tries"] < DETAIL_MAX_TRIES)
        gave = sum(v["tries"] >= DETAIL_MAX_TRIES for v in failed.values())
        why_txt = ", ".join(f"{DETAIL_FAIL_REASONS.get(k, _LEGACY_REASON)} {n:,}" for k, n in left.most_common())
        log.info(f"상세 실패 목록: 재시도 대기 {sum(left.values()):,}대{f' ({why_txt})' if why_txt else ''} "
                 f"· {DETAIL_MAX_TRIES}회 실패로 제외 {gave:,}대")
    if landed:
        log.info("상세 리다이렉트 도착지: " + ", ".join(f"{u} {n:,}" for u, n in landed.most_common(5)))
    if net_fail_total:
        log.warning(f"상세 네트워크 실패 {net_fail_total:,}대 → done 미기록, 다음 실행 때 재수집")
    return list(existing.values())


# ─────────────────────────────────────────────────────
#  3단계: 성능점검기록부 API 수집 (직접 JSON API 호출)
#  발견된 엔드포인트: https://api.encar.com/v1/readside/inspection/vehicle/{id}
# ─────────────────────────────────────────────────────

INSPECT_API = "https://api.encar.com/v1/readside/inspection/vehicle/{}"


def _parse_inspect_api(car_id: str, data: dict) -> dict:
    """성능점검기록부 API 응답 파싱"""
    result = {
        "vehicle_id":       str(car_id),
        "first_reg_date":   "",
        "simple_repair":    "",
        "outer_panel":      "",
        "main_frame":       "",
        "detail_condition": "",
        "inspector_note":   "",
        "inspect_crawled":  False,
    }

    master = data.get("master", {})
    detail = master.get("detail", {})

    # 최초등록일
    frd = detail.get("firstRegistrationDate", "")
    if frd and len(frd) == 8:
        result["first_reg_date"] = f"{frd[:4]}-{frd[4:6]}-{frd[6:]}"
    else:
        result["first_reg_date"] = frd

    # 단순수리
    result["simple_repair"] = str(master.get("simpleRepair", ""))

    # 외판 (RANK_ONE) / 주요골격 (RANK_TWO)
    outers = data.get("outers", [])
    outer_parts = []
    frame_parts = []
    for item in outers:
        part_name = item.get("type", {}).get("title", "")
        statuses   = [s.get("title", "") for s in item.get("statusTypes", [])]
        attrs      = item.get("attributes", [])
        entry = f"{part_name}:{','.join(statuses)}"
        if "RANK_TWO" in attrs:
            frame_parts.append(entry)
        else:  # RANK_ONE 또는 기타 → 외판
            outer_parts.append(entry)

    result["outer_panel"] = " | ".join(outer_parts) if outer_parts else ""
    result["main_frame"]  = " | ".join(frame_parts) if frame_parts else ""

    # 자동차세부상태: 불량/이상 항목만 수집
    GOOD_CODES = {"1", "2", "3"}   # 양호/적정/없음 → 정상
    bad_items = []
    def collect_bad(items):
        for item in items:
            st = item.get("statusType", {}) or {}
            code = st.get("code", "")
            title = item.get("type", {}).get("title", "")
            if code and code not in GOOD_CODES:
                bad_items.append(f"{title}:{st.get('title','')}")
            collect_bad(item.get("children", []))
    collect_bad(data.get("inners", []))
    result["detail_condition"] = " | ".join(bad_items) if bad_items else "이상없음"

    # 특기사항/점검자의견
    comments = detail.get("comments", "") or ""
    insp_name = detail.get("inspName", "") or ""
    result["inspector_note"] = f"{comments} [{insp_name}]".strip(" []")

    result["inspect_crawled"] = True
    return result


async def fetch_inspect_one(session: aiohttp.ClientSession,
                             car: dict,
                             sem: asyncio.Semaphore) -> Optional[dict]:
    """단일 차량 성능점검기록부 API 호출.
    네트워크 실패(일시적)면 None → done 처리하지 않고 다음 실행 때 재수집.
    기록부 없음(404 등 영구 응답)·파싱 실패는 빈 레코드로 done 처리."""
    vid = str(car.get("vehicle_id", car.get("id", "")))
    empty = {
        "vehicle_id": vid, "first_reg_date": "", "simple_repair": "",
        "outer_panel": "", "main_frame": "", "detail_condition": "",
        "inspector_note": "", "inspect_crawled": False,
    }
    try:
        async with sem:
            await asyncio.sleep(random.uniform(0.3, 0.8))
            data, transient = await _fetch_raw(session, INSPECT_API.format(vid), as_json=True)
    except Exception as e:
        log.debug(f"[inspect] 요청 예외 {vid}: {e!r}")
        return None
    if transient:
        return None
    if not data:
        return empty
    try:
        return _parse_inspect_api(vid, data)
    except Exception as e:
        log.debug(f"[inspect] 파싱 오류 {vid}: {e}")
        return empty


async def _scrape_inspect_page(page, car_id: str) -> dict:
    """
    렌더링된 성능점검기록부 페이지에서 데이터 추출.
    encar.com의 페이지 구조 변경 시 셀렉터 업데이트 필요.
    """
    result = {
        "vehicle_id":       car_id,
        "first_reg_date":   "",
        "simple_repair":    "",
        "outer_panel":      "",
        "main_frame":       "",
        "detail_condition": "",
        "inspector_note":   "",
        "inspect_crawled":  False,
    }

    try:
        await page.goto(INSPECT_BASE.format(car_id),
                        wait_until="networkidle", timeout=45_000)
        # 페이지 로딩 대기 (React 렌더링)
        await page.wait_for_timeout(2000)
    except Exception as e:
        log.debug(f"[inspect] goto 실패 {car_id}: {e}")
        return result

    try:
        # ── __PRELOADED_STATE__ 시도
        raw = await page.evaluate("window.__PRELOADED_STATE__ ? JSON.stringify(window.__PRELOADED_STATE__) : null")
        if raw:
            state = json.loads(raw)
            insp = state.get("cars", {}).get("inspect", {})
            if insp:
                result.update({
                    "first_reg_date":   insp.get("firstRegistrationDate", ""),
                    "simple_repair":    insp.get("simpleRepair", ""),
                    "outer_panel":      json.dumps(insp.get("outerPanel", {}), ensure_ascii=False),
                    "main_frame":       json.dumps(insp.get("mainFrame", {}), ensure_ascii=False),
                    "detail_condition": json.dumps(insp.get("detailCondition", {}), ensure_ascii=False),
                    "inspector_note":   insp.get("inspectorNote", ""),
                    "inspect_crawled":  True,
                })
                return result

        # ── DOM 직접 파싱 (테이블 형태)
        data = await page.evaluate("""
        () => {
            const result = {};

            // 테이블 전체 순회하여 key-value 추출
            const tables = document.querySelectorAll('table');
            tables.forEach(table => {
                const rows = table.querySelectorAll('tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('th, td');
                    for (let i = 0; i + 1 < cells.length; i += 2) {
                        const key = (cells[i].innerText || '').trim().replace(/\\s+/g, ' ');
                        const val = (cells[i+1].innerText || '').trim().replace(/\\s+/g, ' ');
                        if (key) result[key] = val;
                    }
                });
            });

            // dl/dt/dd 형태
            document.querySelectorAll('dl').forEach(dl => {
                const dts = dl.querySelectorAll('dt');
                const dds = dl.querySelectorAll('dd');
                dts.forEach((dt, i) => {
                    if (dds[i]) result[dt.innerText.trim()] = dds[i].innerText.trim();
                });
            });

            return JSON.stringify(result);
        }
        """)

        if data:
            parsed = json.loads(data)
            # 주요 필드 매핑 (페이지 레이아웃에 따라 조정 필요)
            FIELD_MAP = {
                "최초등록일":     "first_reg_date",
                "등록일":         "first_reg_date",
                "단순수리":       "simple_repair",
                "자동차세부상태": "detail_condition",
                "특기사항":       "inspector_note",
                "점검자의견":     "inspector_note",
            }
            outer_parts = {}
            frame_parts = {}
            for k, v in parsed.items():
                if k in FIELD_MAP:
                    result[FIELD_MAP[k]] = v
                elif any(part in k for part in ["후드", "프론트", "도어", "트렁크", "쿼터", "루프", "사이드"]):
                    outer_parts[k] = v
                elif any(part in k for part in ["크로스멤버", "인사이드", "필러", "패키지트레이", "대쉬", "플로어", "트렁크플로어", "리어"]):
                    frame_parts[k] = v

            if outer_parts:
                result["outer_panel"] = json.dumps(outer_parts, ensure_ascii=False)
            if frame_parts:
                result["main_frame"] = json.dumps(frame_parts, ensure_ascii=False)
            if parsed:
                result["inspect_crawled"] = True

    except Exception as e:
        log.debug(f"[inspect] DOM 파싱 오류 {car_id}: {e}")

    return result


async def stage3_collect_inspect(details: List[dict], limit: Optional[int] = None):
    """성능점검기록부 수집 (aiohttp 직접 API 호출 — Playwright 불필요)"""

    # 성능점검기록부 있는 차량만 대상
    targets = [d for d in details if "TABLE" in str(d.get("inspection_format", ""))]
    log.info(f"성능점검 대상: {len(targets):,}대 (TABLE 포맷)")

    done_path    = OUTPUT_DIR / "inspect_done_ids.json"
    inspect_path = OUTPUT_DIR / "inspect_results.json"
    done_ids     = set(load_json(done_path) or [])
    inspect_map  = load_json(inspect_path) or {}

    pending = [d for d in targets if str(d.get("vehicle_id")) not in done_ids]
    if limit:
        pending = pending[:limit]
    log.info(f"성능점검 잔여: {len(pending):,}대")

    if not pending:
        _merge_inspect(details, inspect_map)
        return

    sem = asyncio.Semaphore(CONCURRENCY_INSPECT)

    def new_session() -> aiohttp.ClientSession:
        return aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=30, force_close=False))

    net_fail_total = 0
    consec_bad = 0
    session = new_session()
    try:
        BATCH = 500
        for i in range(0, len(pending), BATCH):
            batch = pending[i: i + BATCH]
            tasks = [fetch_inspect_one(session, c, sem) for c in batch]

            label = f"성능점검 [{i+1}~{min(i+BATCH, len(pending))}]"
            if atqdm:
                results = []
                for fut in atqdm(asyncio.as_completed(tasks),
                                 total=len(tasks), desc=label):
                    r = await fut
                    results.append(r)
            else:
                results = await asyncio.gather(*tasks)

            batch_net_fail = 0
            for r in results:
                if r is None:
                    # 네트워크 실패 → 저장·done 기록 안 함 (다음 실행 때 재수집)
                    batch_net_fail += 1
                    continue
                vid = str(r.get("vehicle_id", ""))
                if vid:
                    inspect_map[vid] = r
                    done_ids.add(vid)
            net_fail_total += batch_net_fail

            save_json(inspect_map, inspect_path)
            save_json(list(done_ids), done_path)
            log.info(f"성능점검 중간저장: {len(inspect_map):,}대  (이번 배치 네트워크 실패: {batch_net_fail:,}대)")

            # 2단계와 동일: 실패율 높으면 연결 새로 만들고 대기, 연속 NET_FAIL_MAX_CONSEC 회면 중단(exit 3)
            has_next = i + BATCH < len(pending)
            if batch_net_fail >= len(batch) * NET_FAIL_PAUSE_RATIO:
                consec_bad += 1
                log.warning(f"성능점검 네트워크 실패율 {batch_net_fail/len(batch):.0%} "
                            f"(연속 {consec_bad}/{NET_FAIL_MAX_CONSEC}회, 마지막 오류: {_last_net_error or '-'})")
                if consec_bad >= NET_FAIL_MAX_CONSEC:
                    log.error(f"성능점검 네트워크 실패 {consec_bad}회 연속 → 3단계 중단 "
                              f"(남은 {len(pending) - i - len(batch):,}대 + 실패분은 --resume 으로 재개)")
                    raise SystemExit(3)
                if has_next:
                    await session.close()
                    log.warning(f"→ 연결(세션) 새로 만들고 {NET_FAIL_PAUSE_SEC}s 대기 후 계속")
                    await asyncio.sleep(NET_FAIL_PAUSE_SEC)
                    session = new_session()
            else:
                consec_bad = 0
    finally:
        await session.close()

    if net_fail_total:
        log.warning(f"성능점검 네트워크 실패 {net_fail_total:,}대 → done 미기록, 다음 실행 때 재수집")
    _merge_inspect(details, inspect_map)


def _merge_inspect(details: List[dict], inspect_map: dict):
    """성능점검 결과를 details에 병합 후 최종 CSV 저장"""
    for row in details:
        vid = str(row.get("vehicle_id", row.get("id")))
        if vid in inspect_map:
            insp = inspect_map[vid]
            for field in ["first_reg_date", "simple_repair", "outer_panel",
                          "main_frame", "detail_condition", "inspector_note",
                          "inspect_crawled"]:
                row[field] = insp.get(field, row.get(field, ""))

    result_path = OUTPUT_DIR / "details.json"
    save_json(details, result_path)
    save_csv(details, OUTPUT_DIR / "encar_final.csv")
    log.info(f"최종 저장 완료 → encar_final.csv  ({len(details):,}대)")


# ─────────────────────────────────────────────────────
#  메인
# ─────────────────────────────────────────────────────
async def main(stage: str, limit: Optional[int] = None, fresh: bool = False):
    t0 = time.time()
    log.info(f"{'='*50}")
    log.info(f"엔카 크롤러 시작  stage={stage}  limit={limit}  fresh={fresh}")
    log.info(f"{'='*50}")

    car_list: List[dict] = []

    if stage in ("1", "all"):
        car_list = await stage1_collect_ids(fresh=fresh)
        log.info(f"▶ 1단계 완료: {len(car_list):,}대 ID 수집")
    else:
        car_list = load_json(OUTPUT_DIR / "ids_all.json") or []
        if not car_list:
            log.error("ids_all.json 없음 → --stage 1 먼저 실행 필요")
            return
        log.info(f"기존 ID 로드: {len(car_list):,}대")

    details: List[dict] = []

    if stage in ("2", "all"):
        details = await stage2_collect_details(car_list, limit=limit)
        log.info(f"▶ 2단계 완료: {len(details):,}대 상세 수집")
    else:
        details = load_json(OUTPUT_DIR / "details.json") or []
        if not details:
            log.error("details.json 없음 → --stage 2 먼저 실행 필요")
            return
        log.info(f"기존 상세 로드: {len(details):,}대")

    if stage in ("3", "all"):
        await stage3_collect_inspect(details, limit=limit)
        log.info("▶ 3단계 완료: 성능점검기록부 수집")

    elapsed = time.time() - t0
    log.info(f"{'='*50}")
    log.info(f"전체 소요시간: {elapsed/60:.1f}분")
    log.info(f"{'='*50}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="엔카 중고차 크롤러")
    parser.add_argument("--stage",
                        choices=["1", "2", "3", "all"],
                        default="all",
                        help="실행 단계 (1=ID수집 2=상세 3=성능점검 all=전체)")
    parser.add_argument("--limit", type=int, default=None,
                        help="수집 대수 제한 (테스트용, 기본=전체)")
    parser.add_argument("--fresh", action="store_true",
                        help="기존 캐시 무시하고 ID를 새로 수집 (신규 매물 반영)")
    args = parser.parse_args()
    asyncio.run(main(args.stage, args.limit, args.fresh))
