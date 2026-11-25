#!/usr/bin/env python3
"""第 81 回合（紅方・提議與投票）：任務三藍多出的那 6 個百分點落在哪幾個任務節點、哪一種提議、哪一種票。

  python3 scripts/missionGapStudy81.py --bot DIR_OR_FILES... [--games games_cache.json] [--json out.json] [--md out.md]

真人局 = games_cache.json 的線瓦／面瓦 10 人局（同 blueStrengthOutcomes.py）；參考組 = 藍方 6 座位、紅方 4 座位開打前 PR 平均都 ≥ 55（兩邊都強）。
機器人局 = selfplay/sp.ts 加 detail=1 的結果（'g' 欄）。兩邊都換成「以第 1 局第 1 個隊長為 1家」的相對座位，隊長每次提議往下一家輪。
真人的隊長：牌譜局從 1 號位輪替；Discord 局用「隊長在自己隊上」覆蓋最多的起點（同 datasetReplay.deriveLeaderStart），推不出來的局只進任務結果、不進隊長那幾欄。
輸出只有合計數字（沒有名字、沒有單局紀錄）。
"""
import json, sys, os, math, argparse, glob
from collections import defaultdict

ROLES = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin']
RED = {'assassin', 'morgana', 'mordred', 'oberon'}
TEAM = [3, 4, 4, 5, 5]
NEED = [1, 1, 1, 2, 1]
SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

def rel_index(c):
    return 10 if c == '0' else int(c)

def norm_game(roles_by_seat, rounds, outcome):
    """roles_by_seat: dict seat(str 1..9,0 rel to first leader)->role; rounds: list of {'p': [[team, approvers, forced]], 'm': 'oox'}"""
    return {'roles': roles_by_seat, 'rounds': rounds, 'outcome': outcome}

def derive_start(teams):
    cover = [sum(1 for k, t in enumerate(teams) if ((s + k) % 10) + 1 in t) for s in range(10)]
    best = max(cover); st = cover.index(best)
    second = max(c for i, c in enumerate(cover) if i != st)
    if best < len(teams) * 0.8 or best - second < 3: return None
    return st + 1

def load_humans(path):
    d = json.load(open(path, encoding='utf-8'))
    F = d['fields']; V = d['vocab']; seats = d['constants']['seats']
    ix = {f: i for i, f in enumerate(F)}
    out = []
    for g in d['games']:
        cat = V['category'][g[ix['cat']]]; oc = V['outcome'][g[ix['outcome']]]
        if cat not in ('線瓦', '面瓦') or oc not in ('三紅', '三藍死', '三藍活'): continue
        cfg = g[ix['config']]
        if len(cfg) != 6 or len(set(cfg)) != 6: continue
        lu = g[ix['lineup']]
        b = r = None
        if lu:
            prs = lu[2]; red = set(cfg[:4])
            bi = [k for k, s in enumerate(seats) if s not in red]; ri = [k for k, s in enumerate(seats) if s in red]
            if len(bi) == 6:
                b = sum(prs[k] for k in bi) / 6; r = sum(prs[k] for k in ri) / 4
        state = V['state'][g[ix['state']]]
        okpath = state != '?' and max(state.count('紅'), state.count('藍')) == 3 and min(state.count('紅'), state.count('藍')) <= 2 \
            and state[-1] == ('紅' if state.count('紅') == 3 else '藍') and (state.count('紅') == 3) == (oc == '三紅')
        base = {'outcome': oc, 'b': b, 'r': r, 'src': 'human', 'path': state if okpath else None, 'rounds': None, 'leaderKnown': False}
        votes = g[ix['votes']] or []
        mcells = (g[ix['missions']] or '').split('|')
        # proposals in order; validate
        ok = True; props = []
        prev = None
        for (rd, at, team, appr) in votes:
            if not all(ch in '1234567890' for ch in team + appr): ok = False; break
            if rd < 1 or rd > 5 or len(team) != TEAM[rd - 1]: ok = False; break
            if prev and not ((prev[0] == rd and at == prev[1] + 1) or (rd == prev[0] + 1 and at == 1)): ok = False; break
            if not prev and not (rd == 1 and at == 1): ok = False; break
            props.append((rd, at, team, appr)); prev = (rd, at)
        if not ok or not props:
            out.append(base); continue
        last_round = props[-1][0]
        rounds = []
        good = True
        for rd in range(1, last_round + 1):
            ps = [p for p in props if p[0] == rd]
            cell = mcells[rd - 1] if rd - 1 < len(mcells) else ''
            if not cell or any(ch not in 'ox' for ch in cell) or len(cell) != len(ps[-1][2]): good = False; break
            rounds.append({'p': [[p[2], p[3] if p[1] < 5 else '', p[1] >= 5] for p in ps], 'm': cell})
        if not good:
            out.append(base); continue
        # result consistency
        f = s = 0
        for k, rr in enumerate(rounds):
            if rr['m'].count('x') >= NEED[k]: f += 1
            else: s += 1
        if (f >= 3) != (oc == '三紅') or max(f, s) < 3:
            out.append(base); continue
        teams = [[(10 if ch == '0' else int(ch)) for ch in p[2]] for p in props]
        src = g[ix['src']]
        start = 1 if src == 0 else derive_start(teams)
        # roles by absolute seat
        roles_abs = {cfg[i]: ROLES[i] for i in range(6)}
        # relabel seats relative to start (start -> '1'); if start unknown keep absolute (leader cols skipped)
        def relab(ch):
            if start is None: return ch
            k = ((rel_index(ch) - start) % 10) + 1
            return '0' if k == 10 else str(k)
        roles = {relab(s_): roles_abs.get(s_, 'loyal') for s_ in SEATS}
        rr2 = [{'p': [[''.join(relab(c) for c in p[0]), ''.join(relab(c) for c in p[1]), p[2]] for p in x['p']], 'm': x['m']} for x in rounds]
        path = ''.join('紅' if x['m'].count('x') >= NEED[k] else '藍' for k, x in enumerate(rounds))
        base.update({'roles': roles, 'rounds': rr2, 'leaderKnown': start is not None, 'path': path})
        out.append(base)
    return out

