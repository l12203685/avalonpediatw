#!/usr/bin/env python3
"""第 78 回合：紅方任務牌的彙總（`redCardStudy78.ts` 的輸出 → 表）。

  python3 -I scripts/redCardStudy78.py ROWS.jsonl [ROWS2.jsonl …] --games GAMES.json [--adv QUESTADV.jsonl] --part PART

  ROWS      `redCardStudy78.ts --out` 的檔（可以很多個；後面的檔同一點的欄位蓋掉前面的，候選分幾次跑時用）
  --games   `roleSpots.ts games --out DIR` 的 DIR/games.json（每個座位的玩家編號，沒有名字；選各角色的強者用，同 roleBreakdown.py 的選法）
  --adv     `humanPrBenchmark.ts --roles none --quest-adv` 的檔（人類 PR 量尺的任務牌優勢表：每一張能確定的牌出失敗／出成功各值多少）
  --part    r4      第 4 局、比分 1:2、自己是隊上唯一看得到的紅（線索表第 2 項）：照隊上實際的紅拆開
            view    每個角色 × 局 × 比分 × 有沒有認得的隊友同隊：真人（強者／全部）、真人桌策略層、基準線出失敗的比例
            teams   同一支隊上有兩個以上紅方：整隊出了幾張失敗（真人、機器人兩個座位都換成機器人）、真人各張數的紅方勝率
            pairs   兩個相認紅同隊（一張就夠的任務）：照兩個人的角色、照公開紀錄（出過／藏過／沒有）
            pr      人類 PR 量尺拆到任務牌的格子（只有能確定的牌）
            cand    候選：整隊失敗張數的分布離真人多遠、照真人同張數的勝率換算、人類 PR 量尺（分強度層、偶數／奇數局）
            seat    候選：兩個相認紅同隊時，一個座位換成機器人、隊友照真人（隊友照角色／照公開紀錄兩種算法）
            detail:候選   人類 PR 量尺分角色 × 強度層 × 兩半
            pairs:H,HP6h,…   pairs 的表多列幾欄候選

輸出只有彙總（沒有名字、沒有局號）。
"""
import json
import math
import statistics
import sys
from collections import Counter, defaultdict

argv = sys.argv[1:]
files, opt = [], {}
i = 0
while i < len(argv):
    if argv[i] in ('--games', '--adv', '--part'):
        opt[argv[i][2:]] = argv[i + 1]
        i += 2
    else:
        files.append(argv[i])
        i += 1
if not files or 'part' not in opt:
    sys.exit(__doc__)
PART = opt['part']

ROLE_ZH = {'assassin': '刺客', 'morgana': '莫甘娜', 'mordred': '莫德雷德', 'oberon': '奧伯倫'}
LETTER_ZH = {'A': '刺客', 'M': '莫甘娜', 'D': '莫德雷德', 'O': '奧伯倫'}
TIER_ZH = {'weakHuman': '弱桌', 'avgHuman': '一般桌', 'strongHuman': '強桌', 'unknown': 'S 不明'}
RED = set(ROLE_ZH)

# ── 讀檔 ────────────────────────────────────────────────
rows, seats = {}, {}
for f in files:
    for line in open(f, encoding='utf8'):
        r = json.loads(line)
        if r.get('k') == 'seat':
            seats[(r['gi'], r['seat'])] = r
        else:
            key = (r['gi'], r['seat'], r['round'])
            if key in rows:
                rows[key].update(r)
            else:
                rows[key] = r
ROWS = list(rows.values())
SEATS = list(seats.values())
for r in ROWS:
    r['share'] = r['fails'] / r['reds']
    r['score'] = f"{r['bw']}:{r['rw']}"
    r['half'] = r['ti'] % 2

ADV = {}
if opt.get('adv'):
    for line in open(opt['adv'], encoding='utf8'):
        a = json.loads(line)
        ADV[(a['gi'], a['seat'], a['round'])] = a


