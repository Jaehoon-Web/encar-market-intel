# -*- coding: utf-8 -*-
"""
inspection_score.py — 성능점검 기반 평가 컬럼
  (1) 글로비스 기준 재현: 사고평가점(A~F) · 감점합 · 종합평가점(9~1)  — 글로비스 평가부위별 감점표 기준
  (2) 자체 성능점검점수: 부위×손상 상태가 '같은 모델·차령·주행 대비 가격(잔가)'을 얼마나 낮추는지
      실제 매물로 학습한 가중치로 산출 → 성능감가율(%), 성능점검점수(0~100), 성능등급(9~1)

    python inspection_score.py --fit     # 가중치 재학습 → inspection_score_weights.json (+ 검증 출력, 사이트 모델 갱신)
    python inspection_score.py --export  # 사이트 계산기용 규칙·가중치 → web/data/inspection_model.json
    (prep.py 가 저장된 가중치로 매주 컬럼을 계산하고, 사이트 모델도 함께 내보낸다)
"""
import os, re, sys, json, argparse, datetime, zlib
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
WEIGHTS_PATH = os.path.join(ROOT, "inspection_score_weights.json")
MODEL_PATH = os.path.join(ROOT, "web", "data", "inspection_model.json")   # 사이트 계산기(web/lib/inspection_score.js)가 읽음

# ─────────────────────────────────────────────────────
#  글로비스 평가부위별 감점 적용표 (원본 이미지 전사, 빈칸=None)
#  기호(사용자 확인 2026-10-26): X 교환 · P 판금 · w 용접 · Q 요철·손상 · C 부식 · A 흠집
#  XX·pp·f·m 열은 쓰지 않는다  (주요=주요골격 여부)
# ─────────────────────────────────────────────────────
def _r(XX=None, pp=None, f=None, w=None, m=None, X=None, P=None, Q=None, A=None, C=None, 주요=False):
    return dict(XX=XX, pp=pp, f=f, w=w, m=m, X=X, P=P, Q=Q, A=A, C=C, 주요=주요)

GLOVIS = {
    "앞유리": _r(X=3, A=1),
    "루프": _r(XX=20, pp=3, w=5, X=20, P=5, Q=10, A=1, C=10, 주요=True),
    "앞도어": _r(XX=7, pp=3, X=7, P=3, Q=5, A=1, C=5),
    "A필러": _r(XX=15, pp=3, f=5, w=5, X=15, P=5, Q=7, A=1, C=7, 주요=True),
    "B필러": _r(XX=15, pp=3, f=5, w=5, X=15, P=5, Q=7, A=1, C=7, 주요=True),
    "C필러": _r(XX=15, pp=3, f=5, w=5, X=15, P=5, Q=7, A=1, C=7, 주요=True),
    "스텝": _r(XX=10, pp=3, f=5, w=5, X=10, P=5, Q=10, A=1, C=10),
    "뒷도어": _r(XX=7, pp=3, X=7, P=3, Q=5, A=1, C=5),
    "뒷펜더": _r(XX=15, pp=3, w=5, X=15, P=5, Q=7, A=1, C=7, 주요=True),
    "사이드패널": _r(XX=15, pp=3, w=5, X=15, P=5, Q=7, A=1, C=7, 주요=True),
    "쿼터패널": _r(XX=15, pp=3, w=5, X=15, P=5, Q=7, A=1, C=7, 주요=True),
    "리어코너패널": _r(XX=3, pp=2, X=4, P=2, Q=3, A=1, C=3),
    "뒷범퍼": _r(X=10, P=5, A=1),
    "리어램프": _r(X=3),
    "트렁크": _r(XX=10, pp=3, X=10, P=5, Q=7, A=1, C=7),
    "뒷패널": _r(XX=10, f=5, w=5, X=10, C=7, 주요=True),
    "리어인사이드패널": _r(XX=20, f=5, w=5, X=20, C=10, 주요=True),
    "트렁크플로어패널": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "리어휠하우스": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "시트백패널": _r(XX=15, f=5, w=5, X=15, C=7, 주요=True),
    "백패널": _r(XX=15, f=5, w=5, X=15, C=7, 주요=True),
    "앞범퍼": _r(X=10, P=5, A=1),
    "전조등": _r(X=3),
    "본넷": _r(XX=10, pp=3, X=10, P=5, Q=7, A=1, C=7),
    "앞펜더": _r(XX=7, pp=3, X=7, P=3, Q=5, A=1, C=5),
    "코너패널": _r(XX=4, pp=2, X=4, P=2, Q=3, A=1, C=3),
    "앞패널": _r(XX=15, f=5, w=5, X=15, C=10, 주요=True),
    "인사이드패널": _r(XX=20, f=5, w=5, X=20, C=10, 주요=True),
    "휠하우스": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "스커트패널": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "대쉬패널": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "플로어패널": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "프레임1": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "프레임2": _r(XX=30, f=5, w=5, X=30, C=10, 주요=True),
    "적재함바닥": _r(X=7, P=5, Q=7, A=1, C=7),
    "적재함루프": _r(X=7, P=5, Q=7, A=1, C=7),
    "적재함도어": _r(X=7, P=5, Q=7, A=1, C=7),
    "적재함뒷도어": _r(X=7, P=5, Q=7, A=1, C=7),
}

