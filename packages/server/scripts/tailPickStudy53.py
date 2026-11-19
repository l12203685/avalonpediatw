#!/usr/bin/env python3
"""第 53 回合：`tailPickStudy.ts --all-attempts` 的彙總——第 1、2 局每一次提議，忠臣／派西隊長的全好隊比例（真人、強者、機器人）。
用法: python3 -I scripts/tailPickStudy53.py 標籤=rows.jsonl [標籤=rows.jsonl ...] [--strong-s 55]
真人與強者的數字只取第一個檔（每個檔的真人隊相同）；機器人每個檔一欄。
"""
import sys, json, math
from collections import defaultdict

args = [a for a in sys.argv[1:] if '=' in a and not a.startswith('--')]
strong_s = float(sys.argv[sys.argv.index('--strong-s') + 1]) if '--strong-s' in sys.argv else 55
files = [(a.split('=', 1)[0], a.split('=', 1)[1]) for a in args]


def wilson(k, n):
    if n == 0:
        return '—'
    z = 1.96; p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return f'{100 * p:.1f} [{100 * (c - h):.0f}, {100 * (c + h):.0f}]'


def cell(r):
    att = '第5次（強制）' if r.get('forced') else f"第{r.get('attempt', '?')}次"
    return (r['round'], att, r['role'])


human = defaultdict(lambda: [0, 0, 0, 0])
bots = {lab: defaultdict(lambda: [0, 0]) for lab, _ in files}
for idx, (lab, path) in enumerate(files):
    for line in open(path):
        if not line.strip():
            continue
        r = json.loads(line)
        keys = [cell(r), (r['round'], '全部', r['role']), (r['round'], '第1–4次', r['role']) if not r.get('forced') else None]
        for k in keys:
            if k is None:
                continue
            if idx == 0:
                h = human[k]
                h[0] += 1; h[1] += 1 if r['human']['allGood'] else 0
                if r.get('s') is not None and r['s'] >= strong_s:
                    h[2] += 1; h[3] += 1 if r['human']['allGood'] else 0
            if r.get('bot'):
                b = bots[lab][k]
                b[0] += 1; b[1] += 1 if r['bot']['allGood'] else 0

print('| 局 | 第幾次 | 隊長 | n | 真人全好 % | 強者全好 %（n） | ' + ' | '.join(f'機器人 {lab} %' for lab, _ in files) + ' |')
print('|---|---|---|---|---|---|' + '---|' * len(files))
order = lambda k: (k[0], {'全部': 0, '第1–4次': 1}.get(k[1], 2), k[1], k[2])
for k in sorted(human, key=order):
    h = human[k]
    row = [str(k[0]), k[1], {'loyal': '忠臣', 'percival': '派西'}.get(k[2], k[2]), str(h[0]), wilson(h[1], h[0]), f'{wilson(h[3], h[2])}（{h[2]}）']
    for lab, _ in files:
        b = bots[lab][k]
        row.append(wilson(b[1], b[0]))
    print('| ' + ' | '.join(row) + ' |')
