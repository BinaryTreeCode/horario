import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';

// https://astro.build/config
export default defineConfig({
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

