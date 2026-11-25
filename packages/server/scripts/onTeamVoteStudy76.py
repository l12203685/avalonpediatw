#!/usr/bin/env python3
"""第 76 回合：`onTeamVoteStudy76.ts` 的逐點紀錄彙總（忠臣／派西第 3–5 局的票：在隊上第 1–4 次、不在隊上第 4 次）。

  python3 scripts/onTeamVoteStudy76.py rows_*.jsonl [--pr prH.jsonl] [--part base|curve|cells|cand] [--role loyal|percival] [--json out.json]

- base：每一格（局 × 在不在隊上；全部／弱／一般／強／S 不明）真人、百科AI（真人桌層 H、基準線層 A）的反對率，
  照隊上實際的紅數分、危險的隊擋下率（紅數 ≥ 要的失敗張數 → 反對）、安全的隊放行率、票對。
- curve：第 4 局在隊上照後驗 P(隊上的紅 ≥ 2) 分十格：會失敗的比例、真人與機器人的反對率（分比分）。
- cells：`--pr` 給人類 PR 量尺的逐決策紀錄（`humanPrBenchmark.ts --tier-profile --roles loyal,percival --dump`），
  每一格的量尺落差 Σ（機器人 − 真人的優勢）÷ 局數（pp／局 ± 以局為集群的標準誤）。
- cand：每個候選（`--variant` 的標籤）對 H：反對率、和真人同票、票對、危險擋下、安全放行的配對差（95%，以局為集群）；
  `--pr` 有給時再算量尺的差 Δ（pp／座位局 ± 標準誤；全部／偶數號局／奇數號局 × 強度層 × 角色）——只改票的候選，
  量尺的差 = 每一點「候選那一票的優勢 − 原本那一票的優勢」的加總（紀錄的 `alt` 欄 = 另一票的優勢），不用整份重播。
只輸出彙總，沒有名字。
"""
import json
import math
import sys
from collections import defaultdict

argv = sys.argv[1:]


def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


files = [a for i, a in enumerate(argv) if a.endswith('.jsonl') and (i == 0 or argv[i - 1] not in ('--pr', '--json'))]
part = opt('--part', 'base')
only_role = opt('--role')
raw = [json.loads(l) for f in files for l in open(f) if l.strip()]
seats = [r for r in raw if r.get('k') == 'seat']
rows = [r for r in raw if r.get('k') != 'seat' and (only_role is None or r['role'] == only_role)]
labels = sorted({k[1:] for r in rows[:50] for k in r if k.startswith('H') and k not in ('H',) and not k.startswith('H_')})
TIERS = [('全部', None), ('弱桌', 'weakHuman'), ('一般桌', 'avgHuman'), ('強桌', 'strongHuman'), ('S 不明', 'unknown')]

pr = {}
if opt('--pr'):
    for l in open(opt('--pr')):
        if not l.strip():
            continue
        x = json.loads(l)
        if x['type'] != 'vote':
            continue
        app = x.get('botAction') == 'approve'
        a, o = x['bot'], x.get('alt')
        pr[(x['gi'], x['seat'], x['idx'])] = {'A': a if app else o, 'R': o if app else a, 'h': x['human'], 'b': x['bot'], 'bv': 1 if app else 0}


def pct(a, b):
    return f'{100 * a / b:.1f}%' if b else '—'


def danger(r):
    return r['reds'] >= r['req']


def cluster(rs, f):
    """Σ f / n 與以局為集群的 95% 半寬（百分點）。"""
    by = defaultdict(float)
    cnt = defaultdict(int)
    for r in rs:
        by[r['gi']] += f(r)
        cnt[r['gi']] += 1
    n = len(rs)
    if n == 0:
        return 0.0, 0.0
    m = sum(by.values()) / n
    g = len(by)
    var = sum((by[k] - m * cnt[k]) ** 2 for k in by) * g / max(1, g - 1) / n ** 2
    return 100 * m, 196 * math.sqrt(var)


SCOPES = [
    ('第 3 局在隊上', lambda r: r['on'] and r['round'] == 3),
    ('　第 3 局 0:2', lambda r: r['on'] and r['round'] == 3 and r['rw'] == 2),
    ('　第 3 局 1:1', lambda r: r['on'] and r['round'] == 3 and r['rw'] == 1),
    ('　第 3 局 2:0', lambda r: r['on'] and r['round'] == 3 and r['rw'] == 0),
    ('第 4 局在隊上', lambda r: r['on'] and r['round'] == 4),
    ('　第 4 局 1:2', lambda r: r['on'] and r['round'] == 4 and r['rw'] == 2),
    ('　第 4 局 2:1', lambda r: r['on'] and r['round'] == 4 and r['rw'] == 1),
    ('第 5 局在隊上', lambda r: r['on'] and r['round'] == 5),
    ('第 3 局不在隊上、第 4 次', lambda r: not r['on'] and r['round'] == 3),
    ('第 4 局不在隊上、第 4 次', lambda r: not r['on'] and r['round'] == 4),
    ('第 5 局不在隊上、第 4 次', lambda r: not r['on'] and r['round'] == 5),
]


