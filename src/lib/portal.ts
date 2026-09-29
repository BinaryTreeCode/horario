/**
 * Portal mínimo a document.body para overlays `position: fixed`.
 *
 * Necesario porque un ancestro con `backdrop-filter` (`.glass-panel`) crea un
 * containing block y ancla el overlay a la sección scrolleada en vez del viewport.
 *
 * Uso: `<div class="overlay" use:portal>…</div>`
 *
 * Compatible con transiciones de Svelte (transition:fly, fade, etc.): con
 * transición declarada, Svelte remueve el nodo DESPUÉS de la animación de
 * salida y llama destroy() al final — aquí solo marcamos el nodo para no
 * duplicar la remoción. Sin transición, destroy() corre inmediatamente y
 * remove() funciona como siempre.
 */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  let removido = false;
  return {
    destroy() {
      if (!removido) {
        removido = true;
        node.remove();
      }
    }
  };
}
