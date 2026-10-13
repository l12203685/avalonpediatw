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
  * writes to Discord only with --reply and --fix-list. --reply: one message in the
    thread of each recent post (--reply-since-days, default 14) that could not be parsed
    because of its format, saying which line and why (SKIP_EXPLANATIONS) plus the format
    hint, mentioning nobody. Once per post: a post in Discord回覆 is never replied to again (even if that
    message was deleted), and the bot's own marker message (REPLY_MARKER) is looked for
    in the thread before posting. At most --reply-limit (20) per run; HTTP 403 is counted
    and warned about, never fatal; the message is never re-sent after a server error or
    timeout (Discord may have stored it). Posts tagged 已收錄 / 模擬, deleted or empty
    starters, duplicates, and posts with no record lines and nothing that says they were
    meant as a record (no result tag, no 6-digit 配置) get no reply. If the forum lacks
    one of the tags that decide this (renamed?), no reply is posted at all. With
    --dry-run the replies are counted, not posted.
  * --reply also keeps the forum tag 待修正 (TAG_FIX) on the posts that need fixing, so whoever
    fixes records can filter the forum by it (--no-tag: off). The tag is looked up by its exact
    name and created (Manage Channels) when the forum lacks it; no permission: a notice and no
    tagging this run. Added to every `fixable` post created within --tag-since-days (90) that
    lacks it (never to a post that already has 5 tags, or a locked one unless --tag-locked);
    removed from every post, of any age, that carries it and now parses (imported now or
    earlier, already in 牌譜, a duplicate) or is tagged 已收錄 / 模擬. Posts this run could not
    judge (starter deleted or empty, not a record, before --since) keep their tags. At most
    --tag-limit (30) changes per run, removals first, then additions newest post first; the
    rest wait for the next run. Each change re-reads the post and sends applied_tags = its
    current tags plus or minus TAG_FIX only (archived:false in the same request when the post
    is archived: Discord edits no archived thread otherwise; it archives again on its own after
    inactivity). HTTP 403 (Manage Threads missing): counted, one notice, no further tag change
    this run; 404 (post deleted): counted. With --dry-run the changes are counted, not made.
  * --fix-list: the weekly list of posts to fix, in the guild text channel 牌譜修正
    (FIX_CHANNEL_NAME, or the channel DISCORD_FIX_CHANNEL_ID names): the posts --reply is
    for (`fixable`) created within --fix-list-days (30), by record date (date, 場次, reason,
    line, link), at most --fix-list-max (50) of them plus how many more, and the size of the
    whole backlog. Once per ISO week (Taipei): the bot's marker (FIX_LIST_MARKER + week) in
    the channel's last FIX_LIST_HISTORY messages means it was posted already (--fix-list-force
    posts anyway), so the workflow can pass --fix-list on several days of the week to catch up
    on a lost Monday run. No channel, or no permission there: a notice, never a failed run.
    With --dry-run the list is built and counted, not posted. Not with --since (the backlog
    would leave out the older posts).
  * idempotent: a post already in Discord匯入 (by discord_post_id) is not fetched
    again; a game already in 牌譜 (generate_cache.record_fingerprint, or the same
    配置 + mission results with the same players) or tagged 已收錄 is not imported;
    posts tagged 模擬 (simulations) are not imported either.
  * prints counts and fixed reason strings only (stdout and $GITHUB_STEP_SUMMARY):
    no player names, no record text, no post titles -- the repository is public. The
    line quoted in a reply or the list exists only in that Discord message (markdown,
    masked links and mentions escaped; no link previews).

Usage:
    python discord_records_import.py --dry-run            # parse, dedupe, print counts
    python discord_records_import.py                      # ... and append the new rows
    python discord_records_import.py --since 2026-04-01 --limit 5
    python discord_records_import.py --reply              # ... and reply to unreadable recent posts,
                                                          #     keeping the 待修正 tag up to date
    python discord_records_import.py --reply --no-tag     # ... replies only
    python discord_records_import.py --fix-list           # ... and post this week's list in 牌譜修正
    python discord_records_import.py --dry-run --report skipped.json   # local only

Configuration (environment):
    DISCORD_BOT_TOKEN              the bot's token (View Channel + Read Message History on
                                   the forum, Message Content intent; --reply also needs
                                   Send Messages in Threads, and Manage Threads for the 待修正
                                   tag (Manage Channels once, to create the tag; or add it by
                                   hand); --fix-list needs View Channel, Send Messages and
                                   Read Message History in 牌譜修正)
    AVALON_STATS_CREDENTIALS_FILE, AVALON_STATS_CREDENTIALS_JSON, AVALON_STATS_SHEET_ID
                                   as for generate_cache.py; writing needs Editor access
    DISCORD_RECORDS_FORUM_ID       forum channel id (default FORUM_CHANNEL_ID)
    DISCORD_FIX_CHANNEL_ID         --fix-list: the channel to post in (default: the guild's
                                   text channel named 牌譜修正)

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
# Quoted record text in the bot's messages: markdown, masked links ([..](..)) and <...> forms
# (mentions, <url>, timestamps) render as plain text. '>' alone is harmless (湖 lines: 0>8 o).
_MARKDOWN_ESCAPE_RE = re.compile(r"([\\`*_~|\[\]<])")
SUPPRESS_EMBEDS = 1 << 2  # message flag: no link previews (a quoted line may hold a URL)

