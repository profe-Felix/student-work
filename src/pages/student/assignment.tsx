// src/pages/student/assignment.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle, StrokesPayload } from '../../components/DrawCanvas'
import AudioRecorder, { AudioRecorderHandle } from '../../components/AudioRecorder'
import {
  createSubmission, saveStrokes, saveAudio, loadLatestSubmission,
  listPages,
  supabase
} from '../../lib/db'
import {
  subscribeToAssignment,
  type SetPagePayload,
  type FocusPayload,
  type AutoFollowPayload,
  subscribeToGlobal,
  type TeacherPresenceState,
} from '../../lib/realtime'
import { fetchLatestAssignmentWithFirstPage } from '../../lib/queries'

// ---------- Extend DrawCanvas StrokesPayload just for runtime (allow audioOffsetMs) ----------
type StrokesPayloadRT = StrokesPayload & {
  timing?: {
    capturePerf0Ms?: number
    audioOffsetMs?: number
  }
}

/** Constants */
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

/* ---------- Keys & helpers ---------- */
const draftKey      = (student:string, assignmentId:string, page:number)=> `draft:${student}:${assignmentId}:${page}`
const lastHashKey   = (student:string, assignmentId:string, page:number)=> `lastHash:${student}:${assignmentId}:${page}`
const submittedKey  = (student:string, assignmentId:string, page:number)=> `submitted:${student}:${assignmentId}:${page}`

// cache keys (assignment handoff + presence snapshot)
const ASSIGNMENT_CACHE_KEY = 'currentAssignmentId'
const presenceKey = (assignmentId:string)=> `presence:${assignmentId}`

function normalizeStrokes(data: unknown): StrokesPayloadRT {
  if (!data || typeof data !== 'object') return { strokes: [] }
  const obj = data as any
  const arr = Array.isArray(obj.strokes) ? obj.strokes : []
  const out: StrokesPayloadRT = { strokes: arr }

  if (Number.isFinite(obj.canvasWidth))  out.canvasWidth  = obj.canvasWidth
  if (Number.isFinite(obj.canvasHeight)) out.canvasHeight = obj.canvasHeight

  if (obj.timing && typeof obj.timing === 'object') {
    out.timing = {}
    if (Number.isFinite(obj.timing.capturePerf0Ms)) out.timing.capturePerf0Ms = obj.timing.capturePerf0Ms
    if (Number.isFinite(obj.timing.audioOffsetMs))  out.timing.audioOffsetMs  = obj.timing.audioOffsetMs
  }
  return out
}

function saveDraft(student:string, assignmentId:string, page:number, strokes:any){
  try { localStorage.setItem(draftKey(student, assignmentId, page), JSON.stringify({ t: Date.now(), strokes })) } catch {}
}
function loadDraft(student:string, assignmentId:string, page:number){
  try { const raw = localStorage.getItem(draftKey(student, assignmentId, page)); return raw ? JSON.parse(raw) : null } catch { return null }
}
function clearDraft(student:string, assignmentId:string, page:number){
  try { localStorage.removeItem(draftKey(student, assignmentId, page)) } catch {}
}
function saveSubmittedCache(student:string, assignmentId:string, page:number, strokes:any){
  try { localStorage.setItem(submittedKey(student, assignmentId, page), JSON.stringify({ t: Date.now(), strokes })) } catch {}
}
function loadSubmittedCache(student:string, assignmentId:string, page:number){
  try { const raw = localStorage.getItem(submittedKey(student, assignmentId, page)); return raw ? JSON.parse(raw) : null } catch { return null }
}

async function hashStrokes(strokes:any): Promise<string> {
  const enc = new TextEncoder().encode(JSON.stringify(strokes || {}))
  const buf = await crypto.subtle.digest('SHA-256', enc)
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')
}

