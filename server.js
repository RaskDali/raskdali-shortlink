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

// ====== KAINOS (tik serveryje) ======
const PRICES = {
  Mini: 9.99,
  Standart: 29.99,
  Pro: 59.99,
};

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

let offers = {};
try {
  offers = JSON.parse(await fs.readFile('offers.json', 'utf8'));
} catch (e) { offers = {}; }

// ---- SMTP KONFIGŪRACIJA (Hostinger)
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT || "465"),
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  }
});

// ================= Paysera: start link (redirect) =================
// Kviesk: GET /api/paysera/start?plan=Mini&return=https://www.raskdali.lt/uzklausa-mini
app.get('/api/paysera/start', (req, res) => {
  try {
    const planRaw = String(req.query.plan || '').trim();
    const returnUrl = String(req.query.return || '').trim();

    const price = PRICES[planRaw];
    if (!price || !returnUrl) {
      return res.status(400).send('Neteisingi parametrai.');
    }

    const amountCents = Math.round(price * 100);

    const params = new URLSearchParams({
      projectid: String(process.env.PAYSERA_PROJECTID || ''),
      orderid: 'RD-' + Date.now(),
      accepturl: `${returnUrl}?paid=1`,
      cancelurl: `${returnUrl}?paid=0`,
      callbackurl: `${req.protocol}://${req.get('host')}/paysera-callback`, // ateičiai
      version: '1.6',
      lang: 'LIT',
      currency: process.env.PAYSERA_CURRENCY || 'EUR',
      amount: String(amountCents),
      test: '0'
    });

    const data = Buffer.from(params.toString()).toString('base64');
    const sign = crypto
      .createHash('md5')
      .update(data + (process.env.PAYSERA_PASSWORD || ''), 'utf8')
      .digest('hex');

    const payUrl = `https://www.paysera.com/pay/?data=${encodeURIComponent(data)}&sign=${sign}`;
    return res.redirect(payUrl);
  } catch (e) {
    console.error('Paysera start error:', e);
    return res.status(500).send('Mokėjimo pradėti nepavyko.');
  }
});

// ---- Naujo pasiūlymo sukūrimas
app.post('/api/sukurti-pasiulyma', async (req, res) => {
  const data = req.body; // { items: [...] }
  const id = nanoid(6);
  offers[id] = data;
  await fs.writeFile('offers.json', JSON.stringify(offers, null, 2));
  res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
});

