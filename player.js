/* =========================================================
   LESSON PLAYER  (version 3: a more reliable voice)

   What this file does:
   1. Loads a lesson (made by the AI, or the sample lesson).
   2. For each segment it shows the board, then SPEAKS the text one
      sentence at a time, then moves on to the next segment.
   3. Handles the buttons: start/pause, back, next, repeat, mute, speed.

   WHY IS THE VOICE CODE SO CAREFUL?
   The browser's built-in voice (speechSynthesis) has several known
   problems. Each trick below fixes one of them:
   - We prefer a LOCAL voice (stored on your computer). Online voices
     are slow to start and sometimes never say "I finished".
   - We speak ONE SENTENCE at a time. Long speeches get cut off in
     Chrome, and Pause/Resume can continue from the same sentence.
   - We keep a reference to the current utterance, otherwise Chrome can
     delete it halfway and the "end" event never arrives.
   - After cancel() we wait 150 ms before speaking again, because Chrome
     sometimes ignores a speak() that comes right after a cancel().
   - Two watchdog timers rescue the lesson if the voice never starts or
     never finishes.
   ========================================================= */


/* ---------------------------------------------------------
   1. GRAB THE ELEMENTS WE NEED FROM THE PAGE
   --------------------------------------------------------- */
const topbarLabelEl   = document.getElementById("topbarLabel");
const lessonTitleEl   = document.getElementById("lessonTitle");
const contentsLinkEl  = document.getElementById("contentsLink");
const progressFillEl  = document.getElementById("progressFill");
const progressTextEl  = document.getElementById("progressText");
const boardContentEl  = document.getElementById("boardContent");
const subtitleEl      = document.getElementById("subtitle");
const statusEl        = document.getElementById("lecturerStatus");
const speakingDotEl   = document.getElementById("speakingDot");
const mouthEl         = document.getElementById("mouth");

// ----- Lecturer portrait (photo tile) -----
// One base photo plus six small variations (mouth shapes and a blink), all made from the SAME picture,
// so the face never shifts. The mouth shape follows the loudness of the voice.
const faceImgEl = document.getElementById("faceImg");
const stageEl   = document.querySelector(".stage");
const FACES = {
  closed: "images/sprites/closed.webp",
  eh:     "images/sprites/eh.webp",
  ah:     "images/sprites/ah.webp",
  oo:     "images/sprites/oo.webp",
  ee:     "images/sprites/ee.webp",
  fv:     "images/sprites/fv.webp",
  blink:  "images/sprites/blink.webp"
};
let currentFace = "closed";

// Load all the pictures now so swapping later is instant (no flicker)
Object.keys(FACES).forEach(function (name) { new Image().src = FACES[name]; });

// If the photo cannot load, show the drawn teacher instead
if (faceImgEl) {
  faceImgEl.addEventListener("error", function () { stageEl.classList.add("no-photo"); });
  // the error may already have happened before this line ran
  if (faceImgEl.complete && faceImgEl.naturalWidth === 0) stageEl.classList.add("no-photo");
}

function setFace(name) {
  if (name === currentFace) return;
  currentFace = name;
  if (faceImgEl) faceImgEl.src = FACES[name];
}

// What drives the mouth:
//  - natural voice: the real loudness of the sound (measured with an "analyser")
//  - phone voice: the browser gives no sound to measure, so we make a talking rhythm up
let speakingNow = false;       // true while the lecturer is speaking
let usingCloudAudio = false;   // true while a natural-voice clip is playing
let analyserNode = null, analyserData = null, clipGain = 5;
let mouthLevel = 0, mouthTarget = 0, nextSyllable = 0, syllableCount = 0;
let midPick = 0, wasOpen = false, lastSwap = 0, blinkUntil = 0, nextBlink = 3000;
const MID_SHAPES = ["ee", "oo", "eh", "ee", "fv", "oo"];   // the middle mouth shapes take turns

function measureLevel() {
  analyserNode.getByteTimeDomainData(analyserData);
  let sum = 0;
  for (let i = 0; i < analyserData.length; i++) { const v = (analyserData[i] - 128) / 128; sum += v * v; }
  return Math.min(1, Math.sqrt(sum / analyserData.length) * clipGain);
}

function faceLoop(now) {
  if (speakingNow && usingCloudAudio && analyserNode) {
    mouthTarget = measureLevel();
  } else if (speakingNow) {
    if (now > nextSyllable) {                       // a new mouth size about every 140 to 220 ms, like syllables
      syllableCount++;
      if (syllableCount % (4 + Math.floor(Math.random() * 4)) === 0) { mouthTarget = 0.05; nextSyllable = now + 200 + Math.random() * 150; }
      else { mouthTarget = 0.25 + Math.random() * 0.6; nextSyllable = now + 140 + Math.random() * 80; }
    }
  } else {
    mouthTarget = 0;
  }
  mouthLevel += (mouthTarget - mouthLevel) * (usingCloudAudio ? 0.45 : 0.25);

  const open = mouthLevel > 0.14;
  if (open && !wasOpen) midPick = (midPick + 1) % MID_SHAPES.length;
  wasOpen = open;
  let want = "closed";
  if (mouthLevel > 0.5) want = "ah";
  else if (mouthLevel > 0.3) want = MID_SHAPES[midPick];
  else if (open) want = "eh";
  if (want === "closed") {                          // blink only while the mouth is closed
    if (now > nextBlink) { blinkUntil = now + 140; nextBlink = now + 2500 + Math.random() * 3500; }
    if (now < blinkUntil) want = "blink";
  }
  if (want !== currentFace && (want === "closed" || want === "blink" || now - lastSwap > 110)) { setFace(want); lastSwap = now; }
  if (mouthEl) mouthEl.setAttribute("ry", (3 + mouthLevel * 9).toFixed(1));   // the drawn teacher (backup picture)
  requestAnimationFrame(faceLoop);
}
requestAnimationFrame(faceLoop);