# The weekly list of posts to fix (--fix-list), in the guild text channel 牌譜修正 (or the channel
# DISCORD_FIX_CHANNEL_ID names). First line: the marker and the ISO week (Taipei); that line, by
# the bot, in the channel's last FIX_LIST_HISTORY messages means this week's list is out already.
ENV_FIX_CHANNEL = "DISCORD_FIX_CHANNEL_ID"
FIX_CHANNEL_NAME = "牌譜修正"
FIX_LIST_MARKER = "🤖 牌譜修正清單"
FIX_LIST_DEFAULT_DAYS = 30
FIX_LIST_DEFAULT_MAX = 50
FIX_LIST_LINE_MAX = 20  # quoted line text is cut here (the thread's reply quotes more)
FIX_LIST_HISTORY = 100  # one page of messages (the workflow re-checks Monday to Wednesday)
FIX_LIST_FOOTER = (
    "修正方式：直接編輯貼文的第一則訊息（牌譜本文），不用重發；下次排程（每天凌晨）會自動重新讀取並收錄。"
    f"討論串裡的「{REPLY_MARKER}」回覆有詳細說明和格式提示。"
    f"如果那局已經另外收進牌譜，幫貼文加上「{TAG_RECORDED}」標籤，就不會再列出。"
)
DISCORD_MESSAGE_MAX = 2000  # Discord's limit; counted in UTF-16 units here (the stricter reading)
GUILD_TEXT_TYPES = frozenset({0, 5})  # text, announcement: what a channel found by name may be
MESSAGE_CHANNEL_TYPES = frozenset({0, 5, 10, 11, 12})  # ... or a thread, by DISCORD_FIX_CHANNEL_ID
# FixListReport.status: what happened to this week's list (fixed strings, counts-only summary).
FIX_POSTED = "posted"
FIX_DRY_RUN = "dry_run"
FIX_ALREADY = "already_posted"
FIX_NO_CHANNEL = "no_channel"
FIX_NOT_TEXT = "not_text"
FIX_BAD_VARIABLE = "bad_variable"
FIX_FORBIDDEN = "forbidden"
FIX_ERROR = "error"
FIX_STATUS_TEXT = {
    FIX_POSTED: "已發出",
    FIX_DRY_RUN: "dry run：只計數，未發出",
    FIX_ALREADY: "本週已發過，略過",
    FIX_NO_CHANNEL: f"找不到「{FIX_CHANNEL_NAME}」文字頻道，未發出",
    FIX_NOT_TEXT: f"「{FIX_CHANNEL_NAME}」不是可以發訊息的文字頻道，未發出",
    FIX_BAD_VARIABLE: f"{ENV_FIX_CHANNEL} 不是頻道 id，未發出",
    FIX_FORBIDDEN: "bot 在該頻道沒有權限（403），未發出",
    FIX_ERROR: "Discord 錯誤，未發出或只發出一部分",
}
FIX_CHANNEL_SKIPS = frozenset({FIX_NO_CHANNEL, FIX_NOT_TEXT, FIX_BAD_VARIABLE})

# The forum tag on posts that need fixing (with --reply; Edward 2026-10-13): whoever fixes records
# filters the forum by it. Kept by the bot: added to `fixable` posts, removed once a post parses.
TAG_FIX = "待修正"
TAG_DEFAULT_DAYS = 90
TAG_DEFAULT_LIMIT = 30
MAX_APPLIED_TAGS = 5  # Discord: at most 5 tags on a forum post
MAX_FORUM_TAGS = 20  # Discord: at most 20 tags in a forum
# FixTagReport.status: what became of the tag itself (fixed strings, counts-only summary).
TAG_FOUND = "found"
TAG_CREATED = "created"
TAG_WOULD_CREATE = "would_create"
TAG_CREATE_FORBIDDEN = "create_forbidden"
TAG_FORUM_FULL = "forum_full"
TAG_ERROR = "error"
TAG_STATUS_TEXT = {
    TAG_FOUND: f"論壇已有「{TAG_FIX}」標籤",
    TAG_CREATED: f"論壇沒有「{TAG_FIX}」標籤，本次已建立",
    TAG_WOULD_CREATE: f"論壇沒有「{TAG_FIX}」標籤（dry run 不建立；寫入時會建立）",
    TAG_CREATE_FORBIDDEN: f"論壇沒有「{TAG_FIX}」標籤，bot 沒有權限建立（403），本次未加標籤",
    TAG_FORUM_FULL: f"論壇沒有「{TAG_FIX}」標籤，且標籤已滿 {MAX_FORUM_TAGS} 個無法建立，本次未加標籤",
    TAG_ERROR: f"讀取或建立「{TAG_FIX}」標籤時 Discord 錯誤，本次未更動標籤",
}
TAG_SKIPS = frozenset({TAG_CREATE_FORBIDDEN, TAG_FORUM_FULL, TAG_ERROR})


# ---------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Post:
    id: str  # thread id = starter message id (snowflake)
    title: str
    tags: tuple[str, ...] = ()
    # As listed (forum_posts), for the 待修正 tag: the applied tag ids, and the thread's state.
    tag_ids: tuple[str, ...] = field(default=(), compare=False)
    archived: bool = field(default=False, compare=False)
    locked: bool = field(default=False, compare=False)

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
    # Posts that need no fixing: in Discord匯入 already, or parsed now (whatever the dedupe said).
    ok_ids: set[str] = field(default_factory=set)
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
            report.ok_ids.add(post.id)
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
        report.ok_ids.add(post.id)
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


def fixable(skip: SkippedPost) -> bool:
    """A skip the poster can fix (who gets a --reply, what --fix-list lists): a format reason, and
    the post is not tagged 已收錄."""
    return skip.reason not in REPLY_NOT_FOR and TAG_RECORDED not in skip.post.tags


def reply_candidates(report: ImportReport, now: dt.datetime, since_days: int) -> list[SkippedPost]:
    """Skips the poster can fix (fixable) posted within `since_days`. Oldest first, like the import."""
    cutoff = now - dt.timedelta(days=since_days)
    chosen = [s for s in report.skips if fixable(s) and s.post.created >= cutoff]
    return sorted(chosen, key=lambda s: int(s.post.id))


def quote_line(text: str | None, max_len: int) -> str:
    """A post's line for a Discord message: one line, cut at max_len, markdown escaped."""
    quoted = " ".join((text or "").split())
    if len(quoted) > max_len:
        quoted = quoted[:max_len - 1] + "…"
    return _MARKDOWN_ESCAPE_RE.sub(r"\\\1", quoted)  # never inside an f-string: Python 3.11 (CI) forbids \ there


def reply_text(skip: SkippedPost) -> str:
    """The reply for one post: marker, why (with the line when known), the format hint. This text
    goes to the post's thread only; it carries record text and must never be printed."""
    why = SKIP_EXPLANATIONS.get(skip.reason, skip.reason)
    if skip.line_no:
        escaped = quote_line(skip.line_text, REPLY_LINE_MAX)
        where = f"第 {skip.line_no} 行「{escaped}」：{why}"
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


# ---------------------------------------------------------------------------
# The 待修正 tag on the posts that need fixing (with --reply, unless --no-tag)
# ---------------------------------------------------------------------------

