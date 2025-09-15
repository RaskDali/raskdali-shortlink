// server.js – RaskDali API (švarus variantas)

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

/* -------------------- Paths & const -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// LOGO_PATH gali nurodyti PNG/SVG/JPG logotipo kelią sistemoje.
// Jei nėra, tiesiog praleisime logotipą.
const LOGO_PATH = process.env.LOGO_PATH || path.join(__dirname, 'public', 'logo.png');

const DRAFTS_FILE = 'drafts.json'; // mokamų planų juodraščiai iki Payseros
const ORDERS_FILE = 'orders.json'; // užsakymai iš pasiūlymų (PDF, apmokėjimas)
const OFFERS_FILE = 'offers.json'; // pasiūlymai klientams (7 d. galiojimas)

/* -------------------- App -------------------- */
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

app.get('/health', (_req, res) => res.json({ ok: true }));

/* -------------------- SMTP (pool) -------------------- */
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

/* -------------------- Helpers -------------------- */
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildQuery(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
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

// Saugus (atomic) rašymas į failą
async function atomicWrite(file, data) {
  const tmp = `${file}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function loadJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return {}; }
}
async function saveJson(file, obj) {
  await atomicWrite(file, JSON.stringify(obj, null, 2));
}

/* -------------------- Rekvizitai (pardavėjo) -------------------- */
const SELLER = {
  name: 'RaskDali / UAB „Magdaris“',
  addr: 'Vilniaus g. 3B, Karmėlava, 54448, Lietuva',
  code: '159941827',
  vat: 'LT599418219',
  email: process.env.MAIL_USER || 'info@raskdali.lt',
};

/* -------------------- Email footer -------------------- */
const EMAIL_FOOTER_HTML = `
  <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
  <div style="font-family:Arial,sans-serif;font-size:13px;color:#374151;line-height:1.5">
    <div style="font-weight:700;margin-bottom:4px">RaskDali / UAB „Magdaris“</div>
    <div>${escapeHtml(SELLER.addr)}</div>
    <div>Įmonės kodas: ${escapeHtml(SELLER.code)} · PVM mok. kodas: ${escapeHtml(SELLER.vat)}</div>
    <div>El. paštas: <a href="mailto:${escapeHtml(SELLER.email)}" style="color:#436BAA;text-decoration:none">${escapeHtml(SELLER.email)}</a></div>
    <div>Taisyklės ir sąlygos: <a href="https://www.raskdali.lt/taisykles-ir-salygos" style="color:#436BAA">peržiūrėti</a> · Grąžinimo politika: <a href="https://www.raskdali.lt/grazinimo-politika" style="color:#436BAA">peržiūrėti</a></div>
    <div style="margin-top:8px">Turite klausimų? <b>Atsakykite į šį laišką</b>.</div>
  </div>
`;

/* -------------------- PDF sąskaita su logotipu -------------------- */
async function makeInvoicePdfBuffer({ invoiceNo, buyer, items, total }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const startY = 36;
    let headerBottomY = startY;

    // Logotipas (jei yra)
    try {
      if (fsSync.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 40, startY, { width: 120 });
        headerBottomY = Math.max(headerBottomY, startY + 60);
      }
    } catch { /* ok, be logotipo */ }

    // Pavadinimas ir data
    doc.fontSize(12).fillColor('#111').text('PVM SĄSKAITA–FAKTŪRA', 0, startY, { align: 'right' });
    doc.fontSize(10).fillColor('#333').text(`Serija/NR: ${invoiceNo}`, { align: 'right' });
    doc.text(`Data: ${new Date().toLocaleDateString('lt-LT')}`, { align: 'right' });

    // Linija
    doc.moveTo(40, headerBottomY + 20).lineTo(555, headerBottomY + 20).strokeColor('#e5e7eb').lineWidth(1).stroke();

    // Pardavėjas / Pirkėjas
    const colLeftX = 40;
    const colRightX = 320;
    let y = headerBottomY + 34;

    doc.fillColor('#111').fontSize(11).text('Pardavėjas:', colLeftX, y);
    doc.fontSize(10).fillColor('#333');
    doc.text(SELLER.name, colLeftX, y + 14);
    doc.text(SELLER.addr, colLeftX);
    doc.text(`Įmonės kodas: ${SELLER.code}`, colLeftX);
    doc.text(`PVM mok. kodas: ${SELLER.vat}`, colLeftX);
    doc.text(`El. paštas: ${SELLER.email}`, colLeftX);

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

    // Lentelės galvos
    doc.fontSize(10).fillColor('#111').text('Prekė / paslauga', 40, y);
    doc.text('Kaina su PVM', 420, y, { width: 80, align: 'right' });
    y += 6;
    doc.moveTo(40, y).lineTo(555, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
    y += 8;

    // Eilutės
    doc.fontSize(10).fillColor('#333');
    (items || []).forEach((it, i) => {
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

    // Suma
    doc.fontSize(11).fillColor('#111');
    doc.text(`Iš viso su PVM: ${Number(total || 0).toFixed(2)} €`, 0, y + 8, { align: 'right' });

    doc.end();
  });
}

/* -------------------- Cache -------------------- */
let draftsCache = {};
let offersCache = {};
let ordersCache = {};

async function ensureCaches() {
  draftsCache = await loadJson(DRAFTS_FILE);
  offersCache = await loadJson(OFFERS_FILE);
  ordersCache = await loadJson(ORDERS_FILE);
}
await ensureCaches();

/* -------------------- finalizeOrder (mokami planai) -------------------- */
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

  const adminAddr = SELLER.email;

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

/* -------------------- 1) Mokami planai: start → Paysera -------------------- */
const uploadPaid = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 40 },
});

app.post('/api/uzklausa-start', uploadPaid.any(), async (req, res) => {
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
          base64: Buffer.from(file.buffer).toString('base64'),
        };
      }
      items.push({ idx: i + 1, name, desc, notes, file: fileStored });
    }

    if (!items.length) return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });

    const orderid = nanoid();

    draftsCache[orderid] = {
      ts: Date.now(), emailed: false,
      plan, count, vin, marke, modelis, metai, komentaras, vardas, email, tel, items,
    };
    await saveJson(DRAFTS_FILE, draftsCache);

    const AMOUNTS = { Mini: 999, Standart: 2999, Pro: 5999 }; // centais
    const amount = AMOUNTS[plan] ?? AMOUNTS.Mini;

    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const returnUrl = normalizeReturnUrl(plan, req.body.return || '');

    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent(returnUrl)}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent(returnUrl)}`;

    const { data, sign } = buildPayseraRequest({
      orderid,
      amount,
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl,
      cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? 1 : 0,
    }, process.env.PAYSERA_PROJECT_ID, process.env.PAYSERA_PASSWORD);

    res.json({ pay_url: `https://bank.paysera.com/pay/?data=${encodeURIComponent(data)}&sign=${sign}` });
  } catch (e) {
    console.error('UZKLAUSA-START ERROR:', e);
    res.status(400).json({ error: 'Nepavyko pradėti apmokėjimo.' });
  }
});

/* -------------------- 2) Paysera callback -------------------- */
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

    if (statusOk) finalizeOrder(orderid, 'callback').catch(e => console.error('finalizeOrder err:', e));
    else console.log('CALLBACK status!=1 for', orderid, 'status=', payload.status);

    res.send('OK');
  } catch (e) {
    console.error('PAYSERA CALLBACK ERROR:', e);
    res.status(400).send('ERROR');
  }
});

/* -------------------- 3) „Ačiū“ ekranas -------------------- */
app.get('/thanks', async (req, res) => {
  const ok = req.query.ok === '1';
  const orderid = (req.query.o || '').toString();
  const siteHome = (process.env.SITE_BASE_URL || 'https://www.raskdali.lt').replace(/\/+$/, '');

  if (ok && orderid) finalizeOrder(orderid, 'return').catch(e => console.error('finalizeOrder err:', e));

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
  <p>${ok ? 'Laukite detalių pasiūlymo artimiausiu metu.' : 'Galite pabandyti dar kartą arba susisiekti su mumis.'}</p>
  <a class="btn" href="${escapeHtml(siteHome)}">Eiti į pradžią</a>
</div>`);
});

/* -------------------- 4) Nemokamas planas -------------------- */
const uploadFree = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 20 },
});

async function handleFreeRequest(req, res) {
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
          contentType: file.mimetype || 'application/octet-stream',
        };
      }
      items.push({ idx: i + 1, name, desc, notes, attach });
    }

    if (!items.length) return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });

    // atsakome nedelsiant
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
        ${it.desc  ? `<div><b>Aprašymas:</b> ${escapeHtml(it.desc)}</div>` : ''}
        ${it.notes ? `<div><b>Pastabos:</b> ${escapeHtml(it.notes)}</div>` : ''}
      </div>
    `).join('');

    const adminAttachments = items.map(it => it.attach).filter(Boolean);
    const adminAddr = SELLER.email;

    // ADMIN
    transporter.sendMail({
      from: `"RaskDali" <${adminAddr}>`,
      to: adminAddr,
      subject: `Nemokama užklausa – ${vardas || 'klientas'}`,
      html: `${commonTop}<div style="font-family:Arial,sans-serif;font-size:14px">${adminItemsHtml}</div>`,
      attachments: adminAttachments,
    }).catch(e => console.error('FREE admin mail err:', e));

    // KLIENTUI
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
        `,
      }).catch(e => console.error('FREE client mail err:', e));
    }
  } catch (err) {
    console.error('FREE ERROR:', err);
    try { res.status(500).json({ error: 'Serverio klaida. Bandykite dar kartą.' }); } catch {}
  }
}
app.post('/api/uzklausa_free', uploadFree.any(), handleFreeRequest);
app.post('/api/uzklausa-free', uploadFree.any(), handleFreeRequest);

/* -------------------- 5) Pasiūlymai (7 d. galiojimas) -------------------- */
app.post('/api/sukurti-pasiulyma', async (req, res) => {
  try {
    const data = req.body; // { items: [...] }
    const id = nanoid(6);
    offersCache[id] = { ...data, createdAt: Date.now() };
    await saveJson(OFFERS_FILE, offersCache);
    res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
  } catch (e) {
    console.error('CREATE OFFER ERROR:', e);
    res.status(500).json({ error: 'Nepavyko sukurti pasiūlymo' });
  }
});

app.get('/klientoats/:id', (req, res) => {
  const offer = offersCache[req.params.id];
  if (!offer) return res.status(404).send('Pasiūlymas nerastas');

  const MAX_AGE_DAYS = 7;
  const tooOld = !offer.createdAt || (Date.now() - offer.createdAt) > MAX_AGE_DAYS * 24 * 3600 * 1000;
  if (tooOld) {
    return res.status(410).send(`<!doctype html><meta charset="utf-8">
      <div style="font-family:system-ui,sans-serif;max-width:600px;margin:40px auto">
        <h2>Šios nuorodos galiojimas pasibaigė</h2>
        <p>Jei vis dar norite įsigyti detales, parašykite mums – atnaujinsime pasiūlymą.</p>
      </div>`);
  }

  const home = (process.env.SITE_BASE_URL || 'https://www.raskdali.lt').replace(/\/+$/, '');
  const rowsHtml = (offer.items || []).map((item, i) => `
    <div class="item">
      <b>${item.pozNr ? `${item.pozNr}. ` : ''}${escapeHtml(item.name || '')}</b>
      ${item.type ? ` <span class="type">(${escapeHtml(item.type)})</span>` : ''}
      ${item.desc ? `<div class="desc"><i>${escapeHtml(item.desc)}</i></div>` : ''}
      ${item.eta ? `<div>Pristatymas: <b>${escapeHtml(item.eta)}</b></div>` : ''}
      <div>Kaina: <b>${escapeHtml(item['price-vat'] || '')}€</b> ${item['price-novat'] ? `(be PVM ${escapeHtml(item['price-novat'])}€)` : ''}</div>
      ${item.imgSrc ? `<div class="img"><img src="${escapeHtml(item.imgSrc)}" loading="lazy" referrerpolicy="no-referrer" alt=""></div>` : ''}
      <label><input type="checkbox" name="choose" value="${i}"> Užsakyti šią detalę</label>
    </div>
  `).join('');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="lt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Detalių pasiūlymas</title>
<style>
  :root { --line:#e5e7eb; --brand:#436BAA; --muted:#6b7280; }
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f9fafb;margin:0}
  .wrap{max-width:860px;margin:24px auto;background:#fff;border-radius:14px;padding:24px 28px;box-shadow:0 2px 24px #0001}
  .head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .small{color:var(--muted);font-size:12px}
  .item{border-top:1px solid var(--line);padding:14px 0}
  .item:first-child{border-top:none}
  .type{color:#406BBA}
  .desc{color:#374151}
  .img img{max-width:140px;max-height:140px;border:1px solid var(--line);border-radius:10px;margin-top:6px}
  input,button{font-size:14px}
  .btn{background:var(--brand);color:#fff;border:none;border-radius:10px;padding:10px 16px;cursor:pointer}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media (max-width:640px){ .grid{grid-template-columns:1fr} }
</style></head>
<body>
  <div class="wrap">
    <div class="head">
      <h1 style="margin:0">Detalių pasiūlymas</h1>
      <div class="small">Nuoroda galioja 7 d.</div>
    </div>
    <form method="POST" action="/klientoats/${req.params.id}/order">
      <div class="grid">
        <label>Vardas/įmonė<br><input name="vardas" required style="width:100%"></label>
        <label>El. paštas<br><input type="email" name="email" required style="width:100%"></label>
        <label>Pristatymo adresas<br><input name="adresas" required style="width:100%"></label>
      </div>

      <div class="small" style="margin-top:10px">Rekvizitai sąskaitai (nebūtina)</div>
      <div class="grid" style="margin-top:6px">
        <label>Įmonės pavadinimas<br><input name="imone" style="width:100%"></label>
        <label>Įmonės kodas<br><input name="imones_kodas" style="width:100%"></label>
        <label>PVM kodas<br><input name="pvm_kodas" style="width:100%"></label>
        <label>Sąskaitos adresas<br><input name="saskaitos_adresas" style="width:100%"></label>
      </div>

      <hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">
      ${rowsHtml || '<div class="small">Pasiūlymas tusčias.</div>'}
      <button type="submit" class="btn" style="margin-top:12px">Užsakyti pasirinktas</button>
      <a href="${escapeHtml(home)}" style="margin-left:10px">Į pradžią</a>
    </form>
  </div>
</body></html>`);
});

