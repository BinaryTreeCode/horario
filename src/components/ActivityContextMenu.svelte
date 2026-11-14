<script lang="ts">
  import { portal } from '../lib/portal';
  import { t } from '../lib/i18n';
  import { Plus, Copy, Image as ImageIcon, Trash2, Pencil } from '@lucide/svelte';

  interface Props {
    x: number;
    y: number;
    emptyTimeLabel?: string | null;
    onCreateAtEmpty?: () => void;
    hasImage?: boolean;
    onViewImage?: () => void;
    onEdit?: () => void;
    onDuplicate?: () => void;
    onDelete?: () => void;
  }

  let {
    x,
    y,
    emptyTimeLabel = null,
    onCreateAtEmpty,
    hasImage = false,
    onViewImage,
    onEdit,
    onDuplicate,
    onDelete
  }: Props = $props();
</script>

<div class="custom-context-menu glass-panel" use:portal style="top: {y}px; left: {x}px">
  {#if emptyTimeLabel && onCreateAtEmpty}
    <!-- Menú de hueco vacío: crear en la hora clickeada -->
    <button onclick={onCreateAtEmpty} aria-label={$t('menu.createHere', { time: emptyTimeLabel })}>
      <Plus size={16} /> {$t('menu.createHere', { time: emptyTimeLabel })}
    </button>
  {:else}
    <!-- Menú de actividad existente -->
    {#if onEdit}
      <button onclick={onEdit} aria-label={$t('common.edit')}>
        <Pencil size={16} /> {$t('common.edit')}
      </button>
    {/if}
    {#if onDuplicate}
      <button onclick={onDuplicate} aria-label={$t('menu.duplicate')}>
        <Copy size={16} /> {$t('menu.duplicate')}
      </button>
    {/if}
    {#if hasImage && onViewImage}
      <button onclick={onViewImage}>
        <ImageIcon size={16} /> {$t('menu.viewImage')}
      </button>
    {/if}
    {#if onDelete}
      <button class="delete-btn" onclick={onDelete}>
        <Trash2 size={16} /> {$t('menu.delete')}
      </button>
    {/if}
  {/if}
</div>

<style>
  .custom-context-menu {
    position: fixed;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    padding: 0.5rem;
    min-width: 200px;
    background: rgb(var(--sup));
    border-radius: 12px;
    box-shadow: 0 10px 25px rgb(var(--sombra) / 0.15);
    border: 1px solid rgb(var(--linea) / 0.05);
    animation: fadeIn 0.1s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .custom-context-menu button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    min-height: 44px; /* regla dura #5: touch targets >= 44px */
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 500;
    color: rgb(var(--tinta));
    border-radius: 8px;
    transition: all 0.2s;
    text-align: left;
  }

  .custom-context-menu button:hover {
    background: rgb(var(--tinta) / 0.05);
    color: rgb(var(--verde-texto));
  }

  .custom-context-menu button.delete-btn {
    color: rgb(var(--rojo-texto));
    border-top: 1px solid rgb(var(--linea) / 0.05);
    margin-top: 0.25rem;
    padding-top: 0.75rem;
    border-radius: 0 0 8px 8px;
  }

  .custom-context-menu button.delete-btn:hover {
    background: rgb(var(--rojo-lavado));
  }
</style>
