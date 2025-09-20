import { useEffect, useRef, useState } from 'react'

export default function AudioRecorder({ maxSec=180, onBlob }:{ maxSec?: number, onBlob: (b: Blob)=>void }){
  const [rec, setRec] = useState<MediaRecorder|null>(null)
  const [running, setRunning] = useState(false)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number>()

  const start = async()=>{
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true })
    const mr = new MediaRecorder(stream)
    mr.ondataavailable = e=> chunks.current.push(e.data)
    mr.onstop = ()=>{
      const blob = new Blob(chunks.current, { type: 'audio/webm' })
      chunks.current = []
      onBlob(blob)
    }
    mr.start()
    setRec(mr); setRunning(true)
    timer.current = window.setTimeout(()=> stop(), maxSec*1000)
  }
  const stop = ()=>{ rec?.stop(); rec?.stream.getTracks().forEach(t=>t.stop()); setRunning(false); if(timer.current) clearTimeout(timer.current) }

  useEffect(()=>()=>{ if(rec){ rec.stream.getTracks().forEach(t=>t.stop()) } },[rec])

  return (
    <div>
      {!running ? <button onClick={start}>Record</button> : <button onClick={stop}>Stop</button>}
    </div>
  )
}
