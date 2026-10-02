import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SyncStatus } from './types';

/**
 * Guarda de paridad del catálogo i18n.
 *
 * El archivo se lee como texto a propósito: `es` y `en` son dos objetos
 * literal y el punto del test es justamente que no se les escape una clave al
 * agregar la otra. Además cubre el caso peor de t(): si falta una clave, t()
 * devuelve el NOMBRE de la clave como texto (no lanza), así que una clave
 * faltante se ve en pantalla como "sync.synced" en vez de romperse.
 */
const fuente = readFileSync(fileURLToPath(new URL('./i18n.ts', import.meta.url)), 'utf8');

const corteEn = fuente.indexOf('const en: Catalogo');
if (corteEn < 0) throw new Error('No se encontró "const en: Catalogo": el test no mordería');

const RE_ENTRADA = /^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)'/gm;

/** Extrae clave → valor de un tramo del archivo. */
function entradas(desde: number, hasta: number): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const [, clave, valor] of fuente.slice(desde, hasta).matchAll(RE_ENTRADA)) {
    mapa.set(clave, valor);
  }
  return mapa;
}

const es = entradas(0, corteEn);
const en = entradas(corteEn, fuente.length);

/** Marcadores de interpolación de una plantilla. */
function marcadores(plantilla: string): string[] {
  return [...plantilla.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}

describe('i18n: paridad es/en', () => {
  test('los dos catálogos tienen exactamente las mismas claves', () => {
    const soloEs = [...es.keys()].filter(k => !en.has(k));
    const soloEn = [...en.keys()].filter(k => !es.has(k));
    expect({ soloEs, soloEn }).toEqual({ soloEs: [], soloEn: [] });
  });

  test('ningún catálogo está vacío (el test no mordería si el parseo fallara)', () => {
    expect(es.size).toBeGreaterThan(200);
    expect(en.size).toBe(es.size);
  });

  test('cada clave usa los mismos marcadores de interpolación en ambos idiomas', () => {
    // Traducir "Deshecho: {label}" como "Undone" sin el marcador pierde el
    // nombre de la operación en inglés: el toast sale "Deshecho: {label}".
    const rotas: string[] = [];
    for (const [clave, valorEs] of es) {
      const valorEn = en.get(clave)!;
      if (marcadores(valorEs).join(',') !== marcadores(valorEn).join(',')) {
        rotas.push(`${clave}: es{${marcadores(valorEs).join(',')}} vs en{${marcadores(valorEn).join(',')}}`);
      }
    }
    expect(rotas).toEqual([]);
  });
});

describe('i18n: el estado del sync está traducido entero', () => {
  // Dashboard hace `sync.${syncStatus}`: una clave que falte para un estado
  // sale en pantalla como el literal "sync.offline" (t() no lanza, degrada).
  const ESTADOS: SyncStatus[] = ['offline', 'local', 'syncing', 'synced', 'error'];

  test('cada SyncStatus tiene su clave sync.* en los dos idiomas', () => {
    const faltan: string[] = [];
    for (const estado of ESTADOS) {
      const clave = `sync.${estado}`;
      if (!es.has(clave)) faltan.push(`es:${clave}`);
      if (!en.has(clave)) faltan.push(`en:${clave}`);
    }
    expect(faltan).toEqual([]);
  });

  test('el valor traducido no es la propia clave (t() no degrada al nombre)', () => {
    const degradadas: string[] = [];
    for (const estado of ESTADOS) {
      const clave = `sync.${estado}`;
      if (es.get(clave) === clave) degradadas.push(`es:${clave}`);
      if (en.get(clave) === clave) degradadas.push(`en:${clave}`);
    }
    expect(degradadas).toEqual([]);
  });

  test('el banner de error y el botón Reintentar también están traducidos', () => {
    for (const clave of ['sync.bannerError', 'sync.bannerOffline', 'sync.retry', 'sync.lastAt', 'sync.pending', 'sync.pendingMany']) {
      expect(es.has(clave), `falta es:${clave}`).toBe(true);
      expect(en.has(clave), `falta en:${clave}`).toBe(true);
    }
  });
});
