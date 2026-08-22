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
import { getBankQuestionImageUrl } from '../lib/bank-db';
import { getAttemptLockStatus, saveAttemptLocation } from '../lib/exam-db';
import { detectInAppBrowser } from '../lib/in-app-browser';
import { getConfigValue } from '../lib/config-db';
import { formatThaiDateTime, escapeHtml } from '../lib/format';
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

const DRAFT_KEY_PREFIX = 'exam-draft-';

// /take runs on shared school devices used by many different students across
// many different รอบสอบ over time. clearDraft only ever fires for the one
// attempt a student actually finishes, so a device that's ever had a student
// close the tab mid-exam, get force-submitted, or simply never come back
// accumulates an exam-draft-<attemptId> entry per abandoned attempt forever
// — eventually large enough on a well-used device to trip localStorage's
// quota, which saveDraft's try/catch swallows silently, breaking refresh-
// resume for whichever student hits it next. Sweep every OTHER student's
// leftover draft out on each successful login, keeping only the one for the
// attempt just started/resumed.
function pruneStaleDrafts(keepAttemptId) {
  try {
    const keepKey = draftKey(keepAttemptId);
    const stale = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(DRAFT_KEY_PREFIX) && key !== keepKey) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // best-effort — leftover drafts are a quota risk, not a correctness one
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

// Same idea as formatCountdown but for the "รอเข้าสอบ" wait, which can run
// well past an hour (unlike the in-exam timer) — adds an hours segment
// when needed instead of just letting minutes run past 59.
function formatWaitCountdown(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A live wait is only useful for a plausible "arrived early" gap — beyond
// this, just tell the student the start time and let them come back later
// instead of implying a tab left open for days will do anything useful.
const EARLY_WAIT_THRESHOLD_SECONDS = 30 * 60;

function CheckCircleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function AlertIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    </svg>
  );
}

function MapPinIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
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

