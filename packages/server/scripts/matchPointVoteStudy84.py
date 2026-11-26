#!/usr/bin/env python3
"""第 84 回合（藍紅雙方・紅方聽牌時的內黑／外白）：站長 2026-11-26 的四種情況，在兩邊都強的真人局、全部真人局與機器人局各量一次。

  python3 scripts/matchPointVoteStudy84.py --bot DIR_OR_FILES... [--arm NAME=DIR ...] [--json out.json] [--md out.md]

紅方聽牌 = 紅方已兩勝、藍方還沒三勝的那一局（第 3 局 0:2、第 4 局 1:2、第 5 局 2:2），只看非強制的提議（第 1–4 次）。
四種情況（站長原話的四句）：
  B1 藍方「該局要提前出任務（後方都是紅方）並且隊伍是全好 就應該開外白」：藍方不在隊上、隊上沒有紅 → 投白的比例；
     分「這一次之後到強制局的隊長全是紅」與否。
  B2 藍方「自己被選到 隊伍有紅方的時候 要識情況內黑」：藍方在隊上（不是隊長）、隊上的紅夠讓任務失敗 → 投白（沒內黑）的比例；
     隊上沒有紅時投黑（內黑打錯人）的比例；同樣分「之後的隊長全是紅」與否。
  R1 紅方「判斷該局輪到尾派非常有可能派出全好」：相認紅不在隊上、看得到的隊友夠讓任務失敗 → 投白的比例，分強制局的隊長是藍／紅。
  R2 紅方「隊友進任務 有可能六白衝出去」：同一批票，分「這一票以外的白票」幾張（≥ 6 = 不用他也過、5 = 他的白票剛好決定、≤ 4 = 他投白也不過）。
每一種都附「接下來」：這個提議通過的比例、這一局任務失敗（＝紅方贏下任務）的比例、這些票所在的局的三種結果。
真人局、相對座位與隊長的推法沿用 missionGapStudy81.py（第 1 局第 1 個隊長 = 1家）；推不出隊長的真人局不進「之後的隊長」那幾欄。
輸出只有合計數字（沒有名字、沒有單局紀錄）。
"""
import json, os, sys, math, argparse
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from missionGapStudy81 import load_humans, load_bots, leader_of, RED, NEED  # noqa: E402

KNOWN = ('assassin', 'morgana', 'mordred')
OUTS = ('三紅', '三藍死', '三藍活')


def wilson(k, n):
    if n == 0: return (0.0, 0.0)
    z = 1.96; p = k / n
    d = 1 + z * z / n; c = p + z * z / (2 * n); h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


class Acc:
    """一個格子：n 票、投白幾票；投白／投黑各自之後的提議通過、任務失敗、局的結果。"""
    def __init__(self):
        self.n = 0; self.yes = 0
        self.after = {True: defaultdict(int), False: defaultdict(int)}

    def add(self, yes, passed, mfail, outcome):
        self.n += 1; self.yes += yes
        a = self.after[bool(yes)]
        a['n'] += 1; a['pass'] += passed; a['mfail'] += mfail; a[outcome] += 1

    def js(self):
        lo, hi = wilson(self.yes, self.n)
        return {'n': self.n, 'yes': self.yes, 'rate': self.yes / self.n if self.n else None, 'lo': lo, 'hi': hi,
                'after': {('yes' if k else 'no'): dict(v) for k, v in self.after.items()}}


