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

let mouthTimer = null;
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

    lessonTitleEl.textContent = lesson.title;
    if (lesson.docName) topbarLabelEl.textContent = lesson.docName;

    // Lessons made from an uploaded document can go back to the contents
    if (lesson.docId) {
      contentsLinkEl.href = "outline.html?doc=" + encodeURIComponent(lesson.docId);
      contentsLinkEl.hidden = false;
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

  let sourceLabel = "Extra explanation";
  let sourceClass = "board-source";
  if (segment.quote) {
    sourceLabel = "Exact wording from your material";
    sourceClass += " is-exact";
  } else if (segment.source === "document") {
    sourceLabel = "Based on your material";
  }
  top.append(makeEl("span", sourceClass, sourceLabel));
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

  // The exact excerpt (the server already checked it word for word)
  if (segment.quote) {
    const box = makeEl("div", "board-quote");
    box.append(makeEl("span", "board-quote-label", "From your material"));
    box.append(document.createTextNode("“" + segment.quote + "”"));
    boardContentEl.append(box);
  }
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

  function score(v) {
    let points = 0;
    if (v.localService) points += 10;                    // stored on this computer
    const lang = v.lang.toLowerCase().replace("_", "-");
    if (lang === "en-gb" || lang === "en-ng") points += 3;
    else if (lang === "en-us") points += 2;
    if (/natural|online/i.test(v.name)) points -= 5;     // online voices lag
    return points;
  }
  english.sort(function (a, b) { return score(b) - score(a); });
  return english[0];
}

if (speechSupported) {
  chosenVoice = pickVoice();
  // Chrome loads its voice list a moment after the page opens
  window.speechSynthesis.onvoiceschanged = function () { chosenVoice = pickVoice(); };
}


/* ---------------------------------------------------------
   6. SPEAKING
   --------------------------------------------------------- */

// Cuts the text of a segment into sentences. If the segment has an exact quote,
// the lecturer reads it out first.
function splitIntoParts(segment) {
  let text = "";
  if (segment.quote) {
    text += "Your material says: " + segment.quote.replace(/[.!?\s]+$/, "") + ". ";
  }
  text += segment.speech;
  const pieces = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) || [text];
  return pieces.map(function (p) { return p.trim(); }).filter(Boolean);
}

// Stops everything: voice, timers, and any pending start.
function stopSpeaking() {
  speakToken++;                         // makes all old voice events "stale"
  clearTimeout(startTimer);
  clearTimeout(startCheckTimer);
  clearTimeout(watchdogTimer);
  if (speechSupported) window.speechSynthesis.cancel();
  setSpeaking(false);
}

// Green dot, status text and the moving mouth
function setSpeaking(isSpeaking) {
  speakingDotEl.classList.toggle("is-speaking", isSpeaking);

  if (isSpeaking) {
    statusEl.textContent = "Speaking...";
    clearInterval(mouthTimer);
    // The mouth opens by a random amount each time, which looks more like real speech than a flap
    mouthTimer = setInterval(function () {
      const opening = 3 + Math.random() * 9;       // between 3 (closed) and 12 (wide)
      mouthEl.setAttribute("ry", opening.toFixed(1));
    }, 120);
  } else {
    clearInterval(mouthTimer);
    mouthEl.setAttribute("ry", "3");
    statusEl.textContent = isPlaying ? "Teaching" : "Paused";
  }
}

// Start (or restart) speaking the current segment from a given sentence.
function playCurrent(fromPart) {
  if (!speechSupported) {
    statusEl.textContent = "This browser cannot speak. Use Chrome or Edge.";
    return;
  }

  parts = splitIntoParts(lesson.segments[current]);
  partIndex = Math.min(Math.max(fromPart || 0, 0), parts.length - 1);

  const synth = window.speechSynthesis;
  const wasBusy = synth.speaking || synth.pending;

  stopSpeaking();
  const myToken = speakToken;           // the number of THIS run
  statusEl.textContent = "Starting...";  // instant feedback, so the button never feels dead

  // If something was speaking, wait a moment after cancel() before speaking again
  startTimer = setTimeout(function () {
    if (myToken !== speakToken) return;
    speakPart(myToken, false);
  }, wasBusy ? 150 : 0);
}

// Speaks ONE sentence (parts[partIndex]); when it ends, speaks the next one.
function speakPart(token, isRetry) {
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
        // A quiz re-teach segment ends the lesson when it is done; otherwise go to the next segment
        if (lesson.segments[current].endsLesson) {
          finishLesson();
        } else {
          goTo(current + 1);              // whole segment spoken: next segment
        }
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

  progressFillEl.style.width = ((current + 1) / total) * 100 + "%";
  progressTextEl.textContent = "Section " + (current + 1) + " of " + total;

  if (shouldSpeak) playCurrent(0);
}

function goTo(index) {
  if (!lesson) return;
  if (index < 0) index = 0;

  if (index >= lesson.segments.length) {
    finishLesson();
    return;
  }
  showSegment(index, isPlaying);
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

  if (isPlaying) {
    isPlaying = false;
    stopSpeaking();
    btnPlay.textContent = "▶ Resume";
    statusEl.textContent = "Paused";
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

async function askLecturer(mode, questionText, options) {
  options = options || {};
  if (!lesson || isAsking) return;
  isAsking = true;

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
      sectionId: lesson.sectionId || "",
      scope: lesson.scope || "own",
      part: lesson.part || 0,
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
   11. START
   --------------------------------------------------------- */
loadLesson();