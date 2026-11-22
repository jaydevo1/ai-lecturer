/* =========================================================
   CONTENTS PAGE  (outline.js)

   1. Find out which document to show (from the address ?doc=...).
   2. Ask the server for its contents: GET /api/doc/<id>.
   3. Draw it as: Module (collapsed) > Unit (one open at a time) > main topics.
   4. "Teach this" teaches ONE topic (a very long topic is split into parts that follow each other).
      The FIRST topic of a unit starts with the unit's introduction and goals; the LAST topic of a unit
      ends with the unit's conclusion and summary. Topics in between just start teaching.
      We ask the server for the first lesson, save it, and open the classroom.
   common.js provides: apiFetch, postJson, startWaitTimer, bindPrefs,
                       fetchTopicLesson, getDone, rememberDoc
   ========================================================= */

const docTitleEl = document.getElementById("docTitle");
const docMetaEl = document.getElementById("docMeta");
const outlineNoteEl = document.getElementById("outlineNote");
const treeEl = document.getElementById("tree");
const busyBarEl = document.getElementById("busyBar");
const busyTextEl = document.getElementById("busyText");

const getPrefs = bindPrefs(
  document.getElementById("levelSelect"),
  document.getElementById("difficultySelect"),
  document.getElementById("approachSelect")
);

// Which document? The address wins, then the last one we remember.
const params = new URLSearchParams(window.location.search);
let docId = params.get("doc");
if (!docId) {
  try { docId = localStorage.getItem("lastDocId"); } catch (error) { docId = null; }
}

let isBusy = false;
let courseName = "";
let doneIds = [];     // topics you already made a lesson for (kept in this browser)


