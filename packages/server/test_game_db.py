"""Offline tests for game_db.py (牌譜總庫). Stdlib unittest; synthetic games, no names.

    python packages/server/test_game_db.py
"""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import game_db as gd  # noqa: E402
import records_merge as rm  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-analysis-cache.yml"

# 配置 123456: reds 1 2 3 4 (刺 娜 德 奧), 派 5, 梅 6.
GOOD = {
    "config": "123456",
    "rounds": [
        {"proposals": [{"team": "567", "votes": ["890+"]}], "mission": "ooo"},
        {"proposals": [{"team": "1578", "votes": []}, {"team": "5678", "votes": ["90+"]}], "mission": "oooo"},
        {"proposals": [{"team": "5679", "votes": ["80+"]}], "mission": "oooo"},
    ],
    "lakes": [{"after": 2, "holder": "0", "target": "5", "claim": "o"}],
    "assassination": "7",
    "outcome": "三藍活",
}


def rules(game, partial=False):
    return [c["rule"] for c in gd.validate(game, partial) if c["level"] != gd.INFO]


def source(src, sid, game, kind=gd.KIND_REAL, date="2026-01-02", venue="線瓦", legacy="", s=None):
    return {"src": src, "id": sid, "kind": kind, "date": date, "venue": venue, "legacy": legacy, "s": s, "game": game,
            "problem": "" if game else "讀不懂", "flags": [], "fp": rm.game_fingerprint(game) if game else ""}


class ValidateTest(unittest.TestCase):
    def test_good_game_has_no_errors_or_warnings(self):
        self.assertEqual(rules(GOOD), [])

    def test_combined_vote_tokens(self):
        yes, bad = gd.approvers("12679", ["80+6-"])
        self.assertEqual(bad, [])
        self.assertEqual(yes, set("127980"))

    def test_fails_more_than_reds(self):
        g = copy.deepcopy(GOOD)
        g["rounds"][0]["mission"] = "oox"  # 567 has no red
        self.assertIn("FAILS_GT_RED", rules(g))

    def test_outcome_must_follow_assassination(self):
        g = copy.deepcopy(GOOD)
        g["assassination"] = "6"  # Merlin -> 三藍死
        self.assertIn("OUTCOME", rules(g))
        g["outcome"] = "三藍死"
        self.assertNotIn("OUTCOME", rules(g))

    def test_assassin_target_cannot_be_red(self):
        g = copy.deepcopy(GOOD)
        g["assassination"] = "2"
        self.assertIn("ASSASSIN_RED", rules(g))
        g["assassination"] = "4"  # Oberon: possible (the assassin does not know him), only a warning
        self.assertEqual([c for c in gd.validate(g) if c["rule"] == "ASSASSIN_OBERON"][0]["level"], gd.WARN)

    def test_vote_result_needs_six_approvals(self):
        g = copy.deepcopy(GOOD)
        g["rounds"][0]["proposals"][0]["votes"] = ["8+"]  # 4 approve, yet it went
        self.assertIn("VOTE_RESULT", rules(g))
        g = copy.deepcopy(GOOD)
        g["rounds"][1]["proposals"][0]["votes"] = ["90+"]  # 6 approve, yet not the mission
        self.assertIn("VOTE_RESULT", rules(g))

    def test_vote_marks_against_team(self):
        g = copy.deepcopy(GOOD)
        g["rounds"][0]["proposals"][0]["votes"] = ["890+", "1-"]
        self.assertIn("VOTE_MARKS", rules(g))

    def test_lake_chain_and_rounds(self):
        g = copy.deepcopy(GOOD)
        g["lakes"].append({"after": 3, "holder": "9", "target": "0", "claim": "o"})
        msgs = [c["msg"] for c in gd.validate(g) if c["rule"] == "LAKE"]
        self.assertTrue(any("上一湖驗的是" in m for m in msgs))
        self.assertTrue(any("拿過湖" in m for m in msgs))
        self.assertTrue(any("就結束" in m for m in msgs))  # after 3 in a 3-round game

    def test_undecided_and_after_decided(self):
        g = copy.deepcopy(GOOD)
        g["rounds"] = g["rounds"][:2]
        g["lakes"] = []
        self.assertIn("UNDECIDED", rules(g))
        g = copy.deepcopy(GOOD)
        g["rounds"].append({"proposals": [{"team": "56789", "votes": ["0+"]}], "mission": "ooooo"})
        self.assertIn("AFTER_DECIDED", rules(g))

    def test_team_size_and_seats(self):
        g = copy.deepcopy(GOOD)
        g["rounds"][0]["proposals"][0]["team"] = "5678"
        self.assertIn("TEAM_SIZE", rules(g))
        g["rounds"][0]["proposals"][0]["team"] = "556"
        self.assertIn("TEAM_SEATS", rules(g))

    def test_round_four_needs_two_fails(self):
        g = {"config": "123456", "assassination": "", "outcome": "三紅", "lakes": [], "rounds": [
            {"proposals": [{"team": "125", "votes": ["678+"]}], "mission": "oox"},
            {"proposals": [{"team": "1256", "votes": ["78+"]}], "mission": "ooox"},
            {"proposals": [{"team": "1567", "votes": ["89+"]}], "mission": "oooo"},
            {"proposals": [{"team": "15678", "votes": ["9+"]}], "mission": "oooox"},  # 1 fail in R4 = success
            {"proposals": [{"team": "12567", "votes": ["8+"]}], "mission": "oooxx"},
        ]}
        self.assertEqual(rules(g), [])

    def test_partial_sim_record_skips_end_of_game_rules(self):
        g = copy.deepcopy(GOOD)
        g["rounds"] = g["rounds"][:1]
        g["lakes"], g["assassination"], g["outcome"] = [], "", ""
        self.assertEqual(rules(g, partial=True), [])
        self.assertIn("UNDECIDED", rules(g))


