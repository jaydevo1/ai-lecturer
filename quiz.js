/* =========================================================
   QUIZ  (quiz.js)

   What this file does:
   1. "Quiz me" (or the end of the lesson) asks the server for questions
      (POST /api/quiz). Only making the quiz uses a Gemini request.
   2. Shows one question at a time. Marking is done HERE in the browser,
      so it is instant and free.
   3. At the end: score, the questions you missed with the right answer,
      and a "Teach this differently" button for each missed topic
      (that one uses the lecturer: POST /api/ask with mode "reteach").
   4. "Try new questions" makes a fresh quiz.

   This file is loaded AFTER player.js, so it can use these things from it:
   lesson, current, isPlaying, stopSpeaking, btnPlay, subtitleEl, statusEl,
   askLecturer(), and from common.js: postJson, startWaitTimer, loadPrefs.
   ========================================================= */

const quizPanelEl    = document.getElementById("quizPanel");
const quizCountEl    = document.getElementById("quizCount");
const quizQuestionEl = document.getElementById("quizQuestion");
const quizOptionsEl  = document.getElementById("quizOptions");
const quizFeedbackEl = document.getElementById("quizFeedback");
const quizActionsEl  = document.getElementById("quizActions");
const btnQuiz        = document.getElementById("btnQuiz");

let quizQuestions = [];   // the questions of this quiz
let quizIndex = 0;        // which question we are on
let quizScore = 0;        // right answers so far
let quizMissed = [];      // the ones answered wrongly: { question, chosen }
let quizRound = 0;        // goes up on each retake, so the AI writes different questions
let quizBusy = false;     // true while waiting for the server


/* ---------- small helpers ---------- */
function quizEl(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function quizButton(label, className, onClick) {
  const button = quizEl("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function closeQuiz() {
  quizPanelEl.hidden = true;
}


/* ---------- called by player.js when the lesson ends ---------- */
function offerQuiz() {
  subtitleEl.textContent += " Tap “Quiz me” to test yourself.";
  btnQuiz.classList.add("is-highlight");
}


/* ---------- which topics have been taught so far ---------- */
function taughtSections() {
  if (playlist) {
    return playlist.entries.slice(0, playlist.index + 1).map(function (entry) {
      return { sectionId: entry.sectionId, part: entry.part };
    });
  }
  return lesson.sectionId ? [{ sectionId: lesson.sectionId, part: lesson.part || 0, scope: lesson.scope || "own" }] : [];
}


/* ---------- 1. get the questions ---------- */
async function startQuiz(round) {
  if (!lesson || quizBusy) return;
  quizBusy = true;
  quizRound = round;

  // Pause the lecturer while the learner does the quiz
  isPlaying = false;
  stopSpeaking();
  btnPlay.textContent = "▶ Resume";
  btnQuiz.classList.remove("is-highlight");

  // What was taught (used when the lesson has no uploaded document behind it)
  const taught = lesson.segments
    .filter(function (seg) { return !seg.temp; })
    .map(function (seg) { return seg.board.heading + ". " + seg.speech; })
    .join("\n");

  const prefs = loadPrefs();
  const stopTimer = startWaitTimer(function (message) {
    subtitleEl.textContent = message;
    statusEl.textContent = "Preparing quiz...";
  }, "Writing your quiz");

  try {
    const data = await postJson("/api/quiz", {
      lessonTitle: playlist && playlist.label ? playlist.label : lesson.title,
      lessonText: taught,
      docId: lesson.docId || "",
      // every topic taught so far (a unit is several topics), so the quiz covers what was just taught
      sections: taughtSections(),
      level: prefs.level,
      difficulty: prefs.difficulty,
      approach: prefs.approach,
      round: round
    });

    quizQuestions = data.questions;
    quizIndex = 0;
    quizScore = 0;
    quizMissed = [];
    subtitleEl.textContent = "Quiz time. Choose the best answer for each question.";
    statusEl.textContent = "Quiz";
    quizPanelEl.hidden = false;
    showQuestion();
  } catch (error) {
    console.error(error);
    subtitleEl.textContent = error.message;
    statusEl.textContent = "Paused";
  } finally {
    stopTimer();
    quizBusy = false;
  }
}


/* ---------- 2. one question ---------- */
function showQuestion() {
  const q = quizQuestions[quizIndex];

  quizCountEl.textContent = "Question " + (quizIndex + 1) + " of " + quizQuestions.length;
  quizQuestionEl.textContent = q.question;
  quizOptionsEl.replaceChildren();
  quizFeedbackEl.hidden = true;
  quizActionsEl.replaceChildren(quizButton("Close quiz", "btn btn-quiet", closeQuiz));

  q.options.forEach(function (optionText, index) {
    const button = quizEl("button", "quiz-option", optionText);
    button.type = "button";
    button.addEventListener("click", function () { answerQuestion(index); });
    quizOptionsEl.append(button);
  });
}

// The learner picked an option
function answerQuestion(chosenIndex) {
  const q = quizQuestions[quizIndex];
  const buttons = quizOptionsEl.querySelectorAll(".quiz-option");
  const isRight = chosenIndex === q.correctIndex;

  // Lock all options and colour them
  buttons.forEach(function (button, index) {
    button.disabled = true;
    if (index === q.correctIndex) button.classList.add("is-correct");
    if (index === chosenIndex && !isRight) button.classList.add("is-wrong");
  });

  if (isRight) {
    quizScore++;
  } else {
    quizMissed.push({ question: q, chosen: q.options[chosenIndex] });
  }

  quizFeedbackEl.hidden = false;
  quizFeedbackEl.className = "quiz-feedback " + (isRight ? "is-correct" : "is-wrong");
  quizFeedbackEl.textContent =
    (isRight ? "Correct! " : "Not quite. The answer is: " + q.options[q.correctIndex] + ". ") + q.explanation;

  const isLast = quizIndex === quizQuestions.length - 1;
  quizActionsEl.replaceChildren(
    quizButton(isLast ? "See my score" : "Next question", "btn btn-primary", function () {
      if (isLast) {
        showResults();
      } else {
        quizIndex++;
        showQuestion();
      }
    }),
    quizButton("Close quiz", "btn btn-quiet", closeQuiz)
  );
}


/* ---------- 3. the score ---------- */
function showResults() {
  const total = quizQuestions.length;
  const percent = Math.round((quizScore / total) * 100);

  quizCountEl.textContent = "Your score";
  quizQuestionEl.textContent = quizScore + " out of " + total + " (" + percent + "%)";
  quizOptionsEl.replaceChildren();

  let message = "Good start. Let us go over the ones you missed.";
  if (percent === 100) message = "Perfect. You understood this lesson well.";
  else if (percent >= 70) message = "Well done. Check the few you missed below.";
  quizFeedbackEl.hidden = false;
  quizFeedbackEl.className = "quiz-feedback";
  quizFeedbackEl.textContent = message;

  // The missed questions, each with the right answer and a re-teach button
  quizMissed.forEach(function (item) {
    const box = quizEl("div", "quiz-missed");
    box.append(quizEl("p", "quiz-missed-q", item.question.question));
    box.append(quizEl("p", "quiz-missed-a",
      "Right answer: " + item.question.options[item.question.correctIndex]));
    box.append(quizButton("Teach this differently", "btn", function () {
      reteachMissed(item);
    }));
    quizOptionsEl.append(box);
  });

  quizActionsEl.replaceChildren(
    quizButton("Try new questions", "btn btn-primary", function () {
      closeQuiz();
      startQuiz(quizRound + 1);
    }),
    quizButton("Close quiz", "btn btn-quiet", closeQuiz)
  );
}


/* ---------- 4. re-teach a missed question ---------- */
function reteachMissed(item) {
  const q = item.question;
  closeQuiz();
  askLecturer(
    "reteach",
    'Quiz question: "' + q.question + '" The learner chose: "' + item.chosen +
      '". The correct answer is: "' + q.options[q.correctIndex] + '". Explanation: ' + q.explanation,
    { topic: q.topic || q.question, endAfter: true }
  );
}


/* ---------- button ---------- */
btnQuiz.addEventListener("click", function () {
  startQuiz(0);
});
