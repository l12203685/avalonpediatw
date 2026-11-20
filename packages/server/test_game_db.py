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

    def test_assassin_target_cannot_be_a_teammate(self):
        for seat in "1234":  # 刺客 itself, 莫甘娜, 莫德雷德 and 奧伯倫 (every red flips at the assassination)
            g = copy.deepcopy(GOOD)
            g["assassination"] = seat
            self.assertIn("ASSASSIN_TEAMMATE", rules(g))
        self.assertIn("奧伯倫", next(c["msg"] for c in gd.validate(g) if c["rule"] == "ASSASSIN_TEAMMATE"))

    def test_forced_fifth_proposal_must_go(self):
        g = copy.deepcopy(GOOD)
        g["rounds"][1]["proposals"] = [{"team": t, "votes": []} for t in ("1578", "1579", "1570", "1678", "1679")]
        self.assertNotIn("FORCED_NOT_RUN", rules(g))  # the 5th went
        g["rounds"][1]["proposals"].append({"team": "5678", "votes": ["90+"]})  # a 6th: the 5th did not go
        self.assertIn("FORCED_NOT_RUN", rules(g))
        g = copy.deepcopy(GOOD)
        g["rounds"].append({"proposals": [{"team": t, "votes": []} for t in ("12345", "12346", "12347", "12348", "12349")],
                            "mission": ""})  # 5th proposal, then no mission
        self.assertIn("FORCED_NOT_RUN", rules(g))
        self.assertNotIn("FORCED_NOT_RUN", rules(g, partial=True))  # a 模擬 record may stop right there

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


class SheetDateTest(unittest.TestCase):
    """站長 2026-11-20「日期不同的都以試算表為準 因為discord 上發文的日期不一定是遊戲日期」."""

    def test_sheet_date_wins_and_is_not_a_conflict(self):
        rows = gd.build([source(gd.SRC_SHEET, "12", GOOD, date="2026-01-02"),
                         source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD), date="2026-01-05")])
        self.assertEqual((rows[0]["id"], rows[0]["date"], rows[0]["status"]), ("999", "2026-01-02", "ok"))
        self.assertNotIn("CONFLICT", [c["rule"] for c in rows[0]["checks"]])

    def test_sheet_date_wins_when_the_discord_copy_is_shown(self):
        wrong = copy.deepcopy(GOOD)
        wrong["lakes"] = [{"after": 2, "holder": "0", "target": "0", "claim": "o"}]
        rows = gd.build([source(gd.SRC_SHEET, "12", wrong, date="2026-01-02"),
                         source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD), date="2026-01-05")])
        self.assertEqual((rows[0]["sources"][0]["id"], rows[0]["date"]), ("999", "2026-01-02"))
        msg = next(c["msg"] for c in rows[0]["checks"] if c["rule"] == "CONFLICT")
        self.assertNotIn("日期", msg)  # only the sheet's rule error is named

    def test_sim_sheet_date_wins_too(self):
        rows = gd.build([source(gd.SRC_SIM, "3", GOOD, kind=gd.KIND_SIM, date="2026-01-02"),
                         source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD), kind=gd.KIND_SIM, date="2026-01-04")])
        self.assertEqual(rows[0]["date"], "2026-01-02")
        self.assertNotIn("CONFLICT", [c["rule"] for c in rows[0]["checks"]])

    def test_other_conflicts_and_non_sheet_dates_are_still_flagged(self):
        other = dict(copy.deepcopy(GOOD), outcome="三藍死")
        rows = gd.build([source(gd.SRC_SHEET, "12", GOOD), source(gd.SRC_DISCORD, "999", other, date="2026-01-05")])
        msg = next(c["msg"] for c in rows[0]["checks"] if c["rule"] == "CONFLICT")
        self.assertIn("結果（三藍活 / 三藍死）", msg)
        self.assertNotIn("日期", msg)
        rows = gd.build([source(gd.SRC_DISCORD, "999", GOOD), source(gd.SRC_IMPORT, "Dabc", copy.deepcopy(GOOD), date="2026-01-05")])
        self.assertIn("日期（2026-01-02 / 2026-01-05）", next(c["msg"] for c in rows[0]["checks"] if c["rule"] == "CONFLICT"))

    def test_discord_only_and_import_keep_their_date(self):
        rows = gd.build([source(gd.SRC_DISCORD, "999", GOOD, date="2026-01-05"),
                         source(gd.SRC_IMPORT, "Dabc", copy.deepcopy(GOOD), date="2026-01-05")])
        self.assertEqual(rows[0]["date"], "2026-01-05")

    def test_records_source_uses_the_posts_own_date(self):
        doc = {"posts": [{"id": "1234567890123456789", "tags": [], "date": "2026-01-02", "postDate": "2026-01-05",
                          "src": "dc+sheet", "game": copy.deepcopy(GOOD)}]}
        srcs, _ = gd.records_sources(doc)
        self.assertEqual(srcs[0]["date"], "2026-01-05")
        rows = gd.build([source(gd.SRC_SHEET, "12", copy.deepcopy(GOOD), date="2026-01-02"), *srcs])
        self.assertEqual(rows[0]["date"], "2026-01-02")
        self.assertNotIn("CONFLICT", [c["rule"] for c in rows[0]["checks"]])


