// exam-print.js
//
// Renders a ชุดข้อสอบ's questions as a printable A4 question paper (PDF) —
// for a teacher running the exam on paper instead of online, to hand out
// alongside an OMR answer sheet (see omr-core.js/OMRPrepareTool.jsx; the
// matching answer key gets auto-filled from the same questions by
// syncPrintedOmrQuiz in exam-db.js, so the teacher never re-types it).
//
// Reuses the same canvas-then-rasterize approach as the OMR answer sheet:
// jsPDF's own text() has no Thai font, so it would render Thai as garbage.
// A <canvas> lets the browser's own font rendering (the "Sarabun" family,
// loaded app-wide — see layout.js) draw Thai correctly; each page's canvas
// then becomes one JPEG image embedded in the PDF, exactly like
// OMRPrepareTool's downloadSheetHalfA4/handleGenerateClassPDF.
//
// The letterhead (school name, exam title, subject/score/time line, boxed
// คำชี้แจง rules, and an optional logo) and the 1 vs 2-column question
// layout are all caller-supplied — ExamSetTool's print dialog is what lets
// a teacher edit them per print, prefilled from the admin's exam_app_name/
// exam_app_logo (Settings) and the ชุดข้อสอบ itself. This module just draws
// whatever it's given; it has no config/Supabase dependency of its own
// beyond fetching question images.

import { jsPDF } from 'jspdf';
import { PAGE_W, PAGE_H, MARGIN, choiceLetters, wrapText } from './omr-core';
import { getBankQuestionImageUrl } from './bank-db';

const PRINT_SCALE = 3; // matches omr-core's PRINT_SCALE — sharp at print resolution
const FONT = '"Sarabun", sans-serif';
// PAGE_W=850 for a 210mm-wide page (~4.05 px/mm here) — these are sized in
// that coordinate system to print at roughly 12-14pt, not their raw px
// number; the original 13px body / 12px choice text worked out to ~9pt on
// paper, too small for a printed exam. Body/choice/qnum were nudged back
// down a point from an earlier 16/15/16 pass — still comfortably readable
// on paper, less oversized on screen.
const SCHOOL_FONT = `bold 19px ${FONT}`;
const EXAM_TITLE_FONT = `bold 18px ${FONT}`;
const SUBTITLE_FONT = `14px ${FONT}`;
const CONT_FONT = `14px ${FONT}`;
const INSTRUCTION_FONT = `13px ${FONT}`;
// Same size/weight as BODY_FONT — the question number is just "1. ", "2. "
// inline with the question text now, not a bold "ข้อ 1." label.
const QNUM_FONT = `13.5px ${FONT}`;
const BODY_FONT = `13.5px ${FONT}`;
const CHOICE_FONT = `13.5px ${FONT}`;

const CONTENT_X = MARGIN;
const CONTENT_W = PAGE_W - MARGIN * 2;
const COLUMN_GUTTER = 30;
const CHOICE_INDENT = 25;
const MAX_IMAGE_H = 200;
const TEXT_LINE_H = 22;
const CHOICE_LINE_H = 20;
const BLOCK_GAP = 23;
const FOOTER_RESERVE = 20;
const LOGO_SIZE = 74;

function loadImage(url) {
  return new Promise(resolve => {
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // best-effort — a broken image just prints as missing, not a hard failure
    img.src = url;
  });
}

// Resolves every image a question in this set carries, up front — canvas
// drawing is synchronous, so nothing can be awaited mid-page-layout.
async function loadQuestionImages(supabase, questions) {
  const paths = [...new Set(questions.map(q => q.image_path).filter(Boolean))];
  const images = new Map();
  await Promise.all(paths.map(async path => {
    try {
      const url = await getBankQuestionImageUrl(supabase, path, 300);
      images.set(path, await loadImage(url));
    } catch {
      images.set(path, null);
    }
  }));
  return images;
}

