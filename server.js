import express from 'express';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// --- CORS Middleware ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

let offers = {};

// --- Užkrauna pasiūlymus, jei yra ---
try {
  offers = JSON.parse(await fs.readFile('offers.json', 'utf8'));
} catch (e) { offers = {}; }

// 1. Sukuria naują pasiūlymą ir grąžina trumpą nuorodą
app.post('/api/sukurti-pasiulyma', async (req, res) => {
  const data = req.body; // visa pasiūlymo info (turi būti: { items: [ ... ] })
  const id = nanoid(6);
  offers[id] = data;
  await fs.writeFile('offers.json', JSON.stringify(offers, null, 2));
  res.json({ link: `https://raskdali-shortlink.onrender.com/klientoats/${id}` });
});

// 2. Klientas pagal nuorodą mato savo pasiūlymą
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
          label { font-weight: normal; font-size: 1em; }
        </style>
      </head>
      <body>
        <div class="wrapper">
        <h1>Detalių pasiūlymas</h1>
        <form method="POST" action="/klientoats/${req.params.id}/order">
          ${(offer.items || []).map((item, i) => `
            <div class="item">
              <b>${item.name || ''}</b>
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
                <input type="checkbox" name="choose" value="${i}"> Užsakyti šią detalę
              </label>
            </div>
          `).join('')}
          <button type="submit" class="order-btn">Užsakyti pasirinktas</button>
        </form>
        </div>
      </body>
    </html>
  `);
});

// 3. Gauti pasirinkimą (užsakymą)
app.post('/klientoats/:id/order', (req, res) => {
  const offer = offers[req.params.id];
  if (!offer) return res.status(404).send('Nerasta');
  const pasirinktos = req.body.choose || [];
  // Parodo ką pasirinko vartotojas
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
          ${Array.isArray(pasirinktos)
            ? pasirinktos.map(i => `<li>${offer.items[i]?.name || ''}</li>`).join('')
            : `<li>${offer.items[pasirinktos]?.name || ''}</li>`
          }
        </ul>
      </div>
    </body>
    </html>
  `);
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
