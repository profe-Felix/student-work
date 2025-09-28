import { useEffect, useMemo, useRef, useState } from 'react'
import PdfCanvas from './PdfCanvas'

type Pt = { x:number; y:number }
type Stroke = { color:string; size:number; tool:'pen'|'highlighter'; pts:Pt[] }
type StrokesPayload = {
  strokes: Stroke[]
  // new-ish meta we now save on student side
  canvasWidth?: number
  canvasHeight?: number
  // tolerate older/alt names
  canvas_w?: number
  canvas_h?: number
  w?: number
  h?: number
  width?: number
  height?: number
}

type Seg = { t0:number; t1:number; x0:number; y0:number; x1:number; y1:number; color:string; size:number; tool:'pen'|'highlighter' }
type Built = { segs: Seg[]; duration: number }

export default function PlaybackDrawer({
  pdfUrl,
  pageIndex,
  strokesJson,     // raw JSON from DB
  audioUrl,        // (optional) synced audio, not used in this fix
  title = 'Preview'
}:{
  pdfUrl: string
  pageIndex: number
  strokesJson: unknown
  audioUrl?: string | null
  title?: string
}) {
  const overlayRef = useRef<HTMLCanvasElement|null>(null)
  const pdfCssRef  = useRef<{ w:number; h:number }>({ w: 800, h: 600 })
  const [ready, setReady] = useState(false)

  // Parse strokes (be VERY tolerant)
  const parsed = useMemo(() => parseStrokes(strokesJson), [strokesJson])

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
      if (ready) drawAllStatic()
    })
    ro.observe(host)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  function onPdfReady(_pdf:any, canvas:HTMLCanvasElement) {
    try {
      const cssW = Math.round(parseFloat(getComputedStyle(canvas).width))
      const cssH = Math.round(parseFloat(getComputedStyle(canvas).height))
      pdfCssRef.current = { w: cssW, h: cssH }
      setupOverlayCanvas(cssW, cssH, overlayRef.current)
      setReady(true)
      drawAllStatic()
    } catch {
      setReady(true)
    }
  }

  // ===== Drawing =====

  function setupOverlayCanvas(cssW:number, cssH:number, cnv:HTMLCanvasElement|null) {
    if (!cnv) return
    const dpr = (window.devicePixelRatio || 1)
    cnv.width  = Math.max(1, Math.floor(cssW * dpr))
    cnv.height = Math.max(1, Math.floor(cssH * dpr))
    cnv.style.width  = cssW + 'px'
    cnv.style.height = cssH + 'px'
    const ctx = cnv.getContext('2d')
    if (!ctx) return
    // Reset and apply DPR
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function clearOverlay() {
    const cnv = overlayRef.current
    if (!cnv) return
    const ctx = cnv.getContext('2d')
    if (!ctx) return
    // clear in CSS pixels (since we set DPR via setTransform)
    ctx.save()
    ctx.setTransform(1,0,0,1,0,0)
    ctx.clearRect(0,0, cnv.width, cnv.height)
    ctx.restore()
    // re-apply DPR transform for subsequent drawing
    const dpr = (window.devicePixelRatio || 1)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // Map from source space (capture canvas size) -> current PDF CSS box
  function withScale<T>(ctx:CanvasRenderingContext2D, srcW:number, srcH:number, dstW:number, dstH:number, fn:()=>T):T {
    const sx = dstW / Math.max(1, srcW)
    const sy = dstH / Math.max(1, srcH)
    ctx.save()
    ctx.scale(sx, sy) // we draw in source coordinates; scale does the mapping
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
    ctx.lineWidth = s.size // NOTE: this will be scaled by ctx.scale(sx,sy) from withScale()
    ctx.beginPath()
    for (let i = 0; i < s.pts.length; i++) {
      const p = s.pts[i]
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
    ctx.restore()
  }

  function drawAllStatic() {
    const cnv = overlayRef.current
    if (!cnv) return
    const ctx = cnv.getContext('2d')
    if (!ctx) return
    clearOverlay()

    const { w: cssW, h: cssH } = pdfCssRef.current
    const { sw, sh } = inferSourceDimsFromMetaOrPdf(parsed, cssW, cssH)

    // draw each stroke in source coords, scaled to current PDF CSS box
    withScale(ctx, sw, sh, cssW, cssH, () => {
      for (const s of parsed.strokes) {
        drawStroke(ctx, s)
      }
    })
  }

  // (Optional) animated draw could use built segments; static fix is enough for alignment.
  // Keeping hook for future:
  // function drawUpTo(ms:number) { ... }

  return (
    <div style={{ position:'relative' }}>
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
      <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280' }}>{title}</div>
    </div>
  )
}

/* ================= helpers ================= */

function parseStrokes(raw: unknown): StrokesPayload {
  // Accept: object with strokes[], plus any of these meta fields for width/height
  const out: StrokesPayload = { strokes: [] }

  if (!raw || typeof raw !== 'object') return out
  const obj = raw as any

  // strokes
  const arr = Array.isArray(obj.strokes) ? obj.strokes : []
  out.strokes = arr
    .map((s:any) => sanitizeStroke(s))
    .filter(Boolean) as Stroke[]

  // meta (many aliases tolerated)
  const metaW =
    num(obj.canvasWidth) ??
    num(obj.canvas_w) ??
    num(obj.w) ??
    num(obj.width)
  const metaH =
    num(obj.canvasHeight) ??
    num(obj.canvas_h) ??
    num(obj.h) ??
    num(obj.height)

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

function inferSourceDimsFromMetaOrPdf(payload: StrokesPayload, fallbackW:number, fallbackH:number) {
  // Prefer capture-time meta if present
  const mw = num(payload.canvasWidth)
  const mh = num(payload.canvasHeight)
  if (mw && mh && mw > 0 && mh > 0) {
    return { sw: mw, sh: mh }
  }
  // Else, fall back to current PDF CSS size (old artifacts)
  return { sw: fallbackW, sh: fallbackH }
}
