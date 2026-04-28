// ============================================================
// PackPrice · Lógica de cálculo (puro)
// ============================================================
// Funciones puras: dados (cfg, opciones) devuelven el resultado.
// No tocan el DOM, ni el filesystem, ni variables globales.
// Esto permite testarlas en aislamiento (ver CLAUDE.md §7).
// ============================================================

/**
 * Devuelve el tramo de volumen que corresponde a una cantidad,
 * o null si no encaja en ninguno (cantidad < min de T1).
 */
export function getTramo(cfg, cantidad) {
  for (const t of cfg.tramos) {
    const cumpleMin = cantidad >= t.desde;
    const cumpleMax = (t.hasta === null) || (cantidad <= t.hasta);
    if (cumpleMin && cumpleMax) return t;
  }
  return null;
}

/**
 * Coste real de fabricar una prenda terminada (Roly + DTF + planchado +
 * merma + mano de obra + indirectos + envío prorrateado).
 *
 * @param cfg                       configuración completa
 * @param modeloId                  clave de cfg.modelos_roly (BEAGLE, etc.)
 * @param caras                     1 o 2
 * @param tramo                     tramo ya resuelto (objeto)
 * @param totalPrendasParaEnvio     prendas totales del pedido para prorrateo
 */
export function calcularCostePrenda(cfg, modeloId, caras, tramo, totalPrendasParaEnvio) {
  const m = cfg.modelos_roly[modeloId];
  const p = cfg.parametros;

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

/**
 * Pack peña: combina camiseta BEAGLE + sudadera (CLASICA o URBAN según
 * `capucha`). El tramo se calcula sobre la cantidad de packs.
 */
export function calcularPackPena(cfg, opt) {
  const { cantidad, capucha, caras, cant_4xl, cant_5xl } = opt;
  const pack = cfg.packs.pena_completa;

  if (cantidad < pack.min) {
    return { error: `Mínimo ${pack.min} packs para "${pack.nombre}".` };
  }

  const tramo = getTramo(cfg, cantidad);
  const carasKey = (caras === 2) ? 'dos_caras' : 'una_cara';
  const capuchaKey = (capucha === 'con') ? 'con_capucha' : 'sin_capucha';
  const pvpUnit = pack.pvp[capuchaKey][carasKey][tramo.id];

  const totalPrendas = cantidad * 2;
  const sudaderaModelo = (capucha === 'con') ? 'URBAN' : 'CLASICA';
  const costeCamiseta = calcularCostePrenda(cfg, 'BEAGLE', caras, tramo, totalPrendas);
  const costeSudadera = calcularCostePrenda(cfg, sudaderaModelo, caras, tramo, totalPrendas);
  const buffer3xl = cfg.parametros.buffer_3xl_eur_pack;
  const costePack = costeCamiseta.total + costeSudadera.total + buffer3xl;

  return calcularTotales(cfg, {
    pack: pack.nombre, tramo: tramo.etiqueta, cantidad,
    pvp_unitario: pvpUnit, coste_unitario: costePack,
    cant_4xl, cant_5xl,
    detalle_extra: { capucha: capuchaKey, caras }
  });
}

/**
 * Packs individuales: solo camisetas, solo CLASICA, solo URBAN.
 */
export function calcularPackIndividual(cfg, packId, opt) {
  const { cantidad, caras, cant_4xl, cant_5xl } = opt;
  const pack = cfg.packs[packId];

  if (cantidad < pack.min) {
    return { error: `Mínimo ${pack.min} unidades para "${pack.nombre}".` };
  }

  const tramo = getTramo(cfg, cantidad);
  const carasKey = (caras === 2) ? 'dos_caras' : 'una_cara';
  const pvpUnit = pack.pvp[carasKey][tramo.id];

  const costeUnit = calcularCostePrenda(cfg, pack.modelo, caras, tramo, cantidad);

  return calcularTotales(cfg, {
    pack: pack.nombre, tramo: tramo.etiqueta, cantidad,
    pvp_unitario: pvpUnit, coste_unitario: costeUnit.total,
    cant_4xl, cant_5xl,
    detalle_extra: { modelo: pack.modelo, caras }
  });
}

/**
 * Pack mixto sudaderas: combina X CLASICA + Y URBAN. El tramo se calcula
 * sobre la suma; cada sudadera se factura a su PVP individual.
 */
export function calcularPackMixto(cfg, opt) {
  const { cant_clasica, cant_urban, caras, cant_4xl, cant_5xl } = opt;
  const pack = cfg.packs.sudaderas_mixto;
  const total = cant_clasica + cant_urban;

  if (total < pack.min_total) {
    return { error: `Mínimo ${pack.min_total} sudaderas en total.` };
  }
  if (cant_clasica === 0 && cant_urban === 0) {
    return { error: 'Indica al menos una cantidad mayor que cero.' };
  }

  const tramo = getTramo(cfg, total);
  const carasKey = (caras === 2) ? 'dos_caras' : 'una_cara';

  const pvpClasica = cfg.packs[pack.packs_referencia.CLASICA].pvp[carasKey][tramo.id];
  const pvpUrban   = cfg.packs[pack.packs_referencia.URBAN].pvp[carasKey][tramo.id];

  const subtotal = (cant_clasica * pvpClasica) + (cant_urban * pvpUrban);
  const recargos = (cant_4xl * cfg.parametros.recargo_4xl_eur)
                 + (cant_5xl * cfg.parametros.recargo_5xl_eur);
  const totalIvaInc = subtotal + recargos;

  const costeClasica = calcularCostePrenda(cfg, 'CLASICA', caras, tramo, total);
  const costeUrban   = calcularCostePrenda(cfg, 'URBAN',   caras, tramo, total);
  const costeTotal = (cant_clasica * costeClasica.total) + (cant_urban * costeUrban.total);

  const baseVenta = totalIvaInc / (1 + cfg.parametros.iva);
  const iva = totalIvaInc - baseVenta;
  const margen = baseVenta - costeTotal;
  const margenPct = totalIvaInc > 0 ? (margen / totalIvaInc) : 0;

  return {
    pack: pack.nombre, tramo: tramo.etiqueta, es_mixto: true,
    cantidad_total: total, cant_4xl, cant_5xl, caras,
    desglose: [
      { modelo: 'CLASICA', nombre: cfg.modelos_roly.CLASICA.nombre, cantidad: cant_clasica, pvp: pvpClasica, subtotal: cant_clasica * pvpClasica },
      { modelo: 'URBAN',   nombre: cfg.modelos_roly.URBAN.nombre,   cantidad: cant_urban,   pvp: pvpUrban,   subtotal: cant_urban * pvpUrban }
    ],
    subtotal, recargos, total_iva_inc: totalIvaInc, base_venta: baseVenta, iva,
    coste_total: costeTotal, margen, margen_pct: margenPct
  };
}

/**
 * Calcula subtotales, IVA y márgenes a partir de cantidad × pvp + recargos.
 * Compartido por pack peña y packs individuales (no mixto).
 */
export function calcularTotales(cfg, datos) {
  const subtotal = datos.cantidad * datos.pvp_unitario;
  const recargos = (datos.cant_4xl * cfg.parametros.recargo_4xl_eur)
                 + (datos.cant_5xl * cfg.parametros.recargo_5xl_eur);
  const totalIvaInc = subtotal + recargos;
  const baseVenta = totalIvaInc / (1 + cfg.parametros.iva);
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
