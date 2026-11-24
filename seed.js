// Demo podatki. Samostojno: node seed.js  (POBRIŠE celotno bazo na MONGODB_URI in naloži primer)
// start.js ga pokliče samodejno samo, ko je baza popolnoma prazna.
const crypto = require('crypto');
const { connect, S, oid, hash, providerDefaults } = require('./store');
const A = require('./avail');

async function seed() {
  await S().drop();
  const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin1234';
  await S().users.insertOne({ email: 'admin@terminko.si', passwordHash: hash(ADMIN_PW), role: 'admin', name: 'Leja (admin)', phone: '', createdAt: new Date() });

  async function provider(email, data, hours, services) {
    const { insertedId: userId } = await S().users.insertOne({ email, passwordHash: hash('geslo1234'), role: 'provider', name: data.businessName, phone: data.phone, createdAt: new Date() });
    const weeklyHours = [];
    for (const [days, ranges] of hours) for (const weekday of days) for (const [start, end] of ranges) weeklyHours.push({ weekday, start, end });
    const { insertedId: pid } = await S().providers.insertOne({ ...providerDefaults(), ...data, userId, email, weeklyHours });
    const ids = {};
    for (const [i, s] of services.entries()) {
      ids[s.name] = (await S().services.insertOne({
        providerId: pid, category: s.cat, name: s.name, description: s.desc || '', durationMin: s.min, priceCents: Math.round(s.eur * 100),
        imageId: null, active: true, sort: i, processing: s.pm ? { offsetMin: s.po, durationMin: s.pm, allowedServiceIds: [] } : null, createdAt: new Date(),
      })).insertedId;
    }
    return { pid, ids };
  }

  const lana = await provider('lana@primer.si', {
    slug: 'studio-lana', businessName: 'Frizerski studio Lana', accentColor: '#9a7452', phone: '+386 41 111 222',
    address: 'Slovenska cesta 10, Ljubljana', description: 'Striženje, barvanje in nega las v prijetnem studiu v centru mesta.',
  }, [[[1, 2, 3, 4], [['08:00', '12:00'], ['13:00', '19:00']]], [[5], [['08:00', '16:00']]], [[6], [['08:00', '13:00']]]], [
    { cat: 'Striženje', name: 'Žensko striženje', min: 45, eur: 28, desc: 'Pranje, striženje in feniranje' },
    { cat: 'Striženje', name: 'Moško striženje', min: 30, eur: 18 },
    { cat: 'Striženje', name: 'Otroško striženje', min: 30, eur: 14, desc: 'Do 12. leta' },
    { cat: 'Barvanje', name: 'Barvanje las', min: 120, eur: 65, desc: 'Nanos barve, delovanje, pranje in feniranje', po: 30, pm: 45 },
    { cat: 'Barvanje', name: 'Pramenski balayage', min: 180, eur: 120, desc: 'Ročno nanešeni prameni, toniranje', po: 60, pm: 50 },
    { cat: 'Nega', name: 'Globinska nega las', min: 30, eur: 20 },
    { cat: 'Nega', name: 'Svečana pričeska', min: 60, eur: 40 },
  ]);
  // barvanje: med čakanjem lahko izvaja moško/otroško/žensko striženje
  const cuts = ['Žensko striženje', 'Moško striženje', 'Otroško striženje'].map(n => lana.ids[n]);
  await S().services.updateMany({ _id: { $in: [lana.ids['Barvanje las'], lana.ids['Pramenski balayage']] } }, { $set: { 'processing.allowedServiceIds': cuts } });

  const maja = await provider('maja@primer.si', {
    slug: 'nohti-maja', businessName: 'Nail studio Maja', accentColor: '#b5735c', phone: '+386 40 333 444',
    address: 'Glavni trg 5, Maribor', description: 'Gel lak, nadgradnja in nega rok ter stopal.',
  }, [[[1, 2, 3, 4, 5], [['09:00', '18:00']]]], [
    { cat: 'Roke', name: 'Gel lak', min: 60, eur: 32.5 },
    { cat: 'Roke', name: 'Nadgradnja nohtov', min: 120, eur: 55 },
    { cat: 'Roke', name: 'Manikura', min: 45, eur: 25 },
    { cat: 'Noge', name: 'Pedikura', min: 60, eur: 35 },
  ]);

  // Primer rezervacij za naslednji delovni dan (pon–čet)
  let day = A.nowLocal().slice(0, 10);
  do day = A.addDays(day, 1); while (A.weekday(day) > 4);
  async function book(pr, names, time, name, phone, fillsGapOf = null) {
    const svcs = await S().services.find({ _id: { $in: names.map(n => pr.ids[n]) } }).toArray();
    svcs.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
    const plan = A.planSegments(svcs, A.toMin(time));
    const { insertedId: customerId } = await S().customers.insertOne({ name, phone, email: null, userId: null, createdAt: new Date(), lastBookingAt: new Date() });
    const { insertedId } = await S().bookings.insertOne({
      providerId: pr.pid, customerId, customer: { name, phone, email: null }, note: '', date: day,
      start: A.dt(day, plan.items[0].start), end: A.dt(day, plan.end), totalCents: svcs.reduce((a, s) => a + s.priceCents, 0),
      status: 'confirmed', token: crypto.randomBytes(16).toString('hex'), reminderSent: false, source: 'online', fillsGapOf,
      items: plan.items.map(it => ({ serviceId: it.serviceId, name: it.name, priceCents: it.priceCents, start: A.dt(day, it.start), end: A.dt(day, it.end),
        gap: it.gap ? { start: A.dt(day, it.gap.s), end: A.dt(day, it.gap.e), allowedServiceIds: it.gap.allowed.map(oid) } : null })),
      createdAt: new Date(),
    });
    return insertedId;
  }
  const ana = await book(lana, ['Barvanje las'], '09:00', 'Ana Novak', '+38631000001');
  await book(lana, ['Moško striženje'], '09:30', 'Marko Kralj', '+38631000004', ana);
  await book(lana, ['Barvanje las'], '13:00', 'Tina Golob', '+38631000005');
  await book(lana, ['Žensko striženje'], '16:00', 'Petra Kos', '+38631000002');
  await book(maja, ['Gel lak'], '10:00', 'Nina Zupan', '+38631000003');
  await require('./naja').ensureNaja();
  console.log(`Demo podatki pripravljeni (primer rezervacij: ${day}).
  Admin:      admin@terminko.si / ${ADMIN_PW}
  Naročnica:  lana@primer.si / geslo1234  → /b/studio-lana
  Naročnica:  maja@primer.si / geslo1234  → /b/nohti-maja`);
}

module.exports = seed;
if (require.main === module) connect().then(seed).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
