# -*- coding: utf-8 -*-
"""
adjust_coef.py — 시세 보정 계수 (기획안 D3): 비교 매물 가격을 대상 차 조건으로 옮기는 계수

    python adjust_coef.py               # 계수 추정 → web/data/adj_coef.json + encar_output/prep/adj_coef_report.txt
    python adjust_coef.py --validate    # + 검증: 매물 20%를 떼어 두고 나머지로 그 차의 호가를 추정(보정 전후 오차 비교)

보정가 = 비교 매물 호가 × (1 − 대상 차 성능감가율) ÷ (1 − 비교 매물 성능감가율)
                         × exp( 차령계수 × (대상 − 비교)개월 + 주행계수 × (대상 − 비교)만km
                               + 렌트계수 × (대상 − 비교) + 색상(대상) − 색상(비교) + 등급·세부등급(대상) − 등급·세부등급(비교) )
  · 추정: 판매중·비교사용·성능점검 매물의 로그 호가(성능감가율은 따로 빼 둠)를 같은 (모델·등급·세부등급) 안에서 비교
  · 계층: 시장 → 차급(국산·수입) → 모델. 모델 계수는 표본이 적을수록 차급 값 쪽으로 당긴다(경험적 베이즈)
  · 등급·세부등급 차이는 모델마다(대수가 적으면 0 쪽으로 당김). 주행은 25만km에서 상한
"""
import os, sys, json, zlib, argparse, datetime
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.abspath(__file__))
PREP = os.path.join(ROOT, "encar_output", "prep")
OUT_JSON = os.path.join(ROOT, "web", "data", "adj_coef.json")
REPORT = os.path.join(PREP, "adj_coef_report.txt")

COLORS = ["검정", "회색·은색", "청색", "기타"]                  # 기준: 흰색·진주 (미상은 보정하지 않음)
FEATS = ["age", "km", "rent"] + [f"c_{c}" for c in COLORS]
KM_CAP = 250_000
SHRINK_FE = 5                                                   # 등급·세부등급 차이: 대수 n 이면 n/(n+5) 만큼만 믿는다
LO = np.array([-0.05, -0.15, -0.15] + [-1.0] * len(COLORS))    # 상식 범위: 차령·주행은 값을 올릴 수 없고,
HI = np.array([0.0, 0.0, 0.0] + [1.0] * len(COLORS))          # 렌트 번호판은 0 ~ −15%(렌트 매물이 적은 차급의 튀는 값 방지)
STEPS = [  # 검증용 단계별 매칭(기획안 5.1.2): (등급 일치, 차령 ±개월, 주행 ±만km, 성능등급 ±)
    ("1 정확", True, 6, 2, 1), ("2 차령±12", True, 12, 2, 1), ("3 주행±4만", True, 12, 4, 1),
    ("4 등급 무관", False, 12, 4, 1), ("5 모델 전체", False, 999, 999, 99)]
MIN_COMPS = 5


def load():
    L = pd.read_parquet(os.path.join(PREP, "listings.parquet"),
                        columns=["상태", "비교사용", "점검여부", "제조사", "모델", "등급", "세부등급", "차급", "국산", "차령개월",
                                 "주행km", "현재가", "번호판유형", "색상계열", "성능감가율", "성능등급"])
    d = L[(L["상태"] == "판매중") & L["비교사용"].eq(True) & L["점검여부"].eq(True) & L["성능감가율"].notna()
          & L["차령개월"].between(0, 300) & L["주행km"].gt(0) & L["번호판유형"].isin(["일반", "렌트"])].copy()
    d["y"] = np.log(d["현재가"]) - np.log1p(-d["성능감가율"] / 100)          # 성능 상태는 감가율로 따로 보정
    d["age"] = d["차령개월"].astype(float)
    d["km"] = d["주행km"].clip(upper=KM_CAP) / 1e4
    d["rent"] = (d["번호판유형"] == "렌트").astype(float)
    for c in COLORS:
        d[f"c_{c}"] = (d["색상계열"] == c).astype(float)
    d["등급"] = d["등급"].fillna("")
    d["세부"] = d["세부등급"].fillna("")
    d["seg"] = d["차급"].fillna("기타") + "·" + np.where(d["국산"].eq(True), "국산", "수입")
    d["key"] = d["제조사"] + "|" + d["모델"]
    d["cell"] = d["key"] + "|" + d["등급"] + "|" + d["세부"]
    return d


def within_ols(d):
    """(모델·등급·세부등급) 칸 안의 차이로 추정한 계수와 표준오차. 칸 안에서 변하지 않는 항목은 표준오차 무한대"""
    n = d.groupby("cell")["y"].transform("size")
    d = d[n >= 2]
    if len(d) < len(FEATS) + 5:
        return np.zeros(len(FEATS)), np.full(len(FEATS), np.inf), 0
    g = d.groupby("cell")
    Y = (d["y"] - g["y"].transform("mean")).values
    X = (d[FEATS] - g[FEATS].transform("mean")).values
    ok = (X ** 2).sum(axis=0) > 1e-6
    b, se = np.zeros(len(FEATS)), np.full(len(FEATS), np.inf)
    Xo = X[:, ok]
    XtX = Xo.T @ Xo
    bo = np.linalg.lstsq(Xo, Y, rcond=None)[0]
    dof = max(len(Y) - ok.sum() - d["cell"].nunique(), 1)
    s2 = ((Y - Xo @ bo) ** 2).sum() / dof
    b[ok], se[ok] = bo, np.sqrt(np.diag(s2 * np.linalg.pinv(XtX)))
    return b, se, len(d)


