# -*- coding: utf-8 -*-
"""
cond_refit.py — 기록부 감가 표(cond_table.json)를 팔린 차 기준으로 다시 맞춘다 (기획 v2.33 5.16 · 인터뷰 Q237 Q241 Q243 Q258)

    python tools/cond_refit.py            # 맞춘 결과와 전·후 점검만 보여 줌
    python tools/cond_refit.py --write    # cond_table.json 에 쓰고(그다음 python inspection_score.py --export)

방법
  1) 매물마다 '무사고 비교 매물만'으로 무사고 시세(자기 · 같은 차 제외)를 내고, 실제 호가(팔린 차는 시점 보정) ÷ 그 값의 로그를
     무사고 매물의 가운데로 맞춘다 → 사고 차의 시장 차이 y
  2) 사고 차의 y 에 표를 맞춘다(가운데 회귀, 팔린 차 3 : 판매중 1 가중 — Q237 팔린 차 기준, 판매중은 표본 보강)
     1곳당 값 · 한 번 감가 → 차값 배수(외판 · 골격, 1,400만 원 = 1) → k번째 곳 배수를 번갈아 3번, 마지막에 사고 단계별 가운데를 0으로
     쓰인 횟수가 적은 칸(300 미만)은 지금 값 쪽으로 당긴다
  3) 같은 줄 교환 ≤ 판금 ≤ 0 · 차값 배수 0.3~2 · k번째 곳 배수는 1~3번째 1, 그 뒤 늘지 않게(0.3~1)
  4) 전 · 후 점검: 팔린 차 · 판매중 각각 사고 단계 · 차값 구간 · 곳수별 치우침(가운데) — 0에 가까울수록 맞음
팀이 ⚙에서 고친 칸(/api/cond)은 이 파일이 아니라 저장소에 있으므로 그대로 남는다(사이트에서 팀 값이 앞선다).
"""
import os, sys, json, math, time, argparse, datetime
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import price_engine as PE
import inspection_score as IS

SHRINK_N = 300                    # 팔린 차가 이보다 적은 칸은 지금 값 쪽으로 당김
GROUPS = ("외판", "골격")
ORDER = ["무사고", "외판1·판금", "외판1·교환", "외판2·판금", "외판2·교환", "골격·판금", "골격·교환"]


def clean_bases(pool, C):
    """무사고 비교 매물(교환 · 판금 이력 없음)만으로 본 무사고 시세 — 매물마다 자기 · 같은 차 제외"""
    items = {i: PE.Cond.from_names(PE.damage_names(s)) for i, s in pool["손상부위"].items()}
    clean = pool.index.map(lambda i: not any(PE.STATUS3.get(it["status"]) in ("교환", "판금") for it in items[i]))
    pool = pool.assign(_clean=np.asarray(clean))
    G = {k: PE.Group(g, C) for k, g in pool[pool["_clean"]].groupby("key")}
    out = np.full(len(pool), np.nan)
    for n, r in enumerate(pool.itertuples()):
        g = G.get(r.key)
        if g is None:
            continue
        t = {"등급": r.등급, "세부": r.세부, "age": r.age, "km": r.km, "rent": r.rent,
             "color": r.색상계열 if r.색상계열 in PE.COLORS or r.색상계열 == "흰색·진주" else None,
             "items": [], "dv": r.dv, "se": r.se, "us": r.us, "exclude_id": r.Index, "carkey": r.차키 if isinstance(r.차키, str) else None}
        a = PE.estimate_one(g, t)
        out[n] = a["est"] if a else np.nan
    return out, items


def decompose(cond, items, price):
    """Cond.hist 와 같은 순서로 나눈 값: [(줄 키|상태, 외판·골격, 곳 순번 k)], 사고 여부, 골격 여부"""
    cnt, ent, any_, frame = {}, [], False, False
    for it in items:
        s, inf = PE.STATUS3.get(it["status"]), cond.info(it["part"])
        if s not in ("교환", "판금") or not inf:
            continue
        any_ = True
        frame = frame or inf["rank"] == "골격"
        key = ("골격" if inf["rank"] == "골격" else inf["group"]) + "|" + s
        cnt[key] = cnt.get(key, 0) + 1
        if cnt[key] > cond.T["cap"]:
            continue
        r = cond.rows.get(inf["group"])
        rk = inf["group"] if r and r.get(s) is not None and inf["rank"] != "골격" else inf["rank"]
        g = "골격" if inf["rank"] == "골격" else "외판"
        ent.append((math.log(1 + cond.row_value(inf, s) / 100) * cond.mult(g, price), rk + "|" + s, g))
    ent.sort(key=lambda e: e[0])
    return [(p, g, k) for k, (_, p, g) in enumerate(ent)], any_, frame


