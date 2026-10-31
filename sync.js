'use strict';

/* =========================================================
   Supabase ile cihazlar arası eşitleme
   Ek kütüphane kullanılmaz; Supabase Auth ve REST API'leri doğrudan çağrılır.
   Veriler yine localStorage'da tutulur (çevrimdışı çalışma), değişiklikler buluta gönderilir.
   ========================================================= */

const SB_URL = 'https://jyhfnohjcrmprtzrdevd.supabase.co';
const SB_KEY = 'sb_publishable_NiMoYwZIIu0Soel1z2rIhQ_rt3JepD9';
const SITE_URL = location.protocol.startsWith('http')
  ? location.origin + location.pathname
  : 'https://ercekberkay-maker.github.io/finans-takip/';

const Sync = (() => {
  const SESSION_KEY = 'finans-takip-session';
  const META_KEY = 'finans-takip-sync';
  const LOCAL_ONLY_KEY = 'finans-takip-local-only';

  const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const write = (k, v) => (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)));

  let session = read(SESSION_KEY);
  // updatedAt: bu cihazdaki son değişiklik · syncedAt: buluttan en son görülen sürüm · dirty: gönderilmemiş değişiklik var
  let meta = read(META_KEY) || {};
  let status = 'off', statusDetail = '', lastSync = null;
  let pushTimer = null, busy = false;
  let authMode = 'login', lastEmail = '';

  const saveMeta = () => write(META_KEY, meta);
  const hasData = () => ['incomes', 'cards', 'loans', 'expenses', 'purchases'].some(k => (state[k] || []).length > 0);

  /* ---------- API ---------- */

  const ERRORS = [
    [/Invalid login credentials/i, 'E-posta veya şifre hatalı.'],
    [/Email not confirmed/i, 'E-posta adresin henüz doğrulanmadı. Gelen kutundaki bağlantıya tıkla.'],
    [/already registered/i, 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.'],
    [/at least 6/i, 'Şifre en az 6 karakter olmalı.'],
    [/rate limit|security purposes/i, 'Çok fazla deneme yapıldı. Biraz bekleyip tekrar dene.'],
    [/invalid.*email|email.*invalid/i, 'Geçerli bir e-posta adresi yaz.'],
  ];
  function errText(json, fallback) {
    const m = json && (json.error_description || json.msg || json.message || json.error);
    if (!m) return fallback;
    const hit = ERRORS.find(([re]) => re.test(m));
    return hit ? hit[1] : m;
  }

  async function api(path, { method = 'GET', body, auth = false, bearer, headers = {} } = {}) {
    const h = { apikey: SB_KEY, 'Content-Type': 'application/json', ...headers };
    if (bearer) h.Authorization = 'Bearer ' + bearer;
    else if (auth) h.Authorization = 'Bearer ' + await token();
    const res = await fetch(SB_URL + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* boş yanıt */ }
    if (!res.ok) {
      const e = new Error(errText(json, `Sunucu hatası (${res.status})`));
      e.status = res.status;
      throw e;
    }
    return json;
  }

  function setSession(j, user) {
    session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: +j.expires_at || Math.floor(Date.now() / 1000) + (+j.expires_in || 3600),
      user: { id: user.id, email: user.email },
    };
    write(SESSION_KEY, session);
  }

  // Erişim anahtarı ~1 saatte dolar; süresi yaklaşınca yenilenir
  async function token() {
    if (!session) { const e = new Error('Oturum yok'); e.status = 401; throw e; }
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    try {
      const j = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
      setSession(j, j.user || session.user);
      return session.access_token;
    } catch (e) {
      if (e.status === 400 || e.status === 401) endSession('Oturumun sona erdi, lütfen tekrar giriş yap.');
      throw e;
    }
  }

  function endSession(msg) {
    session = null;
    write(SESSION_KEY, null);
    setStatus('off');
    showAuth(msg ? { type: 'error', text: msg } : null);
  }

  /* ---------- Durum göstergesi ---------- */

  function setStatus(s, detail = '') {
    status = s; statusDetail = detail;
    if (s === 'ok') lastSync = new Date();
    paintStatus();
  }

  function statusInfo() {
    const time = lastSync ? lastSync.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '';
    return {
      off: ['off', 'Sadece bu cihaz', 'Giriş yapılmadı; veriler yalnızca bu cihazda.'],
      pending: ['busy', 'Kaydediliyor…', 'Değişiklikler buluta gönderilecek.'],
      syncing: ['busy', 'Eşitleniyor…', 'Bulutla eşitleniyor.'],
      ok: ['ok', 'Eşitlendi', `Son eşitleme: ${time}`],
      offline: ['warn', 'Çevrimdışı', 'İnternet yok. Değişiklikler bu cihazda saklanıyor, bağlantı gelince gönderilecek.'],
      error: ['err', 'Eşitleme hatası', statusDetail || 'Bilinmeyen hata'],
    }[status];
  }

  function paintStatus() {
    const [cls, text, title] = statusInfo();
    const el = document.getElementById('sync');
    if (el) { el.className = 'sync ' + cls; el.textContent = text; el.title = title; }
    const d = document.getElementById('sync-detail');
    if (d) d.textContent = `${text} · ${title}`;
  }

  function fail(e) {
    if (e instanceof TypeError || !navigator.onLine) setStatus('offline');
    else if (e.status === 401) endSession('Oturumun sona erdi, lütfen tekrar giriş yap.');
    else setStatus('error', e.message);
  }

  /* ---------- Eşitleme ---------- */

  function changed() {
    meta.updatedAt = new Date().toISOString();
    meta.dirty = true;
    saveMeta();
    if (!session) return;
    setStatus('pending');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, 800);
  }

  async function push() {
    if (!session) return;
    if (busy) { clearTimeout(pushTimer); pushTimer = setTimeout(push, 1000); return; }
    busy = true;
    setStatus('syncing');
    try {
      const updated = meta.updatedAt || new Date().toISOString();
      const rows = await api('/rest/v1/finance_state?on_conflict=user_id', {
        method: 'POST', auth: true,
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: { user_id: session.user.id, data: state, updated_at: updated },
      });
      meta.dirty = false;
      meta.userId = session.user.id;
      meta.syncedAt = rows && rows[0] ? rows[0].updated_at : updated;
      saveMeta();
      setStatus('ok');
    } catch (e) { fail(e); }
    finally { busy = false; }
  }

  async function pull() {
    if (!session || busy) return;
    busy = true;
    setStatus('syncing');
    let next = null;
    try {
      const rows = await api('/rest/v1/finance_state?select=data,updated_at', { auth: true });
      const remote = rows && rows[0];
      const firstTime = meta.userId !== session.user.id;   // bu cihazda bu hesapla ilk eşitleme
      if (!remote) {
        next = 'push';    // bulut boş: bu cihazdaki verileri yükle
      } else {
        const rT = Date.parse(remote.updated_at), lT = Date.parse(meta.updatedAt || 0) || 0;
        let useRemote;
        if (firstTime) {
          useRemote = !hasData() || confirm(
            'Bu hesapta buluta kayıtlı veriler var.\n\n' +
            'Tamam → Buluttaki verileri kullan (önerilir)\n' +
            'İptal → Bu cihazdaki verileri buluta yükle (buluttakilerin üzerine yazar)');
        } else if (meta.dirty) {
          useRemote = rT > lT;    // iki tarafta da değişiklik: en yeni kayıt geçerli
        } else {
          useRemote = rT !== Date.parse(meta.syncedAt || 0);
        }
        if (useRemote) applyRemote(remote);
        else if (meta.dirty || firstTime) next = 'push';
        else setStatus('ok');
      }
      meta.userId = session.user.id;
      saveMeta();
    } catch (e) { fail(e); }
    finally { busy = false; }
    if (next === 'push') { if (!meta.updatedAt) meta.updatedAt = new Date().toISOString(); await push(); }
  }

  function applyRemote(remote) {
    state = migrate(Object.assign(emptyState(), remote.data || {}));
    localStorage.setItem(STORE, JSON.stringify(state));
    meta.dirty = false;
    meta.syncedAt = meta.updatedAt = remote.updated_at;
    saveMeta();
    setStatus('ok');
    render();
  }

  // Uygulamaya dönüldüğünde veya bağlantı geldiğinde: bekleyen varsa gönder, yoksa güncel veriyi çek
  function refresh() {
    if (!session) return;
    if (meta.dirty) push(); else pull();
  }

  /* ---------- Giriş ekranı ---------- */

  async function loggedIn(j, recovery = false) {
    const user = j.user || await api('/auth/v1/user', { bearer: j.access_token });
    setSession(j, user);
    write(LOCAL_ONLY_KEY, null);
    if (recovery) {
      authMode = 'newpass';
      showAuth({ type: 'info', text: 'Yeni şifreni belirle.' });
    } else hideAuth();
    await pull();
    render();
  }

  function authHTML(msg) {
    const m = msg ? `<div class="auth-msg ${msg.type}">${esc(msg.text)}</div>` : '';
    const emailField = `<label>E-posta<input name="email" type="email" autocomplete="email" required value="${esc(lastEmail)}"></label>`;
    const pass = (name, label, ac) => `<label>${label}<input name="${name}" type="password" autocomplete="${ac}" minlength="6" required></label>`;
    const tabs = `<div class="auth-tabs">
        <button type="button" data-auth="login" class="${authMode === 'login' ? 'active' : ''}">Giriş yap</button>
        <button type="button" data-auth="signup" class="${authMode === 'signup' ? 'active' : ''}">Kayıt ol</button>
      </div>`;
    let body;
    if (authMode === 'login') body = tabs + emailField + pass('password', 'Şifre', 'current-password') +
      `<button class="btn primary" type="submit">Giriş yap</button>
       <button class="auth-link" type="button" data-auth="forgot">Şifremi unuttum</button>`;
    else if (authMode === 'signup') body = tabs + emailField + pass('password', 'Şifre (en az 6 karakter)', 'new-password') +
      pass('password2', 'Şifre tekrar', 'new-password') + `<button class="btn primary" type="submit">Hesap oluştur</button>`;
    else if (authMode === 'forgot') body = `<p class="auth-sub">E-posta adresini yaz, şifre sıfırlama bağlantısı gönderelim.</p>` + emailField +
      `<button class="btn primary" type="submit">Bağlantı gönder</button>
       <button class="auth-link" type="button" data-auth="login">← Girişe dön</button>`;
    else body = pass('password', 'Yeni şifre', 'new-password') + `<button class="btn primary" type="submit">Şifreyi kaydet</button>`;
    return `<form class="auth-card" novalidate>
      <div class="auth-brand"><span class="logo">₺</span><div><strong>Finans Takip</strong>
        <small>Verilerin telefonunda ve bilgisayarında eşitlensin</small></div></div>
      ${m}${body}
      ${authMode !== 'newpass' ? '<button class="auth-link muted" type="button" data-auth="local">Giriş yapmadan devam et (veriler sadece bu cihazda kalır)</button>' : ''}
    </form>`;
  }

  function showAuth(msg = null) {
    let el = document.getElementById('auth');
    if (!el) {
      el = document.createElement('div');
      el.id = 'auth';
      el.className = 'auth';
      el.addEventListener('submit', onAuthSubmit);
      el.addEventListener('click', onAuthClick);
      document.body.appendChild(el);
    }
    el.innerHTML = authHTML(msg);
    el.hidden = false;
    const first = el.querySelector(lastEmail && authMode === 'login' ? 'input[name=password]' : 'input');
    if (first && matchMedia('(min-width: 761px)').matches) first.focus();
  }

  function hideAuth() {
    const el = document.getElementById('auth');
    if (el) el.hidden = true;
  }

  function onAuthClick(e) {
    const b = e.target.closest('[data-auth]');
    if (!b) return;
    const email = document.querySelector('#auth input[name=email]');
    if (email) lastEmail = email.value.trim();
    if (b.dataset.auth === 'local') {
      write(LOCAL_ONLY_KEY, true);
      hideAuth();
      setStatus('off');
      return;
    }
    authMode = b.dataset.auth;
    showAuth();
  }

  async function onAuthSubmit(e) {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('button[type=submit]');
    const email = f.email ? f.email.value.trim() : '', password = f.password ? f.password.value : '';
    if (email) lastEmail = email;
    btn.disabled = true;
    const redirect = 'redirect_to=' + encodeURIComponent(SITE_URL);
    try {
      if (authMode !== 'newpass' && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('Geçerli bir e-posta adresi yaz.');
      if (authMode === 'login') {
        if (!password) throw new Error('Şifreni yaz.');
        const j = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
        await loggedIn(j);
      } else if (authMode === 'signup') {
        if (password.length < 6) throw new Error('Şifre en az 6 karakter olmalı.');
        if (password !== f.password2.value) throw new Error('Şifreler birbirini tutmuyor.');
        const j = await api('/auth/v1/signup?' + redirect, { method: 'POST', body: { email, password } });
        if (j && j.access_token) await loggedIn(j);
        else {
          authMode = 'login';
          showAuth({ type: 'info', text: `${email} adresine bir doğrulama e-postası gönderdik. E-postadaki bağlantıya tıkla; uygulama açılınca otomatik giriş yapılır.` });
        }
      } else if (authMode === 'forgot') {
        await api('/auth/v1/recover?' + redirect, { method: 'POST', body: { email } });
        authMode = 'login';
        showAuth({ type: 'info', text: 'Şifre sıfırlama bağlantısı e-postana gönderildi.' });
      } else if (authMode === 'newpass') {
        if (password.length < 6) throw new Error('Şifre en az 6 karakter olmalı.');
        await api('/auth/v1/user', { method: 'PUT', auth: true, body: { password } });
        authMode = 'login';
        hideAuth();
        alert('Şifren güncellendi.');
      }
    } catch (err) {
      showAuth({ type: 'error', text: err instanceof TypeError ? 'Sunucuya ulaşılamadı. İnternet bağlantını kontrol et.' : err.message });
    } finally {
      btn.disabled = false;
    }
  }

  // E-posta doğrulama / şifre sıfırlama bağlantısından dönüş: oturum bilgisi adresin # kısmında gelir
  async function handleRedirect() {
    const h = location.hash;
    if (!/access_token=|error=/.test(h)) return false;
    const p = new URLSearchParams(h.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('error')) {
      authMode = 'login';
      showAuth({ type: 'error', text: p.get('error_code') === 'otp_expired' ? 'Bağlantının süresi dolmuş. Tekrar giriş yapmayı veya şifre sıfırlamayı dene.' : (p.get('error_description') || 'Bağlantı geçersiz.') });
      return true;
    }
    try {
      await loggedIn({
        access_token: p.get('access_token'), refresh_token: p.get('refresh_token'),
        expires_at: p.get('expires_at'), expires_in: p.get('expires_in'),
      }, p.get('type') === 'recovery');
    } catch (e) {
      showAuth({ type: 'error', text: e.message });
    }
    return true;
  }

  /* ---------- Hesap paneli (Ayarlar) ---------- */

  function accountHTML() {
    if (!session) {
      return `<div class="panel"><h2>Hesap ve eşitleme</h2>
        <p>Giriş yapmadın; verilerin yalnızca bu cihazda. Giriş yaparsan telefonun ve bilgisayarın otomatik eşitlenir.</p>
        <div class="btns"><button class="btn primary" data-act="login">Giriş yap / Kayıt ol</button></div></div>`;
    }
    const [, text, title] = statusInfo();
    return `<div class="panel"><h2>Hesap ve eşitleme</h2>
      <p><b>${esc(session.user.email)}</b> ile giriş yapıldı. Değişiklikler buluta kaydedilir ve diğer cihazında otomatik görünür.</p>
      <p class="muted-note" id="sync-detail">${text} · ${title}</p>
      <div class="btns"><button class="btn" data-act="sync-now">Şimdi eşitle</button><button class="btn danger" data-act="logout">Çıkış yap</button></div></div>`;
  }

  async function logout() {
    if (!confirm('Çıkış yapılsın mı?\n\nBu cihazdaki veriler silinir; buluttaki verilerin korunur ve tekrar giriş yapınca geri gelir.')) return;
    if (meta.dirty) {
      await push();
      if (meta.dirty && !confirm('Bazı değişiklikler buluta gönderilemedi (internet yok olabilir). Yine de çıkılırsa bu değişiklikler kaybolur. Devam edilsin mi?')) return;
    }
    try { await api('/auth/v1/logout', { method: 'POST', auth: true }); } catch { /* yine de çık */ }
    meta = {};
    saveMeta();
    state = emptyState();
    localStorage.setItem(STORE, JSON.stringify(state));
    view = 'dashboard';
    render();
    authMode = 'login';
    endSession();
  }

  async function init() {
    addEventListener('online', refresh);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    setInterval(() => { if (document.visibilityState === 'visible' && session && !meta.dirty) pull(); }, 60000);
    if (await handleRedirect()) return;
    if (session) { setStatus('syncing'); refresh(); }
    else {
      setStatus('off');
      if (!read(LOCAL_ONLY_KEY)) showAuth();
    }
  }

  return { init, changed, pull, push, refresh, logout, showAuth: () => { authMode = 'login'; showAuth(); }, accountHTML, paintStatus };
})();

Sync.init();
