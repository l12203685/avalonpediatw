#!/usr/bin/env python3
"""第 85 回合（藍方提議・第 1 局隊伍的錨定）：玩家回報「第 1 局任務開藍後，只有能力者會拆第 1 局的隊；
第 1 局的隊＋1 人的任務失敗之後，大家還是繼續派第 1 局的隊＋1 人」。

  python3 scripts/r1AnchorStudy85.py --bot NAME=DIR_OR_GLOB ... [--live DIR] [--games games_cache.json] [--md out.md] [--json out.json]

量的格（座位一律以第 1 局第 1 個隊長為 1家，隊長照輪序；真人局只用推得出隊長的局）：
  A. 第 1 局成功之後，第 2 局（與第 3 局，分第 2 局成功／失敗）非強制的提議：隊伍包含整個第 1 局的隊（超集）的比例，
     分隊長角色（忠臣／派西／梅林／紅方）× 隊長在不在第 1 局的隊上。
  B. 第 1 局成功、之後某一局 k（≥ 2）的任務隊包含整個第 1 局的隊而且任務失敗：下一局（k+1）非強制的提議還包含整個第 1 局的隊的比例，
     分隊長角色；附真實答案——這時第 1 局的隊上真的有紅的比例、加進來的人是紅的比例。
  C. 同一個 B 格：下一局實際出任務的隊包含整個第 1 局的隊時任務的成功率（照派第 1 局的隊到底對不對）。
真人參考：全部真人局、兩邊都強（藍方 6 座位、紅方 4 座位開打前 PR 平均都 ≥ 55，第 1A 節的參考）。
機器人：selfplay/sp.ts 加 detail=1 的結果；--live 讀網站百科AI 對局的 trace（只用百科AI 當隊長的提議）。
輸出只有合計數字（沒有名字、沒有單局紀錄）。
"""
import argparse, glob, json, math, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from missionGapStudy81 import load_humans, load_bots, RED, NEED  # noqa: E402

ROLE_CLASS = {'loyal': 'loyal', 'percival': 'percival', 'merlin': 'merlin'}
CLASSES = ['loyal', 'percival', 'merlin', 'red']
CLASS_ZH = {'loyal': '忠臣', 'percival': '派西', 'merlin': '梅林', 'red': '紅方', 'blue': '藍方合計'}


def cls_of(role):
    return ROLE_CLASS.get(role, 'red' if role in RED else 'loyal')


def leader_of(gidx):
    k = (gidx % 10) + 1
    return '0' if k == 10 else str(k)


def wilson(k, n, z=1.96):
    if n == 0:
        return (float('nan'), float('nan'))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def failed(k, m):
    return m.count('x') >= NEED[k]


