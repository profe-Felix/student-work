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
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)

  useEffect(()=>{
    const canvas = canvasRef.current!
    // Toggle DOM props exactly like the working debug page
    canvas.style.pointerEvents = mode === 'scroll' ? 'none' : 'auto'
    canvas.style.touchAction = mode === 'scroll' ? 'auto' : 'none'
  },[mode])

  useEffect(()=>{
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let active = true

    const getPos = (e: any)=>{
      const rect = canvas.getBoundingClientRect()
      if('touches' in e && e.touches && e.touches.length){
        return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top }
      }
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const down = (e: any)=>{
      if(mode !== 'draw') return
      if('touches' in e && e.touches && e.touches.length > 1) return // let page handle multi-touch
      drawing.current = true
      const p = getPos(e)
      ctx.strokeStyle = color
      ctx.lineWidth = size
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      ctx.moveTo(p.x, p.y)
      if(e.cancelable) e.preventDefault()
    }
    const move = (e: any)=>{
      if(!drawing.current) return
      const p = getPos(e)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      if('touches' in e && e.touches && e.touches.length <= 1){
        if(e.cancelable) e.preventDefault()
      }
    }
    const up = ()=>{
      drawing.current = false
    }

    canvas.addEventListener('touchstart', down, { passive: false })
    canvas.addEventListener('touchmove', move, { passive: false })
    canvas.addEventListener('touchend', up)
    canvas.addEventListener('mousedown', down)
    canvas.addEventListener('mousemove', move)
    canvas.addEventListener('mouseup', up)

    return ()=> {
      if(!active) return
      canvas.removeEventListener('touchstart', down as any)
      canvas.removeEventListener('touchmove', move as any)
      canvas.removeEventListener('touchend', up as any)
      canvas.removeEventListener('mousedown', down as any)
      canvas.removeEventListener('mousemove', move as any)
      canvas.removeEventListener('mouseup', up as any)
      active = false
    }
  },[color, size, mode])

  return <canvas ref={canvasRef} width={width} height={height} style={{
    position:'absolute', inset:0, zIndex:10, display:'block', width:'100%', height:'100%'
  }} />
}
