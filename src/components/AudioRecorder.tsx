import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'

export type AudioRecorderHandle = {
  start: () => Promise<void>
  stop: () => Promise<void>
  getAudioMeta: () => { audioStartPerfMs?: number; durationMs?: number }
}

export default forwardRef(function AudioRecorder(
  {
    maxSec = 180,
    onBlob,
  }: {
    maxSec?: number
    onBlob: (blob: Blob) => void
  },
  ref
) {
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<BlobPart[]>([])
  const [recording, setRecording] = useState(false)
  const timeoutId = useRef<number | null>(null)

  // NEW: perf-clock start time & duration
  const audioStartPerfMs = useRef<number | undefined>(undefined)
  const audioDurationMs = useRef<number | undefined>(undefined)
  const startedAt = useRef<number | undefined>(undefined)

  async function start() {
    if (recording) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream)
    mediaRecorder.current = rec
    chunks.current = []
    startedAt.current = performance.now()
    audioStartPerfMs.current = startedAt.current

    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.current.push(e.data) }
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      const blob = new Blob(chunks.current, { type: 'audio/webm' })
      audioDurationMs.current = startedAt.current ? performance.now() - startedAt.current : undefined
      onBlob(blob)
    }

    rec.start()
    setRecording(true)
    if (timeoutId.current) clearTimeout(timeoutId.current)
    timeoutId.current = window.setTimeout(() => { stop().catch(()=>{}) }, maxSec * 1000)
  }

  async function stop() {
    if (!recording) return
    mediaRecorder.current?.stop()
    setRecording(false)
    if (timeoutId.current) { clearTimeout(timeoutId.current); timeoutId.current = null }
  }

  useImperativeHandle(ref, () => ({
    start, stop,
    getAudioMeta: () => ({ audioStartPerfMs: audioStartPerfMs.current, durationMs: audioDurationMs.current })
  }))

  useEffect(() => () => { if (timeoutId.current) clearTimeout(timeoutId.current) }, [])

  return (
    <div style={{ display:'flex', gap:8 }}>
      <button
        onClick={() => start().catch(()=>{})}
        disabled={recording}
        style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #ddd', background:'#fff' }}
      >
        {recording ? 'Recording…' : 'Record'}
      </button>
      <button
        onClick={() => stop().catch(()=>{})}
        disabled={!recording}
        style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #ddd', background:'#fff' }}
      >
        Stop
      </button>
    </div>
  )
})
