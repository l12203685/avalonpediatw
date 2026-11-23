#!/usr/bin/env python3
"""第 61 回合（紅方）：刺殺倍數的擬合與驗證、第 2 局出牌的彙總（資料整理在 assassinPathStudy.ts）。

  python3 scripts/assassinPathStudy.py fit  hA.jsonl                       # 偶數號擬合倍數（條件 logit，標籤 = 真人刺客選的人）
  python3 scripts/assassinPathStudy.py eval hA.jsonl hA_cand.jsonl [--bot bA.jsonl bA_cand.jsonl]
  python3 scripts/assassinPathStudy.py cards cards_base.jsonl cards_cand.jsonl

hA*.jsonl = `--export-human`（現行／候選 --flag），bA*.jsonl = `--export-bot`（自我對打紀錄，同一份紀錄的現行／候選刺殺）。
只輸出彙總數字。
"""
import json
import sys
from collections import defaultdict

import numpy as np

TERMS = ['model', 'vote', 'lead', 'reuse']


def load(p):
    with open(p, encoding='utf8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def is_br(order):
    return order.startswith('BR')


def design(a, label):
    C = [x for x in a['cands'] if x['front']]
    base = np.array([x['total'] for x in C])
    X = np.array([[x[t] for t in TERMS] for x in C], dtype=float)
    y = np.array([x['seat'] == a[label] for x in C], dtype=float)
    return base, X, y


def fit(S, label, lam, iters=60):
    """Penalised conditional logit: score = total + Σ θ_t · term_t (θ = multiplier − 1), L2 toward θ = 0."""
    D = [d for d in (design(a, label) for a in S) if d[2].sum() == 1]
    th = np.zeros(len(TERMS))
    for _ in range(iters):
        g = -lam * th
        H = -lam * np.eye(len(TERMS))
        for base, X, y in D:
            s = base + X @ th
            s -= s.max()
            e = np.exp(s)
            pr = e / e.sum()
            g += X.T @ (y - pr)
            H -= (X.T * pr) @ X - np.outer(X.T @ pr, X.T @ pr)
        step = np.linalg.solve(H, g)
        th -= step
        if np.abs(step).max() < 1e-9:
            break
    return th, len(D)


def cmd_fit(path):
    A = load(path)
    even = [a for a in A if is_br(a['order']) and a['gi'] % 2 == 0]
    for lam in (2, 10):
        th, n = fit(even, 'human', lam)
        print(f'第 1 局成功、第 2 局失敗，偶數號 {n} 個刺殺點（真人目標在第一層），λ={lam}：倍數 ' +
              '、'.join(f'{t} {1 + v:.2f}' for t, v in zip(TERMS, th)))


def boot_ci(d, B=2000, seed=61):
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(d), size=(B, len(d)))
    m = d[idx].mean(axis=1)
    return np.percentile(m, 2.5), np.percentile(m, 97.5)


def fmt(d):
    lo, hi = boot_ci(d)
    return f'{100 * d.mean():+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}]'