def lam(anchors, price):
    """차값 배수의 칸별 몫(로그 차값 직선 사이) — Cond.mult 와 같은 규칙"""
    A, w = anchors, np.zeros(len(anchors))
    if price is None or not price > 0 or price <= A[0]:
        w[0] = 1.0
        return w
    for k in range(len(A) - 1):
        if price < A[k + 1]:
            t = (math.log(price) - math.log(A[k])) / (math.log(A[k + 1]) - math.log(A[k]))
            w[k], w[k + 1] = 1 - t, t
            return w
    w[-1] = 1.0
    return w


def qreg(y, X, w=None):
    """가운데 회귀 — w(정수 가중)는 행을 그만큼 되풀이해서"""
    import statsmodels.api as sm
    if w is not None:
        ix = np.repeat(np.arange(len(y)), w)
        y, X = y[ix], X[ix]
    return sm.QuantReg(y, X).fit(q=0.5, max_iter=5000).params


def wmedian(v, w):
    o = np.argsort(v)
    c = np.cumsum(w[o])
    return float(v[o][np.searchsorted(c, c[-1] / 2)])


def table_params(T):
    keys = []
    for r in T["rows"]:
        for s in ("교환", "판금"):
            if r[s] is not None:
                keys.append(r["key"] + "|" + s)
    return keys + ["once|사고", "once|골격"]


