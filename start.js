// Zagon strežnika: poveže se z MongoDB (MONGODB_URI), ob popolnoma prazni bazi naloži demo podatke, nato zažene aplikacijo.
const { connect } = require('./store');

(async () => {
  const store = await connect();
  console.log(store.kind === 'mongodb' ? `Povezano z MongoDB (baza "${store.db.databaseName}")` : 'Baza v pomnilniku (samo za preizkus)');
  if (await store.isEmpty() && process.env.SEED_DEMO !== '0') await require('./seed')();
  await require('./naja').ensureNaja();
  const { app, init } = require('./server');
  init();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Terminko teče na vratih ${PORT}`));
})().catch(e => { console.error('Zagon ni uspel:', e.message); process.exit(1); });
