/**
 * Utilidades de foco para diálogos (modal, panel de ajustes, lightbox).
 *
 * Antes esta lógica estaba copiada en cada componente, y dos de los tres
 * diálogos no la tenían: el lightbox no movía el foco al abrir, así que el
 * teclado seguía tabulando por detrás del overlay, y al cerrar el foco se
 * perdía en el body.
 *
 * `atraparTab` mantiene el foco dentro del contenedor; `recordarFoco` captura
 * el elemento que tenía el foco al abrir el diálogo y lo devuelve al cerrar,
 * que es lo que espera alguien que navegaba con teclado (y lo que evita que
 * el foco salte al principio del documento).
 */

/** Elementos que reciben foco, en el orden en que se recorren con Tab. */
const FOCALIZABLES = [
  'button:not([disabled])',
  'input:not([disabled]):not([hidden])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function elementosFocalizables(contenedor: HTMLElement): HTMLElement[] {
  return [...contenedor.querySelectorAll<HTMLElement>(FOCALIZABLES)].filter(
    el => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/**
 * Atrapa el Tab dentro de `contenedor`. Se espera usar como handler de
 * `keydown` en el propio contenedor.
 */
export function atraparTab(contenedor: HTMLElement | null | undefined, e: KeyboardEvent) {
  if (e.key !== 'Tab' || !contenedor) return;
  const focalizables = elementosFocalizables(contenedor);
  if (focalizables.length === 0) return;

  const primero = focalizables[0];
  const ultimo = focalizables[focalizables.length - 1];

  if (e.shiftKey && (document.activeElement === primero || !contenedor.contains(document.activeElement))) {
    e.preventDefault();
    ultimo.focus();
  } else if (!e.shiftKey && document.activeElement === ultimo) {
    e.preventDefault();
    primero.focus();
  }
}

/**
 * Manda el foco al diálogo al abrirlo. `preferido` recibe el foco si existe
 * (el botón de cerrar, por ejemplo); si no, el propio contenedor.
 */
export function enfocarDialogo(
  contenedor: HTMLElement | null | undefined,
  preferido?: HTMLElement | null,
) {
  if (!contenedor) return;
  const destino = preferido ?? contenedor;
  destino.focus({ preventScroll: true });
}

/**
 * Recuerda el elemento con el foco y devuelve una función que lo restaura.
 * Se usa en el cleanup de un $effect o en onDestroy: el foco vuelve a donde
 * estaba, no al body.
 */
export function recordarFoco(): () => void {
  const previo =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return () => {
    // Si el elemento sigue en el documento (no fue borrado al cerrar).
    if (previo && document.contains(previo)) {
      previo.focus({ preventScroll: true });
    }
  };
}