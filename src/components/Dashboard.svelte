<script lang="ts">
    import { db, exportarRespaldoBinario, leerUltimoRespaldo } from '../lib/db';
  import type { Activity } from '../lib/types';
  import { 
    activitiesStore, 
    categoriesStore, 
    settingsStore,
    dayOverridesStore,
    parseTime,
    formatTime
  } from '../lib/stores';
  import WeeklyGrid from './WeeklyGrid.svelte';

  import Toasts from './Toasts.svelte';
  import { toastOk, toastErr } from '../lib/toast';
  import { undoStack, redoStack } from '../lib/undo';
  import { Settings, Calendar, Clock, Plus, ChevronsUp, ChevronsDown, Undo2, Redo2, Download, Upload, Cloud, CloudOff, CloudUpload, CloudDownload, LogIn, RefreshCw, Info } from '@lucide/svelte';
  import { portal } from '../lib/portal';
  import { onSyncChange, syncNow, subirAhora, bajarAhora, SIN_SESION } from '../lib/sync';
  import { t, tNow, idioma } from '../lib/i18n';
  import { modoPrivacidad, alternarPrivacidad } from '../lib/privacy';
  import { temaEfectivo, alternarTema } from '../lib/tema';
  import { Eye, EyeOff, Sun, Moon } from '@lucide/svelte';
  import type { SyncStatus } from '../lib/types';

  let currentView = $state('week'); // 'week' | 'day'

  // ── Deshacer global (Ctrl+Z / ⌘Z) ───────────────────────────────────
  // El botón no decía QUÉ iba a deshacer: un "Deshacer" genérico obliga a
  // memoria. Guardamos también la etiqueta de la cima de cada pila para
  // ponerla en el title (tooltip) y en el aria-label.
  let stackCount = $state(0);
  let redoCount = $state(0);
  let undoLabel = $state('');
  let redoLabel = $state('');
  undoStack.subscribe(s => {
    stackCount = s.length;
    undoLabel = s[s.length - 1]?.label ?? '';
  });
  redoStack.subscribe(s => {
    redoCount = s.length;
    redoLabel = s[s.length - 1]?.label ?? '';
  });

  const undoTitulo = $derived(undoLabel ? $t('header.undoWith', { label: undoLabel }) : $t('header.undo'));
  const redoTitulo = $derived(redoLabel ? $t('header.redoWith', { label: redoLabel }) : $t('header.redo'));

  /** Ejecuta deshacer/rehacer (compartido por teclado y botones del header). */
  function ejecutarUndo(redo: boolean) {
    // pop del op + ejecución en chunk diferido (undoRun no va al bundle inicial)
    import('../lib/undoRun')
      .then(m => (redo ? m.popAndRedo() : m.popAndUndo()))
      .then(label => { if (label) toastOk(redo ? `↻ ${label}` : tNow('toast.undone', { label })); })
      .catch(err => toastErr(tNow('toast.couldNotMove') + ': ' + (err?.message || err)));
  }

  function isTextEntryTarget(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function onUndoKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
    // Guards: el modal de actividad ya tiene Ctrl+Z nativo en sus inputs, y
    // deshacer BD por debajo del form abierto sería confuso.
    if (showActivityModal || showSettings || isTextEntryTarget(e.target)) return;
    const redo = e.shiftKey;
    e.preventDefault();
    ejecutarUndo(redo);
  }

  $effect(() => {
    window.addEventListener('keydown', onUndoKeydown);
    return () => window.removeEventListener('keydown', onUndoKeydown);
  });

  // Estado de sincronización para el badge del header
  let syncStatus = $state<SyncStatus>('local');
  $effect(() => {
    const off = onSyncChange((s) => { syncStatus = s; });
    return off;
  });
  // Detalle del último sync (pendientes y fecha): el badge era invisible
  // (hallazgo amarillo de la auditoría UX) — ahora muestra punto de estado y
  // el title explica cuándo sincronizó y cuántos cambios quedan por subir.
  let syncDetail = $state<{ pending: number; lastSyncAt?: number; sesion: boolean }>({ pending: 0, sesion: false });
  $effect(() => {
    const off = onSyncChange((s, d) => {
      syncStatus = s;
      syncDetail = { pending: d.pending, lastSyncAt: d.lastSyncAt, sesion: d.sesion };
    });
    return off;
  });

  // Reintento del banner de error: mientras vuela la orden el
  // banner NO desaparece (el sync pasa por 'syncing' intermedio)
  // y el botón muestra spinner. Igual que nubeOcupada: sin este
  // guard, un doble clic lanza dos pushes.
  let reintentando = $state(false);
  async function reintentarSync() {
    if (reintentando) return;
    reintentando = true;
    try {
      await syncNow(true);
    } catch {
      // El fracaso ya vuelve como syncStatus 'error': el banner
      // sigue ahí con su mensaje; no hace falta otro aviso.
    } finally {
      reintentando = false;
    }
  }

  // ── Nube: subir y bajar a mano ──
  // El sync automático existe (hooks + arranque) pero es invisible, y para el
  // "¿ya llegó lo del otro?" hace falta una acción que el usuario dispare y de
  // la que se entienda el resultado. Estado del botón mientras vuela la orden:
  // si no, un doble clic dispara dos pushes.
  let nubeOcupada = $state<'subir' | 'bajar' | null>(null);

  async function subirANube() {
    if (nubeOcupada) return;
    if (!syncDetail.sesion) { abrirSesion(); return; }
    nubeOcupada = 'subir';
    try {
      const { enviados } = await subirAhora();
      if (enviados > 0) toastOk(tNow('cloud.subido', { n: enviados }));
      else toastOk(tNow('cloud.subidoNada'));
      menuDatos = false;
    } catch (err: any) {
      toastErr(tNow('cloud.error', { msg: err?.message === SIN_SESION ? tNow('cloud.sinSesion') : (err?.message ?? tNow('settings.networkError')) }));
    } finally {
      nubeOcupada = null;
    }
  }

  async function bajarDeNube() {
    if (nubeOcupada) return;
    if (!syncDetail.sesion) { abrirSesion(); return; }
    nubeOcupada = 'bajar';
    try {
      const { aplicados } = await bajarAhora();
      if (aplicados > 0) toastOk(tNow('cloud.bajado', { n: aplicados }));
      else toastOk(tNow('cloud.bajadoNada'));
      menuDatos = false;
    } catch (err: any) {
      toastErr(tNow('cloud.error', { msg: err?.message === SIN_SESION ? tNow('cloud.sinSesion') : (err?.message ?? tNow('settings.networkError')) }));
    } finally {
      nubeOcupada = null;
    }
  }

  /** Sin sesión el camino honesto es el login, no un error: Ajustes lo tiene. */
  function abrirSesion() {
    menuDatos = false;
    loadSettingsPanel().then(() => showSettings = true);
  }
  // $t (no tNow) para que el título del badge se re-evalúe al cambiar de
  // idioma: era un $derived.by que solo dependía de syncStatus.
  const syncTitulo = $derived.by(() => {
    const base = $t(`sync.${syncStatus}`);
    const extras: string[] = [];
    if (syncDetail.lastSyncAt) {
      extras.push($t('sync.lastAt', {
        time: new Date(syncDetail.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }));
    }
    if (syncDetail.pending > 0) {
      extras.push($t(syncDetail.pending === 1 ? 'sync.pending' : 'sync.pendingMany', { n: syncDetail.pending }));
    }
    return extras.length ? base + ' — ' + extras.join(' — ') : base;
  });

  let selectedDay = $state(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1); // 0 = Mon, 6 = Sun

  // ── Pista de primera ejecución ─────────────────────────────────────────
  // Arrastrar y tocar son los gestos de la app y no se descubren solos: sin
  // una pista el usuario deduce que la rejilla es estática. Aparece UNA vez
  // sobre la rejilla y se descarta para siempre. El estado inicial es false
  // porque el HTML se prerenderiza sin localStorage: el $effect decide.
  const CLAVE_PISTA = 'pistaArrastrarDescartada';
  let mostrarPista = $state(false);
  $effect(() => {
    try {
      if (localStorage.getItem(CLAVE_PISTA) !== '1') mostrarPista = true;
    } catch {
      mostrarPista = true; // sin localStorage (modo privado) se muestra siempre
    }
  });

  function descartarPista() {
    mostrarPista = false;
    try {
      localStorage.setItem(CLAVE_PISTA, '1');
    } catch { /* sin almacenamiento: volverá a salir, es el precio del modo privado */ }
  }

  // Precarga de modales cuando el navegador queda idle
  $effect(() => {
    preloadModals();
    loadDonutCharts(); // los donuts salen del chunk inicial (lazy como los modales)
    loadDailyView(); // la vista Día es excluyente con la Semana: precarga idle
    // Vuelta de un rescate: el botón de reintentar recarga la página para limpiar
    // el fallo cacheado del módulo, pero el usuario seguía intentando abrir el
    // DÍA. Sin esto aterriza en la Semana y tiene que volver a hacer clic — el
    // gesto se pierde justo en el rescate. La precarga de arriba ya deja el
    // chunk en camino, así que solo hay que elegir la vista.
    try {
      if (sessionStorage.getItem('dia-pendiente') === '1') {
        sessionStorage.removeItem('dia-pendiente');
        currentView = 'day';
      }
    } catch { /* sin almacenamiento */ }
  });

  /** Carga el chunk de Día AHORA (click en la pestaña o día de la grilla):
   *  sin esperar al idle callback, que puede demorar hasta 2s en máquina
   *  cargada y la pestaña quedaba en "Cargando vista del día…". */
  function irAVistaDia() {
    currentView = 'day';
    void cargarVistaDia();
  }
  /** Botón "Reintentar" del aviso: RECARGA la página, que es lo único que
   *  limpia de verdad el fallo cacheado del módulo. Una sola vez por sesión:
   *  si la red sigue caída, el guardia evita el bucle de recargas y el aviso
   *  vuelve a quedarse esperando a que vuelva. */
  function reintentarVistaDia() {
    try {
      if (sessionStorage.getItem('dia-reintento') === '1') return;
      sessionStorage.setItem('dia-reintento', '1');
      // El usuario estaba intentando abrir el DÍA: al volver de la recarga tiene
      // que caer ahí, no otra vez en la Semana obligándolo a un clic de más.
      sessionStorage.setItem('dia-pendiente', '1');
    } catch { /* sin almacenamiento: se recarga igual */ }
    location.reload();
  }
  
  // Que dice el interruptor de tema del header. El icono y el texto apuntan al
  // tema al que SALTA, no al que hay: es el criterio del Eye/EyeOff del menu
  // Datos. Y no dice cual es el actual porque eso ya se ve en la pantalla, y
  // cambiar de tema es reversible de un clic.
  const temaTitulo = $derived($temaEfectivo === 'oscuro' ? $t('header.themeToLight') : $t('header.themeToDark'));

  let showSettings = $state(false);
  let showActivityModal = $state(false);

  // Code-splitting: los modales solo bajan del bundle cuando se abren por
  // primera vez (−40 KB del camino crítico). Tras el idle se precargan.
  let SettingsPanelComp: typeof import('./SettingsPanel.svelte').default | null = $state(null);
  let ActivityModalComp: typeof import('./ActivityModal.svelte').default | null = $state(null);
  let DonutChartsComp: typeof import('./DonutCharts.svelte').default | null = $state(null);
  let DailyViewComp: typeof import('./DailyView.svelte').default | null = $state(null);

  // Holders de las promesas de carga (compatibles con el helper cargarChunk).
  // `n` = nº de intentos: cada uno pide una URL nueva (ver cargarChunk).
  const loadSettings = { v: null as Promise<void> | null, n: 0 };
  const loadDonut = { v: null as Promise<void> | null, n: 0 };
  const loadActivity = { v: null as Promise<void> | null, n: 0 };
  const loadDaily = { v: null as Promise<void> | null, n: 0 };

  /** Carga de chunks lazy con REINTENTO y aviso de rescate.
   *
   *  Ojo con el reintento: el navegador memoriza el FALLO de un módulo en su
   *  mapa para esa URL exacta, así que re-importar la MISMA puede rechazar sin
   *  volver a pedir nada. Romperlo con una query variable
   *  (import(`./X.svelte${n}`)) no sirve: Vite solo bundlea imports dinámicos
   *  con especificador literal y revienta en runtime con "Unknown variable
   *  dynamic import"; hacerlo con variantes literales funciona, pero duplica
   *  el chunk en el build (~70 KB de más) y eso no lo paga un arreglo de
   *  resiliencia.
   *
   *  Entonces la salida es RECARGAR, que sí limpia la caché de fallo y no pesa
   *  un byte: el gesto avisa y el botón recarga una sola vez (el guardia de
   *  sessionStorage evita el bucle). Antes no había ninguna de las dos cosas y el
   *  reporte era "entro y no me carga, después de 3 intentos". */
  function cargarChunk(
    holder: { v: Promise<void> | null; n: number },
    hacer: () => Promise<void>
  ): Promise<void> {
    if (holder.v) return holder.v;
    const intento = ++holder.n;
    const p = hacer().catch((err) => {
      console.error(`[dashboard] carga lazy falló (intento ${intento}), se permite reintento`, err);
      if (holder.v === p) holder.v = null; // descartar SOLO si sigue siendo la nuestra
      throw err; // propagar a {#await} si hay
    });
    holder.v = p;
    return p;
  }

  function loadSettingsPanel() {
    return cargarChunk(loadSettings, () => import('./SettingsPanel.svelte').then(m => { SettingsPanelComp = m.default; }));
  }
  function loadActivityModal() {
    return cargarChunk(loadActivity, () => import('./ActivityModal.svelte').then(m => { ActivityModalComp = m.default; }));
  }
  function loadDonutCharts() {
    return cargarChunk(loadDonut, () => import('./DonutCharts.svelte').then(m => { DonutChartsComp = m.default; }));
  }
  function loadDailyView() {
    return cargarChunk(loadDaily, () => import('./DailyView.svelte').then(m => { DailyViewComp = m.default; }));
  }

  /** Último fallo de la vista Día, para no dejar un esqueleto mudo. */
  let dailyError = $state<string | null>(null);

  /**
   * Vista Día: cargar y, si falla, decirlo.
   *
   * El reporte: "a veces entro y no me carga, después de 3 intentos". Antes un
   * fallo de red dejaba el esqueleto girando para siempre, sin texto ni botón.
   *
   * OJO con prometer un reintento automático: medido con el chunk caído, el
   * navegador memoriza el fallo del módulo para esa URL exacta, así que volver
   * a importar NO vuelve a pedir nada por red (4 intentos registrados, 1 sola
   * petición). Un reintento invisible sería teatro: el usuario seguiría viendo
   * el esqueleto. Lo único que limpia de verdad el fallo cacheado es RECARGAR,
   * así que eso se le ofrece explicito y con un botón (una sola vez por sesión,
   * con el guardia de abajo para que no entre en bucle).
   */
  async function cargarVistaDia() {
    dailyError = null;
    try {
      await loadDailyView();
      // La vista entró: el guardia de recarga se desarma para no bloquear un
      // reintento legítimo más adelante.
      try { sessionStorage.removeItem('dia-reintento'); } catch { /* sin almacenamiento */ }
    } catch {
      dailyError = tNow('day.loadError');
    }
  }
  function openSettings() {
    showSettings = true;
    loadSettingsPanel();
  }

  /** Exportar (menú Datos / sidebar): descarga el respaldo con toast de éxito/error.
   *  Usa el formato binario .npz (imágenes recompresidas como binario ZIP). */
  async function exportarDatos() {
    cerrarMenuDatos();
    try {
      const stats = await exportarRespaldoBinario();
      const kb = stats.bytes >= 1024 * 1024
        ? `${(stats.bytes / 1024 / 1024).toFixed(1)} MB`
        : `${Math.max(1, Math.round(stats.bytes / 1024))} KB`;
      toastOk(
        stats.imagenesBinarias > 0
          ? `${tNow('sidebar.exported')} ${kb} · ${tNow('sidebar.exportImages', { n: stats.imagenesBinarias })}`
          : `${tNow('sidebar.exported')} ${kb}`
      );
    } catch (err: any) {
      toastErr(tNow('settings.exportError', { msg: err?.message || err }));
    }
  }

  /** Importar: abre Ajustes donde vive el flujo con confirmación. */
  function importarDatos() {
    cerrarMenuDatos();
    openSettings();
  }

  // ── Menú desplegable "Datos" del header ──
  let menuDatos = $state(false);
  let menuDatosSaliendo = $state(false); // animación de subida al cerrar
  let menuDatosEl: HTMLElement | undefined = $state();
  let menuDatosPos = $state({ x: 0, y: 0 });

  // Fecha del último respaldo descargado (pie del menú). Se lee al abrir el
  // menú para que muestre siempre el valor fresco (incluida la descarga recién
  // hecha desde el propio menú o desde Ajustes).
  let ultimoRespaldo = $state<string | null>(null);
  const fechaUltimoRespaldo = $derived.by(() => {
    if (!ultimoRespaldo) return null;
    const d = new Date(ultimoRespaldo);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString(
      getLocaleActivo(),
      { day: '2-digit', month: '2-digit', year: 'numeric' }
    );
  });

  /** Locale en espejo del idioma de la app (no el del navegador: si el usuario
   *  eligió español en un navegador en inglés, el menú respeta su elección). */
  function getLocaleActivo(): string {
    let lang = 'es';
    idioma.subscribe(v => (lang = v))();
    return lang === 'en' ? 'en-US' : 'es-AR';
  }

  /**
   * Duración de la animación de CIERRE del menú, en ms. Tiene que coincidir
   * con .menuDatosAnim.menuDatosSaliendo (0.12s) o el panel se desmonta a
   * medias y el último fotograma se ve como un parpadeo. Se sube un pelo por
   * el retardo de pintado del navegador.
   */
  const MENU_CIERRE_MS = 130;

  function alternarMenuDatos() {
    if (!menuDatos) {
      ultimoRespaldo = leerUltimoRespaldo();
      if (menuDatosEl) {
        // Posicionar bajo el botón ANTES de abrir (el portal manda al body:
        // sin ancla de layout, las coords deben medirse del botón real).
        const r = menuDatosEl.querySelector('button')?.getBoundingClientRect();
        if (r) {
          const MENU_W = 230;
          const MENU_H = 200; // altura máx estimada (4 items + pie); solo para el clamp
          menuDatosPos = {
            x: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
            // Clamp vertical: con el header parcialmente scrolleado el botón
            // puede quedar cerca/abajo del viewport y el menú salía recortado.
            y: Math.max(8, Math.min(r.bottom + 6, window.innerHeight - MENU_H - 8))
          };
        }
      }
    }
    if (menuDatos) {
      // Cierre animado: el menú sube (menuDatosSaliendo) y se desmonta al
      // terminar la animación, no antes.
      menuDatosSaliendo = true;
      setTimeout(() => { menuDatos = false; menuDatosSaliendo = false; }, MENU_CIERRE_MS);
    } else {
      menuDatos = true;
    }
  }
  /** Cierra el menú directo (Esc / click-afuera / acción) con la misma animación. */
  function cerrarMenuDatos() {
    if (!menuDatos || menuDatosSaliendo) return;
    menuDatosSaliendo = true;
    setTimeout(() => { menuDatos = false; menuDatosSaliendo = false; }, MENU_CIERRE_MS);
  }

  // Click afuera + Esc cierran el menú (patrón del menú contextual existente).
  $effect(() => {
    if (!menuDatos) return;
    const clickAfuera = (e: PointerEvent) => {
      if (menuDatosEl && !menuDatosEl.contains(e.target as Node)) cerrarMenuDatos();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrarMenuDatos();
    };
    document.addEventListener('pointerdown', clickAfuera);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', clickAfuera);
      window.removeEventListener('keydown', esc);
    };
  });
  function preloadModals() {
    ('requestIdleCallback' in window ? requestIdleCallback : (cb: () => void) => setTimeout(cb, 2000))(() => {
      loadSettingsPanel();
      loadActivityModal();
    });
  }
  let editingActivityId = $state<string | null>(null);
  let modalTargetDay = $state<number | null>(null);
  let initialActivityData = $state<Activity | null>(null);

  // Derive settings
  const settingsObj = $derived($settingsStore?.length ? $settingsStore.reduce((acc: any, s: any) => ({ ...acc, [s.key]: s.value }), { startHour: 7, endHour: 23 }) : { startHour: 7, endHour: 23 });

  function openActivityModal(id: string | null = null, day: number | null = null, initialData: Activity | null = null) {
    loadActivityModal();
    editingActivityId = id;
    modalTargetDay = day !== null ? day : (currentView === 'day' ? selectedDay : null);
    initialActivityData = initialData;
    showActivityModal = true;
  }

  function handleDaySelect(day: number) {
    selectedDay = day;
    irAVistaDia();
  }

  async function coverGapsAbove() {
    const startH = settingsObj.startHour;

    if (currentView === 'day') {
      const overrides = $state.snapshot($dayOverridesStore) || [];
      const currentOverride = overrides.find(o => o.day === selectedDay);

      if (currentOverride && currentOverride.activities?.length > 0) {
        const dayActs = currentOverride.activities.map(a => ({ ...a }));
        dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));

        let prevEnd = startH;
        for (const act of dayActs) {
          const actStart = parseTime(act.startTime);
          if (actStart > prevEnd) {
            const duration = parseTime(act.endTime) - actStart;
            act.startTime = formatTime(prevEnd);
            act.endTime = formatTime(prevEnd + duration);
          }
          prevEnd = parseTime(act.endTime);
        }

        await db.dayOverrides.put({
          day: selectedDay,
          activities: dayActs,
          updatedAt: Date.now()
        });
        return;
      }
    }

    const list = $state.snapshot($activitiesStore) || [];
    if (list.length === 0) return;

    // Copy the activities to work with them
    const updatedActivities = list.map(a => ({ 
      ...a, 
      daysOfWeek: [...a.daysOfWeek] 
    }));

    // For each day, shift activities upwards to cover gaps above (preserving duration)
    for (let day = 0; day < 7; day++) {
      const dayActs = updatedActivities.filter(a => a.daysOfWeek.includes(day));
      dayActs.sort((a, b) => parseTime(a.startTime) - parseTime(b.startTime));

      let prevEnd = startH;
      for (const act of dayActs) {
        const actStart = parseTime(act.startTime);
        if (actStart > prevEnd) {
          const duration = parseTime(act.endTime) - actStart;
          act.startTime = formatTime(prevEnd);
          act.endTime = formatTime(prevEnd + duration);
        }
        prevEnd = parseTime(act.endTime);
      }
    }

    // Save changes to database
    try {
      await db.transaction('rw', db.activities, async () => {
        for (const act of updatedActivities) {
          const original = list.find(o => o.id === act.id);
          if (original && (original.startTime !== act.startTime || original.endTime !== act.endTime)) {
            await db.activities.update(act.id!, { 
              startTime: act.startTime,
              endTime: act.endTime,
              updatedAt: Date.now()
            });
          }
        }
      });
    } catch (err: any) {
      console.error('Failed to adjust activities:', err);
      toastErr(tNow('toast.couldNotMove') + ': ' + (err.message || err));
    }
  }

  /** Espejo de coverGapsAbove: empuja todo hacia endHour preservando los
   *  huecos ENTRE actividades (elimina solo el espacio libre inferior). */
  async function coverGapsBelow() {
    const endH = settingsObj.endHour;

    if (currentView === 'day') {
      const overrides = $state.snapshot($dayOverridesStore) || [];
      const currentOverride = overrides.find(o => o.day === selectedDay);

      if (currentOverride && currentOverride.activities?.length > 0) {
        const dayActs = currentOverride.activities.map(a => ({ ...a }));
        dayActs.sort((a, b) => parseTime(b.endTime) - parseTime(a.endTime)); // desde la última

        let nextStart = endH;
        for (const act of dayActs) {
          const actEnd = parseTime(act.endTime);
          if (actEnd < nextStart) {
            const duration = actEnd - parseTime(act.startTime);
            act.startTime = formatTime(nextStart - duration);
            act.endTime = formatTime(nextStart);
          }
          nextStart = parseTime(act.startTime);
        }

        await db.dayOverrides.put({
          day: selectedDay,
          activities: dayActs,
          updatedAt: Date.now()
        });
        return;
      }
    }

    const list = $state.snapshot($activitiesStore) || [];
    if (list.length === 0) return;

    const updatedActivities = list.map(a => ({
      ...a,
      daysOfWeek: [...a.daysOfWeek]
    }));

    // Por día: desde la última actividad hacia atrás, pegada al final del día.
    for (let day = 0; day < 7; day++) {
      const dayActs = updatedActivities.filter(a => a.daysOfWeek.includes(day));
      dayActs.sort((a, b) => parseTime(b.endTime) - parseTime(a.endTime));

      let nextStart = endH;
      for (const act of dayActs) {
        const actEnd = parseTime(act.endTime);
        if (actEnd < nextStart) {
          const duration = actEnd - parseTime(act.startTime);
          act.startTime = formatTime(nextStart - duration);
          act.endTime = formatTime(nextStart);
        }
        nextStart = parseTime(act.startTime);
      }
    }

    try {
      await db.transaction('rw', db.activities, async () => {
        for (const act of updatedActivities) {
          const original = list.find(o => o.id === act.id);
          if (original && (original.startTime !== act.startTime || original.endTime !== act.endTime)) {
            await db.activities.update(act.id!, {
              startTime: act.startTime,
              endTime: act.endTime,
              updatedAt: Date.now()
            });
          }
        }
      });
    } catch (err: any) {
      console.error('Failed to adjust activities:', err);
      toastErr(tNow('toast.couldNotMove') + ': ' + (err.message || err));
    }
  }

  /* (Subir/Bajar Todo retirado a pedido del usuario: los botones ↑↓ del
     header y de la sidebar de Día se eliminaron. La lógica shiftAll quedó
     sin usos y se removió; el deshacer de commitCambios conserva el soporte
     de sus labels por si un op antiguo queda en la pila.) */
</script>

<div class="dashboard" class:privacy-mode={$modoPrivacidad}>
  <!-- Top Navigation & Title -->
  <header class="dashboard-header glass-panel">
    <div class="header-left">
      <h1 class="logo">🌲 {$t('app.name')}</h1>
    </div>
    <!-- Pestañas FUERA de .header-left: en pantallas anchas el header es una
         grilla de 3 zonas (logo · pestañas · acciones) y las pestañas quedan
         centradas de verdad, no pegadas al logo. En pantallas chicas pasan a
         la derecha de la fila del logo y las acciones se centran debajo. -->
    <nav class="view-tabs" aria-label="{$t('header.viewWeek')} / {$t('header.viewDay')}">
        <!-- Pestañas semánticas: role=tablist/tab + aria-selected (los lectores anuncian "pestaña", no "botón pulsado") -->
        <div class="view-tabs-inner" role="tablist">
          <button
            role="tab"
            id="tab-week"
            aria-selected={currentView === 'week'}
            aria-controls="view-panel"
            class:active={currentView === 'week'}
            onclick={() => currentView = 'week'}
            aria-label={$t('header.viewWeek')}
          >
            <Calendar size={18} /> {$t('header.week')}
          </button>
          <button
            role="tab"
            id="tab-day"
            aria-selected={currentView === 'day'}
            aria-controls="view-panel"
            class:active={currentView === 'day'}
            onclick={irAVistaDia}
            aria-label={$t('header.viewDay')}
          >
            <Clock size={18} /> {$t('header.day')}
          </button>
      </div>
    </nav>
    <div class="header-right">
      <!-- Acciones del header: visibles en móvil/tablet siempre, y en desktop
           solo en Semana (en Día viven en la barra lateral dentro del panel). -->
      <div class="header-actions">
        <!-- Deshacer / Rehacer: mismos guards y misma ejecución que Ctrl+Z
             (ejecutarUndo). Deshabilitados cuando su pila está vacía. -->
        <button
          id="btn-undo"
          class="btn btn-secondary btn-icon"
          onclick={() => ejecutarUndo(false)}
          disabled={stackCount === 0}
          aria-label={undoTitulo}
          title={undoTitulo}
        >
          <Undo2 size={20} />
        </button>
        <button
          id="btn-redo"
          class="btn btn-secondary btn-icon"
          onclick={() => ejecutarUndo(true)}
          disabled={redoCount === 0}
          aria-label={redoTitulo}
          title={redoTitulo}
        >
          <Redo2 size={20} />
        </button>
        <button class="btn btn-secondary" onclick={coverGapsAbove} aria-label={$t('header.adjustUp')} title={$t('header.adjustUpTitle')}>
          <ChevronsUp size={20} /> <span class="hide-mobile">{$t('header.adjustUp')}</span>
        </button>
        <button class="btn btn-secondary" onclick={coverGapsBelow} aria-label={$t('header.adjustDown')} title={$t('header.adjustDownTitle')}>
          <ChevronsDown size={20} /> <span class="hide-mobile">{$t('header.adjustDown')}</span>
        </button>
        <button class="btn btn-plus" onclick={() => openActivityModal(null, currentView === 'day' ? selectedDay : null)} aria-label={$t('header.newActivity')}>
          <Plus size={20} /> <span class="hide-mobile">{$t('header.newActivity')}</span>
        </button>
        <!-- (Modo privacidad retirado del header: vive como ítem del menú
             Datos. Header mínimo: compactar ×2, nueva actividad, ajustes.) -->
        <!-- Interruptor rapido de tema. El header es lo unico comun a las DOS
             vistas, asi que un atajo a un clic no puede depender de entrar a
             Ajustes (que en Dia es un paso extra y en movil cuesta un scroll).
             Icono solo, como los demas btn-icon: con el texto la fila del
             header no entra ni en ultrawide y las pestañas se descentran. -->
        <button
          id="btn-tema"
          class="btn btn-secondary btn-icon"
          onclick={alternarTema}
          aria-label={temaTitulo}
          title={temaTitulo}
        >
          {#if $temaEfectivo === 'oscuro'}
            <Sun size={20} />
          {:else}
            <Moon size={20} />
          {/if}
        </button>
        <button class="btn btn-secondary btn-icon" onclick={openSettings} aria-label={$t('header.settings')}>
          <Settings size={20} />
        </button>
      </div>
      <!-- Menú Datos: FUERA de .header-actions para ser visible en AMBAS vistas
           (en Día el header-actions se oculta y las acciones viven en la
           sidebar; los datos siempre están a un clic aquí). -->
      <div class="menu-datos-wrap" bind:this={menuDatosEl}>
        <button
          class="btn btn-secondary btn-icon"
          onclick={alternarMenuDatos}
          aria-label={$t('sidebar.menuDatos')}
          aria-expanded={menuDatos}
          aria-haspopup="menu"
          title={$t('sidebar.menuDatos')}
        >
          <Cloud size={20} />
          {#if syncDetail.pending > 0}
            <span class="sync-dot pendiente" aria-hidden="true"></span>
          {/if}
        </button>
      </div>
      {#if syncStatus !== 'local'}
        <button
          class="sync-badge"
          class:syncing={syncStatus === 'syncing'}
          class:error={syncStatus === 'error'}
          onclick={() => syncNow(true).catch(() => {})}
          aria-label={syncTitulo}
          title={syncTitulo}
        >
          {#if syncStatus === 'synced'}<Cloud size={16} />
          {:else if syncStatus === 'syncing'}<RefreshCw size={16} />
          {:else}<CloudOff size={16} />{/if}
          <span class="sync-dot {syncStatus}" aria-hidden="true"></span>
        </button>
      {/if}
    </div>
  </header>

  {#if syncStatus === 'error' || syncStatus === 'offline' || reintentando}
    <!-- role="alert" para el error; al reintentar, el texto
         cambia a "Reintentando…" y se vuelve a anunciar. -->
    <div class="sync-banner glass-panel" role="alert">
      {#if reintentando}
        <RefreshCw size={16} class="spin" aria-hidden="true" />
      {:else}
        <CloudOff size={16} aria-hidden="true" />
      {/if}
      <span>{reintentando ? $t('sync.retrying') : $t(syncStatus === 'error' ? 'sync.bannerError' : 'sync.bannerOffline')}</span>
      <button class="sync-retry" disabled={reintentando} onclick={reintentarSync}>
        {#if reintentando}<RefreshCw size={16} class="spin" aria-hidden="true" />{/if}
        {reintentando ? $t('sync.retrying') : $t('sync.retry')}
      </button>
    </div>
  {/if}

  <main class="dashboard-main">
    <div class="view-container" id="view-panel" role="tabpanel" aria-labelledby={currentView === 'week' ? 'tab-week' : 'tab-day'}>
      {#if currentView === 'week'}
        <div class="week-layout">
          <div class="grid-section glass-panel">
            {#if mostrarPista}
              <div class="pista-primera" id="pista-primera">
                <Info size={16} aria-hidden="true" />
                <span class="pista-texto">{$t('dayView.dragHint')}</span>
                <button type="button" class="pista-ok" onclick={descartarPista}>
                  {$t('dayView.dragHintGotIt')}
                </button>
              </div>
            {/if}
            <WeeklyGrid 
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
              settings={settingsObj}
              dayOverrides={$dayOverridesStore || []}
              onSelectDay={handleDaySelect}
              onEditActivity={(id, _initialData) => openActivityModal(id, null, _initialData)}
            />
          </div>
          <div class="stats-section">
            {#if DonutChartsComp}
              <DonutChartsComp
                activities={$activitiesStore || []}
                categories={$categoriesStore || []}
                settings={settingsObj}
              />
            {/if}
          </div>
        </div>
      {:else}
        <!-- Vista Día: mismas acciones que Semana (header único, sin sidebar
             duplicada: escritorio edita, móvil ve). -->
        <div class="day-layout glass-panel">
          {#if DailyViewComp}
            <DailyViewComp 
              day={selectedDay}
              activities={$activitiesStore || []} 
              categories={$categoriesStore || []} 
              settings={settingsObj}
              dayOverrides={$dayOverridesStore || []}
              onEditActivity={(id, initialData) => openActivityModal(id, selectedDay, initialData)}
              onNavigateDay={(dir) => { selectedDay = Math.max(0, Math.min(6, selectedDay + dir)); }}
            />
          {:else if dailyError}
            <!-- Falló la carga del chunk tras los reintentos: un esqueleto
                 girando para siempre era el reporte ("entro y no me carga").
                 Acá se dice qué pasó y se da un botón — el usuario nunca queda
                 clavado sin salida. -->
            <div class="daily-skeleton daily-skeleton-error" role="status" aria-live="polite">
              <p class="daily-error-msg">{dailyError}</p>
              <button type="button" class="daily-retry-btn" onclick={reintentarVistaDia}>
                {$t('day.retry')}
              </button>
            </div>
          {:else}
            <!-- Esqueleto EN el panel (no overlay fixed): mantiene el layout y
                 comunica progreso sin tapar el header ni la grilla. Mismo alto
                 aproximado que el track del día para no saltar al montar. -->
            <div class="daily-skeleton" role="status" aria-label={$t('header.viewDay')}>
              <div class="skel-header">
                <div class="skel-chip"></div>
                <div class="skel-line"></div>
              </div>
              <div class="skel-track">
                {#each Array(8) as _, i}
                  <div class="skel-block" style="animation-delay: {i * 90}ms"></div>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </main>

  <!-- Modals -->
  {#if showSettings}
    {#await loadSettingsPanel()}
      <div class="modal-loading" role="status">Cargando ajustes…</div>
    {:then}
      {#if SettingsPanelComp}
        <SettingsPanelComp
          settings={settingsObj}
          categories={$categoriesStore || []}
          onClose={() => showSettings = false}
        />
      {/if}
    {/await}
  {/if}

  {#if showActivityModal}
    {#await loadActivityModal()}
      <div class="modal-loading" role="status">Cargando…</div>
    {:then}
      {#if ActivityModalComp}
        <ActivityModalComp
          id={editingActivityId}
          targetDay={modalTargetDay}
          initialData={initialActivityData}
          categories={$categoriesStore || []}
          settings={settingsObj}
          onClose={() => { showActivityModal = false; modalTargetDay = null; initialActivityData = null; }}
        />
      {/if}
    {/await}
  {/if}

  <!-- (FAB móvil retirado a pedido del usuario: tapaba la última columna de
       la grilla semanal. La creación vive en el botón del header y en el
       tap sobre un hueco de la vista Día.) -->

  {#if menuDatos}
    <!-- Portal a body: el backdrop-filter de .glass-panel ancestro crea
         containing block y anclaría el menú lejos del botón. Mismo fix que
         el menú contextual de las vistas. -->
    <!-- Animación CSS propia (menuDatosAnim) y NO transition:fly: fly lee la
         opacity computada del nodo al crearse, y un nodo recién portado al
         body (use:portal) computa 0 → animaba 0→0 y el menú quedaba
         invisible. La CSS keyframes no depende del estado previo. -->
    <div
      class="menu-datos glass-panel menuDatosAnim"
      class:menuDatosSaliendo={menuDatosSaliendo}
      role="menu"
      use:portal
      style="top: {menuDatosPos.y}px; left: {menuDatosPos.x}px"
    >
      <div class="menu-datos-nube" role="presentation">
        <Cloud size={14} /> {$t('cloud.title')}
        <span class="menu-nube-estado">{syncStatus === 'synced'
          ? $t('sync.synced')
          : syncStatus === 'syncing'
            ? $t('sync.syncing')
            : syncStatus === 'offline'
              ? $t('sync.offline')
              : syncStatus === 'error'
                ? $t('sync.error')
                : $t('cloud.sinSesion')}</span>
      </div>
      {#if syncDetail.sesion}
        <button role="menuitem" onclick={subirANube} title={$t('cloud.subirTitle')} disabled={nubeOcupada !== null}>
          {#if nubeOcupada === 'subir'}<RefreshCw size={16} class="girando" />{:else}<CloudUpload size={16} />{/if}
          <span class="menu-item-flex">{nubeOcupada === 'subir' ? $t('cloud.subiendo') : $t('cloud.subir')}</span>
          {#if syncDetail.pending > 0}<span class="menu-check menu-nube-badge">{$t('cloud.pendientes', { n: syncDetail.pending })}</span>{/if}
        </button>
        <button role="menuitem" onclick={bajarDeNube} title={$t('cloud.bajarTitle')} disabled={nubeOcupada !== null}>
          <CloudDownload size={16} />
          <span class="menu-item-flex">{nubeOcupada === 'bajar' ? $t('cloud.bajando') : $t('cloud.bajar')}</span>
        </button>
      {:else}
        <button role="menuitem" onclick={abrirSesion} title={$t('cloud.sinSesionTitle')}>
          <LogIn size={16} />
          <span class="menu-item-flex">{$t('cloud.sinSesion')}</span>
        </button>
      {/if}
      <div class="menu-datos-sep" role="presentation"></div>
      <button role="menuitem" onclick={exportarDatos} title={$t('sidebar.exportTitle')}>
        <Download size={16} /> {$t('sidebar.export')}
      </button>
      <button role="menuitem" onclick={importarDatos} title={$t('sidebar.importTitle')}>
        <Upload size={16} /> {$t('sidebar.import')}
      </button>
      <div class="menu-datos-sep" role="presentation"></div>
      <button role="menuitemcheckbox" aria-checked={$modoPrivacidad} onclick={alternarPrivacidad} title={$t('header.privacy')}>
        {#if $modoPrivacidad}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
        <span class="menu-item-flex">{$t('header.privacy')}</span>
        {#if $modoPrivacidad}<span class="menu-check">✓</span>{/if}
      </button>
      <div class="menu-datos-pie" role="presentation">
        {#if fechaUltimoRespaldo}
          {$t('sidebar.lastBackup', { fecha: fechaUltimoRespaldo })}
        {:else}
          {$t('sidebar.lastBackupNever')}
        {/if}
      </div>
    </div>
  {/if}

  <Toasts />
</div>

<style>
  .dashboard {
    /* Escalado por ancho de pantalla: 1400px de piso en desktop común,
       1560px en pantallas grandes y 2000px en ultrawide (2560+) para que
       el contenido crezca con la pantalla en vez de dejar franjas muertas
       a los lados (a 2560px el tope 1800 dejaba 380px vacíos POR LADO).
       clamp fluido: nada brusco entre breakpoints. */
    max-width: clamp(1400px, 86vw, 2000px);
    /* width 100%: sin esto, siendo grid item de .app-layout con margin auto,
       el navegador lo encoge a fit-content y el clamp no llega a usarse. */
    width: 100%;
    margin: 0 auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-height: 100vh;
  }

  /* 3 zonas de verdad: logo (izq) · pestañas (centro EXACTO) · acciones (der).
     Con flex space-between las pestañas quedaban pegadas al logo y el centro
     del header quedaba vacío en pantallas anchas. */
  .dashboard-header {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 1rem;
    padding: 1rem 1.5rem;
    padding-top: calc(1rem + env(safe-area-inset-top, 0px));
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 2rem;
    justify-self: start;
  }

  .view-tabs {
    justify-self: center;
  }

  /* Acciones compactas: con textos (Ajustar Arriba/Abajo + Nueva Actividad)
   la fila mide ~700px y SOLO cabe en ultrawide (≥1960px); en pantallas
   comunes partía la fila en dos (el ⚙️ quedaba solo abajo) y descentraba
   las pestañas al crecer su zona de la grilla. Iconos solos (con aria-label
   y title) caben siempre y las pestañas siguen centradas exactas. */
  @media (max-width: 2080px) {
    .header-actions :global(.hide-mobile) {
      display: none;
    }
  }

  /* Desktop: la fila de acciones no se parte — si no cupiera, la zona
   derecha de la grilla crece (1fr tiene piso en su contenido) en vez de
   bajar el ⚙️ a una segunda fila. */
  @media (min-width: 1200px) {
    .header-actions {
      flex-wrap: nowrap;
    }
  }

  .header-right {
    justify-self: end;
  }

  /* Pantallas medianas: las 3 zonas no caben sin apretar (las acciones miden
     ~390px); vuelve el layout de 2 bloques con las pestañas a la derecha del
     logo y las acciones a la derecha. */
  @media (max-width: 1199px) {
    .dashboard-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
    }
    .view-tabs {
      margin-left: auto;
    }
  }

  /* Móvil en HORIZONTAL: alto escaso y ancho de sobra. El bloque anterior
     (max-width 1199px) convertía la cabecera en flex-wrap, y con solo 390px
     de alto se partía en dos filas: 146px de cabecera, el 37% de la pantalla,
     dejando 196px útiles de un timeline de día que mide 1600px.

     Pero en horizontal los tres bloques SI caben en una fila: medidos,
     172 + 204 + 376 = 752px dentro de 844px. Así que se recupera la
     disposicion de una sola linea (grid 1fr auto 1fr, como en escritorio) y
     se ajustan solo los paddings. Los botones de acción no se tocan: 44px es
     el piso duro de zona táctil y ya lo cumplen justos. */
  @media (max-height: 480px) and (min-width: 700px) {
    .dashboard-header {
      display: grid;
      /* 1fr auto auto y no 1fr auto 1fr: con la derecha en 1fr el navegador
         le daba 275px de los 376px que miden sus botones, y estos se partian
         por dentro en dos filas (96px de alto). auto auto les deja su ancho
         natural; el 1fr del logo absorbe lo que sobra. Suman 752px en 820. */
      grid-template-columns: 1fr auto auto;
      gap: 0.5rem;
      padding: 0.35rem 0.75rem;
      padding-top: calc(0.35rem + env(safe-area-inset-top, 0px));
    }
    .view-tabs {
      margin-left: 0;
    }
    .logo {
      font-size: 1rem;
    }
    .view-tabs button {
      padding: 0.45rem 0.7rem;
    }
    .header-right,
    .header-actions {
      flex-wrap: nowrap;
    }
  }

  .logo {
    font-size: 1.25rem;
    font-weight: 700;
    color: rgb(var(--verde-texto));
    /* h1: neutralizar el estilo de agente de usuario y mantener el aspecto previo */
    margin: 0;
  }

  .view-tabs {
    display: flex;
    background: rgb(var(--tinta) / 0.05);
    padding: 0.25rem;
    border-radius: 10px;
    gap: 0.25rem;
  }

  /* role=tablist exige layout flex en el CONTENEDOR con role (no en el nav) */
  .view-tabs-inner {
    display: flex;
    gap: 0.25rem;
  }

  .view-tabs button {
    background: transparent;
    border: none;
    padding: 0.6rem 1rem;
    min-height: 44px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all 0.2s;
  }

  .view-tabs button.active {
    background: rgb(var(--sup));
    color: rgb(var(--verde-texto));
    box-shadow: 0 2px 8px rgb(var(--sombra) / 0.05);
  }

  .header-right {
    display: flex;
    /* center: sin esto, si las acciones llegan a partirse en 2 filas, el
       botón de Datos (hermano en esta fila) se ESTIRA a la altura de las
       dos filas (píldora gigante vista en preview a 2000px). */
    align-items: center;
    gap: 0.75rem;
  }

  /* Acciones del header: fila horizontal SIEMPRE (en Semana y en móvil).
     Sin esto los botones-block se apilan en columna (bug visto en Semana). */
  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  /* Escritorio angosto / zoom del navegador (≤1200px): los botones con texto
     pasan a solo-ícono. Con texto, el grupo necesita ~645px y entre ~770 y
     ~1150px no entra junto al logo+pestañas: flex-wrap lo partía en dos filas
     y se veía una columna apilada a la derecha (bug en desktop). aria-label +
     title conservan el significado; los targets siguen ≥44px (regla dura #5). */
  @media (max-width: 1200px) {
    .header-actions .hide-mobile {
      display: none;
    }
    .btn-plus {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
  }

  /* Ancla del menú Datos: wrapper inline para que el botón no participe del
     wrap raro, y para medir su rect a la hora de abrir. */
  .menu-datos-wrap {
    display: inline-flex;
  }
  .menu-datos-wrap .btn-icon {
    position: relative;
  }

  /* Dropdown de Datos (portal a body, position:fixed): mismo look que el
     menú contextual de las vistas. */
  .menu-datos {
    position: fixed;
    z-index: 1200;
    min-width: 230px;
    padding: 0.35rem;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 24px rgb(var(--sombra) / 0.18);
    /* El menú se ancla a la IZQUIERDA del botón (que está a la derecha del
       header), así que la escala tiene que crecer desde su esquina superior
       derecha: si el origen fuera top-left, el panel "crecería" hacia el
       botón y se vería que se estira en vez de abrirse. */
    transform-origin: top right;
  }
  /* ── Animación del menú ────────────────────────────────────────────────
     Un fade de 160 ms pasaba desapercibido: el menú aparecía de golpe. Ahora
     el panel escala desde la esquina anclada al botón y sus ítems entran
     escalonados (stagger de 40 ms), que es lo que comunica "se abrió" sin
     tener que esperarlo.
     Direcciones fijas: el menú siempre abre hacia abajo (y = botón.bottom),
     así que entra desde arriba y sale hacia arriba. */
  .menuDatosAnim {
    animation: menuDatosIn 0.18s cubic-bezier(0.22, 1.15, 0.36, 1) both;
  }
  .menuDatosAnim.menuDatosSaliendo {
    animation: menuDatosOut 0.12s ease-in both;
  }
  @keyframes menuDatosIn {
    from { opacity: 0; transform: translateY(-10px) scale(0.92); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes menuDatosOut {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to { opacity: 0; transform: translateY(-6px) scale(0.96); }
  }
  /* Stagger: 3 botones (2 items + 1 checkbox) y 2 filas informativas. El
     nth-child cuenta TODOS los hijos, por eso el checkbox es el 4º. */
  .menuDatosAnim > button {
    animation: menuItemIn 0.16s ease-out both;
  }
  .menuDatosAnim > button:nth-child(1) { animation-delay: 0.02s; }
  .menuDatosAnim > button:nth-child(2) { animation-delay: 0.06s; }
  .menuDatosAnim > button:nth-child(4) { animation-delay: 0.10s; }
  .menuDatosAnim > .menu-datos-sep,
  .menuDatosAnim > .menu-datos-pie {
    animation: menuFadeIn 0.16s ease-out both;
  }
  .menuDatosAnim > .menu-datos-sep { animation-delay: 0.13s; }
  .menuDatosAnim > .menu-datos-pie { animation-delay: 0.17s; }
  @keyframes menuItemIn {
    from { opacity: 0; transform: translateY(-7px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes menuFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  /* Al cerrar manda el panel: los hijos vuelven a su estado natural sin
     esperar su retardo, si no el menú se encogía a medias. */
  .menuDatosAnim.menuDatosSaliendo > * {
    animation: none;
  }
  /* El ✓ del modo privacidad asienta con un rebote corto al aparecer. */
  .menu-check {
    color: rgb(var(--verde-texto));
    font-weight: 700;
    animation: menuCheckIn 0.24s cubic-bezier(0.3, 1.7, 0.5, 1) both;
  }
  @keyframes menuCheckIn {
    from { opacity: 0; transform: scale(0.3); }
    to { opacity: 1; transform: scale(1); }
  }
  /* Respeto a la preferencia del sistema: sin movimiento, el menú aparece. */
  @media (prefers-reduced-motion: reduce) {
    .menuDatosAnim,
    .menuDatosAnim > *,
    .menu-check {
      animation: none !important;
    }
  }
  .menu-datos button {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: 44px; /* regla dura #5 */
    padding: 0.55rem 0.8rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: rgb(var(--tinta));
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    transition: background 0.15s;
  }
  .menu-datos button:hover {
    background: rgb(var(--tinta) / 0.08);
  }
  /* El icono acompaña al puntero: un desplazamiento de 2px da el gesto de
     "esto se abre" sin mover el texto (mover el texto saca el blanco del
     objetivo de lectura). */
  .menu-datos button svg {
    transition: transform 0.15s ease-out;
    flex-shrink: 0;
  }
  .menu-datos button:hover svg {
    transform: translateX(2px);
  }

  .menu-datos button[role="menuitemcheckbox"] {
    justify-content: flex-start;
  }
  /* Botones de nube en vuelo: se apagan para que un doble clic no dispare
     dos pushes. opacity sola (sin display:none) para no romper el layout ni
     sacar el elemento del árbol accesible a media animación. */
  .menu-datos button[disabled] {
    opacity: 0.55;
    cursor: progress;
  }
  .girando {
    animation: girar 0.9s linear infinite;
  }
  @keyframes girar {
    to { transform: rotate(360deg); }
  }
  /* Cabecera de la sección nube dentro del menú: el estado va a la derecha
     para que el ojo lea "acción" a la izquierda y "cómo está" a la derecha. */
  .menu-datos-nube {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.8rem 0.35rem;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: rgb(var(--tinta) / 0.7);
  }
  .menu-nube-estado {
    margin-left: auto;
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0;
    text-transform: none;
    color: rgb(var(--verde-texto));
    white-space: nowrap;
  }
  /* Contador de pendientes: no puede ser el ✓ verde (significa "modo
     privacidad activo"); va ámbar para que se lea como aviso. */
  .menu-nube-badge {
    color: rgb(var(--ambar-texto));
    font-size: 0.68rem;
    font-weight: 700;
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .girando { animation: none; }
  }
  .menu-item-flex {
    flex: 1;
    text-align: left;
  }
  .menu-check {
    color: rgb(var(--verde-texto));
    font-weight: 700;
  }
  .menu-datos-sep {
    height: 1px;
    margin: 0.35rem 0.5rem;
    background: rgb(var(--tinta) / 0.14);
  }

  /* Pie informativo: fecha del último respaldo descargado (no interactivo) */
  .menu-datos-pie {
    padding: 0.45rem 0.8rem 0.3rem;
    margin-top: 0.15rem;
    border-top: 1px solid rgb(var(--tinta) / 0.14);
    font-size: 0.72rem;
    font-weight: 500;
    color: rgb(var(--tinta) / 0.65);
    white-space: nowrap;
  }

  /* Targets táctiles >= 44px en el header (regla dura #5) */
  .header-right .btn {
    min-height: 44px;
    min-width: 44px;
  }

  /* Banner de estado de sincronización */
  .modal-loading {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    z-index: 2000;
    color: rgb(var(--verde-texto));
    font-size: 0.95rem;
    background: rgb(var(--sup-2) / 0.6);
    backdrop-filter: blur(2px);
  }

  /* ── Esqueleto de carga de la vista Día ──
     Bloques que pulsan dentro del panel: layout estable (no overlay),
     sensación de progreso y sin salto al montar el track real. */
  .daily-skeleton {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 60vh;
  }

  /* Falló la carga del chunk: el esqueleto mudo se reemplaza por un aviso
     con salida. Sin animación de shimmer — acá no hay nada progressing. */
  .daily-skeleton-error {
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 1.25rem;
  }

  .daily-error-msg {
    margin: 0;
    max-width: 34rem;
    color: var(--text-primary, rgb(var(--texto)));
    font-size: 1rem;
    line-height: 1.5;
  }

  .daily-retry-btn {
    min-height: 44px; /* target táctil ≥44px (regla dura #5) */
    min-width: 44px;
    padding: 0.65rem 1.5rem;
    border-radius: 999px;
    border: 1px solid rgb(var(--verde-borde));
    background: var(--color-green-dark, rgb(var(--verde-fuerte)));
    color: rgb(var(--sobre-color));
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease, transform 0.15s ease;
  }

  .daily-retry-btn:hover {
    filter: brightness(1.08);
  }

  .daily-retry-btn:active {
    transform: scale(0.97);
  }
  .skel-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .skel-chip {
    width: 110px;
    height: 32px;
    border-radius: 16px;
    background: rgb(var(--tinta) / 0.08);
    animation: skelPulso 1.2s ease-in-out infinite;
  }
  .skel-line {
    flex: 1;
    max-width: 320px;
    height: 14px;
    border-radius: 7px;
    background: rgb(var(--tinta) / 0.06);
    animation: skelPulso 1.2s ease-in-out 150ms infinite;
  }
  .skel-track {
    position: relative;
    flex: 1;
    border-left: 2px solid rgb(var(--tinta) / 0.08);
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding-left: 56px;
  }
  .skel-block {
    height: 64px;
    border-radius: 10px;
    border-left: 4px solid rgb(var(--tinta) / 0.12);
    background: rgb(var(--tinta) / 0.05);
    animation: skelPulso 1.2s ease-in-out infinite;
    /* anchos variados: parece contenido real, no una lista clonada */
  }
  .skel-block:nth-child(3n) { width: 72%; }
  .skel-block:nth-child(3n + 1) { width: 88%; }
  .skel-block:nth-child(3n + 2) { width: 55%; }
  @keyframes skelPulso {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.45; }
  }
  @media (prefers-reduced-motion: reduce) {
    .skel-chip, .skel-line, .skel-block {
      animation: none;
    }
  }

  .sync-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.1rem;
    border-radius: 12px;
    border: 1px solid rgb(var(--ambar-borde) / 0.4);
    background: rgb(var(--sup-calido) / 0.92);
    color: rgb(var(--ambar-texto));
    font-size: 0.88rem;
  }
  .sync-banner span { flex: 1; }
  .sync-retry {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    border: none;
    background: rgb(var(--verde-fuerte));
    color: rgb(var(--texto-calido));
    border-radius: 10px;
    padding: 0.55rem 1rem;
    min-height: 44px;
    font-weight: 600;
    cursor: pointer;
  }
  .sync-retry:hover:not(:disabled) { filter: brightness(1.1); }
  .sync-retry:disabled { cursor: progress; }
  /* Spinner del reintento: el mismo giro que el badge de
     estado; reduced-motion lo apaga más abajo. */
  .sync-banner .spin { animation: spin 1.2s linear infinite; }

    /* El spinner del reintento no gira: el texto "Reintentando…"
       ya dice lo que pasa. */
    .sync-banner .spin {
      animation: none;
    }
  /* Punto de estado del sync (hallazgo amarillo de la auditoría: el icono
     de nube no decía NADA del estado). Colores semánticos con tokens. */
  .sync-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid rgb(var(--borde-blanco));
    background: rgb(var(--gris-medio));
  }
  /* Puntos de estado por token (regla #7): antes llevaban hex
     sueltos que no cambiaban con el tema. */
  .sync-dot.synced { background: rgb(var(--verde-fuerte)); }
  .sync-dot.syncing { background: rgb(var(--ambar-solido)); }
  .sync-dot.error { background: rgb(var(--rojo-solido)); }
  .sync-dot.offline { background: rgb(var(--gris-medio)); }
  .sync-dot.pendiente { background: rgb(var(--ambar-solido)); }

  .sync-badge {
    display: flex;
    align-items: center;
    /* Regla dura #5: target táctil real de 44px — antes el
       min-height de 40px no lo cubría ni con el padding. */
    justify-content: center;
    min-width: 44px;
    background: transparent;
    font-size: 0.88rem;
    white-space: nowrap;
    border: 1px solid rgb(var(--verde-borde) / 0.25);
    color: rgb(var(--verde-texto));
    border-radius: 50%;
    width: 44px;
    height: 44px;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
  }

  .sync-badge:hover {
    background: rgb(var(--verde-lavado) / 0.08);
  }

  .sync-badge.syncing {
    animation: spin 1.2s linear infinite;
    pointer-events: none;
  }

  .sync-badge.error {
    color: rgb(var(--rojo-texto));
    border-color: rgb(var(--rojo-borde) / 0.4);
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .btn-plus {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-left: 0.75rem;
  }

  .btn-icon {
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Target táctil completo aunque el icono sea pequeño */
    min-width: 44px;
    min-height: 44px;
  }

  /* (Barra lateral de acciones de Día retirada: el header es único en ambas
     vistas — escritorio edita con el mismo header que móvil.) */

  .dashboard-main {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .view-container {
    flex: 1;
  }

  .week-layout {
    display: grid;
    /* Sidebar de donuts fluida: 320px de piso, hasta 420px en ultrawide —
       en 2560px los 360px se veían enanos junto a la grilla. */
    grid-template-columns: 1fr clamp(320px, 17vw, 420px);
    gap: 1.5rem;
    height: 100%;
  }

  .grid-section {
    padding: 1rem;
    overflow-x: auto;
  }

  /* Pista de primera ejecución: una sola vez, encima de la rejilla. El botón
     es un target de texto normal (min-height 44px por la regla táctil), no una
     ✕ diminuta: un cierre de 20px es inalcanzable con el dedo. */
  .pista-primera {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
    padding: 0.25rem 0.25rem 0.25rem 0.7rem;
    border-radius: 10px;
    background: rgb(var(--verde-lavado) / 0.08);
    border: 1px solid rgb(var(--verde-borde) / 0.16);
    color: rgb(var(--verde-texto));
    font-size: 0.9rem;
  }
  .pista-texto {
    flex: 1;
    min-width: 0;
  }
  .pista-ok {
    flex: none;
    min-height: 44px;
    padding: 0 0.9rem;
    border: 1px solid rgb(var(--verde-borde) / 0.24);
    border-radius: 8px;
    background: rgb(var(--sup));
    color: rgb(var(--verde-texto));
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .pista-ok:hover {
    background: rgb(var(--verde-lavado) / 0.08);
  }

  .stats-section {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* ── Pantallas grandes / ultrawide (≥1536px) ──
     Tipografía y aire del header suben un punto para acompañar el ancho:
     en 21:9 el header quedaba enano frente a 2 metros de grilla. */
  @media (min-width: 1536px) {
    .dashboard {
      padding: 2rem;
      gap: 2rem;
    }
    .logo {
      font-size: 1.4rem;
    }
    .dashboard-header {
      padding: 1.1rem 1.75rem;
    }
    .view-tabs button {
      font-size: 0.95rem;
      padding: 0.6rem 1.25rem;
    }
    .dashboard-header :global(.btn) {
      font-size: 0.95rem;
    }
  }

  /* Ultrawide real (≥2200px, 21:9 QHD+): un punto más de escala sin pasarse —
     la app es mobile-first, no convertimos el header en un banner. */
  @media (min-width: 2200px) {
    .dashboard {
      padding: 2.5rem;
    }
    .logo {
      font-size: 1.55rem;
    }
    .dashboard-header {
      padding: 1.25rem 2rem;
    }
    .view-tabs button {
      font-size: 1rem;
      padding: 0.65rem 1.4rem;
    }
  }

  @media (max-width: 1024px) {
    .week-layout {
      grid-template-columns: 1fr;
    }
    /* El horario es lo primario en móvil: los donuts van después, no antes */
    .stats-section {
      flex-direction: row;
      flex-wrap: wrap;
    }
  }

  @media (max-width: 768px) {
    .dashboard {
      padding: 0.75rem;
      gap: 1rem;
    }
    .dashboard-header {
      padding: 0.75rem 1rem;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    /* Regla dura #5: los .btn medían 42px reales (line-height recortaba el min-height). */
    .dashboard-header :global(.btn) {
      min-height: 44px;
      line-height: 1;
    }
    /* Fila 1: logo a la izquierda y pestañas a la derecha. Fila 2: acciones
       CENTRADAS (antes pegadas a la derecha: en móvil el header parecía
       desbalanceado). */
    .header-right {
      width: 100%;
      justify-content: center;
      gap: 0.5rem;
    }
    /* G9: en landscape corto el header se come la mitad de la pantalla —
       compactar a solo íconos (los textos quedan en aria-label) y permitir
       que left/right compartan una sola fila (los width:100% fuerzan 2 filas).
       Va DESPUÉS de las reglas base: misma especificidad, gana el orden. */
    @media (orientation: landscape) and (max-height: 420px) {
      .dashboard-header {
        padding: 0.4rem 1rem;
        padding-top: calc(0.4rem + env(safe-area-inset-top, 0px));
        gap: 0.5rem;
      }
      .hide-mobile {
        display: none;
      }
      .logo {
        font-size: 0.95rem;
      }
      .dashboard-header :global(.btn) {
        /* regla dura #5: nunca por debajo de 44px ni en landscape corto */
        min-height: 44px;
        padding: 0.3rem 0.6rem;
      }
      .view-tabs button {
        padding: 0.35rem 0.5rem;
        font-size: 0.8rem;
      }
      .header-left,
      .header-right {
        width: auto;
      }
    }
    .grid-section {
      padding: 0.5rem;
    }
  }

  @media (max-width: 640px) {
    .hide-mobile {
      display: none;
    }
    .btn-plus {
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
  }

  @media (max-width: 420px) {
    .logo {
      font-size: 1.1rem;
    }
    .view-tabs button {
      padding: 0.35rem 0.6rem;
      font-size: 0.8rem;
    }
  }

  /* (G5: FAB flotante retirado a pedido del usuario — tapaba la última
     columna de la grilla. Sin reemplazo: el botón "Nueva Actividad" del
     header y el tap en hueco de la vista Día cubren la creación.) */
</style>
