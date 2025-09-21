import { useEffect, useRef, useState } from 'react'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas from '../../components/DrawCanvas'
import AudioRecorder from '../../components/AudioRecorder'

// Crayola 24 (approx hex values)
const CRAYOLA_24 = [
  { name:'Red',         hex:'#EE204D' }, { name:'Yellow',      hex:'#FCE883' },
  { name:'Blue',        hex:'#1F75FE' }, { name:'Green',       hex:'#1CAC78' },
  { name:'Orange',      hex:'#FF7538' }, { name:'Purple',      hex:'#926EAE' },
  { name:'Black',       hex:'#000000' }, { name:'White',       hex:'#FFFFFF' },
  { name:'Brown',       hex:'#B4674D' }, { name:'Pink',        hex:'#FFBCD9' },
  { name:'Gray',        hex:'#95918C' }, { name:'Violet',      hex:'#7F00FF' },
  { name:'Red-Orange',  hex:'#FF5349' }, { name:'Yellow-Orange',hex:'#FFB653' },
  { name:'Yellow-Green',hex:'#C5E384' }, { name:'Blue-Green',  hex:'#0095B7' },
  { name:'Blue-Violet', hex:'#7366BD' }, { name:'Red-Violet',  hex:'#C0448F' },
  { name:'Cerulean',    hex:'#1DACD6' }, { name:'Indigo',      hex:'#4F69C6' },
  { name:'Scarlet',     hex:'#FC2847' }, { name:'Magenta',     hex:'#F664AF' },
  { name:'Peach',       hex:'#FFCBA4' }, { name:'Tan',         hex:'#ECE1D3' },
]

// Crayola “Colors of the World” (12 common tones for compact UI)
const SKIN_TONES = [
  { name:'Ultra Light',   hex:'#FDE6D0' }, { name:'Very Light',    hex:'#F5D2B8' },
  { name:'Light',         hex:'#EDC3A6' }, { name:'Light-Medium',  hex:'#E5B294' },
  { name:'Medium',        hex:'#D9A07F' }, { name:'Medium-Tan',    hex:'#C88B6B' },
  { name:'Tan',           hex:'#B97B5E' }, { name:'Medium-Deep',   hex:'#A86A4E' },
  { name:'Deep',          hex:'#94583F' }, { name:'Very Deep',     hex:'#7C4936' },
  { name:'Rich Deep',     hex:'#643B2C' }, { name:'Ultra Deep',    hex:'#4E2F24' },
]

function Swatch({ hex, selected, onClick }: { hex:string; selected:boolean; onClick:()=>void }){
  return (
    <button
      onClick={onClick}
      style={{
        width: 34, height: 34, borderRadius: 9999,
        border: selected ? '3px solid #111' : '2px solid #ddd',
        background: hex, boxShadow: selected ? '0 0 0 2px #fff inset' : 'none'
      }}
      aria-label={`Color ${hex}`}
    />
  )
}

type Tool = 'pen' | 'highlighter' | 'eraser'

