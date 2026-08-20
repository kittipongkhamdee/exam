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
//
// Anti-cheat: leaving the exam tab/app (document visibilitychange) records
// a violation server-side (record_exam_violation) and locks the screen
// until the proctoring teacher enters the round's own unlock PIN
// (unlock_exam_attempt) — a separate code from the join PIN, never shown
// to students. Exceeding the admin-configured max force-submits
// immediately. Both the violation count and the locked state live on
// online_exam_attempts, not just in this component's state, specifically
// so a refresh can't be used to dodge a lock or reset the count.

import { useEffect, useMemo, useRef, useState } from 'react';
import Swal from 'sweetalert2';
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

// exam-session holds just the PIN + student code the student last logged in
// with (never the exam content or answers) — a refresh re-runs
// start_exam_attempt with these automatically instead of dropping the
// student back to a blank login form, since that RPC already resumes an
// existing unsubmitted/unexpired attempt with its original shuffle intact.
const SESSION_KEY = 'exam-session';

function loadSession() {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(pin, studentCode) {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({ pin, studentCode }));
  } catch {
    // best-effort — losing this just means no refresh-resume
  }
}

function clearSession() {
  try {
    window.localStorage.removeItem(SESSION_KEY);
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

function ExpandIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
    </svg>
  );
}

function CollapseIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 3v3a2 2 0 0 1-2 2H4M15 3v3a2 2 0 0 0 2 2h3M9 21v-3a2 2 0 0 0-2-2H4M15 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

