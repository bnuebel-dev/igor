import { defineConfig } from 'vite'

// Relative base: the same build works on GitHub Pages (/igor/) and inside an .ehpk package.
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
})
