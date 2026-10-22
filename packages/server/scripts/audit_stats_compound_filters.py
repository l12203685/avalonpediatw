"""直接從固定牌譜快照獨立驗算複合條件；不使用 TS 引擎或 Python 參考篩選器。"""

from __future__ import annotations

import argparse
from collections import Counter
from fractions import Fraction
import json
from pathlib import Path

import build_stats_parity_fixtures as fixtures


def audit() -> list[dict]:
    games = fixtures.run_like_games(fixtures.snapshot_log(), fixtures.SNAPSHOT_AS_OF)
    # 只共用牌譜解析與名字正規化，篩選、PR 和結果計數在此直接驗算。
    totals = Counter(name for game in games for name in game.seat_players.values() if name)
    population = list(totals.values())
    selected = {name for name, count in totals.items()
                if round(Fraction(100 * (2 * sum(v < count for v in population)
                                          + population.count(count)), 2 * len(population)), 1) > 90}
    cases = [
        ("online2024", "線瓦且 2024 年", [
            {"kind": "category", "in": ["線瓦"]},
            {"kind": "date", "from": "2024-01-01", "to": "2024-12-31"}],
         lambda g: g.category == "線瓦" and "2024-01-01" <= g.date <= "2024-12-31", set()),
        ("offlineNamedBlue", "面瓦、十席具名且三藍", [
            {"kind": "category", "in": ["面瓦"]}, {"kind": "namedSeats", "min": 10},
            {"kind": "outcome", "in": ["三藍死", "三藍活"]}],
         lambda g: g.category == "面瓦" and len([n for n in g.seat_players.values() if n]) == 10
         and g.outcome in ("三藍死", "三藍活"), set()),
        ("nonCasualLake", "排除娛樂且至少一湖", [
            {"kind": "category", "in": ["娛樂"], "not": True}, {"kind": "lakeCount", "in": [1, 2, 3]}],
         lambda g: g.category != "娛樂" and any((g.lake1, g.lake2, g.lake3)), set()),
        ("merlinEdgeBlue", "梅林在 1／10 號且藍方最終勝", [
            {"kind": "roleSeat", "role": "梅林", "seats": [1, 10]}, {"kind": "finalWinner", "is": "blue"}],
         lambda g: g.outcome == "三藍活" and any(g.seat_roles.get(s) == "梅林" for s in ("1", "0")), set()),
        ("onlineFirstTeam", "線瓦且首隊有紅方", [
            {"kind": "category", "in": ["線瓦"]}, {"kind": "firstTeam", "redCount": [1, 2, 3]}],
         lambda g: g.category == "線瓦" and bool(g.r11_seats)
         and sum(g.seat_roles.get(s) in fixtures.gc.RED_ROLES for s in g.r11_seats) in (1, 2, 3), set()),
        ("weekendLate", "週末且當日第 3 場以後", [
            {"kind": "weekday", "in": [6, 7]}, {"kind": "sessionIndex", "min": 3}],
         lambda g: bool(g.date) and fixtures.dt.date.fromisoformat(g.date).isoweekday() >= 6 and g.slot >= 3, set()),
        ("onlineDropHighPR", "線瓦且排除場數 PR 大於 90 的玩家對局", [
            {"kind": "category", "in": ["線瓦"]},
            {"kind": "excludePlayers", "scope": "dropGames",
             "who": {"by": "metric", "metric": "games", "op": "gt", "pr": 90}}],
         lambda g: g.category == "線瓦" and not any(n in selected for n in g.seat_players.values()), set()),
        ("offlineHideHighPR", "面瓦且只從名單隱藏場數 PR 大於 90 的玩家", [
            {"kind": "category", "in": ["面瓦"]},
            {"kind": "excludePlayers", "scope": "hideFromLists",
             "who": {"by": "metric", "metric": "games", "op": "gt", "pr": 90}}],
         lambda g: g.category == "面瓦", selected),
    ]
    answers = []
    for key, label, clauses, keep, hidden in cases:
        kept = [game for game in games if keep(game)]
        counts = Counter(game.outcome for game in kept)
        listed = {name for game in kept for name in game.seat_players.values() if name} - hidden
        answers.append({"id": key, "label": label, "filter": {"v": 1, "clauses": clauses}, "expected": {
            "games": len(kept), "threeRed": counts["三紅"], "threeBlueDead": counts["三藍死"],
            "threeBlueAlive": counts["三藍活"], "finalRedWins": counts["三紅"] + counts["三藍死"],
            "listedPlayers": len(listed),
        }})
    return answers


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = audit()
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"獨立驗算：{len(result)} 組")
