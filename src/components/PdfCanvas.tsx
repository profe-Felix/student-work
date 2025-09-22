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
  const lastTokenRef = useRef(0)

  useEffect(() => {
    if (!url) return

    let cancelled = false
    let cleanup: (() => void) | null = null
    let renderTask: any | null = null
    let loadingTask: any | null = null
    let pdfDoc: any | null = null

    const token = ++lastTokenRef.current

    ;(async () => {
      try {
        const pdfjs: any = await import('pdfjs-dist/build/pdf')

        // Match worker to runtime api version to avoid mismatch
        const ver: string = (pdfjs && pdfjs.version) ? String(pdfjs.version) : '4.10.38'
        pdfjs.GlobalWorkerOptions.workerSrc =
          `https://unpkg.com/pdfjs-dist@${ver}/build/pdf.worker.min.mjs`

        // Cancel any previous render by creating a new token; also keep handles to cancel below
        loadingTask = pdfjs.getDocument(url)
        const pdf = await loadingTask.promise
        if (cancelled || token !== lastTokenRef.current) return
        pdfDoc = pdf

        const page = await pdf.getPage(pageIndex + 1)
        if (cancelled || token !== lastTokenRef.current) return

        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current
        if (!canvas) return
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        canvas.width = viewport.width
        canvas.height = viewport.height

        renderTask = page.render({ canvasContext: ctx, viewport })
        await renderTask.promise
        if (cancelled || token !== lastTokenRef.current) return

        onReady?.(pdf, canvas)

        cleanup = () => {
          try { renderTask?.cancel() } catch {}
          try { loadingTask?.destroy?.() } catch {}
          try { pdfDoc?.destroy?.() } catch {}
        }
      } catch (e) {
        console.error('PdfCanvas load error', e)
      }
    })()

    return () => {
      cancelled = true
      // Hard-cancel any in-flight work on prop change/unmount
      try { renderTask?.cancel() } catch {}
      try { loadingTask?.destroy?.() } catch {}
      try { pdfDoc?.destroy?.() } catch {}
      if (cleanup) cleanup()
    }
  }, [url, pageIndex, scale, onReady])

  return <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
}
