"""
Import Avalon game records (牌譜) posted in the Discord forum #牌譜紀錄與覆盤 into the
`Discord匯入` tab of the stats Google Sheet, where generate_cache.py picks them up.

Each forum post is one game; its starter message holds the record:

    147                 one proposal per line: seat digits (0 = seat 10), then vote
    260                 anomalies, "+7" / "-5 +39" (sign first) or "7+" / "57-6+" (sign last)
    389 +7
    469
    568
    ooo                 mission result (o/x, any case) = end of the round
    ...
    0>8 o               Lady of the Lake: holder>target, declared o / x / ?
    ...
    刺客刺殺:            (or ：) optionally followed by the target seat, or x
    936758              配置: seats of 刺 娜 德 奧 派 梅
    1.小米              player names, seats 1..9, then 0 (= seat 10)
    ...
    0.菜

Older posts (2023) put the mission result on the team's line ("569 OOX"), write the
lake as "04O" and carry the 配置 as the post title. Posts that cannot be read
completely and unambiguously are skipped with a reason; nothing is guessed. The
result comes from the post's tag (三紅 / 三藍被刀 / 三藍躲刺) and must agree with the
mission results (the 4th mission of a 10-player game needs two fails).

What this script does and does not do:
  * reads Discord (bot token) and the 牌譜 / Discord匯入 tabs; writes only by appending
    rows to Discord匯入 (created with 牌譜's header + discord_post_id, discord_title,
    discord_tags, 匯入時間 if missing). Never writes to Discord or to any other tab.
  * idempotent: a post already in Discord匯入 (by discord_post_id) is not fetched
    again; a game already in 牌譜 (generate_cache.record_fingerprint, or the same
    配置 + mission results with the same players) or tagged 已收錄 is not imported;
    posts tagged 模擬 (simulations) are not imported either.
  * prints counts and fixed reason strings only (stdout and $GITHUB_STEP_SUMMARY):
    no player names, no record text, no post titles -- the repository is public.

Usage:
    python discord_records_import.py --dry-run            # parse, dedupe, print counts
    python discord_records_import.py                      # ... and append the new rows
    python discord_records_import.py --since 2026-04-01 --limit 5
    python discord_records_import.py --dry-run --report skipped.json   # local only

Configuration (environment):
    DISCORD_BOT_TOKEN              the bot's token (View Channel + Read Message History on
                                   the forum, Message Content intent)
    AVALON_STATS_CREDENTIALS_FILE, AVALON_STATS_CREDENTIALS_JSON, AVALON_STATS_SHEET_ID
                                   as for generate_cache.py; writing needs Editor access
    DISCORD_RECORDS_FORUM_ID       forum channel id (default FORUM_CHANNEL_ID)

Exit codes: 0 ok, 2 configuration, 3 Google refused access, 4 sheet data problem,
5 Discord API error. Nothing is written unless everything before the write succeeded.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import generate_cache as gc

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DISCORD_API = "https://discord.com/api/v10"
USER_AGENT = "DiscordBot (avalonpediatw, 1.0)"
GUILD_ID = "1132682489840812113"
FORUM_CHANNEL_ID = "1132683080134578276"  # #牌譜紀錄與覆盤 (forum: one post per game)
ENV_DISCORD_TOKEN = "DISCORD_BOT_TOKEN"
ENV_FORUM_ID = "DISCORD_RECORDS_FORUM_ID"
DISCORD_EPOCH_MS = 1420070400000
FETCH_PACE_SECONDS = 0.05
MAX_ATTEMPTS = 6
MAX_RETRY_SLEEP = 60.0

WRITE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
EXIT_DISCORD = 5
TAIPEI = dt.timezone(dt.timedelta(hours=8), "Asia/Taipei")

TAG_RECORDED = "已收錄"  # set by hand on posts already copied into 牌譜
TAG_SIMULATION = "模擬"
RESULT_TAGS = {"三紅": gc.OUTCOME_THREE_RED, "三藍被刀": gc.OUTCOME_BLUE_DEAD, "三藍躲刺": gc.OUTCOME_BLUE_ALIVE}
CATEGORY_TAGS = ("線瓦", "面瓦")  # -> 分類
EXPECTED_TAGS = (TAG_RECORDED, TAG_SIMULATION, *RESULT_TAGS, *CATEGORY_TAGS)

SEATS = gc.SEATS
TEAM_SIZES = (3, 4, 4, 5, 5)  # 10 players
ROLE_ABBR = ("刺", "娜", "德", "奧", "派", "梅")  # 配置 order, as in 角1 / 首湖玩家 ...
LOYAL_ABBR = "忠"
RED_CONFIG_SLOTS = 4  # 配置[:4] = 刺 娜 德 奧

ROUND_COLUMNS = ("第一局", "第二局", "第三局", "第四局", "第五局")
ROUND_RESULT_COLUMNS = tuple(f"{c}成功失敗" for c in ROUND_COLUMNS)
LAKE_COLUMNS = ("首湖", "二湖", "三湖")
LAKE_PLAYER_COLUMNS = ("首湖玩家", "二湖玩家", "三湖玩家")
ROLE_SEAT_COLUMNS = {"角1": "1", "角4": "4", "角5": "5", "角0": "0"}
# Columns of 牌譜 that are a function of 文字記錄 + 配置 + 玩1..玩0 (see derive_columns;
# test_discord_records_import proves it on the 2146-game snapshot).
DERIVED_COLUMNS = (
    "1-1", *ROUND_RESULT_COLUMNS, *ROUND_COLUMNS, "局勢", *LAKE_COLUMNS, *LAKE_PLAYER_COLUMNS,
    *ROLE_SEAT_COLUMNS, "派5", "派0", "外灑", "組成",
)
EXTRA_COLUMNS = ("discord_post_id", "discord_title", "discord_tags", "匯入時間")
# Without these a Discord匯入 row is useless to generate_cache or to this script's dedupe.
REQUIRED_COLUMNS = (
    "流水號", "文字記錄", "配置", "結果", *(gc.PLAYER_COLUMNS[s] for s in SEATS),
    "1-1", *ROUND_RESULT_COLUMNS, *ROUND_COLUMNS, "局勢", *LAKE_COLUMNS,
)

# Skip reasons: fixed strings, safe for public logs (never interpolate post content).
SKIP_NO_STARTER = "starter message deleted or unreadable"
SKIP_EMPTY = "starter message has no text (empty or attachments only)"
SKIP_SIMULATION = "tagged 模擬 (simulation), not imported"
SKIP_NO_RECORD = "no game record found"
SKIP_UNRECOGNIZED = "unrecognized line inside the record (or record interrupted by footer lines)"
SKIP_BAD_VOTE = "unparseable vote-anomaly token"
SKIP_MISSION_NO_TEAM = "mission result without a proposal before it"
SKIP_TRAILING_PROPOSAL = "proposal after the last mission result"
SKIP_TOO_MANY_PROPOSALS = "more than 5 proposals in a round"
SKIP_DUP_SEAT = "a team lists the same seat twice"
SKIP_TEAM_SIZE = "team size does not fit a 10-player game (3,4,4,5,5)"
SKIP_MISSION_SIZE = "mission result length differs from the team size"
SKIP_ROUNDS_LT3 = "fewer than 3 rounds"
SKIP_UNDECIDED = "record ends before either side has 3 missions"
SKIP_AFTER_DECIDED = "rounds continue after one side has 3 missions"
SKIP_BAD_LAKE = "lake line inconsistent (same seat, broken chain, or not after round 2-4)"
SKIP_NO_CONFIG = "no 6-digit 配置 in the post or its title"
SKIP_BAD_CONFIG = "配置 is not 6 distinct seats"
SKIP_CONFIG_CONFLICT = "different 配置 in the post (body vs body, or body vs title)"
SKIP_FAILS_GT_RED = "more fails than red players on the team (配置 or team wrong)"
SKIP_BAD_ASSASSIN = "unparseable or contradictory 刺客刺殺 line"
SKIP_RESULT_TAGS = "more than one result tag"
SKIP_RESULT_MISMATCH = "result tag disagrees with the mission results"
SKIP_ASSASSIN_MISMATCH = "assassination target disagrees with the result tag"
SKIP_NO_RESULT = "three blue missions but neither a result tag nor an assassination target"
SKIP_NAMES_MISSING = "player names missing or incomplete (need seats 1..9 and 0)"
SKIP_NAMES_MALFORMED = "player name list malformed (seat listed twice, same name twice, or several per line)"
SKIP_INTERNAL = "internal parser error"


class SkipPost(Exception):
    """A post that is not imported; `reason` is one of the SKIP_* strings."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# ---------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Post:
    id: str  # thread id = starter message id (snowflake)
    title: str
    tags: tuple[str, ...] = ()

    @property
    def created(self) -> dt.datetime:
        """Creation time (from the snowflake), Taipei time."""
        ms = (int(self.id) >> 22) + DISCORD_EPOCH_MS
        return dt.datetime.fromtimestamp(ms / 1000, tz=TAIPEI)


