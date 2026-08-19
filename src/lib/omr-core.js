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

function buildLayout(numQuestions, numChoices, idDigits, pageW = PAGE_W, pageH = PAGE_H, layoutStyle = 'auto') {
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
      questions, idGrid, cols: numCols, perCol, layoutStyle: 'topBottom',
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

    return { questions, idGrid, cols: 3, perCol, layoutStyle: 'zipFull', headerBottom, idStartX, idStartY, idColW, idBottom, qStartY, colW, colGap };
  }

  // pageW controls how many columns the questions wrap into: a narrower page
  // (half-sheet) naturally fits fewer question-columns per available width,
  // so this recomputes the wrap point based on the actual page width rather
  // than assuming the full-page width always.
  const usableW = pageW - MARGIN * 2;
  const singleColW = 140; // approx width needed for qLabel + 4-5 choice bubbles
  const maxCols = Math.max(1, Math.floor(usableW / singleColW));
  const cols = numQuestions > 30 ? Math.min(2, maxCols) : (pageW < PAGE_W * 0.75 && numQuestions > 12 ? Math.min(2, maxCols) : 1);
  const perCol = Math.ceil(numQuestions / cols);
  const startY = 340; // half-sheet stacks the ID grid above questions so needs more clearance
  const rowH = 26;
  const colW = usableW / cols;
  const bubbleR = 8;
  const choiceGap = 26;
  const qLabelW = 40;

  const questions = [];
  for (let q = 0; q < numQuestions; q++) {
    const col = Math.floor(q / perCol);
    const rowInCol = q % perCol;
    const x0 = MARGIN + col * colW + qLabelW;
    const y = startY + rowInCol * rowH;
    const choices = [];
    for (let c = 0; c < numChoices; c++) {
      choices.push({ x: x0 + c * choiceGap, y, r: bubbleR });
    }
    questions.push({ index: q, labelX: MARGIN + col * colW, labelY: y, choices });
  }

  // Student ID grid sits below the title on the half sheet (too narrow to
  // place it beside the title like the full sheet does).
  const idStartX = MARGIN;
  const idStartY = 150;
  const idGrid = [];
  for (let d = 0; d < idDigits; d++) {
    const digits = [];
    for (let v = 0; v <= 9; v++) {
      digits.push({ x: idStartX + d * 24, y: idStartY + v * 18, r: 6, value: v });
    }
    idGrid.push(digits);
  }

  return { questions, idGrid, cols, perCol, layoutStyle: 'halfPortrait' };
}

function drawFiducials(ctx, pageW = PAGE_W, pageH = PAGE_H) {
  ctx.fillStyle = '#000';
  const positions = [
    [MARGIN, MARGIN],
    [pageW - MARGIN - MARKER, MARGIN],
    [MARGIN, pageH - MARGIN - MARKER],
    [pageW - MARGIN - MARKER, pageH - MARGIN - MARKER],
  ];
  positions.forEach(([x, y]) => ctx.fillRect(x, y, MARKER, MARKER));
  return positions;
}

function choiceLetters(scheme, n) {
  if (scheme === 'thai') return ['ก','ข','ค','ง','จ'].slice(0, n);
  if (scheme === 'num') return ['1','2','3','4','5'].slice(0, n);
  return ['A','B','C','D','E'].slice(0, n);
}

