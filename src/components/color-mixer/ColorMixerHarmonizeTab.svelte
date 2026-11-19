<script lang="ts">
  import type { Category } from '../../lib/types';
  import { t } from '../../lib/i18n';
  import {
    PALETAS_TEMATICAS,
    ARMONIAS_CROMATICAS,
    esPaletaTematica
  } from '../../lib/paletaCategorias';
  import { observarDesborde, type Desborde } from '../../lib/observarDesborde';

  interface Props {
    categories: Category[];
    selectedMode: string;
    pivotColor: string;
    categoriasArmonizadas: { id: string; color: string }[];
  }

  let {
    categories,
    selectedMode = $bindable(),
    pivotColor = $bindable(),
    categoriasArmonizadas
  }: Props = $props();

  // La previsualización tiene max-height 180px: solo es un tab stop cuando la
  // lista desborda de verdad (axe: scrollable-region-focusable), en vez del
  // `tabindex="0"` fijo que había incluso con dos categorías.
  let previewDesborde = $state<Desborde>({ x: false, y: false });
</script>

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
    <div
      class="preview-categories-list"
      tabindex={previewDesborde.y ? 0 : undefined}
      role="region"
      aria-label={$t('settings.palettePreview')}
      use:observarDesborde={(d: Desborde) => (previewDesborde = d)}
    >
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

<style>
  .tab-panel {
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
</style>