def snowflake_at(when: dt.datetime) -> str:
    """The smallest snowflake of `when` (for fixtures and --since)."""
    ms = int(when.timestamp() * 1000)
    return str((ms - DISCORD_EPOCH_MS) << 22)


# ---------------------------------------------------------------------------
# Line classification
# ---------------------------------------------------------------------------

_SYMBOLS = str.maketrans({
    "−": "-", "–": "-", "—": "-",  # minus sign, en/em dash
    "×": "x", "✕": "x", "✗": "x", "✘": "x",  # × ✕ ✗ ✘
    "○": "o", "◯": "o",  # ○ ◯
})
_MARKDOWN_EDGES = "`*_~|"

_MISSION_RE = re.compile(r"^[oxOX](?: ?[oxOX]){0,4}$")
_LAKE_RE = re.compile(r"^([0-9]) ?> ?([0-9])(?: ?([oxOX?]))?$")
_OLD_LAKE_RE = re.compile(r"^([0-9])([0-9]) ?([oxOX])$")  # 2023 style "04O"
# team digits, a sign-first anomaly may be glued on ("389+7": the only valid reading), then
# space-separated anomaly tokens, then (2023 style) the mission result.
_PROPOSAL_RE = re.compile(r"^([0-9]{1,10})((?:[+\-][0-9]+)*)((?: [0-9+\-]+)*)(?: ?([oxOX]{1,5}))?$")
_CONFIG_RE = re.compile(r"^[0-9]{6}$")
_ASSASSIN_RE = re.compile(r"^刺客?刺殺 ?:? ?(.*)$")
_TARGET_RE = re.compile(r"^(10|[0-9]) ?號?$")
_NO_TARGET_RE = re.compile(r"^(?:[xX]|無|-)$")
_SUFFIX_TOKEN_RE = re.compile(r"^(?:[0-9]+[+\-])+$")  # 7+  57-6+  5-1467+
_PREFIX_TOKEN_RE = re.compile(r"^(?:[+\-][0-9]+)+$")  # +7  -5  +39  +7-5
_NAME_LINE_RE = re.compile(r"^\s*([0-9０-９]{1,2})\s*[.．、:：]\s*(.*?)\s*$")
_ANOTHER_NAME_RE = re.compile(r"\s(?:10|[0-9])\s*[.．、:：]\s*\S")
_GAMEISH_RE = re.compile(r"^(?:[0-9]|[oxOX]{2,}(?![A-Za-z]))")
_TITLE_DATE_RE = re.compile(r"^([0-9]{2})([0-9]{2})(?![0-9])(.*)$")


def normalize_line(raw: str) -> str:
    """NFKC (full-width digits/colons/plus -> ASCII), symbol fixes, markdown edges, one space."""
    s = unicodedata.normalize("NFKC", raw).translate(_SYMBOLS)
    s = s.strip().strip(_MARKDOWN_EDGES).strip()
    return " ".join(s.split())


@dataclass(frozen=True)
class Proposal:
    team: str  # seat chars as written
    votes: tuple[str, ...] = ()  # anomaly tokens, canonical sign-last form ("7+", "5-", "57-6+")

    def render(self) -> str:
        return " ".join((self.team, *self.votes))


@dataclass(frozen=True)
class Lake:
    holder: str
    target: str
    declared: str = ""  # "o", "x", "?" or "" (not written)

    def render(self) -> str:
        return f"{self.holder}>{self.target}" + (f" {self.declared}" if self.declared else "")


@dataclass(frozen=True)
class Item:
    kind: str  # proposal mission lake config assassin name text
    text: str  # the normalized line
    data: Any = None


def canonical_vote_token(token: str) -> str:
    """'+7' -> '7+', '-5' -> '5-', '+7-5' -> '7+5-'; sign-last tokens unchanged."""
    if _SUFFIX_TOKEN_RE.match(token):
        return token
    if _PREFIX_TOKEN_RE.match(token):
        return "".join(seats + sign for sign, seats in re.findall(r"([+\-])([0-9]+)", token))
    raise SkipPost(SKIP_BAD_VOTE)


def classify_line(raw: str) -> Item | None:
    s = normalize_line(raw)
    if not s:
        return None
    m = _ASSASSIN_RE.match(s)
    if m:
        return Item("assassin", s, m.group(1).strip())
    m = _NAME_LINE_RE.match(gc._INVISIBLE_CHARS_RE.sub("", raw).strip().strip("`*|~"))
    if m:
        seat = unicodedata.normalize("NFKC", m.group(1))
        seat = "0" if seat == "10" else seat
        if seat in SEATS and len(seat) == 1:
            return Item("name", s, (seat, m.group(2)))
    if _CONFIG_RE.match(s):
        return Item("config", s, s)
    if _MISSION_RE.match(s):
        return Item("mission", s, s.replace(" ", "").lower())
    m = _LAKE_RE.match(s) or _OLD_LAKE_RE.match(s)
    if m:
        return Item("lake", s, Lake(m.group(1), m.group(2), (m.group(3) or "").lower()))
    m = _PROPOSAL_RE.match(s)
    if m:
        tokens = ([m.group(2)] if m.group(2) else []) + m.group(3).split()
        return Item("proposal", s, (m.group(1), tokens, (m.group(4) or "").lower()))
    return Item("text", s)


GAME_KINDS = ("proposal", "mission", "lake")


# ---------------------------------------------------------------------------
# Parsing a post into a validated game
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Round:
    proposals: tuple[Proposal, ...]
    mission: str  # lower-case, as written


@dataclass(frozen=True)
class LakeUse:
    after_round: int  # completed rounds when the line appeared
    lake: Lake
    mid_round: bool  # a proposal of the next round came before it


@dataclass
class ParsedGame:
    rounds: list[Round]
    lakes: list[LakeUse]
    config: str
    names: dict[str, str]  # seat -> name, all of SEATS
    outcome: str  # 三紅 / 三藍死 / 三藍活
    kill: str  # 刺殺: target seat or ""
    category: str  # 分類
    date: str  # 日期時間 YYYY/MM/DD
    game_no: str  # 場次
    date_from_title: bool

    def text(self) -> str:
        """文字記錄: one proposal / mission / lake per line (the 牌譜 format)."""
        lakes = {u.after_round: u.lake for u in self.lakes}
        lines: list[str] = []
        for i, rnd in enumerate(self.rounds, 1):
            lines += [p.render() for p in rnd.proposals]
            lines.append(rnd.mission)
            if i in lakes:
                lines.append(lakes[i].render())
        return "\n".join(lines)


def round_is_red(mission: str, round_index: int) -> bool:
    """round_index 0-based; the 4th mission of a 10-player game fails only with 2 fails."""
    return mission.count("x") >= (2 if round_index == 3 else 1)


def decided_after(missions: Sequence[str]) -> int | None:
    """1-based round at which one side reached 3 missions, or None."""
    red = blue = 0
    for i, mission in enumerate(missions):
        if round_is_red(mission, i):
            red += 1
        else:
            blue += 1
        if red == 3 or blue == 3:
            return i + 1
    return None


def _game_block(items: list[Item], title: str) -> tuple[list[Item], list[Item]]:
    """(record items, footer items). Free text outside the record is ignored unless it looks
    like part of a record; anything but record lines inside it makes the post unreadable."""
    footer: list[Item] = []
    consumed: set[int] = set()
    for i, item in enumerate(items):
        if item.kind == "assassin" and not item.data and i + 1 < len(items):
            nxt = items[i + 1]  # "刺客刺殺:" then the target (or x) on its own line
            if _TARGET_RE.match(nxt.text) or _NO_TARGET_RE.match(nxt.text):
                consumed.add(i + 1)
                footer.append(Item("assassin", item.text + " " + nxt.text, nxt.text))
                consumed.add(i)
    for i, item in enumerate(items):
        if item.kind != "text" and item.kind not in GAME_KINDS and i not in consumed:
            footer.append(item)
    game_idx = [i for i, item in enumerate(items) if item.kind in GAME_KINDS and i not in consumed]
    if not game_idx:
        raise SkipPost(SKIP_NO_RECORD)
    first, last = game_idx[0], game_idx[-1]
    norm_title = normalize_line(title)
    for i, item in enumerate(items):
        if first <= i <= last:
            if item.kind not in GAME_KINDS or i in consumed:
                raise SkipPost(SKIP_UNRECOGNIZED)
        elif item.kind == "text" and _GAMEISH_RE.match(item.text):
            if not (i < first and (item.text == norm_title or _TITLE_DATE_RE.match(item.text))):
                raise SkipPost(SKIP_UNRECOGNIZED)
    return items[first:last + 1], footer


def _rounds(block: list[Item]) -> tuple[list[Round], list[LakeUse]]:
    rounds: list[Round] = []
    lakes: list[LakeUse] = []
    current: list[Proposal] = []

    def close(mission: str) -> None:
        if not current:
            raise SkipPost(SKIP_MISSION_NO_TEAM)
        rounds.append(Round(tuple(current), mission))
        current.clear()

    for item in block:
        if item.kind == "proposal":
            team, tokens, inline_mission = item.data
            current.append(Proposal(team, tuple(canonical_vote_token(t) for t in tokens)))
            if inline_mission:
                close(inline_mission)
        elif item.kind == "mission":
            close(item.data)
        else:
            lakes.append(LakeUse(len(rounds), item.data, bool(current)))
    if current:
        raise SkipPost(SKIP_TRAILING_PROPOSAL)
    return rounds, lakes


def _check_rounds(rounds: list[Round]) -> None:
    for r, rnd in enumerate(rounds):
        if r >= len(TEAM_SIZES):
            raise SkipPost(SKIP_AFTER_DECIDED)
        if len(rnd.proposals) > 5:
            raise SkipPost(SKIP_TOO_MANY_PROPOSALS)
        for p in rnd.proposals:
            if len(set(p.team)) != len(p.team):
                raise SkipPost(SKIP_DUP_SEAT)
            if len(p.team) != TEAM_SIZES[r]:
                raise SkipPost(SKIP_TEAM_SIZE)
        if len(rnd.mission) != TEAM_SIZES[r]:
            raise SkipPost(SKIP_MISSION_SIZE)
    decided = decided_after([rnd.mission for rnd in rounds])
    if decided is None:
        raise SkipPost(SKIP_ROUNDS_LT3 if len(rounds) < 3 else SKIP_UNDECIDED)
    if len(rounds) > decided:
        raise SkipPost(SKIP_AFTER_DECIDED)


def _check_lakes(lakes: list[LakeUse], rounds: int) -> None:
    prev_after, prev_target = 0, None
    for use in lakes:
        lake = use.lake
        if (use.mid_round or not 2 <= use.after_round <= 4 or use.after_round <= prev_after
                or use.after_round >= rounds or lake.holder == lake.target
                or (prev_target is not None and lake.holder != prev_target)):
            raise SkipPost(SKIP_BAD_LAKE)
        prev_after, prev_target = use.after_round, lake.target


def _config(footer: list[Item], title: str) -> str:
    found = {item.data for item in footer if item.kind == "config"}
    found |= {item.data for item in footer if item.kind == "assassin" and _CONFIG_RE.match(item.data or "")}
    if len(found) > 1:
        raise SkipPost(SKIP_CONFIG_CONFLICT)
    body = next(iter(found), "")
    t = normalize_line(title)
    title_cfg = t if _CONFIG_RE.match(t) and len(set(t)) == 6 else ""
    if body and title_cfg and body != title_cfg:
        raise SkipPost(SKIP_CONFIG_CONFLICT)
    config = body or title_cfg
    if not config:
        raise SkipPost(SKIP_NO_CONFIG)
    if len(set(config)) != 6:
        raise SkipPost(SKIP_BAD_CONFIG)
    return config