def strong_pick(path):
    """各角色的強者（同 roleBreakdown.py：角色 ≥ 30 局、角色勝率往平均拉 30 局、整體勝率在常客中位數以上，取前 7）。回傳 role → {玩家編號}。"""
    games = json.load(open(path, encoding='utf8'))['games']
    tot, rg, rw, sg, sw = Counter(), Counter(), Counter(), Counter(), Counter()
    for g in games:
        for k, p in enumerate(g['players']):
            role = g['roles'][k]
            red = role in RED
            w = 1 if ((g['outcome'] != '三藍活') if red else (g['outcome'] == '三藍活')) else 0
            rg[('*', role)] += 1
            rw[('*', role)] += w
            if p < 0:
                continue
            tot[p] += 1
            rg[(p, role)] += 1
            rw[(p, role)] += w
            sg[(p, red)] += 1
            sw[(p, red)] += w

    def std(p):
        if not sg[(p, False)] or not sg[(p, True)]:
            return None
        return 100 * (0.6 * sw[(p, False)] / sg[(p, False)] + 0.4 * sw[(p, True)] / sg[(p, True)])

    regulars = [p for p in tot if tot[p] >= 100 and std(p) is not None]
    median = statistics.median(std(p) for p in regulars)
    sel = {}
    for role in RED:
        mean = 100 * rw[('*', role)] / rg[('*', role)]
        cand = []
        for p in tot:
            n = rg[(p, role)]
            if n < 30:
                continue
            shr = 100 * (rw[(p, role)] + 30 * mean / 100) / (n + 30)
            if std(p) is not None and std(p) >= median and shr > mean:
                cand.append((-shr, p))
        cand.sort()
        sel[role] = {p for _, p in cand[:7]}
    pid = {g['id']: g['players'] for g in games}
    return sel, pid


SEL, PID = strong_pick(opt['games']) if opt.get('games') else ({}, {})
for r in ROWS:
    p = PID.get(r['gid'], [None] * 10)[r['seat'] - 1] if PID else None
    r['strong'] = bool(SEL) and p is not None and p in SEL.get(r['role'], ())

MIS = defaultdict(list)
for r in ROWS:
    MIS[(r['gi'], r['round'])].append(r)


def pct(k, n, d=0):
    return '—' if not n else f'{100 * k / n:.{d}f}%'


def fshare(xs, col=None):
    """出失敗的比例：真人照「失敗張數 ÷ 隊上紅方人數」；機器人照那一欄。"""
    if not xs:
        return '—'
    v = sum((x['share'] if col is None else (x[col] == 'F')) for x in xs) / len(xs)
    return f'{100 * v:.0f}%'


def dist(vals, mx):
    c = Counter(vals)
    n = len(vals)
    return '／'.join(f'{100 * c[k] / n:.0f}' for k in range(mx + 1)) + '%' if n else '—'


def wins_by(ms, mx, minn=1):
    out = []
    for k in range(mx + 1):
        w = [m[0]['redWon'] for m in ms if m[0]['fails'] == k]
        out.append(f'{100 * sum(w) / len(w):.0f}%（{len(w)}）' if len(w) >= minn else '—')
    return '／'.join(out)


def table(head, body):
    print('| ' + ' | '.join(head) + ' |')
    print('|' + '---|' * len(head))
    for b in body:
        print('| ' + ' | '.join(str(x) for x in b) + ' |')
    print()


def comp(m):
    rec = sum(1 for r in m if r['role'] != 'oberon')
    return f'{rec} 個相認紅' + ('＋奧伯倫' if rec < len(m) else '') if rec else '奧伯倫'


def bot_count(m, col):
    return sum(r[col] == 'F' for r in m)


def cluster_se(per_game):
    """per_game: {gi: (Σd, n)} → (平均, 標準誤；以局為集群的比例估計)。"""
    g = list(per_game.values())
    n = sum(x[1] for x in g)
    if not n or len(g) < 2:
        return 0.0, 0.0, n
    m = sum(x[0] for x in g) / n
    var = sum((x[0] - m * x[1]) ** 2 for x in g) * len(g) / (len(g) - 1) / n ** 2
    return m, math.sqrt(var), n


