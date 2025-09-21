// src/lib/queries.ts (ensure these exist)
import { supabase } from '@/lib/supabaseClient';

export async function listAssignments() {
  return supabase.from('assignments').select('id,title').order('created_at');
}
export async function listPages(assignmentId: string) {
  return supabase.from('pages')
    .select('id,title,assignment_id,page_index,pdf_path')
    .eq('assignment_id', assignmentId)
    .order('page_index');
}
export async function listLatestSubmissionsByPage(pageId: string) {
  const { data, error } = await supabase
    .from('submissions')
    .select('id, student_id, created_at, feedback_rating, feedback_note')
    .eq('page_id', pageId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const seen = new Set<string>();
  const latest: typeof data = [];
  for (const row of data ?? []) { if (!seen.has(row.student_id)) { seen.add(row.student_id); latest.push(row); } }
  return latest;
}
export async function getThumbnailForSubmission(submissionId: string) {
  const { data, error } = await supabase
    .from('artifacts')
    .select('storage_path')
    .eq('submission_id', submissionId)
    .eq('kind', 'thumbnail')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && (error as any).code !== 'PGRST116') throw error;
  return data?.storage_path ?? null;
}
