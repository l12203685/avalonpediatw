#!/usr/bin/env python3
"""每個角色的強者 × 百科AI：分情境的相同／不同與線索表（站長 2026-11-25：「也同樣去對所有角色做一樣的事情
比較與真人強者的主要差異點」「比較時針對該角色比較強 但整體勝率也不差的那幾位玩家」）。

讀 `roleSpots.ts replay` → `annotate` 寫的 spots.jsonl、games.json（每個座位的每個決策點＋局面欄位，沒有名字），
自己從資料集選各角色的強者，寫：

  OUT/report.md、report.html   私人報告（有玩家名字；同一份內容，深色、手機可讀）
  OUT/data.json                私人：選人表＋所有表格的數字
  OUT/leads.md                 匿名：各角色的線索表（可以貼進 docs）
  OUT/cells.json               匿名：每個格子的合計數字
  OUT/cells.public.json        匿名：次數夠、區間不跨 0 的格子（小檔，可以放進 repo）

  cd packages/server
  npx tsx scripts/roleSpots.ts replay --out /repo 外/full && npx tsx scripts/roleSpots.ts annotate --out /repo 外/full
  python3 -I scripts/roleBreakdown.py /repo 外/full /repo 外/out [--dataset games_cache.json] [--notes DIR] [--code-note TEXT]
      [--top 7] [--min-role-games 30] [--min-loyal-games 100] [--regular-games 100] [--shrink 30] [--assassin-by win|hit]
      [--pick FILE]    FILE = {"merlin": ["名字", ...], ...}：這些角色不照規則選，直接用指定的人（檔案放 repo 外）

本檔沒有任何玩家名字（名字從資料集讀）。OUT 不可以在 repo 裡。

選人（每個角色各自選）：
  候選   拿過這個角色 ≥ MIN_ROLE_GAMES 局（忠臣 ≥ MIN_LOYAL_GAMES 局；每個特殊角色大約佔一個人 1/10 的局）
  排序   該角色的勝率，往全體該角色的平均收縮（加 SHRINK 局「平均表現」的假局），避免十幾局的好運排到前面
  門檻   整體勝率（照 6 藍 4 紅的發牌比例加權）≥ 常客（總局數 ≥ REGULAR_GAMES）的中位數；收縮後的角色勝率要高於全體平均
  取     前 TOP 位（不足就有幾位算幾位）
  刺客另外列刺中率、梅林另外列「三藍時沒被刺中」的比例（只列出來，不另外當門檻；--assassin-by hit 可以改用刺中率排序）。

比較：機器人坐在玩家的座位、只看當時的公開紀錄＋自己角色的資訊；百科AI = 真人桌策略層，基準線另外一欄。
  「強者 − 百科AI」的區間 = 以局為單位重抽 BOOT 次的 95% 區間。
誰比較好：
  事後看   用牌譜的真相打分數（藍方的票：危險的隊投黑、安全的隊投白；藍方派隊：隊上沒有紅方；刺殺：刺中梅林……）
  勝率     全部真人在同一格、同一個角色，做 A 和做 B 的時候各自的勝率（相關，不是因果）
"""
import html
import json
import math
import os
import statistics
import sys
from collections import Counter, defaultdict

import numpy as np

argv = sys.argv[1:]
opts = {'top': '7', 'min-role-games': '30', 'min-loyal-games': '100', 'regular-games': '100', 'shrink': '30', 'assassin-by': 'win'}
pos = []
i = 0
while i < len(argv):
    if argv[i].startswith('--') and argv[i][2:] in ('dataset', 'notes', 'code-note', 'top', 'min-role-games', 'min-loyal-games', 'regular-games', 'shrink', 'assassin-by', 'pick'):
        opts[argv[i][2:]] = argv[i + 1]
        i += 2
    else:
        pos.append(argv[i])
        i += 1
if len(pos) != 2:
    sys.exit(__doc__)
SRC, OUT = pos
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
if os.path.abspath(OUT) == REPO or os.path.abspath(OUT).startswith(REPO + os.sep):
    sys.exit(f'OUT must be outside the repo ({REPO}): the report has player names')
os.makedirs(OUT, exist_ok=True)
DATASET = opts.get('dataset', os.path.join(HERE, '..', 'games_cache.json'))
TOP = int(opts['top'])
MIN_ROLE_GAMES = int(opts['min-role-games'])
MIN_LOYAL_GAMES = int(opts['min-loyal-games'])
REGULAR_GAMES = int(opts['regular-games'])
SHRINK = int(opts['shrink'])
BOOT = 1000
RNG = np.random.default_rng(20261125)
NEED = {1: 1, 2: 1, 3: 1, 4: 2, 5: 1}
RED = {'assassin', 'morgana', 'mordred', 'oberon'}
ROLES = ['merlin', 'percival', 'loyal', 'assassin', 'morgana', 'mordred', 'oberon']
ROLE_ZH = {'merlin': '梅林', 'percival': '派西維爾', 'loyal': '忠臣', 'assassin': '刺客', 'morgana': '莫甘娜', 'mordred': '莫德雷德', 'oberon': '奧伯倫'}
CATS = ['lake', 'claim', 'team', 'vote', 'quest', 'kill']
CAT_ZH = {'lake': '湖中（驗誰）', 'claim': '湖中（宣告什麼顏色）', 'team': '任務派隊', 'vote': '黑白球投票', 'quest': '任務牌', 'kill': '刺殺'}
SAME_ZH = {'lake': '驗同一個人', 'claim': '宣告同一種顏色', 'team': '整隊相同', 'vote': '投同一種顏色', 'quest': '出同一種牌', 'kill': '刺同一個人'}
TYPE_CAT = {'lakeTarget': 'lake', 'lakeClaim': 'claim', 'team': 'team', 'vote': 'vote', 'quest': 'quest', 'questOpen': 'quest', 'assassinate': 'kill'}

# ══ 局與選人 ═════════════════════════════════════════════
graw = json.load(open(os.path.join(SRC, 'games.json'), encoding='utf8'))
META = graw.get('meta', {})
GAMES = {g['id']: g for g in graw['games']}
NAMES = json.load(open(DATASET, encoding='utf8'))['players']


def side_won(g, role):
    return (g['outcome'] != '三藍活') if role in RED else (g['outcome'] == '三藍活')


tot, win, rg, rw, sg, sw = Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
kill3, killhit, mer3, mersafe = Counter(), Counter(), Counter(), Counter()
for g in GAMES.values():
    for k, p in enumerate(g['players']):
        role = g['roles'][k]
        w = 1 if side_won(g, role) else 0
        rg[('*', role)] += 1
        rw[('*', role)] += w
        if g['outcome'] != '三紅':
            if role == 'assassin':
                kill3['*'] += 1
                killhit['*'] += g['outcome'] == '三藍死'
            if role == 'merlin':
                mer3['*'] += 1
                mersafe['*'] += g['outcome'] == '三藍活'
        if p < 0:
            continue
        tot[p] += 1
        win[p] += w
        rg[(p, role)] += 1
        rw[(p, role)] += w
        sg[(p, role in RED)] += 1
        sw[(p, role in RED)] += w
        if g['outcome'] != '三紅':
            if role == 'assassin':
                kill3[p] += 1
                killhit[p] += g['outcome'] == '三藍死'
            if role == 'merlin':
                mer3[p] += 1
                mersafe[p] += g['outcome'] == '三藍活'


def std_overall(p):
    """整體勝率，照 6 藍 4 紅的發牌比例加權（拿到紅方的運氣不算）。"""
    if not sg[(p, False)] or not sg[(p, True)]:
        return None
    return 100 * (0.6 * sw[(p, False)] / sg[(p, False)] + 0.4 * sw[(p, True)] / sg[(p, True)])


REGULARS = [p for p in tot if tot[p] >= REGULAR_GAMES and std_overall(p) is not None]
MEDIAN = statistics.median(std_overall(p) for p in REGULARS)
ROLE_MEAN = {r: 100 * rw[('*', r)] / rg[('*', r)] for r in ROLES}
HIT_MEAN = 100 * killhit['*'] / kill3['*']
SAFE_MEAN = 100 * mersafe['*'] / mer3['*']


def shrunk(k, n, mean, weight=SHRINK):
    return 100 * (k + weight * mean / 100) / (n + weight)


PICK = json.load(open(opts['pick'], encoding='utf8')) if opts.get('pick') else {}
SELECT = {}
SEL = {}
for role in ROLES:
    need = MIN_LOYAL_GAMES if role == 'loyal' else MIN_ROLE_GAMES
    rows = []
    for p in tot:
        n = rg[(p, role)]
        if n < need and NAMES[p] not in PICK.get(role, []):
            continue
        r = {
            'player': NAMES[p], 'pid': p, 'roleGames': n, 'roleWinPct': 100 * rw[(p, role)] / n,
            'roleWinShrunk': shrunk(rw[(p, role)], n, ROLE_MEAN[role]), 'games': tot[p], 'overallPct': 100 * win[p] / tot[p],
            'overallStd': std_overall(p),
        }
        if role == 'assassin':
            r.update(attempts=kill3[p], hitPct=(100 * killhit[p] / kill3[p] if kill3[p] else None), hitShrunk=shrunk(killhit[p], kill3[p], HIT_MEAN, 15))
        if role == 'merlin':
            r.update(threeBlue=mer3[p], safePct=(100 * mersafe[p] / mer3[p] if mer3[p] else None))
        r['overallOk'] = r['overallStd'] is not None and r['overallStd'] >= MEDIAN
        r['aboveMean'] = r['roleWinShrunk'] > ROLE_MEAN[role]
        rows.append(r)
    keyf = (lambda r: -r['hitShrunk']) if role == 'assassin' and opts['assassin-by'] == 'hit' else (lambda r: -r['roleWinShrunk'])
    rows.sort(key=keyf)
    picked = [r for r in rows if r['overallOk'] and r['aboveMean']][:TOP]
    if role in PICK:
        missing = [n for n in PICK[role] if n not in NAMES]
        if missing:
            sys.exit(f'--pick: not in the dataset: {missing}')
        picked = [r for r in rows if r['player'] in PICK[role]]
    for r in rows:
        r['picked'] = r in picked
    SELECT[role] = {'minGames': need, 'candidates': len(rows), 'roleMeanPct': ROLE_MEAN[role], 'rows': rows}
    SEL[role] = {r['pid'] for r in picked}

