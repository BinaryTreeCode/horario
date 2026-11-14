import { describe, it, expect } from 'bun:test';
import { compactarDia, planearCompactacionSemanal } from './scheduleCompaction';
import type { Activity } from './types';

describe('scheduleCompaction', () => {
  const baseActividad = (id: string, start: string, end: string, days = [0]): Activity => ({
    id,
    title: `Actividad ${id}`,
    startTime: start,
    endTime: end,
    categoryId: 'cat-1',
    daysOfWeek: days
  });

  describe('compactarDia', () => {
    it('retorna lista vacía si recibe lista vacía o nula', () => {
      expect(compactarDia([], 7, 'arriba')).toEqual([]);
      expect(compactarDia([], 23, 'abajo')).toEqual([]);
    });

    it('no muta las actividades de entrada', () => {
      const entrada = [baseActividad('1', '09:00', '10:00')];
      const copia = JSON.parse(JSON.stringify(entrada));
      compactarDia(entrada, 7, 'arriba');
      expect(entrada).toEqual(copia);
    });

    it('compacta hacia arriba eliminando huecos iniciales y entre actividades', () => {
      const entrada = [
        baseActividad('1', '09:00', '10:30'), // Duración 1.5h
        baseActividad('2', '12:00', '13:00')  // Duración 1h
      ];
      const resultado = compactarDia(entrada, 7, 'arriba');

      expect(resultado).toHaveLength(2);
      expect(resultado[0].id).toBe('1');
      expect(resultado[0].startTime).toBe('07:00');
      expect(resultado[0].endTime).toBe('08:30');

      expect(resultado[1].id).toBe('2');
      expect(resultado[1].startTime).toBe('08:30');
      expect(resultado[1].endTime).toBe('09:30');
    });

    it('no mueve actividades hacia arriba si ya están pegadas al límite o antes', () => {
      const entrada = [
        baseActividad('1', '06:00', '07:30'),
        baseActividad('2', '07:30', '08:30')
      ];
      const resultado = compactarDia(entrada, 7, 'arriba');

      expect(resultado[0].startTime).toBe('06:00');
      expect(resultado[0].endTime).toBe('07:30');
      expect(resultado[1].startTime).toBe('07:30');
      expect(resultado[1].endTime).toBe('08:30');
    });

    it('compacta hacia abajo eliminando huecos finales y entre actividades', () => {
      const entrada = [
        baseActividad('1', '14:00', '15:00'), // 1h
        baseActividad('2', '16:00', '18:00')  // 2h
      ];
      const resultado = compactarDia(entrada, 22, 'abajo');

      expect(resultado).toHaveLength(2);
      // El resultado viene ordenado cronológicamente
      expect(resultado[0].id).toBe('1');
      expect(resultado[0].startTime).toBe('19:00');
      expect(resultado[0].endTime).toBe('20:00');

      expect(resultado[1].id).toBe('2');
      expect(resultado[1].startTime).toBe('20:00');
      expect(resultado[1].endTime).toBe('22:00');
    });

    it('preserva exactamente la duración de cada actividad al compactar hacia abajo', () => {
      const entrada = [
        baseActividad('1', '08:15', '09:45'), // 90 min (1.5h)
        baseActividad('2', '11:00', '12:20')  // 80 min (~1.333h)
      ];
      const resultado = compactarDia(entrada, 20, 'abajo');

      expect(resultado[1].endTime).toBe('20:00');
      expect(resultado[1].startTime).toBe('18:40');

      expect(resultado[0].endTime).toBe('18:40');
      expect(resultado[0].startTime).toBe('17:10');
    });
  });

  describe('planearCompactacionSemanal', () => {
    it('retorna arreglo vacío si no hay actividades', () => {
      expect(planearCompactacionSemanal([], 7, 'arriba')).toEqual([]);
    });

    it('retorna cambios solo para las actividades que cambiaron de horario', () => {
      const acts = [
        baseActividad('1', '07:00', '08:00', [0]), // ya en 07:00
        baseActividad('2', '10:00', '11:00', [0])  // hueco
      ];
      const cambios = planearCompactacionSemanal(acts, 7, 'arriba');
      expect(cambios).toEqual([
        { id: '2', startTime: '08:00', endTime: '09:00' }
      ]);
    });

    it('maneja actividades multi-día conservando la semántica de paso secuencial', () => {
      const acts = [
        baseActividad('1', '10:00', '11:00', [0, 1])
      ];
      const cambios = planearCompactacionSemanal(acts, 8, 'arriba');
      expect(cambios).toEqual([
        { id: '1', startTime: '08:00', endTime: '09:00' }
      ]);
    });

    it('retorna cambios hacia abajo para la semana', () => {
      const acts = [
        baseActividad('1', '10:00', '11:00', [2])
      ];
      const cambios = planearCompactacionSemanal(acts, 21, 'abajo');
      expect(cambios).toEqual([
        { id: '1', startTime: '20:00', endTime: '21:00' }
      ]);
    });
  });
});
