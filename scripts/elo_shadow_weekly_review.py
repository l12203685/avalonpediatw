#!/usr/bin/env python3
"""
elo_shadow_weekly_review.py — #54 Phase 3 observation-window review

Pulls the live `rankings/` and shadow `rankings_shadow/` paths from Firebase
RTDB, compares the ladders, and prints the gate-decision metrics.

Designed to be run weekly during the 2-week observation window (Week 1 early
snapshot, Week 2 final gate). Read-only — never writes to either path.

Gate thresholds (see staging/elo_shadow_week1_checklist.md):

  Top20 overlap >= 50%             → advise ship
  Top20 overlap 40-50%             → continue observing
  Top20 overlap < 40%              → advise rollback
  avg |shadow_delta| > 200 ELO     → investigate factor weights
  anomaly rate (|delta| > 200) > 5%→ investigate outliers

Usage:
    # Via Firebase Admin SDK (requires GOOGLE_APPLICATION_CREDENTIALS env)
    python scripts/elo_shadow_weekly_review.py --source firebase

    # Offline: feed pre-exported JSON dumps
    python scripts/elo_shadow_weekly_review.py \
        --source json \
        --live-json /tmp/rankings.json \
        --shadow-json /tmp/rankings_shadow.json

    # With custom gate thresholds
    python scripts/elo_shadow_weekly_review.py \
        --source json --live-json a.json --shadow-json b.json \
        --top-n 20 --min-games 30

Status: STUB — Firebase-backed reader is not wired yet (intentional; Phase 3
observation window hasn't started). The JSON-mode reader and the gate
calculator are complete so the script can run the moment Edward provides the
dumps (or the `export-rankings.ts` tool lands).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class LadderEntry:
    uid: str
    display_name: str
    elo: int
    total_games: int


@dataclass
class GateResult:
    top_n: int
    overlap_count: int
    overlap_pct: float
    live_top_avg: float
    shadow_top_avg: float
    avg_abs_delta: float
    anomaly_pct: float
    decision: str


def load_ladder_from_json(path: Path, elo_field: str) -> list[LadderEntry]:
    """Load a ladder from a Firebase RTDB JSON export.

    Expected shape (map of uid -> entry):
        {"<uid>": {"displayName": "...", "<elo_field>": 1234, "totalGames": 50}, ...}
    """
    with path.open(encoding="utf-8") as fh:
        raw: dict[str, Any] = json.load(fh)

    entries: list[LadderEntry] = []
    for uid, row in raw.items():
        if not isinstance(row, dict):
            continue
        elo = row.get(elo_field)
        if not isinstance(elo, (int, float)):
            continue
        entries.append(
            LadderEntry(
                uid=uid,
                display_name=str(row.get("displayName", uid)),
                elo=int(elo),
                total_games=int(row.get("totalGames", 0)),
            )
        )
    return entries


def load_ladder_from_firebase(path_ref: str, elo_field: str) -> list[LadderEntry]:
    """Placeholder — wire up firebase-admin here when observation window starts.

    Path ref: either 'rankings' or 'rankings_shadow'. Elo field: 'eloRating' for
    live, 'shadowElo' for shadow. Requires GOOGLE_APPLICATION_CREDENTIALS.
    """
    raise NotImplementedError(
        "Firebase-backed reader not implemented yet. Use --source json with "
        "pre-exported dumps (or land export-rankings.ts tool). See top of file."
    )


def compute_gate(
    live: list[LadderEntry],
    shadow: list[LadderEntry],
    top_n: int,
    min_games: int,
) -> GateResult:
    live_eligible = [e for e in live if e.total_games >= min_games]
    shadow_eligible = [e for e in shadow if e.total_games >= min_games]

    live_top = sorted(live_eligible, key=lambda e: e.elo, reverse=True)[:top_n]
    shadow_top = sorted(shadow_eligible, key=lambda e: e.elo, reverse=True)[:top_n]

    live_uids = {e.uid for e in live_top}
    shadow_uids = {e.uid for e in shadow_top}
    overlap = live_uids & shadow_uids

    overlap_count = len(overlap)
    overlap_pct = overlap_count / top_n if top_n > 0 else 0.0

    live_avg = sum(e.elo for e in live_top) / max(len(live_top), 1)
    shadow_avg = sum(e.elo for e in shadow_top) / max(len(shadow_top), 1)

    # Compare same-uid deltas (live elo vs shadow elo for players appearing in both).
    live_by_uid = {e.uid: e.elo for e in live_eligible}
    shadow_by_uid = {e.uid: e.elo for e in shadow_eligible}
    paired = [
        abs(shadow_by_uid[u] - live_by_uid[u])
        for u in live_by_uid
        if u in shadow_by_uid
    ]
    avg_abs_delta = sum(paired) / max(len(paired), 1)
    anomaly_pct = (
        sum(1 for d in paired if d > 200) / max(len(paired), 1) if paired else 0.0
    )

    if overlap_pct >= 0.50 and anomaly_pct <= 0.05:
        decision = "SHIP — overlap >= 50%, anomalies <= 5%"
    elif overlap_pct >= 0.40:
        decision = "CONTINUE — overlap in 40-50% band; extend observation window"
    else:
        decision = "ROLLBACK — overlap < 40%, shadow too divergent from live"

    return GateResult(
        top_n=top_n,
        overlap_count=overlap_count,
        overlap_pct=overlap_pct,
        live_top_avg=live_avg,
        shadow_top_avg=shadow_avg,
        avg_abs_delta=avg_abs_delta,
        anomaly_pct=anomaly_pct,
        decision=decision,
    )


def print_report(gate: GateResult, week_label: str) -> None:
    print(f"# ELO Phase 3 Shadow Review — {week_label}")
    print()
    print(f"Top-{gate.top_n} overlap: {gate.overlap_count}/{gate.top_n} ({gate.overlap_pct:.1%})")
    print(f"Live  Top-{gate.top_n} avg ELO: {gate.live_top_avg:.0f}")
    print(f"Shadow Top-{gate.top_n} avg ELO: {gate.shadow_top_avg:.0f}")
    print(f"Avg |shadow - live| ELO (paired): {gate.avg_abs_delta:.1f}")
    print(f"Anomaly rate (|delta| > 200 ELO): {gate.anomaly_pct:.1%}")
    print()
    print(f"Gate decision: {gate.decision}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="#54 Phase 3 shadow-mode weekly review (read-only)."
    )
    parser.add_argument(
        "--source",
        choices=("firebase", "json"),
        default="json",
        help="Where to pull rankings from.",
    )
    parser.add_argument("--live-json", type=Path, help="Live rankings JSON export.")
    parser.add_argument(
        "--shadow-json", type=Path, help="Shadow rankings JSON export."
    )
    parser.add_argument(
        "--top-n", type=int, default=20, help="Compare top-N ladder (default 20)."
    )
    parser.add_argument(
        "--min-games",
        type=int,
        default=30,
        help="Min games played for a player to count (default 30).",
    )
    parser.add_argument(
        "--week-label",
        default="Week 1",
        help="Label for the report header (e.g. 'Week 1', 'Week 2 final').",
    )
    args = parser.parse_args()

    if args.source == "firebase":
        live = load_ladder_from_firebase("rankings", "eloRating")
        shadow = load_ladder_from_firebase("rankings_shadow", "shadowElo")
    else:
        if not args.live_json or not args.shadow_json:
            print(
                "ERROR: --live-json and --shadow-json required when --source=json",
                file=sys.stderr,
            )
            return 2
        live = load_ladder_from_json(args.live_json, "eloRating")
        shadow = load_ladder_from_json(args.shadow_json, "shadowElo")

    gate = compute_gate(live, shadow, args.top_n, args.min_games)
    print_report(gate, args.week_label)

    # Zero exit on SHIP/CONTINUE; non-zero on ROLLBACK so CI can gate.
    return 0 if not gate.decision.startswith("ROLLBACK") else 1


if __name__ == "__main__":
    raise SystemExit(main())
