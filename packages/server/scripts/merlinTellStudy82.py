#!/usr/bin/env python3
"""第 82 回合（藍方・梅林被認出來的訊號）：世界線刺客（第 75／79 回合，基準線預設開）從梅林身上讀到什麼、
每一種訊號把刺客的「梅林在哪」往真梅林推了多少；真人梅林（全部、強的真人梅林）同樣的量，比機器人好不好認；
另外看「擋刀」的那一側：非梅林的藍方（忠臣、派西維爾）有多常看起來像梅林、真人刺客刺錯時刺到誰。

正式的刺客 = 分層（`assassinVisibleRedTier`：當隊長時確定放過梅林看得到的紅的人排到後面；第一層 = 從沒放過的人）
＋ 第一層裡世界線的梅林邊際最高的那一個（`assassinWorldLineOwn75 = 0`）。分層照 TypeScript 正式路徑
（`assassinPathStudy.ts` 的 `front`），世界線在這裡用 Python 重算（`worldLineStudy75.py` 同一個模型），才能拆分量：

  K 派隊（Mk、Lk）：梅林／忠臣當隊長時放了誰（「梅林的隊不帶他看得到的紅」）
  V 票（Mv、Lv）：梅林／忠臣的票（內黑、外白）
  L 湖（Ml、Ll）：梅林／忠臣持湖時湖了誰（世界線不看宣告；好人持湖照 A0 說實話）
  P 派西維爾那一側（Pk、Pv、Pl）：派西維爾對兩根拇指的派法、票、湖（「派西信哪一根」把梅林指出來）

每一種訊號報兩個數：拿掉它之後刺中率少多少（正式的刺客：分層＋世界線）、真梅林的 log P(梅林) 少多少（只用世界線，6 個藍方）。
分層本身也是一個訊號（拿掉分層 = 6 個藍方都在第一層）。

表與權重：機器人局用正式的表（`worldLines75Tables.json`，真人局擬合，刺客實際在用的）；真人局用交叉擬合的表
（偶數號的局用奇數號的局擬合的表，反過來也一樣；權重用正式的權重），真人自己的局不會替自己的梅林加分。

輸入只有座位、角色、隊伍、票、任務牌、湖、刺殺（`keySpotStudy.ts --export-human／--export-bot`、`assassinPathStudy.ts --export-*`），沒有玩家名。
`--flags` 是另外產生的「這一局的梅林是不是強的真人梅林」（局號 → 數字；產生它要讀玩家名，所以那份檔不進 repo，這支只讀局號與數字）。

  cd packages/server
  python3 scripts/merlinTellStudy82.py --games b.jsonl --spots bA.jsonl --kind bot [--json out.json]
  python3 scripts/merlinTellStudy82.py --games h.jsonl --spots hA.jsonl --kind human --flags mflags.json [--json out.json]
  python3 scripts/merlinTellStudy82.py --games b.jsonl --spots bA.jsonl --kind bot --part rates     # 各角色的派隊、票、湖比例
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worldLineStudy75 as wl  # noqa: E402
from merlinLeakStudy77 import load_tables  # noqa: E402

COMPS = wl.COMPS
GROUPS = {
    'K': ('Mk', 'Lk'),
    'V': ('Mv', 'Lv'),
    'L': ('Ml', 'Ll'),
    'P': ('Pk', 'Pv', 'Pl'),
}
GROUP_NAME = {'K': '派隊（梅林／忠臣放了誰）', 'V': '票（梅林／忠臣的內黑、外白）', 'L': '湖（梅林／忠臣湖了誰）', 'P': '派西維爾那一側（派隊、票、湖）'}
SEEN = ('assassin', 'morgana', 'oberon')
TABLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'ai', 'assassin', 'worldLines75Tables.json')


def load(p):
    with open(p, encoding='utf8') as fh:
        return [json.loads(l) for l in fh if l.strip()]


def boot_ci(vals, n=1000, seed=82):
    a = np.asarray(vals, dtype=float)
    if len(a) == 0:
        return (float('nan'), float('nan'))
    rng = np.random.default_rng(seed)
    m = a[rng.integers(0, len(a), size=(n, len(a)))].mean(axis=1)
    return float(np.percentile(m, 2.5)), float(np.percentile(m, 97.5))


def merlin_marginal(worlds, z, blue):
    by = defaultdict(list)
    for (x, y), v in zip(worlds, z):
        by[y].append(v)
    lse = {y: wl.logsumexp(v) for y, v in by.items()}
    tot = wl.logsumexp(list(lse.values()))
    return {s: lse.get(s, -1e9) - tot for s in blue}


def pick(marg, pool):
    best = None
    for s in sorted(pool):
        if best is None or marg[s] > marg[best]:
            best = s
    return best


def score_games(games, kind, tables_path):
    """每一局的世界線分量陣列：機器人 = 正式的表；真人 = 交叉擬合（另一半的局擬合的表）。權重一律用正式的。"""
    tb_full, w = load_tables(tables_path)
    wv = np.array([w[c] for c in COMPS])
    out = {}
    if kind == 'bot':
        for gm in games:
            if gm.g.get('at') is None:
                continue
            worlds, arr = wl.world_scores(gm, tb_full)
            out[gm.g['gi']] = (worlds, arr)
        return out, wv
    for half in (0, 1):
        tb = wl.fit_tables([g for g in games if g.g['gi'] % 2 != half])
        for gm in games:
            if gm.g['gi'] % 2 == half and gm.g.get('at') is not None:
                worlds, arr = wl.world_scores(gm, tb)
                out[gm.g['gi']] = (worlds, arr)
    return out, wv


def spot_rows(games, spots, scored, wv, flags):
    by_gi = {g.g['gi']: g for g in games}
    rows = []
    masks = {'all': np.ones(len(COMPS))}
    for k, cs in GROUPS.items():
        masks['-' + k] = np.array([0.0 if c in cs else 1.0 for c in COMPS])
        masks['+' + k] = np.array([1.0 if c in cs else 0.0 for c in COMPS])
    for sp in spots:
        gi = sp['gi']
        if gi not in scored or gi not in by_gi:
            continue
        gm = by_gi[gi]
        worlds, arr = scored[gi]
        blue = list(gm.blue)
        front = {c['seat'] for c in sp['cands'] if c['front']}
        r = {'gi': gi, 's': sp.get('s'), 'merlin': gm.merlin, 'percival': gm.percival, 'mFront': int(gm.merlin in front),
             'nFront': len(front), 'human': sp.get('human'), 'bot': sp.get('bot'), 'logged': sp.get('logged'),
             'roles': gm.roles, 'flag': flags.get(str(gi)) if flags else None, 'front': front}
        for name, m in masks.items():
            marg = merlin_marginal(worlds, arr @ (wv * m), blue)
            r['lp:' + name] = marg[gm.merlin]
            r['hitT:' + name] = int(pick(marg, front) == gm.merlin)
            r['hitW:' + name] = int(pick(marg, blue) == gm.merlin)
            if name == 'all':
                r['marg'] = marg
                r['wlTSeat'] = pick(marg, front)
        rows.append(r)
    return rows


def pct(rows, k):
    return 100.0 * sum(r[k] for r in rows) / max(len(rows), 1)


def summarize(rows, label):
    """一組刺殺點：正式刺客（分層＋世界線）的刺中率、只用世界線、各訊號拿掉之後少多少。"""
    out = {'label': label, 'n': len(rows)}
    if not rows:
        return out
    out['hitT'] = pct(rows, 'hitT:all')
    out['hitW'] = pct(rows, 'hitW:all')
    out['mFront'] = pct(rows, 'mFront')
    out['nFront'] = float(np.mean([r['nFront'] for r in rows]))
    out['lp'] = float(np.mean([r['lp:all'] for r in rows]))
    # 分層這個訊號：拿掉分層 = 6 個藍方都在第一層（只用世界線）
    d = [r['hitT:all'] - r['hitW:all'] for r in rows]
    out['tier'] = (100 * float(np.mean(d)),) + tuple(100 * v for v in boot_ci(d))
    for k in GROUPS:
        d = [r['hitT:all'] - r['hitT:-' + k] for r in rows]
        out['drop:' + k] = (100 * float(np.mean(d)),) + tuple(100 * v for v in boot_ci(d))
        dl = [r['lp:all'] - r['lp:-' + k] for r in rows]
        out['dlp:' + k] = (float(np.mean(dl)),) + boot_ci(dl)
        out['only:' + k] = pct(rows, 'hitW:+' + k)
    return out


def fmt_ci(t, pp=True):
    if t is None or (isinstance(t, float) and math.isnan(t)):
        return '—'
    m, lo, hi = t
    return f'{m:+.1f} [{lo:+.1f}, {hi:+.1f}]' if pp else f'{m:+.3f} [{lo:+.3f}, {hi:+.3f}]'


def print_table(sums):
    print('| 樣本 | 刺殺點 | 正式刺客刺中 % | 只用世界線 % | 梅林在第一層 % | 第一層平均幾人 | 真梅林 log P（世界線） | 分層這個訊號（pp） | '
          + ' | '.join(f'拿掉{GROUP_NAME[k]}（pp）' for k in GROUPS) + ' |')
    print('|---|---|---|---|---|---|---|---|' + '---|' * len(GROUPS))
    for s in sums:
        if s['n'] == 0:
            continue
        print(f"| {s['label']} | {s['n']} | {s['hitT']:.1f} | {s['hitW']:.1f} | {s['mFront']:.1f} | {s['nFront']:.2f} | {s['lp']:.3f} | {fmt_ci(s['tier'])} | "
              + ' | '.join(fmt_ci(s['drop:' + k]) for k in GROUPS) + ' |')
    print()
    print('| 樣本 | ' + ' | '.join(f'{GROUP_NAME[k]}：真梅林 log P 少多少（nat）' for k in GROUPS) + ' | ' + ' | '.join(f'只用{k} 的刺中 %' for k in GROUPS) + ' |')
    print('|---|' + '---|' * (2 * len(GROUPS)))
    for s in sums:
        if s['n'] == 0:
            continue
        print(f"| {s['label']} | " + ' | '.join(fmt_ci(s['dlp:' + k], pp=False) for k in GROUPS) + ' | '
              + ' | '.join(f"{s['only:' + k]:.1f}" for k in GROUPS) + ' |')


def decoys(rows, who):
    """擋刀：刺錯的時候刺到誰（派西維爾／忠臣），世界線第一名不是梅林時是誰；忠臣、派西在第一層的比例。"""
    out = {}
    tgt_key = {'human': 'human', 'bot': 'bot', 'model': 'wlTSeat'}[who]
    miss = [r for r in rows if r.get(tgt_key) is not None and r[tgt_key] != r['merlin']]
    if miss:
        p = sum(1 for r in miss if r[tgt_key] == r['percival'])
        out['miss'] = len(miss)
        out['missPercival'] = 100.0 * p / len(miss)
        out['missLoyal'] = 100.0 * sum(1 for r in miss if r['roles'][r[tgt_key] - 1] == 'loyal') / len(miss)
        out['missRed'] = 100.0 * sum(1 for r in miss if r['roles'][r[tgt_key] - 1] in ('assassin', 'morgana', 'mordred', 'oberon')) / len(miss)
        # 為什麼是他：刺錯的那個人在不在分層的第一層、在世界線（正式的表）的梅林邊際裡排第幾（1 = 最像梅林）、真梅林排第幾
        out['missTargetFront'] = 100.0 * sum(1 for r in miss if r[tgt_key] in r['front']) / len(miss)
        out['missTargetRank'] = float(np.mean([1 + sum(1 for v in r['marg'].values() if v > r['marg'][r[tgt_key]]) for r in miss]))
        out['missMerlinRank'] = float(np.mean([1 + sum(1 for v in r['marg'].values() if v > r['marg'][r['merlin']]) for r in miss]))
        out['missMerlinFront'] = 100.0 * sum(1 for r in miss if r['mFront']) / len(miss)
    hits = [r for r in rows if r.get(tgt_key) is not None]
    out['n'] = len(hits)
    out['hit'] = 100.0 * sum(1 for r in hits if r[tgt_key] == r['merlin']) / max(len(hits), 1)
    return out


def summarize_decoys(rows, spots_by_gi):
    """非梅林藍方在第一層的比例（從沒當隊長放過梅林看得到的紅），分角色；第一層裡世界線最像梅林的非梅林是誰。"""
    inf = defaultdict(lambda: [0, 0])
    top_non = defaultdict(int)
    for r in rows:
        sp = spots_by_gi[r['gi']]
        front = {c['seat'] for c in sp['cands'] if c['front']}
        for s in range(1, 11):
            role = r['roles'][s - 1]
            if role in ('loyal', 'percival', 'merlin'):
                inf[role][0] += int(s in front)
                inf[role][1] += 1
        non = [s for s in front if s != r['merlin']]
        if non:
            b = max(non, key=lambda s: r['marg'][s])
            top_non[r['roles'][b - 1]] += 1
    res = {role: 100.0 * a / max(n, 1) for role, (a, n) in inf.items()}
    tn = sum(top_non.values())
    res['topNonPercival'] = 100.0 * top_non['percival'] / max(tn, 1)
    return res


# ─── 各角色的比例（--part rates） ────────────────────────────────────────────

def rates(games, sel=None):
    """藍方當隊長放梅林看得到的紅的比例（非強制第 1、2 局、非強制第 3 局起、強制局）、票（內黑、外白、對有看得到的紅的隊贊成）、湖（湖到紅）。"""
    acc = defaultdict(lambda: [0, 0])
    for gm in games:
        if not gm.ok or (sel is not None and not sel(gm)):
            continue
        reds = gm.reds
        seen = {reds[r] for r in SEEN}
        allred = set(reds.values())
        role_of = {s: ('M' if s == gm.merlin else 'P' if s == gm.percival else 'L') for s in gm.blue}
        for p in gm.props:
            team = p['team']
            nseen = len(team & seen)
            ld = p['leader']
            if ld in role_of:
                rs = role_of[ld]
                cell = 'F' if p['forced'] else ('12' if p['r'] <= 2 else '3+')
                acc[(rs, 'leadSeen', cell)][0] += int(nseen > 0)
                acc[(rs, 'leadSeen', cell)][1] += 1
            if p['forced'] or p['appr'] is None:
                continue
            for s, rs in role_of.items():
                if s == ld:
                    continue
                v = int(s in p['appr'])
                on = s in team
                rd = p['r'] <= 2 and 'R12' or 'R3+'
                if on:
                    k = (rs, 'innerBlack', rd, 'seen' if nseen else 'clean')
                    acc[k][0] += 1 - v
                    acc[k][1] += 1
                else:
                    k = (rs, 'outerWhite', rd, 'seen' if nseen else 'clean')
                    acc[k][0] += v
                    acc[k][1] += 1
        for _k, h, t, _cl in gm.lakes:
            if h in role_of:
                rs = role_of[h]
                acc[(rs, 'lakeRed', '')][0] += int(t in allred)
                acc[(rs, 'lakeRed', '')][1] += 1
                acc[(rs, 'lakeSeen', '')][0] += int(t in seen)
                acc[(rs, 'lakeSeen', '')][1] += 1
    return {'|'.join(k): (100.0 * a / n if n else None, n) for k, (a, n) in acc.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', required=True)
    ap.add_argument('--spots')
    ap.add_argument('--kind', choices=('bot', 'human'), required=True)
    ap.add_argument('--flags')
    ap.add_argument('--tables', default=TABLES)
    ap.add_argument('--part', default='signals')
    ap.add_argument('--strong-surv', type=float, default=0.6, help='強的真人梅林：他另一半的局（局號奇偶和這一局不同）當梅林、三藍之後活下來的比例 ≥ 這個值')
    ap.add_argument('--strong-n', type=int, default=4, help='強的真人梅林：另一半（局號奇偶不同）的局裡三藍的梅林局至少幾局；強的刺客同樣用另一半的局、刺中率 ≥ 0.5')
    ap.add_argument('--min-s', type=float, default=None, help='真人局只看桌上強度 S ≥ 這個值')
    ap.add_argument('--json')
    args = ap.parse_args()
    games = [wl.Game(g) for g in load(args.games)]
    games = [g for g in games if g.ok]
    flags = json.load(open(args.flags)) if args.flags else None

    def strong(gi):
        f = flags.get(str(gi)) if flags else None
        return bool(f and f.get('surv') is not None and f['n3'] >= args.strong_n and f['surv'] >= args.strong_surv and f['ex'] is not None and f['ex'] >= 0)

    if args.part == 'rates':
        res = {'all': rates(games)}
        if flags:
            res['strongMerlin'] = rates(games, lambda gm: strong(gm.g['gi']))
        if args.json:
            json.dump(res, open(args.json, 'w'), ensure_ascii=False, indent=1)
        keys = sorted(res['all'])
        print('| 格 | ' + ' | '.join(f'{k} %（n）' for k in res) + ' |')
        print('|---|' + '---|' * len(res))
        for k in keys:
            print(f'| {k} | ' + ' | '.join((f'{res[s][k][0]:.1f}（{res[s][k][1]}）' if k in res[s] and res[s][k][0] is not None else '—') for s in res) + ' |')
        return

    spots = load(args.spots)
    if args.min_s is not None:
        spots = [s for s in spots if s.get('s') is not None and s['s'] >= args.min_s]
    scored, wv = score_games(games, args.kind, args.tables)
    rows = spot_rows(games, spots, scored, wv, flags)
    sums = [summarize(rows, '全部')]
    if args.kind == 'human':
        st = [r for r in rows if strong(r['gi'])]
        sums.append(summarize(st, f'強的真人梅林（其他局存活 ≥ {args.strong_surv:.2f}、≥ {args.strong_n} 局、超額勝率 ≥ 0）'))
        sums.append(summarize([r for r in rows if not strong(r['gi'])], '其他真人梅林'))
        sums.append(summarize([r for r in rows if r['s'] is not None and r['s'] >= 55], '高端桌 S ≥ 55'))
    print_table(sums)
    sp_by = {s['gi']: s for s in spots}
    dec = {'model': decoys(rows, 'model')}
    dec['logged'] = decoys(rows, 'human' if args.kind == 'human' else 'bot')
    dec['front'] = summarize_decoys(rows, sp_by)
    if args.kind == 'human':
        st = [r for r in rows if strong(r['gi'])]
        dec['strongLogged'] = decoys(st, 'human')
        dec['strongModel'] = decoys(st, 'model')
        dec['strongFront'] = summarize_decoys(st, sp_by)

        def strong_asn(r):
            f = r['flag'] or {}
            return f.get('an', 0) >= args.strong_n and f.get('ahit') is not None and f['ahit'] >= 0.5

        sa = [r for r in rows if strong_asn(r)]
        dec['strongAssassinLogged'] = decoys(sa, 'human')
        dec['otherAssassinLogged'] = decoys([r for r in rows if not strong_asn(r)], 'human')
    print('\n擋刀：')
    for k, v in dec.items():
        print(f'  {k}: ' + ', '.join(f'{a}={b:.1f}' if isinstance(b, float) else f'{a}={b}' for a, b in v.items()))
    if args.json:
        json.dump({'sums': sums, 'decoys': dec}, open(args.json, 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
