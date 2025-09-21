// src/components/PdfDropZone.tsx
import { useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { v4 as uuidv4 } from 'uuid';

export default function PdfDropZone({ onCreated }:{ onCreated:(assignmentId:string)=>void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string|null>(null);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setErr(null);
    const file = e.dataTransfer.files?.[0];
    if (!file || file.type !== 'application/pdf') { setErr('Drop a single PDF'); return; }
    setBusy(true);
    try {
      const key = `pdfs/${uuidv4()}.pdf`;
      const { error: upErr } = await supabase.storage.from('public').upload(key, file, { contentType: 'application/pdf' });
      if (upErr) throw upErr;

      const title = file.name.replace(/\.pdf$/i, '');
      const { data: assign, error: aErr } = await supabase
        .from('assignments').insert({ title, pdf_path: key }).select('id').single();
      if (aErr) throw aErr;

      const pageCount = await countPdfPages(URL.createObjectURL(file));
      const rows = Array.from({ length: pageCount }).map((_, i) => ({
        assignment_id: assign.id,
        title: `Page ${i + 1}`,
        page_index: i,
        pdf_path: key, // required by your schema
      }));
      const { error: pErr } = await supabase.from('pages').insert(rows);
      if (pErr) throw pErr;

      onCreated(assign.id);
    } catch (e: any) {
      setErr(e.message || 'Upload failed');
    } finally { setBusy(false); }
  }

  return (
    <div
      onDragOver={e => e.preventDefault()}
      onDrop={handleDrop}
      className={`border-2 border-dashed rounded-xl p-6 text-center ${busy ? 'opacity-60' : ''}`}
    >
      <div>Drag & drop a PDF to create a new assignment</div>
      {err && <div className="text-red-600 text-sm mt-2">{err}</div>}
    </div>
  );
}

async function countPdfPages(objectUrl: string): Promise<number> {
  const pdfjs = await import('pdfjs-dist/build/pdf');
  // @ts-ignore - set worker from package. Adjust path if bundler expects copy.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.js', import.meta.url).toString();
  const pdf = await pdfjs.getDocument(objectUrl).promise;
  return pdf.numPages;
}
