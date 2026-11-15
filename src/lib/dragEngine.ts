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
  /** Eje(s) del auto-scroll (omitir = sin auto-scroll). 'both' = X en el
   *  contenedor y Y en el contenedor o, si ese no scrollea en vertical, en la
   *  PÁGINA (caso de Día y Semana, donde mide 1600–2900px y scrollea window). */
  scrollAxis?: 'x' | 'y' | 'both';
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
  /**
   * Háptica al armar/soltar. Por defecto sigue a `ghost` (las vistas que
   * delegan el fantasma en el motor ya vibraban); las que pintan su propio
   * clon pasan `{ ghost: false, haptic: true }` y conservan la vibración.
   */
  haptic?: boolean;
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
  /** Último sentido del movimiento por eje (-1, 0, 1). El auto-scroll NUNCA
   *  va contra el gesto: si el dedo va hacia la izquierda, el borde derecho no
   *  arrastra la grilla al revés (anulaba el arrastre; ver edgeTick). */
  dirX: number;
  dirY: number;
  /** Máxima distancia alcanzada desde el inicio (no la actual). */
  maxDist: number;
  started: boolean;
  ghost: boolean;
  /** Vibración efectiva al armar/soltar (ver BeginOptions.haptic). */
  haptic: boolean;
  armTimer: number;
  quietTimer: number;
  /** scrollTop del contenedor al empezar: compensa el fantasma en auto-scroll. */
  scrollTop0: number;
  /** scrollY de la PÁGINA al empezar: el fantasma (tarjeta in-flow en la vista
   *  Día) se desliza con el documento si la página scrollea a mitad del gesto
   *  — sin compensar, la sombra/transform queda "atrás" del cursor. */
  pageY0: number;
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

/**
 * Paso de auto-scroll de UN eje, en px/frame (negativo = atrás/arriba).
 * `min`/`max` son la intersección VISIBLE del scroller (o del viewport en el
 * fallback de página), no su rect completo: con la grilla de 1600px el borde
 * de abajo cae fuera de pantalla y el puntero nunca llegaba a esa franja.
 * Si el carril visible no supera las dos franjas (pantalla enana, scroller
 * casi oculto) devuelve 0: no hay zona "central" que respetar.
 */
export function calcularPasoAutoScroll(
  pos: number,
  min: number,
  max: number,
  edgeZone = EDGE_ZONE,
  speed = EDGE_SPEED
): number {
  if (max - min <= edgeZone * 2) return 0;
  if (pos < min + edgeZone) return -speed;
  if (pos > max - edgeZone) return speed;
  return 0;
}

