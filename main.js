// ============================================================
// PackPrice - Proceso principal Electron
// ============================================================
// Responsabilidades:
//   - Crear y gestionar la ventana
//   - Acceso al filesystem (lectura/escritura del config)
//   - Persistencia de settings locales (%APPDATA%)
//   - IPC para que el renderer pida operaciones de filesystem
//
// Buenas prácticas de seguridad activadas:
//   - contextIsolation: true
//   - nodeIntegration: false
//   - sandbox: true (no se puede por preload con require, pero limitamos exposición)
//   - El renderer NO tiene acceso a fs/path/etc. directamente.
// ============================================================

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildDefaultConfig } = require('./config.default');
const {
  extraerJsonDeConfig,
  validarFormaConfig,
  stripAdminClave,
  reinyectarAdminClave,
  serializarConfig
} = require('./lib/config-parser');

// --- Configuración de paths ---
const SETTINGS_DIR = path.join(app.getPath('userData'));
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

// Ruta por defecto donde la app espera (y si hace falta crea) el config.js
// compartido en el NAS. Se puede cambiar en "Ajustes" en cada PC y queda
// persistido en el settings.json local.
//
// Se prueban en orden hasta encontrar una que sea escribible. La primera
// existente o accesible se usa como ruta inicial; si ninguna existe se
// crea en la primera viable.
const RUTAS_CONFIG_CANDIDATAS = [
  '\\\\172.26.0.154\\Paep\\Packs\\config.js',
  'Z:\\Packs\\config.js'
];

let mainWindow = null;

// ============================================================
// Funciones auxiliares de filesystem
// ============================================================

/**
 * Lee y parsea config.js sin ejecutarlo como JavaScript.
 *
 * Históricamente esto usaba `vm.runInNewContext`, pero la doc de
 * Node deja claro que `vm` no es una frontera de seguridad: un
 * config malicioso puede escapar con `this.constructor.constructor(...)`
 * y obtener RCE. Como el archivo vive en el NAS y el usuario puede
 * seleccionar cualquier .js desde el diálogo, era una superficie real.
 *
 * Ahora extraemos el JSON con un escáner de llaves y `JSON.parse`,
 * que es estrictamente declarativo.
 */
function leerConfigDesdeArchivo(rutaArchivo) {
  if (!fs.existsSync(rutaArchivo)) {
    throw new Error(`No existe el archivo: ${rutaArchivo}`);
  }
  const contenido = fs.readFileSync(rutaArchivo, 'utf-8');
  return extraerJsonDeConfig(contenido);
}

/**
 * Devuelve mtime + hash sha256 del archivo, para detectar conflictos.
 */
function obtenerInfoArchivo(rutaArchivo) {
  if (!fs.existsSync(rutaArchivo)) return null;
  const stat = fs.statSync(rutaArchivo);
  const contenido = fs.readFileSync(rutaArchivo);
  const hash = crypto.createHash('sha256').update(contenido).digest('hex');
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash
  };
}

/**
 * Crea backup automático antes de sobrescribir el config.
 * Lo guarda en una carpeta hermana 'backups/' con timestamp.
 */
function crearBackup(rutaConfig) {
  if (!fs.existsSync(rutaConfig)) return null;

  const dir = path.dirname(rutaConfig);
  const backupsDir = path.join(dir, 'backups');

  try {
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(backupsDir, `config-${ts}.js`);
    fs.copyFileSync(rutaConfig, backupPath);
    return backupPath;
  } catch (err) {
    // No bloqueante: si falla el backup, avisamos pero seguimos.
    console.error('Error creando backup:', err.message);
    return null;
  }
}

/**
 * Comprueba si una ruta es escribible. Sin efectos secundarios:
 * NO crea directorios, solo lee permisos del archivo o del padre.
 *
 * IMPORTANTE: esta función puede bloquear si la ruta apunta a un NAS
 * inaccesible (Windows tarda en agotar el timeout SMB). Llamarla solo
 * en respuesta a una acción explícita del usuario.
 */
