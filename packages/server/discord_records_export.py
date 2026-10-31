"""
Export the Discord forum #牌譜紀錄與覆盤 (one post = one game) as the list the website's
「牌譜紀錄」tab shows: packages/server/records_cache.json, served by GET /api/analysis/records.

Read-only: it lists the forum's posts and reads each post's starter message (the record) with the
same bot token, client and parser as discord_records_import.py. It never reads the replies in a
post's thread: they are chat, and this file is committed to a public repository, where a reply
deleted or edited on Discord would stay in the git history. The site's server reads the replies
live when someone opens a game (GET /api/analysis/records/:id/replies, services/recordsReplies.ts,
memory cache only). It never writes to Discord or the stats Sheet, and runs in
refresh-analysis-cache.yml next to generate_cache.py, so the file is committed together with the
analysis cache.

What goes into the file, newest post first:
  * every post except those tagged 模擬 and those that are not game records at all (no record,
    no result tag, no 6-digit 配置: notices, questions);
  * per post: the thread id, the title (control characters dropped, at most TITLE_MAX
    characters), the forum tags, the creation time (Taipei), the record date (from the title's
    MMDD as the importer reads it, else the day of the post), and either
      - game: the parsed record (配置, the ten nicknames by seat, each round's proposals with
        their vote-anomaly marks and the mission result, the lake uses, the assassination
        target, the result, 線瓦／面瓦), or
      - problem (+ problemLine): why the record could not be read, as a fixed explanation
        string (SKIP_EXPLANATIONS) -- never the post's text.
  The starter message itself is not stored; only what the parser extracted from it.

Guards (exit 4, the existing file is kept): every string must have the expected shape
(records_problems), and the number of posts must not drop by more than max(5, 10%) against the
existing file (a forum read that came back short), unless --allow-shrink.

The log and $GITHUB_STEP_SUMMARY get counts only (public repository): no titles, names or records.

Usage:
    python discord_records_export.py                      # writes records_cache.json next to this file
    python discord_records_export.py --output PATH
    python discord_records_export.py --allow-shrink       # e.g. after many posts were deleted on purpose

Configuration (environment): DISCORD_BOT_TOKEN (View Channel + Read Message History on the forum,
Message Content intent), DISCORD_RECORDS_FORUM_ID (default: the forum of discord_records_import).

Exit codes: 0 ok (written or unchanged), 2 configuration, 4 guard refused the write, 5 Discord API error.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

import discord_records_import as dri
import generate_cache as gc

RECORDS_FORMAT = "avalon-records"
RECORDS_VERSION = 1
OUTPUT_PATH = Path(__file__).resolve().parent / "records_cache.json"
TITLE_MAX = 100
NAME_MAX = 40
TAG_MAX = 20
SHRINK_MIN = 5
SHRINK_FRACTION = 0.10

OUTCOMES = (gc.OUTCOME_THREE_RED, gc.OUTCOME_BLUE_DEAD, gc.OUTCOME_BLUE_ALIVE)
CATEGORIES = ("", *dri.CATEGORY_TAGS)
PROBLEMS = frozenset(dri.short_explanation(reason) for reason in dri.SKIP_EXPLANATIONS)
# Reasons that say the post is not a game record at all: such posts are left out of the list
# (unless something says they were meant as one, see post_entry).
NOT_A_GAME = frozenset({dri.SKIP_NOT_A_RECORD, dri.SKIP_SIMULATION})
NO_TEXT = frozenset({dri.SKIP_NO_STARTER, dri.SKIP_EMPTY})

_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f​-‏ -‮⁠-⁤﻿]")
_SHAPES = {
    "id": re.compile(r"[0-9]{15,22}"),
    "created": re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\+08:00"),
    "date": re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}"),
    "config": re.compile(r"[0-9]{6}"),
    "team": re.compile(r"[0-9]{3,5}"),
    "vote": re.compile(r"(?:[0-9]+[+\-])+"),
    "mission": re.compile(r"[ox]{3,5}"),
    "seat": re.compile(r"[0-9]"),
    "claim": re.compile(r"[ox?]?"),
    "kill": re.compile(r"[0-9]?"),
}


def clean_text(text: str, limit: int) -> str:
    """One line of plain text: control and zero-width characters dropped, whitespace collapsed,
    cut at `limit` characters."""
    s = " ".join(_CONTROL_RE.sub("", " ".join((text or "").split())).split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def iso_date(value: str) -> str:
    """'YYYY/MM/DD' (the importer's 日期時間) -> 'YYYY-MM-DD'."""
    return value.replace("/", "-")


def game_entry(game: dri.ParsedGame) -> dict[str, Any]:
    """The parsed record as the site renders it (seat order 1..9, 0 = seat 10)."""
    return {
        "config": game.config,
        "names": [clean_text(game.names[s], NAME_MAX) for s in dri.SEATS],
        "rounds": [
            {
                "proposals": [{"team": p.team, "votes": list(p.votes)} for p in rnd.proposals],
                "mission": rnd.mission,
            }
            for rnd in game.rounds
        ],
        "lakes": [
            {"after": use.after_round, "holder": use.lake.holder, "target": use.lake.target,
             "claim": use.lake.declared}
            for use in game.lakes
        ],
        "assassination": game.kill,
        "outcome": game.outcome,
        "category": game.category,
    }


def post_entry(post: dri.Post, content: str | None) -> tuple[dict[str, Any] | None, str]:
    """(the post's entry or None when it is left out, a fixed status for the counts)."""
    if dri.TAG_SIMULATION in post.tags:
        return None, "simulation"
    entry: dict[str, Any] = {
        "id": post.id,
        "title": clean_text(post.title, TITLE_MAX),
        "tags": [clean_text(t, TAG_MAX) for t in post.tags if clean_text(t, TAG_MAX)],
        "created": post.created.isoformat(timespec="seconds"),
    }
    entry["date"] = iso_date(dri.title_date(post.title, post.created)[0])
    try:
        game = dri.parse_post(post, content)
    except dri.SkipPost as exc:
        lines = (content or "").splitlines()
        if exc.reason in NOT_A_GAME or (exc.reason in NO_TEXT and not dri.meant_as_record(post, lines)):
            return None, "not a record"
        entry["game"] = None
        entry["problem"] = dri.short_explanation(exc.reason)
        if exc.line_no:
            entry["problemLine"] = exc.line_no
        return entry, "unreadable"
    except Exception:  # never let one odd post (or its text, in a traceback) through
        entry["game"] = None
        entry["problem"] = dri.short_explanation(dri.SKIP_INTERNAL)
        return entry, "unreadable"
    entry["date"] = iso_date(game.date)
    entry["game"] = game_entry(game)
    return entry, "game"


def build_records(posts: Iterable[dri.Post], fetch: Callable[[dri.Post], str | None], *,
                guild_id: str, forum_id: str) -> tuple[dict[str, Any], Counter]:
    """The file's document (posts newest first) and the counts per status. Pure apart from `fetch`;
    posts tagged 模擬 are not fetched."""
    entries: list[dict[str, Any]] = []
    status: Counter = Counter()
    for post in sorted(posts, key=lambda p: int(p.id), reverse=True):
        content = None if dri.TAG_SIMULATION in post.tags else fetch(post)
        entry, kind = post_entry(post, content)
        status[kind] += 1
        if entry is not None:
            entries.append(entry)
    doc = {
        "format": RECORDS_FORMAT,
        "version": RECORDS_VERSION,
        "guildId": guild_id,
        "forumId": forum_id,
        "counts": {
            "posts": len(entries),
            "games": status["game"],
            "unreadable": status["unreadable"],
        },
        "posts": entries,
    }
    return doc, status


def _full(pattern: str, value: Any) -> bool:
    return isinstance(value, str) and _SHAPES[pattern].fullmatch(value) is not None


def _plain(value: Any, limit: int, allow_empty: bool = False) -> bool:
    return (isinstance(value, str) and (allow_empty or value != "") and len(value) <= limit
            and clean_text(value, limit) == value)


def game_problems(game: Any) -> list[str]:
    """Shape problems of one parsed game (fixed strings, no values)."""
    if not isinstance(game, dict):
        return ["game is not an object"]
    out: list[str] = []
    if set(game) != {"config", "names", "rounds", "lakes", "assassination", "outcome", "category"}:
        out.append("game keys")
    if not _full("config", game.get("config")):
        out.append("config shape")
    names = game.get("names")
    if not (isinstance(names, list) and len(names) == len(dri.SEATS) and all(_plain(n, NAME_MAX) for n in names)):
        out.append("names shape")
    rounds = game.get("rounds")
    if not (isinstance(rounds, list) and 3 <= len(rounds) <= 5):
        out.append("rounds count")
        rounds = []
    for rnd in rounds:
        proposals = rnd.get("proposals") if isinstance(rnd, dict) else None
        if not (isinstance(rnd, dict) and set(rnd) == {"proposals", "mission"} and _full("mission", rnd.get("mission"))
                and isinstance(proposals, list) and 1 <= len(proposals) <= 5):
            out.append("round shape")
            continue
        for p in proposals:
            if not (isinstance(p, dict) and set(p) == {"team", "votes"} and _full("team", p.get("team"))
                    and isinstance(p.get("votes"), list) and all(_full("vote", v) for v in p["votes"])):
                out.append("proposal shape")
    lakes = game.get("lakes")
    if not isinstance(lakes, list) or len(lakes) > 3:
        out.append("lakes shape")
        lakes = []
    for lake in lakes:
        if not (isinstance(lake, dict) and set(lake) == {"after", "holder", "target", "claim"}
                and isinstance(lake.get("after"), int) and not isinstance(lake.get("after"), bool)
                and 2 <= lake["after"] <= 4 and _full("seat", lake.get("holder"))
                and _full("seat", lake.get("target")) and _full("claim", lake.get("claim"))):
            out.append("lake shape")
    if not _full("kill", game.get("assassination")):
        out.append("assassination shape")
    if game.get("outcome") not in OUTCOMES:
        out.append("outcome value")
    if game.get("category") not in CATEGORIES:
        out.append("category value")
    return out


def records_problems(doc: Any) -> list[str]:
    """Everything that is not the expected shape (fixed strings with counts, never a value). The
    write is refused when this is not empty: the file is public, so only the fields above, in
    their expected form, may be in it."""
    if not isinstance(doc, dict):
        return ["document is not an object"]
    out: Counter = Counter()
    if list(doc) != ["format", "version", "guildId", "forumId", "counts", "posts"]:
        out["top-level keys"] += 1
    if doc.get("format") != RECORDS_FORMAT or doc.get("version") != RECORDS_VERSION:
        out["format or version"] += 1
    if not (_full("id", doc.get("guildId")) and _full("id", doc.get("forumId"))):
        out["guild or forum id"] += 1
    posts = doc.get("posts")
    if not isinstance(posts, list):
        return [*out, "posts is not a list"]
    counts = doc.get("counts")
    games = sum(1 for p in posts if isinstance(p, dict) and p.get("game"))
    if counts != {"posts": len(posts), "games": games, "unreadable": len(posts) - games}:
        out["counts"] += 1
    seen: set[str] = set()
    last = None
    for post in posts:
        if not isinstance(post, dict):
            out["post is not an object"] += 1
            continue
        keys = set(post)
        base = {"id", "title", "tags", "created", "date", "game"}
        if not (keys == base or keys == base | {"problem"} or keys == base | {"problem", "problemLine"}):
            out["post keys"] += 1
        pid = post.get("id")
        if not _full("id", pid) or pid in seen:
            out["post id"] += 1
        else:
            seen.add(pid)
            if last is not None and int(pid) >= last:
                out["post order"] += 1
            last = int(pid)
        if not _plain(post.get("title"), TITLE_MAX, allow_empty=True):
            out["title shape"] += 1
        tags = post.get("tags")
        if not (isinstance(tags, list) and len(tags) <= dri.MAX_APPLIED_TAGS and all(_plain(t, TAG_MAX) for t in tags)):
            out["tags shape"] += 1
        elif dri.TAG_SIMULATION in tags:
            out["simulation post"] += 1
        if not _full("created", post.get("created")):
            out["created shape"] += 1
        if not _full("date", post.get("date")):
            out["date shape"] += 1
        if post.get("game") is None:
            if post.get("problem") not in PROBLEMS:
                out["problem text"] += 1
            line = post.get("problemLine")
            if "problemLine" in post and not (isinstance(line, int) and not isinstance(line, bool) and line > 0):
                out["problem line"] += 1
        else:
            if "problem" in post:
                out["problem on a parsed game"] += 1
            for problem in game_problems(post.get("game")):
                out[problem] += 1
    return [f"{name} ({n})" if n > 1 else name for name, n in out.items()]


def dump_records(doc: Mapping[str, Any]) -> str:
    """One top-level key per line and one post per line (small daily diffs)."""
    def compact(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

    lines = ["{"]
    keys = list(doc)
    for n, key in enumerate(keys):
        comma = "," if n < len(keys) - 1 else ""
        value = doc[key]
        if key == "posts" and isinstance(value, list) and value:
            lines.append(f"  {compact(key)}: [")
            lines += [f"    {compact(v)}{',' if i < len(value) - 1 else ''}" for i, v in enumerate(value)]
            lines.append(f"  ]{comma}")
        else:
            lines.append(f"  {compact(key)}: {compact(value)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def load_previous(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def shrink_problem(previous: Mapping[str, Any] | None, doc: Mapping[str, Any]) -> str | None:
    """A fixed message when the list lost more posts than deletions on Discord would explain."""
    if not previous or not isinstance(previous.get("posts"), list):
        return None
    before, after = len(previous["posts"]), len(doc["posts"])
    allowed = max(SHRINK_MIN, int(before * SHRINK_FRACTION))
    if before - after > allowed:
        return (f"the list would shrink from {before} to {after} posts (more than {allowed} fewer): a forum "
                "read that came back short? Kept the existing file; re-run with --allow-shrink if posts "
                "were deleted on purpose.")
    return None


def write_atomically(text: str, path: Path) -> None:
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def summary_lines(status: Counter, doc: Mapping[str, Any], result: str) -> list[str]:
    counts = doc["counts"]
    return [
        "### 網站「牌譜紀錄」清單（records_cache.json）",
        f"- 論壇貼文 {sum(status.values())} 篇：列出 {counts['posts']} 篇（讀得懂 {counts['games']}、"
        f"格式待修正 {counts['unreadable']}）；略過 模擬 {status['simulation']}、非牌譜貼文 {status['not a record']}",
        f"- 結果：{result}",
    ]


def run(args: argparse.Namespace, env: Mapping[str, str] | None = None,
        discord: Any | None = None) -> int:
    env = os.environ if env is None else env
    token = (env.get(dri.ENV_DISCORD_TOKEN) or "").strip()
    if discord is None and not token:
        raise gc.FatalError(f"{dri.ENV_DISCORD_TOKEN} is not set.", gc.EXIT_CONFIG, "Discord token missing")
    forum_id = (env.get(dri.ENV_FORUM_ID) or "").strip() or dri.FORUM_CHANNEL_ID
    out = Path(args.output)
    client = discord or dri.DiscordClient(token)
    try:
        posts, _missing = client.forum_posts(forum_id)
        print(f"Forum posts: {len(posts)}", flush=True)
        fetched = 0

        def fetch(post: dri.Post) -> str | None:
            nonlocal fetched
            fetched += 1
            if fetched % 200 == 0:
                print(f"  fetched {fetched} starter messages...", flush=True)
            return client.starter_content(post.id)

        doc, status = build_records(posts, fetch, guild_id=client.forum_guild_id(forum_id), forum_id=forum_id)
    except dri.DiscordError as exc:
        raise gc.FatalError(f"{exc} Nothing was written.", dri.EXIT_DISCORD, "Discord API error") from None

    problems = records_problems(doc)
    if problems:
        gc._append_step_summary(summary_lines(status, doc, f"格式檢查沒過，未寫入（{len(problems)} 個問題）"))
        raise gc.FatalError("The records list failed its shape check (" + "; ".join(problems[:10])
                            + "); kept the existing file.", gc.EXIT_DATA, "Records list not written")
    previous = load_previous(out)
    shrink = None if args.allow_shrink else shrink_problem(previous, doc)
    if shrink:
        gc._append_step_summary(summary_lines(status, doc, "篇數變少太多，未寫入"))
        raise gc.FatalError(shrink, gc.EXIT_DATA, "Records list not written")
    text = dump_records(doc)
    try:
        unchanged = out.read_text(encoding="utf-8") == text
    except OSError:
        unchanged = False
    if unchanged:
        result = "沒有變動"
    else:
        write_atomically(text, out)
        before = len(previous["posts"]) if previous and isinstance(previous.get("posts"), list) else 0
        result = f"已寫入（{before} → {doc['counts']['posts']} 篇）"
    lines = summary_lines(status, doc, result)
    print("\n".join(lines))
    gc._append_step_summary(lines)
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export the Discord 牌譜 forum as the website's records list.")
    parser.add_argument("--output", default=str(OUTPUT_PATH), metavar="PATH",
                        help=f"where to write the list (default {OUTPUT_PATH.name} next to this script)")
    parser.add_argument("--allow-shrink", action="store_true",
                        help="write even if the list has many fewer posts than the existing file")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(args)
    except gc.FatalError as exc:
        gc.emit_error(str(exc), exc.title)
        return exc.exit_code


if __name__ == "__main__":
    sys.exit(main())
