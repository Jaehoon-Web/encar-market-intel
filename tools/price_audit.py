# -*- coding: utf-8 -*-
"""
price_audit.py — 시세 산정 정밀 점검 (기획 v2.33 5.16 · 인터뷰 Q245 Q250 Q251) — 매주 파이프라인 · 분기 다시 맞추기

    python tools/price_audit.py                  # 점검표만
    python tools/price_audit.py --fit-range      # + 추정 범위 배수를 맞춰 engine_tuning.json 에 씀(분기 · 경고 때)
    python tools/price_audit.py --write          # + web/data/audit.json(관리자 요약) · web/data/cond_market.json(감가 옆 시장 근거) · 기록

방법(공개 매물 자료만 — 경매 대조는 비공개 폴더의 따로 단계)
  · 판매중 매물마다 나머지로 추정(자기 · 같은 차 제외, 보정 계수는 web/data/adj_coef.json) — 기록부 입력 · 상태 미상
  · 판매 완료(최근 3개월) 매물의 마지막 호가(시점 보정)도 같은 방식으로
  · 사고 단계 · 차값 구간(추정값으로 나눔 — 실제 호가로 나누면 가운데로 돌아오는 치우침이 생긴다)별 치우침, 신뢰도 · 상태별 범위 적중
  · 시장 근거: 무사고 비교 매물만으로 본 무사고 시세 대비 사고 차 호가 차이(사고 단계 × 차값 구간, 판매중)
  · 경고: 사고 단계별 치우침이 ±1%p 를 넘거나 오차 가운데가 지난 점검보다 0.5%p 넘게 나빠지면
"""
import os, sys, json, math, time, argparse, datetime
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import price_engine as PE

ORDER = ["무사고", "외판1·판금", "외판1·교환", "외판2·판금", "외판2·교환", "골격·판금", "골격·교환"]
BANDS, BLAB = [0, 1000, 2000, 4000, 1e9], ["1천 미만", "1~2천", "2~4천", "4천+"]
KINDS = ["무사고", "사고", "미상"]
HIST = os.path.join(PE.PREP, "audit_history.json")                             # 점검 기록(공개 저장소 밖)
WARN_BIAS, WARN_MDAPE = 1.0, 0.5


def tgt(r, items):
    return {"등급": r.등급, "세부": r.세부, "age": r.age, "km": r.km, "rent": r.rent,
            "color": r.색상계열 if r.색상계열 in PE.COLORS or r.색상계열 == "흰색·진주" else None,
            "items": items, "dv": r.dv, "se": r.se, "us": r.us, "exclude_id": r.Index, "carkey": r.차키 if isinstance(r.차키, str) else None}


def run(pool, C, sample=None):
    G = {k: PE.Group(g, C) for k, g in pool.groupby("key")}
    items = {i: PE.Cond.from_names(PE.damage_names(s)) for i, s in pool["손상부위"].items()}
    clean = pd.Series({i: not any(PE.STATUS3.get(it["status"]) in ("교환", "판금") for it in v) for i, v in items.items()})
    Gc = {k: PE.Group(g, C) for k, g in pool[clean.reindex(pool.index).values].groupby("key")}
    T = pool if not sample else pool.sample(min(sample, len(pool)), random_state=11)
    rows = []
    for r in T.itertuples():
        it = items[r.Index]
        t = tgt(r, it)
        o = {"id": r.Index, "sold": bool(r.sold), "actual": r.price * (r.tf if r.sold else 1.0), "label": r.사고라벨 if isinstance(r.사고라벨, str) else "미상"}
        a = PE.estimate_one(G[r.key], t)
        if a:
            o.update(est=a["est"], lo=a["lo"], hi=a["hi"], base=a["base"], D=a["D"], grade=a["grade"])
        if not r.sold:
            u = PE.estimate_one(G[r.key], dict(t, items=None))
            if u:
                o.update(est_u=u["est"], lo_u=u["lo"], hi_u=u["hi"], grade_u=u["grade"])
            g = Gc.get(r.key)
            c = PE.estimate_one(g, dict(t, items=[])) if g is not None else None
            if c:
                o["base_c"] = c["est"]
        rows.append(o)
    return pd.DataFrame(rows).set_index("id")


