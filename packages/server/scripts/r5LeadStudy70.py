#!/usr/bin/env python3
"""第 70 回合：彙總 r5LeadStudy70.ts 的 JSONL（真人第 5 局忠臣／派西的提議 vs 機器人在同一個決策點）。

    python3 scripts/r5LeadStudy70.py base_*.jsonl --cand cand_*.jsonl

子集合（全部、第 3–4 次、高端桌 S≥55）：會失敗的隊（真人／對照／候選）、和真人完全相同、Jaccard；候選 − 對照以局為集群（95%）。只輸出彙總。
"""
import argparse
import json
import math
from collections import defaultdict


def load(paths):
    out = {}
    for p in paths:
        with open(p) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    out[(r['gi'], r['att'], r['ht'])] = r
    return out


def jac(a, b):
    a, b = set(a.split(',')), set(b.split(','))
    return len(a & b) / len(a | b)


def paired(keys, f):
    per = defaultdict(float)
    cnt = defaultdict(int)
    for k in keys:
        per[k[0]] += f(k)
        cnt[k[0]] += 1
    n = len(keys)
    m = sum(per.values()) / n
    se = math.sqrt(sum((per[g] - m * cnt[g]) ** 2 for g in per)) / n
    return m, 1.96 * se


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base', nargs='+')
    ap.add_argument('--cand', nargs='+', required=True)
    a = ap.parse_args()
    B, C = load(a.base), load(a.cand)
    subsets = [('全部', lambda r: True), ('第 3–4 次', lambda r: r['att'] >= 3), ('高端桌 S≥55', lambda r: r['s'] is not None and r['s'] >= 55)]
    print('| 範圍 | 點數 | 改到 | 會失敗的隊 真人／對照／候選 | Δ 會失敗 | 完全相同 對照 → Δ | Jaccard 對照 → Δ |')
    print('|---|---|---|---|---|---|---|')
    for name, sel in subsets:
        ks = [k for k in B if k in C and sel(B[k])]
        n = len(ks)
        if n == 0:
            continue
        mean = lambda f: sum(f(k) for k in ks) / n
        d = paired(ks, lambda k: C[k]['bDirty'] - B[k]['bDirty'])
        e = paired(ks, lambda k: (C[k]['bt'] == C[k]['ht']) - (B[k]['bt'] == B[k]['ht']))
        j = paired(ks, lambda k: jac(C[k]['bt'], C[k]['ht']) - jac(B[k]['bt'], B[k]['ht']))
        print(f"| {name} | {n} | {sum(B[k]['bt'] != C[k]['bt'] for k in ks)} | {100 * mean(lambda k: B[k]['hDirty']):.1f}／{100 * mean(lambda k: B[k]['bDirty']):.1f}／{100 * mean(lambda k: C[k]['bDirty']):.1f}% "
              f"| {100 * d[0]:+.1f} ± {100 * d[1]:.1f} | {100 * mean(lambda k: B[k]['bt'] == B[k]['ht']):.1f}% → {100 * e[0]:+.1f} ± {100 * e[1]:.1f} "
              f"| {mean(lambda k: jac(B[k]['bt'], B[k]['ht'])):.3f} → {j[0]:+.3f} ± {j[1]:.3f} |")


if __name__ == '__main__':
    main()
