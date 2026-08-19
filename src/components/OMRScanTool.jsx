'use client';
// OMRScanTool.jsx
//
// Mobile-first scan flow for exam day: pick a quiz that was already
// prepared on a computer (OMRPrepareTool, at /omr/prepare), pick the
// student whose sheet is about to be photographed, capture/upload the
// photo, and save the graded result — repeating fast for a whole class.
//
// The student is picked from the class roster *before* scanning (not
// auto-matched from the ID bubbles the sheet decodes) so a saved result is
// always tied to a known student row, matching how lib/omr-db.js's
// omr_scan_results.student_id is modeled. The decoded ID is only shown
// alongside the result as a sanity check that the right sheet/student was
// picked.
//
// All OMR image-processing logic lives in ../lib/omr-core.js.

import { useState, useRef, useCallback, useEffect } from 'react';
import { TOP_BOTTOM_PAGE_W, TOP_BOTTOM_PAGE_H, choiceLetters, toGray, findFiducials, warpImage, readBubbles, drawGradedOverlay } from '../lib/omr-core';
import { supabase } from '../lib/supabaseClient';
import { getQuizWithAnswerKey, listMyQuizzes, saveScanResult, listScanResultsForQuiz, deleteScanResult, uploadScanPhoto, getScanPhotoUrl } from '../lib/omr-db';
import { useAuth } from '../lib/AuthContext';

const pageW = TOP_BOTTOM_PAGE_W, pageH = TOP_BOTTOM_PAGE_H;
const layoutStyle = 'topBottom';

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

