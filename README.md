# Terminko – spletno naročanje za salone

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lejapetric/narocanje)

Podatki (naročnice, storitve, stranke, rezervacije in slike) se shranjujejo v **MongoDB**.

## 1. MongoDB Atlas (brezplačna baza, enkrat)
1. Ustvari račun na [mongodb.com/atlas](https://www.mongodb.com/cloud/atlas/register) in izberi brezplačen cluster **M0** (regija npr. Frankfurt).
2. **Database Access** → *Add New Database User*: uporabniško ime in geslo (geslo brez posebnih znakov je najlažje).
3. **Network Access** → *Add IP Address* → `0.0.0.0/0` (Render nima stalnega IP naslova).
4. **Connect** → *Drivers* → kopiraj povezavo, npr.
   `mongodb+srv://uporabnik:geslo@cluster0.xxxxx.mongodb.net/terminko?retryWrites=true&w=majority`
   Pred `?` dopiši ime baze (`/terminko`). Ta niz je `MONGODB_URI`.

## 2. Objava na Render
1. Klikni **Deploy to Render** zgoraj (ali na render.com *New → Blueprint* in ta repozitorij).
2. Vpiši `MONGODB_URI` (iz koraka 1) in `ADMIN_PASSWORD` (geslo za admin@terminko.si).
3. Čez nekaj minut dobiš povezavo `https://terminko-xxxx.onrender.com`.

Ob prvem zagonu, ko je baza prazna, se naložijo demo podatki (dve naročnici z nekaj rezervacijami). Če jih nočeš, nastavi `SEED_DEMO=0`.
Podatki ostanejo v Atlasu tudi ob ponovnih zagonih in novih verzijah aplikacije. Če aplikacija že teče, v Renderju odpri *Environment*, dodaj `MONGODB_URI` in shrani.

## Naja Nails
Ob zagonu se samodejno doda naročnica **Naja Nails** (`/b/naja-nails`) s cenikom in slikami z [Instagrama](https://www.instagram.com/najaa_nailss/), če še ne obstaja (`naja.js`, slike v `data/naja/`).
Prijava: `naja-nails@terminko.si`. Geslo nastavi admin v *Admin → Uporabniki*. Trajanja storitev in urnik so okvirni, Naja jih uredi sama. Izklop: `ADD_NAJA=0`.

Vsaka naročnica lahko v *Profil in nastavitve* izbere slog strani (*Terminko* ali *Rožnati*), podnaslov, Instagram, galerijo (do 6 slik) in obvestilo za stranke.

## Zagon lokalno
Potrebuješ Node.js 20 ali novejši.

```bash
npm install
MONGODB_URI="mongodb+srv://..." npm start     # z MongoDB
npm start                                     # brez MONGODB_URI: baza v pomnilniku, samo za preizkus
MONGODB_URI="..." node seed.js                # POBRIŠE bazo in naloži demo podatke
```

Demo računi:
- Admin: `admin@terminko.si` / `admin1234` (ali vrednost `ADMIN_PASSWORD`)
- Naročnica: `lana@primer.si` / `geslo1234` → `/b/studio-lana`
- Naročnica: `maja@primer.si` / `geslo1234` → `/b/nohti-maja`

## Spremenljivke okolja
| Spremenljivka | Pomen |
|---|---|
| `MONGODB_URI` | povezava na MongoDB (Atlas). Brez nje so podatki samo v pomnilniku. |
| `MONGODB_DB` | ime baze, če ni v `MONGODB_URI` (privzeto `terminko`) |
| `SESSION_SECRET` | obvezno v produkciji (Render ga ustvari sam) |
| `ADMIN_PASSWORD` | geslo admina pri prvem zagonu |
| `SEED_DEMO` | `0` = ob prazni bazi ne naloži demo podatkov |
| `BASE_URL` | javni naslov za povezave v SMS/e-pošti (na Renderju samodejno) |
| `NOTIFY_MODE` | `stub` = sporočila se le zapišejo (Admin → Obvestila) |
| `PORT` | vrata (privzeto 3000) |

## Zgradba baze
| Zbirka | Vsebina | Povezave |
|---|---|---|
| `users` | prijave (admin, naročnice, stranke z računom) | |
| `providers` | naročnice: ime, povezava `slug`, naslov, tedenski urnik, pravila | `userId` → users, `coverImageId` → images |
| `services` | storitve: trajanje, cena, opis, čakalni čas | `providerId` → providers, `imageId` → images |
| `customers` | stranke, **samostojne** (niso vezane na salon); prepoznane po telefonu/e-pošti | `userId` → users (če ima račun) |
| `bookings` | rezervacije: kdo, kje, kdaj, katere storitve, cena, status | `providerId`, `customerId`, `items[].serviceId`, `fillsGapOf` → booking |
| `overrides` | izjeme urnika po dnevih (dopust, drugačen čas) | `providerId` |
| `blocks` | odsotnosti / blokiran čas | `providerId` |
| `notifications` | dnevnik poslanih SMS in e-pošte | `bookingId`, `providerId` |
| `images.files`, `images.chunks` | slike (GridFS) | |
| `sessions` | prijave uporabnikov | |

Stranka je s salonom povezana samo prek rezervacije. Rezervacija hrani tudi kopijo imena, telefona in e-pošte ter imen in cen storitev, zato zgodovina ostane pravilna, tudi če se storitev kasneje spremeni ali izbriše.

## Datoteke
- `server.js` – vse poti (javno naročanje, nadzorna plošča naročnice `/dash`, admin `/admin`)
- `store.js` – povezava z MongoDB, indeksi, slike (GridFS) in testna baza v pomnilniku
- `avail.js` – izračun prostih terminov, vključno s čakalnim časom in vzporednimi storitvami
- `notify.js` – e-pošta/SMS (trenutno testni način; tu se priklopi ponudnik)
- `seed.js` – demo podatki
- `public/book.js` – koraki naročanja na strani stranke
