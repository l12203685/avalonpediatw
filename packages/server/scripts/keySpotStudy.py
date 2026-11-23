#!/usr/bin/env python3
"""第 60 回合（分析）：局勢樹上哪些節點（spot）對藍方最後勝負影響最大。

輸入是 `keySpotStudy.ts` 的輸出（只有座位、角色、隊伍、票、任務牌、湖、刺殺，沒有玩家名）：
  --human h.jsonl      真人局（--export-human）
  --bot b.jsonl        自我對打（--export-bot，現行預設 detail=1）
  --replay r.jsonl     S ≥ 55 的真人桌，每個座位用現行預設重播到每一個決策點（--replay）

藍方勝 = 三藍活（三個任務成功而且梅林沒被刺中）。局面（公開資訊）= 第幾局、第幾次提議（1–5；第 5 次 = 強制局，
隊長和之後的隊長的相對位置就是 5 − 第幾次）、比數（藍:紅 = 成功:失敗的任務數），湖另外分。

節點與「動作」（二分，方便比較；真相欄只用來分類，不是決策者知道的事）：
  M  任務結果：這一局的任務成功 vs 失敗（任務結果槓桿 = P(藍勝 | 成功) − P(藍勝 | 失敗)）。
  P  提議：隊長（分藍／紅）派出的隊沒有紅 vs 有紅（「有紅」= 紅數夠讓任務失敗：第 4 局 ≥ 2 紅，其他局 ≥ 1 紅；V、v、C 同）。
  V  表決（整桌）：這個提議通過 vs 被否決，分「隊上有紅／沒有紅」。
  v  表決（個人）：某陣營的投票者贊成 vs 反對（分隊上有紅／沒有紅），只用可靠的票。
  C  任務牌：隊上有紅時任務成功（紅方藏牌）vs 失敗。
  L  湖：藍方持湖 → 驗到真紅 vs 真藍；紅方持湖 → 宣告說實話 vs 說謊。
  A  刺殺：三藍局依任務順序分（例：藍紅藍藍），梅林活 vs 被刺中（藍方勝負就是這一刀）。

每個節點：頻率 f = 走到這個節點的局數 ÷ 全部局數；兩個動作的藍勝率 W1、W0；差 Δ = W1 − W0；
期望擺動 = f × |Δ|（站長要的「頻率 × 差」）；另列 f × 2p(1−p)|Δ|（p = 動作 1 的比例；照實際的選擇比例，實際會動到的量）。
區間：以局為群集的 Poisson bootstrap（真人 1,000 次、自我對打 200 次），報 95% 百分位區間。

和強者的比較（第 3 步）：同一批真人決策點（S ≥ 65 的高強度局；樣本小，另列 S ≥ 55 的高端桌），
機器人（現行預設）和真人選的動作一不一致、各自選「真人資料裡勝率比較好的那個動作」的比例，
落差 = |Δ| × （機器人沒選較好動作的比例 − 強者沒選的比例），Δ 用全部真人局（樣本大），兩邊一起 bootstrap。
注意：Δ 是觀察到的相關，不是因果——選到乾淨的隊的人可能本來就資訊比較好、桌子比較弱或比較強（選擇偏誤）。

  python3 scripts/keySpotStudy.py --human h.jsonl --bot b.jsonl --replay r.jsonl [--md out.md] [--json out.json]
"""
import argparse
import json
import sys
from collections import defaultdict

import numpy as np

RED = {'assassin', 'morgana', 'mordred', 'oberon'}


def camp(role):
    return 'red' if role in RED else 'blue'


