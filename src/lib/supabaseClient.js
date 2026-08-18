import { createClient } from '@supabase/supabase-js';

// Fall back to the PP5 project's public URL + publishable (anon) key — safe
// to ship in client code, matching .env.example — so the app still works
// out of the box on a host where NEXT_PUBLIC_SUPABASE_* wasn't configured.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zwtulepvmlngcrbcrrki.supabase.co';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'sb_publishable_XSAOmXfp00l6Lh0xLwXERQ_4UEgkWhS';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
