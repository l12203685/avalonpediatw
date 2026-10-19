"""精確捨入工具的 Python 參考答案，固定亂數種子、不依賴日期。

涵蓋 round(x * 10) / 10 的五成雙、勝率、格式化到整數及一位小數、Fraction 精確補值、
Unicode 碼位排序與從左到右加總。只輸出虛構資料至 pyround_cases.json。

    python3.11 packages/server/scripts/build_pyround_fixture.py
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER))
import generate_cache as gc  # noqa: E402

OUT = SERVER / "src" / "__tests__" / "fixtures" / "stats_parity" / "pyround_cases.json"


def main() -> int:
    rng = random.Random(20261014)
    ties = [0.05, 0.15, 0.25, 0.35, 0.45, 2.675, 56.25, 56.35, 40.5, 41.5, -2.5, -0.25, -0.04, 12.345, 99.95, 0.0, -0.0]
    floats = ties + [rng.uniform(-100, 100) for _ in range(150)] + [rng.randint(0, 2000) / 20 for _ in range(150)]
    rnd1 = [[x, gc.rnd1(x)] for x in floats]
    rate = [[c, t, gc._rate(c, t)] for t in range(0, 61) for c in range(0, t + 1)]
    fmt = [[x, f"{x:.1f}", f"{x:.0f}"] for x in floats + [0.5, 1.5, 2.5, 0.125, 0.375, 1e-7, 123456.75]]
    cells = []
    for _ in range(400):
        games = rng.randint(0, 6)
        wins = rng.randint(0, games)
        population = gc.rnd1(rng.uniform(0, 100))
        min_cell = rng.choice([0, 1, 3, 5])
        cells.append([wins, games, population, min_cell, gc._round_exact(gc._cell_rate(wins, games, population, min_cell))])
    names = ["測試𠀀", "測試😀", "Ｚ測試", "測試", "測試", "abc", "ABC", "émile", "Zeta", "測試a", "測試ｚ"]
    sums = [[xs, gc._sum_ltr(xs)] for xs in ([rng.uniform(0, 100) * rng.randint(0, 50) for _ in range(7)] for _ in range(100))]
    doc = {"rnd1": rnd1, "rate": rate, "format": fmt, "cells": cells, "sorted": sorted(names), "names": names, "sumLtr": sums}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{len(rnd1)} rnd1, {len(rate)} rate, {len(fmt)} format, {len(cells)} cell cases -> {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
