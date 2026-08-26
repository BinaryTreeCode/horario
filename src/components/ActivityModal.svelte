<script lang="ts">
  import { onMount } from 'svelte';
  import { db } from '../lib/db.ts';
  import type { Activity, Category } from '../lib/types.ts';
  import { X, Trash2, CheckCircle } from 'lucide-svelte';

  interface Props {
    id: number | null;
    categories: Category[];
    settings: { startHour: number; endHour: number };
    onClose: () => void;
  }

  let { id, categories, settings, onClose }: Props = $props();

  let categoryId = $state('');
  let name = $state('');
  let startTime = $state('08:00');
  let endTime = $state('09:00');
  let daysOfWeek = $state([0, 1, 2, 3, 4, 5, 6]);

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
  const durationMinutes = $derived(() => {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    const diff = (eh * 60 + em) - (sh * 60 + sm);
    return diff > 0 ? diff : 0;
  });

  // Ensure categoryId is set
  $effect(() => {
    if (!categoryId && categories.length > 0) {
      categoryId = categories[0].id;
    }
  });

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
      // If the loaded startTime is not in the options, add it
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
    // If the loaded endTime is not in the options, add it
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

  const days = [
    { label: 'L', index: 0 },
    { label: 'M', index: 1 },
    { label: 'M', index: 2 },
    { label: 'J', index: 3 },
    { label: 'V', index: 4 },
    { label: 'S', index: 5 },
    { label: 'D', index: 6 },
  ];

  onMount(async () => {
    if (id !== null) {
      const activity = await db.activities.get(id);
      if (activity) {
        categoryId = activity.categoryId;
        name = activity.name;
        startTime = activity.startTime;
        endTime = activity.endTime;
        daysOfWeek = [...activity.daysOfWeek];
      }
    } else {
      // Set defaults based on settings
      const defaultStart = Math.max(settings.startHour, 8); // default to 8:00 AM, but respect startHour
      const defaultEnd = Math.min(defaultStart + 1, settings.endHour);
      
      const startHStr = defaultStart.toString().padStart(2, '0');
      const endHStr = defaultEnd.toString().padStart(2, '0');
      
      startTime = `${startHStr}:00`;
      endTime = `${endHStr}:00`;
    }
  });

  async function save() {
    try {
      if (!categoryId) {
        alert('Por favor selecciona una categoría');
        return;
      }
      
      const activity: Activity = {
        categoryId,
        name,
        startTime,
        endTime,
        daysOfWeek: [...daysOfWeek]
      };

      console.log('Saving activity:', activity);

      if (id !== null) {
        activity.id = id;
        await db.activities.put(activity);
      } else {
        await db.activities.add(activity);
      }
      
      console.log('Activity saved successfully');
      onClose();
    } catch (error: any) {
      console.error('Failed to save activity:', error);
      alert('Error al guardar: ' + (error.message || 'Error desconocido'));
    }
  }

  async function remove() {
    if (id !== null) {
      await db.activities.delete(id);
      onClose();
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
  <div class="modal-content glass-panel" onclick={e => e.stopPropagation()}>
    <header class="modal-header">
      <h2>{id !== null ? 'Editar' : 'Nueva'} Actividad</h2>
      <button class="close-btn" onclick={onClose}><X size={20} /></button>
    </header>

    <form onsubmit={e => { e.preventDefault(); save(); }}>
      <div class="category-preview" style="background: {categoryColor}"></div>
      
      <div class="form-group">
        <label>Categoría</label>
        <select bind:value={categoryId} required>
          {#each categories as cat}
            <option value={cat.id}>{cat.label}</option>
          {/each}
        </select>
      </div>

      <div class="form-group">
        <label>¿Qué vas a hacer?</label>
        <input type="text" bind:value={name} placeholder="Ej. Sesión de Dibujo" required class="input-large" />
      </div>

      <div class="time-controls-box">
        <div class="time-row-modern">
          <div class="time-picker-group">
            <label>Desde</label>
            <select bind:value={startTime} class="time-select-modern">
              {#each startTimeOptions as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>
          
          <span class="to-separator">a</span>

          <div class="time-picker-group">
            <label>Hasta</label>
            <select bind:value={endTime} class="time-select-modern">
              {#each endTimeOptions() as opt}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="duration-controls">
          <span class="hint-text">Ajuste rápido:</span>
          <div class="duration-chips">
            <button type="button" class="chip" onclick={() => addDuration(30)}>30m</button>
            <button type="button" class="chip" onclick={() => addDuration(45)}>45m</button>
            <button type="button" class="chip" onclick={() => addDuration(60)}>1h</button>
            <button type="button" class="chip" onclick={() => addDuration(90)}>1.5h</button>
          </div>
        </div>

        <div class="duration-hint">
          Duración total: <strong>{durationMinutes() >= 60 ? `${Math.floor(durationMinutes()/60)}h ${durationMinutes()%60}m` : `${durationMinutes()}m`}</strong>
        </div>
      </div>

      <div class="form-group">
        <label>Días de la semana</label>
        <div class="days-selector">
          {#each days as day}
            <button 
              type="button"
              class="day-toggle" 
              class:selected={daysOfWeek.includes(day.index)}
              onclick={() => toggleDay(day.index)}
            >
              {day.label}
            </button>
          {/each}
        </div>
        <div class="presets">
          <button type="button" class="preset-btn" onclick={selectWeekdays}>Lunes a Viernes</button>
          <button type="button" class="preset-btn" onclick={selectAll}>Toda la semana</button>
        </div>
      </div>

      <footer class="modal-footer">
        {#if id !== null}
          <button type="button" class="btn btn-danger" onclick={remove}>
            <Trash2 size={18} /> Eliminar
          </button>
        {/if}
        <div class="footer-right">
          <button type="button" class="btn btn-secondary" onclick={onClose}>Cancelar</button>
          <button type="submit" class="btn btn-primary">
            <CheckCircle size={18} /> Guardar
          </button>
        </div>
      </footer>
    </form>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 200;
  }

  .modal-content {
    width: 95%;
    max-width: 500px;
    padding: 0;
    overflow: hidden;
    background: white;
    border-radius: 16px;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
    animation: slideUp 0.3s ease-out;
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .category-preview {
    height: 10px;
    width: 100%;
  }

  .modal-header, form {
    padding: 1.5rem 2rem;
  }

  .modal-header {
    padding-bottom: 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
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
    color: var(--color-green-dark);
    box-sizing: border-box;
  }

  .time-controls-box {
    background: #f8f9fa;
    padding: 1.25rem;
    border-radius: 12px;
    border: 1px solid rgba(0,0,0,0.05);
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
    color: var(--color-green-dark);
    border: 1px solid rgba(0,0,0,0.1);
    background: white;
    box-sizing: border-box;
  }

  .to-separator {
    font-size: 1rem;
    color: #999;
    padding-top: 1.25rem;
  }

  .duration-controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    background: white;
    border-radius: 8px;
  }

  .hint-text {
    font-size: 0.75rem;
    color: #999;
    font-weight: 600;
    text-transform: uppercase;
  }

  .duration-chips {
    display: flex;
    gap: 0.5rem;
  }

  .chip {
    background: rgba(92, 64, 51, 0.05);
    border: 1px solid rgba(92, 64, 51, 0.1);
    padding: 0.4rem 0.75rem;
    border-radius: 20px;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-brown-bark);
    cursor: pointer;
    transition: all 0.2s;
  }

  .chip:hover {
    background: var(--color-green-dark);
    color: white;
    border-color: var(--color-green-dark);
  }

  .time-select-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .time-badge {
    background: white;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.85rem;
    font-weight: 700;
    color: var(--color-green-dark);
    box-shadow: 0 2px 4px rgba(0,0,0,0.05);
    white-space: nowrap;
  }

  .duration-hint {
    margin-top: 1rem;
    text-align: center;
    font-size: 0.85rem;
    color: #888;
  }

  .duration-hint strong {
    color: var(--color-brown-bark);
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--color-green-dark);
  }

  .close-btn {
    background: transparent;
    border: none;
    color: #999;
    cursor: pointer;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  label {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--color-brown-bark);
  }

  input, select {
    padding: 0.75rem;
    border: 1px solid rgba(0,0,0,0.1);
    border-radius: 8px;
    font-size: 1rem;
    background: rgba(255,255,255,0.8);
  }

  input:focus, select:focus {
    outline: none;
    border-color: var(--color-green-dark);
    box-shadow: 0 0 0 2px rgba(45, 90, 39, 0.1);
  }

  .days-selector {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .day-toggle {
    flex: 1;
    height: 40px;
    border-radius: 8px;
    border: 1px solid rgba(0,0,0,0.1);
    background: white;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .day-toggle.selected {
    background: var(--color-green-dark);
    color: white;
    border-color: var(--color-green-dark);
  }

  .presets {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .preset-btn {
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    background: rgba(92, 64, 51, 0.05);
    border: 1px solid rgba(92, 64, 51, 0.1);
    border-radius: 4px;
    cursor: pointer;
    color: var(--color-brown-bark);
  }

  .modal-footer {
    display: flex;
    justify-content: space-between;
    padding: 1.5rem 2rem;
    border-top: 1px solid rgba(0,0,0,0.05);
    background: #fcfcfc;
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

  .btn-primary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
