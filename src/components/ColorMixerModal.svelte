<script lang="ts">
  import type { Category } from '../lib/types';
  import { X, Check, Palette, SlidersHorizontal, Wand2 } from '@lucide/svelte';
  import { t } from '../lib/i18n';
  import { capturarEscape } from '../lib/dialogStack';
  import { atraparTab, enfocarDialogo, recordarFoco } from '../lib/focus';
  import { textOn } from '../lib/timeUtils';
  import {
    hexAHsl,
    hslAHex,
    generarArmonia,
    armonizarCategorias,
    PALETAS_TEMATICAS,
    ARMONIAS_CROMATICAS,
    esPaletaTematica
  } from '../lib/paletaCategorias';

  interface Props {
    isOpen: boolean;
    categories: Category[];
    targetCategoryId?: string | null;
    initialTab?: 'armonizar' | 'individual';
    onClose: () => void;
    onApplyAll: (newCategories: Category[]) => void;
    onApplyCategory: (catId: string, newColor: string) => void;
  }

  let {
    isOpen,
    categories,
    targetCategoryId = null,
    initialTab = 'armonizar',
    onClose,
    onApplyAll,
    onApplyCategory
  }: Props = $props();

  let modalEl = $state<HTMLElement | null>(null);
  let activeTab = $state<'armonizar' | 'individual'>('armonizar');
  let selectedMode = $state<string>('bosque');
  let pivotColor = $state<string>('#55854f');

  // Modo individual
  let selectedCatId = $state<string>('');
  let indColor = $state<string>('#55854f');

  // Inicializar estado cuando se abre o cambian props
  $effect(() => {
    if (isOpen) {
      activeTab = initialTab;
      if (targetCategoryId) {
        selectedCatId = targetCategoryId;
        const cat = categories.find(c => c.id === targetCategoryId);
        if (cat) indColor = cat.color;
      } else if (categories.length > 0) {
        selectedCatId = categories[0].id;
        indColor = categories[0].color;
      }
      if (categories.length > 0) {
        pivotColor = categories[0].color;
      }
    }
  });

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

  // Vista previa global de categorías armonizadas
  const categoriasArmonizadas = $derived(armonizarCategorias(categories, selectedMode, pivotColor));

  const selectedCatObj = $derived(categories.find(c => c.id === selectedCatId));
  const contrasteInd = $derived(textOn(indColor));

  $effect(() => {
    if (!isOpen) return;
    const restaurarFoco = recordarFoco();
    const limpiarEscape = capturarEscape(() => isOpen, () => onClose());
    queueMicrotask(() => enfocarDialogo(modalEl));
    return () => {
      limpiarEscape();
      restaurarFoco();
    };
  });

  function aplicarArmonizar() {
    const mapColor = new Map(categoriasArmonizadas.map(c => [c.id, c.color]));
    const actualizadas = categories.map(cat => ({
      ...cat,
      color: mapColor.get(cat.id) ?? cat.color,
      updatedAt: Date.now()
    }));
    onApplyAll(actualizadas);
    onClose();
  }

  function aplicarIndividual() {
    if (!selectedCatId) return;
    onApplyCategory(selectedCatId, indColor);
    onClose();
  }
</script>

