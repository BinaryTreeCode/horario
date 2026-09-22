<script lang="ts">
  import type { Activity, Category } from '../lib/types.js';
  import { parseTime } from '../lib/stores.js';

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

  // Helper to calculate total hours per category.
  // Overlaps are NOT double-counted: intervals are merged per time slot and
  // each merged slice is divided evenly among the categories covering it.
  function getStats(filterActivities: Activity[]) {
    // 1) Expand to concrete (start, end, category) intervals for one day
    const intervals: { start: number; end: number; categoryId: string }[] = [];
    filterActivities.forEach((a: Activity) => {
      const s = parseTime(a.startTime);
      const e = parseTime(a.endTime);
      if (e <= s) return;
      const occurrences = filterActivities === activities ? a.daysOfWeek.length : 1;
      for (let i = 0; i < occurrences; i++) {
        intervals.push({ start: s, end: e, categoryId: a.categoryId });
      }
    });
    if (intervals.length === 0) return [];

    // 2) Collect breakpoints and compute per-slice coverage
    const points = [...new Set(intervals.flatMap(iv => [iv.start, iv.end]))].sort((x, y) => x - y);
    const stats: Record<string, number> = {};

    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const covering = intervals.filter(iv => iv.start <= a && iv.end >= b);
      if (covering.length === 0) continue;
      const slice = (b - a) / covering.length; // el tramo se reparte entre las categorías activas
      covering.forEach(iv => {
        stats[iv.categoryId] = (stats[iv.categoryId] || 0) + slice;
      });
    }

    return categories
      .map((c: Category) => ({
        key: c.id,
        label: c.label,
        value: stats[c.id] || 0,
        color: c.color
      }))
      .filter((s: any) => s.value > 0);
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

  const dayStats = $derived(getStats(activities.filter((a: Activity) => a.daysOfWeek.includes(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1))));
  const weekStats = $derived(getStats(activities));
</script>

<div class="stats-container">
  <div class="stat-card glass-panel">
    <h3>Horas Hoy</h3>
    <div class="chart-wrapper">
      <svg viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="Distribución de horas de hoy por categoría">
        {#each ringSegments(dayStats) as seg (seg.key)}
          <path d={seg.d} fill={seg.color} />
        {/each}
      </svg>
      <div class="chart-overlay">
        <span>{dayStats.reduce((acc: number, s: any) => acc + s.value, 0).toFixed(1)}h</span>
      </div>
    </div>
    <div class="legend">
      {#each dayStats as stat}
        <div class="legend-item">
          <span class="dot" style="background: {stat.color}"></span>
          <span class="label">{stat.label}</span>
          <span class="val">{stat.value.toFixed(1)}h</span>
        </div>
      {/each}
    </div>
  </div>

  <div class="stat-card glass-panel">
    <h3>Horas Semana</h3>
    <div class="chart-wrapper">
      <svg viewBox="0 0 {SIZE} {SIZE}" role="img" aria-label="Distribución de horas de la semana por categoría">
        {#each ringSegments(weekStats) as seg (seg.key)}
          <path d={seg.d} fill={seg.color} />
        {/each}
      </svg>
      <div class="chart-overlay">
        <span>{weekStats.reduce((acc: number, s: any) => acc + s.value, 0).toFixed(1)}h</span>
      </div>
    </div>
    <div class="legend">
      {#each weekStats as stat}
        <div class="legend-item">
          <span class="dot" style="background: {stat.color}"></span>
          <span class="label">{stat.label}</span>
          <span class="val">{stat.value.toFixed(1)}h</span>
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
    font-size: 1.25rem;
    font-weight: 700;
    color: var(--color-brown-bark);
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

  .label {
    flex: 1;
    color: #666;
  }

  .val {
    font-weight: 600;
    color: var(--text-main);
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
