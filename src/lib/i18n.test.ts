import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Guarda de claves muertas: una clave del catálogo que nadie pide es deuda
 * (hay que traducirla dos veces y nadie la va a leer nunca).
 *
 * El barrido busca la clave entre comillas simples en todo src/ salvo el
 * propio catálogo. Buscar la clave a pelo daría un falso negativo grave:
 * "settings.imported" está contenido en "settings.importedNoSync", que sí se
 * usa, así que la clave muerta parecería viva. Por eso se exige la comilla.
 *
 * Las claves que se arman por prefijo (day.${i}, sync.${syncStatus},
 * modal.preset.${n}) no aparecen literales: se resuelven mirando los prefijos
 * que el código construye con una interpolación.
 */
const RESERVADAS = new Set<string>([
  // La consume la pista de primera ejecución, en el commit siguiente.
  'dayView.dragHint',
]);

describe('i18n: ninguna clave está muerta', () => {
  const raiz = new URL('../../', import.meta.url);
  const ruta = fileURLToPath(new URL('./i18n.ts', import.meta.url));

  /** Prefijos que el código arma por interpolación: `day.${i}`, etc. */
  function prefijosDinamicos(codigo: string): Set<string> {
    const prefijos = new Set<string>();
    for (const m of codigo.matchAll(/([\w.]+)\.\$\{/g)) prefijos.add(m[1]);
    for (const m of codigo.matchAll(/t\(\s*`([\w.]+)\.\$\{/g)) prefijos.add(m[1]);
    return prefijos;
  }

  test('toda clave del catálogo se usa en el código', () => {
    const codigo: string[] = [];
    const prefijos = new Set<string>();
    const recorrer = (dir: URL) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue;
        const hijo = new URL(entrada.name + (entrada.isDirectory() ? '/' : ''), dir);
        if (entrada.isDirectory()) { recorrer(hijo); continue; }
        if (!/\.(ts|svelte|astro)$/.test(entrada.name)) continue;
        if (fileURLToPath(hijo) === ruta) continue;
        const texto = readFileSync(hijo, 'utf8');
        codigo.push(texto);
        for (const p of prefijosDinamicos(texto)) prefijos.add(p);
      }
    };
    recorrer(raiz);
    const todo = codigo.join('\n');

    const muertas: string[] = [];
    for (const clave of es.keys()) {
      if (RESERVADAS.has(clave)) continue;
      if (todo.includes(`'${clave}'`)) continue;
      // Clave construida por prefijo: `day.${i}` cubre day.0..day.6.
      const prefijo = clave.slice(0, clave.lastIndexOf('.'));
      if (prefijos.has(prefijo)) continue;
      muertas.push(clave);
    }

    expect(
      muertas,
      'Claves del catálogo que nadie pide (borrarlas o usarlas):\n' + muertas.join('\n')
    ).toEqual([]);
  });

  test('las claves reservadas están realmente reservadas y no se olvidan', () => {
    // Si una clave reservada queda sin consumidor, hay que sacarla de la
    // lista: es una puerta por la que colaría una clave muerta.
    for (const clave of RESERVADAS) {
      expect(es.has(clave), `${clave} está en RESERVADAS pero ya no existe`).toBe(true);
      expect(en.has(clave), `${clave} está en RESERVADAS pero falta en inglés`).toBe(true);
    }
  });
});
