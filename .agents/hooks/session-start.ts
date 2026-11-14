/**
 * Hook SessionStart para Antigravity en Nature Planner.
 * Inyecta el contexto operativo y reglas duras al iniciar la sesión.
 */

import { leerStdin } from './shared';

export const SESSION_START_PAYLOAD = {
  injectSteps: [
    {
      systemMessage: {
        systemMessage:
          "Nature Planner: 100% bun (nunca npm). Flujo: Manager/Arquitecto (planes y Zonas Rojas) -> flash (código) -> flash_lite (test/build/commit/push). Zonas Rojas (preguntar antes): src/server/schema.ts, auth y cursor LWW en sync.",
      },
    },
  ],
};

if (import.meta.main) {
  await leerStdin();
  console.log(JSON.stringify(SESSION_START_PAYLOAD, null, 2));
  process.exit(0);
}
