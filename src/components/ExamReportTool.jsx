'use client';
// ExamReportTool.jsx — "รายงาน" (สอบออนไลน์): pick a รอบสอบ and see who's
// taken it — full roster (not just students who logged in, so a student
// who never started shows up as "ยังไม่ได้เข้าสอบ" instead of silently
// missing), submission status, score, and screen-switch violation count.
// Results stay hidden from students by default (per the teacher's own
// scoping) — the "เปิดเผยผลให้นักเรียนดู" toggle here is what flips
// online_exam_rounds.results_visible, which start_exam_attempt checks the
// next time that student re-enters their PIN + code.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { listMyExamRounds, listAllExamRoundsWithTeacher, getRoundReport, setRoundResultsVisible, getItemAnalysisForRound } from '../lib/exam-db';
import ItemAnalysisTable from './ItemAnalysisTable';
import { exportItemAnalysisExcel, exportItemAnalysisPdf } from '../lib/item-analysis-export';

function ReportIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 20V10M12 20V4M20 20v-7" />
    </svg>
  );
}

function EyeIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.7 17.7 0 0 1-3.1 4M6.3 6.3C3.6 8 2 12 2 12s3.5 7 10 7a10 10 0 0 0 3.9-.8" />
      <path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

function TargetIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  );
}

function DownloadIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v12m0 0-4-4m4 4 4-4" />
      <path d="M4 19h16" />
    </svg>
  );
}

