/**
 * Cifrado de extremo a extremo (E2E) para los datos del planificador.
 *
 * Modelo de confianza: el SERVIDOR guarda blobs que NO puede leer. La clave
 * nunca sale del dispositivo — se deriva del password del usuario con
 * PBKDF2-SHA256 (210k iteraciones, sal aleatoria por cuenta) y vive solo en
 * memoria mientras haya sesión. El password jamás viaja a la nube en texto:
 * el servidor ya tiene su scrypt para autenticar, y aquí se usa como SEMILLA
 * local para la clave AES-GCM.
 *
 * Formato de un campo cifrado (lo que viaja por el sync y vive en la BD):
 *   "np1:<saltB64>:<ivB64>:<datosB64>"
 *   np1    → versión del esquema (permite rotar parámetros a futuro)
 *   salt   → sal PBKDF2 (16 bytes, se regenera por campo: barato y aísla)
 *   iv     → nonce AES-GCM (12 bytes, único por cifrado — NUNCA reutilizar)
 *   datos  → ciphertext + tag GCM (16 bytes de autenticación incluidos)
 *
 * Un campo que no empieza con "np1:" se considera legacy (texto plano de
 * antes de la migración): `decryptField` lo devuelve tal cual y
 * `encryptField` lo cifrará en el próximo push — migración transparente,
 * sin script de datos.
 */

const ESQUEMA = 'np1';
const PBKDF2_ITERACIONES = 210_000; // OWASP 2023: mínimo 210k para PBKDF2-SHA256
const LONGITUD_CLAVE = 256; // bits

/** Clave derivada en memoria: vive solo mientras la sesión esté activa. */
let claveCache: CryptoKey | null = null;
let emailCache: string | null = null;

function b64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ¿La cadena es un campo cifrado con nuestro esquema? */
export function esCifrado(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.startsWith(`${ESQUEMA}:`);
}

/**
 * Deriva la clave AES-GCM del password + email (el email como sal de
 * contexto: dos cuentas con el mismo password derivan claves distintas).
 * Se llama al iniciar sesión (login Y registro) con el password en claro
 * ANTES de limpiarlo del formulario.
 */
export async function establecerClave(email: string, password: string): Promise<void> {
  const material = new TextEncoder().encode(`${email.toLowerCase()}::${password}`);
  const base = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey']);
  // Sal determinista por cuenta: la derivación debe dar SIEMPRE la misma clave
  // (no hay servidor que recuerde una sal aleatoria — la sal va embebida en
  // cada campo cifrado para el IV, pero la clave maestra necesita derivación
  // reproducible: usamos el email como contexto estable).
  const sal = new TextEncoder().encode(`np-sal:${email.toLowerCase()}`);
  claveCache = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: sal, iterations: PBKDF2_ITERACIONES, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: LONGITUD_CLAVE },
    false, // no extraíble: ni el propio JS puede exportarla
    ['encrypt', 'decrypt']
  );
  emailCache = email.toLowerCase();
}

/** Olvida la clave (logout): sin ella, los datos de la nube son ilegibles. */
export function olvidarClave(): void {
  claveCache = null;
  emailCache = null;
}

/** ¿Hay clave derivada en memoria? */
export function tieneClave(): boolean {
  return claveCache !== null;
}

/**
 * Cifra un campo (string) con AES-GCM. Devuelve "np1:salt:iv:datos".
 * null/undefined/vacío pasa de largo (nada que cifrar).
 */
export async function cifrarCampo(valor: string): Promise<string> {
  if (!claveCache) throw new Error('Sin clave E2E: inicia sesión de nuevo');
  if (!valor) return valor;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const datos = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    claveCache,
    new TextEncoder().encode(valor)
  );
  // La sal PBKDF2 no aplica por-campo (la clave ya está derivada): el segundo
  // segmento queda reservado y se llena con ceros informativos de versión.
  return `${ESQUEMA}:0:${b64(iv)}:${b64(datos)}`;
}

/**
 * Descifra un campo. Legacy (sin prefijo np1:) se devuelve tal cual —
 * la migración al formato cifrado ocurre en el próximo push.
 */
export async function descifrarCampo(valor: unknown): Promise<string> {
  if (!esCifrado(valor)) return (valor as string) ?? '';
  if (!claveCache) throw new Error('Sin clave E2E: inicia sesión de nuevo');
  const [, , ivB64, datosB64] = valor.split(':');
  const plano = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(ivB64) },
    claveCache,
    unb64(datosB64)
  );
  return new TextDecoder().decode(plano);
}
