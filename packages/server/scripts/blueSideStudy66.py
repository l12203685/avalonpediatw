#!/usr/bin/env python3
"""第 66 回合（藍方）：彙總 `blueSideStudy66.ts` 的 JSONL（同一批真人決策點，機器人 vs 真人／高端桌）。

    python3 scripts/blueSideStudy66.py rows_*.jsonl --part votes|leads|scan [--col A] [--cand X] [--min-s 55] [--roles loyal,percival]

- votes：藍方非強制投票，分局面列 真人／機器人 贊成率、票對（乾淨隊贊成、會失敗的隊反對；第 4 局要兩張）與配對差。
- leads：藍方隊長的提議，分局面列 會失敗的比例（紅數 ≥ 要的失敗張數）與隊伍組成。
- scan：把所有局面格依「格內點數 × |機器人 − 真人 票對差|」排序（找最大的落差）。
`--cand` 給了就另列 候選 − 現行（同一批點的配對差）。95% 區間以局為集群。只輸出彙總數字。
"""
import argparse
import json
import math
from collections import defaultdict


def load(paths, roles, min_s, max_s):
    rows = []
    for p in paths:
        with open(p) as f:
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


def cluster_mean(pairs):
    """pairs: list of (game, value). Returns mean, half-width of 95% CI (cluster by game)."""
    n = len(pairs)
    if n == 0:
        return float('nan'), float('nan')
    m = sum(v for _, v in pairs) / n
    by = defaultdict(lambda: [0.0, 0])
    for g, v in pairs:
        by[g][0] += v
        by[g][1] += 1
    G = len(by)
    if G < 2:
        return m, float('nan')
    ss = sum((s - m * c) ** 2 for s, c in by.values())
    se = math.sqrt(ss * G / (G - 1)) / n
    return m, 1.96 * se


def pct(x):
    return f"{100 * x:.1f}" if x == x else '—'


def score_key(r):
    return f"{r['bw']}:{r['rw']}"


def vote_correct(r, v):
    return 1 if (v == 1) == (r['dirty'] == 0) else 0


def vote_cells(r):
    """All cell keys a vote row belongs to (for scan)."""
    on = 'on' if r['on'] else 'off'
    if r['leaderSelf']:
        on = 'lead'
    rg = f"R{r['round']}"
    sc = score_key(r)
    att = 'a1-2' if r['attempt'] <= 2 else 'a3-4'
    keys = [
        (rg, sc, on),
        (rg, sc, on, att),
        (rg, sc, on, r['role']),
    ]
    if r['round'] >= 2:
        keys.append((rg, sc, on, 'fm' + str(min(r['fm'], 2))))
    if r['role'] == 'percival':
        keys.append((rg, sc, on, 'th' + str(min(r['th'], 2))))
    return keys


def part_votes(rows, col, cand, args):
    vs = [r for r in rows if r['kind'] == 'vote' and r.get(col) is not None]
    groups = defaultdict(list)
    for r in vs:
        on = 'lead' if r['leaderSelf'] else ('on' if r['on'] else 'off')
        groups[(f"R{r['round']}", score_key(r), on)].append(r)
    print(f"| 局 | 比分 | 位置 | n | 真人贊成 | {col} 贊成 | 差 | 真人票對 | {col} 票對 | 票對差 [95%] | 同票 |" + (f" {cand}−{col} 贊成 | {cand}−{col} 票對 |" if cand else ''))
    print('|---|---|---|---|---|---|---|---|---|---|---|' + ('---|---|' if cand else ''))
    for k in sorted(groups):
        g = groups[k]
        if len(g) < args.min_n:
            continue
        n = len(g)
        h = sum(r['human'] for r in g) / n
        b = sum(r[col] for r in g) / n
        hc = sum(vote_correct(r, r['human']) for r in g) / n
        bc = sum(vote_correct(r, r[col]) for r in g) / n
        d, hw = cluster_mean([(r['gi'], vote_correct(r, r[col]) - vote_correct(r, r['human'])) for r in g])
        agree = sum(1 for r in g if r[col] == r['human']) / n
        line = f"| {k[0]} | {k[1]} | {k[2]} | {n} | {pct(h)} | {pct(b)} | {100*(b-h):+.1f} | {pct(hc)} | {pct(bc)} | {100*d:+.1f} ± {100*hw:.1f} | {pct(agree)} |"
        if cand:
            gc = [r for r in g if r.get(cand) is not None]
            dy, hy = cluster_mean([(r['gi'], r[cand] - r[col]) for r in gc])
            dc, hc2 = cluster_mean([(r['gi'], vote_correct(r, r[cand]) - vote_correct(r, r[col])) for r in gc])
            line += f" {100*dy:+.1f} ± {100*hy:.1f} | {100*dc:+.1f} ± {100*hc2:.1f} |"
        print(line)


