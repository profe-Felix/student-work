//src/pages/student/assignment.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle, StrokesPayload } from '../../components/DrawCanvas'
import AudioRecorder, { AudioRecorderHandle } from '../../components/AudioRecorder'
import {
  upsertAssignmentWithPage,
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
} from '../../lib/realtime'

/** Constants */
const assignmentTitle = 'Handwriting - Daily'
const DEFAULT_PDF_STORAGE_PATH = 'pdfs/aprende-m2.pdf'
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

  // storage path comes from DB page row
  const [pdfStoragePath, setPdfStoragePath] = useState<string>('')

  // Resolved URL used by PdfCanvas (bucket is really "pdfs")
  const [pdfUrl, setPdfUrl] = useState<string>('')
  const STORAGE_BUCKET = 'pdfs'
  function keyForBucket(path: string) {
    if (!path) return ''
    let k = path.replace(/^\/+/, '')     // strip leading slash
    k = k.replace(/^public\//, '')       // strip "public/" prefix
    k = k.replace(/^pdfs\//, '')         // strip "pdfs/" if present; keys should be relative to bucket
    return k
  }
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!pdfStoragePath) { setPdfUrl(''); return }
      const key = keyForBucket(pdfStoragePath)
      // Prefer a signed URL (works even for private bucket)
      const { data: sData } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 60 * 60) // 1h
      if (!cancelled && sData?.signedUrl) { setPdfUrl(sData.signedUrl); return }
      // Fallback to public URL if signing isn’t allowed / not needed
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

  // assignment/page cache for realtime filter
  const currIds = useRef<{assignment_id?:string, page_id?:string}>({})
  const [rtAssignmentId, setRtAssignmentId] = useState<string>('')

  // Realtime teacher controls
  const [focusOn, setFocusOn] = useState(false)
  const [navLocked, setNavLocked] = useState(false)
  const [autoFollow, setAutoFollow] = useState(false)
  const [allowedPages, setAllowedPages] = useState<number[] | null>(null)
  const teacherPageIndexRef = useRef<number | null>(null)

  // hashes/dirty tracking
  const lastAppliedServerHash = useRef<string>('')   // last server ink we applied
  const lastLocalHash = useRef<string>('')           // last local canvas snapshot
  const localDirty = useRef<boolean>(false)
  const dirtySince = useRef<number>(0)
  const justSavedAt = useRef<number>(0)              // ignore window after save

  // assignment handoff listener (teacher broadcast)
  useEffect(() => {
    const off = subscribeToGlobal((nextAssignmentId) => {
      setRtAssignmentId(nextAssignmentId)
      setPageIndex(0) // snap to page 0 on switch
      currIds.current = {}
    })
    return off
  }, [])

  // Resolve assignment/page depending on whether we have a teacher-provided assignment
  async function ensureIds(): Promise<{ assignment_id: string, page_id: string }> {
    if (rtAssignmentId) {
      const pages = await listPages(rtAssignmentId)
      const curr = pages.find(p => p.page_index === pageIndex) ?? pages[0]
      if (!curr) throw new Error('No pages available for assignment')
      currIds.current = { assignment_id: rtAssignmentId, page_id: curr.id }
      setPdfStoragePath(curr.pdf_path || '')
      return { assignment_id: rtAssignmentId, page_id: curr.id }
    }
    // Fallback boot path (your original upsert)
    const ids = await upsertAssignmentWithPage(assignmentTitle, DEFAULT_PDF_STORAGE_PATH, pageIndex)
    currIds.current = ids
    if (!rtAssignmentId && ids.assignment_id) setRtAssignmentId(ids.assignment_id!)
    try {
      const pages = await listPages(ids.assignment_id!)
      const curr = pages.find(p => p.page_index === pageIndex) ?? pages[0]
      setPdfStoragePath(curr?.pdf_path || DEFAULT_PDF_STORAGE_PATH)
    } catch {}
    return ids as { assignment_id: string, page_id: string }
  }

  /* ---------- Page load: clear, then draft → server → cache ---------- */
  useEffect(()=>{
    let cancelled=false
    try { drawRef.current?.clearStrokes(); audioRef.current?.stop() } catch {}

    ;(async ()=>{
      try{
        const draft = loadDraft(studentId, assignmentTitle, pageIndex)
        if (draft?.strokes) {
          try { drawRef.current?.loadStrokes(normalizeStrokes(draft.strokes)) } catch {}
          try { lastLocalHash.current = await hashStrokes(normalizeStrokes(draft.strokes)) } catch {}
        } else {
          lastLocalHash.current = ''
        }

        const { assignment_id, page_id } = await ensureIds()
        if (!rtAssignmentId && assignment_id) setRtAssignmentId(assignment_id!)

        try {
          const latest = await loadLatestSubmission(assignment_id, page_id, studentId)
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
              const cached = loadSubmittedCache(studentId, assignmentTitle, pageIndex)
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
        const cached = loadSubmittedCache(studentId, assignmentTitle, pageIndex)
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
          saveDraft(studentId, assignmentTitle, pageIndex, data)
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
          saveDraft(studentId, assignmentTitle, pageIndex, data)
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
      try { const data = drawRef.current?.getStrokes(); if (data) saveDraft(studentId, assignmentTitle, pageIndex, data) } catch {}
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return ()=>{
      stop()
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [pageIndex, studentId])

  /* ---------- Submit (dirty-check) + cache ---------- */
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
      const lastKey = lastHashKey(studentId, assignmentTitle, pageIndex)
      const last = localStorage.getItem(lastKey)
      if (last && last === encHash && !hasAudio) { setSaving(false); submitInFlight.current=false; return }

      const ids = currIds.current.assignment_id ? (currIds.current as any) : await ensureIds()
      currIds.current = ids
      if (!rtAssignmentId) setRtAssignmentId(ids.assignment_id!)

      const submission_id = await createSubmission(studentId, ids.assignment_id!, ids.page_id!)

      if (hasInk) {
        await saveStrokes(submission_id, strokes)
        localStorage.setItem(lastKey, encHash)
        saveSubmittedCache(studentId, assignmentTitle, pageIndex, strokes)
        lastAppliedServerHash.current = encHash
        lastLocalHash.current = encHash
        localDirty.current = false
      }
      if (hasAudio) {
        await saveAudio(submission_id, audioBlob.current!)
        audioBlob.current = null
      }

      clearDraft(studentId, assignmentTitle, pageIndex)
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
    if (nextIndex < 0) return
    if (navLocked || blockedBySync(nextIndex)) return
    try { audioRef.current?.stop() } catch {}

    const current = drawRef.current?.getStrokes() || { strokes: [] }
    const hasInk   = Array.isArray(current.strokes) && current.strokes.length > 0
    const hasAudio = !!audioBlob.current

    if (AUTO_SUBMIT_ON_PAGE_CHANGE && (hasInk || hasAudio)) {
      try { await submit() } catch { try { saveDraft(studentId, assignmentTitle, pageIndex, current) } catch {} }
    } else {
      try { saveDraft(studentId, assignmentTitle, pageIndex, current) } catch {}
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
    return ()=>{ host.removeEventListener('touchstart',onTS as any,true); host.removeEventListener('touchmove',onTM as any,true); host.removeEventListener('touchend',end as any,true); host.removeEventListener('touchcancel',end as any,true) }
  }, [handMode])

  const flipToolbarSide = ()=> {
    setToolbarOnRight(r=>{ const next=!r; try{ localStorage.setItem('toolbarSide', next?'right':'left') }catch{}; return next })
  }

  /* ---------- Realtime + polling (defensive) ---------- */

  // subscribe to teacher broadcast once we know the assignment id
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
      }
    })
    return () => { try { ch?.unsubscribe?.() } catch {} }
  }, [rtAssignmentId, autoFollow])

  const reloadFromServer = async ()=>{
    if (Date.now() - (justSavedAt.current || 0) < 1200) return
    if (localDirty.current && (Date.now() - (dirtySince.current || 0) < 5000)) return

    try{
      const { assignment_id, page_id } = currIds.current.assignment_id
        ? currIds.current as any
        : await ensureIds()
      currIds.current = { assignment_id, page_id }
      if (!rtAssignmentId) setRtAssignmentId(assignment_id!)

      const latest = await loadLatestSubmission(assignment_id!, page_id!, studentId)
      const strokesPayload = latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
      const normalized = normalizeStrokes(strokesPayload)

      const hasServerInk = Array.isArray(normalized?.strokes) && normalized.strokes.length > 0
      if (!hasServerInk) return

      const serverHash = await hashStrokes(normalized)
      if (serverHash === lastAppliedServerHash.current) return

      if (!localDirty.current) {
        drawRef.current?.loadStrokes(normalized)
        saveSubmittedCache(studentId, assignmentTitle, pageIndex, normalized)
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
        const ids = currIds.current.assignment_id
          ? currIds.current as any
          : await ensureIds()
        currIds.current = ids
        if (!rtAssignmentId) setRtAssignmentId(ids.assignment_id!)

        const ch = supabase.channel(`art-strokes-${studentId}-${ids.page_id}`)
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
            color:'#fff', padding:'8px 10px', borderRadius:10, border:'none' }} disabled={saving}>
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
          <button onClick={()=> nav('/start')} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}>
            Switch
          </button>
        </div>
      </div>

      <div
        ref={scrollHostRef}
        style={{ height:'calc(100vh - 160px)', overflow:'auto', WebkitOverflowScrolling:'touch', touchAction:'none',
          display:'flex', alignItems:'flex-start', justifyContent:'center', padding:12,
          background:'#fff', border:'1px solid #eee', borderRadius:12, position:'relative' }}
      >
        <div style={{ position:'relative', width:`${canvasSize.w}px`, height:`${canvasSize.h}px` }}>
          <div style={{ position:'absolute', inset:0, zIndex:0 }}>
            <PdfCanvas url={pdfUrl ?? ''} pageIndex={pageIndex} onReady={onPdfReady} />
          </div>
          <div style={{ position:'absolute', inset:0, zIndex:10 }}>
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
    </div>
  )
}
