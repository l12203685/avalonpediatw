#!/usr/bin/env python3
"""第 84 回合：第 1 關（逐決策和真人一不一致）——人類 PR 量尺的兩份逐決策紀錄（`humanPrBenchmark.ts --dump`），只看投票。

  python3 scripts/voteGate84.py base.jsonl cand.jsonl [--md]

同一個（局, 座位, 決策序號）配對；候選改到的投票（機器人的票不同）裡，對照與候選各有幾票和真人的票一樣；
全部投票的一致率差 = (候選一致 − 對照一致) ÷ 全部投票，標準誤以局為集群。分角色列。第 84 回合的開關只在紅方聽牌時動票，所以改到的票都在那一格。
只輸出彙總（沒有名字、沒有單局紀錄）。
"""
import json, sys, math
from collections import defaultdict


def load(p):
    out = {}
    for line in open(p):
        if not line.strip(): continue
        x = json.loads(line)
        if x.get('type') != 'vote': continue
        out[(x['gi'], x['seat'], x.get('idx'))] = x
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    md = '--md' in sys.argv
    A = load(args[0]); B = load(args[1])
    keys = sorted(set(A) & set(B))
    by = defaultdict(lambda: {'n': 0, 'chg': 0, 'agA': 0, 'agB': 0, 'games': defaultdict(int)})
    for k in keys:
        a, b = A[k], B[k]
        for role in ('all', a['role']):
            r = by[role]
            r['n'] += 1
            if a['botAction'] != b['botAction']:
                r['chg'] += 1; r['agA'] += a['agree']; r['agB'] += b['agree']
                r['games'][k[0]] += int(b['agree']) - int(a['agree'])
    rows = []
    for role in ['all'] + sorted(x for x in by if x != 'all'):
        r = by[role]
        if not r['n']: continue
        n = r['n']; d = sum(r['games'].values()) / n
        # cluster SE by game: per-game sums of (agree_B − agree_A), others 0
        G = len({k[0] for k in keys if role == 'all' or A[k]['role'] == role})
        vals = list(r['games'].values()) + [0] * max(0, G - len(r['games']))
        mu = sum(vals) / G if G else 0
        se = math.sqrt(sum((v - mu) ** 2 for v in vals) / max(1, G - 1)) * G / n / math.sqrt(G) if G > 1 else 0
        rows.append((role, n, r['chg'], r['agA'], r['agB'], 100 * d, 100 * se))
    if md:
        print('| 角色 | 投票數 | 改到的票 | 改到的票裡和真人一樣：對照 → 候選 | 全部投票一致率差 pp（± 標準誤） |')
        print('|---|---|---|---|---|')
        for role, n, c, a, b, d, se in rows:
            print(f'| {role} | {n} | {c} | {a} → {b} | {d:+.2f} ± {se:.2f} |')
    else:
        for row in rows: print(*[round(x, 3) if isinstance(x, float) else x for x in row])


if __name__ == '__main__':
    main()
