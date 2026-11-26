#!/usr/bin/env python3
"""Round 87 (blue / Merlin): "Merlin inner-blacks on a team while the loyal / Percival members on it approve" (rounds 59 / 63, Gemini
handoff v2 item 1 `merlinInnerBlackShield`) — re-measured on self-play games (`sp.ts --flag detail=1`).

Event (round 63 definition): an R3+ non-forced proposal, Merlin on the team and not its leader, Merlin rejects, and another blue seat
(loyal / Percival) on the team approves. `--strict` variants count only non-leader blue approvers.
Per arm: three outcomes (three red / three blue, Merlin killed / three blue, Merlin lives), mission three-blue, hit rate, the share of
three-blue games with the event and the hit rate with / without it, the events split by Merlin's sight (fatal = red has two fails and a
red he sees is on it, or R4 with two seen reds; seen = a red he sees on it but not fatal; clean = no red he sees on it), and — given a
paired control on the same seeds — the paired blue win-rate difference with a game-level bootstrap.

Input: the sp.ts chunk files (JSON {meta, cols, rows}); seats are relative to the 1-1 leader (1..9, 0 = the 10th); the leader of the
k-th proposal of the game (0-based) is seat (k mod 10) + 1. Output: only aggregate counts and rates (no game records).

  python3 scripts/merlinShieldStudy87.py --arm BASE=dir/BASE --arm S5=dir/S5 [--base BASE] [--md]
"""
import argparse
import glob
import json
import os
import random
import sys

ROLES = ['assassin', 'morgana', 'mordred', 'oberon', 'percival', 'merlin']
SEATS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']


def load(path):
    files = sorted(glob.glob(os.path.join(path, '*.json'))) if os.path.isdir(path) else [path]
    games = {}
    for f in files:
        d = json.load(open(f))
        cols = d['cols']
        ci = {c: k for k, c in enumerate(cols)}
        for row in d['rows']:
            g = json.loads(row[ci['g']])
            games[row[ci['i']]] = {
                'blueWon': row[ci['blueWon']], 'threeBlue': row[ci['threeBlue']], 'killed': row[ci['merlinKilled']],
                'h': row[ci['h']], 'g': g,
            }
    return games


def game_events(rec):
    g = rec['g']
    c = g['c']
    role = {}
    for r, s in zip(ROLES, c):
        if s != '-':
            role[s] = r
    for s in SEATS:
        role.setdefault(s, 'loyal')
    merlin = c[5]
    red = {s for s in SEATS if role[s] in ('assassin', 'morgana', 'mordred', 'oberon')}
    seen = {s for s in red if role[s] != 'mordred'}
    blue = {s for s in SEATS if role[s] in ('loyal', 'percival')}
    k = 0
    fails = 0
    out = []  # (round, kind, strict, leader_is_blue_approver_only)
    mission_wins = 0
    for ri, rd in enumerate(g['r']):
        if rd is None:
            continue
        rnd = ri + 1
        for pi, (team, yes) in enumerate(rd['p']):
            leader = rd['L'][pi] if 'L' in rd else SEATS[k % 10]
            k += 1
            forced = (pi in rd['F']) if 'F' in rd else pi >= 4
            if forced or merlin not in team or merlin == leader:
                continue
            if merlin in yes:
                continue
            others = [s for s in team if s in blue and s in yes]
            if not others:
                continue
            strict = any(s != leader for s in others)
            n_seen = sum(1 for s in team if s in seen)
            two_fail = rnd == 4
            if (fails >= 2 and n_seen >= 1) or (two_fail and n_seen >= 2):
                kind = 'fatal'
            elif n_seen >= 1:
                kind = 'seen'
            else:
                kind = 'clean'
            out.append((rnd, kind, strict))
        m = rd.get('m', '')
        if m:
            nf = m.count('x')
            need = 2 if rnd == 4 else 1
            if nf >= need:
                fails += 1
            else:
                mission_wins += 1
    return out


