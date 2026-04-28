// ============================================================
// Preload - puente seguro entre el proceso main y el renderer
// ============================================================
// Expone APIs limitadas en window.packprice vía contextBridge.
// El renderer NO tiene acceso directo a Node, fs, ipcRenderer,
// ni nada similar. Solo puede llamar a las funciones aquí
// expuestas, que internamente usan IPC para hablar con main.
// ============================================================

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('packprice', {

  // --- Settings locales (%APPDATA%) ---
  leerSettings:    ()        => ipcRenderer.invoke('settings:read'),
  guardarSettings: (s)       => ipcRenderer.invoke('settings:write', s),

  // --- Selección de archivo via diálogo nativo ---
  seleccionarConfig: ()      => ipcRenderer.invoke('dialog:select-config'),

  // --- Ruta candidata por defecto (NAS) ---
  rutaConfigPorDefecto: ()   => ipcRenderer.invoke('config:default-path'),

  // --- Comprobación / creación del config ---
  existeConfig:      (ruta)  => ipcRenderer.invoke('config:exists', ruta),
  crearConfigDefault: (datos) => ipcRenderer.invoke('config:create-default', datos),

  // --- Lectura/escritura del config en NAS ---
  leerConfig:        (ruta)  => ipcRenderer.invoke('config:read', ruta),
  infoConfig:        (ruta)  => ipcRenderer.invoke('config:info', ruta),
  guardarConfig:     (datos) => ipcRenderer.invoke('config:write', datos),
  guardarConfigForzado: (datos) => ipcRenderer.invoke('config:force-write', datos),

  // --- Diálogos nativos ---
  confirmarConflicto: (d) => ipcRenderer.invoke('dialog:confirmar-conflicto', d),
  confirmar:          (d) => ipcRenderer.invoke('dialog:confirmar', d),
  mostrarInfo:        (d) => ipcRenderer.invoke('dialog:info', d),
  mostrarError:       (d) => ipcRenderer.invoke('dialog:error', d)

});