def line(rs, col):
    n = len(rs)
    rej = sum(1 - r[col] for r in rs)
    d = [r for r in rs if danger(r)]
    s = [r for r in rs if not danger(r)]
    blocked = sum(1 - r[col] for r in d)
    passed = sum(r[col] for r in s)
    return pct(rej, n), pct(blocked, len(d)), pct(passed, len(s)), pct(blocked + passed, n)


def part_base():
    for tname, tier in TIERS:
        rs0 = [r for r in rows if tier is None or r['tier'] == tier]
        print(f'\n### {tname}（{len({r["gi"] for r in rs0})} 局）\n')
        print('| 格 | 票數 | 反對率 真人／H／A | 危險的隊擋下 真人／H／A（票數） | 安全的隊放行 真人／H／A | 票對 真人／H／A | 和真人同票 H／A |')
        print('|---|---|---|---|---|---|---|')
        for name, f in SCOPES:
            rs = [r for r in rs0 if f(r)]
            if not rs:
                continue
            h, b, a = line(rs, 'human'), line(rs, 'H'), line(rs, 'A')
            nd = sum(1 for r in rs if danger(r))
            ag = lambda c: pct(sum(1 for r in rs if r[c] == r['human']), len(rs))
            print(f'| {name} | {len(rs)} | {h[0]}／{b[0]}／{a[0]} | {h[1]}／{b[1]}／{a[1]}（{nd}） | {h[2]}／{b[2]}／{a[2]} | {h[3]}／{b[3]}／{a[3]} | {ag("H")}／{ag("A")} |')
    print('\n### 照隊上實際的紅數分（全部強度層；反對率 真人／H／A（票數））\n')
    print('| 格 | 0 個紅 | 1 個紅 | 2 個紅 | 3 個以上 |')
    print('|---|---|---|---|---|')
    for name, f in SCOPES:
        rs = [r for r in rows if f(r)]
        cells = []
        for k in range(4):
            x = [r for r in rs if (r['reds'] == k if k < 3 else r['reds'] >= 3)]
            cells.append(f'{pct(sum(1 - r["human"] for r in x), len(x))}／{pct(sum(1 - r["H"] for r in x), len(x))}／{pct(sum(1 - r["A"] for r in x), len(x))}（{len(x)}）')
        print(f'| {name} | ' + ' | '.join(cells) + ' |')
    print('\n### 第 4 局在隊上：H 的理由（機器人的票 × 真人的票）\n')
    by = defaultdict(lambda: [0, 0, 0])
    for r in rows:
        if r['on'] and r['round'] == 4:
            o = by[(r['H_why'], r['H'])]
            o[0] += 1
            o[1] += 1 - r['human']
            o[2] += 1 if danger(r) else 0
    print('| 理由 | 機器人 | 票數 | 真人反對 | 隊真的會失敗 |')
    print('|---|---|---|---|---|')
    for (why, v), o in sorted(by.items(), key=lambda kv: -kv[1][0])[:14]:
        print(f'| {why} | {"贊成" if v else "反對"} | {o[0]} | {pct(o[1], o[0])} | {pct(o[2], o[0])} |')


def gain(x):
    """量尺上「反對 − 贊成」的平均優勢差（pp／票）± 標準誤（以局為集群）；沒有 `--pr` 回空白。"""
    x = [r for r in x if (r['gi'], r['seat'], r['pi']) in pr]
    if not x:
        return ''
    m, hw = cluster(x, lambda r: pr[(r['gi'], r['seat'], r['pi'])]['R'] - pr[(r['gi'], r['seat'], r['pi'])]['A'])
    return f'{m:+.2f} ± {hw / 1.96:.2f}'


