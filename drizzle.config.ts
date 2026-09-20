import { defineConfig } from 'drizzle-kit';
import { readFileSync, existsSync } from 'node:fs';

// Carga DATABASE_URL desde .env.local (prioridad) o .env — sin dependencias externas.
function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*"([^"]+)"\s*$/);
      if (m) return m[1];
    }
  }
  return undefined;
}

export default defineConfig({
  schema: './src/server/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: loadDatabaseUrl() ?? '',
  },
});