# ── r4：第 4 局 1:2、自己是隊上唯一看得到的紅 ──────────────────────
def part_r4():
    cell = [r for r in ROWS if r['round'] == 4 and r['rw'] == 2 and r['knownOn'] == 0]
    for name, sel in (('奧伯倫', lambda r: r['role'] == 'oberon'), ('相認紅（刺客／莫甘娜／莫德雷德），隊上沒有認得的隊友', lambda r: r['role'] != 'oberon')):
        xs = [r for r in cell if sel(r)]
        print(f'**{name}**（{len(xs)} 張牌；強者 {sum(r["strong"] for r in xs)} 張）\n')
        body = []
        groups = [('全部', xs)] + [(f'隊上實際 {k} 個紅' + ('（只有自己）' if k == 1 else '（自己＋一個互相看不到的紅）' if k == 2 else '（其他紅彼此認得，兩張一定出）'), [r for r in xs if r['reds'] == k]) for k in sorted({r['reds'] for r in xs})]
        for label, g in groups:
            st = [r for r in g if r['strong']]
            pin = [r for r in g if r['human'] is not None]
            f = [r for r in pin if r['human'] == 'F']
            s = [r for r in pin if r['human'] == 'S']
            adv = [ADV[(r['gi'], r['seat'], r['round'])] for r in pin if (r['gi'], r['seat'], r['round']) in ADV]
            fs = f'{100 * sum(a["F"] - a["S"] for a in adv) / len(adv):+.1f}' if adv else '—'
            body.append([label, len(g), f'{fshare(st)}（{len(st)}）', fshare(g), fshare(g, 'H'), fshare(g, 'A'),
                         f'{pct(sum(r["redWon"] for r in f), len(f))}（{len(f)}）', f'{pct(sum(r["redWon"] for r in s), len(s))}（{len(s)}）', fs])
        table(['', '牌數', '強者出失敗（牌數）', '全部真人', '真人桌策略層', '基準線', '真人確定出失敗：紅方勝率（牌數）', '真人確定出成功：紅方勝率（牌數）', '量尺：出失敗 − 出成功（pp／張）'], body)
    # 隊上只有一個紅／兩個互相看不到的紅：照失敗張數
    ms = [m for m in MIS.values() if m[0]['round'] == 4 and m[0]['rw'] == 2]
    lone = [m for m in ms if len(m) == 1]
    pair = [m for m in ms if len(m) == 2 and any(r['role'] == 'oberon' for r in m)]
    print('第 4 局（1:2）的任務，照隊上實際的紅與失敗張數（全部真人）：\n')
    table(['隊上的紅', '任務數', '0／1／2 張失敗', '各張數的紅方勝率（任務數）'], [
        ['只有一個紅（任何角色）', len(lone), dist([m[0]['fails'] for m in lone], 1), wins_by(lone, 1)],
        ['奧伯倫＋一個相認紅（互相看不到）', len(pair), dist([m[0]['fails'] for m in pair], 2), wins_by(pair, 2)],
    ])
    # 門檻：自己的後驗 P(隊上的紅夠讓任務失敗)
    print('照機器人自己的後驗 P(隊上還有自己看不到的紅) 分格（真人桌策略層的讀法）：\n')
    body = []
    for lo, hi in ((0, 0.1), (0.1, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 0.9), (0.9, 1.01)):
        for name, sel in (('奧伯倫', lambda r: r['role'] == 'oberon'), ('相認紅', lambda r: r['role'] != 'oberon')):
            g = [r for r in cell if sel(r) and r['H_pMore'] is not None and lo <= r['H_pMore'] < hi]
            if not g:
                continue
            body.append([f'{lo:.1f}–{min(hi, 1):.1f}', name, len(g), pct(sum(r['reds'] >= 2 for r in g), len(g)), pct(sum(r['reds'] == 2 for r in g), len(g)), fshare(g), pct(sum(r['redWon'] for r in g), len(g))])
    table(['P', '誰', '牌數', '隊上真的還有別的紅', '其中剛好兩個紅（自己的牌有用）', '真人出失敗', '紅方勝率'], body)


