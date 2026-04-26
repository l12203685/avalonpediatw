"""
Patch analysis_cache.json with `playstyle` (Panel C) section.

Inputs:
- packages/server/analysis_cache.json (existing, mutated in-place)
- staging/selfplay/real_games_panel_c_playstyle.tsv
  (emitted by scripts/analyze_panel_c_playstyle.ts; per-player Firestore extract)

Output (top-level key `playstyle`):

  playstyle:
    perPlayer: {
      <playerName>: {
        r3RejectRate: { red: float|null, blue: float|null }       # 0-100; null when sample <3 votes
        r3RejectPercentile: { red: float|null, blue: float|null } # cohort percentile vs N>=20 R3+ vote players
        assassinTopSeats: [int, int, int] | null                  # top-3 seats by count, only if assassinAttempts >= 3
        assassinAttempts: int
        captainStickiness: float|null                              # 0-100, null when leaderProposals <5
        captainStickinessPercentile: float|null
        sampleSize: int                                            # totalGames
        hasData: bool                                              # true if any of the 3 metrics is non-null
      }
    }
    cohort: {
      r3Red:  { n: int, mean: float|null, std: float|null }
      r3Blue: { n: int, mean: float|null, std: float|null }
      captainStickiness: { n: int, mean: float|null, std: float|null }
      assassinAttempts: { n: int }                                 # players with attempts>=3
    }
    thresholds: {
      r3MinVotes: int                                              # 10
      assassinMinAttempts: int                                     # 3
      captainMinProposals: int                                     # 5
    }
    labels: {
      r3RejectRedLabel: '紅角 R3+ 強硬度'
      r3RejectBlueLabel: '藍角 R3+ 強硬度'
      assassinTargetLabel: '刺客目標座位偏好'
      captainStickinessLabel: '隊長 stickiness'
    }

Run:
  python3 packages/server/scripts/build_panel_c_playstyle.py
"""

import csv
import json
import statistics
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "analysis_cache.json"
TSV_PATH = Path("/mnt/c/Users/admin/staging/selfplay/real_games_panel_c_playstyle.tsv")

R3_MIN_VOTES = 10              # min R3+ votes (per camp) to compute reject rate
ASSASSIN_MIN_ATTEMPTS = 3      # min assassin attempts to show top seats
CAPTAIN_MIN_PROPOSALS = 5      # min leader proposals to show stickiness


def percentile_rank(value: float, sorted_values: List[float]) -> float:
    n = len(sorted_values)
    if n == 0:
        return 50.0
    less = sum(1 for v in sorted_values if v < value)
    equal = sum(1 for v in sorted_values if v == value)
    return round(((less + 0.5 * equal) / n) * 100, 1)


def cohort_stats(values: List[float]) -> Dict[str, Optional[float]]:
    if not values:
        return {"n": 0, "mean": None, "std": None}
    if len(values) == 1:
        return {"n": 1, "mean": round(values[0], 1), "std": 0.0}
    return {
        "n": len(values),
        "mean": round(statistics.mean(values), 1),
        "std": round(statistics.pstdev(values), 1),
    }


def safe_int(v: str) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


