"""
Patch analysis_cache.json with `featureStudies` section.

Hardcodes 5 high-signal feature studies extracted from staging/selfplay v7
reports (loops 136, 139, 141, 142, 143) into a structured JSON consumable
by the AnalyticsPage "特徵研究" tab.

Inputs (read-only references for source attribution; numbers are baked in):
- staging/selfplay/features_study_lake_declare_accuracy_3outcome_loop141.md
- staging/selfplay/features_study_lake_declarer_post_3outcome_loop142.md
- staging/selfplay/features_study_assassin_target_seat_3outcome_loop143.md
- staging/selfplay/features_study_vote_flip_after_team_change_3outcome_loop136.md
- staging/selfplay/features_study_5reject_round_pattern_3outcome_loop139.md

Output:
- packages/server/analysis_cache.json adds new top-level key:
    featureStudies: {
      generatedAt: ISO string,
      sampleSize: { games, links },
      features: [ { loopId, title, oneLineHook, sampleSize, visualType, data,
                    takeaway, sourceReport } ... ]   (5 items, ranked)
    }

Idempotent: rerun overwrites the section without touching other cache keys.

Run:
  python3 packages/server/scripts/build_feature_studies.py
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
CACHE_PATH = ROOT / "analysis_cache.json"
TAIPEI_TZ = _dt.timezone(_dt.timedelta(hours=8))


def _build_lake_lie_feature() -> Dict[str, Any]:
    """L141 — 湖中宣告真假率 (per-role lie rate, ordered by lie%)."""
    return {
        "loopId": "L141",
        "title": "湖中宣告真假率",
        "titleEn": "Lake Declaration Honesty by Role",
        "oneLineHook": "藍方角色幾乎不說謊 (<1.5%), 紅方刺客最會 (54%)",
        "oneLineHookEn": "Blue roles rarely lie (<1.5%); red Assassin lies most (54%).",
        "sampleSize": {"games": 2146, "links": 4064},
        "visualType": "bar",
        "data": {
            "axisLabel": "Lie %",
            "rows": [
                {"role": "刺", "roleEn": "Assassin", "camp": "red",  "lieRate": 54.09, "total": 318},
                {"role": "娜", "roleEn": "Morgana",  "camp": "red",  "lieRate": 45.33, "total": 353},
                {"role": "奧", "roleEn": "Oberon",   "camp": "red",  "lieRate": 44.72, "total": 322},
                {"role": "德", "roleEn": "Mordred",  "camp": "red",  "lieRate": 38.15, "total": 401},
                {"role": "梅", "roleEn": "Merlin",   "camp": "blue", "lieRate": 1.33,  "total": 452},
                {"role": "派", "roleEn": "Percival", "camp": "blue", "lieRate": 0.91,  "total": 441},
                {"role": "忠", "roleEn": "Loyal",    "camp": "blue", "lieRate": 0.34,  "total": 1760},
            ],
        },
        "takeaway": "AI HeuristicAgent 觀湖宣告 → 用 perRoleLieRate 表估真假機率",
        "takeawayEn": "AI heuristic agent reads lake declarations using these per-role lie priors.",
        "sourceReport": "staging/selfplay/features_study_lake_declare_accuracy_3outcome_loop141.md",
    }


def _build_lake_consistency_feature() -> Dict[str, Any]:
    """L142 — 持湖宣告後行為一致性 (leader picks consistency rate)."""
    return {
        "loopId": "L142",
        "title": "持湖宣告後言行一致度",
        "titleEn": "Lake Declarer Behavioral Consistency",
        "oneLineHook": "刺客 100% 言行一致 (掩護精準), 娜 81% 最易露馬腳",
        "oneLineHookEn": "Assassin is 100% consistent (best cover); Morgana slips most (81%).",
        "sampleSize": {"games": 2146, "links": 4064, "leaderEvents": 674},
        "visualType": "table",
        "data": {
            "rows": [
                # consistency rate from Section 2 (leader picks alignment)
                {"role": "刺", "roleEn": "Assassin", "camp": "red",  "consistencyRate": 100.00, "total": 15,  "consistent": 15,  "inconsistent": 0},
                {"role": "忠", "roleEn": "Loyal",    "camp": "blue", "consistencyRate": 95.43,  "total": 394, "consistent": 376, "inconsistent": 18},
                {"role": "梅", "roleEn": "Merlin",   "camp": "blue", "consistencyRate": 93.91,  "total": 115, "consistent": 108, "inconsistent": 7},
                {"role": "派", "roleEn": "Percival", "camp": "blue", "consistencyRate": 92.05,  "total": 88,  "consistent": 81,  "inconsistent": 7},
                {"role": "德", "roleEn": "Mordred",  "camp": "red",  "consistencyRate": 84.85,  "total": 33,  "consistent": 28,  "inconsistent": 5},
                {"role": "奧", "roleEn": "Oberon",   "camp": "red",  "consistencyRate": 84.62,  "total": 13,  "consistent": 11,  "inconsistent": 2},
                {"role": "娜", "roleEn": "Morgana",  "camp": "red",  "consistencyRate": 81.25,  "total": 16,  "consistent": 13,  "inconsistent": 3},
            ],
            # High-EV cells: top 5 by Δ三紅 magnitude (signal strength)
            "highEvCells": [
                {"label": "娜|宣藍|consistent", "labelEn": "Morgana | Declared Blue | consistent", "n": 12, "threeRedPct": 91.67, "deltaThreeRed": 45.58, "directionEn": "Morgana lying with consistent cover -> strong red"},
                {"label": "奧|宣藍|consistent", "labelEn": "Oberon | Declared Blue | consistent",  "n": 10, "threeRedPct": 90.00, "deltaThreeRed": 43.91, "directionEn": "Oberon consistent blue declaration -> strong red"},
                {"label": "梅|宣藍|consistent", "labelEn": "Merlin | Declared Blue | consistent",  "n": 83, "threeRedPct": 13.25, "deltaThreeRed": -32.83, "directionEn": "Merlin consistent blue declaration -> strong blue"},
                {"label": "忠|宣藍|inconsistent", "labelEn": "Loyal | Declared Blue | inconsistent", "n": 9,  "threeRedPct": 0.00,  "deltaThreeRed": -46.09, "directionEn": "Loyal saying blue but voting reject -> blue wins"},
                {"label": "刺|宣藍|consistent", "labelEn": "Assassin | Declared Blue | consistent", "n": 12, "threeRedPct": 66.67, "deltaThreeRed": 20.58, "directionEn": "Assassin consistent blue cover -> red leans"},
            ],
        },
        "takeaway": "言行不一 = 紅方掩護 signal; 高 EV cell 給 AI 條件機率推論",
        "takeawayEn": "Inconsistent words/actions are red-cover signal; high-EV cells feed conditional priors.",
        "sourceReport": "staging/selfplay/features_study_lake_declarer_post_3outcome_loop142.md",
    }


def _build_assassin_seat_feature() -> Dict[str, Any]:
    """L143 — 刺客 target seat 偏好 (by leader-tier and seat)."""
    return {
        "loopId": "L143",
        "title": "刺客目標座位偏好",
        "titleEn": "Assassin Target Seat Preference",
        "oneLineHook": "隊長次數最多的玩家被刺中率 49%, 沉默玩家只有 39%",
        "oneLineHookEn": "Top-leader targets get hit 49%; quiet seats only 39%.",
        "sampleSize": {"games": 2146, "attempts": 1130},
        "visualType": "bar",
        "data": {
            "axisLabel": "Hit %",
            "leaderTierRows": [
                {"tier": "top_leader", "tierEn": "Top leader (most leads)", "tierZh": "隊長次數多",  "n": 477, "hitRate": 49.06, "missRate": 50.94},
                {"tier": "mid_leader", "tierEn": "Mid leader",              "tierZh": "隊長次數中",  "n": 368, "hitRate": 42.93, "missRate": 57.07},
                {"tier": "low_leader", "tierEn": "Low leader (least leads)", "tierZh": "隊長次數少",  "n": 281, "hitRate": 39.15, "missRate": 60.85},
            ],
            "topSeatRows": [
                # Top 5 seats by absolute hit rate (showing seat-position effect)
                {"seat": 4,  "n": 127, "hitRate": 50.39},
                {"seat": 3,  "n": 102, "hitRate": 50.00},
                {"seat": 5,  "n": 181, "hitRate": 48.62},
                {"seat": 6,  "n": 108, "hitRate": 48.15},
                {"seat": 1,  "n": 100, "hitRate": 48.00},
            ],
        },
        "takeaway": "刺客模仿模式: 鎖隊長多 + 中央座位 (3-6); AI 可學該偏好調目標權重",
        "takeawayEn": "Pattern: lock onto vocal leaders in central seats (3-6); AI can mimic this prior.",
        "sourceReport": "staging/selfplay/features_study_assassin_target_seat_3outcome_loop143.md",
    }


def _build_vote_flip_feature() -> Dict[str, Any]:
    """L136 — vote flip after team change (signed EV per role)."""
    return {
        "loopId": "L136",
        "title": "改隊後投票翻轉率",
        "titleEn": "Vote Flip Rate After Team Change",
        "oneLineHook": "梅林 +1.57pp 翻得最多 (藍信號), 莫甘娜 -2.18pp 最不翻 (掩護自己)",
        "oneLineHookEn": "Merlin flips most (+1.57pp blue signal); Morgana flips least (-2.18pp covering self).",
        "sampleSize": {"games": 2146, "chances": 228754},
        "visualType": "divergent",
        "data": {
            "axisLabel": "signed EV (pp)",
            # Sorted by signed EV descending: positive = blue signal
            "rows": [
                {"role": "梅", "roleEn": "Merlin",   "camp": "blue", "signedEv": 1.57,  "totalChances": 22885, "flipRedPct": 43.37, "flipBluePct": 44.94},
                {"role": "忠", "roleEn": "Loyal",    "camp": "blue", "signedEv": 0.86,  "totalChances": 91510, "flipRedPct": 45.15, "flipBluePct": 46.01},
                {"role": "派", "roleEn": "Percival", "camp": "blue", "signedEv": 0.08,  "totalChances": 22889, "flipRedPct": 45.55, "flipBluePct": 45.62},
                {"role": "刺", "roleEn": "Assassin", "camp": "red",  "signedEv": -1.39, "totalChances": 22849, "flipRedPct": 44.03, "flipBluePct": 42.64},
                {"role": "奧", "roleEn": "Oberon",   "camp": "red",  "signedEv": -1.72, "totalChances": 22849, "flipRedPct": 44.05, "flipBluePct": 42.32},
                {"role": "德", "roleEn": "Mordred",  "camp": "red",  "signedEv": -1.96, "totalChances": 22909, "flipRedPct": 45.55, "flipBluePct": 43.58},
                {"role": "娜", "roleEn": "Morgana",  "camp": "red",  "signedEv": -2.18, "totalChances": 22863, "flipRedPct": 42.48, "flipBluePct": 40.30},
            ],
            "summary": {
                "blueOverall": 45.35,
                "redOverall":  43.10,
                "delta":        2.25,
            },
        },
        "takeaway": "高翻轉率 = 藍方 (彈性反應), 低翻轉率 = 紅方 (一致掩護)",
        "takeawayEn": "High flip = flexible blue; low flip = red coordinated cover.",
        "sourceReport": "staging/selfplay/features_study_vote_flip_after_team_change_3outcome_loop136.md",
    }


def _build_r3_forced_feature() -> Dict[str, Any]:
    """L139 — R3+ forced P5 outcome shift."""
    return {
        "loopId": "L139",
        "title": "R3+ 強制 P5 局勢偏移",
        "titleEn": "Forced P5 Round Outcome Shift",
        "oneLineHook": "R3 出現 forced P5 → 三紅率 +4.50pp, R4 +5.28pp",
        "oneLineHookEn": "R3 forced P5 boosts 3-red by +4.50pp; R4 by +5.28pp.",
        "sampleSize": {"games": 2146},
        "visualType": "line",
        "data": {
            "axisLabel": "Δ 三紅 (pp)",
            "baselineRedPct": 46.09,
            # R1 row noted as degenerate (Sheets padding); excluded from chart but listed in note
            "rows": [
                {"round": "R2", "n": 1829, "threeRedPct": 47.68, "deltaThreeRed": 1.59,  "deltaThreeBlueAlive": -0.47, "deltaThreeBlueDead": -1.12},
                {"round": "R3", "n": 858,  "threeRedPct": 50.58, "deltaThreeRed": 4.50,  "deltaThreeBlueAlive": -5.49, "deltaThreeBlueDead": 0.99},
                {"round": "R4", "n": 146,  "threeRedPct": 51.37, "deltaThreeRed": 5.28,  "deltaThreeBlueAlive": -8.51, "deltaThreeBlueDead": 3.23},
                {"round": "R5", "n": 88,   "threeRedPct": 46.59, "deltaThreeRed": 0.51,  "deltaThreeBlueAlive": -9.97, "deltaThreeBlueDead": 9.47},
            ],
            "comparison": {
                "withR3Forced":    {"n": 858,  "threeRedPct": 50.58, "deltaBaseline": 4.50},
                "withoutR3Forced": {"n": 1288, "threeRedPct": 43.09, "deltaBaseline": -3.00},
            },
            "note": "R1 forced P5 比例異常高 (Sheets 匯入 padding), 該 row 不繪入圖表。",
            "noteEn": "R1 forced P5 frequency is degenerate (Sheets import padding); not plotted.",
        },
        "takeaway": "R3 是 matchpoint, forced P5 = 隊伍 5 連 reject → 紅方掩護成功的強信號",
        "takeawayEn": "R3 is matchpoint; forced P5 (5 consecutive rejections) is a strong red-cover signal.",
        "sourceReport": "staging/selfplay/features_study_5reject_round_pattern_3outcome_loop139.md",
    }


def build_feature_studies() -> Dict[str, Any]:
    """Build the featureStudies payload (5 ranked features + meta)."""
    features: List[Dict[str, Any]] = [
        _build_lake_lie_feature(),         # 1. signal-rich
        _build_lake_consistency_feature(), # 2. signal-rich
        _build_assassin_seat_feature(),    # 3. mid signal
        _build_vote_flip_feature(),        # 4. divergent visualization
        _build_r3_forced_feature(),        # 5. line chart
    ]
    return {
        "generatedAt": _dt.datetime.now(TAIPEI_TZ).isoformat(timespec="seconds"),
        "sampleSize": {"games": 2146, "lakeLinks": 4064},
        "features": features,
    }


def main() -> None:
    print(f"[build_feature_studies] cache: {CACHE_PATH}")
    if not CACHE_PATH.exists():
        raise SystemExit(f"analysis_cache.json not found: {CACHE_PATH}")

    with CACHE_PATH.open(encoding="utf-8") as f:
        cache = json.load(f)

    payload = build_feature_studies()
    cache["featureStudies"] = payload

    with CACHE_PATH.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)

    print(
        f"[build_feature_studies] wrote {len(payload['features'])} features "
        f"(sample={payload['sampleSize']['games']} games)"
    )
    for feat in payload["features"]:
        print(f"  - {feat['loopId']} {feat['title']} ({feat['visualType']})")


if __name__ == "__main__":
    main()