/* -------------------- 6) Užsakymas iš pasiūlymo -------------------- */
app.post('/klientoats/:id/order', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const offer = offersCache[req.params.id];
    if (!offer) return res.status(404).send('Nerasta');

    const pasirinktos = req.body.choose ? (Array.isArray(req.body.choose) ? req.body.choose : [req.body.choose]) : [];
    const name    = (req.body.vardas || '').trim();
    const email   = (req.body.email || '').trim();
    const adresas = (req.body.adresas || '').trim();

    const buyer = {
      name: (req.body.imone || name || '').trim(),
      code: (req.body.imones_kodas || '').trim(),
      vat:  (req.body.pvm_kodas || '').trim(),
      addr: (req.body.saskaitos_adresas || adresas || '').trim(),
      email,
    };

    let total = 0;
    const pasirinktosPrekes = pasirinktos.map(i => offer.items[i]).filter(Boolean);
    const cleanItems = pasirinktosPrekes.map(it => {
      const price = parseFloat(String(it?.['price-vat'] ?? '0').replace(',', '.')) || 0;
      total += price;
      return { name: it?.name || '', desc: it?.desc || '', price };
    });

    const orderid = nanoid();
    ordersCache[orderid] = {
      ts: Date.now(),
      offerId: req.params.id,
      buyer,
      items: cleanItems,
      total,
      status: 'pending_payment',
    };
    await saveJson(ORDERS_FILE, ordersCache);

    // Paysera link
    const amountCents = Math.round(total * 100);
    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const qp = new URLSearchParams({
      version: '1',
      projectid: String(Number(process.env.PAYSERA_PROJECT_ID)),
      orderid,
      amount: String(amountCents),
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl,
      cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? '1' : '0',
    }).toString();
    const dataB64 = Buffer.from(qp).toString('base64');
    const sign = crypto.createHash('md5').update(dataB64 + process.env.PAYSERA_PASSWORD).digest('hex');
    const payUrl = `https://bank.paysera.com/pay/?data=${encodeURIComponent(dataB64)}&sign=${sign}`;

    // PDF sąskaita
    const invoiceNo = `RD-${new Date().getFullYear()}-${orderid.slice(0, 6).toUpperCase()}`;
    const pdfBuffer = await makeInvoicePdfBuffer({ invoiceNo, buyer, items: cleanItems, total });

    const detalesHtml = cleanItems.map(it => `
      <li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} € ${it.desc ? `<br><i>${escapeHtml(it.desc)}</i>` : ''}</li>
    `).join('');

    // Laiškai
    const adminHtml = `
      <h3>Užsakymas iš pasiūlymo</h3>
      <p><b>OrderID:</b> ${orderid}</p>
      <p><b>Pirkėjas:</b> ${escapeHtml(buyer.name)} ${buyer.code ? ' | ' + escapeHtml(buyer.code) : ''} ${buyer.vat ? ' | ' + escapeHtml(buyer.vat) : ''}</p>
      <p><b>El. paštas:</b> ${escapeHtml(email)}</p>
      <p><b>Adresas:</b> ${escapeHtml(buyer.addr || adresas)}</p>
      <ul>${detalesHtml}</ul>
      <p><b>Viso su PVM:</b> ${total.toFixed(2)} €</p>
      <p><a href="${payUrl}" target="_blank">Apmokėti per Paysera</a></p>
    `;
    transporter.sendMail({
      from: `"RaskDali" <${SELLER.email}>`,
      to: SELLER.email,
      subject: `Naujas užsakymas iš pasiūlymo – ${name || buyer.name || 'klientas'} (order ${orderid})`,
      html: adminHtml,
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdfBuffer }],
    }).catch(e => console.error('offer→admin mail err:', e));

    if (email) {
      transporter.sendMail({
        from: `"RaskDali" <${SELLER.email}>`,
        to: email,
        subject: `Sąskaita apmokėjimui – ${invoiceNo}`,
        html: `
          <h2>Jūsų pasirinktos prekės</h2>
          <ul>${detalesHtml}</ul>
          <p>Viso su PVM: <b>${total.toFixed(2)} €</b></p>
          <p>Norėdami apmokėti, spauskite: <a href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
          <p>Prisegame sąskaitą PDF formatu.</p>
          ${EMAIL_FOOTER_HTML}
        `,
        attachments: [{ filename: `${invoiceNo}.pdf}`, content: pdfBuffer }],
      }).catch(e => console.error('offer→client mail err:', e));
    }

    // UI atsakymas
    res.send(`<!doctype html><meta charset="utf-8">
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;margin:0;display:grid;place-items:center;height:100dvh}
        .card{max-width:640px;padding:28px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px #00000014;text-align:center}
        a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600}
      </style>
      <div class="card">
        <h2>Ačiū! Jūsų užsakymas priimtas.</h2>
        <p>Į el. paštą išsiuntėme sąskaitą su apmokėjimo nuoroda.</p>
        <p>Norite apmokėti dabar? <br><a class="btn" href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
        <a class="btn" href="https://www.raskdali.lt/">Grįžti į pradžią</a>
      </div>`);
  } catch (e) {
    console.error('ORDER FROM OFFER ERROR:', e);
    res.status(500).send('Serverio klaida');
  }
});

