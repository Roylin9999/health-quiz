# 60 秒健康選品 — 部署說明

純靜態網站（一個 `public/index.html`），用 Cloudflare Workers 的靜態資產功能發布。

## 第一次設定（只要做一次）
1. Cloudflare 後台 → Workers 和 Pages → 建立 → 連接 GitHub，選這個 repo（health-quiz）。
2. 建置命令留空，部署命令維持 `npx wrangler deploy`，按 Deploy。
3. 完成後網址會是 `https://health-quiz.<你的帳號>.workers.dev`。

## 之後怎麼更新
改完 `public/index.html` 推上 GitHub，Cloudflare 會自動重新部署，約 1 分鐘生效。

## 店主使用
- 店主專區：網址後面加 `/#owner`，或首頁最下方「店主專區」。
- 第一次使用請在店主專區按「寄送測試信」，到信箱點 Activate 啟用（寄信服務：FormSubmit）。
