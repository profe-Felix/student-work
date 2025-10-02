// src/components/PdfDropZone.tsx
import { useRef, useState } from 'react'
import { supabase } from '../lib/db'

const PDF_BUCKET = 'pdfs'

export default function PdfDropZone({
  onCreated,
}: {
  onCreated: (assignmentId: string, title: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)               // flash “Uploaded”
  const [isOver, setIsOver] = useState(false)       // visual hover state
  const dragDepth = useRef(0)                       // avoid flicker with nested drag events

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current = 0
    setIsOver(false)
    setErr(null)

    const file = e.dataTransfer.files?.[0]
    if (!file) { setErr('Drop a single PDF'); return }
    if (file.type !== 'application/pdf') { setErr('File must be a PDF'); return }

    setBusy(true)
    try {
      const keyOnly = `${crypto.randomUUID()}.pdf`  // key in bucket
      const dbPath = `pdfs/${keyOnly}`              // what we store in pages.pdf_path

      const { error: upErr } = await supabase
        .storage.from(PDF_BUCKET)
        .upload(keyOnly, file, { contentType: 'application/pdf', upsert: false })
      if (upErr) throw upErr

      const title = file.name.replace(/\.pdf$/i, '')

      // UPDATED: upsert by title (avoid duplicate-key on reupload)
      const { data: assignment, error: aErr } = await supabase
        .from('assignments')
        .upsert({ title }, { onConflict: 'title' })
        .select('id')
        .single()
      if (aErr) throw aErr
      const assignment_id = assignment.id as string

      const pageCount = await countPdfPages(URL.createObjectURL(file))
      const rows = Array.from({ length: pageCount }, (_, i) => ({
        assignment_id,
        page_index: i,
        pdf_path: dbPath,
      }))

      // UPDATED: upsert pages on (assignment_id, page_index)
      const { error: pErr } = await supabase
        .from('pages')
        .upsert(rows, { onConflict: 'assignment_id,page_index' })
      if (pErr) throw pErr

      // flash “Uploaded”
      setOk(true)
      setTimeout(() => setOk(false), 1200)

      // hand back id+title so the teacher page can update the dropdown instantly
      onCreated(assignment_id, title)
    } catch (e: any) {
      console.error(e)
      setErr(e?.message || 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
  }
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current += 1
    setIsOver(true)
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      setIsOver(false)
      dragDepth.current = 0
    }
  }

  return (
    <div
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={handleDrop}
      style={{
        border: `2px ${isOver ? 'solid' : 'dashed'} ${isOver ? '#34d399' : '#d1d5db'}`,
        background: isOver ? 'rgba(52,211,153,0.08)' : '#fff',
        transition: 'border-color 120ms ease, background 120ms ease, transform 120ms ease',
        borderRadius: 12,
        padding: 16,
        textAlign: 'center',
        opacity: busy ? 0.6 : 1,
        transform: isOver ? 'scale(1.01)' : 'scale(1.0)',
        position: 'relative',
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {isOver ? 'Release to upload PDF' : 'Drag & drop a PDF to create a new assignment'}
      </div>
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
        Stored in the <code>pdfs</code> bucket and auto-seeds pages.
      </div>

      {err && <div style={{ color: '#b91c1c', fontSize: 13, marginTop: 8 }}>{err}</div>}

      {/* “Uploaded” toast */}
      {ok && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -10,
            transform: 'translate(-50%, 100%)',
            background: '#047857',
            color: '#fff',
            padding: '8px 12px',
            borderRadius: 10,
            fontWeight: 700,
            boxShadow: '0 8px 18px rgba(0,0,0,0.25)',
          }}
        >
          Uploaded
        </div>
      )}
    </div>
  )
}

async function countPdfPages(objectUrl: string): Promise<number> {
  const pdfjs = await import('pdfjs-dist/build/pdf')
  ;(pdfjs as any).GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.js',
    import.meta.url
  ).toString()
  const pdf = await (pdfjs as any).getDocument(objectUrl).promise
  return (pdf as any).numPages as number
}
