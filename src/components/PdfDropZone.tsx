//src/components/PdfDropZone.tsx
import { useRef, useState } from 'react';
import { supabase } from '../lib/db';

type Props = { onCreated: (assignmentId: string) => void };

export default function PdfDropZone({ onCreated }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOver, setIsOver] = useState(false);

  async function handleFiles(files: FileList | null) {
    setErr(null);
    const file = files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setErr('Please select a single PDF file.');
      return;
    }

    setBusy(true);
    try {
      // Use your existing *public* bucket and store under pdfs/...
      const bucket = 'public';
      const key = `pdfs/${crypto.randomUUID()}.pdf`;

      // 1) Upload the PDF
      const { error: upErr } = await supabase.storage.from(bucket).upload(key, file, {
        contentType: 'application/pdf',
      });
      if (upErr) throw upErr;

      const title = file.name.replace(/\.pdf$/i, '');
      const storage_path = `${bucket}/${key}`;

      // 2) Create the assignment (or re-use an existing title)
      let assignmentId: string | null = null;
      const ins = await supabase
        .from('assignments')
        .insert({ title, pdf_path: storage_path })
        .select('id')
        .maybeSingle();

      if (ins.error) {
        // unique violation → look up by title
        if ((ins.error as any).code === '23505') {
          const found = await supabase
            .from('assignments')
            .select('id,pdf_path')
            .eq('title', title)
            .maybeSingle();
          if (found.error || !found.data?.id) throw ins.error;
          assignmentId = found.data.id;

          if (!found.data.pdf_path) {
            await supabase.from('assignments')
              .update({ pdf_path: storage_path })
              .eq('id', assignmentId);
          }
        } else {
          throw ins.error;
        }
      } else {
        assignmentId = ins.data!.id;
      }

      if (!assignmentId) throw new Error('Could not determine assignment id.');

      // 3) Count pages with pdfjs (client-side)
      const pageCount = await countPdfPages(URL.createObjectURL(file));

      // 4) Ensure pages exist — insert any missing rows
      const existing = await supabase
        .from('pages')
        .select('page_index')
        .eq('assignment_id', assignmentId);

      if (existing.error) throw existing.error;

      const have = new Set<number>((existing.data ?? []).map((r: any) => r.page_index));
      const rows = Array.from({ length: pageCount })
        .map((_, i) => i)
        .filter(i => !have.has(i))
        .map((i) => ({
          assignment_id: assignmentId!,
          page_index: i,
          pdf_path: storage_path,
        }));

      if (rows.length > 0) {
        const { error: pErr } = await supabase.from('pages').insert(rows);
        if (pErr) throw pErr;
      }

      onCreated(assignmentId);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || 'Failed to create/attach assignment.');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsOver(false);
    void handleFiles(e.dataTransfer?.files || null);
  }

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setIsOver(true); }}
        onDragLeave={() => setIsOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        aria-label="Upload PDF"
        tabIndex={0}
        style={{
          border: '2px dashed #d1d5db',
          borderRadius: 14,
          padding: 18,
          minHeight: 140,
          display: 'grid',
          placeItems: 'center',
          background: isOver ? '#f0fdf4' : '#fbfbfb',
          cursor: busy ? 'progress' : 'pointer',
          transition: 'background 120ms ease',
        }}
      >
        <div style={{ textAlign: 'center', color: '#374151' }}>
          <div style={{ fontSize: 36, lineHeight: 1, marginBottom: 6 }}>📄⬇️</div>
          <div style={{ fontWeight: 700 }}>
            {busy ? 'Uploading…' : 'Drag & drop a PDF here'}
          </div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>
            or <span style={{ textDecoration: 'underline' }}>click to choose a file</span>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          onChange={(e) => void handleFiles(e.target.files)}
          style={{ display: 'none' }}
          disabled={busy}
        />
      </div>

      {err && (
        <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 8 }}>
          {err}
        </div>
      )}
    </div>
  );
}

async function countPdfPages(objectUrl: string): Promise<number> {
  const pdfjs: any = await import('pdfjs-dist/build/pdf');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.js',
    import.meta.url
  ).toString();
  const pdf = await pdfjs.getDocument(objectUrl).promise;
  return pdf.numPages as number;
}
