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
  upsertTeacherState, // DB "truth" students can poll
} from '../../lib/db'
import TeacherSyncBar from '../../components/TeacherSyncBar'
import PdfDropZone from '../../components/PdfDropZone'
import {
  publishSetAssignment,
  teacherPresenceResponder, // ✅ RESTORED: replies to 'hello' with presence-snapshot
  broadcastForceSubmit,
} from '../../lib/realtime'
import PlaybackDrawer from '../../components/PlaybackDrawer'

// 🔎 realtime meter
import { enableRealtimeMeter, logRealtimeUsage } from '../../lib/rtMeter'

// colors policy (DB bootstrap + realtime persistence)
import type { PostgrestSingleResponse, AuthChangeEvent, Session } from '@supabase/supabase-js'

// Supabase Realtime channel status union (local copy)
type ChannelStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'

type LatestCell = {
  submission_id: string
  hasStrokes: boolean
  audioUrl?: string
  mediaCount?: number
} | null

// ──────────────────────────────────────────────────────────────────────────────
// ONE-TIME SAFETY: normalize stroke payloads to { strokes:[{ pts:[{x,y,t?}] }] }
// ──────────────────────────────────────────────────────────────────────────────
function normalizeStrokeShape(payload: any) {
  try {
    if (typeof payload === 'string') payload = JSON.parse(payload)
  } catch {
    return { strokes: [], media: [] }
  }
  const media = Array.isArray(payload?.media) ? payload.media : []
  if (!payload || !Array.isArray(payload.strokes)) {
    return { strokes: [], media }
  }
  return {
    strokes: payload.strokes.map((s: any) => ({
      color: s?.color,
      size: s?.size,
      tool: s?.tool,
      pts: Array.isArray(s?.pts) ? s.pts : (Array.isArray(s?.points) ? s.points : []),
    })),
    media,
  }
}

