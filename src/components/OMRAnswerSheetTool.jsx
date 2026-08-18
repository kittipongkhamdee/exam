'use client';
// OMRAnswerSheetTool.jsx
//
// Combined answer-sheet generator + scanner UI, built for a single Next.js
// client component. It intentionally keeps generator state (answer key,
// question count, scheme) and scanner state (camera, captured photo, scan
// result) together in one component because the scanner needs the
// generator's answerKey to grade against — splitting them into two routes
// would mean lifting answerKey into a shared store (Context, Zustand, a
// server-persisted quiz record, etc.) and passing it down. If you want
// separate /create and /scan pages:
//   1. Move the "1. ตั้งค่ากระดาษคำตอบ" + "2. กำหนดเฉลย" sections (and their
//      state: numQuestions, numChoices, idDigits, scheme, title, subject,
//      answerKey) into an OMRGenerator component. Persist answerKey
//      wherever your quiz records live (e.g. a Supabase/Postgres row) once
//      the teacher finishes setting it, keyed by quiz ID.
//   2. Move "3. ทดสอบสแกนตรวจ" (camera, scanImage, scanResult, and related
//      state) into an OMRScanner component that takes numQuestions,
//      numChoices, idDigits, scheme, and answerKey as props — fetched by
//      quiz ID from wherever step 1 persisted them, instead of reading
//      local component state directly.
//
// Requires: react (^18), jspdf (npm install jspdf) for the PDF export
// button — swap for your own PDF pipeline if you have one already.
//
// All OMR logic (layout math, canvas drawing, corner detection, perspective
// warp, bubble reading) lives in ../lib/omr-core.js and is imported below —
// this file is UI/state only.

import { useState, useRef, useCallback, useEffect } from 'react';
import { jsPDF } from 'jspdf';
import {
  PAGE_W, PAGE_H, MARKER, MARGIN,
  HALF_PAGE_W, HALF_PAGE_H,
  HALF_LANDSCAPE_PAGE_W, HALF_LANDSCAPE_PAGE_H,
  TOP_BOTTOM_PAGE_W, TOP_BOTTOM_PAGE_H,
  buildLayout, drawSheet, choiceLetters,
  toGray, findFiducials, warpImage, readBubbles,
} from '../lib/omr-core';
import { supabase } from '../lib/supabaseClient';
import {
  createQuiz, getQuizWithAnswerKey, listQuizzesForSubject,
  saveScanResult, listScanResultsForQuiz, deleteScanResult,
} from '../lib/omr-db';

