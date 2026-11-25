#!/usr/bin/env python3
"""第 77 回合（藍方・梅林）：梅林的提議在世界線刺客（第 75 回合 `assassinWorldLine75`）眼裡露在哪幾格。

世界線模型裡，一個藍方座位 S「像梅林還是像忠臣」在派隊這一塊的證據是
    D(S) = w_Mk × Σ[log P(事件 | S 是梅林) − log P(事件 | 不分角色的藍方)]
         − w_Lk × Σ[log P(事件 | S 是忠臣) − log P(事件 | 不分角色的藍方)]
事件 = S 當隊長的每一次提議 × 每個座位「有沒有被放上隊」（表 = 第 75 回合真人局擬合的 `worldLines75Tables.json`，疊加權重同表）。
真梅林的 D 平均比真忠臣高多少，就是刺客從提議讀到多少；這支把那個差拆到「提議的格」與「放了誰」：

  --part leak   真人局 vs 自我對打（同一張表）：每一格的「每局貢獻」= 梅林在這一格的提議的 D 總和／梅林座位數 − 忠臣的 D 總和／忠臣座位數；
                機器人 − 真人 = 機器人的梅林比真人的梅林多露的部分。格 = 第幾局 × 第幾次提議 × 比數 × 隊上幾個梅林看得到的紅 × 自己在不在隊上。
                另外照「放了誰」拆（自己、看得到的紅、莫德雷德、派西、忠臣；有放／沒放）。
  --part rates  梅林／忠臣／派西當隊長時的比例（放自己、放看得到的紅、放莫德雷德、放派西、照派上一次成功的隊…），真人 vs 機器人。
  --part votes  同 leak，但看票（Mv、Lv）：第幾局 × 在不在隊上 × 隊上幾個看得到的紅 × 贊成／反對。
  --part hit    只用梅林的派隊（Mk）與全部分量時，世界線第一名是梅林的比例（給自我對打的候選比較用；不分層）。
  --part refit-ablate  同 refit，但逐一拿掉／只留某些分量（機器人的規律落在哪一個分量）。
  --part refit  紅方跟著調整：世界線的表改用這一份自我對打重新擬合（交叉擬合），只用世界線、不分層的刺中率；對照 = 真人局擬合的正式表。

輸入 = `keySpotStudy.ts --export-human／--export-bot` 的 jsonl（只有座位、角色、隊伍、票、任務牌、湖、刺殺，沒有玩家名）。

  cd packages/server
  python3 scripts/merlinLeakStudy77.py --human h.jsonl --bot b.jsonl --part leak [--spots-only] [--json out.json]
"""
import argparse
import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worldLineStudy75 as wl  # noqa: E402

SEEN = ('assassin', 'morgana', 'oberon')


def load_tables(path):
    """正式的表 → (`wl.Tables`, 疊加權重 dict)。"""
    t = json.load(open(path, encoding='utf8'))
    tb = wl.Tables()
    wl.KAPPA = float(t['kappa'])
    for k, (n, x) in t['bin'].items():
        parts = tuple(int(p) if p.lstrip('-').isdigit() else p for p in k.split('|'))
        tb.n[parts] = float(n)
        tb.k[parts] = float(x)
    for rs, row in t['lake'].items():
        for c, v in row.items():
            tb.lake[rs][c] = float(v)
    return tb, dict(zip(t['comps'], t['weights']))


def score_of(gm, p):
    """這一次提議之前的比數 '成功:失敗'。"""
    ok = sum(1 for qr, _t, f in gm.g['quests'] if qr < p['r'] and not wl.mf(qr, f))
    return f'{ok}:{p["fails"]}'


