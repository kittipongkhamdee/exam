'use client';
// ExamProctorAssignmentTool.jsx — "จัดครูคุมสอบ": admin assigns which
// teacher proctors which ชั้น/ห้อง on which date, for exams in the school
// timetable. Moved out of the "ตั้งค่า" settings page into its own menu
// item (under "ตารางคุมสอบ") since assigning proctors is a routine,
// frequent task, not a one-off system setting.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { listProctorAssignmentsForDate, saveProctorAssignment, deleteProctorAssignment, listGradeRoomOptions, listAllTeachers, listProctorOverview } from '../lib/exam-db';
import { formatGradeRoom, formatThaiTime } from '../lib/format';

const card = 'bg-white border border-gray-200 rounded-xl p-4 sm:p-5 mb-4';
const btnTiny = 'bg-gray-100 text-gray-900 px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-200';
const inputCls = 'px-2.5 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500';
const pill = 'inline-block px-2 py-0.5 rounded-full text-xs font-bold';

// Groups the selected date's proctor assignments by ชั้น (grade level), same
// collapsible/numbered-per-group treatment as /exam's "ชุดข้อสอบที่สร้างไว้แล้ว"
// list (see ExamSetTool.jsx) — a school can have several ห้อง assigned per
// ชั้น on a given day, so grouping by ชั้น first makes the list easier to scan.
function groupAssignmentsByGrade(assignments) {
  const groups = new Map();
  for (const a of assignments) {
    const key = a.grade_level || '';
    if (!groups.has(key)) groups.set(key, { name: a.grade_level ? `ชั้น ม.${a.grade_level}` : 'ไม่ระบุชั้น', rows: [] });
    groups.get(key).rows.push(a);
  }
  return [...groups.values()];
}

function ChevronDownIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

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

function addDays(dateStr, days) {
  return new Date(new Date(`${dateStr}T12:00:00+07:00`).getTime() + days * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

// Anchored to noon Bangkok so a device in another timezone can't shift it
// to the adjacent day (same approach as ExamDutyScheduleTool).
function formatThaiDateLong(dateStr) {
  return new Date(`${dateStr}T12:00:00+07:00`).toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });
}

