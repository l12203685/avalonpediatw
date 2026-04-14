# External Media References

> Last updated: 2026-04-14 09:59 +08
> Purpose: 這些媒體體積太大不進 repo，此檔記錄原始路徑 + 未來 R2 / CDN 的 canonical URL。

## Policy

| 大小/類型 | 儲存策略 |
|-----------|----------|
| < 5 MB 圖片 | 進 `assets/images/` |
| 5–20 MB | 進 Git LFS |
| > 20 MB 或總量大 | 走 Cloudflare R2 public bucket |
| 聊天圖庫長尾（> 1 GB） | 不上線，僅內部路徑記錄 |

R2 public base (pending): `https://media.avalonpediatw.com/` （或暫用 `https://pub-<hash>.r2.dev/`）

---

## 角色影片（待上 R2）

Bucket: `avalonpediatw-media`
Prefix: `characters/`
總大小: ~51.4 MB (6 檔)

| # | 檔名 | 原路徑 | 大小 (B) | R2 Key | R2 URL (pending) |
|---|------|--------|---------:|--------|------------------|
| 1 | 刺客有多關鍵.mp4 | `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\刺客有多關鍵 #刺客 #桌上遊戲 #梅林 #魔甘娜 #阿瓦隆 #魔甘娜 #莫德雷德 #抵抗組織.mp4` | 8,581,494 | `characters/assassin.mp4` | `TBD` |
| 2 | 派西維爾有多難分.mp4 | `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\派西維爾有多難分 #派西維爾 #桌上遊戲 #梅林 #魔甘娜 #阿瓦隆 #抵抗組織 #莫德雷德 #刺客.mp4` | 9,311,436 | `characters/percival.mp4` | `TBD` |
| 3 | 梅林有多重要.mp4 | `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\梅林有多重要 #梅林 #桌上遊戲 #魔甘娜 #莫德雷德 #阿瓦隆 #抵抗組織 #抵抗組織 #刺客.mp4` | 8,859,001 | `characters/merlin.mp4` | `TBD` |
| 4 | 莫甘娜有多難玩.mp4 | `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\莫甘娜有多難玩 #阿瓦隆 #桌上遊戲 #梅林 #魔甘娜 #派西維爾 #抵抗組織 #shorts.mp4` | 9,787,433 | `characters/morgana.mp4` | `TBD` |
| 5 | 莫德雷德有多強.mp4 | `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\莫德雷德有多強 #桌上遊戲 #梅林 #莫德雷德 #阿瓦隆 #魔甘娜.mp4` | 8,554,551 | `characters/mordred.mp4` | `TBD` |
| 6 | 奧伯倫到底有多爛.mp4 | `C:\Users\admin\GoogleDrive\專案\阿瓦隆百科\assets\videos\奧伯倫到底有多爛_ #桌上遊戲 #阿瓦隆 #奧伯倫 #梅林 #魔甘娜 #莫德雷德 #shorts #阿瓦隆百科.mp4` | 6,871,574 | `characters/oberon.mp4` | `TBD` |

---

## Discord 圖庫（不上線）

- 路徑: `C:\downloads\阿瓦隆百科_同步閒聊\`
- 總檔數: **3382**
  - `.jpg`: 2804
  - `.png`: 566
  - `.mp4`: 12
- 總體積: **~1.2 GB**
- 時間範圍（檔名時戳）: 2024-02-08 ~ 2025-12-19
- 用途: 內部參考/長尾素材；含社群私密對話截圖，**禁止公開**
- 檔名格式: `YYYYMMDDhhmmssNNNNNN[_image].{jpg,png,mp4}`

### Policy
- 不進 git repo
- 不上 R2
- 精選需上站的素材 → 人工挑 → 進 `assets/images/` 或 R2
- 保留原始備份在本地 + 外接 HDD

---

## R2 Upload TODO

- [ ] Edward 開 Cloudflare 帳號
- [ ] 在 Cloudflare dashboard → R2 → Create Bucket `avalonpediatw-media`
- [ ] Enable public access（或綁 custom domain `media.avalonpediatw.com`）
- [ ] 產 API token（Workers & Pages → R2 → Manage R2 API Tokens）
- [ ] 把 credentials 寫入 `.env.r2`（見 `docs/setup/r2.md`）
- [ ] `pip install boto3`
- [ ] `python scripts/upload_r2.py --dry-run` 驗證
- [ ] `python scripts/upload_r2.py` 實際上傳
- [ ] 更新本檔 R2 URL 欄
- [ ] commit 更新到 `feat/m0.5b-r2-upload` 分支

詳見 `docs/setup/r2.md`。
