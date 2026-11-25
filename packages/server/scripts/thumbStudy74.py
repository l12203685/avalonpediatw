#!/usr/bin/env python3
"""第 74 回合：派西拇指題的情境分析（每日一題題庫的全部派西題）。

    cd packages/server
    npx tsx scripts/thumbStudy74.ts > thumb.jsonl
    npx tsx scripts/scenarioSuite.ts --no-fixtures --bank --bank-class thumb,percTeam --quiet --dump base.jsonl
    npx tsx scripts/scenarioSuite.ts --no-fixtures --bank --bank-class thumb,percTeam --quiet --flag percivalNoInfo74=0.6 --dump cand.jsonl
    python3 scripts/thumbStudy74.py --thumb thumb.jsonl --base base.jsonl [--alt 名稱=cand.jsonl ...]

印三張表（Markdown）：
  1. 被失敗任務沾到的那一根拇指是梅林的比例，照局面拆（只有一根被沾到的題）；
  2. 派西的隊：帶梅林／帶莫甘娜／兩根都不帶、全藍的比例——真人 vs 百科AI（每一套），照「誰被沾到 × 第幾局」拆；
  3. 「哪一根是梅林」的準度：後驗 vs 第 39 回合擬合的讀法（正確率、Brier）。
輸入只有題號、座位、角色，沒有玩家名字；輸出只有彙總。
"""
import argparse
import json


