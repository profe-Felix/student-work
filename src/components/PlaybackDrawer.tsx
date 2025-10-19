// src/components/PlaybackDrawer.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

export type Props = {
  onClose: () => void
  student: string
  pdfUrl: string
  pageIndex: number
  strokesPayload: any
  /** legacy single audio artifact (old path) */
  audioUrl?: string
}

/* ========================= Types ========================= */
type TimedPoint = { x: number; y: number; t?: number }
type Stroke = { color?: string; size?: number; points: TimedPoint[]; tool?: string }
type OverlaySize = { cssW: number; cssH: number; dpr: number }

// media segment saved in strokes_json.media[]
type AudioSeg = {
  kind: 'audio'
  id: string
  startMs: number
  durationMs: number
  mime?: string
  url: string
}
type Seg = AudioSeg & { startSec: number; endSec: number } // convenience

const N = (v:any) => {
  const x = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(x) ? x : 0
}
const clamp = (v:number, lo:number, hi:number) => Math.min(hi, Math.max(lo, v))

/* ------------ parse strokes (supports your {strokes:[{pts:[]}]}, etc.) ------------ */
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
type Parsed = { strokes: Stroke[]; metaW: number; metaH: number; media: AudioSeg[] }
function parseStrokes(payload:any): Parsed {
  let raw = payload
  try { if (typeof raw === 'string') raw = JSON.parse(raw) } catch {}
  if (!raw) return { strokes: [], metaW: 0, metaH: 0, media: [] }

  let metaW = N(raw.canvasWidth ?? raw.canvas_w ?? raw.canvasW ?? raw.width ?? raw.w ?? raw.pageWidth ?? raw.page?.width)
  let metaH = N(raw.canvasHeight ?? raw.canvas_h ?? raw.canvasH ?? raw.height ?? raw.h ?? raw.pageHeight ?? raw.page?.height)

  const media: AudioSeg[] = Array.isArray(raw?.media)
    ? raw.media
        .filter((m:any)=> m && m.kind==='audio' && typeof m.startMs==='number' && typeof m.durationMs==='number' && typeof m.url==='string')
        .map((m:any)=>({ kind:'audio', id:String(m.id||`${m.startMs}`), startMs:N(m.startMs), durationMs:N(m.durationMs), mime:m.mime, url:String(m.url)}))
    : []

  if (raw && raw.data) raw = raw.data
  const toParsed = (arr:any[]): Parsed => ({ strokes: (arr.map(toStroke).filter(Boolean) as Stroke[]), metaW, metaH, media })

  if (Array.isArray(raw)) {
    if (raw.length && typeof raw[0] === 'object' && ('x' in raw[0] || 'pts' in raw[0])) {
      const s = toStroke(raw); return { strokes: s ? [s] : [], metaW, metaH, media }
    }
    return toParsed(raw)
  }

  const buckets:any[] = []
  if (Array.isArray(raw.strokes)) buckets.push(...raw.strokes)
  if (Array.isArray(raw.lines))   buckets.push(...raw.lines)
  if (Array.isArray(raw.paths))   buckets.push(...raw.paths)

  if (!buckets.length && Array.isArray(raw.points)) {
    const s = toStroke(raw); return { strokes: s ? [s] : [], metaW, metaH, media }
  }
  if (buckets.length) return toParsed(buckets)

  const vals = Object.values(raw)
  if (vals.length && Array.isArray(vals[0])) {
    const s = toStroke(vals[0]); return { strokes: s ? [s] : [], metaW, metaH, media }
  }
  return { strokes: [], metaW: 0, metaH: 0, media }
}

/* ------------ UNIFIED, CHRONOLOGICAL POINT TIMELINE (ink + eraser) ------------ */
const isEraserTool = (tool?: string) =>
  tool === 'eraser' || tool === 'eraserObject' || tool === 'erase'

type TLPoint = { x:number; y:number; t:number }
type TLStroke = { color?:string; size?:number; tool?:string; pts: TLPoint[] }
type PointTimeline = { strokes: TLStroke[]; tMin:number; tMax:number } // ms absolute

