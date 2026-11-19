<script lang="ts">
  // Runes puros: evita arrastrar el runtime legacy de Svelte al bundle (~37 KB gzip).
  interface Props {
    open?: boolean;
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    secondaryText?: string;
    /** true → botón de confirmación rojo (acciones destructivas) */
    danger?: boolean;
    onconfirm?: () => void;
    onsecondary?: () => void;
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
    secondaryText,
    danger = false,
    onconfirm,
    onsecondary,
    oncancel,
  }: Props = $props();

  let boxEl = $state<HTMLElement | null>(null);
  let confirmBtnEl = $state<HTMLElement | null>(null);

  // El MENSAJE es la zona que scrollea cuando el aviso es largo (resumen de
  // importación, duplicados). Solo es un tab stop si de verdad desborda: en un
  // mensaje corto un foco extra estorba, pero axe
  // (scrollable-region-focusable) exige que la región scrolleable sea enfocable.
  // La medición vive en lib/observarDesborde (misma que el visor de imagen).
  let msgDesborde = $state<Desborde>({ x: false, y: false });
  const msgScrolleable = $derived(msgDesborde.y);

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
  $effect(() => capturarEscape(() => open, () => close('cancel')));

  function close(accion: 'confirm' | 'secondary' | 'cancel') {
    open = false;
    if (accion === 'confirm') onconfirm?.();
    else if (accion === 'secondary') onsecondary?.();
    else oncancel?.();
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    // El Escape ya lo gestionó el listener de captura de arriba.
    if (e.key === 'Enter') { e.stopPropagation(); close('confirm'); }
  }
  import { portal } from '../lib/portal';
  import { observarDesborde, type Desborde } from '../lib/observarDesborde';
  import { atraparTab, enfocarDialogo, recordarFoco } from '../lib/focus';
  import { capturarEscape } from '../lib/dialogStack';
  import { tNow } from '../lib/i18n';

</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <!-- Portal a body: un ancestro con backdrop-filter crea containing block y ancla este overlay fixed a la sección scrolleada en vez del viewport -->
  <div
    use:portal
    class="confirm-overlay modal-overlay"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && close('cancel')}
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
      <p use:observarDesborde={(d: Desborde) => (msgDesborde = d)} tabindex={msgScrolleable ? 0 : undefined}>{message}</p>
      <div class="confirm-actions">
        <button class="btn-confirm-cancel" onclick={() => close('cancel')}>{cancelText}</button>
        {#if secondaryText}
          <button class="btn-confirm-secondary" onclick={() => close('secondary')}>{secondaryText}</button>
        {/if}
        <button
          class="btn-confirm-ok"
          class:danger
          bind:this={confirmBtnEl}
          onclick={() => close('confirm')}
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
    overscroll-behavior: contain;
    animation: fade-in 0.15s ease;
  }
  /* Columna acotada al viewport: en pantallas bajas (844x390) un aviso largo
     (medido: 787px con .confirm-box sin tope) empujaba los botones a y=783 y
     no había forma de llegar a confirmar. Ahora título y acciones son fijos y
     el que scrollea es el mensaje. */
  .confirm-box {
    width: min(92vw, 400px);
    max-height: calc(100vh - 2rem);
    max-height: calc(100dvh - 2rem);
    display: flex;
    flex-direction: column;
    overflow: hidden;
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
    flex-shrink: 0; /* el título nunca se come el scroll: siempre visible */
    margin: 0 0 10px;
    font-size: 1.12rem;
    color: rgb(var(--texto));
  }
  p {
    flex: 1 1 auto;
    min-height: 0; /* sin esto el flex item no baja del alto de su contenido */
    overflow-y: auto;
    overscroll-behavior: contain;
    /* El aire de la derecha evita que el texto toque la barra fina del tema. */
    padding-right: 4px;
    margin: 0 0 20px;
    font-size: 0.95rem;
    line-height: 1.5;
    color: rgb(var(--texto));
    white-space: pre-line;
  }
  .confirm-actions {
    flex-shrink: 0; /* las acciones quedan siempre dentro del viewport */
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: flex-end;
  }
  .btn-confirm-secondary {
    background: rgb(var(--lavado) / 0.12);
    color: rgb(var(--texto));
    border: 1px solid rgb(var(--borde-blanco) / 0.16);
  }
  .btn-confirm-secondary:hover { background: rgb(var(--lavado) / 0.2); }
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

  /* Landscape móvil / ventanas bajas: el diálogo se compacta pero los botones
     conservan los 44px (regla dura #5). */
  @media (max-height: 480px) {
    .confirm-overlay {
      padding: 10px;
    }
    .confirm-box {
      padding: 14px 18px;
    }
    h3 {
      margin-bottom: 6px;
    }
    p {
      margin-bottom: 12px;
    }
  }

  @keyframes fade-in { from { opacity: 0; } }
  @keyframes pop-in {
    from { opacity: 0; transform: scale(0.94) translateY(8px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
</style>
