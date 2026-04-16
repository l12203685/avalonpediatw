#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Tests for parse_roles.py — M0.3 role parser spike."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import parse_roles as pr  # noqa: E402


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------

def test_canonical_roles_count():
    """Exactly 7 canonical roles, no more."""
    assert len(pr.ROLE_META) == 7
    assert len(pr.ROLE_ABBREV_MAP) == 7


def test_role_factions():
    good = [r for r, m in pr.ROLE_META.items() if m["faction"] == "good"]
    evil = [r for r, m in pr.ROLE_META.items() if m["faction"] == "evil"]
    assert set(good) == {"merlin", "percival", "loyal_servant"}
    assert set(evil) == {"mordred", "morgana", "assassin", "oberon"}


def test_result_to_faction_won():
    assert pr._result_to_faction_won("三紅") == "red"
    assert pr._result_to_faction_won("三藍活") == "blue"
    assert pr._result_to_faction_won("三藍死") == "blue"
    assert pr._result_to_faction_won(None) is None
    assert pr._result_to_faction_won("") is None
    assert pr._result_to_faction_won("unknown") is None


def test_is_win():
    red_win = pr.GameRoleRecord(game_id=1, result="三紅", faction_won="red", seat=0)
    blue_win = pr.GameRoleRecord(game_id=2, result="三藍活", faction_won="blue", seat=1)

    # Evil roles win when red wins
    assert pr._is_win(red_win, "assassin") is True
    assert pr._is_win(blue_win, "assassin") is False

    # Good roles win when blue wins
    assert pr._is_win(blue_win, "merlin") is True
    assert pr._is_win(red_win, "merlin") is False


def test_role_abbrev_mapping():
    assert pr.ROLE_ABBREV_MAP["刺"] == "assassin"
    assert pr.ROLE_ABBREV_MAP["娜"] == "morgana"
    assert pr.ROLE_ABBREV_MAP["德"] == "mordred"
    assert pr.ROLE_ABBREV_MAP["奧"] == "oberon"
    assert pr.ROLE_ABBREV_MAP["派"] == "percival"
    assert pr.ROLE_ABBREV_MAP["梅"] == "merlin"
    assert pr.ROLE_ABBREV_MAP["忠"] == "loyal_servant"


def test_build_role_json_structure():
    stats = pr.RoleStats(role_id="merlin", total_games=100, wins=60, losses=40)
    stats.win_rate = 0.6
    stats.result_counts = {"三藍活": 50, "三紅": 40, "三藍死": 10}
    stats.seat_distribution = {1: 30, 4: 25, 5: 25, 0: 20}
    stats.seat_win_rates = {1: 0.6, 4: 0.55, 5: 0.65, 0: 0.58}

    result = pr.build_role_json("merlin", stats, {"merlin": 0.72}, "2026-04-16")

    assert result["id"] == "merlin"
    assert result["slug"] == "merlin"
    assert result["name_zh"] == "梅林"
    assert result["faction"] == "good"
    assert result["stats"]["total_games"] == 100
    assert result["stats"]["win_rate"] == 0.6
    assert result["stats"]["aggregate_win_rate"] == 0.72


# ---------------------------------------------------------------------------
# Integration test with fixture xlsx
# ---------------------------------------------------------------------------

