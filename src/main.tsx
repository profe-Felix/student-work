// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'

// PAGES
import StudentAssignment from './pages/student/assignment'
import Start from './pages/start'           // keep if you already have it
import Teacher from './pages/teacher'       // NEW

// Base styles (optional)
const appStyle: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  color: '#111827'
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={appStyle}>
      <HashRouter>
        <Routes>
          <Route path="/" element={<Navigate to="/start" replace />} />
          <Route path="/start" element={<Start />} />
          <Route path="/student/assignment" element={<StudentAssignment />} />
          <Route path="/teacher" element={<Teacher />} /> {/* NEW */}
          <Route path="*" element={<Navigate to="/start" replace />} />
        </Routes>
      </HashRouter>
    </div>
  </React.StrictMode>
)
