// ============================================================
// PackPrice · Renderer (orquestación)
// ============================================================
// - Bootstrap y enrutado entre pantallas
// - Eventos del DOM
// - Llamadas IPC al proceso principal vía window.packprice
//
// La lógica pura vive en:
//   - calculo.js  (cálculo de packs)
//   - admin.js    (renderizado del editor admin)
//   - format.js   (utilidades de DOM/formato)
// ============================================================

import { el, show, hide, intDe, fmtEur, fmtPct, deepClone } from './format.js';
import {
  calcularPackPena,
  calcularPackIndividual,
  calcularPackMixto
} from './calculo.js';
import {
  renderAdminTabContent,
  actualizarConfigDesdeInput
} from './admin.js';

// ============================================================
// Estado del módulo
// ============================================================
let CFG = null;                    // configuración actual cargada del NAS
let SETTINGS = null;                // ruta_config + nombre_usuario
let infoConfigAlAbrirAdmin = null;  // mtime + hash al abrir admin (conflictos)
let CFG_BACKUP = null;              // copia para "Cancelar cambios"
let eventosBindeados = false;

const estado = {
  packId: null,
  esAdmin: false,
  adminTab: 'parametros'
};

// ============================================================
// Arranque: decidir pantalla a mostrar
// ============================================================

async function arrancar() {
  SETTINGS = await window.packprice.leerSettings();

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

  // 1) Enganchar listeners INMEDIATAMENTE para que la pantalla sea
  //    interactiva sin esperar a ningún IPC. La sugerencia de ruta
  //    se rellena en background (best-effort) sin bloquear.
  el('btn-bv-explorar').addEventListener('click', async () => {
    const r = await window.packprice.seleccionarConfig();
    if (!r.cancelado) {
      el('bv-ruta').value = r.ruta;
      validarFormBienvenida();
    }
  });

  el('bv-nombre').addEventListener('input', validarFormBienvenida);
  el('bv-ruta').addEventListener('input', validarFormBienvenida);
  el('btn-bv-empezar').addEventListener('click', empezarPrimeraVez);

  validarFormBienvenida();
  setTimeout(() => el('bv-nombre').focus(), 50);

  // 2) Sugerencia de ruta en background. Si el usuario ya está
  //    escribiendo cuando llega, no la pisamos.
  window.packprice.rutaConfigPorDefecto()
    .then((sugerencia) => {
      const input = el('bv-ruta');
      if (!input.value && sugerencia && sugerencia.sugerida) {
        input.value = sugerencia.sugerida;
        validarFormBienvenida();
      }
    })
    .catch(() => { /* no bloqueamos la UI por una sugerencia */ });
}

function validarFormBienvenida() {
  const nombre = el('bv-nombre').value.trim();
  const ruta = el('bv-ruta').value.trim();
  el('btn-bv-empezar').disabled = !(nombre && ruta);
}

async function empezarPrimeraVez() {
  const nombre = el('bv-nombre').value.trim();
  const ruta = el('bv-ruta').value.trim();
  hide('bv-error');

  // Bloquear el botón mientras comprobamos. La verificación toca el
  // filesystem y, sobre rutas UNC inaccesibles, puede tardar.
  const btn = el('btn-bv-empezar');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Comprobando ruta...';
  try {
    await empezarPrimeraVezImpl(nombre, ruta);
  } finally {
    btn.textContent = textoOriginal;
    validarFormBienvenida();
  }
}

async function empezarPrimeraVezImpl(nombre, ruta) {
  // 1) Si el archivo no existe, ofrecer crearlo con defaults del plan.
  const exist = await window.packprice.existeConfig(ruta);
  if (!exist.existe) {
    if (!exist.escribible) {
      mostrarErrorBienvenida(
        'No se puede crear el archivo en esa ruta. Comprueba que el NAS está accesible y tienes permisos de escritura.'
      );
      return;
    }
    const opcion = await window.packprice.confirmar({
      titulo: 'Archivo no encontrado',
      mensaje: '¿Crear config.js con los valores por defecto?',
      detalle: `No se encontró un archivo de configuración en:\n${ruta}\n\nSe creará uno nuevo con los valores por defecto del plan.`,
      botones: ['Crear con valores por defecto', 'Cancelar'],
      defaultId: 0
    });
    if (opcion !== 0) return;

    const creado = await window.packprice.crearConfigDefault({ ruta, modificadoPor: nombre });
    if (!creado.ok) {
      mostrarErrorBienvenida(`No se pudo crear el archivo: ${creado.error}`);
      return;
    }
  } else {
    // Si existe, validamos que se puede leer.
    const r = await window.packprice.leerConfig(ruta);
    if (!r.ok) {
      mostrarErrorBienvenida(`No se pudo leer el archivo: ${r.error}`);
      return;
    }
  }

  // 2) Persistir settings locales.
  SETTINGS = { ruta_config: ruta, nombre_usuario: nombre };
  const guardado = await window.packprice.guardarSettings(SETTINGS);
  if (!guardado.ok) {
    mostrarErrorBienvenida(`No se pudo guardar la configuración local: ${guardado.error}`);
    return;
  }

  // 3) Arrancar app.
  hide('pantalla-bienvenida');
  await cargarConfigYMostrarApp();
}