/* ---------- small helpers ---------- */
function makeEl(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function showBusy(message, isError) {
  busyBarEl.hidden = false;
  busyBarEl.classList.toggle("is-error", Boolean(isError));
  busyTextEl.textContent = message;
}

function setAllButtonsDisabled(disabled) {
  document.querySelectorAll(".btn").forEach(function (button) { button.disabled = disabled; });
}

// A node is a "topic" when it has no children (it is taught by itself)
function isLeaf(node) {
  return node.children.length === 0;
}

// A "unit" is a node whose children are all topics
function isUnit(node) {
  return node.children.length > 0 && node.children.every(isLeaf);
}

// The lessons ONE topic needs, in order. A long topic is split into parts, each part is one entry.
// "siblings" = all the topics of the same unit. It decides how the lesson opens and closes:
//   first topic of the unit -> introduction + goals first;  last topic -> conclusion + recap at the end.
function entriesForTopic(node, siblings) {
  const index = siblings.indexOf(node);
  const isFirstTopic = index <= 0;
  const isLastTopic = index === siblings.length - 1;
  const entries = [];
  for (let part = 0; part < node.parts; part++) {
    const intro = isFirstTopic && part === 0;
    const recap = isLastTopic && part === node.parts - 1;
    entries.push({
      sectionId: node.id,
      part: part,
      position: intro && recap ? "only" : intro ? "first" : recap ? "last" : "middle",
      title: node.title + (node.parts > 1 ? " (part " + (part + 1) + " of " + node.parts + ")" : "")
    });
  }
  return entries;
}

function makeButton(label, className, onClick) {
  const button = makeEl("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}


/* ---------- big quizzes: every topic (and part) under a node ---------- */
function leafRefs(node) {
  if (isLeaf(node)) {
    const refs = [];
    for (let part = 0; part < node.parts; part++) refs.push({ sectionId: node.id, part: part, title: node.title });
    return refs;
  }
  let all = [];
  node.children.forEach(function (child) { all = all.concat(leafRefs(child)); });
  return all;
}

function openBigQuiz(title, nodes) {
  let topics = [];
  nodes.forEach(function (n) { topics = topics.concat(leafRefs(n)); });
  if (topics.length === 0) return;
  try {
    sessionStorage.setItem("bigQuiz", JSON.stringify({ docId: docId, title: title, topics: topics, prefs: getPrefs() }));
  } catch (error) { /* fine */ }
  window.location.href = "bigquiz.html";
}

// A small Quiz button inside a module/unit heading (does not open or close the card)
function quizButtonFor(title, nodes) {
  const button = makeEl("button", "btn secondary mini", "Quiz");
  button.type = "button";
  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    openBigQuiz(title, nodes);
  });
  return button;
}


/* ---------- drawing the tree ---------- */
function renderTopic(node, siblings) {
  const done = doneIds.includes(node.id);
  const row = makeEl("div", "leaf" + (done ? " is-done" : ""));
  row.append(makeEl("span", "leaf-title", node.title));
  if (done) row.append(makeEl("span", "done-tag", "✓ Generated"));
  row.append(makeButton(done ? "Teach again" : "Teach this", done ? "btn secondary" : "btn", function () {
    teach(entriesForTopic(node, siblings), node.title);
  }));
  return row;
}

function renderUnit(node) {
  const details = makeEl("details", "unit-card");
  const summary = makeEl("summary", "");
  summary.append(makeEl("span", "summary-title", node.title));
  const doneCount = node.children.filter(function (c) { return doneIds.includes(c.id); }).length;
  summary.append(makeEl("span", "meta", doneCount + " of " + node.children.length + " generated"));
  summary.append(quizButtonFor(node.title, [node]));
  details.append(summary);

  node.children.forEach(function (child) { details.append(renderTopic(child, node.children)); });

  // Only ONE unit open at a time: opening this one closes all the others
  details.addEventListener("toggle", function () {
    if (!details.open) return;
    treeEl.querySelectorAll("details.unit-card[open]").forEach(function (other) {
      if (other !== details) other.open = false;
    });
  });
  return details;
}

function renderNode(node) {
  if (isLeaf(node)) return renderTopic(node, [node]);     // a document with no units: each topic stands alone
  if (isUnit(node)) return renderUnit(node);

  // A module: collapsed, shows its units
  const details = makeEl("details", "module-card");
  const summary = makeEl("summary", "");
  summary.append(makeEl("span", "summary-title", node.title));
  summary.append(makeEl("span", "meta", "p. " + node.page));
  summary.append(quizButtonFor(node.title, [node]));
  details.append(summary);
  node.children.forEach(function (child) { details.append(renderNode(child)); });
  return details;
}

function drawTree(outline) {
  treeEl.replaceChildren();
  const wholeRow = makeEl("div", "whole-quiz");
  wholeRow.append(makeButton("Quiz me on the whole course", "btn", function () { openBigQuiz(courseName || "Whole course", outline); }));
  treeEl.append(wholeRow);
  outline.forEach(function (node) { treeEl.append(renderNode(node)); });
}

let currentOutline = [];

async function loadOutline() {
  if (!docId) {
    docTitleEl.textContent = "No document yet";
    outlineNoteEl.textContent = "Go back and upload a PDF or photos first.";
    return;
  }

  try {
    const response = await apiFetch("/api/doc/" + encodeURIComponent(docId));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load the contents.");

    rememberDoc(docId);
    try { localStorage.setItem("lastDocId", docId); } catch (error) { /* fine */ }

    courseName = data.courseTitle || data.name;
    docTitleEl.textContent = courseName;
    docMetaEl.textContent = data.pages + " page" + (data.pages === 1 ? "" : "s") + " read";
    outlineNoteEl.textContent =
      "Open a module, then a unit, then tap Teach this on the topic you want. Topics you already generated are marked.";

    currentOutline = data.outline;
    doneIds = await getDoneAsync(docId);
    drawTree(currentOutline);
  } catch (error) {
    console.error(error);
    docTitleEl.textContent = "Could not load";
    outlineNoteEl.textContent = error.message === "Failed to fetch"
      ? "Cannot reach the server. Is it running? (npm start in the server folder)"
      : error.message;
  }
}

// Coming back from the classroom with the Back button: refresh the "generated" marks
window.addEventListener("pageshow", async function (event) {
  if (event.persisted && currentOutline.length) {
    doneIds = await getDoneAsync(docId);
    drawTree(currentOutline);
  }
});


/* ---------- asking for the first lesson ---------- */
async function teach(entries, label) {
  if (isBusy || entries.length === 0) return;
  isBusy = true;
  setAllButtonsDisabled(true);

  const prefs = getPrefs();
  const stopTimer = startWaitTimer(function (m) { showBusy(m, false); }, 'Preparing "' + label + '"');

  try {
    // Each entry knows how its lesson opens and closes (see entriesForTopic)
    const first = await fetchTopicLesson(docId, entries[0], entries[0].position || "only", prefs);

    first.playlist = { entries: entries, index: 0, prefs: prefs, label: label };
    sessionStorage.setItem("currentLesson", JSON.stringify(first));
    window.location.href = "classroom.html";
  } catch (error) {
    console.error(error);
    showBusy(error.message, true);
    isBusy = false;
    setAllButtonsDisabled(false);
  } finally {
    stopTimer();
  }
}

loadOutline();