def fit(T0, cases, prices, wts, labels):
    """cases: [(y, items)] 사고 차, wts: 가중(팔린 차 3 · 판매중 1), labels: 사고 단계. 번갈아 맞추기 — 1곳당 값 · 한 번 → 차값 배수 → k번째 곳 배수 → 사고 단계 맞춤"""
    T = json.loads(json.dumps(T0))
    keys = table_params(T)
    val = {}
    for r in T["rows"]:
        for s in ("교환", "판금"):
            if r[s] is not None:
                val[r["key"] + "|" + s] = math.log(1 + r[s] / 100)
    val["once|사고"], val["once|골격"] = math.log(1 + T["once"]["사고"] / 100), math.log(1 + T["once"]["골격"] / 100)
    y = np.array([c[0] for c in cases])
    nuse = {k: 0 for k in keys}
    for it in range(3):
        cond = PE.Cond(T)
        dec = [decompose(cond, c[1], p) for c, p in zip(cases, prices)]
        # ① 1곳당 값 · 한 번 감가(차값 · k번째 배수는 그대로)
        X = np.zeros((len(cases), len(keys)))
        ki = {k: j for j, k in enumerate(keys)}
        for n, ((ents, any_, frame), p) in enumerate(zip(dec, prices)):
            m = {g: cond.mult(g, p) for g in GROUPS}
            for key, g, k in ents:
                X[n, ki[key]] += cond.order[min(k, len(cond.order) - 1)] * m[g]
                if it == 0:
                    nuse[key] += int(wts[n])
            if any_:
                X[n, ki["once|사고"]] += m["외판"]
            if frame:
                X[n, ki["once|골격"]] += m["골격"]
        if it == 0:
            nuse["once|사고"] = int(wts[X[:, ki["once|사고"]] > 0].sum())
            nuse["once|골격"] = int(wts[X[:, ki["once|골격"]] > 0].sum())
        used = X.any(axis=0)                                                     # 한 번도 안 나온 칸은 그대로
        bu, b = qreg(y, X[:, used], wts), np.full(len(keys), np.nan)
        b[np.flatnonzero(used)] = bu
        for k, j in ki.items():
            if not used[j]:
                continue
            w = nuse[k] / (nuse[k] + SHRINK_N)                                   # 적은 칸은 지금 값 쪽으로
            val[k] = min(0.0, w * b[j] + (1 - w) * val[k])
        _write_vals(T, val)
        # ② 차값 배수(외판 · 골격, 1,400만 원 칸 = 1)
        cond = PE.Cond(T)
        dec = [decompose(cond, c[1], p) for c, p in zip(cases, prices)]
        A = cond.anchors
        cols = [(g, j) for g in GROUPS for j in range(len(A)) if j != 1]
        X, off = np.zeros((len(cases), len(cols))), np.zeros(len(cases))
        for n, ((ents, any_, frame), p) in enumerate(zip(dec, prices)):
            lw, S = lam(A, p), {g: 0.0 for g in GROUPS}
            for key, g, k in ents:
                S[g] += cond.order[min(k, len(cond.order) - 1)] * val[key]
            if any_:
                S["외판"] += val["once|사고"]
            if frame:
                S["골격"] += val["once|골격"]
            for c, (g, j) in enumerate(cols):
                X[n, c] = lw[j] * S[g]
            off[n] = sum(lw[1] * S[g] for g in GROUPS)                           # 1,400만 원 칸 몫은 배수 1
        b = qreg(y - off, X, wts)
        for c, (g, j) in enumerate(cols):
            T["band"][g][j] = float(np.clip(b[c], 0.3, 2.0))
        for g in GROUPS:
            T["band"][g][1] = 1.0
        # ③ k번째 곳 배수(1~3번째는 1)
        cond = PE.Cond(T)
        dec = [decompose(cond, c[1], p) for c, p in zip(cases, prices)]
        X, off = np.zeros((len(cases), 3)), np.zeros(len(cases))
        for n, ((ents, any_, frame), p) in enumerate(zip(dec, prices)):
            m = {g: cond.mult(g, p) for g in GROUPS}
            for key, g, k in ents:
                v = val[key] * m[g]
                if k < 3:
                    off[n] += v
                else:
                    X[n, min(k, 5) - 3] += v
            if any_:
                off[n] += m["외판"] * val["once|사고"]
            if frame:
                off[n] += m["골격"] * val["once|골격"]
        has = X.any(axis=0)
        b = qreg(y - off, X[:, has], wts) if has.any() else []
        q, j = [1.0, 1.0, 1.0], 0
        for c in range(3):
            q.append(float(b[j]) if has[c] else q[-1])
            j += int(has[c])
        prev = 1.0
        for c in range(3, 6):
            prev = float(np.clip(min(prev, q[c]), 0.3, 1.0))
            q[c] = prev
        T["order"] = [round(x, 3) for x in q]
    _write_vals(T, val)
    # ④ 사고 단계별 가운데(가중)를 0으로 — 그 단계를 정하는 칸(같은 단계 · 상태의 1곳당 값)을 함께 늘이거나 줄인다
    defn = {"외판1·판금": ("외판1", "판금"), "외판1·교환": ("외판1", "교환"), "외판2·판금": ("외판2", "판금"),
            "외판2·교환": ("외판2", "교환"), "골격·판금": ("골격", "판금"), "골격·교환": ("골격", "교환")}
    rank_of = {r["key"]: (r["key"] if r["key"] in ("외판1", "외판2", "골격") else IS.PART_RANK[next(p for p, g in IS.SCORE_GROUP.items() if g == r["key"])])
               for r in T["rows"]}
    lab = np.array(labels)
    for _ in range(8):
        cond = PE.Cond(T)
        L = np.array([math.log(1 - cond.hist(c[1], p)) for c, p in zip(cases, prices)])
        worst = 0.0
        for c, (rk, st) in defn.items():
            m = lab == c
            if m.sum() < 100:
                continue
            bias = wmedian(y[m] - L[m], wts[m])                                  # + 면 표가 더 깎음
            worst = max(worst, abs(bias))
            f = 1 - 0.8 * bias / max(1e-6, -float(np.median(L[m])))
            for r in T["rows"]:
                k = r["key"] + "|" + st
                if rank_of[r["key"]] == rk and k in val:
                    val[k] = min(0.0, val[k] * f)
        _write_vals(T, val)
        if worst < 0.002:
            break
    for g in GROUPS:
        T["band"][g] = [round(x, 3) for x in T["band"][g]]
    return T, nuse


def _write_vals(T, val):
    for r in T["rows"]:
        for s in ("교환", "판금"):
            k = r["key"] + "|" + s
            if k in val:
                r[s] = round((math.exp(val[k]) - 1) * 100, 1)                   # 팀 수정(⚙)과 같은 소수 첫째 자리
    T["once"]["사고"] = round((math.exp(val["once|사고"]) - 1) * 100, 1)
    T["once"]["골격"] = round((math.exp(val["once|골격"]) - 1) * 100, 1)
    rank_of_group = {v: IS.PART_RANK[p] for p, v in IS.SCORE_GROUP.items()}
    rows = {r["key"]: r for r in T["rows"]}
    for r in T["rows"]:                                                              # 교환 ≤ 판금 ≤ 0
        pg = r["판금"] if r["판금"] is not None else (rows.get(rank_of_group.get(r["key"]), {}).get("판금"))
        if pg is not None and r["교환"] is not None and r["교환"] > pg:
            r["교환"] = pg


