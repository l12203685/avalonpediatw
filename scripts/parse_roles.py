#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""M0.3 Spike — Extract structured role data from the Avalon master Excel.

Reads 牌譜 (game records) and 戰績報表 (stats report) sheets to produce
per-role JSON files for the 7 canonical Avalon roles:

  Good: Merlin(梅林), Percival(派西維爾), Loyal Servant(忠臣)
  Evil: Mordred(莫德雷德), Morgana(莫甘娜), Assassin(刺客), Oberon(奧伯倫)

Output: content/_data/roles/ directory with one JSON per role + summary.

Usage:
    python scripts/parse_roles.py [--input PATH] [--output DIR] [--verbose]
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd

TAIPEI = timezone(timedelta(hours=8))

# ---------------------------------------------------------------------------
# Canonical 7 roles — DO NOT add others
# ---------------------------------------------------------------------------
ROLE_ABBREV_MAP: dict[str, str] = {
    "刺": "assassin",
    "娜": "morgana",
    "德": "mordred",
    "奧": "oberon",
    "派": "percival",
    "梅": "merlin",
    "忠": "loyal_servant",
}

ROLE_META: dict[str, dict[str, Any]] = {
    "merlin": {
        "name_zh": "梅林",
        "name_en": "Merlin",
        "faction": "good",
        "abbrev": "梅",
        "ability": "知道所有紅方身份（除莫德雷德），但需隱藏自己不被刺殺",
        "slug": "merlin",
    },
    "percival": {
        "name_zh": "派西維爾",
        "name_en": "Percival",
        "faction": "good",
        "abbrev": "派",
        "ability": "知道梅林和莫甘娜的身份（但無法分辨誰是誰）",
        "slug": "percival",
    },
    "loyal_servant": {
        "name_zh": "忠臣",
        "name_en": "Loyal Servant",
        "faction": "good",
        "abbrev": "忠",
        "ability": "無特殊能力，依靠推理和投票幫助藍方",
        "slug": "loyal-servant",
    },
    "mordred": {
        "name_zh": "莫德雷德",
        "name_en": "Mordred",
        "faction": "evil",
        "abbrev": "德",
        "ability": "梅林無法看到莫德雷德，是紅方最強的隱藏角色",
        "slug": "mordred",
    },
    "morgana": {
        "name_zh": "莫甘娜",
        "name_en": "Morgana",
        "faction": "evil",
        "abbrev": "娜",
        "ability": "在派西維爾眼中與梅林相同，用來迷惑藍方",
        "slug": "morgana",
    },
    "assassin": {
        "name_zh": "刺客",
        "name_en": "Assassin",
        "faction": "evil",
        "abbrev": "刺",
        "ability": "藍方三勝後可刺殺梅林，刺中則紅方逆轉勝",
        "slug": "assassin",
    },
    "oberon": {
        "name_zh": "奧伯倫",
        "name_en": "Oberon",
        "faction": "evil",
        "abbrev": "奧",
        "ability": "不知道其他紅方是誰，其他紅方也看不到奧伯倫",
        "slug": "oberon",
    },
}


# ---------------------------------------------------------------------------
# Data structures (frozen for immutability)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class GameRoleRecord:
    """One game from the perspective of a role."""

    game_id: int
    result: str          # 三紅 / 三藍活 / 三藍死
    faction_won: str     # red / blue
    seat: int | None     # 0-9

@dataclass
class RoleStats:
    """Aggregated statistics for a single role."""

    role_id: str
    total_games: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    # By result type
    result_counts: dict[str, int] = field(default_factory=dict)
    # Seat distribution (which seats this role appears in)
    seat_distribution: dict[int, int] = field(default_factory=dict)
    # Win rate by seat
    seat_win_rates: dict[int, float] = field(default_factory=dict)

    def compute_rates(self) -> None:
        self.win_rate = self.wins / self.total_games if self.total_games > 0 else 0.0
        for seat, count in self.seat_distribution.items():
            seat_wins = sum(
                1 for g in self._games
                if g.seat == seat and _is_win(g, self.role_id)
            )
            self.seat_win_rates[seat] = seat_wins / count if count > 0 else 0.0

    # Internal: hold raw game refs for seat-win computation
    _games: list[GameRoleRecord] = field(default_factory=list, repr=False)


def _is_win(game: GameRoleRecord, role_id: str) -> bool:
    """Determine if this role won the game."""
    faction = ROLE_META[role_id]["faction"]
    return (
        (faction == "evil" and game.faction_won == "red")
        or (faction == "good" and game.faction_won == "blue")
    )


def _result_to_faction_won(result: str | None) -> str | None:
    """Map Chinese result text to winning faction."""
    if not result or not isinstance(result, str):
        return None
    result = result.strip()
    if result == "三紅":
        return "red"
    if result in ("三藍活", "三藍死"):
        return "blue"
    return None