@dataclass
class FixTagReport:
    """Counts only: nothing here identifies a post."""
    dry_run: bool = False
    days: int = TAG_DEFAULT_DAYS
    status: str = ""  # one of TAG_STATUS_TEXT
    candidates: int = 0  # fixable posts created within `days`
    already_tagged: int = 0  # ... of them carrying the tag already
    to_add: int = 0  # ... of them lacking it
    to_remove: int = 0  # posts carrying it that need no fixing (any age)
    added: int = 0  # dry run: would be added
    removed: int = 0  # dry run: would be removed
    unarchived: int = 0  # changes that reopened an archived post (archived:false)
    skipped_full: int = 0  # the post has MAX_APPLIED_TAGS tags already
    skipped_locked: int = 0  # locked post (without --tag-locked)
    held_by_limit: int = 0
    gone: int = 0  # HTTP 404: the post was deleted
    forbidden: int = 0  # HTTP 403: no Manage Threads; no further change this run
    left_after_forbidden: int = 0
    errors: int = 0  # other Discord errors or odd responses (per post; the run goes on)
    unchanged: int = 0  # already as wanted when re-read (someone changed it meanwhile)
    untouched: int = 0  # carrying the tag, but this run cannot judge the post: left as it is


@dataclass(frozen=True)
class FixTagPlan:
    add: list[Post]  # newest first
    remove: list[Post]  # newest first
    candidates: int
    already_tagged: int
    untouched: int


# What one tag change comes to (tag_change, change_fix_tag).
TAG_CHANGE = "change"
TAG_UNCHANGED = "unchanged"
TAG_FULL = "full"
TAG_LOCKED = "locked"
TAG_GONE = "gone"


def plan_fix_tags(posts: Iterable[Post], report: ImportReport, now: dt.datetime, days: int) -> FixTagPlan:
    """Which posts get the 待修正 tag and which lose it. Add: `fixable` posts (the --reply rule:
    a format reason, not tagged 已收錄 / 模擬, meant as a record) created within `days` that lack
    it. Remove: posts of any age that carry it and are tagged 已收錄 / 模擬, or need no fixing now
    (report.ok_ids: imported now or earlier, already in 牌譜, a duplicate). A post carrying it that
    this run cannot judge (starter deleted or empty, no longer a record, not read) keeps it, as does
    an older fixable post."""
    fix_ids = {s.post.id for s in report.skips if fixable(s)}
    cutoff = now - dt.timedelta(days=days)
    add: list[Post] = []
    remove: list[Post] = []
    candidates = already = untouched = 0
    for post in sorted(posts, key=lambda p: int(p.id), reverse=True):
        carries = TAG_FIX in post.tags
        if TAG_RECORDED in post.tags or TAG_SIMULATION in post.tags:
            if carries:
                remove.append(post)
        elif post.id in fix_ids:
            if post.created >= cutoff:
                candidates += 1
                if carries:
                    already += 1
                else:
                    add.append(post)
        elif post.id in report.ok_ids:
            if carries:
                remove.append(post)
        elif carries:
            untouched += 1
    return FixTagPlan(add, remove, candidates, already, untouched)


def tag_id_named(available: Any, name: str) -> str | None:
    """The id of the forum tag called exactly `name`, None if there is none."""
    for tag in available or []:
        if isinstance(tag, dict) and tag.get("name") == name and tag.get("id"):
            return str(tag["id"])
    return None


def tag_change(applied: Iterable[Any], tag_id: str | None, add: bool, *, locked: bool,
               allow_locked: bool) -> tuple[str, list[str]]:
    """(TAG_CHANGE / TAG_UNCHANGED / TAG_LOCKED / TAG_FULL, the post's new applied_tags): its
    current tags, in their order, plus or minus `tag_id` only. `tag_id` None: the tag does not
    exist yet (a dry run before it is created)."""
    current = [str(t) for t in applied]
    present = tag_id is not None and tag_id in current
    if present == add:
        return TAG_UNCHANGED, current
    if locked and not allow_locked:
        return TAG_LOCKED, current
    if not add:
        return TAG_CHANGE, [t for t in current if t != tag_id]
    if len(current) >= MAX_APPLIED_TAGS:
        return TAG_FULL, current
    return TAG_CHANGE, current + [tag_id or ""]


def change_fix_tag(client: Any, post: Post, tag_id: str, add: bool, allow_locked: bool) -> tuple[str, bool]:
    """Re-read the post (its tags may have changed since the listing), then set its applied_tags to
    tag_change's. (outcome, an archived post was reopened). Discord errors propagate."""
    thread = client.thread(post.id)
    if thread is None:
        return TAG_GONE, False
    applied = thread.get("applied_tags") or []
    meta = thread.get("thread_metadata") or {}
    if not isinstance(applied, list) or not isinstance(meta, dict):
        raise DiscordError("GET /channels/{thread}: unexpected response")
    outcome, new_tags = tag_change(applied, tag_id, add, locked=bool(meta.get("locked")), allow_locked=allow_locked)
    if outcome != TAG_CHANGE:
        return outcome, False
    archived = bool(meta.get("archived"))
    if not client.set_thread_tags(post.id, new_tags, unarchive=archived):
        return TAG_GONE, False
    return TAG_CHANGE, archived


