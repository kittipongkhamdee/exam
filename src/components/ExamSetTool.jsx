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
import { listMyExamSets, getExamSetWithQuestions, saveExamSet, deleteExamSet, syncPrintedOmrQuiz, copyExamSetToSubject, getBankQuestionQualityStats, examSetHasSubmittedAttempts } from '../lib/exam-db';
import { generateExamQuestionPaperPdf } from '../lib/exam-print';
import { generateExamQuestionPaperDocx } from '../lib/exam-docx';
import { getConfigValues } from '../lib/config-db';
import { formatGradeRoom } from '../lib/format';
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

  // `form` only picks up `initial` via the effect above, which runs AFTER
  // the render that first flips `open` true — on that one render, `form`
  // is still whatever it was at this (already-mounted) component's last
  // render, i.e. null the very first time this dialog opens each session.
  // Guarding on `!form` too (not just `!open`) skips that single render
  // instead of crashing on `form.schoolName` with form still null.
  if (!open || !form) return null;

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
            <label className={labelCls}>รูปแบบไฟล์</label>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="printFormat" checked={form.format !== 'docx'} onChange={() => update('format', 'pdf')} />
                PDF (พิมพ์ได้ทันที)
              </label>
              <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                <input type="radio" name="printFormat" checked={form.format === 'docx'} onChange={() => update('format', 'docx')} />
                Word (.docx — แก้ไขต่อได้)
              </label>
            </div>
          </div>
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
            {submitting
              ? (form.format === 'docx' ? 'กำลังสร้างไฟล์ Word...' : 'กำลังสร้าง PDF...')
              : (form.format === 'docx' ? 'ดาวน์โหลด Word (.docx)' : 'พิมพ์ข้อสอบ (A4)')}
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

  // Same race as PrintOptionsDialog above -- form syncs via an effect that
  // runs after the render where `open` first flips true, so it can still
  // be null on that render; guard on it too, not just `open`.
  if (!open || !form) return null;

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
                <option key={s.id} value={s.id}>{s.subject_name} (ชั้น {formatGradeRoom(s.grade_level, s.room)})</option>
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

// Same automatic 1-5 star rating shown on คลังข้อสอบ (BankTool.jsx) —
// duplicated here rather than shared/exported since every Tool component
// in this app keeps its own small presentational pieces local.
function StarRating({ stars }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`${stars}/5 ดาว จากค่าความยาก/อำนาจจำแนกที่วัดได้จริง`}>
      {Array.from({ length: 5 }, (_, i) => (
        <svg key={i} viewBox="0 0 24 24" className={'h-3.5 w-3.5 ' + (i < stars ? 'fill-amber-400' : 'fill-gray-200')}>
          <path d="M12 2.5l2.9 6.2 6.8.7-5.1 4.6 1.5 6.7L12 17.3l-6.1 3.4 1.5-6.7-5.1-4.6 6.8-.7L12 2.5z" />
        </svg>
      ))}
    </span>
  );
}

function matchesStarFilter(stars, filter) {
  if (!filter) return true;
  if (filter === 'none') return stars === null || stars === undefined;
  if (stars === null || stars === undefined) return false;
  if (filter === '5') return stars === 5;
  if (filter === '4+') return stars >= 4;
  if (filter === '3+') return stars >= 3;
  return true;
}