def _assassination(footer: list[Item]) -> tuple[str | None, bool]:
    """(target seat or None, explicitly marked 'no target' with x)."""
    targets: set[str] = set()
    marked_none = False
    for item in footer:
        if item.kind != "assassin":
            continue
        value = item.data or ""
        if not value or _CONFIG_RE.match(value):
            continue
        m = _TARGET_RE.match(value)
        if m:
            targets.add("0" if m.group(1) == "10" else m.group(1))
        elif _NO_TARGET_RE.match(value):
            marked_none = True
        else:
            raise SkipPost(SKIP_BAD_ASSASSIN)
    if len(targets) > 1 or (targets and marked_none):
        raise SkipPost(SKIP_BAD_ASSASSIN)
    return next(iter(targets), None), marked_none


def _outcome(rounds: list[Round], config: str, tags: Sequence[str], target: str | None,
             marked_none: bool) -> tuple[str, str]:
    """(結果, 刺殺) from the result tag, checked against missions and assassination."""
    red = sum(1 for i, rnd in enumerate(rounds) if round_is_red(rnd.mission, i)) >= 3
    merlin = config[5]
    tagged = {RESULT_TAGS[t] for t in tags if t in RESULT_TAGS}
    if len(tagged) > 1:
        raise SkipPost(SKIP_RESULT_TAGS)
    if not tagged:
        if red:
            return gc.OUTCOME_THREE_RED, target or ""
        if target is None:
            raise SkipPost(SKIP_NO_RESULT)
        return (gc.OUTCOME_BLUE_DEAD if target == merlin else gc.OUTCOME_BLUE_ALIVE), target
    outcome = next(iter(tagged))
    if red != (outcome == gc.OUTCOME_THREE_RED):
        raise SkipPost(SKIP_RESULT_MISMATCH)
    if outcome == gc.OUTCOME_BLUE_DEAD:
        if marked_none or (target is not None and target != merlin):
            raise SkipPost(SKIP_ASSASSIN_MISMATCH)
        return outcome, merlin  # Merlin was assassinated: the target is Merlin's seat
    if outcome == gc.OUTCOME_BLUE_ALIVE and target == merlin:
        raise SkipPost(SKIP_ASSASSIN_MISMATCH)
    return outcome, target or ""


def _names(footer: list[Item]) -> dict[str, str]:
    names: dict[str, str] = {}
    for item in footer:
        if item.kind != "name":
            continue
        seat, raw_name = item.data
        if seat in names or _ANOTHER_NAME_RE.search(" " + raw_name):
            raise SkipPost(SKIP_NAMES_MALFORMED)
        names[seat] = gc.normalize_player_name(raw_name)
    if set(names) != set(SEATS) or not all(names.values()):
        raise SkipPost(SKIP_NAMES_MISSING)
    folded = [n.casefold() for n in names.values()]
    if len(set(folded)) != len(folded):
        raise SkipPost(SKIP_NAMES_MALFORMED)
    return {s: names[s] for s in SEATS}


def title_date(title: str, created: dt.datetime) -> tuple[str, str, bool]:
    """(日期時間, 場次, from_title). Title 'MMDD...N' (e.g. 1009一般場4): that day in the year of
    the post (the year before if that day would be after the post), 場次 = the last number.
    Otherwise (e.g. a 配置 as title) the post's own date and no 場次."""
    t = normalize_line(title)
    day: dt.date | None = None
    game_no = ""
    is_config = bool(_CONFIG_RE.match(t)) and len(set(t)) == 6
    m = None if is_config else _TITLE_DATE_RE.match(t)
    if m:
        try:
            day = dt.date(created.year, int(m.group(1)), int(m.group(2)))
            if day > created.date() + dt.timedelta(days=1):
                day = day.replace(year=day.year - 1)
        except ValueError:
            day = None
        if day is not None:
            numbers = re.findall(r"[0-9]+", m.group(3))
            game_no = str(int(numbers[-1])) if numbers else ""
    from_title = day is not None
    day = day or created.date()
    return f"{day.year:04d}/{day.month:02d}/{day.day:02d}", game_no, from_title


def parse_post(post: Post, content: str | None) -> ParsedGame:
    """The validated game of a post, or SkipPost(reason)."""
    if content is None:
        raise SkipPost(SKIP_NO_STARTER)
    if not content.strip():
        raise SkipPost(SKIP_EMPTY)
    if TAG_SIMULATION in post.tags:
        raise SkipPost(SKIP_SIMULATION)
    items = [item for item in map(classify_line, content.splitlines()) if item is not None]
    block, footer = _game_block(items, post.title)
    rounds, lakes = _rounds(block)
    if not rounds:
        raise SkipPost(SKIP_NO_RECORD)
    _check_rounds(rounds)
    _check_lakes(lakes, len(rounds))
    config = _config(footer, post.title)
    reds = set(config[:RED_CONFIG_SLOTS])
    for rnd in rounds:
        if rnd.mission.count("x") > len(set(rnd.proposals[-1].team) & reds):
            raise SkipPost(SKIP_FAILS_GT_RED)
    target, marked_none = _assassination(footer)
    outcome, kill = _outcome(rounds, config, post.tags, target, marked_none)
    names = _names(footer)
    categories = [t for t in CATEGORY_TAGS if t in post.tags]
    date, game_no, from_title = title_date(post.title, post.created)
    return ParsedGame(
        rounds=rounds, lakes=lakes, config=config, names=names, outcome=outcome, kill=kill,
        category=categories[0] if len(categories) == 1 else "", date=date, game_no=game_no,
        date_from_title=from_title,
    )


# ---------------------------------------------------------------------------
# 牌譜 columns derived from 文字記錄 (+ 配置, 玩1..玩0)
# ---------------------------------------------------------------------------

_DERIVE_MISSION_RE = re.compile(r"^[oxOX]+$")
_DERIVE_LAKE_RE = re.compile(r"^[0-9]\s*>")
_DERIVE_TEAM_RE = re.compile(r"^[0-9]+")


def role_abbr(config: str, seat: str) -> str:
    config = config.strip()[:6]
    return ROLE_ABBR[config.index(seat)] if seat and seat in config else LOYAL_ABBR


