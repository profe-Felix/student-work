import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Hardcode base for GitHub Pages repo: /student-work/
export default defineConfig({
  plugins: [react()],
  base: '/student-work/',
})