function groupBySubject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.subjects?.subject_name} (ชั้น ${formatGradeRoom(item.subjects?.grade_level, item.subjects?.room)})`;
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
  const btnTinyIndigo = 'bg-indigo-50 text-indigo-700 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-indigo-100 transition inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed';
  const btnTinySky = 'bg-sky-50 text-sky-700 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-sky-100 transition inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed';
  const btnTinyAmber = 'bg-amber-50 text-amber-700 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-amber-100 transition inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed';
  const btnTinyRed = 'bg-red-50 text-red-600 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-red-100 transition inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';

  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  const [title, setTitle] = useState('');
  const [availableQuestions, setAvailableQuestions] = useState([]);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [qualityStats, setQualityStats] = useState({});
  const [filterDifficulty, setFilterDifficulty] = useState('');
  const [filterIndicatorId, setFilterIndicatorId] = useState('');
  const [filterStars, setFilterStars] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [pointsById, setPointsById] = useState({}); // { [bank_question_id]: points }
  // 'manual' keeps selectedIds' own order (drag/up-down, unchanged
  // behavior); 'indicator' derives print/display order by grouping
  // selectedQuestions by indicator_id instead — see groupedByIndicator
  // below. Only the derived order is ever persisted (in handleSave); this
  // never mutates selectedIds itself.
  const [sortMode, setSortMode] = useState('manual');
  const [bulkPoints, setBulkPoints] = useState(1);
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

  // Rooms teaching the same subject_code as the selected วิชา, offered as
  // an optional "also create for these rooms" checklist when creating a
  // brand-new ชุดข้อสอบ (not when editing one — an existing set stays
  // scoped to its own subject). Ticking any of these runs the exact same
  // copyExamSetToSubject the standalone "คัดลอกไปอีกห้อง" button uses, just
  // looped once per ticked room right after the primary set is saved,
  // instead of requiring that button pressed once per room afterward.
  const [targetRoomIds, setTargetRoomIds] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await getConfigValues(supabase, ['exam_app_name', 'exam_app_logo']);
        setBrandDefaults({ name: cfg.exam_app_name || '', logo: cfg.exam_app_logo || '' });
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
    setFilterDifficulty('');
    setFilterIndicatorId('');
    setFilterStars('');
    if (!subjectId) {
      setAvailableQuestions([]);
      setQualityStats({});
      return;
    }
    setQuestionsLoading(true);
    (async () => {
      try {
        const list = await listMyBankQuestions(supabase, { subjectId });
        setAvailableQuestions(list);
        // Best-effort and independent of the question list itself — a slow
        // or failed stats query should never block picking questions, it
        // just means the star badges/filter stay off for this refresh.
        getBankQuestionQualityStats(supabase, list.map(q => q.id))
          .then(setQualityStats)
          .catch(() => {});
      } catch {
        setAvailableQuestions([]);
        setQualityStats({});
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
    setPointsById({});
    setSortMode('manual');
    setFormError(null);
    setTargetRoomIds([]);
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
      setPointsById(Object.fromEntries(full.questions.map(q => [q.id, q.points ?? 1])));
      setSortMode(full.group_by_indicator ? 'indicator' : 'manual');
      // Best-effort — never block opening the edit form over this check.
      examSetHasSubmittedAttempts(supabase, full.id).then(hasAttempts => {
        if (hasAttempts) {
          Swal.fire({
            icon: 'warning',
            title: 'ชุดข้อสอบนี้มีนักเรียนส่งข้อสอบแล้ว',
            text: 'การแก้ไขข้อ/คะแนนของชุดข้อสอบนี้จะไม่กระทบคะแนนที่ตรวจไปแล้ว แต่รายงานวิเคราะห์ข้อสอบ (Item Analysis) ของรอบที่สอบไปแล้วอาจแสดงผลไม่ตรงกับข้อที่นักเรียนทำจริงอีกต่อไป',
            confirmButtonText: 'เข้าใจแล้ว',
            confirmButtonColor: '#4f46e5',
          });
        }
      }).catch(() => {});
    } catch (err) {
      setFormError(err.message || 'โหลดชุดข้อสอบไม่สำเร็จ');
    } finally {
      setLoadingEdit(false);
    }
  }

  function toggleQuestion(id) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    setPointsById(prev => (prev[id] !== undefined ? prev : { ...prev, [id]: 1 }));
  }

  function toggleSelectAllQuestions() {
    const allSelected = filteredQuestions.length > 0 && filteredQuestions.every(q => selectedIds.includes(q.id));
    if (allSelected) {
      setSelectedIds(prev => prev.filter(id => !filteredQuestions.some(q => q.id === id)));
    } else {
      setSelectedIds(prev => [...new Set([...prev, ...filteredQuestions.map(q => q.id)])]);
      setPointsById(prev => {
        const next = { ...prev };
        for (const q of filteredQuestions) if (next[q.id] === undefined) next[q.id] = 1;
        return next;
      });
    }
  }

  function updatePoints(id, value) {
    const n = Math.max(0.01, Number(value) || 1);
    setPointsById(prev => ({ ...prev, [id]: n }));
  }

  function applyPointsToAll(rawValue) {
    const points = Math.max(0.01, Number(rawValue) || 1);
    setPointsById(prev => {
      const next = { ...prev };
      for (const id of selectedIds) next[id] = points;
      return next;
    });
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
  const totalPoints = selectedIds.reduce((sum, id) => sum + (pointsById[id] ?? 1), 0);

  const selectedSubject = subjects.find(s => s.id === subjectId) || null;
  // Only offer rooms that share the selected subject's own subject_code —
  // a subject row with no code set (legacy data) matches nothing, since
  // there's no reliable signal it's "the same course" otherwise.
  const sameCodeRooms = selectedSubject?.subject_code
    ? subjects.filter(s => s.id !== subjectId && s.subject_code === selectedSubject.subject_code)
    : [];
  const allTargetRoomsSelected = sameCodeRooms.length > 0 && sameCodeRooms.every(s => targetRoomIds.includes(s.id));

  function toggleTargetRoom(id) {
    setTargetRoomIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleAllTargetRooms() {
    setTargetRoomIds(allTargetRoomsSelected ? [] : sameCodeRooms.map(s => s.id));
  }

  // Groups selectedQuestions by indicator_id — sorted by indicator_code, a
  // trailing "ไม่มีตัวชี้วัด" group last for anything with none — without
  // touching selectedIds itself. Used both to render the grouped list (sort
  // mode 'indicator') and, in handleSave, to derive the seq order actually
  // persisted when that mode is active.
  function groupedByIndicator(questions) {
    const groups = new Map(); // indicator_id (or null) -> { code, text, rows }
    for (const q of questions) {
      const key = q.indicator_id ?? null;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          code: key != null ? q.indicators?.indicator_code : 'ไม่มีตัวชี้วัด',
          text: key != null ? q.indicators?.indicator_text : 'ข้อที่ยังไม่ได้ผูกตัวชี้วัด/ผลการเรียนรู้ไว้ในคลัง',
          rows: [],
        });
      }
      groups.get(key).rows.push(q);
    }
    const sorted = [...groups.values()].sort((a, b) => {
      if (a.key == null) return 1;
      if (b.key == null) return -1;
      return (a.code || '').localeCompare(b.code || '');
    });
    return sorted;
  }

  const indicatorGroups = sortMode === 'indicator' ? groupedByIndicator(selectedQuestions) : [];

  // Indicator/ผลการเรียนรู้ dropdown options: only what's actually attached
  // to at least one question in this subject's bank, so the filter never
  // offers a choice that would empty the list.
  const indicatorOptions = [...new Map(
    availableQuestions.filter(q => q.indicator_id && q.indicators).map(q => [q.indicator_id, q.indicators])
  ).entries()]
    .map(([id, ind]) => ({ id, ...ind }))
    .sort((a, b) => (a.indicator_code || '').localeCompare(b.indicator_code || ''));

  const filteredQuestions = availableQuestions.filter(q =>
    (!filterDifficulty || q.difficulty === filterDifficulty) &&
    // filterIndicatorId comes off a <select>'s DOM value, always a string,
    // while q.indicator_id is the numeric bigint Supabase returns — a bare
    // === here never matched, silently emptying the list on any indicator
    // filter pick.
    (!filterIndicatorId || String(q.indicator_id) === filterIndicatorId) &&
    matchesStarFilter(qualityStats[q.id]?.stars ?? null, filterStars)
  );
  const allQuestionsSelected = filteredQuestions.length > 0 && filteredQuestions.every(q => selectedIds.includes(q.id));

  async function handleSave() {
    if (!subjectId || !title.trim() || selectedIds.length === 0) return;
    setSaving(true);
    setFormError(null);
    try {
      const orderedIds = sortMode === 'indicator'
        ? groupedByIndicator(selectedQuestions).flatMap(g => g.rows.map(q => q.id))
        : selectedIds;
      const newSetId = await saveExamSet(supabase, {
        id: editingSetId, subjectId, title: title.trim(),
        questions: orderedIds.map(id => ({ id, points: pointsById[id] ?? 1 })),
        groupByIndicator: sortMode === 'indicator',
      });

      // Sequential, not Promise.all — target-room counts are small (a
      // handful at most) and this way one failure doesn't abort the rest,
      // it just gets counted and reported after the loop.
      let copyFailures = 0;
      if (!editingSetId) {
        for (const targetSubjectId of targetRoomIds) {
          try {
            await copyExamSetToSubject(supabase, { examSetId: newSetId, targetSubjectId, title: title.trim() });
          } catch {
            copyFailures++;
          }
        }
      }

      resetForm();
      refreshSets();
      if (copyFailures > 0) {
        Swal.fire({
          icon: 'warning', title: 'สร้างชุดข้อสอบสำเร็จบางส่วน',
          text: `สร้างชุดข้อสอบหลักสำเร็จ แต่คัดลอกไปห้องอื่นไม่สำเร็จ ${copyFailures} ห้อง — ลองคัดลอกด้วยปุ่ม "คัดลอกไปอีกห้อง" ที่รายการชุดข้อสอบด้านล่างได้`,
        });
      }
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
      const totalScore = full.questions.reduce((sum, q) => sum + (q.points ?? 1), 0);
      setPrintTarget(full);
      setPrintForm({
        format: 'pdf',
        schoolName: brandDefaults.name,
        examTitle: full.title,
        subjectCode: full.subject_code || '',
        totalScore: String(totalScore),
        durationMinutes: '',
        instructionsText: defaultInstructions(numQuestions, totalScore),
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
        setCode: full.set_code,
      });
      const genArgs = {
        title: full.title,
        setCode: full.set_code,
        subjectName: full.subject_name,
        subjectCode: form.subjectCode,
        gradeLevel: full.grade_level,
        questions: full.questions,
        groupByIndicator: full.group_by_indicator,
        schoolName: form.schoolName.trim(),
        examTitle: form.examTitle.trim(),
        totalScore: Number(form.totalScore) || undefined,
        durationMinutes: form.durationMinutes,
        instructions: form.instructionsText.split('\n').map(s => s.trim()).filter(Boolean),
        columns: form.columns,
        logoDataUrl: form.includeLogo ? brandDefaults.logo : null,
      };
      if (form.format === 'docx') {
        await generateExamQuestionPaperDocx(supabase, genArgs);
      } else {
        await generateExamQuestionPaperPdf(supabase, genArgs);
      }
      setPrintTarget(null);
      setPrintForm(null);
      refreshSets();
      Swal.fire({
        icon: 'success',
        title: form.format === 'docx' ? 'ดาวน์โหลดไฟล์ Word แล้ว' : 'พิมพ์ข้อสอบแล้ว',
        text: form.format === 'docx'
          ? 'ดาวน์โหลดไฟล์ .docx แล้ว และตั้งเฉลยให้ในระบบตรวจข้อสอบ (OMR) ให้แล้ว — ไปที่ "กระดาษคำตอบ" เพื่อพิมพ์กระดาษคำตอบต่อได้เลย'
          : 'ดาวน์โหลด PDF ข้อสอบแล้ว และตั้งเฉลยให้ในระบบตรวจข้อสอบ (OMR) ให้แล้ว — ไปที่ "กระดาษคำตอบ" เพื่อพิมพ์กระดาษคำตอบต่อได้เลย',
      });
    } catch (err) {
      Swal.fire({
        icon: 'error',
        title: form.format === 'docx' ? 'สร้างไฟล์ Word ไม่สำเร็จ' : 'พิมพ์ข้อสอบไม่สำเร็จ',
        text: err.message || 'กรุณาลองใหม่อีกครั้ง',
      });
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
        text: target ? `คัดลอกไปที่ ${target.subject_name} (ชั้น ${formatGradeRoom(target.grade_level, target.room)}) แล้ว — ไปตั้งรอบสอบ/PIN ของห้องนั้นต่อได้ที่ "จัดสอบ"` : undefined,
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
    <div className="max-w-7xl">
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
            <select className={inputCls} value={subjectId} onChange={e => { setSubjectId(e.target.value); setSelectedIds([]); setTargetRoomIds([]); }}>
              <option value="">— เลือกวิชา —</option>
              {subjects.map(s => (
                <option key={s.id} value={s.id}>{s.subject_name} (ชั้น {formatGradeRoom(s.grade_level, s.room)})</option>
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

        {subjectId && !editingSetId && sameCodeRooms.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <label className={label}>สร้างให้ห้องอื่นด้วย (ไม่บังคับ)</label>
              <button type="button" className={btnTiny} onClick={toggleAllTargetRooms}>
                {allTargetRoomsSelected ? 'ยกเลิกทั้งหมด' : 'เลือกทั้งหมด'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {sameCodeRooms.map(s => (
                <label key={s.id} className="inline-flex items-center gap-1.5 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                  <input type="checkbox" checked={targetRoomIds.includes(s.id)} onChange={() => toggleTargetRoom(s.id)} />
                  ชั้น {formatGradeRoom(s.grade_level, s.room)}
                </label>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-1.5">
              คัดลอกข้อที่เลือกไปสร้างเป็นชุดข้อสอบแยกให้แต่ละห้องที่ติ๊กไว้ด้วย (เหมือนปุ่ม &ldquo;คัดลอกไปอีกห้อง&rdquo; แต่ทำให้พร้อมกันตอนสร้าง)
            </p>
          </div>
        )}

        {subjectId && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-7">
            <div>
              <div className="flex items-center justify-between">
                <label className={label}>ข้อสอบในคลัง (ติ๊กเพื่อเพิ่มเข้าชุด)</label>
                {availableQuestions.length > 0 && (
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 cursor-pointer">
                    <input type="checkbox" checked={allQuestionsSelected} onChange={toggleSelectAllQuestions} />
                    เลือกทั้งหมด
                  </label>
                )}
              </div>
              {questionsLoading && <div className="text-sm text-gray-500 mt-2">กำลังโหลด...</div>}
              {!questionsLoading && availableQuestions.length === 0 && (
                <div className="text-sm text-gray-500 mt-2">วิชานี้ยังไม่มีข้อสอบในคลัง — ไปสร้างที่ &quot;คลังข้อสอบ&quot; ก่อน</div>
              )}
              {availableQuestions.length > 0 && (
                <>
                  <div className="flex flex-wrap gap-2 mt-2 mb-1.5">
                    <select
                      className={inputCls + ' text-xs py-1.5'}
                      value={filterDifficulty}
                      onChange={e => setFilterDifficulty(e.target.value)}
                    >
                      <option value="">ระดับความยาก: ทั้งหมด</option>
                      {Object.entries(DIFFICULTY_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {indicatorOptions.length > 0 && (
                      <select
                        className={inputCls + ' text-xs py-1.5 max-w-[180px]'}
                        value={filterIndicatorId}
                        onChange={e => setFilterIndicatorId(e.target.value)}
                      >
                        <option value="">ตัวชี้วัด/ผลการเรียนรู้: ทั้งหมด</option>
                        {indicatorOptions.map(ind => (
                          <option key={ind.id} value={ind.id}>{ind.indicator_code}</option>
                        ))}
                      </select>
                    )}
                    <select
                      className={inputCls + ' text-xs py-1.5'}
                      value={filterStars}
                      onChange={e => setFilterStars(e.target.value)}
                    >
                      <option value="">ดาวคะแนน: ทั้งหมด</option>
                      <option value="5">5 ดาว</option>
                      <option value="4+">4 ดาวขึ้นไป</option>
                      <option value="3+">3 ดาวขึ้นไป</option>
                      <option value="none">ยังไม่มีข้อมูล</option>
                    </select>
                  </div>
                  {filteredQuestions.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-2">ไม่มีข้อสอบที่ตรงกับตัวกรองที่เลือก</div>
                  ) : (
                    <div className="mt-1.5 max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {filteredQuestions.map(q => (
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
                            {qualityStats[q.id]?.stars != null && (
                              <>{' '}<StarRating stars={qualityStats[q.id].stars} /></>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <label className={label}>ลำดับข้อที่เลือก</label>
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-indigo-600 text-white text-sm font-bold shadow-sm">
                    {selectedQuestions.length} ข้อ
                    <span className="opacity-60">·</span>
                    รวม {totalPoints} คะแนน
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-gray-400">เรียงตาม</span>
                  <div className="flex gap-1 bg-gray-100 p-0.5 rounded-full">
                    <button
                      type="button"
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${sortMode === 'manual' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-200'}`}
                      onClick={() => setSortMode('manual')}
                    >
                      ลำดับที่เลือก
                    </button>
                    <button
                      type="button"
                      className={`px-3 py-1 rounded-full text-xs font-semibold ${sortMode === 'indicator' ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-200'}`}
                      onClick={() => setSortMode('indicator')}
                    >
                      ตัวชี้วัด/ผลการเรียนรู้
                    </button>
                  </div>
                </div>
              </div>
              {sortMode === 'indicator' && (
                <div className="text-[11px] text-gray-400 italic mt-1">
                  จัดกลุ่มข้อสอบตามตัวชี้วัด/ผลการเรียนรู้ให้อัตโนมัติ — ในโหมดนี้จะลากสลับลำดับข้อไม่ได้ (ยังลบข้อออกได้ตามปกติ) และจะพิมพ์หัวข้อตัวชี้วัดไว้บนกระดาษคำถามด้วย
                </div>
              )}
              {selectedQuestions.length > 0 && (
                <div className="flex items-center gap-2 mt-3 mb-3 flex-wrap bg-gray-50 rounded-lg px-3 py-2.5">
                  <label className="text-xs font-semibold text-gray-500">กำหนดคะแนนเท่ากันทุกข้อ</label>
                  <input
                    type="number" min="0.01" step="any" value={bulkPoints}
                    onChange={e => setBulkPoints(e.target.value)}
                    className="w-16 px-1.5 py-1 border border-gray-300 rounded text-xs text-center"
                  />
                  <button type="button" className={btnTiny} onClick={() => applyPointsToAll(bulkPoints)}>ใช้กับทุกข้อ</button>
                </div>
              )}
              {selectedQuestions.length === 0 ? (
                <div className="text-sm text-gray-500 mt-2">ยังไม่ได้เลือกข้อสอบ</div>
              ) : sortMode === 'indicator' ? (
                <div className="mt-1.5 max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {(() => {
                    let n = 0;
                    return indicatorGroups.map(g => (
                      <div key={g.key ?? 'none'}>
                        <div className={`flex items-baseline gap-2 px-3.5 py-2 ${g.key == null ? 'bg-gray-50' : 'bg-indigo-50'}`}>
                          <span className={pill + (g.key == null ? ' bg-gray-200 text-gray-600 font-mono' : ' bg-indigo-600 text-white font-mono') + ' whitespace-nowrap shrink-0'}>{g.code}</span>
                          <span className={`text-xs ${g.key == null ? 'text-gray-400' : 'text-indigo-700'}`}>{g.text}</span>
                        </div>
                        {g.rows.map(q => {
                          const i = n++;
                          return (
                            <div key={q.id} className="flex items-start justify-between gap-3.5 px-3.5 py-3.5 text-sm">
                              <div className="flex items-start gap-2.5 min-w-0">
                                <span className="text-xs font-semibold text-gray-400 shrink-0 mt-0.5">{i + 1}.</span>
                                <span className="min-w-0 text-gray-700">{q.question_text}</span>
                              </div>
                              <div className="flex flex-col items-end gap-1.5 shrink-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs text-gray-500">คะแนน</span>
                                  <input
                                    type="number" min={0.01} step="any"
                                    className="w-14 px-1.5 py-1 border border-gray-300 rounded text-xs text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                                    value={pointsById[q.id] ?? 1}
                                    onChange={e => updatePoints(q.id, e.target.value)}
                                    aria-label={`คะแนนข้อ ${i + 1}`}
                                  />
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <button type="button" className={btnTiny} disabled aria-label="เลื่อนขึ้น">
                                    <ArrowUpIcon className="h-3.5 w-3.5" />
                                  </button>
                                  <button type="button" className={btnTiny} disabled aria-label="เลื่อนลง">
                                    <ArrowDownIcon className="h-3.5 w-3.5" />
                                  </button>
                                  <button type="button" className={btnTiny} onClick={() => removeSelected(q.id)} aria-label="เอาออก">
                                    <XIcon className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
              ) : (
                <div className="mt-1.5 max-h-72 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {selectedQuestions.map((q, i) => (
                    <div key={q.id} className="flex items-start justify-between gap-3.5 px-3.5 py-3.5 text-sm">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className="text-xs font-semibold text-gray-400 shrink-0 mt-0.5">{i + 1}.</span>
                        <span className="min-w-0 text-gray-700">{q.question_text}</span>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-500">คะแนน</span>
                          <input
                            type="number" min={0.01} step="any"
                            className="w-14 px-1.5 py-1 border border-gray-300 rounded text-xs text-right focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                            value={pointsById[q.id] ?? 1}
                            onChange={e => updatePoints(q.id, e.target.value)}
                            aria-label={`คะแนนข้อ ${i + 1}`}
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
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
            <SaveIcon className="h-4 w-4" /> {saving
              ? 'กำลังบันทึก...'
              : editingSetId
                ? 'บันทึกการแก้ไข'
                : targetRoomIds.length > 0 ? `สร้างชุดข้อสอบ (${targetRoomIds.length + 1} ห้อง)` : 'สร้างชุดข้อสอบ'}
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
                <div className="flex items-center gap-2 mb-2">
                  <span className="shrink-0 h-6 w-6 rounded-md bg-indigo-100 text-indigo-600 flex items-center justify-center">
                    <SheetIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="text-sm font-bold text-gray-800">{group.name}</div>
                </div>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {group.rows.map(s => (
                    <div key={s.id} className="flex flex-wrap justify-between items-center gap-3 text-sm px-3 py-2.5">
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
                          {s.title}
                          <span className={pill + ' bg-slate-100 text-slate-700 font-mono'}>รหัส {String(s.set_code).padStart(3, '0')}</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">{s.question_count} ข้อ</div>
                        {s.printed_out_of_sync && (
                          <div className="text-xs text-amber-700 mt-0.5">⚠ แก้ไขชุดข้อสอบหลังพิมพ์ครั้งล่าสุด — กด &ldquo;พิมพ์ข้อสอบ (A4)&rdquo; อีกครั้งเพื่ออัปเดตกระดาษคำตอบ (OMR) ให้ตรงกัน</div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-wrap max-w-full shrink-0">
                        <button className={btnTinyIndigo} disabled={printingId === s.id} onClick={() => openPrintDialog(s)}>
                          <PrinterIcon className="h-3.5 w-3.5" /> {printingId === s.id ? 'กำลังโหลด...' : 'พิมพ์ข้อสอบ (A4)'}
                        </button>
                        <button className={btnTinySky} onClick={() => openCopyDialog(s)}>
                          <CopyIcon className="h-3.5 w-3.5" /> คัดลอกไปอีกห้อง
                        </button>
                        <button className={btnTinyAmber} onClick={() => startEdit(s)}>
                          <PencilIcon className="h-3.5 w-3.5" /> แก้ไข
                        </button>
                        <button className={btnTinyRed} onClick={() => setDeleteTarget(s)}>
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
