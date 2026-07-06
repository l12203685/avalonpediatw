# 自訂域名接線 SOP（Edward 註冊 domain 後執行）

> 給 M0.4 / §7 用。Edward 在註冊商（Cloudflare Registrar 或 Namecheap / Gandi）
> 拿到 `avalonpediatw.com` 之後，跟著以下步驟走。所有操作都能主 session 自己做，
> 除了需要你登入的那幾步。

## 前置

- Cloudflare account 已建立（M0.4 步驟 1）
- Cloudflare API token 已存到 `~/.claude/credentials/cloudflare_api_token.txt`
- 域名已付款完成，可在註冊商後台看到

## Phase 1 — DNS 接到 Cloudflare（5 min，Edward 手動）

若用 **Cloudflare Registrar** 買：DNS 自動接好，跳 Phase 2。

若用 **其他註冊商**：
1. 註冊商後台 → 域名管理 → Nameservers
2. 改成 Cloudflare 提供的兩個（CF dashboard → Websites → Add site 時會顯示）
3. 等生效（通常 10 min～2 hr；CF 會 email 通知）

## Phase 2 — 綁定 CF Pages（2 min，我自動跑）

域名生效後告訴我，我會跑：

```bash
# 透過 API 自動綁域名（不需 Edward 點 dashboard）
curl -X POST \
  "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/avalonpediatw/domains" \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"name":"avalonpediatw.com"}'

curl -X POST \
  "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/pages/projects/avalonpediatw/domains" \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"name":"www.avalonpediatw.com"}'
```

CF 會自動簽 SSL（~1 min）。

## Phase 3 — Firebase Hosting 自訂域名（若也要接 game platform）

遊戲平台目前跑在 `avalon-game-platform.web.app`。若想換成 `play.avalonpediatw.com`：

1. Firebase Console → Hosting → Add custom domain
2. 輸入 `play.avalonpediatw.com`
3. Firebase 給一組 TXT + A records
4. 回 Cloudflare DNS → 加那兩筆 record（Proxy status: **DNS only** 灰雲，不要開橘雲）
5. 等 Firebase 驗證（~15 min）
6. SSL 自動簽發（Firebase 代管，~24 hr 內完成）

> 這步非必要。M0.4 目標是 wiki，遊戲平台 `*.web.app` 可以繼續跑。

## Phase 4 — R2 媒體子域（M0.5 Phase 2，Launch 時做）

等 M0.5 實際上傳影片後，若要換 branded URL：

1. CF Dashboard → R2 → `avalonpediatw-media` bucket → Settings → Custom Domains
2. Add `media.avalonpediatw.com`
3. DNS record 自動建（同帳號免手動）
4. SSL 自動簽

前端 `<video src>` 從 `pub-xxx.r2.dev/...` 改成 `media.avalonpediatw.com/...`。

## 驗收

- [ ] `curl -I https://avalonpediatw.com` 回 200 + `server: cloudflare`
- [ ] `curl -I https://www.avalonpediatw.com` 同上
- [ ] 瀏覽器打開 `https://avalonpediatw.com` 見到 wiki 首頁（同 `*.pages.dev` 內容）
- [ ] SSL 綠鎖，證書 issuer = Google Trust Services（CF Pages 預設）

## 卡關處理

- DNS 不生效 > 24 hr：檢查 nameserver 是否真的改到 CF（`dig NS avalonpediatw.com`）
- SSL 一直 pending：CF Pages → Custom domains 頁面按 "Retry"
- 出現 Error 522：backend 沒回應；與自訂域名無關，多半是 Pages project 本身出錯
