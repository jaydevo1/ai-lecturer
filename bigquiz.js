/* =========================================================
   BIG QUIZ  (bigquiz.js)
   A quiz over a whole topic list (a module, a unit or the whole course).
   - The questions are asked for in batches of 10 (one request each), each batch from its OWN
     share of the topics, so the whole scope is covered and nothing repeats.
   - The first batch opens the quiz at once; the rest are fetched in the background while you answer.
   - Marking happens here in the browser (free and instant).
   common.js provides: postJson, startWaitTimer
   ========================================================= */

const BATCH = 10;

const quizTitleEl = document.getElementById("quizTitle");
const setupEl = document.getElementById("setup");
const playEl = document.getElementById("play");
const resultEl = document.getElementById("result");
const setupInfoEl = document.getElementById("setupInfo");
const costNoteEl = document.getElementById("costNote");
const sizeSelectEl = document.getElementById("sizeSelect");
const startBtn = document.getElementById("startBtn");
const bqCountEl = document.getElementById("bqCount");
const bqFillEl = document.getElementById("bqFill");
const bqQuestionEl = document.getElementById("bqQuestion");
const bqOptionsEl = document.getElementById("bqOptions");
const bqFeedbackEl = document.getElementById("bqFeedback");
const bqActionsEl = document.getElementById("bqActions");
const bqNoteEl = document.getElementById("bqNote");

let setup = null;
try { setup = JSON.parse(sessionStorage.getItem("bigQuiz") || "null"); } catch (e) { setup = null; }

let questions = [];       // every question loaded so far
let wanted = 0;           // how many the learner asked for
let batchesDone = 0;
let batchesTotal = 0;
let loading = false;      // a background batch is on its way
let loadError = "";       // set when a batch failed
let waitingForMore = false;
let index = 0;
let score = 0;
let missed = [];
let perTopic = {};        // topic -> { right, total }
let runId = 0;            // a new quiz makes old background requests harmless


function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el("button", cls, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}
function show(which) {
  setupEl.hidden = which !== "setup";
  playEl.hidden = which !== "play";
  resultEl.hidden = which !== "result";
}


/* ---------- setup ---------- */
if (!setup || !setup.docId || !setup.topics || !setup.topics.length) {
  quizTitleEl.textContent = "No quiz chosen";
  setupInfoEl.textContent = "Go back to the contents and tap Quiz on a module, a unit, or the whole course.";
  startBtn.hidden = true;
  sizeSelectEl.parentElement.hidden = true;
} else {
  quizTitleEl.textContent = setup.title;
  document.getElementById("backLink").href = "outline.html?doc=" + encodeURIComponent(setup.docId);
  const names = [];
  setup.topics.forEach(function (t) { if (names.indexOf(t.title) === -1) names.push(t.title); });
  setupInfoEl.textContent = "This quiz covers " + names.length + " topic" + (names.length === 1 ? "" : "s") + ".";
  function updateCost() {
    const n = Number(sizeSelectEl.value);
    const calls = Math.ceil(n / BATCH);
    costNoteEl.textContent = calls + " request" + (calls === 1 ? "" : "s") + " to the AI. The first questions appear quickly; the rest load while you answer.";
  }
  sizeSelectEl.addEventListener("change", updateCost);
  updateCost();
  startBtn.addEventListener("click", function () { startQuiz(Number(sizeSelectEl.value)); });
}


/* ---------- getting the questions ---------- */
// Which topics does batch number b use? Each batch gets its own slice, in order.
function topicsForBatch(b) {
  const T = setup.topics.length;
  const from = Math.floor((b * T) / batchesTotal);
  const to = Math.floor(((b + 1) * T) / batchesTotal);
  const slice = setup.topics.slice(from, Math.max(to, from + 1));
  if (slice.length) return slice;
  return [setup.topics[b % T]];
}

async function fetchBatch(b, run) {
  const count = Math.min(BATCH, wanted - b * BATCH);
  const refs = topicsForBatch(b);
  const prefs = setup.prefs || {};
  const data = await postJson("/api/quiz", {
    lessonTitle: setup.title,
    docId: setup.docId,
    sections: refs.map(function (r) { return { sectionId: r.sectionId, part: r.part }; }),
    count: count,
    round: Math.floor((b * 1) / Math.max(1, setup.topics.length)),   // same topics again later -> different questions
    avoid: questions.slice(-50).map(function (q) { return q.question; }),
    level: prefs.level, difficulty: prefs.difficulty, approach: prefs.approach,
    wholeUnit: false
  });
  if (run !== runId) return [];
  return data.questions.slice(0, count);
}

// Fetches the remaining batches one after another while the learner answers
async function loadRest(run) {
  while (batchesDone < batchesTotal && run === runId) {
    loading = true;
    loadError = "";
    try {
      const got = await fetchBatch(batchesDone, run);
      if (run !== runId) return;
      got.forEach(function (q) { questions.push(q); });
      batchesDone++;
    } catch (error) {
      console.error(error);
      loadError = error.message || "Could not load more questions.";
      loading = false;
      if (waitingForMore) showQuestion();
      return;
    }
    loading = false;
    updateCounter();
    if (waitingForMore) { waitingForMore = false; showQuestion(); }
  }
}

async function startQuiz(size) {
  runId++;
  const run = runId;
  wanted = size;
  batchesTotal = Math.ceil(size / BATCH);
  batchesDone = 0;
  questions = []; index = 0; score = 0; missed = []; perTopic = {};
  loadError = ""; waitingForMore = false;
  startBtn.disabled = true;
  bqNoteEl.textContent = "";

  const stopTimer = startWaitTimer(function (m) { bqNoteEl.textContent = m; }, "Writing your questions");
  try {
    const first = await fetchBatch(0, run);
    questions = first;
    batchesDone = 1;
    show("play");
    bqNoteEl.textContent = "";
    showQuestion();
    loadRest(run);
  } catch (error) {
    console.error(error);
    bqNoteEl.textContent = error.message;
  } finally {
    stopTimer();
    startBtn.disabled = false;
  }
}