# ══ 讀決策點（攤平）═══════════════════════════════════════
SPOTS = defaultdict(list)  # (role, cat) → [d]


def flat(s):
    g = GAMES.get(s['gameId'])
    if g is None:
        return None
    role = s['role']
    cat = TYPE_CAT[s['type']]
    ctx = s.get('ctx')
    if ctx is None:
        return None
    cta = s.get('ctxAi') or ctx
    pid = g['players'][s['seat'] - 1]
    d = {'g': s['gameId'], 'seat': s['seat'], 'role': role, 'cat': cat, 'rd': s['round'], 'at': s.get('attempt'), 'pid': pid,
         'sel': pid in SEL[role], 'win': 1 if side_won(g, role) else 0, 'red': role in RED}
    hu, bh, ba = s['human'], s['agent'], s['agentAi']
    if cat == 'vote':
        f = ctx['features']
        d.update(hu=hu == 'approve', bh=bh == 'approve', ba=ba == 'approve', on=ctx['onTeam'], lead=ctx['isLeader'], reds=f['reds'],
                 known=f['knownRedOthers'], thumbs=f['thumbOthers'], failed=f['failedOthers'], bw=ctx['frame']['blueWins'], rw=ctx['frame']['redWins'],
                 danger=f['reds'] >= NEED[s['round']], sbh=hu == bh, sba=hu == ba)
    elif cat == 'team':
        fr = ctx['frame']
        if not ctx['agent']['roles'] or not cta['agent']['roles']:
            return None
        d.update(hu=ctx['human'], bh=ctx['agent'], ba=cta['agent'], bw=fr['blueWins'], rw=fr['redWins'], size=fr['size'], sbh=hu == bh, sba=hu == ba,
                 prevSame=fr['prevSameRound'])
    elif cat == 'lake':
        if not ctx.get('agent') or not cta.get('agent'):
            return None
        d.update(hu=ctx['human'], bh=ctx['agent'], ba=cta['agent'], bw=ctx['blueWins'], rw=ctx['redWins'], nvalid=len(ctx['valid']),
                 vreds=ctx['validReds'], vknown=ctx['validKnownReds'], vthumbs=ctx['validThumbs'], vm=ctx['validMissions'], sbh=hu == bh, sba=hu == ba)
    elif cat == 'claim':
        t = ctx['target']
        d.update(hu=hu, bh=bh, ba=ba, bw=ctx['blueWins'], rw=ctx['redWins'], tred=t['red'], tknown=t['knownRed'], trole=t['role'], sbh=hu == bh, sba=hu == ba)
    elif cat == 'quest':
        pinned = s['type'] == 'quest'
        d.update(hu=(1.0 if hu == 'fail' else 0.0) if pinned else s.get('humanFailShare'), bh=1.0 if bh == 'fail' else 0.0, ba=1.0 if ba == 'fail' else 0.0,
                 pinned=pinned, bw=ctx['blueWins'], rw=ctx['redWins'], reds=ctx['redsOnTeam'], known=ctx['knownRedOthers'], need=ctx['failsRequired'],
                 lead=ctx['isLeader'], fails=ctx['failCount'], sbh=(hu == bh) if pinned else None, sba=(hu == ba) if pinned else None)
    elif cat == 'kill':
        if not ctx.get('agent') or not cta.get('agent'):
            return None
        d.update(hu=ctx['human'], bh=ctx['agent'], ba=cta['agent'], rw=ctx['redWins'], path=ctx['path'], sbh=hu == bh, sba=hu == ba)
    return d


KILL_BY_GAME = {}
with open(os.path.join(SRC, 'spots.jsonl'), encoding='utf8') as fh:
    for line in fh:
        if not line.strip():
            continue
        d = flat(json.loads(line))
        if d is None:
            continue
        SPOTS[(d['role'], d['cat'])].append(d)
        if d['cat'] == 'kill':
            KILL_BY_GAME[d['g']] = d
# 刺殺：紅方一起討論 → 把刺客座位的決策點也記到同一局的其他紅方座位（機器人 = 刺客座位的機器人）。
for g in GAMES.values():
    k = KILL_BY_GAME.get(g['id'])
    if not k:
        continue
    for seat, role in enumerate(g['roles'], 1):
        # 梅林也記一份：真人刺客與機器人刺客各自有沒有抓到「這一位梅林」。
        if (role in RED and role != 'assassin') or role == 'merlin':
            pid = g['players'][seat - 1]
            SPOTS[(role, 'kill')].append({**k, 'seat': seat, 'role': role, 'pid': pid, 'sel': pid in SEL[role], 'via': True,
                                          'win': 1 if side_won(g, role) else 0, 'red': role in RED})
REPLAYED = {d['g'] for (r, c), xs in SPOTS.items() if c == 'vote' for d in xs}
ROLE_SEATS = {}
for role in ROLES:
    seats_all = {(d['g'], d['seat']) for d in SPOTS[(role, 'vote')]}
    seats_sel = {(d['g'], d['seat']) for d in SPOTS[(role, 'vote')] if d['sel']}
    ROLE_SEATS[role] = {'all': len(seats_all), 'sel': len(seats_sel), 'selGames': len({g for g, _ in seats_sel})}


# ══ 統計小工具 ════════════════════════════════════════════
def mean(vals):
    vals = [v for v in vals if v is not None]
    return (100 * sum(vals) / len(vals)) if vals else None


def boot_gap(xs, fa, fb):
    """mean(fa) − mean(fb)（同一批決策點，成對），以局為單位重抽 → 95% 區間。"""
    by = defaultdict(lambda: [0.0, 0.0, 0.0])
    for x in xs:
        a, b = fa(x), fb(x)
        if a is None or b is None:
            continue
        t = by[x['g']]
        t[0] += 1
        t[1] += a
        t[2] += b
    if not by:
        return None
    arr = np.array(list(by.values()))
    n = arr[:, 0].sum()
    gap = 100 * (arr[:, 1].sum() - arr[:, 2].sum()) / n
    m = len(arr)
    if m < 2:
        return {'n': int(n), 'games': m, 'gap': gap, 'lo': None, 'hi': None, 'a': 100 * arr[:, 1].sum() / n, 'b': 100 * arr[:, 2].sum() / n}
    idx = RNG.integers(0, m, size=(BOOT, m))
    s = arr[idx].sum(axis=1)
    ok = s[:, 0] > 0
    v = np.sort(100 * (s[ok, 1] - s[ok, 2]) / s[ok, 0])
    return {'n': int(n), 'games': m, 'gap': gap, 'lo': float(v[int(0.025 * len(v))]), 'hi': float(v[int(0.975 * len(v)) - 1]),
            'a': 100 * arr[:, 1].sum() / n, 'b': 100 * arr[:, 2].sum() / n}


def wr_choice(xs, f):
    """全部真人：做 A（f=1）的勝率 − 做 B（f=0）的勝率，以局為單位重抽 → 95% 區間。只算 f 是 0 或 1 的決策點。"""
    by = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])
    for x in xs:
        v = f(x)
        if v is None or v not in (0, 1, True, False):
            continue
        t = by[x['g']]
        if v:
            t[0] += 1
            t[1] += x['win']
        else:
            t[2] += 1
            t[3] += x['win']
    if not by:
        return None
    arr = np.array(list(by.values()))
    n1, n0 = arr[:, 0].sum(), arr[:, 2].sum()
    if n1 < 20 or n0 < 20:
        return {'n1': int(n1), 'n0': int(n0), 'wr1': (100 * arr[:, 1].sum() / n1 if n1 else None), 'wr0': (100 * arr[:, 3].sum() / n0 if n0 else None), 'd': None, 'lo': None, 'hi': None}
    m = len(arr)
    idx = RNG.integers(0, m, size=(BOOT, m))
    s = arr[idx].sum(axis=1)
    ok = (s[:, 0] > 0) & (s[:, 2] > 0)
    v = np.sort(100 * (s[ok, 1] / s[ok, 0] - s[ok, 3] / s[ok, 2]))
    return {'n1': int(n1), 'n0': int(n0), 'wr1': 100 * arr[:, 1].sum() / n1, 'wr0': 100 * arr[:, 3].sum() / n0,
            'd': 100 * (arr[:, 1].sum() / n1 - arr[:, 3].sum() / n0), 'lo': float(v[int(0.025 * len(v))]), 'hi': float(v[int(0.975 * len(v)) - 1])}


def sig(g):
    return bool(g) and g.get('lo') is not None and (g['lo'] > 0 or g['hi'] < 0)


def pct(v, d=1):
    return '—' if v is None else f'{v:.{d}f}%'


def ci_txt(g):
    if not g:
        return '—'
    if g.get('lo') is None:
        return f"{g['gap']:+.1f}"
    return f"{g['gap']:+.1f}（{g['lo']:+.1f} ～ {g['hi']:+.1f}）"


def seat_zh(x):
    x = int(x)
    return f'{0 if x == 10 else x}家'


