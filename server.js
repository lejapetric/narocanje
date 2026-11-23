const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { q, db, hash, verify } = require('./db');
const A = require('./avail');
const N = require('./notify');
const V = require('./views');
const { esc, eur, dur, page, topbar, dashLayout, thumb } = V;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret-change-me', resave: false, saveUninitialized: false, cookie: { sameSite: 'lax', httpOnly: true } }));
app.use('/static', express.static(path.join(__dirname, 'public')));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
require('fs').mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));
const upload = multer({
  storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (r, f, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(f.originalname).toLowerCase()) }),
  limits: { fileSize: 5e6 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)),
});

app.use((req, res, next) => {
  req.user = req.session.uid ? q.get('SELECT id,email,role,name,phone FROM users WHERE id=?', req.session.uid) : null;
  res.locals.flash = req.session.flash; delete req.session.flash;
  next();
});
const flash = (req, msg) => { req.session.flash = msg; };
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const toCents = v => Math.round(parseFloat(String(v).replace(',', '.').replace(/[^\d.]/g, '')) * 100) || 0;

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!roles.includes(req.user.role)) return res.status(403).send(page('Ni dostopa', '<div class="center-card"><h2>Ni dostopa</h2></div>', { nav: topbar(req.user) }));
    next();
  };
}
function withProvider(req, res, next) {
  if (req.user.role === 'provider') req.provider = q.get('SELECT * FROM providers WHERE user_id=?', req.user.id);
  else if (req.user.role === 'admin') {
    if (!req.session.actingProvider) return res.redirect('/admin');
    req.provider = q.get('SELECT * FROM providers WHERE id=?', req.session.actingProvider);
  }
  if (!req.provider) return res.redirect('/admin');
  next();
}
const dash = (req, res, title, body, active, actions = '') => res.send(dashLayout(title, body, { user: req.user, provider: req.provider, active, flash: res.locals.flash, actions }));

// ---------- Javno ----------
const { icon, cover } = V;
const authShell = (title, sub, form) => page(title, `<div class="auth"><div class="auth-side">${V.logo()}
  <div class="auth-quote"><h2>Spletno naročanje, ki dela <em>namesto vas.</em></h2><p>Stranke se naročijo same, 24 ur na dan. Vi dobite SMS in urejen koledar.</p>
  <ul class="auth-list"><li>${icon('check', 16)} Lastna povezava za vsak salon</li><li>${icon('check', 16)} Termini se izračunajo glede na storitve</li><li>${icon('check', 16)} Potrditve in opomniki po SMS in e-pošti</li></ul></div>
  <small>© ${new Date().getFullYear()} Terminko</small></div>
  <div class="auth-main"><div class="auth-box"><h1>${title}</h1><p class="muted">${sub}</p>${form}</div></div></div>`, { bodyClass: 'is-auth' });

app.get('/', (req, res) => {
  if (req.user?.role === 'admin') return res.redirect('/admin');
  if (req.user?.role === 'provider') return res.redirect('/dash');
  const provs = q.all(`SELECT p.*, (SELECT COUNT(*) FROM services s WHERE s.provider_id=p.id AND s.active=1) n FROM providers p WHERE active=1 ORDER BY business_name`);
  res.send(page('Spletno naročanje', `${topbar(req.user)}
  <section class="hero"><span class="eyebrow">${icon('sparkles', 14)} Naročanje za salone in studie</span>
   <h1>Vaš naslednji termin,<br><em>v nekaj sekundah.</em></h1>
   <p>Izberite salon, storitve in prost termin. Brez klicev, brez čakanja, brez registracije.</p></section>
  <section class="wrap"><div class="sec-h"><h2>Saloni</h2><span class="muted">${provs.length} ${provs.length === 1 ? 'salon' : 'salonov'}</span></div>
   <div class="grid3">${provs.map(p => `<a class="prov-card" href="/b/${esc(p.slug)}">${cover(p, 'cover-sm')}<div class="pc-body"><b>${esc(p.business_name)}</b>
    <span class="muted small">${icon('map-pin', 14)} ${esc(p.address)}</span><span class="muted small">${p.n} storitev</span></div></a>`).join('')}</div></section>`));
});

app.get('/login', (req, res) => res.send(authShell('Prijava', 'Prijavite se v svoj račun.', `<form class="form" method="post">
  ${res.locals.flash ? `<div class="flash err">${esc(res.locals.flash)}</div>` : ''}
  <label>E-pošta<input name="email" type="email" required autofocus autocomplete="email"></label><label>Geslo<input name="password" type="password" required autocomplete="current-password"></label>
  <input type="hidden" name="next" value="${esc(req.query.next || '')}"><button class="btn block lg">Prijava</button>
  <p class="muted small center">Ste stranka brez računa? <a href="/register${req.query.next ? '?next=' + encodeURIComponent(req.query.next) : ''}">Ustvarite ga</a>, ni pa obvezen.</p></form>`)));
