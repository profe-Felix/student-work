// src/pages/student/assignment.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle, StrokesPayload } from '../../components/DrawCanvas'
import AudioRecorder, { AudioRecorderHandle } from '../../components/AudioRecorder'
import {
  createSubmission, saveStrokes, saveAudio, loadLatestSubmission,
  supabase, getPageId,
} from '../../lib/db'
import { subscribeToAssignment, type AutoFollowPayload, type FocusPayload } from '../../lib/realtime'

/** Fallback constants (used only if no teacher presence yet) */
const FALLBACK_ASSIGNMENT_TITLE = 'Handwriting - Daily'
/** Served from your site bundle (public/aprende-m2.pdf), not Supabase: */
const FALLBACK_PDF_URL = `${import.meta.env.BASE_URL || '/'}aprende-m2.pdf`

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
const draftKey      = (student:string, assignment:string, page:number)=> `draft:${student}:${assignment}:${page}`
const lastHashKey   = (student:string, assignment:string, page:number)=> `lastHash:${student}:${assignment}:${page}`
const submittedKey  = (student:string, assignment:string, page:number)=> `submitted:${student}:${assignment}:${page}`

function normalizeStrokes(data: unknown): StrokesPayload {
  if (!data || typeof data !== 'object') return { strokes: [] }
  const arr = Array.isArray((data as any).strokes) ? (data as any).strokes : []
  return { strokes: arr }
}

