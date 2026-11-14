<script lang="ts">
  import { ShieldCheck, Eye, EyeOff } from '@lucide/svelte';
  import { t } from '../../lib/i18n';
  import { modoPrivacidad, alternarPrivacidad } from '../../lib/privacy';
</script>

<section class="settings-section data-transparency">
  <h3><ShieldCheck size={16} /> {$t('settings.dataTitle')}</h3>
  <button
    type="button"
    class="privacy-toggle"
    role="switch"
    aria-checked={$modoPrivacidad}
    onclick={alternarPrivacidad}
  >
    {#if $modoPrivacidad}<EyeOff size={16} aria-hidden="true" />{:else}<Eye size={16} aria-hidden="true" />{/if}
    <span class="menu-item-flex">{$t('header.privacy')}</span>
    <span class="privacy-estado" aria-hidden="true">{$modoPrivacidad ? '✓' : ''}</span>
  </button>
  <ul class="data-points">
    <li>{@html $t('privacy.noAccount')}</li>
    <li>{@html $t('privacy.withAccount')}</li>
    <li>{@html $t('privacy.whatWeStore')}</li>
    <li>{@html $t('privacy.youControl')}</li>
    <li>{@html $t('privacy.noFinePrint')}</li>
  </ul>
</section>

<style>
  .data-transparency {
    background: rgb(var(--verde-lavado) / 0.04);
    border: 1px solid rgb(var(--verde-borde) / 0.15);
    border-radius: 10px;
    padding: 0.85rem 1rem;
  }

  .data-transparency h3 {
    margin: 0 0 1rem 0;
    font-size: 1rem;
    border-bottom: 1px solid rgb(var(--linea) / 0.05);
    padding-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: rgb(var(--verde-texto));
  }

  .privacy-toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: 44px;
    margin: 0.6rem 0 0;
    padding: 0.55rem 0.75rem;
    border-radius: 8px;
    border: 1px solid rgb(var(--linea) / 0.4);
    background: rgb(var(--sup) / 0.5);
    color: rgb(var(--tinta));
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }

  .privacy-toggle svg {
    flex-shrink: 0;
  }

  .privacy-toggle:hover {
    border-color: rgb(var(--verde-borde) / 0.5);
  }

  .privacy-estado {
    margin-left: auto;
    color: rgb(var(--verde-fuerte));
    font-weight: 700;
  }

  .data-points {
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .data-points li {
    position: relative;
    padding-left: 1.1rem;
    font-size: 0.82rem;
    line-height: 1.45;
    color: rgb(var(--tinta));
  }

  .data-points li::before {
    content: '✓';
    position: absolute;
    left: 0;
    color: rgb(var(--verde-texto));
    font-weight: 700;
  }

  :global(.data-points strong) {
    color: rgb(var(--verde-texto));
  }

  @media (max-width: 480px) {
    .data-transparency {
      padding: 0.7rem 0.75rem;
    }
    .data-points li {
      font-size: 0.78rem;
    }
  }
</style>
