#!/usr/bin/env python3
"""第 77 回合：自我對打四組的成對比較——(a) 現行預設、(b) 只開世界線刺客、(c) 世界線刺客＋藍方新開關、(d) 只開藍方新開關。

刺殺是一局最後一個動作，所以 (b) = (a) 的整局紀錄上重算刺殺、(c) = (d) 的整局紀錄上重算刺殺（`assassinPathStudy.ts --export-bot`）。
(a)、(d) 是同種子、同局號的兩份自我對打（`keySpotStudy.ts --export-bot`，局號 gi 從 0 連續）。逐局配對，bootstrap 95%。

  python3 scripts/merlinCoverArms77.py --base b_base.jsonl --base-def bA_base_def.jsonl --base-wl bA_base_wl.jsonl \
      --arm b_arm.jsonl --arm-def bA_arm_def.jsonl --arm-wl bA_arm_wl.jsonl [--alt 名稱=bA_base_x.jsonl,bA_arm_x.jsonl ...] [--json out.json]

輸入只有座位、角色、隊伍、票、任務牌、湖、刺殺與分數，沒有玩家名。
"""
import argparse
import json

import numpy as np


def load(p):
    with open(p, encoding='utf8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def boot(vals, n=2000, seed=77):
    rng = np.random.default_rng(seed)
    a = np.asarray(vals, dtype=float)
    idx = rng.integers(0, len(a), size=(n, len(a)))
    m = a[idx].mean(axis=1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def outcomes(games, spots, n):
    """每一局：三藍、刺中（-1 = 沒有刺殺）、藍方勝。"""
    three = np.zeros(n)
    hit = np.full(n, -1.0)
    for g in games:
        three[g['gi']] = 1.0 if g['out'] != 'red3' else 0.0
    for a in spots:
        hit[a['gi']] = 1.0 if a['bot'] == a['merlin'] else 0.0
    blue = np.where(three > 0, np.where(hit == 0, 1.0, 0.0), 0.0)
    return three, hit, blue


def line(name, three, hit, blue):
    k = hit >= 0
    return f'| {name} | {100 * three.mean():.2f} | {100 * hit[k].mean():.2f}（{int(k.sum())} 點） | {100 * blue.mean():.2f} |'


def diff(name, x, y):
    lo, hi = boot(y - x)
    return f'| {name} | {100 * (y - x).mean():+.2f} [{100 * lo:+.2f}, {100 * hi:+.2f}] |'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--base-def', required=True)
    ap.add_argument('--base-wl', required=True)
    ap.add_argument('--arm', required=True)
    ap.add_argument('--arm-def', required=True)
    ap.add_argument('--arm-wl', required=True)
    ap.add_argument('--alt', action='append', default=[], help='名稱=基準線的重算檔,候選的重算檔（另一種刺殺設定）')
    ap.add_argument('--json')
    args = ap.parse_args()
    bg, ag = load(args.base), load(args.arm)
    n = len(ag)
    bg = [g for g in bg if g['gi'] < n]
    assert len(bg) == n, (len(bg), n)
    res = {'games': n}
    a = outcomes(bg, [s for s in load(args.base_def) if s['gi'] < n], n)
    b = outcomes(bg, [s for s in load(args.base_wl) if s['gi'] < n], n)
    d = outcomes(ag, load(args.arm_def), n)
    c = outcomes(ag, load(args.arm_wl), n)
    same = sum(1 for x, y in zip(bg, ag) if x['props'] == y['props'] and x['quests'] == y['quests'] and x['lakes'] == y['lakes'])
    print(f'局數 {n}；候選和現行預設到刺殺之前完全相同的局 {same}（{100 * same / n:.1f}%）\n')
    print('| 組 | 任務三藍 % | 刺中率 % | 藍方勝率 % |')
    print('|---|---|---|---|')
    for name, o in (('(a) 現行預設', a), ('(b) 只開世界線刺客', b), ('(c) 世界線刺客＋藍方新開關', c), ('(d) 只開藍方新開關', d)):
        print(line(name, *o))
        k = o[1] >= 0
        res[name[:3]] = {'threeBlue': float(o[0].mean()), 'hit': float(o[1][k].mean()), 'blue': float(o[2].mean()), 'spots': int(k.sum())}
    print('\n| 成對的差（藍方勝率，pp） | 差 [95%] |')
    print('|---|---|')
    for name, x, y in (('(b) − (a)：世界線刺客對現行藍方', a, b), ('(c) − (a)：成對採用對現行預設', a, c), ('(c) − (b)：新藍方對世界線刺客', b, c),
                       ('(d) − (a)：新藍方對現行刺客', a, d)):
        print(diff(name, x[2], y[2]))
        res[name[:9]] = {'d': float((y[2] - x[2]).mean()), 'ci': boot(y[2] - x[2])}
    print(diff('任務三藍：(d) − (a)', a[0], d[0]))
    res['threeBlue d-a'] = {'d': float((d[0] - a[0]).mean()), 'ci': boot(d[0] - a[0])}
    for spec in args.alt:
        name, files = spec.split('=')
        fb, fa = files.split(',')
        xb = outcomes(bg, [s for s in load(fb) if s['gi'] < n], n)
        xa = outcomes(ag, load(fa), n)
        print(f'\n**另一種刺殺設定：{name}**\n')
        print('| 組 | 任務三藍 % | 刺中率 % | 藍方勝率 % |')
        print('|---|---|---|---|')
        print(line('現行藍方', *xb))
        print(line('新藍方', *xa))
        print(diff('新藍方 − 現行藍方（藍方勝率）', xb[2], xa[2]))
        print(diff('新藍方＋這個刺客 − (a)', a[2], xa[2]))
        res['alt ' + name] = {'base': float(xb[2].mean()), 'arm': float(xa[2].mean()), 'hit_base': float(xb[1][xb[1] >= 0].mean()), 'hit_arm': float(xa[1][xa[1] >= 0].mean())}
    if args.json:
        with open(args.json, 'w', encoding='utf8') as fh:
            json.dump(res, fh, ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
