/**
 * Modo oscuro — tres preferencias (claro / oscuro / sistema) con una sola
 * fuente de verdad: la tabla `settings` de IndexedDB, igual que el idioma y
 * el modo privacidad, así el tema viaja en el sync LWW como el resto de los
 * ajustes.
 *
 * Por qué un atributo y no un media query: el CSS define la paleta UNA vez
 * (`:root[data-tema="oscuro"]`). La preferencia "sistema" se resuelve acá, en
 * JS, y se escribe ya translateada. Así no hay dos copias de la paleta que
 * puedan desincronizarse, y `color-scheme` sigue diciéndole al navegador que
 * los controles nativos (select, scrollbar, input de fecha) se pinten
 * oscuros sin esfuerzo.
 *
 * Antes de que hidrate hay un script en Layout.astro que lee este mismo
 * valor de localStorage (espejo, no fuente de verdad) y lo pinta en <html>:
 * sin eso, una recarga en oscuro muestra un destello blanco.
 */

import { writable, derived, get } from 'svelte/store';
import { db, now } from './db';

export type Tema = 'claro' | 'oscuro' | 'sistema';
export type TemaEfectivo = 'claro' | 'oscuro';

/** Clave de la fila en `settings` (id = key = ...). */
export const CLAVE_TEMA = 'tema';

/** Espejo para el script anti-destello del <head>. */
const ESPEJO = 'np:tema';

/**
 * Las tres preferencias con su clave de i18n. La clave va explícita (y no
 * derivada del valor) a propósito: el guard de claves muertas de i18n
 * busca literales, y una clave armada por interpolación parecería no usada.
 */
export const TEMAS: { valor: Tema; clave: string }[] = [
  { valor: 'claro', clave: 'settings.themeClaro' },
  { valor: 'oscuro', clave: 'settings.themeOscuro' },
  { valor: 'sistema', clave: 'settings.themeSistema' },
];

/** ¿El valor guardado es una preferencia válida? (basura en la BD → sistema) */
export function esTemaValido(valor: unknown): valor is Tema {
  return valor === 'claro' || valor === 'oscuro' || valor === 'sistema';
}

/**
 * Resolución pura, sin DOM: traduce la preferencia al tema que se pinta.
 * "sistema" sigue al SO; cualquier otra cosa es la preferencia misma.
 */
export function resolverTema(pref: Tema, prefiereOscuro: boolean): TemaEfectivo {
  if (pref === 'sistema') return prefiereOscuro ? 'oscuro' : 'claro';
  return pref;
}

/** Preferencia actual en memoria. */
export const tema = writable<Tema>('sistema');

/** Tema ya resuelto (reacciona a la preferencia y al SO). */
export const temaEfectivo = derived(tema, (pref) => resolverTema(pref, prefiereOscuro()));

function prefiereOscuro(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Pinta el tema en <html>. Es idempotente y segura fuera del navegador para
 * que los tests puedan importarla.
 */
export function aplicarTema(efectivo: TemaEfectivo): void {
  if (typeof document === 'undefined') return;
  const raiz = document.documentElement;
  raiz.dataset.tema = efectivo;
  // La barra del navegador en Android/iOS toma el color del <head>.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', efectivo === 'oscuro' ? '#14181a' : '#2d4a22');
}

function espejo(pref: Tema): void {
  try {
    localStorage.setItem(ESPEJO, pref);
  } catch { /* modo privado o storage lleno: se pierde el anti-destello */ }
}

/**
 * Carga la preferencia guardada y se queda escuchando: al cambiar el tema
 * del SO con la preferencia en "sistema" el atributo se repinta solo.
 */
let suscripcion: (() => void) | null = null;

export async function iniciarTema(): Promise<void> {
  let pref: Tema = 'sistema';
  try {
    const guardado = await db.settings.get(CLAVE_TEMA);
    if (esTemaValido(guardado?.value)) pref = guardado.value;
  } catch {
    pref = 'sistema';
  }
  // Una sola suscripcion repinta el DOM ante cualquier cambio del store
  // (elegirTema desde Ajustes, o este arranque): no hay dos caminos.
  if (!suscripcion) {
    suscripcion = tema.subscribe((p) => {
      espejo(p);
      aplicarTema(resolverTema(p, prefiereOscuro()));
    });
  }
  tema.set(pref);

  // Marca de arranque: el atributo ya existe antes de esto (lo pone el script
  // anti-destello del <head>), asi que sin esta marca no se puede distinguir
  // "todavia no leyo la BD" de "la BD dijo claro". La usan los tests de
  // pantalla y sirve de bandera al depurar el arranque.
  if (typeof document !== 'undefined') document.documentElement.dataset.temaListo = '1';

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const alCambiar = () => {
      if (get(tema) === 'sistema') aplicarTema(get(temaEfectivo));
    };
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', alCambiar);
    else if (typeof mq.addListener === 'function') mq.addListener(alCambiar);
  }
}

/** Cambia la preferencia y la persiste (viaja al sync como los demás ajustes). */
export async function elegirTema(nuevo: Tema): Promise<void> {
  if (!esTemaValido(nuevo)) return;
  // El store repinta el DOM (suscripcion de iniciarTema); el store se
  // actualiza aunque la escritura en la BD falle, para que el toggle nunca
  // parezca muerto.
  tema.set(nuevo);
  try {
    await db.settings.put({ id: CLAVE_TEMA, key: CLAVE_TEMA, value: nuevo, updatedAt: now() });
  } catch { /* sin BD: el tema queda solo en memoria esta sesión */ }
}

/**
 * A dónde salta el interruptor rápido: SIEMPRE al contrario de lo que se ve.
 *
 * Se decide sobre el tema EFECTIVO y no sobre la preferencia, y esa es toda la
 * diferencia entre un interruptor útil y uno que parece roto. Con la
 * preferencia en "sistema", mirar la preferencia daría "sistema → sistema"
 * (no cambiaría nada) o, peor, saltaría al ciclo y dejaría al usuario
 * encerrado en un orden de tres estados que hay que conocer de memoria. Con
 * el efectivo, cada pulsación cambia de verdad lo que está en pantalla.
 *
 * El precio consciente: desde "sistema" se sale a un tema fijo y el atajo no
 * vuelve a "sistema". Es la decisión correcta porque volver a "sistema" es un
 * acto deliberado ("quiero que siga al dispositivo"), y ese acto vive en
 * Ajustes, donde las tres opciones están una al lado de la otra.
 *
 * Es pura a propósito —la decisión vive acá y el botón solo la aplica— para
 * que el test la pueda verificar sin DOM ni IndexedDB.
 */
export function temaOpuesto(efectivo: TemaEfectivo): Tema {
  return efectivo === 'oscuro' ? 'claro' : 'oscuro';
}

/** El interruptor del header: salta al contrario de lo que se ve y lo guarda. */
export function alternarTema(): void {
  void elegirTema(temaOpuesto(get(temaEfectivo)));
}