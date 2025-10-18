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

/* ========================= Types ========================= */
type TimedPoint = { x: number; y: number; t?: number }
type Stroke = { color?: string; size?: number; points: TimedPoint[]; tool?: string }
type Seg = { x0:number; y0:number; x1:number; y1:number; color:string; size:number; t:number; tool?: string }
type OverlaySize = { cssW: number; cssH: number; dpr: number }

/* ------------ tiny utils ------------ */
const N = (v:any) => {
  const x = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(x) ? x : 0
}

/* ------------ parse strokes (supports your {strokes:[{pts:[]}]}) ------------ */
function asPoints(maybe:any): TimedPoint[] {
  if (!maybe) return []
  if (Array.isArray(maybe) && maybe.length && typeof maybe[0] === 'object' && 'x' in maybe[0]) {
    return maybe.map((p:any) => ({ x: N(p.x), y: N(p.y), t: p.t != null ? N(p.t) : undefined }))
  }
  return []
}

function toStroke(obj:any): Stroke | null {
  if (!obj) return null
  const tool = obj.tool ?? obj.mode ?? obj.type
  if (Array.isArray(obj.pts))    return { color: obj.color, size: obj.size, points: asPoints(obj.pts), tool }
  if (Array.isArray(obj.points)) return { color: obj.color, size: obj.size, points: asPoints(obj.points), tool }
  if (Array.isArray(obj.path))   return { color: obj.color, size: obj.size, points: asPoints(obj.path), tool }
  if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object' && 'x' in obj[0]) {
    return { color: (obj as any).color, size: (obj as any).size, points: asPoints(obj), tool }
  }
  return null
}

type Parsed = { strokes: Stroke[]; metaW: number; metaH: number }

function parseStrokes(payload:any): Parsed {
  let raw = payload
  try { if (typeof raw === 'string') raw = JSON.parse(raw) } catch {}
  if (!raw) return { strokes: [], metaW: 0, metaH: 0 }

  // Try to read capture canvas size if present (student save writes w/h)
  let metaW = N(raw.canvasWidth ?? raw.canvas_w ?? raw.canvasW ?? raw.width ?? raw.w ?? raw.pageWidth ?? raw.page?.width)
  let metaH = N(raw.canvasHeight ?? raw.canvas_h ?? raw.canvasH ?? raw.height ?? raw.h ?? raw.pageHeight ?? raw.page?.height)

  if (raw && raw.data) raw = raw.data

  const toParsed = (arr:any[]): Parsed => ({ strokes: (arr.map(toStroke).filter(Boolean) as Stroke[]), metaW, metaH })

  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object' && ('x' in raw[0] || 'pts' in raw[0])) {
      const s = toStroke(raw); return { strokes: s ? [s] : [], metaW, metaH }
    }
    return toParsed(raw)
  }

  const buckets:any[] = []
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

/* ------------ ORIGINAL: synthesized sequential timeline (strokes replay) ------------ */
function buildSequentialSegments(strokes: Stroke[]): { segs: Seg[]; duration: number } {
  const segs: Seg[] = []
  const SEG_DT = 0.010   // 10ms per segment → ~100 fps reveal
  const GAP_DT = 0.150   // 150ms between strokes (visible pause)
  let t = 0
  for (const s of strokes) {
    const pts = s.points || []
    if (pts.length < 2) { t += GAP_DT; continue }
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i]
      segs.push({
        x0: N(p0.x), y0: N(p0.y), x1: N(p1.x), y1: N(p1.y),
        color: s.color || '#111', size: s.size || 4, t, tool: s.tool
      })
      t += SEG_DT
    }
    t += GAP_DT
  }
  return { segs, duration: t }
}

/* ------------ NEW: point-timestamp timeline for smooth scrubbing ------------ */
type TLPoint = { x:number; y:number; t:number }
type TLStroke = { color?:string; size?:number; tool?:string; pts: TLPoint[] }
type PointTimeline = { strokes: TLStroke[]; t0:number; t1:number } // ms

