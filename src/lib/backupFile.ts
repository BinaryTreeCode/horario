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
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const datos = entries['d'];
  if (!datos) {
    throw new Error('El archivo .npz no contiene los datos del planificador (entrada "d").');
  }
  const data = JSON.parse(strFromU8(datos));

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
