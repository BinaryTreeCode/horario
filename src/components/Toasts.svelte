<script lang="ts">
  import { toasts, dismissToast } from '../lib/toast';
  import { tNow } from '../lib/i18n';
  import { CheckCircle2, AlertCircle, Info, X } from '@lucide/svelte';

  // Svelte 5: los componentes son dinámicos con una variable, sin
  // <svelte:component> (que además está deprecado). AGENTS.md lo prohíbe.
  const ICONOS = { success: CheckCircle2, error: AlertCircle, info: Info };

  /** Cierre con desvanecimiento (pedido del usuario): marca el toast saliente,
   *  anima 200ms y recién entonces lo quita de la store. El cierre visible
   *  (botón X) pasa por acá. El auto-cierre del store también: nótese que
   *  dismissToast NO se usa directo en el markup. */
  const SALIDA_MS = 200;
  let saliendo = $state(new Set<number>());

  function cerrar(id: number) {
    if (saliendo.has(id)) return; // ya animándose
    const next = new Set(saliendo);
    next.add(id);
    saliendo = next;
    setTimeout(() => {
      const fin = new Set(saliendo);
      fin.delete(id);
      saliendo = fin;
      dismissToast(id);
    }, SALIDA_MS);
  }

  // El store auto-cierra a los 2s llamando dismissToast (sin animación, pues
  // el toast ya no estaría). Para que TODA salida se desvanezca, aquí se
  // intercepta: cuando un toast aparece, se agenda SU cierre animado con 1ms
  // antes del plazo del store... en su lugar, más simple: el store ya respeta
  // duration; el nodo se mantiene hasta que el store lo quita. Animamos esa
  // remoción detectándola y reinsertándola brevemente NO — enfoque elegido:
  // el store elimina a los 2s; si el nodo aún está visible, Svelte lo desmonta
  // sin animación. Por eso el store expone dismissToast y este componente
  // ADELANTA el cierre visual: agenda cerrar(id) a duration - SALIDA_MS.
  let prevIds = new Set<number>();
  $effect(() => {
    const actuales = new Set($toasts.map(t => t.id));
    for (const t of $toasts) {
      if (!prevIds.has(t.id) && t.duration > 0) {
        // Programa el cierre ANIMADO justo antes del auto-cierre del store.
        const adelanto = Math.max(0, t.duration - SALIDA_MS);
        setTimeout(() => cerrar(t.id), adelanto);
      }
    }
    prevIds = actuales;
  });
</script>

{#if $toasts.length}
  <div class="toast-container" role="status" aria-live="polite">
    {#each $toasts as t (t.id)}
      {@const Icono = ICONOS[t.type] ?? Info}
      <div
        class="toast glass-panel toast-{t.type}"
        class:toast-out={saliendo.has(t.id)}
      >
        <Icono size={18} class="toast-icon" />
        <span class="toast-msg">{t.message}</span>
        <button
          class="toast-close"
          aria-label={tNow('confirm.close')}
          onclick={() => cerrar(t.id)}
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
    box-shadow: 0 8px 28px rgb(var(--sombra) / 0.25);
    animation: toast-in 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.2);
    border: 1px solid rgb(var(--borde-blanco) / 0.14);
  }
  .toast-success { background: rgba(46, 84, 52, 0.92); color: #eafbee; }
  .toast-error   { background: rgba(96, 34, 34, 0.94); color: #fdeaea; }
  .toast-info    { background: rgba(38, 50, 56, 0.94); color: #eceff1; }
  /* El icono viene de lucide (componente hijo): Svelte no le pone el hash de
     ambito, asi que la parte que lo selecciona debe ser :global o la regla
     nunca casa. Sin esto los tres tonos de aviso salian del color heredado. */
  :global(.toast-icon) { flex-shrink: 0; }
  .toast-success :global(.toast-icon) { color: #9ae6b4; }
  .toast-error :global(.toast-icon) { color: #f9b4b4; }
  .toast-info :global(.toast-icon) { color: #b0bec5; }
  .toast-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-line; }
  .toast-close {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 8px;
    background: rgb(var(--sobre-color) / 0.12);
    color: inherit;
    cursor: pointer;
  }
  .toast-close:hover { background: rgba(255, 255, 255, 0.22); }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(-12px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  /* Desvanecimiento de salida (pedido del usuario): 200ms de fade al cerrar. */
  @keyframes toast-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(-8px) scale(0.97); }
  }
  .toast-out { animation: toast-out 0.2s ease-in forwards; }
  @media (max-width: 480px) {
    .toast-container { top: calc(env(safe-area-inset-top, 0px) + 8px); }
    .toast { font-size: 0.88rem; }
  }
</style>
