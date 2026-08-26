import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

// https://astro.build/config
export default defineConfig({
  site: 'https://binarytreecode.github.io',
  base: '/horario',
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

