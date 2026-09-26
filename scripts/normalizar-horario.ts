/**
 * Normalizador del horario: arregla lo roto SIN alterar los datos.
 *
 * Cambia exactamente DOS cosas y nada más:
 *   1. Ejercicio (13:00–13:45, L–J) → 19:00–19:45 (L–J): era el único
 *      solape real del plan (pisaba 15 min de Almuerzo 13:30–14:00).
 *      El hueco 19:00–19:45 está libre L–J (Cena termina 19:00, trabajo
 *      empieza 20:00) → el movimiento no toca ningún otro bloque.
 *   2. Nombres: recorta espacios sobrantes (p. ej. "Misa " → "Misa").
 *
 * Todo lo demás (horarios, días, categorías, cantidad de bloques, ids,
 * orden) se conserva EXACTO. Deduplica nada, consolida nada, borra nada.
 *
 * Uso: bun run scripts/normalizar-horario.ts <entrada.json> <salida.json>
 */
import { readFileSync, writeFileSync } from 'fs';

const [, , entrada, salida] = process.argv;
if (!entrada || !salida) {
  console.error('Uso: bun run scripts/normalizar-horario.ts <entrada.json> <salida.json>');
  process.exit(1);
}

const data = JSON.parse(readFileSync(entrada, 'utf8'));

const cambios: string[] = [];
const recorte = (s: string) => s.replace(/\s+/g, ' ').trim();

for (const a of data.activities ?? []) {
  // 1) El único arreglo de fondo: Ejercicio sale del solape con Almuerzo.
  //    13:00–13:45 + 45 min → 19:00–19:45, mismos días (L–J).
  if (recorte(a.name).toLowerCase() === 'ejercicio' && a.startTime === '13:00' && a.endTime === '13:45') {
    a.startTime = '19:00';
    a.endTime = '19:45';
    cambios.push(`⏰ "${a.name.trim()}" movido de 13:00–13:45 a 19:00–19:45 (mismos días) — eliminaba el solape con Almuerzo`);
  }
  // 2) Cosmético: espacios sobrantes en el nombre.
  const limpio = recorte(a.name ?? '');
  if (limpio !== a.name) {
    cambios.push(`✂️ Nombre "${a.name}" → "${limpio}"`);
    a.name = limpio;
  }
  if (typeof a.description === 'string' && recorte(a.description) !== a.description) {
    a.description = recorte(a.description);
  }
}

// Auditoría: después de normalizar, verificar que no queda NINGÚN solape
// por día. Si aparece uno, es un error del propio archivo de entrada y se
// reporta sin corregirlo (el script promete no alterar datos).
const overlaps: string[] = [];
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
for (let d = 0; d < 7; d++) {
  const dia = (data.activities ?? []).filter((a: any) => (a.daysOfWeek ?? []).includes(d));
  const min = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  dia.sort((x: any, y: any) => min(x.startTime) - min(y.startTime));
  for (let i = 0; i < dia.length - 1; i++) {
    if (min(dia[i].endTime) > min(dia[i + 1].startTime) + 1e-9) {
      overlaps.push(`${DIAS[d]}: "${dia[i].name}" (${dia[i].startTime}–${dia[i].endTime}) pisa "${dia[i + 1].name}" (${dia[i + 1].startTime}–${dia[i + 1].endTime})`);
    }
  }
}

data.exportDate = new Date().toISOString();
writeFileSync(salida, JSON.stringify(data, null, 2), 'utf8');

console.log(`✅ ${salida}`);
console.log(cambios.length ? '\nCambios aplicados:' : '\nSin cambios necesarios.');
cambios.forEach(c => console.log('   ' + c));
console.log(overlaps.length ? '\n⛔ Solapes restantes (NO corregidos — revisar a mano):' : '\n✅ Auditoría de solapes: 0 en los 7 días.');
overlaps.forEach(o => console.log('   - ' + o));
