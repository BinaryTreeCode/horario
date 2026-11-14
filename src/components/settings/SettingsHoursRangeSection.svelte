<script lang="ts">
  import { t } from '../../lib/i18n';
  import { formatTime as horaReloj } from '../../lib/timeUtils';

  interface Props {
    startHour: number;
    endHour: number;
  }

  let { startHour = $bindable(), endHour = $bindable() }: Props = $props();

  const startOptions = $derived(
    Array.from({ length: 48 }, (_, i) => {
      const v = i * 0.5;
      const h = Math.floor(v), m = v % 1 ? '30' : '00';
      return { value: v, label: `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}${h === 12 ? ' (Mediodía)' : ''}` };
    })
  );

  const endOptions = $derived(
    Array.from({ length: 49 }, (_, i) => {
      const v = i * 0.5;
      const h = Math.floor(v), m = v % 1 ? '30' : '00';
      return { value: v, label: `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}${h === 12 ? ' (Mediodía)' : h === 24 ? ' (Medianoche)' : ''}` };
    }).filter(opt => opt.value > startHour)
  );

  const PASO_SLIDER = 0.25; // 15 min
  let asaActiva = $state<'inicio' | 'fin' | null>(null);

  function alArrastrarInicio(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    // Empujar el fin SOLO si el inicio lo alcanza (mínimo 1h de rango).
    if (v > endHour - 1) endHour = Math.min(24, v + 1);
    startHour = Math.min(v, endHour - 1);
  }

  function alArrastrarFin(e: Event) {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    // Empujar el inicio SOLO si el fin lo alcanza (mínimo 1h de rango).
    if (v < startHour + 1) startHour = Math.max(0, v - 1);
    endHour = Math.max(v, startHour + 1);
  }
</script>

<svelte:window
  onpointerup={() => { asaActiva = null; }}
  onpointercancel={() => { asaActiva = null; }}
/>