// ---- Kliento puslapis
app.get('/klientoats/:id', (req, res) => {
  const offer = offers[req.params.id];
  if (!offer) return res.status(404).send('Pasiūlymas nerastas');
  res.send(`
    <html>
      <head>
        <title>Detalių pasiūlymas</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f9f9f9; margin:0; }
          .wrapper { max-width: 700px; margin: 30px auto; background: #fff; border-radius: 12px; padding: 30px 40px; box-shadow: 0 2px 24px 2px #c1c3df3d; }
          h1 { text-align: center; margin-bottom: 28px; }
          .item { margin-bottom: 24px; border-bottom: 1px solid #d3d3e0; padding-bottom: 18px; }
          .item:last-child { border-bottom: none; }
          .img-preview { max-width: 90px; max-height: 70px; display: block; margin: 8px 0; }
          .order-btn { margin: 22px auto 0; display: block; background: #4A72E3; color: #fff; border: none; border-radius: 8px; padding: 12px 30px; font-size: 1.15em; cursor: pointer; }
          .order-sum { text-align:right; font-size:1.13em; margin:10px 0 12px 0;}
          label { font-weight: normal; font-size: 1em; }
        </style>
        <script>
        function updateSum() {
          let sumBe = 0, sumSu = 0;
          document.querySelectorAll('input[type=checkbox][name=choose]:checked').forEach(chk => {
            const novat = chk.dataset.priceNovat, vat = chk.dataset.priceVat;
            if (novat) sumBe += parseFloat(novat.replace(',', '.'));
            if (vat) sumSu += parseFloat(vat.replace(',', '.'));
          });
          document.getElementById('suma').innerHTML = "Suma pasirinkta: <b>" + sumSu.toFixed(2) + "€</b> (be PVM " + sumBe.toFixed(2) + "€)";
        }
        </script>
      </head>
      <body>
        <div class="wrapper">
        <h1>Detalių pasiūlymas</h1>
        <form method="POST" action="/klientoats/${req.params.id}/order">
          <div>
            <label>Vardas, pavardė/įmonė:<br><input name="vardas" required style="width:99%"></label><br>
            <label>El. paštas:<br><input type="email" name="email" required style="width:99%"></label><br>
            <label>Pristatymo adresas:<br><input name="adresas" required style="width:99%"></label><br>
          </div>
          <hr>
          ${(offer.items || []).map((item, i) => `
            <div class="item">
              <b>${item.pozNr ? `${item.pozNr}. ` : ""}${item.name || ''}</b>
              ${item.type ? `<span style="color:#4066B2; font-size:0.92em; margin-left:8px;">(${item.type})</span>` : ""}
              <div>
                ${item.imgSrc ? `<img src="${item.imgSrc}" class="img-preview">` : ""}
              </div>
              ${item.desc ? `<div><i>${item.desc}</i></div>` : ""}
              ${item.eta ? `<div>Pristatymas: <b>${item.eta}</b></div>` : ""}
              <div style="margin-top:4px;">
                Kaina: <b>${item["price-vat"] || ''}€</b> 
                ${item["price-novat"] ? `(<span style="color:#888; font-size:0.95em">be PVM ${item["price-novat"]}€</span>)` : ""}
              </div>
              <label>
                <input type="checkbox" name="choose" value="${i}" data-price-novat="${item["price-novat"]}" data-price-vat="${item["price-vat"]}" onchange="updateSum()"> Užsakyti šią detalę
              </label>
            </div>
          `).join('')}
          <div id="suma" class="order-sum">Suma pasirinkta: <b>0.00€</b> (be PVM 0.00€)</div>
          <button type="submit" class="order-btn">Užsakyti pasirinktas</button>
        </form>
        </div>
      </body>
    </html>
  `);
});

// ---- Užsakymo gavimas ir laiškų siuntimas
app.post('/klientoats/:id/order', async (req, res) => {
  const offer = offers[req.params.id];
  if (!offer) return res.status(404).send('Nerasta');
  const pasirinktos = req.body.choose ? (Array.isArray(req.body.choose) ? req.body.choose : [req.body.choose]) : [];
  const name = req.body.vardas || '';
  const email = req.body.email || '';
  const adresas = req.body.adresas || '';
  let total = 0, totalBe = 0;

  let pasirinktosPrekes = pasirinktos.map(i => offer.items[i]);
  pasirinktosPrekes.forEach(item => {
    total += parseFloat((item?.["price-vat"] || "0").replace(',', '.'));
    totalBe += parseFloat((item?.["price-novat"] || "0").replace(',', '.'));
  });

  // Laiškas tau
  if (email && pasirinktosPrekes.length) {
    let detalesHtml = pasirinktosPrekes.map(item => `
      <li><b>${item.pozNr ? `${item.pozNr}. ` : ''}${item.name || ''}</b> 
      (${item.type || ''}) – ${item["price-vat"] || ''}€ 
      ${item.desc ? `<i>${item.desc}</i>` : ''}</li>
    `).join('');
    let uzsakymasHtml = `
      <h3>Gautas naujas užsakymas</h3>
      <b>Vardas/įmonė:</b> ${name}<br>
      <b>El. paštas:</b> ${email}<br>
      <b>Adresas:</b> ${adresas}<br>
      <b>Prekės:</b><ul>${detalesHtml}</ul>
      <b>Viso su PVM:</b> ${total.toFixed(2)} €<br>
      <b>Viso be PVM:</b> ${totalBe.toFixed(2)} €
    `;

    try {
      // Tau (administratorius)
      await transporter.sendMail({
        from: `"RaskDali" <${process.env.MAIL_USER}>`,
        to: process.env.MAIL_USER,
        subject: "Naujas detalių užsakymas iš RaskDali",
        html: uzsakymasHtml
      });
      // Klientui
      await transporter.sendMail({
        from: `"RaskDali" <${process.env.MAIL_USER}>`,
        to: email,
        subject: "Jūsų užsakymas priimtas – RaskDali",
        html: `
          <h2>Ačiū, Jūsų užsakymas priimtas!</h2>
          <p>Jūsų pasirinktos prekės:</p>
          <ul>${detalesHtml}</ul>
          <div>Viso su PVM: <b>${total.toFixed(2)} €</b></div>
          <div>Viso be PVM: <b>${totalBe.toFixed(2)} €</b></div>
          <p>Jūsų užsakymą gavome. Netrukus el. paštu atsiųsime sąskaitą su apmokėjimo nuoroda.</p>
          <br>
          <b>RaskDali komanda</b>
        `
      });
    } catch (e) {
      console.error("Nepavyko išsiųsti el. laiško:", e);
    }
  }

  // Atsakymas klientui naršyklėje
  res.send(`
    <html>
    <head>
      <title>Užsakymas pateiktas</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f9f9f9;}
        .box { background: #fff; max-width: 480px; margin: 44px auto; border-radius: 8px; padding: 32px 28px; box-shadow: 0 2px 16px 2px #c1c3df3d; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>Ačiū, Jūsų užsakymas priimtas!</h2>
        <p>Pasirinktos prekės:</p>
        <ul>
          ${pasirinktosPrekes.map(item => `<li>${item.pozNr ? `${item.pozNr}. ` : ''}${item.name || ''} (${item.type || ''}) – ${item["price-vat"] || ''}€</li>`).join('')}
        </ul>
        <div>Viso su PVM: <b>${total.toFixed(2)} €</b></div>
        <div>Viso be PVM: <b>${totalBe.toFixed(2)} €</b></div>
        <div style="margin-top:14px;">Greitu metu atsiųsime sąskaitą apmokėjimui el. paštu.</div>
      </div>
    </body>
    </html>
  `);
});

