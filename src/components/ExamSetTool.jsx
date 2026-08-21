'use client';
// ExamSetTool.jsx — "ข้อสอบ": teacher assembles a reusable ชุดข้อสอบ (exam
// set) by picking a subject, then checking which of that subject's saved
// bank questions to include and in what order. A ชุดข้อสอบ holds no
// schedule/PIN of its own — that's "จัดสอบ" (ExamScheduleTool), which
// schedules one or more รอบสอบ against a set built here.

import { useCallback, useEffect, useState } from 'react';
import Swal from 'sweetalert2';
import { supabase } from '../lib/supabaseClient';
import { listMySubjects, listMyBankQuestions } from '../lib/bank-db';
import { listMyExamSets, getExamSetWithQuestions, saveExamSet, deleteExamSet, syncPrintedOmrQuiz, copyExamSetToSubject } from '../lib/exam-db';
import { generateExamQuestionPaperPdf } from '../lib/exam-print';
import { getConfigValue } from '../lib/config-db';
import ConfirmDialog from './ConfirmDialog';

function defaultInstructions(numQuestions, totalScore) {
  return [
    `1. ข้อสอบแบบปรนัย ${numQuestions} ข้อ ${totalScore} คะแนน`,
    '2. ห้ามนำข้อสอบออกจากห้องสอบโดยเด็ดขาด หากมีข้อสงสัยควรสอบถามกรรมการคุมห้องสอบ',
    '3. เมื่อทำข้อสอบเสร็จแล้ว ส่งข้อสอบคืนที่กรรมการคุมห้องสอบ',
  ].join('\n');
}

