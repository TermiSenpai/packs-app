// Vitest se ejecuta en Node (los tests no tocan DOM ni Electron).
// Importamos los módulos puros (calculo.js, config.default.js,
// lib/config-parser.js). Vitest soporta tanto ESM (calculo.js)
// como CJS (config-parser.js, config.default.js) sin configuración extra.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    globals: false
  }
});