# 엔카 성능점검 부위명(좌우·위치 표기 제거) → 글로비스 부위.  * 표시는 글로비스 표에 없어 가장 가까운 항목으로 보완
TO_GLOVIS = {
    "후드": "본넷", "프론트 휀더": "앞펜더", "프론트 도어": "앞도어", "리어 도어": "뒷도어", "트렁크 리드": "트렁크",
    "라디에이터 서포트": "코너패널",        # * 볼트체결 1랭크 외판 → 코너패널 값으로 보완
    "쿼터 패널": "뒷펜더", "루프 패널": "루프", "사이드실 패널": "스텝", "필러 패널": "A필러",
    "프론트 패널": "앞패널", "크로스 멤버": "앞패널",   # * 크로스멤버 → 앞패널 값으로 보완
    "인사이드 패널": "인사이드패널", "트렁크 플로어": "트렁크플로어패널", "리어 패널": "뒷패널",
    "프론트 사이드 멤버": "프레임1", "리어 사이드 멤버": "프레임2",
    "프론트 휠하우스": "휠하우스", "리어 휠하우스": "리어휠하우스",
    "대쉬 패널": "대쉬패널", "플로어 패널": "플로어패널",
    "패키지 트레이": "시트백패널",           # * 패키지트레이 → 시트백패널 값으로 보완
}
# 글로비스 사고평가점 그룹 (주요골격 교환만으로 평가)
ACC_B = {"앞패널", "뒷패널", "A필러", "B필러", "C필러", "뒷펜더", "사이드패널", "쿼터패널", "시트백패널", "백패널"}
ACC_C = {"인사이드패널", "리어인사이드패널", "트렁크플로어패널"}
ACC_D = {"휠하우스", "리어휠하우스"}
ACC_F = {"대쉬패널", "플로어패널", "프레임1", "프레임2", "루프"}
GRADE_BINS = [(10, 9), (25, 8), (40, 7), (55, 6), (70, 5), (85, 4), (100, 3), (115, 2)]   # 감점합 상한 → 종합평가점
# 상태 → 감점표 열 (앞 열이 비어 있으면 다음 열)
GLOVIS_STATUS = {"교환": ["X"], "용접절단": ["X"], "판금": ["P", "w"], "요철": ["Q", "w"], "손상": ["Q", "w"],
                 "부식": ["C"], "흠집": ["A"]}

# ─────────────────────────────────────────────────────
#  사고 단계 분류 (명세 3.1) — prep.py 와 사이트 계산기가 함께 쓰는 규칙
# ─────────────────────────────────────────────────────
PART_RANK = {   # 성능·상태점검 기준 부위 등급 (좌·우·앞·뒤 표기 제거 후 이름)
    "후드": "외판1", "프론트 휀더": "외판1", "프론트 도어": "외판1", "리어 도어": "외판1",
    "트렁크 리드": "외판1", "라디에이터 서포트": "외판1",
    "쿼터 패널": "외판2", "루프 패널": "외판2", "사이드실 패널": "외판2",
    "프론트 패널": "골격", "크로스 멤버": "골격", "인사이드 패널": "골격", "트렁크 플로어": "골격",
    "리어 패널": "골격", "프론트 사이드 멤버": "골격", "리어 사이드 멤버": "골격",
    "프론트 휠하우스": "골격", "리어 휠하우스": "골격", "필러 패널": "골격", "대쉬 패널": "골격",
    "플로어 패널": "골격", "패키지 트레이": "골격",
}
RANK_LEVEL = {"외판1": 1, "외판2": 2, "골격": 3}
LEVEL_NAME = {0: "무사고", 1: "외판1", 2: "외판2", 3: "골격"}
# 성능점검 상태 원문 → 상태. 앞 규칙이 우선이라 복합 상태("교환(교체),판금/용접")는 가장 심한 것이 된다
RAW_STATUS_RULES = [("교환", "교환"), ("절단", "용접절단"), ("판금|용접", "판금"), ("요철", "요철"),
                    ("손상", "손상"), ("부식", "부식"), ("흠집", "흠집")]
STATUS_KIND = {"교환": "교환", "용접절단": "용접절단", "판금": "판금",              # 상태 → 사고 단계 분류
               "요철": "경미", "손상": "경미", "부식": "경미", "흠집": "경미"}

