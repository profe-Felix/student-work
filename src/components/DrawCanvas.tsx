import { useEffect, useRef } from 'react'

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
  const gesturing   = useRef(false) // true while 2+ fingers are down

  // Apply interaction policy to the canvas element
  const applyPolicy = ()=>{
    const c = canvasRef.current!
    if (!c) return
    if (mode === 'scroll') {
      // All scrolling handled by Safari
      c.style.pointerEvents = 'none'
      c.style.touchAction   = 'auto'
    } else {
      // Draw mode: allow 2-finger scroll/pinch when a gesture is active
      c.style.pointerEvents = gesturing.current ? 'none' : 'auto'
      c.style.touchAction   = gesturing.current ? 'auto' : 'pan-y pinch-zoom'
    }
  }

  useEffect(applyPolicy, [mode])

  useEffect(()=>{
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!

    const getPos = (e: TouchEvent | MouseEvent)=>{
      const r = canvas.getBoundingClientRect()
      if ('touches' in e && e.touches && e.touches.length) {
        return { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top }
      }
      const me = e as MouseEvent
      return { x: me.clientX - r.left, y: me.clientY - r.top }
    }

    const enterGesture = ()=>{
      if (!gesturing.current) { gesturing.current = true; applyPolicy() }
    }
    const exitGesture = ()=>{
      if (gesturing.current) { gesturing.current = false; applyPolicy() }
    }

    const onTouchStart = (e: TouchEvent)=>{
      if (mode !== 'draw') return
      if (e.touches.length > 1) { enterGesture(); return } // multi-touch → release to scroll container
      drawing.current = true
      const p = getPos(e)
      ctx.strokeStyle = color
      ctx.lineWidth   = size
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      if (e.cancelable) e.preventDefault() // keep page still for 1-finger draw
    }

    const onTouchMove = (e: TouchEvent)=>{
      if (mode !== 'draw') return
      if (e.touches.length > 1) { enterGesture(); return } // let panel/page scroll
      if (!drawing.current) return
      const p = getPos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      if (e.cancelable) e.preventDefault()
    }

    const onTouchEnd = (e: TouchEvent)=>{
      if (mode !== 'draw') return
      drawing.current = false
      const anyTouchesLeft = e.touches && e.touches.length > 0
      if (!anyTouchesLeft) exitGesture()
      else setTimeout(()=> exitGesture(), 0) // per-finger end on iOS
    }

    const onMouseDown = (e: MouseEvent)=>{
      if (mode !== 'draw' || gesturing.current) return
      drawing.current = true
      const p = getPos(e)
      ctx.strokeStyle = color
      ctx.lineWidth   = size
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
    }
    const onMouseMove = (e: MouseEvent)=>{
      if (!drawing.current) return
      const p = getPos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
    }
    const onMouseUp = ()=>{ drawing.current = false }

    // Touch must be non-passive for preventDefault to work
    canvas.addEventListener('touchstart', onTouchStart, { passive: false })
    canvas.addEventListener('touchmove',  onTouchMove,  { passive: false })
    canvas.addEventListener('touchend',   onTouchEnd,   { passive: true  })
    // Mouse (desktop testing)
    canvas.addEventListener('mousedown',  onMouseDown)
    canvas.addEventListener('mousemove',  onMouseMove)
    canvas.addEventListener('mouseup',    onMouseUp)

    return ()=>{
      canvas.removeEventListener('touchstart', onTouchStart as any)
      canvas.removeEventListener('touchmove',  onTouchMove as any)
      canvas.removeEventListener('touchend',   onTouchEnd as any)
      canvas.removeEventListener('mousedown',  onMouseDown as any)
      canvas.removeEventListener('mousemove',  onMouseMove as any)
      canvas.removeEventListener('mouseup',    onMouseUp as any)
    }
  },[color, size, mode])

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
