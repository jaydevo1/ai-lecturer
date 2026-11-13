/* =========================================================
   CONTENTS PAGE  (outline.js)

   1. Find out which document to show (from the address ?doc=...).
   2. Ask the server for its outline: GET /api/doc/<id>.
   3. Draw the outline as folders (<details>) with Teach buttons.
   4. When a Teach button is pressed, ask the server for a lesson
      (POST /api/lesson), save it in sessionStorage, open the classroom.
   common.js provides: SERVER_URL, postJson, startWaitTimer, bindPrefs
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

const MAX_PART_BUTTONS = 12;   // do not draw 40 buttons for a giant section
let isBusy = false;


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

// Makes the buttons for ONE teachable piece of text.
// If the text is longer than one lesson, it is split in parts: "Part 1", "Part 2"...
function makeTeachButtons(node, scope, partCount, wholeLabel) {
  const buttons = [];
  if (partCount <= 1) {
    buttons.push(makeTeachButton(wholeLabel, node, scope, 0));
  } else if (partCount <= MAX_PART_BUTTONS) {
    for (let i = 0; i < partCount; i++) {
      buttons.push(makeTeachButton(wholeLabel + ": part " + (i + 1) + " of " + partCount, node, scope, i));
    }
  } else {
    buttons.push(makeEl("span", "short-note", "Too long to teach at once. Open it and pick a smaller section."));
  }
  return buttons;
}

function makeTeachButton(label, node, scope, part) {
  const button = makeEl("button", "btn", label);
  button.type = "button";
  button.addEventListener("click", function () {
    teach(node, scope, part);
  });
  return button;
}


/* ---------- drawing the tree ---------- */
function renderNode(node, depth) {
  const hasChildren = node.children.length > 0;

  if (hasChildren) {
    // A folder: a module or unit that has sections inside it
    const details = makeEl("details", "depth-" + Math.min(depth + 1, 3));
    if (depth === 0 && treeEl.children.length === 0) details.open = true;   // open the very first one

    const summary = makeEl("summary", "", node.title);
    summary.append(makeEl("span", "meta", "p. " + node.page));
    details.append(summary);

    // "Teach the whole unit" buttons (everything inside this folder)
    if (node.rangeChars >= 150) {
      const actions = makeEl("div", "actions");
      makeTeachButtons(node, "all", node.rangeParts, "Teach the whole thing").forEach(function (b) { actions.append(b); });
      details.append(actions);
    }

    node.children.forEach(function (child) { details.append(renderNode(child, depth + 1)); });
    return details;
  }

  // A single section (no children)
  const leaf = makeEl("div", "leaf");
  leaf.append(makeEl("span", "leaf-title", node.title));

  if (node.teachable) {
    makeTeachButtons(node, "own", node.parts, "Teach this").forEach(function (b) { leaf.append(b); });
  } else {
    leaf.classList.add("is-short");
    leaf.append(makeEl("span", "short-note", "very short, p. " + node.page));
  }
  return leaf;
}

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

    docTitleEl.textContent = data.courseTitle || data.name;
    docMetaEl.textContent = data.pages + " page" + (data.pages === 1 ? "" : "s") + " read";
    outlineNoteEl.textContent =
      "Tap a unit to open it, then tap Teach. Contents made by: " + data.outlineSource + ". " +
      "If a heading looks wrong, the teaching text is still your own material.";

    treeEl.replaceChildren();
    data.outline.forEach(function (node) { treeEl.append(renderNode(node, 0)); });
  } catch (error) {
    console.error(error);
    docTitleEl.textContent = "Could not load";
    outlineNoteEl.textContent = error.message === "Failed to fetch"
      ? "Cannot reach the server. Is it running? (npm start in the server folder)"
      : error.message;
  }
}


/* ---------- asking for a lesson ---------- */
async function teach(node, scope, part) {
  if (isBusy) return;
  isBusy = true;
  setAllButtonsDisabled(true);

  const prefs = getPrefs();
  const stopTimer = startWaitTimer(function (m) { showBusy(m, false); }, 'Preparing "' + node.title + '"');

  try {
    const lesson = await postJson("/api/lesson", {
      docId: docId,
      sectionId: node.id,
      scope: scope,
      part: part,
      level: prefs.level,
      difficulty: prefs.difficulty,
      approach: prefs.approach
    });

    sessionStorage.setItem("currentLesson", JSON.stringify(lesson));
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