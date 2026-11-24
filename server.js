const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { S, oid, sid, hash, verify, providerDefaults } = require('./store');
const A = require('./avail');
const N = require('./notify');
const V = require('./views');
const { esc, eur, dur, page, topbar, dashLayout, thumb, imgUrl, icon, cover } = V;

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Seja: v MongoDB (preživi ponovni zagon), brez baze v pomnilniku. Nastavi se v init().
let sessionMw = null;
app.use((req, res, next) => sessionMw ? sessionMw(req, res, next) : next(new Error('Aplikacija še ni pripravljena')));
function init() {
  const opts = { secret: process.env.SESSION_SECRET || 'dev-secret-change-me', resave: false, saveUninitialized: false, cookie: { sameSite: 'lax', httpOnly: true, maxAge: 30 * 864e5 } };
  if (S().kind === 'mongodb') opts.store = require('connect-mongo').MongoStore.create({ client: S().client, dbName: S().db.databaseName, collectionName: 'sessions', ttl: 30 * 86400 });
  sessionMw = session(opts);
  setInterval(() => sendReminders().catch(console.error), 5 * 60 * 1000);
}

app.use('/static', express.static(path.join(__dirname, 'public')));
// Slike se shranijo v MongoDB (GridFS), zato jih multer drži samo v pomnilniku
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5e6 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });
app.get('/img/:id', async (req, res) => {
  const img = await S().getImage(req.params.id);
  if (!img) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type(img.contentType).send(img.buffer);
});
const saveUpload = file => file ? S().saveImage(file.buffer, file.mimetype, file.originalname) : null;

app.use(async (req, res, next) => {
  req.user = req.session.uid ? await S().users.findOne({ _id: oid(req.session.uid) }) : null;
  res.locals.flash = req.session.flash; delete req.session.flash;
  next();
});
const flash = (req, msg) => { req.session.flash = msg; };
const slugify = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const toCents = v => Math.round(parseFloat(String(v).replace(',', '.').replace(/[^\d.]/g, '')) * 100) || 0;
const normEmail = e => String(e || '').trim().toLowerCase() || null;
const normPhone = p => { let x = String(p || '').replace(/[^\d+]/g, ''); if (x.startsWith('00')) x = '+' + x.slice(2); if (/^0\d{8}$/.test(x)) x = '+386' + x.slice(1); return x || null; };
const fmtTs = d => d ? new Date(d).toLocaleString('sl-SI', { timeZone: 'Europe/Ljubljana', dateStyle: 'short', timeStyle: 'short' }) : '';
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!roles.includes(req.user.role)) return res.status(403).send(page('Ni dostopa', `${topbar(req.user)}<div class="empty big"><h2>Ni dostopa</h2></div>`));
    next();
  };
}
async function withProvider(req, res, next) {
  if (req.user.role === 'provider') req.provider = await S().providers.findOne({ userId: req.user._id });
  else if (req.user.role === 'admin' && req.session.actingProvider) req.provider = await S().providers.findOne({ _id: oid(req.session.actingProvider) });
  if (!req.provider) return res.redirect(req.user.role === 'admin' ? '/admin' : '/');
  next();
}
const dash = (req, res, title, body, active, actions = '') => res.send(dashLayout(title, body, { user: req.user, provider: req.provider, active, flash: res.locals.flash, actions }));

// Stranka je samostojna (ni vezana na naročnico). Prepoznamo jo po računu, e-pošti ali telefonu.
async function upsertCustomer({ name, email, phone, userId }) {
  const or = [];
  if (userId) or.push({ userId });
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  const now = new Date();
  const c = or.length ? await S().customers.findOne({ $or: or }) : null;
  if (c) {
    const set = { name, lastBookingAt: now };
    if (email && !c.email) set.email = email;
    if (phone && !c.phone) set.phone = phone;
    if (userId && !c.userId) set.userId = userId;
    await S().customers.updateOne({ _id: c._id }, { $set: set });
    return c._id;
  }
  return (await S().customers.insertOne({ name, email, phone, userId: userId || null, createdAt: now, lastBookingAt: now })).insertedId;
}

// Rezervacije za isto naročnico se obdelajo ena za drugo, da isti termin ne gre dvakrat
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => { });
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// ---------- Javno ----------
const authShell = (title, sub, form) => page(title, `<div class="auth"><div class="auth-side">${V.logo()}
  <div class="auth-quote"><h2>Spletno naročanje, ki dela <em>namesto vas.</em></h2><p>Stranke se naročijo same, 24 ur na dan. Vi dobite SMS in urejen koledar.</p>
  <ul class="auth-list"><li>${icon('check', 16)} Lastna povezava za vsak salon</li><li>${icon('check', 16)} Termini se izračunajo glede na storitve</li><li>${icon('check', 16)} Potrditve in opomniki po SMS in e-pošti</li></ul></div>
  <small>© ${new Date().getFullYear()} Terminko</small></div>
  <div class="auth-main"><div class="auth-box"><h1>${title}</h1><p class="muted">${sub}</p>${form}</div></div></div>`, { bodyClass: 'is-auth' });

app.get('/', async (req, res) => {
  if (req.user?.role === 'admin') return res.redirect('/admin');
  if (req.user?.role === 'provider') return res.redirect('/dash');
  const provs = await S().providers.find({ active: true }).sort({ businessName: 1 }).toArray();
  for (const p of provs) p.n = await S().services.countDocuments({ providerId: p._id, active: true });
  res.send(page('Spletno naročanje', `${topbar(req.user)}
  <section class="hero"><span class="eyebrow">${icon('sparkles', 14)} Naročanje za salone in studie</span>
   <h1>Vaš naslednji termin,<br><em>v nekaj sekundah.</em></h1>
   <p>Izberite salon, storitve in prost termin. Brez klicev, brez čakanja, brez registracije.</p></section>
  <section class="wrap"><div class="sec-h"><h2>Saloni</h2><span class="muted">${provs.length} ${provs.length === 1 ? 'salon' : 'salonov'}</span></div>
   <div class="grid3">${provs.map(p => `<a class="prov-card" href="/b/${esc(p.slug)}">${cover(p, 'cover-sm')}<div class="pc-body"><b>${esc(p.businessName)}</b>
    <span class="muted small">${icon('map-pin', 14)} ${esc(p.address)}</span><span class="muted small">${p.n} storitev</span></div></a>`).join('')}</div></section>`));
});

const safeNext = (n, d) => { n = String(n || ''); return n.startsWith('/') && !n.startsWith('//') ? n : d; };
app.get('/login', (req, res) => res.send(authShell('Prijava', 'Prijavite se v svoj račun.', `<form class="form" method="post">
  ${res.locals.flash ? `<div class="flash err">${esc(res.locals.flash)}</div>` : ''}
  <label>E-pošta<input name="email" type="email" required autofocus autocomplete="email"></label><label>Geslo<input name="password" type="password" required autocomplete="current-password"></label>
  <input type="hidden" name="next" value="${esc(req.query.next || '')}"><button class="btn block lg">Prijava</button>
  <p class="muted small center">Ste stranka brez računa? <a href="/register${req.query.next ? '?next=' + encodeURIComponent(req.query.next) : ''}">Ustvarite ga</a>, ni pa obvezen.</p></form>`)));
