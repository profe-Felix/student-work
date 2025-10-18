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
type OverlaySize = { cssW: number; cssH: number; dpr: number }

type TLPoint = { x:number; y:number; t:number }                 // ms
type TLStroke = { color?:string; size?:number; tool?:string; pts: TLPoint[] }
type Timeline = { strokes: TLStroke[]; t0:number; t1:number }   // ms

type DrawEvent = {
  t: number
  tool: 'pen'|'highlighter'|'eraser'|'other'
  color: string
  size: number
  x0: number; y0: number; x1: number; y1: number
}

/* ------------ utils ------------ */
const N = (v:any) => {
  const x = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(x) ? x : 0
}
const toolOf = (s: any): 'pen'|'highlighter'|'eraser'|'other' => {
  const t = (s?.tool ?? s?.mode ?? s?.type ?? '').toString()
  if (t === 'pen') return 'pen'
  if (t === 'highlighter') return 'highlighter'
  if (t === 'eraser' || t === 'eraserObject') return 'eraser'
  return 'other'
}

/* ------------ parse strokes ------------ */
function asPoints(maybe:any): TimedPoint[] {
  if (!maybe) return []
  if (Array.isArray(maybe) && maybe.length && typeof maybe[0] === 'object' && 'x' in maybe[0]) {
    return maybe.map((p:any) => ({ x: N(p.x), y: N(p.y), t: p.t != null ? N(p.t) : undefined }))
  }
  return []
}
function toStroke(obj:any): Stroke | null {
  if (!obj) return null
  const t = toolOf(obj)
  const color = obj.color ?? '#111'
  const size  = Number.isFinite(obj.size) ? obj.size : 4
  if (Array.isArray(obj.pts))    return { color, size, points: asPoints(obj.pts), tool: t }
  if (Array.isArray(obj.points)) return { color, size, points: asPoints(obj.points), tool: t }
  if (Array.isArray(obj.path))   return { color, size, points: asPoints(obj.path), tool: t }
  if (Array.isArray(obj) && obj.length && typeof obj[0] === 'object' && 'x' in obj[0]) {
    return { color: (obj as any).color ?? color, size: (obj as any).size ?? size, points: asPoints(obj), tool: t }
  }
  return null
}
type Parsed = { strokes: Stroke[]; metaW: number; metaH: number }
function parseStrokes(payload:any): Parsed {
  let raw = payload
  try { if (typeof raw === 'string') raw = JSON.parse(raw) } catch {}
  if (!raw) return { strokes: [], metaW: 0, metaH: 0 }

  const metaW = N(raw.canvasWidth ?? raw.canvas_w ?? raw.canvasW ?? raw.width ?? raw.w ?? raw.pageWidth ?? raw.page?.width)
  const metaH = N(raw.canvasHeight ?? raw.canvas_h ?? raw.canvasH ?? raw.height ?? raw.h ?? raw.pageHeight ?? raw.page?.height)

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

/* ------------ build a per-point timeline (ms) ------------ */
/** Core fix: assign global times to *no-t* strokes so their order is preserved across tools. */
function buildPointTimeline(strokes: Stroke[]): Timeline {
  if (!strokes.length) return { strokes: [], t0:0, t1:0 }

  // Pass 1: check coverage of timestamps
  const strokeHasAnyT = strokes.map(s => (s.points||[]).some(p => typeof p.t === 'number'))

  // We'll build TLStroke[] in input order, but compute a GLOBAL running time
  const SEG = 10;     // 10ms between points
  const GAP = 150;    // 150ms between strokes when we must synthesize
  let globalClock = 0;
  let minT = Infinity, maxT = 0

  const out: TLStroke[] = strokes.map((s, idx) => {
    const pts = s.points || []
    const tool = toolOf(s)
    const color = s.color
    const size = s.size

    // If this stroke has *any* timestamps, we keep them and fill gaps relative to last-in-stroke.
    // If it has *none*, we synthesize from the GLOBAL clock (this is the key change).
    const hasT = strokeHasAnyT[idx]
    const tlPts: TLPoint[] = []
    let lastInStroke = hasT ? -Infinity : (globalClock += 0) // no bump yet

    if (!pts.length) {
      // empty stroke: if no pts, still advance global clock slightly to keep ordering
      if (!hasT) globalClock += GAP
      return { color, size, tool, pts: tlPts }
    }

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      let t: number

      if (hasT && typeof p.t === 'number') {
        // keep recorded t, enforce non-decreasing within stroke
        const tt = Math.max(0, p.t as number)
        t = (lastInStroke <= 0) ? tt : Math.max(tt, lastInStroke)
        lastInStroke = t
      } else if (hasT && typeof p.t !== 'number') {
        // stroke has some t's but this point doesn't: fill locally
        t = (lastInStroke > 0) ? lastInStroke + SEG : (globalClock > 0 ? globalClock : 0)
        lastInStroke = t
      } else {
        // stroke has NO timestamps at all -> synthesize from GLOBAL clock
        if (i === 0) {
          // ensure this stroke starts strictly after previous stroke
          globalClock += GAP
          t = globalClock
        } else {
          globalClock += SEG
          t = globalClock
        }
        lastInStroke = t
      }

      tlPts.push({ x: N(p.x), y: N(p.y), t })
      if (t < minT) minT = t
      if (t > maxT) maxT = t
    }

    // if stroke had timestamps, don't modify globalClock based on it; if it didn't, we've already advanced it
    return { color, size, tool, pts: tlPts }
  })

  if (!isFinite(minT)) minT = 0
  const shift = minT
  const shifted = out.map(s => ({ ...s, pts: s.pts.map(p => ({ ...p, t: p.t - shift })) }))
  return { strokes: shifted, t0: 0, t1: Math.max(0, maxT - shift) }
}

