"""
牌譜總庫（Edward 2026-11-17：「你有自己獨立的牌譜資料庫嗎 (從各個地方蒐集而來的) 因為可能會重複或是登錄錯誤等等的
我希望你自己有建好自己的牌譜資料庫」）—— step 1: one canonical list of every game from every source, with its
provenance, duplicates merged, and every game checked against the rules of the game.

Sources (each already parsed by the existing nightly steps; this module reads their outputs, so it needs no
credentials and adds no new reader of Google / Discord):

  sheet      Google Sheet 牌譜 tab (實戰). games_cache.json rows with src = 0, id = 流水號.
  dc_import  Google Sheet Discord匯入 tab: Discord posts copied into the sheet by discord_records_import.py.
             games_cache.json rows with src = 1 (id ``D<hash>``).
  discord    Discord forum #牌譜紀錄與覆盤, one post per game (records_cache.json entries with a numeric id;
             ``game`` is null when the post does not parse -- ``problem`` says why).
  sim_sheet  Google Sheet 模擬瓦 tab (模擬). records_cache.json entries ``M<流水號>``.
  proavalon  ProAvalon anonymized export (外部, ``P<_id>``; proavalon_games.json from proavalon_import.py).
             OFF by default since 2026-11-18 (站長「我看ProAvalon 的局基本上很多都在亂玩 其實可以考慮刪掉了」):
             the default build leaves it out of game_db.json and the report; ``--with-proavalon`` turns it back
             on. proavalon_games.json and the private raw data stay as they are.

  (records_cache.json's ``S<流水號>`` entries are the sheet games again and sim_bank.json is built from the
  牌譜 snapshot sheets_cache.json, so neither is a source of its own; the report only checks their coverage.)

Merging: games with the same generate_cache.record_fingerprint (配置 + every proposal's team + every mission),
of the same type, are one game. 模擬 never merges with 實戰 (Edward 2026-11-16「模擬畢竟只是模擬」). The merged
game's content comes from the first source in SOURCE_PRIORITY (the sheet: what the stats use); its id is the
id the website's 牌譜紀錄 page uses (the Discord post id when there is one, else ``S<流水號>`` / ``D<hash>`` /
``M<流水號>``), so the id stays the same when a record is corrected.

A source that breaks a rule never hides a clean one (2026-11-17: players corrected the rule errors on Discord, yet
the list kept showing the sheet's copy): every source of a merged game is checked; when the preferred source has an
error and another source of the same game has none, the clean one is shown (CONFLICT names the source that is wrong).
A sheet-only game with an error whose corrected Discord copy no longer has the same fingerprint (one round missing,
配置 off by one seat) is folded into that copy (``superseded`` on the sheet source, rule SUPERSEDED), so the game is
listed once and without the sheet's error. The sheet itself still has to be fixed; the report lists those ids.

Every merged game gets ``checks``: one entry per broken rule (RULES below), with a plain-language message.
Level ``error`` = the record contradicts the rules of the game (a wrong seat, a wrong count, a wrong result);
``warn`` = the record is probably incomplete (votes that do not add up to the outcome, a missing assassination
target, two sources that disagree, a likely duplicate); ``info`` = worth knowing, not wrong. Nothing is fixed
automatically: the list is for a person to correct the source.

Excluded games (Edward 2026-11-17「尾派沒有出任務 刺客刺到隊友 都屬於錯誤局 不用記錄」): a game that breaks an
EXCLUDE_RULES rule in any of its sources -- the assassin shot a teammate (every red flips at the assassination,
Oberon included) or a forced 5th proposal that did not go on the mission -- is left out of ``games`` and every
count; the report lists those games by id and date only. The sources themselves are never changed.

Corrections: game_db_corrections.json (committed) overrides fields of one source's record when the site owner has
checked the original (e.g. his handwritten scoresheet), before merging and the rule checks; the source caches are
never edited. Each entry is keyed by the source's public id (``S572`` ...) and carries ``set`` (field -> value),
``by``, ``date`` and ``note``; the report lists them as 「站長更正」 (id, field, old -> new). An entry may instead (or
also) carry ``exclude``: EXCLUDE_RULES ids the site owner ruled the game breaks although no source shows it in record
syntax (e.g. a Discord post that ends the game before the forced 5th team went); the game is then excluded.

Privacy: no player names, no titles, no free text -- seats, the parsed record, ids and dates only (the same
level as the public dataset). The repo is public.

Usage:  python game_db.py [--games games_cache.json] [--records records_cache.json]
                          [--snapshot sheets_cache.json] [--sim-bank sim_bank.json]
                          [--corrections game_db_corrections.json]
                          [--with-proavalon [--proavalon proavalon_games.json]]
                          [--output game_db.json] [--check-report ../../docs/data/game_db_report.md]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

import discord_records_import as dri
import generate_cache as gc
import name_collisions as nc
import records_merge as rm
import voting_stats as vs

HERE = Path(__file__).resolve().parent
FORMAT = "avalon-game-db"
VERSION = 1

SRC_SHEET = "sheet"
SRC_IMPORT = "dc_import"
SRC_DISCORD = "discord"
SRC_SIM = "sim_sheet"
SRC_PROAVALON = "proavalon"
SOURCE_PRIORITY = (SRC_SHEET, SRC_DISCORD, SRC_IMPORT, SRC_SIM, SRC_PROAVALON)  # whose content the merged game shows
SOURCE_LABELS = {
    SRC_SHEET: "試算表 牌譜 分頁",
    SRC_IMPORT: "試算表 Discord匯入 分頁",
    SRC_DISCORD: "Discord 牌譜論壇",
    SRC_SIM: "試算表 模擬瓦 分頁",
    SRC_PROAVALON: "ProAvalon（外部、匿名）",
}

KIND_REAL = "real"
KIND_SIM = "sim"
KIND_BOT = "bot"
GROUP_EXTERNAL = "external"  # report / counts group of external rows (kind stays real)
# ProAvalon (外部) is left out of the default build (站長 2026-11-18「我看ProAvalon 的局基本上很多都在亂玩 其實可以考慮刪掉了」).
# Reversible: ``python game_db.py --with-proavalon`` puts the games back; nothing is deleted.
INCLUDE_PROAVALON = False

TEAM_SIZES = dri.TEAM_SIZES  # (3, 4, 4, 5, 5): 10 players
SEATS = gc.SEATS
LAKE_AFTER = (2, 3, 4)
FORCED_ATTEMPT = 5
MIN_APPROVE = 6  # of 10 votes
LEADER_MIN_SHARE = 0.8  # = packages/shared/src/stats/mistakes.ts
LEADER_MIN_MARGIN = 3
EARLIEST_DATE = "2015-01-01"
VENUES = ("線瓦", "面瓦")  # 線上／面對面: the only category kept as data (Edward 2026-11-17)
# 陣容強度 S tiers = packages/shared/src/stats/strength.ts S_TIERS (high = 高強度, S >= 65)
S_TIERS = (("high", 65.0), ("strong", 55.0), ("normal", 38.0), ("weak", float("-inf")))
INFER_ALL_WHITE = "all_white_after_success"

ERROR, WARN, INFO = "error", "warn", "info"

# rule id -> (level, short name shown in the report)
RULES: dict[str, tuple[str, str]] = {
    "CONFIG": (ERROR, "配置不是 6 個不同的座位"),
    "TEAM_SEATS": (ERROR, "隊伍裡有重複或不存在的座位"),
    "TEAM_SIZE": (ERROR, "隊伍人數不合 10 人局（3、4、4、5、5）"),
    "PROPOSALS": (ERROR, "一局沒有提議"),
    "FORCED_NOT_RUN": (ERROR, "第 5 次提議（尾派）沒有出任務（有第 6 次提議、或第 5 次提議後沒有任務）"),
    "MISSION_SIZE": (ERROR, "任務張數跟隊伍人數不一樣"),
    "FAILS_GT_RED": (ERROR, "失敗張數比隊上的紅方多"),
    "AFTER_DECIDED": (ERROR, "已經有一方拿到 3 局，後面還有局"),
    "UNDECIDED": (ERROR, "紀錄在任何一方拿到 3 局之前就結束"),
    "OUTCOME": (ERROR, "結果欄跟任務結果或刺殺對不上"),
    "ASSASSIN_TEAMMATE": (ERROR, "刺客刺到隊友（紅方刺殺時全部開牌，奧伯倫也開）"),
    "LAKE": (ERROR, "湖中女神不合規則（同一人、斷鏈、驗過的人又被驗、不在第 2～4 局後）"),
    "VOTE_MARKS": (WARN, "投票記號跟隊伍對不上（場內才會有 -、場外才會有 +；多半是座位寫錯）"),
    "VOTE_RESULT": (WARN, "投票張數跟提議過不過對不上（多半是漏記了場外白／場內黑）"),
    "ASSASSIN_MISSING": (WARN, "三藍卻沒有刺殺目標"),
    "ASSASSIN_EXTRA": (WARN, "三紅卻有刺殺目標"),
    "OUTCOME_MISSING": (WARN, "沒有結果"),
    "DATE_RANGE": (WARN, "日期不合理（早於 2015 年）"),
    "DUP_SAME_SOURCE": (WARN, "同一個來源登錄了兩次"),
    "CONFLICT": (WARN, "不同來源記的不一樣"),
    "NEAR_DUP": (WARN, "疑似同一局（同一天、同配置，但派隊或任務不同）"),
    "SUPERSEDED": (WARN, "同一局另一個來源記錯，總庫用了對的那一筆（例如試算表少記一局、配置寫錯）；記錯的來源要改"),
    "INFERRED_VOTES": (INFO, "順著上一局成功的隊伍派、紀錄沒寫投票：推定全部投白（不是原始紀錄）"),
    "SOURCE_NOTE": (INFO, "外部來源少記的東西（ProAvalon：湖的宣告、刺中哪個忠臣、舊紀錄的失敗張數）"),
    "OWNER_FLAG": (INFO, "試算表 note 標了要注意（review／badGame 等）"),
    "LAKE_CLAIM": (INFO, "湖的宣告沒有記"),
    "NO_DATE": (INFO, "沒有日期"),
    "LEADER": (INFO, "推不出隊長輪替（隊長多半會派自己，這局對不起來）"),
}
LEVEL_ORDER = {ERROR: 0, WARN: 1, INFO: 2}
# 錯誤局：不用記錄（Edward 2026-11-17）-- the game is left out of the database, not just flagged
EXCLUDE_RULES = ("ASSASSIN_TEAMMATE", "FORCED_NOT_RUN")
RED_ROLES = ("刺客", "莫甘娜", "莫德雷德", "奧伯倫")  # 配置 order: config[0..3]
OWNER_FLAGS = ("flag:review", "flag:badGame", "flag:incident", "flag:substitution", "flag:lakeCorrected")


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def strip_names(game: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The site's game object without player names or category (both kept elsewhere / per source)."""
    if not game:
        return None
    return {
        "config": game.get("config", ""),
        "rounds": [
            {"proposals": [{"team": p["team"], "votes": list(p.get("votes") or [])} for p in r["proposals"]],
             "mission": r.get("mission", "")}
            for r in game.get("rounds", [])
        ],
        "lakes": [dict(lake) for lake in game.get("lakes", [])],
        "assassination": game.get("assassination", ""),
        "outcome": game.get("outcome", ""),
    }


