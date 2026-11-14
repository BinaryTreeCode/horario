/**
 * Paleta de sugerencias y mezclador de colores armónicos para categorías.
 *
 * Proporciona:
 * 1. Conversión bidireccional pura HEX <-> HSL.
 * 2. Generación de armonías cromáticas (análoga, monocromática, tríada,
 *    complementaria, dividida, tetrádica, equidistante).
 * 3. Paletas predefinidas inspiradas en la naturaleza (Bosque, Océano,
 *    Atardecer, Flora silvestre, Mineral nórdico, Tierra viva).
 * 4. Armonización global de categorías existentes.
 * 5. Sugerencias automáticas libres de colisión para categorías nuevas.
 */

/** Colores curados a mano: armonía bosque (verde, tierra, agua) + acentos. */
export const PALETA_BASE: string[] = [
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

/** Cuántas sugerencias ofrece la franja rápida. */
export const SUGERENCIAS = 6;

export type TipoArmonia =
  | 'analoga'
  | 'monocromatica'
  | 'triada'
  | 'complementaria'
  | 'dividida'
  | 'tetradica'
  | 'equidistante';

export interface PaletaTematica {
  id: string;
  nombreKey: string;
  descripcionKey: string;
  colores: string[];
}

/** Paletas armónicas curadas inspiradas en la naturaleza. */
export const PALETAS_TEMATICAS: PaletaTematica[] = [
  {
    id: 'bosque',
    nombreKey: 'settings.paletteForest',
    descripcionKey: 'settings.paletteForestDesc',
    colores: ['#2d5a27', '#4a7c44', '#709758', '#3d6b5e', '#6b4e3d', '#8fa382']
  },
  {
    id: 'oceano',
    nombreKey: 'settings.paletteOcean',
    descripcionKey: 'settings.paletteOceanDesc',
    colores: ['#1e3d59', '#2e6b75', '#3e9c9a', '#435b66', '#5b8aa8', '#78909c']
  },
  {
    id: 'atardecer',
    nombreKey: 'settings.paletteSunset',
    descripcionKey: 'settings.paletteSunsetDesc',
    colores: ['#b85042', '#d97d3e', '#d49244', '#8b4f6e', '#74597d', '#a0522d']
  },
  {
    id: 'floral',
    nombreKey: 'settings.paletteFloral',
    descripcionKey: 'settings.paletteFloralDesc',
    colores: ['#7b5ea7', '#9d5b8b', '#b0526b', '#6b8e23', '#4e9a78', '#55854f']
  },
  {
    id: 'nordico',
    nombreKey: 'settings.paletteNordic',
    descripcionKey: 'settings.paletteNordicDesc',
    colores: ['#34495e', '#2c3e50', '#547a82', '#936345', '#7b6d5c', '#475569']
  },
  {
    id: 'tierra',
    nombreKey: 'settings.paletteEarth',
    descripcionKey: 'settings.paletteEarthDesc',
    colores: ['#8b4513', '#a05a2c', '#b8860b', '#556b2f', '#654321', '#a67c52']
  }
];

/** #rrggbb → [h, s, l] con h en 0-360 y s/l en 0-100. */
export function hexAHsl(hex: string): [number, number, number] {
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
  return [Math.round(((h * 60) % 360 + 360) % 360), Math.round(s * 100), Math.round(l * 100)];
}

/** [h, s, l] → #rrggbb en minúsculas. */
export function hslAHex(h: number, s: number, l: number): string {
  const normH = ((Math.round(h) % 360) + 360) % 360;
  const normS = Math.max(0, Math.min(100, Math.round(s)));
  const normL = Math.max(0, Math.min(100, Math.round(l)));
  const c = (1 - Math.abs(2 * (normL / 100) - 1)) * (normS / 100);
  const x = c * (1 - Math.abs(((normH / 60) % 2) - 1));
  const m = normL / 100 - c / 2;
  let r = 0; let g = 0; let b = 0;
  if (normH < 60) { r = c; g = x; }
  else if (normH < 120) { r = x; g = c; }
  else if (normH < 180) { g = c; b = x; }
  else if (normH < 240) { g = x; b = c; }
  else if (normH < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const a = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${a(r)}${a(g)}${a(b)}`;
}

/** Distancia de matiz circular (0-180). */
export function distanciaMatiz(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * ¿Este color se lee como alguno en uso? Mismo matiz (±30°) con
 * luminosidad parecida (±20 puntos) es "el mismo verde" en la
 * grilla, aunque el hex difiera.
 */
export function demasiadoParecido(color: string, usados: string[]): boolean {
  const [h, , l] = hexAHsl(color);
  return usados.some(u => {
    const [hu, , lu] = hexAHsl(u);
    return distanciaMatiz(h, hu) <= 30 && Math.abs(l - lu) <= 20;
  });
}

/**
 * Normaliza saturación y luminosidad para que el color resultante tenga
 * buen contraste con texto blanco (--sobre-color) y mantenga la estética sobria.
 */
function equilibrarTono(s: number, l: number): [number, number] {
  const eqS = Math.max(35, Math.min(75, s));
  const eqL = Math.max(32, Math.min(62, l));
  return [eqS, eqL];
}

/**
 * Genera N variaciones armónicas a partir de un color base según el tipo elegido.
 */
export function generarArmonia(baseHex: string, tipo: TipoArmonia, cantidad: number = 6): string[] {
  const cant = Math.max(1, cantidad);
  const [h, sRaw, lRaw] = hexAHsl(baseHex);
  const [s, l] = equilibrarTono(sRaw, lRaw);

  const colores: string[] = [];

  switch (tipo) {
    case 'analoga': {
      // Abanico armónico centrado o continuo en ±60°
      const span = Math.min(90, Math.max(30, (cant - 1) * 15));
      const paso = cant > 1 ? span / (cant - 1) : 0;
      const inicio = h - span / 2;
      for (let i = 0; i < cant; i++) {
        const hi = (inicio + i * paso + 360) % 360;
        const li = Math.max(28, Math.min(65, l + ((i % 2 === 0 ? 0 : (i % 4 === 1 ? 4 : -4)))));
        colores.push(hslAHex(hi, s, li));
      }
      break;
    }

    case 'monocromatica': {
      // Mismo matiz con variaciones ricas de luminosidad y saturación
      const lMin = 28;
      const lMax = 64;
      const pasoL = cant > 1 ? (lMax - lMin) / (cant - 1) : 0;
      for (let i = 0; i < cant; i++) {
        const li = Math.round(lMin + i * pasoL);
        const si = Math.max(25, Math.min(80, s + (i % 2 === 0 ? 0 : 6)));
        colores.push(hslAHex(h, si, li));
      }
      break;
    }

    case 'complementaria': {
      // Base y opuesto (180°), más variaciones escalonadas
      const opuesto = (h + 180) % 360;
      for (let i = 0; i < cant; i++) {
        const hi = i % 2 === 0 ? h : opuesto;
        const paso = Math.floor(i / 2);
        const deltaL = paso === 0 ? 0 : (paso % 2 === 1 ? 8 : -8);
        const li = Math.max(28, Math.min(64, l + deltaL));
        colores.push(hslAHex(hi, s, li));
      }
      break;
    }

    case 'triada': {
      // 3 polos equidistantes (120°)
      const polos = [h, (h + 120) % 360, (h + 240) % 360];
      for (let i = 0; i < cant; i++) {
        const hi = polos[i % 3];
        const ciclo = Math.floor(i / 3);
        const deltaL = ciclo === 0 ? 0 : (ciclo % 2 === 1 ? 6 : -6);
        const li = Math.max(28, Math.min(64, l + deltaL));
        colores.push(hslAHex(hi, s, li));
      }
      break;
    }

    case 'dividida': {
      // Complementarios divididos: h, h + 150°, h + 210°
      const polos = [h, (h + 150) % 360, (h + 210) % 360];
      for (let i = 0; i < cant; i++) {
        const hi = polos[i % 3];
        const ciclo = Math.floor(i / 3);
        const deltaL = ciclo === 0 ? 0 : (ciclo % 2 === 1 ? 6 : -6);
        const li = Math.max(28, Math.min(64, l + deltaL));
        colores.push(hslAHex(hi, s, li));
      }
      break;
    }

    case 'tetradica': {
      // Rectángulo cromático: h, h + 60°, h + 180°, h + 240°
      const polos = [h, (h + 60) % 360, (h + 180) % 360, (h + 240) % 360];
      for (let i = 0; i < cant; i++) {
        const hi = polos[i % 4];
        const ciclo = Math.floor(i / 4);
        const deltaL = ciclo === 0 ? 0 : (ciclo % 2 === 1 ? 5 : -5);
        const li = Math.max(28, Math.min(64, l + deltaL));
        colores.push(hslAHex(hi, s, li));
      }
      break;
    }

    case 'equidistante':
    default: {
      // Reparto uniforme a lo largo del círculo cromático
      const paso = 360 / cant;
      for (let i = 0; i < cant; i++) {
        const hi = (h + i * paso) % 360;
        colores.push(hslAHex(hi, s, l));
      }
      break;
    }
  }

  return colores;
}

/**
 * Armoniza una lista de categorías asignando a cada una un color coherente.
 * Si 'modo' coincide con el id de una paleta temática, usa los colores de esa paleta.
 * Si 'modo' es un tipo de armonía cromática, genera los colores a partir del color pivote.
 */
export function armonizarCategorias(
  categorias: { id: string; color: string; label?: string }[],
  modo: string,
  colorPivote?: string
): { id: string; color: string }[] {
  if (categorias.length === 0) return [];

  const preset = PALETAS_TEMATICAS.find(p => p.id === modo);
  let paletaFinal: string[] = [];

  if (preset) {
    const base = preset.colores;
    if (categorias.length <= base.length) {
      paletaFinal = base.slice(0, categorias.length);
    } else {
      // Si hay más categorías que colores en el preset, expandimos con variaciones
      paletaFinal = [...base];
      let ciclo = 1;
      while (paletaFinal.length < categorias.length) {
        for (const col of base) {
          if (paletaFinal.length >= categorias.length) break;
          const [h, s, l] = hexAHsl(col);
          const delta = ciclo % 2 === 1 ? 8 : -8;
          const li = Math.max(25, Math.min(65, l + delta));
          paletaFinal.push(hslAHex(h, s, li));
        }
        ciclo++;
      }
    }
  } else {
    // Es un tipo de armonía cromática
    const pivote = colorPivote || categorias[0]?.color || PALETA_BASE[0];
    const tipo = (modo as TipoArmonia) || 'analoga';
    paletaFinal = generarArmonia(pivote, tipo, categorias.length);
  }

  return categorias.map((cat, idx) => ({
    id: cat.id,
    color: paletaFinal[idx] ?? cat.color
  }));
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
  const sugerencias = PALETA_BASE.filter(c => !demasiadoParecido(c, limpios));
  if (sugerencias.length >= SUGERENCIAS) return sugerencias.slice(0, SUGERENCIAS);

  const ultimo = limpios[limpios.length - 1] ?? PALETA_BASE[0];
  const [h0] = hexAHsl(ultimo);
  const extras: string[] = [];
  let h = h0;
  let intentos = 0;
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
 * El color base para una categoría nueva: la primera sugerencia.
 */
export function colorSugerido(usados: string[]): string {
  return paletaSugerida(usados)[0] ?? PALETA_BASE[0];
}
