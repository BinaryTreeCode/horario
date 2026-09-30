import { describe, test, expect } from 'bun:test';
import { zipSync, strToU8 } from 'fflate';
import { leerRespaldo } from './backupFile';
import { validateImport, compactToBackup, type BackupPayload } from './importValidation';
import type { Activity, Category, AppSettings, DayOverride } from './types';

/**
 * Round-trip del export binario (.npz):
 *   payload → placeholders {"i":idx,"f":mime} + binarios en el ZIP
 *   → leerRespaldo reconstruye data-URLs → validateImport acepta.
 * Cubre formato compacto (acts/ovs, imagen en ranura 7) y full
 * (activities/dayOverrides, campo image). Es la pieza que el smoke en
 * browser validó a mano; aquí queda en bun test para CI.
 */

const IMAGEN_1 = 'data:image/webp;base64,UklGRh4A'; // placeholder corto pero data-URL válida
const IMAGEN_2 = 'data:image/jpeg;base64,/9j/4AAQ';

function archivoNpz(payload: unknown, imagenes: Uint8Array[]): File {
  const zip: Record<string, Uint8Array> = { d: strToU8(JSON.stringify(payload)) };
  imagenes.forEach((bytes, i) => { zip[`${i}.bin`] = bytes; });
  return new File([zipSync(zip)], 'planificador-datos-prueba.npz', { type: 'application/zip' });
}

const bytesImagen = (s: string) => new TextEncoder().encode(s);

function payloadFull(): BackupPayload {
  const cats: Category[] = [
    { id: 'rutina', label: 'Rutina', color: '#2f6b2f', order: 0, updatedAt: 0, deletedAt: undefined },
    { id: 'comer', label: 'Comer', color: '#8b5a2b', order: 1, updatedAt: 0, deletedAt: undefined }
  ];
  const acts: Activity[] = [
    { id: 'a1', categoryId: 'rutina', name: 'Rutina', startTime: '06:45', endTime: '07:45', daysOfWeek: [0, 1], image: IMAGEN_1, updatedAt: 100, deletedAt: undefined },
    { id: 'a2', categoryId: 'comer', name: 'Desayuno', startTime: '07:45', endTime: '08:15', daysOfWeek: [0, 1], image: 'https://ejemplo.com/img.webp', updatedAt: 100, deletedAt: undefined },
    { id: 'a3', categoryId: 'comer', name: 'Almuerzo', startTime: '13:00', endTime: '13:30', daysOfWeek: [2], updatedAt: 100, deletedAt: undefined }
  ];
  const ovs: DayOverride[] = [
    { day: 1, activities: [{ ...acts[0], id: 'a1', startTime: '07:00', endTime: '08:00' }], updatedAt: 100, deletedAt: undefined }
  ];
  const sets: AppSettings[] = [
    { id: 'startHour', key: 'startHour', value: 7, updatedAt: 0, deletedAt: undefined },
    { id: 'endHour', key: 'endHour', value: 23, updatedAt: 0, deletedAt: undefined }
  ];
  return { activities: acts, categories: cats, settings: sets, dayOverrides: ovs };
}

