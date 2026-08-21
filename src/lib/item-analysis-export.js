// item-analysis-export.js
//
// Excel (.xlsx) and PDF export for "ผลการวิเคราะห์คุณภาพข้อสอบ" — the
// analyzeItems() (item-analysis.js) output ItemAnalysisTable.jsx renders,
// shared by both รายงานคะแนน (OMR) and รายงาน (online exam). Callers pass
// plain-text rowLabels here (not the JSX ItemAnalysisTable itself accepts),
// since neither export format can render React elements.
//
// The xlsx package (SheetJS) has known CVEs in its *parsing* path
// (prototype pollution / ReDoS on untrusted input) — this module only ever
// calls the write side (aoa_to_sheet + writeFile) to build a file from data
// this app already computed itself, never XLSX.read on anything, so that
// exposure doesn't apply here. Don't add a `XLSX.read`/`readFile` call to
// this file without re-checking that.

import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import { PAGE_W, PAGE_H, MARGIN, wrapText } from './omr-core';

const PRINT_SCALE = 3;
const FONT = '"Sarabun", sans-serif';
const TITLE_FONT = `bold 16px ${FONT}`;
const SUBTITLE_FONT = `11px ${FONT}`;
const CONT_FONT = `11px ${FONT}`;
const HEADER_FONT = `bold 11px ${FONT}`;
const CELL_FONT = `11px ${FONT}`;
const FOOTER_FONT = `11px ${FONT}`;

const CONTENT_X = MARGIN;
const CONTENT_W = PAGE_W - MARGIN * 2;
const ROW_LINE_H = 15;
const ROW_PAD = 6;
const FOOTER_RESERVE = 20;

// Column layout as fractions of CONTENT_W — ข้อที่ gets the most room since
// the online-exam report's labels carry the question text, not just a bare
// number like the OMR report's.
const COLS = [
  { key: 'label', label: 'ข้อที่', frac: 0.40, align: 'left' },
  { key: 'p', label: 'ความยาก (p)', frac: 0.11, align: 'right' },
  { key: 'pVerdict', label: 'แปลผล', frac: 0.13, align: 'left' },
  { key: 'r', label: 'อำนาจจำแนก (r)', frac: 0.12, align: 'right' },
  { key: 'rVerdict', label: 'แปลผล', frac: 0.13, align: 'left' },
  { key: 'verdict', label: 'สรุป', frac: 0.11, align: 'left' },
];

function fmt2(v) { return v === null || v === undefined ? '—' : v.toFixed(2); }
function fmt4(v) { return v === null || v === undefined ? '—' : v.toFixed(4); }

function withColX() {
  let x = CONTENT_X;
  return COLS.map(c => {
    const width = CONTENT_W * c.frac;
    const col = { ...c, x, width };
    x += width;
    return col;
  });
}

/**
 * Downloads a .xlsx workbook of the item-analysis table plus its summary
 * (n, KR-20) and the verdict criteria note.
 * @param {{ fileTitle: string, title: string, subjectLine: string, analysis: { items: Array<{p:number|null, r:number|null, pVerdict:string|null, rVerdict:string|null, verdict:string|null}>, kr20: number|null, n: number }, rowLabels: string[] }} args
 */