def main() -> None:
    print(f"[panel_c] cache: {CACHE_PATH}")
    print(f"[panel_c] tsv:   {TSV_PATH}")

    if not CACHE_PATH.exists():
        raise SystemExit(f"analysis_cache.json not found: {CACHE_PATH}")
    if not TSV_PATH.exists():
        raise SystemExit(f"playstyle TSV not found: {TSV_PATH}")

    with CACHE_PATH.open(encoding="utf-8") as f:
        cache = json.load(f)

    # Load TSV — keep only sheets:<name> entries (skip blank-seat unknown).
    tsv_rows: Dict[str, Dict[str, object]] = {}
    with TSV_PATH.open(encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            pid = row["player_id"]
            if not pid.startswith("sheets:"):
                continue
            name = pid.replace("sheets:", "", 1)
            if name == "unknown":
                continue
            try:
                hist = json.loads(row["assassin_target_seat_hist"]) if row["assassin_target_seat_hist"] else {}
            except json.JSONDecodeError:
                hist = {}
            tsv_rows[name] = {
                "totalGames":            safe_int(row["total_games"]),
                "r3VotesRed":            safe_int(row["r3_votes_red"]),
                "r3RejectsRed":          safe_int(row["r3_rejects_red"]),
                "r3VotesBlue":           safe_int(row["r3_votes_blue"]),
                "r3RejectsBlue":         safe_int(row["r3_rejects_blue"]),
                "assassinAttempts":      safe_int(row["assassin_attempts"]),
                "assassinTargetSeatHist": hist,
                "leaderProposals":       safe_int(row["leader_proposals"]),
                "leaderProposalsSame":   safe_int(row["leader_proposals_same"]),
            }

    print(f"[panel_c] TSV rows kept (sheets:* non-unknown): {len(tsv_rows)}")

    # ── Compute per-player metrics + cohort sets ────────────────────────────
    r3_red_pcts: List[float] = []
    r3_blue_pcts: List[float] = []
    captain_stickiness_pcts: List[float] = []
    assassin_eligible = 0

    raw_per_player: Dict[str, Dict[str, object]] = {}
    for name, row in tsv_rows.items():
        # R3+ red reject rate
        r3_red_pct: Optional[float] = None
        if int(row["r3VotesRed"]) >= R3_MIN_VOTES:
            r3_red_pct = round((int(row["r3RejectsRed"]) / int(row["r3VotesRed"])) * 100, 1)
            r3_red_pcts.append(r3_red_pct)

        # R3+ blue reject rate
        r3_blue_pct: Optional[float] = None
        if int(row["r3VotesBlue"]) >= R3_MIN_VOTES:
            r3_blue_pct = round((int(row["r3RejectsBlue"]) / int(row["r3VotesBlue"])) * 100, 1)
            r3_blue_pcts.append(r3_blue_pct)

        # Captain stickiness
        captain_stk: Optional[float] = None
        if int(row["leaderProposals"]) >= CAPTAIN_MIN_PROPOSALS:
            captain_stk = round((int(row["leaderProposalsSame"]) / int(row["leaderProposals"])) * 100, 1)
            captain_stickiness_pcts.append(captain_stk)

        # Assassin top seats
        assassin_attempts = int(row["assassinAttempts"])
        assassin_top_seats: Optional[List[int]] = None
        if assassin_attempts >= ASSASSIN_MIN_ATTEMPTS:
            hist = row["assassinTargetSeatHist"]
            assert isinstance(hist, dict)
            sorted_seats: List[Tuple[int, int]] = sorted(
                ((int(s), int(c)) for s, c in hist.items()),
                key=lambda t: (-t[1], t[0]),
            )
            assassin_top_seats = [s for s, _ in sorted_seats[:3]]
            assassin_eligible += 1

        raw_per_player[name] = {
            "r3RedPct": r3_red_pct,
            "r3BluePct": r3_blue_pct,
            "captainStk": captain_stk,
            "assassinTopSeats": assassin_top_seats,
            "assassinAttempts": assassin_attempts,
            "totalGames": int(row["totalGames"]),
        }

    # Sorted cohorts for percentile rank.
    sorted_red = sorted(r3_red_pcts)
    sorted_blue = sorted(r3_blue_pcts)
    sorted_stk = sorted(captain_stickiness_pcts)

    # ── Build playstyle.perPlayer for every player in cache.playerDetails ───
    playstyle_per_player: Dict[str, Dict[str, object]] = {}
    for name in cache["playerDetails"].keys():
        agg = raw_per_player.get(name)
        if agg is None:
            playstyle_per_player[name] = {
                "r3RejectRate":               {"red": None, "blue": None},
                "r3RejectPercentile":         {"red": None, "blue": None},
                "assassinTopSeats":           None,
                "assassinAttempts":           0,
                "captainStickiness":          None,
                "captainStickinessPercentile": None,
                "sampleSize":                 int(cache["playerDetails"][name]["player"].get("totalGames", 0)),
                "hasData":                    False,
            }
            continue

        red_pct = agg["r3RedPct"]
        blue_pct = agg["r3BluePct"]
        stk = agg["captainStk"]

        red_pctile = percentile_rank(red_pct, sorted_red) if isinstance(red_pct, (int, float)) else None
        blue_pctile = percentile_rank(blue_pct, sorted_blue) if isinstance(blue_pct, (int, float)) else None
        stk_pctile = percentile_rank(stk, sorted_stk) if isinstance(stk, (int, float)) else None

        has_data = (
            isinstance(red_pct, (int, float))
            or isinstance(blue_pct, (int, float))
            or isinstance(stk, (int, float))
            or agg["assassinTopSeats"] is not None
        )

        playstyle_per_player[name] = {
            "r3RejectRate":               {"red": red_pct, "blue": blue_pct},
            "r3RejectPercentile":         {"red": red_pctile, "blue": blue_pctile},
            "assassinTopSeats":           agg["assassinTopSeats"],
            "assassinAttempts":           agg["assassinAttempts"],
            "captainStickiness":          stk,
            "captainStickinessPercentile": stk_pctile,
            "sampleSize":                 agg["totalGames"],
            "hasData":                    has_data,
        }

    cache["playstyle"] = {
        "perPlayer": playstyle_per_player,
        "cohort": {
            "r3Red":             cohort_stats(r3_red_pcts),
            "r3Blue":            cohort_stats(r3_blue_pcts),
            "captainStickiness": cohort_stats(captain_stickiness_pcts),
            "assassinAttempts":  {"n": assassin_eligible},
        },
        "thresholds": {
            "r3MinVotes":          R3_MIN_VOTES,
            "assassinMinAttempts": ASSASSIN_MIN_ATTEMPTS,
            "captainMinProposals": CAPTAIN_MIN_PROPOSALS,
        },
        "labels": {
            "r3RejectRedLabel":      "紅角 R3+ 強硬度",
            "r3RejectBlueLabel":     "藍角 R3+ 強硬度",
            "assassinTargetLabel":   "刺客目標座位偏好",
            "captainStickinessLabel": "隊長 stickiness",
        },
    }

    # Sanity stats
    with_data = sum(1 for v in playstyle_per_player.values() if v["hasData"])
    print(
        f"[panel_c] playstyle perPlayer: {len(playstyle_per_player)} entries; "
        f"{with_data} hasData=true"
    )
    print(
        f"[panel_c] cohort sizes: "
        f"r3Red={len(r3_red_pcts)} r3Blue={len(r3_blue_pcts)} "
        f"captainStk={len(captain_stickiness_pcts)} assassin>=3={assassin_eligible}"
    )
    if r3_red_pcts:
        print(
            f"[panel_c] r3Red mean={statistics.mean(r3_red_pcts):.1f} "
            f"std={statistics.pstdev(r3_red_pcts):.1f}"
        )
    if r3_blue_pcts:
        print(
            f"[panel_c] r3Blue mean={statistics.mean(r3_blue_pcts):.1f} "
            f"std={statistics.pstdev(r3_blue_pcts):.1f}"
        )
    if captain_stickiness_pcts:
        print(
            f"[panel_c] captainStk mean={statistics.mean(captain_stickiness_pcts):.1f} "
            f"std={statistics.pstdev(captain_stickiness_pcts):.1f}"
        )

    with CACHE_PATH.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    print(f"[panel_c] wrote {CACHE_PATH}")


if __name__ == "__main__":
    main()
