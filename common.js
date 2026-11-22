/* =========================================================
   COMMON HELPERS shared by generate.html and outline.html

   - SERVER_URL: where our Node server lives
   - saved preferences (level, difficulty, approach) so you
     choose them once and every page remembers
   - postJson(): sends data to the server and gives back the answer
   - startWaitTimer(): shows a running "12s" counter while waiting
   ========================================================= */

// ---- WHERE IS THE SERVER? ----
// On your own computer the server is at 127.0.0.1:3000.
// Once the pages are online (GitHub Pages), they must talk to the ONLINE server.
// The online address now lives in config.js (paste your Render address there, once).
const APP_CONFIG = window.APP_CONFIG || {};
const ONLINE_SERVER_URL = String(APP_CONFIG.serverUrl || "").replace(/\/+$/, "");

const IS_LOCAL = ["127.0.0.1", "localhost", ""].includes(window.location.hostname);
const SERVER_URL = IS_LOCAL ? "http://127.0.0.1:3000" : ONLINE_SERVER_URL;
const ACCESS_CODE_KEY = "accessCode";
const PREFS_KEY = "lecturerPrefs";

// Used when nothing is saved yet. Revision mode is the default: quick key points for exam study.
// (Study mode (value "exam") = full detail in the material's exact wording; Explain = teaches freely.)
const DEFAULT_PREFS = { level: "University", difficulty: "Standard", approach: "revision" };

// The three approaches, shown as buttons instead of a drop-down so nobody forgets they exist
const APPROACHES = [
  { value: "revision", name: "Revision", note: "Quick: the main short definition and the key points only. Best for revising before an exam. Switch to Study mode for full detail." },
  { value: "exam", name: "Study mode", note: "Full class: every definition, type and feature taught once, in a natural way, with examples. Best for learning a topic properly." },
  { value: "explain", name: "Explain", note: "Teaches more freely with extra analogies and everyday examples, to help you really understand." }
];

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    // Choices saved before Revision mode existed: start again from the new default approach
    if (saved.approachV !== 2) delete saved.approach;
    return Object.assign({}, DEFAULT_PREFS, saved);
  } catch (error) {
    return Object.assign({}, DEFAULT_PREFS);   // storage blocked or broken: use defaults
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(Object.assign({}, prefs, { approachV: 2 })));
  } catch (error) {
    // not saving is fine, the page still works
  }
}

// Connects the three <select> boxes to the saved preferences.
// Returns a function that reads the current choices.
function bindPrefs(levelEl, difficultyEl, approachEl) {
  // the hidden <select> always holds the three approaches, whatever the page's HTML lists
  approachEl.innerHTML = "";
  APPROACHES.forEach(function (a) {
    const option = document.createElement("option");
    option.value = a.value;
    option.textContent = a.name;
    approachEl.append(option);
  });

  const prefs = loadPrefs();
  levelEl.value = prefs.level;
  difficultyEl.value = prefs.difficulty;
  approachEl.value = prefs.approach;

  function read() {
    return { level: levelEl.value, difficulty: difficultyEl.value, approach: approachEl.value };
  }
  [levelEl, difficultyEl, approachEl].forEach(function (el) {
    el.addEventListener("change", function () { savePrefs(read()); });
  });
  buildApproachPicker(approachEl);
  return read;
}

