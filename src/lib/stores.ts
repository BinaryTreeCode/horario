import { liveQuery } from "dexie";
import { db } from "./db";

export const activitiesStore = liveQuery(async () => {
  const all = await db.activities.toArray();
  return all.filter(a => !a.deletedAt);
});
export const categoriesStore = liveQuery(async () => {
  const all = await db.categories.orderBy('order').toArray();
  return all.filter(c => !c.deletedAt);
});
export const settingsStore = liveQuery(async () => {
  const all = await db.settings.toArray();
  return all.filter(s => !s.deletedAt);
});
export const dayOverridesStore = liveQuery(async () => {
  const all = await db.dayOverrides.toArray();
  return all.filter(o => !o.deletedAt);
});
export const syncStateStore = liveQuery(() => db.syncState.get('1'));

export function getActivityColor(categoryId: string, categories: any[]) {
    return categories.find(c => c.id === categoryId)?.color || '#999';
}

export function parseTime(time: string): number {
    const [h, m] = time.split(':').map(Number);
    return h + m / 60;
}

export function formatTime(hour: number): string {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function format12h(timeStr: string): string {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 || h === 24 ? 'AM' : 'PM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${(m || 0).toString().padStart(2, '0')} ${period}`;
}