# ══ 特徵（每一類決策比什麼）═════════════════════════════════
# 一個特徵 = (代號, 中文, f(d, who))；who = 'hu' 真人、'bh' 百科AI（真人桌層）、'ba' 基準線。回傳 0..1 或 None。
def tf(key):
    return lambda d, w: 1.0 if d[w][key] else 0.0


def good_of(d, w):
    """事後看的好決定（沒有定義 = None）。"""
    c = d['cat']
    if c == 'vote':
        ok = d[w] != d['danger']  # 危險投黑、安全投白
        return (1.0 if ok else 0.0) if not d['red'] else (0.0 if ok else 1.0)  # 紅方相反：危險的隊放行、乾淨的隊擋下
    if c == 'team':
        t = d[w]
        dangerous = t['reds'] >= NEED[d['rd']]
        return (0.0 if dangerous else 1.0) if not d['red'] else (1.0 if dangerous else 0.0)
    if c == 'kill':
        return 1.0 if d[w]['role'] == 'merlin' else 0.0
    return None


GOOD_ZH = {('vote', False): '投對（危險的隊投黑、安全的隊投白）', ('vote', True): '幫到紅方的票（危險的隊投白、乾淨的隊投黑）',
           ('team', False): '派出不會失敗的隊（紅方人數不夠讓任務失敗）', ('team', True): '派出會失敗的隊（紅方人數夠）', ('kill', True): '刺中梅林'}

FEATURES = {
    'vote': [
        ('abn', '異常票（在隊上投黑＝內黑、不在隊上投白＝外白）', lambda d, w: 1.0 if d[w] != d['on'] else 0.0),
    ],
    'team': [
        ('self', '派自己', tf('hasSelf')),
        ('known', '隊上有自己認得的紅方', lambda d, w: 1.0 if d[w]['knownRedOthers'] > 0 else 0.0),
        ('thumb', '隊上有拇指（派西維爾）', lambda d, w: 1.0 if d[w]['thumbOthers'] > 0 else 0.0),
        ('thumb2', '兩個拇指都派（派西維爾）', lambda d, w: 1.0 if d[w]['thumbOthers'] > 1 else 0.0),
        ('failed', '隊上有出過失敗任務的別人', lambda d, w: 1.0 if d[w]['failedOthers'] > 0 else 0.0),
        ('keep', '留下最近一支成功的隊', lambda d, w: None if d[w]['keepsLastSuccess'] is None else (1.0 if d[w]['keepsLastSuccess'] else 0.0)),
        ('clean', '隊上沒有紅方（事後看）', lambda d, w: 1.0 if d[w]['reds'] == 0 else 0.0),
        ('reds2', '隊上有 2 個以上紅方（事後看）', lambda d, w: 1.0 if d[w]['reds'] >= 2 else 0.0),
        ('merlinOn', '隊上有梅林（事後看）', lambda d, w: 1.0 if 'merlin' in d[w]['roles'] else 0.0),
    ],
    'lake': [
        ('red', '驗到紅方（事後看）', tf('red')),
        ('known', '驗自己認得的紅方', tf('knownRed')),
        ('thumb', '驗拇指（派西維爾）', tf('thumb')),
        ('mFailed', '驗出過失敗任務的人', lambda d, w: 1.0 if d[w]['missions'] == 'failed' else 0.0),
        ('mSucc', '驗只出過成功任務的人', lambda d, w: 1.0 if d[w]['missions'] == 'successOnly' else 0.0),
        ('mNone', '驗沒出過任務的人', lambda d, w: 1.0 if d[w]['missions'] == 'none' else 0.0),
        ('next', '驗隔壁（上一家或下一家）', lambda d, w: 1.0 if d[w]['ring'] == 1 else 0.0),
        ('merlin', '驗到梅林（事後看）', lambda d, w: 1.0 if d[w]['role'] == 'merlin' else 0.0),
    ],
    'claim': [
        ('truth', '照實宣告', lambda d, w: None if d[w] == 'none' else (1.0 if (d[w] == 'evil') == d['tred'] else 0.0)),
        ('sayRed', '宣告是紅方', lambda d, w: None if d[w] == 'none' else (1.0 if d[w] == 'evil' else 0.0)),
    ],
    'quest': [
        ('fail', '出失敗', lambda d, w: d[w]),
    ],
    'kill': [
        ('merlin', '刺中梅林', lambda d, w: 1.0 if d[w]['role'] == 'merlin' else 0.0),
        ('percival', '刺到派西維爾', lambda d, w: 1.0 if d[w]['role'] == 'percival' else 0.0),
        ('loyal', '刺到忠臣', lambda d, w: 1.0 if d[w]['role'] == 'loyal' else 0.0),
        ('noFail', '刺沒出過失敗任務的人', lambda d, w: 1.0 if d[w]['failedMissions'] == 0 else 0.0),
        ('succ2', '刺出過 2 次以上成功任務的人', lambda d, w: 1.0 if d[w]['successMissions'] >= 2 else 0.0),
        ('led', '刺派出過成功任務的隊長', lambda d, w: 1.0 if d[w]['ledSuccess'] > 0 else 0.0),
        ('ib', '刺投過內黑的人', lambda d, w: 1.0 if d[w]['innerBlack'] > 0 else 0.0),
        ('ow', '刺投過外白的人', lambda d, w: 1.0 if d[w]['outerWhite'] > 0 else 0.0),
        ('lakeGood', '刺被湖中宣告是藍方的人', lambda d, w: 1.0 if d[w]['lakeClaimed'] == 'good' else 0.0),
        ('lakeHeld', '刺持過湖的人', lambda d, w: 1.0 if d[w]['heldLake'] else 0.0),
    ],
}
FEATURE_ROLES = {'thumb': {'percival'}, 'thumb2': {'percival'}, 'known': {'merlin', 'assassin', 'morgana', 'mordred'}}


def features_for(role, cat):
    out = []
    for key, zh, f in FEATURES[cat]:
        if cat in ('team', 'lake') and key in FEATURE_ROLES and role not in FEATURE_ROLES[key]:
            continue
        if cat == 'lake' and key == 'merlin' and role not in RED:
            continue
        if cat == 'team' and key == 'merlinOn' and role not in RED:
            continue
        out.append((key, zh, f))
    return out


# ══ 格子（局面怎麼分）══════════════════════════════════════
def score_zh(d):
    return f"藍{d['bw']}：紅{d['rw']}"


def cells_for(role, cat):
    """回傳 [(代號, 中文, 篩選函式, 是不是用了事後真相)]。第一個永遠是「全部」。"""
    red = role in RED
    out = [('all', '全部', lambda d: True, False)]
    if cat == 'vote':
        for rd in range(1, 6):
            for on in (True, False):
                pos_zh = '在隊上' if on else '不在隊上'
                out.append((f'r{rd}.{"on" if on else "off"}', f'第{rd}局・{pos_zh}', lambda d, rd=rd, on=on: d['rd'] == rd and d['on'] == on, False))
                if not on:
                    out.append((f'r{rd}.off.a4', f'第{rd}局・不在隊上・第4次提議', lambda d, rd=rd: d['rd'] == rd and not d['on'] and d['at'] == 4, False))
                for dg in (True, False):
                    dz = ('危險的隊' if dg else '安全的隊') if not red else ('紅方人數夠的隊' if dg else '紅方人數不夠的隊')
                    out.append((f'r{rd}.{"on" if on else "off"}.{"d" if dg else "s"}', f'第{rd}局・{pos_zh}・{dz}',
                                lambda d, rd=rd, on=on, dg=dg: d['rd'] == rd and d['on'] == on and d['danger'] == dg, True))
        for rd, bw, rw in ((3, 2, 0), (3, 1, 1), (3, 0, 2), (4, 2, 1), (4, 1, 2)):
            for on in (True, False):
                out.append((f'r{rd}.{"on" if on else "off"}.{bw}{rw}', f'第{rd}局（藍{bw}：紅{rw}）・{"在隊上" if on else "不在隊上"}',
                            lambda d, rd=rd, on=on, bw=bw, rw=rw: d['rd'] == rd and d['on'] == on and d['bw'] == bw and d['rw'] == rw, False))
        if role in ('merlin', 'assassin', 'morgana', 'mordred'):
            who = '認得的紅方' if role == 'merlin' else '紅方隊友'
            for band, bz, lo, hi in (('e', '第1～2局', 1, 2), ('l', '第3～5局', 3, 5)):
                for on in (True, False):
                    for kn in (True, False):
                        out.append((f'{band}.{"on" if on else "off"}.k{int(kn)}', f'{bz}・{"在隊上" if on else "不在隊上"}・隊上{"有" if kn else "沒有"}{who}',
                                    lambda d, lo=lo, hi=hi, on=on, kn=kn: lo <= d['rd'] <= hi and d['on'] == on and (d['known'] > 0) == kn, False))
        if role == 'percival':
            for band, bz, lo, hi in (('e', '第1～2局', 1, 2), ('l', '第3～5局', 3, 5)):
                for on in (True, False):
                    for th in (0, 1, 2):
                        out.append((f'{band}.{"on" if on else "off"}.t{th}', f'{bz}・{"在隊上" if on else "不在隊上"}・隊上有 {th} 個拇指',
                                    lambda d, lo=lo, hi=hi, on=on, th=th: lo <= d['rd'] <= hi and d['on'] == on and d['thumbs'] == th, False))
    elif cat == 'team':
        for rd in range(1, 6):
            out.append((f'r{rd}', f'第{rd}局', lambda d, rd=rd: d['rd'] == rd, False))
        for rd, bw, rw in ((2, 1, 0), (2, 0, 1), (3, 2, 0), (3, 1, 1), (3, 0, 2), (4, 2, 1), (4, 1, 2), (5, 2, 2)):
            out.append((f'r{rd}.{bw}{rw}', f'第{rd}局（藍{bw}：紅{rw}）', lambda d, rd=rd, bw=bw, rw=rw: d['rd'] == rd and d['bw'] == bw and d['rw'] == rw, False))
        out.append(('a1', '第1次提議', lambda d: d['at'] == 1, False))
        out.append(('a4', '第4～5次提議', lambda d: d['at'] >= 4, False))
    elif cat == 'lake':
        for rd in (2, 3, 4):
            out.append((f'after{rd}', f'第{rd}局之後', lambda d, rd=rd: d['rd'] == rd, False))
        out.append(('red<2', '紅方還沒兩勝', lambda d: d['rw'] < 2, False))
        out.append(('red2', '紅方已兩勝', lambda d: d['rw'] >= 2, False))
    elif cat == 'claim':
        out.append(('tBlue', '驗到藍方', lambda d: not d['tred'], True))
        out.append(('tRed', '驗到紅方', lambda d: d['tred'], True))
        if red and role != 'oberon':
            out.append(('tAlly', '驗到認得的紅方隊友', lambda d: d['tred'] and d['tknown'], True))
            out.append(('tHidden', '驗到奧伯倫', lambda d: d['tred'] and not d['tknown'], True))
        if red:
            out.append(('tMerlin', '驗到梅林', lambda d: d['trole'] == 'merlin', True))
            out.append(('tPercival', '驗到派西維爾', lambda d: d['trole'] == 'percival', True))
            out.append(('tLoyal', '驗到忠臣', lambda d: d['trole'] == 'loyal', True))
    elif cat == 'quest':
        for rd in range(1, 6):
            out.append((f'r{rd}', f'第{rd}局', lambda d, rd=rd: d['rd'] == rd, False))
            for n in (1, 2, 3):
                out.append((f'r{rd}.n{n}', f'第{rd}局・隊上{"只有自己一個紅方" if n == 1 else f"有 {n} 個紅方" + ("以上" if n == 3 else "")}',
                            lambda d, rd=rd, n=n: d['rd'] == rd and (d['reds'] == n if n < 3 else d['reds'] >= 3), True))
        for rd, bw, rw in ((2, 1, 0), (2, 0, 1), (3, 2, 0), (3, 1, 1), (3, 0, 2), (4, 2, 1), (4, 1, 2)):
            out.append((f'r{rd}.{bw}{rw}', f'第{rd}局（藍{bw}：紅{rw}）', lambda d, rd=rd, bw=bw, rw=rw: d['rd'] == rd and d['bw'] == bw and d['rw'] == rw, False))
        out.append(('lead', '自己是隊長', lambda d: d['lead'], False))
        if role != 'oberon':
            out.append(('ally', '隊上有認得的紅方隊友', lambda d: d['known'] > 0, False))
            out.append(('solo', '隊上沒有認得的紅方隊友', lambda d: d['known'] == 0, False))
    elif cat == 'kill':
        for rw in (0, 1, 2):
            out.append((f'red{rw}', f'三藍、紅方 {rw} 勝', lambda d, rw=rw: d['rw'] == rw, False))
    return out


