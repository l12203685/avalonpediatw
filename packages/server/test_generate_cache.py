"""Offline tests for generate_cache.py: credentials, sanity guard, carry-over, write path.

No network and no Google libraries needed (stdlib unittest; pytest also collects it).
All data below is fake.

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

    def test_same_growth_and_small_drop_pass(self) -> None:
        prev = fake_cache(games=2146)
        for games in (2146, 2200, 2146 - 22):
            with self.subTest(games=games):
                self.assertEqual(gc.validate_new_cache(fake_cache(games=games), prev), [])

    def test_large_game_drop_refused_unless_allowed(self) -> None:
        prev, new = fake_cache(games=2146), fake_cache(games=2146 - 23)
        problems = gc.validate_new_cache(new, prev)
        self.assertEqual(len(problems), 1)
        self.assertIn("23 fewer", problems[0])
        self.assertEqual(gc.validate_new_cache(new, prev, allow_shrink=True), [])

    def test_large_player_drop_refused(self) -> None:
        problems = gc.validate_new_cache(fake_cache(players=3), fake_cache(players=30))
        self.assertTrue(any("players" in p and "fewer" in p for p in problems), problems)

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
# End to end with a fake spreadsheet (no network)
# ---------------------------------------------------------------------------

def _stats_row(name: str, games: int) -> list[str]:
    row = [""] * 107
    row[0], row[1], row[2], row[3], row[4] = name, str(games), "50%", "52.5%", "51%"
    for j in range(7):
        row[13 + j], row[20 + j], row[98 + j] = "50%", "10%", "4"
    for j in range(10):
        row[29 + j], row[42 + j], row[52 + j] = "50%", "50%", "50%"
    row[95], row[96], row[97], row[105], row[106] = "3", "5", "8", "6", "10"
    return row


GAME_HEADERS = ["流水號", "文字記錄", "配置", "結果", "1-1",
                "第一局成功失敗", "第二局成功失敗", "第三局成功失敗", "第四局成功失敗", "第五局成功失敗",
                "第一局", "第二局", "第三局", "第四局", "第五局", "局勢", "首湖", "二湖", "三湖"]


def fake_tabs(n_games: int = 4) -> dict[str, list[list[str]]]:
    configs = ["123456", "987654", "246802", "135790"]
    outcomes = ["三紅", "三藍活", "三藍死", "三藍活"]
    games = [GAME_HEADERS]
    for i in range(n_games):
        games.append([f"T{i}", "157\nooo\n2>8\n2468\noxo", configs[i % 4], outcomes[i % 4], "157",
                      "ooo", "oxo", "ooo", "", "", "藍", "紅", "藍", "", "", "藍紅藍", "7>1", "", ""])
    players = ["玩家甲", "玩家乙", "玩家丙"]
    chem = [[""] + players] + [[p] + ["" if p == q else "55%" for q in players] for p in players]
    return {
        "牌譜": games,
        "生涯報表": [["總計"] + [""] * 106, ["玩家"] + [""] * 106] + [_stats_row(p, 20 + i) for i, p in enumerate(players)],
        **{tab: chem for tab in ("同贏", "同輸", "贏相關", "同贏-同輸")},
    }


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

    def run_main(self, *args: str) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = gc.main(["--output", str(self.out), *args])
        return rc, out.getvalue() + err.getvalue()

    def test_refresh_carry_over_idempotence_and_guard(self) -> None:
        rc, log = self.run_main()  # first ever run: no previous file
        self.assertEqual(rc, 0, log)
        first = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(first["overview"]["totalGames"], 4)
        self.assertEqual(set(first), set(gc.SHEET_SECTIONS) | {"strength"})

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
        self.assertEqual(second["featureStudies"], first["featureStudies"])
        self.assertEqual(second["archetype"]["perPlayer"]["玩家甲"], {"hasData": True})
        self.assertFalse(second["archetype"]["perPlayer"]["玩家乙"]["hasData"])  # placeholder for the rest
        carried_line = next(line for line in log.splitlines() if "carried over from the existing cache" in line)
        self.assertIn("archetype (+2 placeholder rows)", carried_line)
        self.assertIn("featureStudies", carried_line)

        rc, _ = self.run_main()  # unchanged Sheet -> byte-identical file (workflow sees no diff)
        self.assertEqual(rc, 0)
        self.assertEqual(self.out.read_bytes(), second_bytes)

        self.tabs["生涯報表"] = self.tabs["生涯報表"][:2]  # stats tab emptied -> refuse, keep file
        rc, log = self.run_main("--allow-shrink")
        self.assertEqual(rc, gc.EXIT_DATA)
        self.assertIn("players.players is empty", log)
        self.assertEqual(self.out.read_bytes(), second_bytes)
        self.assertEqual(sorted(os.listdir(self.tmp.name)), ["analysis_cache.json"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
