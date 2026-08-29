'use client';
// BankTool.jsx
//
// AI-assisted question bank: pick a subject, pick one or more core-
// curriculum indicators (or type a free topic for subjects the reference
// table doesn't cover), pick difficulty/choice count/how many questions,
// then call /api/generate-questions (the only place that touches the
// server-side Gemini key) to get an editable draft. The teacher reviews
// and can edit every field before saving into bank_questions.
//
// Below the generator sits a browse/delete list of everything already
// saved to the bank, grouped by subject.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { listMySubjects, listIndicatorsForSubject, listEvalPlanUnitsForSubject, listMyBankQuestions, saveBankQuestions, updateBankQuestion, deleteBankQuestion, uploadBankQuestionImage, getBankQuestionImageUrl, deleteBankQuestionImage } from '../lib/bank-db';
import { getBankQuestionQualityStats } from '../lib/exam-db';
import { downloadBankQuestionTemplate, parseBankQuestionCsv } from '../lib/bank-import';
import { formatGradeRoom } from '../lib/format';
import ConfirmDialog from './ConfirmDialog';

const DIFFICULTIES = [
  { value: 'easy', label: 'ง่าย' },
  { value: 'medium', label: 'ปานกลาง' },
  { value: 'hard', label: 'ยาก' },
];

const KINDS = [
  { value: '', label: 'ทั้งหมด' },
  { value: 'ระหว่างทาง', label: 'ระหว่างทาง' },
  { value: 'ปลายทาง', label: 'ปลายทาง' },
];

// Optional cognitive-level hints for the AI generator (ประเภทข้อสอบ) — none
// selected means "let the AI decide", same as before this existed.
const COGNITIVE_TYPES = [
  { value: 'comprehension', label: 'ความเข้าใจ (Comprehension)' },
  { value: 'application', label: 'การนำไปใช้ (Application)' },
  { value: 'analysis', label: 'การวิเคราะห์ (Analysis)' },
  { value: 'synthesis', label: 'การสังเคราะห์ (Synthesis)' },
  { value: 'evaluation', label: 'การประเมินค่า (Evaluation)' },
];

function SparkleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}

function BankIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" />
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

function ChevronDownIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function SearchIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
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

function ImageIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
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

function UploadIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
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

const SOURCE_LABEL = { ai: 'AI สร้าง', manual: 'ครูสร้างเอง' };

// 1-5 star rating computed automatically from the question's pooled
// difficulty/discrimination across every รอบสอบ it's been used in (see
// getBankQuestionQualityStats/starRatingFromStats) — nothing here is
// teacher-editable, it just visualizes the number the backend computed.
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

function useExpandedGroups() {
  const [expanded, setExpanded] = useState(new Set());
  const toggle = (name) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return [expanded, toggle];
}

function groupBySubject(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.subjects?.subject_name} (ชั้น ${formatGradeRoom(item.subjects?.grade_level, item.subjects?.room)})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()]
    .map(([name, rows]) => ({ name, rows }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th', { numeric: true }));
}

// Image upload/preview/remove control shown only on manual (source:
// 'manual') questions — AI can't draw an accurate diagram, so AI-generated
// drafts and saved rows never render this. Uploads straight into the
// private bank-question-images bucket as soon as a file is picked, so the
// draft/edit state only ever holds the storage path plus a signed preview
// URL, never a raw blob waiting to be saved. This control itself never
// deletes the *previous* path from storage — the caller decides that via
// onChange, since for an already-saved question the previous path is still
// what the DB row points to until a save (or cancel) actually resolves it.
function ImagePicker({ userId, path, url, onChange, uploading, setUploading }) {
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1';

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const newPath = await uploadBankQuestionImage(supabase, { userId, blob: file, contentType: file.type || 'image/jpeg' });
      const newUrl = await getBankQuestionImageUrl(supabase, newPath);
      onChange({ path: newPath, url: newUrl });
    } catch {
      // best-effort — leave prior image (if any) untouched on failure
    } finally {
      setUploading(false);
    }
  }

  function handleRemove() {
    onChange({ path: null, url: null });
  }

  return (
    <div className="mb-3">
      <label className="text-xs font-semibold text-gray-500 block mb-1.5">รูปประกอบคำถาม (ไม่บังคับ)</label>
      {url ? (
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="รูปประกอบคำถาม" className="h-24 w-24 object-cover rounded-lg border border-gray-200" />
          <button type="button" className={btnTiny} disabled={uploading} onClick={handleRemove}>
            <XIcon className="h-3.5 w-3.5" /> ลบรูป
          </button>
        </div>
      ) : (
        <label className={btnTiny + ' cursor-pointer w-fit ' + (uploading ? 'opacity-50 pointer-events-none' : '')}>
          <ImageIcon className="h-3.5 w-3.5" /> {uploading ? 'กำลังอัปโหลด...' : 'แนบรูปภาพ'}
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} disabled={uploading} />
        </label>
      )}
    </div>
  );
}

