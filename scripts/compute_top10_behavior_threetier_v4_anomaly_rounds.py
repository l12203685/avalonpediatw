#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""compute_top10_behavior_threetier_v4_anomaly_rounds.py — 異常票外白/內黑 × 回合細分 (2026-04-22)

v4 vs v3 關鍵差異：
----------------------------------------
Edward 2026-04-22 15:12 指示：
  「異常票你可以分成外白/內黑以及不同回合去分析
   因為越後面的回合 異常票意義權重會越大」

語意拆解：
- **外白**（+ 號）= off_team 但投 approve（沒被選入隊卻投白）
- **內黑**（− 號）= in_team 但投 reject（被選入隊卻投黑）
- **回合**（round）= 本局第幾個 mission 任務（R1-R5）
- **權重**：越後面回合異常票意義越大（R5 決勝局異常 = 強訊號）

新增輸出欄位（向後相容 — v3 欄位全部保留）：
- `anomaly_stats.by_round[N]` (N=1..5)
  - `outer_white_rate`  = 外白票數 / 該回合 off_team 座位機會數
  - `inner_black_rate`  = 內黑票數 / 該回合 in_team 座位機會數
  - `outer_white_count` / `inner_black_count`
  - `off_team_seat_opportunities` / `in_team_seat_opportunities`
  - `attempts_in_round` / `games_with_round`
- `anomaly_stats.round_weight_suggestion` = {1: 0.5, 2: 0.7, 3: 1.0, 4: 1.3, 5: 1.8}
- `anomaly_stats.pooled_rates_for_reference` = 整體不分回合的 outer/inner rate

基礎 derivation 與 v3 完全相同（parse_game_attempts 不動），只多一組 by-round
accumulator 在主迴圈聚合。舊 situations/rollups/explicit/accepted schema 完全不變。

Usage:
    python scripts/compute_top10_behavior_threetier_v4_anomaly_rounds.py
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    print("[FATAL] pip install pyyaml first", file=sys.stderr)
    sys.exit(1)


TAIPEI = timezone(timedelta(hours=8))

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_YAML_PATH = REPO_ROOT / "content" / "_data" / "牌譜.yaml"
THREETIER_PATH = REPO_ROOT / "analysis" / "output" / "top10_players_threetier.json"
OUTPUT_DIR = REPO_ROOT / "analysis" / "output"

ATTEMPT_PATTERN = re.compile(r"^\s*(?P<team>[\d]{2,7})(?:\s+(?P<votes>.+))?\s*$")
VOTE_TOKEN_PATTERN = re.compile(r"(?P<seats>[\d]+)(?P<sign>[+-])")
QUEST_PATTERN = re.compile(r"^\s*([ox]{2,5})\s*$")
LAKE_PATTERN = re.compile(r"^\s*(?P<holder>\d)>(?P<target>\d)\s*(?P<result>[ox])\s*$")

N_PLAYERS = 10
ALL_SEATS = ("1", "2", "3", "4", "5", "6", "7", "8", "9", "0")
SEATS_WITH_ROLE = ("1", "4", "5", "0")

ROLE_CODE_TO_NAME = {
    "刺": "刺客",
    "奧": "奧伯",
    "派": "派西",
    "娜": "娜美",
    "梅": "梅林",
    "忠": "忠臣",
    "德": "德魯",
}
EVIL_ROLES = {"刺客", "奧伯", "娜美", "德魯"}
GOOD_ROLES = {"派西", "梅林", "忠臣"}

SAMPLE_HIGH = 30
SAMPLE_MED = 10


def normalize_seat(ch: str) -> int:
    return 10 if ch == "0" else int(ch)


def parse_team_seats(team_str: str) -> list[int]:
    return [normalize_seat(c) for c in team_str]


def parse_vote_tokens(votes_str: str) -> tuple[set[int], set[int]]:
    """Edward rule: + = anomalous approve (off_team white), - = anomalous reject (in_team black)."""
    approves: set[int] = set()
    rejects: set[int] = set()
    for m in VOTE_TOKEN_PATTERN.finditer(votes_str):
        seats = {normalize_seat(c) for c in m.group("seats")}
        if m.group("sign") == "+":
            approves |= seats
        else:
            rejects |= seats
    return approves, rejects


