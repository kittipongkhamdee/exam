// exam-db.js
//
// Supabase data-access helpers for the online-exam feature's teacher-side
// tables:
//
//   online_exam_sets           (id, subject_id, title, created_by, created_at)
//   online_exam_set_questions  (id, exam_set_id, bank_question_id, seq)
//   online_exam_rounds         (id, exam_set_id, pin, unlock_pin, opens_at,
//                                closes_at, duration_minutes, created_by,
//                                created_at)
//
// Named online_exam_* rather than exam_* deliberately — this Supabase
// project already has exam_teachers/exam_rounds/exam_round_slots/
// exam_submissions from the unrelated ปพ.5 exam-schedule (invigilation
// duty) feature.
//
// A ชุดข้อสอบ (online_exam_sets) is a reusable, ordered pick of questions
// from bank_questions. A รอบสอบ (online_exam_rounds) schedules one ชุดข้อสอบ
// for students to actually take: a time window, a per-student duration
// limit once started, and a single PIN shared by the whole round (per the
// teacher's own scoping — one PIN per round, not per student). unlock_pin
// is a second, separate code — never shown to students — that the
// proctoring teacher enters on a locked student's device after a screen-
// switch violation (see record_exam_violation/unlock_exam_attempt).
//
// RLS on all three follows the same owner-or-admin pattern as
// bank_questions/omr_quizzes: the owning teacher (subjects.user_id =
// auth.uid(), reached via subject_id or via exam_set_id -> subject_id) can
// manage their own rows, admins (is_admin()) can manage everything. The
// list functions below still add an explicit subjects.user_id filter on
// top of RLS — same reasoning as bank-db.js's listMyBankQuestions: an admin
// session must not see every teacher's data in what's meant to be "my own"
// here.
//
// online_exam_proctor_assignments (assign_date, grade_level, room,
// teacher_id) is a separate, admin-managed table: who's assigned to
// physically proctor a ชั้น/ห้อง on a given date. A รอบสอบ's schedule_type
// ('scheduled' = ในตาราง, set by admin-assigned proctor duty | 'adhoc' =
// นอกตาราง, the creating teacher proctors themself) is informational on the
// round only — it is NOT currently an access gate. An earlier attempt at
// this (is_assigned_proctor() + additive SELECT policies on
// online_exam_rounds/online_exam_sets/online_exam_attempts, from the
// add_proctor_monitor_read_access migration) was reverted live
// (drop_recursive_proctor_read_policies) after it broke ALL reads/writes
// on those three tables for every teacher with "infinite recursion
// detected in policy" — online_exam_rounds's policy read
// online_exam_sets/subjects, whose policy read online_exam_rounds back,
// and is_assigned_proctor's own body read online_exam_rounds from within
// online_exam_rounds's own policy. Neither converting the helper to
// plpgsql nor `SET row_security = off` inside it cleared the recursion
// guard when tested live — this is a hard Postgres structural limit, not
// a language/role-bypass issue. A non-owning assigned proctor's
// "ชั้น/ห้อง" มอนิเตอร์ view (ExamMonitorTool.jsx room mode) currently
// only shows what RLS already grants (their own rounds, or everything if
// admin) — reimplementing "see a room's rounds you don't own" needs a
// SECURITY DEFINER RPC (matching start_exam_attempt/is_admin's proven
// pattern: a top-level function call, never invoked from inside one of
// these tables' own policies), not raw table RLS.

import { createQuiz, deleteQuiz } from './omr-db';
import { analyzeItems, starRatingFromStats } from './item-analysis';
import { formatStudentName } from './student-name';
import { saveBankQuestions } from './bank-db';

/**
 * List this teacher's ชุดข้อสอบ, each with its subject and question count.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ subjectId?: string }} [opts]
 */