def tag_fix_posts(client: Any, posts: Sequence[Post], report: ImportReport, *, forum_id: str, now: dt.datetime,
                  dry_run: bool, days: int = TAG_DEFAULT_DAYS, limit: int = TAG_DEFAULT_LIMIT,
                  allow_locked: bool = False) -> FixTagReport:
    """Keep the 待修正 tag on the posts that need fixing (plan_fix_tags): find the tag, create it if
    missing (not in a dry run), then make at most `limit` changes, removals first. A dry run counts
    from the listing and changes nothing. Never raises: the tag that cannot be created, 403 (which
    stops the tag changes for this run), 404 and other Discord errors end up in the counts."""
    plan = plan_fix_tags(posts, report, now, days)
    tags = FixTagReport(dry_run=dry_run, days=days, candidates=plan.candidates, already_tagged=plan.already_tagged,
                        to_add=len(plan.add), to_remove=len(plan.remove), untouched=plan.untouched)
    tag_id: str | None = None
    try:
        tag_id = tag_id_named(client.forum_tags(forum_id), TAG_FIX)
        if tag_id:
            tags.status = TAG_FOUND
        elif dry_run:
            tags.status = TAG_WOULD_CREATE
        else:
            tag_id = client.create_forum_tag(forum_id, TAG_FIX)
            tags.status = TAG_CREATED
    except ForumTagsFull:
        tags.status = TAG_FORUM_FULL
    except DiscordForbidden:
        tags.status = TAG_CREATE_FORBIDDEN
    except Exception:  # a Discord error or an odd response: counted, never printed
        tags.status = TAG_ERROR
    if tags.status in TAG_SKIPS:
        return tags
    changes = 0
    stopped = False
    for post, add in [(p, False) for p in plan.remove] + [(p, True) for p in plan.add]:
        if stopped:
            tags.left_after_forbidden += 1
            continue
        if changes >= limit:
            tags.held_by_limit += 1
            continue
        if dry_run:
            outcome, _ = tag_change(post.tag_ids, tag_id, add, locked=post.locked, allow_locked=allow_locked)
            reopened = post.archived
        else:
            try:
                outcome, reopened = change_fix_tag(client, post, str(tag_id), add, allow_locked)
            except DiscordForbidden:
                tags.forbidden += 1
                stopped = True
                continue
            except Exception:  # never printed, counted only; the next run tries again
                tags.errors += 1
                changes += 1
                continue
        if outcome == TAG_CHANGE:
            changes += 1
            if add:
                tags.added += 1
            else:
                tags.removed += 1
            tags.unarchived += bool(reopened)
        elif outcome == TAG_FULL:
            tags.skipped_full += 1
        elif outcome == TAG_LOCKED:
            tags.skipped_locked += 1
        elif outcome == TAG_GONE:
            tags.gone += 1
        else:
            tags.unchanged += 1
    return tags


def fix_tag_lines(tags: FixTagReport) -> list[str]:
    """Markdown summary of the 待修正 tag: counts only."""
    mode = "dry run：只計數，未更改" if tags.dry_run else "已更新"
    lines = [
        f"- 「{TAG_FIX}」標籤（--reply，{mode}）：{TAG_STATUS_TEXT.get(tags.status, tags.status)}",
        f"  - {tags.days} 天內因格式無法解析且未標「{TAG_RECORDED}」的貼文 {tags.candidates} 篇"
        f"（已有標籤 {tags.already_tagged}，待加 {tags.to_add}）；已不需修正但還有標籤（可解析、已收錄或模擬）：{tags.to_remove} 篇",
    ]
    if tags.status in TAG_SKIPS:
        return lines
    verb = "可" if tags.dry_run else "已"
    extra = [
        (tags.skipped_locked, "貼文已鎖定略過"),
        (tags.gone, "貼文已刪除"),
        (tags.unchanged, "重新讀取時已是正確狀態"),
        (tags.untouched, "帶標籤但本次無法判斷、未更動"),
    ]
    lines.append(
        f"  - 本次{verb}加上：{tags.added}；{verb}移除：{tags.removed}"
        + (f"（其中重新開啟已封存的貼文：{tags.unarchived}）" if tags.unarchived else "")
        + f"；標籤已滿 {MAX_APPLIED_TAGS} 個略過：{tags.skipped_full}"
        + f"；超過 --tag-limit 保留到下次：{tags.held_by_limit}"
        + f"；沒有權限（403）：{tags.forbidden}"
        + (f"（之後停止，留到下次：{tags.left_after_forbidden}）" if tags.left_after_forbidden else "")
        + f"；其他 Discord 錯誤：{tags.errors}"
        + "".join(f"；{label}：{n}" for n, label in extra if n)
    )
    return lines


# ---------------------------------------------------------------------------
# The weekly list of posts to fix (--fix-list)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class FixEntry:
    skip: SkippedPost
    date: str  # 日期時間 as title_date reads it (YYYY/MM/DD)
    game_no: str  # 場次 from the title, or ""
    date_from_title: bool


@dataclass
class FixListReport:
    """Counts only: nothing here identifies a post."""
    dry_run: bool = False
    days: int = FIX_LIST_DEFAULT_DAYS
    status: str = ""  # one of FIX_STATUS_TEXT
    channel_found: bool = False
    entries: int = 0  # fixable posts created within `days`
    listed: int = 0  # ... of them in the list (at most --fix-list-max)
    held_by_cap: int = 0
    backlog: int = 0  # fixable posts of any age
    messages: int = 0  # messages the list takes
    posted: int = 0  # ... of them posted


def short_explanation(reason: str) -> str:
    """SKIP_EXPLANATIONS up to its first '：' or '（': the reason without the hint."""
    text = SKIP_EXPLANATIONS.get(reason, reason)
    return re.split(r"[：（]", text, maxsplit=1)[0].strip() or text


def fix_list_entries(report: ImportReport, now: dt.datetime, days: int) -> tuple[list[FixEntry], int]:
    """(fixable posts created within `days`, by record date then 場次; the number of fixable posts
    of any age)."""
    eligible = [s for s in report.skips if fixable(s)]
    cutoff = now - dt.timedelta(days=days)
    entries = []
    for skip in eligible:
        if skip.post.created >= cutoff:
            date, game_no, from_title = title_date(skip.post.title, skip.post.created)
            # title_date takes the title's last number: a 配置 or a count after the 場次
            # ('1009一般場4 936758') is no game number; nobody plays 100 games a day.
            entries.append(FixEntry(skip, date, game_no if len(game_no) <= 2 else "", from_title))
    entries.sort(key=lambda e: (e.date, 0 if e.game_no else 1, int(e.game_no or 0), int(e.skip.post.id)))
    return entries, len(eligible)


def fix_list_week(now: dt.datetime) -> tuple[str, dt.date]:
    """(ISO week key like 2026-W42, that week's Monday), Taipei time."""
    local = now.astimezone(TAIPEI)
    year, week, _ = local.isocalendar()
    return f"{year}-W{week:02d}", local.date() - dt.timedelta(days=local.weekday())


def fix_list_prefix(now: dt.datetime) -> str:
    """How this week's list starts (and how the bot finds it in the channel)."""
    return f"{FIX_LIST_MARKER} {fix_list_week(now)[0]}"


