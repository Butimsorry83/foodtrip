/* 식도락 여행 — app.js
 * 데이터: data/db.json (GitHub 저장소). 토큰이 있으면 GitHub API로 읽고 쓰며, 없으면 읽기 전용.
 * 지도: Leaflet + OSM(CARTO) 타일. 좌표 검색: 카카오 SDK(국내) / Nominatim(해외).
 */
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const CFG = {
  repo: 'Butimsorry83/foodtrip',        // GitHub owner/repo (설정에서 변경 가능)
  branch: 'main',
  path: 'data/db.json',
};
const OFFLINE = !!window.EMBED_DB;   // 단일 HTML(오프라인) 빌드 여부
const LS = {
  get(k, d) { try { const v = localStorage.getItem('ft.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ft.' + k, JSON.stringify(v)); } catch {} },
};
const REGION_LABEL = { domestic: '국내', nhatrang: '나트랑', danang: '다낭', bangkok: '방콕', guam: '괌', pyeongchang: '평창' };
const CUISINE_COLOR = { '한식': '#c0392b', '중식': '#d35400', '일식': '#7d3c98', '양식': '#2471a3', '기타': '#7f8c8d',
  '현지': '#c0392b', '해산물': '#1b7f8c', '쌀국수': '#d4a017', 'BBQ': '#8e3b1f', '카페': '#6d4c41' };
const SPOT_COLOR = '#14213d';
const TAGS = {
  restaurant: ['아이동반', '놀이방', '유모차', '좌식', '주차', '예약필수', '웨이팅', '노키즈존', '어르신OK', '매운맛', '한국입맛', '미슐랭', '블루리본', '픽드랍', '배달', '카드수수료無'],
  spot: ['실내', '야외', '물놀이', '체험', '동물', '역사·문화', '놀이시설', '무료', '유아OK', '초등추천', '어르신OK', '눈썰매', '매점'],
  mine: ['본가', '처가', '친척', '친구', '단골', '캠핑', '아지트', '주차가능'],   // 우리 장소 (시안 외 추가)
};
const isMine = p => p?.type === 'mine';
function kindLabel(p) { return p.type === 'spot' ? '휴양지' : isMine(p) ? '우리 장소' : (cuisineOf(p)[0] || '식당'); }
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const PARK_TYPES = ['공영', '민영유료', '무료', '노상', '전용', '없음', '미확인'];
const CROWD = ['여유', '주말붐빔', '항상붐빔'];
const PUBLIC_RE = /공영|공용|시영|구영|군영|노외|시립|공공|public|municipal/i;

const S = {
  db: null, sha: null,
  base: null,
  view: 'list', mobileView: 'map',
  scope: 'all', region: 'domestic', flags: new Set(), tags: new Set(), q: '', sort: 'dist',
  sel: null, trip: null, tripDay: 0,
  token: LS.get('token', ''), repo: LS.get('repo', CFG.repo),
  markers: new Map(), baseMarker: null, ring: null,
  kakaoReady: false,
};

/* ---------------- 유틸 ---------------- */
function haversine(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function fmtKm(km) { return km == null ? '—' : km < 10 ? km.toFixed(1) : Math.round(km).toString(); }
function roadEst(km, country) {           // 직선 → 도로거리·소요시간 추정 (국내 1.3배·55km/h, 해외 1.4배·35km/h)
  if (km == null) return null;
  const f = country === 'KR' ? (km > 80 ? 1.2 : 1.3) : 1.4;
  const v = country === 'KR' ? (km > 150 ? 85 : km > 60 ? 70 : 55) : 35;   // 장거리는 고속도로 속도 (덕소→남해 390km ≈ 4.7h)
  const road = km * f; return { road, min: Math.round(road / v * 60) + 5 };
}
function fmtMin(m) { return m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; }
function stars(n) { return n ? '★'.repeat(n) + '<span style="opacity:.25">' + '★'.repeat(5 - n) + '</span>' : '<span style="opacity:.35">미평가</span>'; }
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._t); t._t = setTimeout(() => t.hidden = true, ms); }
function uid(p = 'p') { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function placeById(id) { return S.db.places.find(p => p.id === id) || S.tmpPlaces?.get(id); }   // tmp: 플래너가 카카오에서 임시로 가져온 현지 관광지
function cuisineOf(p) { return Array.isArray(p.cuisine) ? p.cuisine : (p.cuisine ? [p.cuisine] : []); }
function colorOf(p) { if (p.type === 'spot') return SPOT_COLOR; if (isMine(p)) return '#8a5a9e'; const c = cuisineOf(p)[0]; return CUISINE_COLOR[c] || '#7f8c8d'; }
function hasCoord(p) { return typeof p.lat === 'number' && typeof p.lng === 'number'; }
function baseFor(p) {                                        // 장소 나라에 맞는 거점: 국내 장소는 집, 해외는 그 지역 거점 (나트랑 여행 보던 중 국내 장소 열어도 '깜란 출발' 안 뜨게)
  const b = S.base; if (!p || !b || b.country === p.country) return b;
  return S.db.bases.find(x => x.default_for === p.region) || S.db.bases.find(x => x.country === p.country) || b;
}
function distFromBase(p) { const b = baseFor(p); return hasCoord(p) && b ? haversine(b, p) : null; }
function regionsInDb() {
  const set = new Map();
  for (const p of S.db.places) set.set(p.region, (set.get(p.region) || 0) + 1);
  return [...set.entries()];
}
function regionCountry(region) { const p = S.db.places.find(x => x.region === region); return p ? p.country : 'KR'; }
function areaOf(p) { return [...new Set([p.do, p.si].filter(Boolean))].join(' '); }
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function toMin(hhmm) { const m = /^(\d{1,2}):?(\d{2})$/.exec((hhmm || '').trim()); return m ? (+m[1]) * 60 + (+m[2]) : null; }
/* 영업 상태: open | break | closed | dayoff | null(정보 없음) */
function openState(p, when = new Date()) {
  const h = p.hours; if (!h || (!h.open && !(h.closed || []).length)) return null;
  if ((h.closed || []).includes(DAYS[when.getDay()])) return 'dayoff';
  const o = toMin(h.open), c = toMin(h.close); if (o == null || c == null) return null;
  const now = when.getHours() * 60 + when.getMinutes();
  const inRange = c > o ? (now >= o && now < c) : (now >= o || now < c);   // 자정 넘김 허용
  if (!inRange) return 'closed';
  const bs = toMin(h.breakStart), be = toMin(h.breakEnd);
  if (bs != null && be != null && now >= bs && now < be) return 'break';
  return 'open';
}
const OPEN_LABEL = { open: ['영업중', 'ok'], break: ['브레이크', 'warn'], closed: ['영업종료', 'off'], dayoff: ['휴무일', 'off'] };
function parkBadge(p) {
  const k = p.parking; if (!k || !k.type || k.type === '미확인') return '';
  const cls = k.type === '공영' ? 'pk pub' : k.type === '없음' ? 'pk none' : 'pk';
  return `<span class="badge ${cls}">P ${esc(k.type)}${k.crowd === '항상붐빔' ? ' !' : ''}</span>`;
}
function migrate(db) {
  db.meta.family ||= { adults: 2, kids: [], seniors: 0, spicyOK: false, notes: '' };
  for (const p of db.places) { p.tags ||= []; p.visitLog ||= []; p.visits ||= 0; if (p.wish == null) p.wish = false; }
  return db;
}
function rawUrl(path) { return `https://raw.githubusercontent.com/${S.repo}/${CFG.branch}/${path}`; }

/* ---------------- 링크 ---------------- */
function links(p) {
  const name = encodeURIComponent(p.name.replace(/\s*\(.*?\)\s*/g, ' ').trim());
  const q = p.country === 'KR' ? encodeURIComponent(((p.si || '') + ' ' + p.name).trim()) : name;
  const out = {};
  out.naver = p.naver?.url || `https://map.naver.com/p/search/${q}`;
  out.kakao = p.kakao?.url || `https://map.kakao.com/?q=${q}`;
  out.google = p.google?.url || (hasCoord(p) ? `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name + ' ' + (p.address || ''))}`);
  if (S.base && hasCoord(p)) {
    const b = S.base, bn = encodeURIComponent(b.name), pn = name;
    out.route_naver = `https://map.naver.com/p/directions/${b.lng},${b.lat},${bn}/${p.lng},${p.lat},${pn}/-/car`;
    out.route_kakao = `https://map.kakao.com/link/from/${bn},${b.lat},${b.lng}/to/${pn},${p.lat},${p.lng}`;
    out.route_google = `https://www.google.com/maps/dir/?api=1&origin=${b.lat},${b.lng}&destination=${p.lat},${p.lng}&travelmode=driving`;
    out.route_naver_app = `nmap://route/car?slat=${b.lat}&slng=${b.lng}&sname=${bn}&dlat=${p.lat}&dlng=${p.lng}&dname=${pn}&appname=foodtrip`;
  }
  return out;
}

/* ---------------- 데이터 로드/저장 ---------------- */
async function ghGet() {
  const url = `https://api.github.com/repos/${S.repo}/contents/${CFG.path}?ref=${CFG.branch}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  const txt = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), c => c.charCodeAt(0)));
  return { db: JSON.parse(txt), sha: j.sha };
}
async function load() {
  setSync('busy');
  try {
    if (S.token && !OFFLINE) { const { db, sha } = await ghGet(); S.db = db; S.sha = sha; setSync('ok'); }
    else if (OFFLINE) {
      const local = LS.get('localdb', null);
      S.db = local && (local.meta?.updated || '') >= (window.EMBED_DB.meta?.updated || '') ? local : JSON.parse(JSON.stringify(window.EMBED_DB));
      setSync('local');
    }
    else {
      const r = await fetch(`data/db.json?v=${Date.now()}`);
      S.db = await r.json(); setSync('local');
    }
  } catch (e) {
    console.error(e); toast('데이터 불러오기 실패: ' + e.message, 4000);
    try { const r = await fetch(`data/db.json?v=${Date.now()}`); S.db = await r.json(); setSync('err'); } catch {}
  }
  if (!S.db) S.db = { meta: {}, bases: [], places: [], trips: [] };
  S.db.bases ||= []; S.db.places ||= []; S.db.trips ||= []; S.db.meta ||= {}; S.db.trash ||= [];
  migrate(S.db);
  if (trashPurge() > 0 && S.token) markDirty();
  S.baseDb = clone(S.db);                                       // 3-way 병합 기준 (마지막으로 서버와 일치한 상태)
}
/* 사진 등 신규 파일 업로드 (base64 본문) */
async function ghPutFile(path, b64, msg) {
  if (!S.token) throw new Error('토큰 필요');
  const r = await fetch(`https://api.github.com/repos/${S.repo}/contents/${path}`, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg || 'jjtrip: photo', content: b64, branch: CFG.branch }),
  });
  if (!r.ok) throw new Error('업로드 실패 ' + r.status);
  return path;
}
/* 이미지 → 최대 1280px JPEG base64 */
function resizeImage(file, max = 1280) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', 0.82).split(',')[1]);
    };
    img.onerror = () => rej(new Error('이미지 읽기 실패')); img.src = url;
  });
}
function b64utf8(str) {                       // 큰 문자열도 스택 넘침 없이 base64 (UTF-8)
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
/* ---------------- 저장 충돌 병합 (3-way) · 휴지통 ---------------- */
const clone = o => JSON.parse(JSON.stringify(o));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function mergeItem(base, mine, theirs) {                       // 같은 id: 내가 안 바꿨으면 상대 것, 상대가 안 바꿨으면 내 것, 둘 다면 필드별
  if (!base) return mine;                                       // 둘 다 새로 추가(동일 id) — 내 것 우선
  if (same(mine, base)) return theirs; if (same(theirs, base)) return mine;
  const out = { ...theirs };
  for (const k of new Set([...Object.keys(mine), ...Object.keys(base)])) {
    if (k === 'visitLog') { const ids = new Set(); out.visitLog = [...(theirs.visitLog || []), ...(mine.visitLog || [])].filter(v => { const key = v.id || (v.date + '|' + (v.memo || '') + '|' + (v.who || []).join(',')); if (ids.has(key)) return false; ids.add(key); return true; }).sort((a, b) => (a.date || '').localeCompare(b.date || '')); out.visits = Math.max(mine.visits || 0, theirs.visits || 0, out.visitLog.length); continue; }
    if (k === 'tags') { out.tags = [...new Set([...(theirs.tags || []), ...(mine.tags || []).filter(t => !(base.tags || []).includes(t) || (theirs.tags || []).includes(t))])].filter(t => (mine.tags || []).includes(t) || !(base.tags || []).includes(t)); continue; }
    if (k === 'visits' && 'visitLog' in out) continue;
    if (!same(mine[k], base[k])) out[k] = mine[k];              // 내가 바꾼 필드는 내 것
  }
  return out;
}
function mergeList(baseL, mineL, theirsL) {
  const B = new Map((baseL || []).map(x => [x.id, x])), M = new Map((mineL || []).map(x => [x.id, x])), T = new Map((theirsL || []).map(x => [x.id, x]));
  const out = []; const seen = new Set();
  for (const [id, t] of T) { seen.add(id); const m = M.get(id), b = B.get(id);
    if (m) out.push(mergeItem(b, m, t)); else if (!b) out.push(t); else if (!same(b, t)) out.push(t); /* 내가 지웠지만 상대가 수정 → 살림 */ }
  for (const [id, m] of M) { if (seen.has(id)) continue; const b = B.get(id);
    if (!b) out.push(m); else if (!same(b, m)) out.push(m); /* 상대가 지웠지만 내가 수정 → 살림 */ }
  return out;
}
function mergeDb(base, mine, theirs) {
  const out = { ...theirs };
  for (const k of ['places', 'trips', 'bases']) out[k] = mergeList(base?.[k], mine[k], theirs[k]);
  out.trash = mergeList(base?.trash, mine.trash, theirs.trash);
  const trashed = new Set(out.trash.map(x => x.id));
  for (const k of ['places', 'trips', 'bases']) out[k] = out[k].filter(x => !trashed.has(x.id) || (!(base?.trash || []).some(z => z.id === x.id) && !(mine.trash || []).some(z => z.id === x.id) && (mine[k] || []).some(z => z.id === x.id && !same(z, (base?.[k] || []).find(y => y.id === x.id)))));
  out.meta = mergeItem(base?.meta || {}, mine.meta || {}, theirs.meta || {});
  out.meta.updated = [mine.meta?.updated, theirs.meta?.updated].filter(Boolean).sort().pop() || '';
  return out;
}
function trashPut(kind, item) {                               // 소프트 삭제: 휴지통에 30일 보관
  S.db.trash ||= []; S.db.trash.push({ id: item.id, kind, at: today(), name: item.name || item.title || '', item: clone(item) });
}
function trashRestore(id) {
  const i = (S.db.trash || []).findIndex(x => x.id === id); if (i < 0) return;
  const e = S.db.trash.splice(i, 1)[0]; const list = { place: S.db.places, trip: S.db.trips, base: S.db.bases }[e.kind];
  if (list && !list.some(x => x.id === e.id)) list.push(e.item); markDirty(); return e;
}
function trashPurge(days = 30) { const lim = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10); const n = (S.db.trash || []).length; S.db.trash = (S.db.trash || []).filter(x => (x.at || '') >= lim); return n - S.db.trash.length; }
let saveTimer = null, saving = false, dirty = false;
function markDirty() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200); S.homeStale = true; }
async function save() {
  if (OFFLINE) { S.db.meta.updated = new Date().toISOString().slice(0, 10); LS.set('localdb', S.db); setSync('ok'); return; }
  if (!S.token) { setSync('local'); toast('읽기 전용: 설정에서 GitHub 토큰을 입력하면 저장됩니다'); return; }
  if (saving) { dirty = true; return; }
  saving = true; dirty = false; setSync('busy');
  try {
    let remote = null; try { remote = await ghGet(); } catch {}
    if (remote && remote.sha !== S.sha) {                        // 다른 기기가 먼저 저장 → 3-way 병합 후 저장
      const merged = mergeDb(S.baseDb, S.db, migrate(remote.db)); const nBefore = S.db.places.length;
      S.db = merged; S.sha = remote.sha; S.baseDb = clone(remote.db);
      if (S.base) S.base = S.db.bases.find(b => b.id === S.base.id) || S.db.bases[0]; if (S.trip) S.trip = S.db.trips.find(t => t.id === S.trip.id) || null;
      toast(`다른 기기의 변경과 합쳤습니다 (장소 ${nBefore}→${S.db.places.length})`, 3000); S.homeStale = true;
      if (S.view === 'explore') renderList(); if (S.view === 'trips') renderTrips();
    } else if (remote) S.sha = remote.sha;
    S.db.meta.updated = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify(S.db);
    const b64 = b64utf8(body);
    const r = await fetch(`https://api.github.com/repos/${S.repo}/contents/${CFG.path}`, {
      method: 'PUT', headers: { Authorization: 'Bearer ' + S.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'foodtrip: update ' + S.db.meta.updated, content: b64, sha: S.sha, branch: CFG.branch }),
    });
    if (r.status === 409 || r.status === 422) {     // 경합 → 병합 경로로 1회 재시도
      S.sha = null; saving = false; S.retry = (S.retry || 0) + 1; if (S.retry <= 2) return save(); throw new Error('저장 경합 반복 — 잠시 후 다시');
    }
    if (!r.ok) throw new Error('저장 실패 ' + r.status);
    const j = await r.json(); S.sha = j.content.sha; S.baseDb = clone(S.db); S.retry = 0; setSync('ok');
  } catch (e) { console.error(e); setSync('err'); toast(e.message + ' — 1분 후 자동 재시도', 4000); clearTimeout(S.retryT); S.retryT = setTimeout(() => { if (!saving) save(); }, 60000); }
  saving = false; if (dirty) markDirty();
}
function setSync(st) { const el = $('#sync'); el.className = 'sync ' + st; el.title = { ok: 'GitHub 동기화됨', busy: '저장 중…', err: '저장 오류', local: '읽기 전용(토큰 없음)' }[st] || ''; }

