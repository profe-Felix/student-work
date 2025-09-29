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
    onStart, // now passes the perf timestamp
  }: {
    maxSec?: number
    onBlob: (blob: Blob) => void
    onStart?: (ts: number) => void
  },
  ref
) {
  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<BlobPart[]>([])
  const [recording, setRecording] = useState(false)
  const timeoutId = useRef<number | null>(null)

  // perf-clock start time & duration
  const audioStartPerfMs = useRef<number | undefined>(undefined)
  const audioDurationMs = useRef<number | undefined>(undefined)
  const startedAt = useRef<number | undefined>(undefined)

  async function start() {
    if (recording) return

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream)
    mediaRecorder.current = rec
    chunks.current = []

    // capture perf timestamp we’ll use everywhere
    const ts = performance.now()
    startedAt.current = ts
    audioStartPerfMs.current = ts

    rec.ondataavailable = (e: BlobEvent | any) => {
      const data: Blob = (e as any).data
      if (data && data.size > 0) chunks.current.push(data)
    }

    rec.onstop = () => {
      try { stream.getTracks().forEach(t => t.stop()) } catch {}
      const mime = rec.mimeType || 'audio/webm'
      const blob = new Blob(chunks.current, { type: mime })
      audioDurationMs.current = startedAt.current ? performance.now() - startedAt.current : undefined
      onBlob(blob)
    }

    rec.start()
    setRecording(true)

    // Notify caller with the exact perf timestamp we committed to
    try { onStart?.(ts) } catch {}

    if (timeoutId.current) clearTimeout(timeoutId.current)
    timeoutId.current = window.setTimeout(() => { stop().catch(()=>{}) }, maxSec * 1000)
  }

  async function stop() {
    if (!recording) return
    try { mediaRecorder.current?.stop() } catch {}
    setRecording(false)
    if (timeoutId.current) { clearTimeout(timeoutId.current); timeoutId.current = null }
  }

  useImperativeHandle(ref, () => ({
    start,
    stop,
    getAudioMeta: () => ({ audioStartPerfMs: audioStartPerfMs.current, durationMs: audioDurationMs.current })
  }))

  useEffect(() => {
    return () => { if (timeoutId.current) clearTimeout(timeoutId.current) }
  }, [])

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
