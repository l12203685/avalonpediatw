#!/usr/bin/env python3
"""第 82 回合：自我對打候選對基準線的逐局配對（同一批種子、同一個局號；兩邊的刺客都是現行預設的世界線刺客，紀錄上的刺殺就是它）。

輸入 = `keySpotStudy.ts --export-bot` 的 jsonl（基準線、候選各一份）。輸出三種結果（三紅／三藍死／三藍活）、任務三藍、刺中率，
和藍方勝率（三藍活）、任務三藍的成對差（以局為單位 bootstrap 95%）、到刺殺之前完全相同的局的比例、梅林在分層第一層的比例
（`assassinPathStudy.ts --export-bot` 的輸出，給了才算）。只有局號、角色與結果，沒有玩家名。

  python3 scripts/merlinTellArms82.py --base b_BASE.jsonl --arm T5=b_T5.jsonl [--arm ...] [--spots BASE=bA_BASE.jsonl --spots T5=bA_T5.jsonl] [--json out.json]
"""
import argparse
import json

import numpy as np


def load(p):
    with open(p, encoding='utf8') as fh:
        return {g['gi']: g for g in (json.loads(l) for l in fh if l.strip())}


def boot(d, n=2000, seed=82):
    a = np.asarray(d, dtype=float)
    rng = np.random.default_rng(seed)
    m = a[rng.integers(0, len(a), size=(n, len(a)))].mean(axis=1)
    return 100 * a.mean(), 100 * np.percentile(m, 2.5), 100 * np.percentile(m, 97.5)


def split(gs):
    n = len(gs)
    r3 = sum(g['out'] == 'red3' for g in gs)
    dead = sum(g['out'] == 'blueDead' for g in gs)
    alive = sum(g['out'] == 'blueAlive' for g in gs)
    return {'n': n, 'red3': 100 * r3 / n, 'blueDead': 100 * dead / n, 'blueAlive': 100 * alive / n,
            'mission': 100 * (dead + alive) / n, 'hit': 100 * dead / max(dead + alive, 1)}


def same_until_kill(a, b):
    return a['props'] == b['props'] and a['quests'] == b['quests'] and a['lakes'] == b['lakes']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--arm', action='append', default=[])
    ap.add_argument('--spots', action='append', default=[])
    ap.add_argument('--json')
    args = ap.parse_args()
    base = load(args.base)
    spots = {}
    for s in args.spots:
        k, p = s.split('=', 1)
        spots[k] = {g['gi']: g for g in load(p).values()}
    out = {'BASE': split(list(base.values()))}
    if 'BASE' in spots:
        out['BASE']['mFront'] = 100 * np.mean([any(c['seat'] == r['merlin'] and c['front'] for c in r['cands']) for r in spots['BASE'].values()])
    print('| 組 | 局數 | 三紅 % | 三藍死 % | 三藍活 % | 任務三藍 % | 刺中率 % | 梅林在第一層 % | 藍方勝率（三藍活）差 [95%] | 任務三藍差 [95%] | 到刺殺之前相同 % |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    b = out['BASE']
    print(f"| 基準線 | {b['n']} | {b['red3']:.1f} | {b['blueDead']:.1f} | {b['blueAlive']:.1f} | {b['mission']:.1f} | {b['hit']:.1f} | {b.get('mFront', float('nan')):.1f} | — | — | — |")
    for a in args.arm:
        name, path = a.split('=', 1)
        arm = load(path)
        gis = sorted(set(arm) & set(base))
        s = split([arm[g] for g in gis])
        dw = [(arm[g]['out'] == 'blueAlive') - (base[g]['out'] == 'blueAlive') for g in gis]
        dm = [(arm[g]['out'] != 'red3') - (base[g]['out'] != 'red3') for g in gis]
        s['dWin'] = boot(dw)
        s['dMission'] = boot(dm)
        s['same'] = 100 * np.mean([same_until_kill(arm[g], base[g]) for g in gis])
        if name in spots:
            s['mFront'] = 100 * np.mean([any(c['seat'] == r['merlin'] and c['front'] for c in r['cands']) for r in spots[name].values()])
        out[name] = s
        print(f"| {name} | {s['n']} | {s['red3']:.1f} | {s['blueDead']:.1f} | {s['blueAlive']:.1f} | {s['mission']:.1f} | {s['hit']:.1f} | {s.get('mFront', float('nan')):.1f} | "
              f"{s['dWin'][0]:+.2f} [{s['dWin'][1]:+.2f}, {s['dWin'][2]:+.2f}] | {s['dMission'][0]:+.2f} [{s['dMission'][1]:+.2f}, {s['dMission'][2]:+.2f}] | {s['same']:.1f} |")
    print('| 參考：藍、紅平均 PR 都 ≥ 55 的真人局 | 208 | 47.1 | 21.2 | 31.7 | 52.9 | 40.0 | — | — | — | — |')
    if args.json:
        json.dump(out, open(args.json, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
