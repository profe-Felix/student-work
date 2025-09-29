
import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

/* ================= types ================= */

type Pt = { x:number; y:number; t?:number }  // <-- t (ms since capture start) is optional
type Stroke = { color:string; size:number; tool:'pen'|'highlighter'; pts:Pt[] }
type StrokesPayload = {
  strokes: Stroke[]
  // capture meta (preferred)
  canvasWidth?: number
  canvasHeight?: number
  // tolerant aliases
  canvas_w?: number; canvas_h?: number
  w?: number; h?: number
  width?: number; height?: number
  // timing (optional, from capture/submission)
  timing?: {
    capturePerf0Ms?: number
    audioOffsetMs?: number // positive: ink starts AFTER audio; negative: BEFORE
  }
}

type Seg = {
  x0:number; y0:number; x1:number; y1:number;
  color:string; size:number; tool:'pen'|'highlighter';
  len:number;
  // time bounds (ms since capture start) – filled only if timestamps exist
  t0?:number; t1?:number;
}

type Built = {
  segs: Seg[];
  totalLen: number;
  durationLenHeuristic: number; // old length-based duration (pxPerMs) as fallback
  hasTimestamps: boolean;
  timeStart:number;              // earliest seg.t0 when hasTimestamps
  timeEnd:number;                // last seg.t1 when hasTimestamps
}

type PlayMode = 'strokes' | 'together'  // strokes only vs strokes + audio

/* ================= component ================= */

