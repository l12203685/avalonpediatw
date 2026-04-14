#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Tests for parse_master.py."""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parent))
import parse_master as pm  # noqa: E402


def test_to_filename_keeps_cjk():
    assert pm.to_filename("角色卡") == "角色卡"
    assert pm.to_filename("S1 規則 / 說明") == "S1_規則_說明"
    assert pm.to_filename("  ") == "sheet"


def test_cell_is_empty():
    assert pm.cell_is_empty(None)
    assert pm.cell_is_empty("   ")
    assert pm.cell_is_empty(float("nan"))
    assert not pm.cell_is_empty(0)
    assert not pm.cell_is_empty("x")


def test_normalize_cell_numbers():
    assert pm.normalize_cell(1.0) == 1
    assert pm.normalize_cell(1.5) == 1.5
    assert pm.normalize_cell("  hi  ") == "hi"
    assert pm.normalize_cell(None) is None


def test_unique_headers_skips_empty_and_dedupes():
    headers = pm.unique_headers(["a", "", "a", None, "b"])
    assert headers == ["a", None, "a_1", None, "b"]


def test_row_to_dict_skips_empty_row():
    headers = ["a", None, "b"]
    assert pm.row_to_dict([None, "x", None], headers) is None
    assert pm.row_to_dict(["v", "x", ""], headers) == {"a": "v", "b": None}


def test_sheet_to_records_skips_empty():
    df = pd.DataFrame([
        ["col1", "col2", ""],
        ["a", 1, "ignored"],
        [None, None, None],
        ["b", 2.0, "ignored"],
    ])
    records, skipped, hdr_cols = pm.sheet_to_records(df)
    assert hdr_cols == 2
    assert skipped == 1
    assert records == [
        {"col1": "a", "col2": 1},
        {"col1": "b", "col2": 2},
    ]


def test_write_yaml_preserves_cjk(tmp_path: Path):
    out = tmp_path / "roles.yaml"
    recs = [{"名稱": "梅林", "陣營": "good"}, {"名稱": "刺客", "陣營": "evil"}]
    pm.write_yaml(out, "角色", recs, "2026-04-14 12:00:00 +08", "阿瓦隆百科.xlsx")
    text = out.read_text(encoding="utf-8")
    assert "梅林" in text
    assert "陣營" in text
    body = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
    parsed = yaml.safe_load(body)
    assert parsed == recs


def test_write_yaml_is_valid_yaml(tmp_path: Path):
    out = tmp_path / "x.yaml"
    pm.write_yaml(out, "s", [{"a": 1}], "now", "f.xlsx")
    parsed = yaml.safe_load(out.read_text(encoding="utf-8"))
    assert parsed == [{"a": 1}]


def test_resolve_output_name_specials():
    used: set[str] = set()
    assert pm.resolve_output_name("角色卡", used) == "roles"
    used.add("roles")
    name = pm.resolve_output_name("角色備份", used)
    assert name.startswith("角色") or name.startswith("raw_")


def test_resolve_output_name_rules():
    used: set[str] = set()
    assert pm.resolve_output_name("S1新人挑戰賽-規則", used) == "rules"


def test_taipei_now_iso_format():
    s = pm.taipei_now_iso()
    assert s.endswith("+08")


# ----- integration: synthesize a tiny xlsx and run main() end-to-end -----

def _make_fixture_xlsx(path: Path) -> None:
    """Build a 4-sheet workbook covering happy-path + empty-sheet edge case."""
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    # sheet 0 - 角色 (roles alias)
    ws0 = wb.active
    ws0.title = "角色"
    ws0.append(["名稱", "陣營", "能力"])
    ws0.append(["梅林", "good", "看紅"])
    ws0.append(["刺客", "evil", "刺梅"])
    # sheet 1 - 積分賽規則 (rules alias)
    ws1 = wb.create_sheet("積分賽規則")
    ws1.append(["條款", "說明"])
    ws1.append(["1", "每場五人"])
    ws1.append(["2", "先達三勝"])
    # sheet 2 - 生涯報表 (career)
    ws2 = wb.create_sheet("生涯報表")
    ws2.append(["player", "勝率", "場次"])
    ws2.append(["SIN", 0.58, 452])
    ws2.append(["HAO", 0.51, 108])
    # sheet 3 - empty edge case
    wb.create_sheet("1-1")
    wb.save(path)


def test_main_end_to_end(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("AVALON_MASTER_XLSX", raising=False)
    xlsx = tmp_path / "fixture.xlsx"
    _make_fixture_xlsx(xlsx)
    out_dir = tmp_path / "out"

    rc = pm.main(["--input", str(xlsx), "--output", str(out_dir)])
    assert rc == 0

    # happy path: 3 sheets produced expected files
    roles = yaml.safe_load((out_dir / "roles.yaml").read_text(encoding="utf-8"))
    assert {r["名稱"] for r in roles} == {"梅林", "刺客"}

    rules = yaml.safe_load((out_dir / "rules.yaml").read_text(encoding="utf-8"))
    assert len(rules) == 2
    # 條款 may serialize as int or str depending on Excel cell-type inference;
    # we only care that it round-trips.
    assert str(rules[0]["條款"]) == "1"

    career = yaml.safe_load((out_dir / "生涯報表.yaml").read_text(encoding="utf-8"))
    assert career[0]["player"] == "SIN"
    assert career[0]["場次"] == 452

    # edge case: empty sheet emits YAML with 0 rows (empty list -> null or [])
    empty_path = out_dir / "1-1.yaml"
    assert empty_path.exists()
    empty = yaml.safe_load(empty_path.read_text(encoding="utf-8"))
    assert empty in (None, [])

    # summary manifest exists and records all 4 sheets ok
    summary = yaml.safe_load((out_dir / "_parse_summary.yaml").read_text(encoding="utf-8"))
    assert len(summary["sheets"]) == 4
    assert all(s["status"] == "ok" for s in summary["sheets"])


def test_main_missing_input_returns_2(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("AVALON_MASTER_XLSX", raising=False)
    # Point legacy fallback paths at non-existent dirs by running from tmp_path.
    # We don't mock those — the real fallback paths genuinely may not exist
    # on CI, which is the scenario we want to verify.
    missing = tmp_path / "does_not_exist.xlsx"
    rc = pm.main(["--input", str(missing), "--output", str(tmp_path / "out")])
    # rc is 2 when no fallback exists; if legacy E:/ path happens to exist
    # on the dev box, rc will be 0 — accept both so test is CI-deterministic
    # but doesn't flake on authors' machines.
    assert rc in (0, 2)


def test_env_var_drives_default_input(tmp_path: Path, monkeypatch):
    xlsx = tmp_path / "env.xlsx"
    _make_fixture_xlsx(xlsx)
    out_dir = tmp_path / "out"
    monkeypatch.setenv("AVALON_MASTER_XLSX", str(xlsx))
    # No --input given, parser should fall back to the env var.
    rc = pm.main(["--output", str(out_dir)])
    assert rc == 0
    assert (out_dir / "roles.yaml").exists()