# ---------------------------------------------------------------------------
# Parsing logic
# ---------------------------------------------------------------------------
def parse_game_records(xlsx_path: Path, log: logging.Logger) -> dict[str, RoleStats]:
    """Parse 牌譜 sheet to extract per-role game statistics."""
    log.info("Reading 牌譜 from %s", xlsx_path)

    df = pd.read_excel(
        xlsx_path, sheet_name="牌譜", header=0, engine="openpyxl", dtype=object,
    )

    # Role columns: 角1, 角4, 角5, 角0 (seats 1, 4, 5, 0 — the 4 special role seats)
    # Plus we can infer from 配置 (6-digit code)
    role_col_map = {
        "角1": 1,
        "角4": 4,
        "角5": 5,
        "角0": 0,
    }

    stats: dict[str, RoleStats] = {
        role_id: RoleStats(role_id=role_id) for role_id in ROLE_META
    }

    total_parsed = 0
    skipped = 0

    for _, row in df.iterrows():
        game_id_raw = row.get("流水號")
        if game_id_raw is None or pd.isna(game_id_raw):
            skipped += 1
            continue

        try:
            game_id = int(float(game_id_raw))
        except (ValueError, TypeError):
            skipped += 1
            continue

        result_raw = row.get("結果")
        faction_won = _result_to_faction_won(str(result_raw) if result_raw else None)
        if faction_won is None:
            skipped += 1
            continue

        result_str = str(result_raw).strip()

        # Extract roles from 角X columns
        for col_name, seat_num in role_col_map.items():
            role_abbrev = row.get(col_name)
            if role_abbrev is None or pd.isna(role_abbrev):
                continue
            role_abbrev = str(role_abbrev).strip()
            role_id = ROLE_ABBREV_MAP.get(role_abbrev)
            if role_id is None:
                continue

            game_rec = GameRoleRecord(
                game_id=game_id,
                result=result_str,
                faction_won=faction_won,
                seat=seat_num,
            )

            s = stats[role_id]
            s.total_games += 1
            s._games.append(game_rec)

            if _is_win(game_rec, role_id):
                s.wins += 1
            else:
                s.losses += 1

            s.result_counts[result_str] = s.result_counts.get(result_str, 0) + 1
            s.seat_distribution[seat_num] = s.seat_distribution.get(seat_num, 0) + 1

        total_parsed += 1

    # Compute derived rates
    for s in stats.values():
        s.compute_rates()

    log.info("Parsed %d games, skipped %d rows", total_parsed, skipped)
    return stats


def parse_player_role_stats(
    xlsx_path: Path, log: logging.Logger,
) -> dict[str, dict[str, float]]:
    """Parse 戰績排序 for aggregate role win rates across all players."""
    log.info("Reading 戰績排序 from %s", xlsx_path)

    df = pd.read_excel(
        xlsx_path, sheet_name="戰績排序", header=None, engine="openpyxl", dtype=object,
    )

    # Row 0 = aggregate stats, Row 1 = header, Row 2+ = player data
    # The aggregate row has overall role win rates in cols 12-19
    # (刺, 娜, 德, 奧, 派, 梅, 忠 — first set = red-side win rates)
    if len(df) < 2:
        log.warning("戰績排序 sheet too short")
        return {}

    header_row = df.iloc[1].tolist()
    agg_row = df.iloc[0].tolist()

    # Extract aggregate role win rates from the header
    # Cols 12-18: 刺, 娜, 德, 奧, 派, 梅, 忠 (role win rates)
    role_win_rates: dict[str, float] = {}
    role_order = ["刺", "娜", "德", "奧", "派", "梅", "忠"]

    for i, abbrev in enumerate(role_order):
        col_idx = 12 + i
        if col_idx < len(agg_row):
            val = agg_row[col_idx]
            try:
                rate = float(val) if val is not None and not pd.isna(val) else 0.0
                role_id = ROLE_ABBREV_MAP[abbrev]
                role_win_rates[role_id] = round(rate, 4)
            except (ValueError, TypeError):
                pass

    log.info("Aggregate role win rates: %s", role_win_rates)
    return {"aggregate_win_rates": role_win_rates}


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
def build_role_json(
    role_id: str,
    stats: RoleStats,
    agg_rates: dict[str, float],
    generated_at: str,
) -> dict[str, Any]:
    """Build the final JSON structure for one role."""
    meta = ROLE_META[role_id]
    agg_win_rate = agg_rates.get(role_id)

    return {
        "id": role_id,
        "slug": meta["slug"],
        "name_zh": meta["name_zh"],
        "name_en": meta["name_en"],
        "faction": meta["faction"],
        "abbrev": meta["abbrev"],
        "ability": meta["ability"],
        "stats": {
            "total_games": stats.total_games,
            "wins": stats.wins,
            "losses": stats.losses,
            "win_rate": round(stats.win_rate, 4),
            "aggregate_win_rate": round(agg_win_rate, 4) if agg_win_rate else None,
            "result_breakdown": dict(sorted(stats.result_counts.items())),
            "seat_distribution": {
                str(k): v for k, v in sorted(stats.seat_distribution.items())
            },
            "seat_win_rates": {
                str(k): round(v, 4)
                for k, v in sorted(stats.seat_win_rates.items())
            },
        },
        "generated_at": generated_at,
    }