// Three visible buttons (one highlighted) that control the hidden approach <select>
function buildApproachPicker(selectEl) {
  selectEl.hidden = true;
  const picker = document.createElement("div");
  picker.className = "approach-picker";
  picker.setAttribute("role", "radiogroup");
  picker.setAttribute("aria-label", "Approach");
  const note = document.createElement("p");
  note.className = "approach-note";

  function refresh() {
    picker.querySelectorAll(".approach-btn").forEach(function (btn) {
      const on = btn.dataset.value === selectEl.value;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    const current = APPROACHES.find(function (a) { return a.value === selectEl.value; });
    note.textContent = current ? current.note : "";
  }

  APPROACHES.forEach(function (a) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "approach-btn";
    btn.dataset.value = a.value;
    btn.setAttribute("role", "radio");
    btn.textContent = a.name;
    btn.addEventListener("click", function () {
      selectEl.value = a.value;
      selectEl.dispatchEvent(new Event("change", { bubbles: true }));   // saves the choice
      refresh();
    });
    picker.append(btn);
  });

  selectEl.insertAdjacentElement("afterend", picker);
  picker.insertAdjacentElement("afterend", note);
  refresh();
}

/* =========================================================
   ACCOUNTS (log in / sign up / log out)
   The login service is Supabase. We talk to it with plain fetch(). The "session" (login pass + name)
   is kept in this browser. Guests have no session and everything still works for them.
   ========================================================= */
const SESSION_KEY = "lecturerSession";

function accountsReady() { return Boolean(APP_CONFIG.supabaseUrl && APP_CONFIG.supabaseKey); }
function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (error) { return null; }
}
function saveSession(session) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (error) { /* ignore */ } }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (error) { /* ignore */ } }

// The learner's first name (empty for guests): the lecturer uses it when he welcomes you
function getLearnerName() {
  const session = getSession();
  const name = session && session.user && session.user.name ? String(session.user.name).trim() : "";
  return name.split(/\s+/)[0] || "";
}

function friendlyAuthError(data) {
  const raw = String(data.error_description || data.msg || data.message || data.error || "");
  const m = raw.toLowerCase();
  if (m.includes("invalid login")) return "Wrong email or password.";
  if (m.includes("already registered") || m.includes("already been registered")) return "That email already has an account. Log in instead.";
  if (m.includes("password should") || m.includes("weak")) return "Use a longer password (at least 6 characters).";
  if (m.includes("rate limit")) return "Too many tries. Wait a few minutes and try again.";
  if (m.includes("not confirmed")) return "Please confirm your email first (check your inbox).";
  if (m.includes("valid email") || m.includes("invalid email")) return "That email address does not look right.";
  return raw || "Something went wrong. Try again.";
}

async function authCall(path, body, token) {
  const headers = { "Content-Type": "application/json", apikey: APP_CONFIG.supabaseKey };
  if (token) headers.Authorization = "Bearer " + token;
  let response;
  try {
    response = await fetch(APP_CONFIG.supabaseUrl + "/auth/v1/" + path, { method: "POST", headers: headers, body: JSON.stringify(body || {}) });
  } catch (error) {
    throw new Error("Cannot reach the login service. Check your internet.");
  }
  let data = {};
  try { data = await response.json(); } catch (error) { data = {}; }
  if (!response.ok) { const err = new Error(friendlyAuthError(data)); err.status = response.status; throw err; }
  return data;
}

function sessionFromResponse(data, fallbackName) {
  const user = data.user || {};
  const meta = user.user_metadata || {};
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    user: { id: user.id, email: user.email, name: meta.name || fallbackName || "" }
  };
}

async function authSignUp(name, email, password) {
  const data = await authCall("signup", { email: email, password: password, data: { name: name } });
  if (!data.access_token) return { needsConfirm: true };       // the project asks for email confirmation first
  const session = sessionFromResponse(data, name);
  saveSession(session);
  return { session: session };
}

async function authLogIn(email, password) {
  const data = await authCall("token?grant_type=password", { email: email, password: password });
  const session = sessionFromResponse(data);
  saveSession(session);
  return session;
}

async function authLogOut() {
  const session = getSession();
  clearSession();
  clearLocalGuestData();            // the next person on this browser starts clean
  if (session && session.access_token) { try { await authCall("logout", {}, session.access_token); } catch (error) { /* fine */ } }
}