def summarize(R):
    pct = lambda x: round(float(x) * 100, 2)
    on, so = R[~R["sold"] & R["est"].notna()], R[R["sold"] & R["est"].notna()]
    e = on["actual"] / on["est"] - 1
    out = {"date": datetime.date.today().isoformat(), "n_onsale": int(len(on)), "n_sold": int(len(so)),
           "mdape": pct(e.abs().median()), "within10": pct((e.abs() <= .10).mean()), "over20": pct((e.abs() > .20).mean()),
           "bias": pct(e.median()), "mdape_unknown": pct((on["actual"] / on["est_u"] - 1).abs().median()),
           "sold_bias": pct((so["actual"] / so["est"] - 1).median()), "sold_mdape": pct((so["actual"] / so["est"] - 1).abs().median())}
    out["grade"] = {g: {"n": int((on["grade"] == g).sum()), "mdape": pct(e[on["grade"] == g].abs().median())} for g in "ABC" if (on["grade"] == g).sum()}
    cov = {}                                                                         # 범위 적중(신뢰도 × 상태)
    for g in "ABC":
        row = []
        for kind in KINDS:
            if kind == "미상":
                d = on[on["grade_u"] == g]
                hit = (d["actual"] >= d["lo_u"]) & (d["actual"] <= d["hi_u"])
            else:
                d = on[(on["grade"] == g) & ((on["D"] > 0) == (kind == "사고"))]
                hit = (d["actual"] >= d["lo"]) & (d["actual"] <= d["hi"])
            row.append(pct(hit.mean()) if len(d) else None)
        cov[g] = row
    out["coverage"] = cov
    for name, d in (("class", on), ("class_sold", so)):
        ee = d["actual"] / d["est"] - 1
        out[name] = {c: {"n": int((d["label"] == c).sum()), "bias": pct(ee[d["label"] == c].median())} for c in ORDER if (d["label"] == c).sum() >= 50}
    for name, d in (("band", on), ("band_sold", so)):
        ee = d["actual"] / d["est"] - 1
        b = pd.cut(d["est"], BANDS, labels=BLAB).astype(str)
        out[name] = {k: {"n": int((b == k).sum()), "bias": pct(ee[b == k].median())} for k in BLAB if (b == k).sum() >= 50}
    return out


def market(R):
    """감가 옆 시장 근거 — 무사고 비교 매물만으로 본 무사고 시세 대비 호가 차이(판매중, 사고 단계 × 차값 구간)"""
    d = R[~R["sold"] & R["base_c"].notna()].copy()
    d["g"] = d["actual"] / d["base_c"]
    lvl = d.loc[d["label"] == "무사고", "g"].median()
    d["gap"] = d["g"] / lvl - 1
    d["band"] = pd.cut(d["base_c"], BANDS, labels=BLAB).astype(str)
    out = {"date": datetime.date.today().isoformat(), "bands": BLAB, "anchors": BANDS[1:-1], "classes": {}}
    for c in ORDER[1:]:
        x = d[d["label"] == c]
        row = {"all": [round(float(x["gap"].median()) * 100, 1), int(len(x))]}
        for b in BLAB:
            y = x[x["band"] == b]
            row[b] = [round(float(y["gap"].median()) * 100, 1), int(len(y))] if len(y) >= 30 else None
        out["classes"][c] = row
    return out


