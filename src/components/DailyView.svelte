<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, getActivityColor, formatTime, format12h } from '../lib/stores';
  import { resolveDayCascade, resolveResizeDay } from '../lib/cascade';
  import { createDragEngine, type DragHooks, type DragTarget } from '../lib/dragEngine';
  import { Clock, Edit3, Copy, Trash2, ListChecks, RotateCcw, Save, Calendar, Zap, ImageIcon, Plus, ChevronLeft, ChevronRight } from '@lucide/svelte';
  import { db, newId } from '../lib/db';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import ImageLightbox from './ImageLightbox.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr, toastErrRepetido } from '../lib/toast';
  import { portal } from '../lib/portal';
  import { t, tNow } from '../lib/i18n';
  import { pushUndo, cloneAct } from '../lib/undo';

  interface Props {
    day: number;
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    dayOverrides?: DayOverride[];
    onEditActivity: (id: string | null, initialData?: Activity) => void;
    onNavigateDay: (dir: -1 | 1) => void;
  }

  let { day, activities, categories, settings, dayOverrides = [], onEditActivity, onNavigateDay }: Props = $props();

  /**
   * Tap en un slot vacío del track (G4): abre el modal de creación con la hora
   * precargada según el punto tocado. Se ignora si el tap fue sobre una tarjeta
   * o menú; tras un drag, el motor ya suprime el click sintético por su cuenta.
   */
  function handleTrackTap(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.daily-activity-card, .context-menu, button')) return;
    onEditActivity(null, buildDraftAt(hourAtY(e, e.currentTarget as HTMLElement)));
  }

  /** y de un evento del mouse → hora snap-a-15min dentro del rango visible. */
  function hourAtY(e: MouseEvent, track: HTMLElement): number {
    const rect = track.getBoundingClientRect();
    const yPercent = (e.clientY - rect.top) / rect.height;
    const hour = startHour + yPercent * (endHour - startHour);
    return Math.max(startHour, Math.min(Math.round(hour * 4) / 4, endHour - 0.25));
  }

  /** Hora decimal (4.5) → "HH:MM" para el label del menú. */
  function horasAHoraReloj(hour: number): string {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  /** Draft de actividad nueva que arranca a `hour` (fin = +60 min, normalizado). */
  function buildDraftAt(hour: number): Activity {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    const fmt = (v: number) => v.toString().padStart(2, '0');
    const endTotal = h * 60 + m + 60;
    return {
      id: '',
      categoryId: categories[0]?.id ?? 'rutina',
      name: '',
      description: '',
      image: null,
      startTime: `${fmt(h)}:${fmt(m)}`,
      endTime: `${fmt(Math.floor(endTotal / 60) % 24)}:${fmt(endTotal % 60)}`,
      daysOfWeek: [day],
      steps: [],
      updatedAt: 0,
    } as unknown as Activity;
  }

  const DAY_NAMES = $derived([0, 1, 2, 3, 4, 5, 6].map(i => $t(`day.${i}`)));
  const dayName = $derived(DAY_NAMES[day]);
  // Señalización: ¿el día mostrado es hoy? Mismo mapeo que WeeklyGrid:
  // la semana de la app arranca en Lunes (índice 0) y getDay() da Domingo=0.
  const esHoy = $derived.by(() => {
    const d = new Date().getDay();
    const hoy = d === 0 ? 6 : d - 1;
    return day === hoy;
  });
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);

  // Mode: isTemporaryMode means edits are temporary for this day only and don't touch master schedule
  let isTemporaryMode = $state(true);

  const currentOverride = $derived(dayOverrides.find(o => o.day === day));
  const hasOverride = $derived(!!currentOverride && currentOverride.activities !== undefined);

  // Activities to display for this day: use override if active, else master activities
  const dayActivities = $derived(
    isTemporaryMode && hasOverride
      ? currentOverride!.activities
      : activities.filter((a: Activity) => a.daysOfWeek.includes(day))
  );

  // Time bar state
  let now = $state(new Date());
  let interval: any;

  onMount(() => {
    interval = setInterval(() => {
      now = new Date();
    }, 60000);
  });

  // Desmontaje a mitad de drag/gesto: sin esto, los listeners de window
  // quedan colgados y referencian nodos muertos. El motor limpia todo (C2).
  onDestroy(() => {
    clearInterval(interval);
    engine.destroy();
  });

  // ── Estado del drag (leído por layoutActivities y los hooks del motor) ──
  let dragOffsetHours = 0;
  let grabClientY = 0; // punto de agarre (px) — lo usa onActivate del motor
  let draggedActivityId = $state<string | null>(null);
  // (La supresión del click sintético post-drag vive en el motor.)
  /**
   * Vista previa del layout durante el drag: id → {start, end} en horas.
   * No toca la BD — solo alimenta a layoutActivities para que las tarjetas
   * vecinas se deslicen (transition CSS) hacia su posición predicha.
   * null = sin drag activo.
   */
  let dropPreview = $state<Map<string, { start: number; end: number }> | null>(null);
  /** Drop inválido: no cabe / pisaría — tarjeta roja y al soltar vuelve. */
  let dragInvalid = $state(false);
  /** Shake one-shot: se enciende SOLO en la transición válido→inválido y se
   *  limpia en animationend. Pegarlo a .drop-invalid reiniciaría la anima-
   *  ción en cada pointermove cerca del límite = zumbido frenético (y con
   *  el shake moviendo el bloque, el :hover titila = salto de z-index). */
  let shakeInvalid = $state(false);
  /** Tarjeta que sacude el shake: por ID y separado del drag — al soltar un
   *  drop rechazado el id de drag ya se limpió y sin esto el rechazo no
   *  dejaría rastro visible ("el drag se rompió y no pasa nada"). */
  let shakeId = $state<string | null>(null);
  let shakeTimer: ReturnType<typeof setTimeout> | null = null;
  function setInvalid(v: boolean) {
    if (v && !dragInvalid) {
      shakeInvalid = true;
      if (shakeTimer) clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => { shakeInvalid = false; }, 350); // respaldo si animationend no corre
    } else if (!v) {
      shakeInvalid = false;
      if (shakeTimer) { clearTimeout(shakeTimer); shakeTimer = null; }
    }
    dragInvalid = v;
  }
  /** Rótulo del gesto dentro del fantasma: qué hará el drop. */
  let dragHint = $state('');
  /** Ventana de la entrada escalonada: SOLO al cambiar de día (el {#key day}
   *  re-monta las tarjetas). Sin esta gate, alternar animation via la clase
   *  track-dragging reinicia fadeIn en cada drop/cancel = flash de entrada
   *  en toda la columna (cambiar animation-name relanza la animación). */
  let entradaDia = $state(false);
  $effect(() => {
    void day; // dependencia: re-corre en cada cambio de día
    entradaDia = true;
    const t = setTimeout(() => { entradaDia = false; }, 600); // cubre delays hasta 100ms + 250ms de fadeIn
    return () => clearTimeout(t);
  });
  /** Firma del último preview publicado: si no cambió por CONTENIDO, no se
   *  reasigna dropPreview (las transiciones CSS no se relanzan → cero
   *  parpadeo). Mismo patrón que la vista Semana. */
  let firmaPreview = '';
  /**
   * Ancla temporal de la tarjeta recién soltada/estirada: mientras la store
   * re-emite, su layout viene de aquí (slot final) — así la transición CSS
   * la lleva desde el fantasma hasta su slot, sin teletransporte.
   */
  let topOverride = $state<{ id: string; start: number; end: number } | null>(null);
  /** Pulso verde de confirmación (flash-commit) sobre el bloque recién soltado. */
  let flashId = $state<string | null>(null);
  type Slot = { id: string; start: number; end: number };
  const toSlotMap = (slots: Slot[]) => new Map(slots.map(s => [s.id, { start: s.start, end: s.end }]));
  /** Doble rAF con fallback por timeout: la store re-emite y el navegador
   *  pinta antes de soltar el ancla. En navegadores embebidos el rAF puede
   *  venir throttled (no corre en absoluto) y el ancla/zona verde quedarían
   *  pegadas para siempre — el timeout garantiza la limpieza. */
  const settle2 = (fn: () => void) => {
    let done = false;
    const run = () => { if (!done) { done = true; fn(); } };
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 160);
  };

  const engine = createDragEngine({
    ghostClass: 'dragging',
    scrollAxis: 'y',
    scrollContainer: () => document.querySelector('.daily-container')
    // quiet-hold (G6) eliminado en F3: el dedo quieto ya no cancela el drag
    // ni abre menú — era la causa de arrastres "trabados".
  });

  const currentMinutes = $derived(now.getHours() * 60 + now.getMinutes());
  const startMinutes = $derived(startHour * 60);
  const endMinutes = $derived(endHour * 60);

  const barTopPercent = $derived(((currentMinutes - startMinutes) / (endMinutes - startMinutes)) * 100);
  const isNowInRange = $derived(currentMinutes >= startMinutes && currentMinutes <= endMinutes);

  interface DailyLayoutItem extends Activity {
    top: string;
    height: string;
    left: string;
    width: string;
    durationMins: number;
  }

  const layoutActivities = $derived((() => {
    // Durante un drag, las horas efectivas de las VECINAS vienen del preview
    // (se deslizan hacia su posición predicha vía transition CSS); la tarjeta
    // arrastrada no: mantiene su top original y sigue al cursor solo con el
    // transform del fantasma (si el preview también la moviera, top + transform
    // se sumarían y saldría disparada del cursor).
    const preview = dropPreview;
    const anchor = topOverride;
    const acts = dayActivities.map(a => {
      // topOverride (tarjeta recién soltada) > preview (vecinas durante drag)
      // > BD. La tarjeta en pleno drag no recibe ninguno: sigue al cursor vía
      // transform del fantasma; si también moviéramos su top, top + transform
      // se sumarían y saldría disparada del cursor.
      if (anchor && a.id === anchor.id) {
        return { ...a, _start: anchor.start, _end: anchor.end };
      }
      const p = a.id === draggedActivityId ? undefined : preview?.get(a.id!);
      return {
        ...a,
        _start: p ? p.start : parseTime(a.startTime),
        _end: p ? p.end : parseTime(a.endTime)
      };
    }).sort((a, b) => a._start - b._start || (b._end - b._start) - (a._end - a._start));

    if (acts.length === 0) return [] as DailyLayoutItem[];

    // En pleno drag la tarjeta arrastrada NO participa en clusters/tracks:
    // es un fantasma (sigue al cursor vía transform). Si contara como
    // posicionada, una vecina que se deslice a su hueco original la solaparía
    // y el algoritmo partiría el día en 2 columnas (ancho/posición cambiados).
    const dragId = draggedActivityId;
    const activeDrag = dragId !== null && !anchor;
    const layoutable = activeDrag ? acts.filter(a => a.id !== dragId) : acts;

    const clusters: (typeof layoutable)[] = [];
    let currentCluster: typeof acts = [];
    let clusterEnd = -1;

    for (const act of layoutable) {
      if (currentCluster.length === 0 || act._start < clusterEnd - 0.0001) {
        currentCluster.push(act);
        clusterEnd = Math.max(clusterEnd, act._end);
      } else {
        clusters.push(currentCluster);
        currentCluster = [act];
        clusterEnd = act._end;
      }
    }
    if (currentCluster.length > 0) clusters.push(currentCluster);

    const result: DailyLayoutItem[] = [];

    for (const cluster of clusters) {
      const tracks: number[] = [];
      const assignments: { act: typeof acts[0]; track: number }[] = [];

      for (const act of cluster) {
        let assigned = -1;
        for (let t = 0; t < tracks.length; t++) {
          if (tracks[t] <= act._start + 0.0001) {
            assigned = t;
            tracks[t] = act._end;
            break;
          }
        }
        if (assigned === -1) {
          assigned = tracks.length;
          tracks.push(act._end);
        }
        assignments.push({ act, track: assigned });
      }

      const numTracks = Math.max(1, tracks.length);
      for (const item of assignments) {
        const s = item.act._start;
        const e = item.act._end;
        const top = ((s - startHour) / totalHours) * 100;
        const height = ((e - s) / totalHours) * 100;
        const widthPct = 100 / numTracks;
        const leftPct = item.track * widthPct;
        const durationMins = Math.round((e - s) * 60);

        result.push({
          ...item.act,
          top: `${top}%`,
          height: `calc(${height}% - 3px)`,
          left: `${leftPct}%`,
          width: numTracks > 1 ? `calc(${widthPct}% - 4px)` : '100%',
          durationMins
        });
      }
    }

    // El fantasma se dibuja a ancho completo en su slot original (el cursor
    // lo transporta); al soltar, topOverride lo ancla a su slot final.
    if (activeDrag) {
      const d = acts.find(a => a.id === dragId);
      if (d) {
        const top = ((d._start - startHour) / totalHours) * 100;
        const height = ((d._end - d._start) / totalHours) * 100;
        result.push({
          ...d,
          top: `${top}%`,
          height: `calc(${height}% - 3px)`,
          left: '0%',
          width: '100%',
          durationMins: Math.round((d._end - d._start) * 60)
        });
      }
    }

    return result;
  })());

  // ── Temporary mode helpers ──────────────────────────────────────────────

  /** Ensure a dayOverride exists for the current day. Returns a mutable copy of the activities. */
  async function ensureOverride(): Promise<Activity[]> {
    const existing = dayOverrides.find(o => o.day === day);
    if (existing && existing.activities) {
      return existing.activities.map(a => ({ ...a }));
    }
    // Initialize from master schedule
    const masterActs = activities
      .filter(a => a.daysOfWeek.includes(day))
      .map(a => ({ ...a }));
    await db.dayOverrides.put({
      day,
      activities: masterActs,
      updatedAt: Date.now()
    });
    return masterActs;
  }

  async function restoreDefaultTemplate() {
    if (!currentOverride) return;
    confirmRestore = true;
  }

  async function doRestoreDefault() {
    await db.dayOverrides.delete(day);
    toastOk(tNow('toast.templateRestored'));
  }

  async function saveAsPermanentTemplate() {
    if (!currentOverride?.activities) return;
    confirmSavePermanent = true;
  }

  async function doSavePermanent() {
    if (!currentOverride?.activities) return;

    const overrideActs = currentOverride.activities;

    // Get current master activities for this day
    const masterDayActs = activities.filter(a => a.daysOfWeek.includes(day));

    // Remove this day from all master activities that had it
    for (const act of masterDayActs) {
      const newDays = act.daysOfWeek.filter(d => d !== day);
      if (newDays.length === 0) {
        await db.activities.update(act.id!, { deletedAt: Date.now(), updatedAt: Date.now() });
      } else {
        await db.activities.update(act.id!, { daysOfWeek: newDays, updatedAt: Date.now() });
      }
    }

    // Add override activities as new master activities assigned to this day
    for (const act of overrideActs) {
      const { id: _, ...clone } = act;
      clone.daysOfWeek = [day];
      clone.id = newId(); // sin id, add() falla con DataError (PK 'id' sin autoincrement)
      await db.activities.add(clone);
    }

    // Remove the override since it's now the master
    await db.dayOverrides.delete(day);
    toastOk(tNow('toast.appliedWeek'));
  }

  let confirmDelete = $state(false);
  let confirmRestore = $state(false);
  let confirmSavePermanent = $state(false);

  // ── Drag & Drop: la mecánica vive en src/lib/dragEngine.ts (dueño único,
  // compartida con la vista Semana). Aquí solo la semántica de la vista. ──

  /** Calcula el offset del punto de agarre dentro de la tarjeta, en horas. */
  function grabOffsetHours(card: HTMLElement, activity: Activity, clientY: number): number {
    const cardRect = card.getBoundingClientRect();
    const durH = parseTime(activity.endTime) - parseTime(activity.startTime);
    return ((clientY - cardRect.top) / cardRect.height) * durH;
  }

  /** Ancla del gesto de estirado: lado, origen/fin originales + punto de agarre. */
  interface ResizeMeta {
    lado: 'arriba' | 'abajo';
    origStart: number;
    origEnd: number;
    startY: number;
  }

  const dragHooks: DragHooks = {
    onActivate(t) {
      const activity = dayActivities.find(a => a.id === t.activityId);
      if (!activity) return;
      dragOffsetHours = grabOffsetHours(t.card, activity, grabClientY);
      // El layout (y el preview) leen este id: excluye la tarjeta del
      // clustering mientras es fantasma.
      draggedActivityId = t.activityId;
      firmaPreview = '';
    },
    onMove(_t, _x, clientY) {
      if (draggedActivityId === null || !engine.active()) return;
      // Layout predicho: las vecinas se deslizan en vivo vía su transition CSS
      // de top/height. Inválido → SIN preview (nada se desliza): la tarjeta va
      // roja y al soltar el bloque vuelve a su sitio.
      const res = computeLayoutForDrop(clientY, draggedActivityId);
      if (!res) return;
      setInvalid(!res.valido);
      dragHint = !res.valido ? '⛔ ' + $t('toast.noFit') : res.accion === 'insertar' ? '↕ ' + $t('dayView.insertHere') : '';
      // (El resalte de mitad del pisado se retiró: el feedback de posición
      // vive en la tarjeta flotante — hora proyectada + acción del drop.)
      // Anti-parpadeo: solo reasignar dropPreview si el layout cambió por
      // CONTENIDO (firma). Reasignar un Map idéntico en cada pointermove
      // relanza las transiciones CSS = parpadeo.
      const firma = res.valido ? res.slots.map(s => `${s.id}@${s.start}-${s.end}`).join('|') : 'null';
      if (firma !== firmaPreview) {
        firmaPreview = firma;
        dropPreview = res.valido ? toSlotMap(res.slots) : null;
      }
    },
    async onDrop(t, _x, clientY) {
      const res = computeLayoutForDrop(clientY, t.activityId);
      if (!res || !res.valido) {
        // ⛔ Sin reemplazos ni huecos imposibles: el bloque vuelve a su sitio.
        // Toast SIEMPRE con el motivo (toastErrRepetido avisa desde el 1er
        // fallo): con el día lleno casi todo movimiento desborda y el
        // silencio se siente como "el drag se rompió". Además el shake corre
        // UNA vez tras soltar: el rojo del drag desaparece con el fantasma y
        // sin este one-shot el rechazo no deja rastro visible.
        if (res) toastErrRepetido(`mover-dia:${day}`, res.motivo);
        draggedActivityId = null;
        dropPreview = null;
        setInvalid(false);
        // Shake one-shot sobre la TARJETA (por id, no por estado de drag):
        // el rechazo deja rastro visible tras soltar. Fallback por si
        // animationend no corre.
        shakeInvalid = true;
        shakeId = t.activityId;
        if (shakeTimer) clearTimeout(shakeTimer);
        shakeTimer = setTimeout(() => { shakeInvalid = false; shakeId = null; }, 400);
        dragHint = '';
        firmaPreview = '';
        return;
      }
      // El preview muere ANTES de limpiar draggedActivityId: las vecinas
      // conservan el layout final (la store aún no re-emitio), así no saltan.
      dropPreview = toSlotMap(res.slots);
      // Anclamos la tarjeta arrastrada a SU slot final: se asienta con la
      // transición CSS desde donde estaba el fantasma, sin teletransporte.
      draggedActivityId = t.activityId;
      topOverride = { id: t.activityId, start: res.movido.start, end: res.movido.end };
      flashId = t.activityId;
      try {
        await commitDropAt(dropPreview);
      } finally {
        // Si la store re-emitio el mismo layout, soltar el ancla es
        // inobservable; si el commit falló, esto devuelve la UI a la BD.
        settle2(() => { dropPreview = null; topOverride = null; setInvalid(false); dragHint = ''; firmaPreview = ''; flashId = null; });
      }
    },
    onCancel() {
      // C2: reset completo — sin esto la tarjeta queda fantasma (fuera de
      // columnas, ancho completo) hasta el siguiente arrastre.
      draggedActivityId = null;
      dropPreview = null;
      topOverride = null;
      setInvalid(false);
      dragHint = '';
      firmaPreview = '';
    }
  };

  function handlePointerDown(e: PointerEvent, activity: Activity) {
    grabClientY = e.clientY;
    // El motor arma: mouse por umbral (5px), táctil por long-press (260ms).
    engine.begin(e, { card: e.currentTarget as HTMLElement, activityId: activity.id! }, dragHooks);
  }

  /**
   * Resolución de colisiones (cascada push-down) para un clientY dado.
   * Delega en src/lib/cascade.ts (dueño único de la matemática, compartida
   * con la vista Semana). Devuelve el mapa id → {start, end} SIN tocar la BD.
   */
  function computeLayoutForDrop(clientY: number, draggedId: string | null) {
    const track = document.querySelector('.activities-track');
    if (!track || draggedId === null) return null;

    const rect = track.getBoundingClientRect();
    const yPercent = (clientY - rect.top) / rect.height;
    // Hora CRUDA del dedo: decide hueco vs mitades (antes/después). Sin snap
    // ni offset de agarre: la mitad del pisado se lee del punto real.
    const fingerHour = startHour + yPercent * totalHours;

    const activity = dayActivities.find(a => a.id === draggedId);
    if (!activity) return null;

    const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
    let newStartHour = startHour + yPercent * totalHours - dragOffsetHours;
    newStartHour = Math.round(newStartHour * 4) / 4; // snap 15 min
    newStartHour = Math.max(startHour, Math.min(newStartHour, endHour - duration));

    // Cascada sobre el día visible (compartida con la Semana). Los slots
    // incluyen al arrastrado en su posición ORIGINAL: la rotación del tramo
    // lo reubica (reempaquetar preserva duraciones y huecos del tramo).
    const slots = dayActivities.map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    return resolveDayCascade(
      slots,
      { id: draggedId, start: newStartHour, end: newStartHour + duration },
      fingerHour,
      false,
      startHour,
      endHour
    );
  }



  // ── Resize (estirar borde inferior) ──────────────────────────────────
  // Mismo motor, gesto inmediato y sin fantasma: la tarjeta crece por su
  // topOverride y las vecinas se deslizan por dropPreview (igual que en drag).
  const resizeHooks: DragHooks = {
    onActivate(t) {
      draggedActivityId = t.activityId; // excluye la tarjeta del clustering
      firmaPreview = '';
      flashId = null;
    },
    onMove(t, _x, clientY) {
      const res = computeResizePreview(clientY, t.activityId, t.meta as ResizeMeta);
      if (!res) return;
      setInvalid(!res.valido);
      // F4: feedback de por qué topó el borde (el deseo del puntero se acotó).
      dragHint = res.limitadoPor ? `↕ ${tNow('dayView.limitedBy', { what: res.limitadoPor })}` : '';
      topOverride = { id: t.activityId, start: res.movido.start, end: res.movido.end };
      dropPreview = toSlotMap(res.slots);
    },
    async onDrop(t, _x, clientY) {
      const res = computeResizePreview(clientY, t.activityId, t.meta as ResizeMeta);
      draggedActivityId = null;
      if (res && res.valido) {
        await commitResolved(toSlotMap(res.slots));
      } else if (res) {
        // Puerta de repetición: 1er fallo silencioso, al insistir → toast.
        toastErrRepetido(`estirar-dia:${day}`, res.motivo);
      }
      settle2(() => { dropPreview = null; topOverride = null; setInvalid(false); dragHint = ''; firmaPreview = ''; });
    },
    onCancel() {
      draggedActivityId = null;
      dropPreview = null;
      topOverride = null;
      setInvalid(false);
      dragHint = '';
      firmaPreview = '';
    }
  };

  function startResize(e: PointerEvent, activity: Activity, lado: 'arriba' | 'abajo') {
    e.stopPropagation(); // no iniciar drag de la tarjeta ni su click
    engine.beginImmediate(
      e,
      { card: e.currentTarget as HTMLElement, activityId: activity.id!, meta: { lado, origStart: parseTime(activity.startTime), origEnd: parseTime(activity.endTime), startY: e.clientY } satisfies ResizeMeta },
      resizeHooks,
      { ghost: false }
    );
  }

  /** Slots del día tras estirar hasta clientY (cascada compartida, snap 15min).
   *  'abajo' conserva el inicio; 'arriba' conserva el fin. */
  function computeResizePreview(clientY: number, actId: string, meta: ResizeMeta) {
    const track = document.querySelector('.activities-track');
    if (!track) return null;
    const rect = track.getBoundingClientRect();
    const deltaH = ((clientY - meta.startY) / rect.height) * totalHours;
    const slots = dayActivities.map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    if (meta.lado === 'abajo') {
      let newEnd = Math.round((meta.origEnd + deltaH) * 4) / 4;
      newEnd = Math.max(meta.origStart + 0.25, Math.min(newEnd, endHour)); // mín 15min
      // El resize conserva el inicio y empuja en cadena acotado por el hueco
      // libre REAL del lado (resolveResizeDay): nunca trunca vecinos.
      return resolveResizeDay(slots, actId, 'abajo', newEnd, startHour, endHour);
    }
    let newStart = Math.round((meta.origStart + deltaH) * 4) / 4;
    newStart = Math.max(startHour, Math.min(newStart, meta.origEnd - 0.25));
    return resolveResizeDay(slots, actId, 'arriba', newStart, startHour, endHour);
  }

  /** Aplica el drop: el mapa resuelto del preview ES lo que se guarda
   *  (misma matemática que se vio mientras se arrastraba). */
  async function commitDropAt(resolved: Map<string, { start: number; end: number }>) {
    if (resolved.size === 0) return;

    // Metodología acordada: en la vista Día, el drag SIEMPRE es una edición
    // temporal del día (override ⚡) — nunca reescribe la plantilla master.
    // "Guardar como plantilla" es la acción explícita que la promueve.
    try {
      await commitResolved(resolved);
    } finally {
      // C2: el estado del drag se limpia SIEMPRE — error o no, la tarjeta
      // no puede quedar en modo fantasma hasta el próximo arrastre.
      draggedActivityId = null;
    }
  }

  /**
   * Escribe un layout resuelto (id → slot) al override del día visible.
   * Fase 1 del plan v2: delega en commitCambios (transacción atómica +
   * undo/redo de un paso) y muestra el toast con [Deshacer]. El snapshot
   * del override captura el día completo — nunca toca filas master.
   */
  async function commitResolved(resolved: Map<string, { start: number; end: number }>) {
    const overrideActs = await ensureOverride();
    let cambio = false;
    for (const [id, slot] of resolved) {
      const act = overrideActs.find(a => a.id === id);
      if (act) {
        const t0 = formatTime(slot.start);
        const t1 = formatTime(slot.end);
        if (act.startTime !== t0 || act.endTime !== t1) {
          act.startTime = t0;
          act.endTime = t1;
          cambio = true;
        }
      }
    }
    if (!cambio) return;
    try {
      const { commitCambios } = await import('../lib/commit');
      const label = tNow('dayView.moveIn', { day: DAY_NAMES[day] });
      // Sin toast de éxito (pedido del usuario): el movimiento confirmado no
      // avisa nada; los errores sí (toastErr). El paso queda en el stack de
      // undo por si se reviviera la acción.
      await commitCambios({
        label,
        ovs: [{ day, activities: $state.snapshot(overrideActs) as Activity[] }]
      });
    } catch (err: any) {
      toastErr(tNow('toast.couldNotMove') + ': ' + (err?.message || err));
    }
  }

  // Context Menu logic
  // emptyMenuHour ≠ null → el menú es de CREACIÓN sobre un hueco (click derecho
  // en espacio vacío); null → menú de actividad existente.
  let contextMenu = $state({ show: false, x: 0, y: 0, activityId: null as string | null, emptyMenuHour: null as number | null });

  // Lightbox para ver la imagen de la rutina
  let viewingImageActivity = $state<Activity | null>(null);

  const contextMenuActivity = $derived(
    contextMenu.activityId !== null
      ? dayActivities.find(a => a.id === contextMenu.activityId) || null
      : null
  );

  function handleContextMenu(e: MouseEvent, activityId: string) {
    e.preventDefault();
    openContextMenuAt(activityId, e.clientX, e.clientY);
  }

  /** Click derecho en espacio vacío del track: menú de creación con hora del punto. */
  function handleTrackContextMenu(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (target.closest('.daily-activity-card, .custom-context-menu, button')) return;
    e.preventDefault();
    closeContextMenu();
    const hour = hourAtY(e, e.currentTarget as HTMLElement);
    const MENU_W = 220;
    const MENU_H = 44;
    const cx = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const cy = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    contextMenu = { show: true, x: Math.max(4, cx), y: Math.max(4, cy), activityId: null, emptyMenuHour: hour };
  }

  /** Abre el modal de creación con la hora del hueco donde se hizo click derecho. */
  function createAtEmptySlot() {
    const hour = contextMenu.emptyMenuHour;
    closeContextMenu();
    if (hour === null) return;
    onEditActivity(null, buildDraftAt(hour));
  }

  /** Abre el menú contextual con clamp para que no se salga de la ventana.
   *  Solo mouse (click derecho); el long-press táctil quieto (G6) se eliminó
   *  en F3 del plan v2. */
  function openContextMenuAt(activityId: string, x: number, y: number) {
    const MENU_W = 220;
    const MENU_H = 130;
    const cx = Math.min(x, window.innerWidth - MENU_W - 8);
    const cy = Math.min(y, window.innerHeight - MENU_H - 8);
    // emptyMenuHour: null EXPLÍCITO — la plantilla distingue el menú de
    // actividad del menú de hueco con `!== null`; sin la propiedad quedaba
    // undefined y el click derecho sobre una tarjeta mostraba "Crear
    // actividad a las…" en vez del menú de la actividad.
    contextMenu = { show: true, x: Math.max(4, cx), y: Math.max(4, cy), activityId, emptyMenuHour: null };
  }

  function closeContextMenu() {
    contextMenu.show = false;
    contextMenu.emptyMenuHour = null;
  }

  async function duplicateActivity() {
    const sourceId = contextMenu.activityId;
    closeContextMenu();
    if (!sourceId) return;

    const source = dayActivities.find(a => a.id === sourceId);
    if (!source) return;

    if (isTemporaryMode) {
      // ── Modo temporal: clonar dentro del override del día, en el primer hueco ──
      const overrideActs = await ensureOverride();
      const durationH = Math.max(0.25, parseTime(source.endTime) - parseTime(source.startTime));
      const busy = overrideActs.map(a => ({
        start: parseTime(a.startTime),
        end: parseTime(a.endTime)
      }));

      // Buscar hueco alineado a 15 min dentro del rango del día
      let placed: number | null = null;
      for (let t = startHour; t + durationH <= endHour + 1e-9; t += 0.25) {
        const s = Math.round(t * 4) / 4;
        const e = s + durationH;
        if (e > endHour + 1e-9) break;
        if (!busy.some(b => s < b.end && b.start < e)) { placed = s; break; }
      }

      if (placed === null) {
        toastErr(tNow('toast.noGap'));
        return;
      }

      const { id: _o, updatedAt: _u, ...rest } = source;
      const clone: Activity = {
        ...(rest as Activity),
        id: newId(),
        name: `${source.name} (copia)`,
        startTime: formatTime(placed),
        endTime: formatTime(placed + durationH),
        updatedAt: Date.now()
      };
      overrideActs.push(clone);
      await db.dayOverrides.put({
        day,
        activities: $state.snapshot(overrideActs),
        updatedAt: Date.now()
      });
      toastOk(tNow('toast.duplicated', { name: clone.name, time: format12h(clone.startTime) }));
    } else {
      // ── Modo Plantilla: duplicar como actividad maestra en el mismo día ──
      const days = source.daysOfWeek?.length ? source.daysOfWeek : [day];
      const clone = await duplicateActivityOp(sourceId, {
        startHour,
        endHour,
        days
      });
      if (clone) {
        toastOk(tNow('toast.duplicated', { name: clone.name, time: format12h(clone.startTime) }));
      } else {
        toastErr(tNow('toast.noGap'));
      }
    }
  }

  function askDeleteActivity() {
    if (!contextMenu.activityId) { closeContextMenu(); return; }
    confirmDelete = true;
    closeContextMenu();
  }

  async function deleteActivity() {
    const id = contextMenu.activityId;
    if (!id) return;

    try {
      if (isTemporaryMode) {
        const overrideActs = await ensureOverride();
        const victim = overrideActs.find(a => a.id === id);
        const filtered = overrideActs.filter(a => a.id !== id);
        const ovBefore = await db.dayOverrides.get(day);
        await db.dayOverrides.put({
          day,
          activities: filtered,
          updatedAt: Date.now()
        });
        if (victim) {
          pushUndo({
            label: `${tNow('toast.deleted')} — ${victim.name} (${DAY_NAMES[day]})`,
            rows: [],
            overrides: [{ day, before: ovBefore ?? null, after: await db.dayOverrides.get(day) ?? null }]
          });
        }
      } else {
        const before = await db.activities.get(id);
        await db.activities.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
        if (before) {
          pushUndo({ label: `${tNow('toast.deleted')} — ${before.name}`, rows: [{ before, after: await db.activities.get(id) ?? null }] });
        }
      }
      toastOk(tNow('toast.deleted'));
    } catch (err: any) {
      toastErr(tNow('toast.couldNotDelete') + ': ' + (err?.message || err));
    }
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="daily-view">
  <div class="daily-header">
    <div class="header-top-row">
      <div class="day-nav">
        <button
          class="btn-day-nav"
          onclick={() => onNavigateDay(-1)}
          disabled={day === 0}
          aria-label={$t('dayView.prevDay', { day: DAY_NAMES[day - 1] ?? '' })}
          title={$t('dayView.prevDay', { day: DAY_NAMES[day - 1] ?? '' })}
        >
          <ChevronLeft size={20} />
        </button>
        <h2>{dayName}{#if esHoy} <span class="hoy-chip">{$t('week.today')}</span>{/if}</h2>
        <button
          class="btn-day-nav"
          onclick={() => onNavigateDay(1)}
          disabled={day === 6}
          aria-label={$t('dayView.nextDay', { day: DAY_NAMES[day + 1] ?? '' })}
          title={$t('dayView.nextDay', { day: DAY_NAMES[day + 1] ?? '' })}
        >
          <ChevronRight size={20} />
        </button>
      </div>
      <div class="current-time-display">
        <Clock size={16} /> {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>

    <!-- Mode toggle -->
    <div class="mode-pill-toggle">
      <button
        class="mode-btn"
        class:active={isTemporaryMode}
        onclick={() => isTemporaryMode = true}
      >
        <Zap size={14} /> {$t('dayView.tempMode')}
      </button>
      <button
        class="mode-btn"
        class:active={!isTemporaryMode}
        onclick={() => isTemporaryMode = false}
      >
        <Calendar size={14} /> {$t('dayView.templateMode')}
      </button>
    </div>

    <!-- Override banner -->
    {#if isTemporaryMode && hasOverride}
      <div class="override-banner">
        <span class="banner-text">{$t('dayView.tempBanner')}</span>
        <div class="banner-actions">
          <button class="btn-banner btn-restore" onclick={restoreDefaultTemplate}>
            <RotateCcw size={14} /> {$t('dayView.restore')}
          </button>
          <button class="btn-banner btn-save" onclick={saveAsPermanentTemplate}>
            <Save size={14} /> {$t('dayView.applyWeek')}
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!-- tabindex+role=region: contenedor scrolleable accesible por teclado
       (axe: scrollable-region-focusable) -->
  <div class="daily-container" tabindex="0" role="region" aria-label={$t('dayView.title')}>
    <div class="time-track">
      {#each Array.from({ length: totalHours + 1 }, (_, i) => startHour + i) as hour}
        <div class="hour-marker" style="top: {((hour - startHour) / totalHours) * 100}%">
          <span>{hour % 12 || 12}:00 {hour < 12 ? 'AM' : (hour === 24 ? 'AM' : 'PM')}</span>
        </div>
      {/each}
    </div>

    <div class="activities-track" class:track-dragging={draggedActivityId !== null} class:track-entrada={entradaDia} onclick={handleTrackTap} oncontextmenu={handleTrackContextMenu} role="presentation">
      {#if layoutActivities.length === 0}
        <div class="empty-state glass-panel" aria-live="polite">
          <span class="empty-icon">🌱</span>
          <p>{$t('dayView.empty')}</p>
        </div>
      {/if}
      {#key day}
      {#each layoutActivities as activity (activity.id)}
        {@const totalSteps = activity.steps?.length || 0}
        {@const doneSteps = activity.steps?.filter(s => s.completed).length || 0}
        <!-- Sin role="button" NI tabindex: la tarjeta contiene botones reales
             (miniatura, editar) y axe lo marca como nested-interactive. La
             accesibilidad la llevan esos botones (editar con aria-label) y el
             drag/puntero no requiere foco de tarjeta. -->
        <div
          class="daily-activity-card glass-panel"
          class:is-short={activity.durationMins <= 20}
          class:dragging={draggedActivityId === activity.id}
          class:drop-invalid={draggedActivityId === activity.id && dragInvalid}
          class:shake-invalid={(draggedActivityId === activity.id || shakeId === activity.id) && shakeInvalid}
          class:flash-commit={flashId === activity.id}
          onanimationend={(e) => { if (e.animationName === 'shake-x') { shakeInvalid = false; shakeId = null; } }}
          onpointerdown={(e) => handlePointerDown(e, activity)}
          oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
          onclick={() => onEditActivity(activity.id!, activity)}
          style="top: {activity.top}; height: {activity.height}; left: {activity.left}; width: {activity.width}; border-left-color: {getActivityColor(activity.categoryId, categories)}"
        >
          <div class="activity-content" class:compact={activity.durationMins <= 20}>
            <div class="activity-title-group">
              <span class="activity-name">{activity.name}</span>
              {#if activity.image}
                <button
                  type="button"
                  class="activity-image-thumb"
                  aria-label={$t('dayView.viewImage', { name: activity.name })}
                  onclick={(e) => { e.stopPropagation(); viewingImageActivity = activity; }}
                >
                  <img src={activity.image} alt="" />
                </button>
              {/if}
              {#if totalSteps > 0 && activity.durationMins > 20}
                <span class="activity-steps-badge" class:all-done={doneSteps === totalSteps && totalSteps > 0}>
                  <ListChecks size={12} /> {doneSteps}/{totalSteps}
                </span>
              {/if}
            </div>
            <!-- Botón Edit solo en tarjetas con altura real suficiente (≥90 min
                 ≈ ≥52px en el track: siempre > 44px regla dura #5). En tarjetas
                 más cortas la edición queda a un click en la tarjeta o menú
                 contextual — un botón recortado NO es un target válido. -->
            {#if activity.durationMins >= 90}
              <button
                class="edit-btn"
                onclick={(e) => { e.stopPropagation(); onEditActivity(activity.id!, activity); }}
                aria-label={$t('dayView.edit', { name: activity.name })}
              >
                <Edit3 size={13} />
              </button>
            {/if}
          </div>
          <div
            class="resize-handle top"
            aria-hidden="true"
            onpointerdown={(e) => startResize(e, activity, 'arriba')}
          ></div>
          <div
            class="resize-handle"
            aria-hidden="true"
            onpointerdown={(e) => startResize(e, activity, 'abajo')}
          ></div>
        </div>
      {/each}
      {/key}

      {#if isNowInRange}
        <div class="time-bar" style="top: {barTopPercent}%">
          <div class="time-bar-dot">
            <span class="time-bar-label">
              {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </span>
          </div>
          <div class="time-bar-line"></div>
        </div>
      {/if}
    </div>
  </div>

  {#if contextMenu.show}
    <!-- Portal a body: el backdrop-filter de .glass-panel ancestro crea containing block
         y ancla el position:fixed al PANEL (menú lejos del cursor). Mismo fix que Semana. -->
    <div class="custom-context-menu glass-panel" use:portal style="top: {contextMenu.y}px; left: {contextMenu.x}px">
      {#if contextMenu.emptyMenuHour !== null}
        <!-- Menú de hueco: crear con la hora del punto del click derecho -->
        <button onclick={createAtEmptySlot} aria-label={$t('menu.createHere', { time: format12h(horasAHoraReloj(contextMenu.emptyMenuHour)) })}>
          <Plus size={16} /> {$t('menu.createHere', { time: format12h(horasAHoraReloj(contextMenu.emptyMenuHour)) })}
        </button>
      {:else}
      <button onclick={duplicateActivity}>
        <Copy size={16} /> {$t('menu.duplicate')}
      </button>
      {#if contextMenuActivity?.image}
        <button onclick={() => { viewingImageActivity = contextMenuActivity; }}>
          <ImageIcon size={16} /> {$t('menu.viewImage')}
        </button>
      {/if}
      <button class="delete-btn" onclick={askDeleteActivity}>
        <Trash2 size={16} /> {$t('menu.delete')}
      </button>
      {/if}
    </div>
  {/if}

  <ConfirmDialog
    bind:open={confirmDelete}
    title={$t('confirm.deleteTitle')}
    message={$t('confirm.deleteDayMsg')}
    confirmText={$t('confirm.deleteBtn')}
    danger
    onconfirm={deleteActivity}
  />
  <ConfirmDialog
    bind:open={confirmRestore}
    title={$t('confirm.restoreTemplateTitle')}
    message={$t('confirm.restoreTemplateMsg')}
    confirmText={$t('dayView.restore')}
    danger
    onconfirm={doRestoreDefault}
  />
  <ConfirmDialog
    bind:open={confirmSavePermanent}
    title={$t('confirm.applyTemplateTitle')}
    message={$t('confirm.applyTemplateMsg')}
    confirmText={$t('confirm.applyBtn')}
    onconfirm={doSavePermanent}
  />

  {#if viewingImageActivity}
    <ImageLightbox activity={viewingImageActivity} onClose={() => viewingImageActivity = null} />
  {/if}
</div>

<style>
  .daily-view {
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .daily-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.5rem;
    border-bottom: 1px solid rgba(0,0,0,0.05);
  }

  .header-top-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  /* Navegación de días (anterior/siguiente): hallazgo rojo de la auditoría UX
     — la vista Día solo se alcanzaba tocando el ⚡ de una columna en Semana.
     Touch ≥44px y aria-label (reglas duras del proyecto). */
  .day-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .btn-day-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    border: 1px solid rgba(45, 90, 39, 0.25);
    background: rgba(255, 255, 255, 0.55);
    color: var(--color-green-dark);
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }
  .btn-day-nav:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.85);
  }
  .btn-day-nav:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .btn-day-nav:focus-visible {
    outline: 2px solid var(--color-green-dark);
    outline-offset: 2px;
  }

  .daily-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--color-green-dark);
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  /* Chip "Hoy" junto al título: mismo verde institucional que el badge de
     la vista Semana para que la señalización sea consistente. */
  .hoy-chip {
    font-size: 0.68rem;
    font-weight: 700;
    color: #ffffff;
    background: var(--color-green-dark);
    border-radius: 999px;
    padding: 3px 10px;
    line-height: 1.4;
    letter-spacing: 0.02em;
    white-space: nowrap;
    transform: translateY(-1px);
  }

  .current-time-display {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--color-brown-bark);
    padding: 0.5rem 1rem;
    background: rgba(92, 64, 51, 0.05);
    border-radius: 20px;
  }

  /* ── Mode Toggle ── */
  .mode-pill-toggle {
    display: flex;
    background: rgba(0,0,0,0.04);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
    align-self: flex-start;
  }

  .mode-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.6rem 1rem;
    min-height: 44px;
    border: none;
    border-radius: 8px;
    background: transparent;
    font-size: 0.8rem;
    font-weight: 600;
    color: #6b6b6b; /* AA (antes #888) */
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .mode-btn.active {
    background: white;
    color: var(--color-green-dark);
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
  }

  .mode-btn:hover:not(.active) {
    color: var(--color-brown-bark);
  }

  /* ── Override Banner ── */
  .override-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(245, 158, 11, 0.04));
    border: 1px solid rgba(245, 158, 11, 0.25);
    border-radius: 10px;
    padding: 0.6rem 1rem;
    animation: fadeIn 0.2s ease-out;
  }

  .banner-text {
    font-size: 0.82rem;
    font-weight: 600;
    color: #b45309;
  }

  .banner-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-banner {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.55rem 0.9rem;
    min-height: 44px;
    border: none;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
  }

  .btn-restore {
    background: rgba(239, 68, 68, 0.1);
    color: #dc2626;
  }

  .btn-restore:hover {
    background: rgba(239, 68, 68, 0.2);
  }

  .btn-save {
    background: rgba(45, 90, 39, 0.1);
    color: var(--color-green-dark);
  }

  .btn-save:hover {
    background: rgba(45, 90, 39, 0.2);
  }

  .daily-container {
    flex: 1;
    position: relative;
    display: flex;
    margin: 1.5rem;
    overflow-y: auto;
    min-height: 1600px; /* Scale so 15-min tasks have ~25px and don't crowd */
    /* Scrollbar invisible: el scroll queda (rueda del mouse + touch), pero sin
       la barra pegada al borde de las tarjetas. */
    scrollbar-width: none;
    /* En pantallas grandes (≥1536px) el track de actividades deja de ser una
       cinta kilométrica: tope 900px y centrado — las tarjetas conservan
       proporción legible y los ojos no viajan 60cm de lado a lado. */
  }
  @media (min-width: 1536px) {
    .daily-container {
      /* Escala con la pantalla hasta un tope: 900px se quedaba chico en
         2560px (ultrawide) dejando ~1660px muertos. clamp: crece 1px por
         cada 2px de viewport entre 1536 y 2412, techo 1200px. */
      max-width: clamp(900px, 58vw, 1200px);
      margin-left: auto;
      margin-right: auto;
      width: 100%;
    }
    .daily-header {
      max-width: clamp(900px, 58vw, 1200px);
      margin-left: auto;
      margin-right: auto;
      width: 100%;
    }
    .daily-header h2 {
      font-size: 1.7rem;
    }
  }
  .daily-container::-webkit-scrollbar {
    display: none;
  }

  .time-track {
    width: 70px;
    position: relative;
    border-right: 1px solid rgba(0,0,0,0.05);
  }

  .hour-marker {
    position: absolute;
    width: 100%;
    transform: translateY(-50%);
    font-size: 0.75rem;
    color: #6b6b6b; /* AA (antes #888) */
    display: flex;
    justify-content: flex-end;
    padding-right: 0.5rem;
  }

  .activities-track {
    flex: 1;
    position: relative;
    margin-left: 1rem;
  }

  /* G12: invitación cuando el día no tiene actividades (el tap en el track crea) */
  .empty-state {
    position: absolute;
    inset: 15% 8% auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.25rem 1rem;
    text-align: center;
    pointer-events: none; /* el tap pasa al track → abre el modal */
    color: var(--color-brown-bark);
    opacity: 0.85;
  }
  .empty-state .empty-icon {
    font-size: 1.75rem;
  }
  .empty-state p {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.45;
  }

  .daily-activity-card {
    position: absolute;
    background: white;
    border-left: 5px solid;
    padding: 0.35rem 0.85rem;
    box-sizing: border-box;
    transition: top 0.18s cubic-bezier(0.2, 0, 0, 1), height 0.18s cubic-bezier(0.2, 0, 0, 1), transform 0.2s, box-shadow 0.2s, background 0.2s;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 0;
    z-index: 1;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    cursor: grab;
    touch-action: pan-y; /* scroll vertical nativo; el drag (long-press) lo desactiva */
    -webkit-user-select: none;
    user-select: none; /* sin selección de texto que interfiera con el drag */
  }

  .daily-activity-card:focus-visible {
    outline: 3px solid var(--color-green-dark, #2d5a3d);
    outline-offset: 2px;
    z-index: 3;
  }

  .daily-activity-card:active {
    cursor: grabbing;
  }

  /* Handle de redimensionado (estirar borde inferior): invisible hasta hover
     en desktop; en táctil siempre leve indicación. Zona PROPORCIONAL (30% de
     la tarjeta, piso 9px, tope 22px): en tarjetas cortas de 15-30 min el
     agarre/mover nunca queda más chico que la zona de estirar. */
  .resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 30%;
    min-height: 9px;
    max-height: 22px;
    cursor: ns-resize;
    touch-action: none; /* el gesto es del resize, no del scroll */
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .resize-handle::after {
    content: '';
    width: 28px;
    height: 4px;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.18);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .daily-activity-card:hover .resize-handle::after {
    opacity: 1;
  }

  /* Asa superior: espejo de la inferior (resize bidireccional). */
  .resize-handle.top {
    top: 0;
    bottom: auto;
    align-items: flex-start;
  }
  .resize-handle.top::after {
    order: -1;
  }

  /* Flash de commit: el bloque recién soltado confirma con un pulso verde. */
  .daily-activity-card.flash-commit {
    animation: flash-commit 0.5s ease-out;
  }
  @keyframes flash-commit {
    0% { box-shadow: 0 0 0 3px rgba(47, 107, 47, 0.55); }
    100% { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); }
  }

  /* Micro-shake del fantasma inválido (respeta reduced-motion vía el bloque
     general de abajo). CLASE ONE-SHOT (.shake-invalid): se dispara UNA vez
     al pasar de válido→inválido y se limpia en animationend — si la anima-
     ción viviera en .drop-invalid (clase re-aplicada en cada pointermove
     cerca del límite), cada re-aplicación reinicia la animación = zumbido. */
  .daily-activity-card.shake-invalid {
    animation: shake-x 0.3s ease;
  }
  @keyframes shake-x {
    0%, 100% { margin-left: 0; }
    25% { margin-left: -3px; }
    75% { margin-left: 3px; }
  }

  /* En pleno drag se inhibe el hover (sin scale/translate ni overflow visible):
     era la causa de los ticks y sacudidas al agarrar. */
  .daily-activity-card.dragging:hover {
    transform: none;
    overflow: hidden;
    background: white;
  }

  /* Flicker en la colisión (fix): en pleno drag el hover de TODAS las tarjetas
     queda inhibido — la pisada es deslizada bajo el cursor por la cascada y
     con :hover vivo alternaba transform (translateX) + overflow + z-index en
     cada entrada/salida del puntero = parpadeo. Mismo patrón que .col-dragging
     de la vista Semana. */
  /* Parpadeo de z-index (fix): el bloque arrastrado vive BAJO el cursor, así
     que :hover le dispara sin parar y (con el shake moviéndolo ±3px) alterna
     hover/no-hover = intercambio frenético de z-index con el vecino pisado.
     El arrastrado queda OPACO a los cambios de hover: z-index fijo 100 y el
     inhibidor global de hover NO lo incluye (solo afecta a los vecinos). */
  .track-dragging .daily-activity-card:hover:not(.dragging),
  .track-dragging .daily-activity-card:focus-visible:not(.dragging) {
    transform: none;
    overflow: hidden;
    background: white;
    z-index: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .daily-activity-card.dragging,
  .daily-activity-card.dragging:hover,
  .daily-activity-card.dragging:focus-visible {
    z-index: 100; /* se queda arriba del vecino pisado durante TODO el gesto */
  }
  .track-dragging .daily-activity-card:hover .edit-btn {
    opacity: 0; /* el lápiz flotante tampoco compite durante el gesto */
  }
  .track-dragging .daily-activity-card:hover .resize-handle::after {
    opacity: 0; /* las asas de estirar tampoco se encienden a mitad del gesto */
  }
  /* (La entrada escalonada vive SOLO en .track-entrada, abajo: alternar
     animation-name a mitad de gesto reinicia la animación = flash en cada
     drop/cancel. La gate entradaDia la enciende únicamente al cambiar de
     día, cuando el {#key day} re-monta las tarjetas.) */

  /* Entrada escalonada al cambiar de día: se re-monta el track ({#key day})
     y nth-child reparte los delays — cero bytes extra en el chunk. */
  .track-entrada .daily-activity-card {
    animation: fadeIn .25s ease-out backwards;
  }
  .track-entrada .daily-activity-card:nth-child(2) { animation-delay: 20ms }
  .track-entrada .daily-activity-card:nth-child(3) { animation-delay: 40ms }
  .track-entrada .daily-activity-card:nth-child(4) { animation-delay: 60ms }
  .track-entrada .daily-activity-card:nth-child(5) { animation-delay: 80ms }
  .track-entrada .daily-activity-card:nth-child(n+6) { animation-delay: 100ms }

  /* Estado de arrastre activo (pointer drag) */
  .daily-activity-card.dragging {
    /* Sin lag: la tarjeta sigue el dedo/cursor 1:1 (se mueve por transform,
       no por top — su top/height animan hacia el slot predicho como las
       demás, pero las tapa el fantasma que sigue al cursor). */
    transition: opacity 0.15s, box-shadow 0.15s;
    opacity: 1; /* opaca: semi-transparente dejaba ver el texto del vecino a través ("texto duplicado") */
    /* Sombra del bloque flotante de la demo: capa de contacto + caída suave
       y profunda — la tarjeta se ve "levantada" de la grilla. */
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15), 0 12px 28px rgba(0, 0, 0, 0.3);
    z-index: 100;
    cursor: grabbing;
    will-change: transform;
  }

  /* Drop inválido: no cabe / pisaría — rojo y al soltar vuelve a su sitio. */
  .daily-activity-card.drop-invalid {
    background: #e0453a !important;
    border-left-color: #8f2318 !important;
    color: #fff;
  }
  .daily-activity-card.drop-invalid .activity-name {
    color: #fff;
  }

  /* Accesibilidad: quien pide menos movimiento no recorre la cascada —
     los cambios de posición son instantáneos, sin deslizamientos. */
  @media (prefers-reduced-motion: reduce) {
    .daily-activity-card,
    .daily-activity-card.dragging,
    .daily-activity-card.drop-invalid,
    .daily-activity-card.shake-invalid,
    .daily-activity-card.flash-commit,
    .resize-handle::after {
      transition: none !important;
      animation: none !important;
    }
  }

  .daily-activity-card:hover {
    transform: translateX(4px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    z-index: 10;
    overflow: visible;
    background: #fdfdfd;
  }

  .daily-activity-card.is-short {
    min-height: 28px;
    padding: 0.1rem 0.6rem;
    border-left-width: 4px;
    border-radius: 6px;
  }

  .daily-activity-card.is-short .activity-name {
    font-size: 0.84rem;
  }

  .activity-content {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    height: 100%;
    min-height: 0;
    padding-right: 2.25rem;
    box-sizing: border-box;
  }

  .activity-content.compact {
    padding-right: 1.6rem;
    gap: 0.4rem;
  }

  .activity-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 1;
    min-width: 0;
  }

  .activity-name {
    font-weight: 700;
    font-size: 1rem;
    color: var(--text-main);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .activity-image-thumb {
    flex-shrink: 0;
    position: relative; /* ancla del ::before (zona táctil invisible) */
    border: 2px solid rgba(255, 255, 255, 0.9);
    padding: 0;
    background: none;
    cursor: zoom-in;
    border-radius: 50%;
    width: 24px;
    height: 24px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
    transition: transform 0.15s;
  }
  .activity-image-thumb:focus-visible {
    outline: 2px solid var(--color-green-dark, #2f6b2f);
    outline-offset: 2px;
  }

  .activity-image-thumb:hover {
    transform: scale(1.12);
  }

  .activity-image-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%; /* recorte aquí: el botón necesita overflow
                           visible para su zona táctil (::before) */
    object-fit: cover;
  }

  /* Táctil (auditoría UX): 24px es inalcanzable con dedo (regla dura
     #5). Un ::before transparente lleva la zona efectiva a 44px sin
     agrandar el anillo visual ni robarle espacio al nombre.
     box-sizing: border-box → padding-box = 24 − 2×2px de borde = 20px,
     y `inset` se mide sobre él: −12px → 20 + 24 = 44px reales. */
  @media (hover: none) and (pointer: coarse) {
    .activity-image-thumb::before {
      content: '';
      position: absolute;
      inset: -12px;
    }
  }

  .activity-steps-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: rgba(45, 90, 39, 0.1);
    color: var(--color-green-dark);
    font-size: 0.7rem;
    font-weight: 700;
    padding: 0.15rem 0.4rem;
    border-radius: 6px;
    white-space: nowrap;
    border: 1px solid rgba(45, 90, 39, 0.15);
  }

  .activity-steps-badge.all-done {
    background: rgba(45, 90, 39, 0.2);
    color: var(--color-green-dark);
  }

  .edit-btn {
    position: absolute;
    top: 50%;
    right: 0.75rem;
    transform: translateY(-50%);
    background: white;
    border: none;
    color: #bbb;
    cursor: pointer;
    /* Accesibilidad: target táctil >= 44px (regla dura #5) aunque el icono
       siga a 13px. En tarjetas de 15-30min la tarjeta mide menos de 44px de
       alto: el botón sobresale (la tarjeta recorta con overflow:hidden solo
       el icono fantasma que ya no está — se midió y ajustó al plano real). */
    width: 44px;
    height: 44px;
    margin-top: -22px; /* ancla el CENTRO del target a la mitad de la tarjeta */
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: all 0.2s;
    border-radius: 6px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  }
  /* Tarjetas más altas que 44px: el botón no necesita excederse.
     El centro queda anclado igual (margin-top fijo por transform). */
  .daily-activity-card:not(.is-short) .edit-btn {
    height: 44px;
  }

  .daily-activity-card:hover .edit-btn {
    opacity: 1;
  }

  .edit-btn:hover {
    color: var(--color-green-dark);
  }

  .time-bar {
    position: absolute;
    width: 100%;
    left: -1rem; /* Extend to time track */
    right: 0;
    z-index: 20;
    pointer-events: none;
    display: flex;
    align-items: center;
  }

  .time-bar-dot {
    width: 10px;
    height: 10px;
    background: #e53e3e;
    border-radius: 50%;
    box-shadow: 0 0 5px rgba(229, 62, 62, 0.5);
    position: relative;
    display: flex;
    align-items: center;
  }

  .time-bar-label {
    position: absolute;
    right: 15px; /* Move to the left of the dot */
    background: #c53030; /* AA con blanco 4.9:1 (antes #e53e3e = 3.7:1) */
    color: white;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    display: flex;
    align-items: center;
  }

  .time-bar-label::after {
    content: '';
    position: absolute;
    right: -4px;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-left: 4px solid #e53e3e;
  }
  .time-bar-line {
    flex: 1;
    height: 2px;
    background: #e53e3e;
    opacity: 0.5;
  }

  .custom-context-menu {
    position: fixed;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    min-width: 200px;
    background: white;
    border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0,0,0,0.15);
    border: 1px solid rgba(0,0,0,0.05);
    animation: fadeIn 0.1s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .custom-context-menu button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--color-brown-bark);
    border-radius: 8px;
    transition: all 0.2s;
    text-align: left;
  }

  .custom-context-menu button:hover {
    background: rgba(92, 64, 51, 0.05);
    color: var(--color-green-dark);
  }

  .custom-context-menu button.delete-btn {
    color: #e53e3e;
    border-top: 1px solid rgba(0,0,0,0.05);
    margin-top: 0.25rem;
    padding-top: 0.75rem;
    border-radius: 0 0 8px 8px;
  }

  .custom-context-menu button.delete-btn:hover {
    background: #fff5f5;
  }

  /* ── Cobertura móvil escalonada (misma escala que la grilla Semana) ──
     768px: header/banner compactos y track con menos margen.
     480px: todo al mínimo legible — time-track 48px (igual que Semana),
     tarjetas y banner apretados sin romper los touch targets de 44px. */
  @media (max-width: 768px) {
    .daily-header {
      padding: 1rem;
    }
    .daily-header h2 {
      font-size: 1.25rem;
    }
    .current-time-display {
      font-size: 0.8rem;
      padding: 0.35rem 0.75rem;
    }
    .daily-container {
      margin: 1rem 0.5rem;
    }
    .time-track {
      width: 56px; /* misma escala que la columna de horas de Semana @768 */
    }
    .hour-marker {
      font-size: 0.7rem;
      padding-right: 0.35rem;
    }
    .activities-track {
      margin-left: 0.5rem;
    }
    .daily-activity-card {
      padding: 0.4rem 0.6rem;
    }
    .activity-content {
      padding-right: 2rem;
      gap: 0.5rem;
    }
    .activity-name {
      font-size: 0.9rem;
    }    .edit-btn {
      opacity: 0.85;
      padding: 0.25rem;
      right: 0.4rem;
    }
    .time-bar {
      left: -0.5rem;
    }
    /* En móvil el chip de hora se salía por la izquierda (right:15px lo
       ancla al dot sobre la columna de horas): anclarlo AL BORDE IZQUIERDO
       del track, con la flecha mirando a la derecha. */
    .time-bar-label {
      right: auto;
      left: 0.25rem;
      border-radius: 4px 0 4px 4px;
    }
    .time-bar-label::after {
      right: auto;
      left: -4px;
      border-left: none;
      border-right: 4px solid #c53030;
    }
    /* Banner apilado pero con acciones a ancho completo y 44px táctiles */
    .override-banner {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
    }
    .banner-actions {
      justify-content: flex-end;
    }
  }

  @media (max-width: 480px) {
    .daily-header h2 {
      font-size: 1.1rem;
    }
    .daily-container {
      margin: 0.75rem 0.25rem;
    }
    .time-track {
      width: 48px; /* igual que la columna de horas de Semana @480 */
    }
    .hour-marker {
      font-size: 0.62rem;
      padding-right: 0.2rem;
    }
    .activities-track {
      margin-left: 0.25rem;
    }
    .daily-activity-card {
      padding: 0.3rem 0.5rem;
    }
    .activity-content {
      padding-right: 1.75rem;
      gap: 0.25rem;
    }
    .activity-name {
      font-size: 0.82rem;
    }
    .mode-btn {
      font-size: 0.72rem;
      padding: 0.35rem 0.6rem;
    }
    /* Banner: texto y acciones en columna, botones flexionan sin romper
       los 44px de altura táctil (regla dura #5). */
    .override-banner {
      padding: 0.5rem 0.6rem;
    }
    .banner-text {
      font-size: 0.75rem;
    }
    .banner-actions {
      flex-wrap: wrap;
    }
    .btn-banner {
      padding: 0.45rem 0.7rem;
      min-height: 44px;
      font-size: 0.7rem;
    }
    .time-bar-dot {
      width: 8px;
      height: 8px;
    }
    .time-bar-label {
      font-size: 0.6rem;
      right: 12px;
    }
  }
</style>
