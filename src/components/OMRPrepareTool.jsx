'use client';
// OMRPrepareTool.jsx
//
// Desktop-oriented prep flow: pick a subject, design the answer-sheet
// layout, and set the answer key — the part of the OMR workflow a teacher
// does ahead of time, typically at a computer. Saves the quiz + answer key
// to Supabase (createQuiz) so it can be picked up later from the scan flow
// (OMRScanTool, at /omr/scan) on a phone on exam day.
//
// All OMR layout/drawing logic lives in ../lib/omr-core.js and is imported
// below — this file is UI/state only. The actual bubble-reading/scanning
// pipeline lives in OMRScanTool.jsx, not here.

import { useState, useRef, useCallback, useEffect } from 'react';
import Swal from 'sweetalert2';
import { jsPDF } from 'jspdf';
import { HALF_LANDSCAPE_PAGE_W, HALF_LANDSCAPE_PAGE_H, drawSheet, choiceLetters, buildLayout } from '../lib/omr-core';
import { supabase } from '../lib/supabaseClient';
import { createQuiz, getQuizWithAnswerKey, listQuizzesForSubject, listMyQuizzes, listScanResultsForQuiz, deleteScanResult, deleteQuiz, getScanPhotoUrl } from '../lib/omr-db';
import ConfirmDialog from './ConfirmDialog';
import { formatStudentName } from '../lib/student-name';
import { formatGradeRoom } from '../lib/format';