class CleanSourceTest(unittest.TestCase):
    """2026-11-17: rule errors corrected on Discord must not stay listed because the sheet's copy is wrong."""

    def test_clean_source_is_shown_when_the_sheet_breaks_a_rule(self):
        wrong = copy.deepcopy(GOOD)
        wrong["lakes"] = [{"after": 2, "holder": "0", "target": "0", "claim": "o"}]  # holder checks himself
        rows = gd.build([source(gd.SRC_SHEET, "12", wrong), source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD))])
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["id"], row["status"], row["game"]["lakes"]), ("999", gd.WARN, GOOD["lakes"]))
        self.assertEqual([s["id"] for s in row["sources"]], ["999", "S12"])
        self.assertTrue(next(s for s in row["sources"] if s["id"] == "S12")["wrong"])
        msg = next(c["msg"] for c in row["checks"] if c["rule"] == "CONFLICT")
        self.assertIn("試算表 牌譜 分頁那筆有錯（湖中女神不合規則）", msg)
        self.assertNotIn(gd.ERROR, [c["level"] for c in row["checks"]])

    def test_sheet_stays_main_when_every_source_is_wrong(self):
        wrong = copy.deepcopy(GOOD)
        wrong["lakes"] = [{"after": 2, "holder": "0", "target": "0", "claim": "o"}]
        rows = gd.build([source(gd.SRC_SHEET, "12", wrong), source(gd.SRC_DISCORD, "999", copy.deepcopy(wrong))])
        self.assertEqual((rows[0]["status"], [s["id"] for s in rows[0]["sources"]]), (gd.ERROR, ["S12", "999"]))

    def test_sheet_missing_the_last_round_folds_into_the_discord_copy(self):
        cut = copy.deepcopy(GOOD)
        cut["rounds"] = cut["rounds"][:2]  # stops at 2 blue: UNDECIDED (and the lake after round 2 ends the game)
        cut["lakes"] = []
        self.assertIn("UNDECIDED", rules(cut))
        rows = gd.build([source(gd.SRC_SHEET, "12", cut), source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD)),
                         source(gd.SRC_IMPORT, "Dabc", copy.deepcopy(GOOD))])
        self.assertEqual(len(rows), 1)  # listed once
        row = rows[0]
        self.assertEqual((row["id"], row["status"], len(row["game"]["rounds"])), ("999", gd.WARN, 3))
        self.assertEqual(next(s for s in row["sources"] if s["id"] == "S12")["superseded"], "試算表少記第 3 局")
        sup = next(c["msg"] for c in row["checks"] if c["rule"] == "SUPERSEDED")
        self.assertIn("S12）記錯（紀錄在任何一方拿到 3 局之前就結束）：試算表少記第 3 局", sup)
        self.assertNotIn("NEAR_DUP", [c["rule"] for c in row["checks"]])

    def test_config_off_by_one_seat_folds(self):
        right = dict(copy.deepcopy(GOOD), config="123457", assassination="6")  # 梅林 is 7: stabbing 6 misses
        wrong = dict(copy.deepcopy(GOOD), assassination="6")  # 123456: 6 is 梅林, yet 三藍活
        self.assertIn("OUTCOME", rules(wrong))
        rows = gd.build([source(gd.SRC_SHEET, "12", wrong), source(gd.SRC_DISCORD, "999", right)])
        self.assertEqual([r["id"] for r in rows], ["999"])
        self.assertEqual(rows[0]["sources"][1]["superseded"], "配置不同（試算表 123456，正確的是 123457）")

    def test_no_fold_across_dates_when_ambiguous_or_when_the_sheet_is_clean(self):
        cut = copy.deepcopy(GOOD)
        cut["rounds"] = cut["rounds"][:2]
        cut["lakes"] = []
        other_day = gd.build([source(gd.SRC_SHEET, "12", cut), source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD), date="2026-01-03")])
        self.assertEqual(sorted(r["id"] for r in other_day), ["999", "S12"])
        twin = copy.deepcopy(GOOD)
        twin["rounds"][2]["proposals"][0]["team"] = "5670"  # another full game starting the same way
        twin["rounds"][2]["proposals"][0]["votes"] = ["89+"]
        ambiguous = gd.build([source(gd.SRC_SHEET, "12", cut), source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD)),
                              source(gd.SRC_DISCORD, "998", twin)])
        self.assertEqual(len(ambiguous), 3)
        clean = copy.deepcopy(GOOD)
        clean["rounds"].append({"proposals": [{"team": "56789", "votes": ["0+"]}], "mission": "ooooo"})
        rows = gd.build([source(gd.SRC_SHEET, "12", copy.deepcopy(GOOD)), source(gd.SRC_DISCORD, "999", clean)])
        self.assertEqual(len(rows), 2)  # the sheet is not wrong here (the Discord copy is): nothing folds

    def test_twin_reason(self):
        fp = rm.game_fingerprint(GOOD)
        cut = copy.deepcopy(GOOD)
        cut["rounds"] = cut["rounds"][:1]
        self.assertEqual(gd.twin_reason(rm.game_fingerprint(cut), fp), "試算表少記第 2～3 局")
        self.assertEqual(gd.twin_reason(fp, rm.game_fingerprint(cut)), "試算表多記第 2～3 局")
        self.assertEqual(gd.twin_reason(fp, fp.replace("123456", "124356", 1)), "")  # two seats differ

    def test_records_sources_keep_the_reply_correction_id(self):
        doc = {"posts": [{"id": "1234567890123456789", "tags": [], "date": "2026-01-02", "game": copy.deepcopy(GOOD),
                          "fixedByReply": "1234567890123456790"}]}
        srcs, _ = gd.records_sources(doc)
        rows = gd.build(srcs)
        self.assertEqual(rows[0]["sources"], [{"src": "discord", "id": "1234567890123456789", "fixedByReply": "1234567890123456790"}])


