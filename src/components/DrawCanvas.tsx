import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number }
export type Stroke = { color: string; size: number; tool: 'pen'|'highlighter'; pts: StrokePoint[] }
export type StrokesPayload = { strokes: Stroke[] }

export type DrawCanvasHandle = {
  getStrokes: () => StrokesPayload
  loadStrokes: (data: StrokesPayload) => void
  clearStrokes: () => void
  undo: () => void
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = s.size
  if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.35
  } else {
    ctx.globalAlpha = 1
  }
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
    tool, // 'pen'|'highlighter'|'eraser'|'eraserObject'  (erasers handled outside)
  }:{
    width:number; height:number
    color:string; size:number
    mode:'scroll'|'draw'
    tool:'pen'|'highlighter'|'eraser'|'eraserObject'
  },
  ref
){
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D|null>(null)
  const strokes = useRef<Stroke[]>([])
  const current = useRef<Stroke|null>(null)

  // Pointer state
  const activePointers = useRef<Set<number>>(new Set()) // track non-pen pointers for two-finger detection
  const drawingPointerId = useRef<number|null>(null)     // the pointer currently drawing
  const drawingIsPen = useRef<boolean>(false)

  const redraw = ()=>{
    const ctx = ctxRef.current!
    ctx.clearRect(0,0, ctx.canvas.width, ctx.canvas.height)
    for (const s of strokes.current) drawStroke(ctx, s)
    if (current.current) drawStroke(ctx, current.current)
  }

  useEffect(()=>{
    const c = canvasRef.current!
    c.width = width; c.height = height
    const ctx = c.getContext('2d')!
    ctxRef.current = ctx
    redraw()
  }, [width, height])

  useEffect(()=>{
    // Interaction policy:
    // - In scroll mode: let events pass through to parent (no drawing).
    // - In draw mode: capture single-finger / pen; allow two-finger to scroll by disabling drawing.
    const c = canvasRef.current!
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction = 'auto'
    } else {
      c.style.pointerEvents = 'auto'
      // allow pinch/scroll gestures; we’ll gate drawing ourselves
      c.style.touchAction = 'pan-y pinch-zoom'
    }
  }, [mode])

  useImperativeHandle(ref, ()=>({
    getStrokes: ()=> ({ strokes: strokes.current }),
    loadStrokes: (data: StrokesPayload)=>{
      strokes.current = Array.isArray(data?.strokes) ? data.strokes : []
      current.current = null
      redraw()
    },
    clearStrokes: ()=>{
      strokes.current = []
      current.current = null
      redraw()
    },
    undo: ()=>{
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
    const c = canvasRef.current!
    const ctx = ctxRef.current!
    if (!c || !ctx) return

    const shouldDrawWithThisPointer = (e: PointerEvent) => {
      if (mode !== 'draw') return false

      // If at least two non-pen pointers are on screen, we’re in scroll gesture → do not draw.
      const fingersDown = activePointers.current.size
      const isPen = e.pointerType === 'pen'

      // Allow Apple Pencil to draw even with palms down.
      if (isPen) return true

      // Non-pen (finger/mouse): only draw if single pointer and we're not currently panning.
      return fingersDown <= 1
    }

    const onPointerDown = (e: PointerEvent)=>{
      // Track non-pen pointers for “two-finger” detection
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)

      if (!shouldDrawWithThisPointer(e)) return

      drawingPointerId.current = e.pointerId
      drawingIsPen.current = e.pointerType === 'pen'
      c.setPointerCapture(e.pointerId)

      const p = getPos(e)
      current.current = { color, size, tool: tool === 'highlighter' ? 'highlighter' : 'pen', pts: [p] }
      redraw()

      // prevent a “long press” blue selection on iPad
      if ((e as any).preventDefault) e.preventDefault()
    }

    const onPointerMove = (e: PointerEvent)=>{
      // If we’re not the active drawing pointer, ignore.
      if (drawingPointerId.current !== e.pointerId) {
        // also update fingers count for scroll detection
        return
      }
      if (!current.current) return

      if (!shouldDrawWithThisPointer(e)) {
        // Gesture changed mid-draw (second finger went down) → end stroke
        strokes.current.push(current.current)
        current.current = null
        drawingPointerId.current = null
        redraw()
        return
      }

      const p = getPos(e)
      current.current.pts.push(p)
      redraw()
      if ((e as any).preventDefault) e.preventDefault()
    }

    const endStroke = ()=>{
      if (current.current) {
        // discard tiny tap with a single point
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        current.current = null
        redraw()
      }
      drawingPointerId.current = null
    }

    const onPointerUp = (e: PointerEvent)=>{
      // remove from active finger set if non-pen
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      try { c.releasePointerCapture(e.pointerId) } catch {}
    }

    const onPointerCancel = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.delete(e.pointerId)
      if (drawingPointerId.current === e.pointerId) endStroke()
      try { c.releasePointerCapture(e.pointerId) } catch {}
    }

    c.addEventListener('pointerdown', onPointerDown, { passive:false })
    c.addEventListener('pointermove', onPointerMove, { passive:false })
    c.addEventListener('pointerup', onPointerUp, { passive:true })
    c.addEventListener('pointercancel', onPointerCancel, { passive:true })

    return ()=>{
      c.removeEventListener('pointerdown', onPointerDown as any)
      c.removeEventListener('pointermove', onPointerMove as any)
      c.removeEventListener('pointerup', onPointerUp as any)
      c.removeEventListener('pointercancel', onPointerCancel as any)
      activePointers.current.clear()
      drawingPointerId.current = null
      drawingIsPen.current = false
    }
  }, [mode, color, size, tool])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ position:'absolute', inset:0, zIndex:10, display:'block', width:'100%', height:'100%', touchAction:'pan-y pinch-zoom', background:'transparent' }}
    />
  )
})
