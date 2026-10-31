// Fiş fotoğrafından toplam tutar, tarih ve işyeri adını okur (Tesseract.js, cihaz üzerinde OCR).
// Okuma motoru ilk kullanımda CDN'den indirilir, sonra tarayıcı önbelleğinde kalır.
const Receipt = (() => {
  const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let workerP = null, run = 0;

  /* ---------------- Arayüz ---------------- */

  function html() {
    return `<div class="scan full">
      <button type="button" class="btn" id="scan-btn">📷 Fiş fotoğrafı çek / seç</button>
      <input type="file" id="receipt-file" accept="image/*" hidden>
      <div class="scan-body">
        <img id="scan-thumb" alt="" hidden>
        <div id="scan-info" class="scan-info">Fişin fotoğrafını çekersen toplam tutar ve tarih otomatik doldurulur.</div>
      </div>
      <details id="scan-raw" hidden><summary>Okunan metni göster</summary><pre></pre></details>
    </div>`;
  }

  const info = (h, cls = '') => { const el = $('#scan-info'); if (el) { el.innerHTML = h; el.className = 'scan-info ' + cls; } };

  document.addEventListener('click', e => {
    if (e.target.closest('#scan-btn')) $('#receipt-file')?.click();
  });

  document.addEventListener('change', e => {
    if (e.target.id !== 'receipt-file' || !e.target.files[0]) return;
    scan(e.target.files[0]);
    e.target.value = '';
  });

  /* ---------------- OCR ---------------- */

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => fail(new Error('script'));
      document.head.appendChild(s);
    });
  }

  let onProgress = () => {};
  function worker() {
    if (!workerP) {
      workerP = (window.Tesseract ? Promise.resolve() : loadScript(TESS_URL))
        .then(() => Tesseract.createWorker('tur', 1, { logger: m => onProgress(m) }))
        .catch(err => { workerP = null; throw err; });
    }
    return workerP;
  }

  // Büyük telefon fotoğraflarını küçültüp gri tonlamaya çevirir: hem hızlanır hem okuma iyileşir
  async function prepare(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h), px = d.data;
      let lo = 255, hi = 0;
      for (let i = 0; i < px.length; i += 4) {
        const g = px[i] * .299 + px[i + 1] * .587 + px[i + 2] * .114;
        px[i] = g;
        if (g < lo) lo = g;
        if (g > hi) hi = g;
      }
      const k = hi > lo ? 255 / (hi - lo) : 1;
      for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = (px[i] - lo) * k;
      ctx.putImageData(d, 0, 0);
      return cv;
    } finally { URL.revokeObjectURL(url); }
  }

  async function scan(file) {
    const my = ++run;
    const alive = () => my === run && $('#modal').open && $('#scan-info');
    const thumb = $('#scan-thumb');
    if (thumb) { thumb.src = URL.createObjectURL(file); thumb.hidden = false; }
    $('#scan-btn').disabled = true;
    info('<span class="spin"></span> Okuma motoru hazırlanıyor… <small>(ilk seferde birkaç MB indirilir)</small>', 'busy');
    onProgress = m => {
      if (!alive()) return;
      if (m.status === 'recognizing text') info(`<span class="spin"></span> Fiş okunuyor… %${Math.round(m.progress * 100)}`, 'busy');
      else if (/traineddata/.test(m.status)) info(`<span class="spin"></span> Türkçe dil paketi yükleniyor… %${Math.round(m.progress * 100)}`, 'busy');
    };
    try {
      const [w, canvas] = await Promise.all([worker(), prepare(file)]);
      const { data } = await w.recognize(canvas);
      if (!alive()) return;
      apply(parse(data.text), data.text);
    } catch (err) {
      console.error(err);
      if (alive()) info('Fiş okunamadı. İnternet bağlantını kontrol edip tekrar dene ya da bilgileri elle gir.', 'err');
    } finally {
      const b = $('#scan-btn');
      if (b && my === run) { b.disabled = false; b.textContent = '📷 Başka fotoğraf dene'; }
    }
  }

  /* ---------------- Metinden bilgi çıkarma ---------------- */

  // Türkçe karakterleri sadeleştirip büyük harfe çevirir: anahtar kelime eşleştirmek için
  const fold = s => s.toLocaleUpperCase('tr').replace(/[İI]/g, 'I').replace(/Ş/g, 'S').replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U').replace(/Ö/g, 'O').replace(/Ç/g, 'C');

  const DATE_RE = /(?<!\d)(\d{1,2})\s?[.\/-]\s?(\d{1,2})\s?[.\/-]\s?(\d{4}|\d{2})(?!\d)/g;
  const ISO_RE = /(?<!\d)(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})(?!\d)/g;
  // 1.234,56 · 1234,56 · 1,234.56 · 12.50 · "1 234,56"
  const MONEY_RE = /(?<![\d.,])(\d{1,3}(?:[.,\s]\d{3})+|\d{1,7})\s?[,.]\s?(\d{2})(?![.,]?\d)/g;

  function validDate(y, m, d) {
    if (y < 100) y += 2000;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    const now = new Date(), diff = (dt - now) / 864e5;
    if (diff > 1 || diff < -730) return null; // gelecekte ya da 2 yıldan eski tarihler büyük ihtimalle yanlış okuma
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function datesIn(line) {
    const out = [];
    for (const m of line.matchAll(DATE_RE)) { const v = validDate(+m[3], +m[2], +m[1]); if (v) out.push(v); }
    for (const m of line.matchAll(ISO_RE)) { const v = validDate(+m[1], +m[2], +m[3]); if (v) out.push(v); }
    return out;
  }

  function moneyIn(line) {
    const clean = line.replace(DATE_RE, ' ').replace(ISO_RE, ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');
    return [...clean.matchAll(MONEY_RE)].map(m => +(m[1].replace(/[.,\s]/g, '') + '.' + m[2])).filter(v => v > 0);
  }

  const SKIP = /KDV|PARA\s?USTU|NAKIT|KALAN|BAKIYE|PUAN|INDIRIM|LIMIT|KART\s?NO|ADET|MIKTAR/;
  const KEYS = [
    [/GENEL\s?TOPLAM|ODENECEK/, 100],
    [/ARA\s?TOPLAM/, 40],
    [/TOPLAM|TOPLAN|TOPLAH/, 80],
    [/SATIS\s?TUTAR|ISLEM\s?TUTAR/, 90],
    [/TUTAR/, 70],
    [/TOTAL|AMOUNT/, 60],
  ];

  function parse(text) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const folded = lines.map(fold);

    // Tarih: önce "TARİH" yazan satırlarda ara, yoksa fişteki ilk geçerli tarih
    let date = null;
    folded.forEach((f, i) => { if (!date && /TARIH|TARH|DATE/.test(f)) date = datesIn(lines[i])[0] || datesIn(lines[i + 1] || '')[0] || null; });
    if (!date) for (const l of lines) { date = datesIn(l)[0]; if (date) break; }

    // Tutar: anahtar kelimeli satırlara puan ver, en yüksek puanlı satırdaki (eşitse en büyük) tutarı seç
    const cands = [];
    folded.forEach((f, i) => {
      if (SKIP.test(f)) return;
      const key = KEYS.find(([re]) => re.test(f));
      let vals = moneyIn(lines[i]), score = key ? key[1] : 0;
      if (key && !vals.length && lines[i + 1] && !SKIP.test(folded[i + 1])) { vals = moneyIn(lines[i + 1]); score -= 5; }
      if (/\*\s?\d/.test(lines[i])) score += 10; // fişlerde tutarlar genelde *123,45 diye basılır
      vals.forEach(v => cands.push({ v, score }));
    });
    cands.sort((a, b) => b.score - a.score || b.v - a.v);
    const amount = cands.length ? cands[0].v : null;

    // İşyeri adı: üst satırlarda çoğunluğu harf olan ilk satır (POS fişlerinin başındaki banka adı atlanır)
    const NOT_NAME = /TARIH|SAAT|FIS|FATURA|VERGI|V\.?D|TEL|MERSIS|NO\b|ISYERI|TERMINAL|BANK|GARANTI|BBVA|YAPI\s?KREDI|ZIRAAT|QNB|\bTEB\b|\bING\b|ENPARA|KUVEYT|ALBARAKA|HSBC|FIBA|WORLD|BONUS|AXESS|MAXIMUM|PARAF|CARDFINANS|PAYCELL|PAPARA/;
    let merchant = '';
    for (const [i, l] of lines.slice(0, 6).entries()) {
      const letters = (l.match(/\p{L}/gu) || []).length;
      if (letters >= 3 && letters / l.replace(/\s/g, '').length > .7 && !NOT_NAME.test(folded[i])) {
        merchant = l.replace(/[^\p{L}\p{N}&.'\- ]/gu, '').replace(/\s+/g, ' ').trim()
          .replace(/İ/g, 'i').toLowerCase().replace(/(^|\s)\p{L}/gu, c => c.toUpperCase())
          .replace(/(^|\s)((?:\p{L}\.){1,3})(?=\s|$)/gu, c => c.toLocaleUpperCase('tr')); // A.Ş., LTD. gibi kısaltmalar
        break;
      }
    }
    return { amount, date, merchant };
  }

  /* ---------------- Forma uygulama ---------------- */

  function setField(k, v) {
    const input = $(`#form-fields [name="${k}"]`);
    if (!input || v == null || v === '') return false;
    input.value = v;
    const label = input.closest('label');
    label.classList.remove('filled'); void label.offsetWidth; label.classList.add('filled');
    return true;
  }

  function apply(r, raw) {
    const got = [];
    if (setField('amount', r.amount)) got.push(`tutar <b>${money(r.amount)}</b>`);
    if (setField('date', r.date)) got.push(`tarih <b>${r.date.split('-').reverse().join('.')}</b>`);
    const name = $('#form-fields [name="name"]');
    if (name && !name.value.trim() && r.merchant) setField('name', r.merchant);
    syncForm();

    const miss = [!r.amount && 'tutarı', !r.date && 'tarihi'].filter(Boolean);
    if (got.length) {
      info(`✓ Okundu: ${got.join(' · ')}.${miss.length ? ` Fişteki ${miss.join(' ve ')} bulunamadı, elle gir.` : ''}
        <br><small>Kontrol et; ödeme şekli, taksit sayısı ve kategoriyi seçip kaydet.</small>`, miss.length ? 'warn' : 'ok');
    } else {
      info('Fişte tutar ve tarih bulunamadı. Fişi düz, iyi ışıkta ve yakından çekip tekrar dene ya da elle gir.', 'err');
    }
    const box = $('#scan-raw');
    if (box) { box.hidden = false; box.querySelector('pre').textContent = raw.trim(); }
  }

  return { html, parse };
})();
