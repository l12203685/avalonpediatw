#!/usr/bin/env python3
"""第 83 回合：站長 11/26「有條件的拇指」兩個條件在真人梅林的提議上的校準（只有合計數字）。

  python3 scripts/merlinGatedThumbStudy83.py rows_*.jsonl [--flags 局號旗標.json] [--a 0.5 --b 0.6] [--md]

輸入：`merlinPublicThumbStudy.ts --gate` 的 JSONL（梅林第 2–4 局的每一個提議；`gate.human` = 真人帶看得到的紅時那一隊的
(a) pathProb、(b) trustAfter、湖認下；`gate.best` = 忠臣說得通、剛好帶一個看得到的紅的前 3 支裡 (a) 最高的那支；`gate.<標籤>` = 那一組設定帶紅時那一隊）。
`--flags`（不進 repo，要讀玩家名才產生得出來）：局號 → 這一局的梅林在另一半的局（局號奇偶不同）三藍之後活下來的比例 `surv`、局數 `n3`、超額勝率 `ex`；
強的真人梅林 = n3 ≥ 4、surv ≥ 0.6、ex ≥ 0（同第 82 回合）。

輸出：
  1. 真人梅林帶拇指的提議：(a)、(b) 的分布；各門檻組合下有幾成落在門檻內（全部／強的真人梅林；第 3、4 局非強制／第 2 局／強制局）。
  2. 門檻開不開（`gate.best`）：門檻內、門檻外真人梅林帶拇指的比例。
  3. 真人梅林帶拇指時門檻內／外的結果（三紅／三藍死／三藍活、任務三藍）。
  4. 每一組設定帶拇指時有幾成落在門檻內。
"""
import json
import math
import sys
from collections import defaultdict


def load(paths):
    rows = []
    for p in paths:
        with open(p, encoding='utf8') as f:
            rows += [json.loads(x) for x in f if x.strip()]
    return rows


def opt(name, default=None):
    a = sys.argv
    return a[a.index(name) + 1] if name in a else default


def passes(g, A, B):
    return g is not None and g['p'] >= A and (g['lc'] or g['t'] >= B)


def pct(k, n):
    return f'{100 * k / n:.1f}' if n else '—'


def wilson(k, n):
    if not n:
        return '—'
    z = 1.96
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return f'{100 * p:.1f} [{100 * (c - h):.1f}, {100 * (c + h):.1f}]'


def quant(xs, qs=(0.25, 0.5, 0.75)):
    xs = sorted(xs)
    if not xs:
        return ['—'] * len(qs)
    return [f'{xs[min(len(xs) - 1, int(q * len(xs)))]:.2f}' for q in qs]


