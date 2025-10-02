import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/student-work/',
  resolve: {
    dedupe: ['react', 'react-dom'], // <- ensure only one copy is bundled
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
})
