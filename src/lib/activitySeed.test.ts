import { describe, expect, it } from 'bun:test';
import { sembrarSinPisar } from './activitySeed';

describe('sembrarSinPisar', () => {
  it('siembra el valor de la fila cuando el campo sigue como en el montaje', () => {
    expect(sembrarSinPisar('08:30', '08:30', '10:45')).toBe('10:45');
  });

  it('respeta lo que el usuario ya eligió (el bug que pisaba la elección)', () => {
    // El modal se abre con los defaults de creación y la persona elige otra cosa
    // antes de que llegue la lectura async: al llegar, la fila decía 08:30 pero
    // el campo ya valía 11:30 y ESO es lo que tiene que quedar.
    expect(sembrarSinPisar('11:30', '09:00', '08:30')).toBe('11:30');
  });

  it('un campo vacío se siembra con la fila (el modal arranca con el nombre vacío)', () => {
    // Límite conocido de comparar contra la foto: si el usuario deja el campo
    // igual que estaba (vacío) no hay forma de distinguir "no lo toqué" de "lo
    // borré", y se siembra la fila. Es el comportamiento correcto acá: el
    // nombre arranca vacío y trae el nombre real de la actividad.
    expect(sembrarSinPisar('', '', 'Desayuno')).toBe('Desayuno');
  });

  it('compara arrays por identidad: el usuario dejó una copia nueva, gana la suya', () => {
    const enMontaje = [0, 1, 2, 3, 4];
    const delUsuario = [0, 2];
    const deLaFila = [0, 1, 2, 3, 4, 5];
    expect(sembrarSinPisar(delUsuario, enMontaje, deLaFila)).toBe(delUsuario);
  });

  it('si el array sigue con la misma referencia, siembra el de la fila', () => {
    const enMontaje = [0, 1, 2, 3, 4];
    const deLaFila = [0, 1, 2];
    expect(sembrarSinPisar(enMontaje, enMontaje, deLaFila)).toBe(deLaFila);
  });

  it('un objeto null (imagen) se siembra igual que un escalar', () => {
    expect(sembrarSinPisar<string | null>(null, null, 'data:image/webp;base64,AAA')).toBe('data:image/webp;base64,AAA');
  });
});