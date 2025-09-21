import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import StudentAssignment from './pages/student/assignment'
import StartPicker from './pages/start'

const base = import.meta.env.BASE_URL || '/'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter basename="/">
      <Routes>
        <Route path="/" element={<Navigate to="/start" replace />} />
        <Route path="/start" element={<StartPicker />} />
        <Route path="/student/assignment" element={<StudentAssignment />} />
        {/* Teacher route will come next */}
        {/* <Route path="/teacher" element={<TeacherDashboard />} /> */}
        <Route path="*" element={<Navigate to="/start" replace />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>
)