def load_bots(paths):
    files = []
    for p in paths:
        if os.path.isdir(p): files += sorted(glob.glob(os.path.join(p, '*.json')))
        else: files += sorted(glob.glob(p))
    out = []; seen = set()
    for fp in files:
        d = json.load(open(fp))
        cols = d['cols']; gi = cols.index('g'); ii = cols.index('i'); bw = cols.index('blueWon'); tb = cols.index('threeBlue')
        for row in d['rows']:
            if row[ii] in seen: continue
            seen.add(row[ii])
            g = json.loads(row[gi])
            roles = {s_: 'loyal' for s_ in SEATS}
            for k, ch in enumerate(g['c']):
                if ch != '-': roles[ch] = ROLES[k]
            rounds = [{'p': [[p[0], p[1], p[1] == '' and pi == 4] for pi, p in enumerate(r['p'])], 'm': r['m']} for r in g['r'] if r]
            oc = '三紅' if not row[tb] else ('三藍活' if row[bw] else '三藍死')
            path = ''.join('紅' if x['m'].count('x') >= NEED[k] else '藍' for k, x in enumerate(rounds))
            out.append({'roles': roles, 'rounds': rounds, 'outcome': oc, 'leaderKnown': True, 'src': 'bot', 'i': row[ii], 'path': path})
    return out

def leader_of(gidx):
    k = (gidx % 10) + 1
    return '0' if k == 10 else str(k)

