import { forwardRef, useImperativeHandle, useRef, useEffect } from 'react'

export type StrokePoint = { x: number; y: number }
export type Stroke = { color: string; size: number; tool: 'pen'|'highlighter'; pts: StrokePoint[] }
export type StrokesPayload = { strokes: Stroke[] }

export type DrawCanvasHandle = {
  getStrokes: () => StrokesPayload
  loadStrokes: (data: StrokesPayload | null | undefined) => void
  clearStrokes: () => void
  undo: () => void
}

function normalize(data: any): StrokesPayload {
  if (!data || typeof data !== 'object') return { strokes: [] }
  const arr = Array.isArray(data.strokes) ? data.strokes : []
  // Shallow-validate each stroke
  const safe = arr.map((s: any) => ({
    color: typeof s?.color === 'string' ? s.color : '#000000',
    size:  Number.isFinite(s?.size) ? s.size : 4,
    tool:  s?.tool === 'highlighter' ? 'highlighter' : 'pen',
    pts:   Array.isArray(s?.pts)
            ? s.pts.filter((p: any) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
            : []
  }))
  return { strokes: safe }
}

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

  // Pointer state for two-finger detection & pencil
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
    const c = canvasRef.current!
    c.width = width; c.height = height
    const ctx = c.getContext('2d')!
    ctxRef.current = ctx
    redraw()
  }, [width, height])

  useEffect(()=>{
    const c = canvasRef.current!
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction = 'auto'
    } else {
      c.style.pointerEvents = 'auto'
      c.style.touchAction = 'pan-y pinch-zoom'
    }
  }, [mode])

  useImperativeHandle(ref, ()=>({
    getStrokes: ()=> ({ strokes: strokes.current }),
    loadStrokes: (data)=>{
      const safe = normalize(data)
      strokes.current = safe.strokes
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
    const shouldDraw = (e: PointerEvent) => {
      if (mode !== 'draw') return false
      if (e.pointerType === 'pen') return true // always let Apple Pencil draw
      // fingers/mouse: draw only if a single non-pen pointer is down
      return activePointers.current.size <= 1
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (e.pointerType !== 'pen') activePointers.current.add(e.pointerId)
      if (!shouldDraw(e)) return
      drawingPointerId.current = e.pointerId
      c.setPointerCapture(e.pointerId)
      const p = getPos(e)
      current.current = { color, size, tool: tool === 'highlighter' ? 'highlighter' : 'pen', pts: [p] }
      redraw()
      e.preventDefault?.()
    }
    const onPointerMove = (e: PointerEvent)=>{
      if (drawingPointerId.current !== e.pointerId) return
      if (!current.current) return
      if (!shouldDraw(e)) {
        // gesture changed mid-stroke → commit what we have and stop
        if (current.current.pts.length > 1) strokes.current.push(current.current)
        current.current = null
        drawingPointerId.current = null
        redraw()
        return
      }
      const p = getPos(e)
      current.current.pts.push(p)
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

    c.addEventListener('pointerdown', onPointerDown as any, { passive:false })
    c.addEventListener('pointermove', onPointerMove as any, { passive:false })
    c.addEventListener('pointerup', onPointerUp as any, { passive:true })
    c.addEventListener('pointercancel', onPointerCancel as any, { passive:true })
    return ()=>{
      c.removeEventListener('pointerdown', onPointerDown as any)
      c.removeEventListener('pointermove', onPointerMove as any)
      c.removeEventListener('pointerup', onPointerUp as any)
      c.removeEventListener('pointercancel', onPointerCancel as any)
      activePointers.current.clear()
      drawingPointerId.current = null
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
