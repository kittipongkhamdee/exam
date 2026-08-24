// exam-docx.js
//
// Generates the same printable ชุดข้อสอบ question paper as exam-print.js,
// but as a .docx a teacher can keep editing in Word afterward — the PDF
// there is a rasterized image (jsPDF has no Thai font, so real Thai text
// has to be drawn via canvas and flattened into a picture), which can
// never be edited as text again once downloaded. This module writes
// actual paragraphs/runs instead, no canvas involved: Word renders real
// Unicode text with whatever font is installed on the reading machine.
//
// Word's own two-column "newspaper" section (SectionType.CONTINUOUS +
// column.count) flows content between columns and across pages using
// real page/font metrics, so unlike exam-print.js this module never
// computes its own text wrapping or page breaks — the letterhead lives in
// a single-column section, then a continuous section break (same page,
// not a new one) switches to the question body's column count.

import {
  Document, Packer, Paragraph, TextRun, ImageRun, Header,
  AlignmentType, BorderStyle, WidthType, Table, TableRow, TableCell, SectionType,
  HorizontalPositionAlign, HorizontalPositionRelativeFrom,
  VerticalPositionAlign, VerticalPositionRelativeFrom, TextWrappingType,
} from 'docx';
import { choiceLetters, insertThaiZwsp } from './omr-core';
import { getBankQuestionImageUrl } from './bank-db';

// No run in this file ever set a `font` — every question paper has been
// rendered in whatever Word substitutes for Thai in its own default
// (Latin) font, not any actual Thai typeface. "TH Sarabun New" is the
// standard font Thai schools/government documents are conventionally
// expected to use (also this exact "thai-docx" skill's own default) —
// distinct from "Sarabun", the Google Fonts family exam-print.js's PDF
// path loads as a webfont, which isn't something a .docx can embed or
// rely on being installed on whatever machine opens it.
const THAI_FONT = 'TH Sarabun New';

// A real Word document lets Word's own layout engine decide line breaks —
// unlike exam-print.js's canvas, which wraps text itself — but Word has no
// built-in sense of Thai word boundaries to break on. Every TextRun's text
// goes through insertThaiZwsp() first, splicing an invisible zero-width
// space between each word omr-core's own Thai segmenter finds, so Word
// actually has somewhere sensible to break instead of wrapping wherever it
// likes (or not at all). Every run is also explicitly set to THAI_FONT
// (overridable via options.font) rather than relying solely on the
// document's default run style to cascade it everywhere.
function run(options) {
  return new TextRun({ font: THAI_FONT, ...options, text: insertThaiZwsp(options.text) });
}

const PAGE_MARGIN = '10mm';
const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};
const BOX_BORDER = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
const MAX_IMG_W_PX = 260;
const MAX_IMG_H_PX = 200;

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function mimeToDocxType(mime) {
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  return 'jpg';
}

function measureImage(bytes, mime) {
  return new Promise((resolve) => {
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// Loads one image (bytes + docx type + a "contain"-scaled pixel size) —
// shared by the logo and every question image, so both come out with a
// docx.js-ready ImageRun options object and never get stretched off their
// real aspect ratio (see exam-print.js's own fix for the same class of
// bug in the PDF path).
async function loadDocxImage(bytes, mime, maxW, maxH) {
  const dims = await measureImage(bytes, mime);
  if (!dims) return null;
  const scale = Math.min(maxW / dims.w, maxH / dims.h, 1);
  return {
    type: mimeToDocxType(mime),
    data: bytes,
    transformation: { width: Math.round(dims.w * scale), height: Math.round(dims.h * scale) },
  };
}

async function loadLogo(logoDataUrl) {
  if (!logoDataUrl) return null;
  try {
    const mime = logoDataUrl.slice(5, logoDataUrl.indexOf(';'));
    return await loadDocxImage(dataUrlToBytes(logoDataUrl), mime, 120, 120);
  } catch {
    return null;
  }
}

async function loadQuestionImages(supabase, questions) {
  const paths = [...new Set(questions.map(q => q.image_path).filter(Boolean))];
  const images = new Map();
  await Promise.all(paths.map(async path => {
    try {
      const url = await getBankQuestionImageUrl(supabase, path, 300);
      const res = await fetch(url);
      const mime = res.headers.get('content-type') || 'image/jpeg';
      const bytes = new Uint8Array(await res.arrayBuffer());
      images.set(path, await loadDocxImage(bytes, mime, MAX_IMG_W_PX, MAX_IMG_H_PX));
    } catch {
      images.set(path, null);
    }
  }));
  return images;
}

// Logo floats as an independent badge pinned top-left instead of sharing a
// table row with the title text — a nested table's percentage-width cell
// was squeezing school/title/subject/score into whatever narrow column was
// left over, so it never actually centered across the true page width. As
// a floating image (wrap: NONE, so it never pushes text around) anchored
// to the containing cell (layoutInCell), the text paragraphs below are
// free to be plain full-width centered paragraphs — matching how
// exam-print.js's PDF letterhead already centers its title across the
// whole box width, independent of the logo.
function letterheadChildren({ schoolName, examTitle, subjectLine, scoreTimeLine, logo }) {
  const lines = [];
  if (schoolName) lines.push({ text: schoolName, bold: true, size: '14pt' });
  if (examTitle) lines.push({ text: examTitle, bold: true, size: '13pt' });
  lines.push({ text: subjectLine, size: '11pt' });
  if (scoreTimeLine) lines.push({ text: scoreTimeLine, size: '11pt' });

  return lines.map((opts, i) => new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      ...(i === 0 && logo ? [new ImageRun({
        ...logo,
        floating: {
          horizontalPosition: { relative: HorizontalPositionRelativeFrom.COLUMN, align: HorizontalPositionAlign.LEFT },
          verticalPosition: { relative: VerticalPositionRelativeFrom.PARAGRAPH, align: VerticalPositionAlign.TOP },
          wrap: { type: TextWrappingType.NONE },
          layoutInCell: true,
          allowOverlap: false,
        },
      })] : []),
      run(opts),
    ],
  }));
}

