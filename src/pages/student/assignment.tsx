// src/pages/student/assignment.tsx
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle, StrokesPayload } from '../../components/DrawCanvas'
import type { Stroke } from '../../components/DrawCanvas'
import AudioRecorder, { AudioRecorderHandle } from '../../components/AudioRecorder'
import {
  createSubmission, saveStrokes, saveAudio, loadLatestSubmission,
  listPages,
  supabase
} from '../../lib/db'
import {
  subscribeToAssignment,
  subscribeToGlobal,
  subscribeToControl,
  type SetPagePayload,
  type FocusPayload,
  type AutoFollowPayload,
  type TeacherPresenceState,
  // autosync helpers
  subscribePresenceSnapshot,
  studentHello,
  requestAssignment,
} from '../../lib/realtime'

// Eraser utils
import type { Pt } from '../../lib/geometry'
import { objectErase, softErase } from '../../lib/erase'

/** Constants */
const assignmentTitle = 'Handwriting - Daily'
const AUTO_SUBMIT_ON_PAGE_CHANGE = true
const DRAFT_INTERVAL_MS = 4000
const POLL_MS = 5000
const ERASE_RADIUS_BASE = 10
// NEW: one-time per tab “first join” ping flag
const FIRST_JOIN_KEY = 'first-join-pinged'

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

/* ---------- Keys & helpers ---------- */
const ASSIGNMENT_CACHE_KEY = 'currentAssignmentId'
const presenceKey = (assignmentId:string)=> `presence:${assignmentId}`

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
  const buf = await crypto.subtle.digest('SHA-256', enc) as ArrayBuffer
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

/** station inference */
function inferStation(id: string): string {
  const m = id.match(/^([A-Za-z]_\d{2})/)
  return (m?.[1] ?? id).toUpperCase()
}

