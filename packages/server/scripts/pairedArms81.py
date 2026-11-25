#!/usr/bin/env python3
"""第 81 回合：自我對打候選對基準線的逐局配對比較（同一批種子、都有 detail=1），附任務三藍與三種結果，和兩邊都強的真人局放在一起。

  python3 scripts/pairedArms81.py --base DIR --arm NAME=DIR [--arm ...] [--json out.json]

紅方 Δ = 候選紅方勝率 − 基準線紅方勝率（逐局配對的 95% 區間）；同時列改到的局數（整局雜湊 h 不同）。只有合計數字。
"""
import json, os, glob, math, argparse

def load(d):
    rows = {}
    for fp in sorted(glob.glob(os.path.join(d, '*.json'))):
        j = json.load(open(fp)); c = j['cols']
        for r in j['rows']:
            rows[r[c.index('i')]] = {'bw': r[c.index('blueWon')], 'tb': r[c.index('threeBlue')], 'mk': r[c.index('merlinKilled')], 'h': r[c.index('h')]}
    return rows

def split(rows, keys):
    n = len(keys); tb = sum(rows[k]['tb'] for k in keys); bw = sum(rows[k]['bw'] for k in keys)
    return {'n': n, '三紅': 100 * (n - tb) / n, '三藍死': 100 * (tb - bw) / n, '三藍活': 100 * bw / n, '任務三藍': 100 * tb / n, '刺中率': 100 * (tb - bw) / max(1, tb)}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--base', required=True); ap.add_argument('--arm', action='append', default=[]); ap.add_argument('--json')
    a = ap.parse_args()
    B = load(a.base); out = {'base': None, 'arms': {}}
    for spec in a.arm:
        name, d = spec.split('=', 1); A = load(d)
        keys = sorted(set(A) & set(B))
        diffs = [(1 - A[k]['bw']) - (1 - B[k]['bw']) for k in keys]
        n = len(diffs); m = sum(diffs) / n; sd = math.sqrt(sum((x - m) ** 2 for x in diffs) / (n - 1))
        tbd = [A[k]['tb'] - B[k]['tb'] for k in keys]; mt = sum(tbd) / n; sdt = math.sqrt(sum((x - mt) ** 2 for x in tbd) / (n - 1))
        changed = sum(1 for k in keys if A[k]['h'] != B[k]['h'])
        out['arms'][name] = {'n': n, 'redDelta': 100 * m, 'lo': 100 * (m - 1.96 * sd / math.sqrt(n)), 'hi': 100 * (m + 1.96 * sd / math.sqrt(n)),
                             'threeBlueDelta': 100 * mt, 'tbLo': 100 * (mt - 1.96 * sdt / math.sqrt(n)), 'tbHi': 100 * (mt + 1.96 * sdt / math.sqrt(n)),
                             'changed': changed, 'split': split(A, keys)}
        out['base'] = split(B, keys)
    print('| 組 | 局數 | 改到的局 | 三紅 | 三藍死 | 三藍活 | 任務三藍 | 刺中率 | 紅方 Δ（95% 區間） | 任務三藍 Δ |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    print('| 兩邊都強的真人局（參考） | 208 | — | 47.1 | 21.2 | 31.7 | 52.9 | 40.0 | — | — |')
    b = out['base']
    if b: print(f"| 基準線 | {b['n']} | — | {b['三紅']:.1f} | {b['三藍死']:.1f} | {b['三藍活']:.1f} | {b['任務三藍']:.1f} | {b['刺中率']:.1f} | — | — |")
    for name, r in out['arms'].items():
        s = r['split']
        print(f"| {name} | {r['n']} | {r['changed']} | {s['三紅']:.1f} | {s['三藍死']:.1f} | {s['三藍活']:.1f} | {s['任務三藍']:.1f} | {s['刺中率']:.1f} | {r['redDelta']:+.2f} [{r['lo']:+.2f}, {r['hi']:+.2f}] | {r['threeBlueDelta']:+.2f} [{r['tbLo']:+.2f}, {r['tbHi']:+.2f}] |")
    if a.json: open(a.json, 'w').write(json.dumps(out, ensure_ascii=False))

if __name__ == '__main__':
    main()
