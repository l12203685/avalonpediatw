#!/usr/bin/env python3
"""第 73 回合（節點分支的拆解）：第 60 回合的局勢樹節點表，在現行基準線與真人桌讀法上重算，並往下多分一層。

輸入（都只有座位、角色、隊伍、票、任務牌、湖、刺殺，沒有玩家名）：
  --human h.jsonl          真人局（`keySpotStudy.ts --export-human`）
  --bot b.jsonl            自我對打（`keySpotStudy.ts --export-bot`，現行基準線 detail=1）
  --replay A=rep_A.jsonl H=rep_H.jsonl
                           同一批真人決策點的機器人（`humanPrBenchmark.ts --dump` → `keySpotStudy73.ts`；A = 基準線、
                           H = 真人桌讀法，每一桌照自己的強度層），每列帶人類 PR 量尺的優勢 h／b

節點、動作、頻率 f、差 Δ、期望擺動 f × |Δ| 的定義同 `keySpotStudy.py`（第 60 回合）。本檔加的：
  1. 每個節點在「全部真人決策點」與「高端桌 S ≥ 55 的決策點」上，機器人（A、H）和真人各自選到較好動作的比例，
     落差 = |Δ| ×（機器人沒選較好動作的比例 − 真人沒選的比例），頻率 × 落差 = f × 落差（藍勝率百分點／局；紅方節點是紅方的損失）。
  2. 同一個節點的人類 PR 量尺落差（第 1H 節）：Σ（機器人優勢 − 真人優勢）÷ 全部真人局數，pp／局 ± 標準誤（以局為集群）。
     個人票只用這一把尺排（每張票的 Δ 是單一張票的相關，不能直接乘頻率）。
  3. 往下多分一層（n 夠的才列）：到這一局為止的任務順序、第一湖（第 2 局後）的宣告、隊長之前在不在失敗的任務隊上、
     投票者在不在隊上；刺殺另外分桌上強度層。
  4. 「頻率 × 落差」與量尺兩張排名，標出第 56–72 回合處理過哪些節點。

  python3 scripts/keySpotStudy73.py --human h.jsonl --bot b.jsonl --replay A=rep_A.jsonl H=rep_H.jsonl --md out.md
"""
import argparse
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import keySpotStudy as ks  # noqa: E402

RED = ks.RED
camp = ks.camp
CAMP = ks.CAMP


def path_before(g, r):
    """到第 r 局之前的任務順序（藍 = 成功、紅 = 失敗），例：'藍紅'。"""
    return ''.join('紅' if ks.mission_failed(q[0], q[2]) else '藍' for q in g['quests'] if q[0] < r)


def failed_before(g, r):
    out = set()
    for q in g['quests']:
        if q[0] < r and ks.mission_failed(q[0], q[2]):
            out.update(q[1])
    return out


def lake1(g):
    l = next((x for x in g['lakes'] if x[0] == 2), None)
    if l is None or l[3] not in ('o', 'x'):
        return '沒有湖'
    return '湖說藍' if l[3] == 'o' else '湖說紅'


def tier_of(s):
    if s is None:
        return 'S不明'
    return '弱桌' if s < 38 else '一般桌' if s < 55 else '強桌'


def sub_tags(g, key, leader=None, on=None):
    """這個節點往下多分一層的標籤（都是公開資訊）。"""
    t = key[0]
    tags = []
    if t in ('P', 'v', 'M', 'C'):
        r = key[1]
        if r >= 3:
            tags.append('順序 ' + path_before(g, r))
            tags.append(lake1(g))
        if t == 'P' and r >= 2 and leader is not None:
            tags.append('隊長出過失敗任務' if leader in failed_before(g, r) else '隊長沒出過失敗任務')
        if t == 'v' and on is not None:
            tags.append('在隊上' if on else '不在隊上')
    elif t == 'A':
        tags.append(lake1(g))
        tags.append(tier_of(g.get('s')))
    return tags


