import { useRef, useState } from 'react'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas from '../../components/DrawCanvas'
import AudioRecorder from '../../components/AudioRecorder'

export default function StudentAssignment(){
  // Default to your uploaded PDF in /public
  const [pdfUrl] = useState<string>(`${import.meta.env.BASE_URL || '/' }aprende-m2.pdf`)
  const [pageIndex, setPageIndex]   = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })

  const [color, setColor] = useState('#1F75FE')
  const [size,  setSize]  = useState(6)
  const [handMode, setHandMode] = useState(true) // default to Scroll

  const audioBlob = useRef<Blob | null>(null)

  // IMPORTANT: use CSS size (not backing store size) so DrawCanvas aligns perfectly
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

  return (
    <div style={{ minHeight:'100vh', padding: 12, paddingBottom: 96, background:'#fafafa' }}>
      <h2>Student Assignment (Hosted)</h2>

      {/* Scrollable panel so two-finger gestures scroll/pinch */}
      <div
  style={{
    height: 'calc(100vh - 140px)',
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    touchAction: 'pan-y pinch-zoom',   // <— was 'auto'
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    padding: 12,
    background: '#fff',
    border: '1px solid #eee',
    borderRadius: 12,
    // avoid text selection/callout on long palm rests
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none'
  }}
>

        {/* PDF + Draw stack (no touchAction here) */}
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

      {/* Fixed bottom toolbar */}
      <div style={{
        position:'fixed', left:0, right:0, bottom:0, zIndex:10000,
        background:'#fff', borderTop:'1px solid #e5e7eb', padding:'8px 12px',
        display:'flex', gap:8, alignItems:'center', justifyContent:'center'
      }}>
        <label>Color <input type="color" value={color} onChange={e=>setColor(e.target.value)} /></label>
        <label>Size
          <select value={size} onChange={e=>setSize(parseInt(e.target.value))}>
            <option value={3}>S</option>
            <option value={6}>M</option>
            <option value={10}>L</option>
          </select>
        </label>
        <AudioRecorder maxSec={180} onBlob={onAudio} />
        <button onClick={submit} style={{ background:'#22c55e', color:'#fff', padding:'6px 12px', borderRadius:8 }}>
          Submit
        </button>
      </div>
    </div>
  )
}