export default function OMRAnswerSheetTool() {
  const [numQuestions, setNumQuestions] = useState(20);
  const [numChoices, setNumChoices] = useState(4);
  const [idDigits, setIdDigits] = useState(5);
  const [scheme, setScheme] = useState('thai');
  const [title, setTitle] = useState('แบบทดสอบวิทยาศาสตร์ ม.1');
  const [subject, setSubject] = useState('บทที่ 3 พลังงาน');
  // Only one paper layout now: A4 cut top/bottom into two independent
  // half-height sheets. Kept as constants (not state) since there's no
  // longer a picker for it.
  const pageW = TOP_BOTTOM_PAGE_W, pageH = TOP_BOTTOM_PAGE_H;
  const layoutStyle = 'topBottom';

  const [answerKey, setAnswerKey] = useState({});
  const sheetCanvasRef = useRef(null);
  const [sheetReady, setSheetReady] = useState(false);

  const [simResponses, setSimResponses] = useState({});
  const [simId, setSimId] = useState('12345');

  const [scanImage, setScanImage] = useState(null);
  const [scanResult, setScanResult] = useState(null);
  const [scanStage, setScanStage] = useState('idle');
  const [debugCanvas, setDebugCanvas] = useState(null);
  const [originalAnnotated, setOriginalAnnotated] = useState(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);

  const letters = choiceLetters(scheme, numChoices);
  const [fontReady, setFontReady] = useState(false);

  const [activeStep, setActiveStep] = useState(0);

  // --- Supabase-backed quiz/subject/student state ---
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [quizId, setQuizId] = useState(null);
  const [savingQuiz, setSavingQuiz] = useState(false);
  const [saveQuizError, setSaveQuizError] = useState(null);

  const [existingQuizzes, setExistingQuizzes] = useState([]);
  const [loadingQuiz, setLoadingQuiz] = useState(false);
  const [loadQuizError, setLoadQuizError] = useState(null);

  const [students, setStudents] = useState([]);
  const [studentId, setStudentId] = useState('');

  const [savingResult, setSavingResult] = useState(false);
  const [saveResultError, setSaveResultError] = useState(null);
  const [savedResultId, setSavedResultId] = useState(null);

  const [roster, setRoster] = useState([]);
  const [loadingRoster, setLoadingRoster] = useState(false);

  const selectedSubject = subjects.find(s => s.id === subjectId) || null;

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

  // When a subject is picked: load its existing quizzes and its students
  // (matched on the subject's own grade_level/room, per students_read RLS).
  useEffect(() => {
    (async () => {
      setQuizId(null);
      setSavedResultId(null);
      setRoster([]);
      if (!subjectId) { setExistingQuizzes([]); setStudents([]); return; }
      try {
        setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      } catch {
        setExistingQuizzes([]);
      }
      if (selectedSubject) {
        const { data, error } = await supabase
          .from('students')
          .select('id, student_code, student_name, prefix')
          .eq('grade_level', selectedSubject.grade_level)
          .eq('room', selectedSubject.room)
          .order('student_code', { ascending: true });
        setStudents(error ? [] : (data || []));
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
        subjectId, title, numQuestions, numChoices, idDigits, choiceScheme: scheme, answerKey,
      });
      setQuizId(newQuizId);
      setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      refreshRoster(newQuizId);
    } catch (err) {
      setSaveQuizError(err.message || 'บันทึกเฉลยไม่สำเร็จ');
    } finally {
      setSavingQuiz(false);
    }
  }

  async function handleSaveScanResult() {
    if (!quizId || !studentId || !scanResult || scanResult.error) return;
    setSavingResult(true);
    setSaveResultError(null);
    try {
      const responses = scanResult.graded.map(g => ({
        question: g.question, choice: g.choice, ambiguous: g.ambiguous, blank: g.blank,
      }));
      const { resultId } = await saveScanResult(supabase, {
        quizId, studentId, responses, totalCorrect: scanResult.correct, score: scanResult.score,
      });
      setSavedResultId(resultId);
      refreshRoster(quizId);
    } catch (err) {
      setSaveResultError(err.message || 'บันทึกผลสแกนไม่สำเร็จ');
    } finally {
      setSavingResult(false);
    }
  }

  async function handleDeleteResult(id) {
    await deleteScanResult(supabase, id);
    refreshRoster(quizId);
  }

  // Canvas text does not automatically wait for a webfont to finish
  // downloading — if we draw before Prompt is loaded, the canvas silently
  // falls back to the browser default and never re-renders with the right
  // font even after it arrives. Explicitly load the specific weights used
  // (regular + bold) via the Font Loading API and only mark ready once both
  // resolve, so the sheet always redraws with Prompt actually applied.
  useEffect(() => {
    (async () => {
      if (!document.fonts) { setFontReady(true); return; }
      try {
        await Promise.all([
          document.fonts.load('10px "Prompt"'),
          document.fonts.load('bold 10px "Prompt"'),
        ]);
      } finally {
        setFontReady(true);
      }
    })();
  }, []);

  const regenerate = useCallback(() => {
    if (!sheetCanvasRef.current) return;
    drawSheet(sheetCanvasRef.current, { title, subject, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle }, null);
    setSheetReady(true);
  }, [title, subject, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle, fontReady]);

  useEffect(() => { regenerate(); }, [regenerate]);


  function setKeyFor(qIndex, choiceIndex) {
    setAnswerKey(prev => ({ ...prev, [qIndex]: choiceIndex }));
  }

  function downloadSheet() {
    // Export as a true A4 PDF (210mm x 297mm) rather than a raw-pixel PNG.
    // A PNG has no inherent physical size — printers/viewers guess a DPI to
    // convert pixels to mm, and that guess is often wrong (e.g. treating our
    // 850x1100px canvas as 850x1100 *points* at 72 DPI would print it far
    // larger than a real A4 page). Embedding the image in a PDF with an
    // explicit A4 page size removes that ambiguity — it always prints at the
    // correct physical size regardless of image pixel resolution.
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const imgData = canvas.toDataURL('image/png');
    pdf.addImage(imgData, 'PNG', 0, 0, 210, 297); // fill exactly one A4 page
    pdf.save('answer-sheet-a4.pdf');
  }

  function downloadSheetHalfA4() {
    // Print 2 independent answer sheets on a single A4 page, side by side,
    // each filling exactly one true half (105mm x 297mm), with a dashed cut
    // line between them. This must be used with paperSize='half' selected,
    // so the source canvas is already drawn natively at HALF_PAGE_W x
    // HALF_PAGE_H (same aspect ratio as the physical 105x297mm target) —
    // placing it at 105mm width introduces NO stretching, unlike squeezing
    // the full-page canvas into half width, which would distort every
    // circle into an ellipse. Each half keeps its own full set of 4
    // fiducial markers, so after cutting, each half is a complete,
    // independently scannable sheet on its own — the scanner code needs no
    // changes for this, since a cut half-sheet photographed on its own
    // looks exactly like a normal sheet of that size to it.
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const imgData = canvas.toDataURL('image/png');
    const halfW = 105; // 210mm / 2
    pdf.addImage(imgData, 'PNG', 0, 0, halfW, 297);
    pdf.addImage(imgData, 'PNG', halfW, 0, halfW, 297);
    // Dashed cut line down the middle
    pdf.setLineDash([2, 2], 0);
    pdf.setDrawColor(150, 150, 150);
    pdf.line(halfW, 0, halfW, 297);
    pdf.save('answer-sheet-a4-half-x2.pdf');
  }

  function downloadSheetHalfLandscapeA4() {
    // Same idea as downloadSheetHalfA4, but the A4 sheet itself is rotated
    // to landscape (297mm x 210mm) before being cut left-right, so each half
    // is 148.5mm wide x 210mm tall — shorter and wider than the portrait-cut
    // 'half' variant. Must be used with paperSize='halfLandscape' selected,
    // so the source canvas is already natively HALF_LANDSCAPE_PAGE_W x
    // HALF_LANDSCAPE_PAGE_H (matching aspect ratio — no stretching).
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const imgData = canvas.toDataURL('image/png');
    const halfW = 148.5; // 297mm / 2
    pdf.addImage(imgData, 'PNG', 0, 0, halfW, 210);
    pdf.addImage(imgData, 'PNG', halfW, 0, halfW, 210);
    // Dashed cut line down the middle
    pdf.setLineDash([2, 2], 0);
    pdf.setDrawColor(150, 150, 150);
    pdf.line(halfW, 0, halfW, 210);
    pdf.save('answer-sheet-a4-landscape-half-x2.pdf');
  }

  function downloadSheetTopBottomA4() {
    // A4 portrait cut horizontally (top/bottom) into two full-width halves,
    // each 210mm wide x 148.5mm tall, stacked with a dashed cut line between
    // them. Must be used with paperSize='topBottom' selected, so the source
    // canvas is already natively TOP_BOTTOM_PAGE_W x TOP_BOTTOM_PAGE_H
    // (matching aspect ratio — no stretching). Each half keeps its own full
    // set of 4 fiducial markers and horizontal-row ID grid, so after
    // cutting, each half is a complete, independently scannable sheet.
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const imgData = canvas.toDataURL('image/png');
    const halfH = 148.5; // 297mm / 2
    pdf.addImage(imgData, 'PNG', 0, 0, 210, halfH);
    pdf.addImage(imgData, 'PNG', 0, halfH, 210, halfH);
    // Dashed cut line across the middle
    pdf.setLineDash([2, 2], 0);
    pdf.setDrawColor(150, 150, 150);
    pdf.line(0, halfH, 210, halfH);
    pdf.save('answer-sheet-a4-top-bottom-x2.pdf');
  }

  function downloadSheetPNG() {
    const canvas = sheetCanvasRef.current;
    const link = document.createElement('a');
    link.download = 'answer-sheet.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  // Generate a simulated "photo" — draws sheet with random-ish fill offsets + slight rotation to mimic a real photo
  function generateSimulatedScan() {
    const responses = {};
    for (let q = 0; q < numQuestions; q++) {
      responses[q] = Math.floor(Math.random() * numChoices);
    }
    setSimResponses(responses);

    const clean = document.createElement('canvas');
    drawSheet(clean, { title, subject, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle }, { responses, studentId: simId });

    // simulate photo: slight rotation, scale, padding (background), noise
    const photo = document.createElement('canvas');
    const pad = 60;
    const angle = (Math.random() * 4 - 2) * Math.PI / 180;
    photo.width = pageW + pad * 2;
    photo.height = pageH + pad * 2;
    const pctx = photo.getContext('2d');
    pctx.fillStyle = '#cfd3d8';
    pctx.fillRect(0, 0, photo.width, photo.height);
    pctx.save();
    pctx.translate(photo.width/2, photo.height/2);
    pctx.rotate(angle);
    pctx.drawImage(clean, -pageW/2, -pageH/2);
    pctx.restore();
    // light noise
    const idata = pctx.getImageData(0,0,photo.width, photo.height);
    for (let i = 0; i < idata.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 14;
      idata.data[i] = Math.min(255, Math.max(0, idata.data[i] + n));
      idata.data[i+1] = Math.min(255, Math.max(0, idata.data[i+1] + n));
      idata.data[i+2] = Math.min(255, Math.max(0, idata.data[i+2] + n));
    }
    pctx.putImageData(idata, 0, 0);

    setScanImage(photo.toDataURL('image/png'));
    setScanResult(null);
    setSavedResultId(null);
    setSaveResultError(null);
    setOriginalAnnotated(null);
    setDebugCanvas(null);
    setScanStage('idle');
  }

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setScanImage(ev.target.result);
      setScanResult(null);
      setSavedResultId(null);
      setSaveResultError(null);
      setOriginalAnnotated(null);
      setDebugCanvas(null);
      setScanStage('idle');
    };
    reader.readAsDataURL(file);
  }

  async function openCamera() {
    setCameraError(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // getUserMedia requires a secure context (HTTPS, or localhost) — a
      // plain file:// page or an insecure iframe will not expose it at all.
      setCameraError('เบราว์เซอร์นี้ไม่รองรับการเปิดกล้อง (ต้องเปิดผ่าน HTTPS) — ลองอัปโหลดรูปแทน');
      return;
    }
    try {
      // Prefer the rear/environment camera, since that's what's used to
      // photograph a physical sheet of paper lying on a desk. Everything
      // stays in the browser — no file is written or uploaded anywhere;
      // the captured frame goes straight into the same in-memory pipeline
      // the file-upload path uses.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      cameraStreamRef.current = stream;
      setCameraOpen(true);
      // videoRef.current may not be mounted yet on this same tick (the
      // <video> element only renders once cameraOpen is true), so attach
      // the stream on the next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch (err) {
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
    setScanImage(canvas.toDataURL('image/png'));
    setScanResult(null);
    setSavedResultId(null);
    setSaveResultError(null);
    setOriginalAnnotated(null);
    setDebugCanvas(null);
    setScanStage('idle');
    closeCamera();
  }

  // Release the camera if the component unmounts while it's still open.
  useEffect(() => {
    return () => {
      if (cameraStreamRef.current) cameraStreamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  function runScan() {
    if (!scanImage) return;
    setScanStage('processing');
    const img = new Image();
    img.onload = () => {
      setTimeout(() => {
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = img.width; srcCanvas.height = img.height;
        srcCanvas.getContext('2d').drawImage(img, 0, 0);

        const sctx = srcCanvas.getContext('2d');
        const imgData = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
        const gray = toGray(imgData);
        const { corners } = findFiducials(gray, srcCanvas.width, srcCanvas.height);

        if (corners.some(c => c === null)) {
          setScanResult({ error: 'หาจุดมุมกระดาษ (fiducial markers) ไม่ครบ 4 มุม ลองถ่ายให้เห็นทั้ง 4 มุมชัดเจนขึ้น' });
          setScanStage('done');
          return;
        }

        // Diagnostic: mark the detected corner points directly on the original
        // photo (before warping) so we can visually confirm they land exactly
        // on the 4 black squares. If a marker circle is off-target here, the
        // problem is in corner detection; if the circles look correct but the
        // warped result still looks skewed, the problem is in the homography
        // math or destination-point mapping instead.
        const annotated = document.createElement('canvas');
        annotated.width = srcCanvas.width; annotated.height = srcCanvas.height;
        const actx = annotated.getContext('2d');
        actx.drawImage(srcCanvas, 0, 0);
        const cornerLabels = ['TL', 'TR', 'BL', 'BR'];
        corners.forEach((c, i) => {
          actx.beginPath();
          actx.arc(c.x, c.y, 14, 0, Math.PI*2);
          actx.strokeStyle = '#00c853'; actx.lineWidth = 4; actx.stroke();
          actx.font = 'bold 24px "Prompt", sans-serif';
          actx.fillStyle = '#00c853';
          actx.fillText(cornerLabels[i], c.x + 18, c.y);
        });
        setOriginalAnnotated(annotated.toDataURL('image/png'));

        const warped = warpImage(srcCanvas, corners, pageW, pageH);
        if (!warped) {
          setScanResult({ error: 'คำนวณการปรับมุมมองภาพไม่สำเร็จ (มุมที่ตรวจพบอาจผิดพลาด)' });
          setScanStage('done');
          return;
        }
        const { responses, studentId, layout } = readBubbles(warped, { numQuestions, numChoices, idDigits, pageW, pageH, layoutStyle });

        // Draw diagnostic overlay: mark every sampled bubble center so we can
        // visually confirm the sampling grid lines up with the printed circles.
        // Green = detected as the chosen answer, gray = read but not selected.
        const overlay = document.createElement('canvas');
        overlay.width = pageW; overlay.height = pageH;
        const octx = overlay.getContext('2d');
        octx.drawImage(warped, 0, 0);
        layout.questions.forEach((q, qi) => {
          const r = responses[qi];
          q.choices.forEach((c, ci) => {
            octx.beginPath();
            octx.arc(c.x, c.y, 3, 0, Math.PI*2);
            octx.fillStyle = (r.choice === ci) ? '#00c853' : 'rgba(255,0,0,0.55)';
            octx.fill();
          });
        });
        setDebugCanvas(overlay.toDataURL('image/png'));

        let correct = 0, blank = 0, ambiguous = 0;
        const graded = responses.map(r => {
          const key = answerKey[r.question];
          const isCorrect = key !== undefined && r.choice === key;
          if (isCorrect) correct++;
          if (r.blank) blank++;
          if (r.ambiguous) ambiguous++;
          return { ...r, correct: isCorrect, key };
        });

        setScanResult({
          studentId, graded, correct, total: numQuestions, blank, ambiguous,
          score: numQuestions ? Math.round((correct/numQuestions)*1000)/10 : 0,
        });
        setScanStage('done');
      }, 250);
    };
    img.src = scanImage;
  }

  const keyComplete = Object.keys(answerKey).length === numQuestions;

  const steps = [
    { key: 0, label: '0. เลือกวิชา', done: !!subjectId },
    { key: 1, label: '1. ตั้งค่ากระดาษคำตอบ', done: sheetReady },
    { key: 2, label: '2. กำหนดเฉลย', done: keyComplete },
    { key: 3, label: '3. สแกนตรวจ', done: !!scanResult && !scanResult.error },
  ];

  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const row = 'flex flex-wrap gap-3';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50';
  const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-gray-100';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2 py-1 rounded-md text-[11px] font-semibold hover:bg-gray-200';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';
  const pillOk = pill + ' bg-green-50 text-green-700';
  const pillBad = pill + ' bg-red-50 text-red-600';
  const pillWarn = pill + ' bg-amber-50 text-amber-700';
  const imgwrap = 'border border-gray-200 rounded-lg overflow-hidden max-w-full [&_img]:block [&_img]:w-full';
  const stat = 'text-center p-3 rounded-lg bg-gray-50 min-w-[90px]';
  const statN = 'text-2xl font-extrabold';
  const statL = 'text-[11px] text-gray-500';

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-1">ระบบ OMR — สร้างและตรวจกระดาษคำตอบอัตโนมัติ</h1>
      <div className="text-sm text-gray-500 mb-5">เลือกวิชา → ออกแบบฟอร์ม → กำหนดเฉลย → สแกนตรวจ → บันทึกผลนักเรียน</div>

      <div className="flex gap-1 mb-5 border-b border-gray-200 overflow-x-auto" role="tablist">
        {steps.map(s => (
          <button
            key={s.key} type="button" role="tab" aria-selected={activeStep === s.key}
            className={
              "px-3.5 py-2.5 text-sm font-semibold whitespace-nowrap border-b-2 -mb-px transition-colors " +
              (activeStep === s.key ? 'text-indigo-600 border-indigo-600' : 'text-gray-500 border-transparent hover:text-gray-700')
            }
            onClick={() => setActiveStep(s.key)}
          >
            {s.done && <span className="text-green-600 mr-1">✓</span>}{s.label}
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
                <option key={s.id} value={s.id}>{s.subject_code} {s.subject_name} ({s.grade_level}/{s.room})</option>
              ))}
            </select>
          </div>
          {subjectId && (
            <div className={field}>
              <label className={label}>ชุดข้อสอบที่มีอยู่แล้ว</label>
              <select className={inputCls} value={quizId || ''} onChange={e => handleLoadQuiz(e.target.value)} disabled={loadingQuiz}>
                <option value="">— สร้างชุดใหม่ —</option>
                {existingQuizzes.map(q => (
                  <option key={q.id} value={q.id}>{q.title} ({q.num_questions} ข้อ)</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {!subjectId && subjects.length === 0 && (
          <div className="text-xs text-amber-700 mt-2.5">⚠ ไม่พบวิชาของบัญชีนี้ — กรุณาสร้างวิชาในระบบก่อน</div>
        )}
        {loadQuizError && <div className="text-xs text-red-600 mt-2.5">{loadQuizError}</div>}
        {quizId && <div className="mt-2.5"><span className={pillOk}>โหลด/บันทึกชุดข้อสอบแล้ว ({quizId.slice(0, 8)}…)</span></div>}
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
          <div className={field}>
            <label className={label}>หลักรหัสนักเรียน</label>
            <select className={inputCls} value={idDigits} onChange={e=>setIdDigits(+e.target.value)}>
              {[3,4,5].map(n => <option key={n} value={n}>{n} หลัก</option>)}
            </select>
          </div>
        </div>
        <div className="mt-4 flex gap-5 flex-wrap">
          <div>
            <div className={imgwrap} style={{width: 340}}>
              <canvas ref={sheetCanvasRef} className="w-full"/>
            </div>
            <div className="flex gap-2 mt-2.5 flex-wrap">
              <button className={btn} onClick={downloadSheetTopBottomA4}>📄 ดาวน์โหลด PDF (A4 บน-ล่าง = 2 ชุด)</button>
              <button className={btnSecondary} onClick={downloadSheetPNG}>ดาวน์โหลด PNG</button>
            </div>
            <div className="text-[11px] text-amber-700 mt-1.5">⚠ ใช้ไฟล์ PDF สำหรับสั่งพิมพ์ เพราะกำหนดขนาด A4 จริงไว้แน่นอน ไฟล์ PNG อาจพิมพ์ออกมาขนาดผิดเพี้ยนขึ้นอยู่กับโปรแกรมที่ใช้เปิด</div>
            <div className="text-[11px] text-gray-500 mt-1">พิมพ์ออกมาจะได้ A4 1 แผ่น มีกระดาษคำตอบ 2 ชุดวางซ้อนกันบน-ล่าง (210×148.5mm ต่อชุด) รูปแบบรหัสนักเรียนเป็นแนวนอน ฝนบรรทัดละ 1 หลัก มีเส้นประให้ตัดแบ่งตรงกลาง แต่ละชุดมีจุดมุม 4 จุดครบในตัวเอง สแกนแยกได้อิสระหลังตัด</div>
          </div>
          <div className="flex-1 min-w-[280px]">
            <div className="text-sm text-gray-500 leading-relaxed">
              กระดาษคำตอบมี<strong>สี่เหลี่ยมทึบดำ 4 มุม (fiducial markers)</strong> ใช้สำหรับให้ระบบสแกนหาตำแหน่งกระดาษและปรับมุมมองภาพให้ตรง แม้ถ่ายรูปเอียงหรือหมุนเล็กน้อยก็ยังตรวจได้แม่นยำ
              <br/><br/>
              เมื่อพิมพ์จริง: ต้องเห็นมุมทั้ง 4 ชัดเจนในภาพถ่ายเสมอ ห้ามตัดขอบหรือบังมุมกระดาษ
            </div>
          </div>
        </div>
        <div className="flex justify-between mt-4">
          <button className={btnSecondary} onClick={() => setActiveStep(0)}>← ก่อนหน้า</button>
          <button className={btnSecondary} onClick={() => setActiveStep(2)}>ถัดไป →</button>
        </div>
      </div>

      {/* Step 2: Answer key */}
      <div className={card} style={{ display: activeStep === 2 ? 'block' : 'none' }}>
        <h2 className="text-base font-semibold mb-3">2. กำหนดเฉลย {keyComplete ? <span className={pillOk}>ครบแล้ว</span> : <span className={pillWarn}>{Object.keys(answerKey).length}/{numQuestions} ข้อ</span>}</h2>
        <div className="grid gap-1 mt-2" style={{gridTemplateColumns: numQuestions > 20 ? '1fr 1fr' : '1fr'}}>
          {Array.from({length: numQuestions}).map((_, qi) => (
            <div className="flex items-center gap-2 text-sm py-0.5" key={qi}>
              <span className="w-7 text-gray-500 tabular-nums">{String(qi+1).padStart(2,'0')}</span>
              {letters.map((L, ci) => (
                <button
                  key={ci}
                  className={
                    "w-7 h-7 rounded-full border-[1.5px] text-xs font-bold " +
                    (answerKey[qi]===ci ? 'bg-gray-900 text-white border-gray-900' : 'bg-white border-gray-300 hover:border-gray-400')
                  }
                  onClick={()=>setKeyFor(qi, ci)}
                >{L}</button>
              ))}
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2.5 flex-wrap">
          {quizId ? (
            <span className={pillOk}>บันทึกเฉลยแล้ว — หากต้องการแก้ไข ให้เลือก &ldquo;สร้างชุดใหม่&rdquo; แล้วบันทึกเป็นชุดข้อสอบใหม่แทน</span>
          ) : (
            <button
              className={btn}
              onClick={handleSaveAnswerKey}
              disabled={!subjectId || !keyComplete || savingQuiz}
              title={!subjectId ? 'เลือกวิชาก่อน' : (!keyComplete ? 'กำหนดเฉลยให้ครบก่อน' : '')}
            >
              {savingQuiz ? 'กำลังบันทึก...' : '💾 บันทึกเฉลยไปยังฐานข้อมูล'}
            </button>
          )}
          {saveQuizError && <span className="text-xs text-red-600">{saveQuizError}</span>}
        </div>
        <div className="flex justify-between mt-4">
          <button className={btnSecondary} onClick={() => setActiveStep(1)}>← ก่อนหน้า</button>
          <button className={btnSecondary} onClick={() => setActiveStep(3)}>ถัดไป →</button>
        </div>
      </div>

      {/* Step 3: Scan */}
      <div className={card} style={{ display: activeStep === 3 ? 'block' : 'none' }}>
        <h2 className="text-base font-semibold mb-3">3. ทดสอบสแกนตรวจ</h2>
        {quizId && (
          <div className={field + ' mb-3 max-w-xs'}>
            <label className={label}>นักเรียนเจ้าของกระดาษคำตอบนี้</label>
            <select className={inputCls} value={studentId} onChange={e => setStudentId(e.target.value)}>
              <option value="">— เลือกนักเรียน —</option>
              {students.map(st => (
                <option key={st.id} value={st.id}>{st.student_code} {st.prefix}{st.student_name}</option>
              ))}
            </select>
          </div>
        )}
        <div className={row + ' mb-3'}>
          <button className={btn} onClick={openCamera} disabled={!keyComplete} title={!keyComplete? 'กำหนดเฉลยให้ครบก่อน':''}>
            📷 เปิดกล้องถ่ายกระดาษคำตอบ
          </button>
          <button className={btnSecondary} onClick={generateSimulatedScan} disabled={!keyComplete} title={!keyComplete? 'กำหนดเฉลยให้ครบก่อน':''}>
            🎲 จำลองรูปถ่ายกระดาษคำตอบ
          </button>
          <button className={btnSecondary} onClick={()=>fileInputRef.current.click()}>📤 อัปโหลดรูปถ่ายจริง</button>
          <input type="file" accept="image/*" ref={fileInputRef} className="hidden" onChange={handleFileUpload}/>
          {scanImage && <button className={btnSecondary} onClick={runScan} disabled={!keyComplete || scanStage==='processing'}>
            {scanStage==='processing' ? 'กำลังตรวจ...' : '▶ เริ่มตรวจ'}
          </button>}
        </div>
        {!keyComplete && <div className="text-xs text-amber-700 mb-3">⚠ กรุณากำหนดเฉลยให้ครบทุกข้อก่อนทดสอบสแกน</div>}
        {cameraError && <div className="text-xs text-red-600 mb-3">{cameraError}</div>}

        {cameraOpen && (
          <div className="mb-4">
            <div className="relative max-w-[480px] rounded-lg overflow-hidden border border-gray-200 bg-black">
              <video ref={videoRef} playsInline muted className="w-full block"/>
            </div>
            <div className="flex gap-2 mt-2.5">
              <button className={btn} onClick={capturePhoto}>📸 ถ่ายภาพ</button>
              <button className={btnSecondary} onClick={closeCamera}>ยกเลิก</button>
            </div>
            <div className="text-[11px] text-gray-500 mt-1.5">จัดกระดาษให้เห็นจุดดำทึบทั้ง 4 มุมชัดเจนในเฟรม แล้วกดถ่ายภาพ — ภาพจะถูกประมวลผลในเครื่องทันที ไม่มีการอัปโหลดไปที่ใดๆ</div>
          </div>
        )}

        {scanImage && (
          <div className={row + ' items-start'}>
            <div className="w-[260px]">
              <div className="text-xs font-bold mb-1.5 text-gray-500">ภาพถ่ายต้นฉบับ</div>
              <div className={imgwrap}><img src={originalAnnotated || scanImage} alt="ภาพถ่ายกระดาษคำตอบ" /></div>
              {originalAnnotated && <div className="text-[11px] text-gray-500 mt-1">วงกลมเขียว = ตำแหน่งมุมที่ตรวจพบ (ควรอยู่ตรงกลางสี่เหลี่ยมดำพอดี)</div>}
            </div>
            {debugCanvas && (
              <div className="w-[260px]">
                <div className="text-xs font-bold mb-1.5 text-gray-500">หลังปรับมุมมอง (warped)</div>
                <div className={imgwrap}><img src={debugCanvas} alt="ภาพหลังปรับมุมมอง" /></div>
              </div>
            )}
            <div className="flex-1 min-w-[280px]">
              {scanResult && scanResult.error && (
                <div className={pillBad + ' px-3 py-2 text-sm'}>{scanResult.error}</div>
              )}
              {scanResult && !scanResult.error && (
                <div>
                  <div className={row + ' mb-4'}>
                    <div className={stat}><div className={statN}>{scanResult.score}%</div><div className={statL}>คะแนน</div></div>
                    <div className={stat}><div className={statN}>{scanResult.correct}/{scanResult.total}</div><div className={statL}>ถูก</div></div>
                    <div className={stat}><div className={statN}>{scanResult.blank}</div><div className={statL}>ไม่ตอบ</div></div>
                    <div className={stat}><div className={statN}>{scanResult.ambiguous}</div><div className={statL}>ฝนไม่ชัด</div></div>
                  </div>
                  <div className="text-sm mb-2.5">รหัสนักเรียนที่อ่านได้: <strong>{scanResult.studentId}</strong>
                    {scanImage && simId && <span className="text-gray-500"> (จำลองจาก: {simId})</span>}
                  </div>
                  <div className="max-h-[260px] overflow-y-auto border border-gray-100 rounded-lg px-2.5 py-1.5">
                    {scanResult.graded.map(g => (
                      <div key={g.question} className="flex justify-between text-xs py-1 border-b border-gray-100 last:border-b-0">
                        <span>ข้อ {g.question+1}</span>
                        <span>
                          ตอบ: {g.blank ? '—' : letters[g.choice]}{' '}
                          เฉลย: {letters[g.key]}{' '}
                          {g.correct ? <span className={pillOk}>ถูก</span> : <span className={pillBad}>ผิด</span>}
                          {g.ambiguous && <span className={pillWarn + ' ml-1'}>ไม่ชัด</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3.5 flex items-center gap-2.5 flex-wrap">
                    {savedResultId ? (
                      <span className={pillOk}>บันทึกผลของนักเรียนแล้ว</span>
                    ) : (
                      <button
                        className={btn}
                        onClick={handleSaveScanResult}
                        disabled={!quizId || !studentId || savingResult}
                        title={!quizId ? 'บันทึกเฉลยลงฐานข้อมูลก่อน' : (!studentId ? 'เลือกนักเรียนก่อน' : '')}
                      >
                        {savingResult ? 'กำลังบันทึก...' : '💾 บันทึกผลนักเรียนคนนี้'}
                      </button>
                    )}
                    {saveResultError && <span className="text-xs text-red-600">{saveResultError}</span>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {quizId && (
          <div className="mt-5 border-t border-gray-100 pt-4">
            <div className="text-sm font-bold mb-2">
              ผลที่บันทึกแล้วของชุดข้อสอบนี้ {loadingRoster && <span className="font-normal text-gray-500">(กำลังโหลด...)</span>}
            </div>
            {roster.length === 0 ? (
              <div className="text-xs text-gray-500">ยังไม่มีผลที่บันทึก</div>
            ) : (
              <div className="max-h-60 overflow-y-auto">
                {roster.map(r => (
                  <div key={r.id} className="flex justify-between items-center text-xs py-1.5 border-b border-gray-100 last:border-b-0">
                    <span>{r.students?.student_code} {r.students?.prefix}{r.students?.student_name}</span>
                    <span className="flex items-center gap-2">
                      <span>{r.total_correct}/{numQuestions} ({r.score}%)</span>
                      <button className={btnTiny} onClick={() => handleDeleteResult(r.id)}>ลบ</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-between mt-4">
          <button className={btnSecondary} onClick={() => setActiveStep(2)}>← ก่อนหน้า</button>
          <span />
        </div>
      </div>

      <div className={card + ' text-sm text-gray-500 leading-relaxed'}>
        <h2 className="text-base font-semibold mb-3 text-gray-900">วิธีทำงานของระบบ (สรุป)</h2>
        1. ตรวจจับจุดดำ 4 มุม (fiducial markers) ด้วย Otsu thresholding แยกพื้นที่มืด/สว่าง<br/>
        2. คำนวณ homography transform จาก 4 จุดที่พบ → ปรับภาพให้ตรงเป็นสี่เหลี่ยมมาตรฐาน (คล้ายการ &ldquo;แปลงมุมกล้อง&rdquo; ให้เหมือนสแกนตรงๆ)<br/>
        3. อ่านความเข้มสีในแต่ละวงกลมคำตอบ (fill ratio) เทียบกับพื้นหลัง เพื่อตัดสินว่าฝนช่องไหน<br/>
        4. เทียบคำตอบที่อ่านได้กับเฉลยที่ครูกำหนดไว้ → คำนวณคะแนน<br/><br/>
        <strong className="text-gray-700">ข้อจำกัดของ demo นี้:</strong> เป็นการประมวลผลฝั่งเบราว์เซอร์แบบพื้นฐาน ยังไม่รองรับกระดาษที่ยับ/แสงเงาไม่สม่ำเสมอมาก หรือมุมกล้องเอียงมากๆ — ระบบจริงอาจต้องปรับ threshold แบบ adaptive และเพิ่มการตรวจสอบคุณภาพภาพก่อนประมวลผล
      </div>
    </div>
  );
}