const btnPlay     = document.getElementById("btnPlay");
const btnPrev     = document.getElementById("btnPrev");
const btnNext     = document.getElementById("btnNext");
const btnRepeat   = document.getElementById("btnRepeat");
const btnMute     = document.getElementById("btnMute");
const speedSelect = document.getElementById("speedSelect");
const askForm     = document.getElementById("askForm");
const askInput    = document.getElementById("askInput");
const chips       = document.querySelectorAll(".chip");


/* ---------------------------------------------------------
   2. LESSON STATE
   "State" = everything the player must remember right now.
   --------------------------------------------------------- */
let lesson = null;        // the lesson data
let current = 0;          // index of the segment we are on
let isPlaying = false;    // is the lesson running (true) or paused (false)?
let isMuted = false;
let speechSpeed = 1;      // 1 = normal; the speed dropdown changes this

// The speech of the current segment is cut into sentences ("parts").
let parts = [];           // the sentences of the current segment
let partIndex = 0;        // which sentence we are on

// speakToken is a number that goes up every time we stop or restart the voice.
// Events from an OLD voice run carry an old number, so we can ignore them.
let speakToken = 0;

let startTimer = null;        // waits 150 ms after a cancel
let startCheckTimer = null;   // watchdog 1: did the voice START?
let watchdogTimer = null;     // watchdog 2: did the voice FINISH?
let currentUtterance = null;  // kept so Chrome does not throw it away mid-speech
let chosenVoice = null;

const speechSupported = "speechSynthesis" in window;


/* ---------------------------------------------------------
   3. LOAD THE LESSON
   --------------------------------------------------------- */
async function loadLesson() {
  try {
    // A lesson made by the AI is saved in sessionStorage by the other pages
    let savedLesson = null;
    try {
      savedLesson = sessionStorage.getItem("currentLesson");
    } catch (storageError) {
      savedLesson = null;
    }

    if (savedLesson) {
      lesson = JSON.parse(savedLesson);
    } else {
      const response = await fetch("lessons/sample.json");
      if (!response.ok) {
        throw new Error("Could not load lessons/sample.json (status " + response.status + ")");
      }
      lesson = await response.json();
    }

    playlist = lesson.playlist || null;     // set by the contents page: the topics of a unit, in order

    // A logged-in learner is greeted by name when a unit begins ("Hi Jay. Welcome to ...")
    const firstName = getLearnerName();
    const startsUnit = playlist && playlist.index === 0 && playlist.entries && playlist.entries[0] &&
      (playlist.entries[0].position === "first" || playlist.entries[0].position === "only");
    if (firstName && startsUnit && !lesson.greeted && lesson.segments && lesson.segments[0]) {
      lesson.segments[0].speech = "Hi " + firstName + ". " + lesson.segments[0].speech;
      lesson.greeted = true;
      try { sessionStorage.setItem("currentLesson", JSON.stringify(lesson)); } catch (storageError) { /* fine */ }
    }
    tagSegments(lesson.segments, 0, lesson.sectionTitle || lesson.title, lesson);
    lessonTitleEl.textContent = lesson.title;
    if (lesson.docName) topbarLabelEl.textContent = lesson.docName;

    // Lessons made from an uploaded document can go back to the contents
    if (lesson.docId) {
      contentsLinkEl.href = "outline.html?doc=" + encodeURIComponent(lesson.docId);
      contentsLinkEl.hidden = false;
    }

    // Contents button: open the contents page right at the topic you are on (module > unit > topic)
    contentsLinkEl.addEventListener("click", function () {
      if (!lesson.docId) return;
      const entry = playlist && playlist.entries ? playlist.entries[playlist.index || 0] : null;
      const at = (entry && entry.sectionId) || lesson.sectionId || "";
      if (at) {
        try { localStorage.setItem("lastTopic:" + lesson.docId, at); } catch (e) { /* fine */ }
        contentsLinkEl.href = "outline.html?doc=" + encodeURIComponent(lesson.docId) + "&at=" + encodeURIComponent(at);
      }
    });
    {
      const e0 = lesson.playlist && lesson.playlist.entries ? lesson.playlist.entries[0] : null;
      const at0 = (e0 && e0.sectionId) || lesson.sectionId || "";
      if (lesson.docId && at0) { try { localStorage.setItem("lastTopic:" + lesson.docId, at0); } catch (e) { /* fine */ } }
    }

    showSegment(0, false);
    setReadyState();

    if (!speechSupported) {
      statusEl.textContent = "This browser cannot speak. Use Chrome or Edge.";
    }
  } catch (error) {
    console.error(error);
    subtitleEl.textContent = "Sorry, the lesson could not be loaded. Open the project with Live Server.";
  }
}


/* ---------------------------------------------------------
   4. BOARD RENDERING
   We build elements with createElement + textContent (never innerHTML)
   so text from the AI can never inject HTML.
   --------------------------------------------------------- */