// One or two columns of equal width across the content area, left-to-right.
function getColumnLayout(columns) {
  if (columns !== 2) return { count: 1, width: CONTENT_W, xs: [CONTENT_X] };
  const width = (CONTENT_W - COLUMN_GUTTER) / 2;
  return { count: 2, width, xs: [CONTENT_X, CONTENT_X + width + COLUMN_GUTTER] };
}

// A dashed "เส้นปรุ" guide line down the middle of the gutter between the
// two columns, on every page that uses a 2-column layout — a fixed line
// spanning the whole column height regardless of how far content actually
// reaches, matching the perforated cut/fold line printed exams
// traditionally carry. save()/restore() keeps the dash pattern from
// leaking into every other stroke drawn afterward on this shared ctx (the
// letterhead box, the คำชี้แจง box, ...), which all expect solid lines.
function drawColumnDivider(ctx, colLayout, yTop, yBottom) {
  if (colLayout.count !== 2) return;
  const gutterMid = colLayout.xs[0] + colLayout.width + COLUMN_GUTTER / 2;
  ctx.save();
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(gutterMid, yTop);
  ctx.lineTo(gutterMid, yBottom);
  ctx.stroke();
  ctx.restore();
}

// One measurement/layout pass per question — wraps its text and each
// choice's text, and scales its image (if any) to fit one column —
// producing everything the draw pass needs, plus the total height the
// question will occupy, used to decide where column/page breaks fall.
function planQuestions(measureCtx, questions, choiceScheme, images, columnWidth) {
  return questions.map((q, qi) => {
    measureCtx.font = BODY_FONT;
    const textLines = wrapText(measureCtx, q.question_text, columnWidth - 30);

    const letters = choiceLetters(choiceScheme, q.choices.length);
    measureCtx.font = CHOICE_FONT;
    const choiceLines = q.choices.map((c, ci) => wrapText(measureCtx, `${letters[ci]}. ${c}`, columnWidth - 30 - CHOICE_INDENT));

    const img = q.image_path ? images.get(q.image_path) : null;
    let imgW = 0, imgH = 0;
    if (img) {
      const maxW = columnWidth - 30;
      const scale = Math.min(1, maxW / img.width, MAX_IMAGE_H / img.height);
      imgW = Math.round(img.width * scale);
      imgH = Math.round(img.height * scale);
    }

    const height =
      TEXT_LINE_H * textLines.length +
      (img ? imgH + 13 : 0) +
      choiceLines.reduce((sum, lines) => sum + lines.length * CHOICE_LINE_H, 0) +
      BLOCK_GAP;

    return { qi, textLines, choiceLines, img, imgW, imgH, height };
  });
}

/**
 * Draws the top-of-page letterhead and returns the y where question columns
 * can start. The first page gets the full letterhead (logo, school name,
 * exam title, subject/score/time line, boxed คำชี้แจง rules) wrapped in one
 * outer border — matching the traditional bordered exam-cover-page layout
 * (a single table border framing the whole header) most Thai schools
 * already use for paper exams, rather than just the คำชี้แจง sub-box this
 * used to draw alone with a plain rule underneath. Continuation pages just
 * get a short "(ต่อ)" line so the two-column body has more room.
 */
