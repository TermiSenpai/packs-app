'use strict';

// ============================================================
// FuzFuz Calculadora · Renderer
// ============================================================
// Comunicación con el filesystem vía window.fuzfuz (preload.js).
// La lógica de cálculo es la misma de la V1 web.
// ============================================================

// ============================================================
// Estado global
// ============================================================
let CFG = null;                    // configuración actual
let SETTINGS = null;                // ruta_config + nombre_usuario
let infoConfigAlAbrirAdmin = null;  // mtime + hash al entrar en modo admin (para detectar conflictos)
let CFG_BACKUP = null;              // copia para "Cancelar cambios"

const estado = {
  packId: null,
  esAdmin: false,
  adminTab: 'parametros'
};

// ============================================================
// Utilidades
// ============================================================

function el(id) { return document.getElementById(id); }
function show(id) { el(id).classList.remove('hidden'); }
function hide(id) { el(id).classList.add('hidden'); }

function fmtEur(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return num.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function fmtPct(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return (num * 100).toFixed(1) + ' %';
}
function intDe(id) { return parseInt(el(id).value, 10) || 0; }

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ============================================================
// Lógica de cálculo (misma que V1)
// ============================================================

function getTramo(cantidad) {
  for (const t of CFG.tramos) {
    const cumpleMin = cantidad >= t.desde;
    const cumpleMax = (t.hasta === null) || (cantidad <= t.hasta);
    if (cumpleMin && cumpleMax) return t;
  }
  return null;
}

function calcularCostePrenda(modeloId, caras, tramo, totalPrendasParaEnvio) {
  const m = CFG.modelos_roly[modeloId];
  const p = CFG.parametros;

  const baseRoly = m.precio;
  const dtfMetros = (caras === 2) ? p.dtf_metros_2caras : p.dtf_metros_1cara;
  const dtf = dtfMetros * p.dtf_eur_metro;
  const planchado = caras * p.planchado_eur_cara;

  const numBultos = Math.ceil(totalPrendasParaEnvio / p.prendas_por_bulto);
  const envioPorPrenda = (numBultos * p.envio_roly_eur_bulto) / totalPrendasParaEnvio;

  const subtotalPreMerma = baseRoly + envioPorPrenda + dtf + planchado;
  const merma = subtotalPreMerma * p.merma_pct;

  const minutosBase = (caras === 2) ? p.minutos_2caras_base : p.minutos_1cara_base;
  const minutosReal = minutosBase * (1 - tramo.reduccion_tiempo);
  const mo = (minutosReal / 60) * p.mo_eur_hora;

  const indirectos = p.indirectos_eur_prenda;

  return {
    total: baseRoly + envioPorPrenda + dtf + planchado + merma + mo + indirectos
  };
}

function calcularPackPena(opt) {
  const { cantidad, capucha, caras, cant_4xl, cant_5xl } = opt;
  const pack = CFG.packs.pena_completa;

  if (cantidad < pack.min) {
    return { error: `Mínimo ${pack.min} packs para "${pack.nombre}".` };
  }

  const tramo = getTramo(cantidad);
  const carasKey = (caras === 2) ? 'dos_caras' : 'una_cara';
  const capuchaKey = (capucha === 'con') ? 'con_capucha' : 'sin_capucha';
  const pvpUnit = pack.pvp[capuchaKey][carasKey][tramo.id];

  const totalPrendas = cantidad * 2;
  const sudaderaModelo = (capucha === 'con') ? 'URBAN' : 'CLASICA';
  const costeCamiseta = calcularCostePrenda('BEAGLE', caras, tramo, totalPrendas);
  const costeSudadera = calcularCostePrenda(sudaderaModelo, caras, tramo, totalPrendas);
  const buffer3xl = CFG.parametros.buffer_3xl_eur_pack;
  const costePack = costeCamiseta.total + costeSudadera.total + buffer3xl;

  return calcularTotales({
    pack: pack.nombre, tramo: tramo.etiqueta, cantidad,
    pvp_unitario: pvpUnit, coste_unitario: costePack,
    cant_4xl, cant_5xl,
    detalle_extra: { capucha: capuchaKey, caras }
  });
}

function calcularPackIndividual(packId, opt) {
  const { cantidad, caras, cant_4xl, cant_5xl } = opt;
  const pack = CFG.packs[packId];

  if (cantidad < pack.min) {
    return { error: `Mínimo ${pack.min} unidades para "${pack.nombre}".` };
  }

  const tramo = getTramo(cantidad);
  const carasKey = (caras === 2) ? 'dos_caras' : 'una_cara';
  const pvpUnit = pack.pvp[carasKey][tramo.id];

  const costeUnit = calcularCostePrenda(pack.modelo, caras, tramo, cantidad);

  return calcularTotales({
    pack: pack.nombre, tramo: tramo.etiqueta, cantidad,
    pvp_unitario: pvpUnit, coste_unitario: costeUnit.total,
    cant_4xl, cant_5xl,
    detalle_extra: { modelo: pack.modelo, caras }
  });
}

function calcularPackMixto(opt) {
  const { cant_clasica, cant_urban, caras, cant_4xl, cant_5xl } = opt;
  const pack = CFG.packs.sudaderas_mixto;
  const total = cant_clasica + cant_urban;

  if (total < pack.min_total) {
    return { error: `Mínimo ${pack.min_total} sudaderas en total.` };
  }
  if (cant_clasica === 0 && cant_urban === 0) {
    return { error: 'Indica al menos una cantidad mayor que cero.' };
  }

  const tramo = getTramo(total);
  const carasKey = (caras === 2) ? 'dos_caras' : 'una_cara';

  const pvpClasica = CFG.packs[pack.packs_referencia.CLASICA].pvp[carasKey][tramo.id];
  const pvpUrban   = CFG.packs[pack.packs_referencia.URBAN].pvp[carasKey][tramo.id];

  const subtotal = (cant_clasica * pvpClasica) + (cant_urban * pvpUrban);
  const recargos = (cant_4xl * CFG.parametros.recargo_4xl_eur)
                 + (cant_5xl * CFG.parametros.recargo_5xl_eur);
  const totalIvaInc = subtotal + recargos;

  const costeClasica = calcularCostePrenda('CLASICA', caras, tramo, total);
  const costeUrban   = calcularCostePrenda('URBAN', caras, tramo, total);
  const costeTotal = (cant_clasica * costeClasica.total) + (cant_urban * costeUrban.total);

  const baseVenta = totalIvaInc / (1 + CFG.parametros.iva);
  const iva = totalIvaInc - baseVenta;
  const margen = baseVenta - costeTotal;
  const margenPct = totalIvaInc > 0 ? (margen / totalIvaInc) : 0;

  return {
    pack: pack.nombre, tramo: tramo.etiqueta, es_mixto: true,
    cantidad_total: total, cant_4xl, cant_5xl, caras,
    desglose: [
      { modelo: 'CLASICA', nombre: CFG.modelos_roly.CLASICA.nombre, cantidad: cant_clasica, pvp: pvpClasica, subtotal: cant_clasica * pvpClasica },
      { modelo: 'URBAN',   nombre: CFG.modelos_roly.URBAN.nombre,   cantidad: cant_urban,   pvp: pvpUrban,   subtotal: cant_urban * pvpUrban }
    ],
    subtotal, recargos, total_iva_inc: totalIvaInc, base_venta: baseVenta, iva,
    coste_total: costeTotal, margen, margen_pct: margenPct
  };
}

function calcularTotales(datos) {
  const subtotal = datos.cantidad * datos.pvp_unitario;
  const recargos = (datos.cant_4xl * CFG.parametros.recargo_4xl_eur)
                 + (datos.cant_5xl * CFG.parametros.recargo_5xl_eur);
  const totalIvaInc = subtotal + recargos;
  const baseVenta = totalIvaInc / (1 + CFG.parametros.iva);
  const iva = totalIvaInc - baseVenta;
  const costeTotal = datos.cantidad * datos.coste_unitario;
  const margen = baseVenta - costeTotal;
  const margenPct = totalIvaInc > 0 ? (margen / totalIvaInc) : 0;

  return {
    pack: datos.pack, tramo: datos.tramo, cantidad: datos.cantidad,
    pvp_unitario: datos.pvp_unitario, cant_4xl: datos.cant_4xl, cant_5xl: datos.cant_5xl,
    subtotal, recargos, total_iva_inc: totalIvaInc, base_venta: baseVenta, iva,
    coste_unitario: datos.coste_unitario, coste_total: costeTotal,
    margen, margen_pct: margenPct,
    extra: datos.detalle_extra
  };
}

// ============================================================
// Arranque: decidir pantalla a mostrar
// ============================================================

async function arrancar() {
  SETTINGS = await window.fuzfuz.leerSettings();

  if (!SETTINGS || !SETTINGS.ruta_config || !SETTINGS.nombre_usuario) {
    mostrarBienvenida();
    return;
  }

  await cargarConfigYMostrarApp();
}

function mostrarBienvenida() {
  hide('pantalla-app');
  hide('pantalla-error');
  show('pantalla-bienvenida');

  // Sugerencia de ruta por defecto
  el('bv-ruta').value = 'Z:\\Packs\\config.js';

  el('btn-bv-explorar').addEventListener('click', async () => {
    const r = await window.fuzfuz.seleccionarConfig();
    if (!r.cancelado) {
      el('bv-ruta').value = r.ruta;
      validarFormBienvenida();
    }
  });

  el('bv-nombre').addEventListener('input', validarFormBienvenida);
  el('bv-ruta').addEventListener('input', validarFormBienvenida);

  el('btn-bv-empezar').addEventListener('click', empezarPrimeraVez);
}

function validarFormBienvenida() {
  const nombre = el('bv-nombre').value.trim();
  const ruta = el('bv-ruta').value.trim();
  el('btn-bv-empezar').disabled = !(nombre && ruta);
}

async function empezarPrimeraVez() {
  const nombre = el('bv-nombre').value.trim();
  const ruta = el('bv-ruta').value.trim();

  // Validar que el archivo se puede leer antes de guardar settings
  const r = await window.fuzfuz.leerConfig(ruta);
  if (!r.ok) {
    el('bv-error').textContent = `No se pudo leer el archivo: ${r.error}`;
    show('bv-error');
    return;
  }

  SETTINGS = { ruta_config: ruta, nombre_usuario: nombre };
  const guardado = await window.fuzfuz.guardarSettings(SETTINGS);
  if (!guardado.ok) {
    el('bv-error').textContent = `No se pudo guardar la configuración local: ${guardado.error}`;
    show('bv-error');
    return;
  }

  hide('pantalla-bienvenida');
  await cargarConfigYMostrarApp();
}

async function cargarConfigYMostrarApp() {
  const r = await window.fuzfuz.leerConfig(SETTINGS.ruta_config);
  if (!r.ok) {
    mostrarPantallaError(r.error);
    return;
  }

  CFG = r.config;
  hide('pantalla-bienvenida');
  hide('pantalla-error');
  show('pantalla-app');
  inicializarApp();
}

function mostrarPantallaError(detalle) {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  show('pantalla-error');
  el('error-detalle').textContent = detalle;

  el('btn-error-reintentar').onclick = async () => {
    await cargarConfigYMostrarApp();
  };
  el('btn-error-cambiar-ruta').onclick = async () => {
    const r = await window.fuzfuz.seleccionarConfig();
    if (!r.cancelado) {
      SETTINGS.ruta_config = r.ruta;
      await window.fuzfuz.guardarSettings(SETTINGS);
      await cargarConfigYMostrarApp();
    }
  };
}

// ============================================================
// Inicialización de la app principal
// ============================================================

function inicializarApp() {
  // Cabecera
  el('info-usuario').textContent = SETTINGS.nombre_usuario;
  el('info-fecha-cfg').textContent = CFG.fecha_actualizacion || 'sin fecha';
  el('cfg-version').textContent = CFG.version || '?';
  el('cfg-modificado-por').textContent = CFG.modificado_por || '-';

  // Sustituir spans con valores de config
  document.querySelectorAll('[data-cfg]').forEach(span => {
    const key = span.dataset.cfg;
    if (CFG.parametros[key] !== undefined) {
      span.textContent = CFG.parametros[key];
    }
  });

  // Render lista de packs
  renderListaPacks();

  // Eventos (sólo una vez)
  if (!inicializarApp._inicializado) {
    bindearEventos();
    inicializarApp._inicializado = true;
  }
}

function bindearEventos() {
  el('btn-calcular').addEventListener('click', ejecutarCalculo);
  el('btn-reset').addEventListener('click', resetear);
  el('btn-cambiar-pack').addEventListener('click', volverASeleccion);

  el('btn-recargar').addEventListener('click', recargarConfig);
  el('btn-ajustes').addEventListener('click', abrirAjustes);

  el('btn-admin-toggle').addEventListener('click', abrirAdmin);
  el('btn-cerrar-admin').addEventListener('click', cerrarAdmin);
  el('btn-admin-login').addEventListener('click', loginAdmin);
  el('admin-clave').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loginAdmin();
  });
  el('btn-guardar-config').addEventListener('click', guardarConfigEnNAS);
  el('btn-cancelar-admin').addEventListener('click', cancelarCambiosAdmin);

  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => renderAdminTab(tab.dataset.tab));
  });

  el('admin-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'admin-overlay') cerrarAdmin();
  });

  // Modal ajustes
  el('btn-cerrar-ajustes').addEventListener('click', cerrarAjustes);
  el('btn-aj-cancelar').addEventListener('click', cerrarAjustes);
  el('btn-aj-guardar').addEventListener('click', guardarAjustes);
  el('btn-aj-explorar').addEventListener('click', async () => {
    const r = await window.fuzfuz.seleccionarConfig();
    if (!r.cancelado) {
      el('aj-ruta').value = r.ruta;
    }
  });
  el('ajustes-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'ajustes-overlay') cerrarAjustes();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cerrarAdmin();
      cerrarAjustes();
    }
  });
}

