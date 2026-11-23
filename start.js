// Zagon za strežnik: ob prvem zagonu (prazna baza) naloži demo podatke, nato zažene aplikacijo.
const fs = require('fs'), path = require('path');
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
if (!fs.existsSync(dbFile) && process.env.SEED_DEMO !== '0') require('./seed');
const app = require('./server');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Terminko teče na vratih ${PORT}`));
