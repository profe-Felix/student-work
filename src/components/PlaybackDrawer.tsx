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

/* ---------- Extremely defensive stroke parsing ---------- */
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

  if (Array.isArray(payload)) {
    if (payload.length && typeof payload[0] === 'object' && 'x' in payload[0]) {
      const s = toStroke(payload); return s ? [s] : []
    }
    return (payload.map(toStroke).filter(Boolean) as Stroke[])
  }
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

/* ---------- Build segments for timed replay; static draw never depends on this ---------- */
function buildSegments(strokes: Stroke[]): { segs: Seg[]; duration: number } {
  const segs: Seg[] = []
  for (const s of strokes) {
    const pts = s.points || []
    if (pts.length < 2) continue
    const hasT = typeof pts[0]?.t === 'number'
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i]
      let t = hasT ? n(p1.t) : i * 0.012 // ~12ms fallback
      segs.push({ x0: n(p0.x), y0: n(p0.y), x1: n(p1.x), y1: n(p1.y), color: s.color || '#111', size: s.size || 4, t })
    }
  }
  if (!segs.length) return { segs, duration: 0 }
  // normalize to start at 0; convert ms->s if needed
  const t0 = Math.min(...segs.map(s => s.t))
  for (const s of segs) s.t -= t0
  const maxAfter = Math.max(...segs.map(s => s.t))
  if (maxAfter > 600) { for (const s of segs) s.t = s.t / 1000 }
  segs.sort((a, b) => a.t - b.t)
  return { segs, duration: segs[segs.length - 1].t }
}

/* ================= Component ================= */
export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl,
}: Props) {
  const [size, setSize] = useState<Size>({ w: 800, h: 600 })

  const strokes = useMemo(() => coerceStrokes(strokesPayload), [strokesPayload])
  const { segs, duration } = useMemo(() => buildSegments(strokes), [strokes])

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const rafRef = useRef<number | null>(null)
  const [syncToAudio, setSyncToAudio] = useState<boolean>(!!audioUrl)
  const [strokesPlaying, setStrokesPlaying] = useState(false)
  const strokeClock = useRef<{ startMs: number; offsetSec: number }>({ startMs: 0, offsetSec: 0 })

  /* ------- Keep overlay size in lockstep with the actual PDF canvas (no onReady dependency) ------- */
  useEffect(() => {
    const host = pdfHostRef.current
    if (!host) return

    const getPdfCanvas = () => {
      const canvases = Array.from(host.querySelectorAll('canvas')) as HTMLCanvasElement[]
      // our overlay canvas is also inside; exclude it
      const overlay = overlayRef.current
      const pdfCanvas = canvases.find(c => c !== overlay) || null
      return pdfCanvas
    }

    const syncSize = () => {
      const pdfC = getPdfCanvas()
      if (!pdfC) return
      const w = pdfC.width || Math.round(pdfC.getBoundingClientRect().width * (window.devicePixelRatio || 1))
      const h = pdfC.height || Math.round(pdfC.getBoundingClientRect().height * (window.devicePixelRatio || 1))
      setSize(prev => (prev.w === w && prev.h === h) ? prev : { w, h })
    }

    // try immediately, then observe changes
    syncSize()
    const pdfC = getPdfCanvas()
    let ro: ResizeObserver | null = null
    if (pdfC && 'ResizeObserver' in window) {
      ro = new ResizeObserver(() => syncSize())
      ro.observe(pdfC)
    }

    // also poll a few times in case PDF renders a bit later
    const poll = window.setInterval(syncSize, 250)
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 4000)

    return () => {
      if (ro) ro.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(stopPoll)
    }
  }, [pdfUrl, pageIndex])

  /* ------- Low-level drawing ------- */
  function drawStaticAll() {
    const c = overlayRef.current
    if (!c) return
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    const ctx = c.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, size.w, size.h)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const s of strokes) {
      const pts = s.points || []
      if (!pts.length) continue
      ctx.strokeStyle = s.color || '#111'
      ctx.lineWidth = s.size || 4
      if (pts.length === 1) {
        // draw a dot if only one point
        const p = pts[0]
        ctx.beginPath()
        ctx.arc(p.x, p.y, (s.size || 4) * 0.5, 0, Math.PI * 2)
        ctx.fillStyle = s.color || '#111'
        ctx.fill()
        continue
      }
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
  }

  function drawUpTo(timeSec: number) {
    const c = overlayRef.current
    if (!c) return
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    const ctx = c.getContext('2d')
    if (!ctx) return

    // if we don't have segs (no timing info), just draw all
    if (!segs.length) {
      drawStaticAll()
      return
    }

    ctx.clearRect(0, 0, size.w, size.h)
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

  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  /* ------- Always render static ink when size or data changes ------- */
  useEffect(() => {
    drawStaticAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, strokesPayload])

  /* ------- Audio-synced mode (optional) ------- */
  useEffect(() => {
    if (!syncToAudio) { stopRAF(); return }
    const el = audioRef.current
    if (!el) return

    const onPlay = () => {
      stopRAF()
      const loop = () => {
        drawUpTo(el.currentTime)
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    const onPause = () => { stopRAF(); drawUpTo(el.currentTime) }
    const onSeeked = () => { drawUpTo(el.currentTime) }
    const onTimeUpdate = () => { if (!rafRef.current) drawUpTo(el.currentTime) }
    const onEnded = () => { stopRAF(); drawStaticAll() }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('ended', onEnded)

    // first frame
    drawUpTo(el.currentTime)

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ended', onEnded)
      stopRAF()
    }
  }, [syncToAudio, size.w, size.h, segs.length])

  /* ------- Strokes-only replay (works with NO audio) ------- */
  useEffect(() => {
    if (!strokesPlaying) return
    // if we have no timing, just animate at a steady cadence through segments we synthesize
    const hasTiming = segs.length > 0
    const start = performance.now()
    const tick = () => {
      const elapsedSec = (performance.now() - start) / 1000
      if (!hasTiming) {
        // slow reveal over 5s if no timing at all
        const total = 5
        const t = Math.min(1, elapsedSec / total)
        // draw partial by slicing strokes proportionally
        drawStaticPortion(t)
        if (t >= 1) { setStrokesPlaying(false); return }
      } else {
        const t = Math.min(duration, elapsedSec)
        drawUpTo(t)
        if (t >= duration) { setStrokesPlaying(false); return }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    stopRAF()
    rafRef.current = requestAnimationFrame(tick)
    return () => stopRAF()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strokesPlaying, duration, segs.length, size.w, size.h])

  // helper for no-timing gradual reveal: draw first N% of each stroke
  function drawStaticPortion(pct: number) {
    const c = overlayRef.current
    if (!c) return
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    const ctx = c.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, size.w, size.h)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const s of strokes) {
      const pts = s.points || []
      if (pts.length === 0) continue
      ctx.strokeStyle = s.color || '#111'
      ctx.lineWidth = s.size || 4
      const upto = Math.max(1, Math.floor(pts.length * pct))
      if (upto === 1) {
        const p = pts[0]
        ctx.beginPath()
        ctx.arc(p.x, p.y, (s.size || 4) * 0.5, 0, Math.PI * 2)
        ctx.fillStyle = s.color || '#111'
        ctx.fill()
        continue
      }
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < upto; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
  }

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
              {/* We still render PdfCanvas exactly as before; we just don't depend on its callbacks */}
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} />
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
