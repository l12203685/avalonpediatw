"""Offline tests for discord_records_import.py and the Discord匯入 union in generate_cache.py.

No network and no Google libraries needed (stdlib unittest; pytest also collects it).
Fixtures use made-up names. Two groups read the checked-in 牌譜 snapshot in
sheets_cache.json (2146 games, 2026-04-03): DerivedColumnsProofTest proves how the
sheet's derived columns follow from 文字記錄, SnapshotCoverageTest measures how many of
those records the strict post parser accepts and that each one dedupes to its 牌譜 row.
WorkflowModeTest runs the workflow's own bash steps (with `date` and `python` stubbed) to check
which switches a scheduled or manual run turns on.

    python packages/server/test_discord_records_import.py
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from collections import Counter
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import discord_records_import as dri  # noqa: E402
import generate_cache as gc  # noqa: E402

SNAPSHOT = Path(__file__).resolve().parent / "sheets_cache.json"
WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "import-discord-records.yml"
FAKE_KEY = {
    "type": "service_account",
    "client_email": "importer@fake-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\nSECRET-MARKER\n-----END PRIVATE KEY-----\n",
}

NAMES = ["小米", "阿豪", "Kai", "Momo", "夜貓", "Pin", "棉花", "Zed", "老王", "菜"]  # seats 1..9, 0
NAMES_B = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]


def footer(config: str = "936758", names: list[str] = NAMES, assassin: str = "刺客刺殺:") -> str:
    lines = ([assassin] if assassin else []) + ([config] if config else [])
    return "\n".join(lines + [f"{s}.{n}" for s, n in zip(gc.SEATS, names)])


# 配置 936758: 刺 9, 娜 3, 德 6, 奧 7, 派 5, 梅 8 (reds 9 3 6 7). Blue wins round 1, 3, 4.
RECENT_RECORD = """147
260
389 +7
469
568
ooo
5680
5678
5680 +7
5689
5680
ooox
0>8 o
1458
oooo
8>4 o
15678 -5 +39
14580
ooooo"""
RECENT_CANONICAL = (
    "147\n260\n389 7+\n469\n568\nooo\n5680\n5678\n5680 7+\n5689\n5680\nooox\n0>8 o\n"
    "1458\noooo\n8>4 o\n15678 5- 39+\n14580\nooooo"
)
RECENT_BODY = RECENT_RECORD + "\n" + footer()

# The same game the 2023 way: mission on the team's line, lake "08O", 配置 as the title.
OLD_RECORD = """147
260
389 7+
469
568 OOO
5680
5678
5680 7+
5689
5680 OOOX
08O
1458 OOOO
84O
15678 5- 39+
14580 OOOOO"""

# 配置 012543: 刺 0, 娜 1, 德 2, 奧 5, 派 4, 梅 3 (reds 0 1 2 5). Red wins rounds 1-3.
RED_BODY = """136
247
358
469
570
oox
1234
2345
3456
4567
5670
ooox
0>3 o
1235
ooox
刺客刺殺：x
012543
""" + "\n".join(f"{s}.{n}" for s, n in zip(gc.SEATS, NAMES_B))

# 936758 again; round 4 "oooox" has ONE fail: still a blue mission (10 players need two).
FOURTH_MISSION_BODY = """147
ooo
5680
ooox
0>8 o
1369
ooxx
8>4 o
15678
oooox
4>1 o
14580
ooooo
""" + footer(assassin="刺客刺殺：５")


def post(title: str = "1009一般場4", tags: tuple[str, ...] = ("三藍被刀", "線瓦"),
         when: dt.datetime = dt.datetime(2026, 10, 9, 22, 0, tzinfo=dri.TAIPEI), offset: int = 0) -> dri.Post:
    return dri.Post(id=str(int(dri.snowflake_at(when)) + offset), title=title, tags=tags)


def skip_reason(p: dri.Post, body: str | None) -> str:
    try:
        dri.parse_post(p, body)
    except dri.SkipPost as exc:
        return exc.reason
    return "parsed"


# A 牌譜-like header (the snapshot's own header when available).
def sheet_header() -> list[str]:
    if SNAPSHOT.exists():
        return list(json.loads(SNAPSHOT.read_text(encoding="utf-8"))["牌譜"][0])
    return ["流水號", "文字記錄", "配置", "刺殺", "分類", "日期時間", "場次", "頁碼", "note",
            *(gc.PLAYER_COLUMNS[s] for s in gc.SEATS), "結果", *dri.ROUND_RESULT_COLUMNS,
            *dri.ROUND_COLUMNS, "組成", "強人", "戳人", "局勢", *dri.LAKE_COLUMNS,
            *dri.LAKE_PLAYER_COLUMNS, *dri.ROLE_SEAT_COLUMNS, "1-1", "派5", "派0", "外灑"]


def sheet_row(header: list[str], gid: str, config: str, text: str, names: list[str], outcome: str = "") -> list[str]:
    cells = {"流水號": gid, "配置": config, "文字記錄": text, "結果": outcome,
             **{gc.PLAYER_COLUMNS[s]: n for s, n in zip(gc.SEATS, names)}}
    cells.update(dri.derive_columns(text, config, dict(zip(gc.SEATS, names))))
    return [cells.get(h, "") for h in header]


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

class ParserTest(unittest.TestCase):
    def test_recent_format_full_row(self) -> None:
        p = post()
        game = dri.parse_post(p, RECENT_BODY)
        self.assertEqual(game.text(), RECENT_CANONICAL)
        self.assertEqual((game.config, game.outcome, game.kill), ("936758", "三藍死", "8"))  # Merlin = seat 8
        self.assertEqual((game.date, game.game_no, game.category, game.date_from_title), ("2026/10/09", "4", "線瓦", True))
        header = dri.import_header([sheet_header()], None)
        row = dict(zip(header, dri.build_row(p, game, header, "2026-10-10 03:17:00", dri.post_signature(p, RECENT_BODY))))
        expected = {
            "流水號": f"D{p.id}", "文字記錄": RECENT_CANONICAL, "配置": "936758", "刺殺": "8", "分類": "線瓦",
            "日期時間": "2026/10/09", "場次": "4", "頁碼": "", "note": "", "結果": "三藍死",
            **{gc.PLAYER_COLUMNS[s]: n for s, n in zip(gc.SEATS, NAMES)},
            "第一局成功失敗": "ooo", "第二局成功失敗": "ooox", "第三局成功失敗": "oooo", "第四局成功失敗": "ooooo",
            "第五局成功失敗": "", "第一局": "藍", "第二局": "紅", "第三局": "藍", "第四局": "藍", "第五局": "",
            "組成": "小米, 阿豪, KAI, MOMO, 夜貓, PIN, 棉花, ZED, 老王, 菜", "強人": "", "戳人": "",
            "局勢": "藍紅藍藍", "首湖": "0>8", "二湖": "8>4", "三湖": "",
            "首湖玩家": "忠", "二湖玩家": "梅", "三湖玩家": "忠", "角1": "忠", "角4": "忠", "角5": "派", "角0": "忠",
            "1-1": "147", "派5": "N", "派0": "N", "外灑": "N",
            "discord_post_id": p.id, "discord_title": "1009一般場4", "discord_tags": "三藍被刀、線瓦",
            "匯入時間": "2026-10-10 03:17:00", "discord_hash": dri.post_signature(p, RECENT_BODY), "更新時間": "",
        }
        self.assertEqual(row, expected)
        self.assertEqual(header[-6:], list(dri.EXTRA_COLUMNS))
        self.assertRegex(row["discord_hash"], r"^[0-9a-f]{16}$")

    def test_old_2023_inline_style(self) -> None:
        old = post(title="936758", tags=("三藍被刀",), when=dt.datetime(2023, 8, 12, 21, tzinfo=dri.TAIPEI))
        self.assertEqual(skip_reason(old, OLD_RECORD), dri.SKIP_NAMES_MISSING)  # everything else was fine
        game = dri.parse_post(old, OLD_RECORD + "\n" + footer(config="", assassin=""))  # 配置 from the title
        self.assertEqual(game.text(), RECENT_CANONICAL)  # inline missions and "08O" lakes normalized
        self.assertEqual((game.config, game.outcome, game.kill), ("936758", "三藍死", "8"))
        self.assertEqual((game.date, game.game_no, game.date_from_title), ("2023/08/12", "", False))
        self.assertEqual(gc.record_fingerprint("936758", game.text()), gc.record_fingerprint("936758", RECENT_CANONICAL))
        self.assertEqual(skip_reason(dri.Post(old.id, "936750", old.tags), OLD_RECORD + "\n" + footer(assassin="")),
                         dri.SKIP_CONFIG_CONFLICT)  # title 配置 differs from the body's

    def test_full_width_colon_digits_and_fourth_mission_rule(self) -> None:
        game = dri.parse_post(post(tags=("三藍躲刺",)), FOURTH_MISSION_BODY)
        self.assertEqual([r.mission for r in game.rounds], ["ooo", "ooox", "ooxx", "oooox", "ooooo"])
        self.assertEqual((game.outcome, game.kill), ("三藍活", "5"))  # "刺客刺殺：５" -> seat 5, not Merlin
        cols = dri.derive_columns(game.text(), game.config, game.names)
        self.assertEqual((cols["第四局"], cols["局勢"]), ("藍", "藍紅紅藍藍"))
        self.assertEqual(skip_reason(post(tags=("三紅",)), FOURTH_MISSION_BODY), dri.SKIP_RESULT_MISMATCH)
        self.assertEqual(skip_reason(post(tags=()), FOURTH_MISSION_BODY), "parsed")  # target given: 三藍活

    def test_red_game_with_x_assassination(self) -> None:
        game = dri.parse_post(post(tags=("三紅", "面瓦")), RED_BODY)
        self.assertEqual((game.config, game.outcome, game.kill, game.category), ("012543", "三紅", "", "面瓦"))
        self.assertEqual(game.names["0"], "癸")
        self.assertEqual(skip_reason(post(tags=("三藍被刀",)), RED_BODY), dri.SKIP_RESULT_MISMATCH)
        self.assertEqual(skip_reason(post(tags=()), RED_BODY), "parsed")  # 3 red missions need no tag

    def test_mixed_anomaly_styles(self) -> None:
        body = RECENT_BODY.replace("469\n", "469 57-6+\n").replace("5678\n", "5678 5-1467+\n") \
            .replace("5689\n", "5689 3+46-\n").replace("1458\n", "1458 +7-5\n")
        game = dri.parse_post(post(), body)
        props = [p.render() for r in game.rounds for p in r.proposals]
        self.assertIn("469 57-6+", props)
        self.assertIn("5678 5-1467+", props)
        self.assertIn("5689 3+46-", props)
        self.assertIn("1458 7+5-", props)
        self.assertIn("15678 5- 39+", props)
        self.assertEqual(gc.record_fingerprint(game.config, game.text()),
                         gc.record_fingerprint("936758", RECENT_CANONICAL))  # votes are not in the fingerprint
        glued = dri.parse_post(post(), RECENT_BODY.replace("389 +7", "389+7").replace("15678 -5 +39", "15678-5 +39"))
        self.assertEqual(glued.text(), RECENT_CANONICAL)
        self.assertEqual(skip_reason(post(), RECENT_BODY.replace("389 +7", "3897+")), dri.SKIP_UNRECOGNIZED)  # ambiguous
        self.assertEqual(skip_reason(post(), RECENT_BODY.replace("389 +7", "389 7")), dri.SKIP_BAD_VOTE)
        self.assertEqual(skip_reason(post(), RECENT_BODY.replace("389 +7", "389 +7-")), dri.SKIP_BAD_VOTE)

    def test_commentary_markdown_and_title_echo_are_ignored(self) -> None:
        body = "1009一般場4\n好局！\n```\n" + RECENT_RECORD + "\n```\n**刺客刺殺：**\n936758\n" + \
            "\n".join(f"{s}. {n}" for s, n in zip(gc.SEATS, NAMES)) + "\nMVP：夜貓"
        game = dri.parse_post(post(), body)
        self.assertEqual(game.text(), RECENT_CANONICAL)
        self.assertEqual(list(game.names.values()), NAMES)
        self.assertEqual(skip_reason(post(), "ooox 刺殺失敗\n" + RECENT_BODY), dri.SKIP_UNRECOGNIZED)  # game-like text

    def test_names_missing_or_malformed(self) -> None:
        nine = RECENT_RECORD + "\n" + footer().rsplit("\n", 1)[0]
        cases = {
            RECENT_RECORD + "\n刺客刺殺:\n936758": dri.SKIP_NAMES_MISSING,
            nine: dri.SKIP_NAMES_MISSING,
            RECENT_BODY.replace("5.夜貓", "5."): dri.SKIP_NAMES_MISSING,
            RECENT_BODY.replace("5.夜貓", "4.夜貓"): dri.SKIP_NAMES_MALFORMED,
            RECENT_BODY.replace("5.夜貓", "5.小米"): dri.SKIP_NAMES_MALFORMED,
            RECENT_BODY.replace("1.小米\n2.阿豪", "1.小米 2.阿豪"): dri.SKIP_NAMES_MALFORMED,
        }
        for body, reason in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(skip_reason(post(), body), reason)
        game = dri.parse_post(post(), RECENT_BODY.replace("0.菜", "10.菜").replace("1.小米", "１．小米"))
        self.assertEqual((game.names["0"], game.names["1"]), ("菜", "小米"))

    def test_result_and_assassination_consistency(self) -> None:
        cases = [
            (("三紅",), RECENT_BODY, dri.SKIP_RESULT_MISMATCH),
            (("三藍躲刺",), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:8"), dri.SKIP_ASSASSIN_MISMATCH),
            (("三藍被刀",), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:5"), dri.SKIP_ASSASSIN_MISMATCH),
            (("三藍被刀",), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:x"), dri.SKIP_ASSASSIN_MISMATCH),
            (("三藍被刀", "三藍躲刺"), RECENT_BODY, dri.SKIP_RESULT_TAGS),
            ((), RECENT_BODY, dri.SKIP_NO_RESULT),
            ((), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:\n8"), "parsed"),
            (("三藍被刀",), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺: 梅林?"), dri.SKIP_BAD_ASSASSIN),
        ]
        for tags, body, reason in cases:
            with self.subTest(tags=tags, reason=reason):
                self.assertEqual(skip_reason(post(tags=tags), body), reason)
        game = dri.parse_post(post(tags=()), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:\n8"))
        self.assertEqual((game.outcome, game.kill), ("三藍死", "8"))
        game = dri.parse_post(post(tags=("三藍躲刺",)), RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:10號"))
        self.assertEqual((game.outcome, game.kill), ("三藍活", "0"))

    def test_structure_checks(self) -> None:
        cases = {
            dri.SKIP_UNRECOGNIZED: RECENT_BODY.replace("1458\n", "第三輪\n1458\n"),
            dri.SKIP_TEAM_SIZE: RECENT_BODY.replace("147\n", "1478\n"),
            dri.SKIP_DUP_SEAT: RECENT_BODY.replace("147\n", "144\n"),
            dri.SKIP_TOO_MANY_PROPOSALS: RECENT_BODY.replace("147\n", "147\n123\n"),
            dri.SKIP_MISSION_SIZE: RECENT_BODY.replace("oooo\n8>4", "ooo\n8>4"),
            dri.SKIP_FAILS_GT_RED: RECENT_BODY.replace("5680\nooox", "5680\nooxx"),  # one red on the team
            dri.SKIP_UNDECIDED: RECENT_BODY.replace("15678 -5 +39\n14580\nooooo\n", ""),
            dri.SKIP_ROUNDS_LT3: RECENT_BODY.replace("1458\noooo\n8>4 o\n15678 -5 +39\n14580\nooooo\n", ""),
            dri.SKIP_AFTER_DECIDED: RECENT_BODY.replace("ooooo\n", "ooooo\n14580\nooooo\n"),
            dri.SKIP_TRAILING_PROPOSAL: RECENT_BODY.replace("ooooo\n", "ooooo\n14580\n"),
            dri.SKIP_MISSION_NO_TEAM: RECENT_BODY.replace("ooo\n5680", "ooo\noooo\n5680"),
            dri.SKIP_BAD_LAKE: RECENT_BODY.replace("8>4 o", "5>4 o"),
            dri.SKIP_NO_CONFIG: RECENT_BODY.replace("936758\n", ""),
            dri.SKIP_CONFIG_CONFLICT: RECENT_BODY.replace("936758\n", "936758\n936750\n"),
            dri.SKIP_BAD_CONFIG: RECENT_BODY.replace("936758\n", "936798\n"),
            dri.SKIP_NO_RECORD: footer(),
        }
        for reason, body in cases.items():
            with self.subTest(reason=reason):
                self.assertEqual(skip_reason(post(), body), reason)
        lake_cases = ["0>0 o", "0>8 o\n0>8 o"]  # same seat; two lakes after one round
        for lake in lake_cases:
            with self.subTest(lake=lake):
                self.assertEqual(skip_reason(post(), RECENT_BODY.replace("0>8 o", lake)), dri.SKIP_BAD_LAKE)
        self.assertEqual(skip_reason(post(), RECENT_BODY.replace("0>8 o\n1458", "1458\n0>8 o")), dri.SKIP_BAD_LAKE)

    def test_empty_missing_and_simulation(self) -> None:
        self.assertEqual(skip_reason(post(), None), dri.SKIP_NO_STARTER)
        self.assertEqual(skip_reason(post(), "  \n"), dri.SKIP_EMPTY)
        self.assertEqual(skip_reason(post(tags=("模擬", "三藍被刀")), RECENT_BODY), dri.SKIP_SIMULATION)

    def test_no_record_lines_is_a_record_post_only_when_something_says_so(self) -> None:
        chat = "今天那局大家覺得怎麼樣？\n我覺得第三輪的湖很關鍵。"
        self.assertEqual(skip_reason(post(title="覆盤", tags=()), chat), dri.SKIP_NOT_A_RECORD)  # a discussion
        self.assertEqual(skip_reason(post(title="公告", tags=("線瓦",)), chat), dri.SKIP_NOT_A_RECORD)  # a notice
        self.assertEqual(skip_reason(post(title="覆盤", tags=()), chat + "\n刺客刺殺:"), dri.SKIP_NOT_A_RECORD)
        self.assertEqual(skip_reason(post(title="覆盤", tags=("三紅",)), chat), dri.SKIP_NO_RECORD)  # a result tag
        self.assertEqual(skip_reason(post(title="936758", tags=()), chat), dri.SKIP_NO_RECORD)  # a 配置 as the title
        self.assertEqual(skip_reason(post(title="覆盤", tags=()), chat + "\n９３６７５８"), dri.SKIP_NO_RECORD)  # ... in the body
        self.assertEqual(skip_reason(post(title="覆盤", tags=()), footer()), dri.SKIP_NO_RECORD)  # the footer alone
        self.assertEqual(skip_reason(post(title="覆盤", tags=()), "0>8 o"), dri.SKIP_NOT_A_RECORD)  # a lake line alone
        self.assertEqual(skip_reason(post(title="覆盤", tags=("三紅",)), "0>8 o"), dri.SKIP_NO_RECORD)
        self.assertIn(dri.SKIP_NOT_A_RECORD, dri.REPLY_NOT_FOR)
        self.assertNotIn(dri.SKIP_NO_RECORD, dri.REPLY_NOT_FOR)


# ---------------------------------------------------------------------------
# Which line a skip points at (for the Discord reply)
# ---------------------------------------------------------------------------

def locate(body: str | None, tags: tuple[str, ...] = ("三藍被刀",), title: str = "1009一般場4") -> tuple:
    try:
        dri.parse_post(post(title=title, tags=tags), body)
    except dri.SkipPost as exc:
        return exc.reason, exc.line_no, exc.line_text
    return "parsed", None, None


class LineLocationTest(unittest.TestCase):
    """RECENT_BODY: lines 1-19 the record (3 = "389 +7", 6 = "ooo", 12 = "ooox", 13 = "0>8 o", 14 = "1458",
    15 = "oooo", 16 = "8>4 o", 19 = "ooooo"), 20 = "刺客刺殺:", 21 = "936758", 22-31 = "1.小米" .. "0.菜"."""

    def test_line_is_named_when_one_line_is_wrong(self) -> None:
        cases = [
            (RECENT_BODY.replace("389 +7", "389 7"), dri.SKIP_BAD_VOTE, 3, "389 7"),
            (RECENT_BODY.replace("1458\n", "第三輪\n1458\n"), dri.SKIP_UNRECOGNIZED, 14, "第三輪"),
            ("ooox 刺殺失敗\n" + RECENT_BODY, dri.SKIP_UNRECOGNIZED, 1, "ooox 刺殺失敗"),
            (RECENT_BODY.replace("147\n", "1478\n"), dri.SKIP_TEAM_SIZE, 1, "1478"),
            (RECENT_BODY.replace("147\n", "144\n"), dri.SKIP_DUP_SEAT, 1, "144"),
            (RECENT_BODY.replace("147\n", "147\n123\n"), dri.SKIP_TOO_MANY_PROPOSALS, 6, "568"),  # the 6th proposal
            (RECENT_BODY.replace("oooo\n8>4", "ooo\n8>4"), dri.SKIP_MISSION_SIZE, 15, "ooo"),
            (RECENT_BODY.replace("ooo\n5680", "ooo\noooo\n5680"), dri.SKIP_MISSION_NO_TEAM, 7, "oooo"),
            (RECENT_BODY.replace("ooooo\n", "ooooo\n14580\n"), dri.SKIP_TRAILING_PROPOSAL, 20, "14580"),
            (RECENT_BODY.replace("ooooo\n", "ooooo\n14580\nooooo\n"), dri.SKIP_AFTER_DECIDED, 20, "14580"),
            (RECENT_BODY.replace("8>4 o", "5>4 o"), dri.SKIP_BAD_LAKE, 16, "5>4 o"),
            (RECENT_BODY.replace("0>8 o\n1458", "1458\n0>8 o"), dri.SKIP_BAD_LAKE, 14, "0>8 o"),
            (RECENT_BODY.replace("5680\nooox", "5680\nooxx"), dri.SKIP_FAILS_GT_RED, 12, "ooxx"),
            (RECENT_BODY.replace("936758\n", "936758\n936750\n"), dri.SKIP_CONFIG_CONFLICT, 22, "936750"),
            (RECENT_BODY.replace("936758\n", "936798\n"), dri.SKIP_BAD_CONFIG, 21, "936798"),
            (RECENT_BODY.replace("刺客刺殺:", "刺客刺殺: 梅林?"), dri.SKIP_BAD_ASSASSIN, 20, "刺客刺殺: 梅林?"),
            (RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:5\n刺客刺殺:x"), dri.SKIP_BAD_ASSASSIN, 21, "刺客刺殺:x"),
            (RECENT_BODY.replace("5.夜貓", "4.夜貓"), dri.SKIP_NAMES_MALFORMED, 26, "4.夜貓"),
            (RECENT_BODY.replace("5.夜貓", "5.小米"), dri.SKIP_NAMES_MALFORMED, 26, "5.小米"),
            (RECENT_BODY.replace("5.夜貓", "5. "), dri.SKIP_NAMES_MISSING, 26, "5. "),
            (RECENT_BODY.replace("1.小米\n2.阿豪", "1.小米 2.阿豪"), dri.SKIP_NAMES_MALFORMED, 22, "1.小米 2.阿豪"),
            # A record line left after the names: that line is named, not the (correct) 刺客刺殺 line.
            (RECENT_BODY + "\nooooo", dri.SKIP_UNRECOGNIZED, 32, "ooooo"),
            (RECENT_BODY + "\n8>4 o", dri.SKIP_UNRECOGNIZED, 32, "8>4 o"),
            (RECENT_BODY + "\n14580", dri.SKIP_UNRECOGNIZED, 32, "14580"),
            (RECENT_BODY + "\nMVP：夜貓\nooooo", dri.SKIP_UNRECOGNIZED, 33, "ooooo"),
            (RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:\n8") + "\nooooo", dri.SKIP_UNRECOGNIZED, 33, "ooooo"),  # not the "8"
            (RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:\n8") + "\n8>4 o\nooooo", dri.SKIP_UNRECOGNIZED, 33, "8>4 o"),
        ]
        for body, reason, line_no, text in cases:
            with self.subTest(reason=reason, line=line_no):
                self.assertEqual(locate(body), (reason, line_no, text))
        # The tag decides, the 刺客刺殺 line is where to fix it (two-line form: the first of the two).
        self.assertEqual(locate(RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:8"), tags=("三藍躲刺",)),
                         (dri.SKIP_ASSASSIN_MISMATCH, 20, "刺客刺殺:8"))
        self.assertEqual(locate(RECENT_BODY.replace("刺客刺殺:", "刺客刺殺:\n8"), tags=("三藍躲刺",)),
                         (dri.SKIP_ASSASSIN_MISMATCH, 20, "刺客刺殺:"))
        self.assertEqual(locate(OLD_RECORD + "\n" + footer(assassin=""), title="936750"),
                         (dri.SKIP_CONFIG_CONFLICT, 16, "936758"))  # body 配置 (line 16) disagrees with the title

    def test_no_line_when_the_reason_is_not_one_line(self) -> None:
        cases = [
            (RECENT_BODY, ("三紅",), dri.SKIP_RESULT_MISMATCH),
            (RECENT_BODY, ("三藍被刀", "三藍躲刺"), dri.SKIP_RESULT_TAGS),
            (RECENT_BODY, (), dri.SKIP_NO_RESULT),
            (RECENT_BODY.replace("936758\n", ""), ("三藍被刀",), dri.SKIP_NO_CONFIG),
            (RECENT_BODY.replace("15678 -5 +39\n14580\nooooo\n", ""), ("三藍被刀",), dri.SKIP_UNDECIDED),
            (RECENT_BODY.replace("1458\noooo\n8>4 o\n15678 -5 +39\n14580\nooooo\n", ""), ("三藍被刀",), dri.SKIP_ROUNDS_LT3),
            (RECENT_RECORD + "\n刺客刺殺:\n936758", ("三藍被刀",), dri.SKIP_NAMES_MISSING),
            (footer(), ("三藍被刀",), dri.SKIP_NO_RECORD),
            ("今天那局大家覺得怎麼樣？", (), dri.SKIP_NOT_A_RECORD),
            (None, ("三藍被刀",), dri.SKIP_NO_STARTER),
            ("  \n", ("三藍被刀",), dri.SKIP_EMPTY),
            (RECENT_BODY, ("模擬",), dri.SKIP_SIMULATION),
        ]
        for body, tags, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(locate(body, tags=tags), (reason, None, None))

    def test_every_reason_has_an_explanation(self) -> None:
        reasons = {v for k, v in vars(dri).items() if k.startswith("SKIP_") and isinstance(v, str)}
        self.assertEqual(reasons, set(dri.SKIP_EXPLANATIONS))
        self.assertTrue(all(dri.SKIP_EXPLANATIONS.values()))
        self.assertTrue(dri.REPLY_NOT_FOR <= reasons)

    def test_reply_text(self) -> None:
        skip = dri.SkippedPost(post(), dri.SKIP_BAD_VOTE, 3, "  389  *7*\t")
        text = dri.reply_text(skip)
        lines = text.split("\n")
        self.assertEqual(lines[0], dri.REPLY_MARKER)
        self.assertEqual(lines[1], dri.REPLY_INTRO)
        self.assertEqual(lines[2], "第 3 行「389 \\*7\\*」：" + dri.SKIP_EXPLANATIONS[dri.SKIP_BAD_VOTE])  # markdown escaped
        self.assertIn("\n" + dri.FORMAT_HINT + "\n", text)
        self.assertTrue(text.endswith(dri.REPLY_FOOTER))
        self.assertLess(len(text), 2000)  # Discord's message limit
        self.assertNotIn("@", text)
        no_line = dri.reply_text(dri.SkippedPost(post(), dri.SKIP_NAMES_MISSING))
        self.assertIn("\n原因：" + dri.SKIP_EXPLANATIONS[dri.SKIP_NAMES_MISSING] + "\n", no_line)
        long = dri.reply_text(dri.SkippedPost(post(), dri.SKIP_UNRECOGNIZED, 9, "x" * 200))
        self.assertIn("「" + "x" * (dri.REPLY_LINE_MAX - 1) + "…」", long)
        self.assertLess(len(long), 2000)

    def test_title_dates(self) -> None:
        when = dt.datetime(2026, 10, 9, 23, 30, tzinfo=dri.TAIPEI)
        self.assertEqual(dri.title_date("1009一般場4", when), ("2026/10/09", "4", True))
        self.assertEqual(dri.title_date("1009 S2例行賽 第12場", when), ("2026/10/09", "12", True))
        self.assertEqual(dri.title_date("1231一般場2", dt.datetime(2027, 1, 1, 1, tzinfo=dri.TAIPEI)),
                         ("2026/12/31", "2", True))  # posted after new year
        self.assertEqual(dri.title_date("780912", when), ("2026/10/09", "", False))  # a 配置, not a date
        self.assertEqual(dri.title_date("0230一般場", when), ("2026/10/09", "", False))  # no such day
        self.assertEqual(dri.title_date("覆盤", when), ("2026/10/09", "", False))
        # Taipei, not UTC: 2026-10-09 23:30 +08 is 15:30 UTC the same day; 00:30 +08 is the day before in UTC.
        self.assertEqual(post(when=dt.datetime(2026, 10, 10, 0, 30, tzinfo=dri.TAIPEI)).created.date(), dt.date(2026, 10, 10))

    def test_canonical_text_round_trips_through_derive_columns(self) -> None:
        for title, tags, body in (("1009一般場4", ("三藍被刀",), RECENT_BODY), ("1009", ("三紅",), RED_BODY),
                                  ("1009", ("三藍躲刺",), FOURTH_MISSION_BODY)):
            game = dri.parse_post(post(title=title, tags=tags), body)
            cols = dri.derive_columns(game.text(), game.config, game.names)
            self.assertEqual([cols[c] for c in dri.ROUND_RESULT_COLUMNS if cols[c]], [r.mission for r in game.rounds])
            self.assertEqual([cols[c] for c in dri.LAKE_COLUMNS if cols[c]],
                             [f"{u.lake.holder}>{u.lake.target}" for u in game.lakes])
            self.assertEqual(cols["1-1"], game.rounds[0].proposals[0].team)
            self.assertEqual(dri.outcome_from_record([cols[c] for c in dri.ROUND_RESULT_COLUMNS], game.kill, game.config),
                             game.outcome)
            reparsed = gc.parse_game_log([sheet_header(), sheet_row(sheet_header(), "D1", game.config, game.text(),
                                                                    list(game.names.values()), game.outcome)])[0]
            self.assertEqual(len(reparsed.missions), len(game.rounds))


# ---------------------------------------------------------------------------
# Proof: the sheet's derived columns are a function of 文字記錄 (+ 配置, 玩1..玩0)
# ---------------------------------------------------------------------------

def load_snapshot() -> list[list[str]]:
    if not SNAPSHOT.exists():
        raise unittest.SkipTest("sheets_cache.json not found")
    rows = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("牌譜") or []
    if len(gc.parse_game_log(rows)) != 2146:
        raise unittest.SkipTest("sheets_cache.json is not the 2146-game snapshot")
    return rows


def snapshot_games(rows: list[list[str]]) -> list[dict[str, str]]:
    header = rows[0]
    return [dict(zip(header, r)) for r in rows[1:] if r[0].strip() and len(r[2].strip()) == 6]


class DerivedColumnsProofTest(unittest.TestCase):
    """For every one of the 2146 snapshot games: column == derive_columns(文字記録, 配置, 玩*).

    Result: all 22 derived columns agree on 2144 rows (99.91%). The other two, 2044 and 2045,
    agree too once their role columns are computed from the 配置 their formulas actually point
    at (2044: an empty cell, 2045: the 配置 of row 2044) -- a sheet artifact, not a rule.
    The rules include the sheet's quirks: a mission line with trailing blanks is not read
    (row 75, "oooxx "), lake cells keep the line up to its first space ("6>1x", "4>"), the
    next holder is the last character of that cell, nothing stops at a footer-like line
    (row 1257 "2.24680 13579+"). 組成 is compared where the sheet filled it (not in the
    newest rows, one #REF!).

    結果 is typed by hand: it equals outcome_from_record(missions, 刺殺, 配置) on 2128 rows;
    15 records stop before either side has 3 missions, and 3 三藍死 rows have no 刺殺.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.games = snapshot_games(load_snapshot())

    def derive(self, g: dict[str, str], config: str | None = None) -> dict[str, str]:
        return dri.derive_columns(g["文字記錄"], g["配置"] if config is None else config,
                                  {s: g[gc.PLAYER_COLUMNS[s]] for s in gc.SEATS})

    def test_every_derived_column(self) -> None:
        self.assertEqual(len(self.games), 2146)
        mismatched: dict[str, list[str]] = {}
        compared = Counter()
        for g in self.games:
            cols = self.derive(g)
            for c in dri.DERIVED_COLUMNS:
                if c == "組成" and g[c] in ("", "#REF!"):
                    continue
                compared[c] += 1
                if cols[c] != g[c]:
                    mismatched.setdefault(g["流水號"], []).append(c)
        self.assertEqual(sorted(mismatched), ["2044", "2045"], mismatched)
        self.assertEqual(sorted(set(mismatched["2044"]) | set(mismatched["2045"])),
                         sorted(["首湖玩家", "二湖玩家", "三湖玩家", "角4", "角0"]))
        self.assertEqual(compared["1-1"], 2146)
        self.assertEqual(compared["組成"], 2146 - 130 - 1)  # 130 blank (the newest rows) + 1 #REF!
        by_id = {g["流水號"]: g for g in self.games}
        for gid, config in (("2044", ""), ("2045", by_id["2044"]["配置"])):
            cols = self.derive(by_id[gid], config)
            self.assertEqual([c for c in dri.DERIVED_COLUMNS if c != "組成" and cols[c] != by_id[gid][c]], [], gid)

    def test_quirks_are_the_sheets(self) -> None:
        by_id = {g["流水號"]: g for g in self.games}
        self.assertIn("oooxx \n", by_id["75"]["文字記錄"])
        self.assertEqual(by_id["75"]["第四局成功失敗"], "ooooo")  # the sheet skipped "oooxx "
        self.assertEqual((by_id["5"]["三湖"], by_id["384"]["三湖"]), ("6>1x", "4>"))
        self.assertEqual(self.derive(by_id["1257"])["第四局成功失敗"], "ooooo")
        self.assertEqual(dri.derive_columns("147\nooo\n0>8 o\n1456\nooox\n8>4 x", "936758", {})["首湖"], "0>8")

    def test_result_rule(self) -> None:
        wrong = Counter()
        for g in self.games:
            derived = dri.outcome_from_record([g[c] for c in dri.ROUND_RESULT_COLUMNS], g["刺殺"], g["配置"])
            if derived != g["結果"]:
                incomplete = derived == ""
                no_kill = g["結果"] == "三藍死" and not g["刺殺"].strip()
                wrong["record incomplete" if incomplete else "三藍死 without 刺殺" if no_kill else "other"] += 1
        self.assertEqual(dict(wrong), {"record incomplete": 15, "三藍死 without 刺殺": 3})

    def test_import_header_is_the_sheet_header_plus_extras(self) -> None:
        header = dri.import_header([list(load_snapshot()[0])], None)
        self.assertEqual(header, [h.strip() for h in load_snapshot()[0]] + list(dri.EXTRA_COLUMNS))
        self.assertTrue(set(dri.DERIVED_COLUMNS) <= set(header))


# ---------------------------------------------------------------------------
# Coverage: snapshot records as Discord posts
# ---------------------------------------------------------------------------

REVERSE_RESULT_TAGS = {v: k for k, v in dri.RESULT_TAGS.items()}


def snapshot_posts(games: list[dict[str, str]]) -> tuple[list[dri.Post], dict[str, str]]:
    """Each snapshot game as a recent-format post (its 文字記錄 + 刺客刺殺 / 配置 / name footer)."""
    base = int(dri.snowflake_at(dt.datetime(2025, 1, 1, 12, tzinfo=dri.TAIPEI)))
    posts, bodies = [], {}
    for i, g in enumerate(games):
        text = g["文字記錄"]
        if "刺客刺殺" not in text:  # 2109 already carries a pasted Discord footer
            names = [g[gc.PLAYER_COLUMNS[s]] or f"無名{s}" for s in gc.SEATS]
            text += "\n刺客刺殺:\n" + g["配置"].strip() + "\n" + "\n".join(f"{s}.{n}" for s, n in zip(gc.SEATS, names))
        p = dri.Post(id=str(base + i), title="0101一般場1", tags=(REVERSE_RESULT_TAGS[g["結果"]], g["分類"]))
        posts.append(p)
        bodies[p.id] = text
    return posts, bodies


class SnapshotCoverageTest(unittest.TestCase):
    """2064 of the 2146 snapshot records (96.2%) pass the strict parser when posted in the
    recent format; the rest are genuine problems in those records (a fail on a team without
    red players, 6+ proposals in a round, wrong team sizes, broken lake chains, typos like
    "190.4+", one player in two seats). Every accepted one has the fingerprint of its 牌譜
    row, so plan_import reports it as already in 牌譜 and imports none of them."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = load_snapshot()
        cls.games = snapshot_games(cls.rows)
        cls.posts, cls.bodies = snapshot_posts(cls.games)

    def test_parse_coverage_and_reasons(self) -> None:
        outcomes = Counter(skip_reason(p, self.bodies[p.id]) for p in self.posts)
        self.assertEqual(outcomes["parsed"], 2064, outcomes)
        self.assertEqual(outcomes, Counter({
            "parsed": 2064,
            dri.SKIP_FAILS_GT_RED: 15,
            dri.SKIP_TOO_MANY_PROPOSALS: 14,
            dri.SKIP_TEAM_SIZE: 11,
            dri.SKIP_UNDECIDED: 9,
            dri.SKIP_BAD_LAKE: 8,
            dri.SKIP_UNRECOGNIZED: 8,
            dri.SKIP_DUP_SEAT: 5,
            dri.SKIP_NAMES_MALFORMED: 5,
            dri.SKIP_BAD_VOTE: 3,
            dri.SKIP_MISSION_SIZE: 2,
            dri.SKIP_AFTER_DECIDED: 1,
            dri.SKIP_ROUNDS_LT3: 1,
        }))

    def test_every_parsed_copy_is_recognized_as_already_in_the_sheet(self) -> None:
        header = dri.import_header(self.rows, None)
        report = dri.plan_import(self.posts, lambda p: self.bodies[p.id], self.rows, None, header)
        self.assertEqual(report.parsed, 2064)
        self.assertEqual(report.in_sheet, 2064)
        self.assertEqual(report.rows, [])


# ---------------------------------------------------------------------------
# Fingerprints, dedupe and idempotency
# ---------------------------------------------------------------------------

class DedupeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.header_sheet = sheet_header()
        self.header = dri.import_header([self.header_sheet], None)

    def sheet(self, *rows: list[str]) -> list[list[str]]:
        return [self.header_sheet, *rows]

    def run_plan(self, posts, bodies, sheet_rows, import_rows=None, **kw) -> dri.ImportReport:
        self.fetched: list[str] = []

        def fetch(p):
            self.fetched.append(p.id)
            return bodies[p.id]
        return dri.plan_import(posts, fetch, sheet_rows, import_rows, self.header, **kw)

    def test_fingerprint_normalization(self) -> None:
        sheet_style = RECENT_CANONICAL.replace("\n", "\r\n").replace("0>8 o", "0>8").replace("5680 7+", "0865 7+")
        self.assertEqual(gc.record_fingerprint("936758 ", sheet_style + "\r\n"), gc.record_fingerprint("936758", RECENT_CANONICAL))
        self.assertEqual(gc.record_fingerprint("936758", RECENT_CANONICAL.replace("ooox", "xooo")),
                         gc.record_fingerprint("936758", RECENT_CANONICAL))
        self.assertNotEqual(gc.record_fingerprint("936758", RECENT_CANONICAL.replace("1458", "1459")),
                            gc.record_fingerprint("936758", RECENT_CANONICAL))
        self.assertNotEqual(gc.record_fingerprint("936759", RECENT_CANONICAL), gc.record_fingerprint("936758", RECENT_CANONICAL))
        with_footer = RECENT_CANONICAL + "\n刺客刺殺：x\n936758\n1.小米"
        self.assertEqual(gc.record_fingerprint("936758", with_footer), gc.record_fingerprint("936758", RECENT_CANONICAL))

    def test_classification(self) -> None:
        p_same, p_edited, p_cfg = (post(offset=i) for i in range(3))
        p_new, p_twice = post(tags=("三紅",), offset=3), post(tags=("三紅",), offset=5)
        p_recorded = post(tags=("三藍躲刺", "已收錄"), offset=4)
        edited = RECENT_CANONICAL.replace("260", "250")  # a proposal retyped in the 牌譜 copy
        sheet_rows = self.sheet(
            sheet_row(self.header_sheet, "1", "936758", RECENT_CANONICAL.replace("\n", "\r\n"), NAMES, "三藍死"),
        )
        bodies = {
            p_same.id: RECENT_BODY,
            p_new.id: RED_BODY,
            p_recorded.id: FOURTH_MISSION_BODY.replace("刺客刺殺：５", "刺客刺殺：5"),
            p_twice.id: RED_BODY,
        }
        posts = [p_same, p_new, p_recorded, p_twice]
        report = self.run_plan(posts, bodies, sheet_rows)
        self.assertEqual((report.seen, report.parsed, report.in_sheet), (4, 4, 1))
        self.assertEqual((report.recorded_unmatched, report.dup_run, report.new), (1, 1, 1))
        self.assertEqual(len(report.rows), 1)
        self.assertEqual(report.new_unknown_names, 10)  # NAMES_B are not in the sheet
        # A name that differs from one in a tab only by case / width is no new player.
        recased = self.sheet(sheet_row(self.header_sheet, "9", "012543", "123\no",
                                       ["KAI", "ｍｏｍｏ", " pin ", "zed", *NAMES_B[:6]], "三紅"))
        imported_rows = [self.header, [""] * len(self.header)]
        imported_rows[1][self.header.index("流水號")] = "D1"
        imported_rows[1][self.header.index("玩1")] = " 阿豪 "
        report = self.run_plan([p_same], {p_same.id: RECENT_BODY}, recased, imported_rows)
        self.assertEqual(len(report.rows), 1)
        self.assertEqual(report.new_unknown_names, 5)  # of NAMES, 5 are in a tab: 4 of them spelled otherwise

        near = self.sheet(sheet_row(self.header_sheet, "1", "936758", edited, NAMES, "三藍死"))
        report = self.run_plan([p_edited], {p_edited.id: RECENT_BODY}, near)
        self.assertEqual((report.in_sheet, report.near_dup_sheet, report.new), (0, 1, 0))
        retyped_cfg = self.sheet(sheet_row(self.header_sheet, "1", "936750", edited, NAMES, "三藍死"))
        report = self.run_plan([p_cfg], {p_cfg.id: RECENT_BODY}, retyped_cfg)
        self.assertEqual(report.near_dup_sheet, 1)  # same players, same seats, same missions
        other_players = self.sheet(sheet_row(self.header_sheet, "1", "936758", edited, NAMES_B, "三藍死"))
        report = self.run_plan([p_cfg], {p_cfg.id: RECENT_BODY}, other_players)
        self.assertEqual(report.new, 1)  # same 配置 + missions but a different table: a different game

    def test_idempotent_and_limit_and_since(self) -> None:
        posts = [post(offset=0), post(title="1009一般場5", tags=("三紅",), offset=1),
                 post(title="0101舊局", tags=("三紅",), when=dt.datetime(2026, 1, 1, 20, tzinfo=dri.TAIPEI))]
        bodies = {posts[0].id: RECENT_BODY, posts[1].id: RED_BODY, posts[2].id: RED_BODY.replace("1235\nooox", "1250\nooox")}
        first = self.run_plan(posts, bodies, self.sheet(), since=dt.date(2026, 6, 1), limit=1)
        self.assertEqual((first.before_since, first.parsed, len(first.rows), first.held_by_limit), (1, 2, 1, 1))
        self.assertEqual(first.rows[0][self.header.index("流水號")], f"D{posts[0].id}")
        import_rows = [self.header, *first.rows]
        second = self.run_plan(posts, bodies, self.sheet(), import_rows, since=dt.date(2026, 6, 1))
        self.assertEqual((second.already_imported, len(second.rows)), (1, 1))
        self.assertNotIn(posts[0].id, self.fetched)  # imported posts are not fetched again
        import_rows += second.rows
        third = self.run_plan(posts, bodies, self.sheet(), import_rows)
        self.assertEqual((third.already_imported, third.new, third.parsed), (2, 1, 1))  # the old post now
        fourth = self.run_plan(posts, bodies, self.sheet(), import_rows + third.rows)
        self.assertEqual((fourth.already_imported, fourth.new, self.fetched), (3, 0, []))
        # A second post of an already imported game:
        again = post(offset=7)
        fifth = self.run_plan([again], {again.id: RECENT_BODY}, self.sheet(), import_rows)
        self.assertEqual((fifth.dup_imported, fifth.new), (1, 0))

    def test_internal_errors_are_contained(self) -> None:
        with mock.patch.object(dri, "parse_post", side_effect=KeyError("小米")):
            report = self.run_plan([post()], {post().id: RECENT_BODY}, self.sheet())
        self.assertEqual(report.skipped, Counter({dri.SKIP_INTERNAL: 1}))


# ---------------------------------------------------------------------------
# Corrections to posts already in Discord匯入 (plan_recheck)
# ---------------------------------------------------------------------------

IMPORTED_AT = "2026-10-10 03:17:00"
LATER = dt.datetime(2026, 12, 1, 3, 17, tzinfo=dri.TAIPEI)  # a month and a half after the post
STAMP = "2026-12-01 03:17:00"
FIXED_BODY = RECENT_BODY.replace("4.Momo", "4.Mona")  # a wrong player id corrected on the post
COMMENTED_BODY = "好局！\n" + RECENT_BODY  # an edit that does not change the game


def utc(*args: int) -> dt.datetime:
    return dt.datetime(*args, tzinfo=dt.timezone.utc)


class RecheckTest(unittest.TestCase):
    def setUp(self) -> None:
        self.header = dri.import_header([sheet_header()], None)  # a tab created now: has discord_hash / 更新時間
        self.post = post()

    def imported(self, p: dri.Post, body: str, header: list[str] | None = None) -> list[str]:
        header = header or self.header
        return dri.build_row(p, dri.parse_post(p, body), header, IMPORTED_AT, dri.post_signature(p, body))

    def recheck(self, posts, bodies, import_rows, header=None, edits=None, now=LATER, report=None, **kw):
        self.read: list[str] = []
        edits = edits or {}

        def fetch(p):
            self.read.append(p.id)
            body = bodies[p.id]
            return None if body is None else dri.StarterMessage(body, edits.get(p.id))
        self.report = report or dri.ImportReport(ok_ids={p.id for p in posts})
        return dri.plan_recheck(posts, fetch, import_rows, header or self.header, self.report, now=now, stamp=STAMP, **kw)

    def cell(self, row: list[str], name: str, header: list[str] | None = None) -> str:
        return row[(header or self.header).index(name)]

    def test_a_corrected_player_is_rewritten_in_place(self) -> None:
        rows = [self.header, self.imported(self.post, RECENT_BODY)]
        rows[1][self.header.index("note")] = "人工備註"  # a cell a person added: kept
        result = self.recheck([self.post], {self.post.id: FIXED_BODY}, rows, edits={self.post.id: utc(2026, 11, 20)})
        self.assertEqual((result.candidates, result.checked, result.corrected, result.rows_updated), (1, 1, 1, 1))
        [update] = result.updates
        self.assertEqual(update.row, 2)
        self.assertEqual(len(update.values), len(self.header))
        self.assertEqual(self.cell(update.values, "玩4"), "Mona")
        self.assertIn("MONA", self.cell(update.values, "組成"))
        self.assertEqual(self.cell(update.values, "匯入時間"), IMPORTED_AT)  # when it was first imported
        self.assertEqual(self.cell(update.values, "更新時間"), STAMP)
        self.assertEqual(self.cell(update.values, "discord_hash"), dri.post_signature(self.post, FIXED_BODY))
        self.assertEqual(self.cell(update.values, "note"), "人工備註")
        self.assertEqual(self.cell(update.values, "流水號"), f"D{self.post.id}")
        changed = {h for h, a, b in zip(self.header, rows[1], update.values) if a != b}
        self.assertEqual(changed, {"玩4", "組成", "discord_hash", "更新時間"})
        self.assertEqual({self.header[i] for i in update.cols}, changed)  # only these cells are written
        self.assertEqual((update.key_col, update.key), (self.header.index("discord_post_id"), self.post.id))

        rows[1] = update.values  # the next day: nothing to do
        again = self.recheck([self.post], {self.post.id: FIXED_BODY}, rows, edits={self.post.id: utc(2026, 11, 20)})
        self.assertEqual((again.unchanged, again.corrected, again.updates), (1, 0, []))

    def test_unedited_and_comment_only_edits(self) -> None:
        rows = [self.header, self.imported(self.post, RECENT_BODY)]
        result = self.recheck([self.post], {self.post.id: RECENT_BODY}, rows)
        self.assertEqual((result.checked, result.unchanged, result.updates), (1, 1, []))
        edits = {self.post.id: utc(2026, 11, 2)}
        result = self.recheck([self.post], {self.post.id: COMMENTED_BODY}, rows, edits=edits)
        self.assertEqual((result.edited_same, result.corrected, result.rows_updated), (1, 0, 0))
        [update] = result.updates  # the game is the same: only the new discord_hash, nothing else
        self.assertEqual([self.header[i] for i in update.cols], ["discord_hash"])
        self.assertEqual(self.cell(update.values, "discord_hash"), dri.post_signature(self.post, COMMENTED_BODY))
        self.assertEqual(self.cell(update.values, "更新時間"), "")
        rows[1] = update.values  # the next day: not re-parsed or counted as an edit again
        again = self.recheck([self.post], {self.post.id: COMMENTED_BODY}, rows, edits=edits)
        self.assertEqual((again.unchanged, again.edited_same, again.updates), (1, 0, []))

    def test_title_and_result_tag_edits_count(self) -> None:
        rows = [self.header, self.imported(self.post, RECENT_BODY)]
        retitled = dri.Post(self.post.id, "1008一般場4", self.post.tags)  # the date in the title was wrong
        result = self.recheck([retitled], {self.post.id: RECENT_BODY}, rows)
        self.assertEqual(result.corrected, 1)
        self.assertEqual(self.cell(result.updates[0].values, "日期時間"), "2026/10/08")
        bot_tag = dri.Post(self.post.id, self.post.title, (*self.post.tags, dri.TAG_FIX))  # not a tag that matters
        self.assertEqual(self.recheck([bot_tag], {self.post.id: RECENT_BODY}, rows).unchanged, 1)

    def test_rows_written_before_the_hash_column(self) -> None:
        legacy = [h for h in self.header if h not in dri.LATE_COLUMNS]
        rows = [legacy, self.imported(self.post, RECENT_BODY, legacy)]
        header = legacy + list(dri.LATE_COLUMNS)  # what run() passes: the columns are added on the first write
        bodies = {self.post.id: FIXED_BODY}
        before_import = self.recheck([self.post], bodies, rows, header, edits={self.post.id: utc(2026, 10, 9, 15)})
        self.assertEqual((before_import.unchanged, before_import.updates), (1, []))  # edited before it was imported
        self.assertEqual(self.read, [self.post.id])
        never = self.recheck([self.post], bodies, rows, header)
        self.assertEqual(never.unchanged, 1)  # Discord says it was never edited
        after = self.recheck([self.post], bodies, rows, header, edits={self.post.id: utc(2026, 11, 20)})
        self.assertEqual(after.corrected, 1)
        values = after.updates[0].values
        self.assertEqual(len(values), len(header))
        self.assertEqual((self.cell(values, "玩4", header), self.cell(values, "更新時間", header)), ("Mona", STAMP))
        self.assertEqual(self.cell(values, "discord_hash", header), dri.post_signature(self.post, FIXED_BODY))
        rows[1] = values[:]
        rows[0] = header
        # Edited again later: the new 更新時間 is the reference now.
        self.assertEqual(self.recheck([self.post], bodies, rows, header, edits={self.post.id: utc(2026, 11, 30)}).unchanged, 1)

        # A comment added to a legacy row's post: the hash is written (in the new column) once.
        rows = [legacy, self.imported(self.post, RECENT_BODY, legacy)]
        edits = {self.post.id: utc(2026, 11, 20)}
        commented = self.recheck([self.post], {self.post.id: COMMENTED_BODY}, rows, header, edits=edits)
        self.assertEqual(commented.edited_same, 1)
        [update] = commented.updates
        self.assertEqual([header[i] for i in update.cols], ["discord_hash"])
        rows = [header, update.values]
        self.assertEqual(self.recheck([self.post], {self.post.id: COMMENTED_BODY}, rows, header, edits=edits).unchanged, 1)

    def test_unreadable_edits_keep_the_row_and_become_fixable(self) -> None:
        rows = [self.header, self.imported(self.post, RECENT_BODY)]
        broken = RECENT_BODY.replace("389 +7", "389 7")
        result = self.recheck([self.post], {self.post.id: broken}, rows, edits={self.post.id: utc(2026, 11, 20)},
                              now=dt.datetime(2026, 10, 12, 3, 17, tzinfo=dri.TAIPEI))
        self.assertEqual((result.unreadable, result.updates), (1, []))
        [skip] = self.report.skips
        self.assertTrue(skip.edited)
        self.assertEqual((skip.reason, skip.line_no), (dri.SKIP_BAD_VOTE, 3))
        self.assertNotIn(self.post.id, self.report.ok_ids)
        self.assertEqual(sum(self.report.skipped.values()), 0)  # not an import skip in the summary table
        self.assertTrue(dri.fixable(skip))
        text = dri.reply_text(skip)
        self.assertIn(dri.REPLY_INTRO_EDITED, text)
        self.assertNotIn(dri.REPLY_INTRO, text)
        self.assertEqual(len(dri.reply_candidates(self.report, dt.datetime(2026, 10, 12, 3, 17, tzinfo=dri.TAIPEI), 14)), 1)

    def test_left_alone(self) -> None:
        recorded = post(title="1009一般場5", tags=("三紅", dri.TAG_RECORDED), offset=1)
        simulated = post(title="1009一般場6", tags=("三紅", dri.TAG_SIMULATION), offset=2)
        deleted, emptied = post(offset=3), post(offset=4)
        old = post(when=dt.datetime(2026, 8, 1, 20, tzinfo=dri.TAIPEI))  # more than 90 days before LATER
        not_imported = post(offset=5)
        posts = [recorded, simulated, deleted, emptied, old, not_imported]
        def as_imported(p: dri.Post) -> dri.Post:  # the tags it had when it was imported
            return dri.Post(p.id, p.title, tuple(t for t in p.tags if t not in (dri.TAG_RECORDED, dri.TAG_SIMULATION)))
        rows = [self.header] + [self.imported(as_imported(p), RED_BODY if "三紅" in p.tags else RECENT_BODY)
                                for p in (recorded, simulated, deleted, emptied, old)]
        bodies = {p.id: FIXED_BODY for p in posts}
        bodies.update({deleted.id: None, emptied.id: "  "})
        result = self.recheck(posts, bodies, rows, edits={p.id: utc(2026, 11, 20) for p in posts})
        self.assertEqual((result.recorded, result.simulation, result.candidates, result.gone), (1, 1, 2, 2))
        self.assertEqual(sorted(self.read), sorted([deleted.id, emptied.id]))  # 已收錄 / 模擬 / old: never read
        self.assertEqual(result.updates, [])
        self.assertEqual(self.recheck(posts, bodies, rows, days=0).checked, 0)
        self.assertEqual(self.recheck(posts, bodies, rows, limit=0).checked, 0)
        self.assertEqual(self.recheck(posts, bodies, [self.header]).candidates, 0)
        self.assertEqual(self.recheck(posts, bodies, rows, since=dt.date(2026, 10, 10)).candidates, 0)

    def test_a_game_copied_into_the_sheet_since_is_left_to_people(self) -> None:
        rows = [self.header, self.imported(self.post, RECENT_BODY)]
        sheet_rows = [sheet_header(), sheet_row(sheet_header(), "1", "936758", RECENT_CANONICAL, NAMES, "三藍死")]
        result = self.recheck([self.post], {self.post.id: FIXED_BODY}, rows, edits={self.post.id: utc(2026, 11, 20)},
                              sheet_rows=sheet_rows)
        self.assertEqual((result.in_sheet, result.candidates, result.updates, self.read), (1, 0, [], []))

    def test_window_and_switches(self) -> None:
        self.assertEqual(dri.RECHECK_DEFAULT_DAYS, dri.TAG_DEFAULT_DAYS)  # the same 90 days as the 待修正 tag
        args = dri.parse_args([])
        self.assertEqual((args.recheck_days, args.recheck_limit), (90, 200))
        args = dri.parse_args(["--recheck-days", "0", "--recheck-limit", "5"])
        self.assertEqual((args.recheck_days, args.recheck_limit), (0, 5))
        self.assertEqual([dri.column_letters(n) for n in (1, 26, 27, 52, 53, 702, 703)],
                         ["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"])
        self.assertEqual(dri.discord_time("2026-11-20T08:00:00.123000+00:00"), dt.datetime(2026, 11, 20, 8, 0, 0, 123000, tzinfo=dt.timezone.utc))
        self.assertIsNone(dri.discord_time(None))
        self.assertIsNone(dri.discord_time("not a time"))

    def test_limit_newest_every_run_the_rest_take_turns(self) -> None:
        posts = [post(offset=i) for i in range(6)]
        newest = posts[-1]
        rows = [self.header] + [self.imported(p, RECENT_BODY) for p in posts]
        bodies = {p.id: RECENT_BODY for p in posts}
        self.recheck(posts, bodies, rows)
        self.assertEqual(self.read, [p.id for p in reversed(posts)])  # under the limit: all, newest first
        seen: set[str] = set()
        for day in range(3):
            result = self.recheck(posts, bodies, rows, limit=4, now=LATER + dt.timedelta(days=day))
            self.assertEqual((result.candidates, result.checked, result.held), (6, 4, 2))
            self.assertEqual(self.read[:2], [newest.id, posts[-2].id])  # the newest half: every run
            seen.update(self.read)
        self.assertEqual(seen, {p.id for p in posts})  # the other 4 in turns, 2 a run: within 2 runs
        self.assertEqual(len(dri.recheck_order(posts, 1, LATER.date())), 1)

    def test_a_discord_error_stops_the_pass_but_keeps_what_was_planned(self) -> None:
        older, newer = post(offset=0), post(offset=1)
        rows = [self.header, self.imported(older, RECENT_BODY), self.imported(newer, RECENT_BODY)]

        def fetch(p):
            if p.id == older.id:
                raise dri.DiscordError("GET /channels/{thread}/messages/{thread}: HTTP 503", "GET thread 503")
            return dri.StarterMessage(FIXED_BODY, utc(2026, 11, 20))
        report = dri.ImportReport(ok_ids={older.id, newer.id})
        result = dri.plan_recheck([older, newer], fetch, rows, self.header, report, now=LATER, stamp=STAMP)
        self.assertEqual((result.checked, result.corrected, result.error), (1, 1, "GET thread 503"))
        self.assertEqual([u.row for u in result.updates], [3])  # the newer post, read before the error
        text = "\n".join(dri.recheck_lines(result, write=True))
        self.assertIn("重讀途中 Discord API 錯誤（GET thread 503）", text)

    def test_summary_lines_are_counts_only(self) -> None:
        rows = [self.header, self.imported(self.post, RECENT_BODY)]
        result = self.recheck([self.post], {self.post.id: FIXED_BODY}, rows, edits={self.post.id: utc(2026, 11, 20)})
        for write, done in ((True, "有修改、已更新：1 篇（1 列）"), (False, "有修改、dry run，會更新：1 篇（1 列）")):
            text = "\n".join(dri.recheck_lines(result, write=write))
            self.assertIn("90 天內發的重新檢查修改：1 篇，本次重讀 1", text)
            self.assertIn(done, text)
            for secret in NAMES + ["Mona", "1009一般場", self.post.id]:
                self.assertNotIn(secret, text)


# ---------------------------------------------------------------------------
# generate_cache: 牌譜 + Discord匯入
# ---------------------------------------------------------------------------

class GenerateCacheUnionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.rows = load_snapshot()
        cls.header = dri.import_header(cls.rows, None)
        games = snapshot_games(cls.rows)
        copy = next(g for g in games if g["流水號"] == "2146")  # the last 牌譜 game, posted again
        cls.copy_game = copy
        p_copy, p_new, p_red = post(offset=1), post(offset=2), post(title="1009一般場5", tags=("三紅",), offset=3)
        copy_body = copy["文字記錄"] + "\n刺客刺殺:\n" + copy["配置"] + "\n" + \
            "\n".join(f"{s}.{copy[gc.PLAYER_COLUMNS[s]]}" for s in gc.SEATS)
        posts = [dri.Post(p_copy.id, p_copy.title, ("三紅",)), p_new, p_red]
        bodies = {posts[0].id: copy_body, p_new.id: RECENT_BODY, p_red.id: RED_BODY}
        # Plan against an empty 牌譜 so the copy becomes an import row too (as if 牌譜 got it later).
        report = dri.plan_import(posts, lambda p: bodies[p.id], [cls.rows[0]], None, cls.header)
        assert len(report.rows) == 3, report
        cls.import_rows = [cls.header, *report.rows]

    def build(self, games: list[gc.GameRow]) -> dict:
        cache, _ = gc.assemble_cache(gc.build_cache(games, {}), None, strength_builder=lambda players: {"perPlayer": {}},
                                     placeholder_builders={})
        return cache

    def test_merge_dedupes_against_the_sheet(self) -> None:
        merged = gc.merge_game_logs(self.rows, self.import_rows)
        self.assertEqual((merged.main_games, merged.extra_games, merged.extra_added, merged.extra_duplicates), (2146, 3, 2, 1))
        self.assertEqual([g.id for g in merged.games[-2:]], [r[0] for r in self.import_rows[2:]])
        self.assertIn("+ 2 from Discord匯入 (1 more were games already counted, skipped)", merged.summary())
        self.assertEqual(len(gc.merge_game_logs(self.rows, None).games), 2146)
        self.assertEqual(len(gc.merge_game_logs(self.rows, [self.header]).games), 2146)
        doubled = gc.merge_game_logs(self.rows, self.import_rows + [["D9"] + r[1:] for r in self.import_rows[2:]])
        self.assertEqual((doubled.extra_added, doubled.extra_duplicates), (2, 3))  # same game under another 流水號

    def test_union_passes_the_guards_and_only_adds(self) -> None:
        old = self.build(gc.parse_game_log(self.rows))
        new = self.build(gc.merge_game_logs(self.rows, self.import_rows).games)
        self.assertEqual(gc.validate_new_cache(new, old), [])
        self.assertEqual(new["overview"]["totalGames"], old["overview"]["totalGames"] + 2)
        before = {p["name"]: p["totalGames"] for p in old["players"]["players"]}
        after = {p["name"]: p["totalGames"] for p in new["players"]["players"]}
        gained = {n: after[n] - before.get(n, 0.0) for n in after if after[n] != before.get(n)}
        self.assertEqual(gained, {n: 1.0 for n in NAMES + NAMES_B})  # the copied game counts once
        self.assertTrue(all(after[n] >= g for n, g in before.items()))

    def test_end_to_end_reads_the_optional_tab(self) -> None:
        chem = [["", "A"], ["A", ""]]
        tabs = {"牌譜": self.rows, "Discord匯入": self.import_rows,
                **{t: chem for t in ("同贏", "同輸", "贏相關", "同贏-同輸")}}
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, quiet_env(**{gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY)}), \
                mock.patch.object(gc, "open_spreadsheet", lambda source, sheet_id: FakeSheet(tabs)), \
                mock.patch.object(gc, "gspread", mock.Mock(exceptions=mock.Mock(WorksheetNotFound=WorksheetNotFound))), \
                mock.patch.object(gc, "default_strength_builder", lambda: (lambda players: {"perPlayer": {}})), \
                mock.patch.object(gc, "default_placeholder_builders", lambda: {}), \
                redirect_stdout(out), redirect_stderr(out):
            path = Path(tmp) / "analysis_cache.json"
            self.assertEqual(gc.main(["--output", str(path)]), 0, out.getvalue())
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["overview"]["totalGames"], 2148)
            del tabs["Discord匯入"]  # tab removed again -> fewer games: the guard refuses
            self.assertEqual(gc.main(["--output", str(path)]), gc.EXIT_DATA)
        self.assertIn("2146 from 牌譜 + 2 from Discord匯入 (1 more were games already counted, skipped)", out.getvalue())


# ---------------------------------------------------------------------------
# Discord client (fake transport)
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, payload, headers=None):
        self.body = json.dumps(payload).encode()
        self.headers = headers or {}

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def http_error(code: int, payload: dict | None = None) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://discord.com/api", code, "err", {}, io.BytesIO(json.dumps(payload or {}).encode()))


class DiscordClientTest(unittest.TestCase):
    def make(self, script):
        self.calls: list[str] = []
        self.requests: list[tuple[str, str, bytes | None, str | None]] = []  # method, path, body, content type
        self.sleeps: list[float] = []

        def opener(request, timeout):
            self.calls.append(request.full_url.replace(dri.DISCORD_API, ""))
            self.requests.append((request.get_method(), self.calls[-1], request.data, request.get_header("Content-type")))
            self.assertEqual(request.get_header("Authorization"), "Bot TOKEN")
            result = script(self.calls[-1], len(self.calls))
            if isinstance(result, Exception):
                raise result
            return result
        return dri.DiscordClient("TOKEN", opener=opener, sleep=self.sleeps.append, pace=0)

    def test_reply_calls_me_pages_messages_and_posts_without_mentions(self) -> None:
        first_page = [{"id": str(1000 - i), "author": {"id": "U1"}, "content": "chat"} for i in range(dri.MESSAGES_PAGE)]

        def script(path, n):
            if path == "/users/@me":
                return FakeResponse({"id": "BOT1", "username": "avalon", "bot": True})
            if path == f"/channels/777/messages?limit={dri.MESSAGES_PAGE}":
                return FakeResponse(first_page)
            if path == f"/channels/777/messages?limit={dri.MESSAGES_PAGE}&before=901":
                return FakeResponse([{"id": "5", "author": {"id": "BOT1"}, "content": dri.REPLY_MARKER + "\n..."}])
            if path == f"/channels/888/messages?limit={dri.MESSAGES_PAGE}":
                return FakeResponse([{"id": "9", "author": {"id": "BOT1"}, "content": "another bot message"},
                                     {"id": "8", "author": {"id": "U2"}, "content": dri.REPLY_MARKER + " (quoted by a human)"}])
            if path == "/channels/888/messages":
                return FakeResponse({"id": "new"})
            raise AssertionError(path)

        client = self.make(script)
        self.assertEqual(client.bot_user_id(), "BOT1")
        self.assertTrue(client.has_bot_message("777", "BOT1", dri.REPLY_MARKER))  # found on the second page
        self.assertEqual(self.calls[1:3], [f"/channels/777/messages?limit={dri.MESSAGES_PAGE}",
                                           f"/channels/777/messages?limit={dri.MESSAGES_PAGE}&before=901"])
        self.assertFalse(client.has_bot_message("888", "BOT1", dri.REPLY_MARKER))  # neither the bot's nor the marker
        client.post_message("888", "第 3 行「389 7」")
        method, path, body, ctype = self.requests[-1]
        self.assertEqual((method, path, ctype), ("POST", "/channels/888/messages", "application/json"))
        self.assertEqual(json.loads(body), {"content": "第 3 行「389 7」", "allowed_mentions": {"parse": []},
                                            "flags": 4, "nonce": "888", "enforce_nonce": True})  # no link previews
        self.assertTrue(all(m == "GET" for m, _, _, _ in self.requests[:-1]))

    def test_post_is_sent_once_after_a_server_error_or_timeout(self) -> None:
        failures = [http_error(502), http_error(504, {"code": 0}), TimeoutError(), urllib.error.URLError("timed out"),
                    ConnectionResetError()]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__):
                client = self.make(lambda path, n, f=failure: f)
                with self.assertRaises(dri.DiscordError) as ctx:
                    client.post_message("888", "第 3 行「389 7」")
                self.assertEqual([m for m, _, _, _ in self.requests], ["POST"])  # exactly one request
                self.assertEqual(self.sleeps, [])
                self.assertIn("POST /channels/{thread}/messages", str(ctx.exception))
                self.assertNotIn("888", str(ctx.exception))
                self.assertNotIn("389", str(ctx.exception))
        # 429: Discord did not process it, so the same message goes again (with the nonce that makes
        # a second copy impossible should the first one have been stored after all).
        client = self.make(lambda path, n: http_error(429, {"retry_after": 0.5}) if n == 1 else FakeResponse({"id": "new"}))
        client.post_message("888", "第 3 行「389 7」")
        self.assertEqual([m for m, _, _, _ in self.requests], ["POST", "POST"])
        self.assertEqual(self.requests[0][2], self.requests[1][2])
        self.assertEqual(json.loads(self.requests[1][2])["nonce"], "888")
        self.assertIs(json.loads(self.requests[1][2])["enforce_nonce"], True)
        # A GET is still retried after a 502 or a timeout.
        client = self.make(lambda path, n: http_error(502) if n == 1 else FakeResponse({"content": "147"}))
        self.assertEqual(client.starter_content("123"), "147")
        self.assertEqual(len(self.requests), 2)
        client = self.make(lambda path, n: TimeoutError() if n == 1 else FakeResponse({"content": "147"}))
        self.assertEqual(client.starter_content("123"), "147")
        self.assertEqual(len(self.requests), 2)

        # Through reply_to_failures with the real client: one POST, counted as an error, no second message.
        def script(path, n):
            if path == "/users/@me":
                return FakeResponse({"id": "BOT1"})
            if path.startswith("/channels/888/messages?"):
                return FakeResponse([])
            if path == "/channels/888/messages":
                return http_error(502)
            raise AssertionError(path)
        client = self.make(script)
        skip = dri.SkippedPost(dri.Post("888", "1009一般場4", ()), dri.SKIP_BAD_VOTE, 3, "389 7")
        report = dri.reply_to_failures(client, [skip], limit=10, dry_run=False)
        self.assertEqual((report.replied, report.errors), (0, 1))
        self.assertEqual([m for m, _, _, _ in self.requests].count("POST"), 1)

    def test_403_on_post_is_forbidden_with_the_posting_permission_named(self) -> None:
        client = self.make(lambda path, n: http_error(403, {"code": 50001}))
        with self.assertRaises(dri.DiscordForbidden) as ctx:
            client.post_message("424242", "x")
        self.assertIn("POST /channels/{thread}/messages: HTTP 403", str(ctx.exception))
        self.assertIn("Send Messages in Threads", str(ctx.exception))
        self.assertNotIn("424242", str(ctx.exception))
        self.assertIsInstance(ctx.exception, dri.DiscordError)
        with self.assertRaises(dri.DiscordForbidden):  # reading the thread can be forbidden too
            client.has_bot_message("1", "BOT1", dri.REPLY_MARKER)
        client = self.make(lambda path, n: FakeResponse({"username": "no id"}))
        with self.assertRaises(dri.DiscordError):
            client.bot_user_id()

    def test_lists_active_and_archived_posts_with_tags(self) -> None:
        forum = dri.FORUM_CHANNEL_ID
        tags = [{"id": "t1", "name": "已收錄"}, {"id": "t2", "name": "三紅"}, {"id": "t3", "name": "線瓦"}]

        def script(path, n):
            if path == f"/channels/{forum}":
                return FakeResponse({"guild_id": dri.GUILD_ID, "available_tags": tags})
            if path.endswith("/threads/active"):
                return FakeResponse({"threads": [{"id": "300", "name": "c", "parent_id": forum, "applied_tags": ["t2"]},
                                                 {"id": "999", "name": "other", "parent_id": "elsewhere"}]})
            if "archived" in path and "before" not in path:
                return FakeResponse({"has_more": True, "threads": [
                    {"id": "200", "name": "b", "applied_tags": ["t1", "t3"], "thread_metadata": {"archive_timestamp": "2026-01-02T03:04:05.000000+00:00"}}]})
            if "archived" in path:
                self.assertIn("before=2026-01-02T03%3A04%3A05.000000%2B00%3A00", path)
                return FakeResponse({"has_more": False, "threads": [
                    {"id": "100", "name": "a", "applied_tags": ["gone"], "thread_metadata": {"archive_timestamp": "x"}}]})
            raise AssertionError(path)

        posts, missing = self.make(script).forum_posts(forum)
        self.assertEqual([(p.id, p.title, p.tags) for p in posts],
                         [("100", "a", ()), ("200", "b", ("已收錄", "線瓦")), ("300", "c", ("三紅",))])
        self.assertEqual(missing, ["模擬", "三藍被刀", "三藍躲刺", "面瓦"])

    def test_fix_list_calls(self) -> None:
        forum = dri.FORUM_CHANNEL_ID
        full_page = [{"id": str(500 - i), "author": {"id": "U1"}, "content": "已修正"} for i in range(50)]

        def script(path, n):
            if path == f"/channels/{forum}":
                return FakeResponse({"guild_id": "G9", "available_tags": []})
            if path.endswith("/threads/active"):
                return FakeResponse({"threads": []})
            if "archived" in path:
                return FakeResponse({"has_more": False, "threads": []})
            if path == "/guilds/G9/channels":
                return FakeResponse([{"id": "71", "name": "牌譜修正", "type": 0}])
            if path == "/channels/71":
                return FakeResponse({"id": "71", "type": 0})
            if path == "/channels/72":
                return http_error(404, {"code": 10003})
            if path == "/channels/71/messages?limit=50":
                return FakeResponse(full_page)  # a full page, but only the newest 50 are read
            if path == "/channels/71/messages":
                return FakeResponse({"id": "new"})
            if path == "/users/@me":
                return FakeResponse({"id": "BOT1"})
            raise AssertionError(path)

        client = self.make(script)
        self.assertEqual(client.forum_guild_id(forum), "G9")  # fetched when the forum was not listed yet
        self.assertEqual(self.calls, [f"/channels/{forum}"])
        client = self.make(script)
        client.forum_posts(forum)
        before = len(self.calls)
        self.assertEqual(client.forum_guild_id(forum), "G9")  # remembered from forum_posts
        self.assertEqual(len(self.calls), before)
        self.assertEqual(client.guild_channels("G9"), [{"id": "71", "name": "牌譜修正", "type": 0}])
        self.assertEqual(client.channel("71"), {"id": "71", "type": 0})
        self.assertIsNone(client.channel("72"))
        self.assertFalse(client.has_bot_message("71", "BOT1", dri.FIX_LIST_MARKER, max_messages=50))
        self.assertEqual(self.calls[-1], "/channels/71/messages?limit=50")
        client.post_message("71", "清單", nonce="fl2026-W42-1")
        self.assertEqual(json.loads(self.requests[-1][2]), {"content": "清單", "allowed_mentions": {"parse": []},
                                                            "flags": 4, "nonce": "fl2026-W42-1", "enforce_nonce": True})
        self.assertLessEqual(len("fl2026-W42-235959-12"), 25)  # Discord's nonce limit
        self.assertEqual(client.bot_user_id(), "BOT1")
        self.assertEqual(client.bot_user_id(), "BOT1")
        self.assertEqual(self.calls.count("/users/@me"), 1)  # asked once per run

    def test_rate_limit_retry_404_and_errors(self) -> None:
        def script(path, n):
            if n == 1:
                return http_error(429, {"retry_after": 1.5})
            if n == 2:
                return http_error(502)
            if n == 3:
                return FakeResponse({"content": "147"}, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.7"})
            return http_error(404, {"code": 10008})
        client = self.make(script)
        self.assertEqual(client.starter_content("123"), "147")
        self.assertEqual(self.sleeps, [1.75, 2, 0.7])  # retry_after + 0.25, backoff, reset-after
        self.assertIsNone(client.starter_content("124"))  # deleted starter message
        self.assertEqual(self.calls[0], "/channels/123/messages/123")

        client = self.make(lambda path, n: http_error(401, {"code": 0}))
        with self.assertRaises(dri.DiscordError) as ctx:
            client.forum_posts("555")
        self.assertIn("rejected DISCORD_BOT_TOKEN", str(ctx.exception))
        self.assertNotIn("TOKEN\"", str(ctx.exception))
        self.assertNotIn("555", str(ctx.exception))  # route template, no ids
        client = self.make(lambda path, n: http_error(403, {"code": 50001}))
        with self.assertRaises(dri.DiscordError) as ctx:
            client.starter_content("1")
        self.assertIn("Read Message History", str(ctx.exception))

    def test_starter_message_carries_the_edit_time(self) -> None:
        def script(path, n):
            if path == "/channels/1/messages/1":
                return FakeResponse({"content": "147", "edited_timestamp": "2026-11-20T08:00:00.123000+00:00"})
            if path == "/channels/2/messages/2":
                return FakeResponse({"content": "260", "edited_timestamp": None})
            return http_error(404, {"code": 10008})
        client = self.make(script)
        self.assertEqual(client.starter_message("1"),
                         dri.StarterMessage("147", dt.datetime(2026, 11, 20, 8, 0, 0, 123000, tzinfo=dt.timezone.utc)))
        self.assertEqual(client.starter_message("2"), dri.StarterMessage("260", None))
        self.assertIsNone(client.starter_message("3"))
        self.assertEqual([m for m, *_ in self.requests], ["GET", "GET", "GET"])  # reads only

    def test_forum_tag_lookup_and_creation(self) -> None:
        forum = dri.FORUM_CHANNEL_ID
        state = {"tags": [dict(t) for t in FORUM_TAGS[:3]], "patch": None}

        def script(path, n):
            method, _, body, _ = self.requests[-1]
            if path == f"/channels/{forum}" and method == "GET":
                return FakeResponse({"guild_id": dri.GUILD_ID, "available_tags": state["tags"]})
            if path == f"/channels/{forum}" and method == "PATCH":
                if state["patch"] is not None:
                    return state["patch"]
                sent = json.loads(body)["available_tags"]
                return FakeResponse({"id": forum, "available_tags": [*sent[:-1], {**sent[-1], "id": FIX_TAG_ID,
                                                                                    "moderated": False}]})
            if path.endswith("/threads/active"):
                return FakeResponse({"threads": [{"id": "300", "name": "c", "parent_id": forum, "applied_tags": ["9100"],
                                                  "thread_metadata": {"archived": False, "locked": True}}]})
            if "archived" in path:
                return FakeResponse({"has_more": False, "threads": [
                    {"id": "200", "name": "b", "applied_tags": ["9102", "gone"],
                     "thread_metadata": {"archived": True, "archive_timestamp": "x"}}]})
            raise AssertionError((method, path))

        client = self.make(script)
        posts, _ = client.forum_posts(forum)
        self.assertEqual([(p.id, p.tags, p.tag_ids, p.archived, p.locked) for p in posts],
                         [("200", ("三紅",), ("9102", "gone"), True, False), ("300", ("已收錄",), ("9100",), False, True)])
        before = len(self.calls)
        self.assertEqual(client.forum_tags(forum), state["tags"])  # remembered from forum_posts
        self.assertEqual(len(self.calls), before)
        self.assertIsNone(dri.tag_id_named(client.forum_tags(forum), dri.TAG_FIX))
        self.assertEqual(client.create_forum_tag(forum, dri.TAG_FIX), FIX_TAG_ID)
        (m1, p1, _, _), (m2, p2, body, ctype) = self.requests[-2:]
        self.assertEqual((m1, p1, m2, p2, ctype), ("GET", f"/channels/{forum}", "PATCH", f"/channels/{forum}",
                                                   "application/json"))  # read again just before the change
        # Every existing tag goes back exactly as Discord returned it (moderated, emoji): only the new one is added.
        self.assertEqual(json.loads(body), {"available_tags": [*FORUM_TAGS[:3], {"name": dri.TAG_FIX}]})
        self.assertEqual(dri.tag_id_named(client.forum_tags(forum), dri.TAG_FIX), FIX_TAG_ID)

        state["tags"] = [*FORUM_TAGS[:3], FIX_TAG]  # added by hand meanwhile: used, nothing sent
        client = self.make(script)
        self.assertEqual(client.create_forum_tag(forum, dri.TAG_FIX), FIX_TAG_ID)
        self.assertEqual([m for m, _, _, _ in self.requests], ["GET"])
        self.assertEqual(dri.tag_id_named(client.forum_tags(forum), dri.TAG_FIX), FIX_TAG_ID)  # fetched once
        self.assertEqual(len(self.requests), 1)

        state["tags"] = [{"id": str(8000 + i), "name": f"t{i}"} for i in range(dri.MAX_FORUM_TAGS)]
        client = self.make(script)
        with self.assertRaises(dri.ForumTagsFull):
            client.create_forum_tag(forum, dri.TAG_FIX)
        self.assertEqual([m for m, _, _, _ in self.requests], ["GET"])

        state["tags"] = [dict(t) for t in FORUM_TAGS[:3]]
        state["patch"] = http_error(403, {"code": 50013})
        client = self.make(script)
        with self.assertRaises(dri.DiscordForbidden) as ctx:
            client.create_forum_tag(forum, dri.TAG_FIX)
        self.assertIn("PATCH /channels/{forum}: HTTP 403", str(ctx.exception))
        self.assertIn("Manage Channels", str(ctx.exception))
        self.assertNotIn(forum, str(ctx.exception))
        for odd in (FakeResponse({"available_tags": FORUM_TAGS[:3]}), http_error(502)):  # tag missing; server error
            state["patch"] = odd
            client = self.make(script)
            with self.assertRaises(dri.DiscordError):
                client.create_forum_tag(forum, dri.TAG_FIX)
            self.assertEqual([m for m, _, _, _ in self.requests], ["GET", "PATCH"])  # never sent twice

    def test_thread_read_and_tag_change(self) -> None:
        def script(path, n):
            method = self.requests[-1][0]
            if path == "/channels/300" and method == "GET":
                return FakeResponse({"id": "300", "applied_tags": ["9100"], "thread_metadata": {"archived": True}})
            if path == "/channels/300" and method == "PATCH":
                return FakeResponse({"id": "300"})
            if path == "/channels/404":
                return http_error(404, {"code": 10003})
            raise AssertionError((method, path))

        client = self.make(script)
        self.assertEqual(client.thread("300")["applied_tags"], ["9100"])
        self.assertIsNone(client.thread("404"))  # the post was deleted
        self.assertTrue(client.set_thread_tags("300", ["9100", FIX_TAG_ID], unarchive=True))
        method, path, body, ctype = self.requests[-1]
        self.assertEqual((method, path, ctype), ("PATCH", "/channels/300", "application/json"))
        self.assertEqual(json.loads(body), {"applied_tags": ["9100", FIX_TAG_ID], "archived": False})
        self.assertTrue(client.set_thread_tags("300", ["9100"]))
        self.assertEqual(json.loads(self.requests[-1][2]), {"applied_tags": ["9100"]})  # nothing else is sent
        self.assertFalse(client.set_thread_tags("404", []))
        self.assertTrue(client.archive_thread("300"))  # archived again after a change that reopened it
        method, path, body, _ = self.requests[-1]
        self.assertEqual((method, path, json.loads(body)), ("PATCH", "/channels/300", {"archived": True}))
        self.assertFalse(client.archive_thread("404"))

        client = self.make(lambda path, n: http_error(403, {"code": 50013}))
        with self.assertRaises(dri.DiscordForbidden) as ctx:
            client.set_thread_tags("424242", ["1"])
        self.assertIn("PATCH /channels/{thread}: HTTP 403", str(ctx.exception))
        self.assertIn("Manage Threads (管理討論串)", str(ctx.exception))
        self.assertNotIn("424242", str(ctx.exception))
        self.assertEqual(dri.error_kind(ctx.exception), "PATCH /channels/{thread} HTTP 403 code 50013")
        with self.assertRaises(dri.DiscordForbidden) as ctx:  # reading the post: a read permission
            client.thread("424242")
        self.assertEqual(dri.error_kind(ctx.exception), "GET /channels/{thread} HTTP 403 code 50013")
        for failure, kind in ((http_error(502), "PATCH /channels/{thread} HTTP 502"),
                              (http_error(400, {"code": "x"}), "PATCH /channels/{thread} HTTP 400"),  # not a number
                              (TimeoutError(), "PATCH /channels/{thread} network error TimeoutError")):
            with self.subTest(failure=type(failure).__name__):
                client = self.make(lambda path, n, f=failure: f)
                with self.assertRaises(dri.DiscordError) as ctx:
                    client.set_thread_tags("300", ["1"])
                self.assertEqual(len(self.requests), 1)  # a PATCH is not re-sent after a server error
                self.assertEqual(dri.error_kind(ctx.exception), kind)
        client = self.make(lambda path, n: http_error(429, {"retry_after": 0.5}) if n == 1 else FakeResponse({"id": "300"}))
        self.assertTrue(client.set_thread_tags("300", ["1"]))
        self.assertEqual(([m for m, _, _, _ in self.requests], self.sleeps), (["PATCH", "PATCH"], [0.75]))


# ---------------------------------------------------------------------------
# End to end with a fake spreadsheet and a fake Discord (no network)
# ---------------------------------------------------------------------------

class WorksheetNotFound(Exception):
    pass


class APIError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.error = {"code": code, "message": message}
        self.response = mock.Mock(status_code=code)


def quiet_env(**extra: str) -> mock._patch:
    drop = ("GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY", gc.ENV_CREDENTIALS_FILE, gc.ENV_CREDENTIALS_JSON, gc.ENV_SHEET_ID,
            dri.ENV_DISCORD_TOKEN, dri.ENV_FIX_CHANNEL, dri.ENV_FORUM_ID)
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env.update(extra)
    return mock.patch.dict(os.environ, env, clear=True)


def a1_cell(ref: str) -> tuple[int, int]:
    """'BA12' -> (row index 11, column index 52)."""
    m = re.fullmatch(r"([A-Z]+)([0-9]+)", ref)
    assert m, ref
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return int(m.group(2)) - 1, col - 1


class FakeWorksheet:
    def __init__(self, rows, owner, title=""):
        self.rows = rows
        self.owner = owner
        self.title = title

    @property
    def col_count(self):  # the grid: as wide as the widest row unless add_cols made it wider
        return max([len(r) for r in self.rows] + [self.owner.grid_cols.get(self.title, 0)])

    def add_cols(self, cols):
        self.owner.check_write()
        self.owner.grid_cols[self.title] = self.col_count + cols

    def get_all_values(self):
        width = max([len(r) for r in self.rows], default=0)  # gspread pads every row to the widest
        return [list(r) + [""] * (width - len(r)) for r in self.rows]

    def _put(self, ref, values, logged=None):
        row, col = a1_cell(ref)
        assert len(values) == 1, "one row per range"
        assert col + len(values[0]) <= self.col_count, "exceeds grid limits"
        while len(self.rows) <= row:
            self.rows.append([])
        cells = self.rows[row]
        cells += [""] * (col + len(values[0]) - len(cells))
        cells[col:col + len(values[0])] = list(values[0])
        self.owner.writes.append(logged or ref)

    def update(self, values, range_name, raw=True):
        self.owner.check_write()
        assert raw
        if range_name == "A1" and not self.rows:
            self.rows.append([])
            self.owner.grid_cols[self.title] = len(values[0])
        self._put(range_name, values)

    def col_values(self, col):  # gspread: the column's cells down to its last non-empty one
        values = [r[col - 1] if col - 1 < len(r) else "" for r in self.rows]
        while values and not values[-1]:
            values.pop()
        self.owner.reads.append(f"col {col}")
        return values

    def batch_update(self, data, value_input_option=None):
        self.owner.check_write()
        assert value_input_option == "RAW"
        self.owner.batches += 1
        for item in data:
            start, end = item["range"].split(":")
            assert a1_cell(start)[0] == a1_cell(end)[0]
            assert a1_cell(end)[1] - a1_cell(start)[1] + 1 == len(item["values"][0])
            self._put(start, item["values"], item["range"])

    def append_rows(self, values, value_input_option, insert_data_option, table_range):
        self.owner.check_write()
        assert (value_input_option, insert_data_option, table_range) == ("RAW", "INSERT_ROWS", "A1")
        self.rows.extend(list(r) for r in values)
        self.owner.writes.append("append")


class FakeSheet:
    def __init__(self, tabs, deny_writes: bool = False, write_error: Exception | None = None):
        self.tabs = tabs
        self.deny_writes = deny_writes
        self.write_error = write_error
        self.grid_cols: dict[str, int] = {}
        self.writes: list[str] = []  # A1 ranges written (and "append"), in order
        self.reads: list[str] = []  # col_values reads
        self.batches = 0  # batch_update requests

    def check_write(self):
        if self.deny_writes:  # what gspread 6 raises for HTTP 403
            raise PermissionError from APIError(403, "The caller does not have permission")
        if self.write_error is not None:
            raise self.write_error

    def worksheet(self, name):
        if name not in self.tabs:
            raise WorksheetNotFound(name)
        return FakeWorksheet(self.tabs[name], self, name)

    def add_worksheet(self, title, rows, cols):
        self.check_write()
        assert title not in self.tabs
        self.tabs[title] = []
        self.grid_cols[title] = cols
        return FakeWorksheet(self.tabs[title], self, title)


FIX_CHANNEL = "5550001"  # the 牌譜修正 channel of the fake guild

# The fake forum's tags, as Discord returns them: every expected tag, but no 待修正 (FIX_TAG adds it).
FORUM_TAGS = [{"id": f"91{i:02d}", "name": name, "moderated": i == 0, "emoji_id": None,
               "emoji_name": "✅" if i == 0 else None} for i, name in enumerate(dri.EXPECTED_TAGS)]
FIX_TAG_ID = "9199"
LEAK = "不該出現在公開紀錄"  # in the fakes' error messages: the public log must show only the error's kind
FIX_TAG = {"id": FIX_TAG_ID, "name": dri.TAG_FIX, "moderated": False, "emoji_id": None, "emoji_name": None}


def guild_channel(cid: str, name: str, ctype: int = 0) -> dict:
    return {"id": cid, "name": name, "type": ctype, "guild_id": dri.GUILD_ID}


class FakeDiscord:
    def __init__(self, posts, bodies, *, replied=(), forbid_post=False, post_error=False, no_me=False,
                 missing=(), odd_error=False, channels=None, history=None, forbid_fix=False, fix_error_at=0,
                 forum_tags=None, threads=None, deleted=(), deleted_on_patch=(), forbid_tag_create=False,
                 forbid_tags=False, tag_error=False, tag_read_error=False, read_forbidden=(), archive_error=False,
                 edits=None):
        self.posts, self.bodies, self.fetched = posts, bodies, 0
        self.edits = dict(edits or {})  # post id -> the starter message's edited_timestamp
        self.rereads: list[str] = []  # starter messages read through starter_message
        # The 待修正 tag: the forum's tags, and each post's thread as Discord holds it (applied_tags
        # ids, thread_metadata). `threads` may be shared between runs, so tag changes persist.
        self.forum_tag_list = [dict(t) for t in (FORUM_TAGS if forum_tags is None else forum_tags)]
        ids = {t["name"]: t["id"] for t in self.forum_tag_list}
        self.threads = threads if threads is not None else {}
        for p in posts:
            self.threads.setdefault(p.id, {"applied_tags": [ids[n] for n in p.tags if n in ids],
                                           "thread_metadata": {"archived": False, "locked": False}})
        self.deleted = set(deleted)  # 404 when the post is re-read
        self.deleted_on_patch = set(deleted_on_patch)  # 404 on the tag change itself
        self.forbid_tag_create, self.forbid_tags, self.tag_error = forbid_tag_create, forbid_tags, tag_error
        self.tag_read_error = tag_read_error  # reading the forum's tags fails
        self.read_forbidden = set(read_forbidden)  # 403 when the post is re-read
        self.archive_error = archive_error  # archiving a post again fails
        self.tag_reads = 0
        self.tag_creates: list[str] = []
        self.thread_reads: list[str] = []
        self.tag_edits: list[tuple[str, list[str], bool]] = []  # (post, applied_tags sent, archived:false sent)
        self.archives: list[str] = []  # posts archived again after a change
        self.replied = set(replied)  # threads that already hold the bot's marker message
        self.forbid_post, self.post_error, self.no_me = forbid_post, post_error, no_me
        self.missing = list(missing)  # expected forum tags the forum lacks
        self.odd_error = odd_error  # reading a thread gets a 200 with a non-JSON body
        self.me_calls = 0
        self.message_reads: list[str] = []  # threads read for the reply marker
        self.posted: list[tuple[str, str]] = []
        self.nonces: list[str | None] = []
        # The guild's channels (default: a 牌譜修正 text channel) and earlier messages per channel
        # as (author id, content), newest first.
        self.channels = [guild_channel(FIX_CHANNEL, dri.FIX_CHANNEL_NAME)] if channels is None else channels
        self.history: dict[str, list[tuple[str, str]]] = {k: list(v) for k, v in (history or {}).items()}
        self.forbid_fix = forbid_fix  # 403 reading or posting in the fix-list channel
        self.fix_error_at = fix_error_at  # the n-th fix-list message gets a 500
        self.fix_reads: list[tuple[str, str, int | None]] = []  # (channel, prefix, max_messages)
        self.guild_calls = 0

    def forum_posts(self, forum_id):
        names = {t["id"]: t["name"] for t in self.forum_tag_list}
        listed = []
        for p in self.posts:
            thread = self.threads[p.id]
            meta = thread["thread_metadata"]
            listed.append(dri.Post(p.id, p.title, tuple(names[i] for i in thread["applied_tags"] if i in names),
                                   tag_ids=tuple(thread["applied_tags"]), archived=meta["archived"],
                                   locked=meta["locked"]))
        return listed, list(self.missing)

    def forum_tags(self, forum_id):
        self.tag_reads += 1
        if self.tag_read_error:  # the message (never printed) names ids; the kind does not
            raise dri.DiscordError(f"GET /channels/{forum_id} {self.posts[0].id}: HTTP 500 {LEAK}",
                                   "GET /channels/{forum} HTTP 500")
        return [dict(t) for t in self.forum_tag_list]

    def create_forum_tag(self, forum_id, name):
        self.tag_creates.append(name)
        if self.forbid_tag_create:
            raise dri.DiscordForbidden("PATCH /channels/{forum}: HTTP 403")
        if len(self.forum_tag_list) >= dri.MAX_FORUM_TAGS:
            raise dri.ForumTagsFull("PATCH /channels/{forum}: full")
        self.forum_tag_list.append({**FIX_TAG, "name": name})
        return FIX_TAG_ID

    def thread(self, thread_id):
        self.thread_reads.append(thread_id)
        if thread_id in self.read_forbidden:
            raise dri.DiscordForbidden(f"GET /channels/{thread_id}: HTTP 403 {LEAK}",
                                       "GET /channels/{thread} HTTP 403 code 50001")
        if thread_id in self.deleted:
            return None
        thread = self.threads[thread_id]
        return {"id": thread_id, "applied_tags": list(thread["applied_tags"]),
                "thread_metadata": dict(thread["thread_metadata"])}

    def set_thread_tags(self, thread_id, tag_ids, unarchive=False):
        self.tag_edits.append((thread_id, list(tag_ids), unarchive))
        if self.forbid_tags:
            raise dri.DiscordForbidden("PATCH /channels/{thread}: HTTP 403")
        if self.tag_error:
            raise dri.DiscordError(f"PATCH /channels/{thread_id}: HTTP 500 {LEAK}", "PATCH /channels/{thread} HTTP 500")
        if thread_id in self.deleted_on_patch:
            return False
        thread = self.threads[thread_id]
        if thread["thread_metadata"]["archived"] and not unarchive:  # as Discord: no edit of an archived thread
            raise dri.DiscordError("PATCH /channels/{thread}: HTTP 400", "PATCH /channels/{thread} HTTP 400 code 50083")
        thread["applied_tags"] = list(tag_ids)
        if unarchive:
            thread["thread_metadata"]["archived"] = False
        return True

    def archive_thread(self, thread_id):
        self.archives.append(thread_id)
        if self.archive_error:
            raise dri.DiscordError(f"PATCH /channels/{thread_id}: HTTP 500 {LEAK}", "PATCH /channels/{thread} HTTP 500")
        self.threads[thread_id]["thread_metadata"]["archived"] = True
        return True

    def forum_guild_id(self, forum_id):
        return dri.GUILD_ID

    def guild_channels(self, guild_id):
        assert guild_id == dri.GUILD_ID
        self.guild_calls += 1
        return list(self.channels)

    def channel(self, channel_id):
        return next((c for c in self.channels if c["id"] == channel_id), None)

    def starter_content(self, thread_id):
        self.fetched += 1
        return self.bodies[thread_id]

    def starter_message(self, thread_id):
        self.fetched += 1
        self.rereads.append(thread_id)
        body = self.bodies[thread_id]
        return None if body is None else dri.StarterMessage(body, self.edits.get(thread_id))

    def bot_user_id(self):
        self.me_calls += 1
        if self.no_me:
            raise dri.DiscordError("GET /users/@me: HTTP 500")
        return "BOT1"

    def has_bot_message(self, thread_id, bot_id, prefix, max_messages=None):
        assert bot_id == "BOT1"
        if prefix != dri.REPLY_MARKER:  # the fix-list channel
            assert prefix.startswith(dri.FIX_LIST_MARKER + " ")
            self.fix_reads.append((thread_id, prefix, max_messages))
            if self.forbid_fix:
                raise dri.DiscordForbidden("GET /channels/{thread}/messages: HTTP 403")
            newest = ([("BOT1", c) for t, c in reversed(self.posted) if t == thread_id]
                      + self.history.get(thread_id, []))[:max_messages]
            return any(a == bot_id and c.startswith(prefix) for a, c in newest)
        self.message_reads.append(thread_id)
        if self.odd_error:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return thread_id in self.replied or any(t == thread_id and c.startswith(prefix) for t, c in self.posted)

    def post_message(self, thread_id, content, nonce=None):
        if any(c["id"] == thread_id for c in self.channels):  # the fix-list channel
            if self.forbid_fix:
                raise dri.DiscordForbidden("POST /channels/{thread}/messages: HTTP 403")
            if self.fix_error_at and len([t for t, _ in self.posted if t == thread_id]) + 1 == self.fix_error_at:
                raise dri.DiscordError("POST /channels/{thread}/messages: HTTP 500")
        elif self.forbid_post:
            raise dri.DiscordForbidden("POST /channels/{thread}/messages: HTTP 403")
        elif self.post_error:
            raise dri.DiscordError("POST /channels/{thread}/messages: HTTP 500")
        self.posted.append((thread_id, content))
        self.nonces.append(nonce)


class ReplyTest(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 10, 3, 17, tzinfo=dri.TAIPEI)

    def setUp(self) -> None:
        self.header = dri.import_header([sheet_header()], None)
        recent = dt.datetime(2026, 10, 9, 22, tzinfo=dri.TAIPEI)
        old = dt.datetime(2026, 9, 1, 22, tzinfo=dri.TAIPEI)  # 39 days before NOW
        self.p_old = post(title="0901一般場1", when=old)  # bad vote, too old for the default window
        self.p_vote = post(when=recent, offset=0)  # bad vote on line 3
        self.p_names = post(title="1009一般場5", when=recent, offset=1)  # names missing: no line
        self.p_recorded = post(title="1009一般場6", tags=("三藍被刀", "已收錄"), when=recent, offset=2)
        self.p_sim = post(title="1009一般場7", tags=("模擬",), when=recent, offset=3)
        self.p_empty = post(title="1009一般場8", when=recent, offset=4)
        self.p_deleted = post(title="1009一般場9", when=recent, offset=5)
        self.p_ok = post(title="1009一般場2", tags=("三紅",), when=recent, offset=6)
        self.p_dup = post(title="1009一般場3", tags=("三紅",), when=recent, offset=7)  # same game again
        bad_vote = RECENT_BODY.replace("389 +7", "389 7")
        self.bodies = {
            self.p_old.id: bad_vote, self.p_vote.id: bad_vote, self.p_names.id: RECENT_RECORD + "\n刺客刺殺:\n936758",
            self.p_recorded.id: bad_vote, self.p_sim.id: RECENT_BODY, self.p_empty.id: "", self.p_deleted.id: None,
            self.p_ok.id: RED_BODY, self.p_dup.id: RED_BODY,
        }
        self.posts = [self.p_old, self.p_vote, self.p_names, self.p_recorded, self.p_sim, self.p_empty,
                      self.p_deleted, self.p_ok, self.p_dup]
        self.report = dri.plan_import(self.posts, lambda p: self.bodies[p.id], [sheet_header()], None, self.header)

    def fake(self, **kw) -> FakeDiscord:
        return FakeDiscord(self.posts, self.bodies, **kw)

    def test_candidates_are_recent_format_failures_only(self) -> None:
        self.assertEqual(sum(self.report.skipped.values()), 7)
        cands = dri.reply_candidates(self.report, self.NOW, dri.REPLY_DEFAULT_DAYS)
        self.assertEqual([c.post.id for c in cands], [self.p_vote.id, self.p_names.id])  # oldest first
        self.assertEqual((cands[0].reason, cands[0].line_no, cands[0].line_text), (dri.SKIP_BAD_VOTE, 3, "389 7"))
        self.assertEqual((cands[1].reason, cands[1].line_no, cands[1].line_text), (dri.SKIP_NAMES_MISSING, None, None))
        self.assertEqual([c.post.id for c in dri.reply_candidates(self.report, self.NOW, 60)],
                         [self.p_old.id, self.p_vote.id, self.p_names.id])
        self.assertEqual(dri.reply_candidates(self.report, self.NOW, 0), [])
        self.assertEqual(dri.reply_candidates(dri.ImportReport(), self.NOW, 14), [])

    def test_dry_run_counts_without_posting(self) -> None:
        cands = dri.reply_candidates(self.report, self.NOW, 14)
        fake = self.fake()
        dry = dri.reply_to_failures(fake, cands, limit=20, dry_run=True)
        self.assertEqual((dry.candidates, dry.replied, dry.already_replied, dry.forbidden, dry.held_by_limit), (2, 2, 0, 0, 0))
        self.assertTrue(dry.dry_run)
        self.assertEqual((fake.posted, fake.me_calls, fake.message_reads), ([], 1, [self.p_vote.id, self.p_names.id]))
        fake = self.fake(replied=[self.p_vote.id])
        dry = dri.reply_to_failures(fake, cands, limit=20, dry_run=True)
        self.assertEqual((dry.replied, dry.already_replied, fake.posted), (1, 1, []))

    def test_posts_once_per_thread(self) -> None:
        cands = dri.reply_candidates(self.report, self.NOW, 14)
        fake = self.fake()
        live = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((live.replied, live.already_replied, live.forbidden, live.errors), (2, 0, 0, 0))
        self.assertEqual([t for t, _ in fake.posted], [self.p_vote.id, self.p_names.id])
        text = fake.posted[0][1]
        self.assertTrue(text.startswith(dri.REPLY_MARKER + "\n"))
        self.assertIn("\n第 3 行「389 7」：" + dri.SKIP_EXPLANATIONS[dri.SKIP_BAD_VOTE] + "\n", text)
        self.assertIn(dri.FORMAT_HINT, text)
        self.assertIn("\n原因：" + dri.SKIP_EXPLANATIONS[dri.SKIP_NAMES_MISSING] + "\n", fake.posted[1][1])
        again = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)  # the marker is in both threads now
        self.assertEqual((again.replied, again.already_replied, len(fake.posted)), (0, 2, 2))
        fake = self.fake(replied=[self.p_names.id])  # replied by an earlier run
        third = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((third.replied, third.already_replied, [t for t, _ in fake.posted]), (1, 1, [self.p_vote.id]))

    def test_limit_403_and_other_errors(self) -> None:
        cands = dri.reply_candidates(self.report, self.NOW, 14)
        fake = self.fake()
        limited = dri.reply_to_failures(fake, cands, limit=1, dry_run=False)
        self.assertEqual((limited.replied, limited.held_by_limit, [t for t, _ in fake.posted]), (1, 1, [self.p_vote.id]))
        self.assertEqual(fake.message_reads, [self.p_vote.id])  # held-back threads are not even read
        fake = self.fake(forbid_post=True)
        denied = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((denied.forbidden, denied.replied, denied.errors, fake.posted), (2, 0, 0, []))
        fake = self.fake(post_error=True)
        errors = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((errors.errors, errors.replied, errors.forbidden), (2, 0, 0))
        fake = self.fake(no_me=True)
        unknown = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((unknown.errors, unknown.replied, unknown.held_by_limit, fake.posted), (1, 0, 2, []))
        fake = self.fake()
        none = dri.reply_to_failures(fake, [], limit=20, dry_run=False)
        self.assertEqual((none.candidates, fake.me_calls, fake.posted), (0, 0, []))

    def test_logged_posts_are_skipped_without_reading_the_thread(self) -> None:
        cands = dri.reply_candidates(self.report, self.NOW, 14)
        fake = self.fake()
        posted: list[dri.SkippedPost] = []
        live = dri.reply_to_failures(fake, cands, limit=20, dry_run=False, replied={self.p_vote.id}, posted=posted)
        self.assertEqual((live.replied, live.already_replied, fake.message_reads), (1, 1, [self.p_names.id]))
        self.assertEqual([(s.post.id, s.reason) for s in posted], [(self.p_names.id, dri.SKIP_NAMES_MISSING)])
        fake = self.fake()  # the bot's messages were deleted, but the log remembers both posts
        again = dri.reply_to_failures(fake, cands, limit=20, dry_run=False,
                                      replied={self.p_vote.id, self.p_names.id}, posted=posted)
        self.assertEqual((again.replied, again.already_replied, fake.posted, fake.message_reads), (0, 2, [], []))
        self.assertEqual(len(posted), 1)
        dry = dri.reply_to_failures(self.fake(), cands, limit=20, dry_run=True, posted=posted)  # nothing to log
        self.assertEqual((dry.replied, len(posted)), (2, 1))
        fake = self.fake()  # logged posts are not attempts: they do not count against the limit
        limited = dri.reply_to_failures(fake, cands, limit=1, dry_run=False, replied={self.p_vote.id})
        self.assertEqual((limited.replied, limited.already_replied, limited.held_by_limit), (1, 1, 0))
        self.assertEqual([t for t, _ in fake.posted], [self.p_names.id])
        self.assertEqual(dri.replied_post_ids(None), set())
        self.assertEqual(dri.replied_post_ids([]), set())
        self.assertEqual(dri.replied_post_ids([list(dri.REPLY_LOG_COLUMNS), ["1", "t", "r"], ["", "", ""], [" 2 "]]),
                         {"1", "2"})

    def test_no_record_posts_reply_only_when_meant_as_a_record(self) -> None:
        recent = dt.datetime(2026, 10, 9, 22, tzinfo=dri.TAIPEI)
        p_chat = post(title="今天那局的覆盤", tags=(), when=recent, offset=20)
        p_notice = post(title="公告", tags=("線瓦",), when=recent, offset=21)
        p_tagged = post(title="1009一般場9", tags=("三紅",), when=recent, offset=22)
        p_titled = post(title="936758", tags=(), when=recent, offset=23)
        chat = "今天那局大家覺得怎麼樣？\n我覺得第三輪的湖很關鍵。"
        posts = [p_chat, p_notice, p_tagged, p_titled]
        bodies = {p.id: chat for p in posts}
        report = dri.plan_import(posts, lambda p: bodies[p.id], [sheet_header()], None, self.header)
        self.assertEqual(report.skipped, Counter({dri.SKIP_NOT_A_RECORD: 2, dri.SKIP_NO_RECORD: 2}))
        cands = dri.reply_candidates(report, self.NOW, 14)
        self.assertEqual([(c.post.id, c.reason) for c in cands],
                         [(p_tagged.id, dri.SKIP_NO_RECORD), (p_titled.id, dri.SKIP_NO_RECORD)])
        fake = FakeDiscord(posts, bodies)
        live = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((live.replied, [t for t, _ in fake.posted]), (2, [p_tagged.id, p_titled.id]))
        self.assertIn("\n原因：" + dri.SKIP_EXPLANATIONS[dri.SKIP_NO_RECORD] + "\n", fake.posted[0][1])

    def test_odd_responses_are_counted_not_raised(self) -> None:
        cands = dri.reply_candidates(self.report, self.NOW, 14)
        fake = self.fake(odd_error=True)
        odd = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((odd.errors, odd.replied, odd.forbidden, fake.posted), (2, 0, 0, []))
        fake = self.fake()
        with mock.patch.object(fake, "bot_user_id", side_effect=AttributeError("'list' object has no attribute 'get'")):
            unknown = dri.reply_to_failures(fake, cands, limit=20, dry_run=False)
        self.assertEqual((unknown.errors, unknown.replied, unknown.held_by_limit, fake.posted), (1, 0, 2, []))

    def test_summary_lines_are_counts_only(self) -> None:
        lines = "\n".join(dri.reply_lines(dri.ReplyReport(dry_run=False, candidates=3, already_replied=1, replied=1,
                                                          forbidden=1, held_by_limit=0), 14))
        self.assertIn("14 天內因格式無法解析且未標「已收錄」的貼文 3 篇", lines)
        self.assertIn("已回覆過（略過）：1；本次已回覆：1；沒有發言權限（403）：1；其他 Discord 錯誤：0", lines)
        self.assertNotIn("保留到下次", lines)
        dry = "\n".join(dri.reply_lines(dri.ReplyReport(dry_run=True, candidates=25, replied=20, held_by_limit=5), 14))
        self.assertIn("dry run：只計數，未貼文", dry)
        self.assertIn("本次可回覆：20", dry)
        self.assertIn("超過 --reply-limit 保留到下次：5", dry)


class FixListTest(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 12, 3, 17, tzinfo=dri.TAIPEI)  # the Monday run of 2026-W42

    def setUp(self) -> None:
        header = dri.import_header([sheet_header()], None)
        at = lambda m, d, h=22: dt.datetime(2026, m, d, h, tzinfo=dri.TAIPEI)  # noqa: E731
        bad_vote = RECENT_BODY.replace("389 +7", "389 7")
        self.p_a = post(title="1009一般場4", when=at(10, 9), offset=0)  # bad vote, line 3
        self.p_b = post(title="1009一般場2", when=at(10, 9), offset=1)  # names missing: no line
        self.p_c = post(title="覆盤", when=at(10, 5, 21))  # bad 配置 on line 21; no date in the title
        self.p_d = post(title="1008一般場1", tags=("三藍被刀", "已收錄"), when=at(10, 8))
        self.p_e = post(title="0901一般場1", when=at(9, 1))  # 41 days old: backlog only
        self.p_sim = post(title="1007一般場1", tags=("模擬",), when=at(10, 7))
        self.p_chat = post(title="今天那局", tags=(), when=at(10, 7), offset=1)
        self.p_ok = post(title="1010一般場1", tags=("三紅",), when=at(10, 10))
        self.p_md = post(title="1010一般場3", when=at(10, 10, 21))  # unrecognized line 14, with markdown
        self.bodies = {
            self.p_a.id: bad_vote, self.p_b.id: RECENT_RECORD + "\n刺客刺殺:\n936758",
            self.p_c.id: RECENT_BODY.replace("936758\n", "936798\n"), self.p_d.id: bad_vote, self.p_e.id: bad_vote,
            self.p_sim.id: RECENT_BODY, self.p_chat.id: "今天那局大家覺得怎麼樣？", self.p_ok.id: RED_BODY,
            self.p_md.id: RECENT_BODY.replace("1458\n", "第三輪 *重要* __湖__ 打錯了請看這裡\n1458\n"),
        }
        self.posts = [self.p_a, self.p_b, self.p_c, self.p_d, self.p_e, self.p_sim, self.p_chat, self.p_ok, self.p_md]
        self.report = dri.plan_import(self.posts, lambda p: self.bodies[p.id], [sheet_header()], None, header)
        self.entries, self.backlog = dri.fix_list_entries(self.report, self.NOW, 30)

    def fake(self, **kw) -> FakeDiscord:
        return FakeDiscord(self.posts, self.bodies, **kw)

    def fix(self, fake: FakeDiscord, **kw) -> dri.FixListReport:
        kw.setdefault("now", self.NOW)
        kw.setdefault("dry_run", False)
        return dri.post_fix_list(fake, self.report, forum_id=dri.FORUM_CHANNEL_ID, **kw)

    @staticmethod
    def link(p: dri.Post) -> str:
        return f"https://discord.com/channels/{dri.GUILD_ID}/{p.id}"

    def test_entries_are_fixable_posts_by_record_date(self) -> None:
        self.assertEqual(self.report.parsed, 1)
        self.assertEqual([e.skip.post.id for e in self.entries], [self.p_c.id, self.p_b.id, self.p_a.id, self.p_md.id])
        self.assertEqual([(e.date, e.game_no, e.date_from_title) for e in self.entries],
                         [("2026/10/05", "", False), ("2026/10/09", "2", True), ("2026/10/09", "4", True),
                          ("2026/10/10", "3", True)])
        self.assertEqual(self.backlog, 5)  # + the 41-day-old one; never 已收錄, 模擬, discussions, parsed posts
        older, _ = dri.fix_list_entries(self.report, self.NOW, 60)
        self.assertEqual([e.skip.post.id for e in older][:2], [self.p_e.id, self.p_c.id])
        self.assertEqual(dri.fix_list_entries(self.report, self.NOW, 0), ([], 5))
        self.assertEqual(dri.fix_list_entries(dri.ImportReport(), self.NOW, 30), ([], 0))
        # The reply and the list name the same posts.
        self.assertEqual({s.post.id for s in dri.reply_candidates(self.report, self.NOW, 30)},
                         {e.skip.post.id for e in self.entries})

    def test_entry_lines(self) -> None:
        lines = [dri.fix_entry_line(i, e, dri.GUILD_ID) for i, e in enumerate(self.entries, 1)]
        self.assertEqual(lines, [
            f"1. 2026/10/05（依發文時間）：配置不是 6 個不同的座號（第 21 行「936798」） {self.link(self.p_c)}",
            f"2. 2026/10/09 第 2 場：玩家名單不完整 {self.link(self.p_b)}",
            f"3. 2026/10/09 第 4 場：投票異常標記看不懂（第 3 行「389 7」） {self.link(self.p_a)}",
            # cut at FIX_LIST_LINE_MAX, markdown escaped
            "4. 2026/10/10 第 3 場：這一行看不懂（第 14 行「第三輪 \\*重要\\* \\_\\_湖\\_\\_ 打錯了請…」） "
            + self.link(self.p_md),
        ])
        no_text = dri.FixEntry(dri.SkippedPost(self.p_a, dri.SKIP_BAD_VOTE, 3, None), "2026/10/09", "4", True)
        self.assertIn("：投票異常標記看不懂（第 3 行） https://", dri.fix_entry_line(1, no_text, dri.GUILD_ID))
        # A masked link or a mention in the quoted line comes out as plain text.
        linked = dri.FixEntry(dri.SkippedPost(self.p_a, dri.SKIP_UNRECOGNIZED, 5, "[看這](http://a.bc)"), "2026/10/09",
                              "4", True)
        self.assertIn("（第 5 行「\\[看這\\](http://a.bc)」）", dri.fix_entry_line(1, linked, dri.GUILD_ID))
        self.assertEqual(dri.quote_line("<@&123> 389 *7* 0>8 o", 60), "\\<@&123> 389 \\*7\\* 0>8 o")
        # title_date takes the title's last number: a 配置 after the 場次 is no game number.
        when = dt.datetime(2026, 10, 9, 22, tzinfo=dri.TAIPEI)
        odd = [post(title=t, when=when, offset=i) for i, t in enumerate(["1009一般場4 936758", "1009 936758", "1009一般場12"])]
        odd_report = dri.ImportReport(skips=[dri.SkippedPost(p, dri.SKIP_NAMES_MISSING) for p in odd])
        self.assertEqual([(e.date, e.game_no) for e in dri.fix_list_entries(odd_report, self.NOW, 30)[0]],
                         [("2026/10/09", "12"), ("2026/10/09", ""), ("2026/10/09", "")])
        for reason in dri.SKIP_EXPLANATIONS:
            with self.subTest(reason=reason):
                short = dri.short_explanation(reason)
                self.assertTrue(short)
                self.assertNotIn("：", short)
                self.assertLessEqual(len(short), 30)
                self.assertTrue(dri.SKIP_EXPLANATIONS[reason].startswith(short))

    def test_message_cap_backlog_and_nothing_to_fix(self) -> None:
        head = f"{dri.FIX_LIST_MARKER} 2026-W42（2026/10/12 這週）"
        capped = dri.fix_list_messages(self.entries, self.backlog, now=self.NOW, days=30, max_entries=2,
                                       guild_id=dri.GUILD_ID)
        self.assertEqual(len(capped), 1)
        lines = capped[0].split("\n")
        self.assertEqual(lines[0], head)
        self.assertTrue(capped[0].startswith(dri.fix_list_prefix(self.NOW)))
        self.assertEqual(lines[1], "最近 30 天發文、因為格式問題還沒收進戰績統計的牌譜有 4 篇（依牌譜日期排列）：")
        self.assertTrue(lines[2].startswith("1. 2026/10/05（依發文時間）："))
        self.assertTrue(lines[3].startswith("2. 2026/10/09 第 2 場："))
        self.assertEqual(lines[4], "另有 2 篇沒列出（一次最多列 2 篇）。")
        self.assertEqual(lines[5], "累計待修正（不限發文時間）：5 篇，其中 1 篇發文超過 30 天，這裡沒有列出。")
        self.assertEqual(lines[6:], [dri.FIX_LIST_FOOTER])
        for p in (self.p_a, self.p_md, self.p_d, self.p_e, self.p_sim, self.p_chat, self.p_ok):
            self.assertNotIn(p.id, capped[0])
        full = dri.fix_list_messages(self.entries, self.backlog, now=self.NOW, days=30, max_entries=50,
                                     guild_id=dri.GUILD_ID)
        self.assertNotIn("另有", full[0])
        self.assertEqual(len(full[0].split("\n")), 2 + 4 + 2)
        self.assertNotIn("@", full[0])
        self.assertEqual(dri.fix_list_messages([], 0, now=self.NOW, days=30, max_entries=50, guild_id=dri.GUILD_ID),
                         [head + "\n最近 30 天發文的牌譜都沒有格式問題，不用修正。\n累計待修正（不限發文時間）：0 篇。"])
        only_old = dri.fix_list_messages([], 3, now=self.NOW, days=30, max_entries=50, guild_id=dri.GUILD_ID)[0]
        self.assertIn("\n累計待修正（不限發文時間）：3 篇，其中 3 篇發文超過 30 天，這裡沒有列出。\n", only_old)
        self.assertTrue(only_old.endswith(dri.FIX_LIST_FOOTER))

    def test_chunks_of_at_most_2000_split_between_lines(self) -> None:
        many = [dri.FixEntry(dri.SkippedPost(dri.Post(str(10 ** 17 + i), f"1009一般場{i}"), dri.SKIP_UNRECOGNIZED, 9,
                                             "字" * 40), "2026/10/09", str(i), True) for i in range(1, 121)]
        msgs = dri.fix_list_messages(many, 130, now=self.NOW, days=30, max_entries=120, guild_id=dri.GUILD_ID)
        self.assertGreater(len(msgs), 3)
        for m in msgs:
            self.assertLessEqual(dri.discord_length(m), dri.DISCORD_MESSAGE_MAX)
            self.assertLessEqual(len(m), 2000)
        lines = "\n".join(msgs).split("\n")
        self.assertEqual(sum(m.count("\n") + 1 for m in msgs), len(lines))  # no line was split
        self.assertEqual(len(lines), 2 + 120 + 2)
        self.assertEqual([int(x.split(".")[0]) for x in lines if re.match(r"^[0-9]+\. ", x)], list(range(1, 121)))
        self.assertTrue(msgs[0].startswith(dri.fix_list_prefix(self.NOW)))
        self.assertFalse(any(m.startswith(dri.FIX_LIST_MARKER) for m in msgs[1:]))
        self.assertEqual(dri.chunk_lines(["a" * 1000, "b" * 999, "c"]), ["a" * 1000 + "\n" + "b" * 999, "c"])
        self.assertEqual(dri.chunk_lines(["a" * 1000, "b" * 1000]), ["a" * 1000, "b" * 1000])
        huge = dri.chunk_lines(["🤖" * 1500, "x"])  # 3000 UTF-16 units: cut
        self.assertEqual(len(huge), 2)
        self.assertLessEqual(dri.discord_length(huge[0]), 2000)
        self.assertTrue(huge[0].endswith("…"))
        self.assertEqual(dri.chunk_lines([]), [])

    def test_week_key_is_iso_week_in_taipei(self) -> None:
        cases = [
            (dt.datetime(2026, 10, 12, 3, 17, tzinfo=dri.TAIPEI), "2026-W42", dt.date(2026, 10, 12)),
            (dt.datetime(2026, 10, 18, 23, 59, tzinfo=dri.TAIPEI), "2026-W42", dt.date(2026, 10, 12)),
            (dt.datetime(2026, 10, 11, 23, 59, tzinfo=dri.TAIPEI), "2026-W41", dt.date(2026, 10, 5)),
            (dt.datetime(2026, 10, 11, 19, 17, tzinfo=dt.timezone.utc), "2026-W42", dt.date(2026, 10, 12)),  # Mon in Taipei
            (dt.datetime(2027, 1, 1, 3, 17, tzinfo=dri.TAIPEI), "2026-W53", dt.date(2026, 12, 28)),
        ]
        for now, key, monday in cases:
            with self.subTest(now=now):
                self.assertEqual(dri.fix_list_week(now), (key, monday))
                self.assertEqual(dri.fix_list_prefix(now), f"{dri.FIX_LIST_MARKER} {key}")

    def test_channel_from_the_variable_or_by_name(self) -> None:
        channels = [guild_channel("900", dri.FIX_CHANNEL_NAME, 2),  # a voice channel of that name
                    guild_channel("7002", dri.FIX_CHANNEL_NAME), guild_channel("7001", dri.FIX_CHANNEL_NAME, 5),
                    guild_channel("7000", dri.FIX_CHANNEL_NAME + "-舊"), guild_channel("6999", "一般"),
                    guild_channel("8000", "討論串", 11), guild_channel("8001", "論壇", 15)]
        fake = self.fake(channels=channels)
        self.assertEqual(dri.resolve_fix_channel(fake, dri.GUILD_ID), ("7001", "name"))  # the oldest usable one
        self.assertEqual(dri.resolve_fix_channel(self.fake(channels=[guild_channel("1", " 牌譜修正 ")]), dri.GUILD_ID),
                         ("1", "name"))
        self.assertEqual(dri.resolve_fix_channel(self.fake(channels=[guild_channel("1", "牌譜修正", 15)]), dri.GUILD_ID),
                         (None, dri.FIX_NOT_TEXT))  # a forum: no plain messages
        self.assertEqual(dri.resolve_fix_channel(self.fake(channels=channels[3:]), dri.GUILD_ID), (None, dri.FIX_NO_CHANNEL))
        self.assertEqual(dri.resolve_fix_channel(self.fake(channels=[]), dri.GUILD_ID), (None, dri.FIX_NO_CHANNEL))
        fake = self.fake(channels=channels)
        self.assertEqual(dri.resolve_fix_channel(fake, dri.GUILD_ID, " 6999 "), ("6999", "variable"))
        self.assertEqual(dri.resolve_fix_channel(fake, dri.GUILD_ID, "8000"), ("8000", "variable"))  # a thread is fine
        self.assertEqual(dri.resolve_fix_channel(fake, dri.GUILD_ID, "8001"), (None, dri.FIX_NOT_TEXT))
        self.assertEqual(dri.resolve_fix_channel(fake, dri.GUILD_ID, "123"), (None, dri.FIX_NO_CHANNEL))
        self.assertEqual(dri.resolve_fix_channel(fake, dri.GUILD_ID, "#牌譜修正"), (None, dri.FIX_BAD_VARIABLE))
        self.assertEqual(fake.guild_calls, 0)  # the variable wins: the guild's channels are not listed

    def test_posts_once_per_week_unless_forced(self) -> None:
        fake = self.fake()
        live = self.fix(fake)
        self.assertEqual((live.status, live.channel_found, live.entries, live.listed, live.held_by_cap, live.backlog,
                          live.messages, live.posted), (dri.FIX_POSTED, True, 4, 4, 0, 5, 1, 1))
        self.assertEqual(([t for t, _ in fake.posted], fake.nonces), ([FIX_CHANNEL], ["fl2026-W42-1"]))
        self.assertEqual(fake.fix_reads, [(FIX_CHANNEL, f"{dri.FIX_LIST_MARKER} 2026-W42", dri.FIX_LIST_HISTORY)])
        text = fake.posted[0][1]
        for p in (self.p_a, self.p_b, self.p_c, self.p_md):
            self.assertIn(self.link(p), text)
        for p in (self.p_d, self.p_e, self.p_sim, self.p_chat, self.p_ok):
            self.assertNotIn(p.id, text)
        again = self.fix(fake, now=self.NOW + dt.timedelta(days=1))  # Tuesday, same week
        self.assertEqual((again.status, again.posted, again.messages, len(fake.posted)), (dri.FIX_ALREADY, 0, 1, 1))
        forced = self.fix(fake, now=self.NOW + dt.timedelta(days=1), force=True)
        self.assertEqual((forced.status, forced.posted, len(fake.posted)), (dri.FIX_POSTED, 1, 2))
        self.assertEqual(fake.nonces[-1], "fl2026-W42-031700-1")  # its own nonce: a new message
        self.assertEqual(len(fake.fix_reads), 2)  # forced: the channel is not read
        nxt = self.fix(fake, now=self.NOW + dt.timedelta(days=7))
        self.assertEqual((nxt.status, fake.nonces[-1]), (dri.FIX_POSTED, "fl2026-W43-1"))
        self.assertTrue(fake.posted[-1][1].startswith(f"{dri.FIX_LIST_MARKER} 2026-W43（2026/10/19 這週）\n"))
        prefix = dri.fix_list_prefix(self.NOW)
        # A human quoting the marker, or the bot's list of another week, is not this week's list...
        fake = self.fake(history={FIX_CHANNEL: [("U2", prefix + "（引用）"), ("BOT1", dri.FIX_LIST_MARKER + " 2026-W41")]})
        self.assertEqual(self.fix(fake).status, dri.FIX_POSTED)
        # ... and only the newest FIX_LIST_HISTORY messages are read.
        self.assertEqual(dri.FIX_LIST_HISTORY, dri.MESSAGES_PAGE)  # one request
        fake = self.fake(history={FIX_CHANNEL: [("U2", "已修正")] * (dri.FIX_LIST_HISTORY - 1)
                                  + [("BOT1", prefix + "（2026/10/12 這週）")]})
        self.assertEqual((self.fix(fake).status, fake.posted), (dri.FIX_ALREADY, []))
        fake = self.fake(history={FIX_CHANNEL: [("U2", "已修正")] * dri.FIX_LIST_HISTORY
                                  + [("BOT1", prefix + "（2026/10/12 這週）")]})
        self.assertEqual(self.fix(fake).status, dri.FIX_POSTED)

    def test_dry_run_counts_and_never_posts(self) -> None:
        fake = self.fake()
        dry = self.fix(fake, dry_run=True, max_entries=3)
        self.assertEqual((dry.status, dry.dry_run, dry.channel_found, dry.listed, dry.held_by_cap, dry.messages,
                          dry.posted), (dri.FIX_DRY_RUN, True, True, 3, 1, 1, 0))
        self.assertEqual((fake.posted, len(fake.fix_reads)), ([], 1))
        self.assertEqual(self.fix(fake, dry_run=True, force=True).status, dri.FIX_DRY_RUN)
        self.assertEqual(fake.posted, [])
        fake = self.fake(history={FIX_CHANNEL: [("BOT1", dri.fix_list_prefix(self.NOW))]})
        self.assertEqual(self.fix(fake, dry_run=True).status, dri.FIX_ALREADY)

    def test_no_channel_403_and_errors_never_raise(self) -> None:
        fake = self.fake(channels=[])
        none = self.fix(fake)
        self.assertEqual((none.status, none.channel_found, none.entries, none.backlog, none.messages, fake.posted,
                          fake.me_calls), (dri.FIX_NO_CHANNEL, False, 4, 5, 0, [], 0))
        fake = self.fake(forbid_fix=True)
        self.assertEqual((self.fix(fake).status, fake.posted), (dri.FIX_FORBIDDEN, []))
        self.assertEqual(self.fix(fake, force=True).status, dri.FIX_FORBIDDEN)  # 403 on the post itself
        fake = self.fake(fix_error_at=2)
        with mock.patch.object(dri, "fix_list_messages", return_value=[dri.fix_list_prefix(self.NOW) + " a", "b", "c"]):
            partial = self.fix(fake)
        self.assertEqual((partial.status, partial.messages, partial.posted, len(fake.posted)), (dri.FIX_ERROR, 3, 1, 1))
        self.assertEqual(self.fix(self.fake(no_me=True)).status, dri.FIX_ERROR)
        fake = self.fake()
        with mock.patch.object(fake, "guild_channels", side_effect=ValueError("Expecting value")):
            self.assertEqual(self.fix(fake).status, dri.FIX_ERROR)

    def test_summary_lines_are_counts_only(self) -> None:
        lines = "\n".join(dri.fix_list_lines(dri.FixListReport(status=dri.FIX_POSTED, channel_found=True, entries=60,
                                                               listed=50, held_by_cap=10, backlog=80, messages=3, posted=3)))
        self.assertEqual(lines, "- 牌譜修正清單（--fix-list）：已發出\n"
                                "  - 找到頻道：有；30 天內待修正：60 篇，列出：50 篇，超過 --fix-list-max 沒列：10 篇；"
                                "累計待修正（不限天數）：80 篇；清單共 3 則訊息，本次發出 3 則")
        missing = "\n".join(dri.fix_list_lines(dri.FixListReport(status=dri.FIX_NO_CHANNEL, entries=2, listed=2, backlog=2)))
        self.assertIn("找不到「牌譜修正」文字頻道，未發出", missing)
        self.assertIn("找到頻道：沒有", missing)
        self.assertNotIn("超過 --fix-list-max", missing)
        self.assertNotIn("則訊息", missing)  # nothing was built
        statuses = {v for k, v in vars(dri).items() if k.startswith("FIX_") and k not in (
            "FIX_CHANNEL_NAME", "FIX_LIST_MARKER", "FIX_LIST_FOOTER", "FIX_STATUS_TEXT", "FIX_CHANNEL_SKIPS")
            and isinstance(v, str)}
        self.assertEqual(statuses, set(dri.FIX_STATUS_TEXT))
        args = dri.parse_args(["--fix-list"])
        self.assertEqual((args.fix_list, args.fix_list_days, args.fix_list_max, args.fix_list_force), (True, 30, 50, False))
        for bad in (["--fix-list", "--fix-list-max", "0"], ["--fix-list", "--fix-list-days", "0"],
                    ["--fix-list", "--since", "2026-10-01"]):  # --since: the backlog would leave out older posts
            with self.subTest(argv=bad), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dri.parse_args(bad)
        self.assertEqual(dri.parse_args(["--since", "2026-10-01", "--reply"]).since, dt.date(2026, 10, 1))
        self.assertEqual(dri.resolve_fix_channel(self.fake(), dri.GUILD_ID, "１２３"), (None, dri.FIX_BAD_VARIABLE))


class FixTagTest(unittest.TestCase):
    """The 待修正 tag: added to the posts --reply is for, removed once they need no fixing."""
    NOW = dt.datetime(2026, 10, 13, 3, 17, tzinfo=dri.TAIPEI)

    def setUp(self) -> None:
        self.header = dri.import_header([sheet_header()], None)
        at = lambda m, d, h=22: dt.datetime(2026, m, d, h, tzinfo=dri.TAIPEI)  # noqa: E731
        bad_vote = RECENT_BODY.replace("389 +7", "389 7")
        fix = dri.TAG_FIX
        self.p_vote = post(title="1009一般場4", when=at(10, 9))  # fixable; archived
        self.p_names = post(title="1010一般場1", tags=("三藍被刀", "線瓦"), when=at(10, 10))  # fixable
        self.p_tagged = post(title="1011一般場1", tags=("三藍被刀", fix), when=at(10, 11))  # fixable, tagged already
        self.p_full = post(title="1011一般場2", tags=("三藍被刀", "線瓦", "面瓦", "三紅", "三藍躲刺"), when=at(10, 11),
                           offset=1)  # fixable, 5 tags
        self.p_locked = post(title="1011一般場3", when=at(10, 11), offset=2)  # fixable; locked
        self.p_old = post(title="0601一般場1", when=at(6, 1))  # fixable, 133 days old: not tagged
        self.p_old_tagged = post(title="0602一般場1", tags=("三藍被刀", fix), when=at(6, 2))  # ... tagged: keeps it
        self.p_fixed = post(title="0603一般場1", tags=("三紅", fix), when=at(6, 3))  # parses now (any age): loses it
        self.p_imported = post(title="1001一般場1", tags=("三藍被刀", fix), when=at(10, 1))  # in Discord匯入: loses it
        self.p_recorded = post(title="1002一般場1", tags=("三藍被刀", "已收錄", fix), when=at(10, 2))  # loses it
        self.p_sim = post(title="1003一般場1", tags=("模擬", fix), when=at(10, 3))  # loses it
        self.p_deleted = post(title="1004一般場1", tags=("三藍被刀", fix), when=at(10, 4))  # starter deleted: kept
        self.p_chat = post(title="閒聊", tags=(fix,), when=at(10, 5))  # not a record: kept
        self.p_ok = post(title="1005一般場1", tags=("三紅",), when=at(10, 5), offset=1)  # parses, untagged: nothing
        self.posts = [self.p_old, self.p_old_tagged, self.p_fixed, self.p_imported, self.p_recorded, self.p_sim,
                      self.p_deleted, self.p_chat, self.p_ok, self.p_vote, self.p_names, self.p_tagged, self.p_full,
                      self.p_locked]
        self.bodies = {p.id: bad_vote for p in self.posts}
        self.bodies.update({self.p_fixed.id: RED_BODY, self.p_ok.id: RED_BODY, self.p_sim.id: RECENT_BODY,
                            self.p_deleted.id: None, self.p_chat.id: "今天那局大家覺得怎麼樣？",
                            self.p_names.id: RECENT_RECORD + "\n刺客刺殺:\n936758"})
        self.import_rows = [self.header, [self.p_imported.id if h == "discord_post_id" else "" for h in self.header]]
        self.threads: dict = {}  # Discord's side, shared by every fake of a test
        FakeDiscord(self.posts, self.bodies, forum_tags=FORUM_TAGS + [FIX_TAG], threads=self.threads)
        self.threads[self.p_vote.id]["thread_metadata"]["archived"] = True
        self.threads[self.p_locked.id]["thread_metadata"]["locked"] = True
        # Marked 已收錄, then locked and archived by a moderator: the tag goes all the same.
        self.threads[self.p_recorded.id]["thread_metadata"].update(archived=True, locked=True)
        self.tag = {t["name"]: t["id"] for t in FORUM_TAGS + [FIX_TAG]}

    def fake(self, **kw) -> FakeDiscord:
        kw.setdefault("forum_tags", FORUM_TAGS + [FIX_TAG])
        kw.setdefault("threads", self.threads)
        return FakeDiscord(self.posts, self.bodies, **kw)

    def listed(self, fake: FakeDiscord) -> tuple[list[dri.Post], dri.ImportReport]:
        posts, _ = fake.forum_posts(dri.FORUM_CHANNEL_ID)
        report = dri.plan_import(posts, lambda p: self.bodies[p.id], [sheet_header()], self.import_rows, self.header)
        return posts, report

    def run_tags(self, fake: FakeDiscord | None = None, **kw) -> tuple[FakeDiscord, dri.FixTagReport]:
        fake = fake or self.fake()
        posts, report = self.listed(fake)
        kw.setdefault("now", self.NOW)
        kw.setdefault("dry_run", False)
        return fake, dri.tag_fix_posts(fake, posts, report, forum_id=dri.FORUM_CHANNEL_ID, **kw)

    @staticmethod
    def ids(posts) -> list[str]:
        return [p.id for p in posts]

    def test_plan_follows_the_reply_rule(self) -> None:
        posts, report = self.listed(self.fake())
        self.assertEqual((report.already_imported, report.ok_ids),
                         (1, {self.p_imported.id, self.p_fixed.id, self.p_ok.id}))
        plan = dri.plan_fix_tags(posts, report, self.NOW, dri.TAG_DEFAULT_DAYS)
        self.assertEqual(plan.add, [self.p_locked, self.p_full, self.p_names, self.p_vote])  # newest first
        self.assertEqual(plan.remove, [self.p_sim, self.p_recorded, self.p_imported, self.p_fixed])
        self.assertEqual((plan.candidates, plan.already_tagged, plan.untouched), (5, 1, 2))  # deleted, chat
        wide = dri.plan_fix_tags(posts, report, self.NOW, 200)
        self.assertEqual((self.ids(wide.add)[-1], wide.candidates, wide.already_tagged), (self.p_old.id, 7, 2))
        none = dri.plan_fix_tags(posts, report, self.NOW, 0)
        self.assertEqual((none.add, none.candidates, self.ids(none.remove)), ([], 0, self.ids(plan.remove)))
        # The same posts --reply is for, over the tag's window.
        replied = {s.post.id for s in dri.reply_candidates(report, self.NOW, dri.TAG_DEFAULT_DAYS)}
        self.assertEqual(replied, {*self.ids(plan.add), self.p_tagged.id})

    def test_adds_and_removes_that_tag_only(self) -> None:
        fake, tags = self.run_tags()
        t = self.tag
        self.assertEqual(tags.status, dri.TAG_FOUND)
        self.assertEqual(fake.tag_edits, [  # removals first, then additions; every other tag kept, in order
            (self.p_sim.id, [t["模擬"]], False),
            (self.p_recorded.id, [t["三藍被刀"], t["已收錄"]], True),  # locked and archived: removed all the same
            (self.p_imported.id, [t["三藍被刀"]], False),
            (self.p_fixed.id, [t["三紅"]], False),
            (self.p_names.id, [t["三藍被刀"], t["線瓦"], FIX_TAG_ID], False),
            (self.p_vote.id, [t["三藍被刀"], t["線瓦"], FIX_TAG_ID], True),  # archived: archived:false sent with it
        ])
        self.assertEqual(fake.archives, [self.p_recorded.id, self.p_vote.id])  # ... and archived again right after
        for p in (self.p_recorded, self.p_vote):
            self.assertTrue(self.threads[p.id]["thread_metadata"]["archived"])
        self.assertTrue(self.threads[self.p_recorded.id]["thread_metadata"]["locked"])  # still locked
        # The posts the listing shows full (p_full) or locked (p_locked, adding) are not read again.
        self.assertEqual(fake.thread_reads, self.ids([self.p_sim, self.p_recorded, self.p_imported, self.p_fixed,
                                                      self.p_names, self.p_vote]))
        self.assertEqual((tags.candidates, tags.already_tagged, tags.to_add, tags.to_remove), (5, 1, 4, 4))
        self.assertEqual((tags.added, tags.removed, tags.archived, tags.left_open, tags.skipped_full,
                          tags.skipped_locked), (2, 4, 2, 0, 1, 1))
        self.assertEqual((tags.held_by_limit, tags.forbidden, tags.errors, tags.gone, tags.unchanged, tags.untouched),
                         (0, 0, 0, 0, 0, 2))
        self.assertEqual((fake.tag_creates, tags.error_kinds), ([], {}))
        for p in (self.p_old_tagged, self.p_deleted, self.p_chat):  # still need fixing, or cannot be judged
            self.assertIn(FIX_TAG_ID, self.threads[p.id]["applied_tags"])
        self.assertNotIn(FIX_TAG_ID, self.threads[self.p_old.id]["applied_tags"])

        fake, again = self.run_tags()  # the next day: nothing left to change, nothing read again
        self.assertEqual((fake.tag_edits, fake.thread_reads, fake.archives), ([], [], []))
        self.assertEqual((again.candidates, again.already_tagged, again.to_add, again.to_remove), (5, 3, 2, 0))
        self.assertEqual((again.added, again.removed, again.skipped_full, again.skipped_locked), (0, 0, 1, 1))

        fake, unlocked = self.run_tags(allow_locked=True)  # --tag-locked: added to locked posts too
        self.assertEqual(fake.tag_edits, [(self.p_locked.id, [t["三藍被刀"], t["線瓦"], FIX_TAG_ID], False)])
        self.assertEqual((unlocked.added, unlocked.skipped_locked), (1, 0))

    def test_tag_change_rule(self) -> None:
        fix = FIX_TAG_ID
        cases = [  # (applied, add, locked, allow_locked) -> (outcome, new applied_tags)
            ((["1", "2"], True, False, False), (dri.TAG_CHANGE, ["1", "2", fix])),
            ((["1", fix, "2"], False, False, False), (dri.TAG_CHANGE, ["1", "2"])),
            ((["1", fix], True, False, False), (dri.TAG_UNCHANGED, ["1", fix])),
            ((["1"], False, False, False), (dri.TAG_UNCHANGED, ["1"])),
            ((["1"], True, True, False), (dri.TAG_LOCKED, ["1"])),
            ((["1"], True, True, True), (dri.TAG_CHANGE, ["1", fix])),
            ((["1", fix], False, True, False), (dri.TAG_CHANGE, ["1"])),  # removed from a locked post all the same
            ((["1", "2", "3", "4", "5"], True, False, False), (dri.TAG_FULL, ["1", "2", "3", "4", "5"])),
            ((["1", "2", "3", "4", fix], False, False, False), (dri.TAG_CHANGE, ["1", "2", "3", "4"])),
        ]
        for (applied, add, locked, allow), want in cases:
            with self.subTest(applied=applied, add=add, locked=locked, allow=allow):
                self.assertEqual(dri.tag_change(applied, fix, add, locked=locked, allow_locked=allow), want)

    def test_tag_is_created_when_the_forum_lacks_it(self) -> None:
        threads: dict = {}  # a forum without 待修正: no post carries it
        fake, dry = self.run_tags(self.fake(forum_tags=FORUM_TAGS, threads=threads), dry_run=True)
        self.assertEqual((dry.status, fake.tag_creates, fake.tag_edits, fake.thread_reads),
                         (dri.TAG_WOULD_CREATE, [], [], []))
        self.assertEqual((dry.to_add, dry.added, dry.skipped_full, dry.to_remove, dry.removed), (5, 4, 1, 0, 0))
        fake, live = self.run_tags(self.fake(forum_tags=FORUM_TAGS, threads=threads))
        self.assertEqual((live.status, fake.tag_creates, live.added), (dri.TAG_CREATED, [dri.TAG_FIX], 4))
        self.assertTrue(all(edit[1][-1] == FIX_TAG_ID for edit in fake.tag_edits))
        self.assertEqual(dri.tag_id_named(fake.forum_tag_list, dri.TAG_FIX), FIX_TAG_ID)

        fake, denied = self.run_tags(self.fake(forum_tags=FORUM_TAGS, threads={}, forbid_tag_create=True))
        self.assertEqual((denied.status, fake.tag_creates, fake.tag_edits, fake.thread_reads),
                         (dri.TAG_CREATE_FORBIDDEN, [dri.TAG_FIX], [], []))
        self.assertEqual((denied.to_add, denied.added), (5, 0))
        crowded = FORUM_TAGS + [{"id": str(8000 + i), "name": f"其他{i}"} for i in range(dri.MAX_FORUM_TAGS - len(FORUM_TAGS))]
        fake, full = self.run_tags(self.fake(forum_tags=crowded, threads={}))
        self.assertEqual((full.status, fake.tag_edits), (dri.TAG_FORUM_FULL, []))
        fake, broken = self.run_tags(self.fake(tag_read_error=True))
        self.assertEqual((broken.status, fake.tag_edits, fake.thread_reads), (dri.TAG_ERROR, [], []))
        self.assertEqual(broken.error_kinds, {"GET /channels/{forum} HTTP 500": 1})

    def test_limit_counts_changes_removals_first(self) -> None:
        fake, zero = self.run_tags(limit=0)
        self.assertEqual((fake.tag_edits, fake.thread_reads), ([], []))
        # Held: the 6 real changes; the full and the locked post are skipped without taking a slot.
        self.assertEqual((zero.held_by_limit, zero.skipped_full, zero.skipped_locked), (6, 1, 1))
        fake, first = self.run_tags(limit=3)
        self.assertEqual([e[0] for e in fake.tag_edits], self.ids([self.p_sim, self.p_recorded, self.p_imported]))
        self.assertEqual((first.removed, first.added, first.held_by_limit), (3, 0, 3))
        fake, second = self.run_tags(limit=3)  # the rest on the next run
        self.assertEqual([e[0] for e in fake.tag_edits], self.ids([self.p_fixed, self.p_names, self.p_vote]))
        self.assertEqual((second.removed, second.added, second.skipped_locked, second.skipped_full,
                          second.held_by_limit), (1, 2, 1, 1, 0))
        fake, nothing = self.run_tags(limit=0)
        self.assertEqual((fake.tag_edits, fake.thread_reads, nothing.held_by_limit), ([], [], 0))

    def test_403_stops_404_and_errors_are_counted(self) -> None:
        def copy(threads: dict) -> dict:
            return {k: {"applied_tags": list(v["applied_tags"]), "thread_metadata": dict(v["thread_metadata"])}
                    for k, v in threads.items()}
        before = copy(self.threads)  # Discord's side as before any change

        def fresh() -> dict:
            return copy(before)

        fake, denied = self.run_tags(self.fake(forbid_tags=True))
        self.assertEqual((len(fake.tag_edits), denied.forbidden, denied.left_after_forbidden), (1, 1, 5))
        self.assertEqual((denied.added, denied.removed, len(fake.thread_reads)), (0, 0, 1))
        self.assertEqual((denied.skipped_full, denied.skipped_locked), (1, 1))  # not counted as left
        self.assertIn(FIX_TAG_ID, self.threads[self.p_sim.id]["applied_tags"])  # nothing changed

        # A 403 on reading one post is not the missing Manage Threads: an error, and the rest goes on.
        fake, unreadable = self.run_tags(self.fake(threads=fresh(), read_forbidden=[self.p_sim.id]))
        self.assertEqual((unreadable.forbidden, unreadable.left_after_forbidden, unreadable.errors,
                          unreadable.removed, unreadable.added), (0, 0, 1, 3, 2))
        self.assertEqual(unreadable.error_kinds, {"GET /channels/{thread} HTTP 403 code 50001": 1})

        fake, gone = self.run_tags(self.fake(deleted=[self.p_sim.id], deleted_on_patch=[self.p_recorded.id]))
        self.assertEqual((gone.gone, gone.removed, gone.added), (2, 2, 2))
        self.assertNotIn(self.p_sim.id, [e[0] for e in fake.tag_edits])  # deleted before: not even sent
        self.assertEqual(fake.archives, [self.p_vote.id])

        fake, failed = self.run_tags(self.fake(threads=fresh(), tag_error=True))
        self.assertEqual((failed.errors, failed.added, failed.removed, failed.skipped_full, failed.skipped_locked),
                         (6, 0, 0, 1, 1))
        self.assertEqual(failed.error_kinds, {"PATCH /channels/{thread} HTTP 500": 6})
        fake, limited = self.run_tags(self.fake(threads=fresh(), tag_error=True), limit=3)  # errors use up the limit
        self.assertEqual((limited.errors, limited.held_by_limit), (3, 3))
        for odd in ({"applied_tags": "9199", "thread_metadata": {}}, ["not", "a", "thread"]):
            with self.subTest(odd=odd):
                fake = self.fake(threads=fresh())
                with mock.patch.object(fake, "thread", return_value=odd):
                    fake, weird = self.run_tags(fake)
                self.assertEqual((weird.errors, fake.tag_edits), (6, []))
                self.assertEqual(weird.error_kinds, {"GET /channels/{thread} unexpected response": 6})
        fake = self.fake(threads=fresh())
        with mock.patch.object(fake, "set_thread_tags", side_effect=RuntimeError(f"{self.p_sim.id} {LEAK}")):
            fake, crashed = self.run_tags(fake)
        self.assertEqual((crashed.errors, crashed.error_kinds), (6, {"RuntimeError": 6}))  # the type, not the message

        threads = fresh()  # archiving again fails: the tag is changed, the post stays open for now
        fake, open_ = self.run_tags(self.fake(threads=threads, archive_error=True))
        self.assertEqual((open_.added, open_.removed, open_.archived, open_.left_open, open_.errors), (2, 4, 2, 2, 0))
        self.assertEqual(open_.error_kinds, {"PATCH /channels/{thread} HTTP 500": 2})
        self.assertEqual(fake.archives, [self.p_recorded.id, self.p_vote.id])
        self.assertFalse(threads[self.p_vote.id]["thread_metadata"]["archived"])
        self.assertIn(FIX_TAG_ID, threads[self.p_vote.id]["applied_tags"])

    def test_reread_sees_changes_made_meanwhile(self) -> None:
        fake = self.fake()
        posts, report = self.listed(fake)
        self.threads[self.p_names.id]["applied_tags"].append(FIX_TAG_ID)  # tagged by hand after the listing
        self.threads[self.p_sim.id]["applied_tags"].remove(FIX_TAG_ID)  # untagged by hand
        self.threads[self.p_vote.id]["applied_tags"] = [self.tag[n] for n in ("三藍被刀", "線瓦", "面瓦", "三紅", "三藍躲刺")]
        self.threads[self.p_imported.id]["thread_metadata"]["archived"] = True  # archived since the listing
        tags = dri.tag_fix_posts(fake, posts, report, forum_id=dri.FORUM_CHANNEL_ID, now=self.NOW, dry_run=False)
        self.assertEqual((tags.unchanged, tags.skipped_full, tags.added, tags.removed), (2, 2, 0, 3))
        self.assertEqual([e[0] for e in fake.tag_edits], self.ids([self.p_recorded, self.p_imported, self.p_fixed]))
        self.assertTrue(fake.tag_edits[1][2])  # the post as re-read decides archived:false
        self.assertEqual((fake.archives, tags.archived), ([self.p_recorded.id, self.p_imported.id], 2))

    def test_dry_run_counts_from_the_listing(self) -> None:
        fake, dry = self.run_tags(dry_run=True)
        self.assertEqual((fake.tag_edits, fake.thread_reads, fake.tag_creates, fake.archives), ([], [], [], []))
        self.assertEqual((dry.status, dry.added, dry.removed, dry.archived, dry.skipped_full, dry.skipped_locked),
                         (dri.TAG_FOUND, 2, 4, 2, 1, 1))
        self.assertTrue(dry.dry_run)
        fake, limited = self.run_tags(dry_run=True, limit=3)
        self.assertEqual((limited.removed, limited.added, limited.held_by_limit, fake.tag_edits), (3, 0, 3, []))

    def test_summary_lines_are_counts_only(self) -> None:
        live = "\n".join(dri.fix_tag_lines(dri.FixTagReport(
            status=dri.TAG_CREATED, candidates=5, already_tagged=1, to_add=4, to_remove=4, added=2, removed=4,
            archived=1, skipped_full=1, skipped_locked=1, untouched=2)))
        self.assertIn("- 「待修正」標籤（--reply，已更新）：論壇沒有「待修正」標籤，本次已建立", live)
        self.assertIn("90 天內因格式無法解析且未標「已收錄」的貼文 5 篇（已有標籤 1，待加 4）；"
                      "已不需修正但還有標籤（可解析、已收錄或模擬）：4 篇", live)
        self.assertIn("本次已加上：2；已移除：4；標籤已滿 5 個略過：1；超過 --tag-limit 保留到下次：0；沒有權限（403）：0；"
                      "其他 Discord 錯誤：0；已封存的貼文（改標籤時暫時開啟，改完再封存）：1；貼文已鎖定略過：1；"
                      "帶標籤但本次無法判斷、未更動：2", live)
        self.assertNotIn("貼文已刪除", live)
        self.assertNotIn("未能再封存", live)
        live = "\n".join(dri.fix_tag_lines(dri.FixTagReport(status=dri.TAG_FOUND, archived=2, left_open=1)))
        self.assertIn("已封存的貼文（改標籤時暫時開啟，改完再封存）：2；改完後未能再封存（Discord 之後會自動封存）：1", live)
        dry = "\n".join(dri.fix_tag_lines(dri.FixTagReport(dry_run=True, days=30, status=dri.TAG_WOULD_CREATE, added=3,
                                                           held_by_limit=2, forbidden=1, left_after_forbidden=4)))
        self.assertIn("（--reply，dry run：只計數，未更改）：論壇沒有「待修正」標籤（dry run 不建立；寫入時會建立）", dry)
        self.assertIn("30 天內", dry)
        self.assertIn("本次可加上：3；可移除：0；", dry)
        self.assertIn("超過 --tag-limit 保留到下次：2；沒有權限（403）：1（之後停止，留到下次：4）", dry)
        dry = "\n".join(dri.fix_tag_lines(dri.FixTagReport(dry_run=True, status=dri.TAG_FOUND, archived=2)))
        self.assertIn("；目前已封存的貼文（寫入時暫時開啟，改完再封存）：2", dry)
        for status in dri.TAG_SKIPS:
            lines = dri.fix_tag_lines(dri.FixTagReport(status=status, to_add=5))
            self.assertEqual(len(lines), 2)  # what the tag needs, and how many posts wait for it
            self.assertIn(dri.TAG_STATUS_TEXT[status], lines[0])
        self.assertEqual(dri.error_kinds_text(Counter({"b": 1, "a": 2, "c": 1})), "a ×2; b ×1; c ×1")
        self.assertEqual(dri.error_kind(dri.DiscordError(f"x {LEAK}", "GET /x HTTP 500")), "GET /x HTTP 500")
        self.assertEqual(dri.error_kind(dri.DiscordError(f"x {LEAK}")), "DiscordError")
        self.assertEqual(dri.error_kind(ValueError(LEAK)), "ValueError")
        args = dri.parse_args(["--reply"])
        self.assertEqual((args.no_tag, args.tag_since_days, args.tag_limit, args.tag_locked), (False, 90, 30, False))
        args = dri.parse_args(["--reply", "--no-tag", "--tag-since-days", "0", "--tag-limit", "5", "--tag-locked"])
        self.assertEqual((args.no_tag, args.tag_since_days, args.tag_limit, args.tag_locked), (True, 0, 5, True))
        for bad in (["--tag-limit", "-1"], ["--tag-since-days", "x"]):
            with self.subTest(argv=bad), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                dri.parse_args(bad)


def workflow_step_script(name: str) -> str:
    """The `run: |` block of the workflow step called `name`, dedented."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == f"- name: {name}")
    run = next(i for i in range(start, len(lines)) if lines[i].strip() == "run: |")
    body: list[str] = []
    indent = None
    for line in lines[run + 1:]:
        if not line.strip():
            body.append("")
            continue
        width = len(line) - len(line.lstrip())
        indent = width if indent is None else indent
        if width < indent:
            break
        body.append(line[indent:])
    return "\n".join(body)


class WorkflowModeTest(unittest.TestCase):
    """The scheduled run replies, and passes the fix list Monday to Wednesday (Taipei); a manual run
    follows its inputs. DISCORD_IMPORT_REPLY / DISCORD_FIX_LIST = 'false' switch them off for both."""

    def setUp(self) -> None:
        # Not on Windows: bash there may be WSL's (no env passed through, no Windows paths).
        if os.name == "nt" or not WORKFLOW.exists() or not shutil.which("bash"):
            self.skipTest("workflow file or a POSIX bash not available")

    def bash(self, script: str, env: dict[str, str]) -> tuple[subprocess.CompletedProcess, Path]:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        full_env = {"PATH": os.environ.get("PATH", ""), "GITHUB_OUTPUT": str(tmp / "out"), **env}
        proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script],
                              env=full_env, capture_output=True, text=True, encoding="utf-8", cwd=tmp)
        return proc, tmp

    def mode(self, event: str, weekday: int = 4, **env: str) -> dict[str, str]:  # Thursday: no list
        # `date` is stubbed: it records the TZ it was asked in and answers the weekday (%u).
        stub = f'date() {{ printf %s "$TZ" > tz; echo {weekday}; }}\n'
        proc, tmp = self.bash(stub + workflow_step_script("Decide dry run or write"), {"EVENT": event, **env})
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = dict(line.split("=", 1) for line in (tmp / "out").read_text(encoding="utf-8").splitlines())
        if (tmp / "tz").exists():
            out["tz"] = (tmp / "tz").read_text(encoding="utf-8")
        return out

    def test_scheduled_runs(self) -> None:
        # Edward 2026-10-13「應該不用牌譜修正了」: scheduled runs never post the weekly list (manual only),
        # on any weekday and whatever DISCORD_FIX_LIST says; the workflow no longer looks at the date.
        self.assertEqual(self.mode("schedule"), {"write": "true", "limit": "", "reply": "true", "fix_list": "false"})
        for weekday in range(1, 8):
            self.assertEqual(self.mode("schedule", weekday=weekday)["fix_list"], "false")
        self.assertEqual(self.mode("schedule", weekday=1, VAR_FIX_LIST="true")["fix_list"], "false")
        self.assertEqual(self.mode("schedule", VAR_REPLY="false")["reply"], "false")
        self.assertEqual(self.mode("schedule", VAR_REPLY="true")["reply"], "true")
        self.assertEqual(self.mode("schedule", VAR_REPLY="")["reply"], "true")
        paused = self.mode("schedule", VAR_WRITE="false")  # a dry run: replies are counted, not posted
        self.assertEqual((paused["write"], paused["reply"]), ("false", "true"))

    def test_manual_runs_follow_the_inputs(self) -> None:
        default = self.mode("workflow_dispatch", weekday=1, INPUT_WRITE="false", INPUT_REPLY="true", INPUT_FIX_LIST="false")
        self.assertEqual(default, {"write": "false", "limit": "", "reply": "true", "fix_list": "false"})
        on = self.mode("workflow_dispatch", INPUT_WRITE="true", INPUT_REPLY="false", INPUT_FIX_LIST="true",
                       INPUT_LIMIT=" 5 ", VAR_REPLY="true", VAR_FIX_LIST="true", VAR_WRITE="false")
        self.assertEqual(on, {"write": "true", "limit": "5", "reply": "false", "fix_list": "true"})
        # The variables are off switches for manual runs too (the reply box is ticked by default).
        off = self.mode("workflow_dispatch", INPUT_WRITE="true", INPUT_REPLY="true", INPUT_FIX_LIST="true",
                        VAR_REPLY="false", VAR_FIX_LIST="false")
        self.assertEqual(off, {"write": "true", "limit": "", "reply": "false", "fix_list": "false"})
        proc, _ = self.bash(workflow_step_script("Decide dry run or write"), {"EVENT": "workflow_dispatch",
                                                                             "INPUT_LIMIT": "five"})
        self.assertNotEqual(proc.returncode, 0)
        workflow = WORKFLOW.read_text(encoding="utf-8")
        reply_input = workflow.split("      reply:\n", 1)[1].split("      fix_list:\n", 1)[0]
        self.assertIn("default: true", reply_input)  # the manual reply box starts ticked
        self.assertIn("DISCORD_FIX_CHANNEL_ID: ${{ vars.DISCORD_FIX_CHANNEL_ID }}", workflow)

    def test_import_step_passes_the_switches(self) -> None:
        stub = 'python() { printf "%s\\n" "$@" > args; }\n'
        script = stub + workflow_step_script("Import (dry run unless write is on)")
        cases = [
            ({"WRITE": "true", "REPLY": "true", "FIX_LIST": "true"}, ["--reply", "--fix-list"]),
            ({"WRITE": "false", "REPLY": "true", "FIX_LIST": "false", "LIMIT": "5"}, ["--dry-run", "--limit", "5", "--reply"]),
            ({"WRITE": "true", "REPLY": "false", "FIX_LIST": "false"}, []),
        ]
        for env, flags in cases:
            with self.subTest(env=env):
                proc, tmp = self.bash(script, env)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                args = (tmp / "args").read_text(encoding="utf-8").split("\n")[:-1]
                self.assertEqual(args, ["packages/server/discord_records_import.py", *flags])


class EndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.summary = Path(self.tmp.name) / "summary.md"
        header = sheet_header()
        old_game = sheet_row(header, "1", "012543", RED_BODY.split("刺客")[0].strip(), NAMES_B, "三紅")
        self.tabs = {"牌譜": [header, old_game]}
        self.posts = [
            post(offset=0),  # new
            post(title="1009一般場5", tags=("三紅", "已收錄"), offset=1),  # already in 牌譜
            post(title="1009一般場6", tags=("三藍被刀",), offset=2),  # names missing
        ]
        self.bodies = {self.posts[0].id: RECENT_BODY, self.posts[1].id: RED_BODY,
                       self.posts[2].id: RECENT_RECORD + "\n刺客刺殺:\n936758"}
        self.opened_scopes: list = []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_main(self, *args: str, deny_writes: bool = False, ci: bool = True,
                 write_error: Exception | None = None, env_extra: dict | None = None,
                 now: dt.datetime = dt.datetime(2026, 10, 10, 3, 17, tzinfo=dri.TAIPEI), **discord_kw) -> tuple[int, str]:
        sheet = self.sheet = FakeSheet(self.tabs, deny_writes, write_error)

        def open_sheet(source, sheet_id, scopes):
            self.opened_scopes.append(scopes)
            return sheet
        env = {gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY), dri.ENV_DISCORD_TOKEN: "TOKEN",
               "GITHUB_STEP_SUMMARY": str(self.summary), **(env_extra or {})}
        if ci:
            env["GITHUB_ACTIONS"] = "true"
        self.discord = FakeDiscord(self.posts, self.bodies, **discord_kw)
        out = io.StringIO()
        with quiet_env(**env), redirect_stdout(out), redirect_stderr(out):
            try:
                rc = dri.run(dri.parse_args(list(args)), open_sheet=open_sheet, discord=self.discord, now=now)
            except gc.FatalError as exc:
                gc.emit_error(str(exc), exc.title)
                rc = exc.exit_code
        return rc, out.getvalue()

    def refresh_cache(self, path: Path, as_of: str) -> tuple[int, str]:
        """The 03:47 workflow: generate_cache.py (in GitHub Actions) on this run's Sheet."""
        chem = [["", "甲"], ["甲", ""]]
        tabs = {**self.tabs, **{t: chem for t in ("同贏", "同輸", "贏相關", "同贏-同輸")}}
        summary = Path(self.tmp.name) / "cache_summary.md"
        summary.unlink(missing_ok=True)  # this run's job summary only
        env = {gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY), gc.ENV_AS_OF: as_of, "GITHUB_ACTIONS": "true",
               "GITHUB_STEP_SUMMARY": str(summary)}
        out = io.StringIO()
        with quiet_env(**env), \
                mock.patch.object(gc, "open_spreadsheet", lambda source, sheet_id: FakeSheet(tabs)), \
                mock.patch.object(gc, "gspread", mock.Mock(exceptions=mock.Mock(WorksheetNotFound=WorksheetNotFound))), \
                mock.patch.object(gc, "default_strength_builder", lambda: (lambda players: {"perPlayer": {}})), \
                mock.patch.object(gc, "default_placeholder_builders", lambda: {}), \
                redirect_stdout(out), redirect_stderr(out):
            rc = gc.main(["--compare", "--output", str(path)])
            if rc == 0:
                rc = gc.main(["--output", str(path)])
        return rc, out.getvalue() + (summary.read_text(encoding="utf-8") if summary.exists() else "")

    def assert_public_safe(self, text: str) -> None:
        for secret in NAMES + NAMES_B + ["1009一般場", "5680 7+", "15678", "SECRET-MARKER",
                                         "389 7", dri.REPLY_MARKER, dri.REPLY_INTRO, "格式提示"]:
            self.assertNotIn(secret, text)

    def test_reply_mode_posts_once_and_logs_counts_only(self) -> None:
        self.posts.append(post(title="1009一般場7", offset=3))  # bad vote on line 3
        self.bodies[self.posts[3].id] = RECENT_BODY.replace("389 +7", "389 7")
        self.posts.append(post(title="1009一般場8", tags=("模擬",), offset=4))  # never replied to
        self.bodies[self.posts[4].id] = "nonsense"
        self.posts.append(post(title="覆盤", tags=(), offset=5))  # a discussion, not a record: never replied to
        self.bodies[self.posts[5].id] = "今天那局大家覺得怎麼樣？"
        rc, log = self.run_main("--dry-run", "--reply")  # counts, posts nothing
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.discord.posted, [])
        self.assertEqual(self.discord.message_reads, [self.posts[2].id, self.posts[3].id])
        self.assertIn("格式回覆（--reply，dry run：只計數，未貼文）：14 天內因格式無法解析且未標「已收錄」的貼文 2 篇", log)
        self.assertIn("本次可回覆：2", log)
        self.assertIn(f"| {dri.SKIP_NOT_A_RECORD} | 1 | 0 |", log)
        self.assertNotIn("::warning", log)
        self.assertNotIn(dri.REPLY_LOG_TAB, self.tabs)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main("--reply")  # write + reply
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.tabs["Discord匯入"]), 2)
        self.assertEqual([t for t, _ in self.discord.posted], [self.posts[2].id, self.posts[3].id])
        self.assertIn("第 3 行「389 7」", self.discord.posted[1][1])
        self.assertIn("本次已回覆：2；沒有發言權限（403）：0", log)
        self.assertEqual(self.tabs[dri.REPLY_LOG_TAB], [  # one row per reply posted
            list(dri.REPLY_LOG_COLUMNS),
            [self.posts[2].id, "2026-10-10 03:17:00", dri.SKIP_NAMES_MISSING],
            [self.posts[3].id, "2026-10-10 03:17:00", dri.SKIP_BAD_VOTE],
        ])
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("本次已回覆：2", summary)
        self.assertLess(summary.index("已寫入 1 列"), summary.index("本次已回覆：2"))  # the import summary first
        self.assert_public_safe(log + summary)

        rc, log = self.run_main("--reply", replied=[self.posts[2].id, self.posts[3].id])  # next day: once only
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.discord.posted, [])
        self.assertIn("已回覆過（略過）：2；本次已回覆：0", log)

        rc, log = self.run_main("--reply")  # the bot's messages were deleted: Discord回覆 still remembers them
        self.assertEqual(rc, 0, log)
        self.assertEqual((self.discord.posted, self.discord.message_reads), ([], []))
        self.assertIn("已回覆過（略過）：2；本次已回覆：0", log)
        self.assertEqual(len(self.tabs[dri.REPLY_LOG_TAB]), 3)

        del self.tabs[dri.REPLY_LOG_TAB]  # before the tab existed: the marker check alone
        rc, log = self.run_main("--reply", "--reply-limit", "1", "--reply-since-days", "3")
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.discord.posted), 1)
        self.assertEqual(len(self.tabs[dri.REPLY_LOG_TAB]), 2)
        self.assertIn("3 天內", log)
        self.assertIn("超過 --reply-limit 保留到下次：1", log)

        del self.tabs[dri.REPLY_LOG_TAB]
        rc, log = self.run_main("--reply", forbid_post=True)  # no permission: warned, counted, exit 0
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.discord.posted, [])
        self.assertNotIn(dri.REPLY_LOG_TAB, self.tabs)
        self.assertIn("沒有發言權限（403）：2", log)
        self.assertIn("::warning title=Discord reply forbidden::2 reply/replies not posted (HTTP 403)", log)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main("--reply", post_error=True, ci=False)
        self.assertEqual(rc, 0, log)
        self.assertIn("其他 Discord 錯誤：2", log)
        self.assertIn("[WARNING] Discord reply errors: 2 reply/replies", log)

        rc, log = self.run_main()  # without --reply nothing is read or posted
        self.assertEqual((self.discord.me_calls, self.discord.message_reads, self.discord.posted), (0, [], []))
        self.assertNotIn("格式回覆", log)

    def test_reply_log_write_failure_only_warns(self) -> None:
        rc, log = self.run_main("--reply")
        self.assertEqual(rc, 0, log)
        del self.tabs[dri.REPLY_LOG_TAB]
        # Nothing new to import, so only the log tab is written -- and that fails.
        rc, log = self.run_main("--reply", write_error=APIError(500, "Internal error encountered: 小米"))
        self.assertEqual(rc, 0, log)
        self.assertEqual([t for t, _ in self.discord.posted], [self.posts[2].id])
        self.assertNotIn(dri.REPLY_LOG_TAB, self.tabs)
        self.assertIn("本次已回覆：1", log)
        self.assertIn("::warning title=Discord reply log not written::1 reply/replies posted but not recorded in "
                      "Discord回覆 (APIError)", log)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))

    def test_reply_skipped_when_a_deciding_tag_is_missing(self) -> None:
        rc, log = self.run_main("--reply", missing=["已收錄"])  # renamed: recorded posts cannot be told apart
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.tabs["Discord匯入"]), 2)  # the import itself went ahead
        self.assertEqual((self.discord.me_calls, self.discord.message_reads, self.discord.posted), (0, [], []))
        self.assertNotIn(dri.REPLY_LOG_TAB, self.tabs)
        self.assertIn("論壇沒有這些預期的標籤（改名了？）：已收錄", log)
        self.assertIn("格式回覆（--reply）：論壇沒有「已收錄」標籤，無法判斷哪些貼文該回覆，本次未回覆、未計數", log)
        self.assertIn("::warning title=Forum tags missing::1 expected forum tag(s) not found", log)
        self.assertIn("::warning title=Discord reply skipped::1 forum tag(s) that decide which posts get a reply", log)
        self.assertNotIn("本次已回覆", log)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))
        for tag in ("模擬", "三藍被刀"):
            with self.subTest(tag=tag):
                rc, log = self.run_main("--reply", missing=[tag])
                self.assertEqual((rc, self.discord.posted), (0, []))
                self.assertIn(f"論壇沒有「{tag}」標籤", log)
        rc, log = self.run_main("--reply", missing=["面瓦"])  # a category tag decides nothing: replies go ahead
        self.assertEqual(rc, 0, log)
        self.assertEqual([t for t, _ in self.discord.posted], [self.posts[2].id])
        self.assertIn("::warning title=Forum tags missing::1 expected forum tag(s) not found", log)
        self.assertNotIn("Discord reply skipped", log)

    def test_import_summary_survives_the_reply_phase(self) -> None:
        rc, log = self.run_main("--reply", odd_error=True)  # a 200 with a non-JSON body while reading a thread
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.tabs["Discord匯入"]), 2)
        self.assertIn("已寫入 1 列", log)
        self.assertIn("其他 Discord 錯誤：1", log)
        self.assertIn("::warning title=Discord reply errors::1 reply/replies hit a Discord API error or an unexpected "
                      "response", log)
        self.assertNotIn("Expecting value", log)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))
        self.summary.write_text("", encoding="utf-8")
        with mock.patch.object(dri, "reply_to_failures", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                self.run_main("--reply")
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("### Discord 牌譜匯入（已寫入 0 列）", summary)  # the import summary was out before the crash
        self.assertIn("已在 Discord匯入（同一貼文，不再讀取）：1", summary)

    def test_fix_list_posts_weekly_and_logs_counts_only(self) -> None:
        bad = self.posts[2]  # 1009一般場6, names missing
        link = f"https://discord.com/channels/{dri.GUILD_ID}/{bad.id}"

        def public_safe(log: str) -> None:
            self.assert_public_safe(log)
            for secret in ("discord.com/channels", dri.FIX_LIST_MARKER, FIX_CHANNEL, *(p.id for p in self.posts)):
                self.assertNotIn(secret, log)
            self.assertNotIn("::error", log)

        rc, log = self.run_main("--dry-run", "--fix-list")
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.discord.posted, [])
        self.assertIn("- 牌譜修正清單（--fix-list）：dry run：只計數，未發出", log)
        self.assertIn("找到頻道：有；30 天內待修正：1 篇，列出：1 篇；累計待修正（不限天數）：1 篇；清單共 1 則訊息，本次發出 0 則",
                      log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        self.summary.write_text("", encoding="utf-8")
        rc, log = self.run_main("--fix-list")
        self.assertEqual(rc, 0, log)
        self.assertEqual([t for t, _ in self.discord.posted], [FIX_CHANNEL])
        posted = self.discord.posted[0][1]
        self.assertTrue(posted.startswith(f"{dri.FIX_LIST_MARKER} 2026-W41（2026/10/05 這週）\n"))
        self.assertIn(f"\n1. 2026/10/09 第 6 場：玩家名單不完整 {link}\n", posted)
        self.assertIn("- 牌譜修正清單（--fix-list）：已發出", log)
        self.assertIn("清單共 1 則訊息，本次發出 1 則", log)
        summary = self.summary.read_text(encoding="utf-8")
        self.assertLess(summary.index("已寫入 1 列"), summary.index("牌譜修正清單"))
        public_safe(log + summary)

        rc, log = self.run_main("--fix-list", history={FIX_CHANNEL: [("BOT1", posted)]})  # later that week
        self.assertEqual((rc, self.discord.posted), (0, []))
        self.assertIn("- 牌譜修正清單（--fix-list）：本週已發過，略過", log)
        rc, log = self.run_main("--fix-list", "--fix-list-force", history={FIX_CHANNEL: [("BOT1", posted)]})
        self.assertEqual(len(self.discord.posted), 1)

        rc, log = self.run_main("--fix-list", channels=[])  # the channel is not created yet
        self.assertEqual((rc, self.discord.posted), (0, []))
        self.assertIn("找不到「牌譜修正」文字頻道，未發出", log)
        self.assertIn("::notice title=Fix list skipped::No usable channel for the weekly fix list (no_channel): create "
                      "a text channel named 牌譜修正 or set the repository variable DISCORD_FIX_CHANNEL_ID. 1 post(s)", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))
        rc, log = self.run_main("--fix-list", forbid_fix=True)
        self.assertEqual((rc, self.discord.posted), (0, []))
        self.assertIn("::notice title=Fix list skipped::The bot may not read or post in the fix-list channel (HTTP 403): "
                      "give it View Channel, Send Messages and Read Message History there.", log)
        rc, log = self.run_main("--fix-list", fix_error_at=1, ci=False)
        self.assertEqual((rc, self.discord.posted), (0, []))
        self.assertIn("[WARNING] Fix list error: Discord API error or unexpected response; 0 of 1 message(s)", log)

        rc, log = self.run_main("--fix-list", env_extra={dri.ENV_FIX_CHANNEL: "7777"},
                                channels=[guild_channel("7777", "修正區")])
        self.assertEqual(([t for t, _ in self.discord.posted], self.discord.guild_calls), (["7777"], 0))
        public_safe(log.replace("7777", ""))
        for value in ("#牌譜修正", "8888"):  # not an id; no such channel
            with self.subTest(variable=value):
                rc, log = self.run_main("--fix-list", env_extra={dri.ENV_FIX_CHANNEL: value})
                self.assertEqual((rc, self.discord.posted), (0, []))
                self.assertIn("::notice title=Fix list skipped::The repository variable DISCORD_FIX_CHANNEL_ID does not "
                              "name a text channel the bot can see", log)
                self.assertNotIn("create a text channel", log)
                self.assertNotIn(value, log.replace("DISCORD_FIX_CHANNEL_ID", ""))
        self.assertNotIn("7777", log)

        rc, log = self.run_main("--fix-list", missing=["已收錄"])  # cannot tell which posts were recorded
        self.assertEqual((rc, self.discord.posted, self.discord.fix_reads), (0, [], []))
        self.assertIn("牌譜修正清單（--fix-list）：論壇沒有「已收錄」標籤，無法判斷哪些貼文要修正，本次未發出、未計數", log)
        self.assertIn("::warning title=Fix list skipped::1 forum tag(s) that decide which posts need fixing", log)
        self.assertNotIn("Discord reply skipped", log)
        self.assertNotIn("格式回覆", log)

        rc, log = self.run_main("--reply", "--fix-list")  # both: the thread reply and the list
        self.assertEqual(rc, 0, log)
        self.assertEqual([t for t, _ in self.discord.posted], [bad.id, FIX_CHANNEL])
        self.assertEqual(self.discord.me_calls, 2)  # the fake does not cache; the real client asks once
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main()  # without --fix-list the channel is not even looked up
        self.assertEqual((self.discord.guild_calls, self.discord.fix_reads, self.discord.posted), (0, [], []))
        self.assertNotIn("牌譜修正清單", log)

    def test_fix_tag_follows_the_reply_and_logs_counts_only(self) -> None:
        bad = self.posts[2]  # 1009一般場6, names missing: needs fixing
        fixed = post(title="1009一般場7", tags=("三紅", dri.TAG_FIX), offset=3)  # that game is in 牌譜 now
        self.posts.append(fixed)
        self.bodies[fixed.id] = RED_BODY
        forum_tags = FORUM_TAGS + [FIX_TAG]
        tag = {t["name"]: t["id"] for t in forum_tags}
        threads: dict = {}  # Discord's side, across the runs

        def public_safe(log: str) -> None:
            self.assert_public_safe(log)
            for p in self.posts:
                self.assertNotIn(p.id, log)
            self.assertNotIn(LEAK, log)  # the fakes' error messages: only their kind may be printed
            self.assertNotIn("::error", log)

        rc, log = self.run_main("--dry-run", "--reply", forum_tags=forum_tags, threads=threads)
        self.assertEqual(rc, 0, log)
        self.assertEqual((self.discord.tag_edits, self.discord.thread_reads, self.discord.tag_creates), ([], [], []))
        self.assertIn("- 「待修正」標籤（--reply，dry run：只計數，未更改）：論壇已有「待修正」標籤", log)
        self.assertIn("90 天內因格式無法解析且未標「已收錄」的貼文 1 篇（已有標籤 0，待加 1）；"
                      "已不需修正但還有標籤（可解析、已收錄或模擬）：1 篇", log)
        self.assertIn("本次可加上：1；可移除：1；標籤已滿 5 個略過：0；超過 --tag-limit 保留到下次：0；沒有權限（403）：0", log)
        self.assertNotIn("::warning", log)
        self.assertNotIn("::notice", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        self.summary.write_text("", encoding="utf-8")
        rc, log = self.run_main("--reply", forum_tags=forum_tags, threads=threads)
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.discord.tag_edits, [(fixed.id, [tag["三紅"]], False),
                                                  (bad.id, [tag["三藍被刀"], FIX_TAG_ID], False)])
        self.assertIn("- 「待修正」標籤（--reply，已更新）：論壇已有「待修正」標籤", log)
        self.assertIn("本次已加上：1；已移除：1；", log)
        summary = self.summary.read_text(encoding="utf-8")
        self.assertLess(summary.index("本次已回覆："), summary.index("「待修正」標籤"))
        public_safe(log + summary)

        rc, log = self.run_main("--reply", forum_tags=forum_tags, threads=threads)  # the next day: nothing to change
        self.assertEqual((rc, self.discord.tag_edits), (0, []))
        self.assertIn("（已有標籤 1，待加 0）；已不需修正但還有標籤（可解析、已收錄或模擬）：0 篇", log)
        for argv in (["--reply", "--no-tag"], []):  # --no-tag, or no --reply: the tag is not even looked up
            with self.subTest(argv=argv):
                rc, log = self.run_main(*argv, forum_tags=forum_tags, threads=threads)
                self.assertEqual((rc, self.discord.tag_reads, self.discord.thread_reads, self.discord.tag_edits),
                                 (0, 0, [], []))
                self.assertNotIn("「待修正」標籤", log)

        rc, log = self.run_main("--reply", threads={})  # the forum lacks the tag: created, then used
        self.assertEqual((rc, self.discord.tag_creates), (0, [dri.TAG_FIX]))
        self.assertEqual(self.discord.tag_edits, [(bad.id, [tag["三藍被刀"], FIX_TAG_ID], False)])
        self.assertIn("論壇沒有「待修正」標籤，本次已建立", log)
        self.assertNotIn("::notice", log)

        rc, log = self.run_main("--reply", threads={}, forbid_tag_create=True)  # ... and may not be created
        self.assertEqual((rc, self.discord.tag_edits), (0, []))
        self.assertIn("論壇沒有「待修正」標籤，bot 沒有權限建立（403），本次未加標籤", log)
        self.assertIn("::notice title=To-fix tag missing::The forum #牌譜紀錄與覆盤 has no tag named 待修正 and the bot "
                      "may not create it (HTTP 403; creating a forum tag needs Manage Channels). The owner should add a "
                      "tag named exactly 待修正 in the forum's settings (Edit Channel > Tags); posts are tagged from the "
                      "next run on. 1 post(s) would have been tagged.", log)
        self.assertNotIn("::warning", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main("--reply", forum_tags=forum_tags, threads={}, forbid_tags=True)  # no Manage Threads
        self.assertEqual((rc, len(self.discord.tag_edits)), (0, 1))  # stopped at the first 403
        self.assertIn("沒有權限（403）：1（之後停止，留到下次：1）", log)
        self.assertIn("::notice title=To-fix tag forbidden::The bot may not change post tags (HTTP 403): give it "
                      "管理討論串 (Manage Threads) on #牌譜紀錄與覆盤. Tag changes stopped for this run; 2 tag change(s) "
                      "not made, tried again on the next run.", log)
        self.assertNotIn("::warning", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        # A 403 on reading a post again: an error with its kind, not the Manage Threads notice.
        rc, log = self.run_main("--reply", forum_tags=forum_tags, threads={}, read_forbidden=[fixed.id])
        self.assertEqual((rc, [e[0] for e in self.discord.tag_edits]), (0, [bad.id]))
        self.assertIn("本次已加上：1；已移除：0；", log)
        self.assertNotIn("::notice", log)
        self.assertIn("::warning title=To-fix tag errors::1 tag change(s) hit a Discord API error or an unexpected "
                      "response (tried again on the next run). Errors: GET /channels/{thread} HTTP 403 code 50001 ×1.",
                      log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main("--reply", forum_tags=forum_tags, threads={}, tag_error=True, ci=False)
        self.assertEqual(rc, 0, log)
        self.assertIn("其他 Discord 錯誤：2", log)
        self.assertIn("[WARNING] To-fix tag errors: 2 tag change(s) hit a Discord API error or an unexpected response "
                      "(tried again on the next run). Errors: PATCH /channels/{thread} HTTP 500 ×2.", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))
        rc, log = self.run_main("--reply", tag_read_error=True)
        self.assertEqual((rc, self.discord.tag_edits), (0, []))
        self.assertIn("::warning title=To-fix tag error::Reading or creating the forum tag 待修正 hit a Discord API "
                      "error or an unexpected response (GET /channels/{forum} HTTP 500 ×1); no post tag was changed.", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        archived = {fixed.id: {"applied_tags": [tag["三紅"], FIX_TAG_ID],  # fixed, archived months ago
                               "thread_metadata": {"archived": True, "locked": False}}}
        rc, log = self.run_main("--reply", forum_tags=forum_tags, threads=archived, archive_error=True)
        self.assertEqual((rc, self.discord.tag_edits[0]), (0, (fixed.id, [tag["三紅"]], True)))
        self.assertIn("已封存的貼文（改標籤時暫時開啟，改完再封存）：1；改完後未能再封存（Discord 之後會自動封存）：1", log)
        self.assertIn("::warning title=To-fix tag errors::1 archived post(s) got their tag changed but could not be "
                      "archived again (Discord archives them after inactivity). Errors: PATCH /channels/{thread} "
                      "HTTP 500 ×1.", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main("--reply", missing=["已收錄"], forum_tags=forum_tags, threads={})
        self.assertEqual((rc, self.discord.tag_reads, self.discord.tag_edits), (0, 0, []))
        self.assertIn("- 「待修正」標籤：論壇沒有「已收錄」標籤，無法判斷哪些貼文要修正，本次未更動、未計數", log)
        self.assertIn("no reply was posted or counted, no 待修正 tag changed. See the job summary.", log)
        public_safe(log + self.summary.read_text(encoding="utf-8"))

    def test_dry_run_then_write_then_idempotent(self) -> None:
        rc, log = self.run_main("--dry-run")
        self.assertEqual(rc, 0, log)
        self.assertNotIn("Discord匯入", self.tabs)  # nothing created
        self.assertEqual(self.opened_scopes, [None])  # read-only scope
        self.assertIn("- 讀取起始訊息：3；完整解析：2", log)
        self.assertIn("已在 牌譜（指紋相同）：1", log)
        self.assertIn("新局：1", log)
        self.assertIn(f"| {dri.SKIP_NAMES_MISSING} | 1 | 0 |", log)
        self.assertIn("寫入時會建立", log)
        summary = self.summary.read_text(encoding="utf-8")
        self.assert_public_safe(log + summary)

        rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.opened_scopes[-1], dri.WRITE_SCOPES)
        tab = self.tabs["Discord匯入"]
        self.assertEqual(tab[0], dri.import_header([sheet_header()], None))
        self.assertEqual(len(tab), 2)
        self.assertEqual(tab[1][tab[0].index("discord_post_id")], self.posts[0].id)
        self.assertEqual(tab[1][tab[0].index("匯入時間")], "2026-10-10 03:17:00")
        self.assertEqual(len(self.tabs["牌譜"]), 2)  # 牌譜 untouched
        self.assertIn("已寫入 1 列", log)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))

        rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.tabs["Discord匯入"]), 2)  # nothing new
        self.assertIn("已在 Discord匯入（同一貼文，不再讀取）：1", log)
        self.assertIn("已寫入 0 列", log)

    def test_a_corrected_post_updates_its_import_row(self) -> None:
        """The question asked: a post imported weeks ago gets a wrong player fixed -- does the daily
        import pick it up? Yes: its Discord匯入 row is rewritten in place; 牌譜 is never written."""
        self.assertEqual(self.run_main()[0], 0)
        tab = self.tabs["Discord匯入"]
        header = tab[0]
        tab[1][header.index("note")] = "=SUM(1,2)"  # a person's cell (a formula): never written
        imported = list(tab[1])
        self.bodies[self.posts[0].id] = FIXED_BODY
        edits = {self.posts[0].id: utc(2026, 10, 10, 0)}  # after the import (2026-10-09 19:17 UTC)

        rc, log = self.run_main("--dry-run", edits=edits)
        self.assertEqual(rc, 0, log)
        self.assertIn("有修改、dry run，會更新：1 篇（1 列）", log)
        self.assertEqual(tab[1], imported)

        rc, log = self.run_main(edits=edits)
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(tab), 2)  # rewritten in place, nothing appended
        self.assertEqual(tab[1][header.index("玩4")], "Mona")
        self.assertEqual(tab[1][header.index("匯入時間")], imported[header.index("匯入時間")])
        self.assertEqual(tab[1][header.index("note")], "=SUM(1,2)")
        changed = sorted(header.index(h) for h in ("玩4", "組成", "discord_hash", "更新時間"))
        self.assertEqual(self.sheet.writes, [f"{dri.column_letters(a + 1)}2:{dri.column_letters(b + 1)}2"
                                             for a, b in dri.column_runs(changed)])  # those cells only
        self.assertEqual((self.sheet.batches, self.sheet.reads), (1, [f"col {header.index('discord_post_id') + 1}"]))
        self.assertEqual(len(self.tabs["牌譜"]), 2)  # 牌譜 untouched
        summary = self.summary.read_text(encoding="utf-8")
        self.assertIn("有修改、已更新：1 篇（1 列）", log)
        self.assertIn("有修改、已更新：1 篇（1 列）", summary)
        self.assert_public_safe(log + summary)
        self.assertNotIn("Mona", log + summary)
        merged = gc.merge_game_logs(self.tabs["牌譜"], tab)  # what the 03:47 cache refresh reads
        self.assertEqual(merged.games[-1].seat_players["4"], "Mona")

        rc, log = self.run_main(edits=edits)  # the day after: nothing left to do
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.sheet.writes, [])
        self.assertIn("沒有修改：1", log)

    def test_a_tab_from_before_gets_the_new_columns_on_its_first_write(self) -> None:
        legacy = [h for h in dri.import_header([sheet_header()], None) if h not in dri.LATE_COLUMNS]
        p = self.posts[0]
        row = dri.build_row(p, dri.parse_post(p, RECENT_BODY), legacy, "2026-10-09 23:00:00")
        self.tabs["Discord匯入"] = [list(legacy), row]
        self.bodies[p.id] = FIXED_BODY
        rc, log = self.run_main(edits={p.id: utc(2026, 10, 9, 18)})  # 2026-10-10 02:00 Taipei: after that import
        self.assertEqual(rc, 0, log)
        tab = self.tabs["Discord匯入"]
        self.assertEqual(tab[0], legacy + list(dri.LATE_COLUMNS))
        self.assertEqual(self.sheet.grid_cols["Discord匯入"], len(legacy) + 2)  # the grid grew first
        header = tab[0]
        self.assertEqual((tab[1][header.index("玩4")], tab[1][header.index("更新時間")]), ("Mona", "2026-10-10 03:17:00"))
        self.assertEqual(tab[1][header.index("discord_hash")], dri.post_signature(p, FIXED_BODY))
        first, *rest = self.sheet.writes
        self.assertEqual(first, dri.column_letters(len(legacy) + 1) + "1")  # the header cells, then the row
        written = {c for r in rest for c in range(a1_cell(r.split(":")[0])[1], a1_cell(r.split(":")[1])[1] + 1)}
        self.assertEqual({header[c] for c in written}, {"玩4", "組成", "discord_hash", "更新時間"})
        self.assertTrue(all(r.endswith("2") for r in rest))

    def test_a_corrected_name_passes_the_next_cache_refresh(self) -> None:
        """A corrected player id takes a game away from the wrong name: the 03:47 refresh must still
        write (its shrink guard knows the rewritten row), and its public log names nobody."""
        path = Path(self.tmp.name) / "analysis_cache.json"
        self.assertEqual(self.run_main()[0], 0)
        rc, log = self.refresh_cache(path, "2026-10-10")
        self.assertEqual(rc, 0, log)
        before = json.loads(path.read_text(encoding="utf-8"))
        self.assertIn("Momo", before["playerDetails"])

        self.bodies[self.posts[0].id] = FIXED_BODY  # Momo -> Mona, seven weeks later
        later = dt.datetime(2026, 12, 1, 3, 17, tzinfo=dri.TAIPEI)
        rc, log = self.run_main(edits={self.posts[0].id: utc(2026, 11, 30)}, now=later)
        self.assertEqual(rc, 0, log)
        rc, log = self.refresh_cache(path, "2026-12-01")
        self.assertEqual(rc, 0, log)
        after = json.loads(path.read_text(encoding="utf-8"))
        self.assertNotIn("Momo", after["playerDetails"])
        self.assertEqual(after["playerDetails"]["Mona"]["player"]["totalGames"], 1)
        self.assertEqual(after["overview"]["totalGames"], before["overview"]["totalGames"])
        self.assertIn("Discord匯入 有 1 列因貼文修改而改寫：1 個名字的局數因此減少", log)
        self.assert_public_safe(log)
        self.assertNotIn("Mona", log)

        # The day after, the existing cache already has it: nothing to excuse, nothing refused.
        rc, log = self.refresh_cache(path, "2026-12-02")
        self.assertEqual(rc, 0, log)
        self.assertNotIn("因貼文修改而改寫", log)

        # A drop the rewritten row cannot explain (a 牌譜 game deleted the same day) is still refused.
        self.tabs["牌譜"] = self.tabs["牌譜"][:1]
        rc, log = self.refresh_cache(path, "2026-12-03")
        self.assertEqual(rc, gc.EXIT_DATA, log)
        self.assertIn("overview.totalGames would drop from 2 to 1 (1 fewer) (1 Discord匯入 row(s) rewritten from "
                      "edited posts since the existing cache do not explain it)", log)
        self.assert_public_safe(log)

    def test_a_discord_error_while_re_reading_still_imports_new_posts(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        new = post(title="1009一般場7", offset=7)
        self.posts.append(new)
        self.bodies[new.id] = RECENT_BODY.replace("147\n260", "148\n260", 1)  # another game
        reread = FakeDiscord.starter_message

        def failing(fake, thread_id):  # the re-read of the imported post fails; the new post is read
            if thread_id == self.posts[0].id:
                raise dri.DiscordError(f"GET /channels/{{thread}}/messages/{{thread}}: HTTP 503 {LEAK}", "GET message 503")
            return reread(fake, thread_id)
        with mock.patch.object(FakeDiscord, "starter_message", failing):
            rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(self.tabs["Discord匯入"]), 3)  # the new post went in
        self.assertIn("::warning title=Discord re-read stopped::", log)
        self.assertIn("GET message 503", log)
        self.assertNotIn(LEAK, log)
        self.assert_public_safe(log + self.summary.read_text(encoding="utf-8"))

    def test_a_comment_only_edit_is_counted_once(self) -> None:
        self.assertEqual(self.run_main()[0], 0)
        tab = self.tabs["Discord匯入"]
        header, imported = tab[0], list(tab[1])
        self.bodies[self.posts[0].id] = COMMENTED_BODY
        edits = {self.posts[0].id: utc(2026, 10, 10, 0)}
        rc, log = self.run_main(edits=edits)
        self.assertEqual(rc, 0, log)
        self.assertIn("有修改但這局的資料沒變：1", log)
        hash_col = header.index("discord_hash")
        self.assertEqual(self.sheet.writes, [f"{dri.column_letters(hash_col + 1)}2:{dri.column_letters(hash_col + 1)}2"])
        self.assertEqual([c for c, (a, b) in enumerate(zip(imported, tab[1])) if a != b], [hash_col])
        rc, log = self.run_main(edits=edits)  # the day after: not an edit any more
        self.assertEqual(rc, 0, log)
        self.assertIn("有修改但這局的資料沒變：0；沒有修改：1", log)
        self.assertEqual(self.sheet.writes, [])

    def test_a_row_moved_meanwhile_is_not_overwritten(self) -> None:
        """Someone sorts Discord匯入 while the run reads Discord: the planned row now holds another
        post, so it is left alone (and rewritten on the next run)."""
        second = post(title="1009一般場8", offset=8)
        self.posts.append(second)
        self.bodies[second.id] = RECENT_BODY.replace("147\n260", "149\n260", 1)  # another game
        self.assertEqual(self.run_main()[0], 0)
        tab = self.tabs["Discord匯入"]
        self.assertEqual(len(tab), 3)
        snapshot = [list(r) for r in tab]
        self.bodies[self.posts[0].id] = FIXED_BODY
        edits = {self.posts[0].id: utc(2026, 10, 10, 0)}
        reread = FakeDiscord.starter_message

        def sorting(fake, thread_id):  # the tab is re-sorted after it was read
            if not fake.rereads:
                tab[1], tab[2] = tab[2], tab[1]
            return reread(fake, thread_id)
        with mock.patch.object(FakeDiscord, "starter_message", sorting):
            rc, log = self.run_main(edits=edits)
        self.assertEqual(rc, 0, log)
        self.assertEqual(sorted(tab[1:]), sorted(snapshot[1:]))  # nothing overwritten
        self.assertEqual(self.sheet.writes, [])
        self.assertIn("讀取後那一列的位置變了", log)
        self.assertIn("::warning title=Discord匯入 rows moved::1 row(s)", log)
        rc, log = self.run_main(edits=edits)  # the next run finds the row where it is now
        self.assertEqual(rc, 0, log)
        header = tab[0]
        row = next(r for r in tab[1:] if r[header.index("discord_post_id")] == self.posts[0].id)
        self.assertEqual(row[header.index("玩4")], "Mona")

    def test_403_on_write_names_the_service_account_and_editor(self) -> None:
        rc, log = self.run_main(deny_writes=True)
        self.assertEqual(rc, gc.EXIT_GOOGLE_ACCESS, log)
        self.assertIn("::error title=Service account needs Editor on the Google Sheet::", log)
        self.assertIn(f"Share the Google Sheet with {FAKE_KEY['client_email']} as Editor", log)
        self.assertNotIn("Discord匯入", self.tabs)
        self.assert_public_safe(log)
        self.tabs["Discord匯入"] = [dri.import_header([sheet_header()], None)]  # tab exists, append denied
        rc, log = self.run_main(deny_writes=True)
        self.assertEqual(rc, gc.EXIT_GOOGLE_ACCESS, log)
        self.assertIn("as Editor", log)
        self.assertEqual(len(self.tabs["Discord匯入"]), 1)

    def test_empty_existing_tab_gets_its_header(self) -> None:
        self.tabs["Discord匯入"] = []  # created earlier, header write never happened
        rc, log = self.run_main()
        self.assertEqual(rc, 0, log)
        self.assertEqual(self.tabs["Discord匯入"][0], dri.import_header([sheet_header()], None))
        self.assertEqual(len(self.tabs["Discord匯入"]), 2)

    def test_other_write_errors_do_not_echo_google_messages(self) -> None:
        rc, log = self.run_main(write_error=APIError(400, "Invalid value at data.values[0][5]: 小米 15678 5- 39+"))
        self.assertEqual(rc, gc.EXIT_GOOGLE_ACCESS, log)
        self.assertIn("::error title=Google Sheets write failed::Writing to Discord匯入 failed (APIError, HTTP 400)", log)
        self.assert_public_safe(log)

    def test_bad_import_header_and_ci_report_refused(self) -> None:
        self.tabs["Discord匯入"] = [["流水號", "文字記錄"]]
        rc, log = self.run_main("--dry-run")
        self.assertEqual(rc, gc.EXIT_DATA, log)
        self.assertIn("lacks column(s)", log)
        rc, log = self.run_main("--dry-run", "--report", str(Path(self.tmp.name) / "r.json"))
        self.assertEqual(rc, gc.EXIT_CONFIG)
        del self.tabs["Discord匯入"]
        report = Path(self.tmp.name) / "r.json"
        rc, log = self.run_main("--dry-run", "--report", str(report), ci=False)
        self.assertEqual(rc, 0, log)
        details = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual([d["outcome"] for d in details], ["new", "already in 牌譜", f"skipped: {dri.SKIP_NAMES_MISSING}"])

    def test_missing_token(self) -> None:
        out = io.StringIO()
        with quiet_env(), redirect_stdout(out), redirect_stderr(out):
            rc = dri.main(["--dry-run"])
        self.assertEqual(rc, gc.EXIT_CONFIG)
        self.assertIn("DISCORD_BOT_TOKEN is not set", out.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