class ExcludeTest(unittest.TestCase):
    """Edward 2026-11-17「尾派沒有出任務 刺客刺到隊友 都屬於錯誤局 不用記錄」: left out of the database."""

    def build(self, *sources):
        excluded = []
        rows = gd.build(list(sources), excluded)
        return rows, excluded

    def stabbed(self, seat):
        g = copy.deepcopy(GOOD)
        g["assassination"] = seat
        return g

    def test_oberon_stab_is_excluded(self):
        rows, excluded = self.build(source(gd.SRC_SHEET, "12", self.stabbed("4")))
        self.assertEqual(rows, [])
        self.assertEqual([(e["id"], e["date"], e["rules"], e["inconsistent"]) for e in excluded],
                         [("S12", "2026-01-02", ["ASSASSIN_TEAMMATE"], False)])

    def test_morgana_stab_is_excluded(self):
        rows, excluded = self.build(source(gd.SRC_DISCORD, "999", self.stabbed("2")))
        self.assertEqual((rows, [e["id"] for e in excluded]), ([], ["999"]))

    def test_fifth_proposal_not_run_is_excluded(self):
        g = copy.deepcopy(GOOD)
        g["rounds"][1]["proposals"] = [{"team": t, "votes": []} for t in ("1578", "1579", "1570", "1678", "1679", "5678")]
        rows, excluded = self.build(source(gd.SRC_SHEET, "12", g))
        self.assertEqual((rows, excluded[0]["rules"]), ([], ["FORCED_NOT_RUN"]))

    def test_clean_game_is_kept_and_counts_leave_excluded_out(self):
        other = self.stabbed("3")
        other["rounds"][1]["proposals"][0]["team"] = "1579"  # another game (does not merge with S12)
        rows, excluded = self.build(source(gd.SRC_SHEET, "12", GOOD),
                                    source(gd.SRC_PROAVALON, "ab", other, date="2021-01-01"))
        self.assertEqual([r["id"] for r in rows], ["S12"])
        counts = gd.summarize(rows, excluded)
        self.assertEqual(counts["games"], 1)
        self.assertEqual(counts["excluded"]["ASSASSIN_TEAMMATE"], {gd.GROUP_EXTERNAL: 1})

    def test_error_in_one_source_only_is_excluded_as_inconsistent(self):
        rows, excluded = self.build(source(gd.SRC_SHEET, "12", self.stabbed("4")),
                                    source(gd.SRC_DISCORD, "999", copy.deepcopy(GOOD)))  # same fingerprint, clean
        self.assertEqual(rows, [])
        self.assertEqual((excluded[0]["id"], excluded[0]["inconsistent"]), ("999", True))
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "r.md"
            gd.write_report(rows, gd.summarize(rows, excluded), {}, report, excluded)
            text = report.read_text(encoding="utf-8")
            self.assertIn("來源不一致，已排除（1）", text)
            self.assertIn("999（2026-01-02）", text)

    def test_sixth_proposal_in_the_raw_sheet_text(self):
        rounds = [["567"] * 5, ["5678"] * 6, ["5679"]]
        text = "\n".join("\n".join(teams) + "\n" + "o" * len(teams[0]) for teams in rounds)
        self.assertEqual(gd.raw_forced_rounds(text), [2])
        self.assertEqual(gd.raw_forced_rounds(text.replace("oooo\n", "ooo\n", 1)), [])  # misaligned: not trusted
        tail = "\n".join("\n".join(teams) + "\n" + "o" * len(teams[0]) for teams in rounds[:2]) + "\n" + "\n".join(["5679"] * 5)
        self.assertEqual(gd.raw_forced_rounds(tail.replace("5678\n", "", 1)), [3])  # stops after the 5th, no mission
        self.assertEqual(gd.raw_forced_rounds(tail.replace("5678\n", "", 1).rsplit("\n", 1)[0]), [])  # 4: truncated
        self.assertEqual(gd.raw_forced_rounds(tail.replace("ooo\n", "oo\n", 1)), [])  # misaligned earlier round
        decided = "\n".join(f"{t}\n{'o' * len(t)}" for t in ("567", "5678", "5679")) + "\n" + "\n".join(["56789"] * 5)
        self.assertEqual(gd.raw_forced_rounds(decided), [])  # already 3 blue: not a live forced round
        src = dict(source(gd.SRC_SHEET, "12", None), forced_rounds=[2])
        rows, excluded = self.build(src)
        self.assertEqual((rows, excluded[0]["rules"]), ([], ["FORCED_NOT_RUN"]))