/* -------------------- 7) Pagalbiniai servisai -------------------- */
app.get('/api/invoice/:orderid', async (req, res) => {
  try {
    const o = ordersCache[req.params.orderid];
    if (!o) return res.status(404).send('Nerasta');
    const invoiceNo = `RD-${new Date(o.ts).getFullYear()}-${req.params.orderid.slice(0, 6).toUpperCase()}`;
    const pdf = await makeInvoicePdfBuffer({ invoiceNo, buyer: o.buyer, items: o.items, total: o.total });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoiceNo}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('INVOICE FETCH ERROR:', e);
    res.status(500).send('Serverio klaida');
  }
});

app.post('/api/orders/:orderid/resend', async (req, res) => {
  try {
    const o = ordersCache[req.params.orderid];
    if (!o) return res.status(404).json({ error: 'Nerasta' });
    if (!o.buyer?.email) return res.status(400).json({ error: 'Nėra kliento el. pašto' });

    const amountCents = Math.round(o.total * 100);
    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(req.params.orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(req.params.orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const qp = new URLSearchParams({
      version: '1',
      projectid: String(Number(process.env.PAYSERA_PROJECT_ID)),
      orderid: req.params.orderid,
      amount: String(amountCents),
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl,
      cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? '1' : '0',
    }).toString();
    const dataB64 = Buffer.from(qp).toString('base64');
    const sign = crypto.createHash('md5').update(dataB64 + process.env.PAYSERA_PASSWORD).digest('hex');
    const payUrl = `https://bank.paysera.com/pay/?data=${encodeURIComponent(dataB64)}&sign=${sign}`;

    const invoiceNo = `RD-${new Date(o.ts).getFullYear()}-${req.params.orderid.slice(0, 6).toUpperCase()}`;
    const pdf = await makeInvoicePdfBuffer({ invoiceNo, buyer: o.buyer, items: o.items, total: o.total });

    await transporter.sendMail({
      from: `"RaskDali" <${SELLER.email}>`,
      to: o.buyer.email,
      subject: `Sąskaita apmokėjimui – ${invoiceNo}`,
      html: `
        <h2>Jūsų pasirinktos prekės</h2>
        <ul>${o.items.map(it => `<li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} €</li>`).join('')}</ul>
        <p>Viso su PVM: <b>${o.total.toFixed(2)} €</b></p>
        <p>Apmokėti: <a href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
        ${EMAIL_FOOTER_HTML}
      `,
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdf }],
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('RESEND ERROR:', e);
    res.status(500).json({ error: 'Nepavyko persiųsti' });
  }
});

/* -------------------- Error handler & Start -------------------- */
app.use((err, req, res, next) => {
  console.error('UNCAUGHT ERROR:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Serverio klaida' });
});

app.listen(port, () => {
  console.log(`Serveris paleistas ant ${port}`);
});
