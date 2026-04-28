// ============================================================
// FuzFuz Calculadora - Proceso principal Electron
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
const vm = require('vm');

// --- Configuración de paths ---
const SETTINGS_DIR = path.join(app.getPath('userData'));
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

let mainWindow = null;

// ============================================================
// Funciones auxiliares de filesystem
// ============================================================

/**
 * Lee y parsea config.js usando un sandbox seguro de vm.
 * El archivo es JavaScript, no JSON, por lo que vm.runInNewContext
 * lo interpreta correctamente (con comentarios, etc.) sin acceso
 * al sistema porque el sandbox está aislado.
 */
function leerConfigDesdeArchivo(rutaArchivo) {
  if (!fs.existsSync(rutaArchivo)) {
    throw new Error(`No existe el archivo: ${rutaArchivo}`);
  }
  const contenido = fs.readFileSync(rutaArchivo, 'utf-8');
  const sandbox = { window: {} };
  try {
    vm.runInNewContext(contenido, sandbox, { timeout: 1000 });
  } catch (err) {
    throw new Error(`Error al parsear config.js: ${err.message}`);
  }
  if (!sandbox.window.FUZFUZ_CONFIG) {
    throw new Error('El archivo no contiene window.FUZFUZ_CONFIG');
  }
  return sandbox.window.FUZFUZ_CONFIG;
}

/**
 * Genera el contenido de config.js a partir del objeto de configuración.
 */
function serializarConfig(config) {
  const json = JSON.stringify(config, null, 2);
  return `// ============================================================
// FuzFuz - Configuración de la calculadora
// ============================================================
// Editado: ${new Date().toLocaleString('es-ES')}
// Modificado por: ${config.modificado_por || 'desconocido'}
//
// Este archivo es generado por la app. Edítalo solo a mano si
// estás seguro de lo que haces. La app prefiere ediciones desde
// el modo administrador.
// ============================================================

window.FUZFUZ_CONFIG = ${json};
`;
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
    width: 980,
    height: 800,
    minWidth: 720,
    minHeight: 600,
    title: 'FuzFuz Calculadora',
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

// --- Diálogo de selección de archivo config ---

ipcMain.handle('dialog:select-config', async () => {
  const resultado = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona el archivo de configuración',
    filters: [
      { name: 'Configuración JS', extensions: ['js'] },
      { name: 'Todos los archivos', extensions: ['*'] }
    ],
    properties: ['openFile'],
    defaultPath: 'Z:\\Packs'  // sugerencia, el usuario puede navegar a otra parte
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
    return { ok: true, config, info };
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

    // Validar que el config nuevo es serializable
    const contenido = serializarConfig(configNuevo);

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
    const contenido = serializarConfig(configNuevo);
    crearBackup(ruta);
    fs.writeFileSync(ruta, contenido, 'utf-8');
    const infoNueva = obtenerInfoArchivo(ruta);
    return { ok: true, info: infoNueva };
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
