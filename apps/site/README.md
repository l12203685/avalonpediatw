# Avalonpedia TW — Site (Astro 5 POC)

繁體中文亞瓦隆百科前端，Astro 5 + MDX + Tailwind + pagefind，部署目標 Cloudflare Pages。

## 結構

```
apps/site/
├── astro.config.mjs
├── tailwind.config.mjs
├── src/
│   ├── content/
│   │   ├── config.ts          # Content Collections schema
│   │   └── roles/*.mdx        # 角色條目（繁中檔名）
│   ├── layouts/BaseLayout.astro
│   ├── pages/
│   │   ├── index.astro
│   │   ├── search.astro       # pagefind UI
│   │   └── 角色/
│   │       ├── index.astro
│   │       └── [...slug].astro  # 繁中 slug 動態路由
│   └── styles/global.css
```

## 指令

```bash
# 於 repo root 執行
pnpm install
pnpm --filter @avalonpediatw/site dev       # http://localhost:4321
pnpm --filter @avalonpediatw/site build     # 產出 dist/ 並建 pagefind index
pnpm --filter @avalonpediatw/site preview   # 預覽正式建置結果
```

## 繁中 URL

使用 Content Collections + `[...slug].astro` 動態路由。檔名 `梅林.mdx` 產出 `/角色/梅林/`，URL 會 percent-encode 但路徑保持中文字元。

## 搜尋

`astro-pagefind` integration 於 build 階段自動產生 index（`dist/pagefind/`）。`<Search>` component 於 `/search/` 頁面提供 UI。
