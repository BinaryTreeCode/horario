import { defineConfig } from '@playwright/test';

// El webServer arranca el dev de Astro y espera a que responda; así el test
// no depende de un servidor externo ni de un preview compilado.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  workers: 1, // IndexedDB local: la app no tolera sesiones paralelas
  reporter: [['list']],
  // Dos proyectos, porque hay bugs que SOLO existen en el celu. El que se
  // reporto hace poco (el chip de la hora actual aplastado a 11px de ancho)
  // era invisible a 1280: la media query de 480px lo rompia y la de escritorio
  // ni lo miraba. Un e2e que solo corre a 1280 no lo puede cazar.
  //
  // 'movil' corre SOLO gestos.spec.ts: es la suite que depende del ancho (el
  // resto de los archivos ya se setea su viewport por test, y accessibility/
  // sync no tienen Layout móvil que Guardar). Los gestos de la Semana, en
  // cambio, se manejan sobre una grilla que a 390px pide scroll horizontal.
  projects: [
    { name: 'escritorio', use: { viewport: { width: 1280, height: 800 } } },
    {
      name: 'movil',
      use: { viewport: { width: 390, height: 844 } },
      testMatch: /gestos\.spec\.ts/
    }
  ],
  use: {
    baseURL: 'http://localhost:4321'
  },
  webServer: {
    command: 'bun run dev',
    url: 'http://localhost:4321',
    reuseExistingServer: true,
    timeout: 60_000
  }
});
