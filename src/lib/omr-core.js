// omr-core.js
// Pure OMR (Optical Mark Recognition) logic — sheet layout generation,
// canvas drawing, and photo-based bubble-sheet reading (corner detection,
// perspective correction, bubble darkness scoring). No React or DOM
// framework dependency beyond the standard Canvas 2D API, so this file can
// be imported directly into any Next.js page or API route that runs in a
// browser context (client component). For server-side/Node usage, canvas
// operations need a DOM-like canvas implementation (e.g. the `canvas` npm
// package) since this relies on document.createElement('canvas').

// ---------- Layout constants (must match between generator & scanner) ----------
const PAGE_W = 850, PAGE_H = 1100; // px at ~100dpi for A4-ish portrait (full sheet)
const PX_PER_MM = PAGE_W / 210; // scale derived from the full A4 portrait width
// Two "half A4" layouts. Both print two independent sheets on one A4 page
// with a cut line between them — the difference is which way the A4 sheet
// itself is cut:
//   'half'      — A4 portrait cut top-to-bottom into a left and right half,
//                  each 105mm wide x 297mm tall (portrait-shaped halves).
//   'halfLandscape' — A4 rotated to landscape (297x210mm) then cut
//                  left-right, each half 148.5mm wide x 210mm tall
//                  (landscape sheet, portrait-shaped half — shorter and
//                  wider than the 'half' variant).
// Both use the same px-per-mm scale as the full sheet so that MARKER/MARGIN/
// font sizes stay visually consistent across all three page sizes — just the
// canvas extent differs, with the question grid laid out fresh to fit each
// width (rather than shrinking the full layout, which would squash circles
// into ellipses).
const HALF_PAGE_W = Math.round(PAGE_W / 2), HALF_PAGE_H = PAGE_H;
const HALF_LANDSCAPE_PAGE_W = Math.round(148.5 * PX_PER_MM), HALF_LANDSCAPE_PAGE_H = Math.round(210 * PX_PER_MM);
// 'topBottom' — A4 portrait cut left-to-right (horizontally) into a top and
// bottom half, each full 210mm wide x 148.5mm tall. Uses a compact
// horizontal-ID-row layout (digits 0-9 laid out left-to-right per row, one
// row per ID digit) and a dense multi-column question grid, since a
// half-height sheet has far less vertical room than the other two variants.
const TOP_BOTTOM_PAGE_W = PAGE_W, TOP_BOTTOM_PAGE_H = Math.round(148.5 * PX_PER_MM);
const MARKER = 26; // fiducial square size
const MARGIN = 40;

// Printed-sheet layout versions (omr_quizzes.layout_version). A sheet must
// always be read back with the exact geometry it was printed with, so an
// old version is never changed — only new versions are added.
//   1: markers MARGIN (~10mm) from the paper edge — the original layout.
//   2: markers 20mm in, clear of where a teacher staples the stack and of
//      the dog-eared/crumpled corners sheets come back with; everything
//      else moves in with them, and rows tighten (never below 20px) only
//      when the question count would otherwise run past the bottom markers.
// Only the half-page layouts use this; the legacy topBottom/zipFull styles
// always stay on version 1 geometry.
const OMR_LAYOUT_VERSIONS = {
  1: { margin: MARGIN, adaptiveRowH: false, idBoxOffset: 44 },
  2: { margin: Math.round(20 * PX_PER_MM), adaptiveRowH: true, idBoxOffset: 44 },
  // Version-1 sheets printed before 17 Sep 2026: #236/#237 moved the
  // half-page ID box (and so the whole question grid below it) up 14px
  // without bumping the version, and those sheets share layout_version 1
  // with everything printed since. Never stored — the scanner tries it
  // only when 1 doesn't line up (see findFiducialsWithOrientation).
  '1-early': { margin: MARGIN, adaptiveRowH: false, idBoxOffset: 58 },
};
const CURRENT_OMR_LAYOUT_VERSION = 2;

// The geometries a sheet stored as layoutVersion may actually have been
// printed with — see OMR_LAYOUT_VERSIONS['1-early'].
function scanLayoutVariants(layoutVersion) {
  return omrLayoutParams(layoutVersion) === OMR_LAYOUT_VERSIONS[1] ? [1, '1-early'] : [layoutVersion];
}

function omrLayoutParams(layoutVersion) {
  return OMR_LAYOUT_VERSIONS[layoutVersion] || OMR_LAYOUT_VERSIONS[1];
}

// A printed marker's side ÷ the distance between the top two marker
// centres, for findFiducials' opts.expectedMarkerRatio.
function markerSizeRatio(pageW, pageH, margin = MARGIN) {
  const [tl, tr] = markerCenters(pageW, pageH, margin);
  return MARKER / (tr.x - tl.x);
}

// Page-space centres of the 4 printed markers, TL/TR/BL/BR — the points a
// photo's detected marker centroids are mapped onto.
function markerCenters(pageW, pageH, margin = MARGIN) {
  const half = MARKER / 2;
  return [
    { x: margin + half, y: margin + half },
    { x: pageW - margin - half, y: margin + half },
    { x: margin + half, y: pageH - margin - half },
    { x: pageW - margin - half, y: pageH - margin - half },
  ];
}

// Shared with exam-print.js and OMRPrepareTool.jsx: the `text` argument
// document.fonts.load() needs to actually load Sarabun's Thai glyphs before
// drawing to a <canvas>. Without a text argument, load() only guarantees
// its default representative string (effectively ASCII/Latin) is fetched —
// Google's Sarabun stylesheet subsets by unicode-range, shipping Thai
// script (U+0E01-0E5B) as a completely separate woff2 file from Latin, so
// an untargeted load() call never fetches the glyphs a Thai exam paper or
// answer sheet is almost entirely made of; the canvas silently keeps using
// the system fallback font for all of it. This full-coverage sample (every
// Thai consonant/vowel/tone-mark + digits) forces that subset to load,
// regardless of which specific words a given print job contains.
const THAI_GLYPH_SAMPLE = 'กขคฆงจฉชซฌญฎฏฐฑฒณดตถทธนบปผฝพฟภมยรลวศษสหฬอฮฤฦะัาำิีึืุูเแโใไๅๆ่้๊๋์ฯ0123456789';

// Shared with exam-print.js and OMRPrepareTool.jsx: verifies every font in
// fontSpecs is actually ready before returning, instead of the more common
// "fire document.fonts.load() and best-effort try/catch around it" pattern
// this replaced — the teacher explicitly does not want a printed exam ever
// silently substituting the browser's own fallback font for Sarabun, even
// just for one slow/flaky request. document.fonts.load() resolving is not
// by itself sufficient proof: it can settle even when its underlying fetch
// didn't actually complete cleanly in every browser, so this always
// re-confirms with document.fonts.check() (which only reports true once a
// font is genuinely available for use), retrying the load a few times
// before giving up. Throws — rather than silently falling through to draw
// with whatever's on hand — only once real, likely-transient failure (a
// flaky connection to Google Fonts, most plausibly) survives every retry,
// so callers should let this reject the whole print/export instead of
// swallowing it, and show the teacher a clear "ลองใหม่อีกครั้ง" instead of
// silently handing back a document in the wrong font.
async function ensureFontsLoaded(fontSpecs, sampleText = THAI_GLYPH_SAMPLE) {
  if (typeof document === 'undefined' || !document.fonts) return; // no Font Loading API — nothing to verify against
  for (const spec of fontSpecs) {
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await document.fonts.load(spec, sampleText);
      } catch {
        // fall through — the check below and the retry loop handle a real failure
      }
      ok = document.fonts.check(spec, sampleText);
      if (!ok && attempt < 3) await new Promise(resolve => setTimeout(resolve, 400 * attempt));
    }
    if (!ok) {
      throw new Error(`โหลดฟอนต์ไม่สำเร็จ (${spec}) — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่อีกครั้ง`);
    }
  }
}

