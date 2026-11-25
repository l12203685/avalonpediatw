#!/usr/bin/env python3
"""第 75 回合（紅方・刺客）：用「派西維爾－梅林」世界線找梅林。

站長 2026-11-25：真人刺中率比較高，是因為四個紅方的視角會綜合考慮；莫甘娜會被派西維爾看到，所以可以從這點反推
可能的派西維爾位置，進而推出「誰是派西維爾、誰是梅林」的世界線存在的可能性與合理性。

世界線 = 有序的一對（派西維爾 = X、梅林 = Y），6 個藍方座位裡共 30 條，剩下 4 個是忠臣。刺殺時紅方開牌，
誰是刺客／莫甘娜／莫德雷德／奧伯倫都知道。每條世界線的分數 = 每個藍方座位「照這條世界線給他的角色」做出他實際做過的事的
對數概似，減掉「不分角色的藍方」做同一件事的對數概似，分九個分量（角色 P 派西／M 梅林／L 忠臣 × 動作 k 派隊／v 票／l 湖）：

  - 派隊（每一次提議、隊上每一個其他座位各一個二元事件「有沒有被放上隊」）：隊長的角色 × 被放的人的角色。
    派西維爾對梅林那一格再分「莫甘娜在不在這一隊」（兩根拇指只放一根）、對莫甘娜那一格分「莫甘娜曝光了沒」。
  - 票（非強制、票可靠、不是隊長自己）：投票者的角色 × 他照這條世界線看得到的東西
    （派西維爾：兩根拇指各自在不在隊上、隊長是哪一根拇指；梅林：隊上幾個他看得到的紅、莫德雷德在不在；忠臣：梅林／派西在不在隊上）。
  - 湖：持湖者的角色 × 他湖了哪一類人。

每一格的比例用真人局擬合（`--human` 全部的局，不只刺殺點）。交叉擬合：偶數號的局擬合 → 奇數號的刺殺點，反過來也一樣；
九個分量的疊加權重在擬合的那一半裡再切兩份，用另一份的表算分數，不會看到自己的局。模型的格在看驗證結果之前就定好。

輸入只有座位、角色、隊伍、票、任務牌、湖、刺殺與分數，沒有玩家名。

  python3 scripts/worldLineStudy75.py --human h.jsonl --base hA_A.jsonl [--alt H=hA_H.jsonl] --part eval|ablate|views|export|cells
    eval    刺中率：真人、現行、只用世界線、世界線＋現行的分層、現行分數＋世界線；分任務順序、強度層、兩半；派西維爾的診斷
    ablate  九個分量拿掉／只留一個
    views   四個紅方的視角各帶多少：不知道誰是莫甘娜／莫德雷德、不知道誰是奧伯倫、只有梅林（不推派西維爾）
    export  給 TypeScript 的表（--out DIR：worldLines75_full／even／odd.json）
    cells   正式的表（--tables）裡幾個主要的格，給文件用
    bot     自我對打：同一份整局紀錄上重算的刺殺（--base 現行、--cand 候選；`assassinPathStudy.ts --export-bot`），逐局配對
    patch   把重算的刺殺目標寫回自我對打結果檔（--src DIR --src-prefix P --cand X.jsonl --out DIR --out-prefix Q），給 `bot:gap` 量第 1F 節
    botparts 自我對打的整局紀錄（--bot b.jsonl，`keySpotStudy.ts --export-bot`）上，用全部真人局擬合的表：九個分量拿掉／只留一個時
            只用世界線的刺中率（機器人的梅林／派西維爾露在哪一個分量；不分層）
    merge   交叉擬合的兩份輸出照局號合成一份（--even-tables-file 用偶數號擬合的表跑的、--odd-tables-file 用奇數號擬合的表跑的 → --out FILE；
            每一局取「沒有看過它的那張表」的那一列；刺殺點的 jsonl 與 `humanPrBenchmark.ts --dump` 都可以）
"""
import argparse
import json
import math
import os
from collections import defaultdict
from itertools import permutations

import numpy as np

RED_ROLES = ('assassin', 'morgana', 'mordred', 'oberon')
KAPPA = 10.0
PROCS = int(os.environ.get('WL75_PROCS', '2'))
FOLD_PERCIVAL = False  # True = 只有梅林的模型（派西當成忠臣；世界線只剩 6 條）
ALT_SPLIT = False  # True = 換一種切法檢查（外層用序號除以 2 的奇偶，內層用序號的奇偶）
KFOLD = 2  # > 2 = 分 K 份（穩健性檢查）：每一份用其他 K − 1 份的局擬合（比對半切更接近正式的表用的局數）
COMPS = ('Pk', 'Pv', 'Pl', 'Mk', 'Mv', 'Ml', 'Lk', 'Lv', 'Ll')


