"""
Patch analysis_cache.json with `archetype` (Panel A) + `strength` (Panel B) sections.

Inputs:
- packages/server/analysis_cache.json (existing, mutated in-place)
- staging/selfplay/real_games_features_player_signatures.tsv (per-player axes)

Output:
- analysis_cache.json with two new top-level keys:

  archetype:
    perPlayer: {
      <playerName>: {
        axes: { honesty, consistency, stickiness, flip },        # raw 0-100
        percentiles: { honesty, consistency, stickiness, flip }, # 0-100, vs same N>=10 cohort
        sampleSize: int,
        hasData: bool,                                           # true if N>=10 + TSV row present
      }
    }
    cohort: {
      n: int (cohort size for percentile),
      means: { honesty, consistency, stickiness, flip },
      stds:  { honesty, consistency, stickiness, flip },
    }
    axisLabels: {
      honesty:     '誠實度',     # L141 lake_truthful_pct
      consistency: '一致度',     # L142 proxy: 100 - anomaly_vote_rate*5 (clipped)
      stickiness:  '專精度',     # proxy: top role winrate excess over 50
      flip:        '浮動度',     # L136 proxy: anomaly_vote_rate*5 (clipped)
    }

  strength:
    perPlayer: {
      <playerName>: {
        roles: [ { role, winRate, sampleSize, zScore, color } ... ],  # 7 roles
        topRoles:    [ '刺客', '梅林' ],   # top 2 by zScore (sample>=3)
        bottomRoles: [ '莫甘娜' ],         # bottom 1 by zScore (sample>=3)
        hasData: bool,
      }
    }
    cohort: {
      perRole: {
        <role>: { mean: float, std: float, n: int }   # population stats over players with sample>=3
      }
    }

Run:
  python3 packages/server/scripts/build_archetype_strength.py
"""

import csv
import json
import math
import statistics
from pathlib import Path
from typing import Dict, List, Optional

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "analysis_cache.json"
TSV_PATH = Path("/mnt/c/Users/admin/staging/selfplay/real_games_features_player_signatures.tsv")

ROLES_ORDER = ["刺客", "莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林", "忠臣"]
MIN_ROLE_SAMPLE = 3  # role winrate not shown if fewer than this many games as that role


def safe_float(v: Optional[str]) -> Optional[float]:
    if v is None or v == "N/A" or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def clip01_100(v: float) -> float:
    if v < 0: return 0.0
    if v > 100: return 100.0
    return v


def percentile_rank(value: float, sorted_values: List[float]) -> float:
    """Return 0-100 percentile of value within sorted_values. 50 = median, 100 = top."""
    n = len(sorted_values)
    if n == 0: return 50.0
    # Count values strictly less + half of equal -- standard percentile rank.
    less = sum(1 for v in sorted_values if v < value)
    equal = sum(1 for v in sorted_values if v == value)
    return round(((less + 0.5 * equal) / n) * 100, 1)


def zscore(value: float, mean: float, std: float) -> float:
    if std <= 0: return 0.0
    return round((value - mean) / std, 2)


