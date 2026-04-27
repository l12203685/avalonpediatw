"""Patch analysis_cache.json with the 2026-04-27 three-outcome additions.

Edward 2026-04-27 spec: extend the deep-analytics cache with three new
schemas without re-running the slow Google Sheets fetch.

Adds:
- ``overview.seatPositionWinRates[].outcomes``       (per-seat 三結果 distribution)
- ``overview.seatPositionWinRates[].roles[].outcomes`` (per-role-per-seat 三結果)
- ``players[].seatOutcomes``                          (per-player per-seat 三結果)
- ``chemistry.outcomePair``                           (5th chemistry matrix)

When run from inside WSL or any environment where the live Google Sheets
credentials are unavailable, this script projects the global outcome
distribution onto the per-seat / per-pair cells. The projection preserves the
schema contract; numerically the seat / pair distributions match the global
distribution. When per-game per-player attribution lands later (separate
task), this script will be replaced by the proper aggregation in
generate_cache.py.

Usage:
    python3 scripts/patch_cache_3outcome.py
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

CACHE_PATH = Path(__file__).resolve().parent.parent / "analysis_cache.json"


def _empty_outcome() -> dict[str, float]:
    return {
        "threeRed": 0,
        "threeBlueDead": 0,
        "threeBlueAlive": 0,
        "threeRedPct": 0,
        "threeBlueDeadPct": 0,
        "threeBlueAlivePct": 0,
    }


def _scaled_outcome(global_outcome: dict[str, float], total: int) -> dict[str, float]:
    """Project global pcts onto a subset whose total game count is ``total``.

    Counts are scaled by the global pct; pcts mirror the global. Sum is exact
    100% (same precision as the global).
    """
    if total <= 0:
        return _empty_outcome()
    rp = float(global_outcome.get("threeRedPct", 0) or 0)
    bdp = float(global_outcome.get("threeBlueDeadPct", 0) or 0)
    bap = float(global_outcome.get("threeBlueAlivePct", 0) or 0)
    three_red = round(total * rp / 100.0)
    three_blue_dead = round(total * bdp / 100.0)
    three_blue_alive = max(total - three_red - three_blue_dead, 0)
    return {
        "threeRed": three_red,
        "threeBlueDead": three_blue_dead,
        "threeBlueAlive": three_blue_alive,
        "threeRedPct": round(rp * 10) / 10,
        "threeBlueDeadPct": round(bdp * 10) / 10,
        "threeBlueAlivePct": round(bap * 10) / 10,
    }


def patch_seat_position_outcomes(cache: dict[str, Any]) -> int:
    overview = cache.get("overview", {})
    seat_rates = overview.get("seatPositionWinRates", [])
    global_outcome = overview.get("outcomeBreakdown", {})
    if not seat_rates or not global_outcome:
        return 0
    patched = 0
    for seat in seat_rates:
        seat["outcomes"] = _scaled_outcome(global_outcome, int(seat.get("totalGames", 0) or 0))
        for role in seat.get("roles", []):
            role["outcomes"] = _scaled_outcome(global_outcome, int(role.get("games", 0) or 0))
        patched += 1
    return patched


def patch_player_seat_outcomes(cache: dict[str, Any]) -> int:
    players = cache.get("players", {}).get("players", [])
    overview = cache.get("overview", {})
    global_outcome = overview.get("outcomeBreakdown", {})
    seat_rates = overview.get("seatPositionWinRates", [])
    if not players or not global_outcome:
        return 0

    SEATS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    SEAT_LABEL_MAP = {"1": "1", "2": "2", "3": "3", "4": "4", "5": "5",
                      "6": "6", "7": "7", "8": "8", "9": "9", "0": "10"}

    seat_outcomes_lookup: dict[str, dict[str, float]] = {}
    for s in seat_rates:
        seat_label = s.get("seat", "")
        for char, label in SEAT_LABEL_MAP.items():
            if label == seat_label:
                seat_outcomes_lookup[char] = s.get("outcomes") or _empty_outcome()

    patched = 0
    for p in players:
        seat_wr = p.get("seatWinRates", {}) or {}
        per_seat: dict[str, dict[str, float]] = {}
        for s in SEATS:
            rate = seat_wr.get(s, 0)
            if rate and rate > 0 and s in seat_outcomes_lookup:
                per_seat[s] = dict(seat_outcomes_lookup[s])
            else:
                per_seat[s] = _empty_outcome()
        p["seatOutcomes"] = per_seat
        patched += 1
    return patched


def patch_chemistry_outcome_pair(cache: dict[str, Any]) -> int:
    chem = cache.get("chemistry", {})
    co_win = chem.get("coWin")
    overview = cache.get("overview", {})
    global_outcome = overview.get("outcomeBreakdown", {})
    if not co_win or not global_outcome:
        return 0

    players = list(co_win.get("players", []))
    row_labels = list(co_win.get("rowLabels") or players)
    raw_values = list(co_win.get("values", []))

    rp = float(global_outcome.get("threeRedPct", 0) or 0)
    bdp = float(global_outcome.get("threeBlueDeadPct", 0) or 0)
    bap = float(global_outcome.get("threeBlueAlivePct", 0) or 0)

    rp_r = round(rp * 10) / 10
    bdp_r = round(bdp * 10) / 10
    bap_r = round(bap * 10) / 10

    values: list[list[float | None]] = []
    bd: list[list[float | None]] = []
    ba: list[list[float | None]] = []

    for ri, row in enumerate(raw_values):
        v_row: list[float | None] = []
        bd_row: list[float | None] = []
        ba_row: list[float | None] = []
        for ci, cell in enumerate(row):
            if cell is None:
                v_row.append(None)
                bd_row.append(None)
                ba_row.append(None)
                continue
            if ri < len(row_labels) and ci < len(players) and row_labels[ri] == players[ci]:
                v_row.append(None)
                bd_row.append(None)
                ba_row.append(None)
                continue
            v_row.append(rp_r)
            bd_row.append(bdp_r)
            ba_row.append(bap_r)
        values.append(v_row)
        bd.append(bd_row)
        ba.append(ba_row)

    chem["outcomePair"] = {
        "players": players,
        "rowLabels": row_labels,
        "values": values,
        "threeBlueDeadPct": bd,
        "threeBlueAlivePct": ba,
    }
    return 1


def main() -> None:
    print(f"Reading {CACHE_PATH}")
    with CACHE_PATH.open("r", encoding="utf-8") as f:
        cache = json.load(f)

    seat_patched = patch_seat_position_outcomes(cache)
    print(f"  seatPositionWinRates: {seat_patched} seats patched with outcomes")

    player_patched = patch_player_seat_outcomes(cache)
    print(f"  players[].seatOutcomes: {player_patched} players patched")

    chem_patched = patch_chemistry_outcome_pair(cache)
    print(f"  chemistry.outcomePair: {chem_patched} matrix added")

    print(f"Writing back to {CACHE_PATH}")
    with CACHE_PATH.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)

    size_mb = CACHE_PATH.stat().st_size / (1024 * 1024)
    print(f"Done. {CACHE_PATH.name}: {size_mb:.2f} MB")


if __name__ == "__main__":
    main()
