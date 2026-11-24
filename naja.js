// Naja Nails (instagram.com/najaa_nailss) – naročnica s podatki iz njenega Instagrama.
// ensureNaja() jo doda ob zagonu, če še ne obstaja (povezava /b/naja-nails). Obstoječih podatkov ne spreminja.
// Geslo za prijavo nastavi admin v Admin → Uporabniki. Izklop: ADD_NAJA=0.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S, hash, providerDefaults } = require('./store');

const SLUG = 'naja-nails';
const EMAIL = 'naja-nails@terminko.si';

const SERVICES = [
  // [kategorija, ime, minute, cena €, opis, slika]
  ['Podaljševanje', 'Podaljševanje S', 150, 35, 'Kratki nohti', 3],
  ['Podaljševanje', 'Podaljševanje M', 150, 37, 'Srednje dolgi nohti', 1],
  ['Podaljševanje', 'Podaljševanje L', 165, 39, 'Dolgi nohti', 6],
  ['Korektura / gel na naravne', 'Korektura S / gel na naravne S', 120, 33, '', 4],
  ['Korektura / gel na naravne', 'Korektura M / gel na naravne M', 120, 35, '', 5],
  ['Korektura / gel na naravne', 'Korektura L / gel na naravne L', 135, 37, '', null],
  ['Gelish in BIAB', 'Gelish', 60, 25, 'Samo dolžini S in M', 2],
  ['Gelish in BIAB', 'BIAB', 75, 30, 'Samo dolžini S in M', null],
  ['Dodatki', 'Design mini', 15, 5, 'Cena 5–10 €, odvisno od zahtevnosti', null],
  ['Dodatki', 'Design maxi', 30, 10, 'Cena 10–15 €, odvisno od zahtevnosti', null],
  ['Dodatki', 'Odstranitev pred novim setom', 15, 5, 'Ob novem setu', null],
  ['Dodatki', 'Odstranitev', 30, 12, 'Samo odstranitev, brez novega seta', null],
];

async function ensureNaja() {
  if (process.env.ADD_NAJA === '0' || await S().providers.findOne({ slug: SLUG })) return false;
  const img = n => S().saveImage(fs.readFileSync(path.join(__dirname, 'data', 'naja', n + '.jpg')), 'image/jpeg', `naja-${n}.jpg`);
  const gallery = [];
  for (const n of [1, 2, 3, 4, 5, 6]) gallery.push(await img(n));

  let userId = (await S().users.findOne({ email: EMAIL }))?._id;
  if (!userId) userId = (await S().users.insertOne({ email: EMAIL, passwordHash: hash(crypto.randomBytes(18).toString('base64url')), role: 'provider', name: 'Naja Nails', phone: '', createdAt: new Date() })).insertedId;

  const d = providerDefaults();
  const { insertedId: pid } = await S().providers.insertOne({
    ...d, userId, email: EMAIL, slug: SLUG, businessName: 'Naja Nails',
    address: 'Ljubljana – center', phone: '', accentColor: '#c9879e', theme: 'blush',
    tagline: 'gel nohti · podaljševanje · biab', instagram: 'najaa_nailss',
    description: 'Gel nohti, podaljševanje, korektura in BIAB v centru Ljubljane. Velikost S, M ali L pomeni dolžino nohtov.',
    notice: 'Za rezervacijo termina se nakaže 5 €, ki se odštejejo od cene na terminu. Na dan termina ne uporabljaj kreme za roke in prinesi slike za navdih.',
    coverImageId: gallery[3], galleryImageIds: gallery,
    // Okvirni urnik (iz objavljenih terminov); Naja ga uredi v Delovni čas
    weeklyHours: [1, 2, 3, 4, 5, 6, 7].map(weekday => ({ weekday, start: '09:00', end: '19:00' })),
    settings: { ...d.settings, slotStep: 30, minNoticeHours: 12 },
  });
  for (const [i, [category, name, durationMin, eurV, description, im]] of SERVICES.entries()) {
    await S().services.insertOne({ providerId: pid, category, name, description, durationMin, priceCents: Math.round(eurV * 100),
      imageId: im ? gallery[im - 1] : null, active: true, sort: i, processing: null, createdAt: new Date() });
  }
  console.log(`Dodana naročnica Naja Nails → /b/${SLUG} (prijava ${EMAIL}, geslo nastavi admin)`);
  return true;
}

module.exports = { ensureNaja, SLUG, EMAIL };