function buildLayout(numQuestions, numChoices, idDigits, pageW = PAGE_W, pageH = PAGE_H, layoutStyle = 'auto', forcedCols, layoutVersion = 1) {
  // Returns bubble center coordinates for each question/choice, and ID grid.
  // layoutStyle picks which template to use — 'auto' infers from pageW for
  // backward compatibility (narrow width = half-page template), but callers
  // that know their variant (e.g. topBottom, which is full-width but
  // half-height) should pass it explicitly, since width alone can't
  // distinguish "half-page" from "top/bottom half" when both share the same
  // width but different heights.
  const resolvedStyle = layoutStyle !== 'auto' ? layoutStyle : (pageW < PAGE_W * 0.75 ? 'halfPortrait' : 'zipFull');

  if (resolvedStyle === 'topBottom') {
    // Compact layout for a half-height (full-width) sheet: a boxed header
    // row (name/class on the left, student-ID grid boxed and right-aligned
    // to the page edge) above a dense multi-column question grid — needed
    // because a half-height sheet has far less vertical room than a
    // full-height page. All Y values below are ABSOLUTE page coordinates
    // (MARGIN baked in), consistent with every other layout style, so
    // callers never need to re-add MARGIN themselves. No subject/topic line
    // in this style — just the title.
    const titleBottom = MARGIN + 34;
    const headerBoxY = titleBottom + 10;
    const idRowH = 20, idColGap = 22;
    const idLabelH = 16; // space inside the ID box for its label + 0-9 header row
    const idBoxH = idLabelH + idDigits * idRowH + 14; // padding top/bottom
    const nameBoxH = idBoxH; // both header boxes share the same height

    // ID box is right-aligned to the page edge; its width is driven by how
    // many digit columns (0-9) it needs to fit.
    const idGridW = 9 * idColGap + 16;
    const idBoxW = idGridW + 26;
    // Keep the ID box clear of the top-right fiducial marker (must not be
    // drawn over — the marker needs to stay a clean solid square for
    // detection), not just clear of the page margin.
    const idBoxX = pageW - MARGIN - MARKER - 10 - idBoxW;
    const idStartX = idBoxX + 20;
    const idStartY = headerBoxY + idLabelH + 16;

    // Name/class box fills the remaining width to the left of the ID box.
    const nameBoxX = MARGIN;
    const nameBoxGap = 20;
    const nameBoxW = idBoxX - nameBoxGap - nameBoxX;

    const idGrid = [];
    for (let d = 0; d < idDigits; d++) {
      const digits = [];
      for (let v = 0; v <= 9; v++) {
        digits.push({ x: idStartX + v * idColGap, y: idStartY + d * idRowH, r: 7, value: v });
      }
      idGrid.push(digits);
    }
    const idBottom = idStartY + (idDigits - 1) * idRowH;

    const headerBoxBottom = headerBoxY + idBoxH;
    const instructionY = headerBoxBottom + 20;

    // qStartY needs enough clearance below instructionY for BOTH the
    // instruction text itself AND the "ก ข ค ง" choice-letter header row
    // drawn above qStartY.
    const qStartY = instructionY + 24;
    const rowH = 22;
    const bubbleR = 7;
    const choiceGap = 20;
    const qLabelW = 26;
    const usableW = pageW - MARGIN * 2;
    const colGap = 30;
    const numCols = 5;
    const colW = (usableW - colGap * (numCols - 1)) / numCols;
    const perCol = Math.ceil(numQuestions / numCols);

    const questions = [];
    for (let q = 0; q < numQuestions; q++) {
      const col = Math.floor(q / perCol);
      const rowInCol = q % perCol;
      const x0 = MARGIN + col * (colW + colGap) + qLabelW;
      const y = qStartY + rowInCol * rowH;
      const choices = [];
      for (let c = 0; c < numChoices; c++) choices.push({ x: x0 + c * choiceGap, y, r: bubbleR });
      questions.push({ index: q, labelX: MARGIN + col * (colW + colGap), labelY: y, choices, col });
    }

    return {
      questions, idGrid, cols: numCols, perCol, layoutStyle: 'topBottom', margin: MARGIN,
      titleBottom, headerBoxY, idBoxH, nameBoxH, idBoxW, idBoxX, idStartX, idStartY, idColGap, idBottom,
      nameBoxX, nameBoxW, headerBoxBottom, instructionY, qStartY, colW, colGap,
    };
  }

  if (resolvedStyle === 'zipFull') {
    // Full-page layout, ZipGrade-style: student ID runs vertically in the
    // top-left (one column per digit, 0-9 stacked top to bottom starting
    // from 1), and questions wrap across 3 columns so that up to ~50
    // questions fit on one page without the sheet growing taller than A4.
    // All 3 columns start at the same y, below the ID grid — this keeps
    // question rows aligned across columns (a cleaner, more predictable
    // look than letting column 1 start lower than 2/3, which left a large
    // uneven gap at low question counts).
    const headerBottom = 235; // bottom of the name/class/date/quiz header block
    const idColW = 20, idRowH = 20, idStartX = MARGIN, idStartY = headerBottom + 24;
    const idGrid = [];
    for (let d = 0; d < idDigits; d++) {
      const digits = [];
      for (let v = 1; v <= 10; v++) { // ZipGrade order: 1,2,...,9,0 top to bottom
        const value = v === 10 ? 0 : v;
        digits.push({ x: idStartX + d * idColW, y: idStartY + (v - 1) * idRowH, r: 7, value });
      }
      idGrid.push(digits);
    }
    const idBottom = idStartY + 9 * idRowH;

    const qStartY = idBottom + 40; // every column starts here, below the ID grid
    const rowH = 22;
    const bubbleR = 7;
    const choiceGap = 22;
    const qLabelW = 26;
    const usableW = pageW - MARGIN * 2;
    const colGap = 36;
    const colW = (usableW - colGap * 2) / 3;
    const perCol = Math.ceil(numQuestions / 3);

    const questions = [];
    for (let q = 0; q < numQuestions; q++) {
      const col = Math.floor(q / perCol);
      const rowInCol = q % perCol;
      const x0 = MARGIN + col * (colW + colGap) + qLabelW;
      const y = qStartY + rowInCol * rowH;
      const choices = [];
      for (let c = 0; c < numChoices; c++) choices.push({ x: x0 + c * choiceGap, y, r: bubbleR });
      questions.push({ index: q, labelX: MARGIN + col * (colW + colGap), labelY: y, choices, col });
    }

    return { questions, idGrid, cols: 3, perCol, layoutStyle: 'zipFull', margin: MARGIN, headerBottom, idStartX, idStartY, idColW, idBottom, qStartY, colW, colGap };
  }

  // pageW controls how many columns the questions wrap into: a narrower page
  // (half-sheet) naturally fits fewer question-columns per available width,
  // so this recomputes the wrap point based on the actual page width rather
  // than assuming the full-page width always (see the column-count picking
  // below, after startY is known).
  const { margin: M, adaptiveRowH, idBoxOffset } = omrLayoutParams(layoutVersion);
  const usableW = pageW - M * 2;
  // 26 left the last row of a 20-row column (e.g. 60 questions x 3 columns,
  // or 40 x 2) sitting just ~2px above the bottom fiducial marker — visibly
  // crowded. 24 still leaves an 8px gap between adjacent bubbles (16px
  // diameter), but frees up ~40px of clearance at the bottom for the
  // worst-case 20-row column.
  let rowH = 24;

  // Student ID grid sits below the title/name lines on the half sheet, as a
  // bordered box (too narrow to place it beside the title like the full
  // sheet does), right-aligned to the page edge — same row-per-digit,
  // column-per-value (0-9) arrangement as the 'topBottom' style (one filled
  // bubble per row, a single 0-9 header row shared across all digits,
  // rather than the value printed inside every bubble), and the same
  // right-aligned placement 'topBottom' uses for its ID box too.
  const idLabelH = 16;
  const idRowH = 20, idColGap = 22;
  const idBoxW = 9 * idColGap + 30;
  const idBoxH = idLabelH + idDigits * idRowH + 14;
  const idBoxY = M + MARKER + idBoxOffset; // clears the name line + the ชั้น/เลขที่ line below it
  // Keep clear of the top-right fiducial marker, not just the page margin.
  const idBoxX = pageW - M - MARKER - 10 - idBoxW;
  const idStartX = idBoxX + 16;
  const idStartY = idBoxY + idLabelH + 16;

  // Questions start right below the ID box (not a fixed offset) so this
  // still fits a shorter page — e.g. the 'halfLandscape' variant, at 210mm
  // tall vs. 'half's 297mm — without the question grid running off the
  // bottom edge.
  const startY = idBoxY + idBoxH + 26;

  // Column count picks itself: first, how many rows actually fit below
  // startY without crowding the bottom fiducial marker; a question count
  // that would overflow that (e.g. 60 questions, which needs ~30 rows in 2
  // columns) bumps the column count up until each column's row count fits.
  // This used to require the teacher to manually tick a "3 columns" box for
  // large question counts — easy to forget, and forgetting it silently
  // produced a sheet with rows running off the bottom edge.
  // Version 2 gives up ~40px of height to its wider margin, so it plans
  // columns as if rows were 21px (e.g. 40 questions stays 2 columns rather
  // than jumping to 3 dense ones), then sizes rows back up to 24px when
  // they fit — see the adaptiveRowH block below.
  const availH = pageH - M - MARKER - startY;
  const maxRowsPerCol = Math.max(1, Math.floor(availH / (adaptiveRowH ? 21 : rowH)));
  const baseCols = numQuestions > 30 ? 2 : (pageW < PAGE_W * 0.75 && numQuestions > 12 ? 2 : 1);
  const autoCols = Math.max(baseCols, Math.ceil(numQuestions / maxRowsPerCol));
  // A caller can still force a specific column count (e.g. to reproduce the
  // exact layout an already-printed sheet used) via forcedCols — bubble/gap
  // sizing shrinks a bit ("dense" mode) so 3+ columns still fits the
  // narrower half-page width without crowding.
  const dense = (forcedCols || autoCols) >= 3;
  // Bubble radius stays full-size (8) even in dense mode — the current
  // 3-column use case (60 questions on the landscape-half layout, ~174px
  // per column) has enough width margin to not need smaller circles, and
  // smaller ones are harder to fill accurately with a pencil.
  const bubbleR = 8;
  const choiceGap = dense ? 22 : 26;
  const qLabelW = dense ? 28 : 40; // must clear the 2-digit "01." label text (12px font) before the first bubble starts
  const singleColW = dense ? 120 : 140; // approx width needed for qLabel + 4-5 choice bubbles
  const maxCols = Math.max(1, Math.floor(usableW / singleColW));
  const cols = forcedCols || Math.min(autoCols, maxCols);
  const perCol = Math.ceil(numQuestions / cols);
  const colW = usableW / cols;
  if (adaptiveRowH) {
    rowH = Math.min(24, Math.max(20, Math.floor(availH / perCol)));
  }

  const questions = [];
  for (let q = 0; q < numQuestions; q++) {
    const col = Math.floor(q / perCol);
    const rowInCol = q % perCol;
    const x0 = M + col * colW + qLabelW;
    const y = startY + rowInCol * rowH;
    const choices = [];
    for (let c = 0; c < numChoices; c++) {
      choices.push({ x: x0 + c * choiceGap, y, r: bubbleR });
    }
    questions.push({ index: q, labelX: M + col * colW, labelY: y, choices });
  }

  const idGrid = [];
  for (let d = 0; d < idDigits; d++) {
    const digits = [];
    for (let v = 0; v <= 9; v++) {
      digits.push({ x: idStartX + v * idColGap, y: idStartY + d * idRowH, r: 7, value: v });
    }
    idGrid.push(digits);
  }

  return {
    questions, idGrid, cols, perCol, layoutStyle: 'halfPortrait', margin: M, rowH,
    idBoxX, idBoxY, idBoxW, idBoxH, idLabelH, idStartX, idStartY, idColGap,
  };
}

function drawFiducials(ctx, pageW = PAGE_W, pageH = PAGE_H, margin = MARGIN) {
  ctx.fillStyle = '#000';
  const positions = [
    [margin, margin],
    [pageW - margin - MARKER, margin],
    [margin, pageH - margin - MARKER],
    [pageW - margin - MARKER, pageH - margin - MARKER],
  ];
  positions.forEach(([x, y]) => ctx.fillRect(x, y, MARKER, MARKER));
  return positions;
}

// Prints the same "รหัส 007" stamp used on the question paper, right-aligned
// to just clear the top-right fiducial marker (never over it — that square
// must stay solid for scan-time corner detection) so a teacher can match a
// scanned answer sheet back to its ชุดข้อสอบ. Only drawn when the quiz
// carries a set_code — most do not (quizzes made directly in เตรียมข้อสอบ,
// never synced from a printed ชุดข้อสอบ, have none).
function drawSetCodeStamp(ctx, pageW, y, setCode, margin = MARGIN) {
  if (!Number.isFinite(setCode)) return;
  ctx.save();
  ctx.font = '11px "Sarabun", sans-serif';
  ctx.fillStyle = '#000';
  ctx.textAlign = 'right';
  ctx.fillText(`รหัส ${String(setCode).padStart(3, '0')}`, pageW - margin - MARKER - 10, y);
  ctx.restore();
}

// Thai script has no spaces between words, so a plain whitespace split
// treats an entire unspaced sentence as one giant "word" — wrapping it
// then requires cutting mid-word at an arbitrary character position,
// which can slice through a combining vowel/tone sequence and produce a
// broken, nonsensical syllable (e.g. "และ" cut into "แ" + "ละ"). Intl's
// Thai dictionary-based word segmenter finds the real word boundaries
// instead, so wrapping never has to cut inside a word in the common case.
// Falls back to null (handled below) on a runtime without Intl.Segmenter.
const thaiSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('th', { granularity: 'word' })
  : null;

// Unlike our own canvas-drawn PDF (which wraps text itself via wrapText
// above), a real Word document lets Word's own layout engine decide line
// breaks — but Word can only break where it's actually told a break is
// allowed, and it has no built-in notion of Thai word boundaries on its
// own. Splicing a zero-width space (U+200B — invisible, no visual effect)
// between every word this same Intl.Segmenter finds gives Word an explicit
// break opportunity at each one, the same technique the "thai-docx" agent
// skill uses via Python's pythainlp. Returns text unchanged if there's
// nothing to segment or Intl.Segmenter isn't available.
function insertThaiZwsp(text) {
  if (!text || !thaiSegmenter) return text;
  return [...thaiSegmenter.segment(text)].map(s => s.segment).join('\u200b');
}