function formatThai(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

const STATUS_LABEL = {
  submitted: { label: 'ส่งแล้ว', cls: 'bg-green-50 text-green-700' },
  in_progress: { label: 'กำลังทำ', cls: 'bg-amber-50 text-amber-700' },
  not_started: { label: 'ยังไม่ได้เข้าสอบ', cls: 'bg-gray-100 text-gray-500' },
};

export default function ExamReportTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1.5';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';

  const { isAdmin } = useAuth();
  const [viewAllTeachers, setViewAllTeachers] = useState(false);

  const [rounds, setRounds] = useState([]);
  const [roundId, setRoundId] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [togglingVisible, setTogglingVisible] = useState(false);
  const [error, setError] = useState(null);
  const [itemAnalysis, setItemAnalysis] = useState(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setRounds(viewAllTeachers ? await listAllExamRoundsWithTeacher(supabase) : await listMyExamRounds(supabase));
      } catch {
        // best-effort
      }
      setRoundId('');
    })();
  }, [viewAllTeachers]);

  const refreshReport = useCallback(async (id) => {
    if (!id) {
      setReport(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setReport(await getRoundReport(supabase, id));
    } catch (err) {
      setError(err.message || 'โหลดรายงานไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshReport(roundId); }, [roundId, refreshReport]);

  const refreshItemAnalysis = useCallback(async (id) => {
    if (!id) {
      setItemAnalysis(null);
      return;
    }
    setLoadingAnalysis(true);
    try {
      setItemAnalysis(await getItemAnalysisForRound(supabase, id));
    } catch {
      setItemAnalysis(null);
    } finally {
      setLoadingAnalysis(false);
    }
  }, []);

  useEffect(() => { refreshItemAnalysis(roundId); }, [roundId, refreshItemAnalysis]);

  async function handleToggleVisible() {
    if (!report) return;
    setTogglingVisible(true);
    try {
      await setRoundResultsVisible(supabase, report.id, !report.results_visible);
      await refreshReport(report.id);
    } finally {
      setTogglingVisible(false);
    }
  }

  function analysisExportArgs() {
    return {
      fileTitle: `วิเคราะห์คุณภาพข้อสอบ-${report.exam_set_title}`,
      title: report.exam_set_title,
      subjectLine: `${report.subject_name} (ชั้น ${report.grade_level}/${report.room})`,
      analysis: itemAnalysis,
      rowLabels: (itemAnalysis?.questionTexts || []).map((text, i) => `ข้อ ${i + 1}${text ? ' — ' + text : ''}`),
    };
  }

  function handleExportAnalysisExcel() {
    exportItemAnalysisExcel(analysisExportArgs());
  }

  function handleExportAnalysisPdf() {
    exportItemAnalysisPdf(analysisExportArgs());
  }

  const submittedRows = report ? report.rows.filter(r => r.status === 'submitted') : [];
  const avgScore = submittedRows.length > 0
    ? (submittedRows.reduce((sum, r) => sum + Number(r.score || 0), 0) / submittedRows.length).toFixed(1)
    : null;

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-fuchsia-600 to-purple-500 text-white flex items-center justify-center shrink-0">
          <ReportIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">รายงาน</h1>
          <p className="text-sm text-gray-500">ผลสอบออนไลน์ของนักเรียนแต่ละรอบสอบ</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        {isAdmin && (
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-3 cursor-pointer select-none">
            <input type="checkbox" checked={viewAllTeachers} onChange={e => setViewAllTeachers(e.target.checked)} />
            ดูรายงานของครูทุกคน (ไม่ใช่แค่ของฉัน)
          </label>
        )}
        <div className={field}>
          <label className={label}>เลือกรอบสอบ</label>
          {rounds.length === 0 ? (
            <div className="text-sm text-gray-500 mt-1">ยังไม่มีรอบสอบ — ไปตั้งที่ &quot;จัดสอบ&quot; ก่อน</div>
          ) : (
            <select className={inputCls} value={roundId} onChange={e => setRoundId(e.target.value)}>
              <option value="">— เลือกรอบสอบ —</option>
              {rounds.map(r => (
                <option key={r.id} value={r.id}>
                  {r.online_exam_sets?.title} — {r.online_exam_sets?.subjects?.subject_name} (ชั้น {r.online_exam_sets?.subjects?.grade_level}/{r.online_exam_sets?.subjects?.room}) · {formatThai(r.opens_at)}
                  {viewAllTeachers && ` · ครู ${r.teacherName || '(ไม่ระบุชื่อ)'}`}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {loading && <div className={card}><div className="text-sm text-gray-500">กำลังโหลด...</div></div>}
      {error && <div className={card}><div className="text-sm text-red-600">{error}</div></div>}

      {report && !loading && (
        <>
          <div className={card}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-gray-900">{report.exam_set_title}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {report.subject_name} (ชั้น {report.grade_level}/{report.room}) · {formatThai(report.opens_at)} – {formatThai(report.closes_at)}
                </div>
              </div>
              <button type="button" className={btn} onClick={handleToggleVisible} disabled={togglingVisible}>
                {report.results_visible ? <EyeIcon className="h-4 w-4" /> : <EyeOffIcon className="h-4 w-4" />}
                {togglingVisible ? 'กำลังบันทึก...' : (report.results_visible ? 'ผลเปิดเผยอยู่ (กดเพื่อซ่อน)' : 'เปิดเผยผลให้นักเรียนดู')}
              </button>
            </div>
            {report.auto_reveal_results && (
              <div className="mt-2 text-xs text-emerald-700 bg-emerald-50 rounded-md px-2.5 py-1.5 inline-block">
                รอบสอบนี้ตั้งเป็น &ldquo;เผยผลอัตโนมัติ&rdquo; ไว้แล้ว — นักเรียนแต่ละคนเห็นคะแนนของตัวเองทันทีที่ส่งข้อสอบ ไม่ต้องกดปุ่มด้านบน (ปรับได้ที่หน้าจัดสอบ)
              </div>
            )}

            <div className="flex flex-wrap gap-4 mt-4 text-sm">
              <div><span className="font-bold text-gray-900">{report.rows.length}</span> <span className="text-gray-500">ทั้งหมด</span></div>
              <div><span className="font-bold text-green-700">{submittedRows.length}</span> <span className="text-gray-500">ส่งแล้ว</span></div>
              <div><span className="font-bold text-amber-700">{report.rows.filter(r => r.status === 'in_progress').length}</span> <span className="text-gray-500">กำลังทำ</span></div>
              <div><span className="font-bold text-gray-500">{report.rows.filter(r => r.status === 'not_started').length}</span> <span className="text-gray-500">ยังไม่ได้เข้าสอบ</span></div>
              {avgScore !== null && <div><span className="font-bold text-indigo-700">{avgScore}%</span> <span className="text-gray-500">คะแนนเฉลี่ย</span></div>}
            </div>
          </div>

          <div className={card}>
            <div className="overflow-x-auto -mx-5 px-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                    <th className="pb-2 pr-3 font-semibold">เลขประจำตัว</th>
                    <th className="pb-2 pr-3 font-semibold">ชื่อ-สกุล</th>
                    <th className="pb-2 pr-3 font-semibold">สถานะ</th>
                    <th className="pb-2 pr-3 font-semibold">ส่งเมื่อ</th>
                    <th className="pb-2 pr-3 font-semibold">คะแนน</th>
                    <th className="pb-2 font-semibold">สลับหน้าจอ</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map(r => {
                    const status = STATUS_LABEL[r.status];
                    return (
                      <tr key={r.student_id} className="border-b border-gray-50 last:border-b-0">
                        <td className="py-2 pr-3 font-mono text-gray-700">{r.student_code}</td>
                        <td className="py-2 pr-3 text-gray-900">{r.student_name}</td>
                        <td className="py-2 pr-3"><span className={pill + ' ' + status.cls}>{status.label}</span></td>
                        <td className="py-2 pr-3 text-gray-500 text-xs">{formatThai(r.submitted_at)}</td>
                        <td className="py-2 pr-3 text-gray-900">
                          {r.status === 'submitted' ? `${r.total_correct}/${r.total_questions} (${r.score}%)` : '—'}
                        </td>
                        <td className="py-2">
                          {r.violation_count > 0 ? <span className={pill + ' bg-red-50 text-red-600'}>{r.violation_count} ครั้ง</span> : <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className={card}>
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div className="text-sm font-bold flex items-center gap-1.5">
                <TargetIcon className="h-4 w-4 text-gray-400" /> ผลการวิเคราะห์คุณภาพข้อสอบ
              </div>
              {!loadingAnalysis && itemAnalysis && itemAnalysis.n >= 2 && (
                <div className="flex items-center gap-2">
                  <button type="button" className={btnTiny} onClick={handleExportAnalysisExcel}>
                    <DownloadIcon className="h-3.5 w-3.5" /> Excel
                  </button>
                  <button type="button" className={btnTiny} onClick={handleExportAnalysisPdf}>
                    <DownloadIcon className="h-3.5 w-3.5" /> PDF
                  </button>
                </div>
              )}
            </div>
            {loadingAnalysis && <div className="text-sm text-gray-500">กำลังวิเคราะห์...</div>}
            {!loadingAnalysis && (
              <ItemAnalysisTable
                analysis={itemAnalysis}
                rowLabels={(itemAnalysis?.questionTexts || []).map((text, i) => (
                  <div key={i}>
                    <div>ข้อ {i + 1}</div>
                    {text && <div className="text-xs text-gray-400 truncate max-w-xs">{text}</div>}
                  </div>
                ))}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