def derive_columns(text: str, config: str, names: Mapping[str, str]) -> dict[str, str]:
    """The DERIVED_COLUMNS of a 牌譜 row from its 文字記錄, 配置 and 玩1..玩0, by the sheet's rules.

    1-1 = the first proposal's team; 第N局成功失敗 = the N-th mission line (o/x only, lower
    case; a line with trailing blanks is not one); 第N局 = 紅 if that mission failed (2 fails
    needed in round 4) else 藍; 局勢 = 第一局..第五局 joined; 首湖/二湖/三湖 = the N-th lake
    line up to its first space, lower case ("0>8 o" -> "0>8"); 首湖玩家/二湖玩家/三湖玩家 =
    role of the first character of 首湖 (1st holder) and of the last character of 首湖 and
    二湖 (the next holders); 角1/角4/角5/角0 = role of that seat; 派5/派0 = Y if seat 5/0 is
    in 1-1; 外灑 = Y if seat 1 (the first leader) is not; 組成 = the 10 names upper-cased,
    ", "-joined. For the canonical 文字記錄 this script writes, the lake cells are "X>Y".
    """
    first_team = ""
    missions: list[str] = []
    lakes: list[str] = []
    cfg = (config or "").strip()
    for line in re.split(r"\r\n|\r|\n", text or ""):
        if _DERIVE_MISSION_RE.match(line):
            missions.append(line.lower())
            continue
        line = line.strip()
        if _DERIVE_LAKE_RE.match(line):
            lakes.append(line.split(" ")[0].lower())
            continue
        m = _DERIVE_TEAM_RE.match(line)
        if m and not first_team:
            first_team = m.group(0)
    cols: dict[str, str] = {"1-1": first_team}
    colors = []
    for i, (name, result_name) in enumerate(zip(ROUND_COLUMNS, ROUND_RESULT_COLUMNS)):
        result = missions[i] if i < len(missions) else ""
        color = ("紅" if round_is_red(result, i) else "藍") if result else ""
        cols[result_name] = result
        cols[name] = color
        colors.append(color)
    cols["局勢"] = "".join(colors)
    for i, name in enumerate(LAKE_COLUMNS):
        cols[name] = lakes[i] if i < len(lakes) else ""
    chain = [lakes[0][0], lakes[0][-1]] + ([lakes[1][-1]] if len(lakes) > 1 else []) if lakes else []
    for i, name in enumerate(LAKE_PLAYER_COLUMNS):
        cols[name] = role_abbr(cfg, chain[i]) if i < len(chain) else ""
    for name, seat in ROLE_SEAT_COLUMNS.items():
        cols[name] = role_abbr(cfg, seat)
    cols["派5"] = "Y" if "5" in first_team else "N"
    cols["派0"] = "Y" if "0" in first_team else "N"
    cols["外灑"] = "N" if "1" in first_team else "Y"
    cols["組成"] = ", ".join((names.get(s) or "").upper() for s in SEATS)
    return cols


def outcome_from_record(missions: Sequence[str], kill: str, config: str) -> str:
    """結果 as the missions and 刺殺 imply it ('' if neither side has 3 missions)."""
    red = sum(1 for i, m in enumerate(missions) if m and round_is_red(m, i))
    blue = sum(1 for i, m in enumerate(missions) if m and not round_is_red(m, i))
    if red >= 3:
        return gc.OUTCOME_THREE_RED
    if blue >= 3:
        merlin = config.strip()[5:6]
        return gc.OUTCOME_BLUE_DEAD if kill.strip() and kill.strip() == merlin else gc.OUTCOME_BLUE_ALIVE
    return ""


def build_row(post: Post, game: ParsedGame, header: Sequence[str], imported_at: str) -> list[str]:
    text = game.text()
    cols = derive_columns(text, game.config, game.names)
    cols.update({
        "流水號": f"D{post.id}", "文字記錄": text, "配置": game.config, "刺殺": game.kill,
        "分類": game.category, "日期時間": game.date, "場次": game.game_no, "結果": game.outcome,
        **{gc.PLAYER_COLUMNS[s]: game.names[s] for s in SEATS},
        "discord_post_id": post.id, "discord_title": post.title,
        "discord_tags": "、".join(post.tags), "匯入時間": imported_at,
    })
    return [cols.get(h.strip(), "") for h in header]


# ---------------------------------------------------------------------------
# What is already in the Sheet
# ---------------------------------------------------------------------------

def _header_index(rows: Sequence[Sequence[str]]) -> dict[str, int]:
    idx: dict[str, int] = {}
    for i, h in enumerate(rows[0] if rows else []):
        idx.setdefault((h or "").strip(), i)
    return idx


def _cell(row: Sequence[str], idx: Mapping[str, int], name: str) -> str:
    i = idx.get(name)
    return (row[i] or "") if i is not None and i < len(row) else ""


def _folded_names(names: Iterable[str]) -> tuple[str, ...]:
    return tuple(gc.normalize_player_name(n).casefold() for n in names)


class SheetIndex:
    """Fingerprints of the 牌譜 games, plus what near_duplicate needs."""

    def __init__(self, rows: Sequence[Sequence[str]]):
        idx = _header_index(rows)
        self.games = 0
        self.fingerprints: set[str] = set()
        self.names: set[str] = set()
        self._by_config_missions: dict[tuple[str, tuple[str, ...]], list[tuple[str, ...]]] = {}
        self._by_missions_players: set[tuple[tuple[str, ...], tuple[str, ...]]] = set()
        for row in rows[1:]:
            config = _cell(row, idx, "配置").strip()
            if not _cell(row, idx, "流水號").strip() or len(config) != 6:  # as gc.parse_game_log
                continue
            self.games += 1
            text = _cell(row, idx, "文字記錄")
            self.fingerprints.add(gc.record_fingerprint(config, text))
            _, _, missions = gc.record_fingerprint_parts(config, text)
            raw_names = [_cell(row, idx, gc.PLAYER_COLUMNS[s]) for s in SEATS]
            self.names.update(n for n in map(gc.normalize_player_name, raw_names) if n)
            folded = _folded_names(raw_names)
            self._by_config_missions.setdefault((config, missions), []).append(folded)
            if all(folded):
                self._by_missions_players.add((missions, folded))

    def near_duplicate(self, config: str, text: str, names: Mapping[str, str]) -> bool:
        """Same 配置 and mission results as a 牌譜 game that has no full player list or the same
        players on >= 8 seats, or the same mission results with the same 10 players in the same
        seats (配置 retyped). Catches a 牌譜 copy whose proposals were edited."""
        _, _, missions = gc.record_fingerprint_parts(config, text)
        folded = _folded_names(names[s] for s in SEATS)
        for other in self._by_config_missions.get((config, missions), ()):
            if not all(other) or sum(a == b for a, b in zip(other, folded)) >= 8:
                return True
        return (missions, folded) in self._by_missions_players


class ImportIndex:
    """Post ids, fingerprints and names already in the Discord匯入 tab."""

    def __init__(self, rows: Sequence[Sequence[str]] | None):
        rows = rows or []
        idx = _header_index(rows)
        self.post_ids: set[str] = set()
        self.fingerprints: set[str] = set()
        self.names: set[str] = set()
        self.rows = 0
        for row in rows[1:]:
            post_id = _cell(row, idx, "discord_post_id").strip()
            gid = _cell(row, idx, "流水號").strip()
            if not post_id and gid.startswith("D") and gid[1:].isdigit():
                post_id = gid[1:]
            if not post_id and not gid:
                continue
            self.rows += 1
            if post_id:
                self.post_ids.add(post_id)
            config = _cell(row, idx, "配置").strip()
            if len(config) == 6:
                self.fingerprints.add(gc.record_fingerprint(config, _cell(row, idx, "文字記錄")))
            self.names.update(
                n for n in (gc.normalize_player_name(_cell(row, idx, gc.PLAYER_COLUMNS[s])) for s in SEATS) if n
            )