// The login pass, renewed automatically when it is about to run out
async function getAccessToken() {
  const session = getSession();
  if (!session || !session.access_token) return "";
  if (session.expires_at - Date.now() > 60000) return session.access_token;
  try {
    const data = await authCall("token?grant_type=refresh_token", { refresh_token: session.refresh_token });
    const fresh = sessionFromResponse(data, session.user && session.user.name);
    if (!fresh.user.name && session.user) fresh.user.name = session.user.name;
    saveSession(fresh);
    return fresh.access_token;
  } catch (error) {
    if (error.status === 400 || error.status === 401) clearSession();   // the login ended: back to guest
    return session.access_token;
  }
}

// The little bar at the top of a page: "Signed in as Jay [Log out]" or the guest note
function renderAccountBar(container) {
  if (!container || !accountsReady()) return;
  container.replaceChildren();
  const session = getSession();
  const text = document.createElement("span");
  if (session && session.user) {
    text.textContent = "Signed in as " + (session.user.name || session.user.email) + ". Your PDFs and progress are saved to your account.";
    const out = document.createElement("button");
    out.type = "button"; out.className = "account-link"; out.textContent = "Log out";
    out.addEventListener("click", async function () { await authLogOut(); window.location.reload(); });
    container.append(text, out);
  } else {
    text.textContent = "Guest mode: your PDFs and progress stay only in this browser.";
    const link = document.createElement("a");
    link.className = "account-link"; link.href = "login.html"; link.textContent = "Log in or create an account";
    container.append(text, link);
  }
  container.hidden = false;
}

// Forget the documents and progress markers kept in THIS browser (the guest list)
function clearLocalGuestData() {
  try {
    getMyDocIds().forEach(function (id) { localStorage.removeItem(doneKey(id)); });
    localStorage.removeItem(MY_DOCS_KEY);
  } catch (error) { /* ignore */ }
}

// A guest just logged in: move the documents and progress this browser had into the account.
// Afterwards the browser forgets them, so they belong to THIS account only.
async function claimGuestData() {
  const ids = getMyDocIds();
  if (ids.length === 0) return;
  const done = {};
  ids.forEach(function (id) { done[id] = getDone(id); });
  try {
    await postJson("/api/mydocs/claim", { ids: ids, done: done });
    clearLocalGuestData();
  } catch (error) { /* they stay in this browser, and are tried again at the next login */ }
}

// fetch() for our server. It adds the access code, and if the server asks for the
// code (or the saved one is wrong) it asks the learner to type it once, then tries again.
async function apiFetch(path, options) {
  options = options || {};
  for (let attempt = 0; attempt < 2; attempt++) {
    let code = "";
    try { code = localStorage.getItem(ACCESS_CODE_KEY) || ""; } catch (error) { code = ""; }

    const token = await getAccessToken();
    const headers = Object.assign({}, options.headers, code ? { "x-access-code": code } : {}, token ? { Authorization: "Bearer " + token } : {});
    const response = await fetch(SERVER_URL + path, Object.assign({}, options, { headers: headers }));

    if (response.status !== 401) return response;

    // 401 = the server wants an access code
    const typed = window.prompt("Enter the access code to use this site:");
    if (!typed) return response;                       // cancelled: give back the 401
    try { localStorage.setItem(ACCESS_CODE_KEY, typed.trim()); } catch (error) { /* ignore */ }
  }
  return fetch(SERVER_URL + path, options);
}

// When the pages are online the free server sleeps. Knocking on it as soon as a page
// opens starts waking it up, so it is ready sooner when you press a button.
if (!IS_LOCAL) {
  fetch(SERVER_URL + "/api/health").catch(function () { /* ignore */ });
}

// Sends JSON to our server. If the server says something went wrong,
// this throws an Error with the friendly message the server wrote.
async function postJson(path, body) {
  let response;
  try {
    response = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    // fetch itself failed: the server is not running or not reachable
    throw new Error(IS_LOCAL
      ? "Cannot reach the server. Is it running? (npm start in the server folder)"
      : "Cannot reach the server. It may be waking up. Wait one minute and try again.");
  }

  let data = {};
  try {
    data = await response.json();
  } catch (error) {
    data = {};
  }
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong (" + response.status + ").");
  }
  return data;
}