function mostrarErrorBienvenida(mensaje) {
  el('bv-error').textContent = mensaje;
  show('bv-error');
}

async function cargarConfigYMostrarApp() {
  const r = await window.packprice.leerConfig(SETTINGS.ruta_config);
  if (!r.ok) {
    await mostrarPantallaError(r.error);
    return;
  }

  CFG = r.config;
  hide('pantalla-bienvenida');
  hide('pantalla-error');
  show('pantalla-app');
  inicializarApp();
}

async function mostrarPantallaError(detalle) {
  hide('pantalla-app');
  hide('pantalla-bienvenida');
  show('pantalla-error');
  el('error-detalle').textContent = detalle;

  // El botón "Crear config con defaults" solo tiene sentido si el archivo
  // no existe pero la ruta es escribible.
  const exist = await window.packprice.existeConfig(SETTINGS.ruta_config);
  const btnCrear = el('btn-error-crear-default');
  if (btnCrear) {
    if (!exist.existe && exist.escribible) {
      btnCrear.classList.remove('hidden');
    } else {
      btnCrear.classList.add('hidden');
    }
    btnCrear.onclick = async () => {
      const opcion = await window.packprice.confirmar({
        titulo: 'Crear config por defecto',
        mensaje: '¿Crear config.js con los valores por defecto?',
        detalle: `Ruta: ${SETTINGS.ruta_config}`,
        botones: ['Crear', 'Cancelar'],
        defaultId: 0
      });
      if (opcion !== 0) return;

      const creado = await window.packprice.crearConfigDefault({
        ruta: SETTINGS.ruta_config,
        modificadoPor: SETTINGS.nombre_usuario
      });
      if (!creado.ok) {
        await window.packprice.mostrarError({
          titulo: 'Error',
          mensaje: 'No se pudo crear el archivo',
          detalle: creado.error
        });
        return;
      }
      await cargarConfigYMostrarApp();
    };
  }

  el('btn-error-reintentar').onclick = async () => {
    await cargarConfigYMostrarApp();
  };
  el('btn-error-cambiar-ruta').onclick = async () => {
    const r = await window.packprice.seleccionarConfig();
    if (!r.cancelado) {
      SETTINGS.ruta_config = r.ruta;
      await window.packprice.guardarSettings(SETTINGS);
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

  renderListaPacks();

  if (!eventosBindeados) {
    bindearEventos();
    eventosBindeados = true;
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
    tab.addEventListener('click', () => mostrarAdminTab(tab.dataset.tab));
  });

  el('admin-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'admin-overlay') cerrarAdmin();
  });

  // Modal ajustes
  el('btn-cerrar-ajustes').addEventListener('click', cerrarAjustes);
  el('btn-aj-cancelar').addEventListener('click', cerrarAjustes);
  el('btn-aj-guardar').addEventListener('click', guardarAjustes);
  el('btn-aj-explorar').addEventListener('click', async () => {
    const r = await window.packprice.seleccionarConfig();
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
      return;
    }

    // Enter (teclado normal y numpad ambos llegan como 'Enter') dispara
    // "Calcular" cuando estás rellenando el pedido. No actúa si hay un
    // modal abierto ni si la sección de inputs no se está mostrando.
    if (e.key === 'Enter') {
      const paso2 = el('seccion-paso2');
      if (paso2.classList.contains('hidden')) return;
      if (!el('admin-overlay').classList.contains('hidden')) return;
      if (!el('ajustes-overlay').classList.contains('hidden')) return;
      if (!(e.target instanceof HTMLElement) || !paso2.contains(e.target)) return;

      e.preventDefault();
      ejecutarCalculo();
    }
  });

  // UX inputs numéricos: al enfocar, seleccionar todo el valor para
  // que el usuario sobrescriba directamente sin tener que borrar primero.
  // Delegado en document porque los inputs se generan dinámicamente.
  document.addEventListener('focusin', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'number') {
      e.target.select();
    }
  });

  // Evitar que la rueda del ratón cambie el valor de un input numérico
  // por accidente al hacer scroll en la página.
  document.addEventListener('wheel', (e) => {
    const a = document.activeElement;
    if (a instanceof HTMLInputElement && a.type === 'number' && a === e.target) {
      a.blur();
    }
  }, { passive: true });
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
  if (pack.tipo === 'pena')            resultado = calcularPackPena(CFG, opt);
  else if (pack.tipo === 'individual') resultado = calcularPackIndividual(CFG, estado.packId, opt);
  else if (pack.tipo === 'mixto')      resultado = calcularPackMixto(CFG, opt);

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
  let metaHtml = '';
  let tablaHtml = '';

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

  // Snapshot del archivo y de la config para detectar conflictos
  CFG_BACKUP = deepClone(CFG);
  infoConfigAlAbrirAdmin = await window.packprice.infoConfig(SETTINGS.ruta_config);

  mostrarAdminTab(estado.adminTab);
}