# ── view：每個角色自己看到的格子 ─────────────────────────────────
def part_view():
    body = []
    cells = defaultdict(list)
    for r in ROWS:
        mate = '有認得的隊友同隊' if r['knownOn'] > 0 else '沒有'
        cells[(r['role'], r['round'], r['score'], mate)].append(r)
    nseat = Counter(s['role'] for s in SEATS)
    for key in sorted(cells, key=lambda k: (list(ROLE_ZH).index(k[0]), k[1], k[2], k[3])):
        g = cells[key]
        if len(g) < 20:
            continue
        st = [r for r in g if r['strong']]
        hs = sum(r['share'] for r in g) / len(g)
        hb = sum(r['H'] == 'F' for r in g) / len(g)
        body.append([ROLE_ZH[key[0]], f'第{key[1]}局（{key[2]}）', key[3], len(g), f'{fshare(st)}（{len(st)}）', fshare(g), fshare(g, 'H'), fshare(g, 'A'),
                     f'{100 * (hs - hb):+.0f}', f'{100 * len(g) / nseat[key[0]]:.0f}'])
    table(['角色', '局（藍：紅）', '隊上', '牌數', '強者出失敗（牌數）', '全部真人', '真人桌策略層', '基準線', '全部真人 − 真人桌策略層（pp）', '每 100 局這個角色幾張'], body)


# ── teams：整隊出了幾張 ───────────────────────────────────────
def part_teams():
    groups = defaultdict(list)
    for m in MIS.values():
        if len(m) >= 2:
            groups[(m[0]['round'], m[0]['score'], len(m), comp(m))].append(m)
    body = []
    for key in sorted(groups):
        ms = groups[key]
        if len(ms) < 15:
            continue
        mx = key[2]
        body.append([f'第{key[0]}局（{key[1]}）', key[3], len(ms), dist([m[0]['fails'] for m in ms], mx), dist([bot_count(m, 'H') for m in ms], mx), dist([bot_count(m, 'A') for m in ms], mx), wins_by(ms, mx, 5)])
    table(['局（藍：紅）', '隊上的紅', '任務數', '真人：0／1／2…張失敗', '真人桌策略層', '基準線', '真人各張數的紅方勝率（任務數）'], body)


# ── pairs：兩個相認紅同隊 ─────────────────────────────────────
def pair_missions():
    return [m for m in MIS.values() if len(m) == 2 and all(r['role'] != 'oberon' for r in m) and m[0]['round'] <= 3 and m[0]['bw'] < 2 and m[0]['rw'] < 2]


ST_ZH = {'FN': '一個出過、一個沒有紀錄', 'FH': '一個出過、一個藏過', 'HN': '一個藏過、一個沒有紀錄', 'NN': '兩個都沒有紀錄', 'HH': '兩個都藏過', 'FF': '兩個都出過'}


def part_pairs(cols=('H', 'A')):
    ms = pair_missions()
    by_role = defaultdict(list)
    by_st = defaultdict(list)
    for m in ms:
        by_role[(m[0]['round'], ''.join(sorted(r['role'][0].upper() if r['role'] != 'mordred' else 'D' for r in m)))].append(m)
        if m[0]['round'] >= 2:
            by_st[(m[0]['round'], ''.join(sorted(m[0]['pairSt'])))].append(m)
    print('照兩個人的角色：\n')
    body = []
    for key in sorted(by_role):
        g = by_role[key]
        st = [m for m in g if any(r['strong'] for r in m)]
        body.append([f'第{key[0]}局', '＋'.join(LETTER_ZH[c] for c in key[1]), len(g), dist([m[0]['fails'] for m in g], 2), f'{dist([m[0]["fails"] for m in st], 2)}（{len(st)}）']
                    + [dist([bot_count(m, c) for m in g], 2) for c in cols] + [wins_by(g, 2, 4)])
    table(['局', '隊上的兩個相認紅', '任務數', '真人：0／1／2 張失敗', '其中有強者在內（任務數）'] + [COL_ZH.get(c, c) for c in cols] + ['真人各張數的紅方勝率（任務數）'], body)
    print('照兩個人的公開紀錄（之前單獨上過的任務有沒有失敗牌；第 2、3 局）：\n')
    body = []
    for key in sorted(by_st):
        g = by_st[key]
        body.append([f'第{key[0]}局', ST_ZH.get(key[1], key[1]), len(g), dist([m[0]['fails'] for m in g], 2)] + [dist([bot_count(m, c) for m in g], 2) for c in cols] + [wins_by(g, 2, 4)])
    table(['局', '兩個人的紀錄', '任務數', '真人：0／1／2 張失敗'] + [COL_ZH.get(c, c) for c in cols] + ['真人各張數的紅方勝率（任務數）'], body)


