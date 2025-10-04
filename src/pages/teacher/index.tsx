// src/pages/teacher/index.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  listAssignments,
  listPages,
  getAudioUrl,
  type AssignmentRow,
  type PageRow,
  supabase
} from '../../lib/db'
import TeacherSyncBar from '../../components/TeacherSyncBar'
import PdfDropZone from '../../components/PdfDropZone'
import {
  publishSetAssignment,
  respondToAssignmentRequests,
  controlSetAssignment,
  // presence + page broadcasting for late joiners
  publishSetPage,
  setTeacherPresence,
  teacherPresenceResponder,
  controlSetPage,
  controlPresence,
} from '../../lib/realtime'
import PlaybackDrawer from '../../components/PlaybackDrawer'

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
  const lastAnnouncedAssignment = useRef<string>('') // prevent double-broadcasts

  const pageIndex = useMemo(
    () => pages.find((p) => p.id === pageId)?.page_index ?? 0,
    [pages, pageId]
  )

  const [loading, setLoading] = useState(false)
  const [grid, setGrid] = useState<Record<string, LatestCell>>({})

  // PREVIEW STATE
  const [previewOpen, setPreviewOpen] = useState(false)
  const [preview, setPreview] = useState<{
    studentId: string
    strokes: any | null
    audioUrl: string | undefined
  } | null>(null)
  const [previewLoadingSid, setPreviewLoadingSid] = useState<string | null>(null)

  // ===== Resolve a URL for the current page's PDF (for PlaybackDrawer/PdfCanvas) =====
  const STORAGE_BUCKET = 'pdfs'
  const [previewPdfUrl, setPreviewPdfUrl] = useState<string>('')

  function keyForBucket(path: string) {
    if (!path) return ''
    let k = path.replace(/^\/+/, '')
    k = k.replace(/^public\//, '')
    k = k.replace(/^pdfs\//, '')
    return k
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const storagePath = pages.find(p => p.id === pageId)?.pdf_path || ''
      if (!storagePath) { setPreviewPdfUrl(''); return }
      const key = keyForBucket(storagePath)
      const { data: sData } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60)
      if (!cancelled && sData?.signedUrl) { setPreviewPdfUrl(sData.signedUrl); return }
      const { data: pData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key)
      if (!cancelled) setPreviewPdfUrl(pData?.publicUrl ?? '')
    })()
    return () => { cancelled = true }
  }, [pageId, pages])
  // ===== END PDF URL resolve =====

  // fetch helper
  const refreshGrid = useRef<(why?: string) => Promise<void>>(async () => {})
  refreshGrid.current = async (_why?: string) => {
    if (!assignmentId || !pageId) return
    setLoading(true)
    try {
      const next: Record<string, LatestCell> = {}
      for (let i = 0; i < STUDENTS.length; i += 6) {
        const batch = STUDENTS.slice(i, i + 6)
        const results: Array<readonly [string, LatestCell] | null> = await Promise.all(
          batch.map(async (sid: string) => {
            const latest = await listLatestByPageForStudent(assignmentId, pageId, sid)
            if (!latest) return [sid, null] as const
            const hasStrokes = !!latest.artifacts?.some(
              (a: any) => a.kind === 'strokes' && a.strokes_json
            )
            const audioArt = latest.artifacts?.find(
              (a: any) => a.kind === 'audio' && a.storage_path
            )
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
          next[sid] = cell
        }
        setGrid((curr) => ({ ...curr, ...next }))
      }
    } catch (e) {
      console.error('refreshGrid failed', e)
    } finally {
      setLoading(false)
    }
  }

  // debounce
  const debTimer = useRef<number | null>(null)
  const debouncedRefresh = (delay = 300) => {
    if (debTimer.current) window.clearTimeout(debTimer.current)
    debTimer.current = window.setTimeout(() => {
      refreshGrid.current('debounced')
    }, delay)
  }

  // initial loads
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

  useEffect(() => {
    if (!assignmentId) return
    ;(async () => {
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

  // After assignmentId is resolved (initial load), broadcast it once.
  useEffect(() => {
    if (!assignmentId) return
    if (lastAnnouncedAssignment.current === assignmentId) return
    ;(async () => {
      try {
        await publishSetAssignment(assignmentId)
        await controlSetAssignment(assignmentId) // control channel mirror
        lastAnnouncedAssignment.current = assignmentId
      } catch (err) {
        console.error('initial broadcast failed', err)
      }
    })()
  }, [assignmentId])

  // Respond to late-joining students who request the current assignment
  useEffect(() => {
    if (!assignmentId) return
    const off = respondToAssignmentRequests(() => assignmentId)
    return () => { try { (off as any)?.() } catch {} }
  }, [assignmentId])

  useEffect(() => {
    if (!assignmentId || !pageId) return
    setGrid({}) // reset grid when page changes
    refreshGrid.current('page change')
  }, [assignmentId, pageId])

  // ============================================================================
  // ROBUST PRESENCE WITHOUT HEARTBEAT
  // ============================================================================

  // Keep latest state in a ref so our responder always returns fresh info
  const latestRef = useRef<{
    assignmentId: string | null
    pageId: string | null
    pageIndex: number
    pdfPath: string | null
  }>({ assignmentId: null, pageId: null, pageIndex: 0, pdfPath: null })

  // Keep latest values synced into the ref
  useEffect(() => {
    const curr = pages.find(p => p.id === pageId) || null
    latestRef.current = {
      assignmentId: assignmentId || null,
      pageId: pageId || null,
      pageIndex,
      pdfPath: curr?.pdf_path ?? null,
    }
  }, [assignmentId, pageId, pageIndex, pages])

  // Install ONE stable responder early. It reads from latestRef each time it's called.
  useEffect(() => {
    if (!assignmentId) return
    const off = teacherPresenceResponder(assignmentId, () => {
      const snap = latestRef.current
      return {
        // required flags (we don't toggle them here; TeacherSyncBar handles changes)
        autoFollow: false,
        focusOn: false,
        lockNav: false,
        allowedPages: null,

        // current page snapshot
        teacherPageIndex: snap.pageIndex ?? 0,

        // enrich so students can render immediately
        assignmentId: snap.assignmentId ?? assignmentId,
        pageId: snap.pageId ?? '',
        pdfPath: snap.pdfPath ?? undefined,
      }
    })
    return off
  }, [assignmentId])

  // One-time presence kick + page broadcast as soon as we have a page
  const initialKickSent = useRef(false)
  useEffect(() => {
    if (!assignmentId || !pageId) return
    if (initialKickSent.current) return
    ;(async () => {
      try {
        const curr = pages.find(p => p.id === pageId)
        const pdfPath = curr?.pdf_path || undefined

        // Seed everyone with current page (even if it "didn't change")
        await publishSetPage(assignmentId, { pageIndex, pageId, pdfPath })
        await controlSetPage({ pageIndex, pageId, pdfPath })

        // Presence snapshot (flags false so it won't fight focus UI)
        await setTeacherPresence(assignmentId, {
          teacherPageIndex: pageIndex,
          autoFollow: false,
          focusOn: false,
          lockNav: false,
          allowedPages: null,
        })

        // Instant control presence pulse (no interval)
        await controlPresence({
          teacherAlive: true,
          assignmentId,
          pageId,
          pageIndex,
          pdfPath,
          ts: Date.now(),
        })
        initialKickSent.current = true
      } catch (e) {
        console.warn('initial presence/page kick failed', e)
      }
    })()
  }, [assignmentId, pageId, pageIndex, pages])

  // Also broadcast page/presence whenever the page actually changes
  useEffect(() => {
    if (!assignmentId) return
    ;(async () => {
      try {
        const curr = pages.find(p => p.id === pageId)
        const pdfPath = curr?.pdf_path || undefined

        await publishSetPage(assignmentId, { pageIndex, pageId, pdfPath })
        await controlSetPage({ pageIndex, pageId, pdfPath })
        await setTeacherPresence(assignmentId, {
          teacherPageIndex: pageIndex,
          autoFollow: false,
          focusOn: false,
          lockNav: false,
          allowedPages: null,
        })

        // A single pulse here ensures late listeners snap promptly without a heartbeat
        await controlPresence({
          teacherAlive: true,
          assignmentId,
          pageId,
          pageIndex,
          pdfPath,
          ts: Date.now(),
        })
      } catch (e) {
        console.warn('page/presence broadcast failed', e)
      }
    })()
  }, [assignmentId, pageIndex, pageId, pages])

  // ============================================================================
  // realtime refreshers for teacher grid (unchanged)
  // ============================================================================
  useEffect(() => {
    if (!pageId) return

    const ch1 = supabase.channel(`tgrid-subs-${pageId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'submissions',
        filter: `page_id=eq.${pageId}`
      }, () => debouncedRefresh(200))
      .subscribe()

    const ch2 = supabase.channel(`tgrid-arts`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'artifacts'
      }, () => debouncedRefresh(300))
      .subscribe()

    return () => {
      supabase.removeChannel(ch1)
      supabase.removeChannel(ch2)
      if (debTimer.current) { window.clearTimeout(debTimer.current); debTimer.current = null }
    }
  }, [pageId])

  // helper: get latest with artifacts per student for this page
  async function listLatestByPageForStudent(assignment_id: string, page_id: string, student_id: string) {
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
      artifacts: Array<{
        id: string
        kind: string
        strokes_json?: unknown
        storage_path?: string
        created_at: string
      }>
    } | null
  }

  // PREVIEW LOADER
  async function openPreviewForStudent(sid: string) {
    if (!assignmentId || !pageId) return
    setPreviewLoadingSid(sid)
    try {
      const latest = await listLatestByPageForStudent(assignmentId, pageId, sid)
      if (!latest) {
        alert('No submission yet for this student on this page.')
        return
      }
      const strokesArt = latest.artifacts?.find(a => a.kind === 'strokes' && (a as any).strokes_json) as any | undefined
      const audioArt = latest.artifacts?.find(a => a.kind === 'audio' && a.storage_path)

      let audioUrl: string | undefined = undefined
      if (audioArt?.storage_path) {
        try {
          audioUrl = await getAudioUrl(audioArt.storage_path)
        } catch (e) {
          console.warn('getAudioUrl failed', e)
          audioUrl = undefined
        }
      }

      setPreview({
        studentId: sid,
        strokes: strokesArt?.strokes_json ?? null,
        audioUrl
      })
      setPreviewOpen(true)
    } catch (e) {
      console.error('openPreviewForStudent failed', e)
      alert('Failed to load preview.')
    } finally {
      setPreviewLoadingSid(null)
    }
  }

  // Render
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

      <div style={{ margin: '12px 0 16px' }}>
        <PdfDropZone
          onCreated={async (newId: string, title: string) => {
            setAssignments((prev) => {
              if (prev.some((a) => a.id === newId)) return prev
              return [{ id: newId, title }, ...prev]
            })
            setAssignmentId(newId)

            try {
              await publishSetAssignment(newId)
              await controlSetAssignment(newId)
              lastAnnouncedAssignment.current = newId
            } catch (err) {
              console.error('broadcast onCreated failed', err)
            }
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0 8px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Assignment</span>
          <select
            value={assignmentId}
            onChange={async (e) => {
              const next = e.target.value
              setAssignmentId(next)
              try {
                await publishSetAssignment(next)
                await controlSetAssignment(next)
                lastAnnouncedAssignment.current = next
              } catch (err) {
                console.error('broadcast assignment change failed', err)
              }
            }}
            style={{ padding: '6px 8px', minWidth: 260 }}
          >
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
            {pages.map(p => (
              <option key={p.id} value={p.id}>
                Page {p.page_index + 1}
              </option>
            ))}
          </select>
        </label>

        {loading && <span style={{ color: '#6b7280' }}>Loading…</span>}
        <button
          onClick={() => refreshGrid.current('manual')}
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
          title="Force refresh"
        >
          Refresh
        </button>
      </div>

      {assignmentId && pageId && (
        <div style={{ position: 'sticky', top: 8, zIndex: 10, marginBottom: 12 }}>
          <TeacherSyncBar
            assignmentId={assignmentId}
            pageId={pageId}
            pageIndex={pageIndex}
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
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    {cell!.audioUrl && (
                      <audio controls src={cell!.audioUrl} style={{ width: '100%' }} />
                    )}
                    <button
                      type="button"
                      onClick={() => openPreviewForStudent(sid)}
                      disabled={previewLoadingSid === sid}
                      style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', whiteSpace: 'nowrap' }}
                      title="Preview latest submission"
                    >
                      {previewLoadingSid === sid ? 'Loading…' : 'Preview'}
                    </button>
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

      {previewOpen && (
        <PlaybackDrawer
          onClose={() => setPreviewOpen(false)}
          student={preview?.studentId ?? ''}
          pdfUrl={previewPdfUrl}
          pageIndex={currentPage?.page_index ?? 0}
          strokesPayload={(preview?.strokes as any) ?? {}}
          audioUrl={preview?.audioUrl}
        />
      )}
    </div>
  )
}
