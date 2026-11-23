#!/usr/bin/env python3
"""第 62 回合：1-5 與 2-5 的藍隊長尾派——真人（全部／高端桌 S≥55／高強度 S≥65）vs 機器人（同一批決策點）。

輸入：
  --human h.jsonl   `keySpotStudy.ts --export-human`（整局：角色、提議、票、任務、湖、結果；沒有名字）
  --rows r.jsonl    `tailSpot62.ts`（每個藍隊長強制局決策點：真人的隊、各版本機器人的隊）

輸出（--md）：
  1. 乾淨率（隊上沒紅）、任務成功、藍勝（三藍活）分 局面 × 角色 × 強度；機器人 − 真人 的配對差（以局為群集的 Poisson bootstrap）。
     機器人的隊沒有真的出任務：任務成功與藍勝用「同局面、同角色的全部真人，乾淨隊／有紅隊的實際任務成功率與藍勝率」換算（估計，不是觀察）。
  2. 2-5（0:1）的公開訊號：第 1 局失敗隊、1-5 隊的合理性（1-1…1-4 的提議與票）、2-1…2-4 的提議與票；
     每個座位「是紅」與「被真人／機器人選上」各自和這些訊號的關係（條件 logit／logistic，偶數局擬合、奇數局驗證）。
  3. 機器人和強者派不同隊的類型與結果。

  python3 scripts/tailSpot62.py --human h.jsonl --rows r_*.jsonl [--md out.md] [--cols A,H,...] [--cand T1:H,TA:A]
  4. 候選開關在同一批決策點的乾淨率配對差（--cand）。
"""
import argparse
import json
import math
from collections import defaultdict

import numpy as np

RED = {'assassin', 'morgana', 'mordred', 'oberon'}
ROLE_ZH = {'loyal': '忠臣', 'percival': '派西', 'merlin': '梅林'}
BOOT = 1000
rng = np.random.default_rng(62)


def load(paths):
    out = []
    for p in paths:
        with open(p, encoding='utf8') as fh:
            out += [json.loads(l) for l in fh if l.strip()]
    return out


def is_red(g, s):
    return g['roles'][s - 1] in RED


def failed(r, f):
    return f >= (2 if r == 4 else 1)


# ─── 公開訊號（決策點當下看得到的） ─────────────────────────────────────────────

def signals(g, idx):
    """2-5 決策點（第 idx 個提議）的每個座位的公開訊號。回傳 dict seat -> features，加上整體的 1-5 合理性。"""
    props = g['props']
    p = props[idx]
    leader = p[2]
    r1 = [x for x in props if x[0] == 1]
    r1went = [x for x in r1 if x[6]]
    q1 = g['quests'][0]
    r1team = set(q1[1])
    r1fail = failed(1, q1[2])
    r1went = r1went[0] if r1went else None
    r1leader = r1went[2] if r1went else None
    # 1-5（或第 1 局出任務的那一次）之前的提議：每個人被提幾次、被幾個不同的隊長提
    before = [x for x in r1 if r1went and x[1] < r1went[1]]
    nprop = defaultdict(int)
    for x in before:
        for s in x[3]:
            if s != x[2]:
                nprop[s] += 1
    # 1-5 隊的合理性：隊長以外的隊員有幾個「在 1-1…1-4 被別人提過」
    mem = [s for s in r1team if s != r1leader]
    explained = sum(1 for s in mem if nprop[s] > 0)
    copy = any(set(x[3]) == r1team for x in before)
    # 第 2 局到這一次為止的提議（2-1…2-4）
    r2 = [x for x in props if x[0] == 2 and x[1] < p[1]]
    nprop2 = defaultdict(int)
    for x in r2:
        for s in x[3]:
            if s != x[2]:
                nprop2[s] += 1
    # 票：只用可靠的票。1-1…1-4 對「含第 1 局任務隊員的隊」、2-1…2-4。
    appr_r1team = defaultdict(lambda: [0, 0])  # seat -> [贊成含失敗隊員≥2 的隊, 次數]
    for x in before + r2:
        if x[4] is None:
            continue
        ov = len(set(x[3]) & r1team)
        if ov >= 2:
            for s in range(1, 11):
                appr_r1team[s][1] += 1
                if s in x[4]:
                    appr_r1team[s][0] += 1
    feats = {}
    for s in range(1, 11):
        if s == leader:
            continue
        a, n = appr_r1team[s]
        feats[s] = {
            'inR1': 1 if s in r1team else 0,
            'r1Leader': 1 if s == r1leader else 0,
            'nPropR1': nprop[s],
            'nPropR2': nprop2[s],
            'proposedR1Team': 1 if any(x[2] == s and len(set(x[3]) & r1team) >= 2 for x in before + r2) else 0,
            'apprR1TeamRate': (a / n) if n else 0.5,
            'seatAfterLeader': (s - leader) % 10,
        }
    ctx = {
        'leaderInR1': leader in r1team, 'r1fail': r1fail, 'r1leader': r1leader,
        'reasonable': explained, 'copy': copy, 'r1attempt': r1went[1] if r1went else None,
        'r1leaderBlue': (not is_red(g, r1leader)) if r1leader else None,
    }
    return feats, ctx


