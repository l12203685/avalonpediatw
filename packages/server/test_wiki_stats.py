"""Offline tests for wiki_stats.py (百科文章裡的牌譜數字每晚從逐局資料重算). Stdlib unittest.

    python packages/server/test_wiki_stats.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wiki_stats as ws  # noqa: E402


class WikiStatsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.data = ws.Data(json.loads(ws.GAMES_PATH.read_text(encoding="utf-8")))
        cls.values = ws.render_all(cls.data)

    def test_repo_wiki_matches_the_games_dataset(self) -> None:
        # 百科裡標記內的數字＝games_cache.json 現在算出來的（每晚的 workflow 一起更新；手改或忘了重跑會在這裡失敗）。
        self.assertEqual(ws.run(ws.GAMES_PATH, ws.WIKI_PATH, check=True), [],
                         "run: python packages/server/wiki_stats.py")

    def test_every_block_is_used_and_every_marker_is_known(self) -> None:
        articles = json.loads(ws.WIKI_PATH.read_text(encoding="utf-8"))
        keys = {m[0] for m in ws.STAT_SPAN_RE.findall("\n".join(a["content"] for a in articles))}
        self.assertEqual(keys, set(ws.BLOCKS))

    def test_same_scope_as_the_stats_pages(self) -> None:
        # 不篩選的數據分析頁：analysis_cache.json overview 的局數與三種結果（同一次 generate_cache.py 寫的）。
        overview = json.loads((ws.HERE / "analysis_cache.json").read_text(encoding="utf-8"))["overview"]
        c = ws.outcome_counts(self.data.games)
        self.assertEqual(self.data.total, overview["totalGames"])
        ob = overview["outcomeBreakdown"]
        self.assertEqual((c[ws.THREE_RED], c[ws.BLUE_DEAD], c[ws.BLUE_ALIVE]),
                         (ob["threeRed"], ob["threeBlueDead"], ob["threeBlueAlive"]))
        self.assertFalse(any(g.category == "百科AI" for g in self.data.games))

    def test_fill_rewrites_only_inside_markers_and_is_idempotent(self) -> None:
        values = {"a": "一", "b": "x\ny"}
        src = "前 <!-- stat:a -->舊<!-- /stat --> 後\n<!-- stat:b -->\n舊表\n<!-- /stat -->\n尾"
        out = ws.fill(src, values, "t")
        self.assertEqual(out, "前 <!-- stat:a -->一<!-- /stat --> 後\n<!-- stat:b -->\nx\ny\n<!-- /stat -->\n尾")
        self.assertEqual(ws.fill(out, values, "t"), out)

    def test_fill_rejects_unknown_keys_and_multiline_inline_markers(self) -> None:
        with self.assertRaises(SystemExit):
            ws.fill("<!-- stat:nope -->x<!-- /stat -->", {"a": "1"}, "t")
        with self.assertRaises(SystemExit):
            ws.fill("<!-- stat:b -->x<!-- /stat -->", {"b": "x\ny"}, "t")

    def test_run_rewrites_a_stale_copy_and_check_reports_it(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            wiki = Path(tmp) / "wiki_data.json"
            shutil.copy(ws.WIKI_PATH, wiki)
            raw = wiki.read_text(encoding="utf-8")
            stale = raw.replace("<!-- stat:proposals.perPlayer -->本站", "<!-- stat:proposals.perPlayer -->舊的本站", 1)
            self.assertNotEqual(stale, raw)
            wiki.write_text(stale, encoding="utf-8")
            self.assertEqual(ws.run(ws.GAMES_PATH, wiki, check=True), [str(wiki)])
            self.assertEqual(wiki.read_text(encoding="utf-8"), stale)  # check 不寫檔
            self.assertEqual(ws.run(ws.GAMES_PATH, wiki, check=False), [str(wiki)])
            self.assertEqual(wiki.read_text(encoding="utf-8"), raw)

    def test_blocks_have_no_player_names(self) -> None:
        doc = json.loads(ws.GAMES_PATH.read_text(encoding="utf-8"))
        names = [p for p in doc["players"] if len(p) >= 3]
        blob = "\n".join(self.values.values())
        # 只比數量（公開的 CI 紀錄不印名字）
        self.assertEqual(sum(1 for p in names if p in blob), 0)

    def test_numbers_add_up(self) -> None:
        c = ws.outcome_counts(self.data.games)
        self.assertIn(f"| 全部 | {ws.n(self.data.total)} |", self.values["wiki40.outcomes"])
        self.assertIn(f"{ws.n(c[ws.THREE_RED])}（{ws.pct(c[ws.THREE_RED], self.data.total)}）", self.values["wiki40.outcomes"])
        self.assertEqual(ws.pct(1, 3), "33.3%")
        self.assertEqual(ws.pct(1, 0), "—")


if __name__ == "__main__":
    unittest.main()
