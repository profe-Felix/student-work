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

/* ---------- Utilities ---------- */
function n(v: any) { const x = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(x) ? x : 0 }

/* ---------- Extremely defensive stroke parsing ---------- */
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

type Parsed = { strokes: Stroke[]; metaW?: number; metaH?: number }
function parseStrokes(payload: any): Parsed {
  let raw = payload
  try { if (typeof raw === 'string') raw = JSON.parse(raw) } catch {}
  if (!raw) return { strokes: [] }

  // common wrappers/meta locations for source canvas size
  const metaW = n(raw.canvasWidth ?? raw.canvas_w ?? raw.canvasW ?? raw.width ?? raw.w ?? raw.pageWidth ?? raw.page?.width)
  const metaH = n(raw.canvasHeight ?? raw.canvas_h ?? raw.canvasH ?? raw.height ?? raw.h ?? raw.pageHeight ?? raw.page?.height)

  const toParsed = (sArr: any[]): Parsed => ({ strokes: (sArr.map(toStroke).filter(Boolean) as Stroke[]), metaW, metaH })

  if (raw && raw.data) raw = raw.data

  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object' && 'x' in raw[0]) {
      const s = toStroke(raw); return { strokes: s ? [s] : [], metaW, metaH }
    }
    return toParsed(raw)
  }

  const buckets: any[] = []
  if (Array.isArray(raw.strokes)) buckets.push(...raw.strokes)
  if (Array.isArray(raw.lines))   buckets.push(...raw.lines)
  if (Array.isArray(raw.paths))   buckets.push(...raw.paths)
  if (!buckets.length && Array.isArray(raw.points)) {
    const s = toStroke(raw); return { strokes: s ? [s] : [], metaW, metaH }
  }
  if (buckets.length) return toParsed(buckets)

  const vals = Object.values(raw)
  if (vals.length && Array.isArray(vals[0])) {
    const s = toStroke(vals[0]); return { strokes: s ? [s] : [], metaW, metaH }
  }
  return { strokes: [], metaW, metaH }
}

/* ---------- Compute segments for timed replay; static drawing uses raw strokes ---------- */
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
  const t0 = Math.min(...segs.map(s => s.t))
  for (const s of segs) s.t -= t0
  const maxAfter = Math.max(...segs.map(s => s.t))
  if (maxAfter > 600) { for (const s of segs) s.t = s.t / 1000 }
  segs.sort((a, b) => a.t - b.t)
  return { segs, duration: segs[segs.length - 1].t }
}