def analyse(games, live_ai_only=False):
    """games: dicts with roles (rel seat -> role), rounds [{'p': [[team, approvers, forced]], 'm'}], leaderKnown.
    live games may carry 'aiSeats' (set of rel seats that are bots): only those leaders count when live_ai_only."""
    C = defaultdict(lambda: [0, 0])  # key -> [hits, n]
    T = defaultdict(lambda: [0, 0])  # truth counters
    for g in games:
        if not g.get('rounds') or not g.get('leaderKnown'):
            continue
        roles = g['roles']
        rounds = g['rounds']
        if len(rounds) < 2 or failed(0, rounds[0]['m']):
            continue
        r1 = set(rounds[0]['p'][-1][0])
        gidx = 0
        starts = []
        for r in rounds:
            starts.append(gidx)
            gidx += len(r['p'])
        r1_red = any(roles[s] in RED for s in r1)
        # A: R2 / R3 proposals after R1 success
        for k in (1, 2):
            if k >= len(rounds):
                break
            sub = 'R2' if k == 1 else ('R3|R2o' if not failed(1, rounds[1]['m']) else 'R3|R2x')
            for pi, p in enumerate(rounds[k]['p']):
                if p[2] or pi >= 4:
                    continue
                L = leader_of(starts[k] + pi)
                if live_ai_only and L not in g.get('aiSeats', set()):
                    continue
                c = cls_of(roles[L])
                on = 'on' if L in r1 else 'off'
                sup = r1 <= set(p[0])
                for kk in (f'A|{sub}|{c}', f'A|{sub}|{c}|{on}', f'A|{sub}|{"blue" if c != "red" else "redall"}', f'A|{sub}|{"blue" if c != "red" else "redall"}|{on}'):
                    C[kk][0] += sup
                    C[kk][1] += 1
                if pi == 0:
                    kk = f'A1|{sub}|{c}'
                    C[kk][0] += sup
                    C[kk][1] += 1
        # B: a failed mission k>=2 whose team contains the whole R1 team -> proposals in round k+1
        for k in range(1, len(rounds) - 1):
            team_k = set(rounds[k]['p'][-1][0])
            if not (r1 <= team_k) or not failed(k, rounds[k]['m']):
                continue
            tag = f'R{k + 1}x'
            extra = team_k - r1
            # truth (game level, once per spot)
            T[f'{tag}|n'][1] += 1
            T[f'{tag}|r1red'][0] += r1_red
            T[f'{tag}|r1red'][1] += 1
            T[f'{tag}|extraRed'][0] += any(roles[s] in RED for s in extra)
            T[f'{tag}|extraRed'][1] += 1
            T[f'{tag}|onlyR1red'][0] += r1_red and not any(roles[s] in RED for s in extra)
            T[f'{tag}|onlyR1red'][1] += 1
            nxt = rounds[k + 1]
            for pi, p in enumerate(nxt['p']):
                if p[2] or pi >= 4:
                    continue
                L = leader_of(starts[k + 1] + pi)
                if live_ai_only and L not in g.get('aiSeats', set()):
                    continue
                c = cls_of(roles[L])
                on = 'on' if L in r1 else ('x' if L in extra else 'off')
                sup = r1 <= set(p[0])
                for kk in (f'B|{tag}|{c}', f'B|{tag}|{c}|{on}', f'B|{tag}|{"blue" if c != "red" else "redall"}', f'B|{tag}|{"blue" if c != "red" else "redall"}|{on}',
                           f'B|any|{"blue" if c != "red" else "redall"}', f'B|any|{c}'):
                    C[kk][0] += sup
                    C[kk][1] += 1
                if sup:
                    # repeated R1 team + someone: is the R1-team part still clean in truth?
                    C[f'Btruth|{c}|r1red'][0] += r1_red
                    C[f'Btruth|{c}|r1red'][1] += 1
            # C: the team that actually went in round k+1
            went = set(nxt['p'][-1][0])
            if nxt.get('m'):
                key = 'withR1' if r1 <= went else 'noR1'
                C[f'C|{tag}|{key}'][0] += not failed(k + 1, nxt['m'])
                C[f'C|{tag}|{key}'][1] += 1
    return C, T


def analyse_fail(games, live_ai_only=False):
    """站長 2026-11-26「模擬瓦的非尾派忠臣/派西維爾也應該要找前一局開紅的」：前一局任務失敗（開紅）之後，下一局第 1–4 次提議（非尾派）
    隊上有幾個前一局失敗那一隊的人（不含隊長自己）：0 = 沒碰、部分 = 拆開測、全部 = 整隊留。分隊長角色 × 隊長在不在失敗那一隊上。"""
    C = defaultdict(lambda: [0, 0])
    for g in games:
        if not g.get('rounds') or not g.get('leaderKnown'):
            continue
        roles = g['roles']
        rounds = g['rounds']
        gidx = 0
        starts = []
        for r in rounds:
            starts.append(gidx)
            gidx += len(r['p'])
        for k in range(1, len(rounds)):
            if not failed(k - 1, rounds[k - 1]['m']):
                continue
            F = set(rounds[k - 1]['p'][-1][0])
            for pi, p in enumerate(rounds[k]['p']):
                if p[2] or pi >= 4:
                    continue
                L = leader_of(starts[k] + pi)
                if live_ai_only and L not in g.get('aiSeats', set()):
                    continue
                c = cls_of(roles[L])
                if c not in ('loyal', 'percival'):
                    continue
                Fo = F - {L}
                o = len(set(p[0]) & Fo)
                cat = 'none' if o == 0 else ('all' if o == len(Fo) else 'part')
                on = 'on' if L in F else 'off'
                for key in (f'F|{c}', f'F|lp', f'F|lp|{on}', f'F|lp|R{k + 1}'):
                    for cc in ('none', 'part', 'all'):
                        C[f'{key}|{cc}'][0] += cat == cc
                        C[f'{key}|{cc}'][1] += 1
                    C[f'{key}|dirty'][0] += sum(1 for x in p[0] if roles[x] in RED) >= NEED[k]
                    C[f'{key}|dirty'][1] += 1
    return C


