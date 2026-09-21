import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { readFileSync, existsSync } from 'node:fs';
import * as schema from './schema';

function loadDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if ((import.meta as any).env?.DATABASE_URL) return (import.meta as any).env.DATABASE_URL;
  for (const f of ['.env.local', '.env']) {
    if (!existsSync(f)) continue;
    try {
      for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/);
        if (m) return m[1];
      }
    } catch {}
  }
  return undefined;
}

const connectionString = loadDatabaseUrl();
export const isDbConfigured = Boolean(connectionString);

const fallbackHandler: ProxyHandler<any> = {
  get(_target, prop) {
    if (prop === 'then') return undefined;
    return () => {
      throw new Error('DATABASE_URL no está configurada. La aplicación funciona en modo local con IndexedDB.');
    };
  }
};

// Cliente HTTP serverless de Neon si hay DATABASE_URL, proxy de fallback si es solo local
export const db = isDbConfigured
  ? drizzle(neon(connectionString!), { schema })
  : (new Proxy({}, fallbackHandler) as ReturnType<typeof drizzle>);

export { schema };