function drawSheet(canvas, opts, answers) {
  const pageW = opts.pageW || PAGE_W;
  const pageH = opts.pageH || PAGE_H;
  const layoutStyle = opts.layoutStyle || 'auto';
  const ctx = canvas.getContext('2d');
  canvas.width = pageW; canvas.height = pageH;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, pageW, pageH);

  const layout = buildLayout(opts.numQuestions, opts.numChoices, opts.idDigits, pageW, pageH, layoutStyle);
  const letters = choiceLetters(opts.scheme, opts.numChoices);
  const resolvedStyle = layout.layoutStyle;

  if (resolvedStyle === 'topBottom') {
    // ---------- Compact boxed-header layout, for a half-height sheet ----------
    // Renders ONE such sheet; the caller draws this twice (top half + bottom
    // half) onto a full A4 canvas with its own fiducial markers each time.
    drawFiducials(ctx, pageW, pageH);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 15px "Prompt", sans-serif';
    ctx.fillText(opts.title || 'กระดาษคำตอบ', MARGIN + MARKER + 8, MARGIN + 16);

    // Left box: name + class/room/no, two rows separated by a line.
    const nameBoxY = layout.headerBoxY, nameBoxH = layout.nameBoxH;
    const nameBoxX = layout.nameBoxX, nameBoxW = layout.nameBoxW;
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.2;
    ctx.strokeRect(nameBoxX, nameBoxY, nameBoxW, nameBoxH);
    ctx.beginPath();
    ctx.moveTo(nameBoxX, nameBoxY + nameBoxH / 2);
    ctx.lineTo(nameBoxX + nameBoxW, nameBoxY + nameBoxH / 2);
    ctx.stroke();
    ctx.font = '10px "Prompt", sans-serif'; ctx.fillStyle = '#000';
    ctx.fillText('ชื่อ-สกุล: ________________________________', nameBoxX + 8, nameBoxY + nameBoxH * 0.32 + 4);
    ctx.fillText('ชั้น/ห้อง: _______  เลขที่: _______', nameBoxX + 8, nameBoxY + nameBoxH * 0.82 + 4);

    // Right box: student ID grid, right-aligned to the page edge.
    ctx.strokeRect(layout.idBoxX, layout.headerBoxY, layout.idBoxW, layout.idBoxH);
    ctx.font = 'bold 10px "Prompt", sans-serif'; ctx.fillStyle = '#000';
    ctx.fillText('รหัสนักเรียน (ฝนบรรทัดละ 1 ตัว)', layout.idBoxX + 10, layout.headerBoxY + 14);

    // Column headers 0-9 above the ID rows
    ctx.font = 'bold 9px "Prompt", sans-serif'; ctx.fillStyle = '#666';
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

    ctx.font = '9px "Prompt", sans-serif'; ctx.fillStyle = '#555';
    ctx.fillText('คำชี้แจง: ใช้ดินสอ 2B ระบายวงกลมคำตอบให้เต็มวง ข้อละ 1 ตัวเลือก', MARGIN, layout.instructionY);

    // Column choice-letter headers, once per question column
    ctx.font = 'bold 9px "Prompt", sans-serif';
    for (let col = 0; col < layout.cols; col++) {
      const q0 = layout.questions.find(q => q.col === col);
      if (!q0) continue;
      letters.forEach((L, ci) => {
        ctx.fillStyle = '#666';
        ctx.fillText(L, q0.choices[ci].x - 3, q0.labelY - 11);
      });
    }

    ctx.font = '10px "Prompt", sans-serif';
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

  drawFiducials(ctx, pageW, pageH);

  if (resolvedStyle === 'zipFull') {
    // ---------- ZipGrade-style full-page layout ----------
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 18px "Prompt", sans-serif';
    ctx.fillText(opts.title || 'กระดาษคำตอบ', MARGIN + MARKER + 10, MARGIN + 18);
    ctx.font = '11px "Prompt", sans-serif';
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
    ctx.font = 'bold 10px "Prompt", sans-serif'; ctx.fillStyle = '#333';
    ctx.fillText('ชื่อ', boxX + 6, boxY + 15);
    ctx.fillText('ชั้น', boxX + 6, boxY + rowH2 + 15);
    ctx.fillText('วันที่', dateLabelX - labelW + 6, boxY + 15);
    ctx.fillText('รหัสวิชา', dateLabelX - labelW + 6, boxY + rowH2 + 15);

    const headerBottom = layout.headerBottom;

    // Student ID grid header + digits
    ctx.font = '10px "Prompt", sans-serif'; ctx.fillStyle = '#000';
    ctx.fillText('รหัสนักเรียน', layout.idStartX, headerBottom + 16);
    layout.idGrid.forEach((digitCol) => {
      digitCol.forEach((cell) => {
        ctx.beginPath();
        ctx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
        ctx.font = '8px "Prompt", sans-serif'; ctx.fillStyle = '#333';
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
    ctx.font = 'bold 10px "Prompt", sans-serif';
    for (let col = 0; col < 3; col++) {
      const q0 = layout.questions.find(q => q.col === col);
      if (!q0) continue;
      letters.forEach((L, ci) => {
        ctx.fillStyle = '#666';
        ctx.fillText(L, q0.choices[ci].x - 4, q0.labelY - 12);
      });
    }

    ctx.font = '11px "Prompt", sans-serif';
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

  // ---------- Half-page layout (unchanged) ----------
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 13px "Prompt", sans-serif';
  ctx.fillText(opts.title || 'กระดาษคำตอบ', MARGIN + MARKER + 10, MARGIN + 14);
  ctx.font = '9px "Prompt", sans-serif';
  ctx.fillText(opts.subject || '', MARGIN + MARKER + 10, MARGIN + 28);

  // Half-page header is a tight vertical stack: title, subject, then name
  // line clearly below both (not sharing a baseline with the subject).
  ctx.font = '9px "Prompt", sans-serif';
  ctx.fillText('ชื่อ-นามสกุล: ________________________', MARGIN, MARGIN + MARKER + 22);

  ctx.font = '9px "Prompt", sans-serif';
  ctx.fillStyle = '#000';
  ctx.fillText('เลขที่ / รหัสนักเรียน:', MARGIN, MARGIN + MARKER + 42);

  // ID grid — a header row above it labels each column with its place value
  // (หมื่น/พัน/ร้อย/สิบ/หน่วย) so students don't fill digits into the wrong
  // column, which is an easy mistake with a 5-column grid of bare 0-9s.
  const placeNames = ['หมื่น','พัน','ร้อย','สิบ','หน่วย'];
  const idDigitCount = layout.idGrid.length;
  const placeLabelsForCount = placeNames.slice(placeNames.length - idDigitCount);
  ctx.font = 'bold 8px "Prompt", sans-serif';
  ctx.fillStyle = '#666';
  layout.idGrid.forEach((digitCol, d) => {
    if (digitCol.length === 0) return;
    const label = placeLabelsForCount[d] || '';
    const topCellY = digitCol[0].y;
    ctx.fillText(label, digitCol[0].x - 10, topCellY - 10);
  });

  layout.idGrid.forEach((digitCol) => {
    digitCol.forEach((cell) => {
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cell.r, 0, Math.PI * 2);
      ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = '8px "Prompt", sans-serif';
      ctx.fillStyle = '#333';
      ctx.fillText(String(cell.value), cell.x - 3, cell.y + 3);
      const digitIndex = layout.idGrid.indexOf(digitCol);
      if (answers && answers.studentId && answers.studentId[digitIndex] === String(cell.value)) {
        ctx.beginPath();
        ctx.arc(cell.x, cell.y, cell.r - 2, 0, Math.PI * 2);
        ctx.fillStyle = '#000'; ctx.fill();
      }
    });
  });

  // Header row for choice letters (once per column)
  ctx.font = 'bold 11px "Prompt", sans-serif';
  for (let col = 0; col < layout.cols; col++) {
    letters.forEach((L, ci) => {
      const q0 = layout.questions.find(q => q.index === col * layout.perCol);
      if (!q0) return;
      const x = q0.choices[ci].x;
      ctx.fillStyle = '#666';
      ctx.fillText(L, x - 4, layout.questions[0].labelY - 12);
    });
  }

  ctx.font = '12px "Prompt", sans-serif';
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

// Find the 4 solid-black square markers near the 4 corners of the page.
// Instead of averaging all dark pixels in a quadrant (which gets dragged off-target
// by background clutter like desk surface, shadows, or hands), find the largest
// compact dark connected blob in each quadrant using flood fill, and use its
// bounding-box center. This is robust to a dark background around the page.
function findFiducials(gray, width, height) {
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
  const corners = quadrants.map(qd => {
    const localThreshold = otsuThresholdRegion(gray, width, height, qd);
    const candidates = findBlobCandidates(gray, width, height, qd, localThreshold);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const da = (a.x-qd.cornerX)**2 + (a.y-qd.cornerY)**2;
      const db = (b.x-qd.cornerX)**2 + (b.y-qd.cornerY)**2;
      return da - db;
    });
    return candidates[0];
  });
  return { corners, threshold: otsuThreshold(gray) };
}

// Otsu threshold computed over a single rectangular region only, rather
// than the whole image — adapts to that region's local lighting.
function otsuThresholdRegion(gray, width, height, region) {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.min(width, Math.ceil(region.x1));
  const y1 = Math.min(height, Math.ceil(region.y1));
  const hist = new Array(256).fill(0);
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      hist[Math.min(255, Math.max(0, Math.round(gray[y*width+x])))]++;
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

// Flood-fill based connected-component search: returns ALL plausibly
// marker-shaped dark blobs within a region (not just the largest one),
// so the caller can pick the most geometrically sensible candidate.
function findBlobCandidates(gray, width, height, region, threshold) {
  const x0 = Math.max(0, Math.floor(region.x0));
  const y0 = Math.max(0, Math.floor(region.y0));
  const x1 = Math.min(width, Math.ceil(region.x1));
  const y1 = Math.min(height, Math.ceil(region.y1));
  const rw = x1 - x0, rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return [];

  const visited = new Uint8Array(rw * rh);
  const isDark = (x, y) => gray[y*width + x] < threshold;

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
        // edge of the marker.
        results.push({ x: sumX / count, y: sumY / count, count, bw, bh });
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

function warpImage(srcCanvas, corners, pageW = PAGE_W, pageH = PAGE_H) {
  // corners detected in order TL,TR,BL,BR (from quadrant scan order).
  // IMPORTANT: these are the CENTROIDS of the marker squares in the photo,
  // so the destination points must be the centroids of the same squares in
  // our page coordinate system (MARGIN + MARKER/2 from each edge) — not the
  // bare page corners (0,0)/(pageW,pageH). Using the page corners here was
  // a bug: it shifted/scaled every warp by a constant offset equal to the
  // marker's half-size, throwing off all bubble positions consistently.
  const half = MARKER / 2;
  const dst = [
    { x: MARGIN + half, y: MARGIN + half },
    { x: pageW - MARGIN - half, y: MARGIN + half },
    { x: MARGIN + half, y: pageH - MARGIN - half },
    { x: pageW - MARGIN - half, y: pageH - MARGIN - half },
  ];
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
  const layout = buildLayout(opts.numQuestions, opts.numChoices, opts.idDigits, pageW, pageH, layoutStyle);
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
      const isKey = g.key === ci;
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

    ctx.font = 'bold 12px "Prompt", sans-serif';
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
  buildLayout,
  drawFiducials,
  choiceLetters,
  drawSheet,
  toGray,
  findFiducials,
  otsuThreshold,
  otsuThresholdRegion,
  findBlobCandidates,
  computeHomography,
  solveLinear,
  warpImage,
  readBubbles,
  drawGradedOverlay,
};
