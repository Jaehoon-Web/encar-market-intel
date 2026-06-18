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
import re
import csv
import time
import random
import argparse
import logging
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

# ─────────────────────────────────────────────────────
#  API 페이지네이션 실제 한계: ~10,000 unique/쿼리
#  해결책: 각 서브쿼리가 10k 미만이 되도록 지역×제조사×연료 조합
# ─────────────────────────────────────────────────────

# 전국 17개 지역
ALL_REGIONS = [
    "서울", "경기", "인천", "부산", "대구", "경남", "광주",
    "대전", "전북", "충남", "울산", "충북", "경북", "전남",
    "강원", "제주", "세종",
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


def build_subqueries() -> List[Dict]:
    q_list = []

    def add(tab: str, label: str, q: str):
        q_list.append({"tab": tab, "label": label, "q": q})

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 국산 (domestic)
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    # ── 현대·기아 (경기 제외) ─ 지역별 단순 쿼리
    for mfr in ["현대", "기아", "제네시스"]:
        for region in NON_GYEONGGI:
            add("domestic", f"국산_{mfr}_{region}",
                _dom_mfr_region(mfr, region))

    # ── 현대·기아 경기 ─ GreenType + FuelType 세분화
    for mfr in ["현대", "기아"]:
        # 친환경 (EV/HEV) 경기 → 단일 쿼리
        add("domestic", f"국산_{mfr}_경기_친환경",
            _dom_mfr_region_green(mfr, "경기", "Y"))
        # 비친환경 경기 → 연료별 분리
        for fuel, flabel in [
            ("가솔린",         "가솔린"),
            ("디젤",           "디젤"),
            ("LPG(일반인 구입)", "LPG"),
        ]:
            add("domestic", f"국산_{mfr}_경기_비친환경_{flabel}",
                _dom_mfr_region_green_fuel(mfr, "경기", "N", fuel))

    # 제네시스 경기 → 단일 쿼리 (6.7k, 한계 이내)
    add("domestic", "국산_제네시스_경기",
        _dom_mfr_region("제네시스", "경기"))

    # ── KG모빌리티(쌍용) ─ 지역별 분리 (전국 10,693 > 10k 한계)
    for region in ALL_REGIONS:
        add("domestic", f"국산_KG모빌리티_{region}",
            _dom_mfr_region("KG모빌리티(쌍용)", region))

    # ── 르노코리아(삼성) ─ 전국 단일 쿼리 (7,977 < 10k)
    add("domestic", "국산_르노코리아_전국",
        "(And.Hidden.N._.CarType.Y._.Manufacturer.르노코리아(삼성).)")

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # 수입 (imported)
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    # ── 벤츠·BMW ─ GreenType.Y 단일 + GreenType.N 지역별
    for mfr in ["벤츠", "BMW"]:
        add("imported", f"수입_{mfr}_친환경", _imp_mfr_green(mfr, "Y"))
        for region in ALL_REGIONS:
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
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def save_csv(rows: List[Dict], path: Path):
    if not rows:
        return
    keys = list(rows[0].keys())
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    log.info(f"저장: {path}  ({len(rows):,}행)")


def progress(iterable, **kwargs):
    if tqdm:
        return tqdm(iterable, **kwargs)
    return iterable


async def async_progress(coros, **kwargs):
    if atqdm:
        return await atqdm.gather(*coros, **kwargs)
    return await asyncio.gather(*coros)


async def fetch(session: aiohttp.ClientSession, url: str,
                params: dict = None, headers: dict = None,
                as_json: bool = False) -> Optional[Any]:
    """재시도 포함 HTTP GET"""
    h = headers or HEADERS
    for attempt in range(MAX_RETRY):
        try:
            async with session.get(
                url, params=params, headers=h,
                timeout=aiohttp.ClientTimeout(total=30)
            ) as resp:
                if resp.status == 429:
                    wait = 60 * (attempt + 1)
                    log.warning(f"Rate limit → {wait}s 대기")
                    await asyncio.sleep(wait)
                    continue
                if resp.status in (301, 302, 307, 308):
                    # 리다이렉트 추적 (fem → encar 메인으로 가는 경우)
                    loc = resp.headers.get("Location", "")
                    if "encar.com/index" in loc:
                        return None  # 차량 삭제됨
                if resp.status != 200:
                    return None
                if as_json:
                    return await resp.json(content_type=None)
                return await resp.text(encoding="utf-8")
        except asyncio.TimeoutError:
            log.debug(f"Timeout (시도 {attempt+1}): {url}")
        except aiohttp.ClientError as e:
            log.debug(f"ClientError (시도 {attempt+1}): {e}")
        await asyncio.sleep(1.5 ** attempt)
    return None


# ─────────────────────────────────────────────────────
#  1단계: 전체 차량 ID 수집
# ─────────────────────────────────────────────────────
async def fetch_list_page(session: aiohttp.ClientSession,
                          query: str, offset: int) -> Optional[dict]:
    params = {
        "count": "true",
        "q": query,
        "sr": f"|ModifiedDate|{offset}|{PAGE_SIZE}",
    }
    return await fetch(session, LIST_API, params=params, as_json=True)


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


async def collect_subquery(session: aiohttp.ClientSession,
                           sub: dict) -> List[dict]:
    """
    단일 서브쿼리에 대한 ID 수집.
    MAX_OFFSET 초과 시 경고 로그 출력 (누락 가능성).
    """
    label = sub["label"]
    query = sub["q"]
    tab   = sub["tab"]
    cache = OUTPUT_DIR / f"ids_{label}.json"

    if cache.exists():
        data = load_json(cache)
        log.info(f"[{label}] 캐시: {len(data):,}대")
        return data

    # 총 개수 확인
    first = await fetch_list_page(session, query, 0)
    if not first:
        log.warning(f"[{label}] API 실패, 건너뜀")
        return []

    total = first.get("Count", 0)
    if total == 0:
        save_json([], cache)
        return []

    if total > MAX_OFFSET + PAGE_SIZE:
        log.warning(f"[{label}] 총 {total:,}대 → 한계({MAX_OFFSET:,}) 초과! 일부 누락될 수 있음")

    effective_total = min(total, MAX_OFFSET)
    offsets = list(range(0, effective_total, PAGE_SIZE))
    log.info(f"[{label}] {total:,}대 → {len(offsets)}페이지 수집")

    results: List[dict] = []
    seen_ids: set = set()
    sem = asyncio.Semaphore(CONCURRENCY_LIST)

    async def fetch_page(offset: int) -> List[dict]:
        async with sem:
            await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
            data = await fetch_list_page(session, query, offset)
            if not data:
                return []
            return [_parse_list_item(c, tab) for c in data.get("SearchResults", [])]

    # 순차 처리로 중복 조기 감지
    consecutive_dupe_pages = 0
    for offset in offsets:
        page_items = await fetch_page(offset)
        new_items = []
        for item in page_items:
            if item["id"] not in seen_ids:
                seen_ids.add(item["id"])
                new_items.append(item)

        if page_items and len(new_items) == 0:
            consecutive_dupe_pages += 1
            if consecutive_dupe_pages >= 3:
                log.warning(f"[{label}] offset={offset:,}에서 중복 감지 → 조기 종료")
                break
        else:
            consecutive_dupe_pages = 0
            results.extend(new_items)

    save_json(results, cache)
    log.info(f"[{label}] 완료: {len(results):,}대 (unique)")
    return results


async def stage1_collect_ids(fresh: bool = False) -> List[dict]:
    merged = OUTPUT_DIR / "ids_all.json"
    if merged.exists() and not fresh:
        data = load_json(merged)
        log.info(f"전체 ID 캐시 로드: {len(data):,}대  (새로 수집하려면 --fresh 사용)")
        return data
    if fresh and merged.exists():
        merged.unlink()
        log.info("--fresh 모드: ids_all.json 삭제 후 재수집 시작")

    connector = aiohttp.TCPConnector(limit=10)
    async with aiohttp.ClientSession(connector=connector) as session:
        all_items: List[dict] = []
        for sub in SUB_QUERIES:
            items = await collect_subquery(session, sub)
            all_items.extend(items)
            await asyncio.sleep(1.0)  # 서브쿼리 사이 휴식

    # 전체 중복 제거 (동일 ID가 여러 서브쿼리에 중복 가능)
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


async def fetch_detail_one(session: aiohttp.ClientSession,
                           car_info: dict,
                           sem: asyncio.Semaphore) -> dict:
    cid = car_info["id"]
    async with sem:
        await asyncio.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        html = await fetch(session, DETAIL_BASE.format(cid),
                           headers={**HEADERS, "Accept": "text/html"})

    if not html:
        return {**car_info, "detail_crawled": False,
                "first_reg_date": "", "simple_repair": "",
                "outer_panel": "", "main_frame": "",
                "detail_condition": "", "inspector_note": "",
                "inspect_crawled": False}

    state = _parse_preloaded_state(html)
    if not state:
        log.debug(f"PRELOADED_STATE 파싱 실패: {cid}")
        return {**car_info, "detail_crawled": False,
                "first_reg_date": "", "simple_repair": "",
                "outer_panel": "", "main_frame": "",
                "detail_condition": "", "inspector_note": "",
                "inspect_crawled": False}

    return _extract_from_state(cid, state, car_info)


async def stage2_collect_details(car_list: List[dict],
                                 limit: Optional[int] = None) -> List[dict]:
    done_path    = OUTPUT_DIR / "details_done_ids.json"
    result_path  = OUTPUT_DIR / "details.json"

    done_ids   = set(load_json(done_path) or [])
    existing   = {r["vehicle_id"]: r for r in (load_json(result_path) or [])}

    if limit:
        car_list = car_list[:limit]

    pending = [c for c in car_list if c["id"] not in done_ids]
    log.info(f"상세 수집 대상: {len(pending):,}대  (완료: {len(done_ids):,}대)")

    if not pending:
        return list(existing.values())

    sem = asyncio.Semaphore(CONCURRENCY_DETAIL)
    connector = aiohttp.TCPConnector(limit=30, force_close=False)

    async with aiohttp.ClientSession(connector=connector) as session:
        BATCH = 1000
        for batch_start in range(0, len(pending), BATCH):
            batch = pending[batch_start: batch_start + BATCH]
            tasks = [fetch_detail_one(session, c, sem) for c in batch]

            label = f"상세 [{batch_start+1}~{min(batch_start+BATCH, len(pending))}]"
            if atqdm:
                results = []
                for fut in atqdm(asyncio.as_completed(tasks),
                                 total=len(tasks), desc=label):
                    r = await fut
                    results.append(r)
            else:
                results = await asyncio.gather(*tasks)

            for r in results:
                vid = r.get("vehicle_id", r.get("id"))
                existing[str(vid)] = r
                done_ids.add(r.get("id", vid))

            # 배치마다 중간 저장
            all_rows = list(existing.values())
            save_json(all_rows, result_path)
            save_json(list(done_ids), done_path)
            save_csv(all_rows, OUTPUT_DIR / "encar_details.csv")
            log.info(f"중간 저장: {len(all_rows):,}대")

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
                             sem: asyncio.Semaphore) -> dict:
    """단일 차량 성능점검기록부 API 호출"""
    vid = str(car.get("vehicle_id", car.get("id", "")))
    empty = {
        "vehicle_id": vid, "first_reg_date": "", "simple_repair": "",
        "outer_panel": "", "main_frame": "", "detail_condition": "",
        "inspector_note": "", "inspect_crawled": False,
    }
    async with sem:
        await asyncio.sleep(random.uniform(0.3, 0.8))
        data = await fetch(session, INSPECT_API.format(vid), as_json=True)
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
    connector = aiohttp.TCPConnector(limit=30, force_close=False)

    async with aiohttp.ClientSession(connector=connector) as session:
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

            for r in results:
                vid = str(r.get("vehicle_id", ""))
                if vid:
                    inspect_map[vid] = r
                    done_ids.add(vid)

            save_json(inspect_map, inspect_path)
            save_json(list(done_ids), done_path)
            log.info(f"성능점검 중간저장: {len(inspect_map):,}대")

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