// Word-wraps text to fit maxWidth on the canvas ctx's current font.
// firstLineMaxWidth (defaults to maxWidth) narrows only the very first
// wrapped line — for a caller that draws a label before the wrapped text
// starts on that first line (e.g. a bold ตัวชี้วัด code before its
// description) and wants every OTHER line flush left, unindented, while
// still guaranteeing the first line plus the label never exceeds the
// column's own right edge.
function wrapText(ctx, text, maxWidth, firstLineMaxWidth = maxWidth) {
  const lines = [];
  const widthFor = () => (lines.length === 0 ? firstLineMaxWidth : maxWidth);
  // Explicit newlines (e.g. a teacher's numbered คำชี้แจง list, one item
  // per line) are a forced break, not just whitespace to collapse — wrap
  // each \n-separated paragraph independently rather than letting the
  // word-wrap below flow line 2 onto the end of line 1's wrapped text.
  for (const para of text.split('\n')) {
    if (para.length === 0) { lines.push(''); continue; }
    // Each segment (a word, a run of whitespace, or a punctuation mark) is
    // treated as an atomic unit and concatenated directly — Intl.Segmenter
    // already includes any actual spaces in the source as their own
    // segments, so no extra separator needs to be inserted between them
    // (unlike English-style whitespace-split wrapping).
    const segments = thaiSegmenter
      ? [...thaiSegmenter.segment(para)].map(s => s.segment)
      : para.split(/(\s+)/).filter(Boolean);
    let line = '';
    for (let seg of segments) {
      while (ctx.measureText(seg).width > widthFor()) {
        // Last-resort hard-break: only reached for a single dictionary
        // word/token still wider than the whole column on its own (rare —
        // a very long compound word or number) or when Intl.Segmenter is
        // unavailable.
        let cut = seg.length;
        while (cut > 1 && ctx.measureText(seg.slice(0, cut)).width > widthFor()) cut--;
        if (line) { lines.push(line); line = ''; }
        lines.push(seg.slice(0, cut));
        seg = seg.slice(cut);
      }
      const candidate = line + seg;
      if (line && ctx.measureText(candidate).width > widthFor()) {
        lines.push(line);
        line = seg;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// Draws "label" followed by a blank line stretching from right after the
// label to lineEndX, on the ctx's current font/fillStyle — used for
// fill-in-the-blank fields (name/class/number) whose blank should reach a
// specific right edge (e.g. flush with the note text column) rather than a
// fixed number of underscore characters, which looks arbitrarily short on
// wider pages and doesn't adapt if the label text itself changes width.
// Returns the x position right after the label, for a caller that needs to
// start a second label/blank further along the same line.
function drawFillLine(ctx, label, x, y, lineEndX) {
  ctx.fillText(label, x, y);
  const afterLabelX = x + ctx.measureText(label).width + 4;
  ctx.beginPath();
  ctx.moveTo(afterLabelX, y + 2);
  ctx.lineTo(lineEndX, y + 2);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1.4;
  // จุดไข่ปลา (a dotted fill-in line) rather than a solid underline — a
  // near-zero dash length with a round cap draws as a small round dot, not
  // a short dash, so this reads as evenly-spaced dots.
  ctx.lineCap = 'round';
  ctx.setLineDash([0.1, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineCap = 'butt';
  return afterLabelX;
}

// Draws text on the ctx's current font, truncating with a trailing "…" if
// it would otherwise exceed maxWidth — used for values with no natural
// length limit (a real student name pulled from the roster, unlike a fixed
// label) so they can never run into whatever sits to their right.
function fillTextClipped(ctx, text, x, y, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  let clipped = text;
  while (clipped.length > 1 && ctx.measureText(clipped + '…').width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  ctx.fillText(clipped + '…', x, y);
}

function choiceLetters(scheme, n) {
  if (scheme === 'thai') return ['ก','ข','ค','ง','จ'].slice(0, n);
  if (scheme === 'num') return ['1','2','3','4','5'].slice(0, n);
  return ['A','B','C','D','E'].slice(0, n);
}

// The layout math throughout this file targets ~100dpi (PAGE_W=850px for a
// 210mm-wide sheet) — fine on screen, but text/circles print visibly soft
// at that resolution once stretched to true physical size. drawSheet
// renders at PRINT_SCALE times that pixel density instead (canvas.toDataURL
// then exports a proportionally larger PNG) while every coordinate in
// buildLayout/drawSheet itself stays in the original ~100dpi logical units —
// ctx.scale() maps them onto the higher-resolution canvas transparently, so
// nothing else in this file needs to change. This only affects the
// generator's rendered/exported image; it has no effect on scanning, which
// always resamples the photographed sheet to the logical pageW x pageH via
// warpImage regardless of the camera's own resolution.
const PRINT_SCALE = 3;

function drawSheet(canvas, opts, answers) {
  const pageW = opts.pageW || PAGE_W;
  const pageH = opts.pageH || PAGE_H;
  const layoutStyle = opts.layoutStyle || 'auto';
  const ctx = canvas.getContext('2d');
  canvas.width = pageW * PRINT_SCALE; canvas.height = pageH * PRINT_SCALE;
  ctx.scale(PRINT_SCALE, PRINT_SCALE);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageW, pageH);

  const layout = buildLayout(opts.numQuestions, opts.numChoices, opts.idDigits, pageW, pageH, layoutStyle, opts.cols, opts.layoutVersion);
  const letters = choiceLetters(opts.scheme, opts.numChoices);
  const resolvedStyle = layout.layoutStyle;

  if (resolvedStyle === 'topBottom') {
    // ---------- Compact boxed-header layout, for a half-height sheet ----------
    // Renders ONE such sheet; the caller draws this twice (top half + bottom
    // half) onto a full A4 canvas with its own fiducial markers each time.
    drawFiducials(ctx, pageW, pageH);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 16px "Sarabun", sans-serif';
    ctx.fillText(opts.title || 'กระดาษคำตอบ', MARGIN + MARKER + 8, MARGIN + 16);
    drawSetCodeStamp(ctx, pageW, MARGIN + 16, opts.setCode);

    // Left box: name + class/room/no, two rows separated by a line.
    const nameBoxY = layout.headerBoxY, nameBoxH = layout.nameBoxH;
    const nameBoxX = layout.nameBoxX, nameBoxW = layout.nameBoxW;
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2;
    ctx.strokeRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH);
    ctx.beginPath();
    ctx.moveTo(nameBoxX, nameBoxY + nameBoxH / 2);
    ctx.lineTo(nameBoxX + nameBoxW, nameBoxY + nameBoxH / 2);
    ctx.stroke();
    ctx.font = '11px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
    ctx.fillText('ชื่อ-สกุล: ________________________________', nameBoxX + 8, nameBoxY + nameBoxH * 0.32 + 4);
    ctx.fillText('ชั้น/ห้อง: _______  เลขที่: _______', nameBoxX + 8, nameBoxY + nameBoxH * 0.82 + 4);

    // Right box: student ID grid, right-aligned to the page edge.
    ctx.strokeRect(layout.idBoxX, layout.headerBoxY, layout.idBoxW, layout.idBoxH);
    ctx.font = 'bold 11px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
    ctx.fillText('เลขประจำตัวนักเรียน (ฝนบรรทัดละ 1 ตัว)', layout.idBoxX + 10, layout.headerBoxY + 14);

    // Column headers 0-9 above the ID rows
    ctx.font = 'bold 10px "Sarabun", sans-serif'; ctx.fillStyle = '#666';
    for (let v = 0; v <= 9; v++) {
      ctx.fillText(String(v), layout.idStartX + v * layout.idColGap - 3, layout.idStartY - 10);
    }

    layout.idGrid.forEach((digitRow, d) => {
      digitRow.forEach((cell) => {
        ctx.beginPath();
        ctx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2; ctx.stroke();
        if (answers && answers.studentId && answers.studentId[d] === String(cell.value)) {
          ctx.beginPath();
          ctx.arc(cell.x, cell.y, cell.r - 2, 0, Math.PI * 2);
          ctx.fillStyle = '#000'; ctx.fill();
        }
      });
    });

    ctx.font = '9px "Sarabun", sans-serif'; ctx.fillStyle = '#555';
    ctx.fillText('คำชี้แจง: ใช้ดินสอ 2B ระบายวงกลมคำตอบให้เต็มวง ข้อละ 1 ตัวเลือก', MARGIN, layout.instructionY);

    // Column choice-letter headers, once per question column
    ctx.font = 'bold 9px "Sarabun", sans-serif';
    for (let col = 0; col < layout.cols; col++) {
      const q0 = layout.questions.find(q => q.col === col);
      if (!q0) continue;
      letters.forEach((L, ci) => {
        ctx.fillStyle = '#666';
        ctx.fillText(L, q0.choices[ci].x - 3, q0.labelY - 11);
      });
    }

    ctx.font = '10px "Sarabun", sans-serif';
    layout.questions.forEach((q) => {
      ctx.fillStyle = '#000';
      ctx.fillText(String(q.index + 1) + '.', q.labelX, q.labelY + 3);
      q.choices.forEach((c, ci) => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2; ctx.stroke();
        const filled = answers && answers.responses && answers.responses[q.index] === ci;
        if (filled) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, c.r - 2, 0, Math.PI * 2);
          ctx.fillStyle = '#000'; ctx.fill();
        }
      });
    });

    return layout;
  }

  drawFiducials(ctx, pageW, pageH, layout.margin);

  if (resolvedStyle === 'zipFull') {
    // ---------- ZipGrade-style full-page layout ----------
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 18px "Sarabun", sans-serif';
    ctx.fillText(opts.title || 'กระดาษคำตอบ', MARGIN + MARKER + 10, MARGIN + 18);
    drawSetCodeStamp(ctx, pageW, MARGIN + 18, opts.setCode);
    ctx.font = '11px "Sarabun", sans-serif';
    ctx.fillText(opts.subject || '', MARGIN + MARKER + 10, MARGIN + 36);

    // Name / Class / Date / Quiz header box, roughly matching the reference:
    // a two-row box with labeled cells, positioned below the title/subject
    // and above where the ID grid + questions begin.
    const boxX = MARGIN + MARKER + 10, boxY = MARGIN + 50;
    const boxW = pageW - MARGIN - MARKER - 20 - boxX;
    const boxH = 70, rowH2 = boxH / 2;
    const labelW = 55, dateLabelX = boxX + boxW * 0.62;
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2;
    ctx.strokeRect(boxX, boxY, boxW, boxH);
    ctx.beginPath(); ctx.moveTo(boxX, boxY + rowH2); ctx.lineTo(boxX + boxW, boxY + rowH2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(boxX + labelW, boxY); ctx.lineTo(boxX + labelW, boxY + boxH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dateLabelX, boxY); ctx.lineTo(dateLabelX, boxY + boxH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dateLabelX - labelW, boxY); ctx.lineTo(dateLabelX - labelW, boxY + boxH); ctx.stroke();
    ctx.font = 'bold 10px "Sarabun", sans-serif'; ctx.fillStyle = '#333';
    ctx.fillText('ชื่อ', boxX + 6, boxY + 15);
    ctx.fillText('ชั้น', boxX + 6, boxY + rowH2 + 15);
    ctx.fillText('วันที่', dateLabelX - labelW + 6, boxY + 15);
    ctx.fillText('รหัสวิชา', dateLabelX - labelW + 6, boxY + rowH2 + 15);

    const headerBottom = layout.headerBottom;

    // Student ID grid header + digits
    ctx.font = '10px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
    ctx.fillText('รหัสนักเรียน', layout.idStartX, headerBottom + 16);
    layout.idGrid.forEach((digitCol) => {
      digitCol.forEach((cell) => {
        ctx.beginPath();
        ctx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
        ctx.font = '8px "Sarabun", sans-serif'; ctx.fillStyle = '#333';
        ctx.fillText(String(cell.value), cell.x - 3, cell.y + 3);
        const digitIndex = layout.idGrid.indexOf(digitCol);
        if (answers && answers.studentId && answers.studentId[digitIndex] === String(cell.value)) {
          ctx.beginPath();
          ctx.arc(cell.x, cell.y, cell.r - 2, 0, Math.PI * 2);
          ctx.fillStyle = '#000'; ctx.fill();
        }
      });
    });

    // Column choice-letter headers, once per question column, positioned
    // just above that column's first question row (columns 2 & 3 start
    // higher than column 1, which starts below the ID grid).
    ctx.font = 'bold 10px "Sarabun", sans-serif';
    for (let col = 0; col < 3; col++) {
      const q0 = layout.questions.find(q => q.col === col);
      if (!q0) continue;
      letters.forEach((L, ci) => {
        ctx.fillStyle = '#666';
        ctx.fillText(L, q0.choices[ci].x - 4, q0.labelY - 12);
      });
    }

    ctx.font = '11px "Sarabun", sans-serif';
    layout.questions.forEach((q) => {
      ctx.fillStyle = '#000';
      ctx.fillText(String(q.index + 1), q.labelX, q.labelY + 4);
      q.choices.forEach((c, ci) => {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1.1; ctx.stroke();
        const filled = answers && answers.responses && answers.responses[q.index] === ci;
        if (filled) {
          ctx.beginPath();
          ctx.arc(c.x, c.y, c.r - 2, 0, Math.PI * 2);
          ctx.fillStyle = '#000'; ctx.fill();
        }
      });
    });

    return layout;
  }

  // ---------- Half-page layout ----------
  const M = layout.margin;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 18px "Sarabun", sans-serif';
  ctx.fillText(opts.title || 'กระดาษคำตอบ', M + MARKER + 10, M + 16);
  drawSetCodeStamp(ctx, pageW, M + 16, opts.setCode, M);
  ctx.font = '10px "Sarabun", sans-serif';
  ctx.fillText(opts.subject || '', M + MARKER + 10, M + 30);

  // Half-page header is a vertical stack: title, subject, then the name
  // line, then a ชั้น/เลขที่ line below it (not sharing a baseline with the
  // subject). Baselines are spaced 20px apart — enough clearance at the
  // header's 14px font for Thai vowel marks that sit above/below the
  // baseline (e.g. ชื่อ, สกุล) not to visually crowd the line above/below.
  // Each fill-in blank stretches all the way to idBoxRightEdge, the same
  // right boundary the note text below wraps to, instead of stopping short
  // at a fixed number of underscores — unless the caller already knows the
  // student (batch-generating one sheet per class roster entry), in which
  // case the actual name/class/number is printed directly instead of a
  // blank for the student to fill in.
  // Hand-written student-ID line, above the bubble box (not inside it) — a
  // human-readable line where the student writes the ID digits in plain
  // numerals, as a redundancy check alongside filling in the bubbles below
  // (matches the box's own digit count, so it never overflows the box's
  // width even if idDigits differs from the current fixed default of 5).
  // Right-aligned within the ID box's width (flush with its right edge,
  // same as the box below it) rather than starting at its left edge, so a
  // long studentName on the line below has as much clearance as possible
  // before the two would visually collide — computed up here, before the
  // name line, so that line can use it as a hard right boundary.
  // When the caller already knows the student's ID (batch-generating one
  // sheet per class roster entry), each digit is pre-printed inside its box
  // too, matching the pre-filled bubbles below — same as the name/class/
  // number lines above, the student can still see and verify it, they just
  // don't have to write it out themselves.
  const numIdDigits = layout.idGrid.length;
  const writeBoxGap = 4;
  const writeBoxSize = Math.min(20, Math.floor((layout.idBoxW - (numIdDigits - 1) * writeBoxGap) / numIdDigits));
  const writeBoxesW = numIdDigits * writeBoxSize + (numIdDigits - 1) * writeBoxGap;
  const writeBoxStartX = layout.idBoxX + layout.idBoxW - writeBoxesW;
  const writeBoxY = M + MARKER + 16;
  ctx.font = 'bold 10px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
  ctx.fillText('เลขประจำตัวนักเรียน', writeBoxStartX, M + MARKER + 10);
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
  for (let i = 0; i < numIdDigits; i++) {
    const bx = writeBoxStartX + i * (writeBoxSize + writeBoxGap);
    ctx.strokeRect(bx, writeBoxY, writeBoxSize, writeBoxSize);
    if (answers && answers.studentId && answers.studentId[i] != null) {
      ctx.font = 'bold 12px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.fillText(String(answers.studentId[i]), bx + writeBoxSize / 2, writeBoxY + writeBoxSize - 5);
      ctx.textAlign = 'left';
    }
  }

  ctx.font = '14px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
  const idBoxRightEdge = layout.idBoxX - 10;
  const nameLineY = M + MARKER + 26;
  const classLineY = nameLineY + 20;
  // A batch-generated sheet prints the real student name from the roster,
  // which (unlike the blank fill-in line) has no natural length limit — cap
  // it at the write-in ID boxes' own left edge so a long name can never
  // run into them, regardless of how long a name actually is.
  const nameMaxW = writeBoxStartX - M - 12;
  if (opts.studentName) {
    fillTextClipped(ctx, `ชื่อ: ${opts.studentName}`, M, nameLineY, nameMaxW);
  } else {
    drawFillLine(ctx, 'ชื่อ:', M, nameLineY, idBoxRightEdge);
  }
  const classLineMidX = M + (idBoxRightEdge - M) * 0.5;
  if (opts.studentClass) {
    fillTextClipped(ctx, `ชั้น: ${opts.studentClass}`, M, classLineY, classLineMidX - M - 12);
  } else {
    drawFillLine(ctx, 'ชั้น:', M, classLineY, classLineMidX);
  }
  if (opts.studentNumber != null) {
    ctx.fillText(`เลขที่: ${opts.studentNumber}`, classLineMidX + 16, classLineY);
  } else {
    drawFillLine(ctx, 'เลขที่:', classLineMidX + 16, classLineY, idBoxRightEdge);
  }

  // Free-form teacher note, printed in the block of blank space to the left
  // of the ID box (same vertical band as the box itself) — word-wrapped and
  // capped at a fixed number of lines so it can never grow into the ID box
  // or down into the question grid, regardless of how much text is typed.
  if (opts.note) {
    ctx.font = '12px "Sarabun", sans-serif'; ctx.fillStyle = '#333';
    const noteMaxW = layout.idBoxX - M - 10;
    const noteLineH = 16;
    wrapText(ctx, opts.note, noteMaxW).slice(0, 8).forEach((ln, i) => {
      ctx.fillText(ln, M, layout.idBoxY + 8 + i * noteLineH);
    });
  }

  // Student-ID box: bordered, with a "ฝนบรรทัดละ 1 ตัว" label and a single
  // 0-9 header row shared across every digit row below it — same
  // arrangement as the 'topBottom' style's ID box (row = digit position,
  // column = value), rather than printing the value inside every bubble.
  ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2;
  ctx.strokeRect(layout.idBoxX, layout.idBoxY, layout.idBoxW, layout.idBoxH);
  ctx.font = 'bold 9px "Sarabun", sans-serif'; ctx.fillStyle = '#000';
  ctx.fillText('เลขประจำตัวนักเรียน (ฝนบรรทัดละ 1 ตัว)', layout.idBoxX + 8, layout.idBoxY + 12);

  ctx.font = 'bold 9px "Sarabun", sans-serif'; ctx.fillStyle = '#666';
  for (let v = 0; v <= 9; v++) {
    ctx.fillText(String(v), layout.idStartX + v * layout.idColGap - 3, layout.idStartY - 9);
  }

  layout.idGrid.forEach((digitRow, d) => {
    digitRow.forEach((cell) => {
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
      if (answers && answers.studentId && answers.studentId[d] === String(cell.value)) {
        ctx.beginPath();
        ctx.arc(cell.x, cell.y, cell.r - 2, 0, Math.PI * 2);
        ctx.fillStyle = '#000'; ctx.fill();
      }
    });
  });

  // Divider separating the header block (title/name/class/ID box/note)
  // from the question grid below — without it, a longer note ran straight
  // into the "ก ข ค ง" column headers with nothing marking where one
  // section ends and the other begins.
  const dividerY = layout.questions[0].labelY - 22;
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M, dividerY);
  ctx.lineTo(pageW - M, dividerY);
  ctx.stroke();

  // Header row for choice letters (once per column)
  ctx.font = 'bold 12px "Sarabun", sans-serif';
  for (let col = 0; col < layout.cols; col++) {
    letters.forEach((L, ci) => {
      const q0 = layout.questions.find(q => q.index === col * layout.perCol);
      if (!q0) return;
      const x = q0.choices[ci].x;
      ctx.fillStyle = '#666';
      ctx.fillText(L, x - 4, layout.questions[0].labelY - 12);
    });
  }

  ctx.font = '12px "Sarabun", sans-serif';
  layout.questions.forEach((q) => {
    ctx.fillStyle = '#000';
    ctx.fillText(String(q.index + 1).padStart(2, '0'), q.labelX, q.labelY + 4);
    q.choices.forEach((c, ci) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2; ctx.stroke();
      const filled = answers && answers.responses && answers.responses[q.index] === ci;
      if (filled) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r - 2, 0, Math.PI * 2);
        ctx.fillStyle = '#000'; ctx.fill();
      }
    });
  });

  return layout;
}

