// src/lib/outbox.ts
type Job = {
  id: string
  kind: 'save-strokes' | 'save-audio'
  payload: any
  attempts: number
  nextAttemptAt: number
}

const PREFIX = 'outbox:'
const now = () => Date.now()

function saveJob(j: Job) {
  try { localStorage.setItem(PREFIX + j.id, JSON.stringify(j)) } catch {}
}
function loadJob(id: string): Job | null {
  try { const v = localStorage.getItem(PREFIX + id); return v ? JSON.parse(v) : null } catch { return null }
}
function deleteJob(id: string) { try { localStorage.removeItem(PREFIX + id) } catch {} }

export async function enqueue(job: { id: string; kind: Job['kind']; payload: any }) {
  const j: Job = { ...job, attempts: 0, nextAttemptAt: now() }
  saveJob(j)
}

export async function allJobs(): Promise<Job[]> {
  const ks = Object.keys(localStorage).filter(k => k.startsWith(PREFIX))
  const jobs: Job[] = []
  for (const key of ks) {
    const j = loadJob(key.substring(PREFIX.length))
    if (j) jobs.push(j)
  }
  return jobs.sort((a,b)=>a.nextAttemptAt-b.nextAttemptAt)
}

export async function complete(id: string) { deleteJob(id) }

export async function reschedule(j: Job): Promise<Job> {
  const delayMs = Math.min(60000, 1000 * Math.pow(2, j.attempts))
  const next: Job = { ...j, attempts: j.attempts + 1, nextAttemptAt: now() + delayMs }
  saveJob(next)
  return next
}

export async function drain(run: (j: Job)=>Promise<void>) {
  const jobs = await allJobs()
  for (const j of jobs) {
    if (j.nextAttemptAt > now()) continue
    try { await run(j); await complete(j.id) }
    catch { await reschedule(j) }
  }
}
