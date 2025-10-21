// src/components/PdfCanvas.tsx
import { useEffect, useRef } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfCanvas({
  url,
  pageIndex,
  onReady,
}:{
  url: string
  pageIndex: number
  /** onReady(pdf, canvas, { cssW, cssH }) — EXACT CSS size of the page */
  onReady?: (pdf:any, canvas:HTMLCanvasElement, dims:{cssW:number; cssH:number}) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement|null>(null)
  const pdfRef = useRef<any>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const loadingTask = (pdfjsLib as any).getDocument(url)
        const localPdf = await loadingTask.promise
        if (cancelled) return
        pdfRef.current = localPdf

        const page = await localPdf.getPage(pageIndex + 1)
        if (cancelled) return

        // Base viewport at scale 1
        const viewport = page.getViewport({ scale: 1 })

        // Decide CSS width for readability (your existing 900/viewport logic kept)
        const containerWidth = Math.min(900, window.innerWidth - 160)
        const scale = containerWidth / viewport.width
        const scaledViewport = page.getViewport({ scale })

        // Bind canvas EXACT sizes:
        const c = canvasRef.current!
        const ctx = c.getContext('2d')!

        const dpr = window.devicePixelRatio || 1
        const cssW = Math.floor(scaledViewport.width)
        const cssH = Math.floor(scaledViewport.height)
        c.width  = Math.floor(cssW * dpr)
        c.height = Math.floor(cssH * dpr)
        c.style.width  = `${cssW}px`
        c.style.height = `${cssH}px`

        // Reset transform to DPR for crisp PDF rendering
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

        const renderContext = { canvasContext: ctx, viewport: scaledViewport }
        await page.render(renderContext).promise
        if (cancelled) return

        // Tell parent the TRUE CSS size so overlay can match it 1:1
        onReady?.(localPdf, c, { cssW, cssH })
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[PdfCanvas] load error', e)
      }
    }

    load()
    return () => { cancelled = true }
  }, [url, pageIndex, onReady])

  return <canvas ref={canvasRef} style={{ display:'block', background:'#fff' }} />
}
