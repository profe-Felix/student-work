import { useEffect, useRef } from 'react'

/**
 * Canvas drawing with:
 * - Pixel-perfect alignment (handles devicePixelRatio)
 * - Apple Pencil: always draws (pointerType === 'pen')
 * - Touch: 1 finger draws, 2+ fingers scroll/pinch (canvas releases)
 * - Mouse supported
 * - Stable (no resize during a stroke, no policy thrash)
 */
export default function DrawCanvas({
  width,   // CSS width (from PDF canvas CSS size)
  height,  // CSS height (from PDF canvas CSS size)
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
  const ctxRef      = useRef<CanvasRenderingContext2D | null>(null)

  const drawing     = useRef(false)
  const usingPen    = useRef(false)
  const gesturing   = useRef(false)   // true while 2+ touches are on screen
  const lastId      = useRef<number | null>(null) // active pointerId

  // --- helpers ---
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0) // CSS px coordinates
    ctxRef.current = ctx
  }

  const setPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
      return
    }
    // DRAW mode:
    if (gesturing.current && !usingPen.current) {
      // 2+ fingers, no Pencil -> release to scroll/pinch
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else if (drawing.current) {
      // while actively drawing, stop page nudging
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'none'
    } else {
      // idle draw mode: allow two-finger gestures to be recognized by parent
      c.style.pointerEvents = 'auto'
      c.style.touchAction   = 'pan-y pinch-zoom'
    }
  }

  // Resize when props change (but never during an active stroke)
  useEffect(()=>{
    if (!drawing.current) {
      resizeBackingStore()
      setPolicy()
    }
  }, [width, height, mode])

  // Watch for 2+ fingers globally to flip policy immediately
  useEffect(()=>{
    const onTS = (e: TouchEvent)=>{
      if (e.touches.length > 1) { gesturing.current = true;  setPolicy() }
    }
    const onTE = (e: TouchEvent)=>{
      if (e.touches.length <= 1){ gesturing.current = false; setPolicy() }
    }
    window.addEventListener('touchstart', onTS, { passive: true })
    window.addEventListener('touchend',   onTE, { passive: true })
    return ()=>{
      window.removeEventListener('touchstart', onTS as any)
      window.removeEventListener('touchend',   onTE  as any)
    }
  }, [])

  useEffect(()=>{
    const c = canvasRef.current!
    resizeBackingStore()    // ensure ctxRef is set
    setPolicy()

    const rect = () => c.getBoundingClientRect()
    const toLocal = (clientX:number, clientY:number)=>{
      const r = rect()
      return { x: clientX - r.left, y: clientY - r.top }
    }
    const ctx = () => ctxRef.current!

    // --- drawing primitives ---
    const begin = (x:number, y:number)=>{
      const k = ctx()
      k.strokeStyle = color
      k.lineWidth   = size
      k.lineCap     = 'round'
      k.lineJoin    = 'round'
      k.beginPath()
      k.moveTo(x, y)
      // Add a tiny segment so taps leave a dot
      k.lineTo(x + 0.001, y + 0.001)
      k.stroke()
    }
    const lineTo = (x:number, y:number)=>{
      const k = ctx()
      k.lineTo(x, y)
      k.stroke()
    }

    // --- POINTER EVENTS (pen/touch/mouse) ---
    const onPointerDown = (e: PointerEvent)=>{
      if (mode !== 'draw') return
      usingPen.current = (e.pointerType === 'pen')
      // If multi-touch in progress and not Pencil, ignore (let scroll happen)
      if (gesturing.current && !usingPen.current) return

      drawing.current = true
      lastId.current  = e.pointerId
      const p = toLocal(e.clientX, e.clientY)
      begin(p.x, p.y)
      c.setPointerCapture?.(e.pointerId)
      setPolicy()
      e.preventDefault()
    }

    const onPointerMove = (e: PointerEvent)=>{
      if (!drawing.current) return
      // Only track the active pointer
      if (lastId.current !== null && e.pointerId !== lastId.current) return
      if (gesturing.current && !usingPen.current) {
        // Abort drawing if a gesture starts mid-stroke
        drawing.current = false
        lastId.current = null
        c.releasePointerCapture?.(e.pointerId)
        setPolicy()
        return
      }
      const p = toLocal(e.clientX, e.clientY)
      lineTo(p.x, p.y)
      e.preventDefault()
    }

    const endStroke = (e: PointerEvent)=>{
      if (!drawing.current) return
      if (lastId.current !== null && e.pointerId !== lastId.current) return
      drawing.current = false
      usingPen.current = false
      lastId.current = null
      c.releasePointerCapture?.(e.pointerId)
      setPolicy()
    }

    const onPointerUp     = (e: PointerEvent)=> endStroke(e)
    const onPointerCancel = (e: PointerEvent)=> endStroke(e)

    c.addEventListener('pointerdown',  onPointerDown,  { passive: false })
    c.addEventListener('pointermove',  onPointerMove,  { passive: false })
    c.addEventListener('pointerup',    onPointerUp,    { passive: false })
    c.addEventListener('pointercancel',onPointerCancel,{ passive: false })

    // Keep alignment crisp if DPR changes (rotation/zoom)
    const onResize = ()=>{ if (!drawing.current) { resizeBackingStore(); } }
    window.addEventListener('resize', onResize)

    return ()=>{
      c.removeEventListener('pointerdown',  onPointerDown as any)
      c.removeEventListener('pointermove',  onPointerMove as any)
      c.removeEventListener('pointerup',    onPointerUp as any)
      c.removeEventListener('pointercancel',onPointerCancel as any)
      window.removeEventListener('resize',  onResize)
    }
  }, [mode, color, size])

  return (
    <canvas
      ref={canvasRef}
      // Backing size will be set in effect; keep attributes minimal to avoid resets mid-stroke
      width={1}
      height={1}
      style={{
        position:'absolute', inset:0, zIndex:10,
        display:'block', width: `${width}px`, height: `${height}px`
      }}
    />
  )
}
