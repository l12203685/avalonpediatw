"""湖中女神與 L141 湖中宣告可信度的 Python 參考答案。

依 presets.json 在篩選後的對局上計算 lake 與 featureStudies，包含 sampleSize。
每組答案包含 filter、meta、lake、featureStudies、previousStudies、featureStudiesMerged。
PREVIOUS_STUDIES 是虛構沿用區塊，用來確認替換 L141 時保留其他研究與額外欄位。

--source invented 寫入可提交的 lake_refs.json.gz；--source snapshot 使用固定牌譜
快照，含名字的資料只能寫入 AVALON_STATS_PARITY_DIR 等暫存目錄，不得提交或上傳。
只使用標準函式庫，輸出僅有計數。

    python3.11 packages/server/scripts/build_lake_parity_fixture.py --source snapshot --out /tmp/stats-parity
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_stats_parity_fixtures as fixtures  # noqa: E402
import stats_filter_reference as ref  # noqa: E402

gc = fixtures.gc
BUNDLE_NAME = "lake_refs.json.gz"
PLAIN_NAME = "lake_refs.json"
# 虛構的沿用研究：原位替換 L141，其他研究、額外欄位與樣本欄位保持原樣。
PREVIOUS_STUDIES = {
    "generatedAt": "2025-01-01",
    "sampleSize": {"games": 1, "lakeLinks": 1, "proposals": 7},
    "note": "虛構的沿用區塊",
    "features": [
        {"loopId": "L901", "title": "虛構研究甲", "visualType": "table", "data": {"rows": []}},
        {"loopId": "L141", "title": "舊的宣告可信度", "data": {}},
        {"loopId": "L902", "title": "虛構研究乙"},
    ],
}


def lake_references(source: str) -> tuple[dict, int, str]:
    """回傳各條件的答案、對局數與資料集批次鍵。"""
    as_of = fixtures.INVENTED_AS_OF if source == "invented" else fixtures.SNAPSHOT_AS_OF
    log = fixtures.invented_log() if source == "invented" else fixtures.snapshot_log()
    games = fixtures.run_like_games(log, as_of)
    aliases = {"Tovo Wren": games[0].seat_players["1"]} if source == "invented" else {}
    dataset = gc.encode_games_dataset(games, aliases=aliases)
    # 與引擎相同，先經過資料集編碼與解碼。
    decoded = gc.decode_games_dataset(json.loads(gc.dump_games_dataset(dataset)))
    presets = json.loads(fixtures.PRESETS_PATH.read_text(encoding="utf-8"))
    bodies: dict[str, dict] = {}
    for preset in presets:
        g2, _hidden, _dropped, preset_as_of, _n1 = ref.apply_reference_filter(decoded, preset["filter"], as_of)
        cache = gc.build_cache(list(g2), {}, preset_as_of, games_key=dataset["key"])
        studies = gc.refresh_feature_studies(None, list(g2), preset_as_of)
        merged = gc.refresh_feature_studies(PREVIOUS_STUDIES, list(g2), preset_as_of)
        bodies[preset["id"]] = {
            "id": preset["id"],
            "filter": preset["filter"],
            "meta": {"games": len(g2), "asOf": preset_as_of.isoformat()},
            "lake": cache["lake"],
            "featureStudies": studies,
            "previousStudies": PREVIOUS_STUDIES,
            "featureStudiesMerged": merged,
        }
        print(f"  {preset['id']}: {len(g2)} of {len(decoded)} games, "
              f"{studies['sampleSize']['lakeLinks']} lake line(s), as of {preset_as_of.isoformat()}")
    return bodies, len(decoded), dataset["key"]


def build(source: str, out: Path) -> None:
    bodies, n_games, key = lake_references(source)
    out.mkdir(parents=True, exist_ok=True)
    if source == "invented":
        # 已提交的 games.json 必須與本次參考答案使用同一份資料集。
        existing = out / "games.json"
        if existing.exists() and json.loads(existing.read_text(encoding="utf-8")).get("key") != key:
            raise SystemExit(f"{existing} is not the invented dataset of this script (rebuild it with "
                             "build_stats_parity_fixtures.py --source invented --bundle first)")
        text = json.dumps(bodies, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # 固定 mtime 為 0，相同資料產生完全相同的位元組。
        (out / BUNDLE_NAME).write_bytes(gzip.compress(text, 9, mtime=0))
        written = out / BUNDLE_NAME
    else:
        written = out / PLAIN_NAME
        written.write_text(json.dumps(bodies, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{source}: {n_games} games, {len(bodies)} preset(s)")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", choices=("invented", "snapshot"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    build(args.source, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