def load(path):
    with open(path, encoding='utf8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def mission_failed(r, fails):
    return fails >= (2 if r == 4 else 1)


def seq_label(g):
    return ''.join('紅' if mission_failed(r, f) else '藍' for r, _t, f in g['quests'])


# ─── 節點 ────────────────────────────────────────────────────────────────────

def need(r):
    """「隊上有紅」= 紅數 ≥ 讓任務能失敗的張數（10 人局第 4 局要 2 張）。"""
    return 2 if r == 4 else 1


def score_before(g):
    """round → (藍, 紅) before that round's mission."""
    b = f = 0
    out = {}
    for r, _t, fails in g['quests']:
        out[r] = (b, f)
        if mission_failed(r, fails):
            f += 1
        else:
            b += 1
    out['end'] = (b, f)
    return out


def nodes_of(g):
    """(key, action 0/1) for the game's nodes; individual-vote keys can repeat (one per voter)."""
    roles = g['roles']
    red = lambda s: roles[s - 1] in RED
    sc = score_before(g)
    out = []
    for r, a, leader, team, appr, forced, went in g['props']:
        if r not in sc:
            continue
        b, f = sc[r]
        s = f'{b}:{f}'
        dirty = sum(red(x) for x in team) >= need(r)
        out.append((('P', r, a, s, camp(roles[leader - 1])), 0 if dirty else 1))
        if not forced:
            out.append((('V', r, a, s, 'dirty' if dirty else 'clean'), 1 if went else 0))
            if appr is not None:
                ap = set(appr)
                for seat in range(1, 11):
                    if seat == leader:
                        continue
                    out.append((('v', r, a, s, 'dirty' if dirty else 'clean', camp(roles[seat - 1])), 1 if seat in ap else 0))
    for r, team, fails in g['quests']:
        b, f = sc[r]
        s = f'{b}:{f}'
        ok = 0 if mission_failed(r, fails) else 1
        out.append((('M', r, s), ok))
        # 任務牌：隊上有紅（第 4 局要 2 張失敗，只算隊上 ≥ 2 紅）
        if sum(red(x) for x in team) >= need(r):
            out.append((('C', r, s), ok))
    for k, holder, target, claim in g['lakes']:
        b, f = sc.get(k + 1, sc['end'])  # 湖在第 k 局任務之後：比數 = 第 k 局之後
        s = f'{b}:{f}'
        if not red(holder):
            out.append((('L', k, s, 'blue'), 0 if red(target) else 1))
        elif claim in ('o', 'x'):
            truth = 'x' if red(target) else 'o'
            out.append((('L', k, s, 'red'), 1 if claim == truth else 0))
    if g['out'] != 'red3':
        out.append((('A', seq_label(g)), 1 if g['out'] == 'blueAlive' else 0))
    return out


def lake1_tag(g):
    """第一湖（第 2 局後）的宣告：'湖說藍' / '湖說紅' / '沒有湖'."""
    l = next((x for x in g['lakes'] if x[0] == 2), None)
    if l is None or l[3] not in ('o', 'x'):
        return '沒有湖'
    return '湖說藍' if l[3] == 'o' else '湖說紅'


def collect_lake(games):
    """第 3–5 局的任務結果與藍隊長提議，再分第一湖的宣告。"""
    acc = defaultdict(lambda: ([], []))
    for i, g in enumerate(games):
        tag = lake1_tag(g)
        for key, act in nodes_of(g):
            if key[0] in ('M', 'P') and key[1] >= 3 and (key[0] == 'M' or key[4] == 'blue'):
                acc[key + (tag,)][0].append(i)
                acc[key + (tag,)][1].append(act)
    return {k: (np.array(v[0]), np.array(v[1], dtype=float)) for k, v in acc.items()}


def collect(games):
    """key → (game idx array, action array)."""
    acc = defaultdict(lambda: ([], []))
    for i, g in enumerate(games):
        for key, act in nodes_of(g):
            acc[key][0].append(i)
            acc[key][1].append(act)
    return {k: (np.array(v[0]), np.array(v[1], dtype=float)) for k, v in acc.items()}


def node_stats(games, nodes, B, seed, min_cls=15):
    """per key: f, n, p1, W1, W0, Δ, swing (point + CI)."""
    N = len(games)
    win = np.array([1.0 if g['out'] == 'blueAlive' else 0.0 for g in games])
    rng = np.random.default_rng(seed)
    wts = rng.poisson(1.0, size=(B, N)).astype(np.float32)
    tot = wts.sum(axis=1)
    res = {}
    for key, (gi, act) in nodes.items():
        n = len(gi)
        n1 = int(act.sum())
        n0 = n - n1
        if n1 < min_cls or n0 < min_cls:
            continue
        w = win[gi]
        uniq = len(np.unique(gi))
        f = uniq / N
        W1 = w[act == 1].mean()
        W0 = w[act == 0].mean()
        d = W1 - W0
        p1 = n1 / n
        # bootstrap
        bw = wts[:, gi]
        # game-level frequency: count each game once
        first = np.unique(gi, return_index=True)[1]
        fb = bw[:, first].sum(axis=1) / tot
        s1 = (bw * act).sum(axis=1)
        s0 = (bw * (1 - act)).sum(axis=1)
        W1b = (bw * act * w).sum(axis=1) / np.maximum(s1, 1e-9)
        W0b = (bw * (1 - act) * w).sum(axis=1) / np.maximum(s0, 1e-9)
        db = W1b - W0b
        p1b = s1 / np.maximum(s1 + s0, 1e-9)
        swb = fb * np.abs(db)
        evb = fb * 2 * p1b * (1 - p1b) * np.abs(db)
        q = lambda x: [float(np.percentile(x, 2.5)), float(np.percentile(x, 97.5))]
        res[key] = dict(n=n, games=uniq, f=f, p1=p1, W1=float(W1), W0=float(W0), d=float(d), d_ci=q(db),
                        swing=float(f * abs(d)), swing_ci=q(swb), move=float(f * 2 * p1 * (1 - p1) * abs(d)), move_ci=q(evb),
                        _db=db, _fb=fb)
    return res


# ─── 標籤 ────────────────────────────────────────────────────────────────────

CAMP = {'blue': '藍', 'red': '紅'}


def label(key):
    t = key[0]
    if t == 'P':
        _, r, a, s, c = key
        return f'{r}-{a} 提議（{s}，{CAMP[c]}隊長）'
    if t == 'V':
        _, r, a, s, d = key
        return f'{r}-{a} 表決（{s}，隊上{"有紅" if d == "dirty" else "沒紅"}）'
    if t == 'v':
        _, r, a, s, d, c = key
        return f'{r}-{a} {CAMP[c]}方個人票（{s}，隊上{"有紅" if d == "dirty" else "沒紅"}）'
    if t == 'M':
        _, r, s = key
        return f'第 {r} 局任務結果（{s}）'
    if t == 'C':
        _, r, s = key
        return f'第 {r} 局任務牌（{s}，隊上有紅）'
    if t == 'L':
        _, k, s, c = key
        return f'第 {k} 局後的湖（{s}，{CAMP[c]}方持湖）'
    if t == 'A':
        return f'刺殺（任務 {key[1]}）'
    return str(key)


def label_lake(key):
    return label(key[:-1]) + f'・{key[-1]}'


ACT = {
    'P': ('隊上沒紅', '隊上有紅'), 'V': ('通過', '否決'), 'v': ('贊成', '反對'), 'M': ('成功', '失敗'),
    'C': ('藏牌（成功）', '出失敗'), 'A': ('梅林活', '刺中'),
}


def act_names(key):
    if key[0] == 'L':
        return ('驗到真藍', '驗到真紅') if key[3] == 'blue' else ('說實話', '說謊')
    return ACT[key[0]]


def actor_camp(key):
    """Who chooses the action (for 'best action' direction): blue maximizes W, red minimizes."""
    t = key[0]
    if t == 'P':
        return key[4]
    if t == 'v':
        return key[5]
    if t in ('C', 'A'):
        return 'red'
    if t == 'L':
        return key[3]
    return None


# ─── 機器人 vs 強者（同一批真人決策點） ───────────────────────────────────────

def replay_points(games_by_gi, rows):
    """replay rows → (spot key, human action, bot action, exact match, s)."""
    out = []
    for d in rows:
        g = games_by_gi.get(d['gi'])
        if g is None:
            continue
        roles = g['roles']
        red = lambda s: roles[s - 1] in RED
        sc = score_before(g)
        t = d['type']
        r = d['round']
        seats = lambda x: [int(v) for v in x.split(',') if v]
        if t in ('team', 'vote'):
            prop = next((p for p in g['props'] if p[0] == r and p[1] == d['attempt']), None)
            if prop is None or r not in sc:
                continue
            b, f = sc[r]
            s = f'{b}:{f}'
            if t == 'team':
                ht, bt = seats(d['human']), seats(d['agent'])
                if not bt:
                    continue
                key = ('P', r, d['attempt'], s, camp(roles[d['seat'] - 1]))
                ha = 0 if sum(red(x) for x in ht) >= need(r) else 1
                ba = 0 if sum(red(x) for x in bt) >= need(r) else 1
                out.append((key, ha, ba, sorted(ht) == sorted(bt), d['s']))
            else:
                if d['seat'] == prop[2]:
                    continue
                dirty = sum(red(x) for x in prop[3]) >= need(r)
                key = ('v', r, d['attempt'], s, 'dirty' if dirty else 'clean', camp(roles[d['seat'] - 1]))
                ha = 1 if d['human'] == 'approve' else 0
                ba = 1 if d['agent'] == 'approve' else 0
                out.append((key, ha, ba, ha == ba, d['s']))
        elif t == 'quest':
            q = next((x for x in g['quests'] if x[0] == r), None)
            if q is None or (r == 4 and sum(red(x) for x in q[1]) < 2):
                continue
            b, f = sc[r]
            key = ('C', r, f'{b}:{f}')
            ha = 1 if d['human'] == 'success' else 0
            ba = 1 if d['agent'] == 'success' else 0
            out.append((key, ha, ba, ha == ba, d['s']))
        elif t == 'lakeTarget':
            b, f = sc.get(r + 1, sc['end'])
            if red(d['seat']):
                continue
            ht, bt = int(d['human']), int(d['agent']) if d['agent'] else None
            if bt is None:
                continue
            key = ('L', r, f'{b}:{f}', 'blue')
            out.append((key, 0 if red(ht) else 1, 0 if red(bt) else 1, ht == bt, d['s']))
        elif t == 'lakeClaim':
            if not red(d['seat']):
                continue
            b, f = sc.get(r + 1, sc['end'])
            lake = next((l for l in g['lakes'] if l[0] == r), None)
            if lake is None:
                continue
            truth = 'evil' if red(lake[2]) else 'good'
            key = ('L', r, f'{b}:{f}', 'red')
            ha = 1 if d['human'] == truth else 0
            ba = 1 if d['agent'] == truth else 0
            out.append((key, ha, ba, d['human'] == d['agent'], d['s']))
        elif t == 'assassinate':
            merlin = roles.index('merlin') + 1
            key = ('A', seq_label(g))
            ha = 0 if int(d['human']) == merlin else 1
            ba = 0 if d['agent'] and int(d['agent']) == merlin else 1
            out.append((key, ha, ba, d['human'] == d['agent'], d['s']))
    return out


def compare(spot, hstat, pts, smin, B, seed):
    """Agreement and gap at one spot among replay points with s ≥ smin."""
    P = [(h, b, m) for k, h, b, m, s in pts if k == spot and s is not None and s >= smin]
    if not P:
        return None
    h = np.array([x[0] for x in P], dtype=float)
    b = np.array([x[1] for x in P], dtype=float)
    m = np.array([x[2] for x in P], dtype=float)
    d = hstat['d']
    c = actor_camp(spot)
    # better action (in the actor's interest): blue wants high W, red low W
    best1 = (d > 0) if c != 'red' else (d < 0)
    good = (lambda a: a) if best1 else (lambda a: 1 - a)
    miss_b = 1 - good(b).mean()
    miss_h = 1 - good(h).mean()
    gap = abs(d) * (miss_b - miss_h)
    rng = np.random.default_rng(seed)
    n = len(P)
    idx = rng.integers(0, n, size=(B, n))
    db = hstat['_db'][:B] if len(hstat['_db']) >= B else np.resize(hstat['_db'], B)
    mb = 1 - good(b[idx]).mean(axis=1)
    mh = 1 - good(h[idx]).mean(axis=1)
    gb = np.abs(db) * (mb - mh)
    return dict(n=n, agree=float(m.mean()), act_agree=float((h == b).mean()), bot_best=float(1 - miss_b), hum_best=float(1 - miss_h),
                gap=float(gap), gap_ci=[float(np.percentile(gb, 2.5)), float(np.percentile(gb, 97.5))],
                bot_gap=float(abs(d) * miss_b), best=act_names(spot)[0 if best1 else 1])


# ─── 輸出 ────────────────────────────────────────────────────────────────────

def pct(x):
    return f'{100 * x:.1f}'


def pp(x):
    return f'{100 * x:+.1f}'


def ci(c, scale=100):
    return f'[{scale * c[0]:+.1f}, {scale * c[1]:+.1f}]'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--human', required=True)
    ap.add_argument('--bot')
    ap.add_argument('--replay', nargs='*', default=[])
    ap.add_argument('--replay-assassin', nargs='*', default=[], help='全部真人局只重播刺客座位（--replay --min-s -1 --only-role assassin）')
    ap.add_argument('--md')
    ap.add_argument('--json')
    ap.add_argument('--top', type=int, default=10)
    ap.add_argument('--boot', type=int, default=1000)
    args = ap.parse_args()

    H = load(args.human)
    HS = [g for g in H if g['s'] is not None and g['s'] >= 55]
    HS65 = [g for g in H if g['s'] is not None and g['s'] >= 65]
    Bt = load(args.bot) if args.bot else []
    L = []
    say = L.append

    def stats(games, B, seed, min_cls=15):
        return node_stats(games, collect(games), B, seed, min_cls)

    sh = stats(H, args.boot, 1)
    ss = stats(HS, args.boot, 2, min_cls=8)
    sb = stats(Bt, 200, 3, min_cls=30) if Bt else {}
    win = lambda gs: sum(g['out'] == 'blueAlive' for g in gs) / max(len(gs), 1)
    three = lambda gs: sum(g['out'] != 'red3' for g in gs) / max(len(gs), 1)
    say(f'真人 {len(H)} 局（藍勝 {pct(win(H))}%、任務三藍 {pct(three(H))}%）；高端桌 S≥55 {len(HS)} 局（{pct(win(HS))}%）；'
        f'高強度 S≥65 {len(HS65)} 局；自我對打 {len(Bt)} 局（{pct(win(Bt))}%、任務三藍 {pct(three(Bt))}%）\n')

    def row_of(st, key):
        x = st.get(key)
        if not x:
            return '—'
        return f'{pct(x["f"])}% ／ {pp(x["d"])} {ci(x["d_ci"])}'

    # 1. 任務結果槓桿
    say('### 任務結果槓桿（P(藍勝|成功) − P(藍勝|失敗)；頻率 = 走到這一局這個比數的局）\n')
    say('| 節點 | 真人 頻率／槓桿 [95%] | 高端桌 S≥55 | 自我對打 | 真人 期望擺動 |')
    say('|---|---|---|---|---|')
    mk = sorted([k for k in sh if k[0] == 'M'], key=lambda k: (k[1], k[2]))
    for k in mk:
        say(f'| {label(k)} | {row_of(sh, k)} | {row_of(ss, k)} | {row_of(sb, k)} | {pct(sh[k]["swing"])} |')
    say('')

    # 2. 刺殺
    say('### 刺殺：三藍局依任務順序（梅林活的比例 = 1 − 刺中率；期望擺動 = 頻率 × 1）\n')
    say('| 任務順序 | 真人 頻率 | 真人 梅林活 | 高端桌 梅林活 | 自我對打 頻率／梅林活 |')
    say('|---|---|---|---|---|')
    for k in sorted([k for k in sh if k[0] == 'A'], key=lambda k: -sh[k]['f']):
        x = sh[k]
        sx = ss.get(k)
        bx = sb.get(k)
        say(f'| {k[1]} | {pct(x["f"])}% | {pct(x["p1"])}%（n {x["n"]}） | {pct(sx["p1"]) + "%（n " + str(sx["n"]) + "）" if sx else "—"} | '
            f'{pct(bx["f"]) + "% ／ " + pct(bx["p1"]) + "%" if bx else "—"} |')
    say('')

    # 3. 全部決策點的排名
    # 排名只收兩個動作都常見的節點（少數那一邊 ≥ 5%），避免罕見動作的雜訊把節點排上去
    decision = [k for k in sh if k[0] in ('P', 'V', 'C', 'L', 'A', 'v') and min(sh[k]['p1'], 1 - sh[k]['p1']) >= 0.05]
    rank = sorted(decision, key=lambda k: -sh[k]['swing'])
    say(f'### 決策點排名（真人 期望擺動 = 頻率 × |差|，前 {args.top * 2}；個人票的差是單一張票的相關，不和整桌比大小）\n')
    say('| # | 節點 | 動作 1 ／ 0 | 真人 頻率 | 動作 1 比例 | 藍勝 1 ／ 0 | 差 [95%] | 期望擺動 [95%] | 實際擺動 | 高端桌 差 | 自我對打 頻率／差 |')
    say('|---|---|---|---|---|---|---|---|---|---|---|')
    for i, k in enumerate(rank[: args.top * 2], 1):
        x = sh[k]
        a1, a0 = act_names(k)
        sx = ss.get(k)
        bx = sb.get(k)
        say(f'| {i} | {label(k)} | {a1} ／ {a0} | {pct(x["f"])}% | {pct(x["p1"])}% | {pct(x["W1"])} ／ {pct(x["W0"])} | {pp(x["d"])} {ci(x["d_ci"])} | '
            f'{pct(x["swing"])} [{pct(x["swing_ci"][0])}, {pct(x["swing_ci"][1])}] | {pct(x["move"])} | {pp(sx["d"]) if sx else "—"} | '
            f'{pct(bx["f"]) + "% ／ " + pp(bx["d"]) if bx else "—"} |')
    say('')

    # 節點類型合計
    say('### 節點類型合計（真人；Σ 期望擺動 與 Σ 實際擺動）\n')
    say('| 類型 | 節點數 | Σ 期望擺動 | Σ 實際擺動 |')
    say('|---|---|---|---|')
    for t in ('M', 'P', 'V', 'C', 'L', 'A'):
        ks = [k for k in sh if k[0] == t]
        say(f'| {t} | {len(ks)} | {pct(sum(sh[k]["swing"] for k in ks))} | {pct(sum(sh[k]["move"] for k in ks))} |')
    say('')

    # 湖的歷史：第 3–5 局的節點再分第一湖的宣告
    sl = node_stats(H, collect_lake(H), args.boot, 4, min_cls=15)
    say('### 湖的歷史：第 3–5 局的任務結果槓桿與藍隊長提議，分第一湖（第 2 局後）的宣告（真人）\n')
    say('| 節點 | 頻率 | 動作 1 比例 | 差 [95%] | 期望擺動 |')
    say('|---|---|---|---|---|')
    for k in sorted(sl, key=lambda k: -sl[k]['swing'])[:16]:
        x = sl[k]
        say(f'| {label_lake(k)} | {pct(x["f"])}% | {pct(x["p1"])}% | {pp(x["d"])} {ci(x["d_ci"])} | {pct(x["swing"])} |')
    say('')

    # 4. 機器人 vs 強者
    rows = []
    for p in args.replay:
        rows += load(p)
    arows = []
    for p in args.replay_assassin:
        arows += load(p)
    out_json = {'human': {}, 'bot': {}, 'compare': {}}
    if rows:
        byg = {g['gi']: g for g in H}
        pts = replay_points(byg, rows)
        say('### 前 10 個決策點：機器人（現行預設）vs 強者，同一批真人決策點\n')
        say('（決策點 = S≥65 高強度局的那個座位；括號是 S≥55 高端桌。一致 = 完全相同的隊／票／目標；同類 = 動作 1／0 相同；'
            '選較好的動作 = 真人資料裡對自己陣營勝率比較好的那一邊；落差 = |差| ×（機器人沒選較好動作的比例 − 強者沒選的比例），bootstrap 95%）\n')
        say('| # | 節點 | 較好的動作 | n | 一致 % | 同類 % | 機器人選較好 % | 強者選較好 % | 落差（藍勝率，百分點）[95%] |')
        say('|---|---|---|---|---|---|---|---|---|')
        top = [k for k in rank if k[0] != 'v'][: args.top]
        extra = []
        for i, k in enumerate(top, 1):
            # 提議與表決：比較那個節點上做決定的個人（表決 → 該陣營的個人票）
            spots = [k]
            if k[0] == 'V':
                spots = [('v',) + k[1:] + ('blue',)]
            for sp in spots:
                if sp not in sh:
                    continue
                c65 = compare(sp, sh[sp], pts, 65, 1000, 10 + i)
                c55 = compare(sp, sh[sp], pts, 55, 1000, 30 + i)
                if not c55:
                    say(f'| {i} | {label(sp)} | — | 0 | — | — | — | — | — |')
                    continue
                c = c65 or c55
                fmt = lambda a, b2: f'{pct(a)}（{pct(b2)}）'
                say(f'| {i} | {label(sp)} | {c55["best"]} | {c65["n"] if c65 else 0}（{c55["n"]}） | {fmt(c["agree"], c55["agree"])} | '
                    f'{fmt(c["act_agree"], c55["act_agree"])} | {fmt(c["bot_best"], c55["bot_best"])} | {fmt(c["hum_best"], c55["hum_best"])} | '
                    f'{pp(c["gap"])} {ci(c["gap_ci"])}（{pp(c55["gap"])} {ci(c55["gap_ci"])}） |')
                out_json['compare'][label(sp)] = {'s65': {kk: v for kk, v in (c65 or {}).items()}, 's55': c55}
        say('')
        # 刺殺合併（全部三藍局）：機器人刺中率 vs 真人
        say('### 刺殺合併：同一批真人刺殺點，機器人刺客 vs 真人刺客的刺中率\n')
        say('| 範圍 | n | 真人刺中 % | 機器人刺中 % | 差（機器人 − 真人）[95%] | 一致 % |')
        say('|---|---|---|---|---|---|')
        rng = np.random.default_rng(7)
        for name, pred in (('S≥65', lambda k, s: s >= 65), ('S≥55', lambda k, s: s >= 55),
                           ('S≥55、第 2 局失敗（藍紅…）', lambda k, s: s >= 55 and k[1][:2] == '藍紅'),
                           ('S≥55、其他順序', lambda k, s: s >= 55 and k[1][:2] != '藍紅')):
            A = [(h, b, m) for k, h, b, m, s in pts if k[0] == 'A' and s is not None and pred(k, s)]
            if not A:
                continue
            h = np.array([1 - x[0] for x in A], dtype=float)
            b = np.array([1 - x[1] for x in A], dtype=float)
            idx = rng.integers(0, len(A), size=(2000, len(A)))
            dd = (b[idx] - h[idx]).mean(axis=1)
            say(f'| {name} | {len(A)} | {pct(h.mean())} | {pct(b.mean())} | {pp(b.mean() - h.mean())} {ci([np.percentile(dd, 2.5), np.percentile(dd, 97.5)])} | '
                f'{pct(np.mean([x[2] for x in A]))} |')
        say('')
        # 藍方個人票：第 3–5 局，分比數與隊上有沒有紅（S≥55）
        say('### 藍方個人票（第 3–5 局，S≥55 的決策點）：真人 vs 機器人的贊成率\n')
        say('| 局 | 比數 | 第幾次提議 | 隊上 | n | 真人贊成 % | 機器人贊成 % |')
        say('|---|---|---|---|---|---|---|')
        vacc = defaultdict(lambda: [0, 0, 0])
        for k, h, b, m, s in pts:
            if k[0] == 'v' and k[5] == 'blue' and k[1] >= 3 and s is not None and s >= 55:
                for kk in ((k[1], k[3], '全部', k[4]), (k[1], k[3], k[2], k[4])):
                    a = vacc[kk]
                    a[0] += 1
                    a[1] += h
                    a[2] += b
        for kk in sorted(vacc, key=lambda x: (x[0], x[1], str(x[2]), x[3])):
            n, h, b = vacc[kk]
            if n >= 40 and (kk[2] == '全部' or kk[1] in ('0:2', '1:2')):
                say(f'| {kk[0]} | {kk[1]} | {kk[2]} | {"有紅" if kk[3] == "dirty" else "沒紅"} | {n} | {pct(h / n)} | {pct(b / n)} |')
        say('')
        # 所有有重播的決策點裡，期望改進最大的（頻率 × 落差，S≥55）
        cand = []
        for k in sh:
            if k[0] not in ('P', 'v', 'C', 'L', 'A'):
                continue
            c55 = compare(k, sh[k], pts, 55, 300, 99)
            if not c55 or c55['n'] < 15:
                continue
            cand.append((sh[k]['f'] * c55['gap'], k, c55))
        cand.sort(key=lambda x: -x[0])
        say('### 機器人落後強者最多的節點（S≥55 的決策點；頻率 × 落差；n ≥ 15）\n')
        say('| 節點 | 真人 頻率 | 差 | 較好的動作 | n | 機器人選較好 % | 強者選較好 % | 落差 [95%] | 頻率 × 落差 |')
        say('|---|---|---|---|---|---|---|---|---|')
        for v, k, c in cand[:15]:
            say(f'| {label(k)} | {pct(sh[k]["f"])}% | {pp(sh[k]["d"])} | {c["best"]} | {c["n"]} | {pct(c["bot_best"])} | {pct(c["hum_best"])} | '
                f'{pp(c["gap"])} {ci(c["gap_ci"])} | {100 * v:+.2f} |')
        say('')

    if arows:
        byg = {g['gi']: g for g in H}
        apts = [p for p in replay_points(byg, [d for d in arows if d['type'] == 'assassinate'])]
        say('### 刺殺：全部真人局的刺殺點（只重播刺客座位），機器人刺客 vs 真人刺客，依任務順序\n')
        say('| 任務順序 | n | 真人刺中 % | 機器人刺中 % | 差（機器人 − 真人）[95%] |')
        say('|---|---|---|---|---|')
        rng = np.random.default_rng(8)
        groups = defaultdict(list)
        for k, h, b, m, s in apts:
            groups['全部'].append((1 - h, 1 - b))
            groups['第 1 局成功、第 2 局失敗（藍紅…）' if k[1][:2] == '藍紅' else '其他順序'].append((1 - h, 1 - b))
            groups[k[1]].append((1 - h, 1 - b))
        for name in sorted(groups, key=lambda x: -len(groups[x])):
            a = np.array(groups[name], dtype=float)
            if len(a) < 30:
                continue
            idx = rng.integers(0, len(a), size=(2000, len(a)))
            dd = (a[idx, 1] - a[idx, 0]).mean(axis=1)
            say(f'| {name} | {len(a)} | {pct(a[:, 0].mean())} | {pct(a[:, 1].mean())} | {pp(a[:, 1].mean() - a[:, 0].mean())} '
                f'{ci([np.percentile(dd, 2.5), np.percentile(dd, 97.5)])} |')
        say('')

    strip = lambda st: {label(k): {kk: v for kk, v in x.items() if not kk.startswith('_')} for k, x in st.items()}
    out_json['human'] = strip(sh)
    out_json['strong55'] = strip(ss)
    out_json['bot'] = strip(sb)
    text = '\n'.join(L)
    if args.md:
        with open(args.md, 'w', encoding='utf8') as fh:
            fh.write(text + '\n')
    if args.json:
        with open(args.json, 'w', encoding='utf8') as fh:
            json.dump(out_json, fh, ensure_ascii=False, indent=1)
    sys.stdout.write(text + '\n')


if __name__ == '__main__':
    main()