export async function listMyExamSets(supabase, opts = {}) {
  const { data: { user } } = await supabase.auth.getUser();
  let query = supabase
    .from('online_exam_sets')
    .select(`
      id, subject_id, title, created_at,
      subjects!inner ( subject_name, subject_code, grade_level, room, user_id ),
      online_exam_set_questions ( count )
    `)
    .eq('subjects.user_id', user?.id ?? '')
    .order('created_at', { ascending: false });
  if (opts.subjectId) query = query.eq('subject_id', opts.subjectId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(s => ({
    ...s,
    question_count: s.online_exam_set_questions?.[0]?.count ?? 0,
  }));
}

/**
 * Fetch one ชุดข้อสอบ with its questions in order, for the edit form.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
export async function getExamSetWithQuestions(supabase, id) {
  const { data, error } = await supabase
    .from('online_exam_sets')
    .select(`
      id, subject_id, title, printed_quiz_id,
      subjects ( subject_name, subject_code, grade_level, room ),
      online_exam_set_questions ( seq, points, bank_question_id, bank_questions ( id, question_text, difficulty, num_choices, source, choices, correct_choice, image_path ) )
    `)
    .eq('id', id)
    .single();
  if (error) throw error;
  const questions = (data.online_exam_set_questions || [])
    .sort((a, b) => a.seq - b.seq)
    .filter(x => x.bank_questions)
    .map(x => ({ ...x.bank_questions, points: x.points }));
  return {
    id: data.id,
    subject_id: data.subject_id,
    title: data.title,
    printed_quiz_id: data.printed_quiz_id,
    subject_name: data.subjects?.subject_name,
    subject_code: data.subjects?.subject_code,
    grade_level: data.subjects?.grade_level,
    room: data.subjects?.room,
    questions,
  };
}

/**
 * Whether a ชุดข้อสอบ has any รอบสอบ with at least one submitted attempt —
 * used to warn a teacher before they edit a set whose composition/points
 * students have already been scored against. A submitted attempt's own
 * score stays correct either way (submit_exam_attempt captures total_points
 * once at start_exam_attempt time), but item-analysis/quality-stat reports
 * re-read the set's *current* online_exam_set_questions, so editing after
 * the fact can make past reports inconsistent with what those students
 * actually saw.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} examSetId
 * @returns {Promise<boolean>}
 */
export async function examSetHasSubmittedAttempts(supabase, examSetId) {
  const { data: rounds, error: e1 } = await supabase
    .from('online_exam_rounds')
    .select('id')
    .eq('exam_set_id', examSetId);
  if (e1) throw e1;
  if (!rounds || rounds.length === 0) return false;

  const { count, error: e2 } = await supabase
    .from('online_exam_attempts')
    .select('id', { count: 'exact', head: true })
    .in('round_id', rounds.map(r => r.id))
    .not('submitted_at', 'is', null);
  if (e2) throw e2;
  return (count ?? 0) > 0;
}

/**
 * Create or update a ชุดข้อสอบ, replacing its full question list each time
 * — simplest correct way to persist a reordered/edited selection without a
 * client-side transaction.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id?: string, subjectId: string, title: string, questions: Array<{ id: string, points: number }> }} args
 * @returns {Promise<string>} the exam set's id
 */
export async function saveExamSet(supabase, { id, subjectId, title, questions }) {
  const { data: { user } } = await supabase.auth.getUser();
  let examSetId = id;
  if (examSetId) {
    const { error } = await supabase.from('online_exam_sets').update({ subject_id: subjectId, title }).eq('id', examSetId);
    if (error) throw error;
    const { error: delError } = await supabase.from('online_exam_set_questions').delete().eq('exam_set_id', examSetId);
    if (delError) throw delError;
  } else {
    const { data, error } = await supabase.from('online_exam_sets').insert({ subject_id: subjectId, title, created_by: user.id }).select('id').single();
    if (error) throw error;
    examSetId = data.id;
  }
  const rows = questions.map((q, i) => ({ exam_set_id: examSetId, bank_question_id: q.id, seq: i + 1, points: q.points }));
  if (rows.length > 0) {
    const { error } = await supabase.from('online_exam_set_questions').insert(rows);
    if (error) throw error;
  }
  return examSetId;
}

/**
 * Delete a ชุดข้อสอบ (cascades to its question list and any scheduled
 * รอบสอบ).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
export async function deleteExamSet(supabase, id) {
  const { error } = await supabase.from('online_exam_sets').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Copies a ชุดข้อสอบ into a different subject — typically the same course
 * taught in another ห้อง, since a รอบสอบ can only admit students from the
 * one ห้อง its ชุดข้อสอบ's subject belongs to (see start_exam_attempt: it
 * matches the entering student's grade_level/room against the subject's),
 * so reusing the same set across rooms isn't otherwise possible. Both
 * bank_questions and online_exam_sets are subject-scoped with no
 * cross-subject sharing, so this copies each question into the target
 * subject's own bank first (via saveBankQuestions — the same insert path
 * as writing a question by hand or from AI, so the teacher never retypes
 * anything) and then a new ชุดข้อสอบ pointing at those copies, in the same
 * order. RLS requires the target subject to belong to the caller, same as
 * creating either from scratch; the source ชุดข้อสอบ is left untouched.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ examSetId: string, targetSubjectId: string, title: string }} args
 * @returns {Promise<string>} the new ชุดข้อสอบ's id
 */
export async function copyExamSetToSubject(supabase, { examSetId, targetSubjectId, title }) {
  const { data: setRow, error: setError } = await supabase
    .from('online_exam_sets')
    .select(`
      online_exam_set_questions ( seq, points, bank_questions (
        question_text, difficulty, choices, correct_choice, explanation, source, image_path, indicator_id
      ) )
    `)
    .eq('id', examSetId)
    .single();
  if (setError) throw setError;

  const sourceLinks = (setRow.online_exam_set_questions || [])
    .sort((a, b) => a.seq - b.seq)
    .filter(x => x.bank_questions);
  if (sourceLinks.length === 0) throw new Error('ชุดข้อสอบนี้ยังไม่มีข้อสอบ');
  const questions = sourceLinks.map(x => x.bank_questions);

  const { data: { user } } = await supabase.auth.getUser();

  const inserted = await saveBankQuestions(supabase, questions.map(q => ({ ...q, subject_id: targetSubjectId })));

  const { data: newSet, error: newSetError } = await supabase
    .from('online_exam_sets')
    .insert({ subject_id: targetSubjectId, title, created_by: user.id })
    .select('id')
    .single();
  if (newSetError) throw newSetError;

  const linkRows = inserted.map((q, i) => ({ exam_set_id: newSet.id, bank_question_id: q.id, seq: i + 1, points: sourceLinks[i].points }));
  const { error: linkError } = await supabase.from('online_exam_set_questions').insert(linkRows);
  if (linkError) throw linkError;

  return newSet.id;
}

/**
 * List this teacher's scheduled รอบสอบ, each with its ชุดข้อสอบ/subject.
 * Resolves the teacher's own exam-set ids first rather than filtering a
 * doubly-nested embed (online_exam_rounds -> online_exam_sets -> subjects)
 * in one query, since PostgREST's nested-embed filter depth isn't reliable
 * enough to depend on here.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ examSetId?: string }} [opts]
 */
export async function listMyExamRounds(supabase, opts = {}) {
  const { data: { user } } = await supabase.auth.getUser();
  let setQuery = supabase
    .from('online_exam_sets')
    .select('id, subjects!inner ( user_id )')
    .eq('subjects.user_id', user?.id ?? '');
  if (opts.examSetId) setQuery = setQuery.eq('id', opts.examSetId);
  const { data: sets, error: setsError } = await setQuery;
  if (setsError) throw setsError;
  const examSetIds = (sets || []).map(s => s.id);
  if (examSetIds.length === 0) return [];

  const { data, error } = await supabase
    .from('online_exam_rounds')
    .select(`
      id, exam_set_id, pin, unlock_pin, opens_at, closes_at, duration_minutes, results_visible, auto_reveal_results, require_location, schedule_type, created_at,
      online_exam_sets ( title, subjects ( subject_name, subject_code, grade_level, room ) )
    `)
    .in('exam_set_id', examSetIds)
    .order('opens_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Create or update a รอบสอบ.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id?: string, examSetId: string, pin: string, unlockPin: string, opensAt: string, closesAt: string, durationMinutes: number, scheduleType?: 'scheduled'|'adhoc', autoRevealResults?: boolean, requireLocation?: boolean }} args
 */
export async function saveExamRound(supabase, { id, examSetId, pin, unlockPin, opensAt, closesAt, durationMinutes, scheduleType, autoRevealResults, requireLocation }) {
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    exam_set_id: examSetId,
    pin,
    unlock_pin: unlockPin,
    opens_at: opensAt,
    closes_at: closesAt,
    duration_minutes: durationMinutes,
    schedule_type: scheduleType || 'adhoc',
    auto_reveal_results: !!autoRevealResults,
    require_location: !!requireLocation,
  };
  if (id) {
    const { error } = await supabase.from('online_exam_rounds').update(row).eq('id', id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from('online_exam_rounds').insert({ ...row, created_by: user.id });
    if (error) throw error;
  }
}

/**
 * Delete a รอบสอบ.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
export async function deleteExamRound(supabase, id) {
  const { error } = await supabase.from('online_exam_rounds').delete().eq('id', id);
  if (error) throw error;
}

/** Generate a random 6-digit numeric PIN (leading zeros preserved as text). */
export function generatePin() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

/**
 * Manually reveal (or hide) this รอบสอบ's results to every student who's
 * already submitted — the alternative to auto_reveal_results (set at
 * schedule time via saveExamRound), which reveals each student their own
 * score the moment they submit instead of needing this button. Once true,
 * a student re-entering their PIN + student code on an already-submitted
 * attempt gets their score back (see start_exam_attempt) instead of an
 * already_submitted error.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roundId
 * @param {boolean} visible
 */
export async function setRoundResultsVisible(supabase, roundId, visible) {
  const { error } = await supabase.from('online_exam_rounds').update({ results_visible: visible }).eq('id', roundId);
  if (error) throw error;
}

/**
 * A รอบสอบ's full roster — every student in the exam set's subject's
 * grade_level/room — merged against whatever online_exam_attempts row (if
 * any) each of them has for this round, for the "รายงาน" page. Two
 * separate queries (roster, then attempts) merged client-side rather than
 * one join, since a student with no attempt at all still needs to show up
 * as "ยังไม่ได้เข้าสอบ" — an outer join PostgREST can't express from the
 * attempts side.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roundId
 */
export async function getRoundReport(supabase, roundId) {
  const { data: round, error: roundError } = await supabase
    .from('online_exam_rounds')
    .select(`
      id, pin, unlock_pin, opens_at, closes_at, duration_minutes, results_visible, auto_reveal_results,
      online_exam_sets ( title, subjects ( subject_name, subject_code, grade_level, room ) )
    `)
    .eq('id', roundId)
    .single();
  if (roundError) throw roundError;

  const subject = round.online_exam_sets?.subjects;

  const { data: roster, error: rosterError } = await supabase
    .from('students')
    .select('id, student_code, student_name, prefix')
    .eq('grade_level', subject?.grade_level ?? '')
    .eq('room', subject?.room ?? '')
    .order('student_code', { ascending: true });
  if (rosterError) throw rosterError;

  const { data: attempts, error: attemptsError } = await supabase
    .from('online_exam_attempts')
    .select('id, student_id, started_at, submitted_at, total_correct, total_questions, total_points, earned_points, score, violation_count')
    .eq('round_id', roundId);
  if (attemptsError) throw attemptsError;

  const attemptByStudent = new Map((attempts || []).map(a => [a.student_id, a]));

  const rows = (roster || []).map(s => {
    const attempt = attemptByStudent.get(s.id);
    const status = attempt?.submitted_at ? 'submitted' : (attempt ? 'in_progress' : 'not_started');
    return {
      student_id: s.id,
      student_code: s.student_code,
      student_name: formatStudentName(s),
      status,
      attempt_id: attempt?.id ?? null,
      started_at: attempt?.started_at ?? null,
      submitted_at: attempt?.submitted_at ?? null,
      total_correct: attempt?.total_correct ?? null,
      total_questions: attempt?.total_questions ?? null,
      total_points: attempt?.total_points ?? null,
      earned_points: attempt?.earned_points ?? null,
      score: attempt?.score ?? null,
      violation_count: attempt?.violation_count ?? 0,
    };
  });

  return {
    id: round.id,
    pin: round.pin,
    unlock_pin: round.unlock_pin,
    opens_at: round.opens_at,
    closes_at: round.closes_at,
    duration_minutes: round.duration_minutes,
    results_visible: round.results_visible,
    auto_reveal_results: round.auto_reveal_results,
    exam_set_title: round.online_exam_sets?.title,
    subject_name: subject?.subject_name,
    grade_level: subject?.grade_level,
    room: subject?.room,
    rows,
  };
}

/**
 * Deletes one student's attempt at a รอบสอบ (in-progress or already
 * submitted, cascading to their saved answers) so they can log in with
 * the same PIN + เลขประจำตัวนักเรียน and start a completely fresh attempt —
 * for a genuine retake (a technical failure mid-exam, a mistake the
 * teacher wants to let them redo), not something a student can trigger
 * themselves. Per-attempt, not per-round: resetting one student never
 * touches anyone else's attempt at the same รอบสอบ. Authorized via the
 * reset_exam_attempt RPC (is_admin() or owning the attempt's subject),
 * matching every other exam-scoped write in this file.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} attemptId
 */
export async function resetExamAttempt(supabase, attemptId) {
  const { error } = await supabase.rpc('reset_exam_attempt', { p_attempt_id: attemptId });
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Live proctor monitor ("คุมสอบ") — real-time view of who's taking an
// online exam right now, for a teacher physically watching a room. Two
// entry points: by รอบสอบ (a teacher watching their own exam, typically
// นอกตาราง/ad-hoc) or by ชั้น/ห้อง + date (intended for a teacher assigned
// by the admin to proctor a room, watching every online exam happening
// there that day regardless of which teacher set it up — see the note at
// the top of this file: the RLS grant for a non-owning assigned proctor
// was reverted after it caused RLS recursion, so room mode currently only
// surfaces rounds the caller already owns, or everything for an admin).
// Realtime subscriptions on online_exam_attempts respect the same RLS, so
// a live channel only ever delivers rows the viewer is already allowed to
// read.

/**
 * A รอบสอบ's live monitor data — same shape as getRoundReport, plus
 * `locked` per row (needed to render/act on a lock from the monitor) and
 * the round's schedule_type.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roundId
 */
export async function getRoundMonitor(supabase, roundId) {
  const { data: round, error: roundError } = await supabase
    .from('online_exam_rounds')
    .select(`
      id, pin, unlock_pin, opens_at, closes_at, duration_minutes, results_visible, schedule_type,
      online_exam_sets ( title, subjects ( subject_name, subject_code, grade_level, room ) )
    `)
    .eq('id', roundId)
    .single();
  if (roundError) throw roundError;

  const subject = round.online_exam_sets?.subjects;

  const { data: roster, error: rosterError } = await supabase
    .from('students')
    .select('id, student_code, student_name, prefix')
    .eq('grade_level', subject?.grade_level ?? '')
    .eq('room', subject?.room ?? '')
    .order('student_code', { ascending: true });
  if (rosterError) throw rosterError;

  const { data: attempts, error: attemptsError } = await supabase
    .from('online_exam_attempts')
    .select('id, student_id, started_at, submitted_at, total_correct, total_questions, score, violation_count, locked, location_lat, location_lng')
    .eq('round_id', roundId);
  if (attemptsError) throw attemptsError;

  const attemptByStudent = new Map((attempts || []).map(a => [a.student_id, a]));

  const rows = (roster || []).map(s => {
    const attempt = attemptByStudent.get(s.id);
    const status = attempt?.submitted_at ? 'submitted' : (attempt ? 'in_progress' : 'not_started');
    return {
      student_id: s.id,
      student_code: s.student_code,
      student_name: formatStudentName(s),
      status,
      attempt_id: attempt?.id ?? null,
      started_at: attempt?.started_at ?? null,
      submitted_at: attempt?.submitted_at ?? null,
      total_correct: attempt?.total_correct ?? null,
      total_questions: attempt?.total_questions ?? null,
      score: attempt?.score ?? null,
      violation_count: attempt?.violation_count ?? 0,
      locked: attempt?.locked ?? false,
      location_lat: attempt?.location_lat ?? null,
      location_lng: attempt?.location_lng ?? null,
    };
  });

  return {
    id: round.id,
    pin: round.pin,
    unlock_pin: round.unlock_pin,
    opens_at: round.opens_at,
    closes_at: round.closes_at,
    duration_minutes: round.duration_minutes,
    schedule_type: round.schedule_type,
    exam_set_title: round.online_exam_sets?.title,
    subject_name: subject?.subject_name,
    grade_level: subject?.grade_level,
    room: subject?.room,
    rows,
  };
}

/**
 * Every รอบสอบ opening on a given date for a given ชั้น/ห้อง, with each
 * round's live monitor data — for a teacher assigned to proctor a physical
 * room rather than one specific exam, watching every online exam
 * happening there that day regardless of which teacher set it up.
 *
 * Goes through the get_room_monitor_for_proctor RPC rather than plain
 * table reads: that's the replacement for the online_exam_rounds/sets/
 * attempts proctor-read RLS policies reverted in
 * drop_recursive_proctor_read_policies (they caused infinite RLS
 * recursion — a table's own policy can't safely call back into itself,
 * even indirectly through another table). A SECURITY DEFINER RPC that's
 * never invoked from inside one of those tables' own policies doesn't hit
 * that recursion guard, matching the proven pattern of
 * start_exam_attempt/is_admin/proctor_unlock_exam_attempt. The RPC
 * authorizes via is_admin() or a matching online_exam_proctor_assignments
 * row for auth.uid(), and deliberately never returns score/total_correct
 * — this is the operational "who's stuck/locked right now" lens for a
 * room proctor who may not be the subject's own teacher, not a grading
 * view. Owners/admins watching their own exam still see real scores via
 * getRoundMonitor ("รายรอบ" mode) or the "รายงาน" report page.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ date: string, gradeLevel: string, room: string }} args
 */
export async function getRoomMonitor(supabase, { date, gradeLevel, room }) {
  const { data, error } = await supabase.rpc('get_room_monitor_for_proctor', {
    p_date: date,
    p_grade_level: gradeLevel,
    p_room: room,
  });
  if (error) throw error;
  return (data || []).map(round => ({ ...round, id: round.round_id }));
}

/**
 * Every รอบสอบ opening on a given date, across every ชั้น/ห้อง and every
 * teacher's subjects — the "ตารางคุมสอบ" duty-schedule board any signed-in
 * teacher can check (who's proctoring what, where, and when today), not
 * just an admin or the room's own assigned proctor. Goes through the
 * list_exam_day_schedule RPC for the same reason getRoomMonitor does (a
 * SECURITY DEFINER function sidesteps the RLS-recursion guard on
 * online_exam_rounds/sets) — its authorization is deliberately just "is
 * this caller signed in at all", the loosest of the three proctor-facing
 * RPCs, since PIN/รหัสปลดล็อก are meant to stay only off-limits to
 * students, not to other staff.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} date 'YYYY-MM-DD'
 */
export async function listExamDaySchedule(supabase, date) {
  const { data, error } = await supabase.rpc('list_exam_day_schedule', { p_date: date });
  if (error) throw error;
  return data || [];
}

/**
 * Every รอบสอบ the current user is allowed to watch live: their own
 * (created via subjects ownership) plus any they're an admin-assigned
 * proctor for, plus everything if they're an admin — RLS decides which
 * rows come back, deliberately unlike listMyExamRounds's "my own only"
 * scoping.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listMonitorableRounds(supabase) {
  const { data, error } = await supabase
    .from('online_exam_rounds')
    .select(`
      id, opens_at, closes_at, schedule_type,
      online_exam_sets ( title, subjects ( subject_name, grade_level, room ) )
    `)
    .order('opens_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Unlock a locked attempt from the live monitor, using the caller's own
 * identity (owner teacher / admin / assigned proctor) instead of the
 * round's unlock_pin.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} attemptId
 */
export async function proctorUnlockAttempt(supabase, attemptId) {
  const { error } = await supabase.rpc('proctor_unlock_exam_attempt', { p_attempt_id: attemptId });
  if (error) throw error;
}

/**
 * Whether a locked attempt is still locked, for StudentExamTool.jsx to poll
 * while its own "หน้าจอถูกล็อก" prompt is open — closing it the moment the
 * proctoring teacher unlocks from the live monitor (a different browser),
 * instead of leaving the student stuck until they think to refresh.
 * Deliberately a poll rather than a persistent Realtime channel: this only
 * matters for the rare, short window a given student is actually locked,
 * so polling avoids every one of 200+ concurrently-exam-taking students
 * holding an open Realtime connection for the entire exam (Supabase's
 * free-tier concurrent-connection cap is exactly 200). A SECURITY DEFINER
 * RPC because the anon key students use has no RLS SELECT grant on
 * online_exam_attempts (deliberately: that table carries scores, which
 * must stay hidden from students until the teacher reveals them) — same
 * "knowing the attempt_id is the authorization" pattern as
 * record_exam_violation/unlock_exam_attempt.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} attemptId
 */
export async function getAttemptLockStatus(supabase, attemptId) {
  const { data, error } = await supabase.rpc('get_attempt_lock_status', { p_attempt_id: attemptId });
  if (error) throw error;
  return !!data;
}

// Proximity-check feature: a student's browser reports its own one-time
// location at exam start (if the admin has this on and the student grants
// the permission prompt — never required, never re-requested mid-exam),
// purely so the live monitor can flag students sitting closer together
// than the admin's configured minimum, for the proctoring teacher to judge
// (they know who genuinely lives next door) — not an automatic block. A
// SECURITY DEFINER RPC for the same reason as the other student-facing
// exam RPCs: the anon key students use has no RLS write access to
// online_exam_attempts, and knowing the attempt_id is the authorization
// (see record_exam_violation/unlock_exam_attempt).
/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} attemptId
 * @param {number} lat
 * @param {number} lng
 */
export async function saveAttemptLocation(supabase, attemptId, lat, lng) {
  const { error } = await supabase.rpc('save_exam_attempt_location', { p_attempt_id: attemptId, p_lat: lat, p_lng: lng });
  if (error) throw error;
}

/**
 * Locks an attempt from the live monitor on the proctoring teacher's own
 * judgment (e.g. a proximity-check flag they've decided is genuinely
 * suspicious) — same "locked" flag and authorization pattern as
 * proctorUnlockAttempt, just the opposite direction. The locked student's
 * own browser picks this up via its continuous lock-status poll (see
 * StudentExamTool.jsx) and shows the same "หน้าจอถูกล็อก" prompt as a
 * screen-switch violation, needing the round's unlock PIN (or another
 * proctor unlock) to continue.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} attemptId
 */
export async function proctorLockAttempt(supabase, attemptId) {
  const { error } = await supabase.rpc('proctor_lock_exam_attempt', { p_attempt_id: attemptId });
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Admin-managed proctor duty roster (who watches which ชั้น/ห้อง on which
// date). Write access is admin-only (RLS); a non-admin caller can still
// read their own assignments via listProctorAssignmentsForDate to know
// what they're covering.

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} date 'YYYY-MM-DD'
 */
export async function listProctorAssignmentsForDate(supabase, date) {
  // teacher_id and created_by both FK to profiles(id), so the embed below
  // must name the constraint explicitly (profiles!<fk name>) — otherwise
  // PostgREST can't tell which relationship "profiles ( full_name )"
  // should follow and rejects the query as ambiguous.
  const { data, error } = await supabase
    .from('online_exam_proctor_assignments')
    .select('id, assign_date, grade_level, room, teacher_id, profiles!online_exam_proctor_assignments_teacher_id_fkey ( full_name )')
    .eq('assign_date', date)
    .order('grade_level', { ascending: true })
    .order('room', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ date: string, gradeLevel: string, room: string, teacherId: string }} args
 */
export async function saveProctorAssignment(supabase, { date, gradeLevel, room, teacherId }) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('online_exam_proctor_assignments').insert({
    assign_date: date,
    grade_level: gradeLevel,
    room,
    teacher_id: teacherId,
    created_by: user.id,
  });
  if (error) throw error;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
export async function deleteProctorAssignment(supabase, id) {
  const { error } = await supabase.from('online_exam_proctor_assignments').delete().eq('id', id);
  if (error) throw error;
}

/** Distinct ชั้น/ห้อง pairs across every subject, for the admin's assignment picker. */
export async function listGradeRoomOptions(supabase) {
  const { data, error } = await supabase.from('subjects').select('grade_level, room');
  if (error) throw error;
  const seen = new Map();
  for (const s of data || []) {
    const key = `${s.grade_level}|${s.room}`;
    if (!seen.has(key)) seen.set(key, { grade_level: s.grade_level, room: s.room });
  }
  return [...seen.values()].sort((a, b) =>
    a.grade_level.localeCompare(b.grade_level, 'th') || a.room.localeCompare(b.room, 'th'));
}

/** Every teacher account, for the admin's proctor picker. */
export async function listAllTeachers(supabase) {
  const { data, error } = await supabase.from('profiles').select('id, full_name').order('full_name', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Every รอบสอบ in the system, each tagged with its owning teacher's name —
 * for the "รายงาน" page's admin-only "ทุกคน" view. Unlike listMyExamRounds,
 * this doesn't add an ownership filter on top of RLS; a non-admin caller
 * would just get back what RLS already lets them see (their own rounds),
 * so this is only meaningfully "every round" for an admin session
 * (admin_all_online_exam_rounds). Two-step fetch + batched profiles lookup,
 * same pattern as omr-db.js's listAllQuizzes.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listAllExamRoundsWithTeacher(supabase) {
  const { data, error } = await supabase
    .from('online_exam_rounds')
    .select(`
      id, opens_at,
      online_exam_sets ( title, subjects ( subject_name, grade_level, room, user_id ) )
    `)
    .order('opens_at', { ascending: false });
  if (error) throw error;

  const userIds = [...new Set((data || []).map(r => r.online_exam_sets?.subjects?.user_id).filter(Boolean))];
  let nameByUserId = {};
  if (userIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
    nameByUserId = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));
  }
  return (data || []).map(r => ({ ...r, teacherName: nameByUserId[r.online_exam_sets?.subjects?.user_id] || null }));
}

// ---------------------------------------------------------------------
// Printing a ชุดข้อสอบ to paper — for a teacher running the exam offline
// (see exam-print.js for the actual question-paper PDF). The matching OMR
// answer key is auto-filled here from the same questions' correct_choice,
// instead of the teacher re-typing it into "กำหนดเฉลย" by hand.

/**
 * Creates (or, if safe, replaces) the omr_quizzes + omr_answer_keys pulled
 * from a ชุดข้อสอบ's questions, and links it back via
 * online_exam_sets.printed_quiz_id.
 *
 * A re-print reuses the same underlying quiz (deleting and recreating it)
 * ONLY if it has no omr_scan_results yet — once a teacher has actually
 * scanned a student's paper against it, that graded data must never be
 * silently destroyed by a later re-print, so a fresh quiz is created
 * instead and the link just moves to it, leaving the old one (and its real
 * scan results) alone.
 *
 * num_choices is uniform for the whole OMR sheet (a fixed bubble grid, not
 * per-question) — same constraint an OMR quiz built by hand already has —
 * so this takes the max across the set's questions.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ examSetId: string, subjectId: string, title: string, questions: Array<{ correct_choice: number, num_choices: number, points?: number }>, existingQuizId?: string|null }} args
 * @returns {Promise<string>} the omr_quizzes id
 */
export async function syncPrintedOmrQuiz(supabase, { examSetId, subjectId, title, questions, existingQuizId }) {
  if (existingQuizId) {
    const { count, error: countError } = await supabase
      .from('omr_scan_results')
      .select('id', { count: 'exact', head: true })
      .eq('quiz_id', existingQuizId);
    if (countError) throw countError;
    if (!count) {
      await deleteQuiz(supabase, existingQuizId);
    }
  }

  const numChoices = Math.max(...questions.map(q => q.num_choices || 4));
  const answerKey = {};
  questions.forEach((q, i) => {
    answerKey[i] = { choices: [q.correct_choice], points: q.points ?? 1 };
  });

  const { quizId } = await createQuiz(supabase, {
    subjectId,
    title,
    numQuestions: questions.length,
    numChoices,
    idDigits: 5,
    choiceScheme: 'thai',
    paperLayout: 'halfLandscape',
    cols: null,
    answerKey,
  });

  const { error } = await supabase.from('online_exam_sets').update({ printed_quiz_id: quizId }).eq('id', examSetId);
  if (error) throw error;

  return quizId;
}

/**
 * Classroom item-analysis (ค่าความยาก/อำนาจจำแนก/KR-20) for a รอบสอบ's
 * submitted attempts — one row per question in the ชุดข้อสอบ's own order
 * (not per on-screen position, since each student saw them in a different
 * shuffled order). online_exam_answers already carries is_correct and the
 * un-shuffled bank_question_id per answer, so no shuffle-unwinding is
 * needed here — just aggregate by bank_question_id.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} roundId
 */
export async function getItemAnalysisForRound(supabase, roundId) {
  const { data: round, error: roundError } = await supabase
    .from('online_exam_rounds')
    .select('exam_set_id')
    .eq('id', roundId)
    .single();
  if (roundError) throw roundError;

  const { data: setQuestions, error: sqError } = await supabase
    .from('online_exam_set_questions')
    .select('seq, bank_question_id, bank_questions ( question_text )')
    .eq('exam_set_id', round.exam_set_id)
    .order('seq', { ascending: true });
  if (sqError) throw sqError;

  const questionIds = (setQuestions || []).map(sq => sq.bank_question_id);
  const questionTexts = (setQuestions || []).map(sq => sq.bank_questions?.question_text || '');

  const { data: attempts, error: attemptsError } = await supabase
    .from('online_exam_attempts')
    .select('id')
    .eq('round_id', roundId)
    .not('submitted_at', 'is', null);
  if (attemptsError) throw attemptsError;
  const attemptIds = (attempts || []).map(a => a.id);

  if (attemptIds.length === 0) {
    return { questionIds, questionTexts, ...analyzeItems(questionIds.map(() => [])) };
  }

  const { data: answers, error: answersError } = await supabase
    .from('online_exam_answers')
    .select('attempt_id, bank_question_id, is_correct')
    .in('attempt_id', attemptIds);
  if (answersError) throw answersError;

  const byAttemptThenQuestion = new Map();
  for (const a of answers || []) {
    if (!byAttemptThenQuestion.has(a.attempt_id)) byAttemptThenQuestion.set(a.attempt_id, new Map());
    byAttemptThenQuestion.get(a.attempt_id).set(a.bank_question_id, a.is_correct);
  }

  const itemMatrix = questionIds.map(qid =>
    attemptIds.map(aid => (byAttemptThenQuestion.get(aid)?.get(qid) ? 1 : 0))
  );

  return { questionIds, questionTexts, ...analyzeItems(itemMatrix) };
}

/**
 * Per-bank_question_id usage/quality stats for the คลังข้อสอบ list: how
 * many รอบสอบ have used the question, plus an automatic 1-5 star rating
 * (see starRatingFromStats in item-analysis.js) computed from its
 * difficulty/discrimination pooled — sample-size-weighted — across every
 * รอบสอบ that administered it and had ≥2 submitted attempts (the same
 * minimum ItemAnalysisTable itself requires before showing a verdict).
 * RLS on every table queried here already scopes rows to the caller's own
 * subjects (or admin), so this never needs an explicit teacher filter —
 * same reasoning as getItemAnalysisForRound above.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} questionIds
 * @returns {Promise<Record<string, { usageCount: number, sampleN: number, avgP: number|null, avgR: number|null, stars: number|null }>>}
 */
// PostgREST encodes `.in('col', ids)` as a comma-joined literal in the
// query string — a bank/history large enough (hundreds+ of question,
// round, or attempt ids) can blow past URL length limits at the Supabase
// gateway. Chunk any id list handed to `.in()` and merge the results.
const IN_CHUNK_SIZE = 200;
function chunkIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK_SIZE) out.push(ids.slice(i, i + IN_CHUNK_SIZE));
  return out;
}
async function selectInChunks(ids, runChunk) {
  const rows = [];
  for (const chunk of chunkIds(ids)) {
    const { data, error } = await runChunk(chunk);
    if (error) throw error;
    if (data) rows.push(...data);
  }
  return rows;
}

export async function getBankQuestionQualityStats(supabase, questionIds) {
  const stats = {};
  for (const qid of questionIds) stats[qid] = { usageCount: 0, sampleN: 0, avgP: null, avgR: null, stars: null };
  if (!questionIds || questionIds.length === 0) return stats;

  const setQs = await selectInChunks(questionIds, chunk =>
    supabase.from('online_exam_set_questions').select('bank_question_id, exam_set_id').in('bank_question_id', chunk)
  );
  if (!setQs || setQs.length === 0) return stats;

  const setIdsByQuestion = new Map();
  const allSetIds = new Set();
  for (const row of setQs) {
    if (!setIdsByQuestion.has(row.bank_question_id)) setIdsByQuestion.set(row.bank_question_id, new Set());
    setIdsByQuestion.get(row.bank_question_id).add(row.exam_set_id);
    allSetIds.add(row.exam_set_id);
  }

  const rounds = await selectInChunks([...allSetIds], chunk =>
    supabase.from('online_exam_rounds').select('id, exam_set_id').in('exam_set_id', chunk)
  );

  const roundsBySet = new Map();
  for (const r of rounds || []) {
    if (!roundsBySet.has(r.exam_set_id)) roundsBySet.set(r.exam_set_id, []);
    roundsBySet.get(r.exam_set_id).push(r.id);
  }
  for (const [qid, setIds] of setIdsByQuestion) {
    let count = 0;
    for (const sid of setIds) count += (roundsBySet.get(sid) || []).length;
    stats[qid].usageCount = count;
  }
  if (!rounds || rounds.length === 0) return stats;

  const roundIds = rounds.map(r => r.id);
  const attempts = await selectInChunks(roundIds, chunk =>
    supabase.from('online_exam_attempts').select('id, round_id').in('round_id', chunk).not('submitted_at', 'is', null)
  );

  const attemptsByRound = new Map();
  for (const a of attempts || []) {
    if (!attemptsByRound.has(a.round_id)) attemptsByRound.set(a.round_id, []);
    attemptsByRound.get(a.round_id).push(a.id);
  }

  const qualifyingRounds = rounds.filter(r => (attemptsByRound.get(r.id)?.length || 0) >= 2);
  if (qualifyingRounds.length === 0) return stats;

  const qualifyingSetIds = [...new Set(qualifyingRounds.map(r => r.exam_set_id))];
  const allSetQs = await selectInChunks(qualifyingSetIds, chunk =>
    supabase.from('online_exam_set_questions').select('exam_set_id, seq, bank_question_id').in('exam_set_id', chunk).order('seq', { ascending: true })
  );

  const questionsBySet = new Map();
  for (const row of allSetQs || []) {
    if (!questionsBySet.has(row.exam_set_id)) questionsBySet.set(row.exam_set_id, []);
    questionsBySet.get(row.exam_set_id).push(row.bank_question_id);
  }

  const qualifyingAttemptIds = qualifyingRounds.flatMap(r => attemptsByRound.get(r.id) || []);
  const answers = await selectInChunks(qualifyingAttemptIds, chunk =>
    supabase.from('online_exam_answers').select('attempt_id, bank_question_id, is_correct').in('attempt_id', chunk)
  );

  const byAttemptThenQuestion = new Map();
  for (const a of answers || []) {
    if (!byAttemptThenQuestion.has(a.attempt_id)) byAttemptThenQuestion.set(a.attempt_id, new Map());
    byAttemptThenQuestion.get(a.attempt_id).set(a.bank_question_id, a.is_correct ? 1 : 0);
  }

  const targetSet = new Set(questionIds);
  const accum = new Map();

  for (const round of qualifyingRounds) {
    const qids = questionsBySet.get(round.exam_set_id) || [];
    const attemptIds = attemptsByRound.get(round.id) || [];
    const itemMatrix = qids.map(qid => attemptIds.map(aid => byAttemptThenQuestion.get(aid)?.get(qid) ?? 0));
    const { items } = analyzeItems(itemMatrix);
    const n = attemptIds.length;
    qids.forEach((qid, i) => {
      if (!targetSet.has(qid)) return;
      if (!accum.has(qid)) accum.set(qid, { n: 0, sumPN: 0, pWeight: 0, sumRN: 0, rWeight: 0 });
      const acc = accum.get(qid);
      const it = items[i];
      acc.n += n;
      if (it.p !== null) { acc.sumPN += it.p * n; acc.pWeight += n; }
      if (it.r !== null) { acc.sumRN += it.r * n; acc.rWeight += n; }
    });
  }

  for (const [qid, acc] of accum) {
    const avgP = acc.pWeight > 0 ? acc.sumPN / acc.pWeight : null;
    const avgR = acc.rWeight > 0 ? acc.sumRN / acc.rWeight : null;
    stats[qid] = {
      usageCount: stats[qid].usageCount,
      sampleN: acc.n,
      avgP,
      avgR,
      stars: starRatingFromStats(avgP, avgR),
    };
  }

  return stats;
}

// ---------------------------------------------------------------------
// Admin-facing "log ระบบการสอบ" — a read of the platform-wide audit_log
// table (id, actor_id, actor_name, action, detail, created_at), which
// this app didn't create — it's shared infrastructure already provisioned
// for the whole Supabase project (RLS already admin-only SELECT, already
// open INSERT), previously unused by anything. The five exam RPCs
// (start_exam_attempt, record_exam_violation, unlock_exam_attempt,
// proctor_unlock_exam_attempt, submit_exam_attempt) each call the
// SECURITY DEFINER log_exam_event() helper to write into it — see the
// add_exam_audit_logging migration. Actions are prefixed 'exam_' so this
// filters to just this app's events even if something else on the
// platform starts writing other kinds of rows here later.

export const EXAM_AUDIT_ACTION_LABEL = {
  exam_login: 'เข้าสอบ',
  exam_violation: 'สลับหน้าจอ (ล็อก)',
  exam_violation_exceeded: 'สลับหน้าจอเกินกำหนด (ส่งอัตโนมัติ)',
  exam_unlock_pin: 'ปลดล็อกด้วยรหัส',
  exam_unlock_proctor: 'ปลดล็อกจากมอนิเตอร์',
  exam_lock_proctor: 'บล็อกจากมอนิเตอร์ (ตำแหน่งผิดปกติ)',
  exam_submit: 'ส่งข้อสอบ',
  exam_attempt_reset: 'รีเซ็ตให้สอบใหม่',
};

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ limit?: number }} [opts]
 */
export async function listExamAuditLog(supabase, opts = {}) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('id, actor_id, actor_name, action, detail, created_at')
    .like('action', 'exam_%')
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (error) throw error;
  return data;
}
