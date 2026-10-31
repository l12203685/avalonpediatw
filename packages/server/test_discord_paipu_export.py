"""Offline tests for discord_paipu_export.py (the website's 牌譜紀錄 list).

No network and no Google libraries needed (stdlib unittest; pytest also collects it). Synthetic
posts with made-up names (玩家A … 玩家J).

    python packages/server/test_discord_paipu_export.py
"""

from __future__ import annotations

import datetime as dt
import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import discord_paipu_export as dpe  # noqa: E402
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
    return dpe.build_paipu(discord.posts, lambda p: discord.starter_content(p.id), guild_id=GUILD, forum_id=FORUM)


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
        self.assertNotIn(SIM.id, ids)  # 模擬
        self.assertNotIn(SIM.id, discord.fetched)  # ... not even read
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
        self.assertEqual(status["simulation"], 1)
        self.assertEqual(status["not a record"], 2)
        self.assertEqual(doc["counts"], {"posts": 3, "games": 1, "unreadable": 2})

    def test_newest_first_and_no_raw_text(self) -> None:
        doc, _ = build()
        self.assertEqual([p["id"] for p in doc["posts"]], [BROKEN.id, GAME.id, EMPTY_TAGGED.id])
        text = dpe.dump_paipu(doc)
        self.assertNotIn("hello", text)  # the unreadable line itself is never stored
        self.assertNotIn("刺客刺殺", text)
        self.assertNotIn("場地", text)
        self.assertEqual(json.loads(text), doc)
        self.assertEqual(text.count("\n"), 9 + len(doc["posts"]))  # one post per line

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
        self.assertEqual(dpe.paipu_problems(doc), [])


def has(problems: list[str], name: str) -> bool:
    return any(p == name or p.startswith(name + " (") for p in problems)


class ShapeCheckTest(unittest.TestCase):
    def test_built_document_passes(self) -> None:
        doc, _ = build()
        self.assertEqual(dpe.paipu_problems(doc), [])

    def test_unexpected_fields_and_free_text_fail(self) -> None:
        doc, _ = build()
        doc["posts"][1]["text"] = "the whole starter message"
        self.assertTrue(has(dpe.paipu_problems(doc), "post keys"))
        doc, _ = build()
        doc["posts"][0]["problem"] = "第 14 行寫了 hello"
        self.assertTrue(has(dpe.paipu_problems(doc), "problem text"))
        doc, _ = build()
        doc["posts"][1]["game"]["names"][2] = "玩家C\n下一行"
        self.assertTrue(has(dpe.paipu_problems(doc), "names shape"))
        doc, _ = build()
        doc["posts"][1]["game"]["rounds"][0]["proposals"][0]["votes"] = ["好隊"]
        self.assertTrue(has(dpe.paipu_problems(doc), "proposal shape"))
        doc, _ = build()
        doc["posts"][1]["game"]["comment"] = "覆盤心得"
        self.assertTrue(has(dpe.paipu_problems(doc), "game keys"))

    def test_order_counts_and_simulations_fail(self) -> None:
        doc, _ = build()
        doc["posts"].reverse()
        self.assertTrue(has(dpe.paipu_problems(doc), "post order"))
        doc, _ = build()
        doc["counts"]["games"] = 3
        self.assertTrue(has(dpe.paipu_problems(doc), "counts"))
        doc, _ = build()
        doc["posts"][1]["tags"].append("模擬")
        self.assertTrue(has(dpe.paipu_problems(doc), "simulation post"))


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
        self.out = Path(self.tmp.name) / "paipu_cache.json"

    def run_main(self, discord: FakeDiscord | None, *argv: str, env: dict | None = None) -> tuple[int, str]:
        out, err = io.StringIO(), io.StringIO()
        environment = {"DISCORD_BOT_TOKEN": "token-marker"} if env is None else env
        with redirect_stdout(out), redirect_stderr(err), \
                mock.patch.object(dpe.dri, "DiscordClient", lambda token: discord):
            with mock.patch.dict("os.environ", environment, clear=True):
                rc = dpe.main(["--output", str(self.out), *argv])
        return rc, out.getvalue() + err.getvalue()

    def test_writes_then_unchanged_and_logs_counts_only(self) -> None:
        rc, log = self.run_main(FakeDiscord())
        self.assertEqual(rc, 0, log)
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(doc["counts"]["posts"], 3)
        self.assertIn("已寫入（0 → 3 篇）", log)
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


class WorkflowTest(unittest.TestCase):
    def test_refresh_workflow_exports_and_commits_the_list(self) -> None:
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("python packages/server/test_discord_paipu_export.py", text)
        self.assertIn("python packages/server/discord_paipu_export.py", text)
        self.assertIn("PAIPU_PATH: packages/server/paipu_cache.json", text)
        self.assertIn('git add -- "${PAIPU_PATH}"', text)
        self.assertNotIn("--report", text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
