// ============================================================
// Helpers de DOM y formato
// ============================================================
// Sin estado, sin lógica de negocio. Reutilizables y testeables.
// ============================================================

export function el(id) {
  return document.getElementById(id);
}

export function show(id) {
  el(id).classList.remove('hidden');
}

export function hide(id) {
  el(id).classList.add('hidden');
}

export function intDe(id) {
  return parseInt(el(id).value, 10) || 0;
}

export function fmtEur(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return num.toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + ' €';
}

export function fmtPct(num) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  return (num * 100).toFixed(1) + ' %';
}

export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