def raw_forced_rounds(text: str) -> list[int]:
    """Rounds whose forced 5th proposal did not go in a sheet row's raw 文字記錄 (only used for rows the dataset
    could not convert: voting_stats drops such a round, so the parsed row cannot show it): more than 5 proposals
    before a mission, or a last round that stops after 5+ proposals with no mission while no side has 3 yet.
    Trusted only when every earlier round ends in a mission line of the right size; nothing of the text is kept."""
    sizes: list[int] = []
    wins = Counter()
    pending = 0
    for raw in (text or "").splitlines():
        line = " ".join(unicodedata.normalize("NFKC", raw).translate(vs._SYMBOLS).strip().strip("`*_~|").split())
        if re.fullmatch(r"[oxOX](?: ?[oxOX]){0,4}", line):
            mission = line.replace(" ", "")
        else:
            m = vs._PROPOSAL.fullmatch(line)
            if not m:
                continue
            pending += 1
            mission = m.group(4) or ""
        if mission:
            if len(sizes) >= len(TEAM_SIZES) or len(mission) != TEAM_SIZES[len(sizes)] or not pending:
                return []
            sizes.append(pending)
            pending = 0
            wins[mission_success(len(sizes), mission.lower())] += 1
    forced = [r for r, n in enumerate(sizes, 1) if n > FORCED_ATTEMPT]
    if pending >= FORCED_ATTEMPT and len(sizes) < len(TEAM_SIZES) and max(wins.values(), default=0) < 3:
        return forced + [len(sizes) + 1]  # 尾派沒有出任務: the record stops after the forced proposal
    return forced if not pending else []


def dataset_sources(doc: Mapping[str, Any] | None, raw_text: Mapping[str, str] | None = None) -> list[dict[str, Any]]:
    """games_cache.json rows -> sources (sheet / dc_import). raw_text = 流水號 -> 文字記錄 of the 牌譜 snapshot."""
    out: list[dict[str, Any]] = []
    if not doc:
        return out
    idx = {name: i for i, name in enumerate(doc["fields"])}
    note_vocab = doc["vocab"].get("noteTags", [])
    for row in doc["games"]:
        src = SRC_IMPORT if row[idx["src"]] == gc.GAME_SOURCE_DISCORD else SRC_SHEET
        category = doc["vocab"]["category"][row[idx["cat"]]]
        game, reason = rm.sheet_game(row, doc)
        forced = raw_forced_rounds((raw_text or {}).get(str(row[idx["id"]]), "")) if src == SRC_SHEET and not game else []
        notes = row[idx["note"]] if isinstance(row[idx["note"]], list) else []
        flags = sorted(note_vocab[i] for i in notes if 0 <= i < len(note_vocab) and note_vocab[i] in OWNER_FLAGS)
        lineup = row[idx["lineup"]] if "lineup" in idx else []
        out.append({
            "src": src,
            "id": str(row[idx["id"]]),
            "kind": KIND_BOT if category == gc.BOT_CATEGORY else KIND_REAL,
            "date": rm.iso_date(row[idx["date"]]),
            "venue": category if category in VENUES else "",
            # the sheet's 分類 mixes 線瓦/面瓦 with subjective labels (娛樂 ...): kept only as provenance
            "legacy": category if category and category not in VENUES and category != gc.BOT_CATEGORY else "",
            "s": round(lineup[1] / 10, 1) if isinstance(lineup, list) and len(lineup) > 1 and isinstance(lineup[1], (int, float)) else None,
            "game": game,
            "problem": "" if game else f"試算表這局的紀錄讀不懂（{reason}）",
            "flags": flags,
            # the fingerprint records_merge uses for this row (also when the row does not convert)
            "fp": rm.row_fingerprint(row, idx),
            **({"forced_rounds": forced} if forced else {}),
        })
    return out


def records_sources(doc: Mapping[str, Any] | None) -> tuple[list[dict[str, Any]], set[str]]:
    """records_cache.json entries -> sources (discord / sim_sheet), plus the ids of its S entries."""
    out: list[dict[str, Any]] = []
    sheet_ids: set[str] = set()
    if not doc:
        return out, sheet_ids
    for post in doc.get("posts", []):
        pid = str(post.get("id", ""))
        if pid.startswith(rm.SHEET_PREFIX):
            sheet_ids.add(pid[len(rm.SHEET_PREFIX):])
            continue
        if pid.startswith(rm.SIM_PREFIX):
            src, sid = SRC_SIM, pid[len(rm.SIM_PREFIX):]
        elif pid.isdigit():
            src, sid = SRC_DISCORD, pid
        else:
            continue
        tags = [t for t in post.get("tags", []) if isinstance(t, str)]
        game = post.get("game")
        lineup = post.get("lineup") if isinstance(post.get("lineup"), dict) else {}
        out.append({
            "src": src,
            "id": sid,
            "kind": KIND_SIM if (post.get("sim") or src == SRC_SIM) else KIND_REAL,
            "date": post.get("date") or "",
            "venue": next((t for t in tags if t in VENUES), ""),
            "legacy": next((t for t in tags if t in rm.GAME_CATEGORIES[1:] and t not in VENUES), ""),
            "s": lineup.get("s") if isinstance(lineup.get("s"), (int, float)) else None,
            "game": game,
            "problem": "" if game else (post.get("problem") or "讀不懂"),
            "flags": [],
            "fp": rm.game_fingerprint(game) if game else "",
            **({"fixedByReply": str(post["fixedByReply"])} if post.get("fixedByReply") and game else {}),
        })
    return out, sheet_ids


SOURCE_NOTES = {
    "proavalon:noLakeClaims": "ProAvalon 沒有記湖的宣告",
    "proavalon:lakeSeatsUnknown": "這局 ProAvalon 沒有記誰拿湖、驗誰",
    "proavalon:shotLoyalSeatUnknown": "刺客刺的是忠臣，ProAvalon 沒有記是哪一個",
    "proavalon:failCountUnknown": "舊紀錄只有任務成敗，失敗張數用最少的算（第 4 局 2 張、其他 1 張）",
}