function hasAnyTimestamps(strokes: Stroke[]): boolean {
  for (const s of strokes) {
    for (const p of s.points || []) if (typeof p.t === 'number') return true
  }
  return false
}

/** Normalize timestamps to a single global ms axis starting at 0.
 *  If there are no timestamps, synthesize per-point times (10ms) with 150ms gaps (like replay). */
function buildPointTimeline(strokes: Stroke[]): PointTimeline {
  if (!strokes.length) return { strokes: [], t0: 0, t1: 0 }

  if (hasAnyTimestamps(strokes)) {
    // Use recorded times; normalize to start at 0
    let minT = Infinity, maxT = 0
    const tl: TLStroke[] = strokes.map(s => {
      const pts: TLPoint[] = []
      let last = -Infinity
      for (const p of (s.points || [])) {
        if (typeof p.t === 'number') {
          const tt = Math.max(0, p.t)
          const t = Math.max(tt, last <= 0 ? tt : last) // non-decreasing
          last = t
          pts.push({ x:N(p.x), y:N(p.y), t })
          if (t < minT) minT = t
          if (t > maxT) maxT = t
        } else {
          // If some points miss t but at least one has, space missing ones by 10ms
          const t = (last > 0 ? last + 10 : 0)
          last = t
          pts.push({ x:N(p.x), y:N(p.y), t })
          if (t < minT) minT = t
          if (t > maxT) maxT = t
        }
      }
      return { color:s.color, size:s.size, tool:s.tool, pts }
    })
    if (!isFinite(minT)) minT = 0
    const shift = minT
    const shifted = tl.map(s => ({ ...s, pts: s.pts.map(p => ({ ...p, t: p.t - shift })) }))
    return { strokes: shifted, t0: 0, t1: Math.max(0, maxT - shift) }
  }

  // Synthesize: sequential, like your replay timeline, but in ms
  const tl: TLStroke[] = []
  const SEG_MS = 10
  const GAP_MS = 150
  let t = 0
  for (const s of strokes) {
    const pts = s.points || []
    if (!pts.length) { t += GAP_MS; continue }
    const out: TLPoint[] = []
    out.push({ x:N(pts[0].x), y:N(pts[0].y), t })
    for (let i = 1; i < pts.length; i++) {
      t += SEG_MS
      out.push({ x:N(pts[i].x), y:N(pts[i].y), t })
    }
    tl.push({ color:s.color, size:s.size, tool:s.tool, pts: out })
    t += GAP_MS
  }
  return { strokes: tl, t0: 0, t1: Math.max(0, t) }
}

/* ------------ ERASE timeline from payload.ops (optional) ------------ */
type EraseTL = { path: TLPoint[]; radius: number; t0:number; t1:number; mode?: 'soft'|'object' }
type EraseBuild = { erases: EraseTL[]; t0:number; t1:number }

