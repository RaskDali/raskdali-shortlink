import express from 'express';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import nodemailer from 'nodemailer';
import multer from 'multer';
import dotenv from 'dotenv';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

/* -------------------- Middleware -------------------- */
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* -------------------- SMTP (pool – greičiau) -------------------- */
const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || '465', 10),
  secure: true,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  maxConnections: 5,
  maxMessages: 100,
  socketTimeout: 20000
});
transporter.verify().then(
  () => console.log('SMTP OK'),
  (e) => console.error('SMTP ERROR:', e?.message || e)
);

/* -------------------- Helpers -------------------- */
const DRAFTS_FILE = 'drafts.json'; // mokamų planų juodraščiai iki Payseros patvirtinimo
const ORDERS_FILE = 'orders.json'; // užsakymai iš pasiūlymo
const OFFERS_FILE = 'offers.json'; // pasiūlymai (PDF + nuoroda)

async function loadDrafts() { try { return JSON.parse(await fs.readFile(DRAFTS_FILE, 'utf8')); } catch { return {}; } }
async function saveDrafts(d) { await fs.writeFile(DRAFTS_FILE, JSON.stringify(d, null, 2)); }

async function loadOrders() { try { return JSON.parse(await fs.readFile(ORDERS_FILE, 'utf8')); } catch { return {}; } }
async function saveOrders(o) { await fs.writeFile(ORDERS_FILE, JSON.stringify(o, null, 2)); }

let offers = {};
try { offers = JSON.parse(await fs.readFile(OFFERS_FILE, 'utf8')); } catch { offers = {}; }

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
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
    Mini:     `${SITE}/uzklausa-mini`,
    Standart: `${SITE}/uzklausa-standart`,
    Pro:      `${SITE}/uzklausa-pro`,
  };
  const fallback = defaults[plan] || defaults.Mini;
  if (!rawReturn || typeof rawReturn !== 'string') return fallback;
  if (/^https?:\/\//i.test(rawReturn)) return rawReturn;
  if (rawReturn.startsWith('/')) return SITE + rawReturn;
  return fallback;
}

/* -------------------- El. laiškų footeris (klientui) -------------------- */
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

/* -------------------- PDF sąskaita -------------------- */
async function makeInvoicePdfBuffer({ invoiceNo, buyer, items, total }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (b) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Sąskaita faktūra', { align: 'right' });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Serija/NR: ${invoiceNo}`, { align: 'right' });
    doc.text(`Data: ${new Date().toLocaleDateString('lt-LT')}`, { align: 'right' });

    doc.moveDown(1.2);
    doc.fontSize(12).text('Tiekėjas:', { underline: true });
    doc.fontSize(10).text('RaskDali');
    doc.text(`El. paštas: ${process.env.MAIL_USER || 'info@raskdali.lt'}`);

    doc.moveDown(0.8);
    doc.fontSize(12).text('Pirkėjas:', { underline: true });
    doc.fontSize(10).text(buyer.name || '');
    if (buyer.code) doc.text(`Įmonės kodas: ${buyer.code}`);
    if (buyer.vat)  doc.text(`PVM kodas: ${buyer.vat}`);
    if (buyer.addr) doc.text(`Adresas: ${buyer.addr}`);
    if (buyer.email)doc.text(`El. paštas: ${buyer.email}`);

    doc.moveDown(1);
    doc.fontSize(12).text('Prekės / paslaugos:', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);

    items.forEach((it, i) => {
      doc.text(`${i+1}. ${it.name} — ${Number(it.price).toFixed(2)} €`);
      if (it.desc) doc.text(`   ${it.desc}`, { indent: 12 });
    });

    doc.moveDown(0.8);
    doc.fontSize(12).text(`Iš viso su PVM: ${Number(total).toFixed(2)} €`, { align: 'right' });

    doc.end();
  });
}

/* =======================================================
   finalizeOrder — siunčia laiškus (mokami planai po Payseros)
   ======================================================= */