// The school/system logo when the admin has uploaded one (Settings →
// ชื่อระบบ คำอธิบาย และโลโก้), falling back to the same clock badge as
// before when there isn't one. The uploaded logo is typically its own
// already-designed badge with a transparent background, so it's shown
// plain (no gradient/shadow box behind it, which would otherwise show
// through the transparent parts) — only the clock-icon fallback gets the
// colored badge treatment.
function LogoBadge({ logoUrl, animate }) {
  if (logoUrl) {
    return <img src={logoUrl} alt="" className={'h-14 w-14 object-contain mb-3' + (animate ? ' animate-pulse' : '')} />;
  }
  return (
    <div className={'h-14 w-14 rounded-2xl bg-gradient-to-br from-indigo-600 to-blue-400 flex items-center justify-center shadow-lg shadow-indigo-200 mb-3' + (animate ? ' animate-pulse' : '')}>
      <ClockIcon className="h-7 w-7 text-white" />
    </div>
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
  const [inAppBrowser] = useState(() => detectInAppBrowser());
  const [linkCopied, setLinkCopied] = useState(false);
  const [savedSession] = useState(() => (typeof window !== 'undefined' ? loadSession() : null));
  const [phase, setPhase] = useState(savedSession ? 'resuming' : 'login'); // 'login' | 'resuming' | 'locating' | 'exam' | 'submitted' | 'result'
  const [pin, setPin] = useState(savedSession?.pin || '');
  const [studentCode, setStudentCode] = useState(savedSession?.studentCode || '');
  const [loggingIn, setLoggingIn] = useState(false);
  const [logoUrl, setLogoUrl] = useState('');

  // exam_app_logo — the same school/system logo an admin uploads in
  // Settings and this app reuses everywhere else (printed exam papers,
  // the logged-in dashboard). Students never get a Supabase session, so
  // this read only works because config has a narrow anon-read policy
  // scoped to just this one key (see migration
  // add_anon_read_exam_app_logo_config) — every other config key (API
  // keys, etc.) stays blocked for anon.
  useEffect(() => {
    (async () => {
      try {
        setLogoUrl(await getConfigValue(supabase, 'exam_app_logo'));
      } catch {
        // best-effort — falls back to the default clock icon
      }
    })();
  }, []);

  const [attempt, setAttempt] = useState(null); // { attempt_id, exam_set_title, student_name, deadline, questions, violation_count, max_violations, locked }
  const [result, setResult] = useState(null); // { exam_set_title, student_name, submitted_at, total_correct, total_questions, score } — once the teacher reveals results
  const [answers, setAnswers] = useState({}); // { [question_id]: selectedIndex|null }
  const [now, setNow] = useState(Date.now());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittedRef = useRef(false);
  // The visibilitychange listener below (and the handleViolation/
  // handleSubmit chain it calls) is attached once per exam session — its
  // closure over `answers` is frozen from whenever that effect last ran,
  // NOT the latest render. Without this ref, a violation-triggered auto-
  // submit would silently send that stale (often empty) answers snapshot
  // instead of what the student actually picked — scoring them 0 despite
  // correct answers. handleSubmit reads answersRef.current instead of the
  // closed-over `answers` so it's always current no matter which stale
  // closure ends up calling it.
  const answersRef = useRef({});
  useEffect(() => { answersRef.current = answers; }, [answers]);
  const autoSubmitTriggeredRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [imageUrls, setImageUrls] = useState({});
  const fetchedImagePaths = useRef(new Set());

  // Resolve signed URLs for any question that carries an illustration
  // image, once each — the anon-scoped storage policy that allows this
  // (bank-question-images, see the migration) only holds while this exact
  // รอบสอบ is open, which is exactly the window this component is mounted
  // for, so there's never a case where the fetch should be denied here.
  useEffect(() => {
    const paths = (attempt?.questions || [])
      .filter(q => q.image_path && !fetchedImagePaths.current.has(q.image_path))
      .map(q => q.image_path);
    if (paths.length === 0) return;
    paths.forEach(p => fetchedImagePaths.current.add(p));
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(paths.map(async p => {
        try { return [p, await getBankQuestionImageUrl(supabase, p, 6 * 60 * 60)]; } catch { return null; }
      }));
      if (cancelled) return;
      setImageUrls(prev => {
        const next = { ...prev };
        for (const e of entries) if (e && !next[e[0]]) next[e[0]] = e[1];
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [attempt?.questions]);

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
        selected_index: answersRef.current[q.id] ?? null,
      }));
      const { data, error } = await supabase.rpc('submit_exam_attempt', {
        p_attempt_id: attempt.attempt_id,
        p_answers: payload,
      });
      if (error) throw error;
      clearDraft(attempt.attempt_id);
      clearSession();
      // The round's auto_reveal_results setting makes submit_exam_attempt
      // return the score directly (manual submit or the auto-submit above
      // on timeout, both go through here) — go straight to the result
      // screen instead of "รอครูประกาศผล" when that's present.
      if (data?.score !== undefined && data?.score !== null) {
        setResult(data);
        setPhase('result');
      } else {
        setPhase('submitted');
      }
    } catch (err) {
      submittedRef.current = false;
      const code = err?.message?.trim();
      if (code === 'time_expired' || code === 'attempt_locked') {
        // Permanent — retrying this exact call will never succeed. Stop
        // the auto-submit effects from trying again (autoSubmitTriggeredRef
        // stays true) and tell the student plainly instead of silently
        // failing forever or spamming the generic retry error below.
        Swal.fire({
          icon: 'error', title: 'ส่งข้อสอบไม่สำเร็จ',
          text: code === 'attempt_locked'
            ? 'หน้าจอถูกล็อกอยู่ กรุณาแจ้งครูคุมสอบเพื่อขอรหัสปลดล็อกก่อนส่งข้อสอบ'
            : 'หมดเวลาทำข้อสอบแล้ว กรุณาติดต่อครูผู้สอน',
          confirmButtonText: 'ตกลง', confirmButtonColor: '#4f46e5',
        });
        return;
      }
      // Anything else (network blip, transient server error) — clear the
      // auto-submit guard so the timeout/violation effects that call this
      // get to try again on their next tick, instead of leaving the
      // student stuck on a frozen exam screen forever after one failed
      // attempt.
      autoSubmitTriggeredRef.current = false;
      if (!auto) Swal.fire({ icon: 'error', title: 'ส่งข้อสอบไม่สำเร็จ', text: 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }

  // A brief, visibly-ticking warning before every auto-submit (timeout or
  // exceeded violations) — explains why the system is about to submit
  // instead of just doing it with no warning, which otherwise reads as the
  // app malfunctioning to a student who's still mid-answer.
  async function showAutoSubmitCountdown(reasonHtml, seconds) {
    let timerInterval;
    Swal.close();
    await Swal.fire({
      icon: 'warning',
      title: 'ระบบจะส่งข้อสอบให้อัตโนมัติ',
      html: `${reasonHtml}<br>กำลังส่งข้อสอบในอีก <b></b> วินาที`,
      timer: seconds * 1000,
      timerProgressBar: true,
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      didOpen: () => {
        const b = Swal.getHtmlContainer()?.querySelector('b');
        timerInterval = setInterval(() => {
          const left = Swal.getTimerLeft();
          if (b && left != null) b.textContent = String(Math.ceil(left / 1000));
        }, 100);
      },
      willClose: () => clearInterval(timerInterval),
    });
  }

  useEffect(() => {
    if (phase === 'exam' && secondsLeft <= 0 && !submittedRef.current && !autoSubmitTriggeredRef.current) {
      autoSubmitTriggeredRef.current = true;
      (async () => {
        await showAutoSubmitCountdown('หมดเวลาทำข้อสอบแล้ว', 5);
        handleSubmit(true);
      })();
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
        autoSubmitTriggeredRef.current = true;
        await showAutoSubmitCountdown(
          `ออกจากหน้าจอทำข้อสอบเกินจำนวนที่กำหนด (${data.violation_count}/${data.max_violations} ครั้ง)`,
          5
        );
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

  // Polls the attempt's locked status for the whole exam, not just while
  // already locked — a lock can now arrive two ways from the live monitor
  // (a different browser): the proctoring teacher unlocking a violation
  // lock as before, or the teacher newly locking this attempt themselves
  // (proctorLockAttempt in exam-db.js — e.g. acting on a proximity-check
  // flag they've judged genuinely suspicious). Polls slowly (25s) while
  // unlocked, since a remote lock is rare, and quickly (4s) once actually
  // locked, so the "หน้าจอถูกล็อก" prompt closes promptly the moment a
  // teacher unlocks — matches the low-connection-cost reasoning from the
  // unlock-only version this replaces (still no persistent Realtime
  // channel, just a REST poll). Swal.close() resolves showLockModal's
  // pending await like any other dismissal, so the same "set locked: false
  // locally" step there runs unchanged; if no lock modal happens to be
  // open when this fires, Swal.close() is just a harmless no-op.
  useEffect(() => {
    if (phase !== 'exam' || !attempt?.attempt_id) return;
    const interval = setInterval(async () => {
      try {
        const nowLocked = await getAttemptLockStatus(supabase, attempt.attempt_id);
        if (nowLocked && !attempt.locked) {
          setAttempt(prev => (prev ? { ...prev, locked: true } : prev));
          showLockModal(attempt.attempt_id, attempt.violation_count, attempt.max_violations);
        } else if (!nowLocked && attempt.locked) {
          Swal.close();
        }
      } catch {
        // best-effort — a failed poll just retries on the next tick
      }
    }, attempt.locked ? 4000 : 25000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, attempt?.attempt_id, attempt?.locked]);

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

  // Per-รอบสอบ, teacher-toggled (ExamScheduleTool's "บังคับแชร์ตำแหน่งก่อนเข้าสอบ")
  // proximity-check requirement: when the round demands it, phase gates on
  // 'locating' until the location is captured and saved — see login()
  // below deciding that transition from start_exam_attempt's returned
  // require_location/has_location, and the phase === 'locating' screen
  // near the end of this component. Deliberately a hard requirement (no
  // silent skip) per how this round was configured; requestLocation is
  // re-triggerable so a student who denied by accident, or whose GPS
  // fix failed, isn't permanently stuck without at least a retry path.
  const [locatingError, setLocatingError] = useState(null);
  const [locatingBusy, setLocatingBusy] = useState(false);

  function requestLocation() {
    if (!attempt?.attempt_id) return;
    setLocatingError(null);
    setLocatingBusy(true);
    if (!navigator.geolocation) {
      setLocatingBusy(false);
      setLocatingError('อุปกรณ์หรือเบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง — ลองเปลี่ยนเบราว์เซอร์หรืออุปกรณ์');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await saveAttemptLocation(supabase, attempt.attempt_id, pos.coords.latitude, pos.coords.longitude);
          setPhase('exam');
        } catch (err) {
          setLocatingError(err.message || 'บันทึกตำแหน่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
        } finally {
          setLocatingBusy(false);
        }
      },
      (err) => {
        setLocatingBusy(false);
        setLocatingError(
          err.code === 1
            ? 'คุณปฏิเสธการแชร์ตำแหน่ง — เปิดสิทธิ์ตำแหน่งให้เว็บนี้ในการตั้งค่าเบราว์เซอร์ (ไอคอนแม่กุญแจข้างที่อยู่เว็บ) แล้วกดลองใหม่'
            : 'ระบุตำแหน่งไม่สำเร็จ — ตรวจสอบว่าเปิด GPS/บริการตำแหน่งของอุปกรณ์แล้ว แล้วลองใหม่'
        );
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 0 }
    );
  }

  useEffect(() => {
    if (phase === 'locating') requestLocation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Shown once per manual login (not the silent refresh-resume path — see
  // handleLogin vs. the resume useEffect below) so a student can't miss
  // it, but also isn't interrupted by it every time their browser
  // reloads mid-exam. Gated behind an explicit checkbox rather than just
  // a dismiss button, per "ให้นักเรียนได้อ่านกดรับทราบก่อน" — a plain
  // OK button doesn't prove they read anything.
  async function showExamRulesNotice(maxViolations) {
    await Swal.fire({
      title: 'ข้อควรทราบก่อนเริ่มสอบ',
      html: `
        <div style="text-align:left;font-size:0.875rem;line-height:1.6">
          <p>• ระบบตรวจจับการออกจากหน้าจอทำข้อสอบ (สลับแท็บ/แอปอื่น ย่อหน้าจอ จอดับ หรือล็อกหน้าจอ) ทุกครั้งจะถูกบันทึกเป็น <b>การทำผิดกฎ 1 ครั้ง</b></p>
          <p>• อนุญาตให้ทำผิดได้สูงสุด <b>${maxViolations} ครั้ง</b> — เกินกว่านี้ระบบจะ<b>ส่งข้อสอบให้อัตโนมัติทันที</b> แม้ยังไม่หมดเวลา</p>
          <p>• ทุกครั้งที่ทำผิดกฎ หน้าจอจะถูกล็อก ต้องรอ<b>ครูคุมสอบกรอกรหัสปลดล็อก</b>ให้ก่อนจึงทำต่อได้</p>
          <p>⚠️ <b>กรุณาปิดการล็อกหน้าจออัตโนมัติ (Auto-Lock)</b> หรือตั้งเวลาจอดับให้นานกว่าเวลาสอบ — จอดับ/ล็อกเองก็ถูกนับเป็นการทำผิดกฎเช่นกัน</p>
          <p>• ควรเชื่อมต่ออินเทอร์เน็ตให้เสถียรตลอดการสอบ</p>
          <p>• หน้าจอมีลายน้ำระบุชื่อและเวลาของคุณกำกับอยู่ เพื่อป้องกันการแคปหน้าจอไปเผยแพร่</p>
          <p>• ปิดแอป/รีเฟรชหน้าได้โดยคำตอบที่ทำไว้จะไม่หาย แต่<b>เวลาสอบยังเดินต่อตามปกติ</b> ไม่หยุดรอ</p>
        </div>
      `,
      icon: 'warning',
      input: 'checkbox',
      inputValue: 0,
      inputPlaceholder: 'ฉันอ่านและเข้าใจกฎการสอบข้างต้นแล้ว',
      confirmButtonText: 'รับทราบ เริ่มทำข้อสอบ',
      confirmButtonColor: '#4f46e5',
      allowOutsideClick: false,
      allowEscapeKey: false,
      showCancelButton: false,
      width: 480,
      inputValidator: (result) => (result ? undefined : 'กรุณาติ๊กยืนยันว่าอ่านและเข้าใจแล้ว'),
    });
  }

  // "ยังไม่ถึงเวลาสอบ" — the PIN is real but opens_at hasn't arrived yet.
  // Within EARLY_WAIT_THRESHOLD_SECONDS this shows a live countdown and
  // (per "นับเวลาถอยหลังเข้าระบบสอบ") retries the same login automatically
  // the moment it reaches zero; beyond that it's just informational, since
  // nobody realistically leaves a tab open for hours waiting.
  //
  // Deliberately does NOT rely on SweetAlert2's own `timer` option (or any
  // bare setInterval/setTimeout) to decide when to retry — a phone's
  // screen locking, or the browser backgrounding the tab, freely suspends
  // JS timers for an indefinite stretch, so a student who locked their
  // phone right through the exam's opens_at came back to a frozen
  // countdown that never auto-retried and had to type the PIN again.
  // Every check here instead compares real wall-clock time (Date.now())
  // against the fixed target opensAtMs, and a visibilitychange/focus
  // listener re-runs that check the instant the tab becomes visible again
  // — visibility events fire reliably even after a timer-suspending
  // background stretch, unlike the timers themselves.
  async function showTooEarlyDialog(data, pinVal, studentCodeVal) {
    const opensAtMs = new Date(data.opens_at).getTime();
    const opensAtText = formatThaiDateTime(data.opens_at, { dateStyle: 'long', timeStyle: 'short' });
    const secondsUntilOpen = Math.floor((opensAtMs - Date.now()) / 1000);
    // exam_set_title is a teacher-entered ชุดข้อสอบ title, not fixed text —
    // escaped before going into Swal's html: (raw markup, not JSX) so a
    // title containing e.g. <img onerror=...> can't run as script in every
    // student's browser that happens to hit this dialog.
    const setTitle = escapeHtml(data.exam_set_title);

    if (secondsUntilOpen > EARLY_WAIT_THRESHOLD_SECONDS) {
      await Swal.fire({
        icon: 'info',
        title: 'ยังไม่ถึงเวลาสอบ',
        html: `การสอบ &quot;${setTitle}&quot; จะเริ่มเวลา <b>${opensAtText}</b><br>กรุณากลับมาเข้าสอบใหม่เมื่อถึงเวลา`,
        confirmButtonText: 'ตกลง',
        confirmButtonColor: '#4f46e5',
      });
      return;
    }

    let retried = false;
    let tickInterval;
    function retry() {
      if (retried) return;
      retried = true;
      clearInterval(tickInterval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      Swal.close();
      login(pinVal, studentCodeVal, { showRulesNotice: true });
    }
    function onVisible() {
      if (!document.hidden && Date.now() >= opensAtMs) retry();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    await Swal.fire({
      icon: 'info',
      title: 'ยังไม่ถึงเวลาสอบ',
      html: `การสอบ &quot;${setTitle}&quot; จะเริ่มเวลา <b>${opensAtText}</b><br>เหลือเวลาอีก <b class="wait-countdown"></b> — ระบบจะพาเข้าสอบให้อัตโนมัติเมื่อถึงเวลา`,
      confirmButtonText: 'ปิด',
      confirmButtonColor: '#4f46e5',
      allowOutsideClick: false,
      allowEscapeKey: false,
      didOpen: () => {
        const b = Swal.getHtmlContainer()?.querySelector('.wait-countdown');
        const tick = () => {
          const remaining = Math.max(0, Math.ceil((opensAtMs - Date.now()) / 1000));
          if (b) b.textContent = formatWaitCountdown(remaining);
          if (remaining <= 0) retry();
        };
        tick();
        tickInterval = setInterval(tick, 500);
      },
      willClose: () => {
        clearInterval(tickInterval);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
      },
    });
  }

  // "เข้าสอบสายเกินเวลา" — the PIN is real but closes_at has already passed.
  async function showTooLateDialog(data) {
    const opensAtText = formatThaiDateTime(data.opens_at, { dateStyle: 'long', timeStyle: 'short' });
    const closesAtText = formatThaiDateTime(data.closes_at, { dateStyle: 'long', timeStyle: 'short' });
    const setTitle = escapeHtml(data.exam_set_title);
    await Swal.fire({
      icon: 'error',
      title: 'เข้าสอบสายเกินเวลาที่กำหนด',
      html: `การสอบ &quot;${setTitle}&quot; กำหนดให้เข้าสอบในช่วง <b>${opensAtText} – ${closesAtText}</b><br>ขณะนี้เลยเวลาที่กำหนดแล้ว กรุณาติดต่อครูผู้สอน`,
      confirmButtonText: 'ตกลง',
      confirmButtonColor: '#4f46e5',
    });
  }

  async function login(pinVal, studentCodeVal, opts = {}) {
    setLoggingIn(true);
    try {
      const { data, error } = await supabase.rpc('start_exam_attempt', {
        p_pin: pinVal.trim(),
        p_student_code: studentCodeVal.trim(),
      });
      if (error) throw error;
      submittedRef.current = false;
      if (data.blocked === 'too_early') {
        setPhase('login');
        showTooEarlyDialog(data, pinVal.trim(), studentCodeVal.trim());
        return;
      }
      if (data.blocked === 'too_late') {
        clearSession();
        setPhase('login');
        showTooLateDialog(data);
        return;
      }
      if (data.submitted) {
        // The attempt was already submitted and the teacher has since
        // revealed results (see the migration) — same PIN + code doubles
        // as "check my result" once that's true, instead of the usual
        // already_submitted error.
        clearSession();
        setResult(data);
        setPhase('result');
        return;
      }
      if (opts.showRulesNotice) {
        await showExamRulesNotice(data.max_violations);
      }
      saveSession(pinVal.trim(), studentCodeVal.trim());
      pruneStaleDrafts(data.attempt_id);
      setAttempt(data);
      setAnswers(loadDraft(data.attempt_id));
      setNow(Date.now());
      setPhase(data.require_location && !data.has_location ? 'locating' : 'exam');
    } catch (err) {
      const code = err?.message?.trim();
      clearSession();
      setPhase('login');
      Swal.fire({
        icon: 'error',
        title: 'เข้าสอบไม่สำเร็จ',
        text: ERROR_MESSAGES[code] || 'กรุณาตรวจสอบ PIN และเลขประจำตัวนักเรียน',
        confirmButtonText: 'ตกลง',
        confirmButtonColor: '#4f46e5',
      });
    } finally {
      setLoggingIn(false);
    }
  }

  // A refresh restarts the component with savedSession already loaded (see
  // useState above), so this runs once on mount to resume transparently
  // instead of making the student retype the PIN/code they already gave.
  // Skipped entirely inside a detected in-app browser — see the blocking
  // screen below; no point starting/resuming an attempt there.
  useEffect(() => {
    if (savedSession && !inAppBrowser) login(savedSession.pin, savedSession.studentCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyPageLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2500);
    } catch {
      // best-effort — clipboard permission can be denied inside some
      // in-app browsers, which is exactly the situation this is for
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    // Fullscreen requires an un-lapsed user gesture, so it must be
    // requested synchronously right here — before the first await below —
    // or the browser silently ignores it. Best-effort: a refusal (declined
    // permission, unsupported browser like iPhone Safari) just leaves the
    // student in normal view, same as if they never had the toggle button.
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    await login(pin, studentCode, { showRulesNotice: true });
  }

  function handleLogout() {
    clearSession();
    setAttempt(null);
    setPin('');
    setStudentCode('');
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

  // Hard block, no bypass — see in-app-browser.js for why. Checked before
  // every other phase (including 'resuming') so a saved session inside an
  // in-app browser never even attempts to resume; the student must switch
  // to a real browser and re-enter the PIN + student code there.
  if (inAppBrowser) {
    return (
      <div className="min-h-dvh bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className={card + ' w-full max-w-sm text-center'}>
          <div className="h-14 w-14 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center mx-auto mb-4">
            <AlertIcon className="h-8 w-8" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">กรุณาเปิดในเว็บเบราว์เซอร์</h1>
          <p className="mt-2 text-sm text-gray-600">
            ตรวจพบว่าเปิดหน้านี้ผ่านแอป {inAppBrowser} ซึ่งอาจทำให้ระบบทำข้อสอบทำงานผิดพลาด (เช่น บันทึกการเข้าสอบไม่ได้ หรือครูปลดล็อกหน้าจอให้ไม่ได้) กรุณาเปิดลิงก์นี้ในเว็บเบราว์เซอร์ปกติ เช่น Chrome หรือ Safari ก่อนทำข้อสอบ
          </p>
          <p className="mt-3 text-xs text-gray-500">
            แตะปุ่มเมนู (⋮ หรือจุดสามจุด) ที่มุมบนของหน้าจอ แล้วเลือก &quot;เปิดในเบราว์เซอร์&quot; (Open in Browser) — หรือคัดลอกลิงก์ด้านล่างไปวางในเบราว์เซอร์เอง
          </p>
          <button type="button" className={btn + ' mt-4'} onClick={copyPageLink}>
            {linkCopied ? 'คัดลอกลิงก์แล้ว' : 'คัดลอกลิงก์หน้านี้'}
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'resuming') {
    return (
      <div className="min-h-dvh bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className="flex flex-col items-center text-center">
          <LogoBadge logoUrl={logoUrl} animate />
          <p className="text-sm text-gray-500">กำลังเข้าสอบต่อ...</p>
        </div>
      </div>
    );
  }

  if (phase === 'locating') {
    return (
      <div className="min-h-dvh bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className={card + ' w-full max-w-sm text-center'}>
          <div className="h-14 w-14 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center mx-auto mb-4">
            <MapPinIcon className="h-8 w-8" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">รอบสอบนี้ต้องแชร์ตำแหน่งก่อนเข้าสอบ</h1>
          <p className="mt-2 text-sm text-gray-500">
            กรุณากดอนุญาตเมื่อเบราว์เซอร์ขอสิทธิ์เข้าถึงตำแหน่ง — ใช้เพื่อตรวจสอบเบื้องต้นเท่านั้น เข้าสอบไม่ได้จนกว่าจะแชร์ตำแหน่งสำเร็จ
            {attempt?.proximity_min_distance_m != null && (
              <> — <strong className="text-gray-700">นักเรียนที่นั่งอยู่ใกล้กันน้อยกว่า {attempt.proximity_min_distance_m} เมตร อาจถูกครูตรวจสอบ</strong></>
            )}
          </p>
          {locatingError && (
            <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-left">{locatingError}</div>
          )}
          <button type="button" className={btn + ' mt-4'} disabled={locatingBusy} onClick={requestLocation}>
            {locatingBusy ? 'กำลังขอตำแหน่ง...' : 'ลองอีกครั้ง'}
          </button>
          <button type="button" onClick={handleLogout} className="mt-3 text-[11px] text-gray-400 hover:text-gray-600 underline">
            ออกจากระบบ
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'login') {
    return (
      <div className="min-h-dvh bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center text-center mb-6">
            <LogoBadge logoUrl={logoUrl} />
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
      <div className="min-h-dvh bg-gray-50 flex items-center justify-center px-4 py-10">
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

  if (phase === 'result') {
    return (
      <div className="min-h-dvh bg-gray-50 flex items-center justify-center px-4 py-10">
        <div className={card + ' w-full max-w-sm text-center'}>
          <div className="h-14 w-14 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center mx-auto mb-4">
            <CheckCircleIcon className="h-8 w-8" />
          </div>
          <h1 className="text-lg font-bold text-gray-900">{result.exam_set_title}</h1>
          <p className="mt-1 text-sm text-gray-500">{result.student_name}</p>
          <div className="mt-4 text-4xl font-bold text-indigo-700">{result.score}%</div>
          <p className="mt-1 text-sm text-gray-500">ตอบถูก {result.total_correct} จาก {result.total_questions} ข้อ</p>
          <p className="mt-3 text-xs text-gray-400">ส่งเมื่อ {formatThaiDateTime(result.submitted_at, { dateStyle: 'medium', timeStyle: 'short' })}</p>
        </div>
      </div>
    );
  }

  // phase === 'exam'
  const fullscreenSupported = typeof document !== 'undefined' && (document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const watermarkTime = formatThaiDateTime(now, { dateStyle: 'short', timeStyle: 'short' });

  return (
    <div className="min-h-dvh bg-gray-50 pb-24 relative">
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
            {q.image_path && imageUrls[q.image_path] && (
              <img
                src={imageUrls[q.image_path]}
                alt=""
                className="max-w-full max-h-80 rounded-lg border border-gray-200 mb-3 select-none"
                draggable={false}
              />
            )}
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