def prop_rows(gm, tb, w):
    """這一局每個藍方隊長的每一次提議：角色、格、D（梅林假設與忠臣假設各自對其他座位的角色取平均）、照「放了誰」拆的 D。"""
    reds = gm.reds
    rr = wl.red_role_of(reds)
    seen = {reds[r] for r in SEEN}
    d = reds['mordred']
    out = []
    for s in gm.blue:
        role = 'M' if s == gm.merlin else 'P' if s == gm.percival else 'L'
        mine = [p for p in gm.props if p['leader'] == s]
        if not mine:
            continue
        others = [b for b in gm.blue if b != s]
        # 每一個假設各算一次，再取平均（世界線對另一個角色是誰取邊際；這裡用平均近似）
        per_prop = [defaultdict(float) for _ in mine]
        hyps_m = [('M', x, None) for x in others]
        hyps_l = [('L', x, y) for x in others for y in others if x != y]
        for hyps, comp_w in ((hyps_m, w['Mk']), (hyps_l, -w['Lk'])):
            for rs, x, y in hyps:
                ev = wl.pick_events(gm, reds, s, rs, x, y)
                # pick_events 照提議的順序、每一次提議 10 個事件（自己＋9 個其他座位）
                for i in range(len(mine)):
                    chunk = ev[i * 10:(i + 1) * 10]
                    targets = ['self'] + [t for t in range(1, 11) if t != s]
                    for (_c, key, inv, v), t in zip(chunk, targets):
                        if t == 'self':
                            tag = 'self'
                        elif t in seen:
                            tag = 'seen'
                        elif t == d:
                            tag = 'mordred'
                        elif t == gm.merlin:
                            tag = 'merlin'
                        elif t == gm.percival:
                            tag = 'percival'
                        else:
                            tag = 'loyal'
                        per_prop[i][(tag, v)] += comp_w * (tb.ll_bin(key, v) - tb.ll_bin(inv, v)) / len(hyps)
        for p, parts in zip(mine, per_prop):
            team = p['team']
            n_seen = len(team & seen)
            out.append({
                'role': role, 'r': p['r'], 'a': p['a'], 'forced': p['forced'], 'score': score_of(gm, p), 'nseen': n_seen,
                'self': int(s in team), 'mordred': int(d in team), 'perc': int(gm.percival in team), 'merl': int(gm.merlin in team),
                'reuse': int(bool(p['lastSucc']) and p['lastSucc'] <= team), 'nfail': len(team & p['onFail']),
                'nred': sum(1 for t in team if t in rr), 'size': len(team), 'D': sum(parts.values()), 'parts': dict(parts),
            })
    return out


def collect(games, tb, w):
    rows = []
    seats = defaultdict(int)
    for gm in games:
        seats['M'] += 1
        seats['P'] += 1
        seats['L'] += 4
        rows.extend(prop_rows(gm, tb, w))
    return rows, seats


def cell_of(r, level):
    a = '5' if r['forced'] else str(r['a'])
    ns = '2+' if r['nseen'] >= 2 else str(r['nseen'])
    if level == 'round':
        return (f'R{r["r"]}',)
    if level == 'ra':
        return (f'R{r["r"]}', f'第{a}次')
    if level == 'seen':
        return (f'R{r["r"]}', '強制' if r['forced'] else '非強制', f'看得到的紅×{ns}')
    if level == 'self':
        return (f'R{r["r"]}', '強制' if r['forced'] else '非強制', '自己在隊上' if r['self'] else '自己不在')
    if level == 'full':
        return (f'R{r["r"]}', f'第{a}次', r['score'], f'紅×{ns}', '自己在' if r['self'] else '自己不在')
    raise ValueError(level)


def contrib(rows, seats, level):
    """每一格：梅林的提議數／座位、平均 D；忠臣同；每局貢獻 = Σ_梅林 D／梅林座位 − Σ_忠臣 D／忠臣座位。"""
    acc = defaultdict(lambda: {'nM': 0, 'dM': 0.0, 'nL': 0, 'dL': 0.0})
    for r in rows:
        if r['role'] == 'P':
            continue
        c = acc[cell_of(r, level)]
        if r['role'] == 'M':
            c['nM'] += 1
            c['dM'] += r['D']
        else:
            c['nL'] += 1
            c['dL'] += r['D']
    out = {}
    for k, c in acc.items():
        out[k] = {
            'rateM': c['nM'] / seats['M'], 'rateL': c['nL'] / seats['L'],
            'meanM': c['dM'] / c['nM'] if c['nM'] else 0.0, 'meanL': c['dL'] / c['nL'] if c['nL'] else 0.0,
            'c': c['dM'] / seats['M'] - c['dL'] / seats['L'], 'nM': c['nM'], 'nL': c['nL'],
        }
    return out


def parts_contrib(rows, seats):
    """照「放了誰」拆：每局貢獻。"""
    acc = defaultdict(lambda: [0.0, 0.0, 0, 0])
    for r in rows:
        if r['role'] == 'P':
            continue
        i = 0 if r['role'] == 'M' else 1
        for (tag, v), val in r['parts'].items():
            a = acc[(tag, v)]
            a[i] += val
    return {k: a[0] / seats['M'] - a[1] / seats['L'] for k, a in acc.items()}