/* ------------ flatten to chronological events ------------ */
function buildEventTimeline(tl: Timeline): { events: DrawEvent[]; t1:number } {
  const evs: DrawEvent[] = []
  for (const s of tl.strokes) {
    const color = (s.color ?? '#111').toString()
    const size  = Number.isFinite(s.size) ? (s.size as number) : 4
    const tool  = toolOf(s)
    const pts   = s.pts || []
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      evs.push({
        t: b.t,
        tool,
        color,
        size: tool === 'highlighter' ? size * 1.5 : size,
        x0: a.x, y0: a.y, x1: b.x, y1: b.y,
      })
    }
  }
  // Tie-break: same t => ink first, eraser second
  evs.sort((A, B) => {
    if (A.t !== B.t) return A.t - B.t
    const ae = A.tool === 'eraser', be = B.tool === 'eraser'
    if (ae && !be) return 1
    if (!ae && be) return -1
    return 0
  })
  return { events: evs, t1: tl.t1 }
}

/* ------------ source dims ------------ */
function inferSourceDimsFromMetaOrPdf(metaW:number, metaH:number, pdfCssW:number, pdfCssH:number) {
  if (metaW > 10 && metaH > 10) return { sw: metaW, sh: metaH }
  return { sw: Math.max(1, pdfCssW), sh: Math.max(1, pdfCssH) }
}

