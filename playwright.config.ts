import { defineConfig } from '@playwright/test';

// El webServer arranca el dev de Astro y espera a que responda; así el test
// no depende de un servidor externo ni de un preview compilado.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  workers: 1, // IndexedDB local: la app no tolera sesiones paralelas
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4321',
    viewport: { width: 1280, height: 800 }
  },
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:4321',
    reuseExistingServer: true,
    timeout: 60_000
  }
});
