'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { listAllScanPhotos, getScanPhotoUrl, deleteScanPhoto, listAllQuizzes, deleteQuiz } from '@/lib/omr-db';
import { getConfigValue, getConfigValues, setConfigValue } from '@/lib/config-db';
import { resizeImageToFit } from '@/lib/image-resize';
import { formatStudentName } from '@/lib/student-name';
import { listExamAuditLog, EXAM_AUDIT_ACTION_LABEL, listTeacherLastLogins } from '@/lib/exam-db';
import ConfirmDialog from '@/components/ConfirmDialog';
import { formatGradeRoom } from '@/lib/format';

const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200';

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

function EyeIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
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

function LockIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
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

// Tracks which teacher groups are expanded, by name. Groups start collapsed
// (empty set) so the panel opens as a compact list of teacher names —
// admins expand only the teacher they're looking for.
function useExpandedGroups() {
  const [expanded, setExpanded] = useState(new Set());
  const toggle = (name) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  return [expanded, toggle];
}

// Groups a list of admin-wide rows by teacher name, sorted alphabetically
// (Thai collation) by teacher, preserving each row's original order within
// its group — used so the settings panels read as "per teacher" instead of
// one long list mixing every teacher's items together.
function groupByTeacher(items, getTeacherName) {
  const groups = new Map();
  for (const item of items) {
    const name = getTeacherName(item) || 'ไม่ทราบ';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'th'))
    .map(([name, rows]) => ({ name, rows }));
}

function TeacherGroupHeader({ name, count, expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 pt-3 pb-1.5 first:pt-0 text-left"
    >
      <ChevronDownIcon className={"h-3.5 w-3.5 text-gray-400 shrink-0 transition-transform " + (expanded ? '' : '-rotate-90')} />
      <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{name}</span>
      <span className="inline-flex items-center justify-center min-w-[1.25rem] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700 text-[10px] font-bold">{count}</span>
      <div className="h-px flex-1 bg-gray-100" />
    </button>
  );
}

