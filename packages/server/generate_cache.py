"""
Pre-compute all analysis API responses and write to analysis_cache.json.

Runs locally. Reads Google Sheets via service account credentials.
Output: analysis_cache.json with keys matching each API endpoint.
The server reads this file and returns it directly -- zero parsing at runtime.

Usage:
    python generate_cache.py
"""

import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import gspread
from google.oauth2.service_account import Credentials

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

CREDENTIALS_PATH = Path(r"C:\Users\admin\.claude\credentials\google_sheets_concise_beanbag.json")
SHEET_ID = "174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU"
OUTPUT_PATH = Path(__file__).parent / "analysis_cache.json"

MIN_GAMES_THRESHOLD = 50

CONFIG_ROLE_ORDER = ["刺客", "娜美", "德魯", "奧伯", "派西", "梅林"]
RED_ROLES = {"刺客", "娜美", "德魯", "奧伯"}
BLUE_ROLES = {"派西", "梅林", "忠臣"}


# ---------------------------------------------------------------------------
# Google Sheets connection
# ---------------------------------------------------------------------------

def connect() -> gspread.Spreadsheet:
    scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    creds = Credentials.from_service_account_file(str(CREDENTIALS_PATH), scopes=scopes)
    gc = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def decode_config(config: str) -> dict[str, str]:
    seat_role: dict[str, str] = {}
    for i, digit in enumerate(config):
        if i < len(CONFIG_ROLE_ORDER):
            seat_role[digit] = CONFIG_ROLE_ORDER[i]
    for s in "1234567890":
        if s not in seat_role:
            seat_role[s] = "忠臣"
    return seat_role


def role_faction(role: str) -> str:
    if role in RED_ROLES:
        return "紅方"
    if role in BLUE_ROLES:
        return "藍方"
    return ""


def parse_lake(lake_str: str) -> tuple[str, str] | None:
    if not lake_str or ">" not in lake_str:
        return None
    cleaned = lake_str.replace("x", "")
    parts = cleaned.split(">")
    if len(parts) == 2:
        return (parts[0].strip(), parts[1].strip())
    return None


def count_mission_fails(s: str) -> int:
    return s.count("x") if s else 0


def parse_pct(val: str) -> float:
    if not val:
        return 0.0
    cleaned = val.replace("%", "").strip()
    try:
        return float(cleaned)
    except (ValueError, TypeError):
        return 0.0


def rnd1(n: float) -> float:
    """Round to 1 decimal place."""
    return round(n * 10) / 10


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

class GameRow:
    __slots__ = (
        "id", "config", "seat_roles", "outcome",
        "red_win", "blue_win", "merlin_killed",
        "r11_seats", "r11_roles", "r11_red_count", "r11_blue_count",
        "r11_has_merlin", "r11_has_percival",
        "missions",
        "lake1", "lake2", "lake3",
        "lake1_holder_faction", "lake1_target_faction",
        "lake1_holder_role", "lake1_target_role",
        "lake2_holder_faction", "lake2_target_faction",
        "lake2_holder_role", "lake2_target_role",
        "lake3_holder_faction", "lake3_target_faction",
        "lake3_holder_role", "lake3_target_role",
        "game_state", "rounds", "round_results",
        "text_record",
    )


# ---------------------------------------------------------------------------
# Load game log (牌譜)
# ---------------------------------------------------------------------------

def load_game_log(sh: gspread.Spreadsheet) -> list[GameRow]:
    ws = sh.worksheet("牌譜")
    rows = ws.get_all_values()
    if len(rows) < 2:
        return []

    headers = rows[0]
    h_idx: dict[str, int] = {}
    for i, h in enumerate(headers):
        if h not in h_idx:
            h_idx[h] = i

    def col(row: list[str], name: str) -> str:
        idx = h_idx.get(name)
        if idx is None or idx >= len(row):
            return ""
        return row[idx] or ""

    round_names = ["第一局", "第二局", "第三局", "第四局", "第五局"]
    round_result_names = [
        "第一局成功失敗", "第二局成功失敗", "第三局成功失敗",
        "第四局成功失敗", "第五局成功失敗",
    ]

    game_rows: list[GameRow] = []

    for i in range(1, len(rows)):
        row = rows[i]
        gid = col(row, "流水號").strip()
        if not gid:
            continue
        config = col(row, "配置").strip()
        if len(config) != 6:
            continue

        g = GameRow()
        g.id = gid
        g.config = config
        g.seat_roles = decode_config(config)
        g.text_record = col(row, "文字記錄")
        g.outcome = col(row, "結果").strip()
        g.red_win = g.outcome == "三紅"
        g.blue_win = g.outcome in ("三藍死", "三藍活")
        g.merlin_killed = g.outcome == "三藍死"

        # 1-1 team
        r11_str = col(row, "1-1")
        g.r11_seats = list(r11_str) if r11_str else []
        g.r11_roles = [g.seat_roles.get(s, "?") for s in g.r11_seats]
        g.r11_red_count = sum(1 for r in g.r11_roles if r in RED_ROLES)
        g.r11_blue_count = sum(1 for r in g.r11_roles if r in BLUE_ROLES)
        g.r11_has_merlin = "梅林" in g.r11_roles
        g.r11_has_percival = "派西" in g.r11_roles

        # Missions
        g.missions = []
        for m_idx in range(5):
            result_str = col(row, round_result_names[m_idx])
            if not result_str:
                continue
            g.missions.append({
                "round": m_idx + 1,
                "result": result_str,
                "fails": count_mission_fails(result_str),
                "total": len(result_str),
            })

        # Lake
        def lake_factions(lake_parsed, seat_roles):
            if lake_parsed is None:
                return ("", "", "", "")
            h_role = seat_roles.get(lake_parsed[0], "")
            t_role = seat_roles.get(lake_parsed[1], "")
            return (
                role_faction(h_role) if h_role else "",
                role_faction(t_role) if t_role else "",
                h_role,
                t_role,
            )

        g.lake1 = parse_lake(col(row, "首湖"))
        g.lake2 = parse_lake(col(row, "二湖"))
        g.lake3 = parse_lake(col(row, "三湖"))

        l1 = lake_factions(g.lake1, g.seat_roles)
        l2 = lake_factions(g.lake2, g.seat_roles)
        l3 = lake_factions(g.lake3, g.seat_roles)

        g.lake1_holder_faction, g.lake1_target_faction, g.lake1_holder_role, g.lake1_target_role = l1
        g.lake2_holder_faction, g.lake2_target_faction, g.lake2_holder_role, g.lake2_target_role = l2
        g.lake3_holder_faction, g.lake3_target_faction, g.lake3_holder_role, g.lake3_target_role = l3

        g.game_state = col(row, "局勢")
        g.rounds = [col(row, n) for n in round_names]
        g.round_results = [col(row, n) for n in round_result_names]

        game_rows.append(g)

    return game_rows


