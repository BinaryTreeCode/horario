/**
 * Rate limiting de la API de auth, respaldado por la tabla `login_attempts`.
 *
 * Por qué en la BD y no en memoria: Vercel serverless es stateless. Un
 * `Map` en módulo vivo viviría en una sola instancia y un atacante que abre
 * varias en paralelo lo salta entero. En la BD el bloqueo es compartido por
 * todas las instancias y sobrevive a reinicios.
 *
 * Modelo: ventana deslizable simple. Cada clave lleva un contador y el
 * instante en que empezó su ventana. Al superar `LIMITE` intentos fallidos
 * dentro de `VENTANA_MS` la clave queda bloqueada hasta `BLOQUEO_MS`. Un
 * login exitoso limpia el contador (el que falla es el que se debe limitar).
 ** PRIVACIDAD: la clave que se persiste NO es el email ni la IP, sino su hash
 * truncado a 64 hex. Un atacante con acceso de solo-lectura a la tabla no puede
 * enumerar qué correos o direcciones han intentado autenticarse, y la tabla no
 * se convierte en un registro de PII. La sal es fija y vive solo en el
 * servidor: no aporta resistencia contra un atacante que ya tenga la BD (esa
 * persona ve hashes, no datos), sirve para que las claves no sean adivinables
 * con un diccionario de emails comunes.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, isDbConfigured } from './db';
import { loginAttempts } from './schema';

/** Fallos tolerados por ventana antes de bloquear. */
const LIMITE = 5;
/** Duración de la ventana de conteo. */
const VENTANA_MS = 15 * 60 * 1000;
/** Cuánto dura el bloqueo una vez superado el límite. */
const BLOQUEO_MS = 15 * 60 * 1000;

/**
 * Sal del servidor para las claves. No es un secreto de autenticación (la
 * seguridad la da el rate limit, no el hash), pero fijarla evita que las
 * claves sean adivinables con un diccionario de emails comunes.
 */
const SAL = process.env.RATE_LIMIT_SALT ?? 'np-rate-limit-v1';

/** Hash truncado y estable de una clave de limiting. */
function claveHash(tipo: string, dato: string): string {
  return createHash('sha256').update(`${SAL}|${tipo}|${dato.trim().toLowerCase()}`).digest('hex').slice(0, 64);
}

export interface EstadoLimite {
  bloqueado: boolean;
  /** Segundos que faltan para desbloquear; 0 si no está bloqueado. */
  reintentarEnSeg: number;
}

/**
 * Consulta el estado de una clave. Sin BD configurada nunca bloquea: la app
 * debe seguir funcionando en modo local puro (regla de AGENTS.md).
 */
export async function consultarLimite(key: string): Promise<EstadoLimite> {
  if (!isDbConfigured) return { bloqueado: false, reintentarEnSeg: 0 };
  try {
    const fila = await db.query.loginAttempts.findFirst({ where: eq(loginAttempts.key, key) });
    if (!fila?.blockedUntil) return { bloqueado: false, reintentarEnSeg: 0 };
    const restante = fila.blockedUntil - Date.now();
    if (restante <= 0) return { bloqueado: false, reintentarEnSeg: 0 };
    return { bloqueado: true, reintentarEnSeg: Math.ceil(restante / 1000) };
  } catch {
    // Si la tabla aún no existe (migración no aplicada) no tumbamos el login:
    // fallar abierto es preferible a dejar la app sin poder iniciar sesión.
    return { bloqueado: false, reintentarEnSeg: 0 };
  }
}

/** Registra un fallo y devuelve el estado resultante (bloquea si toca). */
export async function registrarFallo(key: string): Promise<EstadoLimite> {
  if (!isDbConfigured) return { bloqueado: false, reintentarEnSeg: 0 };
  const ahora = Date.now();
  try {
    const fila = await db.query.loginAttempts.findFirst({ where: eq(loginAttempts.key, key) });

    // Ventana caducada: el contador arranca de cero.
    const enVentana = fila && ahora - fila.windowStart < VENTANA_MS;
    const base = enVentana ? fila.failedCount : 0;
    const inicio = enVentana ? fila.windowStart : ahora;
    const failedCount = base + 1;
    const bloquea = failedCount > LIMITE;
    const blockedUntil = bloquea ? ahora + BLOQUEO_MS : null;

    await db
      .insert(loginAttempts)
      .values({ key, failedCount, windowStart: inicio, blockedUntil, updatedAt: ahora })
      .onConflictDoUpdate({
        target: loginAttempts.key,
        set: { failedCount, windowStart: inicio, blockedUntil, updatedAt: ahora },
      });

    return bloquea
      ? { bloqueado: true, reintentarEnSeg: Math.ceil(BLOQUEO_MS / 1000) }
      : { bloqueado: false, reintentarEnSeg: 0 };
  } catch {
    return { bloqueado: false, reintentarEnSeg: 0 };
  }
}