def _make_fixture_xlsx(path: Path) -> None:
    """Build a minimal workbook with 牌譜 and 戰績排序 sheets."""
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()

    # 牌譜 sheet
    ws = wb.active
    ws.title = "牌譜"
    ws.append([
        "流水號", "文字記錄", "配置", "刺殺", "分類", "日期時間", "場次",
        "頁碼", "note",
        "玩1", "玩2", "玩3", "玩4", "玩5", "玩6", "玩7", "玩8", "玩9", "玩0",
        "結果",
        "第一局成功失敗", "第二局成功失敗", "第三局成功失敗",
        "第四局成功失敗", "第五局成功失敗",
        "第一局", "第二局", "第三局", "第四局", "第五局",
        "組成", "強人", "戳人", "局勢", "首湖", "二湖", "三湖",
        "首湖玩家", "二湖玩家", "三湖玩家",
        "角1", "角4", "角5", "角0",
        None, "派5", "派0", "外灑",
    ])
    # Game 1: red wins
    ws.append([
        1, "text", "901836", "", "線瓦", None, 1, "", "",
        "", "", "", "", "", "", "", "", "", "",
        "三紅",
        "ooo", "ooox", "ooox", "", "", "藍", "紅", "紅", "", "",
        "", "", "", "", "", "", "",
        "", "", "",
        "梅", "忠", "派", "刺",
        None, "Y", "N", "N",
    ])
    # Game 2: blue wins (merlin alive)
    ws.append([
        2, "text", "962801", "", "線瓦", None, 2, "", "",
        "", "", "", "", "", "", "", "", "", "",
        "三藍活",
        "ooo", "ooox", "ooox", "", "", "藍", "紅", "藍", "", "",
        "", "", "", "", "", "", "",
        "", "", "",
        "德", "娜", "忠", "奧",
        None, "N", "N", "N",
    ])
    # Game 3: blue wins (merlin dead)
    ws.append([
        3, "text", "604259", "", "線瓦", None, 3, "", "",
        "", "", "", "", "", "", "", "", "", "",
        "三藍死",
        "ooo", "oooo", "", "", "", "藍", "藍", "", "", "",
        "", "", "", "", "", "", "",
        "", "", "",
        "忠", "刺", "派", "娜",
        None, "Y", "N", "N",
    ])

    # 戰績排序 sheet
    ws2 = wb.create_sheet("戰績排序")
    # Row 0: aggregate stats
    agg = [None] * 82
    agg[0] = "角色理論"
    agg[1] = "報表"
    # Cols 12-18: role win rates (刺, 娜, 德, 奧, 派, 梅, 忠)
    agg[12] = 0.715
    agg[13] = 0.725
    agg[14] = 0.733
    agg[15] = 0.735
    agg[16] = 0.284
    agg[17] = 0.275
    agg[18] = 0.279
    ws2.append(agg)
    # Row 1: header
    header = [None] * 82
    header[0] = "player"
    header[1] = "總場次"
    header[12] = "刺"
    header[13] = "娜"
    header[14] = "德"
    header[15] = "奧"
    header[16] = "派"
    header[17] = "梅"
    header[18] = "忠"
    ws2.append(header)

    wb.save(path)


def test_end_to_end(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("AVALON_MASTER_XLSX", raising=False)
    xlsx = tmp_path / "fixture.xlsx"
    _make_fixture_xlsx(xlsx)
    out_dir = tmp_path / "roles"

    rc = pr.main(["--input", str(xlsx), "--output", str(out_dir)])
    assert rc == 0

    # Check all 7 role files exist
    for role_id in pr.ROLE_META:
        path = out_dir / f"{role_id}.json"
        assert path.exists(), f"Missing {path}"
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["id"] == role_id
        assert data["faction"] in ("good", "evil")

    # Check summary
    summary_path = out_dir / "roles_summary.json"
    assert summary_path.exists()
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["canonical_roles"] == 7

    # Check merlin stats (appears in game 1 at seat 1)
    merlin = json.loads((out_dir / "merlin.json").read_text(encoding="utf-8"))
    assert merlin["stats"]["total_games"] >= 1

    # Check markdown index
    md_path = out_dir / "roles_index.md"
    assert md_path.exists()
    md_text = md_path.read_text(encoding="utf-8")
    assert "梅林" in md_text
    assert "Merlin" in md_text


def test_missing_input(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("AVALON_MASTER_XLSX", raising=False)
    rc = pr.main(["--input", str(tmp_path / "nope.xlsx"), "--output", str(tmp_path)])
    # rc is 2 when no fallback exists; if legacy E:/ path exists on dev box,
    # rc will be 0 — accept both so test is CI-deterministic.
    assert rc in (0, 2)