# ─── bootstrap ──────────────────────────────────────────────────────────────

def boot_mean(vals, clusters):
    """vals：每個決策點的值；clusters：gi。回傳 (平均, lo, hi)。"""
    vals = np.asarray(vals, float)
    if len(vals) == 0:
        return (math.nan, math.nan, math.nan)
    uc, inv = np.unique(clusters, return_inverse=True)
    sums = np.bincount(inv, weights=vals, minlength=len(uc))
    cnts = np.bincount(inv, minlength=len(uc)).astype(float)
    w = rng.poisson(1.0, size=(BOOT, len(uc)))
    num = w @ sums
    den = w @ cnts
    est = num[den > 0] / den[den > 0]
    return (vals.mean(), np.percentile(est, 2.5), np.percentile(est, 97.5))


def fmt(t, pct=True, sign=False):
    m, lo, hi = t
    if math.isnan(m):
        return '—'
    k = 100 if pct else 1
    s = '+' if sign else ''
    return f'{m * k:{s}.1f} [{lo * k:{s}.1f}, {hi * k:{s}.1f}]'


# ─── 主程式 ───────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--human', required=True)
    ap.add_argument('--rows', nargs='+', required=True)
    ap.add_argument('--md')
    ap.add_argument('--cols', default='A,H')
    ap.add_argument('--cand', help='候選:對照,…（例：T1:H,TA:A）')
    a = ap.parse_args()
    games = {g['gi']: g for g in load([a.human])}
    rows = [r for r in load(a.rows) if r['gi'] in games]
    cols = a.cols.split(',')
    md = []
    P = md.append

    def spot(r):
        if r['round'] == 1:
            return '1-5（0:0）'
        g = games[r['gi']]
        return '2-5（0:1）' if failed(1, g['quests'][0][2]) else '2-5（1:0）'

    def clean(g, team):
        return 0 if any(is_red(g, s) for s in team) else 1

    for r in rows:
        g = games[r['gi']]
        r['spot'] = spot(r)
        q = [x for x in g['quests'] if x[0] == r['round']][0]
        r['hClean'] = clean(g, r['human'])
        r['hPass'] = 0 if failed(r['round'], q[2]) else 1
        r['hWin'] = 1 if g['out'] == 'blueAlive' else 0
        r['hRed3'] = 1 if g['out'] == 'red3' else 0
        for c in cols:
            r['c_' + c] = clean(g, r['teams'].get(c, [])) if r['teams'].get(c) else None
        r['same_' + cols[0]] = 1 if r['teams'].get(cols[0]) == r['human'] else 0

    spots = ['1-5（0:0）', '2-5（0:1）', '2-5（1:0）']
    tiers = [('全部真人', lambda r: True), ('高端桌 S≥55', lambda r: (r['s'] or -1) >= 55), ('高強度 S≥65', lambda r: (r['s'] or -1) >= 65)]
    roles = [('藍方', lambda r: True), ('忠臣', lambda r: r['role'] == 'loyal'), ('派西', lambda r: r['role'] == 'percival'), ('梅林', lambda r: r['role'] == 'merlin')]

    # 換算表：同局面、同角色的全部真人，乾淨／有紅的隊實際的任務成功與藍勝
    conv = {}
    for sp in spots:
        for rl, f in roles:
            xs = [r for r in rows if r['spot'] == sp and f(r)]
            for k in (0, 1):
                ys = [r for r in xs if r['hClean'] == k]
                conv[(sp, rl, k)] = (np.mean([y['hPass'] for y in ys]) if ys else math.nan,
                                     np.mean([y['hWin'] for y in ys]) if ys else math.nan)

    P('### 1. 乾淨率、任務成功、藍勝：真人 vs 機器人（同一批決策點）\n')
    P(f'機器人版本：{", ".join(cols)}（A = 基準線、H = 照桌上 S 的真人桌策略層）。配對差 = 機器人 − 真人，以局為群集的 Poisson bootstrap {BOOT} 次，95% 區間。'
      '機器人的任務成功、藍勝是換算（同局面、同角色全部真人的乾淨隊／有紅隊實際結果），不是觀察。\n')
    for sp in spots:
        P(f'\n**{sp}**\n')
        hdr = '| 樣本 | 角色 | n | 真人 乾淨 % | 真人 任務成功 % | 真人 藍勝 % | ' + ' | '.join(f'{c} 乾淨 %' for c in cols) + ' | ' + ' | '.join(f'{c} − 真人 乾淨 [95%]' for c in cols) + f' | {cols[0]} 換算 任務成功／藍勝 − 真人 |'
        P(hdr)
        P('|' + '---|' * (hdr.count('|') - 1))
        for tn, tf in tiers:
            for rl, rf in roles:
                xs = [r for r in rows if r['spot'] == sp and tf(r) and rf(r) and all(r['c_' + c] is not None for c in cols)]
                if len(xs) < 10:
                    continue
                gi = [r['gi'] for r in xs]
                hc = boot_mean([r['hClean'] for r in xs], gi)
                hp = boot_mean([r['hPass'] for r in xs], gi)
                hw = boot_mean([r['hWin'] for r in xs], gi)
                bc = [np.mean([r['c_' + c] for r in xs]) * 100 for c in cols]
                dif = [boot_mean([r['c_' + c] - r['hClean'] for r in xs], gi) for c in cols]
                # 換算：機器人的隊照同局面同角色的乾淨／有紅實際結果；真人的隊照同一張表（同一把尺）
                c0 = cols[0]
                dp = boot_mean([(conv[(sp, rl, r['c_' + c0])][0] - conv[(sp, rl, r['hClean'])][0]) for r in xs], gi)
                dw = boot_mean([(conv[(sp, rl, r['c_' + c0])][1] - conv[(sp, rl, r['hClean'])][1]) for r in xs], gi)
                P(f'| {tn} | {rl} | {len(xs)} | {fmt(hc)} | {hp[0]*100:.1f} | {hw[0]*100:.1f} | ' + ' | '.join(f'{b:.1f}' for b in bc)
                  + ' | ' + ' | '.join(fmt(d, sign=True) for d in dif) + f' | {dp[0]*100:+.1f}／{fmt(dw, sign=True)} |')

    # 乾淨隊／有紅隊的實際結果（換算表本身）
    P('\n**換算表（全部真人，隊伍實際出任務）：乾淨隊 vs 有紅隊的任務成功／藍勝 %**\n')
    P('| 局面 | 角色 | 乾淨隊 n | 乾淨 任務成功／藍勝 | 有紅 n | 有紅 任務成功／藍勝 |')
    P('|---|---|---|---|---|---|')
    for sp in spots:
        for rl, rf in roles:
            xs = [r for r in rows if r['spot'] == sp and rf(r)]
            n1 = sum(r['hClean'] for r in xs)
            n0 = len(xs) - n1
            p1, w1 = conv[(sp, rl, 1)]
            p0, w0 = conv[(sp, rl, 0)]
            P(f'| {sp} | {rl} | {n1} | {p1*100:.1f}／{w1*100:.1f} | {n0} | {p0*100:.1f}／{w0*100:.1f} |')

    # ─── 2. 2-5（0:1）訊號 ───
    sig_rows = []
    for r in rows:
        if r['spot'] != '2-5（0:1）':
            continue
        g = games[r['gi']]
        feats, ctx = signals(g, r['idx'])
        r['ctx'] = ctx
        r['feats'] = feats
        sig_rows.append(r)
    P('\n### 2. 2-5（0:1）：真人與機器人的隊和公開訊號\n')

    def kR1(team, r):
        return sum(1 for s in team if s != r['leader'] and r['feats'].get(s, {}).get('inR1'))

    P('**帶第 1 局失敗隊的人（自己以外）幾個：比例與乾淨率**（藍隊長，全部真人；括號 = 高端桌 S≥55）\n')
    P('| 隊長自己在第 1 局隊上 | 帶幾個 | 真人 比例 | 真人 乾淨 % | 真人 藍勝 % | 機器人 A 比例 | A 乾淨 % |')
    P('|---|---|---|---|---|---|---|')
    for lin in (False, True):
        xs = [r for r in sig_rows if r['ctx']['leaderInR1'] == lin]
        for k in range(0, 4):
            hs = [r for r in xs if kR1(r['human'], r) == k]
            bs = [r for r in xs if kR1(r['teams']['A'], r) == k]
            if not hs and not bs:
                continue
            hs55 = [r for r in hs if (r['s'] or -1) >= 55]
            P(f'| {"是" if lin else "否"} | {k} | {len(hs)/len(xs)*100:.1f}（{len(hs55)}） | {np.mean([r["hClean"] for r in hs])*100 if hs else float("nan"):.1f}'
              f'（{np.mean([r["hClean"] for r in hs55])*100 if hs55 else float("nan"):.1f}） | {np.mean([r["hWin"] for r in hs])*100 if hs else float("nan"):.1f} | {len(bs)/len(xs)*100:.1f} | '
              f'{np.mean([r["c_A"] for r in bs])*100 if bs else float("nan"):.1f} |')

    # 1-5 合理性
    P('\n**1-5 隊的合理性**（第 1 局出任務那一隊；隊長以外的隊員在 1-1…1-4 被別人提過幾個；照派 = 和之前某一隊完全相同）× 1-5 隊長的真實陣營、2-5 的乾淨率\n')
    P('| 第 1 局隊的隊員被提過 | n | 1-5 隊長是紅 % | 隊上紅數（平均） | 真人 2-5 乾淨 % | A 2-5 乾淨 % | 真人帶 1-5 隊長 % | A 帶 1-5 隊長 % |')
    P('|---|---|---|---|---|---|---|---|')
    for ex in (0, 1, 2):
        xs = [r for r in sig_rows if r['ctx']['reasonable'] == ex and r['ctx']['r1leader'] and r['ctx']['r1leader'] != r['leader']]
        if not xs:
            continue
        g = lambda r: games[r['gi']]
        P(f'| {ex} 個 | {len(xs)} | {np.mean([0 if r["ctx"]["r1leaderBlue"] else 1 for r in xs])*100:.1f} | '
          f'{np.mean([sum(is_red(g(r), s) for s in g(r)["quests"][0][1]) for r in xs]):.2f} | {np.mean([r["hClean"] for r in xs])*100:.1f} | {np.mean([r["c_A"] for r in xs])*100:.1f} | '
          f'{np.mean([r["ctx"]["r1leader"] in r["human"] for r in xs])*100:.1f} | {np.mean([r["ctx"]["r1leader"] in r["teams"]["A"] for r in xs])*100:.1f} |')

    # 每個座位：第 62 回合公開讀法的特徵（`Round62.tailRead62Features`，f62）→ 是紅（在後驗之外）、被選上
    FN = ['inR1', 'r1Lead', 'r1Pick', 'r1LeadUnr', 'consSeed', 'nPropR1', 'nPropR2', 'apprR1out', 'apprR2fail', 'r2PropFail']
    zh = {'inR1': '在第 1 局失敗隊上', 'r1Lead': '派第 1 局那一隊的隊長', 'r1Pick': '第 1 局隊上、隊長自己挑的（1-1…1-4 沒人提過）',
          'r1LeadUnr': '第 1 局隊長、隊上有他自己挑的人（不合理的隊）', 'consSeed': '1-1…1-4 自己的提議放了幾個第 1 局隊員', 'nPropR1': '1-1…1-4 被別人提過幾次',
          'nPropR2': '2-1…2-4 被別人提過幾次', 'apprR1out': '1-1…1-4 不在隊上時對含兩個第 1 局隊員的隊的贊成率（−0.5…+0.5）',
          'apprR2fail': '2-1…2-4 對含兩個第 1 局隊員的隊的贊成率', 'r2PropFail': '2-1…2-4 自己派了含第 1 局隊員的隊'}
    seats = []
    for r in sig_rows:
        if r['role'] not in ('loyal', 'percival') or not r.get('f62'):
            continue
        g = games[r['gi']]
        for s, f in r['f62'].items():
            s = int(s)
            ph = min(max(r['redH'][s - 1], 1e-4), 1 - 1e-4)
            seats.append(dict(gi=r['gi'], strong=(r['s'] or -1) >= 55, red=float(is_red(g, s)), off=math.log(ph / (1 - ph)), f=f,
                              hum=float(s in r['human']), A=float(s in r['teams']['A'])))

    def logit_fit(X, y):
        X = np.column_stack([np.ones(len(X)), X])
        b = np.zeros(X.shape[1])
        for _ in range(60):
            p = 1 / (1 + np.exp(-X @ b))
            H = X.T @ (X * (p * (1 - p))[:, None]) + 1e-6 * np.eye(X.shape[1])
            b += np.linalg.solve(H, X.T @ (y - p))
        return b, np.sqrt(np.diag(np.linalg.inv(H)))

    if seats:
        off = np.array([x['off'] for x in seats])
        F = np.array([x['f'] for x in seats], float)
        X = np.column_stack([off, F])
        ev = np.array([x['gi'] % 2 == 0 for x in seats])
        st = np.array([x['strong'] for x in seats])
        y = {k: np.array([x[k] for x in seats]) for k in ('red', 'hum', 'A')}
        fits = [('是紅（全部）', 'red', np.ones(len(seats), bool)), ('是紅（偶數局）', 'red', ev), ('是紅（奇數局）', 'red', ~ev),
                ('真人選上', 'hum', np.ones(len(seats), bool)), ('高端桌真人選上', 'hum', st), ('機器人 A 選上', 'A', np.ones(len(seats), bool))]
        res = [(n, *logit_fit(X[m], y[k][m])) for n, k, m in fits]
        P('\n**每個座位（隊長以外，忠臣／派西當隊長）：公開讀法的特徵 → 是紅（在真人桌策略層後驗之外）、被選上**'
          '（logistic；第一列是後驗 logit 的係數，其他是殘差係數 = log-odds，括號 = 標準誤）\n')
        P('| 特徵 | ' + ' | '.join(n for n, _, _ in res) + ' |')
        P('|---|' + '---|' * len(res))
        for i, k in enumerate(['常數', '後驗 logit'] + FN):
            P(f'| {zh.get(k, k)} | ' + ' | '.join(f'{b[i]:+.2f}（{se[i]:.2f}）' for _, b, se in res) + ' |')
        P(f'\n（座位數 {len(seats)}，高端桌 {int(st.sum())}。「是紅」的殘差係數 ≈ 0 = 後驗已經讀到；選上的係數和「是紅」不同號 = 選人時看了沒有資訊的訊號。）\n')
        # 交叉驗證：一半擬合殘差權重、另一半看預測（對數損失）
        def ll(p, t):
            p = np.clip(p, 1e-6, 1 - 1e-6)
            return -np.mean(t * np.log(p) + (1 - t) * np.log(1 - p))
        P('| 擬合 → 驗證 | 後驗本身 對數損失 | 加上讀法（只用特徵權重，同開關） | 差 |')
        P('|---|---|---|---|')
        for tr, te, nm in ((ev, ~ev, '偶數局 → 奇數局'), (~ev, ev, '奇數局 → 偶數局')):
            b, _ = logit_fit(X[tr], y['red'][tr])
            p0 = 1 / (1 + np.exp(-off[te]))
            p1 = 1 / (1 + np.exp(-(off[te] + F[te] @ b[2:])))
            P(f'| {nm} | {ll(p0, y["red"][te]):.5f} | {ll(p1, y["red"][te]):.5f} | {ll(p1, y["red"][te]) - ll(p0, y["red"][te]):+.5f} |')

    # ─── 3. 機器人和強者派不同隊的類型 ───
    P('\n### 3. 機器人（A）和真人派不同隊：類型與結果（高端桌 S≥55；全部真人在括號）\n')
    for sp in spots:
        xs = [r for r in rows if r['spot'] == sp]
        P(f'\n**{sp}**\n')
        P('| 類型 | 高端桌 n | 真人 乾淨 % | A 乾淨 % | 真人 藍勝 % | 全部 n | 全部 真人 乾淨 % | 全部 A 乾淨 % | 全部 真人 藍勝 % |')
        P('|---|---|---|---|---|---|---|---|---|')

        def typ(r):
            h, b = set(r['human']), set(r['teams']['A'])
            if h == b:
                return '完全相同'
            d = len(h - b)
            return f'差 {d} 人'
        for t in ['完全相同', '差 1 人', '差 2 人', '差 3 人']:
            al = [r for r in xs if typ(r) == t]
            st = [r for r in al if (r['s'] or -1) >= 55]
            if not al:
                continue
            m = lambda ys, k: np.mean([y[k] for y in ys]) * 100 if ys else float('nan')
            P(f'| {t} | {len(st)} | {m(st, "hClean"):.1f} | {m(st, "c_A"):.1f} | {m(st, "hWin"):.1f} | {len(al)} | {m(al, "hClean"):.1f} | {m(al, "c_A"):.1f} | {m(al, "hWin"):.1f} |')

    # ─── 4. 候選開關：同一批決策點的配對差 ───
    if a.cand:
        P('\n### 4. 候選開關：同一批決策點，乾淨率 候選 − 對照（以局為群集的 bootstrap）\n')
        P('| 候選（對照） | 局面 | 樣本 | 角色 | n | 改到的點 | 對照 乾淨 % | 候選 乾淨 % | 差 [95%] |')
        P('|---|---|---|---|---|---|---|---|---|')
        for pair in a.cand.split(','):
            c, b0 = pair.split(':')
            for sp in spots:
                for tn, tf in tiers:
                    for rl, rf in roles:
                        xs = [r for r in rows if r['spot'] == sp and tf(r) and rf(r) and r['teams'].get(c) and r['teams'].get(b0)]
                        if len(xs) < 10:
                            continue
                        ch = sum(1 for r in xs if r['teams'][c] != r['teams'][b0])
                        if sp != '2-5（0:1）' and ch == 0:
                            continue
                        gi = [r['gi'] for r in xs]
                        cb = [clean(games[r['gi']], r['teams'][b0]) for r in xs]
                        cc = [clean(games[r['gi']], r['teams'][c]) for r in xs]
                        d = boot_mean([x - y for x, y in zip(cc, cb)], gi)
                        P(f'| {c}（{b0}） | {sp} | {tn} | {rl} | {len(xs)} | {ch} | {np.mean(cb)*100:.1f} | {np.mean(cc)*100:.1f} | {fmt(d, sign=True)} |')

    out = '\n'.join(md) + '\n'
    if a.md:
        with open(a.md, 'w', encoding='utf8') as fh:
            fh.write(out)
    print(out)


if __name__ == '__main__':
    main()
