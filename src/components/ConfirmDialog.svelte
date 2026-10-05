<script lang="ts">
  // Runes puros: evita arrastrar el runtime legacy de Svelte al bundle (~37 KB gzip).
  interface Props {
    open?: boolean;
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    /** true → botón de confirmación rojo (acciones destructivas) */
    danger?: boolean;
    onconfirm?: () => void;
    oncancel?: () => void;
  }

  // Los valores por defecto salen de i18n: antes eran literales en español y
// quedaban en español aunque el usuario estuviera en inglés.
  let {
    open = $bindable(false),
    title = tNow('confirm.defaultTitle'),
    message = '',
    confirmText = tNow('confirm.defaultOk'),
    cancelText = tNow('confirm.defaultCancel'),
    danger = false,
    onconfirm,
    oncancel,
  }: Props = $props();

  let boxEl = $state<HTMLElement | null>(null);
  let confirmBtnEl = $state<HTMLElement | null>(null);

  // El foco entra al diálogo y vuelve al elemento que lo abrió: sin esto,
  // al cerrarse el foco se perdía en el body y el teclado arrancaba de nuevo
  // desde el principio del documento.
  $effect(() => {
    if (!open) return;
    const devolver = recordarFoco();
    enfocarDialogo(boxEl, confirmBtnEl);
    return devolver;
  });

  // Escape en fase de captura: el modal de debajo lo consulta y lo deja pasar,
  // así que Esc cierra solo este diálogo (antes cerraba los dos).
  $effect(() => capturarEscape(() => open, () => close(false)));

  function close(confirmed: boolean) {
    open = false;
    if (confirmed) onconfirm?.();
    else oncancel?.();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    // El Escape ya lo gestionó el listener de captura de arriba.
    if (e.key === 'Enter') { e.stopPropagation(); close(true); }
  }
  import { portal } from '../lib/portal';
  import { atraparTab, enfocarDialogo, recordarFoco } from '../lib/focus';
  import { capturarEscape } from '../lib/dialogStack';
  import { tNow } from '../lib/i18n';

</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- Portal a body: un ancestro con backdrop-filter crea containing block y ancla este overlay fixed a la sección scrolleada en vez del viewport -->
  <div
    use:portal
    class="confirm-overlay"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && close(false)}
  >
    <div
      class="confirm-box glass-panel"
      bind:this={boxEl}
      onkeydown={e => atraparTab(boxEl, e)}
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      tabindex="-1"
    >
      <h3>{title}</h3>
      <p>{message}</p>
      <div class="confirm-actions">
        <button class="btn-confirm-cancel" onclick={() => close(false)}>{cancelText}</button>
        <button
          class="btn-confirm-ok"
          class:danger
          bind:this={confirmBtnEl}
          onclick={() => close(true)}
        >{confirmText}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 2500;
    background: rgb(var(--velo) / 0.55);
    backdrop-filter: blur(3px);
    display: grid;
    place-items: center;
    padding: 20px;
    animation: fade-in 0.15s ease;
  }
  .confirm-box {
    width: min(92vw, 400px);
    padding: 22px 24px;
    border-radius: 18px;
    border: 1px solid rgb(var(--borde-blanco) / 0.16);
    box-shadow: 0 20px 60px rgb(var(--sombra) / 0.4);
    animation: pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.15);
  }

  /* Desktop grande (≥1536px): 440px de ancho y tipografía un punto mayor —
     en ultrawide el diálogo quedaba chico frente al resto de la app. */
  @media (min-width: 1536px) {
    .confirm-box {
      width: min(92vw, 440px);
      padding: 26px 28px;
    }
    h3 {
      font-size: 1.2rem;
    }
  }
  h3 {
    margin: 0 0 10px;
    font-size: 1.12rem;
    color: rgb(var(--texto));
  }
  p {
    margin: 0 0 20px;
    font-size: 0.95rem;
    line-height: 1.5;
    color: rgb(var(--texto));
    white-space: pre-line;
  }
  .confirm-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  button {
    min-height: 44px;
    min-width: 96px;
    padding: 0 18px;
    border: none;
    border-radius: 12px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease, transform 0.1s ease;
  }
  button:active { transform: scale(0.97); }
  .btn-confirm-cancel {
    background: rgb(var(--lavado) / 0.07);
    color: rgb(var(--texto));
  }
  .btn-confirm-ok {
    background: rgb(var(--verde-fuerte));
    color: rgb(var(--texto-calido));
  }
  .btn-confirm-ok.danger {
    background: rgb(var(--rojo-solido));
    color: rgb(var(--texto-calido));
  }
  .btn-confirm-cancel:hover { background: rgb(var(--lavado) / 0.12); }
  .btn-confirm-ok:hover { filter: brightness(1.1); }
  @keyframes fade-in { from { opacity: 0; } }
  @keyframes pop-in {
    from { opacity: 0; transform: scale(0.94) translateY(8px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
</style>