def live_games(d):
    """網站百科AI 對局的 trace → 同一個格式（座位以第 1 局第 1 個隊長為 1家）。"""
    zh = {'刺客': 'assassin', '莫甘娜': 'morgana', '莫德雷德': 'mordred', '奧伯倫': 'oberon', '派西維爾': 'percival', '梅林': 'merlin'}
    out = []
    for f in sorted(glob.glob(os.path.join(d, '*.json'))):
        try:
            j = json.load(open(f, encoding='utf-8'))
        except Exception:
            continue
        t = j.get('trace') if isinstance(j, dict) else None
        if not t or len(t.get('seats', [])) != 10 or not t.get('proposals'):
            continue
        start = t['proposals'][0]['leader']

        def rel(s):
            k = ((s - start) % 10) + 1
            return '0' if k == 10 else str(k)
        roles = {}
        ai = set()
        for s in t['seats']:
            roles[rel(s['seat'])] = zh.get(s['role'], 'loyal')
            if s.get('ai'):
                ai.add(rel(s['seat']))
        rounds = []
        ms = {m['round']: m for m in t.get('missions', [])}
        ok = True
        for p in t['proposals']:
            rd = p['round']
            while len(rounds) < rd:
                rounds.append({'p': [], 'm': ''})
            rounds[rd - 1]['p'].append([''.join(rel(x) for x in p['team']), ''.join(rel(x) for x in p['approve']), bool(p['forced'])])
            if rel(p['leader']) != leader_of(sum(len(r['p']) for r in rounds) - 1):
                ok = False
        for rd, r in enumerate(rounds, 1):
            m = ms.get(rd)
            if m:
                r['m'] = 'o' * (len(m['team']) - m['fails']) + 'x' * m['fails']
        rounds = [r for r in rounds if r['m']]
        out.append({'roles': roles, 'rounds': rounds, 'leaderKnown': ok, 'aiSeats': ai})
    return out


