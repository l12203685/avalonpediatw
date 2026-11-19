#!/usr/bin/env python3
"""第 52 回合：彙總 `tailPickStudy.ts` 的 JSONL（第 1、2 局強制局的派隊；沒有玩家名）。

  python3 -I scripts/tailPickStudy.py rows.jsonl [--strong-pr 80] [--md out.md]

格：1-5、2-5（第 1 局任務藍）、2-5（第 1 局任務紅）。組：強者（隊長座位 PR ≥ 80）／全部真人 × 忠臣／派西；
機器人 = 同一批決策點機器人派的隊（同一個角色、同一個座位的公開視角）。比例用 Wilson 95%，平均用 ±1.96 SE；
忠臣 − 派西的差用常態近似，機器人 − 人類的差用逐點配對。
"""
import json
import math
import sys

BIN = [('allGood', '全好隊'), ('self', '派自己'), ('exactPrev', '照派這一局前面的某一隊'), ('r1All', '第 1 局的隊全在（3+1）'), ('leaderOnR1', '隊長出過第 1 局任務'),
       ('merlinIn', '梅林在隊上'), ('morganaIn', '莫甘娜在隊上')]
MEAN = [('maxOverlapPrev', '和前面提議最多重疊'), ('topPicked', '隊員在這一局被選最多的 k 人裡'), ('popular', '隊員被選 ≥ 2 次'),
        ('neverPicked', '隊員沒被選過'), ('meanPicked', '隊員被選平均次數'), ('approverDiff', '隊員贊成率 − 隊外贊成率'),
        ('approvedPrev4', '隊員投第 4 次贊成的人數'), ('flaggedOffApprove', '隊員投過外白'), ('flaggedOnReject', '隊員投過內黑'),
        ('r1In', '隊員裡第 1 局出任務的人'), ('pClean', '機器人隊長的後驗說這隊沒有紅'), ('reds', '隊上紅數')]
OUT = [('missionOk', '任務成功'), ('三紅', '三紅'), ('三藍死', '三藍死'), ('三藍活', '三藍活')]


def wilson(k, n):
    if n == 0:
        return (float('nan'),) * 3
    p = k / n
    z = 1.96
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return p, c - h, c + h


def mstat(xs):
    xs = [float(x) for x in xs if x is not None]
    n = len(xs)
    if n == 0:
        return float('nan'), float('nan'), 0
    m = sum(xs) / n
    v = sum((x - m) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
    return m, math.sqrt(v / n), n


def val(r, side, key):
    if key in ('missionOk',):
        return r['missionOk']
    if key in ('三紅', '三藍死', '三藍活'):
        return r['outcome'] == key
    d = r[side]
    return None if d is None else d.get(key)


def fmt_p(xs):
    xs = [bool(x) for x in xs if x is not None]
    if not xs:
        return '—'
    p, lo, hi = wilson(sum(xs), len(xs))
    return f'{100*p:.1f} [{100*lo:.0f}, {100*hi:.0f}]'


def fmt_m(xs):
    m, se, n = mstat(xs)
    return '—' if n == 0 else f'{m:.2f} ±{1.96*se:.2f}'


def diff_ind(a, b, prop):
    ma, sa, na = mstat([float(bool(x)) if prop else x for x in a if x is not None])
    mb, sb, nb = mstat([float(bool(x)) if prop else x for x in b if x is not None])
    if na == 0 or nb == 0:
        return '—'
    d = ma - mb
    h = 1.96 * math.sqrt(sa * sa + sb * sb)
    k = 100 if prop else 1
    flag = ' *' if abs(d) > h else ''
    return f'{k*d:+.{1 if prop else 2}f} [{k*(d-h):+.{1 if prop else 2}f}, {k*(d+h):+.{1 if prop else 2}f}]{flag}'


def diff_paired(rows, key, prop):
    ds = []
    for r in rows:
        h, b = val(r, 'human', key), val(r, 'bot', key)
        if h is None or b is None:
            continue
        ds.append((float(bool(b)) - float(bool(h))) if prop else (float(b) - float(h)))
    m, se, n = mstat(ds)
    if n == 0:
        return '—'
    k = 100 if prop else 1
    flag = ' *' if abs(m) > 1.96 * se else ''
    return f'{k*m:+.{1 if prop else 2}f} [{k*(m-1.96*se):+.{1 if prop else 2}f}, {k*(m+1.96*se):+.{1 if prop else 2}f}]{flag}'


def main():
    path = sys.argv[1]
    argv = sys.argv[2:]
    spr = float(argv[argv.index('--strong-pr') + 1]) if '--strong-pr' in argv else 80
    rows = [json.loads(line) for line in open(path, encoding='utf8') if line.strip()]
    cells = [('1-5', lambda r: r['round'] == 1), ('2-5（第 1 局藍）', lambda r: r['round'] == 2 and r['r1Failed'] is False),
             ('2-5（第 1 局紅）', lambda r: r['round'] == 2 and r['r1Failed'] is True)]
    strong = lambda r: r['pr'] is not None and r['pr'] >= spr  # noqa: E731
    out = []
    for cname, cf in cells:
        sub = [r for r in rows if cf(r)]
        groups = {}
        for role in ('loyal', 'percival'):
            groups[(role, 'strong')] = [r for r in sub if r['role'] == role and strong(r)]
            groups[(role, 'all')] = [r for r in sub if r['role'] == role]
        L, P, La, Pa = groups[('loyal', 'strong')], groups[('percival', 'strong')], groups[('loyal', 'all')], groups[('percival', 'all')]
        has_bot = any(r['bot'] for r in sub)
        out.append(f'\n### {cname}\n')
        hdr = ['特徵', f'強者忠臣 n={len(L)}', f'強者派西 n={len(P)}', '忠臣 − 派西（強者）', f'全部忠臣 n={len(La)}', f'全部派西 n={len(Pa)}', '忠臣 − 派西（全部）']
        if has_bot:
            hdr += ['機器人忠臣（強者點）', '機器人 − 強者忠臣（配對）', '機器人派西（強者點）', '機器人 − 強者派西', '機器人忠臣（全部點）', '機器人 − 全部忠臣', '機器人派西（全部點）', '機器人 − 全部派西']
        out.append('| ' + ' | '.join(hdr) + ' |')
        out.append('|' + '---|' * len(hdr))
        for key, label, prop in [(k, l, True) for k, l in BIN] + [(k, l, False) for k, l in MEAN] + [(k, l, True) for k, l in OUT]:
            if key in ('r1All', 'r1In', 'leaderOnR1') and cname == '1-5':
                continue
            f = fmt_p if prop else fmt_m
            vs = lambda g, side='human': [val(r, side, key) for r in g]  # noqa: E731
            cols = [label, f(vs(L)), f(vs(P)), diff_ind(vs(L), vs(P), prop), f(vs(La)), f(vs(Pa)), diff_ind(vs(La), vs(Pa), prop)]
            if has_bot:
                if key in [k for k, _ in OUT]:
                    cols += ['—'] * 8
                else:
                    cols += [f(vs(L, 'bot')), diff_paired(L, key, prop), f(vs(P, 'bot')), diff_paired(P, key, prop), f(vs(La, 'bot')), diff_paired(La, key, prop), f(vs(Pa, 'bot')), diff_paired(Pa, key, prop)]
            out.append('| ' + ' | '.join(cols) + ' |')
    text = '\n'.join(out) + '\n'
    print(text)
    if '--md' in argv:
        open(argv[argv.index('--md') + 1], 'w', encoding='utf8').write(text)


if __name__ == '__main__':
    main()