async function finalizeOrder(orderid, reason = 'unknown') {
  const drafts = await loadDrafts();
  const draft = drafts[orderid];
  if (!draft) {
    console.log(`[finalizeOrder] draft not found for ${orderid} (reason=${reason})`);
    return false;
  }
  if (draft.emailed) {
    delete drafts[orderid];
    await saveDrafts(drafts);
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
    // adminui
    transporter.sendMail({
      from: `"RaskDali" <${adminAddr}>`,
      to: adminAddr,
      subject: `Užklausa (${plan}) – ${vardas || 'klientas'} (order ${orderid}, via ${reason})`,
      html: adminHtml,
      attachments,
    }).catch(e => console.error('MAIL admin error:', e));

    // klientui
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

    // cleanup
    draft.emailed = true;
    const d2 = await loadDrafts();
    delete d2[orderid];
    await saveDrafts(d2);

    console.log(`[finalizeOrder] emails queued for ${orderid} (reason=${reason})`);
    return true;
  } catch (mailErr) {
    console.error('[finalizeOrder] MAIL SEND ERROR:', mailErr);
    return false;
  }
}

/* =======================================================
   1) MOKAMI PLANAI: /api/uzklausa-start → Paysera
   ======================================================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 40 }
});

app.post('/api/uzklausa-start', upload.any(), async (req, res) => {
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

    // detalės + nuotraukos (base64)
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

    // išsaugom juodraštį
    const drafts = await loadDrafts();
    drafts[orderid] = {
      ts: Date.now(), emailed: false,
      plan, count, vin, marke, modelis, metai, komentaras, vardas, email, tel, items
    };
    await saveDrafts(drafts);

    // Paysera sumos (centais) — pasilik tai, kas veikia pas tave dabar
    const AMOUNTS = { Mini: 999, Standart: 2999, Pro: 5999 };
    const amount = AMOUNTS[plan] ?? AMOUNTS.Mini;

    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const returnUrl = normalizeReturnUrl(plan, req.body.return || '');

    // įdedam orderid į accept/cancel
    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent(returnUrl)}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent(returnUrl)}`;

    const { data, sign } = buildPayseraRequest({
      orderid,
      amount,
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl,
      cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? 1 : 0
    }, process.env.PAYSERA_PROJECT_ID, process.env.PAYSERA_PASSWORD);

    res.json({ pay_url: `https://bank.paysera.com/pay/?data=${encodeURIComponent(data)}&sign=${sign}` });
  } catch (e) {
    console.error('UZKLAUSA-START ERROR:', e);
    res.status(400).json({ error: 'Nepavyko pradėti apmokėjimo.' });
  }
});

/* =======================================================
   2) Paysera CALLBACK → finalizeOrder(orderid)
   ======================================================= */
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
      // neblokuojam callback – paleidžiam fone
      finalizeOrder(orderid, 'callback').catch(e => console.error('finalizeOrder err:', e));
    } else {
      console.log('CALLBACK received but status!=1 for', orderid, 'status=', payload.status);
    }

    res.send('OK');
  } catch (e) {
    console.error('PAYSERA CALLBACK ERROR:', e);
    res.status(400).send('ERROR');
  }
});

/* =======================================================
   3) Ačiū ekranas — grąžinam greitai (nebelaukiam laiškų)
   ======================================================= */