// Shows "label... 12s" and counts up every second. Returns a function that stops it.
function startWaitTimer(show, label) {
  let seconds = 0;
  show(label + "... 0s");
  const timer = setInterval(function () {
    seconds++;
    if (seconds < 40) {
      show(label + "... " + seconds + "s");
    } else {
      show(label + "... " + seconds + "s. Google is slow right now and the server is retrying. Please keep this page open.");
    }
  }, 1000);
  return function stop() { clearInterval(timer); };
}


/* =========================================================
   MY DOCUMENTS and DONE MARKERS (kept in THIS browser only)
   - myDocs: the documents this browser uploaded. The home page lists only these,
     so a friend using the same server never sees your material.
   - done markers: which topics you have already generated a lesson for,
     so the contents page can show them dimmed.
   ========================================================= */
const MY_DOCS_KEY = "myDocs";

function getMyDocIds() {
  try { return JSON.parse(localStorage.getItem(MY_DOCS_KEY) || "[]"); } catch (error) { return []; }
}

function rememberDoc(docId) {
  // Logged in: the account keeps the list on the server, so this browser must not keep one
  // (otherwise the next person to log in here would get these documents too).
  if (getSession()) return;
  try {
    const ids = getMyDocIds().filter(function (id) { return id !== docId; });
    ids.unshift(docId);                                    // newest first
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify(ids.slice(0, 50)));
  } catch (error) { /* not saving is fine */ }
}

function doneKey(docId) { return "lecturerDone:" + docId; }

function getDone(docId) {
  try { return JSON.parse(localStorage.getItem(doneKey(docId)) || "[]"); } catch (error) { return []; }
}

function markDone(docId, sectionId) {
  try {
    const done = getDone(docId);
    if (!done.includes(sectionId)) {
      done.push(sectionId);
      localStorage.setItem(doneKey(docId), JSON.stringify(done));
    }
  } catch (error) { /* not saving is fine */ }
  // Logged in: also save it to the account, so it follows you to any phone or computer
  if (getSession()) {
    apiFetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ docId: docId, sectionIds: [sectionId] })
    }).catch(function () { /* the local copy is still there */ });
  }
}

// The done list to show: from the account when logged in, from this browser for guests
async function getDoneAsync(docId) {
  const local = getDone(docId);
  if (!getSession()) return local;
  try {
    const response = await apiFetch("/api/progress/" + encodeURIComponent(docId));
    if (!response.ok) return local;
    return (await response.json()).done || [];
  } catch (error) { return local; }
}

// The X button: take a document out of MY list (the shared copy stays for other people)
async function removeMyDoc(docId) {
  try {
    const ids = getMyDocIds().filter(function (id) { return id !== docId; });
    localStorage.setItem(MY_DOCS_KEY, JSON.stringify(ids));
    localStorage.removeItem(doneKey(docId));
  } catch (error) { /* ignore */ }
  if (getSession()) {
    const response = await apiFetch("/api/mydocs/" + encodeURIComponent(docId), { method: "DELETE" });
    if (!response.ok) throw new Error("Could not remove it. Try again.");
  }
}

/* =========================================================
   ASKING FOR ONE TOPIC'S LESSON
   entry    = { sectionId, part, title }
   position = "only" | "first" | "middle" | "last"  (a unit is several topic lessons in a row)
   prefs    = { level, difficulty, approach }
   ========================================================= */
async function fetchTopicLesson(docId, entry, position, prefs) {
  const lesson = await postJson("/api/lesson", {
    docId: docId,
    sectionId: entry.sectionId,
    scope: "own",
    part: entry.part,
    position: position,
    level: prefs.level,
    difficulty: prefs.difficulty,
    approach: prefs.approach
  });
  markDone(docId, entry.sectionId);
  return lesson;
}
