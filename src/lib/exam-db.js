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
// round, not itself an access gate — is_assigned_proctor() (see the
// add_proctor_monitor_read_access migration) grants a matching assignment
// read access to *every* round in that room/date regardless of type, since
// a room's proctor needs to see everything happening in their room that
// day. The owning teacher's own access is unaffected either way — it's the
// pre-existing subjects.user_id-based policy, untouched by any of this.

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
      id, subject_id, title,
      online_exam_set_questions ( seq, bank_question_id, bank_questions ( id, question_text, difficulty, num_choices, source ) )
    `)
    .eq('id', id)
    .single();
  if (error) throw error;
  const questions = (data.online_exam_set_questions || [])
    .sort((a, b) => a.seq - b.seq)
    .map(x => x.bank_questions)
    .filter(Boolean);
  return { id: data.id, subject_id: data.subject_id, title: data.title, questions };
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
// นอกตาราง/ad-hoc) or by ชั้น/ห้อง + date (a teacher assigned by the admin
// to proctor a room, watching every online exam happening there that day
// regardless of which teacher set it up). Read access for both is enforced
// server-side by RLS: the round/set/attempt owner, any admin, or a teacher
// with a matching online_exam_proctor_assignments row for that round's
// grade/room/date (see is_assigned_proctor() — migration
// add_proctor_monitor_read_access). Realtime subscriptions on
// online_exam_attempts respect the same RLS, so a live channel only ever
// delivers rows the viewer is already allowed to read.

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
 * room rather than one specific exam. RLS (is_assigned_proctor) is what
 * actually scopes which rounds a non-owning caller can see here; this just
 * asks for "all rounds in this room on this day" and lets the database
 * answer with only what the caller is authorized to read.
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
