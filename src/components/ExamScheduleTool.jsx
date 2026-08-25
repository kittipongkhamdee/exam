'use client';
// ExamScheduleTool.jsx — "จัดสอบ": schedule a รอบสอบ (round) against an
// existing ชุดข้อสอบ (built in ExamSetTool). A round is a time window
// (opens_at/closes_at) plus a per-student duration limit once a student
// starts, and a single PIN the teacher announces to the whole class at the
// start of the exam — per the teacher's own scoping, one shared PIN per
// round rather than per student.
//
// Each round also picks how students find out their score: the manual
// "เปิดเผยผลให้นักเรียนดู" button on the "รายงาน" page (results_visible,
// the default), or auto_reveal_results here — each student sees their own
// score immediately when their attempt is graded by submit_exam_attempt,
// whether that's a manual submit or the client's own auto-submit on
// timeout, with no teacher action needed.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { supabase } from '../lib/supabaseClient';
import { listMyExamSets, listMyExamRounds, saveExamRound, deleteExamRound, generatePin } from '../lib/exam-db';
import { getConfigValue } from '../lib/config-db';
import { qrSvgPath } from '../lib/qr';
import { formatGradeRoom, formatThaiDateTime, toBangkokInputValue, fromBangkokInputValue } from '../lib/format';
import ConfirmDialog from './ConfirmDialog';

