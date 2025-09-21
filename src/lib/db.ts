import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
)

export async function ensureStudent(id: string) {
  if (!id) return
  const { error } = await supabase.from('students').insert({ id }).select('id').maybeSingle()
  if (error && !String(error.message).includes('duplicate')) {
    console.warn('ensureStudent warning:', error.message)
  }
}

export async function upsertAssignmentWithPage(title: string, pdfPath: string, pageIndex: number) {
  let { data: aRow } = await supabase
    .from('assignments').select('id').eq('title', title).maybeSingle()

  let assignment_id = aRow?.id
  if (!assignment_id) {
    const ins = await supabase.from('assignments').insert({ title }).select('id').single()
    if (ins.error) throw ins.error
    assignment_id = ins.data!.id
  }

  let { data: pRow } = await supabase
    .from('pages')
    .select('id')
    .eq('assignment_id', assignment_id)
    .eq('page_index', pageIndex)
    .maybeSingle()

  if (!pRow) {
    const ins = await supabase.from('pages')
      .insert({ assignment_id, page_index: pageIndex, pdf_path: pdfPath })
      .select('id').single()
    if (ins.error) throw ins.error
    pRow = ins.data
  }

  return { assignment_id, page_id: pRow!.id as string }
}

export async function createSubmission(student_id: string, assignment_id: string, page_id: string) {
  const { data, error } = await supabase.from('submissions')
    .insert({ student_id, assignment_id, page_id })
    .select('id').single()
  if (error) throw error
  return data!.id as string
}

export async function saveStrokes(submission_id: string, strokes: any) {
  const { error } = await supabase.from('artifacts').insert({
    submission_id, kind: 'strokes', strokes_json: strokes
  })
  if (error) throw error
}

export async function saveAudio(submission_id: string, blob: Blob) {
  const fileName = `${submission_id}/${Date.now()}.webm`
  const up = await supabase.storage.from('student-audio')
    .upload(fileName, blob, { contentType: blob.type })
  if (up.error) throw up.error

  const { error } = await supabase.from('artifacts').insert({
    submission_id, kind: 'audio', audio_path: fileName, bytes: blob.size
  })
  if (error) throw error
}

export async function loadLatestSubmission(assignment_id: string, page_id: string, student_id: string) {
  const { data, error } = await supabase.from('submissions')
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
  return data?.[0] || null
}
