// item-analysis.js
//
// Pure classroom item-analysis statistics — ค่าความยาก (difficulty, p),
// อำนาจจำแนก (discrimination, point-biserial correlation r), and KR-20
// reliability — computed from a matrix of per-student per-item
// correct/incorrect (1/0) scores. No React or Supabase dependency:
// omr-db.js and exam-db.js each build the 0/1 matrix from their own
// schema's shape (scanned bubble responses vs. online_exam_answers) and
// hand it to analyzeItems here, so both report pages show the exact same
// numbers for the exact same underlying pattern of right/wrong answers.
//
// Verdict thresholds — difficulty 0.20-0.80 = "ใช้ได้", discrimination
// r >= 0.20 = "ใช้ได้", overall "ใช้ได้" only if both hold, otherwise
// "ปรับปรุงหรือตัดทิ้ง" — match what the teacher asked for this session,
// not a fixed external standard; แปลผลอำนาจจำแนก uses "ทิ้ง" specifically
// (rather than "ปรับปรุงหรือตัดทิ้ง") to mirror the item-analysis report
// format already in use at the school.

const DIFFICULTY_MIN = 0.20;
const DIFFICULTY_MAX = 0.80;
const DISCRIMINATION_MIN = 0.20;

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr, m) {
  const avg = m ?? mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length);
}

// Point-biserial correlation between one item's 0/1 scores and each
// student's total score across the whole test — the standard
// discrimination index for a dichotomously-scored item. Undefined (null)
// when the item has no variance (everyone right or everyone wrong) or the
// total-score distribution has no spread.
function pointBiserial(itemScores, totalScores) {
  const n = itemScores.length;
  const p = mean(itemScores);
  if (p === 0 || p === 1) return null;

  const correctTotals = [];
  const incorrectTotals = [];
  for (let i = 0; i < n; i++) {
    (itemScores[i] ? correctTotals : incorrectTotals).push(totalScores[i]);
  }
  if (correctTotals.length === 0 || incorrectTotals.length === 0) return null;

  const sTotal = stddev(totalScores);
  if (sTotal === 0) return null;

  return ((mean(correctTotals) - mean(incorrectTotals)) / sTotal) * Math.sqrt(p * (1 - p));
}

/**
 * @param {number[][]} itemMatrix — itemMatrix[itemIndex][studentIndex] = 1|0
 * @returns {{
 *   items: Array<{ p: number|null, r: number|null, pVerdict: string|null, rVerdict: string|null, verdict: string|null }>,
 *   kr20: number|null,
 *   n: number,
 * }}
 */
export function analyzeItems(itemMatrix) {
  const numItems = itemMatrix.length;
  const numStudents = numItems > 0 ? itemMatrix[0].length : 0;

  const totalScores = [];
  for (let s = 0; s < numStudents; s++) {
    let total = 0;
    for (let i = 0; i < numItems; i++) total += itemMatrix[i][s];
    totalScores.push(total);
  }

  const items = itemMatrix.map(itemScores => {
    const p = numStudents > 0 ? mean(itemScores) : null;
    const r = numStudents > 1 ? pointBiserial(itemScores, totalScores) : null;
    const pVerdict = p === null ? null : (p >= DIFFICULTY_MIN && p <= DIFFICULTY_MAX ? 'ใช้ได้' : 'ปรับปรุงหรือตัดทิ้ง');
    const rVerdict = r === null ? null : (r >= DISCRIMINATION_MIN ? 'ใช้ได้' : 'ทิ้ง');
    const verdict = (pVerdict === 'ใช้ได้' && rVerdict === 'ใช้ได้') ? 'ใช้ได้' : 'ปรับปรุงหรือตัดทิ้ง';
    return { p, r, pVerdict, rVerdict, verdict };
  });

  // KR-20 = (k / (k-1)) * (1 - Σ(p·q) / σ²_total) — undefined below 2
  // items/students or when the class scored with zero total-score spread.
  let kr20 = null;
  if (numItems > 1 && numStudents > 1) {
    const sumPQ = items.reduce((s, it) => s + (it.p === null ? 0 : it.p * (1 - it.p)), 0);
    const varTotal = stddev(totalScores) ** 2;
    kr20 = varTotal > 0 ? (numItems / (numItems - 1)) * (1 - sumPQ / varTotal) : null;
  }

  return { items, kr20, n: numStudents };
}