def load_human(path):
    """`keySpotStudy.ts --export-human` rows → the same shape as the self-play games (seats 1..10 → '1'..'9','0')."""
    games = {}
    for line in open(path, encoding='utf8'):
        if not line.strip():
            continue
        h = json.loads(line)
        if h.get('out') not in ('red3', 'blueDead', 'blueAlive'):
            continue
        sc = lambda s: '0' if s == 10 else str(s)
        roles = h['roles']
        c = ''.join((sc(roles.index(r) + 1) if r in roles else '-') for r in ROLES)
        rounds = []
        for p in h['props']:
            rnd, att, leader, team, yes, forced = p[0], p[1], p[2], p[3], p[4], p[5]
            while len(rounds) < rnd:
                rounds.append({'p': [], 'm': '', 'L': []})
            rounds[rnd - 1]['p'].append([''.join(sc(s) for s in team), '' if forced or yes is None else ''.join(sc(s) for s in yes)])
            rounds[rnd - 1]['L'].append(sc(leader))
            if forced:
                rounds[rnd - 1].setdefault('F', set()).add(len(rounds[rnd - 1]['p']) - 1)
        for q in h['quests']:
            rnd, team, nf = q[0], q[1], q[2]
            if rnd <= len(rounds):
                rounds[rnd - 1]['m'] = 'o' * (len(team) - nf) + 'x' * nf
        out = h['out']
        games[h['gi']] = {'blueWon': 1 if out == 'blueAlive' else 0, 'threeBlue': 0 if out == 'red3' else 1,
                          'killed': 1 if out == 'blueDead' else (0 if out == 'blueAlive' else -1), 'h': '', 's': h.get('s'),
                          'g': {'c': c, 'r': rounds}}
    return games


def summarize(games, label):
    n = len(games)
    tb = [i for i, r in games.items() if r['threeBlue'] == 1]
    killed = sum(1 for i in tb if games[i]['killed'] == 1)
    red3 = n - len(tb)
    res = {'label': label, 'n': n, 'red3': 100 * red3 / n, 'blueDead': 100 * killed / n,
           'blueAlive': 100 * (len(tb) - killed) / n, 'mission3': 100 * len(tb) / n, 'hit': 100 * killed / max(1, len(tb))}
    for name, filt in [('E', lambda ev: ev[0] >= 3), ('Es', lambda ev: ev[0] >= 3 and ev[2]),
                       ('E12', lambda ev: ev[0] <= 2), ('Ef', lambda ev: ev[0] >= 3 and ev[1] == 'fatal'),
                       ('Ese', lambda ev: ev[0] >= 3 and ev[1] == 'seen'), ('Ec', lambda ev: ev[0] >= 3 and ev[1] == 'clean'),
                       ('E4', lambda ev: ev[0] == 4), ('Enf', lambda ev: ev[0] >= 3 and ev[1] != 'fatal')]:
        with_ev = [i for i in tb if any(filt(ev) for ev in games[i]['ev'])]
        wo = [i for i in tb if i not in set(with_ev)]
        hk = sum(1 for i in with_ev if games[i]['killed'] == 1)
        nk = sum(1 for i in wo if games[i]['killed'] == 1)
        res[name] = (100 * len(with_ev) / max(1, len(tb)), 100 * hk / max(1, len(with_ev)), 100 * nk / max(1, len(wo)), len(with_ev))
    # event counts per kind (all R3+ events, not games)
    kinds = {}
    for i, r in games.items():
        for ev in r['ev']:
            if ev[0] >= 3:
                kinds[(ev[0], ev[1])] = kinds.get((ev[0], ev[1]), 0) + 1
    res['kinds'] = kinds
    return res