def parse_game_attempts(record: str) -> list[dict[str, Any]]:
    """Edward rule derivation:
    - Untagged seat: vote = approve if in team else reject (normal vote)
    - '+' seat:      vote = approve, is_anomaly=True  (off-team player voted yes)
    - '-' seat:      vote = reject,  is_anomaly=True  (in-team player voted no)
    """
    if not record:
        return []
    lines = [ln.strip() for ln in record.split("\n") if ln.strip()]

    items: list[dict[str, Any]] = []
    for line in lines:
        if LAKE_PATTERN.match(line):
            items.append({"kind": "lake"})
            continue
        qm = QUEST_PATTERN.match(line)
        if qm:
            items.append({"kind": "quest", "results": list(qm.group(1))})
            continue
        am = ATTEMPT_PATTERN.match(line)
        if am:
            team_str = am.group("team")
            votes_str = am.group("votes") or ""
            approves, rejects = parse_vote_tokens(votes_str)
            items.append({
                "kind": "attempt",
                "team_seats": parse_team_seats(team_str),
                "anomaly_approves": approves,  # '+' seats (off_team white)
                "anomaly_rejects": rejects,    # '-' seats (in_team black)
                "has_vote_info": bool(votes_str.strip()),
            })

    attempts: list[dict[str, Any]] = []
    round_num = 1
    attempt_in_round = 0
    global_attempt = 0
    round_failed_count = 0

    for idx, item in enumerate(items):
        if item["kind"] == "quest":
            has_fail = any(c == "x" for c in item["results"])
            if has_fail:
                round_failed_count += 1
            round_num += 1
            attempt_in_round = 0
            continue
        if item["kind"] == "lake":
            continue

        attempt_in_round += 1
        global_attempt += 1

        is_last = False
        for j in range(idx + 1, len(items)):
            nxt = items[j]
            if nxt["kind"] == "lake":
                continue
            if nxt["kind"] == "quest":
                is_last = True
            break

        leader_seat = ((global_attempt - 1) % N_PLAYERS) + 1

        team_set = set(item["team_seats"])
        anomaly_approves: set[int] = item["anomaly_approves"]
        anomaly_rejects: set[int] = item["anomaly_rejects"]

        per_seat_votes: dict[int, str] = {}
        per_seat_anomaly: dict[int, bool] = {}
        for s in range(1, N_PLAYERS + 1):
            if s in anomaly_approves:
                # off_team but voted approve (anomalous white)
                per_seat_votes[s] = "approve"
                per_seat_anomaly[s] = True
            elif s in anomaly_rejects:
                # in_team but voted reject (anomalous black)
                per_seat_votes[s] = "reject"
                per_seat_anomaly[s] = True
            else:
                # Normal: in_team → approve, off_team → reject
                per_seat_votes[s] = "approve" if s in team_set else "reject"
                per_seat_anomaly[s] = False

        attempts.append({
            "round": round_num,
            "attempt_in_round": attempt_in_round,
            "global_attempt": global_attempt,
            "team_seats": item["team_seats"],
            "anomaly_approves": sorted(anomaly_approves),
            "anomaly_rejects": sorted(anomaly_rejects),
            "has_vote_info": item["has_vote_info"],
            "is_last_in_round": is_last,
            "leader_seat": leader_seat,
            "per_seat_votes": per_seat_votes,
            "per_seat_anomaly": per_seat_anomaly,
            "failed_count_before_this": round_failed_count,
        })

    return attempts


