'use client';
// OMRReportTool.jsx
//
// Read-only report for a prepared quiz: pick a quiz that's had at least one
// sheet scanned (OMRScanTool, at /omr/scan), then see the class roster's
// scores plus a couple of aggregate stats (average/highest/lowest,
// hardest-hit questions). Re-derives per-question correctness from the raw
// `responses` each scan already stored, against the quiz's answer key — the
// same comparison OMRScanTool itself does at scan time (see runScan there),
// since a scan result only stores the student's raw choice per question,
// not a precomputed correct/incorrect flag.

import { useState, useEffect, useCallback } from 'react';
import { choiceLetters } from '../lib/omr-core';
import { supabase } from '../lib/supabaseClient';
import { getQuizWithAnswerKey, listMyQuizzes, listScanResultsForQuiz } from '../lib/omr-db';

const card = 'bg-white border border-gray-200 rounded-xl p-4 sm:p-5 mb-4';
const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed';
const chip = 'px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors';
const chipActive = 'bg-indigo-600 border-indigo-600 text-white';
const chipInactive = 'bg-white border-gray-300 text-gray-600 hover:border-indigo-300';

function scoreColor(pct) {
  if (pct >= 80) return 'text-green-600';
  if (pct >= 50) return 'text-amber-600';
  return 'text-red-600';
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export default function OMRReportTool() {
  const [quizzes, setQuizzes] = useState([]);
  const [loadingQuizzes, setLoadingQuizzes] = useState(true);
  const [quizFilter, setQuizFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState(''); // '' = every grade level
  const [quizLoadError, setQuizLoadError] = useState(null);

  const [selectedQuiz, setSelectedQuiz] = useState(null); // full quiz + answerKey + subject name
  const [results, setResults] = useState([]);
  const [loadingResults, setLoadingResults] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setQuizzes(await listMyQuizzes(supabase));
      } catch (err) {
        setQuizLoadError(err.message || 'โหลดรายการชุดข้อสอบไม่สำเร็จ');
      } finally {
        setLoadingQuizzes(false);
      }
    })();
  }, []);

  // Deep-link support (e.g. the dashboard's "recent activity" links straight
  // into a quiz's report): once the quiz list is in, auto-select whichever
  // one ?quizId= names. A plain URLSearchParams read instead of
  // next/navigation's useSearchParams — this page has no server-rendered
  // search-param usage to keep in sync with, so it avoids that hook's
  // Suspense-boundary requirement for no benefit here.
  useEffect(() => {
    if (typeof window === 'undefined' || selectedQuiz || quizzes.length === 0) return;
    const quizId = new URLSearchParams(window.location.search).get('quizId');
    const row = quizId && quizzes.find(q => q.id === quizId);
    if (row) handleSelectQuiz(row);
  }, [quizzes]);

  const loadResults = useCallback(async (quizId) => {
    setLoadingResults(true);
    try {
      setResults(await listScanResultsForQuiz(supabase, quizId) || []);
    } catch {
      setResults([]);
    } finally {
      setLoadingResults(false);
    }
  }, []);

  async function handleSelectQuiz(row) {
    setQuizLoadError(null);
    try {
      const quiz = await getQuizWithAnswerKey(supabase, row.id);
      setSelectedQuiz({ ...quiz, subjectName: row.subjects?.subject_name, gradeLevel: row.subjects?.grade_level, room: row.subjects?.room });
      loadResults(quiz.id);
    } catch (err) {
      setQuizLoadError(err.message || 'โหลดชุดข้อสอบไม่สำเร็จ');
    }
  }

  function handleBack() {
    setSelectedQuiz(null);
    setResults([]);
  }

  const gradeLevels = [...new Set(quizzes.map(q => q.subjects?.grade_level).filter(Boolean))];
  const filteredQuizzes = quizzes.filter(q => {
    if (gradeFilter && q.subjects?.grade_level !== gradeFilter) return false;
    if (!quizFilter.trim()) return true;
    const hay = `${q.title} ${q.subjects?.subject_name || ''} ${q.subjects?.subject_code || ''}`.toLowerCase();
    return hay.includes(quizFilter.trim().toLowerCase());
  });

  // --- Screen 1: pick a quiz ---
  if (!selectedQuiz) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">รายงานคะแนน</h1>
        <div className="text-sm text-gray-500 mb-4">เลือกชุดข้อสอบเพื่อดูคะแนนและสถิติของนักเรียนที่สแกนแล้ว</div>

        <input
          type="text" placeholder="ค้นหาชุดข้อสอบ / วิชา..." value={quizFilter}
          onChange={e => setQuizFilter(e.target.value)}
          className="w-full px-3 py-3 border border-gray-300 rounded-lg text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        />

        {gradeLevels.length > 1 && (
          <div className="flex gap-1.5 flex-wrap mb-4">
            <button
              type="button" onClick={() => setGradeFilter('')}
              className={chip + ' ' + (gradeFilter === '' ? chipActive : chipInactive)}
            >
              ทั้งหมด
            </button>
            {gradeLevels.map(g => (
              <button
                key={g} type="button" onClick={() => setGradeFilter(g)}
                className={chip + ' ' + (gradeFilter === g ? chipActive : chipInactive)}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        {loadingQuizzes && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {quizLoadError && <div className="text-sm text-red-600 mb-3">{quizLoadError}</div>}
        {!loadingQuizzes && filteredQuizzes.length === 0 && (
          <div className="text-sm text-gray-500">
            ยังไม่มีชุดข้อสอบที่เตรียมไว้ — ไปที่หน้า <a href="/omr/prepare" className="text-indigo-600 font-semibold">เตรียมข้อสอบ</a> ก่อน
          </div>
        )}
        <div className="space-y-2">
          {filteredQuizzes.map((q, i) => (
            <button
              key={q.id}
              onClick={() => handleSelectQuiz(q)}
              className="w-full flex items-center gap-3 text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-indigo-300 hover:shadow-sm transition"
            >
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shrink-0">
                <ReportIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-900 truncate">{i + 1}. {q.title}</div>
                <div className="text-sm text-gray-500 mt-0.5 truncate">
                  {q.subjects?.subject_name} (ชั้น {q.subjects?.grade_level}/{q.subjects?.room}) · {q.num_questions} ข้อ
                </div>
              </div>
              <ChevronRightIcon className="h-4 w-4 text-gray-300 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // --- Screen 2: report for the selected quiz ---
  const scores = results.map(r => Number(r.score) || 0);
  const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0;
  const max = scores.length ? Math.max(...scores) : 0;
  const min = scores.length ? Math.min(...scores) : 0;

  const letters = choiceLetters(selectedQuiz.choiceScheme, selectedQuiz.numChoices);
  const questionStats = Array.from({ length: selectedQuiz.numQuestions }, (_, qIndex) => {
    const key = selectedQuiz.answerKey[qIndex];
    const keyChoices = key?.choices || [];
    let correct = 0, answered = 0;
    for (const r of results) {
      const resp = (r.responses || []).find(x => x.question === qIndex);
      if (!resp || resp.blank) continue;
      answered++;
      if (keyChoices.includes(resp.choice)) correct++;
    }
    return {
      qIndex,
      pct: results.length ? Math.round((correct / results.length) * 100) : 0,
      correct, answered,
      keyLabel: keyChoices.map(c => letters[c] || '?').join('/'),
    };
  });
  const hardestQuestions = [...questionStats].filter(q => results.length > 0).sort((a, b) => a.pct - b.pct).slice(0, 5);
  const sortedResults = [...results].sort((a, b) => (b.score || 0) - (a.score || 0));

  function handleExportCsv() {
    const rows = [
      ['รหัส', 'ชื่อ-สกุล', 'ถูก', `จาก ${selectedQuiz.numQuestions} ข้อ`, 'คะแนน (%)', 'วันที่สแกน'],
      ...sortedResults.map(r => [
        r.students?.student_code || '',
        `${r.students?.prefix || ''}${r.students?.student_name || ''}`,
        r.total_correct,
        selectedQuiz.numQuestions,
        r.score,
        new Date(r.scanned_at).toLocaleString('th-TH'),
      ]),
    ];
    const csv = '﻿' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `รายงานคะแนน-${selectedQuiz.title}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-5xl">
      <button type="button" onClick={handleBack} className="text-sm font-semibold text-indigo-600 mb-3 inline-flex items-center gap-1">
        <ChevronLeftIcon className="h-4 w-4" /> กลับไปเลือกชุดข้อสอบ
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shrink-0">
            <ReportIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 truncate">{selectedQuiz.title}</h1>
            <div className="text-sm text-gray-500 mt-0.5 truncate">
              {selectedQuiz.subjectName} (ชั้น {selectedQuiz.gradeLevel}/{selectedQuiz.room}) · {selectedQuiz.numQuestions} ข้อ
            </div>
          </div>
        </div>
        <button type="button" onClick={handleExportCsv} disabled={results.length === 0} className={btnSecondary + ' inline-flex items-center gap-2'}>
          <DownloadIcon className="h-4 w-4" /> ดาวน์โหลด CSV
        </button>
      </div>

      {loadingResults && <div className="text-sm text-gray-500 mb-4">กำลังโหลด...</div>}

      {!loadingResults && results.length === 0 && (
        <div className={card}>
          <div className="text-sm text-gray-500">ยังไม่มีนักเรียนสแกนชุดข้อสอบนี้</div>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            <StatCard icon={UsersIcon} iconBg="bg-gradient-to-br from-indigo-600 to-blue-500" value={results.length} unit="คน" label="สแกนแล้ว" />
            <StatCard icon={PercentIcon} iconBg="bg-gradient-to-br from-amber-500 to-orange-500" value={avg} unit="%" label="คะแนนเฉลี่ย" valueClass={scoreColor(avg)} />
            <StatCard icon={TrendingUpIcon} iconBg="bg-gradient-to-br from-emerald-600 to-teal-500" value={max} unit="%" label="สูงสุด" valueClass="text-green-600" />
            <StatCard icon={TrendingDownIcon} iconBg="bg-gradient-to-br from-red-500 to-rose-500" value={min} unit="%" label="ต่ำสุด" valueClass="text-red-600" />
          </div>

          {hardestQuestions.length > 0 && (
            <div className={card}>
              <div className="text-sm font-bold mb-3 flex items-center gap-1.5">
                <TargetIcon className="h-4 w-4 text-gray-400" /> ข้อที่นักเรียนพลาดบ่อยที่สุด
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {hardestQuestions.map(q => (
                  <div key={q.qIndex} className="rounded-lg bg-gray-50 px-3 py-2">
                    <div className="text-xs text-gray-500">ข้อ {q.qIndex + 1} · เฉลย {q.keyLabel}</div>
                    <div className={"text-sm font-bold " + scoreColor(q.pct)}>ถูก {q.pct}% ({q.correct}/{results.length})</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={card + ' p-0 overflow-hidden'}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                    <th className="px-4 py-2.5 font-semibold whitespace-nowrap">รหัส</th>
                    <th className="px-4 py-2.5 font-semibold whitespace-nowrap">ชื่อ-สกุล</th>
                    <th className="px-4 py-2.5 font-semibold text-right">ถูก</th>
                    <th className="px-4 py-2.5 font-semibold text-right">คะแนน</th>
                    <th className="px-4 py-2.5 font-semibold whitespace-nowrap">วันที่สแกน</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedResults.map(r => (
                    <tr key={r.id} className="border-b border-gray-100 last:border-b-0">
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{r.students?.student_code}</td>
                      <td className="px-4 py-2.5 font-medium text-gray-900 whitespace-nowrap">{r.students?.prefix}{r.students?.student_name}</td>
                      <td className="px-4 py-2.5 text-right text-gray-500">{r.total_correct}/{selectedQuiz.numQuestions}</td>
                      <td className={"px-4 py-2.5 text-right font-bold " + scoreColor(r.score)}>{r.score}%</td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{new Date(r.scanned_at).toLocaleString('th-TH')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, iconBg, value, unit, label, valueClass }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-2">
        <div className={"h-9 w-9 rounded-lg flex items-center justify-center shrink-0 text-white " + iconBg}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="text-xs text-gray-500 truncate">{label}</div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={"text-2xl font-extrabold " + (valueClass || 'text-gray-900')}>{value}</span>
        <span className="text-xs text-gray-400">{unit}</span>
      </div>
    </div>
  );
}

function ReportIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 20V10M12 20V4M20 20v-7" />
    </svg>
  );
}

function ChevronRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ChevronLeftIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m15 6-6 6 6 6" />
    </svg>
  );
}

function DownloadIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 4v12M7 11l5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

function UsersIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M2 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
      <circle cx="17" cy="8" r="2.5" />
      <path d="M16 14.2c2.7.5 5 2.4 5 5.8" />
    </svg>
  );
}

function PercentIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <line x1="19" y1="5" x2="5" y2="19" />
      <circle cx="6.5" cy="6.5" r="2.5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
    </svg>
  );
}

function TrendingUpIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </svg>
  );
}

function TrendingDownIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m3 7 6 6 4-4 8 8" />
      <path d="M15 17h6v-6" />
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
