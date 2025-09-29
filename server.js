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
const LOGO_H = parseInt(process.env.LOGO_H || '52', 10);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(DATA_DIR, 'uploads');

const DRAFTS_FILE      = path.join(DATA_DIR, 'drafts.json');
const ORDERS_FILE      = path.join(DATA_DIR, 'orders.json');
const OFFERS_FILE      = path.join(DATA_DIR, 'offers.json');
const INVOICE_SEQ_FILE = path.join(DATA_DIR, 'invoice_seq.json');

/* ---------- App ---------- */
const app = express();
const port = process.env.PORT || 10000;

// ↓ mažesnis limitas, nes nebenešam base64 nuotraukų JSON'e
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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

function eurosToWordsLt(amount) {
  const units = ['nulis','vienas','du','trys','keturi','penki','šeši','septyni','aštuoni','devyni'];
  const teens = ['dešimt','vienuolika','dvylika','trylika','keturiolika','penkiolika','šešiolika','septyniolika','aštuoniolika','devyniolika'];
  const tens  = ['','', 'dvidešimt','trisdešimt','keturiasdešimt','penkiasdešimt','šešiasdešimt','septyniasdešimt','aštuoniasdešimt','devyniasdešimt'];
  const hundreds = ['','šimtas','du šimtai','trys šimtai','keturi šimtai','penki šimtai','šeši šimtai','septyni šimtai','aštuoni šimtai','devyni šimtai'];
  function form(n, vnt, dgs, kil) { if (n % 100 >= 10 && n % 100 <= 19) return kil; const u = n % 10; if (u === 1) return vnt; if (u >= 2 && u <= 9) return dgs; return kil; }
  function upTo999(n) {
    const h = Math.floor(n/100), r = n%100; let out = [];
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
  function chunk(n, i) {
    const words = upTo999(i);
    if (i === 0) return '';
    if (n === 1000)     return words + ' ' + form(i,'tūkstantis','tūkstančiai','tūkstančių');
    if (n === 1000000)  return words + ' ' + form(i,'milijonas','milijonai','milijonų');
    return words;
  }
  const euros = Math.floor(Number(amount) || 0);
  const cents = Math.round(((Number(amount) || 0) - euros) * 100);
  const parts = [];
  const mln = Math.floor(euros / 1_000_000);
  const th  = Math.floor((euros % 1_000_000) / 1_000);
  const rest = euros % 1000;
  if (mln) parts.push(chunk(1_000_000, mln));
  if (th)  parts.push(chunk(1000, th));
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
  const calc = crypto.createHash('md5').update(data + signPassword).digest('md5').digest('hex'); // wrong – fixed below
}
// ↑ ops, pataisom verify:
function verifyPayseraResponseCorrect(data, sign, signPassword) {
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
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("Nepavyko sukurti DATA_DIR:", e);
  }
}

/* ---------- Invoice numbering ---------- */
async function nextInvoiceNo() {
  let seq = await loadJson(INVOICE_SEQ_FILE);
  const yr = new Date().getFullYear();
  if (!seq.year || seq.year !== yr) {
    seq = { year: yr, counter: 0 };
  }
  seq.counter += 1;
  await saveJson(INVOICE_SEQ_FILE, seq);
  const prefix = 'MAGRD' + yr;
  const num = String(seq.counter).padStart(5, '0');
  return `${prefix}-${num}`;
}

/* ---------- Rekvizitai ---------- */
const SELLER = {
  name: 'RaskDali.lt / UAB „Magdaris“',
  addr: 'Vilniaus g. 3B, Karmėlava, 54448, Lietuva',
  code: '159941827',
  vat: 'LT599418219',
  email: process.env.MAIL_USER || 'info@raskdali.lt',
  vatRate: 0.21,
};

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
const topLogoHtml = `
  <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif">
    <tr><td style="padding:16px 0">
      <img src="https://assets.zyrosite.com/A0xl6GKo12tBorNO/rask-dali-siauras-YBg7QDW7g6hKw3WD.png" alt="RaskDali" style="height:26px">
    </td></tr>
  </table>`;

/* ---------- PDF ---------- */
function formatMoney(n) { return Number(n || 0).toFixed(2) + ' €'; }