def rows_of(paths):
    out = {}
    for path in paths.split(','):
        with open(path, encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                out[(r['profile'].split('＋')[0], r['cls'], r['id'].split(':')[1])] = r
    return out


def pct(xs):
    xs = list(xs)
    return '—' if not xs else '%.1f%%' % (100 * sum(1 for x in xs if x) / len(xs))


def brier(ps):
    ps = list(ps)
    return '—' if not ps else '%.3f' % (sum((1 - p) ** 2 for p in ps) / len(ps))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--thumb', required=True)
    ap.add_argument('--base', required=True)
    ap.add_argument('--alt', action='append', default=[])
    args = ap.parse_args()
    T = {}
    with open(args.thumb, encoding='utf-8') as f:
        for line in f:
            if line.strip():
                t = json.loads(line)
                T[t['id'].split(':')[1]] = t
    runs = [('現行', rows_of(args.base))] + [(a.split('=', 1)[0], rows_of(a.split('=', 1)[1])) for a in args.alt]
    ids = sorted(T)
    only_m = [i for i in ids if T[i]['M']['onFail'] > 0 and T[i]['G']['onFail'] == 0]
    only_g = [i for i in ids if T[i]['M']['onFail'] == 0 and T[i]['G']['onFail'] > 0]
    none = [i for i in ids if T[i]['M']['onFail'] == 0 and T[i]['G']['onFail'] == 0]
    both = [i for i in ids if T[i]['M']['onFail'] > 0 and T[i]['G']['onFail'] > 0]

    # 1. 被沾到的那一根是梅林的比例
    single = [(i, 'M') for i in only_m] + [(i, 'G') for i in only_g]
    print('### 只有一根拇指出過失敗的任務：被沾到的那一根是梅林的比例\n')
    print('| 局面 | 題數 | 被沾到的是梅林 |')
    print('|---|---|---|')

    def cond(name, f):
        q = [(i, k) for i, k in single if f(T[i][k], T[i]['G' if k == 'M' else 'M'], T[i])]
        if len(q) >= 15:
            print('| %s | %d | %s |' % (name, len(q), pct(k == 'M' for _, k in q)))

    cond('全部', lambda x, o, t: True)
    cond('那一次任務一張失敗', lambda x, o, t: x['stainFails'] == 1)
    cond('那一次任務兩張以上失敗', lambda x, o, t: x['stainFails'] >= 2)
    cond('第 1 局沾到的', lambda x, o, t: x['stainRound'] == 1)
    cond('第 2 局沾到的', lambda x, o, t: x['stainRound'] == 2)
    cond('強制局（第 5 次）', lambda x, o, t: x['stainForced'] is True)
    cond('非強制', lambda x, o, t: x['stainForced'] is False)
    cond('被沾到的那一根自己派的', lambda x, o, t: x['stainLedBy'] == 1)
    cond('別人派的', lambda x, o, t: x['stainLedBy'] == 0)
    cond('派西自己也在那一隊上', lambda x, o, t: x['stainMeOn'])
    cond('另一根拇指派過被沾到的那一根', lambda x, o, t: o['proposedOther'] >= 1)
    cond('被沾到的那一根派過另一根拇指', lambda x, o, t: x['proposedOther'] >= 1)
    cond('沾到之後另一根當過隊長、帶了被沾到的那一根', lambda x, o, t: x['afterOther'] >= 1 and x['afterOtherWithMe'] >= 1)
    cond('沾到之後另一根當過隊長、沒帶', lambda x, o, t: x['afterOther'] >= 1 and x['afterOtherWithMe'] == 0)
    cond('被沾到的那一根內黑過', lambda x, o, t: x['innerBlack'] >= 1)
    cond('被沾到的那一根也出過成功的任務', lambda x, o, t: x['onSucc'] >= 1)
    cond('另一根出過成功的任務', lambda x, o, t: o['onSucc'] >= 1)

    # 2. 派西的隊
    groups = [
        ('全部', ids),
        ('第 2 局', [i for i in ids if T[i]['round'] == 2]),
        ('第 3 局', [i for i in ids if T[i]['round'] == 3]),
        ('第 4、5 局', [i for i in ids if T[i]['round'] >= 4]),
        ('兩根都沒出過失敗的任務', none),
        ('只有梅林出過失敗的任務', only_m),
        ('只有莫甘娜出過失敗的任務', only_g),
        ('兩根都出過', both),
        ('第 2 局、只有一根出過（合計）', [i for i in only_m + only_g if T[i]['round'] == 2]),
        ('第 2 局、只有梅林出過', [i for i in only_m if T[i]['round'] == 2]),
        ('第 2 局、只有莫甘娜出過', [i for i in only_g if T[i]['round'] == 2]),
        ('第 3 局、只有梅林出過', [i for i in only_m if T[i]['round'] == 3]),
        ('第 3 局、只有莫甘娜出過', [i for i in only_g if T[i]['round'] == 3]),
    ]
    print('\n### 派西的隊：帶梅林／帶莫甘娜／兩根都不帶，和全藍（第 4 局：紅少於 2 個）的比例\n')
    print('| 局面 | 題數 | 誰 | 帶梅林 | 帶莫甘娜 | 兩根都不帶 | 全藍 |')
    print('|---|---|---|---|---|---|---|')
    for name, q in groups:
        if not q:
            continue
        print('| %s | %d | 真人 | %s | %s | %s | %s |' % (
            name, len(q), pct(T[i]['humanHasMerlin'] for i in q), pct(T[i]['humanHasMorgana'] for i in q),
            pct(not T[i]['humanHasMerlin'] and not T[i]['humanHasMorgana'] for i in q), pct(T[i]['humanReds'] < T[i]['need'] for i in q)))
        for run, d in runs:
            for prof in ('基準線', '一般真人桌'):
                th = [d.get((prof, 'bank:thumb', i)) for i in q]
                pt = [d.get((prof, 'bank:percTeam', i)) for i in q]
                if any(x is None for x in th) or any(x is None for x in pt):
                    continue
                print('| | | %s・%s | %s | %s | %s | %s |' % (
                    run, prof, pct(r['x']['teamHasMerlin'] for r in th), pct(r['x']['teamHasMorgana'] for r in th),
                    pct(not r['x']['teamHasMerlin'] and not r['x']['teamHasMorgana'] for r in th),
                    pct(r['x']['reds'] < T[i]['need'] for r, i in zip(pt, q))))

    # 3. 哪一根是梅林
    print('\n### 「哪一根是梅林」：後驗 vs 第 39 回合擬合的讀法（正確率／Brier；讀法平手算半對）\n')
    print('| 局面 | 題數 | ' + ' | '.join('%s・%s 後驗' % (run, prof) for run, _ in runs for prof in ('基準線', '一般真人桌')) + ' | 擬合的讀法 |')
    print('|---|---|' + '---|' * (2 * len(runs) + 1))
    for name, q in groups:
        if not q:
            continue
        cells = []
        for run, d in runs:
            for prof in ('基準線', '一般真人桌'):
                th = [d.get((prof, 'bank:thumb', i)) for i in q]
                if any(x is None for x in th):
                    cells.append('—')
                    continue
                cells.append('%s／%s' % (pct(r['pass'] for r in th), brier(1 - r['x']['pMerlinRed'] for r in th)))
        rp = [T[i]['pReadMerlin'] for i in q]
        acc = 100 * sum(1 if p > 0.5 + 1e-9 else 0.5 if abs(p - 0.5) <= 1e-9 else 0 for p in rp) / len(rp)
        print('| %s | %d | %s | %.1f%%／%s |' % (name, len(q), ' | '.join(cells), acc, brier(rp)))


if __name__ == '__main__':
    main()
