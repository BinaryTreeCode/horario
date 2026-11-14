<script lang="ts">
  import type { Category } from '../../lib/types';
  import { t } from '../../lib/i18n';
  import { textOn } from '../../lib/timeUtils';
  import {
    hexAHsl,
    hslAHex,
    generarArmonia
  } from '../../lib/paletaCategorias';

  interface Props {
    categories: Category[];
    selectedCatId: string;
    indColor: string;
  }

  let {
    categories,
    selectedCatId = $bindable(),
    indColor = $bindable()
  }: Props = $props();

  function cambiarCategoriaIndividual(id: string) {
    selectedCatId = id;
    const cat = categories.find(c => c.id === id);
    if (cat) indColor = cat.color;
  }

  // Descomposición HSL para sliders individuales
  const hslCurrent = $derived(hexAHsl(indColor));
  const currentH = $derived(hslCurrent[0]);
  const currentS = $derived(hslCurrent[1]);
  const currentL = $derived(hslCurrent[2]);

  function onSliderChange(h: number, s: number, l: number) {
    indColor = hslAHex(h, s, l);
  }

  // Armonías en tiempo real para el modo individual
  const armoniasEnVivo = $derived([
    { id: 'analoga', labelKey: 'settings.harmonyAnaloga', colores: generarArmonia(indColor, 'analoga', 5) },
    { id: 'monocromatica', labelKey: 'settings.harmonyMonocromatica', colores: generarArmonia(indColor, 'monocromatica', 5) },
    { id: 'triada', labelKey: 'settings.harmonyTriada', colores: generarArmonia(indColor, 'triada', 3) },
    { id: 'complementaria', labelKey: 'settings.harmonyComplementaria', colores: generarArmonia(indColor, 'complementaria', 4) }
  ]);

  const selectedCatObj = $derived(categories.find(c => c.id === selectedCatId));
  const contrasteInd = $derived(textOn(indColor));
</script>

