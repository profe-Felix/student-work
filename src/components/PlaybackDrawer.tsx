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

type TimedPoint = { x: number; y: number; t?: number }
type Stroke = { color?: string; size?: number; points: TimedPoint[] }
type Seg = {
  x0: number; y0: number; x1: number; y1: number;
  color: string; size: number; t: number;        // seconds from 0
}
type OverlaySize = { cssW: number; cssH: number; dpr: number }

/* ---------- tiny utils ---------- */
function n(v: any) { const x = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(x) ? x : 0 }

/* ---------- robust stroke parsing (supports your { pts:[] } shape) ---------- */
function asPoints(maybe: any): TimedPoint[] {
  if (!maybe) return []
  if (Array.isArray(maybe) && maybe.length && typeof maybe[0] === 'object' && 'x' in maybe[0]) {
    return (maybe as any[]).map(p => ({ x: n((p as any).x), y: n((p as any).y), t: (p as any).t != null ? n((p as any).t) : undefined }))
  }
  return []
}
function toStroke(obj: any): Stroke | null {
  if (!obj) return null
  if (Array.isArray(obj.pts))    return { color: obj.color, size: obj.size, points: asPoints(obj.pts) }    // ← your schema
  if (Array.isArray(obj.points)) return { color: obj.color, size: obj.size, points: asPoints(obj.points) }
  if (Array.isArray(obj.path))   return { color: obj.color, size: obj.size, points: asPoints(obj.path) }
  if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object' && 'x' in obj[0]) {
    return { color: (obj as any).color, size: (obj as any).size, points: asPoints(obj) }
  }
  return null
}

type Parsed = { strokes: Stroke[]; metaW: number; metaH: number }
function parseStrokes(payload: any): Parsed {
  let raw = payload
  try { if (typeof raw === 'string') raw = JSON.parse(raw) } catch {}
  if (!raw) return { strokes: [], metaW: 0, metaH: 0 }

  let metaW = n(raw.canvasWidth ?? raw.canvas_w ?? raw.canvasW ?? raw.width ?? raw.w ?? raw.pageWidth ?? raw.page?.width)
  let metaH = n(raw.canvasHeight ?? raw.canvas_h ?? raw.canvasH ?? raw.height ?? raw.h ?? raw.pageHeight ?? raw.page?.height)
  if (raw && raw.data) raw = raw.data

  const toParsed = (arr: any[]): Parsed => ({ strokes: (arr.map(toStroke).filter(Boolean) as Stroke[]), metaW, metaH })

  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object' && ('x' in raw[0] || 'pts' in raw[0])) {
      const s = toStroke(raw); return { strokes: s ? [s] : [], metaW, metaH }
    }
    return toParsed(raw)
  }

  const buckets: any[] = []
  if (Array.isArray(raw.strokes)) buckets.push(...raw.strokes)    // ← common case
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

/* ---------- timing build with monotonicity fix ---------- */
function buildSegments(strokes: Stroke[]): { segs: Seg[]; duration: number; hadTiming: boolean } {
  const segs: Seg[] = []
  let anyT = false
  for (const s of strokes) {
    const pts = s.points || []
    if (pts.length < 2) continue
    const hasT = typeof pts[0]?.t === 'number'
    anyT = anyT || hasT
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i]
      const t = hasT ? n(p1.t) : i * 0.012
      segs.push({ x0: n(p0.x), y0: n(p0.y), x1: n(p1.x), y1: n(p1.y), color: s.color || '#111', size: s.size || 4, t })
    }
  }
  if (!segs.length) return { segs, duration: 0, hadTiming: false }

  // normalize to start at 0
  const t0 = Math.min(...segs.map(s => s.t))
  for (const s of segs) s.t -= t0

  // ms→s if it looks huge
  const maxAfter = Math.max(...segs.map(s => s.t))
  if (maxAfter > 600) { for (const s of segs) s.t = s.t / 1000 }

  segs.sort((a, b) => a.t - b.t)

  // --- FIX: if timing is non-monotonic or collapsed (duration ~ 0), synthesize smooth timing
  const duration = segs.length ? segs[segs.length - 1].t : 0
  if (!anyT || duration <= 0.0001) {
    // 60 FPS ~ 0.016s per segment gives nice reveal
    for (let i = 0; i < segs.length; i++) segs[i].t = i * 0.016
    return { segs, duration: segs[segs.length - 1].t, hadTiming: false }
  }

  return { segs, duration, hadTiming: true }
}

/* ---------- infer source dimensions for scaling ---------- */
function inferSourceDims(strokes: Stroke[], metaW: number, metaH: number): { sw: number; sh: number } {
  if (metaW > 10 && metaH > 10) return { sw: metaW, sh: metaH }
  let maxX = 0, maxY = 0
  for (const s of strokes) for (const p of (s.points || [])) { if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y }
  if (maxX > 0 && maxX <= 2 && maxY > 0 && maxY <= 2) return { sw: 1, sh: 1 } // normalized
  return { sw: Math.max(1, Math.round(maxX)), sh: Math.max(1, Math.round(maxY)) }
}

/* ================= Component ================= */
export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl,
}: Props) {
  const [overlay, setOverlay] = useState<OverlaySize>({ cssW: 800, cssH: 600, dpr: window.devicePixelRatio || 1 })

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

  /* ------- Keep overlay CSS size = PDF canvas CSS size; scale backing store by DPR ------- */
  useEffect(() => {
    const host = pdfHostRef.current
    if (!host) return

    const findPdfCanvas = () => {
      const canvases = Array.from(host.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const overlayEl = overlayRef.current
      return canvases.find(c => c !== overlayEl) || null
    }

    const syncSize = () => {
      const pdfC = findPdfCanvas()
      if (!pdfC) return
      const rect = pdfC.getBoundingClientRect()
      const cssW = Math.max(1, Math.round(rect.width))
      const cssH = Math.max(1, Math.round(rect.height))
      const dpr = window.devicePixelRatio || 1
      setOverlay(prev => (prev.cssW === cssW && prev.cssH === cssH && prev.dpr === dpr) ? prev : { cssW, cssH, dpr })
    }

    syncSize()
    const pdfC = findPdfCanvas()
    let ro: ResizeObserver | null = null
    if (pdfC && 'ResizeObserver' in window) {
      ro = new ResizeObserver(syncSize)
      ro.observe(pdfC)
    }
    const onResize = () => syncSize()
    window.addEventListener('resize', onResize)

    // poll briefly to catch late PDF renders
    const poll = window.setInterval(syncSize, 200)
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 3000)

    return () => {
      window.removeEventListener('resize', onResize)
      if (ro) ro.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(stopPoll)
    }
  }, [pdfUrl, pageIndex])

  /* ------- drawing helpers (scaled to CSS size & DPR) ------- */
  function ensureCtx(): CanvasRenderingContext2D | null {
    const c = overlayRef.current
    if (!c) return null
    const { cssW, cssH, dpr } = overlay
    // CSS size
    c.style.width = `${cssW}px`
    c.style.height = `${cssH}px`
    // backing store in device pixels
    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))
    if (c.width !== bw) c.width = bw
    if (c.height !== bh) c.height = bh
    const ctx = c.getContext('2d')
    if (!ctx) return null
    // reset transform, then apply DPR
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
    return ctx
  }

  function withScale(ctx: CanvasRenderingContext2D, draw: () => void) {
    const { cssW, cssH } = overlay
    const sx = cssW / Math.max(1, sw)
    const sy = cssH / Math.max(1, sh)
    ctx.save()
    ctx.scale(sx, sy)
    draw()
    ctx.restore()
  }

  function drawStaticAll() {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)
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
        } else {
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
          ctx.stroke()
        }
      }
    })
  }

  function drawUpTo(timeSec: number) {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)

    if (!segs.length) { drawStaticAll(); return }

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
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)

    withScale(ctx, () => {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const s of strokes) {
        const pts = s.points || []
        if (!pts.length) continue
        ctx.strokeStyle = s.color || '#111'
        ctx.lineWidth = s.size || 4
        const upto = Math.max(1, Math.floor(pts.length * pct))
        if (upto === 1) {
          const p = pts[0]
          ctx.beginPath()
          ctx.arc(p.x, p.y, (s.size || 4) * 0.5, 0, Math.PI * 2)
          ctx.fillStyle = s.color || '#111'
          ctx.fill()
        } else {
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < upto; i++) ctx.lineTo(pts[i].x, pts[i].y)
          ctx.stroke()
        }
      }
    })
  }

  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  /* Always render static ink when size or data changes */
  useEffect(() => { drawStaticAll() }, [overlay.cssW, overlay.cssH, overlay.dpr, strokesPayload, sw, sh])

  /* Audio-synced mode (optional) */
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

    drawUpTo(el.currentTime)

    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ended', onEnded)
      stopRAF()
    }
  }, [syncToAudio, overlay.cssW, overlay.cssH, overlay.dpr, segs.length, sw, sh])

  /* Strokes-only replay (works with NO audio) */
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
  }, [strokesPlaying, duration, segs.length, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh])

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
          <div ref={pdfHostRef} style={{ position: 'relative', width: `${overlay.cssW}px`, margin: '12px auto' }}>
            <div style={{ position: 'relative' }}>
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} />
              <canvas
                ref={overlayRef}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${overlay.cssW}px`,
                  height: `${overlay.cssH}px`,
                  pointerEvents: 'none',
                }}
                // backing store sizes are set in ensureCtx() based on DPR
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
