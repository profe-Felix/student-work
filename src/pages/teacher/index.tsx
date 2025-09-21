// src/pages/teacher/index.tsx
import { useEffect, useMemo, useState } from 'react'
import { listAssignments, listPages, listLatestByPage, getAudioUrl, AssignmentRow, PageRow } from '../../lib/db'
import PdfCanvas from '../../components/PdfCanvas'
import PlaybackDrawer from '../../components/PlaybackDrawer'

// Roster (A_01 … A_28). Adjust if your class size changes.
const STUDENTS = Array.from({ length: 28 }, (_, i) => `A_${String(i + 1).padStart(2, '0')}`)

type RowView = {
  student_id: string
  submission: { id: string } | null
  strokes: { strokes_json?: any } | null
  audio: { storage_path?: string | null } | null
}

export default function Teacher() {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentId, setAssignmentId] = useState<string | null>(null)

  const [pages, setPages] = useState<PageRow[]>([])
  const [pageId, setPageId] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState<number>(0)
  const [pdfUrl, setPdfUrl] = useState<string>('')

  const [rows, setRows] = useState<RowView[]>([])
  const [loading, setLoading] = useState(false)

  // Drawer state
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<{ student: string, strokes: any, audioUrl?: string } | null>(null)

  // Load assignments on mount
  useEffect(() => {
    (async () => {
      const a = await listAssignments()
      setAssignments(a)
      if (a.length) {
        setAssignmentId(a[0].id)
        // derive pdf path from student app setting:
        const path = a[0].pdf_path || 'pdfs/aprende-m2.pdf'
        setPdfUrl(`${import.meta.env.BASE_URL || '/'}${path.split('/').pop()}`)
      }
    })().catch(console.error)
  }, [])

  // Load pages when assignment changes
  useEffect(() => {
    if (!assignmentId) return
    ;(async () => {
      const ps = await listPages(assignmentId)
      setPages(ps)
      const first = ps[0]
      if (first) {
        setPageId(first.id)
        setPageIndex(first.page_index)
      } else {
        setPageId(null)
        setPageIndex(0)
      }
    })().catch(console.error)
  }, [assignmentId])

  // Load latest per student when pageId changes
  useEffect(() => {
    if (!assignmentId || !pageId) { setRows([]); return }
    setLoading(true)
    ;(async () => {
      const data = await listLatestByPage(assignmentId, pageId, STUDENTS)
      setRows(data)
    })()
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [assignmentId, pageId])

  const openReview = async (r: RowView) => {
    let audioUrl: string | undefined = undefined
    if (r.audio?.storage_path) {
      try { audioUrl = await getAudioUrl(r.audio.storage_path) } catch { /* ignore */ }
    }
    setCurrent({ student: r.student_id, strokes: r.strokes?.strokes_json || { strokes: [] }, audioUrl })
    setOpen(true)
  }

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ marginBottom: 12 }}>Teacher Dashboard</h2>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label>
          Assignment:{' '}
          <select
            value={assignmentId ?? ''}
            onChange={e => {
              setAssignmentId(e.target.value || null)
            }}
          >
            {assignments.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </label>

        <label>
          Page:{' '}
          <select
            value={pageId ?? ''}
            onChange={e => {
              const id = e.target.value || null
              setPageId(id)
              const p = pages.find(x => x.id === id)
              setPageIndex(p ? p.page_index : 0)
            }}
          >
            {pages.map(p => <option key={p.id} value={p.id}>{p.page_index + 1}</option>)}
          </select>
        </label>
      </div>

      {/* Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12
        }}
      >
        {STUDENTS.map(stu => {
          const r = rows.find(x => x.student_id === stu) || { student_id: stu, submission: null, strokes: null, audio: null }
          const status = r.submission
            ? (r.strokes?.strokes_json?.strokes?.length ? 'Submitted' : (r.audio ? 'Audio only' : 'Submitted'))
            : 'No work'

          return (
            <div key={stu}
              style={{
                border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff',
                padding: 10, display: 'flex', flexDirection: 'column', gap: 8
              }}
            >
              <div style={{ fontWeight: 700, display: 'flex', justifyContent: 'space-between' }}>
                <span>{stu}</span>
                <span style={{
                  fontSize: 12,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: status === 'Submitted' ? '#DCFCE7' : status === 'Audio only' ? '#DBEAFE' : '#F3F4F6',
                  color: status === 'Submitted' ? '#065F46' : status === 'Audio only' ? '#1E40AF' : '#374151',
                  border: '1px solid #e5e7eb'
                }}>
                  {status}
                </span>
              </div>

              {/* Tiny page preview */}
              <div style={{ position: 'relative', width: '100%', aspectRatio: '4/3', overflow: 'hidden', borderRadius: 8, background:'#fafafa' }}>
                <div style={{ position: 'absolute', inset: 0 }}>
                  <PdfCanvas url={pdfUrl} pageIndex={pageIndex} />
                </div>
              </div>

              <button
                onClick={() => openReview(r as RowView)}
                disabled={!r.submission}
                style={{
                  marginTop: 4, padding: '6px 10px', borderRadius: 8,
                  border: '1px solid #e5e7eb', background: r.submission ? '#f9fafb' : '#f3f4f6'
                }}
              >
                Review
              </button>
            </div>
          )
        })}
      </div>

      {/* Drawer */}
      {open && current &&
        <PlaybackDrawer
          onClose={() => setOpen(false)}
          student={current.student}
          pdfUrl={pdfUrl}
          pageIndex={pageIndex}
          strokesPayload={current.strokes}
          audioUrl={current.audioUrl}
        />
      }

      {loading && <div style={{ marginTop: 12, color: '#6b7280' }}>Loading…</div>}
    </div>
  )
}
