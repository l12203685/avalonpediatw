"""複合篩選的獨立 Python 參考實作，供 TypeScript 引擎逐欄比對。

只實作固定驗證條件需要的分類、日期、具名座位數、玩家名字與指標排除。
指標支援角色／位置／整體理論、最終勝率、場數，以及數值或 PR 比較；評估集可為
全部或局條件之後的對局。支援資格不足的處理、反選、最低場數與隱藏／丟局兩種範圍。

在剩餘對局上呼叫 generate_cache.build_cache；隱藏只移除名單，數字不變，排名補滿。
options.leaderboard（上榜條件）合併到 LEADERBOARD_CONFIG 後只重算排行區塊（玩家列的理論視窗不變）。
僅支援預設 activity=filtered。timeline_date 必須先在完整資料集上設定。

    reference_sections(games, filter, cache_as_of, games_key) -> (sections, meta)

檔案與固定條件均不含玩家真名。
"""

from __future__ import annotations

import datetime as dt
from collections import Counter, defaultdict
from fractions import Fraction
from itertools import combinations
from typing import Any, Callable, Mapping, Sequence
from unittest import mock

import generate_cache as gc

CATEGORY_VALUES = {"": "未分類"}


def category_value(g: gc.GameRow) -> str:
    return CATEGORY_VALUES.get(g.category, g.category)


def game_clause_test(clause: Mapping[str, Any]) -> Callable[[gc.GameRow], bool]:
    kind = clause["kind"]
    if kind == "category":
        values = set(clause["in"])

        def test(g: gc.GameRow) -> bool:
            return category_value(g) in values
    elif kind == "date":
        lo, hi, undated = clause.get("from"), clause.get("to"), clause.get("undated") == "include"

        def test(g: gc.GameRow) -> bool:
            if not g.date:
                return undated
            return (lo is None or g.date >= lo) and (hi is None or g.date <= hi)
    elif kind == "namedSeats":
        lo, hi = clause.get("min"), clause.get("max")

        def test(g: gc.GameRow) -> bool:
            n = sum(1 for s in gc.SEATS if g.seat_players.get(s))
            return (lo is None or n >= lo) and (hi is None or n <= hi)
    else:
        raise ValueError(f"the reference filter does not implement {kind!r}")
    if clause.get("not"):
        return lambda g: not test(g)
    return test


def player_rows(games: Sequence[gc.GameRow], as_of: dt.date) -> list[dict]:
    games, _ = gc.drop_dates_after(list(games), as_of)
    return gc.compute_player_stats(games)


def _metric(row: dict, metric: str) -> tuple[float | None, Callable[[int | None], bool]]:
    """單一玩家的指標值與最低場數資格判定函式。"""
    cfg = gc.LEADERBOARD_CONFIG
    total = row["totalGames"]
    theory = row["theory"]
    if metric == "roleTheory":
        rw = theory["roleWindows"]
        return rw["roleTheory"], lambda mg: rw["fullWindows"] and (mg is None or total >= mg)
    if metric == "positionTheory":
        last = theory.get(gc.theory_key(cfg["mainGames"]))
        return (last or {}).get("positionTheory"), lambda mg: total >= (cfg["mainGames"] if mg is None else mg)
    if metric == "overallTheory":
        return theory["career"]["overallTheory"], lambda mg: total >= (cfg["overallMinGames"] if mg is None else mg)
    if metric == "finalWinRate":
        return row["finalWinRate"], lambda mg: total >= (gc.MIN_GAMES_THRESHOLD if mg is None else mg)
    if metric == "games":
        return total, lambda mg: total >= (0 if mg is None else mg)
    raise ValueError(f"the reference filter does not implement metric {metric!r}")


def percentile_rank(value: float, population: Sequence[float]) -> float:
    """PR =（低於人數 + 同分人數的一半）／有資格人數 × 100；精確五成雙至一位小數。"""
    below = sum(1 for v in population if v < value)
    ties = sum(1 for v in population if v == value)
    return round(Fraction(2 * below + ties, 2 * len(population)) * 100 * 10) / 10


def _compare(x: float, op: str, threshold: float) -> bool:
    return {"gt": x > threshold, "ge": x >= threshold, "lt": x < threshold, "le": x <= threshold}[op]


