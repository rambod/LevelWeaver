import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  // Defense-in-depth: any stray bare `process.env.X` in browser code resolves
  // to `{}` instead of throwing `ReferenceError: process is not defined`.
  define: {
    'process.env': '{}',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    open: true
  }
})