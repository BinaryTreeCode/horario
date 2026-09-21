<script lang="ts">
  import { toasts, dismissToast } from '../lib/toast';
  import { CheckCircle2, AlertCircle, Info, X } from 'lucide-svelte';

  const icons = { success: CheckCircle2, error: AlertCircle, info: Info };
</script>

{#if $toasts.length}
  <div class="toast-container" role="status" aria-live="polite">
    {#each $toasts as t (t.id)}
      <div class="toast glass-panel toast-{t.type}">
        <svelte:component this={icons[t.type]} size={18} class="toast-icon" />
        <span class="toast-msg">{t.message}</span>
        <button
          class="toast-close"
          aria-label="Cerrar aviso"
          on:click={() => dismissToast(t.id)}
        ><X size={14} /></button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 3000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(92vw, 420px);
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 14px;
    font-size: 0.92rem;
    line-height: 1.35;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
    animation: toast-in 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    border: 1px solid rgba(255, 255, 255, 0.14);
  }
  .toast-success { background: rgba(46, 84, 52, 0.92); color: #eafbee; }
  .toast-error   { background: rgba(96, 34, 34, 0.94); color: #fdeaea; }
  .toast-info    { background: rgba(38, 50, 56, 0.94); color: #eceff1; }
  .toast-icon { flex-shrink: 0; }
  .toast-success .toast-icon { color: #9ae6b4; }
  .toast-error .toast-icon { color: #f9b4b4; }
  .toast-info .toast-icon { color: #b0bec5; }
  .toast-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-line; }
  .toast-close {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.12);
    color: inherit;
    cursor: pointer;
  }
  .toast-close:hover { background: rgba(255, 255, 255, 0.22); }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(-12px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @media (max-width: 480px) {
    .toast-container { top: calc(env(safe-area-inset-top, 0px) + 8px); }
    .toast { font-size: 0.88rem; }
  }
</style>
