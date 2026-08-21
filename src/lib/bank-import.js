// bank-import.js
//
// CSV import for the "คลังข้อสอบ" bank: lets a teacher upload a batch of
// questions in one file instead of typing them one-by-one via "เพิ่มข้อสอบเอง".
// Parses into the same draft-question shape BankTool.jsx's AI/manual flows
// already produce, so the existing review/edit/save UI (BankTool's step 2 —
// edit any field, remove a row, "บันทึกเข้าคลังทั้งหมด" via saveBankQuestions)
// handles the rest: this module only turns CSV text into
// { question_text, choices, correct_choice, explanation, difficulty,
// source: 'manual' } rows (or a list of per-row error messages) and builds
// the downloadable template that documents the expected column format.
//
// Deliberately a hand-rolled CSV reader, not the xlsx package's parser — a
// plain-text RFC4180 reader needs no third-party parsing of untrusted
// binary/zip input, side-stepping xlsx's known parse-path CVEs entirely
// (see item-analysis-export.js's header for that constraint).

const MAX_CHOICES = 6;

export const TEMPLATE_HEADERS = [
  'คำถาม',
  'ตัวเลือกที่ 1', 'ตัวเลือกที่ 2', 'ตัวเลือกที่ 3', 'ตัวเลือกที่ 4', 'ตัวเลือกที่ 5', 'ตัวเลือกที่ 6',
  'เฉลย (เลขข้อที่ถูก 1-6)',
  'คำอธิบายเฉลย (ไม่บังคับ)',
  'ระดับความยาก (ง่าย/ปานกลาง/ยาก)',
];

const DIFFICULTY_ALIASES = {
  'ง่าย': 'easy', easy: 'easy',
  'ปานกลาง': 'medium', medium: 'medium',
  'ยาก': 'hard', hard: 'hard',
};

// Minimal RFC4180 parser: handles quoted fields (with embedded commas,
// newlines, and "" escaped quotes) and bare CRLF/LF row breaks — enough for
// a spreadsheet-exported CSV without pulling in a dependency.
function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Downloads a .csv template with the header row this parser expects plus
 * one filled-in example row, so a teacher can open it in Excel/Sheets and
 * fill in their own questions in the same shape.
 */
export function downloadBankQuestionTemplate() {
  const example = [
    'ข้อใดคือเมืองหลวงของประเทศไทย',
    'กรุงเทพมหานคร', 'เชียงใหม่', 'ภูเก็ต', 'ขอนแก่น', '', '',
    '1',
    'กรุงเทพมหานครเป็นเมืองหลวงของประเทศไทย',
    'ง่าย',
  ];
  const csv = '﻿' + [TEMPLATE_HEADERS, example]
    .map(row => row.map(csvCell).join(','))
    .join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'แบบฟอร์มนำเข้าข้อสอบ.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Parses uploaded CSV text into draft-question objects ready to merge into
 * BankTool's draftQuestions list, plus any per-row error messages (rows
 * that fail validation are skipped, not fatal to the whole import).
 * @param {string} text
 * @returns {{ questions: Array<{question_text:string, choices:string[], correct_choice:number, explanation:string, difficulty:string, source:'manual', image_path:null, image_url:null}>, errors: string[] }}
 */
export function parseBankQuestionCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { questions: [], errors: ['ไฟล์ว่างเปล่า'] };

  // A header row (matching the template's first column) never carries valid
  // choices/answer so it'd otherwise surface as a bogus error row — skip it.
  const dataRows = rows[0][0]?.trim() === TEMPLATE_HEADERS[0] ? rows.slice(1) : rows;

  const questions = [];
  const errors = [];
  dataRows.forEach((cols, i) => {
    const rowNum = i + 2; // 1-based + the header row this file is expected to have
    const question_text = (cols[0] || '').trim();
    const choices = cols.slice(1, 1 + MAX_CHOICES).map(c => (c || '').trim()).filter(c => c !== '');
    const answerRaw = (cols[1 + MAX_CHOICES] || '').trim();
    const explanation = (cols[2 + MAX_CHOICES] || '').trim();
    const difficultyRaw = (cols[3 + MAX_CHOICES] || '').trim().toLowerCase();

    if (!question_text) { errors.push(`แถวที่ ${rowNum}: ไม่มีคำถาม`); return; }
    if (choices.length < 2) { errors.push(`แถวที่ ${rowNum}: ต้องมีตัวเลือกอย่างน้อย 2 ข้อ`); return; }
    const answerNum = Number(answerRaw);
    if (!Number.isInteger(answerNum) || answerNum < 1 || answerNum > choices.length) {
      errors.push(`แถวที่ ${rowNum}: เฉลยต้องเป็นเลข 1-${choices.length} ให้ตรงกับจำนวนตัวเลือกที่กรอก`);
      return;
    }

    questions.push({
      question_text,
      choices,
      correct_choice: answerNum - 1,
      explanation,
      difficulty: DIFFICULTY_ALIASES[difficultyRaw] || 'medium',
      source: 'manual',
      image_path: null,
      image_url: null,
    });
  });

  return { questions, errors };
}
