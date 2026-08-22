'use client';
// ExamMonitorTool.jsx — "คุมสอบ": a live, auto-updating view for a teacher
// physically proctoring an online exam, in one of two modes:
//
//   - รายรอบ (round): watch one รอบสอบ — typically a teacher watching their
//     own นอกตาราง (ad-hoc) exam.
//   - ชั้น/ห้อง (room): watch every รอบสอบ opening in a given ชั้น/ห้อง on a
//     given date — for a teacher the admin assigned to proctor that room
//     (Settings → มอบหมายครูคุมสอบ), covering ในตาราง exams and any อื่น ๆ
//     happening in the same room that day, regardless of who created them.
//
// Both modes reuse getRoundMonitor/getRoomMonitor (exam-db.js), whose read
// access is enforced server-side by RLS (owner, admin, or a matching
// online_exam_proctor_assignments row) — this component never decides who
// gets to see what, it just renders whatever the database returns.
//
// Cards update live via a Supabase Realtime subscription per visible
// round_id on online_exam_attempts — a lock/submit/violation shows up
// without a manual refresh. A card flipping to "locked" also fires a short
// beep + toast so a proctor watching several rooms doesn't have to stare at
// the grid.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import { supabase } from '../lib/supabaseClient';
import {
  getRoundMonitor, getRoomMonitor, listMonitorableRounds,
  proctorUnlockAttempt, listProctorAssignmentsForDate,
} from '../lib/exam-db';

function MonitorIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
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

function PrinterIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 9V3h12v6" />
      <rect x="4" y="9" width="16" height="8" rx="1.5" />
      <path d="M6 14h12v7H6z" />
    </svg>
  );
}

