import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
)

// Minimal row shapes we touch
type StudentRow = { id: string }

export async function ensureStudent(id: string) {
  if (!id) return
  const { error } = await supabase
    .from('students')
    .upsert({ id }, { onConflict: 'id', ignoreDuplicates: false })
  if (error) throw error
}

export async function listStudents(letter: string): Promise<StudentRow[]> {
  const like = `${letter}_%`
  const { data, error } = await supabase
    .from('students')
    .select('id')
    .like('id', like)
    .order('id', { ascending: true })
  if (error) throw error
  return (data as StudentRow[]) || []
}

export async function upsertAssignmentWithPage(title: string, pdfPath: string, pageIndex: number) {
  // assignment
  const gotA = await supabase
    .from('assignments')
    .select('id')
    .eq('title', title)
    .maybeSingle()
  if (gotA.error) throw gotA.error

  let assignment_id: string | undefined = (gotA.data as any)?.id
  if (!assignment_id) {
    const insA = await supabase
      .from('assignments')
      .insert({ title })
      .select('id')
      .single()
    if (insA.error) throw insA.error
    assignment_id = (insA.data as any).id
  }

  // page
  const gotP = await supabase
    .from('pages')
    .select('id')
    .eq('assignment_id', assignment_id)
    .eq('page_index', pageIndex)
    .maybeSingle()
  if (gotP.error) throw gotP.error

  let page_id: string | undefined = (gotP.data as any)?.id
  if (!page_id) {
    const insP = await supabase
      .from('pages')
      .insert({ assignment_id, page_index: pageIndex, pdf_path: pdfPath })
      .select('id')
      .single()
    if (insP.error) throw insP.error
    page_id = (insP.data as any).id
  }

  return { assignment_id: assignment_id!, page_id: page_id! }
}

export async function createSubmission(student_id: string, assignment_id: string, page_id: string) {
  const { data, error } = await supabase
    .from('submissions')
    .insert({ student_id, assignment_id, page_id })
    .select('id')
    .single()
  if (error) throw error
  return (data as any).id as string
}

export async function saveStrokes(submission_id: string, strokes: any) {
  const { error } = await supabase
    .from('artifacts')
    .insert({ submission_id, kind: 'strokes', strokes_json: strokes })
  if (error) throw error
}

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
  return (data && (data as any[])[0]) || null
}
