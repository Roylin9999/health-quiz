# 60 秒健康選品 — 部署說明

架構：一個 Cloudflare Worker（網頁＋API）＋ D1 資料庫（店主資料、顧客測驗紀錄）。

```
public/index.html   網頁本體（問卷、結果頁、店主專區）
src/worker.js       後端 API；第一次使用時會自動建立資料表
wrangler.jsonc      Worker 設定（D1 繫結）
```

## 一、建立 Worker 專案（只要一次）
1. Cloudflare 後台 → Workers 和 Pages → 建立 → 連接 GitHub，選 `health-quiz`。
2. 建置命令留空，部署命令維持 `npx wrangler deploy`，按 Deploy。

## 二、建立 D1 資料庫（只要一次）
1. Cloudflare 後台 → 儲存和資料庫 → D1 → 建立資料庫，名稱 `health-quiz-db`。
2. 複製資料庫 ID，填進 `wrangler.jsonc` 的 `d1_databases`（或把 ID 交給 Claude 處理）。
3. 資料表不用手動建立，網站第一次被使用時會自動建立。

## 三、管理密鑰（選填）
進 Worker 專案 → 設定 → 變數和密鑰，新增**密鑰（Secret）** `ADMIN_KEY`（自己訂一串密碼）。
之後可用 `/api/admin/results`（標頭 `x-admin-key`）查看所有店主與紀錄。

## 之後怎麼更新
改完推上 GitHub，Cloudflare 會自動重新部署，約 1 分鐘生效。

## 資料與權限
- 店主密碼以 PBKDF2 雜湊儲存，不存明碼。
- 顧客端只拿得到店舖的公開資訊（店舖名稱、會員編號、LINE ID），拿不到店主 Email。
- 每位店主登入後只看得到自己顧客的紀錄。
- 寄信服務：FormSubmit。第一次使用請在店主專區按「寄送測試信」，到信箱點 Activate。

## 串接蘇打餅（挑戰計劃）

`wrangler.jsonc` 已經設定好：店舖 `dkstore` 的顧客結果，會在背後送到蘇打餅（`SYNC_STORE`、`SYNC_URL`，並用服務繫結 `PLAN` 連到 challenge-plan）。
只要在兩個 Worker 都新增同一個密鑰 `INBOX_KEY`（設定 → 變數和密鑰 → 類型選「密鑰」）就會開始傳。
沒設定 `INBOX_KEY` 時不會傳，其他功能照常。要讓更多店舖送過去，把 `SYNC_STORE` 改成用逗號隔開，例如 `dkstore,abcstore`。

## 總後台

1. Cloudflare → health-quiz → 設定 → 變數和密鑰 → 新增，類型選「密鑰」：名稱 `ADMIN_KEY`，內容自己訂一串長一點的密碼。
2. 打開 `https://health-quiz.wellstoryhall.com/#admin`，輸入這組密鑰。
3. 可以看到全部店主和顧客紀錄，可以刪除店主（可選擇連同顧客紀錄一起刪）或單筆顧客紀錄。

店主自己在店主專區也能刪除自己的顧客紀錄。刪除不會影響已經送進蘇打餅名單的資料。
