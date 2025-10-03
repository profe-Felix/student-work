import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

export type AudioRecorderHandle = {
  stop: () => void
  reset: () => void
}

export default forwardRef<AudioRecorderHandle, {
  maxSec: number
  onBlob: (b:Blob)=>void
}>(function AudioRecorder({ maxSec, onBlob }, ref){

  const mediaRef = useRef<MediaRecorder|null>(null)
  const chunksRef= useRef<BlobPart[]>([])
  const timerRef = useRef<number|null>(null)
  const [recording, setRecording] = useState(false)
  const [sec, setSec] = useState(0)

  useImperativeHandle(ref, ()=>({
    stop(){ doStop() },
    reset(){ setSec(0); setRecording(false); chunksRef.current=[] }
  }), [])

  useEffect(()=>()=>{ if(timerRef.current) window.clearInterval(timerRef.current) },[])

  const doStart = async ()=>{
    if (recording) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true })
    const mr = new MediaRecorder(stream)
    mediaRef.current = mr
    chunksRef.current = []
    mr.ondataavailable = (e)=>{ if(e.data && e.data.size) chunksRef.current.push(e.data) }
    mr.onstop = ()=>{
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      onBlob(blob)
      // stop tracks
      stream.getTracks().forEach(t=>t.stop())
    }
    mr.start()
    setRecording(true); setSec(0)
    timerRef.current = window.setInterval(()=>{
      setSec(s=>{
        if (s+1 >= maxSec){ doStop() }
        return s+1
      })
    }, 1000)
  }

  const doStop = ()=>{
    if (timerRef.current){ window.clearInterval(timerRef.current); timerRef.current=null }
    if (mediaRef.current && mediaRef.current.state !== 'inactive'){
      mediaRef.current.stop()
    }
    setRecording(false)
  }

  return (
    <div style={{ display:'flex', gap:8, alignItems:'center' }}>
      <button onClick={recording? doStop : doStart}
        style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #ddd',
          background: recording ? '#ef4444' : '#f3f4f6', color: recording ? '#fff' : '#111' }}>
        {recording ? 'Stop' : 'Record'}
      </button>
      <span style={{ fontVariantNumeric:'tabular-nums', minWidth:48, textAlign:'right' }}>
        {Math.floor(sec/60)}:{String(sec%60).padStart(2,'0')}
      </span>
    </div>
  )
})