def fmt_key(k):
    return '・'.join(k)


def part_leak(hum, bot, tb, w, out_json):
    res = {}
    data = {}
    for name, games in (('真人', hum), ('機器人', bot)):
        rows, seats = collect(games, tb, w)
        data[name] = (rows, seats)
        tot_m = sum(r['D'] for r in rows if r['role'] == 'M') / seats['M']
        tot_l = sum(r['D'] for r in rows if r['role'] == 'L') / seats['L']
        tot_p = sum(r['D'] for r in rows if r['role'] == 'P') / seats['P']
        print(f'{name}：{len(games)} 局；每個座位整局的 D（像梅林 − 像忠臣，派隊）平均：梅林 {tot_m:+.3f}、忠臣 {tot_l:+.3f}、派西 {tot_p:+.3f}；'
              f'梅林 − 忠臣 = {tot_m - tot_l:+.3f}、梅林 − 派西 = {tot_m - tot_p:+.3f}')
        res[name] = {'games': len(games), 'D_merlin': tot_m, 'D_loyal': tot_l, 'D_percival': tot_p}
    for level, title in (('round', '第幾局'), ('ra', '第幾局 × 第幾次提議'), ('seen', '第幾局 × 強制 × 隊上幾個梅林看得到的紅'), ('self', '第幾局 × 強制 × 自己在不在隊上')):
        h = contrib(*data['真人'], level)
        b = contrib(*data['機器人'], level)
        print(f'\n**{title}**（每局貢獻 = 梅林的 D 總和／梅林座位 − 忠臣的 D 總和／忠臣座位；正 = 這一格讓梅林看起來比忠臣更像梅林）\n')
        print('| 格 | 真人：梅林的提議／局、平均 D | 真人：忠臣的提議／座位局、平均 D | 真人 每局貢獻 | 機器人：梅林、平均 D | 機器人：忠臣、平均 D | 機器人 每局貢獻 | 機器人 − 真人 |')
        print('|---|---|---|---|---|---|---|---|')
        keys = sorted(set(h) | set(b))
        zero = {'rateM': 0, 'rateL': 0, 'meanM': 0, 'meanL': 0, 'c': 0, 'nM': 0, 'nL': 0}
        tab = {}
        for k in keys:
            x, y = h.get(k, zero), b.get(k, zero)
            tab[fmt_key(k)] = {'human': x, 'bot': y, 'diff': y['c'] - x['c']}
            print(f'| {fmt_key(k)} | {x["rateM"]:.3f}、{x["meanM"]:+.2f} | {x["rateL"]:.3f}、{x["meanL"]:+.2f} | {x["c"]:+.3f} | '
                  f'{y["rateM"]:.3f}、{y["meanM"]:+.2f} | {y["rateL"]:.3f}、{y["meanL"]:+.2f} | {y["c"]:+.3f} | {y["c"] - x["c"]:+.3f} |')
        print(f'| 合計 | | | {sum(v["c"] for v in h.values()):+.3f} | | | {sum(v["c"] for v in b.values()):+.3f} | {sum(v["c"] for v in b.values()) - sum(v["c"] for v in h.values()):+.3f} |')
        res[level] = tab
    # 最細的格：機器人 − 真人 最大的 25 格
    h = contrib(*data['真人'], 'full')
    b = contrib(*data['機器人'], 'full')
    zero = {'rateM': 0, 'rateL': 0, 'meanM': 0, 'meanL': 0, 'c': 0, 'nM': 0, 'nL': 0}
    keys = sorted(set(h) | set(b), key=lambda k: -(b.get(k, zero)['c'] - h.get(k, zero)['c']))
    print('\n**最細的格（第幾局 × 第幾次 × 比數 × 隊上看得到的紅 × 自己）：機器人 − 真人 最大的 25 格與最小的 10 格**\n')
    print('| 格 | 真人 梅林 n／平均 D | 真人 忠臣 n／平均 D | 真人 每局貢獻 | 機器人 梅林 n／平均 D | 機器人 忠臣 n／平均 D | 機器人 每局貢獻 | 機器人 − 真人 |')
    print('|---|---|---|---|---|---|---|---|')
    full = {}
    for k in keys:
        x, y = h.get(k, zero), b.get(k, zero)
        full[fmt_key(k)] = {'human': x, 'bot': y, 'diff': y['c'] - x['c']}
    for k in keys[:25] + keys[-10:]:
        x, y = h.get(k, zero), b.get(k, zero)
        print(f'| {fmt_key(k)} | {x["nM"]}／{x["meanM"]:+.2f} | {x["nL"]}／{x["meanL"]:+.2f} | {x["c"]:+.4f} | {y["nM"]}／{y["meanM"]:+.2f} | {y["nL"]}／{y["meanL"]:+.2f} | {y["c"]:+.4f} | {y["c"] - x["c"]:+.4f} |')
    res['full'] = full
    # 照放了誰拆
    ph = parts_contrib(*data['真人'])
    pb = parts_contrib(*data['機器人'])
    names = {'self': '自己', 'seen': '梅林看得到的紅（刺客／莫甘娜／奧伯倫）', 'mordred': '莫德雷德', 'percival': '派西維爾', 'merlin': '梅林（忠臣隊長放他）', 'loyal': '忠臣'}
    print('\n**照「放了誰」拆**（每局貢獻；同上的定義）\n')
    print('| 對象 | 有沒有放 | 真人 | 機器人 | 機器人 − 真人 |')
    print('|---|---|---|---|---|')
    pt = {}
    for tag in ('self', 'seen', 'mordred', 'percival', 'merlin', 'loyal'):
        for v in (1, 0):
            x, y = ph.get((tag, v), 0.0), pb.get((tag, v), 0.0)
            pt[f'{tag}|{v}'] = {'human': x, 'bot': y}
            print(f'| {names[tag]} | {"放" if v else "沒放"} | {x:+.3f} | {y:+.3f} | {y - x:+.3f} |')
    print(f'| 合計 | | {sum(ph.values()):+.3f} | {sum(pb.values()):+.3f} | {sum(pb.values()) - sum(ph.values()):+.3f} |')
    res['parts'] = pt
    if out_json:
        with open(out_json, 'w', encoding='utf8') as fh:
            json.dump(res, fh, ensure_ascii=False, indent=1)