export function exportItemAnalysisExcel({ fileTitle, title, subjectLine, analysis, rowLabels }) {
  const sheetData = [
    [title],
    [subjectLine],
    [],
    ['ข้อที่', 'ความยาก (p)', 'แปลผล', 'อำนาจจำแนก (r)', 'แปลผล', 'สรุป'],
    ...analysis.items.map((it, i) => [
      rowLabels[i] || `ข้อ ${i + 1}`,
      it.p === null ? '' : Number(it.p.toFixed(4)),
      it.pVerdict || '',
      it.r === null ? '' : Number(it.r.toFixed(4)),
      it.rVerdict || '',
      it.verdict || '',
    ]),
    [],
    ['จำนวนที่นำมาวิเคราะห์', `${analysis.n} คน`],
    ['KR-20 Reliability', analysis.kr20 === null ? '' : Number(analysis.kr20.toFixed(4))],
    [],
    ['เกณฑ์: ความยาก (p) 0.20–0.80 = ใช้ได้ · อำนาจจำแนก (r) ≥ 0.20 = ใช้ได้ · ข้อที่ใช้ได้ทั้งสองค่าจึงสรุปว่า "ใช้ได้" นอกนั้นแนะนำปรับปรุงหรือตัดทิ้ง'],
  ];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  ws['!cols'] = [{ wch: 44 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'วิเคราะห์คุณภาพข้อสอบ');
  XLSX.writeFile(wb, `${fileTitle}.xlsx`);
}

function drawHeader(ctx, { title, subjectLine, isFirstPage }) {
  let y = MARGIN;
  ctx.fillStyle = '#000';
  if (isFirstPage) {
    ctx.font = TITLE_FONT;
    ctx.fillText('ผลการวิเคราะห์คุณภาพข้อสอบ', MARGIN, y + 14);
    y += 24;
    ctx.font = SUBTITLE_FONT; ctx.fillStyle = '#333';
    ctx.fillText(title, MARGIN, y + 10);
    y += 18;
    ctx.fillText(subjectLine, MARGIN, y + 10);
    y += 22;
  } else {
    ctx.font = CONT_FONT; ctx.fillStyle = '#666';
    ctx.fillText(`${title} (ต่อ)`, MARGIN, y + 10);
    y += 22;
  }
  return y;
}

function drawTableHeader(ctx, cols, y) {
  ctx.font = HEADER_FONT; ctx.fillStyle = '#111';
  const rowH = ROW_LINE_H + ROW_PAD;
  for (const c of cols) {
    ctx.textAlign = c.align === 'right' ? 'right' : 'left';
    const tx = c.align === 'right' ? c.x + c.width - 4 : c.x;
    ctx.fillText(c.label, tx, y + ROW_LINE_H);
  }
  ctx.textAlign = 'left';
  ctx.strokeStyle = '#999'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(CONTENT_X, y + rowH); ctx.lineTo(CONTENT_X + CONTENT_W, y + rowH); ctx.stroke();
  return y + rowH + 4;
}

/**
 * Downloads a Sarabun-rendered A4 PDF of the same table (canvas-then-
 * rasterize, matching exam-print.js/omr-core.js — jsPDF's own text() has no
 * Thai font).
 * @param {{ fileTitle: string, title: string, subjectLine: string, analysis: { items: Array<{p:number|null, r:number|null, pVerdict:string|null, rVerdict:string|null, verdict:string|null}>, kr20: number|null, n: number }, rowLabels: string[] }} args
 */
export function exportItemAnalysisPdf({ fileTitle, title, subjectLine, analysis, rowLabels }) {
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  const cols = withColX();

  const plans = analysis.items.map((it, i) => {
    const label = rowLabels[i] || `ข้อ ${i + 1}`;
    measureCtx.font = CELL_FONT;
    const labelLines = wrapText(measureCtx, label, cols[0].width - 8);
    const cells = {
      label: labelLines,
      p: [fmt2(it.p)],
      pVerdict: [it.pVerdict || '—'],
      r: [fmt4(it.r)],
      rVerdict: [it.rVerdict || '—'],
      verdict: [it.verdict || '—'],
    };
    const lineCount = Math.max(...Object.values(cells).map(lines => lines.length));
    return { cells, height: lineCount * ROW_LINE_H + ROW_PAD };
  });

  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W * PRINT_SCALE;
  canvas.height = PAGE_H * PRINT_SCALE;
  const ctx = canvas.getContext('2d');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
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

  function newPage(isFirstPage) {
    if (!isFirstPage) { flushPage(); pdf.addPage(); }
    resetCanvas();
    let y = drawHeader(ctx, { title, subjectLine, isFirstPage });
    y = drawTableHeader(ctx, cols, y);
    return y;
  }

  let y = newPage(true);

  for (const plan of plans) {
    if (y + plan.height > bottomLimit) {
      y = newPage(false);
    }
    ctx.font = CELL_FONT; ctx.fillStyle = '#222';
    for (const c of cols) {
      const lines = plan.cells[c.key];
      ctx.textAlign = c.align === 'right' ? 'right' : 'left';
      const tx = c.align === 'right' ? c.x + c.width - 4 : c.x;
      lines.forEach((line, li) => ctx.fillText(line, tx, y + ROW_LINE_H - 3 + li * ROW_LINE_H));
    }
    ctx.textAlign = 'left';
    y += plan.height;
  }

  const footerHeight = 60;
  if (y + footerHeight > bottomLimit) {
    y = newPage(false);
  }
  y += 12;
  ctx.font = FOOTER_FONT; ctx.fillStyle = '#111';
  ctx.fillText(`จำนวนที่นำมาวิเคราะห์: ${analysis.n} คน`, MARGIN, y);
  y += 18;
  ctx.fillText(`KR-20 Reliability: ${fmt4(analysis.kr20)}`, MARGIN, y);
  y += 22;
  ctx.font = CONT_FONT; ctx.fillStyle = '#666';
  const criteriaLines = wrapText(ctx, 'เกณฑ์: ความยาก (p) 0.20–0.80 = ใช้ได้ · อำนาจจำแนก (r) ≥ 0.20 = ใช้ได้ · ข้อที่ใช้ได้ทั้งสองค่าจึงสรุปว่า "ใช้ได้" นอกนั้นแนะนำปรับปรุงหรือตัดทิ้ง', CONTENT_W);
  criteriaLines.forEach((line, i) => ctx.fillText(line, MARGIN, y + i * 14));

  flushPage();
  pdf.save(`${fileTitle}.pdf`);
}