function rutaEscribible(rutaArchivo) {
  try {
    if (fs.existsSync(rutaArchivo)) {
      fs.accessSync(rutaArchivo, fs.constants.W_OK);
      return true;
    }
    const dir = path.dirname(rutaArchivo);
    if (fs.existsSync(dir)) {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Devuelve una ruta candidata SIN probar el filesystem. Es solo una
 * sugerencia para mostrar al usuario en la pantalla de bienvenida.
 * La existencia y escribibilidad reales se verifican cuando el usuario
 * pulsa "Empezar" (en `config:exists` y `config:create-default`).
 *
 * No hacemos `fs.existsSync` aquí porque sobre rutas UNC inaccesibles
 * Windows puede tardar decenas de segundos, y eso bloquearía el
 * arranque de la app.
 */
function sugerirRutaCandidata() {
  return RUTAS_CONFIG_CANDIDATAS[0];
}

/**
 * Crea el archivo config.js con valores por defecto en la ruta indicada.
 * No sobrescribe si ya existe.
 *
 * @param {string} rutaArchivo
 * @param {object} [meta] - { modificado_por }
 * @returns {object} { creado: boolean, config, ruta, motivo? }
 */
function crearConfigPorDefecto(rutaArchivo, meta = {}) {
  if (fs.existsSync(rutaArchivo)) {
    return { creado: false, motivo: 'ya_existe', ruta: rutaArchivo };
  }

  const dir = path.dirname(rutaArchivo);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const config = buildDefaultConfig(meta);
  const contenido = serializarConfig(config);
  fs.writeFileSync(rutaArchivo, contenido, 'utf-8');
  return { creado: true, config, ruta: rutaArchivo };
}

/**
 * Carga settings locales de %APPDATA%.
 * Devuelve null si no existen (primer arranque).
 */
function leerSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  try {
    const contenido = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(contenido);
  } catch (err) {
    console.error('settings.json corrupto, se ignora:', err.message);
    return null;
  }
}

function guardarSettings(settings) {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

// ============================================================
// Ventana principal
// ============================================================

function crearVentana() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 600,
    title: 'PackPrice · Calculadora de packs',
    backgroundColor: '#E8ECF1',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false  // necesario porque preload.js usa require
    }
  });

  // Menú simplificado (oculto por defecto, accesible con Alt)
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Archivo',
      submenu: [
        { role: 'reload', label: 'Recargar' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir' }
      ]
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'zoomIn',   label: 'Aumentar zoom' },
        { role: 'zoomOut',  label: 'Reducir zoom' },
        { role: 'resetZoom', label: 'Zoom 100%' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }
      ]
    }
  ]));

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ============================================================
// IPC handlers
// ============================================================

// --- Settings ---

ipcMain.handle('settings:read', () => {
  return leerSettings();
});