// ============================================================
// UI: selección de pack
// ============================================================

function renderListaPacks() {
  const container = el('lista-packs');
  container.innerHTML = '';

  for (const [id, pack] of Object.entries(CFG.packs)) {
    const minTexto = pack.tipo === 'mixto'
      ? `Mín. ${pack.min_total} unidades en total`
      : `Mín. ${pack.min} unidades`;

    const btn = document.createElement('button');
    btn.className = 'pack-option';
    btn.dataset.packId = id;
    btn.innerHTML = `
      <span class="pack-nombre">${pack.nombre}</span>
      <span class="pack-min">${minTexto}</span>
    `;
    btn.addEventListener('click', () => seleccionarPack(id));
    container.appendChild(btn);
  }
}

function seleccionarPack(packId) {
  estado.packId = packId;
  hide('seccion-resultado');
  hide('error-msg');

  const pack = CFG.packs[packId];
  el('pack-titulo').textContent = `2. ${pack.nombre}`;

  renderInputsPack(packId);
  show('seccion-paso2');
  el('seccion-paso2').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderInputsPack(packId) {
  const pack = CFG.packs[packId];
  const container = el('inputs-pack');

  if (pack.tipo === 'pena') {
    container.innerHTML = `
      <div class="input-row">
        <label>Cantidad de packs <span class="hint">(mín. ${pack.min})</span>
          <input type="number" id="in_cantidad" min="${pack.min}" value="${pack.min}">
        </label>
      </div>
      <div class="input-row radio-group">
        <strong>Sudadera:</strong>
        <label><input type="radio" name="capucha" value="sin" checked> Sin capucha</label>
        <label><input type="radio" name="capucha" value="con"> Con capucha</label>
      </div>
      <div class="input-row radio-group">
        <strong>Caras estampadas:</strong>
        <label><input type="radio" name="caras" value="2" checked> 2 caras (pecho + espalda)</label>
        <label><input type="radio" name="caras" value="1"> 1 cara (pecho o espalda)</label>
      </div>
    `;
  } else if (pack.tipo === 'individual') {
    const m = CFG.modelos_roly[pack.modelo];
    container.innerHTML = `
      <div class="input-row">
        <label>Cantidad de ${m.nombre.toLowerCase()}s <span class="hint">(mín. ${pack.min})</span>
          <input type="number" id="in_cantidad" min="${pack.min}" value="${pack.min}">
        </label>
      </div>
      <div class="input-row radio-group">
        <strong>Caras estampadas:</strong>
        <label><input type="radio" name="caras" value="2" checked> 2 caras</label>
        <label><input type="radio" name="caras" value="1"> 1 cara</label>
      </div>
    `;
  } else if (pack.tipo === 'mixto') {
    container.innerHTML = `
      <div class="input-row">
        <label>Sudaderas SIN capucha <span class="hint">(CLASICA)</span>
          <input type="number" id="in_cant_clasica" min="0" value="0">
        </label>
        <label>Sudaderas CON capucha <span class="hint">(URBAN)</span>
          <input type="number" id="in_cant_urban" min="0" value="0">
        </label>
      </div>
      <p class="hint">Total mínimo: ${pack.min_total} sudaderas. Cada sudadera se factura a su precio según el tramo del total.</p>
      <div class="input-row radio-group">
        <strong>Caras estampadas:</strong>
        <label><input type="radio" name="caras" value="2" checked> 2 caras</label>
        <label><input type="radio" name="caras" value="1"> 1 cara</label>
      </div>
    `;
  }
}

function recogerInputs() {
  const pack = CFG.packs[estado.packId];
  const cant_4xl = intDe('cant_4xl');
  const cant_5xl = intDe('cant_5xl');

  if (pack.tipo === 'pena') {
    return {
      cantidad: intDe('in_cantidad'),
      capucha: document.querySelector('input[name="capucha"]:checked').value,
      caras: parseInt(document.querySelector('input[name="caras"]:checked').value, 10),
      cant_4xl, cant_5xl
    };
  }
  if (pack.tipo === 'individual') {
    return {
      cantidad: intDe('in_cantidad'),
      caras: parseInt(document.querySelector('input[name="caras"]:checked').value, 10),
      cant_4xl, cant_5xl
    };
  }
  if (pack.tipo === 'mixto') {
    return {
      cant_clasica: intDe('in_cant_clasica'),
      cant_urban: intDe('in_cant_urban'),
      caras: parseInt(document.querySelector('input[name="caras"]:checked').value, 10),
      cant_4xl, cant_5xl
    };
  }
  return null;
}

function ejecutarCalculo() {
  hide('error-msg');
  const pack = CFG.packs[estado.packId];
  const opt = recogerInputs();

  let resultado;
  if (pack.tipo === 'pena') resultado = calcularPackPena(opt);
  else if (pack.tipo === 'individual') resultado = calcularPackIndividual(estado.packId, opt);
  else if (pack.tipo === 'mixto') resultado = calcularPackMixto(opt);

  if (resultado.error) {
    el('error-msg').textContent = resultado.error;
    show('error-msg');
    hide('seccion-resultado');
    return;
  }

  renderResultado(resultado);
  show('seccion-resultado');
  el('seccion-resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderResultado(r) {
  const c = el('resultado-content');
  let metaHtml = '', tablaHtml = '';

  if (r.es_mixto) {
    metaHtml = `
      <div class="resultado-meta">
        <span><strong>Pack:</strong> ${r.pack}</span>
        <span><strong>Tramo:</strong> ${r.tramo}</span>
        <span><strong>Total sudaderas:</strong> ${r.cantidad_total}</span>
        <span><strong>Caras:</strong> ${r.caras === 2 ? '2 caras' : '1 cara'}</span>
      </div>
    `;
    tablaHtml = `
      <table class="resultado-tabla">
        <thead>
          <tr><th>Concepto</th><th class="valor">Cantidad</th><th class="valor">PVP unit.</th><th class="valor">Subtotal</th></tr>
        </thead>
        <tbody>
          ${r.desglose.map(d => `
            <tr>
              <td>${d.nombre}</td>
              <td class="valor">${d.cantidad}</td>
              <td class="valor">${fmtEur(d.pvp)}</td>
              <td class="valor">${fmtEur(d.subtotal)}</td>
            </tr>
          `).join('')}
          ${r.recargos > 0 ? `
            <tr>
              <td>Recargo tallas grandes</td>
              <td class="valor">${r.cant_4xl + r.cant_5xl}</td>
              <td class="valor">-</td>
              <td class="valor">${fmtEur(r.recargos)}</td>
            </tr>
          ` : ''}
          <tr class="total">
            <td colspan="3">TOTAL (IVA incluido)</td>
            <td class="valor">${fmtEur(r.total_iva_inc)}</td>
          </tr>
        </tbody>
      </table>
    `;
  } else {
    let extra = '';
    if (r.extra) {
      if (r.extra.capucha === 'con_capucha') extra = '<span><strong>Tipo:</strong> CON capucha</span>';
      else if (r.extra.capucha === 'sin_capucha') extra = '<span><strong>Tipo:</strong> SIN capucha</span>';
    }
    metaHtml = `
      <div class="resultado-meta">
        <span><strong>Pack:</strong> ${r.pack}</span>
        <span><strong>Tramo:</strong> ${r.tramo}</span>
        <span><strong>Cantidad:</strong> ${r.cantidad} uds</span>
        <span><strong>Caras:</strong> ${r.extra && r.extra.caras === 2 ? '2 caras' : '1 cara'}</span>
        ${extra}
      </div>
    `;
    tablaHtml = `
      <table class="resultado-tabla">
        <tbody>
          <tr>
            <td>PVP unitario (IVA incluido)</td>
            <td class="valor">${fmtEur(r.pvp_unitario)}</td>
          </tr>
          <tr>
            <td>Subtotal (${r.cantidad} × ${fmtEur(r.pvp_unitario)})</td>
            <td class="valor">${fmtEur(r.subtotal)}</td>
          </tr>
          ${r.recargos > 0 ? `
            <tr>
              <td>Recargo tallas grandes (${r.cant_4xl + r.cant_5xl} prendas)</td>
              <td class="valor">${fmtEur(r.recargos)}</td>
            </tr>
          ` : ''}
          <tr class="total">
            <td>TOTAL (IVA incluido)</td>
            <td class="valor">${fmtEur(r.total_iva_inc)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  const detallesIva = `
    <div class="resultado-meta" style="margin-top: 4px;">
      <span><strong>Base imponible:</strong> ${fmtEur(r.base_venta)}</span>
      <span><strong>IVA repercutido (${fmtPct(CFG.parametros.iva)}):</strong> ${fmtEur(r.iva)}</span>
    </div>
  `;

  let adminHtml = '';
  if (estado.esAdmin) {
    adminHtml = `
      <div class="resultado-admin">
        <h4>📊 Datos internos (modo admin)</h4>
        <div class="stats">
          <div><strong>Coste total</strong>${fmtEur(r.coste_total)}</div>
          <div><strong>Margen €</strong>${fmtEur(r.margen)}</div>
          <div><strong>Margen %</strong>${fmtPct(r.margen_pct)}</div>
          ${r.coste_unitario !== undefined ? `<div><strong>Coste unitario</strong>${fmtEur(r.coste_unitario)}</div>` : ''}
        </div>
      </div>
    `;
  }

  c.innerHTML = metaHtml + tablaHtml + detallesIva + adminHtml;
}

function resetear() {
  if (estado.packId) renderInputsPack(estado.packId);
  el('cant_4xl').value = '0';
  el('cant_5xl').value = '0';
  hide('seccion-resultado');
  hide('error-msg');
}

function volverASeleccion() {
  estado.packId = null;
  hide('seccion-paso2');
  hide('seccion-resultado');
  hide('error-msg');
  el('seccion-paso1').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// Recargar config desde NAS
// ============================================================

async function recargarConfig() {
  if (estado.esAdmin) {
    const ok = confirm('Tienes el modo admin abierto con cambios sin guardar. ¿Recargar de todos modos? Se perderán tus cambios.');
    if (!ok) return;
    cerrarAdmin();
  }
  await cargarConfigYMostrarApp();
}

// ============================================================
// Modo administrador
// ============================================================

async function abrirAdmin() {
  show('admin-overlay');
  if (estado.esAdmin) {
    await mostrarEditorAdmin();
  } else {
    show('admin-login');
    hide('admin-editor');
    setTimeout(() => el('admin-clave').focus(), 100);
  }
}

function cerrarAdmin() {
  hide('admin-overlay');
  hide('admin-login-error');
  el('admin-clave').value = '';
}

async function loginAdmin() {
  const clave = el('admin-clave').value;
  if (clave === CFG.admin.clave) {
    estado.esAdmin = true;
    el('btn-admin-toggle').textContent = '🔓 Admin activo';
    hide('admin-login-error');
    el('admin-clave').value = '';
    await mostrarEditorAdmin();
  } else {
    show('admin-login-error');
  }
}

async function mostrarEditorAdmin() {
  hide('admin-login');
  show('admin-editor');

  // Tomar snapshot del archivo y de la config para detectar conflictos
  CFG_BACKUP = deepClone(CFG);
  infoConfigAlAbrirAdmin = await window.fuzfuz.infoConfig(SETTINGS.ruta_config);

  renderAdminTab(estado.adminTab);
}

function renderAdminTab(tab) {
  estado.adminTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  const cont = el('admin-tab-content');
  if (tab === 'parametros') cont.innerHTML = renderAdminParametros();
  else if (tab === 'modelos') cont.innerHTML = renderAdminModelos();
  else if (tab === 'tramos')  cont.innerHTML = renderAdminTramos();
  else if (tab === 'packs')   cont.innerHTML = renderAdminPacks();

  cont.querySelectorAll('input[data-cfg-path]').forEach(input => {
    input.addEventListener('change', () => actualizarConfigDesdeInput(input));
  });
}

function renderAdminParametros() {
  const labels = {
    mo_eur_hora: 'Mano de obra (€/h por persona)',
    iva: 'IVA (decimal, ej. 0.21)',
    merma_pct: 'Merma (decimal, ej. 0.10)',
    indirectos_eur_prenda: 'Indirectos (€/prenda)',
    buffer_3xl_eur_pack: 'Buffer 3XL (€/pack peña)',
    recargo_4xl_eur: 'Recargo 4XL (€/prenda)',
    recargo_5xl_eur: 'Recargo 5XL+ (€/prenda)',
    envio_roly_eur_bulto: 'Envío Roly (€/bulto)',
    prendas_por_bulto: 'Prendas por bulto',
    dtf_eur_metro: 'DTF (€/metro)',
    dtf_metros_2caras: 'DTF metros 2 caras',
    dtf_metros_1cara: 'DTF metros 1 cara',
    planchado_eur_cara: 'Planchado (€/cara)',
    minutos_2caras_base: 'Minutos por prenda 2 caras',
    minutos_1cara_base: 'Minutos por prenda 1 cara'
  };

  let html = '<div class="admin-grid">';
  for (const [key, lbl] of Object.entries(labels)) {
    html += `
      <label>${lbl}</label>
      <input type="number" step="0.01" value="${CFG.parametros[key]}" data-cfg-path="parametros.${key}">
    `;
  }
  html += '</div>';
  return html;
}

function renderAdminModelos() {
  let html = '<div class="admin-grid">';
  for (const [k, m] of Object.entries(CFG.modelos_roly)) {
    html += `
      <label>${m.nombre} <span class="hint">(${k} · ${m.ref})</span></label>
      <input type="number" step="0.0001" value="${m.precio}" data-cfg-path="modelos_roly.${k}.precio">
    `;
  }
  html += '</div>';
  return html;
}

function renderAdminTramos() {
  let html = '<p class="hint">Edita los rangos de cada tramo de volumen y la reducción de tiempo aplicable.</p>';
  CFG.tramos.forEach((t, i) => {
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

function renderAdminPacks() {
  let html = '<p class="hint">PVP por tramo (IVA incluido). El pack mixto sudaderas usa los precios de "solo_clasica" y "solo_urban" automáticamente.</p>';

  for (const [id, pack] of Object.entries(CFG.packs)) {
    if (pack.tipo === 'mixto') continue;

    html += `<div class="admin-subhead">${pack.nombre}</div>`;

    if (pack.tipo === 'pena') {
      for (const cap of ['sin_capucha', 'con_capucha']) {
        for (const car of ['dos_caras', 'una_cara']) {
          html += `<div class="admin-mini-head">${cap === 'con_capucha' ? 'Con capucha' : 'Sin capucha'} · ${car === 'dos_caras' ? '2 caras' : '1 cara'}</div>`;
          html += '<div class="admin-grid">';
          for (const t of CFG.tramos) {
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
        html += `<div class="admin-mini-head">${car === 'dos_caras' ? '2 caras' : '1 cara'}</div>`;
        html += '<div class="admin-grid">';
        for (const t of CFG.tramos) {
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

function actualizarConfigDesdeInput(input) {
  const path = input.dataset.cfgPath.split('.');
  const valor = input.value === '' ? null : parseFloat(input.value);

  let obj = CFG;
  for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]];
  obj[path[path.length - 1]] = valor;
}

// ============================================================
// Guardar config en NAS con detección de conflictos
// ============================================================

async function guardarConfigEnNAS() {
  // Actualizar metadatos de modificación
  CFG.fecha_actualizacion = new Date().toLocaleString('es-ES');
  CFG.modificado_por = SETTINGS.nombre_usuario;

  const datos = {
    ruta: SETTINGS.ruta_config,
    configNuevo: CFG,
    infoEsperada: infoConfigAlAbrirAdmin
  };

  const r = await window.fuzfuz.guardarConfig(datos);

  if (r.ok) {
    infoConfigAlAbrirAdmin = r.info;
    CFG_BACKUP = deepClone(CFG);
    await window.fuzfuz.mostrarInfo({
      titulo: 'Guardado',
      mensaje: 'Cambios guardados correctamente en el NAS',
      detalle: r.backupPath ? `Backup creado en:\n${r.backupPath}` : ''
    });
    inicializarApp();  // refrescar header con nueva fecha
    return;
  }

  if (r.conflicto) {
    // Pedir decisión al usuario via diálogo nativo
    const respuesta = await window.fuzfuz.confirmarConflicto({
      modificadoPor: r.modificadoPor,
      fechaActualizacion: r.fechaActualizacion
    });

    if (respuesta === 0) {
      // Sobrescribir
      const r2 = await window.fuzfuz.guardarConfigForzado({
        ruta: SETTINGS.ruta_config,
        configNuevo: CFG
      });
      if (r2.ok) {
        infoConfigAlAbrirAdmin = r2.info;
        CFG_BACKUP = deepClone(CFG);
        await window.fuzfuz.mostrarInfo({
          titulo: 'Guardado (forzado)',
          mensaje: 'Cambios guardados sobrescribiendo la versión del compañero.'
        });
        inicializarApp();
      } else {
        await window.fuzfuz.mostrarError({
          titulo: 'Error',
          mensaje: 'No se pudo guardar',
          detalle: r2.error
        });
      }
    } else if (respuesta === 1) {
      // Descartar mis cambios y recargar
      cerrarAdmin();
      estado.esAdmin = false;
      el('btn-admin-toggle').textContent = '🔒 Admin';
      await cargarConfigYMostrarApp();
    }
    // respuesta === 2: cancelar, no hacer nada
    return;
  }

  // Error genérico
  await window.fuzfuz.mostrarError({
    titulo: 'Error al guardar',
    mensaje: 'No se pudo guardar el archivo',
    detalle: r.error || 'Error desconocido'
  });
}

function cancelarCambiosAdmin() {
  if (CFG_BACKUP) {
    CFG = deepClone(CFG_BACKUP);
    renderAdminTab(estado.adminTab);
    inicializarApp();
  }
}

// ============================================================
// Modal Ajustes locales
// ============================================================

function abrirAjustes() {
  el('aj-nombre').value = SETTINGS.nombre_usuario || '';
  el('aj-ruta').value = SETTINGS.ruta_config || '';
  show('ajustes-overlay');
}

function cerrarAjustes() {
  hide('ajustes-overlay');
}

async function guardarAjustes() {
  const nombre = el('aj-nombre').value.trim();
  const ruta = el('aj-ruta').value.trim();

  if (!nombre || !ruta) {
    await window.fuzfuz.mostrarError({
      titulo: 'Datos incompletos',
      mensaje: 'Indica nombre y ruta del config'
    });
    return;
  }

  // Verificar que el archivo se puede leer si la ruta cambió
  if (ruta !== SETTINGS.ruta_config) {
    const r = await window.fuzfuz.leerConfig(ruta);
    if (!r.ok) {
      await window.fuzfuz.mostrarError({
        titulo: 'No se puede leer el archivo',
        mensaje: r.error
      });
      return;
    }
  }

  SETTINGS = { nombre_usuario: nombre, ruta_config: ruta };
  await window.fuzfuz.guardarSettings(SETTINGS);
  cerrarAjustes();
  await cargarConfigYMostrarApp();
}

// ============================================================
// Arranque
// ============================================================

document.addEventListener('DOMContentLoaded', arrancar);
