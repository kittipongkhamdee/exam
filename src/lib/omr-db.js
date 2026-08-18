// omr-db.js
//
// Supabase data-access helpers for the OMR feature, matching the schema
// created in the PP5 project:
//
//   omr_quizzes       (id, subject_id, title, num_questions, num_choices,
//                       id_digits, choice_scheme, created_by, created_at)
//   omr_answer_keys   (id, quiz_id, question_number, correct_choice)
//   omr_scan_results  (id, quiz_id, student_id, responses jsonb,
//                       total_correct, score, scanned_by, scanned_at)
//
// RLS on all three tables follows the same pattern already used by
// subjects/score_units: the owning teacher (subjects.user_id = auth.uid())
// can manage their own quizzes, admins (is_admin()) can manage everything.
// That means these functions rely on the caller already being
// authenticated via the same Supabase client/session used elsewhere in the
// app — there's no separate auth handling here.
//
// Usage: pass your existing Supabase client (from `@supabase/supabase-js`,
// created with your project URL + anon key) into each function. This file
// does not create its own client, so it fits into a project that already
// has one (e.g. a `lib/supabaseClient.js`).

/**
 * Create a new quiz and its answer key in one call.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   subjectId: string,
 *   title: string,
 *   numQuestions: number,
 *   numChoices: number,
 *   idDigits: number,
 *   choiceScheme: 'thai'|'en'|'num',
 *   answerKey: Record<number, number>, // { [questionIndex0based]: choiceIndex0based }
 * }} params
 * @returns {Promise<{ quizId: string }>}
 */
export async function createQuiz(supabase, params) {
  const { subjectId, title, numQuestions, numChoices, idDigits, choiceScheme, answerKey } = params;

  const { data: quiz, error: quizErr } = await supabase
    .from('omr_quizzes')
    .insert({
      subject_id: subjectId,
      title,
      num_questions: numQuestions,
      num_choices: numChoices,
      id_digits: idDigits,
      choice_scheme: choiceScheme,
    })
    .select('id')
    .single();

  if (quizErr) throw quizErr;

  const keyRows = Object.entries(answerKey).map(([qIndex, choiceIndex]) => ({
    quiz_id: quiz.id,
    question_number: Number(qIndex) + 1, // stored 1-based; UI/omr-core uses 0-based
    correct_choice: choiceIndex,
  }));

  if (keyRows.length > 0) {
    const { error: keyErr } = await supabase.from('omr_answer_keys').insert(keyRows);
    if (keyErr) throw keyErr;
  }

  return { quizId: quiz.id };
}

/**
 * Fetch a quiz plus its answer key, in the shape the OMR component expects
 * (0-based question/choice indices, answerKey as a plain object).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} quizId
 */
export async function getQuizWithAnswerKey(supabase, quizId) {
  const { data: quiz, error: quizErr } = await supabase
    .from('omr_quizzes')
    .select('id, subject_id, title, num_questions, num_choices, id_digits, choice_scheme, created_at')
    .eq('id', quizId)
    .single();
  if (quizErr) throw quizErr;

  const { data: keyRows, error: keyErr } = await supabase
    .from('omr_answer_keys')
    .select('question_number, correct_choice')
    .eq('quiz_id', quizId)
    .order('question_number', { ascending: true });
  if (keyErr) throw keyErr;

  const answerKey = {};
  for (const row of keyRows) {
    answerKey[row.question_number - 1] = row.correct_choice; // back to 0-based
  }

  return {
    id: quiz.id,
    subjectId: quiz.subject_id,
    title: quiz.title,
    numQuestions: quiz.num_questions,
    numChoices: quiz.num_choices,
    idDigits: quiz.id_digits,
    choiceScheme: quiz.choice_scheme,
    createdAt: quiz.created_at,
    answerKey,
  };
}

/**
 * List quizzes for a subject, most recent first.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} subjectId
 */
export async function listQuizzesForSubject(supabase, subjectId) {
  const { data, error } = await supabase
    .from('omr_quizzes')
    .select('id, title, num_questions, num_choices, created_at')
    .eq('subject_id', subjectId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Save a graded scan result for one student.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   quizId: string,
 *   studentId: string,
 *   responses: Array<{question:number, choice:number|null, ambiguous:boolean, blank:boolean}>,
 *   totalCorrect: number,
 *   score: number,
 * }} params
 */
export async function saveScanResult(supabase, params) {
  const { quizId, studentId, responses, totalCorrect, score } = params;
  const { data, error } = await supabase
    .from('omr_scan_results')
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      responses,
      total_correct: totalCorrect,
      score,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { resultId: data.id };
}

/**
 * Fetch all scan results for a quiz, joined with student names — the class
 * roster view (who's been scanned, their score).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} quizId
 */
export async function listScanResultsForQuiz(supabase, quizId) {
  const { data, error } = await supabase
    .from('omr_scan_results')
    .select(`
      id, total_correct, score, scanned_at,
      students ( id, student_code, student_name, prefix, room )
    `)
    .eq('quiz_id', quizId)
    .order('scanned_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Delete a scan result (e.g. to re-scan a misread sheet).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} resultId
 */
export async function deleteScanResult(supabase, resultId) {
  const { error } = await supabase.from('omr_scan_results').delete().eq('id', resultId);
  if (error) throw error;
}
