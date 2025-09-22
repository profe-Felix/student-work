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

type LatestCell = {
  submission_id: string
  hasStrokes: boolean
  audioUrl?: string
} | null

// Simple roster: A_01..A_28
const STUDENTS = Array.from({ length: 28 }, (_, i) => `A_${String(i + 1).padStart(2, '0')}`)

export default function TeacherDashboard() {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentId, setAssignmentId] = useState<string>('')

  const [pages, setPages] = useState<PageRow[]>([])
  const [pageId, setPageId] = useState<string>('')

  const [loading, setLoading] = useState(false)
  const [grid, setGrid] = useState<Record<string, LatestCell>>({}) // key = student_id

  // Load assignments on mount
  useEffect(() => {
    (async () => {
      try {
        const as = await listAssignments()
        setAssignments(as)
        const preferred = as.find(a => a.title === 'Handwriting - Daily') ?? as[0]
        if (preferred) setAssignmentId(preferred.id)
      } catch (e) {
        console.error('load assignments failed', e)
      }
    })()
  }, [])

  // When assignment changes, load its pages and pick first page
  useEffect(() => {
    if (!assignmentId) return
    (async () => {
      try {
        const ps = await listPages(assignmentId)
        setPages(ps)
        const p0 = ps.find(p => p.page_index === 0) ?? ps[0]
        if (p0) setPageId(p0.id)
      } catch (e) {
        console.error('load pages failed', e)
      }
    })()
  }, [assignmentId])

  // Helper: fetch latest submission for a specific student on this page
  async function listLatestByPageForStudent(assignment_id: string, page_id: string, student_id: string) {
    const { supabase } = await import('../../lib/db')
    const { data: sub, error: se } = await supabase
      .from('submissions')
      .select('id, student_id, created_at, artifacts(id,kind,strokes_json,storage_path,created_at)')
      .eq('assignment_id', assignment_id)
      .eq('page_id', page_id)
      .eq('student_id', student_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (se) {
      console.error('per-student latest fetch error', se)
      return null
    }
    return sub as unknown as {
      id: string
      student_id: string
      created_at: string
      artifacts: { id: string; kind: string; strokes_json: any; storage_path: string | null; created_at: string }[]
    } | null
  }

  // Load latest per student for the selected page
  useEffect(() => {
    if (!assignmentId || !pageId) return
    let cancelled = false
    setGrid({}) // clear grid when switching
    setLoading(true)

    ;(async () => {
      try {
        const nextGrid: Record<string, LatestCell> = {}

        // fetch in small batches
        for (let i = 0; i < STUDENTS.length; i += 6) {
          const batch = STUDENTS.slice(i, i + 6)
          const results = await Promise.all(
            batch.map(async (sid) => {
              const latest = await listLatestByPageForStudent(assignmentId, pageId, sid)
              if (!latest) return [sid, null] as const

              const hasStrokes = !!latest.artifacts?.some(a => a.kind === 'strokes' && a.strokes_json)
              const audioArt = latest.artifacts?.find(a => a.kind === 'audio' && a.storage_path)
              let audioUrl: string | undefined
              if (audioArt?.storage_path) {
                try { audioUrl = await getAudioUrl(audioArt.storage_path) } catch {}
              }
              return [sid, { submission_id: latest.id, hasStrokes, audioUrl }] as const
            })
          )

          for (const pair of results) {
            if (!pair) continue
            const [sid, cell] = pair
            nextGrid[sid] = cell
          }
          if (cancelled) return
          setGrid(curr => ({ ...curr, ...nextGrid }))
        }
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

  return (
    <div style={{ padding: 16, minHeight: '100vh', background: '#fafafa' }}>
      <h2>Teacher Dashboard</h2>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0 16px' }}>
        {/* Assignment select */}
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Assignment</span>
          <select
            value={assignmentId}
            onChange={(e) => setAssignmentId(e.target.value)}
            style={{ padding: '6px 8px', minWidth: 260 }}
          >
            {assignments.map((a) => (
              <option key={a.id} value={a.id}>{a.title}</option>
            ))}
          </select>
        </label>

        {/* Page select */}
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Page</span>
          <select
            value={pageId}
            onChange={(e) => setPageId(e.target.value)}
            style={{ padding: '6px 8px', minWidth: 120 }}
          >
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                Page {p.page_index + 1}
              </option>
            ))}
          </select>
        </label>

        {loading && <span style={{ color: '#6b7280' }}>Loading…</span>}
      </div>

      {/* Sync bar */}
      {assignmentId && pageId && (
        <div style={{ position: 'sticky', top: 8, zIndex: 10, marginBottom: 12 }}>
          <TeacherSyncBar
            assignmentId={assignmentId}
            pageId={pageId}
            pageIndex={currentPage?.page_index ?? 0}
            assignmentPdfPath={currentPage?.pdf_path ?? null}  {/* ✅ renamed prop */}
          />
        </div>
      )}

      {/* Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {STUDENTS.map((sid) => {
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

      {/* Footnote */}
      <div style={{ marginTop: 16, fontSize: 12, color: '#6b7280' }}>
        Assignment: {currentAssignment?.title ?? '—'} • Page: {currentPage ? currentPage.page_index + 1 : '—'}
      </div>
    </div>
  )
}
