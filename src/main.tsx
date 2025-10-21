// src/main.tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'

// PAGES
import StudentAssignment from './pages/student/assignment'
import Start from './pages/start'
import Teacher from './pages/teacher'
import InsideOutsideWS from './pages/workstations/InsideOutsideWS'
import GelBagWS from './pages/workstations/GelBagWS'   // ← NEW

// Base styles (optional)
const appStyle: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  color: '#111827'
}

// Helper: redirect while preserving ?query (e.g., ?class=A)
function RedirectWithQuery({ to }: { to: string }) {
  const location = useLocation()
  const search = location.search || ''
  return <Navigate to={`${to}${search}`} replace />
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div style={appStyle}>
      <HashRouter>
        <Routes>
          {/* Root -> /start (preserve ?class= etc.) */}
          <Route path="/" element={<RedirectWithQuery to="/start" />} />

          {/* Main pages */}
          <Route path="/start" element={<Start />} />
          <Route path="/student/assignment" element={<StudentAssignment />} />
          <Route path="/teacher" element={<Teacher />} />

          {/* Virtual Workstations */}
          <Route path="/ws/inside-outside" element={<InsideOutsideWS />} />
          <Route path="/ws/gel-bag" element={<GelBagWS />} />               {/* ← NEW */}

          {/* Shortcuts / legacy redirects (preserve query) */}
          <Route path="/inside-outside" element={<RedirectWithQuery to="/ws/inside-outside" />} />
          <Route path="/gel-bag" element={<RedirectWithQuery to="/ws/gel-bag" />} /> {/* ← NEW */}
          <Route path="/student" element={<RedirectWithQuery to="/start" />} />
          <Route path="/student/start" element={<RedirectWithQuery to="/start" />} />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/start" replace />} />
        </Routes>
      </HashRouter>
    </div>
  </React.StrictMode>
)
