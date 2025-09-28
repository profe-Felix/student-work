// src/components/PlaybackDrawer.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

export type Props = {
  onClose: () => void
  student: string
  pdfUrl: string
  pageIndex: number
  strokesPayload: any // may be string | object | array
  audioUrl?: string
}

type Size = { w: number; h: number }
type TimedPoint = { x: number; y: number; t?: number }
type Stroke = { color?: string; size?: number; points: TimedPoint[] }

type Seg = {
  x0: number; y0: number; x1: number; y1: number;
  color: string; size: number; t: number; // seconds from start
}

function coerceStrokes(payload: any): Stroke[] {
  try {
    if (typeof payload === 'string') payload = JSON.parse(payload)
    if (Array.isArray(payload)) return payload as Stroke[]
    if (payload && Array.isArray(payload.strokes)) return payload.strokes as Stroke[]
    if (payload && Array.isArray(payload.lines)) return payload.lines as Stroke[]
  } catch {}
  return []
}

function buildSegments(strokes: Stroke[]): Seg[] {
  const segs: Seg[] = []
  for (const s of strokes) {
    const pts = s.points || []
    if (pts.length < 2) continue
    const hasT = typeof pts[0]?.t === 'number'
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1]
      const p1 = pts[i]
      let t = hasT ? (p1.t as number) : i * 0.012 // 12ms fallback in seconds
      segs.push({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y, color: s.color || '#111', size: s.size || 4, t })
    }
  }
  if (!segs.length) return segs
  const t0 = Math.min(...segs.map(s => s.t))
  for (const s of segs) s.t -= t0
  const maxAfterShift = Math.max(...segs.map(s => s.t))
  if (maxAfterShift > 600) { // looks like ms -> convert to s
    for (const s of segs) s.t = s.t / 1000
  }
  segs.sort((a, b) => a.t - b.t)
  return segs
}

