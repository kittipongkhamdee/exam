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
// A <canvas> lets the browser's own font rendering (the "Prompt" family,
// loaded app-wide — see layout.js) draw Thai correctly; each page's canvas
// then becomes one JPEG image embedded in the PDF, exactly like
// OMRPrepareTool's downloadSheetHalfA4/handleGenerateClassPDF.

import { jsPDF } from 'jspdf';
import { PAGE_W, PAGE_H, MARGIN, choiceLetters, wrapText } from './omr-core';
import { getBankQuestionImageUrl } from './bank-db';

const PRINT_SCALE = 3; // matches omr-core's PRINT_SCALE — sharp at print resolution
const FONT = '"Prompt", sans-serif';
const TITLE_FONT = `bold 18px ${FONT}`;
const SUBTITLE_FONT = `11px ${FONT}`;
const CONT_FONT = `11px ${FONT}`;
const INSTRUCTION_FONT = `10px ${FONT}`;
const QNUM_FONT = `bold 13px ${FONT}`;
const BODY_FONT = `13px ${FONT}`;
const CHOICE_FONT = `12px ${FONT}`;

const CONTENT_X = MARGIN;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CHOICE_INDENT = 20;
const MAX_IMAGE_H = 220;
const TEXT_LINE_H = 18;
const CHOICE_LINE_H = 17;
const BLOCK_GAP = 18;
const FOOTER_RESERVE = 20;

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

// One measurement/layout pass per question — wraps its text and each
// choice's text, and scales its image (if any) to fit the content column —
// producing everything the draw pass needs, plus the total height the
// question will occupy, used to decide where page breaks fall.
function planQuestions(measureCtx, questions, choiceScheme, images) {
  return questions.map((q, qi) => {
    measureCtx.font = BODY_FONT;
    const textLines = wrapText(measureCtx, q.question_text, CONTENT_W - 24);

    const letters = choiceLetters(choiceScheme, q.choices.length);
    measureCtx.font = CHOICE_FONT;
    const choiceLines = q.choices.map((c, ci) => wrapText(measureCtx, `${letters[ci]}. ${c}`, CONTENT_W - 24 - CHOICE_INDENT));

    const img = q.image_path ? images.get(q.image_path) : null;
    let imgW = 0, imgH = 0;
    if (img) {
      const maxW = CONTENT_W - 24;
      const scale = Math.min(1, maxW / img.width, MAX_IMAGE_H / img.height);
      imgW = Math.round(img.width * scale);
      imgH = Math.round(img.height * scale);
    }

    const height =
      TEXT_LINE_H * textLines.length +
      (img ? imgH + 10 : 0) +
      choiceLines.reduce((sum, lines) => sum + lines.length * CHOICE_LINE_H, 0) +
      BLOCK_GAP;

    return { qi, textLines, choiceLines, img, imgW, imgH, height };
  });
}

function drawPageHeader(ctx, { title, subjectLine, isFirstPage }) {
  let y = MARGIN;
  ctx.fillStyle = '#000';
  if (isFirstPage) {
    ctx.font = TITLE_FONT;
    ctx.fillText(title, MARGIN, y + 16);
    y += 26;
    ctx.font = SUBTITLE_FONT; ctx.fillStyle = '#333';
    ctx.fillText(subjectLine, MARGIN, y + 10);
    y += 22;
    ctx.font = INSTRUCTION_FONT; ctx.fillStyle = '#555';
    ctx.fillText('คำชี้แจง: เลือกคำตอบที่ถูกต้องที่สุดเพียงข้อเดียว แล้วระบายคำตอบลงในกระดาษคำตอบที่แจก', MARGIN, y + 8);
    y += 16;
    ctx.font = INSTRUCTION_FONT; ctx.fillStyle = '#333';
    ctx.fillText('ชื่อ-สกุล: ____________________________  ชั้น/ห้อง: __________  เลขที่: ______', MARGIN, y + 12);
    y += 22;
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(MARGIN, y); ctx.lineTo(PAGE_W - MARGIN, y); ctx.stroke();
    y += 16;
  } else {
    ctx.font = CONT_FONT; ctx.fillStyle = '#666';
    ctx.fillText(`${title} (ต่อ)`, MARGIN, y + 10);
    y += 22;
  }
  return y;
}

function drawQuestionBlock(ctx, plan, x, y) {
  ctx.fillStyle = '#000';
  ctx.font = QNUM_FONT;
  const qLabel = `ข้อ ${plan.qi + 1}. `;
  const qLabelW = ctx.measureText(qLabel).width;
  ctx.fillText(qLabel, x, y + 13);
  ctx.font = BODY_FONT;
  plan.textLines.forEach((line, i) => {
    ctx.fillText(line, i === 0 ? x + qLabelW : x + 20, y + 13 + i * TEXT_LINE_H);
  });
  let cursorY = y + TEXT_LINE_H * plan.textLines.length;

  if (plan.img) {
    ctx.drawImage(plan.img, x + 20, cursorY, plan.imgW, plan.imgH);
    cursorY += plan.imgH + 10;
  }

  ctx.font = CHOICE_FONT;
  for (const lines of plan.choiceLines) {
    lines.forEach((line, li) => {
      ctx.fillText(line, x + CHOICE_INDENT, cursorY + 12 + li * CHOICE_LINE_H);
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
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ title: string, subjectName: string, gradeLevel: string, room: string, questions: Array<{question_text:string, choices:string[], image_path:string|null}>, choiceScheme?: 'thai'|'en'|'num' }} args
 */
export async function generateExamQuestionPaperPdf(supabase, { title, subjectName, gradeLevel, room, questions, choiceScheme = 'thai' }) {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const images = await loadQuestionImages(supabase, questions);
  const plans = planQuestions(measureCtx, questions, choiceScheme, images);

  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W * PRINT_SCALE;
  canvas.height = PAGE_H * PRINT_SCALE;
  const ctx = canvas.getContext('2d');

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const subjectLine = `${subjectName} (ชั้น ${gradeLevel}/${room})`;
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

  let isFirstPage = true;
  resetCanvas();
  let y = drawPageHeader(ctx, { title, subjectLine, isFirstPage });
  isFirstPage = false;

  for (const plan of plans) {
    if (y + plan.height > bottomLimit) {
      flushPage();
      pdf.addPage();
      resetCanvas();
      y = drawPageHeader(ctx, { title, subjectLine, isFirstPage });
    }
    y = drawQuestionBlock(ctx, plan, CONTENT_X, y);
  }
  flushPage();

  pdf.save(`${title || 'ข้อสอบ'}.pdf`);
}
