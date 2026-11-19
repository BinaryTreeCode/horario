/**
 * Lectura de archivos de respaldo (.json o .npz).
 *
 * El export binario (.npz) es un ZIP con:
 *   - `d`: el payload JSON compacto, con cada imagen inline reemplazada por
 *     { "i": <índice>, "f": <mime> } (los bytes viven en `<índice>.bin`).
 *   - `<índice>.bin`: los bytes puros de cada imagen (sin inflación base64).
 *
 * Aquí se revierte: los placeholders vuelven a ser data-URLs para que el
 * resultado pase por el MISMO pipeline de siempre (validateImport →
 * confirmación → importValidatedData). Los .json se leen tal cual.
 */

/** Límite máximo de bytes descomprimidos permitidos en un .npz (protección zip-bomb). */
export const MAX_UNZIPPED_BYTES = 30 * 1024 * 1024;
/** Límite máximo de entradas dentro de un archivo .npz. */
export const MAX_ZIP_ENTRIES = 500;

/** Convierte bytes → base64 por bloques (btoa no acepta arrays grandes). */
function aBase64(bytes: Uint8Array): string {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** Devuelve el texto JSON listo para validateImport(), venga de .json o .npz. */
export async function leerRespaldo(file: File): Promise<string> {
  const esZip = /\.npz$/i.test(file.name) || file.type === 'application/zip';
  if (!esZip) return file.text();

  const { unzipSync, strFromU8 } = await import('fflate');
  let entradas = 0;
  let totalEstimado = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter(entry) {
        entradas++;
        if (entradas > MAX_ZIP_ENTRIES) {
          throw new Error(`El archivo .npz supera el límite de ${MAX_ZIP_ENTRIES} entradas.`);
        }
        const tam = Number.isFinite(entry.originalSize) && entry.originalSize > 0 ? entry.originalSize : 0;
        totalEstimado += tam;
        if (totalEstimado > MAX_UNZIPPED_BYTES) {
          throw new Error('El archivo .npz supera el tamaño máximo descomprimido permitido (30 MB).');
        }
        return true;
      }
    });
  } catch (err: any) {
    if (err instanceof Error && err.message.startsWith('El archivo .npz supera')) {
      throw err;
    }
    throw new Error('El archivo .npz está dañado o no es un ZIP válido.');
  }

  let totalReal = 0;
  for (const bytes of Object.values(entries)) {
    totalReal += bytes.byteLength;
    if (totalReal > MAX_UNZIPPED_BYTES) {
      throw new Error('El archivo .npz supera el tamaño máximo descomprimido permitido (30 MB).');
    }
  }

  const datos = entries['d'];
  if (!datos) {
    throw new Error('El archivo .npz no contiene los datos del planificador (entrada "d").');
  }

  let data: any;
  try {
    data = JSON.parse(strFromU8(datos));
  } catch {
    throw new Error('Los datos internos del archivo .npz están corruptos (JSON inválido).');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Los datos internos del archivo .npz no tienen un formato válido.');
  }

  const resolver = (a: any) => {
    // La imagen vive en a.image (formato full) o en la ranura 7 de la fila
    // posicional (formato compacto c1) — mismo acceso dual que el export.
    const esFila = Array.isArray(a);
    const im = esFila ? a[7] : a?.image;
    if (im && typeof im === 'object' && Number.isInteger(im.i)) {
      const bytes = entries[`${im.i}.bin`];
      if (bytes) {
        const dataUrl = `data:${im.f || 'image/webp'};base64,${aBase64(bytes)}`;
        if (esFila) a[7] = dataUrl;
        else a.image = dataUrl;
      }
      // Binario ausente: DEJAR el placeholder intacto (no null/undefined —
      // en JSON se indistinguible de "sin imagen"). El validador lo detecta
      // (isPlaceholderImagen) y emite el warning con la fila conservada.
    }
  };
  // Formato compacto (acts/ovs) Y full (activities/dayOverrides).
  for (const a of data.acts ?? []) resolver(a);
  for (const o of data.ovs ?? []) for (const a of o[1] ?? []) resolver(a);
  for (const a of data.activities ?? []) resolver(a);
  for (const o of data.dayOverrides ?? []) for (const a of o.activities ?? []) resolver(a);

  return JSON.stringify(data);
}
