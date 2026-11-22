/* =========================================================
   STORE (store.js): where the server keeps things.

   Two places are possible, and the rest of the server does not care which one is used:

   1. SUPABASE (online, free database + file storage + logins).
      Used when SUPABASE_URL and SUPABASE_SECRET_KEY are set (in server/.env, and on Render).
      Everything saved here survives the free server going to sleep.

   2. DISK (the server/docs and server/cache folders).
      Used when those two settings are missing, so your own computer still works with no setup.
      Accounts do not exist in this mode: everybody is a guest.

   What is kept:
     docs        every uploaded document: its text and contents (once per file, shared by everybody)
     pdfs        the original PDF (for reading equations, tables and figures from the pages)
     cache       finished lessons, answers and quizzes (so the same request never asks Gemini twice)
     user_docs   which documents belong to which account (the X button removes only this link)
     progress    which topics an account has already generated
   ========================================================= */

const fs = require("fs");
const path = require("path");

module.exports = function createStore(options) {
  const CACHE_DIR = options.cacheDir;
  const DOCS_DIR = options.docsDir;
  const SUPABASE_URL = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();
  const PUBLISHABLE_KEY = String(process.env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const online = Boolean(SUPABASE_URL && SECRET_KEY);

  const ID_RE = /^[a-f0-9]{12}$/;

  /* ---------- a small memory in front of the database (it is slow to fetch a big document every time) ---------- */
  function makeMemory(max, ttlMs) {
    const map = new Map();
    return {
      get: function (key) {
        const hit = map.get(key);
        if (!hit) return null;
        if (hit.expires < Date.now()) { map.delete(key); return null; }
        return hit.value;
      },
      set: function (key, value) {
        if (map.size >= max) map.delete(map.keys().next().value);
        map.set(key, { value: value, expires: Date.now() + ttlMs });
      },
      del: function (key) { map.delete(key); }
    };
  }
  const docMemory = makeMemory(6, 10 * 60 * 1000);
  const pdfMemory = makeMemory(2, 10 * 60 * 1000);
  const userMemory = makeMemory(200, 5 * 60 * 1000);

  /* =========================================================
     DISK
     ========================================================= */
  const disk = {
    cacheGet: async function (key) {
      try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + ".json"), "utf8")); } catch (e) { return null; }
    },
    cacheSet: async function (key, value) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CACHE_DIR, key + ".json"), JSON.stringify(value));
    },
    docGet: async function (id) {
      if (!ID_RE.test(String(id))) return null;
      try { return JSON.parse(fs.readFileSync(path.join(DOCS_DIR, id + ".json"), "utf8")); } catch (e) { return null; }
    },
    docSet: async function (doc) {
      fs.mkdirSync(DOCS_DIR, { recursive: true });
      fs.writeFileSync(path.join(DOCS_DIR, doc.id + ".json"), JSON.stringify(doc));
    },
    docFindByHash: async function (hash) {
      let files = [];
      try { files = fs.readdirSync(DOCS_DIR).filter(function (f) { return ID_RE.test(f.replace(".json", "")) && f.endsWith(".json"); }); } catch (e) { return null; }
      for (const f of files) {
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), "utf8"));
          if (doc.hash === hash) return doc;
        } catch (e) { /* skip a broken file */ }
      }
      return null;
    },
    pdfPut: async function (id, buffer) {
      fs.mkdirSync(DOCS_DIR, { recursive: true });
      fs.writeFileSync(path.join(DOCS_DIR, id + ".pdf"), buffer);
    },
    pdfGet: async function (id) {
      if (!ID_RE.test(String(id))) return null;
      try { return fs.readFileSync(path.join(DOCS_DIR, id + ".pdf")); } catch (e) { return null; }
    },
    // Everything ever uploaded (only used on your own computer, where there are no accounts)
    listAll: async function () {
      let files = [];
      try { files = fs.readdirSync(DOCS_DIR).filter(function (f) { return /^[a-f0-9]{12}\.json$/.test(f); }); } catch (e) { return []; }
      const list = [];
      for (const f of files) {
        const doc = await disk.docGet(f.replace(".json", ""));
        if (!doc) continue;
        let when = 0;
        try { when = fs.statSync(path.join(DOCS_DIR, f)).mtimeMs; } catch (e) { when = 0; }
        list.push({ docId: doc.id, name: doc.name, courseTitle: doc.courseTitle, pages: doc.pages, when: when });
      }
      return list.sort(function (a, b) { return b.when - a.when; });
    }
  };

  /* =========================================================
     SUPABASE
     ========================================================= */
  function authHeaders(key) {
    // New-style keys (sb_secret_...) go in "apikey" only. Old-style keys are long tokens and also go in Authorization.
    return /^sb_/.test(key) ? { apikey: key } : { apikey: key, Authorization: "Bearer " + key };
  }

  async function rest(method, table, query, body, prefer) {
    const headers = Object.assign({ "Content-Type": "application/json" }, authHeaders(SECRET_KEY));
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(SUPABASE_URL + "/rest/v1/" + table + (query ? "?" + query : ""), {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error("Supabase " + method + " " + table + " failed: HTTP " + response.status + " " + text.slice(0, 300));
      error.isStore = true;               // so the server can say "database problem", not "Google is busy"
      error.storeStatus = response.status;
      error.storeText = text;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  function eq(value) { return "eq." + encodeURIComponent(String(value)); }

  const supa = {
    cacheGet: async function (key) {
      const rows = await rest("GET", "cache", "key=" + eq(key) + "&select=value&limit=1");
      return rows && rows[0] ? rows[0].value : null;
    },
    cacheSet: async function (key, value) {
      await rest("POST", "cache", "on_conflict=key", { key: key, value: value }, "resolution=merge-duplicates,return=minimal");
    },
    docGet: async function (id) {
      if (!ID_RE.test(String(id))) return null;
      const memory = docMemory.get(id);
      if (memory) return memory;
      const rows = await rest("GET", "docs", "id=" + eq(id) + "&select=data&limit=1");
      const doc = rows && rows[0] ? rows[0].data : null;
      if (doc) docMemory.set(id, doc);
      return doc;
    },
    docSet: async function (doc) {
      await rest("POST", "docs", "on_conflict=id",
        { id: doc.id, hash: doc.hash || null, name: doc.name, course_title: doc.courseTitle || null, pages: doc.pages || null, data: doc },
        "resolution=merge-duplicates,return=minimal");
      docMemory.set(doc.id, doc);
    },
    docFindByHash: async function (hash) {
      const rows = await rest("GET", "docs", "hash=" + eq(hash) + "&select=id&limit=1");
      return rows && rows[0] ? await supa.docGet(rows[0].id) : null;
    },
    pdfPut: async function (id, buffer) {
      const response = await fetch(SUPABASE_URL + "/storage/v1/object/pdfs/" + id + ".pdf", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/pdf", "x-upsert": "true" }, authHeaders(SECRET_KEY)),
        body: buffer,
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) {
        const error = new Error("Supabase storage upload failed: HTTP " + response.status + " " + (await response.text()).slice(0, 200));
        error.isStore = true;
        error.storeStatus = response.status;
        throw error;
      }
      pdfMemory.set(id, buffer);
    },
    pdfGet: async function (id) {
      if (!ID_RE.test(String(id))) return null;
      const memory = pdfMemory.get(id);
      if (memory) return memory;
      const response = await fetch(SUPABASE_URL + "/storage/v1/object/pdfs/" + id + ".pdf", {
        headers: authHeaders(SECRET_KEY),
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) return null;                      // no saved PDF: page reading just stays off
      const buffer = Buffer.from(await response.arrayBuffer());
      pdfMemory.set(id, buffer);
      return buffer;
    }
  };

  /* ---------- accounts: documents and progress belonging to a person ---------- */
  const accounts = {
    // Who is this login pass (token)? Asks Supabase, and remembers the answer for 5 minutes.
    verify: async function (token) {
      if (!online || !token) return null;
      const known = userMemory.get(token);
      if (known) return known;
      let response;
      try {
        response = await fetch(SUPABASE_URL + "/auth/v1/user", {
          headers: { apikey: PUBLISHABLE_KEY || SECRET_KEY, Authorization: "Bearer " + token },
          signal: AbortSignal.timeout(15000)
        });
      } catch (e) { return null; }
      if (!response.ok) return null;
      const u = await response.json();
      if (!u || !u.id) return null;
      const user = { id: u.id, email: u.email || "", name: String((u.user_metadata && (u.user_metadata.name || u.user_metadata.full_name)) || "").slice(0, 60) };
      userMemory.set(token, user);
      return user;
    },
    link: async function (userId, docId) {
      await rest("POST", "user_docs", "on_conflict=user_id,doc_id",
        { user_id: userId, doc_id: docId, last_opened: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
    },
    unlink: async function (userId, docId) {
      await rest("DELETE", "user_docs", "user_id=" + eq(userId) + "&doc_id=" + eq(docId));
      await rest("DELETE", "progress", "user_id=" + eq(userId) + "&doc_id=" + eq(docId));
    },
    list: async function (userId) {
      const rows = await rest("GET", "user_docs",
        "user_id=" + eq(userId) + "&select=doc_id,last_opened,docs(name,course_title,pages)&order=last_opened.desc&limit=100");
      return (rows || []).filter(function (r) { return r.docs; }).map(function (r) {
        return { docId: r.doc_id, name: r.docs.name, courseTitle: r.docs.course_title, pages: r.docs.pages, when: Date.parse(r.last_opened) || 0 };
      });
    },
    owns: async function (userId, docId) {
      const rows = await rest("GET", "user_docs", "user_id=" + eq(userId) + "&doc_id=" + eq(docId) + "&select=doc_id&limit=1");
      return Boolean(rows && rows[0]);
    },
    progressList: async function (userId, docId) {
      const rows = await rest("GET", "progress", "user_id=" + eq(userId) + "&doc_id=" + eq(docId) + "&select=section_id&limit=2000");
      return (rows || []).map(function (r) { return r.section_id; });
    },
    progressMark: async function (userId, docId, sectionIds) {
      const rows = sectionIds.map(function (s) { return { user_id: userId, doc_id: docId, section_id: String(s).slice(0, 80) }; });
      if (rows.length === 0) return;
      await rest("POST", "progress", "on_conflict=user_id,doc_id,section_id", rows, "resolution=merge-duplicates,return=minimal");
    }
  };

  // Make sure the private "pdfs" folder exists in Supabase storage (harmless if it already does)
  async function ensureBucket() {
    if (!online) return;
    try {
      await fetch(SUPABASE_URL + "/storage/v1/bucket", {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, authHeaders(SECRET_KEY)),
        body: JSON.stringify({ id: "pdfs", name: "pdfs", public: false }),
        signal: AbortSignal.timeout(15000)
      });
    } catch (e) { /* fine */ }
  }

  const backend = online ? supa : disk;
  return {
    online: online,
    cacheGet: backend.cacheGet,
    cacheSet: backend.cacheSet,
    docGet: backend.docGet,
    docSet: backend.docSet,
    docFindByHash: backend.docFindByHash,
    pdfPut: backend.pdfPut,
    pdfGet: backend.pdfGet,
    listAll: disk.listAll,
    accounts: accounts,
    ensureBucket: ensureBucket
  };
};
