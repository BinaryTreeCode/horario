<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let open = false;
  export let title = '¿Confirmar?';
  export let message = '';
  export let confirmText = 'Confirmar';
  export let cancelText = 'Cancelar';
  /** true → botón de confirmación rojo (acciones destructivas) */
  export let danger = false;

  const dispatch = createEventDispatcher<{ confirm: void; cancel: void }>();

  function close(confirmed: boolean) {
    open = false;
    dispatch(confirmed ? 'confirm' : 'cancel');
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    if (e.key === 'Enter') { e.stopPropagation(); close(true); }
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <div
    class="confirm-overlay"
    role="presentation"
    on:click|self={() => close(false)}
  >
    <div class="confirm-box glass-panel" role="alertdialog" aria-modal="true" aria-label={title}>
      <h3>{title}</h3>
      <p>{message}</p>
      <div class="confirm-actions">
        <button class="btn-confirm-cancel" on:click={() => close(false)}>{cancelText}</button>
        <button
          class="btn-confirm-ok"
          class:danger
          on:click={() => close(true)}
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
    background: rgba(10, 18, 12, 0.55);
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
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    animation: pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.15);
  }
  h3 {
    margin: 0 0 10px;
    font-size: 1.12rem;
    color: #1d3a24;
  }
  p {
    margin: 0 0 20px;
    font-size: 0.95rem;
    line-height: 1.5;
    color: #3c4a3f;
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
    background: rgba(0, 0, 0, 0.07);
    color: #2c3a2f;
  }
  .btn-confirm-ok {
    background: #2f6b3f;
    color: #f2f8f2;
  }
  .btn-confirm-ok.danger {
    background: #a13c3c;
    color: #fdf1f1;
  }
  .btn-confirm-cancel:hover { background: rgba(0, 0, 0, 0.12); }
  .btn-confirm-ok:hover { filter: brightness(1.1); }
  @keyframes fade-in { from { opacity: 0; } }
  @keyframes pop-in {
    from { opacity: 0; transform: scale(0.94) translateY(8px); }
    to   { opacity: 1; transform: scale(1) translateY(0); }
  }
</style>