# ---------------------------------------------------------------------------
# The import plan
# ---------------------------------------------------------------------------

@dataclass
class ImportReport:
    seen: int = 0
    before_since: int = 0
    already_imported: int = 0  # post id already in Discord匯入 (not fetched again)
    fetched: int = 0
    parsed: int = 0
    in_sheet: int = 0  # same fingerprint as a 牌譜 game
    near_dup_sheet: int = 0
    recorded_unmatched: int = 0  # tagged 已收錄 but not found in 牌譜: not imported
    dup_imported: int = 0  # same game as a Discord匯入 row of another post
    dup_run: int = 0  # same game as another post of this run
    held_by_limit: int = 0
    date_from_post_time: int = 0
    new_unknown_names: int = 0  # distinct names in the new rows that neither tab has yet
    skipped: Counter = field(default_factory=Counter)
    skipped_recorded: Counter = field(default_factory=Counter)  # ... of which tagged 已收錄
    rows: list[list[str]] = field(default_factory=list)
    details: list[dict] = field(default_factory=list)  # per post, for --report (local only)

    @property
    def new(self) -> int:
        return len(self.rows) + self.held_by_limit

    def note(self, post: Post, outcome: str) -> None:
        self.details.append({"post_id": post.id, "title": post.title, "tags": list(post.tags), "outcome": outcome})

    def skip(self, post: Post, reason: str) -> None:
        self.skipped[reason] += 1
        if TAG_RECORDED in post.tags:
            self.skipped_recorded[reason] += 1
        self.note(post, f"skipped: {reason}")


def plan_import(
    posts: Iterable[Post],
    fetch: Callable[[Post], str | None],
    sheet_rows: Sequence[Sequence[str]],
    import_rows: Sequence[Sequence[str]] | None,
    header: Sequence[str],
    *,
    since: dt.date | None = None,
    limit: int | None = None,
    imported_at: str = "",
) -> ImportReport:
    """Decide, post by post (oldest first), what to append to Discord匯入. Pure apart from `fetch`."""
    report = ImportReport()
    sheet = SheetIndex(sheet_rows)
    imported = ImportIndex(import_rows)
    run_fps: set[str] = set()
    unknown_names: set[str] = set()
    for post in sorted(posts, key=lambda p: int(p.id)):
        report.seen += 1
        if since is not None and post.created.date() < since:
            report.before_since += 1
            continue
        if post.id in imported.post_ids:
            report.already_imported += 1
            report.note(post, "already imported")
            continue
        if TAG_SIMULATION in post.tags:  # no need to fetch it
            report.skip(post, SKIP_SIMULATION)
            continue
        content = fetch(post)
        report.fetched += 1
        try:
            game = parse_post(post, content)
        except SkipPost as exc:
            report.skip(post, exc.reason)
            continue
        except Exception:  # never let one odd post (or its text, in a traceback) through
            report.skip(post, SKIP_INTERNAL)
            continue
        report.parsed += 1
        text = game.text()
        fp = gc.record_fingerprint(game.config, text)
        if fp in sheet.fingerprints:
            report.in_sheet += 1
            report.note(post, "already in 牌譜")
        elif sheet.near_duplicate(game.config, text, game.names):
            report.near_dup_sheet += 1
            report.note(post, "near-duplicate of a 牌譜 game")
        elif TAG_RECORDED in post.tags:
            report.recorded_unmatched += 1
            report.note(post, "tagged 已收錄 but not found in 牌譜")
        elif fp in imported.fingerprints:
            report.dup_imported += 1
            report.note(post, "same game as another post already in Discord匯入")
        elif fp in run_fps:
            report.dup_run += 1
            report.note(post, "same game as an earlier post")
        else:
            run_fps.add(fp)
            if limit is not None and len(report.rows) >= limit:
                report.held_by_limit += 1
                report.note(post, "new (held back by --limit)")
                continue
            report.rows.append(build_row(post, game, header, imported_at))
            report.note(post, "new")
            report.date_from_post_time += not game.date_from_title
            unknown_names.update(n for n in game.names.values() if n not in sheet.names and n not in imported.names)
    report.new_unknown_names = len(unknown_names)
    return report


def report_lines(report: ImportReport, *, write: bool, written: int, tab_exists: bool,
                 missing_tags: Sequence[str] = ()) -> list[str]:
    """Markdown summary: counts and fixed reason strings only (public logs)."""
    mode = f"已寫入 {written} 列" if write else "dry run，未寫入"
    lines = [
        f"### Discord 牌譜匯入（{mode}）",
        f"- 論壇貼文：{report.seen}"
        + (f"（--since 之前 {report.before_since}）" if report.before_since else ""),
        f"- 已在 {gc.DISCORD_IMPORT_TAB}（同一貼文，不再讀取）：{report.already_imported}",
        f"- 讀取起始訊息：{report.fetched}；完整解析：{report.parsed}",
        f"  - 已在 {gc.GAME_LOG_TAB}（指紋相同）：{report.in_sheet}",
        f"  - 疑似已在 {gc.GAME_LOG_TAB}（同配置與任務結果，或同玩家與任務結果）：{report.near_dup_sheet}",
        f"  - 標「{TAG_RECORDED}」但 {gc.GAME_LOG_TAB} 找不到（不匯入，請人工確認）：{report.recorded_unmatched}",
        f"  - 與 {gc.DISCORD_IMPORT_TAB} 另一篇貼文同局：{report.dup_imported}；與本次另一篇同局：{report.dup_run}",
        f"  - 新局：{report.new}"
        + (f"（本次寫入上限 --limit，保留 {report.held_by_limit} 局到下次）" if report.held_by_limit else ""),
    ]
    if report.rows:
        lines.append(
            f"  - 新局中日期取自發文時間（標題無 MMDD）：{report.date_from_post_time}；"
            f"兩個分頁都還沒有的玩家名字：{report.new_unknown_names} 個"
        )
    skipped = sum(report.skipped.values())
    lines.append(f"- 略過（無法完整、無歧義地解析）：{skipped}")
    if skipped:
        lines += ["", f"| 原因 | 篇數 | 其中標「{TAG_RECORDED}」 |", "|---|---|---|"]
        for reason, n in sorted(report.skipped.items(), key=lambda kv: (-kv[1], kv[0])):
            lines.append(f"| {reason} | {n} | {report.skipped_recorded.get(reason, 0)} |")
    if not tab_exists:
        lines.append(f"- {gc.DISCORD_IMPORT_TAB} 分頁尚不存在" + ("，已建立" if write and written else "，寫入時會建立"))
    if missing_tags:
        lines.append(f"- 論壇沒有這些預期的標籤（改名了？）：{'、'.join(missing_tags)}")
    return lines


