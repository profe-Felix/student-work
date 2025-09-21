// src/pages/teacher/index.tsx
import { useEffect, useMemo, useState } from 'react'
import {
  listAssignments,
  listPages,
  listLatestByPage,
  getAudioUrl,
  type AssignmentRow,
  type PageRow,
} from '../../lib/db'
import TeacherSyncBar from '../../components/TeacherSyncBar'
import PdfDropZone from '../../components/PdfDropZone'

type LatestCell = {
  submission_id: string
  hasStrokes: boolean
  audioUrl?: string
} | null

// Simple roster: A_01..A_28 (matches your student format)
const STUDENTS = Array.from({ length: 28 }, (_, i) => `A_${String(i + 1).padStart(2, '0')}`)

export default function TeacherDashboard() {
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentId, setAssignmentId] = useState<string>('') // selected assignment id

  const [pages, setPages] = useState<PageRow[]>([])
  const [pageId, setPageId] = useState<string>('') // selected page id
  const pageIndex = useMemo(
    () => pages.find((p) => p.id === pageId)?.page_index ?? 0,
    [pages, pageId]
  )

  const [loading, setLoading] = useState(false)
  const [grid, setGrid] = useState<Record<string, LatestCell>>({}) // key = student_id

  // Load assignments on mount
  useEffect(() => {
    (async () => {
      try {
        const as = await listAssignments()
        setAssignments(as)
        // Default to "Handwriting - Daily" if present
        const preferred = as.find(a => a.title === 'Handwriting - Daily') ?? as[0]