/** Limpia el contador tras un éxito (login correcto, o ventana vencida). */
export async function limpiarFallos(key: string): Promise<void> {
  if (!isDbConfigured) return;
  try {
    await db.delete(loginAttempts).where(eq(loginAttempts.key, key));
  } catch {
    // sin efecto: el contador se reinicia solo al vencer la ventana
  }
}

/** Clave por correo: frena el credential stuffing contra una cuenta. */
export function claveLogin(email: string): string {
  return claveHash('login', email);
}

/**
 * Clave por IP: frena el abuso de alta de cuentas (miles de registros con
 * correos distintos). La IP se hashea igual, así que no queda en claro.
 */
export function claveRegistro(ip: string): string {
  return claveHash('reg', ip || 'desconocida');
}

/**
 * IP del cliente. Vercel la inyecta en `x-forwarded-for`; fuera de Vercel (o
 * si no llega) cae a 'desconocida', que comparte el mismo bucket y por tanto
 * aplica el mismo límite — conservador a propósito.
 */
export function ipDeRequest(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'desconocida';
}
// ── Presupuesto de sincronización ──────────────────────────────────────────
// El limitador de arriba cuenta FALLOS de login: 5 por 15 minutos. Sirve para
// frenar credential stuffing y no sirve para /api/sync, que empuja y tira en cada
// ciclo (2 requests) y con la cookie de 30 días reintentaría cada 3 s si algo
// falla. Aplicar el limite de login ahí tumbaría el uso normal de la nube.
//
// Aquí lo que se frena es el ABUSO: una sesión válida (o una cookie robada) que
// empuja miles de lotes de 8 MB hincha la base, porque el merge LWW acepta
// cualquier cosa con un updatedAt más nuevo. El presupuesto es por USUARIO (no
// por IP: un móvil detrás de NAT comparte IP con media oficina) y va muy por
// encima de lo que el cliente normal gasta, para no castigar al usuario real.
const SYNC_LIMITE = 120;           // lotes por ventana
const SYNC_VENTANA_MS = 60 * 1000; // 1 minuto
const SYNC_BLOQUEO_MS = 60 * 1000;

/** Clave por usuario: el límite es de la cuenta, no de la conexión. */
export function claveSync(userId: string): string {
  return claveHash('sync', userId);
}

/**
 * Gasto una unidad del presupuesto del usuario. Devuelve el estado resultante;
 * si bloquea, la respuesta es 429 con Retry-After y no se tocan filas.
 *
 * Reusa la tabla login_attempts: failedCount + windowStart + blockedUntil ya
 * son exactamente un contador de ventana deslizante, y la clave va hasheada
 * igual que las de login (el id de usuario no queda en claro).
 */
export async function consumirPresupuestoSync(userId: string): Promise<EstadoLimite> {
  if (!isDbConfigured) return { bloqueado: false, reintentarEnSeg: 0 };
  const key = claveSync(userId);
  const ahora = Date.now();
  try {
    const fila = await db.query.loginAttempts.findFirst({ where: eq(loginAttempts.key, key) });
    const enVentana = fila && ahora - fila.windowStart < SYNC_VENTANA_MS;
    const base = enVentana ? fila.failedCount : 0;
    const inicio = enVentana ? fila.windowStart : ahora;
    const usado = base + 1;
    const bloquea = usado > SYNC_LIMITE;
    const blockedUntil = bloquea ? ahora + SYNC_BLOQUEO_MS : null;
    await db
      .insert(loginAttempts)
      .values({ key, failedCount: usado, windowStart: inicio, blockedUntil, updatedAt: ahora })
      .onConflictDoUpdate({
        target: loginAttempts.key,
        set: { failedCount: usado, windowStart: inicio, blockedUntil, updatedAt: ahora },
      });
    return bloquea
      ? { bloqueado: true, reintentarEnSeg: Math.ceil(SYNC_BLOQUEO_MS / 1000) }
      : { bloqueado: false, reintentarEnSeg: 0 };
  } catch {
    // Tabla ausente o BD caída: fallar abierto. Un límite de abuso no puede ser
    // la razón de que la nube deje de funcionar.
    return { bloqueado: false, reintentarEnSeg: 0 };
  }
}
