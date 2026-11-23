#!/usr/bin/env python3
"""第 67 回合（紅方）：把人類 PR 量尺的逐決策紀錄（`redSideStudy67.ts` 接好局面的 JSONL）依局面格拆開，找機器人落後真人最多的紅方決策。

    python3 scripts/redSideStudy67.py cells_A.jsonl --part scan [--min-s 55] [--roles assassin,morgana] [--top 40]
    python3 scripts/redSideStudy67.py cells_A.jsonl --part types
    python3 scripts/redSideStudy67.py cells_A.jsonl --part detail --type quest|vote|team|lakeTarget|lakeClaim [--round 1]
    python3 scripts/redSideStudy67.py cells_A.jsonl --cand cells_B.jsonl --part diff   （同一批決策點的候選 − 對照，依局面格）

量尺落差（一格）= Σ（機器人優勢 − 真人優勢）÷ 局數，單位 pp／局（該格全部紅方座位合計）；標準誤以局為集群（每局一個加總，沒有點的局算 0）。
這個量把「每點差多少 × 點數」合在一起（同第 66 回合）。只輸出彙總數字。
"""
import argparse
import json
import math
from collections import defaultdict


def load(path, roles, min_s, max_s):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if roles and r['role'] not in roles:
                continue
            if min_s is not None and (r['s'] is None or r['s'] < min_s):
                continue
            if max_s is not None and (r['s'] is None or r['s'] >= max_s):
                continue
            rows.append(r)
    return rows


def att(r):
    if r.get('forced'):
        return 'F'
    return 'a1-2' if r['attempt'] <= 2 else 'a3-4'


def cells(r):
    t = r['type']
    rg = f"R{r.get('round')}"
    role = r['role']
    out = []
    if t == 'vote':
        pos = r['pos']
        m = 'm1' if r['mates'] > 0 else 'm0'
        out += [(t, rg, r['score'], pos), (t, rg, r['score'], pos, att(r)), (t, rg, r['score'], pos, m), (t, rg, r['score'], pos, role),
                (t, rg, pos, m, att(r))]
    elif t == 'team':
        out += [(t, rg, r['score'], att(r)), (t, rg, r['score'], att(r), role), (t, rg, att(r))]
    elif t == 'quest':
        out += [(t, rg, r['score'], f"e{r['reds']}"), (t, rg, f"e{r['reds']}", f"k{r['known']}"), (t, rg, r['score'], f"e{r['reds']}", role), (t, rg)]
    elif t == 'lakeTarget':
        out += [(t, f"L{r['round']}", r['score']), (t, f"L{r['round']}", r['score'], role), (t,)]
    elif t == 'lakeClaim':
        out += [(t, f"L{r['round']}", r['truth']), (t, f"L{r['round']}", r['truth'], f"tk{r['tknown']}"), (t, r['truth'], role)]
    elif t == 'assassinate':
        out += [(t,)]
    return out


def agg(rows, G, keyfn):
    by = defaultdict(lambda: defaultdict(float))
    n = defaultdict(int)
    for r in rows:
        for k in keyfn(r):
            by[k][r['gi']] += r['b'] - r['h']
            n[k] += 1
    res = []
    for k, per in by.items():
        tot = sum(per.values())
        mean = tot / G
        ss = sum((v - mean) ** 2 for v in per.values()) + (G - len(per)) * mean ** 2
        se = math.sqrt(ss / (G - 1)) / math.sqrt(G)
        res.append((mean * 100, se * 100, n[k], k))
    return res


def n_games(rows):
    return len({r['gi'] for r in rows})


def part_scan(rows, G, args):
    res = agg(rows, G, cells)
    res.sort(key=lambda x: x[0])
    print(f"局數 G = {G}")
    print('| 局面格 | 決策點 | 量尺落差 pp／局 ± 標準誤 | 每點 pp |')
    print('|---|---|---|---|')
    for m, se, n, k in res[: args.top]:
        print(f"| {' '.join(map(str, k))} | {n} | {m:+.2f} ± {se:.2f} | {G * m / n:+.2f} |")
    print('\n最大的正（機器人比真人好）：')
    for m, se, n, k in sorted(res, key=lambda x: -x[0])[:12]:
        print(f"| {' '.join(map(str, k))} | {n} | {m:+.2f} ± {se:.2f} | {G * m / n:+.2f} |")


def part_types(rows, G, args):
    res = agg(rows, G, lambda r: [(r['type'],), (r['type'], r['role']), ('ALL',), ('ALL', r['role'])])
    res.sort(key=lambda x: x[3])
    print(f"局數 G = {G}")
    for m, se, n, k in res:
        print(f"| {' '.join(k)} | {n} | {m:+.2f} ± {se:.2f} |")


def pct(x):
    return f"{100 * x:.1f}"