def main() -> None:
    print(f"[build_archetype_strength] cwd={ROOT}")
    print(f"[build_archetype_strength] cache: {CACHE_PATH}")
    print(f"[build_archetype_strength] tsv:   {TSV_PATH}")

    if not CACHE_PATH.exists():
        raise SystemExit(f"analysis_cache.json not found: {CACHE_PATH}")
    if not TSV_PATH.exists():
        raise SystemExit(f"player signature TSV not found: {TSV_PATH}")

    with CACHE_PATH.open(encoding="utf-8") as f:
        cache = json.load(f)

    # ── Load per-player TSV axes ─────────────────────────────────────────
    tsv_rows: Dict[str, Dict[str, Optional[float]]] = {}
    with TSV_PATH.open(encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            name = row["player_id"].replace("sheets:", "")
            tsv_rows[name] = {
                "totalGames":              safe_float(row["total_games"]),
                "winRate":                 safe_float(row["win_rate_pct"]),
                "anomalyVoteRatePct":      safe_float(row["anomaly_vote_rate_pct"]),
                "ladyTruthfulPct":         safe_float(row["lady_truthful_pct"]),
                "redFailPerParticipation": safe_float(row["red_fail_per_participation"]),
                "topRole1":                row["top_role_1"] or None,
                "topRole1WrPct":           safe_float(row["top_role_1_wr_pct"]),
            }

    print(f"[build_archetype_strength] TSV rows: {len(tsv_rows)}")

    # ── Compute Panel A: Archetype 4 axes ────────────────────────────────
    # Axis derivation:
    #   honesty     = ladyTruthfulPct (raw 0-100, fallback 50 if no lake hold)
    #   consistency = 100 - anomalyVoteRatePct * 5 (clip 0-100); proxy for L142 言行一致
    #   stickiness  = topRole1WrPct (raw 0-100); proxy for L137 隊長堅持/角色專精
    #   flip        = anomalyVoteRatePct * 5 (clip 0-100); L136 vote_flip proxy
    raw_axes: Dict[str, Dict[str, float]] = {}
    for name, axes in tsv_rows.items():
        honesty = axes["ladyTruthfulPct"] if axes["ladyTruthfulPct"] is not None else 50.0
        anomaly = axes["anomalyVoteRatePct"] if axes["anomalyVoteRatePct"] is not None else 0.0
        consistency = clip01_100(100 - anomaly * 5)
        flip = clip01_100(anomaly * 5)
        stickiness = axes["topRole1WrPct"] if axes["topRole1WrPct"] is not None else 50.0
        raw_axes[name] = {
            "honesty":     round(honesty, 1),
            "consistency": round(consistency, 1),
            "stickiness":  round(stickiness, 1),
            "flip":        round(flip, 1),
        }

    # Cohort distribution (mean / std) for percentile + interpretation
    sorted_by_axis: Dict[str, List[float]] = {
        a: sorted(p[a] for p in raw_axes.values()) for a in ("honesty", "consistency", "stickiness", "flip")
    }
    cohort_means: Dict[str, float] = {a: round(statistics.mean(v), 1) for a, v in sorted_by_axis.items()}
    cohort_stds: Dict[str, float] = {
        a: round(statistics.pstdev(v), 1) if len(v) > 1 else 0.0
        for a, v in sorted_by_axis.items()
    }

    archetype_per_player: Dict[str, Dict] = {}
    for name in cache["playerDetails"].keys():
        if name in raw_axes:
            axes = raw_axes[name]
            percentiles = {
                a: percentile_rank(axes[a], sorted_by_axis[a])
                for a in ("honesty", "consistency", "stickiness", "flip")
            }
            archetype_per_player[name] = {
                "axes":        axes,
                "percentiles": percentiles,
                "sampleSize":  int(tsv_rows[name]["totalGames"] or 0),
                "hasData":     True,
            }
        else:
            archetype_per_player[name] = {
                "axes":        {"honesty": 0, "consistency": 0, "stickiness": 0, "flip": 0},
                "percentiles": {"honesty": 0, "consistency": 0, "stickiness": 0, "flip": 0},
                "sampleSize":  int(cache["playerDetails"][name]["player"].get("totalGames", 0)),
                "hasData":     False,  # signals UI to show "資料不足 (<10 場)"
            }

    cache["archetype"] = {
        "perPlayer": archetype_per_player,
        "cohort": {
            "n":     len(raw_axes),
            "means": cohort_means,
            "stds":  cohort_stds,
        },
        "axisLabels": {
            "honesty":     "誠實度",
            "consistency": "一致度",
            "stickiness":  "專精度",
            "flip":        "浮動度",
        },
        "axisHelp": {
            "honesty":     "持湖宣告真實率 (越高 = 越誠實)",
            "consistency": "投票異常率反向 (越高 = 言行越一致)",
            "stickiness":  "最強角色勝率 (越高 = 角色專精)",
            "flip":        "投票異常率 (越高 = 投票越浮動)",
        },
    }

    # ── Compute Panel B: Strength Signature (per-role z-score) ───────────
    # Use cache.players[].roleWinRates + rawRoleGames.
    # Cohort per-role: pool all players' winrate where rawRoleGames[role] >= MIN_ROLE_SAMPLE.

    def zh_role(r: str) -> str:
        return r  # all already in zh

    # Per-role population
    per_role_population: Dict[str, List[float]] = {r: [] for r in ROLES_ORDER}
    for entry in cache["players"]["players"]:
        wr_map = entry.get("roleWinRates", {})
        sample_map = entry.get("rawRoleGames", {})
        for role in ROLES_ORDER:
            sample = sample_map.get(role, 0)
            if sample and sample >= MIN_ROLE_SAMPLE:
                wr = wr_map.get(role)
                if wr is not None:
                    per_role_population[role].append(wr)

    cohort_per_role: Dict[str, Dict[str, float]] = {}
    for role, vals in per_role_population.items():
        if len(vals) >= 2:
            cohort_per_role[role] = {
                "mean": round(statistics.mean(vals), 1),
                "std":  round(statistics.pstdev(vals), 1),
                "n":    len(vals),
            }
        elif len(vals) == 1:
            cohort_per_role[role] = {"mean": round(vals[0], 1), "std": 0.0, "n": 1}
        else:
            cohort_per_role[role] = {"mean": 50.0, "std": 0.0, "n": 0}

    strength_per_player: Dict[str, Dict] = {}
    for entry in cache["players"]["players"]:
        name = entry["name"]
        wr_map = entry.get("roleWinRates", {})
        sample_map = entry.get("rawRoleGames", {})
        roles_signature = []
        for role in ROLES_ORDER:
            sample = int(sample_map.get(role, 0) or 0)
            wr = wr_map.get(role)
            if sample >= MIN_ROLE_SAMPLE and wr is not None:
                stat = cohort_per_role[role]
                z = zscore(wr, stat["mean"], stat["std"])
                if z >= 0.5:
                    color = "high"      # significantly above
                elif z <= -0.5:
                    color = "low"       # significantly below
                else:
                    color = "neutral"
                roles_signature.append({
                    "role":       role,
                    "winRate":    round(wr, 1),
                    "sampleSize": sample,
                    "zScore":     z,
                    "color":      color,
                })
            else:
                roles_signature.append({
                    "role":       role,
                    "winRate":    None,
                    "sampleSize": sample,
                    "zScore":     None,
                    "color":      "insufficient",
                })

        scored = [r for r in roles_signature if r["zScore"] is not None]
        scored_sorted = sorted(scored, key=lambda r: -r["zScore"])
        top_roles = [r["role"] for r in scored_sorted[:2]]
        bottom_roles = [r["role"] for r in scored_sorted[-1:]] if len(scored_sorted) >= 3 else []

        has_data = any(r["color"] != "insufficient" for r in roles_signature)

        strength_per_player[name] = {
            "roles":       roles_signature,
            "topRoles":    top_roles,
            "bottomRoles": bottom_roles,
            "hasData":     has_data,
        }

    cache["strength"] = {
        "perPlayer": strength_per_player,
        "cohort": {
            "perRole":         cohort_per_role,
            "minRoleSample":   MIN_ROLE_SAMPLE,
            "rolesOrder":      ROLES_ORDER,
        },
    }

    # ── Stats summary ────────────────────────────────────────────────────
    arche_with_data = sum(1 for v in archetype_per_player.values() if v["hasData"])
    strength_with_data = sum(1 for v in strength_per_player.values() if v["hasData"])
    print(f"[build_archetype_strength] archetype: {arche_with_data}/{len(archetype_per_player)} players with data (>=10 games)")
    print(f"[build_archetype_strength] strength:  {strength_with_data}/{len(strength_per_player)} players with data (>=3 games as some role)")
    print(f"[build_archetype_strength] cohort means (archetype): {cohort_means}")
    print(f"[build_archetype_strength] cohort per-role n: " +
          ", ".join(f"{r}={cohort_per_role[r]['n']}" for r in ROLES_ORDER))

    with CACHE_PATH.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)
    print(f"[build_archetype_strength] wrote {CACHE_PATH}")


if __name__ == "__main__":
    main()