<section class="settings-section">
  <h3>{$t('settings.hoursRange')}</h3>
  <div class="range-selector">
    <div class="range-inputs-horizontal">
      <div class="form-group-compact">
        <label for="set-start">{$t('settings.startsAt')}</label>
        <select id="set-start" bind:value={startHour}>
          {#each startOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      
      <div class="to-text">{$t('settings.to')}</div>

      <div class="form-group-compact">
        <label for="set-end">{$t('settings.endsAt')}</label>
        <select id="set-end" bind:value={endHour}>
          {#each endOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
    </div>
    
    <div class="range-visual">
      <div class="range-slider">
        <div class="range-bar-total" class:arrastrando={asaActiva !== null}>
          <div class="range-bar-active" style="left: {(startHour / 24) * 100}%; width: {((endHour - startHour) / 24) * 100}%"></div>
        </div>
        <!-- Asas superpuestas: cada input cubre la barra completa; el
             z-index dinámico hace pasar arriba al asa cercana al cruce. -->
        <input
          type="range"
          class="range-handle asa-inicio"
          min={0}
          max={24}
          step={PASO_SLIDER}
          value={startHour}
          aria-label={$t('settings.startsAt')}
          aria-valuetext={horaReloj(startHour)}
          oninput={alArrastrarInicio}
          onpointerdown={() => { asaActiva = 'inicio'; }}
          style="z-index: {startHour > (startHour + endHour) / 2 - 1 ? 4 : 5}"
        />
        <input
          type="range"
          class="range-handle asa-fin"
          min={0}
          max={24}
          step={PASO_SLIDER}
          value={endHour}
          aria-label={$t('settings.endsAt')}
          aria-valuetext={horaReloj(endHour)}
          oninput={alArrastrarFin}
          onpointerdown={() => { asaActiva = 'fin'; }}
          style="z-index: {startHour > (startHour + endHour) / 2 - 1 ? 5 : 4}"
        />
        <div class="range-burbuja" class:visible={asaActiva !== null} style="left: {(asaActiva === 'fin' ? endHour : startHour) / 24 * 100}%">
          {horaReloj(asaActiva === 'fin' ? endHour : startHour)}
        </div>
      </div>
      <div class="range-labels">
        <span>0h</span>
        <span>12h</span>
        <span>24h</span>
      </div>
      <p class="range-summary">{$t('settings.daySummary', { hours: endHour - startHour })}</p>
    </div>
  </div>
</section>

<style>
  .settings-section h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    color: rgb(var(--tinta));
    border-bottom: 1px solid rgb(var(--linea) / 0.05);
    padding-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .range-selector {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
    background: rgb(var(--tinta) / 0.03);
    border-radius: 12px;
    border: 1px solid rgb(var(--linea) / 0.05);
  }

  .range-inputs-horizontal {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .form-group-compact {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }

  .form-group-compact label {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--texto-2));
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .form-group-compact select {
    width: 100%;
    padding: 0.5rem;
    min-height: 44px;
    font-size: 0.85rem;
    border: 1px solid rgb(var(--linea) / 0.1);
    border-radius: 8px;
    background: rgb(var(--sup));
    color: rgb(var(--tinta));
  }

  .to-text {
    padding-top: 1.25rem;
    font-size: 0.85rem;
    color: rgb(var(--texto-2));
    font-weight: 600;
  }

  .range-visual {
    padding-top: 1rem;
    border-top: 1px solid rgb(var(--linea) / 0.03);
    margin-top: 0.5rem;
  }

  .range-slider {
    position: relative;
    height: 28px;
    display: flex;
    align-items: center;
  }

  .range-bar-total {
    height: 8px;
    background: rgb(var(--lavado) / 0.1);
    border-radius: 4px;
    position: relative;
    overflow: hidden;
    width: 100%;
  }

  .range-handle {
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 100%;
    height: 28px;
    margin: 0;
    appearance: none;
    -webkit-appearance: none;
    background: transparent;
    pointer-events: none;
  }

  .range-handle:focus {
    outline: none;
  }

  .range-handle::-webkit-slider-runnable-track {
    height: 8px;
    background: transparent;
  }

  .range-handle::-webkit-slider-thumb {
    -webkit-appearance: none;
    pointer-events: auto;
    width: 22px;
    height: 22px;
    margin-top: -7px;
    border-radius: 50%;
    background: var(--color-green-dark);
    border: 3px solid rgb(var(--borde-blanco));
    box-shadow: 0 1px 4px rgb(var(--sombra) / 0.3);
    cursor: grab;
    transition: transform 0.15s;
  }

  .range-handle::-moz-range-track {
    height: 8px;
    background: transparent;
  }

  .range-handle::-moz-range-thumb {
    pointer-events: auto;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--color-green-dark);
    border: 3px solid rgb(var(--borde-blanco));
    box-shadow: 0 1px 4px rgb(var(--sombra) / 0.3);
    cursor: grab;
  }

  .range-handle:active::-webkit-slider-thumb {
    cursor: grabbing;
    transform: scale(1.15);
  }

  .range-handle:focus-visible::-webkit-slider-thumb {
    outline: 3px solid rgb(var(--verde-texto));
    outline-offset: 2px;
  }

  .asa-inicio { z-index: 5; }
  .asa-fin { z-index: 4; }

  .range-burbuja {
    position: absolute;
    top: -18px;
    transform: translateX(-50%);
    background: var(--color-brown-bark);
    color: rgb(var(--sobre-color));
    font-size: 0.72rem;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 6px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.15s, left 0.1s linear;
    white-space: nowrap;
    z-index: 6;
  }

  .range-burbuja.visible {
    opacity: 1;
  }

  .range-bar-total.arrastrando .range-bar-active {
    filter: brightness(1.08);
  }

  .range-bar-active {
    position: absolute;
    height: 100%;
    background: var(--color-green-dark);
    border-radius: 4px;
    transition: all 0.3s ease;
  }

  .range-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: rgb(var(--texto-2));
    margin-top: 0.5rem;
  }

  .range-summary {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
    color: rgb(var(--texto-2));
    text-align: center;
  }

  @media (max-width: 768px) {
    .form-group-compact select {
      min-height: 44px;
      font-size: 16px;
    }
    .range-slider {
      height: 36px;
    }
    .range-handle {
      height: 36px;
    }
    .range-handle::-webkit-slider-thumb {
      width: 28px;
      height: 28px;
      margin-top: -10px;
    }
    .range-handle::-moz-range-thumb {
      width: 28px;
      height: 28px;
    }
  }

  @media (max-width: 480px) {
    .range-selector {
      padding: 0.75rem;
      gap: 1rem;
    }
  }
</style>
