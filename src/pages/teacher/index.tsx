// src/pages/teacher/index.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  listAssignments,
  listPages,
  getAudioUrl,
  type AssignmentRow,
  type PageRow,
  supabase,
} from '../../lib/db'
import PdfDropZone from '../../components/PdfDropZone'
import TeacherSyncBar from '../../components/TeacherSyncBar'

type LatestCell = {
  submission_id: string
  hasStrokes: boolean
  audioUrl?: string
} | null

const STUDENTS = Array.from({ length: 28 }, (_, i) => `A_${String(i + 1).padStart(2, '0')}`)

export default function TeacherDashboard() {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentId, setAssignmentId] = useState<string>('')

  const [pages, setPages] = useState<PageRow[]>([])
  const [pageId, setPageId] = useState<string>('')
  const [pageIndex, setPageIndex] = useState<number>(0)

  const [loading, setLoading] = useState(false)
  const [grid, setGrid] = useState<Record<string, LatestCell>>({})
  const refreshDebounce = useRef<number | null>(null)

  useEffect(() => {
    (async () => {
      try {
        const as = await listAssignments()
        setAssignments(as)
        const preferred = as.find((a: AssignmentRow) => a.title === 'Handwriting - Daily') ?? as[0]
        if (preferred) setAssignmentId(preferred.id)
      } catch (e) { console.error('load assignments failed', e) }
    })()
  }, [])

  useEffect(() => {
    if (!assignmentId) return
    ;(async () => {
      try {
        const ps = await listPages(assignmentId)
        setPages(ps)
        const p0 = ps.find((p: PageRow) => p.page_index === 0) ?? ps[0]
        if (p0) { setPageId(p0.id); setPageIndex(p0.page_index) } else { setPageId(''); setPageIndex(0) }
      } catch (e) { console.error('load pages failed', e) }
    })()
  }, [assignmentId])

  useEffect(() => {
    if (!pageId) return
    const p = pages.find((pp: PageRow) => pp.id === pageId)
    if (p) setPageIndex(p.page_index)
  }, [pageId, pages])

  const fetchGrid = useCallback(async () => {
    if (!assignmentId || !pageId) return
    setLoading(true)
    try {
      const nextGrid: Record<string, LatestCell> = {}
      for (let i = 0; i < STUDENTS.length; i += 6) {
        const batch = STUDENTS.slice(i, i + 6)
        const results = await Promise.all(
          batch.map(async (sid: string) => {
            const { supabase } = await import('../../lib/db')
            const { data: sub, error: se } = await supabase
              .from('submissions')
              .select('id, student_id, created_at, artifacts(id,kind,strokes_json,storage_path,created_at)')
              .eq('assignment_id', assignmentId)
              .eq('page_id', pageId)
              .eq('student_id', sid)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (se) return [sid, null] as const
            if (!sub) return [sid, null] as const
            const hasStrokes = !!sub.artifacts?.some((a: any) => a.kind === 'strokes' && a.strokes_json)
            const audioArt = sub.artifacts?.find((a: any) => a.kind === 'audio' && a.storage_path)
            let audioUrl: string | undefined
            if (audioArt?.storage_path) {
              try { audioUrl = await getAudioUrl(audioArt.storage_path) } catch {}
            }
            return [sid, { submission_id: sub.id, hasStrokes, audioUrl }] as const
          })
        )
        for (const pair of results) {
          if (!pair) continue
          const [sid, cell] = pair
          nextGrid[sid] = cell
        }
        setGrid(curr => ({ ...curr, ...nextGrid }))
      }
    } catch (e) {
      console.error('load latest grid failed', e)
    } finally {
      setLoading(false)
    }
  }, [assignmentId, pageId])

  useEffect(() => { void fetchGrid() }, [fetchGrid])

  useEffect(() => {
    if (!assignmentId || !pageId) return
    const ch = supabase.channel(`teacher-grid-${assignmentId}-${pageId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'artifacts',
        filter: `page_id=eq.${pageId}`
      }, () => {
        if (refreshDebounce.current) window.clearTimeout(refreshDebounce.current)
        refreshDebounce.current = window.setTimeout(() => { void fetchGrid() }, 150) as unknown as number
      })
      .subscribe()
    return () => {
      try { supabase.removeChannel(ch) } catch {}
      if (refreshDebounce.current) { window.clearTimeout(refreshDebounce.current); refreshDebounce.current = null }
    }
  }, [assignmentId, pageId, fetchGrid])

  // Seed pages button if this assignment has zero pages
  const [seeding, setSeeding] = useState(false)
  const seedPages = async () => {
    setSeeding(true)
    try {
      const { data: a } = await supabase.from('assignments').select('id,pdf_path').eq('id', assignmentId).maybeSingle()
      const pdfPath = a?.pdf_path as string | undefined
      if (!pdfPath) throw new Error('Assignment has no pdf_path.')
      const pageCount = await countPdfPages(toPublicUrl(pdfPath))
      const rows = Array.from({ length: pageCount }).map((_, i) => ({
        assignment_id: assignmentId,
        page_index: i,
        pdf_path: pdfPath,
      }))
      const { error: pErr } = await supabase.from('pages').insert(rows)
      if (pErr) throw pErr
      const ps = await listPages(assignmentId)
      setPages(ps)
      const p0 = ps.find((p: PageRow) => p.page_index === 0) ?? ps[0]
      if (p0) { setPageId(p0.id); setPageIndex(p0.page_index) }
    } catch (e) {
      console.error(e)
      alert((e as any)?.message || 'Failed to seed pages')
    } finally {
      setSeeding(false)
    }
  }

  // helpers
  const toPublicUrl = (storagePath: string) => {
    const [bucket, ...rest] = storagePath.split('/')
    const path = rest.join('/')
    const { data } = supabase.storage.from(bucket).getPublicUrl(path)
    return data.publicUrl
  }
  async function countPdfPages(url: string): Promise<number> {
    const pdfjs: any = await import('pdfjs-dist/build/pdf')
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.js', import.meta.url).toString()
    const pdf = await pdfjs.getDocument(url).promise
    return pdf.numPages as number
  }

  const currentPage = useMemo(() => pages.find((p: PageRow) => p.id === pageId) || null, [pages, pageId])

  return (
    <div style={{ padding: 16, minHeight: '100vh', background: '#fafafa' }}>
      <h2>Teacher Dashboard</h2>

      <div style={{ margin: '12px 0 18px' }}>
        <PdfDropZone
          onCreated={(newId: string) => {
            setAssignmentId(newId)
            setPageId('')
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0 8px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Assignment</span>
          <select
            value={assignmentId}
            onChange={(e) => { setAssignmentId(e.target.value); setPageId('') }}
            style={{ padding: '6px 8px', minWidth: 260 }}
          >
            {assignments.map((a: AssignmentRow) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Page</span>
          <select
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            style={{ padding: '6px 8px', minWidth: 120 }}
            disabled={!assignmentId}
          >
            {pages.map((p: PageRow) => (
              <option key={p.id} value={p.id}>
                Page {p.page_index + 1}
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={() => void fetchGrid()}
          style={{ padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff' }}
        >
          Refresh
        </button>

        {pages.length === 0 && assignmentId && (
          <button
            onClick={() => void seedPages()}
            disabled={seeding}
            style={{ padding: '6px 10px', border: '1px solid #eab308', borderRadius: 8, background: '#fefce8', color: '#92400e' }}
            title="Backfill pages from the assignment PDF"
          >
            {seeding ? 'Seeding…' : 'Seed pages'}
          </button>
        )}

        {loading && <span style={{ color: '#6b7280' }}>Loading…</span>}
      </div>

      {assignmentId && pageId && (
        <div style={{ position: 'sticky', top: 8, zIndex: 10, marginBottom: 12 }}>
          <TeacherSyncBar
            assignmentId={assignmentId}
            pageId={pageId}
            pageIndex={pageIndex}
            pdfPath={currentPage?.pdf_path ?? null}
          />
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {STUDENTS.map((sid: string) => {
          const cell = grid[sid] ?? null
          const has = !!cell
          return (
            <div key={sid} style={{
              border: '1px solid #e5e7eb',
              borderRadius: 10,
              background: '#fff',
              padding: 12,
              display: 'flex', flexDirection: 'column', gap: 8
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong>{sid}</strong>
                {has ? <span style={{ color: '#059669', fontSize: 12 }}>has work</span>
                     : <span style={{ color: '#6b7280', fontSize: 12 }}>no work</span>}
              </div>

              {has && (
                <>
                  <div style={{ fontSize: 12, color: '#374151' }}>
                    {cell!.hasStrokes ? '✍️ Strokes' : '—'}
                    {cell!.audioUrl ? ' • 🔊 Audio' : ''}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {cell!.audioUrl && (
                      <audio controls src={cell!.audioUrl} style={{ width: '100%' }} />
                    )}
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
