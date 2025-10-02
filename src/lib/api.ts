// src/lib/api.ts
import { supabase } from './supabaseClient'

export type Assignment = { id: string; title: string; created_at?: string; is_archived?: boolean }
export type Page = { id: string; assignment_id: string; page_index: number; title?: string | null; pdf_path: string | null }
export type Submission = { id: string; student_id: string; assignment_id: string; page_id: string; created_at: string }
export type ArtifactKind = 'strokes' | 'audio' | 'thumbnail' | 'draft-strokes' | 'draft-audio'
export type Artifact = { id: string; submission_id: string; kind: ArtifactKind; storage_path?: string | null; strokes_json?: any; created_at: string }

export async function listAssignments(opts?: { includeArchived?: boolean }): Promise<Assignment[]> {
  const q = supabase.from('assignments').select('*')
  if (!opts?.includeArchived) q.eq('is_archived', false)
  const { data, error } = await q
  if (error) throw error
  return (data || []) as Assignment[]
}

export async function listPages(assignmentId: string): Promise<Page[]> {
  const { data, error } = await supabase
    .from('pages')
    .select('*')
    .eq('assignment_id', assignmentId)
    .order('page_index', { ascending: true })
  if (error) throw error
  return (data || []) as Page[]
}

export async function ensureSubmission(studentId: string, assignmentId: string, pageId: string): Promise<Submission> {
  const { data: existing, error: exErr } = await supabase
    .from('submissions')
    .select('*')
    .eq('student_id', studentId).eq('assignment_id', assignmentId).eq('page_id', pageId)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (exErr) throw exErr
  if (existing) return existing as Submission
  const { data, error } = await supabase
    .from('submissions')
    .insert([{ student_id: studentId, assignment_id: assignmentId, page_id: pageId }])
    .select('*').single()
  if (error) throw error
  return data as Submission
}

export async function latestArtifacts(submissionId: string, kinds: ArtifactKind[]): Promise<Record<ArtifactKind, Artifact | null>> {
  const { data, error } = await supabase
    .from('artifacts')
    .select('*')
    .eq('submission_id', submissionId)
    .in('kind', kinds)
    .order('created_at', { ascending: false })
  if (error) throw error
  const map: Record<ArtifactKind, Artifact | null> = { 'strokes': null, 'audio': null, 'thumbnail': null, 'draft-strokes': null, 'draft-audio': null }
  for (const a of (data as Artifact[] || [])) if (!map[a.kind]) map[a.kind] = a
  return map
}

export async function addArtifact(row: Partial<Artifact>): Promise<Artifact> {
  const { data, error } = await supabase.from('artifacts').insert([row]).select('*').single()
  if (error) throw error
  return data as Artifact
}