# ---------------------------------------------------------------------------
# Load player stats (統計 sheet)
# ---------------------------------------------------------------------------

def load_player_stats(sh: gspread.Spreadsheet) -> list[dict]:
    """Load player stats from the aggregate sheet.

    Sheet structure: row[0] = aggregate totals, row[1] = header, row[2+] = player data.
    Headers have many duplicate names (刺, 娜, etc.) so we use positional indexing
    based on the known column layout from the Python analysis script.
    """
    rows = None
    for tab in ["生涯報表", "戰績報表", "統計", "個人統計", "Stats"]:
        try:
            ws = sh.worksheet(tab)
            rows = ws.get_all_values()
            if len(rows) > 3:
                print(f"  Using stats tab: {tab} ({len(rows)} rows)")
                break
        except gspread.exceptions.WorksheetNotFound:
            continue

    if not rows or len(rows) < 3:
        print("[WARN] No stats sheet found, returning empty player stats")
        return []

    # Column layout (positional, 0-indexed):
    # 0: player, 1: 總場次, 2: 勝率, 3: 角色理論, 4: 位置理論,
    # 5: 紅方三紅, 6: 紅方梅死, 7: 紅方梅活, 8: 紅勝,
    # 9: 藍方三紅, 10: 藍方梅死, 11: 藍方梅活,
    # 12: 三藍(wr), 13-19: 刺娜德奧派梅忠 (role win rates)
    # 20-26: 刺娜德奧派梅忠 (role distribution %)
    # 27: 紅角率, 28: 藍角率
    # 29-38: 1勝~0勝 (seat win rates)
    # 39: 雙尾派, 40: 1-5勝, 41: 6-0勝
    # 42-51: 1紅勝~0紅勝 (seat red win rates)
    # 52-61: 1藍勝~0藍勝 (seat blue win rates)
    # 62-71: 1紅~0紅 (seat red distribution %)
    # 72-81: 1藍~0藍 (seat blue distribution %)
    # 82-84: 三紅,三藍死,三藍活 (raw red mission outcomes)
    # 85-87: 三紅,三藍死,三藍活 (raw blue mission outcomes)
    # 88-94: 刺娜德奧派梅忠 (raw role game counts - wins)
    # 95: 紅勝(raw), 96: 藍勝(raw), 97: 總勝(raw)
    # 98-104: 刺娜德奧派梅忠 (raw role game counts)
    # 105: 紅場, 106: 藍場

    ROLES = ["刺客", "娜美", "德魯", "奧伯", "派西", "梅林", "忠臣"]
    SEATS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]

    def safe(row: list[str], idx: int) -> str:
        if idx >= len(row):
            return ""
        return row[idx] or ""

    players: list[dict] = []

    # Data starts from row[2] (row[0]=aggregate, row[1]=header)
    for i in range(2, len(rows)):
        row = rows[i]
        name = (row[0] if row else "").strip()
        if not name:
            continue
        total_games = parse_pct(safe(row, 1))
        if total_games == 0:
            continue

        # Role win rates: columns 13-19 (刺娜德奧派梅忠)
        role_win_rates: dict[str, float] = {}
        for j, role in enumerate(ROLES):
            role_win_rates[role] = parse_pct(safe(row, 13 + j))

        # Role distribution: columns 20-26
        role_distribution: dict[str, float] = {}
        for j, role in enumerate(ROLES):
            role_distribution[role] = parse_pct(safe(row, 20 + j))

        # Raw role games: columns 98-104
        raw_role_games: dict[str, float] = {}
        for j, role in enumerate(ROLES):
            raw_role_games[role] = parse_pct(safe(row, 98 + j))

        # Seat win rates: columns 29-38
        seat_win_rates: dict[str, float] = {}
        for j, s in enumerate(SEATS):
            seat_win_rates[s] = parse_pct(safe(row, 29 + j))

        # Seat red win rates: columns 42-51
        seat_red_win_rates: dict[str, float] = {}
        for j, s in enumerate(SEATS):
            seat_red_win_rates[s] = parse_pct(safe(row, 42 + j))

        # Seat blue win rates: columns 52-61
        seat_blue_win_rates: dict[str, float] = {}
        for j, s in enumerate(SEATS):
            seat_blue_win_rates[s] = parse_pct(safe(row, 52 + j))

        raw_red_wins = parse_pct(safe(row, 95))
        raw_blue_wins = parse_pct(safe(row, 96))
        raw_total_wins = parse_pct(safe(row, 97))
        raw_red_games = parse_pct(safe(row, 105))
        raw_blue_games = parse_pct(safe(row, 106))

        blue_win = 0.0
        if raw_blue_games > 0 and raw_blue_wins > 0:
            blue_win = round((raw_blue_wins / raw_blue_games) * 100 * 10) / 10

        players.append({
            "name": name,
            "totalGames": total_games,
            "winRate": parse_pct(safe(row, 2)),
            "roleTheory": parse_pct(safe(row, 3)),
            "positionTheory": parse_pct(safe(row, 4)),
            "redWin": parse_pct(safe(row, 8)),
            "blueWin": blue_win,
            "red3Red": parse_pct(safe(row, 5)),
            "redMerlinDead": parse_pct(safe(row, 6)),
            "redMerlinAlive": parse_pct(safe(row, 7)),
            "blue3Red": parse_pct(safe(row, 9)),
            "blueMerlinDead": parse_pct(safe(row, 10)),
            "blueMerlinAlive": parse_pct(safe(row, 11)),
            "roleWinRates": role_win_rates,
            "roleDistribution": role_distribution,
            "redRoleRate": parse_pct(safe(row, 27)),
            "blueRoleRate": parse_pct(safe(row, 28)),
            "seatWinRates": seat_win_rates,
            "seatRedWinRates": seat_red_win_rates,
            "seatBlueWinRates": seat_blue_win_rates,
            "rawRoleGames": raw_role_games,
            "rawRedWins": raw_red_wins,
            "rawBlueWins": raw_blue_wins,
            "rawTotalWins": raw_total_wins,
            "rawRedGames": raw_red_games,
            "rawBlueGames": raw_blue_games,
        })

    return players