class CorrectionTest(unittest.TestCase):
    def test_owner_correction_is_applied_before_the_checks(self):
        g = copy.deepcopy(GOOD)
        g["assassination"] = "4"  # the sheet says Oberon; the owner's scoresheet says 7
        sources = [source(gd.SRC_SHEET, "12", g)]
        doc = {"corrections": {"S12": {"set": {"assassination": "7"}, "by": "站長", "date": "2026-11-17", "note": "x"},
                               "S99": {"set": {"outcome": "三紅"}, "by": "站長", "date": "2026-11-17"}}}
        applied = gd.apply_corrections(sources, doc)
        self.assertEqual(g["assassination"], "4")  # the source record itself is not changed
        excluded = []
        rows = gd.build(sources, excluded)
        self.assertEqual((excluded, [r["id"] for r in rows], rows[0]["status"]), ([], ["S12"], "ok"))
        self.assertEqual(rows[0]["game"]["assassination"], "7")
        self.assertEqual(rows[0]["corrections"], [{"field": "assassination", "old": "4", "new": "7", "by": "站長", "date": "2026-11-17"}])
        self.assertEqual([a.get("missing", False) for a in applied], [False, True])
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "r.md"
            gd.write_report(rows, gd.summarize(rows), {}, report, corrections=applied)
            text = report.read_text(encoding="utf-8")
            self.assertIn("## 站長更正", text)
            self.assertIn("S12 `assassination`：4 → 7（站長 2026-11-17）", text)
            self.assertIn("S99：找不到這一局", text)

    def test_owner_exclusion(self):
        """站長裁定的錯誤局（例如 Discord 版本顯示尾派沒有出任務）：exclude 列規則，這局不記錄。"""
        sources = [source(gd.SRC_SHEET, "12", copy.deepcopy(GOOD))]
        applied = gd.apply_corrections(sources, {"corrections": {"S12": {
            "exclude": ["FORCED_NOT_RUN"], "by": "站長", "date": "2026-11-17", "note": "x"}}})
        self.assertEqual([(a["field"], a["new"]) for a in applied], [("exclude", "FORCED_NOT_RUN")])
        excluded = []
        self.assertEqual(gd.build(sources, excluded), [])
        self.assertEqual((excluded[0]["id"], excluded[0]["rules"]), ("S12", ["FORCED_NOT_RUN"]))
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "r.md"
            gd.write_report([], gd.summarize([], excluded), {}, report, excluded, corrections=applied)
            self.assertIn("S12：錯誤局，不記錄（`FORCED_NOT_RUN`，站長 2026-11-17）", report.read_text(encoding="utf-8"))
        with self.assertRaises(ValueError):
            gd.apply_corrections(sources, {"corrections": {"S12": {"exclude": ["LAKE"]}}})

    def test_only_record_fields_can_be_corrected(self):
        with self.assertRaises(ValueError):
            gd.apply_corrections([source(gd.SRC_SHEET, "12", copy.deepcopy(GOOD))],
                                 {"corrections": {"S12": {"set": {"names": []}}}})

    def test_committed_corrections_file(self):
        doc = json.loads((ROOT / "packages" / "server" / "game_db_corrections.json").read_text(encoding="utf-8"))
        s572 = doc["corrections"]["S572"]
        self.assertEqual((s572["set"], s572["by"], s572["date"]), ({"assassination": "4"}, "站長", "2026-11-17"))
        for gid in ("S211", "S2136", "S318", "S892"):  # 主控台更正: whole records retyped by the site owner
            entry = doc["corrections"][gid]
            self.assertEqual((set(entry["set"]), entry["note"]), (set(gd.CORRECTABLE), "主控台更正"))
            self.assertEqual([c["rule"] for c in gd.validate(entry["set"]) if c["level"] != gd.INFO], [], gid)
        for gid in ("S209", "S374", "S205", "S1982", "S2040", "S1810"):  # 主控台更正 2026-11-18: whole records
            entry = doc["corrections"][gid]
            self.assertEqual((set(entry["set"]), entry["by"], entry["date"]), (set(gd.CORRECTABLE), "站長", "2026-11-18"))
            self.assertEqual([c["rule"] for c in gd.validate(entry["set"]) if c["level"] != gd.INFO], [], gid)
        s673 = doc["corrections"]["S673"]  # 站長 2026-11-17「尾派沒有出任務 … 不用記錄」
        self.assertEqual((s673["exclude"], s673["by"], s673["date"], "set" in s673), (["FORCED_NOT_RUN"], "站長", "2026-11-17", False))
        self.assertIn("尾派沒有出任務 刺客刺到隊友 都屬於錯誤局 不用記錄", s673["note"])

    def test_whole_record_correction_makes_an_unreadable_source_readable(self):
        unreadable = dict(source(gd.SRC_SHEET, "12", None), forced_rounds=[2], problem="試算表這局的紀錄讀不懂（proposals）")
        whole = {f: copy.deepcopy(GOOD[f]) for f in gd.CORRECTABLE}
        applied = gd.apply_corrections([unreadable], {"corrections": {"S12": {"set": whole, "by": "站長", "date": "2026-11-17"}}})
        self.assertEqual((applied[0]["field"], applied[0]["old"]), ("record", "試算表這局的紀錄讀不懂（proposals）"))
        excluded = []
        rows = gd.build([unreadable], excluded)
        self.assertEqual((excluded, rows[0]["id"], rows[0]["status"]), ([], "S12", "ok"))
        self.assertEqual(rows[0]["fp"], rm.game_fingerprint(GOOD))
        # only part of the record: an unreadable source cannot take it
        other = dict(source(gd.SRC_SHEET, "13", None), forced_rounds=[2])
        applied = gd.apply_corrections([other], {"corrections": {"S13": {"set": {"assassination": "7"}}}})
        self.assertTrue(applied[0]["missing"])
        self.assertEqual(gd.build([other], excluded), [])

    def test_whole_record_on_a_readable_source_is_one_report_line(self):
        g = copy.deepcopy(GOOD)
        g["lakes"][0]["claim"] = "x"
        sources = [source(gd.SRC_SHEET, "12", g)]
        whole = {f: copy.deepcopy(GOOD[f]) for f in gd.CORRECTABLE}
        applied = gd.apply_corrections(sources, {"corrections": {"S12": {"set": whole, "by": "站長", "date": "2026-11-18"}}})
        self.assertEqual([(a["field"], a["old"], a["new"]) for a in applied], [("record", "原紀錄（lakes 不一樣）", gd.WHOLE_RECORD)])
        self.assertEqual(gd.build(sources)[0]["game"], GOOD)