# ══ 算每一格 ═════════════════════════════════════════════
MIN_N = {'vote': 40, 'team': 30, 'quest': 25, 'lake': 15, 'claim': 12, 'kill': 15}
CELLS = []  # 匿名的合計


def measure(role, cat, cell, feat, xs_sel, xs_all):
    ckey, czh, cf, truth = cell
    fkey, fzh, f = feat
    sel = [d for d in xs_sel if cf(d)]
    if not sel:
        return None
    g = boot_gap(sel, lambda d: f(d, 'hu'), lambda d: f(d, 'bh'))
    if not g:
        return None
    al = [d for d in xs_all if cf(d)]
    r = {
        'role': role, 'cat': cat, 'cell': ckey, 'cellZh': czh, 'feature': fkey, 'featureZh': fzh, 'usesTruth': truth,
        'n': g['n'], 'games': g['games'], 'strong': g['a'], 'bot': g['b'], 'gap': g['gap'], 'lo': g['lo'], 'hi': g['hi'],
        'baseline': mean(f(d, 'ba') for d in sel), 'all': mean(f(d, 'hu') for d in al), 'allN': sum(1 for d in al if f(d, 'hu') is not None),
        'botAll': mean(f(d, 'bh') for d in al),
    }
    hind = boot_gap(sel, lambda d: good_of(d, 'hu'), lambda d: good_of(d, 'bh'))
    if hind:
        r['good'] = {'strong': hind['a'], 'bot': hind['b'], 'gap': hind['gap'], 'lo': hind['lo'], 'hi': hind['hi'],
                     'baseline': mean(good_of(d, 'ba') for d in sel), 'zh': GOOD_ZH.get((cat, role in RED), '')}
    wr = wr_choice(al, lambda d: f(d, 'hu'))
    if wr:
        r['wr'] = wr
    r['verdict'], r['verdictZh'] = verdict(r)
    seats = ROLE_SEATS[role]['sel'] or 1
    r['per100'] = 100 * r['n'] * abs(r['gap']) / 100 / seats
    r['fine'] = fine_cell(cat, ckey)
    return r


def fine_cell(cat, key):
    """這一格有沒有把比數（或事後的真相）固定住。沒固定的格子混了不同的局勢（落後的局本來就比較常做某些事），勝率那把尺不能用。"""
    import re
    if cat == 'vote':
        return bool(re.match(r'^r[15]\.', key) or re.match(r'^r\d\.(on|off)\.(d|s|\d\d)$', key))
    if cat in ('team', 'quest'):
        return bool(re.match(r'^r[15]$', key) or re.match(r'^r\d\.\d\d$', key))
    if cat == 'lake':
        return key in ('red<2', 'red2')
    if cat == 'claim':
        return key != 'all'
    return False


def verdict(r):
    """W 真人強者比較好（可能是弱點）／B 百科AI 比較好／S 做法不同、看不出誰好／= 差不多。"""
    if not sig(r):
        return '=', '差不多'
    fine = fine_cell(r['cat'], r['cell'])
    if r['cat'] == 'lake' and r['feature'] == 'red' and r['role'] not in RED and r['cell'] == 'red2':
        # 紅方已兩勝：湖是用來抓紅的，驗到紅方就是比較好。
        return ('W', '真人強者比較常驗到紅方') if r['gap'] > 0 else ('B', '百科AI 比較常驗到紅方')
    feature_is_good = r['feature'] in ('clean',) and r['cat'] == 'team' and r['role'] not in RED
    if r['cat'] == 'kill':
        if r['feature'] != 'merlin':
            return 'S', '挑刺殺對象的方式不同'
        if r['role'] == 'merlin':
            return 'S', ('真人刺客比百科AI 刺客更抓得到這幾位梅林' if r['gap'] > 0 else '百科AI 刺客比真人刺客更抓得到這幾位梅林')
        return ('W', '真人強者刺得比較準') if r['gap'] > 0 else ('B', '百科AI 刺得比較準')
    gd = r.get('good')
    wr = r.get('wr')
    wr_sig = fine and bool(wr) and wr.get('d') is not None and wr.get('lo') is not None and (wr['lo'] > 0 or wr['hi'] < 0)
    if r['role'] == 'merlin' and r['cat'] == 'vote' and wr_sig:
        # 梅林的票不只看投對：還要不被刺客認出來，所以先看勝率（含被刺）。
        same_dir = (wr['d'] > 0) == (r['gap'] > 0)
        return ('W', '真人強者的做法勝率比較高（含被刺）') if same_dir else ('B', '百科AI 的做法勝率比較高（含被刺）')
    if gd and gd.get('lo') is not None and r['cat'] == 'vote':
        if gd['lo'] > 0:
            return 'W', '真人強者比較好（事後看）'
        if gd['hi'] < 0:
            return 'B', '百科AI 比較好（事後看）'
    if feature_is_good:
        return ('W', '真人強者的隊比較乾淨') if r['gap'] > 0 else ('B', '百科AI 的隊比較乾淨')
    if wr_sig:
        same_dir = (wr['d'] > 0) == (r['gap'] > 0)
        return ('W', '真人強者的做法勝率比較高') if same_dir else ('B', '百科AI 的做法勝率比較高')
    return 'S', '做法不同，看不出誰好'


RESULT = {}  # role → cat → {'same': {...}, 'rows': [...]}
for role in ROLES:
    RESULT[role] = {}
    for cat in CATS:
        xs_all = SPOTS.get((role, cat), [])
        xs_sel = [d for d in xs_all if d['sel']]
        if not xs_sel:
            continue
        same = {
            'n': sum(1 for d in xs_sel if d['sbh'] is not None), 'bot': mean(d['sbh'] for d in xs_sel), 'baseline': mean(d['sba'] for d in xs_sel),
            'allN': sum(1 for d in xs_all if d['sbh'] is not None), 'botAll': mean(d['sbh'] for d in xs_all), 'baselineAll': mean(d['sba'] for d in xs_all),
            'games': len({d['g'] for d in xs_sel}),
        }
        rows = []
        for cell in cells_for(role, cat):
            for feat in features_for(role, cat):
                r = measure(role, cat, cell, feat, xs_sel, xs_all)
                if r:
                    rows.append(r)
                    CELLS.append(r)
        RESULT[role][cat] = {'same': same, 'rows': rows}


def find(role, cat, cell, feature):
    for r in RESULT[role].get(cat, {}).get('rows', []):
        if r['cell'] == cell and r['feature'] == feature:
            return r
    return None