// Print-only sheet ("พิมพ์ตารางคุมสอบ") for the assigned proctor of a
// ชั้น/ห้อง — every วิชา examined in that room that day, not just the
// current teacher's own, since a room-mode proctor is covering the whole
// room regardless of who set each exam up (mirrors what roomMonitors
// itself already shows on screen; this just adds the PIN/รหัสปลดล็อก a
// proctor needs on paper without staying logged into the monitor page).
function PrintableRoomSchedule({ date, gradeLevel, room, monitors }) {
  return (
    <div className="hidden print:block p-6">
      <h1 className="text-lg font-bold mb-1">ตารางคุมสอบ ชั้น {gradeLevel}/{room}</h1>
      <p className="text-sm text-gray-600 mb-4">วันที่ {formatThaiDate(date)}</p>
      {monitors.length === 0 ? (
        <p className="text-sm text-gray-500">ไม่มีรอบสอบในวันที่เลือก</p>
      ) : (
        <table className="w-full text-sm border border-gray-400 border-collapse">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-gray-400 px-2 py-1 text-left">เวลาสอบ</th>
              <th className="border border-gray-400 px-2 py-1 text-left">วิชา</th>
              <th className="border border-gray-400 px-2 py-1 text-left">เวลาทำ/คน</th>
              <th className="border border-gray-400 px-2 py-1 text-left">PIN เข้าสอบ</th>
              <th className="border border-gray-400 px-2 py-1 text-left">รหัสปลดล็อก</th>
            </tr>
          </thead>
          <tbody>
            {monitors.map(m => (
              <tr key={m.id}>
                <td className="border border-gray-400 px-2 py-1">{formatTime(m.opens_at)} – {formatTime(m.closes_at)}</td>
                <td className="border border-gray-400 px-2 py-1">{m.exam_set_title} — {m.subject_name}</td>
                <td className="border border-gray-400 px-2 py-1">{m.duration_minutes} นาที</td>
                <td className="border border-gray-400 px-2 py-1 font-mono font-bold">{m.pin}</td>
                <td className="border border-gray-400 px-2 py-1 font-mono font-bold">{m.unlock_pin}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function formatThai(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTime(isoString) {
  if (!isoString) return '';
  return new Date(isoString).toLocaleTimeString('th-TH', { timeStyle: 'short' });
}

function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function formatThaiDate(dateStr) {
  if (!dateStr) return '';
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('th-TH', { dateStyle: 'long' });
}

function playAlertBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // best-effort — some browsers block audio before any user gesture
  }
}

function StudentCard({ row, onUnlock, unlocking }) {
  let cls = 'bg-gray-50 border-gray-200 text-gray-500';
  let statusLabel = 'ยังไม่เข้าสอบ';
  if (row.status === 'submitted') {
    cls = 'bg-green-50 border-green-200 text-green-700';
    statusLabel = 'ส่งแล้ว';
  } else if (row.locked) {
    cls = 'bg-red-50 border-red-300 text-red-700 animate-pulse';
    statusLabel = 'ถูกล็อก';
  } else if (row.status === 'in_progress') {
    cls = 'bg-sky-50 border-sky-200 text-sky-700';
    statusLabel = 'กำลังทำ';
  }

  return (
    <div className={'rounded-lg border px-3 py-2.5 text-sm ' + cls}>
      <div className="font-semibold text-gray-900 truncate" title={row.student_name}>{row.student_name}</div>
      <div className="text-xs font-mono text-gray-500">{row.student_code}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-xs font-bold">{statusLabel}</span>
        {row.status === 'submitted' && row.score !== null && (
          <span className="text-xs font-bold text-gray-700">{row.score}%</span>
        )}
      </div>
      {row.violation_count > 0 && (
        <div className="mt-1 text-xs font-bold text-red-600">สลับหน้าจอ {row.violation_count} ครั้ง</div>
      )}
      {row.locked && (
        <button
          type="button"
          className="mt-2 w-full inline-flex items-center justify-center gap-1 bg-red-600 text-white text-xs font-bold px-2 py-1.5 rounded-md hover:bg-red-700 disabled:opacity-50"
          disabled={unlocking}
          onClick={() => onUnlock(row.attempt_id)}
        >
          <LockIcon className="h-3.5 w-3.5" /> {unlocking ? 'กำลังปลดล็อก...' : 'ปลดล็อก'}
        </button>
      )}
    </div>
  );
}

function RoundMonitorCard({ monitor, onUnlockDone }) {
  const [unlockingId, setUnlockingId] = useState(null);

  async function handleUnlock(attemptId) {
    setUnlockingId(attemptId);
    try {
      await proctorUnlockAttempt(supabase, attemptId);
      onUnlockDone();
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'ปลดล็อกไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setUnlockingId(null);
    }
  }

  const submitted = monitor.rows.filter(r => r.status === 'submitted').length;
  const locked = monitor.rows.filter(r => r.locked).length;
  const inProgress = monitor.rows.filter(r => r.status === 'in_progress' && !r.locked).length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="font-semibold text-gray-900">{monitor.exam_set_title}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {monitor.subject_name} (ชั้น {monitor.grade_level}/{monitor.room}) · {formatTime(monitor.opens_at)} – {formatTime(monitor.closes_at)}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          <span className="font-bold text-green-700">{submitted}<span className="text-gray-500 font-normal"> ส่งแล้ว</span></span>
          <span className="font-bold text-sky-700">{inProgress}<span className="text-gray-500 font-normal"> กำลังทำ</span></span>
          {locked > 0 && <span className="font-bold text-red-600">{locked}<span className="text-gray-500 font-normal"> ถูกล็อก</span></span>}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
        {monitor.rows.map(row => (
          <StudentCard key={row.student_id} row={row} onUnlock={handleUnlock} unlocking={unlockingId === row.attempt_id} />
        ))}
      </div>
    </div>
  );
}

export default function ExamMonitorTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
  const modeBtn = 'px-4 py-2 rounded-lg text-sm font-bold transition';

  const [mode, setMode] = useState('round');

  const [rounds, setRounds] = useState([]);
  const [roundId, setRoundId] = useState('');
  const [roundMonitor, setRoundMonitor] = useState(null);

  const [date, setDate] = useState(() => todayBangkok());
  const [roomOptions, setRoomOptions] = useState([]);
  const [gradeRoomKey, setGradeRoomKey] = useState('');
  const [roomMonitors, setRoomMonitors] = useState([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const lockedByAttempt = useRef(new Map());

  useEffect(() => {
    (async () => {
      try {
        setRounds(await listMonitorableRounds(supabase));
      } catch {
        // best-effort
      }
    })();
  }, []);

  useEffect(() => {
    if (mode !== 'room') return;
    (async () => {
      try {
        const assignments = await listProctorAssignmentsForDate(supabase, date);
        const seen = new Map();
        for (const a of assignments) {
          const key = `${a.grade_level}|${a.room}`;
          if (!seen.has(key)) seen.set(key, { grade_level: a.grade_level, room: a.room });
        }
        setRoomOptions([...seen.values()]);
      } catch {
        setRoomOptions([]);
      }
    })();
  }, [mode, date]);

  const noteViolations = useCallback((monitors) => {
    for (const m of monitors) {
      for (const row of m.rows) {
        if (!row.attempt_id) continue;
        const prevLocked = lockedByAttempt.current.get(row.attempt_id);
        if (row.locked && prevLocked === false) {
          playAlertBeep();
          Swal.fire({
            toast: true, position: 'top-end', timer: 4000, showConfirmButton: false,
            icon: 'warning', title: `${row.student_name} ถูกล็อก (สลับหน้าจอ)`,
          });
        }
        lockedByAttempt.current.set(row.attempt_id, row.locked);
      }
    }
  }, []);

  const refreshRoundMode = useCallback(async (id) => {
    if (!id) { setRoundMonitor(null); return; }
    setLoading(true);
    setError(null);
    try {
      const m = await getRoundMonitor(supabase, id);
      noteViolations([m]);
      setRoundMonitor(m);
    } catch (err) {
      setError(err.message || 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, [noteViolations]);

  const refreshRoomMode = useCallback(async (d, key) => {
    if (!key) { setRoomMonitors([]); return; }
    const [gradeLevel, room] = key.split('|');
    setLoading(true);
    setError(null);
    try {
      const ms = await getRoomMonitor(supabase, { date: d, gradeLevel, room });
      noteViolations(ms);
      setRoomMonitors(ms);
    } catch (err) {
      setError(err.message || 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, [noteViolations]);

  useEffect(() => { if (mode === 'round') refreshRoundMode(roundId); }, [mode, roundId, refreshRoundMode]);
  useEffect(() => { if (mode === 'room') refreshRoomMode(date, gradeRoomKey); }, [mode, date, gradeRoomKey, refreshRoomMode]);

  const visibleRoundIds = useMemo(() => {
    if (mode === 'round') return roundId ? [roundId] : [];
    return roomMonitors.map(m => m.id);
  }, [mode, roundId, roomMonitors]);

  // Live updates: one Realtime channel per visible round, re-fetching just
  // that round's monitor data on any attempt change (a raw payload doesn't
  // carry the roster join, so a light refetch is simplest & correct).
  useEffect(() => {
    if (visibleRoundIds.length === 0) return;
    const channels = visibleRoundIds.map(id =>
      supabase
        .channel(`monitor-attempts-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'online_exam_attempts', filter: `round_id=eq.${id}` }, () => {
          if (mode === 'round') refreshRoundMode(id);
          else refreshRoomMode(date, gradeRoomKey);
        })
        .subscribe()
    );
    return () => { channels.forEach(ch => supabase.removeChannel(ch)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRoundIds.join(',')]);

  const [selectedGradeLevel, selectedRoom] = gradeRoomKey ? gradeRoomKey.split('|') : ['', ''];

  return (
    <>
    <div className="max-w-6xl print:hidden">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-rose-600 to-red-500 text-white flex items-center justify-center shrink-0">
          <MonitorIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">คุมสอบ</h1>
          <p className="text-sm text-gray-500">มอนิเตอร์สดของนักเรียนที่กำลังสอบออนไลน์ อัปเดตอัตโนมัติ</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 mt-5 mb-1">
        <div className="flex gap-2">
          <button type="button" className={modeBtn + ' ' + (mode === 'round' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700')} onClick={() => setMode('round')}>
            รายรอบ
          </button>
          <button type="button" className={modeBtn + ' ' + (mode === 'room' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-700')} onClick={() => setMode('room')}>
            ชั้น/ห้อง
          </button>
        </div>
        {mode === 'room' && gradeRoomKey && roomMonitors.length > 0 && (
          <button type="button" className="bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1" onClick={() => window.print()}>
            <PrinterIcon className="h-3.5 w-3.5" /> พิมพ์ตารางคุมสอบ
          </button>
        )}
      </div>

      {mode === 'round' ? (
        <div className={card + ' mt-4'}>
          <div className={field}>
            <label className={label}>เลือกรอบสอบ</label>
            {rounds.length === 0 ? (
              <div className="text-sm text-gray-500 mt-1">ยังไม่มีรอบสอบที่คุณดูมอนิเตอร์ได้</div>
            ) : (
              <select className={inputCls} value={roundId} onChange={e => setRoundId(e.target.value)}>
                <option value="">— เลือกรอบสอบ —</option>
                {rounds.map(r => (
                  <option key={r.id} value={r.id}>
                    {r.online_exam_sets?.title} — {r.online_exam_sets?.subjects?.subject_name} (ชั้น {r.online_exam_sets?.subjects?.grade_level}/{r.online_exam_sets?.subjects?.room}) · {formatThai(r.opens_at)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      ) : (
        <div className={card + ' mt-4'}>
          <div className="flex flex-wrap gap-3">
            <div className={field}>
              <label className={label}>วันที่</label>
              <input type="date" className={inputCls} value={date} onChange={e => { setDate(e.target.value); setGradeRoomKey(''); }} />
            </div>
            <div className={field + ' flex-1 min-w-[200px]'}>
              <label className={label}>ชั้น/ห้อง</label>
              {roomOptions.length === 0 ? (
                <div className="text-sm text-gray-500 mt-1">คุณยังไม่ได้รับมอบหมายคุมสอบห้องใดในวันนี้ — แอดมินมอบหมายได้ที่หน้าตั้งค่า</div>
              ) : (
                <select className={inputCls} value={gradeRoomKey} onChange={e => setGradeRoomKey(e.target.value)}>
                  <option value="">— เลือกชั้น/ห้อง —</option>
                  {roomOptions.map(o => (
                    <option key={`${o.grade_level}|${o.room}`} value={`${o.grade_level}|${o.room}`}>
                      ชั้น {o.grade_level}/{o.room}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && <div className={card}><div className="text-sm text-gray-500">กำลังโหลด...</div></div>}
      {error && <div className={card}><div className="text-sm text-red-600">{error}</div></div>}

      {!loading && mode === 'round' && roundMonitor && (
        <RoundMonitorCard monitor={roundMonitor} onUnlockDone={() => refreshRoundMode(roundId)} />
      )}

      {!loading && mode === 'room' && gradeRoomKey && roomMonitors.length === 0 && (
        <div className={card}><div className="text-sm text-gray-500">ยังไม่มีรอบสอบในชั้น/ห้องนี้ในวันที่เลือก</div></div>
      )}

      {!loading && mode === 'room' && roomMonitors.map(m => (
        <RoundMonitorCard key={m.id} monitor={m} onUnlockDone={() => refreshRoomMode(date, gradeRoomKey)} />
      ))}
    </div>
    {mode === 'room' && gradeRoomKey && (
      <PrintableRoomSchedule date={date} gradeLevel={selectedGradeLevel} room={selectedRoom} monitors={roomMonitors} />
    )}
    </>
  );
}