def part_curve():
    for name, f in [('第 4 局在隊上（全部）', lambda r: True), ('比分 1:2（紅方已兩勝）', lambda r: r['rw'] == 2), ('比分 2:1', lambda r: r['rw'] == 1)]:
        rs = [r for r in rows if r['on'] and r['round'] == 4 and r['H_p2'] is not None and f(r)]
        print(f'\n### {name}：照 H 的後驗 P(隊上的紅 ≥ 2) 分格（{len(rs)} 票）\n')
        print('| P(隊上的紅 ≥ 2) | 票數 | 任務真的會失敗 | 真人反對 | 強者座位（PR ≥ 70）反對 | H 反對 | A 反對 | 量尺：反對 − 贊成（pp／票 ± 標準誤） |')
        print('|---|---|---|---|---|---|---|---|')
        for lo in range(10):
            x = [r for r in rs if min(9, int(r['H_p2'] * 10)) == lo]
            if not x:
                continue
            st = [r for r in x if r['pr'] is not None and not r['prov'] and r['pr'] >= 70]
            print(f'| {lo / 10:.1f}–{(lo + 1) / 10:.1f} | {len(x)} | {pct(sum(1 for r in x if danger(r)), len(x))} | {pct(sum(1 - r["human"] for r in x), len(x))} | {pct(sum(1 - r["human"] for r in st), len(st))}（{len(st)}） | {pct(sum(1 - r["H"] for r in x), len(x))} | {pct(sum(1 - r["A"] for r in x), len(x))} | {gain(x)} |')
    for name, f in [('第 3 局在隊上（全部）', lambda r: True), ('比分 0:2（紅方已兩勝）', lambda r: r['rw'] == 2), ('比分 1:1', lambda r: r['rw'] == 1), ('比分 2:0', lambda r: r['rw'] == 0)]:
        rs = [r for r in rows if r['on'] and r['round'] == 3 and r['H_p1'] is not None and f(r)]
        print(f'\n### {name}：照 H 的後驗 P(隊上自己以外有紅) 分格（{len(rs)} 票）\n')
        print('| P(隊上有紅) | 票數 | 隊上真的有紅 | 真人反對 | H 反對 | A 反對 | 量尺：反對 − 贊成（pp／票 ± 標準誤） |')
        print('|---|---|---|---|---|---|---|')
        for lo in range(20):
            x = [r for r in rs if min(19, int(r['H_p1'] * 20)) == lo]
            if len(x) < 30:
                continue
            print(f'| {lo / 20:.2f}–{(lo + 1) / 20:.2f} | {len(x)} | {pct(sum(1 for r in x if danger(r)), len(x))} | {pct(sum(1 - r["human"] for r in x), len(x))} | {pct(sum(1 - r["H"] for r in x), len(x))} | {pct(sum(1 - r["A"] for r in x), len(x))} | {gain(x)} |')


def games_of(tier, split):
    out = set()
    for s in seats:
        if tier is not None and s['tier'] != tier:
            continue
        if split == 'even' and s['ti'] % 2 != 0:
            continue
        if split == 'odd' and s['ti'] % 2 != 1:
            continue
        out.add(s['gi'])
    return out


def per_game(rs, f, games):
    """Σ f ÷ 局數（pp／局）± 標準誤（以局為集群；沒有這種點的局算 0）。"""
    by = defaultdict(float)
    for r in rs:
        if r['gi'] in games:
            by[r['gi']] += f(r)
    g = len(games)
    if g == 0:
        return 0.0, 0.0
    m = sum(by.values()) / g
    ss = sum((v - m) ** 2 for v in by.values()) + (g - len(by)) * m * m
    return 100 * m, 100 * math.sqrt(ss / max(1, g - 1) / g)


