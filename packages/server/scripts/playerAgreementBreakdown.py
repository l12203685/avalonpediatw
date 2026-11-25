#!/usr/bin/env python3
"""指定玩家的忠臣決策點 × 百科AI：分情境的相同／不同（站長 2026-11-25：湖中／任務派隊／黑白球投票）。

讀 `playerAgreement.ts --roles loyal --dump-reasons` 寫的 spots.json（每個決策點＋ spotContext 的局面欄位），
寫 report.md、report.html（同一份、深色、手機可讀）、data.json、leads.md。

  cd packages/server
  npx tsx scripts/playerAgreement.ts --player 甲 --player 乙 --roles loyal --dump-reasons --out /repo 外/full
  python3 -I scripts/playerAgreementBreakdown.py /repo 外/full/spots.json /repo 外/out [--dataset games_cache.json] [--notes DIR]

- 玩家的順序、名字都從 spots.json 讀；本檔沒有任何玩家名字。report.*、data.json 有名字，不可以放進 repo；
  leads.md 是匿名的（只有合計），可以貼進 docs。
- --dataset：資料集（列出「名字裡含有你打的字」的其他玩家與局數，確認沒有對錯人）。
- --code-note TEXT：接在「百科AI 程式版本」後面的說明（例如「= main abc1234 ＋ 工具的改動」）。
- --notes DIR：DIR/method_extra.md 會接在〈做法與限制〉後面（手寫的補充）。
- 事後真相（隊上的紅方、驗到的人是不是紅方）只用來比誰比較準。危險的隊 = 紅方人數夠讓任務失敗（第 4 局要 2 個）。
- 區間：相同% 用 Wilson；「玩家 − 百科AI」用以局為單位的重抽（BOOT 次）。
"""
import html
import json
import math
import os
import random
import sys
import unicodedata
from collections import Counter, defaultdict

argv = sys.argv[1:]
opts = {}
pos = []
i = 0
while i < len(argv):
    if argv[i] in ('--dataset', '--notes', '--code-note'):
        opts[argv[i][2:]] = argv[i + 1]
        i += 2
    else:
        pos.append(argv[i])
        i += 1
if len(pos) != 2:
    sys.exit(__doc__)
SPOTS, OUT = pos
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
if os.path.abspath(OUT) == REPO or os.path.abspath(OUT).startswith(REPO + os.sep):
    sys.exit(f'OUT must be outside the repo ({REPO}): the report has player names')
random.seed(20261125)
BOOT = 2000
NEED = {1: 1, 2: 1, 3: 1, 4: 2, 5: 1}

raw = json.load(open(SPOTS, encoding='utf8'))
meta, infos = raw['meta'], raw['players']
ORDER = [p['canonical'] for p in infos]
NP = len(ORDER)
ALLZH = f'{NP} 人合計'
H = [s for s in raw['spots'] if s['profile'] == 'human']
A = [s for s in raw['spots'] if s['profile'] == 'ai']
key = lambda s: (s['player'], s['gameId'], s['seat'], s['type'], s['round'], s.get('attempt'))
AI = {key(s): s for s in A}
for s in H:
    s['aiMatch'] = AI[key(s)]['match'] if key(s) in AI else None

LAKE = [s for s in H if s['type'] == 'lakeTarget' and 'ctx' in s and s['ctx'].get('agent')]
TEAM = [s for s in H if s['type'] == 'team' and 'ctx' in s]
VOTE = [s for s in H if s['type'] == 'vote' and 'ctx' in s]

c = lambda s: s['ctx']
hap = lambda s: s['human'] == 'approve'
bap = lambda s: s['agent'] == 'approve'
hf = lambda s: s['ctx']['human']
bf = lambda s: s['ctx']['agent']
fr = lambda s: s['ctx']['frame']
sc = lambda s: (s['ctx']['frame']['blueWins'], s['ctx']['frame']['redWins'])
lsc = lambda s: (s['ctx']['blueWins'], s['ctx']['redWins'])
hred = lambda s: s['ctx']['human']['red']
bred = lambda s: s['ctx']['agent']['red']
hclean = lambda s: s['ctx']['human']['reds'] == 0
bclean = lambda s: s['ctx']['agent']['reds'] == 0
ON = [s for s in VOTE if c(s)['onTeam']]
OFF = [s for s in VOTE if not c(s)['onTeam']]


def danger(s):
    """危險的隊：隊上的紅方人數夠讓任務失敗（第 4 局要 2 張失敗）。"""
    return s['ctx']['features']['reds'] >= NEED[s['round']]


hok = lambda s: hap(s) != danger(s)
bok = lambda s: bap(s) != danger(s)


# ── 統計小工具 ────────────────────────────────────────────
def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (100 * max(0, mid - half), 100 * min(1, mid + half))


def rate(xs, f):
    xs = [x for x in xs if f(x) is not None]
    n = len(xs)
    k = sum(1 for x in xs if f(x))
    return {'n': n, 'k': k, 'pct': (100 * k / n if n else None)}


def boot_gap(xs, fp, fb):
    """玩家比例 − 機器人比例（同一批決策點，成對），以局為單位重抽 → 95% 區間。"""
    xs = [x for x in xs if fp(x) is not None and fb(x) is not None]
    if not xs:
        return None
    by = defaultdict(lambda: [0, 0, 0])
    for x in xs:
        g = by[x['gameId']]
        g[0] += 1
        g[1] += 1 if fp(x) else 0
        g[2] += 1 if fb(x) else 0
    games = list(by.values())
    n = sum(g[0] for g in games)
    gap = 100 * (sum(g[1] for g in games) - sum(g[2] for g in games)) / n
    outs = []
    m = len(games)
    for _ in range(BOOT):
        a = b = d = 0
        for _ in range(m):
            g = games[random.randrange(m)]
            a += g[0]
            b += g[1]
            d += g[2]
        if a:
            outs.append(100 * (b - d) / a)
    outs.sort()
    return {'n': n, 'games': m, 'gap': gap, 'lo': outs[int(0.025 * len(outs))], 'hi': outs[int(0.975 * len(outs)) - 1]}


def G(xs, fp, fb):
    g = boot_gap(xs, fp, fb)
    if not g:
        return None
    return {**g, 'p': rate(xs, fp)['pct'], 'b': rate(xs, fb)['pct']}


def seat_zh(x):
    x = int(x)
    return f'{0 if x == 10 else x}家'


def team_zh(t):
    return ''.join('0' if x == '10' else x for x in str(t).split(',') if x)


def pct(v, d=1):
    return '—' if v is None else f'{v:.{d}f}%'


def small(n):
    return '＊' if n < 30 else ''


def ci_txt(g):
    return '—' if not g else f"{g['gap']:+.1f}（{g['lo']:+.1f} ～ {g['hi']:+.1f}）"


class PB:
    """玩家 vs 百科AI 的一對比例（表格的一格）。"""

    def __init__(self, p, b):
        self.p, self.b = p, b

    def md(self):
        if self.p is None and self.b is None:
            return '—'
        return f'{pct(self.p)} ／ {pct(self.b)}'

    def html(self):
        if self.p is None and self.b is None:
            return '—'

        def bar(v, cls):
            if v is None:
                return ''
            return f'<div class="bar {cls}"><i style="width:{max(0, min(100, v)):.0f}%"></i><b>{v:.1f}%</b></div>'
        return bar(self.p, 'p') + bar(self.b, 'b')


class One:
    """單一比例（相同%）。"""

    def __init__(self, v):
        self.v = v

    def md(self):
        return pct(self.v)

    def html(self):
        if self.v is None:
            return '—'
        return f'<div class="bar s"><i style="width:{max(0, min(100, self.v)):.0f}%"></i><b>{self.v:.1f}%</b></div>'


def gap_txt(p, b, more='玩家多', less='百科AI多'):
    if p is None or b is None:
        return '—'
    d = p - b
    if abs(d) < 0.05:
        return '一樣'
    return f'{more if d > 0 else less} {abs(d):.1f}'


# ── 報告積木 ─────────────────────────────────────────────
blocks = []


def h(level, text):
    blocks.append(('h', level, text))


def para(text):
    blocks.append(('p', text))


def ul(items):
    blocks.append(('ul', items))


def table(headers, rows, note=None):
    blocks.append(('t', headers, rows, note))


def rawmd(text):
    blocks.append(('raw', text))


data = {'meta': meta, 'players': {}, 'lake': {}, 'team': {}, 'vote': {}}
CAT_ZH = {'lake': '湖中', 'team': '任務派隊', 'vote': '黑白球投票'}
SAME_WORD = {'lake': '驗同一個人', 'team': '整隊相同', 'vote': '投同一種顏色'}


# ══ 玩家與局數 ══════════════════════════════════════════
def name_candidates():
    """資料集裡名字（或別名）含有輸入字樣的其他玩家：[(輸入, 正式名字, 局數, 經由哪個別名)]。"""
    if 'dataset' not in opts:
        return None
    ds = json.load(open(opts['dataset'], encoding='utf8'))
    names = ds['players']
    i_seats = ds['fields'].index('seats')
    cnt = Counter()
    for g in ds['games']:
        for k in g[i_seats]:
            if k >= 0:
                cnt[k] += 1
    games = {names[k]: v for k, v in cnt.items()}
    norm = lambda t: unicodedata.normalize('NFKC', t).lower()
    out = []
    for p in infos:
        q = norm(p['query'])
        for n in names:
            if n != p['canonical'] and q in norm(n) and games.get(n):
                out.append((p['query'], n, games[n], None))
        for frm, to in (ds.get('aliases') or {}).items():
            if to != p['canonical'] and q in norm(frm) and q not in norm(to):
                out.append((p['query'], to, games.get(to, 0), frm))
    return out


def players_block():
    rows = []
    for p in infos:
        name, g = p['canonical'], p['games']
        spell = '、'.join(dict.fromkeys(list(p.get('spellingsSeen', [])) + list(p.get('aliasEntries', [])))) or name
        ex = sum(g['excluded'].values())
        un = sum(g['unreplayable'].values()) + g['botGame']
        t = g['tiers']
        n_l = sum(1 for s in LAKE if s['player'] == name)
        n_t = sum(1 for s in TEAM if s['player'] == name)
        n_v = sum(1 for s in VOTE if s['player'] == name)
        rows.append([p['query'], name, spell, g['inDataset'], g.get('otherRole', 0), ex, un, g['replayed'],
                     f"{t.get('weakHuman', 0)}／{t.get('avgHuman', 0)}／{t.get('strongHuman', 0)}", n_l, n_t, n_v])
        data['players'][name] = {'query': p['query'], 'canonical': name, 'spellings': spell, 'gamesInDataset': g['inDataset'], 'otherRoleGames': g.get('otherRole', 0),
                                 'excluded': g['excluded'], 'unreplayable': g['unreplayable'], 'botGames': g['botGame'], 'loyalGamesCompared': g['replayed'], 'tiers': t,
                                 'lakeSpots': n_l, 'teamSpots': n_t, 'voteSpots': n_v}
    rows.append([ALLZH, '', '', '', '', '', '', f"{len({(x['gameId'], x['seat']) for x in H})} 個座位（{len({x['gameId'] for x in H})} 局不重複）", '', len(LAKE), len(TEAM), len(VOTE)])
    table(['你寫的', '網站上的正式名字', '併進來的寫法', '網站戰績的局', '拿其他角色', '排除（錯誤／重複局）', '牌譜無法嚴格重播', '忠臣局（比對）', '桌層 弱／一般／強', '湖中', '派隊', '投票'], rows)
    para('名字的對法和網站個人頁一樣（完全相同 → 只差大小寫／全半形 → 別名表）。每個寫法都直接對到同名的正式玩家。')
    cands = name_candidates()
    if cands is not None:
        data['nameCandidates'] = [{'query': q, 'other': n, 'games': g, 'viaAlias': via} for q, n, g, via in cands]
        if cands:
            items = []
            for q, n, g, via in cands:
                if via:
                    items.append(f'「{q}」：別名表把寫法「{via}」併給另一位玩家「{n}」（{g} 局），所以那些局**沒有**算進 {q}。如果那其實是 {q} 本人，要改別名表再重跑。')
                else:
                    items.append(f'「{q}」：名字裡也有這個字的「{n}」（{g} 局）是另一位玩家，沒有併。')
            para('**容易混淆、但沒有併進來的名字**：')
            ul(items)
        else:
            para('資料集裡沒有其他名字含有這些字樣的玩家。')


