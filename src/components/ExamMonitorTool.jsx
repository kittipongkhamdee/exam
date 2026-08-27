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
//
// Optional proximity check (admin-toggled, Settings → ตรวจสอบตำแหน่งนักเรียน):
// if a student's browser reported a one-time location at exam start, this
// flags — never auto-blocks — any pair sitting closer together than the
// admin's configured minimum, on a small map and a toast, leaving the
// actual "บล็อก" call to the proctoring teacher (see proctorLockAttempt).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Swal from 'sweetalert2';
import 'leaflet/dist/leaflet.css';
import { supabase } from '../lib/supabaseClient';
import {
  getRoundMonitor, getRoomMonitor, listMonitorableRounds,
  proctorUnlockAttempt, proctorLockAttempt, openExamRound, listProctorAssignmentsForDate,
} from '../lib/exam-db';
import { getConfigValue } from '../lib/config-db';
import { distanceMeters } from '../lib/geo';
import { formatGradeRoom, formatThaiDateTime, formatThaiTime, escapeHtml } from '../lib/format';

const DEFAULT_PROXIMITY_MIN_DISTANCE_M = 15;

// Every pair of located students in one monitor whose reported positions
// are closer than minDistanceM — a soft signal for the proctoring teacher
// to judge (they know who genuinely lives next door), never an automatic
// block. O(n²) over one รอบสอบ's roster (a class, not 200 students) is
// trivial, so this runs client-side on every refresh rather than needing
// its own server-side job.
function computeProximityFlags(rows, minDistanceM) {
  const located = rows.filter(r => r.location_lat != null && r.location_lng != null);
  const flaggedIds = new Set();
  const pairs = [];
  for (let i = 0; i < located.length; i++) {
    for (let j = i + 1; j < located.length; j++) {
      const d = distanceMeters(located[i].location_lat, located[i].location_lng, located[j].location_lat, located[j].location_lng);
      if (d < minDistanceM) {
        flaggedIds.add(located[i].attempt_id);
        flaggedIds.add(located[j].attempt_id);
        pairs.push({ a: located[i], b: located[j], distanceM: d });
      }
    }
  }
  return { flaggedIds, pairs };
}

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

function EyeIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// Room-mode proctors are usually standing in the exam room on a phone, not
// somewhere convenient to print — so this shows the same PIN/รหัสปลดล็อก
// info as a popup instead. A dedicated "ตารางคุมสอบ" page (any teacher,
// not just this room's assigned proctor) covers actual printing.
function showRoomScheduleDialog({ gradeLevel, room, monitors }) {
  const rowsHtml = monitors.length === 0
    ? '<div class="text-sm text-gray-500">ไม่มีรอบสอบในวันที่เลือก</div>'
    : `<div class="text-left space-y-2">${monitors.map(m => `
        <div class="border border-gray-200 rounded-lg px-3 py-2">
          <div class="text-sm font-semibold text-gray-900">${escapeHtml(m.exam_set_title)} — ${escapeHtml(m.subject_name)}</div>
          <div class="text-xs text-gray-500 mt-0.5">${formatThaiTime(m.opens_at)} – ${formatThaiTime(m.closes_at)} · ทำได้ ${m.duration_minutes} นาที/คน</div>
          <div class="text-xs mt-1 flex flex-wrap gap-x-3">
            <span class="font-mono font-bold tracking-widest text-gray-900">PIN: ${escapeHtml(m.pin)}</span>
            <span class="font-mono font-bold tracking-widest text-amber-700">ปลดล็อก: ${escapeHtml(m.unlock_pin)}</span>
          </div>
        </div>
      `).join('')}</div>`;
  return Swal.fire({
    title: `ตารางคุมสอบ ชั้น ${escapeHtml(formatGradeRoom(gradeLevel, room))}`,
    html: rowsHtml,
    width: 480,
    confirmButtonText: 'ปิด',
    confirmButtonColor: '#4f46e5',
  });
}

function todayBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
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

// Leaflet + OpenStreetMap (both free, no API key) rather than a paid
// provider — this app already leans on free-tier infrastructure
// throughout. Leaflet touches `window`, so it's imported dynamically
// inside the effect (client-only lifecycle) rather than at module scope,
// keeping this component safe under Next.js's SSR pass. Markers redraw on
// every relevant data change rather than being individually diffed — a
// รอบสอบ's roster is a class (tens of students), not 200, so the redraw
// cost is trivial.
function ProximityMap({ rows, flaggedIds }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  const located = rows.filter(r => r.location_lat != null && r.location_lng != null);
  const locatedKey = located.map(r => `${r.attempt_id}:${r.location_lat}:${r.location_lng}:${flaggedIds.has(r.attempt_id)}`).join(',');

  useEffect(() => {
    // Every located student left (or the round just changed and none are
    // located yet) — tear the map down instead of leaving mapRef pointing
    // at a Leaflet instance bound to a DOM node React is about to remove
    // (this component renders null below when located.length === 0).
    // Without this, a student's marker disappearing and later reappearing
    // (a monitor refresh landing between the two) left the *next* map
    // bound to a detached node — `if (!mapRef.current)` below would skip
    // creating a fresh one, so no map ever showed again.
    if (located.length === 0) {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; markersRef.current = []; }
      return;
    }
    if (!containerRef.current) return;
    let cancelled = false;
    (async () => {
      const L = (await import('leaflet')).default;
      if (cancelled) return;
      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, { zoomControl: true, attributionControl: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(mapRef.current);
      }
      markersRef.current.forEach(m => m.remove());
      markersRef.current = located.map(r => {
        const isFlagged = flaggedIds.has(r.attempt_id);
        const marker = L.circleMarker([r.location_lat, r.location_lng], {
          radius: 8, weight: 2,
          color: isFlagged ? '#dc2626' : '#4f46e5',
          fillColor: isFlagged ? '#f87171' : '#818cf8',
          fillOpacity: 0.9,
        }).addTo(mapRef.current);
        // Leaflet renders a string tooltip as HTML, not text — escape the
        // roster-sourced name/code before interpolating.
        marker.bindTooltip(`${escapeHtml(r.student_name)} (${escapeHtml(r.student_code)})`);
        return marker;
      });
      const bounds = located.map(r => [r.location_lat, r.location_lng]);
      if (bounds.length > 1) mapRef.current.fitBounds(bounds, { padding: [30, 30] });
      else mapRef.current.setView(bounds[0], 17);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locatedKey]);

  useEffect(() => () => {
    if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
  }, []);

  if (located.length === 0) return null;
  // isolate: Leaflet's own panes/controls carry z-index up to 1000, and
  // without a stacking context of its own here that escapes straight into
  // the page's stacking order — easily beating the app sidebar's z-40 and
  // rendering on top of it while the sidebar is open on mobile.
  return <div ref={containerRef} className="relative isolate h-64 rounded-lg overflow-hidden border border-gray-200 mt-3" />;
}

function StudentCard({ row, flagged, onUnlock, onLock, unlocking, locking }) {
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
  if (flagged && !row.locked) cls = 'bg-amber-50 border-amber-300 text-amber-700';

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
      {flagged && !row.locked && (
        <div className="mt-1 text-xs font-bold text-amber-700">⚠ ตำแหน่งใกล้เพื่อนเกินกำหนด</div>
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
      {flagged && !row.locked && row.status === 'in_progress' && (
        <button
          type="button"
          className="mt-2 w-full inline-flex items-center justify-center gap-1 bg-amber-600 text-white text-xs font-bold px-2 py-1.5 rounded-md hover:bg-amber-700 disabled:opacity-50"
          disabled={locking}
          onClick={() => onLock(row.attempt_id)}
        >
          <LockIcon className="h-3.5 w-3.5" /> {locking ? 'กำลังบล็อก...' : 'บล็อก (ตำแหน่งผิดปกติ)'}
        </button>
      )}
    </div>
  );
}

function RoundMonitorCard({ monitor, minDistance, onUnlockDone }) {
  const [unlockingId, setUnlockingId] = useState(null);
  const [lockingId, setLockingId] = useState(null);
  const [opening, setOpening] = useState(false);

  async function handleOpenRound() {
    setOpening(true);
    try {
      await openExamRound(supabase, monitor.id);
      onUnlockDone();
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'เริ่มสอบไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setOpening(false);
    }
  }

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

  async function handleLock(attemptId) {
    const confirmed = await Swal.fire({
      icon: 'warning', title: 'ยืนยันบล็อกนักเรียนคนนี้?',
      text: 'นักเรียนจะถูกล็อกหน้าจอทันที ต้องขอรหัสปลดล็อกจากครูจึงจะทำต่อได้',
      showCancelButton: true, confirmButtonText: 'บล็อก', cancelButtonText: 'ยกเลิก', confirmButtonColor: '#d97706',
    });
    if (!confirmed.isConfirmed) return;
    setLockingId(attemptId);
    try {
      await proctorLockAttempt(supabase, attemptId);
      onUnlockDone();
    } catch (err) {
      Swal.fire({ icon: 'error', title: 'บล็อกไม่สำเร็จ', text: err.message || 'กรุณาลองใหม่อีกครั้ง' });
    } finally {
      setLockingId(null);
    }
  }

  const submitted = monitor.rows.filter(r => r.status === 'submitted').length;
  const locked = monitor.rows.filter(r => r.locked).length;
  const inProgress = monitor.rows.filter(r => r.status === 'in_progress' && !r.locked).length;

  const { flaggedIds, pairs } = useMemo(() => computeProximityFlags(monitor.rows, minDistance), [monitor.rows, minDistance]);

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 mb-5">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <div className="font-semibold text-gray-900">{monitor.exam_set_title}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {monitor.subject_name} (ชั้น {formatGradeRoom(monitor.grade_level, monitor.room)}) · {formatThaiTime(monitor.opens_at)} – {formatThaiTime(monitor.closes_at)}
          </div>
          {monitor.pin && (
            <div className="inline-flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-1 mt-1.5">
              <span className="text-xs text-indigo-800">PIN</span>
              <span className="font-mono font-bold tracking-widest text-indigo-900">{monitor.pin}</span>
            </div>
          )}
          {monitor.unlock_pin && (
            <div className="inline-flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1 mt-1.5">
              <LockIcon className="h-3.5 w-3.5 text-amber-700" />
              <span className="text-xs text-amber-800">รหัสปลดล็อก</span>
              <span className="font-mono font-bold tracking-widest text-amber-900">{monitor.unlock_pin}</span>
            </div>
          )}
          {monitor.manual_start && (
            monitor.started_by_teacher_at ? (
              <div className="inline-flex items-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1 mt-1.5">
                <span className="text-xs font-semibold text-emerald-800">เริ่มสอบแล้ว</span>
              </div>
            ) : (
              <button
                type="button"
                className="inline-flex items-center gap-1.5 bg-indigo-600 text-white rounded-lg px-3 py-1.5 mt-1.5 text-xs font-bold hover:opacity-90 disabled:opacity-50"
                disabled={opening}
                onClick={handleOpenRound}
              >
                {opening ? 'กำลังเริ่มสอบ...' : 'เริ่มสอบ — เปิดให้นักเรียนเข้าทำได้'}
              </button>
            )
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          <span className="font-bold text-green-700">{submitted}<span className="text-gray-500 font-normal"> ส่งแล้ว</span></span>
          <span className="font-bold text-sky-700">{inProgress}<span className="text-gray-500 font-normal"> กำลังทำ</span></span>
          {locked > 0 && <span className="font-bold text-red-600">{locked}<span className="text-gray-500 font-normal"> ถูกล็อก</span></span>}
          {pairs.length > 0 && <span className="font-bold text-amber-700">{flaggedIds.size}<span className="text-gray-500 font-normal"> ตำแหน่งใกล้กัน</span></span>}
        </div>
      </div>

      {pairs.length > 0 && (
        <div className="mb-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs">
          <div className="font-bold text-amber-800 mb-1">⚠ นักเรียนต่อไปนี้อยู่ใกล้กันน้อยกว่า {minDistance} เมตร — ตรวจสอบเอง ระบบไม่ได้บล็อกอัตโนมัติ</div>
          <div className="space-y-0.5 text-amber-700">
            {pairs.map((p, i) => (
              <div key={i}>{p.a.student_name} ↔ {p.b.student_name} (~{Math.round(p.distanceM)} ม.)</div>
            ))}
          </div>
        </div>
      )}

      <ProximityMap rows={monitor.rows} flaggedIds={flaggedIds} />

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mt-3">
        {monitor.rows.map(row => (
          <StudentCard
            key={row.student_id} row={row} flagged={flaggedIds.has(row.attempt_id)}
            onUnlock={handleUnlock} onLock={handleLock}
            unlocking={unlockingId === row.attempt_id} locking={lockingId === row.attempt_id}
          />
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

  const [proximityMinDistance, setProximityMinDistance] = useState(DEFAULT_PROXIMITY_MIN_DISTANCE_M);

  const lockedByAttempt = useRef(new Map());
  const flaggedPairsSeen = useRef(new Set());

  useEffect(() => {
    (async () => {
      try {
        setRounds(await listMonitorableRounds(supabase));
      } catch {
        // best-effort
      }
      try {
        const stored = await getConfigValue(supabase, 'exam_proximity_min_distance_m');
        if (stored) setProximityMinDistance(Number(stored) || DEFAULT_PROXIMITY_MIN_DISTANCE_M);
      } catch {
        // best-effort — falls back to the default already set
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

  // Toasts once per newly-appearing too-close pair (not on every refresh
  // re-render, and not re-firing for a pair the teacher's already seen),
  // same "seen before" tracking idea as noteViolations above.
  const noteProximityFlags = useCallback((monitors) => {
    for (const m of monitors) {
      const { pairs } = computeProximityFlags(m.rows, proximityMinDistance);
      for (const p of pairs) {
        const key = [p.a.attempt_id, p.b.attempt_id].sort().join('|');
        if (flaggedPairsSeen.current.has(key)) continue;
        flaggedPairsSeen.current.add(key);
        playAlertBeep();
        Swal.fire({
          toast: true, position: 'top-end', timer: 5000, showConfirmButton: false,
          icon: 'warning', title: `${p.a.student_name} ↔ ${p.b.student_name} อยู่ใกล้กันเกินกำหนด`,
        });
      }
    }
  }, [proximityMinDistance]);

  const refreshRoundMode = useCallback(async (id) => {
    if (!id) { setRoundMonitor(null); return; }
    setLoading(true);
    setError(null);
    try {
      const m = await getRoundMonitor(supabase, id);
      noteViolations([m]);
      noteProximityFlags([m]);
      setRoundMonitor(m);
    } catch (err) {
      setError(err.message || 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, [noteViolations, noteProximityFlags]);

  const refreshRoomMode = useCallback(async (d, key) => {
    if (!key) { setRoomMonitors([]); return; }
    const [gradeLevel, room] = key.split('|');
    setLoading(true);
    setError(null);
    try {
      const ms = await getRoomMonitor(supabase, { date: d, gradeLevel, room });
      noteViolations(ms);
      noteProximityFlags(ms);
      setRoomMonitors(ms);
    } catch (err) {
      setError(err.message || 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  }, [noteViolations, noteProximityFlags]);

  useEffect(() => { if (mode === 'round') refreshRoundMode(roundId); }, [mode, roundId, refreshRoundMode]);
  useEffect(() => { if (mode === 'room') refreshRoomMode(date, gradeRoomKey); }, [mode, date, gradeRoomKey, refreshRoomMode]);

  const visibleRoundIds = useMemo(() => {
    if (mode === 'round') return roundId ? [roundId] : [];
    return roomMonitors.map(m => m.id);
  }, [mode, roundId, roomMonitors]);

  // The postgres_changes callback below only gets recreated when
  // visibleRoundIds changes (see that effect's own comment on why) — so it
  // would otherwise close over whatever mode/date/gradeRoomKey/
  // refreshRoundMode/refreshRoomMode were current the moment that effect
  // last ran, not the latest ones. refreshRoundMode/refreshRoomMode in
  // particular get a new identity whenever proximityMinDistance changes
  // (via noteProximityFlags), which itself only resolves asynchronously
  // after mount — a round already selected before that config fetch
  // finishes would otherwise keep flagging proximity pairs against the
  // hardcoded default distance for as long as the teacher stays on that
  // same round, never picking up the real configured value. Reading
  // through a ref this effect keeps current every render sidesteps the
  // staleness regardless of which prop it'd be.
  const latestRef = useRef(null);
  useEffect(() => {
    latestRef.current = { mode, date, gradeRoomKey, refreshRoundMode, refreshRoomMode };
  });

  // Live updates: one Realtime channel per visible round, re-fetching just
  // that round's monitor data on any attempt change (a raw payload doesn't
  // carry the roster join, so a light refetch is simplest & correct).
  useEffect(() => {
    if (visibleRoundIds.length === 0) return;
    const channels = visibleRoundIds.map(id =>
      supabase
        .channel(`monitor-attempts-${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'online_exam_attempts', filter: `round_id=eq.${id}` }, () => {
          const latest = latestRef.current;
          if (latest.mode === 'round') latest.refreshRoundMode(id);
          else latest.refreshRoomMode(latest.date, latest.gradeRoomKey);
        })
        .subscribe()
    );
    return () => { channels.forEach(ch => supabase.removeChannel(ch)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRoundIds.join(',')]);

  const [selectedGradeLevel, selectedRoom] = gradeRoomKey ? gradeRoomKey.split('|') : ['', ''];

  return (
    <div className="max-w-6xl">
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
          <button
            type="button"
            className="bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1"
            onClick={() => showRoomScheduleDialog({ gradeLevel: selectedGradeLevel, room: selectedRoom, monitors: roomMonitors })}
          >
            <EyeIcon className="h-3.5 w-3.5" /> ดูตารางคุมสอบ
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
                    {r.online_exam_sets?.title} — {r.online_exam_sets?.subjects?.subject_name} (ชั้น {formatGradeRoom(r.online_exam_sets?.subjects?.grade_level, r.online_exam_sets?.subjects?.room)}) · {formatThaiDateTime(r.opens_at)}
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
                      ชั้น {formatGradeRoom(o.grade_level, o.room)}
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
        <RoundMonitorCard monitor={roundMonitor} minDistance={proximityMinDistance} onUnlockDone={() => refreshRoundMode(roundId)} />
      )}

      {!loading && mode === 'room' && gradeRoomKey && roomMonitors.length === 0 && (
        <div className={card}><div className="text-sm text-gray-500">ยังไม่มีรอบสอบในชั้น/ห้องนี้ในวันที่เลือก</div></div>
      )}

      {!loading && mode === 'room' && roomMonitors.map(m => (
        <RoundMonitorCard key={m.id} monitor={m} minDistance={proximityMinDistance} onUnlockDone={() => refreshRoomMode(date, gradeRoomKey)} />
      ))}
    </div>
  );
}
