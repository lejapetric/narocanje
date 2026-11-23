// Izračun razpoložljivih terminov.
// Vsi časi so lokalni (Europe/Ljubljana) nizi 'YYYY-MM-DD HH:MM'.
const { q } = require('./db');
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
const parseJSON = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// Delovni intervali za dan (v minutah)
function workingRanges(providerId, date) {
  const ov = q.get('SELECT * FROM date_overrides WHERE provider_id=? AND date=?', providerId, date);
  let ranges;
  if (ov) ranges = ov.closed ? [] : parseJSON(ov.ranges, []);
  else ranges = q.all('SELECT start,end FROM weekly_hours WHERE provider_id=? AND weekday=? ORDER BY start', providerId, weekday(date));
  return ranges.map(r => [toMin(r.start), toMin(r.end)]).filter(r => r[1] > r[0]);
}

// Razdeli storitve (zaporedno) na aktivne bloke in čakalne vrzeli
function planSegments(services, startMin, bufferMin = 0) {
  const active = [], gaps = [], items = [];
  let t = startMin;
  services.forEach((s, i) => {
    const end = t + s.duration_min;
    const item = { service_id: s.id, name: s.name, price_cents: s.price_cents, start: t, end, gap: null };
    if (s.processing_min > 0 && s.processing_offset > 0 && s.processing_offset + s.processing_min < s.duration_min) {
      const gs = t + s.processing_offset, ge = gs + s.processing_min;
      active.push({ s: t, e: gs, sid: s.id }, { s: ge, e: end, sid: s.id });
      const gap = { s: gs, e: ge, allowed: parseJSON(s.gap_allowed, []) };
      gaps.push(gap); item.gap = gap;
    } else active.push({ s: t, e: end, sid: s.id });
    items.push(item);
    t = end;
  });
  if (bufferMin > 0 && active.length) active[active.length - 1].e += bufferMin;
  return { active, gaps, items, end: t };
}

// Obstoječe zasedenosti za dan
function existingForDate(providerId, date, excludeBookingId = 0) {
  const items = q.all(`SELECT bi.*, b.id AS bid FROM booking_items bi JOIN bookings b ON b.id=bi.booking_id
    WHERE b.provider_id=? AND b.status='confirmed' AND substr(bi.start,1,10)=? AND b.id<>?`, providerId, date, excludeBookingId);
  const prov = q.get('SELECT buffer_min FROM providers WHERE id=?', providerId);
  const active = [], gaps = [];
  // buffer na koncu vsake rezervacije
  const lastEnd = {};
  for (const it of items) {
    const s = splitDt(it.start).min, e = splitDt(it.end).min;
    if (it.gap_start) {
      const gs = splitDt(it.gap_start).min, ge = splitDt(it.gap_end).min;
      active.push({ s, e: gs, sid: it.service_id }, { s: ge, e, sid: it.service_id });
      gaps.push({ s: gs, e: ge, allowed: parseJSON(it.gap_allowed, []) });
    } else active.push({ s, e, sid: it.service_id });
    if (!lastEnd[it.bid] || lastEnd[it.bid].e < e) lastEnd[it.bid] = active[active.length - 1];
  }
  if (prov && prov.buffer_min) Object.values(lastEnd).forEach(a => { a.e += prov.buffer_min; });
  const blocks = q.all(`SELECT * FROM blocks WHERE provider_id=? AND substr(start,1,10)<=? AND substr(end,1,10)>=?`, providerId, date, date);
  for (const b of blocks) {
    const s = b.start.slice(0, 10) < date ? 0 : splitDt(b.start).min;
    const e = b.end.slice(0, 10) > date ? 1440 : splitDt(b.end).min;
    active.push({ s, e, sid: -1 });
  }
  return { active, gaps };
}

const overlap = (a, b) => a.s < b.e && b.s < a.e;
const allows = (gap, sid) => sid > 0 && (!gap.allowed.length || gap.allowed.includes(sid));

// Preveri, ali kandidat ustreza; vrne {ok, inGap}
function checkCandidate(plan, existing) {
  let inGap = false;
  for (const A of plan.active) {
    for (const E of existing.active) if (overlap(A, E)) return { ok: false };
    for (const G of existing.gaps) if (overlap(A, G)) {
      if (!(A.s >= G.s && A.e <= G.e && allows(G, A.sid))) return { ok: false };
      inGap = true;
    }
  }
  for (const E of existing.active) for (const G of plan.gaps)
    if (overlap(E, G) && !(E.s >= G.s && E.e <= G.e && allows(G, E.sid))) return { ok: false };
  return { ok: true, inGap };
}

function loadServices(providerId, ids) {
  const out = [];
  for (const id of ids) {
    const s = q.get('SELECT * FROM services WHERE id=? AND provider_id=? AND active=1', Number(id), providerId);
    if (!s) return null;
    out.push(s);
  }
  return out;
}

function slotsForDate(provider, services, date, opts = {}) {
  const ranges = workingRanges(provider.id, date);
  if (!ranges.length || !services.length) return [];
  const now = nowLocal();
  const minStart = opts.ignoreNotice ? '' : addMinutes(now, provider.min_notice_hours * 60);
  const existing = existingForDate(provider.id, date, opts.excludeBookingId || 0);
  const total = planSegments(services, 0).end;
  const candidates = new Set();
  for (const [rs, re] of ranges) for (let t = rs; t + total <= re; t += provider.slot_step) candidates.add(t);
  // "samodejni" termini: začetek vsake čakalne vrzeli
  for (const G of existing.gaps) if (ranges.some(([rs, re]) => G.s >= rs && G.s + total <= re)) candidates.add(G.s);
  const out = [];
  for (const t of [...candidates].sort((a, b) => a - b)) {
    if (dt(date, t) < minStart) continue;
    const plan = planSegments(services, t, provider.buffer_min);
    const r = checkCandidate(plan, existing);
    if (r.ok) out.push({ time: fromMin(t), gap: r.inGap });
  }
  return out;
}

function availability(provider, services, from, days) {
  const today = nowLocal().slice(0, 10), last = addDays(today, provider.max_days_ahead);
  const res = {};
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    if (d < today || d > last) { res[d] = []; continue; }
    res[d] = slotsForDate(provider, services, d);
  }
  return res;
}

module.exports = { availability, slotsForDate, planSegments, loadServices, nowLocal, addDays, addMinutes, dt, toMin, fromMin, splitDt, weekday, parseJSON, workingRanges };
