// src/components/PlaybackDrawer.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

export type Props = {
  onClose: () => void
  student: string
  pdfUrl: string
  pageIndex: number
  strokesPayload: any
  audioUrl?: string
}

type Size = { w: number; h: number }
type TimedPoint = { x: number; y: number; t?: number }
type Stroke = { color?: string; size?: number; points: TimedPoint[] }
type Seg = {
  x0: number; y0: number; x1: number; y1: number;
  color: string; size: number; t: number; // seconds from 0
}

/* ---------- Robust stroke parsing ---------- */
function n(v: any) { const x = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(x) ? x : 0 }
function asPoints(maybe: any): TimedPoint[] {
  if (!maybe) return []
  if (Array.isArray(maybe) && maybe.length && typeof maybe[0] === 'object' && 'x' in maybe[0]) {
    return (maybe as any[]).map(p => ({ x: n(p.x), y: n(p.y), t: p.t != null ? n(p.t) : undefined }))
  }
  return []
}
function toStroke(obj: any): Stroke | null {
  if (!obj) return null
  if (Array.isArray(obj.points)) return { color: obj.color, size: obj.size, points: asPoints(obj.points) }
  if (Array.isArray(obj.path))   return { color: obj.color, size: obj.size, points: asPoints(obj.path) }
  if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object' && 'x' in obj[0]) {
    return { color: (obj as any).color, size: (obj as any).size, points: asPoints(obj) }
  }
  return null
}
function coerceStrokes(payload: any): Stroke[] {
  try { if (typeof payload === 'string') payload = JSON.parse(payload) } catch {}
  if (!payload) return []
  if ((payload as any).data) payload = (payload as any).data

  // Array cases
  if (Array.isArray(payload)) {
    if (payload.length && typeof payload[0] === 'object' && 'x' in payload[0]) {
      const s = toStroke(payload); return s ? [s] : []
    }
    return (payload.map(toStroke).filter(Boolean) as Stroke[])
  }
  // Object cases
  const buckets: any[] = []
  if (Array.isArray(payload.strokes)) buckets.push(...payload.strokes)
  if (Array.isArray(payload.lines))   buckets.push(...payload.lines)
  if (Array.isArray(payload.paths))   buckets.push(...payload.paths)
  if (!buckets.length && Array.isArray(payload.points)) {
    const s = toStroke(payload); return s ? [s] : []
  }
  if (buckets.length) return (buckets.map(toStroke).filter(Boolean) as Stroke[])

  const vals = Object.values(payload)
  if (vals.length && Array.isArray(vals[0])) {
    const s = toStroke(vals[0]); return s ? [s] : []
  }
  return []
}

/* ---------- Build segments & normalize time ---------- */
function buildSegments(strokes: Stroke[]): { segs: Seg[]; duration: number } {
  const segs: Seg[] = []
  for (const s of strokes) {
    const pts = s.points || []
    if (pts.length < 2) continue
    const hasT = typeof pts[0]?.t === 'number'
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i]
      let t = hasT ? n(p1.t) : i * 0.012 // ~12ms fallback in seconds
      segs.push({ x0: n(p0.x), y0: n(p0.y), x1: n(p1.x), y1: n(p1.y), color: s.color || '#111', size: s.size || 4, t })
    }
  }
  if (!segs.length) return { segs, duration: 0 }
  const t0 = Math.min(...segs.map(s => s.t))
  for (const s of segs) s.t -= t0
  const maxAfter = Math.max(...segs.map(s => s.t))
  if (maxAfter > 600) { for (const s of segs) s.t = s.t / 1000 } // ms -> s
  segs.sort((a, b) => a.t - b.t)
  return { segs, duration: segs[segs.length - 1].t }
}

