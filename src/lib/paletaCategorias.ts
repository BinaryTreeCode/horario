/**
 * Paleta de sugerencias para categorías nuevas.
 *
 * Por qué existe: "Añadir categoría" creaba siempre la misma categoría
 * gris (#999999) y el usuario tenía que abrir el selector de color a
 * mano para cada una. Ahora la app propone una paleta que armoniza con
 * el tema Forest (los verdes, tierras y aguas de la semilla) y la
 * categoría nueva nace ya con el primer color libre; un toque en la
 * franja cambia el base y el input nativo sigue disponible para
 * cualquier otro.
 *
 * Datos puros: la categoría sigue teniendo UN color (las actividades lo
 * heredan de ella — sin tocar esquema ni sync) y este módulo no lee ni
 * escribe la BD: recibe los colores en uso y devuelve sugerencias.
 */

/** Colores curados a mano: armonía bosque (verde, tierra, agua) + acentos. */
const PALETA: string[] = [
  '#55854f', // verde bosque
  '#8d6235', // tierra
  '#2a3752', // azul noche
  '#3e9c9a', // agua
  '#6cc28a', // menta
  '#7fb2da', // cielo
  '#7b5ea7', // lavanda
  '#d98a3a', // ámbar
  '#b0526b', // granza
  '#5d8aa8', // acero
];

/** Cuántas sugerencias ofrece la franja. */
export const SUGERENCIAS = 6;

/** #rrggbb → [h, s, l] con h en 0-360 y s/l en 0-100. */
function hexAHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 50];
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return [h * 60, Math.round(s * 100), Math.round(l * 100)];
}

/** [h, s, l] → #rrggbb. */
function hslAHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * (l / 100) - 1)) * (s / 100);
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l / 100 - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const a = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${a(r)}${a(g)}${a(b)}`;
}

/** Distancia de matiz circular (0-180). */
function distanciaMatiz(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * ¿Este color se lee como alguno en uso? Mismo matiz (±30°) con
 * luminosidad parecida (±20 puntos) es "el mismo verde" en la
 * grilla, aunque el hex difiera.
 */
function demasiadoParecido(color: string, usados: string[]): boolean {
  const [h, , l] = hexAHsl(color);
  return usados.some(u => {
    const [hu, , lu] = hexAHsl(u);
    return distanciaMatiz(h, hu) <= 30 && Math.abs(l - lu) <= 20;
  });
}

/**
 * Sugerencias para la próxima categoría: los colores curados que NO
 * están en uso (ni cerca de ellos), en orden de paleta. Cuando la
 * paleta curada se agota, se completan matices nuevos por rotación de
 * ángulo dorado (137.5°), que distribuye alrededor del círculo
 * cromático sin apelotonarse.
 */
export function paletaSugerida(usados: string[]): string[] {
  const limpios = usados.filter(Boolean);
  const sugerencias = PALETA.filter(c => !demasiadoParecido(c, limpios));
  if (sugerencias.length >= SUGERENCIAS) return sugerencias.slice(0, SUGERENCIAS);

  const ultimo = limpios[limpios.length - 1] ?? PALETA[0];
  const [h0] = hexAHsl(ultimo);
  const extras: string[] = [];
  let h = h0;
  let intentos = 0;
  // Primero estrictos (lejos de todo lo usado); si ni en 120 giros
  // alcanza (el usuario tiene categorías de todos los matices),
  // relajados: cualquier hex distinto de los usados.
  while (sugerencias.length + extras.length < SUGERENCIAS && intentos < 240) {
    intentos++;
    h = (h + 137.5) % 360;
    const candidato = hslAHex(h, 42, 52);
    if (extras.includes(candidato) || sugerencias.includes(candidato)) continue;
    if (intentos <= 120 && demasiadoParecido(candidato, limpios)) continue;
    extras.push(candidato);
  }
  return [...sugerencias, ...extras].slice(0, SUGERENCIAS);
}

/**
 * El color base para una categoría nueva: la primera sugerencia. Cada
 * creación consume un color de la paleta (el siguiente create ya no lo
 * ve porque el anterior pasó a estar en uso), así que las categorías
 * nuevas nacen todas distintas sin que el usuario elija nada.
 */
export function colorSugerido(usados: string[]): string {
  return paletaSugerida(usados)[0] ?? PALETA[0];
}