# ---------------------------------------------------------------------------
# Load chemistry matrices
# ---------------------------------------------------------------------------

def load_chemistry(sh: gspread.Spreadsheet) -> dict:
    sheet_names = ["同贏", "同輸", "贏相關", "同贏-同輸"]
    keys = ["coWin", "coLose", "winCorr", "coWinMinusLose"]

    result: dict = {}
    for sheet_name, key in zip(sheet_names, keys):
        try:
            ws = sh.worksheet(sheet_name)
            rows = ws.get_all_values()
        except gspread.exceptions.WorksheetNotFound:
            result[key] = {"players": [], "values": []}
            continue

        if len(rows) < 2:
            result[key] = {"players": [], "values": []}
            continue

        players = [p for p in rows[0][1:] if p]
        # Track row labels separately — earlier versions assumed sheet row order
        # matched column order which caused visible ID mismatches when the
        # Google Sheets template reordered rows. Keep both arrays so the
        # frontend can label axes independently.
        row_labels: list[str] = []
        values: list[list[float | None]] = []
        for r in range(1, len(rows)):
            if not rows[r][0]:
                continue
            row_labels.append(rows[r][0])
            row_vals: list[float | None] = []
            for v in rows[r][1:]:
                cleaned = v.replace("%", "").strip() if v else ""
                try:
                    row_vals.append(float(cleaned))
                except (ValueError, TypeError):
                    row_vals.append(None)
            values.append(row_vals)

        result[key] = {"players": players, "rowLabels": row_labels, "values": values}

    return result


# ---------------------------------------------------------------------------
# Compute endpoint responses (matching sheetsAnalysis.ts exactly)
# ---------------------------------------------------------------------------

def compute_seat_position_win_rates(games: list[GameRow]) -> list[dict]:
    """Win rate by seat position (1-10), broken down by role assigned to that seat."""
    SEATS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    SEAT_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
    ALL_ROLES = ["刺客", "娜美", "德魯", "奧伯", "派西", "梅林", "忠臣"]

    # seat_char -> role -> {wins, total}
    seat_role_stats: dict[str, dict[str, dict]] = {}
    for s in SEATS:
        seat_role_stats[s] = {}

    for g in games:
        for seat_char in SEATS:
            role = g.seat_roles.get(seat_char, "")
            if not role:
                continue
            entry = seat_role_stats[seat_char].setdefault(role, {"wins": 0, "total": 0})
            entry["total"] += 1
            # Win = the faction of that role won
            if role in RED_ROLES and g.red_win:
                entry["wins"] += 1
            elif role in BLUE_ROLES and g.blue_win:
                entry["wins"] += 1

    result: list[dict] = []
    for seat_char, label in zip(SEATS, SEAT_LABELS):
        roles_data: list[dict] = []
        total_wins = 0
        total_games_seat = 0
        for role in ALL_ROLES:
            stats = seat_role_stats[seat_char].get(role)
            if not stats or stats["total"] == 0:
                continue
            wr = rnd1(stats["wins"] / stats["total"] * 100)
            roles_data.append({
                "role": role,
                "winRate": wr,
                "games": stats["total"],
            })
            total_wins += stats["wins"]
            total_games_seat += stats["total"]

        overall_wr = rnd1(total_wins / total_games_seat * 100) if total_games_seat > 0 else 0
        result.append({
            "seat": label,
            "overallWinRate": overall_wr,
            "totalGames": total_games_seat,
            "roles": roles_data,
        })

    return result


