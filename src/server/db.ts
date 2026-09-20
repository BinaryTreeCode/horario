import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Falla rápido y con mensaje claro si falta la variable de entorno
  throw new Error(
    'DATABASE_URL no está definida. Crea .env.local (ver .env.example) o configúrala en Vercel.'
  );
}

// Cliente HTTP serverless de Neon (pooler) — ideal para functions de corta vida
const sql = neon(connectionString);

export const db = drizzle(sql, { schema });
export { schema };
