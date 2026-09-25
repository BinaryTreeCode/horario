<script lang="ts">
  /**
   * ScheduleBoard — grilla semanal/diaria con semántica "hueco libre"
   * (infografía del usuario): 1) mover solo a hueco libre; 2) soltar sobre
   * un bloque ocupado = ⛔ vuelve; 3) estirar come el hueco y empuja
   * vecinos en cadena; 4) límites del día duros.
   *
   * Reemplaza a DailyView + WeeklyGrid + dragEngine. El gesto es Pointer
   * Events directo (umbral 6px mouse, long-press 350ms táctil, Esc cancela,
   * auto-scroll rAF); la matemática vive en cascade.ts (dueño único).
   * Persistencia: alcance plantilla = activities (master), alcance ⚡ =
   * dayOverrides del día. Commits con undo y updatedAt (sync LWW).
   */
  import { db } from '../lib/db';
  import type { Activity, Category, DayOverride } from '../lib/types';
  import { parseTime, formatTime, getActivityColor } from '../lib/stores';
  import { planMover, planResize, finDe, type Bloque, type PlanMover } from '../lib/cascade';
  import { toastOk, toastErr } from '../lib/toast';
  import { pushUndo, cloneAct } from '../lib/undo';
  import ConfirmDialog from './ConfirmDialog.svelte';

  interface Props {
    vista: 'semana' | 'dia';
    diaSel: number;
    activities: Activity[];
    categories: Category[];
    dayOverrides: DayOverride[];
    settings: { startHour: number; endHour: number };
    alcance: 'dia' | 'plantilla';
    /** Lunes 00:00 de la semana visible. */
    lunes: Date;
    onOpenActivity: (id: string | null, day: number | null, initialData?: Activity | null) => void;
    onSelectDay: (day: number) => void;
    onNavegar: (dir: number | 'hoy') => void;
    onAlcance: (a: 'dia' | 'plantilla') => void;
  }

  let {
    vista, diaSel, activities, categories, dayOverrides, settings,
    alcance, lunes, onOpenActivity, onSelectDay, onNavegar, onAlcance
  }: Props = $props();

  // ── Grilla ───────────────────────────────────────────────────────────────
  const PXH = 64;
  const PXM = PXH / 60;
  const SNAP = 15;
  const minDia = $derived(settings.startHour * 60);
  const maxDia = $derived(settings.endHour * 60);
  const ALTO = $derived((settings.endHour - settings.startHour) * PXH);
  const HORAS = $derived(
    Array.from({ length: settings.endHour - settings.startHour }, (_, k) => settings.startHour + k)
  );
  const NOMBRES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
  const dias = $derived(vista === 'semana' ? [0, 1, 2, 3, 4, 5, 6] : [diaSel]);
  const esSemana = $derived(vista === 'semana');

  // ── Estado de UI ─────────────────────────────────────────────────────────
  let ahora = $state(new Date());
  $effect(() => {
    const t = setInterval(() => (ahora = new Date()), 30000);
    return () => clearInterval(t);
  });
  const minAhora = $derived(ahora.getHours() * 60 + ahora.getMinutes());

  let prev = $state<PlanMover | (ReturnType<typeof planResize> & { cambios?: Record<number, Bloque[]> }) | null>(null);
  let flot = $state<{
    w: number; h: number; titulo: string; color: string;
    x: number; y: number; horas: string; texto: string; valido: boolean;
  } | null>(null);
  let confirmResetDay = $state(false);

  let scroller: HTMLElement | undefined = $state();
  let colEls: (HTMLElement | undefined)[] = $state([]);

  /** Datos internos del gesto — NO reactivos (patrón del componente base). */
  interface Gesto {
    pid: number;
    id: string; dia: number; diaActual: number;
    b: Bloque;
    modo: 'mover' | 'arriba' | 'abajo';
    offsetMin: number; grabX: number; grabY: number; w: number; h: number;
    x0: number; y0: number; x: number; y: number;
    tactil: boolean; activo: boolean; timer: number | null; raf: number;
    titulo: string; color: string;
  }
  let drag: Gesto | null = null;

  const esMover = (p: typeof prev): p is PlanMover => !!p && 'valido' in p;

  // ── Conversión Activity ↔ Bloque (minutos desde medianoche) ─────────────
  const aBloque = (a: Activity): Bloque => ({
    id: a.id!,
    inicio: parseTime(a.startTime) * 60,
    duracion: Math.max(5, Math.round((parseTime(a.endTime) - parseTime(a.startTime)) * 60))
  });

  function fechaDe(i: number): Date {
    const x = new Date(lunes);
    x.setDate(x.getDate() + i);
    return x;
  }
  function claveFecha(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── Modelo: plantilla (master) vs excepción (override ⚡) ───────────────
  function getBloques(i: number): Activity[] {
    if (alcance === 'plantilla') return activities.filter(a => a.daysOfWeek.includes(i));
    return dayOverrides.find(o => o.day === i)?.activities ?? activities.filter(a => a.daysOfWeek.includes(i));
  }
  function tieneExcepcion(i: number): boolean {
    return alcance === 'dia' && dayOverrides.some(o => o.day === i);
  }

  /** Lo que se pinta: propuesta en vivo durante el gesto, o datos guardados. */
  function bloquesVista(i: number): { act: Activity; b: Bloque }[] {
    const base = getBloques(i).map(a => ({ act: a, b: aBloque(a) }));
    const plan = prev?.cambios?.[i];
    if (!plan) return base;
    return base
      .map(({ act }) => {
        const nb = plan.find(x => x.id === act.id);
        return nb ? { act, b: nb } : null;
      })
      .filter((x): x is { act: Activity; b: Bloque } => !!x);
  }

  // ── Gesto ────────────────────────────────────────────────────────────────
  function iniciar(e: PointerEvent, act: Activity, d: number) {
    if (e.button > 0 || drag) return;
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const asa = (e.target as HTMLElement).closest('.asa');
    const col = colEls[d];
    if (!col) return;
    const b = aBloque(act);
    drag = {
      pid: e.pointerId,
      id: act.id!, dia: d, diaActual: d, b,
      modo: asa ? ((asa as HTMLElement).classList.contains('top') ? 'arriba' : 'abajo') : 'mover',
      offsetMin: minDia + (e.clientY - col.getBoundingClientRect().top) / PXM - b.inicio,
      grabX: e.clientX - rect.left, grabY: e.clientY - rect.top,
      w: rect.width, h: rect.height,
      x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
      tactil: e.pointerType === 'touch', activo: false, timer: null, raf: 0,
      titulo: act.name, color: getActivityColor(act.categoryId, categories)
    };
    if (drag.tactil) drag.timer = window.setTimeout(activar, 350); // long-press móvil
  }

  function onMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pid) return; // multitáctil: solo MI puntero
    drag.x = e.clientX; drag.y = e.clientY;
    if (!drag.activo) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= 6) return;
      if (drag.tactil) { if (drag.timer) clearTimeout(drag.timer); drag = null; return; } // era scroll
      activar();
    }
    actualizar();
  }
  function onUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pid) return; // el pointerup de OTRO dedo no suelta mi gesto
    if (drag.activo) void aplicar();
    limpiar();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && drag) { limpiar(); toastOk('Arrastre cancelado'); }
  }
  // Freno de scroll táctil (no pasivo) mientras el gesto está armado.
  $effect(() => {
    const bloquearScroll = (e: TouchEvent) => { if (drag?.activo) e.preventDefault(); };
    document.addEventListener('touchmove', bloquearScroll, { passive: false });
    return () => document.removeEventListener('touchmove', bloquearScroll);
  });

  function activar() {
    if (!drag) return;
    drag.activo = true;
    if (drag.modo === 'mover') {
      flot = { w: drag.w, h: drag.h, titulo: drag.titulo, color: drag.color, x: 0, y: 0, horas: '', texto: '', valido: true };
    }
    document.body.classList.add(drag.modo === 'mover' ? 'arrastrando' : 'redimensionando');
    if (drag.tactil && navigator.vibrate) navigator.vibrate(15);
    actualizar();
    autoScroll();
  }

  function actualizar() {
    if (!drag) return;
    let d = drag.diaActual;
    if (drag.modo === 'mover') {
      for (const dd of dias) {
        const r = colEls[dd]?.getBoundingClientRect();
        if (r && drag.x >= r.left && drag.x < r.right) { d = dd; break; }
      }
    }
    drag.diaActual = d;
    const col = colEls[d];
    if (!col) return;
    const minuto = minDia + (drag.y - col.getBoundingClientRect().top) / PXM;

    if (drag.modo === 'mover') {
      const mismo = d === drag.dia;
      const origArr = getBloques(drag.dia).map(aBloque);
      const destArr = mismo ? origArr : getBloques(d).map(aBloque);
      const p = planMover(origArr, destArr, mismo, drag.id, drag.b, minuto, drag.offsetMin, minDia, maxDia, SNAP);
      // Preview cross-day: el día destino aún no conoce al bloque → se añade.
      const destPintado = mismo
        ? p.destino
        : [...p.destino.filter(x => x.id !== drag!.id), p.bb].sort((a, b) => a.inicio - b.inicio);
      prev = { ...p, cambios: { [d]: destPintado, ...(mismo ? {} : { [drag.dia]: p.origen }) } };
      flot = flot && {
        ...flot,
        x: drag.x - drag.grabX, y: drag.y - drag.grabY,
        horas: `${fmt(p.bb.inicio)} – ${fmt(finDe(p.bb))}`,
        texto: p.motivo || '↳ Soltar para mover',
        valido: p.valido
      };
    } else {
      const p = planResize(getBloques(d).map(aBloque), drag.id, drag.modo, minuto, minDia, maxDia, SNAP);
      prev = { ...p, cambios: { [d]: p.bloques } };
      flot = flot && {
        ...flot,
        x: drag.x - drag.grabX, y: drag.y - drag.grabY,
        horas: `${fmt(p.bb.inicio)} – ${fmt(finDe(p.bb))}`,
        texto: '',
        valido: true
      };
    }
  }

  function autoScroll() {
    if (!drag || !drag.activo || !scroller) return;
    const r = scroller.getBoundingClientRect(), m = 50, v = 12;
    let dy = 0, dx = 0;
    if (drag.y < r.top + 44 + m) dy = -v; else if (drag.y > r.bottom - m) dy = v;
    if (drag.modo === 'mover') {
      if (drag.x < r.left + m) dx = -v; else if (drag.x > r.right - m) dx = v;
    }
    if (dy || dx) {
      const t = scroller.scrollTop, l = scroller.scrollLeft;
      scroller.scrollTop += dy; scroller.scrollLeft += dx;
      if (t !== scroller.scrollTop || l !== scroller.scrollLeft) actualizar();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function limpiar() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    if (drag.timer) clearTimeout(drag.timer);
    document.body.classList.remove('arrastrando', 'redimensionando');
    drag = null;
    prev = null;
    flot = null;
  }

  // ── Persistencia ─────────────────────────────────────────────────────────
  async function aplicar() {
    const p = prev;
    if (!p || !drag) return;
    if (esMover(p) && !p.valido) {
      toastErr('⛔ No cabe ahí: el bloque vuelve a su sitio');
      return;
    }
    const cambios = p.cambios ?? {};
    if (!cambios[drag.diaActual]) return;
    const label = esMover(p) ? 'Mover' : 'Estirar';
    await persistir(drag.dia, drag.diaActual, cambios, `${label} ${drag.titulo}`, drag.id);
  }

  /** Nudge de teclado: ±SNAP con la misma matemática del drag. */
  async function nudge(act: Activity, d: number, deltaMin: number) {
    const arr = getBloques(d).map(aBloque);
    const b = arr.find(x => x.id === act.id);
    if (!b) return;
    const p = planMover(arr, arr, true, act.id!, b, b.inicio + deltaMin, 0, minDia, maxDia, SNAP);
    if (!p.valido) { toastErr('⛔ No hay hueco libre ahí'); return; }
    await persistir(d, d, { [d]: p.destino }, `Mover ${act.name}`, act.id!);
  }

  async function persistir(
    diaOrigen: number, diaDestino: number,
    cambios: Record<number, Bloque[]>,
    label: string, movedId: string
  ) {
    const destino = cambios[diaDestino] ?? [];
    const crossDay = diaOrigen !== diaDestino;
    try {
      if (alcance === 'plantilla') {
        // Master: una fila = horario global + días. Tocados = destino (+ el
        // movido si cross-day). Snapshots "antes" para el undo.
        const ids = [...new Set([...destino.map(x => x.id), ...(crossDay ? [movedId] : [])])];
        const beforeRows = await db.activities.bulkGet(ids);
        const beforeById = new Map(beforeRows.filter((x): x is Activity => !!x).map(x => [x.id!, x]));
        const now = Date.now();
        await db.transaction('rw', db.activities, async () => {
          for (const nb of destino) {
            const master = await db.activities.get(nb.id);
            if (!master) continue;
            let days = master.daysOfWeek;
            if (nb.id === movedId) {
              const set = new Set(days);
              set.add(diaDestino);
              if (crossDay) set.delete(diaOrigen);
              days = [...set].sort((a, b) => a - b);
            }
            await db.activities.update(nb.id, {
              startTime: formatTime(nb.inicio / 60),
              endTime: formatTime(finDe(nb) / 60),
              daysOfWeek: days,
              updatedAt: now
            });
          }
        });
        const rows: import('../lib/undo').RowChange[] = [];
        for (const id of ids) {
          const after = await db.activities.get(id);
          rows.push({ before: beforeById.has(id) ? cloneAct(beforeById.get(id)!) : null, after: after ? cloneAct(after) : null });
        }
        pushUndo({ label, rows });
      } else {
        // Override ⚡ del día destino (+ del origen si cross-day).
        const ovDest = await db.dayOverrides.get(diaDestino);
        const semillaDest = ovDest?.activities ?? activities.filter(a => a.daysOfWeek.includes(diaDestino));
        const acts: Activity[] = semillaDest.map(a => ({ ...a }));
        const byId = new Map(acts.map(a => [a.id!, a]));
        for (const nb of destino) {
          const a = byId.get(nb.id);
          if (a) {
            a.startTime = formatTime(nb.inicio / 60);
            a.endTime = formatTime(finDe(nb) / 60);
          } else {
            const master = activities.find(x => x.id === nb.id);
            if (master) acts.push({ ...master, startTime: formatTime(nb.inicio / 60), endTime: formatTime(finDe(nb) / 60), daysOfWeek: [diaDestino] });
          }
        }
        const beforeDest = ovDest ?? null;
        await db.dayOverrides.put({ day: diaDestino, activities: $state.snapshot(acts), updatedAt: Date.now() });
        let beforeOrig: DayOverride | null = null;
        if (crossDay) {
          const ovOrig = await db.dayOverrides.get(diaOrigen);
          beforeOrig = ovOrig ?? null;
          const semillaOrig = ovOrig?.activities ?? activities.filter(a => a.daysOfWeek.includes(diaOrigen));
          await db.dayOverrides.put({
            day: diaOrigen,
            activities: $state.snapshot(semillaOrig.filter(a => a.id !== movedId)),
            updatedAt: Date.now()
          });
        }
        pushUndo({
          label: `${label} · ${NOMBRES[diaDestino]}`,
          rows: [],
          overrides: [
            { day: diaDestino, before: beforeDest, after: await db.dayOverrides.get(diaDestino) ?? null },
            ...(crossDay ? [{ day: diaOrigen, before: beforeOrig, after: await db.dayOverrides.get(diaOrigen) ?? null }] : [])
          ]
        });
      }
      toastOk(`${alcance === 'plantilla' ? 'Plantilla actualizada' : 'Cambio solo para esta fecha (⚡)'}`);
    } catch (err: any) {
      console.error('[schedule-board] persistir', err);
      toastErr('Error al guardar: ' + (err?.message || err));
    }
  }

  // ── Crear / editar ───────────────────────────────────────────────────────
  function dobleClickBloque(act: Activity, d: number) {
    onOpenActivity(act.id!, alcance === 'dia' ? d : null, alcance === 'dia' ? act : null);
  }

  /** Doble clic en hueco: nueva actividad prellenada con el hueco libre. */
  function crearEnHueco(e: MouseEvent, d: number) {
    const col = colEls[d];
    if (!col) return;
    const minuto = minDia + (e.clientY - col.getBoundingClientRect().top) / PXM;
    const arr = getBloques(d).map(aBloque);
    const ini = Math.max(minDia, ...arr.filter(o => finDe(o) <= minuto).map(finDe));
    const fn = Math.min(maxDia, ...arr.filter(o => o.inicio > minuto).map(o => o.inicio));
    const inicio = Math.max(ini, Math.min(fn - SNAP, Math.floor(minuto / SNAP) * SNAP));
    const duracion = Math.min(60, fn - inicio);
    if (duracion < SNAP) { toastErr('No hay hueco suficiente'); return; }
    onOpenActivity(null, d, {
      id: '',
      categoryId: categories[0]?.id ?? '',
      name: '',
      description: '',
      startTime: formatTime(inicio / 60),
      endTime: formatTime((inicio + duracion) / 60),
      daysOfWeek: [d],
      updatedAt: Date.now()
    });
  }

  // ── Volver a la plantilla ────────────────────────────────────────────────
  async function doVolverAPlantilla() {
    const ov = await db.dayOverrides.get(diaSel);
    await db.dayOverrides.delete(diaSel);
    if (ov) pushUndo({ label: `Restaurar ${NOMBRES[diaSel]}`, rows: [], overrides: [{ day: diaSel, before: ov, after: null }] });
    toastOk('El día vuelve a usar la plantilla');
  }

  function fmt(m: number): string {
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return `${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
  }

  const opts = { day: 'numeric', month: 'short' } as const;
  const titulo = $derived.by(() => {
    if (esSemana) {
      return alcance === 'plantilla'
        ? 'Plantilla semanal'
        : `${fechaDe(0).toLocaleDateString('es', opts)} – ${fechaDe(6).toLocaleDateString('es', opts)}`;
    }
    return alcance === 'plantilla'
      ? `${NOMBRES[diaSel]} (plantilla)`
      : `${NOMBRES[diaSel]} ${fechaDe(diaSel).toLocaleDateString('es', opts)}`;
  });
</script>

<svelte:window onpointermove={onMove} onpointerup={onUp} onpointercancel={(e) => { if (!drag || e.pointerId === drag.pid) limpiar(); }} onkeydown={onKey} />

<div class="board">
  <div class="toolbar">
    <div class="nav">
      <button onclick={() => onNavegar(-1)} aria-label="Anterior">‹</button>
      <strong>{titulo}</strong>
      <button onclick={() => onNavegar(1)} aria-label="Siguiente">›</button>
      <button onclick={() => onNavegar('hoy')} aria-label="Ir a hoy">Hoy</button>
    </div>
    <div class="seg" role="group" aria-label="Alcance de edición">
      <button class:on={alcance === 'dia'} onclick={() => onAlcance('dia')} aria-pressed={alcance === 'dia'}>⚡ Solo este día</button>
      <button class:on={alcance === 'plantilla'} onclick={() => onAlcance('plantilla')} aria-pressed={alcance === 'plantilla'}>📅 Plantilla</button>
    </div>
    {#if vista === 'dia' && tieneExcepcion(diaSel)}
      <button class="reset" onclick={() => (confirmResetDay = true)}>↺ Volver a la plantilla</button>
    {/if}
  </div>

  <div class="scroller" bind:this={scroller}>
    <div
      class="grid"
      class:vista-semana={esSemana}
      class:vista-dia={!esSemana}
      style="grid-template-columns: 64px repeat({dias.length}, minmax({esSemana ? 110 : 220}px, 1fr)); --pxh: {PXH}px;"
    >
      <div class="head esquina"></div>
      {#each dias as d (d)}
        {@const f = fechaDe(d)}
        <button class="head" class:hoy={claveFecha(ahora) === claveFecha(f)} onclick={() => onSelectDay(d)}>
          <span>{NOMBRES[d]}</span>
          {#if esSemana}<small>{f.getDate()}</small>{/if}
          {#if tieneExcepcion(d)}<i class="rayo" title="Cambios solo para este día">⚡</i>{/if}
        </button>
      {/each}

      <div class="horas" style="height: {ALTO}px">
        {#each HORAS as h}
          {#if h > settings.startHour}
            <div class="hl" style="top: {(h - settings.startHour) * PXH}px">{h % 12 || 12}:00<small>{h < 12 ? 'AM' : 'PM'}</small></div>
          {/if}
          <div class="hl m" style="top: {(h - settings.startHour) * PXH + PXH / 2}px">{h % 12 || 12}:30</div>
        {/each}
      </div>

      {#each dias as d (d)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-body" style="height: {ALTO}px" bind:this={colEls[d]} ondblclick={(e) => crearEnHueco(e, d)}>
          {#each bloquesVista(d) as item (item.act.id)}
            {@const b = item.b}
            {@const activo = prev?.bb.id === item.act.id}
            <div
              class="bloque"
              class:corto={b.duracion <= 20}
              class:destino={!!activo && esMover(prev)}
              class:invalido={!!activo && esMover(prev) && !prev.valido}
              class:redim={!!activo && !esMover(prev)}
              style="top: {(b.inicio - minDia) * PXM + 1}px; height: {b.duracion * PXM - 2}px; --c: {getActivityColor(item.act.categoryId, categories)};"
              role="button"
              tabindex="0"
              aria-label="{item.act.name}, {fmt(b.inicio)} a {fmt(finDe(b))}. Arrastra para mover, bordes para estirar, doble clic para editar"
              onpointerdown={(e) => iniciar(e, item.act, d)}
              ondblclick={(e) => { e.stopPropagation(); dobleClickBloque(item.act, d); }}
              onkeydown={(e) => {
                if (e.key === 'Enter') dobleClickBloque(item.act, d);
                else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  void nudge(item.act, d, e.key === 'ArrowUp' ? -SNAP : SNAP);
                }
              }}
              oncontextmenu={(e) => e.preventDefault()}
            >
              <div class="asa top" aria-hidden="true"></div>
              <div class="t">{item.act.name}</div>
              <div class="h">{fmt(b.inicio)} – {fmt(finDe(b))}</div>
              {#if item.act.image}<img class="thumb" src={item.act.image} alt="" />{/if}
              <div class="asa bot" aria-hidden="true"></div>
            </div>
          {/each}

          {#if claveFecha(ahora) === claveFecha(fechaDe(d)) && minAhora >= minDia && minAhora <= maxDia}
            <div class="ahora" style="top: {(minAhora - minDia) * PXM}px"></div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>

{#if flot}
  <div
    class="bloque flotante"
    class:corto={flot.h < 24}
    class:invalido={!flot.valido}
    class:oscuro={esSemana}
    style="left: {flot.x}px; top: {flot.y}px; width: {flot.w}px; height: {flot.h}px; --c: {flot.color};"
    aria-hidden="true"
  >
    <div class="t">{flot.titulo}</div>
    <div class="h">{flot.horas}</div>
    <div class="accion">{flot.texto}</div>
  </div>
{/if}

<ConfirmDialog
  bind:open={confirmResetDay}
  title="Volver a la plantilla"
  message="Se descartan los cambios de solo este día (⚡) y vuelve el horario semanal."
  confirmText="Restaurar"
  danger
  onconfirm={doVolverAPlantilla}
/>

<style>
  .board { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 10px; flex-wrap: wrap; }
  .nav { display: flex; align-items: center; gap: 6px; }
  .nav strong { font-size: 15px; min-width: 170px; text-align: center; }
  .toolbar button {
    border: 1px solid #e6e8ec; background: #fff; border-radius: 8px; padding: 6px 11px;
    min-height: 44px; cursor: pointer; font: 600 13px/1.2 inherit; color: #2b2f36;
  }
  .toolbar button:hover { background: #f5f6f8; }
  .seg { display: flex; background: #eef0f2; border-radius: 10px; padding: 3px; }
  .seg button { border: 0; background: transparent; color: #8a93a3; }
  .seg button.on { background: #fff; color: var(--color-green-dark, #2f6b2f); box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .toolbar .reset { margin-left: auto; color: #9a5b12; border-color: #f0d9b5; background: #fff8ec; }

  .scroller { flex: 1; min-height: 420px; max-height: calc(100vh - 250px); overflow: auto; position: relative; }
  .grid { display: grid; min-width: 100%; }
  .head {
    position: sticky; top: 0; z-index: 6; background: #fff; height: 44px; border: 0;
    border-bottom: 1px solid #e6e8ec; border-left: 1px solid #e6e8ec; display: flex; align-items: center;
    justify-content: center; gap: 6px; font: 700 14px inherit; color: inherit; cursor: pointer;
  }
  .head.esquina { border-left: 0; left: 0; z-index: 7; cursor: default; }
  .head small { color: #8a93a3; font-weight: 600; }
  .head.hoy { background: #f7f4f1; }
  .head.hoy span { color: var(--color-green-dark); }
  .rayo { font-style: normal; font-size: 11px; background: #fff3c4; border: 1px solid #f3d36b; border-radius: 5px; padding: 0 3px; }

  .horas { position: relative; }
  .hl { position: absolute; right: 10px; transform: translateY(-50%); font-size: 12px; font-weight: 700; color: #4a5261; white-space: nowrap; }
  .hl small { font-size: 10px; color: #8a93a3; margin-left: 2px; }
  .hl.m { font-weight: 500; color: #b3bac6; font-size: 11px; }

  .col-body {
    position: relative; border-left: 1px solid #e6e8ec; overflow: hidden;
    background-image: linear-gradient(#e9ecf0 1px, transparent 1px), linear-gradient(#f5f6f8 1px, transparent 1px);
    background-size: 100% var(--pxh), 100% calc(var(--pxh) / 2);
  }

  .bloque {
    position: absolute; left: 3px; right: 3px; border-radius: 6px; padding: 4px 7px; overflow: hidden; cursor: grab;
    user-select: none; -webkit-user-select: none; touch-action: pan-y; -webkit-touch-callout: none;
    display: flex; flex-direction: column; justify-content: center; box-sizing: border-box; outline: none;
    transition: top .16s ease, height .16s ease, opacity .15s;
  }
  .bloque .t { font-weight: 700; font-size: 12.5px; line-height: 1.2; }
  .bloque .h { font-size: 11px; opacity: .8; margin-top: 2px; }
  .bloque .thumb { position: absolute; right: 4px; top: 4px; width: 20px; height: 20px; border-radius: 4px; object-fit: cover; }
  .bloque.corto { padding: 0 7px; }
  .bloque.corto .t { font-size: 11px; }
  .bloque.corto .h { display: none; }

  .asa { position: absolute; left: 0; right: 0; height: 12px; cursor: ns-resize; z-index: 2; }
  .asa.top { top: 0; }
  .asa.bot { bottom: 0; }

  .vista-semana .bloque, .bloque.flotante.oscuro { background: var(--c); color: #fff; }
  .vista-dia .bloque, .bloque.flotante:not(.oscuro) { background: #fff; color: #2b2f36; border: 1px solid #e1e4e8; border-left: 4px solid var(--c); padding-left: 12px; }
  .vista-dia .bloque .t { font-size: 15px; }
  .vista-dia .bloque.corto .t { font-size: 12.5px; }

  .bloque.destino { opacity: .45; outline: 2px dashed #2b2f36; outline-offset: -2px; transition: none; }
  .bloque.destino.invalido { background: #e0453a !important; color: #fff !important; outline-color: #e0453a; }
  .bloque.redim { z-index: 5; box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--c); }
  .bloque.flotante { position: fixed; right: auto; z-index: 60; pointer-events: none; transition: none;
    box-shadow: 0 12px 28px rgba(0,0,0,.25); transform: rotate(-1.5deg); opacity: .95; }
  .bloque.flotante.invalido { box-shadow: 0 0 0 3px #e0453a, 0 12px 28px rgba(0,0,0,.25); }
  .bloque.flotante .h { display: block; opacity: 1; font-weight: 700; }
  .accion { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; margin-top: 3px; }
  .bloque.flotante.corto .accion { display: none; }

  .ahora { position: absolute; left: 0; right: 0; height: 2px; background: #e0453a; z-index: 4; pointer-events: none; }
  .ahora::before { content: ''; position: absolute; left: -4px; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: #e0453a; }

  @media (max-width: 768px) {
    .nav strong { min-width: 120px; font-size: 13.5px; }
    .toolbar button { padding: 8px 10px; }
    .scroller { max-height: none; height: calc(100vh - 250px); }
  }
</style>