export default function StudentAssignment(){
  const [pdfUrl] = useState<string>(`${import.meta.env.BASE_URL || '/' }aprende-m2.pdf`)
  const [pageIndex, setPageIndex]   = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true) // default to Scroll
  const [tool, setTool] = useState<Tool>('pen')

  const [toolbarRight, setToolbarRight] = useState<boolean>(() => {
    try { return localStorage.getItem('toolbarSide') !== 'left' } catch { return true }
  })

  const audioBlob = useRef<Blob | null>(null)

  const onPdfReady = (_pdf:any, canvas: HTMLCanvasElement)=>{
    const cssW = Math.round(parseFloat(getComputedStyle(canvas).width))
    const cssH = Math.round(parseFloat(getComputedStyle(canvas).height))
    setCanvasSize({ w: cssW, h: cssH })
  }

  const onAudio = (b: Blob)=>{ audioBlob.current = b }

  const submit = ()=>{
    alert(`Submit page ${pageIndex + 1}: audio=${!!audioBlob.current ? 'yes' : 'no'}`)
    audioBlob.current = null
  }

  // ----- MANUAL TWO-FINGER PAN on the scroll panel -----
  const scrollHostRef = useRef<HTMLDivElement|null>(null)
  useEffect(()=>{
    const host = scrollHostRef.current
    if (!host) return

    let panActive = false
    let startY = 0, startX = 0
    let startScrollTop = 0, startScrollLeft = 0

    const onTouchStart = (e: TouchEvent)=>{
      if (e.touches.length >= 2 && !handMode) {
        panActive = true
        const t1 = e.touches[0], t2 = e.touches[1]
        startY = (t1.clientY + t2.clientY) / 2
        startX = (t1.clientX + t2.clientX) / 2
        startScrollTop = host.scrollTop
        startScrollLeft = host.scrollLeft
      }
    }
    const onTouchMove = (e: TouchEvent)=>{
      if (panActive && e.touches.length >= 2) {
        e.preventDefault()
        const t1 = e.touches[0], t2 = e.touches[1]
        const y = (t1.clientY + t2.clientY) / 2
        const x = (t1.clientX + t2.clientX) / 2
        host.scrollTop  = startScrollTop  - (y - startY)
        host.scrollLeft = startScrollLeft - (x - startX)
      }
    }
    const endPan = ()=>{ panActive = false }

    host.addEventListener('touchstart', onTouchStart, { passive: true,  capture: true })
    host.addEventListener('touchmove',  onTouchMove,  { passive: false, capture: true })
    host.addEventListener('touchend',   endPan,       { passive: true,  capture: true })
    host.addEventListener('touchcancel',endPan,       { passive: true,  capture: true })
    return ()=>{
      host.removeEventListener('touchstart', onTouchStart as any, true)
      host.removeEventListener('touchmove',  onTouchMove  as any, true)
      host.removeEventListener('touchend',   endPan       as any, true)
      host.removeEventListener('touchcancel',endPan       as any, true)
    }
  }, [handMode])

  const flipToolbarSide = ()=>{
    setToolbarRight(r=>{
      const next = !r
      try { localStorage.setItem('toolbarSide', next ? 'right' : 'left') } catch {}
      return next
    })
  }

  const Toolbar = (
    <div
      style={{
        position:'fixed',
        ...(toolbarRight ? { right:8 } : { left:8 }),
        top:'50%', transform:'translateY(-50%)',
        zIndex: 10010,
        width: 92, maxHeight:'80vh',
        display:'flex', flexDirection:'column', gap:10,
        padding:10, background:'#ffffff', border:'1px solid #e5e7eb', borderRadius:12,
        boxShadow:'0 6px 16px rgba(0,0,0,0.15)',
        WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none',
        overflow:'hidden'
      }}
      onTouchStart={(e)=>{ e.stopPropagation() }}
    >
      {/* Side + Mode row */}
      <div style={{ display:'flex', gap:6 }}>
        <button
          onClick={flipToolbarSide}
          title="Flip toolbar side"
          style={{ flex:1, background:'#f3f4f6', border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 0' }}
        >⇄</button>
        <button
          onClick={()=>setHandMode(m=>!m)}
          style={{
            flex:1,
            background: handMode ? '#f3f4f6' : '#34d399',
            color: handMode ? '#111827' : '#064e3b',
            border:'1px solid #e5e7eb', borderRadius:8, padding:'6px 0', fontWeight:600
          }}
          aria-label={handMode ? 'Switch to Draw' : 'Switch to Scroll'}
        >
          {handMode ? '✋' : '✍️'}
        </button>
      </div>

      {/* Tool buttons */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
        {[
          {label:'Pen', icon:'✏️', val:'pen'},
          {label:'Hi',  icon:'🖍️', val:'highlighter'},
          {label:'Erase',icon:'🧽', val:'eraser'},
        ].map(t=>(
          <button key={t.val}
            onClick={()=>setTool(t.val as Tool)}
            style={{
              padding:'6px 0', borderRadius:8, border: '1px solid #ddd',
              background: tool===t.val ? '#111' : '#fff', color: tool===t.val ? '#fff' : '#111'
            }}
            title={t.label}
          >
            {t.icon}
          </button>
        ))}
      </div>

      {/* Sizes */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6 }}>
        {[
          {label:'S', val:3},
          {label:'M', val:6},
          {label:'L', val:10},
        ].map(s=>(
          <button key={s.label}
            onClick={()=>setSize(s.val)}
            style={{
              padding:'6px 0', borderRadius:8, border: '1px solid #ddd',
              background: size===s.val ? '#111' : '#fff', color: size===s.val ? '#fff' : '#111'
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Colors (scrollable) */}
      <div style={{ overflowY:'auto', paddingRight:4, maxHeight:'48vh' }}>
        <div style={{ fontSize:12, fontWeight:600, margin:'6px 0 4px' }}>Crayons</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 34px)', gap:8 }}>
          {CRAYOLA_24.map(c=>(
            <Swatch key={c.hex} hex={c.hex} selected={color===c.hex} onClick={()=>{ setColor(c.hex); setTool('pen') }} />
          ))}
        </div>

        <div style={{ fontSize:12, fontWeight:600, margin:'10px 0 4px' }}>Skin</div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 34px)', gap:8 }}>
          {SKIN_TONES.map(c=>(
            <Swatch key={c.hex} hex={c.hex} selected={color===c.hex} onClick={()=>{ setColor(c.hex); setTool('pen') }} />
          ))}
        </div>
      </div>

      {/* Audio + Submit */}
      <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
        <AudioRecorder maxSec={180} onBlob={onAudio} />
        <button onClick={submit}
          style={{ background:'#22c55e', color:'#fff', padding:'8px 10px', borderRadius:10, border:'none' }}>
          Submit
        </button>
      </div>
    </div>
  )

  return (
    <div
      style={{
        minHeight:'100vh',
        padding: 12,
        paddingBottom: 12,
        ...(toolbarRight ? { paddingRight: 110 } : { paddingLeft: 110 }),
        background:'#fafafa',
        WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none'
      }}
    >
      <h2>Student Assignment (Hosted)</h2>

      {/* Scrollable panel; ref used for manual two-finger pan */}
      <div
        ref={scrollHostRef}
        style={{
          height: 'calc(100vh - 120px)',
          overflow: 'auto',
          WebkitOverflowScrolling: 'touch',
          // 'none' so our manual pan works with preventDefault
          touchAction: 'none',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: 12,
          background: '#fff',
          border: '1px solid #eee',
          borderRadius: 12,
        }}
      >
        {/* PDF + Draw stack */}
        <div
          style={{
            position: 'relative',
            width: `${canvasSize.w}px`,
            height: `${canvasSize.h}px`
          }}
        >
          <div style={{ position: 'absolute', inset: 0, zIndex: 0 }}>
            <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
          </div>

          <div style={{ position: 'absolute', inset: 0, zIndex: 10 }}>
            <DrawCanvas
              width={canvasSize.w}
              height={canvasSize.h}
              color={color}
              size={size}
              mode={handMode ? 'scroll' : 'draw'}
              tool={tool}
            />
          </div>
        </div>
      </div>

      {/* Page nav */}
      <div style={{ display:'flex', gap:8, justifyContent:'center', margin: '12px 0' }}>
        <button onClick={()=>setPageIndex(p=>Math.max(0,p-1))}>Prev</button>
        <span style={{ margin: '0 8px' }}>Page {pageIndex+1}</span>
        <button onClick={()=>setPageIndex(p=>p+1)}>Next</button>
      </div>

      {/* Vertical toolbar (left or right) */}
      {Toolbar}
    </div>
  )
}
