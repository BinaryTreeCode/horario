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
 *  - Auto-scroll del contenedor cerca de los bordes, eje configurable (M5).
 *  - Háptica: vibrate(10) al armar, vibrate(8) al soltar.
 *  - Cancelación garantizada (C2): pointercancel, Esc y desmontaje siempre
 *    limpian clase, transform y listeners — la tarjeta no queda fantasma.
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
  /** Movimiento con gesto armado (px de viewport). */
  onMove: (t: DragTarget, clientX: number, clientY: number) => void;
  /** Soltar con gesto armado → commit. */
  onDrop: (t: DragTarget, clientX: number, clientY: number) => void;
  /** Fin sin commit (cancel, Esc, desmontaje). */
  onCancel?: (t: DragTarget) => void;
}

interface Pending {
  target: DragTarget;
  hooks: DragHooks;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  started: boolean;
  ghost: boolean;
  timer: number | null;
}

const THRESHOLD_PX = 5;     // mouse: distancia para armar
const TOUCH_CANCEL_PX = 10; // táctil: movimiento pre-armado = scroll
const LONG_PRESS_MS = 260;
const EDGE_ZONE = 56;       // franja activa de auto-scroll
const EDGE_SPEED = 12;      // px por frame

export function createDragEngine(opts: {
  /** Clase que marca la tarjeta en pleno drag (estilo de fantasma). */
  ghostClass?: string;
  /** Eje del auto-scroll del contenedor (omitir = sin auto-scroll). */
  scrollAxis?: 'x' | 'y';
  scrollContainer?: () => HTMLElement | null;
  /**
   * Patrón iOS (G6): dedo TÁCTIL quieto `ms` desde el pointerdown → el drag
   * se cancela limpio y `onQuiet` abre el menú contextual. Mover el dedo más
   * que TOUCH_CANCEL_PX lo desarma (es scroll/drag, no menú). Solo táctil:
   * el mouse ya tiene click derecho.
   */
  quietHold?: { ms: number; onQuiet: (t: DragTarget, x: number, y: number) => void };
}) {
  const quiet = opts.quietHold;
  let quietTimer = 0;
  const ghostClass = opts.ghostClass ?? '';
  let p: Pending | null = null;
  let raf = 0;

  function preventContext(e: Event) {
    e.preventDefault();
    e.stopPropagation(); // M3: el oncontextmenu de la tarjeta no abre menú en Android
  }

  // M5: auto-scroll al arrastrar cerca de los bordes — sin esto no se puede
  // llevar una actividad a una hora/día fuera de pantalla en un solo gesto.
  function edgeTick() {
    if (!p?.started) { raf = 0; return; }
    const el = opts.scrollContainer?.() ?? null;
    if (el) {
      const r = el.getBoundingClientRect();
      if (opts.scrollAxis === 'y') {
        if (p.lastY < r.top + EDGE_ZONE) el.scrollBy(0, -EDGE_SPEED);
        else if (p.lastY > r.bottom - EDGE_ZONE) el.scrollBy(0, EDGE_SPEED);
      } else if (opts.scrollAxis === 'x') {
        if (p.lastX < r.left + EDGE_ZONE) el.scrollBy(-EDGE_SPEED, 0);
        else if (p.lastX > r.right - EDGE_ZONE) el.scrollBy(EDGE_SPEED, 0);
      }
    }
    raf = requestAnimationFrame(edgeTick);
  }
  function ensureEdgeScroll() {
    if (!raf && opts.scrollAxis && p?.started) raf = requestAnimationFrame(edgeTick);
  }
  function stopEdgeScroll() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  const LISTENERS: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointermove', onPointerMove as EventListener, { passive: false }],
    ['pointerup', onPointerUp as EventListener],
    ['pointercancel', onPointerCancel as EventListener],
    // C1: no pasivo es lo que permite preventDefault del scroll en el drag.
    ['touchmove', onTouchMove as EventListener, { passive: false }],
    ['keydown', onKey as EventListener]
  ];
  function addListeners() {
    for (const [n, fn, o] of LISTENERS) window.addEventListener(n, fn, o);
  }
  function removeListeners() {
    for (const [n, fn] of LISTENERS) window.removeEventListener(n, fn);
  }

  function activate() {
    if (!p || p.started) return;
    p.started = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    try { p.target.card.setPointerCapture(p.pointerId); } catch { /* noop */ }    if (p.ghost) {
      p.target.card.classList.add(ghostClass);
      if (p.pointerType !== 'mouse') {
        p.target.card.style.touchAction = 'none';
        window.addEventListener('contextmenu', preventContext, true);
      }
      navigator.vibrate?.(10); // háptica sutil: el drag se armó
    }
    p.hooks.onActivate?.(p.target);
    moveGhost(p.lastY);
    ensureEdgeScroll();
  }

  function moveGhost(clientY: number) {
    if (!p?.ghost) return;
    // Lift minimalista: el fantasma crece 3% — feedback de agarre sin ruido.
    // Al soltar, la transición base de transform lo asienta de vuelta a 1.
    p.target.card.style.transform = `translateY(${clientY - p.startY}px) scale(1.03)`;
  }

  function onPointerMove(e: PointerEvent) {
    if (!p) return;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (!p.started) {
      const dist = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
      if (p.pointerType === 'mouse') {
        if (dist > THRESHOLD_PX) activate();
      } else if (dist > TOUCH_CANCEL_PX) {
        abortPending(); // mover antes del long-press = gesto de scroll
        return;
      }
      if (!p || !p.started) return;
    }
    if (p.pointerType !== 'mouse') e.preventDefault();
    moveGhost(e.clientY);
    p.hooks.onMove(p.target, e.clientX, e.clientY);
  }

  function onTouchMove(e: TouchEvent) {
    if (!p?.started) return;
    if (e.cancelable) e.preventDefault();
    if (e.touches.length === 1) {
      // Sintetiza el seguimiento del ghost por si pointermove se pierde.
      onPointerMove(e.touches[0] as unknown as PointerEvent);
    }
  }

  /** Punto único de cierre: drop (pointerup) o cancel (Esc/cancel/desmontaje). */
  function end(e: PointerEvent | null, dropped: boolean) {
    if (!p) return;
    if (!p.started) { abortPending(); return; } // tap corto: la vista hace click
    const { target: t, hooks, ghost } = p;
    finish(t, ghost);
    p = null;
    if (dropped) {
      if (ghost) navigator.vibrate?.(8); // háptica: el drop se registró
      hooks.onDrop(t, e!.clientX, e!.clientY);
    } else {
      hooks.onCancel?.(t);
    }
  }
  function onPointerUp(e: PointerEvent) { end(e, true); }
  function onPointerCancel() { end(null, false); }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (p?.started) end(null, false);
    else abortPending();
  }

  /** Limpieza visual + listeners (C2: corre SIEMPRE, error o no). */
  function finish(t: DragTarget, ghost: boolean) {
    clearQuiet();
    if (ghost) {
      t.card.classList.remove(ghostClass);
      t.card.style.transform = '';
      t.card.style.touchAction = '';
      window.removeEventListener('contextmenu', preventContext, true);
    }
    removeListeners();
    stopEdgeScroll();
  }

  function clearQuiet() {
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = 0; }
  }

  function abortPending() {
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    clearQuiet();
    removeListeners();
    p = null;
  }

  return {
    /** Registra el inicio potencial de un drag (arma por umbral/long-press). */
    begin(
      e: PointerEvent,
      target: DragTarget,
      hooks: DragHooks,
      o: { ghost?: boolean; quiet?: boolean } = {}
    ) {
      if (p) return; // un gesto a la vez
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      p = {
        target,
        hooks,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
      started: false,
      ghost: o.ghost ?? true,
      timer: null
    };
      addListeners();
      if (e.pointerType !== 'mouse') {
        p.timer = window.setTimeout(() => {
          if (p && !p.started) activate();
        }, LONG_PRESS_MS);
        if (quiet && o.quiet !== false) {
          clearQuiet();
          quietTimer = window.setTimeout(() => {
            quietTimer = 0;
            // Quiet solo cuenta con el dedo quieto: si el drag armado movió
            // más que el umbral, es un drag, no un menú.
            if (!p?.started) return;
            const moved = Math.hypot(p.lastX - p.startX, p.lastY - p.startY);
            if (moved > TOUCH_CANCEL_PX) return;
            const t = p.target;
            const x = p.lastX;
            const y = p.lastY;
            const hooks = p.hooks;
            const ghost = p.ghost;
            finish(t, ghost);
            p = null;
            hooks.onCancel?.(t); // la vista restaura su estado antes del menú
            quiet.onQuiet(t, x, y);
          }, quiet.ms);
        }
      }
    },
    /** Gesto inmediato (resize): se arma al instante, sin umbral ni timer
     *  ni quiet-hold (el menú contextual no aplica a estirar). */
    beginImmediate(
      e: PointerEvent,
      target: DragTarget,
      hooks: DragHooks,
      o: { ghost?: boolean } = {}
    ) {
      this.begin(e, target, hooks, { ...o, quiet: false });
      activate();
    },
    /** ¿Hay un gesto armado en curso? (para guards de menú contextual). */
    active(): boolean {
      return !!p?.started;
    },
    /** Cancela cualquier gesto activo/pendiente (desmontaje del componente). */
    destroy() {
      end(null, false);
    }
  };
}