def analyse(games):
    """Returns nested aggregates."""
    A = {}
    n = len(games)
    oc = defaultdict(int)
    for g in games: oc[g['outcome']] += 1
    A['nDetail'] = sum(1 for g in games if g['rounds'])
    A['n'] = n
    A['outcome'] = {k: oc[k] / n for k in ('三紅', '三藍死', '三藍活')}
    A['threeBlue'] = (oc['三藍死'] + oc['三藍活']) / n
    # path nodes
    node = defaultdict(lambda: [0, 0])   # path -> [visits, fails]
    pathEnd = defaultdict(int)
    # per-mission node (by path) details
    D = defaultdict(lambda: defaultdict(float))
    for g in games:
        if g['path']:
            for k in range(len(g['path'])):
                node[g['path'][:k]][0] += 1; node[g['path'][:k]][1] += g['path'][k] == '紅'
            pathEnd[g['path']] += 1
        if not g['rounds']: continue
        path = ''
        gidx = 0
        roles = g['roles']
        for k, r in enumerate(g['rounds']):
            fails = r['m'].count('x') >= NEED[k]
            key = path
            # team went
            team = r['p'][-1][0]
            nred = sum(1 for ch in team if roles[ch] in RED)
            dirty = nred >= NEED[k]
            att = len(r['p'])
            dd = D[key]
            dd['n'] += 1; dd['fail'] += fails; dd['dirty'] += dirty
            dd['failGivenDirty'] += fails if dirty else 0
            dd[f'att{att}'] += 1; dd[f'att{att}_dirty'] += dirty
            # leader of the mission team
            lidx = gidx + att - 1
            if g['leaderKnown']:
                L = leader_of(lidx); lr = roles[L]
                camp = 'R' if lr in RED else 'B'
                dd[f'lead{camp}'] += 1; dd[f'lead{camp}_dirty'] += dirty
                dd[f'leadRole_{lr}'] += 1; dd[f'leadRole_{lr}_dirty'] += dirty
            # all proposals in this round
            for pi, (t, ap, forced) in enumerate(r['p']):
                pr = sum(1 for ch in t if roles[ch] in RED)
                pdirty = pr >= NEED[k]
                passed = (pi == len(r['p']) - 1)
                pre = 'P'
                dd[f'{pre}n'] += 1; dd[f'{pre}dirty'] += pdirty
                if g['leaderKnown']:
                    L = leader_of(gidx + pi); lr = roles[L]; camp = 'R' if lr in RED else 'B'
                    dd[f'{pre}lead{camp}'] += 1; dd[f'{pre}lead{camp}_dirty'] += pdirty
                    dd[f'{pre}leadRole_{lr}'] += 1; dd[f'{pre}leadRole_{lr}_dirty'] += pdirty
                    dd[f'{pre}lead{camp}_att{min(pi+1,5)}'] += 1; dd[f'{pre}lead{camp}_att{min(pi+1,5)}_dirty'] += pdirty
                if forced: 
                    dd['Pforced'] += 1; dd['Pforced_dirty'] += pdirty
                    continue
                # votes
                apset = set(ap); tset = set(t)
                dd[f'Pvoted'] += 1
                key2 = 'D' if pdirty else 'C'
                dd[f'V{key2}n'] += 1; dd[f'V{key2}pass'] += passed
                # red outer white / inner black, blue approvals
                KNOWN = ('assassin', 'morgana', 'mordred')
                for s_ in SEATS:
                    rl = roles[s_]
                    if rl in RED and s_ not in tset:
                        # red off the team: what he can see on the team (recognised reds see each other; Oberon sees nobody)
                        vis = sum(1 for ch in t if roles[ch] in KNOWN) if rl in KNOWN else 0
                        cls = 'known' if rl in KNOWN else 'oberon'
                        sees = 'sees' if vis >= NEED[k] else ('dirty' if pdirty else 'clean')
                        a5 = min(pi + 1, 5)
                        for kk in (f'RO_{cls}_{sees}', f'RO_{cls}_{sees}_att{a5}', f'RO_{rl}_{sees}'):
                            dd[kk + '_n'] += 1; dd[kk + '_yes'] += s_ in apset
                    if rl in RED and s_ in tset:
                        cls = 'known' if rl in ('assassin', 'morgana', 'mordred') else 'oberon'
                        kk = f'RI_{cls}_{"dirty" if pdirty else "clean"}'
                        dd[kk + '_n'] += 1; dd[kk + '_yes'] += s_ in apset
                for s_ in SEATS:
                    rl = roles[s_]; on = s_ in tset; yes = s_ in apset
                    side = 'r' if rl in RED else 'b'
                    pos = 'in' if on else 'out'
                    dd[f'V{key2}_{side}{pos}_n'] += 1; dd[f'V{key2}_{side}{pos}_yes'] += yes
                    if side == 'r':
                        dd[f'V{key2}_{rl}{pos}_n'] += 1; dd[f'V{key2}_{rl}{pos}_yes'] += yes
                    else:
                        r2 = 'merlin' if rl == 'merlin' else ('percival' if rl == 'percival' else 'loyal')
                        dd[f'V{key2}_{r2}{pos}_n'] += 1; dd[f'V{key2}_{r2}{pos}_yes'] += yes
            gidx += len(r['p'])
            path += '紅' if fails else '藍'
    A['node'] = {k: {'n': v[0], 'fail': v[1]} for k, v in node.items()}
    A['D'] = {k: dict(v) for k, v in D.items()}
    A['paths'] = dict(pathEnd)
    return A

def value_fn(A):
    """P(three blue | path node) under these data (empirical); terminal: 3 succ -> 1, 3 fail -> 0."""
    node = A['node']
    memo = {}
    def V(path):
        if path.count('藍') >= 3: return 1.0
        if path.count('紅') >= 3: return 0.0
        if path in memo: return memo[path]
        nd = node.get(path)
        q = nd['fail'] / nd['n'] if nd and nd['n'] else 0.5
        v = q * V(path + '紅') + (1 - q) * V(path + '藍')
        memo[path] = v; return v
    return V

def reach(A, path):
    node = A['node']; p = 1.0; cur = ''
    for ch in path:
        nd = node.get(cur)
        if not nd or not nd['n']: return 0.0
        q = nd['fail'] / nd['n']
        p *= q if ch == '紅' else 1 - q
        cur += ch
    return p