COL_ZH = {'H': '真人桌策略層', 'A': '基準線'}


# ── pr：量尺拆到任務牌的格子 ──────────────────────────────────
def part_pr():
    cells = defaultdict(list)
    for r in ROWS:
        a = ADV.get((r['gi'], r['seat'], r['round']))
        if a is None:
            continue
        who = '奧伯倫' if r['role'] == 'oberon' else '相認紅'
        on = '只有自己一個紅' if r['reds'] == 1 else ('兩個相認紅' if r['reds'] == 2 and r['knownOn'] == 1 else '自己＋一個互相看不到的紅' if r['reds'] == 2 else f'{r["reds"]} 個紅')
        cells[(who, r['round'], r['score'], on)].append((r, a))
    nred = len(SEATS)
    body = []
    for key in sorted(cells):
        g = cells[key]
        if len(g) < 30:
            continue
        per = defaultdict(lambda: [0.0, 0])
        for r, a in g:
            per[r['gi']][0] += a[r['H']] - a[r['human']]
            per[r['gi']][1] += 1
        m, se, n = cluster_se(per)
        tot = 100 * sum(a[r['H']] - a[r['human']] for r, a in g) / nred
        body.append([key[0], f'第{key[1]}局（{key[2]}）', key[3], len(g), pct(sum(r['human'] == 'F' for r, _ in g), len(g)), pct(sum(r['H'] == 'F' for r, _ in g), len(g)),
                     f'{100 * sum(a["F"] - a["S"] for _, a in g) / len(g):+.1f}', f'{100 * m:+.2f} ± {100 * se:.2f}', f'{tot:+.3f}'])
    table(['誰', '局（藍：紅）', '隊上實際的紅', '能確定的牌', '真人出失敗', '真人桌策略層出失敗', '裁判：出失敗 − 出成功（pp／張）', '機器人 − 真人（pp／張 ± 標準誤）', '合計（pp／紅方座位局）'], body)
    allp = [(r, ADV[(r['gi'], r['seat'], r['round'])]) for r in ROWS if (r['gi'], r['seat'], r['round']) in ADV]
    print(f'紅方座位局 {nred}；能確定的牌 {len(allp)} 張；合計 機器人 − 真人 = {100 * sum(a[r["H"]] - a[r["human"]] for r, a in allp) / nred:+.3f} pp／紅方座位局（真人桌策略層）、'
          f'{100 * sum(a[r["A"]] - a[r["human"]] for r, a in allp) / nred:+.3f}（基準線）。\n')


# ── cand：候選 ─────────────────────────────────────────────
def cell_of(m):
    return (m[0]['round'], m[0]['score'], len(m), comp(m))


def tv(a, b, mx):
    ca, cb = Counter(a), Counter(b)
    return 0.5 * sum(abs(ca[k] / len(a) - cb[k] / len(b)) for k in range(mx + 1))


