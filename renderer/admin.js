// ============================================================
// PackPrice · Editor de modo administrador
// ============================================================
// Funciones de renderizado puro (devuelven HTML como string),
// más mutaciones controladas del config:
//   - actualizarConfigDesdeInput  (cambio de un campo)
//   - ejecutarAccionAdmin         (añadir/eliminar fila)
//
// La orquestación (abrir/cerrar modal, login, IPC) vive en app.js.
// ============================================================

// ------------------------------------------------------------
// Parámetros: agrupados por categoría para que sean más fáciles
// de localizar. Cada grupo es una sección con título; el grupo
// "Impuestos y recargos" se resalta porque contiene IVA y los
// recargos que cambian con más frecuencia.
// ------------------------------------------------------------
const PARAMETROS_GRUPOS = [
  { titulo: 'Impuestos y recargos', highlight: true, items: [
    { key: 'iva',                  label: 'IVA aplicado',           hint: 'Decimal: 0.21 = 21%', step: 0.01, min: 0, max: 1 },
    { key: 'recargo_4xl_eur',      label: 'Recargo 4XL (€/prenda)', hint: 'Se factura al cliente', step: 0.01, min: 0 },
    { key: 'recargo_5xl_eur',      label: 'Recargo 5XL+ (€/prenda)', step: 0.01, min: 0 },
    { key: 'buffer_3xl_eur_pack',  label: 'Buffer 3XL (€/pack peña)', hint: 'Colchón interno · no se factura', step: 0.01, min: 0 }
  ]},
  { titulo: 'Mano de obra y costes', items: [
    { key: 'mo_eur_hora',          label: 'Mano de obra (€/hora)', step: 0.5, min: 0 },
    { key: 'indirectos_eur_prenda', label: 'Indirectos (€/prenda)', step: 0.01, min: 0 }
  ]},
  { titulo: 'Producción DTF', items: [
    { key: 'merma_pct',            label: 'Merma (decimal)', hint: '0.10 = 10%', step: 0.01, min: 0, max: 1 },
    { key: 'dtf_eur_metro',        label: 'DTF (€/metro)', step: 0.01, min: 0 },
    { key: 'dtf_metros_2caras',    label: 'DTF metros · 2 caras', step: 0.05, min: 0 },
    { key: 'dtf_metros_1cara',     label: 'DTF metros · 1 cara', step: 0.05, min: 0 },
    { key: 'planchado_eur_cara',   label: 'Planchado (€/cara)', step: 0.01, min: 0 }
  ]},
  { titulo: 'Tiempos y envío', items: [
    { key: 'minutos_2caras_base',  label: 'Minutos por prenda · 2 caras', step: 0.5, min: 0 },
    { key: 'minutos_1cara_base',   label: 'Minutos por prenda · 1 cara', step: 0.5, min: 0 },
    { key: 'envio_roly_eur_bulto', label: 'Envío Roly (€/bulto)', step: 0.01, min: 0 },
    { key: 'prendas_por_bulto',    label: 'Prendas por bulto', step: 1, min: 1 }
  ]}
];

// ------------------------------------------------------------
// Utilidades de escape
// ------------------------------------------------------------
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ------------------------------------------------------------
// Color por pack: deterministic — depende del índice del pack
// dentro del config para que cada pack tenga el mismo tono entre
// re-renders.
// ------------------------------------------------------------
const PACK_COLOR_TOKENS = [
  '--pack-color-1', '--pack-color-2', '--pack-color-3',
  '--pack-color-4', '--pack-color-5', '--pack-color-6'
];

export function colorTokenPack(packId, idx) {
  return PACK_COLOR_TOKENS[idx % PACK_COLOR_TOKENS.length];
}

