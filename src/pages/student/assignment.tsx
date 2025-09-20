import { useRef, useState } from 'react'
import PdfCanvas from '../../components/PdfCanvas'
import KonvaStage, { Stroke } from '../../components/KonvaStage'
import AudioRecorder from '../../components/AudioRecorder'

export default function StudentAssignment(){
  const [pdfUrl] = useState<string>(`${import.meta.env.BASE_URL || '/' }sample.pdf`) // replace with assignment PDF
  const [pageIndex, setPageIndex] = useState(0)
  const [canvasSize, setCanvasSize] = useState({w: 800, h: 600})
  const [color, setColor] = useState('#1F75FE')
  const [size, setSize] = useState(6)
  const strokes = useRef<Stroke[]>([])
  const audioBlob = useRef<Blob|null>(null)

  const onPdfReady = (_pdf:any, canvas: HTMLCanvasElement)=>{
    setCanvasSize({ w: canvas.width, h: canvas.height })
  }

  const onStroke = (s: Stroke)=>{ strokes.current.push(s) }
  const onAudio = (b: Blob)=>{ audioBlob.current = b }

  const submit = ()=>{
    // TODO: upload strokes.current as JSON and audioBlob.current to storage
    alert(`Submit page ${pageIndex+1}: strokes=${strokes.current.length}, audio=${!!audioBlob.current}`)
    strokes.current = []
    audioBlob.current = null
  }

  return (
    <div style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        <button onClick={()=>setPageIndex(p=>Math.max(0,p-1))}>Prev</button>
        <span style={{ margin: '0 8px' }}>Page {pageIndex+1}</span>
        <button onClick={()=>setPageIndex(p=>p+1)}>Next</button>
      </div>
      <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
      <KonvaStage width={canvasSize.w} height={canvasSize.h} color={color} size={size} onStroke={onStroke} />
      <div style={{ display:'flex', gap:8, marginTop:8 }}>
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
