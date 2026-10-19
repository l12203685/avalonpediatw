"""任務、派隊與隊長區塊的 Python 參考答案。

missions、rounds、captainAnalysis 僅依保留的對局計算，不因隱藏玩家或基準日改變。
依 presets.json 套用獨立的 Python 篩選器，產生 mission_refs.json.gz：
    presets：每組條件的局數與三個完整區塊。
    odd：額外十局虛構異常資料的資料集與答案（僅 invented 模式）。

異常資料涵蓋大寫 X、跳過任務、提議與結果之間有湖線、全形隊長座號、沒有結果的
隊長、空白或異常首隊、異常局勢及非三種標準結果。答案從編碼後再解碼的資料計算；
若清理異常文字改變正式統計，產生器的 round-trip 守門會停寫資料集。

--source invented 可提交虛構測試檔；--source snapshot 含名字，只能寫至暫存目錄，
不得提交或上傳 artifact。只用標準函式庫，輸出僅有計數。

    python3.11 packages/server/scripts/build_mission_parity_fixture.py --source snapshot --out /tmp/stats-parity
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_stats_parity_fixtures as bpf  # noqa: E402
import generate_cache as gc  # noqa: E402
import stats_filter_reference as ref  # noqa: E402

MISSION_SECTIONS = ("missions", "rounds", "captainAnalysis")
INVENTED_FIXTURE = bpf.SERVER / "src" / "__tests__" / "fixtures" / "stats_parity" / "invented"
OUTPUT_NAME = "mission_refs.json.gz"

# 虛構欄位：分類、配置、結果、首隊、五個任務結果、五個回合、局勢及提案記錄。
ODD_GAMES = [
    # 大寫 X 不計失敗，沿用只數小寫 x 的定義。
    ("線瓦", "123456", "三藍活", "157", ["ooX", "oooo", "oooo", "", ""], ["藍", "藍", "藍", "", ""], "藍藍藍",
     ["1789", "ooX", "28901", "oooo", "390", "45678", "oooo"]),
    # 跳過第二局，第三局隊長缺結果；提案與結果間有湖線時，該任務找不到隊長。
    ("線瓦", "234561", "三紅", "246", ["oox", "", "ooxx", "ooxx", ""], ["紅", "", "紅", "紅", ""], "紅紅紅",
     ["2467", "oox", "3456", "ooxx", "6>7", "ooxx", "4123", "ooxx"]),
    # 全形隊長數字轉 ?，未知角色沿用忠臣；任務中的空白轉 ?，隊長筆數多於任務。
    ("面瓦", "987654", "三藍死", "1 5", ["ooo", "o o x", "oooo", "ooxo", "ooooo"], ["藍", "紅", "藍", "紅", "藍"], "藍紅藍紅藍",
     ["３145", "ooo", "71234", "oxox", "6123", "oooo", "8123", "ooxo", "9123", "ooooo", "1234", "ooo"]),
    # 沒有首隊、異常回合與局勢，以及三種標準結果以外的值。
    ("娛樂", "135790", "流局", "", ["xx", "ooo", "", "", ""], ["紅?", "藍", "", "", ""], "紅藍?", ["13", "xx"]),
    # 首隊重複座位且皆為紅方，結果缺值。
    ("", "112233", "", "113", ["oxx", "ooxx", "oxxx", "", ""], ["紅", "紅", "紅", "", ""], "紅紅紅", ["1123", "oxx"]),
    # 首隊含梅林與派西維爾，所有隊長皆為紅方。
    ("線瓦", "123456", "三紅", "56", ["ooo", "ooxx", "oxoo", "ooxo", "oxooo"], ["藍", "紅", "紅", "藍", "紅"], "藍紅紅藍紅",
     ["1567", "ooo", "2345", "ooxx", "3456", "oxoo", "4567", "ooxo", "1234", "oxooo"]),
    # 座位開頭但不是提案的行，以及先於提案出現的結果。
    ("面瓦", "654321", "三藍活", "78", ["oo", "ooo", "oooo", "", ""], ["藍", "藍", "藍", "", ""], "藍藍藍",
     ["oo", "7 +3", "ooo", "0123", "oooo"]),
    # 局勢筆數同分時，維持第一次出現的順序。
    ("線瓦", "123456", "三藍死", "90", ["ooo", "oxo", "ooo", "oooo", ""], ["藍", "紅", "藍", "藍", ""], "藍紅藍藍",
     ["9012", "ooo", "0123", "oxo", "1234", "ooo", "2345", "oooo"]),
    ("線瓦", "123456", "三紅", "12", ["oxo", "ooo", "oox", "oxxo", ""], ["紅", "藍", "紅", "紅", ""], "紅藍紅紅",
     ["1234", "oxo", "2345", "ooo", "3456", "oox", "4567", "oxxo"]),
    ("娛樂", "246801", "三紅", "2468", ["xox", "xoox", "xxx", "", ""], ["紅", "紅", "紅", "", ""], "紅紅紅",
     ["2468", "xox", "4680", "xoox", "6802", "xxx"]),
]


def odd_log() -> list[list[str]]:
    rows = [bpf.HEADERS]
    names = bpf.INVENTED_PLAYERS[:10]
    for i, (cat, config, outcome, r11, results, rounds, state, lines) in enumerate(ODD_GAMES):
        cells = {
            "流水號": str(i + 1), "文字記錄": "\n".join(lines), "配置": config, "分類": cat,
            "日期時間": f"2026/02/{i + 1:02d}", "場次": str(i + 1), "結果": outcome, "1-1": r11, "局勢": state,
        }
        for m in range(5):
            cells[bpf.HEADERS[bpf.HEADERS.index("第一局成功失敗") + m]] = results[m]
            cells[bpf.HEADERS[bpf.HEADERS.index("第一局") + m]] = rounds[m]
        cells.update({gc.PLAYER_COLUMNS[s]: n for s, n in zip(gc.SEATS, names)})
        rows.append([cells.get(h, "") for h in bpf.HEADERS])
    return rows


def mission_sections(games: list[gc.GameRow], as_of: dt.date) -> dict:
    """產生器對指定對局寫出的任務、回合與隊長區塊。"""
    cache = gc.build_cache(list(games), {}, as_of)
    return {key: cache[key] for key in MISSION_SECTIONS}


def decoded_games(games: list[gc.GameRow]) -> tuple[dict, list[gc.GameRow]]:
    """回傳資料集及解碼後的對局，與每日寫檔及引擎讀取流程一致。"""
    dataset = gc.encode_games_dataset(games)
    return dataset, gc.decode_games_dataset(json.loads(gc.dump_games_dataset(dataset)))


def build(source: str, out: Path) -> None:
    as_of = bpf.INVENTED_AS_OF if source == "invented" else bpf.SNAPSHOT_AS_OF
    games = bpf.run_like_games(bpf.invented_log() if source == "invented" else bpf.snapshot_log(), as_of)
    _, decoded = decoded_games(games)
    presets = json.loads(bpf.PRESETS_PATH.read_text(encoding="utf-8"))
    bundle: dict = {"presets": {}}
    for preset in presets:
        g2, *_ = ref.apply_reference_filter(decoded, preset["filter"], as_of)
        bundle["presets"][preset["id"]] = {
            "id": preset["id"], "filter": preset["filter"], "games": len(g2), "sections": mission_sections(g2, as_of),
        }
        print(f"  {preset['id']}: {len(g2)} of {len(decoded)} games")
    if source == "invented":
        dataset, odd = decoded_games(bpf.run_like_games(odd_log(), as_of))
        bundle["odd"] = {"dataset": dataset, "sections": mission_sections(odd, as_of)}
        print(f"  odd: {len(odd)} games")
    out.mkdir(parents=True, exist_ok=True)
    text = json.dumps(bundle, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    # 固定 mtime 為 0，相同資料產生完全相同的位元組。
    (out / OUTPUT_NAME).write_bytes(gzip.compress(text, 9, mtime=0))
    print(f"{source}: {len(decoded)} games, {len(presets)} presets")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", choices=("invented", "snapshot"), required=True)
    parser.add_argument("--out", type=Path, help=f"default for --source invented: {INVENTED_FIXTURE}")
    args = parser.parse_args(argv)
    out = args.out or (INVENTED_FIXTURE if args.source == "invented" else None)
    if out is None:
        parser.error("--out is required for --source snapshot")
    build(args.source, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