function drawPageHeader(ctx, { schoolName, examTitle, subjectLine, scoreTimeLine, instructions, logoImg, contTitle, isFirstPage }) {
  let y = MARGIN;
  ctx.fillStyle = '#000';
  ctx.textAlign = 'left';
  if (isFirstPage) {
    const boxPad = 14;
    const contentX0 = MARGIN + boxPad;
    const contentW = CONTENT_W - boxPad * 2;
    const centerX = contentX0 + contentW / 2;
    const hasLogo = !!logoImg;
    const cy = MARGIN + boxPad;
    if (hasLogo) {
      // "Contain" the logo within the LOGO_SIZE box instead of stretching
      // it to fill a fixed square — most school logos/crests aren't
      // square, and drawImage with explicit width+height forces exactly
      // that aspect ratio, visibly distorting anything that isn't.
      const logoScale = Math.min(LOGO_SIZE / logoImg.width, LOGO_SIZE / logoImg.height);
      const logoW = logoImg.width * logoScale;
      const logoH = logoImg.height * logoScale;
      ctx.drawImage(logoImg, contentX0 + (LOGO_SIZE - logoW) / 2, cy + (LOGO_SIZE - logoH) / 2, logoW, logoH);
    }

    // School/title/subject/score lines center across the whole box width,
    // independent of the logo — a small badge pinned top-left plus a
    // centered title block, matching the traditional exam cover-page
    // layout, rather than text pushed right to clear the logo.
    ctx.textAlign = 'center';
    let ty = cy + 18;
    if (schoolName) {
      ctx.font = SCHOOL_FONT; ctx.fillStyle = '#000';
      ctx.fillText(schoolName, centerX, ty);
      ty += 25;
    }
    if (examTitle) {
      ctx.font = EXAM_TITLE_FONT; ctx.fillStyle = '#111';
      ctx.fillText(examTitle, centerX, ty);
      ty += 23;
    }
    ctx.font = SUBTITLE_FONT; ctx.fillStyle = '#333';
    ctx.fillText(subjectLine, centerX, ty);
    ty += 20;
    if (scoreTimeLine) {
      ctx.fillText(scoreTimeLine, centerX, ty);
      ty += 20;
    }
    ctx.textAlign = 'left';
    // ty already advanced one full line past the last line actually drawn
    // (subjectLine's or scoreTimeLine's trailing += 20, whichever ran
    // last) — undo that unused advance so the gap below is measured from
    // the real last baseline, not a phantom next line.
    let by = Math.max(cy + (hasLogo ? LOGO_SIZE : 0), ty - 20) + 8;

    if (instructions.length > 0) {
      const lineH = 19;
      const innerPad = 10;
      ctx.font = INSTRUCTION_FONT;
      const boxH = instructions.length * lineH + innerPad * 2;
      ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
      ctx.strokeRect(contentX0, by, contentW, boxH);
      ctx.fillStyle = '#222';
      instructions.forEach((line, i) => {
        ctx.fillText(line, contentX0 + innerPad, by + innerPad + 14 + i * lineH);
      });
      by += boxH;
    }

    y = by + boxPad;
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1;
    ctx.strokeRect(MARGIN, MARGIN, CONTENT_W, y - MARGIN);
    y += 18;
  } else {
    ctx.font = CONT_FONT; ctx.fillStyle = '#666';
    ctx.fillText(`${contTitle} (ต่อ)`, MARGIN, y + 13);
    y += 28;
  }
  return y;
}

function drawQuestionBlock(ctx, plan, x, y) {
  ctx.fillStyle = '#000';
  ctx.font = QNUM_FONT;
  const qLabel = `${plan.qi + 1}. `;
  const qLabelW = ctx.measureText(qLabel).width;
  ctx.fillText(qLabel, x, y + 16);
  ctx.font = BODY_FONT;
  plan.textLines.forEach((line, i) => {
    ctx.fillText(line, i === 0 ? x + qLabelW : x + 25, y + 16 + i * TEXT_LINE_H);
  });
  let cursorY = y + TEXT_LINE_H * plan.textLines.length;

  if (plan.img) {
    ctx.drawImage(plan.img, x + 25, cursorY, plan.imgW, plan.imgH);
    cursorY += plan.imgH + 13;
  }

  ctx.font = CHOICE_FONT;
  for (const lines of plan.choiceLines) {
    lines.forEach((line, li) => {
      ctx.fillText(line, x + CHOICE_INDENT, cursorY + 15 + li * CHOICE_LINE_H);
    });
    cursorY += lines.length * CHOICE_LINE_H;
  }

  return cursorY + BLOCK_GAP;
}

