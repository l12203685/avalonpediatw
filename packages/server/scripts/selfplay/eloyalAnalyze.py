#!/usr/bin/env python3
"""實驗 E-loyal 分析：讀 sp.ts 的結果目錄，按標籤前綴（BASE_ / ELA_ / ELB_）彙總，和 BASE 逐局配對。
用法: python3 -I packages/server/scripts/selfplay/eloyalAnalyze.py <selfplay-results 的 results/eloyal> [--json out.json]
"""
import sys, os, json, math, hashlib
from collections import defaultdict

D = sys.argv[1]
LABELS = ['BASE', 'ELA', 'ELB']
RED_IDX = 4  # c = assassin, morgana, mordred, oberon, percival, merlin
SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
ROLE_OF_C = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin']


def load(label):
    games = {}
    for f in sorted(os.listdir(D)):
        if not f.startswith(label + '_') or not f.endswith('.json'):
            continue
        j = json.load(open(os.path.join(D, f)))
        cols = j['cols']
        ix = {c: k for k, c in enumerate(cols)}
        seed = j['meta']['seed']
        for r in j['rows']:
            games[(seed, r[0])] = (r, ix)
    return games


def wilson(k, n):
    if n == 0:
        return (float('nan'), float('nan'))
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (c - h, c + h)


def unif_pick(seed, i, cands):
    h = hashlib.sha1(f'{seed}|{i}|eloyal-uniform-assassin'.encode()).digest()
    return cands[int.from_bytes(h[:8], 'big') % len(cands)]


def summarize(games):
    s = defaultdict(int)
    cell = defaultdict(lambda: defaultdict(int))
    rnd = defaultdict(lambda: [0, 0])  # round -> [played, success]
    lead = defaultdict(lambda: [0, 0, 0])  # role -> [proposals, reds on team (others), teams with >=1 other red]
    lead_forced = defaultdict(lambda: [0, 0, 0])
    vote = defaultdict(lambda: [0, 0, 0, 0])  # role -> [off-team votes on red teams, approvals, off-team votes on clean teams, approvals]
    lead11 = defaultdict(lambda: [0, 0])  # role -> [1-1 proposals, includes self]
    for (seed, i), (r, ix) in games.items():
        s['n'] += 1
        tb = r[ix['threeBlue']]
        bw = r[ix['blueWon']]
        mk = r[ix['merlinKilled']]
        s['tb'] += tb
        s['alive'] += bw
        s['dead'] += 1 if (tb and mk == 1) else 0
        s['red3'] += 1 if not tb else 0
        cname = ('5紅' if r[ix['red5']] else '5藍') + ('0紅' if r[ix['red0']] else '0藍')
        c = cell[cname]
        c['n'] += 1; c['tb'] += tb; c['alive'] += bw; c['dead'] += 1 if (tb and mk == 1) else 0; c['red3'] += 1 if not tb else 0
        if 'g' not in ix:
            continue
        g = json.loads(r[ix['g']])
        conf = g['c']
        reds = set(conf[:RED_IDX])
        role_at = {}
        for k, seat in enumerate(conf):
            if seat != '-':
                role_at[seat] = ROLE_OF_C[k]
        merlin = conf[5]
        if tb:
            cands = [x for x in SEATS if x not in reds]
            if unif_pick(seed, i, cands) == merlin:
                s['unif_hit'] += 1
        j = 0
        for k, rd in enumerate(g['r']):
            if rd is None:
                continue
            for pi, (team, yes) in enumerate(rd['p']):
                leader = SEATS[j % 10]
                j += 1
                lrole = role_at.get(leader, 'loyal')
                lr = 'red' if leader in reds else lrole
                others_red = sum(1 for x in team if x in reds and x != leader)
                forced = pi == 4
                tgt = lead_forced if forced else lead
                for key in (lrole, 'red' if leader in reds else 'good'):
                    tgt[key][0] += 1; tgt[key][1] += others_red; tgt[key][2] += 1 if others_red else 0
                if k == 0 and pi == 0:
                    lead11[lrole][0] += 1; lead11[lrole][1] += 1 if leader in team else 0
                if forced:
                    continue
                team_red = any(x in reds for x in team)
                for v in SEATS:
                    if v in team:
                        continue
                    vrole = role_at.get(v, 'loyal')
                    for key in (vrole, 'red' if v in reds else 'good'):
                        if team_red:
                            vote[key][0] += 1; vote[key][1] += 1 if v in yes else 0
                        else:
                            vote[key][2] += 1; vote[key][3] += 1 if v in yes else 0
            if rd.get('m'):
                need = 2 if k == 3 else 1
                rnd[k + 1][0] += 1
                rnd[k + 1][1] += 1 if rd['m'].count('x') < need else 0
    return s, cell, rnd, lead, lead_forced, vote, lead11