app.get('/thanks', async (req, res) => {
  const ok = req.query.ok === '1';
  const orderid = (req.query.o || '').toString();
  const siteHome = (process.env.SITE_BASE_URL || 'https://www.raskdali.lt').replace(/\/+$/, '');

  if (ok && orderid) {
    // nelaukiam – tegul fonu siunčia
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
  <p>${ok ? 'Laukite detalių pasiūlymo artimiausiu metu. Jei turite klausimų – tiesiog atsakykite į mūsų laišką.' : 'Galite pabandyti dar kartą arba susisiekti su mumis.'}</p>
  <a class="btn" href="${escapeHtml(siteHome)}">Eiti į pradžią</a>
</div>`);
});

/* =======================================================
   4) Nemokamas planas – priima formą ir el. paštus siunčia fone
   ======================================================= */
const uploadFree = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024, files: 20 } });

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
          contentType: file.mimetype || 'application/octet-stream'
        };
      }
      items.push({ idx: i + 1, name, desc, notes, attach });
    }

    if (!items.length) return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });

    // atsakome klientui tuoj pat (jokio „laukimo“)
    res.json({ ok: true });

    // el. paštai – fone
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

    // ADMIN
    transporter.sendMail({
      from: `"RaskDali" <${adminAddr}>`,
      to: adminAddr,
      subject: `Nemokama užklausa – ${vardas || 'klientas'}`,
      html: `${commonTop}<div style="font-family:Arial,sans-serif;font-size:14px">${adminItemsHtml}</div>`,
      attachments: adminAttachments
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
        `
      }).catch(e => console.error('FREE client mail err:', e));
    }
  } catch (err) {
    console.error('FREE ERROR:', err);
    try { res.status(500).json({ error: 'Serverio klaida. Bandykite dar kartą.' }); } catch {}
  }
}

// Abu keliai → tas pats handleris (kad nebeliktų 404)
app.post('/api/uzklausa_free', uploadFree.any(), handleFreeRequest);
app.post('/api/uzklausa-free', uploadFree.any(), handleFreeRequest);

/* =======================================================
   5) Pasiūlymai (offers) — su 7 d. galiojimu
   ======================================================= */
app.post('/api/sukurti-pasiulyma', async (req, res) => {
  const data = req.body; // { items: [...] }
  const id = nanoid(6);
  offers[id] = { ...data, createdAt: Date.now() }; // 7 d. gyvuoja
  await fs.writeFile(OFFERS_FILE, JSON.stringify(offers, null, 2));
  res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
});