# 자체 점수용 부위 그룹 (표본이 적은 부위는 구조가 비슷한 것끼리 묶음)
SCORE_GROUP = {
    "후드": "후드", "프론트 휀더": "휀더", "프론트 도어": "도어", "리어 도어": "도어", "트렁크 리드": "트렁크리드",
    "라디에이터 서포트": "라디에이터서포트", "쿼터 패널": "쿼터패널", "루프 패널": "루프", "사이드실 패널": "사이드실",
    "필러 패널": "필러", "프론트 패널": "앞패널·크로스멤버", "크로스 멤버": "앞패널·크로스멤버",
    "리어 패널": "뒷패널·패키지트레이", "패키지 트레이": "뒷패널·패키지트레이",
    "인사이드 패널": "인사이드패널", "트렁크 플로어": "트렁크플로어",
    "프론트 휠하우스": "휠하우스", "리어 휠하우스": "휠하우스",
    "프론트 사이드 멤버": "사이드멤버·대쉬·플로어", "리어 사이드 멤버": "사이드멤버·대쉬·플로어",
    "대쉬 패널": "사이드멤버·대쉬·플로어", "플로어 패널": "사이드멤버·대쉬·플로어",
}
SCORE_GROUPS = sorted(set(SCORE_GROUP.values()))
SCORE_KINDS = ["교환", "판금", "경미"]
CAP = 3            # 같은 그룹·상태 부위 수 상한 (도어 4짝 등 과대 반영 방지)
SCORE_K = {"교환": "교환", "용접절단": "판금", "판금": "판금",                    # 상태 → 점수 분류
           "요철": "경미", "손상": "경미", "부식": "경미", "흠집": "경미"}


def parse_items(fin):
    """outer_panel·main_frame → 부위 단위 표 (id, part, status)"""
    txt = pd.concat([fin["outer_panel"], fin["main_frame"]]).dropna()
    txt = txt[txt.str.len() > 0]
    it = txt.str.split(r" \| ").explode().dropna()
    it = it[it.str.contains(":", regex=False)]
    part = it.str.split(":", n=1).str[0].str.replace(r"\(.*?\)", "", regex=True).str.strip()
    stat = it.str.split(":", n=1).str[1].fillna("")
    status = np.select([stat.str.contains(p) for p, _ in RAW_STATUS_RULES], [s for _, s in RAW_STATUS_RULES], default="기타")
    return pd.DataFrame({"id": it.index, "part": part.values, "status": status})


def _glovis_points(row):
    g = GLOVIS.get(row["gpart"])
    if not g:
        return 0
    for col in GLOVIS_STATUS.get(row["status"], []):
        if g[col] is not None:
            return g[col]
    return 0


def glovis_eval(items, index):
    """→ DataFrame(index): 글로비스_감점합, 글로비스_사고평가점, 글로비스_종합평가점"""
    it = items.copy()
    it["gpart"] = it["part"].map(TO_GLOVIS)
    it["pts"] = it.apply(_glovis_points, axis=1)
    pts = it.groupby("id")["pts"].sum()
    ex = it[it["status"].isin(["교환", "용접절단"])]
    cnt = lambda grp: ex[ex["gpart"].isin(grp)].groupby("id").size().reindex(index).fillna(0)
    nB, nC, nD, nF = cnt(ACC_B), cnt(ACC_C), cnt(ACC_D), cnt(ACC_F)
    acc = np.select([(nF >= 1) | (nD >= 2), (nD == 1) | (nC >= 2), (nC == 1) | (nB >= 2), nB == 1],
                    ["F", "D", "C", "B"], default="A")
    total = pts.reindex(index).fillna(0)
    grade = pd.Series(1, index=index)
    for hi, gr in reversed(GRADE_BINS):
        grade[total <= hi] = gr
    return pd.DataFrame({"글로비스_감점합": total.astype(int), "글로비스_사고평가점": acc, "글로비스_종합평가점": grade.astype(int)}, index=index)


def score_features(items, index, simple_repair, mech_level):
    """자체 점수 설계행렬: 부위그룹×상태 개수(상한 CAP) + 용접절단 여부 + 단순수리 + 기계결함"""
    it = items.copy()
    it["grp"] = it["part"].map(SCORE_GROUP)
    it = it[it["grp"].notna()]
    it["k"] = it["status"].map(SCORE_K)
    it = it[it["k"].notna()]
    m = it.groupby(["id", "grp", "k"]).size().clip(upper=CAP).unstack(["grp", "k"], fill_value=0)
    cols = [f"{g}|{k}" for g in SCORE_GROUPS for k in SCORE_KINDS]
    m.columns = [f"{g}|{k}" for g, k in m.columns]
    X = m.reindex(index).reindex(columns=cols).fillna(0)
    X["용접절단"] = it[it["status"] == "용접절단"].groupby("id").size().reindex(index).fillna(0).gt(0).astype(float)
    X["단순수리"] = simple_repair.reindex(index).eq(True).astype(float)
    X["결함_경미"] = mech_level.reindex(index).eq(1).astype(float)
    X["결함_결함"] = mech_level.reindex(index).eq(2).astype(float)
    return X