def nodes73(g):
    """(key, action) 同第 60 回合，再加 (key + (tag,), action) 的下一層。"""
    roles = g['roles']
    red = lambda s: roles[s - 1] in RED
    sc = ks.score_before(g)
    out = []

    def add(key, act, **kw):
        out.append((key, act))
        for tag in sub_tags(g, key, **kw):
            out.append((key + (tag,), act))

    for r, a, leader, team, appr, forced, went in g['props']:
        if r not in sc:
            continue
        b, f = sc[r]
        s = f'{b}:{f}'
        dirty = sum(red(x) for x in team) >= ks.need(r)
        add(('P', r, a, s, camp(roles[leader - 1])), 0 if dirty else 1, leader=leader)
        if not forced:
            add(('V', r, a, s, 'dirty' if dirty else 'clean'), 1 if went else 0)
            if appr is not None:
                ap = set(appr)
                for seat in range(1, 11):
                    if seat == leader:
                        continue
                    add(('v', r, a, s, 'dirty' if dirty else 'clean', camp(roles[seat - 1])), 1 if seat in ap else 0, on=seat in team)
    for r, team, fails in g['quests']:
        b, f = sc[r]
        s = f'{b}:{f}'
        ok = 0 if ks.mission_failed(r, fails) else 1
        add(('M', r, s), ok)
        if sum(red(x) for x in team) >= ks.need(r):
            add(('C', r, s), ok)
    for k, holder, target, claim in g['lakes']:
        b, f = sc.get(k + 1, sc['end'])
        s = f'{b}:{f}'
        if not red(holder):
            add(('L', k, s, 'blue'), 0 if red(target) else 1)
        elif claim in ('o', 'x'):
            truth = 'x' if red(target) else 'o'
            add(('L', k, s, 'red'), 1 if claim == truth else 0)
    if g['out'] != 'red3':
        add(('A', ks.seq_label(g)), 1 if g['out'] == 'blueAlive' else 0)
        add(('A', '全部'), 1 if g['out'] == 'blueAlive' else 0)
    return out


def collect(games):
    acc = defaultdict(lambda: ([], []))
    for i, g in enumerate(games):
        for key, act in nodes73(g):
            acc[key][0].append(i)
            acc[key][1].append(act)
    return {k: (np.array(v[0]), np.array(v[1], dtype=float)) for k, v in acc.items()}


BASE_LEN = {'P': 5, 'V': 5, 'v': 6, 'M': 3, 'C': 3, 'L': 4, 'A': 2}


def is_sub(key):
    return len(key) > BASE_LEN[key[0]]


def label(key):
    if key[0] == 'A' and key[1] == '全部':
        base = '刺殺（全部三藍局）'
    else:
        base = ks.label(key[:BASE_LEN[key[0]]])
    return base + (f'・{key[-1]}' if is_sub(key) else '')