export default function PlaybackDrawer({
  onClose,
  student,
  pdfUrl,
  pageIndex,
  strokesPayload,
  audioUrl,
}: Props) {
  const [size, setSize] = useState<Size>({ w: 800, h: 600 })
  const [pdfReady, setPdfReady] = useState(false)

  const strokes: Stroke[] = useMemo(() => coerceStrokes(strokesPayload), [strokesPayload])
  const segs: Seg[] = useMemo(() => buildSegments(strokes), [strokes])

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const rafRef = useRef<number | null>(null)
  const [pdfSnapshot, setPdfSnapshot] = useState<HTMLImageElement | null>(null)

  function onPdfReady(info: { width?: number; height?: number; cssWidth?: number; cssHeight?: number }) {
    const w = info.width ?? info.cssWidth ?? 800
    const h = info.height ?? info.cssHeight ?? 600
    setSize({ w, h })
    setPdfReady(true)

    requestAnimationFrame(() => {
      if (!pdfHostRef.current) return
      const innerCanvas = pdfHostRef.current.querySelector('canvas') as HTMLCanvasElement | null
      if (!innerCanvas) return
      try {
        const url = innerCanvas.toDataURL('image/png')
        const img = new Image()
        img.onload = () => setPdfSnapshot(img)
        img.src = url
      } catch {
        setPdfSnapshot(null)
      }
    })

    requestAnimationFrame(() => drawAtTime('static'))
  }

  function renderFrame(ctx: CanvasRenderingContext2D, timeSec: number | 'static') {
    const W = size.w, H = size.h
    ctx.clearRect(0, 0, W, H)
    let lastColor = ''
    let lastSize = -1
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (timeSec !== 'static' && s.t > timeSec) break
      if (s.color !== lastColor) { ctx.strokeStyle = s.color; lastColor = s.color }
      if (s.size !== lastSize) { ctx.lineWidth = s.size; lastSize = s.size }
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      ctx.lineTo(s.x1, s.y1)
      ctx.stroke()
    }
  }

  function drawAtTime(time: number | 'static') {
    const c = overlayRef.current
    if (!c) return
    if (!pdfReady) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    renderFrame(ctx, time)
  }

  function startLiveSync() {
    cancelLiveSync()
    const loop = () => {
      const el = audioRef.current
      const t = el ? el.currentTime : 0
      drawAtTime(t)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }

  function cancelLiveSync() {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }

  // Attach audio listeners once element is available, and whenever segs/pdfReady change
  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const ensureDrawNow = () => {
      if (!pdfReady) return
      drawAtTime(el.currentTime)
    }

    const onPlay = () => {
      if (!pdfReady) {
        // Wait until PDF is ready, then start syncing
        const id = requestAnimationFrame(function wait() {
          if (pdfReady) startLiveSync()
          else requestAnimationFrame(wait)
        })
        return
      }
      startLiveSync()
    }
    const onPause = () => { cancelLiveSync(); ensureDrawNow() }
    const onSeeked = () => { ensureDrawNow() }
    const onTimeUpdate = () => { if (!rafRef.current) ensureDrawNow() } // keeps UI responsive when paused/scrubbing
    const onEnded = () => { cancelLiveSync(); drawAtTime('static') }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('ended', onEnded)

    // Initial frame
    ensureDrawNow()

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ended', onEnded)
      cancelLiveSync()
    }
  }, [pdfReady, size.w, size.h, segs.length])

  // Export to WebM (desktop capable browsers)
  async function exportWebM() {
    const W = size.w, H = size.h
    if (W <= 0 || H <= 0 || !pdfReady) {
      alert('PDF page size not ready yet.')
      return
    }

    const off = document.createElement('canvas')
    off.width = W
    off.height = H
    const ctx = off.getContext('2d')
    if (!ctx) { alert('Canvas not supported'); return }

    let audioStream: MediaStream | null = null
    const audioEl = audioRef.current || undefined

    if (audioEl) {
      const anyAudio = audioEl as any
      if (typeof anyAudio.captureStream === 'function') {
        try { audioStream = anyAudio.captureStream() as MediaStream } catch { audioStream = null }
      }
    }
    if (!audioStream && audioEl) {
      try {
        const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext
        const ac = new AC()
        const src = ac.createMediaElementSource(audioEl)
        const dest = ac.createMediaStreamDestination()
        src.connect(dest)
        src.connect(ac.destination)
        audioStream = dest.stream
      } catch {
        audioStream = null
      }
    }

    const fps = 60
    const anyCanvas = off as any
    const videoStream: MediaStream | undefined = typeof anyCanvas.captureStream === 'function'
      ? anyCanvas.captureStream(fps)
      : undefined
    if (!videoStream) { alert('Canvas captureStream not supported in this browser.'); return }

    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...(audioStream ? audioStream.getAudioTracks() : []),
    ])

    const preferred = 'video/webm;codecs=vp9,opus'
    const mime = (window as any).MediaRecorder && (MediaRecorder as any).isTypeSupported && MediaRecorder.isTypeSupported(preferred)
      ? preferred
      : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime })
    const chunks: BlobPart[] = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${student || 'student'}_page${pageIndex + 1}.webm`
      a.click()
      URL.revokeObjectURL(url)
    }

    const drawPdf = (() => {
      if (pdfSnapshot) {
        return () => { ctx.drawImage(pdfSnapshot, 0, 0, W, H) }
      }
      return () => {
        const innerCanvas = pdfHostRef.current?.querySelector('canvas') as HTMLCanvasElement | null
        if (innerCanvas) ctx.drawImage(innerCanvas, 0, 0, W, H)
      }
    })()

    const drawInkAt = (timeSec: number) => {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      let lastColor = ''
      let lastSize = -1
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        if (s.t > timeSec) break
        if (s.color !== lastColor) { ctx.strokeStyle = s.color; lastColor = s.color }
        if (s.size !== lastSize) { ctx.lineWidth = s.size; lastSize = s.size }
        ctx.beginPath()
        ctx.moveTo(s.x0, s.y0)
        ctx.lineTo(s.x1, s.y1)
        ctx.stroke()
      }
    }

    if (!audioEl) { alert('No audio found to sync export.'); return }

    audioEl.currentTime = 0
    try { await audioEl.play() } catch {}

    rec.start(100)
    const loop = () => {
      const t = audioEl.currentTime
      ctx.clearRect(0, 0, W, H)
      drawPdf()
      drawInkAt(t)
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)

    const onEnded = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rec.stop()
      audioEl.removeEventListener('ended', onEnded)
    }
    audioEl.addEventListener('ended', onEnded)
  }

  function downloadStrokes() {
    const blob = new Blob([JSON.stringify({ strokes })], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${student || 'student'}_strokes.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(17,24,39,0.55)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: '#fff',
          width: 'min(1200px, 96vw)',
          height: 'min(92vh, 980px)',
          margin: '2vh auto',
          borderRadius: 12,
          boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            borderBottom: '1px solid #e5e7eb',
            background: '#f9fafb',
          }}
        >
          <strong style={{ fontSize: 14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              onClick={() => {
                const el = audioRef.current
                if (!el) return
                if (el.paused) el.play().catch(() => {})
                else el.pause()
              }}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
              title="Play/Pause (synced)"
            >
              Play/Pause
            </button>
            <button
              onClick={downloadStrokes}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
              title="Download strokes JSON"
            >
              Download JSON
            </button>
            <button
              onClick={exportWebM}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
              title="Export WebM (video + audio)"
            >
              Export WebM
            </button>
            <button
              onClick={onClose}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          {audioUrl ? (
            <audio ref={audioRef} controls src={audioUrl} style={{ width: 'min(600px, 100%)' }} />
          ) : (
            <span style={{ fontSize: 12, color: '#6b7280' }}>No audio</span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
            Page {pageIndex + 1}
          </span>
        </div>

        {/* Content */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: '#fafafa' }}>
          <div ref={pdfHostRef} style={{ position: 'relative', width: `${size.w}px`, margin: '12px auto' }}>
            <div style={{ position: 'relative' }}>
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
              <canvas
                ref={overlayRef}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${size.w}px`,
                  height: `${size.h}px`,
                  pointerEvents: 'none',
                }}
                width={size.w}
                height={size.h}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
