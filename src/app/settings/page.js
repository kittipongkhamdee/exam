'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { listAllScanPhotos, getScanPhotoUrl, deleteScanPhoto, listAllQuizzes, deleteQuiz } from '@/lib/omr-db';
import ConfirmDialog from '@/components/ConfirmDialog';

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

function TeacherGroupHeader({ name, count }) {
  return (
    <div className="flex items-center gap-2 pt-3 pb-1.5 first:pt-0">
      <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">{name}</span>
      <span className="text-[11px] text-gray-400">({count})</span>
      <div className="h-px flex-1 bg-gray-100" />
    </div>
  );
}

function ScanPhotosPanel() {
  const [photos, setPhotos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

  async function handleDelete(id, photoPath) {
    await deleteScanPhoto(supabase, id, photoPath);
    refresh();
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-purple-600 to-fuchsia-500 text-white flex items-center justify-center shrink-0">
          <PhotoIcon className="h-4 w-4" />
        </div>
        <div className="font-semibold text-gray-900">รูปกระดาษคำตอบที่ครูเก็บไว้ทั้งหมด</div>
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        เฉพาะครูที่เปิด &ldquo;เก็บรูปกระดาษคำตอบไว้ดูย้อนหลัง&rdquo; ในหน้าสแกนตรวจเท่านั้นที่จะมีรูปที่นี่ แอดมินลบรูปของครูคนใดก็ได้ (ข้อมูลคะแนน/เฉลยไม่หาย ลบแค่รูป)
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && photos.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีรูปที่เก็บไว้</div>}
      {photos.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          {groupByTeacher(photos, p => p.profiles?.full_name).map(group => (
            <div key={group.name}>
              <TeacherGroupHeader name={group.name} count={group.rows.length} />
              {group.rows.map(p => (
                <div key={p.id} className="flex justify-between items-center text-sm py-2 border-b border-gray-100 last:border-b-0">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">
                      {p.students?.student_code} {p.students?.prefix}{p.students?.student_name}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {p.omr_quizzes?.title} · {p.omr_quizzes?.subjects?.subject_name} ({p.omr_quizzes?.subjects?.grade_level}/{p.omr_quizzes?.subjects?.room})
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    <span className="text-xs text-gray-500">{p.total_correct} ({p.score}%)</span>
                    <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => handleView(p.photo_path)}>
                      <EyeIcon className="h-3.5 w-3.5" /> ดูรูป
                    </button>
                    <button className={btnTiny + ' inline-flex items-center gap-1'} onClick={() => handleDelete(p.id, p.photo_path)}>
                      <TrashIcon className="h-3.5 w-3.5" /> ลบรูป
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function QuizzesPanel() {
  const [quizzes, setQuizzes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null); // { id, title } | null

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
      </div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        รายการชุดข้อสอบของครูทุกคน แอดมินลบชุดข้อสอบของครูคนใดก็ได้ (ลบแล้วเฉลย ผลตรวจ และรูปที่เก็บไว้ของชุดนั้นจะหายไปทั้งหมด กู้คืนไม่ได้)
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && quizzes.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีชุดข้อสอบในระบบ</div>}
      {quizzes.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          {groupByTeacher(quizzes, q => q.teacherName).map(group => (
            <div key={group.name}>
              <TeacherGroupHeader name={group.name} count={group.rows.length} />
              {group.rows.map(q => (
                <div key={q.id} className="flex justify-between items-center text-sm py-2 border-b border-gray-100 last:border-b-0">
                  <div className="min-w-0">
                    <div className="font-medium text-gray-900 truncate">{q.title}</div>
                    <div className="text-xs text-gray-500 truncate">
                      {q.subjects?.subject_name} ({q.subjects?.grade_level}/{q.subjects?.room}) · {q.num_questions} ข้อ
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
          ))}
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
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900">ตั้งค่าระบบ</h1>
      <p className="mt-1 text-sm text-gray-500">สำหรับผู้ดูแลระบบเท่านั้น</p>

      <QuizzesPanel />
      <ScanPhotosPanel />
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
