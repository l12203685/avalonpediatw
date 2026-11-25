#!/usr/bin/env python3
"""第 79 回合：採用世界線刺客（`assassinWorldLine75=1`）之前，在現行程式上重新驗證用的小工具。

  spots   真人刺殺點：舊刺客（基準線、真人桌讀法）和新刺客（世界線，交叉擬合）的刺中率，分兩半、強度層、任務順序；以刺殺點 bootstrap 95%
          python3 scripts/adoptCheck79.py spots --old hA_A.jsonl --old-human hA_H.jsonl --new hA_cf.jsonl [--new-human hA_Hcf.jsonl]
  selfplay 自我對打：兩組結果檔（`selfplay/sp.ts` 的 {meta, cols, rows}）逐局配對
          python3 scripts/adoptCheck79.py selfplay --old DIR --old-prefix OLD_ --new DIR --new-prefix NEW_

輸入只有座位、角色、分數與結果，沒有玩家名。
"""
import argparse
import glob
import json
import os
import random

ORDER_NAME = {'BRRBB': '藍紅紅藍藍', 'BRBB': '藍紅藍藍', 'RRBBB': '紅紅藍藍藍', 'BBB': '藍藍藍', 'RBBB': '紅藍藍藍'}


def load(path):
    return [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]


def tier_of(s):
    if s is None:
        return 'S不明'
    return '弱桌' if s < 38 else '一般桌' if s < 55 else '強桌'


def boot(vals, rng, n=4000):
    if not vals:
        return (0.0, 0.0, 0.0)
    m = 100 * sum(vals) / len(vals)
    k = len(vals)
    ms = sorted(100 * sum(vals[rng.randrange(k)] for _ in range(k)) / k for _ in range(n))
    return (m, ms[int(0.025 * n)], ms[int(0.975 * n) - 1])


def fmt(t):
    return f'{t[0]:+.1f} [{t[1]:+.1f}, {t[2]:+.1f}]'


def spots(a):
    old = load(a.old)
    oh = load(a.old_human)
    new = load(a.new)
    nh = load(a.new_human) if a.new_human else None
    by = lambda rows_: {r['gi']: r for r in rows_}
    OH, NEW, NH = by(oh), by(new), (by(nh) if nh else None)
    assert set(OH) == set(NEW) == {r['gi'] for r in old} and len(OH) == len(old)
    rng = random.Random(79)
    rows = []
    for r in old:
        m = r['merlin']
        i = r['gi']
        oh, new, nh = OH, NEW, NH
        rows.append({'gi': r['gi'], 'tier': tier_of(r['s']), 'order': ORDER_NAME.get(r['order'], '其他順序'),
                     'hum': int(r['human'] == m), 'old': int(r['bot'] == m), 'oh': int(oh[i]['bot'] == m), 'new': int(new[i]['bot'] == m),
                     'chg': int(r['bot'] != new[i]['bot']), 'chgH': int(oh[i]['bot'] != new[i]['bot']),
                     'sameH': int(nh[i]['bot'] == new[i]['bot']) if nh else 1})
    print(f'刺殺點 {len(rows)}；新刺客改到 {sum(x["chg"] for x in rows)} 點（對基準線）、{sum(x["chgH"] for x in rows)} 點（對真人桌讀法）'
          + (f'；真人桌讀法＋世界線和基準線＋世界線同目標 {sum(x["sameH"] for x in rows)}／{len(rows)}' if nh else ''))
    scopes = [('全部', lambda x: True), ('偶數號', lambda x: x['gi'] % 2 == 0), ('奇數號', lambda x: x['gi'] % 2 == 1)]
    for t in ('弱桌', '一般桌', '強桌', 'S不明'):
        scopes.append((t, lambda x, t=t: x['tier'] == t))
        scopes.append((t + '・偶數號', lambda x, t=t: x['tier'] == t and x['gi'] % 2 == 0))
        scopes.append((t + '・奇數號', lambda x, t=t: x['tier'] == t and x['gi'] % 2 == 1))
    for o in ('藍紅紅藍藍', '藍紅藍藍', '紅紅藍藍藍', '藍藍藍', '紅藍藍藍', '其他順序'):
        scopes.append((o, lambda x, o=o: x['order'] == o))
    print('| 範圍 | n | 真人刺客 % | 舊刺客・基準線 % | 舊刺客・真人桌讀法 % | **新刺客（世界線，交叉擬合）%** | 新 − 舊基準線 [95%] | 新 − 舊真人桌讀法 [95%] | 新 − 真人 [95%] |')
    print('|---|---|---|---|---|---|---|---|---|')
    out = {}
    for name, f in scopes:
        g = [x for x in rows if f(x)]
        n = len(g)
        if not n:
            continue
        p = lambda k: 100 * sum(x[k] for x in g) / n
        d1 = boot([x['new'] - x['old'] for x in g], rng)
        d2 = boot([x['new'] - x['oh'] for x in g], rng)
        d3 = boot([x['new'] - x['hum'] for x in g], rng)
        out[name] = {'n': n, 'human': p('hum'), 'old': p('old'), 'oldHuman': p('oh'), 'new': p('new'), 'newMinusOld': d1, 'newMinusOldHuman': d2, 'newMinusHuman': d3}
        print(f'| {name} | {n} | {p("hum"):.1f} | {p("old"):.1f} | {p("oh"):.1f} | **{p("new"):.1f}** | {fmt(d1)} | {fmt(d2)} | {fmt(d3)} |')
    if a.json:
        json.dump(out, open(a.json, 'w', encoding='utf8'), ensure_ascii=False, indent=1)


