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

/* ---------- Paths & const ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FONT_REG  = path.join(__dirname, 'public', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(__dirname, 'public', 'DejaVuSans-Bold.ttf');

const LOGO_PATH = process.env.LOGO_PATH || path.join(__dirname, 'public', 'logo.png');
// Kiek pikselių aukščio piešti logotipą PDF sąskaitoje (keisk pagal poreikį)
const LOGO_H = parseInt(process.env.LOGO_H || '52', 10);

// Visi duomenys bus laikomi diske (Render: /var/data). Lokaliai – ./data po projektu.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const DRAFTS_FILE      = path.join(DATA_DIR, 'drafts.json');       // mokamų planų juodraščiai
const ORDERS_FILE      = path.join(DATA_DIR, 'orders.json');       // užsakymai iš pasiūlymų
const OFFERS_FILE      = path.join(DATA_DIR, 'offers.json');       // pasiūlymai (7 d.)
const INVOICE_SEQ_FILE = path.join(DATA_DIR, 'invoice_seq.json');  // sąskaitų numeracijos skaitiklis


/* ---------- App ---------- */
const app = express();
const port = process.env.PORT || 10000;

// ↑↑↑ PAKELTI LIMITAI, kad tilptų base64 nuotraukos
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------- SMTP (pool) ---------- */
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

/* ---------- Helpers ---------- */
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---- LT suma žodžiais (eurai + centai)
function eurosToWordsLt(amount) {
  const units = ['nulis','vienas','du','trys','keturi','penki','šeši','septyni','aštuoni','devyni'];
  const teens = ['dešimt','vienuolika','dvylika','trylika','keturiolika','penkiolika','šešiolika','septyniolika','aštuoniolika','devyniolika'];
  const tens  = ['','', 'dvidešimt','trisdešimt','keturiasdešimt','penkiasdešimt','šešiasdešimt','septyniasdešimt','aštuoniasdešimt','devyniasdešimt'];
  const hundreds = ['','šimtas','du šimtai','trys šimtai','keturi šimtai','penki šimtai','šeši šimtai','septyni šimtai','aštuoni šimtai','devyni šimtai'];

  function form(n, vnt, dgs, kil) { // 1, 2-9, 0/10-19
    if (n % 100 >= 10 && n % 100 <= 19) return kil;
    const u = n % 10;
    if (u === 1) return vnt;
    if (u >= 2 && u <= 9) return dgs;
    return kil;
  }
  function upTo999(n) {
    const h = Math.floor(n/100), r = n%100;
    let out = [];
    if (h) out.push(hundreds[h]);
    if (r >= 10 && r <= 19) out.push(teens[r-10]);
    else {
      const t = Math.floor(r/10), u = r%10;
      if (t) out.push(tens[t]);
      if (u) out.push(units[u]);
      if (!t && !u && !h) out.push(units[0]);
    }
    return out.join(' ').trim();
    }

  function chunk(n, i) { // tūkstančiai, milijonai …
    const words = upTo999(i);
    if (i === 0) return '';
    if (n === 1000)  return words + ' ' + form(i,'tūkstantis','tūkstančiai','tūkstančių');
    if (n === 1000000) return words + ' ' + form(i,'milijonas','milijonai','milijonų');
    return words;
  }

  const euros = Math.floor(Number(amount) || 0);
  const cents = Math.round(((Number(amount) || 0) - euros) * 100);

  // eurai iki milijonų
  const parts = [];
  const mln = Math.floor(euros / 1_000_000);
  const th  = Math.floor((euros % 1_000_000) / 1_000);
  const rest = euros % 1000;
  if (mln)  parts.push(chunk(1_000_000, mln));
  if (th)   parts.push(chunk(1000, th));
  if (rest || (!mln && !th)) parts.push(upTo999(rest));

  const eurWord = form(euros, 'euras', 'eurai', 'eurų');
  const ctWord  = form(cents, 'centas', 'centai', 'centų');

  return `${parts.join(' ')} ${eurWord} ${cents ? (upTo999(cents) + ' ' + ctWord) : ''}`.trim();
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

// atomic I/O
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
// Įsitikinam, kad DATA_DIR egzistuoja
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("Nepavyko sukurti DATA_DIR:", e);
  }
}

// ---------- Invoice numbering ----------
// Struktūra: { year: 2025, counter: 12 }

async function nextInvoiceNo() {
  let seq = await loadJson(INVOICE_SEQ_FILE);
  const yr = new Date().getFullYear();

  // jei pasikeitė metai – pradedam nuo nulio
  if (!seq.year || seq.year !== yr) {
    seq = { year: yr, counter: 0 };
  }

  seq.counter += 1;
  await saveJson(INVOICE_SEQ_FILE, seq);

  const prefix = 'MAGRD' + yr;  // prefiksas (gali pakeist į kitą)
  const num = String(seq.counter).padStart(5, '0'); // pvz. 00001
  return `${prefix}-${num}`;
}

/* ---------- Rekvizitai (pardavėjo) ---------- */
const SELLER = {
  name: 'RaskDali / UAB „Magdaris“',
  addr: 'Vilniaus g. 3B, Karmėlava, 54448, Lietuva',
  code: '159941827',
  vat: 'LT599418219',
  email: process.env.MAIL_USER || 'info@raskdali.lt',
  vatRate: 0.21,
};

/* ---------- Email footer ---------- */
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
function buildPayNowEmail({ title, items, total, buyer, payUrl }) {
  const list = (items || []).map(it => `
    <li>
      <b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} €
      ${it.desc ? `<br><i>${escapeHtml(it.desc)}</i>` : ''}
    </li>
  `).join('');

  return `
    ${topLogoHtml}
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111">
      <h2 style="margin:6px 0 10px 0">${escapeHtml(title || 'Užsakymo santrauka')}</h2>
      <p><b>Pirkėjas:</b> ${escapeHtml(buyer?.name || '')}${buyer?.email ? ` · <a href="mailto:${escapeHtml(buyer.email)}">${escapeHtml(buyer.email)}</a>` : ''}</p>
      <ul>${list}</ul>
      <p style="font-size:15px"><b>Viso su PVM:</b> ${Number(total || 0).toFixed(2)} €</p>
      <p><a href="${escapeHtml(payUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600">Apmokėti per Paysera</a></p>
      <p style="color:#6b7280;font-size:13px;margin-top:6px">Jei jau apmokėjote, šios nuorodos spausti nereikia.</p>
    </div>
    ${EMAIL_FOOTER_HTML}
  `;
}


/* ---------- PDF sąskaita (su PVM suvestine) ---------- */
function formatMoney(n) { return Number(n || 0).toFixed(2) + ' €'; }

// pridėjom footerNote ir includeReturns valdymą
async function makeInvoicePdfBuffer({ invoiceNo, buyer, items, footerNote, includeReturns = true }) {
  // Kainos items.price laikomos SU PVM. PVM tarifas iš SELLER.vatRate
  const VAT = SELLER.vatRate || 0.21;
  
  function sumGross(items) {
    return (items || []).reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty || 1)), 0);
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 36, // 0.5 inch
      bufferPages: true
    });

    // rinkti baitus
    const chunks = [];
    doc.on('data', b => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ---- Šriftai (su lietuviškom raidėm)
    try {
      doc.registerFont('Sans', FONT_REG);
      doc.registerFont('SansBold', FONT_BOLD);
    } catch (e) {
      // jei kas, naudok built-in
      console.error('FONT load error:', e);
    }
    doc.font('Sans');

    // Kad niekas „neliptų“ – pagalbinė: jei mažai vietos, kurk naują puslapį ir nubrėžk viršutinę liniją
    function ensureSpace(h) {
      const bottom = doc.page.margins.bottom;
      if (doc.y + h > doc.page.height - bottom) {
        doc.addPage();
      }
    }

    // ---- Header (logo + antraštė)
    const startY = 36;
    let headerBottomY = startY;

    try {
      if (fsSync.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, 36, startY, { fit: [140, 40] });
        headerBottomY = Math.max(headerBottomY, startY + 44);
      }
    } catch {}

    doc.font('SansBold').fontSize(14).fillColor('#111')
      .text('PVM SĄSKAITA – FAKTŪRA', 0, startY, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Sans').fontSize(10).fillColor('#333')
      .text(`Serija/NR: ${invoiceNo}`, { align: 'center' })
      .text(`Išrašymo data: ${new Date().toLocaleDateString('lt-LT')}`, { align: 'center' });

    headerBottomY = Math.max(headerBottomY, doc.y);
    doc.moveTo(36, headerBottomY + 10).lineTo(559, headerBottomY + 10)
      .strokeColor('#e5e7eb').lineWidth(1).stroke();

    // ---- Pardavėjas / Pirkėjas (du stulpai)
    const leftX = 36, rightX = 316;
    let y = headerBottomY + 22;

    doc.font('SansBold').fontSize(11).fillColor('#111').text('Pardavėjas', leftX, y);
    doc.font('Sans').fontSize(10).fillColor('#333');
    doc.text(SELLER.name, leftX, y + 14);
    doc.text(SELLER.addr, leftX);
    doc.text(`Įmonės kodas: ${SELLER.code}`, leftX);
    doc.text(`PVM mok. kodas: ${SELLER.vat}`, leftX);
    doc.text(`El. paštas: ${SELLER.email}`, leftX);

    doc.font('SansBold').fontSize(11).fillColor('#111').text('Pirkėjas', rightX, y);
    doc.font('Sans').fontSize(10).fillColor('#333');
    doc.text(buyer?.name || '', rightX, y + 14);
    if (buyer?.addr)  doc.text(buyer.addr, rightX);
    if (buyer?.code)  doc.text(`Įmonės kodas: ${buyer.code}`, rightX);
    if (buyer?.vat)   doc.text(`PVM kodas: ${buyer.vat}`, rightX);
    if (buyer?.email) doc.text(`El. paštas: ${buyer.email}`, rightX);

// --- FIKSUOJAM lentelės pradžią (kaip RRR pavyzdyje)
const TABLE_START_Y = 250;

// jeigu rekvizitai užėmė daugiau – nekertam jų, imam didesnę reikšmę
y = Math.max(doc.y, TABLE_START_Y);

    // ---- Lentelės stulpelių x koordinatės (netankios – kad niekas nepersidengtų)
    const cols = {
      name:      36,
      qty:       320,
      unitNet:   368,
      vatAmt:    452,
      lineGross: 520
    };

    // ---- Lentelės head (pataisyta, kad linija nepersibrauktų per tekstą)
ensureSpace(28);
doc.font('SansBold').fontSize(10).fillColor('#111');

doc.text('Produktas / paslauga', cols.name,    y, { width: cols.qty - cols.name - 6 });
doc.text('Kiekis',               cols.qty,     y, { width: cols.unitNet - cols.qty - 6, align: 'right' });
doc.text('Vnt. kaina be PVM',    cols.unitNet, y, { width: cols.vatAmt  - cols.unitNet - 6, align: 'right' });
doc.text('PVM suma',             cols.vatAmt,  y, { width: cols.lineGross - cols.vatAmt - 6, align: 'right' });
doc.text('Suma su PVM',          cols.lineGross, y, { width: 559 - cols.lineGross - 6, align: 'right' });

// išmatuojam antraštės apačią ir nubrėžiam liniją žemiau teksto
let headBottom = Math.max(doc.y, y) + 4;              // +4 px, kad nepaliestų raidžių „u, p, j“ uodegų
doc.moveTo(36, headBottom).lineTo(559, headBottom)
   .strokeColor('#e5e7eb').lineWidth(0.6).stroke();

y = headBottom + 8;                                   // ir nuo jos pradedam pirmą eilutę

    // ---- Eilutės
doc.font('Sans').fontSize(10).fillColor('#333');
for (const it of (items || [])) {
  ensureSpace(28);

  const qty       = Number(it.qty || 1);
  const grossUnit = Number(it.price || 0);
  const netUnit   = grossUnit / (1 + VAT);
  const vatUnit   = grossUnit - netUnit;

  const lineGross = grossUnit * qty;
  const lineVat   = vatUnit * qty;

  doc.text(it.name || '', cols.name, y, { width: cols.qty - cols.name - 6 });
  doc.text(qty.toString(), cols.qty, y, { width: cols.unitNet - cols.qty - 6, align: 'right' });
  doc.text(netUnit.toFixed(2) + ' €', cols.unitNet, y, { width: cols.vatAmt - cols.unitNet - 6, align: 'right' });
  doc.text(lineVat.toFixed(2) + ' €',  cols.vatAmt,  y, { width: cols.lineGross - cols.vatAmt - 6, align: 'right' });
  doc.text(lineGross.toFixed(2) + ' €', cols.lineGross, y, { width: 559 - cols.lineGross - 6, align: 'right' });

  // BUVO:
  // y = doc.y + 3;

  // DABAR: pasiskaičiuojam žemiau esantį tašką visiems stulpeliams
  const rowBottom = Math.max(
    y + doc.heightOfString(it.name || '',        { width: cols.qty - cols.name - 6 }),
    y + doc.heightOfString(qty.toString(),       { width: cols.unitNet - cols.qty - 6 }),
    y + doc.heightOfString(netUnit.toFixed(2)+' €', { width: cols.vatAmt - cols.unitNet - 6 }),
    y + doc.heightOfString(lineVat.toFixed(2)+' €',  { width: cols.lineGross - cols.vatAmt - 6 }),
    y + doc.heightOfString(lineGross.toFixed(2)+' €', { width: 559 - cols.lineGross - 6 }),
  );
  y = rowBottom + 4; // šiek tiek atsitraukiam nuo teksto

  if (it.desc) {
    ensureSpace(18);
    doc.fillColor('#6b7280').fontSize(9)
      .text(it.desc, cols.name + 12, y, { width: cols.qty - cols.name - 18 });
    doc.font('Sans').fontSize(10).fillColor('#333');
    y = doc.y + 3;
  }

  doc.moveTo(36, y).lineTo(559, y).strokeColor('#f3f4f6').lineWidth(1).stroke();
  y += 6;
}

    // ---- Suvestinė
    const gross = sumGross(items);
    const net   = gross / (1 + VAT);
    const vat   = gross - net;

    y += 8;
    ensureSpace(60);
    doc.font('Sans').fontSize(10).fillColor('#111');
    doc.text(`Iš viso be PVM: ${net.toFixed(2)} €`, 0, y, { align: 'right' });
    y += 14;
    doc.text(`PVM (${Math.round(VAT*100)}%): ${vat.toFixed(2)} €`, 0, y, { align: 'right' });
    y += 14;
    doc.font('SansBold').fontSize(12)
       .text(`Iš viso su PVM: ${gross.toFixed(2)} €`, 0, y, { align: 'right' });

// Suma žodžiais
y += 16;
ensureSpace(30);
doc.font('Sans').fontSize(10).fillColor('#374151')
  .text('Suma žodžiais: ' + eurosToWordsLt(gross), 36, y, { width: 520 });

    // pabaigos pastabos
y += 24;
ensureSpace(40);
const note = footerNote
  || 'Pastaba: neapmokėti užsakymai nevykdomi. Apmokėjimo terminas – 14 kalendorinių dienų. www.raskdali.lt';
doc.font('Sans').fontSize(9).fillColor('#6b7280')
  .text(note, 36, y, { width: 520 });

if (includeReturns) {
  y = doc.y + 8;
  ensureSpace(24);
  doc.font('Sans').fontSize(9).fillColor('#6b7280')
    .text('Grąžinimai: naujos prekės – per 14 d. nuo gavimo; naudotos – pagal garantijos/taisyklių sąlygas. Taisyklės: www.raskdali.lt/taisykles-ir-salygos', 36, y, { width: 520 });
}

doc.end();
  });
}

/* ---------- Caches ---------- */
let draftsCache = {};
let offersCache = {};
let ordersCache = {};

await (async function ensureCaches() {
  await ensureDataDir(); // <- pridedam
  draftsCache = await loadJson(DRAFTS_FILE);
  offersCache = await loadJson(OFFERS_FILE);
  ordersCache = await loadJson(ORDERS_FILE);
})();


/* ---------- Emails common ---------- */
const topLogoHtml = `
  <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif">
    <tr><td style="padding:16px 0">
      <img src="https://assets.zyrosite.com/A0xl6GKo12tBorNO/rask-dali-siauras-YBg7QDW7g6hKw3WD.png" alt="RaskDali" style="height:26px">
    </td></tr>
  </table>`;

/* ---------- finalizeOrder (mokami planai) ---------- */
async function finalizePaidDraft(orderid, reason = 'unknown') {
  const draft = draftsCache[orderid];
  if (!draft) return false;
  if (draft.emailed) {
    delete draftsCache[orderid];
    await saveJson(DRAFTS_FILE, draftsCache);
    return true;
  }

  const { plan, vin, marke, modelis, metai, komentaras, vardas, email, tel, items } = draft;

  const head = `
    ${topLogoHtml}
    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
      <p style="margin:0 0 12px 0"><b>Planas:</b> ${escapeHtml(plan)} · <b>Detalių (užpildyta):</b> ${items.length}</p>
      <p style="margin:0 0 12px 0"><b>VIN:</b> ${escapeHtml(vin)} · <b>Markė:</b> ${escapeHtml(marke)} · <b>Modelis:</b> ${escapeHtml(modelis)} · <b>Metai:</b> ${escapeHtml(metai)}</p>
      <p style="margin:0 0 12px 0"><b>Vardas/įmonė:</b> ${escapeHtml(vardas)} · <b>El. paštas:</b> ${escapeHtml(email)} · <b>Tel.:</b> ${escapeHtml(tel)}</p>
      ${komentaras ? `<p style="margin:0 0 12px 0"><b>Komentarai:</b> ${escapeHtml(komentaras)}</p>` : ''}
      <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
    </div>`;

  const adminItemsHtml = (items || []).map((it, idx) => {
    const img = it.file ? `<div style="margin-top:6px"><img src="cid:item${idx}_cid" style="max-width:320px;border:1px solid #eee;border-radius:6px"></div>` : '';
    const title = it.name ? escapeHtml(it.name) : '(be pavadinimo)';
    return `<div style="padding:10px 12px;border:1px solid #eee;border-radius:10px;margin:8px 0">
      <div style="font-weight:600">#${it.idx}: ${title}</div>
      ${it.desc ? `<div><b>Aprašymas:</b> ${escapeHtml(it.desc)}</div>` : ''}
      ${it.notes ? `<div><b>Pastabos:</b> ${escapeHtml(it.notes)}</div>` : ''}
      ${img}
    </div>`;
  }).join('');

  const adminAttachments = (items || []).map((it, idx) => {
    if (!it.file) return null;
    return {
      filename: it.file.filename,
      content: Buffer.from(it.file.base64, 'base64'),
      contentType: it.file.mimetype,
      cid: `item${idx}_cid`,
    };
  }).filter(Boolean);

  // ADMIN
  await transporter.sendMail({
    from: `"RaskDali" <${SELLER.email}>`,
    to: SELLER.email,
    subject: `Apmokėta užklausa (${plan}) – ${vardas || 'klientas'} (order ${orderid}, via ${reason})`,
    html: head + adminItemsHtml,
    attachments: adminAttachments,
  }).catch(e => console.error('MAIL admin draft err:', e));

    // KLIENTUI
  if (email) {
    const html = `
      ${topLogoHtml}
      <div style="font-family:Arial,sans-serif;font-size:14px">
        <h2 style="margin:6px 0 10px 0">Jūsų užklausa apmokėta ir priimta 🎉</h2>
        <p>Ačiū! Gavome Jūsų apmokėjimą ir užklausą. Paruošime detalių pasiūlymą per 24–48 val.</p>
      </div>
      ${EMAIL_FOOTER_HTML}
    `;
    await transporter.sendMail({
      from: '"RaskDali" <' + SELLER.email + '>',
      to: email,
      subject: 'Jūsų užklausa apmokėta ir priimta – RaskDali',
      html,
    }).catch(e => console.error('MAIL client draft err:', e));
  }

    /* ======= PDF sąskaita planui po apmokėjimo ======= */
  try {
    // naudok tą pačią kainodarą kaip /api/uzklausa-start (centais)
    const PLAN_AMOUNTS_CENTS = { Mini: 999, Standart: 2999, Pro: 5999 };
    const priceEur = (PLAN_AMOUNTS_CENTS[plan] ?? PLAN_AMOUNTS_CENTS.Mini) / 100;

    const invoiceNo = await nextInvoiceNo();
    const buyerForPlan = { name: vardas || email || 'Klientas', email };

    const planItems = [
      { name: `Plano „${plan}“ mokestis`, qty: 1, price: priceEur }
    ];

    const pdfPlan = await makeInvoicePdfBuffer({
      invoiceNo,
      buyer: buyerForPlan,
      items: planItems,
      footerNote: 'Apmokėta internetu. Sąskaita sugeneruota elektroninėmis priemonėmis ir galioja be parašo.',
      includeReturns: true
    });

    const attachPlan = [
      { filename: `${invoiceNo}.pdf`, content: pdfPlan, contentType: 'application/pdf' }
    ];

    // Adminui
    await transporter.sendMail({
      from: `"RaskDali" <${SELLER.email}>`,
      to: SELLER.email,
      subject: `Plano apmokėjimas – ${plan} (${invoiceNo})`,
      html: `
        ${topLogoHtml}
        <div style="font-family:Arial,sans-serif;font-size:14px">
          <p>Gautas plano apmokėjimas (${escapeHtml(plan)}), order ${escapeHtml(orderid)}.</p>
        </div>`,
      attachments: attachPlan
    }).catch(e => console.error('MAIL admin plan-invoice err:', e));

    // Klientui su PDF
    if (email) {
      await transporter.sendMail({
        from: `"RaskDali" <${SELLER.email}>`,
        to: email,
        subject: `Sąskaita – ${invoiceNo}`,
        html: `
          ${topLogoHtml}
          <div style="font-family:Arial,sans-serif;font-size:14px">
            <h2>Ačiū! Mokėjimas gautas ✅</h2>
            <p>Prisegame sąskaitą PDF formatu.</p>
          </div>
          ${EMAIL_FOOTER_HTML}
        `,
        attachments: attachPlan
      }).catch(e => console.error('MAIL client plan-invoice err:', e));
    }
  } catch (e) {
    console.error('Plano PDF/siuntimo klaida:', e);
  }
  /* ======= /BLOKO PABAIGA ======= */



  draft.emailed = true;
  delete draftsCache[orderid];
  await saveJson(DRAFTS_FILE, draftsCache);
  return true;
}

/* ---------- Kai apmokamas užsakymas iš pasiūlymo ---------- */
async function finalizePaidOrder(orderid, reason = 'callback') {
  const o = ordersCache[orderid];
  if (!o) return false;
  if (o.status === 'paid') return true;

  o.status = 'paid';

// ✅ jei sąskaitos numerio dar nėra – sugeneruojam ir IŠSAUGOM prie užsakymo
if (!o.invoiceNo) {
  o.invoiceNo = await nextInvoiceNo(); // sugeneruos pvz. MAGRD2025-00001
}
await saveJson(ORDERS_FILE, ordersCache);

// nuo čia visur naudokim būtent išsaugotą numerį
const invoiceNo = o.invoiceNo;
const pdf = await makeInvoicePdfBuffer({
  invoiceNo,
  buyer: o.buyer,
  items: o.items,
  footerNote: 'Apmokėta internetu. Sąskaita sugeneruota elektroninėmis priemonėmis ir galioja be parašo.',
  includeReturns: true
});

  const listHtml = o.items.map(it =>
    `<li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} €${it.desc ? `<br><i>${escapeHtml(it.desc)}</i>` : ''}</li>`
  ).join('');

  // ADMIN
  await transporter.sendMail({
    from: `"RaskDali" <${SELLER.email}>`,
    to: SELLER.email,
    subject: `Užsakymas apmokėtas – ${o.buyer?.name || 'klientas'} (order ${orderid})`,
    html: `
      ${topLogoHtml}
      <h3>Užsakymas apmokėtas</h3>
      <p><b>OrderID:</b> ${orderid}</p>
      <ul>${listHtml}</ul>
    `,
    attachments: [{ filename: `${invoiceNo}.pdf`, content: pdf, contentType: 'application/pdf' }],
  }).catch(e => console.error('MAIL admin order-paid err:', e));

  // KLIENTUI
  if (o.buyer?.email) {
    await transporter.sendMail({
      from: `"RaskDali" <${SELLER.email}>`,
      to: o.buyer.email,
      subject: `Mokėjimas gautas – ${invoiceNo}`,
      html: `
        ${topLogoHtml}
        <h2>Ačiū! Mokėjimas gautas ✅</h2>
        <p>Jūsų užsakymas priimtas vykdymui. Prisegame sąskaitą PDF formatu.</p>
        ${EMAIL_FOOTER_HTML}
      `,
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdf, contentType: 'application/pdf' }],
    }).catch(e => console.error('MAIL client order-paid err:', e));
  }
  return true;
}

/* ---------- 1) Mokami planai: start → Paysera ---------- */
const uploadPaid = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 40 } });

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

/* ---------- 2) Paysera callback: ir užklausoms, ir užsakymams ---------- */
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
      if (draftsCache[orderid]) {
        finalizePaidDraft(orderid, 'callback').catch(e => console.error('finalize draft err:', e));
      } else if (ordersCache[orderid]) {
        finalizePaidOrder(orderid, 'callback').catch(e => console.error('finalize order err:', e));
      } else {
        console.warn('Callback: orderid not found in drafts/orders', orderid);
      }
    }
    res.send('OK');
  } catch (e) {
    console.error('PAYSERA CALLBACK ERROR:', e);
    res.status(400).send('ERROR');
  }
});

