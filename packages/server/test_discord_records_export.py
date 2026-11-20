"""Offline tests for discord_records_export.py (the website's 牌譜紀錄 list).

No network and no Google libraries needed (stdlib unittest; pytest also collects it). Synthetic
posts with made-up names (玩家A … 玩家J).

    python packages/server/test_discord_records_export.py
"""

from __future__ import annotations

import datetime as dt
from collections import Counter
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import discord_records_export as dpe  # noqa: E402
import discord_records_import as dri  # noqa: E402
import generate_cache as gc  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-analysis-cache.yml"
NAMES = [f"玩家{c}" for c in "ABCDEFGHIJ"]  # seats 1..9, 0
GUILD = "1132682489840812113"
FORUM = "1132683080134578276"

# 配置 936758: 刺 9, 娜 3, 德 6, 奧 7, 派 5, 梅 8. Blue wins rounds 1, 3 and 4; red round 2.
RECORD = """147
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
8>4 x
15678 -5 +39
14580
ooooo"""


def body(record: str = RECORD, config: str = "936758", assassin: str = "刺客刺殺:3",
         names: list[str] = NAMES) -> str:
    lines = [record, assassin, config] + [f"{s}.{n}" for s, n in zip(gc.SEATS, names)]
    return "\n".join(line for line in lines if line)


def post(day: int, hour: int, title: str, tags: tuple[str, ...] = ()) -> dri.Post:
    when = dt.datetime(2026, 10, day, hour, 0, tzinfo=dri.TAIPEI)
    return dri.Post(id=dri.snowflake_at(when), title=title, tags=tags)


GAME = post(25, 23, "1025一般場6", ("三藍躲刺", "線瓦"))
BROKEN = post(26, 22, "1026一般場1", ("三紅",))
SIM = post(27, 21, "1027模擬", ("模擬", "三紅"))
CHAT = post(24, 20, "這週的場地")
EMPTY_TAGGED = post(23, 20, "1023直播局2 22:42 三紅", ("三紅",))
EMPTY_PLAIN = post(22, 20, "公告")

BODIES = {
    GAME.id: body(),
    BROKEN.id: body(RECORD.replace("1458\n", "1458 hello\n")),
    SIM.id: body(),
    CHAT.id: "大家這週要去哪裡打？",
    EMPTY_TAGGED.id: "",
    EMPTY_PLAIN.id: "",
}


class FakeDiscord:
    def __init__(self, posts=(GAME, BROKEN, SIM, CHAT, EMPTY_TAGGED, EMPTY_PLAIN), bodies=None, fail=False):
        self.posts = list(posts)
        self.bodies = dict(BODIES if bodies is None else bodies)
        self.fetched: list[str] = []
        self.fail = fail

    def forum_posts(self, forum_id):
        if self.fail:
            raise dri.DiscordError("GET /channels/{forum}: HTTP 403 (bot cannot see the forum)")
        return list(self.posts), []

    def forum_guild_id(self, forum_id):
        return GUILD

    def starter_content(self, thread_id):
        self.fetched.append(thread_id)
        return self.bodies.get(thread_id)


def build(discord: FakeDiscord | None = None):
    discord = discord or FakeDiscord()
    return dpe.build_records(discord.posts, lambda p: discord.starter_content(p.id), guild_id=GUILD, forum_id=FORUM)