export default function BankTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const row = 'flex flex-wrap gap-3';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-90 inline-flex items-center justify-center gap-2';
  const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';
  const chip = 'px-3 py-1.5 rounded-full text-xs font-semibold border transition';
  const chipActive = chip + ' bg-indigo-600 border-indigo-600 text-white';
  const chipInactive = chip + ' bg-white border-gray-300 text-gray-600 hover:border-indigo-300';

  const [userId, setUserId] = useState(null);
  const [uploadingKeys, setUploadingKeys] = useState(new Set());
  const [imageUrls, setImageUrls] = useState({});
  const fetchedImagePaths = useRef(new Set());

  const [subjects, setSubjects] = useState([]);
  const [subjectId, setSubjectId] = useState('');
  // Whether subjectId's own room is itself one of the save targets — on by
  // default (matches pre-checklist behavior), but toggleable off so a
  // teacher can save into only a sibling room (e.g. only ม.2/2) without
  // subjectId's own room, without having to switch what "เลือกวิชา" points
  // at (which also drives the indicators query below).
  const [includePrimaryRoom, setIncludePrimaryRoom] = useState(true);
  // Other rooms sharing subjectId's own subject_code, ticked to also save
  // every question in this batch into — see saveRoomIds/handleSaveAll
  // below. Both this and includePrimaryRoom reset whenever subjectId
  // changes, since the candidate room list depends on it.
  const [saveRoomIds, setSaveRoomIds] = useState([]);
  const [indicators, setIndicators] = useState([]);
  const [indicatorIds, setIndicatorIds] = useState([]);
  const [units, setUnits] = useState([]);
  const [selectedUnitId, setSelectedUnitId] = useState('');
  const [sourceMode, setSourceMode] = useState('indicators'); // 'indicators' | 'units' | 'custom'
  const [kindFilter, setKindFilter] = useState('');
  const [customTopic, setCustomTopic] = useState('');
  const [cognitiveTypes, setCognitiveTypes] = useState([]);
  const [difficulty, setDifficulty] = useState('medium');
  const [numChoices, setNumChoices] = useState(4);
  const [numQuestions, setNumQuestions] = useState(5);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [draftQuestions, setDraftQuestions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [importErrors, setImportErrors] = useState([]);
  const importInputRef = useRef(null);
  const [pdfImporting, setPdfImporting] = useState(false);
  const [pdfImportError, setPdfImportError] = useState(null);
  const pdfImportInputRef = useRef(null);

  const [bankQuestions, setBankQuestions] = useState([]);
  const [bankLoading, setBankLoading] = useState(true);
  const [bankSearch, setBankSearch] = useState('');
  const [qualityStats, setQualityStats] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedGroups, toggleGroup] = useExpandedGroups();
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [editOriginalImagePath, setEditOriginalImagePath] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState(null);

  const selectedSubject = subjects.find(s => s.id === subjectId) || null;

  // "เลือกวิชา" collapses rooms sharing the same subject_code into one
  // option (indicators/AI generation don't vary by room) — this is the
  // deduped list of options, plus each option's member room ids so the
  // dropdown's own value can pick a representative room while the room
  // checklist below still offers every sibling room.
  const subjectDropdownOptions = (() => {
    const seen = new Set();
    const opts = [];
    for (const s of subjects) {
      const key = s.subject_code || s.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const groupSize = s.subject_code ? subjects.filter(x => x.subject_code === s.subject_code).length : 1;
      opts.push({
        id: s.id,
        label: groupSize > 1 ? `${s.subject_name} (ชั้น ม.${s.grade_level})` : `${s.subject_name} (ชั้น ${formatGradeRoom(s.grade_level, s.room)})`,
      });
    }
    return opts;
  })();

  // Rooms available to also save into, beyond the selected subjectId
  // itself — same subject_code, excluding subjectId — see saveRoomIds.
  const sameCodeRooms = selectedSubject?.subject_code
    ? subjects.filter(s => s.id !== subjectId && s.subject_code === selectedSubject.subject_code)
    : [];
  const allSaveRoomsSelected = sameCodeRooms.length > 0 && sameCodeRooms.every(s => saveRoomIds.includes(s.id));
  // Every room this batch will actually be saved into once "บันทึกเข้า
  // คลังทั้งหมด" is pressed — subjectId's own room only if still ticked,
  // plus whichever sibling rooms are ticked. Can be empty (both untoggled),
  // which handleSaveAll refuses to act on.
  const saveTargetIds = [...(includePrimaryRoom ? [subjectId] : []), ...saveRoomIds];

  function toggleSaveRoom(id) {
    setSaveRoomIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }
  function toggleAllSaveRooms() {
    setSaveRoomIds(allSaveRoomsSelected ? [] : sameCodeRooms.map(s => s.id));
  }

  // Best-effort and independent of the bank list load itself — a slow or
  // failed stats query should never block the question list from showing,
  // it just means the star/usage badges stay off for this refresh.
  const refreshQualityStats = useCallback(async (questions) => {
    const ids = questions.map(q => q.id);
    if (ids.length === 0) {
      setQualityStats({});
      return;
    }
    try {
      setQualityStats(await getBankQuestionQualityStats(supabase, ids));
    } catch {
      // best-effort
    }
  }, []);

  const refreshBank = useCallback(async () => {
    setBankLoading(true);
    try {
      const list = await listMyBankQuestions(supabase);
      setBankQuestions(list);
      refreshQualityStats(list);
    } catch {
      // best-effort — the generator above still works
    } finally {
      setBankLoading(false);
    }
  }, [refreshQualityStats]);

  useEffect(() => {
    (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        setUserId(user?.id ?? null);
        setSubjects(await listMySubjects(supabase));
      } catch {
        // best-effort
      }
    })();
    refreshBank();
  }, [refreshBank]);

  // Resolve signed preview URLs for every saved manual question that has an
  // image, one time each — fetchedImagePaths tracks what's already been
  // requested so a refreshBank() after an unrelated edit doesn't re-fetch
  // every thumbnail's signed URL again.
  useEffect(() => {
    const paths = bankQuestions
      .filter(q => q.source === 'manual' && q.image_path && !fetchedImagePaths.current.has(q.image_path))
      .map(q => q.image_path);
    if (paths.length === 0) return;
    paths.forEach(p => fetchedImagePaths.current.add(p));
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(paths.map(async p => {
        try { return [p, await getBankQuestionImageUrl(supabase, p)]; } catch { return null; }
      }));
      if (cancelled) return;
      setImageUrls(prev => {
        const next = { ...prev };
        for (const e of entries) if (e && !next[e[0]]) next[e[0]] = e[1];
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [bankQuestions]);

  function setKeyUploading(key, val) {
    setUploadingKeys(prev => {
      const next = new Set(prev);
      if (val) next.add(key); else next.delete(key);
      return next;
    });
  }

  useEffect(() => {
    setIndicatorIds([]);
    setIndicators([]);
    setUnits([]);
    setSelectedUnitId('');
    setCustomTopic('');
    setKindFilter('');
    if (!selectedSubject) return;
    (async () => {
      try {
        const [inds, us] = await Promise.all([
          listIndicatorsForSubject(supabase, selectedSubject),
          listEvalPlanUnitsForSubject(supabase, selectedSubject.id),
        ]);
        setIndicators(inds);
        setUnits(us);
        setSourceMode(inds.length > 0 ? 'indicators' : (us.length > 0 ? 'units' : 'custom'));
      } catch {
        // best-effort — falls back to the custom-topic field
        setSourceMode('custom');
      }
    })();
  }, [selectedSubject]);

  function toggleIndicator(id) {
    setIndicatorIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function toggleCognitiveType(value) {
    setCognitiveTypes(prev => prev.includes(value) ? prev.filter(x => x !== value) : [...prev, value]);
  }

  const filteredIndicators = kindFilter ? indicators.filter(i => i.kind === kindFilter) : indicators;

  function selectUnit(unit) {
    setSelectedUnitId(unit.id);
    if (unit.indicators.length > 0) {
      setIndicatorIds(unit.indicators.map(i => i.id));
      setCustomTopic('');
    } else {
      setIndicatorIds([]);
      setCustomTopic(unit.unit_name);
    }
  }

  // Switching source clears whatever the other two modes had picked, so the
  // request sent to /api/generate-questions always reflects only the
  // currently-visible picker, never a stale mix of indicatorIds from one
  // mode plus customTopic typed in another.
  function switchSource(mode) {
    setSourceMode(mode);
    setIndicatorIds([]);
    setSelectedUnitId('');
    setCustomTopic('');
  }

  async function handleGenerate() {
    setGenerateError(null);
    setGenerating(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/generate-questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          subjectId, indicatorIds, customTopic, difficulty, cognitiveTypes,
          numChoices: Number(numChoices), numQuestions: Number(numQuestions),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'สร้างข้อสอบไม่สำเร็จ');
      setDraftQuestions(body.questions.map((q, i) => ({ ...q, _key: `${Date.now()}-${i}` })));
    } catch (err) {
      setGenerateError(err.message || 'สร้างข้อสอบไม่สำเร็จ');
    } finally {
      setGenerating(false);
    }
  }

  // Adds one blank hand-written question to the same draft-review list the
  // AI generator fills, carrying the subject/indicator/difficulty already
  // picked in step 1 and source:'manual' so it's labeled and saved
  // distinctly from AI-drafted ones, even when both sit in the list
  // together before "บันทึกเข้าคลังทั้งหมด".
  function handleAddManual() {
    setDraftQuestions(prev => [...prev, {
      subject_id: subjectId,
      indicator_id: indicatorIds.length === 1 ? indicatorIds[0] : null,
      difficulty,
      question_text: '',
      choices: Array(Number(numChoices) || 4).fill(''),
      correct_choice: 0,
      explanation: '',
      source: 'manual',
      image_path: null,
      image_url: null,
      _key: `manual-${Date.now()}`,
    }]);
  }

  // Reads an uploaded CSV (see bank-import.js for the expected column
  // format, matching downloadBankQuestionTemplate()'s template) and appends
  // whatever rows parsed cleanly onto the same draft list the AI/manual
  // flows fill — so review, edit, and "บันทึกเข้าคลังทั้งหมด" all just work
  // on imported rows too, no separate save path needed. Rows that fail
  // validation (missing question, too few choices, bad answer number) are
  // reported instead of imported; a header-format mismatch or an empty file
  // surfaces as an error list rather than throwing.
  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !subjectId) return;
    setImportErrors([]);
    try {
      const text = await file.text();
      const { questions, errors } = parseBankQuestionCsv(text);
      if (questions.length > 0) {
        setDraftQuestions(prev => [
          ...prev,
          ...questions.map((q, i) => ({
            ...q,
            subject_id: subjectId,
            indicator_id: indicatorIds.length === 1 ? indicatorIds[0] : null,
            _key: `import-${Date.now()}-${i}`,
          })),
        ]);
      }
      setImportErrors(errors);
    } catch {
      setImportErrors(['อ่านไฟล์ไม่สำเร็จ — ตรวจสอบว่าเป็นไฟล์ CSV ที่ถูกต้อง']);
    }
  }

  const MAX_PDF_BYTES = 3 * 1024 * 1024;

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Sends the PDF to /api/import-questions-pdf, which asks Gemini to read
  // the file and extract (not invent) each question verbatim — the only
  // reliable way to handle real exam-paper PDFs, since their layout/
  // numbering/choice-lettering varies far too much for a fixed parser (see
  // bank-import.js's CSV path for that fixed-format alternative). A question
  // with no answer key found in the file still comes back with the AI's
  // best-effort correct_choice, flagged needs_review so the review step
  // below highlights it — same "review before saving" safety net every
  // other draft source (AI-generated, manual, CSV) already goes through.
  async function handleImportPdfFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !subjectId) return;
    setPdfImportError(null);
    if (file.size > MAX_PDF_BYTES) {
      setPdfImportError(`ไฟล์ใหญ่เกินไป (จำกัดไม่เกิน ${Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB) ลองแยกเป็นไฟล์ย่อยหรือบีบอัดไฟล์ก่อน`);
      return;
    }
    setPdfImporting(true);
    try {
      const pdfBase64 = await readFileAsBase64(file);
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/api/import-questions-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ subjectId, difficulty, pdfBase64 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'นำเข้าจากไฟล์ PDF ไม่สำเร็จ');
      setDraftQuestions(prev => [
        ...prev,
        ...body.questions.map((q, i) => ({
          ...q,
          indicator_id: indicatorIds.length === 1 ? indicatorIds[0] : null,
          image_path: null,
          image_url: null,
          _key: `pdf-${Date.now()}-${i}`,
        })),
      ]);
    } catch (err) {
      setPdfImportError(err.message || 'นำเข้าจากไฟล์ PDF ไม่สำเร็จ');
    } finally {
      setPdfImporting(false);
    }
  }

  function updateDraft(key, patch) {
    setDraftQuestions(prev => prev.map(q => q._key === key ? { ...q, ...patch } : q));
  }

  function updateDraftChoice(key, idx, value) {
    setDraftQuestions(prev => prev.map(q => {
      if (q._key !== key) return q;
      const choices = [...q.choices];
      choices[idx] = value;
      return { ...q, choices };
    }));
  }

  function removeDraft(key) {
    const target = draftQuestions.find(q => q._key === key);
    setDraftQuestions(prev => prev.filter(q => q._key !== key));
    if (target?.image_path) deleteBankQuestionImage(supabase, target.image_path).catch(() => {});
  }

  const hasIncompleteDraft = draftQuestions.some(q => !q.question_text.trim() || q.choices.some(c => !c.trim()));

  async function handleSaveAll() {
    if (draftQuestions.length === 0 || saveTargetIds.length === 0) return;
    setSaving(true);
    try {
      // Every draft already carries subject_id === subjectId (set at add
      // time by handleGenerate/handleAddManual/handleImportFile) — the
      // checklist above can point saveTargetIds at any combination of
      // subjectId's own room and its siblings (including subjectId's own
      // room being unticked, saving only into sibling rooms instead), so
      // this always re-targets every row explicitly rather than assuming
      // subjectId is one of the targets. Same duplication
      // ExamSetTool's copyExamSetToSubject does for a whole ชุดข้อสอบ, just
      // done directly here since these are still unsaved drafts rather than
      // an already-saved row to clone.
      const rows = saveTargetIds.length === 1 && saveTargetIds[0] === subjectId
        ? draftQuestions
        : saveTargetIds.flatMap(subject_id => draftQuestions.map(q => ({ ...q, subject_id })));
      await saveBankQuestions(supabase, rows);
      setDraftQuestions([]);
      setSaveRoomIds([]);
      setIncludePrimaryRoom(true);
      refreshBank();
    } catch (err) {
      setGenerateError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteBankQuestion(supabase, deleteTarget.id);
      if (deleteTarget.image_path) await deleteBankQuestionImage(supabase, deleteTarget.image_path).catch(() => {});
      setDeleteTarget(null);
      refreshBank();
    } finally {
      setDeleting(false);
    }
  }

  function startEdit(q) {
    setEditingId(q.id);
    setEditError(null);
    setEditDraft({
      question_text: q.question_text,
      choices: [...q.choices],
      correct_choice: q.correct_choice,
      explanation: q.explanation || '',
      image_path: q.image_path || null,
      image_url: q.image_path ? (imageUrls[q.image_path] || null) : null,
      difficulty: q.difficulty || 'medium',
    });
    setEditOriginalImagePath(q.image_path || null);
  }

  function closeEdit() {
    setEditingId(null);
    setEditDraft(null);
    setEditOriginalImagePath(null);
    setEditError(null);
  }

  function cancelEdit() {
    // Only ever clean up a NEW image uploaded during this edit session —
    // never the row's original persisted image, which the DB still points
    // to since the edit is being discarded, not saved.
    if (editDraft?.image_path && editDraft.image_path !== editOriginalImagePath) {
      deleteBankQuestionImage(supabase, editDraft.image_path).catch(() => {});
    }
    closeEdit();
  }

  function updateEditChoice(idx, value) {
    setEditDraft(prev => {
      const choices = [...prev.choices];
      choices[idx] = value;
      return { ...prev, choices };
    });
  }

  async function handleSaveEdit() {
    if (!editDraft.question_text.trim() || editDraft.choices.some(c => !c.trim())) {
      setEditError('กรอกคำถามและตัวเลือกให้ครบก่อนบันทึก');
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      await updateBankQuestion(supabase, editingId, editDraft);
      // The save succeeded, so the DB row now points at editDraft's image
      // (or none) — the row's old persisted image, if replaced or removed,
      // is safe to delete now that nothing references it any more.
      if (editOriginalImagePath && editOriginalImagePath !== editDraft.image_path) {
        deleteBankQuestionImage(supabase, editOriginalImagePath).catch(() => {});
      }
      closeEdit();
      refreshBank();
    } catch (err) {
      setEditError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setEditSaving(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-fuchsia-600 to-purple-500 text-white flex items-center justify-center shrink-0">
          <BankIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">คลังข้อสอบ</h1>
          <p className="text-sm text-gray-500">ให้ AI ช่วยออกข้อสอบตามตัวชี้วัด แล้วตรวจทานก่อนบันทึกเข้าคลัง</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        <div className="font-semibold text-gray-900 mb-3">1. เลือกวิชาและตัวชี้วัด</div>
        <div className={row}>
          <div className={field}>
            <label className={label}>วิชา</label>
            <select className={inputCls} value={subjectId} onChange={e => { setSubjectId(e.target.value); setSaveRoomIds([]); setIncludePrimaryRoom(true); }}>
              <option value="">— เลือกวิชา —</option>
              {subjectDropdownOptions.map(o => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className={field}>
            <label className={label}>ระดับความยาก</label>
            <select className={inputCls} value={difficulty} onChange={e => setDifficulty(e.target.value)}>
              {DIFFICULTIES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </div>
          <div className={field}>
            <label className={label}>จำนวนตัวเลือก</label>
            <input type="number" min={2} max={6} className={inputCls + ' w-24'} value={numChoices} onChange={e => setNumChoices(e.target.value)} />
          </div>
          <div className={field}>
            <label className={label}>จำนวนข้อ</label>
            <input type="number" min={1} max={15} className={inputCls + ' w-24'} value={numQuestions} onChange={e => setNumQuestions(e.target.value)} />
          </div>
        </div>

        {subjectId && sameCodeRooms.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <label className={label}>บันทึกเข้าห้อง</label>
              <button type="button" className={btnTiny} onClick={toggleAllSaveRooms}>
                {allSaveRoomsSelected ? 'ยกเลิกห้องอื่นทั้งหมด' : 'เลือกห้องอื่นทั้งหมด'}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className={'inline-flex items-center gap-1.5 border rounded-lg px-2.5 py-1.5 text-sm font-medium cursor-pointer ' + (includePrimaryRoom ? 'border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100' : 'border-gray-200 text-gray-500 hover:bg-gray-50')}>
                <input type="checkbox" checked={includePrimaryRoom} onChange={() => setIncludePrimaryRoom(v => !v)} />
                ชั้น {formatGradeRoom(selectedSubject.grade_level, selectedSubject.room)}
                <span className={'text-[10px] font-normal ' + (includePrimaryRoom ? 'text-indigo-500' : 'text-gray-400')}>(ที่เลือกไว้ด้านบน)</span>
              </label>
              {sameCodeRooms.map(s => (
                <label key={s.id} className="inline-flex items-center gap-1.5 border border-gray-200 rounded-lg px-2.5 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                  <input type="checkbox" checked={saveRoomIds.includes(s.id)} onChange={() => toggleSaveRoom(s.id)} />
                  ชั้น {formatGradeRoom(s.grade_level, s.room)}
                </label>
              ))}
            </div>
            {saveTargetIds.length === 0 && (
              <p className="text-xs text-red-600 mt-1.5">เลือกอย่างน้อย 1 ห้องก่อนจึงจะบันทึกได้</p>
            )}
            <p className="text-xs text-gray-500 mt-1.5">
              ข้อสอบที่บันทึกในขั้นตอนที่ 2 จะเข้าคลังของทุกห้องที่ติ๊กไว้ (คนละชุดข้อมูลต่อห้อง แก้ไขภายหลังจะไม่ซิงก์กัน) — ยกเลิกห้องที่เลือกไว้ด้านบนได้ถ้าต้องการบันทึกเข้าห้องอื่นแทน
            </p>
          </div>
        )}

        <div className="mt-4">
          <label className={label}>ประเภทข้อสอบ (เลือกได้หลายข้อ ไม่บังคับเลือก)</label>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-2">
            {COGNITIVE_TYPES.map(c => (
              <label key={c.value} className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cognitiveTypes.includes(c.value)}
                  onChange={() => toggleCognitiveType(c.value)}
                />
                {c.label}
              </label>
            ))}
          </div>
        </div>

        {selectedSubject && (
          <div className="mt-4">
            <div className="flex flex-wrap gap-2 mb-3">
              {indicators.length > 0 && (
                <button type="button" className={sourceMode === 'indicators' ? chipActive : chipInactive} onClick={() => switchSource('indicators')}>
                  ตัวชี้วัดมาตรฐาน ({indicators.length})
                </button>
              )}
              {units.length > 0 && (
                <button type="button" className={sourceMode === 'units' ? chipActive : chipInactive} onClick={() => switchSource('units')}>
                  หน่วยการเรียนรู้ (แผนการวัดผล) ({units.length})
                </button>
              )}
              <button type="button" className={sourceMode === 'custom' ? chipActive : chipInactive} onClick={() => switchSource('custom')}>
                พิมพ์หัวข้อเอง
              </button>
            </div>

            {sourceMode === 'indicators' && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <label className={label}>ประเภทตัวชี้วัด</label>
                  {KINDS.map(k => (
                    <button key={k.value} type="button" className={kindFilter === k.value ? chipActive : chipInactive} onClick={() => setKindFilter(k.value)}>
                      {k.label}
                    </button>
                  ))}
                </div>
                <label className={label}>ตัวชี้วัด (เลือกได้หลายข้อ)</label>
                <div className="mt-1.5 max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {filteredIndicators.map(ind => (
                    <label key={ind.id} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={indicatorIds.includes(ind.id)}
                        onChange={() => toggleIndicator(ind.id)}
                      />
                      <span>
                        <span className="font-semibold text-gray-700">{ind.indicator_code}</span>{' '}
                        <span className="text-[10px] text-gray-400">({ind.kind})</span>{' '}
                        <span className="text-gray-600">{ind.indicator_text}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {sourceMode === 'units' && (
              <>
                <label className={label}>หน่วยการเรียนรู้ (เลือก 1 หน่วย — ใช้ตัวชี้วัดที่ผูกไว้กับหน่วยนั้น)</label>
                {sameCodeRooms.length > 0 && (
                  <p className="text-xs text-amber-600 mt-0.5">
                    แผนของ &ldquo;ชั้น {formatGradeRoom(selectedSubject?.grade_level, selectedSubject?.room)}&rdquo; เท่านั้น — ห้องอื่นที่ติ๊กไว้ด้านบนอาจมีแผนของตัวเองต่างกัน
                  </p>
                )}
                <div className="mt-1.5 max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {units.map(u => (
                    <label key={u.id} className="flex items-start gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input
                        type="radio" name="unit" className="mt-0.5"
                        checked={selectedUnitId === u.id}
                        onChange={() => selectUnit(u)}
                      />
                      <span className="min-w-0">
                        <span className="font-semibold text-gray-700">หน่วยที่ {u.seq}: {u.unit_name}</span>{' '}
                        <span className="text-[10px] text-gray-400">({u.weight}% · {u.hours} ชม.)</span>
                        {u.indicators.length > 0 ? (
                          <div className="text-xs text-gray-500 mt-0.5">
                            {u.indicators.map(i => i.indicator_code).join(', ')}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400 mt-0.5">ไม่มีตัวชี้วัดผูกไว้ — ใช้ชื่อหน่วยเป็นหัวข้อแทน</div>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {sourceMode === 'custom' && (
              <div className={field}>
                <label className={label}>หัวข้อ</label>
                <input
                  type="text" className={inputCls} value={customTopic}
                  onChange={e => setCustomTopic(e.target.value)}
                  placeholder="เช่น การเขียนโปรแกรมแบบวนซ้ำ (loop)"
                />
              </div>
            )}
          </div>
        )}

        {generateError && <div className="text-sm text-red-600 mt-3">{generateError}</div>}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button" className={btn}
            disabled={!subjectId || generating || (indicatorIds.length === 0 && !customTopic.trim())}
            onClick={handleGenerate}
          >
            <SparkleIcon className="h-4 w-4" /> {generating ? 'กำลังสร้างข้อสอบ...' : 'สร้างข้อสอบด้วย AI'}
          </button>
          <button type="button" className={btnSecondary} disabled={!subjectId} onClick={handleAddManual}>
            <PencilIcon className="h-4 w-4" /> เพิ่มข้อสอบเอง
          </button>
          <button type="button" className={btnSecondary} disabled={!subjectId} onClick={() => importInputRef.current?.click()}>
            <UploadIcon className="h-4 w-4" /> นำเข้าจากไฟล์ CSV
          </button>
          <input ref={importInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />
          <button type="button" className={btnSecondary} onClick={downloadBankQuestionTemplate}>
            <DownloadIcon className="h-4 w-4" /> ดาวน์โหลดแบบฟอร์มนำเข้า
          </button>
          <button type="button" className={btnSecondary} disabled={!subjectId || pdfImporting} onClick={() => pdfImportInputRef.current?.click()}>
            <UploadIcon className="h-4 w-4" /> {pdfImporting ? 'กำลังอ่านไฟล์...' : 'นำเข้าจากไฟล์ PDF'}
          </button>
          <input ref={pdfImportInputRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={handleImportPdfFile} />
        </div>
        {!subjectId && <div className="text-xs text-gray-400 mt-2">เลือกวิชาก่อนจึงจะนำเข้าไฟล์ได้</div>}
        {importErrors.length > 0 && (
          <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">
            <div className="font-semibold mb-1">พบปัญหาในไฟล์ที่นำเข้า (แถวที่ผ่านการตรวจสอบจะถูกเพิ่มไว้ในร่างด้านล่างแล้ว):</div>
            <ul className="list-disc list-inside space-y-0.5">
              {importErrors.map((err, i) => <li key={i}>{err}</li>)}
            </ul>
          </div>
        )}
        {pdfImportError && <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg p-3">{pdfImportError}</div>}
        <p className="text-xs text-gray-400 mt-2">
          รูปแบบไฟล์ CSV: คอลัมน์ คำถาม, ตัวเลือกที่ 1-6 (กรอกอย่างน้อย 2 ข้อ), เฉลย (เลขข้อที่ถูก), คำอธิบายเฉลย (ไม่บังคับ), ระดับความยาก (ง่าย/ปานกลาง/ยาก) — ดาวน์โหลดแบบฟอร์มด้านบนเพื่อดูตัวอย่าง
        </p>
        <p className="text-xs text-gray-400 mt-1">
          นำเข้าจากไฟล์ PDF: ให้ AI อ่านไฟล์ข้อสอบ (ไม่เกิน {Math.round(MAX_PDF_BYTES / 1024 / 1024)}MB) แล้วดึงคำถาม/ตัวเลือกออกมาให้อัตโนมัติ — ถ้าไฟล์ไม่มีเฉลยแนบมา AI จะประเมินคำตอบเองและทำเครื่องหมายให้ตรวจสอบซ้ำ รูปภาพ/แผนภาพในไฟล์จะไม่ถูกดึงมาด้วย ต้องแนบเพิ่มเองภายหลังถ้าจำเป็น
        </p>
      </div>

      {draftQuestions.length > 0 && (
        <div className={card}>
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-gray-900">2. ตรวจทานร่างข้อสอบ ({draftQuestions.length} ข้อ)</div>
            <button type="button" className={btn} disabled={saving || hasIncompleteDraft || saveTargetIds.length === 0} onClick={handleSaveAll}>
              <SaveIcon className="h-4 w-4" /> {saving
                ? 'กำลังบันทึก...'
                : saveTargetIds.length > 1 ? `บันทึกเข้าคลังทั้งหมด (${saveTargetIds.length} ห้อง)` : 'บันทึกเข้าคลังทั้งหมด'}
            </button>
          </div>
          {hasIncompleteDraft && <div className="text-xs text-amber-600 mb-3">กรอกคำถามและตัวเลือกให้ครบทุกข้อก่อนบันทึก</div>}
          <div className="space-y-4">
            {draftQuestions.map((q, i) => (
              <div key={q._key} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-400">ข้อ {i + 1}</span>
                    <span className={pill + (q.source === 'manual' ? ' bg-purple-50 text-purple-700' : ' bg-indigo-50 text-indigo-700')}>
                      {SOURCE_LABEL[q.source] || SOURCE_LABEL.ai}
                    </span>
                    {q.needs_review && (
                      <span className={pill + ' bg-amber-50 text-amber-700'}>ตรวจสอบเฉลย — ไฟล์ไม่มีคำตอบ</span>
                    )}
                  </div>
                  <button type="button" className={btnTiny} onClick={() => removeDraft(q._key)}>
                    <TrashIcon className="h-3.5 w-3.5" /> ลบข้อนี้
                  </button>
                </div>
                <textarea
                  className={inputCls + ' w-full mb-3'} rows={2}
                  value={q.question_text}
                  onChange={e => updateDraft(q._key, { question_text: e.target.value })}
                />
                {q.source === 'manual' && (
                  <ImagePicker
                    userId={userId}
                    path={q.image_path}
                    url={q.image_url}
                    uploading={uploadingKeys.has(q._key)}
                    setUploading={v => setKeyUploading(q._key, v)}
                    onChange={({ path, url }) => {
                      // A draft was never persisted, so its previous image
                      // (if any) is never referenced anywhere else and can
                      // be cleaned up immediately.
                      if (q.image_path && q.image_path !== path) deleteBankQuestionImage(supabase, q.image_path).catch(() => {});
                      updateDraft(q._key, { image_path: path, image_url: url });
                    }}
                  />
                )}
                <div className="space-y-1.5 mb-3">
                  {q.choices.map((c, ci) => (
                    <label key={ci} className="flex items-center gap-2">
                      <input
                        type="radio" name={`correct-${q._key}`}
                        checked={q.correct_choice === ci}
                        onChange={() => updateDraft(q._key, { correct_choice: ci })}
                      />
                      <input
                        type="text" className={inputCls + ' flex-1'}
                        value={c}
                        onChange={e => updateDraftChoice(q._key, ci, e.target.value)}
                      />
                    </label>
                  ))}
                </div>
                <label className={label}>คำอธิบายเฉลย</label>
                <textarea
                  className={inputCls + ' w-full mt-1'} rows={2}
                  value={q.explanation}
                  onChange={e => updateDraft(q._key, { explanation: e.target.value })}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={card}>
        <div className="flex items-center gap-2 mb-4">
          <BankIcon className="h-4 w-4 text-gray-400" />
          <div className="font-semibold text-gray-900">ข้อสอบที่บันทึกไว้แล้ว</div>
          {!bankLoading && bankQuestions.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-bold">
              {bankQuestions.length}
            </span>
          )}
        </div>
        {bankLoading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {!bankLoading && bankQuestions.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีข้อสอบในคลัง</div>}
        {bankQuestions.length > 0 && (
          <>
            <div className="relative mb-3">
              <SearchIcon className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={bankSearch}
                onChange={e => setBankSearch(e.target.value)}
                placeholder="ค้นหาคำถาม, วิชา, ชั้น/ห้อง..."
                className={inputCls + ' w-full pl-9'}
              />
            </div>
            <div className="max-h-[32rem] overflow-y-auto -mx-5 px-5 space-y-2">
              {(() => {
                const term = bankSearch.trim().toLowerCase();
                const filteredGroups = groupBySubject(bankQuestions)
                  .map(group => ({
                    ...group,
                    rows: term
                      ? group.rows.filter(q => group.name.toLowerCase().includes(term) || q.question_text?.toLowerCase().includes(term))
                      : group.rows,
                  }))
                  .filter(group => group.rows.length > 0);
                if (term && filteredGroups.length === 0) {
                  return <div className="text-sm text-gray-500 py-2">ไม่พบข้อสอบที่ตรงกับคำค้นหา</div>;
                }
                return filteredGroups.map(group => {
              const expanded = term ? true : expandedGroups.has(group.name);
              return (
                <div key={group.name} className="border border-gray-200 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.name)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left bg-gray-50 hover:bg-gray-100 transition-colors"
                  >
                    <span className="shrink-0 h-7 w-7 rounded-md bg-indigo-100 text-indigo-600 flex items-center justify-center">
                      <BankIcon className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex-1 min-w-0 text-sm font-semibold text-gray-800 truncate">{group.name}</span>
                    <span className="shrink-0 inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-bold">
                      {group.rows.length}
                    </span>
                    <ChevronDownIcon className={"h-4 w-4 text-gray-400 shrink-0 transition-transform " + (expanded ? '' : '-rotate-90')} />
                  </button>
                  {expanded && (
                  <div className="px-3 pt-1 pb-2">
                  {group.rows.map(q => (
                    editingId === q.id ? (
                      <div key={q.id} className="border border-indigo-200 rounded-lg p-4 my-2">
                        <textarea
                          className={inputCls + ' w-full mb-3'} rows={2}
                          value={editDraft.question_text}
                          onChange={e => setEditDraft(prev => ({ ...prev, question_text: e.target.value }))}
                        />
                        {q.source === 'manual' && (
                          <ImagePicker
                            userId={userId}
                            path={editDraft.image_path}
                            url={editDraft.image_url}
                            uploading={uploadingKeys.has('edit')}
                            setUploading={v => setKeyUploading('edit', v)}
                            onChange={({ path, url }) => {
                              // Never delete the row's original persisted
                              // image here — only an intermediate upload
                              // made earlier in this same edit session
                              // (a replace-of-a-replace before saving),
                              // since the edit could still be cancelled.
                              setEditDraft(prev => {
                                if (prev.image_path && prev.image_path !== editOriginalImagePath && prev.image_path !== path) {
                                  deleteBankQuestionImage(supabase, prev.image_path).catch(() => {});
                                }
                                return { ...prev, image_path: path, image_url: url };
                              });
                            }}
                          />
                        )}
                        <div className="space-y-1.5 mb-3">
                          {editDraft.choices.map((c, ci) => (
                            <label key={ci} className="flex items-center gap-2">
                              <input
                                type="radio" name={`edit-${q.id}`}
                                checked={editDraft.correct_choice === ci}
                                onChange={() => setEditDraft(prev => ({ ...prev, correct_choice: ci }))}
                              />
                              <input
                                type="text" className={inputCls + ' flex-1'}
                                value={c}
                                onChange={e => updateEditChoice(ci, e.target.value)}
                              />
                            </label>
                          ))}
                        </div>
                        <label className={label}>ระดับความยาก</label>
                        <select
                          className={inputCls + ' w-full mt-1 mb-3'}
                          value={editDraft.difficulty}
                          onChange={e => setEditDraft(prev => ({ ...prev, difficulty: e.target.value }))}
                        >
                          {DIFFICULTIES.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                        </select>
                        <label className={label}>คำอธิบายเฉลย</label>
                        <textarea
                          className={inputCls + ' w-full mt-1 mb-3'} rows={2}
                          value={editDraft.explanation}
                          onChange={e => setEditDraft(prev => ({ ...prev, explanation: e.target.value }))}
                        />
                        {editError && <div className="text-xs text-red-600 mb-2">{editError}</div>}
                        <div className="flex gap-2">
                          <button type="button" className={btn} disabled={editSaving} onClick={handleSaveEdit}>
                            <SaveIcon className="h-4 w-4" /> {editSaving ? 'กำลังบันทึก...' : 'บันทึก'}
                          </button>
                          <button type="button" className={btnSecondary} disabled={editSaving} onClick={cancelEdit}>ยกเลิก</button>
                        </div>
                      </div>
                    ) : (
                      <div key={q.id} className="flex justify-between items-start gap-3 text-sm py-2.5 border-b border-gray-100 last:border-b-0">
                        <div className="min-w-0 flex items-start gap-3">
                          {q.source === 'manual' && q.image_path && imageUrls[q.image_path] && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={imageUrls[q.image_path]} alt="" className="h-12 w-12 object-cover rounded-md border border-gray-200 shrink-0" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium text-gray-900">{q.question_text}</div>
                            <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                              <span className={pill + (q.source === 'manual' ? ' bg-purple-50 text-purple-700' : ' bg-indigo-50 text-indigo-700')}>
                                {SOURCE_LABEL[q.source] || SOURCE_LABEL.ai}
                              </span>
                              <span className={pill + ' bg-amber-50 text-amber-700'}>{DIFFICULTIES.find(d => d.value === q.difficulty)?.label || q.difficulty}</span>
                              {q.indicators?.indicator_code && <span className={pill + ' bg-gray-100 text-gray-600'}>{q.indicators.indicator_code}</span>}
                              <span>{q.num_choices} ตัวเลือก</span>
                            </div>
                            {qualityStats[q.id] && (qualityStats[q.id].stars !== null || qualityStats[q.id].usageCount > 0) && (
                              <div className="mt-1 flex items-center gap-2 flex-wrap">
                                {qualityStats[q.id].stars !== null && <StarRating stars={qualityStats[q.id].stars} />}
                                {qualityStats[q.id].usageCount > 0 && (
                                  <span className={pill + ' bg-sky-50 text-sky-700'}>ใช้ไปแล้ว {qualityStats[q.id].usageCount} รอบสอบ</span>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button className={btnTiny} onClick={() => startEdit(q)}>
                            <PencilIcon className="h-3.5 w-3.5" /> แก้ไข
                          </button>
                          <button className={btnTiny} onClick={() => setDeleteTarget(q)}>
                            <TrashIcon className="h-3.5 w-3.5" /> ลบ
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                  </div>
                  )}
                </div>
              );
                });
              })()}
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="ยืนยันลบข้อสอบ"
        message={deleteTarget ? `ลบข้อสอบข้อนี้ออกจากคลัง?\n\n"${deleteTarget.question_text}"` : ''}
        confirmLabel="ลบข้อสอบ"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