def replay_points(byg, rows):
    """重播的決策點 → (key, 真人動作, 機器人動作, 完全一致, s, gi, 量尺 h, 量尺 b)；每個點同時算在節點與它的下一層。"""
    out = []
    seats = lambda x: [int(v) for v in str(x).split(',') if v]
    for d in rows:
        g = byg.get(d['gi'])
        if g is None:
            continue
        roles = g['roles']
        red = lambda s: roles[s - 1] in RED
        sc = ks.score_before(g)
        t = d['type']
        r = d['round']
        key = None
        kw = {}
        ha = ba = 0
        same = d['human'] == d['agent']
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
                ha = 0 if sum(red(x) for x in ht) >= ks.need(r) else 1
                ba = 0 if sum(red(x) for x in bt) >= ks.need(r) else 1
                same = sorted(ht) == sorted(bt)
                kw = dict(leader=d['seat'])
            else:
                if d['seat'] == prop[2] or prop[5] or not d.get('rel', 1):
                    continue
                dirty = sum(red(x) for x in prop[3]) >= ks.need(r)
                key = ('v', r, d['attempt'], s, 'dirty' if dirty else 'clean', camp(roles[d['seat'] - 1]))
                ha = 1 if d['human'] == 'approve' else 0
                ba = 1 if d['agent'] == 'approve' else 0
                kw = dict(on=d['seat'] in prop[3])
        elif t == 'quest':
            q = next((x for x in g['quests'] if x[0] == r), None)
            if q is None or sum(red(x) for x in q[1]) < ks.need(r):
                continue
            b, f = sc[r]
            key = ('C', r, f'{b}:{f}')
            ha = 1 if d['human'] == 'success' else 0
            ba = 1 if d['agent'] == 'success' else 0
        elif t == 'lakeTarget':
            if red(d['seat']) or not str(d['agent']).isdigit():
                continue
            b, f = sc.get(r + 1, sc['end'])
            key = ('L', r, f'{b}:{f}', 'blue')
            ha = 0 if red(int(d['human'])) else 1
            ba = 0 if red(int(d['agent'])) else 1
        elif t == 'lakeClaim':
            if not red(d['seat']):
                continue
            lake = next((l for l in g['lakes'] if l[0] == r), None)
            if lake is None:
                continue
            b, f = sc.get(r + 1, sc['end'])
            truth = 'evil' if red(lake[2]) else 'good'
            key = ('L', r, f'{b}:{f}', 'red')
            ha = 1 if d['human'] == truth else 0
            ba = 1 if d['agent'] == truth else 0
        elif t == 'assassinate':
            if g['out'] == 'red3' or not str(d['agent']).isdigit():
                continue
            merlin = roles.index('merlin') + 1
            ha = 0 if int(d['human']) == merlin else 1
            ba = 0 if int(d['agent']) == merlin else 1
            for key in (('A', ks.seq_label(g)), ('A', '全部')):
                out.append((key, ha, ba, same, d['s'], d['gi'], d['h'], d['b']))
                for tag in sub_tags(g, key):
                    out.append((key + (tag,), ha, ba, same, d['s'], d['gi'], d['h'], d['b']))
            continue
        if key is None:
            continue
        out.append((key, ha, ba, same, d['s'], d['gi'], d['h'], d['b']))
        for tag in sub_tags(g, key, **kw):
            out.append((key + (tag,), ha, ba, same, d['s'], d['gi'], d['h'], d['b']))
    return out


def index_points(pts):
    by = defaultdict(list)
    for p in pts:
        by[p[0]].append(p[1:])
    return {k: np.array([(h, b, m, -1 if s is None else s, gi, yh, yb) for h, b, m, s, gi, yh, yb in v], dtype=float) for k, v in by.items()}


def compare(key, hstat, P, smin, n_games, rng, B=600):
    """一個節點：選較好動作的比例（真人／機器人）、落差與 95% 區間、量尺落差（pp／局 ± 標準誤）。"""
    if P is None or len(P) == 0:
        return None
    if smin is not None:
        P = P[P[:, 3] >= smin]
    n = len(P)
    if n == 0:
        return None
    h, b, m = P[:, 0], P[:, 1], P[:, 2]
    d = hstat['d']
    c = ks.actor_camp(key[:BASE_LEN[key[0]]])
    best1 = (d > 0) if c != 'red' else (d < 0)
    good = (lambda a: a) if best1 else (lambda a: 1 - a)
    gh, gb = good(h), good(b)
    gap = abs(d) * (gh.mean() - gb.mean())
    idx = rng.integers(0, n, size=(B, n))
    gbt = abs(d) * (gh[idx].mean(axis=1) - gb[idx].mean(axis=1))
    # 量尺：每一局的 Σ(b − h)，除以全部真人局數（沒有這個節點的局算 0）
    diff = P[:, 6] - P[:, 5]
    per = defaultdict(float)
    for gi, x in zip(P[:, 4], diff):
        per[gi] += x
    v = np.array(list(per.values()))
    yard = v.sum() / n_games
    se = np.sqrt(max((np.square(v).sum() - n_games * yard * yard), 0) / max(n_games - 1, 1) / n_games)
    names = ks.act_names(key[:BASE_LEN[key[0]]])
    return dict(n=n, agree=float(m.mean()), hum=float(gh.mean()), bot=float(gb.mean()), gap=float(gap),
                ci=[float(np.percentile(gbt, 2.5)), float(np.percentile(gbt, 97.5))], yard=float(yard), se=float(se),
                best=names[0 if best1 else 1])