def part_cells():
    if not pr:
        raise SystemExit('--pr required')
    miss = sum(1 for r in rows if (r['gi'], r['seat'], r['pi']) not in pr)
    diff = sum(1 for r in rows if (r['gi'], r['seat'], r['pi']) in pr and pr[(r['gi'], r['seat'], r['pi'])]['bv'] != r['H'])
    print(f'逐點紀錄 {len(rows)} 點；量尺紀錄裡找不到 {miss} 點；量尺那一次重播的票和逐點重播的票不同 {diff} 點\n')
    key = lambda r: (r['gi'], r['seat'], r['pi'])
    adv = lambda r, v: pr[key(r)]['A' if v else 'R']
    ok = [r for r in rows if key(r) in pr]
    for tname, tier in TIERS:
        games = games_of(tier, 'all')
        print(f'\n### {tname}（{len(games)} 局）量尺落差：Σ（機器人 − 真人的優勢）÷ 局數，pp／局 ± 標準誤\n')
        print('| 格 | 票數 | H − 真人 | A − 真人 | 忠臣 H／A | 派西 H／A |')
        print('|---|---|---|---|---|---|')
        for name, f in SCOPES:
            rs = [r for r in ok if f(r) and (tier is None or r['tier'] == tier)]
            if not rs:
                continue
            cell = lambda col, role=None: per_game([r for r in rs if role is None or r['role'] == role], lambda r: adv(r, r[col]) - pr[key(r)]['h'], games)
            h, a = cell('H'), cell('A')
            lh, la, ph, pa = cell('H', 'loyal'), cell('A', 'loyal'), cell('H', 'percival'), cell('A', 'percival')
            print(f'| {name} | {len(rs)} | {h[0]:+.2f} ± {h[1]:.2f} | {a[0]:+.2f} ± {a[1]:.2f} | {lh[0]:+.2f}／{la[0]:+.2f} | {ph[0]:+.2f}／{pa[0]:+.2f} |')
    print('\n### 每一票的平均優勢（pp／票；真人、H、A 各自的票；照隊上實際的紅數）\n')
    print('| 格 | 紅數 | 票數 | 真人反對 | 贊成的優勢 | 反對的優勢 | 真人 | H | A |')
    print('|---|---|---|---|---|---|---|---|---|')
    for name, f in SCOPES:
        if name.startswith('　'):
            continue
        for k in range(4):
            rs = [r for r in ok if f(r) and (r['reds'] == k if k < 3 else r['reds'] >= 3)]
            if len(rs) < 20:
                continue
            m = lambda g: 100 * sum(g(r) for r in rs) / len(rs)
            print(f'| {name} | {k if k < 3 else "3+"} | {len(rs)} | {pct(sum(1 - r["human"] for r in rs), len(rs))} | {m(lambda r: adv(r, 1)):+.2f} | {m(lambda r: adv(r, 0)):+.2f} | {m(lambda r: pr[key(r)]["h"]):+.2f} | {m(lambda r: adv(r, r["H"])):+.2f} | {m(lambda r: adv(r, r["A"])):+.2f} |')


def seat_games(tier, split, role):
    out = defaultdict(int)
    for s in seats:
        if tier is not None and s['tier'] != tier:
            continue
        if role is not None and s['role'] != role:
            continue
        if split == 'even' and s['ti'] % 2 != 0:
            continue
        if split == 'odd' and s['ti'] % 2 != 1:
            continue
        out[s['gi']] += 1
    return out


def yard(lab, tier, split, role, base='H'):
    """量尺的差：Σ（候選那一票的優勢 − 原本那一票的優勢）÷ 座位局；標準誤以局為集群（同 `tierPrCompare.ts`）。"""
    sg = seat_games(tier, split, role)
    N = sum(sg.values())
    if N == 0:
        return None
    d = defaultdict(float)
    for r in rows:
        if r['gi'] not in sg or (role is not None and r['role'] != role):
            continue
        k = (r['gi'], r['seat'], r['pi'])
        if k not in pr or r['H' + lab] == r[base]:
            continue
        p = pr[k]
        d[r['gi']] += (p['A'] if r['H' + lab] else p['R']) - (p['A'] if r[base] else p['R'])
    delta = sum(d.values()) / N
    g = len(sg)
    ss = sum((d.get(gi, 0.0) - delta * n) ** 2 for gi, n in sg.items())
    return 100 * delta, 100 * math.sqrt(ss * g / max(1, g - 1)) / N, N


def fmt(y):
    return '—' if y is None else f'{y[0]:+.2f} ± {y[1]:.2f}'


