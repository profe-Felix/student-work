// src/pages/student/assignment.tsx
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle, StrokesPayload } from '../../components/DrawCanvas'
import type { RemoteStrokeUpdate } from '../../components/DrawCanvas'
import AudioRecorder, { AudioRecorderHandle } from '../../components/AudioRecorder'
import {
  createSubmission, saveStrokes, saveAudio, loadLatestSubmission,
  listPages,
  supabase,
  fetchClassState,
} from '../../lib/db'
import {
  subscribeToAssignment,
  type SetPagePayload,
  type FocusPayload,
  type AutoFollowPayload,
  subscribeToGlobal,
  type TeacherPresenceState,
  // room-scoped ink helpers
  subscribeToInk,
  publishInk
} from '../../lib/realtime'

// Eraser utils
import type { Pt } from '../../lib/geometry'
import { objectErase, softErase } from '../../lib/erase'

/** Constants */
const assignmentTitle = 'Handwriting - Daily' // legacy purge helper
const AUTO_SUBMIT_ON_PAGE_CHANGE = true
const DRAFT_INTERVAL_MS = 4000
const POLL_MS = 5000
const ERASE_RADIUS_BASE = 10

/* ---------- Colors ---------- */
const CRAYOLA_24 = [
  { name:'Red',hex:'#EE204D' },{ name:'Yellow',hex:'#FCE883' },
  { name:'Blue',hex:'#1F75FE' },{ name:'Green',hex:'#1CAC78' },
  { name:'Orange',hex:'#FF7538' },{ name:'Purple',hex:'#926EAE' },
  { name:'Black',hex:'#000000' },{ name:'White',hex:'#FFFFFF' },
  { name:'Brown',hex:'#B4674D' },{ name:'Pink',hex:'#FFBCD9' },
  { name:'Gray',hex:'#95918C' },{ name:'Violet',hex:'#7F00FF' },
  { name:'Red-Orange',hex:'#FF5349' },{ name:'Yellow-Orange',hex:'#FFB653' },
  { name:'Yellow-Green',hex:'#C5E384' },{ name:'Blue-Green',hex:'#0095B7' },
  { name:'Blue-Violet',hex:'#7366BD' },{ name:'Red-Violet',hex:'#C0448F' },
  { name:'Cerulean',hex:'#1DACD6' },{ name:'Indigo',hex:'#4F69C6' },
  { name:'Scarlet',hex:'#FC2847' },{ name:'Magenta',hex:'#F664AF' },
  { name:'Peach',hex:'#FFCBA4' },{ name:'Tan',hex:'#ECE1D3' },
]
const SKIN_TONES = [
  { name:'Ultra Light',hex:'#FDE6D0' },{ name:'Very Light',hex:'#F5D2B8' },
  { name:'Light',hex:'#EDC3A6' },{ name:'Light-Medium',hex:'#E5B294' },
  { name:'Medium',hex:'#D9A07F' },{ name:'Medium-Tan',hex:'#C88B6B' },
  { name:'Tan',hex:'#B97B5E' },{ name:'Medium-Deep',hex:'#A86A4E' },
  { name:'Deep',hex:'#94583F' },{ name:'Very Deep',hex:'#7C4936' },
  { name:'Rich Deep',hex:'#643B2C' },{ name:'Ultra Deep',hex:'#4E2F24' },
]

type Tool = 'pen'|'highlighter'|'eraser'|'eraserObject'

/* ---------- Keys & helpers (now namespaced by CLASS + assignmentId + pageId) ---------- */
const ASSIGNMENT_CACHE_KEY = 'currentAssignmentId'
// CLASS-SCOPED presence cache
const presenceKey = (classCode: string, assignmentId:string)=> `presence:${classCode}:${assignmentId}`

const draftKey      = (student:string, assignmentUid:string, pageUid:string)=> `draft:${student}:${assignmentUid}:${pageUid}`
const lastHashKey   = (student:string, assignmentUid:string, pageUid:string)=> `lastHash:${student}:${assignmentUid}:${pageUid}`
const submittedKey  = (student:string, assignmentUid:string, pageUid:string)=> `submitted:${student}:${assignmentUid}:${pageUid}`

function normalizeStrokes(data: unknown): StrokesPayload {
  if (!data || typeof data !== 'object') return { strokes: [] }
  const arr = Array.isArray((data as any).strokes) ? (data as any).strokes : []
  return { strokes: arr }
}

function saveDraft(student:string, assignmentUid:string, pageUid:string, strokes:any){
  try { localStorage.setItem(draftKey(student, assignmentUid, pageUid), JSON.stringify({ t: Date.now(), strokes })) } catch {}
}
function loadDraft(student:string, assignmentUid:string, pageUid:string){
  try { const raw = localStorage.getItem(draftKey(student, assignmentUid, pageUid)); return raw ? JSON.parse(raw) : null } catch { return null }
}
function clearDraft(student:string, assignmentUid:string, pageUid:string){
  try { localStorage.removeItem(draftKey(student, assignmentUid, pageUid)) } catch {}
}
function saveSubmittedCache(student:string, assignmentUid:string, pageUid:string, strokes:any){
  try { localStorage.setItem(submittedKey(student, assignmentUid, pageUid), JSON.stringify({ t: Date.now(), strokes })) } catch {}
}
function loadSubmittedCache(student:string, assignmentUid:string, pageUid:string){
  try { const raw = localStorage.getItem(submittedKey(student, assignmentUid, pageUid)); return raw ? JSON.parse(raw) : null } catch { return null }
}
function clearSubmittedCache(student:string, assignmentUid:string, pageUid:string){
  try { localStorage.removeItem(submittedKey(student, assignmentUid, pageUid)) } catch {}
}

async function hashStrokes(strokes:any): Promise<string> {
  const enc = new TextEncoder().encode(JSON.stringify(strokes || {}))
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')
}