/* ---------- 3) Ačiū ekranas (dinamiškai pagal tipą) ---------- */
app.get('/thanks', async (req, res) => {
  const ok = req.query.ok === '1';
  const orderid = (req.query.o || '').toString();
  const siteHome = (process.env.SITE_BASE_URL || 'https://www.raskdali.lt').replace(/\/+$/, '');

  let title = ok ? 'Mokėjimas priimtas' : 'Mokėjimas neįvyko';
  let text = ok ? 'Ačiū! Mokėjimas gautas.' : 'Galite pabandyti dar kartą arba susisiekti su mumis.';

  if (ok && orderid) {
    if (draftsCache[orderid]) {
      title = 'Jūsų užklausa apmokėta ir priimta';
      text = 'Paruošime detalių pasiūlymą artimiausiu metu.';
      finalizePaidDraft(orderid, 'return').catch(()=>{});
    } else if (ordersCache[orderid]) {
      title = 'Jūsų užsakymas apmokėtas ir priimtas';
      text = 'Pradėsime vykdymą. Sąskaitą PDF gavote el. paštu.';
      finalizePaidOrder(orderid, 'return').catch(()=>{});
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;margin:0;display:grid;place-items:center;height:100dvh}
  .card{max-width:640px;padding:28px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px #00000014;text-align:center}
  .ok{color:#16a34a;font-size:26px;font-weight:800;margin:10px 0}
  .fail{color:#ef4444;font-size:26px;font-weight:800;margin:10px 0}
  p{font-size:16px;color:#374151}
  a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600}
</style>
<div class="card">
  <div class="${ok ? 'ok' : 'fail'}">${escapeHtml(title)}</div>
  <p>${escapeHtml(text)}</p>
  <a class="btn" href="${escapeHtml(siteHome)}">Eiti į pradžią</a>
</div>`);
});

/* ---------- 4) Nemokamas planas ---------- */
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

    res.json({ ok: true }); // atsakome iš karto

    const head = `
      ${topLogoHtml}
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
        <p style="margin:0 0 12px 0"><b>Planas:</b> ${escapeHtml(plan)} · <b>Detalių (užpildyta):</b> ${items.length}</p>
        <p style="margin:0 0 12px 0"><b>VIN:</b> ${escapeHtml(vin)} · <b>Markė:</b> ${escapeHtml(marke)} · <b>Modelis:</b> ${escapeHtml(modelis)} · <b>Metai:</b> ${escapeHtml(metai)}</p>
        <p style="margin:0 0 12px 0"><b>Vardas/įmonė:</b> ${escapeHtml(vardas)} · <b>El. paštas:</b> ${escapeHtml(email)} · <b>Tel.:</b> ${escapeHtml(tel)}</p>
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

    // ADMIN
    transporter.sendMail({
      from: `"RaskDali" <${SELLER.email}>`,
      to: SELLER.email,
      subject: `Nemokama užklausa – ${vardas || 'klientas'}`,
      html: head + adminItemsHtml,
      attachments: adminAttachments
    }).catch(e => console.error('FREE admin mail err:', e));

    // KLIENTUI
    if (email) {
      transporter.sendMail({
        from: `"RaskDali" <${SELLER.email}>`,
        to: email,
        subject: 'Jūsų nemokama užklausa gauta – RaskDali',
        html: `
          ${topLogoHtml}
          <div style="font-family:Arial,sans-serif;font-size:14px">
            <h2 style="margin:6px 0 10px 0">Jūsų užklausa gauta 🎉</h2>
            <p>Ačiū! Dažniausiai atsakome per 24–48 val.</p>
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
app.post('/api/uzklausa_free', uploadFree.any(), handleFreeRequest);
app.post('/api/uzklausa-free', uploadFree.any(), handleFreeRequest);

/* ---------- (NAUJA) Sanitarizacija vienai detalės eilutei ---------- */
function sanitizeOfferItem(raw = {}) {
  const one = {
    pozNr: String(raw.pozNr || '').slice(0, 30),
    name:  String(raw.name  || '').slice(0, 200),
    desc:  String(raw.desc  || '').slice(0, 600),
    eta:   String(raw.eta   || '').slice(0, 100),
    type:  String(raw.type  || '').slice(0, 60),
    'price-vat':   String(raw['price-vat']   || ''),
    'price-novat': String(raw['price-novat'] || ''),
    imgSrc: null
  };
  const src = String(raw.imgSrc || '');
  // LEIDŽIAM http(s) ir data:image/*;base64,*
  if (/^(https?:\/\/|data:image\/(png|jpe?g|webp|gif);base64,)/i.test(src)) {
    one.imgSrc = src;
  }
  return one;
}

/* ---------- 5) Pasiūlymai (7 d. galiojimas) ---------- */
app.post('/api/sukurti-pasiulyma', async (req, res) => {
  try {
    // Tikimės { items:[...], shipping?: { label, price } }
    const data = req.body;
    const id = nanoid(6);

    // (Debug) – gali išjungti po testų
    try { console.log('Gauta /api/sukurti-pasiulyma:', JSON.stringify({ shipping: data?.shipping, itemsCount: Array.isArray(data?.items) ? data.items.length : 0 }).slice(0, 1000)); } catch {}

    // Normalizuojam shipping (neprivalomas)
    let shipping = undefined;
    if (data.shipping && (typeof data.shipping === 'object')) {
      const label = String(data.shipping.label ?? '').trim();
      const price = Number(String(data.shipping.price ?? '0').toString().replace(',', '.'));
      if (label || Number.isFinite(price)) {
        shipping = {
          label: label || 'Pristatymas',
          price: Number.isFinite(price) && price >= 0 ? price : 0
        };
      }
    }

    const itemsIn = Array.isArray(data.items) ? data.items : [];
    const items = itemsIn.map(sanitizeOfferItem);

    offersCache[id] = {
      items,
      shipping,                  // ← vienas, tavo parinktas pristatymas (arba nenurodytas)
      createdAt: Date.now()
    };

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
  .warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:10px 12px;border-radius:10px;margin:10px 0}
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

      <div class="warn">Dėmesio: <b>neapmokėti užsakymai nevykdomi.</b> Galite <b>apmokėti iškart žemiau</b> arba laukti <b>el. laiško</b> su nuoroda ir PDF sąskaita.</div>

<!-- Pristatymas (tik rodymas, be pasirinkimo) -->
${(() => {
  const s = offer.shipping;
  if (!s) return '';
  const price = Number(s.price || 0);
  const label = s.label ? escapeHtml(s.label) : 'Pristatymas';
  const eur = price.toFixed(2).replace('.', ',') + ' €';
  return `
    <div style="margin:14px 0">
      <div style="font-weight:600;margin-bottom:6px">Pristatymas</div>
      <div>${label}: <b>${eur}</b></div>
    </div>
  `;
})()}

<hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">

${rowsHtml || '<div class="small">Pasiūlymas tuščias.</div>'}
      <button type="submit" class="btn" style="margin-top:12px">Užsakyti pasirinktas</button>
<div id="chooseErr" class="warn" style="display:none;margin-top:10px">
  Nepasirinkta nei viena prekė – pažymėkite bent vieną.
</div>
<a href="${escapeHtml(home)}" style="margin-left:10px">Į pradžią</a>
       </form>
  </div>
<script>
  (function () {
    const form = document.querySelector('form[action^="/klientoats/"][method="POST"]');
    const errBox = document.getElementById('chooseErr');
    if (!form || !errBox) return;

    form.addEventListener('submit', function (e) {
      const hasAny = !!form.querySelector('input[name="choose"]:checked');
      if (!hasAny) {
        e.preventDefault();
        errBox.style.display = 'block';
        errBox.textContent = 'Nepasirinkta nei viena prekė – pažymėkite bent vieną.';
        errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, false);
  })();
</script>
</body></html>`);
});

/* ---------- 6) Užsakymas iš pasiūlymo → PDF + Paysera + laiškai ---------- */
app.post('/klientoats/:id/order', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const offer = offersCache[req.params.id];
    if (!offer) return res.status(404).send('Nerasta');

    const chooseRaw = req.body.choose ? (Array.isArray(req.body.choose) ? req.body.choose : [req.body.choose]) : [];
const idxs = chooseRaw
  .map(v => parseInt(v, 10))
  .filter(n => Number.isInteger(n) && n >= 0);

if (!idxs.length) {
  return res.status(400).send(`
    <meta charset="utf-8">
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;margin:0;display:grid;place-items:center;height:100dvh}
      .card{max-width:640px;padding:28px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px #00000014;text-align:center}
      .warn{color:#9a3412}
      a.btn,button.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600;border:none;cursor:pointer}
    </style>
    <div class="card">
      <h2 class="warn">Nepasirinkta nei viena prekė</h2>
      <p>Pažymėkite bent vieną detalę ir bandykite dar kartą.</p>
      <button class="btn" onclick="history.back()">Grįžti į pasiūlymą</button>
    </div>
  `);
}

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
  const items = idxs.map(i => offer.items[i]).filter(Boolean).map(it => {
  const price = parseFloat(String(it?.['price-vat'] ?? '0').replace(',', '.')) || 0;
  total += price;
  return { name: it?.name || '', desc: it?.desc || '', price, qty: 1 };
});

    // Jei pasiūlymas turi nustatytą pristatymą – įtraukiam
if (offer.shipping && (typeof offer.shipping === 'object')) {
  const shipLabel = String(offer.shipping.label ?? 'Pristatymas');
  const shipPrice = Number(offer.shipping.price ?? 0);
  if (Number.isFinite(shipPrice) && shipPrice >= 0) {
    items.push({ name: shipLabel, desc: '', price: shipPrice, qty: 1 });
    total += shipPrice;
  }
}

    const orderid = nanoid();
    ordersCache[orderid] = { ts: Date.now(), offerId: req.params.id, buyer, items, total, status: 'pending_payment' };
    await saveJson(ORDERS_FILE, ordersCache);

    // Paysera
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
      accepturl, cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? '1' : '0'
    }).toString();
    const dataB64 = Buffer.from(qp).toString('base64');
    const sign = crypto.createHash('md5').update(dataB64 + process.env.PAYSERA_PASSWORD).digest('hex');
    const payUrl = `https://bank.paysera.com/pay/?data=${encodeURIComponent(dataB64)}&sign=${sign}`;

    const detalesHtml = items.map(it =>
      `<li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} €${it.desc ? `<br><i>${escapeHtml(it.desc)}</i>` : ''}</li>`
    ).join('');

    // ADMIN
  transporter.sendMail({
  from: `"RaskDali" <${SELLER.email}>`,
  to: SELLER.email,
  subject: `Naujas užsakymas – ${buyer.name || 'klientas'} (order ${orderid})`,
  html: `
    ${topLogoHtml}
    <h3>Gautas užsakymas</h3>
    <p><b>OrderID:</b> ${orderid}</p>
    <ul>${detalesHtml}</ul>
    <p><b>Viso su PVM:</b> ${total.toFixed(2)} €</p>
    <p><a href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
  `
}).catch(e => console.error('offer→admin mail err:', e));

    // KLIENTUI (su pastaba „jei jau apmokėjote – nuorodos spausti nereikia“)
    if (email) {
     transporter.sendMail({
  from: `"RaskDali" <${SELLER.email}>`,
  to: email,
  subject: `Užsakymo santrauka – apmokėkite`,
  html: buildPayNowEmail({
    title: 'Jūsų užsakymo santrauka',
    items,
    total,
    buyer,
    payUrl
  })
  // attachments: []  // iki apmokėjimo – be priedų
})
.catch(e => console.error('offer→client mail err:', e));
    }

    // „Ačiū“ dėžutė (aiškiai įvardinta, kad tai užsakymas)
    res.send(`
      <meta charset="utf-8">
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#fff;margin:0;display:grid;place-items:center;height:100dvh}
        .card{max-width:640px;padding:28px;border:1px solid #e5e7eb;border-radius:16px;box-shadow:0 8px 30px #00000014;text-align:center}
        .muted{color:#6b7280}
        a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#436BAA;color:#fff;text-decoration:none;font-weight:600}
      </style>
      <div class="card">
        <h2>Ačiū! Jūsų <b>užsakymas</b> priimtas.</h2>
        <p class="muted">Galite apmokėti čia arba el. paštu gauta nuoroda. Neapmokėti užsakymai nevykdomi.</p>
        <p><a class="btn" href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
        <a class="btn" href="https://www.raskdali.lt/">Grįžti į pradžią</a>
      </div>
    `);
  } catch (e) {
    console.error('ORDER FROM OFFER ERROR:', e);
    res.status(500).send('Serverio klaida');
  }
});

/* ---------- 7) PDF peržiūra/atsisiuntimas pagal orderid ---------- */
app.get('/api/invoice/:orderid', async (req, res) => {
  try {
    const o = ordersCache[req.params.orderid];
    if (!o) return res.status(404).send('Nerasta');

    // Visada naudok išsaugotą sąskaitos numerį; jei jo dar nėra – sugeneruok ir įrašyk
    let invoiceNo = o.invoiceNo;
    if (!invoiceNo) {
      invoiceNo = await nextInvoiceNo();
      o.invoiceNo = invoiceNo;
      await saveJson(ORDERS_FILE, ordersCache);
    }

    const pdf = await makeInvoicePdfBuffer({
  invoiceNo,
  buyer: o.buyer,
  items: o.items,
  footerNote: o.status === 'paid'
    ? 'Apmokėta internetu. Sąskaita sugeneruota elektroninėmis priemonėmis ir galioja be parašo.'
    : undefined,
  includeReturns: true
});

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoiceNo}.pdf"`);
    res.send(pdf);
  } catch (e) {
    console.error('INVOICE SERVE ERROR:', e);
    res.status(500).send('Nepavyko sugeneruoti sąskaitos');
  }
});

/* ---------- 8) Sąskaitos + apmokėjimo nuorodos persiuntimas klientui ---------- */
app.post('/api/orders/:orderid/resend', async (req, res) => {
  try {
    const o = ordersCache[req.params.orderid];
    if (!o) return res.status(404).json({ error: 'Nerasta' });
    if (!o.buyer?.email) return res.status(400).json({ error: 'Nėra kliento el. pašto' });

    // Paysera link
    const amountCents = Math.round((o.total || 0) * 100);
    const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
    const accepturl = `${apiHost}/thanks?ok=1&o=${encodeURIComponent(req.params.orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const cancelurl = `${apiHost}/thanks?ok=0&o=${encodeURIComponent(req.params.orderid)}&return=${encodeURIComponent('https://www.raskdali.lt/')}`;
    const qp = new URLSearchParams({
      version: '1',
      projectid: String(Number(process.env.PAYSERA_PROJECT_ID)),
      orderid: req.params.orderid,
      amount: String(amountCents),
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      accepturl, cancelurl,
      callbackurl: `${apiHost}/api/paysera/callback`,
      test: process.env.PAYSERA_TEST === '1' ? '1' : '0'
    }).toString();
    const dataB64 = Buffer.from(qp).toString('base64');
    const sign = crypto.createHash('md5').update(dataB64 + process.env.PAYSERA_PASSWORD).digest('hex');
    const payUrl = `https://bank.paysera.com/pay/?data=${encodeURIComponent(dataB64)}&sign=${sign}`;

    // Pastovus sąskaitos numeris (naudojam esamą, jei jau yra)
    const invoiceNo = o.invoiceNo || `MAGRD${new Date(o.ts).getFullYear()}-${String(1).padStart(5, '0')}`; // fallback jei netyčia neįrašėm
    const pdf = await makeInvoicePdfBuffer({
  invoiceNo,
  buyer: o.buyer,
  items: o.items,
  footerNote: o.status === 'paid'
    ? 'Apmokėta internetu. Sąskaita sugeneruota elektroninėmis priemonėmis ir galioja be parašo.'
    : undefined,
  includeReturns: true
});

    await transporter.sendMail({
      from: `"RaskDali" <${SELLER.email}>`,
      to: o.buyer.email,
      subject: `Sąskaita apmokėjimui – ${invoiceNo}`,
      html: `
        ${topLogoHtml}
        <h2>Jūsų pasirinktos prekės</h2>
        <ul>${o.items.map(it => `<li><b>${escapeHtml(it.name)}</b> — ${Number(it.price).toFixed(2)} €</li>`).join('')}</ul>
        <p>Viso su PVM: <b>${(o.total || 0).toFixed(2)} €</b></p>
        <p>Apmokėti: <a href="${payUrl}" target="_blank" rel="noopener">Apmokėti per Paysera</a></p>
        <p style="color:#6b7280;font-size:13px">Jei jau apmokėjote, šios nuorodos spausti nereikia.</p>
        ${EMAIL_FOOTER_HTML}
      `,
      attachments: [{ filename: `${invoiceNo}.pdf`, content: pdf, contentType: 'application/pdf' }]
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error('RESEND ERROR', e);
    return res.status(500).json({ error: 'Nepavyko persiųsti' });
  }
});

/* ---------- Start ---------- */
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