function groupOverviewByDate(entries) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  return [...groups.entries()].map(([date, rows]) => ({ date, rows }));
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
  // ชั้น groups the teacher has expanded — every group starts collapsed by
  // default, same as /exam's "ชุดข้อสอบที่สร้างไว้แล้ว" list.
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  function toggleGroup(name) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

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

  // "วันไหน วิชาอะไร ใครคุมสอบ" overview — independent of the single date
  // picked above, so the admin can see a whole stretch of exam days at once.
  const [overviewFrom, setOverviewFrom] = useState(() => todayBangkok());
  const [overviewTo, setOverviewTo] = useState(() => addDays(todayBangkok(), 30));
  const [overview, setOverview] = useState([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState(null);
  // Bumped after an assign/remove so the overview re-fetches the same range.
  const [overviewVersion, setOverviewVersion] = useState(0);

  useEffect(() => {
    if (!overviewFrom || !overviewTo || overviewFrom > overviewTo) return;
    let cancelled = false;
    listProctorOverview(supabase, overviewFrom, overviewTo)
      .then(data => { if (!cancelled) { setOverview(data); setOverviewError(null); } })
      .catch(err => { if (!cancelled) setOverviewError(err.message || 'โหลดภาพรวมไม่สำเร็จ'); })
      .finally(() => { if (!cancelled) setOverviewLoading(false); });
    return () => { cancelled = true; };
  }, [overviewFrom, overviewTo, overviewVersion]);

  function reloadOverview() {
    setOverviewLoading(true);
    setOverviewVersion(v => v + 1);
  }

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
      reloadOverview();
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
      reloadOverview();
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
            <div className="space-y-3">
              {groupAssignmentsByGrade(assignments).map(group => {
                const expanded = expandedGroups.has(group.name);
                return (
                  <div key={group.name}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.name)}
                      className="w-full flex items-center gap-2 mb-2 text-left"
                    >
                      <span className="text-sm font-bold text-gray-800">{group.name}</span>
                      <span className={pill + ' bg-gray-100 text-gray-600'}>{group.rows.length}</span>
                      <ChevronDownIcon className={"h-3.5 w-3.5 text-gray-400 shrink-0 transition-transform " + (expanded ? '' : '-rotate-90')} />
                    </button>
                    {expanded && (
                      <div className="border border-gray-200 rounded-lg divide-y divide-gray-100">
                        {group.rows.map((a, i) => (
                          <div key={a.id} className="flex items-center justify-between gap-3 text-sm px-3 py-2">
                            <div>
                              <span className="text-gray-400 font-normal">{i + 1}.</span>{' '}
                              <span className="font-semibold text-gray-900">ชั้น {formatGradeRoom(a.grade_level, a.room)}</span>
                              <span className="text-gray-500"> — {a.profiles?.full_name || '(ไม่ระบุชื่อ)'}</span>
                            </div>
                            <button className={btnTiny} onClick={() => handleRemove(a.id)}>ลบ</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className={card}>
        <div className="font-semibold text-gray-900 mb-1">ภาพรวม: วันไหน วิชาอะไร ใครคุมสอบ</div>
        <p className="text-sm text-gray-500 mb-3">
          รอบสอบออนไลน์ทุกวิชาในช่วงวันที่เลือก พร้อมครูที่ได้รับมอบหมายให้คุมสอบห้องนั้นในวันนั้น — ห้องที่มีสอบแต่ยังไม่มีครูคุมสอบจะขึ้นเตือนสีส้ม
        </p>
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">ตั้งแต่วันที่</label>
            <input type="date" className={inputCls} value={overviewFrom} onChange={e => { setOverviewLoading(true); setOverviewFrom(e.target.value); }} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-gray-500">ถึงวันที่</label>
            <input type="date" className={inputCls} value={overviewTo} onChange={e => { setOverviewLoading(true); setOverviewTo(e.target.value); }} />
          </div>
        </div>
        {overviewFrom > overviewTo ? (
          <div className="text-sm text-red-600">วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด</div>
        ) : overviewLoading ? (
          <div className="text-sm text-gray-500">กำลังโหลด...</div>
        ) : overviewError ? (
          <div className="text-sm text-red-600">{overviewError}</div>
        ) : overview.length === 0 ? (
          <div className="text-sm text-gray-500">ไม่มีรอบสอบหรือการมอบหมายครูคุมสอบในช่วงวันที่เลือก</div>
        ) : (
          <div className="space-y-5">
            {groupOverviewByDate(overview).map(day => (
              <div key={day.date}>
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="text-sm font-bold text-gray-800">{formatThaiDateLong(day.date)}</span>
                  {day.rows.some(e => e.rounds.length > 0 && e.proctors.length === 0) && (
                    <span className={pill + ' bg-amber-50 text-amber-700'}>มีห้องที่ยังไม่มีครูคุมสอบ</span>
                  )}
                  <button type="button" className={btnTiny + ' ml-auto'} onClick={() => { setDate(day.date); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                    มอบหมายวันนี้
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border border-gray-200 border-collapse">
                    <thead>
                      <tr className="bg-gray-50 text-left text-xs text-gray-500">
                        <th className="border border-gray-200 px-2.5 py-1.5 w-28">ชั้น/ห้อง</th>
                        <th className="border border-gray-200 px-2.5 py-1.5">วิชา / เวลาสอบ</th>
                        <th className="border border-gray-200 px-2.5 py-1.5 w-56">ครูคุมสอบ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {day.rows.map(e => (
                        <tr key={`${e.gradeLevel}|${e.room}`} className="align-top">
                          <td className="border border-gray-200 px-2.5 py-2 font-semibold text-gray-900 whitespace-nowrap">ชั้น {formatGradeRoom(e.gradeLevel, e.room)}</td>
                          <td className="border border-gray-200 px-2.5 py-2">
                            {e.rounds.length === 0 ? (
                              <span className="text-gray-400">ไม่มีรอบสอบออนไลน์</span>
                            ) : (
                              <div className="space-y-1">
                                {e.rounds.map(r => (
                                  <div key={r.id}>
                                    <span className="font-medium text-gray-900">{r.subject_name}</span>
                                    <span className="text-gray-500"> — {r.title}</span>
                                    <span className="text-gray-500 whitespace-nowrap"> · {formatThaiTime(r.opens_at)}–{formatThaiTime(r.closes_at)}</span>
                                    {r.schedule_type !== 'scheduled' && <span className={pill + ' bg-gray-100 text-gray-500 ml-1'}>นอกตาราง</span>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="border border-gray-200 px-2.5 py-2">
                            {e.proctors.length > 0 ? (
                              <div className="space-y-0.5">
                                {e.proctors.map(p => <div key={p.id} className="text-gray-900">{p.name || '(ไม่ระบุชื่อ)'}</div>)}
                              </div>
                            ) : e.rounds.length > 0 ? (
                              <div>
                                <span className={pill + ' bg-amber-50 text-amber-700'}>ยังไม่ได้มอบหมาย</span>
                                {[...new Set(e.rounds.map(r => r.owner_name).filter(Boolean))].length > 0 && (
                                  <div className="text-xs text-gray-500 mt-1">
                                    ครูผู้สร้างข้อสอบ: {[...new Set(e.rounds.map(r => r.owner_name).filter(Boolean))].join(', ')}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
