import { useEffect, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import 'pdfjs-dist/build/pdf.worker.min.mjs'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

export default function PdfCanvas({
  url,
  pageIndex = 0,
  onReady
}:{
  url: string
  pageIndex?: number
  onReady?: (pdf:any, canvas: HTMLCanvasElement) => void
}){
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(()=>{
    let cancelled = false
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!

    ;(async ()=>{
      const pdf = await pdfjsLib.getDocument(url).promise
      const page = await pdf.getPage(pageIndex + 1)

      const baseViewport = page.getViewport({ scale: 1 })
      const container = canvas.parentElement as HTMLElement
      const containerCSSWidth = container?.clientWidth || Math.min(900, baseViewport.width)
      const scale = containerCSSWidth / baseViewport.width

      const viewport = page.getViewport({ scale })
      const cssWidth  = Math.round(viewport.width)
      const cssHeight = Math.round(viewport.height)
      const dpr = Math.max(1, window.devicePixelRatio || 1)

      canvas.width  = Math.floor(cssWidth * dpr)
      canvas.height = Math.floor(cssHeight * dpr)
      canvas.style.width  = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const renderTask = page.render({ canvasContext: ctx as any, viewport })
      await renderTask.promise
      if (!cancelled) onReady?.(pdf, canvas)
    })()

    return ()=>{ cancelled = true }
  }, [url, pageIndex])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position:'absolute', inset:0, display:'block',
        width:'100%', height:'100%', pointerEvents:'none', zIndex:0
      }}
    />
  )
}