def fmt(h, n):
    if n == 0:
        return '—'
    lo, hi = wilson(h, n)
    return f'{100 * h / n:.1f} [{100 * lo:.0f}, {100 * hi:.0f}]（{n}）'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bot', nargs='*', default=[], help='NAME=DIR_OR_GLOB')
    ap.add_argument('--live')
    ap.add_argument('--games', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'games_cache.json'))
    ap.add_argument('--thr', type=float, default=55)
    ap.add_argument('--md')
    ap.add_argument('--json')
    a = ap.parse_args()
    H = load_humans(a.games)
    groups = [('真人（全部）', H, False), ('真人（兩邊都強）', [g for g in H if g['b'] is not None and g['b'] >= a.thr and g['r'] >= a.thr], False)]
    for spec in a.bot:
        name, path = spec.split('=', 1)
        groups.append((name, load_bots([path]), False))
    if a.live:
        groups.append(('網站百科AI 對局（只算百科AI 隊長）', live_games(a.live), True))
    res = {}
    for name, gs, ai_only in groups:
        C, T = analyse(gs, ai_only)
        res[name] = {'C': {k: v for k, v in C.items()}, 'T': {k: v for k, v in T.items()}, 'games': len(gs)}
    names = [g[0] for g in groups]
    L = []
    L.append('### A. 第 1 局成功之後：提議包含整個第 1 局的隊（%［95%］（提議數））\n')
    for sub, title in (('R2', '第 2 局'), ('R3|R2o', '第 3 局（第 2 局成功）'), ('R3|R2x', '第 3 局（第 2 局失敗）')):
        L.append(f'\n**{title}，第 1–4 次提議**\n')
        L.append('| 隊長 | ' + ' | '.join(names) + ' |')
        L.append('|---|' + '---|' * len(names))
        for c in ['loyal', 'percival', 'merlin', 'blue', 'redall']:
            for on in ('', '|off', '|on'):
                key = f'A|{sub}|{c}{on}'
                lab = (CLASS_ZH.get(c, '紅方')) + {'': '', '|off': '・不在第 1 局的隊上', '|on': '・在第 1 局的隊上'}[on]
                L.append(f'| {lab} | ' + ' | '.join(fmt(*res[n]['C'].get(key, [0, 0])) for n in names) + ' |')
    L.append('\n### B. 第 1 局成功、之後一局的任務隊包含整個第 1 局的隊而且失敗：下一局的提議還包含整個第 1 局的隊\n')
    for tag, title in (('R2x', '第 2 局失敗 → 第 3 局'), ('R3x', '第 3 局失敗 → 第 4 局'), ('any', '合計（第 3–5 局）')):
        L.append(f'\n**{title}，第 1–4 次提議**\n')
        L.append('| 隊長 | ' + ' | '.join(names) + ' |')
        L.append('|---|' + '---|' * len(names))
        rows = [('loyal', ''), ('percival', ''), ('merlin', ''), ('blue', ''), ('redall', '')]
        if tag != 'any':
            rows += [('blue', '|off'), ('blue', '|on'), ('blue', '|x')]
        for c, on in rows:
            key = f'B|{tag}|{c}{on}'
            lab = CLASS_ZH.get(c, '紅方') + {'': '', '|off': '・不在第 1 局的隊上、也不是加進來的人', '|on': '・在第 1 局的隊上', '|x': '・就是加進來的那個人'}[on]
            L.append(f'| {lab} | ' + ' | '.join(fmt(*res[n]['C'].get(key, [0, 0])) for n in names) + ' |')
        if tag != 'any':
            for tk, lab in (('n', '局數'), ('r1red', '真實：第 1 局的隊上有紅 %'), ('extraRed', '真實：加進來的人是紅 %'), ('onlyR1red', '真實：紅只在第 1 局的隊上 %')):
                if tk == 'n':
                    L.append(f'| {lab} | ' + ' | '.join(str(res[n]['T'].get(f'{tag}|n', [0, 0])[1]) for n in names) + ' |')
                else:
                    L.append(f'| {lab} | ' + ' | '.join(fmt(*res[n]['T'].get(f'{tag}|{tk}', [0, 0])) for n in names) + ' |')
            for key, lab in ((f'C|{tag}|withR1', '下一局出任務的隊包含第 1 局的隊：任務成功 %'), (f'C|{tag}|noR1', '下一局出任務的隊拆掉第 1 局的隊：任務成功 %')):
                L.append(f'| {lab} | ' + ' | '.join(fmt(*res[n]['C'].get(key, [0, 0])) for n in names) + ' |')
    L.append('\n### C. 站長 11/26「非尾派忠臣／派西也應該要找前一局開紅的」：前一局失敗之後，第 1–4 次提議（忠臣＋派西隊長）隊上有幾個失敗那一隊的人（不含自己）\n')
    F = {n: analyse_fail(gs, ai) for n, gs, ai in groups}
    L.append('| 隊長 | 失敗那一隊的人 | ' + ' | '.join(names) + ' |')
    L.append('|---|---|' + '---|' * len(names))
    for key, lab in (('F|lp', '忠臣＋派西'), ('F|loyal', '忠臣'), ('F|percival', '派西'), ('F|lp|off', '不在失敗那一隊上'), ('F|lp|on', '在失敗那一隊上'),
                     ('F|lp|R2', '第 2 局'), ('F|lp|R3', '第 3 局'), ('F|lp|R4', '第 4 局'), ('F|lp|R5', '第 5 局')):
        for cc, cl in (('none', '一個都沒帶 %'), ('part', '帶一部分（拆開測）%'), ('all', '整隊都帶 %'), ('dirty', '隊會失敗 %')):
            L.append(f'| {lab} | {cl} | ' + ' | '.join(fmt(*F[n].get(f'{key}|{cc}', [0, 0])) for n in names) + ' |')
    L.append('\n**B 格裡藍方隊長照派第 1 局的隊＋人時，第 1 局的隊上真的有紅 %**\n')
    L.append('| 隊長 | ' + ' | '.join(names) + ' |')
    L.append('|---|' + '---|' * len(names))
    for c in ['loyal', 'percival', 'merlin']:
        L.append(f'| {CLASS_ZH[c]} | ' + ' | '.join(fmt(*res[n]['C'].get(f'Btruth|{c}|r1red', [0, 0])) for n in names) + ' |')
    L.append('\n局數：' + '、'.join(f'{n} {res[n]["games"]}' for n in names))
    md = '\n'.join(L)
    if a.md:
        open(a.md, 'w', encoding='utf-8').write(md + '\n')
    else:
        print(md)
    if a.json:
        json.dump(res, open(a.json, 'w', encoding='utf-8'), ensure_ascii=False)


