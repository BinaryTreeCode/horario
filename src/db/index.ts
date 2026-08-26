import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL || '';

// Cliente SQL serverless de Neon (HTTP connection pooling)
const sql = neon(connectionString);

// Instancia del ORM Drizzle completamente tipada con el esquema
export const db = drizzle(sql, { schema });
