import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

type Pt = { x:number; y:number }
type Stroke = { color:string; size:number; tool:'pen'|'highlighter'; pts:Pt[] }
type StrokesPayload = {
  strokes: Stroke[]
  // meta saved at capture time (preferred)
  canvasWidth?: number
  canvasHeight?: number
  // tolerate older/alias names
  canvas_w?: number; canvas_h?: number
  w?: number; h?: number
  width?: number; height?: number
}

type Seg = { x0:number; y0:number; x1:number; y1:number; color:string; size:number; tool:'pen'|'highlighter'; len:number }
type Built = { segs: Seg[]; totalLen: number; duration: number }

export default function PlaybackDrawer({
  pdfUrl,
  pageIndex,
  // accept both names; teacher/index.tsx used strokesPayload + onClose, student
  strokesJson,
  strokesPayload,
  audioUrl,
  title = 'Preview',
  onClose,
  student,
}:{
  pdfUrl: string
  pageIndex: number
  strokesJson?: unknown
  strokesPayload?: unknown
  audioUrl?: string | null
  title?: string
  onClose?: () => void
  student?: string
}) {
  const overlayRef = useRef<HTMLCanvasElement|null>(null)
  const pdfCssRef  = useRef<{ w:number; h:number }>({ w: 800, h: 600 })
  const [pdfReady, setPdfReady] = useState(false)

  const audioRef = useRef<HTMLAudioElement|null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [nowMs, setNowMs] = useState(0)        // current time (ms)
  const [durationMs, setDurationMs] = useState(0) // total ms
  const rafRef = useRef<number| null>(null)

  // Parse strokes (tolerant)
  const parsed = useMemo(
    () => parseStrokes(strokesJson ?? strokesPayload),
    [strokesJson, strokesPayload]
  )

  // Build drawable segments + animation duration
  const built = useMemo(() => buildSegments(parsed), [parsed])

  // Keep overlay canvas sized to the PDF's CSS box (and crisp via DPR)
  useEffect(() => {
    const host = document.querySelector('[data-preview-pdf-host]') as HTMLElement | null
    if (!host) return
    const ro = new ResizeObserver(() => {
      const c = host.querySelector('canvas') as HTMLCanvasElement | null
      if (!c) return
      const cssW = Math.round(parseFloat(getComputedStyle(c).width))
      const cssH = Math.round(parseFloat(getComputedStyle(c).height))
      pdfCssRef.current = { w: cssW, h: cssH }
      setupOverlayCanvas(cssW, cssH, overlayRef.current)
      drawUpTo(nowMs) // keep in sync on resize
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [nowMs])

  // Initialize duration (from audio or fallback to built.duration)
  useEffect(() => {
    if (audioUrl) {
      const a = audioRef.current
      if (!a) return
      const onLoaded = () => {
        setDurationMs(Math.max(0, (a.duration || 0) * 1000))
      }
      const onTime = () => {
        const t = Math.max(0, a.currentTime * 1000)
        setNowMs(t)
        drawUpTo(t)
      }
      const onEnd = () => {
        setIsPlaying(false)
      }
      a.addEventListener('loadedmetadata', onLoaded)
      a.addEventListener('timeupdate', onTime)
      a.addEventListener('ended', onEnd)
      // if metadata already available
      if (a.duration && !Number.isNaN(a.duration)) setDurationMs(a.duration * 1000)
      return () => {
        a.removeEventListener('loadedmetadata', onLoaded)
        a.removeEventListener('timeupdate', onTime)
        a.removeEventListener('ended', onEnd)
      }
    } else {
      // no audio: derive duration from drawing length
      setDurationMs(built.duration)
      setNowMs(0)
    }
  }, [audioUrl, built.duration])

  // Animation loop when no audio
  useEffect(() => {
    if (audioUrl) return // audio drives time
    if (!isPlaying) {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
      return
    }
    const start = performance.now() - nowMs
    const tick = (t:number) => {
      const elapsed = t - start
      const clamped = Math.min(durationMs, Math.max(0, elapsed))
      setNowMs(clamped)
      drawUpTo(clamped)
      if (clamped >= durationMs) {
        setIsPlaying(false)
        rafRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }, [isPlaying, durationMs, audioUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  function onPdfReady(_pdf:any, canvas:HTMLCanvasElement) {
    try {
      const cssW = Math.round(parseFloat(getComputedStyle(canvas).width))
      const cssH = Math.round(parseFloat(getComputedStyle(canvas).height))
      pdfCssRef.current = { w: cssW, h: cssH }
      setupOverlayCanvas(cssW, cssH, overlayRef.current)
      setPdfReady(true)
      drawUpTo(nowMs)
    } catch {
      setPdfReady(true)
    }
  }

  function setupOverlayCanvas(cssW:number, cssH:number, cnv:HTMLCanvasElement|null) {
    if (!cnv) return
    const dpr = (window.devicePixelRatio || 1)
    cnv.width  = Math.max(1, Math.floor(cssW * dpr))
    cnv.height = Math.max(1, Math.floor(cssH * dpr))
    cnv.style.width  = cssW + 'px'
    cnv.style.height = cssH + 'px'
    const ctx = cnv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function clearOverlay() {
    const cnv = overlayRef.current
    if (!cnv) return
    const ctx = cnv.getContext('2d')
    if (!ctx) return
    ctx.save()
    ctx.setTransform(1,0,0,1,0,0)
    ctx.clearRect(0,0, cnv.width, cnv.height)
    ctx.restore()
    const dpr = (window.devicePixelRatio || 1)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // Scale from capture (sw,sh) → current PDF CSS (dw,dh)
  function withScale<T>(ctx:CanvasRenderingContext2D, sw:number, sh:number, dw:number, dh:number, fn:()=>T):T {
    const sx = dw / Math.max(1, sw)
    const sy = dh / Math.max(1, sh)
    ctx.save()
    ctx.scale(sx, sy)
    const out = fn()
    ctx.restore()
    return out
  }

  function drawStroke(ctx:CanvasRenderingContext2D, s:Stroke) {
    if (!s.pts || s.pts.length === 0) return
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.size
    ctx.beginPath()
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i]
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
    ctx.restore()
  }

  function drawUpTo(tMs:number) {
    if (!pdfReady) return
    const cnv = overlayRef.current
    if (!cnv) return
    const ctx = cnv.getContext('2d')
    if (!ctx) return

    clearOverlay()

    const { w: dw, h: dh } = pdfCssRef.current
    const { sw, sh } = inferSourceDims(parsed, dw, dh)

    const total = built.duration || 1
    const ratio = Math.max(0, Math.min(1, tMs / total))
    const cutoffLen = built.totalLen * ratio

    let acc = 0
    withScale(ctx, sw, sh, dw, dh, () => {
      // draw full segments up to cutoff
      for (const seg of built.segs) {
        if (acc + seg.len <= cutoffLen) {
          strokeSegment(ctx, seg, 1) // full
          acc += seg.len
        } else {
          // draw partial of this segment if needed
          const remain = cutoffLen - acc
          if (remain > 0 && seg.len > 0) {
            const partial = Math.max(0, Math.min(1, remain / seg.len))
            strokeSegment(ctx, seg, partial)
          }
          break
        }
      }
    })
  }

  function strokeSegment(ctx:CanvasRenderingContext2D, seg:Seg, portion:number) {
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = seg.tool === 'highlighter' ? 0.35 : 1
    ctx.strokeStyle = seg.color
    ctx.lineWidth = seg.size
    const x = seg.x0 + (seg.x1 - seg.x0) * portion
    const y = seg.y0 + (seg.y1 - seg.y0) * portion
    ctx.beginPath()
    ctx.moveTo(seg.x0, seg.y0)
    ctx.lineTo(x, y)
    ctx.stroke()
    ctx.restore()
  }

  // Controls
  const togglePlay = async () => {
    if (audioUrl) {
      const a = audioRef.current
      if (!a) return
      if (isPlaying) {
        a.pause()
        setIsPlaying(false)
      } else {
        // if we were at end, restart
        if (a.currentTime * 1000 >= durationMs - 10) a.currentTime = 0
        try { await a.play(); setIsPlaying(true) } catch {/* autoplay blocked? */}
      }
    } else {
      if (isPlaying) {
        setIsPlaying(false)
      } else {
        // restart if at end
        if (nowMs >= durationMs - 1) setNowMs(0)
        setIsPlaying(true)
      }
    }
  }

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    const t = Math.max(0, Math.min(durationMs, v))
    if (audioUrl) {
      const a = audioRef.current
      if (a) a.currentTime = t / 1000
    } else {
      setNowMs(t)
      drawUpTo(t)
    }
  }

  const fmt = (ms:number) => {
    const s = Math.floor(ms/1000)
    const m = Math.floor(s/60)
    const ss = (s % 60).toString().padStart(2,'0')
    return `${m}:${ss}`
  }

  return (
    <div
      style={{
        position:'fixed', inset:0, zIndex: 40000,
        display:'grid', placeItems:'center',
        background:'rgba(0,0,0,0.55)',
        backdropFilter:'blur(2px)'
      }}
    >
      <div
        style={{
          width:'min(980px, 94vw)',
          maxHeight:'88vh',
          background:'#fff',
          borderRadius:14,
          boxShadow:'0 18px 40px rgba(0,0,0,0.35)',
          display:'flex',
          flexDirection:'column',
          overflow:'hidden'
        }}
      >
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontWeight:800 }}>{title}{student ? ` — ${student}` : ''}</div>
          <button
            onClick={onClose}
            style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}
          >
            Close
          </button>
        </div>

        <div style={{ padding:12, overflow:'auto' }}>
          <div style={{ position:'relative', margin:'0 auto', width: pdfCssRef.current.w + 'px' }}>
            <div data-preview-pdf-host style={{ position:'relative' }}>
              <PdfCanvas url={pdfUrl} pageIndex={pageIndex} onReady={onPdfReady} />
            </div>
            <canvas
              ref={overlayRef}
              style={{
                position:'absolute',
                inset:0,
                pointerEvents:'none'
              }}
            />
          </div>

          {/* Controls */}
          <div style={{ marginTop:12, display:'flex', alignItems:'center', gap:10 }}>
            <button
              onClick={togglePlay}
              style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #ddd', background:'#fff', minWidth:88, fontWeight:700 }}
            >
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <div style={{ fontVariantNumeric:'tabular-nums', minWidth:60, textAlign:'right' }}>{fmt(nowMs)}</div>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(durationMs))}
              value={Math.min(Math.floor(nowMs), Math.floor(durationMs))}
              onChange={onScrub}
              style={{ flex:1 }}
            />
            <div style={{ fontVariantNumeric:'tabular-nums', minWidth:60 }}>{fmt(durationMs)}</div>
          </div>

          {/* Hidden audio element when present */}
          {audioUrl && (
            <audio
              ref={audioRef}
              src={audioUrl || undefined}
              preload="metadata"
              style={{ display:'none' }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ================= helpers ================= */

function parseStrokes(raw: unknown): StrokesPayload {
  const out: StrokesPayload = { strokes: [] }
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as any

  // strokes
  const arr = Array.isArray(obj.strokes) ? obj.strokes : []
  out.strokes = arr
    .map((s:any) => sanitizeStroke(s))
    .filter(Boolean) as Stroke[]

  // meta (aliases tolerated)
  const metaW = num(obj.canvasWidth) ?? num(obj.canvas_w) ?? num(obj.w) ?? num(obj.width)
  const metaH = num(obj.canvasHeight) ?? num(obj.canvas_h) ?? num(obj.h) ?? num(obj.height)
  if (metaW && metaH) {
    out.canvasWidth = metaW
    out.canvasHeight = metaH
  }
  return out
}

function sanitizeStroke(s:any): Stroke | null {
  if (!s || typeof s !== 'object') return null
  const color = typeof s.color === 'string' ? s.color : '#000'
  const size  = Number.isFinite(s.size) ? s.size : 4
  const tool  = s.tool === 'highlighter' ? 'highlighter' : 'pen'
  const pts   = Array.isArray(s.pts) ? s.pts.filter((p:any)=> p && Number.isFinite(p.x) && Number.isFinite(p.y)) : []
  if (pts.length === 0) return null
  return { color, size, tool, pts }
}

function num(v:any): number | undefined {
  return Number.isFinite(v) ? (v as number) : undefined
}

function inferSourceDims(payload: StrokesPayload, fallbackW:number, fallbackH:number) {
  const mw = num(payload.canvasWidth)
  const mh = num(payload.canvasHeight)
  if (mw && mh && mw > 0 && mh > 0) return { sw: mw, sh: mh }
  return { sw: fallbackW, sh: fallbackH }
}

// Build segments for animation. If no audio, derive duration from total length (px) / speed.
function buildSegments(payload: StrokesPayload): Built {
  const segs: Seg[] = []
  let totalLen = 0

  for (const s of payload.strokes) {
    if (!s.pts || s.pts.length < 2) continue
    for (let i = 1; i < s.pts.length; i++) {
      const p0 = s.pts[i-1], p1 = s.pts[i]
      const dx = p1.x - p0.x, dy = p1.y - p0.y
      const len = Math.hypot(dx, dy)
      if (len === 0) continue
      segs.push({ x0:p0.x, y0:p0.y, x1:p1.x, y1:p1.y, color:s.color, size:s.size, tool:s.tool, len })
      totalLen += len
    }
  }

  // Heuristic speed (pixels per millisecond) for no-audio animation.
  // Tune if desired. Larger => faster.
  const pxPerMs = 0.8
  const duration = totalLen > 0 ? Math.max(800, Math.round(totalLen / pxPerMs)) : 0

  return { segs, totalLen, duration }
}