function buildEraseTimelineFromOps(opsAny:any): EraseBuild {
  const out: EraseTL[] = []
  if (!Array.isArray(opsAny)) return { erases: out, t0: 0, t1: 0 }

  let minT = Infinity
  let maxT = 0

  // Gather raw, then normalize to start at 0
  const raw: EraseTL[] = []

  for (const op of opsAny) {
    const isErase = !!op && (op.type === 'erase' || op.mode === 'erase' || op.tool === 'eraser' || op.tool === 'eraserObject')
    if (!isErase) continue

    const pathRaw = op.path || op.pts || []
    if (!Array.isArray(pathRaw) || pathRaw.length === 0) continue

    const pts: TLPoint[] = []
    let last = typeof op.t0 === 'number' ? N(op.t0) : -Infinity
    for (let i = 0; i < pathRaw.length; i++) {
      const p = pathRaw[i] || {}
      let t: number
      if (typeof p.t === 'number') {
        t = N(p.t)
        t = Math.max(t, last > 0 ? last : t)
      } else if (typeof op.t0 === 'number' && typeof op.t1 === 'number') {
        // distribute across [t0, t1]
        const span = Math.max(1, N(op.t1) - N(op.t0))
        t = N(op.t0) + Math.round((i / Math.max(1, pathRaw.length - 1)) * span)
      } else {
        t = last > 0 ? last + 10 : 0
      }
      last = t
      pts.push({ x: N(p.x), y: N(p.y), t })
      if (t < minT) minT = t
      if (t > maxT) maxT = t
    }

    let t0 = typeof op.t0 === 'number' ? N(op.t0) : pts[0].t
    let t1 = typeof op.t1 === 'number' ? N(op.t1) : pts[pts.length - 1].t
    if (t0 < minT) minT = t0
    if (t1 > maxT) maxT = t1

    raw.push({ path: pts, radius: N(op.radius ?? op.size ?? 10), t0, t1, mode: op.mode || op.eraseMode })
  }

  if (!isFinite(minT)) minT = 0
  const shift = minT
  for (const e of raw) {
    const path = e.path.map(p => ({ ...p, t: p.t - shift }))
    out.push({ ...e, path, t0: e.t0 - shift, t1: e.t1 - shift })
  }

  return { erases: out, t0: 0, t1: Math.max(0, maxT - shift) }
}

/* ------------ source space inference ------------ */
function inferSourceDimsFromMetaOrPdf(metaW:number, metaH:number, pdfCssW:number, pdfCssH:number) {
  if (metaW > 10 && metaH > 10) return { sw: metaW, sh: metaH }
  return { sw: Math.max(1, pdfCssW), sh: Math.max(1, pdfCssH) }
}