def apply_score(X, weights):
    """가중치(로그 가격 영향, ≤0) → 성능감가율(%)·성능점검점수(0~100)·성능등급(9~1)"""
    loss_log = np.zeros(len(X))
    for c in X.columns:                      # 열 순서대로 더한다 → 사이트 계산기와 소수점까지 같은 값
        loss_log = loss_log + X[c].values * weights["coef"].get(c, 0.0)
    rate = (1 - np.exp(loss_log)) * 100
    score = np.clip(100 - rate * weights["points_per_pct"], 0, 100)
    grade = np.digitize(rate, weights["grade_cuts"])          # 0 = 가장 좋음
    return pd.DataFrame({"성능감가율": np.round(rate, 2), "성능점검점수": np.round(score, 1),
                         "성능등급": (9 - grade).astype(int)}, index=X.index)


# ─────────────────────────────────────────────────────
#  학습·검증
# ─────────────────────────────────────────────────────
def _target(L):
    """같은 모델·차령 12개월·주행 2만km 그룹(10대 이상) 중앙가 대비 로그 가격"""
    c = L[(L["상태"] == "판매중") & L["비교사용"] & L["점검여부"].eq(True)].copy()
    c["ab"] = c["차령개월"] // 12; c["kb"] = (c["주행km"] // 20000).clip(upper=12)
    g = c.groupby(["모델", "ab", "kb"])["현재가"]
    c["n"] = g.transform("size"); c["med"] = g.transform("median")
    c = c[c["n"] >= 10].copy()
    c["y"] = np.log(c["현재가"] / c["med"]).clip(-0.5, 0.5)
    return c


# 성능등급 9~1 경계 (예상 감가율 %). 등급마다 실제 가격이 뚜렷이 갈리도록 고른 값(2026-10-26 검증:
# 9등급 0% · 8 −2.2 · 7 −3.3 · 6 −4.4 · 5 −6.5 · 4 −9.1 · 3 −12.5 · 2 −16.5 · 1 −20.2%)
GRADE_CUTS = [2.0, 3.5, 5.0, 6.5, 8.5, 11.0, 14.0, 18.0]
EXTRAS = ["용접절단", "단순수리", "결함_경미", "결함_결함"]


def glovis_prior_points():
    """자체 점수 그룹×상태별 글로비스 감점(그룹 안 부위 평균) — 사전 구조로 사용"""
    pts = {}
    for grp in SCORE_GROUPS:
        gparts = [GLOVIS[TO_GLOVIS[p]] for p, g in SCORE_GROUP.items() if g == grp and TO_GLOVIS.get(p) in GLOVIS]
        val = lambda f: np.mean([f(r) for r in gparts]) if gparts else 0.0
        pts[f"{grp}|교환"] = val(lambda r: r["X"] or 0)
        pts[f"{grp}|판금"] = val(lambda r: r["P"] if r["P"] is not None else (r["w"] or 0))
        pts[f"{grp}|경미"] = val(lambda r: np.mean([v for v in (r["Q"], r["C"], r["A"]) if v is not None] or [0]))
    return pd.Series(pts)


def _monotone_T(cols):
    """β = T·γ (γ ≤ 0). 그룹마다 β_경미=γ1, β_판금=γ1+γ2, β_교환=γ1+γ2+γ3 → 교환 ≤ 판금 ≤ 경미 ≤ 0 보장"""
    T = np.zeros((len(cols), len(cols)))
    idx = {c: i for i, c in enumerate(cols)}
    for grp in SCORE_GROUPS:
        g1, g2, g3 = idx[f"{grp}|경미"], idx[f"{grp}|판금"], idx[f"{grp}|교환"]
        T[g1, g1] = 1
        T[g2, g1] = T[g2, g2] = 1
        T[g3, g1] = T[g3, g2] = T[g3, g3] = 1
    for e in EXTRAS:
        T[idx[e], idx[e]] = 1
    return T