{#if isOpen}
  <div class="modal-overlay" onclick={onClose}>
    <div
      class="modal-content glass-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mixer-modal-title"
      tabindex="-1"
      bind:this={modalEl}
      onkeydown={e => atraparTab(modalEl, e)}
      onclick={e => e.stopPropagation()}
    >
      <!-- Header -->
      <div class="modal-header">
        <div class="title-with-icon">
          <Palette size={22} class="icon-brand" />
          <h2 id="mixer-modal-title">{$t('settings.colorMixer')}</h2>
        </div>
        <button
          type="button"
          class="close-btn"
          onclick={onClose}
          aria-label={$t('settings.cancel')}
        >
          <X size={20} />
        </button>
      </div>

      <!-- Pestañas principales -->
      <div class="tabs-bar" role="tablist">
        <button
          type="button"
          role="tab"
          id="tab-armonizar"
          aria-selected={activeTab === 'armonizar'}
          aria-controls="panel-armonizar"
          class="tab-btn"
          class:active={activeTab === 'armonizar'}
          onclick={() => (activeTab = 'armonizar')}
        >
          <Wand2 size={16} />
          <span>{$t('settings.harmonizeAll')}</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-individual"
          aria-selected={activeTab === 'individual'}
          aria-controls="panel-individual"
          class="tab-btn"
          class:active={activeTab === 'individual'}
          onclick={() => (activeTab = 'individual')}
        >
          <SlidersHorizontal size={16} />
          <span>{$t('settings.mixerIndividual')}</span>
        </button>
      </div>

      <div class="modal-body">
        {#if activeTab === 'armonizar'}
          <div id="panel-armonizar" role="tabpanel" aria-labelledby="tab-armonizar" class="tab-panel">
            <h3 class="panel-subtitle">{$t('settings.harmonizeTitle')}</h3>
            <p class="section-desc">{$t('settings.harmonizeDesc')}</p>

            <!-- Paletas temáticas de la naturaleza -->
            <div class="block-section">
              <span class="block-title">{$t('settings.naturePalettes')}</span>
              <div class="presets-grid">
                {#each PALETAS_TEMATICAS as preset}
                  <button
                    type="button"
                    class="preset-card"
                    class:selected={selectedMode === preset.id}
                    onclick={() => (selectedMode = preset.id)}
                  >
                    <div class="preset-info">
                      <span class="preset-name">{$t(preset.nombreKey)}</span>
                      <span class="preset-desc">{$t(preset.descripcionKey)}</span>
                    </div>
                    <div class="preset-swatches">
                      {#each preset.colores as col}
                        <span class="preset-dot" style="background-color: {col};"></span>
                      {/each}
                    </div>
                  </button>
                {/each}
              </div>
            </div>

            <!-- Armonías cromáticas -->
            <div class="block-section">
              <span class="block-title">{$t('settings.chromaticHarmonies')}</span>
              <div class="chips-row">
                {#each ARMONIAS_CROMATICAS as armonia}
                  <button
                    type="button"
                    class="chip-armonia"
                    class:active={selectedMode === armonia.id}
                    onclick={() => (selectedMode = armonia.id)}
                  >
                    {$t(armonia.labelKey)}
                  </button>
                {/each}
              </div>

              <!-- Selector de color pivote si se elige armonía cromática -->
              {#if !esPaletaTematica(selectedMode)}
                <div class="pivot-selector">
                  <label for="input-pivot" class="pivot-label">{$t('settings.pivotColor')}:</label>
                  <div class="pivot-controls">
                    <input
                      id="input-pivot"
                      type="color"
                      bind:value={pivotColor}
                      class="color-circle-input"
                      aria-label={$t('settings.pivotColor')}
                    />
                    <div class="pivot-quick-swatches">
                      {#each categories as cat}
                        <button
                          type="button"
                          class="swatch-mini"
                          class:selected={pivotColor === cat.color}
                          style="background-color: {cat.color};"
                          onclick={() => (pivotColor = cat.color)}
                          aria-label={cat.label}
                        ></button>
                      {/each}
                    </div>
                  </div>
                </div>
              {/if}
            </div>

            <!-- Previsualización de categorías -->
            <div class="block-section">
              <span class="block-title">{$t('settings.palettePreview')}</span>
              <div class="preview-categories-list" tabindex="0" role="region" aria-label={$t('settings.palettePreview')}>
                {#each categoriasArmonizadas as catArm}
                  {@const catOrig = categories.find(c => c.id === catArm.id)}
                  <div class="preview-cat-row">
                    <span class="cat-label-text">{catOrig?.label ?? catArm.id}</span>
                    <div class="cat-colors-diff">
                      <span class="diff-tag">{$t('settings.current')}</span>
                      <span class="swatch-preview" style="background-color: {catOrig?.color ?? 'rgb(var(--gris-medio))'};"></span>
                      <span class="arrow-diff">→</span>
                      <span class="diff-tag highlight">{$t('settings.proposed')}</span>
                      <span class="swatch-preview new-swatch" style="background-color: {catArm.color};"></span>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        {:else}
          <!-- Pestaña: Mezclador Individual -->
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
        {/if}
      </div>

      <!-- Footer con botones de acción -->
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" onclick={onClose}>
          {$t('settings.cancel')}
        </button>
        {#if activeTab === 'armonizar'}
          <button type="button" class="btn btn-primary" onclick={aplicarArmonizar}>
            <Check size={18} />
            <span>{$t('settings.applyPaletteAll')}</span>
          </button>
        {:else}
          <button type="button" class="btn btn-primary" onclick={aplicarIndividual}>
            <Check size={18} />
            <span>{$t('settings.applyColorCat', { name: selectedCatObj?.label ?? '' })}</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgb(var(--velo) / 0.6);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1100;
    padding: 1rem;
  }

  .modal-content {
    background: rgb(var(--sup) / 0.96);
    border: 1px solid rgb(var(--linea) / 0.12);
    border-radius: 16px;
    width: 100%;
    max-width: 620px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 16px 40px rgb(var(--sombra) / 0.2);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.1rem 1.4rem;
    border-bottom: 1px solid rgb(var(--linea) / 0.08);
  }

  .title-with-icon {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .title-with-icon :global(.icon-brand) {
    color: rgb(var(--verde-fuerte));
  }

  .modal-header h2 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: rgb(var(--texto));
  }

  .close-btn {
    background: none;
    border: none;
    color: rgb(var(--texto-2));
    cursor: pointer;
    padding: 0.5rem;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
  }

  .close-btn:hover {
    background: rgb(var(--lavado) / 0.08);
    color: rgb(var(--texto));
  }

  /* Pestañas */
  .tabs-bar {
    display: flex;
    border-bottom: 1px solid rgb(var(--linea) / 0.08);
    background: rgb(var(--sup-2));
    padding: 0 1rem;
    gap: 0.5rem;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.2rem;
    background: none;
    border: none;
    border-bottom: 3px solid transparent;
    font-size: 0.95rem;
    font-weight: 600;
    color: rgb(var(--texto-2));
    cursor: pointer;
    min-height: 44px;
    transition: all 0.2s;
  }

  .tab-btn:hover {
    color: rgb(var(--texto));
  }

  .tab-btn.active {
    color: rgb(var(--verde-texto));
    border-bottom-color: rgb(var(--verde-fuerte));
  }

  /* Cuerpo */
  .modal-body {
    padding: 1.2rem 1.4rem;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
  }

  .panel-subtitle {
    margin: 0 0 0.2rem 0;
    font-size: 1.05rem;
    font-weight: 700;
    color: rgb(var(--texto));
  }

  .section-desc {
    margin: 0;
    font-size: 0.88rem;
    color: rgb(var(--texto-2));
    line-height: 1.4;
  }

  .block-section {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .block-title {
    font-size: 0.82rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: rgb(var(--tinta));
  }

  /* Presets */
  .presets-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 0.6rem;
  }

  .preset-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem 0.9rem;
    background: rgb(var(--sup));
    border: 1.5px solid rgb(var(--linea) / 0.1);
    border-radius: 10px;
    cursor: pointer;
    text-align: left;
    min-height: 44px;
    transition: all 0.2s;
  }

  .preset-card:hover {
    border-color: rgb(var(--verde-borde));
    background: rgb(var(--sup-2));
  }

  .preset-card.selected {
    border-color: rgb(var(--verde-fuerte));
    background: rgb(var(--verde-lavado) / 0.08);
    box-shadow: 0 0 0 1px rgb(var(--verde-fuerte));
  }

  .preset-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .preset-name {
    font-size: 0.9rem;
    font-weight: 700;
    color: rgb(var(--texto));
  }

  .preset-desc {
    font-size: 0.75rem;
    color: rgb(var(--texto-2));
  }

  .preset-swatches {
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }

  .preset-dot {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid rgb(var(--borde-blanco) / 0.4);
    box-shadow: 0 1px 3px rgb(var(--sombra) / 0.15);
  }

  /* Chips de armonía */
  .chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .chip-armonia {
    padding: 0.45rem 0.85rem;
    border-radius: 20px;
    background: rgb(var(--sup));
    border: 1px solid rgb(var(--linea) / 0.12);
    font-size: 0.82rem;
    font-weight: 600;
    color: rgb(var(--texto));
    cursor: pointer;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .chip-armonia:hover {
    border-color: rgb(var(--verde-borde));
    background: rgb(var(--sup-2));
  }

  .chip-armonia.active {
    background: rgb(var(--verde-fuerte));
    color: rgb(var(--sobre-color));
    border-color: rgb(var(--verde-fuerte));
  }

  /* Selector pivote */
  .pivot-selector {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.4rem;
    padding: 0.5rem 0.75rem;
    background: rgb(var(--sup-2));
    border-radius: 8px;
    border: 1px solid rgb(var(--linea) / 0.08);
  }

  .pivot-label {
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(var(--texto));
  }

  .pivot-controls {
    display: flex;
    align-items: center;
    gap: 0.6rem;
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

  .pivot-quick-swatches {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .swatch-mini {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    border: 1.5px solid transparent;
    cursor: pointer;
    padding: 0;
    box-shadow: 0 1px 2px rgb(var(--sombra) / 0.15);
    min-width: 34px;
    min-height: 34px;
    position: relative;
  }

  .swatch-mini::before {
    content: '';
    position: absolute;
    inset: -5px;
  }

  .swatch-mini.selected {
    border-color: rgb(var(--texto));
    transform: scale(1.15);
  }

  /* Previsualización de categorías */
  .preview-categories-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    max-height: 180px;
    overflow-y: auto;
    padding: 0.3rem;
    background: rgb(var(--sup-2));
    border-radius: 10px;
    border: 1px solid rgb(var(--linea) / 0.08);
  }

  .preview-cat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.45rem 0.75rem;
    background: rgb(var(--sup));
    border-radius: 6px;
    font-size: 0.85rem;
  }

  .cat-label-text {
    font-weight: 600;
    color: rgb(var(--texto));
  }

  .cat-colors-diff {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .diff-tag {
    font-size: 0.7rem;
    color: rgb(var(--texto-2));
  }

  .diff-tag.highlight {
    color: rgb(var(--verde-texto));
    font-weight: 600;
  }

  .swatch-preview {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    display: inline-block;
    border: 1px solid rgb(var(--linea) / 0.1);
  }

  .swatch-preview.new-swatch {
    box-shadow: 0 0 0 1.5px rgb(var(--verde-fuerte) / 0.4);
  }

  .arrow-diff {
    font-size: 0.8rem;
    color: rgb(var(--texto-2));
  }

  /* Modo individual */
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

  /* Sliders HSL */
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

  /* Sugerencias de armonía */
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

  .swatch-action.active {
    box-shadow: 0 0 0 2px rgb(var(--texto));
  }

  /* Footer */
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.4rem;
    border-top: 1px solid rgb(var(--linea) / 0.08);
    background: rgb(var(--sup-2));
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.65rem 1.25rem;
    border-radius: 8px;
    font-size: 0.92rem;
    font-weight: 600;
    cursor: pointer;
    min-height: 44px;
    border: none;
    transition: all 0.2s;
  }

  .btn-secondary {
    background: rgb(var(--sup));
    border: 1px solid rgb(var(--linea) / 0.15);
    color: rgb(var(--texto));
  }

  .btn-secondary:hover {
    background: rgb(var(--lavado) / 0.06);
  }

  .btn-primary {
    background: rgb(var(--verde-fuerte));
    color: rgb(var(--sobre-color));
  }

  .btn-primary:hover {
    filter: brightness(1.08);
  }

  @media (max-width: 600px) {
    .modal-content {
      max-height: 96vh;
    }
    .modal-footer {
      flex-direction: column-reverse;
    }
    .modal-footer .btn {
      width: 100%;
    }
  }

  @media (max-height: 520px) {
    .modal-content {
      max-height: 96dvh;
    }
    .modal-header {
      padding: 0.5rem 1rem;
    }
    .modal-footer {
      padding: 0.5rem 1rem;
    }
    .modal-body {
      padding: 0.75rem 1rem;
      gap: 0.75rem;
    }
  }
</style>
