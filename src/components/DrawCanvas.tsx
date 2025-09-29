
import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number; t?: number } // t added (optional for backward compat)
export type Stroke = { color: string; size: number; tool: 'pen'|'highlighter'; pts: StrokePoint[] }
export type StrokesPayload = {
  strokes: Stroke[]
  canvasWidth?: number
  canvasHeight?: number
  timing?: {
    // absolute capture base on performance.now() clock (used to compute audioOffsetMs at submit time)
    capturePerf0Ms?: number
    // optional offset saved with submission for perfect playback (computed in assignment submit)
    audioOffsetMs?: number
  }
}

export type DrawCanvasHandle = {
  getStrokes: () => StrokesPayload
  loadStrokes: (data: StrokesPayload | null | undefined) => void
  clearStrokes: () => void
  undo: () => void
}

/* ---------- Type guards ---------- */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
function isPoint(v: unknown): v is StrokePoint {
  return (
    isRecord(v) &&
    Number.isFinite((v as any).x) &&
    Number.isFinite((v as any).y) &&
    ((v as any).t === undefined || Number.isFinite((v as any).t))
  )
}
function isStroke(v: unknown): v is Stroke {
  if (!isRecord(v)) return false
  const color = typeof v.color === 'string'
  const size  = Number.isFinite(v.size as number)
  const tool  = v.tool === 'pen' || v.tool === 'highlighter'
  const pts   = Array.isArray(v.pts) && (v.pts as unknown[]).every(isPoint)
  return color && size && tool && pts
}
function normalize(input: StrokesPayload | null | undefined): StrokesPayload {
  if (!isRecord(input) || !Array.isArray((input as any).strokes)) {
    return { strokes: [] }
  }
  const raw = (input as any).strokes as unknown[]
  const safe: Stroke[] = raw
    .map((s) => {
      if (isStroke(s)) return s
      if (isRecord(s)) {
        const color = typeof s.color === 'string' ? (s.color as string) : '#000000'
        const size  = Number.isFinite(s.size as number) ? (s.size as number) : 4
        const tool  = s.tool === 'highlighter' ? 'highlighter' : 'pen'
        const pts   = Array.isArray(s.pts) ? (s.pts as unknown[]).filter(isPoint) : []
        return { color, size, tool, pts }
      }
      return null
    })
    .filter((x): x is Stroke => !!x)
  const out: StrokesPayload = { strokes: safe }
  if (Number.isFinite((input as any).canvasWidth))  out.canvasWidth  = (input as any).canvasWidth as number
  if (Number.isFinite((input as any).canvasHeight)) out.canvasHeight = (input as any).canvasHeight as number
  if (isRecord((input as any).timing)) {
    out.timing = {}
    if (Number.isFinite(((input as any).timing as any).capturePerf0Ms)) {
      out.timing.capturePerf0Ms = ((input as any).timing as any).capturePerf0Ms as number
    }
    if (Number.isFinite(((input as any).timing as any).audioOffsetMs)) {
      out.timing.audioOffsetMs = ((input as any).timing as any).audioOffsetMs as number
    }
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
    tool, // 'pen'|'highlighter'|'eraser'|'eraserObject'
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

  // Pointer state for two-finger detection & pencil
  const activePointers = useRef<Set<number>>(new Set())
  const drawingPointerId = useRef<number|null>(null)

  // Timing base for this capture session (performance.now() space)
  const capturePerf0Ms = useRef<number>(performance.now())

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
      canvasWidth:  ctxRef.current?.canvas.width,
      canvasHeight: ctxRef.current?.canvas.height,
      timing: { capturePerf0Ms: capturePerf0Ms.current }
    }),
    loadStrokes: (data: StrokesPayload | null | undefined): void => {
      const safe = normalize(data)
      strokes.current = safe.strokes
      current.current = null
      redraw()
    },
    clearStrokes: (): void => {
      strokes.current = []
      current.current = null
      // reset timing base for a new capture
      capturePerf0Ms.current = performance.now()
      redraw()
    },
    undo: (): void => {
      strokes.current.pop()
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
      if (e.pointerType === 'pen') return true // Apple Pencil even with palm
      return activePointers.current.size <= 1
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)
      if (!shouldDraw(e)) return
      drawingPointerId.current = e.pointerId
      c.setPointerCapture(e.pointerId)
      const p = getPos(e)
      const t = performance.now() - capturePerf0Ms.current
      current.current = { color, size, tool: tool === 'highlighter' ? 'highlighter' : 'pen', pts: [{ x:p.x, y:p.y, t }] }
      redraw()
      ;(e as any).preventDefault?.()
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
      const p = getPos(e)
      const t = performance.now() - capturePerf0Ms.current
      current.current.pts.push({ x:p.x, y:p.y, t })
      redraw()
      ;(e as any).preventDefault?.()
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

    c.addEventListener('pointerdown', onPointerDown as EventListener, { passive:false })
    c.addEventListener('pointermove', onPointerMove as EventListener, { passive:false })
    c.addEventListener('pointerup', onPointerUp as EventListener, { passive:true })
    c.addEventListener('pointercancel', onPointerCancel as EventListener, { passive:true })
    return ()=>{
      c.removeEventListener('pointerdown', onPointerDown as EventListener)
      c.removeEventListener('pointermove', onPointerMove as EventListener)
      c.removeEventListener('pointerup', onPointerUp as EventListener)
      c.removeEventListener('pointercancel', onPointerCancel as EventListener)
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
