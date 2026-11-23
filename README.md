# Terminko – spletno naročanje za salone

## Zagon (lokalno)
Potrebuješ Node.js 22.5 ali novejši.

```bash
npm install
node seed.js        # demo podatki (POBRIŠE obstoječo bazo)
node server.js      # http://localhost:3000
```

Demo računi:
- Admin: `admin@terminko.si` / `admin1234` (spremeni z `ADMIN_PASSWORD=... node seed.js`)
- Naročnica: `lana@primer.si` / `geslo1234` → http://localhost:3000/b/studio-lana
- Naročnica: `maja@primer.si` / `geslo1234` → http://localhost:3000/b/nohti-maja

## Nastavitve (spremenljivke okolja)
| Spremenljivka | Pomen |
|---|---|
| `PORT` | vrata (privzeto 3000) |
| `BASE_URL` | javni naslov, uporabljen v povezavah v SMS/e-pošti |
| `SESSION_SECRET` | obvezno nastavi v produkciji |
| `DB_PATH` | pot do SQLite baze (privzeto `data/app.db`) |
| `NOTIFY_MODE` | `stub` = sporočila se le zapišejo (Admin → Obvestila) |

## Struktura
- `server.js` – vse poti (javno naročanje, nadzorna plošča naročnice `/dash`, admin `/admin`)
- `avail.js` – izračun prostih terminov, vključno s čakalnim časom in vzporednimi storitvami
- `notify.js` – e-pošta/SMS (trenutno testni način; tu se priklopi ponudnik)
- `db.js` – shema baze (SQLite, vgrajen v Node)
- `public/book.js` – koraki naročanja na strani stranke
- `uploads/` – naložene slike

## Objava na Render (en klik)
1. Odpri povezavo **Deploy to Render** spodaj (ali na render.com izberi *New → Blueprint* in ta repozitorij).
2. Vpiši `ADMIN_PASSWORD` (geslo za admin@terminko.si) in potrdi.
3. Čez nekaj minut dobiš povezavo `https://terminko-xxxx.onrender.com`. Ob prvem zagonu se naložijo demo podatki.

Brezplačni paket na Renderju nima trajnega diska: ob ponovnem zagonu se baza ponastavi na demo podatke. Za pravo uporabo izberi paket *Starter* in dodaj disk (npr. pot `/var/data`) ter nastavi `DB_PATH=/var/data/app.db` in `UPLOAD_DIR=/var/data/uploads`.
