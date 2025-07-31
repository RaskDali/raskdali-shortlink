import express from 'express';
import fs from 'fs/promises';
import { nanoid } from 'nanoid';

const app = express();
app.use(express.json());

// CORS MIDDLEWARE – PRIDĖK ŠITĄ BLOKĄ ČIA
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

let offers = {};

// Užkrauk pasiūlymus jei yra
try {
  offers = JSON.parse(await fs.readFile('offers.json', 'utf8'));
} catch (e) { offers = {}; }

// 1. Sukurti naują pasiūlymą ir grąžinti trumpą nuorodą
app.post('/api/sukurti-pasiulyma', async (req, res) => {
  const data = req.body; // visa pasiūlymo info
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
    <h1>Detalių pasiūlymas</h1>
    <form method="POST" action="/klientoats/${req.params.id}/order">
      ${offer.items.map((item, i) => `
        <div>
          <b>${item.title}</b> – ${item.price}€
          <img src="${item.img || ''}" style="max-width:90px"><br>
          <label><input type="checkbox" name="choose" value="${i}"> Užsakyti</label>
        </div>
      `).join('')}
      <button type="submit">Užsakyti pasirinktas</button>
    </form>
  `);
});

// 3. Gauti pasirinkimą (užsakymą)
app.use(express.urlencoded({ extended: true }));
app.post('/klientoats/:id/order', (req, res) => {
  const offer = offers[req.params.id];
  if (!offer) return res.status(404).send('Nerasta');
  const pasirinktos = req.body.choose || [];
  // Čia gali padaryt: išsiųsti tau į email arba išsaugoti faile
  // Dabar grąžina ką pasirinko
  res.send(`
    <h2>Ačiū, Jūsų užsakymas priimtas!</h2>
    <p>Pasirinktos prekės:</p>
    <ul>
      ${Array.isArray(pasirinktos) ? pasirinktos.map(i => `<li>${offer.items[i].title}</li>`).join('') : `<li>${offer.items[pasirinktos].title}</li>`}
    </ul>
  `);
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('Serveris veikia ant port ' + port));
