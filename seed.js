// Demo podatki: node seed.js  (pobriše obstoječo bazo)
const fs = require('fs'), path = require('path');
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f);
const { q, hash } = require('./db');
const A = require('./avail');
const crypto = require('crypto');

const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin1234';
q.run('INSERT INTO users (email,password_hash,role,name) VALUES (?,?,?,?)', 'admin@terminko.si', hash(ADMIN_PW), 'admin', 'Leja (admin)');

function provider(email, data, hours, services) {
  const u = q.run('INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,?,?,?)', email, hash('geslo1234'), 'provider', data.business_name, data.phone);
  const p = q.run('INSERT INTO providers (user_id,slug,business_name,description,address,phone,email,accent) VALUES (?,?,?,?,?,?,?,?)',
    u.lastInsertRowid, data.slug, data.business_name, data.description, data.address, data.phone, email, data.accent);
  const pid = Number(p.lastInsertRowid);
  for (const [days, ranges] of hours) for (const d of days) for (const [s, e] of ranges) q.run('INSERT INTO weekly_hours (provider_id,weekday,start,end) VALUES (?,?,?,?)', pid, d, s, e);
  const ids = {};
  services.forEach((s, i) => {
    ids[s.name] = Number(q.run('INSERT INTO services (provider_id,category,name,description,duration_min,price_cents,sort,processing_offset,processing_min) VALUES (?,?,?,?,?,?,?,?,?)',
      pid, s.cat, s.name, s.desc || '', s.min, Math.round(s.eur * 100), i, s.po || 0, s.pm || 0).lastInsertRowid);
  });
  return { pid, ids };
}

const lana = provider('lana@primer.si', {
  slug: 'studio-lana', business_name: 'Frizerski studio Lana', accent: '#9a7452', phone: '+386 41 111 222',
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
q.run('UPDATE services SET gap_allowed=? WHERE id IN (?,?)', JSON.stringify([lana.ids['Žensko striženje'], lana.ids['Moško striženje'], lana.ids['Otroško striženje']]), lana.ids['Barvanje las'], lana.ids['Pramenski balayage']);

const maja = provider('maja@primer.si', {
  slug: 'nohti-maja', business_name: 'Nail studio Maja', accent: '#b5735c', phone: '+386 40 333 444',
  address: 'Glavni trg 5, Maribor', description: 'Gel lak, nadgradnja in nega rok ter stopal.',
}, [[[1, 2, 3, 4, 5], [['09:00', '18:00']]]], [
  { cat: 'Roke', name: 'Gel lak', min: 60, eur: 32.5 },
  { cat: 'Roke', name: 'Nadgradnja nohtov', min: 120, eur: 55 },
  { cat: 'Roke', name: 'Manikura', min: 45, eur: 25 },
  { cat: 'Noge', name: 'Pedikura', min: 60, eur: 35 },
]);

// Primer rezervacij za jutri
function nextWorkday(d) { do d = A.addDays(d, 1); while (A.weekday(d) > 4); return d; }
const day = nextWorkday(A.nowLocal().slice(0, 10));
function book(pid, names, ids, time, name, phone) {
  const svcs = names.map(n => q.get('SELECT * FROM services WHERE id=?', ids[n]));
  const plan = A.planSegments(svcs, A.toMin(time));
  const r = q.run('INSERT INTO bookings (provider_id,customer_name,customer_phone,customer_email,start,end,total_cents,token) VALUES (?,?,?,?,?,?,?,?)', pid, name, phone, null,
    A.dt(day, plan.items[0].start), A.dt(day, plan.end), svcs.reduce((a, s) => a + s.price_cents, 0), crypto.randomBytes(16).toString('hex'));
  for (const it of plan.items) q.run('INSERT INTO booking_items (booking_id,service_id,name,start,end,gap_start,gap_end,gap_allowed,price_cents) VALUES (?,?,?,?,?,?,?,?,?)',
    r.lastInsertRowid, it.service_id, it.name, A.dt(day, it.start), A.dt(day, it.end), it.gap ? A.dt(day, it.gap.s) : null, it.gap ? A.dt(day, it.gap.e) : null, JSON.stringify(it.gap?.allowed || []), it.price_cents);
}
book(lana.pid, ['Barvanje las'], lana.ids, '09:00', 'Ana Novak', '+386 31 000 001');
book(lana.pid, ['Moško striženje'], lana.ids, '09:30', 'Marko Kralj', '+386 31 000 004');
book(lana.pid, ['Barvanje las'], lana.ids, '13:00', 'Tina Golob', '+386 31 000 005');
book(lana.pid, ['Žensko striženje'], lana.ids, '16:00', 'Petra Kos', '+386 31 000 002');
book(maja.pid, ['Gel lak'], maja.ids, '10:00', 'Nina Zupan', '+386 31 000 003');
console.log(`Demo podatki pripravljeni (primer rezervacij: ${day}).
  Admin:      admin@terminko.si / ${ADMIN_PW}
  Naročnica:  lana@primer.si / geslo1234  → /b/studio-lana
  Naročnica:  maja@primer.si / geslo1234  → /b/nohti-maja`);
