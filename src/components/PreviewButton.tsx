// src/components/PreviewButton.tsx
import { useState } from 'react';
import { fetchLatestFullForStudent } from '../lib/preview';
import PlaybackDrawer from './PlaybackDrawer';

type PreviewButtonProps = {
  assignmentId: string;
  pageId: string;
  pageIndex: number;     // zero-based page index for the PDF page
  pdfUrl: string;        // pages.pdf_path
  studentId: string;     // e.g., "A_01"
  label?: string;        // optional button label override
  className?: string;    // optional styling hook
};

/**
 * Drop-in Preview button that opens PlaybackDrawer with the student's latest
 * strokes + audio layered over the selected PDF page.
 *
 * Non-invasive: does not alter parent state or routing.
 */
export default function PreviewButton({
  assignmentId,
  pageId,
  pageIndex,
  pdfUrl,
  studentId,
  label = 'Preview',
  className,
}: PreviewButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [strokes, setStrokes] = useState<any | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  async function handleOpen() {
    setLoading(true);
    try {
      const full = await fetchLatestFullForStudent(assignmentId, pageId, studentId);
      if (!full) {
        // You can swap this for your toast system if present
        alert('No submission yet for this student on this page.');
        setLoading(false);
        return;
      }
      setStrokes(full.strokes ?? null);
      setAudioUrl(full.audioUrl ?? null);
      setOpen(true);
    } catch (e) {
      console.error('[PreviewButton] Failed to fetch preview:', e);
      alert('Failed to load preview.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={loading}
        className={className}
        title="Preview latest submission"
      >
        {loading ? 'Loading…' : label}
      </button>

      <PlaybackDrawer
        open={open}
        onClose={() => setOpen(false)}
        pdfUrl={pdfUrl ?? ''}
        pageIndex={pageIndex ?? 0}
        strokes={strokes}
        audioUrl={audioUrl}
      />
    </>
  );
}