// =================== UŽKLAUSOS FORMA (Mini/Standart/Pro) ===================
// nuotraukas laikom atminty, ribojam po 5MB vienai
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 40 },
});

app.post('/api/uzklausa', upload.any(), async (req, res) => {
  try {
    const vin      = (req.body.vin || '').trim();
    const marke    = (req.body.marke || '').trim();
    const modelis  = (req.body.modelis || '').trim();
    const metai    = (req.body.metai || '').trim();

    const komentaras = (req.body.komentaras || '').trim();
    const vardas     = (req.body.vardas || '').trim();
    const email      = (req.body.email || '').trim();
    const tel        = (req.body.tel || '').trim();

    const plan  = (req.body.plan || 'Nežinomas').trim();
    const count = Math.max(1, parseInt(req.body.count || '5', 10));

    // SURINKTI DETALES (priimame abi schemas – "items[0][name]" ir "item_0_name")
    const items = [];
    for (let i = 0; i < count; i++) {
      const name  = (req.body[`items[${i}][name]`]  || req.body[`item_${i}_name`]  || '').trim();
      const desc  = (req.body[`items[${i}][desc]`]  || req.body[`item_${i}_desc`]  || '').trim();
      const notes = (req.body[`items[${i}][notes]`] || req.body[`item_${i}_notes`] || '').trim();
      const file  = (req.files || []).find(f => f.fieldname === `items[${i}][image]` || f.fieldname === `item_${i}_image`);
      if (!(name || desc || notes || file)) continue;
      items.push({ idx: i + 1, name, desc, notes, file });
    }

    if (!items.length) {
      return res.status(400).json({ error: 'Bent viena detalė turi būti užpildyta.' });
    }

    // --- Paruošiam laiškus (HTML + priedai)
    const logoUrl = 'https://assets.zyrosite.com/A0xl6GKo12tBorNO/rask-dali-siauras-YBg7QDW7g6hKw3WD.png';
    const adminItemsHtml = items.map((it, idx) => {
      const imgTag = it.file ? `<div style="margin-top:6px"><img src="cid:item${idx}_cid" style="max-width:320px;border:1px solid #eee;border-radius:6px"></div>` : '';
      const title  = it.name ? escapeHtml(it.name) : '(be pavadinimo)';
      return `
        <div style="padding:10px 12px;border:1px solid #eee;border-radius:10px;margin:8px 0">
          <div style="font-weight:600">#${it.idx}: ${title}</div>
          ${it.desc  ? `<div><b>Aprašymas:</b> ${escapeHtml(it.desc)}</div>`   : ''}
          ${it.notes ? `<div><b>Pastabos:</b> ${escapeHtml(it.notes)}</div>`   : ''}
          ${imgTag}
        </div>
      `;
    }).join('');

    const commonTop = `
      <table width="100%" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif">
        <tr><td style="padding:16px 0">
          <img src="${logoUrl}" alt="RaskDali" style="height:26px">
        </td></tr>
      </table>
      <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
        <p style="margin:0 0 12px 0">
          <b>Planas:</b> ${escapeHtml(plan)} &nbsp;|&nbsp; 
          <b>Detalių (užpildyta):</b> ${items.length}
        </p>
        <p style="margin:0 0 12px 0">
          <b>VIN:</b> ${escapeHtml(vin)} &nbsp;|&nbsp; 
          <b>Markė:</b> ${escapeHtml(marke)} &nbsp;|&nbsp; 
          <b>Modelis:</b> ${escapeHtml(modelis)} &nbsp;|&nbsp; 
          <b>Metai:</b> ${escapeHtml(metai)}
        </p>
        <p style="margin:0 0 12px 0">
          <b>Vardas/įmonė:</b> ${escapeHtml(vardas)} &nbsp;|&nbsp; 
          <b>El. paštas:</b> ${escapeHtml(email)} &nbsp;|&nbsp; 
          <b>Tel.:</b> ${escapeHtml(tel)}
        </p>
        ${komentaras ? `<p style="margin:0 0 12px 0"><b>Komentarai:</b> ${escapeHtml(komentaras)}</p>` : ''}
        <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
      </div>
    `;

    const adminHtml = `${commonTop}<div style="font-family:Arial,sans-serif;font-size:14px">${adminItemsHtml}</div>`;

    const attachments = items.map((it, idx) => {
      if (!it.file) return null;
      return {
        filename: it.file.originalname || `detale_${it.idx}.jpg`,
        content: it.file.buffer,
        contentType: it.file.mimetype || 'application/octet-stream',
        cid: `item${idx}_cid`
      };
    }).filter(Boolean);

    const admin = process.env.MAIL_USER || 'info@raskdali.lt';

    // 1) iškart atsakom klientui — nereiks laukti el. laiškų siuntimo
    res.json({ ok: true });

    // 2) laiškus siųsti fone
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
            ${commonTop}
            <div style="font-family:Arial,sans-serif;font-size:14px">
              <h2 style="margin:6px 0 10px 0">Jūsų užklausa gauta 🎉</h2>
              <p>Ačiū! Gavome Jūsų užklausą (<b>${escapeHtml(plan)}</b>). Dažniausiai pasiūlymą pateikiame per <b>24–48 val.</b></p>
              <hr style="border:none;border-top:1px solid #eee;margin:12px 0">
              ${items.map(it => `
                <div style="padding:8px 0">
                  <div><b>#${it.idx}:</b> ${escapeHtml(it.name || '(be pavadinimo)')}</div>
                  ${it.desc ? `<div>Aprašymas: ${escapeHtml(it.desc)}</div>` : ''}
                </div>
              `).join('')}
            </div>
          `;
          await transporter.sendMail({
            from: `"RaskDali" <${admin}>`,
            to: email,
            subject: 'Jūsų užklausa gauta – RaskDali',
            html: clientHtml
          });
        }
      } catch (mailErr) {
        console.error('MAIL SEND ERROR:', mailErr);
      }
    });

  } catch (err) {
    console.error('UZKLAUSA ERROR:', err);
    try { res.status(500).json({ error: 'Serverio klaida. Bandykite dar kartą.' }); } catch {}
  }
});

// paprasta HTML escaping helper funkcija
function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

app.listen(port, () => console.log('Serveris veikia ant port ' + port));