def part_cand():
    cands = [c[1:] for c in ROWS[0] if c.startswith('H') and c not in ('H', 'H_why', 'H_p2', 'H_pMore')]
    # (1) 整隊失敗張數的分布離真人多遠（每一次有紅方上的任務；格 = 局 × 比分 × 隊上的紅）
    multi = defaultdict(list)
    for m in MIS.values():
        multi[cell_of(m)].append(m)
    total = sum(len(v) for v in multi.values())

    def distance(col):
        return sum(len(ms) * tv([m[0]['fails'] for m in ms], [bot_count(m, col) for m in ms], ms[0][0]['reds']) for ms in multi.values()) / total

    # (2) 照真人同張數的勝率換算：w(格, 張數) 用另一半的局估（偶數局的表給奇數局用、反過來也是），張數沒出現過的格退到全部
    def wtab(half):
        t = defaultdict(lambda: [0, 0])
        for m in MIS.values():
            if m[0]['half'] != half:
                k = (cell_of(m), m[0]['fails'])
                t[k][0] += m[0]['redWon']
                t[k][1] += 1
        return t

    W = {0: wtab(0), 1: wtab(1)}

    def ev(col, sel=lambda m: True):
        per = defaultdict(lambda: [0.0, 0])
        for m in MIS.values():
            if not sel(m):
                continue
            t = W[m[0]['half']]
            c = cell_of(m)
            kb, kh = bot_count(m, col), bot_count(m, 'H')
            if kb == kh:
                per[m[0]['gi']][1] += 0
                continue
            wb, wh = t.get((c, kb)), t.get((c, kh))
            if not wb or not wh or wb[1] < 3 or wh[1] < 3:
                continue
            per[m[0]['gi']][0] += wb[0] / wb[1] - wh[0] / wh[1]
        games = {s['gi'] for s in SEATS}
        return sum(v[0] for v in per.values()) / len(games), per

    # (3) 人類 PR 量尺（能確定的牌）：Σ（候選那張牌的優勢 − 原本那張牌的優勢）÷ 紅方座位局
    seat_n = Counter()
    for s in SEATS:
        seat_n[('all', 'all')] += 1
        seat_n[(s['tier'], 'all')] += 1
        seat_n[('all', s['ti'] % 2)] += 1
        seat_n[(s['tier'], s['ti'] % 2)] += 1

    def pr(col, base='H'):
        out = {}
        for tier in ('all', 'weakHuman', 'avgHuman', 'strongHuman', 'unknown'):
            for half in ('all', 0, 1):
                per = defaultdict(float)
                for r in ROWS:
                    a = ADV.get((r['gi'], r['seat'], r['round']))
                    if a is None or r[col] == r[base]:
                        continue
                    if (tier != 'all' and r['tier'] != tier) or (half != 'all' and r['half'] != half):
                        continue
                    per[r['gi']] += a[r[col]] - a[r[base]]
                n = seat_n[(tier, half)]
                ngames = n / 4
                tot = sum(per.values())
                # 以局為集群：沒有改到的局差 = 0
                var = (sum(v * v for v in per.values()) - tot * tot / ngames) / max(1.0, ngames - 1) * ngames
                out[(tier, half)] = (100 * tot / n, 100 * math.sqrt(max(var, 0)) / n)
        return out

    print('候選（開關疊在真人桌策略層上；整隊的張數 = 隊上每個紅方座位都換成機器人；每一次有紅方上的任務都算）：\n')
    body = [['現行（真人桌策略層）', '—', f'{distance("H"):.3f}', '—', '—', '—', '—']]
    for c in cands:
        col = 'H' + c
        changed = sum(r[col] != r['H'] for r in ROWS)
        e, _ = ev(col)
        p = pr(col)
        worst = min(((p[(t, h)][0] + 2 * p[(t, h)][1], t, h) for t in ('weakHuman', 'avgHuman', 'strongHuman', 'unknown') for h in (0, 1)), key=lambda x: x[0])
        wt = f'{TIER_ZH[worst[1]]}{"偶" if worst[2] == 0 else "奇"}數局 {p[(worst[1], worst[2])][0]:+.3f} ± {p[(worst[1], worst[2])][1]:.3f}'
        body.append([c, changed, f'{distance(col):.3f}', f'{100 * e:+.3f}',
                     f'{p[("all", "all")][0]:+.3f} ± {p[("all", "all")][1]:.3f}', f'{p[("all", 0)][0]:+.3f}／{p[("all", 1)][0]:+.3f}', wt])
    table(['候選', '改到的牌', '張數分布離真人（0 = 一樣）', '照真人同張數的勝率換算（紅方勝率 pp／局）', '人類 PR 量尺（pp／紅方座位局 ± 標準誤）', '偶數局／奇數局', '最差的一層 × 一半'], body)
    print('候選疊在基準線上（同一批真人局；整隊的張數分布離真人多遠、人類 PR 量尺對基準線）：\n')
    body = [['現行（基準線）', '—', f'{distance("A"):.3f}', '—', '—', '—']]
    for c in cands:
        col = 'A' + c
        if col in ROWS[0]:
            p = pr(col, 'A')
            worst = min(((p[(t, h)][0] + 2 * p[(t, h)][1], t, h) for t in ('weakHuman', 'avgHuman', 'strongHuman', 'unknown') for h in (0, 1)), key=lambda x: x[0])
            wt = f'{TIER_ZH[worst[1]]}{"偶" if worst[2] == 0 else "奇"}數局 {p[(worst[1], worst[2])][0]:+.3f} ± {p[(worst[1], worst[2])][1]:.3f}'
            body.append([c, sum(r[col] != r['A'] for r in ROWS), f'{distance(col):.3f}',
                         f'{p[("all", "all")][0]:+.3f} ± {p[("all", "all")][1]:.3f}', f'{p[("all", 0)][0]:+.3f}／{p[("all", 1)][0]:+.3f}', wt])
    table(['候選', '改到的牌', '張數分布離真人', '人類 PR 量尺（pp／紅方座位局 ± 標準誤）', '偶數局／奇數局', '最差的一層 × 一半'], body)