def compute_overview(games: list[GameRow], players: list[dict]) -> dict:  # noqa: C901
    total = len(games)
    red_wins = sum(1 for g in games if g.red_win)
    blue_wins = sum(1 for g in games if g.blue_win)
    merlin_kills = sum(1 for g in games if g.merlin_killed)

    significant = [p for p in players if p["totalGames"] >= MIN_GAMES_THRESHOLD]

    # Fix #8: Use roleTheory (theoretical win rate) instead of raw winRate for ranking
    top_by_theory = sorted(significant, key=lambda p: p["roleTheory"], reverse=True)[:10]
    top_by_games = sorted(players, key=lambda p: p["totalGames"], reverse=True)[:10]

    merlin_kill_rate = 0.0
    if blue_wins > 0:
        merlin_kill_rate = rnd1(merlin_kills / (merlin_kills + (blue_wins - merlin_kills)) * 100)

    # Fix #10: Game outcome breakdown
    three_red = sum(1 for g in games if g.outcome == "三紅")
    three_blue_alive = sum(1 for g in games if g.outcome == "三藍活")
    three_blue_dead = sum(1 for g in games if g.outcome == "三藍死")

    return {
        "totalGames": total,
        "totalPlayers": len(players),
        "redWinRate": rnd1(red_wins / total * 100) if total > 0 else 0,
        "blueWinRate": rnd1(blue_wins / total * 100) if total > 0 else 0,
        "merlinKillRate": merlin_kill_rate,
        "outcomeBreakdown": {
            "threeRed": three_red,
            "threeBlueAlive": three_blue_alive,
            "threeBlueDead": three_blue_dead,
            "threeRedPct": rnd1(three_red / total * 100) if total > 0 else 0,
            "threeBlueAlivePct": rnd1(three_blue_alive / total * 100) if total > 0 else 0,
            "threeBlueDeadPct": rnd1(three_blue_dead / total * 100) if total > 0 else 0,
        },
        "topPlayersByTheory": [
            {"name": p["name"], "roleTheory": p["roleTheory"], "winRate": p["winRate"], "games": p["totalGames"]}
            for p in top_by_theory
        ],
        "topPlayersByGames": [
            {"name": p["name"], "games": p["totalGames"], "winRate": p["winRate"]}
            for p in top_by_games
        ],
        # Seat position win rates (replaces useless per-role win rate comparison)
        "seatPositionWinRates": compute_seat_position_win_rates(games),
    }


def compute_missions(games: list[GameRow]) -> dict:
    # Pass rate per mission round
    mission_pass_rates = []
    for r in range(1, 6):
        with_mission = [g for g in games if any(m["round"] == r for m in g.missions)]
        if not with_mission:
            continue
        passed = sum(
            1 for g in with_mission
            if any(m["round"] == r and m["fails"] == 0 for m in g.missions)
        )
        mission_pass_rates.append({
            "round": r,
            "passRate": rnd1(passed / len(with_mission) * 100),
            "totalGames": len(with_mission),
        })

    # Fix #4: Mission success rate by red player count in team (replaces fail card distribution)
    # Group missions by how many red players were on the team
    mission_by_composition: list[dict] = []
    for r in range(1, 6):
        red_count_groups: dict[int, dict] = {}
        for g in games:
            m = next((m2 for m2 in g.missions if m2["round"] == r), None)
            if m is None:
                continue
            # Count red players by checking the round's team composition
            round_str = g.rounds[r - 1] if r - 1 < len(g.rounds) else ""
            # We don't have per-mission team composition directly, use fail count as proxy
            fails = m["fails"]
            entry = red_count_groups.setdefault(fails, {"pass": 0, "fail": 0})
            if m["fails"] == 0:
                entry["pass"] += 1
            else:
                entry["fail"] += 1

    # Aggregate: mission success rate correlated with game outcome
    mission_outcome_corr: list[dict] = []
    for r in range(1, 6):
        with_mission = [g for g in games if any(m2["round"] == r for m2 in g.missions)]
        if not with_mission:
            continue
        passed_games = [g for g in with_mission if any(m2["round"] == r and m2["fails"] == 0 for m2 in g.missions)]
        failed_games = [g for g in with_mission if any(m2["round"] == r and m2["fails"] > 0 for m2 in g.missions)]

        pass_then_blue_win = sum(1 for g in passed_games if g.blue_win)
        fail_then_red_win = sum(1 for g in failed_games if g.red_win)

        mission_outcome_corr.append({
            "round": r,
            "passedGames": len(passed_games),
            "passedThenBlueWin": pass_then_blue_win,
            "passedBlueWinRate": rnd1(pass_then_blue_win / len(passed_games) * 100) if passed_games else 0,
            "failedGames": len(failed_games),
            "failedThenRedWin": fail_then_red_win,
            "failedRedWinRate": rnd1(fail_then_red_win / len(failed_games) * 100) if failed_games else 0,
        })

    # Per-round outcome breakdown
    mission_outcome_by_round = []
    for r in range(1, 6):
        with_mission = [g for g in games if any(m["round"] == r for m in g.missions)]
        if not with_mission:
            continue
        all_pass = 0
        one_fail = 0
        two_fail = 0
        for g in with_mission:
            m = next((m2 for m2 in g.missions if m2["round"] == r), None)
            if m is None:
                continue
            if m["fails"] == 0:
                all_pass += 1
            elif m["fails"] == 1:
                one_fail += 1
            else:
                two_fail += 1
        mission_outcome_by_round.append({
            "round": r,
            "allPass": all_pass,
            "oneFail": one_fail,
            "twoFail": two_fail,
            "total": len(with_mission),
        })

    return {
        "missionPassRates": mission_pass_rates,
        "missionOutcomeByRound": mission_outcome_by_round,
        "missionOutcomeCorrelation": mission_outcome_corr,
    }