def tau2(est, se):
    """모델 사이 진짜 계수의 흩어짐(적률 추정, 하한 있음)"""
    m = np.isfinite(se) & (se < 1)
    if m.sum() < 5:
        return 1e-6
    return max(np.var(est[m]) - np.mean(se[m] ** 2), 1e-6)


def estimate(d):
    """시장 → 차급 → 모델 계수(경험적 베이즈로 당김) + 모델별 등급·세부등급 차이"""
    b_mkt, _, n_mkt = within_ols(d)
    b_mkt = np.clip(b_mkt, LO, HI)
    segs = {s: within_ols(g) for s, g in d.groupby("seg")}
    raw = {k: within_ols(g) for k, g in d.groupby("key")}
    # 차급: 시장 쪽으로(차급 간 흩어짐 기준)
    sb, ss = np.array([v[0] for v in segs.values()]), np.array([v[1] for v in segs.values()])
    t_seg = np.array([tau2(sb[:, j], ss[:, j]) for j in range(len(FEATS))])
    seg_b = {}
    for s, (b, se, n) in segs.items():
        w = t_seg / (t_seg + np.where(np.isfinite(se), se ** 2, np.inf))
        seg_b[s] = {"b": np.clip(w * b + (1 - w) * b_mkt, LO, HI), "n": n}
    # 모델: 자기 차급 쪽으로(모델 간 흩어짐 기준)
    mb, ms = np.array([v[0] for v in raw.values()]), np.array([v[1] for v in raw.values()])
    t_mod = np.array([tau2(mb[:, j], ms[:, j]) for j in range(len(FEATS))])
    seg_of = d.groupby("key")["seg"].agg(lambda s: s.mode().iat[0])
    models = {}
    for k, g in d.groupby("key"):
        b, se, n = raw[k]
        prior = seg_b[seg_of[k]]["b"]
        w = t_mod / (t_mod + np.where(np.isfinite(se), se ** 2, np.inf))
        bm = np.clip(w * b + (1 - w) * prior, LO, HI)
        res = g["y"].values - g[FEATS].values @ bm                                  # 등급·세부등급 차이
        r = pd.DataFrame({"g": g["등급"].values, "t": g["세부"].values, "r": res})
        mu = r["r"].mean()
        gs = r.groupby("g")["r"].agg(["mean", "size"])
        grade = {gname: (m - mu) * n_ / (n_ + SHRINK_FE) for gname, (m, n_) in gs.iterrows()}
        ts = r[r["t"] != ""].groupby(["g", "t"])["r"].agg(["mean", "size"])
        trim = {}
        for (gname, tname), (m, n_) in ts.iterrows():
            trim.setdefault(gname, {})[tname] = (m - gs.loc[gname, "mean"]) * n_ / (n_ + SHRINK_FE)
        models[k] = {"seg": seg_of[k], "n": int(len(g)), "w": w, "b": bm, "grade": grade, "trim": trim}
    return {"market": {"b": b_mkt, "n": n_mkt}, "segments": seg_b, "models": models, "tau_model": t_mod}


def to_json(est):
    def coef(b):
        return {"age": round(float(b[0]), 5), "km": round(float(b[1]), 5), "rent": round(float(b[2]), 5),
                "color": {c: round(float(b[3 + i]), 5) for i, c in enumerate(COLORS)}}
    models = {}
    for k, m in est["models"].items():
        e = coef(m["b"])
        e.update({"seg": m["seg"], "n": m["n"], "model_weight": {"age": round(float(m["w"][0]), 2), "km": round(float(m["w"][1]), 2)},
                  "grade": {g: round(float(v), 4) for g, v in m["grade"].items()},
                  "trim": {g: {t: round(float(v), 4) for t, v in tv.items()} for g, tv in m["trim"].items()}})
        models[k] = e
    return {
        "version": datetime.date.today().isoformat(),
        "note": "엔카 판매중 매물로 추정한 시세 보정 계수(D3). 로그 가격 기준 — 보정 배수 = exp(계수 × 차이)",
        "definition": "보정가 = 비교 매물 호가 × (1 − 대상 감가율)/(1 − 비교 감가율) × exp(age×Δ개월 + km×Δ만km + rent×Δ렌트 + "
                      "color[대상] − color[비교] + grade[대상] − grade[비교] + trim[대상] − trim[비교])",
        "units": {"age": "1개월당", "km": "1만km당(25만km 상한)", "rent": "렌트 번호판", "color": "흰색·진주 대비, 미상은 0"},
        "km_cap": KM_CAP,
        "market": dict(coef(est["market"]["b"]), n=est["market"]["n"]),
        "segments": {s: dict(coef(v["b"]), n=v["n"]) for s, v in sorted(est["segments"].items())},
        "models": models,
    }