def part_rates(hum, bot, tb, w):
    data = {name: collect(games, tb, w)[0] for name, games in (('真人', hum), ('機器人', bot))}

    def rate(rows, f):
        return f'{100 * np.mean([f(r) for r in rows]):.1f}%' if rows else '—'
    cols = [('提議數', None), ('放自己', lambda r: r['self']), ('隊上有看得到的紅', lambda r: r['nseen'] > 0), ('有 2 個以上', lambda r: r['nseen'] >= 2),
            ('放莫德雷德', lambda r: r['mordred']), ('放派西', lambda r: r['perc']), ('放梅林', lambda r: r['merl']), ('整隊沒有紅', lambda r: r['nred'] == 0),
            ('照派上一次成功的隊（整隊都在）', lambda r: r['reuse']), ('隊上有出過失敗任務的人', lambda r: r['nfail'] > 0)]
    for forced in (False, True):
        print(f'\n**{"強制局（第 5 次）" if forced else "非強制的提議"}**\n')
        print('| 第幾局 | 隊長 | 來源 | ' + ' | '.join(c for c, _ in cols) + ' |')
        print('|---|---|---|' + '---|' * len(cols))
        for rd in range(1, 6):
            for role, rn in (('M', '梅林'), ('L', '忠臣'), ('P', '派西')):
                for name in ('真人', '機器人'):
                    rows = [r for r in data[name] if r['r'] == rd and r['forced'] == forced and r['role'] == role]
                    print(f'| {rd} | {rn} | {name} | {len(rows)} | ' + ' | '.join(rate(rows, f) for _, f in cols[1:]) + ' |')


def part_hit(bot, tb, w):
    """世界線第一名是梅林的比例（不分層）：全部分量、只用 Mk、拿掉 Mk。"""
    games = [g for g in bot if g.g.get('at') is not None]
    weights = np.array([w[c] for c in wl.COMPS])
    scored = wl.score_many(games, tb, 'full')
    print(f'刺殺點 {len(games)}（紀錄上的刺中率 {100 * np.mean([g.g["at"] == g.merlin for g in games]):.1f}%）')
    for name, keep in (('全部分量', None), ('只用 Mk', ['Mk']), ('只用 Mk＋Lk', ['Mk', 'Lk']), ('拿掉 Mk', [c for c in wl.COMPS if c != 'Mk']),
                       ('只用 Mv', ['Mv']), ('拿掉梅林那一側', [c for c in wl.COMPS if c[0] != 'M'])):
        mask = np.array([1.0 if keep is None or c in keep else 0.0 for c in wl.COMPS])
        hit = 0
        for g, sc in zip(games, scored):
            _, worlds, arr = sc[0]
            my, _mx = wl.marginals([(None, worlds, arr @ (weights * mask))])
            hit += wl.argmax_seat(my) == g.merlin
        print(f'| {name} | {100 * hit / len(games):.1f} |')


