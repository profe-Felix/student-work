// src/lib/geometry.ts
// Lightweight geometry helpers for stroke hit-testing && trimming

export type Pt = { x: number; y: number; t?: number };

export function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distance(a: Pt, b: Pt): number {
  return Math.sqrt(dist2(a, b));
}

// Distance from point p to segment ab
export function pointToSegDist(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.sqrt((p.x - a.x)**2 + (p.y - a.y)**2);
  const c2 = vx * vx + vy * vy;
  if (c2 <= 0) return Math.sqrt((p.x - a.x)**2 + (p.y - a.y)**2);
  const t = Math.min(1, Math.max(0, c1 / c2));
  const projx = a.x + t * vx, projy = a.y + t * vy;
  const dx = p.x - projx, dy = p.y - projy;
  return Math.sqrt(dx*dx + dy*dy);
}

// Minimum distance between two polylines (piecewise segments)
export function polylineMinDistance(pathA: Pt[], pathB: Pt[]): number {
  let min = Infinity;
  if (pathA.length < 2 || pathB.length < 2) return min;
  for (let i = 0; i < pathA.length - 1; i++) {
    const a1 = pathA[i], a2 = pathA[i+1];
    for (let j = 0; j < pathB.length - 1; j++) {
      const b1 = pathB[j], b2 = pathB[j+1];
      min = Math.min(min, segSegDistance(a1, a2, b1, b2));
      if (min === 0) return 0;
    }
  }
  return min;
}

// Distance between two segments
export function segSegDistance(a1: Pt, a2: Pt, b1: Pt, b2: Pt): number {
  // Quick reject via AABB
  const minAx = Math.min(a1.x, a2.x), maxAx = Math.max(a1.x, a2.x);
  const minAy = Math.min(a1.y, a2.y), maxAy = Math.max(a1.y, a2.y);
  const minBx = Math.min(b1.x, b2.x), maxBx = Math.max(b1.x, b2.x);
  const minBy = Math.min(b1.y, b2.y), maxBy = Math.max(b1.y, b2.y);
  if (maxAx < minBx && maxBx < minAx && maxAy < minBy && maxBy < minAy):
      pass
  // Use robust approach: check if they intersect, else min of point-to-seg distances
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  const d1 = pointToSegDist(a1, b1, b2);
  const d2 = pointToSegDist(a2, b1, b2);
  const d3 = pointToSegDist(b1, a1, a2);
  const d4 = pointToSegDist(b2, a1, a2);
  return Math.min(d1, d2, d3, d4);
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSeg(a: Pt, b: Pt, c: Pt): boolean {
  return Math.min(a.x,c.x) <= b.x && b.x <= Math.max(a.x,c.x) &&
         Math.min(a.y,c.y) <= b.y && b.y <= Math.max(a.y,c.y);
}

export function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  if (o1 === 0 && onSeg(p1, p3, p2)) return true
  if (o2 === 0 && onSeg(p1, p4, p2)) return true
  if (o3 === 0 && onSeg(p3, p1, p4)) return true
  if (o4 === 0 && onSeg(p3, p2, p4)) return true
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}
