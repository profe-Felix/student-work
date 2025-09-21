import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

type Tool = 'pen' | 'highlighter' | 'eraser' | 'eraserObject'

type Stroke = {
  tool: 'pen' | 'highlighter' | 'eraser'; // object eraser doesn't add a stroke
  color: string;
  size: number;
  points: { x:number; y:number }[];
}

export type DrawCanvasHandle = {
  undo: () => void;
}

function distPointToSeg(px:number, py:number, x1:number, y1:number, x2:number, y2:number){
  const vx = x2 - x1, vy = y2 - y1
  const wx = px - x1, wy = py - y1
  const c1 = vx*wx + vy*wy
  if (c1 <= 0) return Math.hypot(px - x1, py - y1)
  const c2 = vx*vx + vy*vy
  if (c2 <= c1) return Math.hypot(px - x2, py - y2)
  const b = c1 / c2
  const bx = x1 + b*vx, by = y1 + b*vy
  return Math.hypot(px - bx, py - by)
}

export default forwardRef<DrawCanvasHandle, {
  width: number
  height: number
  color: string
  size: number
  mode: 'scroll' | 'draw'
  tool: Tool
}> (function DrawCanvas({
  width, height, color, size, mode, tool
}, ref){

  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null)

  const drawing      = useRef(false)
  const usingPen     = useRef(false)        // Apple Pencil
  const activeId     = useRef<number | null>(null)

  const pendingId    = useRef<number | null>(null)
  const pendingPos   = useRef<{x:number,y:number} | null>(null)
  const pendingTO    = useRef<number | null>(null)
  const PENDING_MS   = 60
  const MOVE_THRESH  = 8

  // stroke model for undo / object eraser
  const strokesRef   = useRef<Stroke[]>([])
  const liveStroke   = useRef<Stroke | null>(null)

  const resizeBackingStore = ()=>{
    const c = canvasRef.current!
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    const needW = Math.floor(width  * dpr)
    const needH = Math.floor(height * dpr)
    if (c.width !== needW)  c.width  = needW
    if (c.height !== needH) c.height = needH
    c.style.width  = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctxRef.current = ctx
  }

  const clearCanvas = ()=>{
    const c = canvasRef.current!, k = ctxRef.current!
    k.save()
    k.setTransform(1,0,0,1,0,0) // clear in device pixels
    k.clearRect(0,0,c.width,c.height)
    // restore CSS pixel transform
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    k.setTransform(dpr,0,0,dpr,0,0)
    k.restore()
  }

  const applyStrokeStyle = (s: Stroke)=>{
    const k = ctxRef.current!
    k.lineCap = 'round'
    k.lineJoin = 'round'
    if (s.tool === 'eraser') {
      k.globalCompositeOperation = 'destination-out'
      k.globalAlpha = 1
      k.strokeStyle = '#000'
      k.lineWidth   = s.size * 2
    } else if (s.tool === 'highlighter') {
      k.globalCompositeOperation = 'source-over'
      k.globalAlpha = 0.35
      k.strokeStyle = s.color
      k.lineWidth   = s.size * 2
    } else { // pen
      k.globalCompositeOperation = 'source-over'
      k.globalAlpha = 1
      k.strokeStyle = s.color
      k.lineWidth   = s.size
    }
  }

  const drawStroke = (s: Stroke)=>{
    const k = ctxRef.current!
    if (!s.points.length) return
    applyStrokeStyle(s)
    k.beginPath()
    k.moveTo(s.points[0].x, s.points[0].y)
    for (let i=1;i<s.points.length;i++){
      const p = s.points[i]
      k.lineTo(p.x, p.y)
    }
    // ensure tap leaves a dot
    if (s.points.length === 1) {
      const p = s.points[0]
      k.lineTo(p.x + 0.001, p.y + 0.001)
    }
    k.stroke()
  }

  const redrawAll = ()=>{
    clearCanvas()
    for (const s of strokesRef.current) drawStroke(s)
  }

  useImperativeHandle(ref, ()=>({
    undo(){
      if (liveStroke.current) {
        liveStroke.current = null
      } else if (strokesRef.current.length){
        strokesRef.current.pop()
      }
      redrawAll()
    }
  }), [])

  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // Draw mode: single finger should never scroll; two-finger pan handled by parent panel.
    c.style.pointerEvents = 'auto'
    c.style.touchAction   = 'none'
  }

  useEffect(()=>{
    if (!drawing.current) {
      resizeBackingStore()
      applyPolicy()
      // redraw after DPR change / resize
      redrawAll()
    }
  }, [width, height, mode])

  useEffect(()=>{
    const c = canvasRef.current!
    resizeBackingStore()
    applyPolicy()

    const rect = () => c.getBoundingClientRect()
    const toLocal = (clientX:number, clientY:number)=>{
      const r = rect()
      return { x: clientX - r.left, y: clientY - r.top }
    }

    const clearPending = ()=>{
      if (pendingTO.current) { window.clearTimeout(pendingTO.current) }
      pendingTO.current = null
      pendingId.current = null
      pendingPos.current = null
    }
    const commitPending = ()=>{
      if (pendingId.current === null || !pendingPos.current) return
      drawing.current  = true
      activeId.current = pendingId.current
      // start a new live stroke
      liveStroke.current = {
        tool: (tool === 'eraser' ? 'eraser' : tool === 'highlighter' ? 'highlighter' : 'pen'),
        color, size, points: [pendingPos.current]
      }
      drawStroke(liveStroke.current)
      clearPending()
    }

    // OBJECT ERASER helper: remove nearest stroke to point
    const eraseByObjectAt = (pt:{x:number;y:number})=>{
      // search backwards (top-most first), ignore eraser strokes
      const arr = strokesRef.current
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = arr[i]
        if (s.tool === 'eraser') continue
        const pts = s.points
        if (pts.length === 1) {
          if (Math.hypot(pt.x - pts[0].x, pt.y - pts[0].y) <= Math.max(12, s.size*1.2)) {
            arr.splice(i,1); redrawAll(); return
          }
        } else {
          let hit = false
          const thresh = Math.max(12, s.tool==='highlighter' ? s.size*2 : s.size*1.2)
          for (let j=0;j<pts.length-1;j++){
            if (distPointToSeg(pt.x,pt.y, pts[j].x,pts[j].y, pts[j+1].x,pts[j+1].y) <= thresh){
              hit = true; break
            }
          }
          if (hit) { arr.splice(i,1); redrawAll(); return }
        }
      }
    }

    const onPointerDown = (e: PointerEvent)=>{
      if (mode !== 'draw') return

      usingPen.current = (e.pointerType === 'pen')
      const p = toLocal(e.clientX, e.clientY)

      // Object eraser: remove a stroke near the tap; no drawing capture
      if (tool === 'eraserObject') {
        eraseByObjectAt(p)
        e.preventDefault()
        return
      }

      if (usingPen.current || e.pointerType === 'mouse') {
        drawing.current  = true
        activeId.current = e.pointerId
        liveStroke.current = {
          tool: (tool === 'eraser' ? 'eraser' : tool === 'highlighter' ? 'highlighter' : 'pen'),
          color, size, points: [p]
        }
        drawStroke(liveStroke.current)
        c.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        return
      }

      // touch: small delay to avoid accidental dot when intent is 2-finger pan
      pendingId.current  = e.pointerId
      pendingPos.current = p
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
      pendingTO.current = window.setTimeout(()=>{
        if (pendingId.current === e.pointerId) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }, PENDING_MS)
    }

    const onPointerMove = (e: PointerEvent)=>{
      // start on move if pending and moved enough
      if (pendingId.current !== null && e.pointerId === pendingId.current && pendingPos.current) {
        const r = rect()
        const dx = e.clientX - (r.left + pendingPos.current.x)
        const dy = e.clientY - (r.top  + pendingPos.current.y)
        if (Math.hypot(dx, dy) >= MOVE_THRESH) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }

      if (!drawing.current || activeId.current !== e.pointerId || !liveStroke.current) return
      const pt = toLocal(e.clientX, e.clientY)
      liveStroke.current.points.push(pt)
      // draw only the segment for perf
      const k = ctxRef.current!
      const s = liveStroke.current
      const n = s.points.length
      if (n >= 2) {
        applyStrokeStyle(s)
        k.beginPath()
        const a = s.points[n-2], b = s.points[n-1]
        k.moveTo(a.x, a.y); k.lineTo(b.x, b.y); k.stroke()
      }
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      // cancel pending (no draw)
      if (pendingId.current !== null && e.pointerId === pendingId.current) {
        clearPending()
      }
      if (drawing.current && activeId.current === e.pointerId) {
        drawing.current = false
        activeId.current = null
        if (liveStroke.current) {
          // push stroke and keep bitmap as-is
          strokesRef.current.push(liveStroke.current)
          liveStroke.current = null
        }
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
      }
    }

    const onPointerUp           = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel       = (e: PointerEvent)=> endStroke(e)
    const onLostPointerCapture  = (e: PointerEvent)=> endStroke(e)

    c.addEventListener('pointerdown',        onPointerDown,        { passive: false })
    c.addEventListener('pointermove',        onPointerMove,        { passive: false })
    c.addEventListener('pointerup',          onPointerUp,          { passive: false })
    c.addEventListener('pointercancel',      onPointerCancel,      { passive: false })
    c.addEventListener('lostpointercapture', onLostPointerCapture, { passive: false })

    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore(); redrawAll() } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('pointerdown',        onPointerDown as any)
      c.removeEventListener('pointermove',        onPointerMove as any)
      c.removeEventListener('pointerup',          onPointerUp as any)
      c.removeEventListener('pointercancel',      onPointerCancel as any)
      c.removeEventListener('lostpointercapture', onLostPointerCapture as any)
      window.removeEventListener('resize',        onResize)
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
    }
  }, [mode, color, size, tool])

  return (
    <canvas
      ref={canvasRef}
      width={1}
      height={1}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width: `${width}px`, height: `${height}px`,
        WebkitUserSelect: 'none',
        userSelect: 'none',
        WebkitTouchCallout: 'none'
      }}
      onContextMenu={(e)=> e.preventDefault()}
    />
  )
})