// ---------- Image processing for scanning ----------
function toGray(imgData) {
  const { data, width, height } = imgData;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i*4], g = data[i*4+1], b = data[i*4+2];
    gray[i] = 0.299*r + 0.587*g + 0.114*b;
  }
  return gray;
}

// Untuned starting points for the heuristics below — real classroom photos
// (varying phones, lighting, paper) will likely need these adjusted after
// some real-world testing. Kept deliberately conservative (few false
// positives) since callers use these as soft, advisory warnings only.
const OVEREXPOSED_GRAY_THRESHOLD = 250;
const OVEREXPOSED_FRACTION_THRESHOLD = 0.15;
const BLUR_VARIANCE_THRESHOLD = 150;

// Cheap, no-reference quality check for a captured photo, meant to catch the
// two most common phone-camera failure modes before/alongside scanning:
// motion/focus blur and flash glare or blown-out highlights. Both metrics
// are computed in a single pass over a (ideally downscaled) grayscale image
// so this stays fast enough to run on every capture, not just live preview.
//
// Blur: variance of the Laplacian. The Laplacian response at each interior
// pixel (4*center - 4 neighbors) is large wherever there's a sharp edge and
// near zero over smooth/blurry gradients. A sharp photo (crisp bubble
// outlines, print text) has many strong edge responses scattered through
// the image, so the variance of that response map is high; a blurry photo's
// responses cluster near zero, so the variance is low.
//
// Glare/overexposure: fraction of pixels that are near-pure-white. Ordinary
// photographed white paper under ambient light rarely saturates to 255 over
// a large area; a large near-white fraction usually means direct flash
// reflection or a blown-out highlight washing out part of the page.
function assessImageQuality(gray, width, height) {
  let overexposedCount = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > OVEREXPOSED_GRAY_THRESHOLD) overexposedCount++;
  }
  const overexposedFraction = overexposedCount / gray.length;

  let sum = 0, sumSq = 0, count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  const mean = count ? sum / count : 0;
  const variance = count ? (sumSq / count) - (mean * mean) : 0;

  return {
    blurVariance: variance,
    blurry: variance < BLUR_VARIANCE_THRESHOLD,
    overexposedFraction,
    overexposed: overexposedFraction > OVEREXPOSED_FRACTION_THRESHOLD,
  };
}

// Untuned starting points, like the thresholds above — how many degrees a
// corner angle (skew) or the whole page's in-frame tilt (rotation) may
// deviate before each is flagged.
const CORNER_ANGLE_DEVIATION_THRESHOLD_DEG = 12;
const CORNER_ROTATION_THRESHOLD_DEG = 20;

