// src/components/PdfDropZone.tsx
import { useState } from 'react'
import { supabase } from '../lib/db'

// We store PDFs in the "pdfs" bucket. Keys are "<uuid>.pdf" (no leading "pdfs/").
// In DB pages.pdf_path we save "pdfs/<uuid>.pdf" so the rest of the app
// (which strips "pdfs/") stays happy.
const PDF_BUCKET = 'pdfs'

export default function PdfDropZone({ onCreated }: { onCreated: (assignmentId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setErr(null)

    const file = e.dataTransfer.files?.[0]
    if (!file) { setErr('Drop a single PDF'); return }
    if (file.type !== 'application/pdf') { setErr('File must be a PDF'); return }

    setBusy(true)
    try {
      // 1) Upload to storage
      const keyOnly = `${crypto.randomUUID()}.pdf`        // key within the bucket
      const dbPath  = `pdfs/${keyOnly}`                   // what we store in pages.pdf_path

      const { error: upErr } = await supabase
        .storage.from(PDF_BUCKET)
        .upload(keyOnly, file, { contentType: 'application/pdf', upsert: false })
      if (upErr) throw upErr

      // 2) Create assignment (title only)
      const title = file.name.replace(/\.pdf$/i, '')
      const { data: assignment, error: aErr } = await supabase
        .from('assignments')
        .insert([{ title }])
        .select('id')
        .single()
      if (aErr) throw aErr
      const assignment_id = assignment.id as string

      // 3) Count PDF pages locally to seed pages table
      const pageCount = await countPdfPages(URL.createObjectURL(file))
      const rows = Array.from({ length: pageCount }, (_, i) => ({
        assignment_id,
        page_index: i,
        pdf_path: dbPath,     // keep identical for all pages (same file)
      }))

      const { error: pErr } = await supabase.from('pages').insert(rows)
      if (pErr) throw pErr

      // 4) Hand back the new assignment id
      onCreated(assignment_id)
    } catch (e: any) {
      console.error(e)
      setErr(e?.message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      style={{
        border: '2px dashed #d1d5db',
        borderRadius: 12,
        padding: 16,
        textAlign: 'center',
        background: '#fff',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <div style={{ fontWeight: 600 }}>Drag & drop a PDF to create a new assignment</div>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
        It will upload to the <code>pdfs</code> bucket and seed the pages table automatically.
      </div>
      {err && <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 8 }}>{err}</div>}
    </div>
  )
}

async function countPdfPages(objectUrl: string): Promise<number> {
  // Lazy-load pdfjs (no external net requests; uses your bundler)
  const pdfjs = await import('pdfjs-dist/build/pdf')
  ;(pdfjs as any).GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.js',
    import.meta.url
  ).toString()
  const pdf = await (pdfjs as any).getDocument(objectUrl).promise
  return (pdf as any).numPages as number
}