def fix_entry_line(n: int, entry: FixEntry, guild_id: str) -> str:
    """'3. 2026/10/09 第 4 場：投票異常標記看不懂（第 3 行「389 7」） <link>'. Discord shows the link
    as the post's title."""
    when = entry.date if entry.date_from_title else f"{entry.date}（依發文時間）"
    if entry.game_no:
        when += f" 第 {entry.game_no} 場"
    why = short_explanation(entry.skip.reason)
    if entry.skip.line_no:
        quoted = quote_line(entry.skip.line_text, FIX_LIST_LINE_MAX)
        why += f"（第 {entry.skip.line_no} 行" + (f"「{quoted}」" if quoted else "") + "）"
    return f"{n}. {when}：{why} https://discord.com/channels/{guild_id}/{entry.skip.post.id}"


def discord_length(text: str) -> int:
    """Length as Discord's 2000 limit may count it (UTF-16 units: an emoji counts 2)."""
    return len(text.encode("utf-16-le")) // 2


def chunk_lines(lines: Sequence[str], limit: int = DISCORD_MESSAGE_MAX) -> list[str]:
    """Join lines into as few messages of at most `limit` as possible, splitting only between
    lines (a single longer line is cut)."""
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for line in lines:
        if discord_length(line) > limit:
            line = line[:limit - 1]
            while discord_length(line) > limit - 1:
                line = line[:-1]
            line += "…"
        extra = discord_length(line) + (1 if current else 0)
        if current and size + extra > limit:
            chunks.append("\n".join(current))
            current, size, extra = [], 0, discord_length(line)
        current.append(line)
        size += extra
    if current:
        chunks.append("\n".join(current))
    return chunks


def fix_list_messages(entries: Sequence[FixEntry], backlog: int, *, now: dt.datetime, days: int,
                      max_entries: int, guild_id: str) -> list[str]:
    """This week's list as Discord messages (each <= DISCORD_MESSAGE_MAX). It quotes record lines:
    for the 牌譜修正 channel only, never printed."""
    key, monday = fix_list_week(now)
    lines = [f"{FIX_LIST_MARKER} {key}（{monday:%Y/%m/%d} 這週）"]
    shown = entries[:max_entries]
    if entries:
        lines.append(f"最近 {days} 天發文、因為格式問題還沒收進戰績統計的牌譜有 {len(entries)} 篇（依牌譜日期排列）：")
        lines += [fix_entry_line(i, e, guild_id) for i, e in enumerate(shown, 1)]
        if len(entries) > len(shown):
            lines.append(f"另有 {len(entries) - len(shown)} 篇沒列出（一次最多列 {max_entries} 篇）。")
    else:
        lines.append(f"最近 {days} 天發文的牌譜都沒有格式問題，不用修正。")
    older = backlog - len(entries)
    lines.append(f"累計待修正（不限發文時間）：{backlog} 篇"
                 + (f"，其中 {older} 篇發文超過 {days} 天，這裡沒有列出" if older > 0 else "") + "。")
    if backlog:
        lines.append(FIX_LIST_FOOTER)
    return chunk_lines(lines)


def _is_snowflake(value: str) -> bool:
    """ASCII digits only (str.isdigit alone accepts full-width digits and superscripts)."""
    return bool(value) and value.isascii() and value.isdigit()


def resolve_fix_channel(client: Any, guild_id: str, configured: str = "") -> tuple[str | None, str]:
    """(channel id, how): `configured` (DISCORD_FIX_CHANNEL_ID) if set, else the guild's text
    channel named FIX_CHANNEL_NAME (the oldest if several). Not found: (None, FIX_NO_CHANNEL /
    FIX_NOT_TEXT / FIX_BAD_VARIABLE). Discord errors (403 included) propagate."""
    configured = (configured or "").strip()
    if configured:
        if not _is_snowflake(configured):
            return None, FIX_BAD_VARIABLE
        channel = client.channel(configured)
        if not isinstance(channel, dict):
            return None, FIX_NO_CHANNEL
        if channel.get("type") not in MESSAGE_CHANNEL_TYPES:
            return None, FIX_NOT_TEXT
        return configured, "variable"
    named = [c for c in client.guild_channels(guild_id) or []
             if isinstance(c, dict) and unicodedata.normalize("NFKC", str(c.get("name") or "")).strip() == FIX_CHANNEL_NAME]
    usable = sorted((c for c in named if c.get("type") in GUILD_TEXT_TYPES and _is_snowflake(str(c.get("id") or ""))),
                    key=lambda c: int(c["id"]))
    if usable:
        return str(usable[0]["id"]), "name"
    return None, FIX_NOT_TEXT if named else FIX_NO_CHANNEL


def post_fix_list(client: Any, report: ImportReport, *, forum_id: str, now: dt.datetime, dry_run: bool,
                  days: int = FIX_LIST_DEFAULT_DAYS, max_entries: int = FIX_LIST_DEFAULT_MAX,
                  configured_channel: str = "", force: bool = False) -> FixListReport:
    """Post this week's list unless the bot already did this week (or `force`). Never raises: no
    channel, 403 and other Discord errors end up in the returned status."""
    entries, backlog = fix_list_entries(report, now, days)
    fix = FixListReport(dry_run=dry_run, days=days, entries=len(entries), listed=min(len(entries), max_entries),
                        held_by_cap=max(len(entries) - max_entries, 0), backlog=backlog)
    try:
        guild_id = str(client.forum_guild_id(forum_id) or GUILD_ID)
        channel_id, how = resolve_fix_channel(client, guild_id, configured_channel)
        if channel_id is None:
            fix.status = how
            return fix
        fix.channel_found = True
        messages = fix_list_messages(entries, backlog, now=now, days=days, max_entries=max_entries, guild_id=guild_id)
        fix.messages = len(messages)
        if not force and client.has_bot_message(channel_id, client.bot_user_id(), fix_list_prefix(now),
                                                max_messages=FIX_LIST_HISTORY):
            fix.status = FIX_ALREADY
            return fix
        if dry_run:
            fix.status = FIX_DRY_RUN
            return fix
        key = fix_list_week(now)[0]
        # The nonce (with enforce_nonce) keeps a message from being created twice should the same
        # request reach Discord twice; a forced re-post is a new message, so it gets its own nonce.
        stamp = now.astimezone(TAIPEI).strftime("%H%M%S-") if force else ""
        for i, content in enumerate(messages, 1):
            client.post_message(channel_id, content, nonce=f"fl{key}-{stamp}{i}")
            fix.posted += 1
        fix.status = FIX_POSTED
    except DiscordForbidden:
        fix.status = FIX_FORBIDDEN
    except Exception:  # a Discord error or an odd response: counted, never printed
        fix.status = FIX_ERROR
    return fix