app.post('/login', async (req, res) => {
  const u = await S().users.findOne({ email: normEmail(req.body.email) });
  if (!u || !verify(req.body.password || '', u.passwordHash)) { flash(req, 'Napačna e-pošta ali geslo.'); return res.redirect('/login'); }
  req.session.regenerate(() => {
    req.session.uid = sid(u._id);
    res.redirect(safeNext(req.body.next, u.role === 'admin' ? '/admin' : u.role === 'provider' ? '/dash' : '/moje'));
  });
});
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/register', (req, res) => res.send(authShell('Ustvari račun', 'Z računom imate pregled nad rezervacijami, podatki pa so pri naročanju že izpolnjeni.', `<form class="form" method="post">
  ${res.locals.flash ? `<div class="flash err">${esc(res.locals.flash)}</div>` : ''}
  <label>Ime in priimek<input name="name" required autocomplete="name"></label><label>E-pošta<input name="email" type="email" required autocomplete="email"></label>
  <label>Telefon<input name="phone" type="tel" autocomplete="tel"></label><label>Geslo<input name="password" type="password" minlength="8" required autocomplete="new-password" placeholder="vsaj 8 znakov"></label>
  <input type="hidden" name="next" value="${esc(req.query.next || '')}"><button class="btn block lg">Ustvari račun</button>
  <p class="muted small center">Že imate račun? <a href="/login">Prijava</a></p></form>`)));
app.post('/register', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!email || await S().users.findOne({ email })) { flash(req, 'Ta e-pošta je že registrirana.'); return res.redirect('/register'); }
  if (String(req.body.password || '').length < 8) { flash(req, 'Geslo mora imeti vsaj 8 znakov.'); return res.redirect('/register'); }
  const phone = normPhone(req.body.phone);
  const { insertedId } = await S().users.insertOne({ email, passwordHash: hash(req.body.password), role: 'customer', name: String(req.body.name || '').trim(), phone, createdAt: new Date() });
  // Pretekle rezervacije s to e-pošto ali telefonom se povežejo z novim računom
  const or = [{ email }]; if (phone) or.push({ phone });
  await S().customers.updateMany({ $or: or, userId: null }, { $set: { userId: insertedId } });
  req.session.uid = sid(insertedId);
  res.redirect(safeNext(req.body.next, '/moje'));
});

const statusPill = (b, now) => b.status === 'cancelled' ? '<span class="pill red">Odpovedano</span>' : b.start < now ? '<span class="pill grey">Opravljeno</span>' : '<span class="pill green">Potrjeno</span>';
app.get('/moje', requireRole('customer'), async (req, res) => {
  const custIds = (await S().customers.find({ userId: req.user._id }).toArray()).map(c => c._id);
  const bs = custIds.length ? await S().bookings.find({ customerId: { $in: custIds } }).sort({ start: -1 }).limit(200).toArray() : [];
  const provs = await providerMap(bs.map(b => b.providerId));
  const now = A.nowLocal();
  res.send(page('Moje rezervacije', `${topbar(req.user)}<section class="wrap narrow"><h1 class="page-h">Moje rezervacije</h1>
  ${bs.length ? bs.map(b => { const p = provs[sid(b.providerId)] || {}; return `<a class="card row-card" href="/r/${b.token}"><div class="date-chip" style="--accent:${esc(p.accentColor)}"><small>${V.MONTHS[Number(b.start.slice(5, 7)) - 1].slice(0, 3)}</small><b>${Number(b.start.slice(8, 10))}</b></div>
   <div class="grow"><b>${esc(p.businessName)}</b><div class="muted small">${V.DAYS[A.weekday(b.date)]} ob ${b.start.slice(11)} · ${esc(p.address)}</div></div>${statusPill(b, now)}</a>`; }).join('')
      : `<div class="empty">${icon('calendar-days', 28)}<p>Še nimate rezervacij.</p><a class="btn" href="/">Poišči salon</a></div>`}
  </section>`));
});
async function providerMap(ids) {
  const uniq = [...new Set(ids.map(sid))].map(oid);
  const ps = uniq.length ? await S().providers.find({ _id: { $in: uniq } }).toArray() : [];
  return Object.fromEntries(ps.map(p => [sid(p._id), p]));
}

// Stran za naročanje
app.get('/b/:slug', async (req, res) => {
  const p = await S().providers.findOne({ slug: req.params.slug });
  if (!p || (!p.active && req.user?.role !== 'admin')) return res.status(404).send(page('Ni najdeno', `${topbar(req.user)}<div class="empty big">${icon('search-x', 32)}<h2>Stran ne obstaja</h2><a class="btn" href="/">Na začetek</a></div>`));
  const services = await S().services.find({ providerId: p._id, active: true }).sort({ sort: 1, category: 1, name: 1 }).toArray();
  const hours = [...(p.weeklyHours || [])].sort((a, b) => a.weekday - b.weekday || (a.start < b.start ? -1 : 1));
  const today = A.nowLocal().slice(0, 10), todayR = A.workingRanges(await A.loadRange(p, today, today), today);
  const data = { slug: p.slug, name: p.businessName, today, maxDays: p.settings.maxDaysAhead,
    services: services.map(s => ({ id: sid(s._id), name: s.name, durationMin: s.durationMin, priceCents: s.priceCents })),
    user: req.user ? { name: req.user.name, email: req.user.email, phone: req.user.phone } : null };
  const cats = [...new Set(services.map(s => s.category || 'Storitve'))];
  const openTxt = todayR.length ? `Danes odprto do ${A.fromMin(todayR[todayR.length - 1][1])}` : 'Danes zaprto';
  res.send(page(p.businessName, `${topbar(req.user)}
  <div class="bk" style="--accent:${esc(p.accentColor)}">
   <div class="bk-head">
     <div class="bk-title"><h1>${esc(p.businessName)}</h1>
      <div class="meta"><span>${icon('map-pin', 15)} ${esc(p.address)}</span><span class="${todayR.length ? 'open-now' : ''}">${icon('clock', 15)} ${openTxt}</span>${p.phone ? `<span>${icon('phone', 15)} ${esc(p.phone)}</span>` : ''}</div></div>
     ${cover(p)}
   </div>
   <div class="bk-body">
    <div class="stepper" id="stepper"><div data-s="1" class="on"><i>1</i>Storitve</div><span></span><div data-s="2"><i>2</i>Termin</div><span></span><div data-s="3"><i>3</i>Podatki</div></div>
    <section id="step1">
      <h2 class="step-h">Izberite <em>storitve</em></h2>${p.description ? `<p class="about">${esc(p.description)}</p>` : ''}
      <div class="cat-tabs">${cats.map((c, i) => `<a class="${i ? '' : 'on'}" href="#cat-${esc(slugify(c))}">${esc(c)}</a>`).join('')}</div>
      ${cats.map(c => `<h2 class="cat-h" id="cat-${esc(slugify(c))}">${esc(c)}</h2><div class="svc-list">${services.filter(s => (s.category || 'Storitve') === c).map((s, i) => `
        <label class="svc reveal" style="--i:${i}"><input type="checkbox" value="${sid(s._id)}">${thumb(imgUrl(s.imageId), s.name, 'thumb', s.category)}
          <div class="svc-info"><b>${esc(s.name)}</b><div class="svc-meta">${dur(s.durationMin)}${s.processing?.durationMin ? ` <span class="dot"></span> vključuje ${s.processing.durationMin} min čakanja` : ''}</div>${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}<div class="svc-price">${eur(s.priceCents)}</div></div>
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
     <div class="sum-prov">${cover(p, 'sum-cover')}<div><b>${esc(p.businessName)}</b><small class="muted">${esc(p.address)}</small></div></div>
     <div id="sumItems" class="sum-items"><div class="sum-empty">Izberite eno ali več storitev.</div></div>
     <div id="sumWhen" class="sum-when"></div>
     <div class="sum-total"><span>Skupaj</span><b id="sumTotal">0,00 €</b></div>
     <button class="btn block lg" id="nextBtn" disabled>Naprej</button>
     <p class="sum-note muted small">Plačilo v salonu. Brezplačna odpoved do ${p.settings.cancelHours} ur prej.</p>
   </aside>
  </div>
  <footer class="foot">Naročanje omogoča ${V.logo()}</footer>
  <script>window.BK=${JSON.stringify(data).replace(/</g, '\\u003c')}</script><script src="/static/book.js"></script>`));
});

app.get('/api/b/:slug/availability', async (req, res) => {
  const p = await S().providers.findOne({ slug: req.params.slug, active: true });
  if (!p) return res.status(404).json({ error: 'ni najdeno' });
  const svcs = await A.loadServices(p._id, String(req.query.services || '').split(',').filter(Boolean));
  if (!svcs) return res.status(400).json({ error: 'neveljavne storitve' });
  const from = isDate(req.query.from) ? req.query.from : A.nowLocal().slice(0, 10);
  res.json(await A.availability(p, svcs, from, Math.min(Number(req.query.days) || 7, 31)));
});

app.post('/api/b/:slug/book', async (req, res) => {
  const p = await S().providers.findOne({ slug: req.params.slug, active: true });
  if (!p) return res.status(404).json({ error: 'ni najdeno' });
  const { services = [], date, time, note } = req.body;
  const name = String(req.body.name || '').trim(), email = normEmail(req.body.email), phone = normPhone(req.body.phone);
  if (!name) return res.status(400).json({ error: 'Vpišite ime.' });
  if (!email && !phone) return res.status(400).json({ error: 'Vpišite e-pošto ali telefon.' });
  if (!isDate(date) || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Neveljaven termin.' });
  const svcs = await A.loadServices(p._id, [].concat(services).map(String));
  if (!svcs) return res.status(400).json({ error: 'Neveljavne storitve.' });
  const today = A.nowLocal().slice(0, 10);
  if (date < today || date > A.addDays(today, p.settings.maxDaysAhead)) return res.status(409).json({ error: 'Termin ni na voljo.' });

  const result = await withLock(sid(p._id), async () => {
    const ctx = await A.loadRange(p, date, date);
    const slot = A.slotsForDate(ctx, svcs, date).find(s => s.time === time);
    if (!slot) return { conflict: true };
    const plan = A.planSegments(svcs, A.toMin(time));
    const customerId = await upsertCustomer({ name, email, phone, userId: req.user?.role === 'customer' ? req.user._id : null });
    const booking = {
      providerId: p._id, customerId, customer: { name, email, phone }, note: String(note || '').slice(0, 1000),
      date, start: A.dt(date, plan.items[0].start), end: A.dt(date, plan.end), totalCents: svcs.reduce((a, s) => a + s.priceCents, 0),
      status: 'confirmed', token: crypto.randomBytes(16).toString('hex'), reminderSent: false, source: 'online',
      fillsGapOf: slot.gapOf ? oid(slot.gapOf) : null,
      items: plan.items.map(it => ({ serviceId: it.serviceId, name: it.name, priceCents: it.priceCents, start: A.dt(date, it.start), end: A.dt(date, it.end),
        gap: it.gap ? { start: A.dt(date, it.gap.s), end: A.dt(date, it.gap.e), allowedServiceIds: it.gap.allowed.map(oid) } : null })),
      createdAt: new Date(),
    };
    booking._id = (await S().bookings.insertOne(booking)).insertedId;
    return { booking };
  });
  if (result.conflict) return res.status(409).json({ error: 'Termin žal ni več prost. Izberite drugega.' });
  const b = result.booking;
  await N.bookingCreated(b, p);
  res.json({ ok: true, token: b.token, start: b.start, end: b.end, total: eur(b.totalCents) });
});

function bookingView(b, p, user, msg) {
  const now = A.nowLocal(), ch = p.settings.cancelHours;
  const canCancel = b.status === 'confirmed' && A.addMinutes(now, ch * 60) <= b.start;
  return page('Rezervacija', `${topbar(user)}<div class="wrap narrow" style="--accent:${esc(p.accentColor)}">
   ${msg ? `<div class="flash">${icon('circle-check', 18)}<span>${esc(msg)}</span></div>` : ''}
   <div class="card receipt">
    <div class="rc-head">${cover(p, 'sum-cover')}<div class="grow"><b>${esc(p.businessName)}</b><small class="muted">${esc(p.address)}</small></div>${statusPill(b, now)}</div>
    <div class="rc-when"><div class="date-chip"><small>${V.MONTHS[Number(b.start.slice(5, 7)) - 1].slice(0, 3)}</small><b>${Number(b.start.slice(8, 10))}</b></div>
     <div><b class="big">${V.DAYS[A.weekday(b.date)]}, ${V.fmtDate(b.start)}</b><div class="muted">${b.start.slice(11)} – ${b.end.slice(11)}</div></div></div>
    <div class="rc-items">${b.items.map(i => `<div class="line"><span>${esc(i.name)}<small class="muted"> · ${i.start.slice(11)}</small></span><span>${eur(i.priceCents)}</span></div>`).join('')}
     <div class="line total"><span>Skupaj</span><span>${eur(b.totalCents)}</span></div></div>
    <div class="rc-actions"><a class="btn ghost" href="/r/${b.token}/ics">${icon('calendar-plus', 16)} Dodaj v koledar</a>
     ${p.phone ? `<a class="btn ghost" href="tel:${esc(p.phone.replace(/\s/g, ''))}">${icon('phone', 16)} Pokliči salon</a>` : ''}
     <a class="btn ghost" href="/b/${esc(p.slug)}">${icon('rotate-ccw', 16)} Nova rezervacija</a></div>
    ${canCancel ? `<form class="rc-cancel" method="post" action="/r/${b.token}/cancel" onsubmit="return confirm('Res želite odpovedati termin?')"><span class="muted small">Brezplačna odpoved do ${ch} ur pred terminom.</span><button class="link danger">Odpovej termin</button></form>`
      : b.status === 'confirmed' && b.start > now ? `<p class="rc-cancel muted small">Spletna odpoved ni več mogoča. Za spremembe pokličite ${esc(p.phone)}.</p>` : ''}
   </div></div>`);
}
async function byToken(token) {
  const b = await S().bookings.findOne({ token: String(token) });
  return b ? { b, p: await S().providers.findOne({ _id: b.providerId }) } : {};
}
app.get('/r/:token', async (req, res) => {
  const { b, p } = await byToken(req.params.token);
  if (!b) return res.status(404).send(page('Ni najdeno', `${topbar(req.user)}<div class="empty big"><h2>Rezervacija ne obstaja</h2></div>`));
  res.send(bookingView(b, p, req.user, res.locals.flash));
});
app.get('/r/:token/ics', async (req, res) => {
  const { b, p } = await byToken(req.params.token);
  if (!b) return res.sendStatus(404);
  const f = s => s.replace(/[-: ]/g, '').slice(0, 8) + 'T' + s.slice(11).replace(':', '') + '00';
  res.type('text/calendar').attachment('termin.ics').send(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//terminko//SL', 'BEGIN:VEVENT', `UID:${b.token}@terminko`,
    `DTSTART;TZID=Europe/Ljubljana:${f(b.start)}`, `DTEND;TZID=Europe/Ljubljana:${f(b.end)}`, `SUMMARY:${p.businessName}`, `LOCATION:${p.address}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
});
app.post('/r/:token/cancel', async (req, res) => {
  const { b, p } = await byToken(req.params.token);
  if (!b) return res.sendStatus(404);
  if (b.status !== 'confirmed' || A.addMinutes(A.nowLocal(), p.settings.cancelHours * 60) > b.start) { flash(req, 'Termina ni več mogoče odpovedati prek spleta.'); return res.redirect('/r/' + b.token); }
  await S().bookings.updateOne({ _id: b._id }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'customer' } });
  await N.bookingCancelled(b, p, true);
  flash(req, 'Termin je odpovedan. Prejeli boste potrditev.');
  res.redirect('/r/' + b.token);
});

