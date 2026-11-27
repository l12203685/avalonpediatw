#!/usr/bin/env python3
"""第 90 回合：第 1 號模型接上信念之後（執行期的路徑，`bayesRedShare` 加 `mlBelief90`），真人局驗證那一半的樣本外分數。

輸入 = `exportBelief90.ts --split time-test --cand NAME=flags ...` 的輸出（每一列有現行 p 與每一個候選的 p）。
每一組：Brier、對數損失、ECE（10 格），和現行的差與 95% 重抽信賴區間（以局為集群）；分視角（忠臣、派西）、分回合、高端桌。

  python3 scripts/ml/evalBelief90.py --data b90c_0.bin b90c_1.bin [--json out.json] [--md out.md]
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from train90 import binary_metrics_by_game, compare, load_bin  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', nargs='+', required=True)
    ap.add_argument('--boot', type=int, default=1000)
    ap.add_argument('--json')
    ap.add_argument('--md')
    a = ap.parse_args()
    cols, M = load_bin(a.data)
    ci = {c: i for i, c in enumerate(cols)}
    cands = [c for c in cols if c.startswith('p_')]
    y = M[:, ci['y']].astype(np.float64)
    gi = M[:, ci['gi']].astype(np.int64)
    perc = M[:, ci['percival']] > 0.5
    rnd = M[:, ci['round']].astype(int)
    strong = M[:, ci['strong']] > 0.5
    ps = [('現行', M[:, ci['pBase']].astype(np.float64))] + [(c[2:], M[:, ci[c]].astype(np.float64)) for c in cands]
    groups = [('全部', np.ones(len(y), dtype=bool)), ('忠臣', ~perc), ('派西', perc), ('高端桌', strong)]
    groups += [(f'第 {r} 局', rnd == r) for r in range(1, 6)]
    out = {}
    lines = ['| 範圍 | 讀法 | 點數 | Brier | 差 [95%] | 對數損失 | 差 [95%] | ECE pp | 差 [95%] |', '|---|---|---|---|---|---|---|---|---|']
    for gname, mask in groups:
        if mask.sum() == 0:
            continue
        ms = [binary_metrics_by_game(p[mask], y[mask], gi[mask]) for _, p in ps]
        res = compare(ms, [n for n, _ in ps], B=a.boot)
        out[gname] = res
        for n, _ in ps:
            r = res[n]
            if n == '現行':
                lines.append(f'| {gname} | 現行 | {r["n"]:,} | {r["brier"]:.4f} | — | {r["logloss"]:.4f} | — | {100 * r["ece"]:.2f} | — |')
            else:
                def fmt(k, s=1.0, d=4):
                    lo, hi = r[f'd_{k}_ci']
                    return f'{s * r[f"d_{k}"]:+.{d}f} [{s * lo:+.{d}f}, {s * hi:+.{d}f}]'
                lines.append(f'| {gname} | {n} | {r["n"]:,} | {r["brier"]:.4f} | {fmt("brier")} | {r["logloss"]:.4f} | {fmt("logloss")} | {100 * r["ece"]:.2f} | {fmt("ece", 100, 2)} |')
    md = '\n'.join(lines)
    print(md)
    if a.json:
        json.dump(out, open(a.json, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    if a.md:
        open(a.md, 'w', encoding='utf8').write(md + '\n')


if __name__ == '__main__':
    main()