function saveDraft(student:string, assignment:string, page:number, strokes:any){
  try { localStorage.setItem(draftKey(student, assignment, page), JSON.stringify({ t: Date.now(), strokes })) } catch {}
}
function loadDraft(student:string, assignment:string, page:number){
  try { const raw = localStorage.getItem(draftKey(student, assignment, page)); return raw ? JSON.parse(raw) : null } catch { return null }
}
function clearDraft(student:string, assignment:string, page:number){
  try { localStorage.removeItem(draftKey(student, assignment, page)) } catch {}
}
function saveSubmittedCache(student:string, assignment:string, page:number, strokes:any){
  try { localStorage.setItem(submittedKey(student, assignment, page), JSON.stringify({ t: Date.now(), strokes })) } catch {}
}
function loadSubmittedCache(student:string, assignment:string, page:number){
  try { const raw = localStorage.getItem(submittedKey(student, assignment, page)); return raw ? JSON.parse(raw) : null } catch { return null }
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

export default function StudentAssignment(){
  const location = useLocation()
  const nav = useNavigate()
  const studentId = useMemo(()=>{
    const qs = new URLSearchParams(location.search)
    const id = qs.get('student') || localStorage.getItem('currentStudent') || 'A_01'
    localStorage.setItem('currentStudent', id)
    return id
  }, [location.search])

  // Assignment chosen by teacher (falls back to default)
  const [assignmentId, setAssignmentId] = useState<string | null>(null)

  // PDF that we actually render
  const [pdfUrl, setPdfUrl] = useState<string>('')   // start empty, we’ll set fallback in useEffect

  // page state
  const [pageIndex, setPageIndex]   = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true)
  const [tool, setTool] = useState<Tool>('pen')
  const [saving, setSaving] = useState(false)
  const submitInFlight = useRef(false)

  const [navLocked, setNavLocked] = useState(false)
  const [focusOn, setFocusOn] = useState(false)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)

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

  // Convert "bucket/key" (from teacher) to public URL
  const toPublicUrl = (storagePath: string) => {
    const [bucket, ...rest] = storagePath.split('/')
    const path = rest.join('/')
    const { data } = supabase.storage.from(bucket).getPublicUrl(path)
    return data.publicUrl
  }

  // ==== Teacher presence / auto-follow ====
  useEffect(() => {
    // Subscribe to teacher channel keyed by fallback assignment title (so we learn the real one)
    const ch = subscribeToAssignment(FALLBACK_ASSIGNMENT_TITLE, {
      onAutoFollow: (p: AutoFollowPayload) => {
        if (p.assignmentId) setAssignmentId(p.assignmentId)
        if (typeof p.teacherPageIndex === 'number') setPageIndex(p.teacherPageIndex)
        setAllowedPages(p.allowedPages ?? null)
        if (p.assignmentPdfPath) {
          setPdfUrl(toPublicUrl(p.assignmentPdfPath))
        }
      },
      onFocus: (f: FocusPayload) => {
        setFocusOn(!!f.on)
        setNavLocked(!!f.on && !!f.lockNav)
      },
      onSetPage: ({ pageIndex }) => {
        if (typeof pageIndex === 'number') setPageIndex(pageIndex)
      }
    })
    return () => { ch?.unsubscribe?.() }
  }, [])

  // Fallback initial PDF URL if teacher hasn't broadcast yet
  useEffect(() => {
    if (!pdfUrl) {
      setPdfUrl(FALLBACK_PDF_URL)
    }
  }, [pdfUrl])

  // assignment/page ids for submission
  const currIds = useRef<{assignment_id?:string, page_id?:string}>({})

  // hashes/dirty tracking
  const lastAppliedServerHash = useRef<string>('')   // last server ink we applied
  const lastLocalHash = useRef<string>('')           // last local canvas snapshot
  const localDirty = useRef<boolean>(false)
  const dirtySince = useRef<number>(0)
  const justSavedAt = useRef<number>(0)

  /* ---------- Page load: clear, then draft → server → cache ---------- */
  useEffect(()=>{
    let cancelled=false
    try { drawRef.current?.clearStrokes(); audioRef.current?.stop() } catch {}

    ;(async ()=>{
      try{
        const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
        const draft = loadDraft(studentId, titleKey, pageIndex)
        if (draft?.strokes) {
          try { drawRef.current?.loadStrokes(normalizeStrokes(draft.strokes)) } catch {}
          try { lastLocalHash.current = await hashStrokes(normalizeStrokes(draft.strokes)) } catch {}
        } else {
          lastLocalHash.current = ''
        }

        const aId = assignmentId // presence-driven if available
        let page_id: string | undefined
        if (aId) {
          try { page_id = await getPageId(aId, pageIndex) } catch {}
        }

        currIds.current = { assignment_id: aId ?? undefined, page_id }

        try {
          if (aId && page_id) {
            const latest = await loadLatestSubmission(aId, page_id, studentId)
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
                const cached = loadSubmittedCache(studentId, titleKey, pageIndex)
                if (cached?.strokes) {
                  const normC = normalizeStrokes(cached.strokes)
                  drawRef.current?.loadStrokes(normC)
                  lastLocalHash.current = await hashStrokes(normC)
                }
              }
            }
          }
        } catch {/* ignore */}
      }catch(e){
        console.error('init load failed', e)
        const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
        const cached = loadSubmittedCache(studentId, titleKey, pageIndex)
        if (cached?.strokes) {
          const norm = normalizeStrokes(cached.strokes)
          try { drawRef.current?.loadStrokes(norm); lastLocalHash.current = await hashStrokes(norm) } catch {}
        }
      }
    })()

    return ()=>{ cancelled=true }
  }, [pageIndex, studentId, assignmentId])

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
          const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
          saveDraft(studentId, titleKey, pageIndex, data)
        }
      } catch {}
    }
    id = window.setInterval(tick, 800)
    return ()=>{ if (id!=null) window.clearInterval(id) }
  }, [pageIndex, studentId, assignmentId])

  /* ---------- Draft autosave ---------- */
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
          const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
          saveDraft(studentId, titleKey, pageIndex, data)
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
      try { const data = drawRef.current?.getStrokes(); if (data) {
        const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
        saveDraft(studentId, titleKey, pageIndex, data)
      }} catch {}
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return ()=>{
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [pageIndex, studentId, assignmentId])

  /* ---------- Submit + cache ---------- */
  const submit = async ()=>{
    if (submitInFlight.current) return
    submitInFlight.current = true
    try{
      setSaving(true)
      const strokes = drawRef.current?.getStrokes() || { strokes: [] }
      const hasInk   = Array.isArray(strokes?.strokes) && strokes.strokes.length > 0
      const hasAudio = !!audioBlob.current
      if (!hasInk && !hasAudio) { setSaving(false); submitInFlight.current=false; return }

      const encHash = await hashStrokes(strokes)
      const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
      const lastKey = lastHashKey(studentId, titleKey, pageIndex)
      const last = localStorage.getItem(lastKey)
      if (last && last === encHash && !hasAudio) { setSaving(false); submitInFlight.current=false; return }

      // need assignment & page ids
      let aId = assignmentId ?? undefined
      if (!aId) {
        showToast('Waiting for teacher assignment…', 'err', 1500)
        setSaving(false); submitInFlight.current=false; return
      }
      const pId = await getPageId(aId, pageIndex)
      currIds.current = { assignment_id: aId, page_id: pId }

      const submission_id = await createSubmission(studentId, aId, pId)

      if (hasInk) {
        await saveStrokes(submission_id, strokes)
        localStorage.setItem(lastKey, encHash)
        saveSubmittedCache(studentId, titleKey, pageIndex, strokes)
        lastAppliedServerHash.current = encHash
        lastLocalHash.current = encHash
        localDirty.current = false
      }
      if (hasAudio) {
        await saveAudio(submission_id, audioBlob.current!)
        audioBlob.current = null
      }

      clearDraft(studentId, titleKey, pageIndex)
      showToast('Saved!', 'ok', 1200)
      justSavedAt.current = Date.now()
    } catch (e:any){
      console.error(e); showToast('Save failed', 'err', 1800)
    } finally {
      setSaving(false)
      submitInFlight.current = false
    }
  }

  const goToPage = async (nextIndex:number)=>{
    if (nextIndex < 0) return
    // obey teacher allow-list if present
    if (allowedPages && !allowedPages.includes(nextIndex)) return
    if (navLocked) return

    try { audioRef.current?.stop() } catch {}

    const current = drawRef.current?.getStrokes() || { strokes: [] }
    const hasInk   = Array.isArray(current.strokes) && current.strokes.length > 0
    const hasAudio = !!audioBlob.current

    if (AUTO_SUBMIT_ON_PAGE_CHANGE && (hasInk || hasAudio)) {
      try { await submit() } catch {
        const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
        try { saveDraft(studentId, titleKey, pageIndex, current) } catch {}
      }
    } else {
      const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
      try { saveDraft(studentId, titleKey, pageIndex, current) } catch {}
    }

    setPageIndex(nextIndex)
  }

  // polling to pick up server updates
  const reloadFromServer = async ()=>{
    if (!assignmentId) return
    if (Date.now() - (justSavedAt.current || 0) < 1200) return
    if (localDirty.current && (Date.now() - (dirtySince.current || 0) < 5000)) return

    try{
      const pId = await getPageId(assignmentId, pageIndex)
      currIds.current = { assignment_id: assignmentId, page_id: pId }

      const latest = await loadLatestSubmission(assignmentId, pId, studentId)
      const strokesPayload = latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
      const normalized = normalizeStrokes(strokesPayload)

      const hasServerInk = Array.isArray(normalized?.strokes) && normalized.strokes.length > 0
      if (!hasServerInk) return

      const serverHash = await hashStrokes(normalized)
      if (serverHash === lastAppliedServerHash.current) return

      if (!localDirty.current) {
        drawRef.current?.loadStrokes(normalized)
        const titleKey = assignmentId ?? FALLBACK_ASSIGNMENT_TITLE
        saveSubmittedCache(studentId, titleKey, pageIndex, normalized)
        lastAppliedServerHash.current = serverHash
        lastLocalHash.current = serverHash
      }
    } catch {/* ignore */}
  }

  useEffect(()=>{
    let cleanup: (()=>void)|null = null
    let pollId: number | null = null
    let mounted = true

    ;(async ()=>{
      try{
        if (!assignmentId) return
        const pId = await getPageId(assignmentId, pageIndex)
        currIds.current = { assignment_id: assignmentId, page_id: pId }

        const ch = supabase.channel(`art-strokes-${studentId}-${pId}`)
          .on('postgres_changes', {
            event: '*', schema: 'public', table: 'artifacts',
            filter: `page_id=eq.${pId},kind=eq.strokes`
          }, ()=> reloadFromServer())
          .subscribe()

        cleanup = ()=> { supabase.removeChannel(ch) }
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
  }, [studentId, pageIndex, assignmentId])

  /* ---------- UI ---------- */
  return (
    <div style={{ minHeight:'100vh', padding:12, paddingBottom:12,
      ...(toolbarOnRight ? { paddingRight:130 } : { paddingLeft:130 }),
      background:'#fafafa', WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none' }}>

      {/* Focus overlay + lock banner */}
      {focusOn && (
        <div
          style={{
            position:'fixed', inset:0, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(2px)',
            zIndex:20000, display:'grid', placeItems:'center', color:'#fff', fontSize:20, fontWeight:700
          }}
        >
          Focus Mode — watch the teacher ✋
        </div>
      )}
      {allowedPages && (
        <div style={{ position:'fixed', top:8, left:'50%', transform:'translateX(-50%)',
          background:'#111', color:'#fff', padding:'6px 10px', borderRadius:999, zIndex:20010, fontSize:12 }}>
          Teacher enabled Sync • Allowed pages: {allowedPages.map(p => p+1).join(', ')}
        </div>
      )}

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

      <div
        style={{ height:'calc(100vh - 160px)', overflow:'auto', WebkitOverflowScrolling:'touch', touchAction:'none',
          display:'flex', alignItems:'flex-start', justifyContent:'center', padding:12,
          background:'#fff', border:'1px solid #eee', borderRadius:12, position:'relative' }}
      >
        <div style={{ position:'relative', width:`${canvasSize.w}px`, height:`${canvasSize.h}px` }}>
          <div style={{ position:'absolute', inset:0, zIndex:0 }}>
            <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
          </div>
          <div style={{ position:'absolute', inset:0, zIndex:10, pointerEvents: focusOn ? 'none' : 'auto' }}>
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
          background:'#fff', border:'1px solid '#e5e7eb', borderRadius:999,
          boxShadow:'0 6px 16px rgba(0,0,0,0.15)', padding:'8px 12px'
        }}
      >
        <button
          onClick={()=>goToPage(Math.max(0, pageIndex-1))}
          disabled={saving || submitInFlight.current || navLocked}
          style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
        >
          ◀ Prev
        </button>
        <span style={{ minWidth:90, textAlign:'center', fontWeight:600 }}>
          Page {pageIndex+1}
        </span>
        <button
          onClick={()=>goToPage(pageIndex+1)}
          disabled={saving || submitInFlight.current || navLocked}
          style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#f9fafb' }}
        >
          Next ▶
        </button>
      </div>

      {/* Your toolbar + audio UI (unchanged) */}
      {/* ... keep your existing toolbar/audio components here ... */}

      {toast && <Toast text={toast.msg} kind={toast.kind} />}
    </div>
  )
}