export default function TeacherDashboard() {
  useEffect(() => { enableRealtimeMeter() }, [])

  // Hard switch to disable *all* DB writes when you're not signed in
  const ALLOW_DB_WRITES = false

  // ── AUTH: keep a flag but force false unless you flip ALLOW_DB_WRITES
  const [authed, setAuthed] = useState(false)
  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      if (alive) setAuthed(ALLOW_DB_WRITES && !!data.session)
    })()
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_evt: AuthChangeEvent, session: Session | null) => {
        setAuthed(ALLOW_DB_WRITES && !!session)
      }
    )
    return () => { sub.subscription.unsubscribe(); alive = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Local teacher UI state (mirrors what students should see)
  const [focusOn, setFocusOn] = useState<boolean>(false)
  const [autoFollow, setAutoFollow] = useState<boolean>(true)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)

  // NEW — teacher color policy (mirrors DB + rebroadcasts)
  const [allowColors, setAllowColors] = useState<boolean>(true)
  const colorChanRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const colorReadyRef = useRef<Promise<void> | null>(null) // gate sends until SUBSCRIBED

  const lastAnnouncedAssignment = useRef<string>('')

  const pageIndex = useMemo(
    () => pages.find((p) => p.id === pageId)?.page_index ?? 0,
    [pages, pageId]
  )

  const [loading, setLoading] = useState(false)
  const [grid, setGrid] = useState<Record<string, LatestCell>>({})

  // NEW: UI busy flags
  const [forcing, setForcing] = useState(false)
  const [changingPage, setChangingPage] = useState(false)

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

  // ── colors: table write (best-effort; skip if anon)
  async function persistAllowColors(next: boolean) {
    if (!authed) return
    if (!classCode || !assignmentId) return
    try {
      await supabase
        .from('teacher_state')
        .upsert(
          {
            class_code: classCode,
            assignment_id: assignmentId,
            page_index: pages.find((p) => p.id === pageId)?.page_index ?? 0,
            focus_on: !!focusOn,
            auto_follow: !!autoFollow,
            allowed_pages: allowedPages ?? null,
            allow_colors: !!next, // <── the new column
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'assignment_id' }
        )
    } catch (e) {
      // non-fatal; students still get realtime broadcast
      console.warn('persistAllowColors failed (non-fatal)', e)
    }
  }

  // ── colors: warm a channel that receives own broadcasts (self:true), with SUBSCRIBED gate
  function ensureColorChannel() {
    if (colorChanRef.current) return colorChanRef.current
    if (!assignmentId) return null
    const name = `colors:${classCode}:${assignmentId}`
    const ch = supabase.channel(name, { config: { broadcast: { ack: false, self: true } } })

    colorReadyRef.current = new Promise<void>((resolve) => {
      ch.subscribe((status: ChannelStatus) => {
        if (status === 'SUBSCRIBED') resolve()
      })
    })

    colorChanRef.current = ch
    return ch
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
        strokes_json?: any
        storage_path?: string
        created_at: string
      }>
    } | null
  }

  // ===== Dashboard grid refresh (batched) =====
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

            const strokesArt = latest.artifacts?.find(
              (a: any) => a.kind === 'strokes' && a.strokes_json
            ) as any | undefined

            const hasStrokes = !!strokesArt

            // Prefer audio from strokes_json.media
            let audioUrl: string | undefined
            let mediaCount = 0
            const mediaIn = (strokesArt?.strokes_json && Array.isArray(strokesArt.strokes_json.media))
              ? (strokesArt.strokes_json.media as Array<{ url?: string }>)
              : []

            mediaCount = mediaIn.length

            if (mediaIn.length > 0 && typeof mediaIn[0]?.url === 'string' && mediaIn[0]!.url) {
              audioUrl = mediaIn[0]!.url
            } else {
              const audioArt = latest.artifacts?.find(
                (a: any) => a.kind === 'audio' && a.storage_path
              )
              if (audioArt?.storage_path) {
                try { audioUrl = await getAudioUrl(audioArt.storage_path) } catch {}
              }
            }

            return [sid, { submission_id: latest.id, hasStrokes, audioUrl, mediaCount }] as const
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

  // initial loads: assignments, then pages
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

  // ===== Presence paths students rely on =====

  // 1) CLASS-SCOPED handoff (assignment id) + initial teacher_state + teacher_presence row
  const lastAnnounced = lastAnnouncedAssignment
  useEffect(() => {
    if (!assignmentId) return
    if (lastAnnounced.current === assignmentId) return
    ;(async () => {
      try {
        await publishSetAssignment(classCode, assignmentId)
        lastAnnounced.current = assignmentId
        // DB writes disabled when not authed
        if (authed && ALLOW_DB_WRITES) {
          await safeUpsertTeacherState()
          await safeUpsertTeacherPresenceRow()
        }
      } catch (err) {
        console.error('initial announce / teacher_state write failed', err)
      }
    })()
  }, [classCode, assignmentId, authed])

  // 2) Keep DB "class_state" in sync for cold start
  useEffect(() => {
    if (!authed || !ALLOW_DB_WRITES) return
    if (!classCode || !assignmentId || !pageId) return
    upsertClassState(classCode, assignmentId, pageId, pageIndex)
      .catch(err => console.error('upsertClassState failed', err))
  }, [classCode, assignmentId, pageId, pageIndex, authed])

  // 3) Presence responder: answers student 'hello' with a presence-snapshot
  useEffect(() => {
    if (!assignmentId) return
    const stop = teacherPresenceResponder(classCode, assignmentId, () => ({
      autoFollow: !!autoFollow,
      focusOn: !!focusOn,
      lockNav: !!focusOn,            // lock nav when focused; simple heuristic
      allowedPages: allowedPages ?? null,
      teacherPageIndex: pageIndex,
    }))
    return () => { try { stop?.() } catch {} }
  }, [classCode, assignmentId, autoFollow, focusOn, allowedPages, pageIndex])

  // 4) Also write through to teacher_presence whenever key state changes
  useEffect(() => {
    if (!assignmentId || !authed || !ALLOW_DB_WRITES) return
    ;(async () => {
      await safeUpsertTeacherState()
      await safeUpsertTeacherPresenceRow()
    })()
  }, [assignmentId, pageIndex, autoFollow, focusOn, allowedPages, authed])

  // ── BOOTSTRAP colors from DB, then rebroadcast for students
  useEffect(() => {
    let cancelled = false
    if (!classCode || !assignmentId) return

    ;(async () => {
      try {
        const dbVal = await (async () => {
          if (!authed || !ALLOW_DB_WRITES) return true // default when anon
          const resp: PostgrestSingleResponse<any> = await supabase
            .from('teacher_state')
            .select('allow_colors')
            .eq('class_code', classCode)
            .eq('assignment_id', assignmentId)
            .order('updated_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          return (resp?.data && typeof resp.data.allow_colors === 'boolean')
            ? !!resp.data.allow_colors
            : true
        })()

        if (!cancelled) setAllowColors(dbVal)

        const ch = ensureColorChannel()
        // wait until SUBSCRIBED before sending to avoid REST fallback warning
        await (colorReadyRef.current ?? Promise.resolve())
        if (ch) {
          await ch.send({ type: 'broadcast', event: 'set-allow-colors', payload: { allow: dbVal, ts: Date.now() } })
        }
      } catch (e) {
        // if fetch fails, keep default true and still broadcast that
        const ch = ensureColorChannel()
        await (colorReadyRef.current ?? Promise.resolve())
        if (ch) {
          await ch.send({ type: 'broadcast', event: 'set-allow-colors', payload: { allow: true, ts: Date.now() } })
        }
      }
    })()

    return () => { cancelled = true }
  }, [classCode, assignmentId, authed])

  // ── LISTEN for color policy changes (including our own) and persist to DB
  useEffect(() => {
    if (!assignmentId) return
    const ch = ensureColorChannel()
    if (!ch) return

    ch.on('broadcast', { event: 'set-allow-colors' }, async (msg: any) => {
      const allow = msg?.payload?.allow !== false
      setAllowColors(allow)
      if (authed && ALLOW_DB_WRITES) {
        await persistAllowColors(allow)
      }
    })

    return () => {
      try { ch.unsubscribe() } catch {}
      colorChanRef.current = null
    }
  }, [classCode, assignmentId, authed])

  // ===== Grid + realtime watchers =====
  useEffect(() => {
    if (!assignmentId || !pageId) return
    setGrid({})
    refreshGrid.current('page change')
  }, [assignmentId, pageId, STUDENTS])

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

  // --- Teacher state writers (single row; no broadcast fanout)
  async function safeUpsertTeacherState(optional?: Partial<{ pageIndex: number; focusOn: boolean; autoFollow: boolean; allowedPages: number[] | null }>) {
    if (!authed || !ALLOW_DB_WRITES) return
    if (!classCode || !assignmentId) return
    const idx = (optional?.pageIndex ?? pageIndex)
    const f   = (optional?.focusOn ?? focusOn)
    const af  = (optional?.autoFollow ?? autoFollow)
    const ap  = (optional?.allowedPages ?? allowedPages)
    try {
      await upsertTeacherState({
        classCode,
        assignmentId,
        pageIndex: idx,
        focusOn: f,
        autoFollow: af,
        allowedPages: ap,
      })
    } catch (e) {
      console.error('upsertTeacherState failed', e)
    }
  }

  // NEW: Write-through row that students' fetchPresenceSnapshot() reads
  async function safeUpsertTeacherPresenceRow() {
    if (!authed || !ALLOW_DB_WRITES) return
    if (!classCode || !assignmentId) return
    try {
      await supabase
        .from('teacher_presence')
        .upsert({
          assignment_id: assignmentId,
          class_code: classCode,
          teacher_page_index: pageIndex,
          focus_on: focusOn,
          lock_nav: !!focusOn,           // match responder heuristic
          auto_follow: autoFollow,
          allowed_pages: allowedPages ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'assignment_id,class_code' }) // ← composite target
    } catch (e) {
      // Non-fatal
      console.warn('upsert teacher_presence failed', e)
    }
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

      // Prefer audio from strokes_json.media (new path)
      let audioUrl: string | undefined = undefined
      const mediaIn = (strokesArt?.strokes_json && Array.isArray(strokesArt.strokes_json.media))
        ? (strokesArt.strokes_json.media as Array<{ url?: string }>)
        : []

      if (mediaIn.length > 0 && typeof mediaIn[0]?.url === 'string' && mediaIn[0]!.url) {
        audioUrl = mediaIn[0]!.url
      } else {
        // Legacy fallback: separate audio artifact
        const audioArt = latest.artifacts?.find(a => a.kind === 'audio' && a.storage_path)
        if (audioArt?.storage_path) {
          try {
            audioUrl = await getAudioUrl(audioArt.storage_path)
          } catch (e) {
            console.warn('getAudioUrl failed', e)
            audioUrl = undefined
          }
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
            setAssignments((prev) => {
              if (prev.some((a) => a.id === newId)) return prev
              return [{ id: newId, title }, ...prev]
            })
            setAssignmentId(newId)

            try {
              await publishSetAssignment(classCode, newId)
              lastAnnounced.current = newId

              if (authed && ALLOW_DB_WRITES) {
                await safeUpsertTeacherState()
                await safeUpsertTeacherPresenceRow()
              }

              if (classCode && pageId && authed && ALLOW_DB_WRITES) {
                await upsertClassState(classCode, newId, pageId, pageIndex)
              }
            } catch (err) {
              console.error('broadcast onCreated failed', err)
            }
          }}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '8px 0 8px', flexWrap:'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          <span style={{ marginBottom: 4, color: '#555' }}>Assignment</span>
          <select
            value={assignmentId}
            onChange={async (e) => {
              const next = e.target.value
              setAssignmentId(next)
              try {
                await publishSetAssignment(classCode, next)
                lastAnnounced.current = next
                if (authed && ALLOW_DB_WRITES) {
                  await safeUpsertTeacherState()
                  await safeUpsertTeacherPresenceRow()
                }
                if (classCode && pageId && authed && ALLOW_DB_WRITES) {
                  await upsertClassState(classCode, next, pageId, pageIndex)
                }
              } catch (err) {
                console.error('assignment change failed', err)
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
              if (!assignmentId) return
              const nextPageId = e.target.value
              const nextIndex = pages.find(p => p.id === nextPageId)?.page_index ?? pageIndex

              setChangingPage(true)
              try {
                await broadcastForceSubmit(classCode, assignmentId, {
                  reason: 'page-change',
                  pageIndex: nextIndex
                })

                setPageId(nextPageId)

                if (classCode && authed && ALLOW_DB_WRITES) {
                  await upsertClassState(classCode, assignmentId, nextPageId, nextIndex)
                }

                if (authed && ALLOW_DB_WRITES) {
                  await safeUpsertTeacherState({ pageIndex: nextIndex })
                  await safeUpsertTeacherPresenceRow()
                }
              } catch (err) {
                console.error('submit-before-switch / upsertTeacherState failed', err)
              } finally {
                setChangingPage(false)
              }
            }}
            style={{ padding: '6px 8px', minWidth: 120 }}
            disabled={!assignmentId || changingPage}
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

        {/* 🔎 NEW: Show realtime usage table in console */}
        <button
          onClick={() => {
            const rows = logRealtimeUsage(`RT usage — class ${classCode}`)
            alert(`Realtime events counted: ${rows.length}. Open the console to view the table.`)
          }}
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
          title="Print a per-channel/event send/recv table to the console"
        >
          Show RT usage
        </button>

        {/* Rare realtime: Force submit button (all students) */}
        <button
          onClick={async () => {
            if (!assignmentId) return
            setForcing(true)
            try {
              await broadcastForceSubmit(classCode, assignmentId, { reason: 'teacher-button' })
            } catch (err) {
              console.error('force submit broadcast failed', err)
              alert('Failed to force submit.')
            } finally {
              setForcing(false)
            }
          }}
          disabled={!assignmentId || forcing}
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}
          title="Ask every student to immediately submit what they have"
        >
          {forcing ? 'Submitting…' : 'Force submit all'}
        </button>
      </div>

      {/* Only render TeacherSyncBar when DB writes are allowed */}
      {assignmentId && pageId && authed && ALLOW_DB_WRITES && (
        <div style={{ position: 'sticky', top: 8, zIndex: 10, marginBottom: 12 }}>
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
                    {cell!.mediaCount ? ` • 🔊 ${cell!.mediaCount} audio${cell!.mediaCount > 1 ? 's' : ''}` : ''}
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
          strokesPayload={preview?.strokes ? normalizeStrokeShape(preview.strokes) : { strokes: [] }}
          audioUrl={preview?.audioUrl}
        />
      )}
    </div>
  )
}