function QrCode({ value, className }) {
  const { d, size } = useMemo(() => qrSvgPath(value), [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#141413" />
    </svg>
  );
}

function ClipboardIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 3h6a1 1 0 0 1 1 1v1H8V4a1 1 0 0 1 1-1Z" />
      <path d="M9 12h6M9 16h4" />
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

function RefreshIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 11a8 8 0 0 0-14.6-4.6M4 13a8 8 0 0 0 14.6 4.6" />
      <path d="M4 4v5h5M20 20v-5h-5" />
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

// Print-only sheet ("พิมพ์รายละเอียดรอบสอบ") so a proctoring teacher can
// carry PIN + รหัสปลดล็อก + the exam window on paper instead of having to
// log into the system during the exam — especially useful for an
// admin-assigned proctor covering a room's exams who isn't the owning
// teacher. Rendered hidden on screen (Tailwind's print: variants) and
// shown only inside window.print()'s output; the rest of the page is
// hidden the same way so only this sheet ends up on paper.
function PrintableRoundSheet({ rounds, active }) {
  return (
    <div className={active ? 'hidden print:block print:font-sans p-6' : 'hidden'}>
      <h1 className="text-lg font-bold mb-4">รายละเอียดรอบสอบสำหรับครูคุมสอบ</h1>
      <div className="space-y-5">
        {groupBySubject(rounds).map(group => (
          <div key={group.name} className="break-inside-avoid">
            <div className="font-bold text-sm mb-1">{group.name}</div>
            <table className="w-full text-sm border border-gray-400 border-collapse mb-2">
              <thead>
                <tr className="bg-gray-100">
                  <th className="border border-gray-400 px-2 py-1 text-left">ช่วงเวลาสอบ</th>
                  <th className="border border-gray-400 px-2 py-1 text-left">เวลาทำ/คน</th>
                  <th className="border border-gray-400 px-2 py-1 text-left">PIN เข้าสอบ</th>
                  <th className="border border-gray-400 px-2 py-1 text-left">รหัสปลดล็อก</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map(r => (
                  <tr key={r.id}>
                    <td className="border border-gray-400 px-2 py-1">{formatThaiDateTime(r.opens_at)} – {formatThaiDateTime(r.closes_at)}</td>
                    <td className="border border-gray-400 px-2 py-1">{r.duration_minutes} นาที</td>
                    <td className="border border-gray-400 px-2 py-1 font-mono font-bold">{r.pin}</td>
                    <td className="border border-gray-400 px-2 py-1 font-mono font-bold">{r.unlock_pin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

// Print-only sign ("ป้าย QR เข้าสอบ") meant to be posted at the front of
// the room or handed to students — one full A4 page per รอบสอบ, with a QR
// code to the exam entry page and the PIN large enough to read from a
// desk. Deliberately never includes รหัสปลดล็อก (that one's proctor-only,
// see PrintableRoundSheet above) since this sheet is meant for students to
// see directly.
function PrintableStudentSigns({ rounds, active, origin }) {
  const takeUrl = origin ? `${origin}/take` : '';
  const takeUrlDisplay = takeUrl.replace(/^https?:\/\//, '');
  return (
    <div style={active ? undefined : { display: 'none' }}>
      {rounds.map((r, i) => {
        const subj = r.online_exam_sets?.subjects;
        return (
          <div
            key={r.id}
            className={'hidden print:flex print:font-sans items-center justify-center min-h-screen p-10' + (i < rounds.length - 1 ? ' break-after-page' : '')}
          >
            <div className="w-full max-w-md rounded-3xl border-2 border-gray-300 p-10 text-center">
              <div className="inline-block text-xs font-bold tracking-widest uppercase text-indigo-700 bg-indigo-50 rounded-full px-3 py-1 mb-3">
                เข้าสอบออนไลน์
              </div>
              <h1 className="text-2xl font-extrabold text-gray-900 mb-1">
                {subj?.subject_name} (ชั้น {formatGradeRoom(subj?.grade_level, subj?.room)})
              </h1>
              <p className="text-sm text-gray-500 mb-6">
                {r.online_exam_sets?.title}<br />
                {formatThaiDateTime(r.opens_at)} – {formatThaiDateTime(r.closes_at)}
              </p>

              {takeUrl && (
                <div className="inline-flex p-4 border border-gray-300 rounded-2xl mb-3">
                  <QrCode value={takeUrl} className="h-56 w-56" />
                </div>
              )}
              <div className="text-xs text-gray-500 mb-6">
                สแกน QR หรือเข้า <span className="font-mono">{takeUrlDisplay}</span>
              </div>

              <div className="pt-6 border-t border-dashed border-gray-300">
                <div className="text-xs text-gray-500 mb-1">รหัส PIN เข้าสอบ</div>
                <div className="text-4xl font-extrabold tracking-[0.3em] font-mono text-gray-900">{r.pin}</div>
              </div>

              <div className="mt-6 text-left text-xs text-gray-600 space-y-1.5">
                <div>1. สแกน QR ด้านบน หรือเข้าลิงก์เว็บไซต์</div>
                <div>2. กรอกรหัส PIN: <b className="font-mono">{r.pin}</b></div>
                <div>3. กรอกเลขประจำตัวนักเรียน</div>
                <div>4. เริ่มทำข้อสอบภายในเวลา {r.duration_minutes} นาที</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function computeStatus(round) {
  const now = Date.now();
  const opens = new Date(round.opens_at).getTime();
  const closes = new Date(round.closes_at).getTime();
  if (now < opens) return { label: 'ยังไม่เริ่ม', cls: 'bg-gray-100 text-gray-600' };
  if (now <= closes) return { label: 'กำลังสอบ', cls: 'bg-green-50 text-green-700' };
  return { label: 'ปิดรับแล้ว', cls: 'bg-red-50 text-red-600' };
}

function groupBySubject(rounds) {
  const groups = new Map();
  for (const r of rounds) {
    const subj = r.online_exam_sets?.subjects;
    const key = `${r.online_exam_sets?.title || ''} — ${subj?.subject_name} (ชั้น ${formatGradeRoom(subj?.grade_level, subj?.room)})`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([name, rows]) => ({ name, rows }));
}

const DEFAULT_DURATION = 50;

export default function ExamScheduleTool() {
  const card = 'bg-white border border-gray-200 rounded-xl p-5 mb-5';
  const row = 'flex flex-wrap gap-3';
  const field = 'flex flex-col gap-1';
  const label = 'text-xs font-semibold text-gray-500';
  const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 disabled:opacity-50';
  const btn = 'bg-gradient-to-r from-indigo-600 to-blue-500 text-white px-4 py-2.5 rounded-lg font-bold text-sm hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-90 inline-flex items-center justify-center gap-2';
  const btnSecondary = 'bg-gray-100 text-gray-900 px-4 py-2.5 rounded-lg font-bold text-sm hover:bg-gray-200 transition disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2';
  const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200 inline-flex items-center gap-1';
  const btnTinyIndigo = 'bg-indigo-50 text-indigo-700 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-indigo-100 transition inline-flex items-center gap-1';
  const btnTinyAmber = 'bg-amber-50 text-amber-700 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-amber-100 transition inline-flex items-center gap-1';
  const btnTinyRed = 'bg-red-50 text-red-600 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-red-100 transition inline-flex items-center gap-1';
  const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';

  const [examSets, setExamSets] = useState([]);
  const [examSetId, setExamSetId] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_DURATION);
  const [pin, setPin] = useState(() => generatePin());
  const [unlockPin, setUnlockPin] = useState(() => generatePin());
  const [scheduleType, setScheduleType] = useState('adhoc');
  const [autoRevealResults, setAutoRevealResults] = useState(false);
  const [requireLocation, setRequireLocation] = useState(false);
  // Admin's system-wide master switch (Settings → ตรวจสอบตำแหน่งนักเรียน) —
  // the "บังคับแชร์ตำแหน่งก่อนเข้าสอบ" checkbox below only appears when
  // this is on, so a teacher isn't offered a control that start_exam_attempt
  // would ignore anyway (see the migration ANDing round + global flags).
  const [proximityFeatureEnabled, setProximityFeatureEnabled] = useState(true);
  const [editingRoundId, setEditingRoundId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const [rounds, setRounds] = useState([]);
  const [roundsLoading, setRoundsLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [printMode, setPrintMode] = useState(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => { setOrigin(window.location.origin); }, []);

  function triggerPrint(mode) {
    // flushSync forces the printMode state (and the sheet it swaps in) to
    // actually commit to the DOM before window.print() reads it —
    // window.print() blocks synchronously, so a normal setState here would
    // still be queued/un-rendered by the time the print dialog opens,
    // printing whichever sheet was already showing (or nothing).
    flushSync(() => setPrintMode(mode));
    window.print();
  }

  const refreshRounds = useCallback(async () => {
    setRoundsLoading(true);
    try {
      setRounds(await listMyExamRounds(supabase));
    } catch {
      // best-effort
    } finally {
      setRoundsLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setExamSets(await listMyExamSets(supabase));
      } catch {
        // best-effort
      }
    })();
    (async () => {
      try {
        const stored = await getConfigValue(supabase, 'exam_proximity_check_enabled');
        setProximityFeatureEnabled(stored !== 'false');
      } catch {
        // best-effort — defaults to enabled, matching the Settings panel's own default
      }
    })();
    refreshRounds();
  }, [refreshRounds]);

  function resetForm() {
    setEditingRoundId(null);
    setExamSetId('');
    setOpensAt('');
    setClosesAt('');
    setDurationMinutes(DEFAULT_DURATION);
    setPin(generatePin());
    setUnlockPin(generatePin());
    setScheduleType('adhoc');
    setAutoRevealResults(false);
    setRequireLocation(false);
    setFormError(null);
  }

  function startEdit(r) {
    setEditingRoundId(r.id);
    setExamSetId(r.exam_set_id);
    setOpensAt(toBangkokInputValue(r.opens_at));
    setClosesAt(toBangkokInputValue(r.closes_at));
    setDurationMinutes(r.duration_minutes);
    setPin(r.pin);
    setUnlockPin(r.unlock_pin);
    setScheduleType(r.schedule_type || 'adhoc');
    setAutoRevealResults(!!r.auto_reveal_results);
    setRequireLocation(!!r.require_location);
    setFormError(null);
  }

  async function handleSave() {
    if (!examSetId || !opensAt || !closesAt || !pin.trim() || !unlockPin.trim() || !durationMinutes) return;
    const opensAtDate = fromBangkokInputValue(opensAt);
    const closesAtDate = fromBangkokInputValue(closesAt);
    if (closesAtDate.getTime() <= opensAtDate.getTime()) {
      setFormError('เวลาปิดรับสอบต้องอยู่หลังเวลาเปิดสอบ');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await saveExamRound(supabase, {
        id: editingRoundId,
        examSetId,
        pin: pin.trim(),
        unlockPin: unlockPin.trim(),
        opensAt: opensAtDate.toISOString(),
        closesAt: closesAtDate.toISOString(),
        durationMinutes: Number(durationMinutes),
        scheduleType,
        autoRevealResults,
        requireLocation,
      });
      resetForm();
      refreshRounds();
    } catch (err) {
      setFormError(err.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteExamRound(supabase, deleteTarget.id);
      if (editingRoundId === deleteTarget.id) resetForm();
      setDeleteTarget(null);
      refreshRounds();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
    <div className="max-w-5xl print:hidden">
      <div className="flex items-center gap-3 mb-1">
        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-fuchsia-600 to-purple-500 text-white flex items-center justify-center shrink-0">
          <ClipboardIcon className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">จัดสอบ</h1>
          <p className="text-sm text-gray-500">กำหนดช่วงเวลาสอบ เวลาทำต่อคน รหัส PIN เข้าสอบ และรหัสปลดล็อกสำหรับครูคุมสอบ</p>
        </div>
      </div>

      <div className={card + ' mt-5'}>
        <div className="font-semibold text-gray-900 mb-3">{editingRoundId ? 'แก้ไขรอบสอบ' : 'ตั้งรอบสอบใหม่'}</div>

        {examSets.length === 0 ? (
          <div className="text-sm text-gray-500">ยังไม่มีชุดข้อสอบ — ไปสร้างที่ &quot;ข้อสอบ&quot; ก่อน</div>
        ) : (
          <>
            <div className={row}>
              <div className={field + ' flex-1 min-w-[240px]'}>
                <label className={label}>ชุดข้อสอบ</label>
                <select className={inputCls} value={examSetId} onChange={e => setExamSetId(e.target.value)}>
                  <option value="">— เลือกชุดข้อสอบ —</option>
                  {examSets.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.title} — {s.subjects?.subject_name} (ชั้น {formatGradeRoom(s.subjects?.grade_level, s.subjects?.room)}) · {s.question_count} ข้อ
                    </option>
                  ))}
                </select>
              </div>
              <div className={field}>
                <label className={label}>เวลาทำต่อคน (นาที)</label>
                <input
                  type="number" min={1} className={inputCls + ' w-32'}
                  value={durationMinutes}
                  onChange={e => setDurationMinutes(e.target.value)}
                />
              </div>
            </div>

            <div className={row + ' mt-3'}>
              <div className={field}>
                <label className={label}>เปิดให้เข้าสอบ (เวลาประเทศไทย)</label>
                <input type="datetime-local" className={inputCls} value={opensAt} onChange={e => setOpensAt(e.target.value)} />
              </div>
              <div className={field}>
                <label className={label}>ปิดรับเข้าสอบ (เวลาประเทศไทย)</label>
                <input type="datetime-local" className={inputCls} value={closesAt} onChange={e => setClosesAt(e.target.value)} />
              </div>
              <div className={field}>
                <label className={label}>รหัส PIN (แจ้งนักเรียนตอนเริ่มสอบ)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text" className={inputCls + ' w-32 font-mono tracking-widest'}
                    value={pin}
                    onChange={e => setPin(e.target.value)}
                  />
                  <button type="button" className={btnTiny} onClick={() => setPin(generatePin())} aria-label="สุ่ม PIN ใหม่">
                    <RefreshIcon className="h-3.5 w-3.5" /> สุ่มใหม่
                  </button>
                </div>
              </div>
              <div className={field}>
                <label className={label}>รหัสปลดล็อก (ครูคุมสอบเท่านั้น — ห้ามบอกนักเรียน)</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text" className={inputCls + ' w-32 font-mono tracking-widest text-amber-700'}
                    value={unlockPin}
                    onChange={e => setUnlockPin(e.target.value)}
                  />
                  <button type="button" className={btnTiny} onClick={() => setUnlockPin(generatePin())} aria-label="สุ่มรหัสปลดล็อกใหม่">
                    <RefreshIcon className="h-3.5 w-3.5" /> สุ่มใหม่
                  </button>
                </div>
              </div>
            </div>

            <div className={field + ' mt-3'}>
              <label className={label}>ประเภทการสอบ</label>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="scheduleType" value="adhoc" checked={scheduleType === 'adhoc'} onChange={() => setScheduleType('adhoc')} />
                  นอกตาราง (คุณคุมสอบเอง)
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="scheduleType" value="scheduled" checked={scheduleType === 'scheduled'} onChange={() => setScheduleType('scheduled')} />
                  ในตาราง (แอดมินกำหนดครูคุมสอบ)
                </label>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                นอกตาราง: คุณดูมอนิเตอร์คุมสอบรอบนี้ได้เอง — ในตาราง: ครูที่แอดมินมอบหมายคุมสอบชั้น/ห้องนี้ในวันสอบจะดูมอนิเตอร์ได้ (ดูได้ทั้งรอบในตารางและนอกตารางที่จัดในห้องเดียวกันวันนั้น)
              </p>
            </div>

            <div className={field + ' mt-3'}>
              <label className={label}>การเปิดเผยผลคะแนนให้นักเรียน</label>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="revealMode" checked={!autoRevealResults} onChange={() => setAutoRevealResults(false)} />
                  กดปุ่มเปิดเผยผลเอง (ที่หน้ารายงาน)
                </label>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="revealMode" checked={autoRevealResults} onChange={() => setAutoRevealResults(true)} />
                  แสดงคะแนนอัตโนมัติทันทีที่ส่งข้อสอบ/หมดเวลา
                </label>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">
                โหมดอัตโนมัติ: นักเรียนแต่ละคนเห็นคะแนนของตัวเองทันทีที่กดส่งข้อสอบ หรือเมื่อหมดเวลาแล้วระบบส่งให้อัตโนมัติ — ไม่ต้องรอครูกดเปิดเผยผล
              </p>
            </div>

            {proximityFeatureEnabled && (
              <div className={field + ' mt-3'}>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={requireLocation} onChange={e => setRequireLocation(e.target.checked)} />
                  บังคับแชร์ตำแหน่งก่อนเข้าสอบ (สำหรับสอบที่บ้าน)
                </label>
                <p className="text-xs text-gray-400 mt-0.5">
                  นักเรียนต้องกดอนุญาตแชร์ตำแหน่งก่อนจึงจะเริ่มทำข้อสอบได้ — ถ้าปฏิเสธหรืออุปกรณ์หา GPS ไม่ได้ จะเข้าสอบไม่ได้เด็ดขาด (ต้องลองใหม่จนกว่าจะสำเร็จ) ใช้ระยะห่างขั้นต่ำที่ตั้งไว้ที่หน้าตั้งค่า — ปกติเปิดเฉพาะรอบที่ให้นักเรียนสอบจากที่บ้าน ไม่จำเป็นสำหรับรอบที่สอบในโรงเรียน
                </p>
              </div>
            )}

            {formError && <div className="text-sm text-red-600 mt-3">{formError}</div>}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button" className={btn}
                disabled={!examSetId || !opensAt || !closesAt || !pin.trim() || !unlockPin.trim() || !durationMinutes || saving}
                onClick={handleSave}
              >
                <SaveIcon className="h-4 w-4" /> {saving ? 'กำลังบันทึก...' : (editingRoundId ? 'บันทึกการแก้ไข' : 'ตั้งรอบสอบ')}
              </button>
              {editingRoundId && (
                <button type="button" className={btnSecondary} disabled={saving} onClick={resetForm}>ยกเลิก</button>
              )}
            </div>
          </>
        )}
      </div>

      <div className={card}>
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold text-gray-900">รอบสอบที่ตั้งไว้</div>
          {rounds.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btnTinyIndigo} onClick={() => triggerPrint('proctor')}>
                <PrinterIcon className="h-3.5 w-3.5" /> พิมพ์รายละเอียดรอบสอบ (ครูคุมสอบ)
              </button>
              <button type="button" className={btnTinyIndigo} onClick={() => triggerPrint('student')}>
                <PrinterIcon className="h-3.5 w-3.5" /> พิมพ์ป้าย QR เข้าสอบ (แจกนักเรียน)
              </button>
            </div>
          )}
        </div>
        {roundsLoading && <div className="text-sm text-gray-500">กำลังโหลด...</div>}
        {!roundsLoading && rounds.length === 0 && <div className="text-sm text-gray-500">ยังไม่มีรอบสอบ</div>}
        {rounds.length > 0 && (
          <div className="space-y-4">
            {groupBySubject(rounds).map(group => (
              <div key={group.name}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="shrink-0 h-6 w-6 rounded-md bg-indigo-100 text-indigo-600 flex items-center justify-center">
                    <ClipboardIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="text-sm font-bold text-gray-800">{group.name}</div>
                </div>
                <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                  {group.rows.map(r => {
                    const status = computeStatus(r);
                    return (
                      <div key={r.id} className="flex flex-wrap justify-between items-center gap-3 text-sm px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={pill + ' ' + status.cls}>{status.label}</span>
                            <span className={pill + ' ' + (r.schedule_type === 'scheduled' ? 'bg-indigo-50 text-indigo-700' : 'bg-gray-100 text-gray-500')}>
                              {r.schedule_type === 'scheduled' ? 'ในตาราง' : 'นอกตาราง'}
                            </span>
                            <span className="font-mono font-bold tracking-widest text-gray-900">PIN: {r.pin}</span>
                            <span className="font-mono font-bold tracking-widest text-amber-700">ปลดล็อก: {r.unlock_pin}</span>
                            {r.auto_reveal_results && (
                              <span className={pill + ' bg-emerald-50 text-emerald-700'}>เผยผลอัตโนมัติ</span>
                            )}
                            {r.require_location && (
                              <span className={pill + ' bg-rose-50 text-rose-700'}>บังคับแชร์ตำแหน่ง</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {formatThaiDateTime(r.opens_at)} – {formatThaiDateTime(r.closes_at)} · ทำได้ {r.duration_minutes} นาที/คน
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button className={btnTinyAmber} onClick={() => startEdit(r)}>
                            <PencilIcon className="h-3.5 w-3.5" /> แก้ไข
                          </button>
                          <button className={btnTinyRed} onClick={() => setDeleteTarget(r)}>
                            <TrashIcon className="h-3.5 w-3.5" /> ลบ
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="ยืนยันลบรอบสอบ"
        message="ลบรอบสอบนี้? นักเรียนจะเข้าสอบด้วย PIN นี้ไม่ได้อีก"
        confirmLabel="ลบรอบสอบ"
        danger
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
    <PrintableRoundSheet rounds={rounds} active={printMode === 'proctor'} />
    <PrintableStudentSigns rounds={rounds} active={printMode === 'student'} origin={origin} />
    </>
  );
}