# 配置 123456: reds 1 2 3 4, 派 5, 梅 6. Red has two failed missions after round 2; round 3 5678 then succeeds
# (all good: a red would have failed it), 0 checks 5 (o), 5 checks 9 (o) -> five iron-good seats 5 6 7 8 9.
STOPPED = {
    "config": "123456",
    "rounds": [
        {"proposals": [{"team": "157", "votes": ["890+"]}], "mission": "oox"},
        {"proposals": [{"team": "2390", "votes": ["58+"]}], "mission": "ooxx"},
        {"proposals": [{"team": "5678", "votes": ["90+"]}], "mission": "oooo"},
    ],
    "lakes": [{"after": 2, "holder": "0", "target": "5", "claim": "o"}, {"after": 3, "holder": "5", "target": "9", "claim": "o"}],
    "assassination": "6",
    "outcome": "三藍死",
}


class IronGoodTest(unittest.TestCase):
    """站長 2026-11-18「有五個鐵好了 … 幫我補上這些」：五個鐵好之後的任務是定的，總庫補上。"""

    def test_iron_good_from_missions_and_lakes(self):
        self.assertEqual(rules(STOPPED)[:1], ["UNDECIDED"])
        seats, facts = gd.iron_good(STOPPED)
        self.assertEqual(seats, list("56789"))
        self.assertIn("第 3 局 5678 成功（紅方已經兩紅，紅方出任務一定出失敗）：全是好人", facts)
        g = copy.deepcopy(STOPPED)
        g["lakes"][1]["claim"] = "?"  # no claim: 9 is not proven
        self.assertEqual(gd.iron_good(g)[0], list("5678"))
        g = copy.deepcopy(STOPPED)
        g["lakes"] = [{"after": 2, "holder": "0", "target": "9", "claim": "o"}]  # 0 is not proven good: says nothing
        self.assertEqual(gd.iron_good(g)[0], list("5678"))

    def test_success_before_two_reds_or_in_round_four_proves_less(self):
        g = copy.deepcopy(STOPPED)
        g["rounds"][1]["mission"] = "oooo"  # red has one failed mission: a red may play success on round 3
        g["rounds"][1]["proposals"][0]["team"] = "5890"
        self.assertEqual(gd.iron_good(g)[0], [])
        g = copy.deepcopy(STOPPED)  # round 4 needs two fails: a lone red on it may hide
        g["rounds"][2]["mission"] = "ooox"
        g["rounds"].append({"proposals": [{"team": "56789", "votes": []}], "mission": "ooooo"})
        g["lakes"] = g["lakes"][:1]
        self.assertNotIn("9", gd.iron_good(g)[0])

    def test_completion(self):
        done, filled = gd.complete_iron_good(STOPPED)
        self.assertEqual(filled, {"kind": gd.INFER_IRON_GOOD, "rounds": [4, 5], "team": "56789", "facts": gd.iron_good(STOPPED)[1]})
        self.assertEqual([r["proposals"][0]["team"] + r["mission"] for r in done["rounds"][3:]], ["56789ooooo"] * 2)
        self.assertEqual((done["assassination"], done["outcome"]), ("6", "三藍死"))
        self.assertEqual([c for c in rules(done) if c != "VOTE_RESULT"], [])
        self.assertEqual(len(STOPPED["rounds"]), 3)  # the record itself is not changed

    def test_no_assassination_stays_flagged(self):
        g = dict(copy.deepcopy(STOPPED), assassination="")
        done, _ = gd.complete_iron_good(g)
        self.assertIn("ASSASSIN_MISSING", rules(done))
        self.assertEqual(done["outcome"], "三藍死")

    def test_not_completed_unless_airtight(self):
        cases = {
            "four iron good": dict(copy.deepcopy(STOPPED), lakes=STOPPED["lakes"][:1]),
            "recorded 三紅": dict(copy.deepcopy(STOPPED), outcome="三紅", assassination=""),
            "target contradicts the result": dict(copy.deepcopy(STOPPED), assassination="7"),
            "another error": dict(copy.deepcopy(STOPPED), config="123455"),
        }
        for why, g in cases.items():
            self.assertIsNone(gd.complete_iron_good(g), why)
        g = copy.deepcopy(STOPPED)  # stops after round 1: a round of four is left, its team is not determined
        g["rounds"] = g["rounds"][:2]
        g["rounds"][1]["mission"] = "oooo"
        self.assertIsNone(gd.complete_iron_good(g))
        self.assertIsNone(gd.complete_iron_good(GOOD))  # decided

    def test_build_marks_the_completed_game(self):
        rows = gd.build([source(gd.SRC_SHEET, "12", copy.deepcopy(STOPPED))])
        row = rows[0]
        self.assertEqual((row["completed"]["team"], row["completed"]["rounds"], len(row["game"]["rounds"])), ("56789", [4, 5], 5))
        self.assertIn("IRON_GOOD", [c["rule"] for c in row["checks"]])
        self.assertNotIn("UNDECIDED", [c["rule"] for c in row["checks"]])
        self.assertNotEqual(row["status"], gd.ERROR)
        self.assertEqual(row["fp"], rm.game_fingerprint(STOPPED))  # merged by what the source says
        sim = gd.build([source(gd.SRC_SIM, "3", copy.deepcopy(STOPPED), kind=gd.KIND_SIM)])
        self.assertNotIn("completed", sim[0])
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "r.md"
            gd.write_report(rows, gd.summarize(rows), {}, report)
            self.assertIn("- S12：鐵好 56789；補第 4～5 局；結果 三藍死。", report.read_text(encoding="utf-8"))


