/**
 * Cifrado de extremo a extremo (E2E) para los datos del planificador.
 *
 * Modelo de confianza: el SERVIDOR guarda blobs que NO puede leer. La clave
 * nunca sale del dispositivo — se deriva del password del usuario con
 * PBKDF2-SHA256 (210k iteraciones) y vive solo en memoria mientras haya
 * sesión. El password jamás viaja a la nube en texto: el servidor ya tiene su
 * scrypt para autenticar, y aquí se usa como SEMILLA local para la clave
 * AES-GCM.
 *
 * La sal de la derivación es DETERMINISTA ("np-sal:" + email normalizado) y
 * no aleatoria: la clave maestra tiene que reproducirse igual en cada
 * dispositivo y en cada sesión, y el servidor no guarda ninguna sal que
 * pudiera acompañar al ciphertext. El PBKDF2 con 210k iteraciones es lo que
 * encarece el ataque por diccionario; el email como sal solo hace que dos
 * cuentas con la misma contraseña deriven claves distintas.
 *
 * Formato real de un campo cifrado (lo que viaja por el sync y vive en la BD):
 *   "np1:<version>:<ivB64>:<datosB64>"
 *   np1       → versión del esquema (permite rotar parámetros a futuro)
 *   version   → marcador de versión reservado; hoy siempre "0" y sin uso.
 *               Antes este segmento se documentaba como una sal por campo y
 *               nunca lo fue: no hay sal por campo.
 *   iv        → nonce AES-GCM (12 bytes, aleatorio y único por cifrado — lo
 *               que garantiza que dos textos iguales den ciphertext distinto
 *               y que reutilizar nonce sea detectable)
 *   datos     → ciphertext + tag GCM (16 bytes de autenticación incluidos)
 *
 * Un campo que no empieza con "np1:" se considera legacy (texto plano de
 * antes de la migración): `descifrarCampo` lo devuelve tal cual y
 * `cifrarCampo` lo cifrará en el próximo push — migración transparente,
 * sin script de datos.
 */

const ESQUEMA = 'np1';
const PBKDF2_ITERACIONES = 210_000; // OWASP 2023: mínimo 210k para PBKDF2-SHA256
const LONGITUD_CLAVE = 256; // bits

/** Clave derivada en memoria: vive solo mientras la sesión esté activa. */
let claveCache: CryptoKey | null = null;

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
  // Sal determinista por cuenta: la derivación debe dar SIEMPRE la misma clave,
  // en cada dispositivo y en cada sesión. No hay servidor que recuerde una sal
  // aleatoria, y el campo cifrado solo lleva el IV; por eso el email hace de
  // sal estable (ver la cabecera del archivo).
  const sal = new TextEncoder().encode(`np-sal:${email.toLowerCase()}`);
  claveCache = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: sal, iterations: PBKDF2_ITERACIONES, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: LONGITUD_CLAVE },
    false, // no extraíble: ni el propio JS puede exportarla
    ['encrypt', 'decrypt']
  );
}

/** Olvida la clave (logout): sin ella, los datos de la nube son ilegibles. */
export function olvidarClave(): void {
  claveCache = null;
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
  // Sin sal por campo: la clave ya está derivada y lo que protege cada
  // cifrado es el IV aleatorio. El segundo segmento queda reservado para la
  // versión del formato.
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
