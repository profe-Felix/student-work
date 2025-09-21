// src/components/PdfDropZone.tsx
import { useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

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
      // ---- CHANGE: use your 'pdfs' bucket ----
      const bucket = 'pdfs';
      const key = `${crypto.randomUUID()}.pdf`;

      // 1) Upload PDF to storage
      const { error: upErr } = await supabase.storage.from(bucket).upload(key, file, {
        contentType: 'application/pdf',
      });
      if (upErr) throw upErr;

      // 2) Create assignment (store "bucket/path" so it’s self-contained)
      const title = file.name.replace(/\.pdf$/i, '');
      const storage_path = `${bucket}/${key}`;
      const { data: assign, error: aErr } = await supabase
        .from('assignments')
        .insert({ title, pdf_path: storage_path })
        .select('id')
        .single();
      if (aErr) throw aErr;

      // 3) Count pages with pdfjs
      const pageCount = await countPdfPages(URL.createObjectURL(file));

      // 4) Seed pages table
      const rows = Array.from({ length: pageCount }).map((_, i) => ({
        assignment_id: assign.id,
        title: `Page ${i + 1}`,
        page_index: i,
        pdf_path: storage_path,
      }));
      const { error: pErr } = await supabase.from('pages').insert(rows);
      if (pErr) throw pErr;

      onCreated(assign.id);
    } catch (e: any) {
      console.error(e);
      setErr(e?.message || 'Failed to create assignment.');
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
