"""第 51 回合：「這一局之後還會當隊長」對投票的影響（真人局 vs 機器人自我對打）。

  python3 leaderVoteStudy.py --human rows.csv [--bot DIR_OR_GLOB ...] [--boot 200] [--md out.md]

真人列由 `leaderVoteStudy.ts` 產生；機器人列直接讀 `selfplay/sp.ts --flag detail=1` 的結果檔（`g` 欄，座位以 1-1 隊長為 1 家）。
效果 = 分層的贊成率差（之後還會當隊長 − 不會），層 = 陣營／角色組 × 在不在隊上 × 第幾局 × 第幾次提議 × 隊上有沒有紅 × 比分；
權重 = 層內兩組人數的調和平均（Mantel–Haenszel 的風險差）。區間 = 以局為單位的集群自助法。
在隊上的差 < 0 = 內黑變多；不在隊上的差 > 0 = 外白變多（百科〈名詞說明與簡稱〉：內黑 = 隊伍內投反對、外白 = 隊伍外投贊成）。
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

COLS = ['g', 'st', 'sp', 'role', 'round', 'att', 'on', 'fut', 'tail', 'ahead', 'app', 'tred', 'lred', 'succ', 'fail']
# role codes: 0 loyal 1 percival 2 merlin 3 assassin 4 morgana 5 mordred 6 oberon
GROUPS = {
    'loyal': lambda r: r == 0,
    'good': lambda r: r <= 2,
    'red(no oberon)': lambda r: (r >= 3) & (r <= 5),
}


def load_human(path):
    a = np.loadtxt(path, delimiter=',', skiprows=1, dtype=np.int64)
    return {c: a[:, k] for k, c in enumerate(COLS)}


def bot_rows_from_game(gi, g, out):
    cfg = g['c']
    roles = {}
    for code, ch in zip([3, 4, 5, 6, 1, 2], cfg):
        roles[10 if ch == '0' else int(ch)] = code
    seat = lambda ch: 10 if ch == '0' else int(ch)
    idx = 0
    succ = fail = 0
    for ri, rd in enumerate(g['r']):
        rnd = ri + 1
        for ai, (team, apps) in enumerate(rd['p']):
            att = ai + 1
            leader = idx % 10 + 1
            idx += 1
            if att == 5:
                continue
            ts = {seat(c) for c in team}
            ap = {seat(c) for c in apps}
            tred = int(any(roles.get(s, 0) >= 3 for s in ts))
            lred = int(roles.get(leader, 0) >= 3)
            left = 5 - att
            for s in range(1, 11):
                if s == leader:
                    continue
                off = (s - leader) % 10
                out.append((gi, 0, 0, roles.get(s, 0), rnd, att, int(s in ts), int(1 <= off <= left), int(off == left), off,
                            int(s in ap), tred, lred, succ, fail))
        m = rd.get('m', '')
        if m:
            need = 2 if rnd == 4 else 1
            if m.count('x') >= need:
                fail += 1
            else:
                succ += 1


def load_bot(patterns):
    files = []
    for p in patterns:
        files += sorted(glob.glob(os.path.join(p, '*.json')) if os.path.isdir(p) else glob.glob(p))
    rows = []
    gi = 0
    for f in files:
        d = json.load(open(f))
        k = d['cols'].index('g')
        for r in d['rows']:
            if r[k]:
                bot_rows_from_game(gi, json.loads(r[k]), rows)
                gi += 1
    a = np.array(rows, dtype=np.int64)
    return {c: a[:, k] for k, c in enumerate(COLS)}, gi


def stratified_rd(D, mask, flag, boot, rng):
    """Mantel–Haenszel risk difference of `app` between flag=1 and flag=0 rows inside `mask`, strata as in the docstring."""
    m = mask
    strat_key = (D['role'][m] * 1000000 + D['on'][m] * 100000 + D['round'][m] * 10000 + D['att'][m] * 1000 + D['tred'][m] * 100
                 + D['succ'][m] * 10 + D['fail'][m])
    _, sid = np.unique(strat_key, return_inverse=True)
    f = flag[m]
    y = D['app'][m]
    g = D['g'][m]
    ng = int(D['g'].max()) + 1
    S = sid.max() + 1

    def est(w):
        n1 = np.bincount(sid, weights=w * f, minlength=S)
        n0 = np.bincount(sid, weights=w * (1 - f), minlength=S)
        y1 = np.bincount(sid, weights=w * f * y, minlength=S)
        y0 = np.bincount(sid, weights=w * (1 - f) * y, minlength=S)
        ok = (n1 > 0) & (n0 > 0)
        wt = np.where(ok, n1 * n0 / np.maximum(n1 + n0, 1e-9), 0)
        rd = np.where(ok, y1 / np.maximum(n1, 1e-9) - y0 / np.maximum(n0, 1e-9), 0)
        return (wt * rd).sum() / max(wt.sum(), 1e-9)

    point = est(np.ones(len(y)))
    bs = []
    for _ in range(boot):
        wg = np.bincount(rng.integers(0, ng, ng), minlength=ng).astype(float)
        bs.append(est(wg[g]))
    lo, hi = np.percentile(bs, [2.5, 97.5]) if boot else (np.nan, np.nan)
    n1 = int(f.sum())
    return point, lo, hi, n1, int(len(f) - n1), y[f == 1].mean() if n1 else np.nan, y[f == 0].mean() if len(f) > n1 else np.nan


def table(D, name, boot, rng, sub=None):
    lines = []
    base = np.ones(len(D['g']), dtype=bool) if sub is None else sub
    for gname, gf in GROUPS.items():
        gm = base & gf(D['role'])
        for on in (1, 0):
            for scope, extra, flag in (
                ('全部回合', np.ones_like(gm), D['fut']),
                ('第 1–2 局', D['round'] <= 2, D['fut']),
                ('第 3–5 局', D['round'] >= 3, D['fut']),
                ('尾家 vs 不當隊長', D['fut'] == D['tail'], D['tail']),
                ('中間的隊長 vs 不當隊長', D['tail'] == 0, D['fut']),
            ):
                m = gm & (D['on'] == on) & extra.astype(bool)
                if m.sum() < 50:
                    continue
                p, lo, hi, n1, n0, r1, r0 = stratified_rd(D, m, flag, boot, rng)
                lines.append(f"| {name} | {gname} | {'在隊上' if on else '不在隊上'} | {scope} | {n1:,}／{n0:,} | {100*r1:.1f}% | {100*r0:.1f}% | "
                             f"**{100*p:+.2f}** [{100*lo:+.2f}, {100*hi:+.2f}] |")
    return lines


def cells(D, name, sub=None):
    """Raw approval rates by attempt × on-team × future, good camp, R1 and R3+ (for the doc's small table)."""
    base = np.ones(len(D['g']), dtype=bool) if sub is None else sub
    good = base & (D['role'] <= 2)
    out = []
    for rs, rm in (('R1', D['round'] == 1), ('R2', D['round'] == 2), ('R3+', D['round'] >= 3)):
        for on in (1, 0):
            row = [name, rs, '在隊上（內黑率）' if on else '不在隊上（外白率）']
            for att in (1, 2, 3, 4):
                for fut in (1, 0):
                    m = good & rm & (D['on'] == on) & (D['att'] == att) & (D['fut'] == fut)
                    n = int(m.sum())
                    if n < 20:
                        row.append('—')
                        continue
                    r = D['app'][m].mean()
                    row.append(f"{100*(1-r if on else r):.1f}%（{n:,}）")
            out.append('| ' + ' | '.join(row) + ' |')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--human', required=True)
    ap.add_argument('--bot', nargs='*', default=[])
    ap.add_argument('--boot', type=int, default=200)
    ap.add_argument('--md')
    a = ap.parse_args()
    rng = np.random.default_rng(51)
    H = load_human(a.human)
    out = ['| 資料 | 投票者 | 位置 | 範圍 | n（之後還當隊長／不會） | 贊成率（還會） | 贊成率（不會） | 分層差 pp [95%] |', '|---|---|---|---|---|---|---|---|']
    out += table(H, '真人（全部）', a.boot, rng)
    out += table(H, '真人（強者玩家）', a.boot, rng, H['sp'] == 1)
    out += table(H, '真人（強者桌 S≥55）', a.boot, rng, H['st'] == 1)
    cl = ['| 資料 | 回合 | 位置 | 1-1 還會 | 不會 | 第 2 次 還會 | 不會 | 第 3 次 還會 | 不會 | 第 4 次（尾家） | 不會 |', '|---|' * 1 + '---|' * 10]
    cl += cells(H, '真人')
    cl += cells(H, '強者玩家', H['sp'] == 1)
    if a.bot:
        B, n = load_bot(a.bot)
        out += table(B, f'機器人（{n:,} 局）', min(a.boot, 100), rng)
        cl += cells(B, '機器人')
    text = '\n'.join(out) + '\n\n' + '\n'.join(cl) + '\n'
    print(text)
    if a.md:
        open(a.md, 'w').write(text)


if __name__ == '__main__':
    main()
