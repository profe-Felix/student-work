import { useEffect, useRef, useState } from 'react'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas, { DrawCanvasHandle } from '../../components/DrawCanvas'
import AudioRecorder, { AudioRecorderHandle } from '../../components/AudioRecorder'
import {
  ensureStudent, upsertAssignmentWithPage,
  createSubmission, saveStrokes, saveAudio, loadLatestSubmission
} from '../../lib/db'

const studentId = 'A_01'
const assignmentTitle = 'Handwriting - Daily'
const pdfStoragePath = 'pdfs/aprende-m2.pdf'

// Crayola 24
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

function Swatch({ hex, selected, onClick }:{ hex:string; selected:boolean; onClick:()=>void }){
  return (
    <button onClick={onClick}
      style={{ width:40, height:40, borderRadius:10, border:selected?'3px solid #111':'2px solid #ddd',
        background:hex, boxShadow:selected?'0 0 0 2px #fff inset':'none' }}
      aria-label={`Color ${hex}`} />
  )
}

type Tool = 'pen'|'highlighter'|'eraser'|'eraserObject'

export default function StudentAssignment(){
  const [pdfUrl] = useState<string>(`${import.meta.env.BASE_URL || '/' }aprende-m2.pdf`)
  const [pageIndex, setPageIndex]   = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true)
  const [tool, setTool] = useState<Tool>('pen')
  const [saving, setSaving] = useState(false)

  const [toolbarRight, setToolbarRight] = useState<boolean>(()=>{ try{ return localStorage.getItem('toolbarSide')!=='left' }catch{return true} })

  const drawRef = useRef<DrawCanvasHandle>(null)
  const audioRef = useRef<AudioRecorderHandle>(null)
  const audioBlob = useRef<Blob|null>(null)

  const onPdfReady = (_pdf:any, canvas:HTMLCanvasElement)=>{
    const cssW = Math.round(parseFloat(getComputedStyle(canvas).width))
    const cssH = Math.round(parseFloat(getComputedStyle(canvas).height))
    setCanvasSize({ w: cssW, h: cssH })
  }
  const onAudio = (b:Blob)=>{ audioBlob.current = b }

  // Load per-page submission; if none, CLEAR strokes so pages don't leak ink
  useEffect(()=>{
    let cancelled=false
    ;(async ()=>{
      try{
        // stop any recording when page changes
        audioRef.current?.stop()
        await ensureStudent(studentId)
        const { assignment_id, page_id } = await upsertAssignmentWithPage(assignmentTitle, pdfStoragePath, pageIndex)
        const latest = await loadLatestSubmission(assignment_id, page_id, studentId)
        if (cancelled) return
        const strokes = latest?.artifacts?.find((a:any)=>a.kind==='strokes')?.strokes_json
        if (strokes) { drawRef.current?.loadStrokes(strokes) }
        else { drawRef.current?.clearStrokes() } // <-- important: no leak across pages
      }catch(e){ console.warn('Load failed:', e) }
    })()
    return ()=>{ cancelled=true }
  }, [pageIndex])

  const submit = async ()=>{
    try{
      setSaving(true)
      await ensureStudent(studentId)
      const { assignment_id, page_id } = await upsertAssignmentWithPage(assignmentTitle, pdfStoragePath, pageIndex)
      const submission_id = await createSubmission(studentId, assignment_id, page_id)

      const strokes = drawRef.current?.getStrokes()
      if (strokes) await saveStrokes(submission_id, strokes)
      if (audioBlob.current) await saveAudio(submission_id, audioBlob.current)

      alert('Saved!')
      audioBlob.current = null
    } catch (e:any){
      console.error(e)
      alert('Failed to save: ' + (e?.message || e))
    } finally { setSaving(false) }
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

  const flipToolbarSide = ()=>{
    setToolbarRight(r=>{ const next=!r; try{ localStorage.setItem('toolbarSide', next?'right':'left') }catch{}; return next })
  }

  const Toolbar = (
    <div
      style={{
        position:'fixed', ...(toolbarRight?{right:8}:{left:8}), top:'50%', transform:'translateY(-50%)',
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
            <Swatch key={c.hex} hex={c.hex} selected={color===c.hex} onClick={()=>{ setColor(c.hex); setTool('pen') }} />
          ))}
        </div>
        <div style={{ fontSize:12, fontWeight:600, margin:'10px 0 4px' }}>Skin</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 40px)', gap:8 }}>
          {SKIN_TONES.map(c=>(
            <Swatch key={c.hex} hex={c.hex} selected={color===c.hex} onClick={()=>{ setColor(c.hex); setTool('pen') }} />
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
      ...(toolbarRight ? { paddingRight:130 } : { paddingLeft:130 }),
      background:'#fafafa', WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none' }}>
      <h2>Student Assignment (Hosted)</h2>

      <div ref={scrollHostRef}
        style={{ height:'calc(100vh - 120px)', overflow:'auto', WebkitOverflowScrolling:'touch', touchAction:'none',
          display:'flex', alignItems:'flex-start', justifyContent:'center', padding:12,
          background:'#fff', border:'1px solid #eee', borderRadius:12 }}>
        <div style={{ position:'relative', width:`${canvasSize.w}px`, height:`${canvasSize.h}px` }}>
          <div style={{ position:'absolute', inset:0, zIndex:0 }}>
            <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
          </div>
          <div style={{ position:'absolute', inset:0, zIndex:10 }}>
            <DrawCanvas ref={drawRef} width={canvasSize.w} height={canvasSize.h}
              color={color} size={size} mode={handMode ? 'scroll' : 'draw'} tool={tool} />
          </div>
        </div>
      </div>

      <div style={{ display:'flex', gap:8, justifyContent:'center', margin:'12px 0' }}>
        <button onClick={()=>setPageIndex(p=>Math.max(0,p-1))}>Prev</button>
        <span style={{ margin:'0 8px' }}>Page {pageIndex+1}</span>
        <button onClick={()=>setPageIndex(p=>p+1)}>Next</button>
      </div>

      {Toolbar}
    </div>
  )
}
