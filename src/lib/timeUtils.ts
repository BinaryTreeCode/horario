/**
 * Utilidades puras de tiempo y color para el planificador.
 * Módulo desacoplado sin dependencias de Dexie, IndexedDB ni stores reactivas.
 */

export function getActivityColor(categoryId: string, categories: { id: string; color: string }[] | any[]): string {
  return categories.find(c => c.id === categoryId)?.color || '#999';
}

/**
 * Texto legible sobre un color de categoría (WCAG 1.4.3). El blanco
 * fijo fallaba en categorías claras: 2.26:1 en «oración» (#7FB3D5)
 * y 3.51:1 en «Cocinar» (#319795). Umbral de luminancia 0.20:
 * arriba → texto oscuro (≥4.8:1 medido sobre esos colores); abajo
 * → blanco (≥4.9:1). `shadow` es para los bloques "mini", cuyo
 * nombre desborda sobre otros bloques y necesita sombra inversa.
 */
export function textOn(hex: string): { text: string; shadow: string } {
  const m = hex.match(/#?([0-9a-f]{6})/i);
  if (!m) return { text: '#ffffff', shadow: 'rgba(0, 0, 0, 0.55)' };
  const rgb = m[1].match(/../g)!.map(x => parseInt(x, 16) / 255);
  const lin = rgb.map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.20
    ? { text: '#14201a', shadow: 'rgba(255, 255, 255, 0.7)' }
    : { text: '#ffffff', shadow: 'rgba(0, 0, 0, 0.55)' };
}

/** "HH:MM" → horas decimales (p. ej. "08:30" → 8.5; "24:00" → 24). */
export function parseTime(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h + m / 60;
}

/** Horas decimales → "HH:MM" (clamp 24:00, redondeo a minuto entero). */
export function formatTime(hour: number): string {
  // Minutos enteros normalizados: evita "09:60" con flotantes importados
  // (9.999h → 599.94 min → redondeo a 600 → 10:00). Clamp a 24:00.
  const total = Math.min(24 * 60, Math.round(hour * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/** "HH:MM" → "h:mm AM/PM" (12 horas). */
export function format12h(timeStr: string): string {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h < 12 || h === 24 ? 'AM' : 'PM';
  const hour12 = h % 12 || 12;
  return `${hour12}:${(m || 0).toString().padStart(2, '0')} ${period}`;
}
