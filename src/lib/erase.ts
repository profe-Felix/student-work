// src/lib/erase.ts
// Object-eraser & soft eraser utilities for vector strokes
import { Pt, pointToSegDist, segmentsIntersect } from "./geometry";

export type Stroke = {
  id: string;
  points: Pt[];
  color: string;
  size: number;
  tool?: "pen" | "highlighter" | "eraser";
  userId?: string;
  pageId?: string | number;
};

type BBox = { minX: number; minY: number; maxX: number; maxY: number };

export function strokeBBox(pts: Pt[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function expandBox(b: BBox, r: number): BBox {
  return { minX: b.minX - r, minY: b.minY - r, maxX: b.maxX + r, maxY: b.maxY + r };
}

export function boxesOverlap(a: BBox, b: BBox): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

// === OBJECT ERASER ===
// Delete any stroke that intersects the erasePath within radius
export function objectErase(strokes: Stroke[], erasePath: Pt[], radius: number): {
  kept: Stroke[];
  removedIds: string[];
} {
  if (erasePath.length < 2) return { kept: strokes, removedIds: [] };
  const pathBox = expandBox(strokeBBox(erasePath), radius);
  const removedIds: string[] = [];
  const kept: Stroke[] = [];
  for (const s of strokes) {
    if (s.points.length < 2) { kept.push(s); continue; }
    const bb = strokeBBox(s.points);
    if (!boxesOverlap(bb, pathBox)) { kept.push(s); continue; }
    // Detailed check: if any segment of stroke comes within radius of any segment of erasePath → remove
    let hit = false;
    for (let i = 0; i < s.points.length - 1 && !hit; i++) {
      const a1 = s.points[i], a2 = s.points[i+1];
      for (let j = 0; j < erasePath.length - 1 && !hit; j++) {
        const b1 = erasePath[j], b2 = erasePath[j+1];
        // Quick intersection check
        if (segmentsIntersect(a1, a2, b1, b2)) { hit = true; break; }
        // Distance within radius check
        const d1 = pointToSegDist(a1, b1, b2);
        const d2 = pointToSegDist(a2, b1, b2);
        if (d1 <= radius || d2 <= radius) { hit = true; break; }
      }
    }
    if (hit) removedIds.push(s.id);
    else kept.push(s);
  }
  return { kept, removedIds };
}

// === SOFT ERASER ===
// Trim points from strokes where erasePath passes within radius.
// Returns possibly split strokes (i.e., erasing holes), preserving style metadata.
export function softErase(strokes: Stroke[], erasePath: Pt[], radius: number, minKeepPoints = 2): Stroke[] {
  if (erasePath.length < 2) return strokes;
  const pathBox = expandBox(strokeBBox(erasePath), radius);
  const out: Stroke[] = [];
  for (const s of strokes) {
    if (s.points.length < 2) { out.push(s); continue; }
    const bb = strokeBBox(s.points);
    if (!boxesOverlap(bb, pathBox)) { out.push(s); continue; }
    // Walk stroke and keep points that are outside erase radius from any erasePath segment.
    const keptRuns: Pt[][] = [];
    let currentRun: Pt[] = [];
    const flush = () => {
      if (currentRun.length >= minKeepPoints) keptRuns.push(currentRun);
      currentRun = [];
    };
    const withinRadius = (p: Pt): boolean => {
      for (let j = 0; j < erasePath.length - 1; j++) {
        const b1 = erasePath[j], b2 = erasePath[j+1];
        const d = pointToSegDist(p, b1, b2);
        if (d <= radius) return true;
      }
      return false;
    };
    for (const p of s.points) {
      if (withinRadius(p)) {
        flush();
      } else {
        currentRun.push(p);
      }
    }
    flush();
    if (keptRuns.length === 0) continue;
    if (keptRuns.length === 1) {
      out.push({ ...s, points: keptRuns[0] });
    } else {
      // Split into multiple strokes to preserve visual continuity
      keptRuns.forEach((pts, idx) => {
        out.push({ ...s, id: `${s.id}__part${idx+1}`, points: pts });
      });
    }
  }
  return out;
}
