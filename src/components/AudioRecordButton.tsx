// src/components/AudioRecordButton.tsx
import React, { useEffect, useRef, useState } from 'react'

type Props = {
  disabled?: boolean
  onStart: () => void                 // called right before recording starts
  onStop: (blob: Blob, mime: string, durationMs: number) => void
  onLongHint?: (elapsedMs: number) => void // called at 3min then every 2min
}

export default function AudioRecordButton({ disabled, onStart, onStop, onLongHint }: Props) {
  const [recState, setRecState] = useState<'idle'|'recording'>('idle')
  const mrRef = useRef<MediaRecorder|null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const startAtRef = useRef<number>(0)
  const hintTimerRef = useRef<number| null>(null)
  const hintPhaseRef = useRef<0|1|2|3>(0) // 0: first hint at 3min, then every 2min cycles

  useEffect(() => {
    return () => {
      try { if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop() } catch {}
      if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current)
    }
  }, [])

  async function start() {
    if (disabled || recState === 'recording') return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    let mime = ''
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) mime = 'audio/webm;codecs=opus'
    else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4'
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    mrRef.current = mr
    chunksRef.current = []
    startAtRef.current = performance.now()
    setRecState('recording')
    onStart()

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
    }
    mr.onstop = () => {
      const elapsed = Math.max(0, Math.round(performance.now() - startAtRef.current))
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      setRecState('idle')
      try {
        stream.getTracks().forEach(t => t.stop())
      } catch {}
      if (hintTimerRef.current) window.clearTimeout(hintTimerRef.current)
      hintPhaseRef.current = 0
      onStop(blob, mr.mimeType || 'audio/webm', elapsed)
    }
    mr.start(250) // small timeslice for fast flush

    // long-record hints: first at 3min, then every 2min
    const scheduleHint = (ms: number) => {
      hintTimerRef.current = window.setTimeout(() => {
        const elapsed = Math.round(performance.now() - startAtRef.current)
        onLongHint?.(elapsed)
        const nextDelay = hintPhaseRef.current === 0 ? 2*60_000 : 2*60_000
        hintPhaseRef.current = 1
        scheduleHint(nextDelay)
      }, ms)
    }
    scheduleHint(3*60_000)
  }

  function stop() {
    if (recState !== 'recording') return
    try { mrRef.current?.stop() } catch {}
  }

  return (
    <div style={{ display:'flex', gap:8 }}>
      <button
        onClick={start}
        disabled={disabled || recState==='recording'}
        style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', background: recState==='recording' ? '#ddd' : '#f0fdf4' }}
        title="Start recording"
      >
        🎙️ Record
      </button>
      <button
        onClick={stop}
        disabled={recState!=='recording'}
        style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', background:'#fee2e2' }}
        title="Stop"
      >
        ⏹ Stop
      </button>
    </div>
  )
}