def analyse(games):
    C = defaultdict(Acc)
    cell = defaultdict(lambda: defaultdict(int))
    games_mp = defaultdict(int)
    for g in games:
        if not g['rounds']: continue
        roles = g['roles']; gidx = 0; path = ''
        reached = False
        for k, r in enumerate(g['rounds']):
            fails = r['m'].count('x') >= NEED[k]
            mp = path.count('紅') == 2 and path.count('藍') <= 2
            if mp and g['leaderKnown']:
                reached = True
                sc = f"R{k + 1} {path.count('藍')}:{path.count('紅')}"
                cc = cell[sc]
                cc['n'] += 1; cc['fail'] += fails; cc['forced'] += len(r['p']) >= 5
                ft = r['p'][-1][0]
                if len(r['p']) >= 5:
                    L5 = leader_of(gidx + 4)
                    cc['forcedLeadR'] += roles[L5] in RED
                    cc['forcedDirty'] += sum(1 for ch in ft if roles[ch] in RED) >= NEED[k]
                tailL = leader_of(gidx + 4)
                cc['tailR'] += roles[tailL] in RED
                for pi, (t, ap, forced) in enumerate(r['p']):
                    if forced or pi >= 4: continue
                    passed = pi == len(r['p']) - 1
                    tset = set(t); apset = set(ap)
                    nred = sum(1 for ch in t if roles[ch] in RED)
                    dirty = nred >= NEED[k]; clean = nred == 0
                    L = leader_of(gidx + pi)
                    later = [leader_of(gidx + j) for j in range(pi + 1, 5)]
                    laterRed = all(roles[x] in RED for x in later)
                    laterBlue = [x for x in later if roles[x] not in RED]
                    tail = later[-1]
                    tailRed = roles[tail] in RED
                    oc = g['outcome']; a5 = pi + 1
                    for s in tset | set(roles):
                        rl = roles[s]
                        if s == L: continue
                        on = s in tset; yes = s in apset
                        if rl not in RED:
                            role3 = rl if rl in ('merlin', 'percival') else 'loyal'
                            if not on and clean:
                                for key in ('B1', f'B1_later{"R" if laterRed else "B"}', f'B1_{role3}', f'B1_att{a5}', f'B1_{sc}',
                                            f'B1_later{"R" if laterRed else "B"}_{role3}', f'B1_{sc}_later{"R" if laterRed else "B"}'):
                                    C[key].add(yes, passed, fails, oc)
                            if not on and dirty:
                                C['B1x_dirtyOff'].add(yes, passed, fails, oc)
                                C[f'B1x_dirtyOff_{role3}'].add(yes, passed, fails, oc)
                            if on and dirty:
                                for key in ('B2', f'B2_later{"R" if laterRed else "B"}', f'B2_{role3}', f'B2_att{a5}', f'B2_{sc}', f'B2_{sc}_later{"R" if laterRed else "B"}'):
                                    C[key].add(yes, passed, fails, oc)
                            if on and clean:
                                for key in ('B2c', f'B2c_later{"R" if laterRed else "B"}', f'B2c_{role3}', f'B2c_att{a5}'):
                                    C[key].add(yes, passed, fails, oc)
                        else:
                            if on: continue
                            if rl in KNOWN:
                                vis = sum(1 for ch in t if roles[ch] in KNOWN)
                                if vis >= NEED[k]:
                                    others = sum(1 for x in apset if x != s)
                                    bucket = 'ge6' if others >= 6 else ('eq5' if others == 5 else 'le4')
                                    for key in ('R', f'R1_tail{"R" if tailRed else "B"}', f'R1_tail{"R" if tailRed else "B"}_att{a5}', f'R_att{a5}', f'R_{sc}',
                                                f'R2_{bucket}', f'R2_{bucket}_att{a5}', f'R_{rl}', f'R1_laterBlue{min(len(laterBlue), 2)}', f'R1_{sc}_tail{"R" if tailRed else "B"}', f'R2_{sc}_{bucket}'):
                                        C[key].add(yes, passed, fails, oc)
                                else:
                                    C['Rx_noTeammate' + ('_dirty' if dirty else '_clean')].add(yes, passed, fails, oc)
                            else:
                                C['Ro_' + ('dirty' if dirty else 'clean')].add(yes, passed, fails, oc)
            gidx += len(r['p'])
            path += '紅' if fails else '藍'
        if reached:
            games_mp['n'] += 1; games_mp[g['outcome']] += 1
    return {'cells': {k: v.js() for k, v in C.items()}, 'mpCells': {k: dict(v) for k, v in cell.items()}, 'gamesMp': dict(games_mp),
            'n': len(games), 'outcome': {o: sum(1 for g in games if g['outcome'] == o) / len(games) for o in OUTS}}


