// public-stats.js
//
// Site-wide counters shown on the (unauthenticated) login screen — total
// bank questions across every teacher, total OMR answer sheets scanned.
// bank_questions/omr_scan_results are both RLS-scoped to the owning
// teacher (or admin), so this goes through the get_public_stats()
// SECURITY DEFINER RPC (anon-callable) rather than querying the tables
// directly, which would return zero rows for a logged-out visitor.

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<{ bankQuestionsCount: number, omrScanResultsCount: number }>}
 */
export async function getPublicStats(supabase) {
  const { data, error } = await supabase.rpc('get_public_stats');
  if (error) throw error;
  return {
    bankQuestionsCount: data.bank_questions_count,
    omrScanResultsCount: data.omr_scan_results_count,
  };
}