// ============================================================
// PARÁMETROS
// ============================================================
export function renderAdminParametros(cfg) {
  let html = '<p class="hint" style="margin-bottom: 16px;">Variables que afectan al cálculo. <strong>Impuestos y recargos</strong> es el grupo que más cambia.</p>';

  for (const grupo of PARAMETROS_GRUPOS) {
    html += `<div class="admin-group">`;
    html += `<div class="admin-group__title ${grupo.highlight ? 'is-highlight' : ''}">${esc(grupo.titulo)}</div>`;
    html += '<div class="admin-grid">';
    for (const it of grupo.items) {
      const valor = cfg.parametros[it.key];
      const valorAttr = (valor === null || valor === undefined) ? '' : valor;
      const stepAttr = it.step !== undefined ? ` step="${it.step}"` : '';
      const minAttr  = it.min  !== undefined ? ` min="${it.min}"`   : '';
      const maxAttr  = it.max  !== undefined ? ` max="${it.max}"`   : '';
      html += `
        <label>${esc(it.label)}${it.hint ? ` <span class="hint">${esc(it.hint)}</span>` : ''}
          <input type="number"${stepAttr}${minAttr}${maxAttr} value="${valorAttr}" data-cfg-path="parametros.${it.key}">
        </label>
      `;
    }
    html += '</div></div>';
  }
  return html;
}

// ============================================================
// MODELOS ROLY
// ============================================================
export function renderAdminModelos(cfg) {
  let html = '<p class="hint" style="margin-bottom: 12px;">Modelos Roly que se usan como base de cada pack. No se pueden eliminar los que estén en uso.</p>';

  for (const [id, m] of Object.entries(cfg.modelos_roly)) {
    const enUso = modeloEnUso(cfg, id);
    html += `
      <div class="admin-row">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <span class="admin-row__id">${esc(id)}</span>
            <strong>${esc(m.nombre || '—')}</strong>
            ${enUso ? '<span class="badge badge--neutral" style="margin-left: 6px;">en uso</span>' : ''}
          </div>
          <button type="button" class="admin-row__remove"
                  data-accion="eliminar-modelo" data-id="${esc(id)}"
                  ${enUso ? 'disabled title="Está siendo usado por algún pack"' : 'title="Eliminar modelo"'}
                  aria-label="Eliminar modelo ${esc(id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Nombre
            <input type="text" value="${esc(m.nombre || '')}" data-cfg-path="modelos_roly.${id}.nombre">
          </label>
          <label>Referencia Roly
            <input type="text" value="${esc(m.ref || '')}" data-cfg-path="modelos_roly.${id}.ref">
          </label>
          <label>Precio base (€) <span class="hint">sin IVA, sin DTF</span>
            <input type="number" step="0.0001" min="0" value="${m.precio ?? 0}" data-cfg-path="modelos_roly.${id}.precio">
          </label>
        </div>
      </div>
    `;
  }

  html += `
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-accion="anadir-modelo">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir modelo
      </button>
    </div>
  `;
  return html;
}