function instructionsBox(instructions) {
  if (instructions.length === 0) return [];
  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: BOX_BORDER, bottom: BOX_BORDER, left: BOX_BORDER, right: BOX_BORDER },
    rows: [new TableRow({
      children: [new TableCell({
        borders: NO_BORDERS,
        children: instructions.map(line => new Paragraph({
          spacing: { after: 40 },
          children: [run({ text: line, size: '10.5pt' })],
        })),
      })],
    })],
  })];
}

function questionParagraphs(questions, choiceScheme, images, groupByIndicator) {
  const out = [];
  let prevIndicatorId;
  questions.forEach((q, qi) => {
    // Same rule as exam-print.js's planQuestions: only a question entering
    // a NEW indicator group gets a header, and only when it actually has
    // one — no "ไม่มีตัวชี้วัด" label printed on the student's paper. Code
    // and description run together on one line (code bold, description
    // regular), matching the PDF generator. keepNext asks Word to keep this
    // paragraph attached to the question paragraph that follows, so a
    // column/page break doesn't strand the header on its own —
    // exam-print.js gets this for free by folding the header into the same
    // question's height instead.
    if (groupByIndicator && q.indicator_id != null && q.indicator_id !== prevIndicatorId && q.indicators?.indicator_code) {
      out.push(new Paragraph({
        keepNext: true,
        spacing: { before: 200, after: 0 },
        children: [
          run({ text: `ตัวชี้วัด ${q.indicators.indicator_code}`, bold: true, size: '10.5pt' }),
          ...(q.indicators.indicator_text ? [run({ text: `  ${q.indicators.indicator_text}`, size: '10.5pt' })] : []),
        ],
      }));
    }
    prevIndicatorId = q.indicator_id;

    out.push(new Paragraph({
      spacing: { before: 200, after: 60 },
      children: [
        run({ text: `ข้อ ${qi + 1}. `, bold: true, size: '12pt' }),
        run({ text: q.question_text, size: '12pt' }),
      ],
    }));
    const img = q.image_path ? images.get(q.image_path) : null;
    if (img) {
      out.push(new Paragraph({
        indent: { left: 300 },
        spacing: { after: 60 },
        children: [new ImageRun(img)],
      }));
    }
    const letters = choiceLetters(choiceScheme, q.choices.length);
    q.choices.forEach((c, ci) => {
      out.push(new Paragraph({
        indent: { left: 300 },
        spacing: { after: 40 },
        children: [run({ text: `${letters[ci]}. ${c}`, size: '11pt' })],
      }));
    });
  });
  return out;
}