describe('leerRespaldo (.npz → JSON para validateImport)', () => {
  test('.json pasa tal cual (sin tocar)', async () => {
    const json = JSON.stringify(payloadFull());
    const texto = await leerRespaldo(new File([json], 'respaldo.json', { type: 'application/json' }));
    expect(JSON.parse(texto)).toEqual(JSON.parse(json));
  });

  test('formato compacto: placeholder {"i","f"} en ranura 7 → data-URL reconstruida', async () => {
    // Export compacto real: c1 con acts posicionales [name,start,end,days,catIdx,desc,steps,image]
    const payload = {
      fmt: 'c1',
      v: 4,
      cat: [['rutina', 'Rutina', '#2f6b2f', 0]],
      acts: [['Rutina', '06:45', '07:45', [0, 1], 0, null, null, { i: 0, f: 'image/webp' }]],
      set: [['startHour', 7]],
      ovs: [[0, [['Rutina', '07:00', '08:00', [0], 0, null, null, { i: 1, f: 'image/webp' }]]]]
    };
    const bytes0 = bytesImagen('WEBP-PRIMERA');
    const bytes1 = bytesImagen('WEBP-SEGUNDA');
    const texto = await leerRespaldo(archivoNpz(payload, [bytes0, bytes1]));
    const v = validateImport(texto);
    expect(v.valid).toBe(true);
    expect(v.summary.activities).toBe(1);
    expect(v.summary.dayOverrides).toBe(1);
    // Las data-URLs reconstruidas llevan el mime del placeholder y el base64 de los bytes:
    const imgAct = v._activities[0].image!;
    expect(imgAct.startsWith('data:image/webp;base64,')).toBe(true);
    expect(atob(imgAct.split(',')[1]!)).toBe('WEBP-PRIMERA');
    const imgOv = v._dayOverrides[0].activities[0].image!;
    expect(atob(imgOv.split(',')[1]!)).toBe('WEBP-SEGUNDA');
  });

  test('formato full: placeholder en activities y dayOverrides → data-URL reconstruida', async () => {
    const p = payloadFull();
    // El export reemplaza las data-URLs por placeholders ANTES de comprimir:
    const parsed: any = JSON.parse(JSON.stringify(p));
    parsed.activities[0]!.image = { i: 0, f: 'image/webp' };
    parsed.dayOverrides[0].activities[0].image = { i: 0, f: 'image/webp' };
    const bytes = bytesImagen('BINARIO-UNICO'); // dedupe: misma imagen, una entrada
    const texto = await leerRespaldo(archivoNpz(parsed, [bytes]));
    const v = validateImport(texto);
    expect(v.valid).toBe(true);
    // La reconstrucción da una data-URL de LOS BYTES del ZIP (base64 del
    // binario 'BINARIO-UNICO'), con el mime del placeholder — no restaura la
    // data-URL original literal (el export la recompresó; eso es esperado):
    expect(v._activities[0].image).toBe(`data:image/webp;base64,${btoa('BINARIO-UNICO')}`);
    expect(v._dayOverrides[0].activities[0].image).toBe(`data:image/webp;base64,${btoa('BINARIO-UNICO')}`);
    // La imagen http del resto viaja intacta:
    expect(v._activities[1].image).toBe('https://ejemplo.com/img.webp');
    // Sin imagen → sin imagen:
    expect(v._activities[2].image).toBeUndefined();
  });

  test('.npz sin entrada "d" lanza error claro', async () => {
    const file = new File([zipSync({ otra: strToU8('{}') })], 'malo.npz', { type: 'application/zip' });
    await expect(leerRespaldo(file)).rejects.toThrow(/no contiene los datos/);
  });

  test('placeholder cuyo binario falta → imagen undefined con warning, fila conservada', async () => {
    const payload = {
      fmt: 'c1',
      v: 4,
      cat: [['rutina', 'Rutina', '#2f6b2f', 0]],
      acts: [['Rutina', '06:45', '07:45', [0], 0, null, null, { i: 5, f: 'image/webp' }]], // índice inexistente
      set: [],
      ovs: []
    };
    const texto = await leerRespaldo(archivoNpz(payload, []));
    const v = validateImport(texto);
    expect(v.valid).toBe(true); // la fila NO se pierde
    expect(v.summary.activities).toBe(1);
    expect(v._activities[0].image).toBeUndefined();
    // El validador informa el placeholder residual (archivo editado/dañado):
    expect(v.warnings.some(w => w.toLowerCase().includes('imagen'))).toBe(true);
  });

  test('round-trip completo compactToBackup → npz → leerRespaldo → validateImport', async () => {
    // El export real serializa con compactToBackup y sustituye imágenes;
    // simularlo de punta a punta con el pipeline público:
    const p = payloadFull();
    const compacto: any = compactToBackup(p);
    // Encuentra las data-URLs en acts (índice 7) y sustitúyelas por placeholders:
    const imgs: Uint8Array[] = [];
    const sustituir = (row: any[]) => {
      if (typeof row[7] === 'string' && row[7].startsWith('data:image/')) {
        const idx = imgs.length;
        imgs.push(bytesImagen(`IMG-${idx}`));
        row[7] = { i: idx, f: row[7].slice(5, row[7].indexOf(';')) };
      }
    };
    for (const a of compacto.acts ?? []) sustituir(a);
    for (const o of compacto.ovs ?? []) for (const a of o[1] ?? []) sustituir(a);
    const texto = await leerRespaldo(archivoNpz(compacto, imgs));
    const v = validateImport(texto);
    expect(v.valid).toBe(true);
    expect(v.summary.activities).toBe(3);
    expect(v.summary.dayOverrides).toBe(1);
    // Todas las imágenes binarias volvieron a ser data-URLs válidas:
    for (const a of v._activities) {
      if (a.image) expect(a.image.startsWith('data:image/') || a.image.startsWith('https://')).toBe(true);
    }
    expect(v._activities[0].image!.startsWith('data:image/webp;base64,')).toBe(true);
  });
});
