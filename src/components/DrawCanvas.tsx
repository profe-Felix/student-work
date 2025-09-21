import { useEffect, useRef } from 'react'

/**
 * Pointer-Events based canvas with:
 * - Apple Pencil: always draws (even if fingers are on screen)
 * - Touch: 1 finger draws, 2+ fingers scroll/pinch the outer panel
 * - Mouse: left button draws
 * - Smooth strokes (RAF-batched)
 */
export default function DrawCanvas({
  width,
  height,
  color,
  size,
  mode // 'scroll' | 'draw'
}:{
  width: number
  height: number
  color: string
  size: number
  mode: 'scroll' | 'draw'
}){
  const canvasRef   = useRef<HTMLCanvasElement>(null)

  const drawing     = useRef(false)
  const usingPen    = useRef(false)       // pointerType === 'pen'
  const gesturing   = useRef(false)       // true while 2+ touches on screen
  const pointsQueue = useRef<{x:number,y:number}[]>([])
  const rafId       = useRef<number|undefined>(undefined)

  // ---- style helpers ----
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      // Always let page/panel scroll
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // Draw mode
    if (gesturing.current && !usingPen.current) {
      // Two-finger gesture with no Pencil: release to panel/page
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else if (drawing.current) {
      // While actively drawing, stop page nudging
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'none'
    } else {
      // Idle draw mode: allow two-finger gestures to be recognized by the panel
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'pan-y pinch-zoom'
    }
  }

  useEffect(applyPolicy, [mode])

  // ---- global touch listeners (to detect 2+ fingers reliably on iPad) ----
  useEffect(()=>{
    const onTS = (e: TouchEvent)=> { if (e.touches.length > 1) { gesturing.current = true;  applyPolicy() } }
    const onTE = (e: TouchEvent)=> { if (e.touches.length <= 1){ gesturing.current = false; applyPolicy() } }
    window.addEventListener('touchstart', onTS, { passive: true })
    window.addEventListener('touchend',   onTE, { passive: true })
    return ()=> {
      window.removeEventListener('touchstart', onTS as any)
      window.removeEventListener('touchend',   onTE  as any)
    }
  }, [])

  // ---- draw loop (RAF) ----
  useEffect(()=>{
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!

    const drawFrame = ()=>{
      // Batch queued points into the current path
      if (pointsQueue.current.length) {
        ctx.strokeStyle = color
        ctx.lineWidth   = size
        ctx.lineCap     = 'round'
        ctx.lineJoin    = 'round'
        ctx.beginPath()
        const first = pointsQueue.current[0]
        ctx.moveTo(first.x, first.y)
        for (let i=1; i<pointsQueue.current.length; i++){
          const p = pointsQueue.current[i]
          ctx.lineTo(p.x, p.y)
        }
        ctx.stroke()
        pointsQueue.current = []
      }
      rafId.current = requestAnimationFrame(drawFrame)
    }
    rafId.current = requestAnimationFrame(drawFrame)
    return ()=> { if (rafId.current) cancelAnimationFrame(rafId.current) }
  }, [color, size])

  useEffect(()=>{
    const canvas = canvasRef.current!
    const rect = ()=> canvas.getBoundingClientRect()

    const toLocal = (clientX:number, clientY:number)=>{
      const r = rect()
      return { x: clientX - r.left, y: clientY - r.top }
    }

    // ----- POINTER EVENTS (covers pen, touch, mouse) -----
    const onPointerDown = (e: PointerEvent)=>{
      if (mode !== 'draw') return
      // Pencil always draws (force through even if fingers are on screen)
      usingPen.current = (e.pointerType === 'pen')
      if (usingPen.current || (e.pointerType === 'touch' || e.pointerType === 'mouse')) {
        drawing.current = true
        const p = toLocal(e.clientX, e.clientY)
        pointsQueue.current.push(p)
        // Capture so we keep getting move events even if leaving element
        canvas.setPointerCapture?.(e.pointerId)
        applyPolicy()
        // Prevent page nudge for pen or single-finger draw
        e.preventDefault()
      }
    }

    const onPointerMove = (e: PointerEvent)=>{
      if (!drawing.current) return
      // If a gesture is in progress (2+ touches) and not using Pencil, stop drawing
      if (gesturing.current && !usingPen.current) {
        drawing.current = false
        canvas.releasePointerCapture?.(e.pointerId)
        applyPolicy()
        return
      }
      const p = toLocal(e.clientX, e.clientY)
      pointsQueue.current.push(p)
      // keep page still while drawing
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      if (!drawing.current) return
      drawing.current = false
      usingPen.current = false
      canvas.releasePointerCapture?.(e.pointerId)
      applyPolicy()
    }

    // Safari sometimes fires pointercancel when system gesture takes over
    const onPointerUp     = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel = (e: PointerEvent)=> endStroke(e)

    // Register listeners (non-passive so preventDefault works during draw)
    canvas.addEventListener('pointerdown',  onPointerDown,  { passive: false })
    canvas.addEventListener('pointermove',  onPointerMove,  { passive: false })
    canvas.addEventListener('pointerup',    onPointerUp,    { passive: false })
    canvas.addEventListener('pointercancel',onPointerCancel,{ passive: false })

    return ()=>{
      canvas.removeEventListener('pointerdown',  onPointerDown as any)
      canvas.removeEventListener('pointermove',  onPointerMove as any)
      canvas.removeEventListener('pointerup',    onPointerUp as any)
      canvas.removeEventListener('pointercancel',onPointerCancel as any)
    }
  }, [mode])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width:'100%', height:'100%'
      }}
    />
  )
}