app.post('/login', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE email=?', String(req.body.email || '').trim().toLowerCase());
  if (!u || !verify(req.body.password || '', u.password_hash)) { flash(req, 'Napačna e-pošta ali geslo.'); return res.redirect('/login'); }
  req.session.regenerate(() => {
    req.session.uid = u.id;
    const next = String(req.body.next || '');
    res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : u.role === 'admin' ? '/admin' : u.role === 'provider' ? '/dash' : '/moje');
  });
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/register', (req, res) => res.send(authShell('Ustvari račun', 'Z računom imate pregled nad rezervacijami, podatki pa so pri naročanju že izpolnjeni.', `<form class="form" method="post">
  ${res.locals.flash ? `<div class="flash err">${esc(res.locals.flash)}</div>` : ''}
  <label>Ime in priimek<input name="name" required autocomplete="name"></label><label>E-pošta<input name="email" type="email" required autocomplete="email"></label>
  <label>Telefon<input name="phone" type="tel" autocomplete="tel"></label><label>Geslo<input name="password" type="password" minlength="8" required autocomplete="new-password" placeholder="vsaj 8 znakov"></label>
  <input type="hidden" name="next" value="${esc(req.query.next || '')}"><button class="btn block lg">Ustvari račun</button>
  <p class="muted small center">Že imate račun? <a href="/login">Prijava</a></p></form>`)));
app.post('/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (q.get('SELECT 1 FROM users WHERE email=?', email)) { flash(req, 'Ta e-pošta je že registrirana.'); return res.redirect('/register'); }
  if (String(req.body.password || '').length < 8) { flash(req, 'Geslo mora imeti vsaj 8 znakov.'); return res.redirect('/register'); }
  const r = q.run('INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,?,?,?)', email, hash(req.body.password), 'customer', req.body.name, req.body.phone || '');
  q.run('UPDATE bookings SET customer_user_id=? WHERE customer_email=? AND customer_user_id IS NULL', r.lastInsertRowid, email);
  req.session.uid = Number(r.lastInsertRowid);
  const next = String(req.body.next || '');
  res.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/moje');
});

const statusPill = (b, now) => b.status === 'cancelled' ? '<span class="pill red">Odpovedano</span>' : b.start < now ? '<span class="pill grey">Opravljeno</span>' : '<span class="pill green">Potrjeno</span>';
app.get('/moje', requireRole('customer'), (req, res) => {
  const bs = q.all(`SELECT b.*, p.business_name, p.slug, p.accent, p.address FROM bookings b JOIN providers p ON p.id=b.provider_id WHERE b.customer_user_id=? ORDER BY b.start DESC`, req.user.id);
  const now = A.nowLocal();
  res.send(page('Moje rezervacije', `${topbar(req.user)}<section class="wrap narrow"><h1 class="page-h">Moje rezervacije</h1>
  ${bs.length ? bs.map(b => `<a class="card row-card" href="/r/${b.token}"><div class="date-chip" style="--accent:${esc(b.accent)}"><small>${V.MONTHS[Number(b.start.slice(5, 7)) - 1].slice(0, 3)}</small><b>${Number(b.start.slice(8, 10))}</b></div>
   <div class="grow"><b>${esc(b.business_name)}</b><div class="muted small">${V.DAYS[A.weekday(b.start.slice(0, 10))]} ob ${b.start.slice(11)} · ${esc(b.address)}</div></div>${statusPill(b, now)}</a>`).join('')
      : `<div class="empty">${icon('calendar-days', 28)}<p>Še nimate rezervacij.</p><a class="btn" href="/">Poišči salon</a></div>`}
  </section>`));
});

// Stran za naročanje
app.get('/b/:slug', (req, res) => {
  const p = q.get('SELECT * FROM providers WHERE slug=?', req.params.slug);
  if (!p || (!p.active && req.user?.role !== 'admin')) return res.status(404).send(page('Ni najdeno', `${topbar(req.user)}<div class="empty big">${icon('search-x', 32)}<h2>Stran ne obstaja</h2><a class="btn" href="/">Na začetek</a></div>`));
  const services = q.all('SELECT id,category,name,description,duration_min,price_cents,image,processing_min FROM services WHERE provider_id=? AND active=1 ORDER BY sort, category, name', p.id);
  const hours = q.all('SELECT weekday,start,end FROM weekly_hours WHERE provider_id=? ORDER BY weekday,start', p.id);
  const today = A.nowLocal().slice(0, 10), todayR = A.workingRanges(p.id, today);
  const data = { slug: p.slug, name: p.business_name, services, today, maxDays: p.max_days_ahead,
    user: req.user ? { name: req.user.name, email: req.user.email, phone: req.user.phone } : null };
  const cats = [...new Set(services.map(s => s.category || 'Storitve'))];
  const openTxt = todayR.length ? `Danes odprto do ${A.fromMin(todayR[todayR.length - 1][1])}` : 'Danes zaprto';
  res.send(page(p.business_name, `${topbar(req.user)}
  <div class="bk" style="--accent:${esc(p.accent)}">
   <div class="bk-head">
     <div class="bk-title"><h1>${esc(p.business_name)}</h1>
      <div class="meta"><span>${icon('map-pin', 15)} ${esc(p.address)}</span><span class="${todayR.length ? 'open-now' : ''}">${icon('clock', 15)} ${openTxt}</span>${p.phone ? `<span>${icon('phone', 15)} ${esc(p.phone)}</span>` : ''}</div></div>
     ${cover(p)}
   </div>
   <div class="bk-body">
    <div class="stepper" id="stepper"><div data-s="1" class="on"><i>1</i>Storitve</div><span></span><div data-s="2"><i>2</i>Termin</div><span></span><div data-s="3"><i>3</i>Podatki</div></div>
    <section id="step1">
      <h2 class="step-h">Izberite <em>storitve</em></h2>${p.description ? `<p class="about">${esc(p.description)}</p>` : ''}
      <div class="cat-tabs">${cats.map((c, i) => `<a class="${i ? '' : 'on'}" href="#cat-${esc(slugify(c))}">${esc(c)}</a>`).join('')}</div>
      ${cats.map(c => `<h2 class="cat-h" id="cat-${esc(slugify(c))}">${esc(c)}</h2><div class="svc-list">${services.filter(s => (s.category || 'Storitve') === c).map((s, i) => `
        <label class="svc reveal" style="--i:${i}"><input type="checkbox" value="${s.id}">${thumb(s.image, s.name, 'thumb', s.category)}
          <div class="svc-info"><b>${esc(s.name)}</b><div class="svc-meta">${dur(s.duration_min)}${s.processing_min ? ` <span class="dot"></span> vključuje ${s.processing_min} min čakanja` : ''}</div>${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}<div class="svc-price">${eur(s.price_cents)}</div></div>
          <span class="add">${icon('plus', 18, 'i-plus')}${icon('check', 18, 'i-check')}</span></label>`).join('')}</div>`).join('')}
      ${hours.length ? `<h2 class="cat-h">Delovni čas</h2><div class="hours-list">${[1, 2, 3, 4, 5, 6, 7].map(d => { const h = hours.filter(x => x.weekday === d); return `<div class="${A.weekday(today) === d ? 'today' : ''}"><span><i class="${h.length ? 'o' : 'c'}"></i>${V.DAYS[d]}</span><span>${h.length ? h.map(x => x.start + ' – ' + x.end).join(', ') : 'Zaprto'}</span></div>`; }).join('')}</div>` : ''}
    </section>
    <section id="step2" hidden>
      <div class="sec-top"><button class="icon-btn" data-go="1" aria-label="Nazaj">${icon('arrow-left', 18)}</button><h2>Izberite <em>termin</em></h2></div>
      <div class="cal-head"><b id="monthLbl"></b><div><button class="icon-btn" id="prevW" aria-label="Prejšnji teden">${icon('chevron-left', 18)}</button><button class="icon-btn" id="nextW" aria-label="Naslednji teden">${icon('chevron-right', 18)}</button></div></div>
      <div class="days" id="days"></div><div class="slots" id="slots"></div>
    </section>
    <section id="step3" hidden>
      <div class="sec-top"><button class="icon-btn" data-go="2" aria-label="Nazaj">${icon('arrow-left', 18)}</button><h2>Še nekaj <em>podatkov</em></h2></div>
      <form id="details" class="form">
        ${req.user ? '' : `<div class="note">${icon('user', 16)}<span>Že imate račun? <a href="/login?next=/b/${esc(p.slug)}">Prijavite se</a> in podatki bodo izpolnjeni. Račun ni obvezen.</span></div>`}
        <label>Ime in priimek<input name="name" required autocomplete="name"></label>
        <div class="two"><label>E-pošta<input name="email" type="email" autocomplete="email"></label>
        <label>Mobilni telefon<input name="phone" type="tel" placeholder="+386 …" autocomplete="tel"></label></div>
        <label>Opomba za salon <span class="opt">neobvezno</span><textarea name="note" rows="3" placeholder="npr. dolžina las, alergije …"></textarea></label>
        <p class="muted small">${icon('shield-check', 14)} Vpišite vsaj e-pošto ali telefon, da vam pošljemo potrditev. Podatkov ne delimo z nikomer.</p>
        <div class="err" id="err"></div>
      </form>
    </section>
    <section id="step4" hidden><div class="done"><div class="big-check">${icon('check', 36)}</div><h2>Se <em>vidimo</em> kmalu!</h2><p class="muted">Rezervacija je potrjena.</p><div id="doneTxt"></div></div></section>
   </div>
   <aside class="bk-summary" id="summary">
     <div class="sum-prov">${cover(p, 'sum-cover')}<div><b>${esc(p.business_name)}</b><small class="muted">${esc(p.address)}</small></div></div>
     <div id="sumItems" class="sum-items"><div class="sum-empty">Izberite eno ali več storitev.</div></div>
     <div id="sumWhen" class="sum-when"></div>
     <div class="sum-total"><span>Skupaj</span><b id="sumTotal">0,00 €</b></div>
     <button class="btn block lg" id="nextBtn" disabled>Naprej</button>
     <p class="sum-note muted small">Plačilo v salonu. Brezplačna odpoved do ${p.cancel_hours} ur prej.</p>
   </aside>
  </div>
  <footer class="foot">Naročanje omogoča ${V.logo()}</footer>
  <script>window.BK=${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script src="/static/book.js"></script>`));
});

app.get('/api/b/:slug/availability', (req, res) => {
  const p = q.get('SELECT * FROM providers WHERE slug=? AND active=1', req.params.slug);
  if (!p) return res.status(404).json({ error: 'ni najdeno' });
  const ids = String(req.query.services || '').split(',').filter(Boolean);
  const svcs = A.loadServices(p.id, ids);
  if (!svcs || !svcs.length) return res.status(400).json({ error: 'neveljavne storitve' });
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : A.nowLocal().slice(0, 10);
  res.json(A.availability(p, svcs, from, Math.min(Number(req.query.days) || 7, 31)));
});

app.post('/api/b/:slug/book', async (req, res) => {
  const p = q.get('SELECT * FROM providers WHERE slug=? AND active=1', req.params.slug);
  if (!p) return res.status(404).json({ error: 'ni najdeno' });
  const { services = [], date, time, name, email, phone, note } = req.body;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Vpišite ime.' });
  if (!email && !phone) return res.status(400).json({ error: 'Vpišite e-pošto ali telefon.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Neveljaven termin.' });
  const svcs = A.loadServices(p.id, services);
  if (!svcs || !svcs.length) return res.status(400).json({ error: 'Neveljavne storitve.' });
  let booking, items;
  try {
    db.exec('BEGIN IMMEDIATE');
    const ok = A.slotsForDate(p, svcs, date).some(s => s.time === time) && A.availability(p, svcs, date, 1)[date].some(s => s.time === time);
    if (!ok) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Termin žal ni več prost. Izberite drugega.' }); }
    const plan = A.planSegments(svcs, A.toMin(time));
    const total = svcs.reduce((a, s) => a + s.price_cents, 0);
    const token = crypto.randomBytes(16).toString('hex');
    const custId = req.user?.role === 'customer' ? req.user.id : (email ? q.get("SELECT id FROM users WHERE email=? AND role='customer'", String(email).toLowerCase())?.id ?? null : null);
    const r = q.run('INSERT INTO bookings (provider_id,customer_user_id,customer_name,customer_email,customer_phone,note,start,end,total_cents,token) VALUES (?,?,?,?,?,?,?,?,?,?)',
      p.id, custId, String(name).trim(), email ? String(email).trim().toLowerCase() : null, phone || null, note || '', A.dt(date, plan.items[0].start), A.dt(date, plan.end), total, token);
    for (const it of plan.items) q.run('INSERT INTO booking_items (booking_id,service_id,name,start,end,gap_start,gap_end,gap_allowed,price_cents) VALUES (?,?,?,?,?,?,?,?,?)',
      r.lastInsertRowid, it.service_id, it.name, A.dt(date, it.start), A.dt(date, it.end), it.gap ? A.dt(date, it.gap.s) : null, it.gap ? A.dt(date, it.gap.e) : null, JSON.stringify(it.gap?.allowed || []), it.price_cents);
    db.exec('COMMIT');
    booking = q.get('SELECT * FROM bookings WHERE id=?', r.lastInsertRowid);
    items = q.all('SELECT * FROM booking_items WHERE booking_id=? ORDER BY start', booking.id);
  } catch (e) { try { db.exec('ROLLBACK'); } catch { } console.error(e); return res.status(500).json({ error: 'Napaka pri shranjevanju.' }); }
  await N.bookingCreated(booking, items, p);
  res.json({ ok: true, token: booking.token, start: booking.start, end: booking.end, total: eur(booking.total_cents) });
});

function bookingView(b, p, items, user, msg) {
  const now = A.nowLocal();
  const canCancel = b.status === 'confirmed' && A.addMinutes(now, p.cancel_hours * 60) <= b.start;
  return page('Rezervacija', `${topbar(user)}<div class="wrap narrow" style="--accent:${esc(p.accent)}">
   ${msg ? `<div class="flash">${icon('circle-check', 18)}<span>${esc(msg)}</span></div>` : ''}
   <div class="card receipt">
    <div class="rc-head">${cover(p, 'sum-cover')}<div class="grow"><b>${esc(p.business_name)}</b><small class="muted">${esc(p.address)}</small></div>${statusPill(b, now)}</div>
    <div class="rc-when"><div class="date-chip"><small>${V.MONTHS[Number(b.start.slice(5, 7)) - 1].slice(0, 3)}</small><b>${Number(b.start.slice(8, 10))}</b></div>
     <div><b class="big">${V.DAYS[A.weekday(b.start.slice(0, 10))]}, ${V.fmtDate(b.start)}</b><div class="muted">${b.start.slice(11)} – ${b.end.slice(11)}</div></div></div>
    <div class="rc-items">${items.map(i => `<div class="line"><span>${esc(i.name)}<small class="muted"> · ${i.start.slice(11)}</small></span><span>${eur(i.price_cents)}</span></div>`).join('')}
     <div class="line total"><span>Skupaj</span><span>${eur(b.total_cents)}</span></div></div>
    <div class="rc-actions"><a class="btn ghost" href="/r/${b.token}/ics">${icon('calendar-plus', 16)} Dodaj v koledar</a>
     ${p.phone ? `<a class="btn ghost" href="tel:${esc(p.phone.replace(/\s/g, ''))}">${icon('phone', 16)} Pokliči salon</a>` : ''}
     <a class="btn ghost" href="/b/${esc(p.slug)}">${icon('rotate-ccw', 16)} Nova rezervacija</a></div>
    ${canCancel ? `<form class="rc-cancel" method="post" action="/r/${b.token}/cancel" onsubmit="return confirm('Res želite odpovedati termin?')"><span class="muted small">Brezplačna odpoved do ${p.cancel_hours} ur pred terminom.</span><button class="link danger">Odpovej termin</button></form>`
      : b.status === 'confirmed' && b.start > now ? `<p class="rc-cancel muted small">Spletna odpoved ni več mogoča. Za spremembe pokličite ${esc(p.phone)}.</p>` : ''}
   </div></div>`);
}
app.get('/r/:token', (req, res) => {
  const b = q.get('SELECT * FROM bookings WHERE token=?', req.params.token);
  if (!b) return res.status(404).send(page('Ni najdeno', `${topbar(req.user)}<div class="empty big"><h2>Rezervacija ne obstaja</h2></div>`));
  const p = q.get('SELECT * FROM providers WHERE id=?', b.provider_id);
  res.send(bookingView(b, p, q.all('SELECT * FROM booking_items WHERE booking_id=? ORDER BY start', b.id), req.user, res.locals.flash));
});
app.get('/r/:token/ics', (req, res) => {
  const b = q.get('SELECT * FROM bookings WHERE token=?', req.params.token);
  if (!b) return res.sendStatus(404);
  const p = q.get('SELECT * FROM providers WHERE id=?', b.provider_id);
  const f = s => s.replace(/[-: ]/g, '').slice(0, 8) + 'T' + s.slice(11).replace(':', '') + '00';
  res.type('text/calendar').attachment('termin.ics').send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//terminko//SL', 'BEGIN:VEVENT', `UID:${b.token}@terminko`,
    `DTSTART;TZID=Europe/Ljubljana:${f(b.start)}`, `DTEND;TZID=Europe/Ljubljana:${f(b.end)}`, `SUMMARY:${p.business_name}`, `LOCATION:${p.address}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
});
app.post('/r/:token/cancel', async (req, res) => {
  const b = q.get('SELECT * FROM bookings WHERE token=?', req.params.token);
  if (!b) return res.sendStatus(404);
  const p = q.get('SELECT * FROM providers WHERE id=?', b.provider_id);
  if (b.status !== 'confirmed' || A.addMinutes(A.nowLocal(), p.cancel_hours * 60) > b.start) { flash(req, 'Termina ni več mogoče odpovedati prek spleta.'); return res.redirect('/r/' + b.token); }
  q.run("UPDATE bookings SET status='cancelled' WHERE id=?", b.id);
  await N.bookingCancelled(b, p, true);
  flash(req, 'Termin je odpovedan. Prejeli boste potrditev.');
  res.redirect('/r/' + b.token);
});

