// src/pages/student/assignment.tsx
import type React from 'react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle, StrokesPayload, type Stroke } from '../../components/DrawCanvas'
import type { RemoteStrokeUpdate } from '../../components/DrawCanvas'
import {
  createSubmission, saveStrokes, /* saveAudio, */ loadLatestSubmission,
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
  // ⛔️ students no longer publish or subscribe to live ink
} from '../../lib/realtime'
import { ensureSaveWorker, attachBeforeUnloadSave } from '../../lib/swClient'
// 🔎 realtime meter
import { enableRealtimeMeter, logRealtimeUsage } from '../../lib/rtMeter'

// 5.1 — imports for timeline/audio/clock
import { usePageClock } from '../../hooks/usePageClock'
import AudioRecordButton from '../../components/AudioRecordButton'
import TimelineBar from '../../components/TimelineBar'
import type { AudioSeg, PageArtifact } from '../../types/timeline'

/** Constants */
const assignmentTitle = 'Handwriting - Daily' // legacy purge helper
const AUTO_SUBMIT_ON_PAGE_CHANGE = true
const DRAFT_INTERVAL_MS = 4000
const POLL_MS = 5000

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
const presenceKey = (classCode: string, assignmentId:string)=> `presence:${classCode}:${assignmentId}`

const draftKey      = (student:string, assignmentUid:string, pageUid:string)=> `draft:${student}:${assignmentUid}:${pageUid}`
const lastHashKey   = (student:string, assignmentUid:string, pageUid:string)=> `lastHash:${student}:${assignmentUid}:${pageUid}`
const submittedKey  = (student:string, assignmentUid:string, pageUid:string)=> `submitted:${student}:${assignmentUid}:${pageUid}`

/** Normalize any payload to {strokes:[{color,size,tool,pts:[{x,y,t?}]}]} */
function normalizeStrokes(data: unknown): StrokesPayload {
  const safePts = (arr: any[] | undefined) =>
    Array.isArray(arr)
      ? arr
          .filter(
            (p) =>
              p &&
              typeof p === 'object' &&
              Number.isFinite((p as any).x) &&
              Number.isFinite((p as any).y)
          )
          .map((p) => {
            const tVal = (p as any).t
            return {
              x: Number((p as any).x),
              y: Number((p as any).y),
              t: typeof tVal === 'number' ? Number(tVal) : undefined,
            }
          })
      : []

  try { if (typeof data === 'string') data = JSON.parse(data) } catch {}
  if (!data || typeof data !== 'object') return { strokes: [] }

  const raw = (data as any).strokes
  if (!Array.isArray(raw)) return { strokes: [] }

  const strokes: Stroke[] = raw
    .map((s: any): Stroke | null => {
      const tool: Stroke['tool'] =
        s?.tool === 'highlighter'
          ? 'highlighter'
          : s?.tool === 'eraser' || s?.tool === 'eraserObject' || s?.tool === 'erase'
          ? 'eraser'
          : 'pen'

      const ptsSrc = Array.isArray(s?.pts) ? s.pts : Array.isArray(s?.points) ? s.points : []
      const pts = safePts(ptsSrc)

      const size = Number.isFinite(s?.size) ? Number(s.size) : 4
      const color = typeof s?.color === 'string' ? (s.color as string) : '#000000'

      return { color, size, tool, pts }
    })
    .filter((x): x is Stroke => !!x)

  return { strokes }
}

// Coerce DrawCanvas strokes (t?: number) into timeline strokes (t: number required)
function toTimelineStrokes(
  strokes: { color:string; size:number; tool:'pen'|'highlighter'|'eraser'; pts: {x:number;y:number;t?:number}[] }[]
): import('../../types/timeline').Stroke[] {
  return (strokes || []).map(s => ({
    color: s.color,
    size: s.size,
    tool: s.tool,
    pts: (s.pts || []).map(p => ({
      x: p.x,
      y: p.y,
      t: typeof p.t === 'number' ? p.t : 0
    }))
  }))
}