def fit(L, items, fin_flags, lambdas=(0, 30, 100, 300, 1000, 3000, 10000)):
    """잔가(같은 조건 대비 가격) 회귀. 손상 항목은 가격을 올릴 수 없고(≤0), 같은 부위에선 교환≤판금≤경미.
       글로비스 감점 구조를 사전값으로 두고 ridge 로 당겨 표본 적은 항목을 안정화. λ는 시험셋 R²로 선택."""
    from scipy.optimize import lsq_linear
    c = _target(L)
    X = score_features(items, c.index, fin_flags["단순수리"], fin_flags["결함단계"])
    ctrl = pd.get_dummies(c[["번호판유형", "색상계열"]].astype(str), drop_first=False).astype(float)
    ctrl = ctrl.drop(columns=[x for x in ["번호판유형_일반", "색상계열_흰색·진주"] if x in ctrl.columns])
    test = np.array([zlib.crc32(i.encode()) % 5 == 0 for i in c.index])
    y = c["y"].values
    nd, nc = X.shape[1], ctrl.shape[1]
    T = _monotone_T(list(X.columns))
    Z = X.values @ T                                            # γ 공간 설계행렬
    A = np.hstack([Z, ctrl.values, np.ones((len(c), 1))])
    # 사전값: 글로비스 감점 × θ (θ = 감점합 1점당 로그 가격 영향, 통제변수 포함 최소제곱)
    gp = glovis_prior_points().reindex(X.columns).fillna(0.0)
    s = X.values @ gp.values
    B = np.hstack([s[:, None], ctrl.values, np.ones((len(c), 1))])
    theta = float(np.linalg.lstsq(B[~test], y[~test], rcond=None)[0][0])
    prior = theta * gp.values                                  # 음수(감가)
    lb = np.r_[np.full(nd, -np.inf), np.full(nc + 1, -np.inf)]
    ub = np.r_[np.zeros(nd), np.full(nc + 1, np.inf)]
    best = None
    for lam in lambdas:
        P = np.hstack([np.sqrt(lam) * T, np.zeros((nd, nc + 1))])      # √λ·(β − β_prior)
        A_aug = np.vstack([A[~test], P]); y_aug = np.concatenate([y[~test], np.sqrt(lam) * prior])
        res = lsq_linear(A_aug, y_aug, bounds=(lb, ub), lsmr_tol="auto")
        beta = T @ res.x[:nd]
        pred = A[test] @ res.x
        r2 = 1 - ((y[test] - pred) ** 2).sum() / ((y[test] - y[test].mean()) ** 2).sum()
        print(f"  λ={lam:>6}: 시험셋 R² {r2:.4f}")
        if best is None or r2 > best[0]:
            best = (r2, lam, beta, res.x[nd:nd + nc])
    r2, lam, beta, cc = best
    weights = {"fitted": datetime.date.today().isoformat(), "n_train": int((~test).sum()), "n_test": int(test.sum()),
               "target": "ln(현재가 / 같은 모델·차령12개월·주행2만km 그룹 중앙가)",
               "method": "단조 제약(교환≤판금≤경미≤0) + 글로비스 감점 사전값 ridge, λ 시험셋 선택",
               "glovis_theta_per_point": round(theta, 5), "ridge_lambda": lam, "test_r2_full": round(float(r2), 4),
               "points_per_pct": 4.0, "grade_cuts": GRADE_CUTS,
               "coef": {k: round(float(v), 5) for k, v in zip(X.columns, beta)},
               "glovis_prior": {k: round(float(v), 5) for k, v in zip(X.columns, prior)},
               "controls": {k: round(float(v), 5) for k, v in zip(ctrl.columns, cc)}}
    return weights, c, X, ctrl, test


def validate(c, X, ctrl, test, weights, glv):
    """시험셋에서 사고라벨 / 글로비스 / 자체 점수의 잔가 설명력 비교"""
    from scipy.stats import spearmanr
    yc = c["y"] - ctrl.values @ pd.Series(weights["controls"]).reindex(ctrl.columns).fillna(0).values
    tr, te = ~test, test
    def r2_cat(cat):
        m = yc[tr].groupby(cat[tr]).mean()
        pred = cat[te].map(m).fillna(yc[tr].mean())
        return 1 - ((yc[te] - pred) ** 2).sum() / ((yc[te] - yc[te].mean()) ** 2).sum()
    def r2_lin(x):
        b = np.polyfit(x[tr], yc[tr], 1); pred = np.polyval(b, x[te])
        return 1 - ((yc[te] - pred) ** 2).sum() / ((yc[te] - yc[te].mean()) ** 2).sum()
    sc = apply_score(X, weights)
    g = glv.reindex(c.index)
    rows = [("사고라벨(7단계)", r2_cat(c["사고라벨"]), spearmanr(c["사고단계"][te], yc[te]).correlation * -1),
            ("글로비스 사고평가점(A~F)", r2_cat(g["글로비스_사고평가점"]), np.nan),
            ("글로비스 종합평가점(9~1)", r2_cat(g["글로비스_종합평가점"].astype(str)), spearmanr(g["글로비스_종합평가점"][te], yc[te]).correlation),
            ("글로비스 감점합(연속)", r2_lin(g["글로비스_감점합"].astype(float)), spearmanr(g["글로비스_감점합"][te], yc[te]).correlation * -1),
            ("자체 성능감가율(연속)", r2_lin(sc["성능감가율"]), spearmanr(sc["성능감가율"][te], yc[te]).correlation * -1),
            ("자체 성능등급(9~1)", r2_cat(sc["성능등급"].astype(str)), spearmanr(sc["성능등급"][te], yc[te]).correlation)]
    return pd.DataFrame(rows, columns=["지표", "시험셋 R²", "순위상관"]).round(4), sc, yc