function makeEl(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function renderBoard(segment) {
  const board = segment.board;
  boardContentEl.replaceChildren();

  // Top line: tag on the left, where this part comes from on the right
  const top = makeEl("div", "board-top");
  top.append(makeEl("p", "board-tag", board.tag));

  // Only extra content (the lecturer's own example or analogy) is labelled; the material's own points need no label
  if (segment.source === "added") top.append(makeEl("span", "board-source", "Example / extra"));
  boardContentEl.append(top);

  boardContentEl.append(makeEl("h2", "board-heading", board.heading));

  if (board.type === "title" || board.type === "definition") {
    boardContentEl.append(makeEl("p", "board-text", board.text));
  }

  if (board.type === "diagram") {
    const diagram = makeEl("div", "board-diagram");
    diagram.append(makeEl("div", "node node-root", board.root));

    const branches = makeEl("div", "branches");
    board.children.forEach(function (label, index) {
      const node = makeEl("div", "node", label);
      if (index === board.highlight) node.classList.add("node-active");
      branches.append(node);
    });

    diagram.append(branches);
    boardContentEl.append(diagram);
  }

  if (board.type === "list") {
    const list = makeEl("ul", "board-list");
    board.items.forEach(function (item) {
      list.append(makeEl("li", "", item));
    });
    boardContentEl.append(list);
  }

  // ---- maths, tables, notes and code ----
  if (board.type === "formula") {
    if (board.latex) {
      // KaTeX draws it big and centred ($$ ... $$ is "display" maths)
      boardContentEl.append(makeEl("div", "board-formula", "$$" + board.latex + "$$"));
    }
    if (board.text) boardContentEl.append(makeEl("p", "board-text", board.text));
  }

  if (board.type === "steps") {
    // The same steps stay on the board across segments; "highlight" says which step we are on.
    // Steps after the current one are hidden, so the solution builds up while the lecturer explains.
    const steps = makeEl("ol", "board-steps");
    board.items.forEach(function (item, index) {
      if (board.highlight >= 0 && index > board.highlight) return;
      const li = makeEl("li", index === board.highlight ? "step-now" : "step-done", item);
      steps.append(li);
    });
    boardContentEl.append(steps);
  }

  if (board.type === "table") {
    const table = makeEl("table", "board-table");
    if (board.columns && board.columns.length) {
      const head = makeEl("tr", "");
      board.columns.forEach(function (c) { head.append(makeEl("th", "", c)); });
      table.append(head);
    }
    (board.rows || []).forEach(function (row) {
      const tr = makeEl("tr", "");
      row.split("|").forEach(function (cell) { tr.append(makeEl("td", "", cell.trim())); });
      table.append(tr);
    });
    const wrap = makeEl("div", "board-table-wrap");
    wrap.append(table);
    boardContentEl.append(wrap);
  }

  if (board.type === "drawing" && board.svg) {
    // The server already rebuilt this SVG from safe parts only; we check once more before showing it
    const frame = makeEl("div", "board-drawing");
    if (/<script|\son\w+\s*=|javascript:/i.test(board.svg)) {
      frame.textContent = board.text || "";
    } else {
      frame.innerHTML = board.svg;
    }
    boardContentEl.append(frame);
    if (board.text) boardContentEl.append(makeEl("p", "board-caption", board.text));
  }

  if (board.type === "note") {
    boardContentEl.append(makeEl("p", "board-note", board.text));
  }

  if (board.type === "code") {
    boardContentEl.append(makeEl("pre", "board-code", board.text));
  }

  renderMath(boardContentEl);
}

// Turn $...$ and $$...$$ on the board into real equations. KaTeX loads a moment after the page,
// so if it is not ready yet we try again a few times. If it never loads, the plain text stays.
function renderMath(element, attempt) {
  attempt = attempt || 0;
  if (typeof window.renderMathInElement === "function") {
    try {
      window.renderMathInElement(element, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false }
        ],
        throwOnError: false
      });
    } catch (error) { /* leave the plain text */ }
    return;
  }
  if (attempt < 20) setTimeout(function () { renderMath(element, attempt + 1); }, 250);
}


/* ---------------------------------------------------------
   5. CHOOSING A VOICE
   Prefer a local English voice. Online voices ("Google ...",
   "... Online (Natural)") are slower and less reliable here.
   --------------------------------------------------------- */
function pickVoice() {
  if (!speechSupported) return null;
  const voices = window.speechSynthesis.getVoices();
  const english = voices.filter(function (v) {
    return v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("en");
  });
  if (english.length === 0) return null;

  // A voice the learner picked earlier wins
  let saved = "";
  try { saved = localStorage.getItem("lecturerVoice") || ""; } catch (e) {}
  if (saved) {
    const found = english.find(function (v) { return v.name === saved; });
    if (found) return found;
  }

  function score(v) {
    let points = 0;
    if (v.localService) points += 10;                    // stored on this computer
    const lang = v.lang.toLowerCase().replace("_", "-");
    if (lang === "en-gb" || lang === "en-ng") points += 3;
    else if (lang === "en-us") points += 2;
    if (/natural|online/i.test(v.name)) points -= 5;     // online voices lag
    // The lecturer's face is male, so prefer a male voice when the device has one
    if (/\b(david|mark|guy|ryan|alex|daniel|george|james|richard|christopher|eric|thomas|fred|male)\b/i.test(v.name)) points += 12;
    if (/\b(zira|hazel|susan|samantha|victoria|karen|moira|fiona|female|aria|jenny)\b/i.test(v.name)) points -= 4;
    return points;
  }
  english.sort(function (a, b) { return score(b) - score(a); });
  return english[0];
}

// Fills the voice picker in the controls
function fillVoicePicker() {
  const picker = document.getElementById("voiceSelect");
  if (!picker || !speechSupported) return;
  const english = window.speechSynthesis.getVoices().filter(function (v) {
    return v.lang && v.lang.toLowerCase().replace("_", "-").startsWith("en");
  });
  if (english.length === 0) return;
  picker.innerHTML = "";
  english.forEach(function (v) {
    const option = document.createElement("option");
    option.value = v.name;
    option.textContent = v.name.replace(/^Microsoft |^Google /, "");
    picker.appendChild(option);
  });
  if (chosenVoice) picker.value = chosenVoice.name;
}

if (speechSupported) {
  chosenVoice = pickVoice();
  // Chrome loads its voice list a moment after the page opens
  window.speechSynthesis.onvoiceschanged = function () { chosenVoice = pickVoice(); fillVoicePicker(); };
  fillVoicePicker();
  const voicePickerEl = document.getElementById("voiceSelect");
  if (voicePickerEl) voicePickerEl.addEventListener("change", function () {
    try { localStorage.setItem("lecturerVoice", voicePickerEl.value); } catch (e) {}
    chosenVoice = pickVoice();
    if (isPlaying && lesson) { stopSpeaking(); showSegment(current, true); }   // hear the new voice straight away
  });
}


/* ---------------------------------------------------------
   6. SPEAKING
   --------------------------------------------------------- */

// Cuts the text of a segment into sentences. If the segment has an exact quote,
// the lecturer reads it out first.
function splitIntoParts(segment) {
  // (the server already makes sure any exact sentence from the material is part of "speech")
  const text = segment.speech;
  const pieces = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
  return pieces.map(function (p) { return p.trim(); }).filter(Boolean);
}