def load_sp(d, prefix):
    out = {}
    meta = None
    for f in sorted(glob.glob(os.path.join(d, prefix + '*.json'))):
        j = json.load(open(f, encoding='utf8'))
        meta = j['meta']
        c = j['cols']
        for r in j['rows']:
            out[r[0]] = {k: r[i] for i, k in enumerate(c)}
    return out, meta


def selfplay(a):
    O, mo = load_sp(a.old, a.old_prefix)
    N, mn = load_sp(a.new, a.new_prefix)
    ids = sorted(set(O) & set(N))
    n = len(ids)
    rng = random.Random(79)
    pre = 0
    for i in ids:
        go, gn = json.loads(O[i]['g']), json.loads(N[i]['g'])
        go.pop('a', None)
        gn.pop('a', None)
        pre += int(go == gn)
    kills = [i for i in ids if O[i]['merlinKilled'] >= 0]
    assert all(N[i]['merlinKilled'] >= 0 for i in kills)
    chg = sum(1 for i in kills if json.loads(O[i]['g']).get('a') != json.loads(N[i]['g']).get('a'))
    gain = sum(1 for i in kills if N[i]['merlinKilled'] > O[i]['merlinKilled'])
    loss = sum(1 for i in kills if N[i]['merlinKilled'] < O[i]['merlinKilled'])
    bw = lambda D: 100 * sum(D[i]['blueWon'] for i in ids) / n
    tb = lambda D: 100 * sum(D[i]['threeBlue'] for i in ids) / n
    hit = lambda D: 100 * sum(D[i]['merlinKilled'] for i in kills) / len(kills)
    red = boot([O[i]['blueWon'] - N[i]['blueWon'] for i in ids], rng)
    print(f'局數 {n}（{min(ids)}–{max(ids)}）；刺殺之前逐局相同 {pre}／{n}；刺殺點 {len(kills)}，目標不同 {chg}，多刺中 {gain}／少刺中 {loss}')
    print(f'任務三藍 舊 {tb(O):.2f}% 新 {tb(N):.2f}%；刺中率 {hit(O):.2f} → {hit(N):.2f}%；藍方勝率 {bw(O):.2f} → {bw(N):.2f}%；紅方勝率差 {red[0]:+.2f} [{red[1]:+.2f}, {red[2]:+.2f}]')
    res = {'games': n, 'sameBeforeAssassination': pre, 'spots': len(kills), 'changed': chg, 'gain': gain, 'loss': loss, 'threeBlue': tb(O), 'hitOld': hit(O), 'hitNew': hit(N),
           'blueOld': bw(O), 'blueNew': bw(N), 'redDelta': red, 'byOrder': {}}

    def order(g):
        s = ''.join('藍' if 'x' not in r['m'] or (len(r['m']) == 5 and r['m'].count('x') < 2 and False) else '紅' for r in g['r'])
        return s

    def order2(g):
        out = ''
        for k, r in enumerate(g['r']):
            fails = r['m'].count('x')
            need = 2 if (k == 3) else 1  # 10 人局第 4 局要兩張失敗
            out += '紅' if fails >= need else '藍'
        return out
    by = {}
    for i in kills:
        by.setdefault(order2(json.loads(O[i]['g'])), []).append(i)
    print('| 任務順序 | 刺殺點 | 刺中率 舊 % | 新 % |')
    print('|---|---|---|---|')
    for k in sorted(by, key=lambda k: -len(by[k])):
        g = by[k]
        ho = 100 * sum(O[i]['merlinKilled'] for i in g) / len(g)
        hn = 100 * sum(N[i]['merlinKilled'] for i in g) / len(g)
        res['byOrder'][k] = {'n': len(g), 'old': ho, 'new': hn}
        print(f'| {k} | {len(g)} | {ho:.1f} | {hn:.1f} |')
    if a.json:
        json.dump(res, open(a.json, 'w', encoding='utf8'), ensure_ascii=False, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('part', choices=['spots', 'selfplay'])
    ap.add_argument('--old')
    ap.add_argument('--old-human')
    ap.add_argument('--new')
    ap.add_argument('--new-human')
    ap.add_argument('--old-prefix', default='OLD_')
    ap.add_argument('--new-prefix', default='NEW_')
    ap.add_argument('--json')
    a = ap.parse_args()
    (spots if a.part == 'spots' else selfplay)(a)


if __name__ == '__main__':
    main()
