<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, getActivityColor, formatTime, format12h } from '../lib/stores';
  import { resolveDayCascade } from '../lib/cascade';
  import { Clock, Edit3, Copy, Trash2, ListChecks, RotateCcw, Save, Calendar, Zap, ImageIcon } from '@lucide/svelte';
  import { db, newId } from '../lib/db';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import ImageLightbox from './ImageLightbox.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';
  import { pushUndo, cloneAct } from '../lib/undo';

  interface Props {
    day: number;
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    dayOverrides?: DayOverride[];
    onEditActivity: (id: string | null, initialData?: Activity) => void;
  }

  let { day, activities, categories, settings, dayOverrides = [], onEditActivity }: Props = $props();

  /**
   * Tap en un slot vacío del track (G4): abre el modal de creación con la hora
   * precargada según el punto tocado. Se ignora si el tap fue sobre una tarjeta
   * o si vino después de un drag (suppressNextClick).
   */
  function handleTrackTap(e: MouseEvent) {
    if (suppressNextClick) return;
    const target = e.target as HTMLElement;
    if (target.closest('.daily-activity-card, .context-menu, button')) return;
    const track = e.currentTarget as HTMLElement;
    const rect = track.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const yPercent = y / rect.height;
    const hour = startHour + yPercent * (endHour - startHour);
    // Snap a 15 min y clamp dentro del rango visible
    const snapped = Math.max(startHour, Math.min(Math.round(hour * 4) / 4, endHour - 0.25));
    const h = Math.floor(snapped);
    const m = Math.round((snapped - h) * 60);
    const fmt = (v: number) => v.toString().padStart(2, '0');
    // Fin = inicio + 60 min, normalizado (no clavado en :59)
    const endTotal = h * 60 + m + 60;
    onEditActivity(null, {
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
    } as unknown as Activity);
  }

  const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const dayName = $derived(DAY_NAMES[day]);
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

  onDestroy(() => {
    clearInterval(interval);
    // Desmontaje a mitad de drag/gesto: sin esto, los listeners de window
    // quedan colgados y referencian nodos muertos.
    cleanupDragListeners();
    cleanupResizeListeners();
    stopEdgeScroll();
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
    toastOk('Plantilla restaurada');
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
    toastOk('Aplicado a la plantilla semanal');
  }

  let confirmDelete = $state(false);
  let confirmRestore = $state(false);
  let confirmSavePermanent = $state(false);

  // ── Drag & Drop con Pointer Events (mouse + táctil) ─────────────────────
  // El DnD nativo de HTML5 no dispara en pantallas táctiles: se reimplementa
  // con pointer events. Mouse: arrastra al superar 5px de movimiento.
  // Táctil: long-press (260ms) para no pelear con el scroll vertical.
  const DRAG_THRESHOLD_PX = 5;
  const LONG_PRESS_MS = 260;

  interface PendingDrag {
    activityId: string;
    offsetYHours: number;   // punto de agarre dentro de la tarjeta, en horas
    startX: number;
    startY: number;
    pointerId: number;
    pointerType: string;
    card: HTMLElement;
    started: boolean;
    timer: number | null;
    lastClientY: number;
  }
  let pendingDrag: PendingDrag | null = null;
  let dragOffsetHours = 0;
  let draggedActivityId = $state<string | null>(null);
  let suppressNextClick = false;

  /**
   * Vista previa del layout durante el drag: id → {start, end} en horas.
   * No toca la BD — solo alimenta a layoutActivities para que las tarjetas
   * vecinas se deslicen (transition CSS) hacia su posición predicha mientras
   * se arrastra. null = sin drag activo.
   */
  let dropPreview = $state<Map<string, { start: number; end: number }> | null>(null);

  /**
   * Ancla temporal de la tarjeta recién soltada: mientras la store re-emite,
   * su layout viene de aquí (slot final) — así la transición CSS la lleva
   * desde la posición del fantasma hasta su slot, sin teletransporte.
   */
  let topOverride = $state<{ id: string; start: number; end: number } | null>(null);

  function handlePointerDown(e: PointerEvent, activity: Activity) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.currentTarget as HTMLElement;
    if (!card.closest('.activities-track')) return;

    const cardRect = card.getBoundingClientRect();
    const durH = parseTime(activity.endTime) - parseTime(activity.startTime);

    pendingDrag = {
      activityId: activity.id!,
      offsetYHours: ((e.clientY - cardRect.top) / cardRect.height) * durH,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      card,
      started: false,
      timer: null,
      lastClientY: e.clientY
    };

    if (e.pointerType !== 'mouse') {
      pendingDrag.timer = window.setTimeout(() => {
        if (pendingDrag && !pendingDrag.started) activateDrag();
      }, LONG_PRESS_MS);
    }

    window.addEventListener('pointermove', onDragPointerMove, { passive: false });
    window.addEventListener('pointerup', onDragPointerUp);
    window.addEventListener('pointercancel', onDragPointerCancel);
    // C1: no pasivo es lo que permite preventDefault del scroll en el drag.
    window.addEventListener('touchmove', onDragTouchMove, { passive: false });
  }

  function activateDrag() {
    if (!pendingDrag || pendingDrag.started) return;
    pendingDrag.started = true;
    dragOffsetHours = pendingDrag.offsetYHours;
    draggedActivityId = pendingDrag.activityId;
    try { pendingDrag.card.setPointerCapture(pendingDrag.pointerId); } catch { /* noop */ }
    pendingDrag.card.classList.add('dragging');
    navigator.vibrate?.(10); // háptica sutil: el drag se armó
    if (pendingDrag.pointerType !== 'mouse') {
      pendingDrag.card.style.touchAction = 'none';
      window.addEventListener('contextmenu', preventDragContextMenu, true);
    }
    moveGhost(pendingDrag.lastClientY);
    ensureEdgeScroll(); // M5
  }

  function preventDragContextMenu(e: Event) {
    e.preventDefault();
    e.stopPropagation(); // M3: el oncontextmenu de la tarjeta no debe abrir el menú en Android
  }

  function moveGhost(clientY: number) {
    if (!pendingDrag) return;
    // Lift minimalista: el fantasma crece 3% — feedback de agarre sin ruido.
    // Al soltar, la transición base de transform lo asienta de vuelta a 1.
    pendingDrag.card.style.transform = `translateY(${clientY - pendingDrag.startY}px) scale(1.03)`;
  }

  // M5: auto-scroll del contenedor al arrastrar cerca de sus bordes — sin
  // esto no se puede llevar una actividad a una hora fuera de pantalla.
  const EDGE_SCROLL_ZONE = 56;   // px de franja activa
  const EDGE_SCROLL_SPEED = 12;  // px por frame
  let edgeScrollRaf = 0;
  function edgeScrollTick() {
    if (!pendingDrag?.started) { edgeScrollRaf = 0; return; }
    const container = document.querySelector('.daily-container');
    if (container) {
      const rect = container.getBoundingClientRect();
      const y = pendingDrag.lastClientY;
      if (y < rect.top + EDGE_SCROLL_ZONE) container.scrollBy(0, -EDGE_SCROLL_SPEED);
      else if (y > rect.bottom - EDGE_SCROLL_ZONE) container.scrollBy(0, EDGE_SCROLL_SPEED);
    }
    edgeScrollRaf = requestAnimationFrame(edgeScrollTick);
  }
  function ensureEdgeScroll() {
    if (!edgeScrollRaf && pendingDrag?.started) edgeScrollRaf = requestAnimationFrame(edgeScrollTick);
  }
  function stopEdgeScroll() {
    if (edgeScrollRaf) { cancelAnimationFrame(edgeScrollRaf); edgeScrollRaf = 0; }
  }

  function onDragPointerMove(e: PointerEvent) {
    if (!pendingDrag) return;
    pendingDrag.lastClientY = e.clientY;

    if (!pendingDrag.started) {
      const dist = Math.hypot(e.clientX - pendingDrag.startX, e.clientY - pendingDrag.startY);
      if (pendingDrag.pointerType === 'mouse') {
        if (dist > DRAG_THRESHOLD_PX) activateDrag();
      } else if (dist > 10 && pendingDrag.timer) {
        // Movimiento antes del long-press = gesto de scroll: cancelar drag
        clearTimeout(pendingDrag.timer);
        pendingDrag.timer = null;
      }
      if (!pendingDrag.started) return;
    }

    if (pendingDrag.pointerType !== 'mouse') e.preventDefault();
    moveGhost(e.clientY);
    updateDropPreview(e.clientY);
  }

  /**
   * Calcula el layout predicho para la posición actual del cursor y lo
   * publica en dropPreview: las tarjetas vecinas empujadas se deslizan en
   * vivo vía su transition CSS de top/height. Síncrono a propósito: el cálculo
   * es trivial (ordenar ≤20 items) y rAF no corre en pestañas ocultas.
   */
  let lastPreviewY = NaN;
  function updateDropPreview(clientY: number) {
    if (clientY === lastPreviewY) return;
    if (!pendingDrag?.started) return;
    lastPreviewY = clientY;
    dropPreview = computeLayoutForDrop(clientY, draggedActivityId);
  }

  /**
   * Resolución de colisiones (cascada push-down) para un clientY dado.
   * Delega en src/lib/cascade.ts (dueño único de la matemática, compartida
   * con la vista Semana). Devuelve el mapa id → {start, end} SIN tocar la BD.
   */
  function computeLayoutForDrop(clientY: number, draggedId: string | null): Map<string, { start: number; end: number }> {
    const result = new Map<string, { start: number; end: number }>();
    const track = document.querySelector('.activities-track');
    if (!track || draggedId === null) return result;

    const rect = track.getBoundingClientRect();
    const yPercent = (clientY - rect.top) / rect.height;

    let newStartHour = startHour + (yPercent * totalHours) - dragOffsetHours;
    newStartHour = Math.round(newStartHour * 4) / 4; // snap 15 min

    const activity = dayActivities.find(a => a.id === draggedId);
    if (!activity) return result;

    const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
    newStartHour = Math.max(startHour, Math.min(newStartHour, endHour - duration));

    // Cascada solo sobre el día visible (compartida con la Semana)
    const slots: { id: string; start: number; end: number }[] = dayActivities
      .filter(a => a.id !== draggedId)
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    // Semántica local: el arrastrado es la pared (movedId); al soltar sobre
    // una sola actividad aplica la regla de mitades (arriba/abajo pegado).
    const resolved = resolveDayCascade(
      [...slots, { id: draggedId, start: newStartHour, end: newStartHour + duration }],
      endHour, draggedId, startHour
    );
    for (const slot of resolved) result.set(slot.id, { start: slot.start, end: slot.end });
    return result;
  }

  async function onDragPointerUp(e: PointerEvent) {
    const st = pendingDrag;
    cleanupDragListeners();
    if (!st) return;
    if (st.timer) clearTimeout(st.timer);
    st.card.classList.remove('dragging');
    st.card.style.transform = '';
    st.card.style.touchAction = '';
    window.removeEventListener('contextmenu', preventDragContextMenu, true);
    pendingDrag = null;

    if (st.started) {
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 150);
      navigator.vibrate?.(8); // háptica: el drop se registró
      // El preview muere ANTES de limpiar draggedActivityId: las vecinas
      // conservan el layout final (la store aún no re-emitio), así no saltan.
      dropPreview = computeLayoutForDrop(e.clientY, st.activityId);
      // Anclamos la tarjeta arrastrada a SU slot final: se asienta con la
      // transición CSS desde donde estaba el fantasma, sin teletransporte.
      const mine = dropPreview.get(st.activityId);
      draggedActivityId = st.activityId;
      topOverride = mine ? { id: st.activityId, start: mine.start, end: mine.end } : null;
      try {
        await commitDropAt(e.clientY);
      } finally {
        // Si la store re-emitio el mismo layout, soltar el ancla es
        // inobservable; si el commit falló, esto devuelve la UI a la BD.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            dropPreview = null;
            topOverride = null;
            lastPreviewY = NaN;
          });
        });
      }
    } else {
      dropPreview = null;
      lastPreviewY = NaN;
    }
    stopEdgeScroll(); // M5
  }

  function onDragPointerCancel() {
    const st = pendingDrag;
    cleanupDragListeners();
    if (st) {
      if (st.timer) clearTimeout(st.timer);
      st.card.classList.remove('dragging');
      st.card.style.transform = '';
      st.card.style.touchAction = '';
    }
    window.removeEventListener('contextmenu', preventDragContextMenu, true);
    // C2: reset completo — sin esto la tarjeta queda fantasma (fuera de
    // columnas, ancho completo) hasta el siguiente arrastre.
    draggedActivityId = null;
    dropPreview = null;
    topOverride = null;
    lastPreviewY = NaN;
    pendingDrag = null;
    stopEdgeScroll(); // M5
  }

  // C1: touch-action se decide cuando el dedo TOCA la pantalla (la tarjeta
  // tiene pan-y para el scroll) — cambiarlo a los 260ms del long-press ya no
  // afecta ese gesto. El único freno fiable del scroll durante el drag es un
  // touchmove no pasivo con preventDefault. Se registra al iniciar el drag
  // y se retira al terminar (el scroll normal de la página no se toca).
  function onDragTouchMove(e: TouchEvent) {
    if (pendingDrag?.started) {
      if (e.cancelable) e.preventDefault();
      if (e.touches.length === 1) {
        // Sintetiza el seguimiento del ghost por si pointermove se pierde.
        onDragPointerMove(e.touches[0] as unknown as PointerEvent);
      }
    }
  }

  function cleanupDragListeners() {
    window.removeEventListener('pointermove', onDragPointerMove);
    window.removeEventListener('pointerup', onDragPointerUp);
    window.removeEventListener('pointercancel', onDragPointerCancel);
    window.removeEventListener('touchmove', onDragTouchMove);
  }

  // ── Resize (estirar borde inferior) ──────────────────────────────────
  // Ancla del gesto de estirado: origen/fin originales + punto de agarre.
  // El preview reutiliza topOverride (slot propio) + dropPreview (vecinas),
  // así la tarjeta crece animada y las demás se deslizan igual que en el drag.
  let resizing = $state<{ id: string; origStart: number; origEnd: number; startY: number; pointerId: number } | null>(null);

  function startResize(e: PointerEvent, activity: Activity) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation(); // no iniciar drag de la tarjeta ni su click
    resizing = {
      id: activity.id!,
      origStart: parseTime(activity.startTime),
      origEnd: parseTime(activity.endTime),
      startY: e.clientY,
      pointerId: e.pointerId
    };
    // Excluye la tarjeta del clustering mientras estira (ancho completo)
    draggedActivityId = activity.id!;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    window.addEventListener('pointermove', onResizeMove, { passive: false });
    window.addEventListener('pointerup', onResizeUp);
    window.addEventListener('pointercancel', onResizeCancel);
  }

  /** Slots del día tras estirar hasta clientY (cascada compartida, snap 15min). */
  function computeResizePreview(clientY: number): { id: string; start: number; end: number }[] | null {
    const track = document.querySelector('.activities-track');
    if (!track || !resizing) return null;
    const rect = track.getBoundingClientRect();
    const deltaH = ((clientY - resizing.startY) / rect.height) * totalHours;
    let newEnd = Math.round((resizing.origEnd + deltaH) * 4) / 4;
    newEnd = Math.max(resizing.origStart + 0.25, Math.min(newEnd, endHour)); // mín 15min
    const slots = dayActivities
      .filter(a => a.id !== resizing!.id)
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    // El resize no reubica el arrastrado (keepPlace): conserva su inicio y
    // solo empuja lo que pisa al estirar.
    return resolveDayCascade(
      [...slots, { id: resizing.id, start: resizing.origStart, end: newEnd }],
      endHour, resizing.id, startHour, true
    );
  }

  function onResizeMove(e: PointerEvent) {
    if (!resizing) return;
    e.preventDefault();
    const resolved = computeResizePreview(e.clientY);
    if (!resolved) return;
    const mine = resolved.find(s => s.id === resizing!.id)!;
    topOverride = { id: resizing.id, start: mine.start, end: mine.end };
    dropPreview = new Map(resolved.map(s => [s.id, { start: s.start, end: s.end }]));
  }

  async function onResizeUp(e: PointerEvent) {
    const st = resizing;
    cleanupResizeListeners();
    resizing = null;
    draggedActivityId = null;
    if (!st) return;
    const resolved = computeResizePreview(e.clientY);
    if (resolved) {
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 150);
      await commitResolved(new Map(resolved.map(s => [s.id, { start: s.start, end: s.end }])));
    }
    requestAnimationFrame(() => requestAnimationFrame(() => { dropPreview = null; topOverride = null; }));
  }

  function onResizeCancel() {
    cleanupResizeListeners();
    resizing = null;
    draggedActivityId = null;
    dropPreview = null;
    topOverride = null;
  }

  function cleanupResizeListeners() {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeUp);
    window.removeEventListener('pointercancel', onResizeCancel);
  }

  /** Aplica el drop en la posición final (clientY en px de viewport). */
  async function commitDropAt(clientY: number) {
    const track = document.querySelector('.activities-track');
    if (!track || draggedActivityId === null) return;

    // Misma matemática que el preview en vivo: lo que se vio mientras se
    // arrastraba es exactamente lo que se guarda.
    const resolved = computeLayoutForDrop(clientY, draggedActivityId);
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

  /** M6: mueve una actividad ±15 min (teclado) respetando la cascada. */
  async function nudgeActivity(activity: Activity, deltaH: number) {
    const dur = parseTime(activity.endTime) - parseTime(activity.startTime);
    let newStart = Math.round((parseTime(activity.startTime) + deltaH) * 4) / 4;
    newStart = Math.max(startHour, Math.min(newStart, endHour - dur));
    const slots = dayActivities
      .filter(a => a.id !== activity.id)
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    const resolved = resolveDayCascade(
      [...slots, { id: activity.id!, start: newStart, end: newStart + dur }],
      endHour, activity.id!, startHour
    );
    await commitResolved(new Map(resolved.map(sl => [sl.id, { start: sl.start, end: sl.end }])));
  }

  /** Escribe un layout resuelto (id → slot) al override del día visible. */
  async function commitResolved(resolved: Map<string, { start: number; end: number }>) {
    const overrideActs = await ensureOverride();
    for (const [id, slot] of resolved) {
      const act = overrideActs.find(a => a.id === id);
      if (act) {
        act.startTime = formatTime(slot.start);
        act.endTime = formatTime(slot.end);
      }
    }
    const stamp = Date.now();
    const ovBefore = await db.dayOverrides.get(day) ?? null;
    await db.dayOverrides.put({
      day,
      activities: $state.snapshot(overrideActs),
      updatedAt: stamp
    });
    // Undo: el snapshot del override captura el día completo (actividades
    // incluidas) — commitResolved nunca toca filas master.
    pushUndo({
      label: `Mover en ${DAY_NAMES[day]}`,
      rows: [],
      overrides: [{ day, before: ovBefore, after: await db.dayOverrides.get(day) ?? null }]
    });
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
  }

  // Context Menu logic
  let contextMenu = $state({ show: false, x: 0, y: 0, activityId: null as string | null });

  // Lightbox para ver la imagen de la rutina
  let viewingImageActivity = $state<Activity | null>(null);

  const contextMenuActivity = $derived(
    contextMenu.activityId !== null
      ? dayActivities.find(a => a.id === contextMenu.activityId) || null
      : null
  );

  function handleContextMenu(e: MouseEvent, activityId: number) {
    e.preventDefault();
    // Clamp para que el menú no se salga de la ventana
    const MENU_W = 220;
    const MENU_H = 130;
    const x = Math.min(e.clientX, window.innerWidth - MENU_W - 8);
    const y = Math.min(e.clientY, window.innerHeight - MENU_H - 8);
    contextMenu = { show: true, x: Math.max(4, x), y: Math.max(4, y), activityId };
  }

  function closeContextMenu() {
    contextMenu.show = false;
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
        toastErr('No hay hueco libre para duplicar');
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
      toastOk(`${clone.name} → ${format12h(clone.startTime)}`);
    } else {
      // ── Modo Plantilla: duplicar como actividad maestra en el mismo día ──
      const days = source.daysOfWeek?.length ? source.daysOfWeek : [day];
      const clone = await duplicateActivityOp(sourceId, {
        startHour,
        endHour,
        days
      });
      if (clone) {
        toastOk(`${clone.name} → ${format12h(clone.startTime)}`);
      } else {
        toastErr('No hay hueco libre para duplicar');
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
            label: `Quitar ${victim.name} de ${DAY_NAMES[day]}`,
            rows: [],
            overrides: [{ day, before: ovBefore ?? null, after: await db.dayOverrides.get(day) ?? null }]
          });
        }
      } else {
        const before = await db.activities.get(id);
        await db.activities.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
        if (before) {
          pushUndo({ label: `Eliminar ${before.name}`, rows: [{ before, after: await db.activities.get(id) ?? null }] });
        }
      }
      toastOk('Actividad eliminada');
    } catch (err: any) {
      toastErr('No se pudo eliminar: ' + (err?.message || err));
    }
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="daily-view">
  <div class="daily-header">
    <div class="header-top-row">
      <h2>{dayName}</h2>
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
        <Zap size={14} /> Solo este día
      </button>
      <button
        class="mode-btn"
        class:active={!isTemporaryMode}
        onclick={() => isTemporaryMode = false}
      >
        <Calendar size={14} /> Plantilla semanal
      </button>
    </div>

    <!-- Override banner -->
    {#if isTemporaryMode && hasOverride}
      <div class="override-banner">
        <span class="banner-text">⚡ Cambios temporales activos</span>
        <div class="banner-actions">
          <button class="btn-banner btn-restore" onclick={restoreDefaultTemplate}>
            <RotateCcw size={14} /> Restaurar
          </button>
          <button class="btn-banner btn-save" onclick={saveAsPermanentTemplate}>
            <Save size={14} /> Aplicar a semana
          </button>
        </div>
      </div>
    {/if}
  </div>

  <div class="daily-container">
    <div class="time-track">
      {#each Array.from({ length: totalHours + 1 }, (_, i) => startHour + i) as hour}
        <div class="hour-marker" style="top: {((hour - startHour) / totalHours) * 100}%">
          <span>{hour % 12 || 12}:00 {hour < 12 ? 'AM' : (hour === 24 ? 'AM' : 'PM')}</span>
        </div>
      {/each}
    </div>

    <div class="activities-track" onclick={handleTrackTap} role="presentation">
      {#if layoutActivities.length === 0}
        <div class="empty-state glass-panel" aria-live="polite">
          <span class="empty-icon">🌱</span>
          <p>Día libre — tocá cualquier hueco del horario para crear una actividad</p>
        </div>
      {/if}
      {#key day}
      {#each layoutActivities as activity (activity.id)}
        {@const totalSteps = activity.steps?.length || 0}
        {@const doneSteps = activity.steps?.filter(s => s.completed).length || 0}
        <div
          class="daily-activity-card glass-panel"
          class:is-short={activity.durationMins <= 20}
          role="button"
          tabindex="0"
          aria-label="{activity.name}, {format12h(activity.startTime)} a {format12h(activity.endTime)}{totalSteps ? `, ${doneSteps} de ${totalSteps} pasos` : ''}. Arrastrar o tocar para editar"
          onpointerdown={(e) => handlePointerDown(e, activity)}
          oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
          onclick={() => { if (suppressNextClick) return; onEditActivity(activity.id!, activity); }}
          onkeydown={(e) => {
            // M6 (WCAG 2.5.7): mover sin puntero. ↑/↓ = ±15 min con cascada;
            // Enter abre edición; Espacio SOLO activa (preventDefault: la
            // tarjeta no puede desplazar la página).
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              nudgeActivity(activity, e.key === 'ArrowUp' ? -0.25 : 0.25);
            } else if (e.key === ' ') {
              e.preventDefault();
              if (!suppressNextClick) onEditActivity(activity.id!, activity);
            } else if (e.key === 'Enter') {
              onEditActivity(activity.id!, activity);
            }
          }}
          style="top: {activity.top}; height: {activity.height}; left: {activity.left}; width: {activity.width}; border-left-color: {getActivityColor(activity.categoryId, categories)}"
        >
          <div class="activity-content" class:compact={activity.durationMins <= 20}>
            <div class="activity-title-group">
              <span class="activity-name">{activity.name}</span>
              {#if activity.image}
                <button
                  type="button"
                  class="activity-image-thumb"
                  title="Ver imagen de la rutina"
                  aria-label="Ver imagen de {activity.name}"
                  onclick={(e) => { e.stopPropagation(); viewingImageActivity = activity; }}
                >
                  <img src={activity.image} alt="" />
                </button>
              {/if}
              {#if totalSteps > 0 && activity.durationMins > 20}
                <span class="activity-steps-badge" class:all-done={doneSteps === totalSteps && totalSteps > 0} title="{doneSteps} de {totalSteps} pasos completados">
                  <ListChecks size={12} /> {doneSteps}/{totalSteps}
                </span>
              {/if}
            </div>
            <button
              class="edit-btn"
              onclick={(e) => { e.stopPropagation(); onEditActivity(activity.id!, activity); }}
              aria-label="Editar {activity.name}"
              title="Editar"
            >
              <Edit3 size={13} />
            </button>
          </div>
          <div
            class="resize-handle"
            aria-hidden="true"
            onpointerdown={(e) => startResize(e, activity)}
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
    <div class="custom-context-menu glass-panel" style="top: {contextMenu.y}px; left: {contextMenu.x}px">
      <button onclick={duplicateActivity}>
        <Copy size={16} /> Duplicar (Independiente)
      </button>
      {#if contextMenuActivity?.image}
        <button onclick={() => { viewingImageActivity = contextMenuActivity; }}>
          <ImageIcon size={16} /> Ver imagen
        </button>
      {/if}
      <button class="delete-btn" onclick={askDeleteActivity}>
        <Trash2 size={16} /> Eliminar
      </button>
    </div>
  {/if}

  <ConfirmDialog
    bind:open={confirmDelete}
    title="Eliminar actividad"
    message="¿Eliminar esta actividad del día? Esta acción no se puede deshacer."
    confirmText="Eliminar"
    danger
    onconfirm={deleteActivity}
  />
  <ConfirmDialog
    bind:open={confirmRestore}
    title="Restaurar plantilla"
    message="¿Restaurar la plantilla por defecto para este día? Se perderán los cambios temporales."
    confirmText="Restaurar"
    danger
    onconfirm={doRestoreDefault}
  />
  <ConfirmDialog
    bind:open={confirmSavePermanent}
    title="Aplicar como plantilla semanal"
    message="¿Aplicar estos cambios temporales como la plantilla semanal permanente? Reemplazará las actividades de este día en toda la semana."
    confirmText="Aplicar"
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

  .daily-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--color-green-dark);
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
    color: #888;
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
    color: #888;
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

  /* Entrada escalonada al cambiar de día: se re-monta el track ({#key day})
     y nth-child reparte los delays — cero JS, cero bytes en el chunk. */
  .daily-activity-card {
    animation: fadeIn .25s ease-out backwards;
  }
  .daily-activity-card:nth-child(2) { animation-delay: 20ms }
  .daily-activity-card:nth-child(3) { animation-delay: 40ms }
  .daily-activity-card:nth-child(4) { animation-delay: 60ms }
  .daily-activity-card:nth-child(5) { animation-delay: 80ms }
  .daily-activity-card:nth-child(n+6) { animation-delay: 100ms }

  /* Estado de arrastre activo (pointer drag) */
  .daily-activity-card.dragging {
    /* Sin lag: la tarjeta sigue el dedo/cursor 1:1 (se mueve por transform,
       no por top — su top/height animan hacia el slot predicho como las
       demás, pero las tapa el fantasma que sigue al cursor). */
    transition: opacity 0.15s, box-shadow 0.15s;
    opacity: 0.85;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.25);
    z-index: 100;
    cursor: grabbing;
    will-change: transform;
  }

  /* Accesibilidad: quien pide menos movimiento no recorre la cascada —
     los cambios de posición son instantáneos, sin deslizamientos. */
  @media (prefers-reduced-motion: reduce) {
    .daily-activity-card,
    .daily-activity-card.dragging,
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
    border: none;
    padding: 0;
    background: none;
    cursor: zoom-in;
    border-radius: 6px;
    overflow: hidden;
    width: 30px;
    height: 30px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
    transition: transform 0.15s;
  }

  .activity-image-thumb:hover {
    transform: scale(1.12);
  }

  .activity-image-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
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
    padding: 0.35rem;
    min-width: 32px;
    min-height: 32px;
    display: grid;
    place-items: center;
    border-radius: 8px;
    opacity: 0;
    transition: all 0.2s;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
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
    background: #e53e3e;
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
      width: 55px;
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
    .override-banner {
      flex-direction: column;
      align-items: flex-start;
    }
  }

  @media (max-width: 480px) {
    .daily-activity-card {
      padding: 0.3rem 0.5rem;
    }
    .activity-content {
      padding-right: 1.75rem;
      gap: 0.25rem;
    }
    .activity-name {
      font-size: 0.82rem;
    }    .time-track {
      width: 48px;
    }
    .hour-marker {
      font-size: 0.65rem;
      padding-right: 0.2rem;
    }
    .mode-btn {
      font-size: 0.72rem;
      padding: 0.35rem 0.6rem;
    }
  }
</style>