def fix_list_lines(fix: FixListReport) -> list[str]:
    """Markdown summary of --fix-list: counts only."""
    found = "有" if fix.channel_found else "沒有"
    return [
        f"- 牌譜修正清單（--fix-list）：{FIX_STATUS_TEXT.get(fix.status, fix.status)}",
        f"  - 找到頻道：{found}；{fix.days} 天內待修正：{fix.entries} 篇，列出：{fix.listed} 篇"
        + (f"，超過 --fix-list-max 沒列：{fix.held_by_cap} 篇" if fix.held_by_cap else "")
        + f"；累計待修正（不限天數）：{fix.backlog} 篇"
        + (f"；清單共 {fix.messages} 則訊息，本次發出 {fix.posted} 則" if fix.messages else ""),
    ]


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
# Discord (reads; --reply posts one message per unreadable post, --fix-list the weekly list)
# ---------------------------------------------------------------------------

class DiscordError(Exception):
    pass


class DiscordForbidden(DiscordError):
    """HTTP 403: the bot lacks a permission (read the thread, post in it, or change tags)."""


class ForumTagsFull(DiscordError):
    """The forum has Discord's maximum of tags (MAX_FORUM_TAGS): no tag can be added."""


MESSAGES_PAGE = 100
MAX_MESSAGE_PAGES = 20  # 2000 messages: more than any record thread has


