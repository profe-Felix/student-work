import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number; t?: number }
export type ToolKind = 'pen' | 'highlighter' | 'eraser' | 'eraserObject'
export type Stroke = { color: string; size: number; tool: Exclude<ToolKind, 'eraserObject'>; pts: StrokePoint[] }
export type StrokesPayload = {
  strokes: Stroke[]
  canvasWidth?: number
  canvasHeight?: number
  timing?: {
    capturePerf0Ms?: number  // perf time (ms) when first stroke on this page started
  }
}

export type DrawCanvasHandle = {
  getStrokes: () => StrokesPayload
  loadStrokes: (data: StrokesPayload | null | undefined) => void
  clearStrokes: () => void
  undo: () => void
  /** Rebase timing so future audio aligns to this exact perf timestamp (ms) */
  markTimingZero: (ts?: number) => void
}

/* ---------- Tool normalization (defensive) ---------- */
function normalizeTool(t: string | undefined): ToolKind {
  if (!t) return 'pen'
  if (t === 'erase' || t === 'eraser-pixel') return 'eraser'
  if (t === 'eraseObject' || t === 'objectEraser') return 'eraserObject'
  return (t as ToolKind)
}

/* ---------- Type guards ---------- */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isPoint(v: unknown): v is StrokePoint {
  return isRecord(v)
    && Number.isFinite((v as any).x)
    && Number.isFinite((v as any).y)
    && ((v as any).t == null || Number.isFinite((v as any).t))
}
function isStroke(v: unknown): v is Stroke {
  if (!isRecord(v)) return false
  const color = typeof v.color === 'string'
  const size  = Number.isFinite((v as any).size)
  const tool  =
    (v as any).tool === 'pen' ||
    (v as any).tool === 'highlighter' ||
    (v as any).tool === 'eraser'
  const pts   = Array.isArray((v as any).pts) && (v as any).pts.every(isPoint)
  return color && size && tool && pts
}
function normalize(input: StrokesPayload | null | undefined): StrokesPayload {
  if (!isRecord(input) || !Array.isArray((input as any).strokes)) {
    return { strokes: [] }
  }
  const raw = (input as any).strokes as unknown[]

  const mapped: Array<Stroke | null> = raw.map((s) => {
    if (isStroke(s)) return s
    if (isRecord(s)) {
      const color = typeof s.color === 'string' ? (s.color as string) : '#000000'
      const size  = Number.isFinite((s as any).size) ? (s as any).size as number : 4
      const toolRaw = (s as any).tool
      const tool: Stroke['tool'] =
        toolRaw === 'highlighter' ? 'highlighter'
        : toolRaw === 'eraser' ? 'eraser'
        : 'pen'
      const pts   = Array.isArray((s as any).pts) ? (s as any).pts.filter(isPoint) : []
      return { color, size, tool, pts }
    }
    return null
  })

  const safe: Stroke[] = mapped.filter((s: Stroke | null): s is Stroke => s !== null)

  const out: StrokesPayload = { strokes: safe }
  if (Number.isFinite((input as any).canvasWidth))  out.canvasWidth  = (input as any).canvasWidth as number
  if (Number.isFinite((input as any).canvasHeight)) out.canvasHeight = (input as any).canvasHeight as number
  if (isRecord((input as any).timing)) {
    const t = (input as any).timing as any
    out.timing = {}
    if (Number.isFinite(t.capturePerf0Ms)) out.timing.capturePerf0Ms = t.capturePerf0Ms
  }
  return out
}

/* ---------- Render helpers ---------- */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (!s.pts || s.pts.length === 0) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s.size

  if (s.tool === 'eraser') {
    // Pixel eraser: punch holes
    ctx.globalCompositeOperation = 'destination-out'
    ctx.globalAlpha = 1
    ctx.strokeStyle = '#000' // color ignored in destination-out
  } else if (s.tool === 'highlighter') {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = s.color
  } else {
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    ctx.strokeStyle = s.color
  }

  ctx.beginPath()
  for (let i = 0; i < s.pts.length; i++) {
    const p = s.pts[i]
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  ctx.restore()
}