def compute_lake(games: list[GameRow]) -> dict:
    lake_configs = [
        ("首湖", "lake1_holder_faction", "lake1_target_faction", "lake1_holder_role", "lake1_target_role"),
        ("二湖", "lake2_holder_faction", "lake2_target_faction", "lake2_holder_role", "lake2_target_role"),
        ("三湖", "lake3_holder_faction", "lake3_target_faction", "lake3_holder_role", "lake3_target_role"),
    ]

    per_lake = []
    for label, hf_key, tf_key, hr_key, tr_key in lake_configs:
        subset = [g for g in games if getattr(g, hf_key) != ""]
        if not subset:
            continue

        # Group by holder faction
        holder_groups: dict[str, dict] = {}
        for g in subset:
            faction = getattr(g, hf_key)
            entry = holder_groups.setdefault(faction, {"count": 0, "red_wins": 0})
            entry["count"] += 1
            if g.red_win:
                entry["red_wins"] += 1

        holder_stats = [
            {
                "faction": faction,
                "games": d["count"],
                "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
            }
            for faction, d in holder_groups.items()
        ]

        # Group by holder x target faction combo
        combo_groups: dict[str, dict] = {}
        for g in subset:
            key = f"{getattr(g, hf_key)}|{getattr(g, tf_key)}"
            entry = combo_groups.setdefault(key, {"count": 0, "red_wins": 0})
            entry["count"] += 1
            if g.red_win:
                entry["red_wins"] += 1

        combo_stats = []
        for key, d in combo_groups.items():
            hf, tf = key.split("|")
            combo_stats.append({
                "holderFaction": hf,
                "targetFaction": tf,
                "games": d["count"],
                "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
            })

        per_lake.append({
            "lake": label,
            "totalGames": len(subset),
            "holderStats": holder_stats,
            "comboStats": combo_stats,
        })

    # Holder role stats (首湖 only)
    lake1_games = [g for g in games if g.lake1_holder_faction != ""]
    holder_role_groups: dict[str, dict] = {}
    for g in lake1_games:
        role = g.lake1_holder_role
        if not role:
            continue
        entry = holder_role_groups.setdefault(role, {"count": 0, "red_wins": 0, "blue_wins": 0})
        entry["count"] += 1
        if g.red_win:
            entry["red_wins"] += 1
        if g.blue_win:
            entry["blue_wins"] += 1

    holder_role_stats = [
        {
            "role": role,
            "games": d["count"],
            "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
            "blueWinRate": rnd1(d["blue_wins"] / d["count"] * 100),
        }
        for role, d in holder_role_groups.items()
    ]

    # Target role stats
    target_role_groups: dict[str, dict] = {}
    for g in lake1_games:
        role = g.lake1_target_role
        if not role:
            continue
        entry = target_role_groups.setdefault(role, {"count": 0, "red_wins": 0})
        entry["count"] += 1
        if g.red_win:
            entry["red_wins"] += 1

    target_role_stats = [
        {
            "role": role,
            "games": d["count"],
            "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
        }
        for role, d in target_role_groups.items()
    ]

    # Fix #12: Enhanced lake analysis -- per-lake role stats and cross-lake patterns
    # Role stats for all 3 lakes, not just lake1
    all_lake_role_stats = []
    for lake_idx, (label, hf_key, tf_key, hr_key, tr_key) in enumerate(lake_configs):
        lake_games = [g for g in games if getattr(g, hf_key) != ""]
        if not lake_games:
            continue

        # Holder role stats for this lake
        h_role_groups: dict[str, dict] = {}
        for g in lake_games:
            role = getattr(g, hr_key)
            if not role:
                continue
            entry = h_role_groups.setdefault(role, {"count": 0, "red_wins": 0, "blue_wins": 0})
            entry["count"] += 1
            if g.red_win:
                entry["red_wins"] += 1
            if g.blue_win:
                entry["blue_wins"] += 1

        h_stats = [
            {
                "role": role,
                "games": d["count"],
                "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
                "blueWinRate": rnd1(d["blue_wins"] / d["count"] * 100),
            }
            for role, d in h_role_groups.items()
        ]

        # Target role stats for this lake
        t_role_groups: dict[str, dict] = {}
        for g in lake_games:
            role = getattr(g, tr_key)
            if not role:
                continue
            entry = t_role_groups.setdefault(role, {"count": 0, "red_wins": 0})
            entry["count"] += 1
            if g.red_win:
                entry["red_wins"] += 1

        t_stats = [
            {
                "role": role,
                "games": d["count"],
                "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
            }
            for role, d in t_role_groups.items()
        ]

        # Holder->Target same/different faction outcome
        same_faction = [g for g in lake_games if getattr(g, hf_key) == getattr(g, tf_key) and getattr(g, tf_key) != ""]
        diff_faction = [g for g in lake_games if getattr(g, hf_key) != getattr(g, tf_key) and getattr(g, tf_key) != ""]

        all_lake_role_stats.append({
            "lake": label,
            "holderRoleStats": h_stats,
            "targetRoleStats": t_stats,
            "sameFaction": {
                "games": len(same_faction),
                "redWinRate": rnd1(sum(1 for g in same_faction if g.red_win) / len(same_faction) * 100) if same_faction else 0,
            },
            "diffFaction": {
                "games": len(diff_faction),
                "redWinRate": rnd1(sum(1 for g in diff_faction if g.red_win) / len(diff_faction) * 100) if diff_faction else 0,
            },
        })

    return {
        "perLake": per_lake,
        "holderRoleStats": holder_role_stats,
        "targetRoleStats": target_role_stats,
        "allLakeRoleStats": all_lake_role_stats,
    }