class DiscordClient:
    """Minimal Discord REST client; honours 429 retry_after and the rate-limit headers.

    GET for the forum, its posts and their messages (and, for --fix-list, the guild's channels
    and the fix-list channel's newest messages); POST only for --reply (one message in a post's
    thread) and --fix-list (the weekly list in one channel); PATCH only for the 待修正 tag (a
    post's applied_tags, and once the forum's available_tags to create the tag). Only a GET is
    re-sent after a server error or a timeout: Discord may have stored the message of a POST
    before the response was lost, and sending it again would post a second reply (the next run
    finds the first one by its marker instead); a PATCH that created the tag could create it
    twice. A 429 is retried for all, Discord did not process it. Errors name the route template
    only (no ids, no content) and never the token.
    """

    def __init__(self, token: str, opener: Callable[..., Any] | None = None,
                 sleep: Callable[[float], None] = time.sleep, pace: float = FETCH_PACE_SECONDS):
        self._token = token
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self._pace = pace
        self._bot_id = ""
        self._forum_guilds: dict[str, str] = {}
        self._forum_tags: dict[str, list[dict]] = {}

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

    def patch(self, path: str, route: str, body: Any, allow_404: bool = False) -> Any:
        return self._request("PATCH", path, route, body=body, allow_404=allow_404)

    def bot_user_id(self) -> str:
        """The bot's own user id (to recognize its earlier replies and lists)."""
        if self._bot_id:
            return self._bot_id
        me = self.get("/users/@me", "/users/@me") or {}
        user_id = str(me.get("id") or "")
        if not user_id:
            raise DiscordError("GET /users/@me: no user id in the response")
        self._bot_id = user_id
        return user_id

    def has_bot_message(self, thread_id: str, bot_id: str, prefix: str, max_messages: int | None = None) -> bool:
        """True if a message by `bot_id` starting with `prefix` is among the channel's (thread's)
        newest `max_messages` (default: up to MAX_MESSAGE_PAGES pages)."""
        before = None
        left = MESSAGES_PAGE * MAX_MESSAGE_PAGES if max_messages is None else max_messages
        while left > 0:
            size = min(MESSAGES_PAGE, left)
            query = f"?limit={size}" + (f"&before={before}" if before else "")
            page = self.get(f"/channels/{thread_id}/messages{query}", "/channels/{thread}/messages") or []
            for message in page:
                author = message.get("author") or {}
                if str(author.get("id") or "") == bot_id and (message.get("content") or "").startswith(prefix):
                    return True
            left -= size
            if len(page) < size or not page[-1].get("id"):
                break
            before = page[-1]["id"]
        return False

    def post_message(self, thread_id: str, content: str, nonce: str | None = None) -> None:
        """One message in a post's thread (or a channel), mentioning nobody and without link
        previews. The nonce (default the thread id: one reply per thread) with enforce_nonce makes
        Discord return the bot's existing message instead of creating another should the same
        request reach it twice within a few minutes."""
        self.post(f"/channels/{thread_id}/messages", "/channels/{thread}/messages",
                  {"content": content, "allowed_mentions": {"parse": []}, "flags": SUPPRESS_EMBEDS,
                   "nonce": nonce or thread_id, "enforce_nonce": True})

    def channel(self, channel_id: str) -> dict | None:
        """A channel object, None if there is no such channel."""
        return self.get(f"/channels/{channel_id}", "/channels/{channel}", allow_404=True)

    def guild_channels(self, guild_id: str) -> list[dict]:
        """The guild's channels (not threads)."""
        return self.get(f"/guilds/{guild_id}/channels", "/guilds/{guild}/channels") or []

    def forum_guild_id(self, forum_id: str) -> str:
        """The forum's guild (read along with forum_posts, else fetched)."""
        if forum_id not in self._forum_guilds:
            channel = self.get(f"/channels/{forum_id}", "/channels/{forum}") or {}
            self._forum_guilds[forum_id] = str(channel.get("guild_id") or GUILD_ID)
        return self._forum_guilds[forum_id]

    def forum_posts(self, forum_id: str) -> tuple[list[Post], list[str]]:
        """All posts (active + archived public threads) of a forum, and expected tags it lacks."""
        channel = self.get(f"/channels/{forum_id}", "/channels/{forum}")
        tags = {t.get("id"): t.get("name", "") for t in channel.get("available_tags") or []}
        guild = channel.get("guild_id") or GUILD_ID
        self._forum_guilds[forum_id] = str(guild)
        self._forum_tags[forum_id] = [t for t in channel.get("available_tags") or [] if isinstance(t, dict)]
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
                 tags=tuple(tags[x] for x in t.get("applied_tags") or [] if x in tags),
                 tag_ids=tuple(str(x) for x in t.get("applied_tags") or []),
                 archived=bool((t.get("thread_metadata") or {}).get("archived")),
                 locked=bool((t.get("thread_metadata") or {}).get("locked")))
            for t in unique.values()
        ]
        posts.sort(key=lambda p: int(p.id))
        names = set(tags.values())
        return posts, [t for t in EXPECTED_TAGS if t not in names]

    def forum_tags(self, forum_id: str) -> list[dict]:
        """The forum's available tags (read along with forum_posts, else fetched)."""
        if forum_id not in self._forum_tags:
            channel = self.get(f"/channels/{forum_id}", "/channels/{forum}") or {}
            self._forum_tags[forum_id] = [t for t in channel.get("available_tags") or [] if isinstance(t, dict)]
        return list(self._forum_tags[forum_id])

    def create_forum_tag(self, forum_id: str, name: str) -> str:
        """Add the tag `name` to the forum (Manage Channels) and return its id. The forum is read
        again first and its tags are sent back exactly as Discord returned them, so no tag changes
        and none added meanwhile is lost; a tag of that name found then is used as it is. Raises
        ForumTagsFull at Discord's maximum, DiscordForbidden without the permission."""
        channel = self.get(f"/channels/{forum_id}", "/channels/{forum}") or {}
        existing = [dict(t) for t in channel.get("available_tags") or [] if isinstance(t, dict)]
        found = tag_id_named(existing, name)
        if found:
            self._forum_tags[forum_id] = existing
            return found
        if len(existing) >= MAX_FORUM_TAGS:
            raise ForumTagsFull("PATCH /channels/{forum}: the forum has the maximum number of tags")
        updated = self.patch(f"/channels/{forum_id}", "/channels/{forum}",
                             {"available_tags": existing + [{"name": name}]}) or {}
        tags = [t for t in updated.get("available_tags") or [] if isinstance(t, dict)]
        tag_id = tag_id_named(tags, name)
        if not tag_id:
            raise DiscordError("PATCH /channels/{forum}: the new tag is not in the response")
        self._forum_tags[forum_id] = tags
        return tag_id

    def thread(self, thread_id: str) -> dict | None:
        """A post's thread as it is now (applied_tags, thread_metadata), None if it was deleted."""
        return self.get(f"/channels/{thread_id}", "/channels/{thread}", allow_404=True)

    def set_thread_tags(self, thread_id: str, tag_ids: Sequence[str], unarchive: bool = False) -> bool:
        """Set a post's applied_tags (Manage Threads). unarchive: archived=false in the same request
        (Discord changes no archived thread otherwise). False if the post was deleted (404)."""
        body: dict[str, Any] = {"applied_tags": list(tag_ids)}
        if unarchive:
            body["archived"] = False
        return self.patch(f"/channels/{thread_id}", "/channels/{thread}", body, allow_404=True) is not None

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
    if status == 403 and method == "PATCH" and route == "/channels/{forum}":
        return (f"{detail}. The bot cannot add a tag to the forum: give it Manage Channels on "
                f"#牌譜紀錄與覆盤, or add the tag {TAG_FIX} in the forum's settings.")
    if status == 403 and method == "PATCH":
        return (f"{detail}. The bot cannot change the post's tags: give it Manage Threads (管理討論串) "
                "on #牌譜紀錄與覆盤.")
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
    # The tags that decide which posts get a reply also decide which posts the fix list names and
    # which carry the 待修正 tag.
    reply_gate = [t for t in REPLY_GATE_TAGS if t in missing_tags] if (args.reply or args.fix_list) else []
    tag_on = args.reply and not args.no_tag
    lines = report_lines(report, write=write, written=written, tab_exists=tab_exists, missing_tags=missing_tags)
    gate_tags = "」「".join(reply_gate)
    if reply_gate and args.reply:
        lines.append(f"- 格式回覆（--reply）：論壇沒有「{gate_tags}」標籤，無法判斷哪些貼文該回覆，本次未回覆、未計數")
    if reply_gate and tag_on:
        lines.append(f"- 「{TAG_FIX}」標籤：論壇沒有「{gate_tags}」標籤，無法判斷哪些貼文要修正，本次未更動、未計數")
    if reply_gate and args.fix_list:
        lines.append(f"- 牌譜修正清單（--fix-list）：論壇沒有「{gate_tags}」標籤，無法判斷哪些貼文要修正，本次未發出、未計數")
    print("\n".join(lines))
    gc._append_step_summary(lines)
    if missing_tags and in_actions:
        print(f"::warning title=Forum tags missing::{len(missing_tags)} expected forum tag(s) not found; see the job summary.")
    if reply_gate and args.reply:
        _warn("Discord reply skipped", f"{len(reply_gate)} forum tag(s) that decide which posts get a reply not found "
              "(renamed?); no reply was posted or counted" + (f", no {TAG_FIX} tag changed" if tag_on else "")
              + ". See the job summary.", in_actions)
    if reply_gate and args.fix_list:
        _warn("Fix list skipped", f"{len(reply_gate)} forum tag(s) that decide which posts need fixing not found "
              "(renamed?); the weekly fix list was not posted. See the job summary.", in_actions)

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
    if tag_on and not reply_gate:
        tag_fix_phase(client, posts, report, args, forum_id=forum_id, now=now_taipei, dry_run=not write,
                      in_actions=in_actions)
    if args.fix_list and not reply_gate:
        fix = post_fix_list(client, report, forum_id=forum_id, now=now_taipei, dry_run=not write,
                            days=args.fix_list_days, max_entries=args.fix_list_max,
                            configured_channel=env.get(ENV_FIX_CHANNEL) or "", force=args.fix_list_force)
        lines = fix_list_lines(fix)
        print("\n".join(lines))
        gc._append_step_summary(lines)
        if fix.status in FIX_CHANNEL_SKIPS and (env.get(ENV_FIX_CHANNEL) or "").strip():
            _notice("Fix list skipped", f"The repository variable {ENV_FIX_CHANNEL} does not name a text channel "
                    f"the bot can see ({fix.status}): fix it (the channel id, digits only) or delete it to use the "
                    f"channel named {FIX_CHANNEL_NAME}. {fix.entries} post(s) would have been listed.", in_actions)
        elif fix.status in FIX_CHANNEL_SKIPS:
            _notice("Fix list skipped", f"No usable channel for the weekly fix list ({fix.status}): create a text "
                    f"channel named {FIX_CHANNEL_NAME} or set the repository variable {ENV_FIX_CHANNEL}. "
                    f"{fix.entries} post(s) would have been listed.", in_actions)
        elif fix.status == FIX_FORBIDDEN:
            _notice("Fix list skipped", f"The bot may not read or post in the fix-list channel (HTTP 403): give it "
                    "View Channel, Send Messages and Read Message History there.", in_actions)
        elif fix.status == FIX_ERROR:
            _warn("Fix list error", f"Discord API error or unexpected response; {fix.posted} of {fix.messages} "
                  "message(s) of the weekly fix list posted. See the job summary.", in_actions)
    if args.report:
        Path(args.report).write_text(json.dumps(report.details, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Per-post report written to {args.report} (contains titles: keep it local).")
    return 0


def tag_fix_phase(client: Any, posts: Sequence[Post], report: ImportReport, args: argparse.Namespace, *,
                  forum_id: str, now: dt.datetime, dry_run: bool, in_actions: bool) -> FixTagReport:
    """tag_fix_posts, then its summary and annotations (counts and fixed strings only)."""
    tags = tag_fix_posts(client, posts, report, forum_id=forum_id, now=now, dry_run=dry_run,
                         days=args.tag_since_days, limit=args.tag_limit, allow_locked=args.tag_locked)
    lines = fix_tag_lines(tags)
    print("\n".join(lines))
    gc._append_step_summary(lines)
    if tags.status in (TAG_CREATE_FORBIDDEN, TAG_FORUM_FULL):
        why = ("the bot may not create it (HTTP 403; creating a forum tag needs Manage Channels)"
               if tags.status == TAG_CREATE_FORBIDDEN else
               f"it already has {MAX_FORUM_TAGS} tags, Discord's maximum (remove one first)")
        _notice("To-fix tag missing", f"The forum #牌譜紀錄與覆盤 has no tag named {TAG_FIX} and {why}. The owner "
                f"should add a tag named exactly {TAG_FIX} in the forum's settings (Edit Channel > Tags); posts are "
                f"tagged from the next run on. {tags.to_add} post(s) would have been tagged.", in_actions)
    elif tags.status == TAG_ERROR:
        _warn("To-fix tag error", f"Reading or creating the forum tag {TAG_FIX} hit a Discord API error or an "
              "unexpected response; no post tag was changed. Retried on the next run.", in_actions)
    if tags.forbidden:
        _notice("To-fix tag forbidden", "The bot may not change post tags (HTTP 403): give it 管理討論串 (Manage "
                "Threads) on #牌譜紀錄與覆盤. Tag changes stopped for this run; "
                f"{tags.forbidden + tags.left_after_forbidden} change(s) left for the next run.", in_actions)
    if tags.errors:
        _warn("To-fix tag errors", f"{tags.errors} tag change(s) hit a Discord API error or an unexpected response; "
              "they are retried on the next run.", in_actions)
    return tags


def _warn(title: str, message: str, in_actions: bool) -> None:
    """A fixed warning (counts allowed, never content); an annotation inside GitHub Actions."""
    print(f"::warning title={title}::{message}" if in_actions else f"[WARNING] {title}: {message}", flush=True)


def _notice(title: str, message: str, in_actions: bool) -> None:
    """A fixed notice (counts allowed, never content); an annotation inside GitHub Actions."""
    print(f"::notice title={title}::{message}" if in_actions else f"[NOTICE] {title}: {message}", flush=True)


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


def _at_least_one(value: str) -> int:
    n = _positive(value)
    if n < 1:
        raise argparse.ArgumentTypeError(f"not a positive integer: {value!r}")
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
                             "format (why, which line, the format hint); once per post; and keep the forum tag "
                             f"{TAG_FIX} on the posts that need fixing (see --no-tag). With --dry-run: count only")
    parser.add_argument("--reply-since-days", type=_positive, default=REPLY_DEFAULT_DAYS, metavar="N",
                        help=f"--reply only to posts created in the last N days (default {REPLY_DEFAULT_DAYS})")
    parser.add_argument("--reply-limit", type=_positive, default=REPLY_DEFAULT_LIMIT, metavar="N",
                        help=f"at most N replies per run, oldest post first (default {REPLY_DEFAULT_LIMIT})")
    parser.add_argument("--no-tag", action="store_true",
                        help=f"with --reply: leave the forum tag {TAG_FIX} alone (by default --reply adds it to the "
                             "posts that need fixing and removes it once they parse)")
    parser.add_argument("--tag-since-days", type=_positive, default=TAG_DEFAULT_DAYS, metavar="N",
                        help=f"add {TAG_FIX} only to posts created in the last N days (default {TAG_DEFAULT_DAYS}); "
                             "it is removed from posts of any age")
    parser.add_argument("--tag-limit", type=_positive, default=TAG_DEFAULT_LIMIT, metavar="N",
                        help=f"at most N {TAG_FIX} tag changes per run, removals first, then additions newest post "
                             f"first (default {TAG_DEFAULT_LIMIT})")
    parser.add_argument("--tag-locked", action="store_true",
                        help=f"also change {TAG_FIX} on locked posts (skipped by default)")
    parser.add_argument("--fix-list", action="store_true",
                        help=f"post this week's list of posts to fix in the {FIX_CHANNEL_NAME} channel (or "
                             f"{ENV_FIX_CHANNEL}); once per ISO week. With --dry-run: count only")
    parser.add_argument("--fix-list-days", type=_at_least_one, default=FIX_LIST_DEFAULT_DAYS, metavar="N",
                        help=f"--fix-list names posts created in the last N days (default {FIX_LIST_DEFAULT_DAYS})")
    parser.add_argument("--fix-list-max", type=_at_least_one, default=FIX_LIST_DEFAULT_MAX, metavar="N",
                        help=f"--fix-list names at most N posts, then how many more (default {FIX_LIST_DEFAULT_MAX})")
    parser.add_argument("--fix-list-force", action="store_true",
                        help="--fix-list even if this week's list is already in the channel")
    args = parser.parse_args(argv)
    if args.fix_list and args.since is not None:
        # --since leaves older posts unread: the list's backlog (all ages) would come out too small.
        parser.error("--fix-list cannot be combined with --since (the backlog counts posts of any age)")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except gc.FatalError as exc:
        gc.emit_error(str(exc), exc.title)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
