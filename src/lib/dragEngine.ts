/**
 * Motor unificado de arrastre (Pointer Events) — dueño único de la mecánica
 * del gesto para las vistas Día y Semana. Reemplaza al DnD nativo de HTML5
 * (no dispara en táctil, regla 6 de AGENTS.md) y a las implementaciones
 * duplicadas de Pointer Events. Las vistas aportan la semántica (preview,
 * commit, restauración) vía hooks; el motor aporta:
 *  - Armado: mouse por umbral (5px), táctil/lápiz por long-press (260ms);
 *    mover antes del long-press es scroll y cancela el gesto pendiente.
 *  - Freno de scroll táctil (C1): touchmove no pasivo con preventDefault
 *    mientras el drag está armado (touch-action se decide al TOCAR).
 *  - Supresión del menú contextual del sistema durante el drag (M3).
 *  - Captura del puntero y fantasma (translateY + lift 1.03) cuando
 *    `ghost: true`; el resize usa `ghost: false` (crece por preview).
 *  - Auto-scroll proporcional cerca de los bordes, eje configurable (M5),
 *    con compensación del fantasma y re-emisión de onMove al desplazar.
 *  - Háptica: vibrate(10) al armar, vibrate(8) al soltar.
 *  - Cancelación garantizada (C2): pointercancel, Esc, blur y desmontaje
 *    siempre limpian clase, transform, captura y listeners.
 *  - Los hooks que lanzan no dejan el motor en estado inconsistente.
 */

export interface DragTarget {
  card: HTMLElement;
  activityId: string;
  /** Metadatos de la vista (p. ej. el día de origen en la Semana). */
  meta?: unknown;
}

export interface DragHooks {
  /** El gesto se armó: la vista entra en modo drag (fantasma/preview). */
  onActivate?: (t: DragTarget) => void;
  /** Movimiento con gesto armado (px de viewport). También se emite durante auto-scroll. */
  onMove: (t: DragTarget, clientX: number, clientY: number) => void;
  /** Soltar con gesto armado → commit. */
  onDrop: (t: DragTarget, clientX: number, clientY: number) => void;
  /** Fin sin commit (cancel, Esc, blur, desmontaje, quiet-hold). */
  onCancel?: (t: DragTarget) => void;
}

export interface DragEngineOptions {
  /** Clase que marca la tarjeta en pleno drag (estilo de fantasma). */
  ghostClass?: string;
  /** Eje del auto-scroll del contenedor (omitir = sin auto-scroll). */
  scrollAxis?: 'x' | 'y';
  scrollContainer?: () => HTMLElement | null;
  /**
   * Patrón iOS (G6, ELIMINADO en F3 del plan v2): antes, dedo TÁCTIL quieto
   * `ms` desde el pointerdown cancelaba el drag y abría el menú contextual.
   * Trababa el arrastre (el dedo se detiene un instante y pierde el gesto).
   * El menú táctil desapareció: click derecho sigue abriéndolo (mouse).
   * Opción conservada por compatibilidad; las vistas ya NO la pasan.
   */
  quietHold?: { ms: number; onQuiet: (t: DragTarget, x: number, y: number) => void };
}

export interface BeginOptions {
  ghost?: boolean;
  quiet?: boolean;
}

interface Gesture {
  target: DragTarget;
  hooks: DragHooks;
  pointerId: number;
  isMouse: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** Máxima distancia alcanzada desde el inicio (no la actual). */
  maxDist: number;
  started: boolean;
  ghost: boolean;
  armTimer: number;
  quietTimer: number;
  /** scrollTop del contenedor al empezar: compensa el fantasma en auto-scroll. */
  scrollTop0: number;
  /** Todos los listeners del gesto cuelgan de esta señal. */
  listeners: AbortController;
}

const THRESHOLD_PX = 5;      // mouse: distancia para armar
const TOUCH_CANCEL_PX = 10;  // táctil: movimiento pre-armado = scroll
/** Umbral de mitades: el táctil arma el drag tras mantener quieto este tiempo.
 *  400ms = plan v2 (F3): más margen que 260ms, SIN quiet-hold (menú táctil
 *  eliminado — "Duplicar" vive en el modal de edición). */
const LONG_PRESS_MS = 400;
const EDGE_ZONE = 56;        // franja activa de auto-scroll
const EDGE_SPEED = 12;       // px por frame

function safe(fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error('[drag-engine] hook error', err);
  }
}

function haptic(ms: number) {
  try { navigator.vibrate?.(ms); } catch { /* sin háptica */ }
}

/** Re-emisión de onMove (movimiento real y auto-scroll). */
function em(c: Gesture) {
  safe(() => c.hooks.onMove(c.target, c.lastX, c.lastY));
}

