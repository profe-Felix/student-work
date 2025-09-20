import { Stage, Layer, Line } from 'react-konva'
import { useState } from 'react'

export type Stroke = {
  tool: 'pen'|'highlighter'|'eraser'
  color: string
  size: number
  points: number[]
  t0: number
  t1?: number
}

export default function KonvaStage({ width, height, color, size, onStroke, disabled=false }:{
  width: number
  height: number
  color: string
  size: number
  onStroke: (s: Stroke) => void
  disabled?: boolean
}){
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [current, setCurrent] = useState<Stroke|null>(null)

  const handleDown = (e:any)=>{
    if(disabled) return
    const evt = e.evt as TouchEvent | MouseEvent
    if('touches' in evt && evt.touches && evt.touches.length > 1) return // two-finger: scroll, not draw
    const pos = e.target.getStage().getPointerPosition()
    const s: Stroke = { tool:'pen', color, size, points:[pos.x, pos.y], t0: performance.now() }
    setCurrent(s)
  }
  const handleMove = (e:any)=>{
    if(disabled || !current) return
    const evt = e.evt as TouchEvent | MouseEvent
    if('touches' in evt && evt.touches && evt.touches.length > 1) return
    const pos = e.target.getStage().getPointerPosition()
    setCurrent({ ...current, points:[...current.points, pos.x, pos.y] })
  }
  const handleUp = ()=>{
    if(disabled || !current) return
    const s = { ...current, t1: performance.now() }
    setStrokes(prev=>[...prev, s])
    onStroke(s)
    setCurrent(null)
  }

  return (
    <Stage width={width} height={height} listening={!disabled} onMouseDown={handleDown} onMousemove={handleMove} onMouseup={handleUp}
           onTouchStart={handleDown} onTouchMove={handleMove} onTouchEnd={handleUp}>
      <Layer>
        {strokes.map((s,i)=> (
          <Line key={i} points={s.points} stroke={s.color} strokeWidth={s.size} lineCap="round" lineJoin="round" />
        ))}
        {current && <Line points={current.points} stroke={current.color} strokeWidth={current.size} lineCap="round" lineJoin="round" />}
      </Layer>
    </Stage>
  )
}