class LakeChainFixTest(unittest.TestCase):
    """站長 2026-11-20「湖中鏈的修正 應該是 你可以直接判斷 接湖的必為下一湖」: corrected, not flagged."""

    FIVE = dict(copy.deepcopy(GOOD), rounds=[
        {"proposals": [{"team": "567", "votes": ["890+"]}], "mission": "ooo"},
        {"proposals": [{"team": "1578", "votes": ["90+"]}], "mission": "ooox"},
        {"proposals": [{"team": "1579", "votes": ["80+"]}], "mission": "ooox"},
        {"proposals": [{"team": "56789", "votes": ["0+"]}], "mission": "ooooo"},
        {"proposals": [{"team": "56789", "votes": ["0+"]}], "mission": "ooooo"},
    ], assassination="7", outcome="三藍活")

    @staticmethod
    def lakes(*pairs):
        return [{"after": 2 + n, "holder": h, "target": t, "claim": "o"} for n, (h, t) in enumerate(pairs)]

    def test_holder_contradicting_the_chain_is_corrected(self):
        g = dict(copy.deepcopy(self.FIVE), lakes=self.lakes(("0", "5"), ("4", "9"), ("9", "8")))
        self.assertIn("LAKE", rules(g))
        rows = gd.build([source(gd.SRC_SHEET, "12", g)])
        row = rows[0]
        self.assertEqual([(lk["holder"], lk["target"]) for lk in row["game"]["lakes"]], [("0", "5"), ("5", "9"), ("9", "8")])
        self.assertEqual(row["autoFixes"], [{"kind": "lake_chain", "lake": 2, "field": "holder", "from": "4", "to": "5"}])
        self.assertNotIn("LAKE", [c["rule"] for c in row["checks"]])
        self.assertIn("LAKE_AUTOFIX", [c["rule"] for c in row["checks"]])
        self.assertEqual(row["status"], "ok")  # an automatic correction is info, not an error
        self.assertEqual(g["lakes"][1]["holder"], "4")  # the source record itself is not edited

    def test_missing_holder_and_target_are_filled_from_the_chain(self):
        lakes, fixes = gd.fix_lake_chain(self.lakes(("0", "5"), ("", "9"), ("9", "8")), "0")
        self.assertEqual([(lk["holder"], lk["target"]) for lk in lakes], [("0", "5"), ("5", "9"), ("9", "8")])
        self.assertEqual(fixes, [{"kind": "lake_chain", "lake": 2, "field": "holder", "from": "", "to": "5"}])
        lakes, fixes = gd.fix_lake_chain(self.lakes(("0", "5"), ("5", ""), ("9", "8")), "0")
        self.assertEqual([lk["target"] for lk in lakes], ["5", "9", "8"])
        self.assertEqual(fixes, [{"kind": "lake_chain", "lake": 2, "field": "target", "from": "", "to": "9"}])
        lakes, fixes = gd.fix_lake_chain(self.lakes(("0", "5"), ("5", "")), "0")  # nothing after it: never invented
        self.assertEqual(([(lk["holder"], lk["target"]) for lk in lakes], fixes), ([("0", "5")], []))

    def test_unknown_seat_comes_from_the_claims_column_first(self):
        game = dict(copy.deepcopy(self.FIVE), lakes=self.lakes(("0", "3")))
        done = gd.unknown_seat_lakes(game, "033?79", "03x37o79x")
        self.assertEqual([(lk["after"], lk["holder"], lk["target"], lk["claim"]) for lk in done["lakes"]],
                         [(2, "0", "3", "o"), (3, "3", "7", "o")])
        done = gd.unknown_seat_lakes(game, "033?79", "03x")
        self.assertEqual(done["lakes"][1], {"after": 3, "holder": "3", "target": "", "claim": ""})

    def test_first_lake_starts_at_0_on_the_sheet_only(self):
        g = dict(copy.deepcopy(self.FIVE), lakes=self.lakes(("4", "5"), ("5", "9")))
        row = gd.build([source(gd.SRC_SHEET, "12", g)])[0]
        self.assertEqual(row["game"]["lakes"][0]["holder"], "0")
        self.assertEqual(row["autoFixes"], [{"kind": "lake_chain", "lake": 1, "field": "holder", "from": "4", "to": "0"}])
        row = gd.build([source(gd.SRC_DISCORD, "999", copy.deepcopy(g))])[0]  # a Discord table may start elsewhere
        self.assertEqual((row["game"]["lakes"][0]["holder"], row.get("autoFixes")), ("4", None))

    def test_target_is_corrected_when_the_chain_says_the_target_is_wrong(self):
        # 0>3 then 7>3: making 3 the holder would have 3 check himself, so lake 1's target is the wrong side
        lakes, fixes = gd.fix_lake_chain(self.lakes(("0", "3"), ("7", "3")), "0")
        self.assertEqual([(lk["holder"], lk["target"]) for lk in lakes], [("0", "7"), ("7", "3")])
        self.assertEqual(fixes, [{"kind": "lake_chain", "lake": 1, "field": "target", "from": "3", "to": "7"}])

    def test_ambiguous_chain_is_still_flagged(self):
        # 0>2, 1>2, 3>4: lake 1 should check 1, or lake 2 should check 3 -- cannot tell which
        g = dict(copy.deepcopy(self.FIVE), lakes=self.lakes(("0", "2"), ("1", "2"), ("3", "4")))
        row = gd.build([source(gd.SRC_SHEET, "12", g)])[0]
        self.assertNotIn("autoFixes", row)
        self.assertIn("LAKE", [c["rule"] for c in row["checks"]])
        self.assertEqual(row["status"], gd.ERROR)

    def test_genuine_rule_break_after_correction_still_flags(self):
        # lake 2's holder is corrected to 5, but 5 then checks 0, who already held the lake
        g = dict(copy.deepcopy(self.FIVE), lakes=self.lakes(("0", "5"), ("4", "0")))
        row = gd.build([source(gd.SRC_SHEET, "12", g)])[0]
        self.assertEqual([(lk["holder"], lk["target"]) for lk in row["game"]["lakes"]], [("0", "5"), ("5", "0")])
        msgs = [c["msg"] for c in row["checks"] if c["rule"] == "LAKE"]
        self.assertTrue(msgs and all("拿過湖" in m and "上一湖驗的是" not in m for m in msgs))


