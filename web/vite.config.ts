import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.VITE_API_URL': JSON.stringify(process.env.VITE_API_URL ?? 'http://localhost:3001'),
    'process.env.VITE_AI_API_URL': JSON.stringify(process.env.VITE_AI_API_URL ?? 'http://localhost:8000'),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@react-three') || id.includes('three')) {
            return 'scene';
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
