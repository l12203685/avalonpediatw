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
    discord_tags, 匯入時間 if missing) and, with --reply, to Discord回覆 (one row per
    reply posted: discord_post_id, 回覆時間, 原因). Never writes to any other tab.
  * writes to Discord only with --reply: one message in the thread of each recent post
    (--reply-since-days, default 14) that could not be parsed because of its format,
    saying which line and why (SKIP_EXPLANATIONS) plus the format hint, mentioning
    nobody. Once per post: a post in Discord回覆 is never replied to again (even if that
    message was deleted), and the bot's own marker message (REPLY_MARKER) is looked for
    in the thread before posting. At most --reply-limit (20) per run; HTTP 403 is counted
    and warned about, never fatal; the message is never re-sent after a server error or
    timeout (Discord may have stored it). Posts tagged 已收錄 / 模擬, deleted or empty
    starters, duplicates, and posts with no record lines and nothing that says they were
    meant as a record (no result tag, no 6-digit 配置) get no reply. If the forum lacks
    one of the tags that decide this (renamed?), no reply is posted at all. With
    --dry-run the replies are counted, not posted.
  * idempotent: a post already in Discord匯入 (by discord_post_id) is not fetched
    again; a game already in 牌譜 (generate_cache.record_fingerprint, or the same
    配置 + mission results with the same players) or tagged 已收錄 is not imported;
    posts tagged 模擬 (simulations) are not imported either.
  * prints counts and fixed reason strings only (stdout and $GITHUB_STEP_SUMMARY):
    no player names, no record text, no post titles -- the repository is public. The
    line quoted in a reply exists only in that Discord message.

Usage:
    python discord_records_import.py --dry-run            # parse, dedupe, print counts
    python discord_records_import.py                      # ... and append the new rows
    python discord_records_import.py --since 2026-04-01 --limit 5
    python discord_records_import.py --reply              # ... and reply to unreadable recent posts
    python discord_records_import.py --dry-run --report skipped.json   # local only

