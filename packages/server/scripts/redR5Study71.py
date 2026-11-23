#!/usr/bin/env python3
"""第 71 回合（紅方）：第 5 局（2:2）紅方不在隊上、隊上沒有看得到的隊友的票（`redR5Study71.ts` 的輸出）彙總。

    python3 scripts/redR5Study71.py rows_*.jsonl [--base A] [--min-s 55]

每一組設定：贊成率、和真人同票（候選 − 對照，以局為集群 bootstrap 95%）、贊成的隊實際有紅的比例、
把真人這一票換成機器人的票時「這隊當場過而且隊上有紅」（紅方當場贏；別人的票照真人）與「當場過而且全藍」的比例。
另列紅方自己視角 P(隊上至少一紅) 的鑑別力（AUC）與分箱。只輸出彙總數字。
"""
import argparse
import glob
import json
import random
from collections import defaultdict


def load(paths, min_s):
    rows = []
    for p in paths:
        for f in glob.glob(p):
            with open(f) as fh:
                for line in fh:
                    if line.strip():
                        r = json.loads(line)
                        if min_s is not None and (r['s'] is None or r['s'] < min_s):
                            continue
                        rows.append(r)
    return rows


def boot_diff(rows, f, R=1000):
    by = defaultdict(list)
    for r in rows:
        by[r['gi']].append(f(r))
    keys = list(by)
    rnd = random.Random(71)
    out = []
    for _ in range(R):
        s = n = 0
        for _k in keys:
            v = by[keys[rnd.randrange(len(keys))]]
            s += sum(v)
            n += len(v)
        out.append(100 * s / max(1, n))
    out.sort()
    return out[int(0.025 * R)], out[int(0.975 * R)]


def auc(rows):
    pos = sorted(r['pRed'] for r in rows if r['reds'] > 0 and r.get('pRed') is not None)
    neg = sorted(r['pRed'] for r in rows if r['reds'] == 0 and r.get('pRed') is not None)
    if not pos or not neg:
        return float('nan')
    # Mann–Whitney via ranks
    allv = sorted([(v, 1) for v in pos] + [(v, 0) for v in neg])
    rank = 0.0
    i = 0
    rsum = 0.0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]:
            j += 1
        avg = (i + j + 1) / 2
        rsum += avg * sum(1 for k in range(i, j) if allv[k][1] == 1)
        i = j
    return (rsum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--min-s', type=float, default=None)
    args = ap.parse_args()
    rows = load(args.paths, args.min_s)
    labels = [k for k in rows[0] if k not in ('gi', 's', 'tier', 'role', 'seat', 'attempt', 'outcome', 'reds', 'yesOthers', 'passed', 'human', 'pRed', 'minReds', 'minReds0')]
    base = {lab: ('H' if lab.startswith('H') and 'H' in labels else 'A') for lab in labels}
    for name, grp in (('奧伯倫', lambda r: r['role'] == 'oberon'), ('相認紅', lambda r: r['role'] != 'oberon'), ('全部', lambda r: True)):
        X = [r for r in rows if grp(r)]
        n = len(X)
        if n == 0:
            continue
        print(f"\n## {name}：{n} 點；隊上實際有紅 {100 * sum(r['reds'] > 0 for r in X) / n:.1f}%；確定性層說一定有紅 L1* {100 * sum((r.get('minReds') or 0) >= 1 for r in X) / n:.1f}%（其中實際有紅 {100 * sum(r['reds'] > 0 for r in X if (r.get('minReds') or 0) >= 1) / max(1, sum((r.get('minReds') or 0) >= 1 for r in X)):.0f}%）、L0 {100 * sum((r.get('minReds0') or 0) >= 1 for r in X) / n:.1f}%（{100 * sum(r['reds'] > 0 for r in X if (r.get('minReds0') or 0) >= 1) / max(1, sum((r.get('minReds0') or 0) >= 1 for r in X)):.0f}%）；"
              f"自己視角 P(有紅) 的 AUC {auc(X):.3f}")
        hp = sum(r['human'] for r in X)
        win_h = sum(1 for r in X if r['passed'] and r['reds'] > 0)
        blue_h = sum(1 for r in X if r['passed'] and r['reds'] == 0)
        print(f"真人：贊成 {100 * hp / n:.1f}%（贊成的隊有紅 {100 * sum(r['reds'] > 0 for r in X if r['human']) / max(1, hp):.1f}%）；當場過且有紅 {100 * win_h / n:.1f}%、當場過且全藍 {100 * blue_h / n:.1f}%")
        print('| 設定 | 贊成 | 贊成的隊有紅 | 和真人同票 | 同票 Δ（對照）[95%] | 當場過且有紅 | 當場過且全藍 |')
        print('|---|---|---|---|---|---|---|')
        for lab in labels:
            Y = [r for r in X if r.get(lab) is not None]
            m = len(Y)
            ap_ = sum(r[lab] for r in Y)
            ag = sum(r[lab] == r['human'] for r in Y)
            passes = lambda r: (r['yesOthers'] + r[lab]) >= 6
            win = sum(1 for r in Y if passes(r) and r['reds'] > 0)
            blue = sum(1 for r in Y if passes(r) and r['reds'] == 0)
            b = base[lab]
            if b != lab and all(r.get(b) is not None for r in Y):
                lo, hi = boot_diff(Y, lambda r: (r[lab] == r['human']) - (r[b] == r['human']))
                d = 100 * sum((r[lab] == r['human']) - (r[b] == r['human']) for r in Y) / m
                dtxt = f"{d:+.1f} [{lo:+.1f}, {hi:+.1f}]（{b}）"
            else:
                dtxt = '—'
            print(f"| {lab} | {100 * ap_ / m:.1f}% | {100 * sum(r['reds'] > 0 for r in Y if r[lab]) / max(1, ap_):.1f}% | {100 * ag / m:.1f}% | {dtxt} | {100 * win / m:.1f}% | {100 * blue / m:.1f}% |")
    X = [r for r in rows if r.get('pRed') is not None]
    print('\n## 紅方自己視角 P(隊上至少一紅) 分箱（全部）')
    print('| P(有紅) | 點數 | 實際有紅 | 真人贊成 | 這隊過了 |')
    print('|---|---|---|---|---|')
    for lo, hi in ((0, .2), (.2, .4), (.4, .6), (.6, .8), (.8, .9), (.9, .999), (.999, 1.01)):
        b = [r for r in X if lo <= r['pRed'] < hi]
        if b:
            print(f"| [{lo:.3g}, {min(hi, 1):.3g}) | {len(b)} | {100 * sum(r['reds'] > 0 for r in b) / len(b):.1f}% | {100 * sum(r['human'] for r in b) / len(b):.1f}% | {100 * sum(r['passed'] for r in b) / len(b):.1f}% |")


if __name__ == '__main__':
    main()
