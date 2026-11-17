"""
The website's 牌譜紀錄 list as ONE database of every game from every source (Edward 2026-11-16:
「你應該要把所有來源的牌譜都整併到自己的資料庫啊，包括 Discord + Googlesheet（實戰 & 模擬）」).

discord_records_export.py reads the Discord forum (one post = one game; the forum's 模擬 tag marks games
with our bot 百科AI, which stay off this list); this module adds the games that exist only in the
Google Sheet:

  * 牌譜 tab (實戰): every sheet game of games_cache.json (the game-level dataset generate_cache.py
    writes earlier in the same workflow run; it already holds the 文字記錄 decoded into proposals,
    approvers, missions, lakes, 刺殺, 結果, seats). Public id ``S<流水號>``.
  * 模擬瓦 tab (模擬): the tab's rows (流水號, 文字記錄, 配置, 刺殺, 分類, 日期時間, 場次, 玩1..玩0), read
    by the export with the stats-sheet credentials. Public id ``M<流水號>``, flagged ``sim``.

Dedupe: a sheet game with the same generate_cache.record_fingerprint (配置 + every proposal's team +
every mission) as a Discord post OF THE SAME TYPE (實戰 / 模擬) is that post: no second entry; the post
gets ``src: "dc+sheet"``. 模擬 entries are flagged ``sim`` and stay out of everything that counts real
games: they never merge into a 實戰 entry, get no 陣容強度 / 失誤標籤, and this list is not an input of
games_cache.json (generate_cache reads only the 牌譜 / Discord匯入 tabs) or sim_bank.json.
Sheet-only entries carry ``src: "sheet"``; plain Discord posts carry no ``src`` (the file before
2026-11-16 had none). Same privacy level as the Discord part: nicknames by seat (already in the
public dataset), the parsed record, no free text.

Ids are the sheet's own 流水號 (stable when a record is corrected, unlike a fingerprint hash).
"""

from __future__ import annotations

import re
from collections import Counter
from typing import Any, Iterable, Mapping, Sequence

import discord_records_import as dri
import generate_cache as gc

SHEET_PREFIX = "S"
SIM_PREFIX = "M"
SIM_TAB = "模擬瓦"
SIM_TAG = dri.TAG_SIMULATION  # 模擬
SRC_SHEET = "sheet"
SRC_BOTH = "dc+sheet"
FP_KEY = "_fp"  # internal: dropped before the file is written
SHEET_TITLE = "試算表牌譜 #{id}"
# Fixed explanations (the file never carries a record's text) for rows whose record does not convert.
SHEET_PROBLEM = "試算表裡這局的紀錄不完整（缺少某一輪的派票、任務張數不對或結果不明）"
SIM_PROBLEM = "試算表裡這局模擬的紀錄格式讀不懂"
PROBLEMS = (SHEET_PROBLEM, SIM_PROBLEM)
SIM_TITLE = "試算表模擬 #{id}"
NAME_MAX = 40

_MISSION_RE = re.compile(r"[ox]{3,5}")
_DIGITS_RE = re.compile(r"[0-9]{1,6}")
_DATE_RE = re.compile(r"([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})")


def clean_name(text: Any) -> str:
    s = " ".join(gc._INVISIBLE_CHARS_RE.sub("", str(text or "")).split())
    return s if len(s) <= NAME_MAX else s[: NAME_MAX - 1] + "…"


def iso_date(value: Any) -> str:
    """'2023-06-27T00:00:00' / '2023/6/27' -> '2023-06-27'; undated (or the sheet's 1900/01/01) -> ''."""
    m = _DATE_RE.search(str(value or ""))
    if not m or m.group(1) < "1990":
        return ""
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def vote_tokens(team: str, approvers: str) -> list[str]:
    """Anomaly marks of one proposal from its approvers (seat order 1..9, 0): '57-' for team members
    who rejected, '6+' for outsiders who approved."""
    minus = "".join(s for s in gc.SEATS if s in team and s not in approvers)
    plus = "".join(s for s in gc.SEATS if s in approvers and s not in team)
    return [t for t in (minus and minus + "-", plus and plus + "+") if t]