// Detects (but, deliberately, does not attempt to correct) a badly skewed
// or non-planar capture from the 4 fiducial corners alone. The single
// 4-point homography readBubbles/warpImage rely on assumes the sheet was a
// flat rectangle photographed straight-on; a curled page or a steep camera
// angle instead produces a corner quadrilateral whose interior angles
// drift away from 90°. With only 4 corner markers printed on the sheet (no
// interior control points), there isn't enough information to model or
// undo a curl/lens-distortion — this only measures how far the quad is
// from a right-angled rectangle and flags it as a warning, honest about
// not being able to fix it: the teacher is in a much better position to
// just retake the photo flatter/more square-on than any correction we
// could guess at without real calibration photos.
//
// Also separately reports rotationDeg/rotated — how far the page's top
// edge tilts from horizontal in the photo. A pure in-plane rotation keeps
// every interior angle at a perfect 90°, so it never trips the skew check
// above, and the 4-point homography itself handles arbitrary rotation
// correctly on its own *as long as the 4 corners are correctly matched to
// their physical TL/TR/BL/BR*. That correspondence is where a heavily
// rotated photo actually breaks things: findFiducials picks each corner
// from a FIXED quadrant of the CAMERA FRAME (top-left 35%, top-right 35%,
// ...), which only lines up with the page's own corners when the page is
// roughly upright in the shot. Rotate the page enough and a marker can
// end up nearer a different frame-quadrant than its own, or a stray dark
// blob (shadow, torn edge, staple) can outcompete it there — silently
// mislabeling which detected point is really the page's TL vs TR vs BL vs
// BR. A homography built on a mislabeled correspondence doesn't just
// rotate the bubble grid (which would be harmless) — it warps it into
// nonsense, sampling bubbles at the wrong positions. This is the likely
// explanation for a photo that looks perfectly fine (sharp, well-lit,
// fully framed) still decoding a garbled, inconsistent student ID from
// one retake to the next. Callers should treat `rotated` as a hard reject
// (retake) rather than just a warning, unlike `skewed` above — this isn't
// a "the read might be a little worse" signal, it's a "the read is likely
// sampling the wrong grid entirely" signal.
function assessCornerGeometry(corners) {
  const [tl, tr, bl, br] = corners;
  function angleAt(p, a, b) {
    const v1x = a.x - p.x, v1y = a.y - p.y;
    const v2x = b.x - p.x, v2y = b.y - p.y;
    const mag1 = Math.hypot(v1x, v1y), mag2 = Math.hypot(v2x, v2y);
    if (mag1 === 0 || mag2 === 0) return 90;
    const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (mag1 * mag2)));
    return Math.acos(cos) * 180 / Math.PI;
  }
  const angles = [
    angleAt(tl, tr, bl),
    angleAt(tr, tl, br),
    angleAt(bl, tl, br),
    angleAt(br, tr, bl),
  ];
  const maxAngleDeviation = Math.max(...angles.map(a => Math.abs(a - 90)));
  const rotationDeg = Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180 / Math.PI;
  return {
    maxAngleDeviation,
    skewed: maxAngleDeviation > CORNER_ANGLE_DEVIATION_THRESHOLD_DEG,
    rotationDeg,
    rotated: Math.abs(rotationDeg) > CORNER_ROTATION_THRESHOLD_DEG,
  };
}

// Find the 4 solid-black square markers near the 4 corners of the page.
// Instead of averaging all dark pixels in a quadrant (which gets dragged off-target
// by background clutter like desk surface, shadows, or hands), find the largest
// compact dark connected blob in each quadrant using flood fill, and use its
// bounding-box center. This is robust to a dark background around the page.
// opts.expectedMarkerRatio (marker side ÷ marker-centre spacing along the
// top edge, from the sheet's layout — see markerSizeRatio) sharpens which
// blobs count as markers; see pickMarkerSet.
// opts.subpixelRefine (default true) controls whether each found corner's
// coarse blob centroid gets refined to sub-pixel precision — see
// refineCentroidSubpixel below. Exposed as an option (rather than always
// on) so callers can offer it as an admin-toggleable feature.
function findFiducials(gray, width, height, opts = {}) {
  const quadrants = [
    { x0: 0, y0: 0, x1: width*0.35, y1: height*0.35, cornerX: 0, cornerY: 0 },
    { x0: width*0.65, y0: 0, x1: width, y1: height*0.35, cornerX: width, cornerY: 0 },
    { x0: 0, y0: height*0.65, x1: width*0.35, y1: height, cornerX: 0, cornerY: height },
    { x0: width*0.65, y0: height*0.65, x1: width, y1: height, cornerX: width, cornerY: height },
  ];
  // Compute the threshold SEPARATELY per quadrant rather than once globally.
  // Real photos often have uneven lighting across the frame (e.g. a shadow
  // gradient from top to bottom, as with a phone blocking light on one
  // side) — a single global threshold tuned to the brighter half of the
  // photo can end up misclassifying the darker half's background as "dark"
  // too, swallowing the marker inside one giant background blob. A local
  // threshold adapts to each quadrant's own lighting instead.
  // Collect ALL plausible marker-shaped blobs in each quadrant (not just the
  // single largest), then choose the one closest to that quadrant's true
  // page corner. This matters because a photo often includes desk/background
  // around the paper, and other dark regions in that area — a shadow, a
  // hand, a shirt sleeve — can be larger than the actual marker; picking by
  // "largest" alone is easily fooled by those. The marker is always the
  // blob nearest the physical corner, by construction of the page layout.
  const thresholds = quadrants.map(qd => otsuThresholdRegion(gray, width, height, qd));
  const sortByCorner = (list, qd) => list.sort((a, b) => {
    const da = (a.x-qd.cornerX)**2 + (a.y-qd.cornerY)**2;
    const db = (b.x-qd.cornerX)**2 + (b.y-qd.cornerY)**2;
    return da - db;
  });
  const perQuadrant = quadrants.map((qd, i) => sortByCorner(findBlobCandidates(gray, width, height, qd, thresholds[i], opts), qd));
  // A shadow across a corner (or dark desk filling part of its quadrant)
  // can make Otsu split bright paper from shadowed paper, so the shadowed
  // paper counts as "dark" and swallows the marker in one huge blob —
  // observed: every candidate in the quadrant rejected while the marker was
  // plainly visible. For a quadrant that came up empty, split its dark side
  // again to separate the near-black marker from grey paper, and accept only
  // blobs about the size of the markers found in the other quadrants (else
  // bubbles and text, which appear at the darker threshold, would pose as
  // the missing marker).
  const found = perQuadrant.filter(c => c.length).map(c => c[0].size ?? Math.sqrt(c[0].count));
  if (found.length >= 2 && found.length < 4) {
    const ref = found.slice().sort((x, y) => x - y)[Math.floor(found.length / 2)];
    quadrants.forEach((qd, i) => {
      if (perQuadrant[i].length) return;
      const darkThreshold = otsuThresholdRegion(gray, width, height, qd, thresholds[i]);
      if (!(darkThreshold < thresholds[i] - DARK_SPLIT_MIN_GAP)) return;
      const blobs = findBlobCandidates(gray, width, height, qd, darkThreshold, opts)
        .filter(b => { const r = b.size / ref; return r > 0.85 && r < 1.2 && b.bw / b.bh > 0.8 && b.bw / b.bh < 1.25 && b.count / (b.bw * b.bh) > 0.8; });
      // Many marker-sized blobs means a patterned area (bubble grid, dark
      // desk texture), not one marker among shadow.
      if (blobs.length <= 3) perQuadrant[i] = sortByCorner(blobs, qd);
    });
  }
  // Nearest-to-corner alone is fooled by a dark object on the desk beyond
  // the paper's corner (observed: a pencil case in the top-right of the
  // frame beat the real marker, shearing the whole warp). With a candidate
  // in every quadrant, pick the four jointly instead — see pickMarkerSet.
  const corners = perQuadrant.some(c => c.length === 0)
    ? perQuadrant.map(c => c[0] || null)
    : (opts.expectedMarkerRatio
      ? pickMarkerSet(perQuadrant, quadrants, Math.hypot(width, height), opts.expectedMarkerRatio)
      : dropSizeOutlier(pickMarkerSet(perQuadrant, quadrants, Math.hypot(width, height))));
  return { corners, threshold: otsuThreshold(gray) };
}

// The four printed markers are the same size, so once three agree, a
// fourth pick far smaller/larger than them isn't a marker at all — usually
// a title letter or staple left behind where the real marker was torn,
// stapled over or crumpled away. Reporting it missing (null) instead lets
// findFiducialsWithOrientation reconstruct that corner properly rather
// than warping to the wrong point. Perspective alone keeps sizes well
// within these bounds.
function dropSizeOutlier(corners) {
  if (corners.some(c => !c)) return corners;
  const size = corners.map(c => c.size ?? Math.sqrt(c.count));
  for (let i = 0; i < 4; i++) {
    const others = size.filter((_, j) => j !== i);
    const lo = Math.min(...others), hi = Math.max(...others);
    if (hi / lo > 1.5) continue;
    const ref = others.reduce((a, b) => a + b, 0) / 3;
    const ratio = size[i] / ref;
    if (ratio < 0.6 || ratio > 1.7) {
      const out = corners.slice();
      out[i] = null;
      return out;
    }
  }
  return corners;
}

const MARKER_CANDIDATES_PER_CORNER = 10;
// Grey levels the second, darker per-quadrant threshold must sit below the
// first before it's worth searching — see findFiducials.
const DARK_SPLIT_MIN_GAP = 20;
// Cost of leaving one corner unmatched (reported null) instead of forcing a
// blob into it — see pickMarkerSet.
const MISSING_CORNER_PENALTY = 1.5;

// Apparent page scale at each corner of a TL/TR/BL/BR quad: the geometric
// mean of its two adjacent edges. Under perspective the near corners get
// bigger and the far ones smaller, and a printed marker shrinks/grows with
// them — dividing a blob's size by this removes perspective from the
// comparison.
function cornerScales([tl, tr, bl, br]) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return [
    Math.sqrt(d(tl, tr) * d(tl, bl)),
    Math.sqrt(d(tr, tl) * d(tr, br)),
    Math.sqrt(d(bl, tl) * d(bl, br)),
    Math.sqrt(d(br, tr) * d(br, bl)),
  ];
}

// Chooses one candidate per quadrant (TL, TR, BL, BR) as the set most
// likely to be the four printed markers. Each pick's size is compared to
// the local page scale at its corner (cornerScales), which makes it
// perspective-proof: with opts.expectedMarkerRatio (marker side ÷ distance
// between marker centres, known per layout version) every real marker
// lands near that ratio wherever it sits in the frame, while a filled
// answer bubble comes out ~60% of it and desk clutter far off; without it,
// the four normalised sizes just have to agree. Each pick should also look
// like a solid square, the set must form a correctly-ordered quad, and
// distance to the frame corner is a light tie-break.
//
// One quadrant may be left empty (null) at MISSING_CORNER_PENALTY: when a
// marker is stapled over or torn off, three real markers plus a gap must
// beat forcing a bubble or a title letter into that corner. The gap's
// position is taken as the parallelogram of the other three for scaling.
function pickMarkerSet(perQuadrant, quadrants, diag, expectedRatio) {
  const lists = perQuadrant.map((cands, i) => cands.slice(0, MARKER_CANDIDATES_PER_CORNER).map(c => {
    const density = c.count / (c.bw * c.bh);
    return {
      c,
      size: c.size ?? Math.sqrt(c.count),
      shape: Math.abs(Math.log(c.bw / c.bh)) * 2 + Math.max(0, 0.8 - density) * 3,
      dist: Math.hypot(c.x - quadrants[i].cornerX, c.y - quadrants[i].cornerY) / diag,
    };
  }).concat([null]));
  let best = null, bestScore = Infinity;
  for (const tl of lists[0]) for (const tr of lists[1]) for (const bl of lists[2]) for (const br of lists[3]) {
    const picks = [tl, tr, bl, br];
    const missing = picks.findIndex(p => !p);
    if (missing >= 0 && picks.some((p, i) => !p && i !== missing)) continue;
    if (tl && tr && !(tl.c.x < tr.c.x)) continue;
    if (bl && br && !(bl.c.x < br.c.x)) continue;
    if (tl && bl && !(tl.c.y < bl.c.y)) continue;
    if (tr && br && !(tr.c.y < br.c.y)) continue;
    const pts = picks.map(p => (p ? p.c : null));
    if (missing >= 0) pts[missing] = parallelogramCorner(pts, missing);
    const scales = cornerScales(pts);
    if (scales.some(v => !(v > 0))) continue;
    const logNorm = [];
    picks.forEach((p, i) => { if (p) logNorm.push(Math.log(p.size / scales[i])); });
    let sizeCost;
    if (expectedRatio) {
      // ±20% is free: at live-preview resolution a marker is ~10px and its
      // measured size is that noisy. A filled bubble (~60%) still pays well
      // over MISSING_CORNER_PENALTY.
      const target = Math.log(expectedRatio);
      sizeCost = logNorm.reduce((sum, v) => sum + Math.max(0, Math.abs(v - target) - 0.2), 0) * 8;
    } else {
      sizeCost = (Math.max(...logNorm) - Math.min(...logNorm)) * 4;
    }
    const score = sizeCost
      + picks.reduce((sum, p) => sum + (p ? p.shape + p.dist : 0), 0)
      + (missing >= 0 ? MISSING_CORNER_PENALTY : 0);
    if (score < bestScore) { bestScore = score; best = pts.map((pt, i) => (picks[i] ? pt : null)); }
  }
  return best || perQuadrant.map(c => c[0]);
}

