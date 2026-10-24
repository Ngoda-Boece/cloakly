import { defineConfig } from 'vite'

// Les content scripts ne peuvent pas être des modules ES : on produit un IIFE autonome.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/content/main.ts',
      formats: ['iife'],
      name: 'CloaklyContent',
      fileName: () => 'content.js',
    },
  },
})
