'use client';
// ExamProctorAssignmentTool.jsx — "จัดครูคุมสอบ": admin assigns which
// teacher proctors which ชั้น/ห้อง on which date, for exams in the school
// timetable. Moved out of the "ตั้งค่า" settings page into its own menu
// item (under "ตารางคุมสอบ") since assigning proctors is a routine,
// frequent task, not a one-off system setting.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { listProctorAssignmentsForDate, saveProctorAssignment, deleteProctorAssignment, listGradeRoomOptions, listAllTeachers } from '../lib/exam-db';
import { formatGradeRoom } from '../lib/format';

const card = 'bg-white border border-gray-200 rounded-xl p-4 sm:p-5 mb-4';
const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200';
const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';

function UsersIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M15 13.5a6.5 6.5 0 0 1 6.5 6.5" />
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

function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

export default function ExamProctorAssignmentTool() {
  const { isAdmin } = useAuth();

  const [date, setDate] = useState(() => todayBangkok());
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [gradeRoomOptions, setGradeRoomOptions] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [gradeRoomKey, setGradeRoomKey] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      setAssignments(await listProctorAssignmentsForDate(supabase, d));
    } catch (err) {
      setError(err.message || 'โหลดรายชื่อครูคุมสอบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(date); }, [date, refresh]);

  useEffect(() => {
    (async () => {
      try {
        const [options, teacherList] = await Promise.all([listGradeRoomOptions(supabase), listAllTeachers(supabase)]);
        setGradeRoomOptions(options);
        setTeachers(teacherList);
      } catch {
        // best-effort
      }
    })();
  }, []);

  async function handleAssign() {
    if (!gradeRoomKey || !teacherId) return;
    const [gradeLevel, room] = gradeRoomKey.split('|');
    setSaving(true);
    setError(null);
    try {
      await saveProctorAssignment(supabase, { date, gradeLevel, room, teacherId });
      setTeacherId('');
      await refresh(date);
    } catch (err) {
      setError(err.message || 'มอบหมายไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id) {
    try {
      await deleteProctorAssignment(supabase, id);
      await refresh(date);
    } catch {
      // best-effort
    }
  }

  if (!isAdmin) {
    return (
      <div className="max-w-lg rounded-xl border border-red-200 bg-red-50 p-5 flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-rose-500 text-white flex items-center justify-center shrink-0">
          <LockIcon className="h-4 w-4" />
        </div>
        <div>
          <div className="font-semibold text-red-700">ไม่มีสิทธิ์เข้าถึงหน้านี้</div>
          <div className="mt-1 text-sm text-red-600">เมนูจัดครูคุมสอบใช้ได้เฉพาะผู้ดูแลระบบ (แอดมิน) เท่านั้น</div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-teal-500 to-emerald-500 text-white flex items-center justify-center shrink-0">
          <UsersIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">จัดครูคุมสอบ</h1>
          <p className="text-sm text-gray-500">มอบหมายครูคุมสอบ (สอบในตาราง)</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        <p className="text-sm text-gray-500 mb-4">
          มอบหมายว่าวันไหน ครูคนไหนคุมสอบชั้น/ห้องไหน — ครูที่ได้รับมอบหมายจะเห็นหน้ามอนิเตอร์คุมสอบของห้องนั้นในวันนั้นได้ ไม่ว่าจะเป็นรอบสอบในตารางหรือนอกตารางที่จัดในห้องเดียวกันวันนั้น ส่วนรอบสอบนอกตาราง ครูที่สร้างข้อสอบดูมอนิเตอร์ของตัวเองได้อยู่แล้วโดยไม่ต้องมอบหมาย
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">วันที่</label>
            <input type="date" className={inputCls} value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">ชั้น/ห้อง</label>
            <select className={inputCls} value={gradeRoomKey} onChange={e => setGradeRoomKey(e.target.value)}>
              <option value="">— เลือกชั้น/ห้อง —</option>
              {gradeRoomOptions.map(o => (
                <option key={`${o.grade_level}|${o.room}`} value={`${o.grade_level}|${o.room}`}>
                  ชั้น {formatGradeRoom(o.grade_level, o.room)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">ครูคุมสอบ</label>
            <select className={inputCls} value={teacherId} onChange={e => setTeacherId(e.target.value)}>
              <option value="">— เลือกครู —</option>
              {teachers.map(t => (
                <option key={t.id} value={t.id}>{t.full_name || '(ไม่ระบุชื่อ)'}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="bg-indigo-600 text-white px-3 py-2 rounded-md text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
            disabled={!gradeRoomKey || !teacherId || saving}
            onClick={handleAssign}
          >
            {saving ? 'กำลังมอบหมาย...' : 'มอบหมาย'}
          </button>
        </div>

        {error && <div className="text-sm text-red-600 mt-3">{error}</div>}

        <div className="mt-4">
          {loading ? (
            <div className="text-sm text-gray-500">กำลังโหลด...</div>
          ) : assignments.length === 0 ? (
            <div className="text-sm text-gray-500">ยังไม่มีการมอบหมายครูคุมสอบในวันที่เลือก</div>
          ) : (
            <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
              {assignments.map(a => (
                <div key={a.id} className="flex items-center justify-between gap-3 text-sm px-3 py-2">
                  <div>
                    <span className="font-semibold text-gray-900">ชั้น {formatGradeRoom(a.grade_level, a.room)}</span>
                    <span className="text-gray-500"> — {a.profiles?.full_name || '(ไม่ระบุชื่อ)'}</span>
                  </div>
                  <button className={btnTiny} onClick={() => handleRemove(a.id)}>ลบ</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