function ScanPhotosPanel() {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedGroups, toggleGroup] = useExpandedGroups();
  const [deletingId, setDeletingId] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null); // { id, photoPath, label } | null

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPhotos(await listAllScanPhotos(supabase));
    } catch (err) {
      setError(err.message || 'โหลดรายการรูปไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { (async () => { await refresh(); })(); }, [refresh]);

  async function handleView(photoPath) {
    try {
      const url = await getScanPhotoUrl(supabase, photoPath);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // best-effort
    }
  }

  async function handleDelete() {
    if (!confirmTarget) return;
    setDeletingId(confirmTarget.id);
    try {
      await deleteScanPhoto(supabase, confirmTarget.id, confirmTarget.photoPath);
      setConfirmTarget(null);
      refresh();
    } catch (err) {
      setError(err.message || 'ลบรูปไม่สำเร็จ');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-purple-600 to-fuchsia-500 text-white flex items-center justify-center shrink-0">
          <PhotoIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">รูปกระดาษคำตอบที่ครูเก็บไว้ทั้งหมด</div>
        {!loading && photos.length > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-bold">
            {photos.length}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        เฉพาะครูที่เปิด &ldquo;เก็บรูปกระดาษคำตอบไว้ดูย้อนหลัง&rdquo; ในหน้าสแกนตรวจเท่านั้นที่จะมีรูปที่นี่ แอดมินลบรูปของครูคนใดก็ได้ (ข้อมูลคะแนน/เฉลยไม่หาย ลบแค่รูป)
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && photos.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีรูปที่เก็บไว้</div>}
      {photos.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          {groupByTeacher(photos, p => p.profiles?.full_name).map(group => {
            const expanded = expandedGroups.has(group.name);
            return (
              <div key={group.name}>
                <TeacherGroupHeader name={group.name} count={group.rows.length} expanded={expanded} onToggle={() => toggleGroup(group.name)} />
                {expanded && group.rows.map(p => (
                  <div key={p.id} className="flex justify-between items-center text-sm py-2 border-b border-gray-100 last:border-b-0">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {p.students?.student_code} {formatStudentName(p.students)}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {p.omr_quizzes?.title} · {p.omr_quizzes?.subjects?.subject_name} (ชั้น {formatGradeRoom(p.omr_quizzes?.subjects?.grade_level, p.omr_quizzes?.subjects?.room)})
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-xs text-gray-500">{p.total_correct} ({p.score}%)</span>
                      <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => handleView(p.photo_path)}>
                        <EyeIcon className="h-3.5 w-3.5" /> ดูรูป
                      </button>
                      <button
                        className={btnTiny + ' inline-flex items-center gap-1'}
                        onClick={() => setConfirmTarget({
                          id: p.id,
                          photoPath: p.photo_path,
                          label: `${p.students?.student_code || ''} ${formatStudentName(p.students)}`.trim(),
                        })}
                        disabled={deletingId === p.id}
                      >
                        {deletingId === p.id ? 'กำลังลบ...' : (<><TrashIcon className="h-3.5 w-3.5" /> ลบรูป</>)}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        title="ยืนยันลบรูปกระดาษคำตอบ"
        message={confirmTarget ? `ลบรูปกระดาษคำตอบของ "${confirmTarget.label}"?\n\nลบแล้วกู้คืนไม่ได้ (ข้อมูลคะแนน/เฉลยไม่หาย ลบแค่รูป)` : ''}
        confirmLabel="ลบรูป"
        danger
        loading={!!deletingId}
        onConfirm={handleDelete}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function QuizzesPanel() {
  const [quizzes, setQuizzes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null); // { id, title } | null
  const [expandedGroups, toggleGroup] = useExpandedGroups();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setQuizzes(await listAllQuizzes(supabase));
    } catch (err) {
      setError(err.message || 'โหลดรายการชุดข้อสอบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { (async () => { await refresh(); })(); }, [refresh]);

  async function handleDelete() {
    if (!confirmTarget) return;
    setDeletingId(confirmTarget.id);
    try {
      await deleteQuiz(supabase, confirmTarget.id);
      setConfirmTarget(null);
      refresh();
    } catch (err) {
      setError(err.message || 'ลบชุดข้อสอบไม่สำเร็จ');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-indigo-600 to-blue-500 text-white flex items-center justify-center shrink-0">
          <SheetIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">ชุดข้อสอบทั้งหมดในระบบ</div>
        {!loading && quizzes.length > 0 && (
          <span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-full bg-indigo-600 text-white text-[11px] font-bold">
            {quizzes.length}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        รายการชุดข้อสอบของครูทุกคน แอดมินลบชุดข้อสอบของครูคนใดก็ได้ (ลบแล้วเฉลย ผลตรวจ และรูปที่เก็บไว้ของชุดนั้นจะหายไปทั้งหมด กู้คืนไม่ได้)
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && quizzes.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีชุดข้อสอบในระบบ</div>}
      {quizzes.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          {groupByTeacher(quizzes, q => q.teacherName).map(group => {
            const expanded = expandedGroups.has(group.name);
            return (
              <div key={group.name}>
                <TeacherGroupHeader name={group.name} count={group.rows.length} expanded={expanded} onToggle={() => toggleGroup(group.name)} />
                {expanded && group.rows.map((q, i) => (
                  <div key={q.id} className="flex justify-between items-center text-sm py-2 border-b border-gray-100 last:border-b-0">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{i + 1}. {q.title}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {q.subjects?.subject_name} (ชั้น {formatGradeRoom(q.subjects?.grade_level, q.subjects?.room)}) · {q.num_questions} ข้อ
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => setConfirmTarget({ id: q.id, title: q.title })} disabled={deletingId === q.id}>
                        {deletingId === q.id ? 'กำลังลบ...' : (<><TrashIcon className="h-3.5 w-3.5" /> ลบ</>)}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirmTarget}
        title="ยืนยันลบชุดข้อสอบ"
        message={confirmTarget ? `ลบชุดข้อสอบ "${confirmTarget.title}" ทั้งหมด?\n\nการลบนี้จะลบเฉลย ผลตรวจของนักเรียนทุกคน และรูปที่เก็บไว้ของชุดนี้ไปด้วย และไม่สามารถกู้คืนได้` : ''}
        confirmLabel="ลบชุดข้อสอบ"
        danger
        loading={!!deletingId}
        onConfirm={handleDelete}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

function SparkleIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </svg>
  );
}

// Reads/writes public.config's gemini_api_key row — the same shared
// key/value table and key name the ปพ.5 system already uses from its own
// settings page, so a key entered there or here works for both.
// Must match the model literal in src/app/api/generate-questions/route.js
// and src/app/api/import-questions-pdf/route.js — this is only a display
// label (the actual Gemini call happens server-side in those routes), so
// nothing breaks if it drifts, but the teacher would see a stale name here.
const GEMINI_MODEL_ALIAS = 'gemini-flash-latest';

function AISettingsPanel() {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [checkingModel, setCheckingModel] = useState(false);
  const [resolvedModel, setResolvedModel] = useState(null);
  const [checkModelError, setCheckModelError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        setValue(await getConfigValue(supabase, 'gemini_api_key'));
      } catch (err) {
        setError(err.message || 'โหลดค่าไม่สำเร็จ');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await setConfigValue(supabase, 'gemini_api_key', value.trim());
      setSaved(true);
    } catch (err) {
      setError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  // "-latest" resolves to whatever Google's current stable release is —
  // the only way to see what that actually is right now is a real
  // generateContent call (models.get on the alias just describes the
  // alias itself, not what it resolves to). Kept as cheap as a real call
  // gets: 1 output token, thinking off, so this is a manual "check now"
  // button rather than something run automatically on every page load.
  async function handleCheckModel() {
    setCheckingModel(true);
    setResolvedModel(null);
    setCheckModelError(null);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_ALIAS}:generateContent?key=${encodeURIComponent(value.trim())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1, thinkingConfig: { thinkingBudget: 0 } },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `Gemini API ผิดพลาด (${res.status})`);
      if (!data.modelVersion) throw new Error('ไม่พบเวอร์ชันโมเดลในผลลัพธ์');
      setResolvedModel(data.modelVersion);
    } catch (err) {
      setCheckModelError(err.message || 'ตรวจสอบไม่สำเร็จ');
    } finally {
      setCheckingModel(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-fuchsia-600 to-purple-500 text-white flex items-center justify-center shrink-0">
          <SparkleIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">Gemini API Key (สำหรับคลังข้อสอบ)</div>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        ใช้สร้างข้อสอบด้วย AI ในหน้าคลังข้อสอบ — ค่านี้ใช้ร่วมกับระบบ ปพ.5 (ตั้งค่าที่ไหนก็ได้ ใช้ได้ทั้งสองระบบ) รับฟรีได้ที่ aistudio.google.com → Get API Key
      </p>
      {loading ? (
        <div className="text-sm text-gray-500">กำลังโหลด...</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              type={revealed ? 'text' : 'password'}
              className="flex-1 px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={value}
              onChange={e => { setValue(e.target.value); setSaved(false); }}
              placeholder="AIza..."
            />
            <button type="button" className={btnTiny} onClick={() => setRevealed(v => !v)}>
              <EyeIcon className="h-3.5 w-3.5" /> {revealed ? 'ซ่อน' : 'แสดง'}
            </button>
            <button type="button" className="bg-indigo-600 text-white px-3 py-2 rounded-md text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50" onClick={handleSave} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
          {error && <div className="text-sm text-red-600 mt-2">{error}</div>}
          {saved && <div className="text-sm text-green-600 mt-2">บันทึกแล้ว</div>}

          <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-700">
              โมเดลที่ตั้งไว้ในระบบ: <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">{GEMINI_MODEL_ALIAS}</span>
            </span>
            <button type="button" className={btnTiny} onClick={handleCheckModel} disabled={checkingModel || !value.trim()}>
              {checkingModel ? 'กำลังตรวจสอบ...' : 'ตรวจสอบเวอร์ชันปัจจุบัน'}
            </button>
            {resolvedModel && <span className="text-sm text-green-700">ขณะนี้คือ <span className="font-mono text-xs bg-green-50 px-1.5 py-0.5 rounded">{resolvedModel}</span></span>}
            {checkModelError && <span className="text-sm text-red-600">{checkModelError}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function ShieldIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
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

// Reads/writes public.config's max_exam_violations row — read server-side
// by record_exam_violation (see the migration) whenever a student's screen
// leaves the exam tab/app during /take, so this cap applies to every รอบสอบ
// in the system rather than being set per round.
const DEFAULT_MAX_VIOLATIONS = 3;

function ExamSecurityPanel() {
  const [value, setValue] = useState(String(DEFAULT_MAX_VIOLATIONS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const stored = await getConfigValue(supabase, 'max_exam_violations');
        setValue(stored || String(DEFAULT_MAX_VIOLATIONS));
      } catch (err) {
        setError(err.message || 'โหลดค่าไม่สำเร็จ');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      setError('กรอกจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await setConfigValue(supabase, 'max_exam_violations', String(n));
      setSaved(true);
    } catch (err) {
      setError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shrink-0">
          <ShieldIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">ป้องกันการทุจริตในการสอบออนไลน์</div>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        เมื่อนักเรียนสลับหน้าจอ/ย่อแอประหว่างทำข้อสอบ หน้าจอนักเรียนจะล็อกและต้องรอครูคุมสอบกรอกรหัสปลดล็อกของรอบสอบนั้นให้ ถ้าสลับหน้าจอเกินจำนวนครั้งที่กำหนดไว้นี้ ระบบจะแจ้งเตือนแล้วส่งข้อสอบให้อัตโนมัติทันที แม้ยังไม่หมดเวลาสอบ
      </p>
      {loading ? (
        <div className="text-sm text-gray-500">กำลังโหลด...</div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700">อนุญาตให้สลับหน้าจอได้สูงสุด</label>
            <input
              type="number" min={1} step={1}
              className="w-20 px-2.5 py-2 border border-gray-300 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={value}
              onChange={e => { setValue(e.target.value); setSaved(false); }}
            />
            <span className="text-sm text-gray-700">ครั้ง</span>
            <button type="button" className="bg-indigo-600 text-white px-3 py-2 rounded-md text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50" onClick={handleSave} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
          {error && <div className="text-sm text-red-600 mt-2">{error}</div>}
          {saved && <div className="text-sm text-green-600 mt-2">บันทึกแล้ว</div>}
        </>
      )}
    </div>
  );
}

// Reads/writes public.config's exam_proximity_check_enabled/
// exam_proximity_min_distance_m rows. enabled is the admin's system-wide
// master switch — start_exam_attempt ANDs it with each round's own
// require_location before deciding whether to actually gate a student's
// entry (see the migration), so flipping this off immediately stops
// enforcement everywhere without having to touch every round, and
// ExamScheduleTool only shows its per-รอบสอบ "บังคับแชร์ตำแหน่งก่อนเข้าสอบ"
// checkbox at all when this is on — a teacher scheduling an in-school exam
// isn't offered a control that wouldn't do anything. Missing config row
// (nothing ever saved) defaults to enabled, matching how this behaved
// before this master switch existed.
const DEFAULT_PROXIMITY_MIN_DISTANCE_M = 15;

function ExamProximityCheckPanel() {
  const [enabled, setEnabled] = useState(true);
  const [minDistance, setMinDistance] = useState(String(DEFAULT_PROXIMITY_MIN_DISTANCE_M));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const [storedEnabled, storedDistance] = await Promise.all([
          getConfigValue(supabase, 'exam_proximity_check_enabled'),
          getConfigValue(supabase, 'exam_proximity_min_distance_m'),
        ]);
        setEnabled(storedEnabled !== 'false');
        setMinDistance(storedDistance || String(DEFAULT_PROXIMITY_MIN_DISTANCE_M));
      } catch (err) {
        setError(err.message || 'โหลดค่าไม่สำเร็จ');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    const n = Number(minDistance);
    if (!Number.isFinite(n) || n < 1) {
      setError('กรอกระยะห่างเป็นเมตร ตั้งแต่ 1 ขึ้นไป');
      return;
    }
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await Promise.all([
        setConfigValue(supabase, 'exam_proximity_check_enabled', enabled ? 'true' : 'false'),
        setConfigValue(supabase, 'exam_proximity_min_distance_m', String(n)),
      ]);
      setSaved(true);
    } catch (err) {
      setError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 text-white flex items-center justify-center shrink-0">
          <MapPinIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">ตรวจสอบตำแหน่งนักเรียน (สอบที่บ้าน)</div>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        สวิตช์นี้คุมทั้งระบบ — ถ้าปิด ครูจะไม่เห็นตัวเลือก &quot;บังคับแชร์ตำแหน่งก่อนเข้าสอบ&quot; ที่หน้า &quot;จัดสอบ&quot; เลย และรอบสอบที่เคยตั้งไว้ก็จะไม่บังคับอีกต่อไป ถ้าเปิดไว้ ครูจะเลือกเปิด/ปิดเป็นรายรอบสอบได้เอง — เมื่อรอบไหนเปิดใช้ นักเรียนต้องอนุญาตแชร์ตำแหน่งจึงจะเข้าสอบได้ ถ้านักเรียนสองคนขึ้นไปในรอบสอบเดียวกันอยู่ใกล้กันน้อยกว่าระยะที่ตั้งไว้ด้านล่างนี้ ระบบจะขึ้นป้ายเตือนในหน้าคุมสอบให้ครูตรวจสอบเอง ไม่ได้บล็อกการสอบอัตโนมัติ
      </p>
      {loading ? (
        <div className="text-sm text-gray-500">กำลังโหลด...</div>
      ) : (
        <>
          <label className="flex items-center gap-3 cursor-pointer select-none mb-3">
            <span
              role="switch" aria-checked={enabled}
              onClick={() => { setEnabled(v => !v); setSaved(false); }}
              className={"relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors " + (enabled ? 'bg-indigo-600' : 'bg-gray-300')}
            >
              <span className={"inline-block h-4 w-4 transform rounded-full bg-white transition-transform " + (enabled ? 'translate-x-6' : 'translate-x-1')} />
            </span>
            <span className="text-sm text-gray-700">เปิดใช้งานฟีเจอร์นี้ทั้งระบบ</span>
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-700">แจ้งเตือนเมื่อห่างกันน้อยกว่า</label>
            <input
              type="number" min={1} step={1}
              className="w-20 px-2.5 py-2 border border-gray-300 rounded-lg text-sm text-center focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={minDistance}
              onChange={e => { setMinDistance(e.target.value); setSaved(false); }}
            />
            <span className="text-sm text-gray-700">เมตร</span>
            <button type="button" className="bg-indigo-600 text-white px-3 py-2 rounded-md text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50" onClick={handleSave} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
          </div>
          {error && <div className="text-sm text-red-600 mt-2">{error}</div>}
          {saved && <div className="text-sm text-green-600 mt-2">บันทึกแล้ว</div>}
        </>
      )}
    </div>
  );
}

function TagIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12.59 2.59a2 2 0 0 0-1.42-.59H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.41l9 9a2 2 0 0 0 2.82 0l7.17-7.17a2 2 0 0 0 0-2.82Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

function ListIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  );
}

const MAX_LOGO_FILE_BYTES = 300 * 1024;

// Deliberately its own config keys (exam_app_*), never the shared
// config.school_name/config.logo_url the ปพ.5-family app already uses live
// on this same project — the admin explicitly asked for this system's
// branding to stay separate rather than shared.
function BrandingPanel() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [logo, setLogo] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [logoBusy, setLogoBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await getConfigValues(supabase, ['exam_app_name', 'exam_app_description', 'exam_app_logo']);
        setName(cfg.exam_app_name || '');
        setDescription(cfg.exam_app_description || '');
        setLogo(cfg.exam_app_logo || '');
      } catch (err) {
        setError(err.message || 'โหลดค่าไม่สำเร็จ');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await Promise.all([
        setConfigValue(supabase, 'exam_app_name', name.trim()),
        setConfigValue(supabase, 'exam_app_description', description.trim()),
      ]);
      setSaved(true);
    } catch (err) {
      setError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('เลือกไฟล์รูปภาพเท่านั้น');
      return;
    }
    setLogoBusy(true);
    try {
      // Always through the resizer, even for an already-small file — a
      // logo only ever displays a few dozen pixels tall, so this also
      // normalizes oversized dimensions, not just oversized bytes.
      const dataUrl = await resizeImageToFit(file, { maxBytes: MAX_LOGO_FILE_BYTES });
      await setConfigValue(supabase, 'exam_app_logo', dataUrl);
      setLogo(dataUrl);
    } catch (err) {
      setError(err.message || 'อัพโหลดโลโก้ไม่สำเร็จ');
    } finally {
      setLogoBusy(false);
    }
  }

  async function handleRemoveLogo() {
    setLogoBusy(true);
    setError(null);
    try {
      await setConfigValue(supabase, 'exam_app_logo', '');
      setLogo('');
    } catch (err) {
      setError(err.message || 'ลบโลโก้ไม่สำเร็จ');
    } finally {
      setLogoBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-sky-600 to-cyan-500 text-white flex items-center justify-center shrink-0">
          <TagIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">ชื่อระบบ คำอธิบาย และโลโก้</div>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        ปรับแต่งชื่อและโลโก้ที่แสดงในเมนูของระบบสอบนี้โดยเฉพาะ ไม่เกี่ยวกับระบบอื่น ถ้าไม่ตั้งค่า จะใช้ชื่อเริ่มต้น &ldquo;ระบบสอบวัดผล&rdquo;
      </p>
      {loading ? (
        <div className="text-sm text-gray-500">กำลังโหลด...</div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">ชื่อระบบ</label>
            <input
              type="text"
              className="px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={name}
              onChange={e => { setName(e.target.value); setSaved(false); }}
              placeholder="ระบบสอบวัดผล"
              maxLength={80}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">คำอธิบาย (แสดงเป็นคำโปรยเล็กๆ)</label>
            <input
              type="text"
              className="px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              value={description}
              onChange={e => { setDescription(e.target.value); setSaved(false); }}
              placeholder="เช่น ระบบตรวจข้อสอบและสอบออนไลน์ของโรงเรียน"
              maxLength={160}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">โลโก้</label>
            <div className="flex items-center gap-3">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logo} alt="โลโก้ระบบ" className="h-12 w-12 rounded-lg object-contain border border-gray-200 bg-white" />
              ) : (
                <div className="h-12 w-12 rounded-lg border border-dashed border-gray-300 flex items-center justify-center text-[10px] text-gray-400 text-center">ไม่มีโลโก้</div>
              )}
              <label className={btnTiny + ' cursor-pointer inline-flex items-center'}>
                {logoBusy ? 'กำลังอัพโหลด...' : 'อัพโหลดโลโก้'}
                <input type="file" accept="image/*" className="hidden" onChange={handleLogoFile} disabled={logoBusy} />
              </label>
              {logo && (
                <button type="button" className={btnTiny} onClick={handleRemoveLogo} disabled={logoBusy}>ลบโลโก้</button>
              )}
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">ไฟล์รูปภาพ — ถ้าไฟล์ใหญ่เกินไป ระบบจะย่อขนาดให้อัตโนมัติ</div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button type="button" className="bg-indigo-600 text-white px-3 py-2 rounded-md text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50" onClick={handleSave} disabled={saving}>
              {saving ? 'กำลังบันทึก...' : 'บันทึกชื่อ/คำอธิบาย'}
            </button>
            {saved && <span className="text-sm text-green-600">บันทึกแล้ว</span>}
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
      )}
    </div>
  );
}

function formatLogTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Bangkok' });
  } catch {
    return iso;
  }
}

function ClockIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

// last_login_at is shared with the ปพ.5 system on this same Supabase
// project — a teacher logging into either app updates the same column, so
// this reflects the most recent login to the school system as a whole, not
// just this exam app.
function LastLoginPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listTeacherLastLogins(supabase));
    } catch (err) {
      setError(err.message || 'โหลดรายการไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-cyan-600 to-teal-500 text-white flex items-center justify-center shrink-0">
            <ClockIcon className="h-4 w-4" />
          </div>
          <div className="font-semibold text-gray-900">ครูเข้าสู่ระบบล่าสุด</div>
        </div>
        <button type="button" className={btnTiny} onClick={refresh}>รีเฟรช</button>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        เวลาที่แต่ละครูเข้าสู่ระบบล่าสุด (ใช้ร่วมกับระบบ ปพ.5 — เข้าระบบไหนก็อัปเดตเวลานี้เหมือนกัน) เรียงจากเข้าล่าสุดไปเก่าสุด
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && rows.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีข้อมูล</div>}
      {rows.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          <div className="divide-y divide-gray-100">
            {rows.map(r => (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm py-2">
                <span className="font-medium text-gray-900 truncate">{r.full_name || '(ไม่ระบุชื่อ)'}</span>
                <span className="text-xs text-gray-500 shrink-0">{r.last_login_at ? formatLogTimestamp(r.last_login_at) : 'ยังไม่เคยเข้าสู่ระบบ'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ExamAuditLogPanel() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listExamAuditLog(supabase));
    } catch (err) {
      setError(err.message || 'โหลด log ไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-slate-600 to-gray-500 text-white flex items-center justify-center shrink-0">
            <ListIcon className="h-4 w-4" />
          </div>
          <div className="font-semibold text-gray-900">Log ระบบการสอบ</div>
        </div>
        <button type="button" className={btnTiny} onClick={refresh}>รีเฟรช</button>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        เหตุการณ์ล่าสุดของระบบสอบออนไลน์ (เข้าสอบ สลับหน้าจอ ปลดล็อก ส่งข้อสอบ) แสดง 200 รายการล่าสุด
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && rows.length === 0 && <div className="text-sm text-gray-500">ยังไม่มี log</div>}
      {rows.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          <div className="divide-y divide-gray-100">
            {rows.map(r => (
              <div key={r.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-gray-900">{EXAM_AUDIT_ACTION_LABEL[r.action] || r.action}</span>
                  <span className="text-xs text-gray-400 shrink-0">{formatLogTimestamp(r.created_at)}</span>
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {r.actor_name || 'ไม่ทราบผู้กระทำ'}{r.detail ? ` · ${r.detail}` : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsContent() {
  const { isAdmin } = useAuth();

  if (!isAdmin) {
    return (
      <div className="max-w-lg rounded-xl border border-red-200 bg-red-50 p-5 flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-rose-500 text-white flex items-center justify-center shrink-0">
          <LockIcon className="h-4 w-4" />
        </div>
        <div>
          <div className="font-semibold text-red-700">ไม่มีสิทธิ์เข้าถึงหน้านี้</div>
          <div className="mt-1 text-sm text-red-600">เมนูตั้งค่าใช้ได้เฉพาะผู้ดูแลระบบ (แอดมิน) เท่านั้น</div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-900">ตั้งค่าระบบ</h1>
      <p className="mt-1 text-sm text-gray-500">สำหรับผู้ดูแลระบบเท่านั้น</p>

      <BrandingPanel />
      <QuizzesPanel />
      <ScanPhotosPanel />
      <AISettingsPanel />
      <ExamSecurityPanel />
      <ExamProximityCheckPanel />
      <LastLoginPanel />
      <ExamAuditLogPanel />
    </div>
  );
}

export default function SettingsPage() {
  return (
    <DashboardShell>
      <SettingsContent />
    </DashboardShell>
  );
}
