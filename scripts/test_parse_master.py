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