def compute_seat_order(games: list[GameRow]) -> dict:
    """Analyze the 6 permutations of Percival(派)/Merlin(梅)/Morgana(娜) seating order.

    For each game, find seats of 派西, 梅林, 娜美, determine their clockwise order,
    then split by outcome: 三藍梅活, 三藍梅死, 三紅.
    Also check if missions fall between (穿插) these three players.
    """
    from itertools import permutations

    TRIO_ROLES = {"派西", "梅林", "娜美"}
    PERM_LABELS = [
        "派梅娜", "派娜梅", "梅派娜", "梅娜派", "娜派梅", "娜梅派",
    ]

    def get_trio_order(seat_roles: dict[str, str]) -> str | None:
        """Return the clockwise order of 派/梅/娜 as a string like '派梅娜'."""
        role_to_seat: dict[str, int] = {}
        for seat_char, role in seat_roles.items():
            if role in TRIO_ROLES:
                try:
                    role_to_seat[role] = int(seat_char) if seat_char != "0" else 10
                except ValueError:
                    continue
        if len(role_to_seat) != 3:
            return None

        # Sort by seat number to get clockwise order
        sorted_roles = sorted(role_to_seat.items(), key=lambda x: x[1])
        # Generate the 3 possible rotations and pick the one starting with lowest seat
        trio = [r[0] for r in sorted_roles]
        # Map role names to short labels
        short = {"派西": "派", "梅林": "梅", "娜美": "娜"}
        return "".join(short.get(r, r[0]) for r in trio)

    def has_interleaving(seat_roles: dict[str, str]) -> bool:
        """Check if other players' seats are between the trio (派/梅/娜).

        On a 10-seat circular table, find the 3 trio seats and check whether
        they are all adjacent (no interleaving) or have gaps with other
        players between them.

        Example: seats 1=梅林, 2=忠臣, 3=莫甘娜, 4=派西 → True (忠臣 between)
        Example: seats 1=梅林, 2=莫甘娜, 3=派西 → False (all adjacent)
        """
        trio_seats: list[int] = []
        for seat_char, role in seat_roles.items():
            if role in TRIO_ROLES:
                try:
                    trio_seats.append(int(seat_char) if seat_char != "0" else 10)
                except ValueError:
                    continue
        if len(trio_seats) != 3:
            return False

        trio_seats.sort()
        num_players = 10

        # Calculate the 3 arc gaps between consecutive trio members on the
        # circular table.  If they are all adjacent, the gaps should be
        # {1, 1, num_players - 2} in some order.
        gaps = [
            (trio_seats[1] - trio_seats[0]) % num_players,
            (trio_seats[2] - trio_seats[1]) % num_players,
            (trio_seats[0] - trio_seats[2]) % num_players,
        ]
        # Sort the gaps: for adjacent trio the smallest two gaps are both 1
        gaps.sort()
        # Adjacent means the two smallest gaps are 1 (directly next to each other)
        return not (gaps[0] == 1 and gaps[1] == 1)

    # Collect stats per permutation
    perm_stats: dict[str, dict] = {}
    for label in PERM_LABELS:
        perm_stats[label] = {
            "total": 0,
            "三藍梅活": 0, "三藍梅死": 0, "三紅": 0,
            "穿插任務": 0,
            "redWins": 0, "blueWins": 0,
            "穿插紅勝": 0, "無穿插紅勝": 0,
            "無穿插": 0,
        }

    for g in games:
        order = get_trio_order(g.seat_roles)
        if order is None or order not in perm_stats:
            continue

        stats = perm_stats[order]
        stats["total"] += 1

        if g.outcome == "三藍活":
            stats["三藍梅活"] += 1
        elif g.outcome == "三藍死":
            stats["三藍梅死"] += 1
        elif g.outcome == "三紅":
            stats["三紅"] += 1

        if g.red_win:
            stats["redWins"] += 1
        if g.blue_win:
            stats["blueWins"] += 1

        interleaved = has_interleaving(g.seat_roles)
        if interleaved:
            stats["穿插任務"] += 1
            if g.red_win:
                stats["穿插紅勝"] += 1
        else:
            stats["無穿插"] += 1
            if g.red_win:
                stats["無穿插紅勝"] += 1

    result = []
    for label in PERM_LABELS:
        s = perm_stats[label]
        total = s["total"]
        if total == 0:
            continue
        interleave_count = s["穿插任務"]
        no_interleave_count = s["無穿插"]
        result.append({
            "order": label,
            "total": total,
            "三藍梅活": s["三藍梅活"],
            "三藍梅死": s["三藍梅死"],
            "三紅": s["三紅"],
            "三藍梅活pct": rnd1(s["三藍梅活"] / total * 100),
            "三藍梅死pct": rnd1(s["三藍梅死"] / total * 100),
            "三紅pct": rnd1(s["三紅"] / total * 100),
            "穿插任務": interleave_count,
            "redWinRate": rnd1(s["redWins"] / total * 100),
            "blueWinRate": rnd1(s["blueWins"] / total * 100),
            "merlinKillRate": rnd1(s["三藍梅死"] / total * 100),
            "穿插率": rnd1(interleave_count / total * 100),
            "穿插紅勝率": rnd1(s["穿插紅勝"] / interleave_count * 100) if interleave_count > 0 else 0,
            "無穿插紅勝率": rnd1(s["無穿插紅勝"] / no_interleave_count * 100) if no_interleave_count > 0 else 0,
        })

    # Overall summary
    total_games = sum(s["total"] for s in perm_stats.values())
    total_red = sum(s["redWins"] for s in perm_stats.values())

    return {
        "permutations": result,
        "totalGames": total_games,
        "overallRedWinRate": rnd1(total_red / total_games * 100) if total_games > 0 else 0,
    }


