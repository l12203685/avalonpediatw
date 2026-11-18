"""Offline tests for console_export.py (主控台匯出：問題牌譜＋牌譜數量). Stdlib unittest.

    python packages/server/test_console_export.py

Fixture test_fixtures/console_export/: a small subset of this directory's caches (games_cache, records_cache,
sheets_cache, game_db_corrections; no ProAvalon, off by default since 2026-11-18) with every name field removed, and the game_db.json that
game_db.py builds from it. expected_old_scripts.json is what the console's first整理腳本 (make_rows.py and
make_problem_records.py, 2026-11-17) wrote for this fixture, minus the console's own state fields and the seat
nicknames: the port has to match it.
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import console_export as ce  # noqa: E402

FIXTURE = HERE / "test_fixtures" / "console_export"
NOW = "2026-01-01T00:00:00+08:00"


def run_export(out: Path, sha: str = "abc1234") -> dict:
    return ce.export(FIXTURE, out, sha, NOW)


def known_names() -> set[str]:
    """Every player name the repo's own caches know (read at test time; the test itself has none)."""
    names: set[str] = set()
    games = json.loads((HERE / "games_cache.json").read_text(encoding="utf-8"))
    names.update(n for n in games.get("players", []) if isinstance(n, str))
    aliases = json.loads((HERE / "player_aliases.json").read_text(encoding="utf-8")).get("aliases", {})
    names.update(aliases)
    names.update(aliases.values())
    sheet = json.loads((HERE / "sheets_cache.json").read_text(encoding="utf-8")).get("牌譜") or [[]]
    header, *rows = sheet
    cols = [header.index("玩" + k) for k in ce.SEATS if "玩" + k in header]
    names.update(r[i].strip() for r in rows for i in cols if len(r) > i and r[i].strip())
    records = json.loads((HERE / "records_cache.json").read_text(encoding="utf-8"))
    for p in records.get("posts", []):
        names.update(n for n in ((p.get("game") or {}).get("names") or []) if n)
    # vocabulary words (e.g. the bot category) are labels, not people
    vocab = {w for words in games.get("vocab", {}).values() for w in words if isinstance(w, str)}
    return {n.strip() for n in names if n.strip() and n.strip() not in vocab}


def name_hit(text: str, name: str) -> bool:
    """Same rule as threads' validatePost: ASCII names of 3+ characters as whole words, CJK names of 2+."""
    if re.fullmatch(r"[\x20-\x7e]+", name):
        if len(name) < 3 or name.isdigit():
            return False
        return re.search(r"(^|[^A-Za-z0-9])" + re.escape(name) + r"([^A-Za-z0-9]|$)", text, re.I) is not None
    return len(name) >= 2 and name in text