export default function StudentAssignment(){
  const location = useLocation()
  const nav = useNavigate()
  const studentId = useMemo(()=>{
    const qs = new URLSearchParams(location.search)
    const id = qs.get('student') || localStorage.getItem('currentStudent') || 'A_01'
    localStorage.setItem('currentStudent', id)
    return id
  }, [location.search])

  /** stationId used for live-sync grouping */
  const stationId = useMemo(()=>{
    const qs = new URLSearchParams(location.search)
    const s = qs.get('station')
    return (s ? s.toUpperCase() : inferStation(studentId))
  }, [location.search, studentId])

  // NEW: hydration gate — we don't show "No hay tareas" until we've tried to hydrate once.
  const [hydrated, setHydrated] = useState(false)

  // pdf path resolved from DB page row
  const [pdfStoragePath, setPdfStoragePath] = useState<string>('')

  // PDF URL for PdfCanvas
  const [pdfUrl, setPdfUrl] = useState<string>('') 
  const [hasTask, setHasTask] = useState<boolean>(false)

  // ---- PDF resolver (IMMEDIATE) ----
  const STORAGE_BUCKET = 'pdfs'
  const resolvingUrlRef = useRef<Promise<void> | null>(null)

  function keyForBucket(path: string) {
    if (!path) return ''
    let k = path.replace(/^\/+/, '')
    k = k.replace(/^public\//, '')
    k = k.replace(/^pdfs\//, '')
    return k
  }

  async function applyPdfPath(path?: string) {
    // central place to resolve & set url + flags immediately
    const finalPath = path || ''
    setPdfStoragePath(finalPath)
    if (!finalPath) {
      setPdfUrl(''); setHasTask(false); setHydrated(true)
      return
    }
    const key = keyForBucket(finalPath)
    try {
      const p = (async () => {
        const { data: sData } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60)
        if (sData?.signedUrl) {
          setPdfUrl(sData.signedUrl)
          setHasTask(true)
          setHydrated(true)
          return
        }
        const { data: pData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key)
        const ok = !!pData?.publicUrl
        setPdfUrl(pData?.publicUrl ?? '')
        setHasTask(ok)
        setHydrated(true)
      })()
      resolvingUrlRef.current = p
      await p
    } catch {
      setPdfUrl('')
      setHasTask(false)
      setHydrated(true)
    } finally {
      resolvingUrlRef.current = null
    }
  }

  // Also keep legacy effect (acts as a safety net if pdfStoragePath changes elsewhere)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!pdfStoragePath) { 
        if (!cancelled){ setPdfUrl(''); setHasTask(false); setHydrated(true) } 
        return 
      }
      const key = keyForBucket(pdfStoragePath)
      const { data: sData } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60)
      if (!cancelled && sData?.signedUrl) { setPdfUrl(sData.signedUrl); setHasTask(true); setHydrated(true); return }
      const { data: pData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key)
      if (!cancelled) { 
        const ok=!!pData?.publicUrl; 
        setPdfUrl(pData?.publicUrl ?? ''); 
        setHasTask(ok); 
        setHydrated(true) 
      }
    })()
    return () => { cancelled = true }
  }, [pdfStoragePath])

  const [pageIndex, setPageIndex]   = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true)
  const [tool, setTool] = useState<Tool>('pen')
  const [saving, setSaving] = useState(false)
  const submitInFlight = useRef(false)

  // ---------- Sync state ----------
  const [focusOn, setFocusOn] = useState(false)
  const [navLocked, setNavLocked] = useState(false)
  const [autoFollow, setAutoFollow] = useState(false)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)
  const teacherPageIndexRef = useRef<number | null>(null)

  // NEW: first time snap flag
  const firstSnapDone = useRef(false)

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

  // Persist assignment id from teacher
  const [rtAssignmentId, setRtAssignmentId] = useState<string>(() => {
    try { return localStorage.getItem(ASSIGNMENT_CACHE_KEY) || '' } catch { return '' }
  })

  // NEW: One-time “first join” request (multi-ping). Student asks teacher for assignment if unknown.
  useEffect(() => {
    if (rtAssignmentId) return
    if (typeof window !== 'undefined' && sessionStorage.getItem(FIRST_JOIN_KEY) === '1') return

    let cancelled = false
    let tries = 0

    const ping = () => {
      if (cancelled) return
      if (rtAssignmentId) {
        try { sessionStorage.setItem(FIRST_JOIN_KEY, '1') } catch {}
        return
      }
      try { void requestAssignment() } catch {}
      tries += 1
      if (tries >= 6) {
        try { sessionStorage.setItem(FIRST_JOIN_KEY, '1') } catch {}
      }
    }

    // fire a few spaced pings to cover timing races
    ping()
    const t1 = window.setTimeout(ping, 600)
    const t2 = window.setTimeout(ping, 1400)
    const t3 = window.setTimeout(ping, 2600)

    return () => {
      cancelled = true
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.clearTimeout(t3)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Global assignment handoff
  useEffect(() => {
    const off = subscribeToGlobal((nextAssignmentId) => {
      try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, nextAssignmentId) } catch {}
      setRtAssignmentId(nextAssignmentId)
      setHydrated(true) // we learned assignment
      try { void studentHello(nextAssignmentId) } catch {}

      try {
        const raw = localStorage.getItem(presenceKey(nextAssignmentId))
        if (raw) {
          const p = JSON.parse(raw) as TeacherPresenceState
          if (typeof p.teacherPageIndex === 'number') {
            teacherPageIndexRef.current = p.teacherPageIndex
            if (!firstSnapDone.current) {
              setPageIndex(p.teacherPageIndex)
              firstSnapDone.current = true
            }
          }
          const pdfPath = (p as any)?.pdfPath as string | undefined
          if (pdfPath) applyPdfPath(pdfPath)
          const pid = (p as any)?.pageId as string | undefined
          if (pid) currIds.current.page_id = pid
        } else {
          setPageIndex(0)
        }
      } catch { setPageIndex(0) }
      currIds.current = {}
    })
    return off
  }, [])

  // 👉 NEW: As soon as we have an assignment id (from any source), prime the page/pdf immediately.
  useEffect(() => {
    if (!rtAssignmentId) return
    let cancelled = false
    ;(async () => {
      try {
        const pages = await listPages(rtAssignmentId)
        if (!pages || pages.length === 0) { await applyPdfPath(''); return }
        const tpi = typeof teacherPageIndexRef.current === 'number' ? teacherPageIndexRef.current : 0
        const current = pages.find(p => p.page_index === tpi) ?? pages[0]
        if (cancelled) return
        currIds.current = { assignment_id: rtAssignmentId, page_id: current.id }
        await applyPdfPath(current.pdf_path || '')
        // first snap if we haven't yet
        if (!firstSnapDone.current) {
          setPageIndex(current.page_index ?? 0)
          firstSnapDone.current = true
        }
      } catch {
        await applyPdfPath('')
      }
    })()
    return () => { cancelled = true }
  }, [rtAssignmentId])

  // ✅ ALSO listen to control:all (with first-snap)
  useEffect(() => {
    const off = subscribeToControl({
      onSetAssignment: (id) => {
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, id) } catch {}
        setRtAssignmentId(id)
        setHydrated(true)
        try { void studentHello(id) } catch {}
      },
      onSetPage: (p) => {
        setHydrated(true)
        teacherPageIndexRef.current = p.pageIndex
        const pdfPath = (p as any)?.pdfPath as string | undefined
        if (pdfPath) applyPdfPath(pdfPath)
        if (p.pageId) currIds.current.page_id = p.pageId

        // First time? snap unconditionally
        if (!firstSnapDone.current) {
          setPageIndex(p.pageIndex)
          firstSnapDone.current = true
          return
        }
        // otherwise respect policy
        if (autoFollow || (focusOn && navLocked)) {
          setPageIndex(prev => prev !== p.pageIndex ? p.pageIndex : prev)
        }
      },
      onFocus: ({ on, lockNav }: FocusPayload) => {
        setHydrated(true)
        setFocusOn(!!on)
        setNavLocked(!!on && !!lockNav)
        if (on && lockNav && typeof teacherPageIndexRef.current === 'number') {
          setPageIndex(teacherPageIndexRef.current)
        }
      },
      onAutoFollow: ({ on, allowedPages, teacherPageIndex }: AutoFollowPayload) => {
        setHydrated(true)
        setAutoFollow(!!on)
        setAllowedPages(allowedPages ?? null)
        if (typeof teacherPageIndex === 'number') teacherPageIndexRef.current = teacherPageIndex
        if (on && typeof teacherPageIndexRef.current === 'number') {
          setPageIndex(teacherPageIndexRef.current)
        }
      },
      // Presence: hydrate page/pdf only; snap once if first time
      onPresence: (p) => {
        setHydrated(true)
        const incomingAid = (p as any)?.assignmentId as string | undefined
        if (incomingAid && incomingAid !== rtAssignmentId) {
          try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, incomingAid) } catch {}
          setRtAssignmentId(incomingAid)
          try { void studentHello(incomingAid) } catch {}
        }
        if (typeof p.teacherPageIndex === 'number') {
          teacherPageIndexRef.current = p.teacherPageIndex
          if (!firstSnapDone.current) {
            setPageIndex(p.teacherPageIndex)
            firstSnapDone.current = true
          }
        }
        const pdfPath = (p as any)?.pdfPath as string | undefined
        if (pdfPath) applyPdfPath(pdfPath)
        const pid = (p as any)?.pageId as string | undefined
        if (pid) currIds.current.page_id = pid

        // after first snap, only follow if policy says so
        if (firstSnapDone.current && (autoFollow || (focusOn && navLocked)) && typeof teacherPageIndexRef.current === 'number') {
          setPageIndex(prev => (prev !== teacherPageIndexRef.current! ? teacherPageIndexRef.current! : prev))
        }
      }
    })
    return off
  }, [autoFollow, focusOn, navLocked, rtAssignmentId])

  // ✅ Presence snapshot (PAGE-ONLY) with first-snap
  useEffect(() => {
    if (!rtAssignmentId) return
    try { void studentHello(rtAssignmentId) } catch {}
    const off = subscribePresenceSnapshot(rtAssignmentId, (p) => {
      setHydrated(true)
      try { localStorage.setItem(presenceKey(rtAssignmentId), JSON.stringify(p)) } catch {}

      if (typeof p.teacherPageIndex === 'number') {
        teacherPageIndexRef.current = p.teacherPageIndex
        if (!firstSnapDone.current) {
          setPageIndex(p.teacherPageIndex)
          firstSnapDone.current = true
        }
      }

      const pdfPath = (p as any)?.pdfPath as string | undefined
      if (pdfPath) applyPdfPath(pdfPath)
      const pid = (p as any)?.pageId as string | undefined
      if (pid) currIds.current.page_id = pid

      if (firstSnapDone.current && (autoFollow || (focusOn && navLocked)) && typeof teacherPageIndexRef.current === 'number') {
        setPageIndex(teacherPageIndexRef.current)
      }
    })
    return () => { try { (off as any)?.() } catch {} }
  }, [rtAssignmentId, autoFollow, focusOn, navLocked])

  // hydrate presence on refresh (optional snap if not yet done)
  useEffect(() => {
    if (!rtAssignmentId) return
    try {
      const raw = localStorage.getItem(presenceKey(rtAssignmentId))
      if (!raw) return
      const p = JSON.parse(raw) as TeacherPresenceState
      setHydrated(true)
      if (typeof p.teacherPageIndex === 'number') {
        teacherPageIndexRef.current = p.teacherPageIndex
        if (!firstSnapDone.current) {
          setPageIndex(p.teacherPageIndex)
          firstSnapDone.current = true
        }
      }
      const pdfPath = (p as any)?.pdfPath as string | undefined
      if (pdfPath) applyPdfPath(pdfPath)
      const pid = (p as any)?.pageId as string | undefined
      if (pid) currIds.current.page_id = pid
    } catch {}
  }, [rtAssignmentId])

  // --------- stable cache ids ----------
  const getCacheIds = (pageId?: string) => {
    const assignmentUid = rtAssignmentId || currIds.current.assignment_id || 'no-assignment'
    const pageUid = pageId || currIds.current.page_id || `page-${pageIndex}`
    return { assignmentUid, pageUid }
  }
  // -------------------------------------

  // Resolve assignment/page
  async function resolveIds(): Promise<{ assignment_id: string, page_id: string } | null> {
    if (!rtAssignmentId) {
      currIds.current = {}
      await applyPdfPath('')
      return null
    }
    const pages = await listPages(rtAssignmentId)
    if (!pages || pages.length === 0) {
      currIds.current = {}
      await applyPdfPath('')
      return null
    }
    // prefer teacher's page if we already know it
    const tpi = typeof teacherPageIndexRef.current === 'number' ? teacherPageIndexRef.current : pageIndex
    const curr = pages.find(p => p.page_index === tpi) ?? pages[0]
    currIds.current = { assignment_id: rtAssignmentId, page_id: curr.id }
    await applyPdfPath(curr.pdf_path || '')
    return { assignment_id: rtAssignmentId, page_id: curr.id }
  }

  const lastAppliedServerHash = useRef<string>('')
  const lastLocalHash = useRef<string>('')
  const localDirty = useRef<boolean>(false)
  const dirtySince = useRef<number>(0)
  const justSavedAt = useRef<number>(0)

  // LIVE: per-page channel for instant peer updates (scoped by station)
  const clientIdRef = useRef<string>('c_' + Math.random().toString(36).slice(2))
  const liveChRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  useEffect(()=>{
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
  }, [pageIndex, studentId, rtAssignmentId])

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
  useEffect(() => {
    let lastSerialized = ''
    let running = !document.hidden
    let intervalId: number | null = null

    const tick = () => {
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

    const start = () => {
      if (intervalId == null) intervalId = window.setInterval(tick, DRAFT_INTERVAL_MS)
    }
    const stop = () => {
      if (intervalId != null) { window.clearInterval(intervalId); intervalId = null }
    }

    const onVis = () => { running = !document.hidden; if (running) start(); else stop() }

    function handleBeforeUnload() {
      try {
        const data = drawRef.current?.getStrokes()
        if (data) {
          const { assignmentUid, pageUid } = getCacheIds()
          saveDraft(studentId, assignmentUid, pageUid, data)
        }
      } catch {}
    }

    document.addEventListener('visibilitychange', onVis)
    start()
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', handleBeforeUnload)
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
      const last = localStorage.getItem(lastHashKey(studentId, assignmentUid, pageUid))
      if (last && last === encHash && !hasAudio) { setSaving(false); submitInFlight.current=false; return }

      const submission_id = await createSubmission(studentId, ids.assignment_id!, ids.page_id!)

      if (hasInk) {
        await saveStrokes(submission_id, strokes)
        localStorage.setItem(lastHashKey(studentId, assignmentUid, pageUid), encHash)
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

  // ---------- Navigation policy ----------
  const isAllowedByPageRange = (idx: number) => {
    if (!allowedPages || allowedPages.length === 0) return true
    return allowedPages.includes(idx)
  }

  const blockedBySync = (idx: number) => {
    const tpi = teacherPageIndexRef.current
    if (focusOn && navLocked) {
      return typeof tpi === 'number' ? idx !== tpi : true
    }
    if (!isAllowedByPageRange(idx)) return true
    if (autoFollow) {
      return typeof tpi === 'number' ? idx !== tpi : true
    }
    return false
  }

  // Snap into range if needed
  useEffect(() => {
    if (!allowedPages || allowedPages.length === 0) return
    if (!isAllowedByPageRange(pageIndex)) {
      const tpi = teacherPageIndexRef.current
      if (typeof tpi === 'number' && allowedPages.includes(tpi)) {
        setPageIndex(tpi)
      } else {
        setPageIndex(allowedPages[0])
      }
    }
  }, [allowedPages]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus snap
  useEffect(() => {
    if (focusOn && navLocked && typeof teacherPageIndexRef.current === 'number') {
      setPageIndex(teacherPageIndexRef.current)
    }
  }, [focusOn, navLocked])

  // AutoFollow snap (post-firstSnap)
  useEffect(() => {
    if (!autoFollow) return
    const tpi = teacherPageIndexRef.current
    if (typeof tpi === 'number') {
      setPageIndex(prev => (prev !== tpi ? tpi : prev))
    }
  }, [autoFollow])

  const goToPage = async (nextIndex:number)=>{
    if (!hasTask) return
    if (nextIndex < 0) return
    if (blockedBySync(nextIndex)) return
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
  const scrollHostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = scrollHostRef.current
    if (!host) return

    let pan = false, startY = 0, startX = 0, startT = 0, startL = 0

    const onTS = (e: TouchEvent) => {
      if (e.touches.length >= 2 && !handMode) {
        pan = true
        const [t1, t2] = [e.touches[0], e.touches[1]]
        startY = (t1.clientY + t2.clientY) / 2
        startX = (t1.clientX + t2.clientX) / 2
        startT = host.scrollTop
        startL = host.scrollLeft
      }
    }

    const onTM = (e: TouchEvent) => {
      if (pan && e.touches.length >= 2) {
        e.preventDefault()
        const [t1, t2] = [e.touches[0], e.touches[1]]
        const y = (t1.clientY + t2.clientY) / 2
        const x = (t1.clientX + t2.clientX) / 2
        host.scrollTop = startT - (y - startY)
        host.scrollLeft = startL - (x - startX)
      }
    }

    const end = () => { pan = false }

    const addOpts = { passive: true, capture: true } as AddEventListenerOptions
    const moveOpts = { passive: false, capture: true } as AddEventListenerOptions
    const rmOpts = { capture: true } as EventListenerOptions

    host.addEventListener('touchstart', onTS, addOpts)
    host.addEventListener('touchmove', onTM, moveOpts)
    host.addEventListener('touchend', end, addOpts)
    host.addEventListener('touchcancel', end, addOpts)

    return () => {
      host.removeEventListener('touchstart', onTS, rmOpts)
      host.removeEventListener('touchmove', onTM, rmOpts)
      host.removeEventListener('touchend', end, rmOpts)
      host.removeEventListener('touchcancel', end, rmOpts)
    }
  }, [handMode])

  const flipToolbarSide = ()=> {
    setToolbarOnRight(r=>{ const next=!r; try{ localStorage.setItem('toolbarSide', next?'right':'left') }catch{}; return next })
  }

  /* ---------- Realtime teacher controls (per-assignment) ---------- */
  useEffect(() => {
    if (!rtAssignmentId) return
    const ch = subscribeToAssignment(rtAssignmentId, {
      onSetPage: ({ pageIndex }: SetPagePayload) => {
        setHydrated(true)
        teacherPageIndexRef.current = pageIndex
        if (!firstSnapDone.current) {
          setPageIndex(pageIndex)
          firstSnapDone.current = true
          return
        }
        if (autoFollow || (focusOn && navLocked)) {
          setPageIndex(prev => (prev !== pageIndex ? pageIndex : prev))
        }
      },
      onFocus: ({ on, lockNav }: FocusPayload) => {
        setHydrated(true)
        setFocusOn(!!on)
        setNavLocked(!!on && !!lockNav)
        if (on && lockNav && typeof teacherPageIndexRef.current === 'number') {
          setPageIndex(teacherPageIndexRef.current)
        }
      },
      onAutoFollow: ({ on, allowedPages, teacherPageIndex }: AutoFollowPayload) => {
        setHydrated(true)
        setAutoFollow(!!on)
        setAllowedPages(allowedPages ?? null)
        if (typeof teacherPageIndex === 'number') teacherPageIndexRef.current = teacherPageIndex
        if (on && typeof teacherPageIndexRef.current === 'number') {
          setPageIndex(teacherPageIndexRef.current)
        }
      },
      onPresence: (p: TeacherPresenceState) => {
        setHydrated(true)
        try { localStorage.setItem(presenceKey(rtAssignmentId), JSON.stringify(p)) } catch {}
        if (typeof p.teacherPageIndex === 'number') {
          teacherPageIndexRef.current = p.teacherPageIndex
          if (!firstSnapDone.current) {
            setPageIndex(p.teacherPageIndex)
            firstSnapDone.current = true
          }
        }
        const pdfPath = (p as any)?.pdfPath as string | undefined
        if (pdfPath) applyPdfPath(pdfPath)
        const pid = (p as any)?.pageId as string | undefined
        if (pid) currIds.current.page_id = pid
        if (firstSnapDone.current && (autoFollow || (p.focusOn && p.lockNav)) && typeof p.teacherPageIndex === 'number') {
          setPageIndex(p.teacherPageIndex)
        }
      }
    })
    return () => { try { ch?.unsubscribe?.() } catch {} }
  }, [rtAssignmentId, autoFollow, focusOn, navLocked])

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

  // Artifacts table watch + polling (safety net)
  useEffect(()=>{
    let cleanup: (()=>void)|null = null
    let pollId: number | null = null
    let mounted = true

    ;(async ()=>{
      const ids = await resolveIds()
      if (!ids) return
      try{
        const ch = supabase.channel(`art-strokes-${ids.page_id}`)
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'artifacts',
            filter: `page_id=eq.${ids.page_id},kind=eq.strokes`
          }, ()=> reloadFromServer())
          .subscribe()
        cleanup = ()=> { try { ch.unsubscribe() } catch {} }
      }catch(e){
        console.error('realtime subscribe failed', e)
      }
      pollId = window.setInterval(()=> { if (mounted) reloadFromServer() }, POLL_MS)
    })()

    return ()=> {
      mounted = false
      if (cleanup) cleanup()
      if (pollId!=null) window.clearInterval(pollId)
    }
  }, [studentId, pageIndex, rtAssignmentId])

  /* ---------- LIVE: page channel for instant co-editing (scoped by station) ---------- */
  useEffect(()=>{
    let cleanup: (()=>void)|null = null
    ;(async ()=>{
      const ids = await resolveIds()
      if (!ids) return

      try { liveChRef.current?.unsubscribe() } catch {}

      const ch = supabase.channel(`page-live-${ids.page_id}:${stationId}`, { config: { broadcast: { self: false } } })

      ch.on('broadcast', { event: 'stroke-commit' }, (msg) => {
        const { clientId, stroke, station } = (msg as any)?.payload || {}
        if (!stroke) return
        if (station && station.toUpperCase() !== stationId) return
        if (clientId === clientIdRef.current) return
        const cur = drawRef.current?.getStrokes() || { strokes: [] }
        drawRef.current?.loadStrokes({ strokes: [...(cur.strokes || []), stroke] })
      })

      ch.on('broadcast', { event: 'erase-commit' }, (msg) => {
        const { clientId, path, radius, mode, station } = (msg as any)?.payload || {}
        if (!Array.isArray(path)) return
        if (station && station.toUpperCase() !== stationId) return
        if (clientId === clientIdRef.current) return
        const cur = drawRef.current?.getStrokes() || { strokes: [] }
        const base = normalizeStrokes(cur)
        const trimmed = mode === 'object'
          ? (objectErase(base.strokes as any, path, radius).kept as any)
          : (softErase(base.strokes as any, path, radius) as any)
        drawRef.current?.loadStrokes({ strokes: trimmed })
      })

      await ch.subscribe()
      liveChRef.current = ch
      cleanup = ()=>{ try { ch.unsubscribe() } catch {} }
    })()
    return ()=>{ if (cleanup) cleanup() }
  }, [pageIndex, rtAssignmentId, stationId])

  /* ---------- LIVE eraser overlay (broadcast on commit) ---------- */
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
    const path = erasePathRef.current
    erasePathRef.current = []
    if (!final) return

    drawRef.current?.loadStrokes(final)

    const ch = liveChRef.current
    if (ch && path.length >= 2) {
      ch.send({
        type: 'broadcast',
        event: 'erase-commit',
        payload: {
          clientId: clientIdRef.current,
          station: stationId,
          path,
          radius: dynamicRadius,
          mode: (tool === 'eraserObject') ? 'object' : 'soft'
        }
      })
    }

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
            Student: <strong>{studentId}</strong> — Station: <strong>{stationId}</strong>
          </div>
          <button onClick={()=> nav('/start')} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}>
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
          {(!hydrated) ? (
            <div style={{
              position:'absolute', inset:0, zIndex:0, display:'grid', placeItems:'center',
              color:'#6b7280', fontWeight:700, fontSize:20
            }}>
              Conectando…
            </div>
          ) : hasTask && pdfUrl ? (
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
              onStrokeCommit={(stroke: Stroke) =>{
                const ch = liveChRef.current
                if (!ch || !stroke) return
                ch.send({
                  type: 'broadcast',
                  event: 'stroke-commit',
                  payload: { clientId: clientIdRef.current, station: stationId, stroke }
                })
              }}
            />
          </div>

          {/* LIVE eraser overlay */}
          <div
            style={{
              position:'absolute',
              inset:0,
              zIndex:20,
              pointerEvents: (hasTask && !handMode && (tool === 'eraser' || tool === 'eraserObject')) ? 'auto' : 'none',
              cursor: (hasTask && !handMode && (tool === 'eraser' || tool === 'eraserObject'))
                ? 'crosshair'
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
          disabled={!hasTask || saving || submitInFlight.current || blockedBySync(Math.max(0, pageIndex-1))}
          style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
        >
          ◀ Prev
        </button>
        <span style={{ minWidth:90, textAlign:'center', fontWeight:600 }}>
          Page {pageIndex+1}
        </span>
        <button
          onClick={()=>goToPage(pageIndex+1)}
          disabled={!hasTask || saving || submitInFlight.current || blockedBySync(pageIndex+1)}
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