def outer_half(gi):
    return (gi // 2) % 2 if ALT_SPLIT else gi % 2


def inner_half(gi):
    if KFOLD > 2:
        return (gi // KFOLD) % 2
    return gi % 2 if ALT_SPLIT else (gi // 2) % 2


def model_ids():
    """交叉擬合的每一個模型：(編號, 這一局是不是它的擬合局, 這一局是不是它的驗證局)。"""
    if KFOLD > 2:
        return [(f, (lambda gi, f=f: gi % KFOLD != f), (lambda gi, f=f: gi % KFOLD == f)) for f in range(KFOLD)]
    return [(h, (lambda gi, h=h: outer_half(gi) == h), (lambda gi, h=h: outer_half(gi) != h)) for h in (0, 1)]


def model_of_test(gi):
    return gi % KFOLD if KFOLD > 2 else 1 - outer_half(gi)


def load(p):
    with open(p, encoding='utf8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def mf(r, f):
    return f >= (2 if r == 4 else 1)


def tier_of(s):
    return 'S不明' if s is None else '弱桌' if s < 38 else '一般桌' if s < 55 else '強桌'


# ─── 一局的事件 ──────────────────────────────────────────────────────────────

class Game:
    """一局整理好的公開紀錄；`reds` = {角色: 座位}（刺殺時紅方開牌之後知道的）。"""

    def __init__(self, g):
        self.g = g
        roles = g['roles']
        self.roles = roles
        self.reds = {r: roles.index(r) + 1 for r in RED_ROLES if r in roles}
        self.ok = len(self.reds) == 4 and roles.count('merlin') == 1 and roles.count('percival') == 1 and len(roles) == 10
        self.blue = [i + 1 for i, r in enumerate(roles) if r not in RED_ROLES]
        self.merlin = roles.index('merlin') + 1 if 'merlin' in roles else None
        self.percival = roles.index('percival') + 1 if 'percival' in roles else None
        quests = sorted(g['quests'])
        self.props = []
        for r, a, leader, team, appr, forced, _went in g['props']:
            before = [(qr, set(t), f) for qr, t, f in quests if qr < r]
            fails = sum(1 for qr, _, f in before if mf(qr, f))
            succ = [t for qr, t, f in before if not mf(qr, f)]
            on_fail = set()
            for qr, t, f in before:
                if mf(qr, f):
                    on_fail |= t
            laked_x = {t for k, h, t, cl in g['lakes'] if k < r and cl == 'x'}
            self.props.append({
                'r': r, 'a': a, 'leader': leader, 'team': set(team), 'appr': None if appr is None else set(appr), 'forced': bool(forced),
                'fails': fails, 'lastSucc': succ[-1] if succ else set(), 'onFail': on_fail, 'lakedX': laked_x,
            })
        self.lakes = [(k, h, t, cl) for k, h, t, cl in g['lakes']]


def red_role_of(reds):
    return {seat: role for role, seat in reds.items()}


def pick_events(gm, reds, s, rs, x, y):
    """座位 s 當隊長的每一次提議 × 每個其他座位：(分量, 這條世界線的格, 不分角色的格, 有沒有放)。rs = 'L'／'P'／'M'。"""
    rr = red_role_of(reds)
    m = reds['morgana']
    out = []
    for p in gm.props:
        if p['leader'] != s:
            continue
        team = p['team']
        r, forced = p['r'], int(p['forced'])
        exposed = int(m in p['onFail'] or m in p['lakedX'])
        out.append((rs + 'k', ('k', rs, 'self', 0, r, forced), ('k', 'B', 'self', r, forced), int(s in team)))
        for t in range(1, 11):
            if t == s:
                continue
            pub = (int(t in p['lastSucc']), int(t in p['onFail']))
            if t in rr:
                rt = rr[t]
                inv = rt
            else:
                rt = 'merlin' if t == y else 'percival' if t == x else 'loyal'
                inv = 'blue'
            extra = 0
            if rs == 'P' and rt == 'merlin':
                extra = int(m in team)
            elif rs == 'P' and rt == 'morgana':
                extra = exposed
            out.append((rs + 'k', ('k', rs, rt, extra, r, forced) + pub, ('k', 'B', inv, r, forced) + pub, int(t in team)))
    return out


def vote_events(gm, reds, s, rs, x, y):
    """座位 s 的每一張非強制、可靠、不是自己提議的票。"""
    rr = red_role_of(reds)
    m, d = reds['morgana'], reds['mordred']
    out = []
    for p in gm.props:
        if p['forced'] or p['appr'] is None or p['leader'] == s:
            continue
        team, leader, r = p['team'], p['leader'], p['r']
        on = int(s in team)
        nred = sum(1 for t in team if t in rr)
        att4 = int(p['a'] == 4)
        v = int(s in p['appr'])
        inv = ('v', 'B', on, min(nred, 2), r, int(leader in rr), att4)
        if rs == 'L':
            lead = 'M' if leader == y else 'P' if leader == x else 'r' if leader in rr else 'b'
            key = ('v', 'L', on, int(y in team), int(x in team), lead, r, min(nred, 2), att4)
        elif rs == 'P':
            lead = 'M' if leader == y else 'G' if leader == m else 'o'
            exposed = int(m in p['onFail'] or m in p['lakedX'])
            nother = sum(1 for t in team if t in rr and t != m)
            key = ('v', 'P', on, int(y in team), int(m in team), lead, exposed, r, min(nother, 1), att4)
        else:
            nseen = sum(1 for t in team if t in rr and t != d)
            lead = 'P' if leader == x else 'd' if leader == d else 's' if leader in rr else 'b'
            key = ('v', 'M', on, min(nseen, 2), int(d in team), int(p['fails'] >= 2), r, int(x in team), lead, att4)
        out.append((rs + 'v', key, inv, v))
    return out


LAKE_N = {
    'L': {'merlin': 1, 'percival': 1, 'loyal': 3, 'red': 4},
    'P': {'merlin': 1, 'morgana': 1, 'loyal': 4, 'red': 3},
    'M': {'percival': 1, 'loyal': 4, 'seen': 3, 'mordred': 1},
    'B': {'blue': 5, 'red': 4},
}


def lake_events(gm, reds, s, rs, x, y):
    """座位 s 持湖時湖了哪一類人：(分量, 角色, 類別, 不分角色的類別)。"""
    rr = red_role_of(reds)
    out = []
    for _k, h, t, _cl in gm.lakes:
        if h != s:
            continue
        if rs == 'L':
            cat = 'red' if t in rr else 'merlin' if t == y else 'percival' if t == x else 'loyal'
        elif rs == 'P':
            cat = 'morgana' if t == reds['morgana'] else 'red' if t in rr else 'merlin' if t == y else 'loyal'
        else:
            cat = 'mordred' if t == reds['mordred'] else 'seen' if t in rr else 'percival' if t == x else 'loyal'
        out.append((rs + 'l', rs, cat, 'red' if t in rr else 'blue'))
    return out


def seat_hyps(blue, s):
    """座位 s 在各條世界線裡的角色假設：('L', x, y)／('P', None, y)／('M', x, None)。"""
    others = [b for b in blue if b != s]
    if FOLD_PERCIVAL:
        return [('L', None, y) for y in others] + [('M', None, None)]
    hyps = [('L', x, y) for x, y in permutations(others, 2)]
    hyps += [('P', None, y) for y in others]
    hyps += [('M', x, None) for x in others]
    return hyps


# ─── 表 ──────────────────────────────────────────────────────────────────────

class Tables:
    """二元事件的格（逐層退回上一層的前綴當先驗）與湖的類別分布。格的前 3 個元素是最上層。"""

    def __init__(self):
        self.n = defaultdict(float)
        self.k = defaultdict(float)
        self.lake = defaultdict(lambda: defaultdict(float))
        self._p = {}

    def add_bin(self, key, v):
        for i in range(3, len(key) + 1):
            pre = key[:i]
            self.n[pre] += 1
            self.k[pre] += v

    def add_lake(self, rs, cat):
        self.lake[rs][cat] += 1

    def p(self, key):
        hit = self._p.get(key)
        if hit is not None:
            return hit
        if len(key) <= 3:
            n = self.n.get(key, 0.0)
            val = (self.k.get(key, 0.0) + 0.5) / (n + 1.0)
        else:
            parent = self.p(key[:-1])
            val = (self.k.get(key, 0.0) + KAPPA * parent) / (self.n.get(key, 0.0) + KAPPA)
        val = min(max(val, 1e-4), 1 - 1e-4)
        self._p[key] = val
        return val

    def ll_bin(self, key, v):
        q = self.p(key)
        return math.log(q if v else 1 - q)

    def ll_lake(self, rs, cat):
        row = self.lake[rs]
        tot = sum(row.values())
        cats = LAKE_N[rs]
        return math.log((row.get(cat, 0.0) + 1.0) / (tot + len(cats)) / cats[cat])


def fit_tables(games):
    """用真實角色擬合：每個藍方座位照他真的角色記一次，另外記一次不分角色的格。"""
    tb = Tables()
    for gm in games:
        x, y = (None if FOLD_PERCIVAL else gm.percival), gm.merlin
        for s in gm.blue:
            rs = 'M' if s == y else 'P' if s == x else 'L'
            for _, key, inv, v in pick_events(gm, gm.reds, s, rs, x, y) + vote_events(gm, gm.reds, s, rs, x, y):
                tb.add_bin(key, v)
                tb.add_bin(inv, v)
            for _, r2, cat, inv in lake_events(gm, gm.reds, s, rs, x, y):
                tb.add_lake(r2, cat)
                tb.add_lake('B', inv)
    return tb


def world_scores(gm, tb, reds=None):
    """世界線各 9 個分量的對數概似比（相對於不分角色的藍方）。回傳 worlds（[(x, y)]）與陣列 [世界線數, 9]。"""
    reds = reds or gm.reds
    blue = [b for b in range(1, 11) if b not in reds.values()]
    per = {}
    for s in blue:
        for rs, x, y in seat_hyps(blue, s):
            acc = defaultdict(float)
            for comp, key, inv, v in pick_events(gm, reds, s, rs, x, y) + vote_events(gm, reds, s, rs, x, y):
                acc[comp] += tb.ll_bin(key, v) - tb.ll_bin(inv, v)
            for comp, r2, cat, inv in lake_events(gm, reds, s, rs, x, y):
                if tb.lake[r2] and tb.lake['B']:
                    acc[comp] += tb.ll_lake(r2, cat) - tb.ll_lake('B', inv)
            per[(s, rs, x, y)] = acc
    worlds = [(None, y) for y in blue] if FOLD_PERCIVAL else list(permutations(blue, 2))
    arr = np.zeros((len(worlds), len(COMPS)))
    for wi, (x, y) in enumerate(worlds):
        tot = defaultdict(float)
        if x is not None:
            for k, v in per[(x, 'P', None, y)].items():
                tot[k] += v
        for k, v in per[(y, 'M', x, None)].items():
            tot[k] += v
        for s in blue:
            if s != x and s != y:
                for k, v in per[(s, 'L', x, y)].items():
                    tot[k] += v
        arr[wi] = [tot.get(c, 0.0) for c in COMPS]
    return worlds, arr


# ─── 疊加權重（世界線的條件 logit） ──────────────────────────────────────────

def fit_stack(feats, truth, l2=1.0, iters=300):
    """feats: [n, 世界線數, k]；truth: [n] 真世界線的序號。最大化真世界線的對數概似，L2 往 0。"""
    n, _, k = feats.shape
    w = np.full(k, 0.3)
    m = np.zeros(k)
    v = np.zeros(k)
    for it in range(1, iters + 1):
        z = feats @ w
        z -= z.max(axis=1, keepdims=True)
        p = np.exp(z)
        p /= p.sum(axis=1, keepdims=True)
        grad = -(feats[np.arange(n), truth] - (p[:, :, None] * feats).sum(axis=1)).mean(axis=0) + l2 * w / n
        m = 0.9 * m + 0.1 * grad
        v = 0.999 * v + 0.001 * grad * grad
        w -= 0.5 * (m / (1 - 0.9 ** it)) / (np.sqrt(v / (1 - 0.999 ** it)) + 1e-8) * (0.05 if it > 200 else 0.2)
    return w


def logsumexp(a):
    mx = max(a)
    return mx + math.log(sum(math.exp(v - mx) for v in a))


def boot(vals, n=2000, seed=75):
    rng = np.random.default_rng(seed)
    a = np.asarray(vals, dtype=float)
    idx = rng.integers(0, len(a), size=(n, len(a)))
    m = a[idx].mean(axis=1)
    return np.percentile(m, 2.5), np.percentile(m, 97.5)


# ─── 交叉擬合 ────────────────────────────────────────────────────────────────

_TB = None
_VIEW = None


def _score_one(gm):
    return view_scores(gm, _TB, _VIEW)


def score_many(games, tb, view):
    global _TB, _VIEW
    _TB, _VIEW = tb, view
    if len(games) < 50 or PROCS <= 1:
        return [view_scores(g, tb, view) for g in games]
    from multiprocessing import get_context
    with get_context('fork').Pool(PROCS) as pool:
        return pool.map(_score_one, games, chunksize=16)


def view_scores(gm, tb, view):
    """照視角算世界線：回傳 [(紅方假設, worlds, arr[世界線數, 9])]。
    view：'full' = 四個紅方都開牌；'swap' = 不知道刺客的兩個隊友誰是莫甘娜、誰是莫德雷德（兩種各算一次）；
    'noOb' = 不知道誰是奧伯倫（刺客、莫甘娜、莫德雷德以外的 7 個座位各當一次，當奧伯倫的那個座位不算分）；'swap+noOb' = 兩個都不知道。"""
    reds0 = gm.reds
    hyps = [dict(reds0)]
    if 'swap' in view:
        hyps.append({**reds0, 'morgana': reds0['mordred'], 'mordred': reds0['morgana']})
    if 'noOb' in view:
        known = {reds0['assassin'], reds0['morgana'], reds0['mordred']}
        hyps = [{**h, 'oberon': o} for h in hyps for o in range(1, 11) if o not in known]
    return [(h,) + world_scores(gm, tb, h) for h in hyps]


def true_world_index(g, worlds):
    if FOLD_PERCIVAL:
        return [y for _, y in worlds].index(g.merlin)
    return worlds.index((g.percival, g.merlin))


def stack_weights(train, mask, l2):
    """疊加權重：train 再切兩份，互相用對方的表算分數。回傳 (權重, [(局, worlds, arr)])。"""
    feats, truth, keep = [], [], []
    for inner in (0, 1):
        a = [g for g in train if inner_half(g.g['gi']) == inner]
        b = [g for g in train if inner_half(g.g['gi']) != inner]
        tb = fit_tables(a)
        for g, sc in zip(b, score_many(b, tb, 'full')):
            _, worlds, arr = sc[0]
            feats.append(arr * mask)
            truth.append(true_world_index(g, worlds))
            keep.append((g, worlds, arr))
    return fit_stack(np.stack(feats), np.asarray(truth), l2=l2) * mask, keep


def crossfit(games, view='full', mask=None, l2=1.0, verbose=False, fold=False):
    """偶數號擬合 → 奇數號，反過來也一樣。回傳 {gi: [(紅方假設, worlds, z)]}、每一半的疊加權重，以及擬合的那一半自己的（內層交叉的）分數。
    疊加權重一律在「四個紅方都開牌」的分數上擬合（真世界線只有一條）；視角只影響驗證那一半怎麼算。"""
    global FOLD_PERCIVAL
    FOLD_PERCIVAL = fold
    mask = np.ones(len(COMPS)) if mask is None else np.asarray(mask, dtype=float)
    out, weights, inner_out = {}, {}, {}
    for half, is_train, is_test in model_ids():
        train = [g for g in games if is_train(g.g['gi'])]
        test = [g for g in games if is_test(g.g['gi'])]
        w, keep = stack_weights(train, mask, l2)
        weights[half] = w
        if verbose:
            print(f'  模型 {half}（擬合 {len(train)} 局）：疊加權重 ' + ' '.join(f'{c}={v:+.2f}' for c, v in zip(COMPS, w)))
        for g, worlds, arr in keep:
            inner_out[(half, g.g['gi'])] = [(g.reds, worlds, arr @ w)]
        tb = fit_tables(train)
        for g, sc in zip(test, score_many(test, tb, view)):
            out[g.g['gi']] = [(h, worlds, arr @ w) for h, worlds, arr in sc]
    return out, weights, inner_out


def marginals(sc):
    """把各個紅方假設的世界線分數合起來：每個座位是梅林／是派西的 log Σ exp。"""
    by_y, by_x = defaultdict(list), defaultdict(list)
    for _, worlds, z in sc:
        for (x, y), val in zip(worlds, z):
            by_y[y].append(val)
            if x is not None:
                by_x[x].append(val)
    return {y: logsumexp(v) for y, v in by_y.items()}, {x: logsumexp(v) for x, v in by_x.items()}


def argmax_seat(d, allowed=None):
    best = None
    for k in sorted(d):
        if allowed is not None and k not in allowed:
            continue
        if best is None or d[k] > d[best]:
            best = k
    return best


def fit_combo(train_rows):
    """刺殺分數 = a × 現行分數 + b × 世界線的梅林邊際（第一層裡的條件 logit；擬合的那一半）。"""
    best = None
    for a in (0.0, 0.25, 0.5, 0.75, 1.0):
        for b in (0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0):
            if a == 0 and b == 0:
                continue
            ll = 0.0
            for r in train_rows:
                cs = [c for c in r['cands'] if c['front']]
                if not any(c['seat'] == r['merlin'] for c in cs):
                    continue
                zs = {c['seat']: a * c['total'] + b * r['my'].get(c['seat'], -50.0) for c in cs}
                ll += zs[r['merlin']] - logsumexp(list(zs.values()))
            if best is None or ll > best[0]:
                best = (ll, a, b)
    return best[1], best[2]


def pct(rows, k):
    return 100.0 * sum(r[k] for r in rows) / max(len(rows), 1)


def diff_line(rows, a, b):
    d = [r[a] - r[b] for r in rows]
    lo, hi = boot(d)
    return f'{100 * np.mean(d):+.1f} [{100 * lo:+.1f}, {100 * hi:+.1f}]'


def build_rows(games, spots, alts, view='full', mask=None, l2=1.0, verbose=False, fold=False):
    by_gi = {g.g['gi']: g for g in games}
    res, weights, inner = crossfit(games, view=view, mask=mask, l2=l2, verbose=verbose, fold=fold)
    combo = {}
    for half, _, _ in model_ids():
        tr = []
        for (h, gi), sc in inner.items():
            if h != half or gi not in spots:
                continue
            my, _ = marginals(sc)
            tr.append({'cands': spots[gi]['cands'], 'merlin': by_gi[gi].merlin, 'my': my})
        combo[half] = fit_combo(tr)
        if verbose:
            print(f'  模型 {half}：現行分數 × {combo[half][0]}、世界線 × {combo[half][1]}（{len(tr)} 個刺殺點）')
    rows = []
    for gi, sp in spots.items():
        if gi not in res:
            continue
        g = by_gi[gi]
        sc = res[gi]
        my, mx = marginals(sc)
        front = {c['seat'] for c in sp['cands'] if c['front']}
        tot = {c['seat']: c['total'] for c in sp['cands']}
        a, b = combo[model_of_test(gi)]
        top_y = argmax_seat(my)
        mix = {s: a * tot[s] + b * my.get(s, -50.0) for s in tot}
        best_w = max(((z, w) for _, worlds, zz in sc for w, z in zip(worlds, zz)), key=lambda t: t[0])[1]
        given_y = {x: z for _, worlds, zz in sc for (x, y), z in zip(worlds, zz) if y == g.merlin and x is not None}
        row = {
            'gi': gi, 'even': 1 - (gi % 2 if KFOLD > 2 else outer_half(gi)), 's': sp['s'], 'order': sp['order'],
            'human': int(sp['human'] == g.merlin), 'humanP': int(sp['human'] == g.percival), 'bot': int(sp['bot'] == g.merlin),
            'wl': int(top_y == g.merlin), 'wlP': int(top_y == g.percival),
            'wlT': int(argmax_seat(my, front) == g.merlin),
            'mix': int(argmax_seat(mix, front) == g.merlin),
            'mixSeat': argmax_seat(mix, front), 'wlSeat': top_y, 'wlTSeat': argmax_seat(my, front),
            'px': int(argmax_seat(mx) == g.percival) if mx else 0,
            'pxGivenY': int(argmax_seat(given_y) == g.percival) if given_y else 0,
            'pw': int(best_w == (g.percival, g.merlin)),
            'sameH': int(argmax_seat(my, front) == sp['human']), 'botSameH': int(sp['bot'] == sp['human']),
            'botSeat': sp['bot'], 'mFront': int(g.merlin in front),
            'my': my, 'mx': mx,
        }
        for name, alt in alts.items():
            row['alt:' + name] = int(alt[gi]['bot'] == g.merlin) if gi in alt else 0
        rows.append(row)
    return rows, weights, combo


ORDERS = ('BRRBB', 'BRBB', 'RRBBB', 'BBB', 'RBBB')


def report(rows, alts, title):
    print(f'\n== {title}（{len(rows)} 個真人刺殺點；交叉擬合）==')
    names = [('human', '真人刺客'), ('bot', '機器人 現行（基準線）')] + [('alt:' + n, f'機器人 {n}') for n in alts] + [
        ('wl', '只用世界線（6 個藍方）'), ('wlT', '世界線＋現行的分層'), ('mix', '現行分數＋世界線（分層內）')]
    alt_keys = ['alt:' + n for n in alts]
    print('| 範圍 | n | ' + ' | '.join(n for _, n in names) + ' | 世界線＋分層 − 現行 [95%] | 混合 − 現行 [95%] |'
          + ''.join(f' 世界線＋分層 − {n} [95%] |' for n in alts) + ' 世界線＋分層 − 真人 [95%] |')
    print('|---|---|' + '---|' * (len(names) + 3 + len(alts)))
    groups = [('全部', rows), ('偶數號', [r for r in rows if r['even']]), ('奇數號', [r for r in rows if not r['even']])]
    for o in ORDERS:
        groups.append((o.replace('B', '藍').replace('R', '紅'), [r for r in rows if r['order'] == o]))
    groups.append(('其他順序', [r for r in rows if r['order'] not in ORDERS]))
    for t in ('弱桌', '一般桌', '強桌', 'S不明'):
        groups.append((t, [r for r in rows if tier_of(r['s']) == t]))
    for name, rs in groups:
        if not rs:
            continue
        print(f'| {name} | {len(rs)} | ' + ' | '.join(f'{pct(rs, k):.1f}' for k, _ in names) + f' | {diff_line(rs, "wlT", "bot")} | {diff_line(rs, "mix", "bot")} |'
              + ''.join(f' {diff_line(rs, "wlT", k)} |' for k in alt_keys) + f' {diff_line(rs, "wlT", "human")} |')
    print(f'派西維爾：世界線的派西第一名是真派西 {pct(rows, "px"):.1f}%（亂猜 16.7%）；已知真梅林時 {pct(rows, "pxGivenY"):.1f}%（亂猜 20%）；'
          f'第一名的世界線完全對 {pct(rows, "pw"):.1f}%（亂猜 3.3%）')
    chg = [r for r in rows if r['wlTSeat'] != r['botSeat']]
    print(f'改到 {len(chg)} 點（{100 * len(chg) / len(rows):.1f}%）：多刺中 {sum(1 for r in chg if r["wlT"] and not r["bot"])}、少刺中 {sum(1 for r in chg if r["bot"] and not r["wlT"])}；'
          f'梅林在分層第一層 {pct(rows, "mFront"):.1f}%')
    print(f'刺到派西：真人 {pct(rows, "humanP"):.1f}%、世界線 {pct(rows, "wlP"):.1f}%；和真人同目標：現行 {pct(rows, "botSameH"):.1f}%、世界線＋分層 {pct(rows, "sameH"):.1f}%')


def export_tables(games, out_dir, l2):
    """給 TypeScript 用的表：full = 全部真人局（部署用）；even／odd = 只用偶數號／奇數號的局擬合（驗證另一半用）。"""
    def dump(train, name):
        w, _ = stack_weights(train, np.ones(len(COMPS)), l2)
        tb = fit_tables(train)
        obj = {
            'version': f'r75-{name}-{len(train)}', 'kappa': KAPPA, 'comps': list(COMPS), 'weights': [round(float(v), 4) for v in w],
            'bin': {'|'.join(str(e) for e in k): [int(n), int(tb.k.get(k, 0))] for k, n in sorted(tb.n.items(), key=lambda kv: tuple(map(str, kv[0])))},
            'lake': {rs: {c: int(v) for c, v in sorted(row.items())} for rs, row in sorted(tb.lake.items())},
        }
        with open(f'{out_dir}/worldLines75_{name}.json', 'w', encoding='utf8') as fh:
            json.dump(obj, fh, separators=(',', ':'))
        print(f'{name}: {len(train)} 局、{len(obj["bin"])} 格、權重 ' + ' '.join(f'{c}={v:+.2f}' for c, v in zip(COMPS, w)))
    dump(games, 'full')
    dump([g for g in games if g.g['gi'] % 2 == 0], 'even')
    dump([g for g in games if g.g['gi'] % 2 == 1], 'odd')


def print_cells(path):
    """正式的表裡幾個主要的格（真人局的比例）。"""
    t = json.load(open(path, encoding='utf8'))
    b = t['bin']

    def r(k):
        if k not in b:
            return '—'
        n, x = b[k]
        return f'{100 * x / n:.1f}%（{x}／{n}）'
    print(f'表 {t["version"]}：{len(b)} 格；疊加權重 ' + ' '.join(f'{c}={w:+.2f}' for c, w in zip(t['comps'], t['weights'])))
    print('\n| 非強制的提議，第幾局 | 派西隊長放梅林（莫甘娜不在隊上） | 派西隊長放梅林（莫甘娜在隊上） | 忠臣隊長放梅林 | 忠臣隊長放忠臣 | 派西隊長放莫甘娜（還沒曝光／已曝光） | 忠臣隊長放莫甘娜 |')
    print('|---|---|---|---|---|---|---|')
    for rd in range(1, 6):
        print(f'| {rd} | {r(f"k|P|merlin|0|{rd}|0")} | {r(f"k|P|merlin|1|{rd}|0")} | {r(f"k|L|merlin|0|{rd}|0")} | {r(f"k|L|loyal|0|{rd}|0")} | '
              f'{r(f"k|P|morgana|0|{rd}|0")}／{r(f"k|P|morgana|1|{rd}|0")} | {r(f"k|L|morgana|0|{rd}|0")} |')
    print('\n| 非強制的提議，第幾局 | 梅林隊長放刺客 | 放奧伯倫 | 放莫甘娜 | 放莫德雷德 | 忠臣隊長放刺客 | 放莫德雷德 | 梅林隊長放派西 | 放忠臣 |')
    print('|---|---|---|---|---|---|---|---|---|')
    for rd in range(1, 6):
        print(f'| {rd} | ' + ' | '.join(r(f'k|{a}|{c}|0|{rd}|0') for a, c in (('M', 'assassin'), ('M', 'oberon'), ('M', 'morgana'), ('M', 'mordred'), ('L', 'assassin'), ('L', 'mordred'), ('M', 'percival'), ('M', 'loyal'))) + ' |')
    print('\n| 票（非強制、不是自己的提議） | 梅林不在、莫甘娜不在 | 只有莫甘娜 | 只有梅林 | 兩根拇指都在 |')
    print('|---|---|---|---|---|')
    for on, name in ((0, '派西不在隊上：贊成'), (1, '派西在隊上：贊成')):
        print(f'| {name} | ' + ' | '.join(r(f'v|P|{on}|{y}|{m}') for y, m in ((0, 0), (0, 1), (1, 0), (1, 1))) + ' |')
    print('\n| 票 | 隊上沒有他看得到的紅 | 一個 | 兩個以上 | 不分角色的藍方：隊上 0／1／2 個以上的紅 |')
    print('|---|---|---|---|---|')
    for on, name in ((0, '梅林不在隊上：贊成'), (1, '梅林在隊上：贊成')):
        print(f'| {name} | ' + ' | '.join(r(f'v|M|{on}|{a}') for a in (0, 1, 2)) + ' | ' + '／'.join(r(f'v|B|{on}|{a}') for a in (0, 1, 2)) + ' |')
    print('\n湖（持湖者的角色 → 湖了哪一類人；括號 = 每個座位的比例）：')
    for rs, name in (('P', '派西'), ('M', '梅林'), ('L', '忠臣')):
        row = t['lake'][rs]
        tot = sum(row.values())
        print(f'- {name}（{tot} 次）：' + '、'.join(f'{c} {100 * v / tot:.1f}%（每個座位 {100 * v / tot / LAKE_N[rs][c]:.1f}%）' for c, v in row.items()))


def bot_compare(base_path, cand_path, games_n):
    """自我對打：同一份紀錄上現行與候選的刺殺，逐局配對（刺殺是最後一個動作）。"""
    base = load(base_path)
    cand = {a['gi']: a for a in load(cand_path)}
    logged = sum(1 for a in base if a.get('logged') == a['bot'])
    print(f'刺殺點 {len(base)}（現行重算和紀錄相同 {logged}／{len(base)}）；局數 {games_n}')
    print('| 範圍 | n | 現行 % | 候選 % | 改到 | 多刺中／少刺中 | 候選 − 現行 [95%] |')
    print('|---|---|---|---|---|---|---|')
    groups = [('全部', base)] + [(o.replace('B', '藍').replace('R', '紅'), [a for a in base if a['order'] == o]) for o in ORDERS]
    for name, rs in groups:
        if not rs:
            continue
        b = np.array([a['bot'] == a['merlin'] for a in rs], dtype=float)
        c = np.array([cand[a['gi']]['bot'] == a['merlin'] for a in rs], dtype=float)
        chg = sum(1 for a in rs if cand[a['gi']]['bot'] != a['bot'])
        lo, hi = boot(c - b)
        print(f'| {name} | {len(rs)} | {100 * b.mean():.2f} | {100 * c.mean():.2f} | {chg} | {int(((c - b) > 0).sum())}／{int(((c - b) < 0).sum())} | '
              f'{100 * (c - b).mean():+.2f} [{100 * lo:+.2f}, {100 * hi:+.2f}] |')
    d = np.zeros(games_n)
    for i, a in enumerate(base):
        d[i] = (cand[a['gi']]['bot'] == a['merlin']) - (a['bot'] == a['merlin'])
    lo, hi = boot(d)
    three = len(base) / games_n
    hb = np.mean([a['bot'] == a['merlin'] for a in base])
    hc = np.mean([cand[a['gi']]['bot'] == a['merlin'] for a in base])
    print(f'紅方勝率差（每局）：{100 * d.mean():+.2f} [{100 * lo:+.2f}, {100 * hi:+.2f}] pp；任務三藍 {100 * three:.2f}%（不變）；'
          f'藍方勝率 {100 * three * (1 - hb):.2f} → {100 * three * (1 - hc):.2f}%')


def patch_results(src, prefix, cand_path, out, oprefix):
    """把候選的刺殺目標寫回 `sp.ts` 的結果檔（g 欄的 a、blueWon、merlinKilled），局的順序同 `keySpotStudy.ts --export-bot`。"""
    cand = {a['gi']: a for a in load(cand_path)}
    os.makedirs(out, exist_ok=True)
    files = sorted(f for f in os.listdir(src) if f.endswith('.json') and f.startswith(prefix))
    gi = changed = n = 0
    for f in files:
        with open(os.path.join(src, f), encoding='utf8') as fh:
            d = json.load(fh)
        cols = d['cols']
        g_at, bw, mk, tb = cols.index('g'), cols.index('blueWon'), cols.index('merlinKilled'), cols.index('threeBlue')
        for row in d['rows']:
            a = cand.get(gi)
            if a is not None:
                assert row[tb] == 1, (gi, row[:6])
                g = json.loads(row[g_at])
                new = '0' if a['bot'] == 10 else str(a['bot'])
                changed += int(str(g['a']) != new)
                g['a'] = new
                row[g_at] = json.dumps(g, separators=(',', ':'))
                hit = 1 if a['bot'] == a['merlin'] else 0
                row[mk] = hit
                row[bw] = 1 - hit
                n += 1
            gi += 1
        with open(os.path.join(out, oprefix + f[len(prefix):]), 'w', encoding='utf8') as fh:
            json.dump(d, fh)
    print(f'{len(files)} 個檔、{gi} 局、{n} 個刺殺、改到 {changed} 個目標')


def bot_parts(games, bot_path, l2, limit):
    """機器人桌：真人局擬合的表與權重，逐分量看機器人的梅林露在哪裡。"""
    w, _ = stack_weights(games, np.ones(len(COMPS)), l2)
    tb = fit_tables(games)
    bots = [Game(g) for g in load(bot_path) if g.get('at') is not None]
    bots = [g for g in bots if g.ok][:limit]
    scored = score_many(bots, tb, 'full')
    print(f'自我對打的刺殺點 {len(bots)}（紀錄上的刺中率 {100 * np.mean([g.g["at"] == g.merlin for g in bots]):.1f}%）')
    sets = [('全部', []), ('拿掉派西那一側（Pk Pv Pl）', ['Pk', 'Pv', 'Pl']), ('拿掉梅林那一側（Mk Mv Ml）', ['Mk', 'Mv', 'Ml']), ('拿掉忠臣那一側（Lk Lv Ll）', ['Lk', 'Lv', 'Ll']),
            ('拿掉派隊（Pk Mk Lk）', ['Pk', 'Mk', 'Lk']), ('拿掉票（Pv Mv Lv）', ['Pv', 'Mv', 'Lv']), ('拿掉湖（Pl Ml Ll）', ['Pl', 'Ml', 'Ll'])]
    sets += [(f'只用 {c}', [x for x in COMPS if x != c]) for c in COMPS]
    print('| 分量 | 只用世界線的刺中率 % | 派西第一名是真派西 % |')
    print('|---|---|---|')
    for name, drop in sets:
        mask = np.array([0.0 if c in drop else 1.0 for c in COMPS])
        hit = px = 0
        for g, sc in zip(bots, scored):
            _, worlds, arr = sc[0]
            my, mx = marginals([(None, worlds, arr @ (w * mask))])
            hit += argmax_seat(my) == g.merlin
            px += argmax_seat(mx) == g.percival
        print(f'| {name} | {100 * hit / len(bots):.1f} | {100 * px / len(bots):.1f} |')


def merge_folds(even_file, odd_file, out):
    """每一局取沒有看過它的那張表的那一列：偶數號的局 ← 奇數號擬合的表；奇數號的局 ← 偶數號擬合的表。"""
    n = 0
    with open(out, 'w', encoding='utf8') as fh:
        for path, want in ((even_file, 1), (odd_file, 0)):
            for r in load(path):
                if r['gi'] % 2 == want:
                    fh.write(json.dumps(r, ensure_ascii=False) + '\n')
                    n += 1
    print(f'{n} 列 → {out}')


def main():
    global KAPPA, ALT_SPLIT, KFOLD
    ap = argparse.ArgumentParser()
    ap.add_argument('--human')
    ap.add_argument('--base')
    ap.add_argument('--alt', action='append', default=[])
    ap.add_argument('--part', default='eval')
    ap.add_argument('--l2', type=float, default=1.0)
    ap.add_argument('--out', default='.')
    ap.add_argument('--tables', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'ai', 'assassin', 'worldLines75Tables.json'))
    ap.add_argument('--kappa', type=float, default=None, help='格子往上一層收縮的強度（預設 10）')
    ap.add_argument('--alt-split', action='store_true', help='換一種奇偶切法（穩健性檢查）')
    ap.add_argument('--kfold', type=int, default=2, help='> 2 = 分 K 份交叉擬合（穩健性檢查；預設對半切）')
    ap.add_argument('--cand')
    ap.add_argument('--games', type=int, default=10000, help='--part bot：這份自我對打紀錄的總局數')
    ap.add_argument('--src')
    ap.add_argument('--src-prefix', default='')
    ap.add_argument('--out-prefix', default='WL_')
    ap.add_argument('--bot')
    ap.add_argument('--limit', type=int, default=3000)
    ap.add_argument('--even-tables-file')
    ap.add_argument('--odd-tables-file')
    args = ap.parse_args()
    if args.part == 'cells':
        return print_cells(args.tables)
    if args.part == 'bot':
        return bot_compare(args.base, args.cand, args.games)
    if args.part == 'patch':
        return patch_results(args.src, args.src_prefix, args.cand, args.out, args.out_prefix)
    if args.part == 'merge':
        return merge_folds(args.even_tables_file, args.odd_tables_file, args.out)
    if args.kappa is not None:
        KAPPA = args.kappa
    ALT_SPLIT = args.alt_split
    KFOLD = args.kfold
    games = [Game(g) for g in load(args.human)]
    games = [g for g in games if g.ok]
    if args.part == 'export':
        print(f'真人局 {len(games)}')
        return export_tables(games, args.out, args.l2)
    if args.part == 'botparts':
        return bot_parts(games, args.bot, args.l2, args.limit)
    spots = {r['gi']: r for r in load(args.base)}
    alts = {a.split('=')[0]: {r['gi']: r for r in load(a.split('=')[1])} for a in args.alt}
    print(f'真人局 {len(games)}；刺殺點 {len(spots)}')

    if args.part == 'eval':
        rows, _, _ = build_rows(games, spots, alts, l2=args.l2, verbose=True)
        report(rows, alts, '世界線模型')
    elif args.part == 'ablate':
        base, _, _ = build_rows(games, spots, alts, l2=args.l2)
        print('| 分量 | 只用世界線 | ＋分層 | 混合 | 派西第一名 |')
        print('|---|---|---|---|---|')
        print(f'| 全部 | {pct(base, "wl"):.1f} | {pct(base, "wlT"):.1f} | {pct(base, "mix"):.1f} | {pct(base, "px"):.1f} |', flush=True)
        sets = [('拿掉派西那一側（Pk Pv Pl）', ['Pk', 'Pv', 'Pl']), ('拿掉梅林那一側（Mk Mv Ml）', ['Mk', 'Mv', 'Ml']), ('拿掉忠臣那一側（Lk Lv Ll）', ['Lk', 'Lv', 'Ll']),
                ('拿掉派隊（Pk Mk Lk）', ['Pk', 'Mk', 'Lk']), ('拿掉票（Pv Mv Lv）', ['Pv', 'Mv', 'Lv']), ('拿掉湖（Pl Ml Ll）', ['Pl', 'Ml', 'Ll'])]
        sets += [(f'只用 {c}', [x for x in COMPS if x != c]) for c in COMPS]
        for name, drop in sets:
            mask = [0.0 if c in drop else 1.0 for c in COMPS]
            rs, _, _ = build_rows(games, spots, alts, mask=mask, l2=args.l2)
            print(f'| {name} | {pct(rs, "wl"):.1f} | {pct(rs, "wlT"):.1f} | {pct(rs, "mix"):.1f} | {pct(rs, "px"):.1f} |', flush=True)
    elif args.part == 'views':
        print('| 視角 | 只用世界線 | ＋分層 | 混合 | 派西第一名 |')
        print('|---|---|---|---|---|')
        for fold, fname in ((False, '世界線（派西 × 梅林）'), (True, '只有梅林（派西當成忠臣）')):
            for view, vname in (('full', '四個紅方都開牌'), ('swap', '不知道誰是莫甘娜／莫德雷德'), ('noOb', '不知道誰是奧伯倫'), ('swap+noOb', '只有刺客自己的視角')):
                rs, _, _ = build_rows(games, spots, alts, view=view, l2=args.l2, fold=fold)
                print(f'| {fname}・{vname} | {pct(rs, "wl"):.1f} | {pct(rs, "wlT"):.1f} | {pct(rs, "mix"):.1f} | {pct(rs, "px"):.1f} |', flush=True)


if __name__ == '__main__':
    main()
