'use client';
// ItemAnalysisTable.jsx — shared "ผลการวิเคราะห์คุณภาพข้อสอบ" table for
// both รายงานคะแนน (OMR) and รายงาน (online exam): renders whatever
// analyzeItems() (item-analysis.js) computed for a test — per-item ค่า
// ความยาก (p) and อำนาจจำแนก (point-biserial r), each with a verdict pill,
// plus the whole test's KR-20 reliability. The two report pages differ
// only in how they label rows (a bare question number for OMR, since an
// omr_quizzes row has no question text of its own; question text preview
// for the online exam, since its questions come from the bank) — passed
// in as `rowLabels` rather than duplicating this table twice.

function fmt2(v) {
  return v === null ? '—' : v.toFixed(2);
}

function fmt4(v) {
  return v === null ? '—' : v.toFixed(4);
}

function VerdictPill({ verdict }) {
  if (verdict === null) return <span className="text-gray-300">—</span>;
  const cls = verdict === 'ใช้ได้' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600';
  return <span className={'inline-block px-2 py-0.5 rounded-full text-xs font-bold ' + cls}>{verdict}</span>;
}

/**
 * @param {{ analysis: { items: Array<{p:number|null, r:number|null, pVerdict:string|null, rVerdict:string|null, verdict:string|null}>, kr20: number|null, n: number }, rowLabels: (string|import('react').ReactNode)[] }} props
 */
export default function ItemAnalysisTable({ analysis, rowLabels }) {
  if (!analysis || analysis.n < 2) {
    return (
      <div className="text-sm text-gray-500">
        ต้องมีนักเรียนที่สอบ/สแกนแล้วอย่างน้อย 2 คน จึงจะวิเคราะห์คุณภาพข้อสอบได้
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto -mx-5 px-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
              <th className="pb-2 pr-3 font-semibold">ข้อที่</th>
              <th className="pb-2 pr-3 font-semibold text-right">ความยาก (p)</th>
              <th className="pb-2 pr-3 font-semibold">แปลผล</th>
              <th className="pb-2 pr-3 font-semibold text-right">อำนาจจำแนก (r)</th>
              <th className="pb-2 pr-3 font-semibold">แปลผล</th>
              <th className="pb-2 font-semibold">สรุป</th>
            </tr>
          </thead>
          <tbody>
            {analysis.items.map((it, i) => (
              <tr key={i} className="border-b border-gray-50 last:border-b-0 align-top">
                <td className="py-2 pr-3 text-gray-900">{rowLabels[i]}</td>
                <td className="py-2 pr-3 text-right font-mono text-gray-700">{fmt2(it.p)}</td>
                <td className="py-2 pr-3"><VerdictPill verdict={it.pVerdict} /></td>
                <td className="py-2 pr-3 text-right font-mono text-gray-700">{fmt4(it.r)}</td>
                <td className="py-2 pr-3"><VerdictPill verdict={it.rVerdict} /></td>
                <td className="py-2"><VerdictPill verdict={it.verdict} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap gap-4 mt-4 text-sm">
        <div><span className="text-gray-500">จำนวนที่นำมาวิเคราะห์: </span><span className="font-bold text-gray-900">{analysis.n} คน</span></div>
        <div><span className="text-gray-500">KR-20 Reliability: </span><span className="font-bold text-gray-900">{fmt4(analysis.kr20)}</span></div>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        เกณฑ์: ความยาก (p) 0.20–0.80 = ใช้ได้ · อำนาจจำแนก (r) ≥ 0.20 = ใช้ได้ · ข้อที่ใช้ได้ทั้งสองค่าจึงสรุปว่า &quot;ใช้ได้&quot; นอกนั้นแนะนำปรับปรุงหรือตัดทิ้ง
      </p>
    </div>
  );
}
