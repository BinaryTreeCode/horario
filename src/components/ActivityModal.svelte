<script lang="ts">
  import { onMount } from 'svelte';
  import { db, newId } from '../lib/db';
  import { parseTime, formatTime } from '../lib/stores';
  import type { Activity, Category, ActivityStep } from '../lib/types';
  import { X, Trash2, CheckCircle, Plus, CheckSquare, Square, ListChecks, Sparkles, Zap, Calendar, ImageIcon, Link2, RefreshCw } from '@lucide/svelte';
  import ImageLightbox from './ImageLightbox.svelte';
  import { t, tNow } from '../lib/i18n';
  import { fueConsumido } from '../lib/dialogStack';
  import { sembrarSinPisar } from '../lib/activitySeed';
  import { comprimirImagen, subirABlob, DIM_LOCAL, DIM_BLOB } from '../lib/routineImages';
  import { isLoggedIn } from '../lib/sync';

  interface Props {
    id: string | null;
    categories: Category[];
    settings: { startHour: number; endHour: number };
    targetDay?: number | null;
    initialData?: Activity | null;
    onClose: () => void;
  }

  let { id, categories, settings, targetDay = null, initialData = null, onClose }: Props = $props();

  let categoryId = $state('');
  let name = $state('');
  let description = $state('');
  let startTime = $state('08:00');
  let endTime = $state('09:00');
  let daysOfWeek = $state([0, 1, 2, 3, 4, 5, 6]);
  let steps = $state<ActivityStep[]>([]);
  let newStepInput = $state('');
  let image = $state<string | null>(null);
  let imageUrlInput = $state('');
  let showImageUrlInput = $state(false);
  let showImagePreview = $state(false);
  let previewActivity = $state<Activity | null>(null);
  let modalEl: HTMLElement | undefined = $state();

  // Scope: 'day' writes to dayOverrides, 'week' writes to db.activities
  let saveScope = $state<'day' | 'week'>('week');
  $effect(() => {
    saveScope = targetDay !== null ? 'day' : 'week';
  });

  // Derived category color for preview
  const activeCategory = $derived(categories.find(c => c.id === categoryId));
  const categoryColor = $derived(activeCategory?.color || '#eeeeee');

  // Format 12h for labels
  function format12h(timeStr: string) {
    const [h, m] = timeStr.split(':').map(Number);
    const period = h < 12 ? 'AM' : (h >= 24 ? 'AM' : 'PM');
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
  }

  // Duration in minutes
  const durationMinutes = $derived.by(() => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    return diff > 0 ? diff : 0;
  });

  // Asegurar categoría seleccionada: por defecto 'Rutina' (la categoría
  // base de la app), no la primera de la lista — una actividad nueva sin
  // elección consciente del usuario cae en lo genérico.
  $effect(() => {
    if (!categoryId && categories.length > 0) {
      categoryId = categories.some(c => c.id === 'rutina') ? 'rutina' : categories[0].id;
    }
  });

  // Cerrar con Esc (sin robar el foco si hay un lightbox de imagen abierto encima)
  $effect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // Con el lightbox o un ConfirmDialog encima, el Esc es de ese diálogo.
      if (e.key === 'Escape' && !showImagePreview && !fueConsumido(e)) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  // Foco inicial dentro del diálogo (lectores de pantalla y teclado: si no,
  // el foco queda en <body> y el trap de Tab no tiene punto de partida).
  // El componente se monta solo cuando se muestra ({#if showActivityModal}),
  // así que el montaje ES la apertura.
  $effect(() => {
    if (modalEl) modalEl.focus({ preventScroll: true });
  });

  function trapFocus(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !modalEl) return;
    const focusables = modalEl.querySelectorAll<HTMLElement>(
      'button:not([hidden]), input:not([hidden]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Time options (every 15 mins) within configured schedule limits
  const allTimes = $derived(() => {
    const times = [];
    const start = settings.startHour;
    const end = settings.endHour;
    for (let h = start; h < end; h++) {
      for (const m of [0, 15, 30, 45]) {
        const hStr = h.toString().padStart(2, '0');
        const mStr = m.toString().padStart(2, '0');
        times.push({ value: `${hStr}:${mStr}`, label: format12h(`${hStr}:${mStr}`) });
      }
    }
    const endStr = end.toString().padStart(2, '0');
    times.push({ value: `${endStr}:00`, label: format12h(`${endStr}:00`) });
    return times;
  });

  const startTimeOptions = $derived(
    (() => {
      const opts = allTimes().filter(t => parseMinutes(t.value) < settings.endHour * 60);
      if (startTime && !opts.some(o => o.value === startTime)) {
        opts.push({ value: startTime, label: format12h(startTime) });
        opts.sort((a, b) => parseMinutes(a.value) - parseMinutes(b.value));
      }
      return opts;
    })()
  );

  const endTimeOptions = $derived(() => {
    const sMin = parseMinutes(startTime);
    const opts = allTimes().filter(t => parseMinutes(t.value) > sMin);
    if (endTime && !opts.some(o => o.value === endTime)) {
      opts.push({ value: endTime, label: format12h(endTime) });
      opts.sort((a, b) => parseMinutes(a.value) - parseMinutes(b.value));
    }
    return opts;
  });

  function parseMinutes(timeStr: string) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
  }

  function addDuration(durationMins: number) {
    const sMin = parseMinutes(startTime);
    const newEndMin = sMin + durationMins;
    const h = Math.floor(newEndMin / 60);
    const m = newEndMin % 60;
    endTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  // ── Imagen de la rutina ─────────────────────────────────────────
  let subiendoImagen = $state(false);

  async function handleImageFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toastErr(tNow('modal.notImage'));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toastErr(tNow('modal.imageTooBig'));
      return;
    }
    input.value = '';
    subiendoImagen = true;
    try {
      // La resolución depende de DÓNdé va a acabar la imagen, no de una sola
      // regla global:
      //
      // - Con sesión: va a Vercel Blob y en la actividad se guarda SOLO la URL
      //   (~100 bytes). El peso no lo paga la base de datos, así que se sube a
      //   DIM_BLOB y el lightbox deja de verse blando en pantallas de alta
      //   densidad. Tope de /api/images: 2 MB, y una WebP de 1600px anda por
      //   los cientos de KB.
      // - Sin sesión: la data-URL queda DENTRO de la actividad. Aquí sí manda
      //   DIM_LOCAL, porque es lo que llena el respaldo automático y lo que
      //   puede provocar el 413 del push.
      //
      // El respaldo ligero se recalcula solo si la subida falla (sin Blob
      // configurado, error de red): el fallback guardado en la actividad
      // tiene que ser siempre el pequeño, nunca el grande.
      const sesion = await isLoggedIn();
      const comprimida = await comprimirImagen(file, sesion ? DIM_BLOB : DIM_LOCAL);
      if (sesion) {
        try {
          image = await subirABlob(comprimida);
        } catch {
          image = await comprimirImagen(file, DIM_LOCAL);
        }
      } else {
        image = comprimida;
      }
      showImageUrlInput = false;
      imageUrlInput = '';
    } catch (err: any) {
      toastErr(tNow('toast.couldNotMove') + ': ' + (err?.message || err));
    } finally {
      subiendoImagen = false;
    }
  }

  function applyImageUrl() {
    const url = imageUrlInput.trim();
    if (!url) return;
    image = url;
    imageUrlInput = '';
    showImageUrlInput = false;
  }

  function removeImage() {
    image = null;
    showImageUrlInput = false;
    imageUrlInput = '';
  }

  function openImagePreview() {
    if (!image) return;
    previewActivity = {
      categoryId,
      name: name || 'Actividad',
      startTime,
      endTime,
      daysOfWeek: [...daysOfWeek],
      steps: $state.snapshot(steps),
      image
    };
    showImagePreview = true;
  }

  function addStep() {
    if (!newStepInput.trim()) return;
    steps = [
      ...steps,
      {
        id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: newStepInput.trim(),
        completed: false
      }
    ];
    newStepInput = '';
  }

  function removeStep(stepId: string) {
    steps = steps.filter(s => s.id !== stepId);
  }

  function toggleStep(stepId: string) {
    steps = steps.map(s => s.id === stepId ? { ...s, completed: !s.completed } : s);
  }

  function applyRoutinePresets() {
    const defaultRoutineSteps = [0, 1, 2, 3].map(i => tNow(`modal.preset.${i}`));
    const newSteps = defaultRoutineSteps.map(t => ({
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: t,
      completed: false
    }));
    steps = [...steps, ...newSteps];
    toastOk(tNow('modal.stepsAdded', { n: 4 }));
  }

  const days = $derived([0, 1, 2, 3, 4, 5, 6].map(i => ({ label: $t(`modal.dayLetter.${i}`), index: i })));

  onMount(async () => {
    // Foto de los campos en el montaje: la referencia para saber qué NO tocó
    // nadie antes de que llegue la lectura async de la fila.
    const foto = {
      categoryId, name, description, startTime, endTime, daysOfWeek, steps, image
    };
    // If initialData is provided (from dayOverride), use it
    if (initialData) {
      categoryId = initialData.categoryId;
      name = initialData.name;
      description = initialData.description || '';
      startTime = initialData.startTime;
      endTime = initialData.endTime;
      daysOfWeek = [...(initialData.daysOfWeek || [])];
      steps = initialData.steps ? [...initialData.steps] : [];
      image = initialData.image || null;
    } else if (id !== null) {
      const activity = await db.activities.get(id);
      if (activity) {
        // La lectura es async: entre que montó y que llegó, la persona pudo
        // tocar un campo. sembrarSinPisar solo siembra lo que sigue igual que en
        // el montaje, así una elección rápida ya no se pierde (el bug que
        // hacia fallar al guard "Modal: aumentar" 1 de cada 8 corridas).
        categoryId = sembrarSinPisar(categoryId, foto.categoryId, activity.categoryId);
        name = sembrarSinPisar(name, foto.name, activity.name);
        description = sembrarSinPisar(description, foto.description, activity.description || '');
        startTime = sembrarSinPisar(startTime, foto.startTime, activity.startTime);
        endTime = sembrarSinPisar(endTime, foto.endTime, activity.endTime);
        daysOfWeek = sembrarSinPisar(daysOfWeek, foto.daysOfWeek, [...activity.daysOfWeek]);
        steps = sembrarSinPisar(steps, foto.steps, activity.steps ? [...activity.steps] : []);
        image = sembrarSinPisar(image, foto.image, activity.image || null);
      }
    } else {
      const defaultStart = Math.max(settings.startHour, 8);
      const defaultEnd = Math.min(defaultStart + 1, settings.endHour);

      const startHStr = defaultStart.toString().padStart(2, '0');
      const endHStr = defaultEnd.toString().padStart(2, '0');

      startTime = `${startHStr}:00`;
      endTime = `${endHStr}:00`;
    }
  });

  import ConfirmDialog from './ConfirmDialog.svelte';
  import { toastOk, toastErr } from '../lib/toast';
  import { pushUndo, cloneAct } from '../lib/undo';
  import { duplicateActivity as duplicateActivityOp } from '../lib/activityOps';
  import { Copy } from '@lucide/svelte';

  /**
   * No se debe poder crear una actividad si ya existe una que se solape con
   * ella en ALGÚN día seleccionado (pedido del usuario: el menú de hueco
   * ofrecía "crear a las 12:00" sobre un bloque existente y el modal
   * guardaba el choque sin avisar). La actividad editada se excluye a sí
   * misma: moverla o acortarla sí se valida contra las demás.
   *
   * Scope "Solo este día" (override ⚡): la validación corre SOLO contra el
   * día destino (targetDay) y contra el HORARIO VIGENTE de ese día, que
   * calcula `horarioEfectivoDia` (el override ES el día y reemplaza la
   * plantilla; sin override, la plantilla del día).
   *
   * Scope "Plantilla semanal": se valida la plantilla tal cual en los días
   * marcados (un día con override tapa su plantilla, pero el usuario está
   * editando LA PLANTILLA y su consistencia interna).
   */
  async function buscarChoque(nueva: { startTime: string; endTime: string; daysOfWeek: number[] }): Promise<{ name: string; dia: string; rango: string } | null> {
    const { DIAS_SEMANA, horarioEfectivoDia, chocaHoras } = await import('../lib/cascade');
    const scopeDia = targetDay !== null && saveScope === 'day';
    const diasAValidar = scopeDia ? [targetDay] : nueva.daysOfWeek;
    const plantilla = await db.activities.toArray();
    for (const dia of diasAValidar) {
      const override = scopeDia ? await db.dayOverrides.get(dia) : undefined;
      for (const a of horarioEfectivoDia(plantilla, override, dia, id)) {
        if (chocaHoras(nueva.startTime, nueva.endTime, a.startTime, a.endTime)) {
          return { name: a.name, dia: DIAS_SEMANA[dia] ?? `día ${dia}`, rango: `${format12h(a.startTime)} – ${format12h(a.endTime)}` };
        }
      }
    }
    return null;
  }

  /**
   * Plan de escritura del modal: growing es un GESTO, no un error.
   *
   * El reporte: "quiero aumentar un bloque desde la pestaña de configuración
   * con el espacio disponible como en el deslizable". El modal rechazaba con
   * "Ya existe X" mientras el asa topaba y empujaba en cadena. Ahora:
   *
   *  - CRECE → se resuelve con la MISMA matemática del asa
   *    (resolverEstirarGlobal / resolveResizeDay): empuja a quien choca, y si
   *    el día está apretado crece solo hasta donde hay lugar (nunca se rechaza).
   *  - MOVER o ENCOGER → el choque se sigue rechazando como antes: empujar a
   *    los vecinos al mover el bloque es otra decisión, y esa es del deslizable.
   *  - CREAR (id === null) → sin "antes" no hay crecimiento que medir: valida.
   */
  interface PlanEstirar {
    /** No entra: se avisa y no se escribe nada. */
    rechazo?: { name: string; dia: string; rango: string };
    /** id → horario final (la actividad estirada MÁS los vecinos empujados). */
    times?: Map<string, { start: number; end: number }>;
    /** Fin efectivo tras acotar por la capacidad. */
    fin?: number;
    /** El deseo no entró entero: topó con el día más apretado. */
    toco?: boolean;
    /** Vecines que se mueven, para el aviso. */
    movidos?: { id: string; nombre: string; despues: { start: number; end: number } }[];
  }

  async function planEstirar(nueva: Activity): Promise<PlanEstirar | null> {
    if (id === null) return null; // crear: no hay "antes" con qué comparar
    const scopeDia = targetDay !== null && saveScope === 'day';
    const CODEC = { parse: parseTime, format: formatTime };
    const dur = (a: string, b: string) => (parseTime(b) - parseTime(a)) * 60;

    // El "antes": la fila del override si el alcance es un día (el override ES
    // ese día), si no la de la plantilla.
    let antes: Activity | null = null;
    if (scopeDia) {
      const ov = await db.dayOverrides.get(targetDay!);
      antes = ov?.activities?.find(a => a.id === id) ?? await db.activities.get(id);
    } else {
      antes = await db.activities.get(id);
    }
    if (!antes) return null;

    if (dur(nueva.startTime, nueva.endTime) <= dur(antes.startTime, antes.endTime)) {
      const choque = await buscarChoque(nueva); // mover/encoger: valida como antes
      return choque ? { rechazo: choque } : null;
    }

    const { resolverEstirarGlobal, resolveResizeDay, horarioEfectivoDia } = await import('../lib/cascade');
    // El borde fijo es el que el usuario NO tocó: si movió el inicio, el fin
    // queda anclado y la cadena sube (como el asa de arriba).
    const lado = nueva.endTime === antes.endTime ? 'arriba' : 'abajo';

    if (scopeDia) {
      // Un solo día (override ⚡): la matemática del deslizable de la vista Día.
      const override = await db.dayOverrides.get(targetDay!);
      const plantilla = await db.activities.toArray();
      const vigente = horarioEfectivoDia(plantilla, override, targetDay!, id);
      const slots = vigente.map(a => ({ id: a.id!, start: parseTime(a.startTime), end: parseTime(a.endTime) }));
      const deseado = lado === 'abajo' ? parseTime(nueva.endTime) : parseTime(nueva.startTime);
      const res = resolveResizeDay(slots, id, lado, deseado, settings.startHour, settings.endHour);
      if (!res.valido) return { rechazo: { name: antes.name, dia: '', rango: res.motivo } };
      const times = new Map<string, { start: number; end: number }>();
      for (const sl of res.slots) times.set(sl.id, { start: sl.start, end: sl.end });
      times.set(id, { start: res.movido.start, end: res.movido.end });
      const movidos = res.slots
        .filter(sl => sl.id !== id)
        .filter(sl => {
          const a = vigente.find(v => v.id === sl.id);
          return !!a && (parseTime(a.startTime) !== sl.start || parseTime(a.endTime) !== sl.end);
        })
        .map(sl => ({ id: sl.id, nombre: vigente.find(v => v.id === sl.id)?.name ?? sl.id, despues: { start: sl.start, end: sl.end } }));
      const finEfectivo = res.movido.end;
      return {
        times,
        fin: finEfectivo,
        toco: Math.abs(finEfectivo - deseado) > 1e-6 && lado === 'abajo',
        movidos
      };
    }

    // Plantilla semanal: la duración es GLOBAL y el tope es el día más apretado.
    const plantilla = await db.activities.toArray();
    const res = resolverEstirarGlobal(
      plantilla, id, parseTime(nueva.startTime), parseTime(nueva.endTime),
      CODEC, settings.startHour, settings.endHour, lado
    );
    if (!res.valido) return { rechazo: { name: antes.name, dia: '', rango: res.motivo } };
    return { times: res.times, fin: res.fin, toco: res.toco, movidos: res.movidos };
  }

  async function save() {
    try {
      if (!categoryId) {
        toastErr(tNow('modal.nameRequired'));
        return;
      }

      const activity: Activity = {
        categoryId,
        name,
        description,
        startTime,
        endTime,
        daysOfWeek: [...daysOfWeek],
        steps: $state.snapshot(steps),
        ...(image ? { image } : {}),
        updatedAt: Date.now()
      };

      // Crecer usa el espacio disponible (como el asa). Mover o encoger
      // siguen validando el choque de antes.
      const plan = await planEstirar(activity);
      if (plan?.rechazo) {
        toastErr(tNow('toast.choca', plan.rechazo));
        return;
      }

      if (targetDay !== null && saveScope === 'day') {
        // Save to dayOverrides (temporary, day-only)
        const existing = await db.dayOverrides.get(targetDay);
        const overrideExisted = !!existing?.activities;
        let overrideActs: Activity[] = existing?.activities
          ? existing.activities.map(a => ({ ...a }))
          : [];

        // Siembra desde la plantilla master del día: sin esto, la primera
        // edición ⚡ crearía un override con UNA sola actividad y vaciaría
        // el resto del día en la vista Día.
        if (!overrideExisted) {
          overrideActs = (await db.activities.toArray())
            .filter(a => !a.deletedAt && a.daysOfWeek.includes(targetDay))
            .map(a => ({ ...a }));
        }

        if (id !== null) {
          const idx = overrideActs.findIndex(a => a.id === id);
          activity.id = id;
          if (idx >= 0) {
            overrideActs[idx] = activity;
          } else {
            overrideActs.push(activity);
          }
          // Estirado con empuje: los vecinos del día se van a la hora resuelta
          // (el override se guarda entero, así que alcanza con escribirlos).
          if (plan?.times) {
            overrideActs = overrideActs.map(a => {
              const t = plan.times!.get(a.id!);
              return t ? { ...a, startTime: formatTime(t.start), endTime: formatTime(t.end) } : a;
            });
          }
        } else {
          // New activity: assign a temporary ID
          activity.id = newId();
          overrideActs.push(activity);
        }

        await db.dayOverrides.put({
          day: targetDay,
          activities: overrideActs,
          updatedAt: Date.now()
        });
      } else if (plan?.times && id !== null) {
        // ESTIRADO CON EMPUJE en la plantilla: la actividad editada MÁS los
        // vecinos movidos entran en UN commit (transacción atómica + un solo
        // paso de deshacer + updatedAt fresco en cada fila). Escrituras sueltas
        // dejarían la semana a medio camino si algo fallara en el medio.
        const acts: Activity[] = [];
        for (const [actId, slot] of plan.times) {
          if (actId === id) {
            acts.push({ ...activity, id, startTime: formatTime(slot.start), endTime: formatTime(slot.end) });
            continue;
          }
          const before = await db.activities.get(actId);
          if (!before) continue;
          acts.push({ ...before, startTime: formatTime(slot.start), endTime: formatTime(slot.end) });
        }
        const { commitCambios } = await import('../lib/commit');
        await commitCambios({ label: `${tNow('modal.stretched')} — ${activity.name}`, acts });
      } else {
        // Save to master db.activities (permanent)
        if (id !== null) {
          const before = await db.activities.get(id);
          activity.id = id;
          await db.activities.put(activity);
          if (before) pushUndo({ label: `${tNow('toast.saved')} — ${activity.name}`, rows: [{ before, after: cloneAct(activity) }] });
        } else {
          activity.id = newId();
          await db.activities.add(activity);
          pushUndo({ label: `${tNow('toast.created')} — ${activity.name}`, rows: [{ before: null, after: cloneAct(activity) }] });
        }
      }

      if (plan?.times && plan.fin !== undefined) {
        // El aviso dice la verdad: hasta dónde llegó y a qué hora se movió cada
        // vecino. Sin esto el usuario ve bloques corridos sin explicación.
        const fin = formatTime(plan.fin);
        const movidos = (plan.movidos ?? []).map(m => `${m.nombre} ${format12h(formatTime(m.despues.start))}`).join(', ');
        toastOk(
          plan.toco
            ? tNow('modal.grewCapped', { name: activity.name, fin: format12h(fin) })
            : movidos
              ? tNow('modal.grewPushed', { name: activity.name, fin: format12h(fin), movidos })
              : tNow('modal.grewTo', { name: activity.name, fin: format12h(fin) })
        );
      } else {
        toastOk(id !== null ? tNow('toast.saved') : tNow('toast.created'));
      }
      onClose();
    } catch (error: any) {
      console.error('Failed to save activity:', error);
      toastErr(tNow('modal.saveError', { msg: error.message || tNow('settings.networkError') }));
    }
  }

  async function remove() {
    if (id !== null) {
      // El diálogo de confirmación promete "podés deshacerlo": el op tiene que
      // entrar al historial. Antes este flujo NO empujaba nada y el botón
      // Deshacer quedaba deshabilitado: la promesa era falsa.
      const etiqueta = `${tNow('toast.deleted')} — ${name}`;
      if (targetDay !== null && saveScope === 'day') {
        // Remove from dayOverrides. Si el override aún no existe, se siembra
        // desde master SIN la actividad (eliminar "solo este día" no puede
        // crear un override vacío que borre el resto del día).
        const existing = await db.dayOverrides.get(targetDay);
        const acts: Activity[] = existing?.activities
          ? existing.activities.filter(a => a.id !== id)
          : (await db.activities.toArray())
              .filter(a => !a.deletedAt && a.daysOfWeek.includes(targetDay) && a.id !== id)
              .map(a => ({ ...a }));
        await db.dayOverrides.put({
          day: targetDay,
          activities: acts,
          updatedAt: Date.now()
        });
        // Snapshot del override: el undo restaura la fila entera (el bloque
        // vuelve con sus campos) en vez de intentar reinsertar la actividad.
        pushUndo({
          label: etiqueta,
          rows: [],
          overrides: [{ day: targetDay, before: existing ?? null, after: await db.dayOverrides.get(targetDay) ?? null }]
        });
      } else {
        // Borrado suave (tombstone) para que el sync lo propague a otros dispositivos
        const before = await db.activities.get(id);
        await db.activities.update(id, { deletedAt: Date.now(), updatedAt: Date.now() });
        if (before) {
          pushUndo({ label: etiqueta, rows: [{ before, after: await db.activities.get(id) ?? null }] });
        }
      }
      toastOk(tNow('toast.deletedNamed', { name }));
      onClose();
    }
  }

  let confirmRemove = $state(false);
  let confirmDuplicate = $state(false);

  /**
   * Duplica la actividad como bloque independiente (primer hueco libre).
   * Antes vivía SOLO en el menú contextual táctil, que se eliminó en F3 del
   * plan v2 (quiet-hold trababa el arrastre) — ahora el modal es la única vía.
   */
  async function duplicate() {
    if (id === null) return;
    try {
      const clone = await duplicateActivityOp(id, {
        startHour: settings.startHour,
        endHour: settings.endHour,
        days: [...daysOfWeek]
      });
      if (clone) {
        toastOk(tNow('modal.createdCopy', { name: clone.name }));
        pushUndo({
          label: `${tNow('modal.duplicate')} ${clone.name}`,
          rows: [{ before: null, after: cloneAct(clone) }]
        });
      } else {
        toastErr(tNow('toast.noGap'));
      }
    } catch (error: any) {
      toastErr(tNow('modal.duplicateError', { msg: error.message || tNow('settings.networkError') }));
    }
  }

  function toggleDay(index: number) {
    if (daysOfWeek.includes(index)) {
      daysOfWeek = daysOfWeek.filter(d => d !== index);
    } else {
      daysOfWeek = [...daysOfWeek, index].sort();
    }
  }

  function selectWeekdays() {
    daysOfWeek = [0, 1, 2, 3, 4];
  }

  function selectAll() {
    daysOfWeek = [0, 1, 2, 3, 4, 5, 6];
  }
</script>

<div class="modal-overlay" onclick={onClose}>
  <div class="modal-content glass-panel" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1" bind:this={modalEl} onkeydown={trapFocus} onclick={e => e.stopPropagation()}>
    <!-- div, no header: un <header> suelto dentro del modal se convierte en un
         segundo landmark banner (axe: landmark-no-duplicate-banner) -->
    <div class="modal-header">
      <h2 id="modal-title">{id !== null ? $t('modal.editTitle') : $t('modal.newTitle')}</h2>
      <button class="close-btn" onclick={onClose} aria-label={$t('modal.closeNoSave')}><X size={20} /></button>
    </div>

    <form onsubmit={e => { e.preventDefault(); save(); }}>
      <div class="category-preview" style="background: {categoryColor}"></div>

      <!-- Scope selector (only shown when opened from daily view) -->
      {#if targetDay !== null}
        <div class="scope-selector">
          <label class="scope-label">{$t('modal.saveIn')}</label>
          <div class="scope-options">
            <label class="scope-option" class:selected={saveScope === 'day'}>
              <input type="radio" name="scope" value="day" bind:group={saveScope} />
              <Zap size={14} />
              <span>{$t('modal.scopeDay')}</span>
            </label>
            <label class="scope-option" class:selected={saveScope === 'week'}>
              <input type="radio" name="scope" value="week" bind:group={saveScope} />
              <Calendar size={14} />
              <span>{$t('dayView.templateMode')}</span>
            </label>
          </div>
        </div>
      {/if}

      <div class="form-group">
        <label for="act-category">{$t('modal.category')}</label>
        <select id="act-category" bind:value={categoryId} required>
          {#each categories as cat}
            <option value={cat.id}>{cat.label}</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label for="act-name">{$t('modal.whatToDo')}</label>
        <input id="act-name" type="text" bind:value={name} placeholder={$t('modal.namePlaceholder')} required class="input-large" />
      </div>

      <!-- Sección de Imagen de la rutina -->
      <div class="image-box">
        <div class="image-header">
          <div class="image-title">
            <ImageIcon size={18} />
            <span>{$t('modal.routineImage')}</span>
          </div>
          {#if image}
            <div class="image-header-actions">
              <button type="button" class="image-btn" onclick={openImagePreview} title={$t('modal.viewImageTitle')}>
                {$t('modal.view')}
              </button>
              <button type="button" class="image-btn image-btn-danger" onclick={removeImage} title={$t('modal.removeImage')}>
                <Trash2 size={14} /> {$t('modal.remove')}
              </button>
            </div>
          {/if}
        </div>

        {#if image}
          <button type="button" class="image-preview" onclick={openImagePreview} title={$t('lightbox.viewFull')}>
            <img src={image} alt={$t('modal.routineImage')} />
          </button>
        {:else}
          <div class="image-actions">
            <label class="image-upload-btn" class:subiendo={subiendoImagen}>
              <input type="file" accept="image/*" onchange={handleImageFile} hidden disabled={subiendoImagen} />
              {#if subiendoImagen}
                <RefreshCw size={16} class="giro" /> {$t('modal.subiendoImagen')}
              {:else}
                <ImageIcon size={16} /> {$t('modal.uploadFile')}
              {/if}
            </label>
            <button type="button" class="image-upload-btn" onclick={() => showImageUrlInput = !showImageUrlInput}>
              <Link2 size={16} /> {$t('modal.useUrl')}
            </button>
          </div>

          {#if showImageUrlInput}
            <div class="image-url-row">
              <input
                type="url"
                bind:value={imageUrlInput}
                placeholder="https://ejemplo.com/imagen.jpg"
                aria-label={$t('modal.imageUrl')}
                onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); applyImageUrl(); } }}
              />
              <button type="button" class="image-upload-btn" onclick={applyImageUrl}>OK</button>
            </div>
          {/if}
        {/if}
      </div>

      <!-- Sección de Pasos / Subtareas -->
      <div class="steps-box">
        <div class="steps-header">
          <div class="steps-title">
            <ListChecks size={18} />
            <span>{$t('modal.stepsCount', { n: steps.length })}</span>
          </div>
          {#if steps.length === 0}
            <button type="button" class="preset-btn-sparkle" onclick={applyRoutinePresets} aria-label={$t('modal.suggestRoutineAria')}>
              <Sparkles size={14} /> {$t('modal.suggestRoutine')}
            </button>
          {/if}
        </div>

        <div class="step-add-row">
          <input
            type="text"
            bind:value={newStepInput}
            placeholder={$t('modal.stepPlaceholder')}
            aria-label={$t('modal.newStep')}
            class="step-input"
            onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); addStep(); } }}
          />
          <button type="button" class="btn-add-step" onclick={addStep} title={$t('modal.addStep')} aria-label={$t('modal.addStep')}>
            <Plus size={18} /> {$t('modal.add')}
          </button>
        </div>

        {#if steps.length > 0}
          <div class="steps-list">
            {#each steps as step, index (step.id)}
              <div class="step-item" class:completed={step.completed}>
                <button
                  type="button"
                  class="step-check-btn"
                  onclick={() => toggleStep(step.id)}
                  aria-label={$t('modal.completeStep')}
                  aria-pressed={step.completed}
                >
                  {#if step.completed}
                    <CheckSquare size={18} class="check-icon done" />
                  {:else}
                    <Square size={18} class="check-icon" />
                  {/if}
                </button>
                <input
                  type="text"
                  bind:value={step.title}
                  class="step-text-input"
                  class:done-text={step.completed}
                />
                <button
                  type="button"
                  class="step-delete-btn"
                  onclick={() => removeStep(step.id)}
                  aria-label={$t('modal.deleteStep')}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="time-controls-box">
        <div class="time-row-modern">
          <div class="time-picker-group">
            <label for="act-start">{$t('modal.from')}</label>
            <select id="act-start" bind:value={startTime} class="time-select-modern">
              {#each startTimeOptions as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>

          <span class="to-separator">{$t('modal.toSep')}</span>

          <div class="time-picker-group">
            <label for="act-end">{$t('modal.to')}</label>
            <select id="act-end" bind:value={endTime} class="time-select-modern">
              {#each endTimeOptions() as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="duration-controls">
          <span class="hint-text">{$t('modal.quickAdjust')}</span>
          <div class="duration-chips">
            <button type="button" class="chip" onclick={() => addDuration(15)}>15m</button>
            <button type="button" class="chip" onclick={() => addDuration(30)}>30m</button>
            <button type="button" class="chip" onclick={() => addDuration(45)}>45m</button>
            <button type="button" class="chip" onclick={() => addDuration(60)}>1h</button>
            <button type="button" class="chip" onclick={() => addDuration(90)}>1.5h</button>
          </div>
        </div>

        <div class="duration-hint">
          {$t('modal.totalDuration')} <strong>{durationMinutes >= 60 ? `${Math.floor(durationMinutes/60)}h ${durationMinutes%60}m` : `${durationMinutes}m`}</strong>
        </div>
      </div>

      <!-- Days selector: hide when saving only to this day's override -->
      {#if saveScope === 'week'}
        <fieldset class="form-group">
          <legend>{$t('modal.daysOfWeek')}</legend>
          <div class="days-selector">
            {#each days as day}
              <button
                type="button"
                class="day-toggle"
                class:selected={daysOfWeek.includes(day.index)}
                aria-pressed={daysOfWeek.includes(day.index)}
                aria-label={$t(`day.${day.index}`)}
                onclick={() => toggleDay(day.index)}
              >
                {day.label}
              </button>
            {/each}
          </div>
          <div class="presets">
            <button type="button" class="preset-btn" onclick={selectWeekdays}>{$t('modal.weekdays')}</button>
            <button type="button" class="preset-btn" onclick={selectAll}>{$t('modal.allWeek')}</button>
          </div>
        </fieldset>
      {/if}

      <footer class="modal-footer">
        {#if id !== null}
          <button type="button" class="btn btn-danger" onclick={() => confirmDuplicate = true}>
            <Copy size={18} /> {$t('modal.duplicate')}
          </button>
          <button id="btn-delete-activity" type="button" class="btn btn-danger" onclick={() => confirmRemove = true}>
            <Trash2 size={18} /> {$t('confirm.deleteBtn')}
          </button>
        {/if}
        <div class="footer-right">
          <button type="button" class="btn btn-secondary" onclick={onClose}>{$t('confirm.cancel')}</button>
          <button type="submit" class="btn btn-primary">
            <CheckCircle size={18} /> {$t('modal.save')}
          </button>
        </div>
      </footer>
    </form>
  </div>
</div>

<ConfirmDialog
  bind:open={confirmRemove}
  title={$t('modal.deleteTitle')}
  message={$t('modal.deleteMsg')}
  confirmText={$t('confirm.deleteBtn')}
  danger
  onconfirm={remove}
/>

<ConfirmDialog
  bind:open={confirmDuplicate}
  title={$t('modal.duplicateTitle')}
  message={$t('modal.duplicateMsg', { name, days: daysOfWeek.length })}
  confirmText={$t('modal.duplicate')}
  onconfirm={duplicate}
/>

{#if showImagePreview && previewActivity}
  <ImageLightbox activity={previewActivity} onClose={() => { showImagePreview = false; previewActivity = null; }} />
{/if}

<style>
  /* ── Imagen de la rutina ── */
  .image-box {
    background: rgb(var(--sup-2));
    border: 1px solid rgb(var(--verde-borde) / 0.12);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .image-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .image-title {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    font-weight: 700;
    color: rgb(var(--tinta));
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .image-header-actions {
    display: flex;
    gap: 0.4rem;
  }

  .image-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: rgb(var(--sup));
    border: 1px solid rgb(var(--linea) / 0.08);
    border-radius: 6px;
    padding: 0.25rem 0.55rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: rgb(var(--verde-texto));
    cursor: pointer;
    transition: all 0.2s;
  }

  .image-btn:hover {
    background: rgb(var(--verde-lavado) / 0.08);
  }

  .image-btn-danger {
    /* 4,13:1 con #e53e3e sobre el blanco del botón (3,86:1 en hover):
       no llegaba a AA. #c81e1e da 5,74:1 y 5,36:1 en hover. */
    color: rgb(var(--rojo-texto));
  }

  .image-btn-danger:hover {
    background: rgb(var(--rojo-lavado));
  }

  .image-preview {
    border: none;
    padding: 0;
    background: none;
    cursor: zoom-in;
    border-radius: 8px;
    overflow: hidden;
    align-self: flex-start;
    max-width: 100%;
  }

  .image-preview img {
    display: block;
    max-width: 100%;
    max-height: 160px;
    border-radius: 8px;
    object-fit: cover;
    box-shadow: 0 2px 8px rgb(var(--sombra) / 0.1);
    transition: transform 0.2s;
  }

  .image-preview:hover img {
    transform: scale(1.02);
  }

  .image-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .image-upload-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgb(var(--sup));
    border: 1px dashed rgb(var(--verde-borde) / 0.35);
    border-radius: 8px;
    padding: 0.45rem 0.8rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: rgb(var(--verde-texto));
    cursor: pointer;
    transition: all 0.2s;
  }
  .image-upload-btn.subiendo {
    opacity: 0.75;
    cursor: wait;
  }
  /* :global porque la clase viaja al <svg> de lucide, que es hijo de otro
     componente: sin el hash de ambito el selector no llegaba a casar y el
     spinner de subida se quedaba quieto. */
  .image-upload-btn :global(.giro) {
    animation: giroSubida 1s linear infinite;
  }
  @keyframes giroSubida {
    to { transform: rotate(360deg); }
  }

  .image-upload-btn:hover {
    background: rgb(var(--verde-lavado) / 0.06);
    border-style: solid;
  }

  .image-url-row {
    display: flex;
    gap: 0.5rem;
  }

  .image-url-row input {
    flex: 1;
    padding: 0.45rem 0.7rem;
    border: 1px solid rgb(var(--linea) / 0.12);
    border-radius: 8px;
    font-size: 0.85rem;
    min-width: 0;
  }

  .image-url-row input:focus {
    outline: none;
    border-color: rgb(var(--verde-borde) / 0.5);
  }

  /* ── Scope Selector ── */
  .scope-selector {
    background: rgb(var(--sup-2));
    border: 1px solid rgb(var(--verde-borde) / 0.12);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .scope-label {
    font-size: 0.8rem;
    font-weight: 700;
    color: rgb(var(--tinta));
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .scope-options {
    display: flex;
    gap: 0.5rem;
  }

  .scope-option {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgb(var(--linea) / 0.08);
    border-radius: 8px;
    background: rgb(var(--sup));
    cursor: pointer;
    font-size: 0.82rem;
    font-weight: 600;
    color: rgb(var(--texto-2)); /* AA (antes #888) */
    transition: all 0.2s;
  }

  .scope-option input[type="radio"] {
    display: none;
  }

  .scope-option.selected {
    border-color: rgb(var(--verde-texto));
    background: rgb(var(--verde-lavado) / 0.06);
    color: rgb(var(--verde-texto));
  }

  .scope-option:hover:not(.selected) {
    border-color: rgb(var(--linea) / 0.15);
    color: rgb(var(--tinta));
  }

  .steps-box {
    background: rgb(var(--sup-2));
    border: 1px solid rgb(var(--verde-borde) / 0.15);
    border-radius: 12px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .steps-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .steps-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 700;
    color: rgb(var(--verde-texto));
  }

  .preset-btn-sparkle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: rgb(var(--verde-lavado) / 0.08);
    border: 1px dashed rgb(var(--verde-borde));
    color: rgb(var(--verde-texto));
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.25rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .preset-btn-sparkle:hover {
    background: var(--color-green-dark);
    color: rgb(var(--sobre-color));
  }

  .step-add-row {
    display: flex;
    gap: 0.5rem;
  }

  .step-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid rgb(var(--linea) / 0.12);
    border-radius: 8px;
    font-size: 0.9rem;
    background: rgb(var(--sup));
  }

  .btn-add-step {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--color-green-dark);
    color: rgb(var(--sobre-color));
    border: none;
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s;
  }

  .btn-add-step:hover {
    background: var(--color-green-moss);
  }

  .steps-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 200px;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  .step-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgb(var(--sup));
    padding: 0.4rem 0.6rem;
    border-radius: 8px;
    border: 1px solid rgb(var(--linea) / 0.06);
    transition: background 0.2s, border-color 0.2s;
  }

  .step-item.completed {
    background: rgb(var(--verde-lavado) / 0.05);
    border-color: rgb(var(--verde-borde) / 0.2);
  }

  .step-check-btn {
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    color: rgb(var(--texto-2)); /* AA (antes #999) */
    transition: color 0.2s;
  }

  .step-check-btn:hover {
    color: rgb(var(--verde-texto));
  }

  /* :global porque .check-icon lo recibe un icono de lucide (componente hijo)
     y Svelte no le anade el hash de ambito: la regla nunca aplicaba y un paso
     completado se quedaba del mismo gris que uno pendiente. */
  :global(.check-icon.done) {
    color: rgb(var(--verde-texto));
  }

  .step-text-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 0.85rem;
    padding: 0.2rem 0.4rem;
    color: var(--text-main);
  }

  .step-text-input:focus {
    outline: none;
    background: rgb(var(--lavado) / 0.02);
    border-radius: 4px;
  }

  .step-text-input.done-text {
    text-decoration: line-through;
    color: rgb(var(--texto-2)); /* AA (antes #888) */
  }

  .step-delete-btn {
    background: transparent;
    border: none;
    padding: 0.25rem;
    cursor: pointer;
    color: rgb(var(--rojo-texto));
    border-radius: 4px;
    display: flex;
    align-items: center;
    transition: all 0.2s;
  }

  .step-delete-btn:hover {
    color: rgb(var(--rojo-texto));
    background: rgb(var(--rojo-lavado));
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgb(var(--velo) / 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 200;
    /* el gesto de scroll sobre el overlay no encadena al fondo */
    overscroll-behavior: contain;
    touch-action: none;
  }

  .modal-content {
    width: 95%;
    max-width: 500px;
    /* dvh: el teclado virtual SÍ reduce dvh (no vh) — el footer queda visible al escribir.
       vh primero como fallback (cascade: la última declaración válida gana). */
    max-height: 92vh;
    max-height: 92dvh;
    padding: 0;
    overflow-y: auto;
    background: rgb(var(--sup));
    border-radius: 16px;
    box-shadow: 0 20px 25px -5px rgb(var(--sombra) / 0.1), 0 10px 10px -5px rgb(var(--sombra) / 0.04);
    animation: slideUp 0.3s ease-out;
    display: flex;
    flex-direction: column;
  }

  /* Desktop grande (≥1536px): el modal gana 40px de ancho — proporción mejor
     frente a la pantalla sin convertir el formulario en un ocupador de sala. */
  @media (min-width: 1536px) {
    .modal-content {
      max-width: 540px;
    }
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .category-preview {
    height: 10px;
    width: 100%;
    flex-shrink: 0;
  }

  .modal-header, form {
    padding: 1.5rem 2rem;
  }

  .modal-header {
    padding-bottom: 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  form {
    padding-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .input-large {
    width: 100%;
    font-size: 1.1rem;
    padding: 0.8rem;
    font-weight: 600;
    color: rgb(var(--verde-texto));
    box-sizing: border-box;
    /* regla dura #5: a 16px de fuente + padding 0.8rem da ~41px en móvil */
    min-height: 44px;
  }

  .time-controls-box {
    background: rgb(var(--sup-2));
    padding: 1.25rem;
    border-radius: 12px;
    border: 1px solid rgb(var(--linea) / 0.05);
  }

  .time-row-modern {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .time-picker-group {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .time-picker-group label {
    margin-bottom: 0.25rem;
  }

  .time-select-modern {
    width: 100%;
    font-size: 1rem;
    padding: 0.5rem;
    font-weight: 600;
    color: rgb(var(--verde-texto));
    border: 1px solid rgb(var(--linea) / 0.1);
    background: rgb(var(--sup));
    box-sizing: border-box;
  }

  .to-separator {
    font-size: 1rem;
    color: rgb(var(--texto-2)); /* AA (antes #999) */
    padding-top: 1.25rem;
  }

  .duration-controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: rgb(var(--sup));
    border-radius: 8px;
  }

  .hint-text {
    font-size: 0.75rem;
    color: rgb(var(--texto-2)); /* AA (antes #999) */
    font-weight: 600;
    text-transform: uppercase;
  }

  .duration-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.5rem;
  }

  .chip {
    background: rgb(var(--tinta) / 0.05);
    border: 1px solid rgb(var(--tinta) / 0.1);
    padding: 0.4rem 0.75rem;
    border-radius: 20px;
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(var(--tinta));
    cursor: pointer;
    transition: all 0.2s;
  }

  .chip:hover {
    background: var(--color-green-dark);
    color: rgb(var(--sobre-color));
    border-color: rgb(var(--verde-texto));
  }

  .duration-hint {
    margin-top: 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: rgb(var(--texto-2)); /* AA (antes #888) */
  }

  .duration-hint strong {
    color: rgb(var(--tinta));
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: rgb(var(--verde-texto));
  }

  .close-btn {
    background: transparent;
    border: none;
    color: rgb(var(--texto-2)); /* AA sobre blanco (antes #999) */
    cursor: pointer;
    /* Target táctil >= 44px (regla dura #5); ya lo era en móvil, ahora también en desktop */
    min-width: 44px;
    min-height: 44px;
    display: grid;
    place-items: center;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  /* fieldset para agrupar los días: el navegador le pone borde y padding por
     defecto, y el legend necesita comportarse como el label que sustituye. */
  fieldset.form-group {
    border: 0;
    padding: 0;
    margin-inline: 0;
    min-inline-size: 0;
  }

  fieldset.form-group > legend {
    padding: 0;
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(var(--tinta));
  }

  label {
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(var(--tinta));
  }

  input, select {
    padding: 0.75rem;
    border: 1px solid rgb(var(--linea) / 0.1);
    border-radius: 8px;
    font-size: 1rem;
    background: rgb(var(--sup) / 0.8);
  }

  input:focus, select:focus {
    outline: none;
    border-color: rgb(var(--verde-texto));
    box-shadow: 0 0 0 2px rgb(var(--sombra) / 0.1);
  }

  .days-selector {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .day-toggle {
    flex: 1;
    height: 44px;
    border-radius: 8px;
    border: 1px solid rgb(var(--linea) / 0.1);
    background: rgb(var(--sup));
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .day-toggle.selected {
    background: var(--color-green-dark);
    color: rgb(var(--sobre-color));
    border-color: rgb(var(--verde-texto));
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .preset-btn {
    font-size: 0.75rem;
    padding: 0.35rem 0.6rem;
    background: rgb(var(--tinta) / 0.05);
    border: 1px solid rgb(var(--tinta) / 0.1);
    border-radius: 4px;
    cursor: pointer;
    color: rgb(var(--tinta));
    /* regla dura #5: target táctil completo (medía ~27px) */
    min-height: 44px;
  }

  .modal-footer {
    display: flex;
    justify-content: space-between;
    padding: 1.5rem 2rem;
    border-top: 1px solid rgb(var(--linea) / 0.05);
    background: rgb(var(--sup));
    flex-shrink: 0;
    /* Pegajoso, sin breakpoint. Cancelar/Guardar son la acción principal del
       modal y no pueden depender de que el usuario adivine que hay que
       bajar: el formulario de creación mide 1040px, asi que en cuanto la
       pantalla es más baja el botón Guardar queda fuera de vista.

       Antes solo era sticky con (max-width: 640px), una condición de ANCHO
       que no describe el problema (es de altura): en móvil horizontal
       (844x390) no se aplicaba y Guardar quedaba a 759px de scroll, y en
       escritorio (1280x800) tampoco, con el boton fuera de pantalla.

       Sin efecto secundario cuando el contenido cabe: sticky solo actúa si
       el elemento trataria de salirse del contenedor, asi que en un modal
       corto se comporta igual que un footer normal. */
    position: sticky;
    bottom: 0;
    z-index: 10;
    box-shadow: 0 -6px 18px rgb(var(--sombra) / 0.08);
    background: rgb(var(--sup));
  }

  .footer-right {
    display: flex;
    gap: 0.75rem;
  }

  .btn {
    padding: 0.6rem 1.2rem;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
  }

  .btn-danger {
    background: rgb(var(--rojo-lavado));
    /* 3,95:1 con #dc2626 — y en hover el fondo se oscurece (#fecaca) y
       baja a 3,34:1. #a71a1a da 6,13:1 y mantiene 5,17:1 en hover. */
    color: rgb(var(--rojo-texto));
  }

  .btn-danger:hover {
    background: rgb(var(--rojo-lavado));
  }

  .btn-primary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  @media (max-width: 540px) {
    .modal-header, form, .modal-footer {
      padding: 1rem 1.25rem;
    }
    .modal-header h2 {
      font-size: 1.25rem;
    }
    .input-large {
      font-size: 1rem;
      padding: 0.65rem;
    }
    .time-controls-box {
      padding: 0.85rem;
    }
    .time-row-modern {
      gap: 0.5rem;
    }
    .time-select-modern {
      font-size: 0.9rem;
      padding: 0.4rem;
    }
    .days-selector {
      gap: 0.25rem;
    }
    .day-toggle {
      height: 44px;
      font-size: 0.8rem;
    }
    .modal-footer {
      flex-direction: column-reverse;
      gap: 0.75rem;
    }
    .footer-right {
      width: 100%;
      justify-content: space-between;
    }
    .footer-right .btn {
      flex: 1;
      justify-content: center;
    }
    .btn-danger {
      width: 100%;
      justify-content: center;
    }
    .scope-options {
      flex-direction: column;
    }
  }
  /* A11y táctil (regla dura #5): en móvil todo control del modal mide ≥44px.
     Último bloque del archivo: gana el cascade sobre las queries de 640/540. */
  @media (max-width: 768px) {
    .close-btn {
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .chip,
    .time-select-modern,
    .step-input,
    .btn-add-step,
    .image-upload-btn,
    .preset-btn-sparkle,
    .day-toggle {
      min-height: 44px;
    }
    .chip {
      padding: 0.4rem 0.9rem;
    }
    .preset-btn-sparkle {
      padding: 0.35rem 0.8rem;
    }
    .step-check-btn,
    .step-delete-btn {
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }
</style>
