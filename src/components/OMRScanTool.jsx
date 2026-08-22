'use client';
// OMRScanTool.jsx
//
// Mobile-first scan flow for exam day: pick a quiz that was already
// prepared on a computer (OMRPrepareTool, at /omr/prepare), then either
// pick the student whose sheet is about to be photographed before
// scanning (the default flow — a saved result is always tied to a known
// student row, matching how lib/omr-db.js's omr_scan_results.student_id
// is modeled), or, in "rapid" mode, skip that pick and let each capture
// match itself to a student afterward via the ID bubbles the sheet already
// encodes (matchStudentByDecodedId), for scanning a whole stack of sheets
// back-to-back without stopping to tap a name each time.
//
// All OMR image-processing logic lives in ../lib/omr-core.js.

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  TOP_BOTTOM_PAGE_W, TOP_BOTTOM_PAGE_H, HALF_LANDSCAPE_PAGE_W, HALF_LANDSCAPE_PAGE_H,
  findFiducialsWithOrientation, readBubbles, drawGradedOverlay, choiceLetters,
} from '../lib/omr-core';
import { supabase } from '../lib/supabaseClient';
import { getQuizWithAnswerKey, listMyQuizzes, saveScanResult, listScanResultsForQuiz, deleteScanResult, uploadScanPhoto, getScanPhotoUrl } from '../lib/omr-db';
import { useAuth } from '../lib/AuthContext';
import { formatStudentName } from '../lib/student-name';
import { formatGradeRoom, formatThaiDateTime } from '../lib/format';

// Every quiz remembers the paper format it was printed with (omr_quizzes.paper_layout,
// .cols — see omr-db.js/getQuizWithAnswerKey), so scanning warps/reads against the
// exact page dimensions and column count that sheet actually used, rather than
// assuming one global format. 'topBottom' quizzes predate the 'halfLandscape'
// format (the only one OMRPrepareTool offers now) and still need to keep scanning
// correctly, hence branching on the saved value instead of hardcoding it here.
function pageOptsForQuiz(quiz) {
  if (quiz.paperLayout === 'halfLandscape') {
    return { pageW: HALF_LANDSCAPE_PAGE_W, pageH: HALF_LANDSCAPE_PAGE_H, layoutStyle: 'halfLandscape', cols: quiz.cols || undefined };
  }
  return { pageW: TOP_BOTTOM_PAGE_W, pageH: TOP_BOTTOM_PAGE_H, layoutStyle: 'topBottom', cols: undefined };
}

// "Rapid" scan mode skips picking a student up front and instead matches
// the decoded ID (from the bubbled student-ID grid, already read by every
// scan regardless of mode) against the class roster by student_code — the
// same right-aligned/zero-padded digit convention OMRPrepareTool uses when
// pre-bubbling a batch sheet's ID grid. Returns null on an ambiguous
// decode ('?' in any digit) or no matching student, so callers can fall
// back to the manual picker.
function matchStudentByDecodedId(students, decodedId, idDigits) {
  if (!decodedId || decodedId.includes('?')) return null;
  return students.find(s => {
    const code = (s.student_code || '').replace(/\D/g, '');
    return code.padStart(idDigits, '0').slice(-idDigits) === decodedId;
  }) || null;
}

const card = 'bg-white border border-gray-200 rounded-xl p-4 sm:p-5 mb-4';
const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-3 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed';
const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-3 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed';
const btnTiny = 'bg-gray-100 text-gray-900 px-2 py-1 rounded-md text-[11px] font-semibold hover:bg-gray-200';
const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';
const pillOk = pill + ' bg-green-50 text-green-700';
const pillBad = pill + ' bg-red-50 text-red-600';
const pillWarn = pill + ' bg-amber-50 text-amber-700';
const imgwrap = 'border border-gray-200 rounded-lg overflow-hidden max-w-full [&_img]:block [&_img]:w-full';
const stat = 'text-center p-3 rounded-lg bg-gray-50';
const statN = 'text-xl font-extrabold';
const statL = 'text-[11px] text-gray-500';
const chip = 'px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors';
const chipActive = 'bg-indigo-600 border-indigo-600 text-white';
const chipInactive = 'bg-white border-gray-300 text-gray-600 hover:border-indigo-300';

