<script lang="ts">
  import { Pie, Group, Chart, Svg } from 'layerchart';
  import type { Activity, Category } from '../lib/types.js';
  import { parseTime, getActivityColor } from '../lib/stores.js';

  interface Props {
    activities: Activity[];
    categories: Category[];
  }

  let { activities, categories }: Props = $props();

  // Helper to calculate total hours per category
  function getStats(filterActivities: Activity[]) {
    const stats: Record<string, number> = {};
    filterActivities.forEach((a: Activity) => {
      const duration = parseTime(a.endTime) - parseTime(a.startTime);
      const days = a.daysOfWeek.length;
      const total = duration * (filterActivities === activities ? days : 1);
      stats[a.categoryId] = (stats[a.categoryId] || 0) + total;
    });

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
</style>
