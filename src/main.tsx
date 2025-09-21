import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import StartPicker from './pages/start'
import StudentAssignment from './pages/student/assignment'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter basename="/">
      <Routes>
        <Route path="/" element={<Navigate to="/start" replace />} />
        <Route path="/start" element={<StartPicker />} />
        <Route path="/student/assignment" element={<StudentAssignment />} />
        <Route path="*" element={<Navigate to="/start" replace />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>
)