if __name__ == '__main__':
    main()


def pr_table(paths, base=None):
    """`r1AnchorStudy85.ts` 的輸出（真人局決策點上的機器人 vs 真人）：每一格的「整個第 1 局的隊都在」比例、隊會失敗的比例、量尺（機器人 − 真人，pp／決策）。
    base 給了另外算候選 − 對照（同一批決策點，配對）。"""
    def load(p):
        return [json.loads(l) for l in open(p, encoding='utf-8') if l.strip()]
    out = []
    rows = load(paths)
    B = {(r['gi'], r['rd'], r['att']): r for r in load(base) if r['spot'] != 'F'} if base else None
    cells = defaultdict(list)
    for r in rows:
        if not r['bt'] or r['spot'] == 'F':
            continue
        for key in ((r['spot'], r['role']), (r['spot'], 'blue'), (r['spot'], 'blue', r['on'])):
            cells[key].append(r)
    def se_mean(xs):
        n = len(xs)
        if n < 2:
            return (float('nan'), float('nan'))
        m = sum(xs) / n
        v = sum((x - m) ** 2 for x in xs) / (n - 1)
        return (m, math.sqrt(v / n))
    out.append('| 格 | 隊長 | n | 真人：整個第 1 局的隊都在 % | 機器人 % | 真人隊會失敗 % | 機器人隊會失敗 % | 量尺 機器人 − 真人（pp／決策） |' + (' 候選 − 對照（pp） | 候選改到 |' if B else ''))
    out.append('|---|---|---|---|---|---|---|---|' + ('---|---|' if B else ''))
    spots = [('A2', '第 2 局'), ('A3o', '第 3 局（第 2 局成功）'), ('A3x', '第 3 局（第 2 局失敗、沒有包含第 1 局的隊）'), ('B', '前一局包含第 1 局的隊而且失敗')]
    for sp, lab in spots:
        for who in ('loyal', 'percival', 'merlin', 'blue', ('blue', 0), ('blue', 1), ('blue', 2)):
            key = (sp,) + (who if isinstance(who, tuple) else (who,))
            rs = cells.get(key, [])
            if not rs:
                continue
            n = len(rs)
            hs = sum(r['ht']['sup'] for r in rs) / n
            bs = sum(r['bt']['sup'] for r in rs) / n
            hd = sum(r['ht']['dirty'] for r in rs) / n
            bd = sum(r['bt']['dirty'] for r in rs) / n
            m, se = se_mean([100 * (r['b'] - r['h']) for r in rs])
            wl = CLASS_ZH.get(who, '') if not isinstance(who, tuple) else '藍方・' + {0: '不在第 1 局的隊上', 1: '在第 1 局的隊上', 2: '失敗那一隊加進來的人'}[who[1]]
            line = f'| {lab} | {wl} | {n} | {100 * hs:.1f} | {100 * bs:.1f} | {100 * hd:.1f} | {100 * bd:.1f} | {m:+.2f} ± {se:.2f} |'
            if B:
                ds = []
                ch = 0
                for r in rs:
                    b0 = B.get((r['gi'], r['rd'], r['att']))
                    if b0 is None:
                        continue
                    ds.append(100 * (r['b'] - b0['b']))
                    ch += (r['bt'] != b0['bt']) or abs(r['b'] - b0['b']) > 1e-12
                m2, se2 = se_mean(ds)
                line += f' {m2:+.3f} ± {se2:.3f} | {ch} |'
            out.append(line)
    # F 格（站長 11/26）：前一局失敗之後的非尾派提議（忠臣＋派西），sup 0 = 一個都沒帶、1 = 帶一部分、2 = 整隊
    out.append('')
    out.append('| F 格：前一局失敗之後、非尾派（忠臣＋派西） | n | 真人：一個都沒帶 % | 機器人 % | 真人：帶一部分 % | 機器人 % | 真人隊會失敗 % | 機器人 % | 量尺 機器人 − 真人 |' + (' 候選 − 對照（pp） | 候選改到 |' if B else ''))
    out.append('|---|---|---|---|---|---|---|---|---|' + ('---|---|' if B else ''))
    BF = {(r['gi'], r['rd'], r['att']): r for r in load(base) if r['spot'] == 'F'} if base else None
    for lab, f in (('全部', lambda r: True), ('忠臣', lambda r: r['role'] == 'loyal'), ('派西', lambda r: r['role'] == 'percival'),
                   ('在失敗那一隊上', lambda r: r['on'] == 1), ('不在失敗那一隊上', lambda r: r['on'] == 0),
                   ('第 2 局', lambda r: r['rd'] == 2), ('第 3 局', lambda r: r['rd'] == 3), ('第 4–5 局', lambda r: r['rd'] >= 4)):
        rs = [r for r in rows if r['spot'] == 'F' and r['bt'] and f(r)]
        if not rs:
            continue
        n = len(rs)
        m, se = se_mean([100 * (r['b'] - r['h']) for r in rs])
        line = (f"| {lab} | {n} | {100 * sum(r['ht']['sup'] == 0 for r in rs) / n:.1f} | {100 * sum(r['bt']['sup'] == 0 for r in rs) / n:.1f} | "
                f"{100 * sum(r['ht']['sup'] == 1 for r in rs) / n:.1f} | {100 * sum(r['bt']['sup'] == 1 for r in rs) / n:.1f} | "
                f"{100 * sum(r['ht']['dirty'] for r in rs) / n:.1f} | {100 * sum(r['bt']['dirty'] for r in rs) / n:.1f} | {m:+.2f} ± {se:.2f} |")
        if BF:
            ds = []
            ch = 0
            for r in rs:
                b0 = BF.get((r['gi'], r['rd'], r['att']))
                if b0 is None:
                    continue
                ds.append(100 * (r['b'] - b0['b']))
                ch += (r['bt'] != b0['bt']) or abs(r['b'] - b0['b']) > 1e-12
            m2, se2 = se_mean(ds)
            line += f' {m2:+.3f} ± {se2:.3f} | {ch} |'
        out.append(line)
    return '\n'.join(out)


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--pr-only':
    pass
