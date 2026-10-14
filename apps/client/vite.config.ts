import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'
import { fileURLToPath } from 'node:url'
import { vendorLayers } from './scripts/vendorLayers'

export default defineConfig({
  // Physics (plan M6): the deterministic Rapier build whose wasm is a file of its own, compiled by the browser as it
  // streams in, instead of the compat build's 4.4 MB of base64 inside a JavaScript chunk. Same engine, same results.
  // An absolute path: packages/physics imports the compat name and does not depend on this build itself.
  resolve: {
    alias: {
      '@dimforge/rapier3d-deterministic-compat': fileURLToPath(
        new URL('./node_modules/@dimforge/rapier3d-deterministic/rapier.js', import.meta.url),
      ),
    },
  },
  plugins: [
    wasm(),
    {
      // Mirror the production server's pretty-URL aliases so the OAuth
      // callback's redirect to /play works in dev too.
      name: 'page-aliases',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/play') req.url = '/play.html'
          else if (req.url === '/editor') req.url = '/editor.html'
          else if (/^\/play\/[a-z0-9-]+(\?|$)/.test(req.url ?? '')) req.url = '/casual.html'
          next()
        })
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      // Dev: game server runs separately on 8000; proxy the game socket
      // plus the HTTP routes the client calls with relative URLs (character
      // list + openvibe.network SSO login/callback).
      '/ws': { target: 'ws://localhost:8000', ws: true },
      '/api': { target: 'http://localhost:8000' },
      '/auth': { target: 'http://localhost:8000' },
      // Map + its uploaded assets are server-owned state, not client files.
      // Without these the editor boots from Vite's index.html fallback and
      // adopts Vite's ETag as its map revision — every save then 409s.
      '/map.json': { target: 'http://localhost:8000' },
      '/map-assets': { target: 'http://localhost:8000' },
    },
  },
  build: {
    rollupOptions: {
      input: {
        home: 'index.html',
        main: 'play.html',
        editor: 'editor.html',
        leaderboard: 'leaderboard.html',
        casual: 'casual.html',
      },
      // Babylon's core as a chain of layers no larger than 400 KB each, not one 2 MB chunk (scripts/vendorLayers.ts).
      output: { manualChunks: vendorLayers() },
    },
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
})
