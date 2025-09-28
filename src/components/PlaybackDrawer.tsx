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
  let maxT = 0
  for (const s of strokes) {
    const pts = s.points || []
    if (pts.length < 2) continue
    const hasT = typeof pts[0]?.t === 'number'
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1]
      const p1 = pts[i]
      let t = hasT ? (p1.t as number) : i * 0.012 // 12ms fallback in *seconds*
      segs.push({
        x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y,
        color: s.color || '#111', size: s.size || 4, t
      })
      if (t > maxT) maxT = t
    }
  }
  if (!segs.length) return segs

  // Normalize timestamps:
  // 1) Shift so first segment starts at 0 (handles absolute timestamps)
  const t0 = Math.min(...segs.map(s => s.t))
  for (const s of segs) s.t -= t0

  // 2) If values look like milliseconds (very large), convert to seconds
  const maxAfterShift = Math.max(...segs.map(s => s.t))
  if (maxAfterShift > 600) { // >10 minutes likely ms
    for (const s of segs) s.t = s.t / 1000
  }

  // Sort by time
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

  // Parsed strokes and precomputed timeline
  const strokes: Stroke[] = useMemo(() => coerceStrokes(strokesPayload), [strokesPayload])
  const segs: Seg[] = useMemo(() => buildSegments(strokes), [strokes])

  // Refs for canvases & audio
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null) // wrapper around PdfCanvas to locate its inner <canvas>
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Animation (synced to audio currentTime)
  const rafRef = useRef<number | null>(null)

  // Snapshot of the PDF page (drawn once for export loop)
  const [pdfSnapshot, setPdfSnapshot] = useState<HTMLImageElement | null>(null)

  // Ensure overlay canvas follows the PDF canvas size
  function onPdfReady(info: { width?: number; height?: number; cssWidth?: number; cssHeight?: number }) {
    const w = info.width ?? info.cssWidth ?? 800
    const h = info.height ?? info.cssHeight ?? 600
    setSize({ w, h })

    // Capture a snapshot of the PDF canvas for faster export rendering
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
        // If tainted (shouldn't be, since pdfjs draws locally), just skip snapshot;
        // export will still work by copying the canvas each frame.
        setPdfSnapshot(null)
      }
    })

    // Also draw static strokes immediately
    requestAnimationFrame(() => drawAtTime('static'))
  }

  // Draw helper: draw all segments with t <= timeSec
  function renderFrame(ctx: CanvasRenderingContext2D, timeSec: number | 'static') {
    const W = size.w, H = size.h
    ctx.clearRect(0, 0, W, H)

    // We only draw ink on the overlay. The PDF is a separate canvas beneath for preview.
    // For export, we draw the PDF snapshot elsewhere (see exportWebM).
    // Here we only render strokes.
    let lastColor = ''
    let lastSize = -1
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Draw all segments up to time
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
    const ctx = c.getContext('2d')
    if (!ctx) return
    // Keep canvas in device pixels, not just CSS
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    renderFrame(ctx, time)
  }

  // Live sync loop (ties to audio currentTime)
  function startLiveSync() {
    cancelLiveSync()
    const loop = () => {
      const t = audioRef.current ? audioRef.current.currentTime : 0
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

  // Start/stop sync when audio plays/pauses or on mount/unmount
  useEffect(() => {
    const el = audioRef.current
    if (!el) return

    const onPlay = () => startLiveSync()
    const onPause = () => {
      cancelLiveSync()
      // draw the exact paused frame
      drawAtTime(el.currentTime)
    }
    const onSeeked = () => drawAtTime(el.currentTime)
    const onEnded = () => { cancelLiveSync(); drawAtTime('static') }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('ended', onEnded)

    // Initial static draw
    drawAtTime('static')

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('ended', onEnded)
      cancelLiveSync()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, segs.length])

  // Export to WebM: composite PDF + ink onto an offscreen canvas, record + mux audio
  async function exportWebM() {
    const W = size.w, H = size.h
    if (W <= 0 || H <= 0) {
      alert('PDF page size not ready yet.')
      return
    }

    // Build composition canvas
    const off = document.createElement('canvas')
    off.width = W
    off.height = H
    const ctx = off.getContext('2d')
    if (!ctx) { alert('Canvas not supported'); return }

    // Get audio stream (native capture if available; otherwise WebAudio fallback)
    let audioStream: MediaStream | null = null
    const audioEl = audioRef.current || undefined
    if (audioEl && typeof audioEl.captureStream === 'function') {
      try { audioStream = audioEl.captureStream() } catch {}
    }
    if (!audioStream && audioEl) {
      try {
        const AC = (window.AudioContext || (window as any).webkitAudioContext)
        const ac = new AC()
        const src = ac.createMediaElementSource(audioEl)
        const dest = ac.createMediaStreamDestination()
        src.connect(dest)
        src.connect(ac.destination) // keep audible
        audioStream = dest.stream
      } catch {
        audioStream = null
      }
    }

    // Video stream from canvas
    const fps = 60
    const videoStream = (off as any).captureStream?.(fps) as MediaStream | undefined
    if (!videoStream) { alert('Canvas captureStream not supported'); return }

    // Combine into single stream
    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...(audioStream ? audioStream.getAudioTracks() : []),
    ])

    // Recorder
    const mime =
      'video/webm;codecs=vp9,opus' in MediaRecorder.isTypeSupported
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm'
    let options: MediaRecorderOptions = { mimeType: mime }
    const rec = new MediaRecorder(stream, options)
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

    // Build a static PDF source to draw quickly each frame
    // Prefer using our snapshot; fall back to copying from the on-screen pdf canvas
    const getPdfDraw = () => {
      if (pdfSnapshot) {
        return () => { ctx.drawImage(pdfSnapshot, 0, 0, W, H) }
      }
      return () => {
        const innerCanvas = pdfHostRef.current?.querySelector('canvas') as HTMLCanvasElement | null
        if (innerCanvas) ctx.drawImage(innerCanvas, 0, 0, W, H)
      }
    }
    const drawPdf = getPdfDraw()

    // Precompute for drawAtTime during export (avoid dependency on overlay state)
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

    // Drive the export with the audio clock for perfect sync
    if (!audioEl) {
      alert('No audio found to sync export.')
      return
    }

    // Prepare playback
    audioEl.currentTime = 0
    try { await audioEl.play() } catch { /* user gesture may be needed; best effort */ }

    // Start recording
    rec.start(100) // gather chunks every 100ms

    // Render loop (ties to audio currentTime)
    const startRaf = () => {
      const loop = () => {
        const t = audioEl.currentTime
        ctx.clearRect(0, 0, W, H)
        drawPdf()
        drawInkAt(t)
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    }

    // Stop conditions
    const onEnded = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rec.stop()
      audioEl.removeEventListener('ended', onEnded)
    }
    audioEl.addEventListener('ended', onEnded)

    // Kick off the RAF loop
    startRaf()
  }

  // Download strokes JSON (unchanged helper)
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
      {/* Panel */}
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

        {/* Top toolbar */}
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

        {/* Content: PDF full width (underlay) + overlay ink */}
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
