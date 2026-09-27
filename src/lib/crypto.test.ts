import { describe, test, expect, beforeEach } from 'bun:test';
import { cifrarCampo, descifrarCampo, esCifrado, establecerClave, olvidarClave, tieneClave } from './crypto';

/**
 * crypto.test.ts — cifrado E2E (PBKDF2 + AES-GCM).
 * WebCrypto está disponible en bun (globalThis.crypto).
 */

describe('crypto E2E (PBKDF2 + AES-GCM)', () => {
  beforeEach(() => {
    olvidarClave();
  });

  test('establecerClave deriva y queda en memoria', async () => {
    expect(tieneClave()).toBe(false);
    await establecerClave('a@x.com', 'password-seguro');
    expect(tieneClave()).toBe(true);
  });

  test('olvidarClave limpia la memoria', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    olvidarClave();
    expect(tieneClave()).toBe(false);
  });

  test('roundtrip: cifrar → descifrar devuelve el original', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    const original = 'Rutina de la mañana: estiramientos y oración';
    const cifrado = await cifrarCampo(original);
    expect(esCifrado(cifrado)).toBe(true);
    expect(cifrado).not.toContain(original); // el plano NO viaja
    const plano = await descifrarCampo(cifrado);
    expect(plano).toBe(original);
  });

  test('roundtrip con caracteres unicode y emojis', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    const original = 'Oración 🙏 — mañana "temprano" \nsegunda línea';
    const cifrado = await cifrarCampo(original);
    expect(await descifrarCampo(cifrado)).toBe(original);
  });

  test('cifrarCampo produce IV único por llamada (nunca reutilizado)', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    const a = await cifrarCampo('mismo texto');
    const b = await cifrarCampo('mismo texto');
    expect(a).not.toBe(b); // IV distinto → ciphertext distinto
    expect(await descifrarCampo(a)).toBe('mismo texto');
    expect(await descifrarCampo(b)).toBe('mismo texto');
  });

  test('legacy: texto sin prefijo np1 pasa sin cambios (descifrar) y se cifra en el próximo push', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    const legacy = 'descripción vieja sin cifrar';
    expect(esCifrado(legacy)).toBe(false);
    expect(await descifrarCampo(legacy)).toBe(legacy); // se lee tal cual
    const cifrado = await cifrarCampo(legacy);
    expect(esCifrado(cifrado)).toBe(true); // migración al cifrar
  });

  test('vacío: cifrar/descifrar "" es identidad', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    expect(await cifrarCampo('')).toBe('');
    expect(await descifrarCampo('')).toBe('');
  });

  test('sin clave: cifrar lanza (no debe enviar nada en claro accidentalmente)', async () => {
    expect(tieneClave()).toBe(false);
    await expect(cifrarCampo('secreto')).rejects.toThrow('Sin clave E2E');
  });

  test('otra cuenta (email distinto) NO puede descifrar blobs ajenos', async () => {
    await establecerClave('ana@x.com', 'password-seguro');
    const blobDeAna = await cifrarCampo('datos de ana');
    olvidarClave();

    await establecerClave('beto@x.com', 'password-seguro'); // mismo password, otro email
    // GCM falla la autenticación → descifrarCampo propaga el error, no devuelve basura
    await expect(descifrarCampo(blobDeAna)).rejects.toThrow();
  });

  test('password incorrecto NO descifra (autenticidad GCM)', async () => {
    await establecerClave('a@x.com', 'password-correcto');
    const blob = await cifrarCampo('secreto');
    olvidarClave();

    await establecerClave('a@x.com', 'password-incorrecto');
    await expect(descifrarCampo(blob)).rejects.toThrow();
  });

  test('JSON de steps sobrevive el roundtrip (parseo intacto)', async () => {
    await establecerClave('a@x.com', 'password-seguro');
    const steps = JSON.stringify([
      { id: '1', title: 'Lavar dientes', completed: true },
      { id: '2', title: 'Vestirse', completed: false },
    ]);
    const cifrado = await cifrarCampo(steps);
    expect(JSON.parse(await descifrarCampo(cifrado))).toEqual(JSON.parse(steps));
  });
});