function groupQuizzesBySubject(quizzes) {
  const groups = new Map();
  for (const q of quizzes) {
    const key = `${q.subjects?.subject_name} (ชั้น ${formatGradeRoom(q.subjects?.grade_level, q.subjects?.room)})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }));
}

export default function OMRPrepareTool() {
  const [numQuestions, setNumQuestions] = useState(20);
  const [numChoices, setNumChoices] = useState(4);
  // Fixed at 5 digits — no longer a picker. Kept as state (not a plain
  // constant) so loading an older saved quiz that used a different digit
  // count via handleLoadQuiz still displays/prints correctly.
  const [idDigits, setIdDigits] = useState(5);
  const [scheme, setScheme] = useState('thai');
  const [title, setTitle] = useState('แบบทดสอบ');
  const [subject, setSubject] = useState('');
  // Free-form note the teacher can type, printed in the block of blank
  // space to the left of the student-ID box (word-wrapped in drawSheet).
  const [note, setNote] = useState('');
  // Paper layout: A4 turned landscape, then cut left/right into two
  // 148.5x210mm portrait-shaped halves — still taller than wide, so it sits
  // naturally in a phone's portrait camera when scanning. This is the only
  // paper format the app offers now (the earlier 'topBottom' — A4 cut
  // top/bottom — was dropped per the teacher's decision once this format's
  // scan support was wired up in OMRScanTool). paper_layout and cols are
  // both saved onto the quiz row so the scan flow can warp/read against the
  // exact format the sheet was printed with, including for older quizzes
  // created before this format existed (those keep their saved 'topBottom').
  const pageW = HALF_LANDSCAPE_PAGE_W;
  const pageH = HALF_LANDSCAPE_PAGE_H;
  const layoutStyle = 'halfLandscape';
  // Column count (e.g. 3 columns for 60 questions instead of a 2-column
  // sheet with rows running off the bottom) is picked automatically by
  // buildLayout based on how many rows actually fit the page — no manual
  // toggle to remember. Resolve it once here so the exact value used for
  // this preview gets frozen into the saved quiz row (createQuiz below),
  // rather than saving "auto" and letting a future change to the
  // auto-picking logic silently reflow an already-printed sheet.
  const cols = buildLayout(numQuestions, numChoices, idDigits, pageW, pageH, layoutStyle).cols;

  const [answerKey, setAnswerKey] = useState({});
  const [bulkPoints, setBulkPoints] = useState(1);
  const sheetCanvasRef = useRef(null);
  const [sheetReady, setSheetReady] = useState(false);

  const letters = choiceLetters(scheme, numChoices);
  const [fontReady, setFontReady] = useState(false);

  const [activeStep, setActiveStep] = useState(0);
  // The answer-key grid (step 2) only switches to a 2-column layout once
  // there's actually room for it — each row (question number + up to 5
  // choice bubbles + a points input) needs roughly 300px on its own, and at
  // narrower widths (including a phone, or a tablet with the sidebar open)
  // forcing 2 columns wrapped each row onto two lines instead, which looked
  // broken. 1280px comfortably clears even the worst case of a full-width
  // desktop sidebar (256px) plus page padding still leaving 2 columns their
  // ~300px each.
  const [isWideScreen, setIsWideScreen] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const update = () => setIsWideScreen(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // --- Supabase-backed quiz/subject state ---
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [quizId, setQuizId] = useState(null);
  // set_code mirrored from the linked ชุดข้อสอบ (null for a quiz made
  // directly here, never synced from one) — printed on the answer sheet
  // itself once loaded, same badge the question paper already carries.
  const [setCode, setSetCode] = useState(null);
  const [savingQuiz, setSavingQuiz] = useState(false);
  const [saveQuizError, setSaveQuizError] = useState(null);
  const [deletingQuiz, setDeletingQuiz] = useState(false);
  const [deleteQuizError, setDeleteQuizError] = useState(null);
  const [confirmDeleteQuizOpen, setConfirmDeleteQuizOpen] = useState(false);

  const [existingQuizzes, setExistingQuizzes] = useState([]);
  const [loadingQuiz, setLoadingQuiz] = useState(false);
  const [loadQuizError, setLoadQuizError] = useState(null);

  // Every quiz across every subject this teacher owns — lets the teacher
  // find and open/delete a quiz directly without picking its subject
  // first (the per-subject dropdown above only ever shows quizzes for
  // whatever subject happens to already be selected). Loaded once at
  // mount and refreshed after any save/delete, mirroring how
  // `existingQuizzes` already keeps itself in sync.
  const [allQuizzes, setAllQuizzes] = useState([]);
  const [allQuizzesLoading, setAllQuizzesLoading] = useState(true);
  const [expandedQuizGroups, setExpandedQuizGroups] = useState(new Set());
  const [deleteListTarget, setDeleteListTarget] = useState(null); // a row from allQuizzes, or null
  const [deletingListQuiz, setDeletingListQuiz] = useState(false);
  const [deleteListError, setDeleteListError] = useState(null);
  // Set right before switching subjectId from the all-quizzes list, so the
  // subjectId effect below (which itself resets quizId/roster/title first)
  // can load this specific quiz *after* that reset finishes, instead of
  // racing it — see the effect for how this is consumed.
  const pendingQuizLoadRef = useRef(null);

  const refreshAllQuizzes = useCallback(async () => {
    try {
      setAllQuizzes(await listMyQuizzes(supabase));
    } catch {
      // best-effort — the rest of the page still works without this list
    } finally {
      setAllQuizzesLoading(false);
    }
  }, []);

  useEffect(() => { refreshAllQuizzes(); }, [refreshAllQuizzes]);

  function toggleQuizGroup(name) {
    setExpandedQuizGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  // Opens a quiz picked from the all-subjects list: switches to its
  // subject (if not already selected) and loads it once that subject's
  // own effect has finished resetting the form.
  function openQuizFromList(quiz) {
    if (quiz.subject_id === subjectId) {
      handleLoadQuiz(quiz.id);
    } else {
      pendingQuizLoadRef.current = quiz.id;
      setSubjectId(quiz.subject_id);
    }
  }

  async function handleDeleteListQuiz() {
    if (!deleteListTarget) return;
    setDeletingListQuiz(true);
    setDeleteListError(null);
    try {
      await deleteQuiz(supabase, deleteListTarget.id);
      if (quizId === deleteListTarget.id) {
        setQuizId(null);
        setRoster([]);
        setAnswerKey({});
      }
      if (deleteListTarget.subject_id === subjectId) {
        setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      }
      await refreshAllQuizzes();
      setDeleteListTarget(null);
    } catch (err) {
      setDeleteListError(err.message || 'ลบชุดข้อสอบไม่สำเร็จ');
    } finally {
      setDeletingListQuiz(false);
    }
  }

  const [roster, setRoster] = useState([]);
  const [loadingRoster, setLoadingRoster] = useState(false);

  // Class roster (every student in the selected subject's grade/room) — used
  // to batch-generate one personalized answer sheet per student, distinct
  // from `roster` above (which is scan RESULTS for a saved quiz, not the
  // student list).
  const [classStudents, setClassStudents] = useState([]);
  const [loadingClassStudents, setLoadingClassStudents] = useState(false);
  const [generatingBatch, setGeneratingBatch] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchError, setBatchError] = useState(null);

  // Load the signed-in teacher's own subjects once.
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from('subjects')
        .select('id, subject_name, subject_code, grade_level, room')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      if (!error) setSubjects(data || []);
    })();
  }, []);

  const refreshRoster = useCallback(async (qId) => {
    if (!qId) { setRoster([]); return; }
    setLoadingRoster(true);
    try {
      const data = await listScanResultsForQuiz(supabase, qId);
      setRoster(data || []);
    } catch {
      setRoster([]);
    } finally {
      setLoadingRoster(false);
    }
  }, []);

  // When a subject is picked: load its existing quizzes, and default the
  // quiz title to "แบบทดสอบ<ชื่อวิชา>" — the teacher can still edit it
  // freely afterward. handleLoadQuiz overwrites this with the saved title
  // if an existing quiz is then picked from the dropdown below.
  useEffect(() => {
    (async () => {
      setQuizId(null);
      setSetCode(null);
      setRoster([]);
      setClassStudents([]);
      setBatchError(null);
      if (!subjectId) { setExistingQuizzes([]); return; }
      const subj = subjects.find(s => s.id === subjectId);
      if (subj) setTitle(`แบบทดสอบ${subj.subject_name}`);
      try {
        setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      } catch {
        setExistingQuizzes([]);
      }
      if (subj) {
        setLoadingClassStudents(true);
        try {
          const { data, error } = await supabase
            .from('students')
            .select('id, student_code, student_name, prefix')
            .eq('grade_level', subj.grade_level)
            .eq('room', subj.room)
            .order('student_code', { ascending: true });
          setClassStudents(error ? [] : (data || []));
        } finally {
          setLoadingClassStudents(false);
        }
      }
      // openQuizFromList sets this right before switching subjects, so the
      // quiz loads only after the reset/existingQuizzes-refresh above has
      // fully settled — loading it any earlier would race handleLoadQuiz's
      // own field-setting against this effect's setQuizId(null)/setTitle
      // above and could leave stale defaults on screen.
      if (pendingQuizLoadRef.current) {
        const pendingId = pendingQuizLoadRef.current;
        pendingQuizLoadRef.current = null;
        handleLoadQuiz(pendingId);
      }
    })();
  }, [subjectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLoadQuiz(id) {
    if (!id) return;
    setLoadingQuiz(true);
    setLoadQuizError(null);
    try {
      const quiz = await getQuizWithAnswerKey(supabase, id);
      setTitle(quiz.title);
      setNumQuestions(quiz.numQuestions);
      setNumChoices(quiz.numChoices);
      setIdDigits(quiz.idDigits);
      setScheme(quiz.choiceScheme);
      setAnswerKey(quiz.answerKey);
      setQuizId(quiz.id);
      setSetCode(quiz.setCode ?? null);
      refreshRoster(quiz.id);
    } catch (err) {
      setLoadQuizError(err.message || 'โหลดชุดข้อสอบไม่สำเร็จ');
    } finally {
      setLoadingQuiz(false);
    }
  }

  async function handleSaveAnswerKey() {
    if (!subjectId || !keyComplete) return;
    setSavingQuiz(true);
    setSaveQuizError(null);
    try {
      const { quizId: newQuizId } = await createQuiz(supabase, {
        subjectId, title, numQuestions, numChoices, idDigits, choiceScheme: scheme,
        paperLayout: layoutStyle, cols, answerKey,
      });
      setQuizId(newQuizId);
      setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      refreshRoster(newQuizId);
      refreshAllQuizzes();
    } catch (err) {
      setSaveQuizError(err.message || 'บันทึกเฉลยไม่สำเร็จ');
    } finally {
      setSavingQuiz(false);
    }
  }

  async function handleDeleteQuiz() {
    if (!quizId) return;
    setDeletingQuiz(true);
    setDeleteQuizError(null);
    try {
      await deleteQuiz(supabase, quizId);
      setQuizId(null);
      setSetCode(null);
      setRoster([]);
      setAnswerKey({});
      setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      setConfirmDeleteQuizOpen(false);
      refreshAllQuizzes();
    } catch (err) {
      setDeleteQuizError(err.message || 'ลบชุดข้อสอบไม่สำเร็จ');
    } finally {
      setDeletingQuiz(false);
    }
  }

  async function handleDeleteResult(id, photoPath) {
    try {
      await deleteScanResult(supabase, id, photoPath);
      refreshRoster(quizId);
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'ลบผลสแกนไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    }
  }

  async function handleViewPhoto(photoPath) {
    try {
      const url = await getScanPhotoUrl(supabase, photoPath);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // best-effort — a missing/expired photo just won't open
    }
  }

  // Canvas text does not automatically wait for a webfont to finish
  // downloading — if we draw before Sarabun is loaded, the canvas silently
  // falls back to the browser default and never re-renders with the right
  // font even after it arrives. Explicitly load the specific weights used
  // (regular + bold) via the Font Loading API and only mark ready once both
  // resolve, so the sheet always redraws with Sarabun actually applied.
  useEffect(() => {
    (async () => {
      if (!document.fonts) { setFontReady(true); return; }
      try {
        await Promise.all([
          document.fonts.load('10px "Sarabun"'),
          document.fonts.load('bold 10px "Sarabun"'),
        ]);
      } finally {
        setFontReady(true);
      }
    })();
  }, []);

  const regenerate = useCallback(() => {
    if (!sheetCanvasRef.current) return;
    drawSheet(sheetCanvasRef.current, { title, subject, note, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle, cols, setCode }, null);
    setSheetReady(true);
  }, [title, subject, note, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle, cols, setCode, fontReady]);

  useEffect(() => { regenerate(); }, [regenerate]);

  // A question's correct-choice set can hold more than one index — a
  // student matching any one of them earns the question's full points, not
  // one entry per match. Each question also carries its own point value
  // (default 1) instead of every question being worth the same.
  function toggleChoice(qIndex, choiceIndex) {
    setAnswerKey(prev => {
      const entry = prev[qIndex] || { choices: [], points: 1 };
      const choices = entry.choices.includes(choiceIndex)
        ? entry.choices.filter(c => c !== choiceIndex)
        : [...entry.choices, choiceIndex].sort((a, b) => a - b);
      return { ...prev, [qIndex]: { ...entry, choices } };
    });
  }

  function setPointsFor(qIndex, rawValue) {
    const points = Math.max(0.5, Number(rawValue) || 1);
    setAnswerKey(prev => {
      const entry = prev[qIndex] || { choices: [], points: 1 };
      return { ...prev, [qIndex]: { ...entry, points } };
    });
  }

  function applyPointsToAll(rawValue) {
    const points = Math.max(0.5, Number(rawValue) || 1);
    setAnswerKey(prev => {
      const next = { ...prev };
      for (let qi = 0; qi < numQuestions; qi++) {
        const entry = next[qi] || { choices: [] };
        next[qi] = { ...entry, points };
      }
      return next;
    });
  }

  function downloadSheetHalfA4() {
    // A4 turned landscape, then cut left-right into two independent
    // portrait-shaped halves, each 148.5mm wide x 210mm tall, with a dashed
    // cut line between them. Each half keeps its own full set of 4
    // fiducial markers, so after cutting, each half is a complete,
    // independently scannable sheet — still taller than wide (sits
    // naturally in a phone's portrait camera frame), just shorter/wider
    // than a plain portrait-A4 half would be.
    //
    // The canvas is rendered at 3x pixel density for print sharpness (see
    // PRINT_SCALE in omr-core.js), so embedding it as a PNG without
    // jsPDF's `compress` option produces a raw, uncompressed bitmap in the
    // PDF — tens of MB for a single page. JPEG is both far smaller AND
    // much faster to encode than a compressed PNG re-embed for this kind
    // of black-on-white line art; quality 0.92 is visually indistinguishable
    // from the PNG source even zoomed in.
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    const halfW = 148.5; // 297mm / 2
    pdf.addImage(imgData, 'JPEG', 0, 0, halfW, 210);
    pdf.addImage(imgData, 'JPEG', halfW, 0, halfW, 210);
    pdf.setLineDash([2, 2], 0);
    pdf.setDrawColor(150, 150, 150);
    pdf.line(halfW, 0, halfW, 210);
    pdf.save('answer-sheet-a4-left-right-x2.pdf');
  }

  function downloadSheetPNG() {
    const canvas = sheetCanvasRef.current;
    const link = document.createElement('a');
    link.download = 'answer-sheet.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  // student_code is a 5-digit school ID matching idDigits by convention —
  // this still degrades gracefully (pad/truncate) for any code that isn't
  // exactly idDigits digits, rather than throwing and blocking the batch.
  function studentIdDigits(code) {
    const onlyDigits = (code || '').replace(/\D/g, '');
    return onlyDigits.padStart(idDigits, '0').slice(-idDigits).split('');
  }

  // Batch-generates one personalized answer sheet per student in the class
  // roster — name, class, running number pre-printed and the ID grid
  // pre-bubbled from their student_code — two students per A4 landscape
  // page (left/right half), as one combined PDF. Uses its own offscreen
  // canvas (not sheetCanvasRef) so it doesn't flicker the on-screen preview
  // while generating.
  async function handleGenerateClassPDF() {
    if (classStudents.length === 0) return;
    setGeneratingBatch(true);
    setBatchProgress(0);
    setBatchError(null);
    try {
      const subj = subjects.find(s => s.id === subjectId);
      const classLabel = subj ? formatGradeRoom(subj.grade_level, subj.room) : '';
      const canvas = document.createElement('canvas');
      // compress:true plus JPEG (instead of the 3x-scaled canvas's raw PNG)
      // is essential here, not just a nice-to-have — without it, a 25-student
      // batch produces a 300+MB PDF that takes the better part of a minute
      // to assemble, since jsPDF has to store each page as an uncompressed
      // bitmap. JPEG at quality 0.92 is both far smaller and much faster to
      // encode for this kind of black-on-white line art, and is visually
      // indistinguishable from the PNG source.
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      const halfW = 148.5;

      function drawStudent(student, seatNumber) {
        drawSheet(canvas, {
          title, subject, note, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle, cols, setCode,
          studentName: formatStudentName(student),
          studentClass: classLabel,
          studentNumber: seatNumber,
        }, { studentId: studentIdDigits(student.student_code) });
        return canvas.toDataURL('image/jpeg', 0.92);
      }

      for (let i = 0; i < classStudents.length; i += 2) {
        if (i > 0) pdf.addPage();
        pdf.addImage(drawStudent(classStudents[i], i + 1), 'JPEG', 0, 0, halfW, 210);
        if (classStudents[i + 1]) {
          pdf.addImage(drawStudent(classStudents[i + 1], i + 2), 'JPEG', halfW, 0, halfW, 210);
        }
        pdf.setLineDash([2, 2], 0);
        pdf.setDrawColor(150, 150, 150);
        pdf.line(halfW, 0, halfW, 210);
        setBatchProgress(Math.min(i + 2, classStudents.length));
        // Yield to the event loop so the progress UI actually paints between
        // canvas draws instead of the whole batch running in one blocking tick.
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      pdf.save(`answer-sheets-${subj?.grade_level || 'x'}-${subj?.room || 'x'}-x${classStudents.length}.pdf`);
    } catch (err) {
      setBatchError(err.message || 'สร้างกระดาษคำตอบทั้งห้องไม่สำเร็จ');
    } finally {
      setGeneratingBatch(false);
    }
  }

  const answeredCount = Array.from({ length: numQuestions }).filter((_, qi) => (answerKey[qi]?.choices?.length ?? 0) > 0).length;
  const keyComplete = answeredCount === numQuestions;
  const totalPoints = Array.from({ length: numQuestions }).reduce((sum, _, qi) => sum + (answerKey[qi]?.points ?? 1), 0);

  const steps = [
    { key: 0, label: '0. เลือกวิชา', done: !!subjectId },
    { key: 1, label: '1. ตั้งค่ากระดาษคำตอบ', done: sheetReady },
    { key: 2, label: '2. กำหนดเฉลย', done: keyComplete },
  ];

  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const row = 'flex flex-wrap gap-3';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-90';
  const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gray-100';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2 py-1 rounded-md text-[11px] font-semibold hover:bg-gray-200';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';
  const pillOk = pill + ' bg-green-50 text-green-700';
  const pillWarn = pill + ' bg-amber-50 text-amber-700';
  const imgwrap = 'border border-gray-200 rounded-lg overflow-hidden max-w-full [&_img]:block [&_img]:w-full';

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">เตรียมข้อสอบ — สร้างกระดาษคำตอบและกำหนดเฉลย</h1>
      <div className="text-sm text-gray-500 mb-5">
        เลือกวิชา → ออกแบบฟอร์ม → กำหนดเฉลย แล้วพิมพ์กระดาษคำตอบไว้ล่วงหน้า — เมื่อสอบเสร็จให้ไปที่หน้า
        <a href="/omr/scan" className="text-indigo-600 font-semibold"> สแกนตรวจ</a> เพื่อตรวจด้วยมือถือ
      </div>

      <div className={card}>
        <div className="font-semibold text-gray-900 mb-3">ชุดข้อสอบที่มีอยู่แล้วทั้งหมด</div>
        {allQuizzesLoading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {!allQuizzesLoading && allQuizzes.length === 0 && (
          <div className="text-sm text-gray-500">ยังไม่มีชุดข้อสอบในระบบ — เลือกวิชาด้านล่างเพื่อเริ่มสร้างชุดแรก</div>
        )}
        {allQuizzes.length > 0 && (
          <div className="max-h-72 overflow-y-auto -mx-5 px-5">
            {groupQuizzesBySubject(allQuizzes).map(group => {
              const expanded = expandedQuizGroups.has(group.name);
              return (
                <div key={group.name}>
                  <button
                    type="button"
                    onClick={() => toggleQuizGroup(group.name)}
                    className="w-full flex items-center gap-2 pt-3 pb-1.5 first:pt-0 text-left"
                  >
                    <ChevronDownIcon className={"h-3.5 w-3.5 text-gray-400 shrink-0 transition-transform " + (expanded ? '' : '-rotate-90')} />
                    <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{group.name}</span>
                    <span className="text-[11px] text-gray-400">({group.rows.length})</span>
                    <div className="h-px flex-1 bg-gray-100" />
                  </button>
                  {expanded && group.rows.map(q => (
                    <div key={q.id} className="flex justify-between items-center gap-3 text-sm py-2 border-b border-gray-100 last:border-b-0">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate">{q.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{q.num_questions} ข้อ · {q.num_choices} ตัวเลือก</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => openQuizFromList(q)} disabled={loadingQuiz}>
                          <PencilIcon className="h-3.5 w-3.5" /> แก้ไข
                        </button>
                        <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => setDeleteListTarget(q)}>
                          <TrashIcon className="h-3.5 w-3.5" /> ลบ
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex gap-1 mb-5 border-b border-gray-200 overflow-x-auto overflow-y-hidden" role="tablist">
        {steps.map(s => (
          <button
            key={s.key} type="button" role="tab" aria-selected={activeStep === s.key}
            className={
              "px-3.5 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors " +
              (activeStep === s.key ? 'text-indigo-600 border-indigo-600' : 'text-gray-500 border-transparent hover:text-gray-700')
            }
            onClick={() => setActiveStep(s.key)}
          >
            {s.done && <CheckCircleIcon className="h-3.5 w-3.5 text-green-600 mr-1 inline-block align-[-2px]" />}{s.label}
          </button>
        ))}
      </div>

      {/* Step 0: Subject + quiz */}
      <div className={card} style={{ display: activeStep === 0 ? 'block' : 'none' }}>
        <h2 className="text-base font-semibold mb-3">0. เลือกวิชาและชุดข้อสอบ</h2>
        <div className={row}>
          <div className={field}>
            <label className={label}>วิชา</label>
            <select className={inputCls} value={subjectId} onChange={e => setSubjectId(e.target.value)}>
              <option value="">— เลือกวิชา —</option>
              {subjects.map(s => (
                <option key={s.id} value={s.id}>{s.subject_code} {s.subject_name} (ชั้น {formatGradeRoom(s.grade_level, s.room)})</option>
              ))}
            </select>
          </div>
          {subjectId && (
            <div className={field}>
              <label className={label}>ชุดข้อสอบที่มีอยู่แล้ว</label>
              <select className={inputCls} value={quizId || ''} onChange={e => handleLoadQuiz(e.target.value)} disabled={loadingQuiz}>
                <option value="">— สร้างชุดใหม่ —</option>
                {existingQuizzes.map((q, i) => (
                  <option key={q.id} value={q.id}>{i + 1}. {q.title} ({q.num_questions} ข้อ)</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {!subjectId && subjects.length === 0 && (
          <div className="text-xs text-amber-700 mt-2.5">⚠ ไม่พบวิชาของบัญชีนี้ — กรุณาสร้างวิชาในระบบก่อน</div>
        )}
        {loadQuizError && <div className="text-xs text-red-600 mt-2.5">{loadQuizError}</div>}
        {quizId && (
          <div className="mt-2.5 flex items-center gap-2.5 flex-wrap">
            <span className={pillOk}>โหลด/บันทึกชุดข้อสอบแล้ว ({quizId.slice(0, 8)}…)</span>
            <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => setConfirmDeleteQuizOpen(true)} disabled={deletingQuiz}>
              {deletingQuiz ? 'กำลังลบ...' : (<><TrashIcon className="h-3.5 w-3.5" /> ลบชุดข้อสอบนี้</>)}
            </button>
            {deleteQuizError && <span className="text-xs text-red-600">{deleteQuizError}</span>}
          </div>
        )}
        <div className="flex justify-between mt-4">
          <span />
          <button className={btnSecondary} onClick={() => setActiveStep(1)}>ถัดไป →</button>
        </div>
      </div>

      {/* Step 1: Layout config */}
      <div className={card} style={{ display: activeStep === 1 ? 'block' : 'none' }}>
        <h2 className="text-base font-semibold mb-3">1. ตั้งค่ากระดาษคำตอบ</h2>
        <div className={row}>
          <div className={field}>
            <label className={label}>ชื่อชุดข้อสอบ</label>
            <input className={inputCls} value={title} onChange={e=>setTitle(e.target.value)} />
          </div>
          <div className={field}>
            <label className={label}>หัวข้อย่อย/บทเรียน (ถ้ามี)</label>
            <input className={inputCls} value={subject} onChange={e=>setSubject(e.target.value)} placeholder="เช่น บทที่ 3 พลังงาน" />
          </div>
          <div className={field}>
            <label className={label}>จำนวนข้อ</label>
            <select className={inputCls} value={numQuestions} onChange={e=>setNumQuestions(+e.target.value)}>
              {[20,30,40,60].map(n => <option key={n} value={n}>{n} ข้อ</option>)}
            </select>
          </div>
          <div className={field}>
            <label className={label}>จำนวนตัวเลือก</label>
            <select className={inputCls} value={numChoices} onChange={e=>setNumChoices(+e.target.value)}>
              {[3,4,5].map(n => <option key={n} value={n}>{n} ตัวเลือก</option>)}
            </select>
          </div>
          <div className={field}>
            <label className={label}>รูปแบบตัวเลือก</label>
            <select className={inputCls} value={scheme} onChange={e=>setScheme(e.target.value)}>
              <option value="thai">ก ข ค ง</option>
              <option value="en">A B C D</option>
              <option value="num">1 2 3 4</option>
            </select>
          </div>
        </div>
        <div className={field + ' mt-3'} style={{maxWidth: 480}}>
          <label className={label}>คำอธิบายเพิ่มเติม (ถ้ามี)</label>
          <textarea
            className={inputCls} rows={5} maxLength={300} value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="เช่น คำชี้แจงพิเศษ, ห้องสอบ, ภาคเรียน ฯลฯ — จะแสดงในช่องว่างข้างกรอบรหัสนักเรียน"
          />
        </div>
        <div className="mt-4 flex gap-5 flex-wrap">
          <div>
            <div className={imgwrap} style={{width: 240}}>
              <canvas ref={sheetCanvasRef} className="w-full"/>
            </div>
            <div className="flex gap-2 mt-2.5 flex-wrap">
              <button className={btn + ' inline-flex items-center gap-2'} onClick={downloadSheetHalfA4}>
                <DownloadIcon className="h-4 w-4" /> ดาวน์โหลด PDF (A4 แนวนอน ซ้าย-ขวา = 2 ชุด)
              </button>
              <button className={btnSecondary + ' inline-flex items-center gap-2'} onClick={downloadSheetPNG}>
                <DownloadIcon className="h-4 w-4" /> ดาวน์โหลด PNG
              </button>
            </div>
            <div className="text-[11px] text-amber-700 mt-1.5">⚠ ใช้ไฟล์ PDF สำหรับสั่งพิมพ์ (ไฟล์ PNG อาจพิมพ์ออกมาขนาดผิดเพี้ยน)</div>
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-2">
            <span className="h-7 w-7 rounded-lg bg-gradient-to-br from-purple-600 to-fuchsia-500 text-white flex items-center justify-center shrink-0">
              <UsersIcon className="h-4 w-4" />
            </span>
            สร้างกระดาษคำตอบทั้งห้อง (ใส่ชื่อ/เลขประจำตัวให้อัตโนมัติ)
          </h3>
          {!subjectId ? (
            <div className="text-xs text-gray-500">เลือกวิชาในขั้นตอนที่ 0 ก่อน เพื่อดึงรายชื่อนักเรียนของห้องนั้น</div>
          ) : loadingClassStudents ? (
            <div className="text-xs text-gray-500">กำลังโหลดรายชื่อนักเรียน...</div>
          ) : classStudents.length === 0 ? (
            <div className="text-xs text-gray-500">ไม่พบนักเรียนของห้องนี้ในระบบ</div>
          ) : (
            <>
              <div className="text-xs text-gray-500 mb-2">
                พบนักเรียน {classStudents.length} คน — แต่ละคนจะได้กระดาษคำตอบของตัวเอง พร้อมชื่อ-สกุล, ชั้น, เลขที่ และฝนวงกลมเลขประจำตัวนักเรียนให้อัตโนมัติจากรหัสนักเรียนในระบบ รวมเป็น PDF เดียว ({Math.ceil(classStudents.length / 2)} แผ่น A4)
              </div>
              <button className={btn + ' inline-flex items-center gap-2'} onClick={handleGenerateClassPDF} disabled={generatingBatch}>
                {generatingBatch ? `กำลังสร้าง... (${batchProgress}/${classStudents.length})` : (<><UsersIcon className="h-4 w-4" /> สร้าง PDF ทั้งห้อง ({classStudents.length} คน)</>)}
              </button>
              {batchError && <div className="text-xs text-red-600 mt-2">{batchError}</div>}
              <div className="text-[11px] text-gray-500 mt-1.5">เลขที่ในกระดาษคำตอบเรียงตามรหัสนักเรียนจากน้อยไปมาก — นักเรียนยังต้องเขียนชื่อ-สกุลด้วยลายมือตามที่พิมพ์ไว้เพื่อยืนยัน และตรวจสอบวงกลมเลขประจำตัวที่ฝนไว้ให้ก่อนเริ่มทำข้อสอบ</div>
            </>
          )}
        </div>

        <div className="flex justify-between mt-4">
          <button className={btnSecondary} onClick={() => setActiveStep(0)}>← ก่อนหน้า</button>
          <button className={btnSecondary} onClick={() => setActiveStep(2)}>ถัดไป →</button>
        </div>
      </div>

      {/* Step 2: Answer key */}
      <div className={card} style={{ display: activeStep === 2 ? 'block' : 'none' }}>
        <h2 className="text-base font-semibold mb-1">2. กำหนดเฉลย {keyComplete ? <span className={pillOk}>ครบแล้ว</span> : <span className={pillWarn}>{answeredCount}/{numQuestions} ข้อ</span>}</h2>
        <div className="text-xs text-gray-500 mb-3">แตะได้มากกว่า 1 ตัวเลือกต่อข้อถ้ามีคำตอบที่ถูกหลายแบบ (ตอบข้อไหนก็ได้เต็ม) และปรับคะแนนแต่ละข้อได้ — คะแนนรวม {totalPoints} คะแนน</div>
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <label className="text-xs font-semibold text-gray-500">กำหนดคะแนนเท่ากันทุกข้อ</label>
          <input
            type="number" min="0.5" step="0.5" value={bulkPoints}
            onChange={e => setBulkPoints(e.target.value)}
            className="w-16 px-1.5 py-1 border border-gray-300 rounded text-xs text-center"
          />
          <button className={btnTiny} onClick={() => applyPointsToAll(bulkPoints)}>ใช้กับทุกข้อ</button>
        </div>
        <div
          className="grid gap-1.5 mt-2"
          style={{
            gridTemplateColumns: numQuestions > 20 && isWideScreen ? '1fr 1fr' : '1fr',
            // grid-auto-flow: column (with an explicit row count) fills each
            // column top-to-bottom before moving to the next one, instead of
            // the default row-first flow that interleaves 01/02, 03/04, ...
            // side by side.
            gridTemplateRows: numQuestions > 20 && isWideScreen ? `repeat(${Math.ceil(numQuestions / 2)}, auto)` : undefined,
            gridAutoFlow: numQuestions > 20 && isWideScreen ? 'column' : 'row',
          }}
        >
          {Array.from({length: numQuestions}).map((_, qi) => (
            <div className="flex items-center gap-2 text-sm py-0.5 flex-wrap" key={qi}>
              <span className="w-7 text-gray-500 tabular-nums">{String(qi+1).padStart(2,'0')}</span>
              {letters.map((L, ci) => {
                const active = !!answerKey[qi]?.choices?.includes(ci);
                return (
                  <button
                    key={ci}
                    className={
                      "w-7 h-7 rounded-full border-[1.5px] text-xs font-bold " +
                      (active ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-300 hover:border-gray-400')
                    }
                    onClick={() => toggleChoice(qi, ci)}
                  >{L}</button>
                );
              })}
              <input
                type="number" min="0.5" step="0.5"
                value={answerKey[qi]?.points ?? 1}
                onChange={e => setPointsFor(qi, e.target.value)}
                className="w-14 px-1.5 py-1 border border-gray-300 rounded text-xs text-center"
                title="คะแนนของข้อนี้"
              />
              <span className="text-[10px] text-gray-400">คะแนน</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2.5 flex-wrap">
          {quizId ? (
            <span className={pillOk}>บันทึกเฉลยแล้ว — หากต้องการแก้ไข ให้เลือก &ldquo;สร้างชุดใหม่&rdquo; แล้วบันทึกเป็นชุดข้อสอบใหม่แทน</span>
          ) : (
            <button
              className={btn + ' inline-flex items-center gap-2'}
              onClick={handleSaveAnswerKey}
              disabled={!subjectId || !keyComplete || savingQuiz}
              title={!subjectId ? 'เลือกวิชาก่อน' : (!keyComplete ? 'กำหนดเฉลยให้ครบก่อน' : '')}
            >
              {savingQuiz ? 'กำลังบันทึก...' : (<><SaveIcon className="h-4 w-4" /> บันทึกเฉลยไปยังฐานข้อมูล</>)}
            </button>
          )}
          {saveQuizError && <span className="text-xs text-red-600">{saveQuizError}</span>}
        </div>
        {quizId && (
          <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50 p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm text-indigo-900">พร้อมสอบแล้ว — ให้นักเรียนทำข้อสอบ แล้วมาสแกนตรวจด้วยมือถือหลังสอบเสร็จ</div>
            <a href="/omr/scan" className={btn + ' inline-flex items-center gap-2'}>
              <CameraIcon className="h-4 w-4" /> ไปที่หน้าสแกนตรวจ <ArrowRightIcon className="h-4 w-4" />
            </a>
          </div>
        )}
        <div className="flex justify-between mt-4">
          <button className={btnSecondary} onClick={() => setActiveStep(1)}>← ก่อนหน้า</button>
          <span />
        </div>
      </div>

      {quizId && (
        <div className={card}>
          <h2 className="text-base font-semibold mb-3 flex items-center gap-1.5">
            <ClipboardListIcon className="h-4 w-4 text-gray-400" />
            ผลที่สแกนแล้วของชุดข้อสอบนี้ {loadingRoster && <span className="font-normal text-gray-500">(กำลังโหลด...)</span>}
          </h2>
          {roster.length === 0 ? (
            <div className="text-sm text-gray-500">ยังไม่มีนักเรียนถูกสแกน</div>
          ) : (
            <div className="max-h-60 overflow-y-auto">
              {roster.map(r => (
                <div key={r.id} className="flex justify-between items-center text-sm py-1.5 border-b border-gray-100 last:border-b-0">
                  <span>{r.students?.student_code} {formatStudentName(r.students)}</span>
                  <span className="flex items-center gap-2">
                    <span>{r.total_correct}/{numQuestions} ({r.score}%)</span>
                    {r.photo_path && <button className={btnTiny} onClick={() => handleViewPhoto(r.photo_path)}>ดูรูป</button>}
                    <button className={btnTiny} onClick={() => handleDeleteResult(r.id, r.photo_path)}>ลบ</button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteQuizOpen}
        title="ยืนยันลบชุดข้อสอบ"
        message={`ลบชุดข้อสอบ "${title}" ทั้งหมด?\n\nการลบนี้จะลบเฉลย ผลตรวจของนักเรียนทุกคน และรูปที่เก็บไว้ของชุดนี้ไปด้วย และไม่สามารถกู้คืนได้`}
        confirmLabel="ลบชุดข้อสอบ"
        danger
        loading={deletingQuiz}
        onConfirm={handleDeleteQuiz}
        onCancel={() => setConfirmDeleteQuizOpen(false)}
      />

      <ConfirmDialog
        open={!!deleteListTarget}
        title="ยืนยันลบชุดข้อสอบ"
        message={deleteListTarget ? `ลบชุดข้อสอบ "${deleteListTarget.title}" ทั้งหมด?\n\nการลบนี้จะลบเฉลย ผลตรวจของนักเรียนทุกคน และรูปที่เก็บไว้ของชุดนี้ไปด้วย และไม่สามารถกู้คืนได้` : ''}
        confirmLabel="ลบชุดข้อสอบ"
        danger
        loading={deletingListQuiz}
        onConfirm={handleDeleteListQuiz}
        onCancel={() => { setDeleteListTarget(null); setDeleteListError(null); }}
      />
      {deleteListError && <div className="text-xs text-red-600 mt-2">{deleteListError}</div>}
    </div>
  );
}

function CheckCircleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </svg>
  );
}

function ChevronDownIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function PencilIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
      <path d="M10 11v6M14 11v6" />
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

function SaveIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </svg>
  );
}

function CameraIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function ArrowRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function ClipboardListIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  );
}