function safe(fn: () => void) {
  try {
    const r = fn();
    // Los hooks onDrop son async: un rechazo (BD ocupada, fila huérfana tras
    // un import…) era una promesa rechazada que NADIE recogía → el gesto
    // quedaba a medio cerrar (tarjeta fantasma pegada, vista "congelada":
    // "el drag and drop se rompe y no me deja avanzar"). Se captura aquí.
    if (r && typeof (r as Promise<void>).catch === 'function') {
      (r as Promise<void>).catch(err => console.error('[drag-engine] hook async error', err));
    }
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
    // Compensar AMBOS scrolls: el del contenedor (auto-scroll del motor) y el
    // de la PÁGINA (rueda del usuario a mitad del gesto) — la tarjeta fantasma
    // vive en el flujo del documento y ambos la deslizan bajo el cursor.
    const scrollDy = el ? el.scrollTop - g.scrollTop0 : 0;
    const pageDy = window.scrollY - g.pageY0;
    g.target.card.style.transform =
      `translateY(${g.lastY - g.startY + scrollDy + pageDy}px) scale(1.03)`;
  }

  // ── Auto-scroll (M5) ────────────────────────────────────────────────
  /** ¿El paso de auto-scroll empuja en contra del último movimiento del dedo?
   *  Con el puntero quieto (dir 0) se deja seguir: sostener el dedo en el borde
   *  es la forma clásica de seguir scrolleando. */
  function contraElGesto(paso: number, dir: number): boolean {
    return paso !== 0 && dir !== 0 && Math.sign(paso) !== Math.sign(dir);
  }

  /** ¿El contenedor es un scroller vertical REAL (con recorrido y overflow)? */
  function scrolleaVertical(el: HTMLElement): boolean {
    if (el.scrollHeight <= el.clientHeight + 20) return false;
    return /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  }

  function edgeTick() {
    const cur = g;
    if (!cur?.started || !scrollAxis) { raf = 0; return; }
    const el = container();
    let movio = false;

    // ── Eje X: el contenedor scrollea en horizontal (grilla de la semana) ──
    if ((scrollAxis === 'x' || scrollAxis === 'both') && el) {
      if (el.scrollWidth > el.clientWidth + 1) {
        const r = el.getBoundingClientRect();
        // Solo la parte visible: el rect completo puede salirse del viewport.
        const min = Math.max(r.left, 0);
        const max = Math.min(r.right, window.innerWidth);
        const paso = calcularPasoAutoScroll(cur.lastX, min, max);
        if (paso !== 0 && !contraElGesto(paso, cur.dirX)) {
          const before = el.scrollLeft;
          el.scrollLeft = before + paso;
          // En el tope el navegador ignora el cambio: nada que re-emitir, o
          // onMove correría a 60 fps con el dedo quieto.
          if (el.scrollLeft !== before) movio = true;
        }
      }
    }

    // ── Eje Y ──────────────────────────────────────────────────────────────
    if (scrollAxis === 'y' || scrollAxis === 'both') {
      let desplazado = false;
      // 1) Contenedor con scroll vertical propio (si existe y tiene recorrido).
      if (el && scrolleaVertical(el)) {
        const r = el.getBoundingClientRect();
        const min = Math.max(r.top, 0);
        const max = Math.min(r.bottom, window.innerHeight);
        const paso = calcularPasoAutoScroll(cur.lastY, min, max);
        if (paso !== 0 && !contraElGesto(paso, cur.dirY)) {
          const before = el.scrollTop;
          el.scrollTop = before + paso;
          desplazado = el.scrollTop !== before;
        }
      }
      // 2) Fallback: scrollea el DOCUMENTO (Día y Semana). Los bordes son los
      //    del viewport, no los del contenedor de 1600px que se sale abajo.
      if (!desplazado) {
        const paso = calcularPasoAutoScroll(cur.lastY, 0, window.innerHeight);
        if (paso !== 0 && !contraElGesto(paso, cur.dirY)) {
          const prevWinY = window.scrollY;
          window.scrollBy({ top: paso, behavior: 'instant' as ScrollBehavior });
          if (window.scrollY !== prevWinY) movio = true;
        }
      } else {
        movio = true;
      }
    }

    // Con el puntero quieto, el contenido se movió debajo: actualizar preview.
    if (movio) {
      paintGhost();
      em(cur);
      // onMove puede haber cerrado el gesto (drop por hook): no re-armar el loop.
      if (!g) { raf = 0; return; }
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

    if (cur.ghost && ghostClass) card.classList.add(ghostClass); // add('') lanza
    if (cur.haptic) haptic(10);

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
      if (cur.haptic) haptic(8);
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

    // Sentido del movimiento ANTES de mover el cursor: lo usa el auto-scroll
    // para no empujar la vista en contra del gesto.
    cur.dirX = Math.sign(x - cur.lastX);
    cur.dirY = Math.sign(y - cur.lastY);
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

  /** Scroll a mitad del gesto (rueda, barra, auto-scroll ajeno): el contenido
   *  se movió bajo el puntero → re-pintar fantasma y re-emitir onMove para que
   *  el preview se recalcule con rects frescos (si no, queda congelado con la
   *  geometría previa al scroll y el feedback "se pierde" al deslizar). */
  function onScroll() {
    const cur = g;
    if (!cur?.started) return;
    paintGhost();
    em(cur);
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
      dirX: 0,
      dirY: 0,
      maxDist: 0,
      started: false,
      ghost: o.ghost ?? true,
      // Efectivo: si la vista no opina, vibra cuando hay fantasma del motor.
      haptic: o.haptic ?? (o.ghost ?? true),
      armTimer: 0,
      quietTimer: 0,
      scrollTop0: container()?.scrollTop ?? 0,
      pageY0: window.scrollY,
      listeners: new AbortController()
    };
    g = cur;

    const { signal } = cur.listeners;
    window.addEventListener('pointermove', onPointerMove, { signal });
    window.addEventListener('pointerup', onPointerUp, { signal });
    window.addEventListener('pointercancel', onPointerCancel, { signal });
    // Captura en fase de captura: el scroll de CUALQUIER contenedor (página,
    // grilla, track) re-ancla el gesto a la geometría nueva.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true, signal });
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
