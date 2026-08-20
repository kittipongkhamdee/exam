'use client';
// StudentExamTool.jsx — the public, no-login exam-taking screen for /take.
// Students never get a Supabase account; access is PIN (per รอบสอบ) +
// เลขประจำตัวนักเรียน only, and every read/write goes through the
// start_exam_attempt / submit_exam_attempt Postgres RPCs (callable by the
// anon key, no session needed) — see the migration's own comment for why:
// those functions are the only place the answer key ever gets touched, so
// the browser never receives correct_choice/explanation, and a submit
// never returns a score (results stay hidden until the teacher's own
// report screen reveals them later).

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import ConfirmDialog from './ConfirmDialog';

const ERROR_MESSAGES = {
  invalid_pin_or_closed: 'รหัส PIN ไม่ถูกต้อง หรือยังไม่ถึง/เลยเวลาเข้าสอบแล้ว',
  invalid_student_code: 'ไม่พบเลขประจำตัวนักเรียนนี้ในห้องเรียนของข้อสอบชุดนี้ กรุณาตรวจสอบอีกครั้ง',
  already_submitted: 'คุณได้ส่งข้อสอบชุดนี้ไปแล้ว',
  time_expired: 'หมดเวลาทำข้อสอบแล้ว',
  exam_set_empty: 'ชุดข้อสอบนี้ยังไม่มีข้อสอบ กรุณาติดต่อครูผู้สอน',
};

function draftKey(attemptId) {
  return `exam-draft-${attemptId}`;
}

