// exam-db.js
//
// Supabase data-access helpers for the online-exam feature's teacher-side
// tables:
//
//   online_exam_sets           (id, subject_id, title, created_by, created_at)
//   online_exam_set_questions  (id, exam_set_id, bank_question_id, seq)
//   online_exam_rounds         (id, exam_set_id, pin, opens_at, closes_at,
//                                duration_minutes, created_by, created_at)
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
// teacher's own scoping — one PIN per round, not per student).
//
// RLS on all three follows the same owner-or-admin pattern as
// bank_questions/omr_quizzes: the owning teacher (subjects.user_id =
// auth.uid(), reached via subject_id or via exam_set_id -> subject_id) can
// manage their own rows, admins (is_admin()) can manage everything. The
// list functions below still add an explicit subjects.user_id filter on
// top of RLS — same reasoning as bank-db.js's listMyBankQuestions: an admin
// session must not see every teacher's data in what's meant to be "my own"
// here.

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
      id, exam_set_id, pin, opens_at, closes_at, duration_minutes, created_at,
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
 * @param {{ id?: string, examSetId: string, pin: string, opensAt: string, closesAt: string, durationMinutes: number }} args
 */
export async function saveExamRound(supabase, { id, examSetId, pin, opensAt, closesAt, durationMinutes }) {
  const { data: { user } } = await supabase.auth.getUser();
  const row = {
    exam_set_id: examSetId,
    pin,
    opens_at: opensAt,
    closes_at: closesAt,
    duration_minutes: durationMinutes,
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
