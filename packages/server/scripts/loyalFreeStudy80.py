#!/usr/bin/env python3
"""第 80 回合：`loyalFreeStudy80.ts` 的彙總（只有座位、角色、隊伍與機率的比，沒有玩家名）。

忠臣說得通的隊（倍數 r：公開的「這隊沒有紅」機率 ≥ 最高的 r 倍）——
  覆蓋率   = 真人忠臣／派西實際派的隊（含自己）落在範圍裡的比例（拿來定 r：範圍要裝得下真人忠臣會派的隊）；
  範圍大小 = 說得通的隊有幾支（平均、中位數）；
  有乾淨的 = 範圍裡至少一支不帶梅林看得到的紅的比例（= 梅林照第 80 回合的規則不必用能力避開的比例）。

  python3 scripts/loyalFreeStudy80.py h80.jsonl [b80.jsonl ...] [--md] [--ratios 0.7,0.5,0.3]
"""
import json
import sys
from collections import defaultdict

RATIOS = [1, 0.9, 0.7, 0.5, 0.3, 0.2, 0.1, 0.05]


def load(paths):
    rows = []
    for p in paths:
        with open(p, encoding='utf8') as f:
            rows += [json.loads(l) for l in f if l.strip()]
    return rows


def cell(r):
    if r['forced']:
        return f"{r['round']}-5"
    return f"{r['round']}-1~4"


def pct(a, b):
    return f"{100 * a / b:.1f}" if b else '—'


def median(xs):
    xs = sorted(xs)
    return xs[len(xs) // 2] if xs else 0


def table(rows, want, title, md):
    idx = [RATIOS.index(x) for x in want]
    groups = defaultdict(list)
    for r in rows:
        groups[cell(r)].append(r)
    order = sorted(groups, key=lambda c: (int(c[0]), c[2:] != '1~4'))
    head = ['局面', '決策數'] + [f'r={w}：覆蓋率／範圍大小（中位）／有乾淨的' for w in want]
    out = [f'\n**{title}**\n', '| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)]
    tot = []
    for c in order + ['全部']:
        g = rows if c == '全部' else groups[c]
        selfed = [r for r in g if r['ratio'] is not None]
        line = [c, str(len(g))]
        for i, w in zip(idx, want):
            cov = sum(1 for r in selfed if r['ratio'] >= w - 1e-9)
            k = [r['k'][i] for r in g]
            clean = sum(1 for r in g if r['c'][i] > 0)
            line.append(f"{pct(cov, len(selfed))}／{sum(k) / max(len(k), 1):.1f}（{median(k)}）／{pct(clean, len(g))}")
        out.append('| ' + ' | '.join(line) + ' |')
    return '\n'.join(out)


def merlin_table(rows, want, title):
    idx = [RATIOS.index(x) for x in want]
    groups = defaultdict(list)
    for r in rows:
        groups[cell(r)].append(r)
    order = sorted(groups, key=lambda c: (int(c[0]), c[2:] != '1~4'))
    head = ['局面', '決策數', '帶拇指 %'] + [f'r={w}：有乾淨的／梅林實際派的隊在範圍裡且乾淨／有乾淨時梅林派乾淨的' for w in want]
    out = [f'\n**{title}**\n', '| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)]
    for c in order + ['全部']:
        g = rows if c == '全部' else groups[c]
        line = [c, str(len(g)), pct(sum(1 for r in g if r['thumbs'] > 0), len(g))]
        for i, w in zip(idx, want):
            clean = [r for r in g if r['c'][i] > 0]
            inset = sum(1 for r in g if r['thumbs'] == 0 and r['ratio'] is not None and r['ratio'] >= w - 1e-9)
            line.append(f"{pct(len(clean), len(g))}／{pct(inset, len(g))}／{pct(sum(1 for r in clean if r['thumbs'] == 0), len(clean))}")
        out.append('| ' + ' | '.join(line) + ' |')
    return '\n'.join(out)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    want = [0.7, 0.5, 0.3]
    if '--ratios' in sys.argv:
        want = [float(x) for x in sys.argv[sys.argv.index('--ratios') + 1].split(',')]
        args = [a for a in args if a != sys.argv[sys.argv.index('--ratios') + 1]]
    rows = load(args)
    for src in sorted({r['src'] for r in rows}):
        rs = [r for r in rows if r['src'] == src]
        name = '真人局' if src == 'human' else '機器人局'
        loyal = [r for r in rs if r['role'] in ('loyal', 'percival')]
        merlin = [r for r in rs if r['role'] == 'merlin']
        print(table(loyal, want, f'{name}：忠臣／派西當隊長（覆蓋率 = 實際派的隊在範圍裡）', True))
        print(table(merlin, want, f'{name}：梅林當隊長（範圍照他的座位算；覆蓋率 = 實際派的隊在範圍裡）', True))
        print(merlin_table(merlin, want, f'{name}：梅林當隊長——範圍裡有沒有乾淨的、實際派的隊'))
        # 全部 r 的一行總覽（覆蓋率曲線）
        selfed = [r for r in loyal if r['ratio'] is not None]
        print(f'\n{name} 忠臣／派西 覆蓋率曲線（全部提議，含自己的 {len(selfed)} 個）：' + '、'.join(
            f"r={w} {pct(sum(1 for r in selfed if r['ratio'] >= w - 1e-9), len(selfed))}%" for w in RATIOS))
        nself = sum(1 for r in loyal if not r['self'])
        print(f'{name} 忠臣／派西 隊上沒有自己：{pct(nself, len(loyal))}%（{nself}／{len(loyal)}）')
        for w in RATIOS:
            i = RATIOS.index(w)
            print(f"  r={w}：梅林的決策點有乾淨的 {pct(sum(1 for r in merlin if r['c'][i] > 0), len(merlin))}%，平均範圍 {sum(r['k'][i] for r in merlin) / max(len(merlin), 1):.1f}")


if __name__ == '__main__':
    main()
