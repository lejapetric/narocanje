// Obvestila. Trenutno TESTNI način: sporočila se zapišejo v bazo (Admin → Obvestila) in konzolo.
// Ko izberemo ponudnika (npr. Brevo, Twilio, SMSAPI.si, Mailgun ...), se implementira samo sendEmail/sendSms.
const { q } = require('./db');

const BASE_URL = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000';
const MODE = process.env.NOTIFY_MODE || 'stub';

async function sendEmail(to, subject, body) {
  if (MODE === 'stub') return 'stub';
  throw new Error('E-poštni ponudnik še ni nastavljen');
}
async function sendSms(to, body) {
  if (MODE === 'stub') return 'stub';
  throw new Error('SMS ponudnik še ni nastavljen');
}

async function log(channel, recipient, subject, body, booking, fn) {
  let status;
  try { status = await fn(); } catch (e) { status = 'napaka: ' + e.message; }
  q.run('INSERT INTO notifications (booking_id, provider_id, channel, recipient, subject, body, status) VALUES (?,?,?,?,?,?,?)',
    booking?.id ?? null, booking?.provider_id ?? null, channel, recipient, subject, body, status);
  console.log(`[${channel.toUpperCase()} → ${recipient}] ${subject || ''} ${body.split('\n')[0]}`);
}

const fmtDate = s => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-'); return `${Number(dd)}. ${Number(m)}. ${y} ob ${t}`; };
const eur = c => (c / 100).toFixed(2).replace('.', ',') + ' €';

function details(b, items) {
  return items.map(i => `• ${i.name} (${i.start.slice(11)})`).join('\n') + `\nSkupaj: ${eur(b.total_cents)}`;
}

async function bookingCreated(b, items, provider) {
  const link = `${BASE_URL}/r/${b.token}`;
  const txt = `Pozdravljeni ${b.customer_name},\n\nvaša rezervacija pri ${provider.business_name} je potrjena za ${fmtDate(b.start)}.\n${details(b, items)}\n\n${provider.address || ''}\nOgled ali odpoved: ${link}`;
  if (b.customer_email) await log('email', b.customer_email, `Potrjena rezervacija – ${provider.business_name}`, txt, b, () => sendEmail(b.customer_email, 'Potrjena rezervacija', txt));
  if (b.customer_phone) await log('sms', b.customer_phone, null, `${provider.business_name}: rezervacija potrjena ${fmtDate(b.start)}. Ogled/odpoved: ${link}`, b, () => sendSms(b.customer_phone, txt));
  const pPhone = provider.phone;
  const ptxt = `Nova rezervacija: ${b.customer_name}, ${fmtDate(b.start)} – ${items.map(i => i.name).join(', ')}. Tel: ${b.customer_phone || '-'}`;
  if (pPhone) await log('sms', pPhone, null, ptxt, b, () => sendSms(pPhone, ptxt));
}

async function bookingCancelled(b, provider, byCustomer) {
  const txt = `Rezervacija pri ${provider.business_name} za ${fmtDate(b.start)} je odpovedana.`;
  if (b.customer_email) await log('email', b.customer_email, 'Odpoved rezervacije', txt, b, () => sendEmail(b.customer_email, 'Odpoved rezervacije', txt));
  if (b.customer_phone && !byCustomer) await log('sms', b.customer_phone, null, txt, b, () => sendSms(b.customer_phone, txt));
  if (provider.phone && byCustomer) await log('sms', provider.phone, null, `Stranka ${b.customer_name} je odpovedala termin ${fmtDate(b.start)}.`, b, () => sendSms(provider.phone, txt));
}

async function reminder(b, provider) {
  const txt = `Opomnik: jutri ${fmtDate(b.start)} imate termin pri ${provider.business_name}. Odpoved: ${BASE_URL}/r/${b.token}`;
  if (b.customer_phone) await log('sms', b.customer_phone, null, txt, b, () => sendSms(b.customer_phone, txt));
  else if (b.customer_email) await log('email', b.customer_email, 'Opomnik za termin', txt, b, () => sendEmail(b.customer_email, 'Opomnik', txt));
}

module.exports = { bookingCreated, bookingCancelled, reminder, fmtDate, eur };
