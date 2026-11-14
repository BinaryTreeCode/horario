import { describe, it, expect } from 'bun:test';
import { parseTime, formatTime, format12h, textOn, getActivityColor } from './timeUtils';

describe('timeUtils - utilidades puras de tiempo y color', () => {
  describe('parseTime', () => {
    it('convierte horas y minutos a número decimal', () => {
      expect(parseTime('00:00')).toBe(0);
      expect(parseTime('08:30')).toBe(8.5);
      expect(parseTime('14:45')).toBe(14.75);
      expect(parseTime('24:00')).toBe(24);
    });
  });

  describe('formatTime', () => {
    it('formatea número decimal a HH:MM con clamping a 24:00', () => {
      expect(formatTime(0)).toBe('00:00');
      expect(formatTime(8.5)).toBe('08:30');
      expect(formatTime(14.75)).toBe('14:45');
      expect(formatTime(24)).toBe('24:00');
      expect(formatTime(25)).toBe('24:00');
    });

    it('redondea minutos enteros evitando residuos flotantes (9.999h -> 10:00)', () => {
      expect(formatTime(9.999)).toBe('10:00');
      expect(formatTime(8.001)).toBe('08:00');
    });
  });

  describe('format12h', () => {
    it('devuelve cadena vacía si no hay entrada', () => {
      expect(format12h('')).toBe('');
    });

    it('formatea correctamente mañanas (AM)', () => {
      expect(format12h('00:00')).toBe('12:00 AM');
      expect(format12h('08:30')).toBe('8:30 AM');
      expect(format12h('11:59')).toBe('11:59 AM');
    });

    it('formatea correctamente tardes y noches (PM)', () => {
      expect(format12h('12:00')).toBe('12:00 PM');
      expect(format12h('13:15')).toBe('1:15 PM');
      expect(format12h('23:45')).toBe('11:45 PM');
    });

    it('trata 24:00 como AM (medianoche final)', () => {
      expect(format12h('24:00')).toBe('12:00 AM');
    });
  });

  describe('textOn', () => {
    it('devuelve texto oscuro para colores claros (WCAG contraste)', () => {
      const claro = textOn('#7FB3D5'); // luminosidad > 0.20
      expect(claro.text).toBe('#14201a');
      expect(claro.shadow).toBe('rgba(255, 255, 255, 0.7)');
    });

    it('devuelve texto blanco para colores oscuros', () => {
      const oscuro = textOn('#2a3752'); // azul noche
      expect(oscuro.text).toBe('#ffffff');
      expect(oscuro.shadow).toBe('rgba(0, 0, 0, 0.55)');
    });

    it('devuelve fallback blanco si el hex no es válido', () => {
      const invalido = textOn('invalid');
      expect(invalido.text).toBe('#ffffff');
      expect(invalido.shadow).toBe('rgba(0, 0, 0, 0.55)');
    });
  });

  describe('getActivityColor', () => {
    const categories = [
      { id: 'trabajo', color: '#ff5500' },
      { id: 'rutina', color: '#55854f' },
    ];

    it('devuelve el color de la categoría si existe', () => {
      expect(getActivityColor('trabajo', categories)).toBe('#ff5500');
      expect(getActivityColor('rutina', categories)).toBe('#55854f');
    });

    it('devuelve fallback #999 si no existe la categoría', () => {
      expect(getActivityColor('inexistente', categories)).toBe('#999');
    });
  });
});
