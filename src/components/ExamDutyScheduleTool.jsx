'use client';
// ExamDutyScheduleTool.jsx — "ตารางคุมสอบ": a school-wide exam schedule
// board for a given date, every ชั้น/ห้อง and every subject at once, not
// scoped to the current teacher's own subjects or an admin-assigned
// proctor duty like ExamMonitorTool's ชั้น/ห้อง mode is. Any signed-in
// teacher can open this to see (and print) who's examining what, where,
// and when today, PIN and รหัสปลดล็อก included — see listExamDaySchedule's
// own comment in exam-db.js for why that's a deliberately looser read
// than the live monitor's per-room authorization.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { listExamDaySchedule } from '../lib/exam-db';

function CalendarIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
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

function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function formatThaiDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('th-TH', { dateStyle: 'long' });
}

function formatTime(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString('th-TH', { timeStyle: 'short' });
}

function groupByRoom(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.grade_level}|${r.room}`;
    if (!groups.has(key)) groups.set(key, { gradeLevel: r.grade_level, room: r.room, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()];
}

function ScheduleTable({ rows, className }) {
  return (
    <table className={'w-full text-sm border border-gray-300 border-collapse ' + (className || '')}>
      <thead>
        <tr className="bg-gray-100">
          <th className="border border-gray-300 px-2 py-1 text-left">เวลาสอบ</th>
          <th className="border border-gray-300 px-2 py-1 text-left">วิชา</th>
          <th className="border border-gray-300 px-2 py-1 text-left">เวลาทำ/คน</th>
          <th className="border border-gray-300 px-2 py-1 text-left">PIN เข้าสอบ</th>
          <th className="border border-gray-300 px-2 py-1 text-left">รหัสปลดล็อก</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.round_id}>
            <td className="border border-gray-300 px-2 py-1">{formatTime(r.opens_at)} – {formatTime(r.closes_at)}</td>
            <td className="border border-gray-300 px-2 py-1">{r.exam_set_title} — {r.subject_name}</td>
            <td className="border border-gray-300 px-2 py-1">{r.duration_minutes} นาที</td>
            <td className="border border-gray-300 px-2 py-1 font-mono font-bold">{r.pin}</td>
            <td className="border border-gray-300 px-2 py-1 font-mono font-bold text-amber-700">{r.unlock_pin}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Rendered twice deliberately, once for screen and once print-only —
// same pattern as ExamScheduleTool's PrintableRoundSheet — so the printed
// page doesn't inherit the on-screen card chrome (rounded corners, colored
// pills) that only makes sense on a monitor.
function PrintableSchedule({ date, groups }) {
  return (
    <div className="hidden print:block p-6">
      <h1 className="text-lg font-bold mb-1">ตารางคุมสอบ</h1>
      <p className="text-sm text-gray-600 mb-4">วันที่ {formatThaiDate(date)}</p>
      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">ไม่มีรอบสอบในวันที่เลือก</p>
      ) : (
        <div className="space-y-5">
          {groups.map(g => (
            <div key={`${g.gradeLevel}|${g.room}`} className="break-inside-avoid">
              <div className="font-bold text-sm mb-1">ชั้น {g.gradeLevel}/{g.room}</div>
              <ScheduleTable rows={g.rows} className="mb-2" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExamDutyScheduleTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1';

  const [date, setDate] = useState(() => todayBangkok());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async (d) => {
    setLoading(true);
    setError(null);
    try {
      setRows(await listExamDaySchedule(supabase, d));
    } catch (err) {
      setError(err.message || 'โหลดตารางคุมสอบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(date); }, [date, refresh]);

  const groups = groupByRoom(rows);

  return (
    <>
    <div className="max-w-5xl print:hidden">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white flex items-center justify-center shrink-0">
          <CalendarIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">ตารางคุมสอบ</h1>
          <p className="text-sm text-gray-500">ทุกวิชา ทุกชั้น/ห้อง ที่สอบในวันที่เลือก — ครูทุกคนดูได้</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">วันที่</label>
            <input type="date" className={inputCls} value={date} onChange={e => setDate(e.target.value)} />
          </div>
          {rows.length > 0 && (
            <button type="button" className={btnTiny} onClick={() => window.print()}>
              <PrinterIcon className="h-3.5 w-3.5" /> พิมพ์ตารางคุมสอบ
            </button>
          )}
        </div>
      </div>

      {loading && <div className={card}><div className="text-sm text-gray-500">กำลังโหลด...</div></div>}
      {error && <div className={card}><div className="text-sm text-red-600">{error}</div></div>}

      {!loading && !error && groups.length === 0 && (
        <div className={card}><div className="text-sm text-gray-500">ไม่มีรอบสอบในวันที่เลือก</div></div>
      )}

      {!loading && groups.map(g => (
        <div key={`${g.gradeLevel}|${g.room}`} className={card}>
          <div className="font-semibold text-gray-900 mb-3">ชั้น {g.gradeLevel}/{g.room}</div>
          <div className="overflow-x-auto">
            <ScheduleTable rows={g.rows} />
          </div>
        </div>
      ))}
    </div>
    <PrintableSchedule date={date} groups={groups} />
    </>
  );
}