class BuildTest(unittest.TestCase):
    def test_parsed_game_entry(self) -> None:
        doc, _ = build()
        entry = next(p for p in doc["posts"] if p["id"] == GAME.id)
        self.assertEqual(entry["title"], "1025一般場6")
        self.assertEqual(entry["tags"], ["三藍躲刺", "線瓦"])
        self.assertEqual(entry["created"], "2026-10-25T23:00:00+08:00")
        self.assertEqual(entry["date"], "2026-10-25")
        self.assertNotIn("problem", entry)
        game = entry["game"]
        self.assertEqual(game["config"], "936758")
        self.assertEqual(game["names"], NAMES)
        self.assertEqual(game["outcome"], gc.OUTCOME_BLUE_ALIVE)
        self.assertEqual(game["assassination"], "3")
        self.assertEqual(game["category"], "線瓦")
        self.assertEqual([r["mission"] for r in game["rounds"]], ["ooo", "ooox", "oooo", "ooooo"])
        self.assertEqual(game["rounds"][0]["proposals"][2], {"team": "389", "votes": ["7+"]})
        self.assertEqual(game["rounds"][3]["proposals"][0], {"team": "15678", "votes": ["5-", "39+"]})
        self.assertEqual(game["lakes"], [
            {"after": 2, "holder": "0", "target": "8", "claim": "o"},
            {"after": 3, "holder": "8", "target": "4", "claim": "x"},
        ])

    def test_left_out_and_unreadable_posts(self) -> None:
        discord = FakeDiscord()
        doc, status = build(discord)
        ids = [p["id"] for p in doc["posts"]]
        self.assertNotIn(SIM.id, ids)  # forum 模擬 = 百科AI games: counted separately, not listed
        self.assertNotIn(SIM.id, discord.fetched)  # ... not even read
        self.assertEqual(status["simulation"], 1)
        self.assertNotIn(CHAT.id, ids)  # a discussion post, not a record
        self.assertNotIn(EMPTY_PLAIN.id, ids)  # empty and nothing says it is a record
        broken = next(p for p in doc["posts"] if p["id"] == BROKEN.id)
        self.assertIsNone(broken["game"])
        self.assertEqual(broken["problem"], dri.short_explanation(dri.SKIP_UNRECOGNIZED))
        self.assertEqual(broken["problemLine"], 14)
        self.assertEqual(broken["date"], "2026-10-26")
        empty = next(p for p in doc["posts"] if p["id"] == EMPTY_TAGGED.id)
        self.assertEqual(empty["problem"], dri.short_explanation(dri.SKIP_EMPTY))
        self.assertNotIn("problemLine", empty)
        self.assertEqual(empty["date"], "2026-10-23")
        self.assertEqual(status["not a record"], 2)
        self.assertEqual(doc["counts"], {"posts": 3, "games": 1, "unreadable": 2})

    def test_newest_first_and_no_raw_text(self) -> None:
        doc, _ = build()
        self.assertEqual([p["id"] for p in doc["posts"]], [BROKEN.id, GAME.id, EMPTY_TAGGED.id])
        text = dpe.dump_records(doc)
        self.assertNotIn("hello", text)  # the unreadable line itself is never stored
        self.assertNotIn("刺客刺殺", text)
        self.assertNotIn("場地", text)
        self.assertEqual(json.loads(text), doc)
        self.assertEqual(text.count("\n"), 9 + len(doc["posts"]))  # one post per line

    def test_bot_games_are_left_out(self) -> None:
        # 有百科AI 的局另外算（Edward 2026-11-03）：沒有「模擬」標籤但座位有百科AI 的貼文，清單同「模擬」一樣不列
        names = ["百科AI_1"] + NAMES[1:]
        bot = post(28, 21, "含百科機器人_20261028_2100_Room-1417_936758", ("線瓦",))
        doc, status = build(FakeDiscord([GAME, bot], {GAME.id: body(), bot.id: body(names=names)}))
        self.assertEqual([p["id"] for p in doc["posts"]], [GAME.id])
        self.assertEqual(status["simulation"], 1)
        self.assertEqual(dpe.records_problems(doc), [])

    def test_titles_and_names_are_one_plain_line(self) -> None:
        odd = post(20, 20, "1020​一般場\n3\t" + "長" * 200, ("三藍被刀",))
        names = list(NAMES)
        names[0] = "玩家​A"
        doc, _ = build(FakeDiscord([odd], {odd.id: body(assassin="刺客刺殺:8", names=names)}))
        entry = doc["posts"][0]
        self.assertTrue(entry["title"].startswith("1020一般場 3 長"))
        self.assertEqual(len(entry["title"]), dpe.TITLE_MAX)
        self.assertEqual(entry["game"]["names"][0], "玩家A")
        self.assertEqual(entry["game"]["outcome"], gc.OUTCOME_BLUE_DEAD)
        self.assertEqual(dpe.records_problems(doc), [])


def has(problems: list[str], name: str) -> bool:
    return any(p == name or p.startswith(name + " (") for p in problems)


class ShapeCheckTest(unittest.TestCase):
    def test_built_document_passes(self) -> None:
        doc, _ = build()
        self.assertEqual(dpe.records_problems(doc), [])

    def test_unexpected_fields_and_free_text_fail(self) -> None:
        doc, _ = build()
        doc["posts"][1]["text"] = "the whole starter message"
        self.assertTrue(has(dpe.records_problems(doc), "post keys"))
        doc, _ = build()
        next(p for p in doc["posts"] if p["id"] == BROKEN.id)["problem"] = "第 14 行寫了 hello"
        self.assertTrue(has(dpe.records_problems(doc), "problem text"))
        doc, _ = build()
        next(p for p in doc["posts"] if p["id"] == GAME.id)["game"]["names"][2] = "玩家C\n下一行"
        self.assertTrue(has(dpe.records_problems(doc), "names shape"))
        doc, _ = build()
        next(p for p in doc["posts"] if p["id"] == GAME.id)["game"]["rounds"][0]["proposals"][0]["votes"] = ["好隊"]
        self.assertTrue(has(dpe.records_problems(doc), "proposal shape"))
        doc, _ = build()
        next(p for p in doc["posts"] if p["id"] == GAME.id)["game"]["comment"] = "覆盤心得"
        self.assertTrue(has(dpe.records_problems(doc), "game keys"))

    def test_order_counts_and_simulations_fail(self) -> None:
        doc, _ = build()
        doc["posts"].reverse()
        self.assertTrue(has(dpe.records_problems(doc), "post order"))
        doc, _ = build()
        doc["counts"]["games"] = 3
        self.assertTrue(has(dpe.records_problems(doc), "counts"))
        doc, _ = build()
        next(p for p in doc["posts"] if p["id"] == GAME.id)["tags"].append("模擬")
        self.assertTrue(has(dpe.records_problems(doc), "simulation post"))
        doc, _ = build()
        next(p for p in doc["posts"] if p["id"] == GAME.id)["sim"] = True  # a Discord post is never a 模擬 entry
        self.assertTrue(has(dpe.records_problems(doc), "simulation post"))


class ShrinkTest(unittest.TestCase):
    def doc(self, n: int) -> dict:
        return {"posts": [{} for _ in range(n)]}

    def test_small_drops_pass_large_ones_fail(self) -> None:
        self.assertIsNone(dpe.shrink_problem(None, self.doc(0)))
        self.assertIsNone(dpe.shrink_problem(self.doc(20), self.doc(15)))  # 5 fewer: allowed
        self.assertIsNotNone(dpe.shrink_problem(self.doc(20), self.doc(14)))
        self.assertIsNone(dpe.shrink_problem(self.doc(500), self.doc(450)))  # 10%
        self.assertIsNotNone(dpe.shrink_problem(self.doc(500), self.doc(449)))


class RunTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name) / "records_cache.json"

    def run_main(self, discord: FakeDiscord | None, *argv: str, env: dict | None = None) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        environment = {"DISCORD_BOT_TOKEN": "token-marker"} if env is None else env
        with redirect_stdout(out), redirect_stderr(err), \
                mock.patch.object(dpe.dri, "DiscordClient", lambda token: discord):
            with mock.patch.dict("os.environ", environment, clear=True):
                rc = dpe.main(["--output", str(self.out), "--games", str(self.out.parent / "no_games.json"), *argv])
        return rc, out.getvalue() + err.getvalue()

    def test_writes_then_unchanged_and_logs_counts_only(self) -> None:
        rc, log = self.run_main(FakeDiscord())
        self.assertEqual(rc, 0, log)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(doc["counts"]["posts"], 3)
        self.assertIn("已寫入（0 → 3 局）", log)
        for secret in ("玩家", "一般場", "直播局", "token-marker", "hello"):
            self.assertNotIn(secret, log)
        rc, log = self.run_main(FakeDiscord())
        self.assertEqual(rc, 0, log)
        self.assertIn("沒有變動", log)

    def test_missing_token_is_a_configuration_error(self) -> None:
        rc, log = self.run_main(None, env={})
        self.assertEqual(rc, gc.EXIT_CONFIG)
        self.assertIn("DISCORD_BOT_TOKEN", log)
        self.assertFalse(self.out.exists())

    def test_discord_error_keeps_the_file(self) -> None:
        self.out.write_text("previous\n", encoding="utf-8")
        rc, log = self.run_main(FakeDiscord(fail=True))
        self.assertEqual(rc, dri.EXIT_DISCORD, log)
        self.assertEqual(self.out.read_text(encoding="utf-8"), "previous\n")

    def test_shrink_guard_and_override(self) -> None:
        many = [post(1 + i % 20, 10 + i // 20, f"10{1 + i % 20:02d}一般場{i}", ("三紅",)) for i in range(30)]
        rc, _ = self.run_main(FakeDiscord(many, {}))
        self.assertEqual(rc, 0)
        rc, log = self.run_main(FakeDiscord(many[:20], {}))
        self.assertEqual(rc, gc.EXIT_DATA, log)
        self.assertEqual(len(json.loads(self.out.read_text(encoding="utf-8"))["posts"]), 30)
        rc, log = self.run_main(FakeDiscord(many[:20], {}), "--allow-shrink")
        self.assertEqual(rc, 0, log)
        self.assertEqual(len(json.loads(self.out.read_text(encoding="utf-8"))["posts"]), 20)


# ---------------------------------------------------------------------------
# lineup / mistakes annotations (Edward 2026-10-31)
# ---------------------------------------------------------------------------

import test_generate_cache as tgc  # noqa: E402  (its synthetic 牌譜 helpers)

POOL = NAMES + ["玩家K", "玩家L"]
SMALL = {**gc.RATING_CONFIG, "lineupMinGames": 5, "lineupActiveDays": 3, "lineupMinPool": 12}
# 配置 936758 (reds 9, 3, 6, 7): R1 369 fails; R2 3690 holds all of it, three blues (1, 2, 0) approve and it goes.
MISTAKE_RECORD = """147
258
389
468
369
oox
3690 12+
ooox
3678
ooox"""
MISTAKE_POST = post(21, 22, "1021一般場1", ("三紅",))
OTHER_POST = post(19, 22, "1019一般場2", ("三藍躲刺",))


def games_doc() -> tuple[dict, list]:
    """36 games, two a day from 2026-10-02, 12 invented players; the last one is GAME's record (2026-10-20)."""
    rows = [tgc.LOG_HEADERS] + [
        tgc.log_row(f"E{i}", tgc.rot_config(i), ("三紅", "三藍活", "三藍死")[i % 3], [POOL[(i + j) % 12] for j in range(10)],
                    date=(dt.date(2026, 10, 2) + dt.timedelta(days=i // 2)).isoformat())
        for i in range(35)
    ]
    last = tgc.log_row("E35", "936758", "三藍活", NAMES, date="2026-10-20", text=RECORD, kill="3")
    for column, cell in zip(tgc.ROUND_RESULT_COLS, ("ooo", "ooox", "oooo", "ooooo")):
        last[tgc.LOG_HEADERS.index(column)] = cell
    rows.append(last)
    games = tgc.run_like_games(rows, as_of=dt.date(2026, 10, 31))
    return gc.encode_games_dataset(games), games


class AnnotateTest(unittest.TestCase):
    def doc(self) -> dict:
        posts = (GAME, BROKEN, MISTAKE_POST, OTHER_POST)
        bodies = {**BODIES, MISTAKE_POST.id: body(MISTAKE_RECORD, assassin=""),
                  OTHER_POST.id: body(RECORD.replace("1458\n", "1459\n"), names=POOL[2:12])}
        return build(FakeDiscord(posts, bodies))[0]

    def test_bot_games_take_no_part_in_lineups(self) -> None:
        # 資料集最後面的百科AI 局（分類 百科AI）不參與陣容強度的重放：結果同沒有那幾局
        dataset, games = games_doc()
        bot_rows = [tgc.LOG_HEADERS] + [
            tgc.log_row(f"B{i}", tgc.rot_config(i), "三紅", ["百科AI_1"] + [POOL[(i + j) % 12] for j in range(1, 10)],
                        date="2026-10-19", category=gc.BOT_CATEGORY) for i in range(6)]
        bots = gc.merge_game_logs(bot_rows, None).bot_games
        self.assertEqual(len(bots), 6)
        with_bots = gc.encode_games_dataset(games, None, bots)
        plain, mixed = self.doc(), self.doc()
        dpe.annotate_records(plain, dataset, SMALL)
        dpe.annotate_records(mixed, with_bots, SMALL)
        self.assertEqual(mixed, plain)

    def test_lineups_matched_and_by_names(self) -> None:
        doc = self.doc()
        dataset, games = games_doc()
        counts = dpe.annotate_records(doc, dataset, SMALL)
        by_id = {p["id"]: p for p in doc["posts"]}
        lineups, _ = gc.compute_lineups(games, SMALL)
        # GAME is the dataset's last game (same 配置, teams and missions): its pre-game lineup.
        self.assertEqual(by_id[GAME.id]["lineup"], dpe.lineup_entry(lineups[-1]))
        # OTHER is not in the dataset: its names at the start of 10/19.
        names = [x for x in POOL[2:12]]
        _, answers = gc.compute_lineups(games, SMALL, queries=[("2026-10-19", names)])
        self.assertEqual(by_id[OTHER_POST.id]["lineup"], dpe.lineup_entry(answers[0]))
        self.assertNotIn("lineup", by_id[BROKEN.id])
        self.assertEqual((counts["matched"], counts["by names"]), (1, 2))  # MISTAKE_POST is by names too
        self.assertEqual(dpe.records_problems(doc), [])
        lu = by_id[GAME.id]["lineup"]
        self.assertEqual(list(lu), ["pool", "s", "prs", "prov"])
        self.assertEqual(lu["s"], gc.rnd1(sum(lu["prs"]) / 10))

    def test_mistakes(self) -> None:
        doc = self.doc()
        counts = dpe.annotate_records(doc, None)
        by_id = {p["id"]: p for p in doc["posts"]}
        self.assertEqual(by_id[MISTAKE_POST.id]["mistakes"], [
            [gc.MISTAKE_SERIOUS, 0, ""], [gc.MISTAKE_BLUE_APPROVE, 2, "120"], [gc.MISTAKE_PROVEN_SENT, 2, "3690"]])
        self.assertNotIn("mistakes", by_id[GAME.id])  # Merlin saying the opposite on the lake is not one
        self.assertNotIn("lineup", by_id[GAME.id])  # no dataset: no lineups
        self.assertEqual(counts[gc.MISTAKE_SERIOUS], 1)
        self.assertEqual(dpe.records_problems(doc), [])
        self.assertEqual(dpe.annotation_lines(counts),
                         ["- 陣容強度：0 篇（對到資料集 0、用名字算 0）；失誤標籤：嚴重失誤 1、已證有紅的隊出任務 1、藍方贊成已證有紅的隊 1"])
        # Annotating again replaces, never stacks.
        dpe.annotate_records(doc, None)
        self.assertEqual(len(by_id[MISTAKE_POST.id]["mistakes"]), 3)

    def test_shape_check(self) -> None:
        doc = self.doc()
        dpe.annotate_records(doc, games_doc()[0], SMALL)
        game = next(p for p in doc["posts"] if p["id"] == GAME.id)
        game["lineup"]["prs"][0] = 101
        self.assertTrue(has(dpe.records_problems(doc), "lineup shape"))
        doc = self.doc()
        dpe.annotate_records(doc, None)
        mistake = next(p for p in doc["posts"] if p["id"] == MISTAKE_POST.id)
        mistake["mistakes"][1][0] = "3 號亂投"
        self.assertTrue(has(dpe.records_problems(doc), "mistakes shape"))
        doc = self.doc()
        next(p for p in doc["posts"] if p["id"] == BROKEN.id)["mistakes"] = [[gc.MISTAKE_SERIOUS, 0, ""]]
        self.assertTrue(has(dpe.records_problems(doc), "annotation on an unreadable or 模擬 post"))

    def test_site_knows_every_tag(self) -> None:
        site = (ROOT / "packages" / "web" / "src" / "utils" / "records.ts").read_text(encoding="utf-8")
        for tag in gc.MISTAKE_TAGS:
            self.assertIn(f"tag: '{tag}'" if tag != gc.MISTAKE_SERIOUS else f"SERIOUS_MISTAKE = '{tag}'", site)

    def test_annotate_only(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out, gpath = Path(tmp.name) / "records_cache.json", Path(tmp.name) / "games_cache.json"
        doc = self.doc()
        doc["format"] = dpe.LEGACY_RECORDS_FORMAT  # a file written before the rename
        out.write_text(dpe.dump_records(doc), encoding="utf-8")
        gpath.write_text(gc.dump_games_dataset(games_doc()[0]), encoding="utf-8")
        log = io.StringIO()
        with redirect_stdout(log), mock.patch.dict(gc.RATING_CONFIG, SMALL), mock.patch.dict("os.environ", {}, clear=True):
            rc = dpe.main(["--output", str(out), "--games", str(gpath), "--annotate-only"])
        self.assertEqual(rc, 0, log.getvalue())
        written = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(written["format"], dpe.RECORDS_FORMAT)
        self.assertEqual(sum(1 for p in written["posts"] if "lineup" in p), 3)
        self.assertIn("陣容強度：3 篇", log.getvalue())
        for secret in ("玩家", "一般場"):
            self.assertNotIn(secret, log.getvalue())


# ---------------------------------------------------------------------------
# one database: Discord + the sheet's 牌譜 and 模擬瓦 tabs (Edward 2026-11-16)
# ---------------------------------------------------------------------------

import records_merge as rm  # noqa: E402

SHEET_ONLY_RECORD = RECORD.replace("147\n260", "148\n260")  # a different game (first team differs)


def sheet_doc() -> dict:
    """Three 牌譜-tab games: 101 = GAME's record (same fingerprint), 102 = another game, 103 = broken."""
    def row(gid: str, text: str, missions=("ooo", "ooox", "oooo", "ooooo"), date: str = "2026-10-20") -> list[str]:
        r = tgc.log_row(gid, "936758", "三藍活", NAMES, date=date, text=text, kill="3", category="線瓦")
        for column, cell in zip(tgc.ROUND_RESULT_COLS, list(missions) + [""] * 5):
            r[tgc.LOG_HEADERS.index(column)] = cell
        r[tgc.LOG_HEADERS.index("首湖")], r[tgc.LOG_HEADERS.index("二湖")] = "0>8", "8>4"
        return r

    rows = [tgc.LOG_HEADERS, row("101", RECORD), row("102", SHEET_ONLY_RECORD, date="2026-10-24"),
            row("103", RECORD.replace("ooox\n", "oooxo\n"), missions=("ooo", "oooxo", "oooo", "ooooo"))]
    return gc.encode_games_dataset(tgc.run_like_games(rows, as_of=dt.date(2026, 10, 31)))


SIM_ROWS = [
    {"流水號": "1", "文字記錄": "158\n458 2+\n130\n467\n359\nooo", "配置": "840216", "刺殺": "",
     "日期時間": "2023-06-27T00:00:00", **{f"玩{s}": n for s, n in zip("12345", NAMES)}},
    {"流水號": "2", "文字記錄": "147\n280\n134\n469\n456\nooo\n1357\n2468", "配置": "718942",
     "日期時間": "2023/6/28"},  # stops mid-round 2
    {"流水號": "3", "文字記錄": "168\n578 2+\n369\n569\n156\n589\noox", "配置": "801467"},  # 6 proposals
    {"流水號": "", "文字記錄": ""},  # an empty row at the bottom of the tab
]


class MergeTest(unittest.TestCase):
    def merged(self) -> tuple[dict, Counter]:
        doc, _ = build()
        return doc, dpe.merge_sheet(doc, sheet_doc(), SIM_ROWS)

    def test_sheet_game_converts_like_the_discord_parse(self) -> None:
        doc, _ = build()
        dc_game = next(p for p in doc["posts"] if p["id"] == GAME.id)["game"]
        entries, counts = rm.sheet_entries(sheet_doc())
        s101 = next(e for e in entries if e["id"] == "S101")
        self.assertEqual(s101["game"]["rounds"], dc_game["rounds"])  # 7+, 5- 39+ marks from the approvers
        self.assertEqual(s101["game"]["lakes"], dc_game["lakes"])
        self.assertEqual((s101["game"]["outcome"], s101["game"]["assassination"]), (gc.OUTCOME_BLUE_ALIVE, "3"))
        self.assertEqual(s101["game"]["names"], NAMES)
        self.assertEqual(rm.game_fingerprint(s101["game"]), dpe.entry_fingerprint(dc_game))
        s103 = next(e for e in entries if e["id"] == "S103")
        self.assertIsNone(s103["game"])
        self.assertEqual(s103["problem"], rm.SHEET_PROBLEM)
        self.assertEqual(counts["sheet"], 2)

    def test_same_game_is_listed_once_and_ids_are_stable(self) -> None:
        doc, counts = self.merged()
        ids = [p["id"] for p in doc["posts"]]
        self.assertNotIn("S101", ids)  # = GAME: one entry, the Discord post
        self.assertEqual(next(p for p in doc["posts"] if p["id"] == GAME.id)["src"], rm.SRC_BOTH)
        self.assertEqual(counts["merged with a Discord post"], 1)
        s102 = next(p for p in doc["posts"] if p["id"] == "S102")
        self.assertEqual((s102["src"], s102["created"], s102["date"], s102["tags"]), (rm.SRC_SHEET, "", "2026-10-24", ["線瓦"]))
        self.assertIn("S103", ids)  # broken sheet rows still get an entry
        self.assertEqual(dpe.records_problems(doc), [])
        again, _ = self.merged()
        self.assertEqual(dpe.dump_records(again), dpe.dump_records(doc))  # same ids and order on a re-run
        # newest first by record date, Discord and sheet together; GAME is S101 too, so it carries the sheet's date
        # 2026-10-20, not its title's 1025 (站長 2026-11-20「日期不同的都以試算表為準」)
        self.assertEqual(ids[:2], [BROKEN.id, "S102"])
        self.assertGreater(ids.index(GAME.id), ids.index("S102"))
        game = next(p for p in doc["posts"] if p["id"] == GAME.id)
        self.assertEqual((game["date"], game[rm.POST_DATE]), ("2026-10-20", "2026-10-25"))
        self.assertEqual(counts["date taken from the sheet"], 1)
        broken = next(p for p in doc["posts"] if p["id"] == BROKEN.id)  # Discord only: its own date
        self.assertEqual((broken["date"], rm.POST_DATE in broken), ("2026-10-26", False))

    def test_owner_duplicate_rulings_leave_an_entry_out(self) -> None:
        """站長 2026-11-20 duplicateOf (game_db_corrections.json): 「刪一篇」／「以試算表為準」 -- the named one stays."""
        doc, _ = build()
        counts = dpe.merge_sheet(doc, sheet_doc(), SIM_ROWS, None, {BROKEN.id: GAME.id, "S102": GAME.id})
        ids = [p["id"] for p in doc["posts"]]
        self.assertNotIn(BROKEN.id, ids)
        self.assertNotIn("S102", ids)
        self.assertIn(GAME.id, ids)
        self.assertEqual(counts["left out as the same game as another (站長)"], 2)
        self.assertEqual(dpe.records_problems(doc), [])
        self.assertEqual(rm.duplicate_ids({"corrections": {"1": {"duplicateOf": "S2"}, "S3": {"set": {}}}}), {"1": "S2"})
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(dpe.load_duplicates(Path(tmp) / "none.json"), {})

    def test_sheet_date_on_a_merged_post(self) -> None:
        doc, _ = self.merged()
        again = json.loads(json.dumps(doc))
        counts = dpe.merge_sheet(again, sheet_doc(), SIM_ROWS, doc)  # a re-merge starts from the post's own date
        self.assertEqual(dpe.dump_records(again), dpe.dump_records(doc))
        self.assertEqual(counts["date taken from the sheet"], 1)
        # the sheet row gets the post's date: nothing to replace, no postDate
        same_day = sheet_doc()
        same_day["games"][0][same_day["fields"].index("date")] = "2026-10-25"
        doc2, _ = build()
        dpe.merge_sheet(doc2, same_day, SIM_ROWS)
        game = next(p for p in doc2["posts"] if p["id"] == GAME.id)
        self.assertEqual((game["date"], game["src"], rm.POST_DATE in game), ("2026-10-25", rm.SRC_BOTH, False))
        # the sheet row no longer matches: the post is Discord only again, with its own date
        doc3 = json.loads(json.dumps(doc))
        other = sheet_doc()
        other["games"] = other["games"][1:]
        dpe.merge_sheet(doc3, other, SIM_ROWS, doc)
        game = next(p for p in doc3["posts"] if p["id"] == GAME.id)
        self.assertEqual((game["date"], "src" in game, rm.POST_DATE in game), ("2026-10-25", False, False))
        # shape: postDate only on a dc+sheet post, a full date, different from date
        for change in ({rm.POST_DATE: "2026-10-20"}, {rm.POST_DATE: "1025"}, {"src": None}):
            bad = json.loads(json.dumps(doc))
            post_ = next(p for p in bad["posts"] if p["id"] == GAME.id)
            for k, v in change.items():
                if v is None:
                    post_.pop(k)
                else:
                    post_[k] = v
            self.assertTrue(has(dpe.records_problems(bad), "postDate"), change)
        self.assertEqual(dpe.records_problems(doc), [])

    def test_simulation_rows(self) -> None:
        doc, counts = self.merged()
        m1 = next(p for p in doc["posts"] if p["id"] == "M1")
        self.assertEqual((m1["sim"], m1["tags"], m1["date"], m1["game"]["outcome"]), (True, ["模擬"], "2023-06-27", ""))
        self.assertEqual(m1["game"]["names"][:6], NAMES[:5] + [""])
        self.assertEqual(m1["game"]["rounds"][0]["proposals"][1], {"team": "458", "votes": ["2+"]})
        m2 = next(p for p in doc["posts"] if p["id"] == "M2")
        self.assertEqual(m2["game"]["rounds"][1], {"proposals": [{"team": "1357", "votes": []}, {"team": "2468", "votes": []}], "mission": ""})
        m3 = next(p for p in doc["posts"] if p["id"] == "M3")
        self.assertEqual(m3["problem"], rm.SIM_PROBLEM)
        self.assertEqual((counts["sim"], counts["sim unreadable"]), (2, 1))
        self.assertNotIn("lineup", m1)
        self.assertEqual(dpe.records_problems(doc), [])
        m1["game"]["outcome"] = ""
        doc_bad = json.loads(json.dumps(doc))
        next(p for p in doc_bad["posts"] if p["id"] == "S102")["game"]["outcome"] = ""  # only 模擬 may be unfinished
        self.assertTrue(has(dpe.records_problems(doc_bad), "outcome value"))

    def test_simulation_never_merges_into_a_real_game(self) -> None:
        # 模擬畢竟只是模擬 (Edward 2026-11-16): same fingerprint, different type -> two entries
        real = post(25, 23, "1025一般場6", ("三藍躲刺", "線瓦"))
        doc, _ = build(FakeDiscord([real], {real.id: body()}))
        sims = [{"流水號": "9", "文字記錄": RECORD, "配置": "936758", "刺殺": "3", "日期時間": "2026-10-25"}]
        counts = dpe.merge_sheet(doc, None, sims)
        self.assertEqual(counts["merged with a Discord post"], 0)
        dc, m9 = (next(p for p in doc["posts"] if p["id"] == i) for i in (real.id, "M9"))
        self.assertNotIn("src", dc)
        self.assertNotIn("sim", dc)
        self.assertIs(m9["sim"], True)
        self.assertEqual(m9["game"]["outcome"], gc.OUTCOME_BLUE_ALIVE)  # a finished 模擬 is still 模擬
        # a 模擬瓦 row with a 牌譜-tab game's fingerprint stays a separate 模擬 entry too, without 陣容強度 / 失誤標籤
        doc, _ = build(FakeDiscord([], {}))
        counts = dpe.merge_sheet(doc, sheet_doc(), sims)
        ids = [p["id"] for p in doc["posts"]]
        self.assertIn("S101", ids)
        self.assertIn("M9", ids)
        dpe.annotate_records(doc, sheet_doc())
        m9 = next(p for p in doc["posts"] if p["id"] == "M9")
        self.assertFalse({"lineup", "mistakes"} & set(m9))
        self.assertEqual(dpe.records_problems(doc), [])

    def test_unavailable_sources_keep_the_previous_entries(self) -> None:
        previous, _ = self.merged()
        doc, _ = build()
        counts = dpe.merge_sheet(doc, None, None, previous)
        self.assertEqual([p["id"] for p in doc["posts"]], [p["id"] for p in previous["posts"]])
        self.assertEqual(counts["sheet kept from the previous file"], 2)
        self.assertEqual(counts["模擬 kept from the previous file"], 3)
        self.assertEqual(dpe.records_problems(doc), [])

    def test_shape_rules_for_sheet_entries(self) -> None:
        doc, _ = self.merged()
        s102 = next(p for p in doc["posts"] if p["id"] == "S102")
        s102["src"] = "dc"
        self.assertTrue(has(dpe.records_problems(doc), "src value"))
        doc, _ = self.merged()
        next(p for p in doc["posts"] if p["id"] == GAME.id)["created"] = ""  # only sheet entries have no time
        self.assertTrue(has(dpe.records_problems(doc), "created shape"))
        doc, _ = self.merged()
        next(p for p in doc["posts"] if p["id"] == "M1")["sim"] = False
        self.assertTrue(has(dpe.records_problems(doc), "sim flag"))
        doc, _ = self.merged()
        next(p for p in doc["posts"] if p["id"] == "S102")["id"] = "X102"
        self.assertTrue(has(dpe.records_problems(doc), "post id"))

    def test_merge_only_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out, games, sims = Path(tmp) / "records_cache.json", Path(tmp) / "games.json", Path(tmp) / "sim.json"
            doc, _ = build()
            out.write_text(dpe.dump_records(doc), encoding="utf-8")
            games.write_text(json.dumps(sheet_doc(), ensure_ascii=False), encoding="utf-8")
            sims.write_text(json.dumps(SIM_ROWS, ensure_ascii=False), encoding="utf-8")
            log = io.StringIO()
            with redirect_stdout(log), redirect_stderr(log):
                rc = dpe.main(["--output", str(out), "--games", str(games), "--merge-only", "--sim-rows", str(sims)])
            self.assertEqual(rc, 0, log.getvalue())
            written = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(written["counts"]["posts"], 3 + 2 + 3)
            self.assertIn("跟 DC 貼文同一局合併 1", log.getvalue())
            for secret in ("玩家", "一般場"):
                self.assertNotIn(secret, log.getvalue())


# 2026-11-17: a record cut off after round 3 (no side has 3 yet) and corrected by a reply in the thread.
HEAD = RECORD.split("8>4 x")[0].rstrip("\n")  # rounds 1-3 and the first lake
TAIL = "8>4 x\n15678 -5 +39\n14580\nooooo"  # the missing round 4 (and the lake before it)
KILL = "刺客刺殺:1"  # a loyal servant (the fixture's 3 is 莫甘娜, which game_db.validate rejects)
POSTER, CORRECTOR, STRANGER, BOT = "100000000000000001", "100000000000000002", "100000000000000003", "100000000000000004"


def thread_post(day: int, title: str = "1020一般場3", replied: bool = True, tags=("三藍躲刺", "線瓦")) -> dri.Post:
    base = post(day, 20, title, tags)
    last = str(int(base.id) + (5 << 22)) if replied else base.id
    return dri.Post(id=base.id, title=base.title, tags=base.tags, owner_id=POSTER, last_message_id=last)


def reply(n: int, author: str, content: str, bot: bool = False) -> dict:
    return {"id": str(200000000000000000 + n), "author": author, "bot": bot, "content": content}


class ReplyCorrectionTest(unittest.TestCase):
    def build(self, posts, bodies, threads, correctors=frozenset()):
        asked = []

        def replies(p):
            asked.append(p.id)
            return threads.get(p.id, [])
        doc, status = dpe.build_records(posts, lambda p: bodies[p.id], guild_id=GUILD, forum_id=FORUM,
                                        replies=replies, correctors=correctors)
        return {e["id"]: e for e in doc["posts"]}, status, asked, doc

    def test_cut_off_record_fixed_by_a_reply_of_record_lines(self) -> None:
        cut = thread_post(20)
        entries, status, asked, doc = self.build([cut], {cut.id: body(HEAD, assassin=KILL)}, {cut.id: [
            reply(1, BOT, "🤖 牌譜格式檢查：牌譜結束時還沒有一方滿三次任務", bot=True),
            reply(2, STRANGER, "第四局\n" + TAIL),
        ]})
        entry = entries[cut.id]
        self.assertEqual(entry["fixedByReply"], reply(2, STRANGER, "")["id"])
        self.assertNotIn("problem", entry)
        self.assertEqual([r["mission"] for r in entry["game"]["rounds"]], ["ooo", "ooox", "oooo", "ooooo"])
        self.assertEqual(entry["game"]["names"], NAMES)  # the names still come from the starter
        self.assertEqual((status["fixed by reply"], status["game"]), (1, 1))
        self.assertEqual(dpe.records_problems(doc), [])
        self.assertNotIn("第四局", json.dumps(doc, ensure_ascii=False))  # nothing of the reply's text is stored

    def test_replies_only_read_for_a_post_that_needs_a_correction_and_has_replies(self) -> None:
        good, quiet = thread_post(21, "1021一般場1"), thread_post(22, "1022一般場1", replied=False)
        _, _, asked, _ = self.build([good, quiet], {good.id: body(assassin=KILL), quiet.id: body(HEAD, assassin=KILL)}, {})
        self.assertEqual(asked, [])

    def test_chat_bot_and_rule_breaking_replies_are_not_applied(self) -> None:
        cut = thread_post(20)
        wrong = TAIL.replace("ooooo", "oooox")  # round 4 failed with 1 fail: 2 blue, 2 red, still undecided
        entries, status, _, _ = self.build([cut], {cut.id: body(HEAD, assassin=KILL)}, {cut.id: [
            reply(1, STRANGER, "第四局少打了，應該是\n" + TAIL),  # prose around the lines: left to a person
            reply(2, BOT, TAIL, bot=True),
            reply(3, STRANGER, wrong),
        ]})
        self.assertIsNone(entries[cut.id]["game"])
        self.assertNotIn("fixedByReply", entries[cut.id])
        self.assertEqual(status["fixed by reply"], 0)

    def test_corrector_allow_list(self) -> None:
        cut = thread_post(20)
        threads = {cut.id: [reply(1, STRANGER, TAIL)]}
        entries, _, _, _ = self.build([cut], {cut.id: body(HEAD, assassin=KILL)}, threads, correctors=frozenset({CORRECTOR}))
        self.assertIsNone(entries[cut.id]["game"])  # only the poster and the correctors count once the list is set
        threads = {cut.id: [reply(1, CORRECTOR, TAIL)]}
        entries, _, _, _ = self.build([cut], {cut.id: body(HEAD, assassin=KILL)}, threads, correctors=frozenset({CORRECTOR}))
        self.assertEqual(entries[cut.id]["fixedByReply"], reply(1, CORRECTOR, "")["id"])

    def test_poster_may_repost_the_whole_record(self) -> None:
        cut = thread_post(20)
        entries, _, _, _ = self.build([cut], {cut.id: body(HEAD, assassin=KILL)}, {cut.id: [
            reply(1, STRANGER, body(assassin=KILL)),  # a whole record from someone else: not taken
        ]})
        self.assertIsNone(entries[cut.id]["game"])
        entries, _, _, _ = self.build([cut], {cut.id: body(HEAD, assassin=KILL)}, {cut.id: [reply(1, POSTER, body(assassin=KILL))]})
        self.assertEqual(len(entries[cut.id]["game"]["rounds"]), 4)

    def test_parse_correctors_and_shape_check(self) -> None:
        self.assertEqual(dpe.parse_correctors(f" {CORRECTOR}, {STRANGER}\nnot-an-id "), frozenset({CORRECTOR, STRANGER}))
        self.assertEqual(dpe.parse_correctors(None), frozenset())
        doc, _ = build()
        entry = next(p for p in doc["posts"] if p["id"] == GAME.id)
        entry["fixedByReply"] = "not an id"
        self.assertIn("fixedByReply shape", dpe.records_problems(doc))
        broken = next(p for p in doc["posts"] if p["id"] == BROKEN.id)
        entry["fixedByReply"] = "200000000000000001"
        broken["fixedByReply"] = "200000000000000001"
        self.assertIn("post keys", dpe.records_problems(doc))  # only on a parsed game

    def test_run_reads_the_corrector_list_from_the_environment(self) -> None:
        cut = thread_post(20)

        class Client(FakeDiscord):
            def thread_replies(self, thread_id):
                return [reply(1, CORRECTOR, TAIL)]
        client = Client(posts=[cut], bodies={cut.id: body(HEAD, assassin=KILL)})
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "records_cache.json"
            env = {"DISCORD_BOT_TOKEN": "token-marker", dpe.ENV_CORRECTORS: CORRECTOR}
            with redirect_stdout(io.StringIO()) as log, mock.patch.object(dpe.dri, "DiscordClient", lambda token: client), \
                    mock.patch.dict("os.environ", env, clear=True):
                self.assertEqual(dpe.main(["--output", str(out), "--games", str(Path(tmp) / "none.json")]), 0)
            doc = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(doc["posts"][0]["fixedByReply"], reply(1, CORRECTOR, "")["id"])
            self.assertIn("討論串回覆更正後讀得懂：1 篇", log.getvalue())
            self.assertNotIn(CORRECTOR, log.getvalue())


class WorkflowTest(unittest.TestCase):
    def test_refresh_workflow_exports_and_commits_the_list(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("python packages/server/test_discord_records_export.py", text)
        self.assertIn("python packages/server/discord_records_export.py", text)
        self.assertIn("RECORDS_PATH: packages/server/records_cache.json", text)
        self.assertIn('git add -- "${RECORDS_PATH}"', text)
        self.assertNotIn("--report", text)
        self.assertIn("--merge-only --sim-sheet", text)  # sheet games and lineups stay fresh when the Discord read is skipped or fails
        self.assertIn('args=(--output "${RECORDS_PATH}" --sim-sheet)', text)
        self.assertIn("DISCORD_RECORD_CORRECTORS: ${{ vars.DISCORD_RECORD_CORRECTORS }}", text)  # ids stay out of the repo


if __name__ == "__main__":
    unittest.main(verbosity=2)
