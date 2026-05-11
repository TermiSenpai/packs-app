// ============================================================
// Tests del schema por defecto (config.default.js)
// ============================================================
// Defensa contra refactores que pierden silenciosamente claves
// estructurales que el resto de la app espera.
// ============================================================
import { describe, test, expect } from 'vitest';
import { buildDefaultConfig, VERSION, ADMIN_CLAVE_DEFAULT } from '../config.default.js';

describe('buildDefaultConfig', () => {
  test('devuelve la versión y campos meta', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.version).toBe(VERSION);
    expect(typeof cfg.fecha_actualizacion).toBe('string');
    expect(typeof cfg.modificado_por).toBe('string');
  });

  test('incluye clave admin por defecto', () => {
    expect(buildDefaultConfig().admin.clave).toBe(ADMIN_CLAVE_DEFAULT);
  });

  test('contiene los packs esperados', () => {
    const cfg = buildDefaultConfig();
    for (const id of [
      'pena_completa',
      'solo_camisetas',
      'solo_clasica',
      'solo_urban',
      'sudaderas_mixto',
      'personalizado'
    ]) {
      expect(cfg.packs[id]).toBeDefined();
    }
  });

  test('contiene los modelos Roly esperados', () => {
    const cfg = buildDefaultConfig();
    for (const id of ['BEAGLE', 'CLASICA', 'URBAN']) {
      expect(cfg.modelos_roly[id]).toBeDefined();
      expect(typeof cfg.modelos_roly[id].precio).toBe('number');
    }
  });

  test('cuatro tramos T1..T4 con T4 abierto por arriba', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.tramos).toHaveLength(4);
    expect(cfg.tramos.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'T4']);
    expect(cfg.tramos[3].hasta).toBeNull();
  });

  test('parametros incluye todos los campos numéricos críticos', () => {
    const cfg = buildDefaultConfig();
    const necesarios = [
      'mo_eur_hora', 'iva', 'merma_pct', 'indirectos_eur_prenda',
      'buffer_3xl_eur_pack', 'recargo_4xl_eur', 'recargo_5xl_eur',
      'envio_roly_eur_bulto', 'prendas_por_bulto',
      'dtf_eur_metro', 'dtf_metros_2caras', 'dtf_metros_1cara',
      'planchado_eur_cara', 'minutos_2caras_base', 'minutos_1cara_base',
      'extra_nombre_eur', 'extra_manga_corta_eur', 'extra_manga_larga_eur'
    ];
    for (const k of necesarios) {
      expect(typeof cfg.parametros[k]).toBe('number');
    }
  });

  test('cada llamada devuelve copia independiente (mutaciones no afectan)', () => {
    const a = buildDefaultConfig();
    const b = buildDefaultConfig();
    a.parametros.iva = 0.99;
    expect(b.parametros.iva).not.toBe(0.99);
  });

  test('respeta meta.modificado_por', () => {
    expect(buildDefaultConfig({ modificado_por: 'Alberto' }).modificado_por).toBe('Alberto');
  });
});
