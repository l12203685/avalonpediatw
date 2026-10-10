"""Offline tests for discord_records_import.py and the Discord匯入 union in generate_cache.py.

No network and no Google libraries needed (stdlib unittest; pytest also collects it).
Fixtures use made-up names. Two groups read the checked-in 牌譜 snapshot in
sheets_cache.json (2146 games, 2026-04-03): DerivedColumnsProofTest proves how the
sheet's derived columns follow from 文字記錄, SnapshotCoverageTest measures how many of
those records the strict post parser accepts and that each one dedupes to its 牌譜 row.

    python packages/server/test_discord_records_import.py
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
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
        row = dict(zip(header, dri.build_row(p, game, header, "2026-10-10 03:17:00")))
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
            "匯入時間": "2026-10-10 03:17:00",
        }
        self.assertEqual(row, expected)
        self.assertEqual(header[-4:], list(dri.EXTRA_COLUMNS))

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
        self.sleeps: list[float] = []

        def opener(request, timeout):
            self.calls.append(request.full_url.replace(dri.DISCORD_API, ""))
            self.assertEqual(request.get_header("Authorization"), "Bot TOKEN")
            result = script(self.calls[-1], len(self.calls))
            if isinstance(result, Exception):
                raise result
            return result
        return dri.DiscordClient("TOKEN", opener=opener, sleep=self.sleeps.append, pace=0)

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
            dri.ENV_DISCORD_TOKEN)
    env = {k: v for k, v in os.environ.items() if k not in drop}
    env.update(extra)
    return mock.patch.dict(os.environ, env, clear=True)


class FakeWorksheet:
    def __init__(self, rows, owner):
        self.rows = rows
        self.owner = owner

    def get_all_values(self):
        return [list(r) for r in self.rows]

    def update(self, values, range_name, raw=True):
        self.owner.check_write()
        assert range_name == "A1" and raw and len(values) == 1
        self.rows[:1] = [list(values[0])]

    def append_rows(self, values, value_input_option, insert_data_option, table_range):
        self.owner.check_write()
        assert (value_input_option, insert_data_option, table_range) == ("RAW", "INSERT_ROWS", "A1")
        self.rows.extend(list(r) for r in values)


class FakeSheet:
    def __init__(self, tabs, deny_writes: bool = False, write_error: Exception | None = None):
        self.tabs = tabs
        self.deny_writes = deny_writes
        self.write_error = write_error

    def check_write(self):
        if self.deny_writes:  # what gspread 6 raises for HTTP 403
            raise PermissionError from APIError(403, "The caller does not have permission")
        if self.write_error is not None:
            raise self.write_error

    def worksheet(self, name):
        if name not in self.tabs:
            raise WorksheetNotFound(name)
        return FakeWorksheet(self.tabs[name], self)

    def add_worksheet(self, title, rows, cols):
        self.check_write()
        assert title not in self.tabs
        self.tabs[title] = []
        return FakeWorksheet(self.tabs[title], self)


class FakeDiscord:
    def __init__(self, posts, bodies):
        self.posts, self.bodies, self.fetched = posts, bodies, 0

    def forum_posts(self, forum_id):
        return list(self.posts), []

    def starter_content(self, thread_id):
        self.fetched += 1
        return self.bodies[thread_id]


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
                 write_error: Exception | None = None) -> tuple[int, str]:
        sheet = FakeSheet(self.tabs, deny_writes, write_error)

        def open_sheet(source, sheet_id, scopes):
            self.opened_scopes.append(scopes)
            return sheet
        env = {gc.ENV_CREDENTIALS_JSON: json.dumps(FAKE_KEY), dri.ENV_DISCORD_TOKEN: "TOKEN",
               "GITHUB_STEP_SUMMARY": str(self.summary)}
        if ci:
            env["GITHUB_ACTIONS"] = "true"
        out = io.StringIO()
        with quiet_env(**env), redirect_stdout(out), redirect_stderr(out):
            try:
                rc = dri.run(dri.parse_args(list(args)), open_sheet=open_sheet,
                             discord=FakeDiscord(self.posts, self.bodies),
                             now=dt.datetime(2026, 10, 10, 3, 17, tzinfo=dri.TAIPEI))
            except gc.FatalError as exc:
                gc.emit_error(str(exc), exc.title)
                rc = exc.exit_code
        return rc, out.getvalue()

    def assert_public_safe(self, text: str) -> None:
        for secret in NAMES + NAMES_B + ["1009一般場", "5680 7+", "15678", "SECRET-MARKER"]:
            self.assertNotIn(secret, text)

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
        self.assertIn("::error title=Google Sheets write failed::Appending to Discord匯入 failed (APIError, HTTP 400)", log)
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
