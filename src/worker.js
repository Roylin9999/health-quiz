// 60 秒健康選品 — Worker：網頁（public/）＋ API（/api/*）＋ D1 資料庫
// 資料庫繫結名稱：DB。沒有綁定時，網頁照常運作，只是不會存雲端紀錄。

const SLUG_RE = /^[A-Za-z0-9_-]{2,40}$/;
const UID_RE = /^[A-Za-z0-9]{2,20}$/;
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINE_RE = /^@?[A-Za-z0-9._-]{2,30}$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS owners (
     slug TEXT PRIMARY KEY COLLATE NOCASE,
     credit_user TEXT, email TEXT NOT NULL, line_id TEXT,
     pw_salt TEXT NOT NULL, pw_hash TEXT NOT NULL,
     token_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS results (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     store TEXT COLLATE NOCASE, customer TEXT NOT NULL,
     focus TEXT, recommendations TEXT, answers TEXT,
     emailed INTEGER DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS results_store ON results (store, created_at)`,
  // 店舖名稱一律用小寫（官網網址是小寫，例如 dkstore），舊資料也順手轉成小寫
  `UPDATE owners SET slug = lower(slug) WHERE slug <> lower(slug) COLLATE BINARY`,
  `UPDATE results SET store = lower(store) WHERE store <> lower(store) COLLATE BINARY`
];
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map(s => db.prepare(s)));
  // 新欄位：顧客看到的稱呼（例如 Roy）；已經有這個欄位時會報錯，忽略即可
  await db.prepare("ALTER TABLE owners ADD COLUMN display_name TEXT").run().catch(() => {});
  schemaReady = true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const err = (status, message) => json({ ok: false, error: message }, status);

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256));
}
const sha256 = async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function readJson(request, max = 20000) {
  const text = await request.text();
  if (text.length > max) throw new Error("too_large");
  return JSON.parse(text || "{}");
}
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

function ownerPublic(o) { return { slug: o.slug, credit_user: o.credit_user || "", line: o.line_id || "", name: o.display_name || "" }; }
function ownerPrivate(o) { return { ...ownerPublic(o), email: o.email }; }

async function authOwner(request, env, slug) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const o = await env.DB.prepare("SELECT * FROM owners WHERE slug = ?").bind(slug).first();
  if (!o || !o.token_hash) return null;
  return safeEqual(await sha256(token), o.token_hash) ? o : null;
}
async function newToken(env, slug) {
  const token = randHex(24);
  await env.DB.prepare("UPDATE owners SET token_hash = ?, updated_at = ? WHERE slug = ?")
    .bind(await sha256(token), Date.now(), slug).run();
  return token;
}

// 把顧客結果送到店主的挑戰計劃網站（例如蘇打餅）的收件匣，在背後進行、顧客看不到
// 設定：wrangler.jsonc 的 vars（SYNC_STORE 店舖、SYNC_URL 網址）、services 的 PLAN ＋ 密鑰 INBOX_KEY（兩邊設成一樣）
async function syncToPlan(env, slug, r) {
  if (!env.SYNC_URL || !env.INBOX_KEY) return false;
  const stores = String(env.SYNC_STORE || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  if (!stores.includes(String(slug).toLowerCase())) return false;
  const a = r.answers || {}, pick = re => { const k = Object.keys(a).find(k => re.test(k)); return k == null || a[k] == null ? [] : [].concat(a[k]).map(x => clip(x, 30)); };   // 用關鍵字找題目，題目文字改了也對得上
  const t = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  // 同一個 Cloudflare 帳號的 Worker 互相呼叫要走服務繫結 PLAN（直接 fetch workers.dev 會被擋）
  const go = env.PLAN ? (u, o) => env.PLAN.fetch(u, o) : fetch;
  const res = await go(String(env.SYNC_URL).replace(/\/+$/, "") + "/api/inbox", {
    method: "POST", signal: AbortSignal.timeout(6000),
    headers: { "content-type": "application/json", "x-inbox-key": env.INBOX_KEY },
    body: JSON.stringify({ id: `hq-${slug}-${r.id || Date.now()}`, store: slug, name: r.customer, date: t,
      age: pick(/年齡/)[0] || "", focus: r.focus, symptoms: pick(/變化/),
      products: r.recs.map(x => x.name) })
  });
  return res.ok;
}

async function sendMail(to, data, origin) {
  const r = await fetch("https://formsubmit.co/ajax/" + encodeURIComponent(to), {
    method: "POST", signal: AbortSignal.timeout(8000),
    headers: { "content-type": "application/json", accept: "application/json", origin, referer: origin + "/" },
    body: JSON.stringify(data)
  });
  const j = await r.json().catch(() => ({}));
  return String(j.success) === "true";
}
// 伺服器寄信失敗時（FormSubmit 常擋掉伺服器發出的請求），把信件內容交給瀏覽器改從前端寄
const mailJob = (to, data) => ({ to, data });

function isAdmin(request, env) {
  const key = request.headers.get("x-admin-key") || "";
  return !!env.ADMIN_KEY && safeEqual(key, env.ADMIN_KEY);
}

async function api(request, env, url, ctx) {
  if (!env.DB) return err(503, "資料庫尚未設定");
  await ensureSchema(env.DB);
  const p = url.pathname.replace(/\/+$/, "");
  const m = request.method;
  let mm;

  // 公開：顧客端讀取店主的店舖資訊（不含 Email）
  if (m === "GET" && (mm = p.match(/^\/api\/store\/([^/]+)$/))) {
    const o = await env.DB.prepare("SELECT * FROM owners WHERE slug = ?").bind(decodeURIComponent(mm[1])).first();
    return o ? json({ ok: true, store: ownerPublic(o) }) : err(404, "找不到這個店舖");
  }

  // 建立店主
  if (m === "POST" && p === "/api/owners") {
    const b = await readJson(request);
    const slug = clip(b.slug, 40).toLowerCase(), credit = clip(b.credit_user, 20).toUpperCase(), email = clip(b.email, 120),
          line = clip(b.line, 31), name = clip(b.name, 20), pw = String(b.password || "");
    if (!SLUG_RE.test(slug)) return err(400, "店舖名稱格式不正確");
    if (credit && !UID_RE.test(credit)) return err(400, "會員編號格式不正確");
    if (!MAIL_RE.test(email)) return err(400, "Email 格式不正確");
    if (line && !LINE_RE.test(line)) return err(400, "LINE ID 格式不正確");
    if (pw.length < 6) return err(400, "密碼至少 6 個字");
    const exists = await env.DB.prepare("SELECT slug FROM owners WHERE slug = ?").bind(slug).first();
    if (exists) return err(409, "這個店舖已經建立過了，請直接登入");
    const salt = randHex(16), now = Date.now();
    await env.DB.prepare(`INSERT INTO owners (slug, credit_user, email, line_id, display_name, pw_salt, pw_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(slug, credit || null, email, line || null, name || null, salt, await pbkdf2(pw, salt), now, now).run();
    const o = await env.DB.prepare("SELECT * FROM owners WHERE slug = ?").bind(slug).first();
    return json({ ok: true, owner: ownerPrivate(o), token: await newToken(env, o.slug) });
  }

  // 店主登入
  if (m === "POST" && p === "/api/owners/login") {
    const b = await readJson(request);
    const o = await env.DB.prepare("SELECT * FROM owners WHERE slug = ?").bind(clip(b.slug, 40)).first();
    if (!o || !safeEqual(await pbkdf2(String(b.password || ""), o.pw_salt), o.pw_hash)) return err(401, "店舖名稱或密碼不正確");
    return json({ ok: true, owner: ownerPrivate(o), token: await newToken(env, o.slug) });
  }

  // 店主：讀取／修改自己的資料
  if ((mm = p.match(/^\/api\/owners\/([^/]+)$/)) && (m === "GET" || m === "PUT")) {
    const o = await authOwner(request, env, decodeURIComponent(mm[1]));
    if (!o) return err(401, "請重新登入");
    if (m === "GET") return json({ ok: true, owner: ownerPrivate(o) });
    const b = await readJson(request);
    const credit = clip(b.credit_user, 20).toUpperCase(), email = clip(b.email, 120), line = clip(b.line, 31), name = clip(b.name, 20);
    if (credit && !UID_RE.test(credit)) return err(400, "會員編號格式不正確");
    if (!MAIL_RE.test(email)) return err(400, "Email 格式不正確");
    if (line && !LINE_RE.test(line)) return err(400, "LINE ID 格式不正確");
    let sql = "UPDATE owners SET credit_user = ?, email = ?, line_id = ?, display_name = ?, updated_at = ?", args = [credit || null, email, line || null, name || null, Date.now()];
    if (b.password) {
      if (String(b.password).length < 6) return err(400, "密碼至少 6 個字");
      const salt = randHex(16); sql += ", pw_salt = ?, pw_hash = ?"; args.push(salt, await pbkdf2(String(b.password), salt));
    }
    await env.DB.prepare(sql + " WHERE slug = ?").bind(...args, o.slug).run();
    const n = await env.DB.prepare("SELECT * FROM owners WHERE slug = ?").bind(o.slug).first();
    return json({ ok: true, owner: ownerPrivate(n) });
  }

  // 店主：自己的顧客紀錄
  if (m === "GET" && (mm = p.match(/^\/api\/owners\/([^/]+)\/results$/))) {
    const o = await authOwner(request, env, decodeURIComponent(mm[1]));
    if (!o) return err(401, "請重新登入");
    const { results } = await env.DB.prepare(
      "SELECT id, customer, focus, recommendations, answers, emailed, created_at FROM results WHERE store = ? ORDER BY created_at DESC LIMIT 500"
    ).bind(o.slug).all();
    return json({ ok: true, results });
  }

  // 店主：寄測試信
  if (m === "POST" && (mm = p.match(/^\/api\/owners\/([^/]+)\/test-mail$/))) {
    const o = await authOwner(request, env, decodeURIComponent(mm[1]));
    if (!o) return err(401, "請重新登入");
    const data = { _subject: `【健康選品｜${o.display_name || o.slug}】測試信`, _template: "table", _captcha: "false",
      "店主": o.display_name || o.slug, "店舖": o.slug, "說明": "這是測試信。收到這封信代表顧客的測驗結果可以正常寄到您的信箱。" };
    const ok = await sendMail(o.email, data, url.origin).catch(() => false);
    return json({ ok: true, sent: ok, mail: ok ? undefined : mailJob(o.email, data) });
  }

  // 前端代寄成功後回報，標記這筆已寄出
  if (m === "POST" && (mm = p.match(/^\/api\/results\/(\d+)\/emailed$/))) {
    await env.DB.prepare("UPDATE results SET emailed = 1 WHERE id = ? AND created_at > ?").bind(+mm[1], Date.now() - 36e5).run();
    return json({ ok: true });
  }

  // 顧客：送出測驗結果
  if (m === "POST" && p === "/api/results") {
    const b = await readJson(request);
    const customer = clip(b.customer, 30);
    if (!customer) return err(400, "缺少姓名");
    const store = SLUG_RE.test(String(b.store || "")) ? String(b.store).toLowerCase() : null;
    const owner = store ? await env.DB.prepare("SELECT * FROM owners WHERE slug = ?").bind(store).first() : null;
    const focus = Array.isArray(b.focus) ? b.focus.slice(0, 6).map(x => clip(x, 20)) : [];
    const recs = Array.isArray(b.recommendations) ? b.recommendations.slice(0, 3).map(r => ({
      name: clip(r.name, 80), url: /^https:\/\/www\.markettaiwan\.com\.tw\//.test(String(r.url || "")) ? clip(r.url, 300) : "", match: Number(r.match) || 0
    })) : [];
    const answers = b.answers && typeof b.answers === "object" ? b.answers : {};
    const ins = await env.DB.prepare(
      "INSERT INTO results (store, customer, focus, recommendations, answers, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(owner ? owner.slug : store, customer, JSON.stringify(focus), JSON.stringify(recs), JSON.stringify(answers).slice(0, 8000), Date.now()).run();
    const id = ins.meta?.last_row_id;
    let emailed = false, mailData = null;
    if (owner) {
      const data = mailData = { _subject: `【健康選品｜${owner.display_name || owner.slug}】${customer} 的測驗結果`, _template: "table", _captcha: "false",
        "店主": owner.display_name || owner.slug, "店舖": owner.slug, "顧客姓名": customer,
        "測驗時間": new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }),
        "保養重點": focus.join("、") };
      recs.forEach((r, i) => data[`推薦 ${i + 1}`] = `${r.name}（符合 ${r.match}%） ${r.url}`);
      for (const [k, v] of Object.entries(answers).slice(0, 15)) data["作答｜" + clip(k, 40)] = Array.isArray(v) ? v.map(x => clip(x, 40)).join("、") : clip(v, 80);
      emailed = await sendMail(owner.email, data, url.origin).catch(() => false);
      if (emailed && id) await env.DB.prepare("UPDATE results SET emailed = 1 WHERE id = ?").bind(id).run();
    }
    const synced = owner ? await syncToPlan(env, owner.slug, { id, customer, focus, recs, answers }).catch(() => false) : false;
    return json({ ok: true, id, emailed, synced, store: owner ? owner.slug : null,
      mail: owner && !emailed ? mailJob(owner.email, mailData) : undefined });
  }

  // 挑戰計劃網站（蘇打餅）讀取同步店舖的完整問卷紀錄，用收件鑰匙 INBOX_KEY；只讀，不能改
  if (m === "GET" && p === "/api/sync/results") {
    const key = request.headers.get("x-inbox-key") || "";
    if (!env.INBOX_KEY || !safeEqual(key, env.INBOX_KEY)) return err(401, "收件鑰匙不正確");
    const stores = String(env.SYNC_STORE || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    const store = String(url.searchParams.get("store") || stores[0] || "").toLowerCase();
    if (!stores.includes(store)) return err(403, "這個店舖沒有開放同步");
    const { results } = await env.DB.prepare(
      "SELECT id, customer, focus, recommendations, answers, created_at FROM results WHERE store = ? ORDER BY created_at DESC LIMIT 300"
    ).bind(store).all();
    const parse = (s, d) => { try { return JSON.parse(s || "") ?? d; } catch (e) { return d; } };
    return json({ ok: true, store, results: results.map(r => ({ id: `hq-${store}-${r.id}`, name: r.customer, at: r.created_at,
      focus: parse(r.focus, []), recs: parse(r.recommendations, []), answers: parse(r.answers, {}) })) });
  }

  // 店主：刪除自己的一筆顧客紀錄
  if (m === "DELETE" && (mm = p.match(/^\/api\/owners\/([^/]+)\/results\/(\d+)$/))) {
    const o = await authOwner(request, env, decodeURIComponent(mm[1]));
    if (!o) return err(401, "請重新登入");
    const r = await env.DB.prepare("DELETE FROM results WHERE id = ? AND store = ?").bind(+mm[2], o.slug).run();
    return json({ ok: true, deleted: r.meta?.changes || 0 });
  }

  // 挑戰計劃網站刪除一筆問卷（測試資料等），同樣用收件鑰匙 INBOX_KEY，只能刪同步店舖的
  if (m === "DELETE" && (mm = p.match(/^\/api\/sync\/results\/hq-([A-Za-z0-9_-]+)-(\d+)$/))) {
    const key = request.headers.get("x-inbox-key") || "";
    if (!env.INBOX_KEY || !safeEqual(key, env.INBOX_KEY)) return err(401, "收件鑰匙不正確");
    const stores = String(env.SYNC_STORE || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
    const store = mm[1].toLowerCase();
    if (!stores.includes(store)) return err(403, "這個店舖沒有開放同步");
    const r = await env.DB.prepare("DELETE FROM results WHERE id = ? AND store = ?").bind(+mm[2], store).run();
    return json({ ok: true, deleted: r.meta?.changes || 0 });
  }

  // 管理者（Roy）：看全部店主與紀錄，需要密鑰 ADMIN_KEY
  if (m === "GET" && p === "/api/admin/results") {
    if (!isAdmin(request, env)) return err(401, "管理密鑰不正確");
    const { results } = await env.DB.prepare(
      "SELECT id, store, customer, focus, recommendations, emailed, created_at FROM results ORDER BY created_at DESC LIMIT 1000").all();
    const owners = (await env.DB.prepare("SELECT slug, display_name, credit_user, email, line_id, created_at FROM owners ORDER BY created_at").all()).results;
    return json({ ok: true, owners, results });
  }

  // 管理者：刪除店主（?results=1 連同他的顧客紀錄一起刪）
  if (m === "DELETE" && (mm = p.match(/^\/api\/admin\/owners\/([^/]+)$/))) {
    if (!isAdmin(request, env)) return err(401, "管理密鑰不正確");
    const slug = decodeURIComponent(mm[1]);
    const r = await env.DB.prepare("DELETE FROM owners WHERE slug = ?").bind(slug).run();
    let removed = 0;
    if (url.searchParams.get("results") === "1") removed = (await env.DB.prepare("DELETE FROM results WHERE store = ?").bind(slug).run()).meta?.changes || 0;
    return json({ ok: true, deleted: r.meta?.changes || 0, results: removed });
  }
  // 管理者：刪除一筆顧客紀錄
  if (m === "DELETE" && (mm = p.match(/^\/api\/admin\/results\/(\d+)$/))) {
    if (!isAdmin(request, env)) return err(401, "管理密鑰不正確");
    const r = await env.DB.prepare("DELETE FROM results WHERE id = ?").bind(+mm[1]).run();
    return json({ ok: true, deleted: r.meta?.changes || 0 });
  }

  return err(404, "找不到這個 API");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url, ctx); }
      catch (e) {
        if (e && e.message === "too_large") return err(413, "資料太大");
        if (e instanceof SyntaxError) return err(400, "資料格式不正確");
        return err(500, "伺服器發生錯誤");
      }
    }
    const res = await env.ASSETS.fetch(request);
    const ct = res.headers.get("content-type") || "";
    if (/^text\/(html|css|plain)|javascript/.test(ct) && !/charset/i.test(ct)) {
      const r = new Response(res.body, res);
      r.headers.set("content-type", ct + "; charset=utf-8");
      return r;
    }
    return res;
  }
};