function preventContext(e: Event) {
  e.preventDefault();
  e.stopPropagation(); // M3: el oncontextmenu de la tarjeta no abre menú en Android
}

export function createDragEngine(opts: DragEngineOptions = {}) {
  const { ghostClass = '', scrollAxis, scrollContainer, quietHold } = opts;
  let g: Gesture | null = null;
  let raf = 0;

  const container = () => scrollContainer?.() ?? null;
  const isArmed = () => !!g?.started;

  // ── Fantasma ────────────────────────────────────────────────────────────
  function paintGhost() {
    if (!g?.ghost) return;
    const el = container();
    // Si el contenedor se desplazó, la tarjeta se movió con el contenido:
    // compensamos para que el fantasma siga bajo el dedo.
    const scrollDy = el ? el.scrollTop - g.scrollTop0 : 0;
    g.target.card.style.transform =
      `translateY(${g.lastY - g.startY + scrollDy}px) scale(1.03)`;
  }

  // ── Auto-scroll (M5) ────────────────────────────────────────────────
  function edgeTick() {
    const cur = g;
    if (!cur?.started || !scrollAxis) { raf = 0; return; }
    const el = container();
    if (el) {
      const r = el.getBoundingClientRect();
      const y = scrollAxis === 'y';
      const pos = y ? cur.lastY : cur.lastX;
      const min = y ? r.top : r.left;
      const max = y ? r.bottom : r.right;
      const before = y ? el.scrollTop : el.scrollLeft;
      const after = pos < min + EDGE_ZONE ? before - EDGE_SPEED
        : pos > max - EDGE_ZONE ? before + EDGE_SPEED : before;
      if (after !== before) {
        if (y) el.scrollTop = after; else el.scrollLeft = after;
        // Con el puntero quieto, el contenido se movió debajo: actualizar preview.
        // En el tope el navegador ignora el cambio (real === before): nada que
        // re-emitir, o computeLayoutForDrop correría a 60 fps con el dedo quieto.
        const real = y ? el.scrollTop : el.scrollLeft;
        if (real !== before) {
          paintGhost();
          em(cur);
        }
      }
    }
    raf = requestAnimationFrame(edgeTick);
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────────
  function activate() {
    const cur = g;
    if (!cur || cur.started) return;
    cur.started = true;
    clearTimeout(cur.armTimer);

    const { card } = cur.target;
    try { card.setPointerCapture(cur.pointerId); } catch { /* puntero ya liberado */ }

    if (!cur.isMouse) {
      // touch-action 'none' anula el scroll nativo mientras el gesto vive
      // (el CSS base pan-y/none de la tarjeta se recupera al limpiar).
      card.style.touchAction = 'none';
      window.addEventListener('contextmenu', preventContext, {
        capture: true,
        signal: cur.listeners.signal
      });
    }

    if (cur.ghost) {
      if (ghostClass) card.classList.add(ghostClass); // classList.add('') lanza
      haptic(10);
    }

    safe(() => cur.hooks.onActivate?.(cur.target));
    paintGhost();
    if (scrollAxis && !raf) raf = requestAnimationFrame(edgeTick);
  }

  /** Limpieza total del gesto (C2: corre SIEMPRE). No llama hooks. */
  function teardown(cur: Gesture) {
    clearTimeout(cur.armTimer);
    clearTimeout(cur.quietTimer);
    cur.listeners.abort(); // quita todos los listeners del gesto de una vez
    if (raf) { cancelAnimationFrame(raf); raf = 0; }

    if (cur.started) {
      const { card } = cur.target;
      if (cur.ghost) {
        if (ghostClass) card.classList.remove(ghostClass);
        card.style.transform = '';
      }
      if (!cur.isMouse) card.style.touchAction = '';
      try { card.releasePointerCapture(cur.pointerId); } catch { /* no capturado */ }
    }
    if (g === cur) g = null;
  }

  /** Punto único de cierre: drop (con coords) o cancel (null). */
  function end(drop: { x: number; y: number } | null) {
    const cur = g;
    if (!cur) return;
    teardown(cur);
    if (!cur.started) return; // tap corto: la vista hace click

    if (drop) {
      if (cur.ghost) haptic(8);
      // Tras un drag real, el click sintético que sigue al pointerup no abre la tarjeta.
      const kill = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
      window.addEventListener('click', kill, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', kill, true), 0);
      safe(() => cur.hooks.onDrop(cur.target, drop.x, drop.y));
    } else {
      safe(() => cur.hooks.onCancel?.(cur.target));
    }
  }

  function onQuietTimeout(cur: Gesture) {
    if (g !== cur || !cur.started || cur.maxDist > TOUCH_CANCEL_PX) return;
    const { target, hooks, lastX, lastY } = cur;
    teardown(cur);
    safe(() => hooks.onCancel?.(target)); // la vista restaura su estado antes del menú
    safe(() => quietHold!.onQuiet(target, lastX, lastY));
  }

  // ── Seguimiento ─────────────────────────────────────────────────────────
  function track(x: number, y: number) {
    const cur = g;
    if (!cur) return;
    // pointermove y touchmove pueden reportar el mismo punto: no duplicar onMove.
    if (cur.started && x === cur.lastX && y === cur.lastY) return;

    cur.lastX = x;
    cur.lastY = y;
    const dist = Math.hypot(x - cur.startX, y - cur.startY);
    if (dist > cur.maxDist) cur.maxDist = dist;

    if (!cur.started) {
      if (cur.isMouse) {
        if (dist > THRESHOLD_PX) activate();
      } else if (dist > TOUCH_CANCEL_PX) {
        teardown(cur); // mover antes del long-press = gesto de scroll
        return;
      }
      if (!isArmed()) return;
    }
    paintGhost();
    em(cur);
  }

  const isOurs = (e: PointerEvent) => !!g && e.pointerId === g.pointerId;

  function onPointerMove(e: PointerEvent) {
    if (isOurs(e)) track(e.clientX, e.clientY);
  }

  function onPointerUp(e: PointerEvent) {
    if (isOurs(e)) end({ x: e.clientX, y: e.clientY });
  }

  function onPointerCancel(e: PointerEvent) {
    if (isOurs(e)) end(null);
  }

  function onTouchMove(e: TouchEvent) {
    if (!isArmed()) return;
    if (e.cancelable) e.preventDefault(); // C1
    // Respaldo por si el navegador deja de emitir pointermove.
    if (e.touches.length === 1) track(e.touches[0].clientX, e.touches[0].clientY);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !g) return;
    if (g.started) {
      e.preventDefault();
      e.stopPropagation(); // que Esc no cierre además un modal padre
    }
    end(null);
  }

  function onBlur() {
    end(null); // alt-tab / cambio de app a mitad del gesto
  }

  // ── API pública ─────────────────────────────────────────────────────────
  /** Registra el inicio potencial de un drag. Devuelve false si se ignoró. */
  function begin(
    e: PointerEvent,
    target: DragTarget,
    hooks: DragHooks,
    o: BeginOptions = {}
  ): boolean {
    if (g) return false; // un gesto a la vez
    const isMouse = e.pointerType === 'mouse';
    if (isMouse && e.button !== 0) return false;

    const cur: Gesture = {
      target,
      hooks,
      pointerId: e.pointerId,
      isMouse,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      maxDist: 0,
      started: false,
      ghost: o.ghost ?? true,
      armTimer: 0,
      quietTimer: 0,
      scrollTop0: container()?.scrollTop ?? 0,
      listeners: new AbortController()
    };
    g = cur;

    const { signal } = cur.listeners;
    window.addEventListener('pointermove', onPointerMove, { signal });
    window.addEventListener('pointerup', onPointerUp, { signal });
    window.addEventListener('pointercancel', onPointerCancel, { signal });
    // C1: no pasivo es lo que permite preventDefault del scroll en el drag.
    window.addEventListener('touchmove', onTouchMove, { passive: false, signal });
    window.addEventListener('keydown', onKey, { signal });
    window.addEventListener('blur', onBlur, { signal });

    if (!isMouse) {
      cur.armTimer = window.setTimeout(() => {
        if (g === cur) activate();
      }, LONG_PRESS_MS);
      if (quietHold && o.quiet !== false) {
        cur.quietTimer = window.setTimeout(() => onQuietTimeout(cur), quietHold.ms);
      }
    }
    return true;
  }

  /** Gesto inmediato (resize): se arma al instante, sin umbral ni timer
   *  ni quiet-hold (el menú contextual no aplica a estirar). */
  function beginImmediate(
    e: PointerEvent,
    target: DragTarget,
    hooks: DragHooks,
    o: Omit<BeginOptions, 'quiet'> = {}
  ): boolean {
    if (!begin(e, target, hooks, { ...o, quiet: false })) return false;
    activate();
    return true;
  }

  return {
    begin,
    beginImmediate,
    /** ¿Hay un gesto armado en curso? (para guards de menú contextual). */
    active: isArmed,
    /** Cancela cualquier gesto activo/pendiente (desmontaje del componente). */
    destroy() {
      end(null);
    }
  };
}

export type DragEngine = ReturnType<typeof createDragEngine>;
