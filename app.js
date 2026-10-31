'use strict';

/* =========================================================
   Finans Takip — kişisel finans paneli
   Veriler tarayıcının localStorage alanında saklanır.
   ========================================================= */

const STORE = 'finans-takip-v1';
const THEME_KEY = 'finans-takip-theme';

const TL = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TL0 = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 0 });
const CMP = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 });
const money = v => TL.format(v || 0);
const money0 = v => TL0.format(v || 0);
const compact = v => CMP.format(v) + ' ₺';
const pct = v => '%' + (v * 100).toLocaleString('tr-TR', { maximumFractionDigits: 0 });

const MON = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
const MONL = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const TYPE_LABEL = { card: 'Kredi kartı', loan: 'Kredi taksiti', exp: 'Sabit gider' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = arr => arr.reduce((a, b) => a + (+b || 0), 0);
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- State ---------------- */

const emptyState = () => ({ incomes: [], cards: [], loans: [], expenses: [], purchases: [], paid: {} });

function load() {
  try { return migrate(Object.assign(emptyState(), JSON.parse(localStorage.getItem(STORE)) || {})); }
  catch { return emptyState(); }
}

// Eski sürümdeki "son ekstre borcu" alanını "aylık ödenecek tutar"a taşır
function migrate(s) {
  for (const c of s.cards) {
    if (c.monthlyPayment === undefined) c.monthlyPayment = +c.statement || 0;
    delete c.statement;
  }
  return s;
}

let state = load();
let view = 'dashboard';
let calOffset = 0;
let cardId = null;      // detay sayfası açık olan kart
let cardExtra = 0;      // detay sayfasında ek gösterilen ay sayısı
let spendOffset = 0;    // harcamalar sayfasındaki ay

function save() {
  localStorage.setItem(STORE, JSON.stringify(state));
  if (typeof Sync !== 'undefined') Sync.changed();
  render();
}

/* ---------------- Dates ---------------- */

function today() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
// Ayın belirli günü; gün ay uzunluğunu aşarsa ayın son gününe sabitlenir (ör. 31 → 30 Kasım)
function dateAt(y, m, day) {
  const b = new Date(y, m, 1);
  return new Date(b.getFullYear(), b.getMonth(), Math.min(day, daysIn(b.getFullYear(), b.getMonth())));
}
const mkey = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
function parseD(s) { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
const fmtD = d => d.getDate() + ' ' + MONL[d.getMonth()] + ' ' + d.getFullYear();
const fmtDs = d => d.getDate() + ' ' + MON[d.getMonth()];
const dayDiff = (a, b) => Math.round((b - a) / 864e5);
// Ödendi kaydı: kart ödemelerinde borçtan düşülen tutar (sayı), diğerlerinde true
const paidAmount = (d, key) => (state.paid[mkey(d)] || {})[key];
const isPaid = (d, key) => paidAmount(d, key) !== undefined;

/* ---------------- Domain calculations ---------------- */

function cardInfo(c) {
  const t = today();
  let lastCut = dateAt(t.getFullYear(), t.getMonth(), +c.cutDay);
  if (lastCut > t) lastCut = dateAt(t.getFullYear(), t.getMonth() - 1, +c.cutDay);
  const nextCut = dateAt(lastCut.getFullYear(), lastCut.getMonth() + 1, +c.cutDay);
  const due = dueAfter(c, lastCut);
  const used = +c.balance || 0, limit = +c.limit || 0;
  return {
    lastCut, nextCut, due, used, limit,
    avail: Math.max(limit - used, 0),
    util: limit ? used / limit : 0,
    duePaid: isPaid(due, 'card:' + c.id),
  };
}

// Bir ekstre kesiminden sonraki ilk son ödeme tarihi
function dueAfter(c, cut) {
  let x = dateAt(cut.getFullYear(), cut.getMonth(), +c.dueDay);
  if (x <= cut) x = dateAt(cut.getFullYear(), cut.getMonth() + 1, +c.dueDay);
  return x;
}

function loanDate(l, i) {
  const f = parseD(l.firstDate);
  return dateAt(f.getFullYear(), f.getMonth() + i, f.getDate());
}

// Tarihi geçmiş taksitler ödenmiş kabul edilir; bu ayın taksiti takvimden "ödendi" işaretlenebilir.
function loanInfo(l) {
  const t = today(), n = +l.term || 0, inst = +l.installment || 0;
  let paid = 0, next = null;
  for (let i = 0; i < n; i++) {
    const d = loanDate(l, i);
    if (d < t || isPaid(d, 'loan:' + l.id)) paid++;
    else if (!next) next = { d, i };
  }
  return {
    paid, left: n - paid, remaining: (n - paid) * inst, next,
    progress: n ? paid / n : 0,
    end: n ? loanDate(l, n - 1) : null,
    totalCost: n * inst,
  };
}

function loanRemainingAfter(endDate) {
  const t = today();
  let total = 0;
  for (const l of state.loans) {
    if (!l.firstDate) continue;
    for (let i = 0; i < +l.term; i++) {
      const d = loanDate(l, i);
      if (d < t || isPaid(d, 'loan:' + l.id)) continue;
      if (d > endDate) total += +l.installment || 0;
    }
  }
  return total;
}

/* ----- Harcamalar (tek çekim / taksitli) ----- */

const round2 = v => Math.round(v * 100) / 100;

// Kartlı harcamanın taksitlerini ekstre kesim tarihine göre ödeme aylarına dağıtır.
// Kesim gününe kadar yapılan harcama o ayın ekstresine, sonrası bir sonraki ekstreye girer.
function purchaseSchedule(p) {
  const c = state.cards.find(x => x.id === p.cardId), d = parseD(p.date);
  if (!c || !d) return [];
  let cut = dateAt(d.getFullYear(), d.getMonth(), +c.cutDay);
  if (cut < d) cut = dateAt(d.getFullYear(), d.getMonth() + 1, +c.cutDay);
  const due = dueAfter(c, cut), n = Math.max(1, Math.floor(+p.installments || 1)), total = +p.amount || 0;
  const base = Math.floor(total / n * 100) / 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    const dd = dateAt(due.getFullYear(), due.getMonth() + i, +c.dueDay);
    out.push({ mk: mkey(dd), date: dd, i, n, amount: i === n - 1 ? round2(total - base * (n - 1)) : base });
  }
  return out;
}

const cardPurchases = c => state.purchases.filter(p => p.cardId === c.id);

// Kartın ay ay ödeme planı: elle girilen tutar + harcama taksitleri
function cardPlan(c) {
  const map = {};
  const slot = mk => (map[mk] = map[mk] || { manual: 0, purchases: 0, items: [] });
  for (const [mk, v] of Object.entries(c.schedule || {})) slot(mk).manual += +v || 0;
  for (const p of cardPurchases(c)) {
    for (const s of purchaseSchedule(p)) {
      const e = slot(s.mk);
      e.purchases = round2(e.purchases + s.amount);
      e.items.push({ name: p.name, amount: s.amount, i: s.i, n: s.n });
    }
  }
  for (const e of Object.values(map)) e.total = round2(e.manual + e.purchases);
  return map;
}

const hasPlan = c => (!!c.schedule && Object.keys(c.schedule).length > 0) || cardPurchases(c).length > 0;

// Harcama silinir/değişirse, henüz ödenmemiş taksitleri kart borcundan geri al
function removePurchaseEffect(p) {
  const c = state.cards.find(x => x.id === p.cardId);
  if (!c) return;
  const key = 'card:' + c.id;
  const unpaid = sum(purchaseSchedule(p).filter(s => !(key in (state.paid[s.mk] || {}))).map(s => s.amount));
  c.balance = round2(Math.max(0, (+c.balance || 0) - unpaid));
}
function applyPurchaseEffect(p) {
  const c = state.cards.find(x => x.id === p.cardId);
  if (c) c.balance = round2((+c.balance || 0) + (+p.amount || 0));
}

// Kartsız (nakit / banka kartı) harcamaların ay toplamı
function cashSpend(y, m) {
  const b = new Date(y, m, 1);
  return sum(state.purchases.filter(p => {
    if (p.cardId) return false;
    const d = parseD(p.date);
    return d && d.getFullYear() === b.getFullYear() && d.getMonth() === b.getMonth();
  }).map(p => p.amount));
}

function cardThisMonth(c) {
  const t = today(), o = obligations(t.getFullYear(), t.getMonth()).find(x => x.key === 'card:' + c.id);
  return o ? o : null;
}

// Belirli bir aydaki tüm ödeme yükümlülükleri
function obligations(y, m) {
  const b = new Date(y, m, 1); y = b.getFullYear(); m = b.getMonth();
  const out = [];
  const t = today(), off = (y - t.getFullYear()) * 12 + (m - t.getMonth());
  for (const c of state.cards) {
    // Aylık ödenecek tutar her ay ödemelere eklenir; ileriki aylarda toplam borç bittiğinde durur.
    // Ödendi işaretlenen ödemeler toplam borçtan zaten düşülmüştür, o yüzden yalnızca ödenmemiş aylar sayılır.
    const key = 'card:' + c.id, pay = +c.monthlyPayment || 0, d = dateAt(y, m, +c.dueDay);
    const stored = paidAmount(d, key);
    const plan = hasPlan(c) ? cardPlan(c) : null;
    let amount;
    if (stored !== undefined) amount = stored === true ? pay : stored;
    else if (plan) {
      // Ay ay plan veya harcama varsa yalnızca plandaki tutarlar (elle girilen + taksitler) kullanılır
      amount = plan[mkey(d)] ? plan[mkey(d)].total : 0;
      if (amount <= 0) continue;
    }
    else if (off < 0) amount = pay;
    else {
      let unpaidBefore = 0;
      for (let k = 0; k < off; k++) {
        if (paidAmount(dateAt(t.getFullYear(), t.getMonth() + k, +c.dueDay), key) === undefined) unpaidBefore++;
      }
      amount = Math.min(pay, Math.max((+c.balance || 0) - pay * unpaidBefore, 0));
      if (amount <= 0) continue;
    }
    out.push({ key, type: 'card', name: c.name, sub: c.bank, date: d, amount, min: off === 0 ? +c.minPayment || 0 : null });
  }
  for (const l of state.loans) {
    const f = parseD(l.firstDate); if (!f) continue;
    const i = (y - f.getFullYear()) * 12 + (m - f.getMonth());
    if (i >= 0 && i < +l.term) {
      out.push({ key: 'loan:' + l.id, type: 'loan', name: l.name, sub: `${l.bank ? l.bank + ' · ' : ''}Taksit ${i + 1}/${l.term}`, date: dateAt(y, m, f.getDate()), amount: +l.installment || 0 });
    }
  }
  for (const e of state.expenses) {
    out.push({ key: 'exp:' + e.id, type: 'exp', name: e.name, sub: e.category, date: dateAt(y, m, +e.day || 1), amount: +e.amount || 0 });
  }
  out.forEach(o => { o.paid = isPaid(o.date, o.key); });
  return out.sort((a, b) => a.date - b.date);
}

function incomesFor(y, m) {
  const b = new Date(y, m, 1); y = b.getFullYear(); m = b.getMonth();
  const out = [];
  for (const i of state.incomes) {
    if (i.type === 'once') {
      const d = parseD(i.date);
      if (d && d.getFullYear() === y && d.getMonth() === m) out.push({ ...i, d });
    } else {
      out.push({ ...i, d: dateAt(y, m, +i.day || 1) });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

function status(o) {
  if (o.paid) return ['good', '✓', 'Ödendi'];
  const n = dayDiff(today(), o.date);
  if (n < 0) return ['critical', '!', 'Gecikti'];
  if (n === 0) return ['warning', '!', 'Bugün'];
  if (n <= 3) return ['warning', '!', n + ' gün kaldı'];
  return ['neutral', '•', n + ' gün kaldı'];
}
const badge = ([cls, icon, text]) => `<span class="badge ${cls}"><i>${icon}</i>${text}</span>`;

/* ---------------- Charts (SVG) ---------------- */

const chartJobs = [];

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (s * p >= v) return s * p;
  return 10 * p;
}

function roundTop(x, y, w, h, r) {
  if (h <= 0.5) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function gridLines(W, M, ih, max) {
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const yy = M.t + ih - ih * i / 4;
    g += `<line class="${i ? 'grid-line' : 'base-line'}" x1="${M.l}" x2="${W - M.r}" y1="${yy}" y2="${yy}"/>`;
    g += `<text class="tick" x="${M.l - 8}" y="${yy}" dy="0.32em" text-anchor="end">${compact(max * i / 4)}</text>`;
  }
  return g;
}

function showTip(e, html) {
  const t = $('#tip');
  t.innerHTML = html; t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
const hideTip = () => { $('#tip').hidden = true; };
const tipRow = (color, name, value) => `<div class="tr"><i style="background:var(${color})"></i>${esc(name)}<span>${value}</span></div>`;

// Gruplu sütun grafiği
function barChart(el, cats, series) {
  const W = Math.max(el.clientWidth, 280), H = 260;
  const M = { t: 12, r: 8, b: 26, l: 58 }, iw = W - M.l - M.r, ih = H - M.t - M.b;
  const max = niceMax(Math.max(0, ...series.flatMap(s => s.values)));
  const n = series.length, gw = iw / cats.length;
  const bw = Math.max(6, Math.min(26, (gw * 0.62 - (n - 1) * 2) / n)), tw = n * bw + (n - 1) * 2;
  let g = gridLines(W, M, ih, max);
  cats.forEach((c, ci) => {
    const x0 = M.l + ci * gw + (gw - tw) / 2;
    series.forEach((s, si) => {
      const h = ih * s.values[ci] / max;
      g += `<path fill="var(${s.color})" d="${roundTop(x0 + si * (bw + 2), M.t + ih - h, bw, h, 4)}"/>`;
    });
    g += `<text class="tick" x="${M.l + ci * gw + gw / 2}" y="${H - 6}" text-anchor="middle">${esc(c)}</text>`;
  });
  cats.forEach((c, ci) => { g += `<rect class="hit" data-i="${ci}" x="${M.l + ci * gw}" y="${M.t}" width="${gw}" height="${ih}"/>`; });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Gelir ve ödemeler grafiği">${g}</svg>`;
  el.querySelectorAll('.hit').forEach(r => {
    r.addEventListener('mousemove', e => {
      const i = +r.dataset.i;
      showTip(e, `<b>${esc(cats[i])}</b>` + series.map(s => tipRow(s.color, s.name, money0(s.values[i]))).join(''));
    });
    r.addEventListener('mouseleave', hideTip);
  });
}

// Alanlı çizgi grafiği (crosshair + tooltip)
function lineChart(el, labels, values, color, name) {
  const W = Math.max(el.clientWidth, 280), H = 240;
  const M = { t: 14, r: 18, b: 26, l: 58 }, iw = W - M.l - M.r, ih = H - M.t - M.b;
  const max = niceMax(Math.max(0, ...values)), n = values.length;
  const x = i => M.l + (n > 1 ? iw * i / (n - 1) : iw / 2);
  const y = v => M.t + ih - ih * v / max;
  let g = gridLines(W, M, ih, max);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  g += `<path d="${line}L${x(n - 1)},${M.t + ih}L${x(0)},${M.t + ih}Z" fill="var(${color})" fill-opacity=".12"/>`;
  g += `<path d="${line}" fill="none" stroke="var(${color})" stroke-width="2" stroke-linejoin="round"/>`;
  const step = Math.ceil(n / Math.max(2, Math.floor(iw / 64)));
  labels.forEach((l, i) => { if (i % step === 0) g += `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`; });
  g += `<circle cx="${x(0)}" cy="${y(values[0])}" r="4" fill="var(${color})" stroke="var(--surface)" stroke-width="2"/>`;
  g += `<text class="dlabel" x="${x(0) + 8}" y="${y(values[0]) - 8}">${money0(values[0])}</text>`;
  g += `<line class="xh" x1="0" x2="0" y1="${M.t}" y2="${M.t + ih}" stroke="var(--axis)" visibility="hidden"/>`;
  g += `<circle class="xd" r="5" fill="var(${color})" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>`;
  g += `<rect class="hit" x="${M.l}" y="${M.t}" width="${iw}" height="${ih}" style="fill:transparent"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(name)}">${g}</svg>`;
  const svg = el.querySelector('svg'), xh = el.querySelector('.xh'), xd = el.querySelector('.xd'), hit = el.querySelector('.hit');
  hit.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), px = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - M.l) / iw * (n - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', x(i)); xd.setAttribute('cy', y(values[i])); xd.setAttribute('visibility', 'visible');
    showTip(e, `<b>${esc(labels[i])}</b>` + tipRow(color, name, money0(values[i])));
  });
  hit.addEventListener('mouseleave', () => { hideTip(); xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); });
}

/* ---------------- Views ---------------- */

const pageHead = (title, desc, right = '') =>
  `<div class="page-head"><div><h1>${title}</h1><p>${desc}</p></div><div>${right}</div></div>`;

const emptyBox = (title, text, btn) =>
  `<div class="panel empty"><h3>${title}</h3><p>${text}</p><div class="btns">${btn || ''}</div></div>`;

function vDashboard() {
  const t = today(), y = t.getFullYear(), m = t.getMonth();
  const hasData = state.incomes.length + state.cards.length + state.loans.length + state.expenses.length + state.purchases.length > 0;
  const head = pageHead('Genel Bakış', `${t.getDate()} ${MONL[m]} ${y} itibarıyla finansal durumun`);
  if (!hasData) {
    return head + emptyBox('Henüz veri yok',
      'Gelirlerini, kredi kartlarını, kredilerini ve sabit giderlerini ekleyerek başla. İstersen örnek verilerle uygulamayı keşfedebilirsin.',
      `<button class="btn primary" data-act="demo">Örnek verileri yükle</button><button class="btn" data-view="incomes">Gelir ekle</button>`);
  }

  const income = sum(incomesFor(y, m).map(i => i.amount));
  const ob = obligations(y, m);
  const obTotal = sum(ob.map(o => o.amount));
  const obLeft = sum(ob.filter(o => !o.paid).map(o => o.amount));
  const cash = cashSpend(y, m);
  const net = income - obTotal - cash;
  const cards = state.cards.map(cardInfo);
  const debt = sum(cards.map(c => c.used)), limit = sum(cards.map(c => c.limit));
  const loanRem = sum(state.loans.map(l => loanInfo(l).remaining));
  const loanMonthly = sum(ob.filter(o => o.type === 'loan').map(o => o.amount));

  const kpi = (label, value, sub, cls = '') =>
    `<div class="panel kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;

  // Yaklaşan ödemeler: bugünden itibaren 30 gün
  const horizon = new Date(t); horizon.setDate(horizon.getDate() + 30);
  const upcoming = [...obligations(y, m), ...obligations(y, m + 1)]
    .filter(o => !o.paid && o.amount !== null && o.amount > 0 && o.date <= horizon && (o.date >= t || o.date.getMonth() === m))
    .sort((a, b) => a.date - b.date);

  const dist = [
    { name: 'Kredi kartları', color: '--s1', v: sum(ob.filter(o => o.type === 'card').map(o => o.amount)) },
    { name: 'Kredi taksitleri', color: '--s2', v: loanMonthly },
    { name: 'Sabit giderler', color: '--s3', v: sum(ob.filter(o => o.type === 'exp').map(o => o.amount)) },
  ];

  // 6 aylık nakit akışı
  const cats = [], incV = [], obV = [];
  for (let k = 0; k < 6; k++) {
    const d = new Date(y, m + k, 1);
    cats.push(MON[d.getMonth()] + (d.getMonth() === 0 || k === 0 ? ' ' + String(d.getFullYear()).slice(2) : ''));
    incV.push(sum(incomesFor(y, m + k).map(i => i.amount)));
    obV.push(sum(obligations(y, m + k).map(o => o.amount)) + cashSpend(y, m + k));
  }
  chartJobs.push(() => barChart($('#ch-flow'), cats, [
    { name: 'Gelir', color: '--s1', values: incV },
    { name: 'Ödemeler', color: '--s2', values: obV },
  ]));

  // 12 aylık kredi borcu projeksiyonu
  if (state.loans.length) {
    const labels = ['Bugün'], vals = [loanRem];
    for (let k = 1; k <= 12; k++) {
      const end = new Date(y, m + k + 1, 0);
      labels.push(MON[end.getMonth()] + ' ' + String(end.getFullYear()).slice(2));
      vals.push(loanRemainingAfter(end));
    }
    chartJobs.push(() => lineChart($('#ch-loan'), labels, vals, '--s2', 'Kalan kredi borcu'));
  }

  return head + `
  <div class="grid kpis six">
    ${kpi(`${MONL[m]} geliri`, money0(income), `${incomesFor(y, m).length} gelir kalemi`)}
    ${kpi(`${MONL[m]} ödemeleri`, money0(obTotal), `Kalan: <b>${money0(obLeft)}</b>`)}
    ${kpi('Net nakit (bu ay)', (net >= 0 ? '+' : '') + money0(net), cash > 0 ? `Nakit harcama ${money0(cash)} dahil` : (net >= 0 ? 'Gelir ödemeleri karşılıyor' : 'Ödemeler geliri aşıyor'), net >= 0 ? 'pos' : 'neg')}
    ${kpi('Kart borcu', money0(debt), limit ? `Limit kullanımı ${pct(debt / limit)}` : 'Kart eklenmedi')}
    ${kpi('Kullanılabilir limit', money0(Math.max(limit - debt, 0)), `Toplam limit ${money0(limit)}`)}
    ${kpi('Kalan kredi borcu', money0(loanRem), `Aylık taksit ${money0(loanMonthly)}`)}
  </div>
  <div class="grid dash">
    <div class="panel span-8">
      <div class="panel-head">
        <div><h2>Gelir ve ödemeler</h2><div class="panel-sub">Önümüzdeki 6 ay · kart taksitleri ve nakit harcamalar dahil</div></div>
        <div class="legend"><span><i style="background:var(--s1)"></i>Gelir</span><span><i style="background:var(--s2)"></i>Ödemeler</span></div>
      </div>
      <div class="chart" id="ch-flow"></div>
    </div>
    <div class="panel span-4">
      <div class="panel-head"><div><h2>Bu ayın ödeme dağılımı</h2><div class="panel-sub">Toplam ${money0(obTotal)}</div></div></div>
      ${obTotal > 0 ? `<div class="stack">${dist.filter(d => d.v > 0).map(d => `<div style="flex:${d.v};background:var(${d.color})" title="${d.name}: ${money0(d.v)}"></div>`).join('')}</div>` : ''}
      ${dist.map(d => `<div class="dist-row"><i style="background:var(${d.color})"></i>${d.name}<span class="v">${money0(d.v)}</span><span class="p">${obTotal ? pct(d.v / obTotal) : '–'}</span></div>`).join('')}
      <div class="dist-row"><span>Gelire oranı</span><span class="v">${income ? pct(obTotal / income) : '–'}</span><span class="p"></span></div>
    </div>
    <div class="panel span-6">
      <div class="panel-head"><div><h2>Yaklaşan ödemeler</h2><div class="panel-sub">Önümüzdeki 30 gün · ödenmemiş</div></div>
        <button class="btn sm" data-view="calendar">Takvim →</button></div>
      ${upcoming.length ? upcoming.slice(0, 8).map(o => `
        <div class="up-row">
          <div class="date-chip"><b>${o.date.getDate()}</b><small>${MON[o.date.getMonth()]}</small></div>
          <div class="name"><div>${esc(o.name)}</div><small>${TYPE_LABEL[o.type]}${o.sub ? ' · ' + esc(o.sub) : ''}</small></div>
          <div class="amt">${money(o.amount)}<div>${badge(status(o))}</div></div>
        </div>`).join('') : '<p class="muted-note">Önümüzdeki 30 gün içinde ödenmemiş ödeme yok.</p>'}
    </div>
    <div class="panel span-6">
      <div class="panel-head"><div><h2>Kart limit kullanımı</h2><div class="panel-sub">Güncel borç / limit</div></div>
        <button class="btn sm" data-view="cards">Kartlar →</button></div>
      ${cards.length ? state.cards.map((c, i) => utilRow(c, cards[i])).join('') : '<p class="muted-note">Henüz kart eklenmedi.</p>'}
    </div>
    ${state.loans.length ? `
    <div class="panel span-12">
      <div class="panel-head"><div><h2>Kredi borcu projeksiyonu</h2><div class="panel-sub">Önümüzdeki 12 ayın sonunda kalan toplam kredi borcu</div></div></div>
      <div class="chart" id="ch-loan"></div>
    </div>` : ''}
  </div>`;
}

function utilRow(c, ci) {
  const high = ci.util >= 0.8;
  return `<div class="util-row">
    <div class="util-top"><span><b>${esc(c.name)}</b> <span class="muted">${esc(c.bank || '')}</span></span>
      <span>${money0(ci.used)} <span class="muted">/ ${money0(ci.limit)}</span> · <b>${pct(ci.util)}</b>
      ${high ? badge(['critical', '!', 'Yüksek']) : ''}</span></div>
    <div class="meter"><div style="width:${Math.min(ci.util, 1) * 100}%"></div></div>
  </div>`;
}

function vCalendar() {
  const t = today(), b = new Date(t.getFullYear(), t.getMonth() + calOffset, 1);
  const y = b.getFullYear(), m = b.getMonth();
  const ob = obligations(y, m), inc = incomesFor(y, m);
  const total = sum(ob.map(o => o.amount)), paid = sum(ob.filter(o => o.paid).map(o => o.amount));
  const income = sum(inc.map(i => i.amount));
  const cash = cashSpend(y, m), net = income - total - cash;
  const nav = `<div class="month-nav">
      <button class="btn sm" data-act="cal" data-d="-1">←</button>
      <strong>${MONL[m]} ${y}</strong>
      <button class="btn sm" data-act="cal" data-d="1">→</button>
      ${calOffset ? '<button class="btn sm" data-act="cal" data-d="0">Bu ay</button>' : ''}
    </div>`;
  const kpi = (label, value, cls = '') => `<div class="panel kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div></div>`;
  return pageHead('Ödeme Takvimi', 'Aylık ödemelerini gör, ödediklerini işaretle', nav) + `
  <div class="grid kpis six">
    ${kpi('Toplam ödeme', money0(total))}
    ${kpi('Ödenen', money0(paid), 'pos')}
    ${kpi('Kalan', money0(total - paid), total - paid > 0 ? 'neg' : '')}
    ${kpi('Gelir', money0(income))}
    ${kpi('Nakit harcama', money0(cash))}
    ${kpi('Net', (net >= 0 ? '+' : '') + money0(net), net >= 0 ? 'pos' : 'neg')}
  </div>
  <div class="panel">
    ${ob.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Tarih</th><th>Ödeme</th><th>Tür</th><th class="num">Tutar</th><th class="num">Asgari</th><th>Durum</th><th>Ödendi</th></tr></thead>
      <tbody>${ob.map(o => `<tr class="${o.paid ? 'is-paid' : ''}">
        <td>${fmtDs(o.date)}</td>
        <td><b>${esc(o.name)}</b><span class="sub">${esc(o.sub || '')}</span></td>
        <td>${TYPE_LABEL[o.type]}</td>
        <td class="num">${o.amount === null ? '<span title="Bu dönemin ekstresi bilinmiyor">—</span>' : money(o.amount)}</td>
        <td class="num">${o.min ? money(o.min) : ''}</td>
        <td>${badge(status(o))}</td>
        <td><input type="checkbox" class="check" data-act="pay" data-key="${o.key}" data-month="${mkey(o.date)}" ${o.paid ? 'checked' : ''} aria-label="${esc(o.name)} ödendi"></td>
      </tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">Toplam</td><td class="num">${money(total)}</td><td colspan="3"></td></tr></tfoot>
    </table></div>
    <p class="muted-note">Kredi kartı tutarı, kartta girdiğin <b>aylık ödenecek tutardan</b> gelir ve kartın toplam borcu bitene kadar her ay ödemelere eklenir.</p>`
    : '<p class="muted-note">Bu ay için ödeme yok.</p>'}
  </div>
  ${inc.length ? `<div class="panel" style="margin-top:16px"><div class="panel-head"><h2>Bu ayın gelirleri</h2></div>
    <div class="table-wrap"><table><tbody>${inc.map(i => `<tr><td>${fmtDs(i.d)}</td><td><b>${esc(i.name)}</b></td><td>${i.type === 'once' ? 'Tek seferlik' : 'Düzenli'}</td><td class="num">${money(i.amount)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
}

const addBtn = (list, label) => `<button class="btn primary" data-act="add" data-list="${list}">+ ${label}</button>`;
const rowActions = (list, id) => `<div class="actions">
  <button class="icon-btn" data-act="edit" data-list="${list}" data-id="${id}" title="Düzenle">✎</button>
  <button class="icon-btn" data-act="del" data-list="${list}" data-id="${id}" title="Sil">🗑</button></div>`;

function vIncomes() {
  const t = today(), monthly = sum(state.incomes.filter(i => i.type !== 'once').map(i => i.amount));
  return pageHead('Gelirler', `Düzenli aylık gelir toplamı: <b>${money(monthly)}</b> · Bu ay toplam: <b>${money(sum(incomesFor(t.getFullYear(), t.getMonth()).map(i => i.amount)))}</b>`, addBtn('incomes', 'Gelir ekle')) +
    (state.incomes.length ? `<div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Açıklama</th><th>Tür</th><th>Zaman</th><th class="num">Tutar</th><th></th></tr></thead>
      <tbody>${state.incomes.map(i => `<tr>
        <td><b>${esc(i.name)}</b></td>
        <td>${i.type === 'once' ? 'Tek seferlik' : 'Düzenli (aylık)'}</td>
        <td>${i.type === 'once' ? (i.date ? fmtD(parseD(i.date)) : '—') : 'Her ayın ' + i.day + '. günü'}</td>
        <td class="num">${money(i.amount)}</td><td>${rowActions('incomes', i.id)}</td></tr>`).join('')}</tbody>
    </table></div></div>`
      : emptyBox('Gelir eklenmedi', 'Maaş, kira geliri, ek iş gibi gelirlerini ekle.', addBtn('incomes', 'Gelir ekle')));
}

function vCards() {
  const infos = state.cards.map(cardInfo);
  const debt = sum(infos.map(c => c.used)), limit = sum(infos.map(c => c.limit));
  const thisMonth = state.cards.map(cardThisMonth);
  const monthly = sum(thisMonth.map(o => o ? o.amount : 0));
  return pageHead('Kredi Kartları', `Bu ay ödenecek <b>${money(monthly)}</b> · Toplam borç <b>${money(debt)}</b> · Toplam limit <b>${money(limit)}</b> · Kullanılabilir <b>${money(Math.max(limit - debt, 0))}</b>`, addBtn('cards', 'Kart ekle')) +
    (state.cards.length ? `<div class="grid tiles">${state.cards.map((c, idx) => {
      const ci = infos[idx], o = thisMonth[idx], pay = o ? o.amount : 0;
      const st = ci.duePaid ? ['good', '✓', 'Ödendi'] : status({ date: ci.due, paid: false });
      const s = cardSummary(c);
      return `<div class="panel">
        <div class="ccard clickable" data-act="open-card" data-id="${c.id}" title="Aylık ödemeleri aç">
          <div class="row"><div><div class="bank">${esc(c.bank || 'Banka')}</div><div class="cname">${esc(c.name)}</div></div><div class="chip"></div></div>
          <div>
            <small>Toplam borç</small>
            <div class="big">${money(ci.used)}</div>
            <div class="meter"><div style="width:${Math.min(ci.util, 1) * 100}%"></div></div>
            <div class="row" style="margin-top:6px"><small>Limit ${money0(ci.limit)}</small><small>Kullanım ${pct(ci.util)}</small></div>
          </div>
        </div>
        <div class="pay-box">
          <div><small>${MONL[today().getMonth()]} ödemesi</small><b>${money(pay)}</b>
          <small>${hasPlan(c) ? `${s.months} aylık plan · ${money0(s.planned)} planlandı` : 'Ay ay plan girilmedi'}</small></div>
          <button class="btn sm" data-act="open-card" data-id="${c.id}">Aylık ödemeler →</button>
        </div>
        <div class="facts">
          <div><small>Asgari ödeme</small><b>${money(c.minPayment)}</b></div>
          <div><small>Bu ay ödeme sonrası borç</small><b>${money(o && o.paid ? ci.used : Math.max(ci.used - pay, 0))}</b></div>
          <div><small>Kullanılabilir limit</small><b>${money(ci.avail)}</b></div>
          <div><small>Limit kullanımı</small><b>${pct(ci.util)}</b></div>
          <div><small>Sonraki ekstre kesim</small><b>${fmtD(ci.nextCut)}</b></div>
          <div><small>Son ödeme tarihi</small><b>${fmtD(ci.due)}</b></div>
        </div>
        <div class="tile-foot">${badge(st)}${rowActions('cards', c.id)}</div>
      </div>`;
    }).join('')}</div>`
      : emptyBox('Kredi kartı eklenmedi', 'Kart limitini, borcunu, ekstre kesim ve son ödeme günlerini girerek takibe başla.', addBtn('cards', 'Kart ekle')));
}

// Kartın aylık planının özeti
function cardSummary(c) {
  const key = 'card:' + c.id, plan = cardPlan(c);
  let planned = 0, months = 0, paidTotal = 0;
  for (const [k, v] of Object.entries(plan)) {
    if (!(key in (state.paid[k] || {})) && v.total > 0) { planned += v.total; months++; }
  }
  for (const k in state.paid) { const v = state.paid[k][key]; if (typeof v === 'number') paidTotal += v; }
  const balance = +c.balance || 0;
  return { planned: round2(planned), months, paidTotal, balance, diff: round2(balance - planned) };
}

function cardSummaryHTML(c) {
  const s = cardSummary(c);
  const kpi = (label, value, sub = '', cls = '') => `<div class="panel kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  let check;
  if (!hasPlan(c)) check = badge(['neutral', 'i', 'Henüz plan yok — aşağıdaki aylara tutar yaz']);
  else if (Math.abs(s.diff) < 0.01) check = badge(['good', '✓', 'Plan toplam borçla eşleşiyor']);
  else if (s.diff > 0) check = badge(['warning', '!', `${money(s.diff)} borç henüz bir aya yazılmadı`]);
  else check = badge(['critical', '!', `Plan toplam borçtan ${money(-s.diff)} fazla`]);
  return `<div class="grid kpis">
      ${kpi('Toplam borç', money(s.balance), 'Ödendikçe otomatik düşer')}
      ${kpi('Plandaki ödemeler', money(s.planned), `${s.months} ay · ödenmemiş`)}
      ${kpi('Ödenen', money(s.paidTotal), 'İşaretlenen ödemeler', 'pos')}
    </div>
    <div style="margin:-4px 0 16px">${check}</div>`;
}

// Kartın detay sayfasında gösterilecek aylar
function cardMonths(c) {
  const t = today(), key = 'card:' + c.id;
  const keys = [...Object.keys(cardPlan(c)), ...Object.keys(state.paid).filter(k => key in state.paid[k])].sort();
  const toDate = k => { const [yy, mm] = k.split('-').map(Number); return new Date(yy, mm - 1, 1); };
  let start = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  let end = new Date(t.getFullYear(), t.getMonth() + 11 + cardExtra, 1);
  if (keys.length) {
    const first = toDate(keys[0]), last = toDate(keys[keys.length - 1]);
    if (first < start) start = new Date(Math.max(first, new Date(t.getFullYear(), t.getMonth() - 12, 1)));
    if (last > end) end = last;
  }
  const out = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) out.push(d);
  return out;
}

function schedRowStatus(o) {
  return o.amount > 0 || o.paid ? badge(status(o)) : '<span class="muted-note" style="margin:0">—</span>';
}

function vCardDetail() {
  const c = state.cards.find(x => x.id === cardId);
  if (!c) { view = 'cards'; return vCards(); }
  const ci = cardInfo(c), key = 'card:' + c.id, t = today(), plan = cardPlan(c);
  const rows = cardMonths(c).map(m0 => {
    const mk = mkey(m0), due = dateAt(m0.getFullYear(), m0.getMonth(), +c.dueDay);
    const stored = paidAmount(due, key), paid = stored !== undefined;
    const e = plan[mk] || { manual: 0, purchases: 0, total: 0, items: [] };
    const manual = (c.schedule || {})[mk] ?? '';
    const total = paid && typeof stored === 'number' ? stored : e.total;
    const isNow = m0.getFullYear() === t.getFullYear() && m0.getMonth() === t.getMonth();
    const tipText = e.items.map(it => `${it.name}${it.n > 1 ? ` (${it.i + 1}/${it.n})` : ''}: ${money(it.amount)}`).join('\n');
    return `<tr class="${paid ? 'is-paid' : ''} ${isNow ? 'is-now' : ''}" data-month="${mk}">
      <td><b>${MONL[m0.getMonth()]} ${m0.getFullYear()}</b>${isNow ? '<span class="tag">bu ay</span>' : ''}<span class="sub">Son ödeme ${fmtDs(due)}</span></td>
      <td class="num"><input class="sched-input" type="number" min="0" step="0.01" placeholder="0,00" value="${manual}"
        data-id="${c.id}" data-month="${mk}" data-purchases="${e.purchases}" ${paid ? 'disabled title="Tutarı değiştirmek için önce ödendi işaretini kaldır"' : ''} aria-label="${MONL[m0.getMonth()]} elle girilen tutar"></td>
      <td class="num">${e.purchases > 0 ? `<span class="has-tip" title="${esc(tipText)}">${money(e.purchases)}<span class="sub">${e.items.length} harcama</span></span>` : '<span class="muted-note">—</span>'}</td>
      <td class="num tot"><b>${total > 0 ? money(total) : '—'}</b></td>
      <td class="st">${schedRowStatus({ date: due, paid, amount: total })}</td>
      <td><input type="checkbox" class="check" data-act="pay" data-key="${key}" data-month="${mk}" ${paid ? 'checked' : ''} ${!paid && !(total > 0) ? 'disabled' : ''} aria-label="${MONL[m0.getMonth()]} ödendi"></td>
    </tr>`;
  }).join('');
  const purchases = cardPurchases(c).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return pageHead(esc(c.name), `${esc(c.bank || '')} · Aylık ödemelerini ay ay gir, ödedikçe işaretle`,
    `<div class="actions"><button class="btn" data-view="cards">← Kartlar</button><button class="btn" data-act="edit" data-list="cards" data-id="${c.id}">Kartı düzenle</button><button class="btn primary" data-act="add" data-list="purchases" data-card="${c.id}">+ Harcama ekle</button></div>`) + `
  <div id="card-summary">${cardSummaryHTML(c)}</div>
  <div class="grid dash">
    <div class="span-4">
      <div class="ccard">
        <div class="row"><div><div class="bank">${esc(c.bank || 'Banka')}</div><div class="cname">${esc(c.name)}</div></div><div class="chip"></div></div>
        <div>
          <small>Toplam borç</small>
          <div class="big">${money(ci.used)}</div>
          <div class="meter"><div style="width:${Math.min(ci.util, 1) * 100}%"></div></div>
          <div class="row" style="margin-top:6px"><small>Limit ${money0(ci.limit)}</small><small>Kullanım ${pct(ci.util)}</small></div>
        </div>
      </div>
      <div class="panel facts" style="grid-template-columns:1fr 1fr">
        <div><small>Kullanılabilir limit</small><b>${money(ci.avail)}</b></div>
        <div><small>Asgari ödeme</small><b>${money(c.minPayment)}</b></div>
        <div><small>Ekstre kesim günü</small><b>Her ayın ${c.cutDay}.</b></div>
        <div><small>Son ödeme günü</small><b>Her ayın ${c.dueDay}.</b></div>
      </div>
      <div class="panel" style="margin-top:16px">
        <div class="panel-head"><div><h2>Bu karttaki harcamalar</h2><div class="panel-sub">${purchases.length} harcama · ${money(sum(purchases.map(p => p.amount)))}</div></div></div>
        ${purchases.length ? purchases.slice(0, 12).map(p => {
          const n = Math.max(1, +p.installments || 1), sch = purchaseSchedule(p);
          return `<div class="up-row">
            <div class="name"><div><b>${esc(p.name)}</b></div><small>${fmtDs(parseD(p.date))} · ${n > 1 ? `${n} taksit · ilk ödeme ${MON[sch[0].date.getMonth()]}` : `Tek çekim · ${MON[sch[0].date.getMonth()]} ödemesine`}</small></div>
            <div class="amt">${money(p.amount)}${n > 1 ? `<small class="sub">${n} × ${money(sch[0].amount)}</small>` : ''}</div>
            ${rowActions('purchases', p.id)}
          </div>`;
        }).join('') : '<p class="muted-note">Henüz harcama yok. “+ Harcama ekle” ile tek çekim veya taksitli harcama gir.</p>'}
      </div>
    </div>
    <div class="panel span-8">
      <div class="panel-head"><div><h2>Aylık ödemeler</h2>
        <div class="panel-sub">Harcama taksitleri ekstre kesim tarihine göre aylara otomatik dağıtılır. “Elle” sütununa önceki borcunu ya da ek tutar yazabilirsin; “Ödendi” işaretlenince toplam borçtan düşer.</div></div></div>
      <div class="table-wrap"><table class="sched">
        <thead><tr><th>Ay</th><th class="num">Elle girilen</th><th class="num">Harcamalar</th><th class="num">Toplam</th><th>Durum</th><th>Ödendi</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn sm" data-act="more-months">+ 6 ay daha göster</button></div>
    </div>
  </div>`;
}

function vLoans() {
  const infos = state.loans.map(loanInfo);
  return pageHead('Krediler', `Kalan toplam borç <b>${money(sum(infos.map(i => i.remaining)))}</b> · Aylık taksit toplamı <b>${money(sum(state.loans.filter((l, i) => infos[i].left > 0).map(l => l.installment)))}</b>`, addBtn('loans', 'Kredi ekle')) +
    (state.loans.length ? `<div class="grid tiles">${state.loans.map((l, idx) => {
      const li = infos[idx];
      return `<div class="panel">
        <div class="panel-head"><div><h2>${esc(l.name)}</h2><div class="panel-sub">${esc(l.bank || '')}${l.rate ? ' · Aylık faiz %' + esc(l.rate) : ''}</div></div>
          ${li.left === 0 ? badge(['good', '✓', 'Kapandı']) : ''}</div>
        <div class="util-top"><span>${li.paid}/${l.term} taksit ödendi</span><b>${pct(li.progress)}</b></div>
        <div class="meter" style="margin-bottom:16px"><div style="width:${li.progress * 100}%;background:var(--s2)"></div></div>
        <div class="facts">
          <div><small>Aylık taksit</small><b>${money(l.installment)}</b></div>
          <div><small>Kalan borç</small><b>${money(li.remaining)}</b></div>
          <div><small>Çekilen tutar</small><b>${money(l.principal)}</b></div>
          <div><small>Toplam geri ödeme</small><b>${money(li.totalCost)}</b></div>
          <div><small>Sonraki taksit</small><b>${li.next ? fmtD(li.next.d) : '—'}</b></div>
          <div><small>Bitiş tarihi</small><b>${li.end ? fmtD(li.end) : '—'}</b></div>
        </div>
        <div class="tile-foot"><span class="muted-note" style="margin:0">Faiz yükü: ${money(Math.max(li.totalCost - (+l.principal || 0), 0))}</span>${rowActions('loans', l.id)}</div>
      </div>`;
    }).join('')}</div>`
      : emptyBox('Kredi eklenmedi', 'İhtiyaç, taşıt veya konut kredilerini ekleyerek kalan borç ve taksitlerini takip et.', addBtn('loans', 'Kredi ekle')));
}

function vExpenses() {
  return pageHead('Sabit Giderler', `Aylık toplam: <b>${money(sum(state.expenses.map(e => e.amount)))}</b>`, addBtn('expenses', 'Gider ekle')) +
    (state.expenses.length ? `<div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>Gider</th><th>Kategori</th><th>Ödeme günü</th><th class="num">Tutar</th><th></th></tr></thead>
      <tbody>${[...state.expenses].sort((a, b) => a.day - b.day).map(e => `<tr>
        <td><b>${esc(e.name)}</b></td><td>${esc(e.category)}</td><td>Her ayın ${e.day}. günü</td>
        <td class="num">${money(e.amount)}</td><td>${rowActions('expenses', e.id)}</td></tr>`).join('')}</tbody>
    </table></div></div>`
      : emptyBox('Sabit gider eklenmedi', 'Kira, faturalar, abonelikler ve sigorta gibi her ay tekrarlanan ödemeleri ekle.', addBtn('expenses', 'Gider ekle')));
}

const SPEND_CATS = ['Market', 'Yeme-içme', 'Ulaşım', 'Akaryakıt', 'Giyim', 'Elektronik', 'Ev', 'Sağlık', 'Eğlence', 'Eğitim', 'Seyahat', 'Diğer'];

function vPurchases() {
  const t = today(), b = new Date(t.getFullYear(), t.getMonth() + spendOffset, 1);
  const y = b.getFullYear(), m = b.getMonth();
  const list = state.purchases.filter(p => {
    const d = parseD(p.date);
    return d && d.getFullYear() === y && d.getMonth() === m;
  }).sort((a, c) => (c.date || '').localeCompare(a.date || ''));
  const total = sum(list.map(p => p.amount));
  const onCard = sum(list.filter(p => p.cardId).map(p => p.amount));
  const cats = SPEND_CATS.map(name => ({ name, v: sum(list.filter(p => (p.category || 'Diğer') === name).map(p => p.amount)) }))
    .filter(x => x.v > 0).sort((a, c) => c.v - a.v);
  const maxCat = cats.length ? cats[0].v : 1;
  const cardName = id => { const c = state.cards.find(x => x.id === id); return c ? c.name : 'Silinmiş kart'; };
  const kpi = (label, value, sub = '') => `<div class="panel kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
  const nav = `<div class="month-nav">
      <button class="btn sm" data-act="spend-month" data-d="-1">←</button>
      <strong>${MONL[m]} ${y}</strong>
      <button class="btn sm" data-act="spend-month" data-d="1">→</button>
      ${spendOffset ? '<button class="btn sm" data-act="spend-month" data-d="0">Bu ay</button>' : ''}
      <button class="btn primary" data-act="add" data-list="purchases">+ Harcama ekle</button>
    </div>`;

  return pageHead('Harcamalar', 'Günlük ve kredi kartı harcamaların · taksitler kartın ödeme planına otomatik dağıtılır', nav) + `
  <div class="grid kpis">
    ${kpi('Toplam harcama', money0(total), `${list.length} işlem`)}
    ${kpi('Kredi kartıyla', money0(onCard), 'Kart limitinden düşüldü')}
    ${kpi('Nakit / banka kartı', money0(total - onCard), 'Bu ayın nakit akışından düşer')}
    ${kpi('Günlük ortalama', money0(total / (spendOffset === 0 ? t.getDate() : daysIn(y, m))), spendOffset === 0 ? 'Ay başından bugüne' : 'Ay geneli')}
  </div>
  <div class="grid dash">
    <div class="panel span-8">
      <div class="panel-head"><div><h2>${MONL[m]} harcamaları</h2><div class="panel-sub">Harcama tarihine göre</div></div></div>
      ${list.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Tarih</th><th>Açıklama</th><th>Ödeme şekli</th><th>Taksit</th><th class="num">Tutar</th><th></th></tr></thead>
        <tbody>${list.map(p => {
          const n = Math.max(1, +p.installments || 1), sch = p.cardId ? purchaseSchedule(p) : [];
          return `<tr>
            <td>${fmtDs(parseD(p.date))}</td>
            <td><b>${esc(p.name)}</b><span class="sub">${esc(p.category || 'Diğer')}</span></td>
            <td>${p.cardId ? `<a href="#" class="link" data-act="open-card" data-id="${p.cardId}">${esc(cardName(p.cardId))}</a>` : 'Nakit / banka kartı'}</td>
            <td>${p.cardId ? (n > 1 ? `${n} × ${money(sch[0] ? sch[0].amount : p.amount / n)}` : 'Tek çekim') + (sch[0] ? `<span class="sub">İlk ödeme ${fmtDs(sch[0].date)}</span>` : '') : '—'}</td>
            <td class="num">${money(p.amount)}</td>
            <td>${rowActions('purchases', p.id)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : '<p class="muted-note">Bu ay harcama girilmedi.</p>'}
    </div>
    <div class="panel span-4">
      <div class="panel-head"><div><h2>Kategoriye göre</h2><div class="panel-sub">${MONL[m]} ${y}</div></div></div>
      ${cats.length ? cats.map(x => `<div class="util-row">
        <div class="util-top"><span>${esc(x.name)}</span><span><b>${money0(x.v)}</b> <span class="muted">${pct(x.v / total)}</span></span></div>
        <div class="meter"><div style="width:${x.v / maxCat * 100}%"></div></div>
      </div>`).join('') : '<p class="muted-note">Veri yok.</p>'}
    </div>
  </div>`;
}

function vSettings() {
  return pageHead('Ayarlar', 'Hesap, veri yedekleme, şablon ve görünüm') + `
  <div class="grid settings">
    ${typeof Sync !== 'undefined' ? Sync.accountHTML() : ''}
    <div class="panel"><h2>Yedekle</h2><p>Tüm verilerini JSON dosyası olarak indir. Eşitleme açık olsa da ara sıra yedek almak iyi bir alışkanlıktır.</p>
      <div class="btns"><button class="btn primary" data-act="export">Dışa aktar (.json)</button><button class="btn" data-act="import">İçe aktar</button></div></div>
    <div class="panel"><h2>Şablon / örnek veri</h2><p>Uygulamayı denemek için örnek gelir, kart, kredi ve gider verilerini yükle. Mevcut verilerin silinir.</p>
      <div class="btns"><button class="btn" data-act="demo">Örnek verileri yükle</button></div></div>
    <div class="panel"><h2>Görünüm</h2><p>Açık ve koyu tema arasında geçiş yap.</p>
      <div class="btns"><button class="btn" data-act="theme">◐ Tema değiştir</button></div></div>
    <div class="panel"><h2>Tüm verileri sil</h2><p>Bu işlem geri alınamaz. Önce yedek almayı unutma.</p>
      <div class="btns"><button class="btn danger" data-act="reset">Verileri sil</button></div></div>
  </div>`;
}

const VIEWS = { dashboard: vDashboard, calendar: vCalendar, incomes: vIncomes, cards: vCards, card: vCardDetail, purchases: vPurchases, loans: vLoans, expenses: vExpenses, settings: vSettings };

function render() {
  chartJobs.length = 0;
  hideTip();
  $('#main').innerHTML = VIEWS[view]();
  const navView = view === 'card' ? 'cards' : view;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.view === navView));
  chartJobs.forEach(fn => fn());
}

/* ---------------- Forms ---------------- */

const DAY = { t: 'number', min: 1, max: 31, step: 1 };
const MONEY = { t: 'number', min: 0, step: 0.01 };

const FORMS = {
  incomes: {
    title: 'Gelir', fields: [
      { k: 'name', l: 'Açıklama', t: 'text', req: true, ph: 'Maaş, kira geliri…', full: true },
      { k: 'amount', l: 'Tutar (₺)', ...MONEY, req: true },
      { k: 'type', l: 'Tür', t: 'select', opts: [['monthly', 'Düzenli (her ay)'], ['once', 'Tek seferlik']], def: 'monthly' },
      { k: 'day', l: 'Yatış günü', ...DAY, def: 1, req: true, when: o => o.type !== 'once' },
      { k: 'date', l: 'Tarih', t: 'date', req: true, when: o => o.type === 'once' },
    ],
  },
  cards: {
    title: 'Kredi Kartı', fields: [
      { k: 'name', l: 'Kart adı', t: 'text', req: true, ph: 'Ör. Bonus Platinum' },
      { k: 'bank', l: 'Banka', t: 'text', ph: 'Ör. Garanti BBVA' },
      { k: 'limit', l: 'Kart limiti (₺)', ...MONEY, req: true },
      { k: 'balance', l: 'Toplam borç (₺)', ...MONEY, req: true, hint: 'Taksitler dahil kartın tüm borcu' },
      { k: 'monthlyPayment', l: 'Varsayılan aylık ödeme (₺)', ...MONEY, def: 0, hint: 'Yalnızca ay ay plan girilmemişse kullanılır' },
      { k: 'minPayment', l: 'Asgari ödeme (₺)', ...MONEY, def: 0, full: true },
      { k: 'cutDay', l: 'Ekstre kesim günü', ...DAY, req: true },
      { k: 'dueDay', l: 'Son ödeme günü', ...DAY, req: true },
    ],
  },
  loans: {
    title: 'Kredi', fields: [
      { k: 'name', l: 'Kredi adı', t: 'text', req: true, ph: 'Ör. İhtiyaç kredisi' },
      { k: 'bank', l: 'Banka', t: 'text' },
      { k: 'principal', l: 'Çekilen tutar (₺)', ...MONEY, req: true },
      { k: 'installment', l: 'Aylık taksit (₺)', ...MONEY, req: true },
      { k: 'term', l: 'Vade (ay)', t: 'number', min: 1, step: 1, req: true },
      { k: 'firstDate', l: 'İlk taksit tarihi', t: 'date', req: true, hint: 'Geçmiş taksitler ödenmiş sayılır' },
      { k: 'rate', l: 'Aylık faiz oranı (%)', t: 'number', min: 0, step: 0.01 },
    ],
  },
  expenses: {
    title: 'Sabit Gider', fields: [
      { k: 'name', l: 'Gider adı', t: 'text', req: true, ph: 'Ör. Kira, elektrik' },
      { k: 'category', l: 'Kategori', t: 'select', opts: ['Kira', 'Fatura', 'Abonelik', 'Sigorta', 'Eğitim', 'Aidat', 'Diğer'].map(x => [x, x]), def: 'Fatura' },
      { k: 'amount', l: 'Aylık tutar (₺)', ...MONEY, req: true },
      { k: 'day', l: 'Ödeme günü', ...DAY, req: true },
    ],
  },
  purchases: {
    title: 'Harcama', fields: [
      { k: 'name', l: 'Açıklama', t: 'text', req: true, ph: 'Ör. Market alışverişi, telefon', full: true },
      { k: 'amount', l: 'Toplam tutar (₺)', ...MONEY, req: true },
      { k: 'date', l: 'Harcama tarihi', t: 'date', req: true, def: () => { const d = today(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; } },
      { k: 'cardId', l: 'Ödeme şekli', t: 'select', opts: () => [...state.cards.map(c => [c.id, `💳 ${c.name}${c.bank ? ' · ' + c.bank : ''}`]), ['', 'Nakit / banka kartı']], def: () => state.cards[0]?.id ?? '' },
      { k: 'installments', l: 'Taksit sayısı', t: 'number', min: 1, max: 36, step: 1, def: 1, req: true, hint: '1 = tek çekim', when: o => !!o.cardId },
      { k: 'category', l: 'Kategori', t: 'select', opts: () => SPEND_CATS.map(x => [x, x]), def: 'Market' },
    ],
    // Taksitlerin hangi aylara düşeceğini canlı gösterir
    preview: o => {
      if (!o.cardId) return o.amount ? 'Nakit harcama: bu ayın nakit akışından düşer, kart borcunu etkilemez.' : '';
      const c = state.cards.find(x => x.id === o.cardId);
      if (!c || !(+o.amount > 0) || !o.date) return '';
      const sch = purchaseSchedule({ cardId: o.cardId, amount: +o.amount, date: o.date, installments: +o.installments || 1 });
      const back = editing.id ? (state.purchases.find(x => x.id === editing.id) || {}) : {};
      const avail = (+c.limit || 0) - (+c.balance || 0) + (back.cardId === c.id ? +back.amount || 0 : 0);
      return `<b>${c.name}</b> kullanılabilir limit: ${money(avail)} → <b>${money(avail - +o.amount)}</b><br>
        Ödeme planı: ${sch.map(s => `${MON[s.date.getMonth()]} ${String(s.date.getFullYear()).slice(2)} <b>${money(s.amount)}</b>`).join(' · ')}`;
    },
  },
};

let editing = null;

function openForm(list, id, preset = {}) {
  const spec = FORMS[list];
  const item = id ? state[list].find(x => x.id === id) : preset;
  editing = { list, id };
  $('#form-title').textContent = (id ? 'Düzenle: ' : 'Yeni ') + spec.title;
  $('#form-fields').innerHTML = spec.fields.map(f => {
    const def = typeof f.def === 'function' ? f.def() : f.def;
    const v = item[f.k] ?? def ?? '';
    const opts = typeof f.opts === 'function' ? f.opts() : f.opts;
    const attrs = ['min', 'max', 'step'].filter(a => f[a] !== undefined).map(a => `${a}="${f[a]}"`).join(' ');
    const input = f.t === 'select'
      ? `<select name="${f.k}">${opts.map(([val, lab]) => `<option value="${esc(val)}" ${String(v) === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`
      : `<input name="${f.k}" type="${f.t}" value="${esc(v)}" ${attrs} ${f.ph ? `placeholder="${esc(f.ph)}"` : ''}>`;
    return `<label data-k="${f.k}" class="${f.full ? 'full' : ''}">${f.l}${input}${f.hint ? `<small>${f.hint}</small>` : ''}</label>`;
  }).join('') + (spec.preview ? '<div id="form-preview" class="form-preview full"></div>' : '');
  syncForm();
  $('#modal').showModal();
  $('#form-fields input')?.focus();
}

function formValues() {
  const o = {};
  new FormData($('#form')).forEach((v, k) => { o[k] = v; });
  return o;
}

function syncForm() {
  const spec = FORMS[editing.list], o = formValues();
  for (const f of spec.fields) {
    const label = $(`#form-fields label[data-k="${f.k}"]`);
    const show = !f.when || f.when(o);
    label.hidden = !show;
    const input = label.querySelector('input,select');
    input.required = !!f.req && show;
    input.disabled = !show;
  }
  if (spec.preview) {
    const html = spec.preview(formValues());
    $('#form-preview').innerHTML = html;
    $('#form-preview').hidden = !html;
  }
}

$('#form').addEventListener('change', syncForm);
$('#form').addEventListener('input', syncForm);
$('#form').addEventListener('submit', e => {
  e.preventDefault();
  const { list, id } = editing;
  const spec = FORMS[list], raw = formValues(), obj = {};
  for (const f of spec.fields) {
    if (!(f.k in raw)) continue;
    obj[f.k] = f.t === 'number' ? (raw[f.k] === '' ? '' : Number(raw[f.k])) : raw[f.k].trim();
  }
  if (list === 'purchases') {
    if (!obj.cardId) obj.installments = 1;
    const old = id ? state.purchases.find(x => x.id === id) : null;
    const c = state.cards.find(x => x.id === obj.cardId);
    if (c) {
      // Aynı karttaki eski harcama düzenleniyorsa onun tutarı limite geri eklenmiş sayılır
      const back = old && old.cardId === c.id ? +old.amount || 0 : 0;
      const avail = (+c.limit || 0) - (+c.balance || 0) + back;
      if (obj.amount > avail && !confirm(`Bu harcama ${c.name} kartının kullanılabilir limitini (${money(avail)}) aşıyor. Yine de kaydedilsin mi?`)) return;
    }
    if (old) { removePurchaseEffect(old); Object.assign(old, obj); applyPurchaseEffect(old); }
    else { const p = { id: uid(), ...obj }; state.purchases.push(p); applyPurchaseEffect(p); }
  }
  else if (id) Object.assign(state[list].find(x => x.id === id), obj);
  else state[list].push({ id: uid(), ...obj });
  $('#modal').close();
  save();
});

/* ---------------- Demo data ---------------- */

function demoData() {
  const t = today(), y = t.getFullYear(), m = t.getMonth();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // Bu aydan başlayarak ay ay ödeme planı
  const plan = amounts => Object.fromEntries(amounts.map((v, k) => [mkey(new Date(y, m + k, 1)), v]));
  const day = k => iso(new Date(y, m, Math.max(1, t.getDate() - k)));
  const data = {
    incomes: [
      { id: uid(), name: 'Maaş', amount: 85000, type: 'monthly', day: 1 },
      { id: uid(), name: 'Kira geliri', amount: 14000, type: 'monthly', day: 5 },
      { id: uid(), name: 'Freelance proje', amount: 22000, type: 'once', date: iso(new Date(y, m + 1, 15)) },
    ],
    cards: [
      { id: uid(), name: 'Bonus Platinum', bank: 'Garanti BBVA', limit: 120000, balance: 46850, monthlyPayment: 0, minPayment: 5000, cutDay: 12, dueDay: 22, schedule: plan([12500, 12500, 11000, 9800, 7550, 6000]) },
      { id: uid(), name: 'World Card', bank: 'Yapı Kredi', limit: 60000, balance: 51300, monthlyPayment: 0, minPayment: 4000, cutDay: 25, dueDay: 5, schedule: plan([9800, 11200, 9500, 8400, 7400, 6200, 4600, 4000]) },
      { id: uid(), name: 'Axess', bank: 'Akbank', limit: 45000, balance: 8400, monthlyPayment: 4200, minPayment: 1680, cutDay: 3, dueDay: 13 },
    ],
    loans: [
      { id: uid(), name: 'İhtiyaç kredisi', bank: 'İş Bankası', principal: 200000, installment: 11250, term: 24, firstDate: iso(new Date(y, m - 7, 10)), rate: 3.49 },
      { id: uid(), name: 'Taşıt kredisi', bank: 'Ziraat Bankası', principal: 450000, installment: 19800, term: 36, firstDate: iso(new Date(y, m - 14, 18)), rate: 2.89 },
    ],
    expenses: [
      { id: uid(), name: 'Ev kirası', category: 'Kira', amount: 22000, day: 3 },
      { id: uid(), name: 'Elektrik', category: 'Fatura', amount: 1250, day: 20 },
      { id: uid(), name: 'Doğalgaz', category: 'Fatura', amount: 1800, day: 24 },
      { id: uid(), name: 'İnternet', category: 'Fatura', amount: 650, day: 15 },
      { id: uid(), name: 'Site aidatı', category: 'Aidat', amount: 2500, day: 10 },
      { id: uid(), name: 'Dijital abonelikler', category: 'Abonelik', amount: 480, day: 8 },
    ],
    purchases: [],
    paid: {},
  };
  const [bonus, world] = data.cards;
  data.purchases = [
    { id: uid(), name: 'Cep telefonu', amount: 36000, date: day(0), cardId: bonus.id, installments: 9, category: 'Elektronik' },
    { id: uid(), name: 'Kablosuz kulaklık', amount: 3600, date: day(0), cardId: world.id, installments: 3, category: 'Elektronik' },
    { id: uid(), name: 'Haftalık market', amount: 2340, date: day(0), cardId: bonus.id, installments: 1, category: 'Market' },
    { id: uid(), name: 'Kışlık mont', amount: 4800, date: day(0), cardId: bonus.id, installments: 3, category: 'Giyim' },
    { id: uid(), name: 'Akaryakıt', amount: 1850, date: day(3), cardId: '', installments: 1, category: 'Akaryakıt' },
    { id: uid(), name: 'Öğle yemeği', amount: 420, date: day(1), cardId: '', installments: 1, category: 'Yeme-içme' },
    { id: uid(), name: 'Pazar alışverişi', amount: 960, date: day(6), cardId: '', installments: 1, category: 'Market' },
    { id: uid(), name: 'Sinema', amount: 600, date: day(9), cardId: '', installments: 1, category: 'Eğlence' },
  ];
  // Kartlı harcamalar kart borcuna (limite) eklenir
  data.purchases.forEach(p => {
    const c = data.cards.find(x => x.id === p.cardId);
    if (c) c.balance += p.amount;
  });
  return data;
}

/* ---------------- Events ---------------- */

document.addEventListener('click', e => {
  const v = e.target.closest('[data-view]');
  if (v) { view = v.dataset.view; if (view === 'calendar') calOffset = 0; render(); window.scrollTo(0, 0); return; }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  switch (act) {
    case 'add': openForm(a.dataset.list, null, a.dataset.card ? { cardId: a.dataset.card } : {}); break;
    case 'edit': openForm(a.dataset.list, a.dataset.id); break;
    case 'del': {
      const list = a.dataset.list, item = state[list].find(x => x.id === a.dataset.id);
      if (!item) break;
      const extra = list === 'purchases' && item.cardId ? '\nÖdenmemiş taksitleri kart borcundan düşülecek.'
        : list === 'cards' && cardPurchases(item).length ? `\nBu karta ait ${cardPurchases(item).length} harcama da silinecek.` : '';
      if (confirm(`"${item.name}" silinsin mi?${extra}`)) {
        if (list === 'purchases') removePurchaseEffect(item);
        if (list === 'cards') state.purchases = state.purchases.filter(p => p.cardId !== item.id);
        state[list] = state[list].filter(x => x !== item);
        save();
      }
      break;
    }
    case 'spend-month': e.preventDefault(); spendOffset = a.dataset.d === '0' ? 0 : spendOffset + Number(a.dataset.d); render(); break;
    case 'close-modal': $('#modal').close(); break;
    case 'open-card': cardId = a.dataset.id; cardExtra = 0; view = 'card'; render(); window.scrollTo(0, 0); break;
    case 'more-months': cardExtra += 6; render(); break;
    case 'cal': calOffset = a.dataset.d === '0' ? 0 : calOffset + Number(a.dataset.d); render(); break;
    case 'pay': {
      const month = a.dataset.month, key = a.dataset.key;
      const p = state.paid[month] = state.paid[month] || {};
      const card = key.startsWith('card:') && state.cards.find(c => 'card:' + c.id === key);
      if (card) {
        // Kart ödemesi: işaretlenince toplam borçtan düş, işaret kaldırılınca geri ekle
        if (a.checked) {
          const [yy, mm] = month.split('-').map(Number);
          const o = obligations(yy, mm - 1).find(x => x.key === key);
          const amount = Math.min(o ? o.amount : +card.monthlyPayment || 0, +card.balance || 0);
          card.balance = +((+card.balance || 0) - amount).toFixed(2);
          p[key] = amount;
        } else {
          if (typeof p[key] === 'number') card.balance = +((+card.balance || 0) + p[key]).toFixed(2);
          delete p[key];
        }
      } else if (a.checked) p[key] = true;
      else delete p[key];
      save(); break;
    }
    case 'theme': {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
      render(); break;
    }
    case 'demo': {
      const has = state.incomes.length + state.cards.length + state.loans.length + state.expenses.length + state.purchases.length;
      if (!has || confirm('Mevcut verilerin örnek verilerle değiştirilecek. Devam edilsin mi?')) {
        state = demoData();
        // Bu ayın tarihi geçmiş ödemeleri ödenmiş say
        const t = today();
        for (const o of obligations(t.getFullYear(), t.getMonth())) {
          // Örnek borçlar ödeme sonrası hali gösterir; kart tutarı kaydedilir ki işaret kaldırılınca geri eklensin
          if (o.date < t) (state.paid[mkey(o.date)] = state.paid[mkey(o.date)] || {})[o.key] = o.type === 'card' ? o.amount : true;
        }
        view = 'dashboard'; save();
      }
      break;
    }
    case 'reset':
      if (confirm('Tüm veriler kalıcı olarak silinecek. Emin misin?')) { state = emptyState(); save(); }
      break;
    case 'export': {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `finans-yedek-${mkey(today())}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      break;
    }
    case 'import': $('#import-file').click(); break;
    case 'login': Sync.showAuth(); break;
    case 'logout': Sync.logout(); break;
    case 'sync-now': Sync.refresh(); break;
  }
});

// Kart detayında aylık tutar girişi: yazarken kaydeder, odak kaybolmasın diye sayfayı yeniden çizmez
document.addEventListener('input', e => {
  const inp = e.target.closest('.sched-input');
  if (!inp) return;
  const c = state.cards.find(x => x.id === inp.dataset.id);
  if (!c) return;
  c.schedule = c.schedule || {};
  const v = Math.round((parseFloat(inp.value) || 0) * 100) / 100;
  if (v > 0) c.schedule[inp.dataset.month] = v; else delete c.schedule[inp.dataset.month];
  localStorage.setItem(STORE, JSON.stringify(state));
  if (typeof Sync !== 'undefined') Sync.changed();
  const row = inp.closest('tr'), [yy, mm] = inp.dataset.month.split('-').map(Number);
  const total = round2(v + (+inp.dataset.purchases || 0));
  row.querySelector('.check').disabled = !(total > 0);
  row.querySelector('.tot').innerHTML = `<b>${total > 0 ? money(total) : '—'}</b>`;
  row.querySelector('.st').innerHTML = schedRowStatus({ date: dateAt(yy, mm - 1, +c.dueDay), paid: false, amount: total });
  $('#card-summary').innerHTML = cardSummaryHTML(c);
});

$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.cards) || !Array.isArray(data.incomes)) throw new Error('format');
    state = migrate(Object.assign(emptyState(), data));
    save();
    alert('Veriler içe aktarıldı.');
  } catch {
    alert('Dosya okunamadı. Lütfen bu uygulamadan alınmış bir yedek dosyası seç.');
  }
  e.target.value = '';
});

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (chartJobs.length) chartJobs.forEach(fn => fn()); }, 150);
});

render();