class ParityTest(unittest.TestCase):
    """Problem grouping and per-source records match the old console scripts on the fixture."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name)
        cls.summary = run_export(cls.out)
        cls.doc = json.loads((cls.out / "problem_games.json").read_text(encoding="utf-8"))
        cls.expected = json.loads((FIXTURE / "expected_old_scripts.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def test_same_ids_and_groups(self) -> None:
        got = {g["id"]: g["group"] for g in self.doc["games"]}
        want = {gid: row["group"] for gid, row in self.expected["rows"].items()}
        self.assertEqual(got, want)

    def test_fixture_covers_every_group(self) -> None:
        self.assertEqual({g["group"] for g in self.doc["games"]}, set(ce.GROUPS))

    def test_rows_match_old_script(self) -> None:
        for g in self.doc["games"]:
            with self.subTest(id=g["id"]):
                self.assertEqual(g, self.expected["rows"][g["id"]])

    def test_records_match_old_script(self) -> None:
        self.assertEqual(self.doc["records"], self.expected["records"])

    def test_pairs_have_both_records(self) -> None:
        for g in self.doc["games"]:
            if g.get("pair"):
                self.assertIn(g["pair"], self.doc["records"])

    def test_rows_are_ordered_by_group_date_id(self) -> None:
        keys = [(ce.GROUPS.index(g["group"]), g["date"], g["id"]) for g in self.doc["games"]]
        self.assertEqual(keys, sorted(keys))


class OutputTest(unittest.TestCase):
    def test_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            run_export(Path(a))
            run_export(Path(b))
            for name in ("problem_games.json", "game_counts.json"):
                self.assertEqual((Path(a) / name).read_bytes(), (Path(b) / name).read_bytes(), name)

    def test_counts(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run_export(Path(d), sha="abc1234")
            counts = json.loads((Path(d) / "game_counts.json").read_text(encoding="utf-8"))
            db = json.loads((FIXTURE / "game_db.json").read_text(encoding="utf-8"))
        self.assertEqual(counts["dbVersion"], "abc1234")
        self.assertEqual(counts["updatedAt"], NOW)
        self.assertTrue(counts["gameDbInSync"])
        self.assertEqual(counts["games"], len(db["games"]))
        self.assertEqual(counts["byKind"], db["counts"]["byKind"])
        expected = json.loads((FIXTURE / "expected_old_scripts.json").read_text(encoding="utf-8"))
        self.assertEqual(sum(counts["problems"].values()), len(expected["rows"]))
        self.assertLessEqual({"讀不懂的實戰局", "沒有日期"}, {i["label"] for i in counts["items"]})

    def test_out_of_sync_db_is_flagged(self) -> None:
        inputs = ce.load_inputs(FIXTURE)
        db = json.loads(json.dumps(inputs["db"]))
        db["games"] = db["games"][1:]
        self.assertFalse(ce.db_in_sync(db, inputs["rebuilt"]))
        self.assertTrue(ce.db_in_sync(inputs["db"], inputs["rebuilt"]))

    def test_default_export_has_no_names(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            run_export(Path(d))
            doc = json.loads((Path(d) / "problem_games.json").read_text(encoding="utf-8"))
        self.assertFalse(doc["withNames"])
        for recs in doc["records"].values():
            for s in recs["sources"]:
                self.assertNotIn("names", s)
                self.assertNotIn("namesRaw", s)


class PrivacyTest(unittest.TestCase):
    def test_fixture_has_no_player_names(self) -> None:
        names = known_names()
        self.assertGreater(len(names), 50)  # the check really ran against the caches
        for f in sorted(FIXTURE.glob("*.json")):
            text = f.read_text(encoding="utf-8")
            hits = [n for n in names if name_hit(text, n)]
            self.assertEqual(len(hits), 0, f"{f.name} contains {len(hits)} player name(s)")  # names not printed

    def test_fixture_name_fields_are_empty(self) -> None:
        games = json.loads((FIXTURE / "games_cache.json").read_text(encoding="utf-8"))
        self.assertEqual(games["players"], [])
        seats = games["fields"].index("seats")
        self.assertTrue(all(row[seats] == [-1] * 10 for row in games["games"]))
        sheet = json.loads((FIXTURE / "sheets_cache.json").read_text(encoding="utf-8"))
        self.assertFalse(any(h.startswith("玩") for h in sheet["牌譜"][0]))
        records = json.loads((FIXTURE / "records_cache.json").read_text(encoding="utf-8"))
        self.assertFalse(any("names" in (p.get("game") or {}) or "title" in p for p in records["posts"]))


class HelpersTest(unittest.TestCase):
    def test_records_text(self) -> None:
        game = {"config": "123456", "rounds": [
            {"proposals": [{"team": "567", "votes": ["890+"]}], "mission": "ooo"},
            {"proposals": [{"team": "1578", "votes": []}, {"team": "5678", "votes": ["5-"]}], "mission": "oooo"},
        ], "lakes": [{"after": 2, "holder": "0", "target": "5", "claim": "o"}], "assassination": "7", "outcome": "三藍死"}
        self.assertEqual(ce.records_text(game), "567 890+\nooo\n1578\n5678 5-\noooo\n0>5 o\n123456\n刺客刺殺:7\n結果:三藍死")

    def test_per_round(self) -> None:
        sizes, pending = ce.per_round("124\n125\n126\n127\n128\n129\n1234 oxoo\n345")
        self.assertEqual(sizes, [(7, 4)])
        self.assertEqual(pending, 1)

    def test_plain_seats(self) -> None:
        self.assertEqual(ce.plain("隊伍 569 上只有 0 個紅方"), "隊伍（5、6、9家）上只有 0 個紅方")


if __name__ == "__main__":
    unittest.main()
