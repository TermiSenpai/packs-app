// ============================================================
// PackPrice · Parser y validación del config.js
// ============================================================
// Reemplaza el antiguo `vm.runInNewContext`: NUNCA ejecutamos
// código del config como JavaScript. Extraemos el literal JSON
// que sigue a `window.PACKPRICE_CONFIG = …;` y lo parseamos con
// `JSON.parse`, que es estricto y no ejecuta nada.
//
// Motivación de seguridad:
//   La documentación oficial de Node deja claro que `vm` NO es
//   una frontera de seguridad. Un `config.js` malicioso podía
//   escapar con `this.constructor.constructor('…')()` y conseguir
//   RCE en el proceso main. Como el `config.js` vive en el NAS
//   (red interna, fácilmente alcanzable) y, peor aún, el usuario
//   puede *seleccionar* un .js arbitrario desde el diálogo, esto
//   era una superficie real.
//
// El parser tolera comentarios al principio del archivo (que es
// como serializa `serializarConfig`), y usa un escáner de llaves
// con consciencia de strings. Si el archivo no parsea como JSON,
// lanza un error claro: el usuario lo ve en pantalla y o bien
// recrea el config con defaults o restaura un backup.
// ============================================================

'use strict';

const SECCIONES_REQUERIDAS = ['parametros', 'modelos_roly', 'tramos', 'packs', 'admin'];

/**
 * Extrae el objeto JSON asignado a `window.PACKPRICE_CONFIG` y lo
 * parsea con `JSON.parse`. NO ejecuta el archivo como JS.
 *
 * @param {string} contenido  texto crudo del archivo
 * @returns {object}          configuración parseada
 * @throws {Error}            si no encuentra el marcador o si el JSON es inválido
 */
function extraerJsonDeConfig(contenido) {
  if (typeof contenido !== 'string') {
    throw new Error('El contenido del config debe ser texto');
  }
  const idxMarcador = contenido.indexOf('window.PACKPRICE_CONFIG');
  if (idxMarcador === -1) {
    throw new Error('El archivo no contiene window.PACKPRICE_CONFIG');
  }
  const idxBrace = contenido.indexOf('{', idxMarcador);
  if (idxBrace === -1) {
    throw new Error('No se encuentra el objeto JSON tras window.PACKPRICE_CONFIG');
  }

  // Escáner de llaves con consciencia de strings double-quoted.
  // `JSON.stringify` solo emite double-quoted strings, y nuestro
  // serializador es JSON.stringify, así que esto es suficiente.
  let depth = 0;
  let i = idxBrace;
  let enString = false;
  let escapado = false;
  for (; i < contenido.length; i++) {
    const c = contenido[i];
    if (escapado) { escapado = false; continue; }
    if (enString) {
      if (c === '\\') { escapado = true; continue; }
      if (c === '"')  { enString = false; }
      continue;
    }
    if (c === '"') { enString = true; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) {
    throw new Error('Llaves desbalanceadas en el objeto del config');
  }
  const bloqueJson = contenido.slice(idxBrace, i);
  try {
    return JSON.parse(bloqueJson);
  } catch (err) {
    throw new Error(`Config no es JSON válido: ${err.message}`);
  }
}

/**
 * Valida que el objeto config tiene la forma mínima esperada.
 * No es exhaustivo (no comprueba cada campo de cada pack); sí
 * suficiente para detectar corrupción gruesa antes de escribir.
 *
 * @param {object} cfg
 * @throws {Error} con mensaje en español si algo falta
 */
function validarFormaConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('El config debe ser un objeto');
  }
  for (const clave of SECCIONES_REQUERIDAS) {
    if (!(clave in cfg)) {
      throw new Error(`Falta la sección "${clave}" en el config`);
    }
  }
  if (!cfg.parametros || typeof cfg.parametros !== 'object') {
    throw new Error('cfg.parametros debe ser un objeto');
  }
  if (!cfg.modelos_roly || typeof cfg.modelos_roly !== 'object') {
    throw new Error('cfg.modelos_roly debe ser un objeto');
  }
  if (!Array.isArray(cfg.tramos) || cfg.tramos.length === 0) {
    throw new Error('cfg.tramos debe ser un array no vacío');
  }
  for (const t of cfg.tramos) {
    if (typeof t.id !== 'string' || typeof t.desde !== 'number') {
      throw new Error('Cada tramo necesita id (string) y desde (número)');
    }
  }
  if (!cfg.packs || typeof cfg.packs !== 'object') {
    throw new Error('cfg.packs debe ser un objeto');
  }
  if (!cfg.admin || typeof cfg.admin !== 'object') {
    throw new Error('cfg.admin debe ser un objeto');
  }
}

/**
 * Devuelve una copia del config sin la clave admin. La
 * usamos antes de mandar el config al renderer: la verificación
 * de la clave debe ocurrir en main, no en el renderer (donde
 * DevTools puede leer `CFG.admin.clave` con un `console.log`).
 *
 * Sustituye `clave` por un flag `tiene_clave` para que el
 * renderer pueda mostrar UX coherente (p.ej. avisar si nunca se
 * configuró).
 */
function stripAdminClave(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const adminOriginal = cfg.admin || {};
  const { clave, ...resto } = adminOriginal;
  return {
    ...cfg,
    admin: {
      ...resto,
      tiene_clave: typeof clave === 'string' && clave.length > 0
    }
  };
}

/**
 * Inverso de stripAdminClave: dado un config recibido del renderer
 * (sin clave) y la clave actual conocida, reinyecta la clave para
 * persistir. Si el renderer manda una clave (caso futuro: cambio
 * de clave desde admin), respeta la nueva.
 */
function reinyectarAdminClave(cfgDelRenderer, claveActual) {
  if (!cfgDelRenderer || typeof cfgDelRenderer !== 'object') {
    throw new Error('Config inválido al reinyectar admin.clave');
  }
  const adminEntrante = cfgDelRenderer.admin || {};
  const { tiene_clave: _ignored, clave: claveDelRenderer, ...resto } = adminEntrante;
  const claveFinal = (typeof claveDelRenderer === 'string' && claveDelRenderer.length > 0)
    ? claveDelRenderer
    : claveActual;
  return {
    ...cfgDelRenderer,
    admin: { ...resto, clave: claveFinal }
  };
}

/**
 * Genera el contenido textual de config.js a partir del objeto.
 * Vivía en main.js; lo movemos aquí para poder testarlo aislado.
 */
function serializarConfig(config) {
  const json = JSON.stringify(config, null, 2);
  return `// ============================================================
// PackPrice - Configuración de la calculadora
// ============================================================
// Editado: ${new Date().toLocaleString('es-ES')}
// Modificado por: ${config.modificado_por || 'desconocido'}
//
// Este archivo es generado por la app. Edítalo solo a mano si
// estás seguro de lo que haces. La app prefiere ediciones desde
// el modo administrador.
// ============================================================

window.PACKPRICE_CONFIG = ${json};
`;
}

module.exports = {
  extraerJsonDeConfig,
  validarFormaConfig,
  stripAdminClave,
  reinyectarAdminClave,
  serializarConfig,
  SECCIONES_REQUERIDAS
};