function saveDraft(student:string, assignmentUid:string, pageUid:string, payload:any){
  try { localStorage.setItem(draftKey(student, assignmentUid, pageUid), JSON.stringify({ t: Date.now(), ...payload })) } catch {}
}
function loadDraft(student:string, assignmentUid:string, pageUid:string){
  try { const raw = localStorage.getItem(draftKey(student, assignmentUid, pageUid)); return raw ? JSON.parse(raw) : null } catch { return null }
}
function clearDraft(student:string, assignmentUid:string, pageUid:string){
  try { localStorage.removeItem(draftKey(student, assignmentUid, pageUid)) } catch {}
}
function saveSubmittedCache(student:string, assignmentUid:string, pageUid:string, payload:any){
  try { localStorage.setItem(submittedKey(student, assignmentUid, pageUid), JSON.stringify({ t: Date.now(), ...payload })) } catch {}
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
  // 🔎 enable realtime meter once
  useEffect(() => { enableRealtimeMeter() }, [])

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
  const scrollHostRef = useRef<HTMLDivElement | null>(null)

  // 2-finger pan on the scroll host while in draw mode
  useEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    let pan = false, startY = 0, startX = 0, startTop = 0, startLeft = 0

    const onTS = (e: TouchEvent) => {
      if (e.touches.length >= 2 && !handMode) {
        pan = true
        const [t1, t2] = [e.touches[0], e.touches[1]]
        startY = (t1.clientY + t2.clientY) / 2
        startX = (t1.clientX + t2.clientX) / 2
        startTop = host.scrollTop
        startLeft = host.scrollLeft
      }
    }

    const onTM = (e: TouchEvent) => {
      if (pan && e.touches.length >= 2) {
        e.preventDefault() // we’ll scroll manually
        const [t1, t2] = [e.touches[0], e.touches[1]]
        const y = (t1.clientY + t2.clientY) / 2
        const x = (t1.clientX + t2.clientX) / 2
        host.scrollTop  = startTop  - (y - startY)
        host.scrollLeft = startLeft - (x - startX)
      }
    }

    const end = () => { pan = false }

    host.addEventListener('touchstart', onTS,       { passive: true,  capture: true })
    host.addEventListener('touchmove',  onTM,       { passive: false, capture: true })
    host.addEventListener('touchend',   end,        { passive: true,  capture: true })
    host.addEventListener('touchcancel',end,        { passive: true,  capture: true })

    return () => {
      host.removeEventListener('touchstart', onTS as any, true)
      host.removeEventListener('touchmove',  onTM as any, true)
      host.removeEventListener('touchend',   end as any,  true)
      host.removeEventListener('touchcancel',end as any,  true)
    }
  }, [handMode])
  
  // remember when a recording started, so startMs matches ink timebase
  const recordStartRef = useRef<number | null>(null)

  // 5.2 — media + page clock
  const [media, setMedia] = useState<AudioSeg[]>([])
  const { nowMs, markFirstAction, absorbStrokePointT, absorbMediaEnd } = usePageClock()

  // 🔧 Track the real PDF canvas element and keep overlay in sync with its CSS size
  const pdfCanvasEl = useRef<HTMLCanvasElement | null>(null)

  /** Robustly compute the PDF canvas CSS size (avoids bottom clipping). */
  const syncFromPdfCanvas = () => {
    const el = pdfCanvasEl.current
    if (!el) return

    const dpr = (window.devicePixelRatio || 1)

    const rect = el.getBoundingClientRect()
    const cs = window.getComputedStyle(el)
    const cssWStyle = parseFloat(cs.width) || 0
    const cssHStyle = parseFloat(cs.height) || 0
    const cssWIntrinsic = (el.width || 0) / dpr
    const cssHIntrinsic = (el.height || 0) / dpr

    const parent = el.parentElement
    const parentW = parent ? Math.max(parent.scrollWidth, parent.clientWidth) : 0
    const parentH = parent ? Math.max(parent.scrollHeight, parent.clientHeight) : 0

    const cssW = Math.max(1, Math.round(Math.max(rect.width, cssWStyle, cssWIntrinsic, parentW)))
    const cssH = Math.max(1, Math.round(Math.max(rect.height, cssHStyle, cssHIntrinsic, parentH)))

    setCanvasSize(prev => prev.w === cssW && prev.h === cssH ? prev : { w: cssW, h: cssH })
  }

  const [toast, setToast] = useState<{ msg:string; kind:'ok'|'err' }|null>(null)
  const toastTimer = useRef<number|null>(null)
  const showToast = (msg:string, kind:'ok'|'err'='ok', ms=1500)=>{
    setToast({ msg, kind })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(()=> setToast(null), ms)
  }
  useEffect(()=>()=>{ if (toastTimer.current) window.clearTimeout(toastTimer.current) }, [])

// When PDF is ready, remember its canvas and sync size immediately
const onPdfReady = useCallback((_pdf:any, canvas:HTMLCanvasElement, dims?:{cssW:number; cssH:number})=>{
  pdfCanvasEl.current = canvas
  if (dims && typeof dims.cssW === 'number' && typeof dims.cssH === 'number') {
    const w = Math.max(1, Math.round(dims.cssW))
    const h = Math.max(1, Math.round(dims.cssH))
    setCanvasSize(prev => (prev.w===w && prev.h===h) ? prev : { w, h })
  }
  try {
    const dpr = (window.devicePixelRatio || 1)
    if (canvas.width && !canvas.style.width)  canvas.style.width  = `${Math.round(canvas.width / dpr)}px`
    if (canvas.height && !canvas.style.height) canvas.style.height = `${Math.round(canvas.height / dpr)}px`
  } catch {}
  syncFromPdfCanvas()
}, []); // 👈 stable reference; won’t change when tool/color/handMode change


  // Keep overlay size synced to PDF canvas + parent size changes and zoom/orientation
  useEffect(() => {
    const el = pdfCanvasEl.current
    if (!el) return

    let roCanvas: ResizeObserver | null = null
    let roParent: ResizeObserver | null = null

    if ('ResizeObserver' in window) {
      roCanvas = new ResizeObserver(() => syncFromPdfCanvas())
      roCanvas.observe(el)
      if (el.parentElement) {
        roParent = new ResizeObserver(() => syncFromPdfCanvas())
        roParent.observe(el.parentElement)
      }
    }

    const onWinResize = () => syncFromPdfCanvas()
    window.addEventListener('resize', onWinResize)

    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const onDprChange = () => syncFromPdfCanvas()
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', onDprChange)

    const onOrient = () => syncFromPdfCanvas()
    window.addEventListener('orientationchange', onOrient)

    const poll = window.setInterval(syncFromPdfCanvas, 150)
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 2500)

    return () => {
      if (roCanvas) roCanvas.disconnect()
      if (roParent) roParent.disconnect()
      window.removeEventListener('resize', onWinResize)
      if (mq && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onDprChange)
      window.removeEventListener('orientationchange', onOrient)
      window.clearInterval(poll)
      window.clearTimeout(stopPoll)
    }
  }, [pdfUrl, pageIndex])

  // assignment/page ids for realtime
  const currIds = useRef<{assignment_id?:string, page_id?:string}>({})

  // Persist assignment id from teacher (or DB fallback)
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

  const snapToTeacherIfAvailable = (assignmentId: string) => {
    try {
      const raw = localStorage.getItem(presenceKey(classCode, assignmentId))
      if (!raw) return
      const p = JSON.parse(raw) as TeacherPresenceState
      applyPresenceSnapshot(p, { snap: true })
    } catch {/* ignore */}
  }

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

  useEffect(() => {
    if (!classCode) return
    const off = subscribeToGlobal(classCode, (nextAssignmentId) => {
      try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, nextAssignmentId) } catch {}
      setRtAssignmentId(nextAssignmentId)
      snapToTeacherIfAvailable(nextAssignmentId)
      ensurePresenceFromServer(nextAssignmentId)
      currIds.current = {}
    })
    return off
  }, [classCode])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const snap = await fetchClassState(classCode)
        if (!snap || cancelled) { setClassBootDone(true); return }

        setRtAssignmentId(snap.assignment_id)
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, snap.assignment_id) } catch {}

        if (typeof snap.page_index === 'number') {
          setPageIndex(snap.page_index)
        }
      } catch {
      } finally {
        if (!cancelled) setClassBootDone(true)
      }
    })()
    return () => { cancelled = true }
  }, [classCode])

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

  useEffect(() => {
    if (!rtAssignmentId) return
    try {
      const raw = localStorage.getItem(presenceKey(classCode, rtAssignmentId))
      if (raw) {
        const p = JSON.parse(raw) as TeacherPresenceState
        applyPresenceSnapshot(p, { snap: true })
      } else {
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

  /* ---------- Hello → presence-snapshot handshake ---------- */
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

  // Resolve assignment/page
  async function resolveIds(): Promise<{ assignment_id: string, page_id: string } | null> {
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
      currIds.current = {}
      setPdfStoragePath('')
      setHasTask(false)
      return null
    }

    snapToTeacherIfAvailable(assignmentId)
    await ensurePresenceFromServer(assignmentId)

    let targetIndex = pageIndex
    const tpi = teacherPageIndexRef.current
    if (autoFollow && typeof tpi === 'number') {
      targetIndex = tpi
      if (pageIndex !== tpi) setPageIndex(tpi)
    }

    let pages = await listPages(assignmentId).catch(() => [] as any[])
    if (!pages || pages.length === 0) {
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

    const curr =
      pages.find(p => p.page_index === targetIndex) ??
      pages.find(p => p.page_index === pageIndex) ??
      pages[0]

    if (typeof curr.page_index === 'number' && curr.page_index !== pageIndex) {
      setPageIndex(curr.page_index)
    }

    currIds.current = { assignment_id: assignmentId, page_id: curr.id }
    setPdfStoragePath(curr.pdf_path || '')
    setHasTask(!!curr.pdf_path)

    return { assignment_id: assignmentId, page_id: curr.id }
  }

  /* ---------- Page load: clear, then draft → server → cache ---------- */
  useEffect(()=>{
    if (!classBootDone || !rtAssignmentId) return

    let cancelled=false
    try { drawRef.current?.clearStrokes() } catch {}

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
          setMedia([])
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
          // 5.4 — load draft media
          const draftMedia: AudioSeg[] = Array.isArray(draft?.media) ? draft.media : []
          setMedia(draftMedia)
          try {
            const mx = draftMedia.reduce((m, seg)=> Math.max(m, seg.startMs + seg.durationMs), 0)
            if (mx > 0) absorbMediaEnd(mx)
          } catch {}
        } else {
          lastLocalHash.current = ''
          setMedia([])
        }

        try {
          const latest = await loadLatestSubmission(ids.assignment_id, ids.page_id, studentId)
          if (!cancelled && latest) {
            const payload: PageArtifact | any =
              latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
            const norm = normalizeStrokes(payload)
            if (Array.isArray(norm.strokes) && norm.strokes.length > 0) {
              const h = await hashStrokes(norm)
              if (!localDirty.current) {
                drawRef.current?.loadStrokes(norm)
                // 5.3 — absorb last stroke times
                try {
                  for (const s of norm.strokes) {
                    if (s.pts?.length) absorbStrokePointT(s.pts[s.pts.length-1]?.t)
                  }
                } catch {}
                // 5.4 — media from server
                const mediaIn: AudioSeg[] = Array.isArray(payload?.media) ? payload.media : []
                setMedia(mediaIn)
                try {
                  const mx = mediaIn.reduce((m, seg)=> Math.max(m, seg.startMs + seg.durationMs), 0)
                  if (mx > 0) absorbMediaEnd(mx)
                } catch {}
                lastAppliedServerHash.current = h
                lastLocalHash.current = h
              }
            } else if (!draft?.strokes) {
              const cached = loadSubmittedCache(studentId, assignmentUid, pageUid)
              if (cached?.strokes) {
                const normC = normalizeStrokes(cached.strokes)
                drawRef.current?.loadStrokes(normC)
                lastLocalHash.current = await hashStrokes(normC)
                const cachedMedia: AudioSeg[] = Array.isArray(cached?.media) ? cached.media : []
                setMedia(cachedMedia)
                try {
                  const mx = cachedMedia.reduce((m, seg)=> Math.max(m, seg.startMs + seg.durationMs), 0)
                  if (mx > 0) absorbMediaEnd(mx)
                } catch {}
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
          const cachedMedia: AudioSeg[] = Array.isArray(cached?.media) ? cached.media : []
          setMedia(cachedMedia)
          try {
            const mx = cachedMedia.reduce((m, seg)=> Math.max(m, seg.startMs + seg.durationMs), 0)
            if (mx > 0) absorbMediaEnd(mx)
          } catch {}
        } else {
          setMedia([])
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
          // 5.4 — save full draft payload
          const draftPayload = {
            canvasWidth: canvasSize.w,
            canvasHeight: canvasSize.h,
            strokes: data.strokes || [],
            media
          }
          saveDraft(studentId, assignmentUid, pageUid, draftPayload)
        }
      } catch {}
    }
    id = window.setInterval(tick, 800)
    return ()=>{ if (id!=null) window.clearInterval(id) }
  }, [pageIndex, studentId, media, canvasSize.w, canvasSize.h])

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
        const draftPayload = {
          canvasWidth: canvasSize.w,
          canvasHeight: canvasSize.h,
          strokes: data.strokes || [],
          media
        }
        const s = JSON.stringify(draftPayload)
        if (s !== lastSerialized) {
          const { assignmentUid, pageUid } = getCacheIds()
          saveDraft(studentId, assignmentUid, pageUid, draftPayload)
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
          const draftPayload = {
            canvasWidth: canvasSize.w,
            canvasHeight: canvasSize.h,
            strokes: data.strokes || [],
            media
          }
          saveDraft(studentId, assignmentUid, pageUid, draftPayload)
        }
      } catch {}
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return ()=>{
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onBeforeUnload as any)
    }
  }, [pageIndex, studentId, media, canvasSize.w, canvasSize.h])

  /* ---------- Submit (dirty-check) + cache ---------- */
  const submit = async ()=>{
    if (!hasTask) return
    if (submitInFlight.current) return
    submitInFlight.current = true
    try{
      setSaving(true)
      const strokesRaw = drawRef.current?.getStrokes() || { strokes: [] }
      const normalized = normalizeStrokes(strokesRaw)
      const hasInk   = Array.isArray(normalized.strokes) && normalized.strokes.length > 0
      if (!hasInk) { setSaving(false); submitInFlight.current=false; return }

      const encHash = await hashStrokes(normalized)
      const ids = currIds.current
      if (!ids.assignment_id || !ids.page_id) { setSaving(false); submitInFlight.current=false; return }

      const { assignmentUid, pageUid } = getCacheIds(ids.page_id)
      const lastKey = lastHashKey(studentId, assignmentUid, pageUid)
      const last = localStorage.getItem(lastKey)
      if (last && last === encHash) { setSaving(false); submitInFlight.current=false; return }

      const submission_id = await createSubmission(studentId, ids.assignment_id!, ids.page_id!)

      // 5.4 — Save strokes + media with canvas size
      const payloadForSave: PageArtifact = {
        canvasWidth: canvasSize.w,
        canvasHeight: canvasSize.h,
        strokes: toTimelineStrokes(normalized.strokes),  // ✅ coerce to timeline strokes (t always a number)
        media: media
      }

      await saveStrokes(submission_id, payloadForSave)
      localStorage.setItem(lastKey, encHash)
      saveSubmittedCache(studentId, assignmentUid, pageUid, payloadForSave)
      lastAppliedServerHash.current = encHash
      lastLocalHash.current = encHash
      localDirty.current = false

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

  const hasInkOrAudio = () => {
    const current = normalizeStrokes(drawRef.current?.getStrokes() || { strokes: [] })
    const hasInk   = Array.isArray(current.strokes) && current.strokes.length > 0
    return { hasInk, current }
  }

  const submitIfNeeded = async (_reason: string) => {
    const { hasInk } = hasInkOrAudio()
    if (!hasInk) return
    try {
      await submit()
    } catch {
      const { assignmentUid, pageUid } = getCacheIds()
      try {
        const data = drawRef.current?.getStrokes() || {strokes:[]}
        const draftPayload = {
          canvasWidth: canvasSize.w,
          canvasHeight: canvasSize.h,
          strokes: data.strokes || [],
          media
        }
        saveDraft(studentId, assignmentUid, pageUid, draftPayload)
      } catch {}
    }
  }

  function buildSavePayload() {
    try {
      const ids = currIds.current
      if (!ids.assignment_id || !ids.page_id) return null
      const strokes = normalizeStrokes(drawRef.current?.getStrokes() || { strokes: [] })
      const hasInk = Array.isArray(strokes?.strokes) && strokes.strokes.length > 0
      if (!hasInk) return null
      return {
        type: 'close-save-v1',
        classCode,
        studentId,
        assignmentId: ids.assignment_id,
        pageId: ids.page_id,
        pageIndex,
        canvas: { w: canvasSize.w, h: canvasSize.h },
        strokes,
        media,
        ts: Date.now()
      }
    } catch {
      return null
    }
  }

  useEffect(() => {
    let detach: (() => void) | null = null
    ;(async () => {
      try { await ensureSaveWorker() } catch {}
      detach = attachBeforeUnloadSave('student-close-save', async () => buildSavePayload())
    })()
    return () => { try { detach?.() } catch {} }
  }, [studentId, classCode, rtAssignmentId, pageIndex, canvasSize.w, canvasSize.h, media])

  /* ---------- Realtime + polling ---------- */
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
        applyPresenceSnapshot({
          autoFollow: !!on,
          allowedPages: allowedPages ?? null,
          focusOn,
          lockNav: navLocked,
          teacherPageIndex: teacherPageIndexRef.current ?? undefined
        } as TeacherPresenceState, { snap: true })
      },
      onPresence: (p: TeacherPresenceState) => {
        try { localStorage.setItem(presenceKey(classCode, rtAssignmentId), JSON.stringify(p)) } catch {}
        applyPresenceSnapshot(p, { snap: true })
      },

      // NEW: force-submit → submit immediately (scoped or all)
      onForceSubmit: async (p: { studentId?: string; pageIndex?: number }) => {
        try {
          if (p?.studentId && p.studentId !== studentId) return
          await submit()
          if (typeof p?.pageIndex === 'number') {
            setNavLocked(false)
            setPageIndex(p.pageIndex)
          }
        } catch (e) {
          console.warn('force-submit handler failed', e)
        }
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
      const payload: PageArtifact | any =
        latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
      const normalized = normalizeStrokes(payload)

      const hasServerInk = Array.isArray(normalized?.strokes) && normalized.strokes.length > 0
      if (!hasServerInk) return

      const serverHash = await hashStrokes(normalized)
      if (serverHash === lastAppliedServerHash.current) {
        // still refresh media if changed
        const mediaIn: AudioSeg[] = Array.isArray(payload?.media) ? payload.media : []
        setMedia(mediaIn)
        try {
          const mx = mediaIn.reduce((m, seg)=> Math.max(m, seg.startMs + seg.durationMs), 0)
          if (mx > 0) absorbMediaEnd(mx)
        } catch {}
        return
      }

      if (!localDirty.current) {
        drawRef.current?.loadStrokes(normalized)
        try {
          for (const s of normalized.strokes) {
            if (s.pts?.length) absorbStrokePointT(s.pts[s.pts.length-1]?.t)
          }
        } catch {}
        const mediaIn: AudioSeg[] = Array.isArray(payload?.media) ? payload.media : []
        setMedia(mediaIn)
        try {
          const mx = mediaIn.reduce((m, seg)=> Math.max(m, seg.startMs + seg.durationMs), 0)
          if (mx > 0) absorbMediaEnd(mx)
        } catch {}
        const { assignmentUid, pageUid } = getCacheIds(ids.page_id)
        saveSubmittedCache(studentId, assignmentUid, pageUid, payload)
        lastAppliedServerHash.current = serverHash
        lastLocalHash.current = serverHash
      }
    } catch {/* ignore */}
  }

  useEffect(() => {
    if (!classBootDone || !rtAssignmentId) return

    let pollId: number | null = null
    let mounted = true

    ;(async () => {
      const ids = await resolveIds()
      if (!ids) return

      // ---- polling only (no artifacts realtime channel)
      pollId = window.setInterval(() => {
        if (mounted) reloadFromServer()
      }, POLL_MS)
    })()

    return () => {
      mounted = false
      if (pollId != null) window.clearInterval(pollId)
    }
  }, [classBootDone, classCode, studentId, pageIndex, rtAssignmentId])

  /* ---------- Audio helpers (5.5) ---------- */
  async function uploadAudioBlob(studentId:string, assignmentId:string, pageId:string, blob:Blob, mime:string): Promise<string> {
    const ext = mime.includes('mp4') ? 'm4a' : 'webm'
    const path = `audio/${assignmentId}/${pageId}/${studentId}-${Date.now()}.${ext}`
    const { error } = await supabase.storage.from('pdfs').upload(path, blob, { contentType: mime, upsert: true })
    if (error) throw error
    const { data: pub } = supabase.storage.from('pdfs').getPublicUrl(path)
    return pub?.publicUrl || ''
  }

  function addAudioSegment(startMs:number, durationMs:number, mime:string, url:string) {
    const seg: AudioSeg = {
      kind: 'audio',
      id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      startMs, durationMs, mime, url
    }
    setMedia(prev => {
      const next = [...prev, seg]
      try { absorbMediaEnd(seg.startMs + seg.durationMs) } catch {}
      return next
    })
  }

  async function handleRecordStart() {
    // ensure page clock is running AND remember when the clip begins
    markFirstAction()
    try { recordStartRef.current = nowMs() } catch { recordStartRef.current = null }
  }

  async function handleRecordStop(blob: Blob, mime: string, elapsedMs: number) {
    try {
      const ids = currIds.current
      // use the start time captured at onStart (fallback to now if missing)
      const start = (recordStartRef.current ?? nowMs())
      recordStartRef.current = null

      if (!ids.assignment_id || !ids.page_id) {
        const url = URL.createObjectURL(blob)
        addAudioSegment(start, elapsedMs, mime, url)
        showToast('Audio saved locally', 'ok', 1200)
        return
      }
      const url = await uploadAudioBlob(studentId, ids.assignment_id, ids.page_id, blob, mime)
      addAudioSegment(start, elapsedMs, mime, url)
      showToast('Audio uploaded', 'ok', 1200)
    } catch (e) {
      console.warn('upload audio failed', e)
      const start = (recordStartRef.current ?? nowMs())
      recordStartRef.current = null
      const url = URL.createObjectURL(blob)
      addAudioSegment(start, elapsedMs, mime, url)
      showToast('Upload failed — kept locally', 'err', 1600)
    }
  }

  function deleteAudio(id: string) {
    setMedia(prev => prev.filter(s => s.id !== id))
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
        <button onClick={()=> setToolbarOnRight(r=>{ const next=!r; try{ localStorage.setItem('toolbarSide', next?'right':'left') }catch{}; return next })} title="Flip toolbar side"
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

      {/* 5.6 — record + submit */}
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        <AudioRecordButton
          onStart={handleRecordStart}
          onStop={handleRecordStop}
          onLongHint={(ms)=> showToast(`Long recording (${Math.round(ms/1000)}s)…`, 'ok', 1200)}
        />
        <button onClick={submit}
          style={{ background: saving ? '#16a34a' : '#22c55e', opacity: saving?0.8:1,
            color:'#fff', padding:'8px 10px', borderRadius:10, border:'none' }} disabled={saving || !hasTask}>
          {saving ? 'Saving…' : 'Submit'}
        </button>
      </div>
    </div>
  )

  // 👇 Add this just before `return ( ... )`
  const pdfNode = useMemo(() => {
    if (!hasTask || !pdfUrl) return null
    return (
      <div style={{ position:'absolute', inset:0, zIndex:0 }}>
        <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
      </div>
    )
  }, [pdfUrl, pageIndex, hasTask, onPdfReady])
  // 2d — page navigation that auto-submits before changing pages (if enabled)
  const goToPage = useCallback(async (i:number) => {
    if (!Number.isFinite(i)) return
    if (AUTO_SUBMIT_ON_PAGE_CHANGE) {
      try { await submitIfNeeded('page-change') } catch {}
    }
    setNavLocked(false)
    setPageIndex(Math.max(0, i))
  }, [submitIfNeeded])

  const goPrev = useCallback(() => { void goToPage(Math.max(0, pageIndex - 1)) }, [goToPage, pageIndex])
  const goNext = useCallback(() => { void goToPage(pageIndex + 1) }, [goToPage, pageIndex])

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
          {/* 🔎 small debug button */}
          <button
            onClick={() => {
              const rows = logRealtimeUsage(`RT usage — student ${studentId}`)
              alert(`Realtime events counted: ${rows.length}. See console for details.`)
            }}
            style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
          >
            RT usage
          </button>
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
        style={{ height:'calc(100vh - 220px)', overflow:'auto', WebkitOverflowScrolling:'touch',
          touchAction: handMode ? 'auto' : 'none',
          display:'flex', alignItems:'flex-start', justifyContent:'center', padding:12,
          background:'#fff', border:'1px solid #eee', borderRadius:12, position:'relative' }}
      >
        <div style={{ position:'relative', width:`${canvasSize.w}px`, height:`${canvasSize.h}px`, overflow:'visible' }}>
          {/* PDF layer */}
          {pdfNode ?? (
            <div style={{
              position:'absolute', inset:0, zIndex:0, display:'grid', placeItems:'center',
              color:'#6b7280', fontWeight:700, fontSize:22
            }}>
              No hay tareas.
            </div>
          )}

          {/* Draw layer */}
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 10,
              pointerEvents: (hasTask && !handMode) ? 'auto' : 'none',
              touchAction: (hasTask && !handMode) ? 'none' : 'auto',
            }}
          >
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
                // 5.3 — clock kick + absorb latest t (local only)
                try { markFirstAction() } catch {}
                try {
                  const pLast = (u.pts && u.pts.length) ? u.pts[u.pts.length - 1] : undefined
                  if (pLast && typeof (pLast as any).t === 'number') absorbStrokePointT((pLast as any).t)
                } catch {}
                // ⛔️ no live publish from students
              }}
            />
          </div>
        </div>
      </div>

      {/* 5.6 — Timeline bar */}
      <div style={{ display:'flex', justifyContent:'center', marginTop:12 }}>
        <TimelineBar
          widthPx={Math.min(900, Math.max(480, canvasSize.w))}
          durationMs={
            Math.max(
              1000,
              media.reduce((m, s) => Math.max(m, s.startMs + s.durationMs), 0),
              (() => {
                const data = drawRef.current?.getStrokes()
                if (!data?.strokes?.length) return 0
                let mx = 0
                for (const s of data.strokes) {
                  if (s.pts?.length) {
                    const t = s.pts[s.pts.length - 1]?.t || 0
                    mx = Math.max(mx, t)
                  }
                }
                return mx
              })()
            )
          }
          audio={media}
          onDelete={(id)=> deleteAudio(id)}
        />
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
          onClick={goPrev}
          disabled={!hasTask || saving || submitInFlight.current || navLocked || (autoFollow && teacherPageIndexRef.current!==null && Math.max(0, pageIndex-1)!==teacherPageIndexRef.current)}
          style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
        >
          ◀ Prev
        </button>
        <span style={{ minWidth:90, textAlign:'center', fontWeight:600 }}>
          Page {pageIndex+1}
        </span>
        <button
          onClick={goNext}
          disabled={!hasTask || saving || submitInFlight.current || navLocked || (autoFollow && teacherPageIndexRef.current!==null && (pageIndex+1)!==teacherPageIndexRef.current)}
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