class InferenceTest(unittest.TestCase):
    def after_success(self, votes):
        g = copy.deepcopy(GOOD)
        g["rounds"][1] = {"proposals": [{"team": "5678", "votes": votes}], "mission": "oooo"}  # R1 567 succeeded
        return g

    def test_resend_after_success_without_votes_is_inferred_all_white(self):
        inferred = []
        checks = gd.validate(self.after_success([]), inferred=inferred)
        self.assertNotIn("VOTE_RESULT", [c["rule"] for c in checks])
        self.assertIn("INFERRED_VOTES", [c["rule"] for c in checks])
        self.assertEqual(inferred, [{"round": 2, "attempt": 1, "kind": gd.INFER_ALL_WHITE}])
        self.assertIn("VOTE_RESULT", [c["rule"] for c in gd.validate(self.after_success([]), infer=False)])

    def test_no_inference_when_votes_were_recorded_or_team_differs(self):
        self.assertIn("VOTE_RESULT", rules(self.after_success(["9+"])))
        g = self.after_success([])
        g["rounds"][1]["proposals"][0]["team"] = "1578"  # does not contain 567
        self.assertIn("VOTE_RESULT", rules(g))

    def test_build_marks_inferred_votes(self):
        rows = gd.build([source(gd.SRC_SHEET, "12", self.after_success([]))])
        self.assertEqual(rows[0]["inferred_votes"][0]["kind"], gd.INFER_ALL_WHITE)


class BuildTest(unittest.TestCase):
    def test_venue_and_legacy_category_are_separate(self):
        rows = gd.build([source(gd.SRC_SHEET, "12", GOOD, venue="", legacy="娛樂", s=66.2),
                         source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD), venue="線瓦")])
        row = rows[0]
        self.assertEqual((row["venue"], row["legacyCategory"], row["strength"]), ("線瓦", ["娛樂"], "high"))
        self.assertNotIn("CONFLICT", [c["rule"] for c in row["checks"]])
        rows = gd.build([source(gd.SRC_SHEET, "12", GOOD, venue="面瓦"), source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD))])
        self.assertIn("CONFLICT", [c["rule"] for c in rows[0]["checks"]])

    def test_strength_tiers(self):
        self.assertEqual([gd.strength_tier(x) for x in (65, 64.9, 55, 38, 37.9, None)],
                         ["high", "strong", "strong", "normal", "weak", ""])

    def test_merge_by_fingerprint_uses_the_records_page_id(self):
        rows = gd.build([source(gd.SRC_SHEET, "12", GOOD), source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD))])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], "999")
        self.assertEqual([s["id"] for s in rows[0]["sources"]], ["S12", "999"])
        self.assertEqual(rows[0]["status"], "ok")

    def test_sim_never_merges_with_real(self):
        rows = gd.build([source(gd.SRC_SHEET, "12", GOOD), source(gd.SRC_SIM, "3", copy.deepcopy(GOOD), kind=gd.KIND_SIM)])
        self.assertEqual(sorted(r["kind"] for r in rows), ["real", "sim"])

    def test_conflict_duplicate_and_near_duplicate(self):
        other = copy.deepcopy(GOOD)
        other["outcome"] = "三藍死"
        near = copy.deepcopy(GOOD)
        near["rounds"][1]["proposals"][0]["team"] = "1579"
        rows = gd.build([
            source(gd.SRC_SHEET, "12", GOOD), source(gd.SRC_SHEET, "13", copy.deepcopy(GOOD)),
            source(gd.SRC_DISCORD, "999", other), source(gd.SRC_SHEET, "14", near),
        ])
        by_id = {r["id"]: r for r in rows}
        main = by_id["999"]
        found = {c["rule"] for c in main["checks"]}
        self.assertTrue({"DUP_SAME_SOURCE", "CONFLICT", "NEAR_DUP"} <= found)
        self.assertIn("S14", next(c["msg"] for c in main["checks"] if c["rule"] == "NEAR_DUP"))

    def test_unreadable_sources_are_kept(self):
        rows = gd.build([source(gd.SRC_DISCORD, "5", None)])
        self.assertEqual(rows[0]["status"], "unreadable")
        self.assertEqual(rows[0]["problem"], "讀不懂")

    def test_output_has_no_names_and_is_deterministic(self):
        named = dict(copy.deepcopy(GOOD), names=["玩家A"] * 10, category="線瓦")
        rows = gd.build([source(gd.SRC_SHEET, "12", named)])
        self.assertNotIn("names", rows[0]["game"])
        with tempfile.TemporaryDirectory() as tmp:
            a, b = Path(tmp) / "a.json", Path(tmp) / "b.json"
            gd.write_db(rows, gd.summarize(rows), a)
            gd.write_db(gd.build([source(gd.SRC_SHEET, "12", named)]), gd.summarize(rows), b)
            self.assertEqual(a.read_text(encoding="utf-8"), b.read_text(encoding="utf-8"))
            doc = json.loads(a.read_text(encoding="utf-8"))
            self.assertEqual(doc["format"], gd.FORMAT)
            self.assertEqual(doc["games"][0]["id"], "S12")


class WorkflowTest(unittest.TestCase):
    def test_nightly_workflow_builds_and_commits_the_database(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("packages/server/game_db.py", text)
        self.assertIn("GAME_DB_PATH", text)
        self.assertIn("python packages/server/test_game_db.py", text)


if __name__ == "__main__":
    unittest.main()