/* ---------------------------------------------------------
   NATURAL VOICE (made once on the server, saved, and played here as a small sound file)
   - The server says whether it is switched on (/api/health). If it is, the settings sheet gets a "Voice type" choice.
   - We ask for a few sentences at a time and fetch the NEXT piece while this one plays, so there are no gaps.
   - If anything goes wrong (daily limit, no internet), we quietly use the phone voice for a while.
   --------------------------------------------------------- */
const CLOUD = { available: false };
let cloudDownUntil = 0;            // after a failure we use the phone voice until this time
let audioCtx = null, gainNode = null, currentSource = null;
const clipCache = new Map();       // text -> promise of the decoded sound

function wantsNatural() {
  try { return localStorage.getItem("voiceMode") === "natural"; } catch (e) { return false; }
}
function cloudActive() {
  return CLOUD.available && wantsNatural() && Date.now() > cloudDownUntil;
}

// Sound must be unlocked by a tap. playCurrent() calls this inside the Start/Resume tap.
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    audioCtx = new AC();
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;
    analyserData = new Uint8Array(analyserNode.fftSize);
    gainNode = audioCtx.createGain();
    analyserNode.connect(gainNode);     // the analyser sits BEFORE the volume, so Mute still moves the mouth
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  return true;
}

function stopClip() {
  usingCloudAudio = false;
  if (currentSource) {
    const old = currentSource;
    currentSource = null;
    old.onended = null;
    try { old.stop(); } catch (e) { /* already stopped */ }
  }
}