def vote_rows(gm, tb, w):
    """每個藍方座位的每一張票（非強制、可靠、不是自己的提議）：像梅林 − 像忠臣的證據（Mv、Lv），照格累計。"""
    reds = gm.reds
    seen = {reds[r] for r in SEEN}
    out = []
    for s in gm.blue:
        role = 'M' if s == gm.merlin else 'P' if s == gm.percival else 'L'
        others = [b for b in gm.blue if b != s]
        mine = [p for p in gm.props if not p['forced'] and p['appr'] is not None and p['leader'] != s]
        if not mine:
            continue
        acc = [0.0] * len(mine)
        hyps_m = [('M', x, None) for x in others]
        hyps_l = [('L', x, y) for x in others for y in others if x != y]
        for hyps, comp_w in ((hyps_m, w['Mv']), (hyps_l, -w['Lv'])):
            for rs, x, y in hyps:
                ev = wl.vote_events(gm, reds, s, rs, x, y)
                for i, (_c, key, inv, v) in enumerate(ev):
                    acc[i] += comp_w * (tb.ll_bin(key, v) - tb.ll_bin(inv, v)) / len(hyps)
        for p, d in zip(mine, acc):
            ns = len(p['team'] & seen)
            out.append({'role': role, 'D': d, 'cell': ('R1–R2' if p['r'] <= 2 else f'R{p["r"]}', '在隊上' if s in p['team'] else '不在隊上',
                                                        f'看得到的紅×{"2+" if ns >= 2 else ns}', '贊成' if s in p['appr'] else '反對')})
    return out


def part_votes(hum, bot, tb, w):
    print('票（非強制、不是自己的提議）：每局貢獻 = 梅林的證據總和／梅林座位 − 忠臣的證據總和／忠臣座位（正 = 這一格讓梅林比忠臣更像梅林）\n')
    tabs = {}
    for name, games in (('真人', hum), ('機器人', bot)):
        acc = defaultdict(lambda: [0.0, 0.0, 0, 0])
        for gm in games:
            for r in vote_rows(gm, tb, w):
                if r['role'] == 'P':
                    continue
                a = acc[r['cell']]
                i = 0 if r['role'] == 'M' else 1
                a[i] += r['D']
                a[2 + i] += 1
        g = len(games)
        tabs[name] = {k: (a[0] / g - a[1] / (4 * g), a[2] / g, a[3] / (4 * g)) for k, a in acc.items()}
    print('| 格 | 真人：梅林／忠臣 每座位局的票數 | 真人 每局貢獻 | 機器人：梅林／忠臣 票數 | 機器人 每局貢獻 | 機器人 − 真人 |')
    print('|---|---|---|---|---|---|')
    zero = (0.0, 0.0, 0.0)
    for k in sorted(set(tabs['真人']) | set(tabs['機器人'])):
        x, y = tabs['真人'].get(k, zero), tabs['機器人'].get(k, zero)
        if abs(x[0]) < 0.002 and abs(y[0]) < 0.002:
            continue
        print(f'| {fmt_key(k)} | {x[1]:.2f}／{x[2]:.2f} | {x[0]:+.3f} | {y[1]:.2f}／{y[2]:.2f} | {y[0]:+.3f} | {y[0] - x[0]:+.3f} |')
    th, tbt = sum(v[0] for v in tabs['真人'].values()), sum(v[0] for v in tabs['機器人'].values())
    print(f'| 合計（全部的格） | | {th:+.3f} | | {tbt:+.3f} | {tbt - th:+.3f} |')


def part_refit_ablate(bot, kfold):
    """重新擬合的表（同 refit）拿掉／只留某些分量時的刺中率：機器人的規律落在哪一個分量。"""
    wl.KFOLD = kfold
    spots = [g for g in bot if g.g.get('at') is not None]
    sets = [('全部分量', None), ('拿掉梅林的派隊（Mk）', ['Mk']), ('只用梅林的派隊（Mk）', [c for c in wl.COMPS if c != 'Mk']),
            ('拿掉梅林那一側（Mk Mv Ml）', ['Mk', 'Mv', 'Ml']), ('拿掉派西那一側（Pk Pv Pl）', ['Pk', 'Pv', 'Pl']), ('拿掉忠臣那一側（Lk Lv Ll）', ['Lk', 'Lv', 'Ll']),
            ('拿掉票（Pv Mv Lv）', ['Pv', 'Mv', 'Lv'])]
    print(f'局數 {len(bot)}、刺殺點 {len(spots)}；表與疊加權重用這一份自我對打擬合（分 {kfold} 份交叉擬合），只用世界線、不分層')
    print('| 分量 | 刺中率 % | 派西第一名是真派西 % |')
    print('|---|---|---|')
    for name, drop in sets:
        mask = [0.0 if drop and c in drop else 1.0 for c in wl.COMPS]
        out, _w, _ = wl.crossfit(bot, view='full', mask=mask)
        hit = px = 0
        for g in spots:
            my, mx = wl.marginals(out[g.g['gi']])
            hit += wl.argmax_seat(my) == g.merlin
            px += wl.argmax_seat(mx) == g.percival
        print(f'| {name} | {100 * hit / len(spots):.1f} | {100 * px / len(spots):.1f} |', flush=True)


def part_refit(bot, human_tb, w, kfold):
    """紅方跟著調整：世界線的表與疊加權重改用這一份自我對打重新擬合（交叉擬合：每一份用其他幾份的局擬合），只用世界線、不分層的刺中率。
    對照 = 真人局擬合的正式表在同一批刺殺點上的刺中率。"""
    wl.KFOLD = kfold
    out, weights, _ = wl.crossfit(bot, view='full', verbose=True)
    spots = [g for g in bot if g.g.get('at') is not None]
    weights_h = np.array([w[c] for c in wl.COMPS])
    scored = wl.score_many(spots, human_tb, 'full')
    hit_r = hit_h = px_r = 0
    for g, sc in zip(spots, scored):
        my, mx = wl.marginals(out[g.g['gi']])
        hit_r += wl.argmax_seat(my) == g.merlin
        px_r += wl.argmax_seat(mx) == g.percival
        _, worlds, arr = sc[0]
        my2, _ = wl.marginals([(None, worlds, arr @ weights_h)])
        hit_h += wl.argmax_seat(my2) == g.merlin
    n = len(spots)
    three = n / len(bot)
    print(f'局數 {len(bot)}、刺殺點 {n}（任務三藍 {100 * three:.2f}%）；紀錄上的刺中率 {100 * np.mean([g.g["at"] == g.merlin for g in spots]):.1f}%')
    print(f'| 真人局擬合的表（不分層） | {100 * hit_h / n:.1f} | 藍方勝率 {100 * three * (1 - hit_h / n):.2f}% |')
    print(f'| 這一份自我對打重新擬合的表（分 {kfold} 份交叉擬合；不分層） | {100 * hit_r / n:.1f} | 藍方勝率 {100 * three * (1 - hit_r / n):.2f}% | 派西第一名是真派西 {100 * px_r / n:.1f}% |')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--human')
    ap.add_argument('--bot')
    ap.add_argument('--part', default='leak')
    ap.add_argument('--tables', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'ai', 'assassin', 'worldLines75Tables.json'))
    ap.add_argument('--spots-only', action='store_true', help='只看有刺殺的局（三藍）')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--json')
    ap.add_argument('--kfold', type=int, default=4)
    args = ap.parse_args()
    tb, w = load_tables(args.tables)

    def games_of(path):
        gs = [wl.Game(g) for g in wl.load(path)]
        gs = [g for g in gs if g.ok and (not args.spots_only or g.g.get('at') is not None)]
        return gs[:args.limit] if args.limit else gs
    bot = games_of(args.bot) if args.bot else []
    if args.part == 'hit':
        return part_hit(bot, tb, w)
    if args.part == 'refit':
        return part_refit(bot, tb, w, args.kfold)
    if args.part == 'refit-ablate':
        return part_refit_ablate(bot, args.kfold)
    hum = games_of(args.human)
    if args.part == 'leak':
        return part_leak(hum, bot, tb, w, args.json)
    if args.part == 'rates':
        return part_rates(hum, bot, tb, w)
    if args.part == 'votes':
        return part_votes(hum, bot, tb, w)
    raise SystemExit('--part leak|rates|votes|hit|refit|refit-ablate')


if __name__ == '__main__':
    main()