/* ---------- Geometry for object-eraser hit test ---------- */
function dist2(a: {x:number;y:number}, b: {x:number;y:number}) {
  const dx = a.x - b.x, dy = a.y - b.y
  return dx*dx + dy*dy
}
function distToSegmentSq(p:{x:number;y:number}, v:{x:number;y:number}, w:{x:number;y:number}) {
  // Return minimum distance^2 from point p to segment vw
  const l2 = dist2(v, w)
  if (l2 === 0) return dist2(p, v)
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2
  t = Math.max(0, Math.min(1, t))
  const proj = { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) }
  return dist2(p, proj)
}
function strokeIntersectsSegment(stroke: Stroke, a:{x:number;y:number}, b:{x:number;y:number}, radius:number) {
  const thr = Math.max(stroke.size ?? 10, radius)
  const thr2 = thr * thr
  const pts = stroke.pts
  if (!pts || pts.length === 0) return false
  if (pts.length === 1) {
    // closest distance from segment AB to single point
    return distToSegmentSq(pts[0], a, b) <= thr2
  }
  for (let i = 1; i < pts.length; i++) {
    // If segment AB is within 'thr' of any stroke segment, we consider it intersecting
    const v = pts[i-1], w = pts[i]
    // Check min distance between two segments by sampling (cheap but effective)
    // First, quick checks to avoid doing extra math:
    // (1) endpoint near test
    if (distToSegmentSq(v, a, b) <= thr2 || distToSegmentSq(w, a, b) <= thr2) return true
    // (2) drag endpoints near stroke segment
    if (distToSegmentSq(a, v, w) <= thr2 || distToSegmentSq(b, v, w) <= thr2) return true
  }
  return false
}

