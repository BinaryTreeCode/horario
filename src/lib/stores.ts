import { liveQuery } from "dexie";
import { db } from "./db";

export const activitiesStore = liveQuery(() => db.activities.toArray());
export const categoriesStore = liveQuery(() => db.categories.orderBy('order').toArray());
export const settingsStore = liveQuery(() => db.settings.toArray());

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
