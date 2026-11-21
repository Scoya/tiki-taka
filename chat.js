'use strict';
/* =========================================================
   둘만의 채팅
   - 메시지는 이 폰(IndexedDB)에 먼저 저장 → 서버로 전송 (오프라인이면 대기)
   - 실시간 수신, 읽음 표시, 이모지 반응, 사진, 일정·메모·디데이 공유
   - 상대가 채팅 화면을 보고 있지 않을 때만 푸시 알림 요청
   ========================================================= */
const CHAT_EMOJIS = ['♥', '😂', '👍', '😮', '😢', '🙏'];
const CHAT_PAGE = 80;

const ChatDB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      if (!('indexedDB' in window)) { rej(new Error('no-idb')); return; }
      let r;
      try { r = indexedDB.open('couple-chat', 1); } catch (e) { rej(e); return; }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('msgs')) db.createObjectStore('msgs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => { this.db = r.result; this.db.onversionchange = () => { this.db.close(); this.db = null; }; this.db.onclose = () => { this.db = null; }; res(this.db); };
      r.onerror = () => rej(r.error || new Error('idb-open'));
      r.onblocked = () => rej(new Error('idb-blocked'));
    });
  },
  run(stores, mode, fn) {
    return this.open().then(db => new Promise((res, rej) => {
      let t;
      try { t = db.transaction(stores, mode); } catch (e) { this.db = null; rej(e); return; }
      const box = {};
      t.oncomplete = () => res(box.v);
      t.onerror = () => rej(t.error || new Error('idb-tx'));
      t.onabort = () => rej(t.error || new Error('idb-abort'));
      fn(t, box);
    }));
  },
  all(store) { return this.run([store], 'readonly', (t, b) => { const r = t.objectStore(store).getAll(); r.onsuccess = () => { b.v = r.result || []; }; }).then(v => v || []); },
  get(store, key) { return this.run([store], 'readonly', (t, b) => { const r = t.objectStore(store).get(key); r.onsuccess = () => { b.v = r.result || null; }; }); },
  put(store, recs) { return this.run([store], 'readwrite', t => { (Array.isArray(recs) ? recs : [recs]).forEach(x => t.objectStore(store).put(x)); }); },
  del(store, keys) { return this.run([store], 'readwrite', t => { (Array.isArray(keys) ? keys : [keys]).forEach(k => t.objectStore(store).delete(k)); }); },
  clear() { return this.run(['msgs', 'blobs', 'meta'], 'readwrite', t => { ['msgs', 'blobs', 'meta'].forEach(s => t.objectStore(s).clear()); }); }
};