<div id="panel-individual" role="tabpanel" aria-labelledby="tab-individual" class="tab-panel">
  <!-- Selector de categoría -->
  <div class="cat-select-box">
    <label for="select-cat-ind" class="block-title">{$t('settings.categoryToEdit')}:</label>
    <select
      id="select-cat-ind"
      class="form-select"
      value={selectedCatId}
      onchange={e => cambiarCategoriaIndividual(e.currentTarget.value)}
    >
      {#each categories as cat}
        <option value={cat.id}>{cat.label}</option>
      {/each}
    </select>
  </div>

  <!-- Muestra del color actual y valores -->
  <div class="color-display-card">
    <div class="large-color-swatch" style="background-color: {indColor};">
      <span
        class="swatch-text-preview"
        style="color: {contrasteInd.text}; text-shadow: 0 1px 2px {contrasteInd.shadow};"
      >
        {selectedCatObj?.label ?? $t('settings.categoryFallback')}
      </span>
    </div>
    <div class="color-text-inputs">
      <input
        type="color"
        value={indColor}
        class="color-circle-input"
        aria-label={$t('settings.baseColor')}
        oninput={e => (indColor = e.currentTarget.value)}
      />
      <input
        type="text"
        value={indColor.toUpperCase()}
        class="hex-input"
        aria-label={$t('settings.hexCode')}
        onchange={e => {
          const val = e.currentTarget.value.trim();
          if (/^#[0-9a-f]{6}$/i.test(val)) indColor = val.toLowerCase();
        }}
      />
    </div>
  </div>

  <!-- Deslizadores HSL interactivos -->
  <div class="hsl-sliders">
    <!-- Matiz (Hue) -->
    <div class="slider-group">
      <div class="slider-header">
        <span class="slider-label">{$t('settings.hue')}</span>
        <span class="slider-value">{currentH}°</span>
      </div>
      <input
        type="range"
        min="0"
        max="360"
        value={currentH}
        class="range-slider slider-hue"
        aria-label={$t('settings.hue')}
        oninput={e => onSliderChange(Number(e.currentTarget.value), currentS, currentL)}
      />
    </div>

    <!-- Saturación -->
    <div class="slider-group">
      <div class="slider-header">
        <span class="slider-label">{$t('settings.saturation')}</span>
        <span class="slider-value">{currentS}%</span>
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={currentS}
        class="range-slider"
        style="background: linear-gradient(to right, {hslAHex(currentH, 0, currentL)}, {hslAHex(currentH, 100, currentL)});"
        aria-label={$t('settings.saturation')}
        oninput={e => onSliderChange(currentH, Number(e.currentTarget.value), currentL)}
      />
    </div>

    <!-- Luminosidad -->
    <div class="slider-group">
      <div class="slider-header">
        <span class="slider-label">{$t('settings.lightness')}</span>
        <span class="slider-value">{currentL}%</span>
      </div>
      <input
        type="range"
        min="15"
        max="85"
        value={currentL}
        class="range-slider"
        style="background: linear-gradient(to right, {hslAHex(currentH, currentS, 15)}, {hslAHex(currentH, currentS, 50)}, {hslAHex(currentH, currentS, 85)});"
        aria-label={$t('settings.lightness')}
        oninput={e => onSliderChange(currentH, currentS, Number(e.currentTarget.value))}
      />
    </div>
  </div>

  <!-- Sugerencias de armonía en vivo -->
  <div class="harmonies-suggestions">
    <span class="block-title">{$t('settings.chromaticHarmonies')}</span>

    {#each armoniasEnVivo as armonia}
      <div class="harmony-row">
        <span class="harmony-label">{$t(armonia.labelKey)}:</span>
        <div class="swatches-row">
          {#each armonia.colores as col}
            <button
              type="button"
              class="swatch-action"
              class:active={indColor === col}
              style="background-color: {col};"
              onclick={() => (indColor = col)}
              aria-label={$t('settings.useColor', { color: col })}
            ></button>
          {/each}
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .tab-panel {
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
  }

  .block-title {
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: rgb(var(--tinta));
  }

  .cat-select-box {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .form-select {
    padding: 0.6rem 0.8rem;
    border-radius: 8px;
    border: 1px solid rgb(var(--linea) / 0.15);
    background: rgb(var(--sup));
    color: rgb(var(--texto));
    font-size: 0.95rem;
    min-height: 44px;
  }

  .color-display-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem;
    background: rgb(var(--sup-2));
    border-radius: 12px;
    border: 1px solid rgb(var(--linea) / 0.08);
  }

  .large-color-swatch {
    flex: 1;
    height: 48px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgb(var(--borde-blanco) / 0.3);
  }

  .swatch-text-preview {
    font-size: 0.95rem;
    font-weight: 700;
    text-shadow: 0 1px 2px rgb(var(--sombra) / 0.4);
  }

  .color-text-inputs {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .color-circle-input {
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    background: none;
    padding: 0;
  }

  .color-circle-input::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  .color-circle-input::-webkit-color-swatch {
    border-radius: 50%;
    border: 2px solid rgb(var(--borde-blanco));
    box-shadow: 0 1px 4px rgb(var(--sombra) / 0.2);
  }

  .hex-input {
    width: 90px;
    padding: 0.45rem 0.6rem;
    font-family: monospace;
    font-size: 0.88rem;
    border-radius: 6px;
    border: 1px solid rgb(var(--linea) / 0.15);
    background: rgb(var(--sup));
    color: rgb(var(--texto));
    text-align: center;
    min-height: 44px;
  }

  .hsl-sliders {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 0.85rem;
    background: rgb(var(--sup-2));
    border-radius: 12px;
    border: 1px solid rgb(var(--linea) / 0.08);
  }

  .slider-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .slider-header {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    font-weight: 600;
    color: rgb(var(--texto));
  }

  .slider-value {
    color: rgb(var(--texto-2));
    font-family: monospace;
  }

  .range-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 14px;
    border-radius: 7px;
    outline: none;
    border: 1px solid rgb(var(--linea) / 0.1);
    cursor: pointer;
  }

  .range-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: rgb(var(--sup));
    border: 2.5px solid rgb(var(--texto));
    box-shadow: 0 2px 4px rgb(var(--sombra) / 0.25);
    cursor: pointer;
  }

  .range-slider::-moz-range-thumb {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: rgb(var(--sup));
    border: 2.5px solid rgb(var(--texto));
    box-shadow: 0 2px 4px rgb(var(--sombra) / 0.25);
    cursor: pointer;
  }

  .slider-hue {
    background: linear-gradient(
      to right,
      hsl(0 100% 50%) 0%,
      hsl(60 100% 50%) 17%,
      hsl(120 100% 50%) 33%,
      hsl(180 100% 50%) 50%,
      hsl(240 100% 50%) 67%,
      hsl(300 100% 50%) 83%,
      hsl(360 100% 50%) 100%
    );
  }

  .harmonies-suggestions {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .harmony-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    background: rgb(var(--sup));
    border-radius: 8px;
    border: 1px solid rgb(var(--linea) / 0.08);
  }

  .harmony-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: rgb(var(--texto));
  }

  .swatches-row {
    display: flex;
    gap: 0.4rem;
  }

  .swatch-action {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: 1px solid rgb(var(--borde-blanco) / 0.4);
    cursor: pointer;
    box-shadow: 0 1px 3px rgb(var(--sombra) / 0.12);
    min-width: 44px;
    min-height: 44px;
    transition: transform 0.15s;
    padding: 0;
  }

  .swatch-action:hover {
    transform: scale(1.1);
  }

  @media (max-width: 768px) {
    .form-select,
    .hex-input {
      min-height: 44px;
      font-size: 16px;
    }
  }

  .swatch-action.active {
    box-shadow: 0 0 0 2px rgb(var(--texto));
  }
</style>