/* =================== Component =================== */
export default function PlaybackDrawer({
  onClose, student, pdfUrl, pageIndex, strokesPayload, audioUrl,
}: Props) {
  const [overlay, setOverlay] = useState<OverlaySize>({
    cssW: 800, cssH: 600, dpr: window.devicePixelRatio || 1
  })
  const pdfCssRef = useRef<{ w:number; h:number }>({ w: 800, h: 600 })

  const parsed   = useMemo(() => parseStrokes(strokesPayload), [strokesPayload])
  const tl       = useMemo(() => buildPointTimeline(parsed.strokes), [parsed.strokes])
  const merged   = useMemo(() => buildEventTimeline(tl), [tl])
  const durationMs = merged.t1

  const { sw, sh } = useMemo(
    () => inferSourceDimsFromMetaOrPdf(parsed.metaW, parsed.metaH, pdfCssRef.current.w, pdfCssRef.current.h),
    [parsed.metaW, parsed.metaH, overlay.cssW, overlay.cssH]
  )

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef   = useRef<HTMLAudioElement | null>(null)
  const rafRef     = useRef<number | null>(null)

  const [syncToAudio, setSyncToAudio] = useState<boolean>(!!audioUrl)
  const [strokesPlaying, setStrokesPlaying] = useState(false)

  const [scrubbing, setScrubbing] = useState(false)
  const [scrubMs, setScrubMs] = useState<number>(0) // start at 0

  /* ---- Size/DPR sync ---- */
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

  /* ---- Canvas helpers ---- */
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
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.scale(dpr, dpr)
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
  function applyStyle(ctx: CanvasRenderingContext2D, ev: DrawEvent) {
    if (ev.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#000'
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = ev.tool === 'highlighter' ? 0.35 : 1
      ctx.strokeStyle = ev.color
    }
    ctx.lineWidth = Math.max(1, ev.size)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }

  /* ---- Draw helpers ---- */
  function drawEventsUpTo(ms:number) {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.clearRect(0, 0, cssW, cssH)

    withScale(ctx, () => {
      let lastKey = ''
      for (let i = 0; i < merged.events.length; i++) {
        const ev = merged.events[i]
        if (ev.t > ms) break
        const key = `${ev.tool}|${ev.color}|${ev.size}`
        if (key !== lastKey) { applyStyle(ctx, ev); lastKey = key }
        ctx.beginPath()
        ctx.moveTo(ev.x0, ev.y0)
        ctx.lineTo(ev.x1, ev.y1)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    })
  }

  function drawAllStatic() { drawEventsUpTo(durationMs) }

  /* ---- Effects ---- */
  useEffect(() => { drawAllStatic() }, [overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, strokesPayload, durationMs])

  useEffect(() => {
    if (!syncToAudio) { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } ; return }
    const el = audioRef.current; if (!el) return
    const loop = () => { drawEventsUpTo(el.currentTime * 1000); rafRef.current = requestAnimationFrame(loop) }
    const onPlay = () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = requestAnimationFrame(loop) }
    const onPause = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }; drawEventsUpTo(el.currentTime * 1000) }
    const onSeeked = () => { drawEventsUpTo(el.currentTime * 1000) }
    const onTimeUpdate = () => { if (!rafRef.current) drawEventsUpTo(el.currentTime * 1000) }
    const onEnded = () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }; drawAllStatic() }
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('seeked', onSeeked)
    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('ended', onEnded)
    drawEventsUpTo(el.currentTime * 1000)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('seeked', onSeeked)
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('ended', onEnded)
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
    }
  }, [syncToAudio, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, durationMs])

  useEffect(() => {
    if (!strokesPlaying) return
    const start = performance.now()
    const tick = () => {
      const t = (performance.now() - start)
      drawEventsUpTo(Math.min(t, durationMs))
      if (t >= durationMs) { setStrokesPlaying(false); return }
      rafRef.current = requestAnimationFrame(tick)
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null } }
  }, [strokesPlaying, durationMs, overlay.cssW, overlay.cssH, overlay.dpr, sw, sh])

  useEffect(() => { setScrubMs(0) }, [durationMs])

  const hasAudio = !!audioUrl

  return (
    <div role="dialog" aria-modal="true" style={{ position:'fixed', inset:0, background:'rgba(17,24,39,0.55)', display:'flex', justifyContent:'center', zIndex:50 }}>
      <div style={{ background:'#fff', width:'min(1200px, 96vw)', height:'min(92vh, 980px)', margin:'2vh auto', borderRadius:12, boxShadow:'0 10px 30px rgba(0,0,0,0.2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb', background:'#f9fafb' }}>
          <strong style={{ fontSize:14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
            <button onClick={() => { setSyncToAudio(false); setScrubbing(false); setStrokesPlaying(p => !p) }} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>
              {strokesPlaying ? 'Stop Replay' : 'Replay Strokes'}
            </button>
            <button onClick={() => { setStrokesPlaying(false); setScrubbing(false); setSyncToAudio(s => !s) }} disabled={!hasAudio} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: hasAudio ? '#fff' : '#f3f4f6' }}>
              {syncToAudio ? 'Sync: ON' : 'Sync: OFF'}
            </button>
            <button
              onClick={() => {
                setStrokesPlaying(false)
                setSyncToAudio(false)
                setScrubbing(s => !s)
                const target = !scrubbing ? 0 : scrubMs
                setScrubMs(target)
                drawEventsUpTo(target)
              }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: scrubbing ? '#fee2e2' : '#fff' }}
              title="Scrub (chronological; erases included)"
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

        {/* Content */}
        <div style={{ flex:1, minHeight:0, overflow:'auto', background:'#fafafa' }}>
          <div ref={pdfHostRef} style={{ position:'relative', width:`${overlay.cssW}px`, margin:'12px auto' }}>
            <div style={{ position:'relative' }}>
              <PdfCanvas
                url={pdfUrl}
                pageIndex={pageIndex}
                onReady={(_pdf:any, canvas:HTMLCanvasElement) => {
                  const rect = canvas.getBoundingClientRect()
                  pdfCssRef.current = { w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) }
                  const dpr = window.devicePixelRatio || 1
                  setOverlay(prev => {
                    const cssW = pdfCssRef.current.w, cssH = pdfCssRef.current.h
                    return (prev.cssW === cssW && prev.cssH === cssH && prev.dpr === dpr) ? prev : { cssW, cssH, dpr }
                  })
                }}
              />
              <canvas ref={overlayRef} style={{ position:'absolute', inset:0, width:`${overlay.cssW}px`, height:`${overlay.cssH}px`, pointerEvents:'none' }} />
            </div>
          </div>
        </div>

        {/* Scrubber */}
        <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fff' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, opacity: scrubbing ? 1 : 0.6 }}>
            <span style={{ width: 40, textAlign:'right', fontSize:12, color:'#6b7280' }}>{Math.max(0, Math.round((scrubMs) / 1000))}s</span>
            <input
              type="range"
              min={0}
              max={Math.max(0, durationMs)}
              step={1}
              value={Math.min(durationMs, Math.max(0, scrubMs))}
              onChange={(e) => {
                const v = Math.min(durationMs, Math.max(0, parseInt(e.target.value, 10)))
                setScrubMs(v)
                if (scrubbing) drawEventsUpTo(v)
              }}
              style={{ flex:1 }}
              disabled={!scrubbing || durationMs <= 0}
            />
            <span style={{ width: 40, fontSize:12, color:'#6b7280' }}>{Math.max(0, Math.round(durationMs / 1000))}s</span>
          </div>
          {!scrubbing && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
              Tip: Click <strong>Scrub</strong> to enable the slider. Draw & erase render strictly in chronological order.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
