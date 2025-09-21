import { useRef, useState } from 'react'
import PdfCanvas from '../../components/PdfCanvas'
import DrawCanvas from '../../components/DrawCanvas'
import AudioRecorder from '../../components/AudioRecorder'

export default function StudentAssignment(){
  // Use your uploaded PDF
  const [pdfUrl] = useState<string>(`${import.meta.env.BASE_URL || '/' }aprende-m2.pdf`)
  const [pageIndex, setPageIndex] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 })
  const [color, setColor] = useState('#1F75FE')
  const [size, setSize] = useState(6)
  const [handMode, setHandMode] = useState(true) // default to Scroll so page can move
  const audioBlob = useRef<Blob | null>(null)

  const onPdfReady = (_pdf:any, canvas: HTMLCanvasElement)=>{
    setCanvasSize({ w: canvas.width, h: canvas.height })
  }

  const onAudio = (b: Blob)=>{ audioBlob.current = b }

  const submit = ()=>{
    alert(
      `Submit page ${pageIndex + 1}: audio=${!!audioBlob.current ? 'yes' : 'no'} (strokes drawn are on the canvas layer)`
    )
    audioBlob.current = null
  }

  return (
    <div style={{ minHeight:'100vh', padding: 12, paddingBottom: 96, background:'#fafafa' }}>
      <h2>Student Assignment (Hosted)</h2>

      {/* Stacked: PDF (bottom) + drawing canvas (top) */}
      <div
        style={{
          position: 'relative',
          width: `${canvasSize.w}px`,
          height: `${canvasSize.h}px`,
          margin: '12px auto',
          // In draw mode, prevent page scroll; in scroll mode, allow normal scroll.
          touchAction: handMode ? 'auto' : 'none'
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

      {/* Page nav */}
      <div style={{ display:'flex', gap:8, justifyContent:'center', marginBottom: 12 }}>
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
        <button onClick={submit} style={{ background:'#22c55e', color:'#fff', padding:'6px 12px', borderRadius:8 }}>Submit</button>
      </div>
    </div>
  )
}
