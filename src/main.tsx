import React from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import StudentAssignment from './pages/student/assignment'
import TeacherSubmission from './pages/teacher/submission'

function App(){
  const base = import.meta.env.BASE_URL || '/'
  return (
    <HashRouter>
      <Routes>
        <Route path="/student/assignment" element={<StudentAssignment/>} />
        <Route path="/teacher/submission" element={<TeacherSubmission/>} />
        <Route path="*" element={<Navigate to="/student/assignment" replace/>} />
      </Routes>
    </HashRouter>
  )
}

createRoot(document.getElementById('root')!).render(<App/>)