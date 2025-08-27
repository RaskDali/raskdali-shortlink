import express from 'express';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import nodemailer from 'nodemailer';
import multer from 'multer';
import dotenv from 'dotenv';
import crypto from 'crypto';

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

/* -------------------- SMTP -------------------- */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || '465', 10),
  secure: true,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

// (nebūtina, bet naudinga loguose pamatyti ar SMTP OK)
transporter.verify().then(
  () => console.log('SMTP OK'),
  (e) => console.error('SMTP ERROR:', e?.message || e)
);

/* -------------------- Helpers -------------------- */
const DRAFTS_FILE = 'drafts.json'; // juodraščiai iki Payseros patvirtinimo

async function loadDrafts() {
  try { return JSON.parse(await fs.readFile(DRAFTS_FILE, 'utf8')); }
  catch { return {}; }
}
async function saveDrafts(d) {
  await fs.writeFile(DRAFTS_FILE, JSON.stringify(d, null, 2));
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
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

/* =======================================================
   Bendra finalizacijos funkcija — siunčia laiškus ir išvalo juodraštį
   ======================================================= */
async function finalizeOrder(orderid, reason = 'unknown') {
  const drafts = await loadDrafts();
  const draft = drafts[orderid];
  if (!draft) {
    console.log(`[finalizeOrder] draft not found for ${orderid} (reason=${reason})`);
    return false;
  }
  if (draft.emailed) {
    // jei buvo bandyta anksčiau — tiesiog išvalom
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
    await transporter.sendMail({
      from: `"RaskDali" <${adminAddr}>`,
      to: adminAddr,
      subject: `Užklausa (${plan}) – ${vardas || 'klientas'} (order ${orderid}, via ${reason})`,
      html: adminHtml,
      attachments,
    });
    // klientui
    if (email) {
      const clientHtml = `
        ${top}
        <div style="font-family:Arial,sans-serif;font-size:14px">
          <h2 style="margin:6px 0 10px 0">Jūsų užklausa gauta 🎉</h2>
          <p>Ačiū! Gavome Jūsų užklausą (<b>${escapeHtml(plan)}</b>). Dažniausiai pasiūlymą pateikiame per <b>24–48 val.</b></p>
        </div>`;
      await transporter.sendMail({
        from: `"RaskDali" <${adminAddr}>`,
        to: email,
        subject: 'Jūsų užklausa gauta – RaskDali',
        html: clientHtml,
      });
    }

    // pažymim/pašalinam
    draft.emailed = true;
    const d2 = await loadDrafts();
    delete d2[orderid];
    await saveDrafts(d2);

    console.log(`[finalizeOrder] emails sent for ${orderid} (reason=${reason})`);
    return true;
  } catch (mailErr) {
    console.error('[finalizeOrder] MAIL SEND ERROR:', mailErr);
    return false;
  }
}

/* =======================================================
   1) UŽKLAUSOS START (saugom juodraštį + Paysera URL su orderid)
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

    // Paysera
    const AMOUNTS = { Mini: 99, Standart: 1499, Pro: 2499 }; // centais
    const amount = AMOUNTS[plan] ?? AMOUNTS.Mini;

    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const returnUrl = normalizeReturnUrl(plan, req.body.return || '');

    // >>> pridėjau orderid "o" į accept/cancel
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
      await finalizeOrder(orderid, 'callback');
    } else {
      console.log('CALLBACK received but status!=1 for', orderid, 'status=', payload.status);
      // jei neapmokėta — tiesiog paliekam juodraštį; /thanks fallback’o nesiunčiam
    }

    res.send('OK');
  } catch (e) {
    console.error('PAYSERA CALLBACK ERROR:', e);
    res.status(400).send('ERROR');
  }
});

/* =======================================================
   3) Ačiū (fallback) — jei ok=1 ir turim o=orderid → finalizeOrder
   ======================================================= */
app.get('/thanks', async (req, res) => {
  const ok = req.query.ok === '1';
  const orderid = (req.query.o || '').toString();
  const back = (req.query.return || '/').toString();

  // Fallback: jei grįžom su ok=1 ir dar turime juodraštį — mėginam išsiųsti
  if (ok && orderid) {
    await finalizeOrder(orderid, 'return');
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<meta charset="utf-8">
<title>${ok ? 'Apmokėta' : 'Apmokėjimas atšauktas'}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;margin:0;display:grid;place-items:center;height:100dvh}
  .card{max-width:560px;padding:28px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px #00000014;text-align:center}
  .ok{color:#16a34a;font-size:26px;font-weight:800;margin:10px 0}
  .fail{color:#ef4444;font-size:26px;font-weight:800;margin:10px 0}
  a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600}
</style>
<div class="card">
  <div class="${ok ? 'ok' : 'fail'}">${ok ? 'Ačiū! Mokėjimas patvirtintas.' : 'Mokėjimas neįvyko.'}</div>
  <div>Galite grįžti į formą.</div>
  <a class="btn" href="${escapeHtml(back)}">Grįžti</a>
</div>`);
});

/* =======================================================
   4) Pasiūlymų (offers) dalis — be pakeitimų, tik kad nuotraukos matytųsi
   ======================================================= */
let offers = {};
try { offers = JSON.parse(await fs.readFile('offers.json', 'utf8')); } catch { offers = {}; }

app.post('/api/sukurti-pasiulyma', async (req, res) => {
  const data = req.body;
  const id = nanoid(6);
  offers[id] = data;
  await fs.writeFile('offers.json', JSON.stringify(offers, null, 2));
  res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
});

app.get('/klientoats/:id', (req, res) => {
  const offer = offers[req.params.id];
  if (!offer) return res.status(404).send('Pasiūlymas nerastas');
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
</style></head><body>
<div class="wrap">
  <h1>Detalių pasiūlymas</h1>
  <form method="POST" action="/klientoats/${req.params.id}/order">
    <div><label>Vardas/įmonė:<br><input name="vardas" required style="width:100%"></label></div>
    <div><label>El. paštas:<br><input type="email" name="email" required style="width:100%"></label></div>
    <div><label>Pristatymo adresas:<br><input name="adresas" required style="width:100%"></label></div>
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
    <button type="submit" style="margin-top:12px">Užsakyti pasirinktas</button>
  </form>
</div>
</body></html>`);
});

app.post('/klientoats/:id/order', (req, res) => {
  res.send('<meta charset="utf-8"><h2>Užsakymas priimtas</h2>');
});

/* -------------------- Start -------------------- */
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
