import express from 'express';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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
    // Laiškas klientui – GAVOME užsakymą
    let klientuiHtml = `
      <h2>Ačiū, Jūsų užsakymas priimtas!</h2>
      <p>Jūsų pasirinktos prekės:</p>
      <ul>${detalesHtml}</ul>
      <div>Viso su PVM: <b>${total.toFixed(2)} €</b></div>
      <div>Viso be PVM: <b>${totalBe.toFixed(2)} €</b></div>
      <p>Jūsų užsakymą gavome. Netrukus el. paštu atsiųsime sąskaitą su apmokėjimo nuoroda.</p>
      <br>
      <b>RaskDali komanda</b>
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
        html: klientuiHtml
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

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
