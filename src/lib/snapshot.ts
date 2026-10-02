/**
 * Des-proxy de datos antes de escribirlos en IndexedDB.
 *
 * Regla 2 de AGENTS.md: un proxy de $state no se puede structured-clonar, y
 * `db.put()` usa structured clone, así que escribir un proxy revienta con
 * DataCloneError. La regla dice pasar por `$state.snapshot()`, pero eso solo
 * existe dentro de un componente de Svelte: la ruta de escritura real
 * (commit.ts) es TypeScript plano y no tenía forma de hacerlo.
 *
 * Esta función es el equivalente para código no-Svelte: recorre el valor y
 * devuelve una copia de datos planos, sin proxies en ningún nivel. Recorre
 * en profundidad (y no solo las claves conocidas) para que un campo anidado
 * nuevo no reintroduzca el fallo en silencio.
 *
 * Por qué no `structuredClone` directamente: justamente porque lanza
 * DataCloneError al recibir el proxy, que es el problema que queremos evitar.
 */

/** Copia profunda a datos planos, sin proxies y sin referencias compartidas. */
export function desProxy<T>(valor: T): T {
  return copiar(valor, new WeakSet()) as T;
}

function copiar(valor: unknown, vistos: WeakSet<object>): unknown {
  if (valor === null || typeof valor !== 'object') return valor;

  // Ciclos: si ya vimos este objeto, paramos (un horario real no los tiene,
  // pero un import corrupto sí podría traerlos y aquí no queremos colgarnos).
  if (vistos.has(valor)) return undefined;
  vistos.add(valor);

  if (Array.isArray(valor)) {
    return valor.map(v => copiar(v, vistos));
  }
  if (valor instanceof Date) {
    return new Date(valor.getTime());
  }
  if (valor instanceof Map) {
    return new Map([...valor.entries()].map(([k, v]) => [copiar(k, vistos), copiar(v, vistos)]));
  }
  if (valor instanceof Set) {
    return new Set([...valor.values()].map(v => copiar(v, vistos)));
  }

  const salida: Record<string, unknown> = {};
  for (const clave of Object.keys(valor as Record<string, unknown>)) {
    salida[clave] = copiar((valor as Record<string, unknown>)[clave], vistos);
  }
  return salida;
}

/**
 * ¿El valor se puede structured-clonar? Es la comprobación honesta: la
 * anterior usaba `Array.isArray(a.steps)`, que devuelve `true` también para
 * un proxy de array y por tanto no detectaba proxies (el fallo que decía
 * prevenir). Esta pregunta al motor con la misma operación que hará Dexie.
 */
export function esEstructurable(valor: unknown): boolean {
  try {
    structuredClone(valor);
    return true;
  } catch {
    return false;
  }
}

/**
 * Des-proxy y verifica. Lanza si aun así quedara algo no clonable, para que* el error aparezca en el punto de la escritura y no como un DataCloneError
 * dentro de una transacción de Dexie.
 */
export function desProxyVerificado<T>(valor: T, que: string): T {
  const limpio = desProxy(valor);
  if (!esEstructurable(limpio)) {
    throw new Error(`No se puede guardar ${que}: contiene valores no clonables.`);
  }
  return limpio;
}