# 任務牌：同一支隊上有兩個以上紅方時，一共出了幾張失敗（真人 = 牌譜；百科AI = 每個紅方座位各自換成機器人的選擇加起來）。
def fail_count_table():
    by = defaultdict(list)
    for role in RED:
        for d in SPOTS.get((role, 'quest'), []):
            by[(d['g'], d['rd'])].append(d)
    out = defaultdict(lambda: {'n': 0, 'human': Counter(), 'bot': Counter(), 'baseline': Counter(), 'win': Counter()})
    for (g, rd), ds in by.items():
        reds = ds[0]['reds']
        if reds < 2 or len(ds) != reds:
            continue
        if rd == 4:
            where = '第4局（要 2 張失敗）'
        elif ds[0]['rw'] >= 2:
            where = '紅方已兩勝（第3、5局，1 張就贏）'
        else:
            where = f'第{rd}局（紅方還沒兩勝）'
        key = (where, min(reds, 3))
        t = out[key]
        t['win'][min(ds[0]['fails'], 3)] += ds[0]['win']
        t['n'] += 1
        t['human'][min(ds[0]['fails'], 3)] += 1
        t['bot'][min(int(sum(d['bh'] for d in ds)), 3)] += 1
        t['baseline'][min(int(sum(d['ba'] for d in ds)), 3)] += 1
    return out


FAILS = fail_count_table()

# ══ 報告積木（同 playerAgreementBreakdown.py）═══════════════════
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


class PB:
    """真人強者 vs 百科AI 的一對比例。"""

    def __init__(self, p, b):
        self.p, self.b = p, b

    def md(self):
        return '—' if self.p is None and self.b is None else f'{pct(self.p)} ／ {pct(self.b)}'

    def html(self):
        def bar(v, cls):
            return '' if v is None else f'<div class="bar {cls}"><i style="width:{max(0, min(100, v)):.0f}%"></i><b>{v:.1f}%</b></div>'
        return '—' if self.p is None and self.b is None else bar(self.p, 'p') + bar(self.b, 'b')


class Tag:
    """判讀的小標籤。"""

    def __init__(self, code, text):
        self.code, self.text = code, text

    def md(self):
        return {'W': '🔴 ', 'B': '🟢 ', 'S': '⚪ ', '=': ''}.get(self.code, '') + self.text

    def html(self):
        return f'<span class="tag g{ {"W": "w", "B": "b", "S": "s", "=": "e"}.get(self.code, "e") }">{html.escape(self.text)}</span>'


def small(n, cat):
    return '＊' if n < MIN_N[cat] else ''


def n_txt(r, cat):
    return f"{r['n']}{small(r['n'], cat)}"


def judge_cell(r):
    if r['verdict'] == '=':
        return Tag('=', r['verdictZh'])
    bits = []
    gd = r.get('good')
    wr = r.get('wr')
    if gd and gd.get('lo') is not None and r['cat'] == 'vote':
        bits.append(f"{gd['zh'].split('（')[0]} {pct(gd['strong'])} 對 {pct(gd['bot'])}{'' if sig(gd) else '（區間跨 0）'}")
    if wr and wr.get('d') is not None and r['cat'] != 'kill' and fine_cell(r['cat'], r['cell']):
        bits.append(f"全部真人這樣做的勝率 {pct(wr['wr1'])}（{wr['n1']} 次）、不這樣做 {pct(wr['wr0'])}（{wr['n0']} 次）{'' if (wr['lo'] > 0 or wr['hi'] < 0) else '（區間跨 0）'}")
    return Tag(r['verdict'], r['verdictZh'] + ('：' + '；'.join(bits) if bits else ''))


def std_row(label, r, cat):
    return [label, n_txt(r, cat), PB(r['strong'], r['bot']), pct(r['all']), pct(r['baseline']), ci_txt(r), judge_cell(r)]


STD_HEAD = ['', '次數', '真人強者 ／ 百科AI', '全部真人', '基準線', '強者 − 百科AI（95% 區間）', '誰比較好']


def rows_of(role, cat, keys, feature, label=None):
    out = []
    for ck in keys:
        r = find(role, cat, ck, feature)
        if r:
            out.append(std_row(label(r) if label else r['cellZh'], r, cat))
    return out


def player_names(role):
    return [r['player'] for r in SELECT[role]['rows'] if r['picked']]


# ── 選人表 ──
def selection_section():
    h(2, '怎麼選各角色的強者')
    ul([
        f'資料：網站戰績的真人局 {len(GAMES)} 局（百科AI 局、標記有問題的局、總庫的錯誤／重複局不算）。其中 {len(REPLAYED)} 局可以逐步重播，用來比決策；勝率用全部 {len(GAMES)} 局算。',
        f'候選：拿過這個角色至少 {MIN_ROLE_GAMES} 局（忠臣至少 {MIN_LOYAL_GAMES} 局）。每個特殊角色大約是一個人 1/10 的局，所以 {MIN_ROLE_GAMES} 局大約等於總共打過 300 局。',
        f'排序：這個角色的勝率，但先往「全部人拿這個角色的平均」拉近一點（等於多加 {SHRINK} 局平均表現），十幾局的好運不會排到前面。',
        f'門檻：整體勝率（照 6 藍 4 紅的發牌比例加權，拿到紅方的運氣不算）要在常客（總局數 ≥ {REGULAR_GAMES}，共 {len(REGULARS)} 位）的中位數 {MEDIAN:.1f}% 以上；角色勝率（拉近後）要高於全體平均。',
        f'每個角色取前 {TOP} 位，不足就有幾位算幾位。刺客另外列刺中率（全體平均 {HIT_MEAN:.1f}%），梅林另外列三藍時沒被刺中的比例（全體平均 {SAFE_MEAN:.1f}%）。',
    ])
    for role in ROLES:
        s = SELECT[role]
        h(3, f'{ROLE_ZH[role]}（全體平均勝率 {s["roleMeanPct"]:.1f}%；候選 {s["candidates"]} 位）')
        heads = ['玩家', '這個角色的局數', '角色勝率', '拉近後', '總局數', '整體勝率', '整體（6藍4紅加權）']
        if role == 'assassin':
            heads += ['刺殺次數', '刺中率']
        if role == 'merlin':
            heads += ['三藍局數', '沒被刺中']
        heads += ['']
        rows = []
        shown = [r for r in s['rows'] if r['picked']] + [r for r in s['rows'] if not r['picked']][:4]
        for r in shown:
            row = [r['player'], r['roleGames'], pct(r['roleWinPct']), pct(r['roleWinShrunk']), r['games'], pct(r['overallPct']), pct(r['overallStd'])]
            if role == 'assassin':
                row += [r['attempts'], pct(r['hitPct'])]
            if role == 'merlin':
                row += [r['threeBlue'], pct(r['safePct'])]
            why = '入選' if r['picked'] else ('整體勝率低於常客中位數' if not r['overallOk'] else ('角色勝率沒有高於平均' if not r['aboveMean'] else '名額已滿'))
            row.append(why)
            rows.append(row)
        table(heads, rows, '沒入選的只列排在最前面的 4 位，方便看差在哪裡。')


# ── 每個角色 ──
def role_section(role):
    red = role in RED
    seats = ROLE_SEATS[role]
    h(2, f'{ROLE_ZH[role]}')
    para(f'比的對象：{"、".join(player_names(role))}（{len(SEL[role])} 位）。他們拿{ROLE_ZH[role]}而且可以重播的座位 {seats["sel"]} 個；參考用的「全部真人」是所有人拿{ROLE_ZH[role]}的 {seats["all"]} 個座位。')
    # 相同比例
    rows = []
    for cat in CATS:
        c = RESULT[role].get(cat)
        if not c or not c['same']['n']:
            continue
        s = c['same']
        rows.append([f'{CAT_ZH[cat]}：{SAME_ZH[cat]}', f"{s['n']}{small(s['n'], cat)}", Bar(s['bot']), pct(s['baseline']), pct(s['botAll']), s['allN']])
    table(['和百科AI 做一樣的事的比例', '強者的決策點', '強者 × 百科AI', '強者 × 基準線', '全部真人 × 百科AI', '全部真人的決策點'], rows,
          '「刺殺」：紅方一起討論，所以每個紅方角色都算；百科AI = 機器人坐在刺客座位的選擇（梅林那一列 = 這幾位當梅林的局，真人刺客與機器人刺客刺的是不是同一個人）。「任務牌」只算牌譜看得出是誰出的那些。')
    leads = role_leads(role)
    if leads:
        h(3, f'{ROLE_ZH[role]}：差最多的地方（照「每 100 局差幾次」排）')
        table(['局面：比什麼', '真人強者 ／ 百科AI', '每 100 局差幾次', '次數', '誰比較好'],
              [[f"{CAT_ZH[r['cat']].split('（')[0] if r['cat'] != 'claim' else '湖中宣告'}｜{r['cellZh']}：{r['featureZh'].split('（')[0]}", PB(r['strong'], r['bot']), f"{r['per100']:.0f}", n_txt(r, r['cat']), judge_cell(r)] for r in leads[:12]],
              '只列區間不跨 0 的。紅色 = 真人強者比較好（可能是弱點）、綠色 = 百科AI 比較好、灰色 = 做法不同但看不出誰好。「每 100 局」= 每 100 個拿這個角色的座位。')
    for cat in CATS:
        c = RESULT[role].get(cat)
        if not c:
            continue
        CATEGORY[cat](role, c)
    per_player_table(role)


