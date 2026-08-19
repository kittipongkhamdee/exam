'use client';

import { useCallback, useEffect, useState } from 'react';
import DashboardShell from '@/components/DashboardShell';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { listAllScanPhotos, getScanPhotoUrl, deleteScanPhoto, listAllQuizzes, deleteQuiz } from '@/lib/omr-db';
import ConfirmDialog from '@/components/ConfirmDialog';

const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200';

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
      <div className="font-semibold text-gray-900">รูปกระดาษคำตอบที่ครูเก็บไว้ทั้งหมด</div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        เฉพาะครูที่เปิด &ldquo;เก็บรูปกระดาษคำตอบไว้ดูย้อนหลัง&rdquo; ในหน้าสแกนตรวจเท่านั้นที่จะมีรูปที่นี่ แอดมินลบรูปของครูคนใดก็ได้ (ข้อมูลคะแนน/เฉลยไม่หาย ลบแค่รูป)
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && photos.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีรูปที่เก็บไว้</div>}
      {photos.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          {photos.map(p => (
            <div key={p.id} className="flex justify-between items-center text-sm py-2 border-b border-gray-100 last:border-b-0">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">
                  {p.students?.student_code} {p.students?.prefix}{p.students?.student_name}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {p.omr_quizzes?.title} · {p.omr_quizzes?.subjects?.subject_name} ({p.omr_quizzes?.subjects?.grade_level}/{p.omr_quizzes?.subjects?.room})
                  {' · ครู: '}{p.profiles?.full_name || 'ไม่ทราบ'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <span className="text-xs text-gray-500">{p.total_correct} ({p.score}%)</span>
                <button className={btnTiny} onClick={() => handleView(p.photo_path)}>ดูรูป</button>
                <button className={btnTiny} onClick={() => handleDelete(p.id, p.photo_path)}>ลบรูป</button>
              </div>
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
      <div className="font-semibold text-gray-900">ชุดข้อสอบทั้งหมดในระบบ</div>
      <p className="mt-1 text-sm text-gray-500 mb-4">
        รายการชุดข้อสอบของครูทุกคน แอดมินลบชุดข้อสอบของครูคนใดก็ได้ (ลบแล้วเฉลย ผลตรวจ และรูปที่เก็บไว้ของชุดนั้นจะหายไปทั้งหมด กู้คืนไม่ได้)
      </p>
      {loading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}
      {!loading && quizzes.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีชุดข้อสอบในระบบ</div>}
      {quizzes.length > 0 && (
        <div className="max-h-96 overflow-y-auto -mx-5 px-5">
          {quizzes.map(q => (
            <div key={q.id} className="flex justify-between items-center text-sm py-2 border-b border-gray-100 last:border-b-0">
              <div className="min-w-0">
                <div className="font-medium text-gray-900 truncate">{q.title}</div>
                <div className="text-xs text-gray-500 truncate">
                  {q.subjects?.subject_name} ({q.subjects?.grade_level}/{q.subjects?.room}) · {q.num_questions} ข้อ
                  {' · ครู: '}{q.teacherName || 'ไม่ทราบ'}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <button className={btnTiny} onClick={() => setConfirmTarget({ id: q.id, title: q.title })} disabled={deletingId === q.id}>
                  {deletingId === q.id ? 'กำลังลบ...' : 'ลบ'}
                </button>
              </div>
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
      <div className="max-w-lg rounded-xl border border-red-200 bg-red-50 p-5">
        <div className="font-semibold text-red-700">ไม่มีสิทธิ์เข้าถึงหน้านี้</div>
        <div className="mt-1 text-sm text-red-600">เมนูตั้งค่าใช้ได้เฉพาะผู้ดูแลระบบ (แอดมิน) เท่านั้น</div>
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
