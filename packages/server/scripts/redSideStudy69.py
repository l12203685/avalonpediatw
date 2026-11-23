#!/usr/bin/env python3
"""第 69 回合（紅方）：`redSideStudy69.ts` 的逐點紀錄彙總（第 3 局、紅方已兩勝、相認紅不在隊上、隊上有看得到的隊友）。

  python3 scripts/redSideStudy69.py rows_*.jsonl [--cols A,C5] [--min-s 55]

每一組設定、全部真人局與高端桌（S ≥ min-s）各一張表：
- 贊成率（第 1–2 次／第 3–4 次提議）、和真人同票；
- 依「其他 9 人實際的贊成數」分：≤ 4（自己贊成也過不了，外白只會被看到）、5（自己這一票決定過不過）、≥ 6（不管自己都會過）；
- 把真人的票換成機器人的票時這隊過不過（其他人的票照真人）：過的比例＝紅方當場贏的比例；「白費的外白」＝贊成了但這隊還是過不了。
差的 95% 區間以局為集群（同一批點的配對差）。只輸出彙總。
"""
import json
import math
import sys
from collections import Counter, defaultdict

files = [a for a in sys.argv[1:] if a.endswith('.jsonl')]


def opt(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


rows = [json.loads(l) for f in files for l in open(f) if l.strip()]
cols = opt('--cols', ','.join(k for k in rows[0] if k not in {
    'gi', 's', 'tier', 'role', 'seat', 'attempt', 'outcome', 'leaderMate', 'mates', 'reds', 'size', 'tailRed', 'tailSelf', 'laterRed',
    'yesOthers', 'blueOffYes', 'passed', 'human', 'why', 'est'})).split(',')
min_s = float(opt('--min-s', '55'))


def cl_mean(rs, f):
    n = len(rs)
    if n == 0:
        return float('nan'), 0.0
    by, cnt = defaultdict(float), defaultdict(int)
    for r in rs:
        by[r['gi']] += f(r)
        cnt[r['gi']] += 1
    m = sum(by.values()) / n
    g = len(by)
    var = sum((by[k] - m * cnt[k]) ** 2 for k in by) * g / max(1, g - 1) / n ** 2
    return m, 1.96 * math.sqrt(var)


def pct(x):
    return f'{100 * x:.1f}'


def passes(r, c):
    return 1.0 if r['yesOthers'] + r[c] >= 6 else 0.0


def report(tag, base):
    print(f'\n### {tag}（{len(base)} 點、{len({r["gi"] for r in base})} 局）\n')
    scopes = [
        ('全部', lambda r: True),
        ('第 1–2 次', lambda r: r['attempt'] <= 2),
        ('第 3–4 次', lambda r: r['attempt'] >= 3),
        ('其他人贊成 ≤ 4（過不了）', lambda r: r['yesOthers'] <= 4),
        ('其他人贊成 = 5（自己決定）', lambda r: r['yesOthers'] == 5),
        ('其他人贊成 ≥ 6（一定過）', lambda r: r['yesOthers'] >= 6),
        ('尾家是看得到的紅', lambda r: r['tailRed']),
        ('尾家是藍方', lambda r: not r['tailRed']),
    ]
    print('| 範圍 | n | 真人贊成 % | ' + ' | '.join(f'{c} 贊成 % | {c} 同票 %' for c in ['human'] + cols if c != 'human') + ' |')
    print('|---|---|---|' + '---|---|' * len(cols))
    for name, f in scopes:
        rs = [r for r in base if f(r)]
        if not rs:
            continue
        h = sum(r['human'] for r in rs) / len(rs)
        cells = []
        for c in cols:
            b = sum(r[c] for r in rs) / len(rs)
            a = sum(1 for r in rs if r[c] == r['human']) / len(rs)
            cells.append(f'{pct(b)} | {pct(a)}')
        print(f'| {name} | {len(rs)} | {pct(h)} | ' + ' | '.join(cells) + ' |')
    print('\n| 設定 | 這隊過（紅方當場贏）% | Δ 對真人 [95%] | 白費的外白 %（贊成但過不了） | 同票 Δ 對第一組 [95%] |')
    print('|---|---|---|---|---|')
    hp = sum(r['passed'] for r in base) / len(base)
    hw = sum(1 for r in base if r['human'] and not r['passed']) / len(base)
    print(f'| 真人 | {pct(hp)} | — | {pct(hw)} | — |')
    c0 = cols[0]
    for c in cols:
        p = sum(passes(r, c) for r in base) / len(base)
        d, ci = cl_mean(base, lambda r: passes(r, c) - r['passed'])
        w = sum(1 for r in base if r[c] and not passes(r, c)) / len(base)
        da, cia = cl_mean(base, lambda r: float(r[c] == r['human']) - float(r[c0] == r['human']))
        print(f'| {c} | {pct(p)} | {100 * d:+.1f} [{100 * (d - ci):+.1f}, {100 * (d + ci):+.1f}] | {pct(w)} | {100 * da:+.1f} [{100 * (da - cia):+.1f}, {100 * (da + cia):+.1f}] |')


report('全部真人局', rows)
report(f'高端桌 S ≥ {min_s:g}', [r for r in rows if r['s'] is not None and r['s'] >= min_s])

c0 = cols[0]
print(f'\n{c0} 的規則（真人贊成、{c0} 反對的點）：')
for k, v in Counter((r.get('why') or '?') for r in rows if r['human'] == 1 and r[c0] == 0).most_common(6):
    print(f'- {k}: {v}')
# 公開估計 vs 真人實際：不在隊上的藍方實際的贊成數 vs 公開視角 P(乾淨) ≥ τ 的人數
print('\n不在隊上的藍方：公開視角 P(乾淨) ≥ τ 的人數（估）vs 真人實際贊成的藍方（不在隊上）')
for tau in (0.3, 0.4, 0.5, 0.6, 0.7):
    est = [sum(1 for p in r['est']['offBlueP'] if p >= tau) for r in rows if r.get('est')]
    act = [r['blueOffYes'] for r in rows if r.get('est')]
    print(f'τ {tau}: 估 {sum(est) / len(est):.2f} 實際 {sum(act) / len(act):.2f}')