# ---------------------------------------------------------------------------
# Discord (read only)
# ---------------------------------------------------------------------------

class DiscordError(Exception):
    pass


class DiscordClient:
    """GET-only Discord REST client; honours 429 retry_after and the rate-limit headers.

    Errors name the route template only (no ids, no content) and never the token.
    """

    def __init__(self, token: str, opener: Callable[..., Any] | None = None,
                 sleep: Callable[[float], None] = time.sleep, pace: float = FETCH_PACE_SECONDS):
        self._token = token
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self._pace = pace

    def get(self, path: str, route: str, allow_404: bool = False) -> Any:
        request = urllib.request.Request(DISCORD_API + path, headers={
            "Authorization": f"Bot {self._token}", "User-Agent": USER_AGENT})
        for attempt in range(MAX_ATTEMPTS):
            try:
                with self._open(request, timeout=30) as response:
                    body = response.read()
                    headers = getattr(response, "headers", {}) or {}
                    if str(headers.get("X-RateLimit-Remaining", "")) == "0":
                        self._sleep(min(float(headers.get("X-RateLimit-Reset-After") or 1), MAX_RETRY_SLEEP))
                    elif self._pace:
                        self._sleep(self._pace)
                    return json.loads(body or b"null")
            except urllib.error.HTTPError as exc:
                payload = _json_or_empty(exc)
                if exc.code == 429:
                    retry = payload.get("retry_after") or (exc.headers or {}).get("Retry-After") or 2
                    self._sleep(min(float(retry), MAX_RETRY_SLEEP) + 0.25)
                    continue
                if exc.code == 404 and allow_404:
                    return None
                if exc.code >= 500:
                    self._sleep(min(2 ** attempt, MAX_RETRY_SLEEP))
                    continue
                raise DiscordError(_discord_error_message(exc.code, payload.get("code"), route)) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt == MAX_ATTEMPTS - 1:
                    raise DiscordError(f"GET {route}: network error ({type(exc).__name__})") from None
                self._sleep(min(2 ** attempt, MAX_RETRY_SLEEP))
        raise DiscordError(f"GET {route}: still failing after {MAX_ATTEMPTS} attempts (rate limit or server errors)")

    def forum_posts(self, forum_id: str) -> tuple[list[Post], list[str]]:
        """All posts (active + archived public threads) of a forum, and expected tags it lacks."""
        channel = self.get(f"/channels/{forum_id}", "/channels/{forum}")
        tags = {t.get("id"): t.get("name", "") for t in channel.get("available_tags") or []}
        guild = channel.get("guild_id") or GUILD_ID
        active = self.get(f"/guilds/{guild}/threads/active", "/guilds/{guild}/threads/active")
        threads = [t for t in (active or {}).get("threads", []) if t.get("parent_id") == forum_id]
        before = None
        while True:
            query = "?limit=100" + (f"&before={urllib.parse.quote(before, safe='')}" if before else "")
            page = self.get(f"/channels/{forum_id}/threads/archived/public{query}",
                            "/channels/{forum}/threads/archived/public") or {}
            batch = page.get("threads") or []
            threads += batch
            if not page.get("has_more") or not batch:
                break
            next_before = (batch[-1].get("thread_metadata") or {}).get("archive_timestamp")
            if not next_before or next_before == before:
                break
            before = next_before
        unique = {t["id"]: t for t in threads if t.get("id")}
        posts = [
            Post(id=t["id"], title=t.get("name") or "",
                 tags=tuple(tags[x] for x in t.get("applied_tags") or [] if x in tags))
            for t in unique.values()
        ]
        posts.sort(key=lambda p: int(p.id))
        names = set(tags.values())
        return posts, [t for t in EXPECTED_TAGS if t not in names]

    def starter_content(self, thread_id: str) -> str | None:
        """The text of a post's starter message, None if it was deleted."""
        message = self.get(f"/channels/{thread_id}/messages/{thread_id}",
                           "/channels/{thread}/messages/{thread}", allow_404=True)
        if message is None:
            return None
        return message.get("content") or ""


def _json_or_empty(exc: urllib.error.HTTPError) -> dict:
    try:
        data = json.loads(exc.read() or b"{}")
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _discord_error_message(status: int, code: Any, route: str) -> str:
    detail = f"GET {route}: HTTP {status}" + (f" (Discord code {code})" if code else "")
    if status == 401:
        return f"{detail}. Discord rejected {ENV_DISCORD_TOKEN}: reset the bot token and update the secret."
    if status == 403:
        return (f"{detail}. The bot cannot read the forum: give it View Channel and Read Message History "
                "on #牌譜紀錄與覆盤 (and the Message Content intent).")
    return detail


# ---------------------------------------------------------------------------
# Google Sheets
# ---------------------------------------------------------------------------

def import_header(sheet_rows: Sequence[Sequence[str]], import_rows: Sequence[Sequence[str]] | None) -> list[str]:
    """The Discord匯入 header: the existing one, or 牌譜's header + EXTRA_COLUMNS for a new tab."""
    if import_rows:
        header = [(h or "").strip() for h in import_rows[0]]
        where = f"the {gc.DISCORD_IMPORT_TAB} header row"
        needed = (*REQUIRED_COLUMNS, "discord_post_id")
    else:
        base = [(h or "").strip() for h in (sheet_rows[0] if sheet_rows else [])]
        header = base + [c for c in EXTRA_COLUMNS if c not in base]
        where = f"the {gc.GAME_LOG_TAB} header row (copied to the new {gc.DISCORD_IMPORT_TAB} tab)"
        needed = REQUIRED_COLUMNS
    missing = [c for c in needed if c not in header]
    if missing:
        raise gc.FatalError(
            f"{where} lacks column(s) {', '.join(missing)}; nothing was written. Fix the header row and re-run.",
            gc.EXIT_DATA, f"{gc.DISCORD_IMPORT_TAB} header incomplete",
        )
    return header


def append_import_rows(sh: Any, header: Sequence[str], rows: Sequence[Sequence[str]],
                       tab_exists: bool, has_header: bool) -> None:
    """Create Discord匯入 and its header row if needed, then append `rows` as plain text (RAW:
    "098735" stays text, nothing is parsed as a formula). INSERT_ROWS never overwrites cells."""
    if tab_exists:
        ws = sh.worksheet(gc.DISCORD_IMPORT_TAB)
    else:
        ws = sh.add_worksheet(title=gc.DISCORD_IMPORT_TAB, rows=1, cols=len(header))
    if not has_header:
        ws.update(values=[list(header)], range_name="A1", raw=True)
    ws.append_rows([list(r) for r in rows], value_input_option="RAW",
                   insert_data_option="INSERT_ROWS", table_range="A1")


