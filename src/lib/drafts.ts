// src/lib/drafts.ts
export type DraftKey = { studentId: string; pageId: string; kind: 'strokes' | 'audio' }
const k = (d: DraftKey) => `draft:${d.studentId}:${d.pageId}:${d.kind}`

export async function saveLocalDraft(d: DraftKey, value: any) {
  try { localStorage.setItem(k(d), JSON.stringify(value)) } catch {}
}
export async function loadLocalDraft(d: DraftKey) {
  try { const v = localStorage.getItem(k(d)); return v ? JSON.parse(v) : null } catch { return null }
}
export async function clearLocalDraft(d: DraftKey) {
  try { localStorage.removeItem(k(d)) } catch {}
}