/* ---------------- 지도 ---------------- */
let map;
function isDark() { const t = LS.get('theme', 'auto'); return t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches); }
function tileUrl() { return 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'; }   // CARTO가 키를 요구(2026)해 OSM 표준 타일로 교체 · 다크모드는 CSS 필터(style.css .dark-tiles)
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true }).setView([36.5, 127.8], 7);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  S.tiles = L.tileLayer(tileUrl(), {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  S.cluster = L.markerClusterGroup({ maxClusterRadius: 42, showCoverageOnHover: false, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 13,
    iconCreateFunction: c => { const ms = c.getAllChildMarkers(); const sp = ms.filter(m => m.options.kind === 'spot').length; const n = ms.length;
      const sz = n >= 50 ? 64 : n >= 10 ? 48 : 40;
      return L.divIcon({ className: '', html: `<div class="clu${n >= 50 ? ' big' : n < 10 ? ' sm' : ''}"><b>${n}</b>${sp ? `<small>휴 ${sp}</small>` : ''}</div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] }); } });
  map.addLayer(S.cluster);
  map.on('click', e => {
    if (S.pickFor) { const p = placeById(S.pickFor); S.pickFor = null; map.getContainer().classList.remove('picking'); if (p) { p.lat = +e.latlng.lat.toFixed(6); p.lng = +e.latlng.lng.toFixed(6); p.geo_src = '직접'; markDirty(); renderList(); toast(`위치 저장: ${p.name}`); openDetail(p.id); } return; }
    if (S.sel) { S.sel = null; renderList(); } drawRoute(null); });
  map.getContainer().addEventListener('click', e => { const b = e.target.closest('.popcard [data-detail]'); if (b) { e.stopPropagation(); openDetail(b.dataset.detail); } });
}
function pinIcon(p, sel) {
  return L.divIcon({ className: '', html: `<div class="pin${p.type === 'spot' ? ' spot' : isMine(p) ? ' mine' : ''}${sel ? ' sel' : ''}" style="background:${catColor(p)}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
}
function renderMarkers() {
  const visible = new Set(filtered().map(p => p.id));
  for (const [id, m] of S.markers) if (!visible.has(id)) { S.cluster.removeLayer(m); S.markers.delete(id); }
  for (const p of S.db.places) {
    if (!visible.has(p.id) || !hasCoord(p)) continue;
    let m = S.markers.get(p.id);
    if (!m) {
      m = L.marker([p.lat, p.lng], { icon: pinIcon(p, false), kind: p.type }); S.cluster.addLayer(m);
      m.on('click', () => window.innerWidth <= 860 ? openDetail(p.id) : selectOnMap(p.id));
      m.bindTooltip(p.name, { direction: 'top', offset: [0, -6] });
      S.markers.set(p.id, m);
    } else m.setLatLng([p.lat, p.lng]);
    m.setIcon(pinIcon(p, S.sel === p.id));
    m.setZIndexOffset(S.sel === p.id ? 1000 : 0);
  }
  renderBaseMarker();
}
function renderBaseMarker() {
  if (S.baseMarker) { map.removeLayer(S.baseMarker); S.baseMarker = null; }
  if (S.ring) { map.removeLayer(S.ring); S.ring = null; }
  if (!S.base) return;
  S.baseMarker = L.marker([S.base.lat, S.base.lng], { icon: L.divIcon({ className: '', html: '<div class="basepin">⌂</div>', iconSize: [38, 38], iconAnchor: [19, 19] }), zIndexOffset: 2000 }).addTo(map);
  S.baseMarker.bindTooltip('거점: ' + S.base.name, { direction: 'top', offset: [0, -10] });
  S.ring = L.layerGroup([10, 30, 60].map(km => L.circle([S.base.lat, S.base.lng], { radius: km * 1000, color: '#f2b134', weight: 1, dashArray: '4 6', fill: false, interactive: false, className: 'ring' }))).addTo(map);
}
function selectOnMap(id) {                                    // W2: 핀/행 선택 → 지도 위 카드 (상세는 '상세 →')
  const p = placeById(id); if (!p) return; S.sel = id; renderList();
  if (!hasCoord(p)) return;
  const d = distInfo(p), dl = distFromBase(p), L_ = links(p);
  const html = `<div class="popcard"><div class="top">${thumbHtml(p, 'tile')}<div style="flex:1;min-width:0"><b class="nm">${esc(p.name)}</b><p class="sub">${esc([kindLabel(p), areaOf(p)].filter(Boolean).join(' · '))}</p><p class="dist">${dl != null ? `직선 ${fmtKm(dl)} · ` : ''}${d ? `${d.real ? '실경로' : '도로'} ${fmtKm(d.km)}km · <b>${minText(d.min)}</b>` : '위치 없음'}</p></div></div>
    <div class="acts"><a class="n" href="${L_.route_naver || L_.naver}" target="_blank" rel="noopener">N 길찾기</a><a class="k" href="${L_.route_kakao || L_.kakao}" target="_blank" rel="noopener">카카오</a><button data-detail="${p.id}">상세 →</button></div></div>`;
  const pop = L.popup({ closeButton: false, autoPan: true, offset: [0, -10], maxWidth: 360 }).setLatLng([p.lat, p.lng]).setContent(html).openOn(map);
}
function fitToVisible() {
  const pts = filtered().filter(hasCoord).map(p => [p.lat, p.lng]);
  if (S.base) pts.push([S.base.lat, S.base.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 });
}

/* ---------------- 거점 ---------------- */
function setBase(id, silent) {
  S.base = S.db.bases.find(b => b.id === id) || S.db.bases[0] || null;
  LS.set('base', S.base?.id);
  $('#base-name').textContent = S.base ? S.base.name : '거점 없음'; $('#base-name2') && ($('#base-name2').textContent = baseShort()); $('#base-chip-name') && ($('#base-chip-name').textContent = baseShort());
  renderBaseMarker(); renderList();
  if (!silent && S.base) { map.setView([S.base.lat, S.base.lng], Math.max(map.getZoom(), 9)); toast('거점: ' + S.base.name); }
}
function baseMenu() {                                          // 04 거점 선택 시트
  closeMenu();
  const ico = b => b.id === 'b_home' ? '<span class="bi home">⌂</span>' : `<span class="bi hotel"><svg class="i" viewBox="0 0 24 24"><path d="M3 21V9l9-6 9 6v12M9 21v-6h6v6"></path></svg></span>`;
  openSheet(`<div class="base-pick">
    <div class="grip2"></div>
    <div class="bp-h"><b>어디서 출발할까요?</b><button class="lnk rw" data-act="edit-bases">편집</button></div>
    <p class="bp-sub">거리·경로·추천이 모두 이 거점 기준으로 바뀝니다</p>
    <div class="bp-list">${S.db.bases.map(b => `<button class="bp-row${S.base?.id === b.id ? ' on' : ''}" data-id="${b.id}">${ico(b)}<span class="t"><b>${esc(b.name)}</b><p>${esc(b.note || areaOf(b) || '')}${b.default_for ? ` · <em>${esc(REGION_LABEL[b.default_for] || b.default_for)} 기본</em>` : ''}${b.approx ? ' · 좌표 추정' : ''}</p></span>${S.base?.id === b.id ? '<span class="ck">✓</span>' : ''}</button>`).join('')}
      <button class="bp-row" data-id="__geo"><span class="bi geo">${ICO.loc}</span><span class="t"><b>지금 내 위치</b><p>여행 중 즉석으로 · 저장 안 함</p></span></button></div>
    <button class="bp-cta rw" data-id="__add">+ 새 거점 추가 (호텔·숙소)</button></div>`);
  $('#sheet-inner').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'edit-bases') { S.baseEdit = !S.baseEdit; closeSheet(); showView('settings'); return; }
    const id = b.dataset.id; if (!id) return;
    if (id === '__add') return openBaseForm();
    if (id === '__geo') { if (!navigator.geolocation) return toast('위치 사용 불가'); navigator.geolocation.getCurrentPosition(pos => { S.base = { id: '__geo', name: '지금 내 위치', lat: pos.coords.latitude, lng: pos.coords.longitude, country: 'KR' }; $('#base-name').textContent = S.base.name; $('#base-name2') && ($('#base-name2').textContent = '내 위치'); $('#base-chip-name') && ($('#base-chip-name').textContent = '내 위치'); renderBaseMarker(); renderList(); map.setView([S.base.lat, S.base.lng], 12); closeSheet(); toast('거점: 지금 내 위치'); }, () => toast('위치 권한 필요')); return; }
    closeSheet(); setBase(id);
  };
}
function closeMenu() { $('#menu')?.remove(); }
function openBaseForm(base) {
  const b = base || { id: uid('b'), name: '', country: S.region === 'domestic' ? 'KR' : regionCountry(S.region), lat: '', lng: '', note: '' };
  openSheet(`
    <div class="sheet-head"><h2>${base ? '거점 수정' : '거점 추가'}</h2><button class="close" data-act="close">✕</button></div>
    <form class="form" id="base-form">
      <label>이름<input name="name" value="${esc(b.name)}" required placeholder="예: 하얏트 리젠시 다낭"></label>
      <div class="inline"><label>주소·장소 검색<input id="bq" placeholder="호텔명 또는 주소"></label><button type="button" class="primary" data-act="bsearch">검색</button></div>
      <div class="hits" id="bhits" hidden></div>
      <div class="three">
        <label>국가<select name="country"><option value="KR"${b.country === 'KR' ? ' selected' : ''}>KR</option><option value="VN"${b.country === 'VN' ? ' selected' : ''}>VN</option><option value="TH"${b.country === 'TH' ? ' selected' : ''}>TH</option><option value="GU"${b.country === 'GU' ? ' selected' : ''}>GU</option><option value="JP">JP</option><option value="OTHER">기타</option></select></label>
        <label>위도<input name="lat" value="${b.lat}" required inputmode="decimal"></label>
        <label>경도<input name="lng" value="${b.lng}" required inputmode="decimal"></label>
      </div>
      <label>메모<input name="note" value="${esc(b.note || '')}"></label>
      <div class="btns"><button type="button" data-act="geoloc">📍 현재 위치 사용</button><button type="submit" class="primary">저장</button>${base ? '<button type="button" class="danger" data-act="bdel">삭제</button>' : ''}</div>
    </form>`);
  const f = $('#base-form');
  f.addEventListener('submit', e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    Object.assign(b, { name: d.name.trim(), country: d.country, lat: +d.lat, lng: +d.lng, note: d.note.trim(), approx: false });
    if (!S.db.bases.includes(b)) S.db.bases.push(b);
    markDirty(); closeSheet(); setBase(b.id); renderSettings();
  });
  f.addEventListener('click', async e => {
    const act = e.target.dataset.act;
    if (act === 'geoloc') navigator.geolocation?.getCurrentPosition(pos => { f.lat.value = pos.coords.latitude.toFixed(6); f.lng.value = pos.coords.longitude.toFixed(6); toast('현재 위치 입력됨'); }, () => toast('위치 권한 거부됨'));
    if (act === 'bsearch') { const hits = await geoSearch($('#bq').value, f.country.value); showHits($('#bhits'), hits, h => { f.name.value ||= h.name; f.lat.value = h.lat; f.lng.value = h.lng; }); }
    if (act === 'bdel') { trashPut('base', b); S.db.bases = S.db.bases.filter(x => x !== b); markDirty(); closeSheet(); setBase(S.db.bases[0]?.id); renderSettings(); }
  });
}

/* ---------------- 필터·목록 ---------------- */
function filtered() {
  const q = S.q.trim().toLowerCase();
  return S.db.places.filter(p => {
    if (S.scope !== 'all' && p.type !== S.scope) return false;
    if (S.region !== 'all' && p.region !== S.region) return false;
    for (const f of S.flags) {
      if (['봄', '여름', '가을', '겨울'].includes(f)) {
        if (p.type === 'spot' && !(p.seasons || []).includes(f)) return false;
        if (p.type === 'restaurant') { const sp = p.spot_id && placeById(p.spot_id); if (sp && !(sp.seasons || []).includes(f)) return false; }
      }
      if (f === 'unvisited' && (p.visits || 0) > 0) return false;
      if (f === 'saved' && !p.naver?.saved) return false;
      if (f === 'wish' && !p.wish) return false;
      if (f === 'open' && openState(p) !== 'open') return false;
    }
    for (const t of S.tags) if (!(p.tags || []).includes(t)) return false;
    if (S.radius && S.base) { const dk = distInfo(p)?.km; if (dk != null && dk > S.radius) return false; }
    if (q) {
      const hay = [p.name, p.si, p.do, p.zone, p.address, p.desc, p.pros, p.cons, p.signature, p.note, p.spot_name, ...cuisineOf(p), ...(p.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
function sorted(list) {
  const key = S.sort;
  return list.slice().sort((a, b) => {
    if (key === 'dist') { const da = distFromBase(a), db = distFromBase(b); if (da == null && db == null) return 0; if (da == null) return 1; if (db == null) return -1; return da - db; }
    if (key === 'rating') return (ratingOf(b) - ratingOf(a)) || a.name.localeCompare(b.name, 'ko');
    if (key === 'reviews') return ((b.naver?.reviews || 0) - (a.naver?.reviews || 0)) || a.name.localeCompare(b.name, 'ko');
    return a.name.localeCompare(b.name, 'ko');
  });
}
function ratingOf(p) { if (p.rating) return p.rating; if (p.type === 'restaurant' && p.spot_id) return placeById(p.spot_id)?.rating || 0; return 0; }
function renderRegionChips() {
  const el = $('#f-region'); if (!el) return;
  const regs = regionsInDb();
  el.innerHTML = regs.map(([r, n]) => `<button data-v="${r}" class="${S.region === r ? 'on' : ''}">${REGION_LABEL[r] || r} <span class="mono" style="opacity:.6">${n}</span></button>`).join('')
    + `<button data-v="all" class="${S.region === 'all' ? 'on' : ''}">전체</button>`;
  const dd = $('#region-dd'); if (dd) { dd.textContent = (S.region === 'all' ? '전체 지역' : REGION_LABEL[S.region] || S.region) + ' ▾'; dd.classList.toggle('on', S.region !== 'all'); }
  const sd = $('#season-dd'); if (sd) { const cur = ['봄', '여름', '가을', '겨울'].find(x => S.flags.has(x)); sd.textContent = (cur || '계절') + ' ▾'; sd.classList.toggle('on', !!cur); }
  $$('#f-season button[data-v]').forEach(x => x.classList.toggle('on', S.flags.has(x.dataset.v)));
  $('#base-name2') && ($('#base-name2').textContent = baseShort());
  $('#base-chip-name') && ($('#base-chip-name').textContent = baseShort());
}
function pickMenu(anchor, items, onPick) {                      // 칩 드롭다운 (지역·계절)
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.id = 'menu';
  m.innerHTML = items.map(([v, label, on]) => `<button data-v="${esc(v)}" class="${on ? 'on' : ''}">${label}</button>`).join('');
  m.onclick = e => { const b = e.target.closest('button'); if (!b) return; onPick(b.dataset.v); closeMenu(); };
  document.body.appendChild(m); const r = anchor.getBoundingClientRect(); m.style.left = Math.min(r.left, window.innerWidth - 250) + 'px'; m.style.top = (r.bottom + 6) + 'px'; m.style.position = 'fixed';
  S.menu = m; setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function renderTagChips() {
  const pool = TAGS[S.scope] || [...TAGS.spot, ...TAGS.restaurant, ...TAGS.mine];
  const cnt = new Map();
  for (const p of S.db.places) if (S.region === 'all' || p.region === S.region) for (const t of p.tags || []) cnt.set(t, (cnt.get(t) || 0) + 1);
  for (const t of [...S.tags]) if (!pool.includes(t)) S.tags.delete(t);
  const shown = [...new Set(pool)].filter(t => cnt.get(t) || S.tags.has(t));
  const top = shown.slice().sort((a, b) => (cnt.get(b) || 0) - (cnt.get(a) || 0));
  const lim = S.tagsMore ? top : [...new Set([...top.slice(0, 4), ...[...S.tags]])];
  $('#f-tags').innerHTML = lim.map(t => `<button data-v="${esc(t)}" class="${S.tags.has(t) ? 'on' : ''}">#${esc(t)}</button>`).join('') + (top.length > 4 ? `<button class="more" data-more="1">${S.tagsMore ? '접기' : `+${top.length - lim.length}`}</button>` : '');
}
function rowLine3(p, sub = false) {                       // 목록 셋째 줄 규칙(12): 영업 상태 → 방문 횟수 → P공영(거리) → 필터와 겹치는 태그, 최대 3개 + N
  const items = [];
  const os = openState(p);
  if (os) items.push(`<span class="${OPEN_LABEL[os][1] === 'ok' ? 'ok' : OPEN_LABEL[os][1] === 'warn' ? 'warn' : 'off'}">${OPEN_LABEL[os][0]}</span>`);
  else if (p.hours?.open && os !== 'open') items.push(`<span class="off">${esc(p.hours.open)} 오픈</span>`);
  if (p.visits) items.push(`<span class="g">방문 ${p.visits}회</span>`);
  const lot = (p.parking?.lots || []).find(l => l.public) || (p.parking?.type === '공영' ? { name: '공영' } : null);
  if (lot) items.push(`<span class="pk">P공영${lot.dist != null ? `(${Math.round(lot.dist)}m)` : ''}</span>`);
  const tags = (p.tags || []).filter(t => S.tags.size ? S.tags.has(t) : true);
  for (const t of tags) items.push(`<span class="g">#${esc(t)}</span>`);
  const shown = items.slice(0, 3); const more = items.length - shown.length;
  return shown.join('') + (more > 0 ? `<span class="g">+${more}</span>` : '');
}
function rowHtml(p) {
  const d = distInfo(p);
  const sub = isMine(p) ? [(p.tags || [])[0] || '우리 장소', areaOf(p)] : p.type === 'spot' ? [areaOf(p), (p.seasons || []).join('·')] : [cuisineOf(p)[0], areaOf(p), p.spot_name ? p.spot_name + ' 근처' : (p.zone || '')];
  return `<button class="row${S.sel === p.id ? ' sel' : ''}" data-id="${p.id}">
    ${thumbHtml(p, 'tile')}
    <span class="main"><span class="name"><b>${esc(p.name)}</b>${p.naver?.saved ? '<span class="nv">N✔</span>' : ''}${p.wish ? '<span class="ws">★</span>' : ''}</span>
      <span class="sub">${sub.filter(Boolean).map(esc).join(' · ')}</span>
      <span class="st">${rowLine3(p)}</span></span>
    <span class="dist">${d ? `<b>${fmtKm(d.km)}<small>km</small></b><p>${minText(d.min)}</p>` : '<span class="none">위치 없음</span>'}</span>
  </button>`;
}
function filterCount() { return S.flags.size + S.tags.size + (S.scope !== 'all' ? 1 : 0) + (S.radius ? 1 : 0); }
function emptyHtml() {                                         // 시안 11a: 결과 없음
  const where = S.region === 'all' ? '내 리스트' : (REGION_LABEL[S.region] || S.region), n = filterCount(), q = S.q.trim();
  const sub = [q ? `「${esc(q)}」` : '', n ? `필터 ${n}개 적용 중` : '', S.radius ? `${S.radius}km 이내` : ''].filter(Boolean).join(' · ') || '등록된 장소 없음';
  const nextKm = S.radius ? ({ 10: 30, 30: 60, 60: null })[S.radius] : null;
  return `<div class="empty11"><img src="${asset('assets/mark-globe.png')}" alt=""><b>${esc(where)}에서는 못 찾았어요</b><p class="cap">${sub}</p>
    <div class="acts">${n ? '<button class="btn line" data-act="clear">필터 모두 풀기</button>' : ''}${S.radius ? `<button class="btn line" data-act="km">${nextKm ? `반경 ${S.radius}km → ${nextKm}km` : '반경 제한 해제'}</button>` : ''}${S.region !== 'all' ? '<button class="btn line" data-act="allregion">전체 지역에서 찾기</button>' : ''}<button class="btn kakao rw" data-act="newplace">${(S.region === 'all' || regionCountry(S.region) === 'KR') ? '카카오에서 새로 찾기' : '구글에서 새로 찾기'}</button></div></div>`;
}
function emptyAct(act) {
  if (act === 'clear') { S.flags.clear(); S.tags.clear(); S.scope = 'all'; $$('#f-scope button').forEach(x => x.classList.toggle('on', x.dataset.v === 'all')); renderRegionChips(); renderTagChips(); renderList(); }
  if (act === 'km') { const nextKm = ({ 10: 30, 30: 60, 60: null })[S.radius] ?? null; S.radius = nextKm; LS.set('radius', S.radius); $$('#km-pills button').forEach(b => b.classList.toggle('on', S.radius != null && +b.dataset.km <= S.radius)); $('#fab-km').textContent = S.radius ? S.radius + 'km' : 'km'; $('#fab-km').classList.toggle('on', !!S.radius); renderList(); }
  if (act === 'allregion') { S.region = 'all'; LS.set('region', 'all'); renderRegionChips(); renderTagChips(); renderList(); fitToVisible(); }
  if (act === 'newplace') { const p = { id: uid(), type: 'restaurant', country: S.region === 'domestic' || S.region === 'all' ? 'KR' : regionCountry(S.region), region: S.region === 'all' ? 'domestic' : S.region, name: S.q.trim(), cuisine: [], seasons: [], rating: 0, visits: 0, naver: {}, kakao: {}, tags: [], visitLog: [] }; openPlaceForm(p); if (p.name) setTimeout(() => $('#pf [data-act=psearch]')?.click(), 50); }
}
function renderList() {
  const items = sorted(filtered());
  const sortLabel = { dist: '가까운 순', rating: '별점순', reviews: '네이버 리뷰순', name: '이름순' }[S.sort] || '';
  $('#count').textContent = items.length;
  $('#count-sub').textContent = (S.radius ? S.radius + 'km 이내 · ' : '') + sortLabel;
  $('#count2').innerHTML = `<b>${items.length}곳</b> <span>· ${S.radius ? S.radius + 'km 이내' : '전체'}</span>`;
  const el = $('#list');
  if (!items.length) { el.innerHTML = emptyHtml(); renderMarkers(); return; }
  el.innerHTML = items.map(rowHtml).join('');
  renderMarkers();
}

/* ---------------- 상세 ---------------- */
function openSheet(html) { const s = $('#sheet'); $('#sheet-inner').innerHTML = html; s.hidden = false; $('#sheet-inner').scrollTop = 0; const sc = $('#sheet-inner .sheet-scroll'); if (sc) sc.scrollTop = 0; }
function closeSheet() { $('#sheet').hidden = true; }
function nocoordHtml(p) {                                       // 시안 11c: 좌표 없음
  const ap = approxCoord(p);
  return `<div class="nocoord"><div class="box"><span class="q">?</span><b>지도 위치가 없어요</b><p class="cap">${ap ? `${esc(p.si || areaOf(p))} 중심으로 대략 계산 중 · 정확한 거리·경로는 위치 지정 후` : '주소만 있고 좌표가 없어 거리·경로를 계산할 수 없어요'}</p></div>
    <div class="field"><span class="cap">주소</span><span class="v">${esc(p.address || [p.do, p.si, p.zone].filter(Boolean).join(' ') || '주소 없음')}</span></div>
    <button class="btn pri rw" data-act="geocode">주소로 위치 찾기 (${p.country === 'KR' ? '카카오' : googleKey() ? '구글' : 'OSM'})</button>
    <button class="btn line rw" data-act="pinpick">지도에서 직접 찍기</button></div>`;
}
function startPinPick(p) {
  closeSheet(); showView('map'); S.pickFor = p.id;
  const ap = approxCoord(p); if (ap) map.setView([ap.lat, ap.lng], 12);
  map.getContainer().classList.add('picking');
  toast(`지도를 탭해서 「${p.name}」 위치 지정 · 다시 열려면 목록에서 선택`, 4000);
}
function openDetail(id) {
  const p = placeById(id); if (!p) return;
  S.sel = id; renderList();
  drawRoute(null);
  if (hasCoord(p)) { map.setView([p.lat, p.lng], Math.max(map.getZoom(), 13), { animate: S.view === 'explore' }); }
  const d = distFromBase(p), r = roadEst(d, p.country), L_ = links(p), di = distInfo(p);
  const spot = p.spot_id && placeById(p.spot_id);
  const rests = (p.restaurants || []).map(placeById).filter(Boolean);
  const kv = [];
  if (p.type === 'spot') { kv.push(['지역', areaOf(p)]); kv.push(['계절', (p.seasons || []).join(' · ') || '—']); if (p.lodging) kv.push(['숙박', p.lodging]); if (p.desc) kv.push(['설명', p.desc]); if (p.pros) kv.push(['장점', p.pros]); if (p.cons) kv.push(['단점', p.cons]); if (p.dist_home_km != null) kv.push(['집 기준', `${p.dist_home_km} km (엑셀)`]); }
  else { kv.push(['종류', cuisineOf(p).join(' · ') || '—']); if (spot) kv.push(['연계', spot.name]); if (p.zone) kv.push(['구역', p.zone + (p.ac ? ' · 에어컨' : '')]); if (p.signature) kv.push(['시그니처', p.signature]); if (p.pay?.length) kv.push(['결제', p.pay.join(' · ')]); if (p.dist_base_km != null) kv.push(['숙소 기준', `${p.dist_base_km} km · ${p.time_base_min}분 (엑셀)`]); }
  if (p.address) kv.push(['주소', p.address]);
  if (p.kakao?.phone) kv.push(['전화', p.kakao.phone]);
  if (p.note) kv.push(['비고', p.note]);
  const n = p.naver || {};
  const os = openState(p), h = p.hours, ol = os && OPEN_LABEL[os];
  const pk = p.parking || {};
  const tagPool = TAGS[p.type] || TAGS.restaurant;
  const extraTags = (p.tags || []).filter(t => !tagPool.includes(t));
  const img = imgOf(p), nPhotos = (p.visitLog || []).filter(v => v.photo).length + (p.basePhoto ? 1 : 0);
  const kind = isMine(p) ? '우리 장소' + ((p.tags || [])[0] ? ' · ' + p.tags[0] : '') : p.type === 'spot' ? '휴양지' + ((p.tags || [])[0] ? ' · ' + p.tags[0] : '') : cuisineOf(p).join(' · ') || '식당';
  const todayHrs = os === 'dayoff' ? '휴무' : h?.open ? (os === 'open' ? `~${h.close || ''}` : h.open) : null;
  const lots = (pk.lots || []).slice(0, 3);
  const cover = img
    ? `<div class="cover" style="--cat:${catColor(p)};background-image:url('${img}')"><div class="handle"></div><span class="cat-chip">${esc(kind)}</span><span class="nph">${familyPhoto(p) ? '우리 가족 사진' : '사진 한국관광공사'}${nPhotos > 1 ? ` · ${nPhotos}장` : ''}</span></div>`
    : `<div class="cover info" style="--cat:${catColor(p)}"><div class="handle"></div><span class="cat-chip">${esc(kind)}</span>
        <div class="stat3"><div><small>${esc(baseShort(p))}에서</small><b>${di ? fmtKm(di.km) + '<small>km</small>' : '—'}</b></div><div><small>차로</small><b>${di ? minText(di.min).replace(/(\d+)(시간|분)/g, '$1<small>$2</small>') : '—'}</b></div><div><small>${isMine(p) ? '분류' : '오늘'}</small><b>${isMine(p) ? `<small>${esc((p.tags || [])[0] || '우리 장소')}</small>` : todayHrs ? `<span class="mono" style="font-size:18px">${esc(todayHrs)}</span><small> ${os === 'dayoff' ? '' : os === 'open' ? '영업중' : '오픈'}</small>` : '<small>영업 미입력</small>'}</b></div></div>
        <div class="tags">${(p.tags || []).slice(0, 3).map(t => `<span>#${esc(t)}</span>`).join('')}</div>
        <div class="nophoto"><span>아직 사진이 없어요</span><button class="rw" data-act="visitlog">+ 첫 사진 올리기</button></div></div>`;
  openSheet(`
    <div class="sheet-scroll">
    <div style="position:relative">${cover}<div class="cover-acts"><button data-act="share" title="공유">↗</button><button data-act="close">✕</button></div></div>
    <div class="d-head">
      <div class="kind"><span class="chip" style="--cat:${catColor(p)}">${esc(kind)}</span><span>${esc(areaOf(p))}${p.address ? ' · ' + esc(p.address.replace(/^\S+\s/, '')) : ''}</span></div>
      <h1>${esc(p.name)}</h1>
      <div class="rt">${n.rating ? `<span><span class="nv">N</span> <span class="mono">${n.rating}</span>${n.reviews ? ` <span class="mono cnt">(${n.reviews.toLocaleString()})</span>` : ''}</span>` : ''}${p.google?.rating ? `<span><span class="gg">G</span> <span class="mono">${p.google.rating}</span>${p.google.reviews ? ` <span class="mono cnt">(${p.google.reviews.toLocaleString()})</span>` : ''}</span>` : ''}${ratingOf(p) ? `<span class="us">우리 ★${ratingOf(p)}.0</span>` : ''}${p.wish ? '<span class="us">★ 가고싶다</span>' : ''}${!n.rating && !p.google?.rating && !ratingOf(p) ? '<span style="color:var(--text-3)">평점 미입력 — 아래 더보기에서 입력</span>' : ''}</div>
    </div>
    ${roBanner()}${!hasCoord(p) ? nocoordHtml(p) : baseFor(p) ? `<div class="distbox${di?.real ? ' real' : ''}"><div><small>직선</small><b>${fmtKm(d)}<small>km</small></b></div><div><small>도로${di?.real ? '' : ' 추정'}</small><b>${di ? fmtKm(di.km) : '—'}<small>km</small></b></div><div><small>소요</small><b class="t">${di ? minText(di.min).replace(/(\d+)(시간|분)/g, '$1<small>$2</small>') : '—'}</b></div></div><p class="dist-cap">${esc(baseFor(p).name)} 출발 · ${di?.real ? '카카오 실경로' : '지금 기준 추정'}</p>` : ''}
    ${hasCoord(p) ? `<div class="d-map" id="d-map" title="찾기 지도에서 크게 보기"></div>` : ''}
    <div class="d-tags rw-chips">${tagPool.map(t => `<span class="chip ${(p.tags || []).includes(t) ? 'tag' : 'off'}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}${extraTags.map(t => `<span class="chip tag" data-tag="${esc(t)}">#${esc(t)}</span>`).join('')}<span class="chip plus" data-act="tagedit">＋ 태그</span></div>
    <div class="d-grid">
      <span>영업</span><div class="hrs">${h && (h.open || (h.closed || []).length) ? `${ol ? `<b class="${ol[1]}">${ol[0]}</b>` : '<b class="off">시간 등록</b>'}${h.lastOrder ? ` · ${esc(h.lastOrder)} 라스트오더` : h.close && os === 'open' ? ` · ${esc(h.close)} 마감` : ''}<p>${(h.closed || []).length ? `휴무 ${esc(h.closed.join('·'))} · ` : '매일 '}${esc(h.open || '?')}–${esc(h.close || '?')}${h.breakStart ? ` · 브레이크 ${esc(h.breakStart)}–${esc(h.breakEnd || '?')}` : ''}</p>` : '<span style="color:var(--text-3)">미입력</span>'} <button class="mini rw" data-act="hours">${h ? '수정' : '입력'}</button></div>
      <span>주차</span><div class="lots">${lots.length ? lots.map((l, i) => `<div class="lot"><span class="chip ${l.public ? 'pub' : 'paid'}">${l.public ? '공영' : '민영'}</span><span>${esc(l.name)}</span><span class="m">${l.dist != null ? Math.round(l.dist) + 'm' : ''}</span><span class="lot-a"><a class="mini k" href="https://map.kakao.com/link/to/${encodeURIComponent(l.name)},${l.lat},${l.lng}" target="_blank" rel="noopener">K</a><button class="mini ghost rw" data-unpin="${i}">✕</button></span></div>`).join('') : `<div class="lot">${pk.type ? `<span class="chip ${pk.type === '공영' ? 'pub' : 'paid'}">${esc(pk.type)}</span><span>${esc([pk.fee, pk.crowd, pk.note].filter(Boolean).join(' · ') || '상세 미입력')}</span>` : '<span style="color:var(--text-3)">미입력</span>'}</div>`}
        <div class="lot" style="gap:6px"><button class="mini" data-act="parkfind" ${hasCoord(p) ? '' : 'disabled'}>주변 주차장 찾기</button><button class="mini rw" data-act="parkedit">${pk.type ? '수정' : '입력'}</button></div><div id="lotfind"></div></div>
    </div>
    ${isMine(p) ? `<div class="d-sec"><div class="h"><b>거점</b><button data-act="asbase" ${hasCoord(p) ? '' : 'disabled'}>${S.db.bases.some(b => b.placeId === p.id) ? (S.base?.placeId === p.id ? '지금 거점 ✓' : '이 곳 기준으로 보기 →') : '거점으로 등록 →'}</button></div></div>` : ''}
    <div class="d-sec"><div class="h"><b>${p.type === 'spot' ? '근처 식당' : '이 근처'}</b><button data-act="reco" ${hasCoord(p) ? '' : 'disabled'}>${p.type === 'spot' ? '추천 보기 →' : '다른 식당 추천 →'}</button></div></div>
    <div class="d-sec"><div class="h"><b>방문 기록</b><span style="display:flex;gap:12px">${(p.visitLog || []).length ? '<button data-act="journal">모아보기</button>' : ''}<button class="rw" data-act="visitlog">+ 기록 추가</button></span></div>
      ${(p.visitLog || []).length ? `<div class="tl-v">${p.visitLog.slice().reverse().map((v, ri) => { const i = p.visitLog.length - 1 - ri;
        return `<div class="v${ri ? ' old' : ''}"><span class="dot"></span><div class="vh"><b class="mono">${esc((v.date || '').replace(/-/g, '.'))}</b><span class="st">${starsTxt(v.rating)}</span><button class="mini ghost rw" data-vdel="${i}" title="삭제">✕</button></div>${v.memo ? `<p>${esc(v.memo)}</p>` : ''}${v.photo ? `<img class="vphoto" src="${photoUrl(v.photo) || ''}" alt="방문 사진" loading="lazy">` : ''}${!ri ? `<img class="stamp" src="${asset('assets/mark-stamp.png')}" alt="">` : ''}</div>`; }).join('')}</div>`
      : `<div class="novisit"><img src="${asset('assets/mark-stamp.png')}" alt=""><div><b>아직 안 가본 곳</b><small>다녀오면 스탬프가 찍혀요</small></div></div>`}
    </div>
    ${rests.length ? `<div class="d-sec"><div class="h"><b>추천 식당 ${rests.length}</b></div><div class="sublist" style="margin:12px 0 0">${rests.map(x => `<button data-go="${x.id}"><span><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${catColor(x)};margin-right:6px"></span>${esc(x.name)}</span><span class="mono" style="color:var(--text-2)">${distInfo(x) ? fmtKm(distInfo(x).km) + 'km' : ''}</span></button>`).join('')}</div></div>` : ''}
    ${spot ? `<div class="d-sec"><div class="h"><b>연계 휴양지</b></div><div class="sublist" style="margin:12px 0 0"><button data-go="${spot.id}"><span>${esc(spot.name)}</span><span class="stars">${stars(spot.rating)}</span></button></div></div>` : ''}
    <details class="d-more"><summary>더보기 · 평점 입력 · 정보 · 관리</summary>
      <div class="sec">평점 <span class="sec-note">네이버·구글 직접 확인 후 입력</span></div>
      <div class="naverbox" id="naverbox">
        <label>방문자 리뷰 수<input name="reviews" inputmode="numeric" value="${n.reviews ?? ''}"></label>
        <label>블로그 리뷰 수<input name="blog" inputmode="numeric" value="${n.blog ?? ''}"></label>
        <label>별점<input name="rating" inputmode="decimal" value="${n.rating ?? ''}"></label>
        <label>'전국 맛집 지도' 저장<select name="saved"><option value="">아니오</option><option value="1"${n.saved ? ' selected' : ''}>예 ✔</option></select></label>
        <label class="wide">네이버 플레이스 URL<input name="url" value="${esc(n.url || '')}" placeholder="https://naver.me/… 또는 place 링크"></label>
        <label>구글 별점<input name="g_rating" inputmode="decimal" value="${p.google?.rating ?? ''}"></label>
        <label>구글 리뷰 수<input name="g_reviews" inputmode="numeric" value="${p.google?.reviews ?? ''}"></label>
        <label class="wide">조회일<input name="date" value="${esc(n.date || '')}" placeholder="${today()}"></label>
        <div class="wide btns rw" style="margin:0"><button class="primary" data-act="nsave">평점 저장</button><a class="mini g" href="${L_.google}" target="_blank" rel="noopener" style="padding:7px 11px">구글에서 확인</a><a class="mini n" href="${L_.naver}" target="_blank" rel="noopener" style="padding:7px 11px">네이버에서 확인</a></div>
      </div>
      <div class="sec">정보</div><dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <div class="sec">지도에서 열기</div><div class="btns" style="margin:0"><a class="n" href="${L_.naver}" target="_blank" rel="noopener">네이버지도</a><a class="k" href="${L_.kakao}" target="_blank" rel="noopener">카카오맵</a><a class="g" href="${L_.google}" target="_blank" rel="noopener">구글맵</a>${/iPhone|Android/i.test(navigator.userAgent) && L_.route_naver_app ? `<a href="${L_.route_naver_app}">네이버앱 길찾기</a>` : ''}</div>
      <div class="sec">관리</div><div class="btns" style="margin:0"><button class="rw" data-act="geocode">좌표 찾기</button><button class="rw" data-act="edit">수정</button><button class="rw danger" data-act="del">삭제</button></div>
    </details>
    </div>
    <div class="d-foot">
      <div class="nav3"><a class="n" href="${L_.route_naver || L_.naver}" target="_blank" rel="noopener">N 길찾기</a><a class="k" href="${L_.route_kakao || L_.kakao}" target="_blank" rel="noopener">카카오</a><a href="${L_.route_google || L_.google}" target="_blank" rel="noopener">구글</a></div>
      <div class="row2"><button class="wishbtn rw${p.wish ? ' on' : ''}" data-act="wish" title="가고싶다">${p.wish ? '★' : '☆'}</button>${p.visits ? `<button class="cta" data-act="plan-with">${p.type === 'spot' ? '근처 식당과 묶어서 일정 만들기' : '근처 휴양지와 묶어서 일정 만들기'}</button>` : `<button class="cta rw" data-act="visitlog">다녀왔어요 · 기록 남기기</button>`}</div>
    </div>`);
  const sheet = $('#sheet-inner');
  let found = [];
  drawDetailMap(p); refineDetailRoute(p);
  sheet.onclick = async e => {
    const go = e.target.closest('[data-go]'); if (go) return openDetail(go.dataset.go);
    const tg = e.target.closest('[data-tag]');
    if (tg) { if (document.body.classList.contains('ro')) return; const t = tg.dataset.tag; const set = new Set(p.tags || []); set.has(t) ? set.delete(t) : set.add(t); p.tags = [...set]; tg.classList.toggle('tag'); tg.classList.toggle('off'); markDirty(); renderTagChips(); renderList(); return; }
    const vdel = e.target.closest('[data-vdel]');
    if (vdel) { if (vdel.dataset.confirm) { p.visitLog.splice(+vdel.dataset.vdel, 1); p.visits = Math.max(0, (p.visits || 1) - 1); markDirty(); openDetail(id); } else { vdel.dataset.confirm = 1; vdel.textContent = '삭제?'; } return; }
    const pin = e.target.closest('[data-pin]');
    if (pin) { const l = found[+pin.dataset.pin]; p.parking ||= { type: '미확인' }; p.parking.lots ||= []; if (!p.parking.lots.some(x => x.name === l.name)) p.parking.lots.push(l); p.parking.lots = p.parking.lots.slice(-3); if (!p.parking.type || p.parking.type === '미확인') p.parking.type = l.public ? '공영' : '민영유료'; markDirty(); openDetail(id); toast('주차장 저장'); return; }
    const unpin = e.target.closest('[data-unpin]');
    if (unpin) { p.parking.lots.splice(+unpin.dataset.unpin, 1); markDirty(); openDetail(id); return; }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'close') return closeSheet();
    if (act === 'tagedit') { const box = sheet.querySelector('.d-tags'); box.classList.toggle('edit'); e.target.textContent = box.classList.contains('edit') ? '완료' : '＋ 태그'; return; }
    if (act === 'share') { shareLink('p', p.id, p.name); return; }
    if (act === 'wish') { p.wish = !p.wish; markDirty(); openDetail(id); toast(p.wish ? '가고싶다 ★' : '해제'); }
    if (act === 'edit') openPlaceForm(p);
    if (act === 'reco') openRecommend(p);
    if (act === 'plan-with') openPlanner(p.type === 'spot' ? { with: p.id, region: p.region } : { region: p.region, with: p.spot_id || undefined });
    if (act === 'hours') openHoursForm(p);
    if (act === 'parkedit') openParkingForm(p);
    if (act === 'visitlog') openVisitForm(p);
    if (act === 'parkfind') { const box = $('#lotfind'); box.innerHTML = '<div class="help">검색 중…</div>'; found = await findParking(p); box.innerHTML = renderFoundLots(found, p); }
    if (act === 'del') { if (sheet.dataset.confirm === id) { trashPut('place', p); S.db.places = S.db.places.filter(x => x !== p); for (const s of S.db.places) if (s.restaurants) s.restaurants = s.restaurants.filter(x => x !== id); const m = S.markers.get(id); if (m) { S.cluster.removeLayer(m); S.markers.delete(id); } markDirty(); closeSheet(); S.sel = null; renderList(); toast('휴지통으로 이동 (설정 › 휴지통에서 복원)'); } else { sheet.dataset.confirm = id; e.target.textContent = '정말 삭제? (다시 클릭)'; } }
    if (act === 'pinpick') { startPinPick(p); return; }
    if (act === 'journal') { openJournal({ placeId: p.id }); return; }
    if (act === 'asbase') { let b = S.db.bases.find(x => x.placeId === p.id); if (!b) { if (isRO()) return goToken(); b = { id: uid('b'), name: p.name, country: p.country, lat: p.lat, lng: p.lng, note: (p.tags || [])[0] || '우리 장소', si: p.si || null, placeId: p.id }; S.db.bases.push(b); markDirty(); toast('거점 등록: ' + p.name); } setBase(b.id); openDetail(p.id); return; }
    if (act === 'geocode') { e.target.textContent = '검색 중…'; const ok = await geocodePlace(p); if (ok) { markDirty(); renderList(); openDetail(id); toast('좌표 저장: ' + ok); } else { toast('검색 결과 없음 — 수정에서 직접 입력'); openDetail(id); } }
    if (act === 'nsave') {
      const box = $('#naverbox'); const g = k => box.querySelector(`[name=${k}]`).value.trim();
      p.naver = { ...(p.naver || {}), reviews: g('reviews') ? +g('reviews').replace(/,/g, '') : null, blog: g('blog') ? +g('blog').replace(/,/g, '') : null, rating: g('rating') ? +g('rating') : null, saved: !!g('saved'), url: g('url') || null, date: g('date') || today() };
      const gr = g('g_rating'), gv = g('g_reviews');
      if (gr || gv || p.google) p.google = { ...(p.google || {}), rating: gr ? +gr : null, reviews: gv ? +gv.replace(/,/g, '') : null };
      markDirty(); renderList(); toast('평점 저장됨');
    }
  };
}

/* ---------------- 주차장 ---------------- */
function lotRow(l, i, pinned) {
  const nav = S.base ? `https://map.naver.com/p/directions/${S.base.lng},${S.base.lat},${encodeURIComponent(S.base.name)}/${l.lng},${l.lat},${encodeURIComponent(l.name)}/-/car` : `https://map.naver.com/p/search/${encodeURIComponent(l.name)}`;
  const kk = `https://map.kakao.com/link/to/${encodeURIComponent(l.name)},${l.lat},${l.lng}`;
  return `<div class="lot"><span class="lot-n"><span class="badge ${l.public ? 'pk pub' : 'pk'}">${l.public ? '공영' : '유료/민영'}</span> ${esc(l.name)}<small>${l.dist != null ? Math.round(l.dist) + 'm · ' : ''}${esc(l.address || '')}</small></span>
    <span class="lot-a"><a class="mini n" href="${nav}" target="_blank" rel="noopener">N</a><a class="mini k" href="${kk}" target="_blank" rel="noopener">K</a>${pinned ? `<button class="mini ghost" data-unpin="${i}">✕</button>` : `<button class="mini" data-pin="${i}">저장</button>`}</span></div>`;
}
function renderFoundLots(lots, p) {
  if (!lots.length) return `<div class="help">반경 1km 내 검색 결과 없음${p.country === 'KR' && !S.kakaoReady ? ' (카카오 키 필요)' : ''}</div>`;
  const pub = lots.map((l, i) => [l, i]).filter(([l]) => l.public), paid = lots.map((l, i) => [l, i]).filter(([l]) => !l.public);
  const crowded = p.parking?.crowd === '항상붐빔';
  const sec = (title, arr) => arr.length ? `<div class="lot-sec">${title}</div>${arr.map(([l, i]) => lotRow(l, i, false)).join('')}` : '';
  return `<div class="lots">${crowded
    ? sec('항상 붐빔 → 유료라도 확실한 곳 (거리순)', paid) + sec('공영 (참고 · 만차 가능)', pub)
    : sec('공영·공용 1순위', pub) + sec('유료·민영 대안', paid)}</div>`;
}
async function findParking(p) {
  if (!hasCoord(p)) return [];
  if (p.country === 'KR') {
    await loadKakao();
    if (window.kakao?.maps?.services) {
      return new Promise(res => {
        new kakao.maps.services.Places().categorySearch('PK6', (data, st) => {
          if (st !== kakao.maps.services.Status.OK) return res([]);
          res(data.map(d => ({ name: d.place_name, lat: +d.y, lng: +d.x, dist: +d.distance, address: d.road_address_name || d.address_name, url: d.place_url, public: PUBLIC_RE.test(d.place_name + ' ' + d.category_name) }))
            .sort((a, b) => a.dist - b.dist).slice(0, 12));
        }, { location: new kakao.maps.LatLng(p.lat, p.lng), radius: 1000, sort: kakao.maps.services.SortBy.DISTANCE });
      });
    }
  }
  // 해외: 구글 키 있으면 구글, 없으면 OSM Overpass
  if (googleKey()) { const g = await googleNearby(p, ['parking'], 1000, 'DISTANCE', 15); if (g.length) return g.map(h => ({ name: h.name, lat: h.lat, lng: h.lng, dist: h.dist, address: [h.address, h.rating ? 'G' + h.rating : ''].filter(Boolean).join(' · '), public: PUBLIC_RE.test(h.name) })); }
  try {
    const q = `[out:json][timeout:15];(node(around:1000,${p.lat},${p.lng})[amenity=parking];way(around:1000,${p.lat},${p.lng})[amenity=parking];);out center 30;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q) });
    const j = await r.json();
    return j.elements.map(e => { const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon; const t = e.tags || {};
      return { name: t.name || (t.fee === 'no' ? '무료 주차장' : '주차장'), lat, lng, dist: haversine(p, { lat, lng }) * 1000, address: [t.fee === 'no' ? '무료' : t.fee === 'yes' ? '유료' : '', t.capacity ? t.capacity + '면' : ''].filter(Boolean).join(' · '), public: PUBLIC_RE.test((t.name || '') + ' ' + (t.operator || '') + ' ' + (t.access || '')) || t.access === 'public' };
    }).filter(l => l.lat).sort((a, b) => a.dist - b.dist).slice(0, 12);
  } catch { return []; }
}
function openParkingForm(p) {
  const k = p.parking || {};
  openSheet(`<div class="sheet-head"><h2>주차 정보</h2><button class="close" data-act="back">✕</button></div>
    <form class="form" id="pkf">
      <label>유형<div class="chips small" id="pk-type">${PARK_TYPES.map(t => `<button type="button" data-v="${t}" class="${k.type === t ? 'on' : ''}">${t}</button>`).join('')}</div></label>
      <label>붐빔<div class="chips small" id="pk-crowd">${CROWD.map(t => `<button type="button" data-v="${t}" class="${k.crowd === t ? 'on' : ''}">${t}</button>`).join('')}</div></label>
      <label>요금<input name="fee" value="${esc(k.fee || '')}" placeholder="예: 30분 1,000원 / 식사 시 2시간 무료"></label>
      <label>메모<input name="note" value="${esc(k.note || '')}" placeholder="예: 주말 11시 이전 도착 권장"></label>
      <div class="help">"항상붐빔"이면 주변 주차장 찾기에서 유료 주차장이 먼저 표시됩니다.</div>
      <div class="btns"><button class="primary">저장</button><button type="button" data-act="back">취소</button></div></form>`);
  const f = $('#pkf');
  f.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.v) { [...b.parentElement.children].forEach(x => x.classList.toggle('on', x === b && !x.classList.contains('on'))); } if (b.dataset.act === 'back') openDetail(p.id); });
  f.addEventListener('submit', e => { e.preventDefault();
    p.parking = { ...(p.parking || {}), type: $('#pk-type .on')?.dataset.v || null, crowd: $('#pk-crowd .on')?.dataset.v || null, fee: f.fee.value.trim() || null, note: f.note.value.trim() || null };
    markDirty(); renderList(); openDetail(p.id); toast('주차 정보 저장'); });
}

/* ---------------- 영업시간 ---------------- */
function openHoursForm(p) {
  const h = p.hours || {};
  openSheet(`<div class="sheet-head"><h2>영업시간</h2><button class="close" data-act="back">✕</button></div>
    <form class="form" id="hf">
      <div class="two"><label>오픈<input name="open" type="time" value="${esc(h.open || '')}"></label><label>마감<input name="close" type="time" value="${esc(h.close || '')}"></label></div>
      <div class="three"><label>브레이크 시작<input name="breakStart" type="time" value="${esc(h.breakStart || '')}"></label><label>브레이크 끝<input name="breakEnd" type="time" value="${esc(h.breakEnd || '')}"></label><label>라스트오더<input name="lastOrder" type="time" value="${esc(h.lastOrder || '')}"></label></div>
      <label>정기 휴무<div class="chips small" id="h-days">${DAYS.map(d => `<button type="button" data-d="${d}" class="${(h.closed || []).includes(d) ? 'on' : ''}">${d}</button>`).join('')}</div></label>
      <div class="btns"><button class="primary">저장</button><button type="button" data-act="clear">지우기</button><button type="button" data-act="back">취소</button></div></form>`);
  const f = $('#hf');
  f.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.d) b.classList.toggle('on'); if (b.dataset.act === 'back') openDetail(p.id); if (b.dataset.act === 'clear') { p.hours = null; markDirty(); renderList(); openDetail(p.id); } });
  f.addEventListener('submit', e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    p.hours = { open: d.open || null, close: d.close || null, breakStart: d.breakStart || null, breakEnd: d.breakEnd || null, lastOrder: d.lastOrder || null, closed: $$('#h-days .on').map(b => b.dataset.d) };
    markDirty(); renderList(); openDetail(p.id); toast('영업시간 저장'); });
}

/* ---------------- 방문 기록 ---------------- */
const FAMILY_DEFAULT = ['아빠', '엄마', '하준', '이준'];
function familyNames() { const f = S.db.meta.family || {}; return (f.names || []).length ? f.names : FAMILY_DEFAULT; }
function openVisitForm(p) {                                     // 시안 07: 방문 기록 · 내 사진 올리기
  const di = distInfo(p); const mealNow = (() => { const h = new Date().getHours(); return h < 11 ? '아침' : h < 15 ? '점심' : h < 17 ? '간식' : '저녁'; })();
  const st = { photos: [], rating: 0, who: new Set(familyNames()), menu: [] };
  const dateTxt = iso => { const d = new Date(iso + 'T00:00:00'); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} (${DAYS[d.getDay()]})`; };
  openSheet(`<div class="vf-sheet">
    <div class="hd"><button class="lnk" data-act="back">취소</button><b>방문 기록</b><button class="lnk pri" data-act="save">저장</button></div>
    <div class="vf-scroll">
      <div class="vf-place">${thumbHtml(p, 'tile')}<div style="flex:1;min-width:0"><b>${esc(p.name)}</b><p class="cap">${esc(areaOf(p))}${di ? ` · ${fmtKm(di.km)}km` : ''}</p></div></div>
      <div class="vsec"><h4>사진 <span class="cap3">최대 10장 · 첫 장이 표지</span></h4><div class="vgrid" id="vgrid"></div><p class="cap3" style="margin-top:8px">기기에서 1280px로 줄여 저장 · 원본은 올리지 않음${S.token || OFFLINE ? '' : ' · <b>GitHub 토큰 없으면 사진은 이 기기에만 남음</b>'}</p><input type="file" id="vfile" accept="image/*" multiple hidden></div>
      <div class="vsec"><h4>날짜</h4><label class="field"><span class="num" id="vdate-txt">${dateTxt(today())}</span><input type="date" id="vdate" value="${today()}"><select id="vmeal" class="cap" style="margin-left:auto">${['아침', '점심', '간식', '저녁', '야식'].map(m => `<option${m === mealNow ? ' selected' : ''}>${m}</option>`).join('')}</select></label></div>
      <div class="vsec"><h4>함께 간 사람</h4><div class="chips" id="vwho">${familyNames().map(n => `<button type="button" class="chip on" data-who="${esc(n)}">${esc(n)}</button>`).join('')}<button type="button" class="chip" data-who="+">+ 손님</button></div></div>
      <div class="vsec"><h4>별점</h4><div class="vstars" id="vstars">${[1, 2, 3, 4, 5].map(n => `<span data-r="${n}">★</span>`).join('')}<span class="num val" id="vval">—</span></div></div>
      <div class="vsec"><h4>한줄평</h4><textarea id="vmemo" class="vmemo" placeholder="예: 하준이가 순두부 국물까지 다 마심"></textarea></div>
      <div class="vsec"><h4>먹은 메뉴</h4><div class="chips" id="vmenu"><button type="button" class="chip" data-menu="+">+ 메뉴</button></div></div>
      <div style="height:20px"></div></div>
    <div class="vf-foot"><button class="btn-pri" data-act="save">기록 저장하고 스탬프 찍기</button></div></div>`);
  const sheet = $('#sheet-inner');
  const drawPhotos = () => { $('#vgrid').innerHTML = st.photos.map((ph, i) => `<div class="vph" style="background-image:url('${ph.url}')">${i === 0 ? '<span class="cv">표지</span>' : ''}<button type="button" class="x" data-rm="${i}">✕</button></div>`).join('') + (st.photos.length < 10 ? '<button type="button" class="vph add" data-act="addphoto"><b>+</b>사진 추가</button>' : ''); };
  const drawMenu = () => { $('#vmenu').innerHTML = st.menu.map((m, i) => `<button type="button" class="chip soft" data-rmmenu="${i}">${esc(m)} ✕</button>`).join('') + '<button type="button" class="chip" data-menu="+">+ 메뉴</button>'; };
  drawPhotos();
  $('#vdate').onchange = e => { $('#vdate-txt').textContent = dateTxt(e.target.value || today()); };
  $('#vfile').onchange = async e => { for (const f of [...e.target.files].slice(0, 10 - st.photos.length)) { try { const b64 = await resizeImage(f); st.photos.push({ b64, url: 'data:image/jpeg;base64,' + b64 }); } catch { toast('사진을 읽지 못했습니다'); } } drawPhotos(); e.target.value = ''; };
  sheet.onclick = async e => {
    const b = e.target.closest('button, [data-r]'); if (!b) return;
    if (b.dataset.act === 'back') return openDetail(p.id);
    if (b.dataset.act === 'addphoto') return $('#vfile').click();
    if (b.dataset.rm != null) { st.photos.splice(+b.dataset.rm, 1); drawPhotos(); return; }
    if (b.dataset.r) { st.rating = +b.dataset.r; $$('#vstars [data-r]').forEach(x => x.classList.toggle('on', +x.dataset.r <= st.rating)); $('#vval').textContent = st.rating.toFixed(1); return; }
    if (b.dataset.who) { if (b.dataset.who === '+') { const n = prompt('함께 간 사람 이름'); if (n && n.trim()) { st.who.add(n.trim()); b.insertAdjacentHTML('beforebegin', `<button type="button" class="chip on" data-who="${esc(n.trim())}">${esc(n.trim())}</button>`); } return; } st.who.has(b.dataset.who) ? st.who.delete(b.dataset.who) : st.who.add(b.dataset.who); b.classList.toggle('on'); return; }
    if (b.dataset.menu === '+') { const m = prompt('먹은 메뉴'); if (m && m.trim()) { st.menu.push(m.trim()); drawMenu(); } return; }
    if (b.dataset.rmmenu != null) { st.menu.splice(+b.dataset.rmmenu, 1); drawMenu(); return; }
    if (b.dataset.act === 'save') {
      $$('[data-act=save]').forEach(x => { x.disabled = true; }); $('.vf-foot .btn-pri').textContent = '저장 중…';
      const entry = { date: $('#vdate').value || today(), meal: $('#vmeal').value, rating: st.rating || null, memo: $('#vmemo').value.trim() || null, who: [...st.who], menu: st.menu.slice(), photo: null, photos: [] };
      for (const [i, ph] of st.photos.entries()) {
        let stored = null;
        if (S.token && !OFFLINE) { try { stored = await ghPutFile(`photos/${p.id}/${entry.date}_${Date.now().toString(36)}_${i}.jpg`, ph.b64, `jjtrip: photo ${p.name}`); } catch (err) { toast('사진 업로드 실패: ' + err.message, 3500); } }
        if (!stored) { const local = LS.get('photos', {}); const key = `local:${p.id}:${Date.now().toString(36)}${i}`; local[key] = ph.url; try { LS.set('photos', local); stored = key; } catch { toast('이 기기 저장 공간 부족 — 사진 생략'); } }
        if (stored) entry.photos.push(stored);
      }
      entry.photo = entry.photos[0] || null;
      p.visitLog ||= []; entry.id ||= uid('v'); p.visitLog.push(entry); p.visits = (p.visits || 0) + 1;
      markDirty(); renderList(); openDetail(p.id); toast('기록 저장 · 스탬프 찍힘');
    }
  };
}

/* ---------------- 추천 엔진 (규칙 기반) ----------------
 * scoreRestaurant(r, ctx) → {score, reasons[]}   ctx: {origin:{lat,lng}, season, family, mode:'plan'|'today', spotCrowded, country}
 * scoreSpot(s, ctx)       → {score, reasons[]}   (③ 플래너·계절 추천용)
 */
const SEASON_KW = {
  '여름': /냉면|막국수|물회|콩국수|빙수|해산물|회\b|조개|새우|랍스타|과일/i,
  '겨울': /국밥|해장국|칼국수|순두부|짬뽕|전골|곰탕|설렁탕|어묵|라멘|쌀국수|탕\b/i,
  '봄': /나물|비빔|두부|한정식|딸기/i,
  '가을': /전어|대하|꽃게|한우|갈비|버섯|송이/i,
};
function seasonNow(d = new Date()) { const m = d.getMonth() + 1; return m <= 2 || m === 12 ? '겨울' : m <= 5 ? '봄' : m <= 8 ? '여름' : '가을'; }
function famProfile() { const f = S.db.meta.family || {}; const kids = f.kids || []; return { toddler: kids.some(a => a < 7), school: kids.some(a => a >= 7 && a <= 12), teen: kids.some(a => a > 12), senior: (f.seniors || 0) > 0, spicyOK: !!f.spicyOK, kids: kids.length > 0 }; }
function distScore(km) { if (km == null) return [0, null]; if (km <= 1) return [30, `${fmtKm(km)}km`]; if (km <= 3) return [22, `${fmtKm(km)}km`]; if (km <= 7) return [12, `${fmtKm(km)}km`]; if (km <= 15) return [5, `${fmtKm(km)}km`]; if (km <= 20) return [0, `${fmtKm(km)}km`]; return [-999, null]; }

function scoreRestaurant(r, ctx) {
  const tags = new Set(r.tags || []), fam = ctx.family || famProfile(), reasons = [];
  let s = 0;
  const km = ctx.origin && hasCoord(r) ? haversine(ctx.origin, r) : null;
  const [ds, dl] = distScore(km); if (ds <= -999) return null; s += ds; if (dl) reasons.push([ds, dl]);
  if (!hasCoord(r)) { s -= 3; reasons.push([-3, '좌표無']); }
  // 계절
  const kw = SEASON_KW[ctx.season]; const txt = [r.name, r.signature, r.desc, r.note, ...cuisineOf(r)].join(' ');
  if (kw && kw.test(txt)) { s += 6; reasons.push([6, ctx.season + ' 제철']); }
  // 가족
  if (tags.has('노키즈존') && fam.kids) return null;
  if (fam.toddler) { if (tags.has('아이동반')) { s += 8; reasons.push([8, '아이동반']); } if (tags.has('놀이방')) { s += 6; reasons.push([6, '놀이방']); } if (tags.has('유모차')) { s += 4; reasons.push([4, '유모차']); } }
  else if (fam.school) { if (tags.has('아이동반')) { s += 5; reasons.push([5, '아이동반']); } if (tags.has('좌식')) { s += 2; reasons.push([2, '좌식']); } }
  if (fam.senior) { if (tags.has('어르신OK')) { s += 8; reasons.push([8, '어르신OK']); } if (cuisineOf(r).includes('한식')) { s += 4; reasons.push([4, '한식']); } if (tags.has('웨이팅')) { s -= 4; reasons.push([-4, '웨이팅']); } }
  if (tags.has('매운맛') && !fam.spicyOK) { s -= 8; reasons.push([-8, '매운맛']); }
  if (tags.has('한국입맛') && r.country !== 'KR') { s += 3; reasons.push([3, '한국입맛']); }
  // 평가
  const rt = r.rating || 0, sp = r.spot_id && placeById(r.spot_id);
  if (rt) { s += rt * 3; reasons.push([rt * 3, '★' + rt]); } else if (sp?.rating) { s += sp.rating * 1.5; reasons.push([sp.rating * 1.5, '연계 ★' + sp.rating]); }
  const gg = r.google || {};
  if (gg.rating && !(r.naver || {}).rating) { const v = Math.round((gg.rating - 4) * 5); s += v; reasons.push([v, `G${gg.rating}`]); }
  if (gg.reviews && !(r.naver || {}).reviews) { const v = Math.round(Math.log10(gg.reviews + 1) * 3); s += v; reasons.push([v, `G리뷰 ${gg.reviews.toLocaleString()}`]); }
  const nv = r.naver || {};
  if (nv.reviews) { const v = Math.round(Math.log10(nv.reviews + 1) * 3); s += v; reasons.push([v, `리뷰 ${nv.reviews.toLocaleString()}`]); }
  if (nv.rating) { const v = Math.round((nv.rating - 4) * 5); s += v; reasons.push([v, `N${nv.rating}`]); }
  if (tags.has('미슐랭')) { s += 5; reasons.push([5, '미슐랭']); }
  // 주차
  const pk = r.parking?.type;
  if (pk === '공영' || pk === '무료') { s += 8; reasons.push([8, 'P' + pk]); } else if (pk === '민영유료' || pk === '전용') { s += 4; reasons.push([4, 'P' + pk]); } else if (pk === '없음') { s -= 8; reasons.push([-8, '주차 없음']); }
  if (ctx.spotCrowded && (pk === '전용' || pk === '무료' || tags.has('주차'))) { s += 6; reasons.push([6, '자체주차']); }
  // 이력·오늘 모드
  if (r.visits) { s += 3; reasons.push([3, `방문 ${r.visits}`]); }
  if (r.wish) { s += 4; reasons.push([4, '가고싶다★']); }
  if (ctx.mode === 'today') {
    const os = openState(r, ctx.when); if (os === 'closed' || os === 'dayoff') return null; if (os === 'open') { s += 4; reasons.push([4, '영업중']); }
    if (tags.has('예약필수') || tags.has('웨이팅')) { s -= 2; reasons.push([-2, '예약/웨이팅']); }
  }
  reasons.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  return { score: Math.round(s), reasons: reasons.map(x => x[1]).filter(Boolean) };
}

function scoreSpot(sp, ctx) {
  const tags = new Set(sp.tags || []), fam = ctx.family || famProfile(), reasons = []; let s = 0;
  const km = ctx.origin && hasCoord(sp) ? haversine(ctx.origin, sp) : (ctx.origin?.id === 'b_home' && sp.dist_home_km != null ? sp.dist_home_km : null);
  if (km != null) { const v = km <= 30 ? 15 : km <= 80 ? 10 : km <= 150 ? 5 : 0; s += v; reasons.push([v, `${fmtKm(km)}km`]); }
  if ((sp.seasons || []).includes(ctx.season)) { s += 12; reasons.push([12, ctx.season + ' 추천']); } else if ((sp.seasons || []).length) { s -= 10; reasons.push([-10, ctx.season + ' 비추']); }
  if (ctx.season === '여름' && tags.has('물놀이')) { s += 6; reasons.push([6, '물놀이']); }
  if ((ctx.season === '여름' || ctx.season === '겨울') && tags.has('실내')) { s += 4; reasons.push([4, '실내']); }
  if (ctx.season === '겨울' && tags.has('눈썰매')) { s += 6; reasons.push([6, '눈썰매']); }
  if (fam.toddler) { if (tags.has('유아OK')) { s += 8; reasons.push([8, '유아OK']); } if (tags.has('동물')) { s += 4; reasons.push([4, '동물']); } }
  if (fam.school) { if (tags.has('초등추천')) { s += 8; reasons.push([8, '초등추천']); } if (tags.has('체험')) { s += 4; reasons.push([4, '체험']); } }
  if (fam.teen && tags.has('역사·문화')) { s += 4; reasons.push([4, '역사·문화']); }
  if (fam.senior && tags.has('야외') && !tags.has('실내')) { s -= 2; }
  if (sp.rating) { s += sp.rating * 3; reasons.push([sp.rating * 3, '★' + sp.rating]); }
  if (tags.has('무료')) { s += 2; reasons.push([2, '무료']); }
  if ((sp.restaurants || []).length) { s += 2; reasons.push([2, `식당 ${sp.restaurants.length}`]); }
  if (sp.wish) { s += 5; reasons.push([5, '가고싶다★']); }
  if (!sp.visits) { s += 2; reasons.push([2, '미방문']); }
  reasons.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  return { score: Math.round(s), reasons: reasons.map(x => x[1]) };
}

/* A: 내 DB에서 추천 */
const normSi = s => (s || '').replace(/(특별|광역)?시$|군$/, '').trim();
function siMatch(si, list) { const a = normSi(si); if (!a) return false; return (list || []).filter(Boolean).some(x => { const b = normSi(x); if (!b) return false; if (a === b || a.startsWith(b) || b.startsWith(a)) return true; if ((b === '서울' && /구$/.test(a)) || (a === '서울' && /구$/.test(b))) return true; return false; }); }
function recommendFromDb(ctx, limit = 8) {
  const out = [];
  for (const r of S.db.places) {
    if (r.type !== 'restaurant') continue;
    if (ctx.country && r.country !== ctx.country) continue;
    if (ctx.excludeId && r.id === ctx.excludeId) continue;
    if (ctx.spotId && r.spot_id && r.spot_id !== ctx.spotId && !hasCoord(r)) continue;                  // 다른 휴양지 전용 식당 제외
    const rr = ctx.allowApprox ? withCoord(r) : r;                                                       // 플래너: 좌표 없으면 시·군 중심으로 대략
    if (!hasCoord(rr) || !hasCoord(ctx.origin || {})) { const near = ctx.spotId && r.spot_id === ctx.spotId; if (!near && !siMatch(r.si, ctx.siList || [ctx.si])) continue; }   // 좌표 없으면 같은 시·군(거점은 인근 시·군 목록)만
    const sc = scoreRestaurant(rr, ctx); if (!sc) continue;
    out.push({ place: r, ...sc, approx: !!rr.approx, km: ctx.origin && hasCoord(rr) ? haversine(ctx.origin, rr) : null });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
/* B: 카카오 주변 신규 후보 (국내, 키 필요) */
const KAKAO_CUISINE = [['한식', '한식'], ['중식', '중식'], ['일식', '일식'], ['양식', '양식'], ['분식', '기타'], ['카페', '카페'], ['치킨', '기타'], ['패스트푸드', '기타'], ['아시아', '기타']];
async function recommendNearbyKakao(origin, ctx, radius = 3000) {
  if (!origin || !hasCoord(origin)) return [];
  await loadKakao(); if (!window.kakao?.maps?.services) return [];
  const known = new Set(S.db.places.map(p => p.kakao?.url).filter(Boolean));
  const knownNames = new Set(S.db.places.map(p => p.name.replace(/\s/g, '')));
  const fam = ctx.family || famProfile();
  const run = page => new Promise(res => new kakao.maps.services.Places().categorySearch('FD6', (data, st, pg) => res(st === kakao.maps.services.Status.OK ? data : []), { location: new kakao.maps.LatLng(origin.lat, origin.lng), radius, sort: kakao.maps.services.SortBy.DISTANCE, page }));
  const p1 = await run(1); skelStep(1, 2); const data = [...p1, ...await run(2)]; skelStep(2, 2);
  return data.filter(d => !known.has(d.place_url) && !knownNames.has(d.place_name.replace(/\s/g, ''))).map(d => {
    const cat = d.category_name || ''; const cu = (KAKAO_CUISINE.find(([k]) => cat.includes(k)) || [null, '기타'])[1];
    const km = d.distance / 1000; const [ds, dl] = distScore(km); const reasons = [dl, cat.split('>').pop().trim()].filter(Boolean);
    let s = ds;
    if (/냉면|막국수|국밥|해장국|칼국수|순두부/.test(d.place_name) && SEASON_KW[ctx.season]?.test(d.place_name)) { s += 6; reasons.push(ctx.season + ' 제철'); }
    if (fam.kids && /키즈|가족/.test(cat + d.place_name)) { s += 4; reasons.push('가족'); }
    if (/(술집|호프|바|포장마차|노래)/.test(cat) && fam.kids) s -= 15;
    return { candidate: { name: d.place_name, lat: +d.y, lng: +d.x, address: d.road_address_name || d.address_name, phone: d.phone, url: d.place_url, cuisine: cu, category: cat }, score: Math.round(s), reasons, km };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
}

/* 추천 화면 */
function skelHtml(title, src, saved) {                        // 시안 11b: 로딩 스켈레톤
  const row = w => `<div class="sk-row"><div class="th sk"></div><div class="m"><div class="sk" style="height:14px;width:${w[0]}%"></div><div class="sk" style="height:11px;width:${w[1]}%"></div><div class="sk" style="height:11px;width:${w[2]}%"></div></div></div>`;
  return `<div class="skel"><div class="h"><b>${title}</b><span class="num cap" id="sk-step">${esc(src)} · 0/2</span></div><div class="bar"><i id="sk-bar" style="width:12%"></i></div>${row([60, 85, 40])}${row([50, 75, 35])}${row([65, 80, 45])}<p class="cap3">${saved ? `저장된 ${saved}곳은 바로 보이고, 새 후보만 불러오는 중` : '새 후보 불러오는 중'}</p></div>`;
}
function skelStep(i, n) { const s = $('#sk-step'), b = $('#sk-bar'); if (s) s.textContent = s.textContent.replace(/\d+\/\d+$/, `${i}/${n}`); if (b) b.style.width = Math.round(12 + 88 * i / n) + '%'; }
async function openRecommend(spot, opts = {}) {                // 시안 10: 근처 추천 · 내 리스트 + 새 후보
  const mode = opts.mode || 'plan';
  const origin = opts.origin || spot || S.base;
  const season = opts.season || seasonNow();
  const hr = new Date().getHours(); const meal = opts.meal || (hr < 11 ? '아침' : hr < 15 ? '점심' : hr < 17 ? '간식' : '저녁');
  const radius = opts.radius || (mode === 'today' ? 5 : 5);
  const onlyOpen = opts.onlyOpen ?? (mode === 'today');
  const fam = famProfile(); const famTag = fam.toddler ? '아이동반' : fam.school ? '아이동반' : fam.senior ? '어르신OK' : null;
  const ctx = { origin, season, mode, country: origin?.country || spot?.country || 'KR', spotCrowded: spot?.parking?.crowd === '항상붐빔', when: new Date(), excludeId: spot?.id, spotId: spot?.type === 'spot' ? spot.id : spot?.spot_id, si: spot?.si || origin?.si, siList: spot ? [spot.si] : [origin?.si, ...(origin?.near || []), ...(!origin?.si ? [S.base?.si, ...(S.base?.near || [])] : [])] };
  const title = mode === 'today' ? '오늘 뭐 먹지' : `${spot.name} 근처 추천`;
  const cap = mode === 'today' ? `${esc(origin?.name || '거점')} 기준` : (spot.type === 'spot' ? '휴양지 기준' : isMine(spot) ? '우리 장소 기준' : '식당 기준');
  let A = recommendFromDb(ctx, 40).filter(x => x.km == null || x.km <= radius);
  if (onlyOpen) A = A.filter(x => { const os = openState(x.place); return !os || os === 'open'; });
  if (famTag && opts.famOn) A = A.filter(x => (x.place.tags || []).includes(famTag));
  A = A.slice(0, 12);
  const tab = opts.tab || 'mine';
  const reasonChip = (r) => { const neg = /^-|없음|매운|웨이팅|비추/.test(r); const gold = /제철|계절|봄|여름|가을|겨울/.test(r) || /^★/.test(r); const cls = neg ? 'background:var(--danger-soft);color:var(--danger)' : gold ? 'background:var(--accent-soft);color:#8a6400' : 'background:var(--primary-soft);color:var(--primary)'; return `<span class="bd" style="${cls}">${esc(r.replace(/^★(\d)$/, '우리 ★$1'))}</span>`; };
  const rowA = (x, i) => { const p = x.place; const re = x.km != null ? roadEst(x.km, p.country) : null; const di = re ? { km: re.road, min: re.min } : (origin?.id === S.base?.id ? distInfo(p) : null); const os = openState(p), ol = os && OPEN_LABEL[os];
    const chips = [ol ? `<span class="bd" style="background:var(--${ol[1] === 'ok' ? 'success' : ol[1] === 'warn' ? 'warning' : 'bg'}-soft);color:var(--${ol[1] === 'ok' ? 'success' : ol[1] === 'warn' ? 'warning' : 'text-2'})">${ol[0]}</span>` : '', p.wish ? '<span class="bd" style="background:var(--primary-soft);color:var(--primary)">가고싶다</span>' : '', ...x.reasons.filter(r => !/km$|좌표/.test(r)).map(reasonChip)].filter(Boolean).slice(0, 2).join('');
    return `<button class="rc-row" data-go="${p.id}"><b class="num rk${i === 0 ? ' top' : ''}">${i + 1}</b>${thumbHtml(p, 'tile')}<div class="m"><div class="nm"><b>${esc(p.name)}</b>${p.visits ? `<span class="bd" style="background:var(--stamp);color:#fff">${p.visits}회</span>` : ''}${p.wish ? '<span class="bd" style="background:var(--accent);color:#000">★</span>' : ''}</div><p class="cap">${esc([cuisineOf(p)[0] || (p.type === 'spot' ? '휴양지' : '식당'), di ? `${fmtKm(di.km)}km` : areaOf(p), di ? (di.km < 1.2 ? `걸어서 ${Math.round(di.km * 15)}분` : `차로 ${minText(di.min)}`) : ''].filter(Boolean).join(' · '))}</p><div class="chips2">${chips}</div></div></button>`; };
  openSheet(`<div class="rc-sheet">
    <div class="hd"><button class="back" data-act="back">‹</button><div style="flex:1;min-width:0"><p class="cap3">${cap}</p><b>${esc(title)}</b></div></div>
    <div class="rc-chips"><span class="chip on">${meal}</span><button class="chip${radius >= 30 ? ' on' : ''}" data-radius="${radius >= 30 ? 5 : 30}">${radius}km 이내</button><button class="chip${onlyOpen ? ' on' : ''}" data-open="1">영업중</button>${famTag ? `<button class="chip${opts.famOn ? ' on' : ''}" data-fam="1">#${famTag}</button>` : ''}<button class="chip" data-season="1">${season}</button></div>
    <div class="seg rc-seg"><button class="${tab === 'mine' ? 'on' : ''}" data-tab="mine">내 리스트 ${A.length}</button><button class="${tab === 'new' ? 'on' : ''}" data-tab="new">새 후보 <span id="rc-nb">…</span></button></div>
    <div class="rc-body">
      <div id="rc-a" class="${tab === 'mine' ? '' : 'hide'}">${A.length ? A.map(rowA).join('') : `<div class="empty">조건에 맞는 등록 식당 없음${!hasCoord(origin || {}) ? '<br><small>좌표 수집 후엔 거리 기준으로 더 찾습니다</small>' : ''}</div>`}</div>
      <div id="rc-b" class="${tab === 'new' ? '' : 'hide'}"><div class="rc-new"><div class="h"><span class="bd" style="background:var(--${ctx.country === 'KR' ? 'kakao' : 'google'});color:${ctx.country === 'KR' ? 'var(--on-kakao)' : '#fff'}">${ctx.country === 'KR' ? '카카오' : '구글'}</span><b>주변 새 후보</b><span class="cap3">리스트에 없는 곳</span></div><div id="rc-bl">${skelHtml(`${esc(origin?.name || '거점')} 주변 찾는 중…`, ctx.country === 'KR' ? '카카오' : '구글', A.length)}</div></div></div>
    </div></div>`);
  const sheet = $('#sheet-inner');
  let B = [];
  const rowB = (x, i) => { const c = x.candidate; return `<div class="rc-row nb"><div class="m"><b>${esc(c.name)}</b><p class="cap">${esc([c.cuisine?.[0] || c.category?.split('>').slice(-1)[0], x.km != null ? `${fmtKm(x.km)}km` : '', c.google?.reviews ? `리뷰 ${c.google.reviews.toLocaleString()}` : x.reasons[1] || ''].filter(Boolean).join(' · '))}</p></div><a class="mini ${c.google ? 'g' : 'k'}" href="${c.url}" target="_blank" rel="noopener">보기</a><button class="chip rw" data-addc="${i}">+ 리스트</button></div>`; };
  const fill = () => { const el = $('#rc-bl'); if (!el) return; el.innerHTML = B.length ? B.map(rowB).join('') : `<div class="help">${ctx.country === 'KR' ? (S.kakaoReady ? '반경 내 새 후보 없음' : '설정에서 카카오 JavaScript 키를 켜면 주변 식당을 자동으로 찾습니다') : (googleKey() ? '반경 내 새 후보 없음' : '설정에서 구글 Places 키를 넣으면 해외 주변 식당을 찾습니다')}</div>`; const nb = $('#rc-nb'); if (nb) nb.textContent = B.length; };
  if (hasCoord(origin || {})) { B = ctx.country === 'KR' ? await recommendNearbyKakao(origin, ctx, radius * 1000) : await recommendNearbyGoogle(origin, ctx, radius * 1000); } 
  else { const nb = $('#rc-nb'); if (nb) nb.textContent = '0'; const el = $('#rc-bl'); if (el) el.innerHTML = '<div class="help">좌표가 없어 주변 검색을 못 합니다 — 상세 › 더보기 › 좌표 찾기</div>'; }
  if (hasCoord(origin || {})) fill();
  sheet.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'back') { spot && mode !== 'today' ? openDetail(spot.id) : closeSheet(); return; }
    if (b.dataset.tab) { openRecommend(spot, { ...opts, tab: b.dataset.tab }); return; }
    if (b.dataset.radius) { openRecommend(spot, { ...opts, radius: +b.dataset.radius }); return; }
    if (b.dataset.open) { openRecommend(spot, { ...opts, onlyOpen: !onlyOpen }); return; }
    if (b.dataset.fam) { openRecommend(spot, { ...opts, famOn: !opts.famOn }); return; }
    if (b.dataset.season) { const seq = ['봄', '여름', '가을', '겨울']; openRecommend(spot, { ...opts, season: seq[(seq.indexOf(season) + 1) % 4] }); return; }
    if (b.dataset.go) { openDetail(b.dataset.go); return; }
    if (b.dataset.addc != null) {
      const c = B[+b.dataset.addc].candidate;
      openPlaceForm({ id: uid(), type: 'restaurant', country: ctx.country, region: spot?.region || (ctx.country === 'KR' ? 'domestic' : S.region), name: c.name, lat: c.lat, lng: c.lng, address: c.address, cuisine: c.cuisine, seasons: [], rating: 0, visits: 0, naver: {}, kakao: c.google ? {} : { url: c.url, phone: c.phone }, google: c.google || null, spot_id: spot && spot.type === 'spot' ? spot.id : null, tags: [], note: c.category });
    }
  };
}
function recoRow(x, i) {
  const p = x.place || x.candidate; const isNew = !x.place;
  const reasons = x.reasons.slice(0, 4).map(r => `<span class="badge ${/^-|없음|매운|웨이팅|비추/.test(r) ? 'neg' : ''}">${esc(r)}</span>`).join('');
  return `<div class="reco-row"><span class="rank mono">${i + 1}</span>
    <span class="reco-main"><b>${esc(p.name)}</b> <span class="mono reco-score">${x.score}</span><span class="sub">${isNew ? esc(p.category.split('>').slice(-1)[0]) : [cuisineOf(p).join('·'), p.spot_name ? '↳ ' + p.spot_name : ''].filter(Boolean).map(esc).join(' · ')}</span><span class="reasons">${reasons}</span></span>
    ${isNew ? `<span class="reco-acts"><a class="mini ${p.google ? 'g' : 'k'}" href="${p.url}" target="_blank" rel="noopener">보기</a><button class="mini" data-addc="${i}">＋등록</button></span>` : `<button class="mini" data-go="${p.id}">상세</button>`}</div>`;
}
/* 오늘 뭐 먹지: 현재 위치(허용 시) 또는 거점 기준 */
function todayPick() {
  const go = origin => openRecommend(null, { mode: 'today', origin });
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => go({ lat: pos.coords.latitude, lng: pos.coords.longitude, name: '현재 위치', country: S.base?.country || 'KR' }), () => go(S.base), { timeout: 4000, maximumAge: 60000 });
  } else go(S.base);
}

/* ---------------- 여행 플래너 ----------------
 * buildPlan(cfg) → {days:[{label, date, items:[{time,activity,place,place_id,note,kind,km,min}], totalKm, totalMin}]}
 */
const STAY_RULES = [['놀이시설', 240], ['물놀이', 180], ['눈썰매', 180], ['체험', 150], ['동물', 150], ['역사·문화', 120], ['실내', 120], ['야외', 90]];
function stayMin(sp) { const t = new Set(sp.tags || []); for (const [k, m] of STAY_RULES) if (t.has(k)) return m; return 120; }
function hhmm(min) { min = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function addDays(iso, n) { if (!iso) return null; const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d; }
function dayLabel(iso, i) { const d = addDays(iso, i); return d ? `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]})` : `${i + 1}일차`; }
function leg(a, b) { const km = haversine(a, b); const r = roadEst(km, (a.country || b.country || 'KR')); return r ? { km: r.road, min: r.min } : { km: 0, min: 0 }; }
function isFamous(p) { const n = p.naver || {}, g = p.google || {}; return /미슐랭|블루리본/.test((p.tags || []).join()) || (p.rating || 0) >= 5 || (n.reviews || 0) >= 1000 || (n.blog || 0) >= 1000 || ((g.rating || 0) >= 4.5 && (g.reviews || 0) >= 1000); }   // 멀어도 갈 만한 곳: 미슐랭·블루리본 / 우리 ★5 / 네이버 방문자·블로그 리뷰 1,000+ / 구글 4.5·1,000+
function mealPick(origin, when, used, ctx, radiusKm) {
  if (ctx.force) { const fp = placeById(ctx.force); if (fp) return { place: fp, score: 0, reasons: ['직접 선택'], km: haversine(withCoord(origin), withCoord(fp)) }; }
  const list = recommendFromDb({ ...ctx, origin: withCoord(origin), mode: 'plan', allowApprox: true }, 40).filter(x => !used.has(x.place.id) && !(ctx.skip || new Set()).has(x.place.id) && x.km != null && (hasCoord(x.place) ? (x.km <= radiusKm || (isFamous(x.place) && x.km <= Math.max(radiusKm * 3, 10))) : (x.km <= radiusKm + 2 && !!origin.si && siMatch(x.place.si, [origin.si]))));   // 반경 안만 · 유명 맛집만 반경×3까지 예외 · 좌표 없는 식당은 같은 시·군일 때만
  if (ctx.meal === 'dinner') for (let i = list.length - 1; i >= 0; i--) if (/양식|카페|브런치|피자|파스타/.test(cuisineOf(list[i].place).join() + (list[i].place.name || ''))) list.splice(i, 1);   // 저녁은 양식 제외 (점심은 OK)
  for (const x of list) if (x.km > radiusKm) x.reasons = [`유명 맛집 (${fmtKm(x.km)}km)`, ...x.reasons];
  if (ctx.toward && hasCoord(withCoord(ctx.toward))) { const o = withCoord(origin), tw = withCoord(ctx.toward), base0 = haversine(o, tw);   // 다음 장소 가는 길에 가까운 곳 우선
    list.sort((a, b) => { const da = haversine(o, withCoord(a.place)) + haversine(withCoord(a.place), tw) - base0, db = haversine(o, withCoord(b.place)) + haversine(withCoord(b.place), tw) - base0; return (da - db) * 3 - (a.score - b.score) * 0.2; }); }
  for (const x of list) {               // 영업시간 있는 곳은 그 시각에 열려 있어야
    const os = openState(x.place, when); if (os === 'closed' || os === 'dayoff' || os === 'break') continue;
    return x;
  }
  return null;
}
function candMeal(cfg, slot, near) {                            // 등록 식당이 없을 때: 근처 새 후보(카카오·구글)로 채움
  const c = cfg.candPick && cfg.candPick[slot]; if (!c) return null;
  return { kind: 'meal', slot, near, cand: c, place: c.name, note: [`${c.src || '카카오'} 추천`, c.cuisine, c.km != null ? fmtKm(c.km) + 'km' : ''].filter(Boolean).join(' · ') };
}
function routeCost(start, list, end) { let c = 0, p = start; for (const s of list) { c += leg(p, s).min; p = s; } if (end) c += leg(p, end).min; return c; }
function bestOrder(start, list, end) {                           // 동선 최단 순서 (6곳 이하 전수, 그 이상은 최근접)
  if (list.length <= 1) return list.slice();
  if (list.length > 6) { const rest = list.slice(), out = []; let p = start; while (rest.length) { rest.sort((a, b) => haversine(p, a) - haversine(p, b)); p = rest.shift(); out.push(p); } return out; }
  let best = list.slice(), bc = Infinity; const a = list.slice();
  const perm = l => { if (l === a.length) { const c = routeCost(start, a, end); if (c < bc) { bc = c; best = a.slice(); } return; } for (let i = l; i < a.length; i++) { [a[l], a[i]] = [a[i], a[l]]; perm(l + 1); [a[l], a[i]] = [a[i], a[l]]; } };
  perm(0); return best;
}
function bestSubset(start, cands, k, end) {                      // k곳 고르기: 출발→…→도착 이동시간이 가장 짧은 묶음
  if (cands.length <= k) return bestOrder(start, cands, end);
  let best = null, bc = Infinity, n = 0; const pick = [];
  const rec = i => { if (n > 400) return; if (pick.length === k) { n++; const o = bestOrder(start, pick, end); const c = routeCost(start, o, end); if (c < bc) { bc = c; best = o; } return; } for (let j = i; j < cands.length; j++) { pick.push(cands[j]); rec(j + 1); pick.pop(); } };
  rec(0); return best || bestOrder(start, cands.slice(0, k), end);
}
function buildPlan(cfg) {
  const home = cfg.base, lodge = cfg.lodge && hasCoord(cfg.lodge) && cfg.lodging === 'stay' ? cfg.lodge : null;   // 집 = 출발·귀가, 숙소 = 현지 기준점
  const base = lodge || home, ctx = { season: cfg.season, family: famProfile(), country: base.country, mode: 'plan', skip: new Set(cfg.skipMeals || []), allowApprox: true };
  const stayOf = sp => (cfg.stayOverride && cfg.stayOverride[sp.id]) || stayMin(sp);
  let pool = cfg.spots.map(withCoord).filter(hasCoord);
  const extra = (cfg.extra || []).map(withCoord).filter(hasCoord).filter(s => !pool.some(p => p.id === s.id));
  const stayTrip = cfg.lodging === 'stay' && !!lodge;
  let prevEnd = home;                                            // 숙소 미정 숙박: 전날 마지막 장소 근처에서 다음날 시작
  const dStart = di => di === 0 ? home : cfg.lodging === 'stay' ? (lodge || prevEnd) : base;
  const dEnd = di => di === cfg.days - 1 ? home : cfg.lodging === 'stay' ? (lodge || null) : base;
  const days = [], used = new Set(), autoIds = new Set();
  for (let di = 0; di < cfg.days; di++) {
    const lastDay = di === cfg.days - 1, stayMode = cfg.lodging === 'stay' && !lastDay;
    const date = addDays(cfg.start, di) || new Date();
    const at = m => { const d = new Date(date); d.setHours(0, m, 0, 0); return d; };
    const S0 = dStart(di), E0 = dEnd(di);
    const homeLeg = lastDay && lodge ? leg(lodge, home).min : 0;
    const dayEndMin = cfg.endMin - homeLeg;
    // ① 이 날 갈 곳 고르기 + 동선 순서
    let todays;
    const forced = cfg.dayOrders && cfg.dayOrders[di];
    if (forced) { todays = forced.map(id => pool.find(p => p.id === id) || extra.find(p => p.id === id)).filter(Boolean); }
    else {
      const k = Math.min(cfg.maxSpots, Math.max(1, Math.ceil(pool.length / (cfg.days - di))));
      todays = bestSubset(S0, pool, Math.min(k, pool.length), E0);
      const want = Math.min(cfg.maxSpots, 2);
      if (cfg.autoFill && todays.length < want && extra.length) {   // 모자라면 같은 지역에서 동선상 가장 싸게 끼워 넣을 수 있는 곳 보충
        while (todays.length < want && extra.length) { let bi = -1, bc = Infinity; extra.forEach((e, i) => { const c = routeCost(S0, bestOrder(S0, [...todays, e], E0), E0); if (c < bc) { bc = c; bi = i; } }); if (bi < 0 || bc - routeCost(S0, todays, E0) > 90) break; const e = extra.splice(bi, 1)[0]; autoIds.add(e.id); todays.push(e); }
        todays = bestOrder(S0, todays, E0);
      }
    }
    pool = pool.filter(p => !todays.includes(p));
    // ② 시간표 (오전 절반 → 점심 → 오후 → 저녁)
    const items = []; let cur = S0, t = cfg.startMin, km = 0, mv = 0, lunchDone = false;
    const push = (time, activity, place, ex = {}) => items.push({ time: hhmm(time), activity, place: place?.name || null, place_id: place?.id || null, ...ex });
    const move = (to, label) => { const L = leg(cur, to); t += L.min; km += L.km; mv += L.min; push(t, label || '이동 → ' + to.name, null, { kind: 'move', from: cur, to, km: L.km, min: L.min, note: `약 ${L.min}분 (${fmtKm(L.km)}km)` }); cur = to; };
    const hrs = m => `${Math.round(m / 60 * 10) / 10}h`;
    const lunch = (lt, near, toward) => { const m = mealPick(near, at(lt), used, { ...ctx, toward, meal: 'lunch', force: cfg.forceMeals && cfg.forceMeals[di + ':lunch'] }, cfg.mealKm || 3);
      if (m) { used.add(m.place.id); push(lt, '중식', m.place, { kind: 'meal', note: m.reasons.slice(0, 3).join(' · '), slot: di + ':lunch', near }); } else push(lt, '중식', null, candMeal(cfg, di + ':lunch', near) || { kind: 'meal', slot: di + ':lunch', near, note: '근처 식당 찾는 중…' });
      lunchDone = true; return lt + 75; };
    push(t, di > 0 && cfg.lodging === 'stay' ? '숙소 출발' : '출발', S0.id && S0 === home ? S0 : null, { kind: 'base', place: di > 0 && cfg.lodging === 'stay' && !lodge ? `전일 숙소 (${S0.name} 인근)` : S0.name });
    if ((base.country !== 'KR' || cfg.lodging === 'stay') && cfg.breakfast && di > 0) { push(t, '조식', null, { kind: 'meal', note: '숙소 조식' }); t += 50; }
    if (!todays.length) push(t + 30, '자유 일정', null, { kind: 'spot', note: '선택한 휴양지 소진 — 추천에서 추가' });
    let lunchAfter = todays.length >= 2 ? Math.ceil(todays.length / 2) : 1;
    if (todays.length === 3) {                                    // 홀수(3곳): 무거운 1곳은 반나절 단독, 가벼운 2곳(서로 가까운)은 묶어서 반대편 반나절
      let hv = todays.reduce((m, s) => stayOf(s) > stayOf(m) ? s : m, todays[0]);
      if (!forced) {                                              // 단독 1곳 × 순서 4가지 모두 비교: 이동시간 + (단독이 가벼우면 벌점) + (묶은 2곳이 멀면 벌점)
        const mx = Math.max(...todays.map(stayOf)); let best = null, bc = Infinity;
        for (const h of todays) { const l = todays.filter(s => s !== h); const pen = (mx - stayOf(h)) / 60 * 20 + leg(l[0], l[1]).min * 0.5;
          for (const o of [[h, l[0], l[1]], [h, l[1], l[0]], [l[0], l[1], h], [l[1], l[0], h]]) { const c = routeCost(S0, o, E0) + pen; if (c < bc) { bc = c; best = o; hv = h; } } }
        todays = best; }
      lunchAfter = todays[0] === hv ? 1 : todays[2] === hv ? 2 : 2;
    }
    const n = todays.length;
    for (let i = 0; i < n; i++) {
      const spot = todays[i], stay = stayOf(spot), L = leg(cur, spot);
      if (t + L.min + stay > dayEndMin - 60 && items.some(x => x.kind === 'spot')) { pool.unshift(...todays.slice(i)); break; }   // 시간 초과 → 다음 날로
      move(spot);
      if (!lunchDone && t >= 11 * 60 + 30 && (i >= lunchAfter || t >= 12 * 60 + 30 || t + stay > 13 * 60 + 30)) t = lunch(t, spot, todays[i + 1]);   // 도착이 늦거나 끝나면 점심이 너무 늦어질 때 → 먼저 점심
      const tag = autoIds.has(spot.id) ? ' · 자동 추천' : '';
      if (!lunchDone && t < 11 * 60 + 30 && t + stay > 14 * 60 + 30) {                 // 한 곳에 오래(점심 시간을 통째로 걸침): 체류 중 근처 점심
        push(t, spot.name, spot, { kind: 'spot', note: hrs(stay) + tag }); const tEnd = t + stay; lunch(12 * 60 + 15, spot); const last = items[items.length - 1]; last.note = ['체류 중 근처', last.note].filter(Boolean).join(' · '); t = tEnd + 60;
      } else { push(t, spot.name, spot, { kind: 'spot', note: hrs(stay) + tag }); t += stay; }
      if (!lunchDone && i + 1 >= lunchAfter && (i + 1 < n || t <= 14 * 60 + 30)) t = lunch(Math.max(t, 11 * 60 + 30), spot, todays[i + 1]);   // 오전 절반 끝 → 점심 (다음 장소 방향)
      if (cfg.rest && !items.some(x => x.kind === 'rest') && t >= 13 * 60 && t <= 15 * 60 + 30) { push(t, '숙소 휴식 · 낮잠', null, { kind: 'rest', note: '1.5h' }); t += 90; }
      used.add(spot.id);
    }
    if (!lunchDone && t <= 15 * 60 && items.some(x => x.kind === 'spot' && x.place_id)) t = lunch(Math.max(t, 11 * 60 + 30), cur);
    // ③ 저녁 · 숙소/귀가
    const goingHome = !stayMode && E0 === home && home.country === 'KR';               // 집으로 돌아가는 날: 집 앞에서 저녁 X
    const dt0 = Math.max(t, 18 * 60);
    const localDinnerOK = goingHome && cur !== home && dt0 + 80 + leg(cur, home).min <= cfg.endMin && leg(cur, home).min > 25;   // 복귀 시각 안에 현지에서 먹고 출발 가능할 때만
    const leaveEarly = (lastDay && lodge && homeLeg >= 120 && t <= 17 * 60 + 30) || (goingHome && !localDinnerOK);
    if (t < dayEndMin && !leaveEarly) {
      const farHome = E0 && cur !== E0 && leg(cur, E0).min >= 120;
      const dinnerNear = stayMode && lodge ? lodge : (goingHome || t >= 17 * 60 + 30 || stayMode || farHome || !E0) ? cur : E0;
      const dt = Math.max(t, 18 * 60);
      if (dinnerNear !== cur) move(dinnerNear, dinnerNear === lodge ? '이동 → 숙소 방향' : '이동 → 거점 방향');
      const m = mealPick(dinnerNear, at(dt), used, { ...ctx, meal: 'dinner', force: cfg.forceMeals && cfg.forceMeals[di + ':dinner'] }, cfg.mealKm || 3);
      if (m) { used.add(m.place.id); push(Math.max(t, dt), '석식', m.place, { kind: 'meal', note: m.reasons.slice(0, 3).join(' · '), slot: di + ':dinner', near: dinnerNear }); }
      else push(Math.max(t, dt), '석식', null, candMeal(cfg, di + ':dinner', dinnerNear) || { kind: 'meal', slot: di + ':dinner', near: dinnerNear, note: '근처 식당 찾는 중…' });
      t = Math.max(t, dt) + 80;
    }
    if (stayMode) {
      if (lodge) { if (cur !== lodge) move(lodge, '이동 → 숙소'); push(t, '숙소 체크인', null, { kind: 'base', place: lodge.name, note: lodge.approx ? '동네 기준 (대략)' : '' }); }
      else { push(t, '숙소 체크인', null, { kind: 'base', place: `숙소 미정 (${cur.name} 인근)`, note: '플래너에서 숙소 지정 가능' }); prevEnd = cur; }
    } else {
      if (cur !== E0) move(E0, E0 === home ? '이동 → 집' : '이동 → 거점');
      push(t, E0.country === 'KR' && E0.id === 'b_home' ? '귀가' : '숙소 복귀', E0, { kind: 'base', note: leaveEarly ? '저녁은 집에서 (복귀 시각 우선)' : '' });
    }
    days.push({ label: dayLabel(cfg.start, di), items, totalKm: Math.round(km), totalMin: mv, over: t > cfg.endMin });
  }
  return { days, leftover: pool, lodge, home };
}

/* 화면 */
async function findAttractions(o, radiusM, country) {           // 근처 관광명소 (국내 카카오 AT4, 해외 구글)
  const known = new Set(S.db.places.map(p => p.name.replace(/\s/g, '')));
  let out = [];
  if (country === 'KR') {
    await loadKakao(); if (!window.kakao?.maps?.services) return [];
    const run = page => new Promise(res => new kakao.maps.services.Places().categorySearch('AT4', (data, st) => res(st === kakao.maps.services.Status.OK ? data : []), { location: new kakao.maps.LatLng(o.lat, o.lng), radius: Math.min(radiusM, 20000), sort: kakao.maps.services.SortBy.ACCURACY, page }));
    const p1 = await run(1); skelStep(1, 2); const data = [...p1, ...await run(2)]; skelStep(2, 2);
    out = data.map(d => ({ name: d.place_name, lat: +d.y, lng: +d.x, address: d.road_address_name || d.address_name, url: d.place_url, cat: (d.category_name || '').split('>').pop().trim(), km: d.distance ? d.distance / 1000 : haversine(o, { lat: +d.y, lng: +d.x }), src: '카카오' }));
  } else if (googleKey()) {
    const g = await googleNearby(o, ['tourist_attraction'], Math.min(radiusM, 50000), 'POPULARITY', 15);
    out = g.map(h => ({ ...h, cat: h.type, km: haversine(o, h), src: '구글' }));
  }
  return out.filter(h => !known.has(h.name.replace(/\s/g, '')) && !/(주차장|화장실|매표소|관리사무소)/.test(h.name)).slice(0, 12);
}
function openPlanner(prefill = {}) {
  const region = prefill.region || (S.region === 'all' ? 'domestic' : S.region);
  const base = S.base || S.db.bases[0];
  const season = prefill.season || seasonNow(new Date((prefill.start || today()) + 'T00:00:00'));
  const ctx = { origin: base, season, family: famProfile() };
  const allSpots = S.db.places.filter(p => p.type === 'spot' && p.region === region && approxCoord(p)).map(s => ({ s, ...scoreSpot(withCoord(s), ctx), approx: !hasCoord(s) })).sort((a, b) => b.score - a.score);
  const isKR = (regionCountry(region) || 'KR') === 'KR';
  const siCount = {}; S.db.places.filter(p => (isKR ? p.country === 'KR' : p.region === region) && p.type !== 'restaurant').forEach(p => { const k = areaKey(p) || '기타'; siCount[k] = (siCount[k] || 0) + 1; });   // 저장한 휴양지·우리 장소 수
  const areas = Object.entries(siCount).sort((a, b) => b[1] - a[1]);
  const area = prefill.area && (isKR || siCount[prefill.area]) ? prefill.area : 'all';     // 목적지 시·군 (예: 양평) — 국내는 저장 0곳이어도 선택 가능
  let lodge = prefill.lodge || null;                                                      // 숙소(동네·호텔·펜션) = 현지 기준점. 집 거점은 출발·귀가용
  const pendingCenter = !lodge && area !== 'all' && !areaCenter(area);
  if (!lodge && area !== 'all') { const c = areaCenter(area); if (c) lodge = { name: `${area} (동네 미정)`, lat: c.lat, lng: c.lng, country: 'KR', approx: true, si: area }; }
  const radiusKm = prefill.radiusKm || 20;
  const anchor = lodge && hasCoord(lodge) ? lodge : null;
  const inArea = area === 'all' ? allSpots : allSpots.filter(x => areaKey(x.s) === area);
  const homeP = S.db.bases.find(b => b.id === 'b_home') || base;
  const awayTrip = anchor && homeP && hasCoord(homeP) && haversine(anchor, homeP) > 8;          // 집에서 떨어진 숙소 = 그 지역으로 떠나는 여행
  const local = x => !awayTrip || haversine(homeP, withCoord(x.s)) > x.km;                       // 집보다 숙소에 더 가까운 곳만 (집 앞 월문천·하남 제외)
  let spots = anchor ? allSpots.map(x => ({ ...x, km: haversine(anchor, withCoord(x.s)) })).filter(x => x.km <= radiusKm && local(x)).sort((a, b) => ((areaKey(a.s) === area ? 0 : 1) - (areaKey(b.s) === area ? 0 : 1)) || (a.km - b.km)) : inArea;   // 숙소 기준: 같은 시·군 → 가까운 순
  const noCoord = S.db.places.filter(p => p.type === 'spot' && p.region === region && !approxCoord(p)).length;
  const nApprox = spots.filter(x => x.approx).length;
  const wantN = (prefill.days || 1) * Math.min(prefill.maxSpots || 3, 2);
  const autoLocal = anchor && spots.length < wantN && !prefill.spots;                           // 저장한 곳이 모자라면 현지 관광지를 자동으로 불러옴
  const preN = (prefill.days || 1) * Math.min(prefill.maxSpots || 3, 2);
  const pre = prefill.spots ? new Set(prefill.spots) : new Set([...(prefill.with ? [prefill.with] : []), ...spots.filter(x => x.s.wish).map(x => x.s.id), ...spots.slice(0, preN).map(x => x.s.id)].slice(0, preN + 1));   // 지역을 고르면 그 지역 상위 휴양지만 자동 선택
  openSheet(`<div class="sheet-head"><div><h2>여행 플래너</h2><div class="help">${REGION_LABEL[region] || region} · 거점 ${esc(base?.name || '없음')} · ${season}</div></div><button class="close" data-act="close">✕</button></div>
    <form class="form" id="plf">
      <label>제목<input name="title" value="${esc(prefill.title || `${new Date().getFullYear()} ${area !== 'all' ? area : (REGION_LABEL[region] || region)} 가족 여행`)}"></label>
      <div class="two"><label>목적지 (시·군)<select name="area" id="pl-area"><option value="all">${REGION_LABEL[region] || region} 전체 (${allSpots.length})</option>${isKR ? `<optgroup label="저장한 곳 있는 지역">${areas.filter(([k]) => k !== '기타').map(([k, n]) => `<option value="${esc(k)}"${k === area ? ' selected' : ''}>${esc(k)} (${n})</option>`).join('')}</optgroup>${Object.entries(KR_AREAS).map(([g, l]) => `<optgroup label="${g}">${l.map(k => `<option value="${esc(k)}"${k === area && !siCount[k] ? ' selected' : ''}>${esc(k)}${siCount[k] ? ` (${siCount[k]})` : ''}</option>`).join('')}</optgroup>`).join('')}` : areas.map(([k, n]) => `<option value="${esc(k)}"${k === area ? ' selected' : ''}>${esc(k)} (${n})</option>`).join('')}</select></label>
        <label>숙소 반경<select name="radiusKm">${[10, 20, 30, 60].map(k => `<option value="${k}"${k === radiusKm ? ' selected' : ''}>${k}km</option>`).join('')}</select></label></div>
      <label>식당 반경 <small style="font-weight:400">(장소·숙소 기준 · 유명 맛집만 예외)</small><select name="mealKm">${[1, 3, 5, 10].map(k => `<option value="${k}"${k === (prefill.mealKm || 3) ? ' selected' : ''}>${k}km 안</option>`).join('')}</select></label>
      <div class="sec">숙소 (동네 또는 호텔·펜션) <span class="sec-note">이 위치 기준으로 근처 휴양지를 고릅니다</span></div>
      <div class="lodge-box"><div class="lodge-cur">${lodge ? `<b>${esc(lodge.name)}</b>${lodge.approx ? '<span class="apx">대략</span>' : ''}<span class="cap">${lodge.address ? esc(lodge.address) : `${lodge.lat?.toFixed?.(3)}, ${lodge.lng?.toFixed?.(3)}`}</span>` : '<span class="cap">숙소 미정 — 아래에서 검색하거나 시·군을 고르면 동네 중심으로 잡습니다</span>'}</div>
        ${lodge && !lodge.approx && !lodge.baseId ? '<label class="check"><input name="saveLodge" type="checkbox" checked> 일정 저장 시 이 숙소를 거점 목록에도 저장 (다음 여행·근처 추천에 재사용)</label>' : ''}
        <div class="inline"><input id="lq" placeholder="동네명 또는 호텔·펜션명 (예: 남해 상주, 힐튼 남해)"><button type="button" class="primary" data-act="lsearch">검색</button></div><div class="hits" id="lhits" hidden></div>
        ${S.db.bases.filter(b => b.id !== 'b_home' && b.country === (regionCountry(region) || 'KR')).length ? `<div class="chips" style="margin-top:6px">${S.db.bases.filter(b => b.id !== 'b_home' && b.country === (regionCountry(region) || 'KR')).map(b => `<button type="button" class="chip" data-lodgebase="${b.id}">▣ ${esc(b.name)}</button>`).join('')}</div>` : ''}</div>
      <div class="three"><label>출발일<input name="start" type="date" value="${esc(prefill.start || today())}"></label><label>일수<input name="days" type="number" min="1" max="7" value="${prefill.days || 1}"></label><label>계절 <small style="font-weight:400">(출발일 기준 자동)</small><input name="season" value="${seasonNow(new Date((prefill.start || today()) + 'T00:00:00'))}" readonly style="background:var(--panel-2);color:var(--text-2)"></label></div>
      <div class="three"><label>출발<input name="startT" type="time" value="09:00"></label><label>복귀<input name="endT" type="time" value="20:00"></label><label>하루 최대<select name="maxSpots">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === (prefill.maxSpots || 3) ? ' selected' : ''}>${n}곳</option>`).join('')}</select></label></div>
      <div class="two"><label>숙박<select name="lodging"><option value="return"${base?.country === 'KR' && base?.id === 'b_home' ? '' : ' selected'}>매일 거점 복귀</option><option value="stay"${base?.country === 'KR' && base?.id === 'b_home' ? ' selected' : ''}>${lodge ? `숙소(${esc(lodge.name.split(' (')[0])}) 숙박 · 마지막 날 귀가` : '현지 숙박 (마지막 날 복귀)'}</option></select></label><label class="check" style="align-self:end"><input name="breakfast" type="checkbox" checked> 숙소 조식 포함</label></div>
      ${famProfile().toddler ? '<label class="check"><input name="rest" type="checkbox" checked> 유아 낮잠 · 13:30–15:00 숙소 휴식 넣기</label>' : ''}
      <label class="check"><input name="autoFill" type="checkbox" ${prefill.autoFill === false ? '' : 'checked'}> 선택한 곳이 모자라면 같은 지역 휴양지로 자동 채우기</label>
      <div class="sec">휴양지 ${anchor ? `<span class="sec-note">숙소 ${radiusKm}km 안 ${spots.length}곳 · 상위 자동 선택 (빼거나 더할 수 있음)` : '<span class="sec-note">점수순 · ★ 가고싶다 우선 선택됨'}${nApprox ? ` · <span class="apx">대략</span> ${nApprox}곳은 시·군 중심으로 계산` : ''}${noCoord ? ` · 지역 불명 ${noCoord}곳 제외` : ''}</span></div>
      ${autoLocal ? `<div class="help" id="pl-autol">${esc(area !== 'all' ? area : '숙소')} 근처 관광지 불러오는 중…</div>` : ''}
      <div class="pick" id="pick">${spots.map(x => `<label class="pick-row"><input type="checkbox" value="${x.s.id}" ${pre.has(x.s.id) ? 'checked' : ''}><span class="pick-main"><b>${esc(x.s.name)}</b> <span class="mono reco-score">${x.score}</span>${x.approx ? '<span class="apx">대략</span>' : ''}<span class="sub">${[x.km != null ? `숙소에서 ${fmtKm(x.km)}km` : x.s.si, (x.s.seasons || []).join('·'), `${stayMin(x.s) / 60}h`].filter(Boolean).map(esc).join(' · ')}</span><span class="reasons">${x.reasons.slice(0, 3).map(r => `<span class="badge ${/비추|^-/.test(r) ? 'neg' : ''}">${esc(r)}</span>`).join('')}</span></span></label>`).join('') || '<div class="help">이 지역에 등록된 휴양지가 없습니다</div>'}</div>
      ${spots.length ? '' : `<div class="help" style="margin:4px 0">${anchor ? `숙소 ${radiusKm}km 안에 등록된 휴양지가 없어요` : '이 지역에 등록된 휴양지가 없어요'} — 아래에서 새 후보를 찾아 추가하세요</div>`}
      <div class="pl-new" id="pl-new"><button type="button" class="chip" data-act="findnew">＋ ${(regionCountry(region) || 'KR') === 'KR' ? '카카오' : '구글'}에서 근처 관광지 새로 찾기</button><div id="pl-newl"></div></div>
      <div class="btns"><button class="primary" data-act="build">동선 생성</button><span class="help" style="align-self:center">선택 안 하면 추천 상위로 자동 구성</span></div>
    </form>
    <div id="plan-out"></div>`);
  const f = $('#plf'); let plan = null, cfg = null;
  if (autoLocal) (async () => {
    const hits = (await findAttractions(anchor, radiusKm * 1000, regionCountry(region) || 'KR')).filter(h => !awayTrip || haversine(homeP, h) > haversine(anchor, h));
    const box = $('#pl-autol'); if (!$('#plf')) return;
    if (!hits.length) { if (box) box.textContent = window.kakao?.maps?.services ? '근처 관광지를 못 찾았어요 — 반경을 넓혀 보세요' : '카카오 지도 키가 연결되면 현지 관광지를 자동으로 채웁니다'; return; }
    S.tmpPlaces ||= new Map(); const need = Math.max(0, wantN - $$('#pick input:checked').length);
    const rows = hits.slice(0, 8).map((h, i) => { const id = 'tmp_' + h.name.replace(/\s/g, '').slice(0, 20); if (!S.tmpPlaces.has(id)) S.tmpPlaces.set(id, { id, type: 'spot', country: regionCountry(region) || 'KR', region, name: h.name, lat: h.lat, lng: h.lng, address: h.address || null, si: area !== 'all' ? area : null, do: null, seasons: [], tags: [], rating: 0, visits: 0, visitLog: [], wish: false, naver: {}, kakao: h.url ? { url: h.url } : {}, src: h.src, tmp: true });
      return `<label class="pick-row"><input type="checkbox" value="${id}" ${i < need ? 'checked' : ''}><span class="pick-main"><b>${esc(h.name)}</b> <span class="bd" style="background:var(--kakao);color:var(--on-kakao)">${esc(h.src)} 추천</span><span class="sub">${esc([h.cat, '숙소에서 ' + fmtKm(haversine(anchor, h)) + 'km'].filter(Boolean).join(' · '))}</span></span></label>`; }).join('');
    if (box) box.outerHTML = `<div class="help">${esc(area !== 'all' ? area : '숙소')} 현지 관광지 ${Math.min(hits.length, 8)}곳 (저장 안 된 곳 · 일정 저장 시 휴양지로 추가)</div>`;
    $('#pick').insertAdjacentHTML('afterbegin', rows);
    const fd = $('#plf'); const want = Math.max(2, (+fd?.days?.value || 1) * Math.min(+fd?.maxSpots?.value || 3, 2));
    const all = $$('#pick input'); const rank = i => { const p = placeById(i.value); return p?.tmp ? 1 : areaKey(p) === area ? 0 : 2; };
    all.slice().sort((a, b) => rank(a) - rank(b)).forEach((i, k) => { i.checked = k < want; });   // 같은 시·군 저장분 → 현지 관광지 → 그 외
  })();
  if (pendingCenter) { const lc = $('.lodge-cur'); if (lc) lc.innerHTML = `<span class="cap">${esc(area)} 위치 찾는 중…</span>`; geocodeArea(area).then(c => { if (c && $('#plf')) reopen($('#plf'), { area }); else if (lc) lc.innerHTML = '<span class="cap">지역 위치를 못 찾았어요 — 숙소를 직접 검색해 주세요</span>'; }); }
  f.addEventListener('submit', e => e.preventDefault());
  f.querySelector('[name=start]').addEventListener('change', e => { const sv = seasonNow(new Date(e.target.value + 'T00:00:00')); f.querySelector('[name=season]').value = sv; });   // 계절은 출발일로 자동
  const reopen = (f0, patch) => { const d = Object.fromEntries(new FormData(f0)); openPlanner({ ...prefill, spots: null, title: /^\d{4} .+ 가족 여행( 일정)?$/.test(d.title) ? '' : d.title, start: d.start, days: +d.days || 1, maxSpots: +d.maxSpots, radiusKm: +d.radiusKm || 20, mealKm: +d.mealKm || 3, area: d.area, lodge, ...patch }); };
  const bindArea = f0 => { f0.querySelector('[name=area]')?.addEventListener('change', e => reopen(f0, { area: e.target.value, lodge: null }));
    f0.querySelector('#lq')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f0.querySelector('[data-act=lsearch]')?.click(); } });
    f0.querySelector('[name=radiusKm]')?.addEventListener('change', e => reopen(f0, { radiusKm: +e.target.value }));
    f0.addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'lsearch') { const q = $('#lq').value.trim(); if (!q) return toast('동네명이나 숙소 이름을 입력하세요'); b.textContent = '검색 중…'; let hits = []; try { hits = await geoSearch(q, regionCountry(region) || 'KR', area !== 'all' ? area : ''); if (!hits.length && area !== 'all') hits = await osmSearch(`${area} ${q}`, regionCountry(region) || 'KR'); } catch (err) { toast('검색 실패: ' + err.message); } b.textContent = '검색'; showHits($('#lhits'), hits, h => { const ak = isKR ? (Object.values(KR_AREAS).flat().filter(k => (h.address || '').includes(k.replace(/^(경기|강원|경남) /, ''))).sort((a, b) => b.length - a.length)[0] || area) : area;
        reopen(f0, { area: ak, lodge: { name: h.name, lat: h.lat, lng: h.lng, address: h.address, country: regionCountry(region) || 'KR', si: ak } }); }); }
      if (b.dataset.lodgebase) { const bb = S.db.bases.find(x => x.id === b.dataset.lodgebase); reopen(f0, { lodge: { name: bb.name, lat: bb.lat, lng: bb.lng, country: bb.country, baseId: bb.id } }); } }); };
  bindArea(f);
  let curDi = 0; const formHtml = $('#sheet-inner').innerHTML;
  const showForm = () => { const html = $('#sheet-inner').innerHTML; if (!$('#plf')) { $('#sheet-inner').innerHTML = formHtml; rebind(); } };
  const showDay = di => { curDi = di; $('#sheet-inner').innerHTML = `<div class="pl-sheet">${renderPlan(plan, cfg, di)}</div>`; drawPlanMap(plan, di); bindDrag(di); fillNear(); };
  const nearCache = S.nearCache ||= {}; const tried = new Set();
  const nearCands = async near => {                              // 근처 식당 후보 (위치별 캐시)
    const o = withCoord(near); if (!hasCoord(o)) return [];
    const k = o.lat.toFixed(3) + ',' + o.lng.toFixed(3); if (nearCache[k]) return nearCache[k];
    const ctx2 = { season: cfg.season, family: famProfile(), country: cfg.base.country, mode: 'plan' };
    let r = []; try { r = (cfg.base.country === 'KR' ? await recommendNearbyKakao(o, ctx2, (cfg.mealKm || 3) * 1000) : await recommendNearbyGoogle(o, ctx2, (cfg.mealKm || 3) * 1000)).map(x => ({ ...x.candidate, km: x.km, score: x.score, src: cfg.base.country === 'KR' ? '카카오' : '구글', cuisine: Array.isArray(x.candidate.cuisine) ? x.candidate.cuisine[0] : x.candidate.cuisine })); } catch {}
    return (nearCache[k] = r);
  };
  const fillNear = async () => {                                 // '찾는 중' 식사 칸을 근처 새 후보로 채우고 다시 그림
    const need = plan.days.flatMap(d => d.items).filter(it => it.kind === 'meal' && !it.place_id && !it.cand && it.slot && it.near && !tried.has(it.slot));
    if (!need.length) return; need.forEach(it => tried.add(it.slot));
    cfg.candPick ||= {}; const usedNames = new Set(Object.values(cfg.candPick).map(c => c.name)); let got = 0;
    for (const it of need) { const list = await nearCands(it.near); const c = list.find(x => !usedNames.has(x.name) && !(/dinner/.test(it.slot) && /양식|카페|기타/.test(x.cuisine || '') && /피자|파스타|카페|커피|브런치|버거|핫도그/.test(x.name + (x.category || ''))) && !(/dinner/.test(it.slot) && x.cuisine === '양식')); if (c) { cfg.candPick[it.slot] = c; usedNames.add(c.name); got++; } }
    if (got) { plan = buildPlan(cfg); showDay(curDi); }
    else { $$('.pl-row.meal .cap').forEach(el => { el.innerHTML = el.innerHTML.replace('근처 식당 찾는 중…', cfg.base.country === 'KR' ? (window.kakao?.maps?.services ? '근처 식당 없음 — 현지 선택' : '카카오 키 연결 시 근처 식당 추천') : '구글 키 연결 시 근처 식당 추천'); }); }
  };
  const bindDrag = di => {                                       // 휴양지 순서 끌어서 바꾸기 (≡)
    const list = $('.pl-list'); if (!list) return; let dragIdx = null;
    list.addEventListener('dragstart', e => { const r = e.target.closest('.pl-row[draggable]'); if (!r) return; dragIdx = +r.dataset.idx; e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); });
    list.addEventListener('dragover', e => { const r = e.target.closest('.pl-row[draggable]'); if (r) { e.preventDefault(); r.classList.add('over'); } });
    list.addEventListener('dragleave', e => { e.target.closest('.pl-row')?.classList.remove('over'); });
    list.addEventListener('drop', e => { const r = e.target.closest('.pl-row[draggable]'); if (!r || dragIdx == null) return; e.preventDefault(); const to = +r.dataset.idx; if (to === dragIdx) return;
      const ids = plan.days[di].items.filter(it => it.kind === 'spot' && it.place_id).map(it => it.place_id); const uniq = [...new Set(ids)];
      const from = plan.days[di].items[dragIdx].place_id, target = plan.days[di].items[to].place_id; const a = uniq.indexOf(from), bI = uniq.indexOf(target); if (a < 0 || bI < 0) return;
      uniq.splice(a, 1); uniq.splice(bI, 0, from); cfg.dayOrders[di] = uniq; plan = buildPlan(cfg); showDay(di); toast('순서 변경 · 시간 다시 계산'); });
  };
  let rebind = () => { const f2 = $('#plf'); if (!f2) return; bindArea(f2); f2.addEventListener('submit', e => e.preventDefault()); f2.querySelector('[name=start]').addEventListener('change', e => { f2.querySelector('[name=season]').value = seasonNow(new Date(e.target.value + 'T00:00:00')); }); };
  $('#sheet-inner').onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'close') { closeSheet(); return; }
    if (b.dataset.go) { openDetail(b.dataset.go); return; }
    if (b.dataset.act === 'findnew') {
      const o = anchor || (area !== 'all' && SI_CENTER[area] ? { lat: SI_CENTER[area][0], lng: SI_CENTER[area][1] } : null) || (base && hasCoord(base) ? base : null);
      const list = $('#pl-newl'); if (!o) { list.innerHTML = '<div class="help">숙소나 목적지를 먼저 정해주세요</div>'; return; }
      list.innerHTML = skelHtml('근처 관광지 찾는 중…', (regionCountry(region) || 'KR') === 'KR' ? '카카오' : '구글', 0);
      const hits = await findAttractions(o, radiusKm * 1000, regionCountry(region) || 'KR');
      S.plNew = hits;
      list.innerHTML = hits.length ? hits.map((h, i) => `<div class="rc-row nb"><div class="m"><b>${esc(h.name)}</b><p class="cap">${esc([h.cat, h.km != null ? (anchor ? '숙소에서 ' : '') + fmtKm(h.km) + 'km' : '', h.rating ? 'G' + h.rating : ''].filter(Boolean).join(' · '))}</p></div><button type="button" class="chip" data-addnew="${i}">+ 추가</button></div>`).join('')
        : `<div class="help">${(regionCountry(region) || 'KR') === 'KR' ? (window.kakao?.maps?.services ? '반경 안 관광지 없음' : '카카오 지도 키가 연결돼야 찾을 수 있어요 (설정 › 카카오 JavaScript 키)') : (googleKey() ? '반경 안 관광지 없음' : '설정에서 구글 Places 키를 넣으면 찾을 수 있어요')}</div>`;
      return;
    }
    if (b.dataset.addnew != null) {                               // 새 후보 → 휴양지로 등록 + 선택
      const h = S.plNew?.[+b.dataset.addnew]; if (!h) return;
      let p = S.db.places.find(x => x.name.replace(/\s/g, '') === h.name.replace(/\s/g, ''));
      if (!p) { p = { id: uid(), type: 'spot', country: regionCountry(region) || 'KR', region, name: h.name, lat: h.lat, lng: h.lng, address: h.address || null, si: area !== 'all' ? area : null, do: null, seasons: [], tags: [], rating: 0, visits: 0, visitLog: [], wish: false, naver: {}, kakao: h.src === '카카오' ? { url: h.url } : {}, google: h.src === '구글' ? { url: h.url, rating: h.rating, reviews: h.reviews } : undefined, src: h.src }; S.db.places.push(p); markDirty(); }
      if (!$(`#pick input[value="${p.id}"]`)) $('#pick').insertAdjacentHTML('afterbegin', `<label class="pick-row"><input type="checkbox" value="${p.id}" checked><span class="pick-main"><b>${esc(p.name)}</b> <span class="badge">새 후보</span><span class="sub">${esc([h.cat, h.km != null ? fmtKm(h.km) + 'km' : ''].filter(Boolean).join(' · '))}</span></span></label>`);
      else $(`#pick input[value="${p.id}"]`).checked = true;
      b.textContent = '추가됨 ✓'; b.disabled = true; return;
    }
    if (b.dataset.act === 'build') {
      const d = Object.fromEntries(new FormData($('#plf')));
      let ids = $$('#pick input:checked').map(i => i.value);
      if (!ids.length) {                                          // 미선택 → 추천 상위 자동 (없으면 새 후보 찾기)
        const want = Math.max(1, (+d.days || 1) * Math.min(+d.maxSpots || 3, 2));
        const cand = $$('#pick input').map(i => placeById(i.value)).filter(Boolean).map(withCoord);
        const auto = []; if (cand.length) { let cur = cand[0]; auto.push(cur.id);                     // 1순위 + 그 근처(40km)부터 이어 붙임 → 하루에 서로 가까운 곳끼리
          while (auto.length < want) { const nx = cand.filter(p => !auto.includes(p.id) && hasCoord(p)).map(p => [haversine(cur, p), p]).sort((a, b) => a[0] - b[0])[0]; if (!nx || nx[0] > 40 * Math.max(1, (+d.days || 1) - 0.5)) break; auto.push(nx[1].id); cur = nx[1]; } }
        if (!auto.length) { toast('등록된 휴양지가 없어요 — 새 후보를 찾는 중'); $('#plf [data-act=findnew]')?.click(); return; }
        ids = auto; auto.forEach(id => { const cb = $(`#pick input[value="${id}"]`); if (cb) cb.checked = true; }); toast(`선택이 없어 추천 ${auto.length}곳으로 만들었어요`);
      }
      cfg = { title: d.title.trim(), start: d.start, days: +d.days || 1, season: d.season, base, startMin: toMin(d.startT) ?? 540, endMin: toMin(d.endT) ?? 1200, maxSpots: +d.maxSpots, hopKm: 40, breakfast: !!d.breakfast, rest: !!d.rest, lodging: (+d.days > 1 ? d.lodging : 'return'), spots: ids.map(placeById), autoFill: !!d.autoFill, saveLodge: !!d.saveLodge, mealKm: +d.mealKm || 3, area, lodge, radiusKm, extra: $$('#pick input').map(i => i.value).filter(id => !ids.includes(id)).map(placeById).filter(Boolean) };
      tried.clear(); cfg.dayOrders = prefill.dayOrders || {}; cfg.skipMeals = []; cfg.candPick = prefill.candPick || {}; cfg.stayOverride = prefill.stayOverride || {}; cfg.forceMeals = prefill.forceMeals || {}; plan = buildPlan(cfg); showDay(0);
    }
    if (b.dataset.act === 'plan-back') { showForm(); return; }
    if (b.dataset.act === 'plan-prev') { const di = +b.dataset.di; if (di === 0) showForm(); else showDay(di - 1); return; }
    if (b.dataset.act === 'plan-next') { showDay(+b.dataset.di + 1); return; }
    if (b.dataset.act === 'replan') { const di = +b.dataset.di; delete cfg.dayOrders[di]; plan = buildPlan(cfg); showDay(di); return; }
    if (b.dataset.swap != null) {                               // 식사 바꾸기: 후보 3곳 중 고르기
      const idx = +b.dataset.swap, it = plan.days[curDi].items[idx]; const row = b.closest('.pl-row'); if (!it || !row) return;
      if (row.nextElementSibling?.classList.contains('pl-cands')) { row.nextElementSibling.remove(); return; }
      const near = it.near || (it.place_id && placeById(it.place_id)); const ctx2 = { season: cfg.season, family: famProfile(), country: cfg.base.country, mode: 'plan', allowApprox: true, origin: near ? withCoord(near) : cfg.base };
      const cands = recommendFromDb(ctx2, 30).filter(x => x.place.id !== it.place_id && x.km != null && (x.km <= (cfg.mealKm || 3) * 1.5 || (isFamous(x.place) && x.km <= Math.max((cfg.mealKm || 3) * 3, 10)))).slice(0, 3);   // 식당 반경 안 위주
      row.insertAdjacentHTML('afterend', `<div class="pl-cands">${cands.map(x => `<button class="rc-row" data-pick-meal="${x.place.id}" data-slot="${esc(it.slot || '')}">${thumbHtml(x.place, 'tile')}<div class="m"><b>${esc(x.place.name)}</b><p class="cap">${esc([cuisineOf(x.place)[0], x.km != null ? (x.approx && x.km < 0.5 ? '같은 지역' : fmtKm(x.km) + 'km') : areaOf(x.place), x.reasons.filter(r => !/km$/.test(r))[0]].filter(Boolean).join(' · '))}</p></div></button>`).join('') || '<div class="help">근처 등록 식당 없음</div>'}<div class="pl-cnew"><span class="bd" style="background:var(--${cfg.base.country === 'KR' ? 'kakao' : 'google'});color:${cfg.base.country === 'KR' ? 'var(--on-kakao)' : '#fff'}">${cfg.base.country === 'KR' ? '카카오' : '구글'}</span> 근처 새 후보 불러오는 중…</div></div>`);
      const box = row.nextElementSibling; const list = near ? await nearCands(near) : []; S.swapCands = list.filter(c => c.name !== it.place).slice(0, 5);
      const nb = box.querySelector('.pl-cnew'); if (nb) nb.outerHTML = S.swapCands.length ? S.swapCands.map((c, k) => `<button class="rc-row" data-pick-cand="${k}" data-slot="${esc(it.slot || '')}"><span class="tile" style="--cat:var(--cat-${CAT_VAR[c.cuisine] || 'etc'})">${esc(CAT_GLYPH[c.cuisine] || '·')}</span><div class="m"><b>${esc(c.name)} <span class="bd" style="background:var(--${c.src === '구글' ? 'google' : 'kakao'});color:${c.src === '구글' ? '#fff' : 'var(--on-kakao)'}">${esc(c.src)}</span></b><p class="cap">${esc([c.cuisine, c.km != null ? fmtKm(c.km) + 'km' : '', c.google?.reviews ? '리뷰 ' + c.google.reviews : ''].filter(Boolean).join(' · '))}</p></div></button>`).join('') : `<div class="help">${cfg.base.country === 'KR' ? (window.kakao?.maps?.services ? '근처 새 후보 없음' : '카카오 키 연결 시 근처 식당 추천') : '구글 키 연결 시 근처 식당 추천'}</div>`;
      return; }
    if (b.dataset.pickMeal) { cfg.forceMeals[b.dataset.slot] = b.dataset.pickMeal; if (cfg.candPick) delete cfg.candPick[b.dataset.slot]; plan = buildPlan(cfg); showDay(curDi); toast('식당 변경'); return; }
    if (b.dataset.pickCand != null) { const c = (S.swapCands || [])[+b.dataset.pickCand]; if (!c) return; cfg.candPick ||= {}; cfg.candPick[b.dataset.slot] = c; delete cfg.forceMeals[b.dataset.slot]; plan = buildPlan(cfg); showDay(curDi); toast('식당 변경 · ' + c.name); return; }
    if (b.dataset.stay) { const [id, delta] = b.dataset.stay.split(':'); const p = placeById(id); const cur = cfg.stayOverride[id] ?? stayMin(p); cfg.stayOverride[id] = Math.max(30, cur + +delta); plan = buildPlan(cfg); showDay(curDi); return; }
    if (b.dataset.act === 'refine' && plan) { b.disabled = true; b.textContent = '실경로 조회 중…'; refinePlanRoutes(plan).then(n => { showDay(curDi); toast(n ? `${n}개 구간 실경로 반영` : '실경로 조회 실패 — 키 확인'); }); return; }
    if (b.dataset.act === 'saveplan' && plan) {
      const t = prefill.tripId && S.db.trips.find(x => x.id === prefill.tripId) || { id: 'trip' + uid(''), title: cfg.title, city: cfg.area && cfg.area !== 'all' ? cfg.area : (REGION_LABEL[region] || region), country: base.country, year: +(cfg.start || today()).slice(0, 4), items: [], planned: true };
      t.title = cfg.title; t.year = +(cfg.start || today()).slice(0, 4); t.items = [];
      for (const day of plan.days) for (const it of day.items) if (it.kind !== 'move') t.items.push({ day: day.label, time: it.time, activity: it.activity, place: it.place, note: it.note || null, place_id: it.place_id || null });
        else t.items.push({ day: day.label, time: it.time, activity: it.activity, place: null, note: it.note, place_id: null });
      t.plan = { start: cfg.start, days: cfg.days, maxSpots: cfg.maxSpots, lodging: cfg.lodging, breakfast: cfg.breakfast, rest: cfg.rest, startMin: cfg.startMin, endMin: cfg.endMin, spots: cfg.spots.map(x => x.id), dayOrders: cfg.dayOrders, stayOverride: cfg.stayOverride, forceMeals: cfg.forceMeals, region, area: cfg.area, autoFill: cfg.autoFill, lodge: cfg.lodge, radiusKm: cfg.radiusKm, candPick: cfg.candPick || {}, mealKm: cfg.mealKm };   // 플래너로 다시 열기용
      for (const day of plan.days) for (const it of day.items) { const tp = it.place_id && S.tmpPlaces?.get(it.place_id); if (tp && !S.db.places.some(p => p.id === tp.id)) { const np = { ...tp }; delete np.tmp; S.db.places.push(np); } }   // 일정에 쓴 현지 관광지 → 휴양지로 등록
      if (cfg.saveLodge && cfg.lodge && !cfg.lodge.baseId && hasCoord(cfg.lodge)) {     // 숙소 → 거점 목록 (중복 좌표 200m 이내는 재사용)
        let lb = S.db.bases.find(x => hasCoord(x) && haversine(x, cfg.lodge) < 0.2);
        if (!lb) { lb = { id: uid('b'), name: cfg.lodge.name, country: cfg.lodge.country || 'KR', lat: cfg.lodge.lat, lng: cfg.lodge.lng, note: `숙소 · ${cfg.title}`, si: cfg.area !== 'all' ? cfg.area : null, address: cfg.lodge.address || null }; S.db.bases.push(lb); }
        cfg.lodge.baseId = lb.id; t.plan.lodge = cfg.lodge;
      }
      if (!S.db.trips.includes(t)) S.db.trips.push(t); markDirty(); closeSheet(); S.trip = t; S.tripDay = 0; showView('trips'); renderTrips(); toast(prefill.tripId ? '일정 수정 저장' : '일정 저장 — 여행 탭');
    }
  };
}
function renderPlan(plan, cfg, di = 0) {                        // 시안 08c: 자동 동선 · D{n} (지도 + 추천 순서 + 저장)
  const d = plan.days[di]; const n = plan.days.length;
  const stops = d.items.filter(it => it.kind !== 'move' && it.kind !== 'base');
  const colorOfIt = it => { const p = it.place_id && placeById(it.place_id); return it.kind === 'meal' ? (p ? catColor(p) : 'var(--cat-seafood)') : 'var(--cat-spot)'; };
  const tagsOf = it => { const p = it.place_id && placeById(it.place_id); return p?.tags?.length ? ' · #' + p.tags[0] : ''; };
  let k = 0;
  const rows = d.items.map((it, i) => {
    if (it.kind === 'move') return `<div class="pl-mv">차 ${it.min}분${it.km ? ` · ${fmtKm(it.km)}km` : ''}</div>`;
    if (it.kind === 'base') {                                    // 집·숙소도 일정 줄로 (시간 포함)
      const lodgeRow = /숙소/.test(it.activity); const home = /귀가|^출발$/.test(it.activity) && !lodgeRow;
      const late = /귀가|복귀/.test(it.activity) && toMin(it.time) > cfg.endMin;
      return `<div class="pl-row base"><span class="num rk" style="background:${lodgeRow ? 'var(--primary-2)' : 'var(--accent)'};color:${lodgeRow ? '#fff' : '#000'}">${lodgeRow ? '▣' : '⌂'}</span><div style="flex:1;min-width:0"><b>${esc(it.activity)} · ${esc(it.place || (home ? cfg.base.name : '숙소'))}</b><p class="cap">${esc(it.time)}${it.note ? ' · ' + esc(it.note) : ''}${late ? ` · <span style="color:var(--danger)">복귀 목표 ${hhmm(cfg.endMin)} 초과</span>` : /귀가|복귀/.test(it.activity) ? ` · 목표 ${hhmm(cfg.endMin)}` : ''}</p></div></div>`;
    }
    if (it.kind === 'rest') return `<div class="pl-row rest"><span class="num rk" style="background:var(--text-3)">☾</span><div style="flex:1"><b>${esc(it.activity)}</b><p class="cap">${esc(it.time)} · 1시간 30분</p></div></div>`;
    k++; const isMeal = it.kind === 'meal'; const p = it.place_id && placeById(it.place_id); const apx = p && !hasCoord(p) ? '<span class="apx">대략</span>' : '';
    const dur = it.note && /h$/.test(it.note) ? it.note.replace(/(\d+(?:\.\d+)?)h/, (m, h) => `${+h >= 1 ? Math.floor(+h) + '시간' : ''}${Math.round((+h % 1) * 60) ? ' ' + Math.round((+h % 1) * 60) + '분' : ''}`.trim()) : (isMeal ? '1시간 20분' : '');
    return `<div class="pl-row${isMeal ? ' meal' : ''}" data-idx="${i}" ${!isMeal && it.place_id ? 'draggable="true"' : ''}><span class="num rk" style="background:${colorOfIt(it)}">${k}</span><div style="flex:1;min-width:0"><b>${isMeal ? `${esc(it.activity)} · ${p ? esc(p.name) : it.cand ? esc(it.cand.name) : '자동 추천'}` : esc(it.activity)}${apx}</b><p class="cap">${esc(it.time)}${dur ? ' · ' + dur : ''}${isMeal ? (p ? ` · ${esc(cuisineOf(p)[0] || '')}${it.note ? ' · ' + esc((apx && /^0\.\dkm$|^0km$/.test(it.note.split(' · ')[0])) ? '같은 지역' : it.note.split(' · ')[0]) : ''}` : ' · ' + esc(it.note || '')) : esc(tagsOf(it))}</p></div>${isMeal ? `<button class="chip" data-swap="${i}">바꾸기</button>` : (it.place_id ? `<span class="stayctl"><button data-stay="${it.place_id}:-30">−</button><button data-stay="${it.place_id}:30">＋</button></span><span class="cap3 grip">≡</span>` : '')}</div>`;
  }).join('');
  return `<div class="pl-hd"><button class="back" data-act="plan-back">‹</button><b>자동 동선 · D${di + 1}</b><span class="cap">${di + 1} / ${n}</span></div>
    <div class="pl-prog">${plan.days.map((x, i) => `<span class="${i <= di ? 'on' : ''}"></span>`).join('')}</div>
    <div class="pl-map" id="pl-map"><span class="pl-sum">총 ${d.totalKm}km · 이동 ${minText(d.totalMin)}${d.over ? ' · <b style="color:var(--danger)">복귀 시각 초과</b>' : ''}</span></div>
    <div class="pl-list"><div class="pl-lh"><b>추천 순서 <span class="cap">${esc(d.label)}</span></b><button class="lnk" data-act="replan" data-di="${di}">↻ 다시 짜기</button></div>${rows}
      ${di === n - 1 && plan.leftover.length ? `<div class="help" style="margin-top:8px">시간 부족으로 제외: ${plan.leftover.map(s => esc(s.name)).join(', ')} — 일수 늘리거나 선택 해제</div>` : ''}
      ${cfg.base.country === 'KR' ? `<button class="chip" style="margin-top:10px" data-act="refine" ${kakaoRestKey() ? '' : 'disabled title="설정에서 카카오 REST 키 입력"'}>실경로로 시간 보정</button>` : ''}</div>
    <div class="pl-foot"><button class="btn-line" data-act="plan-prev" data-di="${di}">이전</button><button class="btn-pri" data-act="${di === n - 1 ? 'saveplan' : 'plan-next'}" data-di="${di}">${di === n - 1 ? '일정으로 저장' : `D${di + 1} 확인 · 다음`}</button></div>`;
}
function drawDetailMap(p, path) {                               // 상세 작은 지도 (시안 외 추가): 거점 → 장소, 실경로 있으면 경로선
  const el = $('#d-map'); if (!el || !window.L || !hasCoord(p)) return;
  if (S.dMap) { try { S.dMap.remove(); } catch {} S.dMap = null; }
  const b = baseFor(p); const m = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false });
  L.tileLayer(tileUrl(), { maxZoom: 18 }).addTo(m);
  const pts = [[p.lat, p.lng]];
  if (b && hasCoord(b) && haversine(b, p) < 600) {                // 너무 멀면(해외↔국내) 장소만
    pts.push([b.lat, b.lng]);
    L.polyline(path?.length ? path : [[b.lat, b.lng], [p.lat, p.lng]], { color: '#024968', weight: path?.length ? 4 : 2.5, opacity: .85, dashArray: path?.length ? null : '6 6' }).addTo(m);
    L.marker([b.lat, b.lng], { icon: L.divIcon({ className: '', html: '<span class="pl-pin" style="background:var(--accent);color:#000">⌂</span>', iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(m);
  }
  L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: `<span class="pl-pin" style="background:${catColor(p)}">${esc(catGlyph(p))}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(m);
  if (pts.length > 1) m.fitBounds(pts, { padding: [26, 26], maxZoom: 14, animate: false }); else m.setView(pts[0], 14, { animate: false });
  S.dMap = m; setTimeout(() => { if (S.dMap === m && m._container?.isConnected) m.invalidateSize(false); }, 60);
  el.onclick = () => { closeSheet(); showView('map'); map.setView([p.lat, p.lng], 14); selectOnMap(p.id); };
}
function drawPlanMap(plan, di) {                                  // 동선 미니 지도 (Leaflet)
  const el = $('#pl-map'); if (!el || !window.L) return;
  const d = plan.days[di]; const pts = []; const marks = [];
  let k = 0;
  for (const it of d.items) { const p = it.kind === 'base' ? (it.place_id ? placeById(it.place_id) : null) : (it.place_id && placeById(it.place_id)); const c = p && approxCoord(p) ? approxCoord(p) : it.cand && hasCoord(it.cand) ? it.cand : it.kind === 'base' ? (plan.lodge && /숙소/.test(it.activity) ? plan.lodge : hasCoord(plan.home || S.base || {}) ? (plan.home || S.base) : null) : null; if (!c) continue; if (it.kind !== 'move') { pts.push([c.lat, c.lng]); if (it.kind !== 'base') { k++; marks.push({ ll: [c.lat, c.lng], n: k, color: it.kind === 'meal' ? (p ? catColor(p) : it.cand ? `var(--cat-${CAT_VAR[it.cand.cuisine] || 'etc'})` : 'var(--cat-seafood)') : 'var(--cat-spot)' }); } else marks.push({ ll: [c.lat, c.lng], n: /숙소/.test(it.activity) ? '▣' : '⌂', color: /숙소/.test(it.activity) ? 'var(--primary-2)' : 'var(--pin)', base: !/숙소/.test(it.activity) }); } }
  if (S.plMap) { try { S.plMap.remove(); } catch {} S.plMap = null; }
  if (pts.length < 1) { el.insertAdjacentHTML('beforeend', '<div class="help" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">좌표 있는 일정이 없어 지도를 못 그립니다</div>'); return; }
  const m = L.map(el, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false });
  L.tileLayer(tileUrl(), { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
  const path = (S.planPaths && S.planPaths[di]) || pts;
  L.polyline(path, { color: '#024968', weight: 4, lineCap: 'round' }).addTo(m);
  for (const mk of marks) L.marker(mk.ll, { icon: L.divIcon({ className: '', html: `<span class="pl-pin" style="background:${mk.color};${mk.base ? 'color:#000' : ''}">${mk.n}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(m);
  m.fitBounds(pts, { padding: [28, 28], maxZoom: 13, animate: false }); S.plMap = m; setTimeout(() => { if (S.plMap === m && m._container?.isConnected) m.invalidateSize(false); }, 50);
}
/* ---------------- 실경로 (카카오모빌리티 REST) ----------------
 * 키는 이 기기 브라우저에만 저장 (공개 저장소 db.json에 넣지 않음). 결과는 30일 캐시.
 */
function kakaoRestKey() { return LS.get('kakaoRest', ''); }
function googleKey() { return LS.get('googleKey', ''); }
async function kakaoRoute(a, b, withPath = false) {
  const key = kakaoRestKey(); if (!key || !a || !b || a.lat == null || b.lat == null) return null;
  const ck = [a.lat, a.lng, b.lat, b.lng].map(x => (+x).toFixed(4)).join(',');
  const cache = LS.get('routes', {});
  if (!withPath && cache[ck] && Date.now() - cache[ck].t < 30 * 864e5) return cache[ck];
  try {
    const r = await fetch(`https://apis-navi.kakaomobility.com/v1/directions?origin=${a.lng},${a.lat}&destination=${b.lng},${b.lat}&priority=RECOMMEND`, { headers: { Authorization: 'KakaoAK ' + key } });
    if (!r.ok) return null;
    const j = await r.json(); const rt = j.routes?.[0];
    if (!rt || rt.result_code !== 0) return null;
    const out = { km: rt.summary.distance / 1000, min: Math.round(rt.summary.duration / 60), toll: rt.summary.fare?.toll || 0, t: Date.now() };
    cache[ck] = out;
    const keys = Object.keys(cache); if (keys.length > 400) keys.sort((x, y) => cache[x].t - cache[y].t).slice(0, 100).forEach(k => delete cache[k]);
    LS.set('routes', cache);
    if (withPath) { const pts = []; for (const s of rt.sections || []) for (const rd of s.roads || []) for (let i = 0; i < rd.vertexes.length; i += 2) pts.push([rd.vertexes[i + 1], rd.vertexes[i]]); return { ...out, path: pts }; }
    return out;
  } catch { return null; }
}
function drawRoute(path) {
  if (S.routeLine) { map.removeLayer(S.routeLine); S.routeLine = null; }
  if (path?.length) S.routeLine = L.polyline(path, { color: '#2f6f8f', weight: 5, opacity: .75 }).addTo(map);
}
/* 상세 거리 박스를 실경로로 교체 */
async function refineDetailRoute(p) {
  const b = baseFor(p); if (!b || !hasCoord(p) || p.country !== 'KR' || b.country !== 'KR' || !kakaoRestKey()) return;
  const r = await kakaoRoute(b, p, true); if (!r || S.sel !== p.id) return;
  const box = $('.distbox'); if (!box) return;
  box.children[1].innerHTML = `<small>도로</small><b>${fmtKm(r.km)}<small>km</small></b>`;
  box.children[2].innerHTML = `<small>소요</small><b class="t">${minText(r.min).replace(/(\d+)(시간|분)/g, '$1<small>$2</small>')}</b>`;
  box.classList.add('real'); const cap = box.nextElementSibling; if (cap?.classList.contains('dist-cap')) cap.textContent = `${b.name} 출발 · 카카오 실경로${r.toll ? ` · 통행료 ${r.toll.toLocaleString()}원` : ''}`;
  drawRoute(r.path); drawDetailMap(p, r.path);
}
/* 플래너 이동 구간 실경로 보정: 이후 일정 시각을 차이만큼 밀고 당김 */
async function refinePlanRoutes(plan) {
  let n = 0;
  for (const day of plan.days) {
    let delta = 0, km = 0, mv = 0;
    for (const it of day.items) {
      if (delta) { const m = toMin(it.time); if (m != null) it.time = hhmm(m + delta); }
      if (it.kind === 'move' && it.from && it.to) {
        const r = await kakaoRoute(it.from, it.to);
        if (r) { delta += r.min - it.min; it.min = r.min; it.km = r.km; it.note = `약 ${r.min}분 (${fmtKm(r.km)}km · 실경로${r.toll ? ` · 통행료 ${r.toll.toLocaleString()}원` : ''})`; n++; }
      }
      if (it.kind === 'move') { km += it.km || 0; mv += it.min || 0; }
    }
    day.totalKm = Math.round(km); day.totalMin = mv;
  }
  return n;
}

/* ---------------- 구글 Places (New) — 해외 검색·추천·주차 ----------------
 * 키: Google Cloud → Places API (New) 사용 설정 → API 키(HTTP 리퍼러 제한). 이 기기에만 저장.
 */
const G_MASK = 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.formattedAddress,places.googleMapsUri,places.primaryType,places.primaryTypeDisplayName,places.regularOpeningHours.weekdayDescriptions';
async function gPlaces(path, body) {
  const key = googleKey(); if (!key) return null;
  const r = await fetch('https://places.googleapis.com/v1/places:' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': G_MASK }, body: JSON.stringify({ languageCode: 'ko', ...body }) });
  if (!r.ok) { const t = await r.text(); throw new Error('Google ' + r.status + ' ' + t.slice(0, 120)); }
  return (await r.json()).places || [];
}
function gHit(g, origin) {
  const lat = g.location?.latitude, lng = g.location?.longitude;
  return { name: g.displayName?.text || '', lat, lng, address: g.formattedAddress, url: g.googleMapsUri, rating: g.rating, reviews: g.userRatingCount, type: g.primaryTypeDisplayName?.text || g.primaryType || '', hours: g.regularOpeningHours?.weekdayDescriptions || null, src: '구글', dist: origin ? haversine(origin, { lat, lng }) * 1000 : null };
}
async function googleSearch(q, origin) {
  try { const res = await gPlaces('searchText', { textQuery: q, maxResultCount: 6, ...(origin ? { locationBias: { circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius: 30000 } } } : {}) }); return (res || []).map(g => gHit(g)); }
  catch (e) { console.warn(e); return []; }
}
async function googleNearby(origin, types, radius, rank = 'POPULARITY', max = 20) {
  try { const res = await gPlaces('searchNearby', { includedTypes: types, maxResultCount: max, rankPreference: rank, locationRestriction: { circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius } } }); return (res || []).map(g => gHit(g, origin)); }
  catch (e) { console.warn(e); toast('구글 검색 실패: ' + e.message.slice(0, 60), 3500); return []; }
}
const G_CUISINE = [[/korean/i, '한식'], [/seafood/i, '해산물'], [/vietnam|pho/i, '쌀국수'], [/barbecue|bbq/i, 'BBQ'], [/cafe|coffee/i, '카페'], [/japanese|sushi|ramen/i, '기타'], [/chinese/i, '기타']];
async function recommendNearbyGoogle(origin, ctx, radius = 3000) {
  if (!googleKey() || !origin || !hasCoord(origin)) return [];
  const known = new Set(S.db.places.map(p => p.google?.url).filter(Boolean));
  const knownNames = new Set(S.db.places.map(p => p.name.replace(/\s/g, '').toLowerCase()));
  const fam = ctx.family || famProfile();
  const hits = await googleNearby(origin, ['restaurant'], radius);
  return hits.filter(h => !known.has(h.url) && ![...knownNames].some(n => n.includes(h.name.replace(/\s/g, '').toLowerCase()))).map(h => {
    const km = h.dist / 1000; const [ds, dl] = distScore(km); let s = ds; const reasons = [dl, h.type].filter(Boolean);
    if (h.rating) { const v = Math.round((h.rating - 4) * 8); s += v; reasons.push(`G${h.rating}`); }
    if (h.reviews) { s += Math.round(Math.log10(h.reviews + 1) * 3); reasons.push(`리뷰 ${h.reviews.toLocaleString()}`); }
    if (fam.kids && /bar|pub|night/i.test(h.type)) s -= 15;
    if (SEASON_KW[ctx.season]?.test(h.name)) { s += 6; reasons.push(ctx.season + ' 제철'); }
    const cu = (G_CUISINE.find(([re]) => re.test(h.type)) || [null, '현지'])[1];
    return { candidate: { name: h.name, lat: h.lat, lng: h.lng, address: h.address, url: h.url, cuisine: cu, category: h.type, google: { rating: h.rating, reviews: h.reviews, url: h.url } }, score: s, reasons, km };
  }).sort((a, b) => b.score - a.score).slice(0, 8);
}

/* ---------------- 공유 링크 ----------------
 * #p-<장소id> / #t-<여행id> — 받은 사람은 토큰 없이 읽기 전용으로 열림
 */
function shareUrl(kind, id) { return location.origin + location.pathname + '#' + kind + '-' + id; }
async function shareLink(kind, id, title) {
  const url = shareUrl(kind, id), text = `[준준 TRIP] ${title}`;
  if (navigator.share) { try { await navigator.share({ title: text, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('링크 복사됨 — 카톡에 붙여넣기'); }
  catch { prompt('링크 복사', url); }
}
function handleHash() {
  const m = /^#([ptj])-(.+)$/.exec(location.hash || ''); if (!m) return;
  if (m[1] === 'j') { showView('home'); openJournal(); return; }
  if (m[1] === 'p' && placeById(m[2])) { const p = placeById(m[2]); if (p.region !== S.region) { S.region = p.region; renderRegionChips(); renderTagChips(); renderList(); } openDetail(m[2]); }
  if (m[1] === 't') { const t = S.db.trips.find(x => x.id === m[2]); if (t) { S.trip = t; S.tripDay = 0; showView('trips'); renderTrips(); focusTrip(); } }
}
function isRO() { return !S.token && !OFFLINE; }
function applyReadOnly() { document.body.classList.toggle('ro', isRO()); }
function roBanner() { return isRO() ? `<div class="ro-banner"><b>⚠</b><div><b>읽기 전용</b> · 기록·저장이 꺼져 있어요</div><button data-act="ro-token">토큰 넣기</button></div>` : ''; }   // 시안 11d
function goToken() { closeSheet(); closeMenu(); showView('settings'); openKeySheet('gh'); }

/* ---------------- 엑셀 내보내기 (원본 양식) ---------------- */
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/exceljs.min.js'; s.onload = res; s.onerror = () => rej(new Error('ExcelJS 로드 실패')); document.head.appendChild(s); });
}
const XL = {
  font: { name: '맑은 고딕', size: 10 },
  hdrFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } },
  tripFill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEECE1' } },
  thin: { style: 'thin', color: { argb: 'FFBFBFBF' } }, med: { style: 'medium' },
};
function xlHeader(ws, cells, fill) {
  for (const [addr, v] of cells) { const c = ws.getCell(addr); c.value = v; c.font = { ...XL.font, bold: true }; c.fill = fill; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = { top: XL.med, bottom: XL.med, left: XL.thin, right: XL.thin }; }
}
function xlBody(ws, fromRow, toRow, fromCol, toCol, centerCols = []) {
  for (let r = fromRow; r <= toRow; r++) for (let c = fromCol; c <= toCol; c++) {
    const cell = ws.getCell(r, c); cell.font = XL.font; cell.border = { top: XL.thin, bottom: XL.thin, left: XL.thin, right: XL.thin };
    cell.alignment = { vertical: 'middle', wrapText: true, horizontal: centerCols.includes(c) ? 'center' : undefined };
  }
}
function sheetName(name, used) { let n = name.replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31).trim(); let k = 2; while (used.has(n)) n = name.slice(0, 28) + ' ' + k++; used.add(n); return n; }

function xlOverall(wb, used) {
  const ws = wb.addWorksheet(sheetName('Overall', used), { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.columns = [0.9, 9.6, 9, 9, 17.9, 12.1, 13.2, 5.6, 5.6, 5.6, 5.6, 14.8, 14.8, 14.8, 14.8, 14.8, 27.9, 25.1, 20, 9].map(w => ({ width: w }));
  ws.getCell('B1').value = '■ 계절별 가족 휴양지LIST'; ws.getCell('B1').font = { ...XL.font, size: 14, bold: true };
  ['B3:B4', 'C3:D3', 'E3:E4', 'F3:F4', 'G3:G4', 'H3:K3', 'L3:P3', 'Q3:Q4', 'R3:R4', 'S3:S4', 'T3:T4'].forEach(m => ws.mergeCells(m));
  xlHeader(ws, [['B3', '추천도'], ['C3', '지역'], ['C4', '도'], ['D4', '시, 군'], ['E3', '여행지'], ['F3', '거리\nFrom Home'], ['G3', '추천숙박'], ['H3', '추천 계절'], ['H4', '봄'], ['I4', '여름'], ['J4', '가을'], ['K4', '겨울'],
    ['L3', '추천 식당'], ['L4', '한식'], ['M4', '중식'], ['N4', '일식'], ['O4', '양식'], ['P4', '그 외'], ['Q3', '여행지 설명'], ['R3', '장점'], ['S3', '단점'], ['T3', '방문이력']], XL.hdrFill);
  ws.getRow(3).height = 20; ws.getRow(4).height = 18;
  const home = S.db.bases.find(b => b.id === 'b_home');
  const spots = S.db.places.filter(p => p.type === 'spot' && p.country === 'KR');
  let r = 5;
  for (const s of spots) {
    const rests = S.db.places.filter(x => x.type === 'restaurant' && x.spot_id === s.id);
    const by = cu => rests.filter(x => (cuisineOf(x)[0] || '기타') === cu).map(x => x.name).join('\n') || null;
    const dist = s.dist_home_km ?? (home && hasCoord(s) ? Math.round(haversine(home, s) * 1.3) : null);
    const row = ws.getRow(r);
    row.values = [null, s.rating ? '★'.repeat(s.rating) : '-', s.do === '서울' ? null : s.do, s.si, s.name, dist, s.lodging || '-',
      ...['봄', '여름', '가을', '겨울'].map(x => (s.seasons || []).includes(x) ? 'O' : null),
      by('한식'), by('중식'), by('일식'), by('양식'), [by('기타'), s.note].filter(Boolean).join('\n') || null, s.desc, s.pros, s.cons, s.visits || 0];
    r++;
  }
  xlBody(ws, 5, r - 1, 2, 20, [2, 3, 4, 6, 7, 8, 9, 10, 11, 20]);
  for (let i = 5; i < r; i++) ws.getCell(i, 2).font = { ...XL.font, color: { argb: 'FFC00000' } };
}
function xlRegion(wb, used, region) {
  const list = S.db.places.filter(p => p.region === region && p.type === 'restaurant'); if (!list.length) return;
  const label = REGION_LABEL[region] || region, base = S.db.bases.find(b => b.default_for === region);
  const ws = wb.addWorksheet(sheetName(label + ' 식당', used), { views: [{ state: 'frozen', ySplit: 4 }] });
  ws.columns = [0.5, 5.2, 23.9, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 4.2, 52.7, 7.9, 7.9, 4.2, 4.2, 4.2, 32.5, 27.1].map(w => ({ width: w }));
  ws.getCell('A1').value = `■ ${label} 구역별 식당 분류표`; ws.getCell('A1').font = { ...XL.font, size: 11, bold: true };
  ['B3:B4', 'C3:C4', 'D3:D4', 'E3:J3', 'K3:K4', 'L3:M3', 'N3:P3', 'Q3:Q4', 'R3:R4'].forEach(m => ws.mergeCells(m));
  const cats = ['현지', '해산물', '쌀국수', 'BBQ', '한식', '기타'];
  xlHeader(ws, [['B3', '지역'], ['C3', '상호명'], ['D3', 'A/C'], ['E3', '분  류'], ...cats.map((c, i) => [String.fromCharCode(69 + i) + '4', c]), ['K3', '주  소'], ['L3', `숙소 기준(${base ? base.name.split(' ')[0] : '-'})`], ['L4', '거리'], ['M4', '소요'], ['N3', '지급방법'], ['N4', '현금'], ['O4', '카드'], ['P4', '이체'], ['Q3', '시그니처 메뉴'], ['R3', '비고']], XL.hdrFill);
  let r = 5;
  for (const p of list) {
    const d = base && hasCoord(p) ? roadEst(haversine(base, p), p.country) : null;
    const cu = cuisineOf(p);
    ws.getRow(r).values = [null, p.zone || p.si || '', p.name, p.ac ? 'O' : null, ...cats.map(c => cu.includes(c) ? 'O' : null), p.address,
      p.dist_base_km ?? (d ? Math.round(d.road * 10) / 10 : null), p.time_base_min ?? (d ? d.min : null),
      ...['현금', '카드', '이체'].map(x => (p.pay || []).includes(x) ? 'O' : null), p.signature, [p.note, p.google?.rating ? `G${p.google.rating}` : ''].filter(Boolean).join(' · ') || null];
    r++;
  }
  xlBody(ws, 5, r - 1, 2, 18, [2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16]);
}
function xlTrip(wb, used, t) {
  const first = (t.items.find(i => i.day)?.day || '').match(/(\d+)\/(\d+)/);
  const nm = `${String(t.year).slice(-2)}.${first ? first[1] : ''} ${t.city}`;
  const ws = wb.addWorksheet(sheetName(nm, used));
  ws.columns = [1, 9, 8.6, 36, 37.5, 47.5].map(w => ({ width: w }));
  ws.mergeCells('B1:F1'); ws.getCell('B1').value = t.title; ws.getCell('B1').font = { ...XL.font, size: 16, bold: true };
  xlHeader(ws, [['B3', '일 자'], ['C3', '시 간'], ['D3', '일 정'], ['E3', '장 소'], ['F3', '비 고']], XL.tripFill);
  let r = 4, dayStart = 4, cur = null;
  for (const it of t.items) {
    if (it.day !== cur) { if (cur != null && r - 1 > dayStart) ws.mergeCells(dayStart, 2, r - 1, 2); cur = it.day; dayStart = r; ws.getCell(r, 2).value = (it.day || '').replace(' ', '\n'); }
    ws.getCell(r, 3).value = it.time || null; ws.getCell(r, 4).value = it.activity || null; ws.getCell(r, 5).value = it.place || null; ws.getCell(r, 6).value = it.note || null;
    r++;
  }
  if (r - 1 > dayStart) ws.mergeCells(dayStart, 2, r - 1, 2);
  xlBody(ws, 4, r - 1, 2, 6, [2, 3]);
}
async function exportXlsx(opts = {}) {
  toast('엑셀 생성 중…');
  try {
    await loadExcelJS();
    const wb = new ExcelJS.Workbook(); wb.creator = '준준 TRIP'; const used = new Set();
    if (opts.trip) xlTrip(wb, used, opts.trip);
    else {
      xlOverall(wb, used);
      for (const [r] of regionsInDb()) if (r !== 'domestic') xlRegion(wb, used, r);
      for (const t of S.db.trips.slice().sort((a, b) => a.year - b.year)) xlTrip(wb, used, t);
    }
    const buf = await wb.xlsx.writeBuffer();
    const d = new Date(), ymd = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    const name = opts.trip ? `${ymd}_${opts.trip.title}.xlsx` : `${ymd}_준준TRIP_가족휴양지LIST.xlsx`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })); a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('엑셀 저장: ' + a.download, 3000);
  } catch (e) { console.error(e); toast('엑셀 실패: ' + e.message, 4000); }
}


/* ---------------- 대략 좌표 (시·군·구 중심) — 좌표 수집 전 플래너·거리 추정용 ---------------- */
const SI_CENTER = {
  '서울': [37.5665, 126.978], '송파': [37.5145, 127.106], '강동': [37.5301, 127.124], '성동': [37.5634, 127.037], '마포': [37.5663, 126.902], '종로': [37.573, 126.979], '중랑': [37.6063, 127.093], '광진': [37.5385, 127.082], '강남': [37.5172, 127.047], '동대문': [37.5744, 127.04], '성북': [37.5894, 127.017], '동작': [37.5124, 126.94], '구로': [37.4954, 126.887], '용산': [37.5326, 126.99],
  '남양주': [37.636, 127.216], '포천': [37.895, 127.2], '용인': [37.241, 127.178], '안성': [37.008, 127.28], '성남': [37.42, 127.127], '가평': [37.831, 127.51], '파주': [37.76, 126.78], '인천': [37.456, 126.705], '수원': [37.263, 127.029], '이천': [37.272, 127.435], '과천': [37.429, 126.988], '화성': [37.199, 126.831], '하남': [37.539, 127.215], '광주': [37.429, 127.255], '양주': [37.785, 127.046], '의왕': [37.345, 126.968], '구리': [37.594, 127.13], '평택': [36.992, 127.113], '여주': [37.298, 127.637], '강화': [37.747, 126.488], '제물포': [37.47, 126.65],
  '속초': [38.207, 128.592], '평창': [37.37, 128.39], '강릉': [37.752, 128.876], '추천': [37.881, 127.73], '춘천': [37.881, 127.73], '홍천': [37.697, 127.889], '양양': [38.075, 128.619], '고성': [38.38, 128.468], '삼척': [37.45, 129.165],
  '서산': [36.785, 126.45], '부여': [36.276, 126.91], '서천': [36.08, 126.69], '제천': [37.132, 128.191], '사천': [35.004, 128.064], '남해': [34.838, 127.892], '문경': [36.586, 128.187], '청도': [35.647, 128.734], '순천': [34.95, 127.487],
  '제주': [33.499, 126.531], '대구': [35.871, 128.601], '수성': [35.858, 128.63], '동구': [35.887, 128.636], '중구': [35.87, 128.606], '부산': [35.18, 129.075], '남구': [35.136, 129.084], '서구': [35.098, 129.024], '사하': [35.104, 128.975], '동래': [35.205, 129.084], '수영': [35.145, 129.113], '대전': [36.35, 127.385],
};
const KR_AREAS = {                                             // 국내 목적지 (시·군 단위, 광역시는 하나로)
  '광역시': ['서울', '인천', '강화', '옹진', '부산', '대구', '군위', '광주', '대전', '울산', '세종'],
  '경기': ['가평', '고양', '과천', '경기 광주', '구리', '군포', '김포', '남양주', '동두천', '부천', '성남', '수원', '시흥', '안산', '안성', '안양', '양주', '양평', '여주', '연천', '오산', '용인', '의왕', '의정부', '이천', '파주', '평택', '포천', '하남', '화성', '광명'],
  '강원': ['강릉', '강원 고성', '동해', '삼척', '속초', '양구', '양양', '영월', '원주', '인제', '정선', '철원', '춘천', '태백', '평창', '홍천', '화천', '횡성'],
  '충북': ['괴산', '단양', '보은', '영동', '옥천', '음성', '제천', '증평', '진천', '청주', '충주'],
  '충남': ['계룡', '공주', '금산', '논산', '당진', '보령', '부여', '서산', '서천', '아산', '예산', '천안', '청양', '태안', '홍성'],
  '전북': ['고창', '군산', '김제', '남원', '무주', '부안', '순창', '완주', '익산', '임실', '장수', '전주', '정읍', '진안'],
  '전남': ['강진', '고흥', '곡성', '광양', '구례', '나주', '담양', '목포', '무안', '보성', '순천', '신안', '여수', '영광', '영암', '완도', '장성', '장흥', '진도', '함평', '해남', '화순'],
  '경북': ['경산', '경주', '고령', '구미', '김천', '문경', '봉화', '상주', '성주', '안동', '영덕', '영양', '영주', '영천', '예천', '울릉', '울진', '의성', '청도', '청송', '칠곡', '포항'],
  '경남': ['거제', '거창', '경남 고성', '김해', '남해', '밀양', '사천', '산청', '양산', '의령', '진주', '창녕', '창원', '통영', '하동', '함안', '함양', '합천'],
  '제주': ['제주', '서귀포'],
};
const AREA_CENTER = { '광주': [35.160, 126.851], '경기 광주': [37.429, 127.255], '강원 고성': [38.380, 128.468], '경남 고성': [34.973, 128.322], '양평': [37.492, 127.488], '서귀포': [33.254, 126.560] };
function doShort(d) { d = d || ''; const M = [[/^서울/, '서울'], [/^부산/, '부산'], [/^대구/, '대구'], [/^인천/, '인천'], [/^광주/, '광주'], [/^대전/, '대전'], [/^울산/, '울산'], [/^세종/, '세종'], [/^제주/, '제주'], [/^경기/, '경기'], [/^강원/, '강원'], [/^충(청)?북/, '충북'], [/^충(청)?남/, '충남'], [/^전(라)?북|^전북/, '전북'], [/^전(라)?남/, '전남'], [/^경(상)?북/, '경북'], [/^경(상)?남/, '경남']]; for (const [r, k] of M) if (r.test(d)) return k; return ''; }
function areaKey(p) {                                           // 장소 → 목적지 키 (서울 강남구→서울, 경기 광주시→'경기 광주', 강화군→강화)
  if (!p || p.country !== 'KR') return normSi(p?.si || p?.zone || '') || '';
  const ds = doShort(p.do); const s = normSi((p.si || '').replace(/구$/, m => m)) || '';
  if (['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종'].includes(ds)) return ['강화', '옹진', '군위'].includes(s) ? s : ds;
  if (/구$/.test(s) && !ds) return '서울';
  if (s === '광주' && ds === '경기') return '경기 광주'; if (s === '고성') return ds === '경남' ? '경남 고성' : '강원 고성';
  if (s === '제주' || s === '서귀포') return s;
  return s || ds;
}
function areaCenter(key) { const c = AREA_CENTER[key] || SI_CENTER[key] || (LS.get('areaCenter', {})[key]); return c ? { lat: c[0], lng: c[1] } : null; }
async function geocodeArea(key) {                               // 목적지 중심 좌표 (없으면 카카오 주소검색 → OSM), 기기에 캐시
  const grp = Object.entries(KR_AREAS).find(([, l]) => l.includes(key))?.[0] || '';
  const name = key.replace(/^(경기|강원|경남) /, ''); const pre = grp === '광역시' ? '' : (key.includes(' ') ? key.split(' ')[0] : grp) + ' ';
  let hit = null;
  try { await loadKakao(true); if (window.kakao?.maps?.services?.Geocoder) { const g = new kakao.maps.services.Geocoder(); for (const q of [`${pre}${name}군`, `${pre}${name}시`, `${pre}${name}`]) { hit = await new Promise(res => g.addressSearch(q, (d, st) => res(st === kakao.maps.services.Status.OK && d[0] ? { lat: +d[0].y, lng: +d[0].x } : null))); if (hit) break; } } } catch {}
  if (!hit) { const o = await osmSearch(`${pre}${name}`, 'KR'); if (o[0]) hit = { lat: o[0].lat, lng: o[0].lng }; }
  if (hit) { const c = LS.get('areaCenter', {}); c[key] = [hit.lat, hit.lng]; LS.set('areaCenter', c); }
  return hit;
}
function approxCoord(p) {                                    // 실제 좌표 없으면 시·군·구 중심 (approx:true)
  if (hasCoord(p)) return { lat: p.lat, lng: p.lng, approx: false };
  const keys = [p.si, p.zone, p.do].filter(Boolean).map(x => x.replace(/(특별|광역)?(시|군|구)$/, '').trim());
  for (const k of keys) { if (SI_CENTER[k]) return { lat: SI_CENTER[k][0], lng: SI_CENTER[k][1], approx: true }; }
  if (p.country !== 'KR' && S.db.bases.find(b => b.country === p.country)) { const b = S.db.bases.find(b => b.country === p.country); return { lat: b.lat, lng: b.lng, approx: true }; }
  return null;
}
function withCoord(p) { if (hasCoord(p)) return p; const c = approxCoord(p); return c ? Object.assign(Object.create(p), { lat: c.lat, lng: c.lng, approx: true }) : p; }   // 원본은 안 건드리고 좌표만 덧씌운 뷰

/* ---------------- 에셋·사진 ---------------- */
// 오프라인 단일 HTML에서는 bundle.py가 assets/·photos/base/ 를 window.EMBED_ASSETS(경로→dataURI)로 넣어줌
function asset(path) { return (window.EMBED_ASSETS || {})[path] || path; }
function photoUrl(path) {
  if (!path) return null;
  if (/^(data:|https?:|blob:)/.test(path)) return path;
  if (path.startsWith('local:')) return LS.get('photos', {})[path] || null;          // 이 기기에만 저장된 사진
  const e = (window.EMBED_ASSETS || {})[path]; if (e) return e;
  if (OFFLINE) return null;                                   // 오프라인 파일엔 내장된 사진만
  return path.startsWith('photos/') ? rawUrl(path) : path;
}
// 사진 우선순위: 가족 사진(방문기록) → 기본 사진(관광공사·해외 대표) → 없음(정보 카드)
function familyPhoto(p) { const v = (p.visitLog || []).slice().reverse().find(x => x.photo); return v ? photoUrl(v.photo) : null; }
function imgOf(p) { return familyPhoto(p) || photoUrl(p.basePhoto?.path) || null; }
function imgCredit(p) { return !familyPhoto(p) && p.basePhoto ? (p.basePhoto.source || '한국관광공사') : ''; }
const CAT_VAR = { '한식': 'korean', '중식': 'chinese', '일식': 'japanese', '양식': 'western', '카페': 'cafe', '현지': 'local', '해산물': 'seafood', '쌀국수': 'pho', 'BBQ': 'bbq', '기타': 'etc' };
const CAT_GLYPH = { '한식': '한', '중식': '중', '일식': '일', '양식': '양', '카페': '카', '현지': '현', '해산물': '해', '쌀국수': '쌀', 'BBQ': 'B', '기타': '·' };
function catOf(p) { return isMine(p) ? 'mine' : p.type === 'spot' ? 'spot' : (CAT_VAR[cuisineOf(p)[0]] || 'etc'); }
function catColor(p) { return `var(--cat-${catOf(p)})`; }
function catGlyph(p) { return isMine(p) ? '⌂' : p.type === 'spot' ? '휴' : (CAT_GLYPH[cuisineOf(p)[0]] || '·'); }
// 목록 썸네일: 가족/기본 사진 → 음식 종류 색 + 종류 글자 (이름 첫 글자 표지 금지)
function thumbHtml(p, cls = 'thumb-c') {
  const img = imgOf(p);
  return `<span class="${cls}" style="--cat:${catColor(p)}">${img ? `<img src="${img}" alt="" loading="lazy">` : esc(catGlyph(p))}</span>`;
}
// (구) 그라데이션 표지 — 상세·목록 ②단계 교체 전까지 유지
const ART = {
  '한식': ['#b91c1c', '#f97316'], '중식': ['#c2410c', '#fbbf24'], '일식': ['#6d28d9', '#c084fc'], '양식': ['#1d4ed8', '#60a5fa'], '카페': ['#78350f', '#d6a77a'],
  '현지': ['#be123c', '#fb7185'], '해산물': ['#0e7490', '#67e8f9'], '쌀국수': ['#ca8a04', '#fde68a'], 'BBQ': ['#7c2d12', '#fb923c'], '기타': ['#475569', '#94a3b8'],
  spot: ['#0f766e', '#5eead4'], 물놀이: ['#0369a1', '#7dd3fc'], 놀이시설: ['#db2777', '#f9a8d4'], '역사·문화': ['#7c3aed', '#c4b5fd'], 동물: ['#15803d', '#86efac'], 눈썰매: ['#1e40af', '#bfdbfe'],
};
function photoOf(p) { return imgOf(p); }
function artOf(p) {
  let key = p.type === 'spot' ? ((p.tags || []).find(t => ART[t]) || 'spot') : (cuisineOf(p)[0] || '기타');
  const [a, b] = ART[key] || ART['기타'];
  const angle = ((p.name.charCodeAt(0) * 37) % 360);
  return { bg: `linear-gradient(${angle}deg, ${a}, ${b})`, glyph: catGlyph(p), photo: imgOf(p) };
}
function artHtml(p, cls = 'art', extra = '') {
  const a = artOf(p);
  return `<div class="${cls}" style="background:${a.bg}">${a.photo ? `<img src="${a.photo}" alt="" loading="lazy">` : `<span class="glyph">${esc(a.glyph)}</span>`}${extra}</div>`;
}
const TRIP_COVER = { '다낭': 'danang', '평창': 'pyeongchang', '괌': 'guam', '방콕': 'bangkok', '나트랑': 'nhatrang' };
const COUNTRY_EN = { KR: 'KOREA', VN: 'VIETNAM', TH: 'THAILAND', GU: 'GUAM', JP: 'JAPAN', US: 'USA' };
function tripCoverStyle(t) {
  const key = Object.keys(TRIP_COVER).find(k => (t.city || '').includes(k));
  if (key) return `background-image:url('${asset('assets/trip-cover-' + TRIP_COVER[key] + '.jpg')}')`;
  const hues = { KR: ['#0f766e', '#2dd4bf'], VN: ['#be123c', '#fb923c'], TH: ['#7c3aed', '#f0abfc'], GU: ['#0369a1', '#38bdf8'], JP: ['#b91c1c', '#fda4af'] };
  const [a, b] = hues[t.country] || ['#334155', '#94a3b8'];
  return `background-image:linear-gradient(160deg, ${a}, ${b})`;
}
function tripArt(t) { return tripCoverStyle(t).replace('background-image:', ''); }

/* ---------------- 홈 — 확정 시안 01(폰)·W1(PC) 마크업 그대로 ---------------- */
const SEASON_COPY = { '봄': ['봄나들이', '꽃 피는 계절, 가까운 개울과 공원부터'], '여름': ['여름 물놀이', '시원한 계곡과 바다, 그리고 냉면'], '가을': ['가을 식도락', '제철 먹거리를 찾아 떠나는 짧은 여행'], '겨울': ['겨울 온기', '눈썰매와 뜨끈한 국물 한 그릇'] };
const SEASON_EN = { '봄': 'spring', '여름': 'summer', '가을': 'autumn', '겨울': 'winter' };
const ICO = {
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>',
  bell: '<svg class="i" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10 21h4"></path></svg>',
  eat: '<svg class="i" viewBox="0 0 24 24"><path d="M4 11h16a8 8 0 0 1-16 0Z"></path><path d="M8 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4"></path></svg>',
  plan: '<svg class="i" viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"></rect><path d="M4 10h16M9 3v4M15 3v4M12 13v4M10 15h4"></path></svg>',
  map: '<svg class="i" viewBox="0 0 24 24"><path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2Z"></path><path d="M9 4v14M15 6v14"></path></svg>',
  star: '<svg class="i" viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"></path></svg>',
  loc: '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M12 2v4M12 18v4M2 12h4M18 12h4"></path></svg>',
};
// 거점 기준 거리·소요 (카카오 경로 캐시 → 도로 추정 → 엑셀 집 기준 거리)
function distInfo(p) {
  const base = baseFor(p); if (!base) return null;
  if (!hasCoord(p)) return base.id === 'b_home' && p.dist_home_km != null ? { km: p.dist_home_km, min: Math.round(p.dist_home_km / 55 * 60) + 5, real: false } : null;
  const ck = [base.lat, base.lng, p.lat, p.lng].map(x => (+x).toFixed(4)).join(','); const rt = LS.get('routes', {})[ck];
  if (rt && rt.km != null) return { km: rt.km, min: rt.min, real: true };
  const d = haversine(base, p); const e = roadEst(d, p.country); return e ? { km: e.road, min: e.min, real: false } : null;
}
function minText(m) { return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? m % 60 + '분' : ''}`.trim() : `${m}분`; }
function baseShort(p) { return ((p ? baseFor(p) : S.base)?.name || '거점').replace(/^집\s*\((.*)\)$/, '$1').replace(/\s*\(.*\)/, ''); }
function distText(p) { const d = distInfo(p); return d ? `${baseShort(p)}에서 ${fmtKm(d.km)}km · 차로 ${minText(d.min)}` : '위치 없음'; }
function catDot(p) { return isMine(p) ? '우리 장소' + ((p.tags || [])[0] ? ' · ' + p.tags[0] : '') : p.type === 'spot' ? '휴양지' + ((p.tags || [])[0] ? ' · ' + p.tags[0] : '') : cuisineOf(p).join(' · ') || '식당'; }
function starsTxt(n) { return n ? '★'.repeat(n) + '☆'.repeat(5 - n) : ''; }
function homeData() {
  const season = seasonHome(), base = S.base, ctx = { origin: base, season, family: famProfile() };
  const spots = S.db.places.filter(p => p.type === 'spot'), rests = S.db.places.filter(p => p.type === 'restaurant');
  const scored = spots.map(s => ({ s, ...scoreSpot(s, ctx) })).sort((a, b) => b.score - a.score);
  const withPhoto = scored.filter(x => imgOf(x.s));                           // 사진 없는 곳은 큰 카드·캐러셀에 올리지 않음
  const feats = (withPhoto.length ? withPhoto : scored).slice(0, 3);
  S.heroIdx = Math.min(S.heroIdx || 0, Math.max(feats.length - 1, 0));
  const logs = S.db.places.flatMap(p => (p.visitLog || []).map(v => ({ p, v }))).sort((a, b) => (b.v.date || '').localeCompare(a.v.date || ''));
  const visited = S.db.places.filter(p => p.visits > 0).sort((a, b) => (b.visits || 0) - (a.visits || 0));
  const wish = S.db.places.filter(p => p.wish);
  const trips = S.db.trips.slice().sort((a, b) => b.year - a.year);
  const totalVisits = S.db.places.reduce((n, p) => n + (p.visits || 0), 0);
  const fam = S.db.meta.family || {};
  const famName = (fam.names || []).length ? fam.names.join('·') + '이네' : '우리 가족';
  const ym = new Date(); const ymText = `${ym.getFullYear()}.${String(ym.getMonth() + 1).padStart(2, '0')}`;
  const nearRest = p => rests.filter(r => r.spot_id === p.id || (hasCoord(r) && hasCoord(p) && haversine(r, p) <= 5) || (!hasCoord(r) && r.si && r.si === p.si)).length;
  const why = x => [...x.reasons.filter(r => !/km$/.test(r)).slice(0, 1), ...(x.s.tags || []).slice(0, 3).map(t => '#' + t)].slice(0, 4);
  const nSaved = rests.filter(r => r.naver?.saved).length;
  return { season, base, spots, rests, scored, feats, logs, visited, wish, trips, totalVisits, famName, ymText, nearRest, why, nSaved, title: SEASON_COPY[season][0] };
}
const tripSub = t => { const d = [...new Set(t.items.map(i => i.day))].length; let hotel = t.items.find(i => /호텔|리조트|숙소|체크인/.test(i.activity || '') || /호텔|리조트|resort|hotel/i.test(i.place || ''))?.place || ''; hotel = hotel.split(/\s{2,}|\(|,/)[0].trim(); if (hotel.length > 22) hotel = hotel.slice(0, 22) + '…'; return [hotel, d ? d + '일' : null].filter(Boolean).join(' · ') || `${t.items.length}개 일정`; };
const tripCity = t => (t.city || '').replace(/\s*\(.*\)/, '');
function collectionsHtml(d, pc) {
  const regions = regionsInDb();
  const items = [...regions.map(([r, n]) => ({ act: `data-region="${r}"`, label: REGION_LABEL[r] || r, n, bg: r === 'domestic' ? 'var(--primary)' : 'var(--primary-2)' })),
    ...['한식', '중식'].map(c => ({ act: `data-cuisine="${c}"`, label: c, n: d.rests.filter(p => cuisineOf(p).includes(c)).length, bg: `var(--cat-${CAT_VAR[c]})` })).filter(x => x.n)];
  const unv = S.db.places.filter(p => !p.visits).length;
  if (pc) return items.slice(0, 4).map(x => `<button ${x.act} style="background:${x.bg}"><b>${esc(x.label)}</b><span class="disp">${x.n}</span></button>`).join('') + `<button data-act="explore-unvisited" style="background:rgba(255,188,0,.9);color:#000"><b>미방문</b><span class="disp">${unv}</span></button>`;
  return items.slice(0, 4).map(x => `<button ${x.act} style="background:${x.bg}"><b>${esc(x.label)}</b><span class="mono">${x.n}곳</span></button>`).join('') + `<button class="wide" data-act="explore-unvisited"><b>아직 안 가본 곳</b><span class="mono">${unv}곳 →</span></button>`;
}
function renderHomePhone(d) {
  const feat = d.feats[S.heroIdx]; const fp = feat?.s; const img = fp && imgOf(fp); const di = fp && distInfo(fp);
  const logCard = ({ p, v }) => { const im = (v.photo && photoUrl(v.photo)) || imgOf(p); return `<button class="log-card" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="bar"></div>${im ? `<div class="lc-img"><img src="${im}" alt=""></div>` : ''}<div class="in"><div class="lh"><span class="mono">${esc((v.date || '').replace(/-/g, '.'))}</span><span class="st">${starsTxt(v.rating)}</span></div><b>${esc(p.name)}</b>${v.memo ? `<q>${esc(v.memo)}</q>` : ''}</div></button>`; };
  const visitCard = p => { const im = imgOf(p); return `<button class="log-card" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="bar"></div>${im ? `<div class="lc-img"><img src="${im}" alt=""></div>` : ''}<div class="in"><div class="lh"><span class="mono">방문 ${p.visits}회</span><span class="st">${starsTxt(ratingOf(p))}</span></div><b>${esc(p.name)}</b><q>${esc(p.pros || p.desc || areaOf(p))}</q></div></button>`; };
  const recoCard = x => { const p = x.s, im = imgOf(p), dd = distInfo(p);
    return `<button class="reco-card" data-go="${p.id}"><div class="rc${im ? ' ph' : ''}" style="${im ? `background-image:url('${im}')` : ''}">${im ? `<span class="ss ph-ss">${esc(x.reasons.find(r => !/km$/.test(r)) || d.season)}</span>` : `<span class="ss">${esc(d.season)}</span><div><b class="km">${dd ? fmtKm(dd.km) : '—'}<small>km</small></b><p class="min">${dd ? `${esc(baseShort())}에서 ${minText(dd.min)}` : '위치 없음'}</p></div><span class="why">${esc((p.tags || []).slice(0, 2).join(' · ') || x.reasons[1] || '')}</span>`}${p.visits ? `<img class="stamp" src="${asset('assets/mark-stamp.png')}" alt="">` : ''}</div><b>${esc(p.name)}</b><p class="sub">${dd ? fmtKm(dd.km) + 'km' : esc(areaOf(p))} · ${(p.tags || []).slice(0, 2).map(t => '#' + esc(t)).join(' ')}</p></button>`; };
  const wishRow = p => { const st = openState(p), ol = st && OPEN_LABEL[st]; const dd = distInfo(p);
    return `<button class="wish-row" data-go="${p.id}">${thumbHtml(p, 'tile')}<div style="flex:1;min-width:0"><b>${esc(p.name)}</b><p>${esc(kindLabel(p))} · ${esc(areaOf(p))}${dd ? ` <span class="mono">· ${fmtKm(dd.km)}km</span>` : ''}</p></div>${ol ? `<span class="chip op-${ol[1]}">${ol[0]}</span>` : (p.hours?.open ? `<span class="chip op-off">${esc(p.hours.open)} 오픈</span>` : '')}</button>`; };
  const tripCover = t => `<button class="trip-cover" data-trip="${t.id}" style="${tripCoverStyle(t)}"><span class="yr">${t.year} · ${COUNTRY_EN[t.country] || t.country}</span><span class="city">${esc(tripCity(t))}</span><span class="sub">${esc(tripSub(t))}</span>${t.country !== 'KR' ? `<img class="globe" src="${asset('assets/mark-globe.png')}" alt="">` : `<img class="stamp" src="${asset('assets/mark-stamp.png')}" alt="">`}</button>`;
  return `
    <div class="ph-hero"><div class="dots"></div><div class="sun"></div>
      <div class="ph-top"><img src="${asset('assets/mark-faces.png')}" alt="" style="width:76px"><img src="${asset('assets/wordmark-white.png')}" alt="준준 TRIP" style="width:118px;margin-left:-2px"><span style="flex:1"></span><button class="bell" data-act="settings" title="설정">${ICO.bell}</button></div>
      <div class="ph-copy"><div class="kicker">${SEASON_EN[d.season]} · ${d.ymText} · ${esc(baseShort())} 기준</div>
        <h1>${esc(d.title)},<br>어디로 갈까?</h1>
        <p class="sub">${esc(d.famName)} 휴양지 ${d.spots.length}곳, 맛집 ${d.rests.length}곳</p>
        <form class="ph-search" id="hero-search">${ICO.search}<input id="hq" type="search" placeholder="휴양지 · 식당 · 메뉴 검색" autocomplete="off"></form>
        <div class="ph-quick"><button class="gold" data-act="today"><i>${ICO.eat}</i>오늘 뭐 먹지</button><button data-act="planner"><i>${ICO.plan}</i>여행 만들기</button><button data-act="explore"><i>${ICO.map}</i>지도로 찾기</button><button data-act="wish"><i>${ICO.star}</i>가고싶다</button></div>
      </div></div>
    ${fp ? `<div class="ph-feat"><div class="tile${img ? ' ph' : ' info'}" style="${img ? `background:linear-gradient(0deg,rgba(0,0,0,.35),rgba(0,0,0,0) 50%),url('${img}') center/cover` : ''}">${!img ? `<div class="km">${di ? fmtKm(di.km) + '<small>km</small>' : '—'}</div><div class="sub">${di ? `${esc(baseShort())}에서 ${minText(di.min)}` : '위치 없음'}</div>` : ''}<span class="rank">이번 계절 ${S.heroIdx + 1}순위</span><span class="where">${fp.type === 'spot' ? '휴양지' : esc(cuisineOf(fp)[0] || '식당')} · ${esc(areaOf(fp))}</span></div>
      <div class="body"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px"><div><h2>${esc(fp.name)}</h2><p class="meta">${esc(distText(fp))}</p></div><button class="wish${fp.wish ? ' on' : ''}" data-wish="${fp.id}">${ICO.star}</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:14px">${d.why(feat).map((w, i) => `<span class="chip ${i === 0 && !w.startsWith('#') ? 'season' : 'tag'}">${esc(w)}</span>`).join('')}${ratingOf(fp) ? `<span class="chip tag">★ ${ratingOf(fp)}.0</span>` : ''}</div>
        <button class="cta" data-reco="${fp.id}">근처 식당 추천 <span class="mono">${d.nearRest(fp)}</span> →</button></div></div>` : ''}
    ${roBanner()}<div class="ph-stats"><div><b>${d.spots.length}</b><small>휴양지</small></div><div><b>${d.rests.length}</b><small>식당</small></div><div><b class="gold">${d.totalVisits}</b><small>방문 기록</small></div><div><b>${d.trips.length}</b><small>여행</small></div></div>
    <div class="sec"><div class="sh"><h3><span class="serif" style="font-weight:800">우리 가족</span> 기록</h3><button class="lnk" data-act="explore-visited">전체 ${d.logs.length || d.visited.length}</button></div>
      <div class="hs">${d.logs.length ? d.logs.slice(0, 10).map(logCard).join('') : d.visited.slice(0, 10).map(visitCard).join('') || '<div class="help" style="padding:0 20px">아직 기록이 없습니다. 상세 화면에서 "+ 기록 추가"로 남겨보세요.</div>'}</div></div>
    <div class="sec"><div class="sh"><h3>이번 계절 추천</h3><button class="lnk" data-act="planner">${esc(d.season)} ${d.scored.filter(x => x.score > 0).length}</button></div>
      <div class="hs">${d.scored.slice(0, 10).map(recoCard).join('')}</div></div>
    ${d.wish.length ? `<div class="sec"><div class="sh"><h3><span style="color:var(--accent)">★</span> 가고싶다</h3><button class="lnk" data-act="wish">${d.wish.length}곳</button></div><div class="wish-list">${d.wish.slice(0, 4).map(wishRow).join('')}</div></div>` : ''}
    <div class="sec"><div class="sh"><h3>여행 일정</h3><button class="lnk rw" data-act="planner">+ 새 여행</button></div><div class="hs">${d.trips.map(tripCover).join('')}</div></div>
    <div class="sec"><div class="sh"><h3>컬렉션</h3></div><div class="collect">${collectionsHtml(d, false)}</div></div>
    <div class="ph-foot"><img src="${asset('assets/logo-main.png')}" alt="준준 TRIP"><p>${esc(d.famName === '우리 가족' ? '함께 쌓는 우리 가족 여행 기록' : d.famName.replace('이네', '이와') + ' 함께 쌓는 우리 가족 여행 기록')}</p></div>
    <div style="height:30px"></div>`;
}
function renderHomePC(d) {
  const n = d.feats.length, i = S.heroIdx; const feat = d.feats[i]; const fp = feat?.s;
  const dcard = (x, k) => { const p = x.s, im = imgOf(p), dd = distInfo(p); const inner = im ? `<div class="img" style="background-image:url('${im}')"></div>` : `<div class="img info"><div class="km">${dd ? fmtKm(dd.km) + '<small>km</small>' : '—'}</div><div class="min">${dd ? `${esc(baseShort())}에서 ${minText(dd.min)}` : '위치 없음'}</div></div>`;
    if (k === 0) return `<div class="pc-feat"><div class="dcard" data-go="${p.id}"><div class="plate"></div>${inner}<div class="cap">${esc(p.name)}</div></div>${im ? `<span class="tagl">${familyPhoto(p) ? '우리 가족 사진' : '기본 사진 · 관광공사'}</span><button class="tagr" data-go="${p.id}">내 사진으로 바꾸기</button>` : ''}</div>`;
    return `<div class="pc-next" style="left:${1000 + (k - 1) * 293}px;animation-delay:${k * 80}ms"><button class="dcard sm" data-act="feat-go" data-k="${k}">${inner}<div class="cap">${esc(p.name)}</div></button></div>`; };
  const logCard = ({ p, v }, big) => big ? `<button class="pc-log big" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="h"><span class="cat">${esc(catDot(p))}</span>${esc(areaOf(p))} · 최근 기록</div>${(v.photo && photoUrl(v.photo)) || imgOf(p) ? `<div class="lc-img big" style="margin-top:14px"><img src="${(v.photo && photoUrl(v.photo)) || imgOf(p)}" alt=""></div>` : ''}<q>${esc(v.memo || p.name)}</q>${p.pros || p.signature ? `<p class="memo">${esc(p.pros || p.signature)}</p>` : ''}<div class="f"><div><b>${esc(p.name)}</b><p class="mono">${esc((v.date || '').slice(5).replace('-', '.'))} · <span class="st">★${v.rating || ''}</span> · ${p.visits}회</p></div><img class="stamp" src="${asset('assets/mark-stamp.png')}" alt=""></div><span class="add rw">+ 사진 추가</span></button>`
    : `<button class="pc-log" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="h"><i></i>${esc(catDot(p))}<span class="st">${starsTxt(v.rating)}</span></div>${(v.photo && photoUrl(v.photo)) || imgOf(p) ? `<div class="lc-img"><img src="${(v.photo && photoUrl(v.photo)) || imgOf(p)}" alt=""></div>` : ''}<q>${esc(v.memo || areaOf(p))}</q><div class="f"><b>${esc(p.name)}</b><span class="mono">${esc((v.date || '').slice(5).replace('-', '.'))}</span></div></button>`;
  const visitCard = (p, big) => `<button class="pc-log${big ? ' big' : ''}" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="h">${big ? `<span class="cat">${esc(catDot(p))}</span>` : `<i></i>${esc(catDot(p))}`}<span class="st">${starsTxt(ratingOf(p))}</span></div>${imgOf(p) ? `<div class="lc-img${big ? ' big' : ''}"${big ? ' style="margin-top:14px"' : ''}><img src="${imgOf(p)}" alt=""></div>` : ''}<q>${esc(p.pros || p.desc || p.signature || areaOf(p))}</q><div class="f"><b>${esc(p.name)}</b><span class="mono">방문 ${p.visits}회</span></div></button>`;
  const logsHtml = d.logs.length ? d.logs.slice(0, 5).map((l, k) => logCard(l, k === 0)).join('') : d.visited.slice(0, 5).map((p, k) => visitCard(p, k === 0)).join('');
  const wishRow = p => { const st = openState(p), ol = st && OPEN_LABEL[st]; const dd = distInfo(p);
    return `<button class="row" data-go="${p.id}">${thumbHtml(p, 'tile')}<div style="flex:1"><b>${esc(p.name)}</b><p>${esc(kindLabel(p))} · ${esc(areaOf(p))}${dd ? ` · ${fmtKm(dd.km)}km` : ''}</p></div>${ol ? `<span class="chip op-${ol[1]}">${ol[0]}</span>` : (p.tags?.[0] ? `<span class="chip op-off">#${esc(p.tags[0])}</span>` : '')}</button>`; };
  const trip = t => `<button class="pc-trip" data-trip="${t.id}"><div class="plate"></div><div class="photo" style="${tripCoverStyle(t)}"><div class="txt"><span class="mono">${t.year} · ${t.country === 'KR' ? '국내' : COUNTRY_EN[t.country] || t.country}</span><div class="disp">${esc(tripCity(t))}</div><p>${esc(tripSub(t))}</p></div>${t.country !== 'KR' ? `<img class="globe" src="${asset('assets/mark-globe.png')}" alt="">` : `<img class="stamp" src="${asset('assets/mark-stamp.png')}" alt="">`}</div></button>`;
  return `
    <div class="pc-hero-wrap" style="background-image:linear-gradient(rgba(14,58,75,.78),rgba(14,58,75,.78)),url('${asset('assets/hero-' + SEASON_EN[d.season] + '.jpg')}');background-size:cover;background-position:center"><div class="pc-hero" id="pc-hero">
      <div class="bg" style="background-image:linear-gradient(90deg,rgba(14,58,75,.82) 0%,rgba(14,58,75,.55) 40%,rgba(14,58,75,0) 62%),linear-gradient(180deg,rgba(14,58,75,.55),rgba(14,58,75,0) 30%),linear-gradient(0deg,rgba(14,58,75,.6),rgba(14,58,75,0) 45%),url('${asset('assets/hero-' + SEASON_EN[d.season] + '.jpg')}')"></div>
      <div class="note"><span>${esc(d.season)} 배경 · 계절마다 자동 교체</span>설정 › 사진에서 변경</div>
      <nav class="pc-nav"><div class="links">${['home', 'explore', 'trips', 'settings'].map((v, k) => `<button data-view="${v}" class="${v === 'home' ? 'on' : ''}">${['홈', '찾기', '여행', '설정'][k]}</button>`).join('')}</div></nav>
      <div class="pc-logo"><img src="${asset('assets/mark-faces.png')}" alt="" style="width:70px"><img src="${asset('assets/wordmark-white.png')}" alt="준준 TRIP" style="width:112px"></div>
      <div class="pc-right"><button data-act="base"><span class="g">⌂</span> 거점: ${esc(S.base?.name || '없음')} ▾</button><button data-act="settings">가족 ${(S.db.meta.family?.adults || 0) + (S.db.meta.family?.kids || []).length + (S.db.meta.family?.seniors || 0) || '설정'}</button></div>
      <div class="pc-copy"><div class="kicker">${SEASON_EN[d.season]} · ${d.ymText} · 우리 가족 식도락</div>
        <h1>${esc(d.title)},<br>어디로 갈까?</h1>
        ${fp ? `<p class="body"><span class="nm"><span class="lbl">이번 계절 ${i + 1}순위</span>${esc(fp.name)}</span>${esc(areaOf(fp))} · ${esc(distText(fp))}<span class="why">${d.why(feat).map(w => `<span>${esc(w)}</span>`).join('')}</span></p><div class="cta"><button class="wt-btn" data-reco="${fp.id}">근처 식당 ${d.nearRest(fp)}곳</button></div>` : ''}
      </div>
      <form class="pc-search" id="hero-search">${ICO.search}<input id="hq" type="search" placeholder="휴양지 · 식당 · 메뉴 검색" autocomplete="off"><button class="wt-btn">검색</button></form>
      <div class="pc-quick"><button class="gold" data-act="today">오늘 뭐 먹지</button><button data-act="planner">여행 만들기</button><button data-act="explore">지도로 찾기</button><button data-act="wish">★ 가고싶다</button></div>
      <div class="pc-stats"><div><b>${d.spots.length}</b><small>휴양지</small></div><div><b>${d.rests.length}</b><small>식당</small></div><div><b class="gold">${d.totalVisits}</b><small>방문 기록</small></div><div><b>${d.trips.length}</b><small>여행</small></div></div>
      ${n > 1 ? `<div class="pc-count">${String(i + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}</div><div class="pc-arrows"><button class="prev" data-act="feat-prev"><span style="background-image:url('${asset('assets/wt-arrow.png')}')"></span></button><button data-act="feat-next"><span style="background-image:url('${asset('assets/wt-arrow.png')}')"></span></button></div>` : ''}
      ${d.feats.slice(0, 2).map((x, k) => dcard(d.feats[(i + k) % n], k)).join('')}
    </div></div>
    <div class="pc-body">${roBanner()}
      <div class="pc-grid"><div><div class="sh"><h3>우리 가족 기록</h3><span>방문 사진 · 날짜 · 별점 · 한줄평</span><button class="lnk" data-act="explore-visited">전체 ${d.logs.length || d.visited.length} →</button></div>
        <div class="pc-logs">${logsHtml || '<div class="help">아직 기록이 없습니다.</div>'}</div></div>
        <div class="pc-side"><div class="pc-stat4"><div><b>${d.spots.length}</b><small>휴양지</small></div><div><b>${d.rests.length}</b><small>식당${d.nSaved ? ' · N저장 ' + d.nSaved : ''}</small></div><div><b class="gold">${d.totalVisits}</b><small>방문 기록</small></div><div><b>${d.trips.length}</b><small>여행</small></div></div>
          <div class="pc-wish"><div class="h"><b><span class="g">★</span> 가고싶다</b><button class="lnk" data-act="wish">${d.wish.length}곳 →</button></div>${d.wish.slice(0, 4).map(wishRow).join('') || '<p class="help">상세 화면의 ★로 담아두세요.</p>'}</div></div></div>
      <div style="padding-top:40px"><div class="sh"><h3>여행 일정</h3><span>지구 = 해외 · 스탬프 = 다녀옴</span><button class="lnk rw" data-act="planner">+ 새 여행 만들기</button></div>
        <div class="pc-trips">${d.trips.slice(0, 5).map(trip).join('')}${d.trips.length < 5 ? `<button class="pc-trip plus rw" data-act="planner"><div class="photo">+ 새 여행</div></button>` : ''}</div></div>
      <div style="padding-top:44px"><div class="sh"><h3>컬렉션</h3></div><div class="pc-collect">${collectionsHtml(d, true)}</div></div>
      <div class="pc-foot"><img src="${asset('assets/logo-header.png')}" alt="준준 TRIP"><p>${esc(d.famName === '우리 가족' ? '함께 쌓는 우리 가족 여행 기록' : d.famName.replace('이네', '이와') + ' 함께 쌓는 우리 가족 여행 기록')}</p><span class="sp"></span><span>엑셀 · JSON 내보내기는 설정에서 · 갱신 ${esc(S.db.meta.updated || '')}</span></div>
    </div>`;
}
function fitPcHero() {
  const phone = window.innerWidth <= 860; const sc = phone ? 1 : Math.min(1, document.documentElement.clientWidth / 1440);
  $('#top').style.zoom = sc;                                   // 상단바도 히어로와 같은 배율 → 로고·메뉴 위치 동일
  const h = $('#pc-hero'); if (!h) return; h.style.zoom = sc; h.parentElement.style.height = Math.round(819 * sc) + 'px';
  const hx = Math.max(0, (document.documentElement.clientWidth - 1440 * sc) / 2);   // 상단바와 같은 기준(문서 폭)으로 가운데 → 홈 스크롤바 유무와 무관하게 메뉴 위치 동일
  h.style.marginLeft = (hx / sc) + 'px';
}
function renderHome() {
  const el = $('#view-home'); if (!el) return;
  const d = homeData(); const phone = window.innerWidth <= 860; S.homeMode = phone ? 'phone' : 'pc';
  el.innerHTML = phone ? renderHomePhone(d) : renderHomePC(d);
  fitPcHero();
  $('#hero-search').onsubmit = e => { e.preventDefault(); S.q = $('#hq').value.trim(); $('#q').value = S.q; S.region = 'all'; renderRegionChips(); renderTagChips(); renderList(); showView('explore'); fitToVisible(); };
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) return showView(b.dataset.view);
    if (b.dataset.wish) { const p = placeById(b.dataset.wish); p.wish = !p.wish; markDirty(); renderHome(); return; }
    if (b.dataset.go) return openDetail(b.dataset.go);
    if (b.dataset.reco) return openRecommend(placeById(b.dataset.reco));
    if (b.dataset.trip) { S.trip = S.db.trips.find(t => t.id === b.dataset.trip); S.tripDay = 0; showView('trips'); return; }
    if (b.dataset.region) { S.region = b.dataset.region; S.scope = 'all'; S.flags.clear(); S.tags.clear(); LS.set('region', S.region); renderRegionChips(); renderTagChips(); const base = S.db.bases.find(x => x.default_for === S.region); if (base) setBase(base.id, true); renderList(); showView('explore'); fitToVisible(); return; }
    if (b.dataset.cuisine) { S.region = 'domestic'; S.scope = 'restaurant'; $$('#f-scope button').forEach(x => x.classList.toggle('on', x.dataset.v === 'restaurant')); S.q = b.dataset.cuisine; $('#q').value = S.q; renderRegionChips(); renderTagChips(); renderList(); showView('explore'); return; }
    const act = b.dataset.act; const n = d.feats.length;
    if (act === 'feat-prev' || act === 'feat-next') { S.heroIdx = (S.heroIdx + (act === 'feat-next' ? 1 : n - 1)) % n; renderHome(); return; }
    if (act === 'feat-go') { S.heroIdx = (S.heroIdx + +b.dataset.k) % n; renderHome(); return; }
    if (act === 'base') { e.stopPropagation(); baseMenu(b); return; }
    if (act === 'settings') showView('settings');
    if (act === 'today') todayPick();
    if (act === 'planner') openPlanner();
    if (act === 'explore') { showView('explore'); fitToVisible(); }
    if (act === 'trips') { S.trip = null; showView('trips'); }
    if (act === 'explore-visited') return openJournal();
    if (act === 'wish' || act === 'explore-unvisited') {
      S.flags.clear(); if (act === 'wish') S.flags.add('wish'); if (act === 'explore-unvisited') S.flags.add('unvisited');
      $$('#f-season button').forEach(x => x.classList.toggle('on', S.flags.has(x.dataset.v)));
      S.sort = act === 'explore-visited' ? 'rating' : S.sort; renderList(); showView('explore');
    }
  };
}

/* ---------------- 폰 바텀시트 ---------------- */
function initSheetDrag() {
  const panel = $('#panel'), grip = $('#grip'); if (!grip) return;
  const states = ['peek', '', 'full']; let idx = 1, sy = 0, sh = 0, dragging = false;
  const fab = $('#fab'); const place = () => { if (!fab) return; const pr = panel.getBoundingClientRect(), mr = $('#main').getBoundingClientRect(); fab.style.top = Math.max(80, pr.top - mr.top - 112) + 'px'; fab.style.opacity = pr.height > mr.height * .8 ? 0 : 1; };
  const apply = () => { panel.classList.remove('peek', 'full'); if (states[idx]) panel.classList.add(states[idx]); panel.style.height = ''; setTimeout(() => { map.invalidateSize(); place(); }, 290); };
  grip.addEventListener('pointerdown', e => { dragging = true; sy = e.clientY; sh = panel.getBoundingClientRect().height; grip.setPointerCapture(e.pointerId); panel.style.transition = 'none'; });
  grip.addEventListener('pointermove', e => { if (!dragging) return; const h = Math.max(90, Math.min(window.innerHeight * .92, sh + (sy - e.clientY))); panel.style.height = h + 'px'; place(); });
  grip.addEventListener('pointerup', e => { if (!dragging) return; dragging = false; panel.style.transition = ''; const h = panel.getBoundingClientRect().height, H = window.innerHeight; idx = h < H * .28 ? 0 : h > H * .7 ? 2 : 1; apply(); });
  grip.addEventListener('click', () => { idx = idx === 0 ? 1 : idx === 1 ? 2 : 0; apply(); });
  panel.setSheet = s => { idx = states.indexOf(s); if (idx < 0) idx = 1; apply(); }; place();
}

/* ---------------- 추가/수정 폼 ---------------- */
function openPlaceForm(p) {
  const isNew = !p || !placeById(p.id);
  p = p || { id: uid(), type: 'restaurant', country: S.region === 'domestic' || S.region === 'all' ? 'KR' : regionCountry(S.region), region: S.region === 'all' ? 'domestic' : S.region, name: '', cuisine: [], seasons: [], rating: 0, visits: 0, naver: {}, kakao: {} };
  const spots = S.db.places.filter(x => x.type === 'spot');
  const CU = p.country === 'KR' ? ['한식', '중식', '일식', '양식', '기타'] : ['현지', '해산물', '쌀국수', 'BBQ', '한식', '카페', '기타'];
  openSheet(`
    <div class="sheet-head"><h2>${isNew ? '장소 추가' : '수정'}</h2><button class="close" data-act="close">✕</button></div>
    <form class="form" id="pf">
      <div class="inline"><label>장소 검색 (카카오·OSM)<input id="pq" value="${esc(p.name)}" placeholder="상호명 + 지역"></label><button type="button" class="primary" data-act="psearch">검색</button></div>
      <div class="hits" id="phits" hidden></div>
      <div class="two">
        <label>유형<select name="type"><option value="restaurant"${p.type === 'restaurant' ? ' selected' : ''}>식당</option><option value="spot"${p.type === 'spot' ? ' selected' : ''}>휴양지</option><option value="mine"${isMine(p) ? ' selected' : ''}>우리 장소 (본가 등)</option></select></label>
        <label>지역 그룹<input name="region" list="regions" value="${esc(p.region)}"><datalist id="regions">${regionsInDb().map(([r]) => `<option value="${r}">${REGION_LABEL[r] || r}</option>`).join('')}</datalist></label>
      </div>
      <label>이름<input name="name" value="${esc(p.name)}" required></label>
      <div class="three">
        <label>국가<select name="country">${['KR', 'VN', 'TH', 'GU', 'JP', 'OTHER'].map(c => `<option${p.country === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
        <label>위도<input name="lat" value="${p.lat ?? ''}" inputmode="decimal"></label>
        <label>경도<input name="lng" value="${p.lng ?? ''}" inputmode="decimal"></label>
      </div>
      <label>주소<input name="address" value="${esc(p.address || '')}"></label>
      <div class="two">
        <label>도<input name="do" value="${esc(p.do || '')}"></label>
        <label>시·군·구역<input name="si" value="${esc(p.si || p.zone || '')}"></label>
      </div>
      <label>별점 (0~5)<input name="rating" type="number" min="0" max="5" value="${p.rating || 0}"></label>
      <label>종류 <div class="chips small" id="cu">${CU.map(c => `<button type="button" data-c="${c}" class="${cuisineOf(p).includes(c) ? 'on' : ''}">${c}</button>`).join('')}</div></label>
      <label>추천 계절 <div class="chips small" id="se">${['봄', '여름', '가을', '겨울'].map(c => `<button type="button" data-c="${c}" class="${(p.seasons || []).includes(c) ? 'on' : ''}">${c}</button>`).join('')}</div></label>
      <label>연계 휴양지<select name="spot_id"><option value="">없음</option>${spots.map(s => `<option value="${s.id}"${p.spot_id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <label>시그니처 메뉴<input name="signature" value="${esc(p.signature || '')}"></label>
      <label>설명<textarea name="desc">${esc(p.desc || '')}</textarea></label>
      <div class="two"><label>장점<input name="pros" value="${esc(p.pros || '')}"></label><label>단점<input name="cons" value="${esc(p.cons || '')}"></label></div>
      <label>비고<input name="note" value="${esc(p.note || '')}"></label>
      <div class="two"><label>카카오 링크<input name="kakao_url" value="${esc(p.kakao?.url || '')}"></label><label>전화<input name="phone" value="${esc(p.kakao?.phone || '')}"></label></div>
      <div class="btns"><button type="submit" class="primary">${isNew ? '추가' : '저장'}</button><button type="button" data-act="close">취소</button></div>
    </form>`);
  const f = $('#pf');
  f.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.c) { b.classList.toggle('on'); return; }
    if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'psearch') {
      b.textContent = '…';
      const hits = await geoSearch($('#pq').value, f.country.value, f.si.value);
      b.textContent = '검색';
      showHits($('#phits'), hits, h => { f.name.value ||= h.name; f.lat.value = h.lat; f.lng.value = h.lng; if (h.address) f.address.value = h.address; if (h.phone) f.phone.value = h.phone; if (h.src === '구글') f._google = { rating: h.rating, reviews: h.reviews, url: h.url }; else if (h.url) f.kakao_url.value = h.url; });
    }
  });
  f.addEventListener('submit', e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    const prevSpot = p.spot_id;
    Object.assign(p, { type: d.type, region: d.region.trim() || 'domestic', name: d.name.trim(), country: d.country, address: d.address.trim() || null,
      do: d.do.trim() || null, si: d.si.trim() || null, rating: +d.rating || 0, signature: d.signature.trim() || null, desc: d.desc.trim() || null,
      pros: d.pros.trim() || null, cons: d.cons.trim() || null, note: d.note.trim() || null, spot_id: d.spot_id || null,
      lat: d.lat ? +d.lat : null, lng: d.lng ? +d.lng : null,
      cuisine: $$('#cu button.on').map(b => b.dataset.c), seasons: $$('#se button.on').map(b => b.dataset.c),
      kakao: { ...(p.kakao || {}), url: d.kakao_url.trim() || null, phone: d.phone.trim() || null } });
    if (f._google) p.google = f._google;
    if (p.country !== 'KR' && p.si) { p.zone = p.si; }
    if (p.type === 'restaurant' && p.cuisine.length === 1 && p.country === 'KR') p.cuisine = p.cuisine[0];
    const sp = p.spot_id && placeById(p.spot_id); p.spot_name = sp ? sp.name : null;
    if (prevSpot !== p.spot_id) { const old = prevSpot && placeById(prevSpot); if (old?.restaurants) old.restaurants = old.restaurants.filter(x => x !== p.id); if (sp) { sp.restaurants ||= []; if (!sp.restaurants.includes(p.id)) sp.restaurants.push(p.id); } }
    if (isNew) S.db.places.push(p);
    markDirty(); renderRegionChips(); renderTagChips(); renderList(); closeSheet();
    if (isNew && p.type === 'spot' && hasCoord(p)) { toast('추가됨 — 근처 식당 추천'); openRecommend(p); } else { openDetail(p.id); toast(isNew ? '추가됨' : '저장됨'); }
  });
}
function showHits(el, hits, pick) {
  if (!hits.length) { el.hidden = false; el.innerHTML = '<button type="button" disabled>검색 결과 없음</button>'; return; }
  el.hidden = false;
  el.innerHTML = hits.map((h, i) => `<button type="button" data-i="${i}">${esc(h.name)}<small>${esc(h.address || '')} · ${h.src}</small></button>`).join('');
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; pick(hits[b.dataset.i]); el.hidden = true; toast('좌표 입력됨'); };
}

/* ---------------- 지오코딩 ---------------- */
function loadKakao(quiet) {
  const key = LS.get('kakaoJsMine', '') || S.db.meta.kakaoKey; if (!key || S.kakaoReady || window.kakao) return Promise.resolve(!!window.kakao);
  return new Promise(res => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => kakao.maps.load(() => { S.kakaoReady = true; res(true); });
    s.onerror = () => { if (!quiet) toast('카카오 SDK 로드 실패 — 키·도메인 등록 확인'); res(false); };
    document.head.appendChild(s);
  });
}
function kakaoSearch(q) {
  return new Promise(res => {
    if (!window.kakao?.maps?.services) return res([]);
    new kakao.maps.services.Places().keywordSearch(q, (data, status) => {
      if (status !== kakao.maps.services.Status.OK) return res([]);
      res(data.slice(0, 6).map(d => ({ name: d.place_name, lat: +d.y, lng: +d.x, address: d.road_address_name || d.address_name, phone: d.phone, url: d.place_url, src: '카카오' })));
    });
  });
}
async function osmSearch(q, cc) {
  try {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=ko,en&q=${encodeURIComponent(q)}${cc && cc !== 'OTHER' ? '&countrycodes=' + (cc === 'GU' ? 'gu' : cc.toLowerCase()) : ''}`;
    const r = await fetch(u); if (!r.ok) return [];
    return (await r.json()).map(d => ({ name: d.name || d.display_name.split(',')[0], lat: +d.lat, lng: +d.lon, address: d.display_name, src: 'OSM' }));
  } catch { return []; }
}
async function geoSearch(q, country, area) {
  q = (q || '').trim(); if (!q) return [];
  if (country === 'KR') {
    await loadKakao();
    let hits = await kakaoSearch(area ? `${area} ${q}` : q);
    if (!hits.length && area) hits = await kakaoSearch(q);
    if (!hits.length) hits = await osmSearch(q, 'KR');
    return hits;
  }
  if (googleKey()) { const g = await googleSearch(q, S.base); if (g.length) return g; }
  return osmSearch(q, country);
}
async function geocodePlace(p) {
  const name = p.name.replace(/\s*\(.*?\)\s*/g, ' ').trim();
  let hits = [];
  if (p.country === 'KR') hits = await geoSearch(name, 'KR', p.si || (p.spot_id && placeById(p.spot_id)?.si) || '');
  else { if (googleKey()) hits = await googleSearch(`${name} ${p.address || p.zone || ''}`.trim(), S.db.bases.find(b => b.country === p.country) || S.base); if (!hits.length && p.address) hits = await osmSearch(p.address, p.country); if (!hits.length) hits = await osmSearch(name.split(' ').slice(-2).join(' ') + ' ' + (p.zone === '깜란' ? 'Cam Ranh' : 'Nha Trang'), p.country); }
  if (!hits.length) return null;
  const h = hits[0];
  p.lat = h.lat; p.lng = h.lng; p.address ||= h.address; if (h.src === '구글') p.google = { rating: h.rating, reviews: h.reviews, url: h.url }; else if (h.url) p.kakao = { ...(p.kakao || {}), url: h.url, phone: h.phone || p.kakao?.phone }; p.geo_src = h.src; p.geo_auto = true;
  return h.name;
}
async function geocodeAll(btn, bar) {
  const todo = S.db.places.filter(p => !hasCoord(p));
  if (!todo.length) return toast('좌표 없는 장소 없음');
  if (todo.some(p => p.country === 'KR') && !S.db.meta.kakaoKey) toast('국내 장소는 카카오 키가 있어야 정확합니다 (OSM 대체 시도)', 3500);
  btn.disabled = true; let n = 0, ok = 0;
  for (const p of todo) {
    const r = await geocodePlace(p); if (r) ok++;
    n++; bar.style.width = (n / todo.length * 100) + '%'; btn.textContent = `좌표 수집 ${n}/${todo.length}`;
    if (p.country !== 'KR') await new Promise(r => setTimeout(r, 1100));   // Nominatim 1req/s
  }
  btn.disabled = false; btn.textContent = '좌표 일괄 수집'; markDirty(); renderList(); toast(`완료: ${ok}/${todo.length} 좌표 확보`); renderSettings();
}

/* ---------------- 여행 ---------------- */
function tripDates(t) {                                       // 일자 라벨("10/21 (월)") + 연도 → 날짜 범위
  const days = [...new Set(t.items.map(i => i.day).filter(Boolean))];
  const ds = days.map(d => { const m = d.match(/(\d{1,2})\/(\d{1,2})/); return m ? new Date(t.year, +m[1] - 1, +m[2]) : null; }).filter(Boolean);
  if (!ds.length) return { days, start: null, end: null, nights: 0 };
  const start = ds[0], end = ds[ds.length - 1]; const nights = Math.round((end - start) / 864e5);
  return { days, start, end, nights };
}
const md = d => d ? `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}` : '';
function dday(t) { const { start } = tripDates(t); if (!start) return null; const n = Math.round((start - new Date(new Date().toDateString())) / 864e5); return n; }
function tripRestCount(t) { return t.items.filter(i => i.place_id ? placeById(i.place_id)?.type === 'restaurant' : /식|점심|저녁|중식|석식|조식|카페|맛집/.test(i.activity || '')).length; }
function renderTrips() {
  const el = $('#trips');
  if (!S.trip) {                                                 // 08a 여행 목록
    const trips = S.db.trips.slice().sort((a, b) => (dday(b) ?? -9999) - (dday(a) ?? -9999) || b.year - a.year);
    const up = trips.find(t => (dday(t) ?? -1) >= 0) || trips[0];
    const rest = trips.filter(t => t !== up);
    const cover = t => { const { start, end, nights } = tripDates(t); const dd = dday(t);
      return `<button class="tp-big" data-id="${t.id}" style="${tripCoverStyle(t)}"><span class="num k">${dd != null && dd >= 0 ? `D-${dd}` : t.year} · ${t.country === 'KR' ? '국내' : COUNTRY_EN[t.country] || t.country}</span><span class="serif city">${esc(tripCity(t))}</span><span class="sub">${start ? `${t.year}.${md(start)} – ${md(end)} · ${nights}박 ${nights + 1}일` : `${t.items.length}개 일정`}</span>
        <span class="pills"><span>일정 ${t.items.length}</span><span>식당 ${tripRestCount(t)}</span></span>${t.country !== 'KR' ? `<img class="globe" src="${asset('assets/mark-globe.png')}" alt="">` : `<img class="stamp" src="${asset('assets/mark-stamp-white.png')}" alt="">`}</button>`; };
    const small = t => `<button class="tp-sm" data-id="${t.id}" style="${tripCoverStyle(t)}"><span class="num k">${t.year}${t.country === 'KR' ? ' · 국내' : ''}</span><span class="serif city">${esc(tripCity(t))}</span>${(dday(t) ?? -1) < 0 ? `<img class="stamp" src="${asset('assets/mark-stamp-white.png')}" alt="">` : `<img class="globe" src="${asset('assets/mark-globe.png')}" alt="">`}</button>`;
    el.innerHTML = `<div class="tp-hd"><b>여행</b><button class="chip on rw" data-act="planner" style="height:36px">+ 새 여행</button></div>
      <div class="tp-list">${up ? cover(up) : '<div class="help">아직 여행이 없습니다.</div>'}<div class="tp-grid">${rest.map(small).join('')}</div>
      <div class="btns" style="margin:4px 0 0"><button class="rw" data-act="newtrip">＋ 빈 여행 추가</button><button data-act="xlsxall">엑셀 내보내기</button></div></div>`;
    el.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.id) { S.trip = S.db.trips.find(t => t.id === b.dataset.id); S.tripDay = 0; renderTrips(); focusTrip(); } if (b.dataset.act === 'newtrip') openTripForm(); if (b.dataset.act === 'planner') openPlanner(); if (b.dataset.act === 'xlsxall') exportXlsx(); };
    return;
  }
  const t = S.trip, { days, start, end } = tripDates(t);              // 08b 타임라인
  const day = days[S.tripDay] || days[0];
  const items = t.items.filter(i => i.day === day);
  const region = tripRegion(t);
  const base = S.db.bases.find(b => b.default_for === region);
  const kindOf = it => { const p = it.place_id && placeById(it.place_id); if (p) return p.type === 'spot' ? ['spot', 'var(--cat-spot)'] : ['meal', catColor(p)]; if (/출발|귀가|복귀|숙소|체크인|체크아웃|공항|이동/.test(it.activity || '')) return ['base', 'var(--pin)']; if (/식|점심|저녁|중식|석식|조식|카페|맛집/.test(it.activity || '')) return ['meal', 'var(--cat-local)']; return ['spot', 'var(--cat-spot)']; };
  let prevPlace = base;
  const rows = items.map((it, i) => {
    const isBase = /출발|귀가|복귀|숙소|체크인|체크아웃|공항/.test(it.activity || '');
    const m = it.place_id ? placeById(it.place_id) : (it.place && !isBase && matchPlace(it.place));
    if (/^이동/.test(it.activity || '')) return `<span class="num cap3">${esc(it.time || '')}</span><div class="mv"><span></span></div><div class="mvt">차 ${esc(it.note || '')}</div>`;
    const [kind, color] = kindOf(it);
    let legTxt = '';
    if (m && hasCoord(m) && prevPlace && hasCoord(prevPlace) && prevPlace !== m) { const L = leg(prevPlace, m); legTxt = `<span class="num cap3"></span><div class="mv"><span></span></div><div class="mvt">차 ${L.min}분 · ${fmtKm(L.km)}km</div>`; }
    if (m && hasCoord(m)) prevPlace = m;
    const os = m && openState(m), ol = os && OPEN_LABEL[os];
    const card = `<div class="tl-card${kind === 'meal' ? ' meal' : ''}"><div style="flex:1;min-width:0"><b>${esc(it.activity || it.place || '')}</b><p class="cap">${esc([m ? (m.type === 'spot' ? '휴양지' : cuisineOf(m)[0]) : '', it.place && it.place !== it.activity ? it.place : '', it.note].filter(Boolean).join(' · '))}</p>${m && m.tags?.length ? `<div class="tags">${m.tags.slice(0, 2).map(x => `<span class="chip soft">#${esc(x)}</span>`).join('')}</div>` : ''}</div>${ol ? `<span class="num ${ol[1]}">${ol[0]}</span>` : ''}<button class="lnk rw" data-edititem="${t.items.indexOf(it)}" title="수정">✎</button>${m ? `<button class="lnk" data-go="${m.id}">›</button>` : (it.place && !isBase && !/미정/.test(it.place) ? `<button class="lnk rw" data-addplace="${t.items.indexOf(it)}">＋등록</button>` : '')}</div>`;
    return legTxt + `<span class="num cap">${esc(it.time || '')}</span><div class="dotcol"><span class="dot" style="background:${color};box-shadow:0 0 0 1px ${color}"></span>${i < items.length - 1 ? '<span class="line"></span>' : ''}</div><div class="cardcol">${card}</div>`;
  }).join('');
  el.innerHTML = `
    <div class="tp-hero" style="${tripCoverStyle(t)}"><div class="tp-top"><button class="back" data-act="back">‹</button><div style="display:flex;gap:6px"><button class="pill" data-act="tshare">↗</button><button class="pill rw" data-act="edit-trip">편집</button></div></div>
      <div class="tp-title"><span class="serif">${esc(tripCity(t))}</span><span class="num">${start ? `${md(start)}–${md(end)}` : t.year}${base ? ` · 거점 ${esc(base.name.replace(/\s*\(.*\)/, ''))}` : ''}</span></div></div>
    <div class="daytabs">${days.map((d, i) => { const m2 = d.match(/(\d{1,2})\/(\d{1,2})/); return `<button data-day="${i}" class="${i === S.tripDay ? 'on' : ''}">D${i + 1}<b class="num">${m2 ? `${m2[1].padStart(2, '0')}.${m2[2].padStart(2, '0')}` : esc(d)}</b></button>`; }).join('')}</div>
    <div class="tl-wrap"><div class="legend"><span class="chip"><i style="background:var(--cat-spot)"></i>휴양지</span><span class="chip"><i style="background:var(--cat-seafood)"></i>식사</span><span class="chip"><i class="dash"></i>이동</span></div>
      <div class="tl2">${rows || '<div class="help">이 날 일정이 없습니다.</div>'}</div></div>
    <div class="tp-acts">${t.plan ? '<button class="rw" data-act="replan">플래너로 다시 열기</button>' : ''}<button data-act="region">${REGION_LABEL[region] || region} 식당 보기</button><button data-act="txlsx">엑셀</button><button data-act="journal">여행기</button><button data-act="guide">안내서 만들기</button></div>
    <button class="fab-add rw" data-act="additem">+ 일정 추가</button>`;
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'back') { S.trip = null; renderTrips(); }
    if (b.dataset.act === 'region') { S.region = region; S.scope = 'all'; renderRegionChips(); renderList(); showView('explore'); fitToVisible(); }
    if (b.dataset.day != null) { S.tripDay = +b.dataset.day; renderTrips(); }
    if (b.dataset.go) openDetail(b.dataset.go);
    if (b.dataset.addplace != null) { const it = t.items[b.dataset.addplace]; openPlaceForm({ id: uid(), type: 'restaurant', country: t.country, region, name: it.place, cuisine: [], seasons: [], rating: 0, visits: 0, naver: {}, kakao: {}, note: it.activity }); }
    if (b.dataset.act === 'additem') openItemForm(t);
    if (b.dataset.act === 'edit-trip') openTripEdit(t);
    if (b.dataset.act === 'tshare') shareLink('t', t.id, t.title);
    if (b.dataset.act === 'txlsx') exportXlsx({ trip: t });
    if (b.dataset.act === 'guide') exportGuideJson(t);
    if (b.dataset.act === 'journal') openJournal({ tripId: t.id });
    if (b.dataset.act === 'replan') openPlanner({ tripId: t.id, title: t.title, region: t.plan.region, start: t.plan.start, days: t.plan.days, maxSpots: t.plan.maxSpots, spots: t.plan.spots, dayOrders: t.plan.dayOrders, stayOverride: t.plan.stayOverride, forceMeals: t.plan.forceMeals, area: t.plan.area, autoFill: t.plan.autoFill, lodge: t.plan.lodge, radiusKm: t.plan.radiusKm, candPick: t.plan.candPick, mealKm: t.plan.mealKm });
    if (b.dataset.edititem != null) openItemEdit(t, +b.dataset.edititem);
  };
}
function openItemEdit(t, idx) {                                  // 타임라인 항목 시간·내용 수정·삭제
  const it = t.items[idx]; if (!it) return;
  openSheet(`<div class="sheet-head"><h2>일정 수정</h2><button class="close" data-act="close">✕</button></div>
    <form class="form" id="ief"><div class="two"><label>일자<input name="day" value="${esc(it.day || '')}"></label><label>시간<input name="time" value="${esc(it.time || '')}" placeholder="12:30"></label></div>
    <label>내용<input name="activity" value="${esc(it.activity || '')}" required></label><label>장소<input name="place" value="${esc(it.place || '')}"></label><label>비고<input name="note" value="${esc(it.note || '')}"></label>
    <div class="btns"><button class="primary">저장</button><button type="button" class="danger" data-act="del">삭제</button></div></form>`);
  const f = $('#ief');
  f.addEventListener('submit', e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f)); Object.assign(it, { day: d.day.trim(), time: d.time.trim(), activity: d.activity.trim(), place: d.place.trim() || null, note: d.note.trim() || null }); t.items.sort((a, b) => (a.day || '').localeCompare(b.day || '') || (a.time || '').localeCompare(b.time || '')); markDirty(); closeSheet(); renderTrips(); });
  f.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'close') closeSheet(); if (b.dataset.act === 'del') { t.items.splice(idx, 1); markDirty(); closeSheet(); renderTrips(); } });
}
function openTripEdit(t) {
  openSheet(`<div class="sheet-head"><h2>여행 편집</h2><button class="close" data-act="close">✕</button></div>
    <form class="form" id="tef"><label>제목<input name="title" value="${esc(t.title)}" required></label>
    <div class="three"><label>도시<input name="city" value="${esc(t.city)}" required></label><label>국가<input name="country" value="${esc(t.country)}"></label><label>연도<input name="year" type="number" value="${t.year}"></label></div>
    <div class="sec">일정 ${t.items.length}개 <span class="sec-note">✕로 삭제</span></div>
    <div class="sublist">${t.items.map((it, i) => `<button type="button" data-del="${i}"><span class="mono" style="color:var(--text-2)">${esc(it.day || '')} ${esc(it.time || '')}</span><span style="flex:1;text-align:left;margin-left:8px">${esc(it.activity || '')}${it.place ? ' · ' + esc(it.place) : ''}</span><span>✕</span></button>`).join('')}</div>
    <div class="btns"><button class="primary">저장</button><button type="button" class="danger" data-act="deltrip">여행 삭제</button></div></form>`);
  const f = $('#tef');
  f.addEventListener('submit', e => { e.preventDefault(); const d = Object.fromEntries(new FormData(f)); t.title = d.title.trim(); t.city = d.city.trim(); t.country = d.country.trim().toUpperCase(); t.year = +d.year; markDirty(); closeSheet(); renderTrips(); });
  f.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'close') closeSheet(); if (b.dataset.del != null) { t.items.splice(+b.dataset.del, 1); markDirty(); openTripEdit(t); } if (b.dataset.act === 'deltrip') { if (b.dataset.c) { trashPut('trip', t); S.db.trips = S.db.trips.filter(x => x !== t); markDirty(); closeSheet(); S.trip = null; renderTrips(); } else { b.dataset.c = 1; b.textContent = '정말 삭제? (다시 클릭)'; } } });
}
// 안내서 스킬(trip-guide-html)용 JSON 내보내기
function exportGuideJson(t) {                                    // trip-guide-html v2 입력 스키마(2-1절)에 맞춘 내보내기
  const region = t.plan?.region || tripRegion(t);
  const lodge = t.plan?.lodge && hasCoord(t.plan.lodge) ? t.plan.lodge : null;
  const base = lodge || S.db.bases.find(b => b.default_for === region) || baseFor({ country: t.country, region }) || S.base;
  const ids = new Set(t.items.map(i => i.place_id).filter(Boolean));
  const inTrip = S.db.places.filter(p => ids.has(p.id));
  for (const p of inTrip) if (p.type === 'spot') for (const r of S.db.places) if (r.spot_id === p.id) ids.add(r.id);   // 일정 휴양지의 연계 식당
  const anchors = [...inTrip.filter(hasCoord), ...(base && hasCoord(base) ? [base] : [])];
  const near = p => hasCoord(p) && anchors.some(a => haversine(a, p) <= 15);       // 일정·숙소 15km 안 등록 장소
  const pool = S.db.places.filter(p => ids.has(p.id) || (p.country === t.country && (t.country !== 'KR' ? p.region === region : near(p))));
  const abs = u => { if (!u) return null; if (/^(data:|https?:)/.test(u)) return u; try { return new URL(u, location.href).href; } catch { return u; } };
  const places = pool.map(p => { const d = base && hasCoord(base) && hasCoord(p) ? haversine(base, p) : null; const e = d != null ? roadEst(d, p.country) : null;
    return { id: p.id, type: p.type === 'mine' ? 'spot' : p.type, country: p.country, name: p.name, lat: p.lat ?? null, lng: p.lng ?? null, addr: p.address || '', tags: p.tags || [], hours: p.hours || null, parking: p.parking || null,
      google: p.google || {}, naver: p.naver || {}, kakao: p.kakao || {}, photo: abs(familyPhoto(p)), basePhoto: p.basePhoto ? { ...p.basePhoto, path: abs(photoUrl(p.basePhoto.path)) } : null,
      visitLog: (p.visitLog || []).map(v => ({ ...v, photo: abs(v.photo && photoUrl(v.photo)), photos: (v.photos || []).map(x => abs(photoUrl(x))) })),
      cuisine: cuisineOf(p).join(', ') || undefined, signature: p.signature || undefined, area: areaOf(p) || undefined, km: e ? Math.round(e.road * 10) / 10 : null, min: e ? e.min : null, q: [p.name, p.si || p.zone].filter(Boolean).join(' ') }; });
  const { start, end } = tripDates(t); const iso = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : undefined;
  const trip = { id: t.id, title: t.title, city: tripCity(t), country: t.country, year: t.year, planned: !!t.planned, start: t.plan?.start || iso(start), end: iso(end), travelers: familyNames(), interests: t.interests || [],
    items: t.items.map(i => ({ day: i.day, time: i.time, activity: i.activity, place: i.place, note: i.note || null, place_id: i.place_id || null })) };
  const out = { trip, places, base: base ? { name: base.name, lat: base.lat, lng: base.lng, addr: base.address || base.note || '' } : null, family: { ...(S.db.meta.family || {}) }, mode: t.country === 'KR' ? 'domestic' : 'overseas' };
  const fname = `${today().replace(/-/g, '.')}_${tripCity(t)}_guide.json`;
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname; a.click();
  const prompt = `첨부한 ${fname}로 trip-guide-html 스킬을 써서 ${tripCity(t)} 오프라인 여행 안내서를 만들어줘.\n- 모드: ${out.mode === 'domestic' ? '국내' : '해외'} / 기간: ${trip.start || '?'} ~ ${trip.end || '?'} / 숙소: ${base?.name || '미정'}\n- guide 블록은 출처 있는 정보만, 없는 값은 지어내지 말 것\n- 여권·예약번호는 넣지 말 것\n- 결과 HTML 하나로 (사진·폰트 내장)`;
  openSheet(`<div class="ks-sheet"><div class="hd"><button class="back" data-act="close">‹</button><div style="flex:1"><p class="cap3">trip-guide-html v2</p><b>안내서 만들기</b></div></div>
    <div class="ks-body">
      <div class="grp" style="margin:0"><div><span style="flex:1">내보낸 파일<p class="cap3">${esc(fname)}</p></span><span class="ok">다운로드됨</span></div><div><span style="flex:1">포함<p class="cap3">일정 ${trip.items.length}줄 · 장소 ${places.length}곳 · 방문 기록 ${places.reduce((n, p) => n + p.visitLog.length, 0)} · 사진 ${places.filter(p => p.photo || p.basePhoto).length}</p></span></div><div><span style="flex:1">기준 숙소<p class="cap3">${esc(base?.name || '없음')}</p></span></div></div>
      <p class="cap">① 받은 JSON을 클로드 대화에 첨부 → ② 아래 요청문 복사해 붙여넣기 → ③ 결과 HTML을 폰에 저장 (인터넷 없이 열림)</p>
      <pre class="ks-code" id="gp" style="white-space:pre-wrap">${esc(prompt)}</pre>
      <button class="btn pri" data-act="copy">요청문 복사</button>
    </div></div>`);
  $('#sheet-inner').onclick = async e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'close') closeSheet();
    if (b.dataset.act === 'copy') { try { await navigator.clipboard.writeText(prompt); b.textContent = '복사됨 ✓'; } catch { toast('복사 실패 — 길게 눌러 직접 복사'); } } };
}
function tripRegion(t) { if (t.plan?.region) return t.plan.region; if (t.country === 'KR') return 'domestic'; return { '나트랑': 'nhatrang', '다낭': 'danang', '방콕': 'bangkok', '괌': 'guam' }[tripCity(t)] || (t.city || '').toLowerCase(); }
function matchPlace(name) {
  const n = name.toLowerCase().replace(/\s+/g, '');
  return S.db.places.find(p => { const pn = p.name.toLowerCase().replace(/\s+/g, ''); return pn.includes(n) || n.includes(pn.split('(')[0]) || p.name.split(' ').some(w => w.length > 2 && n.includes(w.toLowerCase())); });
}
function focusTrip() {
  const region = tripRegion(S.trip);
  const pts = S.db.places.filter(p => p.region === region && hasCoord(p)).map(p => [p.lat, p.lng]);
  const base = S.db.bases.find(b => b.default_for === region); if (base) setBase(base.id, true);
  if (S.db.places.some(p => p.region === region)) { S.region = region; LS.set('region', region); renderRegionChips(); renderList(); }
  if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 13 }); else if (base) map.setView([base.lat, base.lng], 11);
}
function openTripForm() {
  openSheet(`<div class="sheet-head"><h2>여행 추가</h2><button class="close" data-act="close">✕</button></div>
    <form class="form" id="tf"><label>제목<input name="title" required placeholder="2026 후쿠오카 가족 여행 일정"></label>
    <div class="three"><label>도시<input name="city" required placeholder="후쿠오카"></label><label>국가<input name="country" value="JP"></label><label>연도<input name="year" type="number" value="${new Date().getFullYear()}"></label></div>
    <div class="btns"><button class="primary">추가</button></div></form>`);
  $('#tf').addEventListener('submit', e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); const t = { id: 'trip' + uid(''), title: d.title.trim(), city: d.city.trim(), country: d.country.trim().toUpperCase(), year: +d.year, items: [] }; S.db.trips.push(t); markDirty(); closeSheet(); S.trip = t; renderTrips(); });
  $('#tf').addEventListener('click', e => { if (e.target.dataset.act === 'close') closeSheet(); });
}
function openItemForm(t) {
  const days = [...new Set(t.items.map(i => i.day).filter(Boolean))];
  openSheet(`<div class="sheet-head"><h2>일정 추가</h2><button class="close" data-act="close">✕</button></div>
    <form class="form" id="if"><div class="two"><label>일자<input name="day" list="days" value="${esc(days[S.tripDay] || '')}" placeholder="6/28 (토)"><datalist id="days">${days.map(d => `<option value="${esc(d)}">`).join('')}</datalist></label><label>시간<input name="time" placeholder="12:30"></label></div>
    <label>내용<input name="activity" required placeholder="중식"></label><label>장소<input name="place" placeholder="안토이 Ăn Thôi"></label><label>비고<input name="note"></label>
    <div class="btns"><button class="primary">추가</button></div></form>`);
  $('#if').addEventListener('submit', e => { e.preventDefault(); const d = Object.fromEntries(new FormData(e.target)); t.items.push({ day: d.day.trim(), time: d.time.trim(), activity: d.activity.trim(), place: d.place.trim() || null, note: d.note.trim() || null }); markDirty(); closeSheet(); renderTrips(); });
  $('#if').addEventListener('click', e => { if (e.target.dataset.act === 'close') closeSheet(); });
}