# ─────────────────────────────────────────────────────
#  사이트 계산기 모델 (web/data/inspection_model.json → web/lib/inspection_score.js)
# ─────────────────────────────────────────────────────
# 성능·상태점검기록부 부위 37곳 — 엔카 원문 표기 그대로, 기록부 순서
POSITIONS = [
    ("외판 1랭크", ["후드", "프론트 휀더(좌)", "프론트 휀더(우)", "프론트 도어(좌)", "프론트 도어(우)",
                  "리어 도어(좌)", "리어 도어(우)", "트렁크 리드", "라디에이터 서포트(볼트체결부품)"]),
    ("외판 2랭크", ["쿼터 패널(좌)", "쿼터 패널(우)", "루프 패널", "사이드실 패널(좌)", "사이드실 패널(우)"]),
    ("주요골격 A랭크", ["프론트 패널", "크로스 멤버", "인사이드 패널(좌)", "인사이드 패널(우)", "트렁크 플로어", "리어 패널"]),
    ("주요골격 B랭크", ["프론트 사이드 멤버(좌)", "프론트 사이드 멤버(우)", "리어 사이드 멤버(좌)", "리어 사이드 멤버(우)",
                      "프론트 휠하우스(좌)", "프론트 휠하우스(우)", "리어 휠하우스(좌)", "리어 휠하우스(우)",
                      "필러 패널(앞)(좌)", "필러 패널(앞)(우)", "필러 패널(중간)(좌)", "필러 패널(중간)(우)",
                      "필러 패널(뒤)(좌)", "필러 패널(뒤)(우)", "패키지 트레이"]),
    ("주요골격 C랭크", ["대쉬 패널", "플로어 패널"]),
]
STATUS_CODES = [("X", "교환"), ("W", "판금"), ("절단", "용접절단"), ("U", "요철"), ("T", "손상"), ("C", "부식"), ("A", "흠집")]
PART_DIR = {"프론트 휀더": "앞", "프론트 도어": "앞", "리어 도어": "뒤", "프론트 패널": "앞", "리어 패널": "뒤",
            "프론트 사이드 멤버": "앞", "리어 사이드 멤버": "뒤", "프론트 휠하우스": "앞", "리어 휠하우스": "뒤"}
# 앞뒤를 적지 않은 부위 → 계산(등급·점수 그룹·글로비스 감점·사고평가 그룹)이 같은 대표 부위
GENERIC_PARTS = {"도어": "프론트 도어", "사이드 멤버": "프론트 사이드 멤버", "휠하우스": "프론트 휠하우스"}
GENERIC_DIR = {"도어": {"앞": "프론트 도어", "뒤": "리어 도어"},
               "사이드 멤버": {"앞": "프론트 사이드 멤버", "뒤": "리어 사이드 멤버"},
               "휠하우스": {"앞": "프론트 휠하우스", "뒤": "리어 휠하우스"}}
# 엑셀 '성능 상태' 칸 읽기 — 띄어쓰기·대소문자는 무시하고 가장 긴 표기부터 찾는다
PART_ALIASES = {
    "후드": ["후드", "본넷", "보닛", "본네트"],
    "프론트 휀더": ["프론트 휀더", "프론트 펜더", "프런트 휀더", "프런트 펜더", "앞 휀더", "앞 펜더", "휀더", "펜더"],
    "프론트 도어": ["프론트 도어", "프런트 도어", "앞 도어", "앞문", "전도어"],
    "리어 도어": ["리어 도어", "뒷 도어", "뒤 도어", "뒷문", "후도어"],
    "트렁크 리드": ["트렁크 리드", "트렁크", "트렁크 도어", "테일게이트", "백도어"],
    "라디에이터 서포트": ["라디에이터 서포트", "라디에타 서포트", "라지에이터 서포트", "라지에타 서포트", "라디에이터", "코어 서포트"],
    "쿼터 패널": ["쿼터 패널", "쿼터", "리어 휀더", "리어 펜더", "뒷 휀더", "뒷 펜더", "뒤 휀더", "뒤 펜더"],
    "루프 패널": ["루프 패널", "루프", "지붕"],
    "사이드실 패널": ["사이드실 패널", "사이드실", "사이드씰", "사이드 스텝", "스텝", "로커 패널"],
    "프론트 패널": ["프론트 패널", "프런트 패널", "앞 패널"],
    "크로스 멤버": ["크로스 멤버", "크로스 맴버", "크로스멤바"],
    "인사이드 패널": ["인사이드 패널", "인사이드"],
    "트렁크 플로어": ["트렁크 플로어", "트렁크 플로워", "트렁크 바닥"],
    "리어 패널": ["리어 패널", "뒷 패널", "백 패널"],
    "프론트 사이드 멤버": ["프론트 사이드 멤버", "프런트 사이드 멤버", "앞 사이드 멤버", "프론트 멤버", "앞 멤버", "앞 프레임", "프론트 프레임"],
    "리어 사이드 멤버": ["리어 사이드 멤버", "뒷 사이드 멤버", "뒤 사이드 멤버", "리어 멤버", "뒷 멤버", "뒷 프레임", "리어 프레임"],
    "프론트 휠하우스": ["프론트 휠하우스", "프런트 휠하우스", "앞 휠하우스"],
    "리어 휠하우스": ["리어 휠하우스", "뒷 휠하우스", "뒤 휠하우스"],
    "필러 패널": ["필러 패널", "필러", "기둥"],
    "패키지 트레이": ["패키지 트레이", "패키지"],
    "대쉬 패널": ["대쉬 패널", "대시 패널", "대쉬", "대시"],
    "플로어 패널": ["플로어 패널", "플로워 패널", "플로어", "플로워", "바닥"],
    "도어": ["도어"],                                   # 앞뒤 미상 (GENERIC_PARTS)
    "사이드 멤버": ["사이드 멤버", "멤버", "프레임"],
    "휠하우스": ["휠하우스"],
}
PILLAR_ALIASES = {"A필러": "앞", "B필러": "중간", "C필러": "뒤", "A필러 패널": "앞", "B필러 패널": "중간", "C필러 패널": "뒤",
                  "필러A": "앞", "필러B": "중간", "필러C": "뒤",
                  "앞 필러": "앞", "중간 필러": "중간", "센터 필러": "중간", "뒤 필러": "뒤", "뒷 필러": "뒤"}
