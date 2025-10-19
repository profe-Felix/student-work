// src/types/timeline.ts
export type StrokePoint = { x:number; y:number; t:number }
export type Stroke = {
  color: string
  size: number
  tool: 'pen' | 'highlighter' | 'eraser'
  pts: StrokePoint[]
}

export type AudioSeg = {
  kind: 'audio'
  id: string
  startMs: number
  durationMs: number
  mime: string
  url: string
  label?: string
}

export type PageArtifact = {
  canvasWidth: number
  canvasHeight: number
  strokes: Stroke[]
  media: AudioSeg[]
  strokeSegments?: Array<{ strokeIndex:number; startMs:number; endMs:number }>
}
