// src/lib/db.ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL!,
  import.meta.env.VITE_SUPABASE_ANON_KEY!
)

/** Minimal rows used by teacher & student pages */
export type AssignmentRow = { id: string; title: string }
export type PageRow       = { id: string; assignment_id: string; page_index: number }
export type LatestByPageRow = {
  submission_id: string
  student_id: string
  created_at: string
  strokes_json?: any | null
  audio_url?: string | null
}

/** ---------- ASSIGNMENTS ---------- */
/** Hot-fix: upsert by title only (no pdf_path field) */
export async function upsertAssignmentWithPage(title: string, _pdfPath: string, pageIndex: number) {
  const { data: aRow, error: aErr } = await supabase
    .from('assignments')
    .upsert({ title }, { onConflict: 'title' })
    .select('id')
    .single()
  if (aErr) throw aErr
  const assignment_id = aRow!.id as string

  const { data: pRow, error: pErr } = await supabase
    .from('pages')
    .upsert({ assignment_id, page_index: pageIndex }, { onConflict: 'assignment_id,page_index' })
    .select('id')
    .single()
  if (pErr) throw pErr
  const page_id = pRow!.id as string

  return { assignment_id, page_id }
}

export async function listAssignments(): Promise<AssignmentRow[]> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id,title')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data || []) as AssignmentRow[]
}

/** ---------- PAGES ---------- */
export async function listPages(assignment_id: string): Promise<PageRow[]> {
  const { data, error } = await supabase
    .from('pages')
    .select('id,assignment_id,page_index')
    .eq('assignment_id', assignment_id)
    .order('page_index', { ascending: true })
  if (error) throw error
  return (data || []) as PageRow[]
}

/** ---------- SUBMISSIONS / ARTIFACTS ---------- */
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
  // simple storage; you can make the bucket public in Storage → audio
  const fileName = `${submission_id}-${Date.now()}.webm`
  const { data: up, error: upErr } = await supabase.storage.from('audio').upload(fileName, audioBlob, { upsert: true })
  if (upErr) throw upErr

  const { error: artErr } = await supabase
    .from('artifacts')
    .insert({ submission_id, page_id: null, kind: 'audio', audio_url: up.path })
  if (artErr) throw artErr
}

/** Returns latest submission + artifacts for given student/page */
export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
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

  return { submission_id: sub.id, created_at: sub.created_at, artifacts: arts || [] }
}

/** Teacher grid helper: latest submission per student for a page */
export async function listLatestByPage(assignment_id: string, page_id: string): Promise<LatestByPageRow[]> {
  // Get latest submission id per student for this page
  const { data: latest, error: latestErr } = await supabase
    .from('submissions')
    .select('id,student_id,created_at')
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .order('created_at', { ascending: false })
  if (latestErr) throw latestErr

  // Keep only the newest per student
  const newestMap = new Map<string, { id: string; created_at: string }>()
  ;(latest || []).forEach(row => {
    const prev = newestMap.get(row.student_id)
    if (!prev || new Date(row.created_at) > new Date(prev.created_at)) {
      newestMap.set(row.student_id, { id: row.id, created_at: row.created_at })
    }
  })

  const submissionIds = Array.from(newestMap.values()).map(v => v.id)
  if (submissionIds.length === 0) return []

  const { data: arts, error: artErr } = await supabase
    .from('artifacts')
    .select('submission_id, kind, strokes_json, audio_url, created_at')
    .in('submission_id', submissionIds)
  if (artErr) throw artErr

  const bySub = new Map<string, { strokes_json?: any; audio_url?: string | null }>()
  ;(arts || []).forEach(a => {
    const cur = bySub.get(a.submission_id) || {}
    if (a.kind === 'strokes') cur.strokes_json = a.strokes_json
    if (a.kind === 'audio')   cur.audio_url   = a.audio_url ?? null
    bySub.set(a.submission_id, cur)
  })

  const out: LatestByPageRow[] = []
  newestMap.forEach((v, student_id) => {
    const mix = bySub.get(v.id) || {}
    out.push({
      submission_id: v.id,
      student_id,
      created_at: v.created_at,
      strokes_json: mix.strokes_json ?? null,
      audio_url: mix.audio_url ?? null,
    })
  })
  return out
}

/** Storage public URL helper for audio (if bucket is public) */
export function getAudioUrl(path: string | null | undefined): string | null {
  if (!path) return null
  const { data } = supabase.storage.from('audio').getPublicUrl(path)
  return data?.publicUrl ?? null
}