def select_players(who: Mapping[str, Any], rows: Sequence[dict], all_players: Sequence[str]) -> set[str]:
    if who["by"] == "names":
        names = set(who["names"])
        return {n for n in all_players if n not in names} if who.get("invert") else names
    values = []
    for row in rows:
        value, eligible = _metric(row, who["metric"])
        values.append((row["name"], value, value is not None and eligible(who.get("minGames"))))
    population = [v for _, v, ok in values if ok]
    use_pr = who.get("pr") is not None
    threshold = who["pr"] if use_pr else who["value"]
    selected = set()
    for name, value, ok in values:
        if not ok:
            if who.get("ineligible") == "select":
                selected.add(name)
            continue
        x = percentile_rank(value, population) if use_pr else value
        match = _compare(x, who["op"], threshold)
        if match != bool(who.get("invert")):
            selected.add(name)
    return selected


def effective_as_of(flt: Mapping[str, Any], cache_as_of: dt.date) -> dt.date:
    option = (flt.get("options") or {}).get("asOf")
    if option and option != "auto":
        return dt.date.fromisoformat(option)
    as_of = cache_as_of
    for c in flt.get("clauses") or []:
        if c["kind"] == "date" and not c.get("not") and c.get("to"):
            as_of = min(as_of, dt.date.fromisoformat(c["to"]))
    return as_of


def apply_reference_filter(
    games: Sequence[gc.GameRow], flt: Mapping[str, Any], cache_as_of: dt.date,
) -> tuple[list[gc.GameRow], set[str], set[str], dt.date, int]:
    """回傳剩餘對局、隱藏玩家、丟局玩家、基準日與局條件之後的局數。"""
    if (flt.get("options") or {}).get("activity", "filtered") != "filtered":
        raise ValueError("the reference filter only implements activity 'filtered'")
    as_of = effective_as_of(flt, cache_as_of)
    clauses = flt.get("clauses") or []
    tests = [game_clause_test(c) for c in clauses if c["kind"] != "excludePlayers"]
    g1 = [g for g in games if all(t(g) for t in tests)]
    all_players = list(dict.fromkeys(n for g in games for s in gc.SEATS if (n := g.seat_players.get(s))))
    unfiltered = filtered = None
    dropped: set[str] = set()
    hidden: set[str] = set()
    incomplete = False
    for c in clauses:
        if c["kind"] != "excludePlayers":
            continue
        who = c["who"]
        if who["by"] == "metric" and who.get("evaluatedOn") == "filtered":
            filtered = filtered if filtered is not None else player_rows(g1, as_of)
            rows = filtered
        else:
            unfiltered = unfiltered if unfiltered is not None else player_rows(games, cache_as_of)
            rows = unfiltered
        chosen = select_players(who, rows, all_players)
        (dropped if c["scope"] == "dropGames" else hidden).update(chosen)
        incomplete = incomplete or (c["scope"] == "dropGames" and bool(c.get("dropIncompleteGames")))
    g2 = [
        g for g in g1
        if not (incomplete and sum(1 for s in gc.SEATS if g.seat_players.get(s)) < 10)
        and not any(g.seat_players.get(s) in dropped for s in gc.SEATS if g.seat_players.get(s))
    ]
    return g2, hidden, dropped, as_of, len(g1)


def reference_pairs(games: Sequence[gc.GameRow], roster: Mapping[str, Any], hidden: set[str]) -> dict:
    """獨立逐局計算同陣營勝負；三結果矩陣仍以既有 Python 函式作為契約。"""
    counts: dict = defaultdict(Counter)
    labels = {}
    hidden_keys = {gc.player_name_key(name) for name in hidden}
    for game in games:
        if game.outcome not in gc.OUTCOMES:
            continue
        present: dict = defaultdict(set)
        for seat, name in game.seat_players.items():
            key = gc.player_name_key(name)
            labels[key] = name
            present[key].add(gc.role_faction(game.seat_roles.get(seat, "")))
        for a, b in combinations(sorted(present), 2):
            c = counts[a, b]
            c["shared"] += 1
            if len(present[a]) == 1 and present[a] == present[b] and "" not in present[a]:
                faction = next(iter(present[a]))
                c["same"] += 1
                c["mission"] += int(game.red_win if faction == "紅方" else game.blue_win)
                c["final"] += int(gc.is_final_win("刺客" if faction == "紅方" else "忠臣", game.outcome))
    rows = []
    for (a, b), c in counts.items():
        if a in hidden_keys or b in hidden_keys:
            continue
        rows.append({"players": [labels[a], labels[b]], "sharedGames": c["shared"], "sameFactionGames": c["same"],
                     "missionWins": c["mission"], "missionLosses": c["same"] - c["mission"],
                     "finalWins": c["final"], "finalLosses": c["same"] - c["final"],
                     "missionWinRate": gc._rate(c["mission"], c["same"]) if c["same"] else None,
                     "finalWinRate": gc._rate(c["final"], c["same"]) if c["same"] else None})
    rows.sort(key=lambda r: (-r["sameFactionGames"], *r["players"]))
    shown = lambda names: [name for name in names if gc.player_name_key(name) not in hidden_keys]
    matrix_roster = {"players": shown(roster.get("players", [])),
                     "rowLabels": shown(roster.get("rowLabels") or roster.get("players", []))}
    return {"source": "games", "sameFaction": rows,
            "outcomePair": gc.compute_outcome_pair_matrix({"coWin": matrix_roster}, list(games))}


