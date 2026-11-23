#!/usr/bin/env python3
"""第 65 回合（紅方）：`redSideStudy65.ts` 的逐點紀錄彙總。

  python3 scripts/redSideStudy65.py rows_*.jsonl [--cols A,H,W] [--min-s 55] [--part votes|leads|oberon|all]

- votes：相認紅（刺客、莫甘娜、莫德雷德）第 3 局起、第 1–4 次提議、不在隊上的贊成（外白）率，真人 vs 每一組設定，分局面；
  在隊上的反對（內黑）率；機器人反對而真人贊成的點，機器人用的規則。
- leads：紅方隊長（不含奧伯倫）的提議：看得到的紅數（含自己）、莫德雷德在不在、自己在不在的分布；真人那一隊的藍方隊外贊成率與紅勝率。
- oberon：奧伯倫的投票（在隊上／不在隊上、分局）。
差的 95% 區間以局為集群（同一批點的配對差）。只輸出彙總。
"""
import json
import math
import sys
from collections import Counter, defaultdict

files = [a for a in sys.argv[1:] if a.endswith('.jsonl')]


def opt(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


cols = opt('--cols', 'A,H').split(',')
min_s = float(opt('--min-s', '55'))
part = opt('--part', 'all')
rows = [json.loads(l) for f in files for l in open(f) if l.strip()]
votes = [r for r in rows if r['kind'] == 'vote']
leads = [r for r in rows if r['kind'] == 'lead']
strong = lambda r: r['s'] is not None and r['s'] >= min_s


def cl_mean(rs, f):
    """mean of f over rows ± 95% (cluster = game)."""
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


def cell(rs, col, val):
    """human rate, bot rate, diff ± ci (pp)"""
    rs = [r for r in rs if r.get(col) is not None]
    h, _ = cl_mean(rs, lambda r: val(r, 'human'))
    b, _ = cl_mean(rs, lambda r: val(r, col))
    d, ci = cl_mean(rs, lambda r: val(r, col) - val(r, 'human'))
    return len(rs), h, b, d, ci


def table(title, scopes, base, val, colset=None):
    colset = colset or cols
    print(f'\n### {title}\n')
    print('| 範圍 | n | 真人 % | ' + ' | '.join(f'{c} % | {c} − 真人 [95%]' for c in colset) + ' |')
    print('|---|---|---|' + '---|---|' * len(colset))
    for name, f in scopes:
        rs = [r for r in base if f(r)]
        if not rs:
            continue
        out = []
        n = h = None
        for c in colset:
            n, h, b, d, ci = cell(rs, c, val)
            out.append(f'{pct(b)} | {100 * d:+.1f} [{100 * (d - ci):+.1f}, {100 * (d + ci):+.1f}]')
        print(f'| {name} | {n} | {pct(h)} | ' + ' | '.join(out) + ' |')


yes = lambda r, c: float(r[c])
no = lambda r, c: 1.0 - float(r[c])
KNOWN = ('assassin', 'morgana', 'mordred')

if part in ('votes', 'all'):
    off = [r for r in votes if r['role'] in KNOWN and r['round'] >= 3 and r['attempt'] <= 4 and not r['on']]
    for tag, base in (('全部真人局', off), (f'高端桌 S≥{min_s:g}', [r for r in off if strong(r)])):
        table(f'相認紅・第 3 局起・不在隊上的贊成（外白）率 — {tag}', [
            ('全部', lambda r: True),
            ('隊上有看得到的隊友', lambda r: r['mates'] >= 1),
            ('　隊長是隊友', lambda r: r['mates'] >= 1 and r['leaderMate']),
            ('　隊長是藍方', lambda r: r['mates'] >= 1 and not r['leaderMate']),
            ('　紅方已兩勝（關鍵）', lambda r: r['mates'] >= 1 and r['rw'] >= 2),
            ('　紅方未滿兩勝', lambda r: r['mates'] >= 1 and r['rw'] < 2),
            ('　　隊友夠讓任務失敗', lambda r: r['mates'] >= 1 and r['rw'] < 2 and r['mates'] >= r['req']),
            ('　　第 1–3 次提議', lambda r: r['mates'] >= 1 and r['rw'] < 2 and r['attempt'] <= 3),
            ('　　第 4 次提議', lambda r: r['mates'] >= 1 and r['rw'] < 2 and r['attempt'] == 4),
            ('　　藍方已兩勝', lambda r: r['mates'] >= 1 and r['rw'] < 2 and r['bw'] >= 2),
            ('隊上沒有看得到的隊友', lambda r: r['mates'] == 0),
            ('　藍方已兩勝（關鍵）', lambda r: r['mates'] == 0 and r['bw'] >= 2),
            ('　藍方未滿兩勝', lambda r: r['mates'] == 0 and r['bw'] < 2),
            ('　　隊上實際有紅（奧伯倫）', lambda r: r['mates'] == 0 and r['bw'] < 2 and r['reds'] >= 1),
            ('　　第 4 次提議', lambda r: r['mates'] == 0 and r['bw'] < 2 and r['attempt'] == 4),
            ('第 3 局', lambda r: r['round'] == 3),
            ('第 4 局', lambda r: r['round'] == 4),
            ('第 5 局', lambda r: r['round'] == 5),
            ('刺客', lambda r: r['role'] == 'assassin'),
            ('莫甘娜', lambda r: r['role'] == 'morgana'),
            ('莫德雷德', lambda r: r['role'] == 'mordred'),
        ], base, yes)
    # why: bot rejects while human approves (off-team, R3+)
    c0 = cols[0]
    for tag, base in (('全部真人局', off), (f'高端桌 S≥{min_s:g}', [r for r in off if strong(r)])):
        diff = [r for r in base if r['human'] == 1 and r[c0] == 0]
        print(f'\n真人外白、{c0} 反對（{tag}）：{len(diff)} 點；規則：')
        for k, v in Counter((r.get('why') or '?') for r in diff).most_common(8):
            print(f'- {k}: {v}')
        both = [r for r in base if r['human'] == 1]
        print(f'真人外白的點 {c0} 也外白：{pct(sum(r[c0] for r in both) / max(1, len(both)))}%（{len(both)} 點）')
    on = [r for r in votes if r['role'] in KNOWN and r['round'] >= 3 and r['attempt'] <= 4 and r['on'] and not r['leaderSelf']]
    for tag, base in (('全部真人局', on), (f'高端桌 S≥{min_s:g}', [r for r in on if strong(r)])):
        table(f'相認紅・第 3 局起・在隊上（不是隊長）的反對（內黑）率 — {tag}', [
            ('全部', lambda r: True),
            ('紅方未滿兩勝', lambda r: r['rw'] < 2),
            ('紅方已兩勝', lambda r: r['rw'] >= 2),
            ('隊上有隊友', lambda r: r['mates'] >= 1),
        ], base, no)

if part in ('leads', 'all'):
    L = [r for r in leads if r['role'] in KNOWN]
    for tag, base in (('全部真人局', L), (f'高端桌 S≥{min_s:g}', [r for r in L if strong(r)])):
        print(f'\n### 紅方隊長（刺客／莫甘娜／莫德雷德）的提議 — {tag}\n')
        print('| 範圍 | n | 誰 | 看得到的紅 0 / 1 / 2 / 3+ % | 平均 | 莫德雷德在隊上 % | 自己在隊上 % |')
        print('|---|---|---|---|---|---|---|')
        for name, f in [
            ('第 1–2 局 非強制', lambda r: r['round'] <= 2 and not r['forced']),
            ('第 3–5 局 非強制', lambda r: r['round'] >= 3 and not r['forced']),
            ('第 3–5 局 非強制、紅方未滿兩勝', lambda r: r['round'] >= 3 and not r['forced'] and r['rw'] < 2),
            ('強制（第 5 次）', lambda r: r['forced']),
            ('第 4 局（要兩張失敗）', lambda r: r['round'] == 4),
            ('全部', lambda r: True),
        ]:
            rs = [r for r in base if f(r)]
            if not rs:
                continue
            for who in ['human'] + cols:
                rr = [r for r in rs if r.get(who)]
                k = Counter(min(3, r[who]['known']) for r in rr)
                n = len(rr)
                mord = [r for r in rr if r['role'] != 'mordred']
                print(f'| {name} | {n} | {who} | ' + ' / '.join(pct(k[i] / n) for i in range(4))
                      + f' | {sum(r[who]["known"] for r in rr) / n:.2f} | '
                      + (pct(sum(r[who]['mord'] for r in mord) / len(mord)) if mord else '—')
                      + f' | {pct(sum(r[who]["self"] for r in rr) / n)} |')
        # paired diff in mean known reds
        for c in cols:
            for name, f in [('第 1–2 局 非強制', lambda r: r['round'] <= 2 and not r['forced']),
                            ('第 3–5 局 非強制', lambda r: r['round'] >= 3 and not r['forced']),
                            ('強制', lambda r: r['forced'])]:
                rs = [r for r in base if f(r) and r.get(c)]
                d, ci = cl_mean(rs, lambda r: r[c]['known'] - r['human']['known'])
                d2, ci2 = cl_mean(rs, lambda r: (r[c]['known'] >= 2) - (r['human']['known'] >= 2))
                print(f'- {c} − 真人（{name}，n {len(rs)}）：看得到的紅平均 {d:+.2f} ± {ci:.2f}；≥ 2 個的比例 {100 * d2:+.1f} ± {100 * ci2:.1f} pp')
    # cost of obvious teams (human data): blue off-team approval, pass, red win by known count
    print('\n### 真人紅隊長的隊：看得到的紅數 vs 藍方隊外贊成、通過、紅勝（第 3–5 局非強制）\n')
    print('| 範圍 | 看得到的紅 | n | 藍方隊外贊成 % | 通過 % | 出任務 % | 紅勝（三紅＋刺中）% |')
    print('|---|---|---|---|---|---|---|')
    for tag, base in (('全部', L), (f'S≥{min_s:g}', [r for r in L if strong(r)])):
        rs = [r for r in base if r['round'] >= 3 and not r['forced']]
        for k in (1, 2, 3):
            rr = [r for r in rs if min(3, r['human']['known']) == k]
            vv = [r for r in rr if r['blueOff']]
            if not rr:
                continue
            bo = sum(r['blueOffYes'] for r in vv) / max(1, sum(r['blueOff'] for r in vv))
            print(f'| {tag} | {k}{"+" if k == 3 else ""} | {len(rr)} | {pct(bo)} | {pct(sum(r["passed"] for r in rr) / len(rr))} | '
                  f'{pct(sum(r["went"] for r in rr) / len(rr))} | {pct(sum(r["outcome"] != "B" for r in rr) / len(rr))} |')

if part in ('oberon', 'all'):
    O = [r for r in votes if r['role'] == 'oberon' and r['attempt'] <= 4]
    for tag, base in (('全部真人局', O), (f'高端桌 S≥{min_s:g}', [r for r in O if strong(r)])):
        table(f'奧伯倫的贊成率 — {tag}', [
            ('第 1–2 局 不在隊上', lambda r: r['round'] <= 2 and not r['on']),
            ('第 1–2 局 在隊上', lambda r: r['round'] <= 2 and r['on'] and not r['leaderSelf']),
            ('第 3 局起 不在隊上', lambda r: r['round'] >= 3 and not r['on']),
            ('　隊上有紅（他看不到）', lambda r: r['round'] >= 3 and not r['on'] and r['reds'] >= 1),
            ('　隊上沒有紅', lambda r: r['round'] >= 3 and not r['on'] and r['reds'] == 0),
            ('　藍方已兩勝', lambda r: r['round'] >= 3 and not r['on'] and r['bw'] >= 2),
            ('　紅方已兩勝', lambda r: r['round'] >= 3 and not r['on'] and r['rw'] >= 2),
            ('　第 4 次提議', lambda r: r['round'] >= 3 and not r['on'] and r['attempt'] == 4),
            ('第 3 局起 在隊上（不是隊長）', lambda r: r['round'] >= 3 and r['on'] and not r['leaderSelf']),
            ('　紅方未滿兩勝', lambda r: r['round'] >= 3 and r['on'] and not r['leaderSelf'] and r['rw'] < 2),
        ], base, yes)
        diff = [r for r in base if r['round'] >= 3 and r['human'] != r[cols[0]]]
        print(f'\n奧伯倫第 3 局起和真人不同票（{tag}）：{len(diff)} 點；{cols[0]} 的規則：')
        for k, v in Counter((r.get('why') or '?') + (' → 贊成' if r[cols[0]] else ' → 反對') for r in diff).most_common(8):
            print(f'- {k}: {v}')
    OL = [r for r in leads if r['role'] == 'oberon']
    print(f'\n奧伯倫當隊長：{len(OL)} 次；實際紅數（含自己）真人 {sum(r["human"]["reds"] for r in OL) / max(1, len(OL)):.2f}／'
          + '／'.join(f'{c} {sum(r[c]["reds"] for r in OL if r.get(c)) / max(1, len(OL)):.2f}' for c in cols)
          + f'；自己在隊上 真人 {pct(sum(r["human"]["self"] for r in OL) / max(1, len(OL)))}%／'
          + '／'.join(f'{c} {pct(sum(r[c]["self"] for r in OL if r.get(c)) / max(1, len(OL)))}%' for c in cols))