def google_error(exc: BaseException, sheet_id: str, email: str | None, write: bool) -> gc.FatalError | None:
    kind = gc.classify_google_error(exc)
    if kind is None:
        return None
    who = email or "the service account (client_email missing from the key)"
    if kind == "permission" and write:
        detail = gc._google_error_detail(exc)
        if "has not been used" in detail.lower() or "is disabled" in detail.lower():
            return gc.FatalError(gc.google_access_error_message(kind, exc, sheet_id, email),
                                 gc.EXIT_GOOGLE_ACCESS, "Google Sheets API disabled")
        return gc.FatalError(
            f"Service account {who} may not write to spreadsheet {sheet_id} ({detail}). "
            f"Share the Google Sheet with {who} as Editor (Viewer is not enough to create and "
            f"append to the {gc.DISCORD_IMPORT_TAB} tab), then re-run. Nothing was written.",
            gc.EXIT_GOOGLE_ACCESS, "Service account needs Editor on the Google Sheet",
        )
    titles = {"auth": "Google rejected the service-account key", "permission": "Service account cannot open the Google Sheet",
              "not_found": "Google Sheet not found", "missing_worksheet": "Worksheet missing from the Google Sheet"}
    code = gc.EXIT_DATA if kind == "missing_worksheet" else gc.EXIT_GOOGLE_ACCESS
    return gc.FatalError(gc.google_access_error_message(kind, exc, sheet_id, email), code, titles[kind])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(
    args: argparse.Namespace,
    env: Mapping[str, str] | None = None,
    open_sheet: Callable[..., Any] | None = None,
    discord: DiscordClient | None = None,
    now: dt.datetime | None = None,
) -> int:
    env = os.environ if env is None else env
    write = not args.dry_run
    if args.report and env.get("GITHUB_ACTIONS") == "true":
        raise gc.FatalError("--report writes post titles and is for local runs only, not GitHub Actions "
                            "(public logs and artifacts).", gc.EXIT_CONFIG, "--report refused in CI")
    token = (env.get(ENV_DISCORD_TOKEN) or "").strip()
    if discord is None and not token:
        raise gc.FatalError(f"{ENV_DISCORD_TOKEN} is not set.", gc.EXIT_CONFIG, "Discord token missing")
    source = gc.resolve_credentials_source(env)
    sheet_id = gc.resolve_sheet_id(env)
    email = source.client_email()
    forum_id = (env.get(ENV_FORUM_ID) or "").strip() or FORUM_CHANNEL_ID
    print(f"Mode: {'write (append to ' + gc.DISCORD_IMPORT_TAB + ')' if write else 'dry run (nothing is written)'}")
    print(f"Service account: {email or '(client_email not found in key)'}; spreadsheet: {sheet_id}")

    opener = open_sheet or gc.open_spreadsheet
    try:
        sh = opener(source, sheet_id, WRITE_SCOPES if write else None)
        sheet_rows = sh.worksheet(gc.GAME_LOG_TAB).get_all_values()
        import_rows = gc.read_optional_worksheet(sh, gc.DISCORD_IMPORT_TAB)
    except gc.FatalError:
        raise
    except Exception as exc:
        err = google_error(exc, sheet_id, email, write)
        if err is None:
            raise
        raise err from None
    tab_exists = import_rows is not None
    header = import_header(sheet_rows, import_rows)
    print(f"{gc.GAME_LOG_TAB}: {max(len(sheet_rows) - 1, 0)} rows; {gc.DISCORD_IMPORT_TAB}: "
          + (f"{max(len(import_rows) - 1, 0)} rows" if tab_exists else "tab not created yet"))

    client = discord or DiscordClient(token)
    try:
        posts, missing_tags = client.forum_posts(forum_id)
        print(f"Forum posts: {len(posts)}")
        fetched = 0

        def fetch(post: Post) -> str | None:
            nonlocal fetched
            fetched += 1
            if fetched % 200 == 0:
                print(f"  fetched {fetched} starter messages...", flush=True)
            return client.starter_content(post.id)

        stamp = (now or dt.datetime.now(TAIPEI)).astimezone(TAIPEI).strftime("%Y-%m-%d %H:%M:%S")
        report = plan_import(posts, fetch, sheet_rows, import_rows, header,
                             since=args.since, limit=args.limit, imported_at=stamp)
    except DiscordError as exc:
        raise gc.FatalError(f"{exc} Nothing was written.", EXIT_DISCORD, "Discord API error") from None

    written = 0
    if write and report.rows:
        try:
            append_import_rows(sh, header, report.rows, tab_exists, has_header=bool(import_rows))
        except Exception as exc:
            err = google_error(exc, sheet_id, email, write=True)
            if err is None:
                # Google's own message may quote the values sent (names, records): keep it out of
                # the public log. Re-running is safe: rows that did land are skipped by post id.
                status = getattr(getattr(exc, "response", None), "status_code", None)
                err = gc.FatalError(
                    f"Appending to {gc.DISCORD_IMPORT_TAB} failed ({type(exc).__name__}"
                    + (f", HTTP {status}" if status else "") + "); details withheld because the log is "
                    "public. Re-run (posts already written are skipped), or run locally to see the error.",
                    gc.EXIT_GOOGLE_ACCESS, "Google Sheets write failed",
                )
            raise err from None
        written = len(report.rows)

    lines = report_lines(report, write=write, written=written, tab_exists=tab_exists, missing_tags=missing_tags)
    print("\n".join(lines))
    gc._append_step_summary(lines)
    if missing_tags and env.get("GITHUB_ACTIONS") == "true":
        print(f"::warning title=Forum tags missing::{len(missing_tags)} expected forum tag(s) not found; see the job summary.")
    if args.report:
        Path(args.report).write_text(json.dumps(report.details, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Per-post report written to {args.report} (contains titles: keep it local).")
    return 0


def _date(value: str) -> dt.date:
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a date (YYYY-MM-DD): {value!r}") from None


def _positive(value: str) -> int:
    try:
        n = int(value)
    except ValueError:
        n = -1
    if n < 0:
        raise argparse.ArgumentTypeError(f"not a non-negative integer: {value!r}")
    return n


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=f"Import Discord forum game records into the {gc.DISCORD_IMPORT_TAB} tab.")
    parser.add_argument("--dry-run", action="store_true",
                        help="parse, dedupe and print the counts; write nothing")
    parser.add_argument("--limit", type=_positive, metavar="N",
                        help="append at most N new games (oldest first); the rest wait for the next run")
    parser.add_argument("--since", type=_date, metavar="YYYY-MM-DD",
                        help="only posts created on or after this date (Taipei time)")
    parser.add_argument("--report", metavar="PATH",
                        help="local runs only: write per-post outcomes (with titles) as JSON to PATH")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except gc.FatalError as exc:
        gc.emit_error(str(exc), exc.title)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