def compute_rounds(games: list[GameRow]) -> dict:
    valid = [g for g in games if len(g.r11_seats) > 0]

    def mission1_pass_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        passed = sum(
            1 for g in gs
            if any(m["round"] == 1 and m["fails"] == 0 for m in g.missions)
        )
        return rnd1(passed / len(gs) * 100)

    def red_win_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        return rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100)

    def blue_win_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        return rnd1(sum(1 for g in gs if g.blue_win) / len(gs) * 100)

    def merlin_kill_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        return rnd1(sum(1 for g in gs if g.merlin_killed) / len(gs) * 100)

    merlin_in = [g for g in valid if g.r11_has_merlin]
    merlin_out = [g for g in valid if not g.r11_has_merlin]
    perc_in = [g for g in valid if g.r11_has_percival]
    perc_out = [g for g in valid if not g.r11_has_percival]

    vision_stats = {
        "merlinInTeam": {
            "games": len(merlin_in),
            "mission1PassRate": mission1_pass_rate(merlin_in),
            "redWinRate": red_win_rate(merlin_in),
            "blueWinRate": blue_win_rate(merlin_in),
        },
        "merlinNotInTeam": {
            "games": len(merlin_out),
            "mission1PassRate": mission1_pass_rate(merlin_out),
            "redWinRate": red_win_rate(merlin_out),
            "blueWinRate": blue_win_rate(merlin_out),
        },
        "percivalInTeam": {
            "games": len(perc_in),
            "mission1PassRate": mission1_pass_rate(perc_in),
            "redWinRate": red_win_rate(perc_in),
        },
        "percivalNotInTeam": {
            "games": len(perc_out),
            "mission1PassRate": mission1_pass_rate(perc_out),
            "redWinRate": red_win_rate(perc_out),
        },
    }

    # Red count in R1-1
    red_count_groups: dict[int, list[GameRow]] = defaultdict(list)
    for g in valid:
        red_count_groups[g.r11_red_count].append(g)

    red_in_r11 = sorted(
        [
            {
                "redCount": rc,
                "games": len(gs),
                "mission1PassRate": mission1_pass_rate(gs),
                "redWinRate": red_win_rate(gs),
            }
            for rc, gs in red_count_groups.items()
        ],
        key=lambda x: x["redCount"],
    )

    # Mission 1 branching
    with_m1 = [g for g in games if g.round_results[0] and len(g.round_results[0]) > 0]
    m1_passed = [g for g in with_m1 if count_mission_fails(g.round_results[0]) == 0]
    m1_failed = [g for g in with_m1 if count_mission_fails(g.round_results[0]) > 0]

    mission1_branch = [
        {"passed": True, "games": len(m1_passed), "redWinRate": red_win_rate(m1_passed), "merlinKillRate": merlin_kill_rate(m1_passed)},
        {"passed": False, "games": len(m1_failed), "redWinRate": red_win_rate(m1_failed), "merlinKillRate": merlin_kill_rate(m1_failed)},
    ]

    # Round progression
    round_labels = ["第一局", "第二局", "第三局", "第四局", "第五局"]
    round_progression: dict = {}
    for r_idx in range(5):
        with_round = [g for g in games if g.rounds[r_idx] and len(g.rounds[r_idx]) > 0]
        if not with_round:
            continue
        blue_count = sum(1 for g in with_round if g.rounds[r_idx] == "藍")
        red_count = sum(1 for g in with_round if g.rounds[r_idx] == "紅")
        round_progression[round_labels[r_idx]] = {
            "bluePct": rnd1(blue_count / len(with_round) * 100),
            "redPct": rnd1(red_count / len(with_round) * 100),
            "total": len(with_round),
        }

    # Game states (top 20)
    state_groups: dict[str, dict] = {}
    for g in games:
        if not g.game_state:
            continue
        entry = state_groups.setdefault(g.game_state, {"count": 0, "red_wins": 0})
        entry["count"] += 1
        if g.red_win:
            entry["red_wins"] += 1

    game_states = sorted(
        [
            {
                "state": s,
                "games": d["count"],
                "redWinRate": rnd1(d["red_wins"] / d["count"] * 100),
            }
            for s, d in state_groups.items()
        ],
        key=lambda x: x["games"],
        reverse=True,
    )[:20]

    return {
        "visionStats": vision_stats,
        "redInR11": red_in_r11,
        "mission1Branch": mission1_branch,
        "roundProgression": round_progression,
        "gameStates": game_states,
    }


def compute_players_endpoint(players: list[dict]) -> dict:
    """Matches GET /api/analysis/players response shape."""
    return {"players": players, "total": len(players)}


def compute_player_details(players: list[dict]) -> dict[str, dict]:
    """Pre-compute per-player detail + radar for GET /api/analysis/players/:name.

    Fix #7: Radar dimensions changed to:
    - 藍方勝率(三藍梅活) = blueMerlinAlive (blue wins where Merlin survives)
    - 紅方任務勝率(三紅) = red3Red (red wins by 3 failed missions)
    - 紅方刺殺勝率(三藍梅死) = redMerlinDead (red wins via Merlin assassination)
    - 位置率 = positionTheory
    - 理論勝率 = roleTheory
    Removed: 藍角率, 紅角率 (not important)
    """
    result: dict[str, dict] = {}
    for p in players:
        radar = {
            "blueMerlinAlive": p["blueMerlinAlive"],
            "red3Red": p["red3Red"],
            "redMerlinDead": p["redMerlinDead"],
            "positionTheory": p["positionTheory"],
            "roleTheory": p["roleTheory"],
        }
        result[p["name"]] = {"player": p, "radar": radar}
    return result


# ---------------------------------------------------------------------------
# Captain Analysis
# ---------------------------------------------------------------------------

_MISSION_RESULT_RE = re.compile(r'^[oxOX]+$')
_LAKE_RE = re.compile(r'^\d+>\d+')


def _parse_captain_per_mission(text_record: str) -> list[str | None]:
    """Return captain seat char for each completed mission in a game record.

    The captain is the first digit of the last team proposal line immediately
    before a mission result line (ooo / ooox / OOX etc).  Lake lines (N>M)
    reset the current candidate and are not treated as proposals.

    Returns a list of up to 5 elements; an element is None when no proposal
    precedes the corresponding result line.
    """
    missions: list[str | None] = []
    last_proposal_captain: str | None = None

    for raw_line in re.split(r'\r?\n', text_record.strip()):
        line = raw_line.strip()
        if not line:
            continue
        if _LAKE_RE.match(line):
            last_proposal_captain = None
            continue
        if _MISSION_RESULT_RE.match(line):
            missions.append(last_proposal_captain)
            last_proposal_captain = None
            continue
        if line[0].isdigit():
            last_proposal_captain = line[0]

    return missions


