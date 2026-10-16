"""複合篩選引擎的 Python 參考答案：每個欄位須與相同對局的快取完全一致。

依 fixtures/stats_parity/presets.json 的固定條件產出：
    games.json：每日產生器使用的每局資料集。
    context.json：固定基準日、來源、條件清單、別名與默契矩陣名單。
    ref/<id>.json：條件、計數與全部可重算區塊。
    --bundle：改寫 refs.json.gz；省略可從玩家列還原的 playerDetails。

--source invented 使用固定亂數種子的虛構玩家與對局，可提交至測試目錄。
--source snapshot 使用 sheets_cache.json 的 2,146 局快照，含名字的答案僅寫入
RUNNER_TEMP，測試透過 AVALON_STATS_PARITY_DIR 讀取；不得提交或上傳 artifact。
只使用標準函式庫，標準輸出僅有計數。基準日固定，不依賴執行當天。

    python3.11 packages/server/scripts/build_stats_parity_fixtures.py --source snapshot --out /tmp/stats-parity
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import random
import shutil
import sys
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVER))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import generate_cache as gc  # noqa: E402
import stats_filter_reference as ref  # noqa: E402

PRESETS_PATH = SERVER / "src" / "__tests__" / "fixtures" / "stats_parity" / "presets.json"
SNAPSHOT_AS_OF = dt.date(2026, 2, 28)  # 固定為快照最後一局的隔日
INVENTED_AS_OF = dt.date(2026, 2, 28)

HEADERS = (
    ["流水號", "文字記錄", "配置", "刺殺", "分類", "日期時間", "場次", "note"]
    + [gc.PLAYER_COLUMNS[s] for s in gc.SEATS]
    + ["結果", "1-1", "第一局成功失敗", "第二局成功失敗", "第三局成功失敗", "第四局成功失敗", "第五局成功失敗",
       "第一局", "第二局", "第三局", "第四局", "第五局", "局勢", "首湖", "二湖", "三湖"]
)
# 全部為虛構名字；擴充區字、表情與全形字用來驗證 Python 碼位排序和 JS 的差異。
INVENTED_PLAYERS = [f"虛構{c}" for c in "甲乙丙丁戊己庚辛壬癸子丑寅卯辰"] + ["測試𠀀", "測試😀", "Ｚ測試"]
INVENTED_NEWCOMERS = ["新手一", "新手二"]
TEAM_SIZES = (3, 4, 4, 5, 5)
NOTES = ["", "", "", "", "S2", "古亭", "九號", "我旁觀", "[1-1]虛構的事件", "虛構私揪"]


def invented_log(n_games: int = 520, seed: int = 20261014) -> list[list[str]]:
    """固定種子的虛構牌譜，日期 2024-01-01 至 2026-02-27；含缺日期、缺名字、缺結果與近期新人。"""
    rng = random.Random(seed)
    start, end = dt.date(2024, 1, 1), dt.date(2026, 2, 27)
    span = (end - start).days
    rows = [HEADERS]
    for i in range(n_games):
        day = start + dt.timedelta(days=i * span // (n_games - 1))
        date = "" if i < 3 else ("1900/01/01" if i % 37 == 0 else f"{day.year}/{day.month:02d}/{day.day:02d}")
        pool = list(INVENTED_PLAYERS)
        if (end - day).days < 60:
            pool += INVENTED_NEWCOMERS * 3
        names: list[str] = []
        for name in rng.sample(pool, len(pool)):
            if name not in names:
                names.append(name)
            if len(names) == 10:
                break
        if i % 11 == 5:
            for k in rng.sample(range(10), 3):
                names[k] = ""
        if i % 29 == 7:
            names = [names[0]] + [""] * 9
        seats = rng.sample(gc.SEATS, 10)
        config = "".join(seats[:6])
        roles = gc.decode_config(config)
        outcome = rng.choices(["三紅", "三藍死", "三藍活", ""], weights=[45, 24, 30, 1])[0]
        if outcome == "三紅":
            reds = 3
            blues = rng.choice([0, 1, 2])
        else:
            blues = 3
            reds = rng.choice([0, 1, 2])
        sequence = ["紅"] * reds + ["藍"] * blues
        last = sequence.pop(sequence.index("紅" if outcome == "三紅" else "藍"))
        rng.shuffle(sequence)
        sequence.append(last)
        missions = []
        for m, side in enumerate(sequence):
            size = TEAM_SIZES[m]
            if side == "藍":
                fails = 1 if (m == 3 and rng.random() < 0.2) else 0
            else:
                fails = 2 if m == 3 else rng.choice([1, 1, 2])
            missions.append("o" * (size - fails) + "x" * fails)
        merlin = next(s for s, r in roles.items() if r == "梅林")
        kill = ""
        if outcome == "三藍死":
            kill = merlin
        elif outcome == "三藍活":
            kill = rng.choice([s for s in gc.SEATS if s != merlin])
        lines = []
        lakes = ["", "", ""]
        for m, result in enumerate(missions):
            for _ in range(rng.choice([1, 1, 2, 3])):
                leader = rng.choice(gc.SEATS)
                team = "".join(rng.sample([s for s in gc.SEATS if s != leader], TEAM_SIZES[m] - 1))
                lines.append(f"{leader}{team}" + rng.choice(["", " +3", " -5"]))
            lines.append(result)
            if 1 <= m <= 3 and m < len(missions) - 1:
                holder, target = rng.sample(gc.SEATS, 2)
                lines.append(f"{holder}>{target}{rng.choice([' x', ' o', ' o', ''])}")
                lakes[m - 1] = f"{holder}>{target}"
        cells = {
            "流水號": str(i + 1), "文字記錄": "\n".join(lines), "配置": config, "刺殺": kill,
            "分類": rng.choices(["線瓦", "面瓦", "娛樂", ""], weights=[55, 30, 10, 5])[0], "日期時間": date,
            "場次": str(i % 6 + 1), "note": rng.choice(NOTES), "結果": outcome,
            "1-1": "".join(rng.sample(gc.SEATS, 3)), "局勢": "".join(sequence),
            "首湖": lakes[0], "二湖": lakes[1], "三湖": lakes[2],
        }
        for m, result in enumerate(missions):
            cells[HEADERS[HEADERS.index("第一局成功失敗") + m]] = result
            cells[HEADERS[HEADERS.index("第一局") + m]] = sequence[m]
        cells.update({gc.PLAYER_COLUMNS[s]: n for s, n in zip(gc.SEATS, names)})
        rows.append([cells.get(h, "") for h in HEADERS])
    return rows


def snapshot_log() -> list[list[str]]:
    data = json.loads((SERVER / "sheets_cache.json").read_text(encoding="utf-8"))
    return data["牌譜"]


def run_like_games(log: list[list[str]], as_of: dt.date) -> list[gc.GameRow]:
    """與每日 run 相同的解析、日期檢查、名字正規化與時間排序處理。"""
    games, _ = gc.drop_dates_after(gc.merge_game_logs(log, None).games, as_of)
    games, _ = gc.canonicalize_player_names(games)
    return gc.assign_timeline_dates(games)


def build(source: str, out: Path, bundle: bool = False) -> None:
    as_of = INVENTED_AS_OF if source == "invented" else SNAPSHOT_AS_OF
    games = run_like_games(invented_log() if source == "invented" else snapshot_log(), as_of)
    aliases = {"Tovo Wren": games[0].seat_players["1"]} if source == "invented" else {}
    dataset = gc.encode_games_dataset(games, aliases)
    decoded = gc.decode_games_dataset(json.loads(gc.dump_games_dataset(dataset)))
    presets = json.loads(PRESETS_PATH.read_text(encoding="utf-8"))
    shutil.rmtree(out / "ref", ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    gc.write_games_dataset_atomically(dataset, out / "games.json")
    roster = {"players": dataset["players"], "rowLabels": list(reversed(dataset["players"]))}
    context = {"asOf": as_of.isoformat(), "source": source, "presets": [p["id"] for p in presets],
               "aliases": aliases, "chemistryRoster": roster}
    (out / "context.json").write_text(json.dumps(context, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    bodies: dict[str, dict] = {}
    for preset in presets:
        sections, meta = ref.reference_sections(decoded, preset["filter"], as_of, dataset["key"], aliases, roster)
        if bundle:
            sections.pop("playerDetails")
        bodies[preset["id"]] = {"id": preset["id"], "filter": preset["filter"], "meta": meta, "sections": sections}
        print(f"  {preset['id']}: {meta['games']} of {meta['totalGames']} games, "
              f"{meta['droppedPlayers']} dropped / {meta['hiddenPlayers']} hidden player(s), as of {meta['asOf']}")
    if bundle:
        text = json.dumps(bodies, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # 固定 mtime 為 0，相同資料產生完全相同的位元組。
        (out / "refs.json.gz").write_bytes(gzip.compress(text, 9, mtime=0))
    else:
        (out / "ref").mkdir()
        for preset_id, body in bodies.items():
            (out / "ref" / f"{preset_id}.json").write_text(json.dumps(body, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{source}: {len(games)} games, {len(dataset['players'])} players")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", choices=("invented", "snapshot"), required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bundle", action="store_true",
                        help="one refs.json.gz without playerDetails (the checked-in invented fixture)")
    args = parser.parse_args(argv)
    build(args.source, args.out, args.bundle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