# ══ 一、湖中 ════════════════════════════════════════════
def chance(xs):
    return 100 * sum(1 / len(s['ctx']['valid']) for s in xs) / len(xs) if xs else None


def rnd_red(xs):
    return 100 * sum(s['ctx']['validReds'] / len(s['ctx']['valid']) for s in xs) / len(xs) if xs else None


def lake_section():
    L = LAKE
    rows = []
    tot = {}
    for name in ORDER + [ALLZH]:
        xs = L if name == ALLZH else [s for s in L if s['player'] == name]
        r = rate(xs, lambda s: s['match'])
        ra = rate(xs, lambda s: s['aiMatch'])
        lo, hi = wilson(r['k'], r['n'])
        p, b = rate(xs, hred), rate(xs, bred)
        tot[name] = {'n': r['n'], 'same': r['pct'], 'sameCI': [lo, hi], 'sameAiBaseline': ra['pct'], 'chanceSame': chance(xs), 'playerRedHit': p['pct'], 'botRedHit': b['pct'], 'randomRedHit': rnd_red(xs)}
        rows.append([name, f"{r['n']}{small(r['n'])}", One(r['pct']), f'{pct(lo)}–{pct(hi)}' if r['n'] else '—', pct(ra['pct']), pct(chance(xs)), PB(p['pct'], b['pct']), pct(rnd_red(xs))])
    g = boot_gap(L, hred, bred)
    tot['gapRedHit'] = g
    data['lake']['totals'] = tot
    h(3, '總表：驗同一個人的比例')
    table(['玩家', '次數', '相同%', '95% 區間', '（基準線層相同%）', '亂驗會相同%', '驗到紅方%：玩家 ／ 百科AI', '亂驗會驗到紅%'], rows,
          '相同 = 驗同一個座位。＊ = 不到 30 次，只能看方向。「亂驗」= 在當時可以驗的人裡隨便挑一個。')
    if g:
        para(f"**誰比較會驗到紅方**（{ALLZH} {g['n']} 次）：玩家 − 百科AI = {g['gap']:+.1f} 個百分點，95% 區間 {g['lo']:+.1f} ～ {g['hi']:+.1f}（以局為單位重抽 {BOOT} 次）。")

    h(3, '分情境：第幾次湖、當時比數')
    rows, out = [], []
    for rd in (2, 3, 4):
        xs = [s for s in L if s['ctx']['afterRound'] == rd]
        groups = [(f'第 {rd} 局任務之後（第 {rd - 1} 次湖）', xs)]
        for score in sorted({lsc(s) for s in xs}, reverse=True):
            groups.append((f'　比數 藍 {score[0]}：紅 {score[1]}', [s for s in xs if lsc(s) == score]))
        for label, ys in groups:
            if not ys:
                continue
            r = rate(ys, lambda s: s['match'])
            p, b = rate(ys, hred), rate(ys, bred)
            rows.append([label, f"{r['n']}{small(r['n'])}", One(r['pct']), pct(chance(ys)), PB(p['pct'], b['pct']), pct(rnd_red(ys)), gap_txt(p['pct'], b['pct'], '玩家較常驗到紅', '百科AI較常驗到紅')])
            out.append({'label': label.strip(), 'n': r['n'], 'same': r['pct'], 'playerRedHit': p['pct'], 'botRedHit': b['pct'], 'randomRedHit': rnd_red(ys)})
    data['lake']['byLakeAndScore'] = out
    table(['情境', '次數', '相同%', '亂驗會相同%', '驗到紅方%：玩家 ／ 百科AI', '亂驗會驗到紅%', '差在哪'], rows)

    h(3, '分情境：驗的是哪一種人')
    kinds = [
        ('出過失敗任務的人', lambda f: f['missions'] == 'failed', 'failed'),
        ('只出過成功任務的人', lambda f: f['missions'] == 'successOnly', 'successOnly'),
        ('還沒出過任務的人', lambda f: f['missions'] == 'none', 'none'),
        ('當過失敗任務隊長的人', lambda f: f['ledFailedMission'], None),
        ('自己當隊長時派過的人', lambda f: f['onHolderProposals'], None),
        ('自己沒派過的人', lambda f: not f['onHolderProposals'], None),
        ('隔壁（上一家或下一家）', lambda f: f['ring'] == 1, None),
        ('隔 2 家', lambda f: f['ring'] == 2, None),
        ('隔 3 家', lambda f: f['ring'] == 3, None),
        ('隔 4 家', lambda f: f['ring'] == 4, None),
        ('正對面（隔 5 家）', lambda f: f['ring'] == 5, None),
        ('下一家（順位第 1）', lambda f: f['clockwise'] == 1, None),
        ('上一家（順位第 9）', lambda f: f['clockwise'] == 9, None),
    ]
    rows, out = [], []
    n_all = len(L)
    for label, f, mk in kinds:
        hp = [s for s in L if f(s['ctx']['human'])]
        bp = [s for s in L if f(s['ctx']['agent'])]
        avail = None
        if mk and L and all('validMissions' in s['ctx'] for s in L):
            avail = 100 * sum(s['ctx']['validMissions'][mk] / len(s['ctx']['valid']) for s in L) / n_all
        same = rate(hp, lambda s: s['match'])
        pr, br = rate(hp, hred), rate(bp, bred)
        ps = 100 * len(hp) / n_all if n_all else None
        bs = 100 * len(bp) / n_all if n_all else None
        rows.append([label, pct(avail), PB(ps, bs), gap_txt(ps, bs, '玩家較常選', '百科AI較常選'), f"{same['n']}{small(same['n'])}", One(same['pct']), PB(pr['pct'], br['pct'])])
        out.append({'kind': label, 'availablePct': avail, 'playerPicksPct': ps, 'botPicksPct': bs, 'nPlayerPicks': len(hp), 'nBotPicks': len(bp), 'sameWhenPlayerPicks': same['pct'],
                    'redWhenPlayerPicks': pr['pct'], 'redWhenBotPicks': br['pct']})
    data['lake']['byTargetKind'] = out
    table(['對象', '可驗的人裡佔%', f'選這種人%：玩家 ／ 百科AI（{n_all} 次）', '差在哪', '玩家選這種的次數', '這時候相同%', '選這種時驗到紅%：玩家 ／ 百科AI'], rows,
          '「可驗的人裡佔%」= 亂驗會選到這一種的機率。規則上不能驗持過湖或被驗過的人，所以「驗之前的持湖者／被驗過的人」這一類不存在。')


# ══ 二、任務派隊 ══════════════════════════════════════════
def jac(xs):
    return sum(s['jaccard'] for s in xs) / len(xs) if xs else None