def main():
    paths = [a for a in sys.argv[1:] if a.endswith('.jsonl')]
    rows = [r for r in load(paths) if 'gate' in r]
    flags = json.load(open(opt('--flags'))) if opt('--flags') else {}
    A = float(opt('--a', 0.5))
    B = float(opt('--b', 0.6))

    def strong(r):
        f = flags.get(str(r['gi']))
        return bool(f) and f.get('n3', 0) >= 4 and (f.get('surv') or 0) >= 0.6 and f.get('ex') is not None and f['ex'] >= 0

    def cell(r):
        if r['forced']:
            return '強制局'
        return '第 2 局' if r['round'] == 2 else '第 3、4 局非強制'

    out = []
    pr = out.append
    pr(f'# 第 83 回合：有條件的拇指——真人梅林的校準（{len(rows)} 個梅林第 2–4 局的提議；門檻 a = {A}、b = {B}）\n')

    # 1. human thumbs
    pr('## 1. 真人梅林帶拇指的提議：(a)、(b) 的分布與落在門檻內的比例\n')
    pr('| 格 | 樣本 | 提議 | 帶拇指 % | (a) 四分位 | (b) 四分位 | 湖認下 % | 落在門檻內 % [95%] |')
    pr('|---|---|---|---|---|---|---|---|')
    for c in ('第 3、4 局非強制', '第 2 局', '強制局'):
        for lab, sel in (('全部真人梅林', lambda r: True), ('強的真人梅林', strong)):
            R = [r for r in rows if cell(r) == c and sel(r)]
            th = [r for r in R if r['human']['thumbs'] > 0 and r['gate'].get('human')]
            g = [r['gate']['human'] for r in th]
            k = sum(passes(x, A, B) for x in g)
            pr(f"| {c} | {lab} | {len(R)} | {pct(len(th), len(R))} | {' / '.join(quant([x['p'] for x in g]))} | {' / '.join(quant([x['t'] for x in g]))} | {pct(sum(x['lc'] for x in g), len(g))} | {wilson(k, len(g))} |")
    pr('')
    pr('門檻組合（第 3、4 局非強制，真人梅林帶拇指落在門檻內 %：全部／強的真人梅林；括號 = 門檻內占全部提議的 %）：\n')
    As = (0.3, 0.4, 0.5, 0.6, 0.7)
    Bs = (0.4, 0.5, 0.6, 0.7)
    pr('| a ＼ b | ' + ' | '.join(str(b) for b in Bs) + ' |')
    pr('|---|' + '---|' * len(Bs))
    R = [r for r in rows if cell(r) == '第 3、4 局非強制']
    th = [r for r in R if r['human']['thumbs'] > 0 and r['gate'].get('human')]
    ths = [r for r in th if strong(r)]
    for a in As:
        cells = []
        for b in Bs:
            k1 = sum(passes(r['gate']['human'], a, b) for r in th)
            k2 = sum(passes(r['gate']['human'], a, b) for r in ths)
            ob = sum(passes(r['gate'].get('best'), a, b) for r in R)
            cells.append(f'{pct(k1, len(th))}／{pct(k2, len(ths))}（{pct(ob, len(R))}）')
        pr(f'| {a} | ' + ' | '.join(cells) + ' |')
    pr('')

    # 2. gate open vs human thumb rate
    pr('## 2. 門檻開著（`gate.best` 過門檻）的時候，真人梅林帶拇指的比例\n')
    pr('| 格 | 樣本 | 門檻開著的提議 % | 門檻內帶拇指 % | 門檻外帶拇指 % |')
    pr('|---|---|---|---|---|')
    for c in ('第 3、4 局非強制', '第 2 局', '強制局'):
        for lab, sel in (('全部真人梅林', lambda r: True), ('強的真人梅林', strong)):
            R = [r for r in rows if cell(r) == c and sel(r)]
            inn = [r for r in R if passes(r['gate'].get('best'), A, B)]
            outn = [r for r in R if not passes(r['gate'].get('best'), A, B)]
            pr(f"| {c} | {lab} | {pct(len(inn), len(R))}（{len(inn)}／{len(R)}） | {wilson(sum(r['human']['thumbs'] > 0 for r in inn), len(inn))} | {wilson(sum(r['human']['thumbs'] > 0 for r in outn), len(outn))} |")
    pr('')

    # 3. outcomes
    pr('## 3. 真人梅林第 3、4 局帶拇指：門檻內／外的結果（同一局多個提議只算第一個）\n')
    pr('| | 局數 | 三紅 % | 三藍死 % | 三藍活 % | 任務三藍 % | 帶拇指的隊出任務 % |')
    pr('|---|---|---|---|---|---|---|')
    for lab, sel in (('全部真人梅林', lambda r: True), ('強的真人梅林', strong)):
        for side in ('門檻內', '門檻外'):
            seen = set()
            k = defaultdict(int)
            went = 0
            for r in rows:
                if r['round'] < 3 or not sel(r) or r['human']['thumbs'] == 0 or not r['gate'].get('human') or r['outcome'] == '?':
                    continue
                if passes(r['gate']['human'], A, B) != (side == '門檻內') or r['gi'] in seen:
                    continue
                seen.add(r['gi'])
                k[r['outcome']] += 1
                went += 1 if r.get('went') else 0
            n = len(seen)
            pr(f"| {lab}・{side} | {n} | {pct(k['三紅'], n)} | {pct(k['三藍死'], n)} | {pct(k['三藍活'], n)} | {pct(k['三藍死'] + k['三藍活'], n)} | {pct(went, n)} |")
    pr('')

    # 4. variants
    labs = sorted({k for r in rows for k in r['gate'] if k not in ('human', 'best', 'nCand')})
    if labs:
        pr('## 4. 機器人各組設定帶拇指時落在門檻內的比例（同一批真人決策點，第 3、4 局非強制）\n')
        pr('| 組 | 帶拇指的點 | 落在門檻內 % | (a) 四分位 | (b) 四分位 |')
        pr('|---|---|---|---|---|')
        for v in labs:
            g = [r['gate'][v] for r in rows if cell(r) == '第 3、4 局非強制' and r['gate'].get(v)]
            pr(f"| {v} | {len(g)} | {wilson(sum(passes(x, A, B) for x in g), len(g))} | {' / '.join(quant([x['p'] for x in g]))} | {' / '.join(quant([x['t'] for x in g]))} |")
        pr('')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
