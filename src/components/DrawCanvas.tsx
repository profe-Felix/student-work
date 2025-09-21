import { useEffect, useRef } from 'react'

/**
 * Drawing that plays nice with two-finger scroll + Apple Pencil:
 * - Single finger: starts drawing after 60ms or a small move (no accidental dot)
 * - Two fingers: cancels any pending draw and releases to scroll/pinch
 * - Apple Pencil: draws immediately (no delay)
 * - Pixel-accurate (handles devicePixelRatio)
 * - No resize during a stroke
 */
export default function DrawCanvas({
  width,   // CSS width (from PDF canvas)
  height,  // CSS height (from PDF canvas)
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
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const ctxRef       = useRef<CanvasRenderingContext2D | null>(null)

  const drawing      = useRef(false)
  const usingPen     = useRef(false)
  const activeId     = useRef<number | null>(null)       // pointerId we draw with

  const touchCount   = useRef(0)                         // active touch pointers
  const gesturing    = useRef(false)                     // true when touchCount >= 2

  // Pending single-finger start (to detect second finger)
  const pendingId    = useRef<number | null>(null)
  const pendingPos   = useRef<{x:number,y:number} | null>(null)
  const pendingTO    = useRef<number | null>(null)
  const PENDING_MS   = 60
  const MOVE_THRESH  = 8   // px before we commit to draw

  // --- size/backing store ---
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // draw in CSS pixels
    ctxRef.current = ctx
  }

  // --- interaction policy (must be set BEFORE touches begin) ---
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // DRAW mode: keep touch-action none so 1-finger won’t scroll;
    // release only when we KNOW 2+ touches are down.
    if (gesturing.current && !usingPen.current) {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'none'
    }
  }

  // Apply sizing/policy when props change (but never mid-stroke)
  useEffect(()=>{
    if (!drawing.current) {
      resizeBackingStore()
      applyPolicy()
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
    const ctx = () => ctxRef.current!

    // Stroke helpers
    const begin = (x:number, y:number)=>{
      const k = ctx()
      k.strokeStyle = color
      k.lineWidth   = size
      k.lineCap     = 'round'
      k.lineJoin    = 'round'
      k.beginPath()
      k.moveTo(x, y)
      k.lineTo(x + 0.001, y + 0.001) // dot for taps
      k.stroke()
    }
    const lineTo = (x:number, y:number)=>{
      const k = ctx()
      k.lineTo(x, y)
      k.stroke()
    }

    // Pending helpers
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
      begin(pendingPos.current.x, pendingPos.current.y)
      clearPending()
    }

    // Touch pointer bookkeeping
    const addTouch = ()=> {
      touchCount.current += 1
      if (touchCount.current >= 2) {
        gesturing.current = true
        // If a second finger arrives while a single-finger start is pending, cancel it.
        clearPending()
        // If drawing (single finger) and not Pencil, abort and release to scroll
        if (drawing.current && !usingPen.current) {
          drawing.current = false
          activeId.current = null
        }
        applyPolicy()
      }
    }
    const removeTouch = ()=> {
      touchCount.current = Math.max(0, touchCount.current - 1)
      const nowGesturing = touchCount.current >= 2
      if (nowGesturing !== gesturing.current) {
        gesturing.current = nowGesturing
        applyPolicy()
      }
    }

    // Pointer handlers (pen/touch/mouse)
    const onPointerDown = (e: PointerEvent)=>{
      // Keep touch count up to date first
      if (e.pointerType === 'touch') addTouch()

      if (mode !== 'draw') return

      usingPen.current = (e.pointerType === 'pen')

      // If we’re in a real 2-finger gesture and not Pencil → do not start drawing
      if (gesturing.current && !usingPen.current) return

      const p = toLocal(e.clientX, e.clientY)

      if (usingPen.current || e.pointerType === 'mouse') {
        // Pencil/mouse: start immediately
        drawing.current  = true
        activeId.current = e.pointerId
        begin(p.x, p.y)
        c.setPointerCapture?.(e.pointerId)
        e.preventDefault()
        return
      }

      // TOUCH (single finger): delay a bit to see if a 2nd finger appears
      pendingId.current  = e.pointerId
      pendingPos.current = p
      if (pendingTO.current) window.clearTimeout(pendingTO.current)
      pendingTO.current = window.setTimeout(()=>{
        // If no second finger arrived, commit to draw
        if (!gesturing.current && pendingId.current === e.pointerId) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }, PENDING_MS)

      // We don't preventDefault yet; touch-action is none in draw mode so page won't scroll anyway
    }

    const onPointerMove = (e: PointerEvent)=>{
      // If this pointer is the pending single-finger start, start when moved enough
      if (pendingId.current !== null && e.pointerId === pendingId.current && pendingPos.current) {
        const dx = e.clientX - (rect().left + pendingPos.current.x)
        const dy = e.clientY - (rect().top  + pendingPos.current.y)
        if (Math.hypot(dx, dy) >= MOVE_THRESH && !gesturing.current) {
          commitPending()
          c.setPointerCapture?.(e.pointerId)
        }
      }

      if (!drawing.current) return
      if (activeId.current !== null && e.pointerId !== activeId.current) return

      // If gesture begins mid-stroke (2nd touch down) and not Pencil, abort draw
      if (gesturing.current && !usingPen.current) {
        drawing.current = false
        activeId.current = null
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
        return
      }

      const p = toLocal(e.clientX, e.clientY)
      lineTo(p.x, p.y)
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      // Maintain touch active count
      if (e.pointerType === 'touch') removeTouch()

      // Cancel pending start if this was the pending pointer
      if (pendingId.current !== null && e.pointerId === pendingId.current) {
        clearPending()
      }

      if (drawing.current && activeId.current !== null && e.pointerId === activeId.current) {
        drawing.current = false
        usingPen.current = false
        activeId.current = null
        c.releasePointerCapture?.(e.pointerId)
        applyPolicy()
      } else {
        // Even if not drawing, policy may need to update after touch changes
        applyPolicy()
      }
    }

    const onPointerUp           = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel       = (e: PointerEvent)=> endStroke(e)
    const onLostPointerCapture  = (e: PointerEvent)=> endStroke(e)

    // Register (must be non-passive so preventDefault works)
    c.addEventListener('pointerdown',        onPointerDown,        { passive: false })
    c.addEventListener('pointermove',        onPointerMove,        { passive: false })
    c.addEventListener('pointerup',          onPointerUp,          { passive: false })
    c.addEventListener('pointercancel',      onPointerCancel,      { passive: false })
    c.addEventListener('lostpointercapture', onLostPointerCapture, { passive: false })

    // Keep crisp on DPR change (rotate/zoom) — avoid during stroke
    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore() } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('pointerdown',        onPointerDown as any)
      c.removeEventListener('pointermove',        onPointerMove as any)
      c.removeEventListener('pointerup',          onPointerUp as any)
      c.removeEventListener('pointercancel',      onPointerCancel as any)
      c.removeEventListener('lostpointercapture', onLostPointerCapture as any)
      window.removeEventListener('resize',        onResize)
      clearPending()
    }
  }, [mode, color, size])

  return (
    <canvas
      ref={canvasRef}
      width={1}
      height={1}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width: `${width}px`, height: `${height}px`
      }}
    />
  )
}