// Print-time letterhead editor — lets a teacher tweak the school name, exam
// title, subject code, score/time, คำชี้แจง rules, column count, and
// whether to include the admin's logo (Settings → ชื่อระบบ/โลโก้) before
// generating this specific ชุดข้อสอบ's PDF. Fully controlled by ExamSetTool;
// re-seeds its local form state from `initial` every time it opens.
function PrintOptionsDialog({ open, initial, onCancel, onConfirm, submitting }) {
  const [form, setForm] = useState(initial);
  useEffect(() => { if (open) setForm(initial); }, [open, initial]);

  if (!open) return null;

  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
  const labelCls = 'text-xs font-semibold text-gray-500';
  const fieldCls = 'flex flex-col gap-1';

  function update(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-5">
        <div className="font-semibold text-gray-900 mb-1">ตั้งค่าหัวกระดาษก่อนพิมพ์</div>
        <p className="text-xs text-gray-500 mb-4">ปรับข้อมูลหัวกระดาษของข้อสอบชุดนี้ได้ตามต้องการ — ใช้ครั้งนี้ครั้งเดียว ไม่กระทบชุดข้อสอบอื่น</p>

        <div className="space-y-3">
          <div className={fieldCls}>
            <label className={labelCls}>ชื่อโรงเรียน/หน่วยงาน</label>
            <input type="text" className={inputCls} value={form.schoolName} onChange={e => update('schoolName', e.target.value)} placeholder="เช่น โรงเรียนตาเบาวิทยา อำเภอปราสาท จังหวัดสุรินทร์" />
          </div>
          <div className={fieldCls}>
            <label className={labelCls}>ชื่อการสอบ</label>
            <input type="text" className={inputCls} value={form.examTitle} onChange={e => update('examTitle', e.target.value)} placeholder="เช่น แบบทดสอบวัดผลปลายภาคเรียนที่ 1" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label className={labelCls}>รหัสวิชา</label>
              <input type="text" className={inputCls} value={form.subjectCode} onChange={e => update('subjectCode', e.target.value)} />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>คะแนนเต็ม</label>
              <input type="number" min={0} className={inputCls} value={form.totalScore} onChange={e => update('totalScore', e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className={fieldCls}>
              <label className={labelCls}>เวลา (นาที)</label>
              <input type="number" min={0} className={inputCls} value={form.durationMinutes} onChange={e => update('durationMinutes', e.target.value)} placeholder="ไม่บังคับ" />
            </div>
            <div className={fieldCls}>
              <label className={labelCls}>จำนวนคอลัมน์</label>
              <select className={inputCls} value={form.columns} onChange={e => update('columns', Number(e.target.value))}>
                <option value={2}>2 คอลัมน์</option>
                <option value={1}>1 คอลัมน์</option>
              </select>
            </div>
          </div>
          <div className={fieldCls}>
            <label className={labelCls}>คำชี้แจง (บรรทัดละ 1 ข้อ)</label>
            <textarea className={inputCls + ' min-h-24'} value={form.instructionsText} onChange={e => update('instructionsText', e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.includeLogo} disabled={!form.hasLogo} onChange={e => update('includeLogo', e.target.checked)} />
            แสดงโลโก้ที่แอดมินอัพโหลดไว้ในหน้าตั้งค่า
            {!form.hasLogo && <span className="text-xs text-gray-400 ml-1">(ยังไม่มีโลโก้ — ไปอัพโหลดที่หน้าตั้งค่าก่อน)</span>}
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="bg-gray-100 text-gray-900 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-200 disabled:opacity-50" onClick={onCancel} disabled={submitting}>ยกเลิก</button>
          <button
            type="button"
            className="bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 disabled:opacity-50"
            onClick={() => onConfirm(form)}
            disabled={submitting}
          >
            {submitting ? 'กำลังสร้าง PDF...' : 'พิมพ์ข้อสอบ (A4)'}
          </button>
        </div>
      </div>
    </div>
  );
}

// "คัดลอกไปอีกห้อง" — a ชุดข้อสอบ (and the bank questions it's built from)
// belongs to one subject, which is itself scoped to one ห้อง, and a รอบสอบ
// only admits students from that same ห้อง — so the same PIN/ชุดข้อสอบ
// can't directly serve two rooms. This picks a different subject (another
// ห้อง teaching the same course) to copy the whole set into, with no
// retyping — see copyExamSetToSubject.
function CopyExamSetDialog({ open, initial, subjectOptions, onCancel, onConfirm, submitting }) {
  const [form, setForm] = useState(initial);
  useEffect(() => { if (open) setForm(initial); }, [open, initial]);

  if (!open) return null;

  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm w-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
  const labelCls = 'text-xs font-semibold text-gray-500';
  const fieldCls = 'flex flex-col gap-1';

  function update(key, value) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
        <div className="font-semibold text-gray-900 mb-1">คัดลอกชุดข้อสอบไปอีกห้อง</div>
        <p className="text-xs text-gray-500 mb-4">
          คัดลอกข้อสอบทุกข้อในชุดนี้ไปที่วิชา/ห้องที่เลือก โดยไม่ต้องพิมพ์ใหม่ — ชุดต้นทางไม่มีการเปลี่ยนแปลง
        </p>

        <div className="space-y-3">
          <div className={fieldCls}>
            <label className={labelCls}>วิชา/ห้องปลายทาง</label>
            <select className={inputCls} value={form.targetSubjectId} onChange={e => update('targetSubjectId', e.target.value)}>
              <option value="">— เลือกวิชา/ห้อง —</option>
              {subjectOptions.map(s => (
                <option key={s.id} value={s.id}>{s.subject_name} (ชั้น {s.grade_level}/{s.room})</option>
              ))}
            </select>
            {subjectOptions.length === 0 && (
              <div className="text-xs text-amber-600 mt-0.5">ยังไม่มีวิชาอื่นให้เลือกคัดลอกไป</div>
            )}
          </div>
          <div className={fieldCls}>
            <label className={labelCls}>ชื่อชุดข้อสอบใหม่</label>
            <input type="text" className={inputCls} value={form.title} onChange={e => update('title', e.target.value)} />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="bg-gray-100 text-gray-900 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-200 disabled:opacity-50" onClick={onCancel} disabled={submitting}>ยกเลิก</button>
          <button
            type="button"
            className="bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2 rounded-lg text-sm font-bold hover:opacity-90 disabled:opacity-50"
            onClick={() => onConfirm(form)}
            disabled={submitting || !form.targetSubjectId || !form.title.trim()}
          >
            {submitting ? 'กำลังคัดลอก...' : 'คัดลอกชุดข้อสอบ'}
          </button>
        </div>
      </div>
    </div>
  );
}

const SOURCE_LABEL = { ai: 'AI สร้าง', manual: 'ครูสร้างเอง' };
const DIFFICULTY_LABEL = { easy: 'ง่าย', medium: 'ปานกลาง', hard: 'ยาก' };

function SheetIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
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

function SaveIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M8 4v5h8V4M8 14h8v6H8z" />
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

function ArrowUpIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function ArrowDownIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

function XIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function PrinterIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 9V3h12v6" />
      <rect x="4" y="9" width="16" height="8" rx="1.5" />
      <path d="M6 14h12v7H6z" />
    </svg>
  );
}

function CopyIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

function groupBySubject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.subjects?.subject_name} (ชั้น ${item.subjects?.grade_level}/${item.subjects?.room})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }));
}

export default function ExamSetTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const row = 'flex flex-wrap gap-3';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-90 inline-flex items-center justify-center gap-2';
  const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';

  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [title, setTitle] = useState('');
  const [availableQuestions, setAvailableQuestions] = useState([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [editingSetId, setEditingSetId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [loadingEdit, setLoadingEdit] = useState(false);

  const [examSets, setExamSets] = useState([]);
  const [setsLoading, setSetsLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [printingId, setPrintingId] = useState(null);

  // exam_app_name/exam_app_logo (Settings → ชื่อระบบ/โลโก้) — used only as
  // this dialog's starting values; the teacher can still edit or drop them
  // per print, and nothing here is written back to config.
  const [brandDefaults, setBrandDefaults] = useState({ name: '', logo: '' });
  const [printTarget, setPrintTarget] = useState(null); // full exam set (with questions) being printed, or null
  const [printForm, setPrintForm] = useState(null);
  const [printSubmitting, setPrintSubmitting] = useState(false);

  const [copyTarget, setCopyTarget] = useState(null); // the exam set (list row) being copied, or null
  const [copyForm, setCopyForm] = useState(null);
  const [copySubmitting, setCopySubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [name, logo] = await Promise.all([
          getConfigValue(supabase, 'exam_app_name'),
          getConfigValue(supabase, 'exam_app_logo'),
        ]);
        setBrandDefaults({ name: name || '', logo: logo || '' });
      } catch {
        // best-effort
      }
    })();
  }, []);

  const refreshSets = useCallback(async () => {
    setSetsLoading(true);
    try {
      setExamSets(await listMyExamSets(supabase));
    } catch {
      // best-effort
    } finally {
      setSetsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setSubjects(await listMySubjects(supabase));
      } catch {
        // best-effort
      }
    })();
    refreshSets();
  }, [refreshSets]);

  useEffect(() => {
    if (!subjectId) {
      setAvailableQuestions([]);
      return;
    }
    setQuestionsLoading(true);
    (async () => {
      try {
        setAvailableQuestions(await listMyBankQuestions(supabase, { subjectId }));
      } catch {
        setAvailableQuestions([]);
      } finally {
        setQuestionsLoading(false);
      }
    })();
  }, [subjectId]);

  function resetForm() {
    setEditingSetId(null);
    setSubjectId('');
    setTitle('');
    setSelectedIds([]);
    setFormError(null);
  }

  async function startEdit(set) {
    setLoadingEdit(true);
    setFormError(null);
    try {
      const full = await getExamSetWithQuestions(supabase, set.id);
      setEditingSetId(full.id);
      setSubjectId(full.subject_id);
      setTitle(full.title);
      setSelectedIds(full.questions.map(q => q.id));
    } catch (err) {
      setFormError(err.message || 'โหลดชุดข้อสอบไม่สำเร็จ');
    } finally {
      setLoadingEdit(false);
    }
  }

  function toggleQuestion(id) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function removeSelected(id) {
    setSelectedIds(prev => prev.filter(x => x !== id));
  }

  function moveSelected(index, dir) {
    setSelectedIds(prev => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  const questionsById = new Map(availableQuestions.map(q => [q.id, q]));
  const selectedQuestions = selectedIds.map(id => questionsById.get(id)).filter(Boolean);

  async function handleSave() {
    if (!subjectId || !title.trim() || selectedIds.length === 0) return;
    setSaving(true);
    setFormError(null);
    try {
      await saveExamSet(supabase, { id: editingSetId, subjectId, title: title.trim(), questionIds: selectedIds });
      resetForm();
      refreshSets();
    } catch (err) {
      setFormError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  // "พิมพ์ข้อสอบ (A4)": opens the letterhead editor first (school name/exam
  // title/subject code/score/time/คำชี้แจง/columns/logo), prefilled from the
  // admin's Settings branding and the ชุดข้อสอบ itself — see
  // PrintOptionsDialog. Confirming there runs the actual generation:
  // creates/updates the matching OMR quiz + answer key (pulled straight
  // from these questions' correct_choice, so the teacher never types the
  // answer key by hand for a paper exam) and downloads the PDF — see
  // exam-print.js and syncPrintedOmrQuiz.
  async function openPrintDialog(set) {
    setPrintingId(set.id);
    try {
      const full = await getExamSetWithQuestions(supabase, set.id);
      if (full.questions.length === 0) {
        Swal.fire({ icon: 'warning', title: 'ชุดข้อสอบนี้ยังไม่มีข้อสอบ', text: 'เพิ่มข้อสอบเข้าชุดก่อนพิมพ์' });
        return;
      }
      const numQuestions = full.questions.length;
      setPrintTarget(full);
      setPrintForm({
        schoolName: brandDefaults.name,
        examTitle: full.title,
        subjectCode: full.subject_code || '',
        totalScore: String(numQuestions),
        durationMinutes: '',
        instructionsText: defaultInstructions(numQuestions, numQuestions),
        columns: 2,
        hasLogo: !!brandDefaults.logo,
        includeLogo: !!brandDefaults.logo,
      });
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'โหลดชุดข้อสอบไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setPrintingId(null);
    }
  }

  async function confirmPrint(form) {
    if (!printTarget) return;
    const full = printTarget;
    setPrintSubmitting(true);
    try {
      await syncPrintedOmrQuiz(supabase, {
        examSetId: full.id,
        subjectId: full.subject_id,
        title: full.title,
        questions: full.questions,
        existingQuizId: full.printed_quiz_id,
      });
      await generateExamQuestionPaperPdf(supabase, {
        title: full.title,
        subjectName: full.subject_name,
        subjectCode: form.subjectCode,
        gradeLevel: full.grade_level,
        room: full.room,
        questions: full.questions,
        schoolName: form.schoolName.trim(),
        examTitle: form.examTitle.trim(),
        totalScore: Number(form.totalScore) || undefined,
        durationMinutes: form.durationMinutes,
        instructions: form.instructionsText.split('\n').map(s => s.trim()).filter(Boolean),
        columns: form.columns,
        logoDataUrl: form.includeLogo ? brandDefaults.logo : null,
      });
      setPrintTarget(null);
      setPrintForm(null);
      refreshSets();
      Swal.fire({
        icon: 'success', title: 'พิมพ์ข้อสอบแล้ว',
        text: 'ดาวน์โหลด PDF ข้อสอบแล้ว และตั้งเฉลยให้ในระบบตรวจข้อสอบ (OMR) ให้แล้ว — ไปที่ "กระดาษคำตอบ" เพื่อพิมพ์กระดาษคำตอบต่อได้เลย',
      });
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'พิมพ์ข้อสอบไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setPrintSubmitting(false);
    }
  }

  // "คัดลอกไปอีกห้อง": prefills the target-subject picker (every other
  // subject, so the teacher can't accidentally "copy" a set onto itself)
  // and the new set's title, defaulting to the same title as the source.
  function openCopyDialog(set) {
    setCopyTarget(set);
    setCopyForm({ targetSubjectId: '', title: set.title });
  }

  async function confirmCopy(form) {
    if (!copyTarget) return;
    setCopySubmitting(true);
    try {
      await copyExamSetToSubject(supabase, {
        examSetId: copyTarget.id,
        targetSubjectId: form.targetSubjectId,
        title: form.title.trim(),
      });
      setCopyTarget(null);
      setCopyForm(null);
      refreshSets();
      const target = subjects.find(s => s.id === form.targetSubjectId);
      Swal.fire({
        icon: 'success', title: 'คัดลอกชุดข้อสอบแล้ว',
        text: target ? `คัดลอกไปที่ ${target.subject_name} (ชั้น ${target.grade_level}/${target.room}) แล้ว — ไปตั้งรอบสอบ/PIN ของห้องนั้นต่อได้ที่ "จัดสอบ"` : undefined,
      });
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'คัดลอกชุดข้อสอบไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setCopySubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteExamSet(supabase, deleteTarget.id);
      if (editingSetId === deleteTarget.id) resetForm();
      setDeleteTarget(null);
      refreshSets();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-fuchsia-600 to-purple-500 text-white flex items-center justify-center shrink-0">
          <SheetIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ข้อสอบ</h1>
          <p className="text-sm text-gray-500">สร้างชุดข้อสอบจากคลังข้อสอบ เลือกและจัดลำดับข้อที่จะใช้สอบ</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        <div className="font-semibold text-gray-900 mb-3">{editingSetId ? 'แก้ไขชุดข้อสอบ' : 'สร้างชุดข้อสอบใหม่'}</div>
        {loadingEdit && <div className="text-sm text-gray-500 mb-3">กำลังโหลด...</div>}
        <div className={row}>
          <div className={field}>
            <label className={label}>วิชา</label>
            <select className={inputCls} value={subjectId} onChange={e => { setSubjectId(e.target.value); setSelectedIds([]); }}>
              <option value="">— เลือกวิชา —</option>
              {subjects.map(s => (
                <option key={s.id} value={s.id}>{s.subject_name} (ชั้น {s.grade_level}/{s.room})</option>
              ))}
            </select>
          </div>
          <div className={field + ' flex-1 min-w-[200px]'}>
            <label className={label}>ชื่อชุดข้อสอบ</label>
            <input
              type="text" className={inputCls} value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="เช่น สอบกลางภาค บทที่ 1-3"
            />
          </div>
        </div>

        {subjectId && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={label}>ข้อสอบในคลัง (ติ๊กเพื่อเพิ่มเข้าชุด)</label>
              {questionsLoading && <div className="text-sm text-gray-500 mt-2">กำลังโหลด...</div>}
              {!questionsLoading && availableQuestions.length === 0 && (
                <div className="text-sm text-gray-500 mt-2">วิชานี้ยังไม่มีข้อสอบในคลัง — ไปสร้างที่ &quot;คลังข้อสอบ&quot; ก่อน</div>
              )}
              {availableQuestions.length > 0 && (
                <div className="mt-1.5 max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {availableQuestions.map(q => (
                    <label key={q.id} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox" className="mt-0.5"
                        checked={selectedIds.includes(q.id)}
                        onChange={() => toggleQuestion(q.id)}
                      />
                      <span className="min-w-0">
                        <span className="text-gray-700">{q.question_text}</span>{' '}
                        <span className={pill + (q.source === 'manual' ? ' bg-purple-50 text-purple-700' : ' bg-indigo-50 text-indigo-700')}>
                          {SOURCE_LABEL[q.source] || SOURCE_LABEL.ai}
                        </span>{' '}
                        <span className={pill + ' bg-amber-50 text-amber-700'}>{DIFFICULTY_LABEL[q.difficulty] || q.difficulty}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className={label}>ลำดับข้อที่เลือก ({selectedQuestions.length} ข้อ)</label>
              {selectedQuestions.length === 0 ? (
                <div className="text-sm text-gray-500 mt-2">ยังไม่ได้เลือกข้อสอบ</div>
              ) : (
                <div className="mt-1.5 max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {selectedQuestions.map((q, i) => (
                    <div key={q.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                      <span className="text-xs font-semibold text-gray-400 shrink-0 mt-0.5">{i + 1}.</span>
                      <span className="min-w-0 flex-1 text-gray-700">{q.question_text}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button type="button" className={btnTiny} disabled={i === 0} onClick={() => moveSelected(i, -1)} aria-label="เลื่อนขึ้น">
                          <ArrowUpIcon className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" className={btnTiny} disabled={i === selectedQuestions.length - 1} onClick={() => moveSelected(i, 1)} aria-label="เลื่อนลง">
                          <ArrowDownIcon className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" className={btnTiny} onClick={() => removeSelected(q.id)} aria-label="เอาออก">
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {formError && <div className="text-sm text-red-600 mt-3">{formError}</div>}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button" className={btn}
            disabled={!subjectId || !title.trim() || selectedIds.length === 0 || saving}
            onClick={handleSave}
          >
            <SaveIcon className="h-4 w-4" /> {saving ? 'กำลังบันทึก...' : (editingSetId ? 'บันทึกการแก้ไข' : 'สร้างชุดข้อสอบ')}
          </button>
          {editingSetId && (
            <button type="button" className={btnSecondary} disabled={saving} onClick={resetForm}>ยกเลิก</button>
          )}
        </div>
      </div>

      <div className={card}>
        <div className="font-semibold text-gray-900 mb-3">ชุดข้อสอบที่สร้างไว้แล้ว</div>
        {setsLoading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {!setsLoading && examSets.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีชุดข้อสอบ</div>}
        {examSets.length > 0 && (
          <div className="space-y-4">
            {groupBySubject(examSets).map(group => (
              <div key={group.name}>
                <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">{group.name}</div>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {group.rows.map(s => (
                    <div key={s.id} className="flex justify-between items-center gap-3 text-sm px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900">{s.title}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{s.question_count} ข้อ</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button className={btnTiny} disabled={printingId === s.id} onClick={() => openPrintDialog(s)}>
                          <PrinterIcon className="h-3.5 w-3.5" /> {printingId === s.id ? 'กำลังโหลด...' : 'พิมพ์ข้อสอบ (A4)'}
                        </button>
                        <button className={btnTiny} onClick={() => openCopyDialog(s)}>
                          <CopyIcon className="h-3.5 w-3.5" /> คัดลอกไปอีกห้อง
                        </button>
                        <button className={btnTiny} onClick={() => startEdit(s)}>
                          <PencilIcon className="h-3.5 w-3.5" /> แก้ไข
                        </button>
                        <button className={btnTiny} onClick={() => setDeleteTarget(s)}>
                          <TrashIcon className="h-3.5 w-3.5" /> ลบ
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="ยืนยันลบชุดข้อสอบ"
        message={deleteTarget ? `ลบชุดข้อสอบ "${deleteTarget.title}"?\n\nรอบสอบที่ตั้งไว้จากชุดนี้จะถูกลบไปด้วย` : ''}
        confirmLabel="ลบชุดข้อสอบ"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <PrintOptionsDialog
        open={!!printTarget && !!printForm}
        initial={printForm}
        submitting={printSubmitting}
        onConfirm={confirmPrint}
        onCancel={() => { setPrintTarget(null); setPrintForm(null); }}
      />

      <CopyExamSetDialog
        open={!!copyTarget && !!copyForm}
        initial={copyForm}
        subjectOptions={subjects.filter(s => s.id !== copyTarget?.subject_id)}
        submitting={copySubmitting}
        onConfirm={confirmCopy}
        onCancel={() => { setCopyTarget(null); setCopyForm(null); }}
      />
    </div>
  );
}
