# FuzFuz Calculadora · V2 (Electron)

App de escritorio para Windows. La calculadora vive en cada PC, lee/escribe el `config.js` centralizado en el NAS.

---

## 1. Requisitos previos

En el PC donde vayas a construir el `.exe`:

- **Node.js 18 o superior** (recomendado 20 LTS): https://nodejs.org
- **Conexión a internet** para descargar dependencias la primera vez

No necesitas Visual Studio ni Build Tools, electron-builder usa binarios pre-compilados.

---

## 2. Construir el .exe (primera vez)

Abre una terminal (PowerShell, CMD o Git Bash) en la carpeta del proyecto y ejecuta:

```bash
npm install
```

Esto descarga ~150-200 MB de dependencias en `node_modules/`. Puede tardar 1-2 minutos.

Después:

```bash
npm run build:win
```

Esto genera el ejecutable. Cuando termine, lo encontrarás en:

```
dist/FuzFuz-Calculadora-2.0.0-portable.exe
```

Es un único archivo de ~85 MB. No necesita instalación.

---

## 3. Probar en modo desarrollo (sin construir)

Si quieres iterar más rápido durante el desarrollo:

```bash
npm run dev
```

Esto ejecuta la app directamente, sin construir el `.exe`. Cualquier cambio en el código requiere cerrar y volver a ejecutar.

---

## 4. Distribución a otros PCs

1. Construye el `.exe` una vez en tu PC
2. Copia el archivo `dist/FuzFuz-Calculadora-2.0.0-portable.exe` a cada PC de los usuarios
3. Cada usuario:
   - Lo guarda en su escritorio o en `C:\Users\<usuario>\FuzFuz\`
   - Crea un acceso directo en el escritorio si quiere
   - Doble clic para abrir
4. La primera vez en cada PC, la app pedirá:
   - El nombre del usuario (Alberto, Fede, etc.)
   - La ruta del `config.js` en el NAS (ej: `Z:\Packs\config.js`)
5. Esos datos se guardan en `%APPDATA%\fuzfuz-calculadora\settings.json` y no se vuelven a pedir.

---

## 5. Despliegue del config.js

El archivo `config.js` debe colocarse manualmente en el NAS. Estructura recomendada:

```
\\172.26.0.154\Paep\Packs\
├── config.js           ← el archivo que la app lee/escribe
└── backups\            ← se crea automáticamente la primera vez que se modifica
    ├── config-2026-04-28T15-30-12.js
    └── config-2026-04-29T09-15-44.js
```

Si no tienes un `config.js` inicial, copia el que viene con la versión web V1 (`fuzfuz_app/config.js`). La app no crea el archivo desde cero por seguridad — espera encontrarlo ya existente.

---

## 6. Actualizaciones futuras

Cuando saquemos V3 con cambios de código:

1. Reconstruyes el `.exe` con los nuevos cambios (`npm run build:win`)
2. Distribuyes el nuevo `.exe` a cada PC reemplazando el anterior
3. Los `settings.json` y el `config.js` del NAS se mantienen sin tocar

Si a futuro lo necesitas, podemos añadir auto-update con `electron-updater`, pero requiere infraestructura (un servidor o un GitHub Releases). Para 2 PCs no compensa.

---

## 7. Estructura del proyecto

```
fuzfuz_app_v2/
├── package.json              ← dependencias y scripts
├── main.js                   ← proceso principal Electron (filesystem, IPC)
├── preload.js                ← puente seguro main↔renderer
├── icon.png                  ← icono del .exe
├── README-build.md           ← este archivo
├── renderer/
│   ├── index.html            ← UI (todas las pantallas)
│   ├── app.js                ← lógica de la app (cálculo, eventos)
│   └── styles.css            ← estilos
└── dist/                     ← se crea al ejecutar build (no commitear)
    └── FuzFuz-Calculadora-2.0.0-portable.exe
```

---

## 8. Resolución de problemas

**"npm install" falla con error de permisos en Windows**
Ejecuta la terminal como administrador.

**"npm run build:win" falla con "code signing"**
electron-builder a veces avisa de que no firmaste el .exe digitalmente. Para uso interno no hace falta firmarlo. Si te bloquea: añade `"sign": null` en `package.json` dentro de `build.win`.

**Windows SmartScreen avisa al ejecutar el .exe**
Es normal con .exe sin firma. Pulsa "Más información" → "Ejecutar de todas formas". Solo se muestra la primera vez.

**La app no encuentra el config.js**
Comprueba que la unidad de red está mapeada (Z:, Y:, etc.). Abre el explorador de Windows y verifica que puedes navegar a la ruta. Si la unidad cambia, abre la app, ve a "Ajustes" y selecciona la nueva ruta.

**Conflicto al guardar en modo admin**
Es lo esperado si los dos editáis a la vez. La app pregunta qué hacer (sobrescribir / descartar / cancelar). Antes de cualquier sobrescritura, se crea un backup en `\<NAS>\Packs\backups\`.

---

## 9. Notas de seguridad

- Toda comunicación con filesystem va a través de `main.js`. El renderer (la UI) **no** tiene acceso directo al disco.
- `contextIsolation: true` y `nodeIntegration: false`: el código del renderer no puede ejecutar Node.
- `preload.js` expone solo las funciones necesarias (leer/escribir config, settings, diálogos).
- La clave de admin (en `config.js`) es protección anti-clic-accidental, no seguridad real. Cualquiera con acceso al NAS puede leerla.
- Los backups en `<NAS>\Packs\backups\` no se borran automáticamente. Limpia manualmente cada cierto tiempo si crecen mucho.