export default function PlaybackDrawer({
  pdfUrl,
  pageIndex,
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
  const [nowMs, setNowMs] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const rafRef = useRef<number| null>(null)

  const audioAvailable = !!audioUrl
  const [playMode, setPlayMode] = useState<PlayMode>(audioAvailable ? 'together' : 'strokes')

  // Parse strokes (tolerant)
  const parsed = useMemo(
    () => parseStrokes(strokesJson ?? strokesPayload),
    [strokesJson, strokesPayload]
  )

  // Build drawable segments + timing metadata
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

  // Initialize / update duration
  useEffect(() => {
    if (playMode === 'together' && audioAvailable) {
      const a = audioRef.current
      if (!a) return
      const onLoaded = () => {
        const baseDur = Math.max(0, (a.duration || 0) * 1000)
        setDurationMs(baseDur) // slider range = audio length
      }
      const onEnded  = () => setIsPlaying(false)
      a.addEventListener('loadedmetadata', onLoaded)
      a.addEventListener('ended', onEnded)
      if (a.duration && !Number.isNaN(a.duration)) setDurationMs(a.duration * 1000)
      return () => {
        a.removeEventListener('loadedmetadata', onLoaded)
        a.removeEventListener('ended', onEnded)
      }
    } else {
      // Strokes-only duration:
      // - if we have real timestamps, use actual capture span
      // - else fall back to old length-based heuristic
      if (built.hasTimestamps) {
        setDurationMs(Math.max(0, built.timeEnd - built.timeStart))
      } else {
        setDurationMs(built.durationLenHeuristic)
      }
      setNowMs(0)
    }
  }, [audioAvailable, playMode, built.hasTimestamps, built.timeEnd, built.timeStart, built.durationLenHeuristic])

  // Unified animation loop
  useEffect(() => {
    // stop any existing loop first
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (!isPlaying) return

    // strokes-only loop uses a timebase we control
    let start = performance.now() - nowMs
    const tick = (t:number) => {
      let visualMs = 0
      if (playMode === 'together' && audioAvailable) {
        const a = audioRef.current
        const audioTimeMs = Math.max(0, (a?.currentTime || 0) * 1000)
        const off = parsed.timing?.audioOffsetMs ?? 0
        // visual time = audio clock + offset
        visualMs = Math.max(0, audioTimeMs + off)
      } else {
        const elapsed = t - start
        visualMs = Math.max(0, elapsed)
      }

      const clamped = Math.min(durationMs, visualMs)
      setNowMs(clamped)
      drawUpTo(clamped)

      if (clamped >= durationMs - 0.5) {
        setIsPlaying(false)
        rafRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    // If switching from pause to play in strokes-only, reset base clock
    if (!(playMode === 'together' && audioAvailable)) {
      start = performance.now() - nowMs
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }, [isPlaying, playMode, audioAvailable, durationMs, parsed.timing?.audioOffsetMs, nowMs])

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

  /* ---------- drawing ---------- */

  function drawUpTo(tMs:number) {
    if (!pdfReady) return
    const cnv = overlayRef.current
    if (!cnv) return
    const ctx = cnv.getContext('2d')
    if (!ctx) return

    clearOverlay()

    const { w: dw, h: dh } = pdfCssRef.current
    const { sw, sh } = inferSourceDims(parsed, dw, dh)

    if (built.hasTimestamps) {
      // TIME-BASED playback (accurate): draw full segments with t1 <= cutoff,
      // and partial for the first segment where t0 < cutoff < t1.
      const cutoff = Math.max(0, tMs + built.timeStart) // built.timeStart is usually 0, but tolerate non-zero
      withScale(ctx, sw, sh, dw, dh, () => {
        for (const seg of built.segs) {
          const segT0 = seg.t0 ?? 0
          const segT1 = seg.t1 ?? segT0
          if (cutoff >= segT1) {
            strokeSegment(ctx, seg, 1)
          } else if (cutoff <= segT0) {
            break
          } else {
            const portion = (cutoff - segT0) / Math.max(1, segT1 - segT0)
            strokeSegment(ctx, seg, Math.max(0, Math.min(1, portion)))
            break
          }
        }
      })
    } else {
      // LENGTH-BASED fallback (legacy): keep your original pacing
      const totalTime = Math.max(1, built.durationLenHeuristic)
      const ratio = Math.max(0, Math.min(1, tMs / totalTime))
      const cutoffLen = built.totalLen * ratio

      let acc = 0
      withScale(ctx, sw, sh, dw, dh, () => {
        for (const seg of built.segs) {
          if (acc + seg.len <= cutoffLen) {
            strokeSegment(ctx, seg, 1)
            acc += seg.len
          } else {
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

  /* ---------- controls ---------- */

  const togglePlay = async () => {
    if (playMode === 'together' && audioAvailable) {
      const a = audioRef.current
      if (!a) return
      if (isPlaying) {
        a.pause()
        setIsPlaying(false)
      } else {
        if (a.currentTime * 1000 >= durationMs - 10) a.currentTime = 0
        try { await a.play(); setIsPlaying(true) } catch {/* autoplay blocked? */}
      }
    } else {
      if (isPlaying) {
        setIsPlaying(false)
      } else {
        if (nowMs >= durationMs - 1) setNowMs(0)
        setIsPlaying(true)
      }
    }
  }

  const onScrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value)
    const t = Math.max(0, Math.min(durationMs, v))
    if (playMode === 'together' && audioAvailable) {
      const a = audioRef.current
      if (a) {
        const off = parsed.timing?.audioOffsetMs ?? 0
        // Convert desired visual time (t) back to audio time (audio = visual - offset)
        const audioT = Math.max(0, (t - off) / 1000)
        a.currentTime = audioT
        // draw immediately at the new position for visual snap
        const visualT = Math.max(0, Math.min(durationMs, (a.currentTime * 1000) + off))
        drawUpTo(visualT)
        setNowMs(visualT)
      }
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

  /* ---------- UI ---------- */

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
          width:'min(1100px, 94vw)',
          maxHeight:'88vh',
          background:'#fff',
          borderRadius:14,
          boxShadow:'0 18px 40px rgba(0,0,0,0.35)',
          display:'flex',
          flexDirection:'column',
          overflow:'hidden',
          position:'relative'
        }}
      >
        {/* Header */}
        <div style={{ padding:'10px 14px', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontWeight:800 }}>{title}{student ? ` — ${student}` : ''}</div>
          <button
            onClick={onClose}
            style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#f3f4f6' }}
          >
            Close
          </button>
        </div>

        {/* Floating top controls */}
        <div
          style={{
            position:'absolute',
            left:'50%', top:12, transform:'translateX(-50%)',
            zIndex: 2,
            display:'flex', alignItems:'center', gap:10,
            padding:'8px 12px',
            background:'rgba(255,255,255,0.95)',
            border:'1px solid #e5e7eb',
            borderRadius:999,
            boxShadow:'0 6px 18px rgba(0,0,0,0.15)',
            backdropFilter:'saturate(1.0) blur(4px)'
          }}
        >
          {/* Play/Pause */}
          <button
            onClick={togglePlay}
            style={{ padding:'8px 12px', borderRadius:999, border:'1px solid #ddd', background:'#fff', minWidth:88, fontWeight:700 }}
          >
            {isPlaying ? 'Pause' : 'Play'}
          </button>

          {/* Mode toggle */}
          <div
            style={{
              display:'inline-flex', border:'1px solid #ddd', borderRadius:999, overflow:'hidden'
            }}
            title={audioAvailable ? 'Choose what to play' : 'Audio not available'}
          >
            <button
              onClick={()=> setPlayMode('strokes')}
              disabled={playMode==='strokes'}
              style={{
                padding:'6px 10px',
                background: playMode==='strokes' ? '#111' : '#fff',
                color: playMode==='strokes' ? '#fff' : '#111',
                border:'none', fontWeight:700
              }}
            >
              Strokes
            </button>
            <button
              onClick={()=> setPlayMode('together')}
              disabled={!audioAvailable || playMode==='together'}
              style={{
                padding:'6px 10px',
                background: playMode==='together' ? '#111' : '#fff',
                color: playMode==='together' ? '#fff' : '#111',
                borderLeft:'1px solid #ddd', fontWeight:700, opacity: audioAvailable ? 1 : 0.5
              }}
            >
              Together
            </button>
          </div>

          {/* Time + Scrubber */}
          <div style={{ fontVariantNumeric:'tabular-nums', minWidth:60, textAlign:'right' }}>{fmt(nowMs)}</div>
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.floor(durationMs))}
            value={Math.min(Math.floor(nowMs), Math.floor(durationMs))}
            onChange={onScrub}
            style={{ width:300 }}
          />
          <div style={{ fontVariantNumeric:'tabular-nums', minWidth:60 }}>{fmt(durationMs)}</div>
        </div>

        {/* Body */}
        <div style={{ padding:'52px 12px 12px', overflow:'auto' }}>
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

          {/* Hidden audio element when present */}
          {audioAvailable && (
            <audio
              ref={audioRef}
              src={audioUrl || undefined}
              preload="auto"
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

  // timing (optional)
  if (obj.timing && typeof obj.timing === 'object') {
    out.timing = {}
    if (Number.isFinite(obj.timing.capturePerf0Ms)) out.timing.capturePerf0Ms = obj.timing.capturePerf0Ms
    if (Number.isFinite(obj.timing.audioOffsetMs))  out.timing.audioOffsetMs  = obj.timing.audioOffsetMs
  }
  return out
}

function sanitizeStroke(s:any): Stroke | null {
  if (!s || typeof s !== 'object') return null
  const color = typeof s.color === 'string' ? s.color : '#000'
  const size  = Number.isFinite(s.size) ? s.size : 4
  const tool  = s.tool === 'highlighter' ? 'highlighter' : 'pen'
  const ptsIn = Array.isArray(s.pts) ? s.pts : []
  const pts: Pt[] = ptsIn
    .filter((p:any)=> p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p:any)=> ({ x:p.x, y:p.y, t: Number.isFinite(p.t) ? p.t : undefined })) // preserve t when present
  if (pts.length === 0) return null
  return { color, size, tool, pts }
}

function num(v:any): number | undefined { return Number.isFinite(v) ? (v as number) : undefined }

function inferSourceDims(payload: StrokesPayload, fallbackW:number, fallbackH:number) {
  const mw = num(payload.canvasWidth)
  const mh = num(payload.canvasHeight)
  if (mw && mh && mw > 0 && mh > 0) return { sw: mw, sh: mh }
  return { sw: fallbackW, sh: fallbackH }
}

// Build segments. If any point has timestamps, produce time-based segments; otherwise, length-based fallback.
function buildSegments(payload: StrokesPayload): Built {
  const segs: Seg[] = []
  let totalLen = 0
  let hasTimestamps = payload.strokes.some(s => s.pts.some(p => Number.isFinite(p.t)))
  let globalT0 = Number.POSITIVE_INFINITY
  let globalT1 = 0

  if (hasTimestamps) {
    for (const s of payload.strokes) {
      if (!s.pts || s.pts.length < 2) continue
      for (let i = 1; i < s.pts.length; i++) {
        const p0 = s.pts[i-1], p1 = s.pts[i]
        const dx = p1.x - p0.x, dy = p1.y - p0.y
        const len = Math.hypot(dx, dy)
        const t0 = Math.max(0, num(p0.t) ?? 0)
        const t1 = Math.max(t0, num(p1.t) ?? t0)
        segs.push({ x0:p0.x, y0:p0.y, x1:p1.x, y1:p1.y, color:s.color, size:s.size, tool:s.tool, len, t0, t1 })
        totalLen += len
        if (t0 < globalT0) globalT0 = t0
        if (t1 > globalT1) globalT1 = t1
      }
    }
    if (!isFinite(globalT0)) { globalT0 = 0; globalT1 = 0 }
  } else {
    const pxPerMs = 0.8
    let runningT = 0
    for (const s of payload.strokes) {
      if (!s.pts || s.pts.length < 2) continue
      for (let i = 1; i < s.pts.length; i++) {
        const p0 = s.pts[i-1], p1 = s.pts[i]
        const dx = p1.x - p0.x, dy = p1.y - p0.y
        const len = Math.hypot(dx, dy)
        const dur = len / pxPerMs
        const t0 = runningT
        const t1 = runningT + dur
        segs.push({ x0:p0.x, y0:p0.y, x1:p1.x, y1:p1.y, color:s.color, size:s.size, tool:s.tool, len, t0, t1 })
        totalLen += len
        runningT = t1
      }
    }
    hasTimestamps = false
    globalT0 = 0
    globalT1 = segs.length ? segs[segs.length - 1].t1! : 0
  }

  const pxPerMs = 0.8
  const durationLenHeuristic = totalLen > 0 ? Math.max(800, Math.round(totalLen / pxPerMs)) : 0

  return { segs, totalLen, durationLenHeuristic, hasTimestamps, timeStart: globalT0, timeEnd: globalT1 }
}
