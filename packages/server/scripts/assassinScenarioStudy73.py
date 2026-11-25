#!/usr/bin/env python3
"""第 73 回合（紅方・刺客）：刺殺節點的情境分析——把同一批真人刺殺點照情境類別拆開，比真人刺客與機器人刺客。

輸入（都只有座位、角色、隊伍、票、任務牌、湖、刺殺與分數，沒有玩家名）：
  --human h.jsonl            真人局（`keySpotStudy.ts --export-human`）
  --base  hA.jsonl           真人刺殺點、現行的機器人刺客（`assassinPathStudy.ts --export-human [--flag …]`）
  --alt   NAME=hA_x.jsonl …  同一批刺殺點、另一組開關（--part paths 多列一欄；--part cands 當候選比）

--part：
  paths   任務順序 × 桌上強度層：真人／機器人的刺中率、梅林在不在分層的第一層、兩邊的目標是什麼角色。
  lifts   候選人的公開特徵（出過哪些任務、派過乾淨的隊、票、湖、拇指）：有這個特徵的候選人是梅林的比例、
          真人與機器人的目標有這個特徵的比例、選到這種人時各自的刺中率。--order 只看一種任務順序。
  tier    分層（`assassinVisibleRedTier`、`assassinDoomedRead`）的證據照「哪一局、哪一種提議」拆：只有這一種證據的候選人是梅林的比例、
          因此被排到第二層的梅林數、真人在那些點刺中幾個。
  cells   全部真人局（不只刺殺點）的提議與票照「局 × 隊伍組成」分格：梅林和其他藍方各自的比例與概似比。
          隊伍組成用梅林的視野：乾淨／只有莫德雷德／一個看得到的紅／一個看得到的紅＋莫德雷德／兩個以上。
  cands   候選（--alt）對現行（--base）：刺中率的差、bootstrap 95%、偶數號／奇數號、分任務順序與強度層。
  ablate  刺殺分數的各項（模型、投票、隊長、照派）拿掉，或換成 cells 的分格概似比（偶數號的局擬合 → 奇數號的刺殺點，反過來也一樣）：
          這份紀錄上刺中率的上限在哪裡。

  python3 scripts/assassinScenarioStudy73.py --human h.jsonl --base hA_H.jsonl --part paths
"""
import argparse
import json
import math
from collections import Counter, defaultdict

import numpy as np

RED = {'assassin', 'morgana', 'mordred', 'oberon'}


def load(p):
    with open(p, encoding='utf8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def mf(r, f):
    return f >= (2 if r == 4 else 1)


def tier_of(s):
    return 'S不明' if s is None else '弱桌' if s < 38 else '一般桌' if s < 55 else '強桌'


def zh(order):
    return order.replace('B', '藍').replace('R', '紅')


# ─── 候選人的公開特徵 ────────────────────────────────────────────────────────

def feats(g):
    """每個藍方座位在刺殺時的公開特徵（紅方已經開牌：誰是紅、梅林看得到誰都知道）。"""
    roles = g['roles']
    red = {i + 1 for i, r in enumerate(roles) if r in RED}
    seen = {i + 1 for i, r in enumerate(roles) if r in RED and r != 'mordred'}
    morg = roles.index('morgana') + 1
    quests = {r: (set(t), f) for r, t, f in g['quests']}
    out = {}
    for c in range(1, 11):
        if c in red:
            continue
        f = Counter()
        for r, (t, fl) in quests.items():
            if c in t:
                f['onFail' if mf(r, fl) else 'onSucc'] += 1
        f['nFail'] = sum(1 for r, (t, fl) in quests.items() if mf(r, fl))
        for r, a, leader, team, appr, forced, went in g['props']:
            ts = set(team)
            nred, nseen = len(ts & red), len(ts & seen)
            if leader == c:
                f['led'] += 1
                if nred == 0:
                    f['ledClean'] += 1
                    if r >= 3:
                        f['led3Clean'] += 1
                if nseen == 0 and nred > 0:
                    f['ledMordOnly'] += 1
                if nseen > 0:
                    f['ledSeen'] += 1
                if morg in ts:
                    f['ledMorg'] += 1
                if went and r in quests:
                    f['ledMFail' if mf(r, quests[r][1]) else 'ledMSucc'] += 1
            elif leader not in red and c in ts:
                f['picked'] += 1
                if morg in ts:
                    f['pickedWithMorg'] += 1
            if appr is not None and leader != c:
                v = c in appr
                if c not in ts:
                    if nseen > 0 and v:
                        f['offApprSeen'] += 1
                    if nred == 0 and not v:
                        f['offRejClean'] += 1
                        if r >= 3:
                            f['off3RejClean'] += 1
                    if nred == 0 and v and r >= 3:
                        f['off3ApprClean'] += 1
                    if morg in ts and v:
                        f['offApprMorg'] += 1
                elif not v:
                    f['onRej'] += 1
                    if nseen > 0:
                        f['onRejSeen'] += 1
                    elif nred == 0:
                        f['onRejClean'] += 1
        for k, h, t, cl in g['lakes']:
            if h == c:
                f['heldLake'] = 1
                f['lakeTgtRed'] = 1 if t in red else 0
                f['lakeClaimX'] = 1 if cl == 'x' else 0
            if t == c:
                f['laked'] = 1
                f['lakedByRed'] = 1 if h in red else 0
                f['lakedO'] = 1 if cl == 'o' else 0
                f['lakedX'] = 1 if cl == 'x' else 0
        out[c] = f
    return out


PREDS = [
    ('出過失敗的任務', lambda f: f['onFail'] >= 1),
    ('有任務失敗、但他都不在失敗的隊上', lambda f: f['onFail'] == 0 and f['nFail'] > 0),
    ('出過 ≥ 2 個成功的任務', lambda f: f['onSucc'] >= 2),
    ('沒出過成功的任務', lambda f: f['onSucc'] == 0),
    ('帶過成功的任務（隊長）', lambda f: f['ledMSucc'] >= 1),
    ('帶過失敗的任務（隊長）', lambda f: f['ledMFail'] >= 1),
    ('派過全藍的隊 ≥ 1 次', lambda f: f['ledClean'] >= 1),
    ('派過全藍的隊 ≥ 2 次', lambda f: f['ledClean'] >= 2),
    ('第 3 局起派過全藍的隊', lambda f: f['led3Clean'] >= 1),
    ('派過只有莫德雷德的隊', lambda f: f['ledMordOnly'] >= 1),
    ('派過有梅林看得到的紅的隊', lambda f: f['ledSeen'] >= 1),
    ('派過莫甘娜（拇指）', lambda f: f['ledMorg'] >= 1),
    ('被藍隊長和莫甘娜派在同一隊 ≥ 1 次', lambda f: f['pickedWithMorg'] >= 1),
    ('被藍隊長選上 ≥ 4 次', lambda f: f['picked'] >= 4),
    ('被藍隊長選上 ≤ 1 次', lambda f: f['picked'] <= 1),
    ('隊外贊成過有看得到的紅的隊', lambda f: f['offApprSeen'] >= 1),
    ('隊外贊成過有莫甘娜的隊', lambda f: f['offApprMorg'] >= 1),
    ('隊外反對過全藍的隊', lambda f: f['offRejClean'] >= 1),
    ('第 3 局起隊外反對過全藍的隊', lambda f: f['off3RejClean'] >= 1),
    ('第 3 局起隊外贊成過全藍的隊', lambda f: f['off3ApprClean'] >= 1),
    ('在隊上反對過（內黑）', lambda f: f['onRej'] >= 1),
    ('內黑過有看得到的紅的隊', lambda f: f['onRejSeen'] >= 1),
    ('內黑過全藍的隊', lambda f: f['onRejClean'] >= 1),
    ('持過湖', lambda f: f['heldLake'] == 1),
    ('持湖驗到紅', lambda f: f['heldLake'] == 1 and f['lakeTgtRed'] == 1),
    ('持湖宣告紅', lambda f: f['heldLake'] == 1 and f['lakeClaimX'] == 1),
    ('被藍方持湖者宣告藍', lambda f: f['laked'] == 1 and not f['lakedByRed'] and f['lakedO'] == 1),
    ('被紅方持湖者宣告藍', lambda f: f['laked'] == 1 and f['lakedByRed'] == 1 and f['lakedO'] == 1),
    ('被紅方持湖者宣告紅', lambda f: f['laked'] == 1 and f['lakedByRed'] == 1 and f['lakedX'] == 1),
]


# ─── 分層的證據 ──────────────────────────────────────────────────────────────

def evidence(g):
    """每個藍隊長：分層會算的提議（隊上有梅林看得到的紅），帶局面描述。和 `VisibleRedProposals.ts` 同一套規則。"""
    roles = g['roles']
    red = {i + 1 for i, r in enumerate(roles) if r in RED}
    seen = {i + 1 for i, r in enumerate(roles) if r in RED and r != 'mordred'}
    qres = {r: mf(r, f) for r, t, f in g['quests']}
    qteam = {r: set(t) for r, t, f in g['quests']}
    ev = defaultdict(list)
    for r, a, leader, team, appr, forced, went in g['props']:
        if leader in red:
            continue
        ts = set(team)
        ns = len(ts & seen)
        if ns == 0:
            continue
        fb = sum(1 for rr in range(1, r) if qres.get(rr))
        d = dict(r=r, a=a, ns=ns, forced=forced, went=went)
        if r <= 2 and a < 5:
            if r == 2 and 1 in qres and not qres[1] and qteam[1] <= ts and (ts & seen) <= qteam[1]:
                continue  # 第 2 局照派成功的第 1 局
            d['tier'] = 'D'
        else:
            if r >= 3 and a < 5 and fb < 2 and any(rr < r and not qres[rr] and qteam[rr] <= ts and (ts & seen) <= qteam[rr] for rr in qres):
                continue  # 照派成功的隊
            d['tier'] = 'T'
        ev[leader].append(d)
    return ev


def klass(e):
    if e['tier'] == 'D':
        return f'第 {e["r"]} 局第 1–4 次（{"出了任務" if e["went"] else "被否決"}）'
    if e['forced']:
        return f'第 {e["r"]} 局強制局' if e['r'] <= 2 else '第 3 局起的強制局'
    if e['r'] == 4:
        return '第 4 局（要兩張失敗）、剛好一個看得到的紅' if e['ns'] == 1 else '第 4 局、兩個以上看得到的紅'
    return f'第 {e["r"]} 局非強制'


# ─── 分格的概似比 ────────────────────────────────────────────────────────────

COMPS = ['乾淨', '只有莫德雷德', '一個看得到的紅', '一個看得到的紅＋莫德雷德', '兩個以上看得到的紅']


def comp(ts, seen, mord):
    ns = len(ts & seen)
    m = mord in ts
    if ns == 0:
        return COMPS[1] if m else COMPS[0]
    if ns == 1:
        return COMPS[3] if m else COMPS[2]
    return COMPS[4]


def cells(games):
    V = defaultdict(lambda: [[0, 0], [0, 0]])
    Ld = defaultdict(lambda: [Counter(), Counter()])
    for g in games:
        roles = g['roles']
        red = {i + 1 for i, r in enumerate(roles) if r in RED}
        seen = {i + 1 for i, r in enumerate(roles) if r in RED and r != 'mordred'}
        mord = roles.index('mordred') + 1
        merlin = roles.index('merlin') + 1
        qres = {r: mf(r, f) for r, t, f in g['quests']}
        for r, a, leader, team, appr, forced, went in g['props']:
            ts = set(team)
            fb = sum(1 for rr in range(1, r) if qres.get(rr))
            c = comp(ts, seen, mord)
            if leader not in red:
                Ld[(r, forced)][0 if leader == merlin else 1][c] += 1
            if appr is not None:
                ap = set(appr)
                for s in range(1, 11):
                    if s in red or s == leader:
                        continue
                    V[(r, s in ts, c, fb >= 2)][0 if s == merlin else 1][1 if s in ap else 0] += 1
    return V, Ld


# ─── 各部分 ──────────────────────────────────────────────────────────────────

def pct(x):
    return f'{100 * x:.1f}'


def part_paths(H, base, alts):
    names = ['現行'] + [n for n, _ in alts]
    sets = [base] + [dict((r['gi'], r) for r in a) for _, a in alts]
    acc = defaultdict(lambda: defaultdict(float))
    for r in base:
        g = H.get(r['gi'])
        if g is None:
            continue
        m = r['merlin']
        mfront = next(c['front'] for c in r['cands'] if c['seat'] == m)
        for key in (('全部', '全部'), (zh(r['order']), '全部'), ('全部', tier_of(r['s'])), (zh(r['order']), tier_of(r['s']))):
            a = acc[key]
            a['n'] += 1
            a['h'] += r['human'] == m
            a['front'] += mfront
            a['hOut'] += (r['human'] == m and not mfront)
            a['hRole_' + g['roles'][r['human'] - 1]] += 1
            a['bRole_' + g['roles'][r['bot'] - 1]] += 1
            a['same'] += r['human'] == r['bot']
            a['b0'] += r['bot'] == m
            for i, s in enumerate(sets[1:], 1):
                a[f'b{i}'] += s[r['gi']]['bot'] == m
    print('| 任務順序 | 強度層 | n | 真人刺中 % | ' + ' | '.join(f'機器人（{n}）%' for n in names) + ' | 梅林在第一層 % | 真人在第一層外刺中（占全部 %） | 真人的目標：派西／忠臣 % | 機器人的目標：派西／忠臣 % | 同一個目標 % |')
    print('|---|---|---|---|' + '---|' * len(names) + '---|---|---|---|---|')
    order = sorted(acc, key=lambda k: (-acc[(k[0], '全部')]['n'], k[1] != '全部', k[1]))
    for k in order:
        a = acc[k]
        n = a['n']
        if n < 25:
            continue
        print(f'| {k[0]} | {k[1]} | {int(n)} | {pct(a["h"] / n)} | ' + ' | '.join(pct(a[f'b{i}'] / n) for i in range(len(names)))
              + f' | {pct(a["front"] / n)} | {pct(a["hOut"] / n)} | {pct(a["hRole_percival"] / n)}／{pct(a["hRole_loyal"] / n)} | {pct(a["bRole_percival"] / n)}／{pct(a["bRole_loyal"] / n)} | {pct(a["same"] / n)} |')


def part_lifts(H, base, order):
    rows = [r for r in base if r['gi'] in H and (order is None or r['order'] == order)]
    F = {r['gi']: feats(H[r['gi']]) for r in rows}
    n = len(rows)
    print(f'刺殺點 {n} 個（{"全部" if order is None else zh(order)}）；候選人 = 六個藍方，梅林占 1/6 = 16.7%。\n')
    print('| 候選人的公開特徵 | 候選人有這個特徵 % | 其中是梅林 % | 是派西 % | 真人的目標有 % | 真人選到這種人時刺中 % | 機器人的目標有 % | 機器人選到這種人時刺中 % |')
    print('|---|---|---|---|---|---|---|---|')
    for name, p in PREDS:
        nc = nx = mx = px = ht = hh = bt = bb = 0
        for r in rows:
            g = H[r['gi']]
            f = F[r['gi']]
            m = r['merlin']
            for c, x in f.items():
                nc += 1
                if p(x):
                    nx += 1
                    mx += c == m
                    px += g['roles'][c - 1] == 'percival'
            if p(f[r['human']]):
                ht += 1
                hh += r['human'] == m
            if p(f[r['bot']]):
                bt += 1
                bb += r['bot'] == m
        if nx < 20:
            continue
        print(f'| {name} | {pct(nx / nc)} | {pct(mx / nx)} | {pct(px / nx)} | {pct(ht / n)} | {pct(hh / max(ht, 1))} | {pct(bt / n)} | {pct(bb / max(bt, 1))} |')


def part_tier(H, base):
    cls = defaultdict(lambda: [0, 0])
    excl = Counter()
    hit = Counter()
    noev = [0, 0]
    tot = 0
    for r in base:
        g = H.get(r['gi'])
        if g is None:
            continue
        ev = evidence(g)
        m = r['merlin']
        front = {c['seat'] for c in r['cands'] if c['front']}
        for c in r['cands']:
            E = ev.get(c['seat'], [])
            if not E:
                noev[0] += 1
                noev[1] += c['seat'] == m
                continue
            ks = sorted(set(klass(e) for e in E))
            key = ks[0] if len(ks) == 1 else '兩種以上'
            cls[key][0] += 1
            cls[key][1] += c['seat'] == m
            if c['seat'] == m and m not in front:
                excl[key] += 1
                hit[key] += r['human'] == m
                tot += 1
    print(f'沒有任何這類提議的候選人 {noev[0]} 個，其中梅林 {pct(noev[1] / noev[0])}%；被排到第二層的梅林共 {tot} 個。\n')
    print('| 候選人只有這一種證據 | 候選人數 | 其中是梅林 % | 因此被排到第二層的梅林 | 真人在這些點刺中 |')
    print('|---|---|---|---|---|')
    for k, (n, mm) in sorted(cls.items()):
        print(f'| {k} | {n} | {pct(mm / n)} | {excl[k]} | {hit[k]} |')


def part_cells(H):
    V, Ld = cells(list(H.values()))
    print(f'真人 {len(H)} 局全部的提議與票（只用可靠的票）。\n')
    print('### 提議：藍隊長派的隊（梅林的視野）\n')
    print('| 局 | 強制局 | 隊伍組成 | 梅林 n／N（%） | 其他藍方 n／N（%） | 概似比 |')
    print('|---|---|---|---|---|---|')
    for k in sorted(Ld):
        a, b = Ld[k]
        na, nb = sum(a.values()), sum(b.values())
        for c in COMPS:
            lr = ((a[c] + 1) / (na + 5)) / ((b[c] + 1) / (nb + 5))
            print(f'| {k[0]} | {"是" if k[1] else "否"} | {c} | {a[c]}／{na}（{pct(a[c] / max(na, 1))}） | {b[c]}／{nb}（{pct(b[c] / max(nb, 1))}） | {lr:.2f} |')
    one = lambda r: (sum(Ld[(r, False)][0][c] for c in COMPS[2:4]), sum(Ld[(r, False)][0].values()), sum(Ld[(r, False)][1][c] for c in COMPS[2:4]), sum(Ld[(r, False)][1].values()))
    print('\n剛好一個看得到的紅（有沒有莫德雷德合併；非強制）：' + '；'.join(
        f'第 {r} 局 梅林 {one(r)[0]}／{one(r)[1]}（{pct(one(r)[0] / one(r)[1])}%）、其他 {one(r)[2]}／{one(r)[3]}（{pct(one(r)[2] / one(r)[3])}%）、概似比 {(one(r)[0] / one(r)[1]) / (one(r)[2] / one(r)[3]):.2f}'
        for r in (1, 2, 3, 4, 5)) + '\n')
    print('### 票：第 3 局起（非強制，投票者不是隊長）\n')
    print('| 局 | 在隊上 | 隊伍組成 | 紅方已兩勝 | 梅林贊成 %（n） | 其他藍方贊成 %（n） | 贊成的概似比 | 反對的概似比 |')
    print('|---|---|---|---|---|---|---|---|')
    for k in sorted(V, key=lambda k: (k[0], not k[1], COMPS.index(k[2]), k[3])):
        if k[0] < 3:
            continue
        a, b = V[k]
        na, nb = sum(a), sum(b)
        if na < 30:
            continue
        pm, po = (a[1] + 1) / (na + 2), (b[1] + 1) / (nb + 2)
        print(f'| {k[0]} | {"是" if k[1] else "否"} | {k[2]} | {"是" if k[3] else "否"} | {pct(a[1] / na)}（{na}） | {pct(b[1] / nb)}（{nb}） | {pm / po:.2f} | {(1 - pm) / (1 - po):.2f} |')
    # 第 4 局、剛好一個看得到的紅（有沒有莫德雷德合併）
    for on in (True, False):
        for red2 in (True, False):
            a = [sum(V[(4, on, c, red2)][0][i] for c in COMPS[2:4]) for i in (0, 1)]
            b = [sum(V[(4, on, c, red2)][1][i] for c in COMPS[2:4]) for i in (0, 1)]
            if sum(a) >= 30:
                print(f'\n第 4 局、剛好一個看得到的紅、{"在隊上" if on else "不在隊上"}、紅方{"已" if red2 else "未"}兩勝：梅林贊成 {pct(a[1] / sum(a))}%（{sum(a)}）、其他藍方 {pct(b[1] / sum(b))}%（{sum(b)}）')


def part_cands(H, base, alts):
    rng = np.random.default_rng(73)
    hh = np.array([r['human'] == r['merlin'] for r in base], float)
    b0 = np.array([r['bot'] == r['merlin'] for r in base], float)
    print(f'刺殺點 {len(base)} 個；真人刺中 {pct(hh.mean())}%、現行 {pct(b0.mean())}%。\n')
    print('| 候選 | 改到 | 多刺中／少刺中 | 刺中率 % | Δ [95%] | 偶數號／奇數號 | 藍紅…／其他順序 | 弱／一般／強／S 不明 | 和真人同目標 Δ |')
    print('|---|---|---|---|---|---|---|---|---|')
    for name, alt in alts:
        by = {r['gi']: r for r in alt}
        C = [by[r['gi']] for r in base]
        b1 = np.array([c['bot'] == c['merlin'] for c in C], float)
        d = b1 - b0
        ch = sum(r['bot'] != c['bot'] for r, c in zip(base, C))
        idx = rng.integers(0, len(d), size=(4000, len(d)))
        bs = d[idx].mean(axis=1)
        sel = lambda f: 100 * float(np.mean([x for x, r in zip(d, base) if f(r)] or [0]))
        same = 100 * (np.mean([c['bot'] == c['human'] for c in C]) - np.mean([r['bot'] == r['human'] for r in base]))
        print(f'| {name} | {ch} | {int((d > 0).sum())}／{int((d < 0).sum())} | {pct(b1.mean())} | {100 * d.mean():+.2f} [{100 * np.percentile(bs, 2.5):+.2f}, {100 * np.percentile(bs, 97.5):+.2f}] | '
              f'{sel(lambda r: r["gi"] % 2 == 0):+.2f}／{sel(lambda r: r["gi"] % 2 == 1):+.2f} | {sel(lambda r: r["order"].startswith("BR")):+.2f}／{sel(lambda r: not r["order"].startswith("BR")):+.2f} | '
              + '／'.join(f'{sel(lambda r, t=t: tier_of(r["s"]) == t):+.2f}' for t in ('弱桌', '一般桌', '強桌', 'S不明')) + f' | {same:+.2f} |')


def cell_events(g):
    """每個藍方座位的 (種類, 格, 動作)：提議 = (局, 強制) → 隊伍組成；票 = (局, 在隊上, 隊伍組成, 紅方已兩勝) → 贊成／反對。"""
    roles = g['roles']
    red = {i + 1 for i, r in enumerate(roles) if r in RED}
    seen = {i + 1 for i, r in enumerate(roles) if r in RED and r != 'mordred'}
    mord = roles.index('mordred') + 1
    qres = {r: mf(r, f) for r, t, f in g['quests']}
    for r, a, leader, team, appr, forced, went in g['props']:
        ts = set(team)
        fb = sum(1 for rr in range(1, r) if qres.get(rr))
        c = comp(ts, seen, mord)
        if leader not in red:
            yield leader, 'lead', (r, forced), c
        if appr is not None:
            ap = set(appr)
            for s in range(1, 11):
                if s not in red and s != leader:
                    yield s, 'vote', (r, s in ts, c, fb >= 2), 1 if s in ap else 0


def cell_scores(g, V, Ld):
    """分格概似比的對數和（樸素貝氏）：每個藍方座位的 (票, 提議)。"""
    sv, sl = defaultdict(float), defaultdict(float)
    for s, kind, k, act in cell_events(g):
        if kind == 'vote':
            a, b = V.get(k, ([0, 0], [0, 0]))
            pm, po = (a[1] + 1) / (sum(a) + 2), (b[1] + 1) / (sum(b) + 2)
            sv[s] += math.log(pm / po) if act else math.log((1 - pm) / (1 - po))
        else:
            a, b = Ld.get(k, (Counter(), Counter()))
            sl[s] += math.log(((a[act] + 1) / (sum(a.values()) + 5)) / ((b[act] + 1) / (sum(b.values()) + 5)))
    return sv, sl


def part_ablate(H, base):
    """刺殺分數各項拿掉、或換成真人分格的概似比（偶數號的局擬合 → 奇數號的刺殺點，反過來也一樣），分層照舊。"""
    games = list(H.values())
    tabs = {p: cells([g for g in games if g['gi'] % 2 != p]) for p in (0, 1)}
    sc = {r['gi']: cell_scores(H[r['gi']], *tabs[r['gi'] % 2]) for r in base}
    variants = [
        ('現行（模型＋投票＋湖＋隊長＋照派）', lambda c, v, l: c['total']),
        ('只用條件 logit 模型', lambda c, v, l: c['model']),
        ('現行 − 投票讀法', lambda c, v, l: c['total'] - c['vote']),
        ('現行 − 隊長讀法', lambda c, v, l: c['total'] - c['lead']),
        ('現行 − 照派讀法', lambda c, v, l: c['total'] - c['reuse']),
        ('投票讀法換成真人分格的票（× 0.5）', lambda c, v, l: c['total'] - c['vote'] + 0.5 * v),
        ('投票讀法換成真人分格的票（× 1）', lambda c, v, l: c['total'] - c['vote'] + v),
        ('現行 ＋ 真人分格的提議（× 0.5）', lambda c, v, l: c['total'] + 0.5 * l),
        ('現行 ＋ 真人分格的提議（× 1）', lambda c, v, l: c['total'] + l),
        ('只用真人分格（票＋提議）', lambda c, v, l: v + l),
    ]
    rng = np.random.default_rng(73)
    picks = {}
    for name, fn in variants:
        out = []
        for r in base:
            sv, sl = sc[r['gi']]
            best = None
            for c in sorted(r['cands'], key=lambda c: c['seat']):
                if not c['front']:
                    continue
                x = fn(c, sv[c['seat']], sl[c['seat']])
                if best is None or x > best[0]:
                    best = (x, c['seat'])
            out.append(best[1])
        picks[name] = out
    b0 = np.array([p == r['merlin'] for p, r in zip(picks[variants[0][0]], base)], float)
    print(f'刺殺點 {len(base)} 個；真人刺中 {pct(np.mean([r["human"] == r["merlin"] for r in base]))}%。分層（第一層）每一種寫法都照舊。\n')
    print('| 刺殺分數的寫法 | 刺中率 % | 改到 | 多刺中／少刺中 | Δ [95%] | 偶數號／奇數號 |')
    print('|---|---|---|---|---|---|')
    for name, _ in variants:
        b1 = np.array([p == r['merlin'] for p, r in zip(picks[name], base)], float)
        d = b1 - b0
        ch = sum(a != b for a, b in zip(picks[name], picks[variants[0][0]]))
        bs = d[rng.integers(0, len(d), size=(4000, len(d)))].mean(axis=1)
        ev = 100 * np.mean([x for x, r in zip(d, base) if r['gi'] % 2 == 0])
        od = 100 * np.mean([x for x, r in zip(d, base) if r['gi'] % 2 == 1])
        print(f'| {name} | {pct(b1.mean())} | {ch} | {int((d > 0).sum())}／{int((d < 0).sum())} | {100 * d.mean():+.2f} [{100 * np.percentile(bs, 2.5):+.2f}, {100 * np.percentile(bs, 97.5):+.2f}] | {ev:+.2f}／{od:+.2f} |')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--human', required=True)
    ap.add_argument('--base')
    ap.add_argument('--alt', nargs='*', default=[])
    ap.add_argument('--part', required=True, choices=['paths', 'lifts', 'tier', 'cells', 'cands', 'ablate'])
    ap.add_argument('--order', help='lifts：只看這個任務順序（B／R，例：BRRBB）')
    args = ap.parse_args()
    H = {g['gi']: g for g in load(args.human)}
    base = [r for r in load(args.base) if r['gi'] in H] if args.base else []
    alts = [(s.split('=', 1)[0], load(s.split('=', 1)[1])) for s in args.alt]
    if args.part == 'paths':
        part_paths(H, base, alts)
    elif args.part == 'lifts':
        part_lifts(H, base, args.order)
    elif args.part == 'tier':
        part_tier(H, base)
    elif args.part == 'cells':
        part_cells(H)
    elif args.part == 'ablate':
        part_ablate(H, base)
    else:
        part_cands(H, base, alts)


if __name__ == '__main__':
    main()
