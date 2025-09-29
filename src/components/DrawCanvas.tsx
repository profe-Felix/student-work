import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number; t?: number }
export type Stroke = { color: string; size: number; tool: 'pen'|'highlighter'; pts: StrokePoint[] }
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
  /** Rebase timing so future audio aligns to this new "now" (ts = perf timestamp from AudioRecorder) */
  markTimingZero: (ts?: number) => void
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
  const tool  = (v as any).tool === 'pen' || (v as any).tool === 'highlighter'
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
      const tool  = (s as any).tool === 'highlighter' ? 'highlighter' : 'pen'
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
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.35 : 1
  ctx.strokeStyle = s.color
  ctx.beginPath()
  for (let i = 0; i < s.pts.length; i++) {
    const p = s.pts[i]
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  }
  ctx.stroke()
  ctx.restore()
}

export default forwardRef(function DrawCanvas(
  {
    width, height,
    color, size,
    mode, // 'scroll' | 'draw'
    tool, // 'pen'|'highlighter'|'eraser'|'eraserObject'  (erasers not implemented here)
  }:{
    width:number; height:number
    color:string; size:number
    mode:'scroll'|'draw'
    tool:'pen'|'highlighter'|'eraser'|'eraserObject'
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
      const newZero = typeof ts === 'number' ? ts : performance.now()
      const oldZero = capturePerf0Ms.current
      if (oldZero == null) { capturePerf0Ms.current = newZero; return }
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

    const onPointerDown = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)
      if (!shouldDraw(e)) return

      drawingPointerId.current = e.pointerId
      c.setPointerCapture(e.pointerId)

      if (capturePerf0Ms.current == null) capturePerf0Ms.current = performance.now()

      const now = performance.now()
      const p = getPos(e)
      const t = Math.max(0, Math.round(now - (capturePerf0Ms.current ?? now)))
      current.current = {
        color,
        size,
        tool: tool === 'highlighter' ? 'highlighter' : 'pen',
        pts: [{ x: p.x, y: p.y, t }]
      }
      redraw()
      e.preventDefault?.()
    }

    const onPointerMove = (e: PointerEvent)=>{
      if (drawingPointerId.current !== e.pointerId) return
      if (!current.current) return
      if (!shouldDraw(e)) {
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        current.current = null
        drawingPointerId.current = null
        redraw()
        return
      }
      const now = performance.now()
      const p = getPos(e)
      const t = Math.max(0, Math.round(now - (capturePerf0Ms.current ?? now)))
      current.current.pts.push({ x: p.x, y: p.y, t })
      redraw()
      e.preventDefault?.()
    }

    const endStroke = ()=>{
      if (current.current) {
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        current.current = null
        redraw()
      }
      drawingPointerId.current = null
    }

    const onPointerUp = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      try { c.releasePointerCapture(e.pointerId) } catch {}
    }
    const onPointerCancel = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
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
    }
  }, [mode, color, size, tool])

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
