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
// After you deploy the server on Render, paste its address below (no slash at the end).
const ONLINE_SERVER_URL = "https://ai-lecturer-b0qs.onrender.com";

const IS_LOCAL = ["127.0.0.1", "localhost", ""].includes(window.location.hostname);
const SERVER_URL = IS_LOCAL ? "http://127.0.0.1:3000" : ONLINE_SERVER_URL;
const ACCESS_CODE_KEY = "accessCode";
const PREFS_KEY = "lecturerPrefs";

// Used when nothing is saved yet. Exam mode is the default because
// NOUN exams reward the exact wording of the course material.
const DEFAULT_PREFS = { level: "University", difficulty: "Standard", approach: "exam" };

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return Object.assign({}, DEFAULT_PREFS, saved);
  } catch (error) {
    return Object.assign({}, DEFAULT_PREFS);   // storage blocked or broken: use defaults
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (error) {
    // not saving is fine, the page still works
  }
}

// Connects the three <select> boxes to the saved preferences.
// Returns a function that reads the current choices.
function bindPrefs(levelEl, difficultyEl, approachEl) {
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
  return read;
}

// fetch() for our server. It adds the access code, and if the server asks for the
// code (or the saved one is wrong) it asks the learner to type it once, then tries again.
async function apiFetch(path, options) {
  options = options || {};
  for (let attempt = 0; attempt < 2; attempt++) {
    let code = "";
    try { code = localStorage.getItem(ACCESS_CODE_KEY) || ""; } catch (error) { code = ""; }

    const headers = Object.assign({}, options.headers, code ? { "x-access-code": code } : {});
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