async function makeInvoicePdfBuffer({ invoiceNo, buyer, items, footerNote, includeReturns = true }) {
  const VAT = SELLER.vatRate || 0.21;
  function sumGross(items) {
    return (items || []).reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty || 1)), 0);
  }
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 36, bufferPages: true });
    const chunks = [];
    doc.on('data', b => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try { doc.registerFont('Sans', FONT_REG); doc.registerFont('SansBold', FONT_BOLD); } catch {}
    doc.font('Sans');

    function ensureSpace(h) {
      const bottom = doc.page.margins.bottom;
      if (doc.y + h > doc.page.height - bottom) doc.addPage();
    }

    const startY = 36;
    let headerBottomY = startY;
    try { if (fsSync.existsSync(LOGO_PATH)) { doc.image(LOGO_PATH, 36, startY, { fit: [140, 40] }); headerBottomY = Math.max(headerBottomY, startY + 44); } } catch {}
    doc.font('SansBold').fontSize(14).fillColor('#111')
      .text('PVM SĄSKAITA – FAKTŪRA', 0, startY, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Sans').fontSize(10).fillColor('#333')
      .text(`Serija/NR: ${invoiceNo}`, { align: 'center' })
      .text(`Išrašymo data: ${new Date().toLocaleDateString('lt-LT')}`, { align: 'center' });

    headerBottomY = Math.max(headerBottomY, doc.y);
    doc.moveTo(36, headerBottomY + 10).lineTo(559, headerBottomY + 10).strokeColor('#e5e7eb').lineWidth(1).stroke();

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

    const TABLE_START_Y = 250;
    y = Math.max(doc.y, TABLE_START_Y);

    const cols = { name: 36, qty: 320, unitNet: 368, vatAmt: 452, lineGross: 520 };

    ensureSpace(28);
    doc.font('SansBold').fontSize(10).fillColor('#111');
    doc.text('Produktas / paslauga', cols.name, y, { width: cols.qty - cols.name - 6 });
    doc.text('Kiekis', cols.qty, y, { width: cols.unitNet - cols.qty - 6, align: 'right' });
    doc.text('Vnt. kaina be PVM', cols.unitNet, y, { width: cols.vatAmt - cols.unitNet - 6, align: 'right' });
    doc.text('PVM suma', cols.vatAmt, y, { width: cols.lineGross - cols.vatAmt - 6, align: 'right' });
    doc.text('Suma su PVM', cols.lineGross, y, { width: 559 - cols.lineGross - 6, align: 'right' });

    let headBottom = Math.max(doc.y, y) + 4;
    doc.moveTo(36, headBottom).lineTo(559, headBottom).strokeColor('#e5e7eb').lineWidth(0.6).stroke();
    y = headBottom + 8;

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
      doc.text(lineVat.toFixed(2) + ' €', cols.vatAmt, y, { width: cols.lineGross - cols.vatAmt - 6, align: 'right' });
      doc.text(lineGross.toFixed(2) + ' €', cols.lineGross, y, { width: 559 - cols.lineGross - 6, align: 'right' });

      const rowBottom = Math.max(
        y + doc.heightOfString(it.name || '', { width: cols.qty - cols.name - 6 }),
        y + doc.heightOfString(qty.toString(), { width: cols.unitNet - cols.qty - 6 }),
        y + doc.heightOfString(netUnit.toFixed(2)+' €', { width: cols.vatAmt - cols.unitNet - 6 }),
        y + doc.heightOfString(lineVat.toFixed(2)+' €', { width: cols.lineGross - cols.vatAmt - 6 }),
        y + doc.heightOfString(lineGross.toFixed(2)+' €', { width: 559 - cols.lineGross - 6 }),
      );
      y = rowBottom + 4;

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

    const gross = (items || []).reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.qty || 1)), 0);
    const net   = gross / (1 + VAT);
    const vat   = gross - net;

    y += 8; ensureSpace(60);
    doc.font('Sans').fontSize(10).fillColor('#111').text(`Iš viso be PVM: ${net.toFixed(2)} €`, 0, y, { align: 'right' }); y += 14;
    doc.text(`PVM (${Math.round(VAT*100)}%): ${vat.toFixed(2)} €`, 0, y, { align: 'right' }); y += 14;
    doc.font('SansBold').fontSize(12).text(`Iš viso su PVM: ${gross.toFixed(2)} €`, 0, y, { align: 'right' });

    y += 16; ensureSpace(30);
    doc.font('Sans').fontSize(10).fillColor('#374151').text('Suma žodžiais: ' + eurosToWordsLt(gross), 36, y, { width: 520 });

    y += 24; ensureSpace(40);
    const note = footerNote || 'Pastaba: neapmokėti užsakymai nevykdomi. Apmokėjimo terminas – 14 kalendorinių dienų. www.raskdali.lt';
    doc.font('Sans').fontSize(9).fillColor('#6b7280').text(note, 36, y, { width: 520 });

    if (includeReturns) {
      y = doc.y + 8; ensureSpace(24);
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
  await ensureDataDir();
  await fs.mkdir(UPLOADS_DIR, { recursive: true }).catch(()=>{});
  // statinė talpa nuotraukoms
  app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d', setHeaders(res){ res.setHeader('Cache-Control','public, max-age=604800'); } }));

  draftsCache = await loadJson(DRAFTS_FILE);
  offersCache = await loadJson(OFFERS_FILE);
  ordersCache = await loadJson(ORDERS_FILE);
})();