def lead_cells(r):
    rg = f"R{r['round']}"
    sc = score_key(r)
    f = 'F' if r['forced'] else ('a1-2' if r['attempt'] <= 2 else 'a3-4')
    return [(rg, sc, f), (rg, sc, f, r['role'])]


def part_leads(rows, col, cand, args):
    ls = [r for r in rows if r['kind'] == 'lead' and r.get(col) is not None and r['human'] is not None]
    groups = defaultdict(list)
    for r in ls:
        f = 'F' if r['forced'] else f"a{r['attempt']}"
        key = (f"R{r['round']}", score_key(r), f) if not args.by_role else (f"R{r['round']}", score_key(r), f, r['role'])
        groups[key].append(r)
    feats = ['self', 'fm', 'lf', 'lo', 'th', 'kr']
    print(f"| 局面 | n | 真人會失敗 | {col} 會失敗 | 差 [95%] | " + ' | '.join(f"{x} 真人/{col}" for x in feats) + (f" | {cand}−{col} 會失敗 |" if cand else ' |'))
    print('|---|---|---|---|---|' + '---|' * len(feats) + ('---|' if cand else ''))
    for k in sorted(groups):
        g = groups[k]
        if len(g) < args.min_n:
            continue
        n = len(g)
        hd = sum(r['human']['dirty'] for r in g) / n
        bd = sum(r[col]['dirty'] for r in g) / n
        d, hw = cluster_mean([(r['gi'], r[col]['dirty'] - r['human']['dirty']) for r in g])
        fs = []
        for x in feats:
            hv = [r['human'][x] for r in g if r['human'][x] is not None]
            bv = [r[col][x] for r in g if r[col][x] is not None]
            fs.append(f"{sum(hv)/len(hv):.2f}/{sum(bv)/len(bv):.2f}" if hv and bv else '—')
        line = f"| {' '.join(map(str, k))} | {n} | {pct(hd)} | {pct(bd)} | {100*d:+.1f} ± {100*hw:.1f} | " + ' | '.join(fs)
        if cand:
            gc = [r for r in g if r.get(cand) is not None]
            dc, hc = cluster_mean([(r['gi'], r[cand]['dirty'] - r[col]['dirty']) for r in gc])
            line += f" | {100*dc:+.1f} ± {100*hc:.1f} |"
        else:
            line += ' |'
        print(line)


def part_scan(rows, col, args):
    out = []
    cells = defaultdict(list)
    for r in rows:
        if r['kind'] == 'vote' and r.get(col) is not None:
            for k in vote_cells(r):
                cells[('vote',) + k].append(r)
        if r['kind'] == 'lead' and r.get(col) is not None and r['human'] is not None:
            for k in lead_cells(r):
                cells[('lead',) + k].append(r)
    for k, g in cells.items():
        if len(g) < args.min_n:
            continue
        if k[0] == 'vote':
            pairs = [(r['gi'], vote_correct(r, r[col]) - vote_correct(r, r['human'])) for r in g]
            agree = sum(1 for r in g if r[col] == r['human']) / len(g)
            dy = sum(r[col] - r['human'] for r in g) / len(g)
        else:
            # lead: correct = not dirty
            pairs = [(r['gi'], r['human']['dirty'] - r[col]['dirty']) for r in g]
            agree = float('nan')
            dy = float('nan')
        d, hw = cluster_mean(pairs)
        out.append((len(g) * d, k, len(g), d, hw, agree, dy))
    out.sort(key=lambda x: x[0])
    print('| 種類 | 局面格 | n | 對的比例 機器人−真人 [95%] | n × 差 | 同票 | 贊成差 |')
    print('|---|---|---|---|---|---|---|')
    for tot, k, n, d, hw, agree, dy in out[: args.top]:
        print(f"| {k[0]} | {' '.join(map(str, k[1:]))} | {n} | {100*d:+.1f} ± {100*hw:.1f} | {tot:+.0f} | {pct(agree)} | {100*dy:+.1f} |")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--part', default='votes')
    ap.add_argument('--col', default='A')
    ap.add_argument('--cand', default=None)
    ap.add_argument('--min-s', type=float, default=None)
    ap.add_argument('--max-s', type=float, default=None)
    ap.add_argument('--roles', default='loyal,percival,merlin')
    ap.add_argument('--min-n', type=int, default=100)
    ap.add_argument('--top', type=int, default=40)
    ap.add_argument('--by-role', action='store_true')
    args = ap.parse_args()
    rows = load(args.paths, set(args.roles.split(',')), args.min_s, args.max_s)
    if args.part == 'votes':
        part_votes(rows, args.col, args.cand, args)
    elif args.part == 'leads':
        part_leads(rows, args.col, args.cand, args)
    else:
        part_scan(rows, args.col, args)


if __name__ == '__main__':
    main()
