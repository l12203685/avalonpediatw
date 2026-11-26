#!/usr/bin/env python3
"""第 88 回合：梅林「被刺機率」估計器的校準（`merlinEvStudy88.ts` 的輸出）。

三藍的局、梅林當隊長的每一個提議一列。估計器：E = 梅林估的「刺客的世界線認我是梅林」的機率（派了實際的隊之後，`ea`）。
擬合 P(被刺) = σ(a + b × logit(E))（偶數局擬合、奇數局驗證；也報全部擬合的係數給 `Round88.ts`），
報 Brier、ECE（10 格等寬）、和只用平均刺中率的 Brier 比；參考：刺殺時刺客的世界線（四個紅方開牌，真的視角）`wlEnd`。
也報 E 在候選隊之間差多少（同一個決策點最低／最高）與真人梅林帶拇指時的 E。

  python3 scripts/merlinEvStudy88.py --set 真人局=ev_h.jsonl --set 機器人=ev_b.jsonl [--md OUT.md]
"""
import argparse
import json
import math

import numpy as np


def load(path):
    rows = []
    with open(path, encoding='utf8') as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def fit(x, y, iters=200):
    """一維 logistic（截距＋斜率），牛頓法。"""
    X = np.column_stack([np.ones(len(x)), np.asarray(x, float)])
    yv = np.asarray(y, float)
    w = np.zeros(2)
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        g = X.T @ (yv - p)
        H = (X * (p * (1 - p))[:, None]).T @ X + 1e-6 * np.eye(2)
        step = np.linalg.solve(H, g)
        w += step
        if np.max(np.abs(step)) < 1e-9:
            break
    return w


def predict(w, x):
    return 1 / (1 + np.exp(-(w[0] + w[1] * np.asarray(x, float))))


def brier(p, y):
    return float(np.mean((np.asarray(p) - np.asarray(y, float)) ** 2))


def ece(p, y, bins=10):
    p = np.asarray(p)
    y = np.asarray(y, float)
    tot = 0.0
    for k in range(bins):
        lo, hi = k / bins, (k + 1) / bins
        m = (p >= lo) & (p < hi) if k < bins - 1 else (p >= lo) & (p <= hi)
        if m.sum():
            tot += m.sum() / len(p) * abs(p[m].mean() - y[m].mean())
    return float(tot)


