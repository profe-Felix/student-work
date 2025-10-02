//src/lib/erase.ts
// Object-eraser & soft eraser utilities for your Stroke shape (uses `pts`)
import type { Pt } from "./geometry";

// Your app's stroke shape:
export type StrokePoint = { x: number; y: number };
export type Stroke = { color: string; size: number; tool: "pen" | "highlighter"; pts: StrokePoint[] };

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

function strokeBBox(pts: StrokePoint[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function expandBox(b: BBox, r: number): BBox {
  return { minX: b.minX - r, minY: b.minY - r, maxX: b.maxX + r, maxY: b.maxY + r };
}

function boxesOverlap(a: BBox, b: BBox): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

// --- geometry helpers (copied from geometry.ts exports)
import { pointToSegDist, segmentsIntersect } from "./geometry";

// === OBJECT ERASER ===
// Delete any stroke that intersects the erasePath within `radius`.
// Returns new stroke list and the number of removed strokes.
export function objectErase(
  strokes: Stroke[],
  erasePath: Pt[],
  radius: number
): { kept: Stroke[]; removedCount: number } {
  if (erasePath.length < 2) return { kept: strokes, removedCount: 0 };
  const pathBox = expandBox(strokeBBox(erasePath as StrokePoint[]), radius);

  const kept: Stroke[] = [];
  let removed = 0;

  for (const s of strokes) {
    if (!Array.isArray(s.pts) || s.pts.length < 2) {
      // single points or invalid strokes won't match path segments anyway
      kept.push(s);
      continue;
    }
    const bb = strokeBBox(s.pts);
    if (!boxesOverlap(bb, pathBox)) {
      kept.push(s);
      continue;
    }

    // Detailed check: if any segment of stroke comes within radius of any erase segment → remove
    let hit = false;
    for (let i = 0; i < s.pts.length - 1 && !hit; i++) {
      const a1 = s.pts[i], a2 = s.pts[i + 1];
      for (let j = 0; j < erasePath.length - 1 && !hit; j++) {
        const b1 = erasePath[j], b2 = erasePath[j + 1];
        if (segmentsIntersect(a1, a2, b1, b2)) { hit = true; break; }
        const d1 = pointToSegDist(a1, b1, b2);
        const d2 = pointToSegDist(a2, b1, b2);
        if (d1 <= radius || d2 <= radius) { hit = true; break; }
      }
    }

    if (hit) removed++;
    else kept.push(s);
  }

  return { kept, removedCount: removed };
}

// === SOFT ERASER ===
// Trim points from strokes where erasePath passes within `radius`.
// Returns possibly split strokes (multiple pieces), preserving style.
export function softErase(
  strokes: Stroke[],
  erasePath: Pt[],
  radius: number,
  minKeepPoints = 2
): Stroke[] {
  if (erasePath.length < 2) return strokes;
  const pathBox = expandBox(strokeBBox(erasePath as StrokePoint[]), radius);
  const out: Stroke[] = [];

  const withinRadius = (p: StrokePoint): boolean => {
    for (let j = 0; j < erasePath.length - 1; j++) {
      const b1 = erasePath[j], b2 = erasePath[j + 1];
      const d = pointToSegDist(p, b1, b2);
      if (d <= radius) return true;
    }
    return false;
  };

  for (const s of strokes) {
    if (!Array.isArray(s.pts) || s.pts.length < 2) { out.push(s); continue; }

    const bb = strokeBBox(s.pts);
    if (!boxesOverlap(bb, pathBox)) { out.push(s); continue; }

    // Build runs of points that are OUTSIDE the erase radius.
    const keptRuns: StrokePoint[][] = [];
    let currentRun: StrokePoint[] = [];
    const flush = () => {
      if (currentRun.length >= minKeepPoints) keptRuns.push(currentRun);
      currentRun = [];
    };

    for (const p of s.pts) {
      if (withinRadius(p)) flush();
      else currentRun.push(p);
    }
    flush();

    if (keptRuns.length === 0) continue; // whole stroke erased

    if (keptRuns.length === 1) {
      out.push({ ...s, pts: keptRuns[0] });
    } else {
      // Split into multiple strokes to preserve gaps
      keptRuns.forEach((pts /*, idx */) => {
        out.push({ ...s, pts });
      });
    }
  }

  return out;
}
