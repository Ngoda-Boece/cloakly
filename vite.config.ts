import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'

/**
 * Embarque le moteur WASM d'ONNX Runtime dans l'extension : Manifest V3
 * interdit de charger du code depuis un CDN (comportement par défaut de transformers.js).
 */
function bundleOnnxRuntime(): Plugin {
  const dist = new URL('./node_modules/onnxruntime-web/dist/', import.meta.url)
  const files = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']
  return {
    name: 'cloakly-bundle-onnx-runtime',
    apply: 'build',
    generateBundle(_options, bundle) {
      // Vite émet aussi sa propre copie hachée du .wasm, inutilisée puisque
      // runtime.ts fixe wasmPaths : on évite 27 Mo en double.
      for (const name of Object.keys(bundle)) {
        if (/^assets\/ort-wasm-.*\.wasm$/.test(name)) delete bundle[name]
      }
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: `ort/${file}`, source: readFileSync(new URL(file, dist)) })
      }
    },
  }
}

// Build du popup, du document offscreen (modèles IA) et du service worker.
// Le content script est construit à part (vite.content.config.ts) : Chrome
// l'exige en un seul fichier non modulaire.
// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react(), bundleOnnxRuntime()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // transformers.js et ONNX Runtime pèsent lourd : c'est attendu ici.
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        popup: 'index.html',
        offscreen: 'offscreen.html',
        background: 'src/background/main.ts',
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
