//src/pages/teacher/index.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import {
  listAssignments,
  listPages,
  getAudioUrl,
  type AssignmentRow,
  type PageRow,
  supabase,
  upsertClassState,
} from '../../lib/db'
import TeacherSyncBar from '../../components/TeacherSyncBar'
import PdfDropZone from '../../components/PdfDropZone'
import {
  publishSetAssignment,
  publishSetPage,
  setTeacherPresence,
  teacherPresenceResponder
} from '../../lib/realtime'
import PlaybackDrawer from '../../components/PlaybackDrawer'

type LatestCell = {
  submission_id: string
  hasStrokes: boolean
  audioUrl?: string
} | null

export default function TeacherDashboard() {
  // --- class code from URL (?class=A); default 'A'
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const classCode = (params.get('class') || 'A').toUpperCase()

  // students list is dynamic from classCode
  const STUDENTS = useMemo(
    () => Array.from({ length: 28 }, (_, i) => `${classCode}_${String(i + 1).padStart(2, '0')}`),
    [classCode]
  )

  // shareable /start link with class
  const startHref = useMemo(() => {
    const base = `${window.location.origin}${window.location.pathname}`
    return `${base}#/start?class=${encodeURIComponent(classCode)}`
  }, [classCode])

  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentId, setAssignmentId] = useState<string>('')

  const [pages, setPages] = useState<PageRow[]>([])
  const [pageId, setPageId] = useState<string>('')
  const lastAnnouncedAssignment = useRef<string>('')

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

  // ===== resolve a URL for the current page's PDF (for PlaybackDrawer/PdfCanvas) =====
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
  // ===== END =====

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

  // --- presence responder (answers students' "hello" with current state)
  const stopPresenceResponderRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!assignmentId) return

    if (stopPresenceResponderRef.current) {
      try { stopPresenceResponderRef.current() } catch {}
      stopPresenceResponderRef.current = null
    }
    // CLASS-SCOPED responder
    const stop = teacherPresenceResponder(classCode, assignmentId, () => ({
      autoFollow: true,
      allowedPages: null,
      focusOn: false,
      lockNav: false,
      teacherPageIndex: pageIndex
    }))
    stopPresenceResponderRef.current = stop

    return () => {
      try { stopPresenceResponderRef.current?.() } catch {}
      stopPresenceResponderRef.current = null
    }
  }, [classCode, assignmentId, pageIndex])

  // initial assignment broadcast (CLASS-SCOPED)
  useEffect(() => {
    if (!assignmentId) return
    if (lastAnnouncedAssignment.current === assignmentId) return
    ;(async () => {
      try {
        await publishSetAssignment(classCode, assignmentId)
        lastAnnouncedAssignment.current = assignmentId
      } catch (err) {
        console.error('initial broadcast failed', err)
      }
    })()
  }, [classCode, assignmentId])

  // page + presence broadcast (CLASS-SCOPED)
  useEffect(() => {
    if (!assignmentId) return
    ;(async () => {
      try {
        await publishSetPage(classCode, assignmentId, { pageIndex })
        await setTeacherPresence(classCode, assignmentId, {
          autoFollow: true,
          teacherPageIndex: pageIndex,
          focusOn: false,
          lockNav: false,
          allowedPages: null
        })
      } catch (err) {
        console.error('page/presence broadcast failed', err)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classCode, assignmentId, pageIndex])

  // --- keep DB "class_state" in sync for cold start
  useEffect(() => {
    if (!classCode || !assignmentId || !pageId) return
    upsertClassState(classCode, assignmentId, pageId, pageIndex)
      .catch(err => console.error('upsertClassState failed', err))
  }, [classCode, assignmentId, pageId, pageIndex])

  useEffect(() => {
    if (!assignmentId || !pageId) return
    setGrid({})
    refreshGrid.current('page change')
  }, [assignmentId, pageId, STUDENTS])

  // realtime refreshers
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

      {/* quick share box for /start?class=CODE */}
      <div style={{
        margin: '8px 0 16px', padding: 10, background:'#fff',
        border:'1px solid #e5e7eb', borderRadius:10, display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'
      }}>
        <div style={{ fontSize:12, color:'#374151' }}>Class:</div>
        <strong style={{ fontSize:14 }}>{classCode}</strong>
        <input
          readOnly
          value={startHref}
          style={{ flex:1, minWidth:260, padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:8, background:'#f9fafb' }}
        />
        <button
          onClick={async()=>{ try { await navigator.clipboard.writeText(startHref) } catch {} }}
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
          title="Copy link"
        >
          Copy link
        </button>
        <a
          href={startHref}
          target="_blank"
          rel="noreferrer"
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6', textDecoration:'none', color:'#111' }}
          title="Open start page"
        >
          Open
        </a>
      </div>

      <div style={{ margin: '12px 0 16px' }}>
        <PdfDropZone
          onCreated={async (newId: string, title: string) => {
            // Show it immediately in the dropdown
            setAssignments((prev) => {
              if (prev.some((a) => a.id === newId)) return prev
              return [{ id: newId, title }, ...prev]
            })

            // Select it
            setAssignmentId(newId)

            // Broadcast to students now (CLASS-SCOPED)
            try {
              await publishSetAssignment(classCode, newId)
              lastAnnouncedAssignment.current = newId

              // snapshot to class_state (best effort)
              if (classCode && pageId) {
                await upsertClassState(classCode, newId, pageId, pageIndex)
              }
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
                // CLASS-SCOPED handoff
                await publishSetAssignment(classCode, next)
                lastAnnouncedAssignment.current = next

                // snapshot to class_state (best-effort)
                if (classCode && pageId) {
                  await upsertClassState(classCode, next, pageId, pageIndex)
                }
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
            onChange={async (e) => {
              const nextPageId = e.target.value
              setPageId(nextPageId)

              // upsert immediately with the selected page's index
              try {
                const nextIndex = pages.find(p => p.id === nextPageId)?.page_index ?? pageIndex
                if (classCode && assignmentId) {
                  await upsertClassState(classCode, assignmentId, nextPageId, nextIndex)
                }
                // rebroadcast page for this class (snappy)
                await publishSetPage(classCode, assignmentId, { pageIndex: nextIndex })
                await setTeacherPresence(classCode, assignmentId, {
                  autoFollow: true,
                  teacherPageIndex: nextIndex,
                  focusOn: false,
                  lockNav: false,
                  allowedPages: null
                })
              } catch (err) {
                console.error('upsert/publish on page change failed', err)
              }
            }}
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
{/* IMPORTANT: scope teacher controls to this class */}
<TeacherSyncBar
  classCode={classCode}
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
