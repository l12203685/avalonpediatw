#!/usr/bin/env python3
"""第 59 回合：`onTeamVoteStudy59.ts` 的逐點紀錄彙總（藍方在隊上、第 3 局起、第 1–4 次提議、不是隊長）。

  python3 scripts/onTeamVoteStudy59.py rows_*.jsonl [--col H|A]

每個候選（`--variant` 的標籤；空白 = 現行）：機器人反對率、和真人同票的比例（全部／座位 PR ≥ 70／桌上 S ≥ 65）、
票對不對（反對 ⇔ 隊上的紅夠讓任務失敗），分角色、分局。配對差的 95% 區間以局為集群。只輸出彙總。
"""
import json
import math
import sys
from collections import defaultdict

args = [a for i, a in enumerate(sys.argv[1:]) if a.endswith('.jsonl')]
col = 'H'
if '--col' in sys.argv:
    col = sys.argv[sys.argv.index('--col') + 1]
rows = [json.loads(l) for f in args for l in open(f) if l.strip()]
labels = sorted({k[len(col):] for k in rows[0] if k.startswith(col) and not k.endswith(('_why', '_p1', '_preq', '_max'))})


def strong(r):
    return r['pr'] is not None and not r['prov'] and r['pr'] >= 70


def s65(r):
    return r['s'] is not None and r['s'] >= 65


def paired(rs, f, lab):
    """Σ 候選 − 現行（每點 f），以局為集群的平均差 ± 95%（百分點）。"""
    by = defaultdict(float)
    for r in rs:
        by[r['gi']] += f(r, lab) - f(r, '')
    n = len(rs)
    if n == 0:
        return 0.0, 0.0
    tot = sum(by.values())
    m = tot / n
    g = len(by)
    # 集群標準誤：Σ_g (S_g − m n_g)² / n²
    cnt = defaultdict(int)
    for r in rs:
        cnt[r['gi']] += 1
    var = sum((by[k] - m * cnt[k]) ** 2 for k in by) * g / max(1, g - 1) / n ** 2
    return 100 * m, 196 * math.sqrt(var)


agree = lambda r, lab: 1.0 if r[col + lab] == r['human'] else 0.0
truth = lambda r, lab: 1.0 if (1 - r[col + lab]) == (1 if r['reds'] >= r['req'] else 0) else 0.0
rej = lambda r, lab: 1.0 - r[col + lab]

scopes = [
    ('全部', lambda r: True),
    ('忠臣', lambda r: r['role'] == 'loyal'),
    ('派西', lambda r: r['role'] == 'percival'),
    ('梅林', lambda r: r['role'] == 'merlin'),
    ('第 3 局', lambda r: r['round'] == 3),
    ('第 3 局 紅方兩勝', lambda r: r['round'] == 3 and r['rw'] == 2),
    ('第 4 局', lambda r: r['round'] == 4),
    ('第 5 局', lambda r: r['round'] == 5),
    ('座位 PR ≥ 70', strong),
    ('桌上 S ≥ 65', s65),
]

print(f'# 藍方在隊上的投票（策略層 {col}；{len(rows)} 點）\n')
print('| 範圍 | 點數 | 真人反對 | 候選 | 機器人反對 | 和真人同票 | Δ 同票 [95%] | 票對 | Δ 票對 [95%] |')
print('|---|---|---|---|---|---|---|---|---|')
for name, flt in scopes:
    rs = [r for r in rows if flt(r)]
    if not rs:
        continue
    n = len(rs)
    hr = 100 * sum(1 - r['human'] for r in rs) / n
    for lab in labels:
        br = 100 * sum(rej(r, lab) for r in rs) / n
        ag = 100 * sum(agree(r, lab) for r in rs) / n
        tr = 100 * sum(truth(r, lab) for r in rs) / n
        if lab == '':
            print(f'| {name} | {n} | {hr:.1f}% | 現行 | {br:.1f}% | {ag:.1f}% | — | {tr:.1f}% | — |')
        else:
            da, ha = paired(rs, agree, lab)
            dt, ht = paired(rs, truth, lab)
            print(f'| {name} | | | {lab} | {br:.1f}% | {ag:.1f}% | {da:+.1f} [{da - ha:+.1f}, {da + ha:+.1f}] | {tr:.1f}% | {dt:+.1f} [{dt - ht:+.1f}, {dt + ht:+.1f}] |')
human_truth = 100 * sum(1 for r in rows if (1 - r['human']) == (1 if r['reds'] >= r['req'] else 0)) / len(rows)
print(f'\n真人自己的票對：{human_truth:.1f}%')
