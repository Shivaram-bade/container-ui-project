import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || 'http://backend:8000'

function deploymentDetailHtmlFallback() {
  return {
    name: 'deployment-detail-html-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const acceptsHtml = String(req.headers.accept || '').includes('text/html');
        if (req.method === 'GET' && acceptsHtml && req.url?.startsWith('/api/auth/deployment-detail')) {
          req.url = '/deployment';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), deploymentDetailHtmlFallback()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api')
      }
    }
  }
})