ipcMain.handle('settings:write', (event, settings) => {
  try {
    guardarSettings(settings);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Ruta candidata por defecto (NAS) ---

ipcMain.handle('config:default-path', () => {
  // Devolución instantánea: sugerencia sin probar filesystem para no
  // bloquear el arranque cuando el NAS está inaccesible.
  return {
    candidatas: RUTAS_CONFIG_CANDIDATAS.slice(),
    sugerida:   sugerirRutaCandidata()
  };
});

// --- Comprobación de existencia ---

ipcMain.handle('config:exists', (event, ruta) => {
  try {
    return { existe: fs.existsSync(ruta), escribible: rutaEscribible(ruta) };
  } catch (err) {
    return { existe: false, escribible: false, error: err.message };
  }
});

// --- Creación del config con defaults ---

ipcMain.handle('config:create-default', (event, { ruta, modificadoPor }) => {
  try {
    const r = crearConfigPorDefecto(ruta, { modificado_por: modificadoPor });
    if (!r.creado) {
      return { ok: false, motivo: r.motivo, error: 'El archivo ya existe en esa ruta' };
    }
    const info = obtenerInfoArchivo(r.ruta);
    return { ok: true, config: stripAdminClave(r.config), info, ruta: r.ruta };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Diálogo de selección de archivo config ---

ipcMain.handle('dialog:select-config', async () => {
  // No pasamos `defaultPath` apuntando al NAS: si la ruta UNC está
  // inaccesible, Windows se cuelga intentando resolverla antes de
  // mostrar el diálogo. Usamos la carpeta del usuario como punto de
  // partida (siempre instantánea); el explorador recuerda la última
  // ubicación visitada en posteriores aperturas.
  const resultado = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona el archivo de configuración',
    filters: [
      { name: 'Configuración JS', extensions: ['js'] },
      { name: 'Todos los archivos', extensions: ['*'] }
    ],
    properties: ['openFile'],
    defaultPath: app.getPath('home')
  });

  if (resultado.canceled || resultado.filePaths.length === 0) {
    return { cancelado: true };
  }
  return { cancelado: false, ruta: resultado.filePaths[0] };
});

// --- Lectura de config ---

ipcMain.handle('config:read', (event, ruta) => {
  try {
    const config = leerConfigDesdeArchivo(ruta);
    const info = obtenerInfoArchivo(ruta);
    return { ok: true, config: stripAdminClave(config), info };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Escritura de config (con detección de conflictos) ---
//
// Recibe:
//   - ruta: la ruta del archivo
//   - configNuevo: el objeto de configuración a guardar
//   - infoEsperada: { mtimeMs, hash } que el renderer leyó al abrir admin
//                    (null si es la primera escritura o no se quiere comprobar)
//
// Devuelve:
//   - { ok: true, info } si se guardó
//   - { ok: false, conflicto: true, infoActual } si hubo conflicto
//   - { ok: false, error } si error genérico
//
/**
 * Reinyecta la clave admin en un config recibido del renderer
 * (que la recibe stripped). Si el archivo en disco no se puede
 * leer (caso degradado), usamos la clave por defecto en vez de
 * dejar el config sin admin.clave válido.
 */
function fusionarConClaveActual(ruta, configDelRenderer) {
  let claveActual = null;
  try {
    const cfgDisco = leerConfigDesdeArchivo(ruta);
    claveActual = (cfgDisco.admin && cfgDisco.admin.clave) || null;
  } catch (_) {
    // Archivo nuevo o ilegible: fallback a la default. No silenciamos
    // por costumbre; lo hacemos porque es la única recuperación posible
    // sin romper la edición admin en curso.
    claveActual = buildDefaultConfig().admin.clave;
  }
  return reinyectarAdminClave(configDelRenderer, claveActual);
}

ipcMain.handle('config:write', (event, { ruta, configNuevo, infoEsperada }) => {
  try {
    // Detección de conflicto: ¿cambió el archivo desde que el admin lo leyó?
    if (infoEsperada) {
      const infoActual = obtenerInfoArchivo(ruta);
      if (infoActual) {
        const cambio = (infoActual.hash !== infoEsperada.hash);
        if (cambio) {
          // Intentar leer el config actual para mostrar quién lo modificó
          let modificadoPor = 'desconocido';
          let fechaActualizacion = '';
          try {
            const cfgActual = leerConfigDesdeArchivo(ruta);
            modificadoPor = cfgActual.modificado_por || 'desconocido';
            fechaActualizacion = cfgActual.fecha_actualizacion || '';
          } catch (_) {}

          return {
            ok: false,
            conflicto: true,
            infoActual,
            modificadoPor,
            fechaActualizacion
          };
        }
      }
    }

    const configCompleto = fusionarConClaveActual(ruta, configNuevo);
    validarFormaConfig(configCompleto);
    const contenido = serializarConfig(configCompleto);

    // Backup antes de sobrescribir
    const backupPath = crearBackup(ruta);

    // Escribir
    fs.writeFileSync(ruta, contenido, 'utf-8');

    // Devolver nueva info
    const infoNueva = obtenerInfoArchivo(ruta);
    return { ok: true, info: infoNueva, backupPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Forzar escritura (sobrescribir conflicto) ---
ipcMain.handle('config:force-write', (event, { ruta, configNuevo }) => {
  try {
    const configCompleto = fusionarConClaveActual(ruta, configNuevo);
    validarFormaConfig(configCompleto);
    const contenido = serializarConfig(configCompleto);
    crearBackup(ruta);
    fs.writeFileSync(ruta, contenido, 'utf-8');
    const infoNueva = obtenerInfoArchivo(ruta);
    return { ok: true, info: infoNueva };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Verificación de la clave admin (en main, no en renderer) ---
//
// El renderer recibe el config sin `admin.clave`, así que la
// comparación de la clave debe ocurrir aquí. Usamos
// `crypto.timingSafeEqual` para no filtrar por tiempo. Si las
// longitudes difieren, devolvemos `false` directamente: el
// timing sigue ligado a la longitud del candidato, no a su
// contenido, lo cual es aceptable para un "anti-clic-accidental".
ipcMain.handle('auth:verify-admin', (event, { ruta, clave }) => {
  try {
    if (typeof clave !== 'string' || typeof ruta !== 'string') {
      return { ok: false, error: 'Parámetros inválidos' };
    }
    const cfg = leerConfigDesdeArchivo(ruta);
    const claveActual = (cfg.admin && cfg.admin.clave) || '';
    const aBuf = Buffer.from(clave, 'utf-8');
    const bBuf = Buffer.from(claveActual, 'utf-8');
    if (aBuf.length !== bBuf.length) {
      return { ok: true, valida: false };
    }
    const valida = crypto.timingSafeEqual(aBuf, bBuf);
    return { ok: true, valida };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Info del archivo (para detectar cambios externos) ---
ipcMain.handle('config:info', (event, ruta) => {
  try {
    return obtenerInfoArchivo(ruta);
  } catch (err) {
    return null;
  }
});

// --- Diálogo de confirmación nativa ---
ipcMain.handle('dialog:confirmar-conflicto', async (event, datos) => {
  const { modificadoPor, fechaActualizacion } = datos;
  const respuesta = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'Conflicto al guardar',
    message: 'El archivo fue modificado mientras editabas',
    detail: `Otro usuario (${modificadoPor || 'desconocido'}) modificó el config el ${fechaActualizacion || 'sin fecha'}. ¿Cómo quieres proceder?`,
    buttons: [
      'Sobrescribir (mis cambios ganan)',
      'Descartar mis cambios (recargar)',
      'Cancelar'
    ],
    defaultId: 2,
    cancelId: 2
  });
  return respuesta.response; // 0, 1 o 2
});

ipcMain.handle('dialog:confirmar', async (event, { titulo, mensaje, detalle, botones, defaultId }) => {
  const respuesta = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: titulo,
    message: mensaje,
    detail: detalle || '',
    buttons: botones || ['Aceptar', 'Cancelar'],
    defaultId: typeof defaultId === 'number' ? defaultId : 0,
    cancelId: (botones || ['Aceptar', 'Cancelar']).length - 1
  });
  return respuesta.response;
});

ipcMain.handle('dialog:info', async (event, { titulo, mensaje, detalle }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: titulo,
    message: mensaje,
    detail: detalle || ''
  });
});

ipcMain.handle('dialog:error', async (event, { titulo, mensaje, detalle }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: titulo,
    message: mensaje,
    detail: detalle || ''
  });
});

// ============================================================
// Ciclo de vida de la app
// ============================================================

app.whenReady().then(() => {
  crearVentana();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) crearVentana();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