# ─────────────────────────────────────────────────────
#  검증: 떼어 둔 매물의 호가를 나머지 매물로 추정
# ─────────────────────────────────────────────────────
def predict(test, train, est):
    out = []
    by_key = {k: g for k, g in train.groupby("key")}
    for k, tg in test.groupby("key"):
        c = by_key.get(k)
        if c is None or len(c) < MIN_COMPS:
            continue
        m = est["models"].get(k)
        if m is None:
            continue
        bm, grade, trim = m["b"], m["grade"], m["trim"]
        cg, ca, ck = c["등급"].values, c["age"].values, c["km"].values
        cs, cr, cp = c["성능등급"].values, c["성능감가율"].values / 100, c["현재가"].values
        cx = c[FEATS].values
        cfe = np.array([grade.get(a, 0) + trim.get(a, {}).get(b, 0) for a, b in zip(c["등급"], c["세부"])])
        for r in tg.itertuples():
            for name, same_g, da, dk, ds in STEPS:
                sel = (np.abs(ca - r.age) <= da) & (np.abs(ck - r.km) <= dk) & (np.abs(cs - r.성능등급) <= ds)
                if same_g:
                    sel &= cg == r.등급
                if sel.sum() >= MIN_COMPS:
                    break
            if sel.sum() < MIN_COMPS:
                continue
            p = cp[sel]
            cond = (1 - r.성능감가율 / 100) / (1 - cr[sel])
            tx = np.array([getattr(r, f) for f in FEATS])
            tfe = grade.get(r.등급, 0) + trim.get(r.등급, {}).get(r.세부, 0)
            full = cond * np.exp((tx - cx[sel]) @ bm + tfe - cfe[sel])
            out.append({"step": name, "n": int(sel.sum()), "actual": r.현재가, "raw": np.median(p),
                        "cond": np.median(p * cond), "full": np.median(p * full), "seg": m["seg"]})
    return pd.DataFrame(out)


def validate(d):
    test_mask = d.index.map(lambda i: zlib.crc32(str(i).encode()) % 5 == 0).values.astype(bool)
    train, test = d[~test_mask], d[test_mask]
    est = estimate(train)
    P = predict(test, train, est)
    rows = []
    for label, grp in [("전체", P)] + [(f"단계 {s}", g) for s, g in P.groupby("step")]:
        row = {"구분": label, "대수": len(grp)}
        for col, name in [("raw", "보정 없음"), ("cond", "성능만"), ("full", "성능+D3")]:
            err = (grp[col] / grp["actual"] - 1).abs()
            row[f"{name} 오차중위%"] = round(err.median() * 100, 2)
            row[f"{name} ±10%안%"] = round((err <= 0.10).mean() * 100, 1)
        rows.append(row)
    return pd.DataFrame(rows), len(train), len(test)


def report(est, val, secs):
    pct = lambda v: (np.exp(v) - 1) * 100
    mk = est["market"]["b"]
    lines = [f"시세 보정 계수(D3) — {datetime.datetime.now():%Y-%m-%d %H:%M} · {secs}초",
             f"추정 매물 {est['market']['n']:,}대(같은 모델·등급·세부등급 칸에 2대 이상) · 모델 {len(est['models']):,}개",
             f"시장: 차령 1개월 {pct(mk[0]):+.2f}% · 주행 1만km {pct(mk[1]):+.2f}% · 렌트 {pct(mk[2]):+.2f}% · " +
             " · ".join(f"{c} {pct(mk[3 + i]):+.2f}%" for i, c in enumerate(COLORS)), "", "차급별(국산·수입):"]
    for s, v in sorted(est["segments"].items(), key=lambda x: -x[1]["n"]):
        b = v["b"]
        lines.append(f"  {s:<10} {v['n']:>6,}대 · 차령 {pct(b[0]):+.2f}% · 주행 {pct(b[1]):+.2f}% · 렌트 {pct(b[2]):+.2f}%")
    w = np.array([m["w"][0] for m in est["models"].values()])
    n = np.array([m["n"] for m in est["models"].values()])
    lines += ["", f"모델 계수에서 모델 자체 비중(차령): 200대 이상 모델 중위 {np.median(w[n >= 200]):.2f} · 50대 미만 중위 {np.median(w[n < 50]):.2f}"]
    if val is not None:
        v, ntr, nte = val
        lines += ["", f"검증: 학습 {ntr:,}대 · 시험 {nte:,}대(매물ID 고정 20%) — 시험 매물의 호가를 학습 매물로 추정", v.to_string(index=False)]
    text = "\n".join(lines)
    with open(REPORT, "w", encoding="utf-8") as f:
        f.write(text + "\n")
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = datetime.datetime.now()
    d = load()
    est = estimate(d)
    with open(OUT_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(to_json(est), f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    val = validate(d) if args.validate else None
    print(report(est, val, (datetime.datetime.now() - t0).seconds))
    print(f"→ {OUT_JSON} ({os.path.getsize(OUT_JSON) / 1024:.0f}KB)")


if __name__ == "__main__":
    main()
