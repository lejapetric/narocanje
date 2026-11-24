// Izračun razpoložljivih terminov.
// Vsi časi so lokalni (Europe/Ljubljana) nizi 'YYYY-MM-DD HH:MM' – v bazi se zaradi tega lepo razvrščajo.
// Podatki za obdobje se naložijo z nekaj poizvedbami (loadRange), izračun pa je nato čisto v pomnilniku.
const { S } = require('./store');
const TZ = 'Europe/Ljubljana';

const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fromMin = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const dt = (date, min) => `${date} ${fromMin(min)}`;
const splitDt = s => ({ date: s.slice(0, 10), min: toMin(s.slice(11, 16)) });

function nowLocal() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}
function addDays(date, n) {
  const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMinutes(s, n) {
  const { date, min } = splitDt(s); let m = min + n, d = date;
  while (m >= 1440) { m -= 1440; d = addDays(d, 1); }
  while (m < 0) { m += 1440; d = addDays(d, -1); }
  return dt(d, m);
}
const weekday = date => { const w = new Date(date + 'T12:00:00Z').getUTCDay(); return w === 0 ? 7 : w; };
const sid = v => v == null ? '' : String(v);

// Naloži vse, kar vpliva na termine med from in to (vključno)
async function loadRange(provider, from, to, excludeBookingId = null) {
  const pid = provider._id;
  const [overrides, bookings, blocks] = await Promise.all([
    S().overrides.find({ providerId: pid, date: { $gte: from, $lte: to } }).toArray(),
    S().bookings.find({ providerId: pid, status: 'confirmed', date: { $gte: from, $lte: to } }).toArray(),
    S().blocks.find({ providerId: pid, start: { $lte: to + ' 23:59' }, end: { $gte: from + ' 00:00' } }).toArray(),
  ]);
  return {
    provider,
    overrides: Object.fromEntries(overrides.map(o => [o.date, o])),
    bookings: excludeBookingId ? bookings.filter(b => sid(b._id) !== sid(excludeBookingId)) : bookings,
    blocks,
  };
}

// Delovni intervali za dan (v minutah)
function workingRanges(ctx, date) {
  const ov = ctx.overrides[date];
  let ranges;
  if (ov) ranges = ov.closed ? [] : (ov.ranges || []);
  else ranges = (ctx.provider.weeklyHours || []).filter(h => h.weekday === weekday(date)).sort((a, b) => a.start < b.start ? -1 : 1);
  return ranges.map(r => [toMin(r.start), toMin(r.end)]).filter(r => r[1] > r[0]);
}

// Razdeli storitve (zaporedno) na aktivne bloke in čakalne vrzeli
function planSegments(services, startMin, bufferMin = 0) {
  const active = [], gaps = [], items = [];
  let t = startMin;
  services.forEach(s => {
    const id = sid(s._id), end = t + s.durationMin, pr = s.processing;
    const item = { serviceId: s._id, name: s.name, priceCents: s.priceCents, start: t, end, gap: null };
    if (pr && pr.durationMin > 0 && pr.offsetMin > 0 && pr.offsetMin + pr.durationMin < s.durationMin) {
      const gs = t + pr.offsetMin, ge = gs + pr.durationMin;
      active.push({ s: t, e: gs, sid: id }, { s: ge, e: end, sid: id });
      const gap = { s: gs, e: ge, allowed: (pr.allowedServiceIds || []).map(sid) };
      gaps.push(gap); item.gap = gap;
    } else active.push({ s: t, e: end, sid: id });
    items.push(item);
    t = end;
  });
  if (bufferMin > 0 && active.length) active[active.length - 1].e += bufferMin;
  return { active, gaps, items, end: t };
}

// Obstoječe zasedenosti za dan
function existingForDate(ctx, date) {
  const active = [], gaps = [];
  const buffer = ctx.provider.settings?.bufferMin || 0;
  for (const b of ctx.bookings) {
    if (b.date !== date) continue;
    let last = null;
    for (const it of b.items) {
      const s = splitDt(it.start).min, e = splitDt(it.end).min, id = sid(it.serviceId);
      if (it.gap) {
        const gs = splitDt(it.gap.start).min, ge = splitDt(it.gap.end).min;
        active.push({ s, e: gs, sid: id }, { s: ge, e, sid: id });
        gaps.push({ s: gs, e: ge, allowed: (it.gap.allowedServiceIds || []).map(sid), bookingId: sid(b._id) });
      } else active.push({ s, e, sid: id });
      if (!last || last.e < e) last = active[active.length - 1];
    }
    if (buffer && last) last.e += buffer;
  }
  for (const bl of ctx.blocks) {
    if (bl.start.slice(0, 10) > date || bl.end.slice(0, 10) < date) continue;
    const s = bl.start.slice(0, 10) < date ? 0 : splitDt(bl.start).min;
    const e = bl.end.slice(0, 10) > date ? 1440 : splitDt(bl.end).min;
    active.push({ s, e, sid: '' });
  }
  return { active, gaps };
}

const overlap = (a, b) => a.s < b.e && b.s < a.e;
const allows = (gap, id) => !!id && (!gap.allowed.length || gap.allowed.includes(id));

// Preveri, ali kandidat ustreza; vrne {ok, inGap, gapOf}
function checkCandidate(plan, existing) {
  let inGap = false, gapOf = null;
  for (const A of plan.active) {
    for (const E of existing.active) if (overlap(A, E)) return { ok: false };
    for (const G of existing.gaps) if (overlap(A, G)) {
      if (!(A.s >= G.s && A.e <= G.e && allows(G, A.sid))) return { ok: false };
      inGap = true; gapOf = G.bookingId;
    }
  }
  for (const E of existing.active) for (const G of plan.gaps)
    if (overlap(E, G) && !(E.s >= G.s && E.e <= G.e && allows(G, E.sid))) return { ok: false };
  return { ok: true, inGap, gapOf };
}

// Storitve v vrstnem redu, kot jih je izbrala stranka; null, če katera ne obstaja
async function loadServices(providerId, ids) {
  const { oid } = require('./store');
  const oids = ids.map(oid);
  if (!oids.length || oids.some(x => !x)) return null;
  const found = await S().services.find({ _id: { $in: oids }, providerId, active: true }).toArray();
  const byId = Object.fromEntries(found.map(s => [sid(s._id), s]));
  const out = oids.map(o => byId[sid(o)]);
  return out.some(x => !x) ? null : out;
}

function slotsForDate(ctx, services, date, opts = {}) {
  const p = ctx.provider, st = p.settings || {};
  const ranges = workingRanges(ctx, date);
  if (!ranges.length || !services.length) return [];
  const minStart = opts.ignoreNotice ? '' : addMinutes(nowLocal(), (st.minNoticeHours || 0) * 60);
  const existing = existingForDate(ctx, date);
  const total = planSegments(services, 0).end;
  const candidates = new Set();
  const step = st.slotStep || 15;
  for (const [rs, re] of ranges) for (let t = rs; t + total <= re; t += step) candidates.add(t);
  // "samodejni" termini: začetek vsake čakalne vrzeli
  for (const G of existing.gaps) if (ranges.some(([rs, re]) => G.s >= rs && G.s + total <= re)) candidates.add(G.s);
  const out = [];
  for (const t of [...candidates].sort((a, b) => a - b)) {
    if (dt(date, t) < minStart) continue;
    const plan = planSegments(services, t, st.bufferMin || 0);
    const r = checkCandidate(plan, existing);
    if (r.ok) out.push({ time: fromMin(t), gap: r.inGap, gapOf: r.gapOf });
  }
  return out;
}

async function availability(provider, services, from, days) {
  const today = nowLocal().slice(0, 10), last = addDays(today, provider.settings?.maxDaysAhead || 60);
  const ctx = await loadRange(provider, from, addDays(from, days - 1));
  const res = {};
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    res[d] = d < today || d > last ? [] : slotsForDate(ctx, services, d).map(({ time, gap }) => ({ time, gap }));
  }
  return res;
}

module.exports = { availability, slotsForDate, loadRange, planSegments, loadServices, nowLocal, addDays, addMinutes, dt, toMin, fromMin, splitDt, weekday, workingRanges };