PARSE_WORDS = {
    "status_words": {"교환": "교환", "교체": "교환", "용접절단": "용접절단", "절단": "용접절단", "판금": "판금", "용접": "판금",
                     "요철": "요철", "찌그러짐": "요철", "손상": "손상", "파손": "손상", "경미": "손상",
                     "부식": "부식", "흠집": "흠집", "스크래치": "흠집", "긁힘": "흠집"},
    "status_symbols": {"X": "교환", "W": "판금", "U": "요철", "T": "손상", "C": "부식", "A": "흠집"},
    "side_words": {"좌": "좌", "좌측": "좌", "왼쪽": "좌", "운전석": "좌", "LH": "좌", "L": "좌",
                   "우": "우", "우측": "우", "오른쪽": "우", "조수석": "우", "RH": "우", "R": "우"},
    "both_words": ["좌우", "양쪽", "양측", "LR"],
    "direction_words": {"앞": "앞", "프론트": "앞", "프런트": "앞", "중간": "중간", "센터": "중간",
                        "뒤": "뒤", "뒷": "뒤", "리어": "뒤"},
    "ignore_words": ["볼트체결부품", "볼트체결", "패널", "부위"],
    "unknown_cell": ["미상", "모름", "확인불가", "-", "?", "N/A", "NA"],
    "no_damage_cell": ["무사고", "무사고차", "완전무사고", "무", "이상없음", "사고없음", "없음", "정상"],
}


def build_model():
    """사이트 계산기용 모델 — prep.py 와 같은 규칙 + 학습 가중치를 한 덩어리로"""
    w = json.load(open(WEIGHTS_PATH, encoding="utf-8"))
    acc = {"B": ACC_B, "C": ACC_C, "D": ACC_D, "F": ACC_F}
    acc_of = lambda gp: tuple(k for k, s in acc.items() if gp in s)
    for g, alt in GENERIC_DIR.items():          # 앞뒤 미상 부위는 앞·뒤 어느 쪽이든 계산이 같아야 한다
        a, b = alt["앞"], alt["뒤"]
        assert (PART_RANK[a], SCORE_GROUP[a], GLOVIS[TO_GLOVIS[a]], acc_of(TO_GLOVIS[a])) == \
               (PART_RANK[b], SCORE_GROUP[b], GLOVIS[TO_GLOVIS[b]], acc_of(TO_GLOVIS[b])), g
    positions = []
    for board, labels in POSITIONS:
        for lab in labels:
            tags = re.findall(r"\((.*?)\)", lab)
            positions.append({"board": board, "label": lab, "part": re.sub(r"\(.*?\)", "", lab).strip(),
                              "side": next((t for t in tags if t in ("좌", "우")), None),
                              "pillar": next((t for t in tags if t in ("앞", "중간", "뒤")), None)})
    assert len(positions) == 37 and {p["part"] for p in positions} == set(PART_RANK)
    sided = {p["part"] for p in positions if p["side"]}
    return {
        "version": w["fitted"],
        "note": "inspection_score.py 가 만든 파일(직접 고치지 말 것) — prep.py 와 같은 규칙 + 학습 가중치",
        "parts": {p: {"rank": r, "group": SCORE_GROUP.get(p), "glovis": TO_GLOVIS.get(p), "sides": p in sided,
                      "dir": PART_DIR.get(p)} for p, r in PART_RANK.items()},
        "generic_parts": GENERIC_PARTS,
        "positions": positions,
        "statuses": [{"code": c, "name": n} for c, n in STATUS_CODES],
        "rank_level": RANK_LEVEL,
        "level_name": {str(k): v for k, v in LEVEL_NAME.items()},
        "raw_status_rules": RAW_STATUS_RULES,
        "status_kind": STATUS_KIND,
        "glovis": {"table": GLOVIS, "status_cols": GLOVIS_STATUS,
                   "acc": {k: sorted(s) for k, s in acc.items()}, "grade_bins": GRADE_BINS},
        "score": {"columns": [f"{g}|{k}" for g in SCORE_GROUPS for k in SCORE_KINDS] + EXTRAS,
                  "status_k": SCORE_K, "cap": CAP, "coef": w["coef"], "points_per_pct": w["points_per_pct"],
                  "grade_cuts": w["grade_cuts"], "fitted": w["fitted"], "ridge_lambda": w["ridge_lambda"],
                  "test_r2_full": w["test_r2_full"]},
        "simple_repair_rule": "외판(1·2랭크)에 교환·판금·용접절단이 있으면 '있음' — 2026-10-26 판매중 데이터와 99.0% 일치",
        "mech_levels": {"0": "없음", "1": "경미(미세누유·미세누수)", "2": "결함(누유·누수·불량·부족·과다 등)"},
        "parser": {"part_aliases": PART_ALIASES, "pillar_aliases": PILLAR_ALIASES, "generic_dir": GENERIC_DIR, **PARSE_WORDS},
    }