def fit_range(R):
    """신뢰도 × 상태마다 범위 배수 k — 실제 호가가 est·(lo/est)^k ~ est·(hi/est)^k 안에 50% 들게(지금 범위에서 다시 맞춤)"""
    tun = json.load(open(os.path.join(ROOT, "engine_tuning.json"), encoding="utf-8"))
    on = R[~R["sold"] & R["est"].notna()]
    K = {}
    for g in "ABC":
        row = []
        for j, kind in enumerate(KINDS):
            if kind == "미상":
                d = on[on["grade_u"] == g]; est, lo, hi = d["est_u"], d["lo_u"], d["hi_u"]
            else:
                d = on[(on["grade"] == g) & ((on["D"] > 0) == (kind == "사고"))]; est, lo, hi = d["est"], d["lo"], d["hi"]
            k0 = tun["range_k"][g][j]
            if len(d) < 200:
                row.append(k0)
                continue
            a = np.log(d["actual"] / est).values
            l, h = np.log(lo / est).values, np.log(hi / est).values                  # 지금 범위(이미 k0 배)
            cov = lambda k: float(((a >= l * k) & (a <= h * k)).mean())
            x0, x1 = 0.5, 6.0
            for _ in range(50):
                xm = (x0 + x1) / 2
                x0, x1 = (xm, x1) if cov(xm) < 0.5 else (x0, xm)
            row.append(round(k0 * (x0 + x1) / 2, 3))
        K[g] = row
    tun["range_k"] = K
    with open(os.path.join(ROOT, "engine_tuning.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(tun, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return K


def warnings(cur, prev):
    w = []
    for name, lab in (("class", "판매중"), ("class_sold", "판매 완료")):
        for c, v in cur.get(name, {}).items():
            if c != "무사고" and abs(v["bias"] - cur[name].get("무사고", {"bias": 0})["bias"]) > WARN_BIAS:
                w.append(f"{lab} {c} 치우침 {v['bias'] - cur[name]['무사고']['bias']:+.1f}%p(무사고 대비) — ±{WARN_BIAS:.0f}%p 넘음")
    if prev and cur["mdape"] - prev["mdape"] > WARN_MDAPE:
        w.append(f"오차 가운데 {prev['mdape']:.1f}% → {cur['mdape']:.1f}% (+{cur['mdape'] - prev['mdape']:.1f}%p)")
    return w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fit-range", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--sample", type=int, default=None)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    pool = PE.load_pool()
    C = PE.coef_from_json(json.load(open(os.path.join(ROOT, "web", "data", "adj_coef.json"), encoding="utf-8")))
    R = run(pool, C, a.sample)
    print(f"[시세 점검] 판매중 {int((~R['sold']).sum()):,} · 판매 완료 {int(R['sold'].sum()):,} · {time.time() - t0:.0f}초", flush=True)
    S = summarize(R)
    prev = None
    if os.path.exists(HIST):
        h = json.load(open(HIST, encoding="utf-8"))
        prev = h[-1] if h else None
    S["warnings"] = warnings(S, prev)
    print(json.dumps({k: S[k] for k in ("mdape", "within10", "over20", "bias", "mdape_unknown", "sold_bias", "sold_mdape")}, ensure_ascii=False))
    print("범위 적중(신뢰도 × 무사고 · 사고 · 미상):", S["coverage"])
    print("사고 단계(판매중):", {c: v["bias"] for c, v in S["class"].items()})
    print("사고 단계(판매 완료):", {c: v["bias"] for c, v in S["class_sold"].items()})
    print("차값 구간(추정값, 판매중):", {c: v["bias"] for c, v in S["band"].items()}, "· 판매 완료:", {c: v["bias"] for c, v in S["band_sold"].items()})
    print("경고:", S["warnings"] or "없음")
    if a.fit_range:
        print("범위 배수 →", fit_range(R), "(engine_tuning.json — 다시 내보내기 python price_engine.py --export)")
    if a.write:
        M = market(R)
        for name, obj in (("audit.json", S), ("cond_market.json", M)):
            with open(os.path.join(ROOT, "web", "data", name), "w", encoding="utf-8", newline="\n") as f:
                json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
                f.write("\n")
        h = json.load(open(HIST, encoding="utf-8")) if os.path.exists(HIST) else []
        h = [x for x in h if x.get("date") != S["date"]] + [{k: S[k] for k in ("date", "mdape", "bias", "sold_bias", "class", "class_sold")}]
        json.dump(h[-60:], open(HIST, "w", encoding="utf-8"), ensure_ascii=False)
        print("web/data/audit.json · cond_market.json 에 썼습니다")


if __name__ == "__main__":
    main()
