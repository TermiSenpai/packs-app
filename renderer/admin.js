// ============================================================
// PackPrice · Editor de modo administrador
// ============================================================
// Funciones de renderizado puro (devuelven HTML como string) más
// la mutación controlada del config a partir de un input.
// La orquestación (abrir/cerrar modal, login, IPC) vive en app.js.
// ============================================================

const LABELS_PARAMETROS = {
  mo_eur_hora:           'Mano de obra (€/h por persona)',
  iva:                   'IVA (decimal, ej. 0.21)',
  merma_pct:             'Merma (decimal, ej. 0.10)',
  indirectos_eur_prenda: 'Indirectos (€/prenda)',
  buffer_3xl_eur_pack:   'Buffer 3XL (€/pack peña)',
  recargo_4xl_eur:       'Recargo 4XL (€/prenda)',
  recargo_5xl_eur:       'Recargo 5XL+ (€/prenda)',
  envio_roly_eur_bulto:  'Envío Roly (€/bulto)',
  prendas_por_bulto:     'Prendas por bulto',
  dtf_eur_metro:         'DTF (€/metro)',
  dtf_metros_2caras:     'DTF metros 2 caras',
  dtf_metros_1cara:      'DTF metros 1 cara',
  planchado_eur_cara:    'Planchado (€/cara)',
  minutos_2caras_base:   'Minutos por prenda 2 caras',
  minutos_1cara_base:    'Minutos por prenda 1 cara'
};

export function renderAdminParametros(cfg) {
  let html = '<div class="admin-grid">';
  for (const [key, lbl] of Object.entries(LABELS_PARAMETROS)) {
    html += `
      <label>${lbl}</label>
      <input type="number" step="0.01" value="${cfg.parametros[key]}" data-cfg-path="parametros.${key}">
    `;
  }
  html += '</div>';
  return html;
}

export function renderAdminModelos(cfg) {
  let html = '<div class="admin-grid">';
  for (const [k, m] of Object.entries(cfg.modelos_roly)) {
    html += `
      <label>${m.nombre} <span class="hint">(${k} · ${m.ref})</span></label>
      <input type="number" step="0.0001" value="${m.precio}" data-cfg-path="modelos_roly.${k}.precio">
    `;
  }
  html += '</div>';
  return html;
}

export function renderAdminTramos(cfg) {
  let html = '<p class="hint">Edita los rangos de cada tramo de volumen y la reducción de tiempo aplicable.</p>';
  cfg.tramos.forEach((t, i) => {
    html += `
      <div class="admin-subhead">${t.id} · ${t.etiqueta}</div>
      <div class="admin-grid">
        <label>Desde (uds)</label>
        <input type="number" value="${t.desde}" data-cfg-path="tramos.${i}.desde">
        <label>Hasta (uds, vacío = sin límite)</label>
        <input type="number" value="${t.hasta === null ? '' : t.hasta}" data-cfg-path="tramos.${i}.hasta">
        <label>Reducción de tiempo (decimal)</label>
        <input type="number" step="0.01" value="${t.reduccion_tiempo}" data-cfg-path="tramos.${i}.reduccion_tiempo">
      </div>
    `;
  });
  return html;
}

export function renderAdminPacks(cfg) {
  let html = '<p class="hint">PVP por tramo (IVA incluido). El pack mixto sudaderas usa los precios de "solo_clasica" y "solo_urban" automáticamente.</p>';

  for (const [id, pack] of Object.entries(cfg.packs)) {
    if (pack.tipo === 'mixto') continue;

    html += `<div class="admin-subhead">${pack.nombre}</div>`;

    if (pack.tipo === 'pena') {
      for (const cap of ['sin_capucha', 'con_capucha']) {
        for (const car of ['dos_caras', 'una_cara']) {
          const headCap = cap === 'con_capucha' ? 'Con capucha' : 'Sin capucha';
          const headCar = car === 'dos_caras' ? '2 caras' : '1 cara';
          html += `<div class="admin-mini-head">${headCap} · ${headCar}</div>`;
          html += '<div class="admin-grid">';
          for (const t of cfg.tramos) {
            html += `
              <label>${t.etiqueta}</label>
              <input type="number" step="0.01" value="${pack.pvp[cap][car][t.id]}" data-cfg-path="packs.${id}.pvp.${cap}.${car}.${t.id}">
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
          html += `
            <label>${t.etiqueta}</label>
            <input type="number" step="0.01" value="${pack.pvp[car][t.id]}" data-cfg-path="packs.${id}.pvp.${car}.${t.id}">
          `;
        }
        html += '</div>';
      }
    }
  }
  return html;
}

/**
 * Renderiza el contenido de una pestaña del editor admin.
 * @param {object} cfg
 * @param {'parametros'|'modelos'|'tramos'|'packs'} tab
 * @returns {string} HTML
 */
export function renderAdminTabContent(cfg, tab) {
  switch (tab) {
    case 'parametros': return renderAdminParametros(cfg);
    case 'modelos':    return renderAdminModelos(cfg);
    case 'tramos':     return renderAdminTramos(cfg);
    case 'packs':      return renderAdminPacks(cfg);
    default:           return '';
  }
}

/**
 * Aplica al config el valor introducido en un input con data-cfg-path.
 * Mutación controlada: el `cfg` se modifica en sitio.
 *
 * @param {object} cfg          configuración (se muta)
 * @param {HTMLInputElement} input
 */
export function actualizarConfigDesdeInput(cfg, input) {
  const path = input.dataset.cfgPath.split('.');
  const valor = input.value === '' ? null : parseFloat(input.value);

  let obj = cfg;
  for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
  obj[path[path.length - 1]] = valor;
}
