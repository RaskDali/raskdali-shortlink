import express from "express";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = "links.json";

// Nedidelė atminties (RAM) duomenų bazė
let links = {};

// Bando užkrauti iš failo (jei yra)
if (fs.existsSync(DB_FILE)) {
  links = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
}

// Sutrumpinto linko sugeneravimas
function generateShortCode(length = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Sukuria naują shortlink
app.use(express.json());
app.post("/api/create", (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: "Missing data" });

  let code;
  do {
    code = generateShortCode();
  } while (links[code]);

  links[code] = data;
  fs.writeFileSync(DB_FILE, JSON.stringify(links));
  res.json({ short: code });
});

// Atidaro linko duomenis
app.get("/:code", (req, res) => {
  const { code } = req.params;
  const data = links[code];
  if (!data) return res.status(404).send("Not found");
  res.json({ data });
});

app.listen(PORT, () => {
  console.log("Shortlink server running on port " + PORT);
});