def team_section():
    T = TEAM
    rows = []
    tot = {}
    for name in ORDER + [ALLZH]:
        xs = T if name == ALLZH else [s for s in T if s['player'] == name]
        r = rate(xs, lambda s: s['match'])
        ra = rate(xs, lambda s: s['aiMatch'])
        lo, hi = wilson(r['k'], r['n'])
        p, b = rate(xs, hclean), rate(xs, bclean)
        dif = sum(s['ctx']['seatsDiffer'] for s in xs) / len(xs) if xs else None
        one = rate(xs, lambda s: s['ctx']['seatsDiffer'] <= 1)
        tot[name] = {'n': r['n'], 'same': r['pct'], 'sameCI': [lo, hi], 'jaccard': jac(xs), 'sameAiBaseline': ra['pct'], 'avgSeatsDiffer': dif, 'within1Seat': one['pct'], 'playerClean': p['pct'], 'botClean': b['pct']}
        rows.append([name, r['n'], One(r['pct']), f'{pct(lo)}–{pct(hi)}', f'{jac(xs):.3f}' if xs else '—', pct(ra['pct']), f'{dif:.2f}' if xs else '—', pct(one['pct']), PB(p['pct'], b['pct'])])
    g = boot_gap(T, hclean, bclean)
    tot['gapClean'] = g
    data['team']['totals'] = tot
    h(3, '總表：派出同一支隊伍的比例')
    table(['玩家', '次數', '整隊相同%', '95% 區間', '重疊度（Jaccard）', '（基準線層相同%）', '平均差幾個人', '差 1 人以內%', '隊上沒有紅方%：玩家 ／ 百科AI'], rows,
          '整隊相同 = 每一個人都一樣。重疊度 = 兩隊共同的人 ÷ 兩隊加起來的人（1 = 完全相同）。')
    if g:
        para(f"**誰派的隊比較乾淨**（{ALLZH} {g['n']} 次）：玩家 − 百科AI = {g['gap']:+.1f} 個百分點，95% 區間 {g['lo']:+.1f} ～ {g['hi']:+.1f}（以局為單位重抽 {BOOT} 次）。")

    def row(label, xs):
        r = rate(xs, lambda s: s['match'])
        ps, bs = rate(xs, lambda s: hf(s)['hasSelf']), rate(xs, lambda s: bf(s)['hasSelf'])
        pc, bc = rate(xs, hclean), rate(xs, bclean)
        dif = sum(s['ctx']['seatsDiffer'] for s in xs) / len(xs) if xs else None
        return ([label, f"{r['n']}{small(r['n'])}", One(r['pct']), f'{jac(xs):.2f}' if xs else '—', f'{dif:.2f}' if xs else '—', PB(ps['pct'], bs['pct']), PB(pc['pct'], bc['pct']),
                 gap_txt(pc['pct'], bc['pct'], '玩家較乾淨', '百科AI較乾淨')],
                {'label': label.strip(), 'n': r['n'], 'same': r['pct'], 'jaccard': jac(xs), 'avgSeatsDiffer': dif, 'playerSelf': ps['pct'], 'botSelf': bs['pct'], 'playerClean': pc['pct'], 'botClean': bc['pct']})

    heads = ['情境', '次數', '整隊相同%', '重疊度', '平均差幾人', '派自己%：玩家 ／ 百科AI', '隊上沒紅%：玩家 ／ 百科AI', '差在哪']
    h(3, '分情境：第幾局 × 第幾次提議')
    rows, out = [], []
    for rd in range(1, 6):
        for at in range(1, 6):
            xs = [s for s in T if s['round'] == rd and s.get('attempt') == at]
            if not xs:
                continue
            r, o = row(f'第 {rd} 局第 {at} 次（{rd}-{at}）' + ('強制局' if at == 5 else ''), xs)
            rows.append(r)
            out.append(o)
    for label, xs in [('所有強制局（第 5 次，不投票）', [s for s in T if fr(s)['forced']]), ('所有要投票的提議（第 1～4 次）', [s for s in T if not fr(s)['forced']])]:
        r, o = row(label, xs)
        rows.append(r)
        out.append(o)
    data['team']['byMissionAttempt'] = out
    table(heads, rows, '隊伍人數：第 1 局 3 人、第 2、3 局 4 人、第 4、5 局 5 人。')

    h(3, '分情境：當時比數')
    rows, out = [], []
    for score in sorted({sc(s) for s in T}, key=lambda x: (x[0] + x[1], -x[0])):
        r, o = row(f'藍 {score[0]}：紅 {score[1]}（第 {score[0] + score[1] + 1} 局）', [s for s in T if sc(s) == score])
        rows.append(r)
        out.append(o)
    data['team']['byScore'] = out
    table(heads, rows)

    h(3, '分情境：隊伍是怎麼組的')

    def seq(team_txt, seat):
        t = {int(x) for x in team_txt.split(',') if x}
        return t == {seat, seat % 10 + 1, (seat + 1) % 10 + 1}
    structs = [
        ('派自己', T, lambda s: hf(s)['hasSelf'], lambda s: bf(s)['hasSelf']),
        ('上一個任務成功 → 原班人馬全部留下（照派）', [s for s in T if fr(s)['lastMissionSucceeded']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']),
        ('上一個任務失敗、但更早有成功的隊 → 那一隊全部留下', [s for s in T if not fr(s)['lastMissionSucceeded'] and fr(s)['lastSuccessTeam']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']),
        ('有人出過失敗任務 → 隊上帶了這種人（自己不算）', [s for s in T if [x for x in fr(s)['failedSeats'] if x != s['seat']]], lambda s: hf(s)['failedOthers'] > 0, lambda s: bf(s)['failedOthers'] > 0),
        ('有人被湖中宣告是藍方 → 帶他', [s for s in T if [x for x in fr(s)['lakeGoodSeats'] if x != s['seat']]], lambda s: hf(s)['lakeGoodOthers'] > 0, lambda s: bf(s)['lakeGoodOthers'] > 0),
        ('有人被湖中宣告是紅方 → 帶他', [s for s in T if [x for x in fr(s)['lakeEvilSeats'] if x != s['seat']]], lambda s: hf(s)['lakeEvilOthers'] > 0, lambda s: bf(s)['lakeEvilOthers'] > 0),
        ('帶上一位隊長', [s for s in T if hf(s)['hasPrevLeader'] is not None], lambda s: hf(s)['hasPrevLeader'], lambda s: bf(s)['hasPrevLeader']),
        ('同一局上一隊被否決 → 原隊再派一次（最多換 1 人）', [s for s in T if fr(s)['prevSameRound']], lambda s: hf(s)['overlapPrev'] >= fr(s)['size'] - 1, lambda s: bf(s)['overlapPrev'] >= fr(s)['size'] - 1),
        ('同一局上一隊被否決 → 換掉 2 人以上', [s for s in T if fr(s)['prevSameRound']], lambda s: hf(s)['overlapPrev'] <= fr(s)['size'] - 2, lambda s: bf(s)['overlapPrev'] <= fr(s)['size'] - 2),
        ('第 1 局：派自己＋下兩家（順位隊）', [s for s in T if s['round'] == 1], lambda s: seq(s['human'], s['seat']), lambda s: seq(s['agent'], s['seat'])),
    ]
    rows, out = [], []
    for label, xs, fp, fb in structs:
        p, b = rate(xs, fp), rate(xs, fb)
        same = rate(xs, lambda s: s['match'])
        if not p['n']:
            continue
        rows.append([label, f"{p['n']}{small(p['n'])}", PB(p['pct'], b['pct']), gap_txt(p['pct'], b['pct'], '玩家較常', '百科AI較常'), One(same['pct'])])
        out.append({'label': label, 'n': p['n'], 'player': p['pct'], 'bot': b['pct'], 'sameInGroup': same['pct']})
    data['team']['structure'] = out
    table(['怎麼組', '遇到的次數', '這樣派%：玩家 ／ 百科AI', '差在哪', '這些局面整隊相同%'], rows)

    h(3, '和百科AI的隊伍差幾個人')
    cnt = Counter(min(3, s['ctx']['seatsDiffer']) for s in T)
    n = len(T)
    rows = [[lab, cnt.get(k, 0), One(100 * cnt.get(k, 0) / n if n else None)] for k, lab in [(0, '完全相同'), (1, '差 1 人'), (2, '差 2 人'), (3, '差 3 人以上')]]
    data['team']['seatsDiffer'] = {str(k): cnt.get(k, 0) for k in range(4)}
    table(['差幾人', '次數', '佔比'], rows)

    h(3, '隊上沒有紅方的比例（誰派得比較乾淨）')
    rows, out = [], []
    groups = [(f'第 {rd} 局', [s for s in T if s['round'] == rd], hclean, bclean) for rd in range(1, 6)]
    groups.append(('第 4 局（紅方不到 2 個：要 2 張失敗，任務還是會過）', [s for s in T if s['round'] == 4], lambda s: hf(s)['reds'] < 2, lambda s: bf(s)['reds'] < 2))
    groups.append(('第 1 局失敗之後的第 2 局（藍 0：紅 1）', [s for s in T if sc(s) == (0, 1)], hclean, bclean))
    for label, xs, fp, fb in groups:
        g = G(xs, fp, fb)
        if not g:
            continue
        rows.append([label, g['n'], PB(g['p'], g['b']), ci_txt(g)])
        out.append({'label': label, **g})
    data['team']['cleanByRound'] = out
    table(['第幾局', '次數', '隊上沒紅%：玩家 ／ 百科AI', '玩家 − 百科AI（95% 區間）'], rows)


# ══ 三、黑白球投票 ═════════════════════════════════════════
def vote_section():
    V = VOTE
    rows = []
    tot = {}
    for name in ORDER + [ALLZH]:
        xs = V if name == ALLZH else [s for s in V if s['player'] == name]
        on = [s for s in xs if c(s)['onTeam']]
        off = [s for s in xs if not c(s)['onTeam']]
        r = rate(xs, lambda s: s['match'])
        ra = rate(xs, lambda s: s['aiMatch'])
        lo, hi = wilson(r['k'], r['n'])
        p, b = rate(xs, hap), rate(xs, bap)
        ib_p, ib_b = rate(on, lambda s: not hap(s)), rate(on, lambda s: not bap(s))
        ow_p, ow_b = rate(off, hap), rate(off, bap)
        tot[name] = {'n': r['n'], 'same': r['pct'], 'sameCI': [lo, hi], 'sameAiBaseline': ra['pct'], 'playerApprove': p['pct'], 'botApprove': b['pct'],
                     'onTeamN': len(on), 'playerInnerBlack': ib_p['pct'], 'botInnerBlack': ib_b['pct'], 'offTeamN': len(off), 'playerOuterWhite': ow_p['pct'], 'botOuterWhite': ow_b['pct']}
        rows.append([name, r['n'], One(r['pct']), f'{pct(lo)}–{pct(hi)}', pct(ra['pct']), PB(p['pct'], b['pct']), PB(ib_p['pct'], ib_b['pct']), PB(ow_p['pct'], ow_b['pct'])])
    data['vote']['totals'] = tot
    h(3, '總表：投同一種顏色的比例')
    table(['玩家', '票數', '相同%', '95% 區間', '（基準線層相同%）', '投白球（贊成）%：玩家 ／ 百科AI', '內黑率：玩家 ／ 百科AI', '外白率：玩家 ／ 百科AI'], rows,
          '每一張第 1～4 次提議的票都算（強制局不投票）。內黑 = 自己在隊上卻投黑球；外白 = 自己不在隊上卻投白球。只算票數對得上結果的提議。')

    h(3, '誰投得比較準（事後看隊上的紅方）')
    nh = lambda s: not hap(s)
    nb = lambda s: not bap(s)
    acc = [
        ('危險的隊 → 投黑球（擋下來）', [s for s in V if danger(s)], nh, nb),
        ('　其中自己在隊上', [s for s in ON if danger(s)], nh, nb),
        ('　其中自己不在隊上', [s for s in OFF if danger(s)], nh, nb),
        ('安全的隊 → 投白球（放行）', [s for s in V if not danger(s)], hap, bap),
        ('　其中自己在隊上', [s for s in ON if not danger(s)], hap, bap),
        ('　其中自己不在隊上', [s for s in OFF if not danger(s)], hap, bap),
        ('隊長是紅方 → 投黑球', [s for s in V if c(s)['leaderRed']], nh, nb),
        ('隊長是藍方 → 投白球', [s for s in V if not c(s)['leaderRed'] and not c(s)['isLeader']], hap, bap),
        ('整體投對（危險投黑、安全投白）', V, hok, bok),
        ('　第 1、2 局', [s for s in V if s['round'] <= 2], hok, bok),
        ('　第 3 局以後', [s for s in V if s['round'] >= 3], hok, bok),
    ]
    rows, out = [], []
    for label, xs, fp, fb in acc:
        g = G(xs, fp, fb)
        if not g:
            continue
        same = rate(xs, lambda s: s['match'])
        rows.append([label, g['n'], PB(g['p'], g['b']), ci_txt(g), One(same['pct'])])
        out.append({'label': label.strip(), **g, 'same': same['pct']})
    data['vote']['accuracy'] = out
    table(['情境 → 正確的票', '票數', '投對%：玩家 ／ 百科AI', '玩家 − 百科AI（95% 區間）', '相同%'], rows,
          '危險的隊 = 隊上紅方人數夠讓任務失敗（第 4 局要 2 張失敗，所以要 2 個紅方；其他局 1 個）；安全的隊 = 其他。事後真相只用來比誰比較準；投票當下玩家和百科AI都看不到角色。')

    h(3, '誰投得比較準：分第幾局、在不在隊上')
    rows, out = [], []
    for rd in range(1, 6):
        for tag, pool in (('在隊上', ON), ('不在隊上', OFF)):
            xs = [s for s in pool if s['round'] == rd]
            if not xs:
                continue
            red = [s for s in xs if danger(s)]
            cl = [s for s in xs if not danger(s)]
            pr, br = rate(red, nh), rate(red, nb)
            pc, bc = rate(cl, hap), rate(cl, bap)
            g = G(xs, hok, bok)
            rows.append([f'第 {rd} 局・{tag}', len(xs), len(red), PB(pr['pct'], br['pct']), len(cl), PB(pc['pct'], bc['pct']), PB(g['p'], g['b']), ci_txt(g)])
            out.append({'round': rd, 'onTeam': tag == '在隊上', 'n': len(xs), 'dangerN': len(red), 'playerRejectDanger': pr['pct'], 'botRejectDanger': br['pct'], 'safeN': len(cl),
                        'playerApproveSafe': pc['pct'], 'botApproveSafe': bc['pct'], 'correct': g})
    data['vote']['accuracyByRound'] = out
    table(['情境', '票數', '危險的隊', '擋下來（投黑）%：玩家 ／ 百科AI', '安全的隊', '放行（投白）%：玩家 ／ 百科AI', '投對%：玩家 ／ 百科AI', '玩家 − 百科AI（95% 區間）'], rows)

    def row(label, xs):
        r = rate(xs, lambda s: s['match'])
        p, b = rate(xs, hap), rate(xs, bap)
        return ([label, f"{r['n']}{small(r['n'])}", One(r['pct']), PB(p['pct'], b['pct']), gap_txt(p['pct'], b['pct'], '玩家多投白', '百科AI多投白')],
                {'label': label.strip(), 'n': r['n'], 'same': r['pct'], 'playerApprove': p['pct'], 'botApprove': b['pct']})

    heads = ['情境', '票數', '相同%', '投白球%：玩家 ／ 百科AI', '差在哪']
    for title, pool, tag, keyname in [('分情境：自己在隊上 × 第幾局第幾次', ON, '在隊上', 'onTeamByMissionAttempt'), ('分情境：自己不在隊上 × 第幾局第幾次', OFF, '不在隊上', 'offTeamByMissionAttempt')]:
        h(3, title)
        rows, out = [], []
        for rd in range(1, 6):
            xs = [s for s in pool if s['round'] == rd]
            if xs:
                r, o = row(f'第 {rd} 局（全部）', xs)
                rows.append(r)
                out.append(o)
            for at in range(1, 5):
                ys = [s for s in xs if s.get('attempt') == at]
                if ys:
                    r, o = row(f'　{rd}-{at}', ys)
                    rows.append(r)
                    out.append(o)
        data['vote'][keyname] = out
        table(heads, rows, '在隊上投黑球 = 內黑；不在隊上投白球 = 外白。' if tag == '在隊上' else None)

    h(3, '分情境：當時比數')
    rows, out = [], []
    for score in sorted({sc(s) for s in V}, key=lambda x: (x[0] + x[1], -x[0])):
        for tag, pool in [('在隊上', ON), ('不在隊上', OFF)]:
            xs = [s for s in pool if sc(s) == score]
            if xs:
                r, o = row(f'藍 {score[0]}：紅 {score[1]}・{tag}', xs)
                rows.append(r)
                out.append(o)
    data['vote']['byScore'] = out
    table(heads, rows)

    h(3, '分情境：其他')
    others = [
        ('自己是隊長（投自己派的隊）', [s for s in V if c(s)['isLeader']]),
        ('第 4 次提議（再否決就是強制局）・在隊上', [s for s in ON if s.get('attempt') == 4]),
        ('第 4 次提議（再否決就是強制局）・不在隊上', [s for s in OFF if s.get('attempt') == 4]),
        ('隊上有出過失敗任務的人（自己不算）・在隊上', [s for s in ON if c(s)['features']['failedOthers'] > 0]),
        ('隊上有出過失敗任務的人・不在隊上', [s for s in OFF if c(s)['features']['failedOthers'] > 0]),
        ('第 3 局以後、隊上沒有出過失敗任務的人・在隊上', [s for s in ON if s['round'] >= 3 and c(s)['features']['failedOthers'] == 0]),
        ('第 3 局以後、隊上沒有出過失敗任務的人・不在隊上', [s for s in OFF if s['round'] >= 3 and c(s)['features']['failedOthers'] == 0]),
        ('上一個任務成功、原班人馬全部留下的隊・在隊上', [s for s in ON if fr(s)['lastMissionSucceeded'] and c(s)['features']['keepsLastSuccess']]),
        ('上一個任務成功、原班人馬全部留下的隊・不在隊上', [s for s in OFF if fr(s)['lastMissionSucceeded'] and c(s)['features']['keepsLastSuccess']]),
        ('隊上有被湖中宣告是紅方的人（自己不算）', [s for s in V if c(s)['features']['lakeEvilOthers'] > 0]),
        ('自己被湖中宣告是紅方之後（忠臣知道持湖者說謊）', [s for s in V if s['seat'] in fr(s)['lakeEvilSeats']]),
    ]
    rows, out = [], []
    for label, xs in others:
        if xs:
            r, o = row(label, xs)
            rows.append(r)
            out.append(o)
    data['vote']['other'] = out
    table(heads, rows)


# ══ 相同／不同的地方：挑過的情境，數字照算 ══════════════════════
def same_diff_section():
    out = {}

    def agree(label, xs, word, what=None, fp=None, fb=None):
        r = rate(xs, lambda s: s['match'])
        if r['n'] < 30:
            return None
        t = f"{label}：{r['n']} 次裡 {r['pct']:.1f}% {word}"
        d = {'label': label, 'n': r['n'], 'same': r['pct']}
        if what:
            p, b = rate(xs, fp), rate(xs, fb)
            t += f"；{what}的比例，玩家 {p['pct']:.1f}%、百科AI {b['pct']:.1f}%"
            d.update({'what': what, 'player': p['pct'], 'bot': b['pct']})
        d['text'] = t + '。'
        return d

    def share(label, xs, what, fp, fb):
        p, b = rate(xs, fp), rate(xs, fb)
        if p['n'] < 30:
            return None
        gap = p['pct'] - b['pct']
        close = abs(gap) < 5 and min(p['pct'], b['pct']) > 0.5 * max(p['pct'], b['pct'])
        who = '差不多' if close else ('玩家多' if gap > 0 else '百科AI多')
        tail = f"（{who}{'' if close else f' {abs(gap):.1f} 個百分點'}）"
        return {'label': label, 'n': p['n'], 'what': what, 'player': p['pct'], 'bot': b['pct'], 'gap': gap,
                'text': f"{label}（{p['n']} 次）：{what}的比例，玩家 {p['pct']:.1f}%、百科AI {b['pct']:.1f}%{tail}。"}

    L, T, V = LAKE, TEAM, VOTE
    W = SAME_WORD
    hm = lambda k: (lambda s: c(s)['human']['missions'] == k)
    bm = lambda k: (lambda s: c(s)['agent']['missions'] == k)
    rnd = rnd_red(L)
    spec = {
        'lake': {
            'same': [
                agree('玩家驗「只出過成功任務的人」的時候', [s for s in L if hm('successOnly')(s)], W['lake']),
                agree('藍方領先（藍 2：紅 1）時的湖', [s for s in L if lsc(s) == (2, 1)], W['lake'], '驗到紅方', hred, bred),
                agree('一比一（藍 1：紅 1）時的湖', [s for s in L if lsc(s) == (1, 1)], W['lake'], '驗到紅方', hred, bred),
                agree('紅方還沒拿到兩局時的湖（全部）', [s for s in L if c(s)['redWins'] < 2], W['lake'], '驗到紅方', hred, bred),
                agree('玩家驗「自己當隊長時派過的人」的時候', [s for s in L if c(s)['human']['onHolderProposals']], W['lake']),
                share(f'兩邊都刻意避開紅方（亂驗會有 {rnd:.0f}% 驗到紅）' if rnd else '驗到紅方', L, '驗到紅方', hred, bred),
                share('驗自己派過的人', L, '選這種人', lambda s: c(s)['human']['onHolderProposals'], lambda s: c(s)['agent']['onHolderProposals']),
                share('驗出過失敗任務的人', L, '選這種人', hm('failed'), bm('failed')),
            ],
            'diff': [
                agree('玩家驗「還沒出過任務的人」的時候', [s for s in L if hm('none')(s)], W['lake']),
                agree('紅方已經拿到兩局時的湖（全部）', [s for s in L if c(s)['redWins'] >= 2], W['lake'], '驗到紅方', hred, bred),
                agree('藍 0：紅 2 時的湖', [s for s in L if lsc(s) == (0, 2)], W['lake'], '驗到紅方', hred, bred),
                agree('藍 1：紅 2 時的湖', [s for s in L if lsc(s) == (1, 2)], W['lake'], '驗到紅方', hred, bred),
                agree('第 4 局任務之後的湖（藍 2：紅 2，最後一次湖）', [s for s in L if c(s)['afterRound'] == 4], W['lake'], '驗到紅方', hred, bred),
                share('驗只出過成功任務的人', L, '選這種人', hm('successOnly'), bm('successOnly')),
                share('驗還沒出過任務的人', L, '選這種人', hm('none'), bm('none')),
                share('驗隔壁（上一家或下一家）', L, '選這種人', lambda s: c(s)['human']['ring'] == 1, lambda s: c(s)['agent']['ring'] == 1),
            ],
        },
        'team': {
            'same': [
                agree('上一個任務成功之後的提議', [s for s in T if fr(s)['lastMissionSucceeded']], W['team']),
                agree('第 5 局第 1 次提議', [s for s in T if s['round'] == 5 and s['attempt'] == 1], W['team']),
                agree('第 3 局第 1 次提議', [s for s in T if s['round'] == 3 and s['attempt'] == 1], W['team']),
                agree('第 5 局（藍 2：紅 2）的所有提議', [s for s in T if s['round'] == 5], W['team'], '隊上沒有紅方', hclean, bclean),
                agree('第 1 局成功之後的第 2 局（藍 1：紅 0）', [s for s in T if sc(s) == (1, 0)], W['team']),
                agree('第 4 局第 1 次提議', [s for s in T if s['round'] == 4 and s['attempt'] == 1], W['team']),
                share('有人出過失敗任務時，隊上帶這種人（自己不算）', [s for s in T if [x for x in fr(s)['failedSeats'] if x != s['seat']]], '這樣派', lambda s: hf(s)['failedOthers'] > 0, lambda s: bf(s)['failedOthers'] > 0),
                share('有人被湖中宣告是藍方時帶他', [s for s in T if [x for x in fr(s)['lakeGoodSeats'] if x != s['seat']]], '這樣派', lambda s: hf(s)['lakeGoodOthers'] > 0, lambda s: bf(s)['lakeGoodOthers'] > 0),
            ],
            'diff': [
                agree('第 1 局的所有提議（還沒有任務紀錄）', [s for s in T if s['round'] == 1], W['team'], '隊上沒有紅方', hclean, bclean),
                agree('第 1 局失敗之後的第 2 局（藍 0：紅 1）', [s for s in T if sc(s) == (0, 1)], W['team'], '隊上沒有紅方', hclean, bclean),
                agree('藍 0：紅 2 的第 3 局', [s for s in T if sc(s) == (0, 2)], W['team'], '隊上沒有紅方', hclean, bclean),
                share('上一個任務失敗、更早有成功的隊時，把那支成功的隊全部留下', [s for s in T if not fr(s)['lastMissionSucceeded'] and fr(s)['lastSuccessTeam']], '這樣派', lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']),
                share('上一個任務成功時原班人馬照派', [s for s in T if fr(s)['lastMissionSucceeded']], '這樣派', lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']),
                share('當隊長時派自己', T, '這樣派', lambda s: hf(s)['hasSelf'], lambda s: bf(s)['hasSelf']),
                share('同一局上一隊被否決後，原隊再派一次（最多換 1 人）', [s for s in T if fr(s)['prevSameRound']], '這樣派', lambda s: hf(s)['overlapPrev'] >= fr(s)['size'] - 1, lambda s: bf(s)['overlapPrev'] >= fr(s)['size'] - 1),
            ],
        },
        'vote': {
            'same': [
                agree('自己當隊長、投自己派的隊', [s for s in V if c(s)['isLeader']], W['vote'], '投白球', hap, bap),
                agree('第 1 局在隊上', [s for s in ON if s['round'] == 1], W['vote'], '投白球', hap, bap),
                agree('第 1 局不在隊上', [s for s in OFF if s['round'] == 1], W['vote'], '投白球', hap, bap),
                agree('第 2 局不在隊上', [s for s in OFF if s['round'] == 2], W['vote'], '投白球', hap, bap),
                agree('第 2 局在隊上', [s for s in ON if s['round'] == 2], W['vote'], '投白球', hap, bap),
                agree('第 3 局不在隊上的第 1、2 次提議', [s for s in OFF if s['round'] == 3 and s['attempt'] <= 2], W['vote'], '投白球', hap, bap),
                agree('上一個任務成功、原班人馬照派的隊，自己在隊上', [s for s in ON if fr(s)['lastMissionSucceeded'] and c(s)['features']['keepsLastSuccess']], W['vote'], '投白球', hap, bap),
            ],
            'diff': [
                agree('藍 0：紅 2 的第 3 局、自己在隊上', [s for s in ON if sc(s) == (0, 2)], W['vote'], '投白球', hap, bap),
                agree('第 3 局在隊上（全部）', [s for s in ON if s['round'] == 3], W['vote'], '投白球', hap, bap),
                agree('第 4 局在隊上（全部）', [s for s in ON if s['round'] == 4], W['vote'], '投白球', hap, bap),
                agree('第 5 局在隊上', [s for s in ON if s['round'] == 5], W['vote'], '投白球', hap, bap),
                agree('第 3、4 局的第 4 次提議、自己不在隊上（再否決就是強制局）', [s for s in OFF if s['round'] in (3, 4) and s['attempt'] == 4], W['vote'], '投白球', hap, bap),
                agree('第 4 局不在隊上', [s for s in OFF if s['round'] == 4], W['vote'], '投白球', hap, bap),
                agree('隊上有被湖中宣告是紅方的人', [s for s in V if c(s)['features']['lakeEvilOthers'] > 0], W['vote'], '投白球', hap, bap),
                share('第 1、2 局在隊上卻投黑球（內黑）', [s for s in ON if s['round'] <= 2], '投黑球', lambda s: not hap(s), lambda s: not bap(s)),
            ],
        },
    }
    for cat in ('lake', 'team', 'vote'):
        h(3, CAT_ZH[cat])
        same = [x for x in spec[cat]['same'] if x]
        diff = [x for x in spec[cat]['diff'] if x]
        para('**相同的地方**')
        ul([x['text'] for x in same] or ['（沒有合計 30 次以上的情境）'])
        para('**不同的地方**')
        ul([x['text'] for x in diff] or ['（沒有合計 30 次以上的情境）'])
        out[cat] = {'same': same, 'different': diff}
    data['sameDifferent'] = out

    h(3, '主要差距的 95% 區間')
    gaps = [
        ('湖中：驗到紅方', L, hred, bred),
        ('湖中：紅方已拿兩局時驗到紅方', [s for s in L if c(s)['redWins'] >= 2], hred, bred),
        ('湖中：紅方還沒拿兩局時驗到紅方', [s for s in L if c(s)['redWins'] < 2], hred, bred),
        ('湖中：驗只出過成功任務的人', L, hm('successOnly'), bm('successOnly')),
        ('湖中：驗隔壁', L, lambda s: c(s)['human']['ring'] == 1, lambda s: c(s)['agent']['ring'] == 1),
        ('派隊：派自己', T, lambda s: hf(s)['hasSelf'], lambda s: bf(s)['hasSelf']),
        ('派隊：上一個任務成功時照派', [s for s in T if fr(s)['lastMissionSucceeded']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']),
        ('派隊：隊上沒有紅方（全部）', T, hclean, bclean),
        ('派隊：隊上沒有紅方（第 1 局）', [s for s in T if s['round'] == 1], hclean, bclean),
        ('派隊：隊上沒有紅方（第 1 局失敗後的第 2 局）', [s for s in T if sc(s) == (0, 1)], hclean, bclean),
        ('派隊：隊上沒有紅方（第 3 局以後）', [s for s in T if s['round'] >= 3], hclean, bclean),
        ('投票：投白球（全部）', V, hap, bap),
        ('投票：第 3 局在隊上投白球', [s for s in ON if s['round'] == 3], hap, bap),
        ('投票：第 4 局在隊上投白球', [s for s in ON if s['round'] == 4], hap, bap),
        ('投票：不在隊上投白球（外白）', OFF, hap, bap),
        ('投票：第 4 次提議、不在隊上投白球', [s for s in OFF if s['attempt'] == 4], hap, bap),
        ('投票：投對（危險的隊投黑、安全的隊投白）', V, hok, bok),
    ]
    rows, outg = [], []
    for label, xs, fp, fb in gaps:
        g = G(xs, fp, fb)
        if not g:
            continue
        sig = '是' if (g['lo'] > 0 or g['hi'] < 0) else '否（區間跨過 0）'
        rows.append([label, g['n'], g['games'], PB(g['p'], g['b']), f"{g['gap']:+.1f}", f"{g['lo']:+.1f} ～ {g['hi']:+.1f}", sig])
        outg.append({'label': label, **g})
    data['headlineGaps'] = outg
    table(['差距', '次數', '局數', '玩家 ／ 百科AI', '玩家 − 百科AI', '95% 區間', '看得出差別嗎'], rows, f'以局為單位重抽 {BOOT} 次（同一局的決策點綁在一起）。相同% 的區間（Wilson）列在各節的總表。')


# ══ 各玩家特色 ══════════════════════════════════════════
def metric_list(sel):
    """一批決策點的方向指標：遇到某種局面時這樣做的比例，玩家 vs 百科AI。"""
    V = [s for s in VOTE if sel(s)]
    T = [s for s in TEAM if sel(s)]
    L = [s for s in LAKE if sel(s)]
    on = [s for s in V if c(s)['onTeam']]
    off = [s for s in V if not c(s)['onTeam']]
    M = []

    def add(cat, label, xs, fp, fb, short=None):
        p, b = rate(xs, fp), rate(xs, fb)
        if p['n']:
            M.append({'cat': cat, 'label': label, 'short': short or label, 'n': p['n'], 'p': p['pct'], 'b': b['pct'], 'kp': p['k'], 'kb': b['k'], 'gap': p['pct'] - b['pct']})
    nh = lambda s: not hap(s)
    nb = lambda s: not bap(s)
    add('投票', '第 1、2 局在隊上投黑球（內黑）', [s for s in on if s['round'] <= 2], nh, nb)
    add('投票', '第 3 局在隊上投黑球（內黑）', [s for s in on if s['round'] == 3], nh, nb, '第 3 局在隊上內黑')
    add('投票', '第 4 局在隊上投黑球（內黑）', [s for s in on if s['round'] == 4], nh, nb, '第 4 局在隊上內黑')
    add('投票', '第 5 局在隊上投黑球（內黑）', [s for s in on if s['round'] == 5], nh, nb)
    add('投票', '第 1、2 局不在隊上投白球（外白）', [s for s in off if s['round'] <= 2], hap, bap)
    add('投票', '第 3 局以後不在隊上投白球（外白）', [s for s in off if s['round'] >= 3], hap, bap, '第 3 局以後外白')
    add('投票', '第 4 次提議、不在隊上投白球', [s for s in off if s.get('attempt') == 4], hap, bap, '第 4 次提議外白')
    add('投票', '危險的隊投黑球（擋下來）', [s for s in V if danger(s)], nh, nb)
    add('投票', '安全的隊投白球（放行）', [s for s in V if not danger(s)], hap, bap)
    add('派隊', '當隊長時派自己', T, lambda s: hf(s)['hasSelf'], lambda s: bf(s)['hasSelf'], '派自己')
    add('派隊', '上一個任務成功就原班人馬照派', [s for s in T if fr(s)['lastMissionSucceeded']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess'], '照派')
    add('派隊', '上一個任務失敗時，留下更早那支成功的隊', [s for s in T if not fr(s)['lastMissionSucceeded'] and fr(s)['lastSuccessTeam']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess'])
    add('派隊', '帶出過失敗任務的人', [s for s in T if [x for x in fr(s)['failedSeats'] if x != s['seat']]], lambda s: hf(s)['failedOthers'] > 0, lambda s: bf(s)['failedOthers'] > 0)
    add('派隊', '帶上一位隊長', [s for s in T if hf(s)['hasPrevLeader'] is not None], lambda s: hf(s)['hasPrevLeader'], lambda s: bf(s)['hasPrevLeader'])
    add('派隊', '帶被湖中宣告是藍方的人', [s for s in T if [x for x in fr(s)['lakeGoodSeats'] if x != s['seat']]], lambda s: hf(s)['lakeGoodOthers'] > 0, lambda s: bf(s)['lakeGoodOthers'] > 0)
    add('派隊', '上一隊被否決後原隊再派（最多換 1 人）', [s for s in T if fr(s)['prevSameRound']], lambda s: hf(s)['overlapPrev'] >= fr(s)['size'] - 1, lambda s: bf(s)['overlapPrev'] >= fr(s)['size'] - 1, '被否決後原隊再派')
    add('派隊', '派出沒有紅方的隊', T, hclean, bclean)
    for k, lab in (('failed', '驗出過失敗任務的人'), ('successOnly', '驗只出過成功任務的人'), ('none', '驗還沒出過任務的人')):
        add('湖中', lab, L, lambda s, k=k: c(s)['human']['missions'] == k, lambda s, k=k: c(s)['agent']['missions'] == k, '湖中' + lab)
    add('湖中', '驗隔壁的人', L, lambda s: c(s)['human']['ring'] == 1, lambda s: c(s)['agent']['ring'] == 1, '湖中驗隔壁')
    add('湖中', '驗自己派過的人', L, lambda s: c(s)['human']['onHolderProposals'], lambda s: c(s)['agent']['onHolderProposals'], '湖中驗自己派過的人')
    add('湖中', '驗到紅方', L, hred, bred, '湖中驗到紅方')
    for m in M:
        pp = (m['kp'] + m['kb']) / (2 * m['n'])
        m['se'] = 100 * math.sqrt(max(1e-9, 2 * pp * (1 - pp) / m['n']))
        m['z'] = m['gap'] / m['se']
    return M


PER_PLAYER = {}


def per_player_compute():
    for name in ORDER:
        M = metric_list(lambda s, name=name: s['player'] == name)
        others = {m['label']: m for m in metric_list(lambda s, name=name: s['player'] != name)}
        for m in M:
            o = others.get(m['label'])
            m['othersP'], m['othersB'], m['othersGap'] = (o['p'], o['b'], o['gap']) if o else (None, None, None)
            m['distinct'] = (m['gap'] - o['gap']) / math.sqrt(m['se'] ** 2 + o['se'] ** 2) if o else 0
            # 突出 = 和百科AI的差距比其他人更大（同一個方向），而且看得出來
            m['standsOut'] = bool(o) and (m['gap'] - o['gap']) * m['gap'] > 0 and abs(m['distinct']) >= 1
        ok = [m for m in M if m['n'] >= 20 and abs(m['z']) >= 2]
        cand = sorted([m for m in ok if m['standsOut']], key=lambda m: -abs(m['distinct']))
        cand += sorted([m for m in ok if not m['standsOut']], key=lambda m: -abs(m['z']))
        picks, seen = [], Counter()
        for m in cand:
            if seen[m['cat']] >= 2:
                continue
            picks.append(m)
            seen[m['cat']] += 1
            if len(picks) == 3:
                break
        PER_PLAYER[name] = {'top3': picks, 'all': M}


def per_player_section():
    pooled = {m['label']: m for m in metric_list(lambda s: True)}
    for name in ORDER:
        h(3, name)
        items = []
        for m in PER_PLAYER[name]['top3']:
            who = '比百科AI常' if m['gap'] > 0 else '比百科AI少'
            common = '' if m['standsOut'] else '〔和其他人差不多，是大家共同的差別〕'
            items.append(f"**{m['cat']}・{m['label']}**：{name} {m['p']:.1f}%、百科AI 在同樣的局面 {m['b']:.1f}%（{who} {abs(m['gap']):.1f} 個百分點，{m['n']} 次{'，樣本小' if m['n'] < 50 else ''}）；其他人合計是玩家 {m['othersP']:.1f}%、百科AI {m['othersB']:.1f}%。{common}")
        ul(items or ['（沒有至少 20 次而且明顯的差距）'])
    data['perPlayer'] = PER_PLAYER
    h(3, '對照表：每位玩家「玩家 − 百科AI」差幾個百分點')
    per = {name: {m['label']: m for m in PER_PLAYER[name]['all']} for name in ORDER}
    rows = []
    for lab, pl in pooled.items():
        r = [f"{pl['cat']}：{lab}", f"{pl['p']:.1f}% ／ {pl['b']:.1f}%（{pl['n']}）"]
        for name in ORDER:
            m = per[name].get(lab)
            r.append('—' if not m else f"{m['gap']:+.1f}{'＊' if m['n'] < 30 else ''}")
        rows.append(r)
    table(['指標', f'{ALLZH} 玩家 ／ 百科AI（次數）'] + ORDER, rows, '正數 = 玩家比百科AI常這樣做；＊ = 該玩家不到 30 次。')
    data['perPlayerMatrix'] = {'pooled': list(pooled.values())}


# ══ 例子 ══════════════════════════════════════════════
def choice_zh(s, v):
    if s['type'] == 'team':
        return f'派 {team_zh(v)}'
    if s['type'] == 'vote':
        return '白球（贊成）' if v == 'approve' else '黑球（反對）'
    return f'驗 {seat_zh(v)}'


def examples_section():
    out = {}

    def pick(xs, used):
        xs = sorted([s for s in xs if s.get('reason') and not s['reason'].startswith('（解釋失敗')], key=lambda s: (int(s['gameId']) if s['gameId'].isdigit() else 10 ** 9, s['round'], s.get('attempt') or 0))
        if not xs:
            return None
        start = len(xs) * 2 // 3
        for j in range(len(xs)):
            s = xs[(start + j) % len(xs)]
            if s['player'] not in used:
                used.add(s['player'])
                return s
        return xs[start]
    groups = {
        'lake': [
            ('紅方已拿兩局：玩家驗到藍方，百科AI 驗到紅方', [s for s in LAKE if not s['match'] and c(s)['redWins'] >= 2 and not hred(s) and bred(s)]),
            ('玩家驗還沒出過任務的人，百科AI 驗出過任務的人', [s for s in LAKE if not s['match'] and c(s)['human']['missions'] == 'none' and c(s)['agent']['missions'] != 'none']),
        ],
        'team': [
            ('上一個任務成功：百科AI 原班人馬照派，玩家換人', [s for s in TEAM if not s['match'] and fr(s)['lastMissionSucceeded'] and not hf(s)['keepsLastSuccess'] and bf(s)['keepsLastSuccess']]),
            ('第 1 局失敗後的第 2 局：玩家的隊沒有紅方，百科AI 的隊有紅方', [s for s in TEAM if not s['match'] and sc(s) == (0, 1) and hclean(s) and not bclean(s)]),
        ],
        'vote': [
            ('第 3 局在隊上：玩家投白球，百科AI 投黑球（內黑）', [s for s in ON if not s['match'] and s['round'] == 3 and hap(s)]),
            ('第 4 局在隊上：玩家投黑球（內黑），百科AI 投白球', [s for s in ON if not s['match'] and s['round'] == 4 and not hap(s)]),
        ],
    }
    for cat in ('lake', 'team', 'vote'):
        h(3, CAT_ZH[cat])
        used = set()
        out[cat] = []
        items = []
        for label, xs in groups[cat]:
            s = pick(xs, used)
            if not s:
                continue
            at = f"第 {s['round']} 局第 {s['attempt']} 次提議" if s.get('attempt') else f"第 {s['round']} 局任務之後"
            if cat == 'lake':
                extra = f"（當時藍 {c(s)['blueWins']}：紅 {c(s)['redWins']}；事後：{seat_zh(s['human'])}是{'紅' if hred(s) else '藍'}方、{seat_zh(s['agent'])}是{'紅' if bred(s) else '藍'}方）"
            elif cat == 'team':
                extra = f"（當時藍 {sc(s)[0]}：紅 {sc(s)[1]}；事後：玩家的隊有 {hf(s)['reds']} 個紅方、百科AI 的隊有 {bf(s)['reds']} 個）"
            else:
                extra = f"（當時藍 {sc(s)[0]}：紅 {sc(s)[1]}；提議的隊 {team_zh(','.join(map(str, c(s)['team'])))}，隊長 {seat_zh(fr(s)['leaderSeat'])}；事後：隊上有 {c(s)['features']['reds']} 個紅方）"
            items.append(f"**{label}**（合計 {len(xs)} 次）— 局 {s['gameId']}｜{at}｜{s['player']} 坐 {seat_zh(s['seat'])}｜玩家 {choice_zh(s, s['human'])} vs 百科AI {choice_zh(s, s['agent'])}{extra}｜百科AI 的理由：{s['reason']}")
            out[cat].append({'kind': label, 'count': len(xs), 'gameId': s['gameId'], 'round': s['round'], 'attempt': s.get('attempt'), 'player': s['player'], 'seat': s['seat'],
                             'human': s['human'], 'agent': s['agent'], 'reason': s['reason']})
        ul(items or ['（沒有附理由的例子：重播時要加 --dump-reasons）'])
    data['examples'] = out


# ══ 結論（數字照算）══════════════════════════════════════
def conclusion_items():
    f0 = lambda v: '—' if v is None else f'{v:.0f}%'
    f1 = lambda v: '—' if v is None else f'{v:.1f}%'
    same = lambda xs: rate(xs, lambda s: s['match'])['pct']
    R = lambda xs, f: rate(xs, f)['pct']
    nh = lambda s: not hap(s)
    nb = lambda s: not bap(s)
    seats = len({(x['gameId'], x['seat']) for x in H})
    games = len({x['gameId'] for x in H})
    on3 = [s for s in ON if s['round'] == 3]
    on4 = [s for s in ON if s['round'] == 4]
    off4 = [s for s in OFF if s['attempt'] == 4]
    early = [s for s in VOTE if s['round'] <= 2]
    lead = [s for s in VOTE if c(s)['isLeader']]
    T = TEAM
    after_ok = [s for s in T if fr(s)['lastMissionSucceeded']]
    after_fail = [s for s in T if not fr(s)['lastMissionSucceeded'] and fr(s)['lastSuccessTeam']]
    t01 = [s for s in T if sc(s) == (0, 1)]
    r2 = [s for s in LAKE if c(s)['redWins'] >= 2]
    d4 = [s for s in on4 if danger(s)]
    gl = boot_gap(LAKE, hred, bred)
    lake_word = '湖中看不出差別' if gl and gl['lo'] <= 0 <= gl['hi'] else ('湖中是玩家比較常驗到紅方' if gl and gl['gap'] > 0 else '湖中是百科AI比較常驗到紅方')
    vote_gap = R(VOTE, bok) - R(VOTE, hok)
    clean_gap = R(T, hclean) - R(T, bclean)
    items = [
        f"**名字**：{NP} 個寫法都直接對到網站上同名的正式玩家，沒有需要猜的（容易混淆的名字見〈玩家與局數〉）。忠臣局合計 {seats:,} 個座位（{games:,} 局）：湖中 {len(LAKE):,} 次、派隊 {len(TEAM):,} 次、投票 {len(VOTE):,} 張。",
        f"**投票最像**：{f1(same(VOTE))} 投同一種顏色；第 1、2 局 {f1(same(early))} 相同，自己當隊長時 {f1(same(lead))}。",
        f"**投票最不像的是「第 3 局自己在隊上」**：玩家 {f0(R(on3, hap))} 投白球，百科AI 只有 {f0(R(on3, bap))}（內黑 {f0(R(on3, nb))}，玩家 {f0(R(on3, nh))}）。第 4 局反過來：玩家內黑 {f0(R(on4, nh))}，百科AI 只有 {f0(R(on4, nb))}。",
        f"**玩家比較願意放行**：不在隊上投白球（外白）玩家 {f1(R(OFF, hap))}、百科AI {f1(R(OFF, bap))}；第 4 次提議（再否決就是強制局）{f1(R(off4, hap))} 對 {f1(R(off4, bap))}。",
        f"**派隊整隊相同只有 {f1(same(T))}**（差 1 人以內 {f0(R(T, lambda s: c(s)['seatsDiffer'] <= 1))}）。最像：上一個任務成功之後（{f0(same(after_ok))}）、第 3 局第 1 次（{f0(same([s for s in T if s['round'] == 3 and s['attempt'] == 1]))}）。最不像：第 1 局（{f1(same([s for s in T if s['round'] == 1]))}）、第 1 局失敗後的第 2 局（{f1(same(t01))}）。",
        f"**派法差在三件事**：百科AI 幾乎一定派自己（{f0(R(T, lambda s: bf(s)['hasSelf']))}，玩家 {f0(R(T, lambda s: hf(s)['hasSelf']))}）、比較愛照派（{f0(R(after_ok, lambda s: bf(s)['keepsLastSuccess']))} 對 {f0(R(after_ok, lambda s: hf(s)['keepsLastSuccess']))}）、任務失敗後還是把更早成功的那一隊整隊留下（{f0(R(after_fail, lambda s: bf(s)['keepsLastSuccess']))} 對 {f0(R(after_fail, lambda s: hf(s)['keepsLastSuccess']))}）。",
        f"**湖中驗同一個人 {f1(same(LAKE))}**（亂驗 {f0(chance(LAKE))}）。兩邊都偏向驗信得過的人（驗到紅方 玩家 {f0(R(LAKE, hred))}、百科AI {f0(R(LAKE, bred))}，亂驗 {f0(rnd_red(LAKE))}）；紅方拿到兩局後百科AI 改成抓紅（驗到紅 {f0(R(r2, bred))}），玩家 {f0(R(r2, hred))}。百科AI 也比較常驗隔壁（{f0(R(LAKE, lambda s: c(s)['agent']['ring'] == 1))} 對 {f0(R(LAKE, lambda s: c(s)['human']['ring'] == 1))}）。",
        f"**誰比較準**：票是{'百科AI' if vote_gap > 0 else '玩家'}略準（投對 百科AI {f1(R(VOTE, bok))}、玩家 {f1(R(VOTE, hok))}）；隊是{'玩家' if clean_gap > 0 else '百科AI'}略乾淨（沒有紅方 玩家 {f1(R(T, hclean))}、百科AI {f1(R(T, bclean))}，差在第 1、2 局）；{lake_word}。",
        f"**最值得拿去優化的**：① 第 4 局在隊上、隊上其實有兩個以上紅方時，玩家 {f0(R(d4, nh))} 會擋、百科AI 只有 {f0(R(d4, nb))}（真人桌的設定修過頭）；② 第 1 局失敗後的第 2 局，玩家派出沒有紅方的隊 {f0(R(t01, hclean))}、百科AI {f0(R(t01, bclean))}。細節在 `leads.md`。",
    ]
    feats, plain = [], []
    for name in ORDER:
        tops = [m for m in PER_PLAYER[name]['top3'] if m['standsOut']]
        if tops:
            m = tops[0]
            feats.append(f"{name} {m['short']} {f0(m['p'])}（其他人 {f0(m['othersP'])}，百科AI {f0(m['b'])}）")
        else:
            plain.append(name)
    line = '**個人特色**（各挑最突出的一件）：' + '；'.join(feats)
    if plain:
        line += f"；{'、'.join(plain)} 沒有比其他人更突出的差別"
    items.append(line + '。')
    return items


METHOD = """### 做法

- **資料**：網站戰績與數據分析用的那一批真人局（{games} 局）。不含 ProAvalon、不含百科AI 局；試算表標記的壞局、牌譜總庫標的錯誤局與疑似重複局、站長更正檔排除的局都不算；牌譜無法一步一步嚴格重播的局也不算（各有幾局見〈玩家與局數〉）。只比玩家拿到**忠臣**的座位。
- **重播**：和第 1 關的座位一致度、人類 PR 量尺同一套。百科AI 坐在玩家的那個座位，只拿到那一刻桌上的公開紀錄（忠臣沒有額外資訊），做一個決定，和玩家實際的選擇比；之後照真人的牌譜繼續走，下一個決策點再比一次。
- **百科AI**：重播當時的程式 {sha}{note}，用它在真人桌真的會用的策略層（照那一局開打前的桌上強度分弱／一般／強三層，強度不明算一般）。總表括號裡的「基準線層」是機器人互打用的那一套，只當對照。
- **湖中**：忠臣持湖時驗誰（同一個座位才算相同）。**派隊**：當隊長的每一次提議，含強制局；整隊每個人都一樣才算相同，另外列重疊度與差幾人。**投票**：第 1～4 次提議的每一張票（強制局不投票），同一種顏色算相同。
- **事後真相**（隊上有幾個紅方、驗到的人是不是紅方、隊長是不是紅方）只用來比誰比較準，做決定的當下兩邊都看不到。「危險的隊」= 隊上紅方人數夠讓任務失敗（第 4 局要 2 張失敗，所以要 2 個紅方）。
- **區間**：相同% 用 Wilson 95% 區間；「玩家 − 百科AI」的差用以局為單位的重抽（{boot} 次），同一局的決策點綁在一起。
- **各玩家特色**：每個指標先看這位玩家和百科AI有沒有明顯差距，再看這個差距有沒有比其他人更大；兩個都成立才算「突出」。

### 限制

- **量的是「同一個局面會不會做一樣的事」**，不是「換成百科AI 打這一局會不會贏」。百科AI 沒有參與前面的局面。
- **玩家有牌譜沒有的資訊**：聊天、語氣、彼此的習慣。百科AI 只有紀錄。第 1 局就派得比亂派乾淨，多半是這個。
- **投票的牌譜只記異常票**（內黑、外白），其他人一律當正常票；票數對不上結果的提議不算。所以投票「相同」很大一部分是兩邊都投正常票。
- **湖中樣本小**：合計 {lakes} 次，單一玩家 {lake_min}～{lake_max} 次；分到單一情境後只能看方向。表裡 ＊ = 不到 30 次。
- **派隊「整隊相同」很嚴格**：第 1 局沒有任何資訊，選誰本來就接近隨機，相同比例低不代表想法不同；要看「派自己、照派、帶誰」這些做法的比例。
- **同一局有兩位以上指定玩家都拿忠臣時各算各的**（{seats} 個座位來自 {ugames} 局）。
- **表很多**：單一格子的差別有些只是巧合；結論只用區間不跨 0、樣本夠的差別。"""


# ══ 線索（匿名，可以貼進 docs/ai/optimization_loop.md）══════════════════
def leads_md():
    def ai_rate(xs, f):
        ys = [AI[key(s)] for s in xs if key(s) in AI]
        return 100 * sum(1 for y in ys if f(y)) / len(ys) if ys else None

    def line(label, d, extra=''):
        return f"| {label} | {d['n']}（{d['games']} 局） | {d['p']:.1f}% | {d['b']:.1f}% | {ci_txt(d)} | {extra} |"
    nh = lambda s: not hap(s)
    nb = lambda s: not bap(s)
    out = {}
    L = []
    L.append(f'# {NP} 位高場數玩家的忠臣決策點 × 百科AI：哪些差別值得做一輪優化')
    L.append('')
    L.append(f"資料：網站戰績的真人局裡，{NP} 位指定玩家（匿名）拿到忠臣的 {len({(x['gameId'], x['seat']) for x in H})} 個座位（{len({x['gameId'] for x in H})} 局）；湖中 {len(LAKE)} 次、派隊 {len(TEAM)} 次、投票 {len(VOTE)} 張（第 1～4 次提議）。"
             f"重播同第 1 關／人類 PR 量尺（`playerAgreement.ts --roles loyal --dump-reasons` → `playerAgreementBreakdown.py`，程式 {meta['gitSha'][:10]}）：機器人坐在玩家的座位、只看當時的公開紀錄，每個決策點獨立比。"
             f'百科AI = 真人桌策略層；「基準線層」另外標。區間 = 以局為單位重抽 {BOOT} 次的 95% 區間。「事後真相」（隊上的紅方人數）只用來比誰比較準。')
    L.append('')
    L.append('判讀的規則：玩家的選擇**量得到比較好**（隊比較乾淨、票比較準、湖比較準，而且區間不跨 0）才算「可能是機器人的弱點」；只是做法不同、或機器人反而比較準的，歸「風格差」。')
    L.append('')
    L.append('## A. 可能是機器人的弱點（值得開一輪）')
    L.append('')
    r4 = [s for s in ON if s['round'] == 4]
    d4 = [s for s in r4 if danger(s)]
    s4 = [s for s in r4 if not danger(s)]
    a, b_, cc, ok = G(d4, nh, nb), G(s4, hap, bap), G(r4, nh, nb), G(r4, hok, bok)
    base_all = ai_rate(r4, lambda y: y['agent'] == 'reject')
    base_d = ai_rate(d4, lambda y: y['agent'] == 'reject')
    base_s = ai_rate(s4, lambda y: y['agent'] == 'approve')
    L.append('### A1. 第 4 局自己在隊上：隊上其實有兩個紅方時，百科AI 幾乎不擋（真人桌層的 `onTeamVote59=0.8` 修過頭）')
    L.append('')
    L.append('| 第 4 局、忠臣在隊上 | 票數 | 玩家 | 百科AI（真人桌層） | 玩家 − 百科AI（95% 區間） | 基準線層 |')
    L.append('|---|---|---|---|---|---|')
    L.append(line('內黑率（全部）', cc, pct(base_all)))
    L.append(line('隊上有 ≥ 2 個紅方 → 投黑球（擋下來）', a, pct(base_d)))
    L.append(line('隊上紅方 < 2 個 → 投白球（放行）', b_, pct(base_s)))
    L.append(line('投對（危險投黑、安全投白）', ok, ''))
    L.append('')
    byred = []
    for k in range(0, 4):
        xs = [s for s in r4 if c(s)['features']['reds'] == k]
        if xs:
            byred.append(f"{k} 個紅 {rate(xs, nh)['pct']:.0f}%／{rate(xs, nb)['pct']:.0f}%（{len(xs)} 票）")
    L.append('- 照隊上（別人）實際的紅方人數分，內黑率 玩家／百科AI：' + '、'.join(byred) + '。玩家會隨著隊上的紅變多而多擋，百科AI 幾乎是平的。')
    L.append('- 內黑率的走勢（第 1 → 5 局在隊上）：玩家 ' + ' → '.join(f"{rate([s for s in ON if s['round'] == r], nh)['pct']:.0f}%" for r in range(1, 6))
             + '；百科AI ' + ' → '.join(f"{rate([s for s in ON if s['round'] == r], nb)['pct']:.0f}%" for r in range(1, 6)) + '。玩家是逐局升高，百科AI 在第 3 局衝高、第 4 局掉到最低。')
    L.append(f"- 判讀：第 59 回合把第 4 局在隊上的內黑從基準線的五成壓下來是對的方向（當時量到真人 29%），但 0.8 的門檻讓它掉到 {cc['b']:.0f}%，危險的隊只擋 {a['b']:.0f}%。「投對」整體沒有差（第 4 局的隊大多安全），但放行一支有兩個紅的第 4 局隊伍，代價是那一局任務。")
    L.append('- 建議的一輪：`onTeamVote59` 掃 0.5／0.6／0.7（或改成跟「P(隊上的紅 ≥ 2)」連續對應的機率），量尺用這一格的「危險隊擋下率／安全隊放行率」＋人類 PR 量尺忠臣、派西；兩半都不負才放。')
    L.append('')
    out['A1'] = {'innerBlack': cc, 'rejectDanger': a, 'approveSafe': b_, 'correct': ok, 'baseline': {'innerBlack': base_all, 'rejectDanger': base_d, 'approveSafe': base_s}}

    t01 = [s for s in TEAM if sc(s) == (0, 1)]
    a2 = G(t01, hclean, bclean)
    base01 = ai_rate(t01, lambda y: y['ctx']['agent']['reds'] == 0)
    mr_p = sum(hf(s)['reds'] for s in t01) / len(t01)
    mr_b = sum(bf(s)['reds'] for s in t01) / len(t01)
    fo_p = sum(hf(s)['failedOthers'] for s in t01) / len(t01)
    fo_b = sum(bf(s)['failedOthers'] for s in t01) / len(t01)
    L.append('### A2. 第 1 局失敗之後的第 2 局派隊（藍 0：紅 1）：玩家的隊比較乾淨')
    L.append('')
    L.append('| 第 2 局（第 1 局失敗）、忠臣當隊長 | 次數 | 玩家 | 百科AI（真人桌層） | 玩家 − 百科AI（95% 區間） | 基準線層 |')
    L.append('|---|---|---|---|---|---|')
    L.append(line('隊上沒有紅方', a2, pct(base01)))
    L.append('')
    c0p = rate([s for s in t01 if hf(s)['failedOthers'] == 0], hclean)
    c0b = rate([s for s in t01 if bf(s)['failedOthers'] == 0], bclean)
    c1p = rate([s for s in t01 if hf(s)['failedOthers'] == 1], hclean)
    c1b = rate([s for s in t01 if bf(s)['failedOthers'] == 1], bclean)
    L.append(f"- 隊上平均紅方人數：玩家 {mr_p:.2f}、百科AI {mr_b:.2f}。兩邊帶「第 1 局失敗隊的人」的數量一樣（平均 {fo_p:.2f} 對 {fo_b:.2f} 人），差在**挑誰**：不帶失敗隊的人時沒紅 {pct(c0p['pct'])}（{c0p['n']} 次）對 {pct(c0b['pct'])}（{c0b['n']} 次），帶 1 個時 {pct(c1p['pct'])}（{c1p['n']}）對 {pct(c1b['pct'])}（{c1b['n']}）。")
    per = []
    for name in ORDER:
        xs = [s for s in t01 if s['player'] == name]
        if xs:
            per.append((rate(xs, hclean)['pct'] - rate(xs, bclean)['pct'], len(xs)))
    per.sort(reverse=True)
    L.append(f'- {NP} 位各自的差（玩家 − 百科AI，百分點；括號是次數）：' + '、'.join(f'{g:+.0f}（{n}）' for g, n in per) + '。不是每一位都贏，合計的差主要來自其中幾位。')
    L.append(f"- 整隊相同只有 {rate(t01, lambda s: s['match'])['pct']:.1f}%（全部提議 {rate(TEAM, lambda s: s['match'])['pct']:.1f}%），是除了第 1 局以外最不像的一格。")
    L.append('- 判讀：有量得到的差，但來源不確定——可能是第 1 局的票與提議裡還有機器人沒讀到的資訊，也可能是牌譜沒有的現場資訊（聊天、語氣）。第 72 回合看過這一格的讀法（`r2Lead72`，分角色 × 隊長位置）都不採用；這裡補的是「高場數的玩家在這一格確實派得比較乾淨」這個落差的大小。')
    L.append('- 建議的一輪：只拿這一格，把玩家選的人和機器人選的人逐一對（誰是第 1 局的隊長、誰對第 1 局的提議投了什麼、座位距離），看有沒有公開紀錄解釋得了的規律；解釋不了就記成「牌譜外的資訊」，不再追。')
    L.append('')
    out['A2'] = {'clean': a2, 'baseline': base01, 'meanReds': [mr_p, mr_b]}

    t1 = [s for s in TEAM if s['round'] == 1]
    a3 = G(t1, hclean, bclean)
    a31 = G([s for s in t1 if s['attempt'] == 1], hclean, bclean)
    a32 = G([s for s in t1 if 2 <= s['attempt'] <= 4], hclean, bclean)
    L.append('### A3. 第 1 局派隊：玩家高於亂派，百科AI 剛好等於亂派（多半是牌譜外的資訊，優先度低）')
    L.append('')
    L.append('| 第 1 局、忠臣當隊長 | 次數 | 玩家 | 百科AI | 玩家 − 百科AI（95% 區間） | 備註 |')
    L.append('|---|---|---|---|---|---|')
    L.append(line('隊上沒有紅方（全部提議）', a3, '亂派（自己＋隨機 2 人）= 27.8%'))
    L.append(line('　第 1 次提議（完全沒有公開紀錄）', a31, ''))
    L.append(line('　第 2～4 次提議（看得到前面的提議與票）', a32, ''))
    L.append('')
    L.append('- 判讀：第 1 次提議時桌上沒有任何紀錄，玩家還是高於亂派，表示這個差有一部分來自牌譜沒有的東西；第 2～4 次提議的差才可能是「讀第 1 局的票」。先不開，等 A2 的逐一比對有結果再決定。')
    L.append('')
    out['A3'] = {'all': a3, 'first': a31, 'later': a32}

    L.append('## B. 風格差（做法不同，但量不到玩家比較好，或機器人反而比較準）')
    L.append('')
    L.append('| 差別 | 次數 | 玩家 | 百科AI | 玩家 − 百科AI（95% 區間） | 誰比較準 |')
    L.append('|---|---|---|---|---|---|')
    r3 = [s for s in ON if s['round'] == 3]
    b1ok = G(r3, hok, bok)
    L.append(line('第 3 局在隊上的內黑率', G(r3, nh, nb), f"百科AI：投對 {b1ok['b']:.1f}% 對 {b1ok['p']:.1f}%（{ci_txt(b1ok)}）"))
    L.append(line('　有紅的隊 → 擋下來', G([s for s in r3 if danger(s)], nh, nb), '百科AI'))
    L.append(line('　沒紅的隊 → 放行', G([s for s in r3 if not danger(s)], hap, bap), '玩家'))
    L.append(line('第 5 局在隊上投對', G([s for s in ON if s['round'] == 5], hok, bok), ''))
    L.append(line('不在隊上投白球（外白）', G(OFF, hap, bap), '各有輸贏（下兩列）'))
    L.append(line('　第 4 次提議（再否決就是強制局）', G([s for s in OFF if s['attempt'] == 4], hap, bap), ''))
    L.append(line('　危險的隊 → 擋下來', G([s for s in OFF if danger(s)], nh, nb), '百科AI'))
    L.append(line('　安全的隊 → 放行', G([s for s in OFF if not danger(s)], hap, bap), '玩家'))
    L.append(line('所有票：投對', G(VOTE, hok, bok), ''))
    L.append(line('第 1、2 局在隊上的內黑率', G([s for s in ON if s['round'] <= 2], nh, nb), '看不出誰好（第 66 回合試過第 2 局忠臣這一支，量尺變差）'))
    L.append(line('當隊長時派自己', G(TEAM, lambda s: hf(s)['hasSelf'], lambda s: bf(s)['hasSelf']), ''))
    L.append(line('上一個任務成功 → 原班人馬照派', G([s for s in TEAM if fr(s)['lastMissionSucceeded']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']), ''))
    L.append(line('上一個任務失敗 → 留下更早那支成功的隊', G([s for s in TEAM if not fr(s)['lastMissionSucceeded'] and fr(s)['lastSuccessTeam']], lambda s: hf(s)['keepsLastSuccess'], lambda s: bf(s)['keepsLastSuccess']), ''))
    L.append(line('第 3 局以後派出沒有紅方的隊', G([s for s in TEAM if s['round'] >= 3], hclean, bclean), '區間跨 0 = 看不出差別'))
    L.append(line('上一隊被否決後原隊再派（最多換 1 人）', G([s for s in TEAM if fr(s)['prevSameRound']], lambda s: hf(s)['overlapPrev'] >= fr(s)['size'] - 1, lambda s: bf(s)['overlapPrev'] >= fr(s)['size'] - 1), ''))
    lk1 = [s for s in LAKE if c(s)['redWins'] < 2]
    lk2 = [s for s in LAKE if c(s)['redWins'] >= 2]
    L.append(line('湖中：驗到紅方（全部）', G(LAKE, hred, bred), f'亂驗 {rnd_red(LAKE):.0f}%'))
    L.append(line('　紅方還沒兩勝（信任鏈：想驗到藍方）', G(lk1, hred, bred), '百科AI（驗到的紅比較少）'))
    L.append(line('　紅方已兩勝（想抓紅）', G(lk2, hred, bred), '百科AI（驗到的紅比較多）'))
    L.append(line('　紅方還沒兩勝：驗只出過成功任務的人', G(lk1, lambda s: c(s)['human']['missions'] == 'successOnly', lambda s: c(s)['agent']['missions'] == 'successOnly'), ''))
    L.append(line('　紅方還沒兩勝：驗出過失敗任務的人', G(lk1, lambda s: c(s)['human']['missions'] == 'failed', lambda s: c(s)['agent']['missions'] == 'failed'), ''))
    L.append(line('湖中：驗隔壁（上一家或下一家）', G(LAKE, lambda s: c(s)['human']['ring'] == 1, lambda s: c(s)['agent']['ring'] == 1), ''))
    L.append('')
    n3 = sum(1 for s in r3 if not s['match'])
    L.append(f"- **第 3 局在隊上的內黑**是最大的一塊不同（{n3} 張，佔所有不同的票 {100 * n3 / max(1, sum(1 for s in VOTE if not s['match'])):.0f}%）：百科AI 內黑的比例是玩家的兩倍多，擋掉比較多有紅的隊，也擋掉三分之一沒紅的隊。照「投對」算是百科AI 比較準，所以不列弱點；如果目標是「像這幾位玩家」，可以用現成的開關 `onTeamVote59R3` 另外量。")
    L.append('- **派自己、照派、留成功隊**：百科AI 明顯比較黏著自己和成功過的隊，但第 3 局以後隊伍乾淨的比例看不出差別，是風格。')
    L.append(f"- **湖中**：兩種局面百科AI 都比玩家「更照目的走」。信任鏈的局面真人桌層（`lakeChain68`）幾乎只驗只出過成功任務的人，和這幾位驗同一個人的比例 {rate(lk1, lambda s: s['match'])['pct']:.1f}%（基準線層 {rate(lk1, lambda s: s['aiMatch'])['pct']:.1f}%）——第 68 回合的人類 PR 量尺是正的，所以是「比較不像、但不是比較差」。")
    L.append('- **驗隔壁**：百科AI 驗隔壁的比例是玩家的將近兩倍，可能和同分時的挑法有關；量不到對準度的影響，但容易被看出是機器人，可以順手查同分時怎麼挑。')
    L.append('')
    L.append('## C. 樣本與限制')
    L.append('')
    L.append(f'- 湖中只有 {len(LAKE)} 次，分到單一情境常常不到 70 次，只能看方向；派隊、投票的樣本夠。')
    L.append('- 每個決策點獨立重播：機器人沒有參與之前的局面，之後也照真人的牌譜走，所以量的是「同一個局面會不會做一樣的事」，不是「換成機器人打這一局會不會贏」。')
    L.append('- 玩家有牌譜沒有的資訊（聊天、語氣、彼此的習慣）；機器人只有公開紀錄。A2、A3 的差可能有一部分是這個。')
    L.append('- 投票的牌譜只記異常票（內黑、外白），其餘都當正常票；只算票數對得上結果的提議。')
    L.append('- 表很多，單一格子的差別有些只是巧合；上面只把區間不跨 0、而且方向說得通的列進 A。')
    open(os.path.join(OUT, 'leads.md'), 'w', encoding='utf8').write('\n'.join(L) + '\n')
    data['leads'] = out


# ══ 組裝 ══════════════════════════════════════════════
os.makedirs(OUT, exist_ok=True)
per_player_compute()
roles_zh = '忠臣'
h(1, f'{NP} 位玩家的{roles_zh}決策點 × 百科AI：哪裡相同、哪裡不同')
para(f"產生：{meta['generatedAt'][:16].replace('T', ' ')} UTC｜百科AI 程式版本 {meta['gitSha'][:10]}{opts.get('code-note', '')}｜資料：網站戰績的真人局 {meta['datasetGames']} 局裡，這 {NP} 位拿到忠臣的局。私人分析，內含玩家名字，不要貼到公開的地方。")
h(2, '結論')
ul(conclusion_items())
h(2, '玩家與局數')
players_block()
h(2, '一、湖中')
para('忠臣拿到湖中女神時驗誰（忠臣的宣告一定是實話，所以只比對象）。')
lake_section()
h(2, '二、任務派隊')
para('輪到這位玩家當隊長的每一次提議（含強制局）。')
team_section()
h(2, '三、黑白球投票')
vote_section()
h(2, '相同的地方、不同的地方')
same_diff_section()
h(2, '各玩家特色')
para('每位玩家挑 3 件「和百科AI有明顯差距、而且差得比其他人更多」的事（至少 20 次、同一類最多 2 件；不夠 3 件就補大家共同的差別並標出來）。百分比 = 遇到那種局面時這樣做的比例。')
per_player_section()
h(2, '例子')
para('每一類挑兩種合計差很多的情形，各一個實際的局面。「百科AI 的理由」是它在那個座位、只看當時公開資訊做決定時自己留下的一句話（小數是它估那個人是紅方的機率）。')
examples_section()
h(2, '做法與限制')
lake_ns = [sum(1 for s in LAKE if s['player'] == n) for n in ORDER]
rawmd(METHOD.format(games=meta['datasetGames'], sha=meta['gitSha'][:10], note=opts.get('code-note', ''), boot=BOOT, lakes=len(LAKE), lake_min=min(lake_ns), lake_max=max(lake_ns),
                    seats=len({(x['gameId'], x['seat']) for x in H}), ugames=len({x['gameId'] for x in H})))
if 'notes' in opts and os.path.exists(os.path.join(opts['notes'], 'method_extra.md')):
    rawmd(open(os.path.join(opts['notes'], 'method_extra.md'), encoding='utf8').read().strip())
leads_md()


def cell_md(x):
    return x.md() if hasattr(x, 'md') else str(x)


def cell_html(x):
    return x.html() if hasattr(x, 'html') else html.escape(str(x))


def inline_html(t):
    t = html.escape(t)
    out, on = [], False
    for part in t.split('**'):
        out.append(('<b>' if on else '') + part + ('</b>' if on else ''))
        on = not on
    return ''.join(out).replace('`', '')


def md_to_html(text):
    out, lst = [], False
    for line in text.split('\n'):
        if line.startswith('- '):
            if not lst:
                out.append('<ul>')
                lst = True
            out.append(f'<li>{inline_html(line[2:])}</li>')
            continue
        if lst:
            out.append('</ul>')
            lst = False
        if line.startswith('### '):
            out.append(f'<h3>{inline_html(line[4:])}</h3>')
        elif line.strip():
            out.append(f'<p>{inline_html(line)}</p>')
    if lst:
        out.append('</ul>')
    return '\n'.join(out)


md, ht = [], []
for b in blocks:
    if b[0] == 'h':
        md += ['#' * b[1] + ' ' + b[2], '']
        ht.append(f'<h{b[1]}>{html.escape(b[2])}</h{b[1]}>')
    elif b[0] == 'p':
        md += [b[1], '']
        ht.append(f'<p>{inline_html(b[1])}</p>')
    elif b[0] == 'ul':
        md += [f'- {x}' for x in b[1]] + ['']
        ht.append('<ul>' + ''.join(f'<li>{inline_html(x)}</li>' for x in b[1]) + '</ul>')
    elif b[0] == 'raw':
        md += [b[1], '']
        ht.append(md_to_html(b[1]))
    elif b[0] == 't':
        _, heads, rows, nt = b
        md.append('| ' + ' | '.join(heads) + ' |')
        md.append('|' + '---|' * len(heads))
        for r in rows:
            md.append('| ' + ' | '.join(cell_md(x) for x in r) + ' |')
        md.append('')
        if nt:
            md += [f'（{nt}）', '']
        ht.append('<div class="tw"><table><thead><tr>' + ''.join(f'<th>{html.escape(x)}</th>' for x in heads) + '</tr></thead><tbody>'
                  + ''.join('<tr>' + ''.join(f'<td>{cell_html(x)}</td>' for x in r) + '</tr>' for r in rows) + '</tbody></table></div>')
        if nt:
            ht.append(f'<p class="note">{html.escape(nt)}</p>')

open(os.path.join(OUT, 'report.md'), 'w', encoding='utf8').write('\n'.join(md))
CSS = """
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0f1216;color:#e6e9ee;font:15px/1.65 -apple-system,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
main{max-width:1080px;margin:0 auto;padding:16px}
h1{font-size:22px;line-height:1.35;margin:8px 0 12px}
h2{font-size:19px;margin:34px 0 10px;padding:8px 12px;background:#1a2029;border-left:4px solid #e0a43a;border-radius:4px}
h3{font-size:16px;margin:22px 0 8px;color:#f0c674}
p{margin:8px 0}
ul{margin:8px 0;padding-left:20px}
li{margin:6px 0}
.note{color:#9aa4b2;font-size:13px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:#b8c0cc;margin:6px 0 2px}
.legend span::before{content:"";display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.legend .lp::before{background:#4f9dde}.legend .lb::before{background:#e0a43a}.legend .ls::before{background:#5fb37a}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:8px 0;border:1px solid #262d38;border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{padding:6px 8px;border-bottom:1px solid #222935;text-align:left;vertical-align:middle;white-space:nowrap}
td:first-child,th:first-child{white-space:normal;min-width:150px;position:sticky;left:0;background:#12161c}
th{background:#171c24;color:#b8c0cc;font-weight:600;white-space:normal;min-width:74px}
tbody tr:nth-child(even) td{background:#12161c}
.bar{position:relative;height:17px;min-width:110px;background:#1c222c;border-radius:3px;margin:2px 0;overflow:hidden}
.bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px}
.bar b{position:relative;font-weight:500;font-size:12px;line-height:17px;padding-left:6px;color:#fff;text-shadow:0 0 3px #000}
.bar.p i{background:#2f6fa8}.bar.b i{background:#a87420}.bar.s i{background:#3c7f55}
"""
page = ('<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{NP} 位玩家的忠臣決策點 × 百科AI</title><style>' + CSS + '</style></head><body><main>'
        + ht[0] + '<div class="legend"><span class="lp">玩家</span><span class="lb">百科AI</span><span class="ls">相同%</span></div>' + '\n'.join(ht[1:]) + '</main></body></html>')
open(os.path.join(OUT, 'report.html'), 'w', encoding='utf8').write(page)


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, float):
        return round(o, 3)
    return o


json.dump(clean(data), open(os.path.join(OUT, 'data.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
print('wrote', OUT, 'lake', len(LAKE), 'team', len(TEAM), 'vote', len(VOTE))