// Downloads one clip and turns it into sound. Remembered, so repeating is instant.
function getClip(text) {
  if (clipCache.has(text)) return clipCache.get(text);
  const job = (async function () {
    let response;
    const timeout = new Promise(function (_, reject) { setTimeout(function () { reject(new Error("voice took too long")); }, 75000); });
    response = await Promise.race([
      apiFetch("/api/voice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text }) }),
      timeout
    ]);
    if (!response.ok) throw new Error("voice HTTP " + response.status);
    const bytes = await response.arrayBuffer();
    ensureAudio();
    const buffer = await audioCtx.decodeAudioData(bytes);
    // Auto-volume for the mouth: deep or quiet voices would barely open it, so measure this clip and scale to suit
    const data = buffer.getChannelData(0), win = Math.floor(buffer.sampleRate * 0.05), loud = [];
    for (let a = 0; a + win < data.length; a += win) { let q = 0; for (let k = a; k < a + win; k++) q += data[k] * data[k]; loud.push(Math.sqrt(q / win)); }
    loud.sort(function (x, y) { return x - y; });
    const p90 = loud[Math.floor(loud.length * 0.9)] || 0.1;
    buffer.mouthGain = Math.max(2, Math.min(30, 0.6 / p90));
    return buffer;
  })();
  clipCache.set(text, job);
  job.catch(function () { clipCache.delete(text); });
  if (clipCache.size > 14) clipCache.delete(clipCache.keys().next().value);   // keep memory small
  return job;
}

// A "chunk" = a few sentences (about 260 letters) spoken as one clip, starting at sentence number "from".
function chunkAt(segmentParts, from) {
  let n = 0, text = "";
  while (from + n < segmentParts.length) {
    const piece = segmentParts[from + n];
    if (n > 0 && (text + " " + piece).length > 260) break;
    text += (n ? " " : "") + piece;
    n++;
  }
  return n ? { text: text, n: n } : null;
}

// While one clip plays, fetch the next one (in this segment, or the start of the next segment)
function prefetchAfter(nextFrom) {
  let next = chunkAt(parts, nextFrom);
  if (!next && lesson && lesson.segments[current + 1] && !lesson.segments[current].checkAfter && !lesson.segments[current].endsLesson) {
    next = chunkAt(splitIntoParts(lesson.segments[current + 1]), 0);
  }
  if (next && next.text.length <= 690) getClip(next.text).catch(function () { /* handled when it is needed */ });
}

function speakChunkCloud(token) {
  const chunk = chunkAt(parts, partIndex);
  if (!chunk || chunk.text.length > 690) { speakPartPhone(token, false); return; }

  if (!speakingNow) statusEl.textContent = "Preparing the voice...";
  getClip(chunk.text).then(function (buffer) {
    if (token !== speakToken) return;
    ensureAudio();
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = speechSpeed;
    source.connect(analyserNode);
    gainNode.gain.value = isMuted ? 0 : 1;      // muted still "speaks" silently, so timing stays the same
    clipGain = buffer.mouthGain || 5;
    currentSource = source;
    usingCloudAudio = true;
    setSpeaking(true);
    source.onended = function () {
      if (currentSource === source) currentSource = null;
      if (token !== speakToken) return;
      partIndex += chunk.n;
      if (partIndex < parts.length) {
        speakPart(token, false);
      } else {
        setSpeaking(false);
        segmentSpoken();
      }
    };
    source.start();
    prefetchAfter(partIndex + chunk.n);
  }).catch(function (error) {
    if (token !== speakToken) return;
    console.warn("Natural voice failed, using the phone voice for a while:", error && error.message);
    cloudDownUntil = Date.now() + 5 * 60 * 1000;
    statusEl.textContent = "Using the phone voice for now";
    speakPartPhone(token, false);
  });
}

// Ask the server if the natural voice is switched on; if so, show the choice in the settings
(async function checkNaturalVoice() {
  try {
    const response = await apiFetch("/api/health");
    const info = await response.json();
    if (!info.voice || !info.voice.on) return;
    CLOUD.available = true;
    const row = document.getElementById("voiceModeRow");
    const select = document.getElementById("voiceMode");
    if (row && select) {
      row.hidden = false;
      select.value = wantsNatural() ? "natural" : "phone";
      select.addEventListener("change", function () {
        try { localStorage.setItem("voiceMode", select.value); } catch (e) { /* fine */ }
        cloudDownUntil = 0;
        if (isPlaying && lesson) { stopSpeaking(); showSegment(current, true); }   // hear the new voice straight away
      });
    }
  } catch (e) { /* server asleep or old version: the phone voice just stays */ }
})();


// Stops everything: voice, timers, and any pending start.
function stopSpeaking() {
  speakToken++;                         // makes all old voice events "stale"
  clearTimeout(startTimer);
  clearTimeout(startCheckTimer);
  clearTimeout(watchdogTimer);
  if (speechSupported) window.speechSynthesis.cancel();
  stopClip();
  setSpeaking(false);
}

// Green dot and status text. (The mouth itself is moved by faceLoop above.)
function setSpeaking(isSpeaking) {
  speakingDotEl.classList.toggle("is-speaking", isSpeaking);
  speakingNow = isSpeaking;
  if (isSpeaking) {
    statusEl.textContent = "Speaking...";
  } else {
    usingCloudAudio = false;
    statusEl.textContent = isPlaying ? "Teaching" : "Paused";
  }
}

// Start (or restart) speaking the current segment from a given sentence.
function playCurrent(fromPart) {
  if (!speechSupported && !cloudActive()) {
    statusEl.textContent = "This browser cannot speak. Use Chrome or Edge.";
    return;
  }
  if (CLOUD.available) ensureAudio();      // must happen inside the tap, or phones keep the sound locked

  parts = splitIntoParts(lesson.segments[current]);
  partIndex = Math.min(Math.max(fromPart || 0, 0), parts.length - 1);

  const synth = window.speechSynthesis;
  const wasBusy = speechSupported && (synth.speaking || synth.pending);

  stopSpeaking();
  const myToken = speakToken;           // the number of THIS run
  statusEl.textContent = "Starting...";  // instant feedback, so the button never feels dead

  // If something was speaking, wait a moment after cancel() before speaking again
  startTimer = setTimeout(function () {
    if (myToken !== speakToken) return;
    speakPart(myToken, false);
  }, wasBusy ? 150 : 0);
}

// Speaks the next piece: with the natural voice if it is on and working, otherwise the phone voice.
function speakPart(token, isRetry) {
  if (cloudActive()) speakChunkCloud(token);
  else speakPartPhone(token, isRetry);
}

// The whole segment has been spoken: go on to the quiz question, the next segment, or the end.
function segmentSpoken() {
  if (lesson.segments[current].endsLesson) {
    finishLesson();                       // a quiz re-teach segment ends the lesson when it is done
  } else if (lesson.segments[current].checkAfter) {
    askUnderstanding();                   // "Does that make sense?"
  } else {
    goTo(current + 1);                    // otherwise the next segment
  }
}

// Speaks ONE sentence (parts[partIndex]) with the phone's own voice; when it ends, speaks the next one.
function speakPartPhone(token, isRetry) {
  const synth = window.speechSynthesis;
  const text = parts[partIndex];

  const utterance = new SpeechSynthesisUtterance(text);
  if (!chosenVoice) chosenVoice = pickVoice();
  if (chosenVoice) {
    utterance.voice = chosenVoice;
    utterance.lang = chosenVoice.lang;
  } else {
    utterance.lang = "en-GB";
  }
  utterance.rate = 0.95 * speechSpeed;
  utterance.volume = isMuted ? 0 : 1;     // muted still "speaks" silently, so timing stays the same

  let started = false;
  let finished = false;   // becomes true once THIS sentence has been dealt with (so it is never counted twice)

  // Move on from this sentence. cancelFirst = true when the voice is stuck and we must stop it ourselves.
  function finishThisPart(cancelFirst) {
    if (finished || token !== speakToken) return;
    finished = true;
    clearTimeout(startCheckTimer);
    clearTimeout(watchdogTimer);

    function advance() {
      if (token !== speakToken) return;
      partIndex++;
      if (partIndex < parts.length) {
        speakPart(token, false);          // next sentence
      } else {
        setSpeaking(false);
        segmentSpoken();
      }
    }

    if (cancelFirst) {
      synth.cancel();
      setTimeout(advance, 150);
    } else {
      advance();
    }
  }

  utterance.onstart = function () {
    if (finished || token !== speakToken) return;
    started = true;
    clearTimeout(startCheckTimer);
    setSpeaking(true);
  };

  utterance.onend = function () {
    finishThisPart(false);
  };

  utterance.onerror = function (event) {
    if (finished || token !== speakToken) return;
    // "canceled" and "interrupted" happen when WE stop the voice on purpose
    if (event && (event.error === "canceled" || event.error === "interrupted")) return;
    console.error("Speech error:", event && event.error);
    finishThisPart(false);
  };

  currentUtterance = utterance;     // keep a reference so Chrome does not delete it
  synth.resume();                   // some Chrome versions get stuck in "paused"
  synth.speak(utterance);

  // WATCHDOG 1: the voice should START within 4 seconds. If not, try once more, then give up.
  clearTimeout(startCheckTimer);
  startCheckTimer = setTimeout(function () {
    if (finished || started || token !== speakToken) return;
    if (!isRetry) {
      console.warn("The voice did not start, trying again.");
      finished = true;                        // ignore anything the old attempt still says
      synth.cancel();
      startTimer = setTimeout(function () {
        if (token !== speakToken) return;
        speakPart(token, true);
      }, 150);
    } else {
      voiceFailed();
    }
  }, 4000);

  // WATCHDOG 2: the voice should FINISH within a bit more than the expected time.
  // About 2.5 words per second at normal speed.
  const words = text.split(/\s+/).length;
  const expectedSeconds = words / (2.5 * utterance.rate);
  clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(function () {
    if (finished || token !== speakToken) return;
    console.warn("The voice never said it finished, moving on.");
    finishThisPart(true);
  }, (expectedSeconds * 1.6 + 5) * 1000);
}

function voiceFailed() {
  isPlaying = false;
  stopSpeaking();
  btnPlay.textContent = "▶ Resume";
  statusEl.textContent = "The voice did not start. Press Resume to try again.";
}


/* ---------------------------------------------------------
   7. SHOWING A SEGMENT
   --------------------------------------------------------- */
function showSegment(index, shouldSpeak) {
  current = index;
  partIndex = 0;
  const segment = lesson.segments[current];
  const total = lesson.segments.length;

  renderBoard(segment);
  subtitleEl.textContent = segment.subtitle;

  // The top bar shows the topic that is being taught right now
  if (segment.topic) lessonTitleEl.textContent = segment.topic;

  if (playlist) {
    // "Topic 2 of 5 - section 3 of 9": the position inside the current topic
    const sameTopic = lesson.segments.filter(function (s) { return s.topicIndex === segment.topicIndex; });
    const local = sameTopic.indexOf(segment) + 1;
    const topics = playlist.entries.length;
    progressFillEl.style.width = ((segment.topicIndex + local / sameTopic.length) / topics) * 100 + "%";
    progressTextEl.textContent = "Topic " + (segment.topicIndex + 1) + " of " + topics + " · section " + local + " of " + sameTopic.length;
  } else {
    progressFillEl.style.width = ((current + 1) / total) * 100 + "%";
    progressTextEl.textContent = "Section " + (current + 1) + " of " + total;
  }

  // Near the end of this topic: start preparing the next topic so there is no long wait
  if (playlist && shouldSpeak && current >= total - 3) prefetchNextTopic();

  if (shouldSpeak) playCurrent(0);
}

function goTo(index) {
  if (!lesson) return;
  closeCheck();
  if (index < 0) index = 0;

  if (index >= lesson.segments.length) {
    // The topic is finished. If the unit has more topics, bring the next one; otherwise the lesson is over.
    if (hasMoreTopics()) advanceTopic(); else finishLesson();
    return;
  }
  showSegment(index, isPlaying);
}


/* ---------------------------------------------------------
   A UNIT IS SEVERAL TOPICS IN A ROW (the "playlist")
   Each topic is its own lesson from the server. While you listen to one,
   the next is prepared in the background, then added to the end.
   --------------------------------------------------------- */
let playlist = null;          // { entries:[{sectionId, part, title}], index, prefs, label } or null
let nextTopicPromise = null;  // the next topic's lesson, while it is being fetched
let waitingForTopic = false;  // true when fetching the next topic failed (Resume tries again)

// Writes topic information on each segment, so the board, progress and questions know which topic they belong to
function tagSegments(segments, topicIndex, topicTitle, source) {
  segments.forEach(function (seg) {
    seg.topic = topicTitle;
    seg.topicIndex = topicIndex;
    if (source.docId) seg.ref = { sectionId: source.sectionId, part: source.part, scope: source.scope || "own" };
  });
}

function hasMoreTopics() {
  return Boolean(playlist) && playlist.index + 1 < playlist.entries.length;
}

function prefetchNextTopic() {
  if (!hasMoreTopics() || nextTopicPromise) return;
  const entry = playlist.entries[playlist.index + 1];
  const isLast = playlist.index + 2 === playlist.entries.length;
  nextTopicPromise = fetchTopicLesson(lesson.docId, entry, entry.position || (isLast ? "last" : "middle"), playlist.prefs)
    .then(function (data) { return { ok: true, data: data }; },
          function (error) { return { ok: false, error: error }; });
}

let advancingTopic = false;   // stops a second tap on "Next" from adding the same topic twice

async function advanceTopic() {
  if (advancingTopic) return;
  advancingTopic = true;
  prefetchNextTopic();
  const stopTimer = startWaitTimer(function (message) {
    subtitleEl.textContent = message;
    statusEl.textContent = "Preparing the next topic...";
  }, "Preparing the next topic");

  const result = await nextTopicPromise;
  stopTimer();
  nextTopicPromise = null;
  advancingTopic = false;

  if (!result.ok) {
    // Pause here. Pressing Resume tries again.
    waitingForTopic = true;
    isPlaying = false;
    stopSpeaking();
    btnPlay.textContent = "▶ Resume";
    subtitleEl.textContent = result.error.message + " Press Resume to try again.";
    statusEl.textContent = "Paused";
    return;
  }

  playlist.index++;
  const next = result.data;
  tagSegments(next.segments, playlist.index, next.sectionTitle || next.title, next);
  const firstNew = lesson.segments.length;
  lesson.segments = lesson.segments.concat(next.segments);
  showSegment(firstNew, isPlaying);
}


function finishLesson() {
  isPlaying = false;
  stopSpeaking();
  // Remove temporary quiz re-teach segments so a replay of the lesson stays clean
  lesson.segments = lesson.segments.filter(function (seg) { return !seg.temp; });
  showSegment(0, false);
  setReadyState();
  subtitleEl.textContent = lesson.docId
    ? "Lesson complete. Press Start to watch it again, or open Contents to pick another section."
    : "Lesson complete. Press Start to watch it again.";
  statusEl.textContent = "Lesson complete";
  // quiz.js defines offerQuiz(); it shows the "Take the quiz" button
  if (typeof offerQuiz === "function") offerQuiz();
}


/* ---------------------------------------------------------
   8. PLAY / PAUSE
   Pause = stop the voice but REMEMBER the sentence (partIndex).
   Resume = continue from that same sentence.
   --------------------------------------------------------- */
function setReadyState() {
  btnPlay.textContent = "▶ Start";
  statusEl.textContent = "Ready to teach";
}

function togglePlay() {
  if (!lesson) return;
  if (checkOpen) { checkYes(); return; }      // Resume while the question is showing = "Yes, continue"

  if (isPlaying) {
    isPlaying = false;
    stopSpeaking();
    btnPlay.textContent = "▶ Resume";
    statusEl.textContent = "Paused";
  } else if (waitingForTopic) {
    // The next topic failed to load earlier: try again
    waitingForTopic = false;
    isPlaying = true;
    btnPlay.textContent = "\u275A\u275A Pause";
    advanceTopic();
  } else {
    // Browsers only allow sound after a tap, which is why we never auto-start.
    isPlaying = true;
    btnPlay.textContent = "❚❚ Pause";
    playCurrent(partIndex);
  }
}


/* ---------------------------------------------------------
   9. BUTTON EVENTS
   --------------------------------------------------------- */
btnPlay.addEventListener("click", togglePlay);

btnPrev.addEventListener("click", function () {
  goTo(current - 1);
});

btnNext.addEventListener("click", function () {
  goTo(current + 1);
});

btnRepeat.addEventListener("click", function () {
  if (!lesson) return;
  isPlaying = true;
  btnPlay.textContent = "❚❚ Pause";
  playCurrent(0);                       // this segment again from its first sentence
});

btnMute.addEventListener("click", function () {
  isMuted = !isMuted;
  btnMute.textContent = isMuted ? "Unmute" : "Mute";
  if (isPlaying) playCurrent(partIndex);   // restart the current sentence with the new volume
});

if (speedSelect) {
  speedSelect.addEventListener("change", function () {
    speechSpeed = Number(speedSelect.value) || 1;
    if (isPlaying) playCurrent(partIndex);   // restart the current sentence at the new speed
  });
}


/* ---------------------------------------------------------
   10. ASK THE LECTURER
   Flow: pause the voice -> send the question and what is being taught to
   the server (POST /api/ask) -> the server returns ONE new segment ->
   we insert it right after the current segment -> play it ->
   the lesson then carries on with the next original segment.
   mode: "ask" (typed question), "simpler", "example", "diagram"
   --------------------------------------------------------- */
let isAsking = false;   // true while we wait for the server, so a second click is ignored


/* ---------------------------------------------------------
   "Does that make sense?" - asked after every answer
   --------------------------------------------------------- */
const checkBarEl = document.getElementById("checkBar");
let checkOpen = false;

function speakOneLine(text, done) {
  if (!speechSupported || isMuted) { setTimeout(done, 900); return; }
  const u = new SpeechSynthesisUtterance(text);
  if (chosenVoice) { u.voice = chosenVoice; u.lang = chosenVoice.lang; } else u.lang = "en-GB";
  u.rate = 0.95 * speechSpeed;
  let fired = false;
  function once() { if (!fired) { fired = true; done(); } }
  u.onend = once; u.onerror = once;
  setTimeout(once, 6000);                 // safety: never get stuck
  window.speechSynthesis.speak(u);
}

function askUnderstanding() {
  if (!checkBarEl) { goTo(current + 1); return; }
  checkOpen = true;
  isPlaying = false;
  btnPlay.textContent = "\u25B6 Resume";
  statusEl.textContent = "Waiting for you";
  checkBarEl.hidden = false;                 // the question itself is only spoken; the buttons pop up at the side
  speakOneLine("Does that make sense?", function () {});
}

function closeCheck() {
  checkOpen = false;
  if (checkBarEl) checkBarEl.hidden = true;
}

function checkYes() {
  if (!checkOpen) return;
  closeCheck();
  stopSpeaking();
  speakOneLine("Great, let's continue with the lesson.", function () {
    isPlaying = true;
    btnPlay.textContent = "\u275A\u275A Pause";
    goTo(current + 1);
  });
}

function checkNo() {
  if (!checkOpen) return;
  closeCheck();
  stopSpeaking();
  askLecturer("simpler", "");
}

if (checkBarEl) {
  document.getElementById("checkYes").addEventListener("click", checkYes);
  document.getElementById("checkNo").addEventListener("click", checkNo);
}

async function askLecturer(mode, questionText, options) {
  options = options || {};
  if (!lesson || isAsking) return;
  isAsking = true;
  closeCheck();

  // Pause, but remember the sentence so Resume still works if the question fails
  isPlaying = false;
  stopSpeaking();
  btnPlay.textContent = "\u25B6 Resume";

  // What the lecturer was just saying, and a little of what came before it
  const now = lesson.segments[current];
  const before = lesson.segments.slice(Math.max(0, current - 3), current);
  const prefs = loadPrefs();

  const stopTimer = startWaitTimer(function (message) {
    subtitleEl.textContent = message;
    statusEl.textContent = "Thinking...";
  }, "The lecturer is thinking");

  try {
    const data = await postJson("/api/ask", {
      mode: mode,
      question: questionText || "",
      lessonTitle: lesson.title,
      nowTeaching: options.topic ? "Quiz topic: " + options.topic : now.board.heading + ". " + now.speech,
      recentlyTaught: before.map(function (seg) { return seg.speech; }).join(" "),
      docId: lesson.docId || "",
      sectionId: now.ref ? now.ref.sectionId : "",
      scope: now.ref ? now.ref.scope : "own",
      part: now.ref ? now.ref.part : 0,
      level: prefs.level,
      difficulty: prefs.difficulty
    });

    // Put the answer right after the current segment, then play it
    if (mode === "ask") data.segment.board.tag = "Your question";
    if (mode === "reteach") data.segment.board.tag = "Let's try again";
    if (options.endAfter) {            // used by the quiz: play it, then stop the lesson
      data.segment.temp = true;
      data.segment.endsLesson = true;
    }
    if (!options.endAfter) data.segment.checkAfter = true;   // after the answer: "Does that make sense?"
    data.segment.topic = now.topic;                // the answer belongs to the topic being taught
    data.segment.topicIndex = now.topicIndex;
    data.segment.ref = now.ref;
    lesson.segments.splice(current + 1, 0, data.segment);
    isPlaying = true;
    btnPlay.textContent = "\u275A\u275A Pause";
    showSegment(current + 1, true);
  } catch (error) {
    console.error(error);
    subtitleEl.textContent = error.message + " Press Resume to continue the lesson.";
    statusEl.textContent = "Paused";
  } finally {
    stopTimer();
    isAsking = false;
  }
}

askForm.addEventListener("submit", function (event) {
  event.preventDefault();
  const question = askInput.value.trim();
  if (question === "") return;
  askInput.value = "";
  askLecturer("ask", question);
});

/* ---------------------------------------------------------
   SPEAK YOUR QUESTION (free: the browser's built-in speech recognition)
   Tap the mic, talk, and your words appear in the question box. Nothing is sent until you press Ask,
   so you can correct any word the computer got wrong. Works in Chrome and Edge (needs internet);
   on browsers that cannot do it, the mic button is hidden.
   --------------------------------------------------------- */
const btnMic = document.getElementById("btnMic");
const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition;
const normalPlaceholder = askInput.placeholder;
let recognizer = null;
let listening = false;

function micMessage(text) {
  askInput.placeholder = text;
  setTimeout(function () { if (!listening) askInput.placeholder = normalPlaceholder; }, 4000);
}

function stopListening() {
  if (recognizer) { try { recognizer.stop(); } catch (error) { /* already stopped */ } }
}

function startListening() {
  // The lecturer must be quiet, or the microphone would hear him instead of you
  if (isPlaying) togglePlay();

  const startText = askInput.value.trim();
  recognizer = new SpeechRecognitionClass();
  recognizer.lang = "en-NG";
  recognizer.interimResults = true;
  recognizer.continuous = false;

  recognizer.onstart = function () {
    listening = true;
    btnMic.classList.add("is-listening");
    btnMic.setAttribute("aria-label", "Stop listening");
    askInput.placeholder = "Listening... speak now";
  };

  recognizer.onresult = function (event) {
    let heard = "";
    for (let i = 0; i < event.results.length; i++) heard += event.results[i][0].transcript;
    askInput.value = (startText ? startText + " " : "") + heard.trim();
  };

  recognizer.onerror = function (event) {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      micMessage("The microphone is blocked. Allow it for this site in your browser, then try again.");
    } else if (event.error === "no-speech") {
      micMessage("I did not hear anything. Tap the mic and try again.");
    } else if (event.error === "network") {
      micMessage("Voice typing needs the internet. Check your connection.");
    } else if (event.error !== "aborted") {
      micMessage("Voice typing did not work. You can still type your question.");
    }
  };

  recognizer.onend = function () {
    listening = false;
    btnMic.classList.remove("is-listening");
    btnMic.setAttribute("aria-label", "Speak your question");
    if (askInput.placeholder === "Listening... speak now") askInput.placeholder = normalPlaceholder;
    askInput.focus();                 // the text is ready to read, fix and send
  };

  try { recognizer.start(); } catch (error) { micMessage("Voice typing could not start. Try again."); }
}