function mostrarAdminTab(tab) {
  estado.adminTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });

  const cont = el('admin-tab-content');
  cont.innerHTML = renderAdminTabContent(CFG, tab);

  cont.querySelectorAll('input[data-cfg-path]').forEach(input => {
    input.addEventListener('change', () => actualizarConfigDesdeInput(CFG, input));
  });
}

async function guardarConfigEnNAS() {
  CFG.fecha_actualizacion = new Date().toLocaleString('es-ES');
  CFG.modificado_por = SETTINGS.nombre_usuario;

  const datos = {
    ruta: SETTINGS.ruta_config,
    configNuevo: CFG,
    infoEsperada: infoConfigAlAbrirAdmin
  };

  const r = await window.packprice.guardarConfig(datos);

  if (r.ok) {
    infoConfigAlAbrirAdmin = r.info;
    CFG_BACKUP = deepClone(CFG);
    await window.packprice.mostrarInfo({
      titulo: 'Guardado',
      mensaje: 'Cambios guardados correctamente en el NAS',
      detalle: r.backupPath ? `Backup creado en:\n${r.backupPath}` : ''
    });
    inicializarApp();
    return;
  }

  if (r.conflicto) {
    await resolverConflictoAdmin(r);
    return;
  }

  await window.packprice.mostrarError({
    titulo: 'Error al guardar',
    mensaje: 'No se pudo guardar el archivo',
    detalle: r.error || 'Error desconocido'
  });
}

async function resolverConflictoAdmin(respuestaConflicto) {
  const respuesta = await window.packprice.confirmarConflicto({
    modificadoPor: respuestaConflicto.modificadoPor,
    fechaActualizacion: respuestaConflicto.fechaActualizacion
  });

  if (respuesta === 0) {
    // Sobrescribir
    const r2 = await window.packprice.guardarConfigForzado({
      ruta: SETTINGS.ruta_config,
      configNuevo: CFG
    });
    if (r2.ok) {
      infoConfigAlAbrirAdmin = r2.info;
      CFG_BACKUP = deepClone(CFG);
      await window.packprice.mostrarInfo({
        titulo: 'Guardado (forzado)',
        mensaje: 'Cambios guardados sobrescribiendo la versión del compañero.'
      });
      inicializarApp();
    } else {
      await window.packprice.mostrarError({
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
}

function cancelarCambiosAdmin() {
  if (CFG_BACKUP) {
    CFG = deepClone(CFG_BACKUP);
    mostrarAdminTab(estado.adminTab);
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
    await window.packprice.mostrarError({
      titulo: 'Datos incompletos',
      mensaje: 'Indica nombre y ruta del config'
    });
    return;
  }

  // Verificar que el archivo se puede leer si la ruta cambió.
  if (ruta !== SETTINGS.ruta_config) {
    const r = await window.packprice.leerConfig(ruta);
    if (!r.ok) {
      await window.packprice.mostrarError({
        titulo: 'No se puede leer el archivo',
        mensaje: r.error
      });
      return;
    }
  }

  SETTINGS = { nombre_usuario: nombre, ruta_config: ruta };
  await window.packprice.guardarSettings(SETTINGS);
  cerrarAjustes();
  await cargarConfigYMostrarApp();
}

// ============================================================
// Bootstrap
// ============================================================

document.addEventListener('DOMContentLoaded', arrancar);
