// ============================================================
// Tests del parser y validador del config (lib/config-parser.js)
// ============================================================
// Especialmente importantes los tests de SEGURIDAD: el parser
// reemplaza el antiguo `vm.runInNewContext` precisamente porque
// `vm` no es una frontera de seguridad. Aquí verificamos que
// payloads maliciosos NO ejecutan código.
// ============================================================
import { describe, test, expect } from 'vitest';
import {
  extraerJsonDeConfig,
  validarFormaConfig,
  stripAdminClave,
  reinyectarAdminClave,
  serializarConfig
} from '../lib/config-parser.js';
import { buildDefaultConfig } from '../config.default.js';

describe('extraerJsonDeConfig — happy path', () => {
  test('round-trip: serializar → extraer devuelve el mismo objeto', () => {
    const original = buildDefaultConfig({ modificado_por: 'tester' });
    const texto = serializarConfig(original);
    const recuperado = extraerJsonDeConfig(texto);
    expect(recuperado).toEqual(original);
  });

  test('admite comentarios y espacio en blanco al principio', () => {
    const texto = `// comentario
// otro
window.PACKPRICE_CONFIG = ${JSON.stringify({ a: 1, b: { c: 'hola' } })};
`;
    expect(extraerJsonDeConfig(texto)).toEqual({ a: 1, b: { c: 'hola' } });
  });

  test('tolera el punto y coma final ausente', () => {
    const texto = `window.PACKPRICE_CONFIG = ${JSON.stringify({ a: 1 })}`;
    expect(extraerJsonDeConfig(texto)).toEqual({ a: 1 });
  });

  test('respeta llaves dentro de strings', () => {
    const obj = { mensaje: 'hola { mundo } { adios' };
    const texto = `window.PACKPRICE_CONFIG = ${JSON.stringify(obj)};`;
    expect(extraerJsonDeConfig(texto)).toEqual(obj);
  });

  test('respeta strings con escapes de comillas', () => {
    const obj = { mensaje: 'dijo "hola"' };
    const texto = `window.PACKPRICE_CONFIG = ${JSON.stringify(obj)};`;
    expect(extraerJsonDeConfig(texto)).toEqual(obj);
  });
});

describe('extraerJsonDeConfig — errores claros', () => {
  test('falta marcador window.PACKPRICE_CONFIG', () => {
    expect(() => extraerJsonDeConfig('var x = 1;')).toThrow(/PACKPRICE_CONFIG/);
  });

  test('no hay objeto JSON tras el marcador', () => {
    expect(() => extraerJsonDeConfig('window.PACKPRICE_CONFIG = 42;')).toThrow();
  });

  test('JSON malformado falla con mensaje útil', () => {
    expect(() => extraerJsonDeConfig('window.PACKPRICE_CONFIG = { roto: }')).toThrow();
  });

  test('llaves desbalanceadas', () => {
    expect(() => extraerJsonDeConfig('window.PACKPRICE_CONFIG = { "a": 1'))
      .toThrow(/desbalanceadas|JSON/);
  });

  test('contenido no-string', () => {
    expect(() => extraerJsonDeConfig(null)).toThrow();
    expect(() => extraerJsonDeConfig(123)).toThrow();
  });
});

describe('extraerJsonDeConfig — SEGURIDAD: no ejecuta código', () => {
  test('payload con IIFE no se ejecuta (regresión RCE)', () => {
    let efecto = false;
    // Simulamos lo que hubiera intentado: si el contenido se ejecutase
    // como JS (como hacía vm.runInNewContext), `efecto` cambiaría.
    // Con JSON.parse, esto debe fallar como JSON inválido.
    globalThis.__packprice_pwned__ = () => { efecto = true; };
    const texto = `window.PACKPRICE_CONFIG = (globalThis.__packprice_pwned__(), { admin: { clave: 'x' } });`;
    expect(() => extraerJsonDeConfig(texto)).toThrow();
    expect(efecto).toBe(false);
    delete globalThis.__packprice_pwned__;
  });

  test('payload con this.constructor.constructor no se ejecuta', () => {
    // Vector clásico de escape de vm. JSON.parse no lo entiende.
    const texto = `window.PACKPRICE_CONFIG = this.constructor.constructor('return process')();`;
    expect(() => extraerJsonDeConfig(texto)).toThrow();
  });

  test('llamada a require explícita no se ejecuta', () => {
    const texto = `window.PACKPRICE_CONFIG = require('child_process').execSync('whoami');`;
    expect(() => extraerJsonDeConfig(texto)).toThrow();
  });

  test('property en string con llave no rompe el parser', () => {
    // La cadena contiene `}` que NO debe cerrar el objeto exterior.
    const obj = { evil: '"} ; require("child_process").execSync("rm -rf /") ; ({"x":1' };
    const texto = `window.PACKPRICE_CONFIG = ${JSON.stringify(obj)};`;
    expect(extraerJsonDeConfig(texto)).toEqual(obj);
  });
});

