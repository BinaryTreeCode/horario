<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, getActivityColor, textOn, formatTime, format12h } from '../lib/stores';
  import { resolveDayCascade, resolveResizeDay, resolveNudgeDay, propagateWeekly, capacidadResizeWeekly, barridoRetiro } from '../lib/cascade';
  import type { WeeklyResolution } from '../lib/cascade';
  import { db } from '../lib/db';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import { Copy, Trash2, ListChecks, ImageIcon, Plus } from '@lucide/svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr, toastErrRepetido } from '../lib/toast';
  import { cloneAct } from '../lib/undo';
  import { portal } from '../lib/portal';
  import { createDragEngine, type DragHooks, type DragTarget } from '../lib/dragEngine';
  import { t, tNow } from '../lib/i18n';

  interface Props {
    activities: Activity[];
    categories: Category[];
    settings: { startHour: number; endHour: number };
    dayOverrides?: DayOverride[];
    onSelectDay: (day: number) => void;
    // initialData: draft precargado (crear en hueco vía click derecho)
    onEditActivity: (id: string | null, initialData?: Activity) => void;
  }

  let { activities, categories, settings, dayOverrides = [], onSelectDay, onEditActivity }: Props = $props();

  // ── Menú de hueco: click derecho en espacio vacío de una columna ──
  let emptySlotMenu = $state({ show: false, x: 0, y: 0, day: -1, hour: 0 });

  /** Click derecho en un hueco de la grilla semanal: ofrece crear ahí. */
  function handleGridContextMenu(e: MouseEvent, day: number) {
    const target = e.target as HTMLElement;
    if (target.closest('.activity-item, .custom-context-menu, button')) return;
    e.preventDefault();
    emptySlotMenu.show = false;
    const grid = e.currentTarget as HTMLElement;
    const rect = grid.getBoundingClientRect();
    const hour = Math.max(
      startHour,
      Math.min(Math.round(((e.clientY - rect.top) / rect.height * (endHour - startHour) + startHour) * 4) / 4, endHour - 0.25)
    );
    const MENU_W = 220;
    const MENU_H = 44;
    emptySlotMenu = {
      show: true,
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
      day,
      hour
    };
  }

  /** Abre el modal de creación en el día del hueco, con la hora del click. */
  function createAtEmptySlotWeekly() {
    const { day, hour } = emptySlotMenu;
    emptySlotMenu.show = false;
    if (day < 0) return;
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    const fmt = (v: number) => v.toString().padStart(2, '0');
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

  /** Hora decimal → "HH:MM" para el label del menú de hueco. */
  function horasAHoraReloj(hour: number): string {
    const h = Math.floor(hour);
    const m = Math.round((hour - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  // ── Drag & Drop: la mecánica vive en src/lib/dragEngine.ts (dueño único,
  // compartida con la vista Día). El quiet-hold táctil (G6) se ELIMINÓ (F3
  // del plan v2): el dedo quieto ya no cancela el drag — era la causa de
  // arrastres "trabados". El menú contextual queda solo para mouse (click
  // derecho); "Duplicar" vive en el modal de edición.
  // (La supresión del click sintético post-drag vive en el motor.)

  function openContextMenu(activityId: string, x: number, y: number) {
    // Solo mouse (click derecho). Clamp para que el menú no se salga de la
    // ventana (MENU_H: 2 items × 44px + padding — con 130 quedaba fuera en
    // landscape; ya no cuenta "Duplicar", que vive en el modal).
    const MENU_W = 220;
    const MENU_H = 160;
    const cx = Math.min(x, window.innerWidth - MENU_W - 8);
    const cy = Math.min(y, window.innerHeight - MENU_H - 8);
    contextMenu = { show: true, x: Math.max(4, cx), y: Math.max(4, cy), activityId };
  }

  const engine = createDragEngine({
    ghostClass: 'drag-ghost',
    scrollAxis: 'x',
    // El scroller real del eje x es el CONTENEDOR (.grid-scroll es flex,
    // overflow visible): el auto-scroll de bordes necesita el que tiene
    // overflow-x:auto.
    scrollContainer: () => document.querySelector('.weekly-grid-container')
  });

  onDestroy(() => engine.destroy());

  const days = $derived([0, 1, 2, 3, 4, 5, 6].map(i => $t(`day.${i}`)));
  // Estado vacío de la SEMANA. Se deriva de `activities` (el prop crudo) y no
  // de getDayActivitiesWithLayout(): pedirle el layout a los 7 dias otra vez
  // solo para contar activities duplicaria el trabajo mas caro del render.
  const semanaVacia = $derived(activities.filter(a => !a.deletedAt).length === 0);
  // Señalización del día actual: JS getDay() → 0=domingo…6=sábado, igual que
  // el índice de columnas. Se fija al montar (la vista no vive cruzando
  // medianoche: el usuario recarga o cambia de pestaña antes).
  const hoyIdx = getHoyIdx();
  function getHoyIdx(): number {
    try {
      const d = new Date().getDay();
      // Domingo=0 en JS pero la semana de la app arranca en Lunes (índice 0):
      // L,M,X,J,V = 1..5 → 0..4; Sábado=6 → 5; Domingo=0 → 6.
      return d === 0 ? 6 : d - 1;
    } catch {
      return -1;
    }
  }
  const startHour = $derived(settings.startHour);
  const endHour = $derived(settings.endHour);
  const totalHours = $derived(endHour - startHour);
  
  // 15-minute precision (4 slots per hour)
  const slotsPerHour = 4;
  /** Altura de slot en px. En viewports anchos (≥1536px) sube a 30px para
   *  aprovechar pantallas grandes/ultrawide: la matemática del drag no cambia
   *  porque usa esta constante (reactiva) y el rect vivo del grid. */
  const ALTURA_COMPACTA = 26; // ≥26px/slot: bloques de 15min tocables (~44px los de 30min, 104px los de 1h)
  const ALTURA_GRANDE = 30;
  let slotHeightPx = $state(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1536px)').matches ? ALTURA_GRANDE : ALTURA_COMPACTA
  );
  const totalSlots = $derived(totalHours * slotsPerHour);

  $effect(() => {
    const mq = window.matchMedia('(min-width: 1536px)');
    const sync = () => { slotHeightPx = mq.matches ? ALTURA_GRANDE : ALTURA_COMPACTA; };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  const hours = $derived(Array.from({ length: totalHours + 1 }, (_, i) => startHour + i));

  /** Codec de tiempos inyectable a la cascada (única instancia). */
  const CODEC = { parse: parseTime, format: formatTime };

  // Calculate grid row position with 15-min precision using round
  function getRowPosition(timeStr: string) {
    const time = parseTime(timeStr);
    const offset = time - startHour;
    return Math.max(1, Math.round(offset * slotsPerHour) + 1);
  }

  interface LayoutActivity extends Activity {
    rowStart: number;
    rowEnd: number;
    numSlots: number;
    top: string;
    height: string;
    left: string;
    width: string;
  }

  // Filter, calculate precise row slots and resolve overlaps per day.
  // Layout absoluto (top/height en %) en vez de grid-row: permite animar la
  // cascada con transition CSS (grid-row no es animable). Los tracks son los
  // mismos clusters de solape de antes.
  function getDayActivitiesWithLayout(dayIndex: number, preview?: Map<string, { start: number; end: number }>, excludeId?: string | null) {
    const dayActs = activities
      .filter((a: Activity) => a.daysOfWeek.includes(dayIndex))
      .map(a => {
        const p = preview?.get(a.id!);
        return {
          ...a,
          _start: p ? p.start : parseTime(a.startTime),
          _end: p ? p.end : parseTime(a.endTime)
        };
      })
      .sort((a, b) => a._start - b._start || (b._end - b._start) - (a._end - a._start));

    if (dayActs.length === 0) return { items: [] as LayoutActivity[], maxCols: 1 };

    // En pleno drag la tarjeta arrastrada NO participa en clusters/tracks:
    // es un fantasma (sigue al cursor); excluirla evita que una vecina que
    // ocupa su hueco la parta en columnas angostas.
    const layoutable = excludeId ? dayActs.filter(a => a.id !== excludeId) : dayActs;
    if (layoutable.length === 0) {
      // Solo el fantasma: se dibuja a ancho completo en su slot de BD.
      const d = dayActs.find(a => a.id === excludeId)!;
      return {
        items: [ghostItem(d)],
        maxCols: 1
      };
    }

    // Group into clusters of overlapping activities
    const clusters: (typeof layoutable)[] = [];
    let currentCluster: typeof layoutable = [];
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
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    let overallMaxCols = 1;
    const preliminaryItems: { act: typeof layoutable[0]; track: number; clusterCols: number }[] = [];

    for (const cluster of clusters) {
      const tracks: number[] = [];
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
        preliminaryItems.push({ act, track: assigned, clusterCols: 0 });
      }

      const cCols = Math.max(1, tracks.length);
      if (cCols > overallMaxCols) overallMaxCols = cCols;

      for (let j = preliminaryItems.length - cluster.length; j < preliminaryItems.length; j++) {
        preliminaryItems[j].clusterCols = cCols;
      }
    }

    const resultItems: LayoutActivity[] = preliminaryItems.map(item => {
      const s = item.act._start;
      const e = item.act._end;
      const topPct = ((s - startHour) / totalHours) * 100;
      const heightPct = ((e - s) / totalHours) * 100;
      // El ancho sale de las columnas de SU PROPIO grupo de solapamiento, no
      // del maximo de la semana. Con overallMaxCols, un solo solapamiento en
      // cualquier dia y a cualquier hora encogia al 50% los 123 bloques de la
      // rejilla: en un movil eso son 27px de ancho para el nombre, y 97 de
      // esos bloques ni siquiera se solapaban con nadie. clusterCols ya se
      // calculaba justo aqui y se guardaba sin usar.
      const cols = item.clusterCols;
      const widthPct = 100 / cols;
      const leftPct = item.track * widthPct;
      return {
        ...item.act,
        rowStart: getRowPosition(item.act.startTime),
        rowEnd: Math.max(getRowPosition(item.act.startTime) + 1, getRowPosition(item.act.endTime)),
        numSlots: Math.max(1, Math.round((e - s) * slotsPerHour)),
        top: `${topPct}%`,
        height: `calc(${heightPct}% - 3px)`,
        left: `${cols > 1 ? leftPct : 0}%`,
        width: cols > 1 ? `calc(${widthPct}% - 3px)` : '100%'
      };
    });

    // El fantasma se reinserta a ancho completo, en su slot de BD (el cursor lo transporta).
    if (excludeId) {
      const d = dayActs.find(a => a.id === excludeId);
      if (d) resultItems.push(ghostItem(d));
    }

    return { items: resultItems, maxCols: overallMaxCols };
  }

  function ghostItem(d: any): LayoutActivity {
    const s = parseTime(d.startTime);
    const e = parseTime(d.endTime);
    const topPct = ((s - startHour) / totalHours) * 100;
    const heightPct = ((e - s) / totalHours) * 100;
    return {
      ...d,
      rowStart: getRowPosition(d.startTime),
      rowEnd: Math.max(getRowPosition(d.startTime) + 1, getRowPosition(d.endTime)),
      numSlots: Math.max(1, Math.round((e - s) * slotsPerHour)),
      top: `${topPct}%`,
      height: `calc(${heightPct}% - 3px)`,
      left: '0%',
      width: '100%'
    };
  }

  // Drag and Drop handlers (mecánica en src/lib/dragEngine.ts)
  let draggedActivityId = $state<string | null>(null);
  let dragSourceDay = $state<number | null>(null);
  let dragOffsetHours = 0;
  /** Firma del último preview publicado: si no cambió por CONTENIDO, no se
   *  reasigna (las transiciones CSS no se relanzan → cero parpadeo). */
  let firmaPreview = '';

  /** Columna + grid bajo el puntero (null = fuera de la grilla). */
  function dropTargetAt(x: number, y: number): { day: number; grid: HTMLElement } | null {
    const col = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.day-column');
    if (!col) return null;
    const day = [...document.querySelectorAll('.day-column')].indexOf(col);
    const grid = document.querySelectorAll('.slots-grid')[day] as HTMLElement | undefined;
    return day >= 0 && grid ? { day, grid } : null;
  }

  

  const dragHooks: DragHooks = {
    onActivate(t) {
      draggedActivityId = t.activityId;
      dragSourceDay = (t.meta as { day: number }).day;
      firmaPreview = '';
    },
    onMove(t, x, y) {
      // Sincrónico a propósito: la protección anti-jitter NO es el throttle
      // (los rAF pueden venir throttled) sino la doble barrera determinista
      // de publicarPreview: histéresis en la mitad + firma por contenido que
      // evita reescribir el layout si el resultado no cambió.
      dragGhostXY = { x, y };
      if (draggedActivityId === null) return;
      actualizarPreview(x, y);
    },
    async onDrop(t, x, y) {
      const sourceDay = (t.meta as { day: number }).day;
      const activity = activities.find(a => a.id === t.activityId);
      if (!activity) { clearDragPreview(); return; }
      const target = dropTargetAt(x, y);
      const day = target?.day ?? sourceDay;
      const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
      // La MISMA matemática del preview decide validez y layout: lo que se
      // vio es lo que se guarda. Inválido → toast ⛔ y el bloque vuelve.
      if (target) {
        const rect = target.grid.getBoundingClientRect();
        const fingerHour = startHour + (y - rect.top) / (slotHeightPx * slotsPerHour);
        let newStart = Math.round((startHour + (y - rect.top) / (slotHeightPx * slotsPerHour) - dragOffsetHours) * 4) / 4;
        newStart = Math.max(startHour, Math.min(newStart, endHour - duration));
        const targetSlots = activities
          .filter(a => a.daysOfWeek.includes(day))
          .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
        const crossInto = !activity.daysOfWeek.includes(day);
        const res = resolveDayCascade(
          targetSlots,
          { id: t.activityId, start: newStart, end: newStart + duration },
          fingerHour,
          crossInto,
          startHour,
          endHour
        );
        if (!res.valido) {
          // Puerta de repetición: 1er fallo silencioso, al insistir → toast.
          toastErrRepetido(`mover-semana:${day}`, res.motivo);
          clearDragPreview();
          return;
        }
        // ── Cascada completa con RECHAZO multi-día: si el movimiento choca
        // en otro día, NO se escribe nada y el bloque vuelve (antes la
        // "pared" empujaba ajenos sin permiso).
        dragSourceDay = sourceDay;
        const cascada = computeFullCascade(t.activityId, day, res.movido.start, res);
        if (!cascada.valido) {
          // Puerta de repetición: 1er fallo silencioso, al insistir → toast.
          toastErrRepetido(`mover-semana:${day}`, cascada.motivo);
          clearDragPreview();
          return;
        }
        dropPreview = { day, slots: new Map(res.slots.map(s => [s.id, { start: s.start, end: s.end }])) };
        let newDays = [...activity.daysOfWeek];
        const idx = newDays.indexOf(sourceDay);
        if (idx !== -1) {
          newDays[idx] = day;
        } else if (!newDays.includes(day)) {
          newDays.push(day);
        }
        newDays = [...new Set(newDays)].sort((a, b) => a - b);
        // Asentado suave: el dropPreview ya posiciona la tarjeta en su slot
        // final; el commit corre debajo y el doble rAF suelta el ancla sin
        // salto (igual que la vista Día).
        try {
          await commitWeeklyTimes(cascada.times, `Mover ${activity.name} a ${days[day]}`, { id: t.activityId, days: newDays });
        } finally {
          settle2(() => clearDragPreview());
        }
        return;
      }
      // Soltar FUERA de la grilla = cancelar (el bloque vuelve a su sitio):
      // nunca commit-un-movimiento-al-startHour (corruptor silencioso).
      clearDragPreview();
    },
    onCancel() {
      // C2: soltar fuera de la grilla, Esc o cancel — sin reset la tarjeta
      // queda con opacidad y fuera del layout hasta el próximo arrastre.
      clearDragPreview();
    }
  };

  /** Doble rAF: la store re-emite y el navegador pinta antes de soltar el ancla. */
  /** Doble rAF con fallback por timeout: ver settle2 de la vista Día
   *  (rAF throttled en navegadores embebidos → la limpieza nunca correría). */
  const settle2 = (fn: () => void) => {
    let done = false;
    const run = () => { if (!done) { done = true; fn(); } };
    requestAnimationFrame(() => requestAnimationFrame(run));
    setTimeout(run, 160);
  };

  /**
   * Recalcula el preview del drop (throttled por rAF desde onMove). Hora
   * CRUDA del dedo decide hueco vs mitades; histéresis en el umbral; el
   * resultado solo se publica si difiere por CONTENIDO del anterior.
   */
  function actualizarPreview(x: number, y: number) {
    if (draggedActivityId === null) return;
    const activity = activities.find(a => a.id === draggedActivityId);
    if (!activity) return;
    const target = dropTargetAt(x, y);
    if (!target) {
      publicarPreview(null, null, false, '');
      return;
    }
    const duration = parseTime(activity.endTime) - parseTime(activity.startTime);
    const rect = target.grid.getBoundingClientRect();
    const fingerHour = startHour + (y - rect.top) / (slotHeightPx * slotsPerHour);
    const start = Math.round((startHour + (y - rect.top) / (slotHeightPx * slotsPerHour) - dragOffsetHours) * 4) / 4;
    const snapped = Math.max(startHour, Math.min(start, endHour - duration));
    const targetSlots = activities
      .filter(a => a.daysOfWeek.includes(target.day))
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    const crossInto = !activity.daysOfWeek.includes(target.day);
    const res = resolveDayCascade(
      targetSlots,
      { id: activity.id!, start: snapped, end: snapped + duration },
      fingerHour,
      crossInto,
      startHour,
      endHour
    );
    publicarPreview(
      target.day,
      res.valido ? res.slots : null,
      !res.valido,
      !res.valido ? '⛔ No cabe' : res.accion === 'insertar' ? '↕ Insertar aquí' : ''
    );
  }

  /** Publica el preview solo si el contenido cambió (anti-parpadeo). */
  function publicarPreview(day: number | null, slots: { id: string; start: number; end: number }[] | null, invalido: boolean, hint: string) {
    const firma = slots ? `${day}:${slots.map(s => `${s.id}@${s.start}-${s.end}`).join('|')}` : 'null';
    if (draggedActivityId !== null) {
      const mio = slots?.find(s => s.id === draggedActivityId);
      if (mio) dragGhostHora = `${format12h(formatTime(mio.start))} – ${format12h(formatTime(mio.end))}`;
      // (El resalte de mitad del pisado se retiró: el feedback de posición
      // vive en el clon flotante — hora proyectada + acción del drop.)
    }
    if (firma === firmaPreview) {
      setInvalid(invalido); // el texto puede cambiar sin cambiar el layout
      dragHint = hint;
      return;
    }
    firmaPreview = firma;
    setInvalid(invalido);
    dragHint = hint;
    dropPreview = slots ? { day: day!, slots: new Map(slots.map(s => [s.id, { start: s.start, end: s.end }])) } : null;
  }

  function handleItemPointerDown(e: PointerEvent, activity: Activity, dayIndex: number) {
    const card = e.currentTarget as HTMLElement;
    const rect = card.getBoundingClientRect();
    dragOffsetHours = ((e.clientY - rect.top) / rect.height) * (parseTime(activity.endTime) - parseTime(activity.startTime));
    // Métricas del clon flotante estilo demo: el bloque flotará anclado al
    // MISMO punto relativo donde se agarró (grabDX/DY) y con su tamaño real.
    grabDX = e.clientX - rect.left;
    grabDY = e.clientY - rect.top;
    grabW = rect.width;
    grabH = rect.height;
    // El motor arma: mouse por umbral (5px), táctil por long-press (260ms).
    engine.begin(e, { card, activityId: activity.id!, meta: { day: dayIndex } }, dragHooks);
  }

  /**
   * Vista previa del drop (igual que la vista Día): id → {start, end} en
   * horas, calculada en dragover SIN tocar la BD. Las actividades del día
   * destino se deslizan en vivo vía transition CSS hacia su posición
   * predicha. null = sin drag activo.
   */
  let dropPreview = $state<{ day: number; slots: Map<string, { start: number; end: number }> } | null>(null);
  /** Drop inválido: no cabe / pisaría — tarjeta roja y al soltar vuelve. */
  let dragInvalid = $state(false);
  /** Shake one-shot del clon flotante: solo en la transición válido→inválido;
   *  pegado a .invalido se reiniciaría en cada pointermove = zumbido. */
  let shakeInvalid = $state(false);
  let shakeTimer: ReturnType<typeof setTimeout> | null = null;
  function setInvalid(v: boolean) {
    if (v && !dragInvalid) {
      shakeInvalid = true;
      if (shakeTimer) clearTimeout(shakeTimer);
      shakeTimer = setTimeout(() => { shakeInvalid = false; }, 350);
    } else if (!v) {
      shakeInvalid = false;
      if (shakeTimer) { clearTimeout(shakeTimer); shakeTimer = null; }
    }
    dragInvalid = v;
  }
  /** Rótulo del gesto dentro del fantasma: qué hará el drop. */
  let dragHint = $state('');
  /** Rótulo flotante del RESIZE vertical: por qué el bloque no crece
   *  ("↕ Limitado por…"). null = sin gesto o sin límite alcanzado. */
  let vresHint = $state<{ texto: string; x: number; y: number } | null>(null);
  /** Posición del cursor para el fantasma flotante (null = sin drag). */
  let dragGhostXY = $state<{ x: number; y: number } | null>(null);
  /** Hora proyectada del fantasma: el slot final del arrastrado en el preview. */
  let dragGhostHora = $state('');
  /** Punto de agarre dentro del bloque (px) y tamaño real: el clon flotante
   *  se dibuja en el mismo punto relativo al cursor — cero salto al armar
   *  (patrón .bloque.flotante de la demo). Se capturan en pointerdown. */
  let grabDX = 0;
  let grabDY = 0;
  let grabW = 0;
  let grabH = 0;
  /** Actividad y color del fantasma flotante (clon visual del bloque). */
  const ghostActivity = $derived(activities.find(a => a.id === draggedActivityId) ?? null);
  const ghostColor = $derived(ghostActivity ? getActivityColor(ghostActivity.categoryId, categories) : '#2d3748');

  /**
   * Cascada completa para el commit: TODOS los días de la actividad (incluido
   * el destino si el drag cruza columnas). Devuelve la resolución COMPLETA:
   * si el movimiento choca en otro día (o algún día desborda) → valido=false
   * y NO se escribe nada (el bloque vuelve). Es la regla del usuario: mover
   * jamás empuja fuera del día del drop.
   */
  function computeFullCascade(
    actId: string,
    targetDay: number,
    anchorStart: number,
    resDestino?: { slots: { id: string; start: number; end: number }[] }
  ): WeeklyResolution {
    const activity = activities.find(a => a.id === actId);
    if (!activity) return { byDay: new Map(), times: new Map(), valido: false, motivo: '⛔ Actividad no encontrada' };
    const origDays = activity.daysOfWeek;
    const finalDays = dragSourceDay !== null && origDays.includes(dragSourceDay)
      ? [...origDays.filter(d => d !== dragSourceDay), targetDay]
      : [...origDays];
    // Con resDestino el día del drop se siembra EXACTO (lo que se vio);
    // los demás días se validan contra el slot anclado (sin empujar a nadie).
    return propagateWeekly(
      activities, actId, anchorStart, endHour, CODEC, [...new Set(finalDays)],
      undefined, 0, false,
      resDestino ? { day: targetDay, slots: resDestino.slots } : undefined
    );
  }



  // M6 (WCAG 2.5.7): mover sin puntero. ±15 min es un deseo EXACTO: la
  // actividad ancla como pared y empuja en cadena en TODOS sus días (el
  // teclado no tiene dedo ni mitades). Si algún día desborda → ⛔ y nada
  // se escribe.
  async function nudgeWeekly(activity: Activity, deltaH: number) {
    if (draggedActivityId !== null) return;
    const dur = parseTime(activity.endTime) - parseTime(activity.startTime);
    let newStart = Math.round((parseTime(activity.startTime) + deltaH) * 4) / 4;
    newStart = Math.max(startHour, Math.min(newStart, endHour - dur));
    const times = new Map<string, { start: number; end: number }>();
    let invalido = false;
    for (const d of activity.daysOfWeek) {
      const daySlots = activities
        .filter(a => a.daysOfWeek.includes(d))
        .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
      const res = resolveNudgeDay(daySlots, activity.id!, newStart, startHour, endHour);
      if (!res.valido) invalido = true;
      for (const s of res.slots) {
        times.set(s.id, { start: s.start, end: s.end });
      }
    }
    if (invalido) { toastErrRepetido(`teclado-sem:${activity.id}`, '⛔ No cabe: el empuje desbordaría el día'); return; }
    await commitWeeklyTimes(times, `${activity.name} → ${format12h(formatTime(newStart))}`);
  }

  /**
   * Punto de escritura de horarios globales (drop, teclado y resize lo
   * reusan): delega en commitCambios (transacción atómica + undo/redo de un
   * paso, fase 1 del plan v2) y muestra el toast con [Deshacer].
   */
  async function commitWeeklyTimes(
    times: Map<string, { start: number; end: number }>,
    label: string,
    daysChange?: { id: string; days: number[] }
  ): Promise<string | null> {
    const acts: Activity[] = [];
    for (const [id, slot] of times) {
      const before = activities.find(a => a.id === id);
      if (!before) continue;
      const t0 = formatTime(slot.start);
      const t1 = formatTime(slot.end);
      const days = daysChange?.id === id ? daysChange.days : before.daysOfWeek;
      // Comparación por CONTENIDO: no escribir filas no-op (churn de updatedAt → ruido en el sync LWW).
      if (t0 !== before.startTime || t1 !== before.endTime || days.join(',') !== before.daysOfWeek.join(',')) {
        acts.push({ ...cloneAct(before), startTime: t0, endTime: t1, daysOfWeek: days });
      }
    }
    if (acts.length === 0) return null;
    try {
      const { commitCambios } = await import('../lib/commit');
      // Sin toast de éxito (pedido del usuario): el movimiento confirmado no
      // avisa nada; los errores sí (toastErr). El paso queda en el stack de
      // undo por si se reviviera la acción.
      await commitCambios({ label, acts });
      return label;
    } catch {
      toastErr(tNow('toast.couldNotMove'));
      return null;
    }
  }

  function clearDragPreview() {
    // C2: corre al soltar, cancelar o con Esc. Sin el reset de ids, la
    // tarjeta queda con opacidad 0.55 y fuera del layout hasta el próximo drag.
    draggedActivityId = null;
    dragSourceDay = null;
    dropPreview = null;
    setInvalid(false);
    shakeInvalid = false;
    dragHint = '';
    dragGhostXY = null;
    dragGhostHora = '';
    firmaPreview = '';
  }

  // ── Resize bidireccional (estirar arriba/abajo) en la grilla semanal ──
  // Mismo motor, gesto inmediato y sin fantasma. Semántica acordada: la
  // duración cambia en TODOS los días (global); keepPlace conserva el lado
  // fijo ('abajo' conserva inicio, 'arriba' conserva fin). Único gesto que
  // empuja en cadena — con candado: si un día desborda → ⛔ y nada se escribe.
  interface WeekResizeMeta {
    day: number;
    lado: 'arriba' | 'abajo';
    origStart: number;
    origEnd: number;
    startY: number;
  }

  // ── Resize HORIZONTAL (estirar a días vecinos) ──
  // Asa izquierda/derecha de la tarjeta: al arrastrar hacia el día vecino,
  // la actividad GANA ese día (lunes → martes). Al arrastrar de vuelta,
  // lo pierde. La hora no cambia: es un gesto de días, no de horario. La
  // validación es por conflictos en el día ganado (la cascada del resolve
  // empuja si hay espacio; ⛔ si no cabe) y el gesto con umbral de medio
  // día: cruzar el borde decide, jiggle no escribe.
  interface WeekHResizeMeta {
    day: number;            // día de origen (donde está la tarjeta)
    lado: 'izq' | 'der';    // asa agarrada
    startX: number;         // clientX inicial
    ganado: boolean;        // ya se cruzó el borde (commit 1 vez)
    activityId: string;     // copia local: resolverHResize no ve t.activityId
  }

  const weekResizeHooks: DragHooks = {
    onActivate(t) {
      draggedActivityId = t.activityId; // excluye la tarjeta del clustering
    },
    onMove(t, _x, clientY) {
      const m = t.meta as WeekResizeMeta;
      const calc = computeWeekResize(clientY, t.activityId, m);
      if (calc) {
        setInvalid(!calc.valido);
        // F4: la capacidad global acotó el deseo → feedback del por qué.
        dragHint = calc.limitadoPor ? `↕ Limitado por ${calc.limitadoPor}` : '';
        vresHint = dragHint ? { texto: dragHint, x: _x, y: clientY } : null;
        dropPreview = { day: m.day, slots: calc.slots };
      }
    },
    async onDrop(t, _x, clientY) {
      const m = t.meta as WeekResizeMeta;
      const calc = computeWeekResize(clientY, t.activityId, m);
      draggedActivityId = null;
      dragSourceDay = null;
      setInvalid(false);
      shakeInvalid = false;
      dragHint = '';
      vresHint = null;
      if (!calc) { dropPreview = null; return; }
      if (!calc.valido) { toastErrRepetido(`estirar-sem:${m.day}`, '⛔ No cabe: estirar desbordaría el día'); dropPreview = null; return; }
      // Commit global: el borde del PUNTERO manda. Con lado 'arriba' el fin
      // queda fijo (ancla = nuevo inicio) y la nueva duración viaja a todos
      // los días; el rechazo multi-día del candado protege el límite.
      const act = activities.find(a => a.id === t.activityId);
      const nuevaDur = m.lado === 'abajo'
        ? calc.newEnd! - m.origStart
        : m.origEnd - calc.newStart!;
      const ancla = m.lado === 'abajo' ? m.origStart : calc.newStart!;
      // Lado del estirar: 'arriba' ancla el FIN y lo pisado sube en cadena
      // (igual que el preview de resolveResizeDay) — antes el commit
      // re-derivaba con pared anclada al inicio y los vecinos traspasaban.
      const sem = propagateWeekly(activities, t.activityId, ancla, endHour, CODEC, act?.daysOfWeek ?? [], nuevaDur, 0, true, undefined, m.lado);
      if (!sem.valido) { toastErrRepetido(`estirar-sem:${m.day}`, sem.motivo); dropPreview = null; return; }
      await commitWeeklyTimes(sem.times, `Estirar ${act?.name ?? 'actividad'}`);
      dropPreview = null;
    },
    onCancel() {
      draggedActivityId = null;
      dragSourceDay = null;
      dropPreview = null;
      vresHint = null;
      setInvalid(false);
      shakeInvalid = false;
    }
  };

  function startResize(e: PointerEvent, activity: Activity, dayIndex: number, lado: 'arriba' | 'abajo') {
    e.stopPropagation(); // no disparar long-press/click/drag del ítem
    e.preventDefault();
    engine.beginImmediate(
      e,
      { card: e.currentTarget as HTMLElement, activityId: activity.id!, meta: { day: dayIndex, lado, origStart: parseTime(activity.startTime), origEnd: parseTime(activity.endTime), startY: e.clientY } satisfies WeekResizeMeta },
      weekResizeHooks,
      { ghost: false }
    );
  }

  // ── Resize horizontal: asas laterales (ganar/perder el día vecino) ──
  // ── Preview del hResize: qué hará el gesto si se suelta ahora ──
  // Activo = se cruzó el umbral (media columna). 'haciaFuera' = el asa se
  // aleja de la tarjeta (gana/retira el vecino, según quién lo tenga);
  // 'haciaDentro' = se dirige a la propia tarjeta (retira el día actual).
  // La vista pinta la columna afectada y el rótulo con esta info.
  let hresPreview = $state<{ accion: 'ganar' | 'retirar'; dias: number[]; x: number; y: number } | null>(null);

  /** Resuelve qué haría el gesto (compartido por preview y commit):
   *  null = sin gesto/no cruza umbral/borde del arreglo; si decide, devuelve
   *  la acción y los días afectados. Reglas:
   *  - Asa hacia AFUERA a un día que NO tiene la actividad: GANA ese día.
   *  - Asa hacia ADENTRO (hacia el bloque): BARRIDO de retiro. El dedo dice
   *    HASTA dónde: "de Domingo a Jueves" elimina los días CRUZADOS
   *    (Sábado y Viernes) — el día bajo el dedo queda como nuevo borde y el
   *    día del asa se conserva. Menos de una columna cruzada = el gesto
   *    clásico de siempre: retirar SOLO el día del asa. Límites: solo se
   *    retiran días que la actividad tiene, y jamás queda sin ningún día.
   *  - El vecino exterior YA tiene la actividad: hacia afuera no hay gesto,
   *    pero el asa sigue visible porque el barrido hacia adentro sí existe
   *    (asaLateralUtil). */
  function resolverHResize(m: WeekHResizeMeta, clientX: number): { accion: 'ganar' | 'retirar'; dias: number[]; diaOrigen: number } | null {
    const act = activities.find(a => a.id === m.activityId);
    if (!act) return null;
    const cols = [...document.querySelectorAll('.day-column')];
    const colAncho = cols[m.day]?.getBoundingClientRect().width ?? 0;
    if (colAncho <= 0) return null;
    const delta = clientX - m.startX;
    const cruzo = Math.abs(delta) > colAncho * 0.5; // umbral: media columna
    if (!cruzo) return null;
    const dirAsa = m.lado === 'der' ? 1 : -1;      // hacia afuera
    const haciaDentro = Math.sign(delta) === -dirAsa; // arrastre opuesto al lado del asa
    if (haciaDentro) {
      // Devolverse: BARRIDO de retiro hacia adentro. La matemática vive en
      // cascade.ts (barridoRetiro, dueño único con tests): aquí solo la
      // geometría del gesto (columnas completas cruzadas y dirección).
      const dirIn: 1 | -1 = -dirAsa;
      const n = Math.floor(Math.abs(delta) / colAncho); // columnas COMPLETAS cruzadas
      const dias = barridoRetiro(act.daysOfWeek, m.day, dirIn, n);
      if (dias.length === 0) return null; // único día: retirar no se ofrece
      return { accion: 'retirar', dias, diaOrigen: m.day };
    }
    const diaVecino = m.day + dirAsa;
    if (diaVecino < 0 || diaVecino > 6) return null;
    if (act.daysOfWeek.includes(diaVecino)) return null; // el bloque ya sigue hacia allá: sin gesto hacia afuera
    return { accion: 'ganar', dias: [diaVecino], diaOrigen: m.day };
  }

  const hResizeHooks: DragHooks = {
    onActivate(t) {
      draggedActivityId = t.activityId;
      hresPreview = null;
    },
    onMove(t, clientX, _y) {
      const m = t.meta as WeekHResizeMeta;
      const r = resolverHResize(m, clientX);
      hresPreview = r ? { accion: r.accion, dias: r.dias, x: clientX, y: _y } : null;
    },
    async onDrop(t, clientX) {
      const m = t.meta as WeekHResizeMeta;
      const act = activities.find(a => a.id === t.activityId);
      hresPreview = null;
      if (!act) return;
      const r = resolverHResize(m, clientX);
      if (!r) return; // jiggle / borde del arreglo / único día: nada se escribe
      if (r.accion === 'retirar') {
        const quitados = r.dias;
        const newDays = act.daysOfWeek.filter(d => !quitados.includes(d));
        // commitWeeklyTimes compara por contenido y omite filas no-op; el
        // cambio de días vía daysChange fuerza la escritura del único cambio.
        const times = new Map<string, { start: number; end: number }>();
        times.set(act.id!, { start: parseTime(act.startTime), end: parseTime(act.endTime) });
        await commitWeeklyTimes(times, `${act.name}: dejar ${quitados.map(d => days[d]).join(', ')}`, { id: act.id!, days: newDays });
        toastOk(quitados.length === 1
          ? tNow('toast.dayRemoved', { dia: days[quitados[0]] })
          : tNow('toast.daysRemoved', { dias: quitados.map(d => days[d]).join(', ') }));
        return;
      }
      // Ganancia: el vecino no tiene la actividad → agregar el día.
      const diaVecino = r.dias[0];
      const newDays = [...act.daysOfWeek, diaVecino].sort((a, b) => a - b);
      // Validar el día ganado: ¿cabe el bloque (cascada con empuje)?
      const dur = parseTime(act.endTime) - parseTime(act.startTime);
      const slots = activities
        .filter(a => a.daysOfWeek.includes(diaVecino))
        .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
      const inicio = parseTime(act.startTime);
      const res = resolveDayCascade(
        slots,
        { id: act.id!, start: inicio, end: inicio + dur },
        inicio,
        true,
        startHour,
        endHour
      );
      if (!res.valido) { toastErrRepetido(`hres:${act.id}`, '⛔ No cabe: el día vecino está lleno a esa hora'); return; }
      // Commit: mismas horas en el nuevo día + empuje en cadena del día ganado
      const times = new Map<string, { start: number; end: number }>();
      for (const s of res.slots) times.set(s.id, { start: s.start, end: s.end });
      await commitWeeklyTimes(times, `${act.name} → ${days[diaVecino]}`, { id: act.id!, days: newDays });
      toastOk(tNow('toast.dayExtended', { dia: days[diaVecino] }));
    },
    onCancel() {
      hresPreview = null;
      draggedActivityId = null;
    }
  };

  function startHResize(e: PointerEvent, activity: Activity, dayIndex: number, lado: 'izq' | 'der') {
    e.stopPropagation();
    e.preventDefault();
    engine.beginImmediate(
      e,
      { card: e.currentTarget as HTMLElement, activityId: activity.id!, meta: { day: dayIndex, lado, startX: e.clientX, ganado: false, activityId: activity.id! } satisfies WeekHResizeMeta },
      hResizeHooks,
      { ghost: false }
    );
  }

  // ── Indicadores dinámicos de asas ──
  // Solo se muestran los gestos que HOY tienen sentido:
  //  - estirar arriba/abajo: capacidad > 0 en ese lado (si no hay hueco, la
  //    asa no aparece: sin indicador de acción imposible)
  //  - asa lateral: SOLO en límites o huecos (pedido del usuario): activa
  //    únicamente si el vecino exterior NO tiene la actividad (ahí se gana
  //    ese día) o el borde del arreglo deja el barrido hacia adentro. En
  //    medio de un tramo contiguo ( Lun–Vie: el borde Lun/Mar ) NO hay asa:
  //    arrastrar desde ahí mueve el bloque como cualquier otra zona.
  // Se recalcula con activities: al cambiar el día o los datos, reaparecen.
  /**
   * ¿La asa lateral de ESTA tarjeta (columna concreta i) ofrece algo?
   * Límites y huecos: afuera se gana un día libre; en el borde del arreglo
   * solo queda el barrido hacia adentro (requiere ≥2 días). En el medio de
   * un tramo contiguo la asa no existe — el vecino ya tiene la actividad y
   * no hay hueco que llenar ni límite que mover.
   */
  function asaLateralUtil(act: Activity, i: number, lado: 'izq' | 'der'): boolean {
    const puedeRetirar = act.daysOfWeek.length > 1;
    const vecino = lado === 'der' ? i + 1 : i - 1;
    const ganaVecino = vecino >= 0 && vecino <= 6 && !act.daysOfWeek.includes(vecino);
    const vecinoFuera = vecino < 0 || vecino > 6;
    return ganaVecino || (puedeRetirar && vecinoFuera);
  }
  const asasPosibles = $derived.by(() => {
    const mapa = new Map<string, { arriba: boolean; abajo: boolean; izq: boolean; der: boolean; retirar: boolean }>();
    for (const act of activities) {
      // La asa lateral del lado X es útil si existe ALGÚN día que la gesture
      // afecte: ganar un vecino que no tiene la actividad, o retirar el día
      // actual (siempre que quede ≥1 día). Se evalúa por tarjeta global:
      // la misma actividad se estira desde cualquier columna donde aparezca.
      const puedeRetirar = act.daysOfWeek.length > 1;
      const ganaAlgo = act.daysOfWeek.length < 7;
      mapa.set(act.id!, {
        // Encoger SIEMPRE está permitido (regla del proyecto): el asa vertical
        // existe aunque el bloque esté encajonado entre vecinos (capacidad 0
        // = no puede estirar, pero sí puede achicar). El gesto acota por la
        // capacidad al estirar y no toca nada al encoger — sin asa el bloque
        // colindante quedaba inmodificable verticalmente.
        arriba: true,
        abajo: true,
        izq: ganaAlgo || puedeRetirar,
        der: ganaAlgo || puedeRetirar,
        retirar: puedeRetirar
      });
    }
    return mapa;
  });

  /**
   * Cálculo COMPARTIDO por preview y commit del resize (una sola matemática):
   * el borde del puntero (snap 15min, clamp) y el mapa resuelto. 'abajo'
   * conserva el inicio (cascada empuja hacia abajo); 'arriba' conserva el fin
   * (cascada empuja hacia arriba). Nunca reacomoda la tarjeta que se estira.
   */
  function computeWeekResize(
    clientY: number,
    actId: string,
    m: WeekResizeMeta
  ): { lado: 'arriba' | 'abajo'; newEnd?: number; newStart?: number; valido: boolean; limitadoPor?: string; slots: Map<string, { start: number; end: number }> } | null {
    const col = document.querySelectorAll('.day-column .slots-grid')[m.day];
    if (!col) return null;
    const deltaSlots = (clientY - m.startY) / slotHeightPx;
    const daySlots = activities
      .filter(a => a.daysOfWeek.includes(m.day))
      .map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
    // Capacidad GLOBAL (mínimo entre los días de la actividad): la duración
    // es global — al estirar, la nueva duración viaja a todos los días y el
    // commit acota el deseo para que NINGÚN día desborde (sin ⛔ al estirar).
    // El encoger no se acota: siempre está permitido.
    const capMin = capacidadResizeWeekly(activities, actId, m.lado, CODEC, startHour, endHour);
    // Feedback cuando la capacidad GLOBAL acotó el deseo (la duración es
    // global: el día MÁS APRETADO de la actividad manda). Sin esto el gesto
    // se ve muerto: el hueco existe en la columna del gesto pero el bloque
    // no crece y no se sabe por qué.
    const EPS_H = 1e-6; // comparación de horas (floats del snap de 15min)
    const deseoAbajo = m.lado === 'abajo';
    const deseo = deseoAbajo
      ? Math.round((m.origEnd + deltaSlots / slotsPerHour) * 4) / 4
      : Math.round((m.origStart + deltaSlots / slotsPerHour) * 4) / 4;
    const topeGlobal = deseoAbajo ? m.origEnd + capMin / 60 : m.origStart - capMin / 60;
    const estaEstirando = deseoAbajo ? deseo > m.origEnd + EPS_H : deseo < m.origStart - EPS_H;
    const acotoGlobal = estaEstirando && (deseoAbajo ? deseo > topeGlobal + EPS_H : deseo < topeGlobal - EPS_H);
    if (deseoAbajo) {
      let newEnd = deseo;
      // Regla del usuario: estirar SIEMPRE topa, nunca se rechaza. El deseo
      // del puntero se acota por la capacidad global (el encoger no se acota).
      if (newEnd > m.origEnd) {
        newEnd = Math.min(newEnd, topeGlobal);
      }
      newEnd = Math.max(m.origStart + 0.25, Math.min(newEnd, endHour));
      const res = resolveResizeDay(daySlots, actId, 'abajo', newEnd, startHour, endHour);
      return { lado: m.lado, newEnd, valido: res.valido, limitadoPor: acotoGlobal && !res.limitadoPor ? 'el día más apretado de la semana' : res.limitadoPor, slots: new Map(res.slots.map(s => [s.id, { start: s.start, end: s.end }])) };
    }
    let newStart = deseo;
    // Espejo hacia arriba: acotar por la capacidad global.
    if (newStart < m.origStart) {
      newStart = Math.max(newStart, topeGlobal);
    }
    newStart = Math.max(startHour, Math.min(newStart, m.origEnd - 0.25));
    const res = resolveResizeDay(daySlots, actId, 'arriba', newStart, startHour, endHour);
    return { lado: m.lado, newStart, valido: res.valido, limitadoPor: acotoGlobal && !res.limitadoPor ? 'el día más apretado de la semana' : res.limitadoPor, slots: new Map(res.slots.map(s => [s.id, { start: s.start, end: s.end }])) };
  }

  // Context Menu logic
  let contextMenu = $state({ show: false, x: 0, y: 0, activityId: null as string | null });

  // Lightbox para ver la imagen de la rutina
  let viewingImageActivity = $state<Activity | null>(null);

  // ── Popover de imagen al pasar el mouse (Semana) ──
  // Hover sobre la miniatura muestra la foto ampliada SIN click; el click
  // sigue abriendo el lightbox. Portal + fixed: no le afecta el overflow de
  // la tarjeta/columna. Retraso de entrada para no parpadear al pasar el
  // mouse de paso; el touch no tiene hover: ahí el gesto sigue siendo tap.
  let imgPopover = $state<{ activity: Activity; x: number; y: number } | null>(null);
  let imgPopoverTimer: ReturnType<typeof setTimeout> | null = null;

  function mostrarImgPopover(e: MouseEvent, activity: Activity) {
    // Sin hover (táctil) no hay popover: ahí el gesto es el tap → lightbox.
    if (matchMedia('(hover: none)').matches) return;
    if (imgPopoverTimer) { clearTimeout(imgPopoverTimer); imgPopoverTimer = null; }
    // currentTarget muere con el dispatch (null dentro del setTimeout): el
    // rect se captura AHORA, el timeout solo decide cuándo pintarlo.
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    imgPopoverTimer = setTimeout(() => {
      imgPopover = { activity, x: r.left + r.width / 2, y: r.top };
    }, 180);
  }
  function ocultarImgPopover(inmediato = false) {
    if (imgPopoverTimer) { clearTimeout(imgPopoverTimer); imgPopoverTimer = null; }
    if (inmediato) imgPopover = null;
    else imgPopoverTimer = setTimeout(() => { imgPopover = null; }, 80);
  }

  const activityHasImage = $derived(
    contextMenu.activityId !== null &&
    !!activities.find(a => a.id === contextMenu.activityId)?.image
  );

  function handleContextMenu(e: MouseEvent, activityId: string) {
    e.preventDefault();
    openContextMenu(activityId, e.clientX, e.clientY);
  }

  function closeContextMenu() {
    contextMenu.show = false;
    emptySlotMenu.show = false;
  }

  async function duplicateActivity() {
    const sourceId = contextMenu.activityId;
    closeContextMenu();
    if (!sourceId) return;

    const source = activities.find(a => a.id === sourceId);
    if (!source) return;

    // Duplicar en los mismos días de la semana que la original
    const days = source.daysOfWeek?.length ? source.daysOfWeek : [0];
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

  let confirmDelete = $state(false);

  function askDeleteActivity() {
    if (contextMenu.activityId) confirmDelete = true;
    closeContextMenu();
  }

  async function deleteActivity() {
    const id = contextMenu.activityId;
    if (!id) return;
    try {
      await db.activities.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
      // Propagar el borrado a las ediciones temporales (dayOverrides) que la copiaron
      const overrides = await db.dayOverrides.toArray();
      const dirty = overrides
        .filter(o => o.activities?.some(a => a.id === id))
        .map(o => ({ ...o, activities: o.activities.filter(a => a.id !== id) }));
      if (dirty.length > 0) await db.dayOverrides.bulkPut(dirty);
      toastOk(tNow('toast.deleted'));
    } catch (err: any) {
      console.error(err);
    }
  }
</script>

<svelte:window onclick={closeContextMenu} onscroll={closeContextMenu} />

<div class="weekly-grid-container" style="--total-slots: {totalSlots}; --slot-height: {slotHeightPx}px">
  <div class="scroll-hint" aria-hidden="true">{$t('week.scrollHint')}</div>
  <div class="grid-scroll">
  <div class="time-column">
    <div class="header-spacer"></div>
    {#each hours as hour}
      <div class="hour-label" style="grid-row: {getRowPosition(hour + ':00') + 1}">
        <span class="hour-text">{hour % 12 || 12}:00</span>
        <span class="hour-ampm">{hour < 12 || hour === 24 ? 'AM' : 'PM'}</span>
      </div>
      {#if hour < endHour}
        <div class="half-hour-label" style="grid-row: {getRowPosition(hour + ':30') + 1}">
          <span class="half-text">{hour % 12 || 12}:30</span>
        </div>
      {/if}
    {/each}
  </div>

  <div class="days-columns">
    {#if semanaVacia}
      <!-- Sin actividades no hay nada que arrastrar ni ningun bloque que
           leer: la rejilla a secas no le dice al usuario que hacer. El icono
           y el texto son los mismos que usa la vista Día para su "día libre",
           de modo que las dos vistas se leen igual. -->
      <div class="empty-state glass-panel" aria-live="polite">
        <span class="empty-icon">🌱</span>
        <p>{$t('weekView.empty', { btn: $t('header.newActivity') })}</p>
      </div>
    {/if}
    {#each days as day, i}
      {@const dayData = getDayActivitiesWithLayout(i, dropPreview?.day === i ? dropPreview.slots : undefined, draggedActivityId !== null && (dragSourceDay === i || dropPreview?.day === i) ? draggedActivityId : null)}
      <div class="day-column" class:col-dragging={draggedActivityId !== null} class:col-hoy={i === hoyIdx}
        class:col-hres-ganar={hresPreview?.accion === 'ganar' && hresPreview.dias.includes(i)}>
        <!-- Nombre completo SIEMPRE accesible: en columna angosta el header muestra
             la abreviatura (Mié/Sáb) y el title lleva el nombre entero. Sin
             nombres cortados a medias jamás. -->
        <button class="day-header" class:header-hoy={i === hoyIdx} class:header-temp={dayOverrides.some(o => o.day === i && o.activities?.length >= 0)} onclick={() => onSelectDay(i)} aria-label={$t('week.viewDay', { day })} title="{day}">
          <span class="day-name">
            <span class="day-name-completo">{day}</span>
            <span class="day-name-corto" aria-hidden="true">{day.slice(0, 3)}</span>
          </span>
          {#if i === hoyIdx}
            <span class="hoy-badge">{$t('week.today')}</span>
          {/if}
          {#if dayOverrides.some(o => o.day === i && o.activities?.length >= 0)}
            <span class="day-temp-badge" title={$t('week.tempBadge')}>⚡</span>
          {/if}
        </button>
        <div
          class="slots-grid"
          oncontextmenu={(e) => handleGridContextMenu(e, i)}
        >
          {#each dayData.items as activity (activity.id)}
            {@const numSlots = activity.numSlots}
            {@const catColor = getActivityColor(activity.categoryId, categories)}
            {@const catFg = textOn(catColor)}
            <!-- role="button" en un <div>, no un <button> real: el bloque
                 contiene la miniatura, que SÍ es un botón (abre la
                 imagen). Un <button> no puede contener otro <button> — HTML
                 lo prohíbe y el foco de teclado no puede entrar: la
                 miniatura quedaba inalcanzable con Tab y sus handlers de
                 Enter/Espacio nunca se ejecutaban. La vista Día ya resolvió
                 esto del mismo modo ( DailyView.svelte ). -->
            <div
              class="activity-item"
              role="button"
              tabindex="0"
              class:short={numSlots <= 2}
              class:mini={numSlots <= 1}
              class:drag-ghost={draggedActivityId === activity.id}
              class:drop-invalid={draggedActivityId === activity.id && dragInvalid}
              class:hres-afectado={hresPreview?.accion === 'retirar' && hresPreview.dias.includes(i) && activity.id === draggedActivityId}
              onpointerdown={(e) => handleItemPointerDown(e, activity, i)}
              oncontextmenu={(e) => handleContextMenu(e, activity.id!)}
              style="top: {activity.top}; height: {activity.height}; left: {activity.left}; width: {activity.width}; --bg-color: {catColor}; --fg-color: {catFg.text}; --fg-shadow: {catFg.shadow}"
              onclick={() => onEditActivity(activity.id!)}
              onkeydown={(e) => {
                // M6 (WCAG 2.5.7): ↑/↓ = ±15 min con cascada global. Enter y
                // Espacio abren edición: antes venía gratis del <button>
                // nativo y ahora hay que gestionarlos a mano.
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  nudgeWeekly(activity, e.key === 'ArrowUp' ? -0.25 : 0.25);
                } else if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onEditActivity(activity.id!);
                }
              }}
              aria-label="{activity.name}, {format12h(activity.startTime)} — {format12h(activity.endTime)}{activity.steps?.length ? `, ${activity.steps.length}` : ''}. {$t('dayView.keyboardHint')}"
              title={activity.name}
            >
              <div class="activity-title">
                <span>{activity.name}</span>
                {#if activity.steps && activity.steps.length > 0}
                  <span class="grid-steps-icon">
                    <ListChecks size={10} />
                  </span>
                {/if}
              </div>
                {#if asasPosibles.get(activity.id!)?.arriba}
                  <div
                    class="resize-handle top"
                    aria-hidden="true"
                    onpointerdown={(e) => startResize(e, activity, i, 'arriba')}
                  ></div>
                {/if}
                {#if asasPosibles.get(activity.id!)?.abajo}
                  <div
                    class="resize-handle"
                    aria-hidden="true"
                    onpointerdown={(e) => startResize(e, activity, i, 'abajo')}
                  ></div>
                {/if}
                {#if (i > 0 || asasPosibles.get(activity.id!)?.retirar) && asasPosibles.get(activity.id!)?.izq && asaLateralUtil(activity, i, 'izq')}
                  <div
                    class="resize-handle hres-izq"
                    aria-hidden="true"
                    onpointerdown={(e) => startHResize(e, activity, i, 'izq')}
                  ></div>
                {/if}
                {#if (i < 6 || asasPosibles.get(activity.id!)?.retirar) && asasPosibles.get(activity.id!)?.der && asaLateralUtil(activity, i, 'der')}
                  <div
                    class="resize-handle hres-der"
                    aria-hidden="true"
                    onpointerdown={(e) => startHResize(e, activity, i, 'der')}
                  ></div>
                {/if}
            </div>
            <!-- Miniatura REAL de la imagen (igual que la vista Día): el icono
                 genérico no decía qué imagen era; la foto misma sí.
                 Vive FUERA del bloque a propósito: el bloque es interactivo
                 (role=button) y un <button> no puede anidarse en otro
                 interactivo — HTML lo prohíbe y el foco de teclado no
                 entra dentro, así que la miniatura era inalcanzable con Tab.
                 Se posiciona con la MISMA geometría que el bloque (mismos
                 strings de left/width), pegada a su borde derecho. -->
            {#if activity.image && numSlots > 1}
              <button
                type="button"
                class="grid-image-thumb"
                class:short={numSlots <= 2}
                style="top: calc({activity.top} + 2px); left: calc({activity.left} + {activity.width} - var(--thumb) - 3px)"
                aria-label={$t('dayView.viewImage', { name: activity.name })}
                aria-describedby={imgPopover?.activity.id === activity.id ? 'img-popover' : undefined}
                title={$t('menu.viewImage')}
                onclick={(e) => { e.stopPropagation(); ocultarImgPopover(true); viewingImageActivity = activity; }}
                onpointerdown={(e) => e.stopPropagation()}
                onmouseenter={(e) => mostrarImgPopover(e, activity)}
                onmouseleave={() => ocultarImgPopover()}
                onfocus={(e) => mostrarImgPopover(e, activity)}
                onblur={() => ocultarImgPopover(true)}
              >
                <img src={activity.image} alt="" loading="lazy" />
              </button>
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  </div>
  </div>

  {#if draggedActivityId !== null && dragGhostXY && ghostActivity}
    <!-- Fantasma flotante estilo demo: clon del BLOQUE COMPLETO (tamaño real,
         color de categoría) anclado al punto de agarre, con la hora proyectada
         y la acción del drop (fixed = no le afectan overflow ni scroll). -->
    <div class="drag-float" use:portal class:invalido={dragInvalid} class:shake={shakeInvalid} aria-hidden="true"
      onanimationend={(e) => { if (e.animationName === 'shake') shakeInvalid = false; }}
      style="left: {dragGhostXY.x - grabDX}px; top: {dragGhostXY.y - grabDY}px; width: {grabW}px; height: {grabH}px; --bg-color: {ghostColor}">
      <div class="df-title"><span>{ghostActivity.name}</span></div>
      <span class="df-hora">{dragGhostHora}</span>
    </div>
  {/if}

  {#if vresHint}
    <!-- Rótulo del resize vertical: explica por qué el bloque no creció
         (capacidad global acotada / topa con bloque o borde). -->
    <div class="hres-float hres-ganar vres-float" use:portal aria-hidden="true"
      style="left: {vresHint.x}px; top: {vresHint.y}px">
      {vresHint.texto}
    </div>
  {/if}

  {#if imgPopover}
    <!-- Popover de imagen (hover/foco sobre la miniatura): foto ampliada sin
         click. Anclado al centro-superior de la miniatura; portal como los
         demás overlays (overflow de tarjeta/columna no lo recorta). -->
    <div class="img-popover" id="img-popover" role="tooltip" use:portal
      style="left: {imgPopover.x}px; top: {imgPopover.y}px">
      <img src={imgPopover.activity.image} alt="" />
      <span class="img-popover-name">{imgPopover.activity.name}</span>
    </div>
  {/if}

  {#if hresPreview && ghostActivity}
    <!-- Rótulo del hResize: qué pasaría si se suelta AHORA. Igual que
         .drag-float: portal + fixed para escapar de overflow y scroll.
         Anclado al pointer del motor (posición viva en cada gesto). -->
    <div class="hres-float" use:portal class:hres-ganar={hresPreview.accion === 'ganar'} class:hres-retirar={hresPreview.accion === 'retirar'} aria-hidden="true"
      style="left: {hresPreview.x}px; top: {hresPreview.y}px">
      <span class="hf-senial" aria-hidden="true">{hresPreview.accion === 'ganar' ? '+' : '−'}</span>
      {hresPreview.dias.map(d => days[d]).join(', ')}
      <span class="hf-act">{ghostActivity.name}</span>
    </div>
  {/if}

  {#if emptySlotMenu.show}
    <!-- Menú de hueco (click derecho en espacio vacío de un día): portal por el
         mismo motivo que el menú de actividad (containing block de glass-panel). -->
    <div class="custom-context-menu glass-panel" use:portal style="top: {emptySlotMenu.y}px; left: {emptySlotMenu.x}px">
      <button onclick={createAtEmptySlotWeekly} aria-label={$t('menu.createHere', { time: format12h(horasAHoraReloj(emptySlotMenu.hour)) })}>
        <Plus size={16} /> {$t('menu.createHere', { time: format12h(horasAHoraReloj(emptySlotMenu.hour)) })}
      </button>
    </div>
  {/if}

  {#if contextMenu.show}
    <!-- Portal a body: backdrop-filter de .glass-panel ancestro crea containing block y rompe el position:fixed -->
    <div class="custom-context-menu glass-panel" use:portal style="top: {contextMenu.y}px; left: {contextMenu.x}px">
      <button onclick={duplicateActivity} aria-label={$t('menu.duplicate')}>
        <Copy size={16} /> {$t('menu.duplicate')}
      </button>
      {#if viewingImageActivity === null && activityHasImage}
        <button onclick={() => { viewingImageActivity = activities.find(a => a.id === contextMenu.activityId) || null; }}>
          <ImageIcon size={16} /> {$t('menu.viewImage')}
        </button>
      {/if}
      <button class="delete-btn" onclick={askDeleteActivity}>
        <Trash2 size={16} /> {$t('menu.delete')}
      </button>
    </div>
  {/if}

  <ConfirmDialog
    bind:open={confirmDelete}
    title={$t('confirm.deleteTitle')}
    message={$t('confirm.deleteWeekMsg')}
    confirmText={$t('confirm.deleteBtn')}
    danger
    onconfirm={deleteActivity}
  />

  {#if viewingImageActivity}
    <ImageLightbox activity={viewingImageActivity} onClose={() => viewingImageActivity = null} />
  {/if}
</div>

<style>
  .weekly-grid-container {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    max-width: 100%;
    padding-bottom: 1rem;
    padding-top: 10px;
    position: relative;
    scrollbar-width: thin;
    /* Contenedor de consulta (CQ): los breakpoints de la grilla reaccionan al
       ANCHO REAL DEL CONTENEDOR y no al viewport. Ventaja práctica: si mañana
       la grilla vive en un panel lateral o en pantalla dividida, su layout se
       adapta solo — sin tocar una sola regla. inline-size = solo el eje
       horizontal participa (el alto no crea contención, no rompe el track). */
    container: weekly-grid / inline-size;
  }

  /* El scroll es del CONTENIDO (no del contenedor): así la columna de horas
     puede quedar pegajosa y los días no arrastran la página entera.
     Piso total: columna de horas (68px) + 7 días al mínimo legible (88px).
     Bajo ese ancho el scroll horizontal toma el relevo sin aplastar días. */
  .grid-scroll {
    display: flex;
    /* Llena el ancho disponible (flex:1) PERO sin bajar del piso. El piso
       total es escalonado como las columnas (68px horas + 7×piso + gaps):
       88px/día en desktop, 66px en ≤768px, 56px en ≤480px — así en un móvil
       de 320px caben 4 días sin scroll (antes: 2 días y scroll eterno). */
    flex: 1;
    min-width: calc(68px + 7 * 88px + 6px);
  }
  @container weekly-grid (width < 768px) {
    .grid-scroll {
      min-width: calc(48px + 7 * 66px + 6px);
    }
  }
  @container weekly-grid (width < 480px) {
    .grid-scroll {
      min-width: calc(48px + 7 * 56px + 6px);
    }
  }

  .time-column {
    display: grid;
    grid-template-rows: 40px repeat(var(--total-slots), var(--slot-height));
    width: 68px;
    padding-right: 0.5rem;
    border-right: 1px solid rgba(0,0,0,0.08);
    user-select: none;
    flex-shrink: 0;
    /* Solo texto decorativo (etiquetas de hora): sin eventos,
       el carril pegajoso deja de "comerse" el borde izquierdo
       de la zona táctil (::before) de las miniaturas de la 1ª
       columna (medido: hasta −14px de zona perdida contra el
       carril, z-index 20 con fondo). El scroll/rueda siguen
       funcionando: el evento pasa al contenido bajo el carril
       y sube hasta .grid-scroll. */
    pointer-events: none;
    /* Pegajosa al deslizar hacia los lados: las horas siempre visibles. */
    position: sticky;
    left: 0;
    z-index: 20;
    background: rgba(255, 255, 255, 0.82);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  /* En contenedor angosto la columna de horas se compacta igual que los días
     (misma escala que los breakpoints del piso de columnas). */
  @container weekly-grid (width < 768px) {
    .time-column {
      width: 56px;
    }
  }
  @container weekly-grid (width < 480px) {
    .time-column {
      width: 48px;
    }
  }

  .header-spacer {
    height: 40px;
  }

  .hour-label {
    font-size: 0.72rem;
    font-weight: 700;
    color: #4a5568;
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: 2px;
    transform: translateY(-50%);
    white-space: nowrap;
    padding-right: 4px;
  }

  .hour-text {
    color: #2d3748;
  }

  .hour-ampm {
    font-size: 0.6rem;
    font-weight: 600;
    /* 4,02:1 con #718096 — no llegaba a AA. #4a5568 da 7,53:1 sobre el
       panel y 6,60:1 en el peor caso (glifo encima de un punto del
       patrón de fondo). Jerarquía conservada: sigue siendo más claro que
       .hour-text (#2d3748). */
    color: #4a5568;
  }

  .half-hour-label {
    font-size: 0.64rem;
    font-weight: 500;
    /* 2,26:1 con #a0aec0: la mitad de lo que exige AA. #5c6778 da 5,73:1
       sobre el panel y 5,03:1 en el peor caso. Sigue siendo la etiqueta
       más discreta de las dos (peso 500 frente al 600 de AM/PM). */
    color: #5c6778;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    transform: translateY(-50%);
    white-space: nowrap;
    opacity: 0.85;
    padding-right: 4px;
  }

  .days-columns {
    flex: 1;
    display: grid;
    /* El estado vacío se superpone a la rejilla, no la empuja: sin
       actividades las columnas siguen ahí (con su rejilla de fondo) y el
       aviso flota encima. grid-area lo saca del flujo de las 7 columnas. */
    position: relative;
    /* Ajuste dinámico con piso y tope (pedido del usuario): reparte el ancho
       sin aplastar los días ni dejarlos gigantes.
       % y NO fr dentro de clamp (fr invalida la declaración entera):
       14.2857% = 1/7 del contenedor, menos 1px por el gap entre columnas
       (6 gaps consumen 6px que el % puro ignora — sin el descuento, la suma
       de columnas excede el contenedor en 6px y aparece micro-scroll).
       Piso ESCALONADO (cobertura general móvil): el 88px fijo era una pared
       en 320/425px (2 días en pantalla y scroll eterno). En móvil angosto el
       piso baja: 66px en ≤768px, 56px en ≤480px — el día SIEMPRE cabe en su
       mínimo y el scroll solo aparece cuando no caben los 7 días. */
    /* Techo de columna 420px (antes 300): el tope 300 solo dejaba de crecer
       por encima de ~2100px de panel y ahí la grilla quedaba pegada a la
       IZQUIERDA con franja muerta a la derecha. 420px × 7 ≈ 2940px cubre
       cualquier display razonable y, si algún contenedor lo supera,
       justify-content: center reparte el sobrante a ambos lados. */
    grid-template-columns: repeat(7, clamp(88px, calc(14.2857% - 1px), 420px));
    justify-content: center;
    gap: 1px;
    background: rgba(0,0,0,0.06);
  }
  @container weekly-grid (width < 768px) {
    .days-columns {
      grid-template-columns: repeat(7, clamp(66px, calc(14.2857% - 1px), 420px));
    }
  }
  /* Estado vacío de la semana: misma idea y mismo aspecto que el de la vista
     Día (icono + una frase que dice qué hacer), pero flotando sobre la
     rejilla en vez de anclado al track. grid-area 1/1/-1/-1 lo hace ocupar
     las siete columnas sin pushar los días: si no, aparecería como una
     octava columna y descuadraría la rejilla entera. */
  .empty-state {
    grid-area: 1 / 1 / -1 / -1;
    align-self: start;
    justify-self: center;
    margin-top: 12%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 1.25rem 1rem;
    text-align: center;
    pointer-events: none;
    color: var(--color-brown-bark);
    opacity: 0.85;
    max-width: min(90%, 22rem);
  }
  .empty-state .empty-icon {
    font-size: 1.75rem;
  }
  .empty-state p {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  @container weekly-grid (width < 480px) {
    .days-columns {
      /* Piso 60px (antes 56): con el padding fino da el ancho justo para que
         "Almuerzo" completo entre en una línea a 0.7rem. */
      grid-template-columns: repeat(7, clamp(60px, calc(14.2857% - 1px), 420px));
    }
  }

  .day-column {
    display: flex;
    flex-direction: column;
    background: white;
    min-width: 0;
    overflow: hidden;
  }

  .day-header {
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--color-brown-bark, #4a3728);
    border-bottom: 1px solid rgba(0,0,0,0.08);
    background: white;
    border: none;
    cursor: pointer;
    transition: background 0.2s;
    overflow: hidden; /* el nombre largo nunca desborda la columna */
    box-sizing: border-box;
    position: relative; /* ancla el badge ⚡ en la esquina (no empuja el nombre) */
  }

  /* Nombre completo SIEMPRE legible (nada cortado a medias):
     .day-name-completo manda mientras el ancho de columna lo permite; debajo
     de ~76px de columna, la abreviatura de 3 letras toma el relevo y el
     nombre entero queda en title del botón. El flip es por contenedor,
     no por viewport: igual que los pisos de columnas. */
  .day-name {
    display: inline-flex;
    max-width: 100%;
    overflow: hidden;
  }
  .day-name-corto {
    display: none;
  }
  @container weekly-grid (width < 590px) {
    /* 7 columnas: <590px de grilla = columnas de <~76px → 'Miércoles' (10
       caracteres a 0.85rem ≈ 71px) no cabe completo → abreviatura. */
    .day-name-completo {
      display: none;
    }
    .day-name-corto {
      display: inline;
    }
  }

  .day-header:hover {
    background: rgba(92, 64, 51, 0.05);
  }

  /* ── Señalización del día actual ──
     El header de hoy se tiñe de verde (color de la app) y lleva el badge
     "Hoy"; la columna entera lleva un borde sutil para encontrarla de
     reojo sin marear con colores fuertes el tablero completo. */
  .day-header.header-hoy {
    background: rgba(74, 124, 68, 0.10);
    color: var(--color-green-dark, #2f6b2f);
    box-shadow: inset 0 -2px 0 var(--color-green-dark, #2f6b2f);
  }
  .day-header.header-hoy:hover {
    background: rgba(74, 124, 68, 0.16);
  }
  .hoy-badge {
    font-size: 0.62rem;
    font-weight: 700;
    margin-left: 0.3rem;
    color: #ffffff;
    background: var(--color-green-dark, #2f6b2f);
    border-radius: 999px;
    padding: 1px 7px;
    line-height: 1.4;
    display: inline-flex;
    align-items: center;
    letter-spacing: 0.02em;
    flex-shrink: 0;
  }
  /* Columna de hoy: borde verde sutil en los costados (no tapa el grid:
     outline no ocupa espacio de layout). */
  .day-column.col-hoy .slots-grid {
    box-shadow: inset 2px 0 0 rgba(74, 124, 68, 0.25), inset -2px 0 0 rgba(74, 124, 68, 0.25);
  }

  /* ── Preview del hResize (asas laterales) ──
     Verde: la actividad ganaría el día (no tiene bloque ahí — la columna
     entera es el único feedback posible). Retiro: la marca va sobre los
     BLOQUES de la actividad arrastrada en los días afectados (.hres-
     afectado), NUNCA sobre la columna entera: eso manchaba a los vecinos
     (Aseo 1, Trabajo…) que no participan en el gesto. Espejo del feedback
     del drag vertical (drop-preview). */
  .day-column.col-hres-ganar .slots-grid {
    box-shadow: inset 0 0 0 3px rgba(74, 124, 68, 0.55);
    background: rgba(74, 124, 68, 0.06);
  }
  /* Fantasmas del retiro: los bloques de la actividad que dejarían de
     existir en esos días se ponen rojos. */
  .activity-item.hres-afectado {
    background: #e0453a !important;
    color: #fff !important;
  }

  /* Variante del rótulo para el resize VERTICAL: sin signo, solo el texto
     del límite; anclado junto al puntero. */
  .vres-float {
    transform: translate(14px, -50%);
    background: var(--color-brown-bark, #4a3728);
  }

  /* Rótulo flotante del hResize: acción + día + actividad, anclado al puntero.
     Portal + fixed: le afectan ni el overflow del panel ni el scroll. */
  .hres-float {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: 8px;
    font-size: 0.78rem;
    font-weight: 700;
    color: #fff;
    background: var(--color-green-dark, #2f6b2f);
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 12px 28px rgba(0, 0, 0, 0.32);
    transform: translate(14px, -50%);
    will-change: transform, left, top;
    white-space: nowrap;
    max-width: 70vw;
  }
  .hres-float .hf-senial {
    font-size: 0.9rem;
    line-height: 1;
  }
  .hres-float .hf-act {
    font-weight: 600;
    opacity: 0.85;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hres-float.hres-retirar {
    background: #e0453a;
  }

  /* Badge ⚡ de edición temporal: PUNTO en la esquina del header (position
     absolute). Antes iba inline junto al nombre y con 5 días con ⚡ la fila
     de cabeceras quedaba saturada ("Lun ⚡ Mar ⚡ Hoy ⚡ …") empujando y
     compactando el nombre. Sigue con title para el significado. */
  .day-temp-badge {
    position: absolute;
    top: 3px;
    right: 3px;
    font-size: 0.58rem;
    color: #b45309;
    background: #fef3c7;
    border: 1px solid #fde68a;
    border-radius: 999px;
    padding: 0 3px;
    line-height: 1.2;
    display: inline-flex;
    align-items: center;
    margin: 0;
  }
  /* El header con ⚡ reserva la esquina: el nombre/píldora Hoy nunca la pisa
     (en columnas angostas la píldora llegaba hasta el badge). */
  .day-header.header-temp {
    padding-right: 16px;
    padding-left: 8px;
  }

  .slots-grid {
    flex: 1;
    position: relative;
    overflow: hidden;
    /* La altura la fija la grilla de fondo vía --total-slots; los hijos son
       absolutos (top/height en %) para poder animar la cascada. */
    /* Repeating guide lines: :00 solid line, :30 subtle line, :15 and :45 faint lines */
    background-size: 100% calc(var(--slot-height) * 4);
    background-image: linear-gradient(
      to bottom,
      rgba(0, 0, 0, 0.09) 0px,
      rgba(0, 0, 0, 0.09) 1px,
      transparent 1px,
      transparent calc(var(--slot-height) - 1px),
      rgba(0, 0, 0, 0.02) calc(var(--slot-height) - 1px),
      rgba(0, 0, 0, 0.02) var(--slot-height),
      transparent var(--slot-height),
      transparent calc(var(--slot-height) * 2 - 1px),
      rgba(0, 0, 0, 0.05) calc(var(--slot-height) * 2 - 1px),
      rgba(0, 0, 0, 0.05) calc(var(--slot-height) * 2),
      transparent calc(var(--slot-height) * 2),
      transparent calc(var(--slot-height) * 3 - 1px),
      rgba(0, 0, 0, 0.02) calc(var(--slot-height) * 3 - 1px),
      rgba(0, 0, 0, 0.02) calc(var(--slot-height) * 3),
      transparent calc(var(--slot-height) * 3)
    );
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  }

  .slots-grid::before {
    content: '';
    display: block;
    height: calc(var(--total-slots) * var(--slot-height));
  }

  .activity-item {
    position: absolute;
    background: var(--bg-color);
    /* Texto adaptativo por luminancia (WCAG 1.4.3): el blanco fijo
       fallaba en categorías claras — 2.26:1 «oración», 3.51:1 «Cocinar». */
    color: var(--fg-color, white);
    margin: 1px;
    border-radius: 4px;
    /* Padding fino: en columnas de piso (56-66px) cada px horizontal decide
       entre "Almuerzo" entero o roto a mitad de palabra. */
    padding: 2px 3px;
    text-align: left;
    border: none;
    cursor: grab;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
    overflow: hidden;
    opacity: 0.93;
    /* Cascada animada (igual que la vista Día): top/height transicionan. */
    transition: top 0.18s cubic-bezier(0.2, 0, 0, 1), height 0.18s cubic-bezier(0.2, 0, 0, 1), transform 0.15s, box-shadow 0.15s, opacity 0.15s;
    min-width: 0;
    min-height: 24px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    box-sizing: border-box;
    -webkit-user-select: none;
    user-select: none; /* arrastrar >5px no selecciona el texto de la grilla */
  }  /* Tarjeta ORIGINAL durante el drag: atenuada, sin más (el bloque real
     vuela bajo el cursor como clon). Sin transición: con top/transform
     animados la tarjeta perseguía al cursor con retardo (drag entrecortado
     y "dirección invertida" percibida). */
  .activity-item.drag-ghost {
    opacity: 0.45;
    transition: none;
    /* Parpadeo de z-index (fix): la tarjeta original vive bajo el cursor y
       el :hover le dispara sin parar (con el shake del clon, alterna
       hover/no-hover = salto frenético de índices z con el vecino pisado).
       z-index fijo alto durante TODO el gesto. */
    z-index: 100;
  }
  .col-dragging .activity-item.drag-ghost:hover,
  .col-dragging .activity-item.drag-ghost:focus-visible {
    z-index: 100;
    transform: none;
    outline: none;
  }

  /* En pleno drag los vecinos no compiten: sin hover (scale/outline/z-index)
     ni focus ring — el plano superior es SOLO del arrastrado. */
  .col-dragging .activity-item:hover,
  .col-dragging .activity-item:focus-visible {
    transform: none;
    outline: none;
    z-index: auto;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  }

  /* Drop inválido: no cabe — rojo y al soltar el bloque vuelve. */
  .activity-item.drop-invalid {
    background: #e0453a !important;
    color: #fff !important;
  }

  /* Accesibilidad: sin deslizamientos para quien pide menos movimiento. */
  @media (prefers-reduced-motion: reduce) {
    .activity-item,
    .activity-item.drag-ghost,
    .drag-float,
    .drag-float.shake {
      transition: none !important;
      animation: none !important;
    }
  }

  /* ── Resize bidireccional: asa superior (espejo de la inferior) ── */
  .resize-handle.top {
    top: 0;
    bottom: auto;
  }
  .resize-handle.top::after {
    bottom: auto;
    top: 2px;
  }

  /* ── Fantasma flotante estilo demo: BLOQUE COMPLETO (fixed, clon del
     arrastrado con su tamaño real y color de categoría) ── */
  .drag-float {
    position: fixed;
    z-index: 1000;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--bg-color, #2d3748);
    color: #fff;
    overflow: hidden;
    box-sizing: border-box;
    /* Sombra del bloque flotante de la demo: capa de contacto + caída suave
       y profunda, con la rotación característica del arrastre. will-change
       promueve el clon a su propia capa: el scroll no re-rasteriza la sombra
       (se "perdía" al scrollear con el bloque agarrado). */
    box-shadow: 0 4px 10px rgba(0, 0, 0, 0.18), 0 12px 28px rgba(0, 0, 0, 0.32);
    transform: rotate(-1.5deg);
    will-change: transform, box-shadow;
    transition: background 0.15s, box-shadow 0.15s;
  }
  /* Shake ONE-SHOT: la clase .shake solo se enciende en la transición
     válido→inválido (setInvalid del script) y se limpia en animationend —
     pegarla a .invalido (re-aplicada en cada pointermove cerca del límite)
     reinicia la animación en cada movimiento = zumbido frenético. */
  .drag-float.invalido {
    background: #e0453a !important;
    box-shadow: 0 0 0 3px rgba(224, 69, 58, 0.4), 0 12px 28px rgba(0, 0, 0, 0.35);
  }
  .drag-float.shake {
    animation: shake 0.3s ease;
  }
  .drag-float .df-title {
    font-weight: 700;
    font-size: 0.78rem;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .drag-float .df-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    white-space: normal;
    word-break: break-word;
  }
  .drag-float .df-hora {
    font-size: 0.62rem;
    font-weight: 700;
    opacity: 0.92;
  }
  @keyframes shake {
    0%, 100% { margin-left: 0; }
    25% { margin-left: -3px; }
    75% { margin-left: 3px; }
  }

  /* Inhibir el hover en pleno drag: sin scale/translate ni re-layout
     (causa de ticks y sacudidas al agarrar). */
  .activity-item:active.drag-ghost {
    transform: scale(0.98);
  }
  .activity-item:hover,
  .activity-item:focus-visible {
    opacity: 1;
    z-index: 5;
    box-shadow: 0 3px 10px rgba(0,0,0,0.25);
    outline: 3px solid var(--color-green-dark, #2d5a3d);
    outline-offset: 2px;
  }

  .activity-item:active {
    cursor: grabbing;
  }

  /* Handle de redimensionado (estirar borde inferior) */
  /* Zona PROPORCIONAL (30%, piso 9px, tope 22px): tarjetas cortas de 15-30
     min conservan superficie suficiente para agarrar y mover. */
  .resize-handle {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 30%;
    min-height: 9px;
    max-height: 22px;
    cursor: ns-resize;
    touch-action: none;
  }
  .resize-handle::after {
    content: '';
    position: absolute;
    left: 20%;
    right: 20%;
    bottom: 2px;
    height: 3px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.5);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .activity-item:hover .resize-handle::after,
  .activity-item:focus-visible .resize-handle::after {
    opacity: 1;
  }

  /* ── Asas horizontales (estirar a días vecinos) ──
     Franjas laterales angostas, separadas de las verticales (las esquinas
     quedan para el resize vertical: fricción mínima entre gestos). */
  /* Asas laterales: el indicador (píldora) existe SOLO donde el gesto tiene
     sentido — límites del tramo y huecos — porque el elemento del asa ya se
     crea únicamente ahí (asaLateralUtil). En el medio de un tramo contiguo
     no hay asa ni píldora: arrastrar desde el borde mueve el bloque.
     La píldora va MORDIDA hacia adentro (5-9px) para no caer sobre la
     frontera entre columnas, con anillo oscuro + sombra para leerse igual
     sobre bloques claros y oscuros. */
  .resize-handle.hres-izq {
    left: 1px;
    right: auto;
    top: 25%;
    bottom: 25%;
    width: 12px;
    height: auto;
    min-height: 0;
    max-height: none;
    cursor: ew-resize;
  }
  .resize-handle.hres-der {
    left: auto;
    right: 1px;
    top: 25%;
    bottom: 25%;
    width: 12px;
    height: auto;
    min-height: 0;
    max-height: none;
    cursor: ew-resize;
  }
  .resize-handle.hres-izq::after,
  .resize-handle.hres-der::after {
    top: 22%;
    bottom: 22%;
    width: 4px;
    height: auto;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.8);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.22), 0 1px 2px rgba(0, 0, 0, 0.3);
  }
  .resize-handle.hres-izq::after {
    left: 4px;
  }
  .resize-handle.hres-der::after {
    left: auto;
    right: 4px;
  }

  .activity-item:hover {
    opacity: 1;
    z-index: 30;
    transform: scale(1.02);
    box-shadow: 0 4px 12px rgba(0,0,0,0.22);
  }

  .slots-grid:hover {
    background-color: rgba(0,0,0,0.01);
  }

  /* Título de la tarjeta: BLOCK con miniatura FLOAT a la derecha (antes era
     flex space-between y la miniatura le robaba 22px SIEMPRE al texto — en
     columnas de 66px quedaban 38px y "Rutina" (38.4px) se partía a la mitad.
     Con float el texto fluye alrededor: las palabras largas bajan enteras a
     la 2ª línea en vez de truncarse a "Desa…". */
  .activity-title {
    font-weight: 700;
    /* Grupo CENTRADO (nombre + miniatura + pasos) en horizontal y vertical:
       flex-wrap para que en columnas angostas la miniatura baje a una 2ª
       línea centrada en vez de robarle ancho al nombre ("Rutina" se
       truncaba a 32px útiles con la miniatura flotando a la derecha). */
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    /* Separación nombre ↔ miniatura: a 3px quedaban pegados (captura del
       usuario). 6px los despega sin forzar el salto de línea en columnas
       anchas. */
    gap: 6px;
    text-align: center;
    font-size: 0.78rem;
    overflow: hidden;
    width: 100%;
    line-height: 1.25;
  }

  .activity-title > span {
    flex: 0 1 auto;
    min-width: 0;
  }

  .activity-title span {
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    white-space: normal;
    /* Cortes con guion real ("Al-muerzo") en vez de letras huérfanas
       ("Almuerz/o") que dejaba break-word. overflow-wrap solo responde si
       una palabra entera excede TODA la línea. Requiere <html lang> correcto
       (el store idioma lo mantiene en espejo). */
    hyphens: auto;
    -webkit-hyphens: auto;
    overflow-wrap: break-word;
    min-width: 0;
  }

  /* Bloques de 15 min (1 slot): una sola línea con ellipsis — 2 líneas
     no caben en la altura del bloque y el texto se recorta. La miniatura
     baja a 14px para cederle el mayor ancho posible al nombre. */
  .activity-item.short .activity-title {
    font-size: 0.68rem;
  }
  .activity-item.short .activity-title span {
    -webkit-line-clamp: 1;
    line-clamp: 1;
    white-space: nowrap;
    display: block;
  }
  .grid-image-thumb.short {
    --thumb: 14px;
  }
  /* Bloques de UN slot (≤15 min): el bloque mide ~13px y ni la línea de
     texto le cabe (auditoría UX: "ilegibles"). El nombre desborda HACIA
     FUERA del bloque (patrón Google Calendar) con sombra para leerse sobre
     lo que haya debajo; miniatura e icono de pasos se ocultan (más chicos
     que el bloque, y el botón de 14px violaba el touch target de 44px). */
  .activity-item.mini {
    overflow: visible;
    z-index: 3;
  }
  .activity-item.mini .activity-title {
    font-size: 0.66rem;
    line-height: 1.15;
    margin-top: -1px;
    overflow: visible;
  }
  .activity-item.mini .activity-title span {
    -webkit-line-clamp: unset;
    line-clamp: unset;
    white-space: nowrap;
    overflow: visible;
    text-overflow: clip;
    text-shadow: 0 1px 2px var(--fg-shadow, rgba(0, 0, 0, 0.55)), 0 0 3px var(--fg-shadow, rgba(0, 0, 0, 0.35));
  }
  .activity-item.mini .grid-steps-icon {
    display: none;
  }
  /* Con las columnas compactas de móvil (piso 56px) el título normal baja
     un punto: "Miércoles" completo entra en 56px sin recortes agresivos. */
  @container weekly-grid (width < 480px) {
    .activity-title {
      font-size: 0.7rem;
    }
    .activity-item.short .activity-title {
      font-size: 0.62rem;
    }
    .grid-image-thumb {
      --thumb: 15px;
    }
  }

  /* Hint de scroll horizontal solo cuando el contenedor es angosto */
  .scroll-hint {
    display: none;
  }
  @container weekly-grid (width < 768px) {
    .scroll-hint {
      display: block;
      font-size: 0.75rem;
      color: #6b7a6e;
      padding: 2px 4px 6px;
      text-align: center;
      animation: hint-fade 5s ease forwards;
    }
  }
  @keyframes hint-fade {
    0%, 70% { opacity: 1; }
    100% { opacity: 0.35; }
  }

  .grid-steps-icon {
    display: inline-flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.3);
    padding: 1px 3px;
    border-radius: 4px;
    font-size: 0.65rem;
    flex-shrink: 0;
  }

  /* Miniatura de imagen de la tarjeta (Semana): círculo de la foto real con
     anillo blanco para destacar sobre cualquier color de categoría. Mismo
     concepto que .activity-image-thumb de la vista Día. FLOAT right: el
     nombre usa el ancho restante y las palabras completas bajan limpias —
     sin partir palabras ni truncar por culpa de la foto. */
  .grid-image-thumb {
    /* El tamaño vive en --thumb porque AHORA lo calcula la geometría: el
       `left` inline del botón es calc(… - var(--thumb) …), así que una
       única variable mueve el visual y mantiene el pegado al borde. */
    --thumb: 18px;
    position: absolute; /* ancla del ::before (zona táctil invisible) */
    /* POR ENCIMA del bloque, no dentro de él: al ser hermana tiene que
       ganarle en el orden de pintado. .activity-item sube a z-index 5 en
       :hover/:focus-visible, y con la miniatura en 2 el bloque entero —asas
       de estirar incluidas— se pintaba por delante: el clic caia en el asa
       y redimensionaba la actividad en vez de abrir la imagen (medido con
       elementFromPoint simulando ese hover). 6 queda por encima del bloque
       en reposo y en hover, y por debajo del fantasma de arrastre (100),
       que sí debe taparla. */
    z-index: 6;
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    padding: 0;
    border: 2px solid rgba(255, 255, 255, 0.9);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    cursor: zoom-in;
    background: none;
    transition: transform 0.15s;
  }
  .grid-image-thumb:hover {
    transform: scale(1.2);
  }
  .grid-image-thumb:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .grid-image-thumb img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%; /* recorte aquí: el botón necesita overflow
                           visible para su zona táctil (::before) */
    object-fit: cover;
  }
  /* Táctil: 18px es inalcanzable con dedo (hallazgo de la auditoría UX).
     Sin puntero fino la miniatura sube a 32px visuales y un ::before
     transparente extiende la ZONA EFECTIVA a 44px (regla dura #5):
     el anillo visible no crece, el target sí. En desktop sigue 18px
     para no robar espacio a tarjetas cortas. */
  @media (hover: none) and (pointer: coarse) {
    .grid-image-thumb {
      --thumb: 32px;
    }
    /* box-sizing: border-box → el padding-box del botón es 32 − 2×2px
       de borde = 28px, y `inset` se mide SOBRE ÉSE. −8px → 28 + 16
       = 44px de zona real (verificado con elementFromPoint). */
    .grid-image-thumb::before {
      content: '';
      position: absolute;
      inset: -8px;
    }
    /* Bloques cortos: el visual sigue en 14px (la regla de arriba, con
       especificidad 0,2,0, gana), pero la zona efectiva llega a 44px
       (padding-box 10px + 2×17px). */
    .grid-image-thumb.short::before {
      inset: -17px;
    }
    /* Bloques cortos: con wrap, el nombre (nowrap, base completa
       de la línea) empuja la miniatura a la 2ª línea en AMBOS
       sentidos — row y row-reverse (medido: centro al ~69% de
       la tarjeta, dentro del asa inferior → hitW de 1px, peor
       que desktop). Con nowrap el nombre cede ancho (min-width:0
       ya lo permite) y se trunca con ellipsis; la miniatura
       queda en la línea 1, centrada verticalmente al 50% de la
       tarjeta: lejos del asa inferior (30% inferior) y de la
       superior. El nombre entero sigue en title/aria-label de
       la tarjeta. */
    .activity-item.short .activity-title {
      flex-wrap: nowrap;
    }
    /* El ::before de 44×44 se pinta MÁS ALLÁ del padding-box del
       botón: en cortos sobresale ~12px por la izquierda de la
       tarjeta, y en todas sobrepasa el borde de .activity-title.
       Pero AMBOS ancestros tienen overflow:hidden, que en
       hit-testing RECORTA el ::before (bitmap elementFromPoint:
       zona efectiva real de solo ~28×12px con el ::before de
       44×44 computado — medido en vivo). En táctil los ancestros
       dejan de recortar: el ::before es transparente (cero
       impacto visual — el nombre sigue truncándose en el <span>,
       que tiene su propio overflow:hidden + ellipsis) y el
       target sí llega a 44px reales. Desktop intacto: la regla
       vive dentro del media query, donde el ::before no existe. */
    .activity-title {
      overflow: visible;
    }
    .activity-item.short {
      overflow: visible;
    }
    /* Bloques cortos (<44px de alto): la zona interactiva se amplía a 44px
       con un pseudo-elemento transparente, como ya se hace con las
       miniaturas. El visual sigue siendo de 24-27px (la escala temporal no
       se toca: un bloque de 15 min son 15 min), lo que cambia es lo que el
       dedo alcanza.

       La ampliación roza ~10px del bloque de arriba y del de abajo cuando
       están pegados. Es el mismo canje que ya se acepta con las miniaturas
       y, a cambio, el objetivo pasa de 24x60 a 44x60 casi el doble de
       área). Con mouse NO se aplica nada de esto: ahí 24px ya cumple
       WCAG 2.2 AA (Target Size 2.5.8 pide 24x24) y ampliar la zona
       robaría clics al vecino sin ganar nada. */
    .activity-item.short::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: 50%;
      /* 46 y no 44: al centrar sobre una altura fraccionaria el hit-testing
         cae un píxel por debajo de lo declarado, y el guard mide entero. */
      height: 46px;
      transform: translateY(-50%);
      z-index: 2;
    }
    /* Los ancestros recortan el ::before en hit-testing, igual que pasaba
       con las miniaturas: hay que quitarles el overflow en táctil. */
    .day-column,
    .slots-grid {
      overflow: visible;
    }
  }

  /* Popover de imagen (hover): foto ampliada + nombre, anclada encima de la
     miniatura. pointer-events none: el mouse puede "salir" hacia él sin que
     parpadee; desaparece al salir de la miniatura. */
  .img-popover {
    position: fixed;
    z-index: 1000;
    /* 12px sobre la miniatura: a 8px la foto quedaba pegada al bloque. */
    transform: translate(-50%, calc(-100% - 12px));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 6px;
    border-radius: 10px;
    background: white;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22), 0 2px 6px rgba(0, 0, 0, 0.12);
    pointer-events: none;
    animation: img-pop-in 0.15s ease;
  }
  @keyframes img-pop-in {
    from { opacity: 0; transform: translate(-50%, calc(-100% - 4px)); }
    to { opacity: 1; transform: translate(-50%, calc(-100% - 8px)); }
  }
  .img-popover img {
    width: 120px;
    height: 120px;
    object-fit: cover;
    border-radius: 6px;
    display: block;
  }
  .img-popover-name {
    max-width: 124px;
    font-size: 0.72rem;
    font-weight: 700;
    color: var(--color-brown-bark, #4a3728);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  }

  .custom-context-menu button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    min-height: 44px; /* regla dura #5: medido 39px antes */
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

  /* Desktop grande / ultrawide (≥1536px): la cabecera de día gana aire y la
     tipografía de bloques sube medio punto — en 21:9 la grilla es el elemento
     dominante y merece la legibilidad extra. AL FINAL del bloque: misma
     especificidad que las reglas base, gana por orden de cascade. */
  @media (min-width: 1536px) {
    .header-spacer {
      height: 48px;
    }
    .day-header {
      height: 52px;
      font-size: 0.95rem;
    }
    .activity-title {
      font-size: 0.88rem;
    }
    .activity-item.short .activity-title {
      font-size: 0.76rem;
    }
    .hour-label {
      font-size: 0.78rem;
    }
  }
</style>