def cmd_eval(base_path, cand_path, bot=None):
    A = load(base_path)
    C = {a['gi']: a for a in load(cand_path)}
    groups = [
        ('全部', lambda a: True), ('偶數號（擬合）', lambda a: a['gi'] % 2 == 0), ('奇數號（驗證）', lambda a: a['gi'] % 2 == 1),
        ('第 1 局成功、第 2 局失敗', lambda a: is_br(a['order'])),
        ('　其中奇數號', lambda a: is_br(a['order']) and a['gi'] % 2 == 1),
        ('　藍紅紅藍藍', lambda a: a['order'] == 'BRRBB'), ('　藍紅藍藍', lambda a: a['order'] == 'BRBB'),
        ('其他順序', lambda a: not is_br(a['order'])),
        ('高端桌 S≥55', lambda a: a['s'] is not None and a['s'] >= 55),
        ('高強度 S≥65', lambda a: a['s'] is not None and a['s'] >= 65),
    ]
    print('| 範圍 | n | 真人刺中 % | 機器人 現行 % | 候選 % | 候選 − 現行 [95%] | 候選 − 真人 | 和真人同目標 現行 → 候選 % |')
    print('|---|---|---|---|---|---|---|---|')
    for name, f in groups:
        S = [a for a in A if f(a)]
        if not S:
            continue
        h = np.array([a['human'] == a['merlin'] for a in S], dtype=float)
        b = np.array([a['bot'] == a['merlin'] for a in S], dtype=float)
        c = np.array([C[a['gi']]['bot'] == a['merlin'] for a in S], dtype=float)
        ab = np.mean([a['bot'] == a['human'] for a in S])
        ac = np.mean([C[a['gi']]['bot'] == a['human'] for a in S])
        print(f'| {name} | {len(S)} | {100 * h.mean():.1f} | {100 * b.mean():.1f} | {100 * c.mean():.1f} | {fmt(c - b)} | '
              f'{100 * (c.mean() - h.mean()):+.1f} | {100 * ab:.1f} → {100 * ac:.1f} |')
    if bot:
        B = load(bot[0])
        BC = {a['gi']: a for a in load(bot[1])}
        print('\n自我對打（同一份紀錄，刺殺是最後一個動作，逐局配對）')
        print('| 範圍 | n | 現行 % | 候選 % | 候選 − 現行 [95%] |')
        print('|---|---|---|---|---|')
        for name, f in (('全部', lambda a: True), ('第 1 局成功、第 2 局失敗', lambda a: is_br(a['order'])),
                        ('藍紅紅藍藍', lambda a: a['order'] == 'BRRBB'), ('藍紅藍藍', lambda a: a['order'] == 'BRBB')):
            S = [a for a in B if f(a)]
            b = np.array([a['bot'] == a['merlin'] for a in S], dtype=float)
            c = np.array([BC[a['gi']]['bot'] == a['merlin'] for a in S], dtype=float)
            print(f'| {name} | {len(S)} | {100 * b.mean():.2f} | {100 * c.mean():.2f} | {fmt(c - b)} |')


def cmd_cards(base_path, cand_path):
    rows = {'現行': load(base_path), '候選': load(cand_path)}
    print('| 範圍 | 版本 | 每張牌：n | 真人出失敗 % | 機器人出失敗 % | 每個任務：n | 真人任務失敗 % | 機器人任務失敗 % |')
    print('|---|---|---|---|---|---|---|---|')
    for lab, f in (('全部', lambda c: True), ('高端桌 S≥55', lambda c: c['s'] is not None and c['s'] >= 55),
                   ('高強度 S≥65', lambda c: c['s'] is not None and c['s'] >= 65)):
        for name, R in rows.items():
            P = [c for c in R if f(c) and c['human'] is not None]
            G = defaultdict(list)
            for c in R:
                if f(c):
                    G[c['gi']].append(c)
            hm = np.mean([cs[0]['fails'] > 0 for cs in G.values()])
            bm = np.mean([any(c['agent'] == 'fail' for c in cs) for cs in G.values()])
            print(f'| {lab} | {name} | {len(P)} | {100 * np.mean([c["human"] == "fail" for c in P]):.1f} | '
                  f'{100 * np.mean([c["agent"] == "fail" for c in P]):.1f} | {len(G)} | {100 * hm:.1f} | {100 * bm:.1f} |')
    print('\n落單的紅（看不到隊友）每個角色：出失敗 %（n）')
    for role in ('assassin', 'morgana', 'mordred', 'oberon'):
        out = []
        for name, R in rows.items():
            P = [c for c in R if c['role'] == role and c['mates'] == 0]
            out.append(f'{name} {100 * np.mean([c["agent"] == "fail" for c in P]):.1f}')
        P = [c for c in rows['現行'] if c['role'] == role and c['mates'] == 0 and c['reds'] == 1]
        out.append(f'真人（隊上只有他一個紅）{100 * np.mean([c["fails"] > 0 for c in P]):.1f}（{len(P)}）')
        print(f'- {role}：' + '、'.join(out))


def main():
    a = sys.argv[1:]
    if a and a[0] == 'fit':
        return cmd_fit(a[1])
    if a and a[0] == 'eval':
        bot = a[a.index('--bot') + 1:a.index('--bot') + 3] if '--bot' in a else None
        return cmd_eval(a[1], a[2], bot)
    if a and a[0] == 'cards':
        return cmd_cards(a[1], a[2])
    print(__doc__)


if __name__ == '__main__':
    main()
