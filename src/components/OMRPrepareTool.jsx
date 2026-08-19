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
import { jsPDF } from 'jspdf';
import { TOP_BOTTOM_PAGE_W, TOP_BOTTOM_PAGE_H, HALF_LANDSCAPE_PAGE_W, HALF_LANDSCAPE_PAGE_H, drawSheet, choiceLetters } from '../lib/omr-core';
import { supabase } from '../lib/supabaseClient';
import { createQuiz, getQuizWithAnswerKey, listQuizzesForSubject, listScanResultsForQuiz, deleteScanResult, getScanPhotoUrl } from '../lib/omr-db';

export default function OMRPrepareTool() {
  const [numQuestions, setNumQuestions] = useState(20);
  const [numChoices, setNumChoices] = useState(4);
  const [idDigits, setIdDigits] = useState(5);
  const [scheme, setScheme] = useState('thai');
  const [title, setTitle] = useState('แบบทดสอบวิทยาศาสตร์ ม.1');
  const [subject, setSubject] = useState('บทที่ 3 พลังงาน');
  // Paper layout: 'topBottom' (A4 cut top/bottom into two landscape halves —
  // the current default, saved quizzes assume this) or 'half' (A4 turned
  // landscape, then cut left/right into two 148.5x210mm portrait-shaped
  // halves — still taller than wide, so it sits naturally in a phone's
  // portrait camera when scanning, but shorter/wider than a plain portrait
  // A4 half would be; EXPERIMENTAL PREVIEW ONLY for now, see the note in
  // Step 1). forceCols3 packs the 'half' layout's questions into 3 columns
  // (e.g. 60 questions as 3x20) instead of the automatic 1-2.
  const [paperLayout, setPaperLayout] = useState('topBottom');
  const [forceCols3, setForceCols3] = useState(false);
  const pageW = paperLayout === 'half' ? HALF_LANDSCAPE_PAGE_W : TOP_BOTTOM_PAGE_W;
  const pageH = paperLayout === 'half' ? HALF_LANDSCAPE_PAGE_H : TOP_BOTTOM_PAGE_H;
  const layoutStyle = paperLayout === 'half' ? 'halfLandscape' : 'topBottom';
  const cols = paperLayout === 'half' && forceCols3 ? 3 : undefined;

  const [answerKey, setAnswerKey] = useState({});
  const [bulkPoints, setBulkPoints] = useState(1);
  const sheetCanvasRef = useRef(null);
  const [sheetReady, setSheetReady] = useState(false);

  const letters = choiceLetters(scheme, numChoices);
  const [fontReady, setFontReady] = useState(false);

  const [activeStep, setActiveStep] = useState(0);

  // --- Supabase-backed quiz/subject state ---
  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [quizId, setQuizId] = useState(null);
  const [savingQuiz, setSavingQuiz] = useState(false);
  const [saveQuizError, setSaveQuizError] = useState(null);

  const [existingQuizzes, setExistingQuizzes] = useState([]);
  const [loadingQuiz, setLoadingQuiz] = useState(false);
  const [loadQuizError, setLoadQuizError] = useState(null);

  const [roster, setRoster] = useState([]);
  const [loadingRoster, setLoadingRoster] = useState(false);

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

  // When a subject is picked: load its existing quizzes.
  useEffect(() => {
    (async () => {
      setQuizId(null);
      setRoster([]);
      if (!subjectId) { setExistingQuizzes([]); return; }
      try {
        setExistingQuizzes(await listQuizzesForSubject(supabase, subjectId));
      } catch {
        setExistingQuizzes([]);
      }
    })();
  }, [subjectId]);

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

  async function handleDeleteResult(id, photoPath) {
    await deleteScanResult(supabase, id, photoPath);
    refreshRoster(quizId);
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
    drawSheet(sheetCanvasRef.current, { title, subject, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle, cols }, null);
    setSheetReady(true);
  }, [title, subject, numQuestions, numChoices, idDigits, scheme, pageW, pageH, layoutStyle, cols, fontReady]);

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

  function downloadSheetTopBottomA4() {
    // A4 portrait cut horizontally (top/bottom) into two full-width halves,
    // each 210mm wide x 148.5mm tall, stacked with a dashed cut line between
    // them. Each half keeps its own full set of 4 fiducial markers and
    // horizontal-row ID grid, so after cutting, each half is a complete,
    // independently scannable sheet.
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const imgData = canvas.toDataURL('image/png');
    const halfH = 148.5; // 297mm / 2
    pdf.addImage(imgData, 'PNG', 0, 0, 210, halfH);
    pdf.addImage(imgData, 'PNG', 0, halfH, 210, halfH);
    pdf.setLineDash([2, 2], 0);
    pdf.setDrawColor(150, 150, 150);
    pdf.line(0, halfH, 210, halfH);
    pdf.save('answer-sheet-a4-top-bottom-x2.pdf');
  }

  function downloadSheetHalfA4() {
    // A4 turned landscape, then cut left-right into two independent
    // portrait-shaped halves, each 148.5mm wide x 210mm tall, with a dashed
    // cut line between them. Each half keeps its own full set of 4
    // fiducial markers, so after cutting, each half is a complete,
    // independently scannable sheet — still taller than wide (sits
    // naturally in a phone's portrait camera frame), just shorter/wider
    // than a plain portrait-A4 half would be.
    const canvas = sheetCanvasRef.current;
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const imgData = canvas.toDataURL('image/png');
    const halfW = 148.5; // 297mm / 2
    pdf.addImage(imgData, 'PNG', 0, 0, halfW, 210);
    pdf.addImage(imgData, 'PNG', halfW, 0, halfW, 210);
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
          <div className={field}>
            <label className={label}>รูปแบบกระดาษ</label>
            <select className={inputCls} value={paperLayout} onChange={e=>setPaperLayout(e.target.value)}>
              <option value="topBottom">บน-ล่าง (แนวนอน) = 2 ชุด</option>
              <option value="half">ซ้าย-ขวา (จากกระดาษแนวนอน) = 2 ชุด</option>
            </select>
          </div>
          {paperLayout === 'half' && (
            <label className={field + ' justify-end'} style={{ paddingBottom: 8 }}>
              <span className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={forceCols3} onChange={e => setForceCols3(e.target.checked)} />
                แบ่ง 3 คอลัมน์ (สำหรับ 60 ข้อ)
              </span>
            </label>
          )}
        </div>
        {paperLayout === 'half' && (
          <div className="text-xs text-amber-700 mt-2 mb-1">
            ⚠ ทดลอง: รูปแบบนี้ยังใช้ได้แค่ดูตัวอย่าง/พิมพ์เท่านั้น หน้าสแกนตรวจยังอ่านได้เฉพาะแบบ &ldquo;บน-ล่าง&rdquo; — ถ้าชอบแบบนี้แล้วต้องการใช้จริง แจ้งได้เลย จะเชื่อมให้หน้าสแกนอ่านแบบนี้ได้ด้วย
          </div>
        )}
        <div className="mt-4 flex gap-5 flex-wrap">
          <div>
            <div className={imgwrap} style={{width: paperLayout === 'half' ? 240 : 340}}>
              <canvas ref={sheetCanvasRef} className="w-full"/>
            </div>
            <div className="flex gap-2 mt-2.5 flex-wrap">
              {paperLayout === 'half' ? (
                <button className={btn} onClick={downloadSheetHalfA4}>📄 ดาวน์โหลด PDF (A4 แนวนอน ซ้าย-ขวา = 2 ชุด)</button>
              ) : (
                <button className={btn} onClick={downloadSheetTopBottomA4}>📄 ดาวน์โหลด PDF (A4 บน-ล่าง = 2 ชุด)</button>
              )}
              <button className={btnSecondary} onClick={downloadSheetPNG}>ดาวน์โหลด PNG</button>
            </div>
            <div className="text-[11px] text-amber-700 mt-1.5">⚠ ใช้ไฟล์ PDF สำหรับสั่งพิมพ์ เพราะกำหนดขนาด A4 จริงไว้แน่นอน ไฟล์ PNG อาจพิมพ์ออกมาขนาดผิดเพี้ยนขึ้นอยู่กับโปรแกรมที่ใช้เปิด</div>
            {paperLayout === 'half' ? (
              <div className="text-[11px] text-gray-500 mt-1">พิมพ์จากกระดาษ A4 แนวนอน 1 แผ่น ตัดซ้าย-ขวาได้กระดาษคำตอบ 2 ชุด (148.5×210mm ต่อชุด ยังเป็นทรงตั้งอยู่) เหมาะกับการถ่ายด้วยกล้องมือถือแนวตั้ง มีเส้นประให้ตัดแบ่งตรงกลาง แต่ละชุดมีจุดมุม 4 จุดครบในตัวเอง สแกนแยกได้อิสระหลังตัด</div>
            ) : (
              <div className="text-[11px] text-gray-500 mt-1">พิมพ์ออกมาจะได้ A4 1 แผ่น มีกระดาษคำตอบ 2 ชุดวางซ้อนกันบน-ล่าง (210×148.5mm ต่อชุด) รูปแบบรหัสนักเรียนเป็นแนวนอน ฝนบรรทัดละ 1 หลัก มีเส้นประให้ตัดแบ่งตรงกลาง แต่ละชุดมีจุดมุม 4 จุดครบในตัวเอง สแกนแยกได้อิสระหลังตัด</div>
            )}
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
        <div className="grid gap-1.5 mt-2" style={{gridTemplateColumns: numQuestions > 20 ? '1fr 1fr' : '1fr'}}>
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
        {quizId && (
          <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50 p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm text-indigo-900">พร้อมสอบแล้ว — ให้นักเรียนทำข้อสอบ แล้วมาสแกนตรวจด้วยมือถือหลังสอบเสร็จ</div>
            <a href="/omr/scan" className={btn}>📷 ไปที่หน้าสแกนตรวจ →</a>
          </div>
        )}
        <div className="flex justify-between mt-4">
          <button className={btnSecondary} onClick={() => setActiveStep(1)}>← ก่อนหน้า</button>
          <span />
        </div>
      </div>

      {quizId && (
        <div className={card}>
          <h2 className="text-base font-semibold mb-3">
            ผลที่สแกนแล้วของชุดข้อสอบนี้ {loadingRoster && <span className="font-normal text-gray-500">(กำลังโหลด...)</span>}
          </h2>
          {roster.length === 0 ? (
            <div className="text-sm text-gray-500">ยังไม่มีนักเรียนถูกสแกน</div>
          ) : (
            <div className="max-h-60 overflow-y-auto">
              {roster.map(r => (
                <div key={r.id} className="flex justify-between items-center text-sm py-1.5 border-b border-gray-100 last:border-b-0">
                  <span>{r.students?.student_code} {r.students?.prefix}{r.students?.student_name}</span>
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
    </div>
  );
}
