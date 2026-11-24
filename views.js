const fs = require('fs');
const path = require('path');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = c => (Number(c || 0) / 100).toFixed(2).replace('.', ',') + ' €';
const dur = m => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`;
const DAYS = ['', 'Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota', 'Nedelja'];
const DAYS_S = ['', 'pon', 'tor', 'sre', 'čet', 'pet', 'sob', 'ned'];
const MONTHS = ['januar', 'februar', 'marec', 'april', 'maj', 'junij', 'julij', 'avgust', 'september', 'oktober', 'november', 'december'];
const fmtDate = s => { const [y, m, d] = s.slice(0, 10).split('-'); return `${Number(d)}. ${Number(m)}. ${y}`; };

// Ikone (Lucide, licenca ISC) – vstavljene neposredno v HTML
const ICON_DIR = path.join(__dirname, 'node_modules', 'lucide-static', 'icons');
const iconCache = {};
function icon(name, size = 18, cls = '') {
  if (!(name in iconCache)) {
    try { iconCache[name] = fs.readFileSync(path.join(ICON_DIR, name + '.svg'), 'utf8').replace(/<!--.*?-->\s*/s, '').replace(/\s+/g, ' ').trim(); }
    catch { iconCache[name] = ''; }
  }
  return iconCache[name].replace('<svg', `<svg aria-hidden="true" class="ic ${cls}"`).replace(/width="24"/, `width="${size}"`).replace(/height="24"/, `height="${size}"`);
}
function serviceIcon(text) {
  const t = String(text).toLowerCase();
  if (/barv|balaj|pramen|toner/.test(t)) return 'palette';
  if (/striž|stri|las|fen|frizur/.test(t)) return 'scissors';
  if (/pričes|prices|svečan/.test(t)) return 'crown';
  if (/noht|gel|manik|rok|nadgrad/.test(t)) return 'hand';
  if (/pedik|nog|stopal/.test(t)) return 'footprints';
  if (/obrv|trepal|oči/.test(t)) return 'eye';
  if (/masa/.test(t)) return 'flower-2';
  if (/kozmet|obraz|lice/.test(t)) return 'droplet';
  if (/nega|kerat/.test(t)) return 'sparkles';
  return 'sparkles';
}

const logoMark = `<span class="logo-mark">${icon('calendar-check-2', 18)}</span>`;
const logo = (href = '/') => `<a class="logo" href="${href}">${logoMark}<span>terminko</span></a>`;

function page(title, body, { bodyClass = '', head = '' } = {}) {
  return `<!doctype html><html lang="sl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Terminko</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">${head}<script defer src="/static/ui.js"></script></head>
<body class="${bodyClass}">${body}</body></html>`;
}

function topbar(user, { minimal = false } = {}) {
  return `<header class="topbar"><div class="topbar-in">${logo()}<nav>
  ${user ? `${user.role === 'customer' ? `<a href="/moje">${icon('calendar-days', 16)} Moje rezervacije</a>` : `<a href="${user.role === 'admin' ? '/admin' : '/dash'}">${icon('layout-dashboard', 16)} Nadzorna plošča</a>`}
     <span class="avatar" title="${esc(user.email)}">${esc((user.name || user.email).trim()[0].toUpperCase())}</span><a class="muted" href="/logout">Odjava</a>`
      : minimal ? '' : '<a href="/login">Prijava</a><a href="/register" class="btn sm">Ustvari račun</a>'}
  </nav></div></header>`;
}

function dashLayout(title, body, { user, provider, active, flash, actions = '' } = {}) {
  const items = [['/dash', 'Pregled', 'layout-dashboard'], ['/dash/calendar', 'Koledar', 'calendar-days'], ['/dash/bookings', 'Rezervacije', 'list-checks'],
    ['/dash/services', 'Storitve', 'tag'], ['/dash/customers', 'Stranke', 'contact'], ['/dash/hours', 'Delovni čas', 'clock'], ['/dash/settings', 'Profil in nastavitve', 'settings']];
  const adminItems = [['/admin', 'Naročnice', 'building-2'], ['/admin/bookings', 'Vse rezervacije', 'calendar-range'], ['/admin/customers', 'Stranke', 'contact'], ['/admin/notifications', 'Obvestila', 'bell'], ['/admin/users', 'Uporabniki', 'users']];
  const link = ([h, l, i]) => `<a class="${active === h ? 'on' : ''}" href="${h}">${icon(i, 18)}<span>${l}</span></a>`;
  const nav = `<aside class="side">
    <div class="side-top">${logo()}</div>
    ${user.role === 'admin' ? `<div class="side-sec">Administracija</div>${adminItems.map(link).join('')}` : ''}
    ${provider ? `<div class="side-sec">${user.role === 'admin' ? 'Urejaš naročnico' : 'Moj salon'}</div>
      <div class="side-prov"><span class="mono" style="--accent:${esc(provider.accentColor)}">${esc(provider.businessName.trim()[0])}</span><div><b>${esc(provider.businessName)}</b><small>/b/${esc(provider.slug)}</small></div></div>
      ${items.map(link).join('')}
      <a href="/b/${esc(provider.slug)}" target="_blank">${icon('external-link', 18)}<span>Stran za naročanje</span></a>` : ''}
    <div class="side-foot"><span class="avatar">${esc((user.name || user.email).trim()[0].toUpperCase())}</span><div><b>${esc(user.name || '')}</b><small>${esc(user.email)}</small></div><a href="/logout" title="Odjava">${icon('log-out', 18)}</a></div>
  </aside>`;
  return page(title, `<div class="dash">${nav}<main class="dash-main"><div class="dash-head"><h1>${esc(title)}</h1><div class="dash-actions">${actions}</div></div>
    ${flash ? `<div class="flash">${icon('circle-check', 18)}<span>${esc(flash)}</span></div>` : ''}${body}</main></div>`, { bodyClass: 'is-dash' });
}

// Videz strani za naročanje (izbere ga naročnica v nastavitvah)
const THEMES = {
  default: { label: 'Terminko (privzeto)', head: '' },
  blush: { label: 'Rožnati (nežno roza, elegantna pisava)', head: '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&display=swap" rel="stylesheet">' },
};
const themeOpts = p => { const t = THEMES[p?.theme] ? p.theme : 'default'; return { bodyClass: 'theme-' + t, head: THEMES[t].head }; };

// Slike so shranjene v MongoDB (GridFS) in se strežejo prek /img/:id
const imgUrl = id => id ? '/img/' + esc(String(id)) : null;

// Slika storitve ali elegantna ikona
function thumb(img, name, cls = 'thumb', category = '') {
  if (img) return `<img class="${cls}" src="${esc(img)}" alt="">`;
  return `<div class="${cls} ph">${icon(serviceIcon(category + ' ' + name), cls.includes('sm') ? 18 : 26)}</div>`;
}
function cover(p, cls = 'cover') {
  if (p.coverImageId) return `<img class="${cls}" src="${imgUrl(p.coverImageId)}" alt="">`;
  return `<div class="${cls} cover-ph" style="--accent:${esc(p.accentColor)}"><span class="cover-mono">${esc(p.businessName.trim()[0])}</span></div>`;
}

module.exports = { THEMES, themeOpts, imgUrl, esc, eur, dur, page, topbar, dashLayout, thumb, cover, icon, serviceIcon, logo, DAYS, DAYS_S, MONTHS, fmtDate };