const Chat = {
  msgs: new Map(), meta: { k: 'chat', coupleId: '', lastSync: '', myRead: '', partnerRead: '' },
  ready: false, readyP: null, channel: null, partnerVisible: false, visible: false,
  showCount: CHAT_PAGE, urls: new Map(), dlBusy: new Set(), flushing: false, pulling: false,
  noMoreServer: false, loadingOlder: false, retryTimer: 0, readTimer: 0, built: false, lastCount: 0,

  mySlot() { return Sync.meta && Sync.meta.slot === 'you' ? 'you' : 'me'; },
  partnerSlot() { return this.mySlot() === 'me' ? 'you' : 'me'; },
  usable() { return !!(window.Sync && Sync.isLinked()); },

  /* ---------- 시작 / 정리 ---------- */
  init() {
    if (this.readyP) return this.readyP;
    this.readyP = (async () => {
      try {
        const m = await ChatDB.get('meta', 'chat');
        if (m) this.meta = { ...this.meta, ...m };
        if (this.usable() && this.meta.coupleId && this.meta.coupleId !== Sync.meta.coupleId) await this.wipe();
        const rows = await ChatDB.all('msgs');
        rows.forEach(r => { if (r && isStr(r.id)) this.msgs.set(r.id, r); });
      } catch (e) { /* 저장소를 못 열어도 화면은 동작 */ }
      this.ready = true;
      this.updateBadge();
      if (tab === 'chat') renderChat(true);
    })();
    window.addEventListener('online', () => { this.flush(); this.pull(); });
    document.addEventListener('visibilitychange', () => { this.setVisible(); if (!document.hidden) { this.flush(); this.pull(); } });
    return this.readyP;
  },
  async start() {
    await this.init();
    if (!Sync.online()) return;
    if (this.meta.coupleId !== Sync.meta.coupleId) { await this.wipe(); this.meta.coupleId = Sync.meta.coupleId; this.saveMeta(); }
    this.subscribe();
    this.loadPartnerRead();
    this.pull();
    this.flush();
  },
  stop() {
    if (this.channel && Sync.sb) { try { Sync.sb.removeChannel(this.channel); } catch (e) {} }
    this.channel = null; this.partnerVisible = false;
  },
  async wipe() {
    this.stop();
    this.msgs.clear();
    this.urls.forEach(u => URL.revokeObjectURL(u)); this.urls.clear();
    this.meta = { k: 'chat', coupleId: '', lastSync: '', myRead: '', partnerRead: '' };
    this.noMoreServer = false; this.showCount = CHAT_PAGE;
    try { await ChatDB.clear(); } catch (e) {}
    this.updateBadge();
  },
  async reset() { await this.wipe(); if (tab === 'chat') renderChat(true); },
  saveMeta() { ChatDB.put('meta', this.meta).catch(() => {}); },

  /* ---------- 정렬·조회 ---------- */
  sortKey(m) { return m.created_at ? m.created_at : '~' + String(m.client_ts || 0).padStart(15, '0'); },
  list() { return [...this.msgs.values()].sort((a, b) => this.sortKey(a) < this.sortKey(b) ? -1 : this.sortKey(a) > this.sortKey(b) ? 1 : 0); },
  unread() {
    const p = this.partnerSlot(), r = this.meta.myRead || '';
    let n = 0; this.msgs.forEach(m => { if (m.slot === p && m.created_at && m.created_at > r && !m.deleted) n++; });
    return n;
  },
  updateBadge() {
    const n = this.usable() ? this.unread() : 0;
    const el = document.getElementById('chat-badge');
    if (el) { el.textContent = n > 99 ? '99+' : String(n); el.hidden = !n; }
    try {
      if (n && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (!n && navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch (e) {}
  },

  /* ---------- 서버 → 이 폰 ---------- */
  clean(row) {
    return {
      id: row.id, slot: row.slot === 'you' ? 'you' : 'me', type: ['text', 'photo', 'ref'].includes(row.type) ? row.type : 'text',
      body: isStr(row.body) ? row.body.slice(0, 2000) : '', ref: row.ref && typeof row.ref === 'object' ? row.ref : null,
      reactions: row.reactions && typeof row.reactions === 'object' ? row.reactions : {}, deleted: !!row.deleted,
      created_at: isStr(row.created_at) ? row.created_at : '', updated_at: isStr(row.updated_at) ? row.updated_at : '',
      client_ts: Number.isFinite(row.client_ts) ? row.client_ts : 0, status: 'sent'
    };
  },
  /* 받은 행 반영. 바뀌었으면 true */
  apply(rows) {
    const changed = [];
    for (const row of rows) {
      if (!row || !isStr(row.id) || row.couple_id !== Sync.meta.coupleId) continue;
      const c = this.clean(row), old = this.msgs.get(c.id);
      if (old && old.updated_at && c.updated_at && old.updated_at >= c.updated_at && old.status === 'sent') continue;
      if (old && old.status !== 'sent' && !c.created_at) continue;
      this.msgs.set(c.id, c); changed.push(c);
      if (c.updated_at > (this.meta.lastSync || '')) this.meta.lastSync = c.updated_at;
    }
    if (changed.length) { ChatDB.put('msgs', changed).catch(() => {}); this.saveMeta(); }
    return changed.length > 0;
  },
  async pull() {
    if (!Sync.online() || this.pulling) return;
    this.pulling = true;
    let changed = false;
    try {
      const cid = Sync.meta.coupleId;
      if (!this.meta.lastSync) {
        // 처음: 최근 200개만
        const { data, error } = await Sync.sb.from('messages').select('*').eq('couple_id', cid).order('created_at', { ascending: false }).range(0, 199);
        if (error) throw error;
        changed = this.apply(data || []);
        if ((data || []).length < 200) this.noMoreServer = true;
        if (!this.meta.lastSync) { this.meta.lastSync = new Date(0).toISOString(); this.saveMeta(); }
      } else {
        const since = new Date(Date.parse(this.meta.lastSync) - 10000).toISOString();
        for (let page = 0, from = 0; page < 20; page++, from += 500) {
          const { data, error } = await Sync.sb.from('messages').select('*').eq('couple_id', cid).gt('updated_at', since).order('updated_at', { ascending: true }).range(from, from + 499);
          if (error) throw error;
          if (this.apply(data || [])) changed = true;
          if (!data || data.length < 500) break;
        }
      }
    } catch (e) { this.retryLater(); }
    this.pulling = false;
    if (changed) this.afterChange();
  },
  async loadOlder() {
    if (this.loadingOlder || this.noMoreServer || !Sync.online()) return false;
    const sent = this.list().filter(m => m.created_at);
    if (!sent.length) { this.noMoreServer = true; return false; }
    this.loadingOlder = true;
    try {
      const { data, error } = await Sync.sb.from('messages').select('*').eq('couple_id', Sync.meta.coupleId).lt('created_at', sent[0].created_at).order('created_at', { ascending: false }).range(0, 99);
      if (error) throw error;
      if (!data || data.length < 100) this.noMoreServer = true;
      this.apply(data || []);
      return (data || []).length > 0;
    } catch (e) { return false; }
    finally { this.loadingOlder = false; }
  },
  async loadPartnerRead() {
    if (!Sync.online()) return;
    const { data } = await Sync.sb.from('chat_reads').select('slot,last_read').eq('couple_id', Sync.meta.coupleId);
    const p = (data || []).find(r => r.slot === this.partnerSlot());
    if (p && p.last_read && p.last_read !== this.meta.partnerRead) { this.meta.partnerRead = p.last_read; this.saveMeta(); if (tab === 'chat') renderChat(); }
  },
  afterChange() {
    this.updateBadge();
    if (tab === 'chat') renderChat();
    this.markRead();
  },
  retryLater() { clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => { this.flush(); this.pull(); }, 15000); },

  /* ---------- 실시간 + 접속 상태(상대가 채팅을 보고 있는지) ---------- */
  subscribe() {
    this.stop();
    const cid = Sync.meta.coupleId;
    const ch = Sync.sb.channel('chat-' + cid, { config: { presence: { key: this.mySlot() } } });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: 'couple_id=eq.' + cid }, p => {
      if (p.new && this.apply([p.new])) this.afterChange();
    });
    ch.on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reads', filter: 'couple_id=eq.' + cid }, p => {
      const r = p.new;
      if (r && r.slot === this.partnerSlot() && isStr(r.last_read) && r.last_read > (this.meta.partnerRead || '')) {
        this.meta.partnerRead = r.last_read; this.saveMeta(); if (tab === 'chat') renderChat();
      }
    });
    ch.on('presence', { event: 'sync' }, () => {
      try {
        const st = ch.presenceState() || {};
        this.partnerVisible = (st[this.partnerSlot()] || []).some(x => x && x.visible);
      } catch (e) { this.partnerVisible = false; }
      if (tab === 'chat') { const s = document.getElementById('chat-sub'); if (s) s.innerHTML = chatSubHtml(); }
    });
    ch.subscribe(status => {
      if (status === 'SUBSCRIBED') { this.track(); this.pull(); this.loadPartnerRead(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.retryLater();
    });
    this.channel = ch;
  },
  track() { if (this.channel) { try { const r = this.channel.track({ visible: this.visible }); if (r && r.catch) r.catch(() => {}); } catch (e) {} } },
  setVisible() {
    const v = tab === 'chat' && !document.hidden && this.usable();
    if (v !== this.visible) { this.visible = v; this.track(); }
    if (v) this.markRead();
  },
  markRead() {
    if (!this.visible) return;
    const p = this.partnerSlot();
    let latest = this.meta.myRead || '';
    this.msgs.forEach(m => { if (m.slot === p && m.created_at && m.created_at > latest) latest = m.created_at; });
    if (latest === (this.meta.myRead || '')) return;
    this.meta.myRead = latest; this.saveMeta(); this.updateBadge();
    clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => { if (Sync.online()) Sync.sb.rpc('mark_read', { p_at: latest }).then(() => {}, () => {}); }, 600);
  },

  /* ---------- 보내기 ---------- */
  async send(type, body, ref, blobs) {
    if (!this.usable()) { toast('공유 연결 후에 쓸 수 있어요'); return; }
    await this.init();
    const m = { id: uid(), slot: this.mySlot(), type, body: (body || '').slice(0, 2000), ref: ref || null, reactions: {}, deleted: false, created_at: '', updated_at: '', client_ts: Date.now(), status: 'pending' };
    if (blobs) {
      try { await ChatDB.put('blobs', [{ k: m.id + '_f', b: blobs.full }, { k: m.id + '_t', b: blobs.thumb }]); }
      catch (e) { toast('사진을 저장하지 못했어요'); return; }
      this.urls.set(m.id + '_t', URL.createObjectURL(blobs.thumb));
    }
    this.msgs.set(m.id, m);
    ChatDB.put('msgs', m).catch(() => {});
    if (tab === 'chat') renderChat(true);
    this.flush();
  },
  isNetErr(e) { const s = String((e && (e.message || e)) || ''); return !(e && e.code) && /fetch|network|load failed|timeout|offline/i.test(s); },
  async flush() {
    if (this.flushing || !Sync.online()) return;
    this.flushing = true;
    const cid = Sync.meta.coupleId;
    try {
      const pend = this.list().filter(m => m.status === 'pending');
      for (const m of pend) {
        if (!this.msgs.has(m.id)) continue;   // 보내는 사이 지운 경우
        try {
          if (m.type === 'photo') {
            const [f, t] = await Promise.all([ChatDB.get('blobs', m.id + '_f'), ChatDB.get('blobs', m.id + '_t')]);
            if (!f || !t) throw Object.assign(new Error('photo missing'), { code: 'local' });
            const st = Sync.sb.storage.from('photos');
            const r1 = await st.upload(`${cid}/chat/${m.id}.jpg`, f.b, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' });
            if (r1.error) throw r1.error;
            const r2 = await st.upload(`${cid}/chat/${m.id}_t.jpg`, t.b, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' });
            if (r2.error) throw r2.error;
          }
          let { data, error } = await Sync.sb.from('messages').insert({ couple_id: cid, id: m.id, slot: m.slot, type: m.type, body: m.body, ref: m.ref, client_ts: m.client_ts }).select().single();
          if (error && (error.code === '23505' || /duplicate/i.test(error.message || ''))) {
            ({ data, error } = await Sync.sb.from('messages').select('*').eq('couple_id', cid).eq('id', m.id).maybeSingle());
          }
          if (error) throw error;
          if (data) { this.apply([data]); this.notifyPartner(m.id); }
        } catch (e) {
          if (this.isNetErr(e)) { this.retryLater(); break; }   // 인터넷 문제 → 나중에 다시
          const cur = this.msgs.get(m.id);
          if (cur) { cur.status = 'failed'; ChatDB.put('msgs', cur).catch(() => {}); }
        }
      }
    } finally {
      this.flushing = false;
      if (tab === 'chat') renderChat();
    }
  },
  notifyPartner(id) {
    if (this.partnerVisible) return;   // 상대가 채팅을 보고 있으면 알림 생략
    Sync.callFn({ type: 'chat', id }).catch(() => {});
  },
  retry(id) {
    const m = this.msgs.get(id);
    if (!m || m.status !== 'failed') return;
    m.status = 'pending'; ChatDB.put('msgs', m).catch(() => {});
    renderChat(); this.flush();
  },
  async remove(id) {
    const m = this.msgs.get(id);
    if (!m) return;
    if (m.status !== 'sent') {   // 아직 서버에 없는 메시지
      this.msgs.delete(id);
      ChatDB.del('msgs', id).catch(() => {}); ChatDB.del('blobs', [id + '_f', id + '_t']).catch(() => {});
      renderChat(); return;
    }
    if (!Sync.online()) { toast('인터넷에 연결된 뒤 삭제할 수 있어요'); return; }
    const { error } = await Sync.sb.rpc('delete_message', { p_id: id });
    if (error) { toast('삭제하지 못했어요'); return; }
    if (m.type === 'photo') {
      Sync.sb.storage.from('photos').remove([`${Sync.meta.coupleId}/chat/${id}.jpg`, `${Sync.meta.coupleId}/chat/${id}_t.jpg`]).then(() => {}, () => {});
      ChatDB.del('blobs', [id + '_f', id + '_t']).catch(() => {});
      ['_t', '_f'].forEach(s => { const u = this.urls.get(id + s); if (u) { URL.revokeObjectURL(u); this.urls.delete(id + s); } });
    }
    Object.assign(m, { deleted: true, body: '', ref: null, reactions: {} });
    ChatDB.put('msgs', m).catch(() => {});
    renderChat();
  },
  async react(id, emoji) {
    const m = this.msgs.get(id), s = this.mySlot();
    if (!m || m.status !== 'sent' || m.deleted) return;
    if (!Sync.online()) { toast('인터넷에 연결된 뒤 반응할 수 있어요'); return; }
    const prev = m.reactions[s] || '';
    const next = prev === emoji ? '' : emoji;
    m.reactions = { ...m.reactions }; if (next) m.reactions[s] = next; else delete m.reactions[s];
    renderChat();
    const { error } = await Sync.sb.rpc('react_message', { p_id: id, p_emoji: next });
    if (error) { m.reactions = { ...m.reactions }; if (prev) m.reactions[s] = prev; else delete m.reactions[s]; renderChat(); toast('반응을 저장하지 못했어요'); }
  },

  /* ---------- 사진 ---------- */
  async photoURL(id, size) {
    const k = id + '_' + size;
    if (this.urls.has(k)) return this.urls.get(k);
    let rec = null;
    try { rec = await ChatDB.get('blobs', k); } catch (e) {}
    let blob = rec && rec.b;
    if (!blob && Sync.online()) {
      const { data, error } = await Sync.sb.storage.from('photos').download(`${Sync.meta.coupleId}/chat/${id}${size === 't' ? '_t' : ''}.jpg`);
      if (!error && data) { blob = data; ChatDB.put('blobs', { k, b: data }).catch(() => {}); }
    }
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    this.urls.set(k, u);
    return u;
  },
  async hydrate() {
    const imgs = document.querySelectorAll('#chat-list img[data-pk]:not([src])');
    for (const img of imgs) {
      const k = img.dataset.pk;
      if (this.dlBusy.has(k)) continue;
      this.dlBusy.add(k);
      try {
        const u = await this.photoURL(k.slice(0, -2), k.slice(-1));
        if (u) document.querySelectorAll(`#chat-list img[data-pk="${CSS.escape(k)}"]`).forEach(x => { x.src = u; });
      } catch (e) {}
      this.dlBusy.delete(k);
    }
  }
};
window.Chat = Chat;