export default function OMRScanTool() {
  const { session, saveScanPhotos, setSaveScanPhotos } = useAuth();
  const [quizzes, setQuizzes] = useState([]);
  const [loadingQuizzes, setLoadingQuizzes] = useState(true);
  const [quizFilter, setQuizFilter] = useState('');
  const [selectedQuiz, setSelectedQuiz] = useState(null); // full quiz + answerKey + subject grade/room
  const [quizLoadError, setQuizLoadError] = useState(null);

  const [students, setStudents] = useState([]);
  const [studentId, setStudentId] = useState('');

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

  const letters = selectedQuiz ? choiceLetters(selectedQuiz.choiceScheme, selectedQuiz.numChoices) : [];

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
  }

  function pickStudent(id) {
    setStudentId(id);
    resetScan();
  }

  function handleNextStudent() {
    setStudentId('');
    resetScan();
  }

  function runScan(imgSrc) {
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

        const warped = warpImage(srcCanvas, corners, pageW, pageH);
        if (!warped) {
          setScanResult({ error: 'คำนวณการปรับมุมมองภาพไม่สำเร็จ (มุมที่ตรวจพบอาจผิดพลาด)' });
          setScanStage('done');
          return;
        }
        const { responses, studentId: decodedId, layout } = readBubbles(warped, {
          numQuestions: selectedQuiz.numQuestions, numChoices: selectedQuiz.numChoices,
          idDigits: selectedQuiz.idDigits, pageW, pageH, layoutStyle,
        });

        let correct = 0, blank = 0, ambiguous = 0;
        const graded = responses.map(r => {
          const key = selectedQuiz.answerKey[r.question];
          const isCorrect = key !== undefined && r.choice === key;
          if (isCorrect) correct++;
          if (r.blank) blank++;
          if (r.ambiguous) ambiguous++;
          return { ...r, correct: isCorrect, key };
        });

        // Build the reviewable graded overlay now (while the warped canvas
        // and layout are on hand) so it's ready to preview and, if the
        // teacher has opted in, upload on save — see resetScan/handleSaveScanResult.
        const gradedCanvas = drawGradedOverlay(warped, { layout, graded });
        gradedCanvasRef.current = gradedCanvas;
        setGradedImageUrl(gradedCanvas.toDataURL('image/png'));

        setScanResult({
          decodedId, graded, correct, total: selectedQuiz.numQuestions, blank, ambiguous,
          score: selectedQuiz.numQuestions ? Math.round((correct / selectedQuiz.numQuestions) * 1000) / 10 : 0,
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
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
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
    if (!selectedQuiz || !studentId || !scanResult || scanResult.error) return;
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
        quizId: selectedQuiz.id, studentId, responses, totalCorrect: scanResult.correct, score: scanResult.score,
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
  const filteredQuizzes = quizzes.filter(q => {
    if (!quizFilter.trim()) return true;
    const hay = `${q.title} ${q.subjects?.subject_name || ''} ${q.subjects?.subject_code || ''}`.toLowerCase();
    return hay.includes(quizFilter.trim().toLowerCase());
  });

  // --- Screen 1: pick a prepared quiz ---
  if (!selectedQuiz) {
    return (
      <div className="max-w-lg mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">สแกนตรวจ</h1>
        <div className="text-sm text-gray-500 mb-4">เลือกชุดข้อสอบที่เตรียมไว้แล้วเพื่อเริ่มสแกน</div>

        <button
          type="button"
          onClick={() => setSaveScanPhotos(!saveScanPhotos)}
          className={card + ' w-full flex items-center justify-between gap-3 text-left cursor-pointer select-none'}
        >
          <span>
            <span className="block text-sm font-semibold text-gray-900">🖼️ เก็บรูปกระดาษคำตอบไว้ดูย้อนหลัง</span>
            <span className="block text-xs text-gray-500 mt-0.5">บันทึกรูปที่ตรวจแล้ว (พร้อมทำเครื่องหมายถูก/ผิด) ไว้เปิดดูภายหลัง</span>
          </span>
          <span
            role="switch" aria-checked={saveScanPhotos}
            className={"relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors " + (saveScanPhotos ? 'bg-indigo-600' : 'bg-gray-300')}
          >
            <span className={"inline-block h-4 w-4 transform rounded-full bg-white transition-transform " + (saveScanPhotos ? 'translate-x-6' : 'translate-x-1')} />
          </span>
        </button>

        <input
          type="text" placeholder="ค้นหาชุดข้อสอบ / วิชา..." value={quizFilter}
          onChange={e => setQuizFilter(e.target.value)}
          className="w-full px-3 py-3 border border-gray-300 rounded-lg text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
        />

        {loadingQuizzes && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {quizLoadError && <div className="text-sm text-red-600 mb-3">{quizLoadError}</div>}
        {!loadingQuizzes && filteredQuizzes.length === 0 && (
          <div className="text-sm text-gray-500">
            ยังไม่มีชุดข้อสอบที่เตรียมไว้ — ไปที่หน้า <a href="/omr/prepare" className="text-indigo-600 font-semibold">เตรียมข้อสอบ</a> ก่อน
          </div>
        )}
        <div className="space-y-2">
          {filteredQuizzes.map(q => (
            <button
              key={q.id}
              onClick={() => handleSelectQuiz(q)}
              className="w-full text-left bg-white border border-gray-200 rounded-xl p-4 hover:border-indigo-300 hover:shadow-sm transition"
            >
              <div className="font-semibold text-gray-900">{q.title}</div>
              <div className="text-sm text-gray-500 mt-0.5">
                {q.subjects?.subject_name} ({q.subjects?.grade_level}/{q.subjects?.room}) · {q.num_questions} ข้อ
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // --- Screen 2: pick a student ---
  if (!studentId) {
    return (
      <div className="max-w-lg mx-auto">
        <QuizHeader quiz={selectedQuiz} onChangeQuiz={handleChangeQuiz} scannedCount={roster.length} totalCount={students.length} />
        <h2 className="text-base font-semibold mb-3 mt-4">เลือกนักเรียนเจ้าของกระดาษคำตอบ</h2>
        {students.length === 0 ? (
          <div className="text-sm text-gray-500">ไม่พบนักเรียนของวิชานี้ ({selectedQuiz.gradeLevel}/{selectedQuiz.room})</div>
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
                  <span className="text-sm font-medium text-gray-900">{st.student_code} {st.prefix}{st.student_name}</span>
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
    <div className="max-w-lg mx-auto">
      <QuizHeader quiz={selectedQuiz} onChangeQuiz={handleChangeQuiz} scannedCount={roster.length} totalCount={students.length} />

      <div className={card + ' mt-4'}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-gray-500">นักเรียน</div>
          <button className="text-xs font-semibold text-indigo-600" onClick={() => setStudentId('')}>เปลี่ยนนักเรียน</button>
        </div>
        <div className="font-semibold text-gray-900 mb-4">{selectedStudent?.student_code} {selectedStudent?.prefix}{selectedStudent?.student_name}</div>

        {!scanImage && (
          <div className="flex flex-col gap-2">
            <button className={btn + ' py-4 text-base'} onClick={openCamera}>📷 ถ่ายภาพกระดาษคำตอบ</button>
            <button className={btnSecondary} onClick={() => fileInputRef.current.click()}>📤 อัปโหลดรูปถ่าย</button>
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
              <button className={btn + ' flex-1'} onClick={capturePhoto}>📸 ถ่ายภาพ</button>
              <button className={btnSecondary} onClick={closeCamera}>ยกเลิก</button>
            </div>
            <div className="text-[11px] text-gray-500 mt-1.5">จัดกระดาษให้เห็นจุดดำทึบทั้ง 4 มุมชัดเจนในเฟรม แล้วกดถ่ายภาพ</div>
          </div>
        )}

        {scanImage && (
          <div className="mt-2">
            <div className={imgwrap + ' max-w-[220px] mb-3'}>
              <img src={gradedImageUrl || scanImage} alt="ภาพกระดาษคำตอบ" />
            </div>

            {scanStage === 'processing' && <div className="text-sm text-gray-500">กำลังตรวจ...</div>}

            {scanResult && scanResult.error && (
              <div>
                <div className={pillBad + ' px-3 py-2 text-sm block mb-3'}>{scanResult.error}</div>
                <button className={btnSecondary} onClick={resetScan}>↺ ถ่ายใหม่</button>
              </div>
            )}

            {scanResult && !scanResult.error && (
              <div>
                <div className="grid grid-cols-4 gap-2 mb-3">
                  <div className={stat}><div className={statN}>{scanResult.score}%</div><div className={statL}>คะแนน</div></div>
                  <div className={stat}><div className={statN}>{scanResult.correct}/{scanResult.total}</div><div className={statL}>ถูก</div></div>
                  <div className={stat}><div className={statN}>{scanResult.blank}</div><div className={statL}>ไม่ตอบ</div></div>
                  <div className={stat}><div className={statN}>{scanResult.ambiguous}</div><div className={statL}>ไม่ชัด</div></div>
                </div>
                <div className="text-xs text-gray-500 mb-3">
                  รหัสที่อ่านได้จากกระดาษ: <strong className="text-gray-700">{scanResult.decodedId}</strong> — ตรวจสอบว่าตรงกับนักเรียนที่เลือกไว้
                </div>

                {savedResultId ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={pillOk}>บันทึกแล้ว</span>
                    <button className={btn} onClick={handleNextStudent}>➡ ถ่ายคนถัดไป</button>
                  </div>
                ) : (
                  <div className="flex gap-2 flex-wrap">
                    <button className={btn} onClick={handleSaveScanResult} disabled={savingResult}>
                      {savingResult ? 'กำลังบันทึก...' : '💾 บันทึกผล'}
                    </button>
                    <button className={btnSecondary} onClick={resetScan}>↺ ถ่ายใหม่</button>
                  </div>
                )}
                {saveResultError && <div className="text-xs text-red-600 mt-2">{saveResultError}</div>}
              </div>
            )}
          </div>
        )}
      </div>

      <div className={card}>
        <div className="text-sm font-bold mb-2">
          สแกนแล้ว {roster.length}/{students.length} คน {loadingRoster && <span className="font-normal text-gray-500">(กำลังโหลด...)</span>}
        </div>
        {roster.length > 0 && (
          <div className="max-h-52 overflow-y-auto">
            {roster.map(r => (
              <div key={r.id} className="flex justify-between items-center text-xs py-1.5 border-b border-gray-100 last:border-b-0">
                <span>{r.students?.student_code} {r.students?.prefix}{r.students?.student_name}</span>
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

function QuizHeader({ quiz, onChangeQuiz, scannedCount, totalCount }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-white border border-gray-200 rounded-xl p-3">
      <div className="min-w-0">
        <div className="font-semibold text-gray-900 truncate">{quiz.title}</div>
        <div className="text-xs text-gray-500">{quiz.subjectName} ({quiz.gradeLevel}/{quiz.room}) · สแกนแล้ว {scannedCount}/{totalCount}</div>
      </div>
      <button className="text-xs font-semibold text-indigo-600 shrink-0" onClick={onChangeQuiz}>เปลี่ยนชุดข้อสอบ</button>
    </div>
  );
}