Configuration (environment):
    DISCORD_BOT_TOKEN              the bot's token (View Channel + Read Message History on
                                   the forum, Message Content intent; --reply also needs
                                   Send Messages in Threads)
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
from typing import Any, Callable, Collection, Iterable, Mapping, Sequence

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
# Tags that decide whether a post gets a --reply (已收錄 / 模擬 exclude it; a result tag is how a
# three-blue game is read). A forum lacking one of them (renamed?) would make the bot reply to
# the wrong posts, so the reply phase is skipped then.
REPLY_GATE_TAGS = (TAG_RECORDED, TAG_SIMULATION, *RESULT_TAGS)

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
# One row per reply posted (--reply): the record that a post was replied to, kept outside Discord
# so that a deleted reply is not posted again the next day.
REPLY_LOG_TAB = "Discord回覆"
REPLY_LOG_COLUMNS = ("discord_post_id", "回覆時間", "原因")
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
SKIP_NOT_A_RECORD = "no game record and nothing says it was meant as one (no result tag, no 6-digit 配置)"
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
    """A post that is not imported; `reason` is one of the SKIP_* strings.

    `line_no` (1-based line of the starter message) and `line_text` (that line as written) are
    set only when the reason points at one line; otherwise None. Reasons stay the fixed public
    strings; the line text is for the Discord reply (--reply) only and is never printed.
    """

    def __init__(self, reason: str, line_no: int | None = None, line_text: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.line_no = line_no or None
        self.line_text = line_text

    def locate(self, lines: Sequence[str]) -> None:
        """Fill line_text from the post's lines when only the line number is known."""
        if self.line_no and self.line_text is None and 1 <= self.line_no <= len(lines):
            self.line_text = lines[self.line_no - 1]


# What each skip reason means, for the Discord reply (--reply). Fixed strings; the reason
# keys above stay the ones printed in logs.
SKIP_EXPLANATIONS = {
    SKIP_NO_STARTER: "起始訊息已刪除或無法讀取",
    SKIP_EMPTY: "起始訊息沒有文字（空白或只有附件）",
    SKIP_SIMULATION: "標了「模擬」，不收錄",
    SKIP_NO_RECORD: "找不到牌譜（沒有提議、任務結果這些行）",
    SKIP_NOT_A_RECORD: "找不到牌譜，也沒有結果標籤或 6 碼配置（不像牌譜貼文，不回覆）",
    SKIP_UNRECOGNIZED: "這一行看不懂：牌譜裡只能有提議、任務結果（o/x）和湖線，其他文字請放在牌譜前面或後面",
    SKIP_BAD_VOTE: "投票異常標記看不懂：每個標記是座號加 + 或 -（例如 7+、5-、+39）",
    SKIP_MISSION_NO_TEAM: "這個任務結果前面沒有提議",
    SKIP_TRAILING_PROPOSAL: "最後一個任務結果後面還有提議（少打了任務結果？）",
    SKIP_TOO_MANY_PROPOSALS: "同一輪超過 5 次提議（少打了任務結果？）",
    SKIP_DUP_SEAT: "同一隊伍裡有重複的座號",
    SKIP_TEAM_SIZE: "隊伍人數不對（10 人局五輪依序是 3、4、4、5、5 人）",
    SKIP_MISSION_SIZE: "任務結果的 o/x 數量和隊伍人數不一樣",
    SKIP_ROUNDS_LT3: "不到 3 輪",
    SKIP_UNDECIDED: "牌譜結束時還沒有一方滿三次任務",
    SKIP_AFTER_DECIDED: "已經有一方三次任務之後還有多的輪次",
    SKIP_BAD_LAKE: "湖線有問題（持湖者和目標相同、湖的傳遞接不上、或不在第 2～4 輪結束後）",
    SKIP_NO_CONFIG: "找不到 6 碼配置（刺、娜、德、奧、派、梅的座號），本文和標題都沒有",
    SKIP_BAD_CONFIG: "配置不是 6 個不同的座號",
    SKIP_CONFIG_CONFLICT: "配置前後不一致（本文裡有兩個不同的，或本文和標題不同）",
    SKIP_FAILS_GT_RED: "這輪任務的失敗數比隊伍裡的紅方人數還多（配置或隊伍打錯了？）",
    SKIP_BAD_ASSASSIN: "刺客刺殺那一行看不懂或前後矛盾（寫座號或 x）",
    SKIP_RESULT_TAGS: "結果標籤超過一個（三紅／三藍被刀／三藍躲刺只能選一個）",
    SKIP_RESULT_MISMATCH: "結果標籤和任務結果對不起來",
    SKIP_ASSASSIN_MISMATCH: "刺殺目標和結果標籤對不起來（三藍被刀的刺殺目標要是梅林的座號）",
    SKIP_NO_RESULT: "三藍但沒有結果標籤也沒有刺殺目標，不知道梅林有沒有被刺中",
    SKIP_NAMES_MISSING: "玩家名單不完整（要有 1～9 號和 10 號，每個座位一行：1.名字）",
    SKIP_NAMES_MALFORMED: "玩家名單有問題（同一座位出現兩次、同一名字兩個座位、或一行寫了好幾個人）",
    SKIP_INTERNAL: "程式內部錯誤",
}

# The Discord reply (--reply): a fixed marker (also how the bot recognizes its own reply), then
# the reason, the format hint and what happens next. Sent to the post's thread only; never printed.
REPLY_MARKER = "🤖 牌譜格式檢查"
REPLY_INTRO = "這篇牌譜目前無法自動收錄到戰績統計。"
FORMAT_HINT = "\n".join([
    "格式提示（照牌譜順序，每行一項）：",
    "・每次提議一行：隊伍座號連寫（0 = 10 號），可接投票異常標記：座號加 + 或 -，例如 389 +7、469 57-6+",
    "・每輪任務結果一行：o 成功、x 失敗，例如 ooox",
    "・湖：持湖者>目標 宣告，例如 0>8 o（o = 宣告藍、x = 宣告紅）",
    "・牌譜之後：刺客刺殺：座號或 x；配置 6 碼（刺、娜、德、奧、派、梅的座號，例如 936758）；"
    "玩家名單每人一行：1.名字 … 9.名字、10.名字",
    "・貼文標籤擇一：三紅／三藍被刀／三藍躲刺",
])
REPLY_FOOTER = "修正起始訊息後不用做別的，下次排程（每天凌晨）會自動重新讀取並收錄。"
REPLY_LINE_MAX = 60  # quoted line text is cut here (the poster can see the whole line anyway)
REPLY_DEFAULT_DAYS = 14
REPLY_DEFAULT_LIMIT = 20
# Skips that are not the poster's formatting (or not a record post at all): no reply for these.
REPLY_NOT_FOR = frozenset({SKIP_NO_STARTER, SKIP_EMPTY, SKIP_SIMULATION, SKIP_INTERNAL, SKIP_NOT_A_RECORD})
_MARKDOWN_ESCAPE_RE = re.compile(r"([\\`*_~|])")


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
    line_no: int = 0  # 1-based line of the post (0 = unknown)

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
    line_no: int = 0  # 1-based line of the post (0 = unknown)


def canonical_vote_token(token: str, line_no: int | None = None) -> str:
    """'+7' -> '7+', '-5' -> '5-', '+7-5' -> '7+5-'; sign-last tokens unchanged."""
    if _SUFFIX_TOKEN_RE.match(token):
        return token
    if _PREFIX_TOKEN_RE.match(token):
        return "".join(seats + sign for sign, seats in re.findall(r"([+\-])([0-9]+)", token))
    raise SkipPost(SKIP_BAD_VOTE, line_no)


def classify_line(raw: str, line_no: int = 0) -> Item | None:
    s = normalize_line(raw)
    if not s:
        return None
    m = _ASSASSIN_RE.match(s)
    if m:
        return Item("assassin", s, m.group(1).strip(), line_no)
    m = _NAME_LINE_RE.match(gc._INVISIBLE_CHARS_RE.sub("", raw).strip().strip("`*|~"))
    if m:
        seat = unicodedata.normalize("NFKC", m.group(1))
        seat = "0" if seat == "10" else seat
        if seat in SEATS and len(seat) == 1:
            return Item("name", s, (seat, m.group(2)), line_no)
    if _CONFIG_RE.match(s):
        return Item("config", s, s, line_no)
    if _MISSION_RE.match(s):
        return Item("mission", s, s.replace(" ", "").lower(), line_no)
    m = _LAKE_RE.match(s) or _OLD_LAKE_RE.match(s)
    if m:
        return Item("lake", s, Lake(m.group(1), m.group(2), (m.group(3) or "").lower()), line_no)
    m = _PROPOSAL_RE.match(s)
    if m:
        tokens = ([m.group(2)] if m.group(2) else []) + m.group(3).split()
        return Item("proposal", s, (m.group(1), tokens, (m.group(4) or "").lower()), line_no)
    return Item("text", s, None, line_no)


GAME_KINDS = ("proposal", "mission", "lake")


# ---------------------------------------------------------------------------
# Parsing a post into a validated game
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Round:
    proposals: tuple[Proposal, ...]
    mission: str  # lower-case, as written
    line_no: int = 0  # line of the mission result (the team's line in the 2023 style)


@dataclass(frozen=True)
class LakeUse:
    after_round: int  # completed rounds when the line appeared
    lake: Lake
    mid_round: bool  # a proposal of the next round came before it
    line_no: int = 0


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
                footer.append(Item("assassin", item.text + " " + nxt.text, nxt.text, item.line_no))
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
                # A footer line (刺客刺殺 / 配置 / a name) inside the block is fine where it is: the
                # problem is the record line that came after it. Name that one.
                culprit = item if item.kind == "text" else next((items[j] for j in game_idx if j > i), item)
                raise SkipPost(SKIP_UNRECOGNIZED, culprit.line_no)
        elif item.kind == "text" and _GAMEISH_RE.match(item.text):
            if not (i < first and (item.text == norm_title or _TITLE_DATE_RE.match(item.text))):
                raise SkipPost(SKIP_UNRECOGNIZED, item.line_no)
    return items[first:last + 1], footer


def _rounds(block: list[Item]) -> tuple[list[Round], list[LakeUse]]:
    rounds: list[Round] = []
    lakes: list[LakeUse] = []
    current: list[Proposal] = []

    def close(mission: str, line_no: int) -> None:
        if not current:
            raise SkipPost(SKIP_MISSION_NO_TEAM, line_no)
        rounds.append(Round(tuple(current), mission, line_no))
        current.clear()

    for item in block:
        if item.kind == "proposal":
            team, tokens, inline_mission = item.data
            current.append(Proposal(team, tuple(canonical_vote_token(t, item.line_no) for t in tokens), item.line_no))
            if inline_mission:
                close(inline_mission, item.line_no)
        elif item.kind == "mission":
            close(item.data, item.line_no)
        else:
            lakes.append(LakeUse(len(rounds), item.data, bool(current), item.line_no))
    if current:
        raise SkipPost(SKIP_TRAILING_PROPOSAL, current[0].line_no)
    return rounds, lakes


def _check_rounds(rounds: list[Round]) -> None:
    for r, rnd in enumerate(rounds):
        if r >= len(TEAM_SIZES):
            raise SkipPost(SKIP_AFTER_DECIDED, rnd.proposals[0].line_no)
        if len(rnd.proposals) > 5:
            raise SkipPost(SKIP_TOO_MANY_PROPOSALS, rnd.proposals[5].line_no)
        for p in rnd.proposals:
            if len(set(p.team)) != len(p.team):
                raise SkipPost(SKIP_DUP_SEAT, p.line_no)
            if len(p.team) != TEAM_SIZES[r]:
                raise SkipPost(SKIP_TEAM_SIZE, p.line_no)
        if len(rnd.mission) != TEAM_SIZES[r]:
            raise SkipPost(SKIP_MISSION_SIZE, rnd.line_no)
    decided = decided_after([rnd.mission for rnd in rounds])
    if decided is None:
        raise SkipPost(SKIP_ROUNDS_LT3 if len(rounds) < 3 else SKIP_UNDECIDED)
    if len(rounds) > decided:
        raise SkipPost(SKIP_AFTER_DECIDED, rounds[decided].proposals[0].line_no)


def _check_lakes(lakes: list[LakeUse], rounds: int) -> None:
    prev_after, prev_target = 0, None
    for use in lakes:
        lake = use.lake
        if (use.mid_round or not 2 <= use.after_round <= 4 or use.after_round <= prev_after
                or use.after_round >= rounds or lake.holder == lake.target
                or (prev_target is not None and lake.holder != prev_target)):
            raise SkipPost(SKIP_BAD_LAKE, use.line_no)
        prev_after, prev_target = use.after_round, lake.target


def _config(footer: list[Item], title: str) -> str:
    found = [(item.data, item.line_no) for item in footer
             if item.kind == "config" or (item.kind == "assassin" and _CONFIG_RE.match(item.data or ""))]
    body, body_line = found[0] if found else ("", 0)
    for value, line_no in found[1:]:
        if value != body:
            raise SkipPost(SKIP_CONFIG_CONFLICT, line_no)
    t = normalize_line(title)
    title_cfg = t if _CONFIG_RE.match(t) and len(set(t)) == 6 else ""
    if body and title_cfg and body != title_cfg:
        raise SkipPost(SKIP_CONFIG_CONFLICT, body_line)
    config = body or title_cfg
    if not config:
        raise SkipPost(SKIP_NO_CONFIG)
    if len(set(config)) != 6:
        raise SkipPost(SKIP_BAD_CONFIG, body_line if body else None)
    return config


def _assassination(footer: list[Item]) -> tuple[str | None, bool, int | None]:
    """(target seat or None, explicitly marked 'no target' with x, line of the 刺客刺殺 line)."""
    seen: list[tuple[str, int]] = []  # ("x" or the seat, line) in post order
    for item in footer:
        if item.kind != "assassin":
            continue
        value = item.data or ""
        if not value or _CONFIG_RE.match(value):
            continue
        m = _TARGET_RE.match(value)
        if m:
            seen.append(("0" if m.group(1) == "10" else m.group(1), item.line_no))
        elif _NO_TARGET_RE.match(value):
            seen.append(("x", item.line_no))
        else:
            raise SkipPost(SKIP_BAD_ASSASSIN, item.line_no)
    if not seen:
        return None, False, None
    value, line_no = seen[0]
    for other, other_line in seen[1:]:
        if other != value:
            raise SkipPost(SKIP_BAD_ASSASSIN, other_line)
    return (None, True, line_no) if value == "x" else (value, False, line_no)


def _outcome(rounds: list[Round], config: str, tags: Sequence[str], target: str | None,
             marked_none: bool, assassin_line: int | None = None) -> tuple[str, str]:
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
            raise SkipPost(SKIP_ASSASSIN_MISMATCH, assassin_line)
        return outcome, merlin  # Merlin was assassinated: the target is Merlin's seat
    if outcome == gc.OUTCOME_BLUE_ALIVE and target == merlin:
        raise SkipPost(SKIP_ASSASSIN_MISMATCH, assassin_line)
    return outcome, target or ""


def _names(footer: list[Item]) -> dict[str, str]:
    names: dict[str, str] = {}
    lines: dict[str, int] = {}
    for item in footer:
        if item.kind != "name":
            continue
        seat, raw_name = item.data
        if seat in names or _ANOTHER_NAME_RE.search(" " + raw_name):
            raise SkipPost(SKIP_NAMES_MALFORMED, item.line_no)
        names[seat] = gc.normalize_player_name(raw_name)
        lines[seat] = item.line_no
    if set(names) != set(SEATS) or not all(names.values()):
        empty = next((lines[s] for s, n in names.items() if not n), None)
        raise SkipPost(SKIP_NAMES_MISSING, empty)
    folded: dict[str, str] = {}
    for seat, name in names.items():  # post order
        if name.casefold() in folded:
            raise SkipPost(SKIP_NAMES_MALFORMED, lines[seat])
        folded[name.casefold()] = seat
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


def meant_as_record(post: Post, lines: Sequence[str]) -> bool:
    """A result tag, or a 6-digit 配置 in the title or the body: the post was meant as a record
    (as opposed to a discussion, a question or a notice in the same forum)."""
    if any(t in RESULT_TAGS for t in post.tags):
        return True
    return any(_CONFIG_RE.match(normalize_line(s)) for s in (post.title, *lines))


def parse_post(post: Post, content: str | None) -> ParsedGame:
    """The validated game of a post, or SkipPost(reason)."""
    if content is None:
        raise SkipPost(SKIP_NO_STARTER)
    if not content.strip():
        raise SkipPost(SKIP_EMPTY)
    if TAG_SIMULATION in post.tags:
        raise SkipPost(SKIP_SIMULATION)
    lines = content.splitlines()
    try:
        items = [item for item in (classify_line(raw, n) for n, raw in enumerate(lines, 1)) if item is not None]
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
                raise SkipPost(SKIP_FAILS_GT_RED, rnd.line_no)
        target, marked_none, assassin_line = _assassination(footer)
        outcome, kill = _outcome(rounds, config, post.tags, target, marked_none, assassin_line)
        names = _names(footer)
    except SkipPost as exc:
        if exc.reason == SKIP_NO_RECORD and not meant_as_record(post, lines):
            raise SkipPost(SKIP_NOT_A_RECORD) from None
        exc.locate(lines)
        raise
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


def replied_post_ids(rows: Sequence[Sequence[str]] | None) -> set[str]:
    """discord_post_id of every row of the Discord回覆 tab (None: the tab does not exist)."""
    rows = rows or []
    idx = _header_index(rows)
    ids = {_cell(row, idx, "discord_post_id").strip() for row in rows[1:]}
    ids.discard("")
    return ids


# ---------------------------------------------------------------------------
# The import plan
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SkippedPost:
    post: Post
    reason: str
    line_no: int | None = None
    line_text: str | None = None


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
    skips: list[SkippedPost] = field(default_factory=list)  # every skipped post, for --reply
    rows: list[list[str]] = field(default_factory=list)
    details: list[dict] = field(default_factory=list)  # per post, for --report (local only)

    @property
    def new(self) -> int:
        return len(self.rows) + self.held_by_limit

    def note(self, post: Post, outcome: str, **extra: Any) -> None:
        self.details.append({"post_id": post.id, "title": post.title, "tags": list(post.tags), "outcome": outcome, **extra})

    def skip(self, post: Post, reason: str, line_no: int | None = None, line_text: str | None = None) -> None:
        self.skipped[reason] += 1
        if TAG_RECORDED in post.tags:
            self.skipped_recorded[reason] += 1
        self.skips.append(SkippedPost(post, reason, line_no, line_text))
        self.note(post, f"skipped: {reason}", line_no=line_no)


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
            report.skip(post, exc.reason, exc.line_no, exc.line_text)
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


# ---------------------------------------------------------------------------
# Replies to posts that could not be parsed (--reply)
# ---------------------------------------------------------------------------

@dataclass
class ReplyReport:
    """Counts only: nothing here identifies a post."""
    dry_run: bool = False
    candidates: int = 0  # format skips within --reply-since-days, not tagged 已收錄
    already_replied: int = 0  # the bot's marker is already in the thread
    replied: int = 0  # posted (dry run: would be posted)
    forbidden: int = 0  # HTTP 403 (no permission to read or post in the thread)
    errors: int = 0  # other Discord errors (per thread; the run goes on)
    held_by_limit: int = 0


def reply_candidates(report: ImportReport, now: dt.datetime, since_days: int) -> list[SkippedPost]:
    """Skips the poster can fix: a format reason, posted within `since_days`, not tagged 已收錄.
    Oldest first, like the import itself."""
    cutoff = now - dt.timedelta(days=since_days)
    chosen = [s for s in report.skips
              if s.reason not in REPLY_NOT_FOR and TAG_RECORDED not in s.post.tags and s.post.created >= cutoff]
    return sorted(chosen, key=lambda s: int(s.post.id))


def reply_text(skip: SkippedPost) -> str:
    """The reply for one post: marker, why (with the line when known), the format hint. This text
    goes to the post's thread only; it carries record text and must never be printed."""
    why = SKIP_EXPLANATIONS.get(skip.reason, skip.reason)
    if skip.line_no:
        quoted = " ".join((skip.line_text or "").split())
        if len(quoted) > REPLY_LINE_MAX:
            quoted = quoted[:REPLY_LINE_MAX - 1] + "…"
        where = f"第 {skip.line_no} 行「{_MARKDOWN_ESCAPE_RE.sub(r'\\\1', quoted)}」：{why}"
    else:
        where = f"原因：{why}"
    return "\n".join([REPLY_MARKER, REPLY_INTRO, where, "", FORMAT_HINT, "", REPLY_FOOTER])


def reply_to_failures(client: Any, candidates: Sequence[SkippedPost], *, limit: int, dry_run: bool,
                      replied: Collection[str] = frozenset(), posted: list[SkippedPost] | None = None) -> ReplyReport:
    """Post the reply in each candidate's thread unless the bot already did: posts in `replied`
    (the Discord回覆 tab) are skipped without reading the thread, then the bot's own marker message
    is looked for. Each post actually replied to is appended to `posted` (for the Discord回覆 tab).
    At most `limit` attempts; a dry run only counts. Never raises for one thread: 403, other
    Discord errors and any odd response are counted and the run goes on."""
    report = ReplyReport(dry_run=dry_run, candidates=len(candidates))
    if not candidates:
        return report
    try:
        bot_id = client.bot_user_id()
    except Exception:  # cannot tell the bot's own messages apart: reply to nothing
        report.errors += 1
        report.held_by_limit = len(candidates)
        return report
    for skip in candidates:
        if skip.post.id in replied:  # replied once already, whether or not that message still exists
            report.already_replied += 1
            continue
        if report.replied + report.forbidden + report.errors >= limit:
            report.held_by_limit += 1
            continue
        try:
            if client.has_bot_message(skip.post.id, bot_id, REPLY_MARKER):
                report.already_replied += 1
                continue
            if not dry_run:
                client.post_message(skip.post.id, reply_text(skip))
        except DiscordForbidden:
            report.forbidden += 1
            continue
        except Exception:  # a Discord error or an unexpected response: never printed, counted only
            report.errors += 1
            continue
        report.replied += 1
        if posted is not None and not dry_run:
            posted.append(skip)
    return report


def reply_lines(reply: ReplyReport, since_days: int) -> list[str]:
    """Markdown summary of --reply: counts only."""
    mode = "dry run：只計數，未貼文" if reply.dry_run else "已貼文"
    lines = [
        f"- 格式回覆（--reply，{mode}）：{since_days} 天內因格式無法解析且未標「{TAG_RECORDED}」的貼文 {reply.candidates} 篇",
        f"  - 已回覆過（略過）：{reply.already_replied}；本次{'可' if reply.dry_run else '已'}回覆：{reply.replied}；"
        f"沒有發言權限（403）：{reply.forbidden}；其他 Discord 錯誤：{reply.errors}"
        + (f"；超過 --reply-limit 保留到下次：{reply.held_by_limit}" if reply.held_by_limit else ""),
    ]
    return lines


def report_lines(report: ImportReport, *, write: bool, written: int, tab_exists: bool,
                 missing_tags: Sequence[str] = (), reply: ReplyReport | None = None,
                 reply_since_days: int = REPLY_DEFAULT_DAYS) -> list[str]:
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
    if reply is not None:
        lines += reply_lines(reply, reply_since_days)
    return lines


# ---------------------------------------------------------------------------
# Discord (reads; --reply also posts one message per unreadable post)
# ---------------------------------------------------------------------------

class DiscordError(Exception):
    pass


class DiscordForbidden(DiscordError):
    """HTTP 403: the bot lacks a permission (read the thread, or post in it)."""


MESSAGES_PAGE = 100
MAX_MESSAGE_PAGES = 20  # 2000 messages: more than any record thread has


class DiscordClient:
    """Minimal Discord REST client; honours 429 retry_after and the rate-limit headers.

    GET for the forum, its posts and their messages; POST only for --reply (one message in a
    post's thread). Only a GET is re-sent after a server error or a timeout: Discord may have
    stored the message of a POST before the response was lost, and sending it again would post a
    second reply (the next run finds the first one by its marker instead). A 429 is retried for
    both, Discord did not process it. Errors name the route template only (no ids, no content)
    and never the token.
    """

    def __init__(self, token: str, opener: Callable[..., Any] | None = None,
                 sleep: Callable[[float], None] = time.sleep, pace: float = FETCH_PACE_SECONDS):
        self._token = token
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self._pace = pace

    def _request(self, method: str, path: str, route: str, body: Any = None, allow_404: bool = False) -> Any:
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = {"Authorization": f"Bot {self._token}", "User-Agent": USER_AGENT}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(DISCORD_API + path, data=data, headers=headers, method=method)
        resend = method == "GET"  # a POST is never sent twice (see the class docstring)
        for attempt in range(MAX_ATTEMPTS):
            try:
                with self._open(request, timeout=30) as response:
                    raw = response.read()
                    resp_headers = getattr(response, "headers", {}) or {}
                    if str(resp_headers.get("X-RateLimit-Remaining", "")) == "0":
                        self._sleep(min(float(resp_headers.get("X-RateLimit-Reset-After") or 1), MAX_RETRY_SLEEP))
                    elif self._pace:
                        self._sleep(self._pace)
                    return json.loads(raw or b"null")
            except urllib.error.HTTPError as exc:
                payload = _json_or_empty(exc)
                if exc.code == 429:
                    retry = payload.get("retry_after") or (exc.headers or {}).get("Retry-After") or 2
                    self._sleep(min(float(retry), MAX_RETRY_SLEEP) + 0.25)
                    continue
                if exc.code == 404 and allow_404:
                    return None
                if exc.code >= 500 and resend:
                    self._sleep(min(2 ** attempt, MAX_RETRY_SLEEP))
                    continue
                message = _discord_error_message(exc.code, payload.get("code"), route, method)
                raise (DiscordForbidden if exc.code == 403 else DiscordError)(message) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if not resend or attempt == MAX_ATTEMPTS - 1:
                    raise DiscordError(f"{method} {route}: network error ({type(exc).__name__})") from None
                self._sleep(min(2 ** attempt, MAX_RETRY_SLEEP))
        raise DiscordError(f"{method} {route}: still failing after {MAX_ATTEMPTS} attempts (rate limit or server errors)")

    def get(self, path: str, route: str, allow_404: bool = False) -> Any:
        return self._request("GET", path, route, allow_404=allow_404)

    def post(self, path: str, route: str, body: Any) -> Any:
        return self._request("POST", path, route, body=body)

    def bot_user_id(self) -> str:
        """The bot's own user id (to recognize its earlier replies)."""
        me = self.get("/users/@me", "/users/@me") or {}
        user_id = str(me.get("id") or "")
        if not user_id:
            raise DiscordError("GET /users/@me: no user id in the response")
        return user_id

    def has_bot_message(self, thread_id: str, bot_id: str, prefix: str) -> bool:
        """True if a message by `bot_id` starting with `prefix` is in the thread (newest first)."""
        before = None
        for _ in range(MAX_MESSAGE_PAGES):
            query = f"?limit={MESSAGES_PAGE}" + (f"&before={before}" if before else "")
            page = self.get(f"/channels/{thread_id}/messages{query}", "/channels/{thread}/messages") or []
            for message in page:
                author = message.get("author") or {}
                if str(author.get("id") or "") == bot_id and (message.get("content") or "").startswith(prefix):
                    return True
            if len(page) < MESSAGES_PAGE or not page[-1].get("id"):
                break
            before = page[-1]["id"]
        return False

    def post_message(self, thread_id: str, content: str) -> None:
        """One message in a post's thread, mentioning nobody. The nonce (the thread id, one reply
        per thread) with enforce_nonce makes Discord return the bot's existing message instead of
        creating another should the same request reach it twice within a few minutes."""
        self.post(f"/channels/{thread_id}/messages", "/channels/{thread}/messages",
                  {"content": content, "allowed_mentions": {"parse": []},
                   "nonce": thread_id, "enforce_nonce": True})

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


def _discord_error_message(status: int, code: Any, route: str, method: str = "GET") -> str:
    detail = f"{method} {route}: HTTP {status}" + (f" (Discord code {code})" if code else "")
    if status == 401:
        return f"{detail}. Discord rejected {ENV_DISCORD_TOKEN}: reset the bot token and update the secret."
    if status == 403 and method == "POST":
        return (f"{detail}. The bot cannot post in the thread: give it Send Messages in Threads "
                "on #牌譜紀錄與覆盤.")
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
                       tab_exists: bool, has_header: bool, tab: str = gc.DISCORD_IMPORT_TAB) -> None:
    """Create `tab` (Discord匯入, or Discord回覆) and its header row if needed, then append `rows` as
    plain text (RAW: "098735" stays text, nothing is parsed as a formula). INSERT_ROWS never
    overwrites cells."""
    if tab_exists:
        ws = sh.worksheet(tab)
    else:
        ws = sh.add_worksheet(title=tab, rows=1, cols=len(header))
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
        reply_log_rows = gc.read_optional_worksheet(sh, REPLY_LOG_TAB) if args.reply else None
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

        now_taipei = (now or dt.datetime.now(TAIPEI)).astimezone(TAIPEI)
        stamp = now_taipei.strftime("%Y-%m-%d %H:%M:%S")
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

    # The import summary goes out before the reply phase: whatever happens in Discord afterwards,
    # the counts of what was written are in the log and the job summary.
    in_actions = env.get("GITHUB_ACTIONS") == "true"
    reply_gate = [t for t in REPLY_GATE_TAGS if t in missing_tags] if args.reply else []
    lines = report_lines(report, write=write, written=written, tab_exists=tab_exists, missing_tags=missing_tags)
    if reply_gate:
        lines.append(f"- 格式回覆（--reply）：論壇沒有「{'」「'.join(reply_gate)}」標籤，無法判斷哪些貼文該回覆，"
                     "本次未回覆、未計數")
    print("\n".join(lines))
    gc._append_step_summary(lines)
    if missing_tags and in_actions:
        print(f"::warning title=Forum tags missing::{len(missing_tags)} expected forum tag(s) not found; see the job summary.")
    if reply_gate:
        _warn("Discord reply skipped", f"{len(reply_gate)} forum tag(s) that decide which posts get a reply not found "
              "(renamed?); no reply was posted or counted. See the job summary.", in_actions)

    if args.reply and not reply_gate:
        # After the sheet write and its summary: a Discord problem here never loses imported rows.
        candidates = reply_candidates(report, now_taipei, args.reply_since_days)
        posted: list[SkippedPost] = []
        reply = reply_to_failures(client, candidates, limit=args.reply_limit, dry_run=not write,
                                  replied=replied_post_ids(reply_log_rows), posted=posted)
        if posted:
            try:
                append_import_rows(sh, REPLY_LOG_COLUMNS, [[s.post.id, stamp, s.reason] for s in posted],
                                   reply_log_rows is not None, has_header=bool(reply_log_rows), tab=REPLY_LOG_TAB)
            except Exception as exc:  # the message may quote the values: type only
                _warn("Discord reply log not written", f"{len(posted)} reply/replies posted but not recorded in "
                      f"{REPLY_LOG_TAB} ({type(exc).__name__}); the bot's marker message in each thread still "
                      "prevents a second reply unless that message is deleted.", in_actions)
        lines = reply_lines(reply, args.reply_since_days)
        print("\n".join(lines))
        gc._append_step_summary(lines)
        if reply.forbidden:
            _warn("Discord reply forbidden", f"{reply.forbidden} reply/replies not posted (HTTP 403): give the bot "
                  "Send Messages in Threads and Read Message History on #牌譜紀錄與覆盤.", in_actions)
        if reply.errors:
            _warn("Discord reply errors", f"{reply.errors} reply/replies hit a Discord API error or an unexpected "
                  "response; see the job summary. They are retried on the next run.", in_actions)
    if args.report:
        Path(args.report).write_text(json.dumps(report.details, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Per-post report written to {args.report} (contains titles: keep it local).")
    return 0


def _warn(title: str, message: str, in_actions: bool) -> None:
    """A fixed warning (counts allowed, never content); an annotation inside GitHub Actions."""
    print(f"::warning title={title}::{message}" if in_actions else f"[WARNING] {title}: {message}", flush=True)


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
    parser.add_argument("--reply", action="store_true",
                        help="reply in the thread of each recent post that could not be parsed because of its "
                             "format (why, which line, the format hint); once per post. With --dry-run: count only")
    parser.add_argument("--reply-since-days", type=_positive, default=REPLY_DEFAULT_DAYS, metavar="N",
                        help=f"--reply only to posts created in the last N days (default {REPLY_DEFAULT_DAYS})")
    parser.add_argument("--reply-limit", type=_positive, default=REPLY_DEFAULT_LIMIT, metavar="N",
                        help=f"at most N replies per run, oldest post first (default {REPLY_DEFAULT_LIMIT})")
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