// Frees a canvas's pixel buffer right away. Mobile browsers (iOS Safari
// and Android Chrome alike) cap total canvas memory and reclaim dropped
// canvases lazily, so a scanning session that just lets them go out of
// scope eventually can't allocate a new one — scans start failing until
// the page is reloaded. Every full-size scratch canvas made per scan goes
// through here once it's no longer needed.
function releaseCanvas(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

// Rotates a canvas by 0/90/180/270 degrees, swapping width/height for a
// quarter turn.
function rotateCanvas(canvas, degrees) {
  if (degrees === 0) return canvas;
  const swap = degrees === 90 || degrees === 270;
  const w = canvas.width, h = canvas.height;
  const out = document.createElement('canvas');
  out.width = swap ? h : w;
  out.height = swap ? w : h;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(degrees * Math.PI / 180);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

// Live camera captures (unlike file uploads, which get EXIF orientation
// auto-applied by the browser when decoded into an <img>/Image) can come
// out of canvas.drawImage(videoElement, ...) rotated relative to how the
// photo visually looked on screen — a known getUserMedia quirk on some
// Android/browser combinations, especially when a stream is requested at
// fixed landscape dimensions while the phone is physically held in
// portrait to frame a portrait-shaped answer sheet. findFiducials assumes
// the buffer is already upright, so a rotated buffer makes it mislabel
// which detected marker is TL/TR/BL/BR — producing a severely
// skewed/sheared warp instead of an outright "corners not found" failure,
// which is much harder for a teacher to notice than a clean error.
//
// Scores how "readable" a warped candidate is by actually running the real
// bubble-decoding pass on it: a correctly-oriented sheet reads its
// pre-structured student-ID grid (exactly one darkest bubble per digit
// row, by construction of the sheet) with total confidence, while a
// wrongly-oriented candidate is sampling essentially arbitrary positions
// and almost never produces a clean, unambiguous ID. This is a direct,
// self-verifying signal rather than an indirect proxy (an earlier version
// of this function compared ink density between the sparse header and the
// dense bubble grid — "top vs bottom" — but that broke down for compact
// layouts like 60 questions across 3 columns, where most of the page
// height past the grid is genuinely blank, and a 180-degree-flipped
// candidate could end up scoring as fake-dark-heavy as the real one).
// Blank/ambiguous question responses are weighted far lower than ID
// confidence, since a real student may legitimately leave questions
// blank — that's not a sign of wrong orientation the way an undecodable
// ID is.
function decodeConfidenceScore(warpedCanvas, readOpts) {
  const { responses, studentId } = readBubbles(warpedCanvas, readOpts);
  const idUnclear = (studentId.match(/\?/g) || []).length;
  const questionUnclear = responses.filter(r => r.ambiguous).length;
  return -idUnclear * 1000 - questionUnclear;
}

// Tries corner detection at all 4 quarter-turns of the source canvas.
// Rotations whose corner quadrilateral aspect ratio doesn't plausibly
// match the page's actual pageW:pageH are discarded outright (this
// rejects a 90-degree swap, e.g. a portrait page read as landscape, and
// saves the cost of decoding it). Among the survivors — normally just the
// correct orientation and its 180-degree-flipped twin, since flipping
// preserves aspect ratio — decodeConfidenceScore breaks the tie by which
// one actually decodes cleanly. readOpts must match what the caller will
// pass to readBubbles for the real read (numQuestions, numChoices,
// idDigits, layoutStyle, cols; pageW/pageH come from this function's own
// params). This corrects a rotated camera capture transparently instead
// of grading a garbled read (see findFiducials's caller in
// OMRScanTool.jsx for context on when this happens).
//
// Sheets stored as one layout version may have been printed with an
// earlier geometry of it (scanLayoutVariants). The stored one is tried
// first; the next is tried only when that read isn't clean (rings not lined
// up well enough to grade, or a corner had to be reconstructed from the
// grid), and the better one wins. The result's layoutVersion is the geometry to read the
// bubbles with.
function findFiducialsWithOrientation(srcCanvas, pageW, pageH, readOpts) {
  // Marker detection doesn't depend on the bubble grid, so every variant
  // shares one pass per rotation (see detectRotation).
  const detections = new Map();
  let best = null;
  try {
    for (const layoutVersion of scanLayoutVariants(readOpts.layoutVersion)) {
      // The stored version is right for nearly every sheet; a variant is
      // only worth trying (and trusting) when it doesn't already read well
      // — a corner reconstructed from the grid proves little about the grid.
      if (best && best.alignment >= MIN_SCAN_ALIGNMENT && best.estimatedCorner === null) break;
      const found = findFiducialsForLayout(srcCanvas, pageW, pageH, { ...readOpts, layoutVersion }, detections);
      if (!found) continue;
      found.layoutVersion = layoutVersion;
      if (!best || found.alignment > best.alignment) {
        if (best) releaseCanvas(best.warped);
        best = found;
      } else {
        releaseCanvas(found.warped);
      }
    }
  } finally {
    for (const det of detections.values()) {
      if (det.canvas && det.canvas !== srcCanvas && det.canvas !== best?.canvas) releaseCanvas(det.canvas);
    }
  }
  return best;
}

// Rotates the photo by deg and finds its markers, once per rotation and
// marker margin however many layout variants ask. A rotation whose corners
// can't be a page of this shape is dropped (and its canvas freed) here, for
// every variant at once.
function detectRotation(srcCanvas, deg, pageW, pageH, margin, expectedRatio, subpixelRefine, detections) {
  const key = `${deg}:${margin}`;
  if (detections.has(key)) return detections.get(key);
  const det = { rejected: true };
  detections.set(key, det);
  const canvas = rotateCanvas(srcCanvas, deg);
  const imgData = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const gray = toGray(imgData);
  const { corners } = findFiducials(gray, canvas.width, canvas.height, { subpixelRefine, expectedMarkerRatio: markerSizeRatio(pageW, pageH, margin) });
  const missing = corners.map((c, i) => (c === null ? i : -1)).filter(i => i >= 0);
  let ok = missing.length <= 1;
  if (ok) {
    const full = corners.slice();
    if (missing.length === 1) full[missing[0]] = parallelogramCorner(full, missing[0]);
    const [tl, tr, bl] = full;
    const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
    // A clearly wrong aspect is a 90-degree swap.
    ok = topW > 0 && leftH > 0 && Math.abs(Math.log((leftH / topW) / expectedRatio)) <= 0.35;
  }
  if (!ok) {
    // Dead weight — free it now (never the caller's own srcCanvas, which
    // rotation 0 returns as-is).
    if (canvas !== srcCanvas) releaseCanvas(canvas);
    return det;
  }
  Object.assign(det, { rejected: false, canvas, gray, corners });
  return det;
}

function findFiducialsForLayout(srcCanvas, pageW, pageH, readOpts, detections) {
  const layout = buildLayout(readOpts.numQuestions, readOpts.numChoices, readOpts.idDigits, pageW, pageH, readOpts.layoutStyle || 'auto', readOpts.cols, readOpts.layoutVersion);
  const pageCorners = markerCenters(pageW, pageH, layout.margin);
  // Aspect of the marker-centre quad itself, not the whole page — they
  // differ once markers sit further in (layout version 2).
  const expectedRatio = (pageCorners[2].y - pageCorners[0].y) / (pageCorners[1].x - pageCorners[0].x);
  const candidates = [];
  for (const deg of [0, 90, 180, 270]) {
    const det = detectRotation(srcCanvas, deg, pageW, pageH, layout.margin, expectedRatio, readOpts.subpixelRefine, detections);
    if (det.rejected) continue;
    const { canvas, gray } = det;
    const corners = det.corners.slice();
    let estimatedCorner = corners.findIndex(c => c === null);
    if (estimatedCorner < 0) {
      estimatedCorner = null;
    } else {
      // One marker stapled over, torn or crumpled — refine the rough guess
      // against the printed bubble grid (see refineEstimatedCorner).
      corners[estimatedCorner] = parallelogramCorner(corners, estimatedCorner);
      const refined = refineEstimatedCorner(gray, canvas.width, canvas.height, corners, estimatedCorner, pageCorners, layout);
      if (!refined) continue;
      corners[estimatedCorner] = refined;
    }
    const warped = warpImage(canvas, corners, pageW, pageH, layout.margin);
    if (!warped) continue;
    const orientationScore = decodeConfidenceScore(warped, { ...readOpts, pageW, pageH });
    candidates.push({ canvas, gray, corners, rotationDeg: deg, warped, orientationScore, estimatedCorner });
  }
  if (candidates.length === 0) return null;
  // A clean 4-marker read beats an estimated one at the same decode score.
  candidates.sort((a, b) => (b.orientationScore - a.orientationScore) || ((a.estimatedCorner === null ? 0 : 1) - (b.estimatedCorner === null ? 0 : 1)));
  const best = candidates[0];
  // Rotated canvases belong to the shared detections (freed by
  // findFiducialsWithOrientation); only the warps are this call's own.
  for (const c of candidates.slice(1)) releaseCanvas(c.warped);

  // All 4 found doesn't mean all 4 are right: a crumpled or half-stapled
  // marker is often still detected, just with its centre dragged off the
  // real one, which shifts every bubble near that corner. Try re-fitting
  // each corner alone against the printed grid; keep a fix only when it
  // clearly beats the detected position.
  if (best.estimatedCorner === null) {
    const repaired = repairOneCorner(best.gray, best.canvas.width, best.canvas.height, best.corners, pageCorners, layout);
    if (repaired) {
      const warpedFix = warpImage(best.canvas, repaired.corners, pageW, pageH, layout.margin);
      if (warpedFix) {
        releaseCanvas(best.warped);
        best.corners = repaired.corners;
        best.warped = warpedFix;
        best.cornerShift = repaired.shift;
        // A small nudge is just a blurry/perspective-biased centroid being
        // tidied up — silently. Only a big move means the marker itself
        // was damaged, which the teacher should be told about.
        if (repaired.shift > CORNER_REPAIR_REPORT_SHIFT) best.estimatedCorner = repaired.index;
      }
    }
  }
  // How well the printed bubble rings line up under the final corners —
  // lets the caller refuse to grade a warp that's visibly wrong instead of
  // saving a garbage score (see MIN_SCAN_ALIGNMENT's caller).
  const Hfinal = computeHomography(best.corners, pageCorners);
  best.alignment = Hfinal ? bubbleAlignmentScore(best.gray, best.canvas.width, best.canvas.height, Hfinal, layout) : -Infinity;
  delete best.gray;
  return best; // { canvas, corners, rotationDeg, warped, estimatedCorner, alignment } (+ layoutVersion, from the caller)
}

// How much better (in bubbleAlignmentScore units) a re-fitted corner must
// line the grid up before it replaces the detected marker — keeps an
// undamaged sheet's genuine markers from being second-guessed by noise.
const CORNER_REPAIR_MIN_GAIN = 4;
// Fraction of the page's size a repaired corner must move before it counts
// as "that marker was damaged" (and is reported), rather than a tidy-up.
const CORNER_REPAIR_REPORT_SHIFT = 0.015;

function repairOneCorner(gray, width, height, corners, pageCorners, layout) {
  const H0 = computeHomography(corners, pageCorners);
  if (!H0) return null;
  const base = bubbleAlignmentScore(gray, width, height, H0, layout);
  let bestFix = null;
  for (let i = 0; i < 4; i++) {
    const fit = searchCorner(gray, width, height, corners, i, corners[i], pageCorners, layout, [[0.04, 0.01, 2], [0.012, 0.002, 1]]);
    const gain = fit.score - base;
    if (gain >= CORNER_REPAIR_MIN_GAIN && (!bestFix || gain > bestFix.gain)) {
      bestFix = { index: i, point: fit.point, gain };
    }
  }
  if (!bestFix) return null;
  const fixed = corners.slice();
  fixed[bestFix.index] = bestFix.point;
  const others = corners.filter((_, i) => i !== bestFix.index);
  const side = Math.hypot(others[0].x - others[1].x, others[0].y - others[1].y);
  const moved = Math.hypot(bestFix.point.x - corners[bestFix.index].x, bestFix.point.y - corners[bestFix.index].y);
  return { corners: fixed, index: bestFix.index, shift: side ? moved / side : 0 };
}

// How well the printed bubble circles line up under a candidate page→photo
// homography: for every question and student-ID bubble, the darkest point
// along its printed ring (sampled at radius r±1) minus the paper just
// outside it. Correctly aligned, every ring lands on ink with light paper
// around it; misaligned, the samples land on blank paper or mid-gap. Works
// whether or not a bubble is filled, since a filled bubble's ring is dark too.
const ALIGN_RING_ANGLES = 12;
function bubbleAlignmentScore(gray, width, height, H, layout, stride = 1) {
  const project = (x, y) => {
    const d = H[6] * x + H[7] * y + H[8];
    const px = Math.round((H[0] * x + H[1] * y + H[2]) / d);
    const py = Math.round((H[3] * x + H[4] * y + H[5]) / d);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    return 255 - gray[py * width + px];
  };
  const bubbles = [];
  for (const q of layout.questions) for (const c of q.choices) bubbles.push(c);
  for (const row of layout.idGrid) for (const c of row) bubbles.push(c);
  let total = 0, n = 0;
  for (let bi = 0; bi < bubbles.length; bi += stride) {
    const b = bubbles[bi];
    let ring = 0, outer = 0, k = 0;
    for (let a = 0; a < ALIGN_RING_ANGLES; a++) {
      const t = (a / ALIGN_RING_ANGLES) * Math.PI * 2;
      const cos = Math.cos(t), sin = Math.sin(t);
      let best = -1;
      for (const r of [b.r - 1, b.r, b.r + 1]) {
        const v = project(b.x + cos * r, b.y + sin * r);
        if (v !== null && v > best) best = v;
      }
      const o = project(b.x + cos * (b.r + 3.5), b.y + sin * (b.r + 3.5));
      if (best < 0 || o === null) continue;
      ring += best; outer += o; k++;
    }
    if (k === 0) continue;
    total += (ring - outer) / k;
    n++;
  }
  return n ? total / n : -Infinity;
}

// A finished scan whose bubbleAlignmentScore is below this is refused
// rather than graded. Measured: correct reads scored 84-98 on simulated
// photos and 58-75 on real (even low-res, blurry) phone captures; every
// wrong warp — a mistaken corner, a steep tilt plus a damaged marker —
// scored 38 or less.
const MIN_SCAN_ALIGNMENT = 45;

// Below this, no candidate position made the printed rings line up — the
// three found markers are probably wrong or the page is too distorted, so
// refuse rather than grade a garbage warp.
const MIN_BUBBLE_ALIGNMENT = 12;

// Rough position of the one marker findFiducials couldn't find, assuming
// the page is a parallelogram (exact without perspective): the other
// three corners' vector sum. Corners are TL, TR, BL, BR.
function parallelogramCorner(corners, missingIndex) {
  const [tl, tr, bl, br] = corners;
  switch (missingIndex) {
    case 0: return { x: tr.x + bl.x - br.x, y: tr.y + bl.y - br.y };
    case 1: return { x: tl.x + br.x - bl.x, y: tl.y + br.y - bl.y };
    case 2: return { x: tl.x + br.x - tr.x, y: tl.y + br.y - tr.y };
    default: return { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y };
  }
}

// Real photos have perspective, so parallelogramCorner can be off by a few
// percent of the page — enough to misread bubbles. Refines it with a
// coarse-to-fine search of nearby positions, keeping whichever makes the
// printed bubble grid line up best (bubbleAlignmentScore). Returns {x, y},
// or null if nothing lines up convincingly.
// The parallelogram guess ignores perspective, which on a tilted photo can
// put it ~10% of the page away — hence the wide first pass (on every other
// bubble, to keep it quick) before narrowing in.
function refineEstimatedCorner(gray, width, height, corners, missingIndex, pageCorners, layout) {
  const fit = searchCorner(gray, width, height, corners, missingIndex, corners[missingIndex], pageCorners, layout,
    [[0.15, 0.01, 2], [0.02, 0.004, 1], [0.005, 0.001, 1]]);
  return fit.score >= MIN_BUBBLE_ALIGNMENT ? fit.point : null;
}

// Coarse-to-fine grid search for one corner's position (the other three
// held fixed) maximising bubbleAlignmentScore. passes: [[range, step,
// bubbleStride], ...], range/step as fractions of the page's size in the
// photo. The returned score is always re-measured on every bubble.
function searchCorner(gray, width, height, corners, index, start, pageCorners, layout, passes) {
  const others = corners.filter((_, i) => i !== index);
  const side = (Math.hypot(others[0].x - others[1].x, others[0].y - others[1].y)
    + Math.hypot(others[1].x - others[2].x, others[1].y - others[2].y)
    + Math.hypot(others[0].x - others[2].x, others[0].y - others[2].y)) / 3;
  const scoreAt = (p, stride) => {
    const trial = corners.slice();
    trial[index] = p;
    const H = computeHomography(trial, pageCorners);
    return H ? bubbleAlignmentScore(gray, width, height, H, layout, stride) : -Infinity;
  };
  let point = start;
  for (const [range, step, stride] of passes) {
    const center = point;
    let passBest = scoreAt(center, stride);
    const r = range * side, st = step * side;
    for (let dy = -r; dy <= r + 1e-9; dy += st) {
      for (let dx = -r; dx <= r + 1e-9; dx += st) {
        const p = { x: center.x + dx, y: center.y + dy };
        const sc = scoreAt(p, stride);
        if (sc > passBest) { passBest = sc; point = p; }
      }
    }
  }
  return { point, score: scoreAt(point, 1) };
}

// Otsu threshold computed over a single rectangular region only, rather
// than the whole image — adapts to that region's local lighting. With
// below set, only pixels darker than it are considered — i.e. the dark
// class of a previous split, split again.
function otsuThresholdRegion(gray, width, height, region, below = 256) {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.min(width, Math.ceil(region.x1));
  const y1 = Math.min(height, Math.ceil(region.y1));
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = Math.min(255, Math.max(0, Math.round(gray[y*width+x])));
      if (v >= below) continue;
      hist[v]++;
      total++;
    }
  }
  if (total === 0) return 128;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

// Refines a blob's coarse (hard-threshold) mass centroid to sub-pixel
// precision. findBlobCandidates below decides pixel membership with a
// binary in/out mask, so a pixel only partially covered by the printed
// marker (an anti-aliased or JPEG-blurred edge — the norm for a phone
// photo, not the exception) is either fully counted or not counted at
// all, quantizing the true edge position to whole pixels. Re-weighting a
// small window around the blob by how far below the threshold each pixel
// actually is (rather than a hard 0/1 mask) lets those partial edge
// pixels contribute proportionally, landing closer to the marker's real
// center than the binary version can.
function refineCentroidSubpixel(gray, width, height, bbox, threshold) {
  const pad = 1;
  const x0 = Math.max(0, Math.floor(bbox.minX) - pad);
  const y0 = Math.max(0, Math.floor(bbox.minY) - pad);
  const x1 = Math.min(width, Math.ceil(bbox.maxX) + pad + 1);
  const y1 = Math.min(height, Math.ceil(bbox.maxY) + pad + 1);
  let sumW = 0, sumX = 0, sumY = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const w = Math.max(0, threshold - gray[y * width + x]);
      sumW += w; sumX += w * x; sumY += w * y;
    }
  }
  if (sumW <= 0) return null;
  return { x: sumX / sumW, y: sumY / sumW };
}

