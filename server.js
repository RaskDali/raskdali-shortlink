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

/* ---------- Middleware ---------- */
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ---------- Paprasta „DB“ ---------- */
let offers = {};
try { offers = JSON.parse(await fs.readFile('offers.json', 'utf8')); } catch { offers = {}; }

/* ---------- SMTP ---------- */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || '465', 10),
  secure: true,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

/* ---------- Helperiai ---------- */
function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
function buildQuery(obj) {
  return Object.entries(obj).map(([k, v]) =>
    `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`
  ).join('&');
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

/* =========================================================
   API: UŽKLAUSA → laiškai adminui ir klientui
   ========================================================= */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 40 } });

app.post('/api/uzklausa', upload.any(), async (req, res) => {
  try {
    const vin   = (req.body.vin || '').trim();
    const marke = (req.body.marke || '').trim();
    const modelis = (req.body.modelis || '').trim();
    const metai = (req.body.metai || '').trim();

    const komentaras = (req.body.komentaras || '').trim();
    const vardas     = (req.body.vardas || '').trim();
    const email      = (req.body.email || '').trim();
    const tel        = (req.body.tel || '').trim();

    const plan  = (req.body.plan || 'Nežinomas').trim();
    const count = Math.max(1, parseInt(req.body.count || '5', 10));

    const items = [];
    for (let i = 0; i < count; i++) {
      const name  = (req.body[`items[${i}][name]`]  || req.body[`item_${i}_name`]  || '').trim();
      const desc  = (req.body[`items[${i}][desc]`]  || req.body[`item_${i}_desc`]  || '').trim();
      const notes = (req.body[`items[${i}][notes]`] || req.body[`item_${i}_notes`] || '').trim();
      const file  = (req.files || []).find(f => f.fieldname === `items[${i}][image]` || f.fieldname === `item_${i}_image`);
      if (!(name || desc || notes || file)) continue;
      items.push({ idx: i + 1, name, desc, notes, file });
    }
    if (!items.length) return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });

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

    const adminItems = items.map((it, idx) => {
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

    const attachments = items.map((it, idx) => it.file ? ({
      filename: it.file.originalname || `detale_${it.idx}.jpg`,
      content: it.file.buffer,
      contentType: it.file.mimetype || 'application/octet-stream',
      cid: `item${idx}_cid`
    }) : null).filter(Boolean);

    const admin = process.env.MAIL_USER || 'info@raskdali.lt';

    // Atsakome klientui iškart (neblokuojam)
    res.json({ ok: true });

    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: `"RaskDali" <${admin}>`,
          to: admin,
          subject: `Užklausa (${plan}) – ${vardas || 'klientas'}`,
          html: adminHtml,
          attachments
        });

        if (email) {
          const clientHtml = `
            ${top}
            <div style="font-family:Arial,sans-serif;font-size:14px">
              <h2 style="margin:6px 0 10px 0">Jūsų užklausa gauta 🎉</h2>
              <p>Ačiū! Gavome Jūsų užklausą (<b>${escapeHtml(plan)}</b>). Dažniausiai pasiūlymą pateikiame per <b>24–48 val.</b></p>
            </div>`;
          await transporter.sendMail({
            from: `"RaskDali" <${admin}>`,
            to: email,
            subject: 'Jūsų užklausa gauta – RaskDali',
            html: clientHtml
          });
        }
      } catch (e) {
        console.error('MAIL SEND ERROR:', e);
      }
    });
  } catch (e) {
    console.error('UZKLAUSA ERROR:', e);
    try { res.status(500).json({ error: 'Serverio klaida. Bandykite dar kartą.' }); } catch {}
  }
});

/* =========================================================
   Paysera: START + CALLBACK + FINISH (nauja)
   ========================================================= */

// Paysera START → grąžinam pay_url
app.get('/api/paysera/start', async (req, res) => {
  try {
    const plan = (req.query.plan || 'Mini').toString();
    const rawReturn = (req.query.return || '').toString();
    const returnUrl = normalizeReturnUrl(plan, rawReturn);

    const AMOUNTS = { Mini: 99, Standart: 1499, Pro: 2499 }; // centais
    const amount = AMOUNTS[plan] ?? AMOUNTS.Mini;

    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');

    // Vietoj ?paid — mūsų tarpiniam puslapiui.
    const accepturl = `${apiHost}/paysera/finish?ok=1&return=${encodeURIComponent(returnUrl)}`;
    const cancelurl = `${apiHost}/paysera/finish?ok=0&return=${encodeURIComponent(returnUrl)}`;

    const { data, sign } = buildPayseraRequest({
      orderid: nanoid(),
      amount,
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl,
      cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? 1 : 0
    }, process.env.PAYSERA_PROJECT_ID, process.env.PAYSERA_PASSWORD);

    res.json({ pay_url: `https://bank.paysera.com/pay/?data=${encodeURIComponent(data)}&sign=${sign}` });
  } catch (e) {
    console.error('PAYSERA START ERROR:', e);
    res.status(400).json({ error: 'Negalime paruošti apmokėjimo.' });
  }
});

// Paysera CALLBACK (parašo patikrinimas)
app.post('/api/paysera/callback', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const { data, sign } = req.body || {};
    if (!data || !sign) return res.status(400).send('ERROR');
    if (!verifyPayseraResponse(data, sign, process.env.PAYSERA_PASSWORD)) {
      console.error('PAYSERA CALLBACK: sign mismatch');
      return res.status(400).send('ERROR');
    }
    const payload = parsePayseraData(data);
    console.log('PAYSERA OK:', payload);
    res.send('OK');
  } catch (e) {
    console.error('PAYSERA CALLBACK ERROR:', e);
    res.status(400).send('ERROR');
  }
});

// NAUJAS: Paysera FINISH (tarpinis puslapis)
app.get('/paysera/finish', (req, res) => {
  const ok = req.query.ok === '1' ? '1' : '0';
  const back = (req.query.return || '/').toString();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<meta charset="utf-8">
<title>Grįžtame...</title>
<script>
  try {
    sessionStorage.setItem('rqPaid', '${ok}');
  } catch (e) {}
  location.replace(${JSON.stringify(back)});
</script>
<body style="font-family:system-ui,Arial;padding:20px">
Grąžiname į svetainę...
</body>`);
});

/* =========================================================
   Pasiūlymo peržiūra (su imgSrc)
   ========================================================= */
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
        ${item.type ? ` <span style="color:#4066B2;font-size:.95em">(${item.type})</span>` : ''}
        ${item.desc ? `<div><i>${item.desc}</i></div>` : ''}
        ${item.eta ? `<div>Pristatymas: <b>${item.eta}</b></div>` : ''}
        <div>Kaina: <b>${item['price-vat'] || ''}€</b> ${item['price-novat'] ? `(be PVM ${item['price-novat']}€)` : ''}</div>
        <div class="img">${item.imgSrc ? `<img src="${item.imgSrc}" loading="lazy" alt="" referrerpolicy="no-referrer">` : ''}</div>
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

/* ---------- start ---------- */
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