/* ---------------- 설정 ---------------- */
/* ---------------- 설정 (시안 09) ---------------- */
const FAM_COLORS = ['var(--primary)', 'var(--primary-2)', '#2a6fb8', '#2e8b57', '#b5651d', '#7d3c98'];
function maskKey(k) { k = (k || '').trim(); if (!k) return ''; return k.length > 10 ? k.slice(0, 4) + '••••' + k.slice(-4) : '••••'; }
function themePref() { return LS.get('theme', 'auto'); }
function applyTheme() { const t = themePref(); if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; document.body.classList.toggle('dark-tiles', isDark()); const m = $('meta[name=theme-color]'); if (m) m.content = (t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches)) ? '#0f1a1e' : '#ffffff'; }
function seasonPref() { return LS.get('season', 'auto'); }
function seasonHome() { const s = seasonPref(); return s === 'auto' ? seasonNow() : s; }
const KEY_DEFS = {                                         // 키 입력 화면(행 탭): 입력칸 + 붙여넣기 + 연결 확인
  gh: { title: 'GitHub 토큰', cap: '가족 데이터 저장 · 없으면 읽기 전용', get: () => S.token, set: v => { S.token = v; LS.set('token', v); S.sha = null; }, ph: 'github_pat_…', scope: '이 기기',
    extra: () => `<label class="ks-field"><span class="cap">저장소 (owner/repo)</span><input id="ks-repo" value="${esc(S.repo)}" placeholder="${CFG.repo}"></label>`,
    before: () => { S.repo = ($('#ks-repo')?.value || '').trim() || CFG.repo; LS.set('repo', S.repo); },
    test: async () => { S.sha = null; await load(); return S.sha ? `연결됨 · ${S.repo} · 갱신 ${S.db.meta.updated || ''}` : null; },
    after: () => { boot(true); applyReadOnly(); },
    help: 'GitHub › Settings › Developer settings › Fine-grained tokens · 저장소 foodtrip · Contents: Read and write · 만료 1년' },
  kakaojs: { title: '카카오 JavaScript 키', cap: '지도 표시 · 장소 검색', get: () => LS.get('kakaoJsMine', ''), set: v => { LS.set('kakaoJsMine', v); S.kakaoReady = false; }, ph: 'JavaScript 키', scope: '이 기기 (비우면 공용 키 사용)',
    extra: () => `<label class="ks-field"><span class="cap">공용 키 (앱 전체 · 저장소에 기록)</span><input id="ks-shared" value="${esc(S.db.meta.kakaoKey || '')}" placeholder="앱 소유자만 입력"></label>`,
    before: () => { const v = ($('#ks-shared')?.value || '').trim(); if (v !== (S.db.meta.kakaoKey || '')) { S.db.meta.kakaoKey = v; markDirty(); } },
    test: async () => { const ok = await loadKakao(); const hits = ok ? await kakaoSearch('남양주 팔당수산') : []; return hits.length ? `OK — ${hits[0].name}` : null; },
    help: 'developers.kakao.com › 내 애플리케이션 › 앱 키 › JavaScript 키 · 플랫폼 Web에 이 사이트 도메인 등록 · 카카오맵 활성화' },
  krest: { title: '카카오 REST 키', cap: '길찾기 · 주변 후보 검색', get: kakaoRestKey, set: v => LS.set('kakaoRest', v), ph: 'REST API 키', scope: '이 기기',
    test: async () => { const r = await kakaoRoute({ lat: 37.5872, lng: 127.2132 }, { lat: 37.5480, lng: 127.0746 }); return r ? `OK — 집→어린이대공원 ${fmtKm(r.km)}km · ${fmtMin(r.min)}` : null; },
    help: '같은 카카오 앱의 REST API 키 · 카카오모빌리티 길찾기 사용 설정 ON' },
  google: { title: '구글 Places 키', cap: '해외 장소 검색 · 평점 · 주변 식당', get: googleKey, set: v => LS.set('googleKey', v), ph: 'AIza…', scope: '이 기기',
    test: async () => { const g = await googleNearby({ lat: 12.2388, lng: 109.1967 }, ['restaurant'], 1500, 'POPULARITY', 3); return g.length ? `OK — ${g[0].name} (G${g[0].rating ?? '-'})` : null; },
    help: 'Google Cloud › Places API (New) 사용 › API 키 (HTTP 리퍼러 제한 권장) · 월 무료 사용량 내 과금 0' },
};
function openKeySheet(kind) {
  const K = KEY_DEFS[kind]; const cur = K.get() || '';
  openSheet(`<div class="ks-sheet">
    <div class="hd"><button class="back" data-act="back">‹</button><div style="flex:1;min-width:0"><p class="cap3">${esc(K.cap)}</p><b>${esc(K.title)}</b></div></div>
    <div class="ks-body">
      ${K.extra ? K.extra() : ''}
      <label class="ks-field"><span class="cap">${esc(K.title)} <span class="cap3">· ${esc(K.scope)}</span></span><input id="ks-key" type="password" value="${esc(cur)}" placeholder="${esc(K.ph)}" autocomplete="off" spellcheck="false"></label>
      <div class="ks-row"><button class="btn line" data-act="paste">붙여넣기</button><button class="btn line" data-act="test">연결 확인</button></div>
      <button class="btn pri" data-act="save">저장</button>
      <div class="ks-status" id="ks-status">${cur ? `저장됨 · <span class="num">${esc(maskKey(cur))}</span>` : '미입력'}</div>
      <p class="cap ks-help">${esc(K.help)}<br>키는 이 기기 브라우저에만 저장 · JSON 내보내기에 포함 안 함${cur ? ' · 비우고 저장하면 삭제' : ''}</p>
    </div></div>`);
  const sheet = $('#sheet-inner'), st = () => $('#ks-status'), input = () => $('#ks-key');
  sheet.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
    if (act === 'back') { closeSheet(); renderSettings(); return; }
    if (act === 'paste') { try { const t = (await navigator.clipboard.readText()).trim(); if (t) { input().value = t; st().textContent = '붙여넣음 — 「연결 확인」 또는 「저장」'; } else toast('클립보드가 비어 있음'); } catch { toast('클립보드 읽기 권한 없음 — 직접 입력'); } return; }
    if (act === 'test' || act === 'save') {
      const v = input().value.trim(); K.before?.(); K.set(v);
      if (act === 'save') { st().innerHTML = v ? `저장됨 · <span class="num">${esc(maskKey(v))}</span>` : '삭제됨 (미입력)'; toast(v ? `${K.title} 저장 (${K.scope.split(' ')[0]})` : `${K.title} 삭제`); if (K.after) await K.after(); renderSettings(); return; }
      if (!v) { st().textContent = '키를 먼저 입력'; return; }
      st().textContent = '연결 확인 중…';
      try { const r = await K.test(); st().innerHTML = r ? `<span class="ok">${esc(r)}</span>` : '<span class="no" style="color:var(--danger)">실패 — 키·도메인·권한 확인</span>'; if (r && K.after) await K.after(); }
      catch (err) { st().innerHTML = `<span style="color:var(--danger)">실패 — ${esc(err.message)}</span>`; }
    }
  };
}
function openFamilyEdit() {
  const f = S.db.meta.family || {};
  openSheet(`<div class="ks-sheet">
    <div class="hd"><button class="back" data-act="back">‹</button><div style="flex:1"><p class="cap3">추천·방문 기록의 기준</p><b>가족 프로필</b></div></div>
    <form class="ks-body" id="fam-form">
      <label class="ks-field"><span class="cap">가족 이름 (쉼표로 · 순서대로 표시)</span><input name="names" value="${esc(familyNames().join(', '))}" placeholder="아빠, 엄마, 하준, 이준"></label>
      <div class="three">
        <label class="ks-field"><span class="cap">성인</span><input name="adults" type="number" min="0" value="${f.adults ?? 2}"></label>
        <label class="ks-field"><span class="cap">아이 나이</span><input name="kids" value="${esc((f.kids || []).join(', '))}" placeholder="9, 6"></label>
        <label class="ks-field"><span class="cap">어르신</span><input name="seniors" type="number" min="0" value="${f.seniors ?? 0}"></label></div>
      <label class="check"><input name="spicyOK" type="checkbox" ${f.spicyOK ? 'checked' : ''}> 매운 음식 OK</label>
      <label class="ks-field"><span class="cap">메모</span><input name="notes" value="${esc(f.notes || '')}" placeholder="예: 막내 해산물 알러지 없음, 좌식 선호"></label>
      <button type="submit" class="btn pri rw">저장</button>
    </form></div>`);
  const form = $('#fam-form');
  form.onsubmit = e => { e.preventDefault(); const d = Object.fromEntries(new FormData(form));
    S.db.meta.family = { ...f, names: d.names.split(/[,\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8), adults: +d.adults || 0, kids: d.kids.split(/[,\s]+/).map(Number).filter(n => n > 0 && n < 20), seniors: +d.seniors || 0, spicyOK: !!d.spicyOK, notes: d.notes.trim() };
    markDirty(); closeSheet(); toast('가족 프로필 저장'); renderSettings(); S.homeStale = true; };
  $('#sheet-inner').onclick = e => { if (e.target.closest('[data-act=back]')) { closeSheet(); renderSettings(); } };
}
function openTourApiInfo() {
  const spots = S.db.places.filter(p => p.type === 'spot'), withPhoto = spots.filter(p => p.basePhoto).length, noCoord = S.db.places.filter(p => !hasCoord(p)).length;
  openSheet(`<div class="ks-sheet">
    <div class="hd"><button class="back" data-act="back">‹</button><div style="flex:1"><p class="cap3">대표사진 · 좌표</p><b>한국관광공사 TourAPI</b></div></div>
    <div class="ks-body">
      <div class="grp" style="margin:0"><div><span style="flex:1">대표사진<p class="cap3">휴양지 기준 · photos/base</p></span><span class="num cap">${withPhoto}/${spots.length}</span></div><div><span style="flex:1">좌표 없는 장소<p class="cap3">국내는 카카오·TourAPI, 해외는 구글·OSM</p></span><span class="num cap">${noCoord}곳</span></div></div>
      <p class="cap ks-help">TourAPI 키는 앱에 넣지 않고 PC 명령줄에서만 사용 (사진·좌표 수집 후 저장소에 반영). PowerShell:</p>
      <pre class="ks-code">py tools\\tourapi_photos.py --key "서비스키"\npy tools\\tourapi_coords.py --key "서비스키"</pre>
      <div class="progress"><i id="geo-bar"></i></div>
      <button class="btn line rw" data-act="geoall">앱에서 좌표 일괄 수집 (카카오·OSM)</button>
    </div></div>`);
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'back') { closeSheet(); renderSettings(); } if (b.dataset.act === 'geoall') geocodeAll(b, $('#geo-bar')); };
}
function openTrash() {
  const T = S.db.trash || [];
  openSheet(`<div class="ks-sheet"><div class="hd"><button class="back" data-act="back">‹</button><div style="flex:1"><p class="cap3">30일 뒤 자동 비움</p><b>휴지통 ${T.length}</b></div></div>
    <div class="ks-body">${T.length ? `<div class="grp" style="margin:0">${T.slice().reverse().map(e => `<div><span style="flex:1"><b>${esc(e.name || e.id)}</b><p class="cap3">${{ place: '장소', trip: '여행', base: '거점' }[e.kind] || e.kind} · 삭제 ${esc(e.at || '')}</p></span><button class="st-edit rw" data-restore="${e.id}">복원</button></div>`).join('')}</div><button class="btn line rw" data-act="empty">휴지통 비우기</button>` : '<p class="cap" style="text-align:center;padding:30px 0">비어 있음</p>'}</div></div>`);
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'back') { closeSheet(); renderSettings(); }
    if (b.dataset.restore) { const r = trashRestore(b.dataset.restore); toast(r ? `복원: ${r.name}` : '복원 실패'); renderList(); openTrash(); }
    if (b.dataset.act === 'empty') { if (b.dataset.c) { S.db.trash = []; markDirty(); openTrash(); } else { b.dataset.c = 1; b.textContent = '정말 비우기? (다시 탭)'; } } };
}
function renderSettings() {
  const el = $('#settings');
  const fam = familyNames(), f = S.db.meta.family || {};
  const spots = S.db.places.filter(p => p.type === 'spot'), withPhoto = spots.filter(p => p.basePhoto).length;
  const kkJs = LS.get('kakaoJsMine', '') || S.db.meta.kakaoKey;
  const st = (on, onTxt = '연결됨', offTxt = '미입력') => on ? `<span class="ok">${onTxt}</span>` : `<span class="no">${offTxt}</span>`;
  const themeTxt = { auto: '시스템 따라', light: '라이트', dark: '다크' }[themePref()];
  const seasonTxt = seasonPref() === 'auto' ? `자동 · ${seasonNow()}` : seasonPref();
  const baseIco = b => b.country === 'KR' && /집/.test(b.name) ? '<span style="color:var(--pin);font-weight:900">⌂</span>' : '<span style="color:var(--primary-2);font-weight:900">▣</span>';
  const baseSub = b => (b.country === 'KR' ? '국내' : (REGION_LABEL[Object.keys(REGION_LABEL).find(r => regionCountry(r) === b.country)] || b.country)) + (b.default_for ? ' 기본' : '') + (b.note ? ' · ' + b.note : '');
  el.innerHTML = `
    <div class="st-hd"><b>설정</b>${S.token ? '<span class="ok">GitHub 연결됨</span>' : OFFLINE ? '<span class="cap3">오프라인 파일</span>' : '<span class="no" style="color:var(--warning)">읽기 전용</span>'}</div>
    <div class="gt">가족 프로필</div>
    <div class="grp"><button class="st-fam" data-act="family">${fam.map((n, i) => `<span class="fc" style="background:${FAM_COLORS[i % FAM_COLORS.length]}">${esc(n)}</span>`).join('')}<span class="cap st-more">${f.kids?.length ? `아이 ${f.kids.join('·')}세 · ` : ''}편집 ›</span></button></div>
    <div class="gt">거점</div>
    <div class="grp">${S.db.bases.map(b => `<button data-base="${b.id}">${baseIco(b)}<span class="st-name">${esc(b.name)}<span class="cap3"> · ${esc(baseSub(b))}</span></span>${S.base?.id === b.id ? '<span class="ok">사용 중</span>' : ''}<span class="st-edit rw" data-bedit="${b.id}">수정</span></button>`).join('')}<button class="st-add rw" data-act="baseadd">+ 거점 추가</button></div>
    <div class="gt">사진 · API 키</div>
    <div class="grp">
      <button data-key="tourapi"><span style="flex:1;text-align:left">한국관광공사 TourAPI<p class="cap3">대표사진 ${withPhoto}/${spots.length} · 키는 PC에서만</p></span>${st(withPhoto > 0, '수집됨', '미수집')}</button>
      <button data-key="kakaojs"><span style="flex:1;text-align:left">카카오 JavaScript 키<p class="cap3">지도 표시 · 장소 검색${LS.get('kakaoJsMine', '') ? ' · 개인 키' : S.db.meta.kakaoKey ? ' · 공용 키' : ''}</p></span>${st(!!kkJs, S.kakaoReady ? '연결됨' : '키 있음')}</button>
      <button data-key="krest"><span style="flex:1;text-align:left">카카오 REST 키<p class="cap3">길찾기 · 주변 후보 검색</p></span>${st(!!kakaoRestKey())}</button>
      <button data-key="gh"><span style="flex:1;text-align:left">GitHub 토큰<p class="cap3">가족 데이터 저장 · 없으면 읽기 전용</p></span>${st(!!S.token, S.sha ? '연결됨' : '확인 필요')}</button>
      <button data-key="google"><span style="flex:1;text-align:left">구글 Places 키<p class="cap3">해외 장소 검색 · 평점</p></span>${st(!!googleKey())}</button>
      <button data-act="season"><span style="flex:1;text-align:left">계절 메인 배경</span><span class="cap">${esc(seasonTxt)} ›</span></button></div>
    <div class="gt">데이터</div>
    <div class="grp">
      <button data-act="xlsx"><span style="flex:1;text-align:left">엑셀로 내보내기<p class="cap3">원본 양식 · 장소 ${S.db.places.length} · 여행 ${S.db.trips.length}</p></span><span class="cap num">.xlsx</span></button>
      <button data-act="export"><span style="flex:1;text-align:left">JSON 백업</span><span class="cap num">.json</span></button>
      <label class="st-import"><span style="flex:1;text-align:left">JSON 불러오기<p class="cap3">백업 파일로 전체 교체</p></span><span class="cap num">.json</span><input type="file" id="s-import" accept=".json" hidden></label>
      <button data-act="theme"><span style="flex:1;text-align:left">다크모드</span><span class="cap">${themeTxt} ›</span></button>
      <button data-act="trash"><span style="flex:1;text-align:left">휴지통<p class="cap3">삭제한 장소·여행 30일 보관 · 복원 가능</p></span><span class="cap num">${(S.db.trash || []).length}</span></button>
      <button data-act="naver"><span style="flex:1;text-align:left">네이버 전국 맛집 지도<p class="cap3">MY플레이스 리스트 링크 · 상세의 N저장✔ 연동</p></span><span class="cap">${S.db.meta.naverListUrl ? '열기 ›' : '미입력'}</span></button>
      ${OFFLINE ? '' : `<button data-act="reload"><span style="flex:1;text-align:left">다시 불러오기<p class="cap3">갱신 ${esc(S.db.meta.updated || '')}</p></span><span class="cap">↻</span></button>`}</div>
    <p class="cap3 st-foot">준준 TRIP · 키는 기기 브라우저에만 저장 · 데이터는 GitHub <span class="num">${esc(S.repo)}</span></p>`;
  el.onclick = async e => {
    const edit = e.target.closest('[data-bedit]'); if (edit) { e.stopPropagation(); openBaseForm(S.db.bases.find(x => x.id === edit.dataset.bedit)); return; }
    const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
    if (b.dataset.key) { b.dataset.key === 'tourapi' ? openTourApiInfo() : openKeySheet(b.dataset.key); return; }
    if (b.dataset.base) { setBase(b.dataset.base); renderSettings(); return; }
    if (act === 'family') openFamilyEdit();
    if (act === 'baseadd') openBaseForm();
    if (act === 'season') pickMenu(b, [['auto', `자동 (지금은 ${seasonNow()})`, seasonPref() === 'auto'], ...['봄', '여름', '가을', '겨울'].map(x => [x, x, seasonPref() === x])], v => { LS.set('season', v); S.homeStale = true; renderSettings(); });
    if (act === 'trash') openTrash();
    if (act === 'theme') pickMenu(b, [['auto', '시스템 따라', themePref() === 'auto'], ['light', '라이트', themePref() === 'light'], ['dark', '다크', themePref() === 'dark']], v => { LS.set('theme', v); applyTheme(); renderSettings(); });
    if (act === 'naver') { const v = prompt('네이버 MY플레이스 리스트 링크', S.db.meta.naverListUrl || ''); if (v == null) return; if (v.trim() && v.trim() === (S.db.meta.naverListUrl || '')) { window.open(v.trim(), '_blank', 'noopener'); return; } S.db.meta.naverListUrl = v.trim(); markDirty(); renderSettings(); }
    if (act === 'reload') { S.sha = null; await load(); boot(true); toast('다시 불러옴'); }
    if (act === 'xlsx') exportXlsx();
    if (act === 'export') { const blob = new Blob([JSON.stringify(S.db, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `foodtrip_${S.db.meta.updated || 'db'}.json`; a.click(); }
  };
  $('#s-import').onchange = async e => { const file = e.target.files[0]; if (!file) return; try { const j = JSON.parse(await file.text()); if (!j.places) throw new Error('형식 오류'); if (!confirm(`현재 데이터를 백업 파일(장소 ${j.places.length})로 교체할까요?`)) return; S.db = migrate(j); markDirty(); boot(true); toast('가져오기 완료'); } catch (err) { toast('가져오기 실패: ' + err.message); } };
}

/* ---------------- 우리 가족 기록 (블로그형 피드 · 시안 외 추가) ---------------- */
function visitPhotos(v) { return (v.photos && v.photos.length ? v.photos : v.photo ? [v.photo] : []).map(photoUrl).filter(Boolean); }
function openJournal(opts = {}) {
  const kind = opts.kind || 'all', who = opts.who || '';
  const t = opts.tripId && S.db.trips.find(x => x.id === opts.tripId);
  let ents = S.db.places.flatMap(p => (p.visitLog || []).map(v => ({ p, v })));
  if (opts.placeId) ents = ents.filter(e => e.p.id === opts.placeId);
  if (t) { const ids = new Set(t.items.map(i => i.place_id).filter(Boolean)); const { start, end } = tripDates(t);
    const iso = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : null; const a = iso(start), z = iso(end);
    ents = ents.filter(e => (a && z ? e.v.date >= a && e.v.date <= z : true) && (ids.has(e.p.id) || (a && z && e.p.region === (t.plan?.region || tripRegion(t))))); }
  if (kind !== 'all') ents = ents.filter(e => e.p.type === kind);
  if (who) ents = ents.filter(e => (e.v.who || []).includes(who));
  ents.sort((a, b) => (b.v.date || '').localeCompare(a.v.date || ''));
  const nPh = ents.reduce((n, e) => n + visitPhotos(e.v).length, 0);
  const title = opts.placeId ? placeById(opts.placeId)?.name + ' 기록' : t ? `${tripCity(t)} 여행기` : '우리 가족 기록';
  const dow = d => { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? '' : ` (${DAYS[x.getDay()]})`; };
  let lastM = '';
  const cards = ents.map((e, i) => { const { p, v } = e; const ph = visitPhotos(v); const m = (v.date || '').slice(0, 7);
    const head = m !== lastM ? `<h3 class="jr-month">${m ? `${m.slice(0, 4)}년 ${+m.slice(5, 7)}월` : '날짜 없음'}</h3>` : ''; lastM = m;
    return `${head}<article class="jr-card">${ph.length ? `<button class="jr-ph" data-lb="${i}" style="background-image:url('${ph[0]}')">${ph.length > 1 ? `<span class="n">1/${ph.length}</span>` : ''}<img class="stamp" src="${asset('assets/mark-stamp-white.png')}" alt=""></button>` : ''}
      <div class="jr-body"><button class="jr-place" data-go="${p.id}">${thumbHtml(p, 'tile')}<span><b>${esc(p.name)}</b><small>${esc([kindLabel(p), areaOf(p)].filter(Boolean).join(' · '))}</small></span><i>›</i></button>
        <p class="jr-meta"><span class="num">${esc((v.date || '').replace(/-/g, '.'))}</span>${esc(dow(v.date))}${v.meal ? ' · ' + esc(v.meal) : ''}${v.rating ? ` · <span class="st">${'★'.repeat(v.rating)}<span>${'★'.repeat(5 - v.rating)}</span></span>` : ''}</p>
        ${v.memo ? `<p class="jr-memo serif">“${esc(v.memo)}”</p>` : ''}
        ${(v.menu || []).length ? `<p class="jr-menu">${v.menu.map(x => `<span>${esc(typeof x === 'string' ? x : x.name || '')}</span>`).join('')}</p>` : ''}
        ${(v.who || []).length ? `<p class="jr-who">${v.who.map(n => `<span>${esc(n)}</span>`).join('')}</p>` : ''}</div></article>`; }).join('');
  const chip = (k, label, on) => `<button class="chip${on ? ' on' : ''}" ${k}>${label}</button>`;
  const noLog = opts.placeId || t || who ? [] : S.db.places.filter(p => (p.visits || 0) > 0 && !(p.visitLog || []).length && (kind === 'all' || p.type === kind)).sort((a, b) => (b.visits || 0) - (a.visits || 0));   // 다녀왔지만 아직 글·사진 없는 곳
  const noLogHtml = noLog.length ? `<h3 class="jr-month">다녀온 곳 · 아직 기록 없음 <small>${noLog.length}</small></h3><div class="jr-nolog">${noLog.map(p => `<div class="row-nl">${thumbHtml(p, 'tile')}<button class="jr-place" data-go="${p.id}"><span><b>${esc(p.name)}</b><small>${esc([kindLabel(p), areaOf(p), `방문 ${p.visits}회`].join(' · '))}</small></span></button><button class="chip rw" data-addlog="${p.id}">+ 기록</button></div>`).join('')}</div>` : '';
  openSheet(`<div class="jr-sheet"><div class="hd"><button class="back" data-act="back">‹</button><div style="flex:1;min-width:0"><p class="cap3">방문 ${ents.length} · 사진 ${nPh}</p><b>${esc(title)}</b></div>${t || opts.placeId ? '' : `<button class="chip" data-act="share">공유</button>`}</div>
    ${opts.placeId ? '' : `<div class="jr-chips">${chip('data-kind="all"', '전체', kind === 'all')}${chip('data-kind="spot"', '휴양지', kind === 'spot')}${chip('data-kind="restaurant"', '식당', kind === 'restaurant')}${chip('data-kind="mine"', '우리 장소', kind === 'mine')}<span class="sep"></span>${familyNames().map(n => chip(`data-who="${esc(n)}"`, esc(n), who === n)).join('')}</div>`}
    <div class="jr-feed">${cards}${noLogHtml}${cards || noLogHtml ? '' : `<div class="empty11"><img src="${asset('assets/mark-stamp.png')}" alt=""><b>아직 기록이 없어요</b><p class="cap">장소 상세 › 「다녀왔어요 · 기록 남기기」로 사진과 한줄평을 남기면 여기에 쌓입니다</p></div>`}</div></div>`);
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'back') { opts.placeId ? openDetail(opts.placeId) : closeSheet(); return; }
    if (b.dataset.kind) return openJournal({ ...opts, kind: b.dataset.kind });
    if (b.dataset.who != null) return openJournal({ ...opts, who: who === b.dataset.who ? '' : b.dataset.who });
    if (b.dataset.go) return openDetail(b.dataset.go);
    if (b.dataset.addlog) return openVisitForm(placeById(b.dataset.addlog));
    if (b.dataset.lb != null) { const en = ents[+b.dataset.lb]; return openLightbox(visitPhotos(en.v), 0, `${en.p.name} · ${(en.v.date || '').replace(/-/g, '.')}`); }
    if (b.dataset.act === 'share') shareLink('j', 'all', '우리 가족 기록');
  };
}
function openLightbox(srcs, i = 0, cap = '') {                    // 사진 크게 보기 (좌우 넘김 · 스와이프)
  document.getElementById('lb')?.remove(); if (!srcs.length) return;
  const el = document.createElement('div'); el.id = 'lb'; el.className = 'lb'; document.body.appendChild(el);
  const draw = () => { el.innerHTML = `<img src="${srcs[i]}" alt=""><button class="x" data-lbx="1">✕</button>${srcs.length > 1 ? `<button class="pv" data-lbp="-1">‹</button><button class="nx" data-lbp="1">›</button>` : ''}<p class="cap">${esc(cap)}${srcs.length > 1 ? ` · ${i + 1}/${srcs.length}` : ''}</p>`; };
  draw();
  el.onclick = e => { const b = e.target.closest('button'); if (!b) { if (e.target === el) el.remove(); return; } if (b.dataset.lbx) el.remove(); if (b.dataset.lbp) { i = (i + +b.dataset.lbp + srcs.length) % srcs.length; draw(); } };
  let x0 = null; el.ontouchstart = e => { x0 = e.touches[0].clientX; }; el.ontouchend = e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50 && srcs.length > 1) { i = (i + (dx < 0 ? 1 : -1) + srcs.length) % srcs.length; draw(); } x0 = null; };
  document.addEventListener('keydown', function k(ev) { if (!document.getElementById('lb')) return document.removeEventListener('keydown', k); if (ev.key === 'Escape') el.remove(); if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { i = (i + (ev.key === 'ArrowRight' ? 1 : -1) + srcs.length) % srcs.length; draw(); } });
}

