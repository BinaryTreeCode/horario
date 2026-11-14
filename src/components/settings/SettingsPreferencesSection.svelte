<script lang="ts">
  import { Languages } from '@lucide/svelte';
  import { idioma, cambiarIdioma, t, IDIOMAS_DISPONIBLES } from '../../lib/i18n';
  import { tema, elegirTema, TEMAS } from '../../lib/tema';
</script>

<!-- ── Idioma / Language ── -->
<section class="settings-section">
  <h3><Languages size={16} /> {$t('settings.language')}</h3>
  <div class="lang-selector" role="radiogroup" aria-label="{$t('settings.language')}">
    {#each IDIOMAS_DISPONIBLES as opt}
      <button
        class="lang-option"
        class:active={$idioma === opt.codigo}
        role="radio"
        aria-checked={$idioma === opt.codigo}
        onclick={() => cambiarIdioma(opt.codigo)}
      >
        {opt.nombre}
      </button>
    {/each}
  </div>
  <p class="lang-hint">{$t('settings.languageHint')}</p>
</section>

<!-- ── Tema / Theme ── -->
<section class="settings-section">
  <h3>{$t('settings.theme')}</h3>
  <div class="lang-selector" role="radiogroup" aria-label={$t('settings.theme')}>
    {#each TEMAS as opt}
      <button
        class="lang-option"
        class:active={$tema === opt.valor}
        role="radio"
        aria-checked={$tema === opt.valor}
        data-tema-opcion={opt.valor}
        onclick={() => elegirTema(opt.valor)}
      >
        {$t(opt.clave)}
      </button>
    {/each}
  </div>
  <p class="lang-hint">{$t('settings.themeHint')}</p>
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

  .lang-selector {
    display: flex;
    background: rgb(var(--lavado) / 0.04);
    border-radius: 10px;
    padding: 3px;
    gap: 2px;
    width: fit-content;
  }

  .lang-option {
    padding: 0.5rem 1.1rem;
    min-height: 44px;
    border: none;
    border-radius: 8px;
    background: transparent;
    font-size: 0.85rem;
    font-weight: 600;
    color: rgb(var(--texto-2));
    cursor: pointer;
    transition: all 0.2s;
  }

  .lang-option.active {
    background: rgb(var(--sup));
    color: rgb(var(--verde-texto));
    box-shadow: 0 1px 4px rgb(var(--sombra) / 0.08);
  }

  .lang-hint {
    margin: 0.4rem 0 0;
    font-size: 0.75rem;
    color: rgb(var(--texto-2));
  }
</style>
