// src/hooks/usePageClock.ts
import { useRef, useCallback } from 'react'

/**
 * Page clock: time 0 starts at first action; persists across reloads
 * We keep a "baseOffsetMs" (max of all ink/audio seen) and add running wall time.
 */
export function usePageClock() {
  const baseOffsetMs = useRef(0)      // jumps forward when we see later ink/audio
  const runningRef   = useRef(false)
  const wallStartMs  = useRef(0)

  const ensureRunning = useCallback(() => {
    if (!runningRef.current) {
      runningRef.current = true
      wallStartMs.current = performance.now()
    }
  }, [])

  const bumpTo = useCallback((tMs: number) => {
    // If new content ends after our current notion of "now", move base forward
    const now = performance.now()
    const runningElapsed = runningRef.current ? (now - wallStartMs.current) : 0
    const currentClock = baseOffsetMs.current + runningElapsed
    if (tMs > currentClock) {
      baseOffsetMs.current = tMs
      if (runningRef.current) {
        wallStartMs.current = now
      }
    }
  }, [])

  const nowMs = useCallback(() => {
    const runningElapsed = runningRef.current ? (performance.now() - wallStartMs.current) : 0
    return Math.max(0, Math.round(baseOffsetMs.current + runningElapsed))
  }, [])

  const markFirstAction = useCallback(() => {
    ensureRunning()
  }, [ensureRunning])

  const absorbStrokePointT = useCallback((t: number | undefined) => {
    if (typeof t === 'number' && t >= 0) {
      ensureRunning()
      // stroke points carry absolute page-relative t already; keep base at least as large
      bumpTo(t)
    }
  }, [bumpTo, ensureRunning])

  const absorbMediaEnd = useCallback((endMs: number) => {
    ensureRunning()
    bumpTo(endMs)
  }, [bumpTo, ensureRunning])

  return {
    nowMs,             // current page-clock time
    markFirstAction,   // call when first action occurs (draw start or first record)
    absorbStrokePointT,// feed incoming stroke point t-values
    absorbMediaEnd,    // update base when new media extends the end time
  }
}
