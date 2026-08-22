// omr-db.js
//
// getItemAnalysisForQuiz (bottom of this file) is the one function here
// with a top-level import — it hands scored responses to the shared
// analyzeItems() in item-analysis.js rather than duplicating the
// difficulty/discrimination/KR-20 math.
//
// Supabase data-access helpers for the OMR feature, matching the schema
// created in the PP5 project:
//
//   omr_quizzes       (id, subject_id, title, num_questions, num_choices,
//                       id_digits, choice_scheme, created_by, created_at)
//   omr_answer_keys   (id, quiz_id, question_number, correct_choices int[],
//                       points numeric) — correct_choices holds every
//                       choice index accepted as correct for that question
//                       (a student matching any one of them earns `points`
//                       for the question, not the sum of all of them)
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

import { analyzeItems } from './item-analysis';

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
 *   paperLayout: 'topBottom'|'halfLandscape',
 *   cols?: number|null, // forced column count the sheet was printed with, if any
 *   answerKey: Record<number, { choices: number[], points: number }>, // { [questionIndex0based]: {...} }
 * }} params
 * @returns {Promise<{ quizId: string }>}
 */
export async function createQuiz(supabase, params) {
  const { subjectId, title, numQuestions, numChoices, idDigits, choiceScheme, paperLayout, cols, answerKey } = params;

  const { data: quiz, error: quizErr } = await supabase
    .from('omr_quizzes')
    .insert({
      subject_id: subjectId,
      title,
      num_questions: numQuestions,
      num_choices: numChoices,
      id_digits: idDigits,
      choice_scheme: choiceScheme,
      paper_layout: paperLayout,
      cols: cols || null,
    })
    .select('id')
    .single();

  if (quizErr) throw quizErr;

  const keyRows = Object.entries(answerKey).map(([qIndex, entry]) => ({
    quiz_id: quiz.id,
    question_number: Number(qIndex) + 1, // stored 1-based; UI/omr-core uses 0-based
    correct_choices: entry.choices,
    points: entry.points,
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
    .select('id, subject_id, title, num_questions, num_choices, id_digits, choice_scheme, paper_layout, cols, created_at')
    .eq('id', quizId)
    .single();
  if (quizErr) throw quizErr;

  const { data: keyRows, error: keyErr } = await supabase
    .from('omr_answer_keys')
    .select('question_number, correct_choices, points')
    .eq('quiz_id', quizId)
    .order('question_number', { ascending: true });
  if (keyErr) throw keyErr;

  const answerKey = {};
  for (const row of keyRows) {
    answerKey[row.question_number - 1] = { choices: row.correct_choices, points: Number(row.points) }; // back to 0-based
  }

  return {
    id: quiz.id,
    subjectId: quiz.subject_id,
    title: quiz.title,
    numQuestions: quiz.num_questions,
    numChoices: quiz.num_choices,
    idDigits: quiz.id_digits,
    choiceScheme: quiz.choice_scheme,
    paperLayout: quiz.paper_layout,
    cols: quiz.cols,
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
 * List every quiz across all of the teacher's subjects, most recent first,
 * each with its subject's name/grade/room attached — for a scanning UI
 * where the teacher picks a previously-prepared quiz directly, without
 * choosing a subject first. Explicitly filtered to subjects.user_id, not
 * left to RLS alone: omr_quizzes' RLS also carries an admin_all_omr_quizzes
 * policy (any is_admin() session can read every row) so an admin account
 * would otherwise see every teacher's quizzes here too, when this "my
 * quizzes" list is meant to mean literally the caller's own — the
 * everyone's-quizzes view is listAllQuizzes, for the dedicated admin
 * settings panel.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listMyQuizzes(supabase) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('omr_quizzes')
    .select(`
      id, subject_id, title, num_questions, num_choices, id_digits, choice_scheme, created_at,
      subjects!inner ( subject_name, subject_code, grade_level, room )
    `)
    .eq('subjects.user_id', user?.id ?? '')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * List every quiz across every teacher — for the admin-only "quiz sets"
 * management panel. Ordinary teachers only see their own rows here too
 * (RLS still applies), but an admin session sees everyone's via the
 * admin_all_omr_quizzes policy. Ownership is derived through
 * subjects.user_id (what RLS itself keys on, and reliably set), not
 * omr_quizzes.created_by (never actually set on insert) — and since
 * subjects.user_id has no FK to profiles for PostgREST to auto-embed
 * (it points at auth.users), the teacher's name is looked up in a
 * separate query and merged in here rather than nested in the select.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listAllQuizzes(supabase) {
  const { data, error } = await supabase
    .from('omr_quizzes')
    .select(`
      id, title, num_questions, num_choices, created_at,
      subjects ( subject_name, grade_level, room, user_id )
    `)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const userIds = [...new Set((data || []).map(q => q.subjects?.user_id).filter(Boolean))];
  let nameByUserId = {};
  if (userIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', userIds);
    nameByUserId = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));
  }
  return (data || []).map(q => ({ ...q, teacherName: nameByUserId[q.subjects?.user_id] || null }));
}

// Storage bucket for kept scan photos. Private (not the `public` bucket
// pattern used elsewhere in this project) since answer sheets can carry
// student names/handwriting. Objects are pathed `{teacherUid}/...` and RLS
// (see migration add_omr_scan_photo_storage) only lets the owning teacher
// or an admin read/write/delete under their own prefix.
const SCAN_PHOTO_BUCKET = 'omr-scan-photos';

// The teacher's "keep scan photos" preference itself lives on
// profiles.save_scan_photos and is read/written via AuthContext
// (src/lib/AuthContext.jsx's saveScanPhotos/setSaveScanPhotos), not here —
// the scan tool already holds a Supabase session via that context, so it
// doesn't need a separate OMR-specific accessor for one profile column.

/**
 * Upload a graded-overlay photo (a PNG Blob/File, e.g. from
 * canvas.toBlob) for one scan result and return its storage path.
 * Does not touch the omr_scan_results row — pass the returned path to
 * saveScanResult's `photoPath` param.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{ userId: string, quizId: string, blob: Blob }} params
 * @returns {Promise<{ path: string }>}
 */
export async function uploadScanPhoto(supabase, { userId, quizId, blob }) {
  const path = `${userId}/${quizId}/${crypto.randomUUID()}.png`;
  const { error } = await supabase.storage
    .from(SCAN_PHOTO_BUCKET)
    .upload(path, blob, { contentType: 'image/png' });
  if (error) throw error;
  return { path };
}

/**
 * Get a temporary signed URL to view a kept scan photo (the bucket is
 * private, so a plain public URL won't work).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} path
 * @param {number} [expiresIn] seconds, default 1 hour
 */
export async function getScanPhotoUrl(supabase, path, expiresIn = 3600) {
  const { data, error } = await supabase.storage
    .from(SCAN_PHOTO_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error) throw error;
  return data.signedUrl;
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
 *   scannedBy?: string,
 *   photoPath?: string|null,
 * }} params
 */
export async function saveScanResult(supabase, params) {
  const { quizId, studentId, responses, totalCorrect, score, scannedBy, photoPath } = params;
  const { data, error } = await supabase
    .from('omr_scan_results')
    .insert({
      quiz_id: quizId,
      student_id: studentId,
      responses,
      total_correct: totalCorrect,
      score,
      scanned_by: scannedBy || null,
      photo_path: photoPath || null,
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
      id, total_correct, score, scanned_at, photo_path, responses,
      students ( id, student_code, student_name, prefix, room )
    `)
    .eq('quiz_id', quizId)
    .order('scanned_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * List this teacher's most recent scans across every quiz, newest first —
 * for the dashboard's "recent activity" panel. Explicitly filtered to
 * subjects.user_id, not left to RLS alone: omr_scan_results' RLS also
 * carries an admin_all_omr_scan_results policy (any is_admin() session can
 * read every row) so an admin account would otherwise see every teacher's
 * scans here too, when this "my activity" list is meant to mean literally
 * the caller's own — the everyone's-photos view is listAllScanPhotos, for
 * the dedicated admin settings panel.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {number} [limit]
 */
export async function listMyRecentScanActivity(supabase, limit = 5) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('omr_scan_results')
    .select(`
      id, score, scanned_at,
      students ( student_code, student_name, prefix ),
      omr_quizzes!inner ( id, title, subjects!inner ( subject_name, grade_level, room, user_id ) )
    `)
    .eq('omr_quizzes.subjects.user_id', user?.id ?? '')
    .order('scanned_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

/**
 * Aggregate stats over every one of this teacher's scan results, for the
 * dashboard's stat cards — how many sheets have been graded in total, the
 * average score across them, and which quizzes have at least one scan (so
 * the dashboard can flag prepared quizzes nobody's scanned yet). One query
 * instead of several separate counts, since it needs every row's quiz_id
 * and score anyway. Same explicit subjects.user_id filtering as
 * listMyRecentScanActivity, for the same reason (an admin session must not
 * see every teacher's totals folded into their own here).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function getMyScanStats(supabase) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('omr_scan_results')
    .select('quiz_id, score, omr_quizzes!inner(subjects!inner(user_id))')
    .eq('omr_quizzes.subjects.user_id', user?.id ?? '');
  if (error) throw error;
  const rows = data || [];
  const scores = rows.map(r => Number(r.score) || 0);
  return {
    totalScanned: rows.length,
    avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    scannedQuizIds: new Set(rows.map(r => r.quiz_id)),
  };
}

/**
 * List every kept scan photo across every teacher — for the admin-only
 * "stored scan photos" panel. Ordinary teachers only see their own rows
 * here too (RLS still applies), but an admin session sees everyone's via
 * the admin_all_omr_scan_results policy.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export async function listAllScanPhotos(supabase) {
  const { data, error } = await supabase
    .from('omr_scan_results')
    .select(`
      id, photo_path, total_correct, score, scanned_at,
      students ( student_code, student_name, prefix ),
      omr_quizzes ( title, subjects ( subject_name, grade_level, room ) ),
      profiles ( full_name )
    `)
    .not('photo_path', 'is', null)
    .order('scanned_at', { ascending: false });
  if (error) throw error;
  return data;
}

/**
 * Delete a scan result (e.g. to re-scan a misread sheet). Also removes its
 * stored photo from the bucket, if any.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} resultId
 * @param {string} [photoPath]
 */
export async function deleteScanResult(supabase, resultId, photoPath) {
  if (photoPath) {
    await supabase.storage.from(SCAN_PHOTO_BUCKET).remove([photoPath]);
  }
  const { error } = await supabase.from('omr_scan_results').delete().eq('id', resultId);
  if (error) throw error;
}

/**
 * Delete a quiz entirely — its answer key and every scan result cascade
 * automatically (omr_answer_keys/omr_scan_results both have ON DELETE
 * CASCADE to omr_quizzes at the DB level). Any kept scan photos are
 * removed from storage first, since CASCADE only cleans up DB rows, not
 * storage objects — leaving those behind would silently accumulate.
 * A teacher can delete their own quizzes and an admin can delete anyone's
 * (both already covered by the existing RLS policies on these tables).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} quizId
 */
export async function deleteQuiz(supabase, quizId) {
  const { data: results, error: fetchErr } = await supabase
    .from('omr_scan_results')
    .select('photo_path')
    .eq('quiz_id', quizId)
    .not('photo_path', 'is', null);
  if (fetchErr) throw fetchErr;
  const photoPaths = (results || []).map(r => r.photo_path).filter(Boolean);
  if (photoPaths.length > 0) {
    await supabase.storage.from(SCAN_PHOTO_BUCKET).remove(photoPaths);
  }
  const { error } = await supabase.from('omr_quizzes').delete().eq('id', quizId);
  if (error) throw error;
}

/**
 * Delete just the stored photo for a scan result, keeping the grading data
 * intact. Used by the admin "stored scan photos" panel.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} resultId
 * @param {string} photoPath
 */
export async function deleteScanPhoto(supabase, resultId, photoPath) {
  const { error: storageErr } = await supabase.storage.from(SCAN_PHOTO_BUCKET).remove([photoPath]);
  if (storageErr) throw storageErr;
  const { error } = await supabase.from('omr_scan_results').update({ photo_path: null }).eq('id', resultId);
  if (error) throw error;
}

/**
 * Classroom item-analysis (ค่าความยาก/อำนาจจำแนก/KR-20) for a quiz's
 * scanned results — one row per question_number, built by matching each
 * scan's responses against omr_answer_keys.correct_choices (a response
 * counts as correct if its choice is any one of a question's accepted
 * answers — same rule scoring itself already uses; blank/ambiguous marks
 * always count as incorrect).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} quizId
 */
export async function getItemAnalysisForQuiz(supabase, quizId) {
  const { data: quiz, error: quizErr } = await supabase
    .from('omr_quizzes')
    .select('num_questions')
    .eq('id', quizId)
    .single();
  if (quizErr) throw quizErr;

  const { data: keyRows, error: keyErr } = await supabase
    .from('omr_answer_keys')
    .select('question_number, correct_choices')
    .eq('quiz_id', quizId);
  if (keyErr) throw keyErr;
  // question_number is stored 1-based in this column, but a scan result's
  // responses[].question is 0-based (the omr-core/UI convention — see
  // OMRReportTool's own qIndex-vs-resp.question comparison) — reindex the
  // key to 0-based here so both sides line up on the same axis below.
  const correctByIndex = new Map((keyRows || []).map(k => [k.question_number - 1, new Set(k.correct_choices || [])]));

  const { data: results, error: resErr } = await supabase
    .from('omr_scan_results')
    .select('student_id, scanned_at, responses')
    .eq('quiz_id', quizId);
  if (resErr) throw resErr;

  // A rescan (OMRScanTool's "สแกนซ้ำ") inserts a new row rather than
  // overwriting the old one (see saveScanResult/listScanResultsForQuiz's
  // own comment), so a student scanned twice would otherwise be counted as
  // two different students here — silently skewing p/r/KR-20. Keep only
  // each student's most recent scan, matching what the report/roster
  // views already show as "the" result for that student.
  const latestByStudent = new Map();
  for (const result of results || []) {
    if (!result.student_id) continue;
    const existing = latestByStudent.get(result.student_id);
    if (!existing || new Date(result.scanned_at) > new Date(existing.scanned_at)) {
      latestByStudent.set(result.student_id, result);
    }
  }

  const numItems = quiz.num_questions;
  const itemMatrix = Array.from({ length: numItems }, () => []);

  for (const result of latestByStudent.values()) {
    const byIndex = new Map((result.responses || []).map(r => [r.question, r]));
    for (let qi = 0; qi < numItems; qi++) {
      const resp = byIndex.get(qi);
      const correctSet = correctByIndex.get(qi);
      const correct = resp && !resp.blank && !resp.ambiguous && correctSet?.has(resp.choice) ? 1 : 0;
      itemMatrix[qi].push(correct);
    }
  }

  const questionNumbers = Array.from({ length: numItems }, (_, i) => i + 1);

  return { questionNumbers, ...analyzeItems(itemMatrix) };
}