def fmt(c, key):
    x = c.get(key)
    if not x or not x['n']: return '—'
    return f"{100 * x['rate']:.1f}（{x['n']}）"


def after_fmt(c, key, side):
    x = c.get(key)
    if not x: return '—'
    a = x['after'].get(side, {})
    n = a.get('n', 0)
    if not n: return '—'
    return f"通過 {100 * a.get('pass', 0) / n:.0f}／任務失敗 {100 * a.get('mfail', 0) / n:.0f}／" + '／'.join(f"{100 * a.get(o, 0) / n:.0f}" for o in OUTS)


ROWS = [
    ('B1 藍方不在隊上、隊上沒有紅 → 投白', 'B1'),
    ('　之後到強制局的隊長全是紅', 'B1_laterR'),
    ('　之後還有藍隊長', 'B1_laterB'),
    ('　忠臣／派西／梅林', None),
    ('　第 1／2／3／4 次提議', None),
    ('（對照）藍方不在隊上、隊上的紅夠失敗 → 投白', 'B1x_dirtyOff'),
    ('B2 藍方在隊上、隊上的紅夠失敗 → 投白（沒內黑）', 'B2'),
    ('　之後的隊長全是紅', 'B2_laterR'),
    ('　之後還有藍隊長', 'B2_laterB'),
    ('（對照）藍方在隊上、隊上沒有紅 → 投白（1 − 打錯的內黑）', 'B2c'),
    ('　之後的隊長全是紅', 'B2c_laterR'),
    ('R1 相認紅不在隊上、看得到隊友夠失敗 → 投白', 'R'),
    ('　強制局的隊長是藍', 'R1_tailB'),
    ('　強制局的隊長是紅', 'R1_tailR'),
    ('　之後的隊長沒有藍／一個藍／兩個以上', None),
    ('R2 同上，這一票以外的白票 ≥ 6（不用他也過）', 'R2_ge6'),
    ('　= 5（他的白票剛好決定）', 'R2_eq5'),
    ('　≤ 4（他投白也不過）', 'R2_le4'),
    ('　第 1／2／3／4 次提議', None),
    ('（對照）相認紅不在隊上、看不到夠多隊友、隊其實夠失敗 → 投白', 'Rx_noTeammate_dirty'),
    ('（對照）奧伯倫不在隊上、隊夠失敗／不夠 → 投白', None),
]