/* ---------- one question ---------- */
function updateCounter() {
  const total = Math.max(wanted, questions.length);
  bqCountEl.textContent = "Question " + Math.min(index + 1, total) + " of " + total;
  bqFillEl.style.width = (index / total) * 100 + "%";
}

function showQuestion() {
  if (index >= questions.length) {
    if (batchesDone >= batchesTotal || (loadError && !loading)) {
      if (loadError && questions.length < wanted) return offerPartial();
      return showResults();
    }
    // more questions are still on their way
    waitingForMore = true;
    bqQuestionEl.textContent = "Loading more questions...";
    bqOptionsEl.replaceChildren();
    bqFeedbackEl.hidden = true;
    bqActionsEl.replaceChildren();
    return;
  }
  const q = questions[index];
  updateCounter();
  bqQuestionEl.textContent = q.question;
  bqOptionsEl.replaceChildren();
  bqFeedbackEl.hidden = true;
  bqActionsEl.replaceChildren(btn("Stop and see score", "btn secondary", showResults));
  q.options.forEach(function (text, i) {
    const b = el("button", "bq-option", text);
    b.type = "button";
    b.addEventListener("click", function () { answer(i); });
    bqOptionsEl.append(b);
  });
}

function offerPartial() {
  bqQuestionEl.textContent = "Could not load the rest of the questions.";
  bqOptionsEl.replaceChildren();
  bqFeedbackEl.hidden = false;
  bqFeedbackEl.className = "bq-feedback is-wrong";
  bqFeedbackEl.textContent = loadError + " You answered " + questions.length + " so far.";
  bqActionsEl.replaceChildren(
    btn("Try loading again", "btn", function () { loadError = ""; waitingForMore = true; loadRest(runId); showQuestion(); }),
    btn("See my score", "btn secondary", showResults)
  );
}

function answer(chosen) {
  const q = questions[index];
  const right = chosen === q.correctIndex;
  bqOptionsEl.querySelectorAll(".bq-option").forEach(function (b, i) {
    b.disabled = true;
    if (i === q.correctIndex) b.classList.add("is-correct");
    if (i === chosen && !right) b.classList.add("is-wrong");
  });
  const t = q.topic || "General";
  perTopic[t] = perTopic[t] || { right: 0, total: 0 };
  perTopic[t].total++;
  if (right) { score++; perTopic[t].right++; } else missed.push(q);

  bqFeedbackEl.hidden = false;
  bqFeedbackEl.className = "bq-feedback " + (right ? "is-correct" : "is-wrong");
  bqFeedbackEl.textContent = (right ? "Correct! " : "Not quite. The answer is: " + q.options[q.correctIndex] + ". ") + q.explanation;

  index++;
  bqFillEl.style.width = (index / Math.max(wanted, questions.length)) * 100 + "%";
  bqActionsEl.replaceChildren(
    btn(index >= wanted ? "See my score" : "Next question", "btn", showQuestion),
    btn("Stop and see score", "btn secondary", showResults)
  );
}


/* ---------- result ---------- */
function showResults() {
  show("result");
  const answered = index;       // questions the learner actually answered
  const total = Math.max(1, answered);
  const percent = Math.round((score / total) * 100);
  document.getElementById("resultScore").textContent = score + " out of " + answered + " (" + percent + "%)";
  document.getElementById("resultMessage").textContent =
    percent >= 90 ? "Excellent. You know this material well."
    : percent >= 70 ? "Well done. Revise the weak topics below."
    : percent >= 50 ? "A fair start. Go back over the weak topics, then try again."
    : "Keep going. Study the weak topics below, then retake the quiz.";

  const box = document.getElementById("topicBreakdown");
  box.replaceChildren();
  Object.keys(perTopic)
    .sort(function (a, b) { return perTopic[a].right / perTopic[a].total - perTopic[b].right / perTopic[b].total; })
    .forEach(function (name) {
      const t = perTopic[name];
      const p = Math.round((t.right / t.total) * 100);
      const row = el("div", "bq-row" + (p < 60 ? " is-weak" : ""));
      row.append(el("span", "name", name), el("span", "pct", t.right + "/" + t.total + " · " + p + "%"));
      box.append(row);
    });

  const list = document.getElementById("missedList");
  list.replaceChildren();
  document.getElementById("missedHead").hidden = missed.length === 0;
  missed.forEach(function (q) {
    const m = el("div", "bq-missed");
    m.append(el("p", "", q.question), el("p", "bq-right", "Right answer: " + q.options[q.correctIndex]), el("p", "", q.explanation));
    list.append(m);
  });

  const actions = document.getElementById("resultActions");
  actions.replaceChildren();
  if (missed.length) actions.append(btn("Retry only the ones I missed", "btn", function () { retryMissed(); }));
  actions.append(btn("New quiz", "btn secondary", function () { runId++; show("setup"); }));
  const back = el("a", "btn secondary", "Back to contents");
  back.href = "outline.html?doc=" + encodeURIComponent(setup.docId);
  actions.append(back);
}

// Free: just goes through the missed questions again (no new request)
function retryMissed() {
  runId++;                               // stops any background loading
  questions = missed.slice();
  wanted = questions.length;
  batchesDone = batchesTotal = 1;
  loadError = ""; waitingForMore = false;
  index = 0; score = 0; missed = []; perTopic = {};
  show("play");
  showQuestion();
}