def build_seat_to_nickname(row: dict[str, Any]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for seat_ch in ALL_SEATS:
        name = row.get(f"玩{seat_ch}")
        if isinstance(name, str) and name.strip() and name.strip() != "null":
            mapping[normalize_seat(seat_ch)] = name.strip()
    return mapping


def build_seat_to_role(row: dict[str, Any]) -> dict[int, str]:
    mapping: dict[int, str] = {}
    for seat_ch in SEATS_WITH_ROLE:
        code = row.get(f"角{seat_ch}")
        if isinstance(code, str) and code.strip():
            role = ROLE_CODE_TO_NAME.get(code.strip()[0])
            if role:
                mapping[normalize_seat(seat_ch)] = role
    return mapping


def bucket_team_size(n: int) -> str:
    if n <= 2:
        return "2"
    if n == 3:
        return "3"
    if n == 4:
        return "4"
    return "5_plus"


def bucket_stage(round_num: int) -> str:
    return "r1" if round_num == 1 else "r2_plus"


def bucket_failed(n: int) -> str:
    if n == 0:
        return "f0"
    if n == 1:
        return "f1"
    return "f2_plus"


def bucket_role(role: str | None) -> str:
    if role is None:
        return "unknown"
    if role in EVIL_ROLES:
        return "evil"
    if role in GOOD_ROLES:
        return "good"
    return "unknown"


def make_situation_key(
    role_bucket: str, stage: str, is_leader: bool, in_team: bool,
    failed_bucket: str, team_size_bucket: str,
) -> str:
    leader_key = "leader" if is_leader else "off_leader"
    team_key = "in_team" if in_team else "off_team"
    return f"{role_bucket}.{stage}.{leader_key}.{team_key}.{failed_bucket}.ts{team_size_bucket}"


def confidence_level(n: int) -> str:
    if n >= SAMPLE_HIGH:
        return "high"
    if n >= SAMPLE_MED:
        return "medium"
    if n > 0:
        return "low"
    return "none"


def compute_for_pool(
    rows: list[dict[str, Any]],
    pool_nicks: set[str],
    pool_avg_win_rate: float,
) -> dict[str, Any]:
    situation_counts: dict[str, dict[str, int]] = defaultdict(lambda: {"approve": 0, "reject": 0})
    situation_counts_explicit: dict[str, dict[str, int]] = defaultdict(lambda: {"approve": 0, "reject": 0})
    situation_counts_accepted: dict[str, dict[str, int]] = defaultdict(lambda: {"approve": 0, "reject": 0})

    games_processed = 0
    attempts_scanned = 0
    votes_counted = 0
    votes_counted_explicit = 0
    votes_counted_accepted = 0

    anomaly_approve_count = 0
    anomaly_reject_count = 0
    total_attempts_with_any_anomaly = 0

    # v4 新增：by-round cross-product 累加器
    # 每個回合 N 追蹤：
    #   outer_white_count      = 該回合 off_team 座位投 approve 的次數（+ 標）
    #   inner_black_count      = 該回合 in_team 座位投 reject 的次數（- 標）
    #   off_team_opportunities = 該回合累計 off_team 座位數（分母）
    #   in_team_opportunities  = 該回合累計 in_team 座位數（分母）
    #   attempts_in_round      = 該回合 attempts 總數
    #   games_with_round       = 有此回合的 game 數
    round_stats: dict[int, dict[str, int]] = {
        n: {
            "outer_white_count": 0,
            "inner_black_count": 0,
            "off_team_opportunities": 0,
            "in_team_opportunities": 0,
            "attempts_in_round": 0,
        } for n in (1, 2, 3, 4, 5)
    }
    round_seen_games: dict[int, set[int]] = {n: set() for n in (1, 2, 3, 4, 5)}

    for row_idx, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        record = row.get("文字記錄")
        if not record:
            continue
        seat_to_nick = build_seat_to_nickname(row)
        if not seat_to_nick:
            continue
        if not any(nick in pool_nicks for nick in seat_to_nick.values()):
            continue
        seat_to_role = build_seat_to_role(row)
        attempts = parse_game_attempts(record)
        if not attempts:
            continue
        games_processed += 1

        for att in attempts:
            attempts_scanned += 1
            team = set(att["team_seats"])
            leader = att["leader_seat"]
            round_num = att["round"]
            stage = bucket_stage(round_num)
            failed_bucket = bucket_failed(att["failed_count_before_this"])
            team_size_bucket = bucket_team_size(len(team))
            anomaly_approves_set = set(att["anomaly_approves"])
            anomaly_rejects_set = set(att["anomaly_rejects"])
            explicit_seats = anomaly_approves_set | anomaly_rejects_set

            if explicit_seats:
                total_attempts_with_any_anomaly += 1
            anomaly_approve_count += len(anomaly_approves_set)
            anomaly_reject_count += len(anomaly_rejects_set)

            # v4 新增：by-round cross-product
            #   outer_white = +  ∩ off_team（沒被選卻投白）
            #   inner_black = −  ∩ in_team（被選卻投黑）
            # 分母：該 attempt 裡 off_team/in_team 的座位數
            if 1 <= round_num <= 5:
                off_team_seats = N_PLAYERS - len(team)
                in_team_seats = len(team)
                outer_white_here = len(anomaly_approves_set - team)  # + 且不在隊
                inner_black_here = len(anomaly_rejects_set & team)   # − 且在隊
                rs = round_stats[round_num]
                rs["outer_white_count"] += outer_white_here
                rs["inner_black_count"] += inner_black_here
                rs["off_team_opportunities"] += off_team_seats
                rs["in_team_opportunities"] += in_team_seats
                rs["attempts_in_round"] += 1
                round_seen_games[round_num].add(row_idx)

            for seat, nick in seat_to_nick.items():
                if nick not in pool_nicks:
                    continue
                vote = att["per_seat_votes"].get(seat)
                if vote not in ("approve", "reject"):
                    continue
                role = seat_to_role.get(seat)
                role_bucket = bucket_role(role)
                is_leader = seat == leader
                in_team = seat in team

                key = make_situation_key(
                    role_bucket, stage, is_leader, in_team, failed_bucket, team_size_bucket,
                )
                situation_counts[key][vote] += 1
                votes_counted += 1
                if seat in explicit_seats:
                    situation_counts_explicit[key][vote] += 1
                    votes_counted_explicit += 1
                if att["is_last_in_round"]:
                    situation_counts_accepted[key][vote] += 1
                    votes_counted_accepted += 1

    def build_rollups(base_counts: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
        rc: dict[str, dict[str, int]] = defaultdict(lambda: {"approve": 0, "reject": 0})
        for key, counts in base_counts.items():
            parts = key.split(".")
            if len(parts) != 6:
                continue
            role_b, stage, leader_b, team_b, _failed, ts_b = parts
            rc[f"L1.{role_b}.{stage}.{leader_b}.{team_b}"]["approve"] += counts["approve"]
            rc[f"L1.{role_b}.{stage}.{leader_b}.{team_b}"]["reject"] += counts["reject"]
            rc[f"L2.{stage}.{leader_b}.{team_b}"]["approve"] += counts["approve"]
            rc[f"L2.{stage}.{leader_b}.{team_b}"]["reject"] += counts["reject"]
            rc[f"L3.{stage}.{team_b}"]["approve"] += counts["approve"]
            rc[f"L3.{stage}.{team_b}"]["reject"] += counts["reject"]
            rc[f"L4.{ts_b}"]["approve"] += counts["approve"]
            rc[f"L4.{ts_b}"]["reject"] += counts["reject"]
        return rc

    def finalize(counts_map: dict[str, dict[str, int]]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, c in counts_map.items():
            total = c["approve"] + c["reject"]
            out[key] = {
                "sample_size": total,
                "approve_count": c["approve"],
                "reject_count": c["reject"],
                "approve_rate": round(c["approve"] / total, 4) if total else 0.0,
                "reject_rate": round(c["reject"] / total, 4) if total else 0.0,
                "confidence": confidence_level(total),
            }
        return out

    situations_out = finalize(situation_counts)
    rollups_out = finalize(build_rollups(situation_counts))
    situations_explicit_out = finalize(situation_counts_explicit)
    rollups_explicit_out = finalize(build_rollups(situation_counts_explicit))
    situations_accepted_out = finalize(situation_counts_accepted)
    rollups_accepted_out = finalize(build_rollups(situation_counts_accepted))

    low_conf_keys = sum(1 for v in situations_out.values() if v["confidence"] == "low")
    med_conf_keys = sum(1 for v in situations_out.values() if v["confidence"] == "medium")
    high_conf_keys = sum(1 for v in situations_out.values() if v["confidence"] == "high")

    total_anomaly_tokens = anomaly_approve_count + anomaly_reject_count

    # v4 新增：by-round cross-product 收尾
    by_round_out: dict[str, dict[str, Any]] = {}
    total_outer_white = 0
    total_inner_black = 0
    total_off_team_opps = 0
    total_in_team_opps = 0
    for n in (1, 2, 3, 4, 5):
        rs = round_stats[n]
        off_opps = rs["off_team_opportunities"]
        in_opps = rs["in_team_opportunities"]
        outer_rate = round(rs["outer_white_count"] / off_opps, 5) if off_opps else 0.0
        inner_rate = round(rs["inner_black_count"] / in_opps, 5) if in_opps else 0.0
        by_round_out[str(n)] = {
            "outer_white_rate": outer_rate,
            "inner_black_rate": inner_rate,
            "outer_white_count": rs["outer_white_count"],
            "inner_black_count": rs["inner_black_count"],
            "off_team_seat_opportunities": off_opps,
            "in_team_seat_opportunities": in_opps,
            "attempts_in_round": rs["attempts_in_round"],
            "games_with_round": len(round_seen_games[n]),
        }
        total_outer_white += rs["outer_white_count"]
        total_inner_black += rs["inner_black_count"]
        total_off_team_opps += off_opps
        total_in_team_opps += in_opps

    # Round weight suggestion — Edward 原則「越後面回合權重越大」
    # 從 0.5 線性遞增到 1.8，中段 R3 設 1.0（基準）
    round_weight_suggestion = {"1": 0.5, "2": 0.7, "3": 1.0, "4": 1.3, "5": 1.8}

    pooled_outer_rate = (
        round(total_outer_white / total_off_team_opps, 5) if total_off_team_opps else 0.0
    )
    pooled_inner_rate = (
        round(total_inner_black / total_in_team_opps, 5) if total_in_team_opps else 0.0
    )

    return {
        "pool_avg_win_rate": pool_avg_win_rate,
        "top10_player_nicknames": sorted(pool_nicks),
        "games_processed": games_processed,
        "attempts_scanned": attempts_scanned,
        "votes_counted": votes_counted,
        "votes_counted_explicit": votes_counted_explicit,
        "votes_counted_accepted": votes_counted_accepted,
        "situations": situations_out,
        "rollups": rollups_out,
        "situations_explicit": situations_explicit_out,
        "rollups_explicit": rollups_explicit_out,
        "situations_accepted": situations_accepted_out,
        "rollups_accepted": rollups_accepted_out,
        "confidence_summary": {
            "total_keys": len(situations_out),
            "high_conf_keys": high_conf_keys,
            "medium_conf_keys": med_conf_keys,
            "low_conf_keys": low_conf_keys,
        },
        "anomaly_stats": {
            # v3 欄位（保留向後相容）
            "anomaly_approve_count": anomaly_approve_count,
            "anomaly_reject_count": anomaly_reject_count,
            "total_anomaly_tokens": total_anomaly_tokens,
            "attempts_with_any_anomaly": total_attempts_with_any_anomaly,
            "total_attempts": attempts_scanned,
            "anomaly_approve_ratio_of_all_votes": (
                round(anomaly_approve_count / votes_counted, 5) if votes_counted else 0.0
            ),
            "anomaly_reject_ratio_of_all_votes": (
                round(anomaly_reject_count / votes_counted, 5) if votes_counted else 0.0
            ),
            "attempts_with_anomaly_ratio": (
                round(total_attempts_with_any_anomaly / attempts_scanned, 4)
                if attempts_scanned else 0.0
            ),
            # v4 新增：異常票外白/內黑 × 回合
            "by_round": by_round_out,
            "round_weight_suggestion": round_weight_suggestion,
            "pooled_rates_for_reference": {
                "outer_white_rate": pooled_outer_rate,
                "inner_black_rate": pooled_inner_rate,
                "outer_white_count": total_outer_white,
                "inner_black_count": total_inner_black,
                "total_off_team_opportunities": total_off_team_opps,
                "total_in_team_opportunities": total_in_team_opps,
            },
            "note": (
                "by_round[N].outer_white_rate = 該 round 外白票 / off_team 座位機會數；"
                "inner_black_rate = 內黑票 / in_team 座位機會數。"
                "分母為每個 attempt 的 off/in-team 人數累加（不以玩家為單位），"
                "反映『該 round 任一 off/in-team 座位出現異常的機率』。"
                "runtime 建議以 by_round 為主，pooled_rates_for_reference 只作整體回退參考。"
            ),
        },
    }


def main() -> int:
    if not THREETIER_PATH.exists():
        print(f"[FATAL] missing {THREETIER_PATH}", file=sys.stderr)
        return 1
    if not RAW_YAML_PATH.exists():
        print(f"[FATAL] missing raw yaml: {RAW_YAML_PATH}", file=sys.stderr)
        return 1

    threetier = json.loads(THREETIER_PATH.read_text(encoding="utf-8"))
    print(f"[INFO] loading {RAW_YAML_PATH.relative_to(REPO_ROOT)}...")
    with RAW_YAML_PATH.open("r", encoding="utf-8") as f:
        rows = yaml.safe_load(f)
    if not isinstance(rows, list):
        print("[FATAL] yaml is not a list", file=sys.stderr)
        return 1

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    data_quality = {
        "vote_rule_version": "edward_2026-04-22",
        "vote_rule_description": (
            "無標 = 正常票（被選入隊→approve；沒被選→reject）；"
            "+ = 異常白票（沒被選卻投白）；"
            "- = 異常黑票（被選卻投黑）。"
            "Edward 2026-04-22 14:18 verbatim 明定。"
        ),
        "leader_rotation": (
            "10 人局順時針輪替，leader = ((global_attempt - 1) % 10) + 1。"
        ),
        "prior_rule_version_rejected": "v2: token=dissenters + is_last_in_round majority inference (2026-04-22 作廢)",
    }

    fallback_chain = [
        "situations[full_key]  (6 維 role.stage.leader.team.failed.team_size)",
        "rollups[L1.role.stage.leader.team]  (4 維 rollup)",
        "rollups[L2.stage.leader.team]  (3 維，無 role)",
        "rollups[L3.stage.team]  (2 維，最穩定)",
        "rollups[L4.team_size]  (1 維，僅 team_size)",
        "PriorLookup.getHardcode()  (Tier-3 安全值)",
    ]

    now = datetime.now(TAIPEI).isoformat()
    summary_per_tier: dict[str, Any] = {}

    for tier in ("expert", "mid", "novice"):
        tier_data = threetier[tier]
        pool_nicks = {p["nickname"] for p in tier_data["top10"]}
        pool_avg = tier_data["avg_win_rate"]
        print(f"\n[INFO] computing tier={tier} (pool size={len(pool_nicks)})")
        result = compute_for_pool(rows, pool_nicks, pool_avg)

        out = {
            "version": 4,
            "rule_version": "edward_2026-04-22",
            "anomaly_breakdown_version": "edward_2026-04-22_15:12_round_cross_product",
            "tier": tier,
            "generated_at": now,
            "source": "牌譜.yaml via internal_nickname_ranking_threetier + Edward vote rule",
            "pool_avg_win_rate": result["pool_avg_win_rate"],
            "top10_player_nicknames": result["top10_player_nicknames"],
            "games_processed": result["games_processed"],
            "attempts_scanned": result["attempts_scanned"],
            "votes_counted": result["votes_counted"],
            "votes_counted_explicit": result["votes_counted_explicit"],
            "votes_counted_accepted": result["votes_counted_accepted"],
            "confidence_summary": result["confidence_summary"],
            "anomaly_stats": result["anomaly_stats"],
            "situations": result["situations"],
            "rollups": result["rollups"],
            "situations_explicit": result["situations_explicit"],
            "rollups_explicit": result["rollups_explicit"],
            "situations_accepted": result["situations_accepted"],
            "rollups_accepted": result["rollups_accepted"],
            "data_quality": data_quality,
            "fallback_chain": fallback_chain,
            "schema_note": (
                "situations key = {role_bucket}.{stage}.{leader}.{team_pos}.{failed}.{team_size}；"
                "rollups key = L{1|2|3|4}.{...}。三視圖："
                "situations/rollups = 全員票（Edward 規則下全員可推）；"
                "situations_explicit/rollups_explicit = 僅 +/- 座位（= 異常票）；"
                "situations_accepted/rollups_accepted = 僅最終通過的 attempt。"
            ),
        }

        out_path = OUTPUT_DIR / f"top10_behavior_priors_{tier}.json"
        out_path.write_text(
            json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
        )
        print(f"[OK] wrote {out_path.relative_to(REPO_ROOT)}")
        print(
            f"  games={result['games_processed']}  attempts={result['attempts_scanned']}  "
            f"votes={result['votes_counted']}  "
            f"explicit(anomaly)={result['votes_counted_explicit']}  "
            f"accepted={result['votes_counted_accepted']}  "
            f"keys={result['confidence_summary']['total_keys']}"
        )
        print(
            f"  anomaly: +={result['anomaly_stats']['anomaly_approve_count']} "
            f"-={result['anomaly_stats']['anomaly_reject_count']} "
            f"ratio={result['anomaly_stats']['anomaly_approve_ratio_of_all_votes']*100:.3f}%/"
            f"{result['anomaly_stats']['anomaly_reject_ratio_of_all_votes']*100:.3f}%"
        )
        print("  by_round  (外白率 / 內黑率 / off_opps / in_opps / attempts):")
        for n in ("1", "2", "3", "4", "5"):
            br = result["anomaly_stats"]["by_round"][n]
            print(
                f"    R{n}: outer={br['outer_white_rate']*100:6.3f}%  "
                f"inner={br['inner_black_rate']*100:6.3f}%  "
                f"off_opps={br['off_team_seat_opportunities']:>5}  "
                f"in_opps={br['in_team_seat_opportunities']:>5}  "
                f"attempts={br['attempts_in_round']:>5}"
            )

        for rk in ("L3.r1.off_team", "L3.r1.in_team", "L3.r2_plus.off_team", "L3.r2_plus.in_team"):
            r_inf = result["rollups"].get(rk, {})
            r_acc = result["rollups_accepted"].get(rk, {})
            print(
                f"    {rk:28s}  "
                f"all: n={r_inf.get('sample_size',0):>5} app={r_inf.get('approve_rate',0)*100:5.1f}%  "
                f"accepted: n={r_acc.get('sample_size',0):>5} app={r_acc.get('approve_rate',0)*100:5.1f}%"
            )

        summary_per_tier[tier] = {
            "rule_version": "edward_2026-04-22",
            "anomaly_breakdown_version": "edward_2026-04-22_15:12_round_cross_product",
            "votes_counted": result["votes_counted"],
            "total_keys": result["confidence_summary"]["total_keys"],
            "high_conf_keys": result["confidence_summary"]["high_conf_keys"],
            "low_conf_keys": result["confidence_summary"]["low_conf_keys"],
            "anomaly_stats": result["anomaly_stats"],
            "L3.r1.off_team": result["rollups"].get("L3.r1.off_team"),
            "L3.r1.in_team": result["rollups"].get("L3.r1.in_team"),
            "L3.r2_plus.off_team": result["rollups"].get("L3.r2_plus.off_team"),
            "L3.r2_plus.in_team": result["rollups"].get("L3.r2_plus.in_team"),
        }

    summary_path = OUTPUT_DIR / "top10_priors_build_summary.json"
    summary_path.write_text(
        json.dumps(summary_per_tier, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
    )
    print(f"\n[OK] build summary → {summary_path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
