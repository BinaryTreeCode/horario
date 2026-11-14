/**
 * Hook PreInvocation para Antigravity en Nature Planner.
 * Inspecciona rápidamente el estado de git (sin tocar node_modules),
 * detectando cambios en Zonas Rojas y violaciones de diseño/runes en archivos .svelte modificados.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { leerStdin } from './shared';

const ZONAS_ROJAS = new Set([
  'src/server/schema.ts',
  'src/server/auth.ts',
  'src/pages/api/auth.ts',
  'src/lib/sync.ts',
  'src/pages/api/sync.ts',
]);

/**
 * Parsea la salida de `git status --porcelain` extrayendo las rutas de los archivos modificados.
 * Maneja renombrados (`orig -> dest`), comillas y barras diagonales.
 */
export function parsearGitPorcelain(salida: string): string[] {
  if (!salida || typeof salida !== 'string') return [];
  const lineas = salida.split(/\r?\n/);
  const rutas: string[] = [];

  for (const linea of lineas) {
    if (!linea.trim() || linea.length < 4) continue;
    let resto = linea.slice(3).trim();
    if (!resto) continue;

    // Manejar renombrados: orig -> dest
    if (resto.includes(' -> ')) {
      const partes = resto.split(' -> ');
      resto = partes[partes.length - 1].trim();
    }

    // Quitar comillas si están presentes
    if (resto.startsWith('"') && resto.endsWith('"')) {
      resto = resto.slice(1, -1);
    }

    // Normalizar barras diagonales de Windows
    resto = resto.replace(/\\/g, '/');
    rutas.push(resto);
  }

  return rutas;
}

/**
 * Detecta si alguna de las rutas modificadas pertenece a las Zonas Rojas del proyecto.
 */