/* =================== Component =================== */
export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl,
}: Props) {
  // PDF CSS size (what the user sees), plus DPR for crispness
  const [overlay, setOverlay] = useState<OverlaySize>({
    cssW: 800, cssH: 600, dpr: window.devicePixelRatio || 1
  })

  // PDF CSS size at render time (from PdfCanvas onReady)
  const pdfCssRef = useRef<{ w:number; h:number }>({ w: 800, h: 600 })

  const parsed = useMemo(() => parseStrokes(strokesPayload), [strokesPayload])
  const strokes = parsed.strokes

  // ORIGINAL: Build a single global timeline across all strokes (for "Replay Strokes")
  const { segs, duration } = useMemo(() => buildSequentialSegments(strokes), [strokes])

  // NEW: Time-based point timeline (ms) for smooth scrubbing and audio sync
  const pointTL = useMemo(() => buildPointTimeline(strokes), [strokes])

  // NEW: Optional erase timeline (from payload.ops), normalized to 0
  const eraseTL = useMemo(() => {
    const ops = (strokesPayload && typeof strokesPayload === 'object') ? (strokesPayload.ops || []) : []
    return buildEraseTimelineFromOps(ops)
  }, [strokesPayload])

  // total length in ms: combined ink+erase
  const durationMs = Math.max(pointTL.t1, eraseTL.t1)

  // Decide the stroke coordinate space to scale from
  const { sw, sh } = useMemo(
    () => inferSourceDimsFromMetaOrPdf(
      // Prefer explicit w/h if present in the payload for best scaling
      N(strokesPayload?.w ?? parsed.metaW),
      N(strokesPayload?.h ?? parsed.metaH),
      pdfCssRef.current.w,
      pdfCssRef.current.h
    ),
    [strokesPayload?.w, strokesPayload?.h, parsed.metaW, parsed.metaH, overlay.cssW, overlay.cssH]
  )

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)

  const [syncToAudio, setSyncToAudio] = useState<boolean>(!!audioUrl)
  const [strokesPlaying, setStrokesPlaying] = useState(false)

  // Scrubbing state (start at 0 to avoid “final image then un-erase” feel)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubMs, setScrubMs] = useState<number>(0)

  /* ---- Bind overlay size to PDF canvas CSS size, and track DPR ---- */
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

    const poll = window.setInterval(syncSize, 200)
    const stopPoll = window.setTimeout(() => window.clearInterval(poll), 3000)

    return () => {
      window.removeEventListener('resize', onResize)
      if (ro) ro.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(stopPoll)
    }
  }, [pdfUrl, pageIndex])

  /* ---- Drawing helpers (DPR-aware, scales from stroke space sw×sh to current CSS space) ---- */
  function ensureCtx(): CanvasRenderingContext2D | null {
    const c = overlayRef.current
    if (!c) return null
    const { cssW, cssH, dpr } = overlay
    c.style.width = `${cssW}px`
    c.style.height = `${cssH}px`
    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))
    if (c.width !== bw) c.width = bw
    if (c.height !== bh) c.height = bh
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(1, 0, 0, 1, 0, 0) // reset
    ctx.scale(dpr, dpr) // map drawing units → CSS pixels
    return ctx
  }

  function withScale(ctx: CanvasRenderingContext2D, draw: () => void) {
    const sx = overlay.cssW / Math.max(1, sw)
    const sy = overlay.cssH / Math.max(1, sh)
    ctx.save()
    ctx.scale(sx, sy)
    draw()
    ctx.restore()
  }

  function applyStyleForTool(ctx: CanvasRenderingContext2D, color: string, size: number, tool?: string) {
    ctx.strokeStyle = color
    const isHi = tool === 'highlighter'
    ctx.globalAlpha = isHi ? 0.35 : 1.0
    ctx.lineWidth = Math.max(1, (isHi ? size * 1.5 : size))
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }

  function drawAllStatic() {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)
    withScale(ctx, () => {
      for (const s of strokes) {
        const pts = s.points || []
        if (!pts.length) continue
        applyStyleForTool(ctx, s.color || '#111', s.size || 4, s.tool)
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
      ctx.globalAlpha = 1
    })
  }

  /* ---- ORIGINAL: draw by synthesized stroke segments (seconds) ---- */
  function drawUpTo(timeSec:number) {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)
    if (!segs.length) { drawAllStatic(); return }
    withScale(ctx, () => {
      let lastColor = ''
      let lastSize = -1
      let lastTool = ''
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        if (s.t > timeSec) break
        if (s.color !== lastColor || s.size !== lastSize || (s.tool || '') !== lastTool) {
          applyStyleForTool(ctx, s.color, s.size, s.tool)
          lastColor = s.color
          lastSize = s.size
          lastTool = s.tool || ''
        }
        ctx.beginPath()
        ctx.moveTo(s.x0, s.y0)
        ctx.lineTo(s.x1, s.y1)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    })
  }

  /* ---- ERASE helpers ---- */
  function eraseAlong(ctx: CanvasRenderingContext2D, path: TLPoint[], radius:number) {
    if (!path.length) return
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(1, radius)
    ctx.beginPath()
    ctx.moveTo(path[0].x, path[0].y)
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y)
    ctx.stroke()
    ctx.restore()
  }

  /* ---- NEW: draw by real/synthesized point timestamps (milliseconds) with interpolation + ERASES ---- */
  function drawAtMs(ms:number) {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)

    withScale(ctx, () => {
      // 1) DRAW ink up to ms (existing point timeline)
      if (!pointTL.strokes.length) {
        for (const s of strokes) {
          const pts = s.points || []
          if (!pts.length) continue
          applyStyleForTool(ctx, s.color || '#111', s.size || 4, s.tool)
          ctx.beginPath()
          ctx.moveTo(pts[0].x, pts[0].y)
          for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
          ctx.stroke()
        }
      } else {
        for (const s of pointTL.strokes) {
          const pts = s.pts
          if (!pts || pts.length === 0) continue

          // find last index with t <= ms
          let i = 0
          while (i < pts.length && pts[i].t <= ms) i++
          const lastIdx = i - 1
          if (lastIdx < 0) continue

          applyStyleForTool(ctx, s.color || '#111', s.size || 4, s.tool)

          // draw all segments fully up to lastIdx
          if (lastIdx >= 1) {
            ctx.beginPath()
            ctx.moveTo(pts[0].x, pts[0].y)
            for (let k = 1; k <= lastIdx; k++) ctx.lineTo(pts[k].x, pts[k].y)
            ctx.stroke()
          } else {
            // single point (dot) visible
            const p = pts[0]
            ctx.beginPath()
            ctx.arc(p.x, p.y, (s.size || 4) * 0.5, 0, Math.PI * 2)
            ctx.fillStyle = s.color || '#111'
            ctx.fill()
          }

          // interpolate the next segment endpoint (smooth “live” stroke head)
          if (lastIdx < pts.length - 1) {
            const a = pts[lastIdx]
            const b = pts[lastIdx + 1]
            const dt = Math.max(1, b.t - a.t)
            const u = Math.min(1, Math.max(0, (ms - a.t) / dt))
            const x = a.x + (b.x - a.x) * u
            const y = a.y + (b.y - a.y) * u
            if (u > 0) {
              ctx.beginPath()
              ctx.moveTo(a.x, a.y)
              ctx.lineTo(x, y)
              ctx.stroke()
            }
          }
        }
      }

      // 2) ERASE up to ms (from payload.ops), path is partially revealed by time
      if (eraseTL.erases.length) {
        for (const e of eraseTL.erases) {
          if (ms <= e.t0) continue
          const cut = e.path.filter(p => p.t <= ms)
          if (cut.length >= 2) {
            eraseAlong(ctx, cut, e.radius)
          } else if (cut.length === 1) {
            eraseAlong(ctx, [cut[0], { ...cut[0], x: cut[0].x + 0.01, y: cut[0].y + 0.01 }], e.radius)
          }
        }
      }

      ctx.globalAlpha = 1
    })
  }

  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  /* ---- Always draw static ink when sizes or payload change ---- */
  useEffect(() => { drawAllStatic() }, [overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, strokesPayload])

  /* ---- Audio-synced mode (uses real ms timeline for smoothness + erase) ---- */
  useEffect(() => {
    if (!syncToAudio) { stopRAF(); return }
    const el = audioRef.current; if (!el) return

    const onPlay = () => {
      stopRAF()
      const loop = () => { drawAtMs(el.currentTime * 1000); rafRef.current = requestAnimationFrame(loop) }
      rafRef.current = requestAnimationFrame(loop)
    }
    const onPause = () => { stopRAF(); drawAtMs(el.currentTime * 1000) }
    const onSeeked = () => { drawAtMs(el.currentTime * 1000) }
    const onTimeUpdate = () => { if (!rafRef.current) drawAtMs(el.currentTime * 1000) }
    const onEnded = () => { stopRAF(); drawAllStatic() }

    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('ended', onEnded)

    drawAtMs(el.currentTime * 1000)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ended', onEnded)
      stopRAF()
    }
  }, [syncToAudio, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, pointTL.t1, eraseTL.t1])

  /* ---- Strokes-only replay (old path; seconds-based; no erase) ---- */
  useEffect(() => {
    if (!strokesPlaying) return
    const start = performance.now()
    const tick = () => {
      const t = (performance.now() - start) / 1000
      drawUpTo(Math.min(t, duration))
      if (t >= duration) { setStrokesPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    stopRAF()
    rafRef.current = requestAnimationFrame(tick)
    return () => stopRAF()
  }, [strokesPlaying, duration, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh])

  // Keep scrub range in sync if new data arrives; keep head at 0 when enabling scrub
  useEffect(() => {
    setScrubMs(0)
  }, [durationMs])

  const hasAudio = !!audioUrl

  return (
    <div role="dialog" aria-modal="true" style={{ position:'fixed', inset:0, background:'rgba(17,24,39,0.55)', display:'flex', justifyContent:'center', zIndex:50 }}>
      <div style={{ background:'#fff', width:'min(1200px, 96vw)', height:'min(92vh, 980px)', margin:'2vh auto', borderRadius:12, boxShadow:'0 10px 30px rgba(0,0,0,0.2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb', background:'#f9fafb' }}>
          <strong style={{ fontSize:14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
            <button
              onClick={() => { setSyncToAudio(false); setScrubbing(false); setStrokesPlaying(p => !p) }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
              title="Replay without audio"
            >
              {strokesPlaying ? 'Stop Replay' : 'Replay Strokes'}
            </button>
            <button
              onClick={() => { setStrokesPlaying(false); setScrubbing(false); setSyncToAudio(s => !s) }}
              disabled={!hasAudio}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: hasAudio ? '#fff' : '#f3f4f6' }}
              title={hasAudio ? 'Tie ink to audio playback' : 'No audio available'}
            >
              {syncToAudio ? 'Sync: ON' : 'Sync: OFF'}
            </button>
            {/* Scrub toggle (starts at 0) */}
            <button
              onClick={() => {
                setStrokesPlaying(false)
                setSyncToAudio(false)
                setScrubbing(s => !s)
                const startAt = 0
                setScrubMs(startAt)
                drawAtMs(startAt)
              }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: scrubbing ? '#fee2e2' : '#fff' }}
              title="Scrub smoothly through ink (includes erasing)"
            >
              {scrubbing ? 'Exit Scrub' : 'Scrub'}
            </button>
            <button onClick={onClose} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>
              Close
            </button>
          </div>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb' }}>
          {hasAudio ? (<audio ref={audioRef} controls src={audioUrl} style={{ width:'min(600px, 100%)' }} />) : (<span style={{ fontSize:12, color:'#6b7280' }}>No audio</span>)}
          <span style={{ marginLeft:'auto', fontSize:12, color:'#6b7280' }}>Page {pageIndex + 1}</span>
        </div>

        {/* Content: PDF underlay + overlay */}
        <div style={{ flex:1, minHeight:0, overflow:'auto', background:'#fafafa' }}>
          <div ref={pdfHostRef} style={{ position:'relative', width:`${overlay.cssW}px`, margin:'12px auto' }}>
            <div style={{ position:'relative' }}>
              {/* IMPORTANT: capture the PDF CSS size right when it’s ready */}
              <PdfCanvas
                url={pdfUrl}
                pageIndex={pageIndex}
                onReady={(_pdf:any, canvas:HTMLCanvasElement) => {
                  const rect = canvas.getBoundingClientRect()
                  pdfCssRef.current = { w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) }
                  // Also sync overlay immediately
                  const dpr = window.devicePixelRatio || 1
                  setOverlay(prev => {
                    const cssW = pdfCssRef.current.w, cssH = pdfCssRef.current.h
                    return (prev.cssW === cssW && prev.cssH === cssH && prev.dpr === dpr) ? prev : { cssW, cssH, dpr }
                  })
                }}
              />
              <canvas
                ref={overlayRef}
                style={{ position:'absolute', inset:0, width:`${overlay.cssW}px`, height:`${overlay.cssH}px`, pointerEvents:'none' }}
              />
            </div>
          </div>
        </div>

        {/* Scrubber bar */}
        <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fff' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, opacity: scrubbing ? 1 : 0.6 }}>
            <span style={{ width: 40, textAlign:'right', fontSize:12, color:'#6b7280' }}>
              {Math.max(0, Math.round((scrubMs) / 1000))}s
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, durationMs)}
              step={1}
              value={Math.min(durationMs, Math.max(0, scrubMs))}
              onChange={(e) => {
                const v = Math.min(durationMs, Math.max(0, parseInt(e.target.value, 10)))
                setScrubMs(v)
                if (scrubbing) drawAtMs(v)
              }}
              style={{ flex:1 }}
              disabled={!scrubbing || durationMs <= 0}
            />
            <span style={{ width: 40, fontSize:12, color:'#6b7280' }}>
              {Math.max(0, Math.round(durationMs / 1000))}s
            </span>
          </div>
          {!scrubbing && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
              Tip: Click <strong>Scrub</strong> to enable the slider. It starts at the beginning and includes erasing.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