def reference_sections(
    games: Sequence[gc.GameRow], flt: Mapping[str, Any], cache_as_of: dt.date, games_key: str,
    aliases: Mapping[str, str] | None = None, roster: Mapping[str, Any] | None = None,
) -> tuple[dict, dict]:
    """對篩選後的對局重算全部支援區塊，再處理只隱藏名單的玩家。"""
    g2, hidden, dropped, as_of, n1 = apply_reference_filter(games, flt, cache_as_of)
    meta = {"totalGames": len(games), "gamesAfterClauses": n1, "games": len(g2), "droppedPlayers": len(dropped),
            "hiddenPlayers": len(hidden), "asOf": as_of.isoformat()}
    more = {"lake": gc.compute_lake(list(g2)), "seatOrder": gc.compute_seat_order(list(g2)),
            "lakeClaim": gc.compute_lake_claim_feature(list(g2), as_of),
            "pairs": reference_pairs(g2, roster or {}, hidden)}
    overrides = (flt.get("options") or {}).get("leaderboard") or {}
    cfg = {**gc.LEADERBOARD_CONFIG, **overrides}
    if not hidden:
        cache = gc.build_cache(list(g2), {}, as_of, gc.cache_aliases({"players": {"aliases": aliases or {}}}),
                               games_key=games_key)
        if overrides:
            games2, _ = gc.drop_dates_after(list(g2), as_of)
            ov = cache["overview"]
            cache["leaderboard"] = gc.compute_leaderboard(games2, as_of, ov["roleFinalWinRates"], ov["seatFinalWinRates"],
                                                          ov["roleSeatFinalWinRates"], cfg=cfg)
        return {**{k: cache[k] for k in ("overview", "players", "playerDetails", "missions", "rounds", "captainAnalysis",
                                        "leaderboard")}, **more}, meta
    # 數字先用完整 G2 計算，再移除隱藏玩家並依序補滿名單。
    games2, _ = gc.drop_dates_after(list(g2), as_of)
    players = gc.compute_player_stats(games2)
    seat_outcomes = gc.compute_seat_outcomes_per_player(games2, players)
    for p in players:
        p["seatOutcomes"] = seat_outcomes.get(p["name"], {})
    listed = [p for p in players if p["name"] not in hidden]
    overview = gc.compute_overview(games2, listed)
    overview["totalPlayers"] = len(players)
    overview["gamesKey"] = games_key
    timelines = gc.player_timelines
    with mock.patch.object(gc, "player_timelines",
                           lambda gs: {n: s for n, s in timelines(gs).items() if n not in hidden}):
        leaderboard = gc.compute_leaderboard(games2, as_of, overview["roleFinalWinRates"], overview["seatFinalWinRates"],
                                             overview["roleSeatFinalWinRates"], cfg=cfg)
    return {
        "overview": overview,
        "players": gc.compute_players_endpoint(listed, {k: v for k, v in (aliases or {}).items()
                                                        if v in {p["name"] for p in listed}}),
        "playerDetails": gc.compute_player_details(listed),
        "missions": gc.compute_missions(games2),
        "rounds": gc.compute_rounds(games2),
        "captainAnalysis": gc.compute_captain_analysis(games2),
        "leaderboard": leaderboard,
        **more,
    }, meta
