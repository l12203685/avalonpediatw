"""Offline tests for name_collisions.py (同名不同人候選). Stdlib unittest; made-up names only.

    python packages/server/test_name_collisions.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import name_collisions as nc  # noqa: E402

FIELDS = ["id", "src", "date", "cat", "slot", "note", "config", "outcome", "kill", "seats", "missions", "rounds",
          "state", "firstTeam", "lakes", "claims", "captains", "votes", "lineup"]
CATS = ["線瓦", "面瓦", "娛樂", "", "其他", "百科AI"]
# Two crowds that never meet, and Ash Vole in both (made-up names).
OLD = ["Ash Vole", "Bram", "Cleo", "Dov", "Esk", "Fen", "Gil", "Hal", "Ivo", "Jun"]
NEW = ["Ash Vole", "Kai", "Lux", "Mox", "Nim", "Oak", "Pip", "Quo", "Rex", "Sol"]


class Doc:
    def __init__(self) -> None:
        self.players: list[str] = []
        self.rows: list[list] = []

    def idx(self, name: str) -> int:
        if name not in self.players:
            self.players.append(name)
        return self.players.index(name)

    def add(self, gid: str, names: list[str], date: str = "2026-01-02", cat: str = "線瓦", slot: int = 1,
            src: int = 0) -> None:
        seats = [self.idx(n) if n else -1 for n in names] + [-1] * (10 - len(names))
        row = [gid, src, date, CATS.index(cat), slot, [], "123456", 0, "", seats, "", "", 0, "", "", "", "", [], []]
        self.rows.append(row)

    def doc(self) -> dict:
        return {"format": "avalon-games", "fields": FIELDS, "vocab": {"category": CATS}, "players": self.players,
                "games": self.rows}


def two_crowds() -> Doc:
    d = Doc()
    for i in range(4):
        d.add(str(100 + i), OLD[i % 2:] + OLD[:i % 2], date=f"2023-05-1{i}", cat="面瓦", slot=i + 1)
    for i in range(2):
        d.add(f"D00000000a{i}", NEW, date=f"2026-11-1{i}", slot=i + 1, src=1)
    return d


class RulesTest(unittest.TestCase):
    def test_disjoint_crowds_are_rule_b(self) -> None:
        d = two_crowds()
        doc = nc.detect(d.doc())
        self.assertEqual(doc["counts"]["b"], {"names": 1, "candidates": 1, "games": 6})
        self.assertEqual(doc["counts"]["a1"]["names"], 0)
        self.assertEqual(doc["counts"]["a2"]["names"], 0)
        (c,) = doc["candidates"]
        self.assertEqual((c["rule"], c["level"], c["name"]), ("b", "review", "Ash Vole"))
        self.assertEqual([len(g["games"]) for g in c["groups"]], [4, 2])
        self.assertEqual(c["groups"][0]["venues"], {"面瓦": 4})
        self.assertEqual((c["groups"][1]["from"], c["groups"][1]["to"]), ("2026-11-10", "2026-11-11"))
        (s,) = c["suggested"]
        self.assertEqual(s["games"], ["D00000000a0", "D00000000a1"])
        self.assertEqual((s["name"], s["as"], s["status"]), ("Ash Vole", "Ash Vole（2）", "pending"))
        self.assertEqual(s["id"], nc.split_doc_id("Ash Vole", s["games"]))
        self.assertTrue(s["id"].startswith("ns_"))

    def test_one_shared_co_player_links_the_crowds(self) -> None:
        d = two_crowds()
        d.add("200", ["Ash Vole", "Bram", "Kai", "Lux", "Mox", "Nim", "Oak", "Pip", "Quo", "Rex"], date="2026-11-12")
        self.assertEqual(nc.detect(d.doc())["counts"]["b"]["names"], 0)

    def test_partial_rosters_do_not_count(self) -> None:
        d = Doc()
        for i in range(3):
            d.add(str(i + 1), OLD, date=f"2023-01-0{i + 1}")
        d.add("9", ["Ash Vole"], date="2023-02-01")  # only the name written: nothing to compare
        d.add("10", ["Ash Vole", "Kai", "Lux", "Mox", "Nim"], date="2023-02-02")  # 4 others < MIN_COPLAYERS
        self.assertEqual(nc.detect(d.doc())["counts"]["b"]["names"], 0)

    def test_one_name_on_two_seats_is_rule_a1(self) -> None:
        d = Doc()
        d.add("7", ["Ash Vole", "Bram", "Cleo", "Dov", "Esk", "Ash Vole", "Gil", "Hal", "Ivo", "Jun"])
        (c,) = nc.detect(d.doc())["candidates"]
        self.assertEqual((c["rule"], c["level"], c["games"]), ("a1", "definitive", ["S7"]))
        self.assertEqual(c["groups"][0]["games"][0]["seats"], ["1", "6"])
        self.assertEqual(c["suggested"][0]["seat"], "6")

    def test_same_day_venue_and_slot_at_two_tables_is_rule_a2(self) -> None:
        d = Doc()
        for i in range(3):
            d.add(str(10 + i), OLD, date="2026-03-01", slot=i + 1)
        d.add("D00000000b0", NEW, date="2026-03-01", slot=2, src=1)
        doc = nc.detect(d.doc())
        a2 = [c for c in doc["candidates"] if c["rule"] == "a2"]
        self.assertEqual(len(a2), 1)
        self.assertEqual(a2[0]["games"], ["S11", "D00000000b0"])
        self.assertEqual(a2[0]["suggested"][0]["games"], ["D00000000b0"])  # the table outside his usual crowd

    def test_same_game_entered_twice_is_not_a2(self) -> None:
        d = Doc()
        d.add("1", OLD, date="2026-03-01", slot=2)
        d.add("2", OLD, date="2026-03-01", slot=2)  # one game twice: game_db's NEAR_DUP, not two people
        self.assertEqual(nc.detect(d.doc())["counts"]["a2"]["names"], 0)

    def test_other_slot_or_venue_is_not_a2(self) -> None:
        d = Doc()
        d.add("1", OLD, date="2026-03-01", slot=1)
        d.add("2", NEW, date="2026-03-01", slot=1, cat="面瓦")  # 線瓦 and 面瓦 number their games apart
        d.add("3", NEW, date="2026-03-01", slot=2)
        self.assertEqual(nc.detect(d.doc())["counts"]["a2"]["names"], 0)

    def test_bot_games_are_left_out(self) -> None:
        d = two_crowds()
        d.add("300", ["Ash Vole", "百科AI", "Kai"], cat="百科AI")
        self.assertEqual(len(nc.stats_games(d.doc())), 6)

    def test_site_id_and_tags_come_from_game_db_and_records(self) -> None:
        d = two_crowds()
        db = {"games": [{"id": "1571000000000000001", "sources": [
            {"src": "discord", "id": "1571000000000000001"}, {"src": "dc_import", "id": "D00000000a0"}]}]}
        records = {"posts": [{"id": "1571000000000000001", "tags": ["三紅", "線瓦", "S2無差別亂鬥-例行賽"]}]}
        games = {g["id"]: g for g in nc.stats_games(d.doc(), db, records)}
        self.assertEqual(games["D00000000a0"]["site"], "1571000000000000001")
        self.assertEqual(games["D00000000a0"]["tags"], ["S2無差別亂鬥-例行賽"])  # outcome and venue tags dropped
        self.assertEqual(games["S100"]["site"], "S100")


class OutputTest(unittest.TestCase):
    def test_report_lines_have_counts_only(self) -> None:
        doc = nc.detect(two_crowds().doc())
        text = "\n".join(nc.report_lines(doc["counts"]))
        self.assertIn("| `b` | 要人看 |", text)
        for name in OLD + NEW:
            self.assertNotIn(name, text)
        self.assertNotIn("D00000000a0", text)

    def test_deterministic_and_refuses_the_repo(self) -> None:
        doc = nc.detect(two_crowds().doc())
        self.assertEqual(json.dumps(doc, ensure_ascii=False), json.dumps(nc.detect(two_crowds().doc()), ensure_ascii=False))
        with self.assertRaises(SystemExit):
            nc.write(doc, nc.HERE / "tmp_name_collisions")
        with tempfile.TemporaryDirectory() as tmp:
            path = nc.write(doc, Path(tmp))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["format"], nc.FORMAT)

    def test_suggested_name_skips_taken_ones(self) -> None:
        self.assertEqual(nc.other_name("Ash Vole", {"Ash Vole（2）"}), "Ash Vole（3）")

    def test_empty_input(self) -> None:
        doc = nc.detect(None)
        self.assertEqual((doc["games"], doc["candidates"]), (0, []))


if __name__ == "__main__":
    unittest.main()
