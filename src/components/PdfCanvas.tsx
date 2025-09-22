// src/components/PdfCanvas.tsx
import { useEffect, useRef } from 'react'

type Props = {
  url: string
  pageIndex: number    // 0-based
  onReady?: (pdf: any, canvas: HTMLCanvasElement) => void
  scale?: number       // default 1.25
}

export default function PdfCanvas({ url, pageIndex, onReady, scale = 1.25 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const tokenRef = useRef(0)

  useEffect(() => {
    if (!url) return

    let cancelled = false
    let renderTask: any | null = null
    let loadingTask: any | null = null
    let pdfDoc: any | null = null

    const token = ++tokenRef.current

    ;(async () => {
      try {
        const pdfjs: any = await import('pdfjs-dist/build/pdf')
        const ver: string = (pdfjs && pdfjs.version) ? String(pdfjs.version) : '4.10.38'
        // mjs worker works on GH Pages
        pdfjs.GlobalWorkerOptions.workerSrc =
          `https://unpkg.com/pdfjs-dist@${ver}/build/pdf.worker.min.mjs`

        loadingTask = pdfjs.getDocument(url)
        const pdf = await loadingTask.promise
        if (cancelled || token !== tokenRef.current) return
        pdfDoc = pdf

        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled || token !== tokenRef.current) return

        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        // Resize only if changed (reduces flicker)
        if (canvas.width !== viewport.width)  canvas.width  = viewport.width
        if (canvas.height !== viewport.height) canvas.height = viewport.height

        renderTask = page.render({ canvasContext: ctx, viewport })
        await renderTask.promise
        if (cancelled || token !== tokenRef.current) return

        onReady?.(pdf, canvas)
      } catch (e: any) {
        // Expected when a render is superseded by new props
        const msg = (e && e.name) ? e.name : ''
        if (msg === 'RenderingCancelledException' || msg === 'AbortException') {
          // ignore — we’re cancelling on purpose
        } else {
          console.error('PdfCanvas load error', e)
        }
      } finally {
        // Don’t destroy worker on normal prop churn; let browser cache it
      }
    })()

    return () => {
      cancelled = true
      try { renderTask?.cancel() } catch {}
      try { loadingTask?.destroy?.() } catch {}
      try { pdfDoc?.destroy?.() } catch {}
    }
  }, [url, pageIndex, scale, onReady])

  return <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
}