// How many pixels of light gap the dark mask below bridges before
// connected-component search runs — untuned starting point, small enough
// to never merge two genuinely separate shapes (bubbles/text are spaced
// far more than this apart at any resolution this runs at).
const BLOB_GAP_CLOSE_RADIUS = 2;

// Precomputes a dark/not-dark mask for the region, "closed" by expanding
// each dark pixel by BLOB_GAP_CLOSE_RADIUS — bridges a thin light gap
// splitting what should be one solid marker into two separately-flood-
// filled pieces. Observed in practice: a printer banding defect or a
// paper crease can leave a hairline light seam straight through an
// otherwise-solid fiducial square (visibly still one square to the eye);
// a plain 4-connected flood fill then finds two thin, oddly-shaped
// halves instead — each usually failing the aspect/density checks below
// on its own, so the marker is missed entirely. Only changes which
// pixels count as CONNECTED for this search — the sub-pixel centroid
// refinement afterward re-derives position from actual graylevels, not
// this mask, so a closed-over gap doesn't bias where the corner lands.
function buildClosedDarkMask(gray, width, x0, y0, x1, y1, threshold, radius) {
  const rw = x1 - x0, rh = y1 - y0;
  const base = new Uint8Array(rw * rh);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      base[(y - y0) * rw + (x - x0)] = gray[y * width + x] < threshold ? 1 : 0;
    }
  }
  if (radius <= 0) return base;
  const closed = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (base[y * rw + x]) { closed[y * rw + x] = 1; continue; }
      search: for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rh) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= rw) continue;
          if (base[ny * rw + nx]) { closed[y * rw + x] = 1; break search; }
        }
      }
    }
  }
  return closed;
}

// Flood-fill based connected-component search: returns ALL plausibly
// marker-shaped dark blobs within a region (not just the largest one),
// so the caller can pick the most geometrically sensible candidate.
// opts.subpixelRefine (default true) applies refineCentroidSubpixel to
// each surviving blob.
function findBlobCandidates(gray, width, height, region, threshold, opts = {}) {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.min(width, Math.ceil(region.x1));
  const y1 = Math.min(height, Math.ceil(region.y1));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return [];

  // Search both the raw mask and the gap-closed one: closing rescues a
  // marker split by a printer seam, but at low resolution (the ~480px live
  // preview) it also bridges the ~2.5mm gap to the title text beside the
  // top-left marker, merging them into one non-square blob that fails the
  // shape checks. Near-duplicate hits from the two passes are dropped.
  const squareness = b => Math.abs(Math.log(b.bw / b.bh)) + (1 - b.count / (b.bw * b.bh));
  const results = [];
  for (const radius of [0, BLOB_GAP_CLOSE_RADIUS]) {
    for (const b of findBlobsInMask(gray, width, height, x0, y0, x1, y1, threshold, radius, opts)) {
      // Closing grows a blob by `radius` on every side; undo that so sizes
      // from the two passes are comparable (pickMarkerSet compares them).
      b.size = Math.max(1, Math.sqrt(b.count) - 2 * radius);
      const i = results.findIndex(r => Math.abs(r.x - b.x) < Math.max(r.bw, b.bw) / 4 && Math.abs(r.y - b.y) < Math.max(r.bh, b.bh) / 4);
      if (i === -1) results.push(b);
      else if (squareness(b) < squareness(results[i])) results[i] = b;
    }
  }
  return results;
}