/* ---------- Infer source-drawing dimensions (for scaling) ---------- */
function inferSourceDims(strokes: Stroke[], metaW?: number, metaH?: number): { sw: number; sh: number } {
  // If metadata provided and sensible, use it
  if (metaW > 10 && metaH > 10) return { sw: metaW, sh: metaH }

  // Otherwise, infer from bounds of all points
  let maxX = 0, maxY = 0
  for (const s of strokes) {
    for (const p of (s.points || [])) {
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }

  // Handle normalized [0..1] data (rare): if max <= 2, treat as normalized
  if (maxX > 0 && maxX <= 2 && maxY > 0 && maxY <= 2) {
    return { sw: 1, sh: 1 }
  }

  // Fallback to bounds
  return { sw: Math.max(1, Math.round(maxX)), sh: Math.max(1, Math.round(maxY)) }
}

/* ================= Component ================= */
export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl,
}: Props) {
  const [size, setSize] = useState<Size>({ w: 800, h: 600 })

  const parsed = useMemo(() => parseStrokes(strokesPayload), [strokesPayload])
  const strokes = parsed.strokes
  const { segs, duration } = useMemo(() => buildSegments(strokes), [strokes])
  const { sw, sh } = useMemo(() => inferSourceDims(strokes, parsed.metaW, parsed.metaH), [strokes, parsed.metaW, parsed.metaH])

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const rafRef = useRef<number | null>(null)
  const [syncToAudio, setSyncToAudio] = useState<boolean>(!!audioUrl)
  const [strokesPlaying, setStrokesPlaying] = useState(false)

  /* ------- Keep overlay size in lockstep with the actual PDF canvas (no onReady dependency) ------- */
  useEffect(() => {
    const host = pdfHostRef.current
    if (!host) return

    const getPdfCanvas = () => {
      const canvases = Array.from(host.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const overlay = overlayRef.current
      const pdfCanvas = canvases.find(c => c !== overlay) || null
      return pdfCanvas
    }

    const syncSize = () => {
      const pdfC = getPdfCanvas()
      if (!pdfC) return
      // Use the PDF canvas *internal* pixel size (not CSS)
      const w = pdfC.width || Math.round(pdfC.getBoundingClientRect().width * (window.devicePixelRatio || 1))
      const h = pdfC.height || Math.round(pdfC.getBoundingClientRect().height * (window.devicePixelRatio || 1))
      setSize(prev => (prev.w === w && prev.h === h) ? prev : { w, h })
    }

    // Try immediately, then observe
    syncSize()
    const pdfC = getPdfCanvas()
    let ro: ResizeObserver | null = null
    if (pdfC && 'ResizeObserver' in window) {
      ro = new ResizeObserver(() => syncSize())
      ro.observe(pdfC)
    }
    const poll = window.setInterval(syncSize, 250)
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 4000)

    return () => {
      if (ro) ro.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(stopPoll)
    }
  }, [pdfUrl, pageIndex])

  /* ------- Low-level drawing with auto-scale to fit current PDF page ------- */
  function withScale(ctx: CanvasRenderingContext2D, draw: () => void) {
    // Scale raw stroke space (sw x sh) to current overlay size (size.w x size.h)
    const sx = size.w / Math.max(1, sw)
    const sy = size.h / Math.max(1, sh)
    ctx.save()
    ctx.scale(sx, sy)
    draw()
    ctx.restore()
  }

  function ensureCanvas(): CanvasRenderingContext2D | null {
    const c = overlayRef.current
    if (!c) return null
    if (c.width !== size.w) c.width = size.w
    if (c.height !== size.h) c.height = size.h
    return c.getContext('2d')
  }

  function drawStaticAll() {
    const ctx = ensureCanvas()
    if (!ctx) return
    ctx.clearRect(0, 0, size.w, size.h)
    withScale(ctx, () => {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const s of strokes) {
        const pts = s.points || []
        if (!pts.length) continue
        ctx.strokeStyle = s.color || '#111'
        ctx.lineWidth = s.size || 4
        if (pts.length === 1) {
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
    })
  }

  function drawUpTo(timeSec: number) {
    const ctx = ensureCanvas()
    if (!ctx) return
    // If no timing, show everything (or we could do proportional reveal)
    if (!segs.length) { drawStaticAll(); return }

    ctx.clearRect(0, 0, size.w, size.h)
    withScale(ctx, () => {
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
    })
  }

  function drawStaticPortion(pct: number) {
    const ctx = ensureCanvas()
    if (!ctx) return
    ctx.clearRect(0, 0, size.w, size.h)
    withScale(ctx, () => {
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
    })
  }

  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  /* ------- Always draw static ink when size or data changes ------- */
  useEffect(() => {
    drawStaticAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, strokesPayload, sw, sh])

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
  }, [syncToAudio, size.w, size.h, segs.length, sw, sh])

  /* ------- Strokes-only replay (works with NO audio) ------- */
  useEffect(() => {
    if (!strokesPlaying) return

    const hasTiming = segs.length > 0
    const start = performance.now()
    const durationFallback = 5 // seconds if no timing info

    const tick = () => {
      const elapsedSec = (performance.now() - start) / 1000
      if (!hasTiming) {
        const t = Math.min(1, elapsedSec / durationFallback)
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
  }, [strokesPlaying, duration, segs.length, size.w, size.h, sw, sh])

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
              {/* Render PdfCanvas as before; we don’t rely on its callbacks */}
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