function loadDraft(attemptId) {
  try {
    const raw = window.localStorage.getItem(draftKey(attemptId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveDraft(attemptId, answers) {
  try {
    window.localStorage.setItem(draftKey(attemptId), JSON.stringify(answers));
  } catch {
    // best-effort — losing the local draft just means no refresh-resume
  }
}

function clearDraft(attemptId) {
  try {
    window.localStorage.removeItem(draftKey(attemptId));
  } catch {
    // best-effort
  }
}

function formatCountdown(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function CheckCircleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function ClockIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export default function StudentExamTool() {
  const [phase, setPhase] = useState('login'); // 'login' | 'exam' | 'submitted'
  const [pin, setPin] = useState('');
  const [studentCode, setStudentCode] = useState('');
  const [loginError, setLoginError] = useState(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [attempt, setAttempt] = useState(null); // { attempt_id, exam_set_title, student_name, deadline, questions }
  const [answers, setAnswers] = useState({}); // { [question_id]: selectedIndex|null }
  const [now, setNow] = useState(Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);

  useEffect(() => {
    if (phase !== 'exam') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const secondsLeft = attempt ? Math.floor((new Date(attempt.deadline).getTime() - now) / 1000) : 0;

  const answeredCount = useMemo(
    () => (attempt ? attempt.questions.filter(q => answers[q.id] !== undefined && answers[q.id] !== null).length : 0),
    [attempt, answers]
  );

  async function handleSubmit(auto) {
    if (!attempt || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      const payload = attempt.questions.map(q => ({
        question_id: q.id,
        selected_index: answers[q.id] ?? null,
      }));
      const { error } = await supabase.rpc('submit_exam_attempt', {
        p_attempt_id: attempt.attempt_id,
        p_answers: payload,
      });
      if (error) throw error;
      clearDraft(attempt.attempt_id);
      setPhase('submitted');
    } catch {
      // Even on an error the attempt is best treated as done — grading is
      // idempotent server-side, so re-entering the PIN/code would just
      // resume (if still within the window) or correctly report
      // already_submitted if the write actually went through.
      submittedRef.current = false;
      if (!auto) alert('ส่งข้อสอบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }

  useEffect(() => {
    if (phase === 'exam' && secondsLeft <= 0 && !submittedRef.current) {
      handleSubmit(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, secondsLeft]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      const { data, error } = await supabase.rpc('start_exam_attempt', {
        p_pin: pin.trim(),
        p_student_code: studentCode.trim(),
      });
      if (error) throw error;
      submittedRef.current = false;
      setAttempt(data);
      setAnswers(loadDraft(data.attempt_id));
      setNow(Date.now());
      setPhase('exam');
    } catch (err) {
      const code = err?.message?.trim();
      setLoginError(ERROR_MESSAGES[code] || 'เข้าสอบไม่สำเร็จ กรุณาตรวจสอบ PIN และเลขประจำตัวนักเรียน');
    } finally {
      setLoggingIn(false);
    }
  }

  function selectAnswer(questionId, idx) {
    setAnswers(prev => {
      const next = { ...prev, [questionId]: idx };
      if (attempt) saveDraft(attempt.attempt_id, next);
      return next;
    });
  }

  const card = 'bg-white border border-gray-200 rounded-xl p-5';
  const inputCls = 'px-3 py-2.5 border border-gray-300 rounded-lg text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
  const label = 'text-xs font-semibold text-gray-500 block mb-1';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-3 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed w-full';

  if (phase === 'login') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-400 flex items-center justify-center shadow-lg shadow-indigo-200 mb-3">
              <ClockIcon className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-xl font-bold text-gray-900">เข้าสอบออนไลน์</h1>
            <p className="mt-1 text-sm text-gray-500">กรอกรหัส PIN และเลขประจำตัวนักเรียนที่ครูแจ้ง</p>
          </div>
          <form onSubmit={handleLogin} className={card + ' space-y-3'}>
            <div>
              <label className={label}>รหัส PIN</label>
              <input
                type="text" inputMode="numeric" required autoFocus
                className={inputCls + ' font-mono tracking-widest text-center text-lg'}
                value={pin} onChange={e => setPin(e.target.value)}
                placeholder="000000"
              />
            </div>
            <div>
              <label className={label}>เลขประจำตัวนักเรียน</label>
              <input
                type="text" inputMode="numeric" required
                className={inputCls}
                value={studentCode} onChange={e => setStudentCode(e.target.value)}
                placeholder="เลขประจำตัวนักเรียน"
              />
            </div>
            {loginError && <div className="text-sm text-red-600">{loginError}</div>}
            <button type="submit" className={btn} disabled={loggingIn}>
              {loggingIn ? 'กำลังตรวจสอบ...' : 'เข้าสอบ'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (phase === 'submitted') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className={card + ' w-full max-w-sm text-center'}>
          <div className="h-14 w-14 rounded-full bg-green-50 text-green-600 flex items-center justify-center mx-auto mb-4">
            <CheckCircleIcon className="h-8 w-8" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">ส่งข้อสอบเรียบร้อยแล้ว</h1>
          <p className="mt-2 text-sm text-gray-500">รอให้ครูผู้สอนประกาศผลคะแนน</p>
        </div>
      </div>
    );
  }

  // phase === 'exam'
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-bold text-gray-900 truncate">{attempt.student_name}</span>
            <span className="text-gray-300">·</span>
            <span className="font-semibold text-gray-700 truncate">{attempt.exam_set_title}</span>
          </div>
          <div className="text-xs text-gray-500">ตอบแล้ว {answeredCount}/{attempt.questions.length} ข้อ</div>
        </div>
        <div className={'flex items-center gap-1.5 font-mono font-bold text-lg shrink-0 ' + (secondsLeft <= 60 ? 'text-red-600' : 'text-gray-900')}>
          <ClockIcon className="h-5 w-5" /> {formatCountdown(secondsLeft)}
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-5 space-y-4">
        {attempt.questions.map((q, i) => (
          <div key={q.id} className={card}>
            <div className="text-xs font-semibold text-gray-400 mb-1">ข้อ {i + 1}</div>
            <div className="text-sm font-medium text-gray-900 mb-3">{q.question_text}</div>
            <div className="space-y-2">
              {q.choices.map((c, ci) => (
                <label
                  key={ci}
                  className={
                    'flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm cursor-pointer transition ' +
                    (answers[q.id] === ci ? 'border-indigo-500 bg-indigo-50 text-indigo-900' : 'border-gray-200 hover:bg-gray-50 text-gray-700')
                  }
                >
                  <input
                    type="radio" name={`q-${q.id}`} className="shrink-0"
                    checked={answers[q.id] === ci}
                    onChange={() => selectAnswer(q.id, ci)}
                  />
                  {c}
                </label>
              ))}
            </div>
          </div>
        ))}

        <button type="button" className={btn} onClick={() => setConfirmOpen(true)} disabled={submitting}>
          ส่งข้อสอบ
        </button>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="ยืนยันส่งข้อสอบ"
        message={`ตอบแล้ว ${answeredCount}/${attempt.questions.length} ข้อ\n\nเมื่อส่งแล้วจะแก้ไขคำตอบไม่ได้อีก`}
        confirmLabel="ส่งข้อสอบ"
        loading={submitting}
        onConfirm={() => handleSubmit(false)}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