function Toast({ text, kind }:{ text:string; kind:'ok'|'err' }){
  return (
    <div style={{
      position:'fixed', left:'50%', bottom:24, transform:'translateX(-50%)',
      background: kind==='ok' ? '#047857' : '#b91c1c',
      color:'#fff', padding:'10px 14px', borderRadius:12,
      fontWeight:600, boxShadow:'0 6px 16px rgba(0,0,0,0.25)', zIndex: 20000,
      maxWidth:'80vw', textAlign:'center'
    }}>
      {text}
    </div>
  )
}

/* ---------- find newest assignment with at least one page (fallback) ---------- */
async function fetchLatestAssignmentIdWithPages(): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('assignments')
      .select('id, created_at')
      .order('created_at', { ascending: false })
      .limit(5)

    if (error || !data || data.length === 0) return null

    for (const row of data) {
      try {
        const pages = await listPages(row.id)
        if (pages && pages.length > 0) return row.id
      } catch {/* skip if pages lookup fails */}
    }
    return null
  } catch {
    return null
  }
}

/* ---------- initial page index from cached presence (best effort) ---------- */
function initialPageIndexFromPresence(classCode: string): number {
  try {
    const cachedAssignmentId = localStorage.getItem(ASSIGNMENT_CACHE_KEY) || ''
    if (!cachedAssignmentId) return 0
    const raw = localStorage.getItem(presenceKey(classCode, cachedAssignmentId))
    if (!raw) return 0
    const p = JSON.parse(raw) as TeacherPresenceState
    if (p && p.autoFollow && typeof p.teacherPageIndex === 'number') {
      return p.teacherPageIndex
    }
  } catch {/* ignore */}
  return 0
}

/* ---------- server fallback to get teacher presence snapshot ---------- */
async function fetchPresenceSnapshot(assignmentId: string): Promise<TeacherPresenceState | null> {
  try {
    const { data, error } = await supabase
      .from('teacher_presence')
      .select('*')
      .eq('assignment_id', assignmentId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error || !data) return null
    const p = data as any
    const snapshot: TeacherPresenceState = {
      autoFollow: !!p.auto_follow || !!p.autofollow || !!p.autoFollow,
      allowedPages: Array.isArray(p.allowed_pages) ? p.allowed_pages : (p.allowedPages ?? null),
      focusOn: !!p.focus_on || !!p.focusOn,
      lockNav: !!p.lock_nav || !!p.lockNav,
      teacherPageIndex: typeof p.teacher_page_index === 'number'
        ? p.teacher_page_index
        : (typeof p.teacherPageIndex === 'number' ? p.teacherPageIndex : undefined),
    }
    return snapshot
  } catch {
    return null
  }
}