def pdl(H, B):
    """performance-difference decomposition of P_B(3藍) − P_H(3藍): Σ_n reach_H(n) × (q_H(n) − q_B(n)) × (V_B(n藍) − V_B(n紅))."""
    VB = value_fn(B)
    out = {}
    for path in H['node']:
        if path not in B['node']: continue
        qh = H['node'][path]['fail'] / H['node'][path]['n']
        qb = B['node'][path]['fail'] / B['node'][path]['n']
        out[path] = reach(H, path) * (qh - qb) * (VB(path + '藍') - VB(path + '紅'))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bot', nargs='*', default=[])
    ap.add_argument('--games', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'games_cache.json'))
    ap.add_argument('--json')
    ap.add_argument('--thr', type=float, default=55)
    a = ap.parse_args()
    hum = load_humans(a.games)
    strong = [g for g in hum if g['b'] is not None and g['b'] >= a.thr and g['r'] >= a.thr]
    res = {'humanAll': analyse(hum), 'humanStrong': analyse(strong)}
    res['humanStrongLeaderKnown'] = sum(1 for g in strong if g['leaderKnown'])
    res['humanAllLeaderKnown'] = sum(1 for g in hum if g['leaderKnown'])
    if a.bot:
        bots = load_bots(a.bot)
        res['bot'] = analyse(bots)
        res['pdl_strong'] = pdl(res['humanStrong'], res['bot'])
        res['pdl_all'] = pdl(res['humanAll'], res['bot'])
        res['pdlScore_strong'] = pdl_by_score(res['pdl_strong'])
        res['pdlScore_all'] = pdl_by_score(res['pdl_all'])
        ci, tci = bootstrap_pdl(strong, res['bot'])
        res['pdlScore_strong_ci'] = ci; res['pdl_strong_total_ci'] = tci
        res['treeThreeBlue'] = {'humanStrong': value_fn(res['humanStrong'])(''), 'humanAll': value_fn(res['humanAll'])(''), 'bot': value_fn(res['bot'])('')}
    s = json.dumps(res, ensure_ascii=False)
    if a.json: open(a.json, 'w').write(s)
    for k in ('humanAll', 'humanStrong', 'bot'):
        if k in res: print(k, res[k]['n'], {x: round(100 * y, 1) for x, y in res[k]['outcome'].items()}, 'threeBlue', round(100 * res[k]['threeBlue'], 1))
    print('leaderKnown strong', res['humanStrongLeaderKnown'], 'all', res['humanAllLeaderKnown'])
    if 'pdl_strong' in res:
        tot = sum(res['pdl_strong'].values())
        print('PDL strong total', round(100 * tot, 2), 'actual', round(100 * (res['bot']['threeBlue'] - res['humanStrong']['threeBlue']), 2))
        print('tree 3藍', {k: round(100 * v, 2) for k, v in res['treeThreeBlue'].items()}, 'total CI', [round(100 * x, 2) for x in res['pdl_strong_total_ci']])
        for p, v in sorted(res['pdlScore_strong'].items(), key=lambda x: -abs(x[1])):
            lo, hi = res['pdlScore_strong_ci'].get(p, (0, 0))
            print(' ', p, round(100 * v, 2), f'[{100*lo:.2f}, {100*hi:.2f}]', 'all-human', round(100 * res['pdlScore_all'].get(p, 0), 2))


# ---------- report helpers ----------
def score_of(path):
    """mission node by round and score: 'R3 1:1' (blue:red)."""
    return f"R{len(path) + 1} {path.count('藍')}:{path.count('紅')}"

def agg_by_score(D):
    out = defaultdict(lambda: defaultdict(float))
    for p, d in D.items():
        for k, v in d.items(): out[score_of(p)][k] += v
    return out

def pdl_by_score(contrib):
    out = defaultdict(float)
    for p, v in contrib.items(): out[score_of(p)] += v
    return out

def bootstrap_pdl(strong, B, reps=400, seed=81):
    import random
    rnd = random.Random(seed)
    valid = [g for g in strong if g['path']]
    acc = defaultdict(list); tot = []
    for _ in range(reps):
        sm = [valid[rnd.randrange(len(valid))] for _ in valid]
        H = {'node': defaultdict(lambda: {'n': 0, 'fail': 0})}
        for g in sm:
            for k in range(len(g['path'])):
                nd = H['node'][g['path'][:k]]; nd['n'] += 1; nd['fail'] += g['path'][k] == '紅'
        H['node'] = dict(H['node'])
        c = pdl_by_score(pdl(H, B))
        for k, v in c.items(): acc[k].append(v)
        tot.append(sum(c.values()))
    def ci(xs):
        xs = sorted(xs); return (xs[int(0.025 * len(xs))], xs[int(0.975 * len(xs)) - 1])
    return {k: ci(v) for k, v in acc.items()}, ci(tot)

if __name__ == '__main__':
    main()
