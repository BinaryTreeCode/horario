<script lang="ts">
  import type { Activity, Category } from '../lib/types.js';
  import { computeCategoryStats, totalHours, formatHours, withFreeTime, DAY_CAPACITY, WEEK_CAPACITY } from '../lib/timeStats.js';
  import { t } from '../lib/i18n';

  // Donut SVG propio (~2 KB) en lugar de layerchart (~120 KB gzip):
  // misma estetica (innerRadius 50, porciones con separacion, overlay de horas).
  const SIZE = 200;
  const CENTER = SIZE / 2;
  const R_MID = 75;    // radio medio del anillo
  const THICK = 25;    // grosor: interior 62.5, exterior 87.5 (equivale a innerRadius 50)

  interface Props {
    activities: Activity[];
    categories: Category[];
  }

  let { activities, categories }: Props = $props();

  // Hoy en índice de daysOfWeek (0=Lunes..6=Domingo): JS da 0=Domingo.
  const todayIndex = $derived(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1);

  // Cálculo corregido: la semana suma día por día (antes el total semanal
  // acababa duplicando el diario por un bug de intervalos replicados).
  const dayStats = $derived(computeCategoryStats(activities, categories, [todayIndex]));
  const weekStats = $derived(computeCategoryStats(activities, categories, [0, 1, 2, 3, 4, 5, 6]));

  const dayTotal = $derived(totalHours(dayStats));
  const weekTotal = $derived(totalHours(weekStats));

  // Espacio libre: horas sin planificar (franja gris del anillo + fila en leyenda).
  const dayWithFree = $derived(withFreeTime(dayStats, DAY_CAPACITY));
  const weekWithFree = $derived(withFreeTime(weekStats, WEEK_CAPACITY));

  // % sobre la capacidad total (24h / 168h): contexto real de ocupación.
  function pct(value: number, capacity: number): string {
    return Math.round((value / capacity) * 100) + '%';
  }

  // Segmentos del anillo: paths de arco (exterior + interior) proporcionales al valor.
  function ringSegments(stats: { value: number; color: string; key: string }[]) {
    const total = stats.reduce((acc, s) => acc + s.value, 0);
    if (total <= 0) return [];
    const out: { d: string; color: string; key: string }[] = [];
    let angle = -Math.PI / 2; // empieza a las 12
    const gap = stats.length > 1 ? 0.035 : 0; // rad de separacion entre porciones
    const rOut = R_MID + THICK / 2;
    const rIn = R_MID - THICK / 2;
    for (const s of stats) {
      const sweep = (s.value / total) * 2 * Math.PI;
      const a0 = angle + gap / 2;
      const a1 = angle + sweep - gap / 2;
      if (a1 > a0) {
        const x0 = CENTER + rOut * Math.cos(a0), y0 = CENTER + rOut * Math.sin(a0);
        const x1 = CENTER + rOut * Math.cos(a1), y1 = CENTER + rOut * Math.sin(a1);
        const xi1 = CENTER + rIn * Math.cos(a1), yi1 = CENTER + rIn * Math.sin(a1);
        const xi0 = CENTER + rIn * Math.cos(a0), yi0 = CENTER + rIn * Math.sin(a0);
        const large = a1 - a0 > Math.PI ? 1 : 0;
        out.push({
          d: 'M ' + x0 + ' ' + y0
            + ' A ' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1
            + ' L ' + xi1 + ' ' + yi1
            + ' A ' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + xi0 + ' ' + yi0
            + ' Z',
          color: s.color,
          key: s.key
        });
      }
      angle += sweep;
    }
    return out;
  }
</script>

<div class="stats-container">
  <div class="stat-card glass-panel">
    <h3>{$t('week.hoursToday')}</h3>
    <div class="chart-wrapper">
      <svg viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label={$t('week.hoursTodayAria')}>
        {#each ringSegments(dayWithFree) as seg (seg.key)}
          <path d={seg.d} fill={seg.color} />
        {/each}
      </svg>
      <div class="chart-overlay">
        <span class="overlay-total">{formatHours(dayTotal)}</span>
        <span class="overlay-sub">{$t('donut.ofDay')}</span>
      </div>
    </div>      <div class="legend">
        {#each dayWithFree as stat}
          <div class="legend-item">
            <span class="dot {stat.key === '__free__' ? 'dot-free' : ''}" style="background: {stat.color}"></span>
            <span class="label">{stat.key === '__free__' ? $t('donut.free') : stat.label}</span>
            <span class="val">
              {formatHours(stat.value)}
              <span class="pct">{pct(stat.value, DAY_CAPACITY)}</span>
            </span>
          </div>
        {/each}
      </div>
  </div>

  <div class="stat-card glass-panel">
    <h3>{$t('week.hoursWeek')}</h3>
    <div class="chart-wrapper">
      <svg viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label={$t('week.hoursWeekAria')}>
        {#each ringSegments(weekWithFree) as seg (seg.key)}
          <path d={seg.d} fill={seg.color} />
        {/each}
      </svg>
      <div class="chart-overlay">
        <span class="overlay-total">{formatHours(weekTotal)}</span>
        <span class="overlay-sub">{$t('donut.ofWeek')}</span>
      </div>
    </div>      <div class="legend">
        {#each weekWithFree as stat}
          <div class="legend-item">
            <span class="dot {stat.key === '__free__' ? 'dot-free' : ''}" style="background: {stat.color}"></span>
            <span class="label">{stat.key === '__free__' ? $t('donut.free') : stat.label}</span>
            <span class="val">
              {formatHours(stat.value)}
              <span class="pct">{pct(stat.value, WEEK_CAPACITY)}</span>
            </span>
          </div>
        {/each}
      </div>
  </div>
</div>

<style>
  .stats-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .stat-card {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .stat-card h3 {
    margin: 0;
    font-size: 1.1rem;
    color: var(--color-green-dark);
    align-self: flex-start;
  }

  .chart-wrapper {
    width: 200px;
    height: 200px;
    position: relative;
  }

  .chart-wrapper svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  .chart-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .overlay-total {
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-brown-bark);
    white-space: nowrap;
  }

  .overlay-sub {
    font-size: 0.65rem;
    color: #999;
    margin-top: 0.15rem;
    white-space: nowrap;
  }

  .legend {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 1rem;
    border-top: 1px solid rgba(0,0,0,0.05);
    /* Reserva 2 filas: los datos llegan async y sin esto la 2da tarjeta salta (CLS) */
    min-height: 3.4rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .dot-free {
    background: #d8d5cd;
    border: 1px dashed #b5b1a6;
  }

  .label {
    flex: 1;
    color: #666;
  }

  .val {
    font-weight: 600;
    color: var(--text-main);
  }

  .pct {
    font-weight: 400;
    color: #999;
    font-size: 0.72rem;
    margin-left: 0.3rem;
  }

  @media (max-width: 768px) {
    .stats-container {
      width: 100%;
      gap: 1rem;
    }
    .stat-card {
      width: 100%;
      box-sizing: border-box;
      padding: 1rem;
    }
  }
</style>