// ---------- Nadzorna plošča naročnice ----------
const D = express.Router();
D.use(requireRole('provider', 'admin'), withProvider);

const itemNames = b => b.items.map(i => i.name).join(', ');
D.get('/', async (req, res) => {
  const p = req.provider, now = A.nowLocal(), today = now.slice(0, 10);
  const B = S().bookings;
  const [todays, upcoming, week, next] = await Promise.all([
    B.find({ providerId: p._id, status: 'confirmed', date: today }).sort({ start: 1 }).toArray(),
    B.find({ providerId: p._id, status: 'confirmed', start: { $gte: now } }).toArray(),
    B.countDocuments({ providerId: p._id, createdAt: { $gte: new Date(Date.now() - 7 * 864e5) } }),
    B.find({ providerId: p._id, status: 'confirmed', date: { $gt: today } }).sort({ start: 1 }).limit(6).toArray(),
  ]);
  const link = `${req.protocol}://${req.get('host')}/b/${p.slug}`;
  const stat = (ic, label, val, sub = '') => `<div class="card stat"><span class="stat-ic">${icon(ic, 18)}</span><div><div class="muted small">${label}</div><b class="num">${val}</b>${sub ? `<div class="muted small">${sub}</div>` : ''}</div></div>`;
  dash(req, res, 'Pregled', `
  <div class="card linkbox"><span class="stat-ic accent">${icon('link', 18)}</span><div class="grow"><div class="muted small">Vaša povezava za naročanje. Delite jo na Instagramu, Facebooku ali Google profilu.</div><b id="lnk">${esc(link)}</b></div>
   <button class="btn sm" onclick="navigator.clipboard.writeText(document.getElementById('lnk').textContent);this.innerHTML='Kopirano'">${icon('copy', 15)} Kopiraj</button></div>
  <div class="stats">${stat('calendar-days', 'Danes', todays.length, 'terminov')}${stat('calendar-clock', 'Prihajajoči', upcoming.length, 'potrjenih terminov')}${stat('wallet', 'Pričakovan promet', eur(upcoming.reduce((a, b) => a + b.totalCents, 0)), 'iz prihajajočih terminov')}${stat('trending-up', 'Novih rezervacij', week, 'zadnjih 7 dni')}</div>
  <div class="grid-2-1"><div><div class="sec-h"><h2>Danes, ${V.fmtDate(today)}</h2><a class="link" href="/dash/calendar">Odpri koledar</a></div>${bookingTable(todays, true)}</div>
   <div><div class="sec-h"><h2>Naslednji termini</h2></div><div class="card list">${next.length ? next.map(b => `<div class="li"><div class="date-chip sm"><small>${V.DAYS_S[A.weekday(b.date)]}</small><b>${Number(b.date.slice(8, 10))}</b></div><div class="grow"><b>${esc(b.customer.name)}</b><div class="muted small">${b.start.slice(11)} · ${esc(itemNames(b))}</div></div></div>`).join('') : '<div class="li muted">Ni prihajajočih terminov.</div>'}</div></div></div>`, '/dash',
  `<a class="btn ghost sm" href="/b/${esc(p.slug)}" target="_blank">${icon('external-link', 15)} Odpri mojo stran</a><a class="btn sm" href="/b/${esc(p.slug)}" target="_blank">${icon('plus', 15)} Nova rezervacija</a>`);
});

function bookingTable(bs, compact) {
  if (!bs.length) return `<div class="card empty">${icon('calendar-x-2', 26)}<p>Ni terminov.</p></div>`;
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Termin</th><th>Stranka</th><th>Storitve</th><th class="r">Znesek</th><th>Status</th><th></th></tr></thead><tbody>${bs.map(b => `<tr class="${b.status === 'cancelled' ? 'dim' : ''}">
    <td class="nowrap">${compact ? '' : `<div class="muted small">${V.DAYS_S[A.weekday(b.date)]}, ${V.fmtDate(b.start)}</div>`}<b>${b.start.slice(11)}</b> – ${b.end.slice(11)}</td>
    <td><div class="who"><span class="avatar sm">${esc(b.customer.name.trim()[0] || '?')}</span><div><b>${esc(b.customer.name)}</b><div class="muted small">${esc(b.customer.phone || b.customer.email || '')}</div></div></div></td>
    <td>${esc(itemNames(b))}${b.fillsGapOf ? ` <span class="pill blue" title="Med čakanjem druge stranke">vzporedno</span>` : ''}${b.note ? `<div class="muted small">${icon('message-square', 12)} ${esc(b.note)}</div>` : ''}</td>
    <td class="r nowrap">${eur(b.totalCents)}</td><td><span class="pill ${b.status === 'cancelled' ? 'red' : 'green'}">${b.status === 'cancelled' ? 'Odpovedano' : 'Potrjeno'}</span></td>
    <td class="r">${b.status === 'confirmed' ? `<form method="post" action="/dash/bookings/${sid(b._id)}/cancel" onsubmit="return confirm('Odpovem termin? Stranka bo obveščena.')"><button class="link danger small">Odpovej</button></form>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

D.get('/bookings', async (req, res) => {
  const show = req.query.show === 'past' ? 'past' : 'up', now = A.nowLocal();
  const bs = await S().bookings.find({ providerId: req.provider._id, start: show === 'past' ? { $lt: now } : { $gte: now } }).sort({ start: show === 'past' ? -1 : 1 }).limit(300).toArray();
  dash(req, res, 'Rezervacije', `<div class="tabs"><a class="${show === 'up' ? 'on' : ''}" href="?show=up">Prihajajoče</a><a class="${show === 'past' ? 'on' : ''}" href="?show=past">Pretekle</a>
   </div>${bookingTable(bs)}`, '/dash/bookings', `<a class="btn sm" href="/b/${esc(req.provider.slug)}" target="_blank">${icon('plus', 15)} Nova rezervacija</a>`);
});
D.post('/bookings/:id/cancel', async (req, res) => {
  const b = await S().bookings.findOne({ _id: oid(req.params.id), providerId: req.provider._id });
  if (b && b.status === 'confirmed') {
    await S().bookings.updateOne({ _id: b._id }, { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'provider' } });
    await N.bookingCancelled(b, req.provider, false); flash(req, 'Termin odpovedan, stranka obveščena.');
  }
  res.redirect(req.get('referer') || '/dash/bookings');
});

// Stranke, ki so se naročile pri tej naročnici (povezava prek rezervacij)
async function customerRows(filter) {
  const bs = await S().bookings.find(filter).sort({ start: -1 }).toArray();
  const by = new Map();
  for (const b of bs) {
    const k = sid(b.customerId); if (!by.has(k)) by.set(k, { n: 0, cancelled: 0, spent: 0, last: b.start, providers: new Set() });
    const r = by.get(k); r.n++; r.providers.add(sid(b.providerId));
    if (b.status === 'cancelled') r.cancelled++; else r.spent += b.totalCents;
  }
  const cs = by.size ? await S().customers.find({ _id: { $in: [...by.keys()].map(oid) } }).toArray() : [];
  return cs.map(c => ({ c, ...by.get(sid(c._id)) })).sort((a, b) => a.last < b.last ? 1 : -1);
}
const customerTable = (rows, showProviders, provs = {}) => rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Stranka</th><th>Kontakt</th>${showProviders ? '<th>Saloni</th>' : ''}<th class="r">Rezervacij</th><th class="r">Odpovedi</th><th class="r">Skupaj</th><th>Zadnji termin</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td><div class="who"><span class="avatar sm">${esc((r.c.name || '?').trim()[0])}</span><div><b>${esc(r.c.name)}</b>${r.c.userId ? '<div class="muted small">ima račun</div>' : ''}</div></div></td>
   <td class="small">${esc(r.c.phone || '')}<div class="muted">${esc(r.c.email || '')}</div></td>${showProviders ? `<td class="small">${[...r.providers].map(id => esc(provs[id]?.businessName || '')).join(', ')}</td>` : ''}
   <td class="r">${r.n}</td><td class="r">${r.cancelled}</td><td class="r nowrap">${eur(r.spent)}</td><td class="nowrap">${V.fmtDate(r.last)} ${r.last.slice(11)}</td></tr>`).join('')}</tbody></table></div>`
  : `<div class="card empty">${icon('contact', 26)}<p>Še ni strank.</p></div>`;
D.get('/customers', async (req, res) => {
  const rows = await customerRows({ providerId: req.provider._id });
  dash(req, res, 'Stranke', `<p class="muted">Stranke, ki so se kdaj naročile pri vas. Stranka se prepozna po telefonu ali e-pošti, zato ista oseba ni podvojena.</p>${customerTable(rows)}`, '/dash/customers');
});

// Tedenski koledar
D.get('/calendar', async (req, res) => {
  const p = req.provider, today = A.nowLocal().slice(0, 10);
  let start = isDate(req.query.w) ? req.query.w : today;
  start = A.addDays(start, 1 - A.weekday(start));
  const days = [...Array(7)].map((_, i) => A.addDays(start, i));
  const ctx = await A.loadRange(p, days[0], days[6]);
  const svcNames = Object.fromEntries((await S().services.find({ providerId: p._id }).toArray()).map(s => [sid(s._id), s.name]));
  const H0 = 7 * 60, H1 = 21 * 60, PX = 1.1; // px na minuto
  const y = m => (Math.max(H0, Math.min(H1, m)) - H0) * PX;
  const cols = days.map(d => {
    const ranges = A.workingRanges(ctx, d);
    const bs = ctx.bookings.filter(b => b.date === d).sort((a, b) => a.start < b.start ? -1 : 1);
    let html = ranges.map(([s, e]) => `<div class="open" style="top:${y(s)}px;height:${y(e) - y(s)}px"></div>`).join('');
    for (const bl of ctx.blocks.filter(bl => bl.start.slice(0, 10) <= d && bl.end.slice(0, 10) >= d)) {
      const s = bl.start.slice(0, 10) < d ? 0 : A.toMin(bl.start.slice(11)), e = bl.end.slice(0, 10) > d ? 1440 : A.toMin(bl.end.slice(11));
      html += `<div class="ev block" style="top:${y(s)}px;height:${y(e) - y(s)}px">${esc(bl.note || 'Odsotnost')}</div>`;
    }
    for (const b of bs) {
      const nm = esc(b.customer.name);
      for (const it of b.items) {
        const s = A.toMin(it.start.slice(11)), e = A.toMin(it.end.slice(11));
        const gs = it.gap ? A.toMin(it.gap.start.slice(11)) : e, ge = it.gap ? A.toMin(it.gap.end.slice(11)) : e;
        html += `<div class="ev ${b.fillsGapOf ? 'par' : ''}" style="top:${y(s)}px;height:${y(gs) - y(s) - 2}px" title="${nm} · ${esc(it.name)}"><b>${it.start.slice(11)} ${nm}</b><span>${esc(it.name)}</span></div>`;
        if (it.gap) {
          html += `<div class="ev" style="top:${y(ge)}px;height:${y(e) - y(ge) - 2}px" title="${nm} · ${esc(it.name)}"><b>${it.gap.end.slice(11)} ${nm}</b><span>${esc(it.name)} (nadaljevanje)</span></div>`;
          const allowed = (it.gap.allowedServiceIds || []).map(id => svcNames[sid(id)]).filter(Boolean);
          const filled = bs.some(o => o !== b && (sid(o.fillsGapOf) === sid(b._id) || (o.start >= it.gap.start && o.end <= it.gap.end)));
          html += `<div class="ev gap" style="top:${y(gs)}px;height:${y(ge) - y(gs) - 2}px"><span>⏳ čakanje${filled ? '' : ` · prosto za ${esc(allowed.join(', ') || 'drugo storitev')}`}</span></div>`;
        }
      }
    }
    return `<div class="col"><div class="col-h ${d === today ? 'today' : ''}">${V.DAYS_S[A.weekday(d)]} <b>${Number(d.slice(8))}.${Number(d.slice(5, 7))}.</b></div><div class="col-b" style="height:${(H1 - H0) * PX}px">${html}</div></div>`;
  }).join('');
  const hours = [...Array((H1 - H0) / 60)].map((_, i) => `<div style="height:${60 * PX}px">${String(7 + i).padStart(2, '0')}:00</div>`).join('');
  const futureBlocks = await S().blocks.find({ providerId: p._id, end: { $gte: A.nowLocal() } }).sort({ start: 1 }).toArray();
  dash(req, res, 'Koledar', `<div class="tabs"><a href="?w=${A.addDays(start, -7)}">‹ Prejšnji teden</a><a href="?">Danes</a><a href="?w=${A.addDays(start, 7)}">Naslednji teden ›</a>
    <span class="muted" style="margin-left:auto">${V.fmtDate(days[0])} – ${V.fmtDate(days[6])}</span></div>
   <div class="legend"><span class="lgd ev-l"></span>termin <span class="lgd gap-l"></span>čakanje (barva deluje) – prosto za vzporedno storitev <span class="lgd par-l"></span>termin med čakanjem <span class="lgd block-l"></span>odsotnost</div>
   <div class="week"><div class="hrs"><div class="col-h"></div>${hours}</div>${cols}</div>
   <details class="card pad" style="margin-top:16px"><summary><b>+ Dodaj odsotnost / blokiran čas</b></summary>
    <form method="post" action="/dash/blocks" class="inline-form"><label>Od<input type="datetime-local" name="start" required></label><label>Do<input type="datetime-local" name="end" required></label><label>Opomba<input name="note" placeholder="npr. dopust, malica"></label><button class="btn sm">Shrani</button></form>
    ${futureBlocks.map(b => `<div class="line"><span>${esc(b.start)} – ${esc(b.end)} ${esc(b.note)}</span><form method="post" action="/dash/blocks/${sid(b._id)}/delete"><button class="link danger">Odstrani</button></form></div>`).join('')}
   </details>`, '/dash/calendar');
});
D.post('/blocks', async (req, res) => {
  const s = String(req.body.start || '').replace('T', ' ').slice(0, 16), e = String(req.body.end || '').replace('T', ' ').slice(0, 16);
  if (s.length === 16 && e > s) await S().blocks.insertOne({ providerId: req.provider._id, start: s, end: e, note: String(req.body.note || ''), createdAt: new Date() });
  res.redirect('/dash/calendar?w=' + s.slice(0, 10));
});
D.post('/blocks/:id/delete', async (req, res) => { await S().blocks.deleteOne({ _id: oid(req.params.id), providerId: req.provider._id }); res.redirect('/dash/calendar'); });

// Storitve
D.get('/services', async (req, res) => {
  const p = req.provider;
  const svcs = await S().services.find({ providerId: p._id }).sort({ sort: 1, category: 1, name: 1 }).toArray();
  const edit = req.query.edit && req.query.edit !== 'new' ? svcs.find(x => sid(x._id) === req.query.edit) : null;
  const s = edit || { name: '', category: '', description: '', durationMin: 30, priceCents: 0, processing: null, active: true, sort: svcs.length };
  const pr = s.processing || { offsetMin: 0, durationMin: 0, allowedServiceIds: [] };
  const allowed = (pr.allowedServiceIds || []).map(sid);
  dash(req, res, 'Storitve', `
  <div class="tabs"><a class="on" href="/dash/services">Seznam</a><a href="/dash/services/bulk">Množični vnos</a></div>
  <table class="tbl"><tr><th style="width:56px"></th><th>Storitev</th><th>Kategorija</th><th>Trajanje</th><th>Cena</th><th>Vzporedno</th><th></th></tr>${svcs.map(x => `<tr class="${x.active ? '' : 'dim'}">
   <td>${thumb(imgUrl(x.imageId), x.name, 'thumb sm', x.category)}</td><td><b>${esc(x.name)}</b>${x.active ? '' : ' <span class="pill grey">skrito</span>'}</td><td>${esc(x.category)}</td><td>${dur(x.durationMin)}</td><td>${eur(x.priceCents)}</td>
   <td class="small">${x.processing?.durationMin ? `⏳ ${x.processing.durationMin} min čakanja po ${x.processing.offsetMin} min` : ''}</td><td><a class="btn ghost sm" href="?edit=${sid(x._id)}#form">Uredi</a></td></tr>`).join('')}</table>
  ${req.query.edit ? `<form id="form" class="card pad form two" method="post" action="/dash/services/save" enctype="multipart/form-data">
   <h2 class="full">${edit ? 'Uredi storitev' : 'Nova storitev'}</h2><input type="hidden" name="id" value="${edit ? sid(edit._id) : ''}">
   <label>Ime *<input name="name" value="${esc(s.name)}" required></label><label>Kategorija<input name="category" value="${esc(s.category)}" list="cats" placeholder="npr. Lasje"></label>
   <datalist id="cats">${[...new Set(svcs.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
   <label>Trajanje (min) *<input name="duration_min" type="number" min="5" step="5" value="${s.durationMin}" required></label><label>Cena (€) *<input name="price" value="${(s.priceCents / 100).toFixed(2).replace('.', ',')}" required></label>
   <label class="full">Opis<textarea name="description" rows="2">${esc(s.description)}</textarea></label>
   <label>Slika ${edit?.imageId ? '<span class="opt">naložena, nova jo zamenja</span>' : ''}<input type="file" name="image" accept="image/*"></label><label>Vrstni red<input name="sort" type="number" value="${s.sort}"></label>
   ${edit?.imageId ? `<label class="chk full"><input type="checkbox" name="remove_image"> Odstrani sliko</label>` : ''}
   <fieldset class="full par-box"><legend>⏳ Čakalni čas in vzporedna storitev</legend>
    <p class="muted small">Npr. barvanje 120 min: po 30 min nanosa barva deluje 40 min. V tem času je izvajalka prosta, zato aplikacija strankam samodejno ponudi termin za izbrane storitve (npr. striženje) v sredini tega termina.</p>
    <label>Čakanje se začne po (min)<input name="processing_offset" type="number" min="0" step="5" value="${pr.offsetMin}"></label>
    <label>Čakanje traja (min)<input name="processing_min" type="number" min="0" step="5" value="${pr.durationMin}"></label>
    <div class="full"><div class="small"><b>Med čakanjem lahko delam (prazno = katerokoli, ki se prilega):</b></div><div class="chips">${svcs.filter(x => !edit || sid(x._id) !== sid(edit._id)).map(x => `<label class="chip"><input type="checkbox" name="gap_allowed" value="${sid(x._id)}" ${allowed.includes(sid(x._id)) ? 'checked' : ''}>${esc(x.name)} (${x.durationMin} min)</label>`).join('')}</div></div>
   </fieldset>
   <label class="chk full"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}> Prikazano na strani za naročanje</label>
   <div class="full row"><button class="btn">Shrani</button><a class="btn ghost" href="/dash/services">Prekliči</a>
   ${edit ? `<button class="btn danger" formaction="/dash/services/${sid(edit._id)}/delete" onclick="return confirm('Izbrišem storitev?')" style="margin-left:auto">Izbriši</button>` : ''}</div></form>` : ''}`, '/dash/services', `<a class="btn ghost sm" href="/dash/services/bulk">${icon('table-2', 15)} Množični vnos</a><a class="btn sm" href="/dash/services?edit=new#form">${icon('plus', 15)} Nova storitev</a>`);
});
D.post('/services/save', upload.single('image'), async (req, res) => {
  const p = req.provider, b = req.body;
  if (!String(b.name || '').trim()) { flash(req, 'Ime je obvezno.'); return res.redirect('/dash/services'); }
  const pm = Number(b.processing_min) || 0;
  const doc = {
    category: String(b.category || '').trim(), name: String(b.name).trim(), description: String(b.description || ''), durationMin: Number(b.duration_min) || 30, priceCents: toCents(b.price),
    processing: pm > 0 ? { offsetMin: Number(b.processing_offset) || 0, durationMin: pm, allowedServiceIds: [].concat(b.gap_allowed || []).map(oid).filter(Boolean) } : null,
    active: !!b.active, sort: Number(b.sort) || 0, updatedAt: new Date(),
  };
  const existing = b.id ? await S().services.findOne({ _id: oid(b.id), providerId: p._id }) : null;
  if (req.file || (b.remove_image && existing?.imageId)) {
    if (existing?.imageId) await S().deleteImage(existing.imageId);
    doc.imageId = req.file ? await saveUpload(req.file) : null;
  }
  if (existing) await S().services.updateOne({ _id: existing._id }, { $set: doc });
  else await S().services.insertOne({ providerId: p._id, imageId: null, ...doc, createdAt: new Date() });
  flash(req, 'Storitev shranjena.'); res.redirect('/dash/services');
});
D.post('/services/:id/delete', async (req, res) => {
  const s = await S().services.findOne({ _id: oid(req.params.id), providerId: req.provider._id });
  if (s) { if (s.imageId) await S().deleteImage(s.imageId); await S().services.deleteOne({ _id: s._id }); }
  flash(req, 'Storitev izbrisana.'); res.redirect('/dash/services');
});

function parseBulk(text) {
  const rows = [], errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const c = line.split(line.includes('\t') ? '\t' : ';').map(x => x.trim());
    if (/^kategorija$/i.test(c[0])) return;
    const [category = '', name, minutes, price, description = ''] = c;
    if (!name || !Number(minutes)) { errors.push(`Vrstica ${i + 1}: manjka ime ali trajanje`); return; }
    rows.push({ category, name, durationMin: Number(minutes), priceCents: toCents(price), description });
  });
  return { rows, errors };
}
D.get('/services/bulk', (req, res) => dash(req, res, 'Množični vnos storitev', `
  <div class="tabs"><a href="/dash/services">Seznam</a><a class="on" href="/dash/services/bulk">Množični vnos</a></div>
  <form class="card pad form" method="post"><p>Prilepite tabelo iz Excela/Google Sheets ali vpišite vsako storitev v svojo vrstico, stolpci ločeni s podpičjem:</p>
  <code class="block">Kategorija; Ime; Trajanje (min); Cena (€); Opis</code>
  <textarea name="text" rows="10" placeholder="Lasje; Žensko striženje; 45; 28; Pranje, striženje in feniranje&#10;Lasje; Moško striženje; 30; 18&#10;Nohti; Gel lak; 60; 32,50"></textarea>
  <div class="row"><button class="btn ghost" name="mode" value="preview">Predogled</button><button class="btn" name="mode" value="save">Uvozi</button></div></form>`, '/dash/services'));
D.post('/services/bulk', async (req, res) => {
  const { rows, errors } = parseBulk(req.body.text);
  if (req.body.mode === 'save' && rows.length && !errors.length) {
    const base = await S().services.countDocuments({ providerId: req.provider._id }), now = new Date();
    await S().services.insertMany(rows.map((r, i) => ({ providerId: req.provider._id, ...r, imageId: null, processing: null, active: true, sort: base + i, createdAt: now })));
    flash(req, `Uvoženih ${rows.length} storitev. Slike in čakalne čase lahko dodate pri posamezni storitvi.`); return res.redirect('/dash/services');
  }
  dash(req, res, 'Množični vnos storitev', `<div class="tabs"><a href="/dash/services">Seznam</a><a class="on" href="/dash/services/bulk">Množični vnos</a></div>
   ${errors.length ? `<div class="flash err">${errors.map(esc).join('<br>')}</div>` : ''}
   <h2>Predogled (${rows.length})</h2><table class="tbl"><tr><th>Kategorija</th><th>Ime</th><th>Trajanje</th><th>Cena</th><th>Opis</th></tr>${rows.map(r => `<tr><td>${esc(r.category)}</td><td>${esc(r.name)}</td><td>${dur(r.durationMin)}</td><td>${eur(r.priceCents)}</td><td>${esc(r.description)}</td></tr>`).join('')}</table>
   <form class="form" method="post"><textarea name="text" rows="8">${esc(req.body.text)}</textarea><div class="row"><button class="btn ghost" name="mode" value="preview">Osveži predogled</button><button class="btn" name="mode" value="save" ${errors.length || !rows.length ? 'disabled' : ''}>Uvozi ${rows.length} storitev</button></div></form>`, '/dash/services');
});

// Delovni čas + koledar izjem
D.get('/hours', async (req, res) => {
  const p = req.provider, wh = p.weeklyHours || [];
  const today = A.nowLocal().slice(0, 10);
  const m = /^\d{4}-\d{2}$/.test(req.query.m) ? req.query.m : today.slice(0, 7);
  const first = m + '-01', startCell = A.addDays(first, 1 - A.weekday(first));
  const ctx = await A.loadRange(p, startCell, A.addDays(startCell, 41));
  const ovs = ctx.overrides;
  const sel = isDate(req.query.d) ? req.query.d : null;
  const nextM = A.addDays(first, 32).slice(0, 7), prevM = A.addDays(first, -1).slice(0, 7);
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = A.addDays(startCell, i); if (i >= 35 && d.slice(0, 7) !== m) break;
    const r = A.workingRanges(ctx, d), o = ovs[d];
    cells += `<a href="?m=${m}&d=${d}#edit" class="mc ${d.slice(0, 7) !== m ? 'out' : ''} ${d === today ? 'today' : ''} ${o ? 'ov' : ''} ${r.length ? '' : 'closed'} ${sel === d ? 'sel' : ''}">
     <b>${Number(d.slice(8))}</b><span>${r.length ? r.map(([a, b]) => A.fromMin(a) + '–' + A.fromMin(b)).join('<br>') : 'zaprto'}</span>${o?.note ? `<i>${esc(o.note)}</i>` : ''}</a>`;
  }
  const selCtx = sel && !(sel in ovs) && (sel < startCell || sel > A.addDays(startCell, 41)) ? await A.loadRange(p, sel, sel) : ctx;
  const selRanges = sel ? A.workingRanges(selCtx, sel) : [];
  const selOv = sel ? selCtx.overrides[sel] : null;
  dash(req, res, 'Delovni čas', `
  <div class="cols2">
   <form class="card pad form" method="post" action="/dash/hours"><h2>Tedenski urnik</h2><p class="muted small">Več intervalov na dan ločite z vejico, npr. <code>08:00-12:00, 13:00-19:00</code>. Prazno = zaprto.</p>
    ${[1, 2, 3, 4, 5, 6, 7].map(d => `<label class="hrow"><span>${V.DAYS[d]}</span><input name="d${d}" value="${wh.filter(x => x.weekday === d).sort((a, b) => a.start < b.start ? -1 : 1).map(x => x.start + '-' + x.end).join(', ')}" placeholder="zaprto"></label>`).join('')}
    <button class="btn">Shrani urnik</button></form>
   <div class="card pad"><h2>Koledar razpoložljivosti</h2><p class="muted small">Kliknite dan, da ga zaprete (dopust, praznik) ali nastavite drugačen urnik samo za ta dan.</p>
    <div class="tabs"><a href="?m=${prevM}">‹</a><b>${V.MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</b><a href="?m=${nextM}">›</a></div>
    <div class="month">${V.DAYS_S.slice(1).map(x => `<div class="mh">${x}</div>`).join('')}${cells}</div>
    ${sel ? `<form id="edit" class="form ovform" method="post" action="/dash/overrides"><h3>${V.DAYS[A.weekday(sel)]}, ${V.fmtDate(sel)}</h3><input type="hidden" name="date" value="${sel}">
     <label class="chk"><input type="checkbox" name="closed" ${selRanges.length ? '' : 'checked'}> Zaprto ta dan</label>
     <label>Ure ta dan<input name="ranges" value="${selRanges.map(([a, b]) => A.fromMin(a) + '-' + A.fromMin(b)).join(', ')}"></label>
     <label>Opomba<input name="note" value="${esc(selOv?.note || '')}" placeholder="npr. dopust"></label>
     <label>Ponovi za naslednjih dni<input name="repeat" type="number" min="0" max="60" value="0"></label>
     <div class="row"><button class="btn sm">Shrani</button>${selOv ? `<button class="btn sm ghost" name="reset" value="1">Povrni na tedenski urnik</button>` : ''}</div></form>` : ''}
   </div></div>`, '/dash/hours');
});
function parseRanges(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(/[-–]/).map(t => t.trim()))
    .filter(([a, b]) => /^\d{1,2}:\d{2}$/.test(a) && /^\d{1,2}:\d{2}$/.test(b)).map(([a, b]) => ({ start: a.padStart(5, '0'), end: b.padStart(5, '0') })).filter(r => r.end > r.start);
}
D.post('/hours', async (req, res) => {
  const weeklyHours = [];
  for (let d = 1; d <= 7; d++) for (const r of parseRanges(req.body['d' + d])) weeklyHours.push({ weekday: d, ...r });
  await S().providers.updateOne({ _id: req.provider._id }, { $set: { weeklyHours } });
  flash(req, 'Urnik shranjen.'); res.redirect('/dash/hours');
});
D.post('/overrides', async (req, res) => {
  const p = req.provider, date = req.body.date;
  if (!isDate(date)) return res.redirect('/dash/hours');
  const n = Math.min(Number(req.body.repeat) || 0, 60);
  for (let i = 0; i <= n; i++) {
    const d = A.addDays(date, i);
    if (req.body.reset) await S().overrides.deleteOne({ providerId: p._id, date: d });
    else await S().overrides.updateOne({ providerId: p._id, date: d }, { $set: { closed: !!req.body.closed, ranges: parseRanges(req.body.ranges), note: String(req.body.note || '') } }, { upsert: true });
  }
  flash(req, 'Shranjeno.'); res.redirect(`/dash/hours?m=${date.slice(0, 7)}&d=${date}`);
});