/**
 * Generates and downloads a .docx question paper for a ชุดข้อสอบ, mirroring
 * exam-print.js's generateExamQuestionPaperPdf — same caller-supplied
 * letterhead/layout args, same choiceScheme contract with syncPrintedOmrQuiz.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   title: string, subjectName: string, subjectCode?: string, gradeLevel: string,
 *   questions: Array<{question_text:string, choices:string[], image_path:string|null, indicator_id?:number|null, indicators?:{indicator_code:string, indicator_text:string}}>,
 *   choiceScheme?: 'thai'|'en'|'num', setCode?: number,
 *   schoolName?: string, examTitle?: string, totalScore?: number, durationMinutes?: number|string,
 *   instructions?: string[], columns?: 1|2, logoDataUrl?: string|null,
 *   groupByIndicator?: boolean,
 * }} args
 */
export async function generateExamQuestionPaperDocx(supabase, {
  title, subjectName, subjectCode, gradeLevel, questions, choiceScheme = 'thai', setCode,
  schoolName = '', examTitle = '', totalScore, durationMinutes, instructions = [], columns = 2, logoDataUrl = null,
  groupByIndicator = false,
}) {
  const [images, logo] = await Promise.all([
    loadQuestionImages(supabase, questions),
    loadLogo(logoDataUrl),
  ]);

  const subjectLine = `รายวิชา ${subjectName}  รหัสวิชา ${subjectCode || '-'}  ชั้นมัธยมศึกษาปีที่ ${gradeLevel}`;
  const scoreTimeLine = [
    Number.isFinite(totalScore) && totalScore > 0 ? `คะแนนเต็ม ${totalScore} คะแนน` : '',
    Number(durationMinutes) > 0 ? `เวลา ${durationMinutes} นาที` : '',
  ].filter(Boolean).join('   ');

  const pageSetup = { size: { width: '210mm', height: '297mm' }, margin: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN } };

  // A running header (repeats on every page, unlike a one-off paragraph)
  // showing รหัสชุดข้อสอบ top-right — same spot exam-print.js stamps it
  // in the PDF, so a teacher can match a stack of printed papers to the
  // right ชุดข้อสอบ while grading regardless of which page a sheet is on.
  // Word requires each section to declare its own header for one to show,
  // so both sections below get their own instance (docx.js assigns each
  // Header its own relationship id — sharing one object across sections
  // isn't a documented/safe pattern here).
  const setCodeLabel = Number.isFinite(setCode) ? `รหัส ${String(setCode).padStart(3, '0')}` : null;
  function makeSetCodeHeader() {
    if (!setCodeLabel) return {};
    return {
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [run({ text: setCodeLabel, size: '10.5pt' })],
          })],
        }),
      },
    };
  }

  // The whole letterhead (logo/school/title/subject/score lines + the
  // คำชี้แจง box) sits inside one outer border — matching the traditional
  // bordered exam-cover-page layout most Thai schools already use (a
  // single table border framing the whole header), rather than just
  // boxing the คำชี้แจง lines alone with a plain rule underneath.
  const headerChildren = [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: BOX_BORDER, bottom: BOX_BORDER, left: BOX_BORDER, right: BOX_BORDER },
      rows: [new TableRow({
        children: [new TableCell({
          borders: NO_BORDERS,
          margins: { top: 150, bottom: 150, left: 150, right: 150 },
          children: [
            ...letterheadChildren({ schoolName, examTitle, subjectLine, scoreTimeLine, logo }),
            ...instructionsBox(instructions),
          ],
        })],
      })],
    }),
    new Paragraph({ spacing: { before: 160, after: 80 }, children: [] }),
  ];

  const doc = new Document({
    // Every run in this document is Thai (or Thai/English mixed) — without
    // a language tag, Word has no signal to apply its Thai (complex-script)
    // line-breaking rules and can wrap far less predictably than intended.
    // Setting it once here on the document's default run style, rather
    // than on every individual TextRun, is enough: everything inherits it
    // unless a run overrides its own language.
    styles: {
      default: {
        document: {
          run: { font: THAI_FONT, language: { value: 'th-TH', eastAsia: 'th-TH', bidirectional: 'th-TH' } },
        },
      },
    },
    sections: [
      { properties: { page: pageSetup }, children: headerChildren, ...makeSetCodeHeader() },
      {
        properties: {
          page: pageSetup,
          type: SectionType.CONTINUOUS,
          // separate turns on Word's own column-divider rule (OOXML w:sep)
          // — its only line-style option, solid rather than dashed, but the
          // closest native Word equivalent to the ปรุ divider line
          // exam-print.js draws dashed on the PDF's canvas.
          column: { count: columns === 1 ? 1 : 2, space: '0.7cm', separate: columns !== 1 },
        },
        children: questionParagraphs(questions, choiceScheme, images, groupByIndicator),
        ...makeSetCodeHeader(),
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title || 'ข้อสอบ'}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
