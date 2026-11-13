/* =========================================================
   GENERATE PAGE  (version 3)

   Two ways to start:
   A) UPLOAD a PDF or photos
        -> files are read in the browser and sent to our server (/api/upload)
        -> the server builds a contents outline and gives us a docId
        -> we open outline.html to pick a section
   B) PASTE text
        -> sent to /api/lesson, the lesson is saved in sessionStorage,
           and we open classroom.html
   common.js provides: postJson, startWaitTimer, bindPrefs
   ========================================================= */

const levelSelect = document.getElementById("levelSelect");
const difficultySelect = document.getElementById("difficultySelect");
const approachSelect = document.getElementById("approachSelect");
const getPrefs = bindPrefs(levelSelect, difficultySelect, approachSelect);

const uploadForm = document.getElementById("uploadForm");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");

const lessonForm = document.getElementById("lessonForm");
const materialInput = document.getElementById("materialInput");
const generateBtn = document.getElementById("generateBtn");
const statusMsg = document.getElementById("statusMsg");

const MAX_FILES_BYTES = 14 * 1024 * 1024;   // must match the server limit
const MAX_IMAGES = 6;

function showMessage(element, message, isError) {
  element.textContent = message;
  element.classList.toggle("is-error", Boolean(isError));
}

// Reads one file and gives back its content as base64 text.
// readAsDataURL gives "data:application/pdf;base64,AAAA...", we keep what is after the comma.
function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
    reader.onerror = function () { reject(new Error("Could not read the file " + file.name)); };
    reader.readAsDataURL(file);
  });
}

/* ---------- A) UPLOAD ---------- */
uploadForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  const files = Array.from(fileInput.files);
  if (files.length === 0) {
    showMessage(uploadStatus, "Choose a PDF or some photos first.", true);
    return;
  }

  // Check the files in the browser first, so mistakes are caught instantly
  const isPdf = function (f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name); };
  const isImage = function (f) { return /^image\/(png|jpeg|webp)$/.test(f.type); };
  const totalBytes = files.reduce(function (sum, f) { return sum + f.size; }, 0);

  if (totalBytes > MAX_FILES_BYTES) {
    showMessage(uploadStatus, "These files are too big (limit about 14 MB in total).", true);
    return;
  }
  if (files.length === 1 && isPdf(files[0])) {
    // a single PDF is fine
  } else if (files.every(isImage)) {
    if (files.length > MAX_IMAGES) {
      showMessage(uploadStatus, "Please choose at most " + MAX_IMAGES + " photos at a time.", true);
      return;
    }
  } else {
    showMessage(uploadStatus, "Choose ONE PDF, or up to " + MAX_IMAGES + " photos (PNG, JPG, WEBP). Do not mix them.", true);
    return;
  }

  uploadBtn.disabled = true;
  const stopTimer = startWaitTimer(function (m) { showMessage(uploadStatus, m, false); }, "Reading your file and building the contents");

  try {
    const payload = [];
    for (const file of files) {
      payload.push({ name: file.name, mimeType: isPdf(file) ? "application/pdf" : file.type, data: await readFileAsBase64(file) });
    }

    const result = await postJson("/api/upload", { files: payload });

    try {
      localStorage.setItem("lastDocId", result.docId);
      sessionStorage.removeItem("currentLesson");   // forget any older lesson
    } catch (storageError) {
      // fine: the docId is also put in the page address below
    }
    window.location.href = "outline.html?doc=" + encodeURIComponent(result.docId);
  } catch (error) {
    console.error(error);
    showMessage(uploadStatus, error.message, true);
    uploadBtn.disabled = false;
  } finally {
    stopTimer();
  }
});

/* ---------- B) PASTE TEXT ---------- */
lessonForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  generateBtn.disabled = true;
  const stopTimer = startWaitTimer(function (m) { showMessage(statusMsg, m, false); }, "Preparing your lesson");

  try {
    const prefs = getPrefs();
    const data = await postJson("/api/lesson", {
      text: materialInput.value,
      level: prefs.level,
      difficulty: prefs.difficulty,
      approach: prefs.approach
    });

    sessionStorage.setItem("currentLesson", JSON.stringify(data));
    window.location.href = "classroom.html";
  } catch (error) {
    console.error(error);
    showMessage(statusMsg, error.message, true);
    generateBtn.disabled = false;
  } finally {
    stopTimer();
  }
});


/* ---------------------------------------------------------
   YOUR SAVED MATERIAL
   Asks the server (GET /api/docs) what was uploaded before and shows a link
   to each one's contents page. If the server is off or nothing is saved,
   the card simply stays hidden.
   --------------------------------------------------------- */
async function loadSavedMaterial() {
  const card = document.getElementById("savedCard");
  const list = document.getElementById("savedList");
  try {
    const response = await apiFetch("/api/docs");
    if (!response.ok) return;
    const data = await response.json();
    if (!data.docs || data.docs.length === 0) return;

    list.replaceChildren();
    data.docs.forEach(function (doc) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = "outline.html?doc=" + encodeURIComponent(doc.docId);
      link.textContent = (doc.courseTitle || doc.name) + "  (" + doc.pages + " page" + (doc.pages === 1 ? "" : "s") + ")";
      item.append(link);
      list.append(item);
    });
    card.hidden = false;
  } catch (error) {
    // The server is not running: say nothing here, the other buttons already explain it
  }
}

loadSavedMaterial();