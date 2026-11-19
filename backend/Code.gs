/**
 * Backend de la Rifa Natura (Google Apps Script).
 * Basado en rifa-template, con columna extra "telefono" (WhatsApp del comprador).
 *
 * NADA específico de la rifa vive acá. Todo se configura así:
 *
 *   Script Properties (Configuración del proyecto → Propiedades del script):
 *     MP_ACCESS_TOKEN   Access Token de Mercado Pago (producción o prueba).   OBLIGATORIA
 *     SHEET_ID          ID de la Google Sheet (lo que está entre /d/ y /edit). OBLIGATORIA
 *     PAGE_URL          URL pública de la página, ej: https://usuario.github.io/rifa-x/
 *                       Se usa para las URLs de retorno de MP y para leer config.json. OBLIGATORIA
 *     WEBAPP_URL        (opcional) URL /exec de esta implementación, para el webhook de MP.
 *                       Si falta, se usa ScriptApp.getService().getUrl().
 *     RESERVA_MINUTOS   (opcional) minutos que dura una reserva. Default 30.
 *     SHEET_NAME        (opcional) nombre de la pestaña. Default "Numeros".
 *
 *   Precios y rango de números: se leen del config.json publicado en PAGE_URL,
 *   así el precio que cobra MP siempre coincide con el que muestra la página.
 *
 * Estados de número: libre / reservado / vendido (minúscula, sin tilde).
 */

const COLS = ['numero', 'estado', 'nombre', 'instagram', 'telefono', 'reservado_hasta', 'ref', 'payment_id', 'actualizado'];
const ANCHO_DATOS = COLS.length - 1;                     // columnas de 'estado' a 'actualizado'
const C = {}; COLS.forEach((c, i) => C[c] = i);          // índice 0-based de cada columna
const MP_API = 'https://api.mercadopago.com';

// =====================================================================
//  Entradas HTTP
// =====================================================================

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  try {
    if (action === 'getNumbers') return json_(getNumbers_());
    // Webhook de MP en formato viejo (IPN): ?topic=payment&id=123
    if (e.parameter.topic === 'payment' && e.parameter.id) {
      procesarPago_(e.parameter.id);
      return json_({ ok: true });
    }
    return json_({ ok: true, msg: 'Backend de rifa funcionando' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Error interno' });
  }
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (_) {}
  const q = (e && e.parameter) || {};

  try {
    // Webhook de Mercado Pago: { type: 'payment', data: { id } }  ó  ?type=payment&data.id=123
    const tipoMP = body.type || body.topic || q.type || q.topic;
    const idMP = (body.data && body.data.id) || q['data.id'] || q.id;
    if (!body.action && tipoMP === 'payment' && idMP) {
      procesarPago_(idMP);
      return json_({ ok: true });
    }

    switch (body.action) {
      case 'reserve':          return json_(reservar_(body));
      case 'createPreference': return json_(crearPreferencia_(body));
      case 'confirm':          return json_(confirmar_(body));
      case 'release':          return json_(liberarPorRef_(body.ref));
      default:                 return json_({ ok: false, error: 'Acción desconocida' });
    }
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: err.publico ? err.message : 'Error interno, probá de nuevo.' });
  }
}

// =====================================================================
//  Acciones
// =====================================================================

/** Lista pública: SOLO número y estado. Nunca nombres, Instagram ni teléfono. */
function getNumbers_() {
  const sh = hoja_();
  const datos = filas_(sh);
  const ahora = Date.now();
  return datos.map(r => {
    let estado = normEstado_(r[C.estado]);
    // Una reserva vencida se muestra libre aunque el trigger todavía no haya corrido.
    if (estado === 'reservado' && venceEn_(r) < ahora) estado = 'libre';
    return { numero: Number(r[C.numero]), estado: estado };
  });
}

function reservar_(b) {
  const numeros = validarNumeros_(b.numeros);
  const nombre = limpiarTexto_(b.nombre, 60);
  const instagram = limpiarTexto_(b.instagram, 60);
  const telefono = limpiarTelefono_(b.telefono);
  if (!nombre || !instagram) throw publico_('Completá tu nombre e Instagram.');
  if (!telefono) throw publico_('Revisá tu número de WhatsApp (con código de área).');

  return conLock_(() => {
    const sh = hoja_();
    const datos = filas_(sh);
    const ahora = new Date();
    const idx = indicePorNumero_(datos);

    const tomados = numeros.filter(n => {
      const r = datos[idx[n]];
      if (!r) return true;
      const est = normEstado_(r[C.estado]);
      return est === 'vendido' || (est === 'reservado' && venceEn_(r) > ahora.getTime());
    });
    if (tomados.length) {
      return { ok: false, error: 'El número ' + tomados.join(', ') + ' ya fue tomado. Elegí otro.' };
    }

    const ref = Utilities.getUuid();
    const hasta = new Date(ahora.getTime() + minutosReserva_() * 60000);
    numeros.forEach(n => {
      const fila = idx[n] + 2; // +1 por encabezado, +1 por base 1
      sh.getRange(fila, C.estado + 1, 1, ANCHO_DATOS).setValues([[
        'reservado', nombre, instagram, telefono, hasta, ref, '', ahora
      ]]);
    });
    return { ok: true, ref: ref, reservado_hasta: hasta.toISOString() };
  });
}

function crearPreferencia_(b) {
  const ref = String(b.ref || '');
  if (!ref) throw publico_('Falta la referencia de la reserva.');

  const filas = filasPorRef_(ref).filter(f => normEstado_(f.r[C.estado]) === 'reservado');
  if (!filas.length) throw publico_('La reserva venció. Elegí tus números de nuevo.');

  const cfg = config_();
  const numeros = filas.map(f => Number(f.r[C.numero])).sort((a, b) => a - b);
  const total = calcularPrecio_(numeros.length, cfg.precios);
  const pageUrl = prop_('PAGE_URL', true);
  const retorno = pageUrl + (pageUrl.indexOf('?') >= 0 ? '&' : '?') + 'nums=' + numeros.join(',');
  const titulo = (cfg.precios && cfg.precios.tituloPago) || cfg.titulo || 'Rifa';

  const pref = {
    items: [{
      title: titulo + ' - ' + numeros.map(n => fmtNum_(n, cfg)).join(', '),   // ej: "Natura - 05, 08, 42"
      quantity: 1,
      unit_price: total,
      currency_id: (cfg.precios && cfg.precios.moneda) || 'ARS'
    }],
    external_reference: ref,
    back_urls: { success: retorno, failure: retorno, pending: retorno },
    auto_return: 'approved',
    notification_url: webappUrl_(),
    // Sin Rapipago / Pago Fácil / cajero: esos se pagan días después y la reserva ya venció.
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
    expires: true,
    expiration_date_to: Utilities.formatDate(new Date(venceEn_(filas[0].r)), 'America/Argentina/Buenos_Aires', "yyyy-MM-dd'T'HH:mm:ss.SSSXXX")
  };
  if (!pref.notification_url) delete pref.notification_url;

  const res = mp_('post', '/checkout/preferences', pref);
  if (!res.init_point) throw new Error('MP no devolvió init_point: ' + JSON.stringify(res));
  return { ok: true, init_point: res.init_point };
}

/** El front llama esto al volver de MP. Igual se valida todo contra la API de MP. */
function confirmar_(b) {
  if (!b.payment_id) throw publico_('Falta payment_id.');
  return procesarPago_(b.payment_id);
}

/**
 * Valida un pago contra /v1/payments/{id} y, si está aprobado, por el monto correcto
 * y con external_reference de una reserva existente, marca esos números como vendidos.
 * Idempotente: se puede llamar varias veces (webhook + retorno) sin problema.
 */
function procesarPago_(paymentId) {
  paymentId = String(paymentId).replace(/[^\d]/g, '');
  if (!paymentId) throw publico_('payment_id inválido.');

  const pago = mp_('get', '/v1/payments/' + paymentId);
  const ref = String(pago.external_reference || '');
  if (!ref) return { ok: false, error: 'Pago sin referencia.' };

  if (pago.status !== 'approved') {
    if (pago.status === 'rejected' || pago.status === 'cancelled') liberarPorRef_(ref);
    return { ok: false, estado: pago.status };
  }

  return conLock_(() => {
    const sh = hoja_();
    const filas = filasPorRef_(ref, sh);
    if (!filas.length) {
      alerta_('Pago aprobado sin reserva (venció o se liberó). Devolver o asignar números a mano.', pago, ref);
      return { ok: false, error: 'Reserva no encontrada. Escribinos por WhatsApp.' };
    }

    const cfg = config_();
    const esperado = calcularPrecio_(filas.length, cfg.precios);
    if (Number(pago.transaction_amount) + 0.01 < esperado) {
      alerta_('Monto menor al esperado ($' + esperado + '). No se marcó como vendido.', pago, ref);
      return { ok: false, error: 'Monto incorrecto. Revisar a mano.' };
    }

    const ahora = new Date();
    const numeros = [];
    const pisados = [];
    filas.forEach(f => {
      const est = normEstado_(f.r[C.estado]);
      const pidPrevio = String(f.r[C.payment_id] || '');
      if (est === 'vendido' && pidPrevio && pidPrevio !== paymentId) {
        // Otro pago ya se quedó con este número: no pisamos.
        pisados.push(fmtNum_(f.r[C.numero], cfg) + ' (pago ' + pidPrevio + ')');
        return;
      }
      sh.getRange(f.fila, C.estado + 1).setValue('vendido');
      sh.getRange(f.fila, C.reservado_hasta + 1).setValue('');
      sh.getRange(f.fila, C.payment_id + 1).setValue(paymentId);
      sh.getRange(f.fila, C.actualizado + 1).setValue(ahora);
      numeros.push(Number(f.r[C.numero]));
    });
    if (pisados.length) alerta_('Números ya vendidos con otro pago: ' + pisados.join(', ') + '. Devolver la parte que corresponda.', pago, ref);
    return { ok: true, numeros: numeros };
  });
}

function liberarPorRef_(ref) {
  ref = String(ref || '');
  if (!ref) return { ok: false };
  return conLock_(() => {
    const sh = hoja_();
    let n = 0;
    filasPorRef_(ref, sh).forEach(f => {
      if (normEstado_(f.r[C.estado]) === 'reservado') { limpiarFila_(sh, f.fila); n++; }
    });
    return { ok: true, liberados: n };
  });
}

// =====================================================================
//  Funciones para correr a mano desde el editor
// =====================================================================

/**
 * Crea (o completa) la pestaña con un número por fila, según config.json.
 * No borra nada: si ya hay filas, solo agrega los números que falten.
 */
function initSheet() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID', true));
  const nombre = prop_('SHEET_NAME') || 'Numeros';
  const sh = ss.getSheetByName(nombre) || ss.insertSheet(nombre);

  if (sh.getLastRow() === 0) {
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
  }

  const cfg = config_(true);
  const desde = Number(cfg.numeros.desde), hasta = Number(cfg.numeros.hasta);
  const existentes = {};
  filas_(sh).forEach(r => existentes[Number(r[C.numero])] = true);

  const nuevas = [];
  for (let n = desde; n <= hasta; n++) {
    if (!existentes[n]) nuevas.push([n, 'libre'].concat(new Array(COLS.length - 2).fill('')));
  }
  if (nuevas.length) sh.getRange(sh.getLastRow() + 1, 1, nuevas.length, COLS.length).setValues(nuevas);
  sh.getRange(2, C.numero + 1, Math.max(sh.getLastRow() - 1, 1), 1).setNumberFormat('0');
  // Teléfono como texto, para que la Sheet no le saque ceros ni lo pase a notación científica.
  sh.getRange(2, C.telefono + 1, Math.max(sh.getLastRow() - 1, 1), 1).setNumberFormat('@');

  console.log('Hoja "' + nombre + '" lista: números ' + desde + '–' + hasta + ' (' + nuevas.length + ' nuevos).');
}

/** Libera reservas vencidas. Lo ejecuta el trigger cada 5 minutos. */
function liberarVencidas() {
  conLock_(() => {
    const sh = hoja_();
    const ahora = Date.now();
    let n = 0;
    filas_(sh).forEach((r, i) => {
      if (normEstado_(r[C.estado]) === 'reservado' && venceEn_(r) < ahora) {
        limpiarFila_(sh, i + 2);
        n++;
      }
    });
    if (n) console.log('Liberadas ' + n + ' reservas vencidas.');
  });
}

/** Instala el trigger de liberarVencidas cada 5 minutos (sin duplicarlo). */
function instalarTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'liberarVencidas')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('liberarVencidas').timeBased().everyMinutes(5).create();
  console.log('Trigger instalado: liberarVencidas cada 5 minutos.');
}

/** Chequeo rápido de que las propiedades y el config están bien. */
function diagnostico() {
  ['MP_ACCESS_TOKEN', 'SHEET_ID', 'PAGE_URL'].forEach(k =>
    console.log(k + ': ' + (prop_(k) ? 'OK' : 'FALTA')));
  const cfg = config_(true);
  console.log('Config: "' + cfg.titulo + '", números ' + cfg.numeros.desde + '–' + cfg.numeros.hasta +
    ', 1 número = $' + calcularPrecio_(1, cfg.precios) + ', 3 números = $' + calcularPrecio_(3, cfg.precios));
  const me = mp_('get', '/users/me');
  console.log('Mercado Pago: cuenta ' + me.id + ' (' + (me.nickname || '') + ')');
}

// =====================================================================
//  Helpers
// =====================================================================

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function publico_(msg) {
  const e = new Error(msg);
  e.publico = true;
  return e;
}

function prop_(k, obligatoria) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (obligatoria && !v) throw new Error('Falta la Script Property ' + k);
  return v ? String(v).trim() : '';
}

function minutosReserva_() {
  return Number(prop_('RESERVA_MINUTOS')) || 30;
}

function webappUrl_() {
  const p = prop_('WEBAPP_URL');
  if (p) return p;
  try { return ScriptApp.getService().getUrl() || ''; } catch (_) { return ''; }
}

function hoja_() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID', true));
  const sh = ss.getSheetByName(prop_('SHEET_NAME') || 'Numeros');
  if (!sh) throw new Error('No existe la pestaña. Corré initSheet().');
  return sh;
}

function filas_(sh) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, COLS.length).getValues().filter(r => r[C.numero] !== '');
}

function indicePorNumero_(datos) {
  const idx = {};
  datos.forEach((r, i) => idx[Number(r[C.numero])] = i);
  return idx;
}

function filasPorRef_(ref, sh) {
  sh = sh || hoja_();
  const out = [];
  filas_(sh).forEach((r, i) => { if (String(r[C.ref]) === ref) out.push({ r: r, fila: i + 2 }); });
  return out;
}

function limpiarFila_(sh, fila) {
  const vacia = new Array(ANCHO_DATOS).fill('');
  vacia[0] = 'libre';
  vacia[ANCHO_DATOS - 1] = new Date();
  sh.getRange(fila, C.estado + 1, 1, ANCHO_DATOS).setValues([vacia]);
}

function normEstado_(e) {
  const s = String(e || '').trim().toLowerCase();
  return s === 'reservado' || s === 'vendido' ? s : 'libre';
}

function venceEn_(r) {
  const v = r[C.reservado_hasta];
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function validarNumeros_(lista) {
  if (!Array.isArray(lista) || !lista.length) throw publico_('Seleccioná al menos un número.');
  const cfg = config_();
  const desde = Number(cfg.numeros.desde), hasta = Number(cfg.numeros.hasta);
  const nums = [...new Set(lista.map(Number))];
  const max = maxPorCompra_(cfg);
  if (nums.length > max) throw publico_('Podés comprar hasta ' + max + ' números por vez.');
  nums.forEach(n => {
    if (!Number.isInteger(n) || n < desde || n > hasta) throw publico_('Número inválido: ' + n);
  });
  return nums.sort((a, b) => a - b);
}

function limpiarTexto_(s, max) {
  // Evita fórmulas inyectadas en la Sheet (=, +, -, @ al inicio).
  return String(s || '').replace(/[\r\n\t]/g, ' ').trim().replace(/^[=+\-@]+/, '').slice(0, max);
}

/** Deja solo dígitos (y un + inicial). Entre 8 y 15 dígitos, si no devuelve ''. */
function limpiarTelefono_(s) {
  const txt = String(s || '').trim();
  const digitos = txt.replace(/\D/g, '');
  if (digitos.length < 8 || digitos.length > 15) return '';
  return (txt.charAt(0) === '+' ? '+' : '') + digitos;
}

function maxPorCompra_(cfg) {
  return Number(cfg.numeros && cfg.numeros.maxPorCompra) || 10;
}

/**
 * Anota un pago que hay que revisar a mano en la pestaña "Alertas" de la misma planilla.
 * No repite la misma alerta para el mismo pago (el webhook y el retorno llaman dos veces).
 */
function alerta_(motivo, pago, ref) {
  console.warn('ALERTA pago ' + pago.id + ': ' + motivo);
  try {
    const ss = SpreadsheetApp.openById(prop_('SHEET_ID', true));
    let sh = ss.getSheetByName('Alertas');
    if (!sh) {
      sh = ss.insertSheet('Alertas');
      sh.appendRow(['fecha', 'payment_id', 'monto', 'pagador', 'ref', 'motivo']);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, 6).setFontWeight('bold');
    }
    const pid = String(pago.id || '');
    const n = sh.getLastRow() - 1;
    if (n > 0 && sh.getRange(2, 2, n, 6).getValues().some(r => String(r[0]).replace(/^'/, '') === pid && r[4] === motivo)) return;
    const payer = pago.payer || {};
    const quien = limpiarTexto_([payer.first_name, payer.last_name].filter(Boolean).join(' ') + (payer.email ? ' <' + payer.email + '>' : ''), 120);
    sh.appendRow([new Date(), "'" + pid, Number(pago.transaction_amount) || '', quien, ref, motivo]);
  } catch (e) {
    console.error('No pude anotar la alerta: ' + e);
  }
}

function conLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw publico_('Hay mucha gente comprando, probá de nuevo en unos segundos.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Lee config.json de la página publicada (cacheado 10 min). */
function config_(sinCache) {
  const cache = CacheService.getScriptCache();
  if (!sinCache) {
    const c = cache.get('config');
    if (c) return JSON.parse(c);
  }
  const base = prop_('PAGE_URL', true).split('?')[0].replace(/index\.html$/, '');
  const url = base + (base.endsWith('/') ? '' : '/') + 'config.json';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (res.getResponseCode() !== 200) throw new Error('No pude leer ' + url + ' (' + res.getResponseCode() + ')');
  const cfg = JSON.parse(res.getContentText());
  if (!cfg.numeros || !cfg.precios || !cfg.precios.unitario) throw new Error('config.json sin "numeros" o "precios.unitario"');
  cache.put('config', JSON.stringify(cfg), 600);
  return cfg;
}

/** Mismo algoritmo que el front: precio mínimo combinando packs y unitario. */
function calcularPrecio_(cantidad, p) {
  const opciones = [{ cantidad: 1, precio: Number(p.unitario) }].concat(
    (p.packs || []).map(x => ({ cantidad: Number(x.cantidad), precio: Number(x.precio) })));
  const mejor = [0];
  for (let i = 1; i <= cantidad; i++) {
    mejor[i] = Infinity;
    opciones.forEach(o => { if (o.cantidad <= i) mejor[i] = Math.min(mejor[i], mejor[i - o.cantidad] + o.precio); });
  }
  return mejor[cantidad];
}

function fmtNum_(n, cfg) {
  return String(n).padStart(Number(cfg.numeros.digitos) || 0, '0');
}

function mp_(metodo, path, payload) {
  const opts = {
    method: metodo,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + prop_('MP_ACCESS_TOKEN', true) }
  };
  if (payload) {
    opts.contentType = 'application/json';
    opts.payload = JSON.stringify(payload);
    opts.headers['X-Idempotency-Key'] = Utilities.getUuid();
  }
  const res = UrlFetchApp.fetch(MP_API + path, opts);
  const code = res.getResponseCode();
  const body = JSON.parse(res.getContentText() || '{}');
  if (code >= 300) throw new Error('Mercado Pago ' + code + ' en ' + path + ': ' + res.getContentText().slice(0, 300));
  return body;
}
