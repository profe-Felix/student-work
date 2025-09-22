//src/lib/db.ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } }
)

// === Types (teacher page may import some of these) ===
export type AssignmentRow = { id: string; title: string }
export type PageRow = { id: string; assignment_id: string; page_index: number; pdf_path: string | null }

// ----- SELECT helpers -----
export async function getAssignmentIdByTitle(title: string): Promise<string> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id')
    .eq('title', title)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error(`Assignment "${title}" not found`)
  return data.id
}

export async function getPageId(assignment_id: string, page_index: number): Promise<string> {
  const { data, error } = await supabase
    .from('pages')
    .select('id')
    .eq('assignment_id', assignment_id)
    .eq('page_index', page_index)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error(`Page ${page_index} not found for assignment ${assignment_id}`)
  return data.id
}

/** Backward-compatible wrapper used by student/assignment.tsx */
export async function upsertAssignmentWithPage(title: string, _pdf_path: string, page_index: number) {
  // We don’t upsert here; just SELECT what already exists.
  const assignment_id = await getAssignmentIdByTitle(title)
  const page_id = await getPageId(assignment_id, page_index)
  return { assignment_id, page_id }
}

// ----- Submissions & artifacts -----
export async function createSubmission(student_id: string, assignment_id: string, page_id: string): Promise<string> {
  const { data, error } = await supabase
    .from('submissions')
    .insert([{ student_id, assignment_id, page_id }])
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

export async function saveStrokes(submission_id: string, strokes_json: any) {
  const { error } = await supabase
    .from('artifacts')
    .insert([{ submission_id, kind: 'strokes', strokes_json }])
  if (error) throw error
}

export async function saveAudio(submission_id: string, blob: Blob) {
  const bucket = 'audio'
  const key = `${submission_id}/${Date.now()}.webm`
  const { error: upErr } = await supabase.storage.from(bucket).upload(key, blob, {
    contentType: 'audio/webm',
    upsert: false,
  })
  if (upErr) throw upErr

  const { error: insErr } = await supabase
    .from('artifacts')
    .insert([{ submission_id, kind: 'audio', storage_path: `${bucket}/${key}` }])
  if (insErr) throw insErr
}

export async function getAudioUrl(storage_path: string) {
  const [bucket, ...rest] = storage_path.split('/')
  const path = rest.join('/')
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

// Latest submission (with joined artifacts) for a page/student
export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
  const { data: sub, error: se } = await supabase
    .from('submissions')
    .select('id, created_at')
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .eq('student_id', student_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (se) throw se
  if (!sub?.id) return null

  const { data: arts, error: ae } = await supabase
    .from('artifacts')
    .select('id, kind, strokes_json, storage_path, created_at')
    .eq('submission_id', sub.id)
    .order('created_at', { ascending: true })
  if (ae) throw ae

  return { submission: sub, artifacts: arts || [] }
}

// ----- Teacher helpers (select-only) -----
export async function listAssignments(): Promise<AssignmentRow[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id,title')
    .order('title', { ascending: true })
  if (error) throw error
  return data as AssignmentRow[]
}

export async function listPages(assignment_id: string): Promise<PageRow[]> {
  const { data, error } = await supabase
    .from('pages')
    .select('id,assignment_id,page_index,pdf_path')
    .eq('assignment_id', assignment_id)
    .order('page_index', { ascending: true })
  if (error) throw error
  return data as PageRow[]
}

export async function listLatestByPage(assignment_id: string, page_id: string) {
  const { data, error } = await supabase
    .from('submissions')
    .select('id, student_id, created_at, artifacts(id,kind,strokes_json,storage_path,created_at)')
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}
