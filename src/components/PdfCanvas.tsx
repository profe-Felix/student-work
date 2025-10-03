import { useEffect, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import 'pdfjs-dist/build/pdf.worker.min.mjs' // Vite-friendly worker import

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

export default function PdfCanvas({
  url,
  pageIndex,
  onReady,
}:{
  url: string
  pageIndex: number
  onReady?: (pdf:any, canvas:HTMLCanvasElement)=>void
}){
  const canvasRef = useRef<HTMLCanvasElement|null>(null)
  const pdfRef    = useRef<any>(null)
  const renderTaskRef = useRef<any>(null)

  useEffect(()=>{
    let cancelled = false
    let localPdf: any = null

    const load = async ()=>{
      try{
        // Cancel any prior render
        if (renderTaskRef.current && renderTaskRef.current.cancel) {
          try { await renderTaskRef.current.cancel() } catch {}
        }
        renderTaskRef.current = null

        // Destroy old doc
        if (pdfRef.current && pdfRef.current.destroy) {
          try { await pdfRef.current.destroy() } catch {}
          pdfRef.current = null
        }

        const loadingTask = pdfjsLib.getDocument(url)
        localPdf = await loadingTask.promise
        if (cancelled) return
        pdfRef.current = localPdf

        const page = await localPdf.getPage(pageIndex + 1)
        if (cancelled) return

        const viewport = page.getViewport({ scale: 1 })
        const containerWidth = Math.min(900, window.innerWidth - 160) // keep it readable with toolbar
        const scale = containerWidth / viewport.width
        const scaledViewport = page.getViewport({ scale })

        const canvas = canvasRef.current!
        const ctx = canvas.getContext('2d')!
        canvas.width  = Math.floor(scaledViewport.width * window.devicePixelRatio)
        canvas.height = Math.floor(scaledViewport.height * window.devicePixelRatio)
        canvas.style.width  = `${scaledViewport.width}px`
        canvas.style.height = `${scaledViewport.height}px`

        // Reset transform to dpr
        ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0)
        const renderContext = { canvasContext: ctx, viewport: scaledViewport }
        const task = page.render(renderContext)
        renderTaskRef.current = task
        await task.promise
        if (cancelled) return

        onReady?.(localPdf, canvas)
      } catch(e){
        // swallow errors when unmounted/cancelled
        // console.warn('PDF render error', e)
      }
    }

    load()

    const onResize = ()=>{
      // Re-render on resize
      load()
    }
    window.addEventListener('resize', onResize)

    return ()=>{
      cancelled = true
      window.removeEventListener('resize', onResize)
      if (renderTaskRef.current && renderTaskRef.current.cancel) {
        try { renderTaskRef.current.cancel() } catch {}
      }
      // Let pdf.js clean up
      if (pdfRef.current && pdfRef.current.destroy) {
        try { pdfRef.current.destroy() } catch {}
      }
      pdfRef.current = null
      renderTaskRef.current = null
    }
  }, [url, pageIndex])

  return (
    <canvas
      ref={canvasRef}
      style={{
        display:'block',
        width:'100%',
        height:'auto',
        background:'#fff',
        borderRadius: 8
      }}
    />
  )
}