// ============================================================
// TRAMOS
// ============================================================
export function renderAdminTramos(cfg) {
  let html = '<p class="hint" style="margin-bottom: 12px;">Cada tramo activa un PVP distinto en cada pack. Si añades o eliminas tramos los packs se ajustan automáticamente y mantienen los valores existentes.</p>';

  cfg.tramos.forEach((t, i) => {
    const desactivarEliminar = cfg.tramos.length <= 1;
    html += `
      <div class="admin-row">
        <div class="admin-row__head">
          <div class="admin-row__title">
            <span class="admin-row__id">${esc(t.id)}</span>
            <strong>${esc(t.etiqueta || '')}</strong>
          </div>
          <button type="button" class="admin-row__remove"
                  data-accion="eliminar-tramo" data-idx="${i}"
                  ${desactivarEliminar ? 'disabled title="Debe quedar al menos un tramo"' : 'title="Eliminar tramo"'}
                  aria-label="Eliminar tramo ${esc(t.id)}">
            <svg class="icon"><use href="#i-x"/></svg>
          </button>
        </div>
        <div class="admin-grid">
          <label>Etiqueta
            <input type="text" value="${esc(t.etiqueta || '')}" data-cfg-path="tramos.${i}.etiqueta">
          </label>
          <label>Reducción de tiempo <span class="hint">decimal · 0.10 = 10%</span>
            <input type="number" step="0.01" min="0" max="1" value="${t.reduccion_tiempo ?? 0}" data-cfg-path="tramos.${i}.reduccion_tiempo">
          </label>
          <label>Desde (uds)
            <input type="number" min="1" step="1" value="${t.desde ?? 0}" data-cfg-path="tramos.${i}.desde">
          </label>
          <label>Hasta (uds) <span class="hint">vacío = sin límite</span>
            <input type="number" min="1" step="1" value="${t.hasta === null || t.hasta === undefined ? '' : t.hasta}" data-cfg-path="tramos.${i}.hasta">
          </label>
        </div>
      </div>
    `;
  });

  html += `
    <div class="admin-row-add">
      <button type="button" class="btn btn-secondary" data-accion="anadir-tramo">
        <svg class="icon"><use href="#i-plus"/></svg> Añadir tramo
      </button>
    </div>
  `;
  return html;
}

// ============================================================
// PACKS (PVP) — cada pack con su color
// ============================================================
export function renderAdminPacks(cfg) {
  let html = '<p class="hint" style="margin-bottom: 16px;">PVP por tramo, IVA incluido. Cada pack tiene un color para localizarlo a simple vista. El pack mixto reusa los precios de los packs que referencia.</p>';

  let idx = 0;
  for (const [id, pack] of Object.entries(cfg.packs)) {
    const colorToken = colorTokenPack(id, idx);
    idx++;

    if (pack.tipo === 'mixto') {
      html += `
        <section class="admin-pack" style="--pack-color: var(${colorToken});">
          <header class="admin-pack__head">
            <span class="admin-pack__dot"></span>
            <h4>${esc(pack.nombre)}</h4>
            <span class="admin-pack__id">${esc(id)}</span>
          </header>
          <div class="admin-pack__body">
            <p class="hint">Reusa los PVP de
              <strong>${esc(pack.packs_referencia?.CLASICA || '—')}</strong> y
              <strong>${esc(pack.packs_referencia?.URBAN || '—')}</strong>.
              Si quieres cambiar precios, edítalos en sus packs originales.
            </p>
          </div>
        </section>
      `;
      continue;
    }

    html += `<section class="admin-pack" style="--pack-color: var(${colorToken});">`;
    html += `
      <header class="admin-pack__head">
        <span class="admin-pack__dot"></span>
        <h4>${esc(pack.nombre)}</h4>
        <span class="admin-pack__id">${esc(id)}</span>
      </header>
      <div class="admin-pack__body">
    `;

    if (pack.tipo === 'pena') {
      for (const cap of ['sin_capucha', 'con_capucha']) {
        for (const car of ['dos_caras', 'una_cara']) {
          const headCap = cap === 'con_capucha' ? 'Con capucha' : 'Sin capucha';
          const headCar = car === 'dos_caras' ? '2 caras' : '1 cara';
          html += `<div class="admin-mini-head">${headCap} · ${headCar}</div>`;
          html += '<div class="admin-grid">';
          for (const t of cfg.tramos) {
            const valor = pack.pvp?.[cap]?.[car]?.[t.id];
            html += `
              <label>${esc(t.id)} · ${esc(t.etiqueta || '')}
                <input type="number" step="0.01" min="0" value="${valor ?? 0}" data-cfg-path="packs.${id}.pvp.${cap}.${car}.${t.id}">
              </label>
            `;
          }
          html += '</div>';
        }
      }
    } else if (pack.tipo === 'individual') {
      for (const car of ['dos_caras', 'una_cara']) {
        const headCar = car === 'dos_caras' ? '2 caras' : '1 cara';
        html += `<div class="admin-mini-head">${headCar}</div>`;
        html += '<div class="admin-grid">';
        for (const t of cfg.tramos) {
          const valor = pack.pvp?.[car]?.[t.id];
          html += `
            <label>${esc(t.id)} · ${esc(t.etiqueta || '')}
              <input type="number" step="0.01" min="0" value="${valor ?? 0}" data-cfg-path="packs.${id}.pvp.${car}.${t.id}">
            </label>
          `;
        }
        html += '</div>';
      }
    }

    html += '</div></section>';
  }
  return html;
}

