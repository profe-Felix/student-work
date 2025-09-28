// src/lib/supabaseHelpers.ts
import { supabase } from './supabaseClient';

export function publicUrl(path: string) {
  const { data } = supabase.storage.from('public').getPublicUrl(path);
  return data.publicUrl;
}