describe('validarFormaConfig', () => {
  test('config por defecto pasa', () => {
    expect(() => validarFormaConfig(buildDefaultConfig())).not.toThrow();
  });

  test.each([
    ['parametros'],
    ['modelos_roly'],
    ['tramos'],
    ['packs'],
    ['admin']
  ])('falla si falta sección %s', (clave) => {
    const cfg = buildDefaultConfig();
    delete cfg[clave];
    expect(() => validarFormaConfig(cfg)).toThrow(new RegExp(clave));
  });

  test('rechaza tramos vacíos', () => {
    const cfg = buildDefaultConfig();
    cfg.tramos = [];
    expect(() => validarFormaConfig(cfg)).toThrow(/tramos/);
  });

  test('rechaza tramos sin id', () => {
    const cfg = buildDefaultConfig();
    cfg.tramos = [{ desde: 10 }];
    expect(() => validarFormaConfig(cfg)).toThrow(/tramo/);
  });

  test('rechaza objetos no-objeto', () => {
    expect(() => validarFormaConfig(null)).toThrow();
    expect(() => validarFormaConfig([])).toThrow();
    expect(() => validarFormaConfig('string')).toThrow();
  });
});

describe('stripAdminClave', () => {
  test('elimina la clave y deja flag tiene_clave', () => {
    const cfg = buildDefaultConfig();
    expect(cfg.admin.clave).toBeTruthy();
    const stripped = stripAdminClave(cfg);
    expect(stripped.admin.clave).toBeUndefined();
    expect(stripped.admin.tiene_clave).toBe(true);
    // No mutar el original
    expect(cfg.admin.clave).toBeTruthy();
  });

  test('tiene_clave=false si no había clave', () => {
    const cfg = buildDefaultConfig();
    cfg.admin.clave = '';
    expect(stripAdminClave(cfg).admin.tiene_clave).toBe(false);
  });

  test('inputs raros no rompen', () => {
    expect(stripAdminClave(null)).toBe(null);
    expect(stripAdminClave({}).admin.tiene_clave).toBe(false);
  });
});

describe('reinyectarAdminClave', () => {
  test('reinyecta la clave actual cuando el renderer no manda nueva', () => {
    const cfg = buildDefaultConfig();
    const stripped = stripAdminClave(cfg);
    const restaurado = reinyectarAdminClave(stripped, 'clave-disco');
    expect(restaurado.admin.clave).toBe('clave-disco');
    expect(restaurado.admin.tiene_clave).toBeUndefined();
  });

  test('si el renderer manda clave nueva, se respeta', () => {
    const stripped = stripAdminClave(buildDefaultConfig());
    stripped.admin.clave = 'nueva';
    const r = reinyectarAdminClave(stripped, 'antigua');
    expect(r.admin.clave).toBe('nueva');
  });

  test('rechaza inputs no-objeto', () => {
    expect(() => reinyectarAdminClave(null, 'x')).toThrow();
  });
});

describe('serializarConfig', () => {
  test('produce un archivo que vuelve a parsearse', () => {
    const cfg = buildDefaultConfig({ modificado_por: 'X' });
    const txt = serializarConfig(cfg);
    expect(txt).toContain('window.PACKPRICE_CONFIG');
    expect(extraerJsonDeConfig(txt)).toEqual(cfg);
  });
});