def per_player_table(role):
    rows = []
    for name, pid in [(r['player'], r['pid']) for r in SELECT[role]['rows'] if r['picked']]:
        row = [name]
        seats_ = set()
        for cat in CATS:
            xs = [d for d in SPOTS.get((role, cat), []) if d['pid'] == pid and d['sbh'] is not None]
            seats_ |= {(d['g'], d['seat']) for d in xs} if cat == 'vote' else set()
            row.append(f"{pct(mean(d['sbh'] for d in xs))}（{len(xs)}）" if xs else '—')
        row.insert(1, len(seats_))
        rows.append(row)
    if rows:
        h(3, f'{ROLE_ZH[role]}：每一位和百科AI 做一樣的事的比例')
        table(['玩家', '座位數'] + [SAME_ZH[c] for c in CATS], rows, '括號 = 決策點數。')


class Bar:
    def __init__(self, v):
        self.v = v

    def md(self):
        return pct(self.v)

    def html(self):
        return '—' if self.v is None else f'<div class="bar s"><i style="width:{max(0, min(100, self.v)):.0f}%"></i><b>{self.v:.1f}%</b></div>'


def role_leads(role, min_per100=3.0):
    out = []
    for cat in CATS:
        for r in RESULT[role].get(cat, {}).get('rows', []):
            if r['cell'] == 'all' and cat in ('vote',):
                continue
            if not sig(r) or r['n'] < MIN_N[cat]:
                continue
            if role == 'merlin' and cat == 'kill' and r['feature'] != 'merlin':
                continue  # 梅林那一欄的刺殺是「真人刺客 vs 機器人刺客」，挑對象的細節放在刺客那邊
            if r['per100'] < (min_per100 if cat in ('vote', 'team') else 1.0):
                continue
            out.append(r)
    out.sort(key=lambda r: -r['per100'])
    # 同一類決策、同一個特徵只留最大的三格，避免整張表都是同一件事。
    seen = Counter()
    kept = []
    for r in out:
        k = (r['cat'], r['feature'])
        if seen[k] >= 3:
            continue
        seen[k] += 1
        kept.append(r)
    return kept


def cat_lake(role, c):
    h(3, f'{ROLE_ZH[role]}・{CAT_ZH["lake"]}')
    feats = features_for(role, 'lake')
    rows = []
    for key, zh, _ in feats:
        r = find(role, 'lake', 'all', key)
        if r:
            rows.append(std_row(zh, r, 'lake'))
    table(STD_HEAD, rows, '湖中一場最多三次，次數少但每一次都很關鍵；＊ = 次數偏少，只能看方向。')
    rows = []
    for ck in ('red<2', 'red2'):
        for key in ('red', 'mFailed', 'mSucc', 'known', 'thumb'):
            r = find(role, 'lake', ck, key)
            if r:
                rows.append(std_row(f"{r['cellZh']}：{r['featureZh']}", r, 'lake'))
    for ck in ('after2', 'after3', 'after4'):
        for key in ('red', 'mFailed'):
            r = find(role, 'lake', ck, key)
            if r:
                rows.append(std_row(f"{r['cellZh']}：{r['featureZh']}", r, 'lake'))
    if rows:
        table(STD_HEAD, rows)


def cat_claim(role, c):
    h(3, f'{ROLE_ZH[role]}・{CAT_ZH["claim"]}')
    rows = []
    for ck in ('all', 'tBlue', 'tRed', 'tAlly', 'tHidden', 'tMerlin', 'tPercival', 'tLoyal'):
        r = find(role, 'claim', ck, 'truth')
        if r:
            rows.append(std_row(f"{r['cellZh']}：照實宣告", r, 'claim'))
    table(STD_HEAD, rows, '只算牌譜有記宣告的湖中。照實宣告 = 驗到紅說紅、驗到藍說藍。')


def cat_team(role, c):
    red = role in RED
    h(3, f'{ROLE_ZH[role]}・{CAT_ZH["team"]}')
    rows = []
    for key, zh, _ in features_for(role, 'team'):
        r = find(role, 'team', 'all', key)
        if r:
            rows.append(std_row(zh, r, 'team'))
    r = find(role, 'team', 'all', 'self')
    if r and r.get('good'):
        g = r['good']
        rows.append([g['zh'], n_txt(r, 'team'), PB(g['strong'], g['bot']), '—', pct(g['baseline']), ci_txt(g), Tag('W' if sig(g) and g['gap'] > 0 else ('B' if sig(g) else '='), '真人強者比較好' if sig(g) and g['gap'] > 0 else ('百科AI 比較好' if sig(g) else '差不多'))])
    table(STD_HEAD, rows, '當隊長的每一次提議（含被否決的）。')
    key = 'clean' if not red else 'known' if role != 'oberon' else 'reds2'
    rows = rows_of(role, 'team', ['r1', 'r2', 'r2.10', 'r2.01', 'r3', 'r3.20', 'r3.11', 'r3.02', 'r4', 'r4.21', 'r4.12', 'r5'], key)
    if rows:
        zh = dict((k, z) for k, z, _ in FEATURES['team'])[key]
        table([f'分局：{zh}'] + STD_HEAD[1:], rows)
    extra = {'merlin': 'known', 'percival': 'thumb'}.get(role)
    if extra:
        rows = rows_of(role, 'team', ['r1', 'r2', 'r3', 'r4', 'r5', 'a1', 'a4'], extra)
        if rows:
            table([f"分局：{dict((k, z) for k, z, _ in FEATURES['team'])[extra]}"] + STD_HEAD[1:], rows)
    if red:
        rows = rows_of(role, 'team', ['r1', 'r2', 'r3', 'r4', 'r5'], 'self')
        if rows:
            table(['分局：派自己'] + STD_HEAD[1:], rows)


def cat_vote(role, c):
    red = role in RED
    h(3, f'{ROLE_ZH[role]}・{CAT_ZH["vote"]}')
    rows = []
    for rd in range(1, 6):
        for pos_ in ('on', 'off'):
            r = find(role, 'vote', f'r{rd}.{pos_}', 'abn')
            if not r:
                continue
            label = f"第{rd}局・{'在隊上投黑（內黑）' if pos_ == 'on' else '不在隊上投白（外白）'}"
            row = std_row(label, r, 'vote')
            rows.append(row)
    table(STD_HEAD, rows, ('誰比較好：用事後的真相打分數——' + GOOD_ZH[('vote', red)] + '。只算第 1～4 次提議（第 5 次強制出隊沒有投票）。'))
    rows = []
    for rd in range(1, 6):
        for pos_ in ('on', 'off'):
            for dg in ('d', 's'):
                r = find(role, 'vote', f'r{rd}.{pos_}.{dg}', 'abn')
                if r and r['n'] >= MIN_N['vote'] and sig(r):
                    rows.append([r['cellZh'], n_txt(r, 'vote'), PB(r['strong'], r['bot']), pct(r['all']), pct(r['baseline']), ci_txt(r), judge_cell(r)])
    if rows:
        table(['照隊上實際的紅方分（事後看）：異常票率'] + STD_HEAD[1:], rows, '危險的隊 = 隊上的紅方人數夠讓任務失敗（第 4 局要 2 個）。只列差別明確的。')
    rows = []
    for rd, bw, rw in ((3, 2, 0), (3, 1, 1), (3, 0, 2), (4, 2, 1), (4, 1, 2)):
        for pos_ in ('on', 'off'):
            r = find(role, 'vote', f'r{rd}.{pos_}.{bw}{rw}', 'abn')
            if r and r['n'] >= 20:
                rows.append(std_row(r['cellZh'], r, 'vote'))
    if rows:
        table(['照比數分：異常票率'] + STD_HEAD[1:], rows)
    rows = []
    for band in ('e', 'l'):
        for pos_ in ('on', 'off'):
            for suffix in ('k1', 'k0', 't0', 't1', 't2'):
                r = find(role, 'vote', f'{band}.{pos_}.{suffix}', 'abn')
                if r and r['n'] >= 20:
                    rows.append(std_row(r['cellZh'], r, 'vote'))
    if rows:
        table(['照自己認得的人分：異常票率'] + STD_HEAD[1:], rows)


def cat_quest(role, c):
    h(3, f'{ROLE_ZH[role]}・{CAT_ZH["quest"]}')
    rows = []
    for ck in ['all', 'r1', 'r2', 'r3', 'r4', 'r5', 'lead', 'solo', 'ally']:
        r = find(role, 'quest', ck, 'fail')
        if r:
            rows.append(std_row(f"{r['cellZh']}：出失敗", r, 'quest'))
    table(STD_HEAD, rows, '隊上有兩個以上紅方、只出了一部分失敗時，牌譜看不出是誰出的：那幾張照「失敗張數 ÷ 隊上紅方人數」算真人的失敗率。')
    rows = []
    for rd in range(1, 6):
        for n in (1, 2, 3):
            r = find(role, 'quest', f'r{rd}.n{n}', 'fail')
            if r and r['n'] >= 10:
                rows.append(std_row(f"{r['cellZh']}：出失敗", r, 'quest'))
    if rows:
        table(['照隊上的紅方人數分'] + STD_HEAD[1:], rows)


def cat_kill(role, c):
    h(3, f'{ROLE_ZH[role]}・{CAT_ZH["kill"]}')
    rows = []
    for key, zh, _ in FEATURES['kill']:
        r = find(role, 'kill', 'all', key)
        if r and (role == 'assassin' or key in ('merlin', 'percival', 'loyal')):
            rows.append(std_row(zh if role != 'merlin' else zh.replace('刺中梅林', '被刺中'), r, 'kill'))
    for ck in ('red0', 'red1', 'red2'):
        r = find(role, 'kill', ck, 'merlin')
        if r:
            rows.append(std_row(f"{r['cellZh']}：{'刺中梅林' if role != 'merlin' else '被刺中'}", r, 'kill'))
    if role == 'assassin':
        note = '走到三藍的局。'
    elif role == 'merlin':
        note = '走到三藍的局。這裡反過來看：「真人強者」那一欄 = 當時的真人刺客刺的人，「百科AI」= 機器人坐在刺客座位會刺的人；兩邊抓的都是這幾位梅林。'
    else:
        note = f'走到三藍的局。{ROLE_ZH[role]}不是動手的人，但紅方一起討論：這裡是「強者拿{ROLE_ZH[role]}的那幾局」實際刺的人，對上機器人坐在刺客座位會刺的人。'
    table(STD_HEAD, rows, note)


