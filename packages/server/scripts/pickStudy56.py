#!/usr/bin/env python3
"""第 56 回合：`pickStudy56.ts` 的彙總。
用法: python3 -I scripts/pickStudy56.py rows_0.jsonl [rows_1.jsonl ...]
(1) 第 1、2 局：第 1–4 次 vs 第 5 次提議，真人／機器人（各候選）的全好 %、F/F*（評分者後驗的相對乾淨度）、F ≥ F* − 0.01 的比例；全部、S ≥ 55、S ≥ 65。
(2) 第 2 局起（已經有任務結果）：M < κ·M* 的比例（κ = 0.5、0.8）與那些點的全好 %；候選對現行預設的逐點配對差。
"""
import sys, json, math
from collections import defaultdict

rows = []
for p in sys.argv[1:]:
    for line in open(p):
        if line.strip():
            rows.append(json.loads(line))
labels = list(rows[0]['bots'].keys()) if rows else []


def mean_ci(xs):
    n = len(xs)
    if n == 0:
        return '—'
    m = sum(xs) / n
    v = sum((x - m) ** 2 for x in xs) / max(1, n - 1)
    return f'{100 * m:.1f} ± {196 * math.sqrt(v / n):.1f}'


def m_only(xs):
    return sum(xs) / len(xs) if xs else float('nan')


def actors(r):
    out = {'真人': r['human']}
    for lab in labels:
        out[lab] = r['bots'].get(lab)
    return out


cohorts = [('全部', lambda r: True), ('S≥55', lambda r: r.get('s') is not None and r['s'] >= 55), ('S≥65', lambda r: r.get('s') is not None and r['s'] >= 65)]

print('## (1) 第 1、2 局：第 1–4 次 vs 第 5 次（忠臣／派西隊長）\n')
for cname, cf in cohorts:
    print(f'### {cname}\n')
    print('| 局 | 隊長 | 第幾次 | n | ' + ' | '.join(f'{a} 全好%／F/F*／最乾淨%' for a in ['真人'] + labels) + ' |')
    print('|---|---|---|---|' + '---|' * (1 + len(labels)))
    for rnd in (1, 2):
        for role in ('loyal', 'percival'):
            gaps = {}
            for grp, gf in (('1–4', lambda r: not r['forced']), ('5', lambda r: r['forced'])):
                sub = [r for r in rows if r['round'] == rnd and r['role'] == role and gf(r) and cf(r)]
                cells = []
                for a in ['真人'] + labels:
                    ev = [actors(r)[a] for r in sub if actors(r)[a] is not None and r['fBest'] > 0]
                    fs = [r for r in sub if actors(r)[a] is not None and r['fBest'] > 0]
                    ag = [1 if e['allGood'] else 0 for e in ev]
                    rel = [e['f'] / r['fBest'] for e, r in zip(ev, fs)]
                    top = [1 if e['f'] >= r['fBest'] - 0.01 else 0 for e, r in zip(ev, fs)]
                    gaps.setdefault(a, {})[grp] = (m_only(ag), m_only(rel), m_only(top))
                    cells.append(f'{100 * m_only(ag):.1f}／{m_only(rel):.2f}／{100 * m_only(top):.0f}' if ev else '—')
                print(f'| {rnd} | {"忠臣" if role == "loyal" else "派西"} | {grp} | {len(sub)} | ' + ' | '.join(cells) + ' |')
            cells = []
            for a in ['真人'] + labels:
                g = gaps.get(a, {})
                if '1–4' in g and '5' in g:
                    cells.append(f'{100 * (g["5"][0] - g["1–4"][0]):+.1f}／{g["5"][1] - g["1–4"][1]:+.2f}／{100 * (g["5"][2] - g["1–4"][2]):+.0f}')
                else:
                    cells.append('—')
            print(f'| {rnd} | {"忠臣" if role == "loyal" else "派西"} | 差（5 − 1–4） | | ' + ' | '.join(cells) + ' |')
    print()

print('## (1b) 第 1、2 局第 1–4 次，候选 − 現行預設（同一批決策點，全好 pp ± 95%）\n')
for cname, cf in cohorts:
    for lab in labels:
        if lab == 'DEF':
            continue
        out = []
        for rnd in (1, 2):
            for role in ('loyal', 'percival'):
                d = [(1 if r['bots'][lab]['allGood'] else 0) - (1 if r['bots']['DEF']['allGood'] else 0)
                     for r in rows if r['round'] == rnd and r['role'] == role and not r['forced'] and cf(r) and r['bots'].get(lab) and r['bots'].get('DEF')]
                ch = sum(1 for r in rows if r['round'] == rnd and r['role'] == role and not r['forced'] and cf(r) and r['bots'].get(lab) and r['bots'].get('DEF') and r['bots'][lab]['team'] != r['bots']['DEF']['team'])
                out.append(f'R{rnd}{"忠" if role == "loyal" else "派"} {mean_ci(d)}（改 {ch}/{len(d)}）')
        print(f'- {cname} {lab}: ' + '；'.join(out))
print()

print('## (2) 第 2 局起（有任務結果）：只用任務的乾淨度 M 和最高 M* 的比\n')
for cname, cf in cohorts:
    sub = [r for r in rows if r['fails'] is not None and r['round'] >= 2 and cf(r) and r['mBest'] > 0]
    print(f'### {cname}（n {len(sub)}）\n')
    print('| 誰 | M < 0.5·M* % | 那些點全好 % | M < 0.8·M* % | 那些點全好 % | 全部全好 % | M 最高的隊全好 %（同一批點） |')
    print('|---|---|---|---|---|---|---|')
    for a in ['真人'] + labels:
        ev = [(actors(r)[a], r) for r in sub if actors(r)[a] is not None]
        lo5 = [(e, r) for e, r in ev if e['m'] < 0.5 * r['mBest'] - 1e-9]
        lo8 = [(e, r) for e, r in ev if e['m'] < 0.8 * r['mBest'] - 1e-9]
        f = lambda xs: f'{100 * m_only([1 if e["allGood"] else 0 for e, _ in xs]):.1f}' if xs else '—'
        mt = lambda xs: f'{100 * m_only([r["mTopClean"] for _, r in xs]):.1f}' if xs else '—'
        print(f'| {a} | {100 * len(lo5) / max(1, len(ev)):.1f} | {f(lo5)}（M最高 {mt(lo5)}） | {100 * len(lo8) / max(1, len(ev)):.1f} | {f(lo8)}（M最高 {mt(lo8)}） | {f(ev)} | {mt(ev)} |')
    print()
    for lab in labels:
        if lab == 'DEF':
            continue
        d = [(1 if r['bots'][lab]['allGood'] else 0) - (1 if r['bots']['DEF']['allGood'] else 0) for r in sub if r['bots'].get(lab) and r['bots'].get('DEF')]
        ch = sum(1 for r in sub if r['bots'].get(lab) and r['bots'].get('DEF') and r['bots'][lab]['team'] != r['bots']['DEF']['team'])
        print(f'- {lab} − DEF（第 2 局起）：全好 {mean_ci(d)} pp，改到 {ch}/{len(d)}')
    print()
