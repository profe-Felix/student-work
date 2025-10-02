// src/lib/supabaseClient.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL!;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY!;

if (!url || !anon) {
  console.error('Missing Supabase env: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
}

// Use a global singleton to avoid multiple GoTrueClient instances in the same browser context.
declare global {
  // eslint-disable-next-line no-var
  var __supabase__: SupabaseClient | undefined;
}

export const supabase: SupabaseClient =
  globalThis.__supabase__ ??
  (globalThis.__supabase__ = createClient(url, anon, {
    auth: {
      // set a unique storage key so other apps on the same domain don’t collide
      storageKey: 'student-work-auth',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  }));