# ─── 第 56–72 回合處理過的節點 ───────────────────────────────────────────────

def handled(key):
    t = key[0]
    if t == 'A':
        return ('61（藍紅… 的讀法倍數，真人桌採用）、' if key[1].startswith('藍紅') or key[1] == '全部' else '') + '71（看得到的紅的參照，不過）、73（本回合）'
    if t == 'C':
        if key[1] == 2 and key[2] == '1:0':
            return '61（落單的紅照真人比例出牌，真人桌採用）'
        if key[1] == 1:
            return '64（奧伯倫第 1 局一律出失敗，不採用）'
        if key[1] == 4:
            return '67（第 4 局落單的紅，待站長裁定）'
        return ''
    if t == 'L':
        return '68（信任鏈少湖出過失敗任務的人，真人桌採用）' if key[3] == 'blue' else ''
    if t == 'P':
        _, r, a, s, c = key[:5]
        if c == 'red':
            return '65（第 3、5 局少疊隊友，基準線採用）' if r >= 3 else ''
        if r == 1 and a == 5:
            return '62（1-5 尾派，不採用）'
        if r == 2 and a == 5 and s == '0:1':
            return '62（2-5 尾派，不採用）'
        if r == 2 and s == '0:1':
            return '72（第 2 局第 1 局失敗之後的提議，不採用）' + ('；真人桌 56/57（照第 5 次派）' if a <= 4 else '')
        if r <= 2:
            return '56/57（真人桌照第 5 次派）、58/64/70（梅林的拇指）'
        if r == 5:
            return '70（第 5 局挑隊的讀法，不採用）'
        return ''
    if t == 'v':
        _, r, a, s, d, c = key[:6]
        if c == 'blue':
            if r == 2:
                return '66（第 2 局在隊上的內黑，真人桌派西／梅林採用）'
            if r >= 3:
                return '59（第 4 局在隊上照字面讀，真人桌採用）、63（G1，不採用）'
            return ''
        if r <= 2:
            return '67（相認紅第 2 局在隊上的內黑，基準線採用）'
        if r == 3 and s == '0:2':
            return '69（紅方已兩勝的關鍵隊外白，真人桌採用）、65（奧伯倫照雜魚投票）'
        if r == 5:
            return '71（隊上一定有紅時外白，真人桌採用）、65（奧伯倫）'
        return '65（奧伯倫照雜魚投票，真人桌採用）'
    return ''


# ─── 輸出 ────────────────────────────────────────────────────────────────────

pct = ks.pct
pp = ks.pp


def ci2(c):
    return f'[{100 * c[0]:+.1f}, {100 * c[1]:+.1f}]'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--human', required=True)
    ap.add_argument('--bot')
    ap.add_argument('--replay', nargs='*', default=[], help='NAME=path（A = 基準線、H = 真人桌讀法）')
    ap.add_argument('--md')
    ap.add_argument('--boot', type=int, default=1000)
    ap.add_argument('--top', type=int, default=25)
    args = ap.parse_args()

    H = ks.load(args.human)
    HS = [g for g in H if g['s'] is not None and g['s'] >= 55]
    Bt = ks.load(args.bot) if args.bot else []
    N = len(H)
    L = []
    say = L.append
    win = lambda gs: sum(g['out'] == 'blueAlive' for g in gs) / max(len(gs), 1)
    three = lambda gs: sum(g['out'] != 'red3' for g in gs) / max(len(gs), 1)
    kill = lambda gs: sum(g['out'] == 'blueDead' for g in gs) / max(sum(g['out'] != 'red3' for g in gs), 1)
    say(f'真人 {N} 局（藍勝 {pct(win(H))}%、任務三藍 {pct(three(H))}%、刺中 {pct(kill(H))}%）；高端桌 S≥55 {len(HS)} 局（藍勝 {pct(win(HS))}%）；'
        f'自我對打（現行基準線）{len(Bt)} 局（藍勝 {pct(win(Bt))}%、任務三藍 {pct(three(Bt))}%、刺中 {pct(kill(Bt))}%）\n')

    sh = ks.node_stats(H, collect(H), args.boot, 1, 15)
    ss = ks.node_stats(HS, collect(HS), min(args.boot, 400), 2, 8)
    sb = ks.node_stats(Bt, collect(Bt), 200, 3, 30) if Bt else {}
    byg = {g['gi']: g for g in H}
    reps = {}
    for spec in args.replay:
        name, path = spec.split('=', 1)
        reps[name] = index_points(replay_points(byg, ks.load(path)))
        say(f'機器人在真人決策點（{name}）：{sum(len(v) for k, v in reps[name].items() if not is_sub(k) and k != ("A", "全部"))} 個決策點')
    say('')
    names = list(reps)
    rng = np.random.default_rng(73)

    def cmp_all(key, smin=None):
        if key not in sh:
            return {}
        return {nm: compare(key, sh[key], reps[nm].get(key), smin, N, rng) for nm in names}

    # 1. 任務結果槓桿，再分任務順序／第一湖
    say('## 1. 任務結果槓桿（P(藍勝 | 成功) − P(藍勝 | 失敗)），往下分任務順序與第一湖\n')
    say('| 節點 | 真人 頻率／槓桿 [95%] | 期望擺動 | 高端桌 槓桿 | 自我對打 頻率／槓桿 |')
    say('|---|---|---|---|---|')
    row = lambda st, k: (f'{pct(st[k]["f"])}% ／ {pp(st[k]["d"])} {ci2(st[k]["d_ci"])}' if k in st else '—')
    short = lambda st, k: (f'{pct(st[k]["f"])}% ／ {pp(st[k]["d"])}' if k in st else '—')
    for k in sorted([k for k in sh if k[0] == 'M'], key=lambda k: (k[1], k[2], len(k), str(k[-1]))):
        if is_sub(k) and sh[k]['f'] < 0.04:
            continue
        say(f'| {"　" if is_sub(k) else ""}{label(k)} | {row(sh, k)} | {pct(sh[k]["swing"])} | {pp(ss[k]["d"]) if k in ss else "—"} | {short(sb, k)} |')
    say('')

    # 2. 刺殺
    say('## 2. 刺殺：任務順序 × 第一湖 × 桌上強度層（同一批真人刺殺點）\n')
    say('| 節點 | 真人 頻率 | n | 真人刺中 % | 機器人 A % | 機器人 H % | 落差 A [95%] | 落差 H [95%] | 頻率 × 落差 A／H | 自我對打 頻率／刺中 % |')
    say('|---|---|---|---|---|---|---|---|---|---|')
    akeys = [k for k in sh if k[0] == 'A']
    for k in sorted(akeys, key=lambda k: (-sh[k[:2]]['f'] if k[:2] in sh else 0, len(k), str(k[-1]))):
        c = cmp_all(k)
        ca, ch = c.get('A'), c.get('H')
        if not ca or ca['n'] < (25 if is_sub(k) else 20):
            continue
        f = sh[k]['f']
        bx = sb.get(k)
        say(f'| {"　" if is_sub(k) else ""}{label(k)} | {pct(f)}% | {ca["n"]} | {pct(ca["hum"])} | {pct(ca["bot"])} | {pct(ch["bot"]) if ch else "—"} | '
            f'{pp(ca["gap"])} {ci2(ca["ci"])} | {(pp(ch["gap"]) + " " + ci2(ch["ci"])) if ch else "—"} | {100 * f * ca["gap"]:+.2f}／{100 * f * ch["gap"] if ch else 0:+.2f} | '
            f'{(pct(bx["f"]) + "% ／ " + pct(1 - bx["p1"])) if bx else "—"} |')
    say('')

    # 3. 頻率 × 落差排名（提議、任務牌、湖、刺殺）
    def rank_rows(pred, smin=None, min_n=40):
        rows = []
        for k in sh:
            if not pred(k) or min(sh[k]['p1'], 1 - sh[k]['p1']) < 0.05:
                continue
            c = cmp_all(k, smin)
            if not c.get('A') or c['A']['n'] < min_n:
                continue
            rows.append((k, c))
        return rows

    def table(title, rows, sort_name, top, note=''):
        say(f'### {title}\n')
        if note:
            say(note + '\n')
        say('| # | 節點 | 真人 頻率 | 差 Δ | 期望擺動 | 較好的動作 | n | 真人選較好 % | A % | H % | 落差 A [95%] | 落差 H [95%] | **頻率 × 落差 A／H** | 量尺 A／H（pp／局 ± 標準誤） | 處理過的回合 |')
        say('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
        rows = sorted(rows, key=lambda x: -sh[x[0]]['f'] * x[1][sort_name]['gap'])
        for i, (k, c) in enumerate(rows[:top], 1):
            x = sh[k]
            a, h = c['A'], c.get('H') or c['A']
            say(f'| {i} | {label(k)} | {pct(x["f"])}% | {pp(x["d"])} | {pct(x["swing"])} | {a["best"]} | {a["n"]} | {pct(a["hum"])} | {pct(a["bot"])} | {pct(h["bot"])} | '
                f'{pp(a["gap"])} {ci2(a["ci"])} | {pp(h["gap"])} {ci2(h["ci"])} | **{100 * x["f"] * a["gap"]:+.2f}／{100 * x["f"] * h["gap"]:+.2f}** | '
                f'{100 * a["yard"]:+.2f} ± {100 * a["se"]:.2f}／{100 * h["yard"]:+.2f} ± {100 * h["se"]:.2f} | {handled(k)} |')
        say('')

    base = lambda k: not is_sub(k) and k != ('A', '全部')
    say('## 3. 排名：頻率 × 落差（正 = 機器人比真人差；單位是那一方的勝率百分點／局）\n')
    table(f'3.1 全部真人決策點（提議、任務牌、湖、刺殺；照真人桌讀法 H 排，前 {args.top}）',
          rank_rows(lambda k: base(k) and k[0] in ('P', 'C', 'L', 'A')), 'H', args.top,
          '個人票不在這張表（單一張票的 Δ 是相關，不能乘頻率），看 3.3 的量尺。')
    table('3.2 高端桌 S ≥ 55 的決策點（同一張表，機器人 vs 強者；前 15）',
          rank_rows(lambda k: base(k) and k[0] in ('P', 'C', 'L', 'A'), 55, 25), 'H', 15)

    # 3.3 量尺排名（含個人票）
    say('### 3.3 人類 PR 量尺的落差（全部節點，含個人票；負 = 機器人比真人差；照 H 排，最負的 25 格）\n')
    say('| # | 節點 | 決策點 | 量尺 A（pp／局 ± 標準誤） | 量尺 H | 真人／A／H 選較好 % | 處理過的回合 |')
    say('|---|---|---|---|---|---|---|')
    yr = []
    for k in sh:
        if not base(k) or k[0] not in ('P', 'v', 'C', 'L', 'A'):
            continue
        c = cmp_all(k)
        if c.get('A') and c.get('H') and c['A']['n'] >= 40:
            yr.append((k, c))
    tot = {nm: sum(c[nm]['yard'] for k, c in yr) for nm in names}
    for i, (k, c) in enumerate(sorted(yr, key=lambda x: x[1]['H']['yard'])[:25], 1):
        a, h = c['A'], c['H']
        say(f'| {i} | {label(k)} | {a["n"]} | {100 * a["yard"]:+.2f} ± {100 * a["se"]:.2f} | {100 * h["yard"]:+.2f} ± {100 * h["se"]:.2f} | '
            f'{pct(a["hum"])}／{pct(a["bot"])}／{pct(h["bot"])} | {handled(k)} |')
    say('')
    say('節點類型合計（量尺，pp／局；n ≥ 40 的節點）：' + '；'.join(
        f'{nm}：' + '、'.join(f'{t} {100 * sum(c[nm]["yard"] for k, c in yr if k[0] == t):+.2f}' for t in ('P', 'v', 'C', 'L', 'A')) + f'，合計 {100 * tot[nm]:+.2f}'
        for nm in names) + '\n')

    # 4. 往下多分一層：前幾名節點的分支
    say('## 4. 往下多分一層：頻率 × 落差前幾名的節點與落差最大的分支\n')
    say('| 節點・分支 | 真人 頻率 | 差 Δ | n | 真人選較好 % | A % | H % | 落差 A [95%] | 落差 H [95%] | 頻率 × 落差 H | 量尺 H（pp／局） |')
    say('|---|---|---|---|---|---|---|---|---|---|---|')
    parents = [k for k, c in sorted(rank_rows(lambda k: base(k) and k[0] in ('P', 'C', 'L')), key=lambda x: -sh[x[0]]['f'] * x[1]['H']['gap'])[:10]]
    for pk in parents:
        subs = [k for k in sh if is_sub(k) and k[:BASE_LEN[k[0]]] == pk]
        for k in [pk] + sorted(subs, key=lambda k: str(k[-1])):
            c = cmp_all(k)
            if not c.get('A') or c['A']['n'] < 40:
                continue
            a, h = c['A'], c.get('H') or c['A']
            x = sh[k]
            say(f'| {"　" if is_sub(k) else ""}{label(k)} | {pct(x["f"])}% | {pp(x["d"])} | {a["n"]} | {pct(a["hum"])} | {pct(a["bot"])} | {pct(h["bot"])} | '
                f'{pp(a["gap"])} {ci2(a["ci"])} | {pp(h["gap"])} {ci2(h["ci"])} | {100 * x["f"] * h["gap"]:+.2f} | {100 * h["yard"]:+.2f} ± {100 * h["se"]:.2f} |')
    say('')
    # 分支裡落差最大的（全部節點的下一層）
    table('4.1 下一層的分支裡頻率 × 落差最大的（全部真人決策點，n ≥ 60；前 15）',
          rank_rows(lambda k: is_sub(k) and k[0] in ('P', 'C', 'L'), None, 60), 'H', 15)

    # 5. 個人票：分在不在隊上
    say('## 5. 個人票（第 2 局起），分在不在隊上：量尺最負的 15 格\n')
    say('| 節點・分支 | 決策點 | 真人贊成 % | A 贊成 % | H 贊成 % | 量尺 A（pp／局） | 量尺 H | 處理過的回合 |')
    say('|---|---|---|---|---|---|---|---|')
    vr = []
    for k in sh:
        if k[0] != 'v' or not is_sub(k) or k[-1] not in ('在隊上', '不在隊上') or k[1] < 2:
            continue
        PA, PH = reps[names[0]].get(k), reps[names[-1]].get(k)
        if PA is None or PH is None or len(PA) < 100:
            continue
        c = cmp_all(k)
        vr.append((k, c, PA[:, 0].mean(), PA[:, 1].mean(), PH[:, 1].mean()))
    for k, c, hm, am, hm2 in sorted(vr, key=lambda x: x[1][names[-1]]['yard'])[:15]:
        a, h = c[names[0]], c[names[-1]]
        say(f'| {label(k)} | {a["n"]} | {pct(hm)} | {pct(am)} | {pct(hm2)} | {100 * a["yard"]:+.2f} ± {100 * a["se"]:.2f} | {100 * h["yard"]:+.2f} ± {100 * h["se"]:.2f} | {handled(k)} |')
    say('')

    # 5.1 公開的局面格（隊上有沒有紅是真相，投票的人不知道）：有紅、沒紅合起來
    say('### 5.1 同一批票照公開的局面合起來（局 × 第幾次 × 比數 × 陣營 × 在不在隊上；隊上有紅、沒紅合計），量尺最負的 15 格\n')
    say('用「隊上有沒有紅」分格是用真相切的：機器人比較嚴的格子，沒紅的那一半是負的、有紅的那一半是正的，要合起來才是投票的人面對的決策點。\n')
    say('| 局面 | 決策點 | 真人贊成 % | A 贊成 % | H 贊成 % | 其中隊上有紅：真人／A／H 贊成 % | 沒紅：真人／A／H 贊成 % | 量尺 A（pp／局） | 量尺 H |')
    say('|---|---|---|---|---|---|---|---|---|')
    pub = defaultdict(lambda: {nm: [] for nm in names})
    for nm in names:
        for k, P in reps[nm].items():
            if k[0] == 'v' and is_sub(k) and k[-1] in ('在隊上', '不在隊上') and k[1] >= 2:
                pub[(k[1], k[2], k[3], k[5], k[-1])][nm].append((k[4], P))
    prow = []
    pn = lambda x: "—" if x != x else pct(x)
    for k, d in pub.items():
        st = {}
        for nm in names:
            P = np.concatenate([x for _, x in d[nm]])
            diff = P[:, 6] - P[:, 5]
            per = defaultdict(float)
            for gi, x in zip(P[:, 4], diff):
                per[gi] += x
            v = np.array(list(per.values()))
            yard = v.sum() / N
            se = np.sqrt(max(np.square(v).sum() - N * yard * yard, 0) / (N - 1) / N)
            part = {c: x for c, x in d[nm]}
            st[nm] = dict(n=len(P), hum=P[:, 0].mean(), bot=P[:, 1].mean(), yard=yard, se=se,
                          dirty=(part['dirty'][:, 0].mean(), part['dirty'][:, 1].mean()) if 'dirty' in part else (float('nan'),) * 2,
                          clean=(part['clean'][:, 0].mean(), part['clean'][:, 1].mean()) if 'clean' in part else (float('nan'),) * 2)
        if st[names[0]]['n'] >= 200:
            prow.append((k, st))
    for k, st in sorted(prow, key=lambda x: x[1][names[-1]]['yard'])[:15]:
        a, h = st[names[0]], st[names[-1]]
        say(f'| {k[0]}-{k[1]} {CAMP[k[3]]}方（{k[2]}）・{k[4]} | {a["n"]} | {pct(a["hum"])} | {pct(a["bot"])} | {pct(h["bot"])} | {pn(a["dirty"][0])}／{pn(a["dirty"][1])}／{pn(h["dirty"][1])} | '
            f'{pn(a["clean"][0])}／{pn(a["clean"][1])}／{pn(h["clean"][1])} | {100 * a["yard"]:+.2f} ± {100 * a["se"]:.2f} | {100 * h["yard"]:+.2f} ± {100 * h["se"]:.2f} |')
    say('')

    text = '\n'.join(L)
    if args.md:
        with open(args.md, 'w', encoding='utf8') as fh:
            fh.write(text + '\n')
    sys.stdout.write(text + '\n')


if __name__ == '__main__':
    main()
