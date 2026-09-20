<script lang="ts">
  import { Pie, Group, Chart, Svg } from 'layerchart';
  import type { Activity, Category } from '../lib/types.js';
  import { parseTime, getActivityColor } from '../lib/stores.js';

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

  const dayStats = $derived(getStats(activities.filter((a: Activity) => a.daysOfWeek.includes(new Date().getDay() === 0 ? 6 : new Date().getDay() - 1))));
  const weekStats = $derived(getStats(activities));
</script>

<div class="stats-container">
  <div class="stat-card glass-panel">
    <h3>Horas Hoy</h3>
    <div class="chart-wrapper">
      <Chart
        data={dayStats}
        x="value"
        c="key"
        cRange={dayStats.map((s: any) => s.color)}
      >
        <Svg>
          <Group center>
            <Pie innerRadius={50} cornerRadius={4} />
          </Group>
        </Svg>
      </Chart>
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
      <Chart
        data={weekStats}
        x="value"
        c="key"
        cRange={weekStats.map((s: any) => s.color)}
      >
        <Svg>
          <Group center>
            <Pie innerRadius={50} cornerRadius={4} />
          </Group>
        </Svg>
      </Chart>
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