/* ================= Component ================= */
export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl,
}: Props) {
  const [size, setSize] = useState<Size>({ w: 800, h: 600 })
  const [pdfReady, setPdfReady] = useState(false)

  const strokes = useMemo(() => coerceStrokes(strokesPayload), [strokesPayload])
  const { segs, duration } = useMemo(() => buildSegments(strokes), [strokes])

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const rafRef = useRef<number | null>(null)

  const [syncToAudio, setSyncToAudio] = useState<boolean>(!!audioUrl)
  const [strokesPlaying, setStrokesPlaying] = useState(false)
  const strokeClock = useRef<{ startMs: number; offsetSec: number }>({ startMs: 0, offsetSec: 0 })

  /* ------- PDF ready ------- */
  function onPdfReady(info: { width?: number; height?: number; cssWidth?: number; cssHeight?: number }) {
    const w = info.width ?? info.cssWidth ?? 800
    const h = info.height ?? info.cssHeight ?? 600
    setSize({ w, h })
    setPdfReady(true)
    // draw static immediately
    requestAnimationFrame(() => drawAtTime('static'))
  }

  /* ------- Drawing ------- */
  function drawSegmentsUpTo(ctx: CanvasRenderingContext2D, tSec: number | 'static') {
    const W = size.w, H = size.h
    ctx.clearRect(0, 0, W, H)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    let lastColor = '', lastSize = -1
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (tSec !== 'static' && s.t > tSec) break
      if (s.color !== lastColor) { ctx.strokeStyle = s.color; lastColor = s.color }
      if (s.size !== lastSize) { ctx.lineWidth = s.size; lastSize = s.size }
      ctx.beginPath()
      ctx.moveTo(s.x0, s.y0)
      ctx.lineTo(s.x1, s.y1)
      ctx.stroke()
    }
  }
  function drawAtTime(tSec: number | 'static') {
    const c = overlayRef.current
    if (!c || !pdfReady) return
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    const ctx = c.getContext('2d')
    if (!ctx) return
    drawSegmentsUpTo(ctx, tSec)
  }

  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  /* ------- Audio-synced mode ------- */
  useEffect(() => {
    if (!syncToAudio) { stopRAF(); return }
    const el = audioRef.current
    if (!el) return

    const onPlay = () => {
      stopRAF()
      const loop = () => {
        drawAtTime(el.currentTime)
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    const onPause = () => { stopRAF(); drawAtTime(el.currentTime) }
    const onSeeked = () => { drawAtTime(el.currentTime) }
    const onTimeUpdate = () => { if (!rafRef.current) drawAtTime(el.currentTime) }
    const onEnded = () => { stopRAF(); drawAtTime('static') }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('ended', onEnded)

    // first frame
    drawAtTime(el.currentTime)

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ended', onEnded)
      stopRAF()
    }
  }, [syncToAudio, pdfReady, size.w, size.h, segs.length])

  /* ------- Strokes-only replay ------- */
  useEffect(() => {
    if (!strokesPlaying) return
    strokeClock.current.startMs = performance.now()
    const tick = () => {
      const elapsed = (performance.now() - strokeClock.current.startMs) / 1000 + strokeClock.current.offsetSec
      if (elapsed >= duration) {
        drawAtTime(duration)
        setStrokesPlaying(false)
        strokeClock.current.offsetSec = 0
        return
      }
      drawAtTime(elapsed)
      rafRef.current = requestAnimationFrame(tick)
    }
    stopRAF()
    rafRef.current = requestAnimationFrame(tick)
    return () => stopRAF()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokesPlaying, duration, pdfReady, size.w, size.h, segs.length])

  // Always draw a static frame when size or segs change
  useEffect(() => { drawAtTime('static') }, [pdfReady, size.w, size.h, segs.length])

  const hasAudio = !!audioUrl

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
            {/* Strokes-only replay */}
            <button
              onClick={() => {
                setSyncToAudio(false)
                setStrokesPlaying(p => !p)
              }}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
              title="Replay without audio"
            >
              {strokesPlaying ? 'Stop Replay' : 'Replay Strokes'}
            </button>

            {/* Audio sync toggle (only if audio exists) */}
            <button
              onClick={() => {
                setStrokesPlaying(false)
                setSyncToAudio(s => !s)
              }}
              disabled={!hasAudio}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid #e5e7eb',
                background: hasAudio ? '#fff' : '#f3f4f6'
              }}
              title={hasAudio ? 'Tie ink to audio playback' : 'No audio available'}
            >
              {syncToAudio ? 'Sync: ON' : 'Sync: OFF'}
            </button>

            <button
              onClick={onClose}
              style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}
            >
              Close
            </button>
          </div>
        </div>

        {/* Toolbar: audio controls (if any) + page label */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: 12,
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          {hasAudio ? (
            <audio ref={audioRef} controls src={audioUrl} style={{ width: 'min(600px, 100%)' }} />
          ) : (
            <span style={{ fontSize: 12, color: '#6b7280' }}>No audio</span>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
            Page {pageIndex + 1}
          </span>
        </div>

        {/* Content: PDF (underlay) + overlay ink */}
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