# ---------------------------------------------------------------------------
# 牌譜 tab: games_cache.json rows
# ---------------------------------------------------------------------------

def sheet_game(row: Sequence[Any], doc: Mapping[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """(the site's game object, '') or (None, reason) for one sheet row of the dataset."""
    idx = {name: i for i, name in enumerate(doc["fields"])}

    def get(name: str) -> Any:
        return row[idx[name]]

    config = get("config")
    if not re.fullmatch(r"[0-9]{6}", config or "") or len(set(config)) != 6:
        return None, "config"
    missions = [c.lower() for c in get("missions").split("|")]
    while missions and not missions[-1]:
        missions.pop()
    if not missions or any(not _MISSION_RE.fullmatch(m) or len(m) != dri.TEAM_SIZES[i] for i, m in enumerate(missions)):
        return None, "missions"
    by_round: dict[int, list[dict[str, Any]]] = {}
    for rnd, attempt, team, approvers in get("votes"):
        if not re.fullmatch(r"[0-9]{3,5}", team or ""):
            return None, "team"
        votes = [] if attempt == 5 and not approvers else vote_tokens(team, approvers or "")
        by_round.setdefault(int(rnd), []).append({"team": team, "votes": votes})
    rounds = []
    for i, mission in enumerate(missions, 1):
        proposals = by_round.get(i)
        if not proposals or len(proposals) > 5:
            return None, "proposals"
        rounds.append({"proposals": proposals, "mission": mission})
    if not 3 <= len(rounds) <= 5:
        return None, "rounds"
    claims = get("claims")
    claim_of = {claims[i:i + 2]: claims[i + 2] for i in range(0, len(claims), 3)}
    lakes = []
    raw = get("lakes")
    for n, after in enumerate((2, 3, 4)):
        pair = raw[2 * n:2 * n + 2]
        if pair == "--" or after >= len(rounds):
            continue
        if not re.fullmatch(r"[0-9]{2}", pair) or pair[0] == pair[1]:
            continue  # a seat the sheet left unknown ('?'): that lake is not shown
        claim = {"x": "x", "o": "o"}.get(claim_of.get(pair, "-"), "")
        lakes.append({"after": after, "holder": pair[0], "target": pair[1], "claim": claim})
    kill = get("kill")
    if not re.fullmatch(r"[0-9]?", kill or ""):
        return None, "kill"
    outcome = doc["vocab"]["outcome"][get("outcome")]
    if outcome not in (gc.OUTCOME_THREE_RED, gc.OUTCOME_BLUE_DEAD, gc.OUTCOME_BLUE_ALIVE):
        outcome = dri.outcome_from_record(missions, kill, config)
        if not outcome:
            return None, "outcome"
    players = doc["players"]
    names = [clean_name(players[i]) if 0 <= i < len(players) else "" for i in get("seats")]
    category = doc["vocab"]["category"][get("cat")]
    return {
        "config": config,
        "names": names,
        "rounds": rounds,
        "lakes": lakes,
        "assassination": kill,
        "outcome": outcome,
        "category": category if category in GAME_CATEGORIES else "",
    }, ""


GAME_CATEGORIES = ("", *dri.CATEGORY_TAGS, "娛樂", "其他")


def sheet_entries(doc: Mapping[str, Any] | None) -> tuple[list[dict[str, Any]], Counter]:
    """Entries of every 牌譜-tab game of the dataset (Discord匯入 rows are Discord posts, 百科AI games are
    left out like on Discord). Rows that do not convert are counted and left out."""
    counts: Counter = Counter()
    out: list[dict[str, Any]] = []
    if not doc:
        return out, counts
    idx = {name: i for i, name in enumerate(doc["fields"])}
    for row in doc["games"]:
        if row[idx["src"]] != gc.GAME_SOURCE_SHEET or not str(row[idx["id"]]).isdigit():
            continue
        if doc["vocab"]["category"][row[idx["cat"]]] == gc.BOT_CATEGORY:
            counts["bot"] += 1
            continue
        game, reason = sheet_game(row, doc)
        gid = str(row[idx["id"]])
        category = doc["vocab"]["category"][row[idx["cat"]]]
        entry: dict[str, Any] = {
            "id": SHEET_PREFIX + gid,
            "title": SHEET_TITLE.format(id=gid),
            "tags": [category] if category in GAME_CATEGORIES[1:] else [],
            "created": "",
            "date": iso_date(row[idx["date"]]),
            "game": game,
        }
        if game is None:
            entry["problem"] = SHEET_PROBLEM
            counts[f"sheet unreadable: {reason}"] += 1
        else:
            counts["sheet"] += 1
        entry["src"] = SRC_SHEET
        entry[FP_KEY] = row_fingerprint(row, idx)
        out.append(entry)
    return out, counts


def row_fingerprint(row: Sequence[Any], idx: Mapping[str, int]) -> str:
    """record_fingerprint of a dataset row (as discord_records_export.row_fingerprint on its GameRow)."""
    teams = [str(v[2]) for v in row[idx["votes"]]]
    cells = [c for c in row[idx["missions"]].split("|") if c]
    return gc.record_fingerprint(row[idx["config"]], "\n".join(teams + cells))


# ---------------------------------------------------------------------------
# 模擬瓦 tab: partial games (often only the first round)
# ---------------------------------------------------------------------------

def lenient_game(text: str, config: str, names: Mapping[str, str], kill: str = "") -> dict[str, Any] | None:
    """A 模擬 record: the same line syntax as a game, but it may stop anywhere (1-5 rounds, the last
    one possibly without its mission). None when a line is not record syntax or sizes are wrong."""
    if not re.fullmatch(r"[0-9]{6}", config or "") or len(set(config)) != 6:
        return None
    rounds: list[dict[str, Any]] = []
    lakes: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    try:
        for n, raw in enumerate((text or "").splitlines(), 1):
            item = dri.classify_line(raw, n)
            if item is None:
                continue
            if item.kind == "proposal":
                team, tokens, inline = item.data
                current.append({"team": team, "votes": [dri.canonical_vote_token(t, n) for t in tokens]})
                if inline:
                    rounds.append({"proposals": current, "mission": inline})
                    current = []
            elif item.kind == "mission":
                if not current:
                    return None
                rounds.append({"proposals": current, "mission": item.data})
                current = []
            elif item.kind == "lake" and not current:
                lake = item.data
                lakes.append({"after": len(rounds), "holder": lake.holder, "target": lake.target,
                              "claim": lake.declared if lake.declared in ("o", "x", "?") else ""})
            else:
                return None
    except dri.SkipPost:
        return None
    if current:
        rounds.append({"proposals": current, "mission": ""})
    if not 1 <= len(rounds) <= 5:
        return None
    for r, rnd in enumerate(rounds):
        size = dri.TEAM_SIZES[r]
        if len(rnd["proposals"]) > 5 or any(len(p["team"]) != size or len(set(p["team"])) != size
                                            for p in rnd["proposals"]):
            return None
        if rnd["mission"] and len(rnd["mission"]) != size:
            return None
    completed = sum(1 for rnd in rounds if rnd["mission"])
    if any(not 2 <= lk["after"] <= min(4, completed) or lk["holder"] == lk["target"] for lk in lakes):
        return None
    missions = [rnd["mission"] for rnd in rounds if rnd["mission"]]
    outcome = dri.outcome_from_record(missions, kill, config) if len(missions) == len(rounds) else ""
    return {
        "config": config,
        "names": [clean_name(names.get(s, "")) for s in gc.SEATS],
        "rounds": rounds,
        "lakes": lakes,
        "assassination": kill if re.fullmatch(r"[0-9]?", kill or "") and outcome else "",
        "outcome": outcome,
        "category": "",
    }


def sim_rows_from_values(values: Sequence[Sequence[Any]] | None) -> list[dict[str, Any]]:
    """get_all_values() of the 模擬瓦 tab -> one dict per row (header names as keys)."""
    if not values:
        return []
    header = [str(h).strip() for h in values[0]]
    return [{h: (r[i] if i < len(r) else "") for i, h in enumerate(header) if h} for r in values[1:]]


def sim_entries(rows: Iterable[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], Counter]:
    counts: Counter = Counter()
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        gid = str(row.get("流水號") or "").strip()
        text = str(row.get("文字記錄") or "")
        if not text.strip():
            continue  # empty rows at the bottom of the tab
        if not _DIGITS_RE.fullmatch(gid) or gid in seen:
            counts["sim skipped: id"] += 1
            continue
        seen.add(gid)
        names = {s: str(row.get(f"玩{s}") or "") for s in gc.SEATS}
        config = str(row.get("配置") or "").strip()
        game = lenient_game(text, config, names, str(row.get("刺殺") or "").strip())
        entry: dict[str, Any] = {
            "id": SIM_PREFIX + gid,
            "title": SIM_TITLE.format(id=gid),
            "tags": [SIM_TAG],
            "created": "",
            "date": iso_date(row.get("日期時間")),
            "game": game,
        }
        if game is None:
            entry["problem"] = SIM_PROBLEM
            counts["sim unreadable"] += 1
        else:
            counts["sim"] += 1
        entry["src"] = SRC_SHEET
        entry["sim"] = True
        entry[FP_KEY] = gc.record_fingerprint(config, text)
        out.append(entry)
    return out, counts


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def game_fingerprint(game: Mapping[str, Any]) -> str:
    """generate_cache.record_fingerprint of a site game object (as discord_records_export.entry_fingerprint)."""
    lines: list[str] = []
    for rnd in game["rounds"]:
        lines += [p["team"] for p in rnd["proposals"]]
        if rnd["mission"]:
            lines.append(rnd["mission"])
    return gc.record_fingerprint(game["config"], "\n".join(lines))


def sort_key(post: Mapping[str, Any]) -> tuple[str, str, int, int]:
    """Newest first: record date, then posting time (Discord), then Discord before sheet, then id."""
    pid = str(post["id"])
    sheet = 0 if pid[:1].isdigit() else 1
    return (post.get("date") or "", post.get("created") or "", -sheet, int(pid.lstrip(SHEET_PREFIX + SIM_PREFIX) or 0))


def merge_posts(dc_posts: Sequence[dict[str, Any]], sheet: Sequence[dict[str, Any]],
                sims: Sequence[dict[str, Any]]) -> tuple[list[dict[str, Any]], Counter]:
    """Discord posts + sheet entries that are not one of them (same fingerprint), newest first."""
    counts: Counter = Counter()
    # 模擬 is only a simulation (Edward 2026-11-16「模擬畢竟只是模擬」): a sheet 實戰 game merges only with a
    # real Discord post, a 模擬瓦 row only with a 模擬 post -- never across types
    dc_by_fp: dict[bool, dict[str, dict[str, Any]]] = {False: {}, True: {}}
    for p in dc_posts:
        p.pop("src", None)
        if p.get("game"):
            dc_by_fp[bool(p.get("sim"))].setdefault(game_fingerprint(p["game"]), p)
    out = list(dc_posts)
    seen_sim: set[str] = set()  # 模擬瓦 rows that repeat one another (never compared with 實戰 games)
    for entry in [*sheet, *sims]:
        fp = entry.pop(FP_KEY, None) or (game_fingerprint(entry["game"]) if entry.get("game") else "")
        if not fp:
            out.append(entry)
            continue
        sim = bool(entry.get("sim"))
        twin = dc_by_fp[sim].get(fp)
        if twin is not None:
            twin["src"] = SRC_BOTH
            counts["merged with a Discord post"] += 1
            continue
        if sim:
            if fp in seen_sim:
                counts["duplicate 模擬 row"] += 1
                continue
            seen_sim.add(fp)
        out.append(entry)
    out.sort(key=sort_key, reverse=True)
    return out, counts