// ---------- Nadzorna plošča naročnice ----------
const D = express.Router();
D.use(requireRole('provider', 'admin'), withProvider);

D.get('/', (req, res) => {
  const p = req.provider, now = A.nowLocal(), today = now.slice(0, 10);
  const todays = q.all("SELECT * FROM bookings WHERE provider_id=? AND status='confirmed' AND substr(start,1,10)=? ORDER BY start", p.id, today);
  const upcoming = q.get("SELECT COUNT(*) c, COALESCE(SUM(total_cents),0) s FROM bookings WHERE provider_id=? AND status='confirmed' AND start>=?", p.id, now);
  const week = q.get("SELECT COUNT(*) c FROM bookings WHERE provider_id=? AND created_at>=datetime('now','-7 days')", p.id);
  const next = q.all("SELECT * FROM bookings WHERE provider_id=? AND status='confirmed' AND start>=? AND substr(start,1,10)>? ORDER BY start LIMIT 6", p.id, now, today);
  const link = `${req.protocol}://${req.get('host')}/b/${p.slug}`;
  const stat = (ic, label, val, sub = '') => `<div class="card stat"><span class="stat-ic">${icon(ic, 18)}</span><div><div class="muted small">${label}</div><b class="num">${val}</b>${sub ? `<div class="muted small">${sub}</div>` : ''}</div></div>`;
  dash(req, res, 'Pregled', `
  <div class="card linkbox"><span class="stat-ic accent">${icon('link', 18)}</span><div class="grow"><div class="muted small">Vaša povezava za naročanje. Delite jo na Instagramu, Facebooku ali Google profilu.</div><b id="lnk">${esc(link)}</b></div>
   <button class="btn sm" onclick="navigator.clipboard.writeText(document.getElementById('lnk').textContent);this.innerHTML='Kopirano'">${icon('copy', 15)} Kopiraj</button></div>
  <div class="stats">${stat('calendar-days', 'Danes', todays.length, 'terminov')}${stat('calendar-clock', 'Prihajajoči', upcoming.c, 'potrjenih terminov')}${stat('wallet', 'Pričakovan promet', eur(upcoming.s), 'iz prihajajočih terminov')}${stat('trending-up', 'Novih rezervacij', week.c, 'zadnjih 7 dni')}</div>
  <div class="grid-2-1"><div><div class="sec-h"><h2>Danes, ${V.fmtDate(today)}</h2><a class="link" href="/dash/calendar">Odpri koledar</a></div>${bookingTable(todays, true)}</div>
   <div><div class="sec-h"><h2>Naslednji termini</h2></div><div class="card list">${next.length ? next.map(b => `<div class="li"><div class="date-chip sm"><small>${V.DAYS_S[A.weekday(b.start.slice(0, 10))]}</small><b>${Number(b.start.slice(8, 10))}</b></div><div class="grow"><b>${esc(b.customer_name)}</b><div class="muted small">${b.start.slice(11)} · ${esc(itemNames(b.id))}</div></div></div>`).join('') : '<div class="li muted">Ni prihajajočih terminov.</div>'}</div></div></div>`, '/dash',
  `<a class="btn ghost sm" href="/b/${esc(p.slug)}" target="_blank">${icon('external-link', 15)} Odpri mojo stran</a><a class="btn sm" href="/b/${esc(p.slug)}" target="_blank">${icon('plus', 15)} Nova rezervacija</a>`);
});