def paired(base, arm, key, reps=2000, seed=87):
    ids = sorted(set(base) & set(arm))
    d = [arm[i][key] - base[i][key] for i in ids]
    m = sum(d) / len(d)
    rnd = random.Random(seed)
    bs = []
    for _ in range(reps):
        s = 0
        for _ in range(len(d)):
            s += d[rnd.randrange(len(d))]
        bs.append(s / len(d))
    bs.sort()
    same = sum(1 for i in ids if arm[i]['h'] == base[i]['h'])
    return 100 * m, 100 * bs[int(0.025 * reps)], 100 * bs[int(0.975 * reps)], 100 * same / len(ids), len(ids)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', action='append', default=[], help='NAME=path (a chunk dir or a file)')
    ap.add_argument('--base', default=None, help='the paired control arm name')
    ap.add_argument('--fill', action='append', default=[], help='NAME=BASENAME: games missing in NAME (only= runs) are taken from BASENAME')
    ap.add_argument('--reps', type=int, default=2000)
    ap.add_argument('--human', help='keySpotStudy.ts --export-human rows (games_cache strict replay)')
    ap.add_argument('--flags', help='strong-human-Merlin flags (game index → numbers; made from player ids, never in the repo)')
    ap.add_argument('--strong-n', type=int, default=4)
    ap.add_argument('--strong-surv', type=float, default=0.6)
    args = ap.parse_args()
    arms = {}
    if args.human:
        hum = load_human(args.human)
        arms['真人局：全部'] = hum
        arms['真人局：高端桌 S ≥ 55'] = {i: r for i, r in hum.items() if r.get('s') is not None and r['s'] >= 55}
        if args.flags:
            fl = json.load(open(args.flags))

            def strong(i):
                f = fl.get(str(i))
                return bool(f and f.get('surv') is not None and f['n3'] >= args.strong_n and f['surv'] >= args.strong_surv
                            and f.get('ex') is not None and f['ex'] >= 0)
            arms['真人局：強的真人梅林'] = {i: r for i, r in hum.items() if strong(i)}
            arms['真人局：其他真人梅林'] = {i: r for i, r in hum.items() if not strong(i)}
    for a in args.arm:
        name, path = a.split('=', 1)
        arms[name] = load(path)
    for f in args.fill:
        name, src = f.split('=', 1)
        for i, r in arms[src].items():
            arms[name].setdefault(i, r)
    for name, games in arms.items():
        for r in games.values():
            r['ev'] = game_events(r)
    print('| 組 | 局數 | 三紅 % | 三藍死 % | 三藍活 % | 任務三藍 % | 刺中率 % | 事件局占三藍局 %（局數） | 有事件：刺中 % | 沒事件：刺中 % | 只算非隊長的藍方贊成：占比／有／沒 | 藍方勝率差 [95%] | 任務三藍差 [95%] | 逐局相同 % |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    sums = {}
    for name, games in arms.items():
        s = summarize(games, name)
        sums[name] = s
        diff = '—'
        dm = '—'
        same = '—'
        if args.base and name != args.base and args.base in arms:
            m, lo, hi, sm, _ = paired(arms[args.base], games, 'blueWon', args.reps)
            m2, lo2, hi2, _, _ = paired(arms[args.base], games, 'threeBlue', args.reps)
            diff = f'{m:+.2f} [{lo:+.2f}, {hi:+.2f}]'
            dm = f'{m2:+.2f} [{lo2:+.2f}, {hi2:+.2f}]'
            same = f'{sm:.1f}'
        E = s['E']
        Es = s['Es']
        print(f"| {name} | {s['n']:,} | {s['red3']:.1f} | {s['blueDead']:.1f} | {s['blueAlive']:.1f} | {s['mission3']:.1f} | {s['hit']:.1f} | "
              f"{E[0]:.1f}（{E[3]}） | {E[1]:.1f} | {E[2]:.1f} | {Es[0]:.1f}／{Es[1]:.1f}／{Es[2]:.1f} | {diff} | {dm} | {same} |")
    print()
    print('| 組 | 致命（紅方兩勝＋看得到的紅、第 4 局兩個看得到的紅）：占比／有／沒 | 有看得到的紅、不致命 | 沒有看得到的紅 | 第 4 局 | 不算致命的全部 | 參考：第 1、2 局 |')
    print('|---|---|---|---|---|---|---|')
    for name, s in sums.items():
        f = lambda k: f"{s[k][0]:.1f}／{s[k][1]:.1f}／{s[k][2]:.1f}"
        print(f"| {name} | {f('Ef')} | {f('Ese')} | {f('Ec')} | {f('E4')} | {f('Enf')} | {f('E12')} |")
    print()
    print('事件數（第 3 局起，全部局；局、種類）：')
    for name, s in sums.items():
        ks = sorted(s['kinds'].items())
        print(f"- {name}: " + '、'.join(f"R{r} {k} {v}" for (r, k), v in ks))


if __name__ == '__main__':
    main()