def table(name, rows, out):
    three = [r for r in rows if r['hit'] is not None]
    games = {r['gi'] for r in three}
    hit_g = {r['gi']: r['hit'] for r in three}
    base = np.mean([hit_g[g] for g in games]) if games else float('nan')
    out.append(f'### {name}：三藍 {len(games)} 局、梅林當隊長的提議 {len(three)} 個，刺中率 {100 * base:.1f}%')
    out.append('')
    out.append('| 估計器 | 樣本 | a | b | Brier（驗證） | 只用平均刺中率的 Brier | Brier 改善 % | ECE（驗證） |')
    out.append('|---|---|---|---|---|---|---|---|')
    res = {}
    for label, key, filt in [
        ('E（派了實際的隊之後）全部提議', 'ea', lambda r: True),
        ('E 第 1、2 局', 'ea', lambda r: r['round'] <= 2),
        ('E 第 3、4 局', 'ea', lambda r: 3 <= r['round'] <= 4),
        ('E 強制局', 'ea', lambda r: r['forced']),
        ('E（派之前）全部提議', 'eb', lambda r: True),
        ('E 每局最後一個提議', 'ea', 'last'),
    ]:
        if filt == 'last':
            last = {}
            for r in three:
                last[r['gi']] = r
            sub = list(last.values())
        else:
            sub = [r for r in three if filt(r)]
        if len(sub) < 30:
            continue
        tr = [r for r in sub if r['gi'] % 2 == 0]
        te = [r for r in sub if r['gi'] % 2 == 1]
        w = fit([logit(r[key]) for r in tr], [r['hit'] for r in tr])
        p = predict(w, [logit(r[key]) for r in te])
        y = [r['hit'] for r in te]
        b0 = brier([np.mean([r['hit'] for r in tr])] * len(te), y)
        b1 = brier(p, y)
        wa = fit([logit(r[key]) for r in sub], [r['hit'] for r in sub])
        res[label] = (wa, b1, b0)
        out.append(f'| {label} | {len(sub)} | {wa[0]:+.3f} | {wa[1]:+.3f} | {b1:.4f} | {b0:.4f} | {100 * (b0 - b1) / b0:+.1f} | {ece(p, y):.3f} |')
    # 參考：刺殺時的世界線（每局一個）
    ref = {}
    for r in three:
        if r.get('wlEnd') is not None:
            ref[r['gi']] = (r['wlEnd'], r['hit'])
    if len(ref) >= 30:
        xs = [v[0] for v in ref.values()]
        ys = [v[1] for v in ref.values()]
        out.append(f'| 參考：刺殺時刺客的世界線（真的視角，沒有重新擬合） | {len(ref)} 局 | — | — | {brier(xs, ys):.4f} | {brier([np.mean(ys)] * len(ys), ys):.4f} | {100 * (brier([np.mean(ys)] * len(ys), ys) - brier(xs, ys)) / brier([np.mean(ys)] * len(ys), ys):+.1f} | {ece(xs, ys):.3f} |')
    out.append('')
    # 候選隊之間 E 的差
    spread = [r for r in rows if r.get('emin') is not None]
    if spread:
        def q(vals):
            v = sorted(vals)
            if not v:
                return '—'
            return ' / '.join(f'{v[int(k * (len(v) - 1))]:.3f}' for k in (0.25, 0.5, 0.75))
        out.append('| 格 | 決策點 | E 派之前（四分位） | E 實際的隊 | 乾淨候選最低 | 乾淨候選最高 | 一拇指候選最低 | 實際帶拇指 % |')
        out.append('|---|---|---|---|---|---|---|---|')
        for lab, f in [('第 1、2 局非強制', lambda r: r['round'] <= 2 and not r['forced']),
                       ('第 3、4 局非強制', lambda r: 3 <= r['round'] <= 4 and not r['forced']),
                       ('強制局', lambda r: r['forced'])]:
            sub = [r for r in spread if f(r)]
            out.append(f"| {lab} | {len(sub)} | {q([r['eb'] for r in sub])} | {q([r['ea'] for r in sub])} | {q([r['ecMin'] for r in sub if r['ecMin'] is not None])} | {q([r['ecMax'] for r in sub if r['ecMax'] is not None])} | {q([r['etMin'] for r in sub if r['etMin'] is not None])} | {100 * np.mean([r['thumbs'] > 0 for r in sub]):.1f} |")
        out.append('')
    # 照 E 分組的實際刺中率（全部提議，三藍）
    out.append('| E（實際的隊）分組 | 提議 | 刺中 % | 校準後的平均 P(被刺) % |')
    out.append('|---|---|---|---|')
    if 'E（派了實際的隊之後）全部提議' in res:
        wa = res['E（派了實際的隊之後）全部提議'][0]
        edges = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.45, 1.01]
        for lo, hi in zip(edges, edges[1:]):
            sub = [r for r in three if lo <= r['ea'] < hi]
            if sub:
                pr = predict(wa, [logit(r['ea']) for r in sub])
                out.append(f"| {lo:.2f}–{min(hi, 1):.2f} | {len(sub)} | {100 * np.mean([r['hit'] for r in sub]):.1f} | {100 * np.mean(pr):.1f} |")
    out.append('')
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', action='append', default=[])
    ap.add_argument('--md')
    a = ap.parse_args()
    out = []
    coefs = {}
    for s in a.set:
        name, path = s.split('=', 1)
        res = table(name, load(path), out)
        if 'E（派了實際的隊之後）全部提議' in res:
            coefs[name] = res['E（派了實際的隊之後）全部提議'][0].tolist()
    out.append('係數（全部提議、全部局擬合，給 `Round88.ts`）：' + json.dumps(coefs, ensure_ascii=False))
    text = '\n'.join(out)
    print(text)
    if a.md:
        with open(a.md, 'w', encoding='utf8') as f:
            f.write(text + '\n')


if __name__ == '__main__':
    main()