function buildUnifiedPointTimeline(strokes: Stroke[]): PointTimeline {
  if (!strokes.length) return { strokes: [], tMin: 0, tMax: 0 }

  const SEG_MS = 10
  const GAP_MS = 150

  const tl: TLStroke[] = []
  let clock = 0
  let globalMin = Infinity
  let globalMax = 0

  for (const s of strokes) {
    const src = s.points || []
    if (!src.length) { clock += GAP_MS; continue }

    const strokeHasT = src.some(p => typeof p.t === 'number')

    let pts: TLPoint[] = []
    if (strokeHasT) {
      let last = -Infinity
      const raw: TLPoint[] = src.map((p) => {
        const base = (typeof p.t === 'number') ? N(p.t) : (last > 0 ? last + SEG_MS : 0)
        const t = base < last ? last : base
        last = t
        return { x: N(p.x), y: N(p.y), t }
      })
      const firstT = raw[0].t
      const shift = firstT < clock ? (clock - firstT) : 0
      pts = raw.map(p => ({ ...p, t: p.t + shift }))
      clock = pts[pts.length - 1].t + GAP_MS
    } else {
      pts.push({ x: N(src[0].x), y: N(src[0].y), t: clock })
      for (let i = 1; i < src.length; i++) {
        clock += SEG_MS
        pts.push({ x: N(src[i].x), y: N(src[i].y), t: clock })
      }
      clock += GAP_MS
    }

    for (const p of pts) {
      if (p.t < globalMin) globalMin = p.t
      if (p.t > globalMax) globalMax = p.t
    }
    tl.push({ color: s.color, size: s.size, tool: s.tool, pts })
  }

  if (!isFinite(globalMin)) globalMin = 0
  return { strokes: tl, tMin: globalMin, tMax: globalMax }
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
  const [overlay, setOverlay] = useState<OverlaySize>({
    cssW: 800, cssH: 600, dpr: window.devicePixelRatio || 1
  })
  const pdfCssRef = useRef<{ w:number; h:number }>({ w: 800, h: 600 })

  const parsed = useMemo(() => parseStrokes(strokesPayload), [strokesPayload])
  const strokes = parsed.strokes

  // Unified ms timeline (ink + eraser in correct order, *absolute t*)
  const pointTL = useMemo(() => buildUnifiedPointTimeline(strokes), [strokes])

  // Build segments from media[] or legacy single audioUrl
  const segments: Seg[] = useMemo<Seg[]>(() => {
    if (parsed.media.length) {
      return parsed.media
        .map(m => ({
          ...m,
          startSec: m.startMs / 1000,
          endSec: (m.startMs + m.durationMs) / 1000
        }))
        .sort((a,b) => a.startSec - b.startSec)
    }
    if (audioUrl) {
      return [{
        kind:'audio', id:'legacy-0', startMs:0, durationMs:0, mime: 'audio/*', url: audioUrl,
        startSec: 0, endSec: 0
      }]
    }
    return []
  }, [parsed.media, audioUrl])

  // Timeline zero = earliest among ink points and media starts
  const timelineZero = useMemo(() => {
    let t0 = Number.POSITIVE_INFINITY
    if (pointTL.strokes.length) t0 = Math.min(t0, pointTL.tMin)
    for (const s of segments) t0 = Math.min(t0, s.startMs)
    return Number.isFinite(t0) ? t0 : 0
  }, [pointTL.tMin, segments])

  // Total duration = latest among ink end and media end, minus zero
  const totalMs = useMemo(() => {
    let tMax = pointTL.tMax
    for (const s of segments) tMax = Math.max(tMax, s.endSec * 1000)
    return Math.max(1000, Math.ceil(tMax - timelineZero))
  }, [pointTL.tMax, segments, timelineZero])

  // ===== NEW: Delay INK before the first stroke so audio and ink line up =====
  // Positive = draw later. Adjust in ±100–200ms steps.
  const PRE_INK_DRAW_DELAY_MS = 7000
  const firstInkT = pointTL.strokes.length ? pointTL.tMin : Number.POSITIVE_INFINITY
  const firstInkAbsSec = Number.isFinite(firstInkT) ? firstInkT / 1000 : Infinity

  const { sw, sh } = useMemo(
    () => inferSourceDimsFromMetaOrPdf(parsed.metaW, parsed.metaH, pdfCssRef.current.w, pdfCssRef.current.h),
    [parsed.metaW, parsed.metaH, overlay.cssW, overlay.cssH]
  )

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Master playback state
  const [syncToAudio, setSyncToAudio] = useState<boolean>(segments.length > 0)
  const [scrubbing, setScrubbing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const clockMsRef = useRef<number>(totalMs)  // relative ms (0..totalMs)

  // Timer engine
  const intervalRef = useRef<number | null>(null)
  const lastWallRef = useRef<number | null>(null)

  // Keep scrub range synced on payload/size changes & draw final frame
  const [scrubMs, setScrubMs] = useState<number>(totalMs)
  useEffect(() => { setScrubMs(totalMs); clockMsRef.current = totalMs; drawAtRelMs(totalMs) }, [totalMs])

  // If legacy single audio, set its duration on metadata
  useEffect(() => {
    const a = audioRef.current
    if (!a || !segments.length || segments[0].id !== 'legacy-0') return
    const onMeta = () => {
      const dur = a.duration || 0
      if (dur > 0) {
        segments[0].durationMs = dur * 1000
        segments[0].endSec = dur
      }
    }
    a.addEventListener('loadedmetadata', onMeta)
    return () => a.removeEventListener('loadedmetadata', onMeta)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length])

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

  /* ---- Drawing helpers ---- */
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

  function applyStyleForTool(ctx: CanvasRenderingContext2D, color: string, size: number, tool?: string) {
    const isHi = tool === 'highlighter'
    const isErase = isEraserTool(tool)

    if (isErase) {
      ctx.globalCompositeOperation = 'destination-out'
      ctx.globalAlpha = 1
      ctx.strokeStyle = '#000'
      ctx.lineWidth = Math.max(1, size * 2)
    } else {
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = isHi ? 0.35 : 1.0
      ctx.strokeStyle = color || '#111'
      ctx.lineWidth = Math.max(1, isHi ? size * 2 : size)
    }
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
  }

  // Find segment containing absolute seconds
  function findSegByAbsSec(absSec:number): { idx:number, seg:Seg } | null {
    if (!segments.length) return null
    let lo = 0, hi = segments.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const s = segments[mid]
      if (absSec < s.startSec) hi = mid - 1
      else if (absSec > s.endSec) lo = mid + 1
      else return { idx: mid, seg: s }
    }
    return null
  }

  // Draw strokes up to relative time ms (0..totalMs) — converts to absolute by +timelineZero
  // NEW: apply PRE_INK_DRAW_DELAY_MS before the very first ink point
  function drawAtRelMs(relMs:number) {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, cssW, cssH)

    if (!pointTL.strokes.length) return

    const visualAbsSec = (timelineZero + relMs) / 1000
    const extraDelay = visualAbsSec < firstInkAbsSec ? PRE_INK_DRAW_DELAY_MS : 0
    const cutoffAbs = Math.max(timelineZero, timelineZero + relMs - extraDelay)

    withScale(ctx, () => {
      for (const s of pointTL.strokes) {
        const pts = s.pts
        if (!pts || pts.length === 0) continue
        if (pts[0].t > cutoffAbs) continue

        const pathPts: {x:number;y:number}[] = [{ x: pts[0].x, y: pts[0].y }]
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i]
          if (b.t <= cutoffAbs) {
            pathPts.push({ x: b.x, y: b.y })
          } else if (a.t < cutoffAbs && cutoffAbs < b.t) {
            const u = clamp((cutoffAbs - a.t) / Math.max(1, b.t - a.t), 0, 1)
            pathPts.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
            break
          } else if (a.t >= cutoffAbs) {
            break
          }
        }

        if (pathPts.length >= 1) {
          applyStyleForTool(ctx, s.color || '#111', s.size || 4, s.tool)
          ctx.beginPath()
          ctx.moveTo(pathPts[0].x, pathPts[0].y)
          for (let i = 1; i < pathPts.length; i++) ctx.lineTo(pathPts[i].x, pathPts[i].y)
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    })
  }

  // ==== TIMER ENGINE ====
  function stopTimer() {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    lastWallRef.current = null
  }

  function startTimer() {
    stopTimer()
    lastWallRef.current = performance.now()
    intervalRef.current = window.setInterval(() => {
      const now = performance.now()
      const last = lastWallRef.current ?? now
      const dt = now - last
      lastWallRef.current = now

      // advance clock
      const next = clamp(clockMsRef.current + dt, 0, totalMs)
      clockMsRef.current = next

      // draw (with pre-ink delay)
      drawAtRelMs(next)

      // audio follow — NO artificial offset now
      if (syncToAudio && audioRef.current) {
        const absSec = (timelineZero + next) / 1000
        const hit = findSegByAbsSec(absSec)
        const a = audioRef.current
        if (hit) {
          const { seg } = hit
          const within = absSec - seg.startSec
          if (!a.src || a.src !== seg.url) {
            try {
              a.src = seg.url
              a.currentTime = Math.max(0, within)
              a.play().catch(()=>{})
            } catch {}
          } else {
            const drift = Math.abs((a.currentTime || 0) - within)
            if (drift > 0.1) { try { a.currentTime = Math.max(0, within) } catch {} }
            if (a.paused) { a.play().catch(()=>{}) }
          }
        } else {
          try { if (!a.paused) a.pause() } catch {}
        }
      }

      // stop at end
      if (clockMsRef.current >= totalMs) {
        setPlaying(false)
        stopTimer()
      }
    }, 16) // ~60 FPS
  }

  function play(fromRelMs?: number) {
    if (typeof fromRelMs === 'number') {
      clockMsRef.current = clamp(fromRelMs, 0, totalMs)
      drawAtRelMs(clockMsRef.current)
    }
    if (!playing) {
      setPlaying(true)
      startTimer()
    }
  }
  function pause() {
    setPlaying(false)
    stopTimer()
    try { audioRef.current?.pause() } catch {}
  }

  // Keep overlay updated on size/payload change when not playing
  useEffect(() => {
    if (!playing) drawAtRelMs(clockMsRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, strokesPayload])

  // Cleanup
  useEffect(() => stopTimer, [])

  const hasAnyAudio = segments.length > 0

  return (
    <div role="dialog" aria-modal="true" style={{ position:'fixed', inset:0, background:'rgba(17,24,39,0.55)', display:'flex', justifyContent:'center', zIndex:50 }}>
      <div style={{ background:'#fff', width:'min(1200px, 96vw)', height:'min(92vh, 980px)', margin:'2vh auto', borderRadius:12, boxShadow:'0 10px 30px rgba(0,0,0,0.2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb', background:'#f9fafb' }}>
          <strong style={{ fontSize:14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
            <button
              onClick={() => { setSyncToAudio(s => !s) }}
              disabled={!hasAnyAudio}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: hasAnyAudio ? '#fff' : '#f3f4f6' }}
              title={hasAnyAudio ? 'Tie ink to audio segments' : 'No audio available'}
            >
              {syncToAudio ? 'Sync: ON' : 'Sync: OFF'}
            </button>
            <button
              onClick={() => {
                setScrubbing(s => !s)
                if (!scrubbing) { pause() } else { drawAtRelMs(clockMsRef.current) }
              }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: scrubbing ? '#fee2e2' : '#fff' }}
              title="Scrub through the unified timeline (ink + eraser)"
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
          {/* Hidden; we drive it off the master clock */}
          <audio ref={audioRef} preload="auto" style={{ display:'none' }} />
          <span style={{ fontSize:12, color:'#374151' }}>
            {hasAnyAudio ? `${segments.length} clip${segments.length===1 ? '' : 's'}` : 'No audio'}
          </span>
          {!playing ? (
            <button
              onClick={() => {
                if (clockMsRef.current >= totalMs) {
                  clockMsRef.current = 0
                  drawAtRelMs(0)
                }
                play()
              }}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}
            >
              Play
            </button>
          ) : (
            <button
              onClick={pause}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}
            >
              Pause
            </button>
          )}
          <span style={{ marginLeft:'auto', fontSize:12, color:'#6b7280' }}>Page {pageIndex + 1}</span>
        </div>

        {/* Content: PDF underlay + overlay */}
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
              <canvas
                ref={overlayRef}
                style={{ position:'absolute', inset:0, width:`${overlay.cssW}px`, height:`${overlay.cssH}px`, pointerEvents:'none' }}
              />
            </div>
          </div>
        </div>

        {/* Scrubber */}
        <div style={{ padding: 12, borderTop: '1px solid #e5e7eb', background: '#fff' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10, opacity: scrubbing ? 1 : 0.9 }}>
            <span style={{ width: 40, textAlign:'right', fontSize:12, color:'#6b7280' }}>
              {Math.max(0, Math.round((scrubbing ? scrubMs : clockMsRef.current) / 1000))}s
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(0, totalMs)}
              step={1}
              value={Math.min(totalMs, Math.max(0, scrubbing ? scrubMs : clockMsRef.current))}
              onChange={(e) => {
                const v = clamp(parseInt(e.target.value, 10) || 0, 0, totalMs)
                if (scrubbing) {
                  setScrubMs(v)
                  clockMsRef.current = v
                  drawAtRelMs(v)
                } else {
                  clockMsRef.current = v
                  drawAtRelMs(v)
                  if (syncToAudio && audioRef.current) {
                    const absSec = (timelineZero + v) / 1000
                    const hit = findSegByAbsSec(absSec)
                    const a = audioRef.current
                    if (hit) {
                      const { seg } = hit
                      const within = absSec - seg.startSec
                      try {
                        a.src = seg.url
                        a.currentTime = Math.max(0, within)
                        if (playing) a.play().catch(()=>{})
                        else a.pause()
                      } catch {}
                    } else {
                      try { a.pause() } catch {}
                    }
                  }
                }
              }}
              style={{ flex:1 }}
              disabled={totalMs <= 0}
            />
            <span style={{ width: 40, fontSize:12, color:'#6b7280' }}>
              {Math.max(0, Math.round(totalMs / 1000))}s
            </span>
          </div>
          {!scrubbing && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
              Tip: <strong>Play</strong> advances even during silence; audio auto-joins during its clips.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
