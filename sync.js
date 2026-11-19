'use strict';
/* =========================================================
   Supabase 공유 동기화
   - 이 폰에 먼저 저장하고(오프라인에서도 동작), 바뀐 항목만 서버로 보냄
   - 상대가 바꾼 내용은 실시간으로 받아서 반영
   - 사진은 Storage에 올리고, 상대 폰은 썸네일만 먼저 받고 원본은 열 때 받음
   ========================================================= */
const SYNC_KEY = 'couple-sync';

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const Sync = {
  sb: null, session: null, meta: null, channel: null,
  flushing: false, pulling: false, flushTimer: 0, retryTimer: 0,
  state: 'off', error: '', members: 0, lastOk: 0, dl: Promise.resolve(),

  /* ---------- 기본 ---------- */
  configured() {
    const c = window.COUPLE_CONFIG || {};
    return !!(isStr(c.supabaseUrl) && /^https:\/\//.test(c.supabaseUrl) && isStr(c.supabaseAnonKey) && c.supabaseAnonKey.length > 20 && window.supabase && window.supabase.createClient);
  },
  /* 설정이 안 될 때 원인 안내 */
  configIssue() {
    const c = window.COUPLE_CONFIG;
    if (!c) return 'config.js 파일을 읽지 못했어요. GitHub에 config.js가 올라가 있는지 확인해 주세요.';
    if (!isStr(c.supabaseUrl) || !c.supabaseUrl.trim() || !isStr(c.supabaseAnonKey) || !c.supabaseAnonKey.trim()) return 'config.js가 비어 있어요. GitHub에 올라간 config.js에 주소와 키가 들어 있는지 확인해 주세요.';
    if (!/^https:\/\//.test(c.supabaseUrl.trim())) return 'config.js의 주소는 https:// 로 시작해야 해요.';
    if (c.supabaseAnonKey.trim().length <= 20) return 'config.js의 키가 너무 짧아요. Publishable key 전체를 복사했는지 확인해 주세요.';
    if (!window.supabase || !window.supabase.createClient) return 'vendor/supabase.js 파일을 읽지 못했어요. GitHub에 vendor 폴더가 올라가 있는지 확인해 주세요.';
    return '';
  },
  emptyMeta() { return { coupleId: '', slot: 'me', invite: '', userId: '', lastPull: '', outbox: [], photoUp: [], photoDel: [], snap: {} }; },
  loadMeta() {
    let m = null;
    try { m = JSON.parse(localStorage.getItem(SYNC_KEY)); } catch (e) {}
    const e = this.emptyMeta();
    if (!m || typeof m !== 'object') return e;
    return {
      coupleId: isStr(m.coupleId) ? m.coupleId : '', slot: m.slot === 'you' ? 'you' : 'me',
      invite: isStr(m.invite) ? m.invite : '', userId: isStr(m.userId) ? m.userId : '',
      lastPull: isStr(m.lastPull) ? m.lastPull : '',
      outbox: arr(m.outbox).filter(o => o && isStr(o.id) && isStr(o.kind)),
      photoUp: arr(m.photoUp).filter(p => p && isStr(p.id) && isDate(p.date)),
      photoDel: arr(m.photoDel).filter(isStr),
      snap: m.snap && typeof m.snap === 'object' ? m.snap : {}
    };
  },
  saveMeta() { try { localStorage.setItem(SYNC_KEY, JSON.stringify(this.meta)); } catch (e) {} },
  isLinked() { return !!(this.meta && this.meta.coupleId); },
  online() { return !!(this.sb && this.session && this.isLinked() && navigator.onLine !== false); },
  pending() { return this.meta ? this.meta.outbox.length + this.meta.photoUp.length + this.meta.photoDel.length : 0; },
  setState(s, err) {
    this.state = s; this.error = err || '';
    if (s === 'ok') this.lastOk = Date.now();
    if (typeof tab !== 'undefined' && tab === 'set' && !sheetOpen()) { const el = document.getElementById('sync-status'); if (el) el.innerHTML = this.statusHtml(); }
  },
  statusHtml() {
    if (!this.isLinked()) return '';
    const n = this.pending();
    if (!this.session) return '<span class="dot warn"></span>다시 로그인해 주세요';
    if (navigator.onLine === false) return `<span class="dot warn"></span>오프라인${n ? ` · 보낼 변경 ${n}건 대기` : ''}`;
    if (this.state === 'error') return `<span class="dot err"></span>동기화 오류 · 잠시 후 다시 시도해요${n ? ` (대기 ${n}건)` : ''}`;
    if (this.flushing || this.pulling || n) return `<span class="dot busy"></span>동기화 중…${n ? ` (${n}건)` : ''}`;
    return '<span class="dot ok"></span>동기화됨';
  },

  /* ---------- 시작 ---------- */
  async init() {
    this.meta = this.loadMeta();
    if (this.isLinked()) this.capture(D);   // 앱이 꺼져 있던 사이 놓친 변경이 있으면 대기열에 넣음
    if (!this.configured()) { this.state = 'off'; return; }
    const c = window.COUPLE_CONFIG;
    try {
      // 주소 끝에 /rest/v1/ 이나 / 가 붙어 있어도 프로젝트 주소만 사용
      const url = c.supabaseUrl.trim().replace(/\/(rest|auth|storage|realtime)\/v1\/?.*$/i, '').replace(/\/+$/, '');
      this.sb = window.supabase.createClient(url, c.supabaseAnonKey.trim(), {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'couple-auth' }
      });
    } catch (e) { this.sb = null; this.state = 'off'; return; }
    try { const { data } = await this.sb.auth.getSession(); this.session = data.session || null; } catch (e) { this.session = null; }
    this.sb.auth.onAuthStateChange((ev, session) => {
      this.session = session || null;
      // 콜백 안에서 바로 supabase를 호출하면 멈출 수 있어서 다음 틱으로 미룸
      setTimeout(() => {
        if (ev === 'SIGNED_OUT') this.stopRealtime();
        if (ev === 'SIGNED_IN' && this.isLinked() && !this.channel) this.start();
        if (typeof tab !== 'undefined' && tab === 'set' && !sheetOpen()) renderSet();
      }, 0);
    });
    window.addEventListener('online', () => { this.flush(); this.pull(); });
    window.addEventListener('offline', () => this.setState(this.state));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && this.online()) { this.flush(); this.pull(); } });
    if (this.session && this.isLinked()) {
      if (this.meta.userId && this.meta.userId !== this.session.user.id) { await this.signOut(true); return; }
      this.start();
    }
  },
  start() {
    if (!this.online()) return;
    this.subscribe();
    this.flush();
    this.pull();
    this.countMembers();
  },

  /* ---------- 로그인 ---------- */
  errKo(e) {
    const m = String((e && (e.message || e.error_description || e.code)) || e || '');
    if (/invalid login credentials/i.test(m)) return '이메일 또는 비밀번호가 맞지 않아요';
    if (/email not confirmed/i.test(m)) return '메일함에서 인증 링크를 먼저 눌러 주세요';
    if (/already registered|already exists/i.test(m)) return '이미 가입된 이메일이에요. 로그인해 주세요';
    if (/password.*(6|short|least)/i.test(m)) return '비밀번호는 6자 이상이어야 해요';
    if (/invalid.*email|email.*invalid/i.test(m)) return '이메일 형식을 확인해 주세요';
    if (/rate limit|too many/i.test(m)) return '요청이 많아요. 잠시 후 다시 시도해 주세요';
    if (/signups? not allowed|signup.*disabled/i.test(m)) return '새 가입이 막혀 있어요 (Supabase 설정 확인)';
    if (/invalid_code/.test(m)) return '초대 코드가 맞지 않아요';
    if (/couple_full/.test(m)) return '이미 두 사람이 연결된 코드예요';
    if (/already_member/.test(m)) return '이미 다른 커플에 연결된 계정이에요';
    if (/failed to fetch|network|load failed/i.test(m)) return '인터넷 연결을 확인해 주세요';
    return '문제가 생겼어요: ' + m.slice(0, 80);
  },
  async login(email, password, signup) {
    if (!this.sb) throw new Error('not configured');
    email = (email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('invalid email');
    if (!password || password.length < 6) throw new Error('password should be at least 6 characters');
    let res;
    if (signup) {
      res = await this.sb.auth.signUp({ email, password });
      if (res.error) throw res.error;
      if (!res.data.session) return 'confirm';
    } else {
      res = await this.sb.auth.signInWithPassword({ email, password });
      if (res.error) throw res.error;
    }
    this.session = res.data.session;
    return 'ok';
  },
  /* 로그인 직후: 이미 커플에 연결된 계정인지 확인 */
  async membership() {
    const { data, error } = await this.sb.from('members').select('couple_id,slot').eq('user_id', this.session.user.id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const c = await this.sb.from('couples').select('invite_code').eq('id', data.couple_id).maybeSingle();
    return { coupleId: data.couple_id, slot: data.slot === 'you' ? 'you' : 'me', invite: c.data ? c.data.invite_code : '' };
  },
  async createCouple() {
    const { data, error } = await this.sb.rpc('create_couple');
    if (error) throw error;
    await this.link({ coupleId: data.couple_id, slot: data.slot, invite: data.invite_code }, 'create');
  },
  async joinCouple(code) {
    code = (code || '').replace(/\s/g, '').toUpperCase();
    if (code.length < 6) throw new Error('invalid_code');
    const { data, error } = await this.sb.rpc('join_couple', { code });
    if (error) throw error;
    await this.link({ coupleId: data.couple_id, slot: data.slot, invite: data.invite_code }, 'join');
  },

  /* 커플 연결: 이 폰 데이터를 올리거나, 서버 데이터로 바꿈 */
  async link(m, mode) {
    const resume = this.meta.coupleId === m.coupleId && this.meta.userId === this.session.user.id;
    if (resume) { this.meta.slot = m.slot; this.meta.invite = m.invite || this.meta.invite; this.saveMeta(); this.start(); return; }

    const thumbs = await PhotoStore.allThumbs().catch(() => []);
    const hasLocal = D.events.length || D.ddays.length || D.memos.length || thumbs.length;

    this.stopRealtime();
    this.meta = this.emptyMeta();
    Object.assign(this.meta, { coupleId: m.coupleId, slot: m.slot, invite: m.invite || '', userId: this.session.user.id });
    this.saveMeta();

    if (mode === 'create') {
      // 처음 만든 사람: 이 폰 데이터를 그대로 올림
      this.capture(D);
      thumbs.forEach(t => this.meta.photoUp.push({ id: t.id, date: t.date, created: t.created || 0 }));
      this.saveMeta();
    } else {
      const keep = hasLocal && confirm('이 폰에 있던 일정·디데이·메모·사진을 공유 데이터에 합칠까요?\n\n취소를 누르면 이 폰의 데이터는 지우고 공유 데이터로 바꿔요.');
      const local = keep ? { events: D.events, ddays: D.ddays, memos: D.memos, cats: D.memoCats } : null;
      if (!keep) { await PhotoStore.clear().catch(() => {}); await loadPhotos(); }
      D = Store.empty();
      Store.saveLocal(D);
      this.meta.snap = {};
      await this.pull(true);
      if (local) {
        const has = (list, id) => list.some(x => x.id === id);
        local.events.forEach(x => { if (!has(D.events, x.id)) D.events.push(x); });
        local.ddays.forEach(x => { if (!has(D.ddays, x.id)) D.ddays.push(x); });
        local.memos.forEach(x => { if (!has(D.memos, x.id)) D.memos.push(x); });
        local.cats.forEach(c => { if (!D.memoCats.includes(c) && D.memoCats.length < 20) D.memoCats.push(c); });
        thumbs.forEach(t => this.meta.photoUp.push({ id: t.id, date: t.date, created: t.created || 0 }));
        Store.save(D);
      }
      computeMilestones();
    }
    this.saveMeta();
    render();
    this.start();
  },

  async signOut(silent) {
    this.stopRealtime();
    try { if (this.sb) await this.sb.auth.signOut(); } catch (e) {}
    this.session = null;
    this.meta = this.emptyMeta();
    this.saveMeta();
    if (!silent) toast('로그아웃했어요. 데이터는 이 폰에 남아 있어요');
    if (typeof tab !== 'undefined') render();
  },

  async countMembers() {
    if (!this.online() || this.members >= 2) return;
    const { count, error } = await this.sb.from('members').select('user_id', { count: 'exact', head: true }).eq('couple_id', this.meta.coupleId);
    if (!error && (count || 0) !== this.members) { this.members = count || 0; if (tab === 'set' && !sheetOpen()) renderSet(); }
  },

  /* ---------- 로컬 변경 → 대기열 ---------- */
  itemsOf(d) {
    const out = [{ id: 'settings', kind: 'settings', data: d.settings }, { id: 'cats', kind: 'cats', data: { list: d.memoCats } }];
    d.events.forEach(x => out.push({ id: x.id, kind: 'event', data: x }));
    d.ddays.forEach(x => out.push({ id: x.id, kind: 'dday', data: x }));
    d.memos.forEach(x => out.push({ id: x.id, kind: 'memo', data: x }));
    return out;
  },
  enqueue(op) {
    op.seq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    this.meta.outbox = this.meta.outbox.filter(o => o.id !== op.id);
    this.meta.outbox.push(op);
  },
  capture(d) {
    if (!this.isLinked()) return;
    const seen = new Set();
    for (const it of this.itemsOf(d)) {
      seen.add(it.id);
      const sig = it.kind + ':' + fnv(JSON.stringify(it.data));
      if (this.meta.snap[it.id] !== sig) { this.meta.snap[it.id] = sig; this.enqueue({ id: it.id, kind: it.kind, data: it.data, deleted: false }); }
    }
    for (const id of Object.keys(this.meta.snap)) {
      if (seen.has(id)) continue;
      const kind = this.meta.snap[id].split(':')[0];
      delete this.meta.snap[id];
      this.enqueue({ id, kind, data: {}, deleted: true });
    }
    this.saveMeta();
    this.scheduleFlush();
  },
  photoAdded(rec) {
    if (!this.isLinked()) return;
    this.meta.photoUp.push({ id: rec.id, date: rec.date, created: rec.created });
    this.saveMeta(); this.scheduleFlush();
  },
  photoDeleted(id) {
    if (!this.isLinked()) return;
    const queued = this.meta.photoUp.some(p => p.id === id);
    this.meta.photoUp = this.meta.photoUp.filter(p => p.id !== id);
    if (!queued) { this.enqueue({ id, kind: 'photo', data: {}, deleted: true }); if (!this.meta.photoDel.includes(id)) this.meta.photoDel.push(id); }
    this.saveMeta(); this.scheduleFlush();
  },
  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 700);
    this.setState(this.state === 'error' ? 'error' : this.state);
  },
  retryLater() { clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => { this.flush(); this.pull(); }, 15000); },

  /* ---------- 서버로 보내기 ---------- */
  path(id, thumb) { return `${this.meta.coupleId}/${id}${thumb ? '_t' : ''}.jpg`; },
  async flush() {
    if (!this.online() || this.flushing) return;
    this.flushing = true; this.setState('busy');
    try {
      // 1) 사진 파일 올리기 → 올라간 뒤에 사진 항목 등록 (상대가 빈 사진을 보지 않게)
      while (this.meta.photoUp.length) {
        const p = this.meta.photoUp[0];
        const [t, full] = await Promise.all([PhotoStore.getThumb(p.id), PhotoStore.getFull(p.id)]);
        if (t && t.thumb instanceof Blob && full instanceof Blob) {
          const st = this.sb.storage.from('photos');
          const r1 = await st.upload(this.path(p.id, false), full, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' });
          if (r1.error) throw r1.error;
          const r2 = await st.upload(this.path(p.id, true), t.thumb, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' });
          if (r2.error) throw r2.error;
          if (this.meta.photoUp[0] && this.meta.photoUp[0].id === p.id) this.enqueue({ id: p.id, kind: 'photo', data: { date: p.date, created: p.created || 0 }, deleted: false });
        }
        this.meta.photoUp = this.meta.photoUp.filter(x => x.id !== p.id);
        this.saveMeta();
      }
      // 2) 항목 보내기
      while (this.meta.outbox.length) {
        const batch = this.meta.outbox.slice(0, 200);
        const rows = batch.map(o => ({ couple_id: this.meta.coupleId, id: o.id, kind: o.kind, data: o.data, deleted: !!o.deleted }));
        const { error } = await this.sb.from('items').upsert(rows, { onConflict: 'couple_id,id' });
        if (error) throw error;
        const sent = new Map(batch.map(o => [o.id, o.seq]));
        this.meta.outbox = this.meta.outbox.filter(o => sent.get(o.id) !== o.seq);
        this.saveMeta();
      }
      // 3) 지운 사진 파일 정리
      if (this.meta.photoDel.length) {
        const ids = this.meta.photoDel.slice(0, 50);
        const { error } = await this.sb.storage.from('photos').remove(ids.flatMap(id => [this.path(id, false), this.path(id, true)]));
        if (error) throw error;
        this.meta.photoDel = this.meta.photoDel.filter(id => !ids.includes(id));
        this.saveMeta();
      }
      this.flushing = false;
      this.setState('ok');
    } catch (e) {
      this.flushing = false;
      this.setState('error', this.errKo(e));
      this.retryLater();
    }
  },

  /* ---------- 서버에서 받기 ---------- */
  async pull(full) {
    if (!this.online() || this.pulling) return;
    this.pulling = true; this.setState('busy');
    let changed = false;
    try {
      const since = !full && this.meta.lastPull ? new Date(Date.parse(this.meta.lastPull) - 10000).toISOString() : '';
      let maxTs = this.meta.lastPull, from = 0;
      for (let page = 0; page < 100; page++) {
        let q = this.sb.from('items').select('*').eq('couple_id', this.meta.coupleId).order('updated_at', { ascending: true }).order('id', { ascending: true }).range(from, from + 999);
        if (since) q = q.gt('updated_at', since);
        const { data, error } = await q;
        if (error) throw error;
        for (const row of data) {
          if (this.applyRow(row)) changed = true;
          if (!maxTs || row.updated_at > maxTs) maxTs = row.updated_at;
        }
        if (data.length < 1000) break;
        from += 1000;
      }
      this.meta.lastPull = maxTs || '';
      this.saveMeta();
      this.pulling = false;
      if (changed) this.afterRemote();
      this.setState(this.state === 'error' ? 'error' : 'ok');
    } catch (e) {
      this.pulling = false;
      if (changed) this.afterRemote();
      this.setState('error', this.errKo(e));
      this.retryLater();
    }
  },
  /* 서버 항목 하나를 이 폰 데이터에 반영. 바뀌었으면 true */
  applyRow(row) {
    if (!row || row.couple_id !== this.meta.coupleId || !isStr(row.id)) return false;
    if (this.meta.outbox.some(o => o.id === row.id)) return false;   // 아직 안 보낸 내 변경이 우선
    if (row.kind === 'photo') { this.applyPhoto(row); return false; }
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let changed = false;
    if (row.kind === 'settings') { if (!row.deleted) { const v = sanSettings(data); if (!same(v, D.settings)) { D.settings = v; changed = true; } } }
    else if (row.kind === 'cats') { if (!row.deleted) { const v = sanCats(data.list); if (!same(v, D.memoCats)) { D.memoCats = v; changed = true; } } }
    else if (row.kind === 'event' || row.kind === 'dday' || row.kind === 'memo') {
      const key = { event: 'events', dday: 'ddays', memo: 'memos' }[row.kind];
      const fn = { event: sanEvent, dday: sanDday, memo: sanMemo }[row.kind];
      const list = D[key], i = list.findIndex(x => x.id === row.id);
      const clean = row.deleted ? null : fn({ ...data, id: row.id });
      if (clean) { clean.id = row.id; if (i < 0) { list.push(clean); changed = true; } else if (!same(clean, fn(list[i]))) { list[i] = clean; changed = true; } }
      else if (i >= 0) { list.splice(i, 1); changed = true; }
    } else return false;
    // 받은 내용을 기준점으로 기록 (다시 올려 보내지 않게)
    const item = this.itemsOf(D).find(x => x.id === row.id);
    if (item) this.meta.snap[row.id] = item.kind + ':' + fnv(JSON.stringify(item.data));
    else delete this.meta.snap[row.id];
    return changed;
  },
  afterRemote() {
    Store.saveLocal(D);
    this.saveMeta();
    computeMilestones();
    render();
  },

  /* ---------- 사진 받기 ---------- */
  applyPhoto(row) {
    const id = row.id;
    if (row.deleted) {
      PhotoStore.remove(id).catch(() => {});
      if (removePhotoFromMap(id) && tab === 'cal') renderCal();
      return;
    }
    const date = row.data && isDate(row.data.date) ? row.data.date : '';
    if (!date || findPhoto(id)) return;
    const created = row.data && Number.isFinite(row.data.created) ? row.data.created : 0;
    // 썸네일은 한 장씩 차례로 받음
    this.dl = this.dl.then(async () => {
      if (findPhoto(id) || !this.online()) return;
      const { data, error } = await this.sb.storage.from('photos').download(this.path(id, true));
      if (error || !data) return;
      await PhotoStore.putThumb({ id, date, created, thumb: data });
      addPhotoToMap(id, date, created, data);
      photoReady = true;
      if (tab === 'cal') renderCal();
    }).catch(() => {});
  },
  async fetchFull(id) {
    if (!this.online()) return null;
    try {
      const { data, error } = await this.sb.storage.from('photos').download(this.path(id, false));
      if (error || !data) return null;
      await PhotoStore.putFull(id, data).catch(() => {});
      return data;
    } catch (e) { return null; }
  },

  /* ---------- 실시간 ---------- */
  subscribe() {
    if (!this.online()) return;
    this.stopRealtime();
    this.channel = this.sb.channel('items-' + this.meta.coupleId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: 'couple_id=eq.' + this.meta.coupleId }, p => {
        const row = p.new;
        if (row && row.id && this.applyRow(row)) this.afterRemote();
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') this.pull();
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') this.retryLater();
      });
  },
  stopRealtime() {
    if (this.channel && this.sb) { try { this.sb.removeChannel(this.channel); } catch (e) {} }
    this.channel = null;
  }
};
window.Sync = Sync;