if (!SpeechRecognitionClass) {
  btnMic.hidden = true;
} else {
  btnMic.addEventListener("click", function () {
    if (listening) stopListening(); else startListening();
  });
}

// The quick buttons. Each one is marked in the HTML with data-mode="simpler" etc.
chips.forEach(function (chip) {
  chip.addEventListener("click", function () {
    if (!lesson) return;
    if (chip.id === "btnQuiz") return;          // the "Quiz me" button is handled by quiz.js
    if (chip.classList.contains("chip-end")) {
      finishLesson();
    } else {
      askLecturer(chip.dataset.mode || "ask", chip.dataset.mode ? "" : chip.textContent);
    }
  });
});


/* ---------------------------------------------------------
   LESSON SETTINGS (the gear): speed, voice, mute, repeat
   --------------------------------------------------------- */
const gearBtn = document.getElementById("btnGear");
const sheetEl = document.getElementById("settingsSheet");
function setSheet(open) {
  if (!sheetEl) return;
  sheetEl.hidden = !open;
  if (gearBtn) gearBtn.setAttribute("aria-expanded", open ? "true" : "false");
}
if (gearBtn && sheetEl) {
  gearBtn.addEventListener("click", function () { setSheet(sheetEl.hidden); });
  document.getElementById("sheetClose").addEventListener("click", function () { setSheet(false); });
  sheetEl.addEventListener("click", function (e) { if (e.target === sheetEl) setSheet(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setSheet(false); });
}

/* ---------------------------------------------------------
   11. START
   --------------------------------------------------------- */
loadLesson();



/* ---------------------------------------------------------
   HIDE / SHOW THE CONTROLS
   - The small arrow tab hides the controls so the classroom gets more room (remembered on this device).
   - On a computer the controls start hidden and slide up when the mouse goes near the bottom of the window.
   - On a phone they start visible; tap the tab to hide them, tap again to bring them back.
   --------------------------------------------------------- */
(function setupHideControls() {
  const controlsEl = document.getElementById("controls");
  const toggleEl = document.getElementById("ctrlToggle");
  const topbarEl = document.querySelector(".topbar");
  if (!controlsEl || !toggleEl) return;

  // The picture needs to know how tall the top bar is
  function measureTopbar() {
    if (topbarEl) document.documentElement.style.setProperty("--topbar-h", topbarEl.offsetHeight + "px");
  }
  measureTopbar();
  window.addEventListener("resize", measureTopbar);

  const bigScreen = window.matchMedia("(min-width: 800px) and (hover: hover)").matches;
  let saved = null;
  try { saved = localStorage.getItem("controlsHidden"); } catch (e) { /* fine */ }
  let hidden = saved === null ? bigScreen : saved === "1";

  function apply() {
    document.body.classList.toggle("controls-hidden", hidden);
    toggleEl.setAttribute("aria-expanded", hidden ? "false" : "true");
    toggleEl.setAttribute("aria-label", hidden ? "Show controls" : "Hide controls");
    if (!hidden) controlsEl.classList.remove("is-open");
    measureTopbar();
  }
  apply();

  toggleEl.addEventListener("click", function () {
    if (hidden && !controlsEl.classList.contains("is-open") && bigScreen) {
      controlsEl.classList.add("is-open");        // on a computer the first click just opens it
      return;
    }
    hidden = !hidden;
    try { localStorage.setItem("controlsHidden", hidden ? "1" : "0"); } catch (e) { /* fine */ }
    apply();
    if (hidden) controlsEl.classList.remove("is-open");
  });

  // Computer: mouse near the bottom brings the controls up; moving away hides them again
  document.addEventListener("mousemove", function (event) {
    if (!hidden) return;
    const typing = controlsEl.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    const sheetOpen = sheetEl && !sheetEl.hidden;
    if (event.clientY > window.innerHeight - 70) controlsEl.classList.add("is-open");
    else if (!typing && !sheetOpen && !controlsEl.matches(":hover")) controlsEl.classList.remove("is-open");
  });
})();
