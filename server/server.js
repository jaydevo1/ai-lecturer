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

// Optional LAST backup: Groq (free key from console.groq.com). Used only when every Gemini model has failed.
// Text only: it is skipped for requests that include a PDF or a picture.
const GROQ_KEY = (process.env.GROQ_API_KEY || "").trim();
// One model, or several separated by commas (tried in order, each has its own free limit)
const GROQ_MODELS = (process.env.GROQ_MODELS || process.env.GROQ_MODEL || "openai/gpt-oss-120b")
  .split(",").map(function (n) { return n.trim(); }).filter(Boolean);
const GROQ_REASONING = (process.env.GROQ_REASONING === undefined ? "low" : process.env.GROQ_REASONING).trim();   // "low", "medium", "high" or "" to switch off
const GROQ_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;     // one try
const TOTAL_MS = Number(process.env.GEMINI_TOTAL_MS) || 150000;        // all tries for one request
const BACKOFF_MS = Number(process.env.GEMINI_BACKOFF_MS) || 2000;
const TRIES_PER_MODEL = 2;
const THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || "").trim();  // optional, e.g. "low"

const MAX_TEXT_LENGTH = 15000;          // longest text you can paste
const SECTION_CHAR_LIMIT = 6000;        // longest piece of text turned into ONE lesson (smaller = nothing gets skipped)
const MAX_UPLOAD_BYTES = 14 * 1024 * 1024;   // all uploaded files together
const MAX_PDF_PAGES = 600;
const MAX_IMAGES = 6;

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "cache");   // saved lessons
const DOCS_DIR = process.env.DOCS_DIR || path.join(__dirname, "docs");      // uploaded documents

// Where things are kept: Supabase online (survives the free server sleeping), or these folders on your own computer.
const store = require("./store")({ cacheDir: CACHE_DIR, docsDir: DOCS_DIR });

// Change this word when the teaching prompt changes, so old saved lessons are not reused
const PROMPT_VERSION = "v9";

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


// ---- Who is this? (optional): a logged-in person sends their login pass; guests send nothing ----
app.use("/api", async function (req, res, next) {
  req.user = null;
  const match = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  if (match && store.online) {
    try { req.user = await store.accounts.verify(match[1].trim()); } catch (e) { req.user = null; }
  }
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
              type:      { type: "STRING", enum: ["title", "definition", "diagram", "list", "formula", "steps", "table", "note", "code", "drawing"] },
              tag:       { type: "STRING" },
              heading:   { type: "STRING" },
              text:      { type: "STRING" },
              root:      { type: "STRING" },
              children:  { type: "ARRAY", items: { type: "STRING" } },
              highlight: { type: "INTEGER" },
              items:     { type: "ARRAY", items: { type: "STRING" } },
              latex:     { type: "STRING" },
              svg:       { type: "STRING" },
              columns:   { type: "ARRAY", items: { type: "STRING" } },
              rows:      { type: "ARRAY", items: { type: "STRING" } }
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

COVERAGE (very important): before you write, silently list EVERY definition, term, type, characteristic, advantage, disadvantage, step, formula, rule and example in the material. Each one must be taught in some segment. Never skip one. If you are short of segments, put two related items in one segment, but never leave an item out. Never end the topic until the last point of the material has been taught.
Match depth and vocabulary to the learner's level and teaching difficulty: "Very simple" means short words and many analogies; "Detailed" or "Advanced" means precise terms and deeper reasoning.

Each segment has:
- "speech": what you say out loud. 3 to 6 sentences, 50 to 90 words. Natural spoken English, no bullet points, no symbols that are hard to say aloud. Never read out section numbers such as 3.3.1 or (a). Never say the same point twice.
- "subtitle": a very short version of the point (under 12 words).
- "source": "document" if the content comes directly from the material, "added" if it is your own explanation, analogy or example. Never present your additions as if the document said them. Do not invent facts about the course.
- "quote": always an empty string.
- "board": what appears on the board while you speak. Choose one type:
    "title": opening or section title. Fields: tag, heading, text.
    "definition": a key term. Fields: tag (use "Definition"), heading (the term), text (the definition in one short line).
    "diagram": a simple tree. Fields: tag, heading, root (parent box), children (2 to 4 short labels), highlight (index of the child you are explaining, or -1).
    "list": steps or a recap. Fields: tag, heading, items (2 to 5 short lines).

Ignore any introduction, objectives, summary, conclusion, references or assignment text inside the study material; teach only the real content. Never say "your material says" or "the document says".
Open and close the lesson exactly as the LESSON POSITION RULES in the request say.
Use the diagram "highlight" across consecutive segments so the board follows what you explain.
Keep every board line short.
`;

const EXAM_RULES = `
STUDY MODE (thorough, exam-ready teaching). Teach this topic the way a good lecturer teaches a real class: you understand the content and you explain it, you never read it out.
- Every definition, type, feature, characteristic, advantage, disadvantage, step, formula and rule in the topic text must be taught. The facts and the technical terms come from the topic text and must be correct. Never invent facts and never leave a point out. Keep the course's own term names (a defined term keeps its name) and keep the original order.
- State each core point ONCE, in clear natural spoken words, then add something new: why it matters, a simple everyday example (a market, a phone, a school, transport), a contrast, or a way to remember it. NEVER say a point and then say the same point again in other words. NEVER copy a sentence from the text and then explain it.
- Lists: introduce the list in one sentence, for example "There are three types of computer: analog, digital and hybrid." Then explain each item briefly in its own words. NEVER say numbers or letters from the text such as 3.3.1, (a), (i) or "number one" unless the learner needs the number to follow a real sequence of steps.
- NEVER say "your material says", "the material states", "the document says", "according to the text" or "as written in your PDF". Just teach.
- Ignore any introduction, objectives, summary, conclusion, references, further reading or assignment text that appears inside the topic text. Teach only the real content.
- Board: short key points only: the term as heading, then a short definition or the short list items, without numbering. Never paste paragraphs on the board.
- Mark a segment "document" when it states what the topic text says, and "added" when it is your own example, analogy or hook.
- Leave "quote" as an empty string.
`;

// REVISION MODE: a fast refresher before an exam. It keeps only the most important part of each point
// (the short main definition, the items of a list) in the material's own words, and moves on.
const REVISION_PROMPT = `
You are an excellent university lecturer giving a fast REVISION lesson. The learner has already studied this material and wants to refresh the key points quickly before an exam. This is NOT a full lesson: do not teach everything, pick the most important parts and move on.

Go through the topic in the order of the topic text. For each concept:
- DEFINITION: give only ONE short main definition in your own clear words, faithful to the topic text, keeping the course's term names. Leave out long explanation, history and extra detail.
- LISTS (types, components, features, advantages, disadvantages, steps, sizes): name the list and say every item naturally in one flowing sentence, for example "The types are analog, digital and hybrid." At most a few words about each item. Never read out numbering such as 3.3.1, (a) or (i).
- FORMULAS: state the formula and one short line on what it is used for.
- You may add ONE short memory hook, such as "Think of it like a ...", only for a point that is hard to remember. Mark that segment source "added".
- Skip background, repeated explanation, long examples and small details. Never skip a term, definition or list that an exam could ask for.
- Ignore any introduction, objectives, summary, conclusion, references or assignment text that appears inside the topic text.
- Teach naturally, like a lecturer. NEVER say "your material says", "the document says" or "according to the text". Do not ask the learner questions. Never say the same thing twice.
- Match the vocabulary to the learner's level and teaching difficulty.

Each segment has:
- "speech": what you say out loud. 2 to 4 short sentences, 25 to 55 words. Natural spoken English, no bullet points, no symbols that are hard to say aloud.
- "subtitle": a very short version of the point (under 12 words).
- "source": "document" if the content comes from the topic text, "added" if it is your own memory hook. Do not invent facts about the course.
- "quote": always an empty string.
- "board": what appears on the board while you speak. Choose one type:
    "title": opening or section title. Fields: tag, heading, text.
    "definition": a key term. Fields: tag (use "Definition"), heading (the term), text (the short definition).
    "diagram": a simple tree. Fields: tag, heading, root (parent box), children (2 to 4 short labels), highlight (index of the child you are explaining, or -1).
    "list": items to remember. Fields: tag, heading, items (2 to 6 short lines, no numbering).

Open and close the lesson exactly as the LESSON POSITION RULES in the request say. Keep every board line short.
`;

// MATHS, TABLES, NOTES, CODE: added to every approach. The board can now show real equations (KaTeX in the browser).
const MATH_RULES = `

MATHS, SCIENCE, TABLES AND CODE (apply whenever the topic has formulas, equations, calculations, worked examples, comparison tables or program code):
- Extra board types you may use:
    "formula": one important formula. Fields: tag (use "Formula"), heading (its name), latex (the formula only, in LaTeX, WITHOUT dollar signs), text (one short line saying what each letter means).
    "steps": a worked example solved step by step. Fields: tag (use "Worked example"), heading (the problem), items (EVERY step of the solution in order, each one short, showing the working), highlight (index of the step you are explaining right now, starting at 0).
    "table": a comparison or data table. Fields: tag, heading, columns (short column names), rows (each row is ONE string with its cells separated by " | ").
    "note": a warning, a tip or a rule of thumb. Fields: tag, heading, text.
    "code": program code. Fields: tag, heading, text (the code, with line breaks, at most 10 lines).
- Write mathematics on the board in LaTeX between single dollar signs, inside heading, text, items or rows, for example $F = ma$ or $\\frac{a}{b}$. Chemistry formulas: $\\mathrm{H_2O}$. Do not use dollar signs for money.
- NEVER put LaTeX, dollar signs, backslashes or symbols such as ^ _ { } in "speech" or "subtitle". Say the maths in words: "F equals m times a", "x squared plus two x", "a over b", "the square root of nine".
- WORKED EXAMPLES: use the SAME "items" list in consecutive segments and raise "highlight" by one each time, so the board builds the solution while you explain. Each segment speaks only about its own step: what we do and why. Never skip a step. Show the working, then the final answer with its units.
- Solve every calculation carefully and check the arithmetic and units before you write it. Never guess a number.
- A line such as [Figure: ...] describes a picture in the PDF. Teach it with a diagram, table or steps board built from that description. Never say "as you can see in the figure" and never read the word Figure aloud as if the learner could see the page.
- If the topic text contains a worked example, a table or code, teach that one (steps, table or code board) instead of inventing a different one.
- If the topic has no maths, tables or code, ignore this section and use the normal board types.
`;

// DRAWINGS: the AI draws a simple picture as SVG; sanitizeSvg() below makes sure only safe shapes get through.
const DRAWING_RULES = `

DRAWINGS (physics, electronics, biology, geography, networks, flowcharts, any idea that is easier to see than to say):
- Board type "drawing": Fields: tag (use "Diagram"), heading, svg (the picture as SVG code), text (one short caption).
- Use a drawing whenever the topic is about something with a shape or layout: electric or magnetic field lines, charges, circuits, forces and vectors, waves, rays and lenses, graphs, apparatus, cells, maps, computer networks, flowcharts, block diagrams. A line like [Figure: ...] in the study material describes such a picture: draw it. Use the older "diagram" tree only for simple parent-and-children lists.
- SVG rules (very important):
    * Start with <svg viewBox="0 0 400 260"> and end with </svg>. Everything must fit inside 400 by 260.
    * Use ONLY these tags: svg, g, defs, marker, line, path, circle, ellipse, rect, polygon, polyline, text, tspan. No style, script, image or links.
    * The board is dark. Draw with light colours: white #f4f1e8, blue #4f8cff, yellow #f2c14e, red #ff6b6b, green #4fc88c. Lines stroke-width="2", fill="none" unless a shape is filled.
    * Arrowheads: define ONCE <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#f4f1e8"/></marker></defs> and use marker-end="url(#arr)" on lines and paths.
    * Label every important part with <text font-size="14" fill="#f4f1e8">. Text must not overlap lines or other text. Never use text smaller than 12.
    * Keep it simple and clean: at most about 40 shapes. Make it scientifically correct (electric field lines leave a positive charge and enter a negative one; magnetic field lines leave the north pole and enter the south pole; current flows from the positive terminal; show units and directions with arrows).
- Example, the field of a positive point charge:
  <svg viewBox="0 0 400 260"><defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#f4f1e8"/></marker></defs><circle cx="200" cy="130" r="14" fill="#ff6b6b"/><text x="200" y="135" font-size="16" text-anchor="middle" fill="#ffffff">+</text><line x1="214" y1="130" x2="320" y2="130" stroke="#f4f1e8" stroke-width="2" marker-end="url(#arr)"/><line x1="186" y1="130" x2="80" y2="130" stroke="#f4f1e8" stroke-width="2" marker-end="url(#arr)"/><line x1="200" y1="116" x2="200" y2="30" stroke="#f4f1e8" stroke-width="2" marker-end="url(#arr)"/><line x1="200" y1="144" x2="200" y2="230" stroke="#f4f1e8" stroke-width="2" marker-end="url(#arr)"/><text x="330" y="125" font-size="14" fill="#f2c14e">field lines point outwards</text></svg>
- While you speak about a drawing, point at its labelled parts ("the arrows show the direction a positive test charge would move"). Never read the SVG code aloud.
`;

// The three teaching approaches. Anything else (or nothing) means "revision", the default.
function normApproach(value) {
  return value === "exam" || value === "explain" ? value : "revision";
}

function buildSystemInstruction(approach) {
  if (approach === "revision") return REVISION_PROMPT + MATH_RULES + DRAWING_RULES;
  return (approach === "exam" ? TEACHING_PROMPT + EXAM_RULES : TEACHING_PROMPT) + MATH_RULES + DRAWING_RULES;
}

// Short text gets a shorter lesson (faster). Exam mode needs more segments to cover everything.
function segmentRange(textLength, approach) {
  if (approach === "revision") {
    // revision: about one segment per concept, roughly one per 650 characters of material
    const wanted = Math.min(12, Math.max(4, Math.round(textLength / 650)));
    return wanted + " to " + (wanted + 3);
  }
  // enough segments to cover every point: about one per 330 characters of material (exam) or 420 (explain)
  const per = approach === "exam" ? 330 : 420;
  const target = Math.min(24, Math.max(8, Math.round(textLength / per)));
  return target + " to " + (target + 4);
}

// Tells the AI how to open and close THIS lesson. A unit is taught as several lessons in a row
// (one per topic), so only the first one welcomes the learner and only the last one recaps.
function positionRules(position) {
  const first = position === "first" || position === "only";
  const last = position === "last" || position === "only";
  let r = "LESSON POSITION RULES (these override any other rule about openings and endings):\n";
  if (first) {
    r += '- Open with ONE short segment of 2 to 3 spoken lines in your own words: welcome the learner and say what this unit is about, using the UNIT and its TOPIC LIST given below. Then ONE goals segment: board type "list", tag "Goals", heading "What you will learn", 3 to 5 short items written by you from the TOPIC LIST and the topic text, each starting with a verb such as "Define", "Identify", "Explain". Mark both segments source "added".\n';
  } else {
    r += "- This lesson continues a unit that is already in progress. Do NOT welcome the learner and do NOT introduce the course again. Begin with one short sentence that names the new topic, then teach it.\n";
  }
  if (last) {
    r += '- Finish with ONE recap segment: board type "list", tag "Recap", heading "Recap", 2 to 5 items written by you from what you just taught (and, if useful, the TOPIC LIST). Mark it source "added".\n';
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
  if ((first || last) && extras.unitTitle) {
    extra += "UNIT: " + extras.unitTitle + "\nTOPIC LIST of this unit: " + (extras.topics || []).join("; ") + "\n\n";
  }

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
Transcribe ALL the text in these page images exactly as written. Keep headings, numbering and line breaks. Write every equation or formula in LaTeX between single dollar signs, for example $F = ma$. Write every table as rows with the cells separated by " | ". For every picture, diagram or chart write one line like [Figure: what it shows, with its labels and values]. Do not summarise, correct, translate or add comments.
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
   5b. TALKING TO GROQ (the last backup)
   Same request shape as callGemini, so the rest of the server does not care which one answered.
   --------------------------------------------------------- */
// Our schemas are written the Gemini way ("OBJECT", "STRING"). Groq wants normal JSON schema words.
function lowerSchema(node) {
  if (Array.isArray(node)) return node.map(lowerSchema);
  if (node && typeof node === "object") {
    const out = {};
    Object.keys(node).forEach(function (k) {
      out[k] = (k === "type" && typeof node[k] === "string") ? node[k].toLowerCase() : lowerSchema(node[k]);
    });
    return out;
  }
  return node;
}

function canUseGroq(request) {
  return Boolean(GROQ_KEY) && !request.parts.some(function (part) { return part.inlineData; });
}

async function callGroq(request, withReasoning, groqModel) {
  const userText = request.parts.map(function (part) { return part.text || ""; }).join("\n");
  const messages = [];
  if (request.systemText) messages.push({ role: "system", content: request.systemText });
  messages.push({
    role: "user",
    content: request.schema
      ? userText + "\n\nReply with ONLY one JSON object that follows this JSON schema, with no other text:\n" + JSON.stringify(lowerSchema(request.schema))
      : userText
  });

  const body = { model: groqModel, messages: messages, temperature: request.temperature === undefined ? 0.6 : request.temperature, max_completion_tokens: 8000 };
  if (request.schema) body.response_format = { type: "json_object" };
  if (withReasoning && GROQ_REASONING && /gpt-oss/i.test(groqModel)) body.reasoning_effort = GROQ_REASONING;

  let bodyText;
  let httpStatus;
  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_KEY },
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
    error.details = bodyText.slice(0, 800);
    if (httpStatus === 400 && /json_validate_failed|failed to generate json/i.test(bodyText)) {
      error.kind = "badjson";                 // the model wrote broken JSON: just try again
    } else {
      error.status = httpStatus;
    }
    throw error;
  }

  let answerText = "";
  try {
    const data = JSON.parse(bodyText);
    answerText = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "");
  } catch (err) {
    const error = new Error("Groq sent something that is not JSON");
    error.kind = "badjson";
    throw error;
  }
  answerText = answerText.trim();
  if (!answerText) {
    const error = new Error("Groq returned an empty answer");
    error.kind = "blocked";
    throw error;
  }
  if (!request.schema) return answerText;

  try {
    return JSON.parse(answerText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
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

  geminiLoop:
  for (const model of MODEL_LIST) {
    let thinkingOn = Boolean(THINKING_LEVEL);

    for (let attempt = 1; attempt <= TRIES_PER_MODEL; attempt++) {
      if (Date.now() - startedAt > TOTAL_MS) break geminiLoop;     // out of time: Groq (if set) gets its turn

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

  // Every Gemini model failed. If a Groq key is set, try Groq as the last backup.
  if (canUseGroq(request)) {
    for (const groqModel of GROQ_MODELS) {
      let withReasoning = true;
      for (let attempt = 1; attempt <= TRIES_PER_MODEL; attempt++) {
        try {
          console.log("[groq:" + groqModel + "] try " + attempt + "/" + TRIES_PER_MODEL + " (backup) ...");
          const result = await callGroq(request, withReasoning, groqModel);
          return { result: result, model: "groq:" + groqModel };
        } catch (error) {
          if (error.status === 400 && withReasoning && GROQ_REASONING) {
            console.log("[groq] does not accept the reasoning setting, trying without it");
            withReasoning = false;
            attempt--;
            continue;
          }
          failures.push({ model: "groq:" + groqModel, status: error.status || null, kind: error.kind || null });
          console.log("[groq:" + groqModel + "] try " + attempt + " failed: " + describe(error));
          if (!lastError) lastError = error;
          const action = classify(error);
          if (action === "fatal" || action === "skip") break;       // this Groq model is not usable now: next one
          if (attempt < TRIES_PER_MODEL) await sleep(BACKOFF_MS * (1 + Math.random() * 0.25));
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
const ALLOWED_BOARD_TYPES = ["title", "definition", "diagram", "list", "formula", "steps", "table", "note", "code", "drawing"];

/* ---------------------------------------------------------
   SAFE DRAWINGS: the AI writes SVG, but we never pass its code straight to the browser.
   We read it tag by tag and rebuild it from scratch, keeping only drawing shapes and plain
   drawing attributes. Scripts, styles, images, links, event handlers and odd values are dropped.
   --------------------------------------------------------- */
const SVG_TAGS = ["svg", "g", "defs", "marker", "line", "path", "circle", "ellipse", "rect", "polygon", "polyline", "text", "tspan"];
const SVG_SHAPES = ["line", "path", "circle", "ellipse", "rect", "polygon", "polyline"];
const SVG_ATTRS = ["viewBox", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "width", "height", "d", "points", "fill", "stroke",
  "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "transform", "font-size",
  "font-family", "font-weight", "font-style", "text-anchor", "dominant-baseline", "marker-end", "marker-start", "id", "markerWidth", "markerHeight",
  "refX", "refY", "orient", "markerUnits", "dx", "dy"];
const SVG_ATTR_LOOKUP = {};
SVG_ATTRS.forEach(function (a) { SVG_ATTR_LOOKUP[a.toLowerCase()] = a; });

function escapeSvgText(t) {
  return t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[<>&"']/g, function (c) { return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]; });
}

function sanitizeSvg(raw) {
  let src = String(raw || "").trim();
  if (!src || src.length > 14000) return "";
  src = src.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<(script|style|foreignObject|iframe|object|embed|image|use|a|animate|animateTransform|set)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style|foreignObject|iframe|object|embed|image|use|a|animate|animateTransform|set)\b[^>]*>/gi, "");

  const out = [];
  const stack = [];
  let sawSvg = false;
  let shapes = 0;
  let count = 0;
  const re = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)\s*>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) {                                   // text between tags
      if (stack.length && /^(text|tspan)$/.test(stack[stack.length - 1])) out.push(escapeSvgText(m[5]));
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    if (SVG_TAGS.indexOf(name) === -1) continue;
    if (!sawSvg && name !== "svg") continue;
    if (closing) {
      if (stack.length && stack[stack.length - 1] === name) { out.push("</" + name + ">"); stack.pop(); }
      continue;
    }
    if (name === "svg" && sawSvg) continue;
    if (++count > 160) return "";

    const attrs = {};
    const attrRe = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(m[3]))) {
      const canon = SVG_ATTR_LOOKUP[a[1].toLowerCase()];
      if (!canon) continue;
      const value = String(a[2] !== undefined ? a[2] : a[3]).trim();
      if (value.length > 1500) continue;
      if (/[<>]|javascript:|data:|expression\s*\(|&#|@import/i.test(value)) continue;
      if (/url\s*\(/i.test(value) && !/^url\(#[\w-]+\)$/.test(value)) continue;
      attrs[canon] = value;
    }

    if (name === "svg") {
      sawSvg = true;
      delete attrs.width; delete attrs.height;
      if (!attrs.viewBox || !/^[\d.\s-]+$/.test(attrs.viewBox)) attrs.viewBox = "0 0 400 260";
      attrs.xmlns = "http://www.w3.org/2000/svg";
      attrs.preserveAspectRatio = "xMidYMid meet";
    }
    // Defaults so nothing is invisible on the dark board
    if (name === "text" || name === "tspan") { if (!attrs.fill) attrs.fill = "#f4f1e8"; }
    if (["line", "polyline", "path"].indexOf(name) !== -1 && !attrs.stroke && !attrs.fill) attrs.stroke = "#f4f1e8";
    if (["path", "polygon", "polyline", "rect", "circle", "ellipse"].indexOf(name) !== -1 && !attrs.fill) attrs.fill = "none";
    if (SVG_SHAPES.indexOf(name) !== -1) shapes++;

    const attrText = Object.keys(attrs).map(function (k) { return " " + k + '="' + attrs[k].replace(/"/g, "&quot;") + '"'; }).join("");
    const selfClose = m[4] === "/";
    out.push("<" + name + attrText + (selfClose ? "/>" : ">"));
    if (!selfClose) stack.push(name);
  }
  while (stack.length) out.push("</" + stack.pop() + ">");
  if (!sawSvg || shapes === 0) return "";
  return out.join("");
}

// Safety net: if the AI left LaTeX in the spoken text, turn it into words so the voice never says "backslash frac"
function speakable(text) {
  function words(x) {
    let t = x;
    for (let i = 0; i < 3; i++) t = t.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "$1 over $2").replace(/\\sqrt\s*\{([^{}]*)\}/g, "the square root of $1");
    const map = { times: " times ", cdot: " times ", div: " divided by ", pm: " plus or minus ", leq: " less than or equal to ", le: " less than or equal to ",
      geq: " greater than or equal to ", ge: " greater than or equal to ", neq: " not equal to ", approx: " approximately ", rightarrow: " gives ",
      to: " goes to ", pi: " pi ", Delta: " delta ", delta: " delta ", theta: " theta ", alpha: " alpha ", beta: " beta ", lambda: " lambda ", mu: " mu ",
      omega: " omega ", Omega: " ohms ", sum: " the sum of ", infty: " infinity ", degree: " degrees " };
    t = t.replace(/\\([A-Za-z]+)/g, function (m, name) { return map[name] !== undefined ? map[name] : " "; });
    t = t.replace(/\^\{?2\}?/g, " squared").replace(/\^\{?3\}?/g, " cubed").replace(/\^\{([^{}]*)\}/g, " to the power $1").replace(/\^(\w)/g, " to the power $1");
    t = t.replace(/_\{([^{}]*)\}/g, "$1").replace(/_(\w)/g, "$1").replace(/[{}]/g, "");
    t = t.replace(/=/g, " equals ").replace(/\+/g, " plus ").replace(/\s-\s/g, " minus ");
    return t.replace(/\s+/g, " ").trim();
  }
  return String(text || "").replace(/\$\$?([^$]+)\$\$?/g, function (m, inner) { return words(inner); }).replace(/\$/g, "").replace(/\s{2,}/g, " ").trim();
}

// Remove section numbers the AI may have copied from the PDF: "3.3.1 Types", "(a) Speed", "(iv) ...", "2. Item"
function stripNumbering(text, inSpeech) {
  let t = String(text || "").trim();
  t = t.replace(/^\(?(?:\d+(?:\.\d+)+|\d{1,2}[.)]|[a-z][.)]|\([a-z]\)|\((?:[ivx]+|\d+)\)|[ivx]+[.)])\s+/i, "");
  if (inSpeech) t = t.replace(/\b\d+\.\d+(?:\.\d+)+\s*[:.)-]?\s*/g, "");
  return t.trim();
}

function cleanLesson(raw, sourceText) {
  const sourceWords = " " + wordsOnly(sourceText) + " ";
  const segments = [];
  let verified = 0;
  let removed = 0;

  (raw.segments || []).forEach(function (seg) {
    let speech = String(seg.speech || "").trim();
    if (speech === "") return;
    speech = speakable(stripNumbering(speech, true));

    const board = seg.board || {};
    let type = ALLOWED_BOARD_TYPES.includes(board.type) ? board.type : "definition";
    const svg = type === "drawing" ? sanitizeSvg(board.svg) : "";
    if (type === "drawing" && !svg) type = "definition";      // the picture was unusable: show it as a normal definition card
    const subtitle = speakable(stripNumbering(String(seg.subtitle || "").trim() || speech.slice(0, 90), true));
    const quote = "";      // quotes are no longer used: the lecturer teaches, it does not read

    segments.push({
      speech: speech,
      subtitle: subtitle,
      source: seg.source === "document" ? "document" : "added",
      quote: quote,
      board: {
        type: type,
        tag: String(board.tag || "Lesson"),
        heading: stripNumbering(board.heading || ""),
        text: String(board.text || subtitle),
        root: String(board.root || ""),
        children: Array.isArray(board.children) ? board.children.map(String) : [],
        highlight: Number.isInteger(board.highlight) ? board.highlight : -1,
        items: Array.isArray(board.items) ? board.items.map(function (x) { return stripNumbering(x); }) : [],
        svg: svg,
        latex: String(board.latex || "").replace(/^\s*\$+|\$+\s*$/g, "").trim(),
        columns: Array.isArray(board.columns) ? board.columns.map(String) : [],
        rows: Array.isArray(board.rows) ? board.rows.map(String) : []
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

async function readCache(key) {
  try { return await store.cacheGet(key); } catch (e) { console.error("Could not read the cache:", e.message); return null; }
}

async function writeCache(key, lesson) {
  try { await store.cacheSet(key, lesson); } catch (e) { console.error("Could not save to the cache:", e.message); }
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

/* ---------------------------------------------------------
   10b. READING THE REAL PDF PAGES (equations, tables, figures)
   Plain text extraction loses equations, tables and pictures. For a topic that looks like it has them,
   we cut out just those pages from the saved PDF, send them to Gemini once, and keep the answer
   (equations in LaTeX, tables as rows, figures described). The answer is saved, so it is only done once per topic.
   If anything fails, the lesson simply uses the normal text.
   --------------------------------------------------------- */
const READ_PAGES = (process.env.READ_PAGES || "on").toLowerCase() !== "off";
const MAX_READ_PAGES = Number(process.env.MAX_READ_PAGES) || 6;

const READ_PAGES_PROMPT = `
These are pages from a university course PDF. Transcribe ONE section of them, exactly as written, in reading order.
- Equations and formulas: write each one in LaTeX between single dollar signs, for example $v = u + at$ or $\\frac{a}{b}$.
- Tables: write each row on its own line with the cells separated by " | ", the header row first.
- Pictures, diagrams, charts and graphs: write one line like [Figure: what it shows, including every label, axis, value and arrow that matters].
- Keep headings and ordinary text as written. Do not summarise, correct, translate or add comments.
- Leave out page numbers, running headers and footers.
`;

// Does this topic text look like it has equations, tables or figures?
function looksVisual(text) {
  const t = String(text || "");
  if (t.length < 200) return false;
  if ((t.match(/\b(?:fig(?:ure)?s?\.?|table|diagram|chart|graph)\s*\d/gi) || []).length >= 1) return true;
  const symbols = (t.match(/[=\u00B1\u00D7\u00F7\u221A\u2211\u222B\u2264\u2265\u2260\u2248\u221E\u03C0\u0394\u03B8\u00B2\u00B3\u00BD]/g) || []).length;
  if (symbols / t.length * 1000 >= 4) return true;
  const lines = t.split("\n").filter(function (l) { return l.trim() !== ""; });
  const tiny = lines.filter(function (l) { return l.trim().length <= 3; }).length;
  return lines.length >= 15 && tiny / lines.length > 0.3;     // broken formula fragments on their own lines
}

async function slicePdfPages(pdfBuffer, fromPage, toPage) {
  let PDFLib;
  try { PDFLib = require("pdf-lib"); } catch (e) { console.log("Page reading is off: run npm install in the server folder (pdf-lib is missing)."); return null; }
  const source = await PDFLib.PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const out = await PDFLib.PDFDocument.create();
  const wanted = [];
  for (let p = fromPage; p <= toPage; p++) if (p >= 1 && p <= source.getPageCount()) wanted.push(p - 1);
  if (wanted.length === 0) return null;
  const copied = await out.copyPages(source, wanted);
  copied.forEach(function (page) { out.addPage(page); });
  return Buffer.from(await out.save());
}

// Returns the page-read text of this part of a topic, or null (then the normal text is used)
async function readTopicPages(doc, item, pieceText, sectionTitle) {
  if (!doc.pageStarts) return null;

  const sectionText = doc.text.slice(item.start, item.teachEnd || item.end);
  const at = Math.max(0, sectionText.indexOf(pieceText.slice(0, 80)));
  const startOffset = item.start + at;
  const fromPage = pageOfOffset(doc.pageStarts, startOffset);
  let toPage = pageOfOffset(doc.pageStarts, Math.max(startOffset, startOffset + pieceText.length - 1));
  if (toPage - fromPage + 1 > MAX_READ_PAGES) toPage = fromPage + MAX_READ_PAGES - 1;

  const startsWith = pieceText.slice(0, 120).replace(/\s+/g, " ");
  const endsWith = pieceText.slice(-120).replace(/\s+/g, " ");
  const key = cacheKey(["pages", doc.id, fromPage, toPage, startsWith, endsWith]);
  const saved = await readCache(key);
  if (saved && saved.text) return saved.text;

  const pdfBuffer = await store.pdfGet(doc.id);       // the saved original PDF (none for old uploads)
  if (!pdfBuffer) return null;
  const pdf = await slicePdfPages(pdfBuffer, fromPage, toPage);
  if (!pdf) return null;

  const prompt = READ_PAGES_PROMPT +
    '\nTranscribe only the section "' + sectionTitle + '". It starts with the text: "' + startsWith + '" and it ends with the text: "' + endsWith + '". ' +
    "Skip anything on these pages before the start or after the end of that section.";
  const out = await runWithFallback({
    parts: [{ text: prompt }, { inlineData: { mimeType: "application/pdf", data: pdf.toString("base64") } }],
    temperature: 0
  });
  const text = String(out.result || "").trim();
  // Safety: a very short answer means the reading went wrong, so keep the normal text instead
  if (text.length < pieceText.length * 0.4) return null;
  await writeCache(key, { text: text });
  console.log("Read pages " + fromPage + " to " + toPage + " of " + doc.name + " with " + out.model + " (" + text.length + " characters).");
  return text;
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

  // Contents pages: lines like "Unit 2 Basic Concepts ............ 9" (dots, then a page number).
  // Where several of them sit close together, that whole stretch is a contents page, not real headings.
  const tocLine = /(\.{3,}|\u2026+|(\.\s){4,})\s*\d{1,3}\s*$/;
  const tocHits = [0];
  lines.forEach(function (l, i) { tocHits.push(tocHits[i] + (tocLine.test(l.line) ? 1 : 0)); });
  function inContents(i) {
    // only the contents lines themselves (plus a title that wraps onto the next line), and only where several sit together
    if (!tocLine.test(lines[i].line) && !(i + 1 < lines.length && tocLine.test(lines[i + 1].line))) return false;
    const from = Math.max(0, i - 30);
    const to = Math.min(lines.length, i + 31);
    return tocHits[to] - tocHits[from] >= 4;
  }
  lines.forEach(function (l, i) { l.toc = inContents(i); });

  // A bare "MODULE 1" / "UNIT 2" line that repeats many times is a running page header, not a heading
  const bareCount = {};
  lines.forEach(function (l) {
    if (/^(module|unit)\s+\d+\s*$/i.test(l.line)) {
      const k = l.line.toLowerCase();
      bareCount[k] = (bareCount[k] || 0) + 1;
    }
  });

  // Lines that appear on many different pages are running headers/footers: ignore them
  pageStarts = pageStarts && pageStarts.length ? pageStarts : [0];
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
    if (!l.line || l.toc || !looksLikeHeading(l.line)) return;
    if (bareCount[l.line.toLowerCase()] >= 3) return;
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

/* ---------------------------------------------------------
   RULE-BASED OUTLINE (no AI): for NOUN-style course materials
     MODULE 1 ...  >  UNIT 1 ...  >  1.0 Introduction, 2.0 Objectives,
     3.0 Main Content (3.1, 3.2 ... = the topics), 4.0 Conclusion, 5.0 Summary,
     6.0 Tutor-Marked Assignment, 7.0 References.
   Plain rules read this layout exactly, so no module or topic can go missing.
   Returns the finished items, or null when the document does not look like this.
   --------------------------------------------------------- */
const MODULE_RE = new RegExp("^module\\s+(\\d+|[ivx]+|" + NUMBER_WORDS + ")\\b", "i");
const UNIT_RE = new RegExp("^unit\\s+(\\d+|[ivx]+|" + NUMBER_WORDS + ")\\b", "i");

const ACRONYMS = ["cpu", "ram", "rom", "ict", "vdu", "dc", "ac", "lan", "wan", "os", "pc", "cd", "dvd", "usb", "url", "html", "alu", "bios", "gui", "gsm", "ip", "it", "ai"];

// "BASIC CONCEPTS" -> "Basic Concepts" (only when the whole line is in capitals)
function tidyTitle(title) {
  let t = title.replace(/\s+/g, " ").trim();
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    const small = ["of", "and", "the", "in", "to", "for", "a", "an", "on", "or", "with", "at", "by"];
    t = t.toLowerCase().split(" ").map(function (w, i, arr) {
      if (i > 0 && small.includes(w) && !/\d$/.test(arr[i - 1])) return w;      // "Unit 2 A Historical": keep the capital after a number
      if (/^(i{1,3}|iv|vi{0,3}|ix|x)$/.test(w) || ACRONYMS.includes(w)) return w.toUpperCase();   // "ii", "dc", "cpu"
      return w.replace(/^([^a-z]*)([a-z])/, function (m, a, b) { return a + b.toUpperCase(); });
    }).join(" ");
  }
  return t.slice(0, 90);
}

function ruleBasedOutline(text, pageStarts) {
  const candidates = findHeadingCandidates(text, pageStarts);
  let groups = 0, numbered = 0;
  candidates.forEach(function (c) {
    if (MODULE_RE.test(c.line) || UNIT_RE.test(c.line)) groups++;
    else if (/^\d{1,2}\.[1-9]\d?\s/.test(c.line)) numbered++;
  });
  if (groups < 2 || numbered < 2) return null;

  const raw = [];
  candidates.forEach(function (c) {
    let title = c.line;
    let kind = null;
    const byWords = kindByRules(title);

    // Course-guide lines such as "Module 5 Unit 4: This unit concludes the discussions on ..." describe a unit, they are not headings
    if ((MODULE_RE.test(title) || UNIT_RE.test(title)) &&
        (/^module\s+\S+\s+unit\s+\S+/i.test(title) || /\b(this|these)\s+(unit|module|course)\b/i.test(title))) return;

    if (MODULE_RE.test(title)) kind = "module";
    else if (UNIT_RE.test(title)) kind = "unit";
    else if (byWords === "merge") return;
    else if (byWords) kind = byWords;                       // introduction, objectives, summary ...
    else {
      const m = title.match(/^(\d{1,2})\.(\d{1,2})(\.\d+)?\.?\s+(.*)$/);
      if (!m || m[3]) return;                              // not numbered like 3.1, or a deeper 3.1.2 detail
      if (m[2] === "0" && /^main\s+content/i.test(m[4])) return;   // "3.0 MAIN CONTENT" is only a label
      kind = "topic";
    }

    // "UNIT 1" with the name on the next line: join them
    if ((kind === "module" || kind === "unit") && title.length <= 12) {
      const after = text.slice(c.offset + c.line.length).split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
      if (after && after.length <= 80 && !MODULE_RE.test(after) && !UNIT_RE.test(after) && !/^\d/.test(after)) title = title + " " + after;
    }
    raw.push({ offset: c.offset, title: tidyTitle(title), kind: kind, page: c.page });
  });

  const items = buildItems(raw, text);
  return items.some(isStructural) ? items : null;
}

async function buildOutline(text, pageStarts, docName) {
  // First choice: read the NOUN layout with plain rules (fast, free, and nothing goes missing)
  const byRules = ruleBasedOutline(text, pageStarts);
  if (byRules && byRules.filter(isStructural).length >= 3) {
    console.log("Outline built by rules (module / unit / numbered topics).");
    return { items: byRules, courseTitle: "", source: "rules (module / unit / numbered topics)" };
  }

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
  // "Unit 2 Historical Overview" in a list and "UNIT 2 A HISTORICAL OVERVIEW" later are the same unit
  function groupKey(item) {
    const m = String(item.title).match(/^(module|unit)\s+(\d+|[ivx]+)\b/i);
    return m && item.kind === m[1].toLowerCase() ? m[1].toLowerCase() + m[2].toLowerCase() : null;
  }
  const before = items;
  items = before.filter(function (item, idx) {
    if (ownLength(before, idx) >= 150) return true;
    const key = normKey(item.title);
    const gKey = groupKey(item);
    for (let j = idx + 1; j < before.length; j++) {
      if (normKey(before[j].title) === key) return false;
      if (gKey && groupKey(before[j]) === gKey) return false;
      if (gKey && item.kind === "unit" && before[j].kind === "module") break;   // unit numbers start again in the next module
    }
    return true;
  });

  // Everything before the first module (or the first unit) is the course guide / front matter: not taught
  // (a real module is followed by its units or its sections, never straight by another module)
  function realStart(kind) {
    let idx = items.findIndex(function (i, n) {
      return i.kind === kind && n + 1 < items.length && items[n + 1].kind !== "module";
    });
    if (idx < 0) idx = items.findIndex(function (i) { return i.kind === kind; });
    return idx;
  }
  let firstGroup = realStart("module");
  if (firstGroup < 0) firstGroup = realStart("unit");
  if (firstGroup > 0) items = items.slice(firstGroup);

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
    .map(function (i) {
      return doc.text.slice(i.start, i.end).split("\n").slice(1)
        .filter(function (l) { return !/^\s*\d+\.\d+\s+main\s+content\s*$/i.test(l); })   // the "3.0 MAIN CONTENT" label
        .join("\n").trim();
    })
    .filter(Boolean);
  return pieces.join("\n\n").slice(0, maxChars);
}


/* ---------------------------------------------------------
   12. SAVING UPLOADED DOCUMENTS ON DISK
   --------------------------------------------------------- */
async function saveDoc(doc) {
  await store.docSet(doc);
}

// Documents saved by an older version of this server have no "kind" on their headings.
// Rebuild their structure once, from the saved text, with no Gemini request.
function upgradeDoc(doc) {
  if (!doc || doc.version >= 4 || !Array.isArray(doc.items)) return doc;
  const oldItems = doc.items;
  let items = null;
  try {
    items = ruleBasedOutline(doc.text, doc.pageStarts || null);
    if (items) {
      // old documents did not save where pages start: borrow the page numbers of the old headings
      items.forEach(function (it) {
        let page = 1;
        oldItems.forEach(function (o) { if (o.start <= it.start && o.page) page = o.page; });
        it.page = page;
      });
      doc.outlineSource = "rules (module / unit / numbered topics)";
    }
  } catch (e) { items = null; }

  if (!items && doc.version !== 2) {
    const raw = oldItems.map(function (i) {
      let kind = kindByRules(i.title);
      if (!kind) kind = i.level <= 1 ? "module" : i.level === 2 ? "unit" : "topic";
      return { offset: i.start, title: i.title, page: i.page, kind: kind };
    }).filter(function (i) { return i.kind !== "merge"; });
    items = buildItems(raw, doc.text);
    if (items.length === 0) items = buildItems(chunkOutline(doc.text, [0]), doc.text);
  }
  if (items) doc.items = items;
  doc.version = 4;
  return doc;
}

async function loadDoc(id) {
  if (!/^[a-f0-9]{12}$/.test(String(id))) return null;     // blocks tricks like "../../secret"
  let raw = null;
  try { raw = await store.docGet(id); } catch (e) { console.error("Could not load a document:", e.message); return null; }
  if (!raw) return null;
  const versionBefore = raw.version;
  const doc = upgradeDoc(raw);
  if (doc && doc.version !== versionBefore) {
    try { await saveDoc(doc); } catch (e) { /* not saving is fine, it will be rebuilt next time */ }
  }
  return doc;
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

  // A problem with OUR database (Supabase), not with Google
  if (error.isStore) {
    const text = String(error.storeText || error.message || "");
    if (/42501|permission denied/i.test(text)) {
      return { code: 500, message: "The online database refused access (permission denied). In Supabase, run the fix in supabase-setup.sql (the GRANT lines), then try again." };
    }
    if (error.storeStatus === 401 || error.storeStatus === 403) {
      return { code: 500, message: "The online database rejected the server's key. Check SUPABASE_URL and SUPABASE_SECRET_KEY, then restart the server." };
    }
    if (error.storeStatus === 404 || /42P01|does not exist|schema cache/i.test(text)) {
      return { code: 500, message: "The online database is missing its tables. In Supabase, run supabase-setup.sql once, then try again." };
    }
    return { code: 500, message: "The online database had a problem. Check the server terminal for details and try again." };
  }

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
    // The same file uploaded before (by anybody)? Then reuse its contents: no waiting and no Gemini request.
    const fileHash = crypto.createHash("sha256");
    decoded.forEach(function (f) { fileHash.update(f.buffer); });
    const hash = fileHash.digest("hex");
    const already = await store.docFindByHash(hash);
    if (already) {
      const reused = await loadDoc(already.id);
      if (reused) {
        if (req.user) await store.accounts.link(req.user.id, reused.id);
        console.log("Document reused: " + reused.name + " (same file uploaded before)");
        return res.json(docSummary(reused));
      }
    }

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
    const docId = crypto.randomBytes(6).toString("hex");
    // Keep the real PDF, so equations, tables and figures can be read from its pages later
    if (decoded.length === 1 && isPdf(decoded[0])) {
      try { await store.pdfPut(docId, decoded[0].buffer); } catch (e) { console.error("Could not keep the PDF (page reading stays off for it):", e.message); }
    }

    const doc = {
      id: docId,
      hash: hash,
      name: docName,
      courseTitle: built.courseTitle,
      pages: pages.length,
      chars: joined.text.length,
      outlineSource: built.source,
      createdAt: new Date().toISOString(),
      version: 4,
      pageStarts: joined.pageStarts,
      text: joined.text,
      items: items
    };
    await saveDoc(doc);
    if (req.user) await store.accounts.link(req.user.id, doc.id);
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
app.post("/api/docs/status", async function (req, res) {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.slice(0, 50) : [];
  const docs = [];
  for (const id of ids) {
    const doc = await loadDoc(id);
    if (doc) docs.push({ docId: doc.id, name: doc.name, courseTitle: doc.courseTitle, pages: doc.pages });
  }
  res.json({ docs: docs });
});

// List of everything uploaded before, newest first. Only on your own computer (no accounts, no shared server):
// otherwise everybody would see everybody's uploads. Online, each person asks for their own list (/api/mydocs).
app.get("/api/docs", async function (req, res) {
  if (ACCESS_CODE || store.online) return res.status(403).json({ error: "Not available on a shared server." });
  const list = await store.listAll();
  res.json({ docs: list.slice(0, 30) });
});

app.get("/api/doc/:id", async function (req, res) {
  const doc = await loadDoc(req.params.id);
  if (!doc) return res.status(404).json({ error: "That document was not found. Upload it again." });
  // Opening a document while logged in also puts it in that person's own list
  if (req.user) store.accounts.link(req.user.id, doc.id).catch(function (e) { console.error("Could not link the document:", e.message); });
  res.json(docSummary(doc));
});

/* ---------------------------------------------------------
   ACCOUNTS: my documents and my progress (log in needed)
   --------------------------------------------------------- */
function needUser(req, res) {
  if (!store.online) { res.status(503).json({ error: "Accounts are not set up on this server yet." }); return false; }
  if (!req.user) { res.status(403).json({ error: "Please log in.", needLogin: true }); return false; }   // 403, not 401: 401 means "access code"
  return true;
}

app.get("/api/mydocs", async function (req, res) {
  if (!needUser(req, res)) return;
  try { res.json({ docs: await store.accounts.list(req.user.id) }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "Could not load your documents. Try again." }); }
});

app.delete("/api/mydocs/:id", async function (req, res) {
  if (!needUser(req, res)) return;
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).json({ error: "Bad document id." });
  try { await store.accounts.unlink(req.user.id, req.params.id); res.json({ ok: true }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "Could not remove it. Try again." }); }
});

// A guest just made an account: move the documents (and progress) this browser had into the account
app.post("/api/mydocs/claim", async function (req, res) {
  if (!needUser(req, res)) return;
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).filter(function (id) { return /^[a-f0-9]{12}$/.test(String(id)); }).slice(0, 50);
  const done = req.body.done && typeof req.body.done === "object" ? req.body.done : {};
  let claimed = 0;
  try {
    for (const id of ids) {
      if (!(await loadDoc(id))) continue;
      await store.accounts.link(req.user.id, id);
      const sections = Array.isArray(done[id]) ? done[id].map(String).slice(0, 500) : [];
      await store.accounts.progressMark(req.user.id, id, sections);
      claimed++;
    }
    res.json({ claimed: claimed });
  } catch (e) { console.error(e.message); res.status(500).json({ error: "Could not move your documents. Try again." }); }
});

app.get("/api/progress/:docId", async function (req, res) {
  if (!needUser(req, res)) return;
  if (!/^[a-f0-9]{12}$/.test(req.params.docId)) return res.status(400).json({ error: "Bad document id." });
  try { res.json({ done: await store.accounts.progressList(req.user.id, req.params.docId) }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "Could not load your progress." }); }
});

app.post("/api/progress", async function (req, res) {
  if (!needUser(req, res)) return;
  const docId = String(req.body.docId || "");
  if (!/^[a-f0-9]{12}$/.test(docId)) return res.status(400).json({ error: "Bad document id." });
  const sections = (Array.isArray(req.body.sectionIds) ? req.body.sectionIds : []).map(String).slice(0, 500);
  try { await store.accounts.progressMark(req.user.id, docId, sections); res.json({ ok: true }); }
  catch (e) { console.error(e.message); res.status(500).json({ error: "Could not save your progress." }); }
});

// Make a lesson: either from pasted text, or from one section of an uploaded document
app.post("/api/lesson", async function (req, res) {
  const level = String(req.body.level || "University");
  const difficulty = String(req.body.difficulty || "Standard");
  const approach = normApproach(req.body.approach);
  // A unit is taught as a chain of topic lessons: "first", "middle", "last" (or "only" for a single lesson)
  const position = ["first", "middle", "last"].includes(req.body.position) ? req.body.position : "only";

  let sourceText = "";
  let docName = "";
  let sectionTitle = "";
  let extras = {};
  let meta = {};

  if (req.body.docId) {
    // ---- one topic of an uploaded document ----
    const doc = await loadDoc(req.body.docId);
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

    // Only OUR OWN outline is used as context (unit title and its topic titles).
    // The PDF's introduction, objectives, summary and assignment text are never given to the lecturer.
    const ownerItem = doc.items.find(function (i) { return i.id === item.ownerId; });
    extras = {
      unitTitle: ownerItem ? ownerItem.title : "",
      topics: doc.items.filter(function (i) { return i.ownerId === item.ownerId && (!i.kind || i.kind === "topic"); })
        .map(function (i) { return i.title; }).slice(0, 12)
    };

    if (sourceText.length < 80) {
      return res.status(400).json({ error: "This topic has almost no text under it. Pick another one." });
    }

    // Topics with equations, tables or figures: read the real PDF pages (once, then saved)
    meta.pageReading = "off";
    if (READ_PAGES && req.body.readPages !== false && (req.body.readPages === true || looksVisual(sourceText))) {
      try {
        const read = await readTopicPages(doc, item, sourceText, item.title);
        if (read) { sourceText = read; meta.pageReading = "used"; } else { meta.pageReading = "unavailable"; }
      } catch (error) {
        console.error("Reading the PDF pages failed (the normal text is used):", describe(error));
        meta.pageReading = "failed";
      }
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
  const extrasText = [extras.unitTitle || "", (extras.topics || []).join(";")].join("|");
  const key = cacheKey([level, difficulty, approach, sectionTitle, position, sourceText, extrasText]);
  const saved = await readCache(key);
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
    const lesson = cleanLesson(out.result, sourceText);
    if (sectionTitle) lesson.title = sectionTitle;
    lesson.approach = approach;
    await writeCache(key, lesson);

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
  diagram: "The learner wants a picture. Draw it: use a board of type \"drawing\" (an SVG picture, see the DRAWINGS rules) whenever the idea has a shape, layout or flow; use \"diagram\" (root + children) or \"list\" only for simple groupings. Explain it while pointing at its labelled parts."
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
    const doc = await loadDoc(req.body.docId);
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
  const saved = await readCache(key);
  if (saved) return res.json(Object.assign({}, saved, { cached: true }));

  try {
    const out = await runWithFallback({
      systemText: TEACHING_PROMPT + ASK_PROMPT + MATH_RULES + DRAWING_RULES,
      parts: [{ text: prompt }],
      schema: ASK_SCHEMA,
      temperature: 0.7
    });
    const cleaned = cleanLesson({ title: "answer", segments: [out.result.segment] }, sourceText);
    const answer = { segment: cleaned.segments[0] };
    await writeCache(key, answer);
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
  const approach = normApproach(req.body.approach);
  const round = Math.max(0, Math.min(Number(req.body.round) || 0, 50));
  const lessonTitle = String(req.body.lessonTitle || "").slice(0, 200);

  // Best source: the real course text. Otherwise what the lecturer taught.
  let sourceText = "";
  let outcomesText = "";    // what the unit says the learner should achieve: the quiz must cover these
  let practiceText = "";    // self-assessment questions and solutions: the AI may use them as source material
  if (req.body.docId) {
    const doc = await loadDoc(req.body.docId);
    // "sections" = every topic taught so far in this lesson (a unit is several topics in a row)
    const refs = Array.isArray(req.body.sections) && req.body.sections.length
      ? req.body.sections.slice(0, 80)
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
      // The quiz comes ONLY from the topic(s) just taught. The unit's objectives and assignment are
      // used only when the caller asks for a whole-unit quiz (wholeUnit: true).
      if (firstItem && req.body.wholeUnit === true) {
        outcomesText = specialText(doc, firstItem.ownerId, "outcomes", 1500);
        practiceText = specialText(doc, firstItem.ownerId, "exercise", 3500);
      }
    }
  }
  if (!sourceText) sourceText = String(req.body.lessonText || "").slice(0, 12000);
  if (sourceText.length < 80) return res.status(400).json({ error: "There is not enough lesson text to make a quiz from." });

  let count = sourceText.length < 1500 ? 4 : sourceText.length < 5000 ? 6 : 8;
  // Big quizzes ask for a set size (3 to 15 per request) and send the questions already used, so none repeat
  if (Number(req.body.count) >= 3) count = Math.min(Math.floor(Number(req.body.count)), 15);
  const avoid = Array.isArray(req.body.avoid) ? req.body.avoid.slice(0, 60).map(function (q) { return String(q).slice(0, 140); }) : [];
  const key = cacheKey(["quiz", level, difficulty, approach, String(round), lessonTitle, sourceText, outcomesText, practiceText, String(count), avoid.join("|")]);
  const saved = await readCache(key);
  if (saved) return res.json(Object.assign({}, saved, { cached: true }));

  const prompt =
    "Learner level: " + level + "\nDifficulty: " + difficulty + "\nLesson: " + lessonTitle + "\n" +
    "Write " + count + " questions." + (round > 0 ? " This is attempt " + (round + 1) + ": ask DIFFERENT questions from a typical first quiz, covering other details." : "") +
    (avoid.length ? "\nQuestions already asked (do NOT repeat or rephrase any of them):\n- " + avoid.join("\n- ") + "\n" : "") +
    (approach === "exam" || approach === "revision" ? " Exam style: prefer questions on exact definitions, terms and lists in the material." : "") +
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
    await writeCache(key, quiz);
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
store.ensureBucket();
app.listen(PORT, HOST, function () {
  console.log(store.online ? "Storage: Supabase (saved online, survives the server sleeping; accounts ON)" : "Storage: this computer's folders (docs and cache). Add SUPABASE_URL and SUPABASE_SECRET_KEY to use Supabase.");
  console.log("AI Lecturer server running at http://" + HOST + ":" + PORT);
  console.log(ACCESS_CODE ? "Access code is ON (daily limit " + DAILY_LIMIT + " per visitor)." : "Access code is OFF (fine on your own computer).");
  console.log("Models, in order: " + MODEL_LIST.join(" -> ") + (GROQ_KEY ? " -> " + GROQ_MODELS.map(function (m) { return "groq:" + m; }).join(" -> ") + " (last backup)" : "  (no Groq backup: add GROQ_API_KEY to use one)"));
  console.log("Time limit per try: " + TIMEOUT_MS / 1000 + "s, per request: " + TOTAL_MS / 1000 + "s");
});
