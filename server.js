import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import nodemailer from 'nodemailer';
import multer from 'multer';
import dotenv from 'dotenv';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Jei turi logotipą repo, įkelk į ./public/logo.png arba nurodyk per .env -> LOGO_PATH
const LOGO_PATH = process.env.LOGO_PATH || path.join(__dirname, 'public', 'logo.png');

// Failų saugyklos
const DRAFTS_FILE = 'drafts.json';  // mokamų planų juodraščiai iki Payseros
const ORDERS_FILE = 'orders.json';  // užsakymai iš pasiūlymo
const OFFERS_FILE = 'offers.json';  // pasiūlymai (PDF+link), su createdAt

// --- Express
const app = express();
const port = process.env.PORT || 10000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Greitam liveness patikrinimui
app.get('/health', (req, res) => res.json({ ok: true }));

// --- SMTP (pool)
const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || '465', 10),
  secure: true,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  maxConnections: 5,
  maxMessages: 100,
  socketTimeout: 20000,
});
transporter.verify().then(
  () => console.log('SMTP OK'),
  (e) => console.error('SMTP ERROR:', e?.message || e)
);

// --- Helpers
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildQuery(obj) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
}

function buildPayseraRequest(rawParams, projectId, signPassword) {
  const params = { version: 1, projectid: Number(projectId), ...rawParams };
  const q = buildQuery(params);
  const data = Buffer.from(q).toString('base64');
  const sign = crypto.createHash('md5').update(data + signPassword).digest('hex');
  return { data, sign };
}

function verifyPayseraResponse(data, sign, signPassword) {
  const calc = crypto.createHash('md5').update(data + signPassword).digest('hex');
  return calc === (sign || '').toLowerCase();
}

function parsePayseraData(dataB64) {
  const decoded = Buffer.from(dataB64, 'base64').toString('utf8');
  return Object.fromEntries(new URLSearchParams(decoded));
}

function normalizeReturnUrl(plan, rawReturn) {
  const SITE = (process.env.SITE_BASE_URL || 'https://www.raskdali.lt').replace(/\/+$/, '');
  const defaults = {
    Mini: `${SITE}/uzklausa-mini`,
    Standart: `${SITE}/uzklausa-standart`,
    Pro: `${SITE}/uzklausa-pro`,
  };
  const fallback = defaults[plan] || defaults.Mini;
  if (!rawReturn || typeof rawReturn !== 'string') return fallback;
  if (/^https?:\/\//i.test(rawReturn)) return rawReturn;
  if (rawReturn.startsWith('/')) return SITE + rawReturn;
  return fallback;
}

// Atomic write – saugiau, kai kelios užklausos rašo vienu metu
async function atomicWrite(file, data) {
  const tmp = `${file}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// JSON helpers
async function loadJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return {}; }
}
async function saveJson(file, obj) {
  await atomicWrite(file, JSON.stringify(obj, null, 2));
}

// Email footer klientui
const EMAIL_FOOTER_HTML = `
  <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
  <div style="font-family:Arial,sans-serif;font-size:13px;color:#374151;line-height:1.5">
    <div style="font-weight:700;margin-bottom:4px">RaskDali</div>
    <div>El. paštas: <a href="mailto:${escapeHtml(process.env.MAIL_USER || 'info@raskdali.lt')}" style="color:#436BAA;text-decoration:none">${escapeHtml(process.env.MAIL_USER || 'info@raskdali.lt')}</a></div>
    <div>Taisyklės ir sąlygos: <a href="https://www.raskdali.lt/taisykles-ir-salygos" style="color:#436BAA">peržiūrėti</a></div>
    <div>Grąžinimo politika: <a href="https://www.raskdali.lt/grazinimo-politika" style="color:#436BAA">peržiūrėti</a></div>
    <div style="margin-top:8px">Jei turite klausimų – <b>atsakykite į šį laišką</b>.</div>
  </div>
`;

// --- PDF sąskaita su logotipu (jei yra)
async function makeInvoicePdfBuffer({ invoiceNo, buyer, items, total }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const startY = 36;
    let headerBottomY = startY;

    try {
      if (fsSync.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 40, startY, { width: 120 });
        headerBottomY = Math.max(headerBottomY, startY + 60);
      }
    } catch (_) { /* jei failo nėra – be logotipo */ }

    doc.fontSize(11).text('PVM SĄSKAITA–FAKTŪRA', 0, startY, { align: 'right' });
    doc.fontSize(10).text(`Serija/NR: ${invoiceNo}`, { align: 'right' });
    doc.text(`Data: ${new Date().toLocaleDateString('lt-LT')}`, { align: 'right' });

    doc.moveTo(40, headerBottomY + 20).lineTo(555, headerBottomY + 20).strokeColor('#e5e7eb').lineWidth(1).stroke();

    const colLeftX = 40;
    const colRightX = 320;
    let y = headerBottomY + 34;

    doc.fillColor('#111').fontSize(11).text('Pardavėjas:', colLeftX, y);
    doc.fontSize(10).fillColor('#333');
    doc.text('RaskDali / UAB „Magdaris“', colLeftX, y + 14);
    doc.text('Vilniaus g. 3B, Karmėlava, 54448, Lietuva', colLeftX);
    doc.text(`El. paštas: ${process.env.MAIL_USER || 'info@raskdali.lt'}`, colLeftX);
    doc.text('Įmonės kodas: 159941827', colLeftX);
    doc.text('PVM mok. kodas: LT599418219', colLeftX);

    doc.fillColor('#111').fontSize(11).text('Pirkėjas:', colRightX, y);
    doc.fontSize(10).fillColor('#333');
    doc.text(buyer?.name || '', colRightX, y + 14);
    if (buyer?.code) doc.text(`Įmonės kodas: ${buyer.code}`, colRightX);
    if (buyer?.vat)  doc.text(`PVM kodas: ${buyer.vat}`, colRightX);
    if (buyer?.addr) doc.text(`Adresas: ${buyer.addr}`, colRightX);
    if (buyer?.email)doc.text(`El. paštas: ${buyer.email}`, colRightX);

    y = doc.y + 16;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
    y += 10;

    doc.fontSize(10).fillColor('#111').text('Prekė / paslauga', 40, y);
    doc.text('Kaina su PVM', 420, y, { width: 80, align: 'right' });
    y += 6;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
    y += 8;

    doc.fontSize(10).fillColor('#333');
    items.forEach((it, i) => {
      doc.text(`${i + 1}. ${it.name || ''}`, 40, y, { width: 360 });
      doc.text(`${Number(it.price || 0).toFixed(2)} €`, 420, y, { width: 80, align: 'right' });
      y = doc.y + 4;
      if (it.desc) {
        doc.fillColor('#666').fontSize(9).text(it.desc, 60, y, { width: 340 });
        doc.fontSize(10).fillColor('#333');
        y = doc.y + 4;
      }
      doc.moveTo(40, y).lineTo(555, y).strokeColor('#f1f5f9').lineWidth(1).stroke();
      y += 8;
    });

    doc.fontSize(11).fillColor('#111');
    doc.text(`Iš viso su PVM: ${Number(total || 0).toFixed(2)} €`, 0, y + 8, { align: 'right' });

    doc.end();
  });
}

// --- Drafts/Orders/Offers cache
let offersCache = {};
let draftsCache = {};
let ordersCache = {};

async function ensureCaches() {
  offersCache = await loadJson(OFFERS_FILE);
  draftsCache = await loadJson(DRAFTS_FILE);
  ordersCache = await loadJson(ORDERS_FILE);
}
await ensureCaches();

// =======================================================
//  finalizeOrder — siunčia laiškus (mokami planai po Payseros)
// =======================================================
async function finalizeOrder(orderid, reason = 'unknown') {
  const draft = draftsCache[orderid];
  if (!draft) {
    console.log(`[finalizeOrder] draft not found for ${orderid} (reason=${reason})`);
    return false;
  }
  if (draft.emailed) {
    delete draftsCache[orderid];
    await saveJson(DRAFTS_FILE, draftsCache);
    console.log(`[finalizeOrder] already emailed, cleanup ${orderid}`);
    return true;
  }

  const { plan, vin, marke, modelis, metai, komentaras, vardas, email, tel, items } = draft;

  const logoUrl = 'https://assets.zyrosite.com/A0xl6GKo12tBorNO/rask-dali-siauras-YBg7QDW7g6hKw3WD.png';
  const top = `
    <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif">
      <tr><td style="padding:16px 0"><img src="${logoUrl}" alt="RaskDali" style="height:26px"></td></tr>
    </table>
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
      <p style="margin:0 0 12px 0"><b>Planas:</b> ${escapeHtml(plan)} &nbsp;|&nbsp; <b>Detalių (užpildyta):</b> ${items.length}</p>
      <p style="margin:0 0 12px 0"><b>VIN:</b> ${escapeHtml(vin)} &nbsp;|&nbsp; <b>Markė:</b> ${escapeHtml(marke)} &nbsp;|&nbsp; <b>Modelis:</b> ${escapeHtml(modelis)} &nbsp;|&nbsp; <b>Metai:</b> ${escapeHtml(metai)}</p>
      <p style="margin:0 0 12px 0"><b>Vardas/įmonė:</b> ${escapeHtml(vardas)} &nbsp;|&nbsp; <b>El. paštas:</b> ${escapeHtml(email)} &nbsp;|&nbsp; <b>Tel.:</b> ${escapeHtml(tel)}</p>
      ${komentaras ? `<p style="margin:0 0 12px 0"><b>Komentarai:</b> ${escapeHtml(komentaras)}</p>` : ''}
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
    </div>`;

  const adminItems = (items || []).map((it, idx) => {
    const img = it.file ? `<div style="margin-top:6px"><img src="cid:item${idx}_cid" style="max-width:320px;border:1px solid #eee;border-radius:6px"></div>` : '';
    const title = it.name ? escapeHtml(it.name) : '(be pavadinimo)';
    return `<div style="padding:10px 12px;border:1px solid #eee;border-radius:10px;margin:8px 0">
      <div style="font-weight:600">#${it.idx}: ${title}</div>
      ${it.desc ? `<div><b>Aprašymas:</b> ${escapeHtml(it.desc)}</div>` : ''}
      ${it.notes ? `<div><b>Pastabos:</b> ${escapeHtml(it.notes)}</div>` : ''}
      ${img}
    </div>`;
  }).join('');

  const adminHtml = `${top}<div style="font-family:Arial,sans-serif;font-size:14px">${adminItems}</div>`;
  const attachments = (items || []).map((it, idx) => {
    if (!it.file) return null;
    return {
      filename: it.file.filename,
      content: Buffer.from(it.file.base64, 'base64'),
      contentType: it.file.mimetype,
      cid: `item${idx}_cid`,
    };
  }).filter(Boolean);

  const adminAddr = process.env.MAIL_USER || 'info@raskdali.lt';

  try {
    transporter.sendMail({
      from: `"RaskDali" <${adminAddr}>`,
      to: adminAddr,
      subject: `Užklausa (${plan}) – ${vardas || 'klientas'} (order ${orderid}, via ${reason})`,
      html: adminHtml,
      attachments,
    }).catch(e => console.error('MAIL admin error:', e));

    if (email) {
      const clientHtml = `
        ${top}
        <div style="font-family:Arial,sans-serif;font-size:14px">
          <h2 style="margin:6px 0 10px 0">Jūsų užklausa apmokėta ir priimta 🎉</h2>
          <p>Ačiū! Gavome Jūsų apmokėjimą ir užklausą (<b>${escapeHtml(plan)}</b>). Mūsų komanda paruoš <b>detalių pasiūlymą artimiausiu metu</b> (paprastai per 24–48 val.).</p>
        </div>
        ${EMAIL_FOOTER_HTML}
      `;
      transporter.sendMail({
        from: `"RaskDali" <${adminAddr}>`,
        to: email,
        subject: 'Jūsų užklausa apmokėta ir priimta – RaskDali',
        html: clientHtml,
      }).catch(e => console.error('MAIL client error:', e));
    }

    draft.emailed = true;
    delete draftsCache[orderid];
    await saveJson(DRAFTS_FILE, draftsCache);

    console.log(`[finalizeOrder] emails queued for ${orderid} (reason=${reason})`);
    return true;
  } catch (mailErr) {
    console.error('[finalizeOrder] MAIL SEND ERROR:', mailErr);
    return false;
  }
}

// =======================================================
// 1) MOKAMI PLANAI: /api/uzklausa-start → Paysera
// =======================================================
const uploadPaid = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 40 } });

app.post('/api/uzklausa-start', uploadPaid.any(), async (req, res, next) => {
  try {
    const vin   = (req.body.vin || '').trim();
    const marke = (req.body.marke || '').trim();
    const modelis = (req.body.modelis || '').trim();
    const metai = (req.body.metai || '').trim();

    const komentaras = (req.body.komentaras || '').trim();
    const vardas     = (req.body.vardas || '').trim();
    const email      = (req.body.email || '').trim();
    const tel        = (req.body.tel || '').trim();

    const plan  = (req.body.plan || 'Mini').trim();
    const count = Math.max(1, parseInt(req.body.count || '5', 10));

    const items = [];
    for (let i = 0; i < count; i++) {
      const name  = (req.body[`items[${i}][name]`]  || req.body[`item_${i}_name`]  || '').trim();
      const desc  = (req.body[`items[${i}][desc]`]  || req.body[`item_${i}_desc`]  || '').trim();
      const notes = (req.body[`items[${i}][notes]`] || req.body[`item_${i}_notes`] || '').trim();
      const file  = (req.files || []).find(f => f.fieldname === `items[${i}][image]` || f.fieldname === `item_${i}_image`);
      if (!(name || desc || notes || file)) continue;

      let fileStored = null;
      if (file) {
        fileStored = {
          filename: file.originalname || `detale_${i + 1}.jpg`,
          mimetype: file.mimetype || 'application/octet-stream',
          base64: Buffer.from(file.buffer).toString('base64')
        };
      }
      items.push({ idx: i + 1, name, desc, notes, file: fileStored });
    }

    if (!items.length) return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });

    const orderid = nanoid();

    draftsCache[orderid] = {
      ts: Date.now(), emailed: false,
      plan, count, vin, marke, modelis, metai, komentaras, vardas, email, tel, items
    };
    await saveJson(DRAFTS_FILE, draftsCache);

    const AMOUNTS = { Mini: 999, Standart: 2999, Pro: 5999 }; // centais
    const amount = AMOUNTS[plan] ?? AMOUNTS.Mini;

    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const returnUrl = normalizeReturnUrl(plan, req.body.return || '');

    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent(returnUrl)}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent(returnUrl)}`;

    const { data, sign } = buildPayseraRequest({
      orderid, amount,
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl, cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? 1 : 0
    }, process.env.PAYSERA_PROJECT_ID, process.env.PAYSERA_PASSWORD);

    res.json({ pay_url: `https://bank.paysera.com/pay/?data=${encodeURIComponent(data)}&sign=${sign}` });
  } catch (e) {
    console.error('UZKLAUSA-START ERROR:', e);
    next(e);
  }
});

// =======================================================
// 2) Paysera CALLBACK → finalizeOrder(orderid)
// =======================================================
app.post('/api/paysera/callback', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { data, sign } = req.body || {};
    if (!data || !sign) return res.status(400).send('ERROR');
    if (!verifyPayseraResponse(data, sign, process.env.PAYSERA_PASSWORD)) {
      console.error('PAYSERA CALLBACK: sign mismatch');
      return res.status(400).send('ERROR');
    }
    const payload = parsePayseraData(data);
    const orderid = payload.orderid;
    const statusOk = String(payload.status || '') === '1';
    if (statusOk) {
      finalizeOrder(orderid, 'callback').catch(e => console.error('finalizeOrder err:', e));
    } else {
      console.log('CALLBACK status!=1 for', orderid, 'status=', payload.status);
    }
    res.send('OK');
  } catch (e) {
    console.error('PAYSERA CALLBACK ERROR:', e);
    res.status(400).send('ERROR');
  }
});

// =======================================================
// 3) Ačiū ekranas — atsakymas greitai
// =======================================================
app.get('/thanks', async (req, res) => {
  const ok = req.query.ok === '1';
  const orderid = (req.query.o || '').toString();
  const siteHome = (process.env.SITE_BASE_URL || 'https://www.raskdali.lt').replace(/\/+$/, '');

  if (ok && orderid) {
    finalizeOrder(orderid, 'return').catch(e => console.error('finalizeOrder err:', e));
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<meta charset="utf-8">
<title>${ok ? 'Užklausa apmokėta ir išsiųsta' : 'Mokėjimas neįvyko'}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;margin:0;display:grid;place-items:center;height:100dvh}
  .card{max-width:640px;padding:28px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px #00000014;text-align:center}
  .ok{color:#16a34a;font-size:26px;font-weight:800;margin:10px 0}
  .fail{color:#ef4444;font-size:26px;font-weight:800;margin:10px 0}
  p{font-size:16px;color:#374151}
  a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600}
</style>
<div class="card">
  <div class="${ok ? 'ok' : 'fail'}">${ok ? 'Ačiū! Jūsų užklausa sėkmingai apmokėta ir išsiųsta.' : 'Mokėjimas neįvyko.'}</div>
  <p>${ok ? 'Užsakymas vykdomas tik gavus apmokėjimą. Laukite detalių pasiūlymo artimiausiu metu.' : 'Galite pabandyti dar kartą arba susisiekti su mumis.'}</p>
  <a class="btn" href="${escapeHtml(siteHome)}">Eiti į pradžią</a>
</div>`);
});

// =======================================================
// 4) Nemokamas planas
// =======================================================
const uploadFree = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024, files: 20 } });

async function handleFreeRequest(req, res, next) {
  try {
    const vin      = (req.body.vin || '').trim();
    const marke    = (req.body.marke || '').trim();
    const modelis  = (req.body.modelis || '').trim();
    const metai    = (req.body.metai || '').trim();

    const komentaras = (req.body.komentaras || '').trim();
    const vardas     = (req.body.vardas || '').trim();
    const email      = (req.body.email || '').trim();
    const tel        = (req.body.tel || '').trim();

    const plan  = (req.body.plan || 'Nemokama paieška 1–2 detalių').trim();
    const count = Math.max(1, parseInt(req.body.count || '2', 10));

    const items = [];
    for (let i = 0; i < count; i++) {
      const name  = (req.body[`items[${i}][name]`]  || req.body[`item_${i}_name`]  || '').trim();
      const desc  = (req.body[`items[${i}][desc]`]  || req.body[`item_${i}_desc`]  || '').trim();
      const notes = (req.body[`items[${i}][notes]`] || req.body[`item_${i}_notes`] || '').trim();
      const file  = (req.files || []).find(f => f.fieldname === `items[${i}][image]` || f.fieldname === `item_${i}_image`);
      if (!(name || desc || notes || file)) continue;

      let attach = null;
      if (file) {
        attach = {
          filename: file.originalname || `detale_${i + 1}.jpg`,
          content: file.buffer,
          contentType: file.mimetype || 'application/octet-stream'
        };
      }
      items.push({ idx: i + 1, name, desc, notes, attach });
    }

    if (!items.length) return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });

    // atsakome greitai
    res.json({ ok: true });

    const logoUrl = 'https://assets.zyrosite.com/A0xl6GKo12tBorNO/rask-dali-siauras-YBg7QDW7g6hKw3WD.png';
    const commonTop = `
      <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif">
        <tr><td style="padding:16px 0"><img src="${logoUrl}" alt="RaskDali" style="height:26px"></td></tr>
      </table>
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
        <p style="margin:0 0 12px 0"><b>Planas:</b> ${escapeHtml(plan)} &nbsp;|&nbsp; <b>Detalių (užpildyta):</b> ${items.length}</p>
        <p style="margin:0 0 12px 0"><b>VIN:</b> ${escapeHtml(vin)} &nbsp;|&nbsp; <b>Markė:</b> ${escapeHtml(marke)} &nbsp;|&nbsp; <b>Modelis:</b> ${escapeHtml(modelis)} &nbsp;|&nbsp; <b>Metai:</b> ${escapeHtml(metai)}</p>
        <p style="margin:0 0 12px 0"><b>Vardas/įmonė:</b> ${escapeHtml(vardas)} &nbsp;|&nbsp; <b>El. paštas:</b> ${escapeHtml(email)} &nbsp;|&nbsp; <b>Tel.:</b> ${escapeHtml(tel)}</p>
        ${komentaras ? `<p style="margin:0 0 12px 0"><b>Komentarai:</b> ${escapeHtml(komentaras)}</p>` : ''}
        <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
      </div>
    `;

    const adminItemsHtml = items.map((it) => `
      <div style="padding:10px 12px;border:1px solid #eee;border-radius:10px;margin:8px 0">
        <div style="font-weight:600">#${it.idx}: ${escapeHtml(it.name || '(be pavadinimo)')}</div>
        ${it.desc  ? `<div><b>Aprašymas:</b> ${escapeHtml(it.desc)}</div>`   : ''}
        ${it.notes ? `<div><b>Pastabos:</b> ${escapeHtml(it.notes)}</div>`   : ''}
      </div>
    `).join('');

    const adminAttachments = items.map(it => it.attach).filter(Boolean);
    const adminAddr = process.env.MAIL_USER || 'info@raskdali.lt';

    transporter.sendMail({
      from: `"RaskDali" <${adminAddr}>`,
      to: adminAddr,
      subject: `Nemokama užklausa – ${vardas || 'klientas'}`,
      html: `${commonTop}<div style="font-family:Arial,sans-serif;font-size:14px">${adminItemsHtml}</div>`,
      attachments: adminAttachments
    }).catch(e => console.error('FREE admin mail err:', e));

    if (email) {
      transporter.sendMail({
        from: `"RaskDali" <${adminAddr}>`,
        to: email,
        subject: 'Jūsų nemokama užklausa gauta – RaskDali',
        html: `
          ${commonTop}
          <div style="font-family:Arial,sans-serif;font-size:14px">
            <h2 style="margin:6px 0 10px 0">Jūsų užklausa gauta 🎉</h2>
            <p>Ačiū! Gavome Jūsų nemokamą užklausą (1–2 detalės). Dažniausiai atsakome per <b>24–48 val.</b></p>
          </div>
          ${EMAIL_FOOTER_HTML}
        `
      }).catch(e => console.error('FREE client mail err:', e));
    }
  } catch (err) {
    console.error('FREE ERROR:', err);
    next(err);
  }
}
app.post('/api/uzklausa_free', uploadFree.any(), handleFreeRequest);
app.post('/api/uzklausa-free', uploadFree.any(), handleFreeRequest);

// =======================================================
// 5) Pasiūlymai (offers) — 7 d. galiojimas
// =======================================================
app.post('/api/sukurti-pasiulyma', async (req, res, next) => {
  try {
    const data = req.body; // { items: [...] }
    const id = nanoid(6);
    offersCache[id] = { ...data, createdAt: Date.now() };
    await saveJson(OFFERS_FILE, offersCache);
    res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
  } catch (e) {
    console.error('CREATE OFFER ERROR:', e);
    next(e);
  }
});

app.get('/klientoats/:id', (req, res) => {
  const offer = offersCache[req.params.id];
  if (!offer) return res.status(404).send('Pasiūlymas nerastas');

  const MAX_AGE_DAYS = 7;
  const tooOld = !offer.createdAt || (Date.now() - offer.createdAt) > MAX_AGE_DAYS * 24 * 3600 * 1000;
  if (tooOld) {
    return res.status(410).send(`
      <meta charset="utf-8">
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto">
        <h2>Šios nuorodos galiojimas pasibaigė</h2>
        <p>Jei vis dar norite įsigyti detales, parašykite mums – atnaujinsime pasiūlymą.</p>
      </div>
    `);
  }

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Detalių pasiūlymas</title>
<style>
  body{font-family:Arial, sans-serif