CATEGORY = {'lake': cat_lake, 'claim': cat_claim, 'team': cat_team, 'vote': cat_vote, 'quest': cat_quest, 'kill': cat_kill}


def fails_section():
    h(2, '紅方一起出任務：一共出了幾張失敗')
    para('同一支隊上有兩個以上紅方的任務。真人 = 牌譜實際的失敗張數（全部真人）；百科AI = 把隊上每個紅方座位各自換成機器人，加起來會出幾張（機器人之間沒有互相看到對方的選擇，和真的一起打一樣）。')
    rows = []
    for key in sorted(FAILS, key=lambda k: (k[0], k[1])):
        t = FAILS[key]
        n = t['n']

        def dist(cn):
            return '／'.join(f'{100 * cn[k] / n:.0f}%' for k in range(0, key[1] + 1))
        wr = '／'.join((f"{100 * t['win'][k] / t['human'][k]:.0f}%" if t['human'][k] >= 10 else '—') for k in range(0, key[1] + 1))
        rows.append([f'{key[0]}・隊上 {key[1]} 個紅方{"以上" if key[1] == 3 else ""}', n, dist(t['human']), dist(t['bot']), dist(t['baseline']), wr])
    table(['局面', '任務數', '真人：0／1／2…張失敗', '百科AI', '基準線', '真人出 0／1／2…張時紅方的勝率'], rows,
          '第 4 局要 2 張失敗才算失敗；其他局 1 張就夠，多出的失敗只是多曝光一個紅方。紅方已兩勝時「每個相認的紅方都出失敗」是站長定的硬規則（redMatchPointFail）。勝率不到 10 次的不列。')


# 梅林的票和被刺中：三藍的局裡，梅林第 3～5 局的異常票和最後有沒有被刺中（全部真人）。
def merlin_vote_rows():
    kinds = [
        ('在隊上、隊上有認得的紅方 → 內黑', lambda d: d['on'] and d['known'] > 0),
        ('在隊上、隊上沒有認得的紅方 → 內黑', lambda d: d['on'] and d['known'] == 0),
        ('不在隊上、隊上有認得的紅方 → 外白', lambda d: not d['on'] and d['known'] > 0),
        ('不在隊上、隊上沒有認得的紅方 → 外白', lambda d: not d['on'] and d['known'] == 0),
    ]
    by = defaultdict(list)
    for d in SPOTS.get(('merlin', 'vote'), []):
        if d['rd'] >= 3 and GAMES[d['g']]['outcome'] != '三紅':
            by[(d['g'], d['seat'])].append(d)
    out = []
    for zh, f in kinds:
        t = {'never': [0, 0], 'did': [0, 0]}
        share_h = share_b = n = 0
        for (g, _), ds in by.items():
            xs = [d for d in ds if f(d)]
            if not xs:
                continue
            abn = sum(1 for d in xs if d['hu'] != d['on'])
            cell = t['never' if abn == 0 else 'did']
            cell[0] += 1
            cell[1] += GAMES[g]['outcome'] == '三藍死'
            share_h += abn / len(xs)
            share_b += sum(1 for d in xs if d['bh'] != d['on']) / len(xs)
            n += 1
        out.append({'kind': zh, 'games': n, 'humanShare': 100 * share_h / n if n else None, 'botShare': 100 * share_b / n if n else None,
                    'neverN': t['never'][0], 'neverHit': 100 * t['never'][1] / t['never'][0] if t['never'][0] else None,
                    'didN': t['did'][0], 'didHit': 100 * t['did'][1] / t['did'][0] if t['did'][0] else None})
    return out


MERLIN_VOTES = merlin_vote_rows()


def merlin_vote_section():
    h(2, '梅林的票和被刺中')
    para('只看走到三藍的局、全部真人梅林。每一局看梅林在第 3～5 局遇到這種提議時投了幾次異常票；「這樣投過」= 至少一次。右邊是那些局最後梅林被刺中的比例。這是相關，不是因果（紅方兩勝的局本來就比較常內黑、也比較容易被刺中），只當線索。')
    table(['梅林遇到的提議 → 異常票', '有這種提議的局', '真人平均這樣投的比例', '百科AI', '從沒這樣投：被刺中（局數）', '這樣投過：被刺中（局數）'],
          [[r['kind'], r['games'], pct(r['humanShare']), pct(r['botShare']), f"{pct(r['neverHit'])}（{r['neverN']}）", f"{pct(r['didHit'])}（{r['didN']}）"] for r in MERLIN_VOTES])


# ── 線索（匿名）──
def all_leads():
    out = []
    for role in ROLES:
        for r in role_leads(role):
            out.append(r)
    return out


def leads_md():
    L = []
    L.append('# 各角色的強者 × 百科AI：線索表（自動產生，匿名）')
    L.append('')
    L.append(f'資料：網站戰績的真人局 {len(GAMES)} 局，其中 {len(REPLAYED)} 局可以逐步重播。每個角色各選「該角色勝率高、整體勝率也在常客中位數以上」的前 {TOP} 位（匿名），'
             f'他們的每個決策點讓機器人坐在同一個座位、只看當時的公開紀錄＋自己角色的資訊再做一次。百科AI = 真人桌策略層；程式 {META.get("gitSha", "")[:10]}。')
    L.append('')
    L.append('| 角色 | 入選人數 | 座位數 | ' + ' | '.join(SAME_ZH[c] for c in CATS) + ' |')
    L.append('|---|---|---|' + '---|' * len(CATS))
    for role in ROLES:
        cells = []
        for cat in CATS:
            c = RESULT[role].get(cat)
            cells.append(f"{pct(c['same']['bot'])}（{c['same']['n']}）" if c and c['same']['n'] else '—')
        L.append(f"| {ROLE_ZH[role]} | {len(SEL[role])} | {ROLE_SEATS[role]['sel']} | " + ' | '.join(cells) + ' |')
    L.append('')
    L.append('（格子裡 = 和百科AI 做一樣的事的比例（決策點數）。）')
    L.append('')
    for role in ROLES:
        leads = role_leads(role)
        L.append(f'## {ROLE_ZH[role]}')
        L.append('')
        if not leads:
            L.append('沒有區間不跨 0 的差別。')
            L.append('')
            continue
        L.append('| 局面 | 比什麼 | 次數 | 真人強者 | 百科AI | 基準線 | 全部真人 | 強者 − 百科AI（95% 區間） | 每 100 局差幾次 | 誰比較好 |')
        L.append('|---|---|---|---|---|---|---|---|---|---|')
        for r in leads[:14]:
            L.append(f"| {CAT_ZH[r['cat']]}｜{r['cellZh']} | {r['featureZh']} | {r['n']} | {pct(r['strong'])} | {pct(r['bot'])} | {pct(r['baseline'])} | {pct(r['all'])} | {ci_txt(r)} | {r['per100']:.0f} | {judge_cell(r).md()} |")
        L.append('')
    return '\n'.join(L)


# ══ 組報告 ═══════════════════════════════════════════════
h(1, '各角色的強者 × 百科AI：每個決策點的相同／不同')
para(f'產生：{META.get("generatedAt", "")[:10]}｜百科AI 程式 {META.get("gitSha", "")[:10]}{opts.get("code-note", "")}｜真人局 {len(GAMES)} 局（可重播 {len(REPLAYED)} 局）。'
     '做法同忠臣那一份：機器人坐在玩家的座位、只看當時的公開紀錄＋自己角色的資訊，每個決策點獨立比。百科AI = 真人桌會用的策略層；「基準線」= 自我對打量的那一套。')
notes = opts.get('notes')
if notes and os.path.exists(os.path.join(notes, 'conclusion.md')):
    h(2, '結論')
    rawmd(open(os.path.join(notes, 'conclusion.md'), encoding='utf8').read().strip())
h(2, '總表：和百科AI 做一樣的事的比例')
rows = []
for role in ROLES:
    row = [f'{ROLE_ZH[role]}（{len(SEL[role])} 位、{ROLE_SEATS[role]["sel"]} 個座位）']
    for cat in CATS:
        c = RESULT[role].get(cat)
        row.append(Bar(c['same']['bot']) if c and c['same']['n'] else '—')
    rows.append(row)
table(['角色'] + [SAME_ZH[c] for c in CATS], rows, '黑白球投票大部分是「在隊上投白、不在隊上投黑」的正常票，所以相同比例本來就高；要看各角色段落裡的異常票。')
for role in ROLES:
    role_section(role)
