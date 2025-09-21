// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'

// PAGES
import Start from './pages/start'
import Teacher from './pages/teacher'                 // src/pages/teacher/index.tsx
import StudentWorkspace from './pages/student/StudentWorkspace' // NEW shim

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

          {/* Preferred student route */}
          <Route path="/student/workspace" element={<StudentWorkspace />} />

          {/* Back-compat aliases so old links keep working */}
          <Route path="/student" element={<StudentWorkspace />} />
          <Route path="/student/assignment" element={<StudentWorkspace />} />

          <Route path="/teacher" element={<Teacher />} />
          <Route path="*" element={<Navigate to="/start" replace />} />
        </Routes>
      </HashRouter>
    </div>
  </React.StrictMode>
)
