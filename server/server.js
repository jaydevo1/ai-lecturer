/* =========================================================
   AI LECTURER SERVER  (version 3)

   WHAT IS NEW IN VERSION 3?
   1. UPLOAD: you can upload a PDF or photos of pages. The server
      reads the text, finds the headings and builds a CONTENTS
      OUTLINE (modules > units > sections) that you can click.
   2. TEACH ONE SECTION AT A TIME: tap a section and only that part
      is turned into a lesson (faster, and kinder to the free limit).
   3. EXAM MODE: the AI must copy an exact excerpt from your material
      for each part of the lesson. The server then CHECKS word by word
      that the excerpt really exists in your text. If the AI changed
      even one word, the excerpt is thrown away and never shown as exact.
   4. Longer parts: each spoken part is a little longer, so there are
      fewer pauses between parts.
   Kept from version 2: time limits, retries, backup models, saved
   lessons (cache), /api/models.
   ========================================================= */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Read server/.env if it exists. On a hosting site there is no .env file;
// the settings are typed into the site's dashboard instead, and those win.
try { process.loadEnvFile(path.join(__dirname, ".env")); } catch (error) { /* no .env file: fine */ }


/* ---------------------------------------------------------
   1. SETTINGS (most can be changed in server/.env)
   --------------------------------------------------------- */
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const BASE_URL = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";

// Main model first, then backups tried in order (comma separated in .env)
const MODEL = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || "")
  .split(",").map(function (n) { return n.trim(); }).filter(Boolean);
const MODEL_LIST = [MODEL].concat(FALLBACK_MODELS.filter(function (n) { return n !== MODEL; }));

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;     // one try
const TOTAL_MS = Number(process.env.GEMINI_TOTAL_MS) || 150000;        // all tries for one request
const BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_MS) || 2000;
const TRIES_PER_MODEL = 2;
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || "").trim();  // optional, e.g. "low"

const MAX_TEXT_LENGTH = 15000;          // longest text you can paste
const SECTION_CHAR_LIMIT = 12000;       // longest piece of text turned into ONE lesson
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;   // all uploaded files together
const MAX_PDF_PAGES = 600;
const MAX_IMAGES = 6;

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "cache");   // saved lessons
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "docs");      // uploaded documents

// Change this word when the teaching prompt changes, so old saved lessons are not reused
const PROMPT_VERSION = "v4";

// Online use: a secret code that friends must type, and a daily limit per person,
// so nobody can use up the free Gemini allowance. If ACCESS_CODE is empty (your own computer), the code is not asked.
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT) || 60;
// 127.0.0.1 = only this computer. Render sets the RENDER variable, and then we must listen to the whole internet.
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "http://127.0.0.1:5500,http://localhost:5500")
  .split(",").map(function (o) { return o.trim(); }).filter(Boolean);

if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY. Put it in server/.env and save the file (Ctrl+S).");
  process.exit(1);
}


/* ---------------------------------------------------------
   2. CREATE THE APP
   --------------------------------------------------------- */
const app = express();
app.set("trust proxy", 1);            // behind Render's front door, so req.ip is the real visitor
app.use(cors({ origin: CORS_ORIGINS }));
// Uploaded files travel as base64 text inside JSON, which is about 33% bigger than the file
app.use(express.json({ limit: "25mb" }));

// ---- Gate 1: the access code (every /api route except /api/health) ----
app.use("/api", function (req, res, next) {
  if (!ACCESS_CODE || req.path === "/health" || req.method === "OPTIONS") return next();
  const given = Buffer.from(String(req.get("x-access-code") || ""));
  const wanted = Buffer.from(ACCESS_CODE);
  // timingSafeEqual compares without leaking how many letters were right
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    return res.status(401).json({ error: "Wrong or missing access code.", needCode: true });
  }
  next();
});

// ---- Gate 2: a daily limit per visitor on the routes that use Gemini ----
const usageToday = new Map();   // visitor address -> { day, count }
app.use(["/api/lesson", "/api/ask", "/api/quiz", "/api/upload"], function (req, res, next) {
  if (req.method !== "POST") return next();
  const day = new Date().toISOString().slice(0, 10);
  if (usageToday.size > 2000) usageToday.clear();             // keep memory small
  let use = usageToday.get(req.ip);
  if (!use || use.day !== day) { use = { day: day, count: 0 }; usageToday.set(req.ip, use); }
  if (use.count >= DAILY_LIMIT) {
    return res.status(429).json({ error: "You have reached today's limit of " + DAILY_LIMIT + " requests. Come back tomorrow." });
  }
  use.count++;
  next();
});


/* ---------------------------------------------------------
   3. THE SHAPES OF DATA WE ASK GEMINI FOR
   --------------------------------------------------------- */
const LESSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    segments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          speech:   { type: "STRING" },
          subtitle: { type: "STRING" },
          source:   { type: "STRING", enum: ["document", "added"] },
          quote:    { type: "STRING" },    // exact excerpt copied from the material
          board: {
            type: "OBJECT",
            properties: {
              type:      { type: "STRING", enum: ["title", "definition", "diagram", "list"] },
              tag:       { type: "STRING" },
              heading:   { type: "STRING" },
              text:      { type: "STRING" },
              root:      { type: "STRING" },
              children:  { type: "ARRAY", items: { type: "STRING" } },
              highlight: { type: "INTEGER" },
              items:     { type: "ARRAY", items: { type: "STRING" } }
            },
            required: ["type", "tag", "heading"]
          }
        },
        required: ["speech", "subtitle", "source", "board"]
      }
    }
  },
  required: ["title", "segments"]
};

const OUTLINE_SCHEMA = {
  type: "OBJECT",
  properties: {
    courseTitle: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id:    { type: "INTEGER" },
          kind:  { type: "STRING", enum: ["module", "unit", "topic", "merge"] },
          title: { type: "STRING" }
        },
        required: ["id", "kind", "title"]
      }
    }
  },
  required: ["courseTitle", "items"]
};


/* ---------------------------------------------------------
   4. THE PROMPTS (this is where we control HOW the AI behaves)
   --------------------------------------------------------- */
const TEACHING_PROMPT = `
You are an excellent, patient university lecturer. You TEACH the learner's study material so they truly understand it. You never just read it or summarise it.

Build a lesson with the number of segments stated in the request.

For EVERY important concept in the material, teach it across several segments in this order:
1. Introduce the idea and say why it matters.
2. Give the definition in simple words, then explain it in plain language.
3. Give a concrete worked example, step by step. Where it fits, use everyday situations a Nigerian student knows (markets, transport, school, phones).
4. Give an analogy, or warn about a common mistake.
5. Ask the learner a short question to think about, then answer it.

Never rush. Never say "and so on". Explain WHY, not only WHAT. If the material lists steps or items, walk through each one.
Match depth and vocabulary to the learner's level and teaching difficulty: "Very simple" means short words and many analogies; "Detailed" or "Advanced" means precise terms and deeper reasoning.

Each segment has:
- "speech": what you say out loud. 3 to 5 sentences, 45 to 80 words. Natural spoken English, no bullet points, no symbols that are hard to say aloud.
- "subtitle": a very short version of the point (under 12 words).
- "source": "document" if the content comes directly from the material, "added" if it is your own explanation, analogy or example. Never present your additions as if the document said them. Do not invent facts about the course.
- "quote": (optional) see the quote rules. Leave it as an empty string when it does not apply.
- "board": what appears on the board while you speak. Choose one type:
    "title": opening or section title. Fields: tag, heading, text.
    "definition": a key term. Fields: tag (use "Definition"), heading (the term), text (the definition in one short line).
    "diagram": a simple tree. Fields: tag, heading, root (parent box), children (2 to 4 short labels), highlight (index of the child you are explaining, or -1).
    "list": steps or a recap. Fields: tag, heading, items (2 to 5 short lines).

Open and close the lesson exactly as the LESSON POSITION RULES in the request say.
Use the diagram "highlight" across consecutive segments so the board follows what you explain.
Keep every board line short.
`;

const EXAM_RULES = `
EXAM MODE (very important). This learner is preparing for an exam that rewards the EXACT wording of the course material.
- Never rename, simplify or swap the material's terms. Use the material's own words and spellings for every term, definition, list item and step.
- QUOTE RULES: for every segment whose source is "document", set "quote" to ONE excerpt copied CHARACTER FOR CHARACTER from the material (1 to 3 sentences, at most 60 words). Do not fix spelling, do not change any word, do not join sentences from different places. If you cannot copy it exactly, leave "quote" as an empty string.
- In "speech", introduce the idea briefly and then explain it in simple words. Do NOT repeat the quote inside "speech", because the quote is shown and read out separately.
- Keep the order of the material. Cover EVERY definition, list, type, advantage, disadvantage, step and example in the material. Do not skip points.
- The board "heading", "text" and "items" for document segments must use the material's exact wording as well.
- Any goals or recap segment that comes from the document must use the material's exact wording too.
`;

function buildSystemInstruction(approach) {
  return approach === "exam" ? TEACHING_PROMPT + EXAM_RULES : TEACHING_PROMPT;
}

// Short text gets a shorter lesson (faster). Exam mode needs more segments to cover everything.
function segmentRange(textLength, approach) {
  if (approach === "exam") {
    if (textLength < 1200) return "8 to 12";
    if (textLength < 4000) return "14 to 20";
    return "18 to 26";
  }
  if (textLength < 1200) return "8 to 12";
  if (textLength < 4000) return "12 to 18";
  return "16 to 24";
}

// Tells the AI how to open and close THIS lesson. A unit is taught as several lessons in a row
// (one per topic), so only the first one welcomes the learner and only the last one recaps.
function positionRules(position) {
  const first = position === "first" || position === "only";
  const last = position === "last" || position === "only";
  let r = "LESSON POSITION RULES (these override any other rule about openings and endings):\n";
  if (first) {
    r += '- Open with ONE short segment of 2 to 3 spoken lines that introduces what we are studying (use the INTRODUCTION text if it is given). Then ONE goals segment: board type "list", tag "Goals", heading "What you will learn", items = the learning goals this lesson covers. Use the LEARNING OUTCOMES text if it is given, keeping its wording and listing only the outcomes that match this lesson. If none are given, write 3 short goals yourself and mark the segment source "added".\n';
  } else {
    r += "- This lesson continues a unit that is already in progress. Do NOT welcome the learner and do NOT introduce the course again. Begin with one short sentence that names the new topic, then teach it.\n";
  }
  if (last) {
    r += '- Finish with ONE recap segment: board type "list", tag "Recap", heading "Recap", 2 to 5 items. Base it on the SUMMARY text if it is given (use only the parts that relate to what was taught). If there is no summary, write the recap yourself and mark source "added".\n';
  } else {
    r += "- More topics follow this one. Do NOT end with a recap or a goodbye. Finish the topic and stop.\n";
  }
  return r;
}

function buildLessonPrompt(text, level, difficulty, approach, docName, sectionTitle, position, extras) {
  position = position || "only";
  extras = extras || {};
  let context = "";
  if (docName) context += "Document: " + docName + "\n";
  if (sectionTitle) context += "Topic being taught: " + sectionTitle + "\n";

  const first = position === "first" || position === "only";
  const last = position === "last" || position === "only";
  let extra = "";
  if (first && extras.intro)    extra += 'INTRODUCTION text from the material:\n"""\n' + extras.intro + '\n"""\n\n';
  if (first && extras.outcomes) extra += 'LEARNING OUTCOMES text from the material:\n"""\n' + extras.outcomes + '\n"""\n\n';
  if (last && extras.summary)   extra += 'SUMMARY text from the material:\n"""\n' + extras.summary + '\n"""\n\n';

  return `
Learner's educational level: ${level}
Teaching difficulty: ${difficulty}
${context}Number of teaching segments for the topic itself: ${segmentRange(text.length, approach)} (the opening, goals and recap segments described below are extra)

${positionRules(position)}
${extra}Study material for the topic:
"""
${text}
"""
`;
}

const OUTLINE_PROMPT = `
You organise a course document into a clean table of contents: Module, then Unit, then main teaching topics.
You receive a numbered list of lines that MAY be headings, each written as: id | page | text.
For each line you want to keep, give its kind:
- "module": a top-level block that contains several units (for example "MODULE 1: ...").
- "unit": a unit or chapter inside a module (for example "Unit 2: Coulomb's Law ...").
- "topic": a MAIN teaching topic inside a unit. Usually a numbered section such as "1.2 Electric Charge and Their Properties". Only the main topics, one per concept the learner must study.
- "merge": a real heading that is only a detail of the topic above it (a sub-sub-heading such as 1.2.1, a worked example, a formula, a "Case study", a figure caption). These will be folded into the topic above.
Leave out (do not return) anything that is not a heading: running page headers and footers, table rows, list items, ordinary sentences.
If the document has no modules, use only "unit" and "topic". If it has only chapters, use "unit" for chapters and "topic" for their sections.
A contents page at the start may list the same headings again. Return them as they appear; duplicates are removed later.
Keep the ids in their original order. Keep titles as written but tidy (no page numbers, at most 90 characters).
Also return courseTitle: the course or document title if you can see it, otherwise an empty string.
`;

const TRANSCRIBE_PROMPT = `
Transcribe ALL the text in these page images exactly as written. Keep headings, numbering and line breaks. Do not summarise, correct, translate or add comments.
Start each page with a line "=== PAGE n ===" where n is the image number (1 for the first image). If a page has no readable text, write "[no readable text]" under its marker.
`;


/* ---------------------------------------------------------
   5. TALKING TO GEMINI (one attempt)
   request = { systemText, parts, schema (optional), temperature }
   - with a schema we get a JS object back
   - without a schema we get plain text back
   Errors carry labels the retry logic uses:
     error.status = HTTP number (503, 429 ...)   error.kind = "timeout" | "network" | "badjson" | "blocked"
   --------------------------------------------------------- */
function makeNetworkError(err) {
  const isTimeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
  const reason = isTimeout
    ? "no answer within " + Math.round(TIMEOUT_MS / 1000) + " seconds"
    : "network problem (" + ((err && err.cause && err.cause.code) || (err && err.message) || "unknown") + ")";
  const error = new Error(reason);
  error.kind = isTimeout ? "timeout" : "network";
  return error;
}

async function callGemini(model, request, useThinking) {
  const url = BASE_URL + "/models/" + model + ":generateContent";

  const generationConfig = { temperature: request.temperature === undefined ? 0.6 : request.temperature };
  if (request.schema) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = request.schema;
  }
  if (useThinking && THINKING_LEVEL) {
    generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
  }

  const body = {
    contents: [{ role: "user", parts: request.parts }],
    generationConfig: generationConfig
  };
  if (request.systemText) {
    body.systemInstruction = { parts: [{ text: request.systemText }] };
  }

  let bodyText;
  let httpStatus;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    httpStatus = response.status;
    bodyText = await response.text();
  } catch (err) {
    throw makeNetworkError(err);
  }

  if (httpStatus < 200 || httpStatus >= 300) {
    const error = new Error("HTTP " + httpStatus);
    error.status = httpStatus;
    error.details = bodyText.slice(0, 800);
    throw error;
  }

  let answerText = "";
  try {
    const data = JSON.parse(bodyText);
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    answerText = parts.map(function (p) { return p.text || ""; }).join("");
  } catch (err) {
    const error = new Error("Google sent something that is not JSON");
    error.kind = "badjson";
    throw error;
  }

  if (!answerText) {
    const error = new Error("Google returned an empty answer (it may have been blocked)");
    error.kind = "blocked";
    throw error;
  }

  if (!request.schema) return answerText;   // plain text answer

  try {
    return JSON.parse(answerText);
  } catch (err) {
    const error = new Error("the answer came back cut off or broken");
    error.kind = "badjson";
    throw error;
  }
}


/* ---------------------------------------------------------
   6. RETRIES AND BACKUP MODELS
     "fatal" = our fault (wrong key, bad request): stop.
     "skip"  = this model is not usable now (429 out of free requests, 404 gone): next model.
     "retry" = temporary (503 busy, timeout, network, broken answer): try again after a wait.
   --------------------------------------------------------- */
function classify(error) {
  if (error.status === 400 || error.status === 401 || error.status === 403) return "fatal";
  if (error.status === 404 || error.status === 429) return "skip";
  if (error.status >= 500) return "retry";
  if (error.kind === "timeout" || error.kind === "network" || error.kind === "badjson" || error.kind === "blocked") return "retry";
  return "skip";
}

function describe(error) {
  if (error.status) {
    let googleText = "";
    try { googleText = JSON.parse(error.details).error.message || ""; } catch (e) { googleText = ""; }
    return "HTTP " + error.status + (googleText ? " - " + googleText.slice(0, 110) : "");
  }
  return error.message;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function runWithFallback(request) {
  const startedAt = Date.now();
  const failures = [];
  let lastError = null;

  for (const model of MODEL_LIST) {
    let thinkingOn = Boolean(THINKING_LEVEL);

    for (let attempt = 1; attempt <= TRIES_PER_MODEL; attempt++) {
      if (Date.now() - startedAt > TOTAL_MS) {
        lastError.failures = failures;
        throw lastError;
      }

      try {
        console.log("[" + model + "] try " + attempt + "/" + TRIES_PER_MODEL + " ...");
        const result = await callGemini(model, request, thinkingOn);
        return { result: result, model: model };
      } catch (error) {
        lastError = error;

        if (error.status === 400 && thinkingOn) {
          console.log("[" + model + "] does not accept the thinking setting, trying without it");
          thinkingOn = false;
          attempt--;
          continue;
        }

        failures.push({ model: model, status: error.status || null, kind: error.kind || null });
        const action = classify(error);
        console.log("[" + model + "] try " + attempt + " failed (" + action + "): " + describe(error));

        if (action === "fatal") { error.failures = failures; throw error; }
        if (action === "skip") break;

        if (attempt < TRIES_PER_MODEL) {
          await sleep(BACKOFF_MS * Math.pow(2, attempt - 1) * (1 + Math.random() * 0.25));
        }
      }
    }
  }

  lastError.failures = failures;
  throw lastError;
}


/* ---------------------------------------------------------
   7. EXACT-WORDING CHECK
   wordsOnly() turns text into plain lowercase words, so that tiny
   differences that do not matter (capital letters, curly quotes,
   a word split over two lines with a hyphen in a PDF) do not fail
   the check. The ORDER of the WORDS must still match exactly.
   --------------------------------------------------------- */
function wordsOnly(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/-\s*[\r\n]+\s*/g, "")          // "inter-\nface" becomes "interface"
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteIsInSource(quote, sourceWords) {
  const q = wordsOnly(quote);
  if (q.split(" ").length < 3) return false;     // too short to prove anything
  return sourceWords.includes(" " + q + " ");
}


/* ---------------------------------------------------------
   8. CLEAN THE LESSON
   NEVER trust AI output blindly: fix or drop bad data, and remove
   any "exact quote" that is not really in the source text.
   --------------------------------------------------------- */
const ALLOWED_BOARD_TYPES = ["title", "definition", "diagram", "list"];

function cleanLesson(raw, sourceText) {
  const sourceWords = " " + wordsOnly(sourceText) + " ";
  const segments = [];
  let verified = 0;
  let removed = 0;

  (raw.segments || []).forEach(function (seg) {
    const speech = String(seg.speech || "").trim();
    if (speech === "") return;

    const board = seg.board || {};
    const type = ALLOWED_BOARD_TYPES.includes(board.type) ? board.type : "definition";
    const subtitle = String(seg.subtitle || "").trim() || speech.slice(0, 90);

    let quote = String(seg.quote || "").trim();
    if (quote) {
      if (quoteIsInSource(quote, sourceWords)) {
        verified++;
      } else {
        quote = "";      // not found word for word: never show it as exact
        removed++;
      }
    }

    segments.push({
      speech: speech,
      subtitle: subtitle,
      source: seg.source === "document" ? "document" : "added",
      quote: quote,
      board: {
        type: type,
        tag: String(board.tag || "Lesson"),
        heading: String(board.heading || ""),
        text: String(board.text || subtitle),
        root: String(board.root || ""),
        children: Array.isArray(board.children) ? board.children.map(String) : [],
        highlight: Number.isInteger(board.highlight) ? board.highlight : -1,
        items: Array.isArray(board.items) ? board.items.map(String) : []
      }
    });
  });

  if (segments.length === 0) {
    throw new Error("The AI did not produce a usable lesson. Try again.");
  }

  return {
    title: String(raw.title || "Your lesson"),
    segments: segments,
    exactQuotes: { verified: verified, removed: removed }
  };
}


/* ---------------------------------------------------------
   9. THE LESSON CACHE (saved lessons)
   Same text + level + difficulty + approach = same saved lesson,
   so repeating it costs ZERO free Gemini requests.
   Delete a file in server/cache to force a fresh lesson.
   --------------------------------------------------------- */
function cacheKey(parts) {
  return crypto.createHash("sha256").update([PROMPT_VERSION].concat(parts).join("\n---\n")).digest("hex");
}

function readCache(key) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, key + ".json"), "utf8")); } catch (e) { return null; }
}

function writeCache(key, lesson) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, key + ".json"), JSON.stringify(lesson));
  } catch (e) {
    console.error("Could not save the lesson to the cache:", e.message);
  }
}


/* ---------------------------------------------------------
   10. DOCUMENTS: reading PDFs and images
   --------------------------------------------------------- */

// Text of every page of a PDF (works for PDFs that contain real text)
async function extractPdfPages(buffer) {
  const unpdf = await import("unpdf");
  const pdf = await unpdf.getDocumentProxy(new Uint8Array(buffer));   // must be a plain Uint8Array
  const result = await unpdf.extractText(pdf, { mergePages: false });
  return result.text.map(function (t) {
    return String(t).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  });
}

// Photos of pages: Gemini reads the pictures and returns the text
async function transcribeImages(images) {
  const parts = [{ text: TRANSCRIBE_PROMPT }];
  images.forEach(function (img) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.buffer.toString("base64") } });
  });
  const out = await runWithFallback({ parts: parts, temperature: 0 });
  const text = String(out.result);

  // Split by our "=== PAGE n ===" markers; if they are missing, treat it as one page
  const pieces = text.split(/^=== PAGE \d+ ===\s*$/m).map(function (p) { return p.trim(); }).filter(Boolean);
  return pieces.length ? pieces : [text.trim()];
}

// Split long text into pieces of at most `limit` characters, breaking at line ends
function splitSection(text, limit) {
  const max = limit || SECTION_CHAR_LIMIT;
  if (text.length <= max) return [text];
  const pieces = [];
  let current = "";
  text.split("\n").forEach(function (line) {
    while (line.length > max) {               // one enormous line: cut it
      if (current) { pieces.push(current); current = ""; }
      pieces.push(line.slice(0, max));
      line = line.slice(max);
    }
    if ((current + "\n" + line).length > max && current) {
      pieces.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  });
  if (current.trim()) pieces.push(current);
  return pieces;
}


/* ---------------------------------------------------------
   11. THE CONTENTS OUTLINE
   Step A (free, no Gemini): find lines that LOOK like headings.
   Step B (one Gemini request): pick the real headings and give
           them levels. Only a few thousand characters are sent.
   Step C (free): cut the document text at those headings.
   --------------------------------------------------------- */
const NUMBER_WORDS = "one|two|three|four|five|six|seven|eight|nine|ten";

function looksLikeHeading(line) {
  const t = line.trim();
  if (t.length < 3 || t.length > 110) return false;
  const wordCount = t.split(/\s+/).length;

  // "MODULE 1", "Unit 3", "Chapter two" ...
  if (new RegExp("^(module|unit|chapter|lesson|topic|part|section)\\s+(\\d+|[ivx]+|" + NUMBER_WORDS + ")\\b", "i").test(t)) return true;

  // "1.0 Introduction", "3.2 Types of problems"
  if (/^\d{1,2}(\.\d{1,2}){0,3}\.?\s+[A-Za-z]/.test(t) && !/[.;,]$/.test(t) && wordCount <= 14) return true;

  // ALL CAPS short line
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase() && wordCount <= 12 && !/[.;]$/.test(t)) return true;

  return false;
}

// Joins page texts into one text and remembers where each page starts
function joinPages(pages) {
  let text = "";
  const pageStarts = [];
  pages.forEach(function (p) {
    pageStarts.push(text.length);
    text += p + "\n\n";
  });
  return { text: text, pageStarts: pageStarts };
}

function pageOfOffset(pageStarts, offset) {
  let page = 1;
  for (let i = 0; i < pageStarts.length; i++) {
    if (pageStarts[i] <= offset) page = i + 1; else break;
  }
  return page;
}

function findHeadingCandidates(text, pageStarts) {
  const lines = [];
  let offset = 0;
  text.split("\n").forEach(function (raw) {
    lines.push({ offset: offset, line: raw.trim() });
    offset += raw.length + 1;
  });

  // Lines that appear on many different pages are running headers/footers: ignore them
  const pageCount = pageStarts.length;
  const pagesPerLine = {};
  lines.forEach(function (l) {
    if (!l.line) return;
    const key = l.line.toLowerCase().replace(/\d+/g, "#");
    if (!pagesPerLine[key]) pagesPerLine[key] = new Set();
    pagesPerLine[key].add(pageOfOffset(pageStarts, l.offset));
  });
  const repeatLimit = Math.max(4, Math.ceil(pageCount * 0.4));

  let candidates = [];
  lines.forEach(function (l) {
    if (!l.line || !looksLikeHeading(l.line)) return;
    const key = l.line.toLowerCase().replace(/\d+/g, "#");
    if (pagesPerLine[key] && pagesPerLine[key].size >= repeatLimit) return;
    candidates.push({ offset: l.offset, line: l.line, page: pageOfOffset(pageStarts, l.offset) });
  });

  // Do not send hundreds of lines: keep the strongest kinds first if there are too many
  if (candidates.length > 800) {
    const strong = candidates.filter(function (c) { return /^(module|unit|chapter|lesson|part|section|\d)/i.test(c.line); });
    candidates = strong.slice(0, 800);
  }
  candidates.forEach(function (c, i) { c.id = i + 1; });
  return candidates;
}

/* ---------------------------------------------------------
   KINDS OF HEADINGS
   Structural (shown in the list):  module > unit > topic
   Special (never shown in the list, but used while teaching):
     intro       -> becomes the 2-3 opening lines of a lesson
     outcomes    -> shown as the goals, and decides what the quiz covers
     summary     -> becomes the recap at the end of a lesson
     exercise    -> self-assessment questions and solutions: source material for quizzes
     references  -> ignored
   "merge" = a detail (formula, worked example, sub-sub-heading): folded into the topic above.
   --------------------------------------------------------- */
const KIND_LEVEL = { module: 1, unit: 2, topic: 3 };

function isStructural(item) { return KIND_LEVEL[item.kind] !== undefined; }

function stripNumbering(line) {
  return line.replace(/^\s*\d+(\.\d+)*\.?\s+/, "").trim();
}

// Decides by the WORDS of a heading (no AI needed). Returns a special kind, "merge", or null.
function kindByRules(line) {
  const t = line.trim();
  // "Unit 3 ..." and "Module 2 ..." are always real structure
  if (new RegExp("^(module|unit|chapter)\\s+(\\d+|[ivx]+|" + NUMBER_WORDS + ")\\b", "i").test(t)) return null;
  const s = stripNumbering(t);

  if (/^(references?|further reading|web resources|bibliography|suggested reading|recommended reading)\b/i.test(s)) return "references";
  if (/(self[-\s]?assessment|tutor[-\s]?marked|assessment exercise|\bexercises?\b|\bassignments?\b|practice questions?|review questions?)/i.test(s)) return "exercise";
  if (/^(solutions?|answers?|model answers?)\b/i.test(s)) return "exercise";
  if (/^(intended\s+|learning\s+|unit\s+)?(learning\s+)?(outcomes?|objectives?)\b/i.test(s)) return "outcomes";
  if (/^(summary|conclusion|let us sum up|recap|chapter summary|unit summary)\b/i.test(s)) return "summary";
  if (/^(introduction|overview|preamble|preface)$/i.test(s)) return "intro";
  // formulas ("C = C1 + C2") and worked examples
  if (t.includes("=") || /^(worked\s+|solved\s+)?(example|illustration|formula|equation|proof|theorem|remark|note)\b/i.test(s)) return "merge";
  return null;
}

// Used if Gemini is too busy: guess the kind from the words in the heading
function guessKind(line) {
  if (/^(module|part)\b/i.test(line)) return "module";
  if (/^(unit|chapter|lesson)\b/i.test(line)) return "unit";
  if (/^\d{1,2}\.\d{1,2}\.\d/.test(line)) return "merge";                 // 1.2.3 = a detail
  if (/^\d{1,2}\.\d{1,2}\b/.test(line)) return "topic";                   // 1.2 = a main topic
  const letters = line.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) return "merge";   // other ALL CAPS lines
  return "topic";
}

function normKey(title) { return String(title).toLowerCase().replace(/[^a-z0-9]/g, ""); }

// If there are no headings at all, cut the text into equal parts (each becomes a topic)
function chunkOutline(text, pageStarts) {
  const pieces = splitSection(text.trim(), 8000);
  let offset = 0;
  const items = [];
  pieces.forEach(function (piece, i) {
    const at = Math.max(0, text.indexOf(piece.slice(0, 60), offset));
    offset = at;
    const firstLine = piece.split("\n").find(function (l) { return l.trim(); }) || "";
    items.push({
      offset: at,
      title: "Part " + (i + 1) + ": " + firstLine.trim().slice(0, 50),
      kind: "topic",
      page: pageOfOffset(pageStarts, at)
    });
  });
  return items;
}

async function buildOutline(text, pageStarts, docName) {
  const candidates = findHeadingCandidates(text, pageStarts);
  console.log("Heading candidates found: " + candidates.length);

  if (candidates.length < 2) {
    return { items: buildItems(chunkOutline(text, pageStarts), text), courseTitle: "", source: "equal parts (no headings found)" };
  }

  // Step 1 (free): sort out the "special" headings and the details by their words
  const forced = [];       // special headings: kept with their kind, never shown in the list
  const toJudge = [];      // the rest: module / unit / topic ?
  candidates.forEach(function (c) {
    const rule = kindByRules(c.line);
    if (rule === "merge") return;                               // folded into the topic above
    if (rule) forced.push({ offset: c.offset, title: c.line.slice(0, 90), kind: rule, page: c.page });
    else toJudge.push(c);
  });

  // Step 2: ask Gemini which of the rest are modules, units, topics
  let structural = null;
  let courseTitle = "";
  let source = "AI";
  try {
    if (toJudge.length >= 2) {
      const listing = toJudge.map(function (c) { return c.id + " | " + c.page + " | " + c.line; }).join("\n");
      const out = await runWithFallback({
        systemText: OUTLINE_PROMPT,
        parts: [{ text: "Document: " + docName + "\n\nCandidate lines:\n" + listing }],
        schema: OUTLINE_SCHEMA,
        temperature: 0
      });
      const byId = {};
      toJudge.forEach(function (c) { byId[c.id] = c; });
      const picked = [];
      let lastOffset = -1;
      (out.result.items || []).forEach(function (item) {
        const c = byId[item.id];
        if (!c || c.offset <= lastOffset) return;               // unknown id or out of order: skip
        lastOffset = c.offset;
        if (item.kind === "merge") return;
        const kind = KIND_LEVEL[item.kind] ? item.kind : "topic";
        picked.push({ offset: c.offset, title: String(item.title || c.line).trim().slice(0, 90), kind: kind, page: c.page });
      });
      if (picked.length >= 2) {
        structural = picked;
        courseTitle = String(out.result.courseTitle || "").trim();
      } else {
        console.log("AI outline was too small, using the automatic one.");
      }
    }
  } catch (error) {
    console.error("Outline from Gemini failed (" + describe(error) + "). Using the automatic outline.");
  }

  if (!structural) {
    source = "automatic (guessed from the headings)";
    structural = [];
    toJudge.forEach(function (c) {
      const kind = guessKind(c.line);
      if (kind !== "merge") structural.push({ offset: c.offset, title: c.line.slice(0, 90), kind: kind, page: c.page });
    });
  }

  const items = buildItems(structural.concat(forced), text);
  if (items.length === 0) {
    return { items: buildItems(chunkOutline(text, pageStarts), text), courseTitle: "", source: "equal parts (no headings found)" };
  }
  return { items: items, courseTitle: courseTitle, source: source };
}

// Turns raw headings [{offset, title, kind, page}] into final items with text ranges.
//  1. removes headings that only repeat a contents page,
//  2. folds tiny topics into the topic before them,
//  3. gives every module/unit/topic its level, and cuts the text.
function buildItems(raw, text) {
  const seen = new Set();
  let items = raw.slice().sort(function (a, b) { return a.offset - b.offset; })
    .filter(function (i) { if (seen.has(i.offset)) return false; seen.add(i.offset); return true; });

  function ownLength(list, idx) {
    const end = idx + 1 < list.length ? list[idx + 1].offset : text.length;
    return text.slice(list[idx].offset, end).trim().length;
  }

  // 1. A contents page lists headings with almost no text under them. If the same heading
  //    appears again later, the early one is the contents-page copy: drop it.
  const before = items;
  items = before.filter(function (item, idx) {
    if (ownLength(before, idx) >= 150) return true;
    const key = normKey(item.title);
    for (let j = idx + 1; j < before.length; j++) {
      if (normKey(before[j].title) === key) return false;
    }
    return true;
  });

  // 2. A topic with almost no text is not worth teaching on its own: its text joins the item before it
  const before2 = items;
  items = before2.filter(function (item, idx) {
    return !(item.kind === "topic" && ownLength(before2, idx) < 150);
  });

  // 3. Levels: module 1, unit 2, topic 3, then shifted up if a document has no modules.
  //    A level can only be one deeper than the one before it.
  const structural = items.filter(isStructural);
  if (structural.length === 0) return [];
  const minLevel = Math.min.apply(null, structural.map(function (i) { return KIND_LEVEL[i.kind]; }));
  let previous = 0;
  structural.forEach(function (i) {
    let level = Math.max(1, KIND_LEVEL[i.kind] - (minLevel - 1));
    if (level > previous + 1) level = previous + 1;
    previous = level;
    i.level = level;
  });
  items.forEach(function (i) { if (!isStructural(i)) i.level = 99; });

  return sliceItems(items, text);
}

// Gives every item its slice of text
function sliceItems(items, text) {
  const maxLevel = Math.max.apply(null, items.filter(isStructural).map(function (i) { return i.level; }).concat([1]));
  const unitLevel = Math.max(1, maxLevel - 1);        // the level of "units" (the parents of topics)

  const out = items.map(function (item, i) {
    // "end" = where the NEXT heading of any kind starts: this is the item's own text
    const end = i + 1 < items.length ? items[i + 1].offset : text.length;
    const ownText = text.slice(item.offset, end).trim();

    // "rangeEnd" = where the next module/unit/topic of the same or higher level starts
    let rangeEnd = end;
    let hasChildren = false;
    if (isStructural(item)) {
      rangeEnd = text.length;
      for (let j = i + 1; j < items.length; j++) {
        if (!isStructural(items[j])) continue;
        if (items[j].level <= item.level) { rangeEnd = items[j].offset; break; }
      }
      // the first structural item after this one decides if it has children
      const nextStructural = items.slice(i + 1).find(isStructural);
      hasChildren = Boolean(nextStructural && nextStructural.level > item.level);
    }
    const rangeText = text.slice(item.offset, rangeEnd).trim();

    // What a lesson on this item teaches: a topic = its own text; a unit without topics = everything in it
    const teachEnd = (item.kind === "topic" || !isStructural(item)) ? end : rangeEnd;
    const teachText = text.slice(item.offset, teachEnd).trim();

    return {
      id: "s" + (i + 1),
      title: item.title,
      kind: item.kind,
      level: item.level,
      page: item.page,
      start: item.offset,
      end: end,
      chars: ownText.length,
      rangeEnd: rangeEnd,
      rangeChars: rangeText.length,
      hasChildren: hasChildren,
      teachEnd: teachEnd,
      teachChars: teachText.length,
      teachParts: splitSection(teachText).length,
      teachable: teachText.length >= 150,
      ownerId: null
    };
  });

  // Owners: a topic belongs to its unit; a special heading (introduction, summary ...) belongs to the unit it sits in
  out.forEach(function (item, i) {
    for (let j = i - 1; j >= 0; j--) {
      if (!isStructural(out[j])) continue;
      if (isStructural(item) ? out[j].level < item.level : out[j].level <= unitLevel) { item.ownerId = out[j].id; break; }
    }
  });
  return out;
}

// Builds the tree the contents page draws. Only modules, units and topics appear.
// Branches with nothing teachable inside are left out.
function nestItems(flat) {
  const root = [];
  const stack = [];
  flat.filter(isStructural).forEach(function (item) {
    const node = {
      id: item.id, title: item.title, page: item.page,
      teachable: item.teachable, parts: item.teachParts, chars: item.teachChars,
      children: []
    };
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node); else root.push(node);
    stack.push({ level: item.level, node: node });
  });

  function prune(nodes) {
    return nodes.filter(function (n) {
      n.children = prune(n.children);
      return n.children.length > 0 || n.teachable;
    });
  }
  return prune(root);
}

// The text a lesson on this item teaches (scope "all" = the whole range, older behaviour)
function lessonSlice(doc, item, scope) {
  const end = scope === "all" ? item.rangeEnd : (item.teachEnd || item.end);
  return doc.text.slice(item.start, end).trim();
}

// Text of the special headings (introduction, outcomes, summary, exercises) that belong to an item's unit.
// The heading line itself is removed.
function specialText(doc, ownerId, kind, maxChars) {
  const pieces = doc.items
    .filter(function (i) { return i.kind === kind && i.ownerId === ownerId; })
    .map(function (i) { return doc.text.slice(i.start, i.end).split("\n").slice(1).join("\n").trim(); })
    .filter(Boolean);
  return pieces.join("\n\n").slice(0, maxChars);
}


/* ---------------------------------------------------------
   12. SAVING UPLOADED DOCUMENTS ON DISK
   --------------------------------------------------------- */
function saveDoc(doc) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, doc.id + ".json"), JSON.stringify(doc));
}

// Documents saved by an older version of this server have no "kind" on their headings.
// Rebuild their structure once, from the saved text, with no Gemini request.
function upgradeDoc(doc) {
  if (!doc || doc.version === 2 || !Array.isArray(doc.items)) return doc;
  const raw = doc.items.map(function (i) {
    let kind = kindByRules(i.title);
    if (!kind) kind = i.level <= 1 ? "module" : i.level === 2 ? "unit" : "topic";
    return { offset: i.start, title: i.title, page: i.page, kind: kind };
  }).filter(function (i) { return i.kind !== "merge"; });
  let items = buildItems(raw, doc.text);
  if (items.length === 0) items = buildItems(chunkOutline(doc.text, [0]), doc.text);
  doc.items = items;
  doc.version = 2;
  try { saveDoc(doc); } catch (e) { /* not saving is fine, it will be rebuilt next time */ }
  return doc;
}

function loadDoc(id) {
  if (!/^[a-f0-9]{12}$/.test(String(id))) return null;     // blocks tricks like "../../secret"
  try { return upgradeDoc(JSON.parse(fs.readFileSync(path.join(DOCS_DIR, id + ".json"), "utf8"))); } catch (e) { return null; }
}

function docSummary(doc) {
  return {
    docId: doc.id,
    name: doc.name,
    courseTitle: doc.courseTitle,
    pages: doc.pages,
    chars: doc.chars,
    outlineSource: doc.outlineSource,
    outline: nestItems(doc.items)
  };
}


/* ---------------------------------------------------------
   13. FRIENDLY ERROR MESSAGES (full details stay in this terminal)
   --------------------------------------------------------- */
function friendlyError(error) {
  const failures = error.failures || [];

  if (error.status === 401 || error.status === 403) {
    return { code: 502, message: "Google rejected the API key. Check GEMINI_API_KEY in server/.env, save, and restart the server." };
  }
  if (error.status === 400) {
    return { code: 502, message: "Google rejected the request. Check the server terminal for details." };
  }

  const allQuota = failures.length > 0 && failures.every(function (f) { return f.status === 429; });
  if (allQuota) {
    return {
      code: 429,
      message: "The free limit is used up on every model for now (limits are per minute and per day). Wait a few minutes, or add another model to GEMINI_FALLBACK_MODELS in server/.env."
    };
  }

  const n = MODEL_LIST.length;
  return {
    code: 503,
    message: "Google's AI is too busy right now. The server tried " + n + " model" + (n > 1 ? "s" : "") +
      " several times. Wait a few minutes and try again. Work that already succeeded is saved and will not use another free request."
  };
}


/* ---------------------------------------------------------
   14. ROUTES
   --------------------------------------------------------- */
app.get("/api/health", function (req, res) {
  res.json({ ok: true, models: MODEL_LIST, timeoutSeconds: TIMEOUT_MS / 1000 });
});

// Model names your key can see (not a promise that they work on the free tier)
app.get("/api/models", async function (req, res) {
  try {
    const response = await fetch(BASE_URL + "/models?pageSize=200", {
      headers: { "x-goog-api-key": API_KEY },
      signal: AbortSignal.timeout(20000)
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: (data.error && data.error.message) || "Google refused the request." });
    }
    const names = (data.models || [])
      .filter(function (m) { return (m.supportedGenerationMethods || []).includes("generateContent"); })
      .map(function (m) { return m.name.replace(/^models\//, ""); })
      .sort();
    res.json({ configured: MODEL_LIST, available: names });
  } catch (err) {
    res.status(502).json({ error: "Could not reach Google: " + err.message });
  }
});

// Upload a PDF or photos -> read the text -> build the contents outline
app.post("/api/upload", async function (req, res) {
  const files = Array.isArray(req.body.files) ? req.body.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: "No file was received." });
  }

  // Decode the base64 text back into real file bytes
  const decoded = [];
  let totalBytes = 0;
  for (const f of files) {
    const buffer = Buffer.from(String(f.data || ""), "base64");
    totalBytes += buffer.length;
    decoded.push({ name: String(f.name || "file").slice(0, 120), mimeType: String(f.mimeType || ""), buffer: buffer });
  }
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: "The files are too big (limit " + Math.round(MAX_UPLOAD_BYTES / 1048576) + " MB in total). Try a smaller PDF or fewer photos." });
  }

  const isPdf = function (f) { return f.buffer.slice(0, 4).toString() === "%PDF"; };
  const isImage = function (f) { return /^image\/(png|jpeg|webp)$/.test(f.mimeType); };

  try {
    let pages;
    let docName;

    if (decoded.length === 1 && isPdf(decoded[0])) {
      docName = decoded[0].name.replace(/\.pdf$/i, "");
      pages = await extractPdfPages(decoded[0].buffer);
      if (pages.length > MAX_PDF_PAGES) {
        return res.status(413).json({ error: "This PDF has " + pages.length + " pages. The limit for now is " + MAX_PDF_PAGES + "." });
      }
      const totalChars = pages.reduce(function (sum, p) { return sum + p.length; }, 0);
      if (totalChars < 200 || totalChars / pages.length < 60) {
        return res.status(422).json({
          error: "This PDF has no selectable text (it looks like scanned pictures). For now, upload photos or screenshots of the pages instead (up to " + MAX_IMAGES + " at a time)."
        });
      }
    } else if (decoded.every(isImage)) {
      if (decoded.length > MAX_IMAGES) {
        return res.status(400).json({ error: "Please upload at most " + MAX_IMAGES + " images at a time." });
      }
      docName = decoded.length === 1 ? decoded[0].name.replace(/\.[a-z]+$/i, "") : "Photos of " + decoded.length + " pages";
      pages = await transcribeImages(decoded);
    } else {
      return res.status(400).json({ error: "Upload one PDF, or up to " + MAX_IMAGES + " images (PNG, JPG or WEBP)." });
    }

    const joined = joinPages(pages);
    if (joined.text.trim().length < 100) {
      return res.status(422).json({ error: "Almost no text could be read from this file." });
    }

    const built = await buildOutline(joined.text, joined.pageStarts, docName);
    const items = built.items;

    const doc = {
      id: crypto.randomBytes(6).toString("hex"),
      name: docName,
      courseTitle: built.courseTitle,
      pages: pages.length,
      chars: joined.text.length,
      outlineSource: built.source,
      createdAt: new Date().toISOString(),
      version: 2,
      text: joined.text,
      items: items
    };
    saveDoc(doc);
    console.log("Document saved: " + doc.name + " (" + doc.pages + " pages, " + items.length + " outline entries, outline from " + built.source + ")");
    res.json(docSummary(doc));
  } catch (error) {
    console.error("Upload failed:", describe(error), error.details || "");
    const friendly = friendlyError(error);
    res.status(friendly.code).json({ error: friendly.message });
  }
});

// Get the outline of a document that was uploaded earlier
// Which of these document ids still exist on the server? (each browser keeps its own list of ids)
app.post("/api/docs/status", function (req, res) {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 50) : [];
  const docs = [];
  ids.forEach(function (id) {
    const doc = loadDoc(id);
    if (doc) docs.push({ docId: doc.id, name: doc.name, courseTitle: doc.courseTitle, pages: doc.pages });
  });
  res.json({ docs: docs });
});

// List of everything uploaded before, newest first (for the "Your saved material" card)
app.get("/api/docs", function (req, res) {
  // When the site is shared (an access code is set), nobody may list everybody's uploads
  if (ACCESS_CODE) return res.status(403).json({ error: "Not available on a shared server." });
  let files = [];
  try { files = fs.readdirSync(DOCS_DIR).filter(function (f) { return /^[a-f0-9]{12}\.json$/.test(f); }); } catch (e) { files = []; }

  const list = files.map(function (f) {
    const doc = loadDoc(f.replace(".json", ""));
    if (!doc) return null;
    let when = 0;
    try { when = fs.statSync(path.join(DOCS_DIR, f)).mtimeMs; } catch (e) { when = 0; }
    return { docId: doc.id, name: doc.name, courseTitle: doc.courseTitle, pages: doc.pages, when: when };
  }).filter(Boolean).sort(function (x, y) { return y.when - x.when; });

  res.json({ docs: list.slice(0, 30) });
});

app.get("/api/doc/:id", function (req, res) {
  const doc = loadDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: "That document was not found. Upload it again." });
  res.json(docSummary(doc));
});

// Make a lesson: either from pasted text, or from one section of an uploaded document
app.post("/api/lesson", async function (req, res) {
  const level = String(req.body.level || "University");
  const difficulty = String(req.body.difficulty || "Standard");
  const approach = req.body.approach === "exam" ? "exam" : "explain";
  // A unit is taught as a chain of topic lessons: "first", "middle", "last" (or "only" for a single lesson)
  const position = ["first", "middle", "last"].includes(req.body.position) ? req.body.position : "only";

  let sourceText = "";
  let docName = "";
  let sectionTitle = "";
  let extras = {};
  let meta = {};

  if (req.body.docId) {
    // ---- one topic of an uploaded document ----
    const doc = loadDoc(req.body.docId);
    if (!doc) return res.status(404).json({ error: "That document was not found. Upload it again." });
    const item = doc.items.find(function (i) { return i.id === req.body.sectionId; });
    if (!item) return res.status(404).json({ error: "That topic was not found." });

    const sectionText = lessonSlice(doc, item, req.body.scope);
    const pieces = splitSection(sectionText);
    const partIndex = Math.min(Math.max(Number(req.body.part) || 0, 0), pieces.length - 1);
    sourceText = pieces[partIndex];
    docName = doc.courseTitle || doc.name;
    sectionTitle = item.title + (pieces.length > 1 ? " (part " + (partIndex + 1) + " of " + pieces.length + ")" : "");
    meta = {
      docId: doc.id, sectionId: item.id, scope: req.body.scope === "all" ? "all" : "own",
      part: partIndex, partCount: pieces.length, sectionTitle: sectionTitle, docName: docName, position: position
    };

    // The unit's introduction, learning outcomes and summary (never listed, but used for the opening, goals and recap)
    const owner = item.ownerId;
    extras = {
      intro:    specialText(doc, owner, "intro", 1500),
      outcomes: specialText(doc, owner, "outcomes", 1800),
      summary:  specialText(doc, owner, "summary", 2500)
    };

    if (sourceText.length < 80) {
      return res.status(400).json({ error: "This topic has almost no text under it. Pick another one." });
    }
  } else {
    // ---- pasted text ----
    sourceText = String(req.body.text || "").trim();
    if (sourceText.length < 50) {
      return res.status(400).json({ error: "Please paste at least a few sentences of material." });
    }
    if (sourceText.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ error: "That text is too long. Keep it under " + MAX_TEXT_LENGTH + " characters, or upload it as a file." });
    }
  }

  // Already made this exact lesson (by anyone)? Reuse it for free.
  const extrasText = [extras.intro, extras.outcomes, extras.summary].join("|");
  const key = cacheKey([level, difficulty, approach, sectionTitle, position, sourceText, extrasText]);
  const saved = readCache(key);
  if (saved) {
    console.log("Served from the saved lessons (no Gemini request used).");
    return res.json(Object.assign({}, saved, meta, { cached: true }));
  }

  try {
    const out = await runWithFallback({
      systemText: buildSystemInstruction(approach),
      parts: [{ text: buildLessonPrompt(sourceText, level, difficulty, approach, docName, sectionTitle, position, extras) }],
      schema: LESSON_SCHEMA,
      temperature: 0.6
    });

    // Quotes may come from the topic text or from the unit's outcomes / summary text
    const lesson = cleanLesson(out.result, sourceText + "\n" + (extras.intro || "") + "\n" + (extras.outcomes || "") + "\n" + (extras.summary || ""));
    if (sectionTitle) lesson.title = sectionTitle;
    lesson.approach = approach;
    writeCache(key, lesson);

    console.log("Lesson ready from " + out.model + " (" + lesson.segments.length + " segments, position " + position + "). Exact quotes: " +
      lesson.exactQuotes.verified + " verified, " + lesson.exactQuotes.removed + " removed (not found word for word).");

    res.json(Object.assign({}, lesson, meta, { model: out.model, cached: false }));
  } catch (error) {
    console.error("Lesson generation failed:", describe(error), error.details || "");
    const friendly = friendlyError(error);
    res.status(friendly.code).json({ error: friendly.message });
  }
});


/* ---------------------------------------------------------
   14b. ASK THE LECTURER  (POST /api/ask)
   The learner types a question, or taps "Explain simpler" / "Another example" /
   "Show a diagram". We send Gemini: the question + what is being taught right now
   (+ the real course text if the lesson came from an uploaded document).
   Gemini answers with ONE new lesson segment (speech + board), which the
   classroom plays straight away, then it carries on with the lesson.
   --------------------------------------------------------- */
const ASK_SCHEMA = {
  type: "OBJECT",
  properties: { segment: LESSON_SCHEMA.properties.segments.items },
  required: ["segment"]
};

const ASK_MODES = {
  ask:     "The learner asked a question. Answer exactly what they asked, clearly and directly.",
  simpler: "The learner did not understand. Do NOT repeat the earlier explanation. Re-teach it much more simply: plain everyday words, shorter sentences, one real-life analogy.",
  example: "The learner wants another example. Give one new, concrete example that is different from any example already used.",
  reteach: "The learner answered a quiz question wrongly. Teach the underlying idea again in a DIFFERENT way from the original lesson (a new analogy or a step-by-step breakdown). Then say briefly what the correct answer is and why. Be encouraging.",
  diagram: "The learner wants a picture. Use a board of type \"diagram\" (root + children) or \"list\" that shows the idea visually, and explain it while pointing at it."
};

const ASK_PROMPT = `
You are the same friendly university lecturer who is teaching this lesson. A learner has just interrupted you.
Reply as ONE short lesson segment:
- speech: 3 to 6 spoken sentences, natural and conversational, no markdown or symbols. Finish by checking understanding in a few words (for example "Does that make sense?").
- subtitle: one short sentence of the key point.
- board: something that helps (a definition, a list, or a diagram). Keep board text short.
- source: "document" only if the answer comes from the study material; otherwise "added".
- quote: leave empty unless you copy an exact excerpt from the study material word for word.
Stay on the topic of the lesson. If the question is unrelated to the lesson, say kindly that you will stay on today's topic.
Never invent facts about what the course material says. If the material does not cover the question, say so, then explain it from general knowledge and mark source "added".
`;

app.post("/api/ask", async function (req, res) {
  const mode = ASK_MODES[req.body.mode] ? req.body.mode : "ask";
  const question = String(req.body.question || "").trim().slice(0, 900);
  const level = String(req.body.level || "University");
  const difficulty = String(req.body.difficulty || "Standard");

  if (mode === "ask" && question.length < 2) {
    return res.status(400).json({ error: "Type your question first." });
  }

  // What the lecturer is teaching right now (sent by the classroom; we cap the size)
  const lessonTitle = String(req.body.lessonTitle || "").slice(0, 200);
  const nowTeaching = String(req.body.nowTeaching || "").slice(0, 1500);
  const recentlyTaught = String(req.body.recentlyTaught || "").slice(0, 2500);

  // If the lesson came from an uploaded document, include the real text of that section
  let sourceText = "";
  if (req.body.docId) {
    const doc = loadDoc(req.body.docId);
    const item = doc && doc.items.find(function (i) { return i.id === req.body.sectionId; });
    if (item) {
      const pieces = splitSection(lessonSlice(doc, item, req.body.scope));
      const partIndex = Math.min(Math.max(Number(req.body.part) || 0, 0), pieces.length - 1);
      sourceText = pieces[partIndex];
    }
  }

  const prompt =
    "Learner level: " + level + "\nTeaching difficulty: " + difficulty + "\n" +
    "Lesson: " + lessonTitle + "\n\n" +
    "What you were just explaining:\n" + nowTeaching + "\n\n" +
    (recentlyTaught ? "Earlier in this lesson:\n" + recentlyTaught + "\n\n" : "") +
    (sourceText ? 'Study material:\n"""\n' + sourceText + '\n"""\n\n' : "") +
    "Request: " + ASK_MODES[mode] + (question ? '\nLearner says: "' + question + '"' : "");

  // Same question about the same moment = reuse the saved answer
  const key = cacheKey(["ask", mode, level, difficulty, lessonTitle, nowTeaching, question]);
  const saved = readCache(key);
  if (saved) return res.json(Object.assign({}, saved, { cached: true }));

  try {
    const out = await runWithFallback({
      systemText: TEACHING_PROMPT + ASK_PROMPT,
      parts: [{ text: prompt }],
      schema: ASK_SCHEMA,
      temperature: 0.7
    });
    const cleaned = cleanLesson({ title: "answer", segments: [out.result.segment] }, sourceText);
    const answer = { segment: cleaned.segments[0] };
    writeCache(key, answer);
    console.log("Answer ready from " + out.model + " (mode: " + mode + ").");
    res.json(Object.assign({}, answer, { model: out.model, cached: false }));
  } catch (error) {
    console.error("Ask failed:", describe(error), error.details || "");
    const friendly = friendlyError(error);
    res.status(friendly.code).json({ error: friendly.message });
  }
});


/* ---------------------------------------------------------
   14c. QUIZ  (POST /api/quiz)
   Makes multiple-choice and true/false questions from the lesson material.
   They are marked in the browser (free, instant). Only making the quiz costs
   one Gemini request. "round" makes a fresh set when the learner retakes it.
   --------------------------------------------------------- */
const QUIZ_SCHEMA = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type:         { type: "STRING", enum: ["mcq", "truefalse"] },
          question:     { type: "STRING" },
          options:      { type: "ARRAY", items: { type: "STRING" } },
          correctIndex: { type: "INTEGER" },
          explanation:  { type: "STRING" },
          topic:        { type: "STRING" }
        },
        required: ["type", "question", "options", "correctIndex", "explanation", "topic"]
      }
    }
  },
  required: ["questions"]
};

const QUIZ_PROMPT = `
You write a short quiz that tests whether a learner understood a lesson.
- Use ONLY the study material given. Never test anything the material does not cover.
- Mix types: "mcq" (exactly 4 options, one correct, the others plausible but clearly wrong) and "truefalse" (options must be exactly ["True","False"]).
- Test understanding (why, how, which, what would happen), not just copying words, but use the material's own key terms and spellings.
- correctIndex is the position (starting at 0) of the correct option.
- explanation: 1 or 2 plain sentences saying why the right answer is right.
- topic: 2 to 5 words naming the idea being tested.
- Questions must be independent of each other and clear on their own.
`;

// Shuffles the options so the right answer is not always in the same place
function shuffleOptions(q) {
  const order = q.options.map(function (o, i) { return i; });
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  return {
    options: order.map(function (i) { return q.options[i]; }),
    correctIndex: order.indexOf(q.correctIndex)
  };
}

function cleanQuiz(raw) {
  const out = [];
  (raw.questions || []).forEach(function (q) {
    const options = Array.isArray(q.options) ? q.options.map(function (o) { return String(o).trim(); }).filter(Boolean) : [];
    const question = String(q.question || "").trim();
    if (!question || !Number.isInteger(q.correctIndex)) return;

    if (q.type === "truefalse") {
      if (q.correctIndex !== 0 && q.correctIndex !== 1) return;
      out.push({ type: "truefalse", question: question, options: ["True", "False"], correctIndex: q.correctIndex,
                 explanation: String(q.explanation || ""), topic: String(q.topic || "") });
      return;
    }
    if (options.length < 3 || options.length > 5 || q.correctIndex < 0 || q.correctIndex >= options.length) return;
    const shuffled = shuffleOptions({ options: options, correctIndex: q.correctIndex });
    out.push({ type: "mcq", question: question, options: shuffled.options, correctIndex: shuffled.correctIndex,
               explanation: String(q.explanation || ""), topic: String(q.topic || "") });
  });
  return out;
}

app.post("/api/quiz", async function (req, res) {
  const level = String(req.body.level || "University");
  const difficulty = String(req.body.difficulty || "Standard");
  const approach = req.body.approach === "exam" ? "exam" : "explain";
  const round = Math.max(0, Math.min(Number(req.body.round) || 0, 50));
  const lessonTitle = String(req.body.lessonTitle || "").slice(0, 200);

  // Best source: the real course text. Otherwise what the lecturer taught.
  let sourceText = "";
  let outcomesText = "";    // what the unit says the learner should achieve: the quiz must cover these
  let practiceText = "";    // self-assessment questions and solutions: the AI may use them as source material
  if (req.body.docId) {
    const doc = loadDoc(req.body.docId);
    // "sections" = every topic taught so far in this lesson (a unit is several topics in a row)
    const refs = Array.isArray(req.body.sections) && req.body.sections.length
      ? req.body.sections.slice(0, 40)
      : [{ sectionId: req.body.sectionId, part: req.body.part, scope: req.body.scope }];
    const pieces = [];
    let firstItem = null;
    if (doc) {
      refs.forEach(function (ref) {
        const item = doc.items.find(function (i) { return i.id === ref.sectionId; });
        if (!item) return;
        if (!firstItem) firstItem = item;
        const parts = splitSection(lessonSlice(doc, item, ref.scope));
        pieces.push(parts[Math.min(Math.max(Number(ref.part) || 0, 0), parts.length - 1)]);
      });
      // share the room fairly between the topics
      const each = Math.floor(12000 / Math.max(1, pieces.length));
      sourceText = pieces.map(function (p) { return p.slice(0, each); }).join("\n\n");
      if (firstItem) {
        outcomesText = specialText(doc, firstItem.ownerId, "outcomes", 1500);
        practiceText = specialText(doc, firstItem.ownerId, "exercise", 3500);
      }
    }
  }
  if (!sourceText) sourceText = String(req.body.lessonText || "").slice(0, 12000);
  if (sourceText.length < 80) return res.status(400).json({ error: "There is not enough lesson text to make a quiz from." });

  const count = sourceText.length < 1500 ? 4 : sourceText.length < 5000 ? 6 : 8;
  const key = cacheKey(["quiz", level, difficulty, approach, String(round), lessonTitle, sourceText, outcomesText, practiceText]);
  const saved = readCache(key);
  if (saved) return res.json(Object.assign({}, saved, { cached: true }));

  const prompt =
    "Learner level: " + level + "\nDifficulty: " + difficulty + "\nLesson: " + lessonTitle + "\n" +
    "Write " + count + " questions." + (round > 0 ? " This is attempt " + (round + 1) + ": ask DIFFERENT questions from a typical first quiz, covering other details." : "") +
    (approach === "exam" ? " Exam style: prefer questions on exact definitions, terms and lists in the material." : "") +
    (outcomesText ? '\n\nLearning outcomes of this unit (the quiz must cover them):\n"""\n' + outcomesText + '\n"""' : "") +
    (practiceText ? '\n\nPractice questions and solutions from the material (use them as extra source material; adapt them, do not copy them blindly):\n"""\n' + practiceText + '\n"""' : "") +
    '\n\nStudy material:\n"""\n' + sourceText + '\n"""';

  try {
    const out = await runWithFallback({
      systemText: QUIZ_PROMPT,
      parts: [{ text: prompt }],
      schema: QUIZ_SCHEMA,
      temperature: 0.7
    });
    const questions = cleanQuiz(out.result);
    if (questions.length < 3) throw new Error("The AI did not produce a usable quiz. Try again.");
    const quiz = { title: lessonTitle, questions: questions };
    writeCache(key, quiz);
    console.log("Quiz ready from " + out.model + " (" + questions.length + " questions).");
    res.json(Object.assign({}, quiz, { model: out.model, cached: false }));
  } catch (error) {
    console.error("Quiz failed:", describe(error), error.details || "");
    const friendly = friendlyError(error);
    res.status(friendly.code).json({ error: friendly.message });
  }
});


/* ---------------------------------------------------------
   15. START LISTENING
   --------------------------------------------------------- */
app.listen(PORT, HOST, function () {
  console.log("AI Lecturer server running at http://" + HOST + ":" + PORT);
  console.log(ACCESS_CODE ? "Access code is ON (daily limit " + DAILY_LIMIT + " per visitor)." : "Access code is OFF (fine on your own computer).");
  console.log("Models, in order: " + MODEL_LIST.join(" -> "));
  console.log("Time limit per try: " + TIMEOUT_MS / 1000 + "s, per request: " + TOTAL_MS / 1000 + "s");
});