fails_section()
merlin_vote_section()
selection_section()
h(2, '做法與限制')
ul([
    '每個決策點獨立重播：機器人沒有參與之前的局面，之後也照真人的牌譜走。量的是「同一個局面會不會做一樣的事」，不是「換成機器人打這一局會不會贏」。',
    '站長 2026-11-25：玩家除了發言以外，沒有機器人看不到的資訊；所以和強者的差別就是決策的差別。發言（誰說了什麼）牌譜沒有，機器人也讀不到。',
    '「誰比較好」有兩把尺：事後看（用牌譜的真相打分數）；或全部真人在同一格做 A、做 B 的勝率（相關，不是因果：會選 A 的人可能本來就比較強）。勝率那把尺只用在比數（或事後的真相）已經固定的格子，不然落後的局本來就比較常做某些事，會看錯方向。兩把尺都分不出來的列「做法不同，看不出誰好」。',
    '區間 = 以局為單位重抽 1000 次的 95% 區間。表很多，單一格子的差別有些只是巧合；次數少的（＊）只能看方向。湖中一場最多三次，但每次都關鍵，次數少也照列。',
    '投票的牌譜只記異常票（內黑、外白），其餘都當正常票；只算票數對得上結果的提議。任務牌：兩個以上紅方只出一部分失敗時看不出是誰出的，照比例算。',
    '強者的選法見〈怎麼選各角色的強者〉；每個角色的人不一樣，同一個人可以在好幾個角色入選。',
])
if notes and os.path.exists(os.path.join(notes, 'method_extra.md')):
    rawmd(open(os.path.join(notes, 'method_extra.md'), encoding='utf8').read().strip())


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


def md_table_html(lines):
    rows = [[c.strip() for c in ln.strip().strip('|').split('|')] for ln in lines]
    head, body = rows[0], rows[2:]
    if head[0] == '#' and len(head) >= 5:
        # 排名表（# ｜角色｜局面｜真人強者｜百科AI｜其他欄…）：手機上一列一張卡片比較好讀。
        out = []
        for r in body:
            rest = ''.join(f'<p><b>{inline_html(hd)}</b>{inline_html(v)}</p>' for hd, v in zip(head[5:], r[5:]))
            out.append(f'<div class="card"><div class="ct"><b>{inline_html(r[0])}</b>{inline_html(r[1])}｜{inline_html(r[2])}</div>'
                       f'<div class="cv"><span class="hp">{inline_html(head[3])} {inline_html(r[3])}</span><span class="hb">{inline_html(head[4])} {inline_html(r[4])}</span></div>{rest}</div>')
        return '\n'.join(out)
    return ('<div class="tw"><table><thead><tr>' + ''.join(f'<th>{inline_html(x)}</th>' for x in head) + '</tr></thead><tbody>'
            + ''.join('<tr>' + ''.join(f'<td>{inline_html(x)}</td>' for x in r) + '</tr>' for r in body) + '</tbody></table></div>')


def md_to_html(text):
    out, lst, tbl = [], False, []
    for line in text.split('\n') + ['']:
        if line.startswith('|'):
            tbl.append(line)
            continue
        if tbl:
            out.append(md_table_html(tbl))
            tbl = []
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
    return '\n'.join(out)


md, ht = [], []
toc = []
for b in blocks:
    if b[0] == 'h':
        md += ['#' * b[1] + ' ' + b[2], '']
        if b[1] == 2:
            toc.append(b[2])
            ht.append(f'<h2 id="s{len(toc)}">{html.escape(b[2])}</h2>')
        else:
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
        ht.append('<div class="tw"><table><thead><tr>' + ''.join(f'<th>{html.escape(str(x))}</th>' for x in heads) + '</tr></thead><tbody>'
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
a{color:#8ab8e6}
.note{color:#9aa4b2;font-size:13px}
.toc{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.toc a{padding:4px 10px;background:#1a2029;border:1px solid #2a3340;border-radius:14px;text-decoration:none;font-size:13.5px}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:#b8c0cc;margin:6px 0 2px}
.legend span::before{content:"";display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.legend .lp::before{background:#4f9dde}.legend .lb::before{background:#e0a43a}.legend .ls::before{background:#5fb37a}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:8px 0;border:1px solid #262d38;border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{padding:6px 8px;border-bottom:1px solid #222935;text-align:left;vertical-align:middle;white-space:nowrap}
td:first-child,th:first-child{white-space:normal;min-width:150px;position:sticky;left:0;background:#12161c}
td:last-child{white-space:normal;min-width:170px}
th{background:#171c24;color:#b8c0cc;font-weight:600;white-space:normal;min-width:74px}
tbody tr:nth-child(even) td{background:#12161c}
.bar{position:relative;height:17px;min-width:110px;background:#1c222c;border-radius:3px;margin:2px 0;overflow:hidden}
.bar i{position:absolute;left:0;top:0;bottom:0;border-radius:3px}
.bar b{position:relative;font-weight:500;font-size:12px;line-height:17px;padding-left:6px;color:#fff;text-shadow:0 0 3px #000}
.bar.p i{background:#2f6fa8}.bar.b i{background:#a87420}.bar.s i{background:#3c7f55}
.card{border:1px solid #262d38;border-radius:8px;padding:10px 12px;margin:10px 0;background:#12161c}
.ct{font-weight:600;font-size:15px;line-height:1.5}
.ct b{display:inline-block;min-width:24px;height:24px;line-height:24px;text-align:center;border-radius:12px;background:#e0a43a;color:#111;margin-right:8px;font-size:13px}
.cv{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.cv span{padding:3px 10px;border-radius:4px;font-size:13.5px}
.hp{background:#1d3f5e}.hb{background:#5c4215}
.card p{margin:4px 0;font-size:13.5px;color:#c9d1dc}
.card p b{color:#8f9aab;font-weight:600;margin-right:8px}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12.5px;line-height:1.5;white-space:normal}
.tag.gw{background:#5a2226;color:#ffc9cc;border:1px solid #8a3338}.tag.gb{background:#1f4a30;color:#c4efd2;border:1px solid #2f7048}
.tag.gs{background:#2a3038;color:#c9d1dc;border:1px solid #3a4350}.tag.ge{background:transparent;color:#8791a0}
"""
toc_html = '<nav class="toc">' + ''.join(f'<a href="#s{k + 1}">{html.escape(t)}</a>' for k, t in enumerate(toc)) + '</nav>'
page = ('<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>各角色的強者 × 百科AI</title><style>' + CSS + '</style></head><body><main>'
        + ht[0] + ht[1] + toc_html + '<div class="legend"><span class="lp">真人強者</span><span class="lb">百科AI</span><span class="ls">相同%</span></div>'
        + '\n'.join(ht[2:]) + '</main></body></html>')
open(os.path.join(OUT, 'report.html'), 'w', encoding='utf8').write(page)


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [clean(v) for v in o]
    if isinstance(o, (float, np.floating)):
        return round(float(o), 3)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.bool_,)):
        return bool(o)
    return o


# 公開的檔案只放人數，不放每一位的局數與勝率（對得回是誰）。
ANON_SELECT = {role: {'minGames': s['minGames'], 'candidates': s['candidates'], 'roleMeanPct': s['roleMeanPct'], 'picked': len(SEL[role])} for role, s in SELECT.items()}
public = {
    'meta': {**META, 'games': len(GAMES), 'replayed': len(REPLAYED), 'top': TOP, 'minRoleGames': MIN_ROLE_GAMES, 'minLoyalGames': MIN_LOYAL_GAMES,
             'regularGames': REGULAR_GAMES, 'regulars': len(REGULARS), 'overallMedian': MEDIAN, 'shrink': SHRINK, 'hitMean': HIT_MEAN, 'merlinSafeMean': SAFE_MEAN},
    'seats': ROLE_SEATS,
    'same': {role: {cat: RESULT[role][cat]['same'] for cat in RESULT[role]} for role in ROLES},
    'cells': CELLS,
    'failCounts': [{'cell': k[0], 'reds': k[1], 'n': v['n'], 'human': dict(v['human']), 'bot': dict(v['bot']), 'baseline': dict(v['baseline']), 'redWinsByHumanFails': dict(v['win'])} for k, v in sorted(FAILS.items())],
    'merlinVotes': MERLIN_VOTES,
    'selection': ANON_SELECT,
}
json.dump(clean(public), open(os.path.join(OUT, 'cells.json'), 'w', encoding='utf8'), ensure_ascii=False, separators=(',', ':'))


def slim(r):
    o = {'role': r['role'], 'cat': r['cat'], 'cell': r['cellZh'], 'feature': r['featureZh'].split('（')[0], 'n': r['n'], 'verdict': r['verdict']}
    for k in ('strong', 'bot', 'baseline', 'all', 'gap', 'lo', 'hi', 'per100'):
        o[k] = None if r.get(k) is None else round(float(r[k]), 1)
    if r.get('good') and r['cat'] == 'vote':
        o['goodStrong'], o['goodBot'] = round(float(r['good']['strong']), 1), round(float(r['good']['bot']), 1)
    if r.get('wr') and r['wr'].get('d') is not None and r.get('fine'):
        o['wr'] = [round(float(r['wr']['wr1']), 1), int(r['wr']['n1']), round(float(r['wr']['wr0']), 1), int(r['wr']['n0'])]
    return o


# 可以放進 repo 的小檔：次數夠、區間不跨 0 的格子（以及每一類的「全部」）。
json.dump({'meta': public['meta'], 'seats': ROLE_SEATS, 'same': clean(public['same']), 'failCounts': public['failCounts'], 'merlinVotes': clean(MERLIN_VOTES),
           'cells': [slim(r) for r in CELLS if r['n'] >= MIN_N[r['cat']] and (sig(r) or r['cell'] == 'all')]},
          open(os.path.join(OUT, 'cells.public.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=0)
json.dump(clean({**public, 'selectionNamed': SELECT, 'selected': {role: player_names(role) for role in ROLES}}),
          open(os.path.join(OUT, 'data.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=1)
open(os.path.join(OUT, 'leads.md'), 'w', encoding='utf8').write(leads_md())
print('wrote', OUT, {role: (len(SEL[role]), ROLE_SEATS[role]['sel']) for role in ROLES})