/**
 * Generates and downloads an A4 question-paper PDF for a ชุดข้อสอบ's
 * questions, one fixed order for the whole class (per the teacher's own
 * scoping — a shared paper exam, not per-student shuffling like the online
 * flow). Choice lettering (ก/ข/ค/ง, A/B/C/D, or 1/2/3/4) must match
 * whatever the class's OMR answer sheet uses — see syncPrintedOmrQuiz,
 * which is always called with the same choiceScheme for this reason.
 *
 * The letterhead and layout are fully caller-supplied (see ExamSetTool's
 * print dialog): schoolName/examTitle/subjectCode/totalScore/
 * durationMinutes/instructions build the letterhead, logoDataUrl (a data:
 * URI, e.g. from the admin's exam_app_logo config) prints a logo, and
 * columns (1 or 2) picks the body layout — 2 to match a traditional
 * two-column paper exam, 1 for a simpler single-column sheet.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   title: string, subjectName: string, subjectCode?: string, gradeLevel: string,
 *   questions: Array<{question_text:string, choices:string[], image_path:string|null}>,
 *   choiceScheme?: 'thai'|'en'|'num',
 *   schoolName?: string, examTitle?: string, totalScore?: number, durationMinutes?: number|string,
 *   instructions?: string[], columns?: 1|2, logoDataUrl?: string|null,
 * }} args
 */
export async function generateExamQuestionPaperPdf(supabase, {
  title, subjectName, subjectCode, gradeLevel, questions, choiceScheme = 'thai',
  schoolName = '', examTitle = '', totalScore, durationMinutes, instructions = [], columns = 2, logoDataUrl = null,
}) {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const [images, logoImg] = await Promise.all([
    loadQuestionImages(supabase, questions),
    logoDataUrl ? loadImage(logoDataUrl) : Promise.resolve(null),
  ]);

  const colLayout = getColumnLayout(columns === 1 ? 1 : 2);
  const plans = planQuestions(measureCtx, questions, choiceScheme, images, colLayout.width);

  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W * PRINT_SCALE;
  canvas.height = PAGE_H * PRINT_SCALE;
  const ctx = canvas.getContext('2d');

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const subjectLine = `รายวิชา ${subjectName}  รหัสวิชา ${subjectCode || '-'}  ชั้นมัธยมศึกษาปีที่ ${gradeLevel}`;
  const scoreTimeLine = [
    Number.isFinite(totalScore) && totalScore > 0 ? `คะแนนเต็ม ${totalScore} คะแนน` : '',
    Number(durationMinutes) > 0 ? `เวลา ${durationMinutes} นาที` : '',
  ].filter(Boolean).join('   ');
  const bottomLimit = PAGE_H - MARGIN - FOOTER_RESERVE;

  function resetCanvas() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(PRINT_SCALE, PRINT_SCALE);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  }

  function flushPage() {
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    pdf.addImage(imgData, 'JPEG', 0, 0, 210, 297);
  }

  function drawHeaderForPage(isFirstPage) {
    return drawPageHeader(ctx, { schoolName, examTitle, subjectLine, scoreTimeLine, instructions, logoImg, contTitle: title, isFirstPage });
  }

  resetCanvas();
  let headerY = drawHeaderForPage(true);
  drawColumnDivider(ctx, colLayout, headerY, bottomLimit);
  let colY = colLayout.xs.map(() => headerY);
  let colIndex = 0;

  for (const plan of plans) {
    let placed = false;
    while (colIndex < colLayout.xs.length) {
      if (colY[colIndex] + plan.height <= bottomLimit) { placed = true; break; }
      colIndex++;
    }
    if (!placed) {
      flushPage();
      pdf.addPage();
      resetCanvas();
      headerY = drawHeaderForPage(false);
      drawColumnDivider(ctx, colLayout, headerY, bottomLimit);
      colY = colLayout.xs.map(() => headerY);
      colIndex = 0;
      // A fresh page always accepts the next question even if it still
      // overflows the column (an unusually tall single question) — without
      // this, a question taller than one column's height would flush pages
      // forever without ever placing it.
    }
    colY[colIndex] = drawQuestionBlock(ctx, plan, colLayout.xs[colIndex], colY[colIndex]);
  }
  flushPage();

  pdf.save(`${title || 'ข้อสอบ'}.pdf`);
}
