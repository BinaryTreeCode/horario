<script lang="ts">
  import type { Category } from '../lib/types';
  import { X, Check, Palette, SlidersHorizontal, Wand2 } from '@lucide/svelte';
  import { t } from '../lib/i18n';
  import { capturarEscape } from '../lib/dialogStack';
  import { atraparTab, enfocarDialogo, recordarFoco } from '../lib/focus';
  import { armonizarCategorias } from '../lib/paletaCategorias';
  import ColorMixerHarmonizeTab from './color-mixer/ColorMixerHarmonizeTab.svelte';
  import ColorMixerIndividualTab from './color-mixer/ColorMixerIndividualTab.svelte';

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

  // Vista previa global de categorías armonizadas
  const categoriasArmonizadas = $derived(armonizarCategorias(categories, selectedMode, pivotColor));
  const selectedCatObj = $derived(categories.find(c => c.id === selectedCatId));

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
          <ColorMixerHarmonizeTab
            {categories}
            bind:selectedMode
            bind:pivotColor
            {categoriasArmonizadas}
          />
        {:else}
          <ColorMixerIndividualTab
            {categories}
            bind:selectedCatId
            bind:indColor
          />
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