# ── seat：一個座位換成機器人、隊友照真人（兩個相認紅同隊）────────────────────
def part_seat():
    """
    兩個相認紅同隊（第 1～3 局、一張就夠、兩邊都還沒兩勝）的任務，把其中一個座位換成機器人、另一個照真人：
    新的失敗張數 = 機器人那張 ＋ 真人隊友那張，紅方勝率照真人同局、同比分、同張數的勝率 w（另一半的局估）。真人隊友會不會出，兩種算法並列：
      「照角色」＝隊友出失敗的機率只看他的角色與第幾局（從三種組合的平均張數解出刺客／莫甘娜／莫德雷德各自的比例）；
      「照紀錄」＝兩個人的公開紀錄不一樣時，真人照「出者恆出、藏者恆藏」（該出的那一個出的機率 = 那一格至少一張的比例、另一個 = 兩張的比例），紀錄一樣時照角色。
    """
    ms = pair_missions()
    letter = {'assassin': 'A', 'morgana': 'M', 'mordred': 'D'}
    # 照角色：每一局解 a + d = AD 的平均張數 …
    marg = {}
    for rd in (1, 2, 3):
        mean = {}
        for pr in ('AD', 'AM', 'DM'):
            g = [m for m in ms if m[0]['round'] == rd and ''.join(sorted(letter[r['role']] for r in m)) == pr]
            mean[pr] = sum(m[0]['fails'] for m in g) / len(g)
        marg[rd] = {'A': (mean['AD'] + mean['AM'] - mean['DM']) / 2, 'D': (mean['AD'] + mean['DM'] - mean['AM']) / 2, 'M': (mean['AM'] + mean['DM'] - mean['AD']) / 2}
    print('真人照角色出失敗的比例（兩個相認紅同隊；從三種組合的平均張數解出來）：' + '；'.join(f'第{rd}局 刺客 {100 * v["A"]:.0f}%、莫甘娜 {100 * v["M"]:.0f}%、莫德雷德 {100 * v["D"]:.0f}%' for rd, v in marg.items()) + '\n')
    # 照紀錄：格 = (局, 紀錄)；該出的人 = F 對非 F 的 F、H 對 N 的 N
    cellst = defaultdict(list)
    for m in ms:
        cellst[(m[0]['round'], ''.join(sorted(m[0].get('pairSt', 'NN'))))].append(m[0]['fails'])

    def designated(me, mate):
        if me == 'F' and mate != 'F':
            return True
        if mate == 'F' and me != 'F':
            return False
        if me == 'H' and mate == 'N':
            return False
        if mate == 'H' and me == 'N':
            return True
        return None

    def wtab(half):
        t = defaultdict(lambda: [0, 0])
        for m in ms:
            if m[0]['half'] != half:
                k = (m[0]['round'], m[0]['score'], m[0]['fails'])
                t[k][0] += m[0]['redWon']
                t[k][1] += 1
        return t

    W = {0: wtab(0), 1: wtab(1)}
    cands = [c[1:] for c in ROWS[0] if c.startswith('H') and c not in ('H', 'H_why', 'H_p2', 'H_pMore')]
    nseat = len(SEATS)

    def ev(col, model, half=None):
        per = defaultdict(float)
        for m in ms:
            if half is not None and m[0]['half'] != half:
                continue
            t = W[m[0]['half']]
            for r, o in ((m[0], m[1]), (m[1], m[0])):
                if r[col] == r['H']:
                    continue
                q = marg[r['round']][letter[o['role']]]
                if model == 'record' and r['round'] >= 2:
                    st = r.get('pairSt', 'NN')
                    d = designated(st[1], st[0])  # 隊友是不是該出的那一個
                    if d is not None:
                        fs = cellst[(r['round'], ''.join(sorted(st)))]
                        q = sum(1 for k in fs if k >= 1) / len(fs) if d else sum(1 for k in fs if k >= 2) / len(fs)
                q = min(1.0, max(0.0, q))

                def val(card):
                    b = 1 if card == 'F' else 0
                    out = 0.0
                    for other, pr in ((1, q), (0, 1 - q)):
                        w = t.get((r['round'], r['score'], b + other))
                        if not w or w[1] < 3:
                            return None
                        out += pr * w[0] / w[1]
                    return out

                vb, vh = val(r[col]), val(r['H'])
                if vb is not None and vh is not None:
                    per[r['gi']] += vb - vh
        n = nseat if half is None else sum(1 for x in SEATS if x['ti'] % 2 == half)
        ngames = n / 4
        tot = sum(per.values())
        var = (sum(v * v for v in per.values()) - tot * tot / ngames) / max(1.0, ngames - 1) * ngames
        return 100 * tot / n, 100 * math.sqrt(max(var, 0)) / n

    body = []
    for c in cands:
        col = 'H' + c
        if not any(r[col] != r['H'] for m in ms for r in m):
            continue
        a, ase = ev(col, 'role')
        b, bse = ev(col, 'record')
        body.append([c, sum(r[col] != r['H'] for m in ms for r in m), f'{a:+.3f} ± {ase:.3f}', f'{ev(col, "role", 0)[0]:+.3f}／{ev(col, "role", 1)[0]:+.3f}',
                     f'{b:+.3f} ± {bse:.3f}', f'{ev(col, "record", 0)[0]:+.3f}／{ev(col, "record", 1)[0]:+.3f}'])
    table(['候選', '改到的牌（兩個相認紅同隊）', '隊友照角色（pp／紅方座位局 ± 標準誤）', '偶數局／奇數局', '隊友照紀錄', '偶數局／奇數局'], body)


