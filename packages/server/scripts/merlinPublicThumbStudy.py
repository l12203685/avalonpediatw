#!/usr/bin/env python3
"""第 58 回合：彙總 merlinPublicThumbStudy.ts 的 JSONL（真人梅林的提議 vs 機器人梅林在同一個決策點）。

  python3 scripts/merlinPublicThumbStudy.py rows_*.jsonl [--base BASE] [--md]

每個子集合（全部、高端桌 S≥55、高強度 S≥65、梅林 PR≥80）× 每一組設定：
  拇指率（隊上有看得到的紅）、全好隊、和真人完全相同、Jaccard、和真人「帶不帶拇指」一致；
  和基準（--base）的配對差（以局為集群的標準誤）、改到的點。第 1、2 局非強制另外列。
"""
import json
import math
import sys
from collections import defaultdict


def load(paths):
    rows = []
    for p in paths:
        with open(p, encoding='utf8') as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append(json.loads(line))
    return rows


def jacc(a, b):
    a, b = set(a), set(b)
    return len(a & b) / len(a | b) if a | b else 1.0


def metrics(r, v):
    b = r.get(v)
    h = r['human']
    if not b:
        return None
    return {
        'thumb': 1.0 if b['thumbs'] > 0 else 0.0,
        'good': 1.0 if b['allGood'] else 0.0,
        'exact': 1.0 if b['team'] == h['team'] else 0.0,
        'jac': jacc(b['team'], h['team']),
        'thumbAgree': 1.0 if (b['thumbs'] > 0) == (h['thumbs'] > 0) else 0.0,
    }


def paired(rows, v, base, key):
    """配對差（v − base）的平均與以局為集群的 95% 區間。"""
    by = defaultdict(list)
    for r in rows:
        a, b = metrics(r, v), metrics(r, base)
        if a and b:
            by[r['gi']].append(a[key] - b[key])
    n = sum(len(x) for x in by.values())
    if n == 0:
        return float('nan'), float('nan'), 0
    tot = sum(sum(x) for x in by.values())
    m = tot / n
    g = len(by)
    s2 = sum((sum(x) - m * len(x)) ** 2 for x in by.values())
    se = math.sqrt(s2 * g / max(g - 1, 1)) / n
    return m, 1.96 * se, n


def main():
    argv = sys.argv[1:]
    base = 'BASE'
    if '--base' in argv:
        i = argv.index('--base')
        base = argv[i + 1]
        del argv[i:i + 2]
    md = '--md' in argv
    argv = [a for a in argv if a != '--md']
    rows = load(argv)
    variants = [k for k in rows[0] if isinstance(rows[0].get(k), dict) and k != 'human' and 'team' in rows[0][k]] if rows else []
    for r in rows:
        for k, x in r.items():
            if isinstance(x, dict) and 'team' in x and k != 'human' and k not in variants:
                variants.append(k)
    subsets = [
        ('全部', lambda r: True),
        ('高端桌 S≥55', lambda r: r['s'] is not None and r['s'] >= 55),
        ('高強度 S≥65', lambda r: r['s'] is not None and r['s'] >= 65),
        ('梅林 PR≥80', lambda r: r['pr'] is not None and r['pr'] >= 80),
        ('弱桌 S<38', lambda r: r['s'] is not None and r['s'] < 38),
        ('一般桌 38≤S<55', lambda r: r['s'] is not None and 38 <= r['s'] < 55),
        ('S 不明', lambda r: r['s'] is None),
    ]
    scopes = [
        ('每一次提議', lambda r: True),
        ('第 1、2 局非強制', lambda r: r['round'] <= 2 and not r['forced']),
        ('第 3 局起或強制', lambda r: not (r['round'] <= 2 and not r['forced'])),
    ]
    keys = [('thumb', '拇指率'), ('good', '全好隊'), ('exact', '完全相同'), ('jac', 'Jaccard'), ('thumbAgree', '拇指與真人一致')]
    out = []
    for sname, sf in subsets:
        for cname, cf in scopes:
            rs = [r for r in rows if sf(r) and cf(r)]
            if not rs:
                continue
            out.append(f'\n#### {sname} · {cname}（{len(rs)} 個決策點）\n')
            out.append('| 設定 | 改到 | ' + ' | '.join(k[1] for k in keys) + ' |')
            out.append('|---|---|' + '---|' * len(keys))
            hum = [r['human'] for r in rs]
            out.append('| 真人 | — | ' + f"{100 * sum(1 for h in hum if h['thumbs'] > 0) / len(hum):.1f} | {100 * sum(1 for h in hum if h['allGood']) / len(hum):.1f} | — | — | — |")
            for v in variants:
                ms = [metrics(r, v) for r in rs]
                ms = [m for m in ms if m]
                if not ms:
                    continue
                changed = sum(1 for r in rs if r.get(v) and r.get(base) and r[v]['team'] != r[base]['team'])
                cells = []
                for k, _ in keys:
                    val = sum(m[k] for m in ms) / len(ms)
                    txt = f'{val:.3f}' if k == 'jac' else f'{100 * val:.1f}'
                    if v != base:
                        d, ci, _ = paired(rs, v, base, k)
                        txt += f'（{d:+.3f} ± {ci:.3f}）' if k == 'jac' else f'（{100 * d:+.1f} ± {100 * ci:.1f}）'
                    cells.append(txt)
                out.append(f'| {v} | {changed if v != base else "—"} | ' + ' | '.join(cells) + ' |')
    # 改到的點：基準 vs 候選和真人的一致（全部 / S≥65）
    out.append('\n#### 改到的點（候選和基準的隊不同）\n')
    out.append('| 設定 | 子集合 | 點數 | 完全相同 基準 → 候選 | Jaccard 基準 → 候選 | 拇指率 基準 → 候選（真人） | 全好隊 基準 → 候選（真人） | 照公開視角派（第 3 步） |')
    out.append('|---|---|---|---|---|---|---|---|')
    for v in variants:
        if v == base:
            continue
        for sname, sf in subsets:
            rs = [r for r in rows if sf(r) and r.get(v) and r.get(base) and r[v]['team'] != r[base]['team']]
            if not rs:
                continue
            n = len(rs)
            f = lambda key, w: sum(metrics(r, w)[key] for r in rs) / n
            ht = sum(1 for r in rs if r['human']['thumbs'] > 0) / n
            hg = sum(1 for r in rs if r['human']['allGood']) / n
            fb = sum(1 for r in rs if r[v].get('fb')) / n
            out.append(f'| {v} | {sname} | {n} | {100 * f("exact", base):.1f} → {100 * f("exact", v):.1f} | {f("jac", base):.3f} → {f("jac", v):.3f} | '
                       f'{100 * f("thumb", base):.1f} → {100 * f("thumb", v):.1f}（{100 * ht:.1f}） | {100 * f("good", base):.1f} → {100 * f("good", v):.1f}（{100 * hg:.1f}） | {100 * fb:.0f}% |')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
