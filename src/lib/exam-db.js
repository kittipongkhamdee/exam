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
import { analyzeItems } from './item-analysis';

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
      subjects ( subject_name, grade_level, room ),
      online_exam_set_questions ( seq, bank_question_id, bank_questions ( id, question_text, difficulty, num_choices, source, choices, correct_choice, image_path ) )
    `)
    .eq('id', id)
    .single();
  if (error) throw error;
  const questions = (data.online_exam_set_questions || [])
    .sort((a, b) => a.seq - b.seq)
    .map(x => x.bank_questions)
    .filter(Boolean);
  return {
    id: data.id,
    subject_id: data.subject_id,
    title: data.title,
    printed_quiz_id: data.printed_quiz_id,
    subject_name: data.subjects?.subject_name,
    grade_level: data.subjects?.grade_level,
    room: data.subjects?.room,
    questions,
  };
}

/**
 * Create or update a ชุดข้อสอบ, replacing its full question list each time
 * — simplest correct way to persist a reordered/edited selection without a
 * client-side transaction.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ id?: string, subjectId: string, title: string, questionIds: string[] }} args
 * @returns {Promise<string>} the exam set's id
 */
export async function saveExamSet(supabase, { id, subjectId, title, questionIds }) {
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
  const rows = questionIds.map((qid, i) => ({ exam_set_id: examSetId, bank_question_id: qid, seq: i + 1 }));
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
      id, exam_set_id, pin, unlock_pin, opens_at, closes_at, duration_minutes, results_visible, schedule_type, created_at,
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
 * @param {{ id?: string, examSetId: string, pin: string, unlockPin: string, opensAt: string, closesAt: string, durationMinutes: number, scheduleType?: 'scheduled'|'adhoc' }} args
 */
export async function saveExamRound(supabase, { id, examSetId, pin, unlockPin, opensAt, closesAt, durationMinutes, scheduleType }) {
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    exam_set_id: examSetId,
    pin,
    unlock_pin: unlockPin,
    opens_at: opensAt,
    closes_at: closesAt,
    duration_minutes: durationMinutes,
    schedule_type: scheduleType || 'adhoc',
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
 * Set whether this รอบสอบ's results are revealed to students. Once true, a
 * student re-entering their PIN + student code on an already-submitted
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
      id, pin, unlock_pin, opens_at, closes_at, duration_minutes, results_visible,
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
    .select('id, student_id, started_at, submitted_at, total_correct, total_questions, score, violation_count')
    .eq('round_id', roundId);
  if (attemptsError) throw attemptsError;

  const attemptByStudent = new Map((attempts || []).map(a => [a.student_id, a]));

  const rows = (roster || []).map(s => {
    const attempt = attemptByStudent.get(s.id);
    const status = attempt?.submitted_at ? 'submitted' : (attempt ? 'in_progress' : 'not_started');
    return {
      student_id: s.id,
      student_code: s.student_code,
      student_name: `${s.prefix || ''}${s.student_name}`,
      status,
      started_at: attempt?.started_at ?? null,
      submitted_at: attempt?.submitted_at ?? null,
      total_correct: attempt?.total_correct ?? null,
      total_questions: attempt?.total_questions ?? null,
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
    exam_set_title: round.online_exam_sets?.title,
    subject_name: subject?.subject_name,
    grade_level: subject?.grade_level,
    room: subject?.room,
    rows,
  };
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
    .select('id, student_id, started_at, submitted_at, total_correct, total_questions, score, violation_count, locked')
    .eq('round_id', roundId);
  if (attemptsError) throw attemptsError;

  const attemptByStudent = new Map((attempts || []).map(a => [a.student_id, a]));

  const rows = (roster || []).map(s => {
    const attempt = attemptByStudent.get(s.id);
    const status = attempt?.submitted_at ? 'submitted' : (attempt ? 'in_progress' : 'not_started');
    return {
      student_id: s.id,
      student_code: s.student_code,
      student_name: `${s.prefix || ''}${s.student_name}`,
      status,
      attempt_id: attempt?.id ?? null,
      started_at: attempt?.started_at ?? null,
      submitted_at: attempt?.submitted_at ?? null,
      total_correct: attempt?.total_correct ?? null,
      total_questions: attempt?.total_questions ?? null,
      score: attempt?.score ?? null,
      violation_count: attempt?.violation_count ?? 0,
      locked: attempt?.locked ?? false,
    };
  });

  return {
    id: round.id,
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

/** [startOfDayISO, startOfNextDayISO) for a 'YYYY-MM-DD' date, fixed at the school's Asia/Bangkok offset (+07:00, no DST). */
function bangkokDayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Every รอบสอบ opening on a given date for a given ชั้น/ห้อง, with each
 * round's live monitor data — for a teacher assigned to proctor a physical
 * room rather than one specific exam. Plain RLS (owner-or-admin) scopes
 * which rounds a caller can see here — see the note at the top of this
 * file: a non-owning assigned proctor doesn't currently get anything
 * beyond that, since the RLS grant for that case caused recursion and was
 * reverted. This just asks for "all rounds in this room on this day" and
 * lets the database answer with only what the caller is authorized to
 * read.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ date: string, gradeLevel: string, room: string }} args
 */
export async function getRoomMonitor(supabase, { date, gradeLevel, room }) {
  const { start, end } = bangkokDayRange(date);
  const { data: rounds, error } = await supabase
    .from('online_exam_rounds')
    .select(`
      id, opens_at,
      online_exam_sets!inner ( subjects!inner ( grade_level, room ) )
    `)
    .eq('online_exam_sets.subjects.grade_level', gradeLevel)
    .eq('online_exam_sets.subjects.room', room)
    .gte('opens_at', start)
    .lt('opens_at', end)
    .order('opens_at', { ascending: true });
  if (error) throw error;

  return Promise.all((rounds || []).map(r => getRoundMonitor(supabase, r.id)));
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
  const { data, error } = await supabase
    .from('online_exam_proctor_assignments')
    .select('id, assign_date, grade_level, room, teacher_id, profiles ( full_name )')
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
 * @param {{ examSetId: string, subjectId: string, title: string, questions: Array<{ correct_choice: number, num_choices: number }>, existingQuizId?: string|null }} args
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
    answerKey[i] = { choices: [q.correct_choice], points: 1 };
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