def part_detail(rows, G, args):
    t = args.type
    rs = [r for r in rows if r['type'] == t and (args.round is None or r.get('round') == args.round)]
    groups = defaultdict(list)
    for r in rs:
        if t == 'quest':
            k = (f"R{r['round']}", r['score'], f"e{r['reds']}", f"k{r['known']}", f"n{r['need']}", f"lead{'S' if r['selfLead'] else ('M' if r['mateLead'] else 'B')}")
            if args.by_role:
                k += (r['role'],)
        elif t == 'vote':
            k = (f"R{r['round']}", r['score'], r['pos'], att(r), f"m{min(r['mates'], 2)}", f"lm{r['leaderMate']}")
            if args.by_role:
                k += (r['role'],)
        elif t == 'team':
            k = (f"R{r['round']}", r['score'], att(r))
            if args.by_role:
                k += (r['role'],)
        elif t == 'lakeTarget':
            k = (f"L{r['round']}", r['score'], r['role'])
        elif t == 'lakeClaim':
            k = (f"L{r['round']}", r['truth'], f"tk{r['tknown']}", r['role'])
        else:
            k = (r['role'],)
        groups[k].append(r)
    for k in sorted(groups, key=lambda k: sum(x['b'] - x['h'] for x in groups[k])):
        g = groups[k]
        if len(g) < args.min_n:
            continue
        n = len(g)
        d = 100 * sum(x['b'] - x['h'] for x in g) / G
        extra = ''
        if t == 'quest':
            extra = f"真人失敗 {pct(sum(x['hc'] for x in g) / n)}% 機器人失敗 {pct(sum(x['bc'] for x in g) / n)}%"
        elif t == 'vote':
            extra = f"真人贊成 {pct(sum(x['hv'] for x in g) / n)}% 機器人 {pct(sum(x['bv'] for x in g) / n)}% 同票 {pct(sum(x['agree'] for x in g) / n)}%"
        elif t == 'team':
            hb = [x for x in g if x.get('bt')]
            if hb:
                f = lambda key, side: sum(x[side][key] for x in hb) / len(hb)
                extra = (f"自己在 {f('self','ht'):.2f}/{f('self','bt'):.2f} 看得到的紅 {f('known','ht'):.2f}/{f('known','bt'):.2f} 實際紅 {f('reds','ht'):.2f}/{f('reds','bt'):.2f} "
                         f"莫德 {f('mord','ht'):.2f}/{f('mord','bt'):.2f} 出過失敗 {f('t','ht'):.2f}/{f('t','bt'):.2f} 照派 {f('u','ht'):.2f}/{f('u','bt'):.2f} 完全同隊 {pct(sum(x['agree'] for x in g) / n)}%")
        elif t == 'lakeTarget':
            hb = [x for x in g if x.get('btg')]
            f = lambda key, side: sum(x[side][key] for x in hb) / max(1, len(hb))
            extra = f"目標是紅 {f('red','htg'):.2f}/{f('red','btg'):.2f} 看得到的隊友 {f('known','htg'):.2f}/{f('known','btg'):.2f} 出過失敗 {f('t','htg'):.2f}/{f('t','btg'):.2f} 上一局隊上 {f('prev','htg'):.2f}/{f('prev','btg'):.2f}"
        elif t == 'lakeClaim':
            c = lambda side, v: sum(1 for x in g if x[side] == v) / n
            extra = f"說真話 {pct(c('hcl','truth'))}/{pct(c('bcl','truth'))}% 說謊 {pct(c('hcl','lie'))}/{pct(c('bcl','lie'))}%"
        print(f"| {' '.join(map(str, k))} | {n} | {d:+.2f} | 每點 {100 * sum(x['b'] - x['h'] for x in g) / n:+.2f} | {extra} |")


def part_diff(rows, cand, G, args):
    key = lambda r: (r['gi'], r['seat'], r['type'], r.get('round'), r.get('attempt'))
    cm = {key(r): r for r in cand}
    pairs = []
    for r in rows:
        c = cm.get(key(r))
        if c is None:
            continue
        pairs.append(dict(r, b=c['b'], h=r['b']))
    res = agg(pairs, G, lambda r: [('ALL',), ('ALL', r['role']), (r['type'],), (r['type'], r['role'])] + cells(r))
    res = [x for x in res if abs(x[0]) >= 0.005 or len(x[3]) <= 2]
    res.sort(key=lambda x: x[0])
    for m, se, n, k in res[: args.top]:
        print(f"| {' '.join(map(str, k))} | {n} | {m:+.3f} ± {se:.3f} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--cand')
    ap.add_argument('--part', default='scan')
    ap.add_argument('--type', default='quest')
    ap.add_argument('--round', type=int, default=None)
    ap.add_argument('--roles', default='assassin,morgana,mordred,oberon')
    ap.add_argument('--min-s', type=float, default=None)
    ap.add_argument('--max-s', type=float, default=None)
    ap.add_argument('--min-n', type=int, default=50)
    ap.add_argument('--top', type=int, default=40)
    ap.add_argument('--by-role', action='store_true')
    ap.add_argument('--games', type=int, default=None, help='局數 G（預設 = 有紅方決策的局數）')
    args = ap.parse_args()
    roles = set(args.roles.split(','))
    rows = load(args.path, roles, args.min_s, args.max_s)
    G = args.games or n_games(rows)
    if args.part == 'scan':
        part_scan(rows, G, args)
    elif args.part == 'types':
        part_types(rows, G, args)
    elif args.part == 'detail':
        part_detail(rows, G, args)
    elif args.part == 'diff':
        part_diff(rows, load(args.cand, roles, args.min_s, args.max_s), G, args)


if __name__ == '__main__':
    main()