/* ---------------- 뷰 전환 ---------------- */
function showView(v) {
  const sheetState = v === 'map' ? 'peek' : v === 'list' ? '' : null;
  if (v === 'map' || v === 'list') v = 'explore';
  S.view = v;
  $$('#tabs button, #mobile-nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  const pages = { home: '#view-home', explore: '#main', trips: '#view-trips', settings: '#view-settings' };
  for (const [k, sel] of Object.entries(pages)) $(sel).classList.toggle('on', k === v);
  document.body.classList.toggle('at-home', v === 'home'); document.body.classList.toggle('at-explore', v === 'explore'); document.body.classList.toggle('at-trips', v === 'trips'); document.body.classList.toggle('at-settings', v === 'settings');
  if (v === 'explore') { setTimeout(() => map.invalidateSize(), 60); if (sheetState != null && $('#panel').setSheet) $('#panel').setSheet(sheetState); }
  if (v === 'home') { renderHome(); S.homeStale = false; } else fitPcHero();
  if (v === 'trips') renderTrips();
  if (v === 'settings') renderSettings();
  $(pages[v]).scrollTop = 0;
}

/* ---------------- 부트 ---------------- */
function bindOnce() {
  $('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); };
  $('#mobile-nav').onclick = e => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); };
  $('#base-btn').onclick = e => { e.stopPropagation(); baseMenu(e.currentTarget); };
  $('#base-chip').onclick = e => { e.stopPropagation(); baseMenu(e.currentTarget); };
  $('#q-pc').oninput = $('#q-hdr').oninput = e => { S.q = e.target.value; $('#q').value = S.q; renderList(); if (S.view !== 'explore' && S.q) showView('explore'); };
  $('#region-dd').onclick = e => { e.stopPropagation(); pickMenu(e.currentTarget, [...regionsInDb().map(([r, n]) => [r, `${REGION_LABEL[r] || r} <small>${n}</small>`, S.region === r]), ['all', '전체 지역', S.region === 'all']], v => { S.region = v; LS.set('region', v); renderRegionChips(); renderTagChips(); const base = S.db.bases.find(x => x.default_for === v); if (base) setBase(base.id, true); renderList(); fitToVisible(); }); };
  $('#season-dd').onclick = e => { e.stopPropagation(); pickMenu(e.currentTarget, [...['봄', '여름', '가을', '겨울'].map(x => [x, x, S.flags.has(x)]), ['', '계절 무관', !['봄', '여름', '가을', '겨울'].some(x => S.flags.has(x))]], v => { ['봄', '여름', '가을', '겨울'].forEach(x => S.flags.delete(x)); if (v) S.flags.add(v); renderRegionChips(); renderList(); }); };
  const setKm = km => { S.radius = S.radius === km ? null : km; LS.set('radius', S.radius); $$('#km-pills button').forEach(b => b.classList.toggle('on', S.radius != null && +b.dataset.km <= S.radius)); $('#fab-km').textContent = S.radius ? S.radius + 'km' : 'km'; $('#fab-km').classList.toggle('on', !!S.radius); renderList(); };
  $('#km-pills').onclick = e => { const b = e.target.closest('button'); if (b) setKm(+b.dataset.km); };
  $('#fab-km').onclick = () => { const seq = [10, 30, 60, null]; const i = seq.indexOf(S.radius ?? null); S.radius = seq[(i + 1) % seq.length]; setKm(S.radius); S.radius = seq[(i + 1) % seq.length]; LS.set('radius', S.radius); $$('#km-pills button').forEach(b => b.classList.toggle('on', S.radius != null && +b.dataset.km <= S.radius)); $('#fab-km').textContent = S.radius ? S.radius + 'km' : 'km'; $('#fab-km').classList.toggle('on', !!S.radius); renderList(); };
  $('#fab-loc').onclick = () => { if (!navigator.geolocation) return toast('위치 사용 불가'); navigator.geolocation.getCurrentPosition(pos => { map.setView([pos.coords.latitude, pos.coords.longitude], 13); toast('내 위치로 이동'); }, () => toast('위치 권한 필요')); };
  $('#brand-btn').onclick = () => showView('home');
  initSheetDrag();
  document.addEventListener('click', e => {                     // 11d: 읽기 전용에서 잠긴 버튼 → 설정 › GitHub 토큰
    if (e.target.closest('[data-act=ro-token]')) { e.stopPropagation(); e.preventDefault(); goToken(); return; }
    if (!isRO()) return; const b = e.target.closest('.rw, .rw-chips .chip'); if (!b) return;
    e.stopPropagation(); e.preventDefault(); toast('읽기 전용 — GitHub 토큰을 넣으면 기록·저장 가능'); goToken();
  }, true);
  $('#add-btn').onclick = () => openPlaceForm(); $('#fab-add').onclick = () => openPlaceForm();
  $('#today-btn').onclick = () => todayPick();
  $('#q').oninput = e => { S.q = e.target.value; renderList(); if (S.view !== 'explore' && S.q) showView('explore'); };
  $('#sort').onchange = e => { S.sort = e.target.value; LS.set('sort', S.sort); renderList(); };
  $('#f-scope').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.scope = b.dataset.v; $$('#f-scope button').forEach(x => x.classList.toggle('on', x === b)); renderTagChips(); renderList(); };
  $('#f-tags').onclick = e => { const b = e.target.closest('button'); if (!b) return; e.stopPropagation(); if (b.dataset.more) { S.tagsMore = !S.tagsMore; renderTagChips(); return; } const v = b.dataset.v; S.tags.has(v) ? S.tags.delete(v) : S.tags.add(v); renderTagChips(); renderList(); };
  $('#count-sub').onclick = () => { const seq = ['dist', 'rating', 'reviews', 'name']; S.sort = seq[(seq.indexOf(S.sort) + 1) % seq.length]; $('#sort').value = S.sort; LS.set('sort', S.sort); renderList(); };
  $('#f-region').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.region = b.dataset.v; LS.set('region', S.region); renderRegionChips(); renderTagChips(); const base = S.db.bases.find(x => x.default_for === S.region); if (base) setBase(base.id, true); renderList(); fitToVisible(); };
  $('#f-season').onclick = e => { const b = e.target.closest('button[data-v]'); if (!b || b.closest('#f-tags')) return; const v = b.dataset.v; S.flags.has(v) ? S.flags.delete(v) : S.flags.add(v); b.classList.toggle('on'); renderList(); };
  $('#list').onclick = e => { const eb = e.target.closest('.empty11 button'); if (eb) return emptyAct(eb.dataset.act); const r = e.target.closest('.row'); if (!r) return; const p = placeById(r.dataset.id); if (window.innerWidth > 860 && hasCoord(p)) { map.setView([p.lat, p.lng], Math.max(map.getZoom(), 12)); selectOnMap(r.dataset.id); } else openDetail(r.dataset.id); };
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') closeSheet(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeSheet(); closeMenu(); } });
  window.addEventListener('resize', () => { map.invalidateSize(); { const m = window.innerWidth <= 860 ? 'phone' : 'pc'; if (S.view === 'home' && m !== S.homeMode) renderHome(); else fitPcHero(); } });
  window.addEventListener('hashchange', handleHash);
}
function boot(re) {
  S.sort = LS.get('sort', 'dist'); $('#sort').value = S.sort;
  S.radius = LS.get('radius', null); $$('#km-pills button').forEach(b => b.classList.toggle('on', S.radius != null && +b.dataset.km <= S.radius)); $('#fab-km').textContent = S.radius ? S.radius + 'km' : 'km';
  S.region = LS.get('region', 'domestic'); if (S.region !== 'all' && !S.db.places.some(p => p.region === S.region)) S.region = 'all';
  renderRegionChips(); renderTagChips();
  setBase(LS.get('base') || S.db.bases.find(b => b.default_for === S.region)?.id, true);
  renderList();
  if (!re) { fitToVisible(); showView(location.hash ? 'explore' : 'home'); }
  else { renderHome(); renderTrips(); renderSettings(); }
  if ((S.db.meta.kakaoKey || LS.get('kakaoJsMine', '')) && !OFFLINE) loadKakao(true);
  applyReadOnly();
  if (!re) handleHash();
}
(async function main() {
  applyTheme(); initMap(); bindOnce(); matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  window.JJ = { S, get map() { return map; } };   // 콘솔 디버그용
  await load();
  boot(false);
})();
})();
