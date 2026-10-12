"""Offline tests for generate_cache.py: credentials, sanity guards, carry-over, write path,
--compare, the per-player stats it aggregates from 牌譜, the two-stage outcome fields,
the leaderboard, and the featureStudies it computes / annotates.

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
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
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
            row["name"] = row["name"].lower()  # every old spelling disappears
        problem = next(p for p in gc.validate_new_cache(renamed, prev) if "existing player" in p)
        self.assertIn("12 existing player(s)", problem)
        self.assertIn("P11 21→gone", problem)
        self.assertIn(f"(+{12 - gc.MAX_LISTED_REGRESSIONS} more)", problem)
        self.assertEqual(
            [r[0] for r in gc.games_regressions(renamed, prev)][:3], ["P11", "P10", "P9"],
        )

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
        new = fake_cache(player_fields={f: 0 for f in ALL_PLAYER_FIELDS if f != "name"})
        self.assertEqual(gc.validate_new_cache(new, prev), [])
        self.assertEqual(gc.dropped_player_fields(prev, new), sorted(NEW_PLAYER_FIELDS))  # the reverse direction would be a loss

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
ALL_PLAYER_FIELDS = PLAYER_FIELDS[:-1] + NEW_PLAYER_FIELDS + ["seatOutcomes"]
EMPTY_OUTCOME = {"threeRed": 0, "threeBlueDead": 0, "threeBlueAlive": 0,
                 "threeRedPct": 0, "threeBlueDeadPct": 0, "threeBlueAlivePct": 0}


def old_fields(row: dict) -> dict:
    """The row without the two-stage fields (what the 2026-04-26 rebuild wrote)."""
    return {k: v for k, v in row.items() if k not in NEW_PLAYER_FIELDS}


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
    # Projection of the global split (1 三紅 / 1 三藍死 / 2 三藍活 of 5 games, G4 included) onto the
    # 5 games of seat 1 -- NOT 甲's own games; zero for seat 10, played but never won there.
    "seatOutcomes": {
        s: ({"threeRed": 1, "threeBlueDead": 1, "threeBlueAlive": 3,
             "threeRedPct": 20.0, "threeBlueDeadPct": 20.0, "threeBlueAlivePct": 40.0}
            if s == "1" else EMPTY_OUTCOME)
        for s in SEAT_ORDER
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


def build_fresh(log: list[list[str]]) -> dict:
    """build_cache + a stub strength section (what validate_new_cache expects), no carry-over."""
    cache, _ = gc.assemble_cache(
        gc.build_cache(gc.parse_game_log(log), {}), None,
        strength_builder=lambda players: {"perPlayer": {}}, placeholder_builders={},
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
        self.assertEqual(gc.normalize_player_name("Sin"), "Sin")  # case kept: Sin / SIN / sin differ
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

    def test_two_stage_overview(self) -> None:
        ov = self.cache["overview"]
        self.assertEqual(ov["schemaVersion"], 2)
        self.assertEqual(ov["totalGames"], 5)  # G4 (no 結果) still counts here, as before
        self.assertEqual(ov["missionStage"], {"games": 4, "threeRed": 1, "threeBlue": 3, "redPct": 25.0, "bluePct": 75.0})
        self.assertEqual(ov["assassinationStage"],
                         {"games": 3, "merlinKilled": 1, "merlinSurvived": 2, "killPct": 33.3, "survivePct": 66.7})
        self.assertEqual(ov["final"], {"games": 4, "redWins": 2, "blueWins": 2, "redPct": 50.0, "bluePct": 50.0})
        self.assertEqual(ov["roleFinalWinRates"], EXPECTED_ROLE_FINAL)
        self.assertEqual(ov["topPlayersByExcess"], [])  # nobody has 30 games
        # Old overview keys keep the mission-stage rule (三藍死 = blue win).
        self.assertEqual((ov["redWinRate"], ov["blueWinRate"]), (20.0, 60.0))

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
        for row in self.rows:
            failures += [f"{row['name']}: {msg}" for msg in check(row)]
        self.assertEqual(failures[:10], [], f"{len(failures)} failures")

    def test_fields_and_types(self) -> None:
        self.assertGreaterEqual(len(self.rows), 1)

        def check(row):
            if list(row) not in (PLAYER_FIELDS, ALL_PLAYER_FIELDS):  # the rebuild's shape, or this script's
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

    def test_seat_outcomes_are_the_projected_global_split(self) -> None:
        overview = self.cache["overview"]
        projected = gc.compute_seat_outcomes_per_player(
            overview["seatPositionWinRates"], overview["outcomeBreakdown"], self.rows,
        )

        def check(row):
            if row["seatOutcomes"] != projected[row["name"]]:
                yield "seatOutcomes != projection"
            for s in SEAT_ORDER:
                played = row["seatWinRates"][s] > 0
                if (row["seatOutcomes"][s] == EMPTY_OUTCOME) == played:
                    yield f"seat {s}: projected iff seatWinRates > 0"
        self.check_all(check)

    def test_order_details_and_overview(self) -> None:
        games = [r["totalGames"] for r in self.rows]
        self.assertEqual(games, sorted(games, reverse=True))
        self.assertEqual(self.cache["players"]["total"], len(self.rows))
        self.assertEqual(self.cache["overview"]["totalPlayers"], len(self.rows))
        self.assertEqual(self.cache["playerDetails"], gc.compute_player_details(self.rows))
        self.assertEqual(list(self.cache["playerDetails"]), [r["name"] for r in self.rows])
        top = gc.compute_overview([], self.rows)
        self.assertEqual(self.cache["overview"]["topPlayersByTheory"], top["topPlayersByTheory"])
        self.assertEqual(self.cache["overview"]["topPlayersByGames"], top["topPlayersByGames"])


# ---------------------------------------------------------------------------
# Replay of the 2026-04-26 rebuild from the checked-in 牌譜 snapshot
# ---------------------------------------------------------------------------

SNAPSHOT = Path(__file__).resolve().parent / "sheets_cache.json"
REBUILD_FINGERPRINT = {"totalGames": 2146, "totalPlayers": 198, "threeRed": 999, "threeBlueDead": 499, "threeBlueAlive": 648}
GAME_1276_PLAYERS = ["呂安", "Dean", "布冬", "軒", "HAO", "洋蔥", "大星", "JOY", "kevin", "Sin"]


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

        players = {**cache["players"], "players": [old_fields(r) for r in cache["players"]["players"]]}
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
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def run_main(self, *args: str, summary: bool = False, as_of: str | None = None) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        env = {"GITHUB_STEP_SUMMARY": str(self.summary)} if summary else {}
        if as_of:
            env[gc.ENV_AS_OF] = as_of
        with redirect_stdout(out), redirect_stderr(err), mock.patch.dict(os.environ, env):
            rc = gc.main(["--output", str(self.out), *args])
        return rc, out.getvalue() + err.getvalue()

    def files(self) -> list[str]:
        return sorted(p for p in os.listdir(self.tmp.name) if p != self.summary.name)

    def test_refresh_carry_over_idempotence_and_guard(self) -> None:
        rc, log = self.run_main()  # first ever run: no previous file
        self.assertEqual(rc, 0, log)
        first = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(first["overview"]["totalGames"], 4)
        self.assertEqual(set(first), set(gc.SHEET_SECTIONS) | {"strength", "featureStudies"})
        self.assertEqual([p["name"] for p in first["players"]["players"]], E2E_PLAYERS)
        self.assertEqual(first["players"]["players"][0]["totalGames"], 4.0)
        self.assertEqual(first["overview"]["schemaVersion"], 2)
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
        self.assertEqual(self.files(), ["analysis_cache.json"])

    def test_next_day_without_new_games_writes_nothing(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        first_bytes = self.out.read_bytes()
        next_day = (AS_OF + dt.timedelta(days=1)).isoformat()

        rc, log = self.run_main(as_of=next_day)  # the clock moved on, the Sheet did not
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.out.read_bytes(), first_bytes)  # not rewritten: the workflow has nothing to commit
        self.assertIn("only by the as-of day", log)
        self.assertIn("not written", log)
        self.assertEqual(self.files(), ["analysis_cache.json"])

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
        self.assertEqual(self.files(), ["analysis_cache.json"])
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
        self.assertEqual(gc.previous_month(AS_OF), (dt.date(2026, 9, 1), dt.date(2026, 9, 30)))
        self.assertEqual(gc.previous_month(dt.date(2026, 1, 15)), (dt.date(2025, 12, 1), dt.date(2025, 12, 31)))
        self.assertEqual(gc.previous_month(dt.date(2026, 3, 31)), (dt.date(2026, 2, 1), dt.date(2026, 2, 28)))


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------

# 配置 123456: seats 1-6 are 刺客 莫甘娜 莫德雷德 奧伯倫 派西維爾 梅林, seats 7-0 are 忠臣.
SEPT_OUTCOMES = ["三紅", "三藍活", "三藍死", "三藍活", "三紅"]  # x5: red final wins 15/25, blue 10/25


def dated(gid: str, date: str, outcome: str, names: list[str] | None = None, category: str = "") -> list[str]:
    return log_row(gid, "123456", outcome, names or SEAT_NAMES, date=date, category=category)


def leaderboard_log() -> list[list[str]]:
    """As of 2026-10-12: 25 September games (線瓦 on 20, 新人 replaces 癸 in the last 6), 12 March
    games (the "prior" span of improved), 3 games on 10/10 (assassin), 2 games of 2024 (inside 730
    days only), one future-dated (a typo: counts as undated), three undated, and 老人 who only
    played in 2024."""
    rows = [LOG_HEADERS]
    for i in range(25):
        names = SEAT_NAMES[:9] + ["新人"] if i >= 19 else SEAT_NAMES
        rows.append(dated(f"S{i}", f"2026/09/{i + 1:02d}", SEPT_OUTCOMES[i % 5], names, "線瓦" if i < 20 else "面瓦"))
    for i in range(12):
        rows.append(dated(f"M{i}", f"2026/03/{i + 1:02d}", "三紅" if i < 9 else "三藍活"))  # red-heavy: everyone's prior
    for i, outcome in enumerate(["三藍死", "三藍活", "三紅"]):
        rows.append(dated(f"O{i}", "2026/10/10", outcome))
    rows.append(dated("Y0", "2024/11/01", "三紅", ["老人"] + SEAT_NAMES[1:]))
    rows.append(dated("Y1", "2024/11/02", "三藍活", ["老人"] + SEAT_NAMES[1:]))
    rows.append(dated("F0", "2027/01/01", "三紅"))  # typo in the future: no date at all (drop_dates_after), 全期 only
    rows += [dated(f"U{i}", "", "三藍活") for i in range(3)]
    return rows


class LeaderboardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.games = gc.parse_game_log(leaderboard_log())
        cls.cache = build_fresh(leaderboard_log())
        cls.lb = cls.cache["leaderboard"]
        cls.boards = {b["id"]: b for b in cls.lb["boards"]}

    def test_section_shape(self) -> None:
        self.assertEqual(list(self.lb), ["asOf", "dates", "config", "boards"])
        self.assertEqual(self.lb["asOf"], "2026-10-12")
        self.assertEqual(self.lb["dates"], {"parsed": 42, "unparsed": 4, "earliest": "2024-11-01", "latest": "2026-10-10"})
        self.assertEqual(self.lb["config"], gc.LEADERBOARD_CONFIG)
        self.assertIsNot(self.lb["config"], gc.LEADERBOARD_CONFIG)
        self.assertEqual(list(self.boards), ["main", "online", "recent", "improved", "assassin", "newcomers", "roleTitles"])
        for board in self.lb["boards"]:
            with self.subTest(board=board["id"]):
                self.assertEqual(list(board)[:8], ["id", "title", "titleEn", "period", "windowDays", "minGames", "note", "noteEn"])
                self.assertEqual(list(board)[-1], "rows")
                self.assertEqual([r["rank"] for r in board["rows"]], list(range(1, len(board["rows"]) + 1)))
                self.assertLessEqual(len(board["rows"]), gc.LEADERBOARD_CONFIG["topN"])
                for r in board["rows"]:
                    self.assertIsInstance(r["value"], float)
                    self.assertIsInstance(r["games"], int)

    def test_main_board(self) -> None:
        main = self.boards["main"]
        self.assertEqual((main["period"], main["windowDays"], main["minGames"]), ("2025-10-13 ～ 2026-10-12", 365, 20))
        self.assertIn("近 90 天內有出賽", main["note"])
        names = {r["name"] for r in main["rows"]}
        self.assertEqual(names, set(SEAT_NAMES))  # 新人: 6 games < 20; 老人: not active (2024 only)
        by_name = {r["name"]: r for r in main["rows"]}
        self.assertEqual(by_name["甲"]["games"], 40)  # 25 Sept + 12 March + 3 Oct; 2024, future and undated games excluded
        self.assertEqual(by_name["癸"]["games"], 34)  # 新人 took seat 10 in the last 6 September games
        # 甲 is always 刺客: red final wins = 15 (Sept) + 9 (March) + 2 (Oct: 三藍死 + 三紅) = 26 / 40.
        self.assertEqual(by_name["甲"]["finalWinRate"], 65.0)
        role_rates = self.cache["overview"]["roleFinalWinRates"]
        self.assertEqual(by_name["甲"]["expectedFinalWinRate"], role_rates["刺客"])  # one role only
        for r in main["rows"]:
            self.assertEqual(r["excessWinRate"], rnd1(r["finalWinRate"] - r["expectedFinalWinRate"]))
            self.assertEqual(r["value"], gc.shrunk_excess(r["excessWinRate"], r["games"], 20))
        values = [r["value"] for r in main["rows"]]
        self.assertEqual(values, sorted(values, reverse=True))

    def test_online_board(self) -> None:
        online = self.boards["online"]
        self.assertEqual((online["period"], online["windowDays"], online["category"]), ("2025-10-13 ～ 2026-10-12", 365, "線瓦"))
        self.assertEqual(online["coverage"], 62.5)  # 25 of the 40 window games have a 分類
        self.assertEqual({r["games"] for r in online["rows"]}, {20})  # the 20 線瓦 September games
        self.assertEqual({r["name"] for r in online["rows"]}, set(SEAT_NAMES[:9]))  # 癸: 19 線瓦 games < 20

    def test_online_board_needs_category_coverage(self) -> None:
        log = [row if row[LOG_HEADERS.index("流水號")].startswith("S") and int(row[LOG_HEADERS.index("流水號")][1:]) >= 5
               else row for row in leaderboard_log()]
        cat = LOG_HEADERS.index("分類")
        for row in log[1:6]:  # 5 fewer categorized games: 20/40 = 50% < 60%
            row[cat] = ""
        boards = {b["id"] for b in build_fresh(log)["leaderboard"]["boards"]}
        self.assertNotIn("online", boards)
        self.assertIn("main", boards)

    def test_recent_improved_assassin_newcomers(self) -> None:
        recent = self.boards["recent"]
        self.assertEqual((recent["period"], recent["windowDays"], recent["minGames"]), ("2026-07-15 ～ 2026-10-12", 90, 10))
        self.assertEqual({r["games"] for r in recent["rows"]}, {28, 22})  # 25 + 3; 癸 19 + 3; 新人 6 < 10

        improved = self.boards["improved"]
        self.assertEqual(improved["period"], "2026-07-15 ～ 2026-10-12")
        self.assertEqual(improved["priorPeriod"], "2025-10-13 ～ 2026-07-14")
        jia = next(r for r in improved["rows"] if r["name"] == "甲")
        # recent: 15 + 2 = 17 / 28 = 60.7; prior (March): 9 / 12 = 75.0.
        self.assertEqual((jia["recentFinalWinRate"], jia["priorFinalWinRate"], jia["recentGames"], jia["priorGames"]), (60.7, 75.0, 28, 12))
        self.assertEqual((jia["value"], jia["games"]), (-14.3, 28))
        ji = next(r for r in improved["rows"] if r["name"] == "己")  # 梅林: recent 11/28 = 39.3, prior 3/12 = 25.0
        self.assertEqual(ji["value"], 14.3)
        # 癸 (忠臣, out of the last 6 September games): recent 9/22 = 40.9, prior 25.0 -> 15.9, first; then the
        # five blue players tied at 14.3 with 28 games, in name (code point) order.
        self.assertEqual([(r["name"], r["value"]) for r in improved["rows"][:6]],
                         [("癸", 15.9), ("壬", 14.3), ("己", 14.3), ("庚", 14.3), ("戊", 14.3), ("辛", 14.3)])

        assassin = self.boards["assassin"]
        self.assertEqual((assassin["period"], assassin["windowDays"]), ("2026-10-06 ～ 2026-10-12", 7))
        self.assertEqual(assassin["rows"], [{"rank": 1, "name": "甲", "value": 50.0, "hits": 1, "attempts": 2, "games": 3}])

        newcomers = self.boards["newcomers"]
        self.assertEqual((newcomers["period"], newcomers["minGames"]), ("2026-07-15 ～ 2026-10-12", 5))
        self.assertEqual([(r["name"], r["games"], r["firstPlayed"]) for r in newcomers["rows"]], [("新人", 6, "2026-09-20")])

    def test_role_titles_previous_month(self) -> None:
        titles = self.boards["roleTitles"]
        self.assertEqual((titles["period"], titles["windowDays"], titles["minGames"]), ("2026-09-01 ～ 2026-09-30", 30, 5))
        rows = {r["role"]: r for r in titles["rows"]}
        self.assertEqual(list(rows), ROLE_ORDER)
        self.assertEqual(rows["刺客"], {"rank": 1, "role": "刺客", "name": "甲", "value": 60.0, "games": 25, "wins": 15})
        self.assertEqual((rows["梅林"]["name"], rows["梅林"]["value"]), ("己", 40.0))
        # 忠臣: 庚 辛 壬 25 games at 40.0, 癸 8/19 = 42.1 (rate beats games), 新人 2/6.
        self.assertEqual((rows["忠臣"]["name"], rows["忠臣"]["value"], rows["忠臣"]["games"]), ("癸", 42.1, 19))
        self.assertEqual([r["rank"] for r in titles["rows"]], [1, 2, 3, 4, 5, 6, 7])

    def test_fallback_widens_main_window(self) -> None:
        def log_with(old_date: str) -> list[list[str]]:
            rows = [LOG_HEADERS] + [dated(f"A{i}", old_date, "三紅" if i % 2 else "三藍活") for i in range(22)]
            rows.append(dated("R0", "2026/10/01", "三紅"))  # everyone active, but 1 game in the last 365 days
            rows.append(dated("U0", "", "三藍活"))  # undated: counted in 全期 only
            return rows

        lb = build_fresh(log_with("2024/11/01"))["leaderboard"]  # 23 games within 730 days
        main = next(b for b in lb["boards"] if b["id"] == "main")
        self.assertEqual((main["windowDays"], main["period"]), (730, "2024-10-13 ～ 2026-10-12"))  # 730 days, asOf included
        self.assertEqual({r["games"] for r in main["rows"]}, {23})
        self.assertNotIn("recent", {b["id"] for b in lb["boards"]})  # 1 game < 10: board left out

        lb = build_fresh(log_with("2020/05/05"))["leaderboard"]  # only 全期 has 20 games
        main = next(b for b in lb["boards"] if b["id"] == "main")
        self.assertEqual((main["windowDays"], main["period"]), (0, "2020-05-05 ～ 2026-10-12"))
        self.assertIn("全期", main["note"])
        self.assertEqual({r["games"] for r in main["rows"]}, {24})  # the undated game counts in 全期

    def test_future_dated_games_count_as_undated(self) -> None:
        """A mistyped year must not keep a player 'active', be their lastPlayed or dates.latest."""
        log = leaderboard_log()
        log.append(dated("Z0", "2062/10/05", "三紅", ["老人"] + SEAT_NAMES[1:]))  # 老人's only game since 2024
        log += [dated(f"Z{i}", "2062/10/06", "三藍活", ["未來人"] + SEAT_NAMES[1:]) for i in range(1, 6)]  # future games only
        cache = build_fresh(log)
        lb = cache["leaderboard"]
        self.assertEqual(lb["dates"], {"parsed": 42, "unparsed": 10, "earliest": "2024-11-01", "latest": "2026-10-10"})
        boards = {b["id"]: b for b in lb["boards"]}
        self.assertNotIn("老人", {r["name"] for r in boards["main"]["rows"]})  # still not active
        self.assertEqual([r["name"] for r in boards["newcomers"]["rows"]], ["新人"])  # 未來人 has no dated first game
        self.assertEqual(next(r["games"] for r in boards["main"]["rows"] if r["name"] == "乙"), 40)  # in no window
        rows = {p["name"]: p for p in cache["players"]["players"]}
        self.assertEqual((rows["老人"]["totalGames"], rows["老人"]["firstPlayed"], rows["老人"]["lastPlayed"]),
                         (3.0, "2024-11-01", "2024-11-02"))
        self.assertEqual((rows["未來人"]["totalGames"], rows["未來人"]["firstPlayed"], rows["未來人"]["lastPlayed"]), (5.0, "", ""))

    def test_nobody_active_means_no_boards(self) -> None:
        rows = [LOG_HEADERS] + [dated(f"A{i}", "2024/11/01", "三紅") for i in range(22)]
        lb = build_fresh(rows)["leaderboard"]
        self.assertEqual(lb["boards"], [])
        self.assertEqual(gc.leaderboard_summary(lb), "asOf 2026-10-12；沒有可做的榜；日期可解析 22 局、無日期 0 局")
        self.assertIn("main 10 人（365 天）", gc.leaderboard_summary(self.lb))
        self.assertEqual(gc.leaderboard_summary(None), "無")


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
        cache, games = self.build(leaderboard_log(), AS_OF + dt.timedelta(days=100), previous)  # windows moved past the games
        self.assertFalse(gc.only_the_day_changed(cache, previous, games))
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
        main = boards["main"]
        self.assertEqual((main["windowDays"], main["period"]), (365, "2025-03-02 ～ 2026-03-01"))
        self.assertGreaterEqual(len(main["rows"]), gc.LEADERBOARD_CONFIG["minBoardRows"])
        for r in main["rows"]:
            self.assertGreaterEqual(r["games"], 20)
            self.assertEqual(r["value"], gc.shrunk_excess(r["excessWinRate"], r["games"], 20))
        self.assertIn("online", boards)  # 線瓦 / 面瓦 / 娛樂 fill the 分類 column
        self.assertEqual((boards["roleTitles"]["period"], boards["roleTitles"]["windowDays"]), ("2026-02-01 ～ 2026-02-28", 28))
        self.assertEqual([r["role"] for r in boards["roleTitles"]["rows"]], ["刺客", "派西維爾", "梅林", "忠臣"])  # 23 games in Feb 2026
        self.assertEqual(boards["assassin"]["period"], "2026-02-23 ～ 2026-03-01")

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

if __name__ == "__main__":
    unittest.main(verbosity=2)