export function detectarZonasRojas(rutas: string[]): string[] {
  if (!Array.isArray(rutas)) return [];
  const detectadas = new Set<string>();

  for (const ruta of rutas) {
    if (!ruta || typeof ruta !== 'string') continue;
    const normalizada = ruta.replace(/\\/g, '/').replace(/^\.\//, '');
    if (ZONAS_ROJAS.has(normalizada)) {
      detectadas.add(normalizada);
    }
  }

  return Array.from(detectadas);
}

/**
 * Analiza el contenido de un componente .svelte para asegurar cumplimiento de:
 * 1. Svelte 5 runes (prohibido export let, createEventDispatcher, <svelte:component)
 * 2. Accesibilidad/Toasts (prohibido alert(), confirm())
 * 3. Tokens CSS en <style> (prohibido hex, rgba, rgb sin var(--), o white/black literales)
 */
export function analizarContenidoSvelte(ruta: string, contenido: string): string[] {
  const avisos: string[] = [];

  // Separar bloques <style> del resto (<script> y template)
  let contenidoEstilos = '';
  const resto = contenido.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    contenidoEstilos += '\n' + css;
    return '';
  });

  // Limpiar comentarios en script y template:
  // - Ignorar comentarios simples // ... precedidos de inicio de línea o espacio
  //   (para no mutilar URLs como https://... ni llamadas en la misma línea)
  // - Ignorar comentarios /* ... */ y <!-- ... -->
  const restoLimpio = resto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|\s)\/\/.*/gm, '$1');

  // 1. Detectar patrones prohibidos en <script> / template
  if (/\bexport\s+let\b/.test(restoLimpio)) {
    avisos.push(`${ruta}: Prohibido 'export let' (usar $props() de Svelte 5)`);
  }
  if (/\bcreateEventDispatcher\b/.test(restoLimpio)) {
    avisos.push(`${ruta}: Prohibido 'createEventDispatcher' (usar callbacks en $props() de Svelte 5)`);
  }
  if (/<svelte:component\b/.test(restoLimpio)) {
    avisos.push(`${ruta}: Prohibido '<svelte:component' (usar componentes dinámicos directos en Svelte 5)`);
  }
  if (/\balert\s*\(/.test(restoLimpio)) {
    avisos.push(`${ruta}: Prohibido 'alert()' (usar toasts propios de src/lib/toast.ts)`);
  }
  if (/\bconfirm\s*\(/.test(restoLimpio)) {
    avisos.push(`${ruta}: Prohibido 'confirm()' (usar modal o confirmación UI propia, no window.confirm)`);
  }

  // 2. Analizar <style>
  // Limpiar comentarios /* ... */ en CSS
  const estilosLimpios = contenidoEstilos.replace(/\/\*[\s\S]*?\*\//g, '');

  if (estilosLimpios.trim().length > 0) {
    // Detectar colores hex: #[0-9a-fA-F]{3,8}\b
    if (/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/i.test(estilosLimpios)) {
      avisos.push(`${ruta}: Prohibido colores hexadecimales en <style> (usar tokens CSS rgb(var(--token) / alfa))`);
    }

    // Detectar rgba(...)
    if (/\brgba\s*\(/i.test(estilosLimpios)) {
      avisos.push(`${ruta}: Prohibido 'rgba()' en <style> (usar rgb(var(--token) / alfa))`);
    }

    // Detectar rgb(...) que NO use var(--
    const rgbMatches = estilosLimpios.matchAll(/\brgb\s*\(([\s\S]*?)\)/gi);
    for (const match of rgbMatches) {
      if (!match[1].includes('var(--')) {
        avisos.push(`${ruta}: Prohibido 'rgb()' sin tokens CSS en <style> (debe usar rgb(var(--token) / alfa))`);
        break;
      }
    }

    // Detectar white/black literales como valor de propiedad (:\s*(?:white|black)\b)
    if (/:\s*(?:white|black)\b/i.test(estilosLimpios)) {
      avisos.push(`${ruta}: Prohibido color literal 'white' o 'black' en <style> (usar tokens CSS)`);
    }
  }

  return avisos;
}

if (import.meta.main) {
  let repoRoot = resolve(import.meta.dir, '../..');
  try {
    const raw = await leerStdin();
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (parsed?.workspacePaths?.[0]) {
        repoRoot = parsed.workspacePaths[0];
      }
    }
  } catch {
    // Fallback a repoRoot default
  }

  const avisos: string[] = [];

  try {
    const gitRes = spawnSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    const gitSalida = gitRes.stdout || '';
    const rutasDirty = parsearGitPorcelain(gitSalida);

    // Chequeo de Zonas Rojas
    const zonasRojasModificadas = detectarZonasRojas(rutasDirty);
    if (zonasRojasModificadas.length > 0) {
      avisos.push(
        `Zona Roja modificada: ${zonasRojasModificadas.join(', ')} (requiere confirmación previa por riesgo de integridad o pérdida de datos).`
      );
    }

    // Inspección de componentes .svelte modificados bajo src/
    for (const ruta of rutasDirty) {
      if (ruta.startsWith('src/') && ruta.endsWith('.svelte')) {
        const rutaAbs = resolve(repoRoot, ruta);
        if (existsSync(rutaAbs)) {
          const contenido = readFileSync(rutaAbs, 'utf-8');
          const problemasSvelte = analizarContenidoSvelte(ruta, contenido);
          avisos.push(...problemasSvelte);
        }
      }
    }
  } catch {
    // Si falla git status, no interrumpir ejecución
  }

  if (avisos.length > 0) {
    const ephemeralMessage =
      'Nature Planner Linter Guardrail:\n' +
      avisos.map((a) => `- ${a}`).join('\n') +
      '\nPor favor verifica y corrige estas desviaciones.';
    console.log(
      JSON.stringify(
        {
          injectSteps: [{ ephemeralMessage }],
          terminationBehavior: '',
        },
        null,
        2
      )
    );
  } else {
    console.log(
      JSON.stringify(
        {
          injectSteps: [],
          terminationBehavior: '',
        },
        null,
        2
      )
    );
  }

  process.exit(0);
}
