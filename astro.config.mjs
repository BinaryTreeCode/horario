import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

// Solo usamos base '/horario' al hacer build de producción (GitHub Pages)
// En dev, se sirve en localhost:4321 para no romper los datos locales (IndexedDB/localStorage)
const isProd = process.env.NODE_ENV === 'production';

// https://astro.build/config
export default defineConfig({
  site: 'https://binarytreecode.github.io',
  base: isProd ? '/horario' : '/',
  integrations: [svelte()],
  devToolbar: {
    enabled: false
  },
  vite: {
    build: {
      // Optimizaciones adicionales para asegurar un build ultrarrápido
      target: 'esnext',
      cssMinify: 'lightningcss'
    }
  }
});