def md_report(res, srcs):
    L = []
    L.append('## 1. 紅方聽牌那一局（非強制提議才有票）\n')
    L.append('| 格 | ' + ' | '.join(l for l, _ in srcs) + ' |')
    L.append('|---|' + '---|' * len(srcs))
    for sc in ('R3 0:2', 'R4 1:2', 'R5 2:2'):
        def cellstr(A):
            c = A['mpCells'].get(sc)
            if not c: return '—'
            n = c['n']
            return f"{n} 局；任務失敗 {100 * c['fail'] / n:.1f}%、拖到強制局 {100 * c['forced'] / n:.1f}%（強制局的隊長紅 {100 * c['forcedLeadR'] / max(1, c['forced']):.0f}%、隊夠失敗 {100 * c['forcedDirty'] / max(1, c['forced']):.0f}%）"
        L.append(f'| {sc} | ' + ' | '.join(cellstr(res[k]) for _, k in srcs) + ' |')
    L.append('')
    L.append('走到紅方聽牌的局，三種結果（三紅／三藍死／三藍活 %）：' + '；'.join(
        f"{lab} {res[k]['gamesMp'].get('n', 0)} 局 " + '／'.join(f"{100 * res[k]['gamesMp'].get(o, 0) / max(1, res[k]['gamesMp'].get('n', 0)):.1f}" for o in OUTS) for lab, k in srcs) + '\n')
    L.append('## 2. 四種情況的比例（%，括號 = 票數）\n')
    L.append('| 情況 | ' + ' | '.join(l for l, _ in srcs) + ' |')
    L.append('|---|' + '---|' * len(srcs))
    for lab, key in ROWS:
        if key is not None:
            L.append(f'| {lab} | ' + ' | '.join(fmt(res[k]['cells'], key) for _, k in srcs) + ' |')
            continue
        if '忠臣' in lab:
            parts = ['B1_loyal', 'B1_percival', 'B1_merlin']
        elif '沒有藍' in lab:
            parts = ['R1_laterBlue0', 'R1_laterBlue1', 'R1_laterBlue2']
        elif '奧伯倫' in lab:
            parts = ['Ro_dirty', 'Ro_clean']
        elif lab.startswith('　第') and L and 'R2' in ''.join(L[-4:]):
            parts = ['R_att1', 'R_att2', 'R_att3', 'R_att4']
        else:
            parts = ['B1_att1', 'B1_att2', 'B1_att3', 'B1_att4']
        L.append(f'| {lab} | ' + ' | '.join('／'.join(fmt(res[k]['cells'], p) for p in parts) for _, k in srcs) + ' |')
    L.append('')
    L.append('## 3. 接下來（投白／投黑之後：這個提議通過 %／這一局任務失敗 %／那一局三紅／三藍死／三藍活 %）\n')
    L.append('| 情況 | 票 | ' + ' | '.join(l for l, _ in srcs) + ' |')
    L.append('|---|---|' + '---|' * len(srcs))
    for lab, key in (('B1 不在隊上、隊上沒有紅', 'B1'), ('B1 之後的隊長全是紅', 'B1_laterR'), ('B2 在隊上、隊上的紅夠失敗', 'B2'),
                     ('R1 強制局的隊長是藍', 'R1_tailB'), ('R2 他的白票剛好決定', 'R2_eq5'), ('R2 不用他也過', 'R2_ge6')):
        for side, zh in (('yes', '投白'), ('no', '投黑')):
            L.append(f'| {lab} | {zh} | ' + ' | '.join(after_fmt(res[k]['cells'], key, side) for _, k in srcs) + ' |')
    L.append('')
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bot', nargs='*', default=[])
    ap.add_argument('--arm', action='append', default=[])
    ap.add_argument('--games', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'games_cache.json'))
    ap.add_argument('--thr', type=float, default=55)
    ap.add_argument('--json'); ap.add_argument('--md')
    a = ap.parse_args()
    hum = load_humans(a.games)
    strong = [g for g in hum if g['b'] is not None and g['b'] >= a.thr and g['r'] >= a.thr]
    res = {'humanStrong': analyse(strong), 'humanAll': analyse(hum)}
    srcs = [('兩邊都強的真人', 'humanStrong'), ('全部真人', 'humanAll')]
    if a.bot:
        res['bot'] = analyse(load_bots(a.bot)); srcs.append(('機器人（基準線）', 'bot'))
    for spec in a.arm:
        name, d = spec.split('=', 1)
        res[name] = analyse(load_bots([d])); srcs.append((name, name))
    if a.md: open(a.md, 'w').write(md_report(res, srcs))
    if a.json: open(a.json, 'w').write(json.dumps(res, ensure_ascii=False))
    for lab, k in srcs:
        c = res[k]['cells']
        print(lab, {key: (round(100 * c[key]['rate'], 1), c[key]['n']) for key in ('B1', 'B1_laterR', 'B2', 'B2c', 'R', 'R1_tailB', 'R2_eq5', 'R2_ge6', 'R_att4') if key in c and c[key]['n']})


if __name__ == '__main__':
    main()