function escapeSvgText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A faint, tiled, unselectable watermark identifying who's looking at this
// screen and when — doesn't stop a screenshot (no web page can), but makes
// one traceable back to a student if it's ever shared, which is the
// realistic deterrent available here.
function watermarkBackground(line1, line2) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="180">` +
    `<text x="10" y="80" transform="rotate(-24 140 90)" font-size="13" font-family="sans-serif" fill="#000" fill-opacity="0.07">${escapeSvgText(line1)}</text>` +
    `<text x="10" y="100" transform="rotate(-24 140 90)" font-size="13" font-family="sans-serif" fill="#000" fill-opacity="0.07">${escapeSvgText(line2)}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export default function StudentExamTool() {
  const [savedSession] = useState(() => (typeof window !== 'undefined' ? loadSession() : null));
  const [phase, setPhase] = useState(savedSession ? 'resuming' : 'login'); // 'login' | 'resuming' | 'exam' | 'submitted'
  const [pin, setPin] = useState(savedSession?.pin || '');
  const [studentCode, setStudentCode] = useState(savedSession?.studentCode || '');
  const [loginError, setLoginError] = useState(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [attempt, setAttempt] = useState(null); // { attempt_id, exam_set_title, student_name, deadline, questions, violation_count, max_violations, locked }
  const [answers, setAnswers] = useState({}); // { [question_id]: selectedIndex|null }
  const [now, setNow] = useState(Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // The Fullscreen API is a display preference the student toggles
  // themselves, not an anti-cheat signal — leaving it doesn't count as a
  // violation, since that would punish someone for simply preferring a
  // non-fullscreen view. iOS Safari doesn't support requestFullscreen() on
  // ordinary pages at all (only iPad, and only in some versions), so the
  // button below only renders where document.fullscreenEnabled says it'll
  // actually work.
  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    };
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch {
      // best-effort — some browsers refuse without a direct user-gesture
      // chain; nothing useful to show the student for this
    }
  }

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
    // Defensively dismiss the lock prompt (or the exceeded-violation
    // alert) if either is still open — e.g. the exam timer hitting zero
    // while the student is mid-lock-prompt — so it never lingers on top of
    // the submitted screen after this navigates away from phase 'exam'.
    Swal.close();
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
      clearSession();
      setPhase('submitted');
    } catch {
      // Even on an error the attempt is best treated as done — grading is
      // idempotent server-side, so re-entering the PIN/code would just
      // resume (if still within the window) or correctly report
      // already_submitted if the write actually went through.
      submittedRef.current = false;
      if (!auto) Swal.fire({ icon: 'error', title: 'ส่งข้อสอบไม่สำเร็จ', text: 'กรุณาลองใหม่อีกครั้ง' });
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

  const handlingViolationRef = useRef(false);

  // A non-dismissible prompt (no cancel, backdrop click ignored, Esc
  // ignored) for the round's unlock PIN — stays open, re-showing an inline
  // error, until unlock_exam_attempt actually succeeds.
  async function showLockModal(attemptId, violationCount, maxViolations) {
    await Swal.fire({
      title: 'หน้าจอถูกล็อก',
      html: `ตรวจพบว่าออกจากหน้าจอทำข้อสอบ (ครั้งที่ ${violationCount} จาก ${maxViolations} ครั้งที่อนุญาต)<br>กรุณาแจ้งครูคุมสอบเพื่อขอรหัสปลดล็อก`,
      input: 'text',
      inputAttributes: { autocapitalize: 'off', autocomplete: 'off' },
      inputPlaceholder: 'รหัสปลดล็อกจากครูคุมสอบ',
      confirmButtonText: 'ปลดล็อก',
      confirmButtonColor: '#4f46e5',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showCancelButton: false,
      showLoaderOnConfirm: true,
      preConfirm: async (code) => {
        try {
          const { error } = await supabase.rpc('unlock_exam_attempt', {
            p_attempt_id: attemptId,
            p_unlock_pin: (code || '').trim(),
          });
          if (error) throw error;
        } catch {
          Swal.showValidationMessage('รหัสปลดล็อกไม่ถูกต้อง');
          return false;
        }
      },
    });
    setAttempt(prev => (prev ? { ...prev, locked: false } : prev));
  }

  async function handleViolation() {
    if (!attempt || handlingViolationRef.current || submittedRef.current) return;
    handlingViolationRef.current = true;
    try {
      const { data, error } = await supabase.rpc('record_exam_violation', { p_attempt_id: attempt.attempt_id });
      if (error) throw error;
      if (data.submitted) return;
      setAttempt(prev => (prev ? { ...prev, violation_count: data.violation_count } : prev));
      if (data.exceeded) {
        await Swal.fire({
          icon: 'error',
          title: 'ออกจากหน้าจอเกินจำนวนที่กำหนด',
          text: 'ระบบจะส่งข้อสอบให้อัตโนมัติ',
          timer: 3000,
          showConfirmButton: false,
          allowOutsideClick: false,
        });
        await handleSubmit(true);
      } else {
        setAttempt(prev => (prev ? { ...prev, locked: true } : prev));
        await showLockModal(attempt.attempt_id, data.violation_count, data.max_violations);
      }
    } catch {
      // best-effort — a failed violation write just means this one instance
      // goes uncounted, not worth blocking the student over
    } finally {
      handlingViolationRef.current = false;
    }
  }

  useEffect(() => {
    if (phase !== 'exam') return;
    function onVisibilityChange() {
      if (document.hidden) handleViolation();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, attempt?.attempt_id]);

  // Locking survives a refresh (see the migration) — start_exam_attempt
  // returns locked:true on resume if a prior violation was never cleared,
  // so re-show the same prompt immediately rather than letting the student
  // back into the exam.
  useEffect(() => {
    if (phase === 'exam' && attempt?.locked) {
      showLockModal(attempt.attempt_id, attempt.violation_count, attempt.max_violations);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function login(pinVal, studentCodeVal) {
    setLoginError(null);
    setLoggingIn(true);
    try {
      const { data, error } = await supabase.rpc('start_exam_attempt', {
        p_pin: pinVal.trim(),
        p_student_code: studentCodeVal.trim(),
      });
      if (error) throw error;
      submittedRef.current = false;
      saveSession(pinVal.trim(), studentCodeVal.trim());
      setAttempt(data);
      setAnswers(loadDraft(data.attempt_id));
      setNow(Date.now());
      setPhase('exam');
    } catch (err) {
      const code = err?.message?.trim();
      setLoginError(ERROR_MESSAGES[code] || 'เข้าสอบไม่สำเร็จ กรุณาตรวจสอบ PIN และเลขประจำตัวนักเรียน');
      clearSession();
      setPhase('login');
    } finally {
      setLoggingIn(false);
    }
  }

  // A refresh restarts the component with savedSession already loaded (see
  // useState above), so this runs once on mount to resume transparently
  // instead of making the student retype the PIN/code they already gave.
  useEffect(() => {
    if (savedSession) login(savedSession.pin, savedSession.studentCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    await login(pin, studentCode);
  }

  function handleLogout() {
    clearSession();
    setAttempt(null);
    setPin('');
    setStudentCode('');
    setLoginError(null);
    setPhase('login');
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

  if (phase === 'resuming') {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className="flex flex-col items-center text-center">
          <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-400 flex items-center justify-center shadow-lg shadow-indigo-200 mb-3 animate-pulse">
            <ClockIcon className="h-7 w-7 text-white" />
          </div>
          <p className="text-sm text-gray-500">กำลังเข้าสอบต่อ...</p>
        </div>
      </div>
    );
  }

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
  const fullscreenSupported = typeof document !== 'undefined' && (document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const watermarkTime = new Date(now).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="min-h-screen bg-gray-50 pb-24 relative">
      <div
        className="fixed inset-0 z-40 pointer-events-none select-none"
        style={{ backgroundImage: watermarkBackground(`${attempt.student_name} · ${studentCode}`, watermarkTime), backgroundRepeat: 'repeat' }}
        aria-hidden="true"
      />

      {fullscreenSupported && (
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'ออกจากโหมดเต็มจอ' : 'เข้าสู่โหมดเต็มจอ'}
          className="fixed bottom-5 right-5 z-50 h-11 w-11 rounded-full bg-gray-900/80 text-white flex items-center justify-center shadow-lg hover:bg-gray-900"
        >
          {isFullscreen ? <CollapseIcon className="h-5 w-5" /> : <ExpandIcon className="h-5 w-5" />}
        </button>
      )}

      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-gray-700 truncate">{attempt.exam_set_title}</div>
          <div className="text-xs text-gray-500">ตอบแล้ว {answeredCount}/{attempt.questions.length} ข้อ</div>
        </div>
        <div className="min-w-0 max-w-full text-center">
          <div className="font-bold text-gray-900 truncate">{attempt.student_name}</div>
          <button type="button" onClick={handleLogout} className="text-[11px] text-gray-400 hover:text-gray-600 underline">
            ไม่ใช่ฉัน? ออกจากระบบ
          </button>
        </div>
        <div className={'flex items-center gap-1.5 font-mono font-bold text-lg shrink-0 justify-self-end ' + (secondsLeft <= 60 ? 'text-red-600' : 'text-gray-900')}>
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
