"""
Pre-compute all analysis API responses and write to analysis_cache.json.

Reads the Avalon Google Sheet via a service account and writes
analysis_cache.json with keys matching each API endpoint. The server reads this
file and returns it directly -- zero parsing at runtime.

Runs on the owner's PC and, daily, in GitHub Actions
(.github/workflows/refresh-analysis-cache.yml), which commits the result.

Usage:
    python generate_cache.py                 # owner's PC: default key path below
    python generate_cache.py --compare       # dry run: show what would change, write nothing
    python generate_cache.py --allow-shrink  # accept a deliberate drop in games/players

Configuration (environment variables, all optional, checked in this order):
    AVALON_STATS_CREDENTIALS_FILE  path to a service-account JSON key file
    AVALON_STATS_CREDENTIALS_JSON  the key file's JSON content
    (neither set)                  C:\\Users\\admin\\.claude\\credentials\\google_sheets_concise_beanbag.json
    AVALON_STATS_SHEET_ID          spreadsheet id (default: SHEET_ID below)

Where each top-level section comes from:
    refreshed from the Sheet  overview, players, playerDetails, missions, lake,
                              rounds, seatOrder, captainAnalysis (all from the
                              牌譜 game log; players = every name in 玩1..玩0,
                              see compute_player_stats) and chemistry (同贏 /
                              同輸 / 贏相關 / 同贏-同輸 tabs). 生涯報表 is not read.
                              The game log is 牌譜 plus, when that tab exists,
                              Discord匯入 (games discord_records_import.py
                              copied from the Discord forum, same columns);
                              a Discord匯入 game whose record_fingerprint is
                              already in 牌譜 is dropped (牌譜 wins), see
                              merge_game_logs.
    recomputed here           strength (from players, via
                              scripts/build_archetype_strength.py)
    carried over              archetype, playstyle, featureStudies and any other
                              section this script does not build. They are made
                              by scripts/build_*.py from files that exist only on
                              the owner's PC, so they are copied unchanged from
                              the existing analysis_cache.json; players new since
                              then get the same hasData=false placeholder rows
                              those scripts write.

Safety: the new cache is checked before it replaces the old file. The write is
refused (exit 4) if it is empty or malformed, has fewer games in total than the
existing file, has any existing player with fewer games (games are only ever
appended to 牌譜), has more than max(5, 1%) fewer players, or has an emptied
chemistry matrix (all overridable with --allow-shrink), or if players rows would
lose fields the existing file has (only --allow-field-loss overrides that; CI
never passes it). --compare runs everything up to the write, prints what would
change (players, games, top-10 by games, player fields that changed for many
players, the guard verdict; also to $GITHUB_STEP_SUMMARY) and exits like the
real run would, without writing.

History: the players rows used to come from the 生涯報表 tab (>=30-game players
only, ~62 rows). Commit 61b7398 (2026-04-26) replaced the committed cache with
198 players aggregated from a raw 牌譜 export by a one-shot script that is not
in the repo; compute_player_stats reproduces its formulas (see the comment
there and test_generate_cache.py). Its outcomes were re-derived from the mission
strings instead of 結果; this script uses 結果 (see OUTCOMES).

Exit codes: 0 ok, 2 credentials misconfigured, 3 Google refused access
(auth / sheet not shared / not found), 4 data check failed, nothing written.
"""

from __future__ import annotations

import argparse
import contextlib
import functools
import importlib.util
import json
import math
import os
import re
import stat
import sys
import tempfile
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

try:
    import gspread
    from google.oauth2.service_account import Credentials
except ImportError:  # the pure helpers (and the unit tests) work without the Google libs
    gspread = None  # type: ignore[assignment]
    Credentials = None  # type: ignore[assignment]

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEFAULT_CREDENTIALS_PATH = Path(r"C:\Users\admin\.claude\credentials\google_sheets_concise_beanbag.json")
CREDENTIALS_PATH = DEFAULT_CREDENTIALS_PATH  # kept for anyone importing the old name
SHEET_ID = "174L-by-dtP6IY1pRy8nMpG6_3RMBQXmAV4kTfIgmyIU"
OUTPUT_PATH = Path(__file__).parent / "analysis_cache.json"
SCRIPTS_DIR = Path(__file__).resolve().parent / "scripts"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

ENV_CREDENTIALS_FILE = "AVALON_STATS_CREDENTIALS_FILE"
ENV_CREDENTIALS_JSON = "AVALON_STATS_CREDENTIALS_JSON"
ENV_SHEET_ID = "AVALON_STATS_SHEET_ID"

# Game-log tabs. 牌譜 is required; DISCORD_IMPORT_TAB is optional (written only by
# discord_records_import.py, append-only, same columns as 牌譜 plus discord_* ones).
GAME_LOG_TAB = "牌譜"
DISCORD_IMPORT_TAB = "Discord匯入"

# Sections built from the Sheet by this script.
SHEET_SECTIONS = (
    "overview", "players", "playerDetails", "chemistry", "missions",
    "lake", "rounds", "seatOrder", "captainAnalysis",
)
# Sections recomputed here from the refreshed players.
DERIVED_SECTIONS = ("strength",)
# Sections built on the owner's PC from files not in the repo (carried over).
OWNER_PC_SECTIONS = ("archetype", "playstyle", "featureStudies")
CHEMISTRY_MATRICES = ("coWin", "coLose", "winCorr", "coWinMinusLose")

# Sanity guard: allowed drop vs. the existing cache = max(ABS, PCT% of it).
SHRINK_TOLERANCE_ABS = 5
SHRINK_TOLERANCE_PCT = 1.0

EXIT_CONFIG = 2
EXIT_GOOGLE_ACCESS = 3
EXIT_DATA = 4

# overview.topPlayersByTheory only ranks players with at least this many games.
# 30 (the 生涯報表 cut-off) is what the committed cache (commit 61b7398) used.
MIN_GAMES_THRESHOLD = 30

CONFIG_ROLE_ORDER = ["刺客", "莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林"]
RED_ROLES = {"刺客", "莫甘娜", "莫德雷德", "奧伯倫"}
BLUE_ROLES = {"派西維爾", "梅林", "忠臣"}
ALL_ROLES = ("刺客", "莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林", "忠臣")

# 牌譜 seat characters in table order; "0" is seat 10. Player names are in 玩1..玩9, 玩0.
SEATS = ("1", "2", "3", "4", "5", "6", "7", "8", "9", "0")
PLAYER_COLUMNS = {s: f"玩{s}" for s in SEATS}
SEAT_LABELS = {s: ("10" if s == "0" else s) for s in SEATS}  # roleSeatStats keys use 1..10

# 結果 values. NB: like the rest of this script and the committed cache, 三藍死
# (blue completed 3 missions, Merlin assassinated) counts as a BLUE win.
# The one-shot rebuild behind the committed cache (commit 61b7398) did not read
# 結果: it re-derived the outcome from the 第N局成功失敗 strings and 刺殺, counting
# any "x" as a failed mission (wrong for the 10-player 4th mission, which needs
# two fails): 27 games that 結果 records as 三藍死/三藍活 became 三紅 there, plus
# row 1276, whose names and result its export lost (999/499/648 instead of
# 結果's 971/516/659). This script keeps using 結果 everywhere, players included.
OUTCOME_THREE_RED = "三紅"
OUTCOME_BLUE_DEAD = "三藍死"
OUTCOME_BLUE_ALIVE = "三藍活"
OUTCOMES = (OUTCOME_THREE_RED, OUTCOME_BLUE_DEAD, OUTCOME_BLUE_ALIVE)

# How many offenders the "player lost games" guard names.
MAX_LISTED_REGRESSIONS = 8


# ---------------------------------------------------------------------------
# Errors and reporting
# ---------------------------------------------------------------------------

class FatalError(Exception):
    """A failure with a clear message for the owner; nothing has been written."""

    def __init__(self, message: str, exit_code: int, title: str = "Analysis cache refresh failed"):
        super().__init__(message)
        self.exit_code = exit_code
        self.title = title