const itemNames = id => q.all('SELECT name FROM booking_items WHERE booking_id=? ORDER BY start', id).map(i => i.name).join(', ');
function bookingTable(bs, compact) {
  if (!bs.length) return `<div class="card empty">${icon('calendar-x-2', 26)}<p>Ni terminov.</p></div>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Termin</th><th>Stranka</th><th>Storitve</th><th class="r">Znesek</th><th>Status</th><th></th></tr></thead><tbody>${bs.map(b => `<tr class="${b.status === 'cancelled' ? 'dim' : ''}">
    <td class="nowrap">${compact ? '' : `<div class="muted small">${V.DAYS_S[A.weekday(b.start.slice(0, 10))]}, ${V.fmtDate(b.start)}</div>`}<b>${b.start.slice(11)}</b> – ${b.end.slice(11)}</td>
    <td><div class="who"><span class="avatar sm">${esc(b.customer_name.trim()[0] || '?')}</span><div><b>${esc(b.customer_name)}</b><div class="muted small">${esc(b.customer_phone || b.customer_email || '')}</div></div></div></td>
    <td>${esc(itemNames(b.id))}${b.note ? `<div class="muted small">${icon('message-square', 12)} ${esc(b.note)}</div>` : ''}</td>
    <td class="r nowrap">${eur(b.total_cents)}</td><td><span class="pill ${b.status === 'cancelled' ? 'red' : 'green'}">${b.status === 'cancelled' ? 'Odpovedano' : 'Potrjeno'}</span></td>
    <td class="r">${b.status === 'confirmed' ? `<form method="post" action="/dash/bookings/${b.id}/cancel" onsubmit="return confirm('Odpovem termin? Stranka bo obveščena.')"><button class="link danger small">Odpovej</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

D.get('/bookings', (req, res) => {
  const show = req.query.show === 'past' ? 'past' : 'up';
  const now = A.nowLocal();
  const bs = q.all(`SELECT * FROM bookings WHERE provider_id=? AND start ${show === 'past' ? '<' : '>='} ? ORDER BY start ${show === 'past' ? 'DESC' : 'ASC'} LIMIT 300`, req.provider.id, now);
  dash(req, res, 'Rezervacije', `<div class="tabs"><a class="${show === 'up' ? 'on' : ''}" href="?show=up">Prihajajoče</a><a class="${show === 'past' ? 'on' : ''}" href="?show=past">Pretekle</a>
   </div>${bookingTable(bs)}`, '/dash/bookings', `<a class="btn sm" href="/b/${esc(req.provider.slug)}" target="_blank">${icon('plus', 15)} Nova rezervacija</a>`);
});
D.post('/bookings/:id/cancel', async (req, res) => {
  const b = q.get('SELECT * FROM bookings WHERE id=? AND provider_id=?', req.params.id, req.provider.id);
  if (b && b.status === 'confirmed') { q.run("UPDATE bookings SET status='cancelled' WHERE id=?", b.id); await N.bookingCancelled(b, req.provider, false); flash(req, 'Termin odpovedan, stranka obveščena.'); }
  res.redirect(req.get('referer') || '/dash/bookings');
});

// Tedenski koledar
D.get('/calendar', (req, res) => {
  const p = req.provider;
  let start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.w) ? req.query.w : A.nowLocal().slice(0, 10);
  start = A.addDays(start, 1 - A.weekday(start));
  const days = [...Array(7)].map((_, i) => A.addDays(start, i));
  const H0 = 7 * 60, H1 = 21 * 60, PX = 1.1; // px na minuto
  const y = m => (Math.max(H0, Math.min(H1, m)) - H0) * PX;
  const cols = days.map(d => {
    const ranges = A.workingRanges(p.id, d);
    const bs = q.all("SELECT * FROM bookings WHERE provider_id=? AND status='confirmed' AND substr(start,1,10)=? ORDER BY start", p.id, d);
    const blocks = q.all('SELECT * FROM blocks WHERE provider_id=? AND substr(start,1,10)<=? AND substr(end,1,10)>=?', p.id, d, d);
    let html = ranges.map(([s, e]) => `<div class="open" style="top:${y(s)}px;height:${y(e) - y(s)}px"></div>`).join('');
    for (const bl of blocks) { const s = bl.start.slice(0, 10) < d ? 0 : A.toMin(bl.start.slice(11)), e = bl.end.slice(0, 10) > d ? 1440 : A.toMin(bl.end.slice(11)); html += `<div class="ev block" style="top:${y(s)}px;height:${y(e) - y(s)}px">${esc(bl.note || 'Odsotnost')}</div>`; }
    for (const b of bs) {
      const items = q.all('SELECT * FROM booking_items WHERE booking_id=? ORDER BY start', b.id);
      const inGap = q.get(`SELECT 1 FROM booking_items bi JOIN bookings o ON o.id=bi.booking_id WHERE o.provider_id=? AND o.status='confirmed' AND o.id<>? AND bi.gap_start<=? AND bi.gap_end>=?`, p.id, b.id, b.start, b.end);
      for (const it of items) {
        const s = A.toMin(it.start.slice(11)), e = A.toMin(it.end.slice(11));
        const gs = it.gap_start ? A.toMin(it.gap_start.slice(11)) : e, ge = it.gap_start ? A.toMin(it.gap_end.slice(11)) : e;
        const label = `<b>${it.start.slice(11)} ${esc(b.customer_name)}</b><span>${esc(it.name)}</span>`;
        html += `<div class="ev ${inGap ? 'par' : ''}" style="top:${y(s)}px;height:${y(gs) - y(s) - 2}px" title="${esc(b.customer_name)} · ${esc(it.name)}">${label}</div>`;
        if (it.gap_start) {
          html += `<div class="ev" style="top:${y(ge)}px;height:${y(e) - y(ge) - 2}px" title="${esc(b.customer_name)} · ${esc(it.name)}"><b>${it.gap_end.slice(11)} ${esc(b.customer_name)}</b><span>${esc(it.name)} (nadaljevanje)</span></div>`;
          const allowed = A.parseJSON(it.gap_allowed, []).map(id => q.get('SELECT name FROM services WHERE id=?', id)?.name).filter(Boolean);
          const filled = q.get(`SELECT 1 FROM booking_items bi JOIN bookings o ON o.id=bi.booking_id WHERE o.provider_id=? AND o.status='confirmed' AND bi.start>=? AND bi.end<=? AND o.id<>?`, p.id, it.gap_start, it.gap_end, b.id);
          html += `<div class="ev gap" style="top:${y(gs)}px;height:${y(ge) - y(gs) - 2}px"><span>⏳ čakanje${filled ? '' : ` · prosto za ${esc(allowed.join(', ') || 'drugo storitev')}`}</span></div>`;
        }
      }
    }
    return `<div class="col"><div class="col-h ${d === A.nowLocal().slice(0, 10) ? 'today' : ''}">${V.DAYS_S[A.weekday(d)]} <b>${Number(d.slice(8))}.${Number(d.slice(5, 7))}.</b></div><div class="col-b" style="height:${(H1 - H0) * PX}px">${html}</div></div>`;
  }).join('');
  const hours = [...Array((H1 - H0) / 60)].map((_, i) => `<div style="height:${60 * PX}px">${String(7 + i).padStart(2, '0')}:00</div>`).join('');
  dash(req, res, 'Koledar', `<div class="tabs"><a href="?w=${A.addDays(start, -7)}">‹ Prejšnji teden</a><a href="?">Danes</a><a href="?w=${A.addDays(start, 7)}">Naslednji teden ›</a>
    <span class="muted" style="margin-left:auto">${V.fmtDate(days[0])} – ${V.fmtDate(days[6])}</span></div>
   <div class="legend"><span class="lgd ev-l"></span>termin <span class="lgd gap-l"></span>čakanje (barva deluje) – prosto za vzporedno storitev <span class="lgd par-l"></span>termin med čakanjem <span class="lgd block-l"></span>odsotnost</div>
   <div class="week"><div class="hrs"><div class="col-h"></div>${hours}</div>${cols}</div>
   <details class="card pad" style="margin-top:16px"><summary><b>+ Dodaj odsotnost / blokiran čas</b></summary>
    <form method="post" action="/dash/blocks" class="inline-form"><label>Od<input type="datetime-local" name="start" required></label><label>Do<input type="datetime-local" name="end" required></label><label>Opomba<input name="note" placeholder="npr. dopust, malica"></label><button class="btn sm">Shrani</button></form>
    ${q.all('SELECT * FROM blocks WHERE provider_id=? AND end>=? ORDER BY start', p.id, A.nowLocal()).map(b => `<div class="line"><span>${esc(b.start)} – ${esc(b.end)} ${esc(b.note)}</span><form method="post" action="/dash/blocks/${b.id}/delete"><button class="link danger">Odstrani</button></form></div>`).join('')}
   </details>`, '/dash/calendar');
});
D.post('/blocks', (req, res) => {
  const s = String(req.body.start || '').replace('T', ' ').slice(0, 16), e = String(req.body.end || '').replace('T', ' ').slice(0, 16);
  if (s.length === 16 && e > s) q.run('INSERT INTO blocks (provider_id,start,end,note) VALUES (?,?,?,?)', req.provider.id, s, e, req.body.note || '');
  res.redirect('/dash/calendar?w=' + s.slice(0, 10));
});
D.post('/blocks/:id/delete', (req, res) => { q.run('DELETE FROM blocks WHERE id=? AND provider_id=?', req.params.id, req.provider.id); res.redirect('/dash/calendar'); });

// Storitve
D.get('/services', (req, res) => {
  const p = req.provider;
  const svcs = q.all('SELECT * FROM services WHERE provider_id=? ORDER BY sort, category, name', p.id);
  const edit = req.query.edit ? q.get('SELECT * FROM services WHERE id=? AND provider_id=?', req.query.edit, p.id) : null;
  const s = edit || { name: '', category: '', description: '', duration_min: 30, price_cents: 0, processing_offset: 0, processing_min: 0, gap_allowed: '[]', active: 1, sort: 0 };
  const allowed = A.parseJSON(s.gap_allowed, []);
  dash(req, res, 'Storitve', `
  <div class="tabs"><a class="on" href="/dash/services">Seznam</a><a href="/dash/services/bulk">Množični vnos</a></div>
  <table class="tbl"><tr><th style="width:56px"></th><th>Storitev</th><th>Kategorija</th><th>Trajanje</th><th>Cena</th><th>Vzporedno</th><th></th></tr>${svcs.map(x => `<tr class="${x.active ? '' : 'dim'}">
   <td>${thumb(x.image, x.name, 'thumb sm', x.category)}</td><td><b>${esc(x.name)}</b>${x.active ? '' : ' <span class="pill grey">skrito</span>'}</td><td>${esc(x.category)}</td><td>${dur(x.duration_min)}</td><td>${eur(x.price_cents)}</td>
   <td class="small">${x.processing_min ? `⏳ ${x.processing_min} min čakanja po ${x.processing_offset} min` : ''}</td><td><a class="btn ghost sm" href="?edit=${x.id}#form">Uredi</a></td></tr>`).join('')}</table>
  ${req.query.edit ? `<form id="form" class="card pad form two" method="post" action="/dash/services/save" enctype="multipart/form-data">
   <h2 class="full">${edit ? 'Uredi storitev' : 'Nova storitev'}</h2><input type="hidden" name="id" value="${edit ? edit.id : ''}">
   <label>Ime *<input name="name" value="${esc(s.name)}" required></label><label>Kategorija<input name="category" value="${esc(s.category)}" list="cats" placeholder="npr. Lasje"></label>
   <datalist id="cats">${[...new Set(svcs.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
   <label>Trajanje (min) *<input name="duration_min" type="number" min="5" step="5" value="${s.duration_min}" required></label><label>Cena (€) *<input name="price" value="${(s.price_cents / 100).toFixed(2).replace('.', ',')}" required></label>
   <label class="full">Opis<textarea name="description" rows="2">${esc(s.description)}</textarea></label>
   <label>Slika<input type="file" name="image" accept="image/*"></label><label>Vrstni red<input name="sort" type="number" value="${s.sort}"></label>
   <fieldset class="full par-box"><legend>⏳ Čakalni čas in vzporedna storitev</legend>
    <p class="muted small">Npr. barvanje 120 min: po 30 min nanosa barva deluje 40 min. V tem času je izvajalka prosta, zato aplikacija strankam samodejno ponudi termin za izbrane storitve (npr. striženje) v sredini tega termina.</p>
    <label>Čakanje se začne po (min)<input name="processing_offset" type="number" min="0" step="5" value="${s.processing_offset}"></label>
    <label>Čakanje traja (min)<input name="processing_min" type="number" min="0" step="5" value="${s.processing_min}"></label>
    <div class="full"><div class="small"><b>Med čakanjem lahko delam (prazno = katerokoli, ki se prilega):</b></div><div class="chips">${svcs.filter(x => x.id !== edit?.id).map(x => `<label class="chip"><input type="checkbox" name="gap_allowed" value="${x.id}" ${allowed.includes(x.id) ? 'checked' : ''}>${esc(x.name)} (${x.duration_min} min)</label>`).join('')}</div></div>
   </fieldset>
   <label class="chk full"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Prikazano na strani za naročanje</label>
   <div class="full row"><button class="btn">Shrani</button><a class="btn ghost" href="/dash/services">Prekliči</a>
   ${edit ? `<button class="btn danger" formaction="/dash/services/${edit.id}/delete" onclick="return confirm('Izbrišem storitev?')" style="margin-left:auto">Izbriši</button>` : ''}</div></form>` : ''}`, '/dash/services', `<a class="btn ghost sm" href="/dash/services/bulk">${icon('table-2', 15)} Množični vnos</a><a class="btn sm" href="/dash/services?edit=new#form">${icon('plus', 15)} Nova storitev</a>`);
});
D.post('/services/save', upload.single('image'), (req, res) => {
  const p = req.provider, b = req.body;
  const allowed = JSON.stringify([].concat(b.gap_allowed || []).map(Number).filter(Boolean));
  const vals = [b.category || '', b.name, b.description || '', Number(b.duration_min) || 30, toCents(b.price), Number(b.processing_offset) || 0, Number(b.processing_min) || 0, allowed, b.active ? 1 : 0, Number(b.sort) || 0];
  if (!String(b.name || '').trim()) { flash(req, 'Ime je obvezno.'); return res.redirect('/dash/services'); }
  let id = Number(b.id);
  if (id && q.get('SELECT 1 FROM services WHERE id=? AND provider_id=?', id, p.id)) q.run('UPDATE services SET category=?,name=?,description=?,duration_min=?,price_cents=?,processing_offset=?,processing_min=?,gap_allowed=?,active=?,sort=? WHERE id=?', ...vals, id);
  else id = Number(q.run('INSERT INTO services (category,name,description,duration_min,price_cents,processing_offset,processing_min,gap_allowed,active,sort,provider_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)', ...vals, p.id).lastInsertRowid);
  if (req.file) q.run('UPDATE services SET image=? WHERE id=?', '/uploads/' + req.file.filename, id);
  flash(req, 'Storitev shranjena.'); res.redirect('/dash/services');
});
D.post('/services/:id/delete', (req, res) => { q.run('DELETE FROM services WHERE id=? AND provider_id=?', req.params.id, req.provider.id); flash(req, 'Storitev izbrisana.'); res.redirect('/dash/services'); });

function parseBulk(text) {
  const rows = [], errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const c = line.split(line.includes('\t') ? '\t' : ';').map(x => x.trim());
    if (/^kategorija$/i.test(c[0])) return;
    const [category, name, minutes, price, description = ''] = c;
    if (!name || !Number(minutes)) { errors.push(`Vrstica ${i + 1}: manjka ime ali trajanje`); return; }
    rows.push({ category, name, duration_min: Number(minutes), price_cents: toCents(price), description });
  });
  return { rows, errors };
}
D.get('/services/bulk', (req, res) => dash(req, res, 'Množični vnos storitev', `
  <div class="tabs"><a href="/dash/services">Seznam</a><a class="on" href="/dash/services/bulk">Množični vnos</a></div>
  <form class="card pad form" method="post"><p>Prilepite tabelo iz Excela/Google Sheets ali vpišite vsako storitev v svojo vrstico, stolpci ločeni s podpičjem:</p>
  <code class="block">Kategorija; Ime; Trajanje (min); Cena (€); Opis</code>
  <textarea name="text" rows="10" placeholder="Lasje; Žensko striženje; 45; 28; Pranje, striženje in feniranje&#10;Lasje; Moško striženje; 30; 18&#10;Nohti; Gel lak; 60; 32,50">${esc(req.body?.text || '')}</textarea>
  <div class="row"><button class="btn ghost" name="mode" value="preview">Predogled</button><button class="btn" name="mode" value="save">Uvozi</button></div></form>`, '/dash/services'));
D.post('/services/bulk', (req, res) => {
  const { rows, errors } = parseBulk(req.body.text);
  if (req.body.mode === 'save' && rows.length && !errors.length) {
    const ins = db.prepare('INSERT INTO services (provider_id,category,name,duration_min,price_cents,description) VALUES (?,?,?,?,?,?)');
    db.exec('BEGIN'); rows.forEach(r => ins.run(req.provider.id, r.category || '', r.name, r.duration_min, r.price_cents, r.description)); db.exec('COMMIT');
    flash(req, `Uvoženih ${rows.length} storitev. Slike in čakalne čase lahko dodate pri posamezni storitvi.`); return res.redirect('/dash/services');
  }
  dash(req, res, 'Množični vnos storitev', `<div class="tabs"><a href="/dash/services">Seznam</a><a class="on" href="/dash/services/bulk">Množični vnos</a></div>
   ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
   <h2>Predogled (${rows.length})</h2><table class="tbl"><tr><th>Kategorija</th><th>Ime</th><th>Trajanje</th><th>Cena</th><th>Opis</th></tr>${rows.map(r => `<tr><td>${esc(r.category)}</td><td>${esc(r.name)}</td><td>${dur(r.duration_min)}</td><td>${eur(r.price_cents)}</td><td>${esc(r.description)}</td></tr>`).join('')}</table>
   <form class="form" method="post"><textarea name="text" rows="8">${esc(req.body.text)}</textarea><div class="row"><button class="btn ghost" name="mode" value="preview">Osveži predogled</button><button class="btn" name="mode" value="save" ${errors.length || !rows.length ? 'disabled' : ''}>Uvozi ${rows.length} storitev</button></div></form>`, '/dash/services');
});

// Delovni čas + koledar izjem
D.get('/hours', (req, res) => {
  const p = req.provider;
  const wh = q.all('SELECT * FROM weekly_hours WHERE provider_id=? ORDER BY weekday,start', p.id);
  const today = A.nowLocal().slice(0, 10);
  const m = /^\d{4}-\d{2}$/.test(req.query.m) ? req.query.m : today.slice(0, 7);
  const first = m + '-01', startCell = A.addDays(first, 1 - A.weekday(first));
  const ovs = Object.fromEntries(q.all('SELECT * FROM date_overrides WHERE provider_id=? AND date LIKE ?', p.id, m + '%').map(o => [o.date, o]));
  const sel = /^\d{4}-\d{2}-\d{2}$/.test(req.query.d) ? req.query.d : null;
  const nextM = A.addDays(first, 32).slice(0, 7), prevM = A.addDays(first, -1).slice(0, 7);
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = A.addDays(startCell, i); if (i >= 35 && d.slice(0, 7) !== m) break;
    const r = A.workingRanges(p.id, d), o = ovs[d];
    cells += `<a href="?m=${m}&d=${d}#edit" class="mc ${d.slice(0, 7) !== m ? 'out' : ''} ${d === today ? 'today' : ''} ${o ? 'ov' : ''} ${r.length ? '' : 'closed'} ${sel === d ? 'sel' : ''}">
     <b>${Number(d.slice(8))}</b><span>${r.length ? r.map(([a, b]) => A.fromMin(a) + '–' + A.fromMin(b)).join('<br>') : 'zaprto'}</span>${o?.note ? `<i>${esc(o.note)}</i>` : ''}</a>`;
  }
  const selRanges = sel ? A.workingRanges(p.id, sel) : [];
  dash(req, res, 'Delovni čas', `
  <div class="cols2">
   <form class="card pad form" method="post" action="/dash/hours"><h2>Tedenski urnik</h2><p class="muted small">Več intervalov na dan ločite z vejico, npr. <code>08:00-12:00, 13:00-19:00</code>. Prazno = zaprto.</p>
    ${[1, 2, 3, 4, 5, 6, 7].map(d => `<label class="hrow"><span>${V.DAYS[d]}</span><input name="d${d}" value="${wh.filter(x => x.weekday === d).map(x => x.start + '-' + x.end).join(', ')}" placeholder="zaprto"></label>`).join('')}
    <button class="btn">Shrani urnik</button></form>
   <div class="card pad"><h2>Koledar razpoložljivosti</h2><p class="muted small">Kliknite dan, da ga zaprete (dopust, praznik) ali nastavite drugačen urnik samo za ta dan.</p>
    <div class="tabs"><a href="?m=${prevM}">‹</a><b>${V.MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</b><a href="?m=${nextM}">›</a></div>
    <div class="month">${V.DAYS_S.slice(1).map(x => `<div class="mh">${x}</div>`).join('')}${cells}</div>
    ${sel ? `<form id="edit" class="form ovform" method="post" action="/dash/overrides"><h3>${V.DAYS[A.weekday(sel)]}, ${V.fmtDate(sel)}</h3><input type="hidden" name="date" value="${sel}">
     <label class="chk"><input type="checkbox" name="closed" ${selRanges.length ? '' : 'checked'}> Zaprto ta dan</label>
     <label>Ure ta dan<input name="ranges" value="${selRanges.map(([a, b]) => A.fromMin(a) + '-' + A.fromMin(b)).join(', ')}"></label>
     <label>Opomba<input name="note" value="${esc(ovs[sel]?.note || '')}" placeholder="npr. dopust"></label>
     <label>Ponovi za naslednjih dni<input name="repeat" type="number" min="0" max="60" value="0"></label>
     <div class="row"><button class="btn sm">Shrani</button>${ovs[sel] ? `<button class="btn sm ghost" name="reset" value="1">Povrni na tedenski urnik</button>` : ''}</div></form>` : ''}
   </div></div>`, '/dash/hours');
});
function parseRanges(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(/[-–]/).map(t => t.trim()))
    .filter(([a, b]) => /^\d{1,2}:\d{2}$/.test(a) && /^\d{1,2}:\d{2}$/.test(b)).map(([a, b]) => ({ start: a.padStart(5, '0'), end: b.padStart(5, '0') })).filter(r => r.end > r.start);
}
D.post('/hours', (req, res) => {
  const p = req.provider;
  db.exec('BEGIN'); q.run('DELETE FROM weekly_hours WHERE provider_id=?', p.id);
  for (let d = 1; d <= 7; d++) for (const r of parseRanges(req.body['d' + d])) q.run('INSERT INTO weekly_hours (provider_id,weekday,start,end) VALUES (?,?,?,?)', p.id, d, r.start, r.end);
  db.exec('COMMIT'); flash(req, 'Urnik shranjen.'); res.redirect('/dash/hours');
});
D.post('/overrides', (req, res) => {
  const p = req.provider, date = req.body.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect('/dash/hours');
  const n = Math.min(Number(req.body.repeat) || 0, 60);
  for (let i = 0; i <= n; i++) {
    const d = A.addDays(date, i);
    if (req.body.reset) q.run('DELETE FROM date_overrides WHERE provider_id=? AND date=?', p.id, d);
    else q.run('INSERT INTO date_overrides (provider_id,date,closed,ranges,note) VALUES (?,?,?,?,?) ON CONFLICT(provider_id,date) DO UPDATE SET closed=excluded.closed, ranges=excluded.ranges, note=excluded.note',
      p.id, d, req.body.closed ? 1 : 0, JSON.stringify(parseRanges(req.body.ranges)), req.body.note || '');
  }
  flash(req, 'Shranjeno.'); res.redirect(`/dash/hours?m=${date.slice(0, 7)}&d=${date}`);
});

// Nastavitve
D.get('/settings', (req, res) => {
  const p = req.provider;
  dash(req, res, 'Profil in nastavitve', `<form class="card pad form two" method="post" enctype="multipart/form-data">
   <label>Ime salona<input name="business_name" value="${esc(p.business_name)}" required></label>
   <label>Povezava<div class="prefix"><span>/b/</span><input name="slug" value="${esc(p.slug)}" pattern="[a-z0-9-]+" required></div></label>
   <label>Naslov<input name="address" value="${esc(p.address)}"></label><label>Telefon (za SMS o novih rezervacijah)<input name="phone" value="${esc(p.phone)}"></label>
   <label class="full">Opis<textarea name="description" rows="3">${esc(p.description)}</textarea></label>
   <label>Naslovna slika<input type="file" name="cover" accept="image/*"></label><label>Barva poudarka<input type="color" name="accent" value="${esc(p.accent)}"></label>
   <h3 class="full">Pravila naročanja</h3>
   <label>Korak terminov (min)<select name="slot_step">${[10, 15, 20, 30, 60].map(v => `<option ${p.slot_step === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
   <label>Odmor med strankami (min)<input type="number" name="buffer_min" min="0" value="${p.buffer_min}"></label>
   <label>Najmanj ur vnaprej<input type="number" name="min_notice_hours" min="0" value="${p.min_notice_hours}"></label>
   <label>Največ dni vnaprej<input type="number" name="max_days_ahead" min="1" value="${p.max_days_ahead}"></label>
   <label>Spletna odpoved do (ur pred terminom)<input type="number" name="cancel_hours" min="0" value="${p.cancel_hours}"></label>
   <div class="full"><button class="btn">Shrani</button></div></form>`, '/dash/settings');
});
D.post('/settings', upload.single('cover'), (req, res) => {
  const p = req.provider, b = req.body, slug = slugify(b.slug) || p.slug;
  if (q.get('SELECT 1 FROM providers WHERE slug=? AND id<>?', slug, p.id)) { flash(req, 'Ta povezava je že zasedena.'); return res.redirect('/dash/settings'); }
  q.run('UPDATE providers SET business_name=?,slug=?,address=?,phone=?,description=?,accent=?,slot_step=?,buffer_min=?,min_notice_hours=?,max_days_ahead=?,cancel_hours=? WHERE id=?',
    b.business_name, slug, b.address || '', b.phone || '', b.description || '', /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : p.accent,
    Number(b.slot_step) || 15, Number(b.buffer_min) || 0, Number(b.min_notice_hours) || 0, Number(b.max_days_ahead) || 60, Number(b.cancel_hours) || 0, p.id);
  if (req.file) q.run('UPDATE providers SET cover_image=? WHERE id=?', '/uploads/' + req.file.filename, p.id);
  flash(req, 'Shranjeno.'); res.redirect('/dash/settings');
});
app.use('/dash', D);

// ---------- Admin ----------
const AD = express.Router();
AD.use(requireRole('admin'));
const adm = (req, res, title, body, active, actions = '') => {
  const provider = req.session.actingProvider ? q.get('SELECT * FROM providers WHERE id=?', req.session.actingProvider) : null;
  res.send(dashLayout(title, body, { user: req.user, provider, active, flash: res.locals.flash, actions }));
};
AD.get('/', (req, res) => {
  const now = A.nowLocal(), month = now.slice(0, 7);
  const ps = q.all(`SELECT p.*, u.email AS login, (SELECT COUNT(*) FROM bookings b WHERE b.provider_id=p.id AND b.status='confirmed' AND b.start>=?) AS upcoming,
    (SELECT COALESCE(SUM(total_cents),0) FROM bookings b WHERE b.provider_id=p.id AND b.status='confirmed' AND substr(b.start,1,7)=?) AS month,
    (SELECT COUNT(*) FROM services s WHERE s.provider_id=p.id) AS nsvc FROM providers p LEFT JOIN users u ON u.id=p.user_id ORDER BY p.business_name`, now, month);
  const tot = q.get(`SELECT COUNT(*) c, COALESCE(SUM(total_cents),0) s FROM bookings WHERE status='confirmed' AND substr(start,1,7)=?`, month);
  const sms = q.get(`SELECT COUNT(*) c FROM notifications WHERE channel='sms' AND substr(created_at,1,7)=?`, month);
  const stat = (ic, label, val) => `<div class="card stat"><span class="stat-ic">${icon(ic, 18)}</span><div><div class="muted small">${label}</div><b class="num">${val}</b></div></div>`;
  adm(req, res, 'Naročnice', `<div class="stats">${stat('building-2', 'Aktivne naročnice', ps.filter(p => p.active).length)}${stat('calendar-check', 'Termini ta mesec', tot.c)}${stat('wallet', 'Promet ta mesec', eur(tot.s))}${stat('message-square', 'SMS ta mesec', sms.c)}</div>
   <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Salon</th><th>Prijava</th><th class="r">Storitve</th><th class="r">Prihajajoči</th><th class="r">Promet ta mesec</th><th>Status</th><th></th></tr></thead><tbody>
   ${ps.map(p => `<tr class="${p.active ? '' : 'dim'}"><td><div class="who"><span class="mono sm" style="--accent:${esc(p.accent)}">${esc(p.business_name.trim()[0])}</span><div><b>${esc(p.business_name)}</b><div class="small"><a class="muted" href="/b/${esc(p.slug)}" target="_blank">/b/${esc(p.slug)} ${icon('external-link', 12)}</a></div></div></div></td>
   <td class="muted">${esc(p.login || '–')}</td><td class="r">${p.nsvc}</td><td class="r">${p.upcoming}</td><td class="r">${eur(p.month)}</td>
   <td><form method="post" action="/admin/providers/${p.id}/toggle"><button class="pill-btn" title="Klikni za preklop">${p.active ? '<span class="pill green">Aktivna</span>' : '<span class="pill grey">Neaktivna</span>'}</button></form></td>
   <td class="r"><a class="btn ghost sm" href="/admin/act/${p.id}">Upravljaj ${icon('arrow-right', 14)}</a></td></tr>`).join('')}</tbody></table></div>
   <details class="card pad" id="new" ${ps.length ? '' : 'open'}><summary><b>${icon('plus', 16)} Dodaj novo naročnico</b></summary>
   <form class="form two" method="post" action="/admin/providers" style="margin-top:16px">
    <label>Ime salona<input name="business_name" required></label><label>Povezava <span class="opt">prazno = iz imena</span><input name="slug" pattern="[a-z0-9-]*"></label>
    <label>E-pošta za prijavo<input name="email" type="email" required></label><label>Začetno geslo<input name="password" minlength="8" required></label>
    <label>Telefon za SMS<input name="phone"></label><label>Naslov<input name="address"></label>
    <div class="full row"><label class="chk"><input type="checkbox" name="default_hours" checked> Nastavi privzet urnik pon–pet 9–17</label><button class="btn" style="margin-left:auto">Ustvari naročnico</button></div></form></details>`, '/admin',
   `<a class="btn sm" href="#new" onclick="document.getElementById('new').open=true">${icon('plus', 15)} Nova naročnica</a>`);
});
AD.post('/providers', (req, res) => {
  const b = req.body, email = String(b.email).trim().toLowerCase();
  let slug = slugify(b.slug || b.business_name) || 'salon';
  if (q.get('SELECT 1 FROM users WHERE email=?', email)) { flash(req, 'Uporabnik s to e-pošto že obstaja.'); return res.redirect('/admin'); }
  while (q.get('SELECT 1 FROM providers WHERE slug=?', slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
  db.exec('BEGIN');
  const u = q.run('INSERT INTO users (email,password_hash,role,name,phone) VALUES (?,?,?,?,?)', email, hash(b.password), 'provider', b.business_name, b.phone || '');
  const p = q.run('INSERT INTO providers (user_id,slug,business_name,phone,address,email) VALUES (?,?,?,?,?,?)', u.lastInsertRowid, slug, b.business_name, b.phone || '', b.address || '', email);
  if (b.default_hours) for (let d = 1; d <= 5; d++) q.run('INSERT INTO weekly_hours (provider_id,weekday,start,end) VALUES (?,?,?,?)', p.lastInsertRowid, d, '09:00', '17:00');
  db.exec('COMMIT');
  flash(req, `Naročnica ustvarjena. Povezava: /b/${slug}`); res.redirect('/admin');
});
AD.post('/providers/:id/toggle', (req, res) => { q.run('UPDATE providers SET active=1-active WHERE id=?', req.params.id); res.redirect('/admin'); });
AD.get('/act/:id', (req, res) => { if (q.get('SELECT 1 FROM providers WHERE id=?', req.params.id)) req.session.actingProvider = Number(req.params.id); res.redirect('/dash'); });
AD.get('/bookings', (req, res) => {
  const bs = q.all(`SELECT b.*, p.business_name FROM bookings b JOIN providers p ON p.id=b.provider_id ORDER BY b.created_at DESC LIMIT 300`);
  adm(req, res, 'Vse rezervacije', `<table class="tbl"><tr><th>Ustvarjeno</th><th>Salon</th><th>Termin</th><th>Stranka</th><th>Znesek</th><th>Status</th></tr>${bs.map(b => `<tr class="${b.status === 'cancelled' ? 'dim' : ''}">
   <td class="small">${esc(b.created_at)}</td><td>${esc(b.business_name)}</td><td>${V.fmtDate(b.start)} ${b.start.slice(11)}</td><td>${esc(b.customer_name)}<div class="muted small">${esc(b.customer_phone || '')} ${esc(b.customer_email || '')}</div></td><td>${eur(b.total_cents)}</td>
   <td><a href="/r/${b.token}"><span class="pill ${b.status === 'cancelled' ? 'red' : 'green'}">${b.status === 'cancelled' ? 'odpovedano' : 'potrjeno'}</span></a></td></tr>`).join('')}</table>`, '/admin/bookings');
});
AD.get('/notifications', (req, res) => {
  const ns = q.all('SELECT * FROM notifications ORDER BY id DESC LIMIT 200');
  adm(req, res, 'Obvestila (log)', `<p class="muted">Testni način: e-pošta in SMS se ne pošiljata zares, tu vidite, kaj bi bilo poslano.</p>
   <table class="tbl"><tr><th>Čas</th><th>Kanal</th><th>Prejemnik</th><th>Vsebina</th><th>Status</th></tr>${ns.map(n => `<tr><td class="small">${esc(n.created_at)}</td><td><span class="pill ${n.channel === 'sms' ? 'blue' : 'grey'}">${n.channel}</span></td><td>${esc(n.recipient)}</td>
   <td class="small pre">${n.subject ? `<b>${esc(n.subject)}</b>\n` : ''}${esc(n.body)}</td><td>${esc(n.status)}</td></tr>`).join('')}</table>`, '/admin/notifications');
});
AD.get('/users', (req, res) => {
  const us = q.all('SELECT id,email,role,name,phone,created_at FROM users ORDER BY role, email');
  adm(req, res, 'Uporabniki', `<table class="tbl"><tr><th>E-pošta</th><th>Ime</th><th>Vloga</th><th>Telefon</th><th>Ustvarjen</th><th>Novo geslo</th></tr>${us.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td>
   <td><span class="pill ${u.role === 'admin' ? 'blue' : u.role === 'provider' ? 'green' : 'grey'}">${{ admin: 'admin', provider: 'naročnica', customer: 'stranka' }[u.role]}</span></td><td>${esc(u.phone)}</td><td class="small">${esc(u.created_at)}</td>
   <td><form method="post" action="/admin/users/${u.id}/password" class="inline-form"><input name="password" minlength="8" placeholder="novo geslo" required><button class="btn sm ghost">Nastavi</button></form></td></tr>`).join('')}</table>`, '/admin/users');
});
AD.post('/users/:id/password', (req, res) => { q.run('UPDATE users SET password_hash=? WHERE id=?', hash(req.body.password), req.params.id); flash(req, 'Geslo spremenjeno.'); res.redirect('/admin/users'); });
app.use('/admin', AD);

// ---------- Opomniki (vsakih 5 min) ----------
async function sendReminders() {
  const now = A.nowLocal(), lim = A.addMinutes(now, 24 * 60);
  const bs = q.all("SELECT * FROM bookings WHERE status='confirmed' AND reminder_sent=0 AND start>? AND start<=?", now, lim);
  for (const b of bs) {
    if (A.addMinutes(b.created_at.replace('T', ' ').slice(0, 16), 0) > A.addMinutes(now, -120) && b.start < A.addMinutes(now, 6 * 60)) { /* sveža rezervacija za kmalu: brez opomnika */ }
    else await N.reminder(b, q.get('SELECT * FROM providers WHERE id=?', b.provider_id));
    q.run('UPDATE bookings SET reminder_sent=1 WHERE id=?', b.id);
  }
}
setInterval(() => sendReminders().catch(console.error), 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
if (require.main === module) app.listen(PORT, () => console.log(`Terminko teče na http://localhost:${PORT}`));
module.exports = app;
