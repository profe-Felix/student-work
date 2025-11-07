//src/lib/db.ts
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
      // Gentle throttle so we don't burst during joins
      params: { eventsPerSecond: 10 },
    },
  })
}

// Use globalThis so it's stable across Vite HMR in browser
export const supabase =
  (globalThis as any).__sb_client__ ?? ((globalThis as any).__sb_client__ = makeClient())

// === Types (teacher page imports some of these) ===
export type AssignmentRow = { id: string; title: string }
export type PageRow = { id: string; assignment_id: string; page_index: number; pdf_path: string | null }

const ASSIGNMENT_TITLE = 'Handwriting - Daily'      // keep in sync with student page
const PDF_PATH_DEFAULT = 'pdfs/aprende-m2.pdf'      // just for sanity checks in SELECT

// ----- SELECT-ONLY helpers (no inserts to assignments/pages from browser) -----
export async function getAssignmentIdByTitle(title: string = ASSIGNMENT_TITLE): Promise<string> {
  const { data, error } = await supabase
    .from('assignments')
    .select('id')
    .eq('title', title)
    .limit(1)
    .maybeSingle()

  if (error) throw error
  if (!data?.id) throw new Error(`Assignment "${title}" not found. Create it once in SQL.`)
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
  if (!data?.id) throw new Error(`Page ${page_index} not found for assignment ${assignment_id}. Seed pages in SQL.`)
  return data.id
}

// Backwards-compatible wrapper used by student/assignment.tsx
export async function upsertAssignmentWithPage(title: string, _pdf_path: string, page_index: number) {
  // NOTE: no “upsert” anymore — just SELECT.
  const assignment_id = await getAssignmentIdByTitle(title)
  const page_id = await getPageId(assignment_id, page_index)
  return { assignment_id, page_id }
}

// ----- Submissions & artifacts (allowed by RLS) -----
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

// ===== audio bucket hard-coded to "student-audio" + signed URL support =====
export async function saveAudio(submission_id: string, blob: Blob) {
  const bucket = 'student-audio' // your bucket
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

  // Try a signed URL (works with private buckets); fall back to public URL
  try {
    const { data: signed, error: signErr } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60)
    if (!signErr && signed?.signedUrl) return signed.signedUrl
  } catch {
    // ignore and try public
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

// Latest submission (with joined artifacts) for a page
export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
  // get latest submission id for this student/page
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

  // pull artifacts
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


// --- CLASS STATE HELPERS (legacy) ---
export async function upsertClassState(
  classCode: string,
  assignmentId: string,
  pageId: string,
  pageIndex: number
) {
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
      { onConflict: 'class_code' } // upsert by PK
    )
  if (error) throw error
}

export async function fetchClassState(classCode: string) {
  const { data, error } = await supabase
    .from('class_state')
    .select('*')
    .eq('class_code', classCode)
    .maybeSingle()
  if (error) throw error
  return data as
    | {
        class_code: string
        assignment_id: string
        page_id: string
        page_index: number
        updated_at: string
      }
    | null
}

/* =============================================================================
   NEW: TABLE-DRIVEN TEACHER STATE (reduces realtime chatter)
   - Teacher writes one row per (user_id, class_code)
   - Students poll SELECT latest by updated_at for their class
============================================================================= */

export type TeacherStateRow = {
  user_id: string
  class_code: string
  assignment_id: string
  page_index: number
  focus_on: boolean
  auto_follow: boolean
  allowed_pages: number[] | null
  updated_at: string
}

/** Teacher: upsert current state (INSERT once, then UPDATE same row). */
export async function upsertTeacherState(input: {
  classCode: string
  assignmentId: string
  pageIndex?: number
  focusOn?: boolean
  autoFollow?: boolean
  allowedPages?: number[] | null
}) {
  const {
    classCode,
    assignmentId,
    pageIndex = 0,
    focusOn = false,
    autoFollow = false,
    allowedPages = null,
  } = input

  const { data: me } = await supabase.auth.getUser()
  const uid = me?.user?.id
  if (!uid) throw new Error('Must be signed in to upsert teacher_state')

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
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,class_code' }
    )

  if (error) throw error
}

/** Student: fetch current teacher state for a class (latest row wins). */
export async function fetchTeacherStateForClass(classCode: string): Promise<TeacherStateRow | null> {
  const { data, error } = await supabase
    .from('teacher_state')
    .select('*')
    .eq('class_code', classCode)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // PGRST116 = no rows found for maybeSingle()
  if (error && (error as any).code !== 'PGRST116') throw error
  return (data as any) ?? null
}
