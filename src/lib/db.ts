// src/lib/db.ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!
)

// ---------- helpers ----------
type IdRow = { id: string }
type AssignmentRow = { id: string; title: string }
type PageRow = { id: string; assignment_id: string; page_index: number }
type SubmissionRow = { id: string; assignment_id: string; page_id: string; student_id: string; created_at: string }
type ArtifactRow = {
  id: string; submission_id: string | null; page_id: string | null;
  kind: 'strokes' | 'audio'; strokes_json?: any; audio_url?: string | null; created_at: string
}

// ---------- assignments ----------
export async function upsertAssignmentWithPage(title: string, _pdfPath: string, pageIndex: number) {
  // hotfix: do NOT send pdf_path (db may not have that column)
  const { data: aRows, error: aErr } = await supabase
    .from('assignments')
    .upsert({ title }, { onConflict: 'title' })
    .select('id')
    .single()

  if (aErr) throw aErr
  const assignment_id = aRows!.id as string

  const { data: pRows, error: pErr } = await supabase
    .from('pages')
    .upsert({ assignment_id, page_index: pageIndex }, { onConflict: 'assignment_id,page_index' })
    .select('id')
    .single()

  if (pErr) throw pErr
  const page_id = pRows!.id as string

  return { assignment_id, page_id }
}

// For the teacher dropdown
export async function listAssignments(): Promise<AssignmentRow[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id,title')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as AssignmentRow[]
}

// ---------- submissions/artifacts ----------
export async function createSubmission(student_id: string, assignment_id: string, page_id: string): Promise<string> {
  const { data, error } = await supabase
    .from('submissions')
    .insert({ student_id, assignment_id, page_id })
    .select('id')
    .single()
  if (error) throw error
  return data!.id as string
}

export async function saveStrokes(submission_id: string, strokes_json: any) {
  const { error } = await supabase
    .from('artifacts')
    .insert({ submission_id, page_id: null, kind: 'strokes', strokes_json })
  if (error) throw error
}

export async function saveAudio(submission_id: string, audioBlob: Blob) {
  // Store audio blob to storage (optional in your build) — simple placeholder:
  const fileName = `${submission_id}-${Date.now()}.webm`
  const { data: up, error: upErr } = await supabase.storage.from('audio').upload(fileName, audioBlob, { upsert: true })
  if (upErr) throw upErr
  const { error: artErr } = await supabase
    .from('artifacts')
    .insert({ submission_id, page_id: null, kind: 'audio', audio_url: up.path })
  if (artErr) throw artErr
}

export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
  // latest submission id for this student/page
  const { data: sub, error: sErr } = await supabase
    .from('submissions')
    .select('id, created_at')
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .eq('student_id', student_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sErr) throw sErr
  if (!sub) return null

  const { data: arts, error: aErr } = await supabase
    .from('artifacts')
    .select('id,kind,strokes_json,audio_url,created_at')
    .eq('submission_id', sub.id)
    .order('created_at', { ascending: true })

  if (aErr) throw aErr
  return { submission_id: sub.id, created_at: sub.created_at, artifacts: (arts || []) as ArtifactRow[] }
}