def proavalon_sources(doc: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """proavalon_games.json (proavalon_import.py) -> sources. External: the stats leave them out by default."""
    out: list[dict[str, Any]] = []
    for g in (doc or {}).get("games", []):
        game = g.get("game")
        out.append({
            "src": SRC_PROAVALON, "id": str(g["id"]), "kind": KIND_REAL, "date": g.get("date", ""),
            "venue": g.get("venue", "線瓦"), "legacy": "", "s": None, "game": game,
            "problem": "" if game else "讀不懂", "flags": list(g.get("flags", [])),
            "fp": rm.game_fingerprint(game) if game else "",
        })
    return out


CORRECTABLE = ("config", "rounds", "lakes", "assassination", "outcome")


def apply_corrections(sources: Sequence[dict[str, Any]], doc: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Override fields of the sources named in game_db_corrections.json (on a copy of the record) and return
    what was applied: id, field, old, new, by, date -- or ``missing`` when no source has that id. A source that
    did not convert (or whose raw text showed a 6th proposal) takes a correction only when it sets the whole
    record (every CORRECTABLE field, e.g. retyped by the site owner on the console); it then becomes readable."""
    entries = (doc or {}).get("corrections") or {}
    by_id = {public_id(s): s for s in sources}
    applied: list[dict[str, Any]] = []
    for gid, entry in sorted(entries.items()):
        fields = entry.get("set") or {}
        unknown = sorted(set(fields) - set(CORRECTABLE))
        if unknown:
            raise ValueError(f"game_db_corrections.json {gid}: cannot correct {unknown} (only {CORRECTABLE})")
        exclude = list(entry.get("exclude") or [])
        bad_rules = sorted(set(exclude) - set(EXCLUDE_RULES))
        if bad_rules:
            raise ValueError(f"game_db_corrections.json {gid}: cannot exclude by {bad_rules} (only {EXCLUDE_RULES})")
        meta = {"by": entry.get("by", ""), "date": entry.get("date", "")}
        src = by_id.get(gid)
        if src is not None and exclude:  # 站長裁定：錯誤局（不用記錄）
            src["owner_exclude"] = sorted(set(src.get("owner_exclude", [])) | set(exclude), key=EXCLUDE_RULES.index)
            applied += [{"id": gid, "field": "exclude", "old": "", "new": rule, **meta} for rule in exclude]
            if not fields:
                continue
        whole = set(fields) == set(CORRECTABLE)
        if src is None or (not src["game"] and not whole):
            applied.append({"id": gid, "missing": True, **meta})
            continue
        if not src["game"]:  # the whole record, retyped: replaces the unreadable one
            src["game"] = {f: fields[f] for f in CORRECTABLE}
            src["fp"] = rm.game_fingerprint(src["game"])
            done = [{"id": gid, "field": "record", "old": src["problem"] or "讀不懂", "new": "站長重打的整局紀錄", **meta}]
            src["problem"] = ""
            src.pop("forced_rounds", None)
            src["corrected"] = [{k: v for k, v in d.items() if k != "id"} for d in done]
            applied += done
            continue
        game = dict(src["game"])
        done = []
        for field, value in fields.items():
            done.append({"id": gid, "field": field, "old": game.get(field), "new": value, **meta})
            game[field] = value
        src["game"] = game
        src["corrected"] = [{k: v for k, v in d.items() if k != "id"} for d in done]
        if {"config", "rounds"} & set(fields):
            src["fp"] = rm.game_fingerprint(game)
        applied += done
    return applied


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

def _check(rule: str, msg: str) -> dict[str, str]:
    return {"rule": rule, "level": RULES[rule][0], "msg": msg}


def seat_label(s: str) -> str:
    return f"{s}家"


def approvers(team: str, votes: Sequence[str]) -> tuple[set[str], list[str]]:
    """Approving seats from the anomaly marks ('57-' = team members who rejected, '6+' = outsiders who
    approved; no mark = team approves, outsiders reject) and the marks that make no sense."""
    yes = set(team)
    bad: list[str] = []
    for token in votes:
        text = str(token).replace(" ", "")
        parts = re.findall(r"([0-9]+)([+-])", text)
        if not parts or "".join(a + b for a, b in parts) != text:
            bad.append(str(token))
            continue
        for seats, sign in parts:
            for s in seats:
                if sign == "-":
                    if s not in team:
                        bad.append(f"{s}-")
                    yes.discard(s)
                else:
                    if s in team:
                        bad.append(f"{s}+")
                    yes.add(s)
    return yes, bad


def mission_success(round_no: int, mission: str) -> bool:
    fails = mission.count("x")
    return fails == 0 or (round_no == 4 and fails < 2)


def derive_leaders(teams: Sequence[str]) -> list[str] | None:
    """Python port of packages/shared/src/stats/mistakes.ts deriveLeaderSeats: the rotation start whose
    leaders are on their own team most often; None when no start is clearly best."""
    if not teams:
        return None
    cover = [sum(1 for k, team in enumerate(teams) if SEATS[(start + k) % 10] in team) for start in range(10)]
    best = max(cover)
    start = cover.index(best)
    second = max(c for i, c in enumerate(cover) if i != start)
    if best < len(teams) * LEADER_MIN_SHARE or best - second < LEADER_MIN_MARGIN:
        return None
    return [SEATS[(start + k) % 10] for k in range(len(teams))]


def validate(game: Mapping[str, Any], partial: bool = False, inferred: list[dict[str, Any]] | None = None,
             infer: bool = True) -> list[dict[str, str]]:
    """Every broken rule of one parsed game (the site's game object). partial = a 模擬 record, which may
    stop anywhere: the end-of-game rules (decided, result, assassination, leader rotation) are skipped."""
    checks: list[dict[str, str]] = []
    config = str(game.get("config", ""))
    config_ok = bool(re.fullmatch(r"[0-9]{6}", config)) and len(set(config)) == 6
    if not config_ok:
        checks.append(_check("CONFIG", f"配置「{config}」不是 6 個不同的座位"))
    reds = set(config[:4]) if config_ok else set()
    merlin = config[5] if config_ok else ""

    rounds = list(game.get("rounds", []))
    blue = red = 0
    decided_at = 0
    all_teams: list[str] = []
    prev_success_team = ""  # the team of the previous round's mission when it succeeded
    for r, rnd in enumerate(rounds, 1):
        size = TEAM_SIZES[r - 1] if r <= len(TEAM_SIZES) else 0
        props = list(rnd.get("proposals", []))
        mission = str(rnd.get("mission") or "")
        if decided_at:
            checks.append(_check("AFTER_DECIDED", f"第 {decided_at} 局已經分出勝負，後面還有第 {r} 局"))
        if not props:
            checks.append(_check("PROPOSALS", f"第 {r} 局沒有提議"))
        elif len(props) > FORCED_ATTEMPT:
            checks.append(_check("FORCED_NOT_RUN", f"第 {r} 局有 {len(props)} 次提議（第 5 次提議沒有出任務）"))
        elif len(props) == FORCED_ATTEMPT and not mission and not (partial and r == len(rounds)):
            checks.append(_check("FORCED_NOT_RUN", f"第 {r} 局第 5 次提議後沒有任務結果"))
        for k, p in enumerate(props, 1):
            team = str(p.get("team", ""))
            all_teams.append(team)
            if not re.fullmatch(r"[0-9]+", team) or len(set(team)) != len(team):
                checks.append(_check("TEAM_SEATS", f"第 {r} 局第 {k} 次提議的隊伍「{team}」有重複的座位"))
            elif size and len(team) != size:
                checks.append(_check("TEAM_SIZE", f"第 {r} 局第 {k} 次提議派了 {len(team)} 人（要 {size} 人）"))
            yes, bad = approvers(team, p.get("votes") or [])
            if bad:
                checks.append(_check("VOTE_MARKS", f"第 {r} 局第 {k} 次提議（隊伍 {team}）的投票記號 {'、'.join(bad)} 跟隊伍對不上"))
            if k >= FORCED_ATTEMPT:
                continue
            last = k == len(props) and bool(mission)
            if (infer and last and k == 1 and len(yes) < MIN_APPROVE and not (p.get("votes") or [])
                    and prev_success_team and set(prev_success_team) <= set(team)):
                # Edward 2026-11-17: after a mission succeeds the next leader often re-sends that team and
                # everyone simply approves; recorders then skip the votes. Inferred, never silent.
                checks.append(_check("INFERRED_VOTES", f"第 {r} 局第 1 次提議 {team} 順著上一局成功的隊伍 {prev_success_team}，沒記投票，推定全部投白"))
                if inferred is not None:
                    inferred.append({"round": r, "attempt": 1, "kind": INFER_ALL_WHITE})
                continue
            if last and len(yes) < MIN_APPROVE:
                checks.append(_check("VOTE_RESULT", f"第 {r} 局第 {k} 次提議出了任務，但紀錄的贊成票只有 {len(yes)} 張（要 {MIN_APPROVE} 張）"))
            elif not last and len(yes) >= MIN_APPROVE:
                checks.append(_check("VOTE_RESULT", f"第 {r} 局第 {k} 次提議有 {len(yes)} 張贊成（過半），卻沒有出任務"))
        prev_success_team = ""
        if not mission:
            continue
        if not re.fullmatch(r"[ox]+", mission):
            checks.append(_check("MISSION_SIZE", f"第 {r} 局的任務結果「{mission}」看不懂"))
            continue
        team = str(props[-1]["team"]) if props else ""
        if size and len(mission) != size:
            checks.append(_check("MISSION_SIZE", f"第 {r} 局任務 {len(mission)} 張（要 {size} 張）"))
        elif team and len(mission) != len(team):
            checks.append(_check("MISSION_SIZE", f"第 {r} 局任務 {len(mission)} 張，出任務的隊伍是 {len(team)} 人"))
        if config_ok and team:
            on_red = len(reds & set(team))
            if mission.count("x") > on_red:
                checks.append(_check("FAILS_GT_RED", f"第 {r} 局出了 {mission.count('x')} 張失敗，隊伍 {team} 上只有 {on_red} 個紅方"))
        if mission_success(r, mission):
            blue += 1
            prev_success_team = team
        else:
            red += 1
        if not decided_at and (blue == 3 or red == 3):
            decided_at = r

    kill = str(game.get("assassination") or "")
    outcome = str(game.get("outcome") or "")
    if partial:
        return checks + lake_checks(game, rounds, partial)
    if rounds and not decided_at:
        checks.append(_check("UNDECIDED", f"紀錄停在第 {len(rounds)} 局（藍 {blue}、紅 {red}），沒有一方拿到 3 局"))
    if config_ok and kill and kill in reds:
        checks.append(_check("ASSASSIN_TEAMMATE", f"刺殺目標 {seat_label(kill)} 是{RED_ROLES[config.index(kill)]}（隊友）"))
    if red == 3:
        expected = gc.OUTCOME_THREE_RED
        if kill:
            checks.append(_check("ASSASSIN_EXTRA", f"三紅卻記了刺殺目標 {seat_label(kill)}"))
    elif blue == 3:
        if kill and config_ok:
            expected = gc.OUTCOME_BLUE_DEAD if kill == merlin else gc.OUTCOME_BLUE_ALIVE
        else:
            expected = ""  # cannot tell 死 / 活 without a target
            if not kill:
                checks.append(_check("ASSASSIN_MISSING", "三藍但沒有記刺殺目標"))
    else:
        expected = ""
    if not outcome:
        checks.append(_check("OUTCOME_MISSING", "沒有記結果"))
    elif blue == 3 and not expected:
        if outcome not in (gc.OUTCOME_BLUE_DEAD, gc.OUTCOME_BLUE_ALIVE):
            checks.append(_check("OUTCOME", f"任務三藍，結果卻寫「{outcome}」"))
    elif expected and outcome != expected:
        why = "刺中梅林" if expected == gc.OUTCOME_BLUE_DEAD else ("沒刺中梅林" if blue == 3 else "任務三紅")
        checks.append(_check("OUTCOME", f"結果寫「{outcome}」，照任務和刺殺應該是「{expected}」（{why}）"))

    checks += lake_checks(game, rounds, partial)
    if all_teams and derive_leaders(all_teams) is None:
        checks.append(_check("LEADER", "從各次派的隊推不出一致的隊長輪替"))
    return checks


def lake_checks(game: Mapping[str, Any], rounds: Sequence[Any], partial: bool) -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []
    held: list[str] = []
    prev_target = ""
    lakes = sorted(game.get("lakes", []), key=lambda lk: lk.get("after", 0))
    for n, lake in enumerate(lakes):
        after, holder, target = lake.get("after"), str(lake.get("holder", "")), str(lake.get("target", ""))
        problems = []
        if after not in LAKE_AFTER:
            problems.append(f"在第 {after} 局後")
        elif rounds and after >= len(rounds) and not partial:
            problems.append(f"在第 {after} 局後，但遊戲在第 {len(rounds)} 局就結束")
        if holder == target:
            problems.append("持湖的人驗自己")
        if n and holder != prev_target:
            problems.append(f"持湖的是 {seat_label(holder)}，上一湖驗的是 {seat_label(prev_target)}")
        if target in held:
            problems.append(f"{seat_label(target)} 拿過湖，不能再被驗")
        if problems:
            checks.append(_check("LAKE", f"第 {n + 1} 湖（{seat_label(holder)} 驗 {seat_label(target)}）：" + "；".join(problems)))
        if lake.get("claim", "") not in ("o", "x"):
            checks.append(_check("LAKE_CLAIM", f"第 {n + 1} 湖（{seat_label(holder)} 驗 {seat_label(target)}）沒有記宣告"))
        held.append(holder)
        prev_target = target
    return checks


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def proposal_votes(game: Mapping[str, Any]) -> list[tuple[int, int, frozenset[str]]]:
    """(round, attempt, approvers) of every voted proposal (attempt 1-4) -- comparable across sources."""
    out = []
    for r, rnd in enumerate(game.get("rounds", []), 1):
        for k, p in enumerate(rnd.get("proposals", []), 1):
            if k < FORCED_ATTEMPT:
                out.append((r, k, frozenset(approvers(p["team"], p.get("votes") or [])[0])))
    return out


def conflicts(main: Mapping[str, Any], other: Mapping[str, Any]) -> list[str]:
    """Fields where two sources of the same game disagree (plain-language names)."""
    a, b = main["game"], other["game"]
    out = []
    if (a.get("outcome") or "") and (b.get("outcome") or "") and a["outcome"] != b["outcome"]:
        out.append(f"結果（{a['outcome']} / {b['outcome']}）")
    if (a.get("assassination") or "") != (b.get("assassination") or "") and a.get("assassination") and b.get("assassination"):
        out.append(f"刺殺（{a['assassination']} / {b['assassination']}）")
    la = [(lk["after"], lk["holder"], lk["target"]) for lk in a.get("lakes", [])]
    lb = [(lk["after"], lk["holder"], lk["target"]) for lk in b.get("lakes", [])]
    ca = [lk.get("claim", "") for lk in a.get("lakes", [])]
    cb = [lk.get("claim", "") for lk in b.get("lakes", [])]
    claims_differ = len(ca) == len(cb) and any(x in "ox" and y in "ox" and x and y and x != y for x, y in zip(ca, cb))
    if la and lb and (la != lb or claims_differ):  # an unknown claim ('' / '?') on one side is not a conflict
        out.append("湖中女神")
    va, vb = proposal_votes(a), proposal_votes(b)
    if va and vb and len(va) == len(vb):
        diff = [f"第 {r} 局第 {k} 次" for (r, k, x), (_, _, y) in zip(va, vb) if x != y]
        if diff:
            out.append("投票（" + "、".join(diff[:3]) + ("…" if len(diff) > 3 else "") + "）")
    if main["date"] and other["date"] and main["date"] != other["date"]:
        out.append(f"日期（{main['date']} / {other['date']}）")
    if main["venue"] and other["venue"] and main["venue"] != other["venue"]:
        out.append(f"線上／面對面（{main['venue']} / {other['venue']}）")
    return out


def public_id(src: dict[str, Any]) -> str:
    """The id the website's 牌譜紀錄 page uses for this source."""
    if src["src"] == SRC_SHEET:
        return rm.SHEET_PREFIX + src["id"]
    if src["src"] == SRC_SIM:
        return rm.SIM_PREFIX + src["id"]
    if src["src"] == SRC_PROAVALON:
        return "P" + src["id"]
    return src["id"]  # Discord post id / D<hash>


def excluded_by(src: Mapping[str, Any], partial: bool) -> list[str]:
    """The EXCLUDE_RULES one source breaks (its own record, so a clean second source does not hide it)."""
    hit = {c["rule"] for c in validate(src["game"], partial=partial) if c["rule"] in EXCLUDE_RULES} if src["game"] else set()
    if src.get("forced_rounds"):
        hit.add("FORCED_NOT_RUN")
    hit |= set(src.get("owner_exclude", []))
    return [r for r in EXCLUDE_RULES if r in hit]


def _fp_parts(fp: str) -> tuple[str, list[str], list[str]]:
    """(配置, proposal teams, missions) of a record_fingerprint."""
    cfg, teams, missions = (fp.split("|") + ["", ""])[:3]
    return cfg, [t for t in teams.split(",") if t], [m for m in missions.split(",") if m]


def _round_span(first: int, last: int) -> str:
    return f"第 {first} 局" if first == last else f"第 {first}～{last} 局"


def twin_reason(bad_fp: str, good_fp: str) -> str:
    """Why a sheet record with an error and a clean record of another source are the same game, as the sheet's
    mistake (plain words), or "" when they are not: the same 配置 and one record is the other with whole rounds
    missing at the end (teams and missions a prefix), or the same teams and missions with the 配置 off by one seat."""
    bc, bt, bm = _fp_parts(bad_fp)
    gcfg, gt, gm = _fp_parts(good_fp)
    if not bt or not gt:
        return ""
    if bc == gcfg:
        if len(bm) < len(gm) and gt[:len(bt)] == bt and gm[:len(bm)] == bm:
            return f"試算表少記{_round_span(len(bm) + 1, len(gm))}"
        if len(gm) < len(bm) and bt[:len(gt)] == gt and bm[:len(gm)] == gm:
            return f"試算表多記{_round_span(len(gm) + 1, len(bm))}"
        return ""
    if (len(bc) == len(gcfg) == 6 and sum(a != b for a, b in zip(bc, gcfg)) == 1 and bt == gt and bm == gm):
        return f"配置不同（試算表 {bc}，正確的是 {gcfg}）"
    return ""


def _errors(src: Mapping[str, Any], partial: bool) -> list[str]:
    """The ERROR rules one source's own record breaks (EXCLUDE_RULES aside: those exclude the game)."""
    if not src["game"]:
        return []
    return list(dict.fromkeys(c["rule"] for c in validate(src["game"], partial=partial)
                              if c["level"] == ERROR and c["rule"] not in EXCLUDE_RULES))


def _rule_names(rules: Iterable[str]) -> str:
    return "、".join(RULES[r][1].split("（")[0] for r in rules)


def fold_sheet_twins(clusters: dict[tuple[str, str], list[dict[str, Any]]]) -> None:
    """Fold each sheet-only game with an error into the one clean game of another source that is the same game
    with the sheet's mistake fixed (twin_reason), same type and date. The sheet sources get ``superseded``."""
    groups = list(clusters.items())
    candidates: dict[tuple[str, str], list[tuple[tuple[str, str], dict[str, Any]]]] = defaultdict(list)
    for key, members in groups:
        partial = key[0] == KIND_SIM
        if any(s["src"] in (SRC_DISCORD, SRC_IMPORT) for s in members) and not any(excluded_by(s, partial) for s in members):
            for s in members:
                if s["src"] in (SRC_DISCORD, SRC_IMPORT) and s["date"] and not _errors(s, partial):
                    candidates[(key[0], s["date"])].append((key, s))
    for key, members in groups:
        partial = key[0] == KIND_SIM
        if (not all(s["src"] == SRC_SHEET for s in members) or not members[0]["date"]
                or any(excluded_by(s, partial) for s in members) or not all(_errors(s, partial) for s in members)):
            continue
        hits = {}
        for tkey, twin in candidates.get((key[0], members[0]["date"]), []):
            reason = twin_reason(key[1], twin["fp"])
            if reason and tkey in clusters:
                hits.setdefault(tkey, reason)
        if len(hits) != 1:  # none, or ambiguous: leave both as they are
            continue
        (tkey, reason), = hits.items()
        for s in members:
            s["superseded"] = reason
        clusters[tkey].extend(members)
        del clusters[key]


def build(sources: Sequence[dict[str, Any]], excluded: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Merge sources by fingerprint (per type), validate, and return the database rows. Games that break an
    EXCLUDE_RULES rule in any source are not returned; they go to ``excluded`` (id, date, rules) when given.
    The game's content comes from the first source in SOURCE_PRIORITY whose own record has no error (the first
    source when none is clean); a sheet-only game with an error is folded into its corrected copy (fold_sheet_twins)."""
    clusters: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    singles: list[list[dict[str, Any]]] = []
    for s in sources:
        s.pop("superseded", None)
        group = KIND_SIM if s["kind"] == KIND_SIM else KIND_REAL
        if s["game"] and s["fp"]:
            clusters[(group, s["fp"])].append(s)
        else:
            singles.append([s])
    fold_sheet_twins(clusters)
    rank = {src: i for i, src in enumerate(SOURCE_PRIORITY)}
    rows: list[dict[str, Any]] = []
    for members in [*clusters.values(), *singles]:
        members.sort(key=lambda s: (rank[s["src"]], s["id"]))
        partial = members[0]["kind"] == KIND_SIM
        errs = {id(s): _errors(s, partial) for s in members}
        folded = [s for s in members if s.get("superseded")]
        live = [s for s in members if not s.get("superseded")] or members
        main = live[0]
        replaced: set[int] = set()
        if errs[id(main)]:
            clean = next((s for s in live if s["game"] and not errs[id(s)]), None)
            if clean is not None:  # a wrong source never hides a clean one (CONFLICT names the wrong one)
                replaced = {id(s) for s in live if s is not clean and errs[id(s)]}
                main = clean
        members = [main] + [s for s in members if s is not main]
        by_src = {s["src"]: s for s in reversed(members)}
        cid = (by_src.get(SRC_DISCORD) or by_src.get(SRC_SHEET) or by_src.get(SRC_IMPORT) or main)
        kind = KIND_SIM if main["kind"] == KIND_SIM else (KIND_BOT if any(s["kind"] == KIND_BOT for s in members) else KIND_REAL)
        date = next((s["date"] for s in members if s["date"]), "")
        venue = next((s["venue"] for s in members if s["venue"]), "")
        legacy = sorted({s["legacy"] for s in members if s["legacy"]})
        s_value = next((s["s"] for s in members if s["s"] is not None), None)
        external = any(s["src"] == SRC_PROAVALON for s in members)
        hits = {id(s): excluded_by(s, kind == KIND_SIM) for s in members}
        bad = sorted({r for v in hits.values() for r in v}, key=EXCLUDE_RULES.index)
        if bad:
            if excluded is not None:
                excluded.append({
                    "id": public_id(cid), "kind": kind, **({"external": True} if external else {}), "date": date,
                    "rules": bad, "sources": [public_id(s) for s in members],
                    # 來源不一致：another source of the same game is readable and breaks none of them
                    "inconsistent": any(s["game"] and not hits[id(s)] for s in members),
                })
            continue
        checks: list[dict[str, str]] = []
        inferred: list[dict[str, Any]] = []
        if main["game"]:
            checks += validate(main["game"], partial=kind == KIND_SIM, inferred=inferred)
            counts = Counter(s["src"] for s in members)
            for src, n in sorted(counts.items()):
                if n > 1:
                    ids = "、".join(public_id(s) for s in members if s["src"] == src)
                    checks.append(_check("DUP_SAME_SOURCE", f"{SOURCE_LABELS[src]}有 {n} 筆是同一局：{ids}"))
            for other in members[1:]:
                if other.get("superseded"):
                    checks.append(_check("SUPERSEDED", f"{SOURCE_LABELS[other['src']]}（{public_id(other)}）記錯"
                                                       f"（{_rule_names(errs[id(other)])}）：{other['superseded']}；這局用 "
                                                       f"{SOURCE_LABELS[main['src']]}（{public_id(main)}）的紀錄"))
                    continue
                diff = conflicts(main, other) if other["game"] else []
                if id(other) in replaced:
                    diff = [f"{SOURCE_LABELS[other['src']]}那筆有錯（{_rule_names(errs[id(other)])}），這局用 "
                            f"{SOURCE_LABELS[main['src']]}（{public_id(main)}）的紀錄", *diff]
                if diff:
                    checks.append(_check("CONFLICT", f"{SOURCE_LABELS[main['src']]} 跟 {SOURCE_LABELS[other['src']]}（{public_id(other)}）不一樣：" + "、".join(diff)))
            if not date:
                checks.append(_check("NO_DATE", "沒有日期"))
            elif date < EARLIEST_DATE:
                checks.append(_check("DATE_RANGE", f"日期 {date}"))
        flags = sorted({f for s in members for f in s["flags"]})
        owner = [f for f in flags if f.startswith("flag:")]
        notes = [f for f in flags if not f.startswith("flag:")]
        if owner:
            checks.append(_check("OWNER_FLAG", "、".join(owner)))
        if notes:
            checks.append(_check("SOURCE_NOTE", "、".join(SOURCE_NOTES.get(f, f) for f in notes)))
        if "proavalon:shotLoyalSeatUnknown" in flags:  # the source never says which loyal servant was shot
            checks = [c for c in checks if c["rule"] != "ASSASSIN_MISSING"]
        checks.sort(key=lambda c: (LEVEL_ORDER[c["level"]], c["rule"], c["msg"]))
        status = "unreadable" if not main["game"] else (
            ERROR if any(c["level"] == ERROR for c in checks) else WARN if any(c["level"] == WARN for c in checks) else "ok")
        rows.append({
            "id": public_id(cid),
            "kind": kind,
            **({"external": True} if external else {}),
            "date": date,
            "venue": venue,
            **({"legacyCategory": legacy} if legacy else {}),
            "s": s_value,
            "strength": strength_tier(s_value),
            "status": status,
            "sources": [{"src": s["src"], "id": public_id(s),
                         **({"superseded": s["superseded"]} if s.get("superseded") else {}),
                         **({"wrong": True} if id(s) in replaced else {}),
                         **({"fixedByReply": s["fixedByReply"]} if s.get("fixedByReply") else {})} for s in members],
            "fp": main["fp"],
            "game": strip_names(main["game"]),
            **({"problem": main["problem"]} if not main["game"] else {}),
            **({"inferred_votes": inferred} if inferred else {}),
            **({"corrections": corrected} if (corrected := [c for s in members for c in s.get("corrected", [])]) else {}),
            "checks": checks,
        })
    near_dups(rows)
    for row in rows:
        if any(c["rule"] == "NEAR_DUP" for c in row["checks"]) and row["status"] == "ok":
            row["status"] = WARN
    order = lambda r: ({KIND_REAL: 0, KIND_BOT: 1, KIND_SIM: 2}[r["kind"]], r["date"] == "", _neg(r["date"]), r["id"])  # noqa: E731
    rows.sort(key=order)
    if excluded is not None:
        excluded.sort(key=order)
    return rows


def strength_tier(s: float | None) -> str:
    """Objective table strength from the lineup S (instead of subjective 娛樂／新手 labels)."""
    if s is None:
        return ""
    return next(tier for tier, floor in S_TIERS if s >= floor)


def _neg(date: str) -> str:
    """Sort key: newest date first."""
    return "".join(chr(0x7F - ord(c)) for c in date)


def near_dups(rows: list[dict[str, Any]]) -> None:
    """Same type, same day, same 配置 but a different record: probably one game entered twice with a
    mistake (配置 alone repeats about once in 150k games)."""
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        if row["game"] and row["date"]:
            group = KIND_SIM if row["kind"] == KIND_SIM else KIND_REAL
            groups[(group, row["date"], row["game"]["config"])].append(row)
    for members in groups.values():
        if len(members) < 2:
            continue
        for row in members:
            others = "、".join(m["id"] for m in members if m is not row)
            row["checks"].append(_check("NEAR_DUP", f"同一天、同配置的還有 {others}"))
            row["checks"].sort(key=lambda c: (LEVEL_ORDER[c["level"]], c["rule"], c["msg"]))


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def group(r: Mapping[str, Any]) -> str:
    return GROUP_EXTERNAL if r.get("external") else r["kind"]


def summarize(rows: Sequence[Mapping[str, Any]], excluded: Sequence[Mapping[str, Any]] = ()) -> dict[str, Any]:
    by_kind = Counter(group(r) for r in rows)
    by_status: dict[str, Counter] = defaultdict(Counter)
    rules: dict[str, Counter] = defaultdict(Counter)
    combos = Counter()
    sources = Counter()
    for r in rows:
        by_status[group(r)][r["status"]] += 1
        for c in r["checks"]:
            rules[group(r)][c["rule"]] += 1
        combos[(group(r), "+".join(sorted({s["src"] for s in r["sources"]})), bool(r["game"]))] += 1
        for s in r["sources"]:
            sources[s["src"]] += 1
    return {
        "games": len(rows),
        "byKind": dict(sorted(by_kind.items())),
        "byStatus": {k: dict(sorted(v.items())) for k, v in sorted(by_status.items())},
        "sources": dict(sorted(sources.items())),
        "merged": sum(1 for r in rows if len(r["sources"]) > 1),
        "external": sum(1 for r in rows if r.get("external")),
        "rules": {k: dict(sorted(v.items())) for k, v in sorted(rules.items())},
        "combos": [{"kind": k, "sources": s, "readable": ok, "games": n} for (k, s, ok), n in sorted(combos.items())],
        # 錯誤局 left out of ``games`` (not counted above): rule -> group -> games
        "excluded": {rule: dict(sorted(Counter(group(e) for e in excluded if rule in e["rules"]).items()))
                     for rule in EXCLUDE_RULES},
    }


def write_db(rows: Sequence[Mapping[str, Any]], counts: Mapping[str, Any], path: Path) -> None:
    """One game per line (git diffs stay readable); atomic replace."""
    head = {"format": FORMAT, "version": VERSION, "counts": counts,
            "rules": {k: {"level": v[0], "name": v[1]} for k, v in RULES.items()},
            "sources": SOURCE_LABELS}
    lines = [json.dumps(head, ensure_ascii=False, sort_keys=True, separators=(",", ":"))[:-1] + ',"games":[']
    body = [json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows]
    text = "\n".join(lines + [",\n".join(body), "]}"]) + "\n"
    atomic_write(path, text)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_json(path: Path) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None


def snapshot_texts(snapshot: Any) -> dict[str, str]:
    """流水號 -> 文字記錄 of the 牌譜 snapshot (read only to spot rounds with a 6th proposal; never written out)."""
    if not snapshot or not isinstance(snapshot.get("牌譜"), list) or not snapshot["牌譜"]:
        return {}
    header, *data = snapshot["牌譜"]
    col = {h: i for i, h in enumerate(header)}
    if "流水號" not in col or "文字記錄" not in col:
        return {}
    n = max(col["流水號"], col["文字記錄"])
    return {r[col["流水號"]].strip(): r[col["文字記錄"]] for r in data if len(r) > n and r[col["流水號"]].strip()}


def coverage(rows: Sequence[Mapping[str, Any]], snapshot: Any, sim_bank: Any, records_sheet_ids: set[str],
             dataset_sheet_ids: set[str]) -> dict[str, Any]:
    """How the derived files line up with the database (report only)."""
    out: dict[str, Any] = {}
    if snapshot and isinstance(snapshot.get("牌譜"), list) and snapshot["牌譜"]:
        header, *data = snapshot["牌譜"]
        col = {h: i for i, h in enumerate(header)}
        ids = {r[col["流水號"]].strip() for r in data if len(r) > col["流水號"] and r[col["流水號"]].strip()}
        out["snapshotRows"] = len(ids)
        out["snapshotNotInDataset"] = len(ids - dataset_sheet_ids)
        out["datasetNotInSnapshot"] = len(dataset_sheet_ids - ids)
    out["recordsSheetEntries"] = len(records_sheet_ids)
    out["datasetSheetGamesNotOnRecords"] = len(dataset_sheet_ids - records_sheet_ids)
    if sim_bank and isinstance(sim_bank.get("games"), list):
        fp_to_row = {r["fp"]: r for r in rows if r["fp"] and r["kind"] != KIND_SIM}
        hit = 0
        for g in sim_bank["games"]:
            if gc.record_fingerprint(g.get("cfg", ""), g.get("rec", "")) in fp_to_row:
                hit += 1
        out["simBankGames"] = len(sim_bank["games"])
        out["simBankInDb"] = hit
    return out


def split_games(rows: Sequence[Mapping[str, Any]], excluded: Sequence[Mapping[str, Any]],
                splits: Sequence["gc.PlayerSplit"]) -> dict[str, Any]:
    """player_aliases.json "splits" against the database (no names: rule numbers and game ids only). Every game id
    a rule lists (S<流水號> / D<hash> / a Discord post id) is looked up among the rows' ids and source ids: ``games``
    = the database games the rules name, ``missing`` = ids no row has (typo, or a game that is not in the stats),
    ``excluded`` = ids of 錯誤局 (left out of the database and the stats). Filter rules (from / to / venue) pick
    games by date / 分類 when generate_cache.py runs; they are counted, not resolved here."""
    known: dict[str, str] = {}
    for r in rows:
        known[r["id"]] = r["id"]
        for s in r["sources"]:
            known[s["id"]] = r["id"]
    gone = {sid for e in excluded for sid in [e["id"], *e.get("sources", [])]}
    listed = sorted({gid for rule in splits for gid in rule.games})
    hit = sorted({known[g] for g in listed if g in known})
    return {
        "rules": len(splits),
        "filterRules": sum(1 for rule in splits if rule.has_filter),
        "listed": len(listed),
        "games": hit,
        "missing": [g for g in listed if g not in known and g not in gone],
        "excluded": [g for g in listed if g in gone],
    }


def write_report(rows: Sequence[Mapping[str, Any]], counts: Mapping[str, Any], cov: Mapping[str, Any], path: Path,
                 excluded: Sequence[Mapping[str, Any]] = (), hammer: int = 0,
                 corrections: Sequence[Mapping[str, Any]] = (), proavalon_off: bool = False,
                 collisions: Mapping[str, Any] | None = None, splits: Mapping[str, Any] | None = None) -> None:
    """docs/data/game_db_report.md: counts by rule and the list of games to look at (ids only)."""
    L: list[str] = []
    L.append("# 牌譜總庫：檢查報告")
    L.append("")
    L.append("由 `packages/server/game_db.py` 產生（每天跟著 refresh-analysis-cache 更新），不要手改。總庫本身是 "
             "`packages/server/game_db.json`。只有座位、牌譜、編號與日期，沒有玩家名字與文字。")
    L.append("")
    L.append("## 總數")
    L.append("")
    kind_name = {KIND_REAL: "實戰", KIND_SIM: "模擬", KIND_BOT: "百科AI", GROUP_EXTERNAL: "外部（ProAvalon）"}
    L.append("| 類型 | 局數 | 沒問題 | 只有提醒 | 有錯 | 讀不懂 |")
    L.append("|---|---|---|---|---|---|")
    for k in (KIND_REAL, KIND_BOT, GROUP_EXTERNAL, KIND_SIM):
        st = counts["byStatus"].get(k)
        if not st:
            continue
        total = sum(st.values())
        L.append(f"| {kind_name[k]} | {total} | {st.get('ok', 0)} | {st.get(WARN, 0)} | {st.get(ERROR, 0)} | {st.get('unreadable', 0)} |")
    L.append("")
    L.append(f"多個來源合成一局的：{counts['merged']} 局。")
    L.append("")
    if corrections:
        L.append("## 站長更正")
        L.append("")
        L.append("站長對照原始紀錄（例如手寫紀錄表）確認來源記錯的欄位，寫在 `packages/server/game_db_corrections.json`，"
                 "建庫時先套用再檢查；來源本身不動。")
        L.append("")
        for c in corrections:
            if c.get("missing"):
                L.append(f"- {c['id']}：找不到這一局、或這局讀不懂而更正不是整局紀錄（{c['by']} {c['date']}），更正沒有套用")
            elif c["field"] == "exclude":
                L.append(f"- {c['id']}：錯誤局，不記錄（`{c['new']}`，{c['by']} {c['date']}）")
            else:
                same = "（來源已經是這個值，這筆更正可以刪掉）" if c["old"] == c["new"] else ""
                L.append(f"- {c['id']} `{c['field']}`：{c['old']} → {c['new']}（{c['by']} {c['date']}）{same}")
        L.append("")
    L.append(f"## 錯誤局：不記錄（{len(excluded)}）")
    L.append("")
    L.append("站長 2026-11-17：「尾派沒有出任務 刺客刺到隊友 都屬於錯誤局 不用記錄」。這些局不進總庫（不在 `games`、"
             "上面和下面的數字都不算），來源本身不動。任何一個來源有這種錯就排除；同一局另一個來源沒有這種錯的，另列「來源不一致，已排除」。")
    L.append("")
    has_ext = bool(counts.get("external")) or any(GROUP_EXTERNAL in n for n in counts["excluded"].values())
    L.append("| 規則 | 說明 | 實戰 |" + (" 外部 |" if has_ext else "") + " 模擬 |")
    L.append("|---|---|---|" + ("---|" if has_ext else "") + "---|")
    for rule in EXCLUDE_RULES:
        n = counts["excluded"].get(rule, {})
        ext_cell = f" {n.get(GROUP_EXTERNAL, 0)} |" if has_ext else ""
        L.append(f"| `{rule}` | {RULES[rule][1]} | {n.get(KIND_REAL, 0) + n.get(KIND_BOT, 0)} |{ext_cell} {n.get(KIND_SIM, 0)} |")
    if hammer:
        L.append("")
        L.append(f"另外 ProAvalon 第 5 次提議被否決而輸的 {hammer} 局，匯入時就沒有轉進來（同屬尾派沒有出任務）。")
    if excluded:
        L.append("")
    for title, part in (("", [e for e in excluded if not e["inconsistent"]]), ("來源不一致，已排除", [e for e in excluded if e["inconsistent"]])):
        if not part:
            continue
        if title:
            L.append("")
            L.append(f"{title}（{len(part)}）：")
            L.append("")
        for rule in EXCLUDE_RULES:
            ids = [f"{e['id']}（{e['date'] or '沒有日期'}）" for e in part if rule in e["rules"]]
            if ids:
                L.append(f"- `{rule}`：" + "、".join(ids))
    ext_rows = [r for r in rows if r.get("external")]
    if ext_rows:
        L.append("")
        L.append("## 外部來源：ProAvalon（匿名）")
        L.append("")
        L.append(f"站長 2026-11-17：「10人局配置一模一樣 有湖中的才需要納入分析 其他就不用分析了 先存著牌譜就好」。"
                 f"ProAvalon 匿名匯出（2018–2022）裡 10 人、梅派刺娜德奧、有湖中女神的局轉成總庫格式，共 {len(ext_rows)} 局"
                 "（`packages/server/proavalon_import.py`，id 是 `P` 加 ProAvalon 的 `_id`）。其他局只存在站長的私人 repo，不進這裡。")
        L.append("")
        L.append("- 每局標 `external: true`。**網站統計預設不要算進去**（同一套規則、但不是我們社群的局；ProAvalon 第 5 次提議也要投票）。"
                 "要用的時候明確打開，例如機器人量尺或強者／新手比較想多一批樣本。")
        L.append("- ProAvalon 沒有記湖的宣告（`claim` 是空的）；刺中忠臣時不知道是哪一個（刺殺目標空白）；舊紀錄沒有失敗張數"
                 "（用最少的張數）；部分舊紀錄沒有湖的座位。這些都列在每局的 `SOURCE_NOTE`，不算錯。")
        L.append("- 第 5 次提議被否決而輸的局（我們的規則沒有這種結局）沒有轉進來。")
        st = Counter(r["status"] for r in ext_rows)
        L.append(f"- 檢查結果：沒問題 {st.get('ok', 0)}、只有提醒 {st.get(WARN, 0)}、有錯 {st.get(ERROR, 0)}。")
    elif proavalon_off:
        L.append("")
        L.append("## 外部來源：ProAvalon（停用）")
        L.append("")
        L.append("站長 2026-11-18：「我看ProAvalon 的局基本上很多都在亂玩 其實可以考慮刪掉了」。ProAvalon 的局（`P` 開頭）"
                 "預設不進總庫、不進這份報告，網站上從總庫來的東西（例如 `/更正` 查局）也就沒有這些局。"
                 "原始資料（站長私人 repo）與 `packages/server/proavalon_games.json` 都沒有刪；"
                 "要再用時加 `--with-proavalon` 重建：`python packages/server/game_db.py --with-proavalon`。")
    L.append("")
    real_ok = [r for r in rows if r["kind"] != KIND_SIM and r["game"] and not r.get("external")]
    L.append("## 線上／面對面與陣容強度")
    L.append("")
    L.append("站長 2026-11-17：分類只留「線瓦／面瓦」；「娛樂」「新手局」這類主觀標籤不再當分析篩選，改看成績與當下組成。"
             "總庫的 `venue` 是線瓦／面瓦，`strength` 由陣容強度 S（場上 10 人開局前 PR 的平均）分層："
             "高強度 S ≥ 65、偏強 55–65、一般 38–55、偏弱 < 38（同網站 strength.ts）。試算表舊的「娛樂」只留在 `legacyCategory` 當來源紀錄。")
    L.append("")
    venue_n = Counter(r["venue"] or "（沒記）" for r in real_ok)
    tier_name = {"high": "高強度", "strong": "偏強", "normal": "一般", "weak": "偏弱", "": "（算不出 S）"}
    tier_n = Counter(tier_name[r["strength"]] for r in real_ok)
    L.append("| 線上／面對面 | 局數 |")
    L.append("|---|---|")
    for k, n in venue_n.most_common():
        L.append(f"| {k} | {n} |")
    L.append("")
    L.append("| 陣容強度 | 局數 |")
    L.append("|---|---|")
    for k in ("高強度", "偏強", "一般", "偏弱", "（算不出 S）"):
        if tier_n.get(k):
            L.append(f"| {k} | {tier_n[k]} |")
    L.append("")
    orig = [r for r in real_ok if any(c["rule"] == "VOTE_RESULT" for c in validate(r["game"], infer=False))]
    full = [r for r in orig if not any(c["rule"] == "VOTE_RESULT" for c in r["checks"])]
    part = [r for r in orig if r.get("inferred_votes") and r not in full]
    L.append("## 投票紀錄不完整")
    L.append("")
    L.append(f"出任務的提議贊成不到 6 張、或過半卻沒出任務的實戰局：{len(orig)} 局。站長 2026-11-17 指出常見原因是「順著前一局開藍出去 "
             f"所以下一派 直接全開白」：上一局任務成功、這一局第 1 次提議包含上一局出任務的隊伍、而且紀錄沒寫任何投票記號時，"
             f"推定 10 人全部投白，標成 `inferred_votes: {INFER_ALL_WHITE}`（不是原始紀錄，`INFERRED_VOTES` 一條條列在每局的檢查裡）。")
    L.append("")
    L.append(f"- 這樣推定之後完全對得上：{len(full)} 局")
    L.append(f"- 推定了一部分、還有別的提議對不上：{len(part)} 局")
    L.append(f"- 剩下要站長判斷的：{len(orig) - len(full)} 局（編號在下面「`VOTE_RESULT`」一節）")
    L.append("")
    if collisions is not None:
        L.extend(nc.report_lines(collisions))
    if splits and splits["rules"]:
        L.append("### 已拆開的同名玩家（`player_aliases.json` 的 `splits`）")
        L.append("")
        L.append(f"站長確認是兩個人的名字：{splits['rules']} 條規則（其中 {splits['filterRules']} 條用日期／分類篩選），"
                 f"列出的 {splits['listed']} 個局號對到總庫的 {len(splits['games'])} 局；那些座位在戰績裡算另一位玩家"
                 "（`generate_cache.py` 每晚套用）。")
        if splits["missing"]:
            L.append(f"- 總庫裡找不到的局號（打錯、或不是統計用的局）：{'、'.join(splits['missing'])}")
        if splits["excluded"]:
            L.append(f"- 是錯誤局（不記錄，戰績本來就不算）：{'、'.join(splits['excluded'])}")
        L.append("")
    L.append("## 每個來源進了哪裡")
    L.append("")
    L.append("| 類型 | 來源組合 | 讀得懂 | 局數 |")
    L.append("|---|---|---|---|")
    for c in counts["combos"]:
        names = " ＋ ".join(SOURCE_LABELS[s] for s in c["sources"].split("+"))
        L.append(f"| {kind_name[c['kind']]} | {names} | {'是' if c['readable'] else '否'} | {c['games']} |")
    L.append("")
    if cov:
        L.append("衍生檔案的涵蓋：")
        L.append("")
        if "snapshotRows" in cov:
            L.append(f"- `sheets_cache.json`（牌譜分頁快照）{cov['snapshotRows']} 列有流水號；不在 `games_cache.json` 的 "
                     f"{cov['snapshotNotInDataset']} 列，`games_cache.json` 有而快照沒有的 {cov['datasetNotInSnapshot']} 局。")
        L.append(f"- `records_cache.json` 的試算表牌譜（S 開頭）{cov['recordsSheetEntries']} 筆；`games_cache.json` 的牌譜分頁局"
                 f"沒有在牌譜紀錄頁另列的 {cov['datasetSheetGamesNotOnRecords']} 局（同一局已經是 Discord 貼文，用貼文的編號）。")
        if "simBankGames" in cov:
            L.append(f"- `sim_bank.json`（模擬瓦／Threads 題庫）{cov['simBankGames']} 局，其中 {cov['simBankInDb']} 局對得到總庫。")
        L.append("")
    L.append("## 各規則的局數")
    L.append("")
    L.append("| 規則 | 等級 | 說明 | 實戰 |" + (" 外部 |" if has_ext else "") + " 模擬 |")
    L.append("|---|---|---|---|" + ("---|" if has_ext else "") + "---|")
    level_name = {ERROR: "錯", WARN: "提醒", INFO: "參考"}
    for rule, (level, name) in RULES.items():
        if rule in EXCLUDE_RULES:
            continue  # counted in 錯誤局：不記錄
        real = counts["rules"].get(KIND_REAL, {}).get(rule, 0) + counts["rules"].get(KIND_BOT, {}).get(rule, 0)
        sim = counts["rules"].get(KIND_SIM, {}).get(rule, 0)
        ext = counts["rules"].get(GROUP_EXTERNAL, {}).get(rule, 0)
        ext_cell = f" {ext} |" if has_ext else ""
        L.append(f"| `{rule}` | {level_name[level]} | {name} | {real} |{ext_cell} {sim} |")
    L.append("")
    L.append("（一局可以同時違反好幾條；同一條在一局裡出現幾次就算幾次。）")
    L.append("")
    L.append("## 要人看的局（實戰）")
    L.append("")
    L.append("「錯」與「同一來源登錄兩次／來源不一致／疑似重複」逐局列出；其他提醒只列編號。來源編號：S = 試算表牌譜分頁的流水號、"
             "D = Discord匯入分頁、純數字 = Discord 貼文、M = 模擬瓦分頁。")
    L.append("")
    real_rows = [r for r in rows if r["kind"] != KIND_SIM and r["game"] and not r.get("external")]
    detail_rules = {"DUP_SAME_SOURCE", "CONFLICT", "NEAR_DUP", "SUPERSEDED"}
    for rule, (level, name) in RULES.items():
        hits = [(r, c) for r in real_rows for c in r["checks"] if c["rule"] == rule]
        if not hits or level == INFO:
            continue
        L.append(f"### `{rule}` {name}（{len(hits)}）")
        L.append("")
        if level == ERROR or rule in detail_rules:
            for r, c in hits:
                srcs = "、".join(s["id"] for s in r["sources"] if s["id"] != r["id"])
                L.append(f"- {r['id']}{f'（也是 {srcs}）' if srcs else ''}：{c['msg']}")
        else:
            ids = sorted({r["id"] for r, _ in hits})
            L.append("、".join(ids))
        L.append("")
    dc_only = sorted(r["id"] for r in real_rows if {s["src"] for s in r["sources"]} == {SRC_DISCORD})
    if dc_only:
        L.append(f"## Discord 讀得懂、但還不在統計裡的實戰局（{len(dc_only)}）")
        L.append("")
        L.append("只在 Discord 論壇、還沒進試算表（牌譜或 Discord匯入 分頁），所以網站分析與機器人重播還沒有用到：")
        L.append("")
        L.append("、".join(dc_only))
        L.append("")
    unread = Counter(r.get("problem", "") for r in rows if not r["game"] and r["kind"] != KIND_SIM)
    if unread:
        L.append("## 讀不懂的實戰來源")
        L.append("")
        L.append("| 原因 | 筆數 |")
        L.append("|---|---|")
        for problem, n in unread.most_common():
            L.append(f"| {problem} | {n} |")
        L.append("")
    L.append(PLAN)
    atomic_write(path, "\n".join(L) + "\n")


PLAN = """## 下一步（第 2 步：其他檔案改從總庫產生）

1. **確認規則與清單**：站長看過上面「錯」的局，在來源（試算表或 Discord 貼文）修正；修正後隔天自動重算。
   不能確定的（例如兩個來源不一致、疑似重複）由站長決定哪一筆對。
2. **games_cache.json（網站分析、機器人重播）**：改成「總庫裡讀得懂、沒有錯的實戰局」。先並行產生、逐局比對差異，
   差異都解釋過再切換；Discord 貼文裡讀得懂、但不在試算表的局一併進來（目前只有已匯入 Discord匯入 分頁的才算）。
3. **records_cache.json（牌譜紀錄頁）**：每一筆對應總庫的一局，頁面上顯示檢查結果（例如「這局的投票紀錄不完整」）。
4. **sim_bank.json（模擬瓦、Threads 題庫）**：從總庫挑「沒有錯、有牌譜頁」的實戰局，取代目前從牌譜快照另外建。
5. **機器人重播與量尺**：一律讀總庫的同一批局，報告裡寫總庫版本。
6. **強者的定義**：全站統一用 PR（站長 2026-11-17「強者定義 = PR」）。分析的篩選用陣容強度 S 與 PR，不用「娛樂／新手局」這類主觀分類。
"""


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--games", default=str(HERE / "games_cache.json"))
    ap.add_argument("--records", default=str(HERE / "records_cache.json"))
    ap.add_argument("--snapshot", default=str(HERE / "sheets_cache.json"))
    ap.add_argument("--sim-bank", default=str(HERE / "sim_bank.json"))
    ap.add_argument("--proavalon", default=str(HERE / "proavalon_games.json"), help="read only with --with-proavalon")
    ap.add_argument("--with-proavalon", dest="with_proavalon", action="store_true", default=INCLUDE_PROAVALON,
                    help="put the ProAvalon games (外部, P<_id>) back into the database; off by default since 2026-11-18")
    ap.add_argument("--corrections", default=str(HERE / "game_db_corrections.json"))
    ap.add_argument("--aliases", default=str(HERE / "player_aliases.json"), help="player_aliases.json (its splits)")
    ap.add_argument("--output", default=str(HERE / "game_db.json"))
    ap.add_argument("--check-report", dest="report", default=str(HERE.parent.parent / "docs" / "data" / "game_db_report.md"))
    args = ap.parse_args(argv)

    games_doc = load_json(Path(args.games))
    records_doc = load_json(Path(args.records))
    missing = [name for name, doc in (("games_cache.json", games_doc), ("records_cache.json", records_doc)) if not doc]
    if missing:  # a partial build would silently drop every game of the missing source
        print(f"game_db: {'、'.join(missing)} missing or empty; game_db.json and its report left untouched", file=sys.stderr)
        return 1
    snapshot = load_json(Path(args.snapshot))
    sources = dataset_sources(games_doc, snapshot_texts(snapshot))
    rec_sources, records_sheet_ids = records_sources(records_doc)
    sources += rec_sources
    proavalon_doc = load_json(Path(args.proavalon)) if args.with_proavalon else None
    sources += proavalon_sources(proavalon_doc)
    corrections = apply_corrections(sources, load_json(Path(args.corrections)))
    excluded: list[dict[str, Any]] = []
    rows = build(sources, excluded)
    counts = summarize(rows, excluded)
    dataset_sheet_ids = {s["id"] for s in sources if s["src"] == SRC_SHEET}
    cov = coverage(rows, snapshot, load_json(Path(args.sim_bank)), records_sheet_ids, dataset_sheet_ids)
    hammer = sum(n for why, n in ((proavalon_doc or {}).get("skipped") or {}).items() if "5th proposal" in why)
    write_db(rows, counts, Path(args.output))
    # 同名不同人：候選只寫數量（名字只進私人主控台）；站長已拆開的（player_aliases.json splits）對到總庫的局號
    collisions = nc.counts(nc.candidates(nc.stats_games(games_doc, {"games": rows}, records_doc)))
    try:
        splits = split_games(rows, excluded, gc.load_player_aliases(Path(args.aliases), show_names=False).splits)
    except gc.FatalError as exc:
        print(f"game_db: {exc}", file=sys.stderr)
        splits = None
    if args.report:
        write_report(rows, counts, cov, Path(args.report), excluded, hammer, corrections, proavalon_off=not args.with_proavalon,
                     collisions=collisions, splits=splits)
    print(f"game_db: {counts['games']} games {counts['byKind']}; merged {counts['merged']}; status {counts['byStatus']}; "
          f"excluded {len(excluded)} {counts['excluded']}; name collisions "
          + ", ".join(f"{k} {v['names']}" for k, v in collisions.items())
          + (f"; split rules {splits['rules']} ({len(splits['games'])} games, {len(splits['missing'])} ids not found)"
             if splits and splits["rules"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