def export_model(path=MODEL_PATH):
    """build_model() → JSON 파일 (내용이 같으면 같은 바이트라 커밋 변경이 생기지 않는다)"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(build_model(), f, ensure_ascii=False, indent=1)
        f.write("\n")
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fit", action="store_true")
    ap.add_argument("--export", action="store_true")
    args = ap.parse_args()
    if args.export and not args.fit:
        sys.stdout.reconfigure(encoding="utf-8")
        print("사이트 계산기 모델 →", export_model()); return
    if not args.fit:
        print(__doc__); return
    src = os.path.join(ROOT, "encar_output")
    L = pd.read_parquet(os.path.join(src, "prep", "listings.parquet"))
    fin = pd.read_csv(os.path.join(src, "encar_final.csv"), encoding="utf-8-sig", usecols=["vehicle_id", "outer_panel", "main_frame"],
                      dtype=str, low_memory=False).drop_duplicates("vehicle_id").set_index("vehicle_id")
    items = parse_items(fin)
    flags = L[["단순수리", "결함단계"]]
    weights, c, X, ctrl, test = fit(L, items, flags)
    glv = glovis_eval(items, c.index)
    table, sc, yc = validate(c, X, ctrl, test, weights, glv)
    with open(WEIGHTS_PATH, "w", encoding="utf-8") as f:
        json.dump(weights, f, ensure_ascii=False, indent=1)
    export_model()                                     # 사이트 계산기도 새 가중치로
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"학습 {weights['n_train']:,} / 시험 {weights['n_test']:,} · 선택 λ={weights['ridge_lambda']} · 글로비스 1점당 {((np.exp(weights['glovis_theta_per_point'])-1)*100):.2f}% · 저장 {WEIGHTS_PATH}")
    co = pd.Series(weights["coef"]); pr = pd.Series(weights["glovis_prior"])
    tbl = pd.DataFrame({g: [((np.exp(co.get(f"{g}|{k}", 0)) - 1) * 100) for k in SCORE_KINDS] for g in SCORE_GROUPS}, index=SCORE_KINDS).T.round(2)
    tbl["교환(글로비스 사전)"] = [((np.exp(pr.get(f"{g}|교환", 0)) - 1) * 100) for g in SCORE_GROUPS]
    print("\n[부위 그룹 × 상태별 가격 영향 % (1곳당)]"); print(tbl.round(2).sort_values("교환").to_string())
    print("[기타 항목 %]", {e: round((np.exp(co.get(e, 0)) - 1) * 100, 2) for e in EXTRAS})
    print("\n[통제변수]", {k: round((np.exp(v) - 1) * 100, 2) for k, v in weights["controls"].items()})
    print("\n[잔가 설명력 비교 — 시험셋]"); print(table.to_string(index=False))
    print("\n[등급 경계(감가율 %)]", weights["grade_cuts"])
    b = pd.DataFrame({"등급": sc["성능등급"], "y": yc}).groupby("등급")["y"].agg(["size", "median"])
    b["가격(무손상 대비 %)"] = ((np.exp(b["median"] - b.loc[9, "median"]) - 1) * 100).round(1)
    print("\n[자체 성능등급별 실제 가격]"); print(b[["size", "가격(무손상 대비 %)"]].to_string())
    gl = pd.DataFrame({"g": glv["글로비스_종합평가점"], "y": yc}).groupby("g")["y"].agg(["size", "median"])
    gl["가격(9점 대비 %)"] = ((np.exp(gl["median"] - gl.loc[9, "median"]) - 1) * 100).round(1)
    print("\n[글로비스 종합평가점별 실제 가격]"); print(gl[["size", "가격(9점 대비 %)"]].to_string())
    ga = pd.DataFrame({"a": glv["글로비스_사고평가점"], "y": yc}).groupby("a")["y"].agg(["size", "median"])
    ga["가격(A 대비 %)"] = ((np.exp(ga["median"] - ga.loc["A", "median"]) - 1) * 100).round(1)
    print("\n[글로비스 사고평가점별 실제 가격]"); print(ga[["size", "가격(A 대비 %)"]].to_string())


if __name__ == "__main__":
    main()
