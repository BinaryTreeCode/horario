import { pgTable, text, varchar, integer, bigint, boolean, jsonb, timestamp, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { ActivityStep } from '../lib/types';

/**
 * Usuarios. Autenticación propia con scrypt (node:crypto) + sesiones en BD.
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 150 }),
  passwordHash: text('password_hash').notNull(), // scrypt: salt:hash (hex)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Sesiones. Token aleatorio de 32 bytes (guardado hasheado con sha256);
 * el token plano vive solo en la cookie httpOnly del cliente.
 */
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Datos replicados del planificador, por usuario. Todos traen updated_at (ms epoch)
 * para merge LWW y deleted_at (tombstone) para propagar borrados entre dispositivos.
 */
export const categories = pgTable('categories', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  id: varchar('id', { length: 64 }).notNull(),
  label: varchar('label', { length: 100 }).notNull(),
  color: varchar('color', { length: 30 }).notNull(),
  order: integer('order').notNull().default(0),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (t) => [uniqueIndex('categories_pk').on(t.userId, t.id)]);

export const activities = pgTable('activities', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  id: varchar('id', { length: 64 }).notNull(),
  categoryId: varchar('category_id', { length: 64 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  image: text('image'), // data URL (offline) o URL de Vercel Blob
  startTime: varchar('start_time', { length: 10 }).notNull(),
  endTime: varchar('end_time', { length: 10 }).notNull(),
  daysOfWeek: integer('days_of_week').array().notNull(),
  steps: jsonb('steps').$type<ActivityStep[]>().default([]),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (t) => [uniqueIndex('activities_pk').on(t.userId, t.id)]);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  id: varchar('id', { length: 64 }).notNull(),
  key: varchar('key', { length: 64 }).notNull(),
  value: jsonb('value').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (t) => [uniqueIndex('user_settings_pk').on(t.userId, t.id)]);

export const dayOverrides = pgTable('day_overrides', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  day: integer('day').notNull(),
  activities: jsonb('activities').$type<ActivityStep[] | unknown[]>().notNull().default([]),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (t) => [uniqueIndex('day_overrides_pk').on(t.userId, t.day)]);

export type UserRow = typeof users.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type UserSettingRow = typeof userSettings.$inferSelect;
export type DayOverrideRow = typeof dayOverrides.$inferSelect;