export default forwardRef(function DrawCanvas(
  {
    width, height,
    color, size,
    mode, // 'scroll' | 'draw'
    tool, // 'pen'|'highlighter'|'eraser'|'eraserObject'
    // LIVE STROKE ADD-ONLY (optional)
    onLiveStart,
    onLiveMove,
    onLiveEnd,
  }:{
    width:number; height:number
    color:string; size:number
    mode:'scroll'|'draw'
    tool:ToolKind
    onLiveStart?: (meta: { color:string; size:number; tool:Stroke['tool']; first: StrokePoint }) => void
    onLiveMove?: (p: StrokePoint) => void
    onLiveEnd?: () => void
  },
  ref
){
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef    = useRef<CanvasRenderingContext2D|null>(null)
  const strokes   = useRef<Stroke[]>([])
  const current   = useRef<Stroke|null>(null)

  // timing reference (first time we actually begin drawing on this page)
  const capturePerf0Ms = useRef<number | null>(null)

  // pointers
  const activePointers = useRef<Set<number>>(new Set())
  const drawingPointerId = useRef<number|null>(null)

  // object-eraser drag state
  const eraserObjectPointerId = useRef<number|null>(null)
  const lastErasePos = useRef<{x:number;y:number} | null>(null)

  const redraw = ()=>{
    const ctx = ctxRef.current
    if (!ctx) return
    ctx.clearRect(0,0, ctx.canvas.width, ctx.canvas.height)
    for (const s of strokes.current) drawStroke(ctx, s)
    if (current.current) drawStroke(ctx, current.current)
  }

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return
    c.width = width; c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctxRef.current = ctx
    redraw()
  }, [width, height])

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'pan-y pinch-zoom'
    }
  }, [mode])

  useImperativeHandle(ref, () => ({
    getStrokes: (): StrokesPayload => ({
      strokes: strokes.current,
      canvasWidth: canvasRef.current?.width,
      canvasHeight: canvasRef.current?.height,
      timing: capturePerf0Ms.current != null ? { capturePerf0Ms: capturePerf0Ms.current } : undefined,
    }),
    loadStrokes: (data: StrokesPayload | null | undefined): void => {
      const safe = normalize(data)
      strokes.current = safe.strokes
      current.current = null
      if (safe.timing?.capturePerf0Ms != null) capturePerf0Ms.current = safe.timing.capturePerf0Ms
      redraw()
    },
    clearStrokes: (): void => {
      strokes.current = []
      current.current = null
      capturePerf0Ms.current = null
      redraw()
    },
    undo: (): void => {
      strokes.current.pop()
      redraw()
    },
    /** Rebase all timestamps so a new audio recording can align to "now" */
    markTimingZero: (ts?: number): void => {
      const oldZero = capturePerf0Ms.current
      const newZero = typeof ts === 'number' ? ts : performance.now()

      // First time setting timing? just set and return
      if (oldZero == null) {
        capturePerf0Ms.current = newZero
        redraw()
        return
      }

      // Shift all existing points to preserve absolute time:
      // oldAbs = oldZero + tOld  ⇒  keep oldAbs = newZero + tNew
      // tNew = tOld + (oldZero - newZero)
      const delta = oldZero - newZero
      if (delta !== 0) {
        for (const s of strokes.current) {
          for (const p of s.pts) {
            const tOld = typeof p.t === 'number' ? p.t : 0
            const tNew = tOld + delta
            p.t = Math.max(0, Math.round(tNew))
          }
        }
      }
      capturePerf0Ms.current = newZero
      redraw()
    }
  }))

  const getPos = (e: PointerEvent)=>{
    const c = canvasRef.current!
    const r = c.getBoundingClientRect()
    // Canvas has CSS width/height set to 100%; element and bitmap sizes are kept in sync above.
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  useEffect(()=>{
    const c = canvasRef.current
    if (!c) return

    const shouldDraw = (e: PointerEvent) => {
      if (mode !== 'draw') return false
      if (e.pointerType === 'pen') return true
      return activePointers.current.size <= 1
    }

    const eraseAtSegment = (a:{x:number;y:number}, b:{x:number;y:number})=>{
      // Use size as the eraser radius, with a floor
      const radius = Math.max(10, size)
      let removed = false
      // Remove from top-most down: iterate backwards for stable splices
      for (let i = strokes.current.length - 1; i >= 0; i--) {
        const s = strokes.current[i]
        if (strokeIntersectsSegment(s, a, b, radius)) {
          strokes.current.splice(i, 1)
          removed = true
        }
      }
      if (removed) redraw()
    }

    const onPointerDown = (e: PointerEvent)=>{
      const toolNow = normalizeTool(tool)

      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)
      if (!shouldDraw(e)) return

      // Drag-object-eraser: begin a drag pass that deletes any intersected strokes
      if (toolNow === 'eraserObject') {
        const p = getPos(e)
        eraserObjectPointerId.current = e.pointerId
        lastErasePos.current = p
        // delete any stroke under the initial point
        eraseAtSegment(p, p)
        c.setPointerCapture(e.pointerId)
        e.preventDefault?.()
        return
      }

      // Pixel / pen / highlighter drawing
      drawingPointerId.current = e.pointerId
      c.setPointerCapture(e.pointerId)

      if (capturePerf0Ms.current == null) capturePerf0Ms.current = performance.now()

      const now = performance.now()
      const p = getPos(e)
      const t = Math.max(0, Math.round(now - (capturePerf0Ms.current ?? now)))
      current.current = {
        color,
        size,
        tool: toolNow === 'highlighter' ? 'highlighter' : (toolNow === 'eraser' ? 'eraser' : 'pen'),
        pts: [{ x: p.x, y: p.y, t }]
      }
      if (onLiveStart) onLiveStart({ color: current.current.color, size: current.current.size, tool: current.current.tool, first: current.current.pts[0] })
      redraw()
      e.preventDefault?.()
    }

    const onPointerMove = (e: PointerEvent)=>{
      // Handle drag-object-eraser first
      if (eraserObjectPointerId.current === e.pointerId) {
        const p = getPos(e)
        const prev = lastErasePos.current || p
        eraseAtSegment(prev, p)
        lastErasePos.current = p
        e.preventDefault?.()
        return
      }

      // Then normal drawing
      if (drawingPointerId.current !== e.pointerId) return
      if (!current.current) return

      // If a multi-touch gesture starts mid-stroke, end the stroke
      if (!shouldDraw(e)) {
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        if (onLiveEnd) onLiveEnd()
        current.current = null
        drawingPointerId.current = null
        redraw()
        return
      }

      const now = performance.now()
      const p = getPos(e)
      const t = Math.max(0, Math.round(now - (capturePerf0Ms.current ?? now)))
      const pt = { x: p.x, y: p.y, t }
      current.current.pts.push(pt)
      if (onLiveMove) onLiveMove(pt)
      redraw()
      e.preventDefault?.()
    }

    const endStroke = ()=>{
      if (current.current) {
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        if (onLiveEnd) onLiveEnd()
        current.current = null
        redraw()
      }
      drawingPointerId.current = null
    }

    const endObjectErase = (pid:number)=>{
      if (eraserObjectPointerId.current === pid) {
        eraserObjectPointerId.current = null
        lastErasePos.current = null
      }
    }

    const onPointerUp = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      endObjectErase(e.pointerId)
      try { c.releasePointerCapture(e.pointerId) } catch {}
    }
    const onPointerCancel = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      endObjectErase(e.pointerId)
      try { c.releasePointerCapture(e.pointerId) } catch {}
    }

    c.addEventListener('pointerdown', onPointerDown as unknown as EventListener, { passive:false })
    c.addEventListener('pointermove', onPointerMove as unknown as EventListener, { passive:false })
    c.addEventListener('pointerup', onPointerUp as unknown as EventListener, { passive:true })
    c.addEventListener('pointercancel', onPointerCancel as unknown as EventListener, { passive:true })
    return ()=>{
      c.removeEventListener('pointerdown', onPointerDown as unknown as EventListener)
      c.removeEventListener('pointermove', onPointerMove as unknown as EventListener)
      c.removeEventListener('pointerup', onPointerUp as unknown as EventListener)
      c.removeEventListener('pointercancel', onPointerCancel as unknown as EventListener)
      activePointers.current.clear()
      drawingPointerId.current = null
      eraserObjectPointerId.current = null
      lastErasePos.current = null
    }
  }, [mode, color, size, tool, onLiveStart, onLiveMove, onLiveEnd])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width:'100%', height:'100%',
        touchAction:'pan-y pinch-zoom', background:'transparent'
      }}
    />
  )
})