export default function StudentAssignment(){
  const location = useLocation()
  const nav = useNavigate()

  // class code from URL (?class=), default A
  const classCode = useMemo(() => {
    const qs = new URLSearchParams(location.search)
    return (qs.get('class') || 'A').toUpperCase()
  }, [location.search])

  // remember last student per-class; default `${classCode}_01`
  const studentId = useMemo(() => {
    const qs = new URLSearchParams(location.search)
    const q = qs.get('student')
    const key = `currentStudent:${classCode}`
    const remembered = (() => { try { return localStorage.getItem(key) } catch { return null } })()
    const id = q || remembered || `${classCode}_01`
    try { localStorage.setItem(key, id) } catch {}
    return id
  }, [location.search, classCode])

  // pdf path resolved from DB page row
  const [pdfStoragePath, setPdfStoragePath] = useState<string>('')

  // PDF URL for PdfCanvas
  const [pdfUrl, setPdfUrl] = useState<string>('')
  const [hasTask, setHasTask] = useState<boolean>(false)
  const STORAGE_BUCKET = 'pdfs'
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
      if (!pdfStoragePath) { if (!cancelled){ setPdfUrl(''); setHasTask(false) } return }
      const key = keyForBucket(pdfStoragePath)
      const { data: sData } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60)
      if (!cancelled && sData?.signedUrl) { setPdfUrl(sData.signedUrl); setHasTask(true); return }
      const { data: pData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key)
      if (!cancelled) { const ok=!!pData?.publicUrl; setPdfUrl(pData?.publicUrl ?? ''); setHasTask(ok) }
    })()
    return () => { cancelled = true }
  }, [pdfStoragePath])

  /* ---------- start page using cached teacher presence if any ---------- */
  const [pageIndex, setPageIndex]   = useState<number>(initialPageIndexFromPresence(classCode))
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true)
  const [tool, setTool] = useState<Tool>('pen')
  const [saving, setSaving] = useState(false)
  const submitInFlight = useRef(false)

  // toolbar side (persisted)
  const [toolbarOnRight, setToolbarOnRight] = useState<boolean>(()=>{ try{ return localStorage.getItem('toolbarSide')!=='left' }catch{return true} })

  const drawRef = useRef<DrawCanvasHandle>(null)
  const audioRef = useRef<AudioRecorderHandle>(null)
  const audioBlob = useRef<Blob|null>(null)

  const [toast, setToast] = useState<{ msg:string; kind:'ok'|'err' }|null>(null)
  const toastTimer = useRef<number|null>(null)
  const showToast = (msg:string, kind:'ok'|'err'='ok', ms=1500)=>{
    setToast({ msg, kind })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(()=> setToast(null), ms)
  }
  useEffect(()=>()=>{ if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

  const onPdfReady = (_pdf:any, canvas:HTMLCanvasElement)=>{
    try {
      const cssW = Math.round(parseFloat(getComputedStyle(canvas).width))
      const cssH = Math.round(parseFloat(getComputedStyle(canvas).height))
      setCanvasSize({ w: cssW, h: cssH })
    } catch {/* ignore */}
  }

  // assignment/page ids for realtime
  const currIds = useRef<{assignment_id?:string, page_id?:string}>({})

  // Persist assignment id from teacher (or DB fallback)
  // IMPORTANT: start empty; we'll set it from class snapshot or teacher handoff.
  // This avoids preloading a stale "last drag & drop" assignment.
  const [rtAssignmentId, setRtAssignmentId] = useState<string>('')

  // flag to sequence boot: wait for class snapshot before using "latest"
  const [classBootDone, setClassBootDone] = useState(false)

  // >>> One-time purge of legacy local caches that used the static title
  useEffect(() => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)!
        if (!k) continue
        if (
          (k.startsWith('draft:') || k.startsWith('submitted:') || k.startsWith('lastHash:')) &&
          k.split(':')[2] === assignmentTitle
        ) {
          localStorage.removeItem(k)
        }
      }
    } catch {}
  }, [])

  // Helper: stable cache ids (assignmentUid + pageUid)
  const getCacheIds = (pageId?: string) => {
    const assignmentUid = rtAssignmentId || currIds.current.assignment_id || 'no-assignment'
    const pageUid = pageId || currIds.current.page_id || `page-${pageIndex}`
    return { assignmentUid, pageUid }
  }

  // Realtime teacher controls
  const [focusOn, setFocusOn] = useState(false)
  const [navLocked, setNavLocked] = useState(false)
  const [autoFollow, setAutoFollow] = useState(false)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)
  const teacherPageIndexRef = useRef<number | null>(null)

  // snap-once flag
  const initialSnappedRef = useRef(false)

  // hashes/dirty tracking
  const lastAppliedServerHash = useRef<string>('')
  const lastLocalHash = useRef<string>('')
  const localDirty = useRef<boolean>(false)
  const dirtySince = useRef<number>(0)
  const justSavedAt = useRef<number>(0)

  // === UPDATED: ink subscription handle (unsubscribe-only type to avoid TS mismatch)
  const inkSubRef = useRef<{ unsubscribe?: () => void } | null>(null)

  /* ---------- apply a presence snapshot and (optionally) snap ---------- */
  const applyPresenceSnapshot = (p: TeacherPresenceState | null | undefined, opts?: { snap?: boolean }) => {
    if (!p) return
    setAutoFollow(!!p.autoFollow)
    setAllowedPages(p.allowedPages ?? null)
    setFocusOn(!!p.focusOn)
    setNavLocked(!!p.focusOn && !!p.lockNav)
    if (typeof p.teacherPageIndex === 'number') {
      teacherPageIndexRef.current = p.teacherPageIndex
      const shouldSnap = (opts?.snap ?? true) && !!p.autoFollow && !initialSnappedRef.current
      if (shouldSnap) {
        setPageIndex(p.teacherPageIndex)
        initialSnappedRef.current = true
      }
    }
  }

  // --- helper: snap to teacher using local presence if available (CLASS-SCOPED)
  const snapToTeacherIfAvailable = (assignmentId: string) => {
    try {
      const raw = localStorage.getItem(presenceKey(classCode, assignmentId))
      if (!raw) return
      const p = JSON.parse(raw) as TeacherPresenceState
      applyPresenceSnapshot(p, { snap: true })
    } catch {/* ignore */}
  }

  // --- ensure we also fetch presence from server if cache is missing/stale (store CLASS-SCOPED)
  const ensurePresenceFromServer = async (assignmentId: string) => {
    const cached = localStorage.getItem(presenceKey(classCode, assignmentId))
    if (!cached) {
      const p = await fetchPresenceSnapshot(assignmentId)
      if (p) {
        try { localStorage.setItem(presenceKey(classCode, assignmentId), JSON.stringify(p)) } catch {}
        applyPresenceSnapshot(p, { snap: true })
      }
    }
  }

  // assignment handoff listener (teacher broadcast) — CLASS-SCOPED
  useEffect(() => {
    if (!classCode) return
    const off = subscribeToGlobal(classCode, (nextAssignmentId) => {
      try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, nextAssignmentId) } catch {}
      setRtAssignmentId(nextAssignmentId)
      // Best effort: use cache quickly, then fetch from server to be sure
      snapToTeacherIfAvailable(nextAssignmentId)
      ensurePresenceFromServer(nextAssignmentId)
      currIds.current = {}
      // keep initialSnappedRef as-is (only set inside applyPresenceSnapshot)
    })
    return off
  }, [classCode])

  // Snap to DB class state on boot (cold start) — then mark boot done
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await fetchClassState(classCode)
        if (!snap || cancelled) { setClassBootDone(true); return }

        setRtAssignmentId(snap.assignment_id)
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, snap.assignment_id) } catch {}

        if (typeof snap.page_index === 'number') {
          // We allow presence to override later; this is just a nicer first render.
          setPageIndex(snap.page_index)
        }
      } catch {
        // no class snapshot yet — harmless
      } finally {
        if (!cancelled) setClassBootDone(true)
      }
    })()
    return () => { cancelled = true }
  }, [classCode])

  // On first mount fallback: only after class boot finished and we still have no id
  useEffect(() => {
    if (!classBootDone) return
    if (rtAssignmentId) {
      snapToTeacherIfAvailable(rtAssignmentId)
      ensurePresenceFromServer(rtAssignmentId)
      return
    }
    ;(async () => {
      const latest = await fetchLatestAssignmentIdWithPages()
      if (latest) {
        setRtAssignmentId(latest)
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, latest) } catch {}
        snapToTeacherIfAvailable(latest)
        ensurePresenceFromServer(latest)
      }
    })()
  }, [classBootDone, rtAssignmentId])

  // hydrate presence on refresh (if cached) — CLASS-SCOPED
  useEffect(() => {
    if (!rtAssignmentId) return
    try {
      const raw = localStorage.getItem(presenceKey(classCode, rtAssignmentId))
      if (raw) {
        const p = JSON.parse(raw) as TeacherPresenceState
        applyPresenceSnapshot(p, { snap: true })
      } else {
        // No cache? Pull from server now.
        ;(async () => {
          const p = await fetchPresenceSnapshot(rtAssignmentId)
          if (p) {
            try { localStorage.setItem(presenceKey(classCode, rtAssignmentId), JSON.stringify(p)) } catch {}
            applyPresenceSnapshot(p, { snap: true })
          }
        })()
      }
    } catch {}
  }, [classCode, rtAssignmentId])

  /* ---------- Hello → presence-snapshot handshake (CLASS-SCOPED channel) ---------- */
  useEffect(() => {
    if (!rtAssignmentId) return
    const ch = supabase
      .channel(`assignment:${classCode}:${rtAssignmentId}`, { config: { broadcast: { ack: true } } })
      .on('broadcast', { event: 'presence-snapshot' }, (msg: any) => {
        const p = msg?.payload as TeacherPresenceState | undefined
        if (!p) return
        try { localStorage.setItem(presenceKey(classCode, rtAssignmentId), JSON.stringify(p)) } catch {}
        applyPresenceSnapshot(p, { snap: true })
      })
      .subscribe()

    ;(async () => {
      try {
        await ch.send({ type: 'broadcast', event: 'hello', payload: { ts: Date.now() } })
      } catch {/* ignore */}
    })()

    const t = window.setTimeout(() => { try { ch.unsubscribe() } catch {} }, 4000)
    return () => { try { ch.unsubscribe() } catch {}; window.clearTimeout(t) }
  }, [classCode, rtAssignmentId])

  // Resolve assignment/page with early “snap to teacher” if autoFollow is ON or presence says so
  async function resolveIds(): Promise<{ assignment_id: string, page_id: string } | null> {
    // 1) Ensure we have an assignment id
    let assignmentId = rtAssignmentId
    if (!assignmentId) {
      assignmentId = await fetchLatestAssignmentIdWithPages() || ''
      if (assignmentId) {
        setRtAssignmentId(assignmentId)
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, assignmentId) } catch {}
        snapToTeacherIfAvailable(assignmentId)
        await ensurePresenceFromServer(assignmentId)
      }
    }

    if (!assignmentId) {
      // No assignment found → clear UI
      currIds.current = {}
      setPdfStoragePath('')
      setHasTask(false)
      return null
    }

    // 2) Try to honor teacher presence (don’t bail early)
    snapToTeacherIfAvailable(assignmentId)
    await ensurePresenceFromServer(assignmentId) // no-op if already cached

    // Decide the target index we want to display now
    let targetIndex = pageIndex
    const tpi = teacherPageIndexRef.current
    if (autoFollow && typeof tpi === 'number') {
      targetIndex = tpi
      // keep UI page number in sync; but do NOT return early
      if (pageIndex !== tpi) setPageIndex(tpi)
    }

    // 3) Fetch pages for the resolved assignment
    let pages = await listPages(assignmentId).catch(() => [] as any[])
    if (!pages || pages.length === 0) {
      // fallback: maybe class switched after we started; pick latest with pages
      const latest = await fetchLatestAssignmentIdWithPages()
      if (latest && latest !== assignmentId) {
        assignmentId = latest
        setRtAssignmentId(latest)
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, latest) } catch {}
        snapToTeacherIfAvailable(latest)
        await ensurePresenceFromServer(latest)
        pages = await listPages(latest).catch(() => [] as any[])
      }
    }

    if (!pages || pages.length === 0) {
      currIds.current = {}
      setPdfStoragePath('')
      setHasTask(false)
      return null
    }

    // 4) Pick the page using the targetIndex (teacher if autoFollow) with sane fallbacks
    const curr =
      pages.find(p => p.page_index === targetIndex) ??
      pages.find(p => p.page_index === pageIndex) ??
      pages[0]

    // If the chosen page differs from current UI index, sync it — but continue
    if (typeof curr.page_index === 'number' && curr.page_index !== pageIndex) {
      setPageIndex(curr.page_index)
    }

    // 5) Finalize IDs and PDF path (this is what was missing on “snap”)
    currIds.current = { assignment_id: assignmentId, page_id: curr.id }
    setPdfStoragePath(curr.pdf_path || '')
    setHasTask(!!curr.pdf_path)

    return { assignment_id: assignmentId, page_id: curr.id }
  }

  /* ---------- Page load: clear, then draft → server → cache ---------- */
  useEffect(()=>{
    // Gate until class snapshot resolution completes AND we know the assignment
    if (!classBootDone || !rtAssignmentId) return

    let cancelled=false
    try { drawRef.current?.clearStrokes(); audioRef.current?.stop() } catch {}

    ;(async ()=>{
      const ids = await resolveIds()

      if (!ids) {
        const { assignmentUid, pageUid } = getCacheIds()
        try {
          drawRef.current?.clearStrokes()
          clearDraft(studentId, assignmentUid, pageUid)
          clearSubmittedCache(studentId, assignmentUid, pageUid)
          lastLocalHash.current = ''
          lastAppliedServerHash.current = ''
          localDirty.current = false
        } catch {}
        return
      }

      const { assignmentUid, pageUid } = getCacheIds(ids.page_id)

      try{
        const draft = loadDraft(studentId, assignmentUid, pageUid)
        if (draft?.strokes) {
          const norm = normalizeStrokes(draft.strokes)
          try { drawRef.current?.loadStrokes(norm) } catch {}
          try { lastLocalHash.current = await hashStrokes(norm) } catch {}
        } else {
          lastLocalHash.current = ''
        }

        try {
          const latest = await loadLatestSubmission(ids.assignment_id, ids.page_id, studentId)
          if (!cancelled && latest) {
            const strokes = latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
            const norm = normalizeStrokes(strokes)
            if (Array.isArray(norm.strokes) && norm.strokes.length > 0) {
              const h = await hashStrokes(norm)
              if (!localDirty.current) {
                drawRef.current?.loadStrokes(norm)
                lastAppliedServerHash.current = h
                lastLocalHash.current = h
              }
            } else if (!draft?.strokes) {
              const cached = loadSubmittedCache(studentId, assignmentUid, pageUid)
              if (cached?.strokes) {
                const normC = normalizeStrokes(cached.strokes)
                drawRef.current?.loadStrokes(normC)
                lastLocalHash.current = await hashStrokes(normC)
              }
            }
          }
        } catch {/* ignore */}
      }catch(e){
        console.error('init load failed', e)
        const { assignmentUid, pageUid } = getCacheIds(ids?.page_id)
        const cached = loadSubmittedCache(studentId, assignmentUid, pageUid)
        if (cached?.strokes) {
          const norm = normalizeStrokes(cached.strokes)
          try { drawRef.current?.loadStrokes(norm); lastLocalHash.current = await hashStrokes(norm) } catch {}
        }
      }
    })()

    return ()=>{ cancelled=true }
  }, [classBootDone, pageIndex, studentId, rtAssignmentId, autoFollow])

  /* ---------- Local dirty watcher ---------- */
  useEffect(()=>{
    let id: number | null = null
    const tick = async ()=>{
      try {
        const data = drawRef.current?.getStrokes()
        if (!data) return
        const h = await hashStrokes(data)
        if (h !== lastLocalHash.current) {
          localDirty.current = true
          dirtySince.current = Date.now()
          lastLocalHash.current = h
          const { assignmentUid, pageUid } = getCacheIds()
          saveDraft(studentId, assignmentUid, pageUid, data)
        }
      } catch {}
    }
    id = window.setInterval(tick, 800)
    return ()=>{ if (id!=null) window.clearInterval(id) }
  }, [pageIndex, studentId])

  /* ---------- Draft autosave (coarse) ---------- */
  useEffect(()=>{
    let lastSerialized = ''
    let running = !document.hidden
    let intervalId: number | null = null
    const tick = ()=>{
      try {
        if (!running) return
        const data = drawRef.current?.getStrokes()
        if (!data) return
        const s = JSON.stringify(data)
        if (s !== lastSerialized) {
          const { assignmentUid, pageUid } = getCacheIds()
          saveDraft(studentId, assignmentUid, pageUid, data)
          lastSerialized = s
        }
      } catch {}
    }
    const start = ()=>{ if (intervalId==null){ intervalId = window.setInterval(tick, DRAFT_INTERVAL_MS) } }
    const stop  = ()=>{ if (intervalId!=null){ window.clearInterval(intervalId); intervalId=null } }
    const onVis = ()=>{ running = !document.hidden; if (running) start(); else stop() }
    document.addEventListener('visibilitychange', onVis)
    start()
    const onBeforeUnload = ()=>{
      try {
        const data = drawRef.current?.getStrokes()
        if (data) {
          const { assignmentUid, pageUid } = getCacheIds()
          saveDraft(studentId, assignmentUid, pageUid, data)
        }
      } catch {}
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return ()=>{
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onBeforeUnload as any)
    }
  }, [pageIndex, studentId])

  /* ---------- Submit (dirty-check) + cache ---------- */
  const submit = async ()=>{
    if (!hasTask) return
    if (submitInFlight.current) return
    submitInFlight.current = true
    try{
      setSaving(true)
      const strokes = drawRef.current?.getStrokes() || { strokes: [] }
      const hasInk   = Array.isArray(strokes?.strokes) && strokes.strokes.length > 0
      const hasAudio = !!audioBlob.current
      if (!hasInk && !hasAudio) { setSaving(false); submitInFlight.current=false; return }

      const encHash = await hashStrokes(strokes)
      const ids = currIds.current
      if (!ids.assignment_id || !ids.page_id) { setSaving(false); submitInFlight.current=false; return }

      const { assignmentUid, pageUid } = getCacheIds(ids.page_id)
      const lastKey = lastHashKey(studentId, assignmentUid, pageUid)
      const last = localStorage.getItem(lastKey)
      if (last && last === encHash && !hasAudio) { setSaving(false); submitInFlight.current=false; return }

      const submission_id = await createSubmission(studentId, ids.assignment_id!, ids.page_id!)

      if (hasInk) {
        // Save strokes with the canvas size so previews can scale correctly
        const strokesWithCanvas = { ...strokes, w: canvasSize.w, h: canvasSize.h }
        await saveStrokes(submission_id, strokesWithCanvas)
        localStorage.setItem(lastKey, encHash)
        saveSubmittedCache(studentId, assignmentUid, pageUid, strokes)
        lastAppliedServerHash.current = encHash
        lastLocalHash.current = encHash
        localDirty.current = false
      }
      if (hasAudio) {
        await saveAudio(submission_id, audioBlob.current!)
        audioBlob.current = null
      }

      const ids2 = currIds.current
      const uid2 = getCacheIds(ids2.page_id)
      clearDraft(studentId, uid2.assignmentUid, uid2.pageUid)
      showToast('Saved!', 'ok', 1200)
      justSavedAt.current = Date.now()
    } catch (e:any){
      console.error(e); showToast('Save failed', 'err', 1800)
    } finally {
      setSaving(false)
      submitInFlight.current = false
    }
  }

  const blockedBySync = (idx: number) => {
    if (!autoFollow) return false
    if (allowedPages && allowedPages.length > 0) return !allowedPages.includes(idx)
    const tpi = teacherPageIndexRef.current
    if (typeof tpi === 'number') return idx !== tpi
    return true
  }

  const goToPage = async (nextIndex:number)=>{
    if (!hasTask) return
    if (nextIndex < 0) return
    if (navLocked || blockedBySync(nextIndex)) return
    try { audioRef.current?.stop() } catch {}

    const current = drawRef.current?.getStrokes() || { strokes: [] }
    const hasInk   = Array.isArray(current.strokes) && current.strokes.length > 0
    const hasAudio = !!audioBlob.current

    if (AUTO_SUBMIT_ON_PAGE_CHANGE && (hasInk || hasAudio)) {
      try { await submit() } catch {
        const { assignmentUid, pageUid } = getCacheIds()
        try { saveDraft(studentId, assignmentUid, pageUid, current) } catch {}
      }
    } else {
      const { assignmentUid, pageUid } = getCacheIds()
      try { saveDraft(studentId, assignmentUid, pageUid, current) } catch {}
    }

    setPageIndex(nextIndex)
  }

  // two-finger pan host
  const scrollHostRef = useRef<HTMLDivElement|null>(null)
  useEffect(()=>{
    const host=scrollHostRef.current; if(!host) return
    let pan=false, startY=0, startX=0, startT=0, startL=0
    const onTS=(e:TouchEvent)=>{ if(e.touches.length>=2 && !handMode){ pan=true; const [t1,t2]=[e.touches[0],e.touches[1]]; startY=(t1.clientY+t2.clientY)/2; startX=(t1.clientX+t2.clientX)/2; startT=host.scrollTop; startL=host.scrollLeft } }
    const onTM=(e:TouchEvent)=>{ if(pan && e.touches.length>=2){ e.preventDefault(); const [t1,t2]=[e.touches[0],e.touches[1]]; const y=(t1.clientY+t2.clientY)/2, x=(t1.clientX+t2.clientX)/2; host.scrollTop=startT-(y-startY); host.scrollLeft=startL-(x-startX) } }
    const end=()=>{ pan=false }
    host.addEventListener('touchstart',onTS,{passive:true,capture:true})
    host.addEventListener('touchmove', onTM,{passive:false,capture:true})
    host.addEventListener('touchend',  end,{passive:true,capture:true})
    host.addEventListener('touchcancel',end,{passive:true,capture:true})
    return ()=>{ host.removeEventListener('touchstart',onTS as any,true); host.removeEventListener('touchmove',onTM as any,true); host.removeEventListener('touchend',end as any,true); host.removeEventListener('touchcancel',end,{capture:true} as any) }
  }, [handMode])

  const flipToolbarSide = ()=> {
    setToolbarOnRight(r=>{ const next=!r; try{ localStorage.setItem('toolbarSide', next?'right':'left') }catch{}; return next })
  }

  /* ---------- Realtime + polling (defensive) ---------- */

  // subscribe to teacher broadcast once we know the assignment id — CLASS-SCOPED
  useEffect(() => {
    if (!rtAssignmentId) return
    const ch = subscribeToAssignment(classCode, rtAssignmentId, {
      onSetPage: ({ pageIndex: tpi }: SetPagePayload) => {
        teacherPageIndexRef.current = tpi
        if (autoFollow && typeof tpi === 'number') {
          setPageIndex(prev => (prev !== tpi ? tpi : prev))
        }
      },
      onFocus: ({ on, lockNav }: FocusPayload) => {
        setFocusOn(!!on)
        setNavLocked(!!on && !!lockNav)
      },
      onAutoFollow: ({ on, allowedPages, teacherPageIndex }: AutoFollowPayload) => {
        setAutoFollow(!!on)
        setAllowedPages(allowedPages ?? null)
        if (typeof teacherPageIndex === 'number') teacherPageIndexRef.current = teacherPageIndex
        // Snap once on join if not already snapped
        applyPresenceSnapshot({
          autoFollow: !!on,
          allowedPages: allowedPages ?? null,
          focusOn, // leave focus state as-is here; focus events come via onFocus / onPresence
          lockNav: navLocked,
          teacherPageIndex: teacherPageIndexRef.current ?? undefined
        } as TeacherPresenceState, { snap: true })
      },
      onPresence: (p: TeacherPresenceState) => {
        try { localStorage.setItem(presenceKey(classCode, rtAssignmentId), JSON.stringify(p)) } catch {}
        applyPresenceSnapshot(p, { snap: true })
      }
    })
    return () => { try { ch?.unsubscribe?.() } catch {} }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classCode, rtAssignmentId, autoFollow, focusOn, navLocked])

  const reloadFromServer = async ()=>{
    if (!hasTask) return
    if (Date.now() - (justSavedAt.current || 0) < 1200) return
    if (localDirty.current && (Date.now() - (dirtySince.current || 0) < 5000)) return

    try{
      const ids = currIds.current
      if (!ids.assignment_id || !ids.page_id) return

      const latest = await loadLatestSubmission(ids.assignment_id!, ids.page_id!, studentId)
      const strokesPayload = latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
      const normalized = normalizeStrokes(strokesPayload)

      const hasServerInk = Array.isArray(normalized?.strokes) && normalized.strokes.length > 0
      if (!hasServerInk) return

      const serverHash = await hashStrokes(normalized)
      if (serverHash === lastAppliedServerHash.current) return

      if (!localDirty.current) {
        drawRef.current?.loadStrokes(normalized)
        const { assignmentUid, pageUid } = getCacheIds(ids.page_id)
        saveSubmittedCache(studentId, assignmentUid, pageUid, normalized)
        lastAppliedServerHash.current = serverHash
        lastLocalHash.current = serverHash
      }
    } catch {/* ignore */}
  }

// subscribe to artifacts AND the class-scoped live ink channel
  useEffect(()=>{
    let cleanupArtifacts: (()=>void) | null = null
    let pollId: number | null = null
    let mounted = true

    ;(async ()=>{
      const ids = await resolveIds()
      if (!ids) return

      // live submissions polling
      try{
        const ch = supabase.channel(`art-strokes-${ids.page_id}`)
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'artifacts',
            filter: `page_id=eq.${ids.page_id},kind=eq.strokes`
          }, ()=> reloadFromServer())
          .subscribe()
        cleanupArtifacts = ()=> { try { ch.unsubscribe() } catch {} }
      }catch(e){
        console.error('realtime subscribe failed', e)
      }
      pollId = window.setInterval(()=> { if (mounted) reloadFromServer() }, POLL_MS)

      // CLASS-SCOPED realtime ink (class + assignment + page)
      try { inkSubRef.current?.unsubscribe?.() } catch {}
      const onInk = (u: any) => {
        if (u.tool !== 'pen' && u.tool !== 'highlighter') return
        if ((!Array.isArray(u.pts) || u.pts.length === 0) && !u.done) return
        drawRef.current?.applyRemote({
          id: u.id,
          color: u.color!,
          size: u.size!,
          tool: u.tool as 'pen'|'highlighter',
          pts: (u.pts as any) || [],
          done: !!u.done,
        })
      }
      // Use class-scoped overload; cast to any to satisfy TS overload
      const chInk = (subscribeToInk as any)(classCode, ids.assignment_id, ids.page_id, onInk)
      inkSubRef.current = chInk
    })()

    return ()=> {
      mounted = false
      if (cleanupArtifacts) cleanupArtifacts()
      if (pollId!=null) window.clearInterval(pollId)
      try { inkSubRef.current?.unsubscribe?.() } catch {}
      inkSubRef.current = null
    }
  }, [classCode, studentId, pageIndex, rtAssignmentId])


  /* ---------- LIVE eraser overlay ---------- */
  const eraserActive = hasTask && !handMode && (tool === 'eraser' || tool === 'eraserObject')
  const erasingRef = useRef(false)
  const erasePathRef = useRef<Pt[]>([])
  const eraseBaseRef = useRef<StrokesPayload>({ strokes: [] })
  const rafScheduled = useRef(false)
  const dynamicRadius = Math.max(ERASE_RADIUS_BASE, Math.round(size * 0.9))

  const addPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const last = erasePathRef.current[erasePathRef.current.length - 1]
    if (!last || (Math.hypot(x - last.x, y - last.y) >= 2)) {
      erasePathRef.current.push({ x, y, t: Date.now() })
    }
  }

  const computePreview = () => {
    const base = eraseBaseRef.current
    const path = erasePathRef.current
    if (!base?.strokes || path.length < 2) return base
    if (tool === 'eraserObject') {
      const { kept } = objectErase(base.strokes as any, path, dynamicRadius)
      return { strokes: kept as any }
    } else {
      const trimmed = softErase(base.strokes as any, path, dynamicRadius)
      return { strokes: trimmed as any }
    }
  }

  const schedulePreview = () => {
    if (rafScheduled.current) return
    rafScheduled.current = true
    requestAnimationFrame(() => {
      rafScheduled.current = false
      const next = computePreview()
      if (next) drawRef.current?.loadStrokes(next)
    })
  }

  const onErasePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!eraserActive) return
    erasingRef.current = true
    erasePathRef.current = []
    const current = drawRef.current?.getStrokes() || { strokes: [] }
    eraseBaseRef.current = normalizeStrokes(current)
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId) } catch {}
    addPoint(e)
    schedulePreview()
  }
  const onErasePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!eraserActive || !erasingRef.current) return
    addPoint(e)
    schedulePreview()
  }
  const onErasePointerUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (!erasingRef.current) return
    erasingRef.current = false
    addPoint(e)
    const final = computePreview()
    erasePathRef.current = []
    if (!final) return
    drawRef.current?.loadStrokes(final)
    localDirty.current = true
    try { lastLocalHash.current = await hashStrokes(final) } catch {}
    const { assignmentUid, pageUid } = getCacheIds()
    saveDraft(studentId, assignmentUid, pageUid, final)
  }

  /* ---------- UI ---------- */
  const Toolbar = (
    <div
      style={{
        position:'fixed', right: toolbarOnRight?8:undefined, left: !toolbarOnRight?8:undefined, top:'50%', transform:'translateY(-50%)',
        zIndex:10010, width:120, maxHeight:'80vh',
        display:'flex', flexDirection:'column', gap:10,
        padding:10, background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, boxShadow:'0 6px 16px rgba(0,0,0,0.15)',
        WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none', overflow:'hidden'
      }}
      onTouchStart={(e)=> e.stopPropagation()}
    >
      <div style={{ display:'flex', gap:6 }}>
        <button onClick={flipToolbarSide} title="Flip toolbar side"
          style={{ flex:1, background:'#f3f4f6', border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 0' }}>⇄</button>
        <button onClick={()=>setHandMode(m=>!m)}
          style={{ flex:1, background: handMode?'#f3f4f6':'#34d399', color: handMode?'#111827':'#064e3b',
            border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 0', fontWeight:600 }}>
          {handMode ? '✋' : '✍️'}
        </button>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
        {[
          {label:'Pen',  icon:'✏️', val:'pen'},
          {label:'Hi',   icon:'🖍️', val:'highlighter'},
          {label:'Erase',icon:'🧽', val:'eraser'},
          {label:'Obj',  icon:'🗑️', val:'eraserObject'},
        ].map(t=>(
          <button key={t.val} onClick={()=>setTool(t.val as Tool)}
            style={{ padding:'6px 0', borderRadius:8, border:'1px solid #ddd',
              background: tool===t.val ? '#111' : '#fff', color: tool===t.val ? '#fff' : '#111' }}
            title={t.label}>{t.icon}</button>
        ))}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
        {[{label:'S',val:3},{label:'M',val:6},{label:'L',val:10}].map(s=>(
          <button key={s.label} onClick={()=>setSize(s.val)}
            style={{ padding:'6px 0', borderRadius:8, border:'1px solid #ddd',
              background: size===s.val ? '#111' : '#fff', color: size===s.val ? '#fff' : '#111' }}>
            {s.label}
          </button>
        ))}
        <button onClick={()=>drawRef.current?.undo()}
          style={{ gridColumn:'span 3', padding:'6px 0', borderRadius:8, border:'1px solid #ddd', background:'#fff' }}>⟲ Undo</button>
      </div>

      <div style={{ overflowY:'auto', overflowX:'hidden', paddingRight:4, maxHeight:'42vh' }}>
        <div style={{ fontSize:12, fontWeight:600, margin:'6px 0 4px' }}>Crayons</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 40px)', gap:8 }}>
          {CRAYOLA_24.map(c=>(
            <button key={c.hex} onClick={()=>{ setTool('pen'); setColor(c.hex) }}
              style={{ width:40, height:40, borderRadius:10, border: color===c.hex?'3px solid #111':'2px solid #ddd', background:c.hex }} />
          ))}
        </div>
        <div style={{ fontSize:12, fontWeight:600, margin:'10px 0 4px' }}>Skin</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 40px)', gap:8 }}>
          {SKIN_TONES.map(c=>(
            <button key={c.hex} onClick={()=>{ setTool('pen'); setColor(c.hex) }}
              style={{ width:40, height:40, borderRadius:10, border: color===c.hex?'3px solid #111':'2px solid #ddd', background:c.hex }} />
          ))}
        </div>
      </div>

      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        <AudioRecorder ref={audioRef} maxSec={180} onBlob={(b)=>{ audioBlob.current = b }} />
        <button onClick={submit}
          style={{ background: saving ? '#16a34a' : '#22c55e', opacity: saving?0.8:1,
            color:'#fff', padding:'8px 10px', borderRadius:10, border:'none' }} disabled={saving || !hasTask}>
          {saving ? 'Saving…' : 'Submit'}
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', padding:12, paddingBottom:12,
      ...(toolbarOnRight ? { paddingRight:130 } : { paddingLeft:130 }),
      background:'#fafafa', WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <h2>Student Assignment</h2>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ padding:'6px 10px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff' }}>
            Student: <strong>{studentId}</strong>
          </div>
          <button
            onClick={()=> nav(`/start?class=${encodeURIComponent(classCode)}`)}
            style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}
          >
            Switch
          </button>
        </div>
      </div>

      <div
        ref={scrollHostRef}
        style={{ height:'calc(100vh - 160px)', overflow:'auto', WebkitOverflowScrolling:'touch',
          touchAction: handMode ? 'auto' : 'none',
          display:'flex', alignItems:'flex-start', justifyContent:'center', padding:12,
          background:'#fff', border:'1px solid #eee', borderRadius:12, position:'relative' }}
      >
        <div style={{ position:'relative', width:`${canvasSize.w}px`, height:`${canvasSize.h}px` }}>
          {/* PDF layer */}
          {hasTask && pdfUrl ? (
            <div style={{ position:'absolute', inset:0, zIndex:0 }}>
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
            </div>
          ) : (
            <div style={{
              position:'absolute', inset:0, zIndex:0, display:'grid', placeItems:'center',
              color:'#6b7280', fontWeight:700, fontSize:22
            }}>
              No hay tareas.
            </div>
          )}

          {/* Draw layer */}
          <div style={{
              position:'absolute', inset:0, zIndex:10,
              pointerEvents: (hasTask && !handMode) ? 'auto' : 'none'
            }}>
            <DrawCanvas
              ref={drawRef}
              width={canvasSize.w}
              height={canvasSize.h}
              color={color}
              size={size}
              mode={handMode || !hasTask ? 'scroll' : 'draw'}
              tool={tool}
              selfId={studentId}
              onStrokeUpdate={async (u: RemoteStrokeUpdate) => {
                const ids = currIds.current
                if (!ids.assignment_id || !ids.page_id) return

                // Tag with studentId so only the same student page receives it
                const payloadWithStudent = { ...u, studentId }

                // NEW class-scoped room
                try {
                  await publishInk({ classCode, assignmentId: ids.assignment_id, pageId: ids.page_id }, payloadWithStudent as any)
                } catch {}

                // LEGACY room (for older clients)
                try {
                  // @ts-ignore legacy overload
                  await (publishInk as any)(ids.assignment_id, ids.page_id, payloadWithStudent)
                } catch {}
              }}
            />
          </div>

          {/* LIVE eraser overlay */}
          <div
            style={{
              position:'absolute', inset:0, zIndex:20,
              pointerEvents: (hasTask && !handMode && (tool === 'eraser' || tool === 'eraserObject')) ? 'auto' : 'none',
              cursor: (hasTask && !handMode && (tool === 'eraser' || tool === 'eraserObject'))
                ? (tool === 'eraserObject' ? 'not-allowed' : 'crosshair')
                : 'default'
            }}
            onPointerDown={onErasePointerDown}
            onPointerMove={onErasePointerMove}
            onPointerUp={onErasePointerUp}
            onPointerCancel={onErasePointerUp}
          />
        </div>
      </div>

      {/* Pager */}
      <div
        style={{
          position:'fixed', left:'50%', bottom:18, transform:'translateX(-50%)',
          zIndex: 10020, display:'flex', gap:10, alignItems:'center',
          background:'#fff', border:'1px solid #e5e7eb', borderRadius:999,
          boxShadow:'0 6px 16px rgba(0,0,0,0.15)', padding:'8px 12px'
        }}
      >
        <button
          onClick={()=>goToPage(Math.max(0, pageIndex-1))}
          disabled={!hasTask || saving || submitInFlight.current || navLocked || blockedBySync(Math.max(0, pageIndex-1))}
          style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
        >
          ◀ Prev
        </button>
        <span style={{ minWidth:90, textAlign:'center', fontWeight:600 }}>
          Page {pageIndex+1}
        </span>
        <button
          onClick={()=>goToPage(pageIndex+1)}
          disabled={!hasTask || saving || submitInFlight.current || navLocked || blockedBySync(pageIndex+1)}
          style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
        >
          Next ▶
        </button>
      </div>

      {/* Toolbar & toasts */}
      {Toolbar}
      {toast && <Toast text={toast.msg} kind={toast.kind} />}

      {/* Focus overlay */}
      {focusOn && (
        <div
          style={{
            position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
            backdropFilter:'blur(2px)', zIndex: 20050,
            display:'grid', placeItems:'center', color:'#fff', fontSize:20, fontWeight:700
          }}
        >
          Focus Mode — watch the teacher ✋
        </div>
      )}
    </div>
  )
}