// Nastavitve
D.get('/settings', (req, res) => {
  const p = req.provider, st = p.settings;
  dash(req, res, 'Profil in nastavitve', `<form class="card pad form two" method="post" enctype="multipart/form-data">
   <label>Ime salona<input name="business_name" value="${esc(p.businessName)}" required></label>
   <label>Povezava<div class="prefix"><span>/b/</span><input name="slug" value="${esc(p.slug)}" pattern="[a-z0-9-]+" required></div></label>
   <label>Naslov<input name="address" value="${esc(p.address)}"></label><label>Telefon (za SMS o novih rezervacijah)<input name="phone" value="${esc(p.phone)}"></label>
   <label class="full">Opis<textarea name="description" rows="3">${esc(p.description)}</textarea></label>
   <label>Naslovna slika ${p.coverImageId ? '<span class="opt">naložena, nova jo zamenja</span>' : ''}<input type="file" name="cover" accept="image/*"></label><label>Barva poudarka<input type="color" name="accent" value="${esc(p.accentColor)}"></label>
   ${p.coverImageId ? `<label class="chk full"><input type="checkbox" name="remove_cover"> Odstrani naslovno sliko</label>` : ''}
   <h3 class="full">Pravila naročanja</h3>
   <label>Korak terminov (min)<select name="slot_step">${[10, 15, 20, 30, 60].map(v => `<option ${st.slotStep === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
   <label>Odmor med strankami (min)<input type="number" name="buffer_min" min="0" value="${st.bufferMin}"></label>
   <label>Najmanj ur vnaprej<input type="number" name="min_notice_hours" min="0" value="${st.minNoticeHours}"></label>
   <label>Največ dni vnaprej<input type="number" name="max_days_ahead" min="1" value="${st.maxDaysAhead}"></label>
   <label>Spletna odpoved do (ur pred terminom)<input type="number" name="cancel_hours" min="0" value="${st.cancelHours}"></label>
   <div class="full"><button class="btn">Shrani</button></div></form>`, '/dash/settings');
});
D.post('/settings', upload.single('cover'), async (req, res) => {
  const p = req.provider, b = req.body, slug = slugify(b.slug) || p.slug;
  if (await S().providers.findOne({ slug, _id: { $ne: p._id } })) { flash(req, 'Ta povezava je že zasedena.'); return res.redirect('/dash/settings'); }
  const set = {
    businessName: String(b.business_name || p.businessName).trim(), slug, address: String(b.address || ''), phone: String(b.phone || ''), description: String(b.description || ''),
    accentColor: /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : p.accentColor,
    settings: { slotStep: Number(b.slot_step) || 15, bufferMin: Number(b.buffer_min) || 0, minNoticeHours: Number(b.min_notice_hours) || 0, maxDaysAhead: Number(b.max_days_ahead) || 60, cancelHours: Number(b.cancel_hours) || 0 },
  };
  if (req.file || (b.remove_cover && p.coverImageId)) {
    if (p.coverImageId) await S().deleteImage(p.coverImageId);
    set.coverImageId = req.file ? await saveUpload(req.file) : null;
  }
  await S().providers.updateOne({ _id: p._id }, { $set: set });
  flash(req, 'Shranjeno.'); res.redirect('/dash/settings');
});
app.use('/dash', D);

// ---------- Admin ----------
const AD = express.Router();
AD.use(requireRole('admin'));
const adm = async (req, res, title, body, active, actions = '') => {
  const provider = req.session.actingProvider ? await S().providers.findOne({ _id: oid(req.session.actingProvider) }) : null;
  res.send(dashLayout(title, body, { user: req.user, provider, active, flash: res.locals.flash, actions }));
};
AD.get('/', async (req, res) => {
  const now = A.nowLocal(), month = now.slice(0, 7);
  const [ps, users, monthB, upcomingB, sms] = await Promise.all([
    S().providers.find({}).sort({ businessName: 1 }).toArray(),
    S().users.find({ role: 'provider' }).toArray(),
    S().bookings.find({ status: 'confirmed', date: { $gte: month + '-01', $lte: month + '-31' } }).toArray(),
    S().bookings.find({ status: 'confirmed', start: { $gte: now } }).toArray(),
    S().notifications.countDocuments({ channel: 'sms', createdAt: { $gte: new Date(month + '-01T00:00:00Z') } }),
  ]);
  const login = Object.fromEntries(users.map(u => [sid(u._id), u.email]));
  for (const p of ps) {
    const k = sid(p._id);
    p.login = login[sid(p.userId)]; p.nsvc = await S().services.countDocuments({ providerId: p._id });
    p.upcoming = upcomingB.filter(b => sid(b.providerId) === k).length;
    p.month = monthB.filter(b => sid(b.providerId) === k).reduce((a, b) => a + b.totalCents, 0);
  }
  const stat = (ic, label, val) => `<div class="card stat"><span class="stat-ic">${icon(ic, 18)}</span><div><div class="muted small">${label}</div><b class="num">${val}</b></div></div>`;
  await adm(req, res, 'Naročnice', `<div class="stats">${stat('building-2', 'Aktivne naročnice', ps.filter(p => p.active).length)}${stat('calendar-check', 'Termini ta mesec', monthB.length)}${stat('wallet', 'Promet ta mesec', eur(monthB.reduce((a, b) => a + b.totalCents, 0)))}${stat('message-square', 'SMS ta mesec', sms)}</div>
   <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Salon</th><th>Prijava</th><th class="r">Storitve</th><th class="r">Prihajajoči</th><th class="r">Promet ta mesec</th><th>Status</th><th></th></tr></thead><tbody>
   ${ps.map(p => `<tr class="${p.active ? '' : 'dim'}"><td><div class="who"><span class="mono sm" style="--accent:${esc(p.accentColor)}">${esc(p.businessName.trim()[0])}</span><div><b>${esc(p.businessName)}</b><div class="small"><a class="muted" href="/b/${esc(p.slug)}" target="_blank">/b/${esc(p.slug)} ${icon('external-link', 12)}</a></div></div></div></td>
   <td class="muted">${esc(p.login || '–')}</td><td class="r">${p.nsvc}</td><td class="r">${p.upcoming}</td><td class="r">${eur(p.month)}</td>
   <td><form method="post" action="/admin/providers/${sid(p._id)}/toggle"><button class="pill-btn" title="Klikni za preklop">${p.active ? '<span class="pill green">Aktivna</span>' : '<span class="pill grey">Neaktivna</span>'}</button></form></td>
   <td class="r"><a class="btn ghost sm" href="/admin/act/${sid(p._id)}">Upravljaj ${icon('arrow-right', 14)}</a></td></tr>`).join('')}</tbody></table></div>
   <details class="card pad" id="new" ${ps.length ? '' : 'open'}><summary><b>${icon('plus', 16)} Dodaj novo naročnico</b></summary>
   <form class="form two" method="post" action="/admin/providers" style="margin-top:16px">
    <label>Ime salona<input name="business_name" required></label><label>Povezava <span class="opt">prazno = iz imena</span><input name="slug" pattern="[a-z0-9-]*"></label>
    <label>E-pošta za prijavo<input name="email" type="email" required></label><label>Začetno geslo<input name="password" minlength="8" required></label>
    <label>Telefon za SMS<input name="phone"></label><label>Naslov<input name="address"></label>
    <div class="full row"><label class="chk"><input type="checkbox" name="default_hours" checked> Nastavi privzet urnik pon–pet 9–17</label><button class="btn" style="margin-left:auto">Ustvari naročnico</button></div></form></details>`, '/admin',
   `<a class="btn sm" href="#new" onclick="document.getElementById('new').open=true">${icon('plus', 15)} Nova naročnica</a>`);
});
AD.post('/providers', async (req, res) => {
  const b = req.body, email = normEmail(b.email);
  let slug = slugify(b.slug || b.business_name) || 'salon';
  if (!email || await S().users.findOne({ email })) { flash(req, 'Uporabnik s to e-pošto že obstaja.'); return res.redirect('/admin'); }
  while (await S().providers.findOne({ slug })) slug += '-' + crypto.randomBytes(2).toString('hex');
  const { insertedId: userId } = await S().users.insertOne({ email, passwordHash: hash(String(b.password)), role: 'provider', name: b.business_name, phone: b.phone || '', createdAt: new Date() });
  await S().providers.insertOne({ ...providerDefaults(), userId, slug, businessName: String(b.business_name).trim(), phone: b.phone || '', address: b.address || '', email,
    weeklyHours: b.default_hours ? [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '09:00', end: '17:00' })) : [] });
  flash(req, `Naročnica ustvarjena. Povezava: /b/${slug}`); res.redirect('/admin');
});
AD.post('/providers/:id/toggle', async (req, res) => {
  const p = await S().providers.findOne({ _id: oid(req.params.id) });
  if (p) await S().providers.updateOne({ _id: p._id }, { $set: { active: !p.active } });
  res.redirect('/admin');
});
AD.get('/act/:id', async (req, res) => { if (await S().providers.findOne({ _id: oid(req.params.id) })) req.session.actingProvider = req.params.id; res.redirect('/dash'); });
AD.get('/bookings', async (req, res) => {
  const bs = await S().bookings.find({}).sort({ createdAt: -1 }).limit(300).toArray();
  const provs = await providerMap(bs.map(b => b.providerId));
  await adm(req, res, 'Vse rezervacije', `<table class="tbl"><tr><th>Ustvarjeno</th><th>Salon</th><th>Termin</th><th>Stranka</th><th>Znesek</th><th>Status</th></tr>${bs.map(b => `<tr class="${b.status === 'cancelled' ? 'dim' : ''}">
   <td class="small">${esc(fmtTs(b.createdAt))}</td><td>${esc(provs[sid(b.providerId)]?.businessName)}</td><td>${V.fmtDate(b.start)} ${b.start.slice(11)}</td><td>${esc(b.customer.name)}<div class="muted small">${esc(b.customer.phone || '')} ${esc(b.customer.email || '')}</div></td><td>${eur(b.totalCents)}</td>
   <td><a href="/r/${b.token}"><span class="pill ${b.status === 'cancelled' ? 'red' : 'green'}">${b.status === 'cancelled' ? 'odpovedano' : 'potrjeno'}</span></a></td></tr>`).join('')}</table>`, '/admin/bookings');
});
AD.get('/customers', async (req, res) => {
  const rows = await customerRows({});
  const provs = await providerMap(rows.flatMap(r => [...r.providers]));
  await adm(req, res, 'Stranke', `<p class="muted">Vse stranke. Stranka ni vezana na en salon, s salonom jo poveže šele rezervacija.</p>${customerTable(rows, true, provs)}`, '/admin/customers');
});
AD.get('/notifications', async (req, res) => {
  const ns = await S().notifications.find({}).sort({ createdAt: -1 }).limit(200).toArray();
  await adm(req, res, 'Obvestila (log)', `<p class="muted">Testni način: e-pošta in SMS se ne pošiljata zares, tu vidite, kaj bi bilo poslano.</p>
   <table class="tbl"><tr><th>Čas</th><th>Kanal</th><th>Prejemnik</th><th>Vsebina</th><th>Status</th></tr>${ns.map(n => `<tr><td class="small">${esc(fmtTs(n.createdAt))}</td><td><span class="pill ${n.channel === 'sms' ? 'blue' : 'grey'}">${n.channel}</span></td><td>${esc(n.recipient)}</td>
   <td class="small pre">${n.subject ? `<b>${esc(n.subject)}</b>\n` : ''}${esc(n.body)}</td><td>${esc(n.status)}</td></tr>`).join('')}</table>`, '/admin/notifications');
});
AD.get('/users', async (req, res) => {
  const us = await S().users.find({}).sort({ role: 1, email: 1 }).toArray();
  await adm(req, res, 'Uporabniki', `<table class="tbl"><tr><th>E-pošta</th><th>Ime</th><th>Vloga</th><th>Telefon</th><th>Ustvarjen</th><th>Novo geslo</th></tr>${us.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td>
   <td><span class="pill ${u.role === 'admin' ? 'blue' : u.role === 'provider' ? 'green' : 'grey'}">${{ admin: 'admin', provider: 'naročnica', customer: 'stranka' }[u.role]}</span></td><td>${esc(u.phone)}</td><td class="small">${esc(fmtTs(u.createdAt))}</td>
   <td><form method="post" action="/admin/users/${sid(u._id)}/password" class="inline-form"><input name="password" minlength="8" placeholder="novo geslo" required><button class="btn sm ghost">Nastavi</button></form></td></tr>`).join('')}</table>`, '/admin/users');
});
AD.post('/users/:id/password', async (req, res) => {
  if (String(req.body.password || '').length >= 8) { await S().users.updateOne({ _id: oid(req.params.id) }, { $set: { passwordHash: hash(req.body.password) } }); flash(req, 'Geslo spremenjeno.'); }
  res.redirect('/admin/users');
});
app.use('/admin', AD);

// ---------- Opomniki (vsakih 5 min) ----------
async function sendReminders() {
  const now = A.nowLocal(), lim = A.addMinutes(now, 24 * 60);
  const bs = await S().bookings.find({ status: 'confirmed', reminderSent: false, start: { $gt: now, $lte: lim } }).toArray();
  for (const b of bs) {
    const fresh = Date.now() - new Date(b.createdAt).getTime() < 2 * 3600e3 && b.start < A.addMinutes(now, 6 * 60); // sveža rezervacija za kmalu: brez opomnika
    if (!fresh) await N.reminder(b, await S().providers.findOne({ _id: b.providerId }));
    await S().bookings.updateOne({ _id: b._id }, { $set: { reminderSent: true } });
  }
}

app.use((err, req, res, next) => { console.error(err); res.status(500).send(page('Napaka', '<div class="empty big"><h2>Prišlo je do napake</h2><p class="muted">Poskusite znova čez trenutek.</p><a class="btn" href="/">Na začetek</a></div>')); });

module.exports = { app, init };
