//src/lib/preview.ts
import { supabase } from './db';
import { getAudioUrl } from './db';

export type LatestFullForStudent = {
  submissionId: string;
  strokes: any | null;
  audioUrl: string | null;
} | null;

/**
 * Fetch the latest submission + artifacts (strokes + audio) for a given student/page.
 * - Non-destructive, read-only.
 * - Returns null if the student has no submission for the page.
 */
export async function fetchLatestFullForStudent(
  assignmentId: string,
  pageId: string,
  studentId: string
): Promise<LatestFullForStudent> {
  // 1) Latest submission for this student+page
  const { data: submissions, error: subErr } = await supabase
    .from('submissions')
    .select('id, created_at')
    .eq('assignment_id', assignmentId)
    .eq('page_id', pageId)
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (subErr) {
    console.error('[fetchLatestFullForStudent] submissions error:', subErr);
    throw subErr;
  }
  const submission = submissions?.[0];
  if (!submission) return null;

  // 2) Artifacts (strokes + audio)
  const { data: artifacts, error: artErr } = await supabase
    .from('artifacts')
    .select('id, kind, strokes_json, storage_path, created_at')
    .eq('submission_id', submission.id)
    .order('created_at', { ascending: false });

  if (artErr) {
    console.error('[fetchLatestFullForStudent] artifacts error:', artErr);
    throw artErr;
  }

  const strokes = artifacts?.find(a => a.kind === 'strokes')?.strokes_json ?? null;
  const audioArtifact = artifacts?.find(a => a.kind === 'audio') ?? null;

  let audioUrl: string | null = null;
  if (audioArtifact?.storage_path) {
    try {
      audioUrl = await getAudioUrl(audioArtifact.storage_path);
    } catch (e) {
      console.warn('[fetchLatestFullForStudent] getAudioUrl failed:', e);
      audioUrl = null;
    }
  }

  return { submissionId: submission.id, strokes, audioUrl };
}
