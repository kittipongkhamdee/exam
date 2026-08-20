// config-db.js
//
// Thin wrapper around public.config — a shared key/value settings table,
// not specific to this app: the ปพ.5 system (same Supabase project)
// already stores its Gemini/Typhoon API keys here from its own settings
// page. RLS on config allows any authenticated session to read/write any
// key, so this app's own admin-gated Settings page is the only access
// control on the write side — same trust model the existing ปพ.5 panel
// already relies on.

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 */
export async function getConfigValue(supabase, key) {
  const { data, error } = await supabase.from('config').select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  return data?.value ?? '';
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} key
 * @param {string} value
 */
export async function setConfigValue(supabase, key, value) {
  const { error } = await supabase.from('config').upsert({ key, value });
  if (error) throw error;
}