// ============================================================
// Router de pestañas
// ============================================================
export function renderAdminTabContent(cfg, tab) {
  switch (tab) {
    case 'parametros': return renderAdminParametros(cfg);
    case 'modelos':    return renderAdminModelos(cfg);
    case 'tramos':     return renderAdminTramos(cfg);
    case 'packs':      return renderAdminPacks(cfg);
    default:           return '';
  }
}

// ============================================================
// Mutaciones
// ============================================================

/**
 * Aplica al config el valor introducido en un input con data-cfg-path.
 * Distingue por tipo de input:
 *   - number → parseFloat (o null si vacío)
 *   - text   → string tal cual (sin trim para no alterar el cursor)
 *
 * @param {object} cfg
 * @param {HTMLInputElement} input
 */
export function actualizarConfigDesdeInput(cfg, input) {
  const path = input.dataset.cfgPath.split('.');
  let valor;
  if (input.type === 'text') {
    valor = input.value;
  } else if (input.type === 'number') {
    valor = input.value === '' ? null : parseFloat(input.value);
    if (Number.isNaN(valor)) valor = null;
  } else {
    valor = input.value;
  }

  let obj = cfg;
  for (let i = 0; i < path.length - 1; i++) {
    if (!(path[i] in obj)) return; // ruta inválida, no mutamos
    obj = obj[path[i]];
  }
  obj[path[path.length - 1]] = valor;
}

/**
 * Ejecuta una acción de fila (añadir/eliminar tramo o modelo).
 * Devuelve { error?: string, dirty?: boolean }; si hay error
 * el caller debe mostrarlo y NO refrescar.
 */
export function ejecutarAccionAdmin(cfg, dataset) {
  const accion = dataset.accion;

  if (accion === 'anadir-tramo')   return anadirTramo(cfg);
  if (accion === 'eliminar-tramo') return eliminarTramo(cfg, parseInt(dataset.idx, 10));
  if (accion === 'anadir-modelo')  return anadirModelo(cfg);
  if (accion === 'eliminar-modelo') return eliminarModelo(cfg, dataset.id);

  return { error: `Acción desconocida: ${accion}` };
}

// ------------------------------------------------------------
// Tramos
// ------------------------------------------------------------
function anadirTramo(cfg) {
  const tramos = cfg.tramos;
  const nuevoId = siguienteIdTramo(cfg);
  const ultimo = tramos[tramos.length - 1];

  // Si el último tenía hasta:null (abierto a infinito), lo cerramos para
  // que el nuevo continúe. Heurística: el nuevo empieza en
  // (último.hasta||último.desde)+1 y deja también hasta:null.
  let desde = 1;
  if (ultimo) {
    if (ultimo.hasta === null || ultimo.hasta === undefined) {
      desde = (ultimo.desde || 0) + 1;
      ultimo.hasta = (ultimo.desde || 0); // mantenerlo coherente; usuario reajustará
    } else {
      desde = ultimo.hasta + 1;
    }
  }

  tramos.push({
    id:               nuevoId,
    etiqueta:         `Tramo ${tramos.length + 1}`,
    desde,
    hasta:            null,
    reduccion_tiempo: ultimo ? (ultimo.reduccion_tiempo ?? 0) : 0
  });

  // Cascada: añadir entrada PVP en todos los packs no-mixto, copiando
  // los valores del último tramo previo si existían (para que el usuario
  // no parta de cero).
  for (const pack of Object.values(cfg.packs)) {
    if (pack.tipo === 'pena') {
      for (const cap of ['sin_capucha', 'con_capucha']) {
        for (const car of ['dos_caras', 'una_cara']) {
          if (!pack.pvp[cap]) pack.pvp[cap] = {};
          if (!pack.pvp[cap][car]) pack.pvp[cap][car] = {};
          const previo = ultimo ? pack.pvp[cap][car][ultimo.id] : null;
          pack.pvp[cap][car][nuevoId] = previo ?? 0;
        }
      }
    } else if (pack.tipo === 'individual') {
      for (const car of ['dos_caras', 'una_cara']) {
        if (!pack.pvp[car]) pack.pvp[car] = {};
        const previo = ultimo ? pack.pvp[car][ultimo.id] : null;
        pack.pvp[car][nuevoId] = previo ?? 0;
      }
    }
  }
  return { dirty: true };
}

