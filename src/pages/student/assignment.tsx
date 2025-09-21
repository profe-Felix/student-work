import { useEffect, useRef, useState } from 'react'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas from '../../components/DrawCanvas'
import AudioRecorder from '../../components/AudioRecorder'

export default function StudentAssignment(){
  const [pdfUrl] = useState<string>(`${import.meta.env.BASE_URL || '/' }aprende-m2.pdf`)
  const [pageIndex, setPageIndex]   = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true) // default to Scroll

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
    let startY = 0
    let startX = 0
    let startScrollTop = 0
    let startScrollLeft = 0

    // capture=true so we see the touches even if they start on the canvas
    const onTouchStart = (e: TouchEvent)=>{
      if (e.touches.length >= 2) {
        // only enable manual pan while in Draw mode
        if (!handMode) {
          panActive = true
          const t1 = e.touches[0]
          const t2 = e.touches[1]
          startY = (t1.clientY + t2.clientY) / 2
          startX = (t1.clientX + t2.clientX) / 2
          startScrollTop = host.scrollTop
          startScrollLeft = host.scrollLeft
        }
      }
    }

    const onTouchMove = (e: TouchEvent)=>{
      if (panActive && e.touches.length >= 2) {
        // manual panning — preventDefault stops page rubber banding
        e.preventDefault()
        const t1 = e.touches[0]
        const t2 = e.touches[1]
        const y = (t1.clientY + t2.clientY) / 2
        const x = (t1.clientX + t2.clientX) / 2
        host.scrollTop  = startScrollTop  - (y - startY)
        host.scrollLeft = startScrollLeft - (x - startX)
      }
    }

    const endPan = ()=>{
      panActive = false
    }

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

  return (
    <div style={{ minHeight:'100vh', padding: 12, paddingBottom: 96, background:'#fafafa',
                  WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none' }}>
      <h2>Student Assignment (Hosted)</h2>

      {/* Scrollable panel; we also attach a ref to manually pan when two fingers are down */}
      <div
        ref={scrollHostRef}
        style={{
          height: 'calc(100vh - 140px)',
          overflow: 'auto',
          WebkitOverflowScrolling: 'touch',
          // IMPORTANT: 'none' so our manual pan works with preventDefault
          touchAction: 'none',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          padding: 12,
          background: '#fff',
          border: '1px solid #eee',
          borderRadius: 12,
          WebkitUserSelect: 'none',
          userSelect: 'none',
          WebkitTouchCallout: 'none'
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

      {/* Floating Scroll/Draw toggle */}
      <button
        onClick={()=>setHandMode(m=>!m)}
        style={{
          position:'fixed', right:12, top:12, zIndex: 10000,
          background: handMode ? '#f3f4f6' : '#34d399',
          color: handMode ? '#111827' : '#064e3b',
          border:'1px solid #e5e7eb', borderRadius: 9999, padding: '10px 14px',
          boxShadow:'0 2px 8px rgba(0,0,0,0.15)'
        }}
        aria-label={handMode ? 'Switch to Draw' : 'Switch to Scroll'}
      >
        {handMode ? '✋ Scroll' : '✍️ Draw'}
      </button>

      {/* Fixed bottom toolbar (no blue selection/copy) */}
      <div style={{
        position:'fixed', left:0, right:0, bottom:0, zIndex:10000,
        background:'#fff', borderTop:'1px solid #e5e7eb', padding:'8px 12px',
        display:'flex', gap:8, alignItems:'center', justifyContent:'center',
        WebkitUserSelect:'none', userSelect:'none', WebkitTouchCallout:'none'
      }}
        onTouchStart={(e)=>{ /* prevent long-press selection/callout */ e.preventDefault() }}
      >
        <label>Color <input type="color" value={color} onChange={e=>setColor(e.target.value)} /></label>
        <label>Size
          <select value={size} onChange={e=>setSize(parseInt(e.target.value))}>
            <option value={3}>S</option>
            <option value={6}>M</option>
            <option value={10}>L</option>
          </select>
        </label>
        <AudioRecorder maxSec={180} onBlob={(b)=>{ audioBlob.current = b }} />
        <button onClick={submit} style={{ background:'#22c55e', color:'#fff', padding:'6px 12px', borderRadius:8 }}>
          Submit
        </button>
      </div>
    </div>
  )
}