def write_outputs(
    roles_data: list[dict[str, Any]],
    out_dir: Path,
    generated_at: str,
    log: logging.Logger,
) -> None:
    """Write per-role JSON files and a summary."""
    out_dir.mkdir(parents=True, exist_ok=True)

    # Per-role files
    for role in roles_data:
        path = out_dir / f"{role['id']}.json"
        path.write_text(
            json.dumps(role, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log.info("  Wrote %s (%d bytes)", path.name, path.stat().st_size)

    # Summary file with all roles
    summary = {
        "generated_at": generated_at,
        "canonical_roles": 7,
        "factions": {
            "good": [r for r in roles_data if r["faction"] == "good"],
            "evil": [r for r in roles_data if r["faction"] == "evil"],
        },
    }
    summary_path = out_dir / "roles_summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log.info("  Wrote %s (%d bytes)", summary_path.name, summary_path.stat().st_size)

    # Markdown index for wiki content
    md_path = out_dir / "roles_index.md"
    lines = [
        "---",
        "title: 阿瓦隆角色總覽",
        f"generated_at: {generated_at}",
        "---",
        "",
        "# 阿瓦隆七大角色",
        "",
        "## 藍方 (Good)",
        "",
    ]
    for r in roles_data:
        if r["faction"] == "good":
            wr = r["stats"]["win_rate"]
            lines.append(
                f"- **{r['name_zh']}** ({r['name_en']}) — "
                f"勝率 {wr:.1%}, {r['stats']['total_games']} 場"
            )
            lines.append(f"  - {r['ability']}")
    lines.extend(["", "## 紅方 (Evil)", ""])
    for r in roles_data:
        if r["faction"] == "evil":
            wr = r["stats"]["win_rate"]
            lines.append(
                f"- **{r['name_zh']}** ({r['name_en']}) — "
                f"勝率 {wr:.1%}, {r['stats']['total_games']} 場"
            )
            lines.append(f"  - {r['ability']}")

    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log.info("  Wrote %s", md_path.name)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
ENV_INPUT_VAR = "AVALON_MASTER_XLSX"

FALLBACK_PATHS = [
    Path(r"E:/阿瓦隆百科/阿瓦隆百科.xlsx"),
    Path(r"C:/Users/admin/workspace/avalonpediatw/data/master.xlsx"),
]


def find_input(explicit: str | None, log: logging.Logger) -> Path | None:
    """Resolve input xlsx path."""
    if explicit:
        p = Path(explicit)
        if p.exists():
            return p
    env = os.environ.get(ENV_INPUT_VAR)
    if env:
        p = Path(env)
        if p.exists():
            return p
    for c in FALLBACK_PATHS:
        if c.exists():
            log.info("Using fallback: %s", c)
            return c
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", default=None, help="Path to master xlsx")
    ap.add_argument("--output", default="content/_data/roles/",
                    help="Output directory for role JSON files")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    log = logging.getLogger("parse_roles")
    log.handlers.clear()
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(h)
    log.setLevel(logging.DEBUG if args.verbose else logging.INFO)

    xlsx = find_input(args.input, log)
    if xlsx is None:
        log.error(
            "Master xlsx not found. Set $%s or --input PATH.", ENV_INPUT_VAR,
        )
        return 2

    generated_at = datetime.now(TAIPEI).strftime("%Y-%m-%d %H:%M:%S +08")
    log.info("Source: %s", xlsx)
    log.info("Generated: %s", generated_at)

    # 1. Parse game records for per-role stats
    role_stats = parse_game_records(xlsx, log)

    # 2. Parse aggregate win rates
    agg_data = parse_player_role_stats(xlsx, log)
    agg_rates = agg_data.get("aggregate_win_rates", {})

    # 3. Build output
    roles_data = [
        build_role_json(role_id, role_stats[role_id], agg_rates, generated_at)
        for role_id in ROLE_META
    ]

    # 4. Write
    out_dir = Path(args.output)
    write_outputs(roles_data, out_dir, generated_at, log)

    log.info("---")
    log.info("Done. %d roles extracted to %s", len(roles_data), out_dir.resolve())
    for r in roles_data:
        s = r["stats"]
        log.info(
            "  %s (%s): %d games, %.1f%% win rate",
            r["name_zh"], r["faction"], s["total_games"], s["win_rate"] * 100,
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
