#!/usr/bin/env python3
"""第 72 回合（藍方）：第 2 局（第 1 局失敗之後）藍方隊長非強制的提議，依角色 × 隊長在不在第 1 局的隊上 × 第 1 局幾張失敗 × 第幾次拆人類 PR 量尺落差
（另列全部、偶數號／奇數號局、桌上強度三層 × 兩半，給第 1H 節用；S 的切點同網站 38／55）。

    python3 scripts/r2LeadStudy72.py r2_A.jsonl [--games 2250]                 （拆格：落差、真人／機器人的隊）
    python3 scripts/r2LeadStudy72.py r2_A.jsonl --cand r2_X.jsonl [--games 2250]  （同一批決策點的候選 − 對照，依同樣的格）

量尺落差（一格）= Σ（機器人優勢 − 真人優勢）÷ 局數，單位 pp／局；標準誤以局為集群（每局一個加總，沒有點的局算 0；局數 = 量尺可重播的局數，預設 2,250）。
只輸出彙總數字。
"""
import argparse
import json
import math
from collections import defaultdict


def load(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def att(r):
    return 'a1-2' if r['att'] <= 2 else 'a3-4'


def keys(r):
    pos = 'onR1' if r['onR1'] else 'offR1'
    f = f"f{min(r['f1'], 2)}"
    s = r.get('s')
    tier = 'S?' if s is None else ('weak' if s < 38 else 'avg' if s < 55 else 'strong')
    half = 'even' if r['gi'] % 2 == 0 else 'odd'
    return [('ALL',), ('ALL', half), ('ALL', tier), ('ALL', tier, half), (r['role'],),
            ('ALL', att(r)), (r['role'], att(r)), (r['role'], att(r), pos), (r['role'], att(r), pos, f), ('ALL', att(r), pos)]


def agg(rows, G, val):
    by = defaultdict(lambda: defaultdict(float))
    n = defaultdict(int)
    ex = defaultdict(list)
    for r in rows:
        for k in keys(r):
            by[k][r['gi']] += val(r)
            n[k] += 1
            ex[k].append(r)
    out = []
    for k, per in by.items():
        mean = sum(per.values()) / G
        ss = sum((v - mean) ** 2 for v in per.values()) + (G - len(per)) * mean ** 2
        se = math.sqrt(ss / (G - 1)) / math.sqrt(G)
        out.append((k, mean * 100, se * 100, n[k], ex[k]))
    return sorted(out, key=lambda x: x[0])


def side_mean(ex, side, key):
    xs = [r[side][key] for r in ex if r.get(side)]
    return sum(xs) / max(1, len(xs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--cand')
    ap.add_argument('--games', type=int, default=2250)
    args = ap.parse_args()
    rows = load(args.path)
    G = args.games
    if args.cand:
        cand = {(r['gi'], r['role'], r['att']): r for r in load(args.cand)}
        pairs = []
        for r in rows:
            c = cand.get((r['gi'], r['role'], r['att']))
            if c is not None:
                pairs.append(dict(r, cb=c['b'], cbt=c.get('bt'), changed=int(c.get('bt') != r.get('bt'))))
        print('| 格 | 決策點 | 改到 | Δ 量尺 pp／局 ± 標準誤 | 會失敗 對照→候選 |')
        print('|---|---|---|---|---|')
        for k, m, se, n, ex in agg(pairs, G, lambda r: r['cb'] - r['b']):
            d0 = sum(r['bt']['dirty'] for r in ex if r.get('bt') and r.get('cbt')) / max(1, len(ex))
            d1 = sum(r['cbt']['dirty'] for r in ex if r.get('bt') and r.get('cbt')) / max(1, len(ex))
            print(f"| {' '.join(k)} | {n} | {sum(r['changed'] for r in ex)} | {m:+.3f} ± {se:.3f} | {d0:.3f} → {d1:.3f} |")
        return
    print('| 格 | 決策點 | 量尺落差 pp／局 ± 標準誤 | 會失敗 真人／機器人 | 自己在 | 隊上第 1 局的人 | 選到的第 1 局的人是紅 | 其他人是紅 | 和前面提議的重疊 | 拇指 | 完全同隊 |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    for k, m, se, n, ex in agg(rows, G, lambda r: r['b'] - r['h']):
        def red_rate(side, part):
            num = sum(r[side][part + 'Red'] for r in ex if r.get(side))
            den = sum((r[side]['t'] if part == 't' else (len_team(r, side) - r[side]['self'] - r[side]['t'])) for r in ex if r.get(side))
            return num / max(1, den)
        cells = [f"{side_mean(ex, s, 'dirty'):.3f}" for s in ('ht', 'bt')]
        print(f"| {' '.join(k)} | {n} | {m:+.2f} ± {se:.2f} | {cells[0]}／{cells[1]} | {side_mean(ex, 'ht', 'self'):.2f}／{side_mean(ex, 'bt', 'self'):.2f} | "
              f"{side_mean(ex, 'ht', 't'):.2f}／{side_mean(ex, 'bt', 't'):.2f} | {red_rate('ht', 't'):.3f}／{red_rate('bt', 't'):.3f} | "
              f"{red_rate('ht', 'c'):.3f}／{red_rate('bt', 'c'):.3f} | {side_mean(ex, 'ht', 'ov'):.2f}／{side_mean(ex, 'bt', 'ov'):.2f} | "
              f"{side_mean(ex, 'ht', 'th'):.2f}／{side_mean(ex, 'bt', 'th'):.2f} | {100 * sum(r['agree'] for r in ex) / n:.0f}% |")


def len_team(r, side):
    """第 2 局（十人局）的隊是 4 人。"""
    return 4


if __name__ == '__main__':
    main()
