/**
 * Acción Svelte que avisa si un elemento desborda en cada eje.
 *
 * Existe porque hay dos cosas que `CSS` no puede expresar y `bind:scrollHeight`
 * tampoco (no es un binding válido en Svelte 5):
 *  - pintar/ocultar un aviso según haya scroll real (no según el ancho del
 *    contenedor), y
 *  - poner `tabindex` SOLO cuando la región es scrolleable, que es lo que pide
 *    axe (`scrollable-region-focusable`) sin meter un tab stop inútil cuando
 *    el contenido cabe entero.
 *
 * Uso:
 *   let desborde = $state({ x: false, y: false });
 *   <div use:observarDesborde={(d) => (desborde = d)}>…</div>
 *   <div use:observarDesborde={{ onCambio: (d) => (desborde = d), observarContenido: false }}>…</div>
 *
 * Mide al montar y coalesce disparos posteriores en un `requestAnimationFrame`,
 * emitiendo solo cuando `x` o `y` cambian respecto al estado previo.
 * Con `observarContenido !== false` (defecto) instala un `MutationObserver`
 * para listas o textos dinámicos; con `observarContenido: false` observa con
 * `ResizeObserver` tanto el nodo como su primer hijo directo (si existe).
 */

export interface Desborde {
  x: boolean;
  y: boolean;
}

export type ObservarDesbordeParam =
  | ((d: Desborde) => void)
  | { onCambio: (d: Desborde) => void; observarContenido?: boolean };

export function observarDesborde(node: HTMLElement, param: ObservarDesbordeParam) {
  let onCambio = typeof param === 'function' ? param : param.onCambio;
  const observarContenido =
    typeof param === 'function' ? true : (param.observarContenido ?? true);

  let prevX: boolean | null = null;
  let prevY: boolean | null = null;
  let rafId = 0;

  const medir = () => {
    const x = node.scrollWidth > node.clientWidth + 1;
    const y = node.scrollHeight > node.clientHeight + 1;
    if (x === prevX && y === prevY) return;
    prevX = x;
    prevY = y;
    onCambio({ x, y });
  };

  const programarMedicion = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      medir();
    });
  };

  const ro = new ResizeObserver(programarMedicion);
  ro.observe(node);
  if (!observarContenido && node.firstElementChild) {
    ro.observe(node.firstElementChild);
  }

  // Contenido distinto, misma caja (una lista que crece o encoge).
  let mo: MutationObserver | null = null;
  if (observarContenido) {
    mo = new MutationObserver(programarMedicion);
    mo.observe(node, { childList: true, subtree: true, characterData: true });
  }

  medir();

  return {
    update(nextParam: ObservarDesbordeParam) {
      onCambio = typeof nextParam === 'function' ? nextParam : nextParam.onCambio;
    },
    destroy() {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      ro.disconnect();
      mo?.disconnect();
    }
  };
}
