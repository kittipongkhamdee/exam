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
  Document, Packer, Paragraph, TextRun, ImageRun,
  AlignmentType, BorderStyle, WidthType, Table, TableRow, TableCell, SectionType,
} from 'docx';
import { choiceLetters } from './omr-core';
import { getBankQuestionImageUrl } from './bank-db';

const PAGE_MARGIN = '10mm';
const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};
const BOX_BORDER = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
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

function letterheadChildren({ schoolName, examTitle, subjectLine, scoreTimeLine, logo }) {
  // Centered — matches exam-print.js's PDF letterhead, itself matching the
  // traditional bordered exam-cover-page layout (a small logo badge next
  // to a centered title block) a teacher shared as the reference.
  const textParagraphs = [];
  if (schoolName) {
    textParagraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: schoolName, bold: true, size: '14pt' })],
    }));
  }
  if (examTitle) {
    textParagraphs.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: examTitle, bold: true, size: '13pt' })],
    }));
  }
  textParagraphs.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: subjectLine, size: '11pt' })] }));
  if (scoreTimeLine) {
    textParagraphs.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: scoreTimeLine, size: '11pt' })] }));
  }

  if (!logo) return textParagraphs;

  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [
        new TableCell({
          width: { size: 15, type: WidthType.PERCENTAGE },
          borders: NO_BORDERS,
          children: [new Paragraph({ children: [new ImageRun(logo)] })],
        }),
        new TableCell({
          width: { size: 85, type: WidthType.PERCENTAGE },
          borders: NO_BORDERS,
          children: textParagraphs,
        }),
      ],
    })],
  })];
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
          children: [new TextRun({ text: line, size: '10.5pt' })],
        })),
      })],
    })],
  })];
}

function questionParagraphs(questions, choiceScheme, images) {
  const out = [];
  questions.forEach((q, qi) => {
    out.push(new Paragraph({
      spacing: { before: 200, after: 60 },
      children: [
        new TextRun({ text: `ข้อ ${qi + 1}. `, bold: true, size: '12pt' }),
        new TextRun({ text: q.question_text, size: '12pt' }),
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
        children: [new TextRun({ text: `${letters[ci]}. ${c}`, size: '11pt' })],
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
 *   questions: Array<{question_text:string, choices:string[], image_path:string|null}>,
 *   choiceScheme?: 'thai'|'en'|'num',
 *   schoolName?: string, examTitle?: string, totalScore?: number, durationMinutes?: number|string,
 *   instructions?: string[], columns?: 1|2, logoDataUrl?: string|null,
 * }} args
 */
export async function generateExamQuestionPaperDocx(supabase, {
  title, subjectName, subjectCode, gradeLevel, questions, choiceScheme = 'thai',
  schoolName = '', examTitle = '', totalScore, durationMinutes, instructions = [], columns = 2, logoDataUrl = null,
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
    sections: [
      { properties: { page: pageSetup }, children: headerChildren },
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
        children: questionParagraphs(questions, choiceScheme, images),
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
