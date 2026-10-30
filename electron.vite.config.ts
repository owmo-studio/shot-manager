import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('desktop/main.ts'),
          backend: resolve('server/index.ts')
        },
        external: ['fastify'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('desktop/preload.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: 'client',
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'development-csp',
        apply: 'serve',
        transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      }
    ],
    server: { host: '127.0.0.1' },
    build: { rollupOptions: { input: resolve('client/index.html') } }
  }
})
