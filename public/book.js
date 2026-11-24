(() => {
  const B = window.BK, $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
  const eur = c => (c / 100).toFixed(2).replace('.', ',') + ' €';
  const dur = m => m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + m % 60 + ' min' : ''}` : `${m} min`;
  const DL = ['Nedelja', 'Ponedeljek', 'Torek', 'Sreda', 'Četrtek', 'Petek', 'Sobota'];
  const DS = ['ned', 'pon', 'tor', 'sre', 'čet', 'pet', 'sob'];
  const MON = ['januar', 'februar', 'marec', 'april', 'maj', 'junij', 'julij', 'avgust', 'september', 'oktober', 'november', 'december'];
  const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const wd = d => new Date(d + 'T12:00:00Z').getUTCDay();
  const fmt = d => `${Number(d.slice(8))}. ${Number(d.slice(5, 7))}. ${d.slice(0, 4)}`;
  let sel = [], step = 1, weekStart = B.today, avail = {}, day = null, time = null;

  function go(n) {
    step = n;
    [1, 2, 3, 4].forEach(i => $('#step' + i).hidden = i !== n);
    $$('#stepper [data-s]').forEach(el => { const k = Number(el.dataset.s); el.classList.toggle('on', k === n); el.classList.toggle('done', k < n); });
    $('#stepper').hidden = n === 4;
    document.querySelector('.bk').classList.toggle('compact', n > 1);
    if (n === 2) loadWeek();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    summary();
  }
  function summary() {
    const svcs = sel.map(id => B.services.find(s => s.id === id));
    $('#sumItems').innerHTML = svcs.length ? svcs.map(s => `<div class="line"><span>${esc(s.name)}<small class="muted">${dur(s.durationMin)}</small></span><span>${eur(s.priceCents)}</span></div>`).join('') : '<div class="sum-empty">Izberite eno ali več storitev.</div>';
    $('#sumTotal').textContent = eur(svcs.reduce((a, s) => a + s.priceCents, 0));
    const total = svcs.reduce((a, s) => a + s.durationMin, 0);
    $('#sumWhen').innerHTML = (day && time && step >= 2 ? `<div><b>${DL[wd(day)]}, ${fmt(day)}</b><span>ob ${time}</span></div>` : '') + (total ? `<small class="muted">Trajanje ${dur(total)}</small>` : '');
    const nb = $('#nextBtn');
    nb.hidden = step === 4;
    nb.disabled = step === 1 ? !sel.length : step === 2 ? !(day && time) : false;
    nb.textContent = step === 3 ? 'Potrdi rezervacijo' : 'Nadaljuj';
  }
  $$('.svc input').forEach(cb => cb.addEventListener('change', () => {
    const id = cb.value;
    sel = cb.checked ? [...sel, id] : sel.filter(x => x !== id);
    cb.closest('.svc').classList.toggle('on', cb.checked);
    day = time = null; summary();
  }));
  $('#nextBtn').addEventListener('click', () => step === 3 ? $('#details').requestSubmit() : go(step + 1));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => go(Number(b.dataset.go))));
  $$('.cat-tabs a').forEach(a => a.addEventListener('click', () => { $$('.cat-tabs a').forEach(x => x.classList.remove('on')); a.classList.add('on'); }));

  async function loadWeek() {
    const last = addDays(B.today, B.maxDays);
    $('#prevW').disabled = weekStart <= B.today; $('#nextW').disabled = addDays(weekStart, 7) > last;
    const m1 = MON[Number(weekStart.slice(5, 7)) - 1], end = addDays(weekStart, 6), m2 = MON[Number(end.slice(5, 7)) - 1];
    $('#monthLbl').textContent = (m1 === m2 ? m1 : m1 + ' – ' + m2) + ' ' + end.slice(0, 4);
    $('#days').innerHTML = [...Array(7)].map(() => '<div class="day sk"></div>').join(''); $('#slots').innerHTML = '';
    const r = await fetch(`/api/b/${B.slug}/availability?services=${sel.join(',')}&from=${weekStart}&days=7`);
    avail = await r.json();
    const keys = Object.keys(avail);
    if (!day || !avail[day]?.length) day = keys.find(k => avail[k].length) || null;
    renderDays();
  }
  function renderDays() {
    $('#days').innerHTML = Object.keys(avail).map(d => {
      const n = avail[d].length;
      return `<button class="day ${d === day ? 'on' : ''}" ${n ? '' : 'disabled'} data-d="${d}"><small>${DS[wd(d)]}</small><b>${Number(d.slice(8))}</b><i class="${n ? (n < 6 ? 'few' : 'ok') : ''}"></i></button>`;
    }).join('');
    $$('.day').forEach(b => b.addEventListener('click', () => { day = b.dataset.d; time = null; renderDays(); summary(); }));
    const slots = day ? avail[day] : [];
    if (!Object.values(avail).some(a => a.length)) $('#slots').innerHTML = '<div class="empty">Ta teden ni prostih terminov.<br><button class="btn ghost sm" id="nw2">Naslednji teden</button></div>';
    else {
      const parts = [['Dopoldne', s => s.time < '12:00'], ['Popoldne', s => s.time >= '12:00' && s.time < '17:00'], ['Zvečer', s => s.time >= '17:00']];
      $('#slots').innerHTML = parts.map(([l, f]) => { const x = slots.filter(f); return x.length ? `<div class="slot-grp"><div class="slot-lbl">${l}</div><div class="slot-row">${x.map(s => `<button class="slot ${s.time === time ? 'on' : ''} ${s.gap ? 'gap' : ''}" data-t="${s.time}" title="${s.gap ? 'Termin med čakanjem druge stranke' : ''}">${s.time}</button>`).join('')}</div></div>` : ''; }).join('')
        + (slots.some(s => s.gap) ? '<p class="hint"><span class="slot-dot"></span>Dodaten termin, ki se je sprostil med čakanjem druge stranke</p>' : '');
      $$('.slot').forEach(b => b.addEventListener('click', () => { time = b.dataset.t; renderDays(); summary(); }));
    }
    $('#nw2')?.addEventListener('click', () => $('#nextW').click());
  }
  $('#prevW').addEventListener('click', () => { weekStart = addDays(weekStart, -7); if (weekStart < B.today) weekStart = B.today; day = null; loadWeek(); });
  $('#nextW').addEventListener('click', () => { weekStart = addDays(weekStart, 7); day = null; loadWeek(); });

  const f = $('#details');
  if (B.user) { f.name.value = B.user.name || ''; f.email.value = B.user.email || ''; f.phone.value = B.user.phone || ''; }
  f.addEventListener('submit', async e => {
    e.preventDefault(); $('#err').textContent = '';
    if (!f.name.value.trim()) { $('#err').textContent = 'Vpišite ime in priimek.'; f.name.focus(); return; }
    if (!f.email.value && !f.phone.value) { $('#err').textContent = 'Vpišite e-pošto ali telefon.'; return; }
    const btn = $('#nextBtn'); btn.disabled = true; btn.textContent = 'Potrjujem …';
    const r = await fetch(`/api/b/${B.slug}/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ services: sel, date: day, time, name: f.name.value, email: f.email.value, phone: f.phone.value, note: f.note.value }) });
    const j = await r.json();
    btn.disabled = false; btn.textContent = 'Potrdi rezervacijo';
    if (!r.ok) { $('#err').textContent = j.error || 'Napaka.'; if (r.status === 409) { time = null; setTimeout(() => go(2), 1200); } return; }
    $('#doneTxt').innerHTML = `<p class="big">${DL[wd(day)]}, ${fmt(day)} ob ${time}</p><p class="muted">${esc(B.name)}</p><p class="muted">Potrditev smo poslali ${[f.email.value && 'na e-pošto', f.phone.value && 'po SMS'].filter(Boolean).join(' in ')}.</p>
      <div class="row center"><a class="btn" href="/r/${j.token}">Ogled rezervacije</a><a class="btn ghost" href="/r/${j.token}/ics">Dodaj v koledar</a></div>
      ${B.user ? '' : `<p class="muted small" style="margin-top:24px">Želite pregled nad svojimi termini? <a href="/register?next=/moje">Ustvarite račun</a> z isto e-pošto.</p>`}`;
    go(4); $('#summary').hidden = true; document.querySelector('.bk').classList.add('is-done');
  });
  summary();
})();