def part_cand():
    out = {}
    for scope_name, f in [('第 4 局在隊上', lambda r: r['on'] and r['round'] == 4), ('第 3 局在隊上', lambda r: r['on'] and r['round'] == 3)]:
        rs = [r for r in rows if f(r)]
        if not any(r['H' + lab] != r['H'] for lab in labels for r in rs):
            continue
        print(f'\n### {scope_name}（{len(rs)} 票；真人反對 {pct(sum(1 - r["human"] for r in rs), len(rs))}）：候選 − H，配對差 ± 95%（以局為集群）\n')
        print('| 候選 | 改到 | 反對率 | 和真人同票 | Δ 同票 | 危險的隊擋下（真人） | 安全的隊放行（真人） | 票對（真人） | Δ 票對 |')
        print('|---|---|---|---|---|---|---|---|---|')
        hl = line(rs, 'human')
        here = [lab for lab in labels if any(r['H' + lab] != r['H'] for r in rs)]
        for lab in [''] + here:
            c = 'H' + lab
            l = line(rs, c)
            ag = cluster(rs, lambda r: (1.0 if r[c] == r['human'] else 0.0) - (1.0 if r['H'] == r['human'] else 0.0))
            ri = cluster(rs, lambda r: (1.0 if (1 - r[c]) == danger(r) else 0.0) - (1.0 if (1 - r['H']) == danger(r) else 0.0))
            ch = sum(1 for r in rs if r[c] != r['H'])
            print(f'| {lab or "H（現行）"} | {ch} | {l[0]} | {pct(sum(1 for r in rs if r[c] == r["human"]), len(rs))} | {ag[0]:+.1f} ± {ag[1]:.1f} | {l[1]}（{hl[1]}） | {l[2]}（{hl[2]}） | {l[3]}（{hl[3]}） | {ri[0]:+.1f} ± {ri[1]:.1f} |')
            out.setdefault(lab or 'H', {})[scope_name] = {'changed': ch, 'reject': l[0], 'blocked': l[1], 'passed': l[2], 'right': l[3], 'dAgree': ag, 'dRight': ri}
        print(f'\n分強度層（{scope_name}）：反對率／危險擋下／安全放行／Δ 同票／Δ 票對\n')
        print('| 候選 | 弱桌 | 一般桌 | 強桌 | S 不明 |')
        print('|---|---|---|---|---|')
        for lab in [''] + here:
            c = 'H' + lab
            cells = []
            for _, tier in TIERS[1:]:
                x = [r for r in rs if r['tier'] == tier]
                l = line(x, c)
                ag = cluster(x, lambda r: (1.0 if r[c] == r['human'] else 0.0) - (1.0 if r['H'] == r['human'] else 0.0))
                ri = cluster(x, lambda r: (1.0 if (1 - r[c]) == danger(r) else 0.0) - (1.0 if (1 - r['H']) == danger(r) else 0.0))
                cells.append(f'{l[0]}／{l[1]}／{l[2]}／{ag[0]:+.1f}／{ri[0]:+.1f}')
            print(f'| {lab or "H（現行）"} | ' + ' | '.join(cells) + ' |')
        hx = [line([r for r in rs if r['tier'] == tier], 'human') for _, tier in TIERS[1:]]
        print('| 真人 | ' + ' | '.join(f'{h[0]}／{h[1]}／{h[2]}' for h in hx) + ' |')
    if pr:
        print('\n### 第 1H 節：人類 PR 量尺的差（候選 − H；pp／座位局 ± 標準誤；全部／偶數號局／奇數號局）\n')
        print('| 候選 | 忠臣＋派西 | 忠臣 | 派西 |')
        print('|---|---|---|---|')
        for lab in labels:
            cells = []
            for role in (None, 'loyal', 'percival'):
                cells.append('／'.join(fmt(yard(lab, None, sp, role)) for sp in ('all', 'even', 'odd')))
            print(f'| {lab} | ' + ' | '.join(cells) + ' |')
            out.setdefault(lab, {})['yard'] = {sp: yard(lab, None, sp, None) for sp in ('all', 'even', 'odd')}
        print('\n分強度層（忠臣＋派西；全部／偶數號局／奇數號局）\n')
        print('| 候選 | 弱桌 | 一般桌 | 強桌 | S 不明 |')
        print('|---|---|---|---|---|')
        for lab in labels:
            print(f'| {lab} | ' + ' | '.join('／'.join(fmt(yard(lab, tier, sp, None)) for sp in ('all', 'even', 'odd')) for _, tier in TIERS[1:]) + ' |')
        print('\n分強度層 × 角色（全部／偶數號局／奇數號局）\n')
        print('| 候選 | 角色 | 弱桌 | 一般桌 | 強桌 | S 不明 |')
        print('|---|---|---|---|---|---|')
        worst = {}
        for lab in labels:
            for rname, role in (('忠臣', 'loyal'), ('派西', 'percival')):
                cells = []
                for _, tier in TIERS[1:]:
                    ys = [yard(lab, tier, sp, role) for sp in ('all', 'even', 'odd')]
                    cells.append('／'.join(fmt(y) for y in ys))
                    for sp, y in zip(('all', 'even', 'odd'), ys):
                        if y is not None and y[1] > 0:
                            z = y[0] / y[1]
                            if lab not in worst or z < worst[lab][0]:
                                worst[lab] = (z, f'{tier} {rname} {sp} {fmt(y)}')
                print(f'| {lab} | {rname} | ' + ' | '.join(cells) + ' |')
        print('\n每個候選最差的一格（差 ÷ 標準誤最小）：\n')
        for lab in labels:
            if lab in worst:
                print(f'- {lab}：{worst[lab][1]}（{worst[lab][0]:+.1f} 個標準誤）')
                out[lab]['worst'] = worst[lab]
    if opt('--json'):
        json.dump(out, open(opt('--json'), 'w'), ensure_ascii=False, indent=1)


{'base': part_base, 'curve': part_curve, 'cells': part_cells, 'cand': part_cand}[part]()
