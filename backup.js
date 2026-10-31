'use strict';

/* =========================================================
   Otomatik yedekler
   - Bu cihazda (localStorage): günde bir yedek + riskli işlemlerden önce (buluttan veri gelmeden,
     geri yüklemeden, örnek veri / içe aktarma / silme öncesi).
   - Bulutta (Supabase finance_backups tablosu): günde bir yedek, son 30 gün saklanır.
   ========================================================= */

const Backup = (() => {
  const KEY = 'finans-takip-backups';
  const MAX_DAILY = 14, MAX_EVENT = 10, CLOUD_DAYS = 30;
  const SQL = `create table if not exists public.finance_backups (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  data jsonb not null
);
create index if not exists finance_backups_user_created on public.finance_backups (user_id, created_at desc);
alter table public.finance_backups enable row level security;
create policy "backups_select_own" on public.finance_backups for select using (auth.uid() = user_id);
create policy "backups_insert_own" on public.finance_backups for insert with check (auth.uid() = user_id);
create policy "backups_delete_own" on public.finance_backups for delete using (auth.uid() = user_id);
grant select, insert, delete on public.finance_backups to authenticated;`;

  // Bulut durumu: idle (liste açılmadı) | loading | ok | missing (tablo yok) | error
  let cloud = { status: 'idle', list: [], error: '' };
  let cloudDoneDay = '';

  const localDay = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  const fmt = at => new Date(at).toLocaleString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const hasData = s => ['incomes', 'cards', 'loans', 'expenses', 'purchases'].some(k => (s[k] || []).length > 0);
  const summary = s => [[s.cards, 'kart'], [s.purchases, 'harcama'], [s.incomes, 'gelir'], [s.loans, 'kredi'], [s.expenses, 'gider']]
    .filter(([a]) => a && a.length).map(([a, l]) => `${a.length} ${l}`).join(' · ') || 'boş';
  const loggedIn = () => typeof Sync !== 'undefined' && !!Sync.user();

  /* ---------- Cihazdaki yedekler ---------- */

  function read() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }

  function write(list) {
    // Depolama dolarsa en eski yedekten başlayarak sil
    for (;;) {
      try { localStorage.setItem(KEY, JSON.stringify(list)); return; }
      catch { if (list.length <= 1) return; list.pop(); }
    }
  }

  function snapshot(reason, type = 'event', data = state) {
    if (!hasData(data)) return false;
    const list = read(), json = JSON.stringify(data);
    if (type === 'event' && list[0] && JSON.stringify(list[0].data) === json) return false; // aynısı zaten var
    list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: new Date().toISOString(), type, reason, data: JSON.parse(json) });
    let daily = 0, event = 0;
    write(list.filter(b => (b.type === 'daily' ? ++daily <= MAX_DAILY : ++event <= MAX_EVENT)));
    if (view === 'settings') render();
    return true;
  }

  function dailyLocal() {
    const today = localDay();
    if (!read().some(b => b.type === 'daily' && localDay(new Date(b.at)) === today)) snapshot('Günlük otomatik yedek', 'daily');
  }

  /* ---------- Bulut yedekleri ---------- */

  async function dailyCloud() {
    const today = localDay();
    if (!loggedIn() || !hasData(state) || cloudDoneDay === today || cloud.status === 'missing') return;
    cloudDoneDay = today;
    try {
      const last = await Sync.api('/rest/v1/finance_backups?select=created_at&order=created_at.desc&limit=1', { auth: true });
      if (last && last[0] && localDay(new Date(last[0].created_at)) === today) return;
      await Sync.api('/rest/v1/finance_backups', {
        method: 'POST', auth: true, headers: { Prefer: 'return=minimal' },
        body: { user_id: Sync.user().id, data: state },
      });
      const cutoff = new Date(Date.now() - CLOUD_DAYS * 864e5).toISOString();
      await Sync.api('/rest/v1/finance_backups?created_at=lt.' + encodeURIComponent(cutoff), {
        method: 'DELETE', auth: true, headers: { Prefer: 'return=minimal' },
      });
      if (cloud.status === 'ok') loadCloud();
    } catch (e) {
      if (e.status === 404) { cloud.status = 'missing'; if (view === 'settings') render(); }
      else cloudDoneDay = ''; // internet yoksa / geçici hata: sonra tekrar dene
    }
  }

  async function loadCloud() {
    cloud = { ...cloud, status: 'loading' };
    if (view === 'settings') render();
    try {
      const list = await Sync.api(`/rest/v1/finance_backups?select=id,created_at&order=created_at.desc&limit=${CLOUD_DAYS + 5}`, { auth: true });
      cloud = { status: 'ok', list: list || [], error: '' };
    } catch (e) {
      cloud = e.status === 404 ? { status: 'missing', list: [], error: '' }
        : { status: 'error', list: [], error: e instanceof TypeError ? 'Sunucuya ulaşılamadı.' : e.message };
    }
    if (view === 'settings') render();
  }

  function daily() { dailyLocal(); dailyCloud(); }

  /* ---------- Geri yükleme ---------- */

  async function restore(src, id) {
    let data, at;
    try {
      if (src === 'local') {
        const b = read().find(x => x.id === id);
        if (!b) return;
        data = b.data; at = b.at;
      } else {
        const r = await Sync.api(`/rest/v1/finance_backups?select=data,created_at&id=eq.${encodeURIComponent(id)}`, { auth: true });
        if (!r || !r[0]) throw new Error('Yedek bulunamadı.');
        data = r[0].data; at = r[0].created_at;
      }
    } catch (e) {
      alert('Yedek alınamadı: ' + (e instanceof TypeError ? 'internet bağlantını kontrol et.' : e.message));
      return;
    }
    if (!confirm(`${fmt(at)} tarihli yedek geri yüklensin mi? (${summary(data)})\n\n` +
      'Şu anki verilerin önce bu cihaza yedeklenir; istersen ona da geri dönebilirsin. Geri yüklenen veriler diğer cihazına da gider.')) return;
    snapshot('Geri yüklemeden önceki hal');
    state = migrate(Object.assign(emptyState(), JSON.parse(JSON.stringify(data))));
    save();
    alert('Yedek geri yüklendi.');
  }

  /* ---------- Ayarlar paneli ---------- */

  const row = (src, id, title, sub) => `<div class="backup-row"><div><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>
    <button class="btn sm" data-act="backup-restore" data-src="${src}" data-id="${esc(String(id))}">Geri yükle</button></div>`;

  function cloudHTML() {
    if (!loggedIn()) return '<p class="muted-note">Bulut yedeği için giriş yapman gerekiyor.</p>';
    switch (cloud.status) {
      case 'idle': return '<div class="btns"><button class="btn sm" data-act="backup-cloud">Bulut yedeklerini göster</button></div>';
      case 'loading': return '<p class="muted-note">Yükleniyor…</p>';
      case 'error': return `<p class="muted-note">Bulut yedekleri alınamadı: ${esc(cloud.error)}</p><div class="btns"><button class="btn sm" data-act="backup-cloud">Tekrar dene</button></div>`;
      case 'missing': return `<p class="muted-note">Bulut yedeği için Supabase'de bir kez kurulum gerekiyor: Supabase → <b>SQL Editor</b> → aşağıdaki kodu yapıştır → <b>Run</b>. Sonra bu sayfayı yenile.</p>
        <details><summary class="link" style="cursor:pointer">SQL kodunu göster</summary><pre class="sql">${esc(SQL)}</pre>
        <button class="btn sm" data-act="backup-copy-sql">Kodu kopyala</button></details>`;
      default:
        return cloud.list.length
          ? `<div class="backup-list">${cloud.list.map(b => row('cloud', b.id, fmt(b.created_at), 'Günlük bulut yedeği')).join('')}</div>`
          : '<p class="muted-note">Henüz bulut yedeği yok; ilki bugün otomatik alınacak.</p>';
    }
  }

  function html() {
    const list = read();
    return `<div class="panel"><h2>Otomatik yedekler</h2>
      <p>Verilerin her gün kendiliğinden yedeklenir. Yanlışlıkla silme ya da hatalı eşitleme olursa istediğin tarihe dönebilirsin.</p>
      <h3 class="backup-h">Bu cihazda <small>son ${MAX_DAILY} gün + önemli işlemlerden önce</small></h3>
      ${list.length ? `<div class="backup-list">${list.map(b => row('local', b.id, fmt(b.at), `${esc(b.reason)} · ${summary(b.data)}`)).join('')}</div>`
        : '<p class="muted-note">Henüz yedek yok.</p>'}
      <h3 class="backup-h">Bulutta <small>son ${CLOUD_DAYS} gün, günde bir</small></h3>
      ${cloudHTML()}
      <div class="btns" style="margin-top:12px"><button class="btn" data-act="backup-now">Şimdi yedek al</button></div>
    </div>`;
  }

  document.addEventListener('click', async e => {
    const a = e.target.closest('[data-act^="backup-"]');
    if (!a) return;
    switch (a.dataset.act) {
      case 'backup-now':
        if (!snapshot('Elle alınan yedek')) alert(hasData(state) ? 'Son yedekten bu yana değişiklik yok.' : 'Yedeklenecek veri yok.');
        break;
      case 'backup-cloud': loadCloud(); break;
      case 'backup-restore': restore(a.dataset.src, a.dataset.id); break;
      case 'backup-copy-sql':
        try { await navigator.clipboard.writeText(SQL); a.textContent = 'Kopyalandı ✓'; } catch { alert('Kopyalanamadı; kodu seçip elle kopyala.'); }
        break;
    }
  });

  function init() {
    setTimeout(daily, 4000); // açılışta eşitleme bitsin, sonra yedekle
    setInterval(() => { if (document.visibilityState === 'visible') daily(); }, 30 * 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(daily, 4000); });
  }

  // Çıkış yapılınca cihazdaki yedekler de silinir (veriler bulutta kalır)
  function clear() { localStorage.removeItem(KEY); cloud = { status: 'idle', list: [], error: '' }; cloudDoneDay = ''; }

  return { init, snapshot, html, clear };
})();

Backup.init();