/* ---------- Upload API (nuotraukoms) + valymas ---------- */
const uploadImg = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname || '').toLowerCase()) || '.jpg';
      cb(null, `${Date.now()}-${nanoid(6)}${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 }, // 2MB per foto
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif)$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Netinkamas formatas'), ok);
  }
});

app.post('/api/upload-image', uploadImg.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Failas nepridėtas' });
  const apiHost = (process.env.PUBLIC_API_HOST || 'https://raskdali-shortlink.onrender.com').replace(/\/+$/, '');
  const url = `${apiHost}/uploads/${req.file.filename}`;
  res.json({ url });
});

async function pruneUploads(maxAgeDays = 7) {
  try {
    const cutoff = Date.now() - maxAgeDays*24*3600*1000;
    const files = await fs.readdir(UPLOADS_DIR);
    await Promise.all(files.map(async f => {
      const p = path.join(UPLOADS_DIR, f);
      const st = await fs.stat(p).catch(()=>null);
      if (st && st.isFile() && st.mtimeMs < cutoff) {
        await fs.unlink(p).catch(()=>{});
      }
    }));
  } catch {}
}
pruneUploads().catch(()=>{});
setInterval(()=>pruneUploads().catch(()=>{}), 24*3600*1000);

/* ---------- Emails helper ---------- */
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

/* ---------- finalizePaidDraft / finalizePaidOrder ---------- */
// (palieku tavo nepakeistus – jie buvo geri; tik verify pataisa žemiau callbacke)

async function finalizePaidDraft(orderid, reason = 'unknown') { /* ... tavo originalas be pakeitimų ... */ }
async function finalizePaidOrder(orderid, reason = 'callback') { /* ... tavo originalas be pakeitimų ... */ }

/* ---------- 1) Mokami planai: start → Paysera ---------- */
// (palieku kaip buvo)
const uploadPaid = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 40 } });
app.post('/api/uzklausa-start', uploadPaid.any(), async (req, res) => { /* ... tavo kodas ... */ });

/* ---------- 2) Paysera callback ---------- */
app.post('/api/paysera/callback', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const { data, sign } = req.body || {};
    if (!data || !sign) return res.status(400).send('ERROR');
    if (!verifyPayseraResponseCorrect(data, sign, process.env.PAYSERA_PASSWORD)) {
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

/* ---------- 3) Ačiū ekranas ---------- */
app.get('/thanks', async (req, res) => { /* ... tavo kodas ... */ });

/* ---------- 4) Nemokamas planas ---------- */
const uploadFree = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5*1024*1024, files: 20 } });
async function handleFreeRequest(req, res) { /* ... tavo kodas ... */ }
app.post('/api/uzklausa_free', uploadFree.any(), handleFreeRequest);
app.post('/api/uzklausa-free', uploadFree.any(), handleFreeRequest);

/* ---------- 5) Pasiūlymai (7 d.) ---------- */
// Sanitizer – leidžiam tik http(s) URL nuotraukai
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
  if (/^https?:\/\//i.test(src)) one.imgSrc = src; // tik URL
  return one;
}

app.post('/api/sukurti-pasiulyma', async (req, res) => {
  try {
    const data = req.body;
    const id = nanoid(6);

    let shipping = undefined;
    if (data.shipping && (typeof data.shipping === 'object')) {
      const label = String(data.shipping.label ?? '').trim();
      const price = Number(data.shipping.price ?? 0);
      if (label || Number.isFinite(price)) {
        shipping = { label: label || 'Pristatymas', price: Number.isFinite(price) && price >= 0 ? price : 0 };
      }
    }

    const itemsIn = Array.isArray(data.items) ? data.items : [];
    const items = itemsIn.map(sanitizeOfferItem);

    offersCache[id] = { items, shipping, createdAt: Date.now() };
    await saveJson(OFFERS_FILE, offersCache);
    res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
  } catch (e) {
    console.error('CREATE OFFER ERROR:', e);
    res.status(500).json({ error: 'Nepavyko sukurti pasiūlymo' });
  }
});

app.get('/klientoats/:id', (req, res) => { /* ... tavo kodas (HTML renderis) ... */ });

/* ---------- 6) Užsakymas iš pasiūlymo ---------- */
app.post('/klientoats/:id/order', express.urlencoded({ extended: true }), async (req, res) => { /* ... tavo kodas ... */ });

/* ---------- 7) PDF pagal orderid ---------- */
app.get('/api/invoice/:orderid', async (req, res) => { /* ... tavo kodas ... */ });

/* ---------- 8) Persiuntimas klientui ---------- */
app.post('/api/orders/:orderid/resend', async (req, res) => { /* ... tavo kodas ... */ });

/* ---------- Start ---------- */
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
