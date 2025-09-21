import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
)

/** Tables (minimal fields we touch) */
type StudentRow = { id: string }
type AssignmentRow = { id: string }
type PageRow = { id: string }
type SubmissionRow = { id: string }
type ArtifactRow = {
  kind: 'strokes' | 'audio'
  strokes_json?: any | null
  audio_path?: string | null
}

/** Ensure a student exists (id is PK) */
export async function ensureStudent(id: string) {
  if (!id) return
  const { error } = await supabase
    .from('students')
    .upsert({ id }, { onConflict: 'id', ignoreDuplicates: false })
  if (error) throw error
}

/** Optional: list students for a class letter (A_01, …)  */
export async function listStudents(letter: string) {
  const like = `${letter}_%`
  const { data, error } = await supabase
    .from('students')
    .select<'id', StudentRow>('id')
    .like('id', like)
    .order('id', { ascending: true })
  if (error) throw error
  return (data ?? []) as StudentRow[]
}

/** Create/fetch assignment + page */
export async function upsertAssignmentWithPage(title: string, pdfPath: string, pageIndex: number) {
  // assignment
  const gotA = await supabase.from('assignments')
    .select<'id', AssignmentRow>('id')
    .eq('title', title)
    .maybeSingle()
  if (gotA.error) throw gotA.error

  let assignment_id = gotA.data?.id
  if (!assignment_id) {
    const insA = await supabase.from('assignments')
      .insert({ title })
      .select<'id', AssignmentRow>('id')
      .single()
    if (insA.error) throw insA.error
    assignment_id = insA.data.id
  }

  // page
  const gotP = await supabase.from('pages')
    .select<'id', PageRow>('id')
    .eq('assignment_id', assignment_id)
    .eq('page_index', pageIndex)
    .maybeSingle()
  if (gotP.error) throw gotP.error

  let page_id = gotP.data?.id
  if (!page_id) {
    const insP = await supabase.from('pages')
      .insert({ assignment_id, page_index: pageIndex, pdf_path: pdfPath })
      .select<'id', PageRow>('id')
      .single()
    if (insP.error) throw insP.error
    page_id = insP.data.id
  }

  return { assignment_id, page_id }
}

/** Create a submission and return its id */
export async function createSubmission(student_id: string, assignment_id: string, page_id: string) {
  const { data, error } = await supabase
    .from('submissions')
    .insert({ student_id, assignment_id, page_id })
    .select<'id', SubmissionRow>('id')
    .single()
  if (error) throw error
  return data.id
}

/** Save strokes JSON as an artifact */
export async function saveStrokes(submission_id: string, strokes: any) {
  const { error } = await supabase
    .from('artifacts')
    .insert({ submission_id, kind: 'strokes', strokes_json: strokes } as Partial<ArtifactRow> & { submission_id: string })
  if (error) throw error
}

/** Save audio blob to storage + record in artifacts */
export async function saveAudio(submission_id: string, blob: Blob) {
  const fileName = `${submission_id}/${Date.now()}.webm`
  const up = await supabase.storage
    .from('student-audio')
    .upload(fileName, blob, { contentType: blob.type })
  if (up.error) throw up.error

  const { error } = await supabase
    .from('artifacts')
    .insert({ submission_id, kind: 'audio', audio_path: fileName, bytes: blob.size } as any)
  if (error) throw error
}

/** Load latest submission (with artifacts) for a page/student */
export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
  const { data, error } = await supabase
    .from('submissions')
    .select(`
      id,
      artifacts:artifacts(kind, strokes_json, audio_path)
    `)
    .eq('assignment_id', assignment_id)
    .eq('page_id', page_id)
    .eq('student_id', student_id)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw error
  // `data` is SubmissionRow[] with embedded artifacts; return first or null
  return (data && data[0]) || null
}
