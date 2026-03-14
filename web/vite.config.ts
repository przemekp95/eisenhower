import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
  },
  define: {
    'process.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL ?? 'http://localhost:3001'),
    'process.env.VITE_AI_API_URL': JSON.stringify(process.env.VITE_AI_API_URL ?? 'http://localhost:8000'),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('pixi.js')) {
            return 'scene';
          }

          if (id.includes('gsap') || id.includes('lenis')) {
            return 'motion';
          }

          if (id.includes('src/components/ai')) {
            return 'ai-tools';
          }

          return undefined;
        },
      },
    },
  },
})
