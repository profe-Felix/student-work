// src/lib/db.ts
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL!
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY!

// HMR-safe singleton + unique storage key to avoid "Multiple GoTrueClient instances"
function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storageKey: 'sb-student-work', // unique to this app
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  })
}

// Use globalThis so it's stable across Vite HMR in browser
export const supabase =
  (globalThis as any).__sb_client__ ?? ((globalThis as any).__sb_client__ = makeClient())

// === Types ===
export type AssignmentRow = { id: string; title: string }
export type PageRow = { id: string; assignment_id: string; page_index: number; pdf_path: string | null }

const ASSIGNMENT_TITLE = 'Handwriting - Daily'
const PDF_PATH_DEFAULT = 'pdfs/aprende-m2.pdf'

// ---------------- SELECT HELPERS ----------------
export async function getAssignmentIdByTitle(title: string = ASSIGNMENT_TITLE): Promise<string> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id')
    .eq('title', title)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error(`Assignment "${title}" not found.`)
  return data.id
}

export async function getPageId(assignment_id: string, page_index: number): Promise<string> {
  const { data, error } = await supabase
    .from('pages')
    .select('id,pdf_path')
    .eq('assignment_id', assignment_id)
    .eq('page_index', page_index)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error(`Page ${page_index} not found for assignment ${assignment_id}.`)
  return data.id
}

export async function upsertAssignmentWithPage(title: string, _pdf_path: string, page_index: number) {
  const assignment_id = await getAssignmentIdByTitle(title)
  const page_id = await getPageId(assignment_id, page_index)
  return { assignment_id, page_id }
}

// ---------------- SUBMISSIONS ----------------
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
  const bucket = 'student-audio'
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
  try {
    const { data: signed, error: signErr } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60)
    if (!signErr && signed?.signedUrl) return signed.signedUrl
  } catch {}
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

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

// ---------------- TEACHER HELPERS ----------------
export async function listAssignments(): Promise<AssignmentRow[]> {
  const { data, error } = await supabase.from('assignments').select('id,title').order('title', { ascending: true })
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

// ---------------- CLASS STATE ----------------
export async function upsertClassState(classCode: string, assignmentId: string, pageId: string, pageIndex: number) {
  const { error } = await supabase
    .from('class_state')
    .upsert(
      {
        class_code: classCode,
        assignment_id: assignmentId,
        page_id: pageId,
        page_index: pageIndex,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'class_code' }
    )
  if (error) throw error
}

export async function fetchClassState(classCode: string) {
  const { data, error } = await supabase.from('class_state').select('*').eq('class_code', classCode).maybeSingle()
  if (error) throw error
  return data as
    | { class_code: string; assignment_id: string; page_id: string; page_index: number; updated_at: string }
    | null
}

// ---------------- TEACHER STATE ----------------
export type TeacherStateRow = {
  user_id: string
  class_code: string
  assignment_id: string
  page_index: number
  focus_on: boolean
  auto_follow: boolean
  allowed_pages: number[] | null
  allow_colors?: boolean | null
  updated_at: string
}

// ✅ FIXED: safe UUID fallback for anon mode
export async function upsertTeacherState(input: {
  classCode: string
  assignmentId: string
  pageIndex?: number
  focusOn?: boolean
  autoFollow?: boolean
  allowedPages?: number[] | null
  allowColors?: boolean | null
}) {
  const {
    classCode,
    assignmentId,
    pageIndex = 0,
    focusOn = false,
    autoFollow = false,
    allowedPages = null,
    allowColors = true,
  } = input

  const { data: me } = await supabase.auth.getUser()
  const uid = me?.user?.id || '00000000-0000-0000-0000-000000000000' // valid UUID fallback

  const { error } = await supabase
    .from('teacher_state')
    .upsert(
      {
        user_id: uid,
        class_code: classCode,
        assignment_id: assignmentId,
        page_index: pageIndex,
        focus_on: focusOn,
        auto_follow: autoFollow,
        allowed_pages: allowedPages,
        allow_colors: allowColors,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,class_code' }
    )

  if (error) throw error
}

export async function patchTeacherState(
  classCode: string,
  partial: {
    assignmentId?: string
    pageIndex?: number
    focusOn?: boolean
    autoFollow?: boolean
    allowedPages?: number[] | null
    allowColors?: boolean | null
  }
) {
  const { data: me } = await supabase.auth.getUser()
  const uid = me?.user?.id || '00000000-0000-0000-0000-000000000000'

  const update: Record<string, any> = { updated_at: new Date().toISOString() }
  if (partial.assignmentId !== undefined) update.assignment_id = partial.assignmentId
  if (partial.pageIndex !== undefined) update.page_index = partial.pageIndex
  if (partial.focusOn !== undefined) update.focus_on = partial.focusOn
  if (partial.autoFollow !== undefined) update.auto_follow = partial.autoFollow
  if (partial.allowedPages !== undefined) update.allowed_pages = partial.allowedPages
  if (partial.allowColors !== undefined) update.allow_colors = partial.allowColors

  const { error } = await supabase
    .from('teacher_state')
    .update(update)
    .eq('user_id', uid)
    .eq('class_code', classCode)

  if (error) throw error
}

export async function setTeacherAllowColors(classCode: string, allow: boolean) {
  await patchTeacherState(classCode, { allowColors: allow })
}

export async function fetchTeacherStateForClass(classCode: string): Promise<TeacherStateRow | null> {
  const { data, error } = await supabase
    .from('teacher_state')
    .select('*')
    .eq('class_code', classCode)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error && (error as any).code !== 'PGRST116') throw error
  return (data as any) ?? null
}