def check(title, d, T):
    """치우침(가운데): 실제 시장 차이 − 표 감가(로그) — 0에 가까울수록 맞음. 표가 더 깎으면 +"""
    cond = PE.Cond(T)
    pred = np.array([math.log(1 - cond.hist(it, p)) for it, p in zip(d["items"], d["price_c"])])
    r = d["y"].values - pred
    out = {}
    d = d.assign(단계차값=d["사고"] + " " + d["band"])
    for name, key in (("사고 단계", "사고"), ("차값 구간", "band"), ("곳수", "곳수"), ("단계 × 차값", "단계차값")):
        out[name] = {str(k): (round(float(np.median(r[(d[key] == k).values])) * 100, 2), int((d[key] == k).sum()))
                     for k in d[key].dropna().unique() if (d[key] == k).sum() >= 100}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    t0 = time.time()
    pool = PE.load_pool()
    C = PE.coef_from_json(json.load(open(os.path.join(ROOT, "web", "data", "adj_coef.json"), encoding="utf-8")))
    base_c, items = clean_bases(pool, C)
    d = pool.assign(base_c=base_c).dropna(subset=["base_c"]).copy()
    d["items"] = [items[i] for i in d.index]
    d["y0"] = np.log(d["price"] * np.where(d["sold"], d["tf"], 1.0) / d["base_c"])
    d["사고"] = d["사고라벨"].fillna("미상")
    for s in (True, False):                                                          # 팔린 차 · 판매중 각각 무사고 가운데 = 0
        m = d["sold"] == s
        d.loc[m, "y"] = d.loc[m, "y0"] - d.loc[m & (d["사고"] == "무사고"), "y0"].median()
    d["price_c"] = d["base_c"]
    d["band"] = pd.cut(d["base_c"], [0, 1000, 2000, 4000, 1e9], labels=["1천 미만", "1~2천", "2~4천", "4천+"]).astype(str)
    d["곳수"] = [min(6, sum(1 for it in x if PE.STATUS3.get(it["status"]) in ("교환", "판금"))) for x in d["items"]]
    dam = d[d["곳수"] > 0]
    print(f"[감가 표 다시 맞추기] 무사고 시세 {len(d):,}대 · 사고 차 {len(dam):,}대(팔린 차 {int(dam['sold'].sum()):,}) · {time.time() - t0:.0f}초", flush=True)
    T0 = json.loads(json.dumps(IS.COND_TABLE))
    wts = np.where(dam["sold"], 3, 1)                                              # 팔린 차 3 : 판매중 1
    T1, nuse = fit(T0, list(zip(dam["y"], dam["items"])), list(dam["price_c"]), wts, list(dam["사고"]))
    T1["version"] = datetime.date.today().isoformat()
    print(f"맞춤 {time.time() - t0:.0f}초")
    print("\n[1곳당 값 · 한 번 감가] 지금 → 새 값(쓰인 횟수, 팔린 차 ×3)")
    for r0, r1 in zip(T0["rows"], T1["rows"]):
        print(f"  {r0['label']:<24} 교환 {r0['교환']} → {r1['교환']} ({nuse.get(r0['key'] + '|교환', 0)}) · 판금 {r0['판금']} → {r1['판금']} ({nuse.get(r0['key'] + '|판금', 0)})")
    print(f"  사고 이력(한 번) {T0['once']['사고']} → {T1['once']['사고']} · 골격(한 번) {T0['once']['골격']} → {T1['once']['골격']}")
    print(f"[차값 배수] {T1['band']['labels']}  외판 {T1['band']['외판']} · 골격 {T1['band']['골격']}")
    print(f"[k번째 곳 배수] {T1['order']}")
    for kind, m in (("팔린 차", dam["sold"]), ("판매중", ~dam["sold"])):
        b0, b1 = check(kind, dam[m], T0), check(kind, dam[m], T1)
        print(f"\n[{kind}] 치우침(가운데, %p — 표가 시장보다 더 깎으면 +): 지금 → 새 값")
        for name in b0:
            keys = ORDER if name == "사고 단계" else sorted(b0[name], key=str)
            if name == "단계 × 차값":
                keys = [k for k in keys if abs(b1[name].get(k, (0,))[0]) >= 1.0 or abs(b0[name].get(k, (0,))[0]) >= 1.5]   # 1%p 넘는 칸만
            print("  " + name + ": " + " · ".join(f"{k} {b0[name][k][0]:+.1f}→{b1[name][k][0]:+.1f}" for k in keys if k in b0[name] and k in b1[name]))
    if a.write:
        path = os.path.join(ROOT, "cond_table.json")
        cur = json.load(open(path, encoding="utf-8"))                               # 다른 칸(경매 기준 감가 등)은 그대로
        for k in ("version", "rows", "once", "band", "order"):
            cur[k] = T1[k]
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(cur, f, ensure_ascii=False, indent=1)
            f.write("\n")
        print("\ncond_table.json 에 썼습니다 → python inspection_score.py --export")


if __name__ == "__main__":
    main()
