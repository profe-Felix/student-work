// src/lib/db.ts
import { createClient } from '@supabase/supabase-js'

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL!
export const supabaseAnon = import.meta.env.VITE_SUPABASE_ANON_KEY!
export const supabase = createClient(supabaseUrl, supabaseAnon, {
  auth: { persistSession: false, autoRefreshToken: false }
})

// ---------- Types ----------
export type AssignmentRow = { id: string; title: string; pdf_path: string | null }
export type PageRow = { id: string; assignment_id: string; page_index: number }
export type SubmissionRow = { id: string; assignment_id: string; page_id: string; student_id: string; created_at: string }
export type ArtifactRow = {
  id: string
  submission_id: string
  page_id: string
  kind: 'strokes' | 'audio'
  strokes_json?: any
  storage_path?: string | null
  created_at: string
}

// ---------- Existing write helpers (keep yours here) ----------
export async function upsertAssignmentWithPage(title: string, pdfPath: string, pageIndex: number) {
  // upsert assignment
  const { data: a, error: ea } = await supabase
    .from('assignments')
    .upsert({ title, pdf_path: pdfPath }, { onConflict: 'title' })
    .select('id')
    .single()
  if (ea) throw ea

  // upsert page
  const { data: p, error: ep } = await supabase
    .from('pages')
    .upsert({ assignment_id: a.id, page_index: pageIndex }, { onConflict: 'assignment_id,page_index' })
    .select('id')
    .single()
  if (ep) throw ep

  return { assignment_id: a.id as string, page_id: p.id as string }
}

export async function createSubmission(student_id: string, assignment_id: string, page_id: string) {
  const { data, error } = await supabase
    .from('submissions')
    .insert({ student_id, assignment_id, page_id })
    .select('id')
    .single()
  if (error) throw error
  return data.id as string
}

export async function saveStrokes(submission_id: string, strokes: any) {
  const { error } = await supabase.from('artifacts').insert({
    submission_id,
    kind: 'strokes',
    strokes_json: strokes
  })
  if (error) throw error
}

export async function saveAudio(submission_id: string, blob: Blob) {
  // path: audio/<submission_id>/<timestamp>.webm
  const name = `${Date.now()}.webm`
  const path = `audio/${submission_id}/${name}`

  const { error: upErr } = await supabase.storage.from('audio').upload(path, blob, {
    contentType: 'audio/webm', upsert: false
  })
  if (upErr) throw upErr

  const { error: artErr } = await supabase.from('artifacts').insert({
    submission_id,
    kind: 'audio',
    storage_path: path
  })
  if (artErr) throw artErr
}

export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
  // latest submission for that (student, page)
  const { data: subs, error: es } = await supabase
    .from('submissions')
    .select('id, created_at')
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .eq('student_id', student_id)
    .order('created_at', { ascending: false })
    .limit(1)

  if (es) throw es
  const submission = subs?.[0]
  if (!submission) return null

  const { data: arts, error: ea } = await supabase
    .from('artifacts')
    .select('*')
    .eq('submission_id', submission.id)
    .order('created_at', { ascending: false })

  if (ea) throw ea
  return { submission, artifacts: arts || [] as ArtifactRow[] }
}

// ---------- NEW: Teacher dashboard reads ----------

// List all assignments (id + title), newest first.
export async function listAssignments(): Promise<AssignmentRow[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id,title,pdf_path')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as AssignmentRow[]
}

// Pages for an assignment (ordered by page_index)
export async function listPages(assignment_id: string): Promise<PageRow[]> {
  const { data, error } = await supabase
    .from('pages')
    .select('id,assignment_id,page_index')
    .eq('assignment_id', assignment_id)
    .order('page_index', { ascending: true })
  if (error) throw error
  return data as PageRow[]
}

// Latest submission per student for a page.
// Returns 28 rows (A_01..A_28) even if no submission yet (submission/artifacts null).
export async function listLatestByPage(assignment_id: string, page_id: string, students: string[]) {
  // 1) Grab all submissions for this page
  const { data: subs, error: es } = await supabase
    .from('submissions')
    .select('id,student_id,created_at')
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .order('created_at', { ascending: false })
  if (es) throw es

  // pick latest per student
  const latestMap = new Map<string, SubmissionRow>()
  for (const s of (subs || []) as SubmissionRow[]) {
    if (!latestMap.has(s.student_id)) latestMap.set(s.student_id, s)
  }

  // 2) Fetch artifacts for those latest submissions
  const latestList = Array.from(latestMap.values())
  const ids = latestList.map(s => s.id)
  let artifacts: ArtifactRow[] = []
  if (ids.length) {
    const { data: arts, error: ea } = await supabase
      .from('artifacts')
      .select('*')
      .in('submission_id', ids)
      .order('created_at', { ascending: false })
    if (ea) throw ea
    artifacts = (arts || []) as ArtifactRow[]
  }

  // 3) Build simple view per student
  return students.map(stu => {
    const sub = latestMap.get(stu) || null
    const arts = sub ? artifacts.filter(a => a.submission_id === sub.id) : []
    const strokes = arts.find(a => a.kind === 'strokes') || null
    const audio = arts.find(a => a.kind === 'audio') || null
    return { student_id: stu, submission: sub, strokes, audio }
  })
}

// Signed URL for audio (1 hour)
export async function getAudioUrl(storage_path: string) {
  const { data, error } = await supabase.storage.from('audio').createSignedUrl(storage_path, 3600)
  if (error) throw error
  return data?.signedUrl as string
}