def compute_captain_analysis(games: list[GameRow]) -> dict:
    """Compute captain faction vs mission outcome statistics.

    For each game we parse the 文字記錄 (text_record stored in GameRow) and
    identify which seat captained each mission.  We then map the seat to its
    role and faction (red / blue).

    Two output tables:
    - perMission: for missions 1-5, what fraction of captains were red vs blue
    - captainFactionVsOutcome: for each (captainFaction, missionResult) combo,
      count and percentage of occurrences
    """
    # Per-mission counters: mission_idx (0-4) -> {"red": n, "blue": n, "total": n}
    per_mission: list[dict[str, int]] = [
        {"red": 0, "blue": 0, "total": 0} for _ in range(5)
    ]

    # Faction x outcome counters
    # keys: (faction_str, mission_pass_bool) -> count
    faction_outcome: dict[tuple[str, bool], int] = defaultdict(int)
    faction_outcome_total: dict[str, int] = defaultdict(int)

    for g in games:
        # text_record must be fetched from the raw sheet; GameRow doesn't store
        # it directly.  We attach it in load_game_log below via a new attribute.
        text_record: str = getattr(g, "text_record", "") or ""
        if not text_record:
            continue

        captains = _parse_captain_per_mission(text_record)

        for m_idx, captain_seat in enumerate(captains):
            if m_idx >= 5:
                break
            if captain_seat is None:
                continue

            role = g.seat_roles.get(captain_seat, "忠臣")
            faction = role_faction(role)
            if not faction:
                faction = "藍方"  # 忠臣 → blue

            # Determine mission pass/fail from missions list
            mission_data = next(
                (m for m in g.missions if m["round"] == m_idx + 1), None
            )
            if mission_data is None:
                continue
            passed = mission_data["fails"] == 0

            per_mission[m_idx]["total"] += 1
            if faction == "紅方":
                per_mission[m_idx]["red"] += 1
            else:
                per_mission[m_idx]["blue"] += 1

            faction_outcome[(faction, passed)] += 1
            faction_outcome_total[faction] += 1

    # Build perMission output
    per_mission_out: list[dict] = []
    for m_idx, counts in enumerate(per_mission):
        total = counts["total"]
        if total == 0:
            continue
        per_mission_out.append({
            "mission": m_idx + 1,
            "redCaptainRate": rnd1(counts["red"] / total * 100),
            "blueCaptainRate": rnd1(counts["blue"] / total * 100),
            "games": total,
        })

    # Build captainFactionVsOutcome output
    faction_vs_outcome_out: list[dict] = []
    for (faction, passed), count in sorted(faction_outcome.items()):
        total_for_faction = faction_outcome_total[faction]
        faction_vs_outcome_out.append({
            "captainFaction": faction,
            "missionResult": "pass" if passed else "fail",
            "count": count,
            "percentage": rnd1(count / total_for_faction * 100) if total_for_faction > 0 else 0.0,
        })

    # Win-rate when red/blue captain leads a mission that passes vs fails
    # Extra cut: among games where red captain led, how often did blue win?
    # Group by faction -> outcome -> game outcome
    faction_mission_game: dict[tuple[str, bool], dict[str, int]] = defaultdict(
        lambda: {"red_game_win": 0, "blue_game_win": 0, "total": 0}
    )
    for g in games:
        text_record = getattr(g, "text_record", "") or ""
        if not text_record:
            continue
        captains = _parse_captain_per_mission(text_record)
        for m_idx, captain_seat in enumerate(captains):
            if m_idx >= 5 or captain_seat is None:
                continue
            role = g.seat_roles.get(captain_seat, "忠臣")
            faction = role_faction(role) or "藍方"
            mission_data = next(
                (m for m in g.missions if m["round"] == m_idx + 1), None
            )
            if mission_data is None:
                continue
            passed = mission_data["fails"] == 0
            entry = faction_mission_game[(faction, passed)]
            entry["total"] += 1
            if g.red_win:
                entry["red_game_win"] += 1
            if g.blue_win:
                entry["blue_game_win"] += 1

    captain_mission_game_win_rates: list[dict] = []
    for (faction, passed), entry in sorted(faction_mission_game.items()):
        total = entry["total"]
        if total == 0:
            continue
        captain_mission_game_win_rates.append({
            "captainFaction": faction,
            "missionResult": "pass" if passed else "fail",
            "totalMissions": total,
            "redGameWinRate": rnd1(entry["red_game_win"] / total * 100),
            "blueGameWinRate": rnd1(entry["blue_game_win"] / total * 100),
        })

    return {
        "perMission": per_mission_out,
        "captainFactionVsOutcome": faction_vs_outcome_out,
        "captainMissionGameWinRates": captain_mission_game_win_rates,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("Connecting to Google Sheets...")
    sh = connect()

    print("Loading game log (牌譜)...")
    games = load_game_log(sh)
    print(f"  Loaded {len(games)} games")

    print("Loading player stats...")
    players = load_player_stats(sh)
    print(f"  Loaded {len(players)} players")

    print("Loading chemistry matrices...")
    chemistry = load_chemistry(sh)
    print(f"  Loaded {len(chemistry)} matrices")

    print("Computing endpoint responses...")
    cache = {
        "overview": compute_overview(games, players),
        "players": compute_players_endpoint(players),
        "playerDetails": compute_player_details(players),
        "chemistry": chemistry,
        "missions": compute_missions(games),
        "lake": compute_lake(games),
        "rounds": compute_rounds(games),
        "seatOrder": compute_seat_order(games),
        "captainAnalysis": compute_captain_analysis(games),
    }

    print(f"Writing to {OUTPUT_PATH}...")
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)

    size_mb = OUTPUT_PATH.stat().st_size / (1024 * 1024)
    print(f"Done. {OUTPUT_PATH.name}: {size_mb:.2f} MB")
    print(f"  overview: {cache['overview']['totalGames']} games, {cache['overview']['totalPlayers']} players")
    print(f"  players: {cache['players']['total']} entries")
    print(f"  playerDetails: {len(cache['playerDetails'])} entries")
    print(f"  chemistry: {len(cache['chemistry'])} matrices")


if __name__ == "__main__":
    main()
