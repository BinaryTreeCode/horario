<script lang="ts">
  import { X, ListChecks, ChevronDown, ChevronUp } from '@lucide/svelte';
  import { portal } from '../lib/portal';
  import type { Activity } from '../lib/types';

  interface Props {
    activity: Activity;
    onClose: () => void;
  }

  let { activity, onClose }: Props = $props();

  let stepsOpen = $state(true);
  const hasSteps = $derived(!!activity.steps && activity.steps.length > 0);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  function handleOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Portal a body: un ancestro con backdrop-filter crea containing block y ancla este overlay fixed a la sección scrolleada en vez del viewport -->
<div class="lightbox-fullscreen" use:portal onclick={handleOverlayClick} role="dialog" aria-modal="true">
  <!-- Barra superior: fila fija — la imagen nunca pasa bajo ella -->
  <div class="lightbox-topbar">
    <div class="lightbox-title-group">
      <h3>{activity.name}</h3>
      {#if hasSteps}
        <button
          type="button"
          class="steps-toggle"
          onclick={() => stepsOpen = !stepsOpen}
          title={stepsOpen ? 'Ocultar pasos' : 'Mostrar pasos'}
        >
          <ListChecks size={14} />
          {activity.steps!.length} pasos
          {#if stepsOpen}
            <ChevronUp size={14} />
          {:else}
            <ChevronDown size={14} />
          {/if}
        </button>
      {/if}
    </div>

    <button class="close-btn" onclick={onClose} title="Cerrar (Esc)" aria-label="Cerrar">
      <X size={26} />
    </button>
  </div>

  <!-- Área de imagen: TODO el espacio libre entre la barra y el panel de
       pasos. La imagen cabe entera (contain) — nunca se solapa con la
       barra ni con el panel. Clic en el fondo o en la imagen (por burbuja)
       cierra. -->
  <div class="lightbox-stage" onclick={() => onClose()}>
    <img class="lightbox-img" src={activity.image} alt={activity.name} />
  </div>

  <!-- Panel de pasos: fila fija al final (ya no flota sobre la imagen) -->
  {#if hasSteps && stepsOpen}
    <ul class="lightbox-steps-panel">
      {#each activity.steps as step}
        <li class:done={step.completed}>{step.title}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* Cubre TODA la pantalla — columna: barra · escenario de imagen · panel
     de pasos. El padding respeta safe-area (notch/bordes redondeados) para
     que el póster no toque los bordes del dispositivo. */
  .lightbox-fullscreen {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    background: rgba(10, 14, 10, 0.94);
    backdrop-filter: blur(6px);
    z-index: 1200;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding:
      max(0.5rem, env(safe-area-inset-top, 0px))
      max(0.5rem, env(safe-area-inset-right, 0px))
      max(0.5rem, env(safe-area-inset-bottom, 0px))
      max(0.5rem, env(safe-area-inset-left, 0px));
    animation: lbFade 0.15s ease-out;
  }

  /* Escenario: todo el espacio libre entre la barra y el panel de pasos.
     min-height: 0 permite que el flex hijo se encoja (la imagen cabe
     completa con object-fit: contain, sin desbordar el flex). */
  .lightbox-stage {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: grid;
    place-items: center;
  }

  @keyframes lbFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .lightbox-img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    animation: lbZoom 0.2s ease-out;
    user-select: none;
  }

  @keyframes lbZoom {
    from { transform: scale(0.96); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }

  /* Barra superior: fila fija de la columna (flex-shrink: 0) — ya no
     flota sobre la imagen, así que el póster nunca queda bajo el título. */
  .lightbox-topbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem 1.25rem;
    background: linear-gradient(to bottom, rgba(10, 14, 10, 0.75), transparent);
    pointer-events: none; /* deja pasar clics fuera de los botones */
  }

  .lightbox-title-group {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
    pointer-events: auto;
  }

  .lightbox-topbar h3 {
    margin: 0;
    font-size: 1.1rem;
    font-family: var(--font-heading);
    color: #ffffff;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .steps-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    flex-shrink: 0;
    min-height: 44px; /* target táctil ≥44px (regla dura #5) */
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.25);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.4rem 0.75rem;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .steps-toggle:hover {
    background: rgba(255, 255, 255, 0.28);
  }

  /* Icono de cierre, siempre visible (48px: ≥44px regla dura #5) */
  .close-btn {
    pointer-events: auto;
    flex-shrink: 0;
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.25);
    backdrop-filter: blur(6px);
    color: #ffffff;
    cursor: pointer;
    border-radius: 50%;
    transition: all 0.2s;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  }

  .close-btn:hover {
    background: rgba(239, 68, 68, 0.85);
    border-color: rgba(239, 68, 68, 0.9);
    transform: scale(1.06);
  }

  /* Panel de pasos: fila fija al final de la columna — ya no cubre el
     pie del póster (antes era absolute sobre la imagen). */
  .lightbox-steps-panel {
    flex-shrink: 0;
    align-self: center;
    width: min(560px, 100%);
    max-height: 32vh;
    overflow-y: auto;
    list-style: none;
    padding: 0.9rem 1.25rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    backdrop-filter: blur(10px);
    border-radius: 16px;
    animation: lbSlideUp 0.2s ease-out;
  }

  @keyframes lbSlideUp {
    from { transform: translateY(20px); opacity: 0; }
    to   { transform: translateY(0); opacity: 1; }
  }

  .lightbox-steps-panel li {
    position: relative;
    padding: 0.3rem 0 0.3rem 1.4rem;
    font-size: 0.88rem;
    color: #f0f4f0;
  }

  .lightbox-steps-panel li::before {
    content: '○';
    position: absolute;
    left: 0.2rem;
    color: rgba(255, 255, 255, 0.55);
  }

  .lightbox-steps-panel li.done {
    color: rgba(255, 255, 255, 0.5);
    text-decoration: line-through;
  }

  .lightbox-steps-panel li.done::before {
    content: '●';
    color: #8fe38f;
  }

  @media (max-width: 640px) {
    .lightbox-topbar {
      padding: 0.5rem 0.75rem;
    }
    .lightbox-topbar h3 {
      font-size: 0.95rem;
    }
    /* .close-btn se queda en 48px también en móvil: target táctil ≥44px
       (regla dura #5 — antes bajaba a 42px). */
  }
</style>