export default function OMRScanTool() {
  const { session, saveScanPhotos, setSaveScanPhotos } = useAuth();
  const [quizzes, setQuizzes] = useState([]);
  const [loadingQuizzes, setLoadingQuizzes] = useState(true);
  const [quizFilter, setQuizFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState(''); // '' = every grade level
  const [selectedQuiz, setSelectedQuiz] = useState(null); // full quiz + answerKey + subject grade/room
  const [quizLoadError, setQuizLoadError] = useState(null);

  const [students, setStudents] = useState([]);
  const [studentId, setStudentId] = useState('');
  // Rapid mode skips picking a student up front and matches the decoded ID
  // (via matchStudentByDecodedId) after each capture instead — lets a
  // teacher scan a whole stack of sheets back-to-back. forcePicker lets
  // them still fall back to the manual list for one paper (a mis-decode,
  // an ambiguous digit) without leaving rapid mode for the rest of the
  // stack.
  const [rapidMode, setRapidMode] = useState(false);
  const [forcePicker, setForcePicker] = useState(false);

  const [roster, setRoster] = useState([]);
  const [loadingRoster, setLoadingRoster] = useState(false);

  const [scanImage, setScanImage] = useState(null);
  const [gradedImageUrl, setGradedImageUrl] = useState(null);
  const gradedCanvasRef = useRef(null);
  const [scanResult, setScanResult] = useState(null);
  const [scanStage, setScanStage] = useState('idle');
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);

  const [savingResult, setSavingResult] = useState(false);
  const [saveResultError, setSaveResultError] = useState(null);
  const [savedResultId, setSavedResultId] = useState(null);

  // Tapping an already-scanned student normally shows their existing
  // result (score, per-question breakdown, saved photo) instead of the
  // capture screen — showRescan is the escape hatch back to capturing a
  // fresh photo (e.g. a misread sheet), scoped to just this student pick
  // so it doesn't leak into the next one (reset inside resetScan).
  const [showRescan, setShowRescan] = useState(false);
  const [existingPhotoUrl, setExistingPhotoUrl] = useState(null);

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

  const refreshRoster = useCallback(async (quizId) => {
    if (!quizId) { setRoster([]); return; }
    setLoadingRoster(true);
    try {
      setRoster(await listScanResultsForQuiz(supabase, quizId) || []);
    } catch {
      setRoster([]);
    } finally {
      setLoadingRoster(false);
    }
  }, []);

  async function handleSelectQuiz(row) {
    setQuizLoadError(null);
    try {
      const quiz = await getQuizWithAnswerKey(supabase, row.id);
      setSelectedQuiz({ ...quiz, gradeLevel: row.subjects?.grade_level, room: row.subjects?.room, subjectName: row.subjects?.subject_name });
      const { data, error } = await supabase
        .from('students')
        .select('id, student_code, student_name, prefix')
        .eq('grade_level', row.subjects?.grade_level)
        .eq('room', row.subjects?.room)
        .order('student_code', { ascending: true });
      setStudents(error ? [] : (data || []));
      refreshRoster(quiz.id);
    } catch (err) {
      setQuizLoadError(err.message || 'โหลดชุดข้อสอบไม่สำเร็จ');
    }
  }

  function handleChangeQuiz() {
    setSelectedQuiz(null);
    setStudents([]);
    setStudentId('');
    setForcePicker(false);
    setRoster([]);
    resetScan();
  }

  function resetScan() {
    setScanImage(null);
    setGradedImageUrl(null);
    gradedCanvasRef.current = null;
    setScanResult(null);
    setScanStage('idle');
    setSavedResultId(null);
    setSaveResultError(null);
    setShowRescan(false);
  }

  function pickStudent(id) {
    setStudentId(id);
    setForcePicker(false);
    resetScan();
  }

  function handleNextStudent() {
    setStudentId('');
    setForcePicker(false);
    resetScan();
    // Skip straight to the camera instead of making the teacher tap
    // "ถ่ายภาพกระดาษคำตอบ" again for every student in a batch — this still
    // runs inside the button's click handler, so the browser still counts
    // it as a user gesture and won't block the getUserMedia permission
    // prompt.
    openCamera();
  }

  function runScan(imgSrc) {
    setScanStage('processing');
    const { pageW, pageH, layoutStyle, cols } = pageOptsForQuiz(selectedQuiz);
    const img = new Image();
    img.onload = () => {
      setTimeout(() => {
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = img.width; srcCanvas.height = img.height;
        srcCanvas.getContext('2d').drawImage(img, 0, 0);

        // Live camera captures can come out rotated relative to how the
        // photo visually looked (a getUserMedia quirk on some devices) —
        // findFiducialsWithOrientation tries all 4 quarter-turns and picks
        // whichever one actually decodes cleanly, so a rotated capture is
        // corrected transparently instead of producing a skewed,
        // wrongly-graded read.
        const readOpts = {
          numQuestions: selectedQuiz.numQuestions, numChoices: selectedQuiz.numChoices,
          idDigits: selectedQuiz.idDigits, layoutStyle, cols,
        };
        const best = findFiducialsWithOrientation(srcCanvas, pageW, pageH, readOpts);

        if (!best) {
          setScanResult({ error: 'หาจุดมุมกระดาษ (fiducial markers) ไม่ครบ 4 มุม ลองถ่ายให้เห็นทั้ง 4 มุมชัดเจนขึ้น' });
          setScanStage('done');
          return;
        }

        const warped = best.warped;
        const { responses, studentId: decodedId, layout } = readBubbles(warped, { ...readOpts, pageW, pageH });

        let correct = 0, blank = 0, ambiguous = 0, earnedPoints = 0, totalPoints = 0;
        const graded = responses.map(r => {
          const entry = selectedQuiz.answerKey[r.question];
          const keyChoices = entry?.choices || [];
          const points = entry?.points ?? 1;
          totalPoints += points;
          const isCorrect = !r.blank && keyChoices.includes(r.choice);
          if (isCorrect) { correct++; earnedPoints += points; }
          if (r.blank) blank++;
          if (r.ambiguous) ambiguous++;
          return { ...r, correct: isCorrect, keyChoices, points };
        });

        // Build the reviewable graded overlay now (while the warped canvas
        // and layout are on hand) so it's ready to preview and, if the
        // teacher has opted in, upload on save — see resetScan/handleSaveScanResult.
        const gradedCanvas = drawGradedOverlay(warped, { layout, graded });
        gradedCanvasRef.current = gradedCanvas;
        setGradedImageUrl(gradedCanvas.toDataURL('image/png'));

        setScanResult({
          decodedId, graded, correct, total: selectedQuiz.numQuestions, blank, ambiguous,
          earnedPoints, totalPoints,
          score: totalPoints ? Math.round((earnedPoints / totalPoints) * 1000) / 10 : 0,
        });
        setScanStage('done');
      }, 200);
    };
    img.src = imgSrc;
  }

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setScanImage(ev.target.result);
      setGradedImageUrl(null);
      gradedCanvasRef.current = null;
      setScanResult(null);
      setSavedResultId(null);
      setSaveResultError(null);
      runScan(ev.target.result);
    };
    reader.readAsDataURL(file);
  }

  async function openCamera() {
    setCameraError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('เบราว์เซอร์นี้ไม่รองรับการเปิดกล้อง (ต้องเปิดผ่าน HTTPS) — ลองอัปโหลดรูปแทน');
      return;
    }
    try {
      // No explicit width/height ideal here (previously 1920x1080, a fixed
      // landscape request): forcing a landscape stream while the phone is
      // physically held in portrait to frame a portrait-shaped answer
      // sheet is exactly what triggers the rotated-buffer quirk that
      // findFiducialsWithOrientation exists to correct for — better not to
      // provoke it in the first place. Letting the browser pick its own
      // default resolution keeps it aligned with the device's actual
      // current orientation.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setCameraOpen(true);
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch {
      setCameraError('เปิดกล้องไม่สำเร็จ — ตรวจสอบว่าอนุญาตให้เว็บนี้ใช้กล้อง หรือลองอัปโหลดรูปแทน');
    }
  }

  function closeCamera() {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(t => t.stop());
      cameraStreamRef.current = null;
    }
    setCameraOpen(false);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    setScanImage(dataUrl);
    setGradedImageUrl(null);
    gradedCanvasRef.current = null;
    setScanResult(null);
    setSavedResultId(null);
    setSaveResultError(null);
    closeCamera();
    runScan(dataUrl);
  }

  useEffect(() => {
    return () => {
      if (cameraStreamRef.current) cameraStreamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  async function handleSaveScanResult() {
    // In rapid mode studentId is only set once a student is confirmed (via
    // the manual picker or, implicitly, by matchedStudent below) — until
    // then this falls back to whatever the current render matched from the
    // decoded ID.
    const targetStudentId = studentId || matchedStudent?.id;
    if (!selectedQuiz || !targetStudentId || !scanResult || scanResult.error) return;
    setSavingResult(true);
    setSaveResultError(null);
    try {
      let photoPath = null;
      if (saveScanPhotos && gradedCanvasRef.current) {
        const blob = await new Promise(resolve => gradedCanvasRef.current.toBlob(resolve, 'image/png'));
        if (blob) {
          ({ path: photoPath } = await uploadScanPhoto(supabase, {
            userId: session.user.id, quizId: selectedQuiz.id, blob,
          }));
        }
      }

      const responses = scanResult.graded.map(g => ({
        question: g.question, choice: g.choice, ambiguous: g.ambiguous, blank: g.blank,
      }));
      const { resultId } = await saveScanResult(supabase, {
        quizId: selectedQuiz.id, studentId: targetStudentId, responses, totalCorrect: scanResult.correct, score: scanResult.score,
        scannedBy: session.user.id, photoPath,
      });
      setSavedResultId(resultId);
      refreshRoster(selectedQuiz.id);
    } catch (err) {
      setSaveResultError(err.message || 'บันทึกผลสแกนไม่สำเร็จ');
    } finally {
      setSavingResult(false);
    }
  }

  async function handleDeleteResult(id, photoPath) {
    await deleteScanResult(supabase, id, photoPath);
    refreshRoster(selectedQuiz.id);
  }

  async function handleViewPhoto(photoPath) {
    try {
      const url = await getScanPhotoUrl(supabase, photoPath);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // best-effort — a missing/expired photo just won't open
    }
  }

  const scannedStudentIds = new Set(roster.map(r => r.students?.id).filter(Boolean));
  const selectedStudent = students.find(s => s.id === studentId) || null;
  // Only attempt a match once a scan has actually decoded something — and
  // only in rapid mode, since the normal flow already has a known student.
  const matchedStudent = (rapidMode && !studentId && scanResult && !scanResult.error && selectedQuiz)
    ? matchStudentByDecodedId(students, scanResult.decodedId, selectedQuiz.idDigits)
    : null;
  const effectiveStudent = selectedStudent || matchedStudent;
  // Most recent saved result for the picked student, if any — roster is
  // already ordered newest-first (listScanResultsForQuiz), and a student
  // can have more than one row (rescans intentionally add a new result
  // rather than overwrite), so this is "what to show by default", not
  // "the only result that exists".
  const existingResult = selectedStudent ? (roster.find(r => r.students?.id === selectedStudent.id) || null) : null;

  useEffect(() => {
    let cancelled = false;
    setExistingPhotoUrl(null);
    if (!existingResult?.photo_path) return;
    getScanPhotoUrl(supabase, existingResult.photo_path)
      .then(url => { if (!cancelled) setExistingPhotoUrl(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [existingResult?.id, existingResult?.photo_path]);

  const gradeLevels = [...new Set(quizzes.map(q => q.subjects?.grade_level).filter(Boolean))];
  const filteredQuizzes = quizzes.filter(q => {
    if (gradeFilter && q.subjects?.grade_level !== gradeFilter) return false;
    if (!quizFilter.trim()) return true;
    const hay = `${q.title} ${q.subjects?.subject_name || ''} ${q.subjects?.subject_code || ''}`.toLowerCase();
    return hay.includes(quizFilter.trim().toLowerCase());
  });

  // --- Screen 1: pick a prepared quiz ---
  if (!selectedQuiz) {
    return (
      <div className="max-w-5xl">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">สแกนตรวจ</h1>
        <div className="text-sm text-gray-500 mb-4">เลือกชุดข้อสอบที่เตรียมไว้แล้วเพื่อเริ่มสแกน</div>

        <button
          type="button"
          onClick={() => setSaveScanPhotos(!saveScanPhotos)}
          className={card + ' w-full flex items-center justify-between gap-3 text-left cursor-pointer select-none'}
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="h-10 w-10 rounded-xl bg-gradient-to-br from-purple-600 to-fuchsia-500 text-white flex items-center justify-center shrink-0">
              <PhotoIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-gray-900">เก็บรูปกระดาษคำตอบไว้ดูย้อนหลัง</span>
              <span className="block text-xs text-gray-500 mt-0.5">บันทึกรูปที่ตรวจแล้ว (พร้อมทำเครื่องหมายถูก/ผิด) ไว้เปิดดูภายหลัง</span>
            </span>
          </span>
          <span
            role="switch" aria-checked={saveScanPhotos}
            className={"relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors " + (saveScanPhotos ? 'bg-indigo-600' : 'bg-gray-300')}
          >
            <span className={"inline-block h-4 w-4 transform rounded-full bg-white transition-transform " + (saveScanPhotos ? 'translate-x-6' : 'translate-x-1')} />
          </span>
        </button>

        <button
          type="button"
          onClick={() => setRapidMode(!rapidMode)}
          className={card + ' w-full flex items-center justify-between gap-3 text-left cursor-pointer select-none'}
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="h-10 w-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shrink-0">
              <ZapIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-gray-900">ตรวจแบบรัว (ไม่ต้องเลือกชื่อก่อน)</span>
              <span className="block text-xs text-gray-500 mt-0.5">อ่านชื่อนักเรียนจากรหัสประจำตัวที่ฝนไว้ในกระดาษคำตอบเองหลังถ่ายภาพ เหมาะกับการถ่ายทีละหลายแผ่นต่อเนื่อง</span>
            </span>
          </span>
          <span
            role="switch" aria-checked={rapidMode}
            className={"relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors " + (rapidMode ? 'bg-indigo-600' : 'bg-gray-300')}
          >
            <span className={"inline-block h-4 w-4 transform rounded-full bg-white transition-transform " + (rapidMode ? 'translate-x-6' : 'translate-x-1')} />
          </span>
        </button>

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
              <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-500 text-white flex items-center justify-center shrink-0">
                <SheetIcon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-gray-900 truncate">{i + 1}. {q.title}</div>
                <div className="text-sm text-gray-500 mt-0.5 truncate">
                  {q.subjects?.subject_name} (ชั้น {formatGradeRoom(q.subjects?.grade_level, q.subjects?.room)}) · {q.num_questions} ข้อ
                </div>
              </div>
              <ChevronRightIcon className="h-4 w-4 text-gray-300 shrink-0" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  // --- Screen 2: pick a student ---
  // Skipped entirely in rapid mode unless the teacher explicitly asked for
  // it (forcePicker) — e.g. after a decode that didn't match anyone.
  if (!studentId && (!rapidMode || forcePicker)) {
    return (
      <div className="max-w-5xl">
        <QuizHeader quiz={selectedQuiz} onChangeQuiz={handleChangeQuiz} scannedCount={roster.length} totalCount={students.length} />
        {rapidMode && (
          <button type="button" className="text-xs font-semibold text-indigo-600 mt-3" onClick={() => setForcePicker(false)}>
            ← กลับไปตรวจแบบรัว
          </button>
        )}
        <h2 className="text-base font-semibold mb-3 mt-4">เลือกนักเรียนเจ้าของกระดาษคำตอบ</h2>
        {students.length === 0 ? (
          <div className="text-sm text-gray-500">ไม่พบนักเรียนของวิชานี้ (ชั้น {formatGradeRoom(selectedQuiz.gradeLevel, selectedQuiz.room)})</div>
        ) : (
          <div className="space-y-1.5">
            {students.map(st => {
              const scanned = scannedStudentIds.has(st.id);
              return (
                <button
                  key={st.id}
                  onClick={() => pickStudent(st.id)}
                  className={
                    "w-full flex items-center justify-between text-left bg-white border rounded-lg px-4 py-3 transition " +
                    (scanned ? 'border-green-200 bg-green-50/50' : 'border-gray-200 hover:border-indigo-300')
                  }
                >
                  <span className="text-sm font-medium text-gray-900">{st.student_code} {formatStudentName(st)}</span>
                  {scanned && <span className={pillOk}>สแกนแล้ว</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // --- Screen 3: capture + grade + save ---
  return (
    <div className="max-w-5xl">
      <QuizHeader quiz={selectedQuiz} onChangeQuiz={handleChangeQuiz} scannedCount={roster.length} totalCount={students.length} />

      <div className={card + ' mt-4'}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-gray-500">นักเรียน</div>
          <button
            className="text-xs font-semibold text-indigo-600"
            onClick={() => { setStudentId(''); if (rapidMode) setForcePicker(true); }}
          >
            {rapidMode ? 'เลือกนักเรียนเอง' : 'เปลี่ยนนักเรียน'}
          </button>
        </div>
        {rapidMode && !studentId ? (
          matchedStudent ? (
            <div className="font-semibold text-gray-900 mb-4">{matchedStudent.student_code} {formatStudentName(matchedStudent)}</div>
          ) : scanResult && !scanResult.error ? (
            <div className={pillBad + ' px-3 py-2 text-sm block mb-4'}>
              ไม่พบนักเรียนที่มีรหัสตรงกับ &ldquo;{scanResult.decodedId}&rdquo; ในห้องนี้ — เลือกนักเรียนเอง
            </div>
          ) : (
            <div className="text-sm text-gray-400 mb-4 flex items-center gap-1.5">
              <ZapIcon className="h-4 w-4" /> โหมดตรวจรัว — ถ่ายภาพเพื่ออ่านชื่อนักเรียนจากรหัสอัตโนมัติ
            </div>
          )
        ) : (
          <div className="font-semibold text-gray-900 mb-4">{selectedStudent?.student_code} {formatStudentName(selectedStudent)}</div>
        )}

        {!scanImage && existingResult && !showRescan ? (
          <ScannedResultDetail
            result={existingResult}
            quiz={selectedQuiz}
            photoUrl={existingPhotoUrl}
            onRescan={() => setShowRescan(true)}
            onDelete={() => handleDeleteResult(existingResult.id, existingResult.photo_path)}
          />
        ) : (
          <>
            {!scanImage && (
              <div className="flex flex-col gap-2">
                <button className={btn + ' py-4 text-base inline-flex items-center justify-center gap-2'} onClick={openCamera}>
                  <CameraIcon className="h-5 w-5" /> {existingResult ? 'สแกนซ้ำ' : 'ถ่ายภาพกระดาษคำตอบ'}
                </button>
                <button className={btnSecondary + ' inline-flex items-center justify-center gap-2'} onClick={() => fileInputRef.current.click()}>
                  <UploadIcon className="h-4 w-4" /> อัปโหลดรูปถ่าย
                </button>
                {existingResult && (
                  <button type="button" className="text-xs font-semibold text-gray-500 mt-1" onClick={() => setShowRescan(false)}>
                    ← กลับไปดูผลเดิม
                  </button>
                )}
                <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
              </div>
            )}
            {cameraError && <div className="text-xs text-red-600 mt-2">{cameraError}</div>}

            {cameraOpen && (
          <div className="mt-2">
            <div className="relative rounded-lg overflow-hidden border border-gray-200 bg-black">
              <video ref={videoRef} playsInline muted className="w-full block" />
            </div>
            <div className="flex gap-2 mt-2.5">
              <button className={btn + ' flex-1 inline-flex items-center justify-center gap-2'} onClick={capturePhoto}>
                <CameraIcon className="h-5 w-5" /> ถ่ายภาพ
              </button>
              <button className={btnSecondary} onClick={closeCamera}>ยกเลิก</button>
            </div>
            <div className="text-[11px] text-gray-500 mt-1.5">จัดกระดาษให้เห็นจุดดำทึบทั้ง 4 มุมชัดเจนในเฟรม แล้วกดถ่ายภาพ</div>
          </div>
        )}

        {scanImage && (
          <div className="mt-2">
            <div className={imgwrap + ' mb-3'} style={{ width: 220 }}>
              <img src={gradedImageUrl || scanImage} alt="ภาพกระดาษคำตอบ" />
            </div>

            {scanStage === 'processing' && <div className="text-sm text-gray-500">กำลังตรวจ...</div>}

            {scanResult && scanResult.error && (
              <div>
                <div className={pillBad + ' px-3 py-2 text-sm block mb-3'}>{scanResult.error}</div>
                <button className={btnSecondary + ' inline-flex items-center justify-center gap-2'} onClick={resetScan}>
                  <RefreshIcon className="h-4 w-4" /> ถ่ายใหม่
                </button>
              </div>
            )}

            {scanResult && !scanResult.error && (
              <div>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <div className={stat}><div className={statN}>{scanResult.earnedPoints}/{scanResult.totalPoints}</div><div className={statL}>คะแนน ({scanResult.score}%)</div></div>
                  <div className={stat}><div className={statN}>{scanResult.correct}/{scanResult.total}</div><div className={statL}>ข้อถูก</div></div>
                  <div className={stat}><div className={statN}>{scanResult.blank}</div><div className={statL}>ไม่ตอบ</div></div>
                  <div className={stat}><div className={statN}>{scanResult.ambiguous}</div><div className={statL}>ไม่ชัด</div></div>
                </div>
                <div className="text-xs text-gray-500 mb-3">
                  รหัสที่อ่านได้จากกระดาษ: <strong className="text-gray-700">{scanResult.decodedId}</strong>
                  {rapidMode && !studentId ? ' — ระบบจับคู่ชื่อให้อัตโนมัติจากรหัสนี้' : ' — ตรวจสอบว่าตรงกับนักเรียนที่เลือกไว้'}
                </div>
                {effectiveStudent && scannedStudentIds.has(effectiveStudent.id) && !savedResultId && (
                  <div className={pillWarn + ' px-3 py-2 text-sm block mb-3'}>
                    ⚠ {formatStudentName(effectiveStudent)} เคยถูกสแกนแล้ว — บันทึกซ้ำจะเพิ่มผลใหม่อีกรายการ
                  </div>
                )}

                {savedResultId ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={pillOk}>บันทึกแล้ว</span>
                    <button className={btn + ' inline-flex items-center justify-center gap-2'} onClick={handleNextStudent}>
                      ถ่ายคนถัดไป <ArrowRightIcon className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2 flex-wrap">
                    <button className={btn + ' inline-flex items-center justify-center gap-2'} onClick={handleSaveScanResult} disabled={savingResult || !effectiveStudent}>
                      {savingResult ? 'กำลังบันทึก...' : (<><SaveIcon className="h-4 w-4" /> บันทึกผล</>)}
                    </button>
                    <button className={btnSecondary + ' inline-flex items-center justify-center gap-2'} onClick={resetScan}>
                      <RefreshIcon className="h-4 w-4" /> ถ่ายใหม่
                    </button>
                  </div>
                )}
                {saveResultError && <div className="text-xs text-red-600 mt-2">{saveResultError}</div>}
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>

      <div className={card}>
        <div className="text-sm font-bold mb-2 flex items-center gap-1.5">
          <ClipboardListIcon className="h-4 w-4 text-gray-400" />
          สแกนแล้ว {roster.length}/{students.length} คน {loadingRoster && <span className="font-normal text-gray-500">(กำลังโหลด...)</span>}
        </div>
        {roster.length > 0 && (
          <div className="max-h-52 overflow-y-auto">
            {roster.map(r => (
              <div key={r.id} className="flex justify-between items-center text-xs py-1.5 border-b border-gray-100 last:border-b-0">
                <span>{r.students?.student_code} {formatStudentName(r.students)}</span>
                <span className="flex items-center gap-2">
                  <span>{r.total_correct}/{selectedQuiz.numQuestions} ({r.score}%)</span>
                  {r.photo_path && <button className={btnTiny} onClick={() => handleViewPhoto(r.photo_path)}>ดูรูป</button>}
                  <button className={btnTiny} onClick={() => handleDeleteResult(r.id, r.photo_path)}>ลบ</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Shown in place of the capture buttons when the picked student already
// has a saved result — the score/photo/per-question breakdown a teacher
// actually wants when re-opening someone already marked "สแกนแล้ว", instead
// of being dropped straight back into "ถ่ายภาพกระดาษคำตอบ" as if nothing
// had been scanned yet. `result` is one row from listScanResultsForQuiz
// (aggregate total_correct/score + raw per-question `responses`, no stored
// earnedPoints/totalPoints), so the points-weighted total is recomputed
// here from `responses` against quiz.answerKey exactly like runScan does
// for a live scan.
function ScannedResultDetail({ result, quiz, photoUrl, onRescan, onDelete }) {
  const letters = choiceLetters(quiz.choiceScheme, quiz.numChoices);
  const byQuestion = new Map((result.responses || []).map(r => [r.question, r]));
  let earnedPoints = 0, totalPoints = 0, blank = 0, ambiguous = 0;
  const items = Array.from({ length: quiz.numQuestions }, (_, qi) => {
    const resp = byQuestion.get(qi);
    const entry = quiz.answerKey[qi];
    const correctChoices = entry?.choices || [];
    const points = entry?.points ?? 1;
    totalPoints += points;
    const isCorrect = !!resp && !resp.blank && !resp.ambiguous && correctChoices.includes(resp.choice);
    if (isCorrect) earnedPoints += points;
    if (!resp || resp.blank) blank++;
    if (resp?.ambiguous) ambiguous++;
    return {
      qi,
      isCorrect,
      chosenLabel: resp && !resp.blank && resp.choice != null ? (letters[resp.choice] ?? '?') : '-',
      correctLabel: correctChoices.map(c => letters[c] ?? '?').join('/'),
    };
  });

  return (
    <div>
      {photoUrl && (
        <div className={imgwrap + ' mb-3'} style={{ width: 220 }}>
          <img src={photoUrl} alt="ภาพกระดาษคำตอบที่สแกน" />
        </div>
      )}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <div className={stat}><div className={statN}>{earnedPoints}/{totalPoints}</div><div className={statL}>คะแนน ({result.score}%)</div></div>
        <div className={stat}><div className={statN}>{result.total_correct}/{quiz.numQuestions}</div><div className={statL}>ข้อถูก</div></div>
        <div className={stat}><div className={statN}>{blank}</div><div className={statL}>ไม่ตอบ</div></div>
        <div className={stat}><div className={statN}>{ambiguous}</div><div className={statL}>ไม่ชัด</div></div>
      </div>
      <div className="text-xs text-gray-500 mb-2">สแกนเมื่อ {formatThaiDateTime(result.scanned_at)}</div>
      <div className="grid grid-cols-5 sm:grid-cols-8 gap-1.5 mb-4">
        {items.map(it => (
          <div
            key={it.qi}
            className={"rounded-lg border text-center py-1.5 " + (it.isCorrect ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50')}
          >
            <div className="text-[10px] text-gray-500">ข้อ {it.qi + 1}</div>
            <div className={"text-sm font-bold " + (it.isCorrect ? 'text-green-700' : 'text-red-600')}>{it.chosenLabel}</div>
            {!it.isCorrect && <div className="text-[9px] text-gray-500">เฉลย {it.correctLabel}</div>}
          </div>
        ))}
      </div>
      <div className="flex gap-2 flex-wrap">
        <button className={btnSecondary + ' inline-flex items-center justify-center gap-2'} onClick={onRescan}>
          <RefreshIcon className="h-4 w-4" /> สแกนซ้ำ
        </button>
        <button className={btnSecondary + ' inline-flex items-center justify-center gap-2 text-red-600'} onClick={onDelete}>
          ลบผลนี้
        </button>
      </div>
    </div>
  );
}

function QuizHeader({ quiz, onChangeQuiz, scannedCount, totalCount }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-xl p-3">
      <div className="flex items-center gap-3 min-w-0">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-500 text-white flex items-center justify-center shrink-0">
          <SheetIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-gray-900 truncate">{quiz.title}</div>
          <div className="text-xs text-gray-500">{quiz.subjectName} (ชั้น {formatGradeRoom(quiz.gradeLevel, quiz.room)}) · สแกนแล้ว {scannedCount}/{totalCount}</div>
        </div>
      </div>
      <button className="text-xs font-semibold text-indigo-600 shrink-0" onClick={onChangeQuiz}>เปลี่ยนชุดข้อสอบ</button>
    </div>
  );
}

function SheetIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </svg>
  );
}

function PhotoIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-5-5L5 20" />
    </svg>
  );
}

function ZapIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
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

function CameraIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function UploadIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
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

function ArrowRightIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function RefreshIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
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
