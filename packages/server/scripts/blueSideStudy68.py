#!/usr/bin/env python3
"""第 68 回合（藍方）：把人類 PR 量尺的逐決策紀錄（`blueSideStudy68.ts` 接好局面的 JSONL）依局面格拆開，找機器人落後真人最多的藍方決策。

    python3 scripts/blueSideStudy68.py cells_A.jsonl --part types|scan [--min-s 55] [--roles loyal,percival] [--top 40]
    python3 scripts/blueSideStudy68.py cells_A.jsonl --part detail --type vote|team|lakeTarget [--round 3] [--by-role]
    python3 scripts/blueSideStudy68.py cells_A.jsonl --cand cells_B.jsonl --part diff   （同一批決策點的候選 − 對照，依局面格）

量尺落差（一格）= Σ（機器人優勢 − 真人優勢）÷ 局數，單位 pp／局（該格全部藍方座位合計）；標準誤以局為集群（每局一個加總，沒有點的局算 0）。
同第 66、67 回合。只輸出彙總數字。
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


def lake_tag(x):
    """湖的資訊在這隊上：自己湖到的紅 > 被宣告紅 > 被宣告好 > 沒有。"""
    if x.get('lkr'):
        return 'lkr'
    if x.get('ldr'):
        return 'ldr'
    if x.get('ldg'):
        return 'ldg'
    return 'l0'


def cells(r):
    t = r['type']
    rg = f"R{r.get('round')}"
    role = r['role']
    out = []
    if t == 'vote':
        pos = r['pos']
        out += [(t, rg, r['score'], pos), (t, rg, r['score'], pos, att(r)), (t, rg, r['score'], pos, role), (t, rg, pos, role, att(r))]
        if r['lakes'] > 0:
            out += [(t, 'lake', pos, lake_tag(r)), (t, 'lake', pos, lake_tag(r), role)]
        if r['round'] >= 2:
            out += [(t, rg, pos, f"pf{r['pf']}", role)]
    elif t == 'team':
        out += [(t, rg, r['score'], att(r)), (t, rg, r['score'], att(r), role), (t, rg, att(r)), (t, f"pf{r.get('pf', 0)}", att(r), role)]
        if r['lakes'] > 0:
            out += [(t, 'lake', role)]
    elif t == 'lakeTarget':
        out += [(t, f"L{r['round']}", r['score']), (t, f"L{r['round']}", r['score'], role), (t, role), (t,)]
    elif t == 'lakeClaim':
        out += [(t, r['truth'], role)]
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
        if t == 'vote':
            k = (f"R{r['round']}", r['score'], r['pos'], att(r), f"r{min(r['reds'], 2)}")
            if args.lake:
                k = ('lake', r['pos'], lake_tag(r), f"r{min(r['reds'], 2)}")
        elif t == 'team':
            k = (f"R{r['round']}", r['score'], att(r), f"pf{r.get('pf', 0)}")
        elif t == 'lakeTarget':
            k = (f"L{r['round']}", r['score'])
        else:
            k = (r.get('truth', ''),)
        if args.by_role:
            k += (r['role'],)
        groups[k].append(r)
    for k in sorted(groups, key=lambda k: sum(x['b'] - x['h'] for x in groups[k])):
        g = groups[k]
        if len(g) < args.min_n:
            continue
        n = len(g)
        d = 100 * sum(x['b'] - x['h'] for x in g) / G
        extra = ''
        if t == 'vote':
            extra = f"真人贊成 {pct(sum(x['hv'] for x in g) / n)}% 機器人 {pct(sum(x['bv'] for x in g) / n)}% 同票 {pct(sum(x['agree'] for x in g) / n)}%"
        elif t == 'team':
            hb = [x for x in g if x.get('bt')]
            if hb:
                f = lambda key, side: sum(x[side][key] for x in hb) / len(hb)
                extra = (f"會失敗 {f('dirty','ht'):.2f}/{f('dirty','bt'):.2f} 自己在 {f('self','ht'):.2f}/{f('self','bt'):.2f} 實際紅 {f('reds','ht'):.2f}/{f('reds','bt'):.2f} "
                         f"出過失敗 {f('t','ht'):.2f}/{f('t','bt'):.2f} 照派 {f('u','ht'):.2f}/{f('u','bt'):.2f} 拇指 {f('th','ht'):.2f}/{f('th','bt'):.2f} "
                         f"看得到的紅 {f('kr','ht'):.2f}/{f('kr','bt'):.2f} 湖紅(自己/宣告) {f('lkr','ht'):.2f}/{f('lkr','bt'):.2f} {f('ldr','ht'):.2f}/{f('ldr','bt'):.2f} 完全同隊 {pct(sum(x['agree'] for x in g) / n)}%")
        elif t == 'lakeTarget':
            hb = [x for x in g if x.get('btg')]
            f = lambda key, side: sum(x[side][key] for x in hb) / max(1, len(hb))
            extra = (f"目標是紅 {f('red','htg'):.2f}/{f('red','btg'):.2f} 出過失敗 {f('t','htg'):.2f}/{f('t','btg'):.2f} 上一局隊上 {f('prev','htg'):.2f}/{f('prev','btg'):.2f} "
                     f"拇指 {f('th','htg'):.2f}/{f('th','btg'):.2f} 看得到的紅 {f('kr','htg'):.2f}/{f('kr','btg'):.2f} 被宣告紅/好 {f('ldr','htg'):.2f}/{f('ldr','btg'):.2f} {f('ldg','htg'):.2f}/{f('ldg','btg'):.2f} 同目標 {pct(sum(x['agree'] for x in g) / n)}%")
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
    ap.add_argument('--type', default='vote')
    ap.add_argument('--round', type=int, default=None)
    ap.add_argument('--roles', default='loyal,percival,merlin')
    ap.add_argument('--min-s', type=float, default=None)
    ap.add_argument('--max-s', type=float, default=None)
    ap.add_argument('--min-n', type=int, default=50)
    ap.add_argument('--top', type=int, default=40)
    ap.add_argument('--by-role', action='store_true')
    ap.add_argument('--lake', action='store_true', help='detail vote：依湖的資訊分格')
    ap.add_argument('--games', type=int, default=None, help='局數 G（預設 = 有藍方決策的局數）')
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
