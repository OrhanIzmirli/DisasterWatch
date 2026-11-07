import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // React and the router change rarely: their own chunk stays cached across deploys
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return "vendor";
        },
      },
    },
  },
  server: {
    // Same role as nginx/default.conf in Docker: /api/news -> http://localhost:5000/news
    proxy: {
      // '^/api/' (not '/api'): the /api page itself is a route of the app
      '^/api/': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