function findBlobsInMask(gray, width, height, x0, y0, x1, y1, threshold, radius, opts) {
  const rw = x1 - x0, rh = y1 - y0;
  const closedMask = buildClosedDarkMask(gray, width, x0, y0, x1, y1, threshold, radius);
  const visited = new Uint8Array(rw * rh);
  const isDark = (x, y) => closedMask[(y - y0) * rw + (x - x0)] === 1;

  const results = [];
  const stackX = new Int32Array(rw * rh);
  const stackY = new Int32Array(rw * rh);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const li = (y-y0)*rw + (x-x0);
      if (visited[li] || !isDark(x, y)) continue;

      // BFS/flood fill this connected component
      let sp = 0;
      stackX[sp] = x; stackY[sp] = y; sp++;
      visited[li] = 1;
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      let sumX = 0, sumY = 0; // for intensity-weighted centroid

      while (sp > 0) {
        sp--;
        const cx = stackX[sp], cy = stackY[sp];
        count++;
        sumX += cx; sumY += cy;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
        const neighbors = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
        for (const [nx, ny] of neighbors) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const nli = (ny-y0)*rw + (nx-x0);
          if (visited[nli] || !isDark(nx, ny)) continue;
          visited[nli] = 1;
          stackX[sp] = nx; stackY[sp] = ny; sp++;
        }
      }

      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      // Filter for roughly-square, reasonably sized, SMALL blobs — the
      // printed marker is a small compact square (a few percent of the
      // quadrant at most). Shadows and other background clutter tend to be
      // much larger or more irregular, so a tighter upper bound on size
      // (in addition to the aspect/density checks) rejects most of them
      // outright before we even get to the corner-distance tie-break.
      const aspect = bw / bh;
      const fillDensity = count / (bw * bh);
      const plausibleSize = bw > 4 && bh > 4 && bw < rw * 0.35 && bh < rh * 0.35;
      const plausibleShape = aspect > 0.6 && aspect < 1.7 && fillDensity > 0.55;
      if (plausibleSize && plausibleShape) {
        // Mass centroid (average position of all dark pixels in the blob)
        // rather than the bounding-box midpoint — more stable than the
        // bbox center under asymmetric blur/shadow/JPEG smearing on one
        // edge of the marker. refineCentroidSubpixel sharpens this further
        // to sub-pixel precision when enabled (see above).
        const refined = opts.subpixelRefine === false
          ? null
          : refineCentroidSubpixel(gray, width, height, { minX, maxX, minY, maxY }, threshold);
        results.push({ x: refined ? refined.x : sumX / count, y: refined ? refined.y : sumY / count, count, bw, bh });
      }
    }
  }
  return results;
}

function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, Math.round(gray[i])))]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, wF = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (wB === 0) continue;
    wF = total - wB; if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

// Simple bilinear-sample based perspective warp using 4 detected corners -> target rect
function computeHomography(src, dst) {
  // src, dst: arrays of 4 {x,y} in order TL, TR, BL, BR
  // Solve for 3x3 homography mapping dst->src (so we can sample source per dst pixel)
  const A = [];
  const b = [];
  const pairs = [[dst[0],src[0]],[dst[1],src[1]],[dst[2],src[2]],[dst[3],src[3]]];
  pairs.forEach(([d,s]) => {
    A.push([d.x, d.y, 1, 0, 0, 0, -d.x*s.x, -d.y*s.x]); b.push(s.x);
    A.push([0, 0, 0, d.x, d.y, 1, -d.x*s.y, -d.y*s.y]); b.push(s.y);
  });
  const h = solveLinear(A, b);
  if (!h) return null;
  return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col+1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function warpImage(srcCanvas, corners, pageW = PAGE_W, pageH = PAGE_H, margin = MARGIN) {
  // corners detected in order TL,TR,BL,BR (from quadrant scan order).
  // IMPORTANT: these are the CENTROIDS of the marker squares in the photo,
  // so the destination points must be the centroids of the same squares in
  // our page coordinate system (MARGIN + MARKER/2 from each edge) — not the
  // bare page corners (0,0)/(pageW,pageH). Using the page corners here was
  // a bug: it shifted/scaled every warp by a constant offset equal to the
  // marker's half-size, throwing off all bubble positions consistently.
  const dst = markerCenters(pageW, pageH, margin);
  const H = computeHomography(corners, dst); // maps dst(page coords)->src(photo coords)
  if (!H) return null;

  const out = document.createElement('canvas');
  out.width = pageW; out.height = pageH;
  const octx = out.getContext('2d');
  const sctx = srcCanvas.getContext('2d');
  const srcData = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const outData = octx.createImageData(pageW, pageH);

  for (let y = 0; y < pageH; y++) {
    for (let x = 0; x < pageW; x++) {
      const denom = H[6]*x + H[7]*y + H[8];
      const sx = (H[0]*x + H[1]*y + H[2]) / denom;
      const sy = (H[3]*x + H[4]*y + H[5]) / denom;
      const ix = Math.round(sx), iy = Math.round(sy);
      const di = (y*pageW + x) * 4;
      if (ix >= 0 && ix < srcCanvas.width && iy >= 0 && iy < srcCanvas.height) {
        const si = (iy*srcCanvas.width + ix) * 4;
        outData.data[di] = srcData.data[si];
        outData.data[di+1] = srcData.data[si+1];
        outData.data[di+2] = srcData.data[si+2];
        outData.data[di+3] = 255;
      } else {
        outData.data[di] = 255; outData.data[di+1] = 255; outData.data[di+2] = 255; outData.data[di+3] = 255;
      }
    }
  }
  octx.putImageData(outData, 0, 0);
  return out;
}

function readBubbles(warpedCanvas, opts) {
  const pageW = opts.pageW || PAGE_W;
  const pageH = opts.pageH || PAGE_H;
  const layoutStyle = opts.layoutStyle || 'auto';
  const layout = buildLayout(opts.numQuestions, opts.numChoices, opts.idDigits, pageW, pageH, layoutStyle, opts.cols, opts.layoutVersion);
  const ctx = warpedCanvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, pageW, pageH);
  const gray = toGray(imgData);

  // Instead of a global/local binary threshold (fragile under uneven lighting,
  // JPEG compression, or a dark background), measure the mean darkness inside
  // each bubble directly, then decide the answer by comparing bubbles WITHIN
  // the same question relative to each other. A filled bubble is always
  // meaningfully darker than the unfilled ones next to it, regardless of the
  // absolute lighting conditions in the photo — this matters because real
  // photos often have a lighting gradient across the page (e.g. one corner
  // shadowed), so a single global "blank paper" brightness sampled from one
  // spot on the page is not a reliable reference for bubbles elsewhere.
  function meanDarkness(cx, cy, r) {
    let sum = 0, total = 0;
    const rr = r - 1;
    for (let y = -rr; y <= rr; y++) {
      for (let x = -rr; x <= rr; x++) {
        if (x*x + y*y > rr*rr) continue;
        const px = Math.round(cx + x), py = Math.round(cy + y);
        if (px < 0 || py < 0 || px >= pageW || py >= pageH) continue;
        total++;
        sum += (255 - gray[py*pageW + px]); // invert: higher = darker
      }
    }
    return total ? sum / total : 0;
  }

  // A single global 4-point homography assumes a perfect flat-plane projection,
  // but real phone photos (paper not perfectly flat, slight lens distortion,
  const responses = layout.questions.map(q => {
    const darks = q.choices.map(c => meanDarkness(c.x, c.y, c.r));
    const maxD = Math.max(...darks);
    const sorted = [...darks].sort((a,b) => b-a);
    // Decide primarily by how much the darkest bubble stands out from the
    // others in the SAME question — this is lighting-invariant since all
    // choices in a row are sampled under the same local light. A small
    // absolute-darkness floor (gapToMin) still guards against a fully blank
    // row where all bubbles are equally faint (nothing filled at all).
    const gapToSecond = sorted[0] - sorted[1];
    const gapToMin = maxD - Math.min(...darks);
    const answered = gapToSecond > 8 && gapToMin > 8;
    const isAmbiguous = !answered && gapToMin > 8 && gapToSecond > 3;
    return {
      question: q.index,
      choice: answered ? darks.indexOf(maxD) : null,
      ratios: darks,
      ambiguous: isAmbiguous,
      blank: !answered && !isAmbiguous,
    };
  });

  const studentId = layout.idGrid.map(digitCol => {
    const darks = digitCol.map(c => meanDarkness(c.x, c.y, c.r));
    const maxD = Math.max(...darks);
    const sorted = [...darks].sort((a,b) => b-a);
    const gapToSecond = sorted[0] - sorted[1];
    const gapToMin = maxD - Math.min(...darks);
    if (gapToSecond > 8 && gapToMin > 8) {
      const idx = darks.indexOf(maxD);
      // Use the cell's own .value rather than its array index — the
      // ZipGrade-style ID grid orders cells 1,2,...,9,0 top-to-bottom
      // (matching the reference sheet), not 0,1,...,9, so array index and
      // digit value are NOT the same thing there.
      return String(digitCol[idx].value);
    }
    return '?';
  }).join('');

  return { responses, studentId, layout };
}

// Draws a graded, reviewable copy of a warped (perspective-corrected) sheet:
// a solid ring around the choice the student filled (green if correct, red
// if wrong), a dashed blue ring around the correct choice when the student
// missed it, and a check/cross mark by each question number. This is the
// image saved for later review when a teacher opts in to keeping scan
// photos (see lib/omr-db.js's photo_path column) — the raw, unrectified
// camera photo is not what's kept.
function drawGradedOverlay(warpedCanvas, { layout, graded }) {
  const canvas = document.createElement('canvas');
  canvas.width = warpedCanvas.width;
  canvas.height = warpedCanvas.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(warpedCanvas, 0, 0);

  const byQuestion = new Map(graded.map(g => [g.question, g]));
  layout.questions.forEach((q, qi) => {
    const g = byQuestion.get(qi);
    if (!g) return;

    q.choices.forEach((c, ci) => {
      const isChosen = g.choice === ci;
      const isKey = g.keyChoices.includes(ci);
      if (isChosen) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = g.correct ? '#00c853' : '#e53935';
        ctx.lineWidth = 3;
        ctx.stroke();
      } else if (isKey) {
        ctx.save();
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#1e88e5';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }
    });

    ctx.font = 'bold 12px "Sarabun", sans-serif';
    ctx.fillStyle = g.correct ? '#00c853' : '#e53935';
    ctx.fillText(g.correct ? '✓' : '✗', q.labelX - 16, q.labelY + 4);
  });

  return canvas;
}

// ---------- Exports ----------
export {
  PAGE_W, PAGE_H, PX_PER_MM,
  HALF_PAGE_W, HALF_PAGE_H,
  HALF_LANDSCAPE_PAGE_W, HALF_LANDSCAPE_PAGE_H,
  TOP_BOTTOM_PAGE_W, TOP_BOTTOM_PAGE_H,
  MARKER, MARGIN,
  CURRENT_OMR_LAYOUT_VERSION,
  MIN_SCAN_ALIGNMENT,
  releaseCanvas,
  markerCenters,
  markerSizeRatio,
  bubbleAlignmentScore,
  THAI_GLYPH_SAMPLE,
  ensureFontsLoaded,
  buildLayout,
  drawFiducials,
  choiceLetters,
  wrapText,
  insertThaiZwsp,
  fillTextClipped,
  drawSheet,
  toGray,
  assessImageQuality,
  assessCornerGeometry,
  findFiducials,
  findFiducialsWithOrientation,
  otsuThreshold,
  otsuThresholdRegion,
  findBlobCandidates,
  computeHomography,
  solveLinear,
  warpImage,
  readBubbles,
  drawGradedOverlay,
};
