import { defineConfig } from 'astro/config';
import svelte from '@astrojs/svelte';
import vercel from '@astrojs/vercel';

// Deploy en Vercel: adapter serverless + base '/'.
// (El antiguo base '/horario' era para GitHub Pages y se retiró al migrar a Vercel.)
export default defineConfig({
  output: 'server',
  adapter: vercel(),
  integrations: [svelte()],
  devToolbar: {
    enabled: false
  },
  vite: {
    build: {
      target: 'esnext',
      cssMinify: 'lightningcss'
    },
    optimizeDeps: {
      include: ['dexie', 'lucide-svelte', 'svelte-dnd-action', 'layerchart']
    }
  }
});
