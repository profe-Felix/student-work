// src/pages/teacher/index.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  listAssignments,
  listPages,
  getAudioUrl,
  type AssignmentRow,
  type PageRow,
} from '../../lib/db'
import TeacherSyncBar from '../../components/TeacherSyncBar'
import PdfDropZone from '../../components/PdfDropZone'

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

  useEffect(() => {
    (async () => {
      try {
        const as = await listAssignments()
        setAssignments(as)
        const preferred = as.find(a => a.title === 'Handwriting - Daily') ?? as[0]
        if (preferred) setAssignmentId(preferred.id)
      } catch (e) { console.error('load assignments failed', e) }
    })()
  }, [])

  useEffect(() => {
    if (!assignmentId) return
    (async () => {
      try {
        const ps = await listPages(assignmentId)
        setPages(ps)
        const p0 = ps.find(p => p.page_index === 0) ?? ps[0]
        if (p0) {
          setPageId(p0.id)
          setPageIndex(p0.page_index)
        }
        setGrid({})
      } catch (e) { console.error('load pages failed', e) }
    })()
  }, [assignmentId])

  useEffect(() => {
    if (!pageId) return
    const idx = pages.find(p => p.id === pageId)?.page_index ?? 0
    setPageIndex(idx)
  }, [pageId, pages])

  useEffect(() => {
    if (!assignmentId || !pageId) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const { supabase } = await import('../../lib/db')
        const results = await Promise.all(
          STUDENTS.map(async (sid) => {
            const { data: sub, error } = await supabase
              .from('submissions')
              .select('id, student_id, created_at, artifacts(id,kind,strokes_json,storage_path,created_at)')
              .eq('assignment_id', assignmentId)
              .eq('page_id', pageId)
              .eq('student_id', sid)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            if (error) return [sid, null] as const
            if (!sub) return [sid, null] as const
            const hasStrokes = !!sub.artifacts?.some(a => a.kind === 'strokes' && a.strokes_json)
            const audioArt = sub.artifacts?.find(a => a.kind === 'audio' && a.storage_path)
            let audioUrl: string | undefined
            if (audioArt?.storage_path) {
              try { audioUrl = await getAudioUrl(audioArt.storage_path) } catch {}
            }
            return [sid, { submission_id: sub.id, hasStrokes, audioUrl }] as const
          })
        )
        if (cancelled) return
        const next: Record<string, LatestCell> = {}
        for (const [sid, cell] of results) next[sid] = cell
        setGrid(next)
      } catch (e) {
        console.error('load latest grid failed', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [assignmentId, pageId])

  const currentAssignment = useMemo(
    () => assignments.find(a => a.id === assignmentId) || null,
    [assignments, assignmentId]
  )
  const currentPage = useMemo(
    () => pages.find(p => p.id === pageId) || null,
    [pages, pageId]
  )

  const assignmentPdfPath = currentPage?.pdf_path; // <-- pass to SyncBar

  return (
    <div style={{ padding: 16, minHeight: '100vh', background: '#fafafa' }}>
      <h2 className="text-xl font-semibold">Teacher Dashboard</h2>

      <div style={{ margin: '12px 0' }}>
        <PdfDropZone onCreated={(newId) => {
          setAssignmentId(newId)
          setGrid({})
        }} />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0 8px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Assignment</span>
          <select
            value={assignmentId}
            onChange={(e) => setAssignmentId(e.target.value)}
            style={{ padding: '6px 8px', minWidth: 260 }}
          >
            <option value="">Select…</option>
            {assignments.map(a => (
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
            <option value="">Select…</option>
            {pages.map(p => (
              <option key={p.id} value={p.id}>Pg {p.page_index + 1}</option>
            ))}
          </select>
        </label>

        {loading && <span style={{ color: '#6b7280' }}>Loading…</span>}
      </div>

      {assignmentId && pageId && (
        <TeacherSyncBar
          assignmentId={assignmentId}
          pageId={pageId}
          pageIndex={pageIndex}
          assignmentPdfPath={assignmentPdfPath}   // <-- NEW
          className="sticky top-2 z-10"
        />
      )}

      <div
        style={{
          marginTop: 12,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {STUDENTS.map(sid => {
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

      <div style={{ marginTop: 16, fontSize: 12, color: '#6b7280' }}>
        Assignment: {currentAssignment?.title ?? '—'} • Page: {currentPage ? currentPage.page_index + 1 : '—'}
      </div>
    </div>
  )
}