def _in_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def _escape_workflow_data(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_workflow_property(text: str) -> str:
    return _escape_workflow_data(text).replace(":", "%3A").replace(",", "%2C")


def emit_error(message: str, title: str = "Analysis cache refresh failed") -> None:
    """Print an error; inside GitHub Actions as an ::error:: annotation."""
    if _in_github_actions():
        print(f"::error title={_escape_workflow_property(title)}::{_escape_workflow_data(message)}", flush=True)
    else:
        print(f"[ERROR] {title}: {message}", file=sys.stderr, flush=True)


def _short(text: object, limit: int = 300) -> str:
    s = " ".join(str(text).split())
    return s if len(s) <= limit else s[: limit - 3] + "..."


# ---------------------------------------------------------------------------
# Credentials and sheet id
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CredentialSource:
    """Where the service-account key comes from. Never holds or prints more than needed."""

    kind: str  # "file" or "json"
    origin: str  # human-readable origin, e.g. "env AVALON_STATS_CREDENTIALS_FILE"
    path: Path | None = None
    info: dict | None = field(default=None, repr=False)  # parsed key; repr=False keeps it out of logs

    def describe(self) -> str:
        return f"{self.origin} ({self.path})" if self.kind == "file" else self.origin

    def client_email(self) -> str | None:
        """The service account's email (not secret), or None if unavailable."""
        info = self.info
        if info is None and self.path is not None:
            try:
                info = json.loads(self.path.read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                return None
        if isinstance(info, dict):
            email = info.get("client_email")
            if isinstance(email, str) and email.strip():
                return email.strip()
        return None


def resolve_credentials_source(env: Mapping[str, str] | None = None) -> CredentialSource:
    """AVALON_STATS_CREDENTIALS_FILE, else AVALON_STATS_CREDENTIALS_JSON, else the default path."""
    env = os.environ if env is None else env

    file_value = (env.get(ENV_CREDENTIALS_FILE) or "").strip()
    if file_value:
        path = Path(file_value).expanduser()
        if not path.is_file():
            raise FatalError(
                f"{ENV_CREDENTIALS_FILE} is set to {path}, but that file does not exist.",
                EXIT_CONFIG, "Credentials not found",
            )
        return CredentialSource(kind="file", origin=f"env {ENV_CREDENTIALS_FILE}", path=path)

    json_value = (env.get(ENV_CREDENTIALS_JSON) or "").strip()
    if json_value:
        try:
            info = json.loads(json_value)
        except ValueError as exc:
            # Only the position is reported: the value is a private key.
            pos = f" (line {exc.lineno}, column {exc.colno})" if isinstance(exc, json.JSONDecodeError) else ""
            raise FatalError(
                f"{ENV_CREDENTIALS_JSON} is not valid JSON{pos}. Paste the whole service-account key file content.",
                EXIT_CONFIG, "Credentials malformed",
            ) from None
        if not isinstance(info, dict):
            raise FatalError(
                f"{ENV_CREDENTIALS_JSON} must be a JSON object (a service-account key file).",
                EXIT_CONFIG, "Credentials malformed",
            )
        return CredentialSource(kind="json", origin=f"env {ENV_CREDENTIALS_JSON}", info=info)

    return CredentialSource(kind="file", origin="default path", path=DEFAULT_CREDENTIALS_PATH)


def resolve_sheet_id(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    return (env.get(ENV_SHEET_ID) or "").strip() or SHEET_ID


def _require_google_libs() -> None:
    if gspread is None or Credentials is None:
        raise FatalError(
            "gspread / google-auth are not installed. Run: pip install -r packages/server/requirements-stats.txt",
            EXIT_CONFIG, "Missing Python dependencies",
        )


def load_credentials(source: CredentialSource, scopes: list[str] | None = None):
    """Service-account credentials (read-only Sheets scope unless `scopes` says otherwise)."""
    _require_google_libs()
    scopes = scopes or SCOPES
    try:
        if source.kind == "json":
            return Credentials.from_service_account_info(source.info, scopes=scopes)
        return Credentials.from_service_account_file(str(source.path), scopes=scopes)
    except FileNotFoundError:
        raise FatalError(
            f"Service-account key file not found: {source.path}. "
            f"Set {ENV_CREDENTIALS_FILE} (path) or {ENV_CREDENTIALS_JSON} (key JSON).",
            EXIT_CONFIG, "Credentials not found",
        ) from None
    except OSError as exc:
        raise FatalError(
            f"Cannot read the service-account key from {source.describe()}: {type(exc).__name__}.",
            EXIT_CONFIG, "Credentials unreadable",
        ) from None
    except Exception as exc:  # building credentials is local (no network): any failure = bad key
        # google-auth's ValueError/KeyError texts name missing fields only; other errors
        # (e.g. pyasn1 parsing private_key) are reported by type so no key material is echoed.
        detail = f": {_short(exc, 200)}" if isinstance(exc, (ValueError, KeyError)) else ""
        raise FatalError(
            f"The key from {source.describe()} is not a valid service-account key "
            f"({type(exc).__name__}{detail}). Paste the whole JSON key file, unmodified.",
            EXIT_CONFIG, "Credentials malformed",
        ) from None


def open_spreadsheet(source: CredentialSource, sheet_id: str, scopes: list[str] | None = None) -> gspread.Spreadsheet:
    gc = gspread.authorize(load_credentials(source, scopes))
    return gc.open_by_key(sheet_id)


def connect() -> gspread.Spreadsheet:
    return open_spreadsheet(resolve_credentials_source(), resolve_sheet_id())


def classify_google_error(exc: BaseException) -> str | None:
    """'auth', 'permission', 'not_found', 'missing_worksheet' or None (anything else).

    Works on class names / status codes so it needs no gspread or google-auth import.
    """
    names = {cls.__name__ for cls in type(exc).__mro__}
    if "TransportError" in names:  # network trouble while talking to Google, not an auth problem
        return None
    if names & {"RefreshError", "GoogleAuthError"}:
        return "auth"
    if "WorksheetNotFound" in names:
        return "missing_worksheet"
    if "SpreadsheetNotFound" in names:
        return "not_found"
    if isinstance(exc, PermissionError):  # gspread 6 raises this for HTTP 403 on open_by_key
        return "permission"
    status = getattr(getattr(exc, "response", None), "status_code", None)
    if status == 401:
        return "auth"
    if status == 403:
        return "permission"
    if status == 404:
        return "not_found"
    return None


def _google_error_detail(exc: BaseException) -> str:
    """The most informative message in the exception chain (Google's own error text)."""
    seen: set[int] = set()
    cur: BaseException | None = exc
    fallback = ""
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        error = getattr(cur, "error", None)
        if isinstance(error, Mapping) and error.get("message"):
            return _short(f"HTTP {error.get('code', '?')}: {error['message']}")
        if not fallback and str(cur):
            fallback = _short(f"{type(cur).__name__}: {cur}")
        cur = cur.__cause__ or cur.__context__
    return fallback or type(exc).__name__


def google_access_error_message(kind: str, exc: BaseException, sheet_id: str, email: str | None) -> str:
    who = email or "the service account (client_email missing from the key)"
    detail = _google_error_detail(exc)
    if kind == "auth":
        return (
            f"Google rejected the credentials of service account {who} ({detail}). "
            "The key may be deleted, disabled or malformed: create a new JSON key for this "
            "service account and update the secret."
        )
    if kind == "permission":
        lowered = detail.lower()
        if "has not been used" in lowered or "service_disabled" in lowered or "is disabled" in lowered:
            return (
                f"The Google Sheets API is disabled in the Google Cloud project of service account "
                f"{who} ({detail}). Enable the Google Sheets API for that project, then re-run."
            )
        return (
            f"Service account {who} has no access to spreadsheet {sheet_id} ({detail}). "
            f"Share the Google Sheet with {who} as Viewer, then re-run."
        )
    if kind == "not_found":
        return (
            f"Spreadsheet {sheet_id} was not found for service account {who} ({detail}). "
            f"Check the sheet id ({ENV_SHEET_ID}) and share the sheet with {who} as Viewer."
        )
    return (
        f"A required worksheet is missing from spreadsheet {sheet_id} ({detail}). "
        "Was a tab renamed? Nothing was written."
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def decode_config(config: str) -> dict[str, str]:
    seat_role: dict[str, str] = {}
    for i, digit in enumerate(config):
        if i < len(CONFIG_ROLE_ORDER):
            seat_role[digit] = CONFIG_ROLE_ORDER[i]
    for s in "1234567890":
        if s not in seat_role:
            seat_role[s] = "忠臣"
    return seat_role


def role_faction(role: str) -> str:
    if role in RED_ROLES:
        return "紅方"
    if role in BLUE_ROLES:
        return "藍方"
    return ""


def parse_lake(lake_str: str) -> tuple[str, str] | None:
    if not lake_str or ">" not in lake_str:
        return None
    cleaned = lake_str.replace("x", "")
    parts = cleaned.split(">")
    if len(parts) == 2:
        return (parts[0].strip(), parts[1].strip())
    return None


def count_mission_fails(s: str) -> int:
    return s.count("x") if s else 0


def rnd1(n: float) -> float:
    """Round to 1 decimal place."""
    return round(n * 10) / 10


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

class GameRow:
    __slots__ = (
        "id", "config", "seat_roles", "seat_players", "outcome",
        "red_win", "blue_win", "merlin_killed",
        "r11_seats", "r11_roles", "r11_red_count", "r11_blue_count",
        "r11_has_merlin", "r11_has_percival",
        "missions",
        "lake1", "lake2", "lake3",
        "lake1_holder_faction", "lake1_target_faction",
        "lake1_holder_role", "lake1_target_role",
        "lake2_holder_faction", "lake2_target_faction",
        "lake2_holder_role", "lake2_target_role",
        "lake3_holder_faction", "lake3_target_faction",
        "lake3_holder_role", "lake3_target_role",
        "game_state", "rounds", "round_results",
        "text_record",
    )


# ---------------------------------------------------------------------------
# Load game log (牌譜)
# ---------------------------------------------------------------------------

_INVISIBLE_CHARS_RE = re.compile("[\u200b\u200c\u200d\u2060\ufeff]")


def normalize_player_name(raw: object) -> str:
    """A 玩1..玩0 cell as a player key: '' for an empty seat.

    Drops zero-width characters, trims and collapses any whitespace (incl.
    full-width U+3000 and NBSP) to single spaces. Case is kept: the committed
    cache counts e.g. 'Sin', 'SIN' and 'sin' as three players.
    """
    if not raw:
        return ""
    return " ".join(_INVISIBLE_CHARS_RE.sub("", str(raw)).split())


def read_optional_worksheet(sh: gspread.Spreadsheet, title: str) -> list[list[str]] | None:
    """get_all_values() of tab `title`, or None if the spreadsheet has no such tab."""
    try:
        ws = sh.worksheet(title)
    except Exception as exc:  # gspread's WorksheetNotFound, matched by name (see classify_google_error)
        if classify_google_error(exc) == "missing_worksheet":
            return None
        raise
    return ws.get_all_values()


def load_game_logs(sh: gspread.Spreadsheet) -> "GameLogMerge":
    """牌譜 (required) + Discord匯入 (optional), merged by merge_game_logs."""
    main = sh.worksheet(GAME_LOG_TAB).get_all_values()
    extra = read_optional_worksheet(sh, DISCORD_IMPORT_TAB)
    return merge_game_logs(main, extra)


def load_game_log(sh: gspread.Spreadsheet) -> list[GameRow]:
    return load_game_logs(sh).games


# ---------------------------------------------------------------------------
# Game fingerprint: the same game in 牌譜 and in Discord匯入
# ---------------------------------------------------------------------------
#
# 配置 + the team of every proposal (seats sorted, 0 = seat 10 last) + every mission
# result (as counts: o's then x's). Lake lines and vote anomalies are left out (they are
# the parts most often retyped differently). discord_records_import.py uses this same
# function on both sides; it writes 文字記錄 in this canonical one-item-per-line form.

_FP_MISSION_RE = re.compile(r"^[oxOX]+$")
_FP_TEAM_RE = re.compile(r"^[0-9]+")
# A Discord footer pasted into 文字記錄 ("刺客刺殺：x", "1.name" lines) ends the record.
_FP_FOOTER_RE = re.compile(r"^(?:刺客刺殺|刺殺)|^(?:10|[0-9])\s*[.．、]\s*\S")


def _seat_number(ch: str) -> int:
    return 10 if ch == "0" else int(ch)


def record_fingerprint_parts(config: str, text: str) -> tuple[str, tuple[str, ...], tuple[str, ...]]:
    """(配置, proposal teams, mission results) of a 文字記錄, normalized for comparison."""
    config = (config or "").strip()
    teams: list[str] = []
    missions: list[str] = []
    for raw in re.split(r"\r\n|\r|\n", text or ""):
        line = unicodedata.normalize("NFKC", raw).strip()
        if not line:
            continue
        if _FP_FOOTER_RE.match(line) or (config and line == config):
            break
        if _FP_MISSION_RE.match(line):
            low = line.lower()
            missions.append("o" * low.count("o") + "x" * low.count("x"))
            continue
        if ">" in line:  # lake line
            continue
        m = _FP_TEAM_RE.match(line)
        if m:
            teams.append("".join(sorted(m.group(0), key=_seat_number)))
    return config, tuple(teams), tuple(missions)


def record_fingerprint(config: str, text: str) -> str:
    cfg, teams, missions = record_fingerprint_parts(config, text)
    return f"{cfg}|{','.join(teams)}|{','.join(missions)}"


@dataclass
class GameLogMerge:
    """The games of 牌譜 plus the Discord匯入 games not already in 牌譜."""

    games: list[GameRow]
    main_games: int = 0
    extra_games: int = 0  # readable games in Discord匯入
    extra_added: int = 0
    extra_duplicates: int = 0  # dropped: fingerprint or 流水號 already seen (牌譜 wins)

    def summary(self) -> str:
        text = f"{self.main_games} from {GAME_LOG_TAB}"
        if self.extra_games:
            text += f" + {self.extra_added} from {DISCORD_IMPORT_TAB}"
            if self.extra_duplicates:
                text += f" ({self.extra_duplicates} more were games already counted, skipped)"
        return text


def merge_game_logs(main_rows: list[list[str]], extra_rows: list[list[str]] | None) -> GameLogMerge:
    """牌譜 games as they are, then each Discord匯入 game whose fingerprint and 流水號 are new.

    牌譜 rows are never deduplicated among themselves (as before this tab existed).
    """
    games = parse_game_log(main_rows)
    merged = GameLogMerge(games=games, main_games=len(games))
    if not extra_rows:
        return merged
    seen_fp = {record_fingerprint(g.config, g.text_record) for g in games}
    seen_id = {g.id for g in games}
    for g in parse_game_log(extra_rows):
        merged.extra_games += 1
        fp = record_fingerprint(g.config, g.text_record)
        if fp in seen_fp or g.id in seen_id:
            merged.extra_duplicates += 1
            continue
        seen_fp.add(fp)
        seen_id.add(g.id)
        games.append(g)
        merged.extra_added += 1
    return merged


def parse_game_log(rows: list[list[str]]) -> list[GameRow]:
    """牌譜 rows (header first, as gspread's get_all_values returns them) -> games.

    Rows without 流水號 or without a 6-character 配置 are skipped.
    """
    if len(rows) < 2:
        return []

    headers = rows[0]
    h_idx: dict[str, int] = {}
    for i, h in enumerate(headers):
        h = (h or "").strip()
        if h not in h_idx:
            h_idx[h] = i

    def col(row: list[str], name: str) -> str:
        idx = h_idx.get(name)
        if idx is None or idx >= len(row):
            return ""
        return row[idx] or ""

    round_names = ["第一局", "第二局", "第三局", "第四局", "第五局"]
    round_result_names = [
        "第一局成功失敗", "第二局成功失敗", "第三局成功失敗",
        "第四局成功失敗", "第五局成功失敗",
    ]

    game_rows: list[GameRow] = []

    for i in range(1, len(rows)):
        row = rows[i]
        gid = col(row, "流水號").strip()
        if not gid:
            continue
        config = col(row, "配置").strip()
        if len(config) != 6:
            continue

        g = GameRow()
        g.id = gid
        g.config = config
        g.seat_roles = decode_config(config)
        g.seat_players = {}
        for seat in SEATS:
            name = normalize_player_name(col(row, PLAYER_COLUMNS[seat]))
            if name:
                g.seat_players[seat] = name
        g.text_record = col(row, "文字記錄")
        g.outcome = col(row, "結果").strip()
        g.red_win = g.outcome == "三紅"
        g.blue_win = g.outcome in ("三藍死", "三藍活")
        g.merlin_killed = g.outcome == "三藍死"

        # 1-1 team
        r11_str = col(row, "1-1")
        g.r11_seats = list(r11_str) if r11_str else []
        g.r11_roles = [g.seat_roles.get(s, "?") for s in g.r11_seats]
        g.r11_red_count = sum(1 for r in g.r11_roles if r in RED_ROLES)
        g.r11_blue_count = sum(1 for r in g.r11_roles if r in BLUE_ROLES)
        g.r11_has_merlin = "梅林" in g.r11_roles
        g.r11_has_percival = "派西維爾" in g.r11_roles

        # Missions
        g.missions = []
        for m_idx in range(5):
            result_str = col(row, round_result_names[m_idx])
            if not result_str:
                continue
            g.missions.append({
                "round": m_idx + 1,
                "result": result_str,
                "fails": count_mission_fails(result_str),
                "total": len(result_str),
            })

        # Lake
        def lake_factions(lake_parsed, seat_roles):
            if lake_parsed is None:
                return ("", "", "", "")
            h_role = seat_roles.get(lake_parsed[0], "")
            t_role = seat_roles.get(lake_parsed[1], "")
            return (
                role_faction(h_role) if h_role else "",
                role_faction(t_role) if t_role else "",
                h_role,
                t_role,
            )

        g.lake1 = parse_lake(col(row, "首湖"))
        g.lake2 = parse_lake(col(row, "二湖"))
        g.lake3 = parse_lake(col(row, "三湖"))

        l1 = lake_factions(g.lake1, g.seat_roles)
        l2 = lake_factions(g.lake2, g.seat_roles)
        l3 = lake_factions(g.lake3, g.seat_roles)

        g.lake1_holder_faction, g.lake1_target_faction, g.lake1_holder_role, g.lake1_target_role = l1
        g.lake2_holder_faction, g.lake2_target_faction, g.lake2_holder_role, g.lake2_target_role = l2
        g.lake3_holder_faction, g.lake3_target_faction, g.lake3_holder_role, g.lake3_target_role = l3

        g.game_state = col(row, "局勢")
        g.rounds = [col(row, n) for n in round_names]
        g.round_results = [col(row, n) for n in round_result_names]

        game_rows.append(g)

    return game_rows


# ---------------------------------------------------------------------------
# Per-player stats, aggregated from the 牌譜 game log
# ---------------------------------------------------------------------------
#
# Reproduces the players rows of the committed cache (commit 61b7398 built them
# from a raw 牌譜 export with a one-shot script). The formulas below were
# reverse-engineered from its 198 rows; test_generate_cache checks them two ways:
# CommittedCachePropertyTest (every row of analysis_cache.json equals the row
# rebuilt from its own raw counts) and RebuildReplayTest (fed the rebuild's
# inputs, i.e. the checked-in 牌譜 snapshot with its outcome rule, this code
# writes the committed players / playerDetails byte for byte).
#
#   a player = a distinct normalized 玩1..玩0 name; a game counts for each seat
#     that has a name and a 結果 of 三紅 / 三藍死 / 三藍活 (other 結果 values are
#     left out of the player stats so the outcome counts always add up)
#   win      = red role and 三紅, or blue role and 三藍死 / 三藍活 (see OUTCOMES)
#   rates    = rnd1(count / denominator * 100), 0.0 when the denominator is 0
#   raw*     = counts, written as floats (1080.0) like the committed cache
#   roleTheory     = rnd1(sum(roleDistribution[r] * roleWinRates[r]) / 100) over
#                    the ROUNDED values, i.e. the player's own win rate up to
#                    rounding noise (not the 1/10-4/10 role-pick weighting of
#                    packages/shared roleProbability.ts)
#   positionTheory = 0.0 for everyone (the rebuild never computed it)
#   roleSeatStats  = "角色|座號" (座號 1..10, seat 0 written as 10) for every
#                    role/seat the player had, in first-seen order
#   order    = totalGames descending, ties in order of first appearance in 牌譜
#   seatOutcomes / playerDetails: see compute_seat_outcomes_per_player and
#                    compute_player_details

def _rate(count: float, total: float) -> float:
    return rnd1(count / total * 100) if total else 0.0


class _PlayerTally:
    """Counts for one player while walking the game log."""

    __slots__ = (
        "games", "wins", "role_games", "role_wins", "faction_games", "faction_wins",
        "faction_outcomes", "seat_games", "seat_wins", "seat_faction_games",
        "seat_faction_wins", "role_seat",
    )

    def __init__(self) -> None:
        self.games = 0
        self.wins = 0
        self.role_games: Counter = Counter()
        self.role_wins: Counter = Counter()
        self.faction_games: Counter = Counter()  # "red" / "blue"
        self.faction_wins: Counter = Counter()
        self.faction_outcomes: Counter = Counter()  # (faction, 結果)
        self.seat_games: Counter = Counter()
        self.seat_wins: Counter = Counter()
        self.seat_faction_games: Counter = Counter()  # (seat, faction)
        self.seat_faction_wins: Counter = Counter()
        self.role_seat: dict[str, list[int]] = {}  # "角色|座號" -> [games, wins], first-seen order

    def add(self, seat: str, role: str, outcome: str, won: bool) -> None:
        faction = "red" if role in RED_ROLES else "blue"
        w = 1 if won else 0
        self.games += 1
        self.wins += w
        self.role_games[role] += 1
        self.role_wins[role] += w
        self.faction_games[faction] += 1
        self.faction_wins[faction] += w
        self.faction_outcomes[(faction, outcome)] += 1
        self.seat_games[seat] += 1
        self.seat_wins[seat] += w
        self.seat_faction_games[(seat, faction)] += 1
        self.seat_faction_wins[(seat, faction)] += w
        cell = self.role_seat.setdefault(f"{role}|{SEAT_LABELS[seat]}", [0, 0])
        cell[0] += 1
        cell[1] += w

    def to_row(self, name: str) -> dict:
        total = self.games
        red_games, blue_games = self.faction_games["red"], self.faction_games["blue"]
        role_win_rates = {r: _rate(self.role_wins[r], self.role_games[r]) for r in ALL_ROLES}
        role_distribution = {r: _rate(self.role_games[r], total) for r in ALL_ROLES}
        # Same expression (order and rounding) as the rebuild; see the block comment above.
        role_theory = rnd1(sum(role_distribution[r] * role_win_rates[r] for r in ALL_ROLES) / 100)

        def outcomes(faction: str, outcome: str) -> int:
            return self.faction_outcomes[(faction, outcome)]

        def seat_rates(faction: str | None) -> dict[str, float]:
            if faction is None:
                return {s: _rate(self.seat_wins[s], self.seat_games[s]) for s in SEATS}
            return {
                s: _rate(self.seat_faction_wins[(s, faction)], self.seat_faction_games[(s, faction)])
                for s in SEATS
            }

        return {
            "name": name,
            "totalGames": float(total),
            "winRate": _rate(self.wins, total),
            "roleTheory": role_theory,
            "positionTheory": 0.0,
            "redWin": _rate(self.faction_wins["red"], red_games),
            "blueWin": _rate(self.faction_wins["blue"], blue_games),
            "red3Red": _rate(outcomes("red", OUTCOME_THREE_RED), red_games),
            "redMerlinDead": _rate(outcomes("red", OUTCOME_BLUE_DEAD), red_games),
            "redMerlinAlive": _rate(outcomes("red", OUTCOME_BLUE_ALIVE), red_games),
            "blue3Red": _rate(outcomes("blue", OUTCOME_THREE_RED), blue_games),
            "blueMerlinDead": _rate(outcomes("blue", OUTCOME_BLUE_DEAD), blue_games),
            "blueMerlinAlive": _rate(outcomes("blue", OUTCOME_BLUE_ALIVE), blue_games),
            "roleWinRates": role_win_rates,
            "roleDistribution": role_distribution,
            "redRoleRate": _rate(red_games, total),
            "blueRoleRate": _rate(blue_games, total),
            "seatWinRates": seat_rates(None),
            "seatRedWinRates": seat_rates("red"),
            "seatBlueWinRates": seat_rates("blue"),
            "rawRoleGames": {r: float(self.role_games[r]) for r in ALL_ROLES},
            "rawRedWins": float(self.faction_wins["red"]),
            "rawBlueWins": float(self.faction_wins["blue"]),
            "rawTotalWins": float(self.wins),
            "rawRedGames": float(red_games),
            "rawBlueGames": float(blue_games),
            "rawRedThreeRed": float(outcomes("red", OUTCOME_THREE_RED)),
            "rawRedMerlinDead": float(outcomes("red", OUTCOME_BLUE_DEAD)),
            "rawRedMerlinAlive": float(outcomes("red", OUTCOME_BLUE_ALIVE)),
            "rawBlueThreeRed": float(outcomes("blue", OUTCOME_THREE_RED)),
            "rawBlueMerlinDead": float(outcomes("blue", OUTCOME_BLUE_DEAD)),
            "rawBlueMerlinAlive": float(outcomes("blue", OUTCOME_BLUE_ALIVE)),
            "roleSeatStats": {
                key: {"games": float(n), "wins": float(w), "winRate": _rate(w, n)}
                for key, (n, w) in self.role_seat.items()
            },
        }


def compute_player_stats(games: list[GameRow]) -> list[dict]:
    """players.players rows (without seatOutcomes) from the game log."""
    tallies: dict[str, _PlayerTally] = {}  # insertion order = first appearance
    for g in games:
        if g.outcome not in OUTCOMES:
            continue
        for seat in SEATS:
            name = g.seat_players.get(seat)
            if not name:
                continue
            role = g.seat_roles[seat]
            won = g.red_win if role in RED_ROLES else g.blue_win
            tallies.setdefault(name, _PlayerTally()).add(seat, role, g.outcome, won)
    rows = [t.to_row(name) for name, t in tallies.items()]
    rows.sort(key=lambda r: -r["totalGames"])  # stable: ties keep first-appearance order
    return rows


def game_log_summary(games: list[GameRow]) -> str:
    named = sum(1 for g in games if g.seat_players)
    unknown = sum(1 for g in games if g.outcome not in OUTCOMES)
    seats = sum(len(g.seat_players) for g in games)
    text = f"{named} of {len(games)} games name players ({seats} named seats)"
    if unknown:
        text += f"; {unknown} games have a 結果 other than {'/'.join(OUTCOMES)} and are left out of player stats"
    return text


# ---------------------------------------------------------------------------
# Load chemistry matrices
# ---------------------------------------------------------------------------

def compute_outcome_pair_matrix(
    chemistry: dict,
    overall_outcome: dict,
) -> dict:
    """5th chemistry matrix: per-pair three-outcome distribution among co-wins.

    Edward 2026-04-27 spec: the chemistry tab needs an outcome pair matrix that
    expresses, for each player pair, the **三紅 share among the games where the
    pair co-won**. The primary cell value (``values[i][j]``) is the inferred
    threeRedPct so the existing colour-scale renderer keeps working; auxiliary
    fields ``threeBlueDeadPct`` / ``threeBlueAlivePct`` ride alongside for the
    tooltip.

    Per-game co-win attribution is not currently available at this layer (the
    Google Sheet exposes pair aggregates, not per-game). As a first-ship we
    project the **overall outcome distribution** onto each cell: cells where
    coWin > 0 inherit the global threeRed/threeBlueDead/threeBlueAlive split.
    Empty / self cells stay null. When per-game pair data is wired up the
    projection can be replaced with direct counting; the schema and frontend
    do not need to change.
    """
    co_win = chemistry.get("coWin")
    if not co_win:
        return {"players": [], "rowLabels": [], "values": [], "threeBlueDeadPct": [], "threeBlueAlivePct": []}

    players: list[str] = list(co_win.get("players", []))
    row_labels: list[str] = list(co_win.get("rowLabels") or players)
    raw_values: list[list[float | None]] = list(co_win.get("values", []))

    three_red_pct = float(overall_outcome.get("threeRedPct", 0) or 0)
    three_blue_dead_pct = float(overall_outcome.get("threeBlueDeadPct", 0) or 0)
    three_blue_alive_pct = float(overall_outcome.get("threeBlueAlivePct", 0) or 0)

    values: list[list[float | None]] = []
    bd_matrix: list[list[float | None]] = []
    ba_matrix: list[list[float | None]] = []

    for ri in range(len(raw_values)):
        row_v: list[float | None] = []
        row_bd: list[float | None] = []
        row_ba: list[float | None] = []
        for ci in range(len(raw_values[ri])):
            cell = raw_values[ri][ci]
            if cell is None:
                row_v.append(None)
                row_bd.append(None)
                row_ba.append(None)
                continue
            if ri < len(row_labels) and ci < len(players) and row_labels[ri] == players[ci]:
                row_v.append(None)
                row_bd.append(None)
                row_ba.append(None)
                continue
            row_v.append(rnd1(three_red_pct))
            row_bd.append(rnd1(three_blue_dead_pct))
            row_ba.append(rnd1(three_blue_alive_pct))
        values.append(row_v)
        bd_matrix.append(row_bd)
        ba_matrix.append(row_ba)

    return {
        "players": players,
        "rowLabels": row_labels,
        "values": values,
        "threeBlueDeadPct": bd_matrix,
        "threeBlueAlivePct": ba_matrix,
    }


def load_chemistry(sh: gspread.Spreadsheet) -> dict:
    sheet_names = ["同贏", "同輸", "贏相關", "同贏-同輸"]
    keys = ["coWin", "coLose", "winCorr", "coWinMinusLose"]

    result: dict = {}
    for sheet_name, key in zip(sheet_names, keys):
        try:
            ws = sh.worksheet(sheet_name)
            rows = ws.get_all_values()
        except gspread.exceptions.WorksheetNotFound:
            result[key] = {"players": [], "values": []}
            continue

        if len(rows) < 2:
            result[key] = {"players": [], "values": []}
            continue

        players = [p for p in rows[0][1:] if p]
        # Track row labels separately — earlier versions assumed sheet row order
        # matched column order which caused visible ID mismatches when the
        # Google Sheets template reordered rows. Keep both arrays so the
        # frontend can label axes independently.
        row_labels: list[str] = []
        values: list[list[float | None]] = []
        for r in range(1, len(rows)):
            if not rows[r][0]:
                continue
            row_labels.append(rows[r][0])
            row_vals: list[float | None] = []
            for v in rows[r][1:]:
                cleaned = v.replace("%", "").strip() if v else ""
                try:
                    row_vals.append(float(cleaned))
                except (ValueError, TypeError):
                    row_vals.append(None)
            values.append(row_vals)

        result[key] = {"players": players, "rowLabels": row_labels, "values": values}

    return result


# ---------------------------------------------------------------------------
# Compute endpoint responses (matching sheetsAnalysis.ts exactly)
# ---------------------------------------------------------------------------

def compute_seat_position_win_rates(games: list[GameRow]) -> list[dict]:
    """Win rate by seat position (1-10), broken down by role assigned to that seat.

    Edward 2026-04-27 spec: every seat now also carries a three-outcome breakdown
    (三紅 / 三藍死 / 三藍活) so the frontend tooltip can show the per-seat outcome
    distribution alongside the overall win rate.
    """
    SEATS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    SEAT_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
    ALL_ROLES = ["刺客", "莫甘娜", "莫德雷德", "奧伯倫", "派西維爾", "梅林", "忠臣"]

    # seat_char -> role -> {wins, total}
    seat_role_stats: dict[str, dict[str, dict]] = {}
    # seat_char -> role -> list[GameRow]   (used to compute per-role outcomes)
    seat_role_games: dict[str, dict[str, list]] = {}
    # seat_char -> list[GameRow]           (used to compute per-seat outcomes)
    seat_games: dict[str, list] = {}
    for s in SEATS:
        seat_role_stats[s] = {}
        seat_role_games[s] = {}
        seat_games[s] = []

    for g in games:
        for seat_char in SEATS:
            role = g.seat_roles.get(seat_char, "")
            if not role:
                continue
            entry = seat_role_stats[seat_char].setdefault(role, {"wins": 0, "total": 0})
            entry["total"] += 1
            # Win = the faction of that role won
            if role in RED_ROLES and g.red_win:
                entry["wins"] += 1
            elif role in BLUE_ROLES and g.blue_win:
                entry["wins"] += 1
            seat_role_games[seat_char].setdefault(role, []).append(g)
            seat_games[seat_char].append(g)

    result: list[dict] = []
    for seat_char, label in zip(SEATS, SEAT_LABELS):
        roles_data: list[dict] = []
        total_wins = 0
        total_games_seat = 0
        for role in ALL_ROLES:
            stats = seat_role_stats[seat_char].get(role)
            if not stats or stats["total"] == 0:
                continue
            wr = rnd1(stats["wins"] / stats["total"] * 100)
            roles_data.append({
                "role": role,
                "winRate": wr,
                "games": stats["total"],
                "outcomes": _outcome_split(seat_role_games[seat_char].get(role, [])),
            })
            total_wins += stats["wins"]
            total_games_seat += stats["total"]

        overall_wr = rnd1(total_wins / total_games_seat * 100) if total_games_seat > 0 else 0
        result.append({
            "seat": label,
            "overallWinRate": overall_wr,
            "totalGames": total_games_seat,
            "roles": roles_data,
            "outcomes": _outcome_split(seat_games[seat_char]),
        })

    return result


def _empty_outcome() -> dict:
    return {
        "threeRed": 0, "threeBlueDead": 0, "threeBlueAlive": 0,
        "threeRedPct": 0, "threeBlueDeadPct": 0, "threeBlueAlivePct": 0,
    }


def scaled_outcome(global_outcome: Mapping[str, Any], total: int) -> dict:
    """The global 三紅/三藍死/三藍活 split projected onto `total` games.

    Same arithmetic as scripts/patch_cache_3outcome.py (which wrote the
    committed cache's seatOutcomes): counts are total * global pct, rounded,
    with 三藍活 taking the remainder; the pcts are the global pcts.
    """
    if total <= 0:
        return _empty_outcome()
    rp = float(global_outcome.get("threeRedPct", 0) or 0)
    bdp = float(global_outcome.get("threeBlueDeadPct", 0) or 0)
    bap = float(global_outcome.get("threeBlueAlivePct", 0) or 0)
    three_red = round(total * rp / 100.0)
    three_blue_dead = round(total * bdp / 100.0)
    return {
        "threeRed": three_red,
        "threeBlueDead": three_blue_dead,
        "threeBlueAlive": max(total - three_red - three_blue_dead, 0),
        "threeRedPct": rnd1(rp),
        "threeBlueDeadPct": rnd1(bdp),
        "threeBlueAlivePct": rnd1(bap),
    }


def compute_seat_outcomes_per_player(
    seat_position_win_rates: list[dict],
    outcome_breakdown: Mapping[str, Any],
    players: list[dict],
) -> dict[str, dict[str, dict]]:
    """players[].seatOutcomes: ``{player_name: {seat_char: OutcomeBreakdown}}``.

    Reproduces the committed cache, which got this field from
    scripts/patch_cache_3outcome.py (Edward 2026-04-27): NOT the player's own
    games but, for every seat where the player's seatWinRates is > 0, the
    global outcome split projected onto all games at that seat (the same for
    every such seat and player, e.g. 1000/500/646 for 999/499/648 in 2146
    games); zeros for the other seats (incl. seats played but never won).
    """
    totals = {s: 0 for s in SEATS}
    for row in seat_position_win_rates:
        for s, label in SEAT_LABELS.items():
            if str(row.get("seat")) == label:
                totals[s] = int(row.get("totalGames", 0) or 0)
    projected = {s: scaled_outcome(outcome_breakdown, totals[s]) for s in SEATS}

    out: dict[str, dict[str, dict]] = {}
    for p in players:
        seat_wr = p.get("seatWinRates", {}) or {}
        out[p["name"]] = {
            s: dict(projected[s]) if (seat_wr.get(s) or 0) > 0 else _empty_outcome()
            for s in SEATS
        }
    return out


def compute_overview(games: list[GameRow], players: list[dict]) -> dict:  # noqa: C901
    total = len(games)
    red_wins = sum(1 for g in games if g.red_win)
    blue_wins = sum(1 for g in games if g.blue_win)
    merlin_kills = sum(1 for g in games if g.merlin_killed)

    significant = [p for p in players if p["totalGames"] >= MIN_GAMES_THRESHOLD]

    # Fix #8: Use roleTheory (theoretical win rate) instead of raw winRate for ranking
    top_by_theory = sorted(significant, key=lambda p: p["roleTheory"], reverse=True)[:10]
    top_by_games = sorted(players, key=lambda p: p["totalGames"], reverse=True)[:10]

    merlin_kill_rate = 0.0
    if blue_wins > 0:
        merlin_kill_rate = rnd1(merlin_kills / (merlin_kills + (blue_wins - merlin_kills)) * 100)

    # Fix #10: Game outcome breakdown
    three_red = sum(1 for g in games if g.outcome == "三紅")
    three_blue_alive = sum(1 for g in games if g.outcome == "三藍活")
    three_blue_dead = sum(1 for g in games if g.outcome == "三藍死")

    return {
        "totalGames": total,
        "totalPlayers": len(players),
        "redWinRate": rnd1(red_wins / total * 100) if total > 0 else 0,
        "blueWinRate": rnd1(blue_wins / total * 100) if total > 0 else 0,
        "merlinKillRate": merlin_kill_rate,
        "outcomeBreakdown": {
            "threeRed": three_red,
            "threeBlueAlive": three_blue_alive,
            "threeBlueDead": three_blue_dead,
            "threeRedPct": rnd1(three_red / total * 100) if total > 0 else 0,
            "threeBlueAlivePct": rnd1(three_blue_alive / total * 100) if total > 0 else 0,
            "threeBlueDeadPct": rnd1(three_blue_dead / total * 100) if total > 0 else 0,
        },
        "topPlayersByTheory": [
            {"name": p["name"], "roleTheory": p["roleTheory"], "winRate": p["winRate"], "games": p["totalGames"]}
            for p in top_by_theory
        ],
        "topPlayersByGames": [
            {"name": p["name"], "games": p["totalGames"], "winRate": p["winRate"]}
            for p in top_by_games
        ],
        # Seat position win rates (replaces useless per-role win rate comparison)
        "seatPositionWinRates": compute_seat_position_win_rates(games),
    }


def compute_missions(games: list[GameRow]) -> dict:
    # Pass rate per mission round
    mission_pass_rates = []
    for r in range(1, 6):
        with_mission = [g for g in games if any(m["round"] == r for m in g.missions)]
        if not with_mission:
            continue
        passed = sum(
            1 for g in with_mission
            if any(m["round"] == r and m["fails"] == 0 for m in g.missions)
        )
        mission_pass_rates.append({
            "round": r,
            "passRate": rnd1(passed / len(with_mission) * 100),
            "totalGames": len(with_mission),
        })

    # Fix #4: Mission success rate by red player count in team (replaces fail card distribution)
    # Group missions by how many red players were on the team
    mission_by_composition: list[dict] = []
    for r in range(1, 6):
        red_count_groups: dict[int, dict] = {}
        for g in games:
            m = next((m2 for m2 in g.missions if m2["round"] == r), None)
            if m is None:
                continue
            # Count red players by checking the round's team composition
            round_str = g.rounds[r - 1] if r - 1 < len(g.rounds) else ""
            # We don't have per-mission team composition directly, use fail count as proxy
            fails = m["fails"]
            entry = red_count_groups.setdefault(fails, {"pass": 0, "fail": 0})
            if m["fails"] == 0:
                entry["pass"] += 1
            else:
                entry["fail"] += 1

    # Aggregate: mission success rate correlated with game outcome
    mission_outcome_corr: list[dict] = []
    for r in range(1, 6):
        with_mission = [g for g in games if any(m2["round"] == r for m2 in g.missions)]
        if not with_mission:
            continue
        passed_games = [g for g in with_mission if any(m2["round"] == r and m2["fails"] == 0 for m2 in g.missions)]
        failed_games = [g for g in with_mission if any(m2["round"] == r and m2["fails"] > 0 for m2 in g.missions)]

        pass_then_blue_win = sum(1 for g in passed_games if g.blue_win)
        fail_then_red_win = sum(1 for g in failed_games if g.red_win)

        mission_outcome_corr.append({
            "round": r,
            "passedGames": len(passed_games),
            "passedThenBlueWin": pass_then_blue_win,
            "passedBlueWinRate": rnd1(pass_then_blue_win / len(passed_games) * 100) if passed_games else 0,
            "passedOutcomes": _outcome_split(passed_games),
            "failedGames": len(failed_games),
            "failedThenRedWin": fail_then_red_win,
            "failedRedWinRate": rnd1(fail_then_red_win / len(failed_games) * 100) if failed_games else 0,
            "failedOutcomes": _outcome_split(failed_games),
        })

    # Per-round outcome breakdown
    mission_outcome_by_round = []
    for r in range(1, 6):
        with_mission = [g for g in games if any(m["round"] == r for m in g.missions)]
        if not with_mission:
            continue
        all_pass = 0
        one_fail = 0
        two_fail = 0
        for g in with_mission:
            m = next((m2 for m2 in g.missions if m2["round"] == r), None)
            if m is None:
                continue
            if m["fails"] == 0:
                all_pass += 1
            elif m["fails"] == 1:
                one_fail += 1
            else:
                two_fail += 1
        mission_outcome_by_round.append({
            "round": r,
            "allPass": all_pass,
            "oneFail": one_fail,
            "twoFail": two_fail,
            "total": len(with_mission),
        })

    return {
        "missionPassRates": mission_pass_rates,
        "missionOutcomeByRound": mission_outcome_by_round,
        "missionOutcomeCorrelation": mission_outcome_corr,
    }


def _outcome_split(games_subset: list[GameRow]) -> dict:
    """Compute three-outcome breakdown for a subset of games.

    Display order (Edward 2026-04-26): 三紅 → 三藍死 → 三藍活
    Returns counts + percentages. Empty subset returns zeros.
    """
    n = len(games_subset)
    if n == 0:
        return {
            "threeRed": 0, "threeBlueDead": 0, "threeBlueAlive": 0,
            "threeRedPct": 0, "threeBlueDeadPct": 0, "threeBlueAlivePct": 0,
        }
    three_red = sum(1 for g in games_subset if g.outcome == "三紅")
    three_blue_dead = sum(1 for g in games_subset if g.outcome == "三藍死")
    three_blue_alive = sum(1 for g in games_subset if g.outcome == "三藍活")
    return {
        "threeRed": three_red,
        "threeBlueDead": three_blue_dead,
        "threeBlueAlive": three_blue_alive,
        "threeRedPct": rnd1(three_red / n * 100),
        "threeBlueDeadPct": rnd1(three_blue_dead / n * 100),
        "threeBlueAlivePct": rnd1(three_blue_alive / n * 100),
    }


def compute_lake(games: list[GameRow]) -> dict:
    lake_configs = [
        ("首湖", "lake1_holder_faction", "lake1_target_faction", "lake1_holder_role", "lake1_target_role"),
        ("二湖", "lake2_holder_faction", "lake2_target_faction", "lake2_holder_role", "lake2_target_role"),
        ("三湖", "lake3_holder_faction", "lake3_target_faction", "lake3_holder_role", "lake3_target_role"),
    ]

    per_lake = []
    for label, hf_key, tf_key, hr_key, tr_key in lake_configs:
        subset = [g for g in games if getattr(g, hf_key) != ""]
        if not subset:
            continue

        # Group by holder faction
        holder_groups: dict[str, list[GameRow]] = {}
        for g in subset:
            faction = getattr(g, hf_key)
            holder_groups.setdefault(faction, []).append(g)

        holder_stats = [
            {
                "faction": faction,
                "games": len(gs),
                "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
                "outcomes": _outcome_split(gs),
            }
            for faction, gs in holder_groups.items()
        ]

        # Group by holder x target faction combo
        combo_groups: dict[str, list[GameRow]] = {}
        for g in subset:
            key = f"{getattr(g, hf_key)}|{getattr(g, tf_key)}"
            combo_groups.setdefault(key, []).append(g)

        combo_stats = []
        for key, gs in combo_groups.items():
            hf, tf = key.split("|")
            combo_stats.append({
                "holderFaction": hf,
                "targetFaction": tf,
                "games": len(gs),
                "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
                "outcomes": _outcome_split(gs),
            })

        per_lake.append({
            "lake": label,
            "totalGames": len(subset),
            "holderStats": holder_stats,
            "comboStats": combo_stats,
        })

    # Holder role stats (首湖 only)
    lake1_games = [g for g in games if g.lake1_holder_faction != ""]
    holder_role_groups: dict[str, list[GameRow]] = {}
    for g in lake1_games:
        role = g.lake1_holder_role
        if not role:
            continue
        holder_role_groups.setdefault(role, []).append(g)

    holder_role_stats = [
        {
            "role": role,
            "games": len(gs),
            "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
            "blueWinRate": rnd1(sum(1 for g in gs if g.blue_win) / len(gs) * 100),
            "outcomes": _outcome_split(gs),
        }
        for role, gs in holder_role_groups.items()
    ]

    # Target role stats
    target_role_groups: dict[str, list[GameRow]] = {}
    for g in lake1_games:
        role = g.lake1_target_role
        if not role:
            continue
        target_role_groups.setdefault(role, []).append(g)

    target_role_stats = [
        {
            "role": role,
            "games": len(gs),
            "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
            "outcomes": _outcome_split(gs),
        }
        for role, gs in target_role_groups.items()
    ]

    # Fix #12: Enhanced lake analysis -- per-lake role stats and cross-lake patterns
    # Role stats for all 3 lakes, not just lake1
    all_lake_role_stats = []
    for lake_idx, (label, hf_key, tf_key, hr_key, tr_key) in enumerate(lake_configs):
        lake_games = [g for g in games if getattr(g, hf_key) != ""]
        if not lake_games:
            continue

        # Holder role stats for this lake
        h_role_groups: dict[str, list[GameRow]] = {}
        for g in lake_games:
            role = getattr(g, hr_key)
            if not role:
                continue
            h_role_groups.setdefault(role, []).append(g)

        h_stats = [
            {
                "role": role,
                "games": len(gs),
                "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
                "blueWinRate": rnd1(sum(1 for g in gs if g.blue_win) / len(gs) * 100),
                "outcomes": _outcome_split(gs),
            }
            for role, gs in h_role_groups.items()
        ]

        # Target role stats for this lake
        t_role_groups: dict[str, list[GameRow]] = {}
        for g in lake_games:
            role = getattr(g, tr_key)
            if not role:
                continue
            t_role_groups.setdefault(role, []).append(g)

        t_stats = [
            {
                "role": role,
                "games": len(gs),
                "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
                "outcomes": _outcome_split(gs),
            }
            for role, gs in t_role_groups.items()
        ]

        # Holder->Target same/different faction outcome
        same_faction = [g for g in lake_games if getattr(g, hf_key) == getattr(g, tf_key) and getattr(g, tf_key) != ""]
        diff_faction = [g for g in lake_games if getattr(g, hf_key) != getattr(g, tf_key) and getattr(g, tf_key) != ""]

        all_lake_role_stats.append({
            "lake": label,
            "holderRoleStats": h_stats,
            "targetRoleStats": t_stats,
            "sameFaction": {
                "games": len(same_faction),
                "redWinRate": rnd1(sum(1 for g in same_faction if g.red_win) / len(same_faction) * 100) if same_faction else 0,
                "outcomes": _outcome_split(same_faction),
            },
            "diffFaction": {
                "games": len(diff_faction),
                "redWinRate": rnd1(sum(1 for g in diff_faction if g.red_win) / len(diff_faction) * 100) if diff_faction else 0,
                "outcomes": _outcome_split(diff_faction),
            },
        })

    return {
        "perLake": per_lake,
        "holderRoleStats": holder_role_stats,
        "targetRoleStats": target_role_stats,
        "allLakeRoleStats": all_lake_role_stats,
    }


def compute_seat_order(games: list[GameRow]) -> dict:
    """Analyze the 6 permutations of Percival(派)/Merlin(梅)/Morgana(娜) seating order.

    For each game, find seats of 派西維爾, 梅林, 莫甘娜, determine their clockwise order,
    then split by outcome: 三藍梅活, 三藍梅死, 三紅.
    Also check if missions fall between (穿插) these three players.
    """
    from itertools import permutations

    TRIO_ROLES = {"派西維爾", "梅林", "莫甘娜"}
    PERM_LABELS = [
        "派梅娜", "派娜梅", "梅派娜", "梅娜派", "娜派梅", "娜梅派",
    ]

    def get_trio_order(seat_roles: dict[str, str]) -> str | None:
        """Return the clockwise order of 派/梅/娜 as a string like '派梅娜'."""
        role_to_seat: dict[str, int] = {}
        for seat_char, role in seat_roles.items():
            if role in TRIO_ROLES:
                try:
                    role_to_seat[role] = int(seat_char) if seat_char != "0" else 10
                except ValueError:
                    continue
        if len(role_to_seat) != 3:
            return None

        # Sort by seat number to get clockwise order
        sorted_roles = sorted(role_to_seat.items(), key=lambda x: x[1])
        # Generate the 3 possible rotations and pick the one starting with lowest seat
        trio = [r[0] for r in sorted_roles]
        # Map role names to short labels
        short = {"派西維爾": "派", "梅林": "梅", "莫甘娜": "娜"}
        return "".join(short.get(r, r[0]) for r in trio)

    def has_interleaving(seat_roles: dict[str, str]) -> bool:
        """Check if other players' seats are between the trio (派/梅/娜).

        On a 10-seat circular table, find the 3 trio seats and check whether
        they are all adjacent (no interleaving) or have gaps with other
        players between them.

        Example: seats 1=梅林, 2=忠臣, 3=莫甘娜, 4=派西維爾 → True (忠臣 between)
        Example: seats 1=梅林, 2=莫甘娜, 3=派西維爾 → False (all adjacent)
        """
        trio_seats: list[int] = []
        for seat_char, role in seat_roles.items():
            if role in TRIO_ROLES:
                try:
                    trio_seats.append(int(seat_char) if seat_char != "0" else 10)
                except ValueError:
                    continue
        if len(trio_seats) != 3:
            return False

        trio_seats.sort()
        num_players = 10

        # Calculate the 3 arc gaps between consecutive trio members on the
        # circular table.  If they are all adjacent, the gaps should be
        # {1, 1, num_players - 2} in some order.
        gaps = [
            (trio_seats[1] - trio_seats[0]) % num_players,
            (trio_seats[2] - trio_seats[1]) % num_players,
            (trio_seats[0] - trio_seats[2]) % num_players,
        ]
        # Sort the gaps: for adjacent trio the smallest two gaps are both 1
        gaps.sort()
        # Adjacent means the two smallest gaps are 1 (directly next to each other)
        return not (gaps[0] == 1 and gaps[1] == 1)

    # Collect stats per permutation
    perm_stats: dict[str, dict] = {}
    for label in PERM_LABELS:
        perm_stats[label] = {
            "total": 0,
            "三藍梅活": 0, "三藍梅死": 0, "三紅": 0,
            "穿插任務": 0,
            "redWins": 0, "blueWins": 0,
            "穿插紅勝": 0, "無穿插紅勝": 0,
            "無穿插": 0,
        }

    for g in games:
        order = get_trio_order(g.seat_roles)
        if order is None or order not in perm_stats:
            continue

        stats = perm_stats[order]
        stats["total"] += 1

        if g.outcome == "三藍活":
            stats["三藍梅活"] += 1
        elif g.outcome == "三藍死":
            stats["三藍梅死"] += 1
        elif g.outcome == "三紅":
            stats["三紅"] += 1

        if g.red_win:
            stats["redWins"] += 1
        if g.blue_win:
            stats["blueWins"] += 1

        interleaved = has_interleaving(g.seat_roles)
        if interleaved:
            stats["穿插任務"] += 1
            if g.red_win:
                stats["穿插紅勝"] += 1
        else:
            stats["無穿插"] += 1
            if g.red_win:
                stats["無穿插紅勝"] += 1

    result = []
    for label in PERM_LABELS:
        s = perm_stats[label]
        total = s["total"]
        if total == 0:
            continue
        interleave_count = s["穿插任務"]
        no_interleave_count = s["無穿插"]
        result.append({
            "order": label,
            "total": total,
            "三藍梅活": s["三藍梅活"],
            "三藍梅死": s["三藍梅死"],
            "三紅": s["三紅"],
            "三藍梅活pct": rnd1(s["三藍梅活"] / total * 100),
            "三藍梅死pct": rnd1(s["三藍梅死"] / total * 100),
            "三紅pct": rnd1(s["三紅"] / total * 100),
            "穿插任務": interleave_count,
            "redWinRate": rnd1(s["redWins"] / total * 100),
            "blueWinRate": rnd1(s["blueWins"] / total * 100),
            "merlinKillRate": rnd1(s["三藍梅死"] / total * 100),
            "穿插率": rnd1(interleave_count / total * 100),
            "穿插紅勝率": rnd1(s["穿插紅勝"] / interleave_count * 100) if interleave_count > 0 else 0,
            "無穿插紅勝率": rnd1(s["無穿插紅勝"] / no_interleave_count * 100) if no_interleave_count > 0 else 0,
        })

    # Overall summary
    total_games = sum(s["total"] for s in perm_stats.values())
    total_red = sum(s["redWins"] for s in perm_stats.values())

    return {
        "permutations": result,
        "totalGames": total_games,
        "overallRedWinRate": rnd1(total_red / total_games * 100) if total_games > 0 else 0,
    }


def compute_rounds(games: list[GameRow]) -> dict:
    valid = [g for g in games if len(g.r11_seats) > 0]

    def mission1_pass_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        passed = sum(
            1 for g in gs
            if any(m["round"] == 1 and m["fails"] == 0 for m in g.missions)
        )
        return rnd1(passed / len(gs) * 100)

    def red_win_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        return rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100)

    def blue_win_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        return rnd1(sum(1 for g in gs if g.blue_win) / len(gs) * 100)

    def merlin_kill_rate(gs: list[GameRow]) -> float:
        if not gs:
            return 0.0
        return rnd1(sum(1 for g in gs if g.merlin_killed) / len(gs) * 100)

    merlin_in = [g for g in valid if g.r11_has_merlin]
    merlin_out = [g for g in valid if not g.r11_has_merlin]
    perc_in = [g for g in valid if g.r11_has_percival]
    perc_out = [g for g in valid if not g.r11_has_percival]

    vision_stats = {
        "merlinInTeam": {
            "games": len(merlin_in),
            "mission1PassRate": mission1_pass_rate(merlin_in),
            "redWinRate": red_win_rate(merlin_in),
            "blueWinRate": blue_win_rate(merlin_in),
            "outcomes": _outcome_split(merlin_in),
        },
        "merlinNotInTeam": {
            "games": len(merlin_out),
            "mission1PassRate": mission1_pass_rate(merlin_out),
            "redWinRate": red_win_rate(merlin_out),
            "blueWinRate": blue_win_rate(merlin_out),
            "outcomes": _outcome_split(merlin_out),
        },
        "percivalInTeam": {
            "games": len(perc_in),
            "mission1PassRate": mission1_pass_rate(perc_in),
            "redWinRate": red_win_rate(perc_in),
            "outcomes": _outcome_split(perc_in),
        },
        "percivalNotInTeam": {
            "games": len(perc_out),
            "mission1PassRate": mission1_pass_rate(perc_out),
            "redWinRate": red_win_rate(perc_out),
            "outcomes": _outcome_split(perc_out),
        },
    }

    # Red count in R1-1
    red_count_groups: dict[int, list[GameRow]] = defaultdict(list)
    for g in valid:
        red_count_groups[g.r11_red_count].append(g)

    red_in_r11 = sorted(
        [
            {
                "redCount": rc,
                "games": len(gs),
                "mission1PassRate": mission1_pass_rate(gs),
                "redWinRate": red_win_rate(gs),
                "outcomes": _outcome_split(gs),
            }
            for rc, gs in red_count_groups.items()
        ],
        key=lambda x: x["redCount"],
    )

    # Mission 1 branching
    with_m1 = [g for g in games if g.round_results[0] and len(g.round_results[0]) > 0]
    m1_passed = [g for g in with_m1 if count_mission_fails(g.round_results[0]) == 0]
    m1_failed = [g for g in with_m1 if count_mission_fails(g.round_results[0]) > 0]

    mission1_branch = [
        {"passed": True, "games": len(m1_passed), "redWinRate": red_win_rate(m1_passed), "merlinKillRate": merlin_kill_rate(m1_passed), "outcomes": _outcome_split(m1_passed)},
        {"passed": False, "games": len(m1_failed), "redWinRate": red_win_rate(m1_failed), "merlinKillRate": merlin_kill_rate(m1_failed), "outcomes": _outcome_split(m1_failed)},
    ]

    # Round progression
    round_labels = ["第一局", "第二局", "第三局", "第四局", "第五局"]
    round_progression: dict = {}
    for r_idx in range(5):
        with_round = [g for g in games if g.rounds[r_idx] and len(g.rounds[r_idx]) > 0]
        if not with_round:
            continue
        blue_count = sum(1 for g in with_round if g.rounds[r_idx] == "藍")
        red_count = sum(1 for g in with_round if g.rounds[r_idx] == "紅")
        round_progression[round_labels[r_idx]] = {
            "bluePct": rnd1(blue_count / len(with_round) * 100),
            "redPct": rnd1(red_count / len(with_round) * 100),
            "total": len(with_round),
        }

    # Game states (top 20)
    state_groups: dict[str, list[GameRow]] = {}
    for g in games:
        if not g.game_state:
            continue
        state_groups.setdefault(g.game_state, []).append(g)

    game_states = sorted(
        [
            {
                "state": s,
                "games": len(gs),
                "redWinRate": rnd1(sum(1 for g in gs if g.red_win) / len(gs) * 100),
                "outcomes": _outcome_split(gs),
            }
            for s, gs in state_groups.items()
        ],
        key=lambda x: x["games"],
        reverse=True,
    )[:20]

    return {
        "visionStats": vision_stats,
        "redInR11": red_in_r11,
        "mission1Branch": mission1_branch,
        "roundProgression": round_progression,
        "gameStates": game_states,
    }


def compute_players_endpoint(players: list[dict]) -> dict:
    """Matches GET /api/analysis/players response shape."""
    return {"players": players, "total": len(players)}


def compute_player_details(players: list[dict]) -> dict[str, dict]:
    """playerDetails for GET /api/analysis/players/:name, shaped like the committed cache.

    ``player`` is the players row without seatOutcomes (the committed cache
    added seatOutcomes to players.players only); ``radar`` is a copy of the
    row's roleWinRates. Nothing reads this radar: routes/analysis.ts builds the
    radar it serves from ``player``.
    """
    return {
        p["name"]: {
            "player": {k: v for k, v in p.items() if k != "seatOutcomes"},
            "radar": dict(p["roleWinRates"]),
        }
        for p in players
    }


# ---------------------------------------------------------------------------
# Captain Analysis
# ---------------------------------------------------------------------------

_MISSION_RESULT_RE = re.compile(r'^[oxOX]+$')
_LAKE_RE = re.compile(r'^\d+>\d+')


def _parse_captain_per_mission(text_record: str) -> list[str | None]:
    """Return captain seat char for each completed mission in a game record.

    The captain is the first digit of the last team proposal line immediately
    before a mission result line (ooo / ooox / OOX etc).  Lake lines (N>M)
    reset the current candidate and are not treated as proposals.

    Returns a list of up to 5 elements; an element is None when no proposal
    precedes the corresponding result line.
    """
    missions: list[str | None] = []
    last_proposal_captain: str | None = None

    for raw_line in re.split(r'\r?\n', text_record.strip()):
        line = raw_line.strip()
        if not line:
            continue
        if _LAKE_RE.match(line):
            last_proposal_captain = None
            continue
        if _MISSION_RESULT_RE.match(line):
            missions.append(last_proposal_captain)
            last_proposal_captain = None
            continue
        if line[0].isdigit():
            last_proposal_captain = line[0]

    return missions


def compute_captain_analysis(games: list[GameRow]) -> dict:
    """Compute captain faction vs mission outcome statistics.

    For each game we parse the 文字記錄 (text_record stored in GameRow) and
    identify which seat captained each mission.  We then map the seat to its
    role and faction (red / blue).

    Two output tables:
    - perMission: for missions 1-5, what fraction of captains were red vs blue
    - captainFactionVsOutcome: for each (captainFaction, missionResult) combo,
      count and percentage of occurrences
    """
    # Per-mission counters: mission_idx (0-4) -> {"red": n, "blue": n, "total": n}
    per_mission: list[dict[str, int]] = [
        {"red": 0, "blue": 0, "total": 0} for _ in range(5)
    ]

    # Faction x outcome counters
    # keys: (faction_str, mission_pass_bool) -> count
    faction_outcome: dict[tuple[str, bool], int] = defaultdict(int)
    faction_outcome_total: dict[str, int] = defaultdict(int)

    for g in games:
        # text_record must be fetched from the raw sheet; GameRow doesn't store
        # it directly.  We attach it in load_game_log below via a new attribute.
        text_record: str = getattr(g, "text_record", "") or ""
        if not text_record:
            continue

        captains = _parse_captain_per_mission(text_record)

        for m_idx, captain_seat in enumerate(captains):
            if m_idx >= 5:
                break
            if captain_seat is None:
                continue

            role = g.seat_roles.get(captain_seat, "忠臣")
            faction = role_faction(role)
            if not faction:
                faction = "藍方"  # 忠臣 → blue

            # Determine mission pass/fail from missions list
            mission_data = next(
                (m for m in g.missions if m["round"] == m_idx + 1), None
            )
            if mission_data is None:
                continue
            passed = mission_data["fails"] == 0

            per_mission[m_idx]["total"] += 1
            if faction == "紅方":
                per_mission[m_idx]["red"] += 1
            else:
                per_mission[m_idx]["blue"] += 1

            faction_outcome[(faction, passed)] += 1
            faction_outcome_total[faction] += 1

    # Build perMission output
    per_mission_out: list[dict] = []
    for m_idx, counts in enumerate(per_mission):
        total = counts["total"]
        if total == 0:
            continue
        per_mission_out.append({
            "mission": m_idx + 1,
            "redCaptainRate": rnd1(counts["red"] / total * 100),
            "blueCaptainRate": rnd1(counts["blue"] / total * 100),
            "games": total,
        })

    # Build captainFactionVsOutcome output
    faction_vs_outcome_out: list[dict] = []
    for (faction, passed), count in sorted(faction_outcome.items()):
        total_for_faction = faction_outcome_total[faction]
        faction_vs_outcome_out.append({
            "captainFaction": faction,
            "missionResult": "pass" if passed else "fail",
            "count": count,
            "percentage": rnd1(count / total_for_faction * 100) if total_for_faction > 0 else 0.0,
        })

    # Win-rate when red/blue captain leads a mission that passes vs fails
    # Extra cut: among games where red captain led, how often did blue win?
    # Now also captures three-outcome breakdown so the UI can avoid lumping
    # blue wins together (Edward 2026-04-26: 三紅 / 三藍死 / 三藍活 split).
    faction_mission_games: dict[tuple[str, bool], list[GameRow]] = defaultdict(list)
    for g in games:
        text_record = getattr(g, "text_record", "") or ""
        if not text_record:
            continue
        captains = _parse_captain_per_mission(text_record)
        for m_idx, captain_seat in enumerate(captains):
            if m_idx >= 5 or captain_seat is None:
                continue
            role = g.seat_roles.get(captain_seat, "忠臣")
            faction = role_faction(role) or "藍方"
            mission_data = next(
                (m for m in g.missions if m["round"] == m_idx + 1), None
            )
            if mission_data is None:
                continue
            passed = mission_data["fails"] == 0
            faction_mission_games[(faction, passed)].append(g)

    captain_mission_game_win_rates: list[dict] = []
    for (faction, passed), gs in sorted(faction_mission_games.items()):
        total = len(gs)
        if total == 0:
            continue
        red_win = sum(1 for g in gs if g.red_win)
        blue_win = sum(1 for g in gs if g.blue_win)
        captain_mission_game_win_rates.append({
            "captainFaction": faction,
            "missionResult": "pass" if passed else "fail",
            "totalMissions": total,
            "redGameWinRate": rnd1(red_win / total * 100),
            "blueGameWinRate": rnd1(blue_win / total * 100),
            "outcomes": _outcome_split(gs),
        })

    return {
        "perMission": per_mission_out,
        "captainFactionVsOutcome": faction_vs_outcome_out,
        "captainMissionGameWinRates": captain_mission_game_win_rates,
    }




# ---------------------------------------------------------------------------
# Assemble the cache: Sheet sections + derived + carried-over sections
# ---------------------------------------------------------------------------

def build_cache(games: list[GameRow], chemistry: dict) -> dict:
    """The sections computed from the Sheet (SHEET_SECTIONS); players come from the 牌譜 game log."""
    players = compute_player_stats(games)
    overview = compute_overview(games, players)

    # Edward 2026-04-27: extend chemistry with 5th matrix outcomePair before
    # the players/playerDetails block so seat outcomes can also be attached.
    chemistry["outcomePair"] = compute_outcome_pair_matrix(chemistry, overview["outcomeBreakdown"])

    seat_outcomes_per_player = compute_seat_outcomes_per_player(
        overview["seatPositionWinRates"], overview["outcomeBreakdown"], players,
    )
    for p in players:
        p["seatOutcomes"] = seat_outcomes_per_player.get(p["name"], {})

    return {
        "overview": overview,
        "players": compute_players_endpoint(players),
        "playerDetails": compute_player_details(players),
        "chemistry": chemistry,
        "missions": compute_missions(games),
        "lake": compute_lake(games),
        "rounds": compute_rounds(games),
        "seatOrder": compute_seat_order(games),
        "captainAnalysis": compute_captain_analysis(games),
    }


@functools.lru_cache(maxsize=None)
def _load_local_script(stem: str):
    """Import packages/server/scripts/<stem>.py by path (that folder is not a package)."""
    path = SCRIPTS_DIR / f"{stem}.py"
    spec = importlib.util.spec_from_file_location(f"avalon_stats_{stem}", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def default_strength_builder() -> Callable[[list[dict]], dict]:
    return _load_local_script("build_archetype_strength").build_strength_section


def default_placeholder_builders() -> dict[str, Callable[[float], dict]]:
    """Per-player placeholder rows for carried-over sections, from the scripts that build them."""
    return {
        "archetype": _load_local_script("build_archetype_strength").archetype_placeholder,
        "playstyle": _load_local_script("build_panel_c_playstyle").playstyle_placeholder,
    }


def carry_over_sections(
    new_cache: dict,
    previous: Mapping[str, Any] | None,
    placeholder_builders: Mapping[str, Callable[[float], dict]] | None = None,
) -> dict[str, int]:
    """Copy into new_cache every top-level section of `previous` it does not have.

    Existing per-player rows are kept as they are; players in the new
    playerDetails that a carried section lacks get that section's placeholder
    row (hasData=false). `previous` is not modified.
    Returns {section: number of placeholder rows added}.
    """
    carried: dict[str, int] = {}
    if not previous:
        return carried
    builders = placeholder_builders or {}
    details = new_cache.get("playerDetails") or {}
    for key, value in previous.items():
        if key in new_cache:
            continue
        added = 0
        builder = builders.get(key)
        if builder is not None and isinstance(value, dict) and isinstance(value.get("perPlayer"), dict):
            per_player = dict(value["perPlayer"])
            for name, detail in details.items():
                if name not in per_player:
                    per_player[name] = builder(((detail or {}).get("player") or {}).get("totalGames", 0))
                    added += 1
            value = {**value, "perPlayer": per_player}
        new_cache[key] = value
        carried[key] = added
    return carried


def order_like(cache: dict, previous: Mapping[str, Any] | None) -> dict:
    """Keep the existing file's section order (smaller diffs); new sections go last."""
    if not previous:
        return cache
    ordered = {k: cache[k] for k in previous if k in cache}
    ordered.update((k, v) for k, v in cache.items() if k not in ordered)
    return ordered


def assemble_cache(
    fresh: dict,
    previous: Mapping[str, Any] | None,
    strength_builder: Callable[[list[dict]], dict] | None = None,
    placeholder_builders: Mapping[str, Callable[[float], dict]] | None = None,
) -> tuple[dict, dict[str, int]]:
    cache = dict(fresh)
    cache["strength"] = (strength_builder or default_strength_builder())(cache["players"]["players"])
    if placeholder_builders is None:
        placeholder_builders = default_placeholder_builders()
    carried = carry_over_sections(cache, previous, placeholder_builders)
    return order_like(cache, previous), carried


# ---------------------------------------------------------------------------
# Sanity guard
# ---------------------------------------------------------------------------

def allowed_drop(previous_count: int) -> int:
    return max(SHRINK_TOLERANCE_ABS, math.ceil(previous_count * SHRINK_TOLERANCE_PCT / 100))


def _positive_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return None
    return int(value) if value > 0 and float(value).is_integer() else None


def _count(cache: Mapping[str, Any] | None, section: str, key: str) -> int | None:
    if not isinstance(cache, Mapping):
        return None
    part = cache.get(section)
    return _positive_int(part.get(key)) if isinstance(part, Mapping) else None


def _matrix_size(chemistry: Any, key: str) -> int:
    matrix = chemistry.get(key) if isinstance(chemistry, Mapping) else None
    players = matrix.get("players") if isinstance(matrix, Mapping) else None
    return len(players) if isinstance(players, list) else 0


def dropped_player_fields(cache: Mapping[str, Any], previous: Mapping[str, Any] | None) -> list[str]:
    """Per-player fields the existing players rows have but the new rows lack entirely."""
    def fields(c: Mapping[str, Any] | None) -> set[str]:
        rows = ((c or {}).get("players") or {}).get("players") if isinstance(c, Mapping) else None
        if not isinstance(rows, list):
            return set()
        return set().union(*(set(r) for r in rows if isinstance(r, Mapping))) if rows else set()

    new_fields = fields(cache)
    return sorted(fields(previous) - new_fields) if new_fields else []


def _players_by_name(cache: Mapping[str, Any] | None) -> dict[str, Mapping[str, Any]]:
    rows = ((cache or {}).get("players") or {}).get("players") if isinstance(cache, Mapping) else None
    return {
        r["name"]: r for r in (rows if isinstance(rows, list) else [])
        if isinstance(r, Mapping) and isinstance(r.get("name"), str)
    }


def _fmt_count(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _player_games(cache: Mapping[str, Any] | None) -> dict[str, float]:
    """{name: totalGames} of a cache's players rows (rows without a usable count are ignored)."""
    out: dict[str, float] = {}
    for name, row in _players_by_name(cache).items():
        games = row.get("totalGames")
        if isinstance(games, (int, float)) and not isinstance(games, bool) and games == games:
            out[name] = float(games)
    return out


def games_regressions(
    cache: Mapping[str, Any], previous: Mapping[str, Any] | None,
) -> list[tuple[str, float, float | None]]:
    """(name, old totalGames, new totalGames or None if gone) for every existing player
    whose game count went down, biggest drop first.

    牌譜 only ever gets games appended, so a player's count never goes down; when it
    does, a game row was deleted or became unreadable, or a 玩1..玩0 name was
    retyped (the old spelling loses games, the new one gains them).
    """
    new = _player_games(cache)
    out = [
        (name, before, new.get(name))
        for name, before in _player_games(previous).items()
        if new.get(name) is None or new[name] < before
    ]
    out.sort(key=lambda t: t[1] - (t[2] or 0.0), reverse=True)  # stable: ties keep the old order
    return out


def validate_new_cache(
    cache: Mapping[str, Any],
    previous: Mapping[str, Any] | None,
    allow_shrink: bool = False,
    allow_field_loss: bool = False,
) -> list[str]:
    """Problems that make `cache` unfit to replace `previous` ([] = OK to write)."""
    problems: list[str] = []
    for key in SHEET_SECTIONS + DERIVED_SECTIONS:
        if not isinstance(cache.get(key), dict):
            problems.append(f"section '{key}' is missing or not an object")
    if problems:
        return problems

    games = _count(cache, "overview", "totalGames")
    if games is None:
        problems.append(
            f"overview.totalGames is {cache['overview'].get('totalGames')!r}; expected a positive "
            "number (牌譜 tab empty or unreadable?)"
        )
    player_list = cache["players"].get("players")
    if not isinstance(player_list, list) or not player_list:
        problems.append("players.players is empty (牌譜 has no player names in 玩1..玩0, or those columns were renamed?)")
    elif cache["players"].get("total") != len(player_list):
        problems.append(f"players.total={cache['players'].get('total')!r} but players.players has {len(player_list)} rows")
    if not cache["playerDetails"]:
        problems.append("playerDetails is empty")

    if previous and not allow_shrink:
        # Games are only ever appended to 牌譜: neither the total nor any player's count may go down.
        old_games = _count(previous, "overview", "totalGames")
        if old_games is not None and games is not None and games < old_games:
            problems.append(
                f"overview.totalGames would drop from {old_games} to {games} ({old_games - games} fewer); "
                "games are only ever appended to 牌譜, so rows were deleted or became unreadable "
                "(流水號 blank or 配置 not 6 characters?); if that is intended, re-run with --allow-shrink"
            )
        regressions = games_regressions(cache, previous)
        if regressions:
            shown = ", ".join(
                f"{name} {_fmt_count(before)}→{_fmt_count(after) if after is not None else 'gone'}"
                for name, before, after in regressions[:MAX_LISTED_REGRESSIONS]
            )
            more = len(regressions) - MAX_LISTED_REGRESSIONS
            problems.append(
                f"{len(regressions)} existing player(s) would have fewer games than in the existing cache: "
                f"{shown}{f' (+{more} more)' if more > 0 else ''}. A player's count never goes down while "
                "games are only appended to 牌譜; a deleted row or a retyped 玩1..玩0 name does this. "
                "If intended, re-run with --allow-shrink"
            )
        old_players = _count(previous, "overview", "totalPlayers")
        new_players = _count(cache, "overview", "totalPlayers")
        if old_players is not None and new_players is not None:
            tolerance = allowed_drop(old_players)
            if old_players - new_players > tolerance:
                problems.append(
                    f"the new cache has {new_players} players, {old_players - new_players} fewer than the existing "
                    f"{old_players} (tolerance {tolerance}); if rows were removed on purpose, re-run with --allow-shrink"
                )
        for key in CHEMISTRY_MATRICES:
            old_size = _matrix_size(previous.get("chemistry"), key)
            if old_size and not _matrix_size(cache.get("chemistry"), key):
                problems.append(
                    f"chemistry.{key} is empty but the existing cache has {old_size} players "
                    "(worksheet renamed or emptied?); re-run with --allow-shrink if intended"
                )

    lost = [] if allow_field_loss else dropped_player_fields(cache, previous)
    if lost:
        problems.append(
            f"players rows would lose fields {', '.join(lost)} that the existing cache has "
            "(LeaderboardV3 reads rawRed*/rawBlue*/roleSeatStats); "
            "only --allow-field-loss (local runs) overrides this"
        )
    return problems


# ---------------------------------------------------------------------------
# Dry run (--compare): what a refresh would change
# ---------------------------------------------------------------------------

COMPARE_FIELD_CHANGE_PCT = 5.0
COMPARE_TOP_N = 10


def _fmt_rate(value: Any) -> str:
    return "—" if not isinstance(value, (int, float)) else f"{float(value):.1f}"


def _arrow(old: Any, new: Any, fmt: Callable[[Any], str] = _fmt_count) -> str:
    return fmt(new) if old == new else f"{fmt(old)} → {fmt(new)}"


def _names(names: list[str], limit: int = 8) -> str:
    return "、".join(names[:limit]) + (f"…（共 {len(names)}）" if len(names) > limit else "")


def compare_summary(
    new: Mapping[str, Any],
    old: Mapping[str, Any] | None,
    field_change_pct: float = COMPARE_FIELD_CHANGE_PCT,
    top_n: int = COMPARE_TOP_N,
) -> list[str]:
    """Markdown lines: what replacing `old` with `new` would change (for the job summary)."""
    lines = ["### 戰績分析快取：預覽（--compare，未寫入）"]
    old_rows, new_rows = _players_by_name(old), _players_by_name(new)
    added = [n for n in new_rows if n not in old_rows]
    gone = [n for n in old_rows if n not in new_rows]
    old_ov = (old or {}).get("overview") or {}
    new_ov = new.get("overview") or {}
    lines.append(
        f"- 玩家：{_arrow(len(old_rows) if old else None, len(new_rows))}"
        + (f"；新增 {len(added)}：{_names(added)}" if old and added else "")
        + (f"；消失 {len(gone)}：{_names(gone)}" if gone else "")
    )
    lines.append(f"- 局數：{_arrow(old_ov.get('totalGames'), new_ov.get('totalGames'))}")
    old_ob, new_ob = old_ov.get("outcomeBreakdown") or {}, new_ov.get("outcomeBreakdown") or {}
    lines.append("- 結果：" + "／".join(
        f"{label} {_arrow(old_ob.get(key), new_ob.get(key))}"
        for label, key in (("三紅", "threeRed"), ("三藍死", "threeBlueDead"), ("三藍活", "threeBlueAlive"))
    ))

    top = sorted(new_rows.values(), key=lambda r: -float(r.get("totalGames") or 0))[:top_n]
    if top:
        lines += ["", f"局數前 {len(top)} 名（舊 → 新）：", "", "| # | 玩家 | 局數 | 勝率 |", "|---|---|---|---|"]
        for i, row in enumerate(top, 1):
            prev = old_rows.get(row["name"]) or {}
            lines.append(
                f"| {i} | {row['name']} | {_arrow(prev.get('totalGames'), row.get('totalGames'))} "
                f"| {_arrow(prev.get('winRate'), row.get('winRate'), _fmt_rate)} |"
            )

    common = [n for n in new_rows if n in old_rows]
    if common:
        fields = sorted(set().union(*(set(old_rows[n]) | set(new_rows[n]) for n in common)))
        counts = {f: sum(1 for n in common if old_rows[n].get(f) != new_rows[n].get(f)) for f in fields}
        changed = [
            f"`{f}` {n}/{len(common)}（{n / len(common) * 100:.0f}%）"
            for f, n in sorted(counts.items(), key=lambda kv: -kv[1])  # most-changed first, then by name
            if n / len(common) * 100 > field_change_pct
        ]
        lines += ["", f"超過 {field_change_pct:g}% 共同玩家（{len(common)} 人）值有變動的欄位："
                  + ("、".join(changed) if changed else "無")]
    if old:
        sections = [k for k in new if k in old and new[k] != old[k]]
        lines.append(f"內容有變動的區塊：{'、'.join(sections) if sections else '無'}")
    return lines


def load_previous_cache(path: Path, allow_shrink: bool = False) -> dict | None:
    """The existing cache (source of carried-over sections and the shrink baseline)."""
    if not path.exists():
        print(f"[WARN] {path.name} does not exist yet: nothing to carry over or compare against.")
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("top level is not a JSON object")
    except (OSError, ValueError) as exc:
        message = (
            f"The existing {path.name} cannot be read ({type(exc).__name__}: {_short(exc, 120)}). "
            "Its carried-over sections (archetype, playstyle, featureStudies) cannot be rebuilt here, "
            "so it is not overwritten. Restore it from git or re-run with --allow-shrink to write without them."
        )
        if not allow_shrink:
            raise FatalError(message, EXIT_DATA, "Existing cache unreadable") from None
        print(f"[WARN] {message}")
        return None
    return data


def write_cache_atomically(cache: Mapping[str, Any], path: Path) -> None:
    """Write via a temp file + rename, so a crash never leaves a half-written cache."""
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def fetch_sheet_data(source: CredentialSource, sheet_id: str) -> tuple[list[GameRow], dict]:
    try:
        print("Connecting to Google Sheets...")
        sh = open_spreadsheet(source, sheet_id)

        print(f"Loading game log ({GAME_LOG_TAB}, {DISCORD_IMPORT_TAB} if present)...")
        merged = load_game_logs(sh)
        games = merged.games
        print(f"  Loaded {len(games)} games ({merged.summary()}): {game_log_summary(games)}")

        print("Loading chemistry matrices...")
        chemistry = load_chemistry(sh)
        print(f"  Loaded {len(chemistry)} matrices")
    except FatalError:
        raise
    except Exception as exc:
        kind = classify_google_error(exc)
        if kind is None:
            raise
        titles = {
            "auth": "Google rejected the service-account key",
            "permission": "Service account cannot open the Google Sheet",
            "not_found": "Google Sheet not found",
            "missing_worksheet": "Worksheet missing from the Google Sheet",
        }
        code = EXIT_DATA if kind == "missing_worksheet" else EXIT_GOOGLE_ACCESS
        raise FatalError(
            google_access_error_message(kind, exc, sheet_id, source.client_email()), code, titles[kind]
        ) from None
    return games, chemistry


def _append_step_summary(lines: list[str]) -> None:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary:
        return
    with contextlib.suppress(OSError), open(summary, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def run(
    output_path: Path = OUTPUT_PATH,
    allow_shrink: bool = False,
    allow_field_loss: bool = False,
    compare: bool = False,
    compare_threshold: float = COMPARE_FIELD_CHANGE_PCT,
) -> int:
    source = resolve_credentials_source()
    sheet_id = resolve_sheet_id()
    print(f"Credentials: {source.describe()}")
    print(f"Service account: {source.client_email() or '(client_email not found in key)'}")
    print(f"Spreadsheet: {sheet_id}")

    previous = load_previous_cache(output_path, allow_shrink)
    games, chemistry = fetch_sheet_data(source, sheet_id)

    print("Computing endpoint responses...")
    cache, carried = assemble_cache(build_cache(games, chemistry), previous)

    problems = validate_new_cache(cache, previous, allow_shrink, allow_field_loss)
    refusal = f"Refusing to overwrite {output_path.name}:\n- " + "\n- ".join(problems)

    if compare:
        summary = compare_summary(cache, previous, compare_threshold)
        if problems:
            summary += ["", "**守門：會拒絕寫入**（正式執行會以 exit 4 結束，現有快取不動）："]
            summary += [f"- {p}" for p in problems]
        else:
            summary += ["", "守門：通過（正式執行會寫入）"]
        print("\n".join(summary))
        _append_step_summary(summary)
        if problems:
            raise FatalError(f"Dry run (--compare). {refusal}", EXIT_DATA, "Analysis cache sanity check failed")
        print(f"Dry run (--compare): {output_path.name} was not written.")
        return 0

    if problems:
        raise FatalError(refusal, EXIT_DATA, "Analysis cache sanity check failed")

    print(f"Writing to {output_path}...")
    write_cache_atomically(cache, output_path)

    size_mb = output_path.stat().st_size / (1024 * 1024)
    prev_games = _count(previous, "overview", "totalGames")
    prev_players = _count(previous, "overview", "totalPlayers")
    carried_desc = ", ".join(
        f"{k} (+{n} placeholder rows)" if n else k for k, n in carried.items()
    ) or "none"
    print(f"Done. {output_path.name}: {size_mb:.2f} MB")
    print(f"  overview: {cache['overview']['totalGames']} games (was {prev_games}), "
          f"{cache['overview']['totalPlayers']} players (was {prev_players})")
    print(f"  players: {cache['players']['total']} entries (from 牌譜 玩1..玩0)")
    print(f"  playerDetails: {len(cache['playerDetails'])} entries")
    print(f"  chemistry: {len(cache['chemistry'])} matrices")
    print(f"  refreshed from the Sheet: {', '.join(SHEET_SECTIONS)}")
    print(f"  recomputed from players: {', '.join(DERIVED_SECTIONS)}")
    print(f"  carried over from the existing cache: {carried_desc}")
    _append_step_summary([
        "### 戰績分析快取",
        f"- 局數：{prev_games} → {cache['overview']['totalGames']}；玩家：{prev_players} → {cache['overview']['totalPlayers']}",
        f"- 由試算表重算：{', '.join(SHEET_SECTIONS)}；由 players 重算：{', '.join(DERIVED_SECTIONS)}",
        f"- 沿用現有快取（需在擁有者電腦重建）：{carried_desc}",
    ])
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Regenerate analysis_cache.json from the Avalon Google Sheet.")
    parser.add_argument("--output", type=Path, default=OUTPUT_PATH,
                        help="cache file to read (carry-over / baseline) and replace (default: %(default)s)")
    parser.add_argument("--allow-shrink", action="store_true",
                        help="write even if games or a player's games went down, players or chemistry "
                             "shrank beyond the tolerance")
    parser.add_argument("--allow-field-loss", action="store_true",
                        help="write even if players rows lose fields the existing cache has (local use only)")
    parser.add_argument("--compare", action="store_true",
                        help="dry run: build and check the new cache, print what would change vs the existing "
                             "file (also to $GITHUB_STEP_SUMMARY), write nothing; exits like the real run would")
    parser.add_argument("--compare-threshold", type=float, default=COMPARE_FIELD_CHANGE_PCT, metavar="PCT",
                        help="--compare lists the player fields whose value changed for more than PCT%% of "
                             "the players in both files (default: %(default)s)")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args.output, args.allow_shrink, args.allow_field_loss, args.compare, args.compare_threshold)
    except FatalError as exc:
        emit_error(str(exc), exc.title)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