def paired(a, b, key):
    common = sorted(set(a) & set(b))
    ds = []
    for k in common:
        ra, ia = a[k]; rb, ib = b[k]
        ds.append(key(rb, ib) - key(ra, ia))
    n = len(ds)
    if n < 2:
        return (n, float('nan'), float('nan'))
    m = sum(ds) / n
    v = sum((x - m) ** 2 for x in ds) / (n - 1)
    h = 1.96 * math.sqrt(v / n)
    return (n, m, h)


def pct(x):
    return f'{100 * x:.2f}%'


def main():
    data = {lab: load(lab) for lab in LABELS}
    out = {}
    for lab, gs in data.items():
        if not gs:
            continue
        s, cell, rnd, lead, leadf, vote, lead11 = summarize(gs)
        n = s['n']
        o = {
            'n': n,
            '任務三藍': s['tb'] / n, '三藍死': s['dead'] / n, '三藍活': s['alive'] / n, '三紅': s['red3'] / n,
            '刺中率': s['dead'] / s['tb'] if s['tb'] else None,
            '均勻刺中率': s['unif_hit'] / s['tb'] if s['tb'] else None,
            '均勻三藍死': s['unif_hit'] / n, '均勻三藍活': (s['tb'] - s['unif_hit']) / n,
            'ci': {k: wilson(s[v], n) for k, v in [('任務三藍', 'tb'), ('三藍死', 'dead'), ('三藍活', 'alive'), ('三紅', 'red3')]},
            'ci_hit': wilson(s['dead'], s['tb']),
            'rounds': {k: (v[1] / v[0], v[0]) for k, v in sorted(rnd.items())},
            'cells': {c: {'n': v['n'], '任務三藍': v['tb'] / v['n'], '三藍死': v['dead'] / v['n'], '三藍活': v['alive'] / v['n'], '三紅': v['red3'] / v['n'],
                          '刺中率': v['dead'] / v['tb'] if v['tb'] else None} for c, v in sorted(cell.items())},
            'lead': {k: (v[1] / v[0], v[2] / v[0], v[0]) for k, v in lead.items() if v[0]},
            'lead_forced': {k: (v[1] / v[0], v[2] / v[0], v[0]) for k, v in leadf.items() if v[0]},
            'vote': {k: (v[1] / v[0] if v[0] else None, v[3] / v[2] if v[2] else None, v[0], v[2]) for k, v in vote.items()},
            'lead11': {k: (v[1] / v[0], v[0]) for k, v in lead11.items() if v[0]},
        }
        if lab != 'BASE' and data['BASE']:
            o['paired'] = {
                '三藍活': paired(data['BASE'], gs, lambda r, ix: r[ix['blueWon']]),
                '任務三藍': paired(data['BASE'], gs, lambda r, ix: r[ix['threeBlue']]),
                '三藍死': paired(data['BASE'], gs, lambda r, ix: 1 if (r[ix['threeBlue']] and r[ix['merlinKilled']] == 1) else 0),
                '同局雜湊相同': paired(data['BASE'], gs, lambda r, ix: hash(r[ix['h']])),
            }
            common = set(data['BASE']) & set(gs)
            o['same_h'] = sum(1 for k in common if data['BASE'][k][0][data['BASE'][k][1]['h']] == gs[k][0][gs[k][1]['h']]) / max(1, len(common))
            del o['paired']['同局雜湊相同']
        out[lab] = o
    js = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
    if js:
        json.dump(out, open(js, 'w'), ensure_ascii=False, indent=1)
    for lab, o in out.items():
        print(f"== {lab} n={o['n']}")
        print('  ' + '  '.join(f"{k} {pct(o[k])}" for k in ['任務三藍', '三藍死', '三藍活', '三紅']) + f"  刺中率 {pct(o['刺中率'])}  均勻刺中率 {pct(o['均勻刺中率'])}")
        print('  rounds ' + '  '.join(f"R{k} {pct(v[0])} (n={v[1]})" for k, v in o['rounds'].items()))
        for c, v in o['cells'].items():
            print(f"  {c} n={v['n']} 任務三藍 {pct(v['任務三藍'])} 三藍死 {pct(v['三藍死'])} 三藍活 {pct(v['三藍活'])} 三紅 {pct(v['三紅'])} 刺中 {pct(v['刺中率'] or 0)}")
        if 'paired' in o:
            print('  paired ' + '  '.join(f"{k} {100 * m:+.2f}pp ±{100 * h:.2f} (n={n})" for k, (n, m, h) in o['paired'].items()) + f"  same_h {pct(o['same_h'])}")
        print('  lead(non-forced) ' + '  '.join(f"{k}: {v[0]:.3f}/{pct(v[1])}" for k, v in sorted(o['lead'].items())))
        print('  lead(forced) ' + '  '.join(f"{k}: {v[0]:.3f}/{pct(v[1])}" for k, v in sorted(o['lead_forced'].items())))
        print('  vote off-team approve red/clean ' + '  '.join(f"{k}: {pct(v[0] or 0)}/{pct(v[1] or 0)}" for k, v in sorted(o['vote'].items())))
        print('  1-1 includes self ' + '  '.join(f"{k}: {pct(v[0])}" for k, v in sorted(o['lead11'].items())))


main()