app.get('/klientoats/:id', (req, res) => {
  const offer = offers[req.params.id];
  if (!offer) return res.status(404).send('Pasiūlymas nerastas');

  // 7 dienų galiojimas
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
  body{font-family:Arial, sans-serif;background:#f9f9f9;margin:0}
  .wrap{max-width:760px;margin:24px auto;background:#fff;border-radius:12px;padding:24px 28px;box-shadow:0 2px 24px #0001}
  .item{border-bottom:1px solid #e5e7eb;padding:14px 0}
  .item:last-child{border-bottom:none}
  .img{margin-top:6px}
  .img img{max-width:120px;max-height:120px;border:1px solid #e5e7eb;border-radius:8px}
  label{display:block;margin-top:6px}
  .sub{color:#6b7280;font-size:13px}
  input,button{font-size:14px}
  .btn{background:#436BAA;color:#fff;border:none;border-radius:10px;padding:10px 16px;cursor:pointer}
</style></head><body>
<div class="wrap">
  <h1>Detalių pasiūlymas</h1>
  <form method="POST" action="/klientoats/${req.params.id}/order">
    <div><label>Vardas/įmonė:<br><input name="vardas" required style="width:100%"></label></div>
    <div><label>El. paštas:<br><input type="email" name="email" required style="width:100%"></label></div>
    <div><label>Pristatymo adresas:<br><input name="adresas" required style="width:100%"></label></div>

    <div class="sub" style="margin-top:8px">Rekvizitai sąskaitai (jei reikia)</div>
    <div><label>Įmonės pavadinimas (nebūtina)<br><input name="imone" style="width:100%"></label></div>
    <div><label>Įmonės kodas (nebūtina)<br><input name="imones_kodas" style="width:100%"></label></div>
    <div><label>PVM kodas (nebūtina)<br><input name="pvm_kodas" style="width:100%"></label></div>
    <div><label>Sąskaitos adresas (nebūtina)<br><input name="saskaitos_adresas" style="width:100%"></label></div>

    <hr>
    ${(offer.items || []).map((item, i) => `
      <div class="item">
        <b>${item.pozNr ? `${item.pozNr}. ` : ''}${item.name || ''}</b>
        ${item.type ? ` <span style="color:#406BBA;font-size:.95em">(${item.type})</span>` : ''}
        ${item.desc ? `<div><i>${item.desc}</i></div>` : ''}
        ${item.eta ? `<div>Pristatymas: <b>${item.eta}</b></div>` : ''}
        <div>Kaina: <b>${item['price-vat'] || ''}€</b> ${item['price-novat'] ? `(be PVM ${item['price-novat']}€)` : ''}</div>
        <div class="img">${item.imgSrc ? `<img src="${item.imgSrc}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</div>
        <label><input type="checkbox" name="choose" value="${i}"> Užsakyti šią detalę</label>
      </div>
    `).join('')}
    <button type="submit" class="btn" style="margin-top:12px">Užsakyti pasirinktas</button>
  </form>
</div>
</body></html>`);
});

/* =======================================================
   6) Užsakymas iš pasiūlymo → PDF + Paysera nuoroda + laiškai
   ======================================================= */
app.post('/klientoats/:id/order', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const offer = offers[req.params.id];
    if (!offer) return res.status(404).send('Nerasta');

    const pasirinktos = req.body.choose ? (Array.isArray(req.body.choose) ? req.body.choose : [req.body.choose]) : [];
    const name   = (req.body.vardas || '').trim();
    const email  = (req.body.email || '').trim();
    const adresas= (req.body.adresas || '').trim();

    // Rekvizitai sąskaitai
    const buyer = {
      name: (req.body.imone || name || '').trim(),
      code: (req.body.imones_kodas || '').trim(),
      vat:  (req.body.pvm_kodas || '').trim(),
      addr: (req.body.saskaitos_adresas || adresas || '').trim(),
      email
    };

    let total = 0;
    const pasirinktosPrekes = pasirinktos.map(i => offer.items[i]).filter(Boolean);
    pasirinktosPrekes.forEach(item => {
      total += parseFloat((item?.["price-vat"] || "0").replace(',', '.'));
    });

    // 1) Išsaugome orderį
    const orders = await loadOrders();
    const orderid = nanoid();
    const cleanItems = pasirinktosPrekes.map(it => ({
      name: it?.name || '',
      desc: it?.desc || '',
      price: parseFloat((it?.["price-vat"] || "0").replace(',', '.')) || 0
    }));
    orders[orderid] = {
      ts: Date.now(),
      offerId: req.params.id,
      buyer,
      items: cleanItems,
      total,
      status: 'pending_payment'
    };
    await saveOrders(orders);

    // 2) Paysera apmokėjimo nuoroda
    const amountCents = Math.round(total * 100);
    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/,'');
    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;

    const qp = new URLSearchParams({
      version: '1',
      projectid: String(Number(process.env.PAYSERA_PROJECT_ID)),
      orderid,
      amount: String(amountCents),
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl, cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? '1' : '0'
    }).toString();
    const dataB64 = Buffer.from(qp).toString('base64');
    const sign = crypto.createHash('md5').update(dataB64 + process.env.PAYSERA_PASSWORD).digest('hex');
    const payUrl = `https://bank.paysera.com/pay/?data=${encodeURIComponent(dataB64)}&sign=${sign}`;

    // 3) PDF
    const invoiceNo = `RD-${new Date().getFullYear()}-${orderid.slice(0,6).toUpperCase()}`;
    const pdfBuffer = await makeInvoicePdfBuffer({ invoiceNo, buyer, items: cleanItems, total });

    const detalesHtml = cleanItems.map(it => `
      <li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} € ${it.desc ? `<br><i>${escapeHtml(it.desc)}</i>` : ''}</li>
    `).join('');

    // 4) El. laiškai (neblokuojam atsakymo)
    const adminHtml = `
      <h3>Užsakymas iš pasiūlymo</h3>
      <p><b>OrderID:</b> ${orderid}</p>
      <p><b>Pirkėjas:</b> ${escapeHtml(buyer.name)} ${buyer.code ? ' | ' + escapeHtml(buyer.code) : ''} ${buyer.vat ? ' | ' + escapeHtml(buyer.vat): ''}</p>
      <p><b>El. paštas:</b> ${escapeHtml(email)}</p>
      <p><b>Adresas:</b> ${escapeHtml(buyer.addr || adresas)}</p>
      <ul>${detalesHtml}</ul>
      <p><b>Viso su PVM:</b> ${total.toFixed(2)} €</p>
      <p><a href="${payUrl}" target="_blank">Apmokėti per Paysera</a></p>
    `;
    transporter.sendMail({
      from: `"RaskDali" <${process.env.MAIL_USER}>`,
      to: process.env.MAIL_USER,
      subject: `Naujas užsakymas iš pasiūlymo – ${name || buyer.name || 'klientas'} (order ${orderid})`,
      html: adminHtml,
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdfBuffer }]
    }).catch(e => console.error('offer→admin mail err:', e));

    if (email) {
      transporter.sendMail({
        from: `"RaskDali" <${process.env.MAIL_USER}>`,
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
        attachments: [{ filename: `${invoiceNo}.pdf`, content: pdfBuffer }]
      }).catch(e => console.error('offer→client mail err:', e));
    }

    // 5) „Ačiū“ dėžutė
    res.send(`
      <meta charset="utf-8">
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
      </div>
    `);

  } catch (e) {
    console.error('ORDER FROM OFFER ERROR:', e);
    res.status(500).send('Serverio klaida');
  }
});

/* =======================================================
   7) Naudingi servisai (PDF ir persiuntimas)
   ======================================================= */
app.get('/api/invoice/:orderid', async (req, res) => {
  const orders = await loadOrders();
  const o = orders[req.params.orderid];
  if (!o) return res.status(404).send('Nerasta');
  const invoiceNo = `RD-${new Date(o.ts).getFullYear()}-${req.params.orderid.slice(0,6).toUpperCase()}`;
  const pdf = await makeInvoicePdfBuffer({ invoiceNo, buyer: o.buyer, items: o.items, total: o.total });
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoiceNo}.pdf"`);
  res.send(pdf);
});

app.post('/api/orders/:orderid/resend', async (req, res) => {
  try {
    const orders = await loadOrders();
    const o = orders[req.params.orderid];
    if (!o) return res.status(404).json({ error: 'Nerasta' });
    if (!o.buyer?.email) return res.status(400).json({ error: 'Nėra kliento el. pašto' });

    const amountCents = Math.round(o.total * 100);
    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/,'');
    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(req.params.orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(req.params.orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const qp = new URLSearchParams({
      version:'1', projectid:String(Number(process.env.PAYSERA_PROJECT_ID)),
      orderid: req.params.orderid, amount:String(amountCents),
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl, cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? '1' : '0'
    }).toString();
    const dataB64 = Buffer.from(qp).toString('base64');
    const sign = crypto.createHash('md5').update(dataB64 + process.env.PAYSERA_PASSWORD).digest('hex');
    const payUrl = `https://bank.paysera.com/pay/?data=${encodeURIComponent(dataB64)}&sign=${sign}`;

    const invoiceNo = `RD-${new Date(o.ts).getFullYear()}-${req.params.orderid.slice(0,6).toUpperCase()}`;
    const pdf = await makeInvoicePdfBuffer({ invoiceNo, buyer: o.buyer, items: o.items, total: o.total });

    await transporter.sendMail({
      from: `"RaskDali" <${process.env.MAIL_USER}>`,
      to: o.buyer.email,
      subject: `Sąskaita apmokėjimui – ${invoiceNo}`,
      html: `
        <h2>Jūsų pasirinktos prekės</h2>
        <ul>${o.items.map(it=>`<li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} €</li>`).join('')}</ul>
        <p>Viso su PVM: <b>${o.total.toFixed(2)} €</b></p>
        <p>Apmokėti: <a href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
        ${EMAIL_FOOTER_HTML}
      `,
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdf }]
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('RESEND ERROR', e);
    res.status(500).json({ error: 'Nepavyko persiųsti' });
  }
});

/* -------------------- Start -------------------- */
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