def part_detail(cand):
    """人類 PR 量尺（能確定的牌）分角色 × 強度層 × 兩半。"""
    col = 'H' + cand
    seat_n = Counter()
    for s in SEATS:
        for role in ('all', s['role']):
            for tier in ('all', s['tier']):
                for half in ('all', s['ti'] % 2):
                    seat_n[(role, tier, half)] += 1
    body = []
    for role in ['all'] + list(ROLE_ZH):
        for tier in ('all', 'weakHuman', 'avgHuman', 'strongHuman', 'unknown'):
            cells = []
            for half in ('all', 0, 1):
                per = defaultdict(float)
                for r in ROWS:
                    a = ADV.get((r['gi'], r['seat'], r['round']))
                    if a is None or r[col] == r['H'] or (role != 'all' and r['role'] != role) or (tier != 'all' and r['tier'] != tier) or (half != 'all' and r['half'] != half):
                        continue
                    per[r['gi']] += a[r[col]] - a[r['H']]
                n = seat_n[(role, tier, half)]
                ngames = n / (4 if role == 'all' else 1)
                tot = sum(per.values())
                var = (sum(v * v for v in per.values()) - tot * tot / ngames) / max(1.0, ngames - 1) * ngames
                cells.append(f'{100 * tot / n:+.3f} ± {100 * math.sqrt(max(var, 0)) / n:.3f}' if n else '—')
            if any(c.startswith(('+0.000 ± 0.000', '-0.000 ± 0.000')) for c in cells[:1]):
                continue
            body.append(['紅方合計' if role == 'all' else ROLE_ZH[role], '全部' if tier == 'all' else TIER_ZH[tier]] + cells)
    table(['角色', '強度層', '全部', '偶數局', '奇數局'], body)


if PART == 'r4':
    part_r4()
elif PART == 'view':
    part_view()
elif PART == 'teams':
    part_teams()
elif PART == 'pairs':
    part_pairs()
elif PART.startswith('pairs:'):
    part_pairs(tuple(PART.split(':', 1)[1].split(',')))
elif PART == 'pr':
    part_pr()
elif PART == 'cand':
    part_cand()
elif PART == 'seat':
    part_seat()
elif PART.startswith('detail:'):
    part_detail(PART.split(':', 1)[1])
else:
    sys.exit(__doc__)
