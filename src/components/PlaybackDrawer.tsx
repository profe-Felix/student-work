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
  return { strokes: [], metaW, metaH, media }
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
  const segments: Seg[] = useMemo(() => {
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

  const { sw, sh } = useMemo(
    () => inferSourceDimsFromMetaOrPdf(parsed.metaW, parsed.metaH, pdfCssRef.current.w, pdfCssRef.current.h),
    [parsed.metaW, parsed.metaH, overlay.cssW, overlay.cssH]
  )

  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const pdfHostRef = useRef<HTMLDivElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)

  const [syncToAudio, setSyncToAudio] = useState<boolean>(segments.length > 0)
  const [scrubbing, setScrubbing] = useState(false)
  const [scrubMs, setScrubMs] = useState<number>(totalMs)

  // clock (relative to timelineZero)
  const clockMsRef = useRef<number>(totalMs)

  // Active segment
  const [segIdx, setSegIdx] = useState<number>(segments.length ? 0 : -1)
  const currentSeg = segIdx >= 0 ? segments[segIdx] : null

  // If legacy single audio, update end when metadata loads
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

  // Draw strokes up to relative time ms (0..totalMs) — converts to absolute by +timelineZero
  function drawAtRelMs(relMs:number) {
    const ctx = ensureCtx()
    if (!ctx) return
    const { cssW, cssH } = overlay
    ctx.globalCompositeOperation = 'source-over'
    ctx.clearRect(0, 0, cssW, cssH)

    if (!pointTL.strokes.length) return
    const cutoffAbs = timelineZero + relMs

    withScale(ctx, () => {
      for (const s of pointTL.strokes) {
        const pts = s.pts
        if (!pts || pts.length === 0) continue
        if (pts[0].t > cutoffAbs) continue

        const pathPts: {x:number;y:number}[] = []
        pathPts.push({ x: pts[0].x, y: pts[0].y })

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

  function stopRAF() {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  /* ---- Always draw final state when size/payload change ---- */
  useEffect(() => { clockMsRef.current = totalMs; drawAtRelMs(totalMs) }, [overlay.cssW, overlay.cssH, overlay.dpr, sw, sh, strokesPayload, totalMs])

  /* ---- AUDIO-SYNC CLOCK (multi-seg) ---- */
  const playSegFromRelMs = (relMs:number) => {
    const absSec = (timelineZero + relMs) / 1000
    if (!segments.length || !audioRef.current) return
    // pick the segment containing absSec (or closest)
    let idx = segments.findIndex(s => absSec >= s.startSec && absSec <= (s.endSec || s.startSec + 0.0001))
    if (idx < 0) {
      if (absSec < segments[0].startSec) idx = 0
      else idx = segments.length - 1
    }
    setSegIdx(idx)
    const seg = segments[idx]
    const within = clamp(absSec - seg.startSec, 0, Math.max(0, (seg.endSec - seg.startSec)))
    try {
      audioRef.current.src = seg.url
      audioRef.current.currentTime = within
      // start drawing immediately at this clock position
      clockMsRef.current = relMs
      drawAtRelMs(clockMsRef.current)
      audioRef.current.play().catch(()=>{})
    } catch {}
  }

  // Hook audio time updates to draw when syncing
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (!syncToAudio) { stopRAF(); return }

    const onTime = () => {
      const seg = currentSeg
      if (!seg) return
      const absSec = seg.startSec + (a.currentTime || 0)
      const relMs = clamp((absSec * 1000) - timelineZero, 0, totalMs)
      clockMsRef.current = relMs
      // Use RAF to smooth
      if (!rafRef.current) {
        const tick = () => { drawAtRelMs(clockMsRef.current); rafRef.current = requestAnimationFrame(tick) }
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    const onEnded = () => {
      stopRAF()
      if (segIdx + 1 < segments.length) {
        setSegIdx(segIdx + 1)
        setTimeout(() => { playSegFromRelMs((segments[segIdx + 1].startSec * 1000) - timelineZero) }, 0)
      } else {
        // finished
        clockMsRef.current = totalMs
        drawAtRelMs(totalMs)
      }
    }
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('ended', onEnded)
    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('ended', onEnded)
      stopRAF()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncToAudio, segIdx, segments, timelineZero, totalMs, currentSeg])

  // Keep scrub range synced
  useEffect(() => { setScrubMs(totalMs); clockMsRef.current = totalMs }, [totalMs])

  const hasAnyAudio = segments.length > 0

  return (
    <div role="dialog" aria-modal="true" style={{ position:'fixed', inset:0, background:'rgba(17,24,39,0.55)', display:'flex', justifyContent:'center', zIndex:50 }}>
      <div style={{ background:'#fff', width:'min(1200px, 96vw)', height:'min(92vh, 980px)', margin:'2vh auto', borderRadius:12, boxShadow:'0 10px 30px rgba(0,0,0,0.2)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:12, padding:12, borderBottom:'1px solid #e5e7eb', background:'#f9fafb' }}>
          <strong style={{ fontSize:14 }}>Preview — {student || 'Student'}</strong>
          <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
            <button
              onClick={() => { setSyncToAudio(s => !s); setScrubbing(false) }}
              disabled={!hasAnyAudio}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background: hasAnyAudio ? '#fff' : '#f3f4f6' }}
              title={hasAnyAudio ? 'Tie ink to audio segments' : 'No audio available'}
            >
              {syncToAudio ? 'Sync: ON' : 'Sync: OFF'}
            </button>
            <button
              onClick={() => {
                setSyncToAudio(false)
                setScrubbing(s => !s)
                if (!scrubbing) { setScrubMs(totalMs); clockMsRef.current = totalMs; drawAtRelMs(totalMs) }
                else { drawAtRelMs(clockMsRef.current) }
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
          {hasAnyAudio ? (
            <>
              {/* Hidden; we drive it via segments + Sync:ON */}
              <audio ref={audioRef} preload="auto" style={{ display:'none' }} />
              <span style={{ fontSize:12, color:'#374151' }}>
                {segments.length} clip{segments.length===1 ? '' : 's'}
              </span>
              <button
                onClick={() => {
                  if (!syncToAudio) return
                  // start from current clock
                  playSegFromRelMs(clockMsRef.current)
                }}
                style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}
              >
                Play
              </button>
              <button onClick={() => { try { audioRef.current?.pause() } catch {}; stopRAF() }}
                      style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>
                Pause
              </button>
            </>
          ) : (
            <span style={{ fontSize:12, color:'#6b7280' }}>No audio</span>
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
          <div style={{ display:'flex', alignItems:'center', gap:10, opacity: scrubbing ? 1 : 0.6 }}>
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
                  // live seek while synced: align audio to this ms but don’t auto-play
                  clockMsRef.current = v
                  drawAtRelMs(v)
                  if (syncToAudio && segments.length) {
                    try { audioRef.current?.pause() } catch {}
                    playSegFromRelMs(v)
                    try { audioRef.current?.pause() } catch {}
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
              Tip: Click <strong>Scrub</strong> to enable the slider. The timeline includes erasing in chronological order.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
