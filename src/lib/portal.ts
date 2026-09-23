/**
 * Portal mínimo a document.body para overlays `position: fixed`.
 *
 * Necesario porque un ancestro con `backdrop-filter` (`.glass-panel`) crea un
 * containing block y ancla el overlay a la sección scrolleada en vez del viewport.
 *
 * Uso: `<div class="overlay" use:portal>…</div>`
 */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
