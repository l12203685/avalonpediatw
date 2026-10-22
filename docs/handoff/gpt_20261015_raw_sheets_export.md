# 當次牌譜暫存匯出交接

分支：`gpt/raw-sheets-export`。此改動供 Gemini 的每日題庫重建使用；不依賴投票指標或複合篩選引擎。

## 行為與資料界線

`generate_cache.py --export-raw-sheets <path>` 在分析快取守門通過後，以 `{"牌譜": [[表頭...], [列...]]}` 匯出**同一次試算表抓取**、`merge_game_logs` 選定的原始列，不再次抓取資料。

- 依既有規則保留本表列，Discord 匯入依指紋或流水號排除重複；本表內的重複列仍依既有行為保留，沒有另改計數口徑。
- 無流水號或配置長度不符的列不匯出。不同來源的欄位順序會依表頭對齊，缺欄補空字串，匯入表新增欄位接在表頭末端。
- 保留原始姓名、日期與牌譜文字供題庫解析，未套用分析快取的別名或日期修正。這是私有暫存資料，與可公開的每局解析資料集不同。
- 分析快取因內容未變而不寫入時，仍匯出當次資料。未指定參數時不寫出原始列。
- 路徑必須位於 Git 工作目錄外，不能覆蓋分析快取；解析符號連結後再檢查。與 `--compare` 同用時以設定錯誤結束，不抓取、不寫檔。
- 原子寫入且權限固定 `0600`；匯出成功只新增「牌譜暫存匯出：N 列」一行，不印姓名、原文、路徑，也不將內容加入 job summary。N 是不含表頭的保留列數。
- 匯出失敗回傳 exit 4、不覆蓋分析快取；原子寫入的中間檔會清除。沒有修改既有其他記錄訊息。

## Gemini 整合方式

本分支沒有修改題庫程式、題庫資料或工作流程步驟。建議將產生與消費放在同一個 shell 步驟，讓成功與失敗都有 `EXIT` 清理：

```bash
set -euo pipefail
raw_sheets="$(mktemp "$RUNNER_TEMP/avalon-raw-sheets.XXXXXX")"
trap 'rm -f -- "$raw_sheets"' EXIT
python3.11 packages/server/generate_cache.py --export-raw-sheets "$raw_sheets"
pnpm --filter @avalon/server exec tsx scripts/buildSimBank.ts --cache "$raw_sheets"
```

工作流程的既有憑證環境設定沿用；不得把金鑰寫進上述命令或文件。不要開啟 shell 的 `set -x`。不得對暫存檔執行 `cat`、加入 `git add` 或交給 `upload-artifact`。提交清單維持明確列舉可公開的輸出檔。

若 Gemini 必須拆成不同步驟，消費步驟結束後另加 `if: always()` 的刪除步驟；清理必須在 commit 與 artifact 步驟之前。產生端不能自行在離開時刪除，否則後續的 `buildSimBank.ts` 無法讀取。工作流程整合與清理由 Gemini 負責，本分支未聲稱已接通每日排程。

## 修改檔案

| 檔案 | 修改 |
| --- | --- |
| `packages/server/generate_cache.py` | 解析時保留對應原始列、依既有合併決策選列、CLI 參數、私有原子匯出 |
| `packages/server/test_generate_cache.py` | 7 項使用虛構資料的匯出測試 |
| 本文件 | 呼叫契約、清理方式與檢查結果 |

## 數字驗證

手造案例：本表 2 列（刻意相同但沿用本表規則保留）；匯入表 4 列中 1 列無效、2 列重複、1 列新增，結果為 **3 列資料＋1 列表頭**。把匯出列重新解析後，每個 `GameRow` 欄位與合併結果相同。另一個 4 局固定日期案例，快取位元組未變仍匯出 **4 列資料＋1 列表頭**。

## 檢查結果

基底：2026-10-15 抓取的 `origin/main`，`0e387275a283b3b302944a38315548c5b8eba453`；交付前 rebase。Python 使用 3.11.17，pnpm 使用鎖檔指定的 8.15.4。

| 檢查 | 結果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通過；最初離線安裝因本機缺套件失敗，改正常安裝後通過，鎖檔未改 |
| Python 3.11 `-m py_compile generate_cache.py test_generate_cache.py` | 通過 |
| Python 3.11 `test_generate_cache.py` | 146 項：145 通過、1 項既有略過；新增 7 項均通過 |
| Python 3.11 `test_discord_records_import.py` | 102／102 通過 |
| `pnpm --filter @avalon/shared build` | 通過 |
| `pnpm --filter @avalon/server test` | 重跑通過：122 檔通過、1 檔略過；2,486 測試通過、28 略過 |
| server `type-check`、`lint` | 通過；lint 0 錯誤、160 項既有警告 |
| web `type-check`、`lint`、`build` | 通過；lint 0 錯誤、138 項既有警告 |
| 根目錄 `pnpm type-check` | 通過 |
| `git diff --check` | 通過 |

首次與型別／lint 檢查同時執行伺服器測試時，`PracticeMode.test.ts` 的第二局等待結束逾時，結果為 2,485 通過、1 失敗、28 略過。沒有修改測試、逾時門檻或練習模式程式；單獨重跑完整伺服器套件後全部通過。初次新增測試曾直接比較兩組 `GameRow` 物件身分而失敗，已改成逐欄位比對，完整 Python 套件重跑通過。

## 尚未執行與需要決定的事

未使用正式 Google 憑證抓取當日資料，測試使用固定日期的虛構試算表。未提交任何原始暫存資料，也未建立 artifact。Edward 無須新增決策；Gemini 整合後須驗證題庫成功及失敗兩種路徑都會清除暫存檔。
