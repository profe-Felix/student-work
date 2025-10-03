import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // This is the public base path for GitHub Pages at /student-work/
  base: process.env.BASE || '/student-work/',
})