/** Find the most recent submission (for this student/page) that already has a 'strokes' artifact */
async function fetchLatestSubmissionIdWithStrokes(
  assignmentId: string,
  pageId: string,
  studentId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from('submissions')
    .select('id, created_at, artifacts:artifacts(kind, created_at)')
    .eq('assignment_id', assignmentId)
    .eq('page_id', pageId)
    .eq('student_id', studentId)
    .order('created_at', { ascending: false })
    .limit(15)

  if (error) throw error

  const rows = (data ?? []) as Array<{ id: string; artifacts?: Array<{ kind: string }> }>
  const hit = rows.find(r => Array.isArray(r.artifacts) && r.artifacts.some(a => a.kind === 'strokes'))
  return hit?.id ?? null
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

/* ---------- Audio merging helpers (takes -> one WAV aligned to ink) ---------- */
type AudioTake = { blob: Blob; startPerfMs: number }

// Merge takes -> mono 44.1k WAV. Trim encoder padding but DO NOT change offsets.
async function mergeAudioTakesToWav(
  takes: AudioTake[],
  capturePerf0Ms: number | undefined
): Promise<Blob> {
  if (!takes.length) throw new Error('No takes to merge')

  const TARGET_RATE = 44100

  // 1) Decode using a short-lived AudioContext
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext
  const probeCtx = new AC()

  const decoded = await Promise.all(
    takes.map(async (t) => {
      const ab = await t.blob.arrayBuffer()
      const buf: AudioBuffer = await probeCtx.decodeAudioData(ab.slice(0))
      let offsetSec = ((t.startPerfMs ?? 0) - (capturePerf0Ms ?? 0)) / 1000
      if (!Number.isFinite(offsetSec)) offsetSec = 0
      return { buf, offsetSec }
    })
  )
  probeCtx.close?.()

  // 2) Downmix to mono
  const toMono = (buf: AudioBuffer) => {
    if (buf.numberOfChannels === 1) return buf
    const out = new AudioBuffer({ length: buf.length, numberOfChannels: 1, sampleRate: buf.sampleRate })
    const l = buf.getChannelData(0)
    const r = buf.getChannelData(1)
    const d = out.getChannelData(0)
    const n = Math.min(l.length, r.length)
    for (let i = 0; i < n; i++) d[i] = (l[i] + r[i]) * 0.5
    return out
  }
  const mono = decoded.map(d => ({ buf: toMono(d.buf), offsetSec: d.offsetSec }))

  // 3) Resample to 44.1k if needed
  const OAC = (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext
  const resampled = await Promise.all(mono.map(async ({ buf, offsetSec }) => {
    if (buf.sampleRate === TARGET_RATE) return { buf, offsetSec }
    const length = Math.ceil(buf.duration * TARGET_RATE)
    const oc = new OAC(1, length, TARGET_RATE)
    const src = oc.createBufferSource()
    src.buffer = buf
    src.connect(oc.destination)
    src.start(0)
    const rendered: AudioBuffer = await oc.startRendering()
    return { buf: rendered, offsetSec }
  }))

  // 4) Trim encoder padding BUT keep offset the same
  const TRIM_THRESH = 0.01
  const MAX_TRIM_SEC = 0.3
  const trimmed = resampled.map(({ buf, offsetSec }) => {
    const data = buf.getChannelData(0)
    const maxTrim = Math.min(data.length, Math.floor(MAX_TRIM_SEC * buf.sampleRate))
    let lead = 0
    while (lead < maxTrim && Math.abs(data[lead]) < TRIM_THRESH) lead++
    const view = data.subarray(lead)
    return { data: view, offsetSec }
  })

  // 5) Determine output length
  let totalSec = 0
  for (const t of trimmed) {
    const dur = t.data.length / TARGET_RATE
    totalSec = Math.max(totalSec, t.offsetSec + dur)
  }
  const totalLen = Math.max(1, Math.ceil(totalSec * TARGET_RATE))
  const mix = new Float32Array(totalLen)

  // 6) Mix
  const HEADROOM = 0.85
  for (const t of trimmed) {
    let start = Math.round(t.offsetSec * TARGET_RATE)
    let src = t.data
    if (start < 0) {
      const drop = Math.min(src.length, -start)
      src = src.subarray(drop)
      start = 0
    }
    for (let i = 0; i < src.length; i++) {
      const j = start + i
      if (j < mix.length) mix[j] += src[i] * HEADROOM
    }
  }

  // 7) Encode WAV
  return encodeWavMono16(mix, TARGET_RATE)
}

// Minimal PCM WAV encoder (mono, 16-bit)
function encodeWavMono16(samples: Float32Array, sampleRate: number): Blob {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = (s * 0x7fff) | 0
  }

  const bytesPerSample = 2
  const blockAlign = 1 * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  let off = 0
  const writeStr = (s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)) }
  const writeU32 = (v: number) => { view.setUint32(off, v, true); off += 4 }
  const writeU16 = (v: number) => { view.setUint16(off, v, true); off += 2 }

  writeStr('RIFF'); writeU32(36 + dataSize); writeStr('WAVE')
  writeStr('fmt '); writeU32(16); writeU16(1)
  writeU16(1)
  writeU32(sampleRate); writeU32(byteRate)
  writeU16(blockAlign); writeU16(16)
  writeStr('data'); writeU32(dataSize)
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer))
  return new Blob([buffer], { type: 'audio/wav' })
}

/* ---------- Response 1: helpers for prior audio + storage ---------- */
function parseStoragePath(p: string){
  let s = (p || '').replace(/^\/+/, '').replace(/^public\//, '')
  const slash = s.indexOf('/')
  if (slash < 0) return { bucket: s, key: '' }
  return { bucket: s.slice(0, slash), key: s.slice(slash + 1) }
}

async function downloadBlobFromStoragePath(storage_path: string): Promise<Blob|null> {
  if (!storage_path) return null
  try {
    const { bucket, key } = parseStoragePath(storage_path)
    if (!bucket || !key) return null
    const { data, error } = await supabase.storage.from(bucket).download(key)
    if (error) return null
    return data ?? null
  } catch { return null }
}

async function getPrevAudioInfo(
  assignmentId: string,
  pageId: string,
  studentId: string
): Promise<{ blob: Blob|null; durationMs: number; capturePerf0Ms?: number }>{
  try{
    const latest = await loadLatestSubmission(assignmentId, pageId, studentId)
    if (!latest) return { blob: null, durationMs: 0 }

    const strokesPayload = latest.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
    const capturePerf0Ms = strokesPayload?.timing?.capturePerf0Ms

    const audioArt = latest.artifacts?.find((a:any)=>a.kind==='audio')
    if (!audioArt?.storage_path) return { blob: null, durationMs: 0, capturePerf0Ms }

    const blob = await downloadBlobFromStoragePath(audioArt.storage_path)
    if (!blob) return { blob: null, durationMs: 0, capturePerf0Ms }

    const AC = (window as any).AudioContext || (window as any).webkitAudioContext
    const ctx = new AC()
    const ab = await blob.arrayBuffer()
    const buf: AudioBuffer = await ctx.decodeAudioData(ab.slice(0))
    ctx.close?.()

    return { blob, durationMs: Math.round(buf.duration * 1000), capturePerf0Ms }
  } catch {
    return { blob: null, durationMs: 0 }
  }
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

  // storage path comes from DB page row
  const [pdfStoragePath, setPdfStoragePath] = useState<string>('')

  // Resolved URL used by PdfCanvas (bucket is really "pdfs")
  const [pdfUrl, setPdfUrl] = useState<string>('')
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
      if (!pdfStoragePath) { setPdfUrl(''); return }
      const key = keyForBucket(pdfStoragePath)
      const { data: sData } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60)
      if (!cancelled && sData?.signedUrl) { setPdfUrl(sData.signedUrl); return }
      const { data: pData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(key)
      if (!cancelled) setPdfUrl(pData?.publicUrl ?? '')
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

  // toolbar side (persisted)
  const [toolbarOnRight, setToolbarOnRight] = useState<boolean>(()=>{ try{ return localStorage.getItem('toolbarSide')!=='left' }catch{return true} })

  const drawRef = useRef<DrawCanvasHandle>(null)
  const audioRef = useRef<AudioRecorderHandle>(null)

  // --- Multi-take audio (per page) ---
  const audioTakes = useRef<AudioTake[]>([]) // all takes for this page
  const [recordMode, setRecordMode] = useState<'append'|'replace'>('append')
  const audioBlob = useRef<Blob|null>(null)  // optional: last blob (for previews, etc.)
  const pendingTakeStart = useRef<number|null>(null) // start ts from onStart(ts)

  // IMPORTANT: timing origin for this page (same clock as startPerfMs)
  const timingZeroRef = useRef<number | null>(null)

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

  // assignment/page cache for realtime filter
  const currIds = useRef<{assignment_id?:string, page_id?:string}>({})

  // Persist assignment id so refresh stays on the teacher’s assignment
  const [rtAssignmentId, setRtAssignmentId] = useState<string>(() => {
    try { return localStorage.getItem(ASSIGNMENT_CACHE_KEY) || '' } catch { return '' }
  })

  // derive a key to scope local caches, even when not yet connected
  const assignmentKeyForCache = rtAssignmentId || 'none'

  // Realtime teacher controls
  const [focusOn, setFocusOn] = useState(false)
  const [navLocked, setNavLocked] = useState(false)
  const [autoFollow, setAutoFollow] = useState(false)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)
  const teacherPageIndexRef = useRef<number | null>(null)

  // hashes/dirty tracking
  const lastAppliedServerHash = useRef<string>('')
  const lastLocalHash = useRef<string>('')
  const localDirty = useRef<boolean>(false)
  const dirtySince = useRef<number>(0)
  const justSavedAt = useRef<number>(0)

  // --------- Boot: pick the latest assignment + first page (or nothing) ---------
  useEffect(() => {
    // ✅ If we already know the assignment (e.g., from teacher broadcast cache), don't overwrite with "latest".
    if (rtAssignmentId) return;

    let alive = true
    ;(async () => {
      try {
        const { assignment, page } = await fetchLatestAssignmentWithFirstPage()
        if (!alive) return
        if (!assignment || !page) {
          // No assignments: clear cached id and ensure empty state
          try { localStorage.removeItem(ASSIGNMENT_CACHE_KEY) } catch {}
          setRtAssignmentId('')
          setPdfStoragePath('')
          setPageIndex(0)
          currIds.current = {}
          return
        }
        // Found latest assignment
        setRtAssignmentId(assignment.id)
        try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, assignment.id) } catch {}
        // Ensure first page index and storage path
        setPageIndex(page.page_index ?? 0)

        // fetch the page row to get pdf_path
        const pages = await listPages(assignment.id)
        const first = (pages || []).find((p:any) => (p.page_index ?? 0) === (page.page_index ?? 0)) || (pages || [])[0]
        setPdfStoragePath(first?.pdf_path || '')
        currIds.current = { assignment_id: assignment.id, page_id: first?.id }
      } catch (e) {
        console.error('initial latest assignment load failed', e)
        // fallback to empty state
        try { localStorage.removeItem(ASSIGNMENT_CACHE_KEY) } catch {}
        setRtAssignmentId('')
        setPdfStoragePath('')
        setPageIndex(0)
        currIds.current = {}
      }
    })()
    return () => { alive = false }
  }, [rtAssignmentId])

  // Teacher chooses a different assignment globally → follow it
  useEffect(() => {
    const off = subscribeToGlobal((nextAssignmentId) => {
      try { localStorage.setItem(ASSIGNMENT_CACHE_KEY, nextAssignmentId) } catch {}
      setRtAssignmentId(nextAssignmentId)

      // Hydrate presence snapshot if we have one
      try {
        const raw = localStorage.getItem(presenceKey(nextAssignmentId))
        if (raw) {
          const p = JSON.parse(raw) as TeacherPresenceState
          setAutoFollow(!!p.autoFollow)
          setAllowedPages(p.allowedPages ?? null)
          setFocusOn(!!p.focusOn)
          setNavLocked(!!p.focusOn && !!p.lockNav)
          if (typeof p.teacherPageIndex === 'number') {
            teacherPageIndexRef.current = p.teacherPageIndex
            setPageIndex(p.teacherPageIndex)
          } else {
            setPageIndex(0)
          }
        } else {
          setPageIndex(0)
        }
      } catch {
        setPageIndex(0)
      }

      // reset page-local audio/capture state
      audioTakes.current = []
      audioBlob.current = null
      pendingTakeStart.current = null
      timingZeroRef.current = null
      currIds.current = {}
    })
    return off
  }, [])

  // On assignment known, hydrate presence/page from cache on refresh (keeps "sync to me" after reload)
  useEffect(() => {
    if (!rtAssignmentId) return
    try {
      const raw = localStorage.getItem(presenceKey(rtAssignmentId))
      if (!raw) return
      const p = JSON.parse(raw) as TeacherPresenceState
      setAutoFollow(!!p.autoFollow)
      setAllowedPages(p.allowedPages ?? null)
      setFocusOn(!!p.focusOn)
      setNavLocked(!!p.focusOn && !!p.lockNav)
      if (p.autoFollow && typeof p.teacherPageIndex === 'number') {
        teacherPageIndexRef.current = p.teacherPageIndex
        setPageIndex(p.teacherPageIndex)
      }
    } catch {}
  }, [rtAssignmentId])

  /* ---------- Page load: clear, then draft → server → cache ---------- */
  useEffect(()=>{
    let cancelled=false
    try { drawRef.current?.clearStrokes(); audioRef.current?.stop() } catch {}
    audioTakes.current = []
    audioBlob.current = null
    pendingTakeStart.current = null
    timingZeroRef.current = null

    ;(async ()=>{
      try{
        if (!rtAssignmentId) {
          // no assignment → ensure clean canvas
          lastLocalHash.current = ''
          return
        }

        const draft = loadDraft(studentId, assignmentKeyForCache, pageIndex)
        if (draft?.strokes) {
          try { drawRef.current?.loadStrokes(normalizeStrokes(draft.strokes)) } catch {}
          try { lastLocalHash.current = await hashStrokes(normalizeStrokes(draft.strokes)) } catch {}
        } else {
          lastLocalHash.current = ''
        }

        // ensure page ids for this assignment
        const pages = await listPages(rtAssignmentId)
        const curr = (pages || []).find((p:any) => p.page_index === pageIndex)
        if (!curr) {
          // no page for this index — leave blank
          currIds.current = { assignment_id: rtAssignmentId, page_id: undefined }
          setPdfStoragePath('')
          return
        }
        currIds.current = { assignment_id: rtAssignmentId, page_id: curr.id }
        setPdfStoragePath(curr?.pdf_path || '')

        try {
          const latest = await loadLatestSubmission(rtAssignmentId, curr.id, studentId)
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
              const cached = loadSubmittedCache(studentId, assignmentKeyForCache, pageIndex)
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
        const cached = loadSubmittedCache(studentId, assignmentKeyForCache, pageIndex)
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
          if (rtAssignmentId) saveDraft(studentId, assignmentKeyForCache, pageIndex, data)
        }
      } catch {}
    }
    id = window.setInterval(tick, 800)
    return ()=>{ if (id!=null) window.clearInterval(id) }
  }, [pageIndex, studentId, rtAssignmentId])

  /* ---------- Draft autosave (coarse) ---------- */
  useEffect(()=>{
    let lastSerialized = ''
    let running = !document.hidden
    let intervalId: number | null = null
    const tick = ()=>{
      try {
        if (!running || !rtAssignmentId) return
        const data = drawRef.current?.getStrokes()
        if (!data) return
        const s = JSON.stringify(data)
        if (s !== lastSerialized) {
          saveDraft(studentId, assignmentKeyForCache, pageIndex, data)
          lastSerialized = s
        }
      } catch {}
    }
    const start = ()=>{ if (intervalId==null){ intervalId = window.setInterval(tick, DRAFT_INTERVAL_MS) } }
    const stop  = ()=>{ if (intervalId!=null){ window.clearInterval(intervalId); intervalId=null } }
    const onVis = ()=>{ running = !document.hidden; if (running) start(); else stop() }
    document.addEventListener('visibilitychange', onVis)
    start()
    const onBefore = ()=>{
      try {
        if (!rtAssignmentId) return
        const data = drawRef.current?.getStrokes(); if (data) saveDraft(studentId, assignmentKeyForCache, pageIndex, data)
      } catch {}
    }
    window.addEventListener('beforeunload', onBefore)
    return ()=>{
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onBefore as any)
    }

  }, [pageIndex, studentId, rtAssignmentId]) // eslint-disable-line

  /* ---------- Submit (dirty-check) + cache ---------- */
  const submit = async () => {
    if (submitInFlight.current) return
    if (!rtAssignmentId) return
    submitInFlight.current = true
    try {
      setSaving(true)

      // Build payload and normalize timing BEFORE hashing
      const payload: StrokesPayloadRT =
        (drawRef.current?.getStrokes() as StrokesPayloadRT) ||
        { strokes: [], canvasWidth: canvasSize.w, canvasHeight: canvasSize.h }

      payload.timing = payload.timing ? { ...payload.timing } : {}

      if (payload.timing.capturePerf0Ms == null && timingZeroRef.current != null) {
        payload.timing.capturePerf0Ms = timingZeroRef.current
      }
      if (payload.timing.audioOffsetMs == null) payload.timing.audioOffsetMs = 0

      const hasInk = Array.isArray(payload?.strokes) && payload.strokes.length > 0
      const hasAudioTakes = audioTakes.current.length > 0
      if (!hasInk && !hasAudioTakes) { setSaving(false); submitInFlight.current = false; return }

      // Hash AFTER timing fields are finalized
      const encHash = await hashStrokes(payload)
      const lastKey = lastHashKey(studentId, assignmentKeyForCache, pageIndex)
      const last = localStorage.getItem(lastKey)
      if (last && last === encHash && !hasAudioTakes) { setSaving(false); submitInFlight.current = false; return }

      // resolve current page row
      const pages = await listPages(rtAssignmentId)
      const curr = (pages || []).find((p:any) => p.page_index === pageIndex)
      if (!curr) throw new Error(`No page row for page_index=${pageIndex}`)

      // -------- Response 1 strategy: keep a single canonical submission and append audio --------
      // Choose submission id: prefer the latest (so strokes timeline remains the one teacher sees)
      const latest = await loadLatestSubmission(rtAssignmentId, curr.id, studentId)
      let submission_id = latest?.submission?.id as string | undefined

      if (!submission_id) {
        // First time ever → create submission and (if ink exists) save strokes to set the timeline
        submission_id = await createSubmission(studentId, rtAssignmentId, curr.id)
        if (hasInk) {
          await saveStrokes(submission_id, payload)
          localStorage.setItem(lastKey, encHash)
          saveSubmittedCache(studentId, assignmentKeyForCache, pageIndex, payload)
          lastAppliedServerHash.current = encHash
          lastLocalHash.current = encHash
          localDirty.current = false
        } else {
          // even if no new ink, persist any existing on-canvas strokes to establish a scrub timeline
          const dataNow: StrokesPayloadRT =
            (drawRef.current?.getStrokes() as StrokesPayloadRT) ||
            { strokes: [], canvasWidth: canvasSize.w, canvasHeight: canvasSize.h }
          if (Array.isArray(dataNow.strokes) && dataNow.strokes.length > 0) {
            dataNow.timing = dataNow.timing ?? {}
            if (dataNow.timing.capturePerf0Ms == null && timingZeroRef.current != null) {
              dataNow.timing.capturePerf0Ms = timingZeroRef.current
            }
            await saveStrokes(submission_id, dataNow)
          }
        }
      } else if (hasInk) {
        // If they drew again now, update the strokes timeline on the same submission
        await saveStrokes(submission_id, payload)
        localStorage.setItem(lastKey, encHash)
        saveSubmittedCache(studentId, assignmentKeyForCache, pageIndex, payload)
        lastAppliedServerHash.current = encHash
        lastLocalHash.current = encHash
        localDirty.current = false
      }

      // ----- Audio handling -----
      if (hasAudioTakes) {
        // Merge: prior audio (if any) + new takes → single WAV, and save back to SAME submission
        const captureZero = (payload.timing?.capturePerf0Ms ??
                             timingZeroRef.current ??
                             performance.now())

        // Pull prior audio and include as the first take @ offset 0
        const prior = await getPrevAudioInfo(rtAssignmentId, curr.id, studentId)
        const allTakes: AudioTake[] = []
        if (prior.blob) {
          allTakes.push({ blob: prior.blob, startPerfMs: captureZero }) // offset 0
        }
        // add brand-new takes (already offset using onStart timing)
        for (const t of audioTakes.current) allTakes.push(t)

        const merged = await mergeAudioTakesToWav(allTakes, captureZero)
        await saveAudio(submission_id!, merged)
      }

      clearDraft(studentId, assignmentKeyForCache, pageIndex)
      showToast('Saved!', 'ok', 1200)
      justSavedAt.current = Date.now()
    } catch (e: any) {
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
    if (nextIndex < 0) return
    if (navLocked || blockedBySync(nextIndex)) return
    try { audioRef.current?.stop() } catch {}

    const current = drawRef.current?.getStrokes() || { strokes: [] }
    const hasInk   = Array.isArray(current.strokes) && current.strokes.length > 0
    const hasNewAudio = audioTakes.current.length > 0

    if (AUTO_SUBMIT_ON_PAGE_CHANGE && (hasInk || hasNewAudio)) {
      try { await submit() } catch { try { if (rtAssignmentId) saveDraft(studentId, assignmentKeyForCache, pageIndex, current) } catch {} }
    } else {
      try { if (rtAssignmentId) saveDraft(studentId, assignmentKeyForCache, pageIndex, current) } catch {}
    }

    // reset page-local audio
    audioTakes.current = []
    audioBlob.current = null
    pendingTakeStart.current = null
    timingZeroRef.current = null

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
    return ()=>{ host.removeEventListener('touchstart',onTS as any,true); host.removeEventListener('touchmove',onTM as any,true); host.removeEventListener('touchend',end as any,true); host.removeEventListener('touchcancel',end as any,true) }
  }, [handMode])

  const flipToolbarSide = ()=> {
    setToolbarOnRight(r=>{ const next=!r; try{ localStorage.setItem('toolbarSide', next?'right':'left') }catch{}; return next })
  }

  /* ---------- Realtime + polling (defensive) ---------- */
  useEffect(() => {
    if (!rtAssignmentId) return
    const ch = subscribeToAssignment(rtAssignmentId, {
      onSetPage: ({ pageIndex }: SetPagePayload) => {
        teacherPageIndexRef.current = pageIndex
        if (autoFollow) setPageIndex(prev => (prev !== pageIndex ? pageIndex : prev))
      },
      onFocus: ({ on, lockNav }: FocusPayload) => {
        setFocusOn(!!on)
        setNavLocked(!!on && !!lockNav)
      },
      onAutoFollow: ({ on, allowedPages, teacherPageIndex }: AutoFollowPayload) => {
        setAutoFollow(!!on)
        setAllowedPages(allowedPages ?? null)
        if (typeof teacherPageIndex === 'number') teacherPageIndexRef.current = teacherPageIndex
        if (on && typeof teacherPageIndexRef.current === 'number') {
          setPageIndex(teacherPageIndexRef.current)
        }
      },
      // listen for presence snapshots and cache/apply immediately
      onPresence: (p: TeacherPresenceState) => {
        try { localStorage.setItem(presenceKey(rtAssignmentId), JSON.stringify(p)) } catch {}
        setAutoFollow(!!p.autoFollow)
        setAllowedPages(p.allowedPages ?? null)
        setFocusOn(!!p.focusOn)
        setNavLocked(!!p.focusOn && !!p.lockNav)
        if (typeof p.teacherPageIndex === 'number') {
          teacherPageIndexRef.current = p.teacherPageIndex
          if (p.autoFollow) setPageIndex(prev => prev !== p.teacherPageIndex! ? p.teacherPageIndex! : prev)
        }
      }
    })
    return () => { try { ch?.unsubscribe?.() } catch {} }
  }, [rtAssignmentId, autoFollow])

  const reloadFromServer = async ()=>{
    if (!rtAssignmentId) return
    if (Date.now() - (justSavedAt.current || 0) < 1200) return
    if (localDirty.current && (Date.now() - (dirtySince.current || 0) < 5000)) return

    try{
      const pages = await listPages(rtAssignmentId)
      const curr = (pages || []).find((p:any) => p.page_index === pageIndex)
      if (!curr) return
      currIds.current = { assignment_id: rtAssignmentId, page_id: curr.id }

      const latest = await loadLatestSubmission(rtAssignmentId, curr.id, studentId)
      const strokesPayload = latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
      const normalized = normalizeStrokes(strokesPayload)

      const hasServerInk = Array.isArray(normalized?.strokes) && normalized.strokes.length > 0
      if (!hasServerInk) return

      const serverHash = await hashStrokes(normalized)
      if (serverHash === lastAppliedServerHash.current) return

      if (!localDirty.current) {
        drawRef.current?.loadStrokes(normalized)
        saveSubmittedCache(studentId, assignmentKeyForCache, pageIndex, normalized)
        lastAppliedServerHash.current = serverHash
        lastLocalHash.current = serverHash
      }
    } catch {/* ignore */}
  }

  useEffect(()=>{
    if (!rtAssignmentId) return
    let cleanup: (()=>void)|null = null
    let pollId: number | null = null
    let mounted = true

    ;(async ()=>{
      try{
        const pages = await listPages(rtAssignmentId)
        const curr = (pages || []).find((p:any) => p.page_index === pageIndex)
        if (!curr) return
        currIds.current = { assignment_id: rtAssignmentId, page_id: curr.id }

        const ch = supabase.channel(`art-strokes-${studentId}-${curr.id}`)
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'artifacts',
            filter: `page_id=eq.${curr.id},kind=eq.strokes`
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

  /* ---------- UI ---------- */
  const Toolbar = (
    <div
      style={{
        position:'fixed', right: toolbarOnRight?8:undefined, left: !toolbarOnRight?8:undefined, top:'50%', transform:'translateY(-50%)',
        zIndex:10010, width:150, maxHeight:'80vh',
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

      {/* Quick record mode + reset */}
      <div style={{ display:'flex', gap:6 }}>
        <button
          onClick={() => setRecordMode(m => (m === 'append' ? 'replace' : 'append'))}
          style={{ padding:'6px 8px', border:'1px solid #ddd', borderRadius:8, background:'#fff' }}
          title="Toggle recording mode"
        >
          Mode: {recordMode === 'append' ? 'Append' : 'Replace'}
        </button>
        <button
          onClick={() => { audioTakes.current = []; audioBlob.current = null; pendingTakeStart.current = null }}
          style={{ padding:'6px 8px', border:'1px solid #ddd', borderRadius:8, background:'#fff' }}
          title="Clear all audio for this page"
        >
          Reset Audio
        </button>
      </div>

      <div style={{ overflowY:'auto', overflowX:'hidden', paddingRight:4, maxHeight:'34vh' }}>
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
        <AudioRecorder
          ref={audioRef}
          maxSec={180}
          onStart={async (_ts: number) => {
            const RECORDING_ZERO_BIAS_MS = 3600
            const now = performance.now()

            // Default timing zero
            let t0 = now + RECORDING_ZERO_BIAS_MS

            // If we have a prior audio, append new takes *after* it
            try {
              const pages = await listPages(rtAssignmentId || '')
              const curr = (pages || []).find((p:any) => p.page_index === pageIndex)
              if (rtAssignmentId && curr?.id) {
                const prev = await getPrevAudioInfo(rtAssignmentId, curr.id, studentId)
                const baseZero =
                  prev.capturePerf0Ms ??
                  timingZeroRef.current ??
                  now
                t0 = baseZero + (prev.durationMs || 0) + RECORDING_ZERO_BIAS_MS
              }
            } catch { /* fallback to default t0 */ }

            timingZeroRef.current = t0
            try { (drawRef.current as any)?.markTimingZero?.(t0) } catch {}

            pendingTakeStart.current = now
            if (recordMode === 'replace') audioTakes.current = []
          }}
          onBlob={(b: Blob) => {
            const ts = pendingTakeStart.current ?? performance.now()
            audioTakes.current.push({ blob: b, startPerfMs: ts })
            audioBlob.current = b
            pendingTakeStart.current = null
          }}
        />

        <button onClick={submit}
          style={{ background: saving ? '#16a34a' : '#22c55e', opacity: saving?0.8:1,
            color:'#fff', padding:'8px 10px', borderRadius:10, border:'none' }} disabled={saving}>
          {saving ? 'Saving…' : 'Submit'}
        </button>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', padding:12, paddingBottom:12,
      ...(toolbarOnRight ? { paddingRight:150 } : { paddingLeft:150 }),
      background:'#fafafa', WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <h2>Student Assignment</h2>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <div style={{ padding:'6px 10px', border:'1px solid #e5e7eb', borderRadius:8, background:'#fff' }}>
            Student: <strong>{studentId}</strong>
          </div>
          <button onClick={()=> nav('/start')} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}>
            Switch
          </button>
        </div>
      </div>

      {/* Empty state when there is no assignment yet */}
      {!rtAssignmentId ? (
        <div style={{
          height:'calc(100vh - 160px)', display:'grid', placeItems:'center',
          background:'#fff', border:'1px solid #eee', borderRadius:12, marginTop:12
        }}>
          <div style={{ textAlign:'center' }}>
            <h3 style={{ margin:0 }}>No hay tareas todavía</h3>
            <p style={{ marginTop:8, color:'#6b7280' }}>Cuando el maestro suba una tarea, aparecerá aquí automáticamente.</p>
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scrollHostRef}
            style={{ height:'calc(100vh - 160px)', overflow:'auto', WebkitOverflowScrolling:'touch',
              touchAction: handMode ? 'auto' : 'none',
              display:'flex', alignItems:'flex-start', justifyContent:'center', padding:12,
              background:'#fff', border:'1px solid #eee', borderRadius:12, position:'relative' }}
          >
            <div style={{ position:'relative', width:`${canvasSize.w}px`, height:`${canvasSize.h}px` }}>
              <div style={{ position:'absolute', inset:0, zIndex:0 }}>
                {/* If pdfUrl is empty (e.g., latest assignment but page not found), PdfCanvas will render nothing */}
                <PdfCanvas url={pdfUrl ?? ''} pageIndex={pageIndex} onReady={onPdfReady} />
              </div>
              <div style={{
                  position:'absolute', inset:0, zIndex:10,
                  pointerEvents: handMode ? 'none' : 'auto'
                }}>
                <DrawCanvas ref={drawRef} width={canvasSize.w} height={canvasSize.h}
                  color={color} size={size} mode={handMode ? 'scroll' : 'draw'} tool={tool} />
              </div>
            </div>
          </div>

          {/* Floating pager */}
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
              disabled={saving || submitInFlight.current || navLocked || blockedBySync(Math.max(0, pageIndex-1))}
              style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
            >
              ◀ Prev
            </button>
            <span style={{ minWidth:90, textAlign:'center', fontWeight:600 }}>
              Page {pageIndex+1}
            </span>
            <button
              onClick={()=>goToPage(pageIndex+1)}
              disabled={saving || submitInFlight.current || navLocked || blockedBySync(pageIndex+1)}
              style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
            >
              Next ▶
            </button>
          </div>

          {/* Floating toolbar */}
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
        </>
      )}
    </div>
  )
}
