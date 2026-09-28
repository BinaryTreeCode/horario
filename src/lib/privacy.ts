/**
 * Modo privacidad — oculta los datos de las actividades con un desenfoque
 * (nombres, descripciones, imágenes, pasos). Pensado para mirones, capturas
 * de pantalla y sesiones compartidas: la UI sigue usable (drag incluido),
 * solo el contenido deja de ser legible.
 *
 * Diseño: store writable + persistencia en db.settings (id/key 'privacyMode'),
 * igual que el idioma. El desenfoque se aplica desde Dashboard con la clase
 * global `privacy-mode` en la raíz — el CSS vive en cada componente y global.css
 * (regla base + revelado momentáneo al enfocar/hover una tarjeta).
 *
 * Por qué store y no $state local: tanto el botón del header como los
 * componentes de vista y los modales deben reaccionar al mismo tiempo, sin
 * perforar props por cinco niveles.
 */

import { writable, get } from 'svelte/store';
import { db, now } from './db';

/** Estado del modo privacidad (off por defecto). */
export const modoPrivacidad = writable<boolean>(false);

/** Carga la preferencia guardada en IndexedDB (viaja con el sync como ajuste). */
export async function iniciarPrivacidad(): Promise<void> {
  try {
    const guardado = await db.settings.get('privacyMode');
    modoPrivacidad.set(guardado?.value === true);
  } catch {
    modoPrivacidad.set(false);
  }
}

/** Alterna el modo y persiste la preferencia. */
export async function alternarPrivacidad(): Promise<boolean> {
  const nuevo = !get(modoPrivacidad);
  modoPrivacidad.set(nuevo);
  try {
    await db.settings.put({ id: 'privacyMode', key: 'privacyMode', value: nuevo, updatedAt: now() });
  } catch { /* sin BD: el modo queda solo en memoria esta sesión */ }
  return nuevo;
}
