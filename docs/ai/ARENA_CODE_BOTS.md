# AI 擂台第 2 階段：寫程式的機器人（設計，尚未實作）

> 狀態：**只有設計**（2026-11-26）。第 1 階段（profile 機器人：AI騎士 引擎 ＋ 白名單開關，不執行任何人的程式碼）已上線，
> 見 [`community-bots/README.md`](../../community-bots/README.md) 與 [`docs/BOTS.md`〈AI 擂台〉](../BOTS.md#ai-擂台社群自建機器人)。
> 這份文件說第 2 階段要怎麼做，才能讓任何人交「真的程式」而不危害網站、帳號與其他人。開工前要站長點頭（對外開放執行陌生程式碼）。

## 1. 目標與不做的事

- 目標：任何人（或他的 AI）可以交一支自己寫的阿瓦隆機器人程式，在擂台裡和AI騎士、profile 機器人、其他程式機器人對打，上同一個排行榜。
- 不做：程式機器人**不會**坐進網站上的真人房間、LINE／Discord 群組或模擬瓦；那些永遠只跑AI騎士（見第 7 節）。
- 不做：不給網路、不給檔案系統、不給任何 secret、不給其他座位看不到的資訊。

## 2. 介面：`act(observation) → action`

沿用伺服器現有的 `AvalonAgent`（`packages/server/src/ai/types.ts`）的形狀，但只給**合法看得到的資訊**，並用純資料（JSON）溝通：

```ts
// 擂台送進沙盒的東西（JSON；每次決策一份，機器人沒有持久狀態以外的管道）
interface ArenaObservation {
  version: 1;
  phase: 'team_select' | 'team_vote' | 'quest_vote' | 'lake_pick' | 'lake_declare' | 'assassination';
  playerCount: number;
  me: { seat: number; role: Role; team: 'good' | 'evil' };
  /** 這個角色本來就知道的：梅林看到的紅（不含莫德雷德）、紅方隊友（奧伯倫例外）、派西的兩根拇指（不分誰是誰）。 */
  known: { evilSeats?: number[]; thumbSeats?: number[] };
  round: number;            // 1–5
  attempt: number;          // 本局第幾次提議（1–5）
  leaderSeat: number;
  proposedTeam: number[];
  /** 全部公開紀錄：每次提議（隊長、隊伍、每個人的票）、每次任務（隊伍、失敗張數）、每次湖（持湖、目標、宣告）。 */
  history: PublicHistory;
  /** 自己湖到的真實陣營（只有持湖者自己知道）。 */
  privateLake?: { targetSeat: number; team: 'good' | 'evil' }[];
  legal: LegalActions;      // 這一步能做的事（隊伍大小、可湖的人、可刺的人…）
}

type ArenaAction =
  | { type: 'team_select'; seats: number[] }
  | { type: 'team_vote'; approve: boolean }
  | { type: 'quest_vote'; success: boolean }      // 好人送 false 會被改成 true（規則就是這樣），並記一次違規
  | { type: 'lake_pick'; targetSeat: number }
  | { type: 'lake_declare'; claim: 'good' | 'evil' }
  | { type: 'assassinate'; targetSeat: number };
```

- 觀察由擂台從引擎狀態**重新組出來**（不是把伺服器內部物件丟進去），欄位白名單、深拷貝、凍結；別的座位的角色與隱藏資訊一律不在裡面。
  這一層可以直接沿用 `SelfPlayEngine.buildObservation` 再過一個「只留公開與本角色資訊」的轉換，並用測試鎖住：
  對每個角色、每個階段，觀察裡出現的座位資訊必須是那個角色在真人局看得到的（「玩家沒有發言以外的資訊」，站長 2026-11-25）。
- 非法動作（隊伍人數不對、湖不能湖的人、逾時、丟例外）→ 該步換成**預設動作**（交給AI騎士 在那個座位做一次決定），並記一次違規；
  一局違規超過 3 次判該座位那局輸並標記，排行榜另列違規率。
- 機器人可以在一局內保留自己的記憶（模組內變數），但每局開始時沙盒重建，局與局之間不留東西（防止跨局作弊與記憶體洩漏）。

## 3. 沙盒

候選三種，建議順序：

| 方案 | 隔離 | 時間／記憶體限制 | 語言 | 評估 |
|---|---|---|---|---|
| **WASM（WASI 關掉所有 import 以外的能力）** | 最強：沒有 syscalls，只有我們給的 `act` 進出口 | 燃料計量（fuel）＋線性記憶體上限 | Rust／C／AssemblyScript／Go（TinyGo）、Python（Pyodide 太大，不建議） | **建議第一個做**：確定性最好、跨平台、GitHub Actions 上就能跑 |
| `isolated-vm`（V8 isolate） | 強：獨立 heap，沒有 `require`、`process`、網路 | `memoryLimit`、`timeout` | JavaScript／TypeScript（先轉 JS） | 第二個：JS 作者最多；原生模組要編譯，Node 版本升級要跟 |
| `worker_threads` ＋ `vm` | **弱**：`vm` 不是安全邊界 | `resourceLimits`、自己計時 | JS | 只能當開發用，不能跑陌生程式碼 |

共同規則：

- **沒有網路、沒有檔案系統、沒有環境變數、沒有時間來源**（`Date.now` 換成固定值、`Math.random` 換成以 (seed, 座位, 決策) 播種的亂數，和第 1 階段的共同亂數同一套）。
- 每次決策 **50 ms**、每局 **2 s** CPU 上限；記憶體 **64 MB**；程式大小 **1 MB**（WASM）／**256 KB**（JS 原始碼）。超過 = 該步預設動作＋違規。
- 擂台在**獨立的 GitHub Actions job** 跑（`permissions: {}`、不掛任何 secret、`runs-on` 拋棄式的 runner），結果只輸出排行榜 JSON，
  再由另一個只有 `contents: write` 的 job 驗證格式後 commit。執行陌生程式碼的 job 拿不到寫入權限。
- 確定性：同一個 seed、同一份程式 → 同樣的結果（WASM 天生；JS 靠固定亂數與禁用時間）。排行榜附 seed，任何人可以本機重現。

## 4. 投稿與審查

- 資料夾：`community-bots/<id>/` 多一個 `bot.wasm`（或 `bot.js`）＋ `profile.json`（名字、作者、說明，`kind: "code"`）＋ 原始碼（必須附，WASM 要能從原始碼重建）。
- PR 自動檢查（`pull_request`，fork 安全，不跑投稿的程式）：檔案白名單、大小、`profile.json`、WASM 匯入表只能有我們允許的函式。
- **人工審查**後才合併：看原始碼有沒有試圖逃出沙盒、有沒有放玩家名字或冒犯內容。合併 = 同意它進每週擂台。
- 每週擂台裡程式機器人跟第 1 階段一樣隨機座位、兩邊都坐；違規率高的自動暫停並開 Issue 通知作者。
- 一人一隻（程式與 profile 合計），之後再看要不要放寬。

## 5. 本機開發

- `arena:local` 加 `--code community-bots/<id>/bot.wasm`：在本機用同一個沙盒跑，和第 1 階段一樣印成對比較的報表。
- 提供兩個起手範本：`_examples/code-random`（合法隨機）與 `_examples/code-baseline`（把觀察轉回呼叫AI騎士 的薄包裝，示範介面）。
- 介面的型別定義與 JSON Schema 放在 `packages/server/src/arena/codeBot/`，任何語言都能照 schema 實作。

## 6. 排行榜

- 同一個 `arena/leaderboard.json`，`source` 多一種 `code`；另加 `violations`（每 100 個決策的違規數）。
- 評分方法不變（分陣營的隊伍邏輯回歸、AI騎士 = 1500）。

## 7. 網站上的AI騎士 與擂台機器人分開

- 網站房間、LINE／Discord、模擬瓦用的 bot 程式只 import `src/ai/**`；擂台的沙盒與載入器放在 `src/arena/**` 與 `scripts/arena*`，
  加一條 lint 規則（`no-restricted-imports`）禁止 `src/bots/**`、`src/socket/**`、`src/routes/**` import `src/arena/codeBot/**`。
- 擂台只在 GitHub Actions 跑，不在 Render 的伺服器上跑：伺服器不會載入任何社群程式碼，社群資料夾也不在 Render 的 buildFilter 裡。
- 擂台的結果**不會自動改AI騎士 的預設**。如果某隻機器人的打法值得學，照現有流程做成開關、在 `docs/ai/` 量過再採用。

## 8. 開工前要決定的事（給站長）

1. 要不要開放執行陌生程式碼（即使在沙盒裡）？建議：先開 WASM 一種、人工審查後才合併。
2. 先支援哪些語言？建議：Rust／AssemblyScript（WASM）；JS（isolated-vm）第二步。
3. 違規太多時要自動暫停還是只標記？建議：自動暫停並開 Issue。
