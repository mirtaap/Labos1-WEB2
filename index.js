
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { v4: generateUniqueId } = require('uuid');
const QRCode = require('qrcode');
const axios = require('axios');
const { auth } = require('express-openid-connect');

const app = express();

// Postavljanje middleware-a
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Postavke za bazu podataka
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});


const authConfig = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH0_CLIENT_SECRET,
  baseURL: process.env.BASE_URL,
  clientID: process.env.AUTH0_CLIENT_ID,
  issuerBaseURL: process.env.AUTH0_DOMAIN,
  
};

app.use(auth(authConfig));


async function fetchTicketCount(vatin) {
  if (!vatin) {
    console.log('OIB nije dostupan.');
    return 0;
  }
  
  const result = await db.query('SELECT COUNT(*) FROM tickets WHERE vatin = $1', [vatin]);
  console.log(`Dohvaćen broj ulaznica za OIB ${vatin}: ${result.rows[0].count}`);
  return parseInt(result.rows[0].count, 10);
}


app.get('/', async (req, res) => {
  const user = req.oidc.user ? req.oidc.user : null;

  let ticketCount = 0; 
  if (user && user.vatin) {
    
    ticketCount = await fetchTicketCount(user.vatin);
  }

  res.send(`
    <html>
      <head>
        <link rel="stylesheet" href="/css/styles.css">
        <title>Dobrodošli</title>
      </head>
      <body>
        <div class="main-content">
          <h1>Broj generiranih ulaznica: ${ticketCount}</h1>
          ${user ? `
            <h2>Dobrodošli, ${user.name}!</h2>
            <p>Kreirajte novu ulaznicu:</p>
            <form action="/generate-ticket" method="post">
              <input type="text" name="vatin" placeholder="OIB" required>
              <input type="text" name="firstName" placeholder="Ime" required>
              <input type="text" name="lastName" placeholder="Prezime" required>
              <button type="submit">Generiraj</button>
            </form>
            <a href="/logout">Odjava</a>
          ` : `
            <a href="/login">Prijava</a>
          `}
        </div>
      </body>
    </html>
  `);
});


app.post('/generate-ticket', async (req, res) => {
  const { vatin, firstName, lastName } = req.body;
  if (!vatin || !firstName || !lastName) {
    return res.status(400).json({ error: 'Nedostaju podaci.' });
  }

  
  const existingTickets = await db.query('SELECT COUNT(*) FROM tickets WHERE vatin = $1', [vatin]);
  const ticketCount = parseInt(existingTickets.rows[0].count, 10);

  console.log(`Broj ulaznica za OIB ${vatin}: ${ticketCount}`);

  if (ticketCount >= 3) {
    return res.status(400).json({ error: 'Za ovaj OIB već su kreirane tri ulaznice. Ne možete generirati više.' });
  }

  
  const tokenResponse = await axios.post(`https://dev-lbatmpgrgxqtv2la.us.auth0.com/oauth/token`, {
    client_id: process.env.MACHINE_TO_MACHINE,
    client_secret: process.env.SECRET_ID,
    audience: `https://web2-qr-kod-api.com/ticket`, // Zamijenjeno s vašim API identifikatorom
    grant_type: 'client_credentials',
  });

  const accessToken = tokenResponse.data.access_token;

  
  const apiResponse = await axios.post(`https://web2-qr-kod-api.com/ticket`, {
    vatin, firstName, lastName,
  }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const ticketId = generateUniqueId();
  const createdAt = new Date();
  await db.query('INSERT INTO tickets (id, vatin, firstName, lastName, createdAt) VALUES ($1, $2, $3, $4, $5)', 
    [ticketId, vatin, firstName, lastName, createdAt]);

  console.log(`Ulaznica kreirana: ${ticketId}, OIB: ${vatin}, Vrijeme: ${createdAt}`);
  res.redirect(`/ticket/${ticketId}`);
});


app.get('/ticket/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const result = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  const ticket = result.rows[0];

  if (!ticket) {
    return res.status(404).send('Ulaznica nije pronađena.');
  }

  
  const qrUrl = `${process.env.BASE_URL}/scanned/${ticketId}`; // URL za QR kod
  const qrCodeImage = await QRCode.toDataURL(qrUrl);

  res.send(`
    <html>
      <head>
        <link rel="stylesheet" href="/css/styles.css">
        <title>Vaša ulaznica</title>
      </head>
      <body>
        <div class="ticket-display">
          <h1>Vaša ulaznica je spremna</h1>
          <p>Ime: ${ticket.firstname}</p>
          <p>Prezime: ${ticket.lastname}</p>
          <p>OIB: ${ticket.vatin}</p>
          <p>Vrijeme kreiranja: ${ticket.createdat}</p>
          <img src="${qrCodeImage}" alt="QR kod">
          <a href="/">Povratak na početnu</a>
        </div>
      </body>
    </html>
  `);
});


app.get('/scanned/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const result = await db.query('SELECT * FROM tickets WHERE id = $1', [ticketId]);
  const ticket = result.rows[0];

  if (!ticket) {
    return res.status(404).send('Ulaznica nije pronađena.');
  }

  res.send(`
    <html>
      <head>
        <link rel="stylesheet" href="/css/styles.css">
        <title>Detalji ulaznice</title>
      </head>
      <body>
        <div class="ticket-display">
          <h1>Vaša ulaznica je spremna</h1>
          <p>Identifikator ulaznice: ${ticket.id}</p>
          <p>Vrijeme kreiranja: ${ticket.createdat}</p>
          <p>QR kod više nije potreban na ovoj stranici.</p>
          <a href="/">Povratak na početnu</a>
        </div>
      </body>
    </html>
  `);
});


app.listen(3000, () => console.log('Aplikacija pokrenuta na portu 3000'));
