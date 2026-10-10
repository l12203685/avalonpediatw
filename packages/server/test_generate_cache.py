"""Offline tests for generate_cache.py: credentials, sanity guards, carry-over, write path,
--compare, and the per-player stats it aggregates from 牌譜.

No network and no Google libraries needed (stdlib unittest; pytest also collects it).
Fixtures are fake, except two read-only checks against checked-in data: the committed
analysis_cache.json (CommittedCachePropertyTest) and the 牌譜 snapshot in
sheets_cache.json (RebuildReplayTest, skipped once a refresh replaced the 2026-04-26 cache).

    python packages/server/test_generate_cache.py
"""

from __future__ import annotations

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
CI_ENV = ("GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY", gc.ENV_CREDENTIALS_FILE, gc.ENV_CREDENTIALS_JSON, gc.ENV_SHEET_ID)


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
        "missions": {}, "lake": {}, "rounds": {}, "seatOrder": {}, "captainAnalysis": {},
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
    ["流水號", "文字記錄", "配置", "刺殺"] + [gc.PLAYER_COLUMNS[s] for s in gc.SEATS]
    + ["結果", "1-1"] + ROUND_RESULT_COLS + ["第一局", "第二局", "第三局", "第四局", "第五局", "局勢", "首湖", "二湖", "三湖"]
)


def log_row(gid: str, config: str, outcome: str, names: list[str]) -> list[str]:
    """One 牌譜 row; `names` are the 玩1..玩9, 玩0 cells (seat order of gc.SEATS)."""
    cells = {
        "流水號": gid, "文字記錄": "157\nooo\n2>8\n2468\noxo", "配置": config, "結果": outcome, "1-1": "157",
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
PLAYER_FIELDS = [
    "name", "totalGames", "winRate", "roleTheory", "positionTheory", "redWin", "blueWin",
    "red3Red", "redMerlinDead", "redMerlinAlive", "blue3Red", "blueMerlinDead", "blueMerlinAlive",
    "roleWinRates", "roleDistribution", "redRoleRate", "blueRoleRate",
    "seatWinRates", "seatRedWinRates", "seatBlueWinRates", "rawRoleGames",
    "rawRedWins", "rawBlueWins", "rawTotalWins", "rawRedGames", "rawBlueGames",
    "rawRedThreeRed", "rawRedMerlinDead", "rawRedMerlinAlive",
    "rawBlueThreeRed", "rawBlueMerlinDead", "rawBlueMerlinAlive", "roleSeatStats", "seatOutcomes",
]
EMPTY_OUTCOME = {"threeRed": 0, "threeBlueDead": 0, "threeBlueAlive": 0,
                 "threeRedPct": 0, "threeBlueDeadPct": 0, "threeBlueAlivePct": 0}


def per_role(**values: float) -> dict[str, float]:
    return {r: float(values.get(r, 0.0)) for r in ROLE_ORDER}


def per_seat(**values: float) -> dict[str, float]:
    return {s: float(values.get(f"s{s}", 0.0)) for s in SEAT_ORDER}


def aggregation_log() -> list[list[str]]:
    """配置 digits are the seats of 刺客 莫甘娜 莫德雷德 奧伯倫 派西維爾 梅林; other seats are 忠臣."""
    return [
        LOG_HEADERS,
        log_row("G1", "123456", "三紅", SEAT_NAMES),
        log_row("G2", "234560", "三藍活", SEAT_NAMES),
        log_row("G3", "098765", "三藍死", SEAT_NAMES[1:] + SEAT_NAMES[:1]),  # 甲 moves to seat 0 (= 10)
        log_row("G4", "123456", "", ["幽靈"] + SEAT_NAMES[1:]),  # 結果 not entered yet: not in player stats
        log_row("G5", "567890", "三藍活", [" 甲\u3000", "\u200b乙", "", "", "", "", "", "", "新人", ""]),
        log_row("", "123456", "三紅", SEAT_NAMES),  # no 流水號: not a game
        log_row("G7", "12345", "三紅", SEAT_NAMES),  # 配置 not 6 characters: not a game
    ]


# 甲: G1 刺客@1 三紅 (win), G2 忠臣@1 三藍活 (win), G3 刺客@10 三藍死 (loss: 三藍死 is a blue win),
#     G5 忠臣@1 三藍活 (win).
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
        self.assertEqual(list(jia), PLAYER_FIELDS)
        self.assertEqual(jia, EXPECTED_JIA)
        self.assertEqual(list(jia["roleSeatStats"]), list(EXPECTED_JIA["roleSeatStats"]))
        self.assertEqual(list(jia["seatWinRates"]), SEAT_ORDER)
        self.assertEqual(list(jia["roleWinRates"]), ROLE_ORDER)
        bing = {k: v for k, v in self.rows["丙"].items() if k != "seatOutcomes"}
        self.assertEqual(bing, EXPECTED_BING)
        for row in self.rows.values():  # counts are floats, like the committed cache
            self.assertIsInstance(row["totalGames"], float)
            self.assertIsInstance(row["rawRoleGames"]["忠臣"], float)

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
        self.assertEqual(jia["player"], {k: v for k, v in EXPECTED_JIA.items() if k != "seatOutcomes"})
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
            if list(row) != PLAYER_FIELDS:
                yield f"fields {list(row)}"
            for key in ("roleWinRates", "roleDistribution", "rawRoleGames"):
                if list(row[key]) != ROLE_ORDER:
                    yield f"{key} keys {list(row[key])}"
            for key in ("seatWinRates", "seatRedWinRates", "seatBlueWinRates", "seatOutcomes"):
                if list(row[key]) != SEAT_ORDER:
                    yield f"{key} keys {list(row[key])}"
            for key in PLAYER_FIELDS:
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
            rebuilt = tally_from_row(row).to_row(row["name"])
            original = {k: v for k, v in row.items() if k != "seatOutcomes"}
            if rebuilt != original or list(rebuilt) != list(original):
                yield "to_row(counts) differs: " + ", ".join(k for k in original if rebuilt.get(k) != original[k])
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

        self.assertEqual(dump(cache["players"]), dump(self.committed["players"]))
        self.assertEqual(dump(cache["playerDetails"]), dump(self.committed["playerDetails"]))
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
            quiet_env(**{gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY)}),
            mock.patch.object(gc, "open_spreadsheet", lambda source, sheet_id: FakeSheet(self.tabs)),
            mock.patch.object(gc, "gspread", GSPREAD_STUB),
        ]
        for p in self.patches:
            p.start()

    def tearDown(self) -> None:
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def run_main(self, *args: str, summary: bool = False) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        env = {"GITHUB_STEP_SUMMARY": str(self.summary)} if summary else {}
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
        self.assertEqual(set(first), set(gc.SHEET_SECTIONS) | {"strength"})
        self.assertEqual([p["name"] for p in first["players"]["players"]], E2E_PLAYERS)
        self.assertEqual(first["players"]["players"][0]["totalGames"], 4.0)

        first["featureStudies"] = {"generatedAt": "2026-04-27T15:04:56+08:00", "features": []}
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
        self.assertEqual(second["featureStudies"], first["featureStudies"])
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