class MainTest(unittest.TestCase):
    def test_missing_primary_cache_leaves_outputs_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            games = d / "games.json"
            games.write_text(json.dumps({"fields": [], "vocab": {}, "games": []}), encoding="utf-8")
            out, report = d / "db.json", d / "r.md"
            out.write_text("old", encoding="utf-8")
            report.write_text("old", encoding="utf-8")
            args = ["--games", str(games), "--records", str(d / "none.json"), "--snapshot", str(d / "x.json"),
                    "--sim-bank", str(d / "x.json"), "--proavalon", str(d / "x.json"),
                    "--output", str(out), "--check-report", str(report)]
            self.assertEqual(gd.main(args), 1)
            self.assertEqual((out.read_text(encoding="utf-8"), report.read_text(encoding="utf-8")), ("old", "old"))
            self.assertEqual(gd.main(["--games", str(d / "none.json")] + args[2:]), 1)
            self.assertEqual(out.read_text(encoding="utf-8"), "old")

    def test_proavalon_is_left_out_unless_turned_back_on(self):
        # 站長 2026-11-18「我看ProAvalon 的局基本上很多都在亂玩 其實可以考慮刪掉了」: off by default, reversible.
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "games.json").write_text(json.dumps({"fields": [], "vocab": {}, "games": []}), encoding="utf-8")
            (d / "records.json").write_text(json.dumps({"posts": []}), encoding="utf-8")
            pa_doc = {"games": [{"id": "abc123", "date": "2021-01-01", "venue": "線瓦", "flags": [], "game": GOOD}]}
            (d / "pa.json").write_text(json.dumps(pa_doc, ensure_ascii=False), encoding="utf-8")
            out, report = d / "db.json", d / "r.md"
            args = ["--games", str(d / "games.json"), "--records", str(d / "records.json"),
                    "--snapshot", str(d / "x.json"), "--sim-bank", str(d / "x.json"), "--proavalon", str(d / "pa.json"),
                    "--corrections", str(d / "x.json"), "--output", str(out), "--check-report", str(report)]
            self.assertFalse(gd.INCLUDE_PROAVALON)
            self.assertEqual(gd.main(args), 0)
            db = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual((db["games"], db["counts"]["external"]), ([], 0))
            text = report.read_text(encoding="utf-8")
            self.assertIn("ProAvalon（停用）", text)
            self.assertIn("--with-proavalon", text)
            self.assertNotIn("| 外部 |", text)
            self.assertEqual(gd.main(args + ["--with-proavalon"]), 0)
            db = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual([(g["id"], g.get("external")) for g in db["games"]], [("Pabc123", True)])
            text = report.read_text(encoding="utf-8")
            self.assertIn("ProAvalon（匿名）", text)
            self.assertNotIn("停用", text)


