import { pgTable, text, varchar, integer, timestamp, serial, uuid, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

/**
 * 1. Tabla de Usuarios
 * Permite autenticación de usuarios y aislamiento de sus datos.
 */
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: varchar('name', { length: 150 }),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 2. Tabla de Categorías
 * Define las etiquetas y colores asignados a las actividades.
 */
export const categories = pgTable('categories', {
  id: varchar('id', { length: 50 }).primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  label: varchar('label', { length: 100 }).notNull(),
  color: varchar('color', { length: 30 }).notNull(),
  order: integer('order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 3. Tabla de Actividades
 * Almacena los bloques de horario semanales y diarios.
 */
export const activities = pgTable('activities', {
  id: serial('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  categoryId: varchar('category_id', { length: 50 }).references(() => categories.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  startTime: varchar('start_time', { length: 10 }).notNull(), // Ej: "08:00"
  endTime: varchar('end_time', { length: 10 }).notNull(),     // Ej: "09:30"
  daysOfWeek: integer('days_of_week').array().notNull(),      // Ej: [0, 1, 2, 3, 4]
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * 4. Configuración por Usuario
 * Preferencias individuales (horario de inicio/fin del día, tema, etc.)
 */
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  startHour: integer('start_hour').default(7).notNull(),
  endHour: integer('end_hour').default(23).notNull(),
  theme: varchar('theme', { length: 50 }).default('nature').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relaciones entre tablas
export const usersRelations = relations(users, ({ many, one }) => ({
  activities: many(activities),
  categories: many(categories),
  settings: one(userSettings, {
    fields: [users.id],
    references: [userSettings.userId],
  }),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  user: one(users, {
    fields: [categories.userId],
    references: [users.id],
  }),
  activities: many(activities),
}));

export const activitiesRelations = relations(activities, ({ one }) => ({
  user: one(users, {
    fields: [activities.userId],
    references: [users.id],
  }),
  category: one(categories, {
    fields: [activities.categoryId],
    references: [categories.id],
  }),
}));
