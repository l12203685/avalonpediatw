#!/usr/bin/env python3
"""第 53 回合：pickAudit 的 'pa' 欄彙總（忠臣視角的好人隊長挑隊：機器人的隊 vs 精確挑隊）。
用法: python3 -I packages/server/scripts/selfplay/r53Audit.py <results/r53> DEF ELA ELC [--json out.json]
pa 每筆: [回合, 第幾次提議, 真角色碼 L/P/M/R, 機器人的隊真的全好, 後驗 P(機器人的隊), 後驗最高, 後驗最高那幾隊真的全好的平均,
          均勻 P(機器人的隊), 均勻最高, 均勻最高那幾隊真的全好的平均, 機器人的隊真的紅數]
"""
import sys, os, json
from collections import defaultdict

D = sys.argv[1]
labels = [a for a in sys.argv[2:] if not a.startswith('--') and not a.endswith('.json')]
out = {}
for lab in labels:
    agg = defaultdict(lambda: defaultdict(float))
    for f in sorted(os.listdir(D)):
        if not f.startswith(lab + '_') or not f.endswith('.json'):
            continue
        j = json.load(open(os.path.join(D, f)))
        if 'pa' not in j['cols']:
            continue
        ix = j['cols'].index('pa')
        for row in j['rows']:
            for r in json.loads(row[ix]):
                rd, att, code = r[0], r[1], r[2]
                keys = [(code, rd, 'all'), (code, 'all', 'all'), (code, rd, 'forced' if att >= 5 else 'talk')]
                for k in keys:
                    a = agg[k]
                    a['n'] += 1
                    a['bot'] += r[3]
                    if r[6] >= 0:
                        a['nPost'] += 1; a['postArg'] += r[6]; a['postBot'] += r[4]; a['postMax'] += r[5]
                        a['botIsPostMax'] += 1 if r[4] >= r[5] - 0.0005 else 0
                    if r[9] >= 0:
                        a['nUnif'] += 1; a['unifArg'] += r[9]; a['unifBot'] += r[7]; a['unifMax'] += r[8]
                        a['botIsUnifMax'] += 1 if r[7] >= r[8] - 0.0005 else 0
                    if rd == 4:
                        a['r4ok'] += 1 if r[10] < 2 else 0
    res = {}
    for (code, rd, kind), a in agg.items():
        n = a['n']
        res[f'{code}|{rd}|{kind}'] = {
            'n': int(n), '機器人全好': a['bot'] / n,
            '後驗精確全好': a['postArg'] / a['nPost'] if a['nPost'] else None,
            '均勻精確全好': a['unifArg'] / a['nUnif'] if a['nUnif'] else None,
            '後驗P機器人': a['postBot'] / a['nPost'] if a['nPost'] else None, '後驗P最高': a['postMax'] / a['nPost'] if a['nPost'] else None,
            '均勻P機器人': a['unifBot'] / a['nUnif'] if a['nUnif'] else None, '均勻P最高': a['unifMax'] / a['nUnif'] if a['nUnif'] else None,
            '機器人是後驗最高': a['botIsPostMax'] / a['nPost'] if a['nPost'] else None,
            '機器人是均勻最高': a['botIsUnifMax'] / a['nUnif'] if a['nUnif'] else None,
            '第4局機器人紅少於2': a['r4ok'] / n if rd == 4 else None,
        }
    out[lab] = res
    print(f'== {lab}')
    print('  角色 回合 n | 機器人全好 後驗精確 均勻精確 | 後驗P 機器人/最高 均勻P 機器人/最高 | 機器人=後驗最高 機器人=均勻最高')
    for code in 'LPMR':
        for rd in [1, 2, 3, 4, 5, 'all']:
            k = f'{code}|{rd}|all'
            if k not in res:
                continue
            v = res[k]
            f = lambda x: '  -  ' if x is None else f'{100 * x:5.1f}'
            print(f"  {code} R{rd} {v['n']:7d} | {f(v['機器人全好'])} {f(v['後驗精確全好'])} {f(v['均勻精確全好'])} | {f(v['後驗P機器人'])}/{f(v['後驗P最高'])} {f(v['均勻P機器人'])}/{f(v['均勻P最高'])} | {f(v['機器人是後驗最高'])} {f(v['機器人是均勻最高'])}")
if '--json' in sys.argv:
    json.dump(out, open(sys.argv[sys.argv.index('--json') + 1], 'w'), ensure_ascii=False, indent=1)