class SplitTest(unittest.TestCase):
    """player_aliases.json "splits" (one name, two people) against the database: game ids only, no names."""

    def test_split_ids_resolve_to_database_games(self):
        import generate_cache as gc  # noqa: PLC0415
        post = "1571000000000000009"
        rows = gd.build([source(gd.SRC_SHEET, "1", GOOD), source(gd.SRC_DISCORD, post, GOOD)])
        self.assertEqual([r["id"] for r in rows], [post])
        splits = gc.parse_player_aliases({"aliases": {}, "splits": {"Ilse Marr": [
            {"as": "Orla Pike", "games": ["S1", "S2"]}, {"as": "Orla Pike", "games": [post]},
            {"as": "Orla Pike", "venue": "面瓦"}]}}).splits
        got = gd.split_games(rows, [{"id": "S3", "sources": ["S3"]}], splits)
        self.assertEqual(got, {"rules": 3, "filterRules": 1, "listed": 3, "games": [post], "missing": ["S2"], "excluded": []})
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "r.md"
            counts = gd.summarize(rows)
            gd.write_report(rows, counts, {}, report, collisions={"a1": {"names": 1, "games": 1}}, splits=got)
            text = report.read_text(encoding="utf-8")
        self.assertIn("## 同名不同人（名字碰撞）候選", text)
        self.assertIn("| `a1` | 確定 |", text)
        self.assertIn("列出的 3 個局號對到總庫的 1 局", text)
        self.assertIn("總庫裡找不到的局號（打錯、或不是統計用的局）：S2", text)
        self.assertNotRegex(text, "Ilse|Orla")


class WorkflowTest(unittest.TestCase):
    def test_nightly_workflow_builds_and_commits_the_database(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("packages/server/game_db.py", text)
        self.assertIn("GAME_DB_PATH", text)
        self.assertIn("python packages/server/test_game_db.py", text)


if __name__ == "__main__":
    unittest.main()
