// bank-db.js
//
// Supabase data-access helpers for the AI-assisted question bank feature:
//
//   bank_questions  (id, subject_id, indicator_id, difficulty, num_choices,
//                     question_text, choices jsonb, correct_choice,
//                     explanation, source, created_by, created_at)
//
// RLS on bank_questions follows the same pattern as omr_quizzes: the owning
// teacher (subjects.user_id = auth.uid()) can manage their own rows, admins
// (is_admin()) can manage everything. listMyBankQuestions still adds an
// explicit subjects.user_id filter on top of RLS — same reasoning as
// omr-db.js's listMyQuizzes: an admin session must not see every teacher's
// bank in what's meant to be "my own" here.
//
// indicators is a separate, pre-populated reference table (the national
// core curriculum's ตัวชี้วัดระหว่างทาง/ปลายทาง) keyed by subject_group +
// grade_level (text, e.g. "วิทยาศาสตร์และเทคโนโลยี" / "ม.1"), not by
// subject_id — a subject's matching indicators are looked up by that text
// pair rather than a foreign key, since the same indicator applies to every
// teacher's "ม.1" subject in that learning area.

/**
 * List every subject the caller teaches, for the bank's subject picker.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listMySubjects(supabase) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('subjects')
    .select('id, subject_name, subject_code, subject_group, subject_type, grade_level, room')
    .eq('user_id', user?.id ?? '')
    .order('grade_level', { ascending: true })
    .order('room', { ascending: true });
  if (error) throw error;
  return data;
}

// indicators.grade_level is text like "ม.1".."ม.6", plus a combined
// "ม.4-6" for subjects taught across all three upper-secondary years.
function indicatorGradeLevels(subjectGradeLevel) {
  const levels = [`ม.${subjectGradeLevel}`];
  if (['4', '5', '6'].includes(String(subjectGradeLevel))) levels.push('ม.4-6');
  return levels;
}

/**
 * List the core-curriculum indicators matching a subject's learning area
 * and grade level, for the "เลือกตัวชี้วัด" step of AI question generation.
 * Only covers รายวิชาพื้นฐาน (core subjects) — the reference table has no
 * rows for วิชาเพิ่มเติม (electives), so this returns empty for those and
 * the generation flow falls back to a free-text topic instead.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ subject_group: string, grade_level: string }} subject
 */
export async function listIndicatorsForSubject(supabase, subject) {
  const { data, error } = await supabase
    .from('indicators')
    .select('id, standard_code, indicator_code, indicator_text, kind')
    .eq('subject_group', subject.subject_group)
    .in('grade_level', indicatorGradeLevels(subject.grade_level))
    .order('indicator_code', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * List this teacher's saved bank questions, newest first, each with its
 * subject and (if any) source indicator attached.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ subjectId?: string }} [opts]
 */
export async function listMyBankQuestions(supabase, opts = {}) {
  const { data: { user } } = await supabase.auth.getUser();
  let query = supabase
    .from('bank_questions')
    .select(`
      id, subject_id, indicator_id, difficulty, num_choices, question_text, choices, correct_choice, explanation, source, created_at,
      subjects!inner ( subject_name, subject_code, grade_level, room, user_id ),
      indicators ( indicator_code, indicator_text )
    `)
    .eq('subjects.user_id', user?.id ?? '')
    .order('created_at', { ascending: false });
  if (opts.subjectId) query = query.eq('subject_id', opts.subjectId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Save a batch of drafted questions (AI-generated or hand-written) into the
 * bank. Each item carries its own subject_id/indicator_id since a single
 * generation run can span more than one selected indicator.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Array<{
 *   subject_id: string, indicator_id?: number|null, difficulty: string,
 *   question_text: string, choices: string[], correct_choice: number,
 *   explanation?: string, source?: 'ai'|'manual',
 * }>} questions
 */
export async function saveBankQuestions(supabase, questions) {
  const { data: { user } } = await supabase.auth.getUser();
  const rows = questions.map(q => ({
    subject_id: q.subject_id,
    indicator_id: q.indicator_id || null,
    difficulty: q.difficulty,
    num_choices: q.choices.length,
    question_text: q.question_text,
    choices: q.choices,
    correct_choice: q.correct_choice,
    explanation: q.explanation || '',
    source: q.source || 'ai',
    created_by: user.id,
  }));
  const { error } = await supabase.from('bank_questions').insert(rows);
  if (error) throw error;
}

/**
 * Delete one bank question.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} id
 */
export async function deleteBankQuestion(supabase, id) {
  const { error } = await supabase.from('bank_questions').delete().eq('id', id);
  if (error) throw error;
}
