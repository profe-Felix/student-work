// src/lib/queries.ts
import { supabase } from './supabaseClient';

/**
 * List assignments, newest first.
 * If the column `is_archived` exists, filter to is_archived=false.
 * If it doesn't exist (fresh DB), we gracefully fall back without the filter.
 */
export async function listAssignments() {
  // Try with is_archived filter first
  let q = supabase
    .from('assignments')
    .select('id,title,created_at,is_archived')
    .eq('is_archived', false)
    .order('created_at', { ascending: false });

  let res = await q;
  // If the column doesn't exist yet, retry without it
  if (res.error && String(res.error.message || '').toLowerCase().includes('column') && String(res.error.message || '').toLowerCase().includes('is_archived')) {
    res = await supabase
      .from('assignments')
      .select('id,title,created_at')
      .order('created_at', { ascending: false });
  }
  if (res.error) throw res.error;
  return res;
}

/**
 * List pages for an assignment, ordered by page_index ascending (first page first).
 */
export async function listPages(assignmentId: string) {
  return supabase
    .from('pages')
    .select('id,title,assignment_id,page_index,pdf_path')
    .eq('assignment_id', assignmentId)
    .order('page_index', { ascending: true });
}

/**
 * For a given page, return the latest submission per student.
 * (We pull all for the page ordered by created_at desc, then collapse in-memory.)
 */
export async function listLatestSubmissionsByPage(pageId: string) {
  const { data, error } = await supabase
    .from('submissions')
    .select('id, student_id, created_at, feedback_rating, feedback_note')
    .eq('page_id', pageId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  // collapse to latest per student
  const seen = new Set<string>();
  const latest: typeof data = [];
  for (const row of data ?? []) {
    if (!seen.has(row.student_id)) {
      seen.add(row.student_id);
      latest.push(row);
    }
  }
  return latest;
}

/**
 * Get the newest thumbnail artifact for a submission (if any).
 */
export async function getThumbnailForSubmission(submissionId: string) {
  const { data, error } = await supabase
    .from('artifacts')
    .select('storage_path')
    .eq('submission_id', submissionId)
    .eq('kind', 'thumbnail')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // PGRST116 = no rows
  // @ts-ignore
  if (error && error.code !== 'PGRST116') throw error;
  return data?.storage_path ?? null;
}

/**
 * Helper for student page: fetch the latest assignment (by created_at desc)
 * and its first page (lowest page_index). If none exist, returns nulls.
 */
export async function fetchLatestAssignmentWithFirstPage() {
  // 1) latest assignment
  const aRes = await listAssignments();
  const assignments = aRes.data ?? [];
  const assignment = assignments[0] ?? null;
  if (!assignment) return { assignment: null as null, page: null as null };

  // 2) first page by page_index
  const { data: pages, error: pErr } = await supabase
    .from('pages')
    .select('id,title,assignment_id,page_index,pdf_path')
    .eq('assignment_id', assignment.id)
    .order('page_index', { ascending: true })
    .limit(1);
  if (pErr) throw pErr;

  const page = (pages && pages[0]) || null;
  return { assignment, page };
}
