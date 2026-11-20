"""百科文章裡的牌譜數字，每晚從數據分析頁的同一份逐局資料重算（站長 2026-11-20）。

站長 2026-11-20：「所有跟數字統計有關的 都應該跟資料庫連動 而不是寫死」、「我說了要跟數據分析還有勝率統計那邊
同步啊 整個系統要完全同步同來源」。

百科文章（packages/server/wiki_data.json 與 docs/avalon-wiki 的 Markdown 副本）裡，凡是從牌譜算出來的數字都放在
標記裡，內容由這支程式產生：

    <!-- stat:wiki40.outcomes -->
    （這裡的表格或句子由 wiki_stats.py 寫，手改會被下一次重算蓋掉）
    <!-- /stat -->

標記可以單獨一行（包住整個表格），也可以在一行裡（包住一句話）。網站、llms.txt 顯示文章時會拿掉 HTML 註解
（wikiMarkup.stripHtmlComments），讀者只看到內容；觀念卡的來源雜湊不看標記裡的內容（conceptSource.ts），
數字每晚變動不會讓觀念卡變成待複查。

來源與口徑跟數據分析頁不篩選時完全相同：games_cache.json（generate_cache.py 每晚寫，ProAvalon 不在裡面），
解碼用 generate_cache.decode_games_dataset，百科AI 局（分類「百科AI」）不算（dataset.ts 的預設）。
勝負定義：好人勝＝三藍活；三藍死與三紅算紅方勝。

    python packages/server/wiki_stats.py            # 改寫有變動的檔
    python packages/server/wiki_stats.py --check    # 只檢查：有任何數字跟資料不一致就 exit 1（測試與 CI 用）
    python packages/server/wiki_stats.py --list     # 印出每個標記目前的內容

每晚的 refresh-analysis-cache.yml 在 game_db.py 之後跑一次，有變動就跟快取一起 commit。
只印計數與標記名稱，不印玩家名字（資料集裡的名字這裡完全不用）。
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Callable, Iterable, Mapping

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
GAMES_PATH = HERE / "games_cache.json"
WIKI_PATH = HERE / "wiki_data.json"
DOCS_WIKI_DIR = REPO / "docs" / "avalon-wiki"

sys.path.insert(0, str(HERE))
import generate_cache as gc  # noqa: E402  (same directory; decode rules shared with the stats pages)

THREE_RED = gc.OUTCOME_THREE_RED
BLUE_DEAD = gc.OUTCOME_BLUE_DEAD
BLUE_ALIVE = gc.OUTCOME_BLUE_ALIVE
OUTCOMES = (THREE_RED, BLUE_DEAD, BLUE_ALIVE)
SEATS = gc.SEATS
FRONT_HALF = ("1", "2", "3", "4", "5")

# 標記：<!-- stat:KEY -->…<!-- /stat -->（非貪婪；內容可以跨行）。
STAT_SPAN_RE = re.compile(r"<!-- stat:([A-Za-z0-9_.-]+) -->(.*?)<!-- /stat -->", re.S)


# ─── 格式 ──────────────────────────────────────────────────────────────

def n(v: int) -> str:
    """2284 → 「2,284」。"""
    return f"{v:,}"


def pct(num: int, den: int) -> str:
    """一位小數的百分比；分母 0 →「—」。"""
    return f"{100 * num / den:.1f}%" if den else "—"


def table(header: list[str], rows: Iterable[list[str]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |"]
    lines += ["| " + " | ".join(r) + " |" for r in rows]
    return "\n".join(lines)


def seat_sort_key(s: str) -> int:
    return 10 if s == "0" else int(s)


# ─── 資料 ──────────────────────────────────────────────────────────────

class Data:
    """解碼後的人類局（不含百科AI）與常用的衍生值。"""

    def __init__(self, doc: Mapping) -> None:
        self.games = [g for g in gc.decode_games_dataset(doc) if g.category != gc.BOT_CATEGORY]
        dates = sorted(g.date for g in self.games if g.date)
        self.dated = len(dates)
        self.undated = len(self.games) - self.dated
        self.first_date = dates[0] if dates else ""
        self.last_date = dates[-1] if dates else ""
        self.from_sheet = sum(1 for g in self.games if g.source == 0)
        self.from_discord = len(self.games) - self.from_sheet

    @property
    def total(self) -> int:
        return len(self.games)

    def source_phrase(self) -> str:
        """「本站牌譜（數據分析頁同一份逐局資料，2,341 局，資料至 2026-11-18，每晚更新）」。"""
        return f"本站牌譜（數據分析頁同一份逐局資料，{n(self.total)} 局，資料至 {self.last_date}，每晚更新）"


def outcome_counts(games: Iterable) -> Counter:
    return Counter(g.outcome for g in games)


def mission_count(g) -> int:
    return sum(1 for r in g.rounds if r in ("紅", "藍"))


def decided(g) -> bool:
    """局勢完整：照順序紅／藍、某一方剛好在最後一局拿到第 3 局。"""
    seq = [r for r in g.rounds if r]
    if not seq or any(r not in ("紅", "藍") for r in seq):
        return False
    red = blue = 0
    for i, r in enumerate(seq):
        red += r == "紅"
        blue += r == "藍"
        if (red == 3 or blue == 3) and i != len(seq) - 1:
            return False
    return red == 3 or blue == 3


def year_of(g) -> str:
    return g.date[:4] if g.date else ""


def merlin_seat(g) -> str | None:
    return next((s for s, r in g.seat_roles.items() if r == "梅林"), None)


def faction_of(g, seat: str) -> str:
    role = g.seat_roles.get(seat, "")
    return "紅方" if role in gc.RED_ROLES else ("藍方" if role else "")


# ─── 文章的區塊 ────────────────────────────────────────────────────────

def wiki40_data(d: Data) -> str:
    cats = Counter(g.category for g in d.games)
    named = [c for c in ("線瓦", "面瓦", "娛樂") if cats.get(c)]
    other = d.total - sum(cats[c] for c in named)
    other_note = f"（另有 {n(other)} 局未分類或其他）" if other else ""
    return "\n".join([
        f"- 資料來源：數據分析頁使用的同一份逐局資料（games_cache.json，每晚從牌譜試算表與 Discord 群的牌譜彙整重算）："
        f"牌譜試算表 {n(d.from_sheet)} 局，加上 Discord 群的牌譜彙整 {n(d.from_discord)} 局，共 {n(d.total)} 局；"
        "每一局都有完整角色配置與結果；百科AI 參與的局不算（跟數據分析頁預設相同）",
        f"- 資料期間：{d.first_date}～{d.last_date}（{n(d.dated)} 局有日期；{n(d.undated)} 局日期不明）",
        f"- 全部是 10 人局；分類為{'、'.join(named)}{other_note}",
    ])


def wiki40_outcomes(d: Data) -> str:
    groups = [("全部", d.games)] + [(c, [g for g in d.games if g.category == c]) for c in ("線瓦", "面瓦", "娛樂")]
    rows = []
    for label, gs in groups:
        if not gs:
            continue
        c = outcome_counts(gs)
        total = len(gs)
        rows.append([label, n(total),
                     f"{n(c[BLUE_ALIVE])}（{pct(c[BLUE_ALIVE], total)}）",
                     f"{n(c[BLUE_DEAD])}（{pct(c[BLUE_DEAD], total)}）",
                     f"{n(c[THREE_RED])}（{pct(c[THREE_RED], total)}）",
                     pct(c[BLUE_DEAD], c[BLUE_DEAD] + c[BLUE_ALIVE])])
    c = outcome_counts(d.games)
    three_blue = c[BLUE_DEAD] + c[BLUE_ALIVE]
    return "\n".join([
        table(["分類", "局數", "三藍活（好人勝）", "三藍死", "三紅", "刺中率"], rows),
        "",
        f"- 好人勝率 {pct(c[BLUE_ALIVE], d.total)}，紅方勝率 {pct(c[THREE_RED] + c[BLUE_DEAD], d.total)}"
        f"（三紅 {pct(c[THREE_RED], d.total)}＋三藍死 {pct(c[BLUE_DEAD], d.total)}）。",
        f"- 打到三藍、進入刺殺的局：{n(three_blue)} 局（{pct(three_blue, d.total)}）。",
    ])


def wiki40_length(d: Data) -> str:
    by_len = Counter()
    incomplete = 0
    for g in d.games:
        if decided(g):
            by_len[mission_count(g)] += 1
        else:
            incomplete += 1
    labels = {3: "3 局", 4: "4 局（比分只可能是 3:1）", 5: "5 局"}
    rows = [[labels[k], n(by_len[k]), pct(by_len[k], d.total)] for k in (3, 4, 5)]
    rows.append(["局勢欄位不完整", n(incomplete), pct(incomplete, d.total)])
    states = Counter(g.game_state for g in d.games if decided(g))
    rrr, bbb = states.get("紅紅紅", 0), states.get("藍藍藍", 0)
    top = []
    for state, cnt in sorted(states.items(), key=lambda kv: (-kv[1], kv[0]))[:10]:
        oc = outcome_counts(g for g in d.games if g.game_state == state and decided(g))
        if oc[THREE_RED] == cnt:
            result = f"三紅 {n(cnt)}"
        else:
            result = "、".join(f"{name} {n(oc[name])}" for name in (BLUE_ALIVE, BLUE_DEAD, THREE_RED) if oc[name])
        top.append([state, n(cnt), result])
    return "\n".join([
        table(["打了幾局任務", "局數", "比例"], rows),
        "",
        f"- 3 局結束的 {n(by_len[3])} 局＝紅紅紅 {n(rrr)} 局＋藍藍藍 {n(bbb)} 局。",
        "",
        "**最常見的 10 種進程**",
        "",
        table(["進程", "局數", "結果"], top),
    ])


def wiki40_first(d: Data) -> str:
    rows = []
    for label, color in (("藍（任務成功）", "藍"), ("紅（任務失敗）", "紅")):
        gs = [g for g in d.games if g.rounds and g.rounds[0] == color]
        c = outcome_counts(gs)
        rows.append([label, n(len(gs))] + [pct(c[o], len(gs)) for o in (BLUE_ALIVE, BLUE_DEAD, THREE_RED)])
    return table(["第一局", "局數", "三藍活", "三藍死", "三紅"], rows)


def wiki40_fails(d: Data) -> str:
    sizes = {1: 3, 2: 4, 3: 4, 4: 5, 5: 5}
    rows = []
    missing3 = 0
    four_fail3 = consistent4 = 0
    one_fail4 = 0
    for rnd in range(1, 6):
        counts = Counter()
        played = 0
        for g in d.games:
            cell = g.round_results[rnd - 1] if len(g.round_results) >= rnd else ""
            if not cell:
                # 打到這一局（前面還沒分出勝負）卻沒有任務結果
                if rnd == 3 and len([r for r in g.round_results[:2] if r]) == 2:
                    missing3 += 1
                continue
            played += 1
            fails = gc.count_mission_fails(cell)
            counts[fails] += 1
            if rnd == 3 and fails == 4:
                four_fail3 += 1
                team = _mission_team(g, 3)
                if team is not None and sum(1 for s in team if faction_of(g, s) == "紅方") == 4:
                    consistent4 += 1
            if rnd == 4 and fails == 1:
                one_fail4 += 1
        cells = [n(counts[k]) if k <= sizes[rnd] else "—" for k in range(5)]
        rows.append([f"第 {rnd} 局", str(sizes[rnd])] + cells + [n(played)])
    lines = [table(["局", "出任務人數", "0 張", "1 張", "2 張", "3 張", "4 張", "局數"], rows), ""]
    if missing3:
        lines.append(f"- 第 3 局有 {n(missing3)} 局紀錄沒有任務結果。")
    if four_fail3:
        lines.append(f"- 第 3 局四張失敗的 {n(four_fail3)} 局，對照角色配置與出任務的隊伍，有 {n(consistent4)} 局確實是 4 個壞人都在隊上。")
    lines.append(f"- 第 4 局是保護局（要 2 張失敗才開紅），所以 1 張失敗的 {n(one_fail4)} 局任務仍然成功。")
    return "\n".join(lines)


def _mission_team(g, rnd: int) -> str | None:
    """那一局真的出任務的隊伍：該回合最後一次提議的隊伍。"""
    teams = [p[2] for p in g.voting_proposals if p[0] == rnd and p[2]]
    return teams[-1] if teams else None


def wiki40_merlin(d: Data) -> str:
    killed = Counter()
    total = Counter()
    for g in d.games:
        if g.outcome not in (BLUE_DEAD, BLUE_ALIVE):
            continue
        s = merlin_seat(g)
        if s is None:
            continue
        total[s] += 1
        killed[s] += g.outcome == BLUE_DEAD
    rows = [[s, n(total[s]), pct(killed[s], total[s])] for s in sorted(SEATS, key=seat_sort_key)]
    front_k = sum(killed[s] for s in FRONT_HALF)
    front_n = sum(total[s] for s in FRONT_HALF)
    back_k = sum(killed.values()) - front_k
    back_n = sum(total.values()) - front_n
    per_seat = round(sum(total.values()) / 10)
    return "\n".join([
        f"只看打到三藍的 {n(sum(total.values()))} 局。",
        "",
        table(["梅林座位", "局數", "被刺中比例"], rows),
        "",
        f"- 每個座位平均約 {n(per_seat)} 局；相鄰座位的差異多半在誤差範圍內（誤差怎麼估見"
        "[如何正確解讀阿瓦隆數據](wiki:wiki-209)）。"
        f"1～5 家整體（{pct(front_k, front_n)}）與 6～0 家（{pct(back_k, back_n)}）的差異，原因可能是座位、派票順序或玩家，資料分不出來。",
    ])


def wiki40_first_team(d: Data) -> str:
    teams = Counter()
    alive = Counter()
    recorded = 0
    out_wide = 0
    for g in d.games:
        if not g.r11_seats:
            continue
        recorded += 1
        key = "".join(sorted(g.r11_seats, key=seat_sort_key))
        teams[key] += 1
        alive[key] += g.outcome == BLUE_ALIVE
        if "1" not in g.r11_seats:
            out_wide += 1
    rows = [[k, n(c), pct(alive[k], c)] for k, c in sorted(teams.items(), key=lambda kv: (-kv[1], kv[0]))[:8]]
    lo = min(c for _, c in teams.most_common(8)) if teams else 0
    hi = max(teams.values()) if teams else 0
    return "\n".join([
        table(["1-1 組合", "局數", "三藍活比例"], rows),
        "",
        f"- 1-1 外灑（隊伍裡沒有 1 家）的有 {n(out_wide)} 局（{pct(out_wide, recorded)}，分母是有 1-1 紀錄的 {n(recorded)} 局）。",
        f"- 每個組合只有約 {n(lo)}～{n(hi)} 局，各組合的差異可能只是樣本波動，不要拿來選開局。",
    ])


def wiki40_years(d: Data) -> str:
    by_year: dict[str, list] = defaultdict(list)
    for g in d.games:
        by_year[year_of(g)].append(g)
    rows = []
    for y in sorted(k for k in by_year if k):
        gs = by_year[y]
        label = f"{y}（至 {d.last_date[5:]}）" if y == d.last_date[:4] else y
        if len(gs) < 10:
            rows.append([label, n(len(gs)), "—", "—", "—"])
            continue
        c = outcome_counts(gs)
        rows.append([label, n(len(gs))] + [pct(c[o], len(gs)) for o in (BLUE_ALIVE, BLUE_DEAD, THREE_RED)])
    if by_year.get(""):
        gs = by_year[""]
        c = outcome_counts(gs)
        rows.append(["日期不明", n(len(gs))] + [pct(c[o], len(gs)) for o in (BLUE_ALIVE, BLUE_DEAD, THREE_RED)])
    small = [y for y in sorted(k for k in by_year if k) if len(by_year[y]) < 100]
    lines = [table(["年份", "局數", "三藍活", "三藍死", "三紅"], rows), ""]
    if small:
        lines.append(f"- {'、'.join(small)} 年的局數不到 100 局，不要拿來比較（不到 10 局的年份不列比例）。")
    this_year = by_year.get(d.last_date[:4], [])
    if this_year:
        disc = sum(1 for g in this_year if g.source != 0)
        lines.append(f"- {d.last_date[:4]} 年的 {n(len(this_year))} 局裡有 {n(disc)} 局來自 Discord 群的牌譜彙整，"
                     "記錄來源跟前幾年不同，比較時要小心。")
    return "\n".join(lines)


def proposals_per_player(d: Data) -> str:
    counts = [len(g.voting_proposals) for g in d.games if g.voting_proposals]
    mean = statistics.fmean(counts) if counts else 0.0
    within = sum(1 for c in counts if 11 <= c <= 20)
    return (f"{d.source_phrase()}，一場平均 {mean:.1f} 次提議，換算每人約 {mean / 10:.1f} 次；"
            f"{pct(within, len(counts))} 的對局落在每人 1.1～2.0 次之間。")


def first_mission_fails(d: Data) -> str:
    parts = []
    red3 = []
    labels = {0: "0 張（`ooo`，{n} 局）", 1: "1 張（{n} 局）", 2: "2 張（`oxx`，{n} 局）"}
    for k in (0, 1, 2):
        gs = [g for g in d.games if g.round_results and g.round_results[0]
              and gc.count_mission_fails(g.round_results[0]) == k]
        c = outcome_counts(gs)
        parts.append(f"{labels[k].format(n=n(len(gs)))}{pct(c[THREE_RED] + c[BLUE_DEAD], len(gs))}")
        red3.append(pct(c[THREE_RED], len(gs)))
    return (f"{d.source_phrase()}，依第一局的失敗張數看紅方最終勝率（三紅＋三藍死）：{'；'.join(parts)}。"
            f"三紅率依序是 {'、'.join(red3)}。")


def seat1_win(d: Data) -> str:
    blue = [g for g in d.games if faction_of(g, "1") == "藍方"]
    red = [g for g in d.games if faction_of(g, "1") == "紅方"]
    c_all = outcome_counts(d.games)
    blue_win = sum(1 for g in blue if g.outcome == BLUE_ALIVE)
    red_win = sum(1 for g in red if g.outcome in (THREE_RED, BLUE_DEAD))
    return (f"1 號位勝率，{d.source_phrase()}：1 號位拿到藍方時，藍方勝率 {pct(blue_win, len(blue))}"
            f"（{n(len(blue))} 局；全體藍方勝率 {pct(c_all[BLUE_ALIVE], d.total)}）；"
            f"拿到紅方時，紅方勝率 {pct(red_win, len(red))}（{n(len(red))} 局；"
            f"全體紅方勝率 {pct(c_all[THREE_RED] + c_all[BLUE_DEAD], d.total)}）。")


def seat6_after_forced(d: Data) -> str:
    """第一局在 1-5 強制出任務、6 家不在隊上、三張成功：6 家在 2-1 的派法。"""
    kinds = ("三加一（含自己）", "拆車", "外灑三加一")
    groups: dict[str, Counter] = {"all": Counter(), "梅林": Counter(), "紅方": Counter(), "其他藍方": Counter()}
    for g in d.games:
        r1 = [p for p in g.voting_proposals if p[0] == 1]
        r2 = [p for p in g.voting_proposals if p[0] == 2]
        if not r1 or not r2 or r1[-1][1] != 5 or len(r1) != 5:
            continue
        team1 = r1[-1][2]
        if "6" in team1 or not g.round_results or g.round_results[0] != "ooo":
            continue
        first = r2[0]
        if first[1] != 1 or not first[2]:
            continue
        team2 = set(first[2])
        if not set(team1) <= team2:
            kind = kinds[1]
        elif "6" in team2:
            kind = kinds[0]
        else:
            kind = kinds[2]
        role = g.seat_roles.get("6", "")
        who = "梅林" if role == "梅林" else ("紅方" if role in gc.RED_ROLES else "其他藍方")
        groups["all"][kind] += 1
        groups[who][kind] += 1
    total = sum(groups["all"].values())

    def shares(c: Counter) -> list[str]:
        t = sum(c.values())
        return [pct(c[k], t) for k in kinds]

    s = shares(groups["all"])
    per_role = "；".join(f"{who}（{n(sum(groups[who].values()))} 局）{'／'.join(shares(groups[who]))}"
                         for who in ("梅林", "紅方", "其他藍方"))
    return (f"{d.source_phrase()}：第一局在 1-5 強制出任務、6 家不在隊上、結果三張成功的 {n(total)} 局裡，"
            f"6 家在 2-1 的派法是三加一（含自己）{s[0]}、拆車 {s[1]}、外灑三加一 {s[2]}。依 6 家的角色分：{per_role}。")


def off_team_approvals(d: Data) -> str:
    per_game_props = []
    per_game_votes = []
    for g in d.games:
        if not g.voting_proposals:
            continue
        props = votes = 0
        for rnd, attempt, team, approved in g.voting_proposals:
            if attempt >= 5 or not team:
                continue
            off = [s for s in approved if s not in team]
            if off:
                props += 1
                votes += len(off)
        per_game_props.append(props)
        per_game_votes.append(votes)
    def med(xs: list[int]) -> str:
        m = statistics.median(xs) if xs else 0
        return f"{m:g}"
    return (f"{d.source_phrase()}：一場遊戲平均有 {statistics.fmean(per_game_props):.1f} 次提議出現外白"
            f"（中位數 {med(per_game_props)} 次）；以外白的「票數」算，平均每場 {statistics.fmean(per_game_votes):.1f} 顆"
            f"（中位數 {med(per_game_votes)} 顆）。")


BLOCKS: dict[str, Callable[[Data], str]] = {
    "wiki40.data": wiki40_data,
    "wiki40.outcomes": wiki40_outcomes,
    "wiki40.length": wiki40_length,
    "wiki40.first": wiki40_first,
    "wiki40.fails": wiki40_fails,
    "wiki40.merlin": wiki40_merlin,
    "wiki40.firstTeam": wiki40_first_team,
    "wiki40.years": wiki40_years,
    "proposals.perPlayer": proposals_per_player,
    "firstMission.fails": first_mission_fails,
    "seat1.win": seat1_win,
    "seat6.afterForced": seat6_after_forced,
    "votes.offTeam": off_team_approvals,
}


# ─── 改寫 ─────────────────────────────────────────────────────────────

def render_all(d: Data) -> dict[str, str]:
    return {key: fn(d) for key, fn in BLOCKS.items()}


def fill(text: str, values: Mapping[str, str], where: str) -> str:
    """把 text 裡每個標記的內容換成 values[key]；單獨一行的標記（內容前後是換行）保留換行。"""
    def sub(m: re.Match) -> str:
        key, inner = m.group(1), m.group(2)
        if key not in values:
            raise SystemExit(f"{where}: unknown stat key {key!r} (known: {', '.join(sorted(values))})")
        body = values[key]
        if inner.startswith("\n"):
            return f"<!-- stat:{key} -->\n{body}\n<!-- /stat -->"
        if "\n" in body:
            raise SystemExit(f"{where}: stat {key!r} is multi-line; put its markers on their own lines")
        return f"<!-- stat:{key} -->{body}<!-- /stat -->"
    return STAT_SPAN_RE.sub(sub, text)


def docs_files() -> list[Path]:
    return sorted(p for p in DOCS_WIKI_DIR.rglob("*.md") if "<!-- stat:" in p.read_text(encoding="utf-8"))


def dump_wiki(articles: list, raw: str) -> str:
    """跟原檔同一個格式（indent 2、不轉義中文；結尾換行照原檔）。"""
    out = json.dumps(articles, ensure_ascii=False, indent=2)
    return out + "\n" if raw.endswith("\n") else out


def run(games_path: Path, wiki_path: Path, check: bool) -> list[str]:
    """改寫（或 check 時只比對）；回傳有變動的檔。"""
    d = Data(json.loads(games_path.read_text(encoding="utf-8")))
    values = render_all(d)
    changed: list[str] = []
    raw = wiki_path.read_text(encoding="utf-8")
    articles = json.loads(raw)
    for a in articles:
        a["content"] = fill(a["content"], values, f"{wiki_path.name}#{a.get('id')}")
    out = dump_wiki(articles, raw)
    if out != raw:
        changed.append(str(wiki_path))
        if not check:
            wiki_path.write_text(out, encoding="utf-8")
    if wiki_path == WIKI_PATH:
        for p in docs_files():
            text = p.read_text(encoding="utf-8")
            new = fill(text, values, str(p.relative_to(REPO)))
            if new != text:
                changed.append(str(p))
                if not check:
                    p.write_text(new, encoding="utf-8")
    return changed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--games", type=Path, default=GAMES_PATH)
    ap.add_argument("--wiki", type=Path, default=WIKI_PATH)
    ap.add_argument("--check", action="store_true", help="exit 1 when any stat in the wiki differs from the data")
    ap.add_argument("--list", action="store_true", help="print every stat block")
    args = ap.parse_args(argv)
    if args.list:
        d = Data(json.loads(args.games.read_text(encoding="utf-8")))
        for key, body in render_all(d).items():
            print(f"== {key}\n{body}\n")
        return 0
    changed = run(args.games, args.wiki, args.check)
    rel = [str(Path(c).resolve().relative_to(REPO)) if Path(c).resolve().is_relative_to(REPO) else c for c in changed]
    if args.check:
        if rel:
            print("wiki stats are out of date (run python packages/server/wiki_stats.py):\n  " + "\n  ".join(rel))
            return 1
        print("wiki stats match games_cache.json")
        return 0
    print(f"wiki stats: {len(rel)} file(s) updated" + (":\n  " + "\n  ".join(rel) if rel else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