function eliminarTramo(cfg, idx) {
  const tramos = cfg.tramos;
  if (tramos.length <= 1) return { error: 'Debe quedar al menos un tramo.' };
  const tramo = tramos[idx];
  if (!tramo) return { error: 'Tramo no encontrado.' };

  const ok = window.confirm(
    `¿Eliminar el tramo "${tramo.etiqueta || tramo.id}"? Se quitará el PVP correspondiente de todos los packs.`
  );
  if (!ok) return { dirty: false };

  tramos.splice(idx, 1);

  for (const pack of Object.values(cfg.packs)) {
    if (pack.tipo === 'pena') {
      for (const cap of ['sin_capucha', 'con_capucha']) {
        for (const car of ['dos_caras', 'una_cara']) {
          if (pack.pvp?.[cap]?.[car]) delete pack.pvp[cap][car][tramo.id];
        }
      }
    } else if (pack.tipo === 'individual') {
      for (const car of ['dos_caras', 'una_cara']) {
        if (pack.pvp?.[car]) delete pack.pvp[car][tramo.id];
      }
    }
  }
  return { dirty: true };
}

function siguienteIdTramo(cfg) {
  let max = 0;
  for (const t of cfg.tramos) {
    const m = /^T(\d+)$/.exec(t.id || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `T${max + 1}`;
}

// ------------------------------------------------------------
// Modelos Roly
// ------------------------------------------------------------
function anadirModelo(cfg) {
  const id = siguienteIdModelo(cfg);
  cfg.modelos_roly[id] = {
    nombre: 'Nuevo modelo',
    ref:    '',
    precio: 0
  };
  return { dirty: true };
}

function eliminarModelo(cfg, id) {
  if (!cfg.modelos_roly[id]) return { error: 'Modelo no encontrado.' };
  if (modeloEnUso(cfg, id)) {
    return { error: `El modelo ${id} está en uso por algún pack y no se puede eliminar.` };
  }
  const ok = window.confirm(`¿Eliminar el modelo ${id}?`);
  if (!ok) return { dirty: false };
  delete cfg.modelos_roly[id];
  return { dirty: true };
}

function siguienteIdModelo(cfg) {
  let n = 1;
  while (cfg.modelos_roly[`MODELO_${n}`]) n++;
  return `MODELO_${n}`;
}

/**
 * Un modelo está "en uso" si:
 *   - Algún pack tipo individual lo apunta como pack.modelo.
 *   - Es uno de los modelos hardcoded del pack peña (BEAGLE/CLASICA/URBAN),
 *     ya que calcularPackPena los referencia por nombre directamente.
 */
function modeloEnUso(cfg, id) {
  for (const p of Object.values(cfg.packs)) {
    if (p.modelo === id) return true;
  }
  if (id === 'BEAGLE' || id === 'CLASICA' || id === 'URBAN') return true;
  return false;
}
