"""Offline tests for generate_cache.py: credentials, sanity guards, carry-over, write path,
--compare, the per-player stats it aggregates from 牌譜, the two-stage outcome fields, the
theory win rates (TheoryTest: hand-computed), the leaderboard, the featureStudies it
computes / annotates, and the game-level dataset games_cache.json written with the cache
(複合篩選, Edward 2026-10-14: NoteTagTest, GamesDatasetTest, SnapshotDatasetTest,
DatasetEndToEndTest -- round trip, no free text, written together or withheld). Every cache is
built for a fixed reference day (never "today").

No network and no Google libraries needed (stdlib unittest; pytest also collects it).
Fixtures are fake, except read-only checks against checked-in data: the committed
analysis_cache.json (CommittedCachePropertyTest, FeatureStudiesTest) and the 牌譜 snapshot in
sheets_cache.json (SnapshotShapeTest; RebuildReplayTest, skipped once a refresh replaced the
2026-04-26 cache). The wording of the annotated studies is checked on frozen fixtures
(AnnotationTextTest), never on the committed numbers, which the owner rebuilds now and then.

    python packages/server/test_generate_cache.py
"""

from __future__ import annotations

import copy
import datetime as dt
import io
import json
import os
import stat
import sys
import tempfile
import unittest
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from fractions import Fraction
from pathlib import Path
from typing import Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_cache as gc  # noqa: E402

FAKE_KEY = {
    "type": "service_account",
    "client_email": "stats-bot@fake-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\nSECRET-MARKER\n-----END PRIVATE KEY-----\n",
}
CI_ENV = ("GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY", gc.ENV_CREDENTIALS_FILE, gc.ENV_CREDENTIALS_JSON, gc.ENV_SHEET_ID, gc.ENV_AS_OF)
AS_OF = dt.date(2026, 10, 12)

# The LEADERBOARD_CONFIG every hand-computed example below was worked out with. The whole module
# runs with it (setUpModule), so the owner can change a knob in generate_cache.py -- e.g. turn the
# sparse-cell top-up off with theoryMinCellGames = 0, or rank on the last 80 games -- without
# failing the daily refresh workflow, which runs these tests before it regenerates the cache.
# LeaderboardConfigTest checks the owner's real values (REAL_LEADERBOARD_CONFIG) on their own.
# theoryMinCellGames 5 since 2026-10-14 (Edward：「建議補到 5 場」; the examples were reworked for it,
# TheoryTest keeps the 3-game example with an explicit min_cell).
TEST_LEADERBOARD_CONFIG: dict = {
    "theoryMinCellGames": 5, "activeDays": 90, "topN": 10, "mainGames": 100, "roleWindowGames": 10,
    "loyalWindowGames": 40, "overallMinGames": 250, "theoryMinGames": 0, "requireRoleWindows": 1,
    "assassinAttempts": 20, "assassinMinAttempts": 10,
    "newcomerDays": 90, "newcomerMinGames": 10,
    # roleTitles with a fixed 20-game window in every role (full = fallback): the examples below were
    # worked out with it; RoleTitleWindowTest covers the majority rule (2026-10-28).
    "roleTitleGames": 20, "roleTitleFallbackGames": 20, "loyalTitleGames": 20, "loyalTitleFallbackGames": 20,
}
REAL_LEADERBOARD_CONFIG: dict = copy.deepcopy(gc.LEADERBOARD_CONFIG)
_PINNED_CONFIG = mock.patch.dict(gc.LEADERBOARD_CONFIG, TEST_LEADERBOARD_CONFIG, clear=True)


def setUpModule() -> None:  # noqa: N802 (unittest / pytest hook name)
    _PINNED_CONFIG.start()


def tearDownModule() -> None:  # noqa: N802
    _PINNED_CONFIG.stop()


def config_patch(**values: object) -> mock._patch:
    """LEADERBOARD_CONFIG with `values` changed (on top of TEST_LEADERBOARD_CONFIG)."""
    return mock.patch.dict(gc.LEADERBOARD_CONFIG, values)


def quiet_env(**extra: str) -> mock._patch:
    """os.environ without CI / credential variables (plus `extra`)."""
    env = {k: v for k, v in os.environ.items() if k not in CI_ENV}
    env.update(extra)
    return mock.patch.dict(os.environ, env, clear=True)


def fake_cache(games: int = 100, players: int = 3, chem_players: int = 2, player_fields: dict | None = None) -> dict:
    rows = [{"name": f"P{i}", "totalGames": 10 + i, **(player_fields or {})} for i in range(players)]
    names = [f"C{i}" for i in range(chem_players)]
    matrix = {"players": names, "rowLabels": names, "values": [[None] * chem_players for _ in names]}
    return {
        "overview": {"totalGames": games, "totalPlayers": players},
        "players": {"players": rows, "total": players},
        "playerDetails": {r["name"]: {"player": r, "radar": {}} for r in rows},
        "chemistry": {k: dict(matrix) for k in gc.CHEMISTRY_MATRICES},
        "missions": {}, "lake": {}, "rounds": {}, "seatOrder": {}, "captainAnalysis": {}, "leaderboard": {},
        "strength": {"perPlayer": {}},
    }


def with_theory(cache: dict) -> dict:
    """`cache` with a minimal valid players[].theory per row (career.games = totalGames)."""
    for row in cache["players"]["players"]:
        row["theory"] = {"career": {"games": int(row["totalGames"])}}
    return cache


# ---------------------------------------------------------------------------
# Credential source resolution
# ---------------------------------------------------------------------------

class CredentialResolutionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.key_file = Path(self.tmp.name) / "key.json"
        self.key_file.write_text(json.dumps(FAKE_KEY), encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_file_env_wins_over_json_env(self) -> None:
        src = gc.resolve_credentials_source({
            gc.ENV_CREDENTIALS_FILE: str(self.key_file),
            gc.ENV_CREDENTIALS_JSON: json.dumps({"client_email": "other@x"}),
        })
        self.assertEqual((src.kind, src.path), ("file", self.key_file))
        self.assertEqual(src.client_email(), FAKE_KEY["client_email"])

    def test_missing_file_env_fails_instead_of_falling_back(self) -> None:
        with self.assertRaises(gc.FatalError) as ctx:
            gc.resolve_credentials_source({
                gc.ENV_CREDENTIALS_FILE: str(Path(self.tmp.name) / "nope.json"),
                gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY),
            })
        self.assertEqual(ctx.exception.exit_code, gc.EXIT_CONFIG)

    def test_json_env_used_when_file_env_blank(self) -> None:
        src = gc.resolve_credentials_source({gc.ENV_CREDENTIALS_FILE: "  ", gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY)})
        self.assertEqual(src.kind, "json")
        self.assertEqual(src.info, FAKE_KEY)
        self.assertEqual(src.client_email(), FAKE_KEY["client_email"])
        self.assertNotIn("SECRET-MARKER", repr(src))  # the key never shows up in logs

    def test_invalid_json_env_reports_position_not_content(self) -> None:
        with self.assertRaises(gc.FatalError) as ctx:
            gc.resolve_credentials_source({gc.ENV_CREDENTIALS_JSON: '{"private_key": "SECRET-MARKER",'})
        self.assertEqual(ctx.exception.exit_code, gc.EXIT_CONFIG)
        self.assertNotIn("SECRET-MARKER", str(ctx.exception))
        self.assertIn("line 1", str(ctx.exception))

    def test_non_object_json_env_rejected(self) -> None:
        with self.assertRaises(gc.FatalError):
            gc.resolve_credentials_source({gc.ENV_CREDENTIALS_JSON: "[1, 2]"})

    def test_default_path_when_nothing_set(self) -> None:
        src = gc.resolve_credentials_source({})
        self.assertEqual((src.kind, src.origin, src.path), ("file", "default path", gc.DEFAULT_CREDENTIALS_PATH))
        self.assertIsNone(src.client_email())  # file absent here: no crash

    def test_bad_private_key_reported_without_key_material(self) -> None:
        class PyAsn1Error(Exception):  # what pyasn1 raises for a mangled private_key
            pass

        creds = mock.Mock()
        creds.from_service_account_info.side_effect = PyAsn1Error("substrate SECRET-MARKER")
        source = gc.CredentialSource(kind="json", origin="test", info=FAKE_KEY)
        with mock.patch.object(gc, "Credentials", creds), mock.patch.object(gc, "gspread", mock.Mock()):
            with self.assertRaises(gc.FatalError) as ctx:
                gc.load_credentials(source)
        self.assertEqual(ctx.exception.exit_code, gc.EXIT_CONFIG)
        self.assertIn("PyAsn1Error", str(ctx.exception))
        self.assertNotIn("SECRET-MARKER", str(ctx.exception))

    def test_sheet_id_default_and_override(self) -> None:
        self.assertEqual(gc.resolve_sheet_id({}), gc.SHEET_ID)
        self.assertEqual(gc.resolve_sheet_id({gc.ENV_SHEET_ID: " "}), gc.SHEET_ID)
        self.assertEqual(gc.resolve_sheet_id({gc.ENV_SHEET_ID: " abc123 "}), "abc123")


# ---------------------------------------------------------------------------
# Google error classification / messages (fake exception classes)
# ---------------------------------------------------------------------------

class RefreshError(Exception):
    pass


class TransportError(Exception):
    pass


class SpreadsheetNotFound(Exception):
    pass


class WorksheetNotFound(Exception):
    pass


class APIError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.error = {"code": code, "message": message}
        self.response = mock.Mock(status_code=code)


class GoogleErrorTest(unittest.TestCase):
    def test_classification(self) -> None:
        def wrapped_403() -> PermissionError:  # how gspread 6 reports HTTP 403 on open_by_key
            try:
                raise APIError(403, "The caller does not have permission")
            except APIError as api:
                try:
                    raise PermissionError from api
                except PermissionError as exc:
                    return exc

        cases = [
            (RefreshError("invalid_grant"), "auth"),
            (TransportError("dns"), None),
            (SpreadsheetNotFound(), "not_found"),
            (WorksheetNotFound("牌譜"), "missing_worksheet"),
            (wrapped_403(), "permission"),
            (APIError(403, "nope"), "permission"),
            (APIError(401, "nope"), "auth"),
            (APIError(404, "nope"), "not_found"),
            (APIError(500, "boom"), None),
            (ValueError("x"), None),
        ]
        for exc, expected in cases:
            with self.subTest(exc=type(exc).__name__):
                self.assertEqual(gc.classify_google_error(exc), expected)

    def test_permission_message_names_service_account(self) -> None:
        try:
            raise PermissionError from APIError(403, "The caller does not have permission")
        except PermissionError as exc:
            msg = gc.google_access_error_message("permission", exc, "SHEET", "bot@p.iam.gserviceaccount.com")
        self.assertIn("Share the Google Sheet with bot@p.iam.gserviceaccount.com", msg)
        self.assertIn("SHEET", msg)
        self.assertIn("The caller does not have permission", msg)

    def test_disabled_api_gets_its_own_hint(self) -> None:
        exc = APIError(403, "Google Sheets API has not been used in project 123 before or it is disabled.")
        msg = gc.google_access_error_message("permission", exc, "SHEET", "bot@p")
        self.assertIn("Enable the Google Sheets API", msg)

    def test_fetch_wraps_google_errors_with_email(self) -> None:
        source = gc.CredentialSource(kind="json", origin="test", info=FAKE_KEY)

        def deny(*_args):
            raise PermissionError from APIError(403, "The caller does not have permission")

        with mock.patch.object(gc, "open_spreadsheet", deny), redirect_stdout(io.StringIO()):
            with self.assertRaises(gc.FatalError) as ctx:
                gc.fetch_sheet_data(source, "SHEET")
        self.assertEqual(ctx.exception.exit_code, gc.EXIT_GOOGLE_ACCESS)
        self.assertIn(FAKE_KEY["client_email"], str(ctx.exception))
        self.assertNotIn("SECRET-MARKER", str(ctx.exception))

    def test_emit_error_github_annotation_is_single_line(self) -> None:
        out = io.StringIO()
        with quiet_env(GITHUB_ACTIONS="true"), redirect_stdout(out):
            gc.emit_error("line one\nline two 100%", "A: title, here")
        self.assertEqual(out.getvalue(), "::error title=A%3A title%2C here::line one%0Aline two 100%25\n")


# ---------------------------------------------------------------------------
# Sanity guard
# ---------------------------------------------------------------------------

class SanityGuardTest(unittest.TestCase):
    def test_allowed_drop(self) -> None:
        self.assertEqual(gc.allowed_drop(0), 5)
        self.assertEqual(gc.allowed_drop(100), 5)
        self.assertEqual(gc.allowed_drop(2146), 22)

    def test_same_and_growth_pass(self) -> None:
        prev = fake_cache(games=2146)
        for games in (2146, 2200):
            with self.subTest(games=games):
                self.assertEqual(gc.validate_new_cache(fake_cache(games=games), prev), [])
        self.assertEqual(gc.validate_new_cache(fake_cache(players=5), fake_cache(players=3)), [])  # new players

    def test_any_game_drop_refused_unless_allowed(self) -> None:
        prev = fake_cache(games=2146)
        for games, fewer in ((2145, 1), (2146 - 23, 23)):
            with self.subTest(games=games):
                problems = gc.validate_new_cache(fake_cache(games=games), prev)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(f"would drop from 2146 to {games} ({fewer} fewer)", problems[0])
                self.assertEqual(gc.validate_new_cache(fake_cache(games=games), prev, allow_shrink=True), [])

    def test_large_player_drop_refused(self) -> None:
        problems = gc.validate_new_cache(fake_cache(players=3), fake_cache(players=30))
        self.assertTrue(any("players" in p and "fewer" in p for p in problems), problems)

    def test_player_losing_games_refused_and_listed(self) -> None:
        prev = fake_cache(players=12)  # P0..P11 with 10..21 games
        new = fake_cache(players=12)
        rows = new["players"]["players"]
        rows[3]["totalGames"] = 11.0   # P3 13 -> 11
        rows[7]["totalGames"] = 16     # P7 17 -> 16 (int is fine too)
        rows[5]["totalGames"] = 99.0   # growth is fine
        problems = gc.validate_new_cache(new, prev)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("2 existing player(s) would have fewer games", problems[0])
        self.assertIn("P3 13→11, P7 17→16", problems[0])  # biggest drop first
        self.assertEqual(gc.validate_new_cache(new, prev, allow_shrink=True), [])

        renamed = fake_cache(players=12)
        for row in renamed["players"]["players"]:
            row["name"] = "Q" + row["name"]  # every old name disappears (retyped, not just re-cased)
        problem = next(p for p in gc.validate_new_cache(renamed, prev) if "existing player" in p)
        self.assertIn("12 existing player(s)", problem)
        self.assertIn("P11 21→gone", problem)
        self.assertIn(f"(+{12 - gc.MAX_LISTED_REGRESSIONS} more)", problem)
        self.assertEqual(
            [r[0] for r in gc.games_regressions(renamed, prev)][:3], ["P11", "P10", "P9"],
        )
        recased = fake_cache(players=12)
        for row in recased["players"]["players"]:
            row["name"] = row["name"].lower()  # same players, other case: no regression
        self.assertEqual(gc.games_regressions(recased, prev), [])

    def test_rewritten_discord_rows_explain_a_corrected_name(self) -> None:
        """A Discord匯入 row rewritten from an edited post (a corrected player id) takes its game
        from the old spelling; the guard lets that through, and only that much."""
        prev = fake_cache(players=12)  # P0..P11 with 10..21 games
        new = fake_cache(players=12)
        rows = new["players"]["players"]
        rows[3]["totalGames"] = 12.0  # P3 13 -> 12: the corrected spelling
        rows[5]["totalGames"] = 16.0  # P5 15 -> 16: the right one
        self.assertTrue(gc.validate_new_cache(new, prev))
        self.assertEqual(gc.validate_new_cache(new, prev, rewritten_rows=1), [])
        rows[4]["totalGames"] = 12.0  # P4 14 -> 12: two games, one row cannot do that
        self.assertTrue(gc.validate_new_cache(new, prev, rewritten_rows=1))
        self.assertEqual(gc.validate_new_cache(new, prev, rewritten_rows=2), [])
        self.assertFalse(gc.explained_by_rewrites([(f"P{i}", 10.0, 9.0) for i in range(11)], 1))  # > 10 seats
        self.assertTrue(gc.explained_by_rewrites([(f"P{i}", 10.0, 9.0) for i in range(10)], 1))
        self.assertTrue(gc.explained_by_rewrites([], 0))

        gone = fake_cache(players=12)
        gone["players"]["players"][0]["name"] = "Q0"  # P0's every game was the typo: P0 is gone
        self.assertEqual(gc.validate_new_cache(gone, prev, rewritten_rows=10), [])  # no lost player either
        fewer = fake_cache(games=99, players=12)  # and a game fewer: only a row now a duplicate explains that
        problems = gc.validate_new_cache(fewer, prev, rewritten_rows=1)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("(1 Discord匯入 row(s) rewritten from edited posts since the existing cache do not explain it)",
                      problems[0])
        self.assertEqual(gc.validate_new_cache(fewer, prev, rewritten_rows=1, rewritten_duplicates=1), [])

    def test_public_log_messages_name_nobody(self) -> None:
        prev = fake_cache(players=12)
        new = with_theory(fake_cache(players=12))
        for row in new["players"]["players"][:3]:
            row["totalGames"] -= 2.0
            row["theory"]["career"]["games"] = 1
        new["players"]["players"][11]["name"] = "Q11"
        problems = gc.validate_new_cache(new, prev, show_names=False, rewritten_rows=1)
        text = "\n".join(problems)
        self.assertIn("4 existing player(s) would have fewer games than in the existing cache (1 of them gone; "
                      "biggest drop 21 game(s); names are listed only outside GitHub Actions)", text)
        self.assertIn("3 player(s) have a theory block that does not match their games (theory", text)
        self.assertNotRegex(text, r"\b[PQ]\d+\b")
        self.assertIn("P11 21→gone", "\n".join(gc.validate_new_cache(new, prev)))  # local runs: named
        lines = "\n".join(gc.compare_summary(new, prev, show_names=False))
        self.assertIn("新增 1；消失 1", lines)
        self.assertIn("| # | 局數 | 勝率 |", lines)
        self.assertNotRegex(lines, r"\b[PQ]\d+\b")
        self.assertIn("新增 1：Q11；消失 1：P11", "\n".join(gc.compare_summary(new, prev)))

    def test_empty_or_malformed_always_refused(self) -> None:
        empty_games = fake_cache(games=0)
        no_players = fake_cache()
        no_players["players"] = {"players": [], "total": 0}
        no_players["playerDetails"] = {}
        missing = fake_cache()
        del missing["lake"]
        for name, cache in (("zero games", empty_games), ("no players", no_players), ("missing lake", missing)):
            with self.subTest(name):
                self.assertTrue(gc.validate_new_cache(cache, None, allow_shrink=True))
                self.assertTrue(gc.validate_new_cache(cache, fake_cache(), allow_shrink=True))

    def test_emptied_chemistry_refused(self) -> None:
        problems = gc.validate_new_cache(fake_cache(chem_players=0), fake_cache(chem_players=5))
        self.assertEqual(len(problems), len(gc.CHEMISTRY_MATRICES))

    def test_no_previous_only_structural_checks(self) -> None:
        self.assertEqual(gc.validate_new_cache(fake_cache(games=1), None), [])

    def test_new_player_fields_are_not_a_loss(self) -> None:
        prev = fake_cache(player_fields={f: 0 for f in PLAYER_FIELDS if f != "name"})
        two_stage = fake_cache(player_fields={f: 0 for f in TWO_STAGE_PLAYER_FIELDS if f != "name"})
        schema3 = with_theory(fake_cache(player_fields={f: 0 for f in SCHEMA3_PLAYER_FIELDS if f not in ("name", "theory")}))
        new = with_theory(fake_cache(player_fields={f: 0 for f in ALL_PLAYER_FIELDS if f not in ("name", "theory")}))
        self.assertEqual(gc.validate_new_cache(new, prev), [])
        self.assertEqual(gc.validate_new_cache(new, two_stage), [])  # the 2026-10-12 shape -> schemaVersion 4
        self.assertEqual(gc.validate_new_cache(new, schema3), [])  # the 2026-10-13 shape -> schemaVersion 4
        self.assertEqual(gc.dropped_player_fields(prev, new),
                         sorted(NEW_PLAYER_FIELDS + ROLE_OUTCOME_FIELDS + THEORY_FIELDS + ["voting"]))  # the reverse would be a loss
        self.assertEqual(gc.dropped_player_fields(schema3, new), ROLE_OUTCOME_FIELDS + ["voting"])

    def test_theory_must_match_the_row(self) -> None:
        new = with_theory(fake_cache(players=4))
        new["players"]["players"][1]["theory"]["career"]["games"] = 99  # P1 has 11 games
        new["players"]["players"][2]["theory"] = "junk"
        problems = gc.validate_new_cache(new, None)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("2 player(s) have a theory block that does not match their games: P1、P2", problems[0])
        self.assertEqual(gc.validate_new_cache(with_theory(fake_cache(players=4)), None), [])
        broken = fake_cache()
        broken["leaderboard"] = {"boards": "junk"}
        self.assertEqual(gc.validate_new_cache(broken, None), ["leaderboard.boards is not a list"])

    def test_player_field_loss_refused_even_with_allow_shrink(self) -> None:
        prev = fake_cache(player_fields={"roleSeatStats": {}, "rawRedThreeRed": 1})
        new = fake_cache()
        self.assertEqual(gc.dropped_player_fields(new, prev), ["rawRedThreeRed", "roleSeatStats"])
        self.assertTrue(gc.validate_new_cache(new, prev, allow_shrink=True))
        self.assertEqual(gc.validate_new_cache(new, prev, allow_field_loss=True), [])


# ---------------------------------------------------------------------------
# Carry-over of sections this script cannot rebuild
# ---------------------------------------------------------------------------

def placeholder(total_games: float) -> dict:
    return {"hasData": False, "sampleSize": int(total_games)}


class CarryOverTest(unittest.TestCase):
    def make_previous(self) -> dict:
        prev = fake_cache(games=50, players=2)
        prev["overview"]["marker"] = "old"
        prev["archetype"] = {"perPlayer": {"P0": {"hasData": True, "axes": {"honesty": 70}}}, "cohort": {"n": 1}}
        prev["playstyle"] = {"perPlayer": {"P0": {"hasData": True}, "Gone": {"hasData": True}}, "labels": {"x": "y"}}
        prev["featureStudies"] = {"generatedAt": "2026-04-27T15:04:56+08:00", "features": [{"loopId": "L1"}]}
        prev["someFutureSection"] = {"k": 1}
        return prev

    def test_carries_missing_sections_and_backfills_new_players(self) -> None:
        prev = self.make_previous()
        snapshot = json.dumps(prev, sort_keys=True)
        new = fake_cache(games=60, players=3)  # P0, P1, P2
        carried = gc.carry_over_sections(new, prev, {"archetype": placeholder, "playstyle": placeholder})

        self.assertEqual(carried, {"archetype": 2, "playstyle": 2, "featureStudies": 0, "someFutureSection": 0})
        self.assertEqual(new["featureStudies"], prev["featureStudies"])  # verbatim, incl. generatedAt
        self.assertEqual(new["someFutureSection"], {"k": 1})
        self.assertEqual(new["archetype"]["perPlayer"]["P0"], {"hasData": True, "axes": {"honesty": 70}})
        self.assertEqual(new["archetype"]["perPlayer"]["P2"], {"hasData": False, "sampleSize": 12})
        self.assertEqual(new["archetype"]["cohort"], {"n": 1})
        self.assertIn("Gone", new["playstyle"]["perPlayer"])  # existing rows are never dropped
        self.assertNotIn("marker", new["overview"])  # Sheet sections are not overwritten by old data
        self.assertEqual(json.dumps(prev, sort_keys=True), snapshot)  # previous untouched

    def test_nothing_to_carry_without_previous(self) -> None:
        new = fake_cache()
        self.assertEqual(gc.carry_over_sections(new, None, {}), {})
        self.assertEqual(set(new), set(fake_cache()))

    def test_assemble_recomputes_strength_and_keeps_section_order(self) -> None:
        prev = self.make_previous()
        fresh = {k: v for k, v in fake_cache(games=60).items() if k != "strength"}
        cache, carried = gc.assemble_cache(
            fresh, prev, strength_builder=lambda players: {"perPlayer": {p["name"]: {} for p in players}},
            placeholder_builders={},
        )
        self.assertEqual(list(cache), list(prev))  # same order as the existing file
        self.assertEqual(set(cache["strength"]["perPlayer"]), {"P0", "P1", "P2"})
        self.assertIn("featureStudies", carried)

    def test_real_builders_from_scripts(self) -> None:
        strength = gc.default_strength_builder()([
            {"name": n, "roleWinRates": {"梅林": wr}, "rawRoleGames": {"梅林": 5}}
            for n, wr in (("甲", 80.0), ("乙", 40.0), ("丙", 60.0))
        ])
        self.assertEqual(strength["cohort"]["perRole"]["梅林"], {"mean": 60.0, "std": 16.3, "n": 3})
        self.assertEqual(strength["perPlayer"]["甲"]["roles"][5]["color"], "high")
        builders = gc.default_placeholder_builders()
        self.assertEqual(builders["archetype"](7.0)["sampleSize"], 7)
        self.assertFalse(builders["playstyle"](7.0)["hasData"])

    def test_owner_scripts_key_names_like_the_cache(self) -> None:
        arche = gc._load_local_script("build_archetype_strength")
        panel = gc._load_local_script("build_panel_c_playstyle")
        for spelling in ("Nova", "NOVA", " ｎｏｖａ ", "No\u200bva"):
            self.assertEqual(arche.player_name_key(spelling), gc.player_name_key(spelling))
            self.assertEqual(panel.player_name_key(spelling), gc.player_name_key(spelling))

        def row(games: int, votes: int, hist: dict) -> dict:
            return {"totalGames": games, "r3VotesRed": votes, "r3RejectsRed": 1, "r3VotesBlue": 0, "r3RejectsBlue": 0,
                    "assassinAttempts": sum(hist.values()), "assassinTargetSeatHist": hist,
                    "leaderProposals": 2, "leaderProposalsSame": 1}
        rows = {"Nova": row(30, 8, {"8": 2}), "NOVA": row(5, 4, {"8": 1, "5": 1}), "Kite": row(9, 1, {})}
        merged = panel.merge_spellings(rows)
        self.assertEqual(set(merged), {"nova", "kite"})
        self.assertEqual((merged["nova"]["totalGames"], merged["nova"]["r3VotesRed"], merged["nova"]["r3RejectsRed"]), (35, 12, 2))
        self.assertEqual(merged["nova"]["assassinTargetSeatHist"], {"8": 3, "5": 1})
        self.assertEqual(rows["Nova"]["assassinTargetSeatHist"], {"8": 2})  # input untouched
        # players.aliases of the cache they update (made-up names): an old name's row is its official name's.
        cache = {"players": {"aliases": {"Tovo Wren": "Ilse Marr", "Bad": 3}}}
        for script in (arche, panel):
            self.assertEqual(script.alias_keys(cache), {"tovo wren": "ilse marr"})
            self.assertEqual(script.alias_keys({}), {})
        aliased = panel.merge_spellings({"TOVO WREN": row(30, 8, {"8": 2}), "Ilse Marr": row(5, 4, {"5": 1})},
                                        arche.alias_keys(cache))
        self.assertEqual(set(aliased), {"ilse marr"})
        self.assertEqual((aliased["ilse marr"]["totalGames"], aliased["ilse marr"]["assassinTargetSeatHist"]),
                         (35, {"8": 2, "5": 1}))


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

class WriteTest(unittest.TestCase):
    def test_atomic_write_keeps_mode_and_leaves_no_temp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "analysis_cache.json"
            path.write_text("{}", encoding="utf-8")
            os.chmod(path, 0o644)
            gc.write_cache_atomically({"a": "中文"}, path)
            self.assertEqual(path.read_text(encoding="utf-8"), '{\n  "a": "中文"\n}')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(os.listdir(tmp), ["analysis_cache.json"])

    def test_failed_write_keeps_old_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "analysis_cache.json"
            path.write_text('{"old": true}', encoding="utf-8")
            with self.assertRaises(TypeError):
                gc.write_cache_atomically({"bad": object()}, path)
            self.assertEqual(path.read_text(encoding="utf-8"), '{"old": true}')
            self.assertEqual(os.listdir(tmp), ["analysis_cache.json"])

    def test_unreadable_previous_refused_unless_allowed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "analysis_cache.json"
            path.write_text("<<<<<<< conflict", encoding="utf-8")
            with self.assertRaises(gc.FatalError) as ctx:
                gc.load_previous_cache(path)
            self.assertEqual(ctx.exception.exit_code, gc.EXIT_DATA)
            with redirect_stdout(io.StringIO()):
                self.assertIsNone(gc.load_previous_cache(path, allow_shrink=True))
                self.assertIsNone(gc.load_previous_cache(Path(tmp) / "missing.json"))


# ---------------------------------------------------------------------------
# 牌譜 fixture helpers
# ---------------------------------------------------------------------------

ROUND_RESULT_COLS = ["第一局成功失敗", "第二局成功失敗", "第三局成功失敗", "第四局成功失敗", "第五局成功失敗"]
LOG_HEADERS = (
    ["流水號", "文字記錄", "配置", "刺殺", "分類", "日期時間"] + [gc.PLAYER_COLUMNS[s] for s in gc.SEATS]
    + ["結果", "1-1"] + ROUND_RESULT_COLS + ["第一局", "第二局", "第三局", "第四局", "第五局", "局勢", "首湖", "二湖", "三湖"]
)
DEFAULT_TEXT = "157\nooo\n2>8\n2468\noxo"


def log_row(gid: str, config: str, outcome: str, names: list[str], date: str = "", category: str = "",
            text: str = DEFAULT_TEXT, kill: str = "") -> list[str]:
    """One 牌譜 row; `names` are the 玩1..玩9, 玩0 cells (seat order of gc.SEATS)."""
    cells = {
        "流水號": gid, "文字記錄": text, "配置": config, "結果": outcome, "1-1": "157",
        "刺殺": kill, "分類": category, "日期時間": date,
        "第一局成功失敗": "ooo", "第二局成功失敗": "oxo", "第三局成功失敗": "ooo",
        "第一局": "藍", "第二局": "紅", "第三局": "藍", "局勢": "藍紅藍", "首湖": "7>1",
    }
    cells.update({gc.PLAYER_COLUMNS[s]: n for s, n in zip(gc.SEATS, names)})
    return [cells.get(h, "") for h in LOG_HEADERS]


# ---------------------------------------------------------------------------
# Per-player aggregation from 牌譜 (synthetic fixture, every field checked)
# ---------------------------------------------------------------------------

SEAT_NAMES = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]  # seats 1..9, then seat 0 (= 10)
ROLE_ORDER = ["刺客", "莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林", "忠臣"]
SEAT_ORDER = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
# The fields of the 2026-04-26 rebuild (commit 61b7398), in its order. Their values never change.
PLAYER_FIELDS = [
    "name", "totalGames", "winRate", "roleTheory", "positionTheory", "redWin", "blueWin",
    "red3Red", "redMerlinDead", "redMerlinAlive", "blue3Red", "blueMerlinDead", "blueMerlinAlive",
    "roleWinRates", "roleDistribution", "redRoleRate", "blueRoleRate",
    "seatWinRates", "seatRedWinRates", "seatBlueWinRates", "rawRoleGames",
    "rawRedWins", "rawBlueWins", "rawTotalWins", "rawRedGames", "rawBlueGames",
    "rawRedThreeRed", "rawRedMerlinDead", "rawRedMerlinAlive",
    "rawBlueThreeRed", "rawBlueMerlinDead", "rawBlueMerlinAlive", "roleSeatStats", "seatOutcomes",
]
# Two-stage fields (docs/stats/two_stage_outcome.md), written after roleSeatStats, before seatOutcomes.
NEW_PLAYER_FIELDS = [
    "finalWinRate", "finalRedWinRate", "finalBlueWinRate", "missionWinRate", "merlinSurvivalRate",
    "rawBlueThreeBlue", "roleFinalWinRates", "expectedFinalWinRate", "excessWinRate", "firstPlayed", "lastPlayed",
]
# Theory win rates (Edward 2026-10-13, schemaVersion 3), written after lastPlayed.
THEORY_FIELDS = ["theory"]
# Per-role 三紅 / 三藍死 / 三藍活 counts (schemaVersion 4, 2026-10-14), between lastPlayed and theory.
ROLE_OUTCOME_FIELDS = ["roleOutcomes"]
TWO_STAGE_PLAYER_FIELDS = PLAYER_FIELDS[:-1] + NEW_PLAYER_FIELDS + ["seatOutcomes"]
SCHEMA3_PLAYER_FIELDS = PLAYER_FIELDS[:-1] + NEW_PLAYER_FIELDS + THEORY_FIELDS + ["seatOutcomes"]
PRE_VOTING_PLAYER_FIELDS = PLAYER_FIELDS[:-1] + NEW_PLAYER_FIELDS + ROLE_OUTCOME_FIELDS + THEORY_FIELDS + ["seatOutcomes"]
ALL_PLAYER_FIELDS = PRE_VOTING_PLAYER_FIELDS[:-1] + ["voting", "seatOutcomes"]
THEORY_WINDOW_FIELDS = ["window", "games", "roleTheory", "positionTheory", "finalWinRate", "from", "to", "sparseRoles", "sparseSeats"]
# players[].theory.career also carries 整體理論 (role × seat, 2026-10-28).
CAREER_FIELDS = THEORY_WINDOW_FIELDS + ["overallTheory", "sparseCells", "populationShare"]
OUTCOME_FIELDS = ["missionWinRate", "missionRedWinRate", "missionBlueWinRate", "assassinWinRate", "threeBlueGames"]
ROLE_WINDOWS_FIELDS = ["roleTheory", "fullWindows", "games", "sparseRoles", "from", "to", "roles"]
EMPTY_OUTCOME = {"threeRed": 0, "threeBlueDead": 0, "threeBlueAlive": 0,
                 "threeRedPct": 0, "threeBlueDeadPct": 0, "threeBlueAlivePct": 0}


def old_fields(row: dict) -> dict:
    """The row without the two-stage, role-outcome and theory fields (what the 2026-04-26 rebuild wrote)."""
    return {k: v for k, v in row.items()
            if k not in NEW_PLAYER_FIELDS and k not in THEORY_FIELDS and k not in ROLE_OUTCOME_FIELDS and k != "voting"}


def per_role(**values: float) -> dict[str, float]:
    return {r: float(values.get(r, 0.0)) for r in ROLE_ORDER}


def per_seat(**values: float) -> dict[str, float]:
    return {s: float(values.get(f"s{s}", 0.0)) for s in SEAT_ORDER}


def aggregation_log() -> list[list[str]]:
    """配置 digits are the seats of 刺客 莫甘娜 莫德雷德 奧伯倫 派西維爾 梅林; other seats are 忠臣."""
    return [
        LOG_HEADERS,
        log_row("G1", "123456", "三紅", SEAT_NAMES, date="2026/01/05"),
        log_row("G2", "234560", "三藍活", SEAT_NAMES, date="2026/1/6 20:30"),
        log_row("G3", "098765", "三藍死", SEAT_NAMES[1:] + SEAT_NAMES[:1], date="1900/01/01"),  # 甲 moves to seat 0 (= 10); no date
        log_row("G4", "123456", "", ["幽靈"] + SEAT_NAMES[1:], date="2026/03/01"),  # 結果 not entered yet: not in player stats
        log_row("G5", "567890", "三藍活", [" 甲\u3000", "\u200b乙", "", "", "", "", "", "", "新人", ""], date="2026-02-01"),
        log_row("", "123456", "三紅", SEAT_NAMES),  # no 流水號: not a game
        log_row("G7", "12345", "三紅", SEAT_NAMES),  # 配置 not 6 characters: not a game
    ]


# Global final win rate per role over the named seats of G1 G2 G3 G5 (G4 has no 結果):
#   刺客 甲(三紅 W) 乙(三藍活 L) 甲(三藍死 W) -> 2/3; 莫甘娜 乙 W, 丙 L, 癸 W -> 2/3; 莫德雷德 and
#   奧伯倫 likewise 2/3; 派西維爾 戊 L, 己 W, 庚 L(三藍死), 新人 W -> 2/4; 梅林 己 L, 癸 W, 己 L -> 1/3;
#   忠臣 G1 x4 L, G2 x4 W, G3 x4 L, G5 x2 W -> 6/14.
EXPECTED_ROLE_FINAL = per_role(刺客=66.7, 莫甘娜=66.7, 莫德雷德=66.7, 奧伯倫=66.7, 派西維爾=50.0, 梅林=33.3, 忠臣=42.9)

# Global final win rate per seat (keys 1..10) over the same seats:
#   1: G1 刺客 W, G2 忠臣 W, G3 忠臣 L (三藍死), G5 忠臣 W -> 3/4; 2: 莫甘娜 W, 刺客 L, 忠臣 L, 忠臣 W -> 2/4;
#   3 / 4: W L L -> 1/3; 5: 派西維爾 L, 奧伯倫 L, 梅林 L -> 0/3; 6: 梅林 L, 派西維爾 W, 派西維爾 L -> 1/3;
#   7 / 8: 忠臣 L, 忠臣 W, 奧伯倫 / 莫德雷德 W (三藍死) -> 2/3; 9: L W W W (G5 派西維爾) -> 3/4;
#   10: 忠臣 L, 梅林 W, 刺客 W -> 2/3.
EXPECTED_SEAT_FINAL = {"1": 75.0, "2": 50.0, "3": 33.3, "4": 33.3, "5": 0.0, "6": 33.3, "7": 66.7, "8": 66.7, "9": 75.0, "10": 66.7}

# 甲's theory: G1 刺客@1 W, G2 忠臣@1 W, G3 刺客@10 W (三藍死: red wins the final), G5 忠臣@1 W.
# Topped up to 5 games (theoryMinCellGames, 2026-10-14):
#   roles: 刺客 2 games 2 wins < 5 -> (200 + 3 x 66.7) / 5 = 80.02; 忠臣 (200 + 3 x 42.9) / 5 = 65.74; the
#   other five roles have no game -> the population rate. roleTheory = 0.1 x (80.02 + 3 x 66.7 + 50.0 + 33.3)
#   + 0.4 x 65.74 = 36.342 + 26.296 = 62.638 -> 62.6, every role topped up (sparseRoles 7).
#   seats: 1 has 3 games, 3 wins < 5 -> (300 + 2 x 75.0) / 5 = 90.0; 10 has 1 win -> (100 + 4 x 66.7) / 5 =
#   73.36; the other eight are the population rate (358.3 together). positionTheory = 0.1 x (90.0 + 73.36
#   + 358.3) = 52.166 -> 52.2, every seat topped up (sparseSeats 10).
#   (With 3 games, until 2026-10-14: 刺客 88.9, 忠臣 80.97, roleTheory 69.6; seat 1 as is, positionTheory 53.6.)
#   G3 has no date; it sorts after G2 (the dated row above it) and before G5.
EXPECTED_JIA_THEORY = {
    "window": 0, "games": 4, "roleTheory": 62.6, "positionTheory": 52.2, "finalWinRate": 100.0,
    "from": "2026-01-05", "to": "2026-02-01", "sparseRoles": 7, "sparseSeats": 10,
}
# 甲's per-role windows: every role has fewer games than its window (10, 忠臣 40), so they hold all four
# games and the role theory is the career one (62.6); `rate` is the topped-up cell that went into the
# sum (刺客 80.02 -> 80.0, 忠臣 65.74 -> 65.7), the population rate for a role never played.
EXPECTED_JIA_ROLE_WINDOWS = {
    "roleTheory": 62.6, "fullWindows": False, "games": 4, "sparseRoles": 7, "from": "2026-01-05", "to": "2026-02-01",
    "roles": {
        "刺客": {"games": 2, "wins": 2, "window": 10, "rate": 80.0},
        **{r: {"games": 0, "wins": 0, "window": 10, "rate": EXPECTED_ROLE_FINAL[r]}
           for r in ("莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林")},
        "忠臣": {"games": 2, "wins": 2, "window": 40, "rate": 65.7},
    },
}
# 甲's games per role and 結果: 刺客 G1 三紅, G3 三藍死; 忠臣 G2 三藍活, G5 三藍活.
EXPECTED_JIA_ROLE_OUTCOMES = {
    r: {"三紅": 0, "三藍死": 0, "三藍活": 0} for r in ROLE_ORDER
} | {"刺客": {"三紅": 1, "三藍死": 1, "三藍活": 0}, "忠臣": {"三紅": 0, "三藍死": 0, "三藍活": 2}}

# 甲: G1 刺客@1 三紅 (win), G2 忠臣@1 三藍活 (win), G3 刺客@10 三藍死 (loss: 三藍死 is a blue win),
#     G5 忠臣@1 三藍活 (win).
# Final result: 刺客 三藍死 is a red win -> 4/4; red 2/2, blue 2/2; blue games reaching 三藍: G2, G5, both alive.
# expected = (2 * 66.7 + 2 * 42.9) / 4 = 54.8 over the rounded global rates; excess = 100.0 - 54.8.
EXPECTED_JIA_NEW = {
    "finalWinRate": 100.0, "finalRedWinRate": 100.0, "finalBlueWinRate": 100.0, "missionWinRate": 75.0,
    "merlinSurvivalRate": 100.0, "rawBlueThreeBlue": 2.0,
    "roleFinalWinRates": per_role(刺客=100.0, 忠臣=100.0),
    "expectedFinalWinRate": 54.8, "excessWinRate": 45.2,
    "firstPlayed": "2026-01-05", "lastPlayed": "2026-02-01",  # G3's 1900/01/01 is no date
}
EXPECTED_JIA = {
    "name": "甲", "totalGames": 4.0, "winRate": 75.0, "roleTheory": 75.0, "positionTheory": 0.0,
    "redWin": 50.0, "blueWin": 100.0,
    "red3Red": 50.0, "redMerlinDead": 50.0, "redMerlinAlive": 0.0,
    "blue3Red": 0.0, "blueMerlinDead": 0.0, "blueMerlinAlive": 100.0,
    "roleWinRates": per_role(刺客=50.0, 忠臣=100.0),
    "roleDistribution": per_role(刺客=50.0, 忠臣=50.0),
    "redRoleRate": 50.0, "blueRoleRate": 50.0,
    "seatWinRates": per_seat(s1=100.0),  # seat 10: 1 game, 0 wins -> 0.0
    "seatRedWinRates": per_seat(s1=100.0),
    "seatBlueWinRates": per_seat(s1=100.0),
    "rawRoleGames": per_role(刺客=2, 忠臣=2),
    "rawRedWins": 1.0, "rawBlueWins": 2.0, "rawTotalWins": 3.0, "rawRedGames": 2.0, "rawBlueGames": 2.0,
    "rawRedThreeRed": 1.0, "rawRedMerlinDead": 1.0, "rawRedMerlinAlive": 0.0,
    "rawBlueThreeRed": 0.0, "rawBlueMerlinDead": 0.0, "rawBlueMerlinAlive": 2.0,
    "roleSeatStats": {  # first-seen order; seat 0 is written as 10
        "刺客|1": {"games": 1.0, "wins": 1.0, "winRate": 100.0},
        "忠臣|1": {"games": 2.0, "wins": 2.0, "winRate": 100.0},
        "刺客|10": {"games": 1.0, "wins": 0.0, "winRate": 0.0},
    },
    # 甲's OWN games per seat (round 5, 2026-10-13): seat 1 = G1 三紅, G2 三藍活, G5 三藍活; seat 0 (= 10)
    # = G3 三藍死; the other seats were never played. (Until then this was the overall split projected
    # onto seat 1's games -- 20 % / 20 % / 40 %, the same for every player.)
    "seatOutcomes": {
        "1": {"threeRed": 1, "threeBlueDead": 0, "threeBlueAlive": 2,
              "threeRedPct": 33.3, "threeBlueDeadPct": 0.0, "threeBlueAlivePct": 66.7},
        **{s: EMPTY_OUTCOME for s in SEAT_ORDER[1:-1]},
        "0": {"threeRed": 0, "threeBlueDead": 1, "threeBlueAlive": 0,
              "threeRedPct": 0.0, "threeBlueDeadPct": 100.0, "threeBlueAlivePct": 0.0},
    },
}

# 丙: G1 莫德雷德@3 三紅 (win), G2 莫甘娜@3 三藍活 (loss), G3 忠臣@2 三藍死 (win). Thirds -> rounding.
# Final result: 忠臣 三藍死 is a loss -> 1/3; red 1/2, blue 0/1 (reached 三藍, Merlin dead).
# expected = (66.7 + 66.7 + 42.9) / 3 = 58.8; excess = 33.3 - 58.8 = -25.5.
EXPECTED_BING_NEW = {
    "finalWinRate": 33.3, "finalRedWinRate": 50.0, "finalBlueWinRate": 0.0, "missionWinRate": 66.7,
    "merlinSurvivalRate": 0.0, "rawBlueThreeBlue": 1.0,
    "roleFinalWinRates": per_role(莫德雷德=100.0),
    "expectedFinalWinRate": 58.8, "excessWinRate": -25.5,
    "firstPlayed": "2026-01-05", "lastPlayed": "2026-01-06",
}
EXPECTED_BING = {
    "name": "丙", "totalGames": 3.0, "winRate": 66.7,
    "roleTheory": 66.6,  # (33.3*100 + 33.3*0 + 33.3*100) / 100 over the rounded values, not 66.7
    "positionTheory": 0.0,
    "redWin": 50.0, "blueWin": 100.0,
    "red3Red": 50.0, "redMerlinDead": 0.0, "redMerlinAlive": 50.0,
    "blue3Red": 0.0, "blueMerlinDead": 100.0, "blueMerlinAlive": 0.0,
    "roleWinRates": per_role(莫德雷德=100.0, 忠臣=100.0),
    "roleDistribution": per_role(莫甘娜=33.3, 莫德雷德=33.3, 忠臣=33.3),
    "redRoleRate": 66.7, "blueRoleRate": 33.3,
    "seatWinRates": per_seat(s2=100.0, s3=50.0),
    "seatRedWinRates": per_seat(s3=50.0),
    "seatBlueWinRates": per_seat(s2=100.0),
    "rawRoleGames": per_role(莫甘娜=1, 莫德雷德=1, 忠臣=1),
    "rawRedWins": 1.0, "rawBlueWins": 1.0, "rawTotalWins": 2.0, "rawRedGames": 2.0, "rawBlueGames": 1.0,
    "rawRedThreeRed": 1.0, "rawRedMerlinDead": 0.0, "rawRedMerlinAlive": 1.0,
    "rawBlueThreeRed": 0.0, "rawBlueMerlinDead": 1.0, "rawBlueMerlinAlive": 0.0,
    "roleSeatStats": {
        "莫德雷德|3": {"games": 1.0, "wins": 1.0, "winRate": 100.0},
        "莫甘娜|3": {"games": 1.0, "wins": 0.0, "winRate": 0.0},
        "忠臣|2": {"games": 1.0, "wins": 1.0, "winRate": 100.0},
    },
}


# Fixed leaderboard reference day for every cache the tests build. Without it build_cache falls
# back to "today in +08" and the leaderboard expectations break the day after they were written
# (refresh-analysis-cache run #8, 2026-10-13).
TEST_AS_OF = dt.date(2026, 10, 12)


def build_fresh(log: list[list[str]], as_of: dt.date = TEST_AS_OF) -> dict:
    """build_cache + a stub strength section (what validate_new_cache expects), no carry-over."""
    cache, _ = gc.assemble_cache(
        gc.build_cache(gc.parse_game_log(log), {}, as_of=as_of), None,
        strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={}, as_of=as_of,
    )
    return cache


class PlayerAggregationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cache = build_fresh(aggregation_log())
        self.rows = {p["name"]: p for p in self.cache["players"]["players"]}

    def test_name_normalization(self) -> None:
        self.assertEqual(gc.normalize_player_name(" 甲\u3000"), "甲")
        self.assertEqual(gc.normalize_player_name("\u200b乙\ufeff"), "乙")
        self.assertEqual(gc.normalize_player_name("A\u3000 \u00a0B"), "A B")
        self.assertEqual(gc.normalize_player_name("Tovo Wren"), "Tovo Wren")  # 保留大小寫。
        self.assertEqual(gc.normalize_player_name(""), "")
        self.assertEqual(gc.normalize_player_name(None), "")

    def test_game_log_reads_player_columns(self) -> None:
        games = gc.parse_game_log(aggregation_log())
        self.assertEqual([g.id for g in games], ["G1", "G2", "G3", "G4", "G5"])
        self.assertEqual(games[2].seat_players["0"], "甲")
        self.assertEqual(games[4].seat_players, {"1": "甲", "2": "乙", "9": "新人"})  # empty seats skipped
        self.assertIn("1 games have a 結果 other than", gc.game_log_summary(games))

    def test_every_field_of_two_players(self) -> None:
        jia = self.rows["甲"]
        self.assertEqual(list(jia), ALL_PLAYER_FIELDS)
        self.assertEqual(old_fields(jia), EXPECTED_JIA)  # the 2026-04-26 fields, unchanged
        self.assertEqual(list(jia["roleSeatStats"]), list(EXPECTED_JIA["roleSeatStats"]))
        self.assertEqual(list(jia["seatWinRates"]), SEAT_ORDER)
        self.assertEqual(list(jia["roleWinRates"]), ROLE_ORDER)
        bing = {k: v for k, v in old_fields(self.rows["丙"]).items() if k != "seatOutcomes"}
        self.assertEqual(bing, EXPECTED_BING)
        for row in self.rows.values():  # counts are floats, like the committed cache
            self.assertIsInstance(row["totalGames"], float)
            self.assertIsInstance(row["rawRoleGames"]["忠臣"], float)
            self.assertIsInstance(row["rawBlueThreeBlue"], float)

    def test_two_stage_fields_of_two_players(self) -> None:
        self.assertEqual({k: self.rows["甲"][k] for k in NEW_PLAYER_FIELDS}, EXPECTED_JIA_NEW)
        self.assertEqual({k: self.rows["丙"][k] for k in NEW_PLAYER_FIELDS}, EXPECTED_BING_NEW)
        self.assertEqual(list(self.rows["甲"]["roleFinalWinRates"]), ROLE_ORDER)
        for row in self.rows.values():  # the identities of docs/stats/two_stage_outcome.md
            total, red, blue = row["totalGames"], row["rawRedGames"], row["rawBlueGames"]
            self.assertEqual(row["finalWinRate"], pct(row["rawRedThreeRed"] + row["rawRedMerlinDead"] + row["rawBlueMerlinAlive"], total))
            self.assertEqual(row["finalRedWinRate"], pct(row["rawRedThreeRed"] + row["rawRedMerlinDead"], red))
            self.assertEqual(row["finalBlueWinRate"], pct(row["rawBlueMerlinAlive"], blue))
            self.assertEqual(row["missionWinRate"], row["winRate"])
            self.assertEqual(row["rawBlueThreeBlue"], row["rawBlueMerlinAlive"] + row["rawBlueMerlinDead"])
            self.assertEqual(row["merlinSurvivalRate"], pct(row["rawBlueMerlinAlive"], row["rawBlueThreeBlue"]))
            self.assertEqual(row["expectedFinalWinRate"],
                             rnd1(sum(row["rawRoleGames"][r] * EXPECTED_ROLE_FINAL[r] for r in ROLE_ORDER) / total))
            self.assertEqual(row["excessWinRate"], rnd1(row["finalWinRate"] - row["expectedFinalWinRate"]))

    def test_role_outcomes(self) -> None:
        """roleOutcomes (schemaVersion 4): career 三紅 / 三藍死 / 三藍活 per role, what the conditional blocks
        (任務結果 / 刺殺結果 / 遊戲結果) are computed from; they add up to the per-side raw counts."""
        self.assertEqual(self.rows["甲"]["roleOutcomes"], EXPECTED_JIA_ROLE_OUTCOMES)
        self.assertEqual(list(self.rows["甲"]["roleOutcomes"]), ROLE_ORDER)
        self.assertEqual(self.cache["playerDetails"]["甲"]["player"]["roleOutcomes"], EXPECTED_JIA_ROLE_OUTCOMES)
        for row in self.rows.values():
            ro = row["roleOutcomes"]
            for r in ROLE_ORDER:
                self.assertEqual(list(ro[r]), ["三紅", "三藍死", "三藍活"])
                self.assertTrue(all(isinstance(n, int) for n in ro[r].values()))
                self.assertEqual(sum(ro[r].values()), row["rawRoleGames"][r])
            for side, roles in (("Red", RED_ROLES), ("Blue", set(ROLE_ORDER) - RED_ROLES)):
                for outcome, field in (("三紅", "ThreeRed"), ("三藍死", "MerlinDead"), ("三藍活", "MerlinAlive")):
                    self.assertEqual(sum(ro[r][outcome] for r in roles), row[f"raw{side}{field}"])

    def test_two_stage_overview(self) -> None:
        ov = self.cache["overview"]
        self.assertEqual(ov["schemaVersion"], 4)
        self.assertEqual(ov["totalGames"], 5)  # G4 (no 結果) still counts here, as before
        self.assertEqual(ov["missionStage"], {"games": 4, "threeRed": 1, "threeBlue": 3, "redPct": 25.0, "bluePct": 75.0})
        self.assertEqual(ov["assassinationStage"],
                         {"games": 3, "merlinKilled": 1, "merlinSurvived": 2, "killPct": 33.3, "survivePct": 66.7})
        self.assertEqual(ov["final"], {"games": 4, "redWins": 2, "blueWins": 2, "redPct": 50.0, "bluePct": 50.0})
        self.assertEqual(ov["roleFinalWinRates"], EXPECTED_ROLE_FINAL)
        self.assertEqual(ov["topPlayersByExcess"], [])  # nobody has 30 games
        # Old overview keys keep the mission-stage rule (三藍死 = blue win).
        self.assertEqual((ov["redWinRate"], ov["blueWinRate"]), (20.0, 60.0))
        self.assertEqual(ov["seatFinalWinRates"], EXPECTED_SEAT_FINAL)
        self.assertEqual(ov["topPlayersByRoleTheory"], [])  # nobody has full role windows
        self.assertEqual(ov["topPlayersByPositionTheory"], [])  # nobody has 100 games
        self.assertEqual(ov["topPlayersByOverallTheory"], [])  # nobody has 250 games
        self.assertEqual(list(ov)[-6:], ["seatFinalWinRates", "topPlayersByRoleTheory", "theoryConfig",
                                         "topPlayersByPositionTheory", "topPlayersByOverallTheory",
                                         "roleSeatFinalWinRates"])
        # role × seat population rates: every role, seats 1..10; a cell nobody played is the role's rate.
        rs = ov["roleSeatFinalWinRates"]
        self.assertEqual(list(rs), ROLE_ORDER)
        for role in ROLE_ORDER:
            self.assertEqual(list(rs[role]), [str(i) for i in range(1, 11)])
            # 4 games: most cells nobody played -> the role's rate; a played cell is its own rate.
            self.assertIn(EXPECTED_ROLE_FINAL[role], rs[role].values())
        self.assertEqual(ov["theoryConfig"], {
            "theoryMinCellGames": 5, "theoryWindows": [100], "mainGames": 100, "activeDays": 90,
            "roleWindowGames": {r: 40 if r == "忠臣" else 10 for r in ROLE_ORDER}, "positionGames": 100,
            "overallMinGames": 250,
        })
        self.assertEqual(list(ov["theoryConfig"]["roleWindowGames"]), ROLE_ORDER)
        # topPlayersByGames (schemaVersion 4): each player's 三種結果 over all their games and their sides.
        top = {r["name"]: r for r in ov["topPlayersByGames"]}
        self.assertEqual(top["甲"], {"name": "甲", "games": 4.0, "winRate": 75.0,
                                     "outcomes": {"三紅": 1, "三藍死": 1, "三藍活": 2}, "redGames": 2, "blueGames": 2})
        for r in ov["topPlayersByGames"]:
            self.assertEqual(sum(r["outcomes"].values()), r["games"])
            self.assertEqual(r["redGames"] + r["blueGames"], r["games"])

    def test_theory_of_a_fixture_player(self) -> None:
        """甲 (4 games, every one won): the sparse cells are topped up with the fixture's own
        population rates (EXPECTED_ROLE_FINAL, EXPECTED_SEAT_FINAL)."""
        jia = self.rows["甲"]["theory"]
        self.assertEqual(list(jia), ["roleWindows", "last100", "career"])  # no last50 since schemaVersion 4
        # 整體理論: 4 games in 4 of the 70 cells (two 1/100 cells, two 4/100 as 忠臣), one game each, so
        # 4/5 of their weight and every other cell are the population's: 100 - 0.10 x 1/5 x 100 = 98.0.
        self.assertEqual(jia["career"], {**EXPECTED_JIA_THEORY, "overallTheory": 49.6, "sparseCells": 70,
                                         "populationShare": 98.0})
        self.assertEqual(jia["last100"], {**EXPECTED_JIA_THEORY, "window": 100})  # fewer than 100 games: all of them
        self.assertEqual(jia["roleWindows"], EXPECTED_JIA_ROLE_WINDOWS)
        for row in self.rows.values():
            self.assertEqual(row["theory"]["career"]["games"], row["totalGames"])
            self.assertEqual(row["theory"]["career"]["finalWinRate"], row["finalWinRate"])
            self.assertEqual(list(row["theory"]["career"]), CAREER_FIELDS)
            self.assertEqual(list(row["theory"]["last100"]), THEORY_WINDOW_FIELDS)
            self.assertEqual(list(row["theory"]["roleWindows"]), ROLE_WINDOWS_FIELDS)
            # Few games: every window holds all of them, so the role windows give the career role theory.
            self.assertEqual(row["theory"]["roleWindows"]["roleTheory"], row["theory"]["career"]["roleTheory"])
        # The legacy fields keep their old values (FirestoreLeaderboard's ELO bonus reads roleTheory).
        self.assertEqual((self.rows["甲"]["roleTheory"], self.rows["甲"]["positionTheory"]), (75.0, 0.0))

    def test_top_players_by_excess_is_shrunk_order(self) -> None:
        rows = [
            {"name": "少場", "totalGames": 30.0, "excessWinRate": 12.4, "finalWinRate": 53.3, "expectedFinalWinRate": 40.9, "roleTheory": 1, "winRate": 1},
            {"name": "多場", "totalGames": 1000.0, "excessWinRate": 7.8, "finalWinRate": 52.8, "expectedFinalWinRate": 45.0, "roleTheory": 1, "winRate": 1},
            {"name": "不足", "totalGames": 29.0, "excessWinRate": 50.0, "finalWinRate": 90.0, "expectedFinalWinRate": 40.0, "roleTheory": 1, "winRate": 1},
            {"name": "舊列", "totalGames": 40.0, "roleTheory": 1, "winRate": 1},  # a row without the field is skipped, not a crash
        ]
        top = gc.compute_overview([], rows)["topPlayersByExcess"]
        # 12.4 * 30/50 = 7.4 < 7.8 * 1000/1020 = 7.6: the 1000-game player ranks first.
        self.assertEqual([t["name"] for t in top], ["多場", "少場"])
        self.assertEqual(top[0], {"name": "多場", "excessWinRate": 7.8, "finalWinRate": 52.8, "expectedFinalWinRate": 45.0, "games": 1000.0})
        self.assertEqual(gc.shrunk_excess(12.4, 30, 20), 7.4)
        self.assertEqual(gc.shrunk_excess(-10.0, 20, 20), -5.0)

    def test_order_and_who_counts(self) -> None:
        names = [p["name"] for p in self.cache["players"]["players"]]
        # 4 games, then 3 games in order of first appearance (G1 seats), not by name; 幽靈 only
        # played the game without 結果.
        self.assertEqual(names, ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸", "新人"])
        self.assertEqual(self.rows["新人"]["roleSeatStats"], {"派西維爾|9": {"games": 1.0, "wins": 1.0, "winRate": 100.0}})
        self.assertEqual(self.cache["players"]["total"], 11)
        self.assertEqual(self.cache["overview"]["totalPlayers"], 11)
        self.assertEqual(self.cache["overview"]["totalGames"], 5)  # G4 counts here (as before)
        self.assertEqual(self.cache["overview"]["topPlayersByTheory"], [])  # nobody has 30 games

    def test_player_details_shape(self) -> None:
        details = self.cache["playerDetails"]
        self.assertEqual(list(details), [p["name"] for p in self.cache["players"]["players"]])
        jia = details["甲"]
        self.assertEqual(set(jia), {"player", "radar"})
        self.assertEqual(old_fields(jia["player"]), {k: v for k, v in EXPECTED_JIA.items() if k != "seatOutcomes"})
        self.assertEqual({k: jia["player"][k] for k in NEW_PLAYER_FIELDS}, EXPECTED_JIA_NEW)
        self.assertEqual(jia["radar"], EXPECTED_JIA["roleWinRates"])

    def test_no_field_loss_vs_committed_shape(self) -> None:
        previous = {"players": {"players": [{f: 0 for f in PLAYER_FIELDS}]}}
        self.assertEqual(gc.dropped_player_fields(self.cache, previous), [])

    def test_merge_tracks_rewritten_discord_rows(self) -> None:
        log = aggregation_log()
        header = LOG_HEADERS + ["discord_post_id", gc.DISCORD_UPDATED_COLUMN]
        def extra(gid: str, updated: str, text: str = DEFAULT_TEXT) -> list[str]:
            return log_row(gid, "135790", "三紅", SEAT_NAMES, text=text) + [gid[1:], updated]
        dup_text = log[1][LOG_HEADERS.index("文字記錄")]
        rows = [header, extra("D1", ""), extra("D2", "2026-12-01 03:17:00", "158\nooo"),
                extra("D3", "2026/11/02 03:17", "159\nooo"), extra("D4", "2026-12-02 03:17:00", "158\nooo"),
                log_row("D5", "123456", "三紅", SEAT_NAMES, text=dup_text) + ["5", "2026-12-01 03:17:00"]]
        merged = gc.merge_game_logs(log, rows)
        self.assertEqual((merged.extra_added, merged.extra_duplicates), (3, 2))
        # On or after the day: D2, D4 (a duplicate of D2) and D5 (now the same game as a 牌譜 row).
        self.assertEqual(merged.rewritten_since(dt.date(2026, 12, 1)), (3, 2))
        self.assertEqual(merged.rewritten_since(dt.date(2026, 12, 2)), (1, 1))  # D4, dropped as D2's duplicate
        self.assertEqual(merged.rewritten_since(dt.date(2026, 12, 3)), (0, 0))
        self.assertEqual(merged.rewritten_since(None), (4, 2))
        self.assertEqual(gc.merge_game_logs(log, [LOG_HEADERS, log_row("D9", "135790", "三紅", SEAT_NAMES)])
                         .rewritten_since(None), (0, 0))  # a tab without the column

    def test_guard_refuses_lost_games(self) -> None:
        log = aggregation_log()
        without_g1 = [row for row in log if row[0] != "G1"]
        problems = gc.validate_new_cache(build_fresh(without_g1), self.cache)
        self.assertTrue(any("would drop from 5 to 4 (1 fewer)" in p for p in problems), problems)
        player_problem = next(p for p in problems if "existing player(s)" in p)
        self.assertIn("10 existing player(s) would have fewer games", player_problem)
        self.assertIn("甲 4→3", player_problem)
        self.assertEqual(gc.validate_new_cache(build_fresh(without_g1), self.cache, allow_shrink=True), [])

        retyped = aggregation_log()
        retyped[1][LOG_HEADERS.index("玩1")] = "甲甲"  # same games, one name retyped
        problems = gc.validate_new_cache(build_fresh(retyped), self.cache)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("1 existing player(s) would have fewer games than in the existing cache: 甲 4→3", problems[0])

        more = aggregation_log() + [log_row("G8", "123456", "三紅", SEAT_NAMES)]
        self.assertEqual(gc.validate_new_cache(build_fresh(more), self.cache), [])


# ---------------------------------------------------------------------------
# Property test over the committed analysis_cache.json
# ---------------------------------------------------------------------------

COMMITTED_CACHE = Path(__file__).resolve().parent / "analysis_cache.json"
RED_ROLES = {"刺客", "莫甘娜", "莫德雷德", "奧伯倫"}


def rnd1(x: float) -> float:
    return round(x * 10) / 10


def pct(num: float, den: float) -> float:
    return rnd1(num / den * 100) if den else 0.0


def tally_from_row(row: dict) -> "gc._PlayerTally":
    """The counts a players row was made from, recovered from its raw* and roleSeatStats fields."""
    t = gc._PlayerTally()
    t.games, t.wins = int(row["totalGames"]), int(row["rawTotalWins"])
    for faction, key in (("red", "Red"), ("blue", "Blue")):
        t.faction_games[faction] = int(row[f"raw{key}Games"])
        t.faction_wins[faction] = int(row[f"raw{key}Wins"])
        for outcome, field in ((gc.OUTCOME_THREE_RED, "ThreeRed"), (gc.OUTCOME_BLUE_DEAD, "MerlinDead"),
                               (gc.OUTCOME_BLUE_ALIVE, "MerlinAlive")):
            t.faction_outcomes[(faction, outcome)] = int(row[f"raw{key}{field}"])
    for key, cell in row["roleSeatStats"].items():
        role, label = key.split("|")
        seat = "0" if label == "10" else label
        faction = "red" if role in RED_ROLES else "blue"
        games, wins = int(cell["games"]), int(cell["wins"])
        t.role_seat[key] = [games, wins]
        t.role_games[role] += games
        t.role_wins[role] += wins
        t.seat_games[seat] += games
        t.seat_wins[seat] += wins
        t.seat_faction_games[(seat, faction)] += games
        t.seat_faction_wins[(seat, faction)] += wins
    return t


class OwnOutcomesTest(unittest.TestCase):
    """players[].seatOutcomes and chemistry.outcomePair come from the game log (round 5, 2026-10-13).

    Players saw the same ~46 % (三紅 45.5 %) for everyone in the 位置 heatmap and the 三結果配對
    matrix: both used to be the overall split projected onto every player / pair.
    """

    def setUp(self) -> None:
        self.games = gc.parse_game_log(aggregation_log())
        chemistry = {"coWin": {"players": ["甲", "乙", "新人"], "rowLabels": ["甲", "乙", "新人"],
                               "values": [[None, 50.0, 100.0], [50.0, None, 100.0], [100.0, 100.0, None]]}}
        self.cache = gc.build_cache(self.games, chemistry, as_of=TEST_AS_OF)
        self.rows = {p["name"]: p for p in self.cache["players"]["players"]}

    def test_seat_outcomes_are_each_players_own_games(self) -> None:
        self.assertEqual(self.cache["players"][gc.SEAT_OUTCOMES_SOURCE_KEY], gc.OUTCOME_SOURCE_GAMES)
        self.assertEqual(self.rows["甲"]["seatOutcomes"], EXPECTED_JIA["seatOutcomes"])
        # 乙: seat 1 only in G3 (三藍死); seat 2 in G1 三紅, G2 三藍活, G5 三藍活.
        yi = self.rows["乙"]["seatOutcomes"]
        self.assertEqual((yi["1"]["threeRed"], yi["1"]["threeBlueDead"], yi["1"]["threeBlueAlive"]), (0, 1, 0))
        self.assertEqual((yi["2"]["threeRed"], yi["2"]["threeBlueDead"], yi["2"]["threeBlueAlive"]), (1, 0, 2))
        overall = {k: self.cache["overview"]["outcomeBreakdown"][k] for k in ("threeRedPct", "threeBlueDeadPct", "threeBlueAlivePct")}
        played = [o for row in self.rows.values() for o in row["seatOutcomes"].values() if o != EMPTY_OUTCOME]
        self.assertTrue(played)
        self.assertNotEqual({(o["threeRedPct"], o["threeBlueDeadPct"], o["threeBlueAlivePct"]) for o in played},
                            {tuple(overall.values())})
        # G4 (no 結果) is not counted: 幽靈 sat in seat 1 only there.
        self.assertNotIn("幽靈", self.rows)
        # playerDetails rows still leave seatOutcomes out (only players.players carries it).
        self.assertNotIn("seatOutcomes", self.cache["playerDetails"]["甲"]["player"])

    def test_outcome_pair_matrix_counts_the_games_played_together(self) -> None:
        m = self.cache["chemistry"]["outcomePair"]
        self.assertEqual(m["source"], gc.OUTCOME_SOURCE_GAMES)
        self.assertEqual((m["players"], m["rowLabels"]), (["甲", "乙", "新人"], ["甲", "乙", "新人"]))
        # 甲 + 乙: G1 三紅, G2 三藍活, G3 三藍死, G5 三藍活 -> 1 / 1 / 2 of 4. 甲 or 乙 + 新人: G5 only.
        self.assertEqual(m["values"], [[None, 25.0, 0.0], [25.0, None, 0.0], [0.0, 0.0, None]])
        self.assertEqual(m["threeBlueDeadPct"], [[None, 25.0, 0.0], [25.0, None, 0.0], [0.0, 0.0, None]])
        self.assertEqual(m["threeBlueAlivePct"], [[None, 50.0, 100.0], [50.0, None, 100.0], [100.0, 100.0, None]])
        self.assertEqual(m["games"], [[None, 4, 1], [4, None, 1], [1, 1, None]])

    def test_outcome_pair_labels_match_every_spelling(self) -> None:
        """Matrix labels are upper-cased (QIX); the 牌譜 has Qix / qix / ＱＩＸ for the same label."""
        log = [
            LOG_HEADERS,
            log_row("P1", "123456", "三紅", ["Qix", "Wub", "", "", "", "", "", "", "", ""]),
            log_row("P2", "123456", "三藍活", ["qix", "wub", "", "", "", "", "", "", "", ""]),
            log_row("P3", "123456", "三藍死", ["ＱＩＸ", "Zor", "", "", "", "", "", "", "", ""]),
        ]
        chemistry = {"coWin": {"players": ["QIX", "WUB", "ZOR"], "values": [[None, 1.0, 1.0]] * 3}}
        m = gc.compute_outcome_pair_matrix(chemistry, gc.parse_game_log(log))
        self.assertEqual(m["rowLabels"], ["QIX", "WUB", "ZOR"])  # rowLabels default to players
        self.assertEqual(m["games"], [[None, 2, 1], [2, None, None], [1, None, None]])
        self.assertEqual(m["values"][0], [None, 50.0, 0.0])
        self.assertEqual(m["threeBlueAlivePct"][0], [None, 50.0, 0.0])
        self.assertEqual(m["threeBlueDeadPct"][0], [None, 0.0, 100.0])

    def test_no_chemistry_no_matrix(self) -> None:
        m = gc.compute_outcome_pair_matrix({}, self.games)
        self.assertEqual((m["players"], m["rowLabels"], m["values"]), ([], [], []))

    def test_legacy_projection_is_the_same_for_everyone(self) -> None:
        """What older caches hold (and the server now drops): one split for every played seat."""
        ov = self.cache["overview"]
        projected = gc.projected_seat_outcomes_per_player(ov["seatPositionWinRates"], ov["outcomeBreakdown"],
                                                           list(self.rows.values()))
        splits = {(o["threeRedPct"], o["threeBlueDeadPct"], o["threeBlueAlivePct"])
                  for per_seat in projected.values() for o in per_seat.values() if o != EMPTY_OUTCOME}
        self.assertEqual(len(splits), 1)


class CommittedCachePropertyTest(unittest.TestCase):
    """The identities compute_player_stats implies hold for every players row of the committed cache.

    Holds for the 2026-04-26 rebuild (commit 61b7398) and for every file this script writes.
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not COMMITTED_CACHE.exists():
            raise unittest.SkipTest(f"{COMMITTED_CACHE.name} not found")
        cls.cache = json.loads(COMMITTED_CACHE.read_text(encoding="utf-8"))
        cls.rows = cls.cache["players"]["players"]

    def check_all(self, check) -> None:
        failures = []
        for index, row in enumerate(self.rows):
            failures += [f"row[{index}]: {msg}" for msg in check(row)]
        self.assertEqual(failures[:10], [], f"{len(failures)} failures")

    def test_fields_and_types(self) -> None:
        self.assertGreaterEqual(len(self.rows), 1)

        def check(row):
            # the rebuild's, 10-12's, 10-13's (schemaVersion 3) or this script's
            if list(row) not in (PLAYER_FIELDS, TWO_STAGE_PLAYER_FIELDS, SCHEMA3_PLAYER_FIELDS, PRE_VOTING_PLAYER_FIELDS, ALL_PLAYER_FIELDS):
                yield f"fields {list(row)}"
            for key in ("roleWinRates", "roleDistribution", "rawRoleGames"):
                if list(row[key]) != ROLE_ORDER:
                    yield f"{key} keys {list(row[key])}"
            for key in ("seatWinRates", "seatRedWinRates", "seatBlueWinRates", "seatOutcomes"):
                if list(row[key]) != SEAT_ORDER:
                    yield f"{key} keys {list(row[key])}"
            for key in row:
                if key.startswith("raw") and key != "rawRoleGames" and not isinstance(row[key], float):
                    yield f"{key} is {type(row[key]).__name__}"
            for key, cell in row["roleSeatStats"].items():
                role, _, seat = key.partition("|")
                if role not in ROLE_ORDER or seat not in [str(i) for i in range(1, 11)] or cell["games"] < 1:
                    yield f"roleSeatStats {key} {cell}"
        self.check_all(check)

    def test_counts_add_up(self) -> None:
        def check(row):
            total = row["totalGames"]
            cells = row["roleSeatStats"].values()
            sums = {
                "rawRedGames + rawBlueGames": row["rawRedGames"] + row["rawBlueGames"],
                "sum(rawRoleGames)": sum(row["rawRoleGames"].values()),
                "sum(roleSeatStats.games)": sum(c["games"] for c in cells),
            }
            for label, value in sums.items():
                if value != total:
                    yield f"{label} = {value} != totalGames {total}"
            if row["rawRedWins"] + row["rawBlueWins"] != row["rawTotalWins"]:
                yield "rawRedWins + rawBlueWins != rawTotalWins"
            if sum(c["wins"] for c in cells) != row["rawTotalWins"]:
                yield "sum(roleSeatStats.wins) != rawTotalWins"
            if sum(v for r, v in row["rawRoleGames"].items() if r in RED_ROLES) != row["rawRedGames"]:
                yield "red roles' games != rawRedGames"
            for side in ("Red", "Blue"):
                parts = row[f"raw{side}ThreeRed"] + row[f"raw{side}MerlinDead"] + row[f"raw{side}MerlinAlive"]
                if parts != row[f"raw{side}Games"]:
                    yield f"{side} outcomes add up to {parts}, not raw{side}Games"
            # Red wins only by 三紅; 三藍死 counts as a blue win (see gc.OUTCOMES).
            if row["rawRedWins"] != row["rawRedThreeRed"]:
                yield "rawRedWins != rawRedThreeRed"
            if row["rawBlueWins"] != row["rawBlueMerlinDead"] + row["rawBlueMerlinAlive"]:
                yield "rawBlueWins != rawBlueMerlinDead + rawBlueMerlinAlive"
        self.check_all(check)

    def test_rates_are_rounded_ratios(self) -> None:
        def check(row):
            total, red, blue = row["totalGames"], row["rawRedGames"], row["rawBlueGames"]
            expected = {
                "winRate": pct(row["rawTotalWins"], total),
                "redWin": pct(row["rawRedWins"], red),
                "blueWin": pct(row["rawBlueWins"], blue),
                "red3Red": pct(row["rawRedThreeRed"], red),
                "redMerlinDead": pct(row["rawRedMerlinDead"], red),
                "redMerlinAlive": pct(row["rawRedMerlinAlive"], red),
                "blue3Red": pct(row["rawBlueThreeRed"], blue),
                "blueMerlinDead": pct(row["rawBlueMerlinDead"], blue),
                "blueMerlinAlive": pct(row["rawBlueMerlinAlive"], blue),
                "redRoleRate": pct(red, total),
                "blueRoleRate": pct(blue, total),
                "positionTheory": 0.0,
                "roleTheory": rnd1(sum(row["roleDistribution"][r] * row["roleWinRates"][r] for r in ROLE_ORDER) / 100),
            }
            for key, value in expected.items():
                if row[key] != value:
                    yield f"{key} {row[key]} != {value}"
            role_wins = {r: 0.0 for r in ROLE_ORDER}
            seat = {s: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0] for s in SEAT_ORDER}  # games wins redG redW blueG blueW
            for key, cell in row["roleSeatStats"].items():
                role, label = key.split("|")
                if cell["winRate"] != pct(cell["wins"], cell["games"]):
                    yield f"roleSeatStats {key} winRate"
                role_wins[role] += cell["wins"]
                s = seat["0" if label == "10" else label]
                off = 2 if role in RED_ROLES else 4
                s[0] += cell["games"]; s[1] += cell["wins"]; s[off] += cell["games"]; s[off + 1] += cell["wins"]
            for r in ROLE_ORDER:
                if row["roleDistribution"][r] != pct(row["rawRoleGames"][r], total):
                    yield f"roleDistribution[{r}]"
                if row["roleWinRates"][r] != pct(role_wins[r], row["rawRoleGames"][r]):
                    yield f"roleWinRates[{r}]"
            for s, (g, w, rg, rw, bg, bw) in seat.items():
                if (row["seatWinRates"][s], row["seatRedWinRates"][s], row["seatBlueWinRates"][s]) != (
                        pct(w, g), pct(rw, rg), pct(bw, bg)):
                    yield f"seat {s} rates"
        self.check_all(check)

    def test_row_rebuilt_from_its_own_counts_is_identical(self) -> None:
        def check(row):
            rebuilt = old_fields(tally_from_row(row).to_row(row["name"]))
            original = {k: v for k, v in old_fields(row).items() if k != "seatOutcomes"}
            if rebuilt != original or list(rebuilt) != list(original):
                yield "to_row(counts) differs: " + ", ".join(k for k in original if rebuilt.get(k) != original[k])
        self.check_all(check)

    def test_two_stage_fields_when_present(self) -> None:
        """Rows written by this script (not the rebuild) satisfy docs/stats/two_stage_outcome.md."""
        role_rates = self.cache["overview"].get("roleFinalWinRates")
        if not any("finalWinRate" in row for row in self.rows):
            self.skipTest("the committed cache predates the two-stage fields")
        self.assertIsInstance(role_rates, dict)

        def check(row):
            total = row["totalGames"]
            final = pct(row["rawRedThreeRed"] + row["rawRedMerlinDead"] + row["rawBlueMerlinAlive"], total)
            expected = rnd1(sum(row["rawRoleGames"][r] * role_rates[r] for r in ROLE_ORDER) / total)
            checks = {
                "finalWinRate": final,
                "finalRedWinRate": pct(row["rawRedThreeRed"] + row["rawRedMerlinDead"], row["rawRedGames"]),
                "finalBlueWinRate": pct(row["rawBlueMerlinAlive"], row["rawBlueGames"]),
                "missionWinRate": row["winRate"],
                "rawBlueThreeBlue": row["rawBlueMerlinAlive"] + row["rawBlueMerlinDead"],
                "merlinSurvivalRate": pct(row["rawBlueMerlinAlive"], row["rawBlueMerlinAlive"] + row["rawBlueMerlinDead"]),
                "expectedFinalWinRate": expected,
                "excessWinRate": rnd1(final - expected),
            }
            for key, value in checks.items():
                if row[key] != value:
                    yield f"{key} {row[key]} != {value}"
            if list(row["roleFinalWinRates"]) != ROLE_ORDER:
                yield "roleFinalWinRates keys"
            for key in ("firstPlayed", "lastPlayed"):
                if not isinstance(row[key], str) or (row[key] and len(row[key]) != 10):
                    yield f"{key} {row[key]!r}"
            if row["firstPlayed"] > row["lastPlayed"]:
                yield "firstPlayed after lastPlayed"
        self.check_all(check)

    def test_theory_when_present(self) -> None:
        """Rows written since schemaVersion 3 carry theory windows consistent with the row (4: plus
        roleWindows, the per-role windows of 角色理論)."""
        if not any("theory" in row for row in self.rows):
            self.skipTest("the committed cache predates the theory win rates")
        # The windows the cache was written with (its own leaderboard.config), not today's
        # LEADERBOARD_CONFIG: a changed mainGames / roleWindowGames must not fail the workflow
        # before it has regenerated the file.
        config = (self.cache.get("leaderboard") or {}).get("config") or {}
        windows = config.get("theoryWindows") or gc.theory_windows(config if "mainGames" in config else None)
        schema4 = (self.cache["overview"].get("schemaVersion") or 0) >= 4

        def check(row):
            theory = row["theory"]
            if list(theory) != (["roleWindows"] if schema4 else []) + [gc.theory_key(n) for n in windows] + ["career"]:
                yield f"theory keys {list(theory)}"
                return
            if schema4:
                yield from check_role_windows(theory["roleWindows"], row)
            total = int(row["totalGames"])
            for key, n in [(gc.theory_key(n), n) for n in windows] + [("career", 0)]:
                w = theory[key]
                # career carries 整體理論 once the cache is regenerated (older caches: the window fields only).
                expected = CAREER_FIELDS if key == "career" and "overallTheory" in w else THEORY_WINDOW_FIELDS
                if list(w) != expected:
                    yield f"{key} fields {list(w)}"
                    continue
                if (w["window"], w["games"]) != (n, min(n, total) if n else total):
                    yield f"{key} window/games {w['window']}/{w['games']}"
                for k in ("roleTheory", "positionTheory", "finalWinRate"):
                    if not 0 <= w[k] <= 100:
                        yield f"{key}.{k} {w[k]}"
                if not (0 <= w["sparseRoles"] <= 7 and 0 <= w["sparseSeats"] <= 10):
                    yield f"{key} sparse {w['sparseRoles']}/{w['sparseSeats']}"
                if w["from"] > w["to"]:
                    yield f"{key} from after to"
            if theory["career"]["finalWinRate"] != row["finalWinRate"]:
                yield "career.finalWinRate != finalWinRate"

        def check_role_windows(rw, row):
            if list(rw) != ROLE_WINDOWS_FIELDS or list(rw["roles"]) != ROLE_ORDER:
                yield f"roleWindows fields {list(rw)} / roles {list(rw.get('roles') or {})}"
                return
            min_cell = max(int(config.get("theoryMinCellGames", 3)), 1)
            games, full, sparse, tenths = 0, True, 0, 0.0
            for r, c in rw["roles"].items():
                # The last min(K_r, games as r) games as r, never more than the window.
                if list(c) != ["games", "wins", "window", "rate"] or not 0 <= c["wins"] <= c["games"] <= c["window"]:
                    yield f"roleWindows.roles.{r} {c}"
                    continue
                if c["games"] != min(c["window"], int(row["rawRoleGames"][r])):
                    yield f"roleWindows.roles.{r}.games {c['games']} (window {c['window']}, {row['rawRoleGames'][r]} games as {r})"
                if not 0 <= c["rate"] <= 100:
                    yield f"roleWindows.roles.{r}.rate {c['rate']}"
                games += c["games"]
                full = full and c["games"] >= c["window"]
                sparse += c["games"] < min_cell
                tenths += gc.ROLE_DEAL_TENTHS[r] * c["rate"]
            if (rw["games"], rw["fullWindows"], rw["sparseRoles"]) != (games, full, sparse):
                yield f"roleWindows games/fullWindows/sparseRoles {rw['games']}/{rw['fullWindows']}/{rw['sparseRoles']}"
            # The rates are rounded to one decimal, the sum was rounded once: allow that much drift.
            if abs(tenths / 10 - rw["roleTheory"]) > 0.1:
                yield f"roleWindows.roleTheory {rw['roleTheory']} != Σ deal x rate {tenths / 10:.2f}"
            if rw["from"] > rw["to"]:
                yield "roleWindows from after to"
        self.check_all(check)

    def test_role_outcomes_when_present(self) -> None:
        """roleOutcomes (schemaVersion 4) add up to the row's per-role games and per-side outcome counts."""
        if not any("roleOutcomes" in row for row in self.rows):
            self.skipTest("the committed cache predates roleOutcomes (schemaVersion 4)")

        def check(row):
            ro = row["roleOutcomes"]
            if list(ro) != ROLE_ORDER:
                yield f"roleOutcomes keys {list(ro)}"
                return
            for r in ROLE_ORDER:
                if sum(ro[r].values()) != row["rawRoleGames"][r]:
                    yield f"roleOutcomes.{r} adds up to {sum(ro[r].values())}, not rawRoleGames"
            for side, roles in (("Red", RED_ROLES), ("Blue", set(ROLE_ORDER) - RED_ROLES)):
                for outcome, field in (("三紅", "ThreeRed"), ("三藍死", "MerlinDead"), ("三藍活", "MerlinAlive")):
                    if sum(ro[r][outcome] for r in roles) != row[f"raw{side}{field}"]:
                        yield f"{side} {outcome} != raw{side}{field}"
        self.check_all(check)

    def test_seat_outcomes(self) -> None:
        """Own games (players.seatOutcomesSource = "games", round 5) or, before, the projected overall split."""
        if self.cache["players"].get(gc.SEAT_OUTCOMES_SOURCE_KEY) == gc.OUTCOME_SOURCE_GAMES:
            def check(row):
                seat_games = Counter()
                for key, cell in row["roleSeatStats"].items():
                    seat_games[key.partition("|")[2]] += int(cell["games"])
                for s in SEAT_ORDER:
                    o = row["seatOutcomes"][s]
                    n = o["threeRed"] + o["threeBlueDead"] + o["threeBlueAlive"]
                    if n != seat_games[gc.SEAT_LABELS[s]]:
                        yield f"seat {s}: {n} outcomes for {seat_games[gc.SEAT_LABELS[s]]} games"
                    elif n and (o["threeRedPct"], o["threeBlueDeadPct"], o["threeBlueAlivePct"]) != (
                            pct(o["threeRed"], n), pct(o["threeBlueDead"], n), pct(o["threeBlueAlive"], n)):
                        yield f"seat {s}: pcts"
            self.check_all(check)
            return
        overview = self.cache["overview"]
        projected = gc.projected_seat_outcomes_per_player(
            overview["seatPositionWinRates"], overview["outcomeBreakdown"], self.rows,
        )

        def check_legacy(row):
            if row["seatOutcomes"] != projected[row["name"]]:
                yield "seatOutcomes != projection"
            for s in SEAT_ORDER:
                played = row["seatWinRates"][s] > 0
                if (row["seatOutcomes"][s] == EMPTY_OUTCOME) == played:
                    yield f"seat {s}: projected iff seatWinRates > 0"
        self.check_all(check_legacy)

    def test_order_details_and_overview(self) -> None:
        games = [r["totalGames"] for r in self.rows]
        self.assertEqual(games, sorted(games, reverse=True))
        self.assertEqual(self.cache["players"]["total"], len(self.rows))
        self.assertEqual(self.cache["overview"]["totalPlayers"], len(self.rows))
        self.assertEqual(self.cache["playerDetails"], gc.compute_player_details(self.rows))
        self.assertEqual(list(self.cache["playerDetails"]), [r["name"] for r in self.rows])
        top = gc.compute_overview([], self.rows)
        self.assertEqual(self.cache["overview"]["topPlayersByTheory"], top["topPlayersByTheory"])
        # A cache older than schemaVersion 4 has no outcomes / redGames / blueGames in these rows.
        committed = self.cache["overview"]["topPlayersByGames"]
        self.assertEqual(committed, [{k: row[k] for k in old} for old, row in zip(committed, top["topPlayersByGames"])])
        self.assertEqual(len(committed), len(top["topPlayersByGames"]))


# ---------------------------------------------------------------------------
# Replay of the 2026-04-26 rebuild from the checked-in 牌譜 snapshot
# ---------------------------------------------------------------------------

SNAPSHOT = Path(__file__).resolve().parent / "sheets_cache.json"
# player name -> key table shared with the TS matcher's test (src/__tests__/PlayerNameLookup.test.ts).
NAME_KEY_CASES = Path(__file__).resolve().parent / "src" / "__tests__" / "fixtures" / "player_name_keys.json"
REBUILD_FINGERPRINT = {"totalGames": 2146, "totalPlayers": 198, "threeRed": 999, "threeBlueDead": 499, "threeBlueAlive": 648}
GAME_1276_PLAYERS = ['Tovo Wren', 'Ilse Marr', 'Quill Fen', 'Fable Alder', 'Fable Birch', 'Fable Cedar', 'Fable Elm', 'Fable Fir', 'Fable Hazel', 'Fable Willow']


def rebuild_outcome(row: list[str], idx: dict[str, int]) -> str:
    """The outcome rule of the one-shot rebuild (reverse-engineered): it ignored 結果.

    Any "x" in a 第N局成功失敗 string counts as a failed mission (wrong for the 10-player
    4th mission, which needs two fails); with 3 failed -> 三紅; else 刺殺 decides when
    recorded (Merlin's seat -> 三藍死, other seat -> 三藍活); else 3 clean missions -> 三藍活,
    otherwise 三紅.
    """
    results = [row[idx[c]].strip().lower() for c in ROUND_RESULT_COLS]
    fails = sum(1 for r in results if r and "x" in r)
    passes = sum(1 for r in results if r and "x" not in r)
    kill = row[idx["刺殺"]].strip()
    if fails >= 3:
        return "三紅"
    if kill:
        return "三藍死" if kill == row[idx["配置"]].strip()[5] else "三藍活"
    return "三藍活" if passes >= 3 else "三紅"


class RebuildReplayTest(unittest.TestCase):
    """sheets_cache.json holds a 2026-04-03 copy of the 牌譜 tab (2146 games). Fed the same
    inputs as the rebuild -- its outcome rule, and row 1276 (配置 '206415\\r') without its
    names and result, as its export lost them -- this script reproduces the committed
    players and playerDetails byte for byte. Skipped once a refresh replaced that cache.
    """

    @classmethod
    def setUpClass(cls) -> None:
        if not (COMMITTED_CACHE.exists() and SNAPSHOT.exists()):
            raise unittest.SkipTest("analysis_cache.json or sheets_cache.json not found")
        cls.committed = json.loads(COMMITTED_CACHE.read_text(encoding="utf-8"))
        overview = cls.committed.get("overview", {})
        found = {"totalGames": overview.get("totalGames"), "totalPlayers": overview.get("totalPlayers"),
                 **{k: overview.get("outcomeBreakdown", {}).get(k) for k in ("threeRed", "threeBlueDead", "threeBlueAlive")}}
        if found != REBUILD_FINGERPRINT:
            raise unittest.SkipTest(f"the committed cache is no longer the 2026-04-26 rebuild ({found})")
        cls.log = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("牌譜") or []
        if len(gc.parse_game_log(cls.log)) != 2146:
            raise unittest.SkipTest("sheets_cache.json is not the 2146-game snapshot")
        cls.idx = {h: i for i, h in enumerate(cls.log[0])}
        cls.chemistry = {k: v for k, v in cls.committed["chemistry"].items() if k != "outcomePair"}

    def build(self, log: list[list[str]]) -> dict:
        cache, _ = gc.assemble_cache(
            gc.build_cache(gc.parse_game_log(log), json.loads(json.dumps(self.chemistry))), None,
            strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={},
        )
        return cache

    def test_rebuild_inputs_reproduce_players_byte_for_byte(self) -> None:
        idx = self.idx
        log = [self.log[0]]
        for raw in self.log[1:]:
            row = list(raw)
            if row[idx["流水號"]].strip() == "1276":
                row = [v if h in ("流水號", "文字記錄", "配置") else "" for h, v in zip(self.log[0], row)]
            if row[idx["流水號"]].strip() and len(row[idx["配置"]].strip()) == 6:
                row[idx["結果"]] = rebuild_outcome(row, idx)  # 1276 -> 三紅 (nothing recorded)
            log.append(row)
        cache = self.build(log)

        def dump(value: object) -> str:
            return json.dumps(value, ensure_ascii=False, indent=2)

        # seatOutcomes are the players' own games since round 5 (the rebuild projected the overall split).
        def rebuild_fields(row: dict, committed_row: dict) -> dict:
            return {k: (committed_row.get(k) if k == "seatOutcomes" else v) for k, v in old_fields(row).items()}

        committed_rows = {r["name"]: r for r in self.committed["players"]["players"]}
        players = {"players": [rebuild_fields(r, committed_rows.get(r["name"], {})) for r in cache["players"]["players"]],
                   "total": cache["players"]["total"]}
        details = {n: {**d, "player": old_fields(d["player"])} for n, d in cache["playerDetails"].items()}
        self.assertEqual(dump(players), dump(self.committed["players"]))
        self.assertEqual(dump(details), dump(self.committed["playerDetails"]))
        for key in ("totalGames", "totalPlayers", "redWinRate", "blueWinRate", "merlinKillRate",
                    "outcomeBreakdown", "topPlayersByTheory", "topPlayersByGames"):
            self.assertEqual(cache["overview"][key], self.committed["overview"][key], key)

    def test_first_refresh_from_this_data_passes_the_guards(self) -> None:
        cache = self.build(self.log)  # what the refresh computes: 結果 as written, all names
        self.assertEqual(gc.validate_new_cache(cache, self.committed), [])
        old = {p["name"]: p["totalGames"] for p in self.committed["players"]["players"]}
        gained = {p["name"]: p["totalGames"] - old[p["name"]] for p in cache["players"]["players"]
                  if p["totalGames"] != old.get(p["name"])}
        self.assertEqual(gained, {name: 1.0 for name in GAME_1276_PLAYERS})
        self.assertEqual(cache["overview"]["outcomeBreakdown"]["threeRed"], 971)


# ---------------------------------------------------------------------------
# End to end with a fake spreadsheet (no network)
# ---------------------------------------------------------------------------

E2E_PLAYERS = ["玩家甲", "玩家乙", "玩家丙"]


def fake_tabs(n_games: int = 4) -> dict[str, list[list[str]]]:
    configs = ["123456", "987654", "246802", "135790"]
    outcomes = ["三紅", "三藍活", "三藍死", "三藍活"]
    seats = E2E_PLAYERS + [""] * 7
    games = [LOG_HEADERS] + [log_row(f"T{i}", configs[i % 4], outcomes[i % 4], seats) for i in range(n_games)]
    chem = [[""] + E2E_PLAYERS] + [[p] + ["" if p == q else "55%" for q in E2E_PLAYERS] for p in E2E_PLAYERS]
    return {"牌譜": games, **{tab: chem for tab in ("同贏", "同輸", "贏相關", "同贏-同輸")}}


class FakeSheet:
    def __init__(self, tabs: dict[str, list[list[str]]]):
        self.tabs = tabs

    def worksheet(self, name: str):
        if name not in self.tabs:
            raise WorksheetNotFound(name)
        return mock.Mock(get_all_values=lambda: [list(r) for r in self.tabs[name]])


# Stands in for the gspread module (only `exceptions.WorksheetNotFound` is touched
# once open_spreadsheet is faked), so the test runs with or without gspread installed.
GSPREAD_STUB = mock.Mock(exceptions=mock.Mock(WorksheetNotFound=WorksheetNotFound))


class EndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "analysis_cache.json"
        self.summary = Path(self.tmp.name) / "step_summary.md"
        self.tabs = fake_tabs()
        self.patches = [
            quiet_env(**{gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY), gc.ENV_AS_OF: AS_OF.isoformat()}),
            mock.patch.object(gc, "open_spreadsheet", lambda source, sheet_id: FakeSheet(self.tabs)),
            mock.patch.object(gc, "gspread", GSPREAD_STUB),
            # No aliases unless a test writes this file (the repo's own: PlayerAliasTest).
            mock.patch.object(gc, "ALIASES_PATH", Path(self.tmp.name) / "aliases" / "player_aliases.json"),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def run_main(self, *args: str, summary: bool = False, as_of: str | None = None,
                 actions: bool = False) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        env = {"GITHUB_STEP_SUMMARY": str(self.summary)} if summary else {}
        if as_of:
            env[gc.ENV_AS_OF] = as_of
        if actions:
            env["GITHUB_ACTIONS"] = "true"
        with redirect_stdout(out), redirect_stderr(err), mock.patch.dict(os.environ, env):
            rc = gc.main(["--output", str(self.out), *args])
        return rc, out.getvalue() + err.getvalue()

    def files(self) -> list[str]:
        return sorted(p for p in os.listdir(self.tmp.name) if p != self.summary.name)

    def test_raw_export_uses_current_merged_rows_even_when_cache_unchanged(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        first = self.out.read_bytes()
        raw = Path(self.tmp.name) / "raw-sheets.json"
        rc, log = self.run_main("--export-raw-sheets", str(raw), actions=True, summary=True)
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.out.read_bytes(), first)
        self.assertEqual(json.loads(raw.read_text(encoding="utf-8")), {"牌譜": self.tabs["牌譜"]})
        self.assertEqual(stat.S_IMODE(raw.stat().st_mode), 0o600)
        self.assertIn("牌譜暫存匯出：4 列", log)
        self.assertNotIn(str(raw), log + self.summary.read_text(encoding="utf-8"))
        self.assertNotIn(self.tabs["牌譜"][1][LOG_HEADERS.index("文字記錄")], log)
        self.assertFalse(any(name in log for name in E2E_PLAYERS))

    def test_raw_export_refuses_compare_repo_and_cache_paths_before_fetch(self) -> None:
        raw = Path(self.tmp.name) / "raw-sheets.json"
        targets = [(["--compare"], raw), ([], gc.OUTPUT_PATH.parent / "raw-sheets.json"), ([], self.out)]
        with mock.patch.object(gc, "open_spreadsheet") as fetch:
            for args, target in targets:
                rc, log = self.run_main(*args, "--export-raw-sheets", str(target))
                self.assertEqual(rc, gc.EXIT_CONFIG)
                self.assertNotIn(str(target), log)
            fetch.assert_not_called()
        self.assertFalse(raw.exists())

    def test_raw_export_guard_failure_writes_no_export(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        self.tabs["牌譜"].pop()
        raw = Path(self.tmp.name) / "raw-sheets.json"
        rc, _ = self.run_main("--export-raw-sheets", str(raw))
        self.assertEqual(rc, gc.EXIT_DATA)
        self.assertFalse(raw.exists())

    def test_raw_export_failure_does_not_log_path_or_replace_cache(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        before = self.out.read_bytes()
        raw = Path(self.tmp.name) / "missing" / "raw-sheets.json"
        rc, log = self.run_main("--export-raw-sheets", str(raw))
        self.assertEqual(rc, gc.EXIT_DATA)
        self.assertNotIn(str(raw), log)
        self.assertEqual(self.out.read_bytes(), before)

    def test_refresh_carry_over_idempotence_and_guard(self) -> None:
        rc, log = self.run_main()  # first ever run: no previous file
        self.assertEqual(rc, 0, log)
        first = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(first["overview"]["totalGames"], 4)
        self.assertEqual(set(first), set(gc.SHEET_SECTIONS) | {"strength", "featureStudies"})
        self.assertEqual([p["name"] for p in first["players"]["players"]], E2E_PLAYERS)
        self.assertEqual(first["players"]["players"][0]["totalGames"], 4.0)
        self.assertEqual(first["overview"]["schemaVersion"], 4)
        self.assertEqual(first["leaderboard"]["asOf"], AS_OF.isoformat())
        self.assertEqual(first["leaderboard"]["boards"], [])  # fixture games have no 日期時間
        self.assertEqual(first["leaderboard"]["dates"], {"parsed": 0, "unparsed": 4, "earliest": "", "latest": ""})
        self.assertEqual([f["loopId"] for f in first["featureStudies"]["features"]], ["L141"])  # no previous file

        first["featureStudies"] = {
            "generatedAt": "2026-04-27T15:04:56+08:00", "sampleSize": {"games": 2146, "lakeLinks": 4064},
            "features": [{"loopId": "L141", "visualType": "bar", "data": {}}, L143_FIXTURE()],
        }
        first["archetype"] = {"perPlayer": {"玩家甲": {"hasData": True}}}
        self.out.write_text(json.dumps(first, ensure_ascii=False, indent=2), encoding="utf-8")

        self.tabs["牌譜"].append(self.tabs["牌譜"][1][:])  # one new game in the Sheet
        self.tabs["牌譜"][-1][0] = "T9"
        rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        second_bytes = self.out.read_bytes()
        second = json.loads(second_bytes)
        self.assertEqual(second["overview"]["totalGames"], 5)
        self.assertEqual(second["players"]["players"][0]["totalGames"], 5.0)
        studies = second["featureStudies"]  # carried over, L141 recomputed in place, L143 annotated
        self.assertEqual(list(studies), ["generatedAt", "sampleSize", "features"])
        self.assertEqual((studies["generatedAt"], studies["sampleSize"]["games"]), (AS_OF.isoformat(), 5))
        self.assertEqual([f["loopId"] for f in studies["features"]], ["L141", "L143"])
        self.assertEqual(studies["features"][0]["visualType"], "lakeClaim")
        self.assertEqual(studies["features"][1]["data"], L143_FIXTURE()["data"])  # numbers untouched
        self.assertIn("座位輪替", studies["features"][1]["oneLineHook"])
        self.assertEqual(second["archetype"]["perPlayer"]["玩家甲"], {"hasData": True})
        self.assertFalse(second["archetype"]["perPlayer"]["玩家乙"]["hasData"])  # placeholder for the rest
        carried_line = next(line for line in log.splitlines() if "carried over from the existing cache" in line)
        self.assertIn("archetype (+2 placeholder rows)", carried_line)
        self.assertIn("featureStudies", carried_line)

        rc, _ = self.run_main()  # unchanged Sheet -> byte-identical file (workflow sees no diff)
        self.assertEqual(rc, 0)
        self.assertEqual(self.out.read_bytes(), second_bytes)

        name_cols = [LOG_HEADERS.index(gc.PLAYER_COLUMNS[s]) for s in gc.SEATS]
        for row in self.tabs["牌譜"][1:]:  # player names wiped -> refuse, keep file
            for i in name_cols:
                row[i] = ""
        rc, log = self.run_main("--allow-shrink")
        self.assertEqual(rc, gc.EXIT_DATA)
        self.assertIn("players.players is empty", log)
        self.assertEqual(self.out.read_bytes(), second_bytes)
        self.assertEqual(self.files(), ["analysis_cache.json", "games_cache.json"])

    def test_next_day_without_new_games_writes_nothing(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        first_bytes = self.out.read_bytes()
        next_day = (AS_OF + dt.timedelta(days=1)).isoformat()

        rc, log = self.run_main(as_of=next_day)  # the clock moved on, the Sheet did not
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.out.read_bytes(), first_bytes)  # not rewritten: the workflow has nothing to commit
        self.assertIn("only by the as-of day", log)
        self.assertIn("not written", log)
        self.assertEqual(self.files(), ["analysis_cache.json", "games_cache.json"])

        rc, log = self.run_main("--compare", as_of=next_day, summary=True)  # the preview says so too
        self.assertEqual(rc, 0, log)
        self.assertIn("守門：通過；與現有快取（asOf 2026-10-12）只差 asOf 日期", self.summary.read_text(encoding="utf-8"))
        self.assertEqual(self.out.read_bytes(), first_bytes)

        self.tabs["牌譜"].append(log_row("T9", "123456", "三紅", E2E_PLAYERS + [""] * 7))  # a new game: written, on the new day
        rc, log = self.run_main(as_of=next_day)
        self.assertEqual(rc, 0, log)
        written = json.loads(self.out.read_bytes())
        self.assertEqual(written["overview"]["totalGames"], 5)
        self.assertEqual(written["leaderboard"]["asOf"], next_day)
        self.assertEqual(written["featureStudies"]["generatedAt"], next_day)
        self.assertEqual(written["featureStudies"]["features"][0]["computedAt"], next_day)

    def test_first_refresh_after_the_name_merge(self) -> None:
        """The existing file was written before names were merged (Echo / ECHO / ｅｃｈｏ as three
        players); the refresh merges them, passes the guards, logs counts only, and the next day
        writes nothing (only_the_day_changed replays the merged names)."""
        spellings = ["Echo", "ECHO", "ｅｃｈｏ ", "Echo"]
        self.tabs["牌譜"] = [LOG_HEADERS] + [
            log_row(f"E{i}", "123456", ("三紅", "三藍活", "三藍死")[i % 3],
                    [spellings[i % 4], "玩家乙"] + [""] * 8, date=f"2026/10/{i + 1:02d}")
            for i in range(12)
        ]
        self.tabs["同贏"] = [["", "ECHO", "玩家乙"], ["ECHO", "", "40%"], ["玩家乙", "40%", ""]]
        no_merge = mock.patch.object(gc, "canonicalize_player_names",
                                     lambda games, aliases=gc.NO_ALIASES: (games, gc.NameMerge()))
        with no_merge:
            self.assertEqual(self.run_main()[0], 0)
        old = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(sorted(old["playerDetails"]), sorted(["Echo", "ECHO", "ｅｃｈｏ", "玩家乙"]))

        rc, log = self.run_main(summary=True)
        self.assertEqual(rc, 0, log)
        new = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(sorted(new["playerDetails"]), ["Echo", "玩家乙"])
        self.assertEqual(new["players"]["players"][0]["totalGames"], 12.0)
        self.assertEqual(new["chemistry"]["coWin"]["players"], ["Echo", "玩家乙"])
        newcomers = next(b for b in new["leaderboard"]["boards"] if b["id"] == "newcomers")
        self.assertEqual([r["name"] for r in newcomers["rows"]], ["Echo", "玩家乙"])  # 12 games: over the 10 needed
        self.assertIn("Player names: 2 spelling(s) that differ only by letter case / full- or half-width folded "
                      "into 1 player(s)", log)
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("只差大小寫／全半形的名字：2 個寫法併入 1 位玩家", summary)
        for spelling in ("ECHO", "ｅｃｈｏ"):
            self.assertNotIn(spelling, log + summary)
        merged_bytes = self.out.read_bytes()

        rc, log = self.run_main(as_of=(AS_OF + dt.timedelta(days=1)).isoformat())
        self.assertEqual(rc, 0, log)
        self.assertIn("only by the as-of day", log)
        self.assertEqual(self.out.read_bytes(), merged_bytes)

    def test_alias_file_merges_a_player_on_the_next_refresh(self) -> None:
        """player_aliases.json gains two old names of a player (made-up names): the next refresh shows
        their games under the official name, passes the guards, names nobody in the public log and
        summary, and the day after writes nothing. A malformed file stops the run (exit 2)."""
        old_names = ["Tovo Wren", "Quill Fen", "Ilse Marr", "Tovo Wren"]
        self.tabs["牌譜"] = [LOG_HEADERS] + [
            log_row(f"A{i}", "123456", ("三紅", "三藍活", "三藍死")[i % 3],
                    [old_names[i % 4], "玩家乙"] + [""] * 8, date=f"2026/10/{i + 1:02d}")
            for i in range(12)
        ]
        alias_file = gc.ALIASES_PATH  # setUp: in the temp dir, not there yet
        alias_file.parent.mkdir()
        self.assertEqual(self.run_main()[0], 0)
        old = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(sorted(old["playerDetails"]), sorted(["Tovo Wren", "Quill Fen", "Ilse Marr", "玩家乙"]))
        old["archetype"] = {"perPlayer": {"Tovo Wren": {"hasData": True, "sampleSize": 6}}}
        self.out.write_text(json.dumps(old, ensure_ascii=False, indent=2), encoding="utf-8")

        alias_file.write_text(json.dumps(TEST_ALIASES_DOC), encoding="utf-8")
        rc, log = self.run_main(summary=True, actions=True)
        self.assertEqual(rc, 0, log)
        new = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(sorted(new["playerDetails"]), ["Ilse Marr", "玩家乙"])
        self.assertEqual(new["players"]["players"][0]["name"], "Ilse Marr")
        self.assertEqual(new["players"]["players"][0]["totalGames"], 12.0)
        self.assertEqual(new["players"]["aliases"], {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"})
        self.assertEqual(new["archetype"]["perPlayer"]["Ilse Marr"], {"hasData": True, "sampleSize": 6})
        self.assertIn("Player aliases (player_aliases.json): 2", log)
        self.assertIn("2 name(s) shown under their official name (player_aliases.json, 1 player(s))", log)
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("player_aliases.json 的別名：2 個舊名字改顯示為正式名字（1 位玩家）", summary)
        self.assertNotRegex(log + summary, "Tovo|Quill|Ilse")
        merged_bytes = self.out.read_bytes()

        rc, log = self.run_main(as_of=(AS_OF + dt.timedelta(days=1)).isoformat())
        self.assertEqual(rc, 0, log)
        self.assertIn("only by the as-of day", log)
        self.assertEqual(self.out.read_bytes(), merged_bytes)

        alias_file.write_text('{"aliases": {"Tovo Wren": "Ilse Marr", "Ilse Marr": "Quill Fen"}}',
                              encoding="utf-8")
        rc, log = self.run_main(actions=True)
        self.assertEqual(rc, gc.EXIT_CONFIG, log)
        self.assertIn("::error title=Player alias file malformed::", log)
        self.assertNotRegex(log, "Tovo|Quill|Ilse")
        self.assertEqual(self.out.read_bytes(), merged_bytes)

    def test_future_dated_game_is_logged_and_undated(self) -> None:
        date_col = LOG_HEADERS.index("日期時間")
        self.tabs["牌譜"][1][date_col] = "2062/10/05"  # a mistyped year
        self.tabs["牌譜"][2][date_col] = "2026/10/05"
        rc, log = self.run_main(summary=True)
        self.assertEqual(rc, 0, log)
        self.assertIn("1 game(s) have a 日期時間 after 2026-10-12", log)
        cache = json.loads(self.out.read_bytes())
        self.assertEqual(cache["leaderboard"]["dates"], {"parsed": 1, "unparsed": 3, "earliest": "2026-10-05", "latest": "2026-10-05"})
        self.assertEqual((cache["players"]["players"][0]["firstPlayed"], cache["players"]["players"][0]["lastPlayed"]),
                         ("2026-10-05", "2026-10-05"))
        self.assertIn("- 日期在 asOf 之後的局：1", self.summary.read_text(encoding="utf-8"))

    def test_player_losing_games_refused_unless_allowed(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        before = self.out.read_bytes()
        self.tabs["牌譜"][2][LOG_HEADERS.index("玩1")] = "玩家丁"  # 玩家甲 retyped in one game
        rc, log = self.run_main()
        self.assertEqual(rc, gc.EXIT_DATA, log)
        self.assertIn("玩家甲 4→3", log)
        self.assertEqual(self.out.read_bytes(), before)
        rc, log = self.run_main("--allow-shrink")
        self.assertEqual(rc, 0, log)
        self.assertNotEqual(self.out.read_bytes(), before)

    def test_compare_is_a_dry_run(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        before = self.out.read_bytes()
        self.tabs["牌譜"].append(log_row("T9", "123456", "三紅", E2E_PLAYERS + ["玩家新"] + [""] * 6))
        rc, log = self.run_main("--compare", summary=True)
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.out.read_bytes(), before)  # nothing written
        self.assertEqual(self.files(), ["analysis_cache.json", "games_cache.json"])
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("預覽（--compare，未寫入）", summary)
        self.assertIn("- 玩家：3 → 4；新增 1：玩家新", summary)
        self.assertIn("- 局數：4 → 5", summary)
        self.assertIn("| 1 | 玩家甲 | 4 → 5 | 75.0 → 80.0 |", summary)
        self.assertIn("| 2 | 玩家乙 | 4 → 5 | 100.0 |", summary)
        self.assertIn("| 4 | 玩家新 | — → 1 | — → 100.0 |", summary)
        self.assertIn("- 結果：三紅 1 → 2／三藍死 1／三藍活 2", summary)
        self.assertIn("- 最終（三紅 + 三藍死 = 紅勝）：紅 60.0%／藍 40.0%（5 局）", summary)
        self.assertIn("- 排行榜：asOf 2026-10-12；沒有可做的榜；日期可解析 0 局、無日期 5 局", summary)
        self.assertIn("`totalGames` 3/3（100%）", summary)
        self.assertIn("守門：通過", summary)
        self.assertIn("was not written", log)

        self.tabs["牌譜"] = self.tabs["牌譜"][:1] + self.tabs["牌譜"][2:-1]  # T0 gone (and T9): 3 games
        self.summary.unlink()
        rc, log = self.run_main("--compare", summary=True)
        self.assertEqual(rc, gc.EXIT_DATA, log)
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("守門：會拒絕寫入", summary)
        self.assertIn("would drop from 4 to 3", summary)
        self.assertEqual(self.out.read_bytes(), before)


# ---------------------------------------------------------------------------
# Dates (日期時間) and the as-of day
# ---------------------------------------------------------------------------

class DateParseTest(unittest.TestCase):
    def test_parse_game_date(self) -> None:
        cases = {
            "2022/04/01": "2022-04-01", "2022/4/1": "2022-04-01", "2022-04-01": "2022-04-01",
            "2022.04.01": "2022-04-01", " 2022/04/01 20:00 ": "2022-04-01", "2022/04/01T20:00:00": "2022-04-01",
            "２０２２／０４／０１": "2022-04-01",  # full-width, NFKC
            "1900/01/01": "", "1900-1-1 00:00": "", "": "", None: "", "2022/13/01": "", "2022/02/30": "",
            "20220401": "", "04/01/2022": "", "2022/04/011": "", "2022/04": "", "日期未填": "",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(gc.parse_game_date(raw), expected)

    def test_game_rows_carry_date_category_kill(self) -> None:
        games = gc.parse_game_log(aggregation_log())
        self.assertEqual([g.date for g in games], ["2026-01-05", "2026-01-06", "", "2026-03-01", "2026-02-01"])
        self.assertEqual(gc.date_summary(games), {"parsed": 4, "unparsed": 1, "earliest": "2026-01-05", "latest": "2026-03-01"})
        row = log_row("G9", "123456", "三紅", SEAT_NAMES, date="2026/05/05", category="線瓦", kill="6")
        g = gc.parse_game_log([LOG_HEADERS, row])[0]
        self.assertEqual((g.date, g.category, g.kill), ("2026-05-05", "線瓦", "6"))
        self.assertIn("dates: 4 parsed, 1 without a usable 日期時間", gc.game_log_summary(games))

    def test_drop_dates_after(self) -> None:
        games = gc.parse_game_log(aggregation_log())
        kept, dropped = gc.drop_dates_after(games, dt.date(2026, 2, 1))
        self.assertEqual(dropped, 1)
        self.assertEqual([g.date for g in kept], ["2026-01-05", "2026-01-06", "", "", "2026-02-01"])  # the as-of day itself stays
        self.assertEqual([g.date for g in games], ["2026-01-05", "2026-01-06", "", "2026-03-01", "2026-02-01"])  # input untouched
        self.assertEqual([g.id for g in kept], [g.id for g in games])
        self.assertIs(kept[0], games[0])  # only the affected row is copied
        self.assertEqual(kept[3].seat_players, games[3].seat_players)
        self.assertEqual(gc.drop_dates_after(games, dt.date(2026, 3, 1)), (games, 0))
        # build_cache applies it: a game dated after as_of is undated for players and leaderboard alike
        cache = gc.build_cache(games, {}, dt.date(2026, 2, 1))
        self.assertEqual(cache["leaderboard"]["dates"], {"parsed": 3, "unparsed": 2, "earliest": "2026-01-05", "latest": "2026-02-01"})
        self.assertEqual([g.date for g in games][3], "2026-03-01")

    def test_resolve_as_of(self) -> None:
        self.assertEqual(gc.resolve_as_of({gc.ENV_AS_OF: " 2026-10-12 "}), AS_OF)
        self.assertEqual(gc.resolve_as_of({}, today=dt.date(2026, 1, 2)), dt.date(2026, 1, 2))
        self.assertEqual(gc.resolve_as_of({gc.ENV_AS_OF: ""}, today=dt.date(2026, 1, 2)), dt.date(2026, 1, 2))
        self.assertIsInstance(gc.resolve_as_of({}), dt.date)  # default: today (+08), no crash
        with self.assertRaises(gc.FatalError) as ctx:
            gc.resolve_as_of({gc.ENV_AS_OF: "2026/10/12"})
        self.assertEqual(ctx.exception.exit_code, gc.EXIT_CONFIG)

    def test_windows(self) -> None:
        self.assertEqual(gc.window_start(AS_OF, 365), dt.date(2025, 10, 13))  # 365 days, asOf included
        self.assertEqual(gc.window_start(AS_OF, 1), AS_OF)
        self.assertIsNone(gc.window_start(AS_OF, 0))


# ---------------------------------------------------------------------------
# Theory win rates (Edward 2026-10-13), hand-computed
# ---------------------------------------------------------------------------

THEORY_ROLE_RATES = {"刺客": 70.0, "莫甘娜": 70.0, "莫德雷德": 69.0, "奧伯倫": 71.0, "派西維爾": 30.0, "梅林": 31.0, "忠臣": 30.0}
THEORY_SEAT_RATES = {"1": 45.0, "2": 50.0, "3": 40.0, "4": 46.0, "5": 52.0, "6": 46.0, "7": 43.0, "8": 46.0, "9": 47.0, "10": 48.0}


def seat(role: str, seat_char: str, outcome: str, date: str = "") -> "gc.PlayerSeat":
    return gc.PlayerSeat(role, seat_char, outcome, date)


class TheoryTest(unittest.TestCase):
    def window(self, seats: list, min_cell: int = 3) -> dict:
        return gc.theory_window(seats, THEORY_ROLE_RATES, THEORY_SEAT_RATES, min_cell)

    def test_the_ten_player_deal(self) -> None:
        # 配置 names the seats of the six special roles; the other four seats are 忠臣.
        dealt = Counter(gc.decode_config("123456").values())
        self.assertEqual(dealt, Counter({"忠臣": 4, **{r: 1 for r in gc.CONFIG_ROLE_ORDER}}))
        self.assertEqual(gc.ROLE_DEAL_TENTHS, {r: dealt[r] for r in ROLE_ORDER})  # 忠臣 4/10, every other role 1/10
        self.assertEqual(sum(gc.ROLE_DEAL_TENTHS.values()), 10)
        self.assertEqual(gc.SEAT_DEAL_TENTHS, {s: 1 for s in SEAT_ORDER})

    def test_every_cell_full(self) -> None:
        """30 games, every role at least 3, every seat exactly 3: no top-up."""
        spec = [("刺客", ["三紅", "三紅", "三藍死", "三藍活"]),        # 3/4 = 75.0 (三藍死 is a red win)
                ("莫甘娜", ["三紅", "三藍活", "三藍活"]),              # 1/3
                ("莫德雷德", ["三藍死"] * 3),                          # 3/3 = 100.0
                ("奧伯倫", ["三藍活"] * 3),                            # 0/3
                ("派西維爾", ["三藍活", "三藍死", "三紅"]),            # 1/3 (三藍死 is a blue loss)
                ("梅林", ["三藍活", "三藍活", "三藍死", "三紅"]),      # 2/4 = 50.0
                ("忠臣", ["三藍活"] * 4 + ["三藍死"] * 3 + ["三紅"] * 3)]  # 4/10 = 40.0
        seats = []
        for role, outcomes in spec:
            for outcome in outcomes:
                seats.append(seat(role, SEAT_ORDER[len(seats) % 10], outcome))
        w = self.window(seats)
        # roleTheory = 0.1 x (75 + 33.33 + 100 + 0 + 33.33 + 50) + 0.4 x 40 = 29.17 + 16 = 45.17 -> 45.2.
        # 14 wins in 30 games; three games in every seat, so positionTheory = 0.1 x Σ wins_s / 3 = 14/30 too.
        self.assertEqual(w, {"window": 0, "games": 30, "roleTheory": 45.2, "positionTheory": 46.7, "finalWinRate": 46.7,
                             "from": "", "to": "", "sparseRoles": 0, "sparseSeats": 0})

    def test_sparse_cells_are_topped_up_to_three_games(self) -> None:
        seats = [
            seat("刺客", "1", "三紅", "2026-01-01"),    # W
            seat("忠臣", "1", "三藍活", "2026-01-02"),  # W
            seat("忠臣", "1", "三紅"),                   # L, no date
            seat("刺客", "2", "三藍活", "2026-01-04"),  # L
            seat("忠臣", "0", "三藍活", "2026-01-05"),  # W, seat 10
        ]
        # roles: 刺客 1 win in 2 games -> (100 + 1 x 70.0) / 3 = 56.67; 忠臣 2/3 = 66.67 (3 games: as is);
        #   no game as 莫甘娜 / 莫德雷德 / 奧伯倫 / 派西維爾 / 梅林 -> 70 / 69 / 71 / 30 / 31.
        #   roleTheory = 0.1 x (56.67 + 271) + 0.4 x 66.67 = 32.77 + 26.67 = 59.43 -> 59.4.
        # seats: 1 has 3 games, 2 wins = 66.67; 2: 0 wins in 1 -> (0 + 2 x 50) / 3 = 33.33;
        #   10: 1 win in 1 -> (100 + 2 x 48) / 3 = 65.33; the other seven are the population rate (320 together).
        #   positionTheory = 0.1 x (66.67 + 33.33 + 65.33 + 320) = 48.53 -> 48.5.
        self.assertEqual(self.window(seats), {
            "window": 0, "games": 5, "roleTheory": 59.4, "positionTheory": 48.5, "finalWinRate": 60.0,
            "from": "2026-01-01", "to": "2026-01-05", "sparseRoles": 6, "sparseSeats": 9,
        })
        # Top-up off (0): a played cell is its own rate (刺客 50.0, seat 2 0.0, seat 10 100.0); a cell
        # without games is still the population rate. 0.1 x (50 + 271) + 26.67 = 58.77; 0.1 x 486.67 = 48.67.
        self.assertEqual(self.window(seats, min_cell=0), {
            "window": 0, "games": 5, "roleTheory": 58.8, "positionTheory": 48.7, "finalWinRate": 60.0,
            "from": "2026-01-01", "to": "2026-01-05", "sparseRoles": 5, "sparseSeats": 7,
        })
        # Without min_cell, theory_window follows LEADERBOARD_CONFIG["theoryMinCellGames"] (5 here, see
        # test_sparse_cells_are_topped_up_to_five_games).
        self.assertEqual(gc.theory_window(seats, THEORY_ROLE_RATES, THEORY_SEAT_RATES)["roleTheory"], 54.1)
        with config_patch(theoryMinCellGames=3):
            self.assertEqual(gc.theory_window(seats, THEORY_ROLE_RATES, THEORY_SEAT_RATES)["roleTheory"], 59.4)
        with config_patch(theoryMinCellGames=0):
            self.assertEqual(gc.theory_window(seats, THEORY_ROLE_RATES, THEORY_SEAT_RATES)["roleTheory"], 58.8)

    def test_sparse_cells_are_topped_up_to_five_games(self) -> None:
        """The owner's value since 2026-10-14 (「少於 3 場通常沒有統計意義……建議補到 5 場」): the same five
        games as above, every cell with fewer than 5 games topped up to 5."""
        seats = [
            seat("刺客", "1", "三紅", "2026-01-01"),    # W
            seat("忠臣", "1", "三藍活", "2026-01-02"),  # W
            seat("忠臣", "1", "三紅"),                   # L, no date
            seat("刺客", "2", "三藍活", "2026-01-04"),  # L
            seat("忠臣", "0", "三藍活", "2026-01-05"),  # W, seat 10
        ]
        # roles: 刺客 1 win in 2 -> (100 + 3 x 70.0) / 5 = 62.0; 忠臣 2 wins in 3 -> (200 + 2 x 30.0) / 5 = 52.0
        #   (3 games are no longer enough); the five roles never played -> 271 together.
        #   roleTheory = 0.1 x (62.0 + 271) + 0.4 x 52.0 = 33.3 + 20.8 = 54.1.
        # seats: 1 (3 games, 2 wins) -> (200 + 2 x 45) / 5 = 58.0; 2 (0 in 1) -> (0 + 4 x 50) / 5 = 40.0;
        #   10 (1 in 1) -> (100 + 4 x 48) / 5 = 58.4; the other seven 320 together.
        #   positionTheory = 0.1 x (58.0 + 40.0 + 58.4 + 320) = 47.64 -> 47.6.
        self.assertEqual(self.window(seats, min_cell=5), {
            "window": 0, "games": 5, "roleTheory": 54.1, "positionTheory": 47.6, "finalWinRate": 60.0,
            "from": "2026-01-01", "to": "2026-01-05", "sparseRoles": 7, "sparseSeats": 10,
        })
        # A cell with exactly 5 games is used as is: five 忠臣 games, 3 wins -> 60.0, not topped up.
        five = [seat("忠臣", "1", "三藍活")] * 3 + [seat("忠臣", "1", "三紅")] * 2
        w = self.window(five, min_cell=5)
        # 0.1 x (70 + 70 + 69 + 71 + 30 + 31) + 0.4 x 60.0 = 34.1 + 24 = 58.1; seat 1 as is (60.0) + 9 others
        # at the population rate (418) -> 0.1 x 478 = 47.8.
        self.assertEqual((w["roleTheory"], w["positionTheory"], w["sparseRoles"], w["sparseSeats"]), (58.1, 47.8, 6, 9))

    def test_role_windows(self) -> None:
        """角色理論 over each role's own last games (schemaVersion 4): 10 per special role, 40 as 忠臣.
        W = a final win, L = a loss; the roles' games are interleaved in time, which changes nothing."""
        def games(role: str, results: str) -> list:
            win, loss = ("三紅", "三藍活") if role in RED_ROLES else ("三藍活", "三藍死")
            return [seat(role, "1", win if ch == "W" else loss) for ch in results]

        per_role = [games(role, results) for role, results in (
            ("刺客", "LL" + "W" * 10),           # 12 games: only the last 10 count -> 10/10 = 100.0
            ("莫甘娜", "W" * 5 + "L" * 5),       # exactly 10 -> 50.0
            ("莫德雷德", "W" * 10),              # 100.0
            ("奧伯倫", "L" * 10),                # 0.0
            ("派西維爾", "WL"),                  # 2 < 3: topped up -> (100 + 1 x 30.0) / 3 = 43.33
            ("梅林", "WWLLL"),                   # 5 < 10: all of them -> 40.0
            ("忠臣", "W" * 5 + "W" * 10 + "L" * 30),  # 45 games: the last 40 -> 10/40 = 25.0
        )]
        timeline = []
        while any(per_role):  # round robin: the roles interleave, each role keeps its own order
            for games_in_role in per_role:
                if games_in_role:
                    timeline.append(games_in_role.pop(0))
        rw = gc.role_window_theory(timeline, THEORY_ROLE_RATES, 3)
        # 0.1 x (100 + 50 + 100 + 0 + 43.33 + 40) + 0.4 x 25 = 33.33 + 10 = 43.33 -> 43.3
        self.assertEqual(rw, {
            "roleTheory": 43.3, "fullWindows": False, "games": 87, "sparseRoles": 1, "from": "", "to": "",
            "roles": {
                "刺客": {"games": 10, "wins": 10, "window": 10, "rate": 100.0},
                "莫甘娜": {"games": 10, "wins": 5, "window": 10, "rate": 50.0},
                "莫德雷德": {"games": 10, "wins": 10, "window": 10, "rate": 100.0},
                "奧伯倫": {"games": 10, "wins": 0, "window": 10, "rate": 0.0},
                "派西維爾": {"games": 2, "wins": 1, "window": 10, "rate": 43.3},
                "梅林": {"games": 5, "wins": 2, "window": 10, "rate": 40.0},
                "忠臣": {"games": 40, "wins": 10, "window": 40, "rate": 25.0},
            },
        })
        # Top-up off: 派西維爾 is its own 1/2 = 50.0 -> 0.1 x 340 + 10 = 44.0.
        self.assertEqual(gc.role_window_theory(timeline, THEORY_ROLE_RATES, 0)["roleTheory"], 44.0)
        # Topped up to 5 (2026-10-14): 派西維爾 (100 + 3 x 30.0) / 5 = 38.0; 梅林 has exactly 5 games, as is
        # (40.0) -> 0.1 x (100 + 50 + 100 + 0 + 38 + 40) + 10 = 42.8, still one sparse role.
        five = gc.role_window_theory(timeline, THEORY_ROLE_RATES, 5)
        self.assertEqual((five["roleTheory"], five["sparseRoles"], five["roles"]["派西維爾"]["rate"], five["roles"]["梅林"]["rate"]),
                         (42.8, 1, 38.0, 40.0))
        self.assertEqual(gc.role_window_theory(timeline, THEORY_ROLE_RATES)["roleTheory"], 42.8)  # the config's 5
        # The windows before those (the improved board's baseline): 刺客 LL (2 < 3: (0 + 70) / 3 = 23.33),
        # 忠臣 the first five W (100.0), no earlier game in the other roles (the population rates):
        # 0.1 x (23.33 + 70 + 69 + 71 + 30 + 31) + 0.4 x 100 = 29.43 + 40 = 69.43 -> 69.4.
        before = gc.role_window_theory(timeline, THEORY_ROLE_RATES, 3, previous=True)
        self.assertEqual((before["roleTheory"], before["games"], before["sparseRoles"], before["fullWindows"]),
                         (69.4, 7, 6, False))
        self.assertEqual(before["roles"]["忠臣"], {"games": 5, "wins": 5, "window": 40, "rate": 100.0})
        self.assertEqual(before["roles"]["刺客"], {"games": 2, "wins": 0, "window": 10, "rate": 23.3})

    def test_full_windows(self) -> None:
        """fullWindows: K_r games in every role -- 10 each, 40 as 忠臣 -- and nothing less."""
        full = [seat(r, "1", "三紅", f"2026-02-{1 + i % 28:02d}") for r in ROLE_ORDER
                for i in range(40 if r == "忠臣" else 10)]
        rw = gc.role_window_theory(full, THEORY_ROLE_RATES, 3)
        self.assertEqual((rw["fullWindows"], rw["games"], rw["sparseRoles"]), (True, 100, 0))
        # All 三紅: the red roles win, the blue ones lose -> 0.1 x 4 x 100 = 40.0, the same as the plain
        # final win rate of these 100 games (40 of 100): full windows are dealt like the cards are.
        self.assertEqual(rw["roleTheory"], 40.0)
        self.assertEqual((rw["from"], rw["to"]), ("2026-02-01", "2026-02-28"))
        short = [s for s in full if s.role != "梅林"] + [s for s in full if s.role == "梅林"][:9]
        self.assertFalse(gc.role_window_theory(short, THEORY_ROLE_RATES, 3)["fullWindows"])
        with config_patch(roleWindowGames=9):  # the window follows the config
            self.assertTrue(gc.role_window_theory(short, THEORY_ROLE_RATES, 3)["fullWindows"])
        self.assertEqual(gc.role_window_games(), {r: 40 if r == "忠臣" else 10 for r in ROLE_ORDER})

    def test_last_100_and_career(self) -> None:
        """120 games as 忠臣 cycling through the seats: 70 losses, then 50 wins."""
        timeline = [seat("忠臣", SEAT_ORDER[i % 10], "三紅" if i < 70 else "三藍活", f"2026-01-{1 + i // 10:02d}")
                    for i in range(120)]
        theory = gc.player_theory(timeline, THEORY_ROLE_RATES, THEORY_SEAT_RATES)
        self.assertEqual(list(theory), ["roleWindows", "last100", "career"])  # schemaVersion 4: no last50
        specials = 0.1 * (70 + 70 + 69 + 71 + 30 + 31)  # 34.1: the six special roles, never played
        # roleWindows: the last 40 games as 忠臣 (S80..S119) are all wins -> 0.4 x 100 + 34.1 = 74.1.
        self.assertEqual({k: v for k, v in theory["roleWindows"].items() if k != "roles"},
                         {"roleTheory": 74.1, "fullWindows": False, "games": 40, "sparseRoles": 6,
                          "from": "2026-01-09", "to": "2026-01-12"})
        # last 100: 50 wins -> 0.4 x 50 + 34.1 = 54.1; every seat 5/10 -> 50.
        self.assertEqual(theory["last100"], {"window": 100, "games": 100, "roleTheory": 54.1, "positionTheory": 50.0,
                                             "finalWinRate": 50.0, "from": "2026-01-03", "to": "2026-01-12",
                                             "sparseRoles": 6, "sparseSeats": 0})
        # career: 50/120 -> 0.4 x 41.67 + 34.1 = 50.77 -> 50.8; every seat 5/12 -> 41.7.
        self.assertEqual(theory["career"], {"window": 0, "games": 120, "roleTheory": 50.8, "positionTheory": 41.7,
                                            "finalWinRate": 41.7, "from": "2026-01-01", "to": "2026-01-12",
                                            "sparseRoles": 6, "sparseSeats": 0})
        self.assertAlmostEqual(specials, 34.1)

        short = gc.player_theory(timeline[-30:], THEORY_ROLE_RATES, THEORY_SEAT_RATES)  # fewer than 100 games: all of them
        self.assertEqual(short["last100"]["games"], 30)
        self.assertEqual({**short["last100"], "window": 0}, short["career"])
        self.assertEqual(short["roleWindows"]["roleTheory"], short["career"]["roleTheory"])  # 30 < 40 as 忠臣


class TimelineTest(unittest.TestCase):
    def test_order_by_date_then_log_position(self) -> None:
        """甲 sits in seat 1 every game; the 配置 gives them a different role each time, so the role
        sequence shows the order."""
        rows = [
            LOG_HEADERS,
            log_row("A0", "123456", "三紅", SEAT_NAMES),                       # 刺客, undated: before every dated game
            log_row("A1", "213456", "三紅", SEAT_NAMES, date="2026/03/02"),    # 莫甘娜
            log_row("A2", "231456", "三紅", SEAT_NAMES, date="2026/03/01"),    # 莫德雷德: earlier date, later row
            log_row("A3", "234156", "三紅", SEAT_NAMES),                       # 奧伯倫, undated: with A2 (03/01), after it
            log_row("A4", "123456", "", SEAT_NAMES, date="2026/03/05"),        # no 結果: not counted (its date still carries)
            log_row("A5", "234516", "三紅", SEAT_NAMES),                       # 派西維爾, undated: with A4 (03/05)
            log_row("A6", "234561", "三紅", SEAT_NAMES, date="2026/03/03"),    # 梅林
        ]
        timeline = gc.player_timelines(gc.parse_game_log(rows))["甲"]
        self.assertEqual([s.role for s in timeline], ["刺客", "莫德雷德", "奧伯倫", "莫甘娜", "梅林", "派西維爾"])
        self.assertEqual([s.date for s in timeline], ["", "2026-03-01", "", "2026-03-02", "2026-03-03", ""])
        self.assertEqual({s.seat for s in timeline}, {"1"})


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------

# 配置 123456: seats 1-6 are 刺客 莫甘娜 莫德雷德 奧伯倫 派西維爾 梅林, seats 7-0 are 忠臣.
EARLY = ["三紅", "三紅", "三藍死", "三藍活"]  # S0..S59 by i % 4: red wins the final 3 of 4, blue 1
LATE = ["三藍活", "三藍活", "三藍死", "三紅"]  # S60..S109: red 2 of 4, blue 2
PASSERS = [f"路人{i}" for i in range(1, 10)]


def dated(gid: str, date: str, outcome: str, names: list[str] | None = None, category: str = "") -> list[str]:
    return log_row(gid, "123456", outcome, names or SEAT_NAMES, date=date, category=category)


def s_date(i: int) -> str:
    """Date of game S<i>: two a day from 2026-06-01 (S0, S1) to 2026-07-25 (S108, S109)."""
    return (dt.date(2026, 6, 1) + dt.timedelta(days=i // 2)).isoformat()


def leaderboard_log() -> list[list[str]]:
    """As of 2026-10-12 (active = a game since 2026-07-15). Two undated games at the top (the
    oldest), 120 games of 2024 by 老人 and 路人1..9 (not active), then S0..S109 by 甲..癸, always in
    the same seat and so the same role; 新人 takes 癸's seat 10 in the last 13 (S97 = 2026-07-19 on).
    Career games: 甲..壬 112, 癸 99, 新人 13."""
    rows = [LOG_HEADERS, dated("U0", "", "三紅"), dated("U1", "", "三紅")]
    rows += [dated(f"Y{i}", (dt.date(2024, 1, 1) + dt.timedelta(days=i)).isoformat(), "三紅", ["老人"] + PASSERS)
             for i in range(120)]
    for i in range(110):
        names = SEAT_NAMES[:9] + ["新人"] if i >= 97 else SEAT_NAMES
        rows.append(dated(f"S{i}", s_date(i), (EARLY if i < 60 else LATE)[i % 4], names))
    return rows


class LeaderboardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.cache = build_fresh(leaderboard_log())
        cls.lb = cls.cache["leaderboard"]
        cls.boards = {b["id"]: b for b in cls.lb["boards"]}
        cls.players = {p["name"]: p for p in cls.cache["players"]["players"]}

    def test_section_shape(self) -> None:
        self.assertEqual(list(self.lb), ["asOf", "dates", "config", "boards"])
        self.assertEqual(self.lb["asOf"], "2026-10-12")
        self.assertEqual(self.lb["dates"], {"parsed": 230, "unparsed": 2, "earliest": "2024-01-01", "latest": "2026-07-25"})
        self.assertEqual(self.lb["config"], {"theoryWindows": [100], **TEST_LEADERBOARD_CONFIG})
        self.assertEqual(list(self.lb["config"])[0], "theoryWindows")  # derived: [mainGames]
        # Everyone here plays one role all the time: nobody has full role windows (no main / improved
        # board) and nobody 250 games (no overall board). RotationBoardsTest has those.
        self.assertEqual(list(self.boards), ["position", "assassin", "newcomers", "roleTitles"])
        for board in self.lb["boards"]:
            with self.subTest(board=board["id"]):
                self.assertEqual(list(board)[:9], ["id", "metric", "title", "titleEn", "period", "periodEn", "minGames", "note", "noteEn"])
                self.assertEqual(list(board)[-1], "rows")
                self.assertEqual([r["rank"] for r in board["rows"]], list(range(1, len(board["rows"]) + 1)))
                if board["id"] != "roleTitles":  # one row per title holder, not cut to topN (ties 各給)
                    self.assertLessEqual(len(board["rows"]), gc.LEADERBOARD_CONFIG["topN"])
                for r in board["rows"]:
                    self.assertIsInstance(r["value"], float)
                    self.assertIsInstance(r["games"], int)
                if board["id"] != "roleTitles":
                    keys = [(-r["value"], -r["games"], -r["careerGames"], r["name"]) for r in board["rows"]]
                    self.assertEqual(keys, sorted(keys))
        self.assertEqual({b["metric"] for b in self.lb["boards"]}, {"positionTheory", "roleTheory", "hitRate", "finalWinRate"})

    def theory_fields(self, name: str, key: str) -> dict:
        w = self.players[name]["theory"][key]
        return {k: w[k] for k in ("roleTheory", "positionTheory", "finalWinRate", "games", "from", "to", "sparseRoles", "sparseSeats")}

    def test_position_board_is_each_players_last_100_games(self) -> None:
        board = self.boards["position"]
        self.assertEqual((board["period"], board["minGames"], board["windowGames"]), ("各人最近 100 場", 100, 100))
        self.assertTrue(board["note"].startswith("近 90 天內有出賽、生涯至少 100 場；"))
        self.assertIn("角色理論 = Σ 抽到該角色的機率（忠臣 4/10、其他角色各 1/10）", board["note"])
        self.assertIn("每個角色看他當該角色的最近 10 場、忠臣 40 場", board["note"])
        self.assertIn("不到 5 場的角色、位置或格子，用全體的最終勝率補到 5 場", board["note"])
        self.assertIn("fewer than 5 games is topped up to 5", board["noteEn"])
        # 癸 99 career games, 新人 13: too few; 老人 (120 games) last played in 2024: not active.
        self.assertEqual({r["name"] for r in board["rows"]}, set(SEAT_NAMES[:9]))
        for r in board["rows"]:
            last = self.players[r["name"]]["theory"]["last100"]
            self.assertEqual(list(r), ["rank", "name", "value", "positionTheory", "overallTheory", "finalWinRate",
                                       *OUTCOME_FIELDS, "games", "careerGames", "from", "to", "sparseSeats"])
            self.assertEqual((r["games"], r["careerGames"], r["value"]), (100, 112, last["positionTheory"]))
            self.assertEqual((r["positionTheory"], r["finalWinRate"], r["sparseSeats"]),
                             (last["positionTheory"], last["finalWinRate"], last["sparseSeats"]))
            self.assertEqual(r["overallTheory"], self.players[r["name"]]["theory"]["career"]["overallTheory"])
            self.assertEqual((r["from"], r["to"]), ("2026-06-06", "2026-07-25"))  # S10..S109: the undated U0 U1 are older
            self.assertEqual(r["sparseSeats"], 9)  # one seat each
        jia = next(r for r in board["rows"] if r["name"] == "甲")
        # 刺客 in S10..S109: EARLY loses only on i % 4 == 3 (13 of 50), LATE wins on i % 4 in (2, 3) (24 of 50).
        self.assertEqual(jia["finalWinRate"], 61.0)

    def test_role_theory_needs_full_role_windows(self) -> None:
        """One role all the time is not enough for 角色理論: the main board and the overview ranking need
        10 games in every special role and 40 as 忠臣 (資料篩選不能少場)."""
        self.assertNotIn("main", self.boards)
        self.assertNotIn("improved", self.boards)
        self.assertEqual(self.cache["overview"]["topPlayersByRoleTheory"], [])
        rw = self.players["甲"]["theory"]["roleWindows"]  # 刺客 in all 112 games: the last 10 of them
        self.assertEqual((rw["fullWindows"], rw["games"], rw["sparseRoles"]), (False, 10, 6))
        self.assertEqual(rw["roles"]["刺客"], {"games": 10, "wins": 4, "window": 10, "rate": 40.0})  # S100..S109 (LATE)
        self.assertFalse(any(p["theory"]["roleWindows"]["fullWindows"] for p in self.players.values()))

    def test_assassin_board(self) -> None:
        board = self.boards["assassin"]
        self.assertEqual((board["period"], board["minGames"], board["windowGames"]), ("各人最近 20 次刺殺", 10, 20))
        # 甲's last 20 games as 刺客 that reached 三藍, back from S109: three per four games (活 活 死), so
        # S86..S109 give 18 with 6 hits, S85 and S84 two more misses.
        self.assertEqual(board["rows"], [{"rank": 1, "name": "甲", "value": 30.0, "hits": 6, "attempts": 20, "games": 20,
                                          "careerGames": 112, "from": "2026-07-13", "to": "2026-07-25"}])

    def test_newcomers_board_is_the_exception(self) -> None:
        board = self.boards["newcomers"]
        self.assertEqual((board["period"], board["minGames"], board["windowDays"], board["allGames"]),
                         ("2026-07-15 ～ 2026-10-12 打滿 10 場", 10, 90, True))
        self.assertIn("例外", board["note"])
        self.assertIn("第一次累積到 10 場", board["note"])
        self.assertEqual([(r["name"], r["games"], r["firstPlayed"], r["qualifiedOn"]) for r in board["rows"]],
                         [("新人", 13, "2026-07-19", "2026-07-24")])  # 10th game: S106
        row = board["rows"][0]
        self.assertEqual({k: row[k] for k in self.theory_fields("新人", "career")}, self.theory_fields("新人", "career"))
        self.assertEqual(row["finalWinRate"], 53.8)  # 忠臣 in S97..S109: 7 of 13 are 三藍活

    def test_newcomers_go_by_the_day_they_reach_the_threshold(self) -> None:
        """Edward 2026-10-26「以初次超過門檻場數當作標準」: a few games long ago, then back and over 10 games
        within the 90 days = a newcomer (firstPlayed stays the real first game); 10 games long ago = not one."""
        log = leaderboard_log()
        log += [dated(f"R{i}", f"2024-03-0{i + 1}", "三紅", ["回鍋"] + PASSERS) for i in range(3)]
        log += [dated(f"Q{i}", f"2026-08-{i + 1:02d}", "三藍活", ["回鍋"] + PASSERS) for i in range(7)]
        log += [dated(f"V{i}", f"2024-05-{i + 1:02d}", "三紅", ["老手"] + PASSERS) for i in range(10)]
        log += [dated("V10", "2026-08-20", "三紅", ["老手"] + PASSERS)]
        board = next(b for b in build_fresh(log)["leaderboard"]["boards"] if b["id"] == "newcomers")
        rows = {r["name"]: (r["games"], r["firstPlayed"], r["qualifiedOn"]) for r in board["rows"]}
        self.assertEqual(rows, {"新人": (13, "2026-07-19", "2026-07-24"), "回鍋": (10, "2024-03-01", "2026-08-07")})

    def test_role_titles(self) -> None:
        board = self.boards["roleTitles"]
        self.assertEqual((board["period"], board["minGames"]), ("忠臣近 20 場、其他角色近 20 場", 20))
        self.assertEqual(board["roleWindowGames"], {r: 20 for r in ROLE_ORDER})  # full = fallback: fixed
        self.assertTrue(board["note"].endswith("同率者並列、各得稱號；每個角色的場數固定：忠臣 20 場、其他角色 20 場"))
        self.assertIn("players tied at the top all get the title", board["noteEn"])
        # Roles in ROLE_ORDER; `rank` is the row number. 刺客..梅林: one player each (seats 1-6).
        self.assertEqual([r["role"] for r in board["rows"]], ROLE_ORDER[:6] + ["忠臣"] * 4)
        self.assertEqual([r["rank"] for r in board["rows"]], list(range(1, 11)))
        rows = {r["role"]: r for r in board["rows"] if r["role"] != "忠臣"}
        # S90..S109 (LATE): red and blue both win 10 of 20.
        self.assertEqual(rows["刺客"], {"rank": 1, "role": "刺客", "name": "甲", "value": 50.0, "games": 20, "wins": 10,
                                       "careerRoleGames": 112, "qualified": 1})
        self.assertEqual((rows["梅林"]["name"], rows["梅林"]["value"]), ("己", 50.0))
        # 忠臣 (Edward 2026-10-14: ties 各給): 庚 辛 壬 and 癸 (S77..S96) all 10/20, so all four hold the
        # title; more career games as 忠臣 first (112 > 99), then the name (code-point order: 壬 庚 辛);
        # 新人 has 13 games as 忠臣 < 20. Until 2026-10-14 only 壬 was listed.
        loyal = [(r["rank"], r["name"], r["value"], r["games"], r["wins"], r["careerRoleGames"])
                 for r in board["rows"] if r["role"] == "忠臣"]
        self.assertEqual(loyal, [(7, "壬", 50.0, 20, 10, 112), (8, "庚", 50.0, 20, 10, 112),
                                 (9, "辛", 50.0, 20, 10, 112), (10, "癸", 50.0, 20, 10, 99)])

    def test_role_title_ties_compare_the_rounded_rate(self) -> None:
        """A tie is the same published (one-decimal) rate; a lower rate is not a title, however many games."""
        def runs(name_wins: dict[str, int], games_n: int = 20) -> list[list[str]]:
            # Each name plays 刺客 (seat 1) games_n times; wins first (三紅), then losses (三藍活).
            rows = [LOG_HEADERS]
            day = dt.date(2026, 9, 1)
            for name, wins in name_wins.items():
                for i in range(games_n):
                    rows.append(dated(f"{name}{i}", day.isoformat(), "三紅" if i < wins else "三藍活",
                                      [name] + PASSERS))
                    day += dt.timedelta(days=0 if i % 2 else 1)
            return rows

        cache = build_fresh(runs({"甲": 15, "乙": 15, "丙": 14}))
        board = next(b for b in cache["leaderboard"]["boards"] if b["id"] == "roleTitles")
        assassins = [(r["name"], r["value"]) for r in board["rows"] if r["role"] == "刺客"]
        # Same games and career games: by name (code points, 乙 U+4E59 before 甲 U+7532); 丙 14/20 = 70.0 is
        # not a holder.
        self.assertEqual(assassins, [("乙", 75.0), ("甲", 75.0)])
        # Fable Willowgle holder when nobody ties.
        cache = build_fresh(runs({"甲": 15, "乙": 16}))
        board = next(b for b in cache["leaderboard"]["boards"] if b["id"] == "roleTitles")
        self.assertEqual([(r["name"], r["value"]) for r in board["rows"] if r["role"] == "刺客"], [("乙", 80.0)])

    def test_future_dated_games_count_as_undated(self) -> None:
        """A mistyped year must not keep a player 'active', be their lastPlayed or dates.latest."""
        log = leaderboard_log()
        log.append(dated("Z0", "2062/10/05", "三紅", ["老人"] + PASSERS))  # 老人's only game since 2024
        log += [dated(f"Z{i}", "2062/10/06", "三藍活", ["未來人"] + SEAT_NAMES[1:]) for i in range(1, 11)]  # future games only
        cache = build_fresh(log)
        lb = cache["leaderboard"]
        self.assertEqual(lb["dates"], {"parsed": 230, "unparsed": 13, "earliest": "2024-01-01", "latest": "2026-07-25"})
        boards = {b["id"]: b for b in lb["boards"]}
        self.assertNotIn("老人", {r["name"] for r in boards["position"]["rows"]})  # still not active
        self.assertEqual([r["name"] for r in boards["newcomers"]["rows"]], ["新人"])  # 未來人 has no dated first game
        rows = {p["name"]: p for p in cache["players"]["players"]}
        self.assertEqual((rows["老人"]["totalGames"], rows["老人"]["firstPlayed"], rows["老人"]["lastPlayed"]),
                         (121.0, "2024-01-01", "2024-04-29"))
        self.assertEqual((rows["未來人"]["totalGames"], rows["未來人"]["firstPlayed"], rows["未來人"]["lastPlayed"]), (10.0, "", ""))

    def test_nobody_active_means_no_boards(self) -> None:
        rows = [LOG_HEADERS] + [dated(f"A{i}", "2024/11/01", "三紅") for i in range(22)]
        lb = build_fresh(rows)["leaderboard"]
        self.assertEqual(lb["boards"], [])
        self.assertEqual(gc.leaderboard_summary(lb), "asOf 2026-10-12；沒有可做的榜；日期可解析 22 局、無日期 0 局")
        summary = gc.leaderboard_summary(self.lb)
        self.assertIn("position 9 人（最近 100 場）", summary)
        self.assertIn("newcomers 1 人（90 天）", summary)
        self.assertEqual(gc.leaderboard_summary(None), "無")

    def test_overview_ranking_ignores_activity(self) -> None:
        ov = self.cache["overview"]
        top = ov["topPlayersByPositionTheory"]
        # Everyone with 100 career games, active or not: 甲..壬 and 老人 / 路人1..9 (120 games in 2024) -> top 10.
        self.assertEqual(len(top), 10)
        self.assertEqual(list(top[0]), ["name", "positionTheory", "finalWinRate", "games", "careerGames"])
        for r in top:
            last = self.players[r["name"]]["theory"]["last100"]
            self.assertEqual((r["positionTheory"], r["finalWinRate"], r["games"]), (last["positionTheory"], last["finalWinRate"], 100))
            self.assertGreaterEqual(r["careerGames"], 100)
        keys = [(-r["positionTheory"], -r["careerGames"], r["name"]) for r in top]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(ov["topPlayersByOverallTheory"], [])  # nobody has 250 games
        with config_patch(overallMinGames=112):  # 甲..壬 112 games, 老人 and 路人1..9 120 -> 19 players
            overall = gc.compute_overview([], self.cache["players"]["players"])["topPlayersByOverallTheory"]
        self.assertEqual(len(overall), 10)
        self.assertEqual(list(overall[0]), ["name", "overallTheory", "positionTheory", "finalWinRate", "games", "careerGames"])
        for r in overall:
            career = self.players[r["name"]]["theory"]["career"]
            self.assertEqual((r["overallTheory"], r["positionTheory"], r["finalWinRate"], r["games"]),
                             (career["overallTheory"], career["positionTheory"], career["finalWinRate"], r["careerGames"]))

    def test_active_means_a_game_in_the_last_90_days_as_of_included(self) -> None:
        """asOf 2026-10-12: a last game on 2026-07-15 (asOf - 89, the 90th day) is active, 07-14 is not."""
        on_edge = [f"邊{i}" for i in range(1, 10)]
        too_old = [f"舊{i}" for i in range(1, 10)]
        start = dt.date(2026, 4, 6)  # 100 games, one a day: 04-06 .. 07-14
        rows = [LOG_HEADERS]
        rows += [dated(f"A{i}", (start + dt.timedelta(days=i + 1)).isoformat(), "三紅", ["甲"] + on_edge) for i in range(100)]
        rows += [dated(f"B{i}", (start + dt.timedelta(days=i)).isoformat(), "三紅", ["乙"] + too_old) for i in range(100)]
        cache = build_fresh(rows)
        last = {p["name"]: p["lastPlayed"] for p in cache["players"]["players"]}
        self.assertEqual((last["甲"], last["乙"]), ("2026-07-15", "2026-07-14"))
        boards = {b["id"]: b for b in cache["leaderboard"]["boards"]}
        for board_id in ("position", "roleTitles"):
            with self.subTest(board=board_id):
                names = {r["name"] for r in boards[board_id]["rows"]}
                self.assertIn("甲", names)
                self.assertFalse(names & ({"乙"} | set(too_old)))

    def test_assassin_board_needs_ten_attempts(self) -> None:
        """Nine assassinations as 刺客 (games that reached 三藍) are too few, ten are enough; 三紅 games
        as 刺客 are not attempts."""
        rows = [LOG_HEADERS]
        for name, attempts in (("十次", 10), ("九次", 9)):
            others = [f"{name}{i}" for i in range(1, 10)]
            outcomes = ["三藍死", "三藍活"] * 5
            rows += [dated(f"{name}{i}", "2026-10-01", outcomes[i], [name] + others) for i in range(attempts)]
            rows += [dated(f"{name}紅{i}", "2026-10-02", "三紅", [name] + others) for i in range(5)]
        board = next(b for b in build_fresh(rows)["leaderboard"]["boards"] if b["id"] == "assassin")
        self.assertEqual([(r["name"], r["hits"], r["attempts"], r["value"]) for r in board["rows"]], [("十次", 5, 10, 50.0)])


# Ten players who keep their seats while the deal rotates: in game R<i> special role j (刺客 莫甘娜 莫德雷德
# 奧伯倫 派西維爾 梅林) sits in seat index (j + i) % 10, so every 10 games each player is dealt every special
# role once and 忠臣 four times -- 26 games per special role and 104 as 忠臣 in 260 games. R0..R159 are all
# 三紅 (red roles win, blue roles lose: role theory 40.0 for everyone); R160..R259 follow ROT_LATE[i % 10],
# so in those games each player's result is fixed per role. Three games a day from 2026-05-01 (R259 =
# 2026-07-26): everyone is active as of 2026-10-12.
ROT_NAMES = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉"]  # seats 1..9, then seat 0 (= 10)
ROT_LATE = ["三紅", "三藍活", "三藍死", "三藍活", "三紅", "三藍活", "三藍死", "三紅", "三藍活", "三藍活"]
ROT_GAMES, ROT_SWITCH = 260, 160


def rot_config(i: int) -> str:
    return "".join(gc.SEATS[(j + i) % 10] for j in range(6))


def rot_outcome(i: int) -> str:
    return "三紅" if i < ROT_SWITCH else ROT_LATE[i % 10]


def rotation_log() -> list[list[str]]:
    return [LOG_HEADERS] + [
        log_row(f"R{i}", rot_config(i), rot_outcome(i), ROT_NAMES, date=(dt.date(2026, 5, 1) + dt.timedelta(days=i // 3)).isoformat())
        for i in range(ROT_GAMES)
    ]


def rot_win(role: str, outcome: str) -> bool:
    """The final result, written out again: red roles win on 三紅 / 三藍死, blue roles on 三藍活 only."""
    return outcome in ("三紅", "三藍死") if role in RED_ROLES else outcome == "三藍活"


def rot_role(s: int, i: int) -> str:
    """The role of the player in seat index s in game R<i>."""
    j = (s - i) % 10
    return ROLE_ORDER[j] if j < 6 else "忠臣"


def rot_expected_role_theory(s: int, pick: Callable[[list, int], list]) -> float:
    """Role theory of the player in seat index s, recomputed from the fixture's rule (not from the cache):
    `pick(games as the role, K)` chooses the games of each role (no cell here has fewer than 3)."""
    total = Fraction(0)
    for j, role in enumerate(ROLE_ORDER):
        k = 40 if role == "忠臣" else 10
        used = pick([i for i in range(ROT_GAMES) if rot_role(s, i) == role], k)
        wins = sum(1 for i in used if rot_win(role, rot_outcome(i)))
        total += Fraction(gc.ROLE_DEAL_TENTHS[role], 10) * Fraction(100 * wins, len(used))
    return round(total * 10) / 10


def rot_expected_overall_theory(s: int, population: dict) -> float:
    """整體理論 of the player in seat index s, from the fixture's rule: their own seat's seven cells (26
    games each, 104 as 忠臣, never fewer than 5) plus the other 63 cells at the population rate."""
    label = gc.SEAT_LABELS[gc.SEATS[s]]
    total = Fraction(0)
    for role in ROLE_ORDER:
        weight = Fraction(gc.ROLE_DEAL_TENTHS[role], 100)
        games = [i for i in range(ROT_GAMES) if rot_role(s, i) == role]
        wins = sum(1 for i in games if rot_win(role, rot_outcome(i)))
        total += weight * Fraction(100 * wins, len(games))
        total += weight * sum(Fraction(str(v)) for seat, v in population[role].items() if seat != label)
    return round(total * 10) / 10


def rot_expected_outcomes(s: int, games: range) -> dict:
    """任務勝率 / 刺殺勝率 of the player in seat index s over these games, from the fixture's rule."""
    red = [i for i in games if rot_role(s, i) in RED_ROLES]
    blue = [i for i in games if rot_role(s, i) not in RED_ROLES]
    red_m = sum(1 for i in red if rot_outcome(i) == "三紅")
    blue_m = sum(1 for i in blue if rot_outcome(i) != "三紅")
    three_blue = [i for i in games if rot_outcome(i) != "三紅"]
    hits = sum(1 for i in three_blue if (rot_outcome(i) == "三藍死") == (rot_role(s, i) in RED_ROLES))
    return {
        "missionWinRate": rnd1((red_m + blue_m) / len(games) * 100),
        "missionRedWinRate": rnd1(red_m / len(red) * 100), "missionBlueWinRate": rnd1(blue_m / len(blue) * 100),
        "assassinWinRate": rnd1(hits / len(three_blue) * 100) if three_blue else None,
        "threeBlueGames": len(three_blue),
    }


class RotationBoardsTest(unittest.TestCase):
    """main / improved / overall / position boards and the overview rankings on a rotating deal."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.cache = build_fresh(rotation_log())
        cls.boards = {b["id"]: b for b in cls.cache["leaderboard"]["boards"]}
        cls.players = {p["name"]: p for p in cls.cache["players"]["players"]}

    def test_fixture(self) -> None:
        zi = self.players["子"]
        self.assertEqual(zi["rawRoleGames"], {r: 104.0 if r == "忠臣" else 26.0 for r in ROLE_ORDER})
        self.assertEqual(list(self.boards), ["main", "position", "overall", "theory", "improved", "assassin", "roleTitles"])

    def test_main_board_is_role_theory_over_the_role_windows(self) -> None:
        board = self.boards["main"]
        self.assertEqual((board["period"], board["minGames"]), ("各角色近 10 場、忠臣近 40 場", 100))
        self.assertEqual(board["roleWindowGames"], {r: 40 if r == "忠臣" else 10 for r in ROLE_ORDER})
        self.assertNotIn("windowGames", board)
        self.assertTrue(board["note"].startswith("近 90 天內有出賽、六個特殊角色各至少 10 場、忠臣至少 40 場；"
                                                 "位置理論、最終勝率、任務勝率、刺殺勝率看最近 100 場、整體理論看生涯；"))
        self.assertEqual(len(board["rows"]), 10)
        for r in board["rows"]:
            s, theory = ROT_NAMES.index(r["name"]), self.players[r["name"]]["theory"]
            self.assertEqual(list(r), ["rank", "name", "value", "roleTheory", "positionTheory", "overallTheory",
                                       "finalWinRate", *OUTCOME_FIELDS, "games", "careerGames", "from", "to",
                                       "sparseRoles", "sparseSeats"])
            self.assertEqual(r["value"], rot_expected_role_theory(s, lambda games, k: games[-k:]))
            self.assertEqual((r["roleTheory"], r["games"], r["sparseRoles"]), (r["value"], 100, 0))
            self.assertEqual(theory["roleWindows"]["roleTheory"], r["value"])
            self.assertTrue(theory["roleWindows"]["fullWindows"])
            self.assertEqual((r["positionTheory"], r["finalWinRate"]),
                             (theory["last100"]["positionTheory"], theory["last100"]["finalWinRate"]))
            self.assertEqual((r["overallTheory"], r["careerGames"]), (theory["career"]["overallTheory"], 260))
            self.assertEqual({k: r[k] for k in OUTCOME_FIELDS}, rot_expected_outcomes(s, range(ROT_GAMES - 100, ROT_GAMES)))
        # 子 (seat 1) in R160..R259: 刺客 wins (三紅), 莫甘娜 and 莫德雷德 lose (三藍活), 奧伯倫 wins (三紅),
        # 派西維爾 loses (三藍死), 梅林 wins (三藍活), 忠臣 wins 2 of 4 -> 0.1 x 300 + 0.4 x 50 = 50.0. Their
        # last 10 games as 刺客 are R160..R250 (2026-06-23 on), the last as 莫甘娜 R259 (2026-07-26).
        zi = next(r for r in board["rows"] if r["name"] == "子")
        self.assertEqual((zi["value"], zi["from"], zi["to"]), (50.0, "2026-06-23", "2026-07-26"))
        top = self.cache["overview"]["topPlayersByRoleTheory"]  # all-time, same people here
        self.assertEqual([(t["name"], t["roleTheory"], t["overallTheory"]) for t in top],
                         [(r["name"], r["roleTheory"], r["overallTheory"]) for r in board["rows"]])

    def test_improved_board_compares_the_role_windows_before(self) -> None:
        board = self.boards["improved"]
        self.assertEqual((board["period"], board["minGames"]), ("各角色近 10 場、忠臣近 40 場 vs 再之前同樣場數", 200))
        # The windows before (R60..R159 in every role) are all 三紅: 40.0 for everyone.
        expected = {n: rnd1(rot_expected_role_theory(s, lambda games, k: games[-k:]) - 40.0) for s, n in enumerate(ROT_NAMES)}
        self.assertEqual({r["name"]: r["value"] for r in board["rows"]}, {n: d for n, d in expected.items() if d > 0})
        for r in board["rows"]:
            self.assertEqual((r["priorRoleTheory"], r["recentGames"], r["priorGames"], r["games"], r["careerGames"]),
                             (40.0, 100, 100, 100, 260))
            self.assertEqual(r["value"], rnd1(r["recentRoleTheory"] - r["priorRoleTheory"]))
        self.assertEqual(next(r for r in board["rows"] if r["name"] == "子")["value"], 10.0)
        self.assertEqual(rot_expected_role_theory(0, lambda games, k: games[-2 * k:-k]), 40.0)

    def test_overall_board_is_the_career_role_by_seat_theory(self) -> None:
        board = self.boards["overall"]
        self.assertEqual((board["period"], board["minGames"]), ("各人生涯全部場次", 250))
        self.assertNotIn("allGames", board)  # not the newcomers' exception
        population = self.cache["overview"]["roleSeatFinalWinRates"]
        for r in board["rows"]:
            s = ROT_NAMES.index(r["name"])
            career = self.players[r["name"]]["theory"]["career"]
            self.assertEqual(r["value"], rot_expected_overall_theory(s, population))
            self.assertEqual((r["overallTheory"], r["roleTheory"], r["positionTheory"], r["finalWinRate"], r["games"]),
                             (r["value"], career["roleTheory"], career["positionTheory"], career["finalWinRate"], 260))
            self.assertEqual(r["roleTheory"], rot_expected_role_theory(s, lambda games, k: games))
            # One seat all career: its 7 cells have 26 (忠臣 104) games, the other 63 are the population's.
            self.assertEqual((r["sparseCells"], r["populationShare"]), (63, 90.0))
            self.assertEqual({k: r[k] for k in OUTCOME_FIELDS}, rot_expected_outcomes(s, range(ROT_GAMES)))
        # 子's career role theory: 刺客 26/26, 莫甘娜 and 莫德雷德 16/26, 奧伯倫 26/26, 派西維爾 0/26, 梅林
        # 10/26, 忠臣 20/104 -> 0.1 x 361.54 + 0.4 x 19.23 = 43.85 -> 43.8.
        self.assertEqual(next(r for r in board["rows"] if r["name"] == "子")["roleTheory"], 43.8)
        overall = self.cache["overview"]["topPlayersByOverallTheory"]
        self.assertEqual([(t["name"], t["overallTheory"]) for t in overall], [(r["name"], r["value"]) for r in board["rows"]])
        with config_patch(overallMinGames=261):  # nobody qualifies: the board is left out
            ids = [b["id"] for b in build_fresh(rotation_log())["leaderboard"]["boards"]]
        self.assertNotIn("overall", ids)

    def test_position_board(self) -> None:
        board = self.boards["position"]
        seat_rates = self.cache["overview"]["seatFinalWinRates"]
        for r in board["rows"]:
            s = ROT_NAMES.index(r["name"])
            label = gc.SEAT_LABELS[gc.SEATS[s]]
            wins = sum(1 for i in range(ROT_SWITCH, ROT_GAMES) if rot_win(rot_role(s, i), rot_outcome(i)))
            # One seat played (100 games), the other nine at the population rate.
            expected = (Fraction(wins) + sum(Fraction(str(v)) for k, v in seat_rates.items() if k != label)) / 10
            self.assertEqual(r["value"], round(expected * 10) / 10)
            self.assertEqual((r["games"], r["sparseSeats"]), (100, 9))

    def test_windows_follow_the_config(self) -> None:
        with config_patch(roleWindowGames=5, loyalWindowGames=20):
            cache = build_fresh(rotation_log())
        boards = {b["id"]: b for b in cache["leaderboard"]["boards"]}
        self.assertEqual(boards["main"]["period"], "各角色近 5 場、忠臣近 20 場")
        self.assertEqual(cache["overview"]["theoryConfig"]["roleWindowGames"], {r: 20 if r == "忠臣" else 5 for r in ROLE_ORDER})
        self.assertEqual((cache["leaderboard"]["config"]["roleWindowGames"], cache["leaderboard"]["config"]["loyalWindowGames"]), (5, 20))
        zi = {p["name"]: p for p in cache["players"]["players"]}["子"]["theory"]["roleWindows"]
        self.assertEqual((zi["games"], zi["roles"]["忠臣"]["window"], zi["roleTheory"]), (50, 20, 50.0))
        # The 5 / 20 games before the last ones are R160 on too: nobody improved, so no improved board.
        self.assertNotIn("improved", boards)


# ---------------------------------------------------------------------------
# Names that differ only by letter case / width are one player (Edward 2026-10-13)
# ---------------------------------------------------------------------------

def variant_names(i: int) -> list[str]:
    """Seat names of game S<i> as typed: seat 1 is Nova (54x "Nova", 28x "NOVA", 28x full-width
    "ｎｏｖａ" with stray spaces), seat 2 is Kite (55x "kite" first, then 55x "KITE": a tie, the
    spelling seen first wins); the other seats as in leaderboard_log."""
    nova = ("NOVA", " ｎｏｖａ ", "Nova", "Nova")[i % 4]
    kite = "kite" if i < 55 else "KITE"
    return [nova, kite] + (SEAT_NAMES[2:9] + ["新人"] if i >= 97 else SEAT_NAMES[2:])


def name_log(names_of: Callable[[int], list[str]]) -> list[list[str]]:
    rows = [LOG_HEADERS, dated("U0", "", "三紅"), dated("U1", "", "三紅")]
    for i in range(110):
        rows.append(dated(f"S{i}", s_date(i), (EARLY if i < 60 else LATE)[i % 4], names_of(i)))
    return rows


def name_chemistry(labels: list[str]) -> dict:
    values = [[None if a == b else float(10 * a + b) for b in range(len(labels))] for a in range(len(labels))]
    matrix = {"players": list(labels), "rowLabels": list(labels), "values": values}
    return {k: copy.deepcopy(matrix) for k in ("coWin", "coLose", "winCorr", "coWinMinusLose")}


def build_named(log: list[list[str]], chemistry: dict, aliases: gc.PlayerAliases = gc.NO_ALIASES) -> dict:
    cache, _ = gc.assemble_cache(
        gc.build_cache(gc.parse_game_log(log), chemistry, as_of=TEST_AS_OF, aliases=aliases), None,
        strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={}, as_of=TEST_AS_OF,
    )
    return cache


class PlayerNameMergeTest(unittest.TestCase):
    def test_key(self) -> None:
        for spelling in ("Nova", "NOVA", "nova", " nova ", "ｎｏｖａ", "ＮＯＶＡ", "No​va", "nOvA　"):
            with self.subTest(spelling=spelling):
                self.assertEqual(gc.player_name_key(spelling), "nova")
        self.assertEqual(gc.player_name_key("Ｔｏｖｏ　Ｗｒｅｎ"), "tovo wren")
        self.assertNotEqual(gc.player_name_key("Nova"), gc.player_name_key("Novo"))
        self.assertEqual(gc.player_name_key("雪球"), "雪球")  # CJK untouched
        self.assertEqual(gc.player_name_key(None), "")

    def test_key_matches_the_shared_ts_matcher(self) -> None:
        """The same table PlayerNameLookup.test.ts checks @avalon/shared playerNameKey against: the bots,
        the website search and the stats API find a player by exactly the key the cache merged him by."""
        fixture = json.loads(NAME_KEY_CASES.read_text(encoding="utf-8"))
        cases = fixture["cases"]
        self.assertGreater(len(cases), 20)
        for case in cases:
            with self.subTest(name=case["input"]):
                self.assertEqual(gc.player_name_key(case["input"]), case["key"])
        # player_aliases.json: the same table checks @avalon/shared playerIdentityKey / aliasTarget.
        aliases = gc.parse_player_aliases({"aliases": fixture["aliases"]})
        self.assertGreater(len(fixture["aliasCases"]), 8)
        for case in fixture["aliasCases"]:
            with self.subTest(alias=case["input"]):
                self.assertEqual(gc.player_identity_key(case["input"], aliases), case["identityKey"])
                official = aliases.official.get(aliases.keys.get(gc.player_name_key(case["input"]), ""))
                self.assertEqual(official, case["official"])

    def test_display_is_the_most_used_spelling_ties_go_to_the_first_seen(self) -> None:
        games = gc.parse_game_log(name_log(variant_names))
        before = [dict(g.seat_players) for g in games]
        merged, names = gc.canonicalize_player_names(games)
        self.assertEqual([dict(g.seat_players) for g in games], before)  # input untouched
        typed = [g for g in merged if g.id.startswith("S")]
        self.assertEqual({g.seat_players["1"] for g in typed}, {"Nova"})
        self.assertEqual({g.seat_players["2"] for g in typed}, {"kite"})
        self.assertEqual((names.merged_players, names.merged_spellings), (2, 3))  # Nova 3 spellings, kite 2
        self.assertEqual(names.summary(), "3 spelling(s) that differ only by letter case / full- or half-width "
                                          "folded into 2 player(s)")
        again, names2 = gc.canonicalize_player_names(merged)  # idempotent
        self.assertIs(again, merged)
        self.assertEqual(names2.merged_spellings, 0)
        self.assertEqual((names.doubled_games, names2.doubled_games), (0, 0))

    def test_one_player_on_two_seats_is_counted_for_the_log(self) -> None:
        """A game listing "Nova" and "ｎｏｖａ" on two seats: one player for the cache, so the log
        says how many such games there are (counts only), to fix in 玩1..玩0."""
        def doubled(i: int) -> list[str]:
            names = variant_names(i)
            return names[:2] + ["ｎｏｖａ" if i == 0 else names[2]] + names[3:]
        _, names = gc.canonicalize_player_names(gc.parse_game_log(name_log(doubled)))
        self.assertEqual(names.doubled_games, 1)
        self.assertTrue(names.summary().endswith("; 1 game(s) list one player on two seats (check 玩1..玩0)"))
        _, plain = gc.canonicalize_player_names(gc.parse_game_log(name_log(variant_names)))
        self.assertEqual(plain.doubled_games, 0)
        self.assertNotIn("two seats", plain.summary())

    def test_every_per_player_structure_merges(self) -> None:
        """Typed with variants or typed the same way every time: the same cache, byte for byte
        (players, playerDetails, seat / role stats, theory, leaderboard boards and thresholds,
        overview rankings, chemistry labels)."""
        def canonical(i: int) -> list[str]:
            return ["Nova", "kite"] + variant_names(i)[2:]
        typed = build_named(name_log(variant_names), name_chemistry(["NOVA", "KITE", "丙"]))
        clean = build_named(name_log(canonical), name_chemistry(["Nova", "kite", "丙"]))
        self.assertEqual(json.dumps(typed, ensure_ascii=False, sort_keys=True),
                         json.dumps(clean, ensure_ascii=False, sort_keys=True))
        rows = {p["name"]: p for p in typed["players"]["players"]}
        self.assertNotIn("NOVA", rows)
        self.assertEqual(rows["Nova"]["totalGames"], 110.0)
        self.assertEqual(rows["Nova"]["theory"]["career"]["games"], 110)
        self.assertEqual(rows["Nova"]["roleSeatStats"], {"刺客|1": {"games": 110.0, "wins": rows["Nova"]["rawTotalWins"],
                                                                   "winRate": rows["Nova"]["winRate"]}})
        self.assertEqual(set(typed["playerDetails"]), set(rows))
        position = next(b for b in typed["leaderboard"]["boards"] if b["id"] == "position")
        self.assertIn("Nova", {r["name"] for r in position["rows"]})  # 110 career games: over the 100-game threshold
        self.assertEqual(typed["chemistry"]["coWin"]["players"], ["Nova", "kite", "丙"])
        self.assertEqual(typed["chemistry"]["outcomePair"]["rowLabels"], ["Nova", "kite", "丙"])
        # seatOutcomes / outcomePair are counted after the merge: every spelling's games are Nova's.
        seat1 = rows["Nova"]["seatOutcomes"]["1"]
        self.assertEqual(seat1["threeRed"] + seat1["threeBlueDead"] + seat1["threeBlueAlive"], 110)
        self.assertEqual(typed["chemistry"]["outcomePair"]["games"][0][1], 110)  # Nova + kite, all 110 games
        self.assertEqual(gc.validate_new_cache(typed, None), [])

    def test_split_names_never_reach_a_threshold_alone(self) -> None:
        """Nova's 110 games typed three ways used to be three players under the 100-game board."""
        typed = build_named(name_log(variant_names), name_chemistry(["丙"]))
        position = next(b for b in typed["leaderboard"]["boards"] if b["id"] == "position")
        self.assertEqual(position["minGames"], 100)
        self.assertEqual(len([r for r in position["rows"] if gc.player_name_key(r["name"]) == "nova"]), 1)

    def test_chemistry_labels(self) -> None:
        chemistry = name_chemistry(["NOVA", "nova", "丙", "Stranger"])
        renamed, dropped = gc.canonicalize_chemistry(chemistry, {"nova": "Nova", "丙": "丙"})
        m = chemistry["coWin"]
        self.assertEqual(m["players"], ["Nova", "丙", "Stranger"])  # a second spelling: first one kept
        self.assertEqual(m["rowLabels"], ["Nova", "丙", "Stranger"])
        self.assertEqual(m["values"], [[None, 2.0, 3.0], [20.0, None, 23.0], [30.0, 32.0, None]])
        self.assertEqual((renamed, dropped), (8, 8))  # NOVA as column and row label of 4 matrices; nova too
        untouched = name_chemistry(["Nova", "丙"])
        self.assertEqual(gc.canonicalize_chemistry(untouched, {"nova": "Nova"}), (0, 0))
        self.assertEqual(untouched, name_chemistry(["Nova", "丙"]))

    def test_old_cache_with_split_names_passes_the_guards(self) -> None:
        """The first refresh after the merge: the existing file still has Nova / NOVA / nova rows."""
        prev = fake_cache(players=12)
        split = [("Nova", 40.0), ("NOVA", 7.0), ("nova", 3.0), ("Kite", 9.0), ("KITE", 2.0)]
        prev["players"]["players"] += [{"name": n, "totalGames": g} for n, g in split]
        prev["overview"]["totalPlayers"] = prev["players"]["total"] = 17
        new = fake_cache(players=12)
        new["players"]["players"] += [{"name": "Nova", "totalGames": 50.0}, {"name": "Kite", "totalGames": 11.0}]
        new["overview"]["totalPlayers"] = new["players"]["total"] = 14
        self.assertEqual(gc.distinct_players(prev), 14)
        self.assertEqual(gc.games_regressions(new, prev), [])
        self.assertEqual(gc.validate_new_cache(new, prev), [])
        new["players"]["players"][-2]["totalGames"] = 49.0  # one game lost: still refused
        self.assertEqual(gc.games_regressions(new, prev), [("Nova", 50.0, 49.0)])
        many = fake_cache(players=40)  # 40 players typed two ways = 80 rows; merged: 40, no drop
        many["players"]["players"] += [{"name": f"p{i}", "totalGames": 1.0} for i in range(40)]
        many["overview"]["totalPlayers"] = many["players"]["total"] = 80
        merged = fake_cache(players=40)
        for row in merged["players"]["players"]:
            row["totalGames"] += 1
        self.assertEqual(gc.validate_new_cache(merged, many), [])
        lines = gc.compare_summary(merged, many)
        self.assertIn("只差大小寫／全半形而併入同一位玩家的舊名字 40 個", lines[1])
        self.assertNotIn("消失", lines[1])
        self.assertNotIn("p1", "\n".join(lines))

    def test_carried_per_player_rows_follow_the_merge(self) -> None:
        players = {"Nova": {}, "Kite": {}, "丙": {}}
        per_player = {
            "NOVA": {"hasData": True, "sampleSize": 30},
            "Nova": {"hasData": True, "sampleSize": 60},
            "nova": {"hasData": False, "sampleSize": 2},
            "KITE": {"hasData": True, "sampleSize": 12},  # Kite's own row is a placeholder
            "Kite": {"hasData": False, "sampleSize": 3},
            "Gone": {"hasData": True, "sampleSize": 5},
        }
        folded = gc.fold_per_player_rows(per_player, players)
        self.assertEqual(folded, {"Nova": {"hasData": True, "sampleSize": 60},
                                  "Kite": {"hasData": True, "sampleSize": 12},
                                  "Gone": {"hasData": True, "sampleSize": 5}})
        prev = fake_cache(players=1)
        prev["archetype"] = {"perPlayer": per_player}
        new = fake_cache(players=1)
        new["playerDetails"] = {n: {"player": {"totalGames": 9.0}} for n in players}
        carried = gc.carry_over_sections(new, prev, {"archetype": placeholder})
        self.assertEqual(carried["archetype"], 1)  # only 丙 needs a placeholder
        self.assertEqual(set(new["archetype"]["perPlayer"]), {"Nova", "Kite", "丙", "Gone"})
        self.assertIn("NOVA", prev["archetype"]["perPlayer"])  # previous untouched

    def test_snapshot_counts(self) -> None:
        """The checked-in 牌譜 snapshot: how many spellings fold (counts only)."""
        if not SNAPSHOT.exists():
            self.skipTest("sheets_cache.json not found")
        games = gc.parse_game_log(json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("牌譜") or [])
        if len(games) != 2146:
            self.skipTest("sheets_cache.json is not the 2146-game snapshot")
        spellings = {n for g in games for n in g.seat_players.values()}
        merged, names = gc.canonicalize_player_names(games)
        self.assertEqual((len(spellings), names.merged_players, names.merged_spellings), (198, 22, 27))
        self.assertEqual(len(gc.compute_player_stats(merged)), 198 - 27)


# ---------------------------------------------------------------------------
# Player aliases: the owner says two names are one player (player_aliases.json, Edward 2026-10-14)
# ---------------------------------------------------------------------------

# Made-up names only: Tovo Wren and Quill Fen are old names of Ilse Marr.
TEST_ALIASES_DOC = {"_comment": "test", "aliases": {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"}}


def sample_aliases() -> gc.PlayerAliases:
    return gc.parse_player_aliases(TEST_ALIASES_DOC)


def alias_names(i: int) -> list[str]:
    """Seat names of game S<i>: seat 1 is Ilse Marr, typed as her old names (Tovo Wren, also upper-cased
    with a double space, and Quill Fen) and as her official name in lower case; seat 2 as in variant_names."""
    one = ("Tovo Wren", "ilse marr", "TOVO  WREN", "Quill Fen")[i % 4]
    return [one] + variant_names(i)[1:]


def official_names(i: int) -> list[str]:
    return ["Ilse Marr"] + variant_names(i)[1:]


class PlayerAliasTest(unittest.TestCase):
    def test_parse_and_identity_key(self) -> None:
        aliases = sample_aliases()
        self.assertEqual(dict(aliases.names), {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"})
        self.assertEqual(dict(aliases.keys), {"tovo wren": "ilse marr", "quill fen": "ilse marr"})
        self.assertEqual(dict(aliases.official), {"ilse marr": "Ilse Marr"})
        for spelling in ("Tovo Wren", "ＴＯＶＯ　ｗｒｅｎ", " tovo  wren ", "Quill Fen", "QUILL FEN", "Ilse Marr", "ilse marr"):
            with self.subTest(spelling=spelling):
                self.assertEqual(gc.player_identity_key(spelling, aliases), "ilse marr")
        self.assertEqual(gc.player_identity_key("Nova", aliases), "nova")
        self.assertEqual(gc.player_identity_key("Tovo", aliases), "tovo")  # part of an alias: someone else
        self.assertEqual(gc.player_identity_key("Tovo Wren", gc.NO_ALIASES), "tovo wren")
        tidy = gc.parse_player_aliases({"aliases": {" Tovo​  Wren ": "Ilse　Marr"}})
        self.assertEqual(dict(tidy.names), {"Tovo Wren": "Ilse Marr"})  # tidied like a 玩1..玩0 cell

    def test_malformed_documents_are_refused(self) -> None:
        bad = [
            ([], "the top level is not a JSON object"),
            ({"_comment": "x"}, '"aliases" is missing'),
            ({"aliases": ["Tovo Wren", "Ilse Marr"]}, '"aliases" is missing or is not an object'),
            ({"aliases": {"Tovo Wren": 7}}, "aliases entry 1 ('Tovo Wren': 7): both names must be strings"),
            ({"aliases": {"Tovo Wren": "  "}}, "a name is empty"),
            ({"aliases": {"Tovo Wren": "ＴＯＶＯ ＷＲＥＮ"}}, "both names are one player already"),
            ({"aliases": {"Tovo Wren": "Ilse Marr", "TOVO WREN": "Quill Fen"}},
             "aliases entry 2 ('TOVO WREN': 'Quill Fen'): another entry gives this name a different official name"),
            ({"aliases": {"Tovo Wren": "Ilse Marr", "Quill Fen": "ILSE MARR"}}, "spells this official name differently"),
            ({"aliases": {"Tovo Wren": "Ilse Marr", "Ilse Marr": "Quill Fen"}},
             "aliases entry 1 ('Tovo Wren': 'Ilse Marr'): the official name is itself an alias"),
        ]
        for doc, message in bad:
            with self.subTest(doc=doc):
                with self.assertRaises(ValueError) as caught:
                    gc.parse_player_aliases(doc)
                self.assertIn(message, str(caught.exception))
                if isinstance(doc, dict) and isinstance(doc.get("aliases"), dict):
                    with self.assertRaises(ValueError) as public:
                        gc.parse_player_aliases(doc, show_names=False)
                    self.assertNotRegex(str(public.exception), "Tovo|Ilse|Quill|TOVO|ILSE")
        same_target = gc.parse_player_aliases({"aliases": {"Tovo Wren": "Ilse Marr", "TOVO WREN": "Ilse Marr"}})
        self.assertEqual(dict(same_target.keys), {"tovo wren": "ilse marr"})  # a repeated source is fine

    def test_load_missing_unreadable_and_malformed_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "player_aliases.json"
            self.assertIs(gc.load_player_aliases(path), gc.NO_ALIASES)  # no file = no aliases
            path.write_text(json.dumps(TEST_ALIASES_DOC), encoding="utf-8")
            self.assertEqual(gc.load_player_aliases(path), sample_aliases())
            path.write_text('{"aliases": {"Tovo Wren": "Ilse Marr",}}', encoding="utf-8")
            with self.assertRaises(gc.FatalError) as caught:
                gc.load_player_aliases(path)
            self.assertEqual((caught.exception.exit_code, caught.exception.title),
                             (gc.EXIT_CONFIG, "Player alias file unreadable"))
            self.assertIn("player_aliases.json cannot be read (JSONDecodeError", str(caught.exception))
            path.write_text(json.dumps({"aliases": {"Tovo Wren": "Ilse Marr", "Ilse Marr": "Quill Fen"}}),
                            encoding="utf-8")
            with quiet_env(GITHUB_ACTIONS="true"), self.assertRaises(gc.FatalError) as public:
                gc.load_player_aliases(path)
            self.assertEqual((public.exception.exit_code, public.exception.title),
                             (gc.EXIT_CONFIG, "Player alias file malformed"))
            self.assertIn("aliases entry 1: the official name is itself an alias", str(public.exception))
            self.assertNotRegex(str(public.exception), "Tovo|Ilse|Quill")  # public log: no names
            with quiet_env(), self.assertRaises(gc.FatalError) as local:
                gc.load_player_aliases(path)
            self.assertIn("'Tovo Wren'", str(local.exception))

    def test_the_repo_alias_file_is_valid(self) -> None:
        """packages/server/player_aliases.json (owner-directed): loads, and every official name is a
        name nobody is an alias of."""
        aliases = gc.load_player_aliases(gc.ALIASES_PATH)
        self.assertTrue(aliases.names)
        doc = json.loads(gc.ALIASES_PATH.read_text(encoding="utf-8"))
        self.assertIsInstance(doc.get("_comment"), str)
        for target_key in aliases.official:
            self.assertNotIn(target_key, aliases.keys)

    def test_two_old_names_merge_into_the_official_name(self) -> None:
        """Typed under two old names (and the official one in lower case) or always as the official
        name: the same cache, byte for byte, except players.aliases."""
        chemistry = name_chemistry(["QUILL FEN", "KITE", "丙"])
        typed = build_named(name_log(alias_names), chemistry, sample_aliases())
        clean = build_named(name_log(official_names), name_chemistry(["Ilse Marr", "kite", "丙"]))
        self.assertEqual(typed["players"].pop("aliases"), {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"})
        self.assertNotIn("aliases", clean["players"])
        self.assertEqual(json.dumps(typed, ensure_ascii=False, sort_keys=True),
                         json.dumps(clean, ensure_ascii=False, sort_keys=True))
        rows = {p["name"]: p for p in typed["players"]["players"]}
        self.assertEqual(rows["Ilse Marr"]["totalGames"], 110.0)  # the official spelling, not the most-written
        self.assertFalse({"Tovo Wren", "Quill Fen", "ilse marr", "TOVO WREN"} & set(rows))
        self.assertEqual(typed["chemistry"]["coWin"]["players"], ["Ilse Marr", "kite", "丙"])

        games = gc.parse_game_log(name_log(alias_names))
        merged, names = gc.canonicalize_player_names(games, sample_aliases())
        self.assertEqual({g.seat_players["1"] for g in merged if g.id.startswith("S")}, {"Ilse Marr"})
        self.assertEqual((names.aliased_names, names.aliased_players), (2, 1))  # tovo wren, quill fen
        self.assertEqual((names.merged_players, names.merged_spellings), (2, 2))  # Tovo Wren / TOVO WREN, kite / KITE
        self.assertEqual(names.summary(), "2 spelling(s) that differ only by letter case / full- or half-width "
                                          "folded into 2 player(s); 2 name(s) shown under their official name "
                                          "(player_aliases.json, 1 player(s))")
        self.assertEqual(names.aliases, {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"})
        self.assertEqual(names.display["quill fen"], "Ilse Marr")
        again, names2 = gc.canonicalize_player_names(merged, sample_aliases())  # idempotent
        self.assertIs(again, merged)
        self.assertEqual((names2.aliased_names, names2.aliases), (0, names.aliases))
        _, plain = gc.canonicalize_player_names(games)  # without aliases: three players
        self.assertEqual(plain.aliased_names, 0)
        self.assertEqual(len({plain.display[gc.player_name_key(g.seat_players["1"])] for g in games
                              if g.id.startswith("S")}), 3)

    def test_rename_only_and_aliases_of_absent_players(self) -> None:
        """Only an old name in the games: the player is shown under the official one. An alias whose
        player has no game stays out of players.aliases."""
        aliases = gc.parse_player_aliases({"aliases": {"Tovo Wren": "Ilse Marr", "Zed Ash": "Orla Pike"}})
        cache = build_named(name_log(lambda i: ["Tovo Wren"] + variant_names(i)[1:]), name_chemistry(["丙"]), aliases)
        names = [p["name"] for p in cache["players"]["players"]]
        self.assertIn("Ilse Marr", names)
        self.assertNotIn("Tovo Wren", names)
        self.assertEqual(cache["players"]["aliases"], {"Tovo Wren": "Ilse Marr"})
        nobody = build_named(name_log(variant_names), name_chemistry(["丙"]), aliases)
        self.assertNotIn("aliases", nobody["players"])

    def test_old_and_official_name_in_one_game_is_one_player_twice(self) -> None:
        def doubled(i: int) -> list[str]:
            names = official_names(i)
            return names[:2] + (["Tovo Wren"] if i == 0 else names[2:3]) + names[3:]
        _, names = gc.canonicalize_player_names(gc.parse_game_log(name_log(doubled)), sample_aliases())
        self.assertEqual(names.doubled_games, 1)

    def test_guard_passes_when_an_alias_merges_a_player(self) -> None:
        """The first refresh after an alias was added: the existing file has the old names as players
        of their own; the new one has one row under the official name and players.aliases."""
        prev = fake_cache(players=12)
        prev["players"]["players"] += [{"name": n, "totalGames": g} for n, g in
                                       (("Tovo Wren", 40.0), ("Quill Fen", 3.0), ("Ilse Marr", 5.0))]
        prev["overview"]["totalPlayers"] = prev["players"]["total"] = 15
        new = fake_cache(players=12)
        new["players"]["players"].append({"name": "Ilse Marr", "totalGames": 49.0})  # one new game
        new["players"]["aliases"] = {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"}
        new["overview"]["totalPlayers"] = new["players"]["total"] = 13
        self.assertEqual(gc.games_regressions(new, prev), [])
        self.assertEqual(gc.distinct_players(prev, gc.cache_aliases(new)), 13)
        self.assertEqual(gc.validate_new_cache(new, prev), [])
        self.assertEqual(gc.validate_new_cache(new, prev, show_names=False), [])
        lines = gc.compare_summary(new, prev, show_names=False)
        self.assertIn("依 player_aliases.json 併入正式名字的舊名字 2 個", lines[1])
        self.assertNotIn("消失", lines[1])
        self.assertNotRegex("\n".join(lines), "Tovo|Quill|Ilse")
        self.assertIn("| 1 | 48 → 49 |", "\n".join(lines))  # her games before: the three rows summed

        new["players"]["players"][-1]["totalGames"] = 47.0  # a game lost on top of the merge: refused
        self.assertEqual(gc.games_regressions(new, prev), [("Tovo Wren", 48.0, 47.0)])
        self.assertTrue(gc.validate_new_cache(new, prev))
        new["players"]["players"][-1]["totalGames"] = 49.0
        del new["players"]["aliases"]  # the same rows without the alias: the old names are lost players
        problem = next(p for p in gc.validate_new_cache(new, prev) if "existing player" in p)
        self.assertIn("Tovo Wren 40→gone", problem)

    def test_guard_follows_an_alias_turned_around(self) -> None:
        """The owner makes the old name the official one again: either cache's players.aliases link them."""
        prev = fake_cache(players=3)
        prev["players"]["players"].append({"name": "Ilse Marr", "totalGames": 48.0})
        prev["players"]["aliases"] = {"Tovo Wren": "Ilse Marr"}
        new = fake_cache(players=3)
        new["players"]["players"].append({"name": "Tovo Wren", "totalGames": 48.0})
        new["players"]["aliases"] = {"Ilse Marr": "Tovo Wren"}
        self.assertEqual(gc.games_regressions(new, prev), [])
        self.assertEqual(gc.cache_aliases(prev, new).identity_key("Ilse Marr"),
                         gc.cache_aliases(prev, new).identity_key("tovo wren"))
        junk = {"players": {"aliases": {"Tovo Wren": 3, "": "Ilse Marr", "Nova": "NOVA"}}}
        self.assertEqual(dict(gc.cache_aliases(junk, None, {"players": "x"}).keys), {})  # lenient

    def test_carried_rows_of_an_old_name_follow_the_alias(self) -> None:
        prev = fake_cache(players=1)
        prev["archetype"] = {"perPlayer": {
            "Tovo Wren": {"hasData": True, "sampleSize": 40},
            "Ilse Marr": {"hasData": True, "sampleSize": 5},
            "Quill Fen": {"hasData": False, "sampleSize": 3},
        }}
        new = fake_cache(players=1)
        new["playerDetails"] = {"Ilse Marr": {"player": {"totalGames": 49.0}}}
        new["players"]["aliases"] = {"Tovo Wren": "Ilse Marr", "Quill Fen": "Ilse Marr"}
        carried = gc.carry_over_sections(new, prev, {"archetype": placeholder})
        self.assertEqual(carried["archetype"], 0)
        self.assertEqual(new["archetype"]["perPlayer"], {"Ilse Marr": {"hasData": True, "sampleSize": 40}})


class LeaderboardConfigTest(unittest.TestCase):
    """The knobs of LEADERBOARD_CONFIG: the owner's real values, and that changing one flows through
    to every reader (the doc tells Edward he may)."""

    def test_the_real_config_is_usable(self) -> None:
        cfg = REAL_LEADERBOARD_CONFIG
        self.assertEqual(set(cfg), set(TEST_LEADERBOARD_CONFIG))  # same knobs; the values are the owner's
        for key, value in cfg.items():
            with self.subTest(key=key):
                self.assertIsInstance(value, int)
                self.assertGreaterEqual(value, 1 if key in ("topN", "mainGames", "roleWindowGames", "loyalWindowGames") else 0)
        with mock.patch.dict(gc.LEADERBOARD_CONFIG, REAL_LEADERBOARD_CONFIG, clear=True):
            cache = build_fresh(leaderboard_log())
            windows = gc.theory_windows()
        self.assertEqual(gc.validate_new_cache(cache, None), [])
        self.assertEqual(cache["leaderboard"]["config"], {"theoryWindows": windows, **REAL_LEADERBOARD_CONFIG})
        self.assertEqual(cache["overview"]["theoryConfig"]["theoryWindows"], windows)
        for row in cache["players"]["players"]:
            self.assertEqual(list(row["theory"]), ["roleWindows"] + [gc.theory_key(n) for n in windows] + ["career"])
            self.assertEqual({r: c["window"] for r, c in row["theory"]["roleWindows"]["roles"].items()},
                             cache["overview"]["theoryConfig"]["roleWindowGames"])

    def test_windows_follow_main_games(self) -> None:
        self.assertEqual(gc.theory_windows(), [100])
        self.assertEqual(gc.theory_windows({"mainGames": 0}), [])
        with config_patch(mainGames=80):
            cache = build_fresh(leaderboard_log())
        rows = {p["name"]: p for p in cache["players"]["players"]}
        self.assertEqual(list(rows["甲"]["theory"]), ["roleWindows", "last80", "career"])
        self.assertEqual(cache["leaderboard"]["config"]["theoryWindows"], [80])
        self.assertEqual(cache["overview"]["theoryConfig"], {
            "theoryMinCellGames": 5, "theoryWindows": [80], "mainGames": 80, "activeDays": 90,
            "roleWindowGames": {r: 40 if r == "忠臣" else 10 for r in ROLE_ORDER}, "positionGames": 80, "overallMinGames": 250,
        })
        position = next(b for b in cache["leaderboard"]["boards"] if b["id"] == "position")
        self.assertEqual((position["period"], position["windowGames"], position["minGames"]), ("各人最近 80 場", 80, 80))
        jia = next(r for r in position["rows"] if r["name"] == "甲")
        self.assertEqual(jia["positionTheory"], rows["甲"]["theory"]["last80"]["positionTheory"])
        top = cache["overview"]["topPlayersByPositionTheory"]  # still filled: it reads last<mainGames>
        self.assertEqual(len(top), 10)
        for r in top:
            self.assertEqual((r["positionTheory"], r["games"]), (rows[r["name"]]["theory"]["last80"]["positionTheory"], 80))
        self.assertEqual(gc.validate_new_cache(cache, None), [])

    def test_top_up_off(self) -> None:
        """theoryMinCellGames = 0: the numbers, the board notes and overview.theoryConfig all follow."""
        with config_patch(theoryMinCellGames=0):
            cache = build_fresh(leaderboard_log())
            seats = gc.player_timelines(gc.parse_game_log(leaderboard_log()))["甲"]
            overview = cache["overview"]
            expected = gc.theory_window(seats[-100:], overview["roleFinalWinRates"], overview["seatFinalWinRates"], 0, 100)
        self.assertEqual(overview["theoryConfig"]["theoryMinCellGames"], 0)
        self.assertEqual(cache["leaderboard"]["config"]["theoryMinCellGames"], 0)
        position = next(b for b in cache["leaderboard"]["boards"] if b["id"] == "position")
        self.assertNotIn("補到", position["note"])
        self.assertNotIn("topped up", position["noteEn"])
        jia = next(r for r in position["rows"] if r["name"] == "甲")
        self.assertEqual(jia["positionTheory"], expected["positionTheory"])
        # (Here every played cell has 50+ games, so only the wording changes; TheoryTest checks the
        # numbers of a top-up that matters, with and without it.)
        self.assertEqual(gc.validate_new_cache(cache, None), [])


class OnlyTheDayChangedTest(unittest.TestCase):
    """A run whose only difference from the existing file is the as-of day writes nothing
    (the workflow commits on any byte change, and a commit redeploys the server)."""

    @staticmethod
    def build(log: list[list[str]], as_of: dt.date, previous: dict | None) -> tuple[dict, list]:
        games = gc.parse_game_log(log)
        cache, _ = gc.assemble_cache(
            gc.build_cache(games, {}, as_of), previous,
            strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={}, games=games, as_of=as_of,
        )
        return json.loads(json.dumps(cache, ensure_ascii=False)), games  # as the file is read back

    def test_next_day_same_games(self) -> None:
        previous, games = self.build(leaderboard_log(), AS_OF, None)
        cache, games = self.build(leaderboard_log(), AS_OF + dt.timedelta(days=1), previous)
        self.assertNotEqual(cache, previous)  # asOf, every board's period, generatedAt, computedAt moved on
        self.assertNotEqual([b["period"] for b in cache["leaderboard"]["boards"]], [b["period"] for b in previous["leaderboard"]["boards"]])
        self.assertEqual([b["rows"] for b in cache["leaderboard"]["boards"]], [b["rows"] for b in previous["leaderboard"]["boards"]])
        self.assertTrue(gc.only_the_day_changed(cache, previous, games))
        self.assertTrue(gc.only_the_day_changed(previous, previous, games))  # same day, same file
        self.assertEqual(gc.previous_as_of(previous), AS_OF)

    def test_anything_else_is_a_change(self) -> None:
        previous, _ = self.build(leaderboard_log(), AS_OF, None)
        next_day = AS_OF + dt.timedelta(days=1)
        cache, games = self.build(leaderboard_log() + [dated("N0", "2026/10/13", "三紅")], next_day, previous)  # a new game
        self.assertFalse(gc.only_the_day_changed(cache, previous, games))
        later = AS_OF + dt.timedelta(days=100)
        cache, games = self.build(leaderboard_log(), later, previous)  # nobody active any more: still only the day
        self.assertTrue(gc.only_the_day_changed(cache, previous, games))
        typo = leaderboard_log() + [dated("F0", "2026/12/01", "三紅")]  # after AS_OF (undated then), before `later`
        previous_with_typo, _ = self.build(typo, AS_OF, None)
        cache, games = self.build(typo, later, previous_with_typo)  # the date became valid: lastPlayed moved
        self.assertFalse(gc.only_the_day_changed(cache, previous_with_typo, games))
        cache, games = self.build(leaderboard_log(), next_day, previous)
        edited = copy.deepcopy(previous)
        edited["leaderboard"]["boards"][0]["note"] += "!"  # e.g. a code change to a board's text
        self.assertFalse(gc.only_the_day_changed(cache, edited, games))
        edited = copy.deepcopy(previous)
        edited["players"]["players"][0]["totalGames"] += 1
        self.assertFalse(gc.only_the_day_changed(cache, edited, games))
        # no previous file, or one without a leaderboard asOf (the first run that writes a leaderboard)
        self.assertFalse(gc.only_the_day_changed(cache, None, games))
        stripped = {k: v for k, v in previous.items() if k != "leaderboard"}
        cache, games = self.build(leaderboard_log(), next_day, stripped)
        self.assertFalse(gc.only_the_day_changed(cache, stripped, games))
        self.assertIsNone(gc.previous_as_of(stripped))
        self.assertIsNone(gc.previous_as_of({"leaderboard": {"asOf": "2026/10/12"}}))
        self.assertIsNone(gc.previous_as_of({"leaderboard": "junk"}))
        self.assertIsNone(gc.previous_as_of(None))


# ---------------------------------------------------------------------------
# featureStudies: L141 from the game log, Wilson intervals, annotations
# ---------------------------------------------------------------------------

def L142_FIXTURE() -> dict:
    """The L142 numbers of the 2026-10 committed study, frozen: the wording checks hold on these
    whatever scripts/build_feature_studies.py writes next."""
    rows = [("刺", "Assassin", 100.0, 15), ("忠", "Loyal", 95.43, 394), ("梅", "Merlin", 93.91, 115),
            ("派", "Percival", 92.05, 88), ("德", "Mordred", 84.85, 33), ("奧", "Oberon", 84.62, 13), ("娜", "Morgana", 81.25, 16)]
    cells = [("娜|宣藍|consistent", 12), ("奧|宣藍|consistent", 10), ("梅|宣藍|consistent", 83), ("忠|宣藍|inconsistent", 9), ("刺|宣藍|consistent", 12)]
    return {
        "loopId": "L142", "visualType": "table", "oneLineHook": "old", "takeaway": "old",
        "data": {"rows": [{"role": r, "roleEn": en, "consistencyRate": rate, "total": n} for r, en, rate, n in rows],
                 "highEvCells": [{"label": label, "n": n} for label, n in cells]},
    }


def L136_FIXTURE() -> dict:
    rows = [("梅", "Merlin", 1.57), ("忠", "Loyal", 0.86), ("派", "Percival", 0.08), ("刺", "Assassin", -1.39),
            ("奧", "Oberon", -1.72), ("德", "Mordred", -1.96), ("娜", "Morgana", -2.18)]
    return {"loopId": "L136", "visualType": "divergent", "data": {
        "rows": [{"role": r, "roleEn": en, "signedEv": ev} for r, en, ev in rows],
        "summary": {"blueOverall": 45.35, "redOverall": 43.1, "delta": 2.25},
    }}


def L139_FIXTURE() -> dict:
    return {"loopId": "L139", "visualType": "line", "data": {"baselineRedPct": 46.09, "rows": [
        {"round": "R2", "n": 1829, "threeRedPct": 47.68, "deltaThreeRed": 1.59},
        {"round": "R3", "n": 858, "threeRedPct": 50.58, "deltaThreeRed": 4.5},
    ]}}


def L143_FIXTURE() -> dict:
    return {
        "loopId": "L143", "title": "刺客目標座位偏好", "titleEn": "Assassin Target Seat Preference",
        "oneLineHook": "old", "oneLineHookEn": "old", "sampleSize": {"games": 2146, "attempts": 1130}, "visualType": "bar",
        "data": {"axisLabel": "Hit %", "leaderTierRows": [
            {"tier": "top_leader", "n": 477, "hitRate": 49.06, "missRate": 50.94},
            {"tier": "mid_leader", "n": 368, "hitRate": 42.93, "missRate": 57.07},
            {"tier": "low_leader", "n": 281, "hitRate": 39.15, "missRate": 60.85},
        ]},
        "takeaway": "old", "takeawayEn": "old", "sourceReport": "x.md",
    }


class LakeClaimTest(unittest.TestCase):
    def test_parse_lake_claims(self) -> None:
        text = "157\nooo\n0>2 x\n2>8 o\n6>1x\n4>9 ?\n9>3\n３>５ ｘ\n1>2 O\n2468\noxo\n刺客刺殺:6"
        self.assertEqual(gc.parse_lake_claims(text), [
            ("0", "2", "紅"), ("2", "8", "藍"), ("6", "1", "紅"), ("4", "9", ""), ("9", "3", ""), ("3", "5", "紅"), ("1", "2", "藍"),
        ])
        self.assertEqual(gc.parse_lake_claims(""), [])
        self.assertEqual(gc.parse_lake_claims("12>3 x\n1>23 o"), [])  # not single seats: not lake lines

    def test_wilson_interval(self) -> None:
        self.assertEqual(gc.wilson_interval(0, 0), (0.0, 0.0))
        self.assertEqual(gc.wilson_interval(50, 100), (40.4, 59.6))
        self.assertEqual(gc.wilson_interval(30, 30), (88.6, 100.0))
        self.assertEqual(gc.wilson_interval(0, 10), (0.0, 27.8))
        low, high = gc.wilson_interval(363, 513)
        self.assertTrue(low < 70.8 < high and high - low < 10, (low, high))

    def test_lake_claim_feature_small_fixture(self) -> None:
        # 配置 123456: seats 1-4 red, 5-0 blue.
        log = [
            LOG_HEADERS,
            log_row("G1", "123456", "三紅", SEAT_NAMES, text="7>1 x\n1>2 o\n2>7 x"),  # blue says red: hit; red says blue: miss; red says red: miss
            log_row("G2", "123456", "三藍活", SEAT_NAMES, text="8>5 o\n5>3\n3>9 X"),  # blue says blue: hit; undeclared; red says red: miss
            log_row("G3", "123456", "三藍死", SEAT_NAMES, text="9>4 x"),  # blue says red: hit
        ]
        f = gc.compute_lake_claim_feature(gc.parse_game_log(log), AS_OF)
        self.assertEqual((f["loopId"], f["visualType"], f["sourceReport"], f["computedAt"]), ("L141", "lakeClaim", "generate_cache.py", "2026-10-12"))
        self.assertEqual((f["title"], f["titleEn"]), ("湖中宣告可信度", "Lake claim reliability"))
        self.assertEqual(f["sampleSize"], {"games": 3, "links": 7})
        self.assertEqual(f["data"]["minSample"], 30)
        self.assertEqual(f["data"]["undeclared"], 1)
        cells = {(r["lake"], r["declared"]): (r["n"], r["hits"], r["hitRate"], r["lowSample"]) for r in f["data"]["rows"]}
        self.assertEqual(cells, {
            ("首湖", "紅"): (2, 2, 100.0, True), ("首湖", "藍"): (1, 1, 100.0, True),
            ("二湖", "紅"): (0, 0, 0.0, True), ("二湖", "藍"): (1, 0, 0.0, True),
            ("三湖", "紅"): (2, 0, 0.0, True), ("三湖", "藍"): (0, 0, 0.0, True),
        })
        self.assertEqual([(r["lakeEn"], r["declaredEn"]) for r in f["data"]["rows"]][:2], [("Lake 1", "evil"), ("Lake 1", "good")])
        holders = {(r["holder"], r["declared"]): (r["n"], r["hits"]) for r in f["data"]["holderRows"]}
        self.assertEqual(holders, {("藍", "紅"): (2, 2), ("藍", "藍"): (1, 1), ("紅", "紅"): (2, 0), ("紅", "藍"): (1, 0)})
        for r in f["data"]["rows"] + f["data"]["holderRows"]:
            self.assertEqual((r["ciLow"], r["ciHigh"]), gc.wilson_interval(r["hits"], r["n"]))
            self.assertTrue(r["ciLow"] <= r["hitRate"] <= r["ciHigh"])
        self.assertIn("首湖 100.0%（n=2）", f["oneLineHook"])
        self.assertIn("樣本不足", f["oneLineHook"])
        self.assertIn("Lake 1 100.0% (n=2)", f["oneLineHookEn"])
        self.assertIn("藍方持湖幾乎不說謊（說紅 100.0%、說藍 100.0% 屬實）", f["takeaway"])
        self.assertIn("紅方持湖宣告的可信度只有約 0%", f["takeaway"])
        self.assertIn("n=3", f["takeaway"])
        self.assertIn("judge the holder's side first", f["takeawayEn"])


class AnnotationTextTest(unittest.TestCase):
    """What annotate_feature_studies writes, on frozen numbers (L142/L136/L139/L143_FIXTURE)."""

    @staticmethod
    def annotate(fixture: dict) -> dict:
        return gc.annotate_feature_studies({"features": [fixture]})["features"][0]

    def test_l142(self) -> None:
        l142 = self.annotate(L142_FIXTURE())
        self.assertEqual([(r["role"], r["lowSample"]) for r in l142["data"]["rows"] if r["lowSample"]],
                         [("刺", True), ("奧", True), ("娜", True)])
        self.assertEqual([c["lowSample"] for c in l142["data"]["highEvCells"]], [True, True, False, True, True])
        self.assertEqual(l142["oneLineHook"], "言行一致率，每格附 n：忠臣 95%（n=394）、梅林 94%（n=115）、派西維爾 92%（n=88）、"
                                              "莫德雷德 85%（n=33）；樣本不足（n < 30）：刺客 100%（n=15）、奧伯倫 85%（n=13）、莫甘娜 81%（n=16）")
        self.assertIn("「刺客 100% 言行一致」只是 15 筆的巧合", l142["takeaway"])
        self.assertIn("85%～95%", l142["takeaway"])
        self.assertIn("Assassin 100% (n=15)", l142["oneLineHookEn"])
        self.assertIn("small samples (n < 30)", l142["oneLineHookEn"])
        self.assertIn("15-case coincidence", l142["takeawayEn"])
        enough = L142_FIXTURE()
        for r in enough["data"]["rows"]:
            r["total"] = 50
        l142 = self.annotate(enough)
        self.assertFalse(any(r["lowSample"] for r in l142["data"]["rows"]))
        self.assertNotIn("樣本不足", l142["oneLineHook"])
        self.assertIn("81%～100%", l142["takeaway"])

    def test_l143(self) -> None:
        l143 = self.annotate(L143_FIXTURE())
        self.assertIn("49%（n=477）", l143["oneLineHook"])
        self.assertIn("39%（n=281）", l143["oneLineHook"])
        self.assertIn("座位輪替", l143["oneLineHook"])
        self.assertIn("不是玩家主動程度的指標", l143["takeaway"])
        self.assertIn("seat rotation", l143["takeawayEn"])
        self.assertEqual(l143["data"], L143_FIXTURE()["data"])  # numbers untouched

    def test_l136(self) -> None:
        l136 = self.annotate(L136_FIXTURE())
        self.assertEqual(l136["oneLineHook"], "各角色改隊後的翻票率差距只有 +1.6pp（梅林）～ -2.2pp（莫甘娜），差距很小")
        self.assertIn("only +1.6pp (Merlin) to -2.2pp (Morgana)", l136["oneLineHookEn"])
        self.assertIn("不足以當判斷依據", l136["takeaway"])
        self.assertIn("只差 2.2pp", l136["takeaway"])

    def test_l139(self) -> None:
        l139 = self.annotate(L139_FIXTURE())
        self.assertEqual(l139["oneLineHook"], "R3 出現 forced P5 的局三紅率 50.6%（n=858），比基準 46.1% 高 4.5pp；但這是選擇偏誤，不是因果")
        self.assertIn("結果", l139["takeaway"])
        self.assertIn("不是「紅方在掩護」的證據", l139["takeaway"])
        self.assertIn("selection bias", l139["oneLineHookEn"])
        below = L139_FIXTURE()
        below["data"]["rows"][1].update({"threeRedPct": 40.0, "deltaThreeRed": -6.09})
        self.assertIn("比基準 46.1% 低 6.1pp", self.annotate(below)["oneLineHook"])


class FeatureStudiesTest(unittest.TestCase):
    """The committed studies: structure and idempotence only; their numbers change whenever the
    owner reruns scripts/build_feature_studies.py, so no literal from them is asserted here."""

    @classmethod
    def setUpClass(cls) -> None:
        if not COMMITTED_CACHE.exists():
            raise unittest.SkipTest(f"{COMMITTED_CACHE.name} not found")
        cls.section = json.loads(COMMITTED_CACHE.read_text(encoding="utf-8")).get("featureStudies") or {}
        if {f.get("loopId") for f in cls.section.get("features", [])} < {"L142", "L143", "L136", "L139"}:
            raise unittest.SkipTest("the committed featureStudies lack the carried-over studies")

    def test_annotate_is_pure_idempotent_and_keeps_numbers(self) -> None:
        before = json.dumps(self.section, sort_keys=True)
        once = gc.annotate_feature_studies(self.section)
        self.assertEqual(json.dumps(self.section, sort_keys=True), before)  # input untouched
        self.assertEqual(gc.annotate_feature_studies(once), once)
        self.assertEqual(list(once), list(self.section))
        self.assertEqual(once["sampleSize"], self.section["sampleSize"])
        originals = {f["loopId"]: f for f in self.section["features"]}

        def numbers(data: object) -> object:  # everything but the lowSample flags
            if isinstance(data, dict):
                return {k: numbers(v) for k, v in data.items() if k != "lowSample"}
            if isinstance(data, list):
                return [numbers(v) for v in data]
            return data

        texts = ("oneLineHook", "oneLineHookEn", "takeaway", "takeawayEn")
        for f in once["features"]:
            with self.subTest(loop=f["loopId"]):
                original = originals[f["loopId"]]
                self.assertEqual(numbers(f["data"]), numbers(original["data"]))
                self.assertEqual({k: v for k, v in f.items() if k not in texts + ("data",)},
                                 {k: v for k, v in original.items() if k not in texts + ("data",)})
                if f["loopId"] in gc._FEATURE_ANNOTATORS:
                    for key in texts:
                        self.assertTrue(isinstance(f[key], str) and f[key], key)
                    self.assertNotEqual(f["takeaway"], f["takeawayEn"])
                    self.assertEqual(f, gc.annotate_feature_studies({"features": [original]})["features"][0])
                else:
                    self.assertEqual(f, original)  # L141 (and anything unknown) is not annotated here
        # The owner's build_feature_studies.py text is replaced: the old conclusions never survive a run.
        stale = {"loopId": "L143", "data": L143_FIXTURE()["data"], "takeaway": "刺客模仿模式: 鎖隊長多", "takeawayEn": "x"}
        self.assertNotIn("模仿", gc.annotate_feature_studies({"features": [stale]})["features"][0]["takeaway"])

    def test_annotations_follow_the_committed_numbers(self) -> None:
        """Whatever numbers the committed studies hold, the text names them (wording: AnnotationTextTest)."""
        studies = {f["loopId"]: f for f in gc.annotate_feature_studies(self.section)["features"]}
        l142 = studies["L142"]
        for r in l142["data"]["rows"]:
            self.assertEqual(r["lowSample"], r["total"] < gc.LAKE_CLAIM_MIN_SAMPLE)
            self.assertIn(f"{gc._role_name(r)} {r['consistencyRate']:.0f}%（n={r['total']}）", l142["oneLineHook"])
        for c in l142["data"]["highEvCells"]:
            self.assertEqual(c["lowSample"], c["n"] < gc.LAKE_CLAIM_MIN_SAMPLE)
        self.assertEqual("樣本不足" in l142["oneLineHook"], any(r["lowSample"] for r in l142["data"]["rows"]))
        l143 = studies["L143"]
        top = next(r for r in l143["data"]["leaderTierRows"] if r["tier"] == "top_leader")
        self.assertIn(f"{top['hitRate']:.0f}%（n={top['n']}）", l143["oneLineHook"])
        self.assertIn("座位輪替", l143["oneLineHook"])
        l136 = studies["L136"]
        evs = [r["signedEv"] for r in l136["data"]["rows"]]
        self.assertIn(f"{max(evs):+.1f}pp", l136["oneLineHook"])
        self.assertIn(f"{min(evs):+.1f}pp", l136["oneLineHook"])
        self.assertIn(f"只差 {l136['data']['summary']['delta']:.1f}pp", l136["takeaway"])
        l139 = studies["L139"]
        r3 = next(r for r in l139["data"]["rows"] if r["round"] == "R3")
        self.assertIn(f"{r3['threeRedPct']:.1f}%（n={r3['n']}）", l139["oneLineHook"])
        self.assertIn("選擇偏誤", l139["oneLineHook"])

    def test_annotate_tolerates_odd_sections(self) -> None:
        self.assertEqual(gc.annotate_feature_studies(None), {})
        odd = {"features": [{"loopId": "L142", "data": {"rows": [{"role": "刺", "total": 3}]}}, "junk", {"loopId": "L999", "x": 1}]}
        out = gc.annotate_feature_studies(odd)
        self.assertTrue(out["features"][0]["data"]["rows"][0]["lowSample"])
        self.assertIn("takeaway", out["features"][0])
        self.assertEqual(out["features"][1:], ["junk", {"loopId": "L999", "x": 1}])

    def test_refresh_replaces_l141_in_place_and_stamps_the_run(self) -> None:
        games = gc.parse_game_log(aggregation_log())
        fresh = gc.refresh_feature_studies(None, games, AS_OF)
        self.assertEqual(list(fresh), ["generatedAt", "sampleSize", "features"])
        self.assertEqual(fresh["generatedAt"], "2026-10-12")
        self.assertEqual(fresh["sampleSize"], {"games": 5, "lakeLinks": 5})  # every fixture game has one lake line
        self.assertEqual([f["loopId"] for f in fresh["features"]], ["L141"])

        previous = {"generatedAt": "old", "sampleSize": {"games": 1, "lakeLinks": 1, "extra": 7}, "note": "keep",
                    "features": [L143_FIXTURE(), {"loopId": "L141", "visualType": "bar", "data": {"rows": []}}, {"loopId": "L999"}]}
        out = gc.refresh_feature_studies(previous, games, AS_OF)
        self.assertEqual(list(out), ["generatedAt", "sampleSize", "note", "features"])
        self.assertEqual(out["sampleSize"], {"games": 5, "lakeLinks": 5, "extra": 7})
        self.assertEqual([f["loopId"] for f in out["features"]], ["L143", "L141", "L999"])
        self.assertEqual(out["features"][1]["visualType"], "lakeClaim")
        self.assertIn("座位輪替", out["features"][0]["oneLineHook"])
        self.assertEqual(out["features"][2], {"loopId": "L999"})
        self.assertEqual(previous["features"][0]["oneLineHook"], "old")  # previous untouched

        committed = gc.refresh_feature_studies(self.section, games, AS_OF)
        self.assertEqual([f["loopId"] for f in committed["features"]], [f["loopId"] for f in self.section["features"]])


# ---------------------------------------------------------------------------
# The whole thing on the checked-in 牌譜 snapshot (shape and a few fixed numbers)
# ---------------------------------------------------------------------------

class SnapshotShapeTest(unittest.TestCase):
    """sheets_cache.json: 2146 games dated up to 2026-02-27, 63 with the 1900/01/01 placeholder."""

    AS_OF = dt.date(2026, 3, 1)  # the day after the snapshot's last game; February 2026 is "last month"

    @classmethod
    def setUpClass(cls) -> None:
        if not (SNAPSHOT.exists() and COMMITTED_CACHE.exists()):
            raise unittest.SkipTest("sheets_cache.json or analysis_cache.json not found")
        log = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("牌譜") or []
        cls.games = gc.parse_game_log(log)
        if len(cls.games) != 2146:
            raise unittest.SkipTest("sheets_cache.json is not the 2146-game snapshot")
        previous = json.loads(COMMITTED_CACHE.read_text(encoding="utf-8"))
        cls.committed_loop_ids = {f["loopId"] for f in (previous.get("featureStudies") or {}).get("features") or []}
        chemistry = {k: v for k, v in previous["chemistry"].items() if k != "outcomePair"}
        cls.cache, _ = gc.assemble_cache(
            gc.build_cache(cls.games, chemistry, cls.AS_OF), previous,
            strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={}, games=cls.games, as_of=cls.AS_OF,
        )

    def test_overview_stages(self) -> None:
        ov = self.cache["overview"]
        self.assertEqual(ov["missionStage"], {"games": 2146, "threeRed": 971, "threeBlue": 1175, "redPct": 45.2, "bluePct": 54.8})
        self.assertEqual(ov["assassinationStage"], {"games": 1175, "merlinKilled": 516, "merlinSurvived": 659, "killPct": 43.9, "survivePct": 56.1})
        self.assertEqual(ov["final"], {"games": 2146, "redWins": 1487, "blueWins": 659, "redPct": 69.3, "bluePct": 30.7})
        self.assertEqual(list(ov["roleFinalWinRates"]), ROLE_ORDER)
        self.assertTrue(all(ov["roleFinalWinRates"][r] > 60 for r in RED_ROLES))
        self.assertEqual(len(ov["topPlayersByExcess"]), 10)
        self.assertTrue(all(t["games"] >= gc.MIN_GAMES_THRESHOLD for t in ov["topPlayersByExcess"]))
        self.assertEqual(list(ov["topPlayersByExcess"][0]), ["name", "excessWinRate", "finalWinRate", "expectedFinalWinRate", "games"])

    def test_player_rows(self) -> None:
        rows = self.cache["players"]["players"]
        role_rates = self.cache["overview"]["roleFinalWinRates"]
        self.assertTrue(all(list(r) == ALL_PLAYER_FIELDS for r in rows))
        self.assertEqual(gc.theory_mismatches(self.cache), [])
        for row in rows:
            self.assertTrue(row["firstPlayed"] <= row["lastPlayed"])
            self.assertEqual(row["excessWinRate"], rnd1(row["finalWinRate"] - row["expectedFinalWinRate"]))
            self.assertEqual(row["expectedFinalWinRate"],
                             rnd1(sum(row["rawRoleGames"][r] * role_rates[r] for r in ROLE_ORDER) / row["totalGames"]))
        self.assertEqual(self.cache["playerDetails"][rows[0]["name"]]["player"]["finalWinRate"], rows[0]["finalWinRate"])
        self.assertEqual(gc.validate_new_cache(self.cache, None), [])

    def test_leaderboard(self) -> None:
        lb = self.cache["leaderboard"]
        self.assertEqual(lb["dates"], {"parsed": 2083, "unparsed": 63, "earliest": "2017-02-13", "latest": "2026-02-27"})
        boards = {b["id"]: b for b in lb["boards"]}
        # 32 players active since 2025-12-02 (171 in all): 22 of them have full role windows (35 in all),
        # 23 have 100 career games, 18 have 250 (24 in all). One newcomer: first game 2025-09-12, before the
        # 90 days, but the 10th game on 2025-12-18 (Edward 2026-10-26: newcomers go by the day they reach 10).
        self.assertEqual(list(boards), ["main", "position", "overall", "theory", "improved", "assassin", "newcomers",
                                        "roleTitles"])
        self.assertEqual([(r["games"], r["firstPlayed"], r["qualifiedOn"]) for r in boards["newcomers"]["rows"]],
                         [(21, "2025-09-12", "2025-12-18")])
        rows = {p["name"]: p for p in self.cache["players"]["players"]}
        self.assertEqual(sum(p["theory"]["roleWindows"]["fullWindows"] for p in rows.values()), 35)
        for board_id in ("main", "position", "overall"):
            self.assertEqual(len(boards[board_id]["rows"]), 10)
            for r in boards[board_id]["rows"]:
                self.assertGreaterEqual(r["to"], "2025-12-02")  # active
        for r in boards["main"]["rows"]:
            rw = rows[r["name"]]["theory"]["roleWindows"]
            self.assertTrue(rw["fullWindows"])
            self.assertEqual((r["roleTheory"], r["games"], r["sparseRoles"]), (rw["roleTheory"], 100, 0))
        for r in boards["position"]["rows"]:
            self.assertEqual((r["games"], r["value"]), (100, rows[r["name"]]["theory"]["last100"]["positionTheory"]))
            self.assertGreaterEqual(r["careerGames"], 100)
        for r in boards["overall"]["rows"]:
            self.assertEqual(r["value"], rows[r["name"]]["theory"]["career"]["overallTheory"])
            self.assertGreaterEqual(r["careerGames"], 250)
        for r in boards["improved"]["rows"]:
            self.assertGreater(r["value"], 0)
            self.assertEqual((r["recentGames"], r["priorGames"]), (100, 100))
        for r in boards["assassin"]["rows"]:
            self.assertTrue(10 <= r["attempts"] <= 20)
            self.assertEqual(r["value"], pct(r["hits"], r["attempts"]))
        # 角色王 (ties 各給, 2026-10-14): 莫甘娜 and 莫德雷德 (18 of 20 each) and 忠臣 (9 of 20) have two
        # holders each -- until then the one with more games in the role won -- so 10 rows, 5 players.
        titles = boards["roleTitles"]["rows"]
        self.assertEqual([r["role"] for r in titles],
                         ["刺客", "莫甘娜", "莫甘娜", "莫德雷德", "莫德雷德", "奧伯倫", "派西維爾", "梅林", "忠臣", "忠臣"])
        self.assertEqual([r["value"] for r in titles], [90.0] * 6 + [45.0, 50.0, 45.0, 45.0])
        self.assertEqual(len({r["name"] for r in titles}), 5)
        for role in ROLE_ORDER:
            holders = [r for r in titles if r["role"] == role]
            self.assertEqual(len({r["value"] for r in holders}), 1)
            keys = [(-r["games"], -r["careerRoleGames"], r["name"]) for r in holders]
            self.assertEqual(keys, sorted(keys))
        ov = self.cache["overview"]
        top = ov["topPlayersByRoleTheory"]
        self.assertEqual(len(top), 10)
        self.assertTrue(all(t["careerGames"] >= 100 and t["games"] == 100 for t in top))
        self.assertTrue(all(t["careerGames"] >= 100 for t in ov["topPlayersByPositionTheory"]))
        self.assertTrue(all(t["careerGames"] >= 250 for t in ov["topPlayersByOverallTheory"]))
        self.assertEqual((len(ov["topPlayersByPositionTheory"]), len(ov["topPlayersByOverallTheory"])), (10, 10))
        # The population baseline: Σ deal probability x role final win rate ≈ 46%.
        ov = self.cache["overview"]
        baseline = sum(gc.ROLE_DEAL_TENTHS[r] * ov["roleFinalWinRates"][r] for r in ROLE_ORDER) / 10
        self.assertAlmostEqual(baseline, 46.1, delta=0.1)
        self.assertEqual(list(ov["seatFinalWinRates"]), [str(i) for i in range(1, 11)])

    def test_feature_studies(self) -> None:
        studies = self.cache["featureStudies"]
        self.assertEqual((studies["generatedAt"], studies["sampleSize"]["games"], studies["sampleSize"]["lakeLinks"]), ("2026-03-01", 2146, 4073))
        loop_ids = [f["loopId"] for f in studies["features"]]
        self.assertEqual(set(loop_ids), {"L141"} | self.committed_loop_ids)  # the committed order is kept, whatever it is
        self.assertEqual(len(loop_ids), len(set(loop_ids)))
        l141 = next(f for f in studies["features"] if f["loopId"] == "L141")
        rows = l141["data"]["rows"]
        self.assertEqual(sum(r["n"] for r in rows), 3990)
        self.assertEqual(l141["data"]["undeclared"], 83)
        self.assertFalse(any(r["lowSample"] for r in rows))
        first_red = next(r for r in rows if r["lake"] == "首湖" and r["declared"] == "紅")
        self.assertEqual((first_red["n"], first_red["hitRate"], first_red["ciLow"], first_red["ciHigh"]), (513, 70.8, 66.7, 74.5))
        holders = {(r["holder"], r["declared"]): r["hitRate"] for r in l141["data"]["holderRows"]}
        self.assertGreater(min(holders[("藍", "紅")], holders[("藍", "藍")]), 98.0)  # blue holders do not lie
        self.assertIn("首湖 70.8%（n=513）", l141["oneLineHook"])


class PlayerVotingTest(unittest.TestCase):
    """虛構三局：R3 每局四次有效提議加一次強制派隊，逐票手算。"""

    NAMES = ["Ilse Marr", "Fenn Pike", "Daro Yew", "Neri Moss", "Oren Vale",
             "Sela Brook", "Tovo Wren", "Jori Vale", "Quill Fen", "Vela Reed"]
    TEXT = "789\nooo\n1789 1- 0+\noooo\n1789\n7890\n1789 7- 0+\n7890 0-\n1789\noooo"

    def games(self, n: int = 3, text: str | None = None) -> list[gc.GameRow]:
        return gc.parse_game_log([LOG_HEADERS] + [
            log_row(str(i), "123456", "三藍活", self.NAMES, date="2026-01-02", text=text or self.TEXT)
            for i in range(n)])

    def test_hand_count_denominators_forced_fifth_and_pr(self) -> None:
        rows = gc.compute_player_voting(self.games())
        loyal = rows["Tovo Wren"]
        self.assertEqual(loyal["r3Reject"]["loyal"],
                         {"hits": 3, "votes": 12, "rate": 25.0, "pr": 62.5, "cohortPlayers": 4})
        self.assertEqual(rows["Ilse Marr"]["r3Reject"]["red"],
                         {"hits": 6, "votes": 12, "rate": 50.0, "pr": 12.5, "cohortPlayers": 4})
        for window, evil, good in (("r3Plus", (3, 6), (6, 6)), ("all", (3, 9), (9, 9))):
            self.assertEqual(tuple(loyal["teamComposition"][window]["evilTeamReject"][k] for k in ("hits", "votes")), evil)
            self.assertEqual(tuple(loyal["teamComposition"][window]["goodTeamApprove"][k] for k in ("hits", "votes")), good)
        self.assertEqual(rows["Sela Brook"]["r3Reject"]["loyal"]["votes"], 0)  # 梅林不混入忠臣
        self.assertEqual(rows["Oren Vale"]["r3Reject"]["loyal"]["votes"], 0)  # 派西維爾亦同

    def test_nine_and_ten_votes_threshold(self) -> None:
        games = self.games(10, "789\nooo\n1789\noooo\n1789\noooo")
        nine = gc.compute_player_voting(games[:9])["Tovo Wren"]["r3Reject"]["loyal"]
        ten = gc.compute_player_voting(games)["Tovo Wren"]["r3Reject"]["loyal"]
        self.assertEqual((nine["votes"], nine["rate"], nine["pr"]), (9, None, None))
        self.assertEqual((ten["votes"], ten["rate"], ten["pr"]), (10, 0.0, 37.5))

    def test_prefix_suffix_fullwidth_inline_and_old_lake(self) -> None:
        text = "７８９　００＋　ＯＯＯ\n０４Ｏ\n1789 -1+0 oooo\n1789 1-0+ oooo"
        proposals = gc.parse_voting_proposals(text)
        self.assertEqual(proposals, [(1, 1, "789", "7890"), (2, 1, "1789", "7890"), (3, 1, "1789", "7890")])

    def test_bad_round_is_omitted_without_shifting_round_or_forced_index(self) -> None:
        text = "789\nooo\n1789\noooo\n1789\n1789 7\n1789\n1789\n1789\noooo\n17890\nooooo"
        proposals = gc.parse_voting_proposals(text)
        self.assertEqual([p[0] for p in proposals], [1, 2, 4])
        self.assertEqual(gc.parse_voting_proposals("789 7-7+\nooo"), [])
        self.assertEqual(gc.parse_voting_proposals("778\nooo"), [])
        self.assertEqual(gc.parse_voting_proposals("789\n" * 6 + "ooo"), [])
        self.assertEqual(gc.parse_voting_proposals("789"), [])

    def test_cache_aliases_purity_and_legacy_fields(self) -> None:
        games = self.games()
        before = copy.deepcopy(games)
        once = gc.compute_player_voting(games)
        self.assertEqual(once, gc.compute_player_voting(games))
        self.assertEqual([g.voting_proposals for g in games], [g.voting_proposals for g in before])
        games[1].seat_players["7"] = "ｔｏｖｏ　ｗｒｅｎ"
        cache = gc.build_cache(games, {}, as_of=AS_OF)
        rows = {p["name"]: p for p in cache["players"]["players"]}
        self.assertEqual(rows["Tovo Wren"]["voting"]["r3Reject"]["loyal"]["votes"], 12)
        self.assertEqual(rows["Tovo Wren"]["winRate"], 100)
        self.assertEqual(cache["playerDetails"]["Tovo Wren"]["player"]["voting"], rows["Tovo Wren"]["voting"])
class RawSheetsExportTest(unittest.TestCase):
    def test_raw_rows_follow_merge_decisions_and_align_headers(self) -> None:
        names = ["Tovo Wren"] + [""] * 9
        main = [LOG_HEADERS, log_row("T1", "123456", "三紅", names, text="123\nxxx")]
        # 本表既有的重複列仍保留；只沿用跨來源與匯入表內的既有去重規則。
        main.append(main[1][:])
        header = list(reversed(LOG_HEADERS)) + ["來源註記"]
        added = log_row("T2", "987654", "三藍活", names, text="456\nooo")
        extra = [header,
                 list(reversed(log_row("D1", "123456", "三紅", names, text="123\nxxx"))) + ["虛構重複列"],
                 list(reversed(added)) + ["虛構來源"],
                 list(reversed(added)) + ["虛構重複列"],
                 list(reversed(log_row("", "123456", "三紅", names))) + ["虛構無效列"]]
        merged = gc.merge_game_logs(main, extra)
        self.assertEqual((len(merged.games), merged.extra_added, merged.extra_duplicates), (3, 1, 2))
        self.assertEqual(merged.raw_rows, [LOG_HEADERS + ["來源註記"], main[1] + [""], main[2] + [""],
                                           added + ["虛構來源"]])
        def fields(g: gc.GameRow) -> dict:
            return {key: getattr(g, key) for key in gc.GameRow.__slots__}
        self.assertEqual([fields(g) for g in gc.parse_game_log(merged.raw_rows)], [fields(g) for g in merged.games])

    def test_export_is_atomic_private_and_logs_only_row_count(self) -> None:
        merged = gc.merge_game_logs([LOG_HEADERS, log_row("T1", "123456", "三紅", ["Tovo Wren"] + [""] * 9)], None)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "raw.json"
            path.write_text("{}", encoding="utf-8")
            path.chmod(0o644)
            out = io.StringIO()
            with redirect_stdout(out):
                gc.export_raw_sheets(merged, path)
            self.assertEqual(out.getvalue(), "牌譜暫存匯出：1 列\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            before = path.read_bytes()
            with mock.patch.object(gc.os, "replace", side_effect=OSError("虛構敏感路徑")):
                with self.assertRaises(gc.FatalError) as error:
                    gc.export_raw_sheets(merged, path)
            self.assertNotIn("虛構敏感路徑", str(error.exception))
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_other_git_worktrees_and_symlinks_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            (repo / ".git").write_text("gitdir: /fictional/path", encoding="utf-8")
            link = root / "link"
            link.symlink_to(repo, target_is_directory=True)
            for target in (repo / "raw.json", link / "raw.json"):
                with self.assertRaises(gc.FatalError):
                    gc.raw_sheets_export_path(target, root / "analysis.json", False)


# ---------------------------------------------------------------------------
# Game-level dataset (games_cache.json; 複合篩選, Edward 2026-10-14)
# ---------------------------------------------------------------------------

DATASET_HEADERS = LOG_HEADERS + ["場次", "note"]
# Free text that must never reach games_cache.json (invented: the note's 測試員丁 is nobody).
SECRET_NOTE = "[3-2]9家改為測試員丁代打。"
SECRET_TEXT = "1237 +4 -5 說他是紅的\nooo\n2>8 x 機密宣告\n2468 機密提案\noxo"
SECRET_TITLE = "秘密貼文標題"


def dataset_row(gid: str, config: str, outcome: str, names: list[str], date: str = "", slot: str = "", note: str = "",
                **cells: str) -> list[str]:
    """A 牌譜 row with the 場次 and note columns; `cells` overrides any column (e.g. 首湖="7o>1")."""
    row = log_row(gid, config, outcome, names, date=date, category=cells.pop("分類", "線瓦"),
                  text=cells.pop("文字記錄", DEFAULT_TEXT), kill=cells.pop("刺殺", ""))
    row += [slot, note]
    for column, value in cells.items():
        row[DATASET_HEADERS.index(column)] = value
    return row


def dataset_log() -> list[list[str]]:
    """leaderboard_log() (boards, timelines, undated games) with 場次 / note, plus odd cells the dataset must
    carry without changing any number: a stray character in 1-1, 局勢, 第一局 and 第一局成功失敗, a lake
    cell like 7o>1, a 分類 and a 結果 outside the lists, a two-character 刺殺, a full-width captain."""
    rows = [DATASET_HEADERS] + [row + [str(i % 7 + 1), ("S2", "古亭", "", "我旁觀")[i % 4]]
                                for i, row in enumerate(leaderboard_log()[1:])]
    rows += [
        dataset_row("X1", "123456", "三藍活", SEAT_NAMES, date="2026/07/26", slot="3", note=SECRET_NOTE,
                    **{"1-1": "1 5", "局勢": "", "第一局": "紅 ", "第一局成功失敗": "oox ", "首湖": "7o>1",
                       "分類": "比賽", "刺殺": "10", "文字記錄": "３457\nooo\n" + SECRET_TEXT}),
        dataset_row("X2", "654321", "平手", SEAT_NAMES, date="2026/07/27", note="測試員丁線瓦"),
        dataset_row("X3", "135790", "三紅", SEAT_NAMES, date="2026/07/27", note="Discopia星球[1-2]梅林踩拇指"),
    ]
    return rows


def run_like_games(log: list[list[str]], as_of: dt.date = TEST_AS_OF, extra: list[list[str]] | None = None) -> list:
    """與 run 相同：合併牌譜、檢查日期、合併名字並固定排序日期。"""
    games, _ = gc.drop_dates_after(gc.merge_game_logs(log, extra).games, as_of)
    games, _ = gc.canonicalize_player_names(games)
    return gc.assign_timeline_dates(games)


def dataset_and_cache(games: list, as_of: dt.date = TEST_AS_OF) -> tuple[dict, dict]:
    dataset = gc.encode_games_dataset(games)
    cache, _ = gc.assemble_cache(
        gc.build_cache(games, {}, as_of, games_key=dataset["key"]), None,
        strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={}, games=games, as_of=as_of,
    )
    return dataset, json.loads(json.dumps(cache, ensure_ascii=False))


class NoteTagTest(unittest.TestCase):
    def test_whitelist_only(self) -> None:
        cases = {
            "S2": ("season:S2",), " 古亭週五 ": ("venue:古亭",), "九號": ("venue:九號",), "９號": ("venue:九號",),
            "台中家": ("venue:台中家",), "我旁觀": ("flag:spectated",), "旁觀": ("flag:spectated",),
            "不是我打的": ("flag:notRecorderGame",), "覆盤局": ("flag:review",), "爛局": ("flag:badGame",),
            "[2025/8/14 update]湖女": ("flag:lakeCorrected",),
            "Discopia星球[1-4]梅林踩拇指[2025/8/14 update]湖女": ("venue:Discopia星球", "flag:lakeCorrected", "flag:incident"),
            "[1-1]派西踩拇指": ("flag:incident",), SECRET_NOTE: ("flag:substitution", "flag:incident"),
            "測試員丁": (), "測試員丁線瓦": (), "古亭XYZ": (), "6家在1-5表壞": (), "S4": (), "": (), None: (),
        }
        for raw, tags in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(gc.parse_note_tags(raw), tags)
        self.assertEqual(len(gc.NOTE_TAG_VOCAB), len(set(gc.NOTE_TAG_VOCAB)))
        self.assertTrue(all(t.startswith(("season:", "venue:", "flag:")) for t in gc.NOTE_TAG_VOCAB))

    def test_slot(self) -> None:
        for raw, slot in {"3": 3, " 12 ": 12, "１２": 12, "": 0, None: 0, "3a": 0, "-1": 0}.items():
            self.assertEqual(gc.parse_slot(raw), slot)


class GamesDatasetTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.games = run_like_games(dataset_log())
        cls.dataset, cls.cache = dataset_and_cache(cls.games)
        cls.text = gc.dump_games_dataset(cls.dataset)

    def test_shape(self) -> None:
        ds = self.dataset
        self.assertEqual(list(ds), ["format", "version", "key", "cacheSchemaVersion", "config", "constants", "counts",
                                    "vocab", "players", "aliases", "fields", "games"])
        self.assertEqual((ds["format"], ds["version"], ds["cacheSchemaVersion"]), ("avalon-games", 2, 4))
        self.assertEqual(ds["counts"], {"games": 235, "fromSheet": 235, "fromDiscord": 0, "players": 21, "dated": 233, "undated": 2})
        self.assertEqual(ds["config"]["leaderboard"], gc.LEADERBOARD_CONFIG)
        self.assertEqual(ds["config"]["theoryWindows"], [100])
        self.assertEqual(ds["constants"]["roleDealTenths"]["忠臣"], 4)
        self.assertEqual(ds["players"][:3], ["甲", "乙", "丙"])
        self.assertEqual(ds["aliases"], {})
        self.assertEqual(self.cache["overview"]["gamesKey"], ds["key"])
        self.assertEqual(json.loads(self.text), ds)  # the file is the dataset
        # 每局一行，每日新增對局只需增加少量行數。
        self.assertEqual(sum(1 for line in self.text.splitlines() if line.startswith('    ["')), 235)

    def test_rows(self) -> None:
        ds = self.dataset
        fields = ds["fields"]
        rows = {r[0]: dict(zip(fields, r)) for r in ds["games"]}
        self.assertTrue(all(gid.startswith("H") and len(gid) == 11 for gid in rows))  # U0, Y0, S0...: hashed
        tiny = [LOG_HEADERS, log_row("1234", "123456", "三紅", SEAT_NAMES), log_row("1235", "123456", "三紅", SEAT_NAMES)]
        tiny[2][LOG_HEADERS.index("局勢")] = "紅藍?"  # not ^[紅藍]{1,5}$: "?" (a top-20 state then withholds, see below)
        small = gc.encode_games_dataset(gc.parse_game_log(tiny))
        self.assertEqual([r[0] for r in small["games"]], ["1234", "1235"])  # a plain 流水號 stays
        self.assertEqual(small["vocab"]["state"], ["藍紅藍", "?"])
        self.assertEqual([r[fields.index("state")] for r in small["games"]], [0, 1])
        x1 = next(dict(zip(fields, r)) for r in ds["games"] if r[fields.index("slot")] == 3 and r[fields.index("note")] == [
            gc.NOTE_TAG_VOCAB.index("flag:substitution"), gc.NOTE_TAG_VOCAB.index("flag:incident")])
        self.assertEqual(ds["vocab"]["category"][x1["cat"]], "其他")  # 比賽
        self.assertEqual(x1["kill"], "?")  # 10: not one seat character
        self.assertEqual(x1["firstTeam"], "1?5")
        self.assertEqual(x1["rounds"], "?RB--")
        self.assertEqual(x1["missions"], "oox?|oxo|ooo||")
        self.assertEqual(x1["state"], -1)  # blank
        self.assertEqual(x1["lakes"], "?1----")
        self.assertEqual(x1["captains"], "?12")  # ３457 (full-width), 1237, 2468
        self.assertEqual(x1["claims"], "28x")
        x2 = next(dict(zip(fields, r)) for r in ds["games"] if ds["vocab"]["outcome"][r[fields.index("outcome")]] == "其他")
        self.assertEqual(x2["note"], [])
        three_red_kills = [r[fields.index("kill")] for r in ds["games"] if r[fields.index("outcome")] == 0]
        self.assertEqual(set(three_red_kills), {""})  # 刺殺 only travels with 三藍 games

    def test_round_trip_reproduces_every_section(self) -> None:
        self.assertEqual(gc.games_dataset_problems(self.dataset, self.cache, self.games, TEST_AS_OF), [])
        decoded = gc.decode_games_dataset(json.loads(self.text))
        rebuilt = gc.build_cache(decoded, {}, TEST_AS_OF, games_key=self.dataset["key"])
        for key in gc.GAMES_DATASET_SECTIONS:
            self.assertEqual(gc._canonical({"v": rebuilt[key]}), gc._canonical({"v": self.cache[key]}), key)
        self.assertEqual([g.timeline_date for g in decoded], [g.timeline_date for g in self.games])
        self.assertEqual([g.captains for g in decoded][-3:], [("?", "1", "2"), ("1", "2"), ("1", "2")])

    def test_nothing_but_structured_fields(self) -> None:
        for secret in ("測試員丁", "代打", "機密", "說他", "踩拇指", "比賽", "平手", "1 5"):
            self.assertNotIn(secret, self.text)
        self.assertEqual(gc.games_dataset_privacy_problems(self.dataset), [])
        tampered = copy.deepcopy(self.dataset)
        tampered["games"][0][gc.GAMES_DATASET_FIELDS.index("missions")] = "ooo 機密|||| "
        tampered["vocab"]["state"][0] = "機密"
        tampered["key"] = gc.games_dataset_key(tampered)
        problems = gc.games_dataset_privacy_problems(tampered)
        self.assertEqual(problems, ["vocab.state", "games[].missions: 1 row(s)"])
        self.assertFalse(any("機密" in p for p in problems))
        tampered["key"] = "0" * 16
        self.assertIn("key does not match the content", gc.games_dataset_privacy_problems(tampered))

    def test_discord_rows(self) -> None:
        header = DATASET_HEADERS + ["discord_post_id", "discord_title"]
        extra = [header, dataset_row("D123456789", "246802", "三藍死", SEAT_NAMES, date="2026/07/28")
                 + ["123456789", SECRET_TITLE]]
        games = run_like_games(dataset_log(), extra=extra)
        dataset, cache = dataset_and_cache(games)
        text = gc.dump_games_dataset(dataset)
        self.assertNotIn(SECRET_TITLE, text)
        self.assertNotIn("123456789", text)
        self.assertEqual((dataset["counts"]["fromSheet"], dataset["counts"]["fromDiscord"]), (235, 1))
        last = dataset["games"][-1]
        self.assertTrue(last[0].startswith("D") and len(last[0]) == 11)
        self.assertEqual(last[1], gc.GAME_SOURCE_DISCORD)
        self.assertEqual(gc.games_dataset_problems(dataset, cache, games, TEST_AS_OF), [])

    def test_key(self) -> None:
        again = gc.encode_games_dataset(run_like_games(dataset_log()))
        self.assertEqual(again, self.dataset)
        self.assertRegex(self.dataset["key"], r"^[0-9a-f]{16}$")
        log = dataset_log()
        log[5][DATASET_HEADERS.index("分類")] = "面瓦"  # only a 分類: no section changes, the key does
        other = gc.encode_games_dataset(run_like_games(log))
        self.assertNotEqual(other["key"], self.dataset["key"])

    def test_withheld_when_the_round_trip_differs(self) -> None:
        """A 配置 with a letter turns into "?", like a lake holder "7o": both now name the same seat."""
        log = dataset_log()
        log.append(dataset_row("X9", "12a456", "三紅", SEAT_NAMES, date="2026/07/28", **{"首湖": "7o>1"}))
        games = run_like_games(log)
        dataset, cache = dataset_and_cache(games)
        problems = gc.games_dataset_problems(dataset, cache, games, TEST_AS_OF)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("round trip differs at", problems[0])
        self.assertIn("lake.perLake[0]", problems[0])
        stale = copy.deepcopy(cache)
        stale["overview"]["gamesKey"] = "0" * 16
        self.assertIn("overview.gamesKey is not the dataset's key", gc.games_dataset_problems(self.dataset, stale, self.games, TEST_AS_OF))

    def test_refactor_changes_no_number(self) -> None:
        """captains / lake_claims are 文字記錄 parsed once; timeline_date is player_timelines' own rule."""
        raw = gc.merge_game_logs(dataset_log(), None).games
        for g in raw:
            self.assertEqual(g.captains, tuple(gc._parse_captain_per_mission(g.text_record)[:5]))
            self.assertEqual(g.lake_claims, tuple(gc.parse_lake_claims(g.text_record)[:3]))
        plain = gc.build_cache(raw, {}, TEST_AS_OF)
        fixed = gc.build_cache(gc.assign_timeline_dates(raw), {}, TEST_AS_OF)
        self.assertEqual(gc._canonical(plain), gc._canonical(fixed))
        if sys.version_info < (3, 12):  # 3.12 compensates; _sum_ltr is the 3.11 behaviour CI runs
            values = [0.1 * i for i in range(1, 30)]
            self.assertEqual(gc._sum_ltr(values), sum(values))

    def test_timeline_of_a_subset_keeps_each_game_in_place(self) -> None:
        """甲 plays A0 (dated 03-02), A1 (undated: sorts with A0), A2 (03-01). Without A0 the plain rule would
        move A1 to the top; with timeline_date from all the games it stays after A2."""
        rows = [LOG_HEADERS,
                log_row("A0", "123456", "三紅", SEAT_NAMES, date="2026/03/02"),
                log_row("A1", "213456", "三紅", SEAT_NAMES),
                log_row("A2", "231456", "三紅", SEAT_NAMES, date="2026/03/01")]
        games = gc.assign_timeline_dates(gc.parse_game_log(rows))
        subset = games[1:]
        self.assertEqual([s.role for s in gc.player_timelines(subset)["甲"]], ["莫德雷德", "莫甘娜"])
        plain = gc.parse_game_log(rows)[1:]
        self.assertEqual([s.role for s in gc.player_timelines(plain)["甲"]], ["莫甘娜", "莫德雷德"])


class SnapshotDatasetTest(unittest.TestCase):
    """固定 2,146 局牌譜快照：每個支援區塊皆可由資料集完全重現。"""

    def test_snapshot_round_trip(self) -> None:
        if not SNAPSHOT.exists():
            self.skipTest("sheets_cache.json not found")
        log = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("牌譜") or []
        as_of = dt.date(2026, 2, 28)
        games = run_like_games(log, as_of)
        if len(games) != 2146:
            self.skipTest("sheets_cache.json is not the 2146-game snapshot")
        dataset, cache = dataset_and_cache(games, as_of)
        self.assertEqual(gc.games_dataset_problems(dataset, cache, games, as_of), [])
        self.assertEqual((dataset["counts"]["players"], dataset["counts"]["dated"]), (171, 2083))
        cats = Counter(r[gc.GAMES_DATASET_FIELDS.index("cat")] for r in dataset["games"])
        self.assertEqual([cats[i] for i in range(5)], [1373, 627, 146, 0, 0])
        self.assertLess(len(gc.dump_games_dataset(dataset).encode("utf-8")), 2_000_000)


class DatasetEndToEndTest(unittest.TestCase):
    """以虛構試算表驗證兩份快取一起更新，以及資料集停寫時的退回行為。"""

    setUp = EndToEndTest.setUp
    tearDown = EndToEndTest.tearDown
    run_main = EndToEndTest.run_main
    files = EndToEndTest.files

    def games_file(self) -> Path:
        return self.out.with_name(gc.GAMES_OUTPUT_NAME)

    def test_written_together_and_bound_by_the_key(self) -> None:
        rc, log = self.run_main(summary=True)
        self.assertEqual(rc, 0, log)
        cache = json.loads(self.out.read_text(encoding="utf-8"))
        dataset = json.loads(self.games_file().read_text(encoding="utf-8"))
        self.assertEqual(cache["overview"]["gamesKey"], dataset["key"])
        self.assertEqual(len(dataset["games"]), cache["overview"]["totalGames"])
        self.assertIn("每局資料集：4 局、3 位", self.summary.read_text(encoding="utf-8"))
        self.assertIn("round-trip 通過", self.summary.read_text(encoding="utf-8"))
        first = (self.out.read_bytes(), self.games_file().read_bytes())

        rc, _ = self.run_main(as_of=(AS_OF + dt.timedelta(days=1)).isoformat())  # only the day: neither
        self.assertEqual(rc, 0)
        self.assertEqual((self.out.read_bytes(), self.games_file().read_bytes()), first)

        self.tabs["牌譜"][2][LOG_HEADERS.index("分類")] = "面瓦"  # no section changes, the dataset does
        rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        cache2 = json.loads(self.out.read_text(encoding="utf-8"))
        dataset2 = json.loads(self.games_file().read_text(encoding="utf-8"))
        self.assertNotEqual(dataset2["key"], dataset["key"])
        self.assertEqual(cache2["overview"]["gamesKey"], dataset2["key"])  # both rewritten
        self.assertEqual({k: v for k, v in cache2["overview"].items() if k != "gamesKey"},
                         {k: v for k, v in cache["overview"].items() if k != "gamesKey"})

        self.games_file().unlink()  # a missing dataset is written again even if the cache would not change
        rc, _ = self.run_main()
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(self.games_file().read_text(encoding="utf-8")), dataset2)

    def test_withheld_dataset_keeps_the_cache_going(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        old_dataset = self.games_file().read_bytes()
        row = self.tabs["牌譜"][1]
        row[LOG_HEADERS.index("配置")] = "12a456"  # round trip differs (see GamesDatasetTest)
        row[LOG_HEADERS.index("首湖")] = "7o>1"
        self.tabs["牌譜"].append(log_row("T9", "123456", "三紅", E2E_PLAYERS + [""] * 7))
        github_output = Path(self.tmp.name) / "github_output"
        env = {"GITHUB_ACTIONS": "true", "GITHUB_OUTPUT": str(github_output)}
        with mock.patch.dict(os.environ, env):
            rc, log = self.run_main(summary=True)
        self.assertEqual(rc, 0, log)
        cache = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(cache["overview"]["totalGames"], 5)  # the cache moved on
        self.assertEqual(self.games_file().read_bytes(), old_dataset)  # the dataset did not
        self.assertNotEqual(cache["overview"]["gamesKey"], json.loads(old_dataset)["key"])  # -> filters off
        self.assertIn("games_dataset=withheld", github_output.read_text(encoding="utf-8"))
        self.assertIn("::error title=Games dataset withheld::", log)
        self.assertIn("暫停寫入", self.summary.read_text(encoding="utf-8"))
        for name in E2E_PLAYERS:  # public log: counts and paths only
            self.assertNotIn(name, log + self.summary.read_text(encoding="utf-8"))
        self.assertEqual(self.files(), ["analysis_cache.json", "games_cache.json", "github_output"])

        row[LOG_HEADERS.index("配置")] = "123456"  # fixed in the Sheet: both written again
        with mock.patch.dict(os.environ, env):
            rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertIn("games_dataset=ok", github_output.read_text(encoding="utf-8"))
        dataset = json.loads(self.games_file().read_text(encoding="utf-8"))
        self.assertEqual(json.loads(self.out.read_text(encoding="utf-8"))["overview"]["gamesKey"], dataset["key"])

    def test_compare_writes_neither(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        before = (self.out.read_bytes(), self.games_file().read_bytes())
        self.tabs["牌譜"].append(log_row("T9", "123456", "三紅", E2E_PLAYERS + [""] * 7))
        rc, log = self.run_main("--compare", summary=True)
        self.assertEqual(rc, 0, log)
        self.assertEqual((self.out.read_bytes(), self.games_file().read_bytes()), before)
        self.assertIn("每局資料集：5 局", self.summary.read_text(encoding="utf-8"))
        self.assertIn("nor games_cache.json", log)

    def test_games_output_flag(self) -> None:
        other = Path(self.tmp.name) / "sub"
        other.mkdir()
        rc, log = self.run_main("--games-output", str(other / "g.json"))
        self.assertEqual(rc, 0, log)
        self.assertTrue((other / "g.json").exists())
        self.assertFalse(self.games_file().exists())


class RawSheetsExportTest(unittest.TestCase):
    def test_raw_rows_follow_merge_decisions_and_align_headers(self) -> None:
        names = ["Tovo Wren"] + [""] * 9
        main = [LOG_HEADERS, log_row("T1", "123456", "三紅", names, text="123\nxxx")]
        # 本表既有的重複列仍保留；只沿用跨來源與匯入表內的既有去重規則。
        main.append(main[1][:])
        header = list(reversed(LOG_HEADERS)) + ["來源註記"]
        added = log_row("T2", "987654", "三藍活", names, text="456\nooo")
        extra = [header,
                 list(reversed(log_row("D1", "123456", "三紅", names, text="123\nxxx"))) + ["虛構重複列"],
                 list(reversed(added)) + ["虛構來源"],
                 list(reversed(added)) + ["虛構重複列"],
                 list(reversed(log_row("", "123456", "三紅", names))) + ["虛構無效列"]]
        merged = gc.merge_game_logs(main, extra)
        self.assertEqual((len(merged.games), merged.extra_added, merged.extra_duplicates), (3, 1, 2))
        self.assertEqual(merged.raw_rows, [LOG_HEADERS + ["來源註記"], main[1] + [""], main[2] + [""],
                                           added + ["虛構來源"]])
        def fields(g: gc.GameRow) -> dict:
            return {key: getattr(g, key) for key in gc.GameRow.__slots__ if key != "source"}
        self.assertEqual([fields(g) for g in gc.parse_game_log(merged.raw_rows)], [fields(g) for g in merged.games])

    def test_export_is_atomic_private_and_logs_only_row_count(self) -> None:
        merged = gc.merge_game_logs([LOG_HEADERS, log_row("T1", "123456", "三紅", ["Tovo Wren"] + [""] * 9)], None)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "raw.json"
            path.write_text("{}", encoding="utf-8")
            path.chmod(0o644)
            out = io.StringIO()
            with redirect_stdout(out):
                gc.export_raw_sheets(merged, path)
            self.assertEqual(out.getvalue(), "牌譜暫存匯出：1 列\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            before = path.read_bytes()
            with mock.patch.object(gc.os, "replace", side_effect=OSError("虛構敏感路徑")):
                with self.assertRaises(gc.FatalError) as error:
                    gc.export_raw_sheets(merged, path)
            self.assertNotIn("虛構敏感路徑", str(error.exception))
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(list(Path(tmp).iterdir()), [path])

    def test_other_git_worktrees_and_symlinks_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            (repo / ".git").write_text("gitdir: /fictional/path", encoding="utf-8")
            link = root / "link"
            link.symlink_to(repo, target_is_directory=True)
            for target in (repo / "raw.json", link / "raw.json"):
                with self.assertRaises(gc.FatalError):
                    gc.raw_sheets_export_path(target, root / "analysis.json", False)


class OverallTheoryTest(unittest.TestCase):
    """整體理論 = Σ P(role) × P(seat) × final win % as that role in that seat (Edward 2026-10-28)."""

    def test_hand_example(self) -> None:
        population = {r: {str(i): 50.0 for i in range(1, 11)} for r in ROLE_ORDER}
        loyal = [gc.PlayerSeat("忠臣", "1", "三藍活", "2026-01-01")] * 5  # 5 wins: a full cell
        # 0.04 x 100 + 0.96 x 50 = 52.0; 69 of 70 cells topped up, 96 % of the weight.
        self.assertEqual(gc.overall_theory(loyal, population, 5),
                         {"overallTheory": 52.0, "sparseCells": 69, "populationShare": 96.0})
        # + one lost game as 刺客 in seat 2: (0 + 4 x 50) / 5 = 40 at 0.01 -> 4 + 0.4 + 0.95 x 50 = 51.9;
        # the population's share: 95 + 0.01 x 4/5 x 100 = 95.8.
        mixed = loyal + [gc.PlayerSeat("刺客", "2", "三藍活", "2026-01-02")]
        self.assertEqual(gc.overall_theory(mixed, population, 5),
                         {"overallTheory": 51.9, "sparseCells": 69, "populationShare": 95.8})
        # Seat "0" is seat 10 (its population rate is unused once the cell is full); theory_window adds
        # the three keys only with the population table.
        ten = [gc.PlayerSeat("梅林", "0", "三藍活", "")] * 5
        odd = {**population, "梅林": {**population["梅林"], "10": 0.0}}
        self.assertEqual(gc.overall_theory(ten, odd, 5)["overallTheory"], 50.5)  # 0.01 x 100 + 0.99 x 50
        self.assertNotIn("overallTheory", gc.theory_window(ten, {}, {}, 5))
        self.assertEqual(gc.theory_window(ten, {}, {}, 5, role_seat_rates=population)["overallTheory"], 50.5)

    def test_mission_assassination(self) -> None:
        seats = [gc.PlayerSeat("刺客", "1", "三紅", ""), gc.PlayerSeat("刺客", "1", "三藍死", ""),
                 gc.PlayerSeat("梅林", "2", "三藍活", ""), gc.PlayerSeat("忠臣", "3", "三藍死", ""),
                 gc.PlayerSeat("忠臣", "3", "三紅", "")]
        # 任務: red 1 of 2 (三紅), blue 2 of 3 (三藍) -> 3/5; 刺殺: three 三藍 games -- 刺客 hit, 梅林
        # survived, 忠臣 with Merlin killed -> 2/3.
        self.assertEqual(gc.mission_assassination(seats), {
            "missionWinRate": 60.0, "missionRedWinRate": 50.0, "missionBlueWinRate": 66.7,
            "assassinWinRate": 66.7, "threeBlueGames": 3})
        self.assertEqual(gc.mission_assassination(seats[:1]), {
            "missionWinRate": 100.0, "missionRedWinRate": 100.0, "missionBlueWinRate": None,
            "assassinWinRate": None, "threeBlueGames": 0})


class RoleTitleWindowTest(unittest.TestCase):
    """角色王 (Edward 2026-10-28): the full window when at least half of the listed active players with a
    game in the role have it, else the fallback; qualifying = a full window."""

    @staticmethod
    def seats(**counts: int) -> list:
        return [gc.PlayerSeat(role, "1", "三紅", "2026-10-01") for role, n in counts.items() for _ in range(n)]

    def test_majority_rule(self) -> None:
        cfg = {"roleTitleGames": 3, "roleTitleFallbackGames": 2, "loyalTitleGames": 4, "loyalTitleFallbackGames": 1}
        active = {"A": self.seats(刺客=3, 忠臣=4), "B": self.seats(刺客=1, 忠臣=1), "C": self.seats(梅林=9),
                  "D": self.seats(刺客=5)}
        w = gc.role_title_windows(active, cfg)
        self.assertEqual(w["刺客"], 3)  # A and D of A, B, D have 3 (C never played it)
        self.assertEqual(w["忠臣"], 4)  # A of A, B: exactly half is enough
        self.assertEqual(w["梅林"], 3)  # C alone
        self.assertEqual(w["莫甘娜"], 3)  # nobody played it (the role has no title anyway)
        self.assertEqual(gc.role_title_windows(active, {**cfg, "roleTitleGames": 4})["刺客"], 2)  # only D of three

    def test_rotation_fixture(self) -> None:
        """Everyone has 26 games per special role and 104 as 忠臣: 30 is nobody's -> 26; 100 is everyone's."""
        cfg = {**gc.LEADERBOARD_CONFIG, "roleTitleGames": 30, "roleTitleFallbackGames": 26,
               "loyalTitleGames": 100, "loyalTitleFallbackGames": 50}
        games = gc.parse_game_log(rotation_log())
        board = next(b for b in gc.compute_leaderboard(games, TEST_AS_OF, cfg=cfg)["boards"] if b["id"] == "roleTitles")
        self.assertEqual(board["roleWindowGames"], {r: 100 if r == "忠臣" else 26 for r in ROLE_ORDER})
        self.assertEqual((board["period"], board["minGames"]), ("忠臣近 100 場、其他角色近 26 場", 26))
        self.assertIn("有出賽過該角色的人不到一半打滿時改用忠臣 50 場、其他角色 26 場", board["note"])
        for r in board["rows"]:
            self.assertEqual((r["games"], r["qualified"]), (100 if r["role"] == "忠臣" else 26, 10))
        self.assertEqual(gc.LEADERBOARD_CONFIG["roleTitleGames"], 20)  # the cfg argument leaves the config alone


class TheoryBoardTest(unittest.TestCase):
    """theory: every theory rate of a player in one table (Edward 2026-10-28)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.games = gc.parse_game_log(rotation_log())
        cls.boards = {b["id"]: b for b in gc.compute_leaderboard(cls.games, TEST_AS_OF)["boards"]}

    def theory(self, **over: int) -> dict | None:
        cfg = {**gc.LEADERBOARD_CONFIG, **over}
        return next((b for b in gc.compute_leaderboard(self.games, TEST_AS_OF, cfg=cfg)["boards"] if b["id"] == "theory"),
                    None)

    def test_defaults_list_the_main_board(self) -> None:
        board, main, overall = self.boards["theory"], self.boards["main"], self.boards["overall"]
        self.assertEqual((board["windowGames"], board["overallMinGames"], board["requireRoleWindows"]), (100, 250, True))
        self.assertEqual([(r["name"], r["roleTheory"], r["positionTheory"], r["finalWinRate"]) for r in board["rows"]],
                         [(r["name"], r["roleTheory"], r["positionTheory"], r["finalWinRate"]) for r in main["rows"]])
        by_name = {r["name"]: r for r in overall["rows"]}
        for r in board["rows"]:
            self.assertEqual(r["overallTheory"], by_name[r["name"]]["overallTheory"])
            self.assertEqual((r["games"], r["careerGames"], r["roleGames"], r["fullWindows"]), (100, 260, 100, True))
            self.assertEqual({k: r[k] for k in OUTCOME_FIELDS},
                             rot_expected_outcomes(ROT_NAMES.index(r["name"]), range(160, 260)))

    def test_conditions(self) -> None:
        # 整體理論 below overallMinGames career games: None (—), not a number on fewer games.
        self.assertTrue(all(r["overallTheory"] is None and r["populationShare"] is None
                            for r in self.theory(overallMinGames=261)["rows"]))
        self.assertEqual(len(self.theory(theoryMinGames=260)["rows"]), 10)
        self.assertIsNone(self.theory(theoryMinGames=261))  # an empty board is left out
        # Role windows of 30 / 120: nobody's are full; with the rule off everyone is listed, flagged.
        self.assertIsNone(self.theory(roleWindowGames=30, loyalWindowGames=120))
        off = self.theory(roleWindowGames=30, loyalWindowGames=120, requireRoleWindows=0)
        self.assertEqual(len(off["rows"]), 10)
        self.assertTrue(all(r["fullWindows"] is False for r in off["rows"]))
        self.assertIn("沒打滿的變淡", off["note"])
        # mainGames 0 = the whole career for the last-N numbers.
        career = self.theory(mainGames=0)
        self.assertEqual({r["games"] for r in career["rows"]}, {260})
        self.assertEqual(career["period"], "角色理論：各角色近 10 場、忠臣近 40 場；其他：生涯全部場次")


if __name__ == "__main__":
    unittest.main(verbosity=2)
