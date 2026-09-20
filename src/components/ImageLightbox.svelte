<script lang="ts">
  import { X, ListChecks, ChevronDown, ChevronUp } from 'lucide-svelte';
  import type { Activity } from '../lib/types.ts';

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

<div class="lightbox-fullscreen" onclick={handleOverlayClick} role="dialog" aria-modal="true">
  <img class="lightbox-img" src={activity.image} alt={activity.name} onclick={handleOverlayClick} />

  <!-- Barra superior flotante: nombre + botón de cierre -->
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

  <!-- Panel de pasos flotante -->
  {#if hasSteps && stepsOpen}
    <ul class="lightbox-steps-panel">
      {#each activity.steps as step}
        <li class:done={step.completed}>{step.title}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* Cubre TODA la pantalla */
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
    align-items: center;
    justify-content: center;
    animation: lbFade 0.15s ease-out;
  }

  @keyframes lbFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .lightbox-img {
    display: block;
    max-width: 100vw;
    max-height: 100vh;
    max-height: 100dvh;
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

  /* Barra superior flotante */
  .lightbox-topbar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
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
    font-family: 'Outfit', sans-serif;
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
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.25);
    backdrop-filter: blur(6px);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.3rem 0.6rem;
    border-radius: 999px;
    cursor: pointer;
    transition: background 0.2s;
  }

  .steps-toggle:hover {
    background: rgba(255, 255, 255, 0.28);
  }

  /* Icono de cierre, siempre visible */
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

  /* Panel de pasos flotante abajo */
  .lightbox-steps-panel {
    position: absolute;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    margin: 0;
    width: min(560px, calc(100vw - 2rem));
    max-height: 32vh;
    overflow-y: auto;
    list-style: none;
    padding: 0.9rem 1.25rem;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-bottom: none;
    backdrop-filter: blur(10px);
    border-radius: 16px 16px 0 0;
    animation: lbSlideUp 0.2s ease-out;
  }

  @keyframes lbSlideUp {
    from { transform: translate(-50%, 20px); opacity: 0; }
    to { transform: translate(-50%, 0); opacity: 1; }
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
      padding: 0.75rem 0.85rem;
    }
    .lightbox-topbar h3 {
      font-size: 0.95rem;
    }
    .close-btn {
      width: 42px;
      height: 42px;
    }
  }
</style>
