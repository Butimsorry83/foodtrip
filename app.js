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
  try { const old = JSON.parse(localStorage.getItem('ft.ovCities') || '[]'); if (old.length) { db.meta.ovCities = [...(db.meta.ovCities || []), ...old.filter(o => !(db.meta.ovCities || []).some(c => c.cc === o.cc && c.name === o.name))]; localStorage.removeItem('ft.ovCities'); S.migratedCities = true; } } catch {}   // 기기에만 있던 해외 도시 → db.json
  db.meta.family ||= { adults: 2, kids: [], seniors: 0, spicyOK: false, notes: '' };
  db.lived ||= []; db.growth ||= [];   // 살았던 곳 · 성장 앨범
  for (const p of db.places) { p.tags ||= []; p.visitLog ||= []; p.visits ||= 0; if (p.wish == null) p.wish = false; p.visitLog.forEach((v, i) => { v.id ||= `v_${p.id}_${v.date || ''}_${i}`; }); }   // 기록마다 고정 id (앨범·편집용)
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
  if ((trashPurge() > 0 || S.migratedCities) && S.token) { S.migratedCities = false; markDirty(); }
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
  for (const k of ['places', 'trips', 'bases', 'lived', 'growth']) out[k] = mergeList(base?.[k] || [], mine[k] || [], theirs[k] || []);   // lived: 살았던 곳 · growth: 성장 앨범
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
        <label>국가<select name="country">${countryOptions(b.country || 'KR')}</select></label>
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
      const hay = [p.name, p.si, p.do, p.zone, p.address, p.desc, p.pros, p.cons, p.signature, p.note, p.spot_name, ...cuisineOf(p), ...(p.tags || []), p.country && p.country !== 'KR' ? `${ccKo(p.country)} ${regionEn(p.country)}` : ''].join(' ').toLowerCase();
      if (!hay.includes(q) && !q.split(/\s+/).filter(Boolean).every(w => hay.includes(w))) return false;   // 「italy firenze」처럼 단어 순서·나라 이름도 찾기
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
    <div class="acts">${n ? '<button class="btn line" data-act="clear">필터 모두 풀기</button>' : ''}${S.radius ? `<button class="btn line" data-act="km">${nextKm ? `반경 ${S.radius}km → ${nextKm}km` : '반경 제한 해제'}</button>` : ''}${S.region !== 'all' ? '<button class="btn line" data-act="allregion">전체 지역에서 찾기</button>' : ''}<button class="btn kakao rw" data-act="newplace">${/[A-Za-z]{3,}/.test(q) ? '🌍 전 세계에서 새로 찾기' : (S.region === 'all' || regionCountry(S.region) === 'KR') ? '카카오에서 새로 찾기' : '구글에서 새로 찾기'}</button></div></div>`;
}
function emptyAct(act) {
  if (act === 'clear') { S.flags.clear(); S.tags.clear(); S.scope = 'all'; $$('#f-scope button').forEach(x => x.classList.toggle('on', x.dataset.v === 'all')); renderRegionChips(); renderTagChips(); renderList(); }
  if (act === 'km') { const nextKm = ({ 10: 30, 30: 60, 60: null })[S.radius] ?? null; S.radius = nextKm; LS.set('radius', S.radius); $$('#km-pills button').forEach(b => b.classList.toggle('on', S.radius != null && +b.dataset.km <= S.radius)); $('#fab-km').textContent = S.radius ? S.radius + 'km' : 'km'; $('#fab-km').classList.toggle('on', !!S.radius); renderList(); }
  if (act === 'allregion') { S.region = 'all'; LS.set('region', 'all'); renderRegionChips(); renderTagChips(); renderList(); fitToVisible(); }
  if (act === 'newplace') { const foreign = /[A-Za-z]{3,}/.test(S.q); const p = { id: uid(), type: foreign ? 'spot' : 'restaurant', country: foreign ? 'OTHER' : S.region === 'domestic' || S.region === 'all' ? 'KR' : regionCountry(S.region), region: S.region === 'all' ? 'domestic' : S.region, name: S.q.trim(), cuisine: [], seasons: [], rating: 0, visits: 0, naver: {}, kakao: {}, tags: [], visitLog: [] }; openPlaceForm(p); if (p.name) setTimeout(() => $('#pf [data-act=psearch]')?.click(), 50); }
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
function openSheet(html) { S.sheetDirty = false; const s = $('#sheet'); $('#sheet-inner').innerHTML = html; s.hidden = false; $('#sheet-inner').scrollTop = 0; const sc = $('#sheet-inner .sheet-scroll'); if (sc) sc.scrollTop = 0; }
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
        <div class="stat3"><div><small>${esc(baseShort(p))}에서</small><b>${di ? fmtKm(di.km) + '<small>km</small>' : '—'}</b></div><div><small>${di?.fly ? '비행 약' : '차로'}</small><b>${di ? minText(di.min).replace(/(\d+)(시간|분)/g, '$1<small>$2</small>') : '—'}</b></div><div><small>${isMine(p) ? '분류' : '오늘'}</small><b>${isMine(p) ? `<small>${esc((p.tags || [])[0] || '우리 장소')}</small>` : todayHrs ? `<span class="mono" style="font-size:18px">${esc(todayHrs)}</span><small> ${os === 'dayoff' ? '' : os === 'open' ? '영업중' : '오픈'}</small>` : '<small>영업 미입력</small>'}</b></div></div>
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
        return `<div class="v${ri ? ' old' : ''}"><span class="dot"></span><div class="vh"><b class="mono">${esc((v.date || '').replace(/-/g, '.'))}</b><span class="st">${starsTxt(v.rating)}</span><button class="mini rw" data-vedit="${i}" title="편집">편집</button><button class="mini ghost rw" data-vdel="${i}" title="삭제">✕</button></div>${v.memo ? `<p>${esc(v.memo)}</p>` : ''}${(() => { const ph = visitPhotos(v); return ph.length ? `<div class="vstrip${ph.length === 1 ? ' one' : ''}">${ph.map((u, k) => `<button type="button" data-vlb="${i}" data-k="${k}"><img src="${u}" alt="" loading="lazy">${ph.length > 1 && k === 0 ? `<span>${ph.length}장</span>` : ''}</button>`).join('')}</div>` : ''; })()}${!ri ? `<img class="stamp" src="${asset('assets/mark-stamp.png')}" alt="">` : ''}</div>`; }).join('')}</div>`
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
    const vlb = e.target.closest('[data-vlb]'); if (vlb) { const v = p.visitLog[+vlb.dataset.vlb]; openLightbox(visitPhotos(v), +vlb.dataset.k, `${p.name} · ${(v.date || '').replace(/-/g, '.')}`, { raws: visitRaw(v), date: v.date }); return; }
    const vedit = e.target.closest('[data-vedit]'); if (vedit) { openVisitForm(p, p.visitLog[+vedit.dataset.vedit]); return; }
    const vdel = e.target.closest('[data-vdel]');
    if (vdel) { if (vdel.dataset.confirm) { p.visitLog.splice(+vdel.dataset.vdel, 1); p.visits = Math.max(0, (p.visits || 1) - 1); markDirty(); openDetail(id); } else { vdel.dataset.confirm = 1; vdel.textContent = '삭제?'; } return; }
    const pin = e.target.closest('[data-pin]');
    if (pin) { const l = found[+pin.dataset.pin]; p.parking ||= { type: '미확인' }; p.parking.lots ||= []; if (!p.parking.lots.some(x => x.name === l.name)) p.parking.lots.push(l); p.parking.lots = p.parking.lots.slice(-3); if (!p.parking.type || p.parking.type === '미확인') p.parking.type = l.public ? '공영' : '민영유료'; markDirty(); openDetail(id); toast('주차장 저장'); return; }
    const unpin = e.target.closest('[data-unpin]');
    if (unpin) { p.parking.lots.splice(+unpin.dataset.unpin, 1); markDirty(); openDetail(id); return; }
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'close') { if (S.returnTo) { const f = S.returnTo; S.returnTo = null; return f(); } return closeSheet(); }   // 플래너에서 열었으면 플래너로 복귀
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
function openVisitForm(p, edit, back) {                          // 시안 07: 방문 기록 · 내 사진 올리기 (edit = 기존 기록 편집)
  const di = distInfo(p); const mealNow = (() => { const h = new Date().getHours(); return h < 11 ? '아침' : h < 15 ? '점심' : h < 17 ? '간식' : '저녁'; })();
  const st = edit ? { photos: (edit.photos?.length ? edit.photos : edit.photo ? [edit.photo] : []).map(path => ({ path, url: photoUrl(path) })), rating: edit.rating || 0, who: new Set(edit.who || []), menu: (edit.menu || []).map(m => typeof m === 'string' ? m : m.name || '') } : { photos: [], rating: 0, who: new Set(familyNames()), menu: [] };
  const d0 = edit?.date || today();
  const dateTxt = iso => { const d = new Date(iso + 'T00:00:00'); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} (${DAYS[d.getDay()]})`; };
  openSheet(`<div class="vf-sheet">
    <div class="hd"><button class="lnk" data-act="back">취소</button><b>${edit ? '기록 편집' : '방문 기록'}</b><button class="lnk pri" data-act="save">저장</button></div>
    <div class="vf-scroll">
      <div class="vf-place">${thumbHtml(p, 'tile')}<div style="flex:1;min-width:0"><b>${esc(p.name)}</b><p class="cap">${esc(areaOf(p))}${di ? ` · ${fmtKm(di.km)}km` : ''}</p></div></div>
      <div class="vsec"><h4>사진 <span class="cap3">장수 제한 없음 · 첫 장이 표지</span></h4><div class="vgrid" id="vgrid"></div><p class="cap3" style="margin-top:8px">기기에서 1280px로 줄여 저장 · 원본은 올리지 않음${S.token || OFFLINE ? '' : ' · <b>GitHub 토큰 없으면 사진은 이 기기에만 남음</b>'}</p><input type="file" id="vfile" accept="image/*" multiple hidden></div>
      <div class="vsec"><h4>날짜</h4><label class="field vdate-f"><input type="date" id="vdate" class="num" value="${d0}" max="${today()}"><span class="cap" id="vdate-txt">${dateTxt(d0).slice(-3)}</span><select id="vmeal" class="cap" style="margin-left:auto">${['아침', '점심', '간식', '저녁', '야식'].map(m => `<option${m === (edit?.meal || mealNow) ? ' selected' : ''}>${m}</option>`).join('')}</select></label></div>
      <div class="vsec"><h4>함께 간 사람</h4><div class="chips" id="vwho">${[...new Set([...familyNames(), ...st.who])].map(n => `<button type="button" class="chip${st.who.has(n) ? ' on' : ''}" data-who="${esc(n)}">${esc(n)}</button>`).join('')}<button type="button" class="chip" data-who="+">+ 손님</button></div></div>
      <div class="vsec"><h4>별점</h4><div class="vstars" id="vstars">${[1, 2, 3, 4, 5].map(n => `<span data-r="${n}">★</span>`).join('')}<span class="num val" id="vval">—</span></div></div>
      <div class="vsec"><h4>한줄평</h4><textarea id="vmemo" class="vmemo" placeholder="예: 하준이가 순두부 국물까지 다 마심">${esc(edit?.memo || '')}</textarea></div>
      <div class="vsec"><h4>여행기 본문 <span class="cap3">선택 · 클로드로 다듬은 글을 붙여넣기</span></h4><textarea id="vstory" class="vmemo vstory" placeholder="길게 남기고 싶은 이야기. 「여행기 글 만들기」로 재료를 복사해 클로드에 붙이면 글을 다듬어 줍니다">${esc(edit?.story || '')}</textarea>${edit ? '<button type="button" class="chip" data-act="storykit" style="margin-top:8px">✎ 여행기 글 만들기 (재료 복사)</button>' : ''}</div>
      <div class="vsec"><h4>먹은 메뉴</h4><div class="chips" id="vmenu"><button type="button" class="chip" data-menu="+">+ 메뉴</button></div></div>
      <div style="height:20px"></div></div>
    <div class="vf-foot">${edit ? '<button class="btn-line" data-act="vdelete" style="flex:0 0 auto;padding:0 16px;color:var(--danger)">기록 삭제</button>' : ''}<button class="btn-pri" data-act="save">${edit ? '수정 저장' : '기록 저장하고 스탬프 찍기'}</button></div></div>`);
  const sheet = $('#sheet-inner');
  const drawPhotos = () => { $('#vgrid').innerHTML = st.photos.map((ph, i) => `<div class="vph" style="background-image:url('${ph.url}')">${i === 0 ? '<span class="cv">표지</span>' : ''}<button type="button" class="x" data-rm="${i}">✕</button></div>`).join('') + (true ? '<button type="button" class="vph add" data-act="addphoto"><b>+</b>사진 추가</button>' : ''); };
  const drawMenu = () => { $('#vmenu').innerHTML = st.menu.map((m, i) => `<button type="button" class="chip soft" data-rmmenu="${i}">${esc(m)} ✕</button>`).join('') + '<button type="button" class="chip" data-menu="+">+ 메뉴</button>'; };
  drawPhotos(); drawMenu(); if (st.rating) { $$('#vstars [data-r]').forEach(x => x.classList.toggle('on', +x.dataset.r <= st.rating)); $('#vval').textContent = st.rating.toFixed(1); }
  $('#vdate').onchange = e => { $('#vdate-txt').textContent = dateTxt(e.target.value || today()).slice(-3); };   // 요일 표시
  $('#vdate').onclick = e => { try { e.target.showPicker(); } catch {} };   // 칸 어디를 눌러도 달력 열기 (지난 날짜 선택)
  $('#vfile').onchange = async e => { const fs = [...e.target.files]; let k = 0; for (const f of fs) { k++; if (fs.length > 3) $('#vgrid').dataset.busy = `사진 줄이는 중 ${k}/${fs.length}`; try { const b64 = await resizeImage(f); st.photos.push({ b64, url: 'data:image/jpeg;base64,' + b64 }); } catch { toast('사진을 읽지 못했습니다'); } } delete $('#vgrid').dataset.busy; drawPhotos(); e.target.value = ''; };
  sheet.onclick = async e => {
    const b = e.target.closest('button, [data-r]'); if (!b) return;
    if (b.dataset.act === 'back') return back ? back() : openDetail(p.id);
    if (b.dataset.act === 'vdelete') { if (!b.dataset.c) { b.dataset.c = 1; b.textContent = '정말 삭제?'; return; } p.visitLog = (p.visitLog || []).filter(v => v !== edit); p.visits = Math.max(0, (p.visits || 1) - 1); markDirty(); toast('기록 삭제'); return back ? back() : openDetail(p.id); }
    if (b.dataset.act === 'addphoto') return $('#vfile').click();
    if (b.dataset.act === 'storykit') return copyStoryKit([{ p, v: { ...edit, memo: $('#vmemo').value.trim() || edit.memo, rating: st.rating || edit.rating, who: [...st.who], menu: st.menu } }]);
    if (b.dataset.rm != null) { st.photos.splice(+b.dataset.rm, 1); drawPhotos(); return; }
    if (b.dataset.r) { st.rating = +b.dataset.r; $$('#vstars [data-r]').forEach(x => x.classList.toggle('on', +x.dataset.r <= st.rating)); $('#vval').textContent = st.rating.toFixed(1); return; }
    if (b.dataset.who) { if (b.dataset.who === '+') { const n = prompt('함께 간 사람 이름'); if (n && n.trim()) { st.who.add(n.trim()); b.insertAdjacentHTML('beforebegin', `<button type="button" class="chip on" data-who="${esc(n.trim())}">${esc(n.trim())}</button>`); } return; } st.who.has(b.dataset.who) ? st.who.delete(b.dataset.who) : st.who.add(b.dataset.who); b.classList.toggle('on'); return; }
    if (b.dataset.menu === '+') { const m = prompt('먹은 메뉴'); if (m && m.trim()) { st.menu.push(m.trim()); drawMenu(); } return; }
    if (b.dataset.rmmenu != null) { st.menu.splice(+b.dataset.rmmenu, 1); drawMenu(); return; }
    if (b.dataset.act === 'save') {
      $$('[data-act=save]').forEach(x => { x.disabled = true; }); $('.vf-foot .btn-pri').textContent = '저장 중…';
      const entry = { date: $('#vdate').value || today(), meal: $('#vmeal').value, rating: st.rating || null, memo: $('#vmemo').value.trim() || null, story: $('#vstory').value.trim() || null, who: [...st.who], menu: st.menu.slice(), photo: null, photos: [] };
      const nNew = st.photos.filter(ph => !ph.path).length; let nUp = 0;
      for (const [i, ph] of st.photos.entries()) {
        if (ph.path) { entry.photos.push(ph.path); continue; }
        nUp++; if (nNew > 1) $('.vf-foot .btn-pri').textContent = `사진 올리는 중 ${nUp}/${nNew}`;        // 편집: 이미 올린 사진은 그대로
        let stored = null;
        if (S.token && !OFFLINE) { try { stored = await ghPutFile(`photos/${p.id}/${entry.date}_${Date.now().toString(36)}_${i}.jpg`, ph.b64, `jjtrip: photo ${p.name}`); } catch (err) { toast('사진 업로드 실패: ' + err.message, 3500); } }
        if (!stored) { const local = LS.get('photos', {}); const key = `local:${p.id}:${Date.now().toString(36)}${i}`; local[key] = ph.url; try { LS.set('photos', local); stored = key; } catch { toast('이 기기 저장 공간 부족 — 사진 생략'); } }
        if (stored) entry.photos.push(stored);
      }
      entry.photo = entry.photos[0] || null;
      if (edit) { Object.assign(edit, entry); p.visitLog.sort((a, b) => (a.date || '').localeCompare(b.date || '')); markDirty(); toast('기록 수정'); return back ? back() : openDetail(p.id); }
      p.visitLog ||= []; entry.id ||= uid('v'); p.visitLog.push(entry); p.visits = (p.visits || 0) + 1;
      markDirty(); renderList(); openDetail(p.id); toast('기록 저장 · 스탬프 찍힘'); stampFx();
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
  { const off = offSeason(sp, ctx.season); if (off) { s -= 40; reasons.push([-40, off]); } }   // 11월 야외 수영장 등 제외
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
const SUMMER_ONLY_RE = /워터파크|워터월드|워터랜드|물놀이|수영장|해수욕장|캐리비안|캘리포니아비치|비치$|아쿠아월드|아쿠아필드|래프팅|수상레저/;   // 야외 물놀이 = 여름만
const WINTER_ONLY_RE = /스키|눈썰매|썰매장|얼음|빙어|스케이트장/;
function offSeason(p, season) {                                   // 계절 안 맞는 곳 (직접 넣은 계절이 우선, 실내·온천은 예외)
  if (!season || (p.seasons || []).includes(season)) return '';
  const t = [p.name, p.cat, p.category, p.desc, ...(p.tags || [])].filter(Boolean).join(' ');
  if (/실내|스파|온천|아쿠아리움|사우나/.test(t)) return '';
  if (season !== '여름' && SUMMER_ONLY_RE.test(t)) return '여름 전용';
  if (season !== '겨울' && WINTER_ONLY_RE.test(t)) return '겨울 전용';
  return '';
}
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
const NOMEAL_RE = /패스트푸드|햄버거|버거|롯데리아|맥도날드|맘스터치|버거킹|KFC|서브웨이|프랭크버거|노브랜드|카페|커피|제과|베이커리|도넛|디저트|아이스크림|빙수|편의점|간식|떡,한과/i;   // 여행 식사로 부적합 (점심·저녁 공통)
const NODINNER_RE = /피자|치킨|분식|김밥|토스트|샌드위치|햄버거|버거|양식|파스타|브런치|핫도그|도미노|피자헛|파파존스|떡볶이/i;   // 저녁 제외
const catShort = cat => (cat || '').split('>').map(x => x.trim()).filter(x => x && x !== '음식점').slice(-2).join(' › ');   // 카카오 세부 분류 (예: 해물,생선 › 게,대게)
const mealOK = (c, slot) => { const t = (c.name || '') + ' ' + (c.category || '') + ' ' + (c.cuisine || ''); return !NOMEAL_RE.test(t) && !(/dinner/.test(slot || '') && NODINNER_RE.test(t)); };
async function gRate(c) {                                        // 카카오 후보에 구글 평점·리뷰 수 붙이기 (기기 캐시 30일, 키 있을 때만)
  if (!googleKey() || !hasCoord(c)) return c;
  const cache = LS.get('gRate', {}), k = c.name.replace(/\s/g, '') + '@' + (+c.lat).toFixed(3) + ',' + (+c.lng).toFixed(3), hit = cache[k];
  if (hit && Date.now() - hit.t < 30 * 864e5) { if (hit.r) c.google = { rating: hit.r, reviews: hit.n, url: hit.u }; return c; }
  try { const res = await gPlaces('searchText', { textQuery: c.name, maxResultCount: 3, locationBias: { circle: { center: { latitude: +c.lat, longitude: +c.lng }, radius: 500 } } });
    const g = (res || []).map(x => gHit(x)).find(x => x.lat != null && haversine(c, x) < 0.4);
    cache[k] = g && g.rating ? { r: g.rating, n: g.reviews || 0, u: g.url, t: Date.now() } : { t: Date.now() }; LS.set('gRate', cache);
    if (g && g.rating) c.google = { rating: g.rating, reviews: g.reviews || 0, url: g.url };
  } catch (e) { console.warn(e); }
  return c;
}
const rateBonus = c => { const g = c.google; if (!g || !g.rating) return 0; const n = g.reviews || 0; return (g.rating - 4) * (n >= 30 ? 20 : 8) + Math.min(12, Math.log10(n + 1) * 4); };
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
  }).filter(x => ctx.mode !== 'plan' || mealOK(x.candidate)).sort((a, b) => b.score - a.score).slice(0, ctx.mode === 'plan' ? 12 : 8);
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
  return { kind: 'meal', slot, near, cand: c, place: c.name, note: [`${c.src || '카카오'} 추천`, catShort(c.category) || c.cuisine, c.google?.rating ? `구글 ★${c.google.rating} (${(c.google.reviews || 0).toLocaleString()})` : '', c.km != null ? fmtKm(c.km) + 'km' : ''].filter(Boolean).join(' · ') };
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
      const bf = ((base.country !== 'KR' || cfg.lodging === 'stay') && cfg.breakfast && di > 0) ? 50 : 0;
      const avail = (stayMode ? 18 * 60 + 30 : dayEndMin) - cfg.startMin - bf;                 // 숙박일은 저녁(18시) 전, 귀가일은 복귀 시각까지
      const fits = l => { if (!l.length) return true; const o = bestOrder(S0, l, E0); return l.reduce((s, x) => s + stayOf(x), 0) + routeCost(S0, o, E0) + 75 <= avail; };
      let k = Math.min(cfg.maxSpots, pool.length > cfg.maxSpots * (cfg.days - di - 1) ? cfg.maxSpots : Math.ceil(pool.length / (cfg.days - di)), pool.length);
      todays = bestSubset(S0, pool, k, E0);
      while (k > 1 && !fits(todays)) { k--; todays = bestSubset(S0, pool, k, E0); }   // 시간 안에 들어가는 만큼만
      if (cfg.autoFill && todays.length < cfg.maxSpots && extra.length) {   // 하루 최대까지 같은 지역에서 동선상 가장 싸게 끼워 넣을 수 있는 곳 보충 (시간 허락하는 만큼)
        while (todays.length < cfg.maxSpots && extra.length) { let bi = -1, bc = Infinity; extra.forEach((e, i) => { const c = routeCost(S0, bestOrder(S0, [...todays, e], E0), E0); if (c < bc) { bc = c; bi = i; } }); if (bi < 0 || bc - routeCost(S0, todays, E0) > 90 || !fits([...todays, extra[bi]])) break; const e = extra.splice(bi, 1)[0]; autoIds.add(e.id); todays.push(e); }
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
    if ((base.country !== 'KR' || cfg.lodging === 'stay') && cfg.breakfast && di > 0) {   // 조식: 기본 숙소 조식, 「바꾸기」로 숙소 근처 식당 선택 가능
      const bs = di + ':breakfast', fp = cfg.forceMeals && cfg.forceMeals[bs] && placeById(cfg.forceMeals[bs]);
      if (fp) { used.add(fp.id); push(t, '조식', fp, { kind: 'meal', note: '직접 선택', slot: bs, near: S0, bf: true }); }
      else push(t, '조식', null, candMeal(cfg, bs, S0) || { kind: 'meal', note: '숙소 조식', slot: bs, near: S0, bf: true });
      t += 50; }
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
async function findAttractions(o, radiusM, country, season = $('#plf [name=season]')?.value || seasonNow(new Date())) {           // 근처 관광명소 (국내 카카오 AT4, 해외 구글)
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
  return out.filter(h => !known.has(h.name.replace(/\s/g, '')) && !/(주차장|화장실|매표소|관리사무소)/.test(h.name) && !offSeason(h, season)).slice(0, 12);   // 계절 안 맞는 곳(겨울 수영장 등) 제외
}
function openPlanner(prefill = {}) {
  // 국내/해외 구분: 기본은 지금 거점 나라 (덕소면 국내) — 찾기 탭에서 마지막으로 본 지역을 따라가지 않음
  const homeB = S.db.bases.find(b => b.id === 'b_home') || S.db.bases.find(b => b.country === 'KR') || S.base;
  const zone = prefill.zone || (prefill.region ? ((regionCountry(prefill.region) || 'KR') === 'KR' ? 'KR' : 'OV') : ((S.base?.country || 'KR') === 'KR' ? 'KR' : 'OV'));
  const ovCities = S.db.meta.ovCities || [];                       // 해외 도시 직접 추가분 [{cc, name, lat, lng}] — db.json에 저장(가족 공유)
  const ovCountries = [...new Set([...S.db.places.filter(p => p.country && p.country !== 'KR').map(p => p.country), ...S.db.bases.filter(b => b.country !== 'KR').map(b => b.country), ...ovCities.map(c => c.cc), 'VN', 'TH', 'JP', 'GU', 'PH', 'TW', 'SG', 'MY', 'ID', 'AU', 'US'])];
  const cc = zone === 'KR' ? 'KR' : (prefill.country || (S.base?.country !== 'KR' ? S.base?.country : null) || (prefill.region && regionCountry(prefill.region)) || ovCountries[0]);
  const ovRegions = zone === 'KR' ? [] : [...regionsInDb().filter(([r]) => regionCountry(r) === cc).map(([r, n]) => ({ key: r, label: `${REGION_LABEL[r] || r} (${n})` })), ...ovCities.filter(c => c.cc === cc).map(c => ({ key: 'c:' + c.name, label: c.name + ' (직접 추가)' }))];
  const region = zone === 'KR' ? 'domestic' : (prefill.region && ovRegions.some(r => r.key === prefill.region) ? prefill.region : ovRegions[0]?.key || 'c:');
  const custom = region.startsWith('c:') ? ovCities.find(c => c.cc === cc && 'c:' + c.name === region) : null;
  const base = zone === 'KR' ? (homeB || S.base) : (S.db.bases.find(b => b.default_for === region) || S.db.bases.find(b => b.country === cc) || (custom ? { id: 'c_' + custom.name, name: custom.name + ' 시내', lat: custom.lat, lng: custom.lng, country: cc, approx: true } : S.base));
  const season = prefill.season || seasonNow(new Date((prefill.start || today()) + 'T00:00:00'));
  const ctx = { origin: base, season, family: famProfile() };
  const allSpots = S.db.places.filter(p => p.type === 'spot' && p.region === region && approxCoord(p)).map(s => ({ s, ...scoreSpot(withCoord(s), ctx), approx: !hasCoord(s) })).sort((a, b) => b.score - a.score);
  const isKR = cc === 'KR';
  const siCount = {}; S.db.places.filter(p => (isKR ? p.country === 'KR' : p.region === region) && p.type !== 'restaurant').forEach(p => { const k = areaKey(p) || '기타'; siCount[k] = (siCount[k] || 0) + 1; });   // 저장한 휴양지·우리 장소 수
  const areas = Object.entries(siCount).sort((a, b) => b[1] - a[1]);
  const area = prefill.area && (isKR || siCount[prefill.area]) ? prefill.area : 'all';     // 목적지 시·군 (예: 양평) — 국내는 저장 0곳이어도 선택 가능
  let lodge = prefill.lodge || null;                                                      // 숙소(동네·호텔·펜션) = 현지 기준점. 집 거점은 출발·귀가용
  const pendingCenter = !lodge && area !== 'all' && !areaCenter(area) && !prefill.noLodge;
  if (!lodge && custom && !prefill.noLodge) lodge = { name: `${custom.name} (동네 미정)`, lat: custom.lat, lng: custom.lng, country: cc, approx: true };
  if (!lodge && area !== 'all' && !prefill.noLodge) { const c = areaCenter(area); if (c) lodge = { name: `${area} (동네 미정)`, lat: c.lat, lng: c.lng, country: 'KR', approx: true, si: area }; }
  const radiusKm = prefill.radiusKm || 20;
  const anchor = lodge && hasCoord(lodge) ? lodge : null;
  const inArea = area === 'all' ? allSpots : allSpots.filter(x => areaKey(x.s) === area);
  const homeP = S.db.bases.find(b => b.id === 'b_home') || base;
  const awayTrip = anchor && homeP && hasCoord(homeP) && haversine(anchor, homeP) > 8;          // 집에서 떨어진 숙소 = 그 지역으로 떠나는 여행
  const local = x => !awayTrip || haversine(homeP, withCoord(x.s)) > x.km;                       // 집보다 숙소에 더 가까운 곳만 (집 앞 월문천·하남 제외)
  let spots = anchor ? allSpots.map(x => ({ ...x, km: haversine(anchor, withCoord(x.s)) })).filter(x => x.km <= radiusKm && local(x)).sort((a, b) => ((areaKey(a.s) === area ? 0 : 1) - (areaKey(b.s) === area ? 0 : 1)) || (a.km - b.km)) : inArea;   // 숙소 기준: 같은 시·군 → 가까운 순
  const noCoord = S.db.places.filter(p => p.type === 'spot' && p.region === region && !approxCoord(p)).length;
  const nApprox = spots.filter(x => x.approx).length;
  const wantN = (prefill.days || 1) * (prefill.maxSpots || 3);
  const autoLocal = anchor && spots.length < wantN && !prefill.spots;                           // 저장한 곳이 모자라면 현지 관광지를 자동으로 불러옴
  const preN = (prefill.days || 1) * (prefill.maxSpots || 3);
  const pre = prefill.spots ? new Set(prefill.spots) : new Set([...(prefill.with ? [prefill.with] : []), ...spots.filter(x => x.s.wish).map(x => x.s.id), ...spots.slice(0, preN).map(x => x.s.id)].slice(0, preN + 1));   // 지역을 고르면 그 지역 상위 휴양지만 자동 선택
  openSheet(`<div class="sheet-head"><div><h2>여행 플래너</h2><div class="help">${zone === 'KR' ? '국내' : '해외 · ' + esc(COUNTRY_EN[cc] || cc)} · 출발 ${esc(base?.name || '없음')} · ${season}</div></div><button class="close" data-act="close">✕</button></div>
    <form class="form" id="plf">
      <div class="seg pl-zone"><button type="button" data-zone="KR" class="${zone === 'KR' ? 'on' : ''}">국내</button><button type="button" data-zone="OV" class="${zone === 'OV' ? 'on' : ''}">해외</button></div>
      ${zone === 'OV' ? `<div class="two"><label>나라<select name="cc" id="pl-cc">${ovCountries.map(c => `<option value="${c}"${c === cc ? ' selected' : ''}>${esc((G_COUNTRY_KO[c] || COUNTRY_EN[c] || c))}</option>`).join('')}</select></label>
        <label>도시·지역<select name="region" id="pl-region">${ovRegions.map(r => `<option value="${esc(r.key)}"${r.key === region ? ' selected' : ''}>${esc(r.label)}</option>`).join('') || '<option value="c:">도시를 추가하세요</option>'}</select></label></div>
        <div class="inline pl-addcity"><input id="pl-city" placeholder="새 도시 추가 (예: 다낭, 세부, 오사카)"><button type="button" data-act="addcity">＋ 추가</button></div>` : ''}
      <label>제목<input name="title" value="${esc(prefill.title || `${new Date().getFullYear()} ${area !== 'all' ? area : zone === 'KR' ? '국내' : (REGION_LABEL[region] || custom?.name || '')} 가족 여행`)}"></label>
      <div class="two"><label>${isKR ? '목적지 (시·군)' : '구역'}<select name="area" id="pl-area"><option value="all">${zone === 'KR' ? '국내' : esc(REGION_LABEL[region] || (custom ? custom.name : region))} 전체 (${allSpots.length})</option>${isKR ? `<optgroup label="저장한 곳 있는 지역">${areas.filter(([k]) => k !== '기타').map(([k, n]) => `<option value="${esc(k)}"${k === area ? ' selected' : ''}>${esc(k)} (${n})</option>`).join('')}</optgroup>${Object.entries(KR_AREAS).map(([g, l]) => `<optgroup label="${g}">${l.map(k => `<option value="${esc(k)}"${k === area && !siCount[k] ? ' selected' : ''}>${esc(k)}${siCount[k] ? ` (${siCount[k]})` : ''}</option>`).join('')}</optgroup>`).join('')}` : areas.map(([k, n]) => `<option value="${esc(k)}"${k === area ? ' selected' : ''}>${esc(k)} (${n})</option>`).join('')}</select></label>
        <label>숙소 반경<select name="radiusKm">${[10, 20, 30, 60].map(k => `<option value="${k}"${k === radiusKm ? ' selected' : ''}>${k}km</option>`).join('')}</select></label></div>
      <label>식당 반경 <small style="font-weight:400">(장소·숙소 기준 · 유명 맛집만 예외)</small><select name="mealKm">${[1, 3, 5, 10].map(k => `<option value="${k}"${k === (prefill.mealKm || 3) ? ' selected' : ''}>${k}km 안</option>`).join('')}</select></label>
      <div class="sec">숙소 (동네 또는 호텔·펜션) <span class="sec-note">이 위치 기준으로 근처 휴양지를 고릅니다</span></div>
      <div class="lodge-box"><div class="lodge-cur">${lodge ? `<button type="button" class="lodge-x" data-act="lodgeclear" title="숙소 선택 해제">✕</button><b>${esc(lodge.name)}</b>${lodge.approx ? '<span class="apx">대략</span>' : ''}<span class="cap">${lodge.address ? esc(lodge.address) : `${lodge.lat?.toFixed?.(3)}, ${lodge.lng?.toFixed?.(3)}`}</span>` : '<span class="cap">숙소 미정 — 아래에서 검색하거나 시·군을 고르면 동네 중심으로 잡습니다</span>'}</div>
        ${lodge && !lodge.approx && !lodge.baseId ? '<label class="check"><input name="saveLodge" type="checkbox" checked> 일정 저장 시 이 숙소를 거점 목록에도 저장 (다음 여행·근처 추천에 재사용)</label>' : ''}
        <div class="inline"><input id="lq" placeholder="동네명 또는 호텔·펜션명 (예: 남해 상주, 힐튼 남해)"><button type="button" class="primary" data-act="lsearch">검색</button></div><div class="hits" id="lhits" hidden></div>
        ${S.db.bases.filter(b => b.id !== 'b_home' && b.country === cc).length ? `<div class="chips" style="margin-top:6px">${S.db.bases.filter(b => b.id !== 'b_home' && b.country === cc).map(b => `<button type="button" class="chip" data-lodgebase="${b.id}">▣ ${esc(b.name)}</button>`).join('')}</div>` : ''}</div>
      <div class="three"><label>출발일<input name="start" type="date" value="${esc(prefill.start || today())}"></label><label>일수<input name="days" type="number" min="1" max="7" value="${prefill.days || 1}"></label><label>계절 <small style="font-weight:400">(출발일 기준 자동)</small><input name="season" value="${seasonNow(new Date((prefill.start || today()) + 'T00:00:00'))}" readonly style="background:var(--panel-2);color:var(--text-2)"></label></div>
      <div class="three"><label>출발<input name="startT" type="time" value="09:00"></label><label>복귀<input name="endT" type="time" value="20:00"></label><label>하루 최대<select name="maxSpots">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === (prefill.maxSpots || 3) ? ' selected' : ''}>${n}곳</option>`).join('')}</select></label></div>
      <div class="two"><label>숙박<select name="lodging"><option value="return"${base?.country === 'KR' && base?.id === 'b_home' ? '' : ' selected'}>매일 거점 복귀</option><option value="stay"${base?.country === 'KR' && base?.id === 'b_home' ? ' selected' : ''}>${lodge ? `숙소(${esc(lodge.name.split(' (')[0])}) 숙박 · 마지막 날 귀가` : '현지 숙박 (마지막 날 복귀)'}</option></select></label><label class="check" style="align-self:end"><input name="breakfast" type="checkbox" checked> 숙소 조식 포함</label></div>
      ${famProfile().toddler ? '<label class="check"><input name="rest" type="checkbox" checked> 유아 낮잠 · 13:30–15:00 숙소 휴식 넣기</label>' : ''}
      <label class="check"><input name="autoFill" type="checkbox" ${prefill.autoFill === false ? '' : 'checked'}> 선택한 곳이 모자라면 같은 지역 휴양지로 자동 채우기</label>
      <div class="sec">휴양지 ${anchor ? `<span class="sec-note">숙소 ${radiusKm}km 안 ${spots.length}곳 · 상위 자동 선택 (빼거나 더할 수 있음)` : '<span class="sec-note">점수순 · ★ 가고싶다 우선 선택됨'}${nApprox ? ` · <span class="apx">대략</span> ${nApprox}곳은 시·군 중심으로 계산` : ''}${noCoord ? ` · 지역 불명 ${noCoord}곳 제외` : ''}</span></div>
      ${autoLocal ? `<div class="help" id="pl-autol">${esc(area !== 'all' ? area : '숙소')} 근처 관광지 불러오는 중…</div>` : ''}
      <div class="pick" id="pick">${spots.map(x => `<label class="pick-row"><input type="checkbox" value="${x.s.id}" ${pre.has(x.s.id) ? 'checked' : ''}><span class="pick-main"><b>${esc(x.s.name)}</b> <span class="mono reco-score">${x.score}</span>${x.approx ? '<span class="apx">대략</span>' : ''}<span class="sub">${[x.km != null ? `숙소에서 ${fmtKm(x.km)}km` : x.s.si, (x.s.seasons || []).join('·'), `${stayMin(x.s) / 60}h`].filter(Boolean).map(esc).join(' · ')}</span><span class="reasons">${x.reasons.slice(0, 3).map(r => `<span class="badge ${/비추|^-/.test(r) ? 'neg' : ''}">${esc(r)}</span>`).join('')}</span></span></label>`).join('') || '<div class="help">이 지역에 등록된 휴양지가 없습니다</div>'}</div>
      ${spots.length ? '' : `<div class="help" style="margin:4px 0">${anchor ? `숙소 ${radiusKm}km 안에 등록된 휴양지가 없어요` : '이 지역에 등록된 휴양지가 없어요'} — 아래에서 새 후보를 찾아 추가하세요</div>`}
      <div class="pl-new" id="pl-new"><button type="button" class="chip" data-act="findnew">＋ ${cc === 'KR' ? '카카오' : '구글'}에서 근처 관광지 새로 찾기</button><div id="pl-newl"></div></div>
      <div class="btns"><button class="primary" data-act="build">동선 생성</button><span class="help" style="align-self:center">선택 안 하면 추천 상위로 자동 구성</span></div>
    </form>
    <div id="plan-out"></div>`);
  const f = $('#plf'); let plan = null, cfg = null;
  if (autoLocal) (async () => {
    const hits = (await findAttractions(anchor, radiusKm * 1000, cc)).filter(h => !awayTrip || haversine(homeP, h) > haversine(anchor, h));
    const box = $('#pl-autol'); if (!$('#plf')) return;
    if (!hits.length) { if (box) box.textContent = window.kakao?.maps?.services ? '근처 관광지를 못 찾았어요 — 반경을 넓혀 보세요' : '카카오 지도 키가 연결되면 현지 관광지를 자동으로 채웁니다'; return; }
    S.tmpPlaces ||= new Map(); const need = Math.max(0, wantN - $$('#pick input:checked').length);
    const rows = hits.slice(0, 8).map((h, i) => { const id = 'tmp_' + h.name.replace(/\s/g, '').slice(0, 20); if (!S.tmpPlaces.has(id)) S.tmpPlaces.set(id, { id, type: 'spot', country: cc, region, name: h.name, lat: h.lat, lng: h.lng, address: h.address || null, si: area !== 'all' ? area : null, do: null, seasons: [], tags: [], rating: 0, visits: 0, visitLog: [], wish: false, naver: {}, kakao: h.url ? { url: h.url } : {}, src: h.src, tmp: true });
      return `<label class="pick-row"><input type="checkbox" value="${id}" ${i < need ? 'checked' : ''}><span class="pick-main"><b>${esc(h.name)}</b> <span class="bd" style="background:var(--kakao);color:var(--on-kakao)">${esc(h.src)} 추천</span><span class="sub">${esc([h.cat, '숙소에서 ' + fmtKm(haversine(anchor, h)) + 'km'].filter(Boolean).join(' · '))}</span></span></label>`; }).join('');
    if (box) box.outerHTML = `<div class="help">${esc(area !== 'all' ? area : '숙소')} 현지 관광지 ${Math.min(hits.length, 8)}곳 (저장 안 된 곳 · 일정 저장 시 휴양지로 추가)</div>`;
    $('#pick').insertAdjacentHTML('afterbegin', rows);
    const fd = $('#plf'); const want = Math.max(2, (+fd?.days?.value || 1) * (+fd?.maxSpots?.value || 3));
    const all = $$('#pick input'); const rank = i => { const p = placeById(i.value); return p?.tmp ? 1 : areaKey(p) === area ? 0 : 2; };
    all.slice().sort((a, b) => rank(a) - rank(b)).forEach((i, k) => { i.checked = k < want; });   // 같은 시·군 저장분 → 현지 관광지 → 그 외
  })();
  if (pendingCenter) { const lc = $('.lodge-cur'); if (lc) lc.innerHTML = `<span class="cap">${esc(area)} 위치 찾는 중…</span>`; geocodeArea(area).then(c => { if (c && $('#plf')) reopen($('#plf'), { area }); else if (lc) lc.innerHTML = '<span class="cap">지역 위치를 못 찾았어요 — 숙소를 직접 검색해 주세요</span>'; }); }
  f.addEventListener('submit', e => e.preventDefault());
  f.querySelector('[name=start]').addEventListener('change', e => { const sv = seasonNow(new Date(e.target.value + 'T00:00:00')); f.querySelector('[name=season]').value = sv; });   // 계절은 출발일로 자동
  const reopen = (f0, patch) => { const d = Object.fromEntries(new FormData(f0)); openPlanner({ ...prefill, spots: null, title: /^\d{4} .+ 가족 여행( 일정)?$/.test(d.title) ? '' : d.title, start: d.start, days: +d.days || 1, maxSpots: +d.maxSpots, radiusKm: +d.radiusKm || 20, mealKm: +d.mealKm || 3, area: d.area, lodge, zone, country: cc, region, ...patch }); };
  const bindArea = f0 => { f0.querySelector('[name=area]')?.addEventListener('change', e => reopen(f0, { area: e.target.value, lodge: null, noLodge: false }));
    f0.querySelector('#pl-cc')?.addEventListener('change', e => reopen(f0, { country: e.target.value, region: null, area: 'all', lodge: null, noLodge: false }));
    f0.querySelector('#pl-region')?.addEventListener('change', e => reopen(f0, { region: e.target.value, area: 'all', lodge: null, noLodge: false }));
    f0.querySelector('#lq')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); f0.querySelector('[data-act=lsearch]')?.click(); } });
    f0.querySelector('[name=radiusKm]')?.addEventListener('change', e => reopen(f0, { radiusKm: +e.target.value }));
    f0.addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.zone) { if (b.dataset.zone !== zone) reopen(f0, { zone: b.dataset.zone, region: null, country: null, area: 'all', lodge: null, noLodge: false, title: '' }); return; }
      if (b.dataset.act === 'lodgeclear') { reopen(f0, { lodge: null, noLodge: true }); return; }
      if (b.dataset.act === 'addcity') { const q = $('#pl-city').value.trim(); if (!q) return toast('도시 이름을 입력하세요'); b.textContent = '찾는 중…';
        let hits = []; try { hits = await geoSearch(q, cc); if (!hits.length) hits = await osmSearch(q, cc); } catch {} b.textContent = '＋ 추가';
        if (!hits.length) return toast('위치를 못 찾았어요 — 영문 이름으로 시도해 보세요');
        const list = (S.db.meta.ovCities || []).filter(c => !(c.cc === cc && c.name === q)); list.push({ cc, name: q, lat: +hits[0].lat.toFixed(5), lng: +hits[0].lng.toFixed(5), at: today() }); S.db.meta.ovCities = list; markDirty();
        toast(`도시 추가: ${q}`); reopen(f0, { region: 'c:' + q, area: 'all', lodge: null }); return; }
      if (b.dataset.act === 'lsearch') { const q = $('#lq').value.trim(); if (!q) return toast('동네명이나 숙소 이름을 입력하세요'); b.textContent = '검색 중…'; let hits = []; try { hits = await geoSearch(q, cc, area !== 'all' ? area : ''); if (!hits.length && area !== 'all') hits = await osmSearch(`${area} ${q}`, cc); } catch (err) { toast('검색 실패: ' + err.message); } b.textContent = '검색'; showHits($('#lhits'), hits, h => { const ak = isKR ? (Object.values(KR_AREAS).flat().filter(k => (h.address || '').includes(k.replace(/^(경기|강원|경남) /, ''))).sort((a, b) => b.length - a.length)[0] || area) : area;
        reopen(f0, { area: ak, lodge: { name: h.name, lat: h.lat, lng: h.lng, address: h.address, country: cc, si: ak } }); }); }
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
    if (cfg.base.country === 'KR' && googleKey()) { await Promise.all(r.map(gRate)); r.sort((a, b) => (b.score + rateBonus(b)) - (a.score + rateBonus(a))); }   // 구글 평점 높은·리뷰 많은 곳 위로
    return (nearCache[k] = r);
  };
  const fillNear = async () => {                                 // '찾는 중' 식사 칸을 근처 새 후보로 채우고 다시 그림
    const need = plan.days.flatMap(d => d.items).filter(it => it.kind === 'meal' && !it.bf && !/breakfast/.test(it.slot || '') && !it.place_id && !it.cand && it.slot && it.near && !tried.has(it.slot));   // 조식은 숙소 조식 기본 (자동 채우기 X)
    if (!need.length) return; need.forEach(it => tried.add(it.slot));
    cfg.candPick ||= {}; const usedNames = new Set(Object.values(cfg.candPick).map(c => c.name)); let got = 0;
    for (const it of need) { const list = await nearCands(it.near); const c = list.find(x => !usedNames.has(x.name) && mealOK(x, it.slot) && !(/dinner/.test(it.slot) && x.cuisine === '양식')); if (c) { cfg.candPick[it.slot] = c; usedNames.add(c.name); got++; } }
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
    if (b.dataset.go) { const di = curDi, back = $('.pl-sheet') ? () => showDay(di) : null; openDetail(b.dataset.go); S.returnTo = back; return; }   // 일정에서 상세 → 닫으면 일정으로
    if (b.dataset.act === 'findnew') {
      const o = anchor || (area !== 'all' && SI_CENTER[area] ? { lat: SI_CENTER[area][0], lng: SI_CENTER[area][1] } : null) || (base && hasCoord(base) ? base : null);
      const list = $('#pl-newl'); if (!o) { list.innerHTML = '<div class="help">숙소나 목적지를 먼저 정해주세요</div>'; return; }
      list.innerHTML = skelHtml('근처 관광지 찾는 중…', cc === 'KR' ? '카카오' : '구글', 0);
      const hits = await findAttractions(o, radiusKm * 1000, cc);
      S.plNew = hits;
      list.innerHTML = hits.length ? hits.map((h, i) => `<div class="rc-row nb"><div class="m"><b>${esc(h.name)}</b><p class="cap">${esc([h.cat, h.km != null ? (anchor ? '숙소에서 ' : '') + fmtKm(h.km) + 'km' : '', h.rating ? 'G' + h.rating : ''].filter(Boolean).join(' · '))}</p></div><button type="button" class="chip" data-addnew="${i}">+ 추가</button></div>`).join('')
        : `<div class="help">${cc === 'KR' ? (window.kakao?.maps?.services ? '반경 안 관광지 없음' : '카카오 지도 키가 연결돼야 찾을 수 있어요 (설정 › 카카오 JavaScript 키)') : (googleKey() ? '반경 안 관광지 없음' : '설정에서 구글 Places 키를 넣으면 찾을 수 있어요')}</div>`;
      return;
    }
    if (b.dataset.addnew != null) {                               // 새 후보 → 휴양지로 등록 + 선택
      const h = S.plNew?.[+b.dataset.addnew]; if (!h) return;
      let p = S.db.places.find(x => x.name.replace(/\s/g, '') === h.name.replace(/\s/g, ''));
      if (!p) { p = { id: uid(), type: 'spot', country: cc, region, name: h.name, lat: h.lat, lng: h.lng, address: h.address || null, si: area !== 'all' ? area : null, do: null, seasons: [], tags: [], rating: 0, visits: 0, visitLog: [], wish: false, naver: {}, kakao: h.src === '카카오' ? { url: h.url } : {}, google: h.src === '구글' ? { url: h.url, rating: h.rating, reviews: h.reviews } : undefined, src: h.src }; S.db.places.push(p); markDirty(); }
      if (!$(`#pick input[value="${p.id}"]`)) $('#pick').insertAdjacentHTML('afterbegin', `<label class="pick-row"><input type="checkbox" value="${p.id}" checked><span class="pick-main"><b>${esc(p.name)}</b> <span class="badge">새 후보</span><span class="sub">${esc([h.cat, h.km != null ? fmtKm(h.km) + 'km' : ''].filter(Boolean).join(' · '))}</span></span></label>`);
      else $(`#pick input[value="${p.id}"]`).checked = true;
      b.textContent = '추가됨 ✓'; b.disabled = true; return;
    }
    if (b.dataset.act === 'build') {
      const d = Object.fromEntries(new FormData($('#plf')));
      let ids = $$('#pick input:checked').map(i => i.value);
      if (!ids.length) {                                          // 미선택 → 추천 상위 자동 (없으면 새 후보 찾기)
        const want = Math.max(1, (+d.days || 1) * (+d.maxSpots || 3));
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
      const near = it.near || (it.place_id && placeById(it.place_id)) || plan.days[curDi].items.slice(0, idx).reverse().map(x => x.to || (x.place_id && placeById(x.place_id))).find(x => x && hasCoord(withCoord(x)));   /* 위치 없는 칸은 직전 장소 기준 (집 기준 X) */ const ctx2 = { season: cfg.season, family: famProfile(), country: cfg.base.country, mode: 'plan', allowApprox: true, origin: near ? withCoord(near) : cfg.base };
      const cands = recommendFromDb(ctx2, 30).filter(x => x.place.id !== it.place_id && x.km != null && (x.km <= (cfg.mealKm || 3) * 1.5 || (isFamous(x.place) && x.km <= Math.max((cfg.mealKm || 3) * 3, 10)))).slice(0, 3);   // 식당 반경 안 위주
      row.insertAdjacentHTML('afterend', `<div class="pl-cands">${cands.map(x => `<button class="rc-row" data-pick-meal="${x.place.id}" data-slot="${esc(it.slot || '')}">${thumbHtml(x.place, 'tile')}<div class="m"><b>${esc(x.place.name)}</b><p class="cap">${esc([cuisineOf(x.place)[0], x.km != null ? (x.approx && x.km < 0.5 ? '같은 지역' : fmtKm(x.km) + 'km') : areaOf(x.place), x.reasons.filter(r => !/km$/.test(r))[0]].filter(Boolean).join(' · '))}</p></div></button>`).join('') || '<div class="help">근처 등록 식당 없음</div>'}<div class="pl-cnew"><span class="bd" style="background:var(--${cfg.base.country === 'KR' ? 'kakao' : 'google'});color:${cfg.base.country === 'KR' ? 'var(--on-kakao)' : '#fff'}">${cfg.base.country === 'KR' ? '카카오' : '구글'}</span> 근처 새 후보 불러오는 중…</div></div>`);
      const box = row.nextElementSibling; const list = near ? await nearCands(near) : []; S.swapCands = list.filter(c => c.name !== it.place && mealOK(c, it.slot)).slice(0, 5);
      const nb = box.querySelector('.pl-cnew'); if (nb) nb.outerHTML = S.swapCands.length ? S.swapCands.map((c, k) => `<div class="pl-ci"><button class="rc-row" data-pick-cand="${k}" data-slot="${esc(it.slot || '')}"><span class="tile" style="--cat:var(--cat-${CAT_VAR[c.cuisine] || 'etc'})">${esc(CAT_GLYPH[c.cuisine] || '·')}</span><div class="m"><b>${esc(c.name)} <span class="bd" style="background:var(--${c.src === '구글' ? 'google' : 'kakao'});color:${c.src === '구글' ? '#fff' : 'var(--on-kakao)'}">${esc(c.src)}</span></b><p class="cap">${c.google?.rating ? `<span class="g-rt">★${c.google.rating}</span> <span class="g-n">(${(c.google.reviews || 0).toLocaleString()})</span> · ` : ''}${esc([catShort(c.category) || c.cuisine, c.km != null ? fmtKm(c.km) + 'km' : ''].filter(Boolean).join(' · '))}</p></div></button>${c.url ? `<a class="c-map" href="${esc(c.url)}" target="_blank" rel="noopener" title="카카오맵에서 별점·리뷰 보기">카카오맵 ↗</a>` : ''}</div>`).join('') : `<div class="help">${cfg.base.country === 'KR' ? (window.kakao?.maps?.services ? '근처 새 후보 없음' : '카카오 키 연결 시 근처 식당 추천') : '구글 키 연결 시 근처 식당 추천'}</div>`;
      return; }
    if (b.dataset.pickMeal) { cfg.forceMeals[b.dataset.slot] = b.dataset.pickMeal; if (cfg.candPick) delete cfg.candPick[b.dataset.slot]; plan = buildPlan(cfg); showDay(curDi); toast('식당 변경'); return; }
    if (b.dataset.pickCand != null) { const c = (S.swapCands || [])[+b.dataset.pickCand]; if (!c) return; cfg.candPick ||= {}; cfg.candPick[b.dataset.slot] = c; delete cfg.forceMeals[b.dataset.slot]; plan = buildPlan(cfg); showDay(curDi); toast('식당 변경 · ' + c.name); return; }
    if (b.dataset.stay) { const [id, delta] = b.dataset.stay.split(':'); const p = placeById(id); const cur = cfg.stayOverride[id] ?? stayMin(p); cfg.stayOverride[id] = Math.max(30, cur + +delta); plan = buildPlan(cfg); showDay(curDi); return; }
    if (b.dataset.act === 'refine' && plan) { b.disabled = true; b.textContent = '실경로 조회 중…'; refinePlanRoutes(plan).then(n => { showDay(curDi); toast(n ? `${n}개 구간 실경로 반영` : '실경로 조회 실패 — 키 확인'); }); return; }
    if (b.dataset.act === 'saveplan' && plan) {
      const t = prefill.tripId && S.db.trips.find(x => x.id === prefill.tripId) || { id: 'trip' + uid(''), title: cfg.title, city: cfg.area && cfg.area !== 'all' ? cfg.area : (REGION_LABEL[region] || custom?.name || region), country: base.country, year: +(cfg.start || today()).slice(0, 4), items: [], planned: true };
      t.title = cfg.title; t.year = +(cfg.start || today()).slice(0, 4); t.items = [];
      for (const day of plan.days) for (const it of day.items) if (it.kind !== 'move') t.items.push({ day: day.label, time: it.time, activity: it.activity, place: it.place, note: it.note || null, place_id: it.place_id || null });
        else t.items.push({ day: day.label, time: it.time, activity: it.activity, place: null, note: it.note, place_id: null });
      t.plan = { start: cfg.start, days: cfg.days, maxSpots: cfg.maxSpots, lodging: cfg.lodging, breakfast: cfg.breakfast, rest: cfg.rest, startMin: cfg.startMin, endMin: cfg.endMin, spots: cfg.spots.map(x => x.id), dayOrders: cfg.dayOrders, stayOverride: cfg.stayOverride, forceMeals: cfg.forceMeals, region, area: cfg.area, autoFill: cfg.autoFill, lodge: cfg.lodge, radiusKm: cfg.radiusKm, candPick: cfg.candPick || {}, mealKm: cfg.mealKm, zone, country: cc };   // 플래너로 다시 열기용
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
    return `<div class="pl-row${isMeal ? ' meal' : ''}" data-idx="${i}" ${!isMeal && it.place_id ? 'draggable="true"' : ''}><span class="num rk" style="background:${colorOfIt(it)}">${k}</span><div style="flex:1;min-width:0"><b>${isMeal ? `${esc(it.activity)} · ${p ? `<button type="button" class="pl-go" data-go="${p.id}">${esc(p.name)}</button>` : it.cand ? (it.cand.url ? `<a class="pl-go" href="${esc(it.cand.url)}" target="_blank" rel="noopener">${esc(it.cand.name)} ↗</a>` : esc(it.cand.name)) : '자동 추천'}` : p ? `<button type="button" class="pl-go" data-go="${p.id}">${esc(it.activity)}</button>` : esc(it.activity)}${apx}</b><p class="cap">${esc(it.time)}${dur ? ' · ' + dur : ''}${isMeal ? (p ? ` · ${esc(cuisineOf(p)[0] || '')}${it.note ? ' · ' + esc((apx && /^0\.\dkm$|^0km$/.test(it.note.split(' · ')[0])) ? '같은 지역' : it.note.split(' · ')[0]) : ''}` : ' · ' + esc(it.note || '')) : esc(tagsOf(it))}</p></div>${isMeal ? `<button class="chip" data-swap="${i}">바꾸기</button>` : (it.place_id ? `<span class="stayctl"><button data-stay="${it.place_id}:-30">−</button><button data-stay="${it.place_id}:30">＋</button></span><span class="cap3 grip">≡</span>` : '')}</div>`;
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
  if (m[1] === 'j') { showView('journal'); return; }
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
  { const ph = (t.photos || []).map(x => photoUrl(x.path)).find(Boolean); if (ph) return `background-image:url('${ph}')`; }   // 여행 사진 첫 장이 표지
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
  const d = haversine(base, p);
  if (base.country && p.country && base.country !== p.country && d > 300) return { km: Math.round(d), min: Math.round(d / 800 * 60 + 150), real: false, fly: true };   // 다른 나라: 비행 (직선 + 공항 시간 대략)
  const e = roadEst(d, p.country); return e ? { km: e.road, min: e.min, real: false } : null;
}
function minText(m) { return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60 ? m % 60 + '분' : ''}`.trim() : `${m}분`; }
function baseShort(p) { return ((p ? baseFor(p) : S.base)?.name || '거점').replace(/^집\s*\((.*)\)$/, '$1').replace(/\s*\(.*\)/, ''); }
function distText(p) { const d = distInfo(p); return d ? `${baseShort(p)}에서 ${fmtKm(d.km)}km · ${d.fly ? '비행 약' : '차로'} ${minText(d.min)}` : '위치 없음'; }
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
    <div class="ph-hero" style="background-image:linear-gradient(rgba(14,58,75,.72),rgba(14,58,75,.82)),url('${heroSrc(d.season)}');background-size:cover;background-position:center"><button class="hero-pick ph" data-act="heropick">🖼</button><div class="dots"></div><div class="sun"></div>
      <div class="ph-top"><img src="${asset('assets/mark-faces.png')}" alt="" style="width:76px"><img src="${asset('assets/wordmark-white.png')}" alt="준준 TRIP" style="width:118px;margin-left:-2px"><span style="flex:1"></span><button class="theme-tg" data-act="theme" title="다크모드">${isDark() ? '☀' : '☾'}</button><button class="bell" data-act="settings" title="설정">${ICO.bell}</button></div>
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
  const logCard = ({ p, v }, big) => big ? `<button class="pc-log big" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="h"><span class="cat">${esc(catDot(p))}</span>${esc(areaOf(p))} · 최근 기록</div>${(v.photo && photoUrl(v.photo)) || imgOf(p) ? `<div class="lc-img big" style="margin-top:14px"><img src="${(v.photo && photoUrl(v.photo)) || imgOf(p)}" alt=""></div>` : ''}<q>${esc(v.memo || p.name)}</q>${p.pros || p.signature ? `<p class="memo">${esc(p.pros || p.signature)}</p>` : ''}<div class="f"><div><b>${esc(p.name)}</b><p class="mono">${esc((v.date || '').replace(/-/g, '.'))} · <span class="st">★${v.rating || ''}</span> · ${p.visits}회</p></div><img class="stamp" src="${asset('assets/mark-stamp.png')}" alt=""></div><span class="add rw">+ 사진 추가</span></button>`
    : `<button class="pc-log" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="h"><i></i>${esc(catDot(p))}<span class="st">${starsTxt(v.rating)}</span></div>${(v.photo && photoUrl(v.photo)) || imgOf(p) ? `<div class="lc-img"><img src="${(v.photo && photoUrl(v.photo)) || imgOf(p)}" alt=""></div>` : ''}<q>${esc(v.memo || areaOf(p))}</q><div class="f"><b>${esc(p.name)}</b><span class="mono">${esc((v.date || '').slice(5).replace('-', '.'))}</span></div></button>`;
  const visitCard = (p, big) => `<button class="pc-log${big ? ' big' : ''}" data-go="${p.id}" style="--cat:${catColor(p)}"><div class="h">${big ? `<span class="cat">${esc(catDot(p))}</span>` : `<i></i>${esc(catDot(p))}`}<span class="st">${starsTxt(ratingOf(p))}</span></div>${imgOf(p) ? `<div class="lc-img${big ? ' big' : ''}"${big ? ' style="margin-top:14px"' : ''}><img src="${imgOf(p)}" alt=""></div>` : ''}<q>${esc(p.pros || p.desc || p.signature || areaOf(p))}</q><div class="f"><b>${esc(p.name)}</b><span class="mono">방문 ${p.visits}회</span></div></button>`;
  const logsHtml = d.logs.length ? d.logs.slice(0, 5).map((l, k) => logCard(l, k === 0)).join('') : d.visited.slice(0, 5).map((p, k) => visitCard(p, k === 0)).join('');
  const wishRow = p => { const st = openState(p), ol = st && OPEN_LABEL[st]; const dd = distInfo(p);
    return `<button class="row" data-go="${p.id}">${thumbHtml(p, 'tile')}<div style="flex:1"><b>${esc(p.name)}</b><p>${esc(kindLabel(p))} · ${esc(areaOf(p))}${dd ? ` · ${fmtKm(dd.km)}km` : ''}</p></div>${ol ? `<span class="chip op-${ol[1]}">${ol[0]}</span>` : (p.tags?.[0] ? `<span class="chip op-off">#${esc(p.tags[0])}</span>` : '')}</button>`; };
  const trip = t => `<button class="pc-trip" data-trip="${t.id}"><div class="plate"></div><div class="photo" style="${tripCoverStyle(t)}"><div class="txt"><span class="mono">${t.year} · ${t.country === 'KR' ? '국내' : COUNTRY_EN[t.country] || t.country}</span><div class="disp">${esc(tripCity(t))}</div><p>${esc(tripSub(t))}</p></div>${t.country !== 'KR' ? `<img class="globe" src="${asset('assets/mark-globe.png')}" alt="">` : `<img class="stamp" src="${asset('assets/mark-stamp.png')}" alt="">`}</div></button>`;
  return `
    <div class="pc-hero-wrap" style="background-image:linear-gradient(rgba(14,58,75,.78),rgba(14,58,75,.78)),url('${heroSrc(d.season)}');background-size:cover;background-position:center"><div class="pc-hero" id="pc-hero">
      <div class="bg" style="background-image:linear-gradient(90deg,rgba(14,58,75,.82) 0%,rgba(14,58,75,.55) 40%,rgba(14,58,75,0) 62%),linear-gradient(180deg,rgba(14,58,75,.55),rgba(14,58,75,0) 30%),linear-gradient(0deg,rgba(14,58,75,.6),rgba(14,58,75,0) 45%),url('${heroSrc(d.season)}')"></div>
      <div class="note"><span>${esc(d.season)} 배경 · 계절마다 자동 교체</span><button class="hero-pick" data-act="heropick">🖼 배경 바꾸기</button></div>
      <nav class="pc-nav"><div class="links">${['home', 'explore', 'trips', 'journal', 'settings'].map((v, k) => `<button data-view="${v}" class="${v === 'home' ? 'on' : ''}">${['홈', '찾기', '여행', '기록', '설정'][k]}</button>`).join('')}</div></nav>
      <div class="pc-logo"><img src="${asset('assets/mark-faces.png')}" alt="" style="width:70px"><img src="${asset('assets/wordmark-white.png')}" alt="준준 TRIP" style="width:112px"></div>
      <div class="pc-right"><button class="theme-tg" data-act="theme" title="다크모드 켜기/끄기">${isDark() ? '☀' : '☾'}</button><button data-act="base"><span class="g">⌂</span> 거점: ${esc(S.base?.name || '없음')} ▾</button><button data-act="settings">가족 ${(S.db.meta.family?.adults || 0) + (S.db.meta.family?.kids || []).length + (S.db.meta.family?.seniors || 0) || '설정'}</button></div>
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
/* ---------------- 홈 계절 배경 고르기 (기본 1 + 추천 5 + 내 사진) — 가족 공유(db.json meta.hero) ---------------- */
const HERO_PRESETS = {   // Unsplash 무료 사진 (Unsplash License · 출처 표기 불필요) — 링크로 불러옴
  봄: ['1617413758222-c1703dfdc9bc', '1712320957190-463df569c9e7', '1560255058-d6d3e2af1f93', '1485186337913-a42c84d7ffcc', '1617541101297-1391249475e2'],
  여름: ['1626184386440-7560f291719f', '1720443410740-10ad29462a00', '1702039805789-bacef0302dd4', '1552480794-0d1e1095d113', '1720443408759-d7e3e393e625'],
  가을: ['1700306730557-e62129da6092', '1541928787372-6e5088530c93', '1568456774218-ca9ea97e6c9c', '1700064160470-efe6b77333c8', '1655197084804-dce267199977'],
  겨울: ['1703476072024-97eadd3a9d29', '1734852143323-7dfd484cdeab', '1610251965193-4e15a0e39625', '1708566305701-b74043eada3d', '1637073758540-f2aaec39e9c3'],
};
const unsplash = (id, w = 2400) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80`;
function heroDefault(season) { return asset('assets/hero-' + SEASON_EN[season] + '.jpg'); }
function heroSrc(season) {
  const v = (S.db.meta.hero || {})[season]; if (!v) return heroDefault(season);
  if (/^u:/.test(v)) return unsplash(v.slice(2), window.innerWidth > 860 ? 2400 : 1200);
  return photoUrl(v) || heroDefault(season);
}
function openHeroPicker(season0) {
  let season = season0 || seasonHome();
  const draw = () => {
    const cur = (S.db.meta.hero || {})[season] || '', mine = ((S.db.meta.heroCustom || {})[season] || []);
    const tile = (val, src, label) => `<button class="hp-t${cur === val ? ' on' : ''}" data-hv="${esc(val)}" style="background-image:url('${src}')"><span>${esc(label)}</span>${cur === val ? '<i>✓ 사용 중</i>' : ''}</button>`;
    openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">닫기</button><b>홈 배경 사진</b><span></span></div><div class="vf-scroll" style="padding:16px">
      <div class="jr-tabs" style="margin-bottom:12px">${['봄', '여름', '가을', '겨울'].map(x => `<button class="${x === season ? 'on' : ''}" data-hs="${x}">${x}</button>`).join('')}</div>
      <p class="cap3">고른 사진은 가족 모두에게 같이 보입니다 · 계절이 바뀌면 그 계절 사진으로 자동 교체</p>
      <div class="hp-grid">${tile('', heroDefault(season), '기본')}${HERO_PRESETS[season].map((id, i) => tile('u:' + id, unsplash(id, 600), `추천 ${i + 1}`)).join('')}${mine.map((p, i) => tile(p, photoUrl(p), `내 사진 ${i + 1}`)).join('')}
        <button class="hp-t add rw" data-act="hpup"><b>＋</b><span>내 사진 올리기</span></button></div>
      <input type="file" id="hp-file" accept="image/*" hidden>
      <p class="cap3" style="margin-top:12px">추천 사진: <a href="https://unsplash.com/license" target="_blank" rel="noopener">Unsplash 무료 라이선스</a> · 가로 사진이 잘 어울립니다 (내 사진은 2400px로 줄여 저장)</p></div></div>`);
    $('#hp-file').onchange = async e => { const f = e.target.files[0]; if (!f) return; toast('사진 올리는 중…');
      try { const b64 = await resizeImage(f, 2400); let path = null;
        if (S.token && !OFFLINE) { try { path = await ghPutFile(`photos/hero/${SEASON_EN[season]}_${Date.now().toString(36)}.jpg`, b64, `jjtrip: hero ${season}`); } catch (err) { toast('업로드 실패 — 이 기기에만 저장: ' + err.message, 3500); } }
        if (!path) { const local = LS.get('photos', {}); path = `local:hero:${Date.now().toString(36)}`; local[path] = 'data:image/jpeg;base64,' + b64; LS.set('photos', local); }
        S.db.meta.heroCustom ||= {}; (S.db.meta.heroCustom[season] ||= []).push(path); S.db.meta.hero ||= {}; S.db.meta.hero[season] = path; markDirty(); toast('배경으로 지정'); renderHome(); draw();
      } catch (err) { toast('올리기 실패: ' + err.message, 3500); } };
    $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'back') return closeSheet();
      if (b.dataset.hs) { season = b.dataset.hs; return draw(); }
      if (b.dataset.act === 'hpup') return isRO() ? goToken() : $('#hp-file').click();
      if (b.dataset.hv != null) { if (isRO()) return goToken(); S.db.meta.hero ||= {}; if (b.dataset.hv) S.db.meta.hero[season] = b.dataset.hv; else delete S.db.meta.hero[season]; markDirty(); renderHome(); draw(); toast(`${season} 배경 변경`); }
    };
  };
  draw();
}
function renderHome() {
  const el = $('#view-home'); if (!el) return;
  const d = homeData(); const phone = window.innerWidth <= 860; S.homeMode = phone ? 'phone' : 'pc';
  el.innerHTML = phone ? renderHomePhone(d) : renderHomePC(d);
  fitPcHero(); seasonFx(el.querySelector(phone ? '.ph-hero' : '.pc-hero-wrap'), d.season);
  $('#hero-search').onsubmit = e => { e.preventDefault(); S.q = $('#hq').value.trim(); $('#q').value = S.q; S.region = 'all'; renderRegionChips(); renderTagChips(); renderList(); showView('explore'); fitToVisible(); };
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) return showView(b.dataset.view);
    if (b.dataset.act === 'heropick') return openHeroPicker(d.season);
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
    if (act === 'theme') { LS.set('theme', isDark() ? 'light' : 'dark'); applyTheme(); renderHome(); return; }   // 홈에서 바로 다크/라이트 전환
    if (act === 'settings') showView('settings');
    if (act === 'today') todayPick();
    if (act === 'planner') openPlanner();
    if (act === 'explore') { showView('explore'); fitToVisible(); }
    if (act === 'trips') { S.trip = null; showView('trips'); }
    if (act === 'explore-visited') return showView('journal');
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
        <label>국가<select name="country">${countryOptions(p.country || 'KR')}</select></label>
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
      await loadGeo(); const hits = await geoSearch($('#pq').value, f.country.value, f.si.value);
      b.textContent = '검색';
      showHits($('#phits'), hits, h => { if (!f.name.value.trim() || f.name.value.trim() === $('#pq').value.trim()) f.name.value = h.name; f.lat.value = h.lat;   /* 검색어(italy firenze) 대신 실제 장소 이름(Firenze) */ f.lng.value = h.lng; const c2 = ccAt(h.lat, h.lng); if (c2 && c2 !== f.country.value && f.country.querySelector(`option[value="${c2}"]`)) { f.country.value = c2; toast(`나라 자동: ${G_COUNTRY_KO[c2] || regionEn(c2)}`); } if (h.address) f.address.value = h.address; if (h.phone) f.phone.value = h.phone; if (h.src === '구글') f._google = { rating: h.rating, reviews: h.reviews, url: h.url }; else if (h.url) f.kakao_url.value = h.url; });
    }
  });
  f.addEventListener('submit', e => {
    e.preventDefault(); const d = Object.fromEntries(new FormData(f));
    const prevSpot = p.spot_id;
    Object.assign(p, { type: d.type, region: (d.country !== 'KR' && (!d.region.trim() || d.region.trim() === 'domestic')) ? ((d.si || '').trim().toLowerCase().replace(/\s+/g, '') || regionEn(d.country).toLowerCase()) : (d.region.trim() || 'domestic'), name: d.name.trim(), country: d.country, address: d.address.trim() || null,
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
    if (isNew && S.region !== 'all' && S.region !== p.region) { S.region = 'all'; LS.set('region', 'all'); }   // 새로 넣은 곳이 지금 지역 필터에 가려지지 않게
    if (isNew) { S.q = ''; $$('#q, #q-hdr, #q-pc').forEach(i => { if (i) i.value = ''; }); }
    if (isNew && S.radius) { const dk = distInfo(p)?.km; if (dk != null && dk > S.radius) { S.radius = null; LS.set('radius', null); } }
    markDirty(); renderRegionChips(); renderTagChips(); renderList(); closeSheet();
    if (isNew && hasCoord(p)) { try { map.setView([p.lat, p.lng], 12); } catch {} }
    if (isNew && p.type === 'spot' && hasCoord(p) && !distInfo(p)?.fly) {   /* 거점 없는 먼 나라(신혼여행지 등)는 근처 식당 추천 생략 */ toast('추가됨 — 근처 식당 추천'); openRecommend(p); } else { openDetail(p.id); toast(isNew ? '추가됨' : '저장됨'); }
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
    if (!hits.length && /[A-Za-z]{3,}/.test(q)) return geoSearch(q, 'OTHER');   // 영문 입력(예: italy firenze)이면 해외로 다시
    return hits;
  }
  const cc = country && country !== 'OTHER' ? country : '';
  if (googleKey()) { const g = await googleSearch(cc ? `${q} ${regionEn(cc)}` : q, null); if (g.length) return g; }   // 해외: 거점(덕소) 주변으로 좁히지 않음
  let r = await osmSearch(q, cc); if (!r.length && cc) r = await osmSearch(q, ''); return r;
}
function ccKo(cc) { return G_COUNTRY_KO[cc] || (S.geoWorld?.features.find(f => f.properties.cc === cc) || {}).properties?.n || regionEn(cc); }
function ccAt(lat, lng) { if (lat == null || !S.geoWorld) return ''; const f = S.geoWorld.features.find(f => geoHit(f.geometry, +lng, +lat)); return f ? f.properties.cc : ''; }
function countryOptions(sel) {                                     // 나라 선택 (자주 + 전체 가나다)
  const all = (S.geoWorld?.features || []).map(f => [f.properties.cc, f.properties.n]).filter(([c]) => c && c.length === 2).sort((a, b) => a[1].localeCompare(b[1], 'ko'));
  const top = ['KR', 'VN', 'TH', 'GU', 'JP', 'AU', 'US'], ko = c => G_COUNTRY_KO[c] || (all.find(x => x[0] === c) || [])[1] || c;
  if (sel && !top.includes(sel) && !all.some(x => x[0] === sel)) top.push(sel);
  return `<optgroup label="자주">${top.map(c => `<option value="${c}"${c === sel ? ' selected' : ''}>${esc(ko(c))}</option>`).join('')}</optgroup>${all.length ? `<optgroup label="전체 (가나다)">${all.filter(([c]) => !top.includes(c)).map(([c, n]) => `<option value="${c}"${c === sel ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>` : ''}<option value="OTHER"${sel === 'OTHER' ? ' selected' : ''}>기타</option>`;
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
  if (!ds.length) { if (t.start) { const a = new Date(t.start + 'T00:00:00'), z = new Date((t.end || t.start) + 'T00:00:00'); return { days, start: a, end: z, nights: Math.round((z - a) / 864e5) }; } return { days, start: null, end: null, nights: 0 }; }   // 간단 기록(start·end)
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
      <div class="btns" style="margin:4px 0 0"><button class="rw" data-act="newtrip">＋ 지난 여행 간단 추가</button><button data-act="xlsxall">엑셀 내보내기</button><button class="rw" data-act="importtrip" title="준준 안내서 HTML · 여행 JSON">⇪ 일정 파일 가져오기</button><input type="file" id="ti-file" accept=".html,.htm,.json" hidden></div><p class="cap3 ti-hint">안내서 HTML이나 여행 JSON 파일을 이 화면에 끌어다 놓아도 추가됩니다</p></div>`;
    $('#ti-file').onchange = e => { importTripFile(e.target.files[0]); e.target.value = ''; };
    el.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.id) { S.trip = S.db.trips.find(t => t.id === b.dataset.id); S.tripDay = 0; renderTrips(); focusTrip(); loadGeo().then(() => S.trip && tripTitle(S.trip)); } if (b.dataset.act === 'newtrip') openTripForm(); if (b.dataset.act === 'planner') openPlanner(); if (b.dataset.act === 'xlsxall') exportXlsx(); if (b.dataset.act === 'importtrip') $('#ti-file').click(); };
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
    ${tripPhotosHtml(t)}
    <div class="tl-wrap"${!(t.items || []).length ? ' style="display:none"' : ''}><div class="legend"><span class="chip"><i style="background:var(--cat-spot)"></i>휴양지</span><span class="chip"><i style="background:var(--cat-seafood)"></i>식사</span><span class="chip"><i class="dash"></i>이동</span></div>
      <div class="tl2">${rows || '<div class="help">이 날 일정이 없습니다.</div>'}</div></div>
    <div class="tp-acts"><button class="rw" data-act="tphoto">📷 사진 추가</button>${t.plan ? '<button class="rw" data-act="replan">플래너로 다시 열기</button>' : ''}<button data-act="region">${REGION_LABEL[region] || region} 식당 보기</button><button data-act="txlsx">엑셀</button><button data-act="journal">여행기</button><button data-act="guide">안내서 만들기</button><button class="rw danger" data-act="deltrip">여행 삭제</button></div>
    <button class="fab-add rw" data-act="additem">+ 일정 추가</button>`;
  el.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'back') { S.trip = null; renderTrips(); }
    if (b.dataset.act === 'region') { S.region = region; S.scope = 'all'; renderRegionChips(); renderList(); showView('explore'); fitToVisible(); }
    if (b.dataset.day != null) { S.tripDay = +b.dataset.day; renderTrips(); }
    if (b.dataset.go) openDetail(b.dataset.go);
    if (b.dataset.addplace != null) { const it = t.items[b.dataset.addplace]; openPlaceForm({ id: uid(), type: 'restaurant', country: t.country, region, name: it.place, cuisine: [], seasons: [], rating: 0, visits: 0, naver: {}, kakao: {}, note: it.activity }); }
    if (b.dataset.act === 'additem') openItemForm(t);
    if (b.dataset.act === 'tphoto') return isRO() ? goToken() : openTripPhotos(t);
    if (b.dataset.tplb != null) { const ps = (t.photos || []).filter(x => photoUrl(x.path)); return openLightbox(ps.map(x => photoUrl(x.path)), +b.dataset.tplb, `${tripCity(t)} ${t.year || ''}`, { raws: ps.map(x => x.path), date: null }); }
    if (b.dataset.act === 'edit-trip') openTripEdit(t);
    if (b.dataset.act === 'tshare') shareLink('t', t.id, t.title);
    if (b.dataset.act === 'txlsx') exportXlsx({ trip: t });
    if (b.dataset.act === 'guide') openGuideMenu(t);
    if (b.dataset.act === 'journal') openJournal({ tripId: t.id });
    if (b.dataset.act === 'deltrip') { if (b.dataset.c) { trashPut('trip', t); S.db.trips = S.db.trips.filter(x => x !== t); markDirty(); S.trip = null; renderTrips(); toast('여행 삭제 — 설정 › 휴지통에서 30일 안에 복원 가능'); } else { b.dataset.c = 1; b.textContent = '정말 삭제? (한 번 더)'; setTimeout(() => { if (b.isConnected) { delete b.dataset.c; b.textContent = '여행 삭제'; } }, 4000); } return; }
    if (b.dataset.act === 'replan') openPlanner({ tripId: t.id, title: t.title, region: t.plan.region, start: t.plan.start, days: t.plan.days, maxSpots: t.plan.maxSpots, spots: t.plan.spots, dayOrders: t.plan.dayOrders, stayOverride: t.plan.stayOverride, forceMeals: t.plan.forceMeals, area: t.plan.area, autoFill: t.plan.autoFill, lodge: t.plan.lodge, radiusKm: t.plan.radiusKm, candPick: t.plan.candPick, mealKm: t.plan.mealKm, zone: t.plan.zone, country: t.plan.country });
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
function guideData(t) {                                          // trip-guide-html v2 입력 스키마(2-1절)
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
  return { out, base, trip, places };
}
/* ---------------- 간이 안내서 (앱에서 바로 HTML · trip-guide-html v2 템플릿, 조사 섹션 없이) ---------------- */
const G_MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const G_COUNTRY_KO = { AU: '호주', VN: '베트남', JP: '일본', TH: '태국', US: '미국', GU: '괌', KR: '한국' };
async function toDataUri(src, side = 1600, q = 0.82) {          // 사진 → data URI (크면 축소)
  if (!src) return ''; if (src.startsWith('data:') && src.length < 400000) return src;
  try {
    const r = await fetch(src); if (!r.ok) return ''; const blob = await r.blob();
    const bmp = await createImageBitmap(blob); const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    if (k === 1 && blob.size < 450000) return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } catch { return ''; }
}
async function textOf(path, embedKey) { if (window[embedKey]) return window[embedKey]; const r = await fetch(path); if (!r.ok) throw new Error(path + ' ' + r.status); return r.text(); }
async function buildGuideHtml(t, onStep = () => {}) {
  const { out } = guideData(t); const trip = out.trip, base = out.base || {}, OV = out.mode === 'overseas';
  const hoursText = h => !h ? '' : typeof h === 'string' ? h : h.text || [h.open && h.close ? `${h.open}–${h.close}` : '', (h.closed || []).length ? `휴무 ${h.closed.join('·')}` : ''].filter(Boolean).join(' · ');
  const hasLL = p => typeof p.lat === 'number' && typeof p.lng === 'number';
  // 사진: 가족 사진 → 관광공사 → (여행 표지 · 계절 사진)
  const coverKey = Object.keys(TRIP_COVER).find(k => (trip.city || '').includes(k));
  onStep('표지 사진');
  const heroImg = await toDataUri(asset(coverKey ? `assets/trip-cover-${TRIP_COVER[coverKey]}.jpg` : `assets/hero-${SEASON_EN[seasonNow(trip.start ? new Date(trip.start + 'T00:00:00') : new Date())]}.jpg`), 2560, 0.84);
  const P = {}; const byName = {};
  const itemIds = new Set(trip.items.map(i => i.place_id).filter(Boolean));
  let n = 0; const total = out.places.filter(p => p.type !== 'restaurant').length;
  for (const p of out.places) {
    let photo = '', credit = '';
    if (p.type !== 'restaurant' || itemIds.has(p.id)) {             // 식당 사진은 일정에 있는 곳만 (용량)
      if (p.type !== 'restaurant') onStep(`사진 ${++n}/${total}`);
      if (p.photo) { photo = await toDataUri(p.photo); credit = photo ? '가족 사진' : ''; }
      if (!photo && p.basePhoto?.path) { photo = await toDataUri(p.basePhoto.path); credit = photo ? '한국관광공사' : ''; }
    }
    const q = { ...p, _photo: photo, _credit: credit }; P[p.id] = q; byName[p.name] = q;
  }
  // 일정
  const order = [], days = {}; for (const it of trip.items) { const lab = it.day || 'Day 1'; if (!days[lab]) { days[lab] = []; order.push(lab); } days[lab].push(it); }
  const itin = [], dayPhotos = [], appear = {};
  order.forEach((lab, di) => { const evs = [], route = []; let photo = '';
    for (const it of days[lab]) { const p = it.place_id ? P[it.place_id] : byName[it.place || ''];
      const desc = [it.place && !(it.activity || '').includes(it.place) ? it.place : '', it.note || ''].filter(Boolean).join(' · ');
      const visited = !!(p && (p.visitLog || []).length); evs.push(visited ? [it.time || '', it.activity || '', desc, true] : [it.time || '', it.activity || '', desc]);
      if (p) { appear[p.id] ||= `DAY ${di + 1} · ${lab}`; if (!route.includes(p.name)) route.push(p.name); photo ||= p._photo; } }
    itin.push({ title: evs.filter(e => e[1] && !/^(출발|귀가|숙소|이동)/.test(e[1])).slice(0, 2).map(e => e[1]).join(' · ') || evs.slice(0, 2).map(e => e[1]).join(' · '), level: '', events: evs, route: base.name && route.length ? [base.name, ...route, base.name] : route, notes: '' });
    dayPhotos.push(photo || heroImg); });
  const start = trip.start || '', end = trip.end || start;
  // 목적지
  const guide = Object.values(P).filter(p => p.type !== 'restaurant' && (itemIds.has(p.id) || !OV)).map(p => ({ tab: p.name.split(' · ')[0].slice(0, 14), name: p.name, en: '', when: appear[p.id] || (p.tags || []).join(' · '),
    dest: p.name + (p.addr ? ' ' + p.addr : ''), lat: hasLL(p) ? p.lat : null, lng: hasLL(p) ? p.lng : null, img: p._photo || heroImg,
    intro: [p.signature, p.addr, p._credit ? `사진 ${p._credit}` : ''].filter(Boolean), facts: [p.hours ? { k: '영업', v: hoursText(p.hours) } : null, !OV && p.parking?.type ? { k: '주차', v: p.parking.type } : null, (p.tags || []).length ? { k: '태그', v: p.tags.map(x => '#' + x).join(' ') } : null].filter(Boolean),
    how: [], see: [], tip: (p.visitLog || []).slice(-1).map(v => v.memo ? `우리 기록: “${v.memo}”` : '')[0] || '', booking: [], bookingNote: '' }));
  // 식당
  const rest = Object.values(P).filter(p => p.type === 'restaurant').map(p => { const km = p.km ?? (hasLL(p) && base.lat != null ? Math.round(haversine(base, p) * 10) / 10 : null);
    return [p.area || trip.city || '', p.name, p.name, p.cuisine ? p.cuisine.split(', ') : ['기타'], p.signature || '', p.addr || '', km, p.min ?? (km != null ? Math.round(km * 3 + 3) : null), (p.tags || []).join(' · '), p.q || p.name, hasLL(p) ? p.lat : null, hasLL(p) ? p.lng : null]; });
  const rcats = [...new Set(rest.flatMap(r => r[3]))].sort();
  const parking = OV ? [] : Object.values(P).filter(p => p.parking?.type).map(p => ({ k: p.name, v: [p.parking.type, p.parking.fee].filter(Boolean).join(' · ') || '주차 정보', sub: [p.parking.crowd, p.parking.note, (p.parking.lots || []).map(l => typeof l === 'string' ? l : l.name).join(' / ')].filter(Boolean).join(' · ') }));
  // 표지·브랜드
  onStep('로고·글꼴');
  const d2 = s => { const d = s ? new Date(s + 'T00:00:00') : null; return d && !isNaN(d) ? d : null; }; const sd = d2(start), ed = d2(end);
  const hrange = sd && ed ? `${String(sd.getDate()).padStart(2, '0')} ${G_MON[sd.getMonth()]} — ${String(ed.getDate()).padStart(2, '0')} ${G_MON[ed.getMonth()]} ${ed.getFullYear()}` : '';
  const FLIGHT = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{2,4}\b/;
  const tt = trip.items.filter(it => it.time && FLIGHT.test(`${it.activity || ''} ${it.note || ''}`)).slice(0, 8).map(it => ({ k: it.activity, v: it.time, d: it.day }));
  const nights = sd && ed ? Math.max(0, Math.round((ed - sd) / 864e5)) : 0;
  const who = [trip.travelers?.length ? `${trip.travelers.length}명 (${trip.travelers.join(' + ')})` : '', sd && ed ? `${trip.city} ${nights}박` : '', base.name || ''].filter(Boolean).join(' · ');
  const brand = { logo: await toDataUri(asset('assets/logo-header.png'), 600), globe: OV ? await toDataUri(asset('assets/mark-globe.png'), 600) : '', stamp: await toDataUri(asset('assets/mark-stamp.png'), 600) }; brand.noStamp = !brand.stamp;
  const img = {}; for (const k of ['hero', 'prepare', 'phrases', 'missions', 'info', 'restaurants', 'tickets', 'docs']) img[k] = heroImg || dayPhotos[0] || '';
  const pages = [['Home', 0], ['Before You Go', 3], ['Itinerary', 1]]; if (guide.length) pages.push(['Destinations', 2]); if (rest.length) pages.push(['Restaurants', 7]); pages.push(['Info', 6]);
  const view = { brand, img, heroRange: hrange, heroCity: trip.city || '', heroTagline: trip.title || '', heroDesc: '', heroFoot: who, timetable: tt,
    planLabel: '계획 기준', transitFoot: '요금·소요시간은 대략값 · 지도 버튼은 인터넷 연결 필요', hasTransit: false, gMapLabel: '숙소에서 길찾기 ↗', eatNote: '영업시간·위치는 방문 전 지도 앱에서 재확인',
    prepareSub: '날씨·준비물은 출발 전 확인', hasBio: false, bioEn: '', bioTitle: '', bioNote: '', budgetSub: '현지 지출 기준', budgetNote: '', principles: [], principlesSub: '이번 일정의 기준',
    phrasesTitle: '', phrasesSub: '', missionTitle: '여행 미션', missionSub: '여행하면서 하나씩 체크',
    transfers: base.name ? [{ k: '숙소', title: base.name, lines: [base.addr].filter(Boolean), note: '', link: '', linkLabel: '' }] : [], transfersSub: '이동은 편하게, 예약은 명확하게',
    hasPay: false, payTitle: '', paySub: '', payNote: '', hasParking: !!parking.length, parkingNote: '주차 요금·혼잡도는 방문 전 지도 앱에서 재확인', sosNote: '휴대폰에 저장 + 종이로 한 장 출력해 가방에 보관',
    hasOps: false, opsTitle: '운영 확인', opsText: '', opsLinks: [], foodTitle: 'Local Food', foodSub: '꼭 먹어 볼 음식', foodNote: '맛집 위치는 Restaurants 탭 참고',
    restTitle: '구역별 식당 정리 · 일정이 바뀌어도 근처에서 고르기', restSub: '상호·주소 옆 복사 버튼 → 지도·택시 앱에 붙여넣기', distHead: '숙소에서', restFoot: '영업시간·위치는 방문 전 지도 앱에서 재확인',
    ticketGroups: [], ticketsSub: '', docLead: '', visaEn: '', visaTitle: '', visaSource: '', returnTitle: '귀국', hasVisa: false, hasArrival: false, hasPax: false, hasDecl: false, hasReturn: false, hasRefs: false,
    footCity: trip.city || '', footRange: (start ? start.replace(/-/g, '.') + '–' + (end || '').slice(5).replace(/-/g, '.') : '') + (trip.title ? ' · ' + trip.title : ''), footCredits: '사진: 우리 가족 · 한국관광공사 · 준준 TRIP' };
  const TRIP = { id: trip.id || 'trip', mode: out.mode, start, end, itin, labels: order, dayPhotos, tasks: [], tasksDone: [], pack: [], missions: [], facts: [], bio: [], budget: [],
    fx: OV ? { cur: '', rate: 1 } : { cur: '', rate: 1 }, contacts: [], rest, rcats, hotel: base.name || '', guide, guideFood: {}, phrases: [], transit: {}, infoTabs: [{ key: 'move', label: '이동 · 숙소' }, { key: 'sos', label: '비상 연락' }],
    extras: [], pay: [], parking, food: [], football: { title: '', lead: '', intro: '', labels: {}, record: [], history: [], clubs: [], players: [], legends: [], korea: [], recordNote: '', playersNote: '' },
    arrivalCard: [], travelers: [], declarations: [], refs: [], returnInfo: [], eta: { summary: '', tips: '', steps: [] }, docNote: '', pages, view };
  onStep('템플릿');
  let html = await textOf('guide/template.html', 'EMBED_GUIDE_TPL'); const tokens = await textOf('tokens.css', 'EMBED_TOKENS').catch(() => '');
  html = html.replace('__TRIP_DATA__', () => JSON.stringify(TRIP).replace(/<\//g, '<\\/')).replace('__TITLE__', () => (trip.title || trip.city || '여행 안내서').replace(/</g, '')).replace('/*__TOKENS_OVERRIDE__*/', () => tokens);
  return { html, fname: `${today().replace(/-/g, '.')}_${(trip.city || 'Trip').replace(/[\\/:*?"<>|\s]+/g, '_')}_Travel_Offline_간이.html` };
}
async function exportGuideHtml(t, btn) {
  const lab = btn?.textContent; const step = s => { if (btn) btn.textContent = `만드는 중… ${s}`; };
  if (btn) btn.disabled = true;
  try { const { html, fname } = await buildGuideHtml(t, step); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' })); a.download = fname; document.body.appendChild(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 4000); toast(`간이 안내서 저장: ${fname} (${(html.length / 1e6).toFixed(1)}MB)`, 3500); }
  catch (err) { toast('안내서 만들기 실패: ' + err.message, 4000); }
  if (btn) { btn.disabled = false; btn.textContent = lab; }
}
function openGuideMenu(t) {                                      // 안내서: 간이(앱에서 바로 HTML) / 완성본(클로드 + 스킬)
  openSheet(`<div class="ks-sheet"><div class="hd"><button class="back" data-act="close">‹</button><div style="flex:1"><p class="cap3">${esc(tripCity(t))} · 오프라인 HTML</p><b>안내서 만들기</b></div></div>
    <div class="ks-body">
      <div class="grp" style="margin:0"><div style="flex-direction:column;align-items:stretch;gap:8px"><span><b>간이 안내서 · 바로 받기</b><p class="cap3">일정 · 목적지 · 식당 · 주차 · 우리 기록 · 사진(가족 → 관광공사 → 여행 표지). 인터넷 없이 열림. 준비물·현지 정보 같은 조사 내용은 없음</p></span><button class="btn pri" data-act="ghtml">HTML 바로 받기</button></div>
        <div style="flex-direction:column;align-items:stretch;gap:8px"><span><b>완성본 · 클로드에게 맡기기</b><p class="cap3">간이 내용 + 준비물·날씨·교통·현지 정보·관심사 탭까지 조사해서 시드니 안내서 수준으로. JSON 받아 클로드 대화에 첨부</p></span><button class="btn line" data-act="gjson">JSON + 요청문 받기</button></div></div>
    </div></div>`);
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'close') closeSheet(); if (b.dataset.act === 'ghtml') exportGuideHtml(t, b); if (b.dataset.act === 'gjson') exportGuideJson(t); };
}
function exportGuideJson(t) {                                    // 안내서용 JSON (클로드 + trip-guide-html 스킬로 완성본)
  const { out, base, trip, places } = guideData(t);
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
/* ---------------- 지난 여행 간단 기록 (기간·동네·사진만) + 여행 사진 ---------------- */
async function readPhotos(files) {                                  // 파일 → { b64, url, date(EXIF/파일 날짜) }
  const out = []; for (const f of [...files]) { try { const ex = exifDate(await f.slice(0, 256 * 1024).arrayBuffer()); const b64 = await resizeImage(f); const lm = f.lastModified ? new Date(f.lastModified) : null;
    out.push({ b64, url: 'data:image/jpeg;base64,' + b64, date: ex || (lm ? lm.toISOString().slice(0, 10) : null) }); } catch { toast('사진을 읽지 못했습니다'); } } return out;
}
async function uploadPhotos(list, dir, opt = {}) {                  // → [{ path, date, who }] · opt: { who:[], toGrowth, memo, onStep }
  const res = []; S.db.growth ||= [];
  for (const [i, x] of list.entries()) { opt.onStep?.(i + 1, list.length); let path = null;
    if (S.token && !OFFLINE) { try { path = await ghPutFile(`photos/${dir}/${x.date || today()}_${Date.now().toString(36)}_${i}.jpg`, x.b64, `jjtrip: ${dir}`); } catch (err) { toast('사진 업로드 실패: ' + err.message, 3500); } }
    if (!path) { const local = LS.get('photos', {}); path = `local:${dir.replace(/\//g, ':')}:${Date.now().toString(36)}${i}`; local[path] = x.url; try { LS.set('photos', local); } catch { toast('이 기기 저장 공간 부족 — 사진 생략'); continue; } }
    res.push({ path, date: x.date || null, who: opt.who || [] });
    if (opt.toGrowth && (opt.who || []).length) S.db.growth.push({ id: uid('g'), who: opt.who, date: x.date || null, photo: path, memo: opt.memo || null }); }
  return res;
}
function photoPickerHtml(id) {                                       // 사진 고르기 + 누구 + 성장 앨범 체크 (공통 조각)
  return `<div class="lv-phs" id="${id}-phs"></div><button type="button" class="btn-line" data-pp="${id}" style="width:100%;margin-top:8px">＋ 사진 고르기</button><input type="file" id="${id}-file" accept="image/*" multiple hidden>
    <div class="lv-gr"><span class="cap3">함께 간 사람 · 사진에 나온 사람 (선택)</span><div class="chips" id="${id}-who">${familyNames().map(n => `<button type="button" class="chip" data-ppw="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <label class="ti-chk"><input type="checkbox" id="${id}-gr" checked> 고른 사람의 🌱 성장 앨범에도 넣기</label></div>`;
}
function bindPhotoPicker(id) {                                       // → { list, who:Set, draw }
  const st = { list: [], who: new Set() };
  st.draw = () => { $(`#${id}-phs`).innerHTML = st.list.map((x, i) => `<div class="lv-ph new" style="background-image:url('${x.url}')"><small>${esc((x.date || '').replace(/-/g, '.'))}</small><button type="button" data-pprm="${i}">✕</button></div>`).join(''); };
  $(`#${id}-file`).onchange = async e => { $(`#${id}-phs`).dataset.busy = '사진 읽는 중…'; st.list.push(...await readPhotos(e.target.files)); delete $(`#${id}-phs`).dataset.busy; st.draw(); e.target.value = ''; };
  st.click = b => { if (b.dataset.pp === id) { $(`#${id}-file`).click(); return true; } if (b.dataset.ppw) { st.who.has(b.dataset.ppw) ? st.who.delete(b.dataset.ppw) : st.who.add(b.dataset.ppw); b.classList.toggle('on'); return true; } if (b.dataset.pprm != null) { st.list.splice(+b.dataset.pprm, 1); st.draw(); return true; } return false; };
  return st;
}
async function openTripForm() {                                     // 여행 추가: 간단 기록 (옛날 여행은 일정 없이 기간·동네·사진만)
  await loadGeo(); const loc = {};
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">취소</button><b>여행 추가</b><button class="lnk pri" data-act="tfsave">저장</button></div><div class="vf-scroll" style="padding:16px">
    <p class="cap3">일정 정리가 없는 옛날 여행도 기간·동네·사진만으로 남길 수 있어요 (일정은 나중에 추가 가능)</p>
    <div class="ti-f" style="margin-top:8px"><label>제목</label><input id="tf-title" placeholder="예: 2010 신혼여행 · 피렌체"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px"><div class="ti-f"><label>나라</label><select id="tf-cc">${countryOptions('KR')}</select></div><div class="ti-f"><label>도시·동네</label><input id="tf-city" placeholder="예: 피렌체 · 강릉 경포"></div></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button type="button" class="btn-line" data-act="tffind" style="flex:none;padding:0 14px">📍 위치 찾기</button><p class="cap3" id="tf-pos" style="margin:auto 0">지도에 표시할 위치 (선택)</p></div><div id="tf-hits" class="lv-hits"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px"><div class="ti-f"><label>시작일</label><input id="tf-s" type="date" max="${today()}"></div><div class="ti-f"><label>마지막 날</label><input id="tf-e" type="date"></div></div>
    <div class="vsec" style="margin-top:14px"><h4>사진 <span class="cap3">촬영일 자동 · 장수 제한 없음</span></h4>${photoPickerHtml('tfp')}</div>
    <div class="vsec"><h4>한 줄 메모 <span class="cap3">선택</span></h4><input id="tf-memo" class="vmemo" style="min-height:0;height:40px" placeholder="예: 비 오던 두오모 앞"></div></div>
    <div class="vf-foot"><button class="btn-pri" data-act="tfsave">여행 저장</button></div></div>`);
  const pp = bindPhotoPicker('tfp');
  $('#sheet-inner').onclick = async e => { const b = e.target.closest('button'); if (!b) return; if (pp.click(b)) return; const act = b.dataset.act;
    if (act === 'back') return closeSheet();
    if (act === 'tffind') { const q = $('#tf-city').value.trim(); if (!q) return toast('도시·동네를 먼저 입력하세요'); const box = $('#tf-hits'); box.innerHTML = '<div class="help">찾는 중…</div>'; const hits = await addrSearch(q, $('#tf-cc').value); S.tfHits = hits;
      box.innerHTML = hits.length ? hits.slice(0, 5).map((x, i) => `<button class="lv-hit" data-tfh="${i}"><b>${esc(x.name)}</b><small>${esc(x.address || '')}</small></button>`).join('') : '<div class="help">못 찾았어요 — 위치 없이 저장해도 됩니다 (지도엔 나라 가운데 표시)</div>'; return; }
    if (b.dataset.tfh != null) { const x = S.tfHits[+b.dataset.tfh]; Object.assign(loc, { lat: x.lat, lng: x.lng }); const c2 = ccAt(x.lat, x.lng); if (c2 && $('#tf-cc').querySelector(`option[value="${c2}"]`)) $('#tf-cc').value = c2; $('#tf-pos').textContent = `위치: ${x.name}`; $$('.lv-hit').forEach(y => y.classList.toggle('on', y === b)); return; }
    if (act === 'tfsave') {
      const city = $('#tf-city').value.trim(), s0 = $('#tf-s').value, e0 = $('#tf-e').value || s0; if (!city) return toast('도시·동네를 입력하세요'); if (!s0) return toast('시작일을 넣어주세요 (대략이라도)');
      $$('[data-act=tfsave]').forEach(x => { x.disabled = true; });
      const t = { id: 'trip' + uid(''), title: $('#tf-title').value.trim() || `${s0.slice(0, 4)} ${city}`, city, country: $('#tf-cc').value, year: +s0.slice(0, 4), start: s0, end: e0 < s0 ? s0 : e0, memo: $('#tf-memo').value.trim() || null, items: [], ...(loc.lat != null ? loc : {}) };
      t.photos = await uploadPhotos(pp.list, `trips/${t.id}`, { who: [...pp.who], toGrowth: $('#tfp-gr').checked, memo: t.title, onStep: (i, n) => { $('.vf-foot .btn-pri').textContent = `사진 올리는 중 ${i}/${n}`; } });
      S.db.trips.push(t); markDirty(); closeSheet(); S.trip = t; S.tripDay = 0; showView('trips'); renderTrips(); tripTitle(t); toast('여행 저장');
    }
  };
}
function openTripPhotos(t) {                                         // 여행에 사진 추가
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">취소</button><b>${esc(tripCity(t))} 사진 추가</b><button class="lnk pri" data-act="tpsave">저장</button></div><div class="vf-scroll" style="padding:16px">${photoPickerHtml('tpp')}</div>
    <div class="vf-foot"><button class="btn-pri" data-act="tpsave">사진 저장</button></div></div>`);
  const pp = bindPhotoPicker('tpp');
  $('#sheet-inner').onclick = async e => { const b = e.target.closest('button'); if (!b) return; if (pp.click(b)) return;
    if (b.dataset.act === 'back') { closeSheet(); return; }
    if (b.dataset.act === 'tpsave') { if (!pp.list.length) return toast('사진을 골라주세요'); $$('[data-act=tpsave]').forEach(x => { x.disabled = true; });
      const add = await uploadPhotos(pp.list, `trips/${t.id}`, { who: [...pp.who], toGrowth: $('#tpp-gr').checked, memo: t.title || tripCity(t), onStep: (i, n) => { $('.vf-foot .btn-pri').textContent = `사진 올리는 중 ${i}/${n}`; } });
      t.photos = [...(t.photos || []), ...add].sort((a, c) => (a.date || '').localeCompare(c.date || '')); markDirty(); closeSheet(); renderTrips(); toast(`사진 ${add.length}장 추가`); }
  };
}
function tripPhotosHtml(t) {
  const ps = (t.photos || []).filter(x => photoUrl(x.path)); const noItems = !(t.items || []).length;
  if (!ps.length && !noItems) return '';
  return `<div class="tp-gal">${noItems ? `<div class="tp-simple"><b>${esc(t.title || tripCity(t))}</b><p class="cap">${esc([t.start ? t.start.replace(/-/g, '.') + (t.end && t.end !== t.start ? ' — ' + t.end.slice(5).replace('-', '.') : '') : t.year, tripCity(t), ccKo(t.country)].filter(Boolean).join(' · '))}</p>${t.memo ? `<p class="serif tp-memo">“${esc(t.memo)}”</p>` : ''}</div>` : ''}
    ${ps.length ? `<div class="tp-ph">${ps.map((x, i) => `<button data-tplb="${i}" style="background-image:url('${photoUrl(x.path)}')"><small>${esc((x.date || '').slice(5).replace('-', '.'))}</small></button>`).join('')}</div>` : '<div class="help">사진이 아직 없어요 — 아래 「📷 사진 추가」</div>'}</div>`;
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
function photoCount() { return S.db.places.reduce((n, p) => n + (p.visitLog || []).reduce((m, v) => m + visitPhotos(v).length, 0), 0); }
async function repoUsage() {                                     // GitHub 저장소 용량 (KB, 이력 포함) — 공개 저장소라 토큰 없이 조회
  if (OFFLINE) return null; const c = LS.get('repoUsage', null); if (c && Date.now() - c.t < 6 * 3600e3) return c;
  try { const r = await fetch('https://api.github.com/repos/' + (S.repo || CFG.repo)); if (!r.ok) return c; const j = await r.json(); const u = { mb: (j.size || 0) / 1024, t: Date.now() }; LS.set('repoUsage', u); return u; } catch { return c; }
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
      <button data-act="season"><span style="flex:1;text-align:left">계절 메인 배경</span><span class="cap">${esc(seasonTxt)} ›</span></button><button data-act="heropick"><span style="flex:1;text-align:left">배경 사진 고르기<p class="cap3">계절별 기본 + 추천 5장 + 내 사진</p></span><span class="cap">${Object.keys(S.db.meta.hero || {}).length ? '변경됨' : '기본'} ›</span></button></div>
    <div class="gt">데이터</div>
    <div class="grp">
      <button data-act="xlsx"><span style="flex:1;text-align:left">엑셀로 내보내기<p class="cap3">원본 양식 · 장소 ${S.db.places.length} · 여행 ${S.db.trips.length}</p></span><span class="cap num">.xlsx</span></button>
      <button data-act="export"><span style="flex:1;text-align:left">JSON 백업</span><span class="cap num">.json</span></button>
      <label class="st-import"><span style="flex:1;text-align:left">JSON 불러오기<p class="cap3">백업 파일로 전체 교체</p></span><span class="cap num">.json</span><input type="file" id="s-import" accept=".json" hidden></label>
      <button data-act="theme"><span style="flex:1;text-align:left">다크모드</span><span class="cap">${themeTxt} ›</span></button>
      <button data-act="usage"><span style="flex:1;text-align:left">저장 공간<p class="cap3" id="st-usage">사진 ${photoCount()}장 · 저장소 용량 확인 중…</p></span><span class="cap num" id="st-usage-v">/ 1GB</span></button>
      <button data-act="trash"><span style="flex:1;text-align:left">휴지통<p class="cap3">삭제한 장소·여행 30일 보관 · 복원 가능</p></span><span class="cap num">${(S.db.trash || []).length}</span></button>
      <button data-act="naver"><span style="flex:1;text-align:left">네이버 전국 맛집 지도<p class="cap3">MY플레이스 리스트 링크 · 상세의 N저장✔ 연동</p></span><span class="cap">${S.db.meta.naverListUrl ? '열기 ›' : '미입력'}</span></button>
      ${OFFLINE ? '' : `<button data-act="reload"><span style="flex:1;text-align:left">다시 불러오기<p class="cap3">갱신 ${esc(S.db.meta.updated || '')}</p></span><span class="cap">↻</span></button>`}</div>
    <p class="cap3 st-foot">준준 TRIP · 키는 기기 브라우저에만 저장 · 데이터는 GitHub <span class="num">${esc(S.repo)}</span></p>`;
  repoUsage().then(u => { const a = $('#st-usage'), b = $('#st-usage-v'); if (!a) return; if (!u) { a.textContent = `사진 ${photoCount()}장 · 저장소 용량 확인 실패 (잠시 후 다시)`; return; } const pct = u.mb / 1024 * 100; a.textContent = `사진 ${photoCount()}장 · 저장소 ${u.mb.toFixed(0)}MB (이력 포함) · GitHub 권장 1GB`; b.textContent = `${pct.toFixed(1)}%`; if (pct > 80) { b.style.color = 'var(--danger)'; a.textContent += ' · 정리 필요'; } });
  el.onclick = async e => {
    const edit = e.target.closest('[data-bedit]'); if (edit) { e.stopPropagation(); openBaseForm(S.db.bases.find(x => x.id === edit.dataset.bedit)); return; }
    const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
    if (b.dataset.key) { b.dataset.key === 'tourapi' ? openTourApiInfo() : openKeySheet(b.dataset.key); return; }
    if (b.dataset.base) { setBase(b.dataset.base); renderSettings(); return; }
    if (act === 'family') openFamilyEdit();
    if (act === 'baseadd') openBaseForm();
    if (act === 'heropick') return openHeroPicker();
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
function storyHtml(t) { return String(t || '').split(/\n{2,}/).map(par => `<p>${esc(par).replace(/\n/g, '<br>')}</p>`).join(''); }
async function copyStoryKit(list, trip) {                         // 여행기 본문 재료 → 클로드에 붙여 블로그 글쓰기 스킬로 다듬기 (준준트립 기록용)
  list = (list || []).filter(Boolean); if (!list.length) return toast('기록이 없습니다');
  const leg = p => { const b = baseFor ? baseFor(p) : S.base; return b && hasCoord(b) && hasCoord(p) ? `${b.name}에서 약 ${fmtKm(haversine(b, p))}km` : ''; };
  const lines = list.slice().sort((a, b) => (a.v.date || '').localeCompare(b.v.date || '')).map(({ p, v }) => [
    `■ ${v.date || '날짜 미상'}${v.meal ? ' ' + v.meal : ''} · ${p.name} (${[kindLabel(p), areaOf(p)].filter(Boolean).join(' · ')})`,
    p.address ? `- 주소: ${p.address}` : '', leg(p) ? `- 거리: ${leg(p)}` : '',
    v.rating ? `- 우리 별점: ${v.rating}/5` : '', (v.who || []).length ? `- 함께 간 사람: ${v.who.join(', ')}` : '',
    (v.menu || []).length ? `- 먹은 메뉴: ${v.menu.map(x => typeof x === 'string' ? x : x.name).join(', ')}` : '',
    v.memo ? `- 한줄평: ${v.memo}` : '', p.desc ? `- 장소 메모: ${p.desc}` : '', visitPhotos(v).length ? `- 사진 ${visitPhotos(v).length}장` : '',
    v.story ? `- 지금 적어둔 본문:\n${v.story}` : ''].filter(Boolean).join('\n')).join('\n\n');
  const txt = `블로그 글쓰기 스킬(naver-blog-writer)의 문장 다듬기로, 아래 기록을 우리 가족 여행 앱 「준준 TRIP」에 넣을 여행기 본문으로 써줘.
- 용도: 가족끼리 보는 기록 (외부 블로그 게시 X)
- 톤: 가족 여행기, 따뜻하고 담백하게 · 존댓말 X(일기체)
- 길이: 기록 1개당 500~800자 · 문단은 빈 줄로 구분
- 제외: 검색 노출용 키워드 반복·해시태그·소제목 남발·광고 문구·사실이 아닌 내용 지어내기
- 사진은 넣지 말 것 (앱에 이미 있음)
- 결과: 기록별로 「■ 날짜 · 장소」 아래 본문만 출력 → 앱의 「여행기 본문」 칸에 붙여넣을 예정
${trip ? `\n[여행] ${tripCity(trip)} ${trip.year || ''}\n` : ''}
${lines}`;
  try { await navigator.clipboard.writeText(txt); toast(`여행기 재료 ${list.length}건 복사 · 클로드 대화에 붙여넣으세요`, 3500); }
  catch { const w = document.createElement('textarea'); w.value = txt; document.body.appendChild(w); w.select(); try { document.execCommand('copy'); toast('여행기 재료 복사'); } catch { prompt('아래를 복사하세요', txt); } w.remove(); }
}
const jrTabs = on => `<div class="jr-tabs"><button class="${on === 'album' ? 'on' : ''}" data-jtab="album">📷 앨범</button><button class="${on === 'growth' ? 'on' : ''}" data-jtab="growth">🌱 성장 앨범</button></div>`;
function openGrowth(opts) {
  const who = opts.gwho || ''; S.gwho = who; const box = opts.page ? $('#journal') : null;
  const n = growthEnts(who).length;
  const html = `<div class="jr-sheet"><div class="hd">${opts.page ? '' : '<button class="back" data-act="back">‹</button>'}<div style="flex:1;min-width:0"><p class="cap3">사진 ${n} · 연도순</p><b>${who ? esc(who) + ' 성장 앨범' : '우리 가족 성장 앨범'}</b></div>${jrTabs('growth')}</div><div class="jr-feed gr-feed">${growthHtml(who)}</div></div>`;
  if (box) box.innerHTML = html; else openSheet(html);
  (box || $('#sheet-inner')).onclick = e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.jtab) return openJournal({ page: opts.page, growth: b.dataset.jtab === 'growth', gwho: who });
    if (b.dataset.act === 'back') return closeSheet();
    if (b.dataset.grwho != null) return openGrowth({ ...opts, gwho: b.dataset.grwho });
    if (b.dataset.act === 'grup') return isRO() ? goToken() : openGrowthUpload(who);
    if (b.dataset.act === 'grplay') return growthPlay(who);
    if (b.dataset.act === 'grbirth') return isRO() ? goToken() : openGrowthBirth();
    if (b.dataset.gr) { const list = growthEnts(who), k = list.findIndex(g => g.id === b.dataset.gr);
      openLightbox(list.map(g => photoUrl(g.photo)), k, who || '성장 앨범');
      const lb = $('#lb'); if (lb && !isRO()) { const del = document.createElement('button'); del.className = 'lb-gr del'; del.textContent = '이 사진 앨범에서 빼기'; del.onclick = ev => { ev.stopPropagation(); if (!del.dataset.c) { del.dataset.c = 1; del.textContent = '정말 뺄까요? (원본 파일은 남음)'; return; } const cur = list[k]; S.db.growth = (S.db.growth || []).filter(g => g.id !== cur.id); markDirty(); lb.remove(); toast('성장 앨범에서 뺌'); openGrowth(opts); }; lb.appendChild(del); }
      return; }
  };
}
function openJournal(opts = {}) {
  if (opts.growth) return openGrowth(opts);
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
  const allEnts = ents;
  if (opts.post) ents = ents.filter(e => (e.v.id || '') === opts.post);   // 앨범에서 고른 글 하나
  const album = !opts.placeId && !opts.post;                             // 기록 첫 화면 = 앨범(사진 격자)
  const nPh = ents.reduce((n, e) => n + visitPhotos(e.v).length, 0);
  const title = opts.post && ents[0] ? ents[0].p.name : opts.placeId ? placeById(opts.placeId)?.name + ' 기록' : t ? `${tripCity(t)} 여행기` : '우리 가족 기록';
  const dow = d => { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? '' : ` (${DAYS[x.getDay()]})`; };
  let lastM = '';
  const cards = ents.map((e, i) => { const { p, v } = e; const ph = visitPhotos(v); const m = (v.date || '').slice(0, 7);
    const head = m !== lastM ? `<h3 class="jr-month">${m ? `${m.slice(0, 4)}년 ${+m.slice(5, 7)}월` : '날짜 없음'}</h3>` : ''; lastM = m;
    return `${head}<article class="jr-card">
      <div class="jr-body"><button class="jr-place" data-go="${p.id}">${thumbHtml(p, 'tile')}<span><b>${esc(p.name)}</b><small>${esc([kindLabel(p), areaOf(p)].filter(Boolean).join(' · '))}</small></span><i>›</i></button>
        <button class="jr-edit rw" data-edit="${i}" title="기록 편집">편집</button>
        <p class="jr-meta"><span class="num">${esc((v.date || '').replace(/-/g, '.'))}</span>${esc(dow(v.date))}${v.meal ? ' · ' + esc(v.meal) : ''}${v.rating ? ` · <span class="st">${'★'.repeat(v.rating)}<span>${'★'.repeat(5 - v.rating)}</span></span>` : ''}</p>
        ${v.memo ? `<p class="jr-memo serif">“${esc(v.memo)}”</p>` : ''}
        ${v.story ? `<div class="jr-story">${storyHtml(v.story)}</div>` : ''}
        ${(v.menu || []).length ? `<p class="jr-menu">${v.menu.map(x => `<span>${esc(typeof x === 'string' ? x : x.name || '')}</span>`).join('')}</p>` : ''}
        ${(v.who || []).length ? `<p class="jr-who">${v.who.map(n => `<span>${esc(n)}</span>`).join('')}</p>` : ''}</div>${ph.length ? `<div class="jr-phs">${opts.post && ph.length > 1 ? '<button class="jr-nav pv" data-pn="-1" title="이전 사진">‹</button><button class="jr-nav nx" data-pn="1" title="다음 사진">›</button>' : ''}${ph.map((u, k) => `<button class="jr-ph${k === 0 ? ' on' : ''}" data-lb="${i}" data-k="${k}"><img src="${u}" alt="" loading="lazy">${k === 0 ? `<img class="stamp" src="${asset('assets/mark-stamp-white.png')}" alt="">` : ''}${ph.length > 1 ? `<span class="n">${k + 1}/${ph.length}</span>` : ''}</button>`).join('')}</div>` : ''}</article>`; }).join('');   // 어디·언제 먼저, 사진은 아래
  const sb = !album && ents.length > 0 && !!(opts.sb ?? LS.get('jrSb', false)), pg = Math.max(0, Math.min(opts.pg || 0, ents.length - 1));   // 스크랩북 보기 (쪽 넘김)
  const SB_ROT = [-3, 2.5, -1.5, 3.5, -2.5, 1.5, -3.5, 2];
  const sbPage = (e, i) => { const { p, v } = e, ph = visitPhotos(v), n = ph.length;
    return `<article class="sb-page"><div class="sb-top"><span class="sb-date num">${esc((v.date || '').replace(/-/g, '.'))}${esc(dow(v.date))}${v.meal ? ' · ' + esc(v.meal) : ''}</span><img class="sb-stamp" src="${asset('assets/mark-stamp.png')}" alt=""></div>
      <h2 class="sb-title hand">${esc(p.name)}</h2><p class="sb-sub">${esc([kindLabel(p), areaOf(p)].filter(Boolean).join(' · '))}${v.rating ? ` · <span class="st">${'★'.repeat(v.rating)}</span>` : ''}</p>
      ${n ? `<div class="sb-photos ${n <= 4 ? 'n' + n : 'many'}">${ph.map((u, k) => `<button class="sb-pol" data-lb="${i}" data-k="${k}" style="--r:${SB_ROT[k % 8]}deg"><span class="tape"></span><img src="${u}" alt="" loading="lazy"><small class="hand">${k === 0 ? esc((v.date || '').slice(5).replace('-', '.')) : ''}</small></button>`).join('')}</div>` : ''}
      ${v.memo ? `<p class="sb-memo hand">“${esc(v.memo)}”</p>` : ''}${v.story ? `<div class="sb-story">${storyHtml(v.story)}</div>` : ''}
      ${(v.menu || []).length || (v.who || []).length ? `<div class="sb-foot">${(v.menu || []).map(x => `<span class="sb-ticket">${esc(typeof x === 'string' ? x : x.name || '')}</span>`).join('')}${(v.who || []).map(nm => `<span class="sb-sticker hand">${esc(nm)}</span>`).join('')}</div>` : ''}
      <button class="sb-edit rw" data-edit="${i}">편집</button></article>`; };
  const sbHtml = sb ? `${sbPage(ents[pg], pg).replace('<article class="sb-page">', `<article class="sb-page${opts.turn ? ' turn-' + opts.turn : ''}">`)}${ents.length > 1 ? `<div class="sb-nav"><button data-sbpg="${pg - 1}" ${pg ? '' : 'disabled'}>‹ 이전 쪽</button><span class="num">${pg + 1} / ${ents.length}</span><button data-sbpg="${pg + 1}" ${pg < ents.length - 1 ? '' : 'disabled'}>다음 쪽 ›</button></div>` : ''}` : '';
  const withPh = album ? ents.filter(e => visitPhotos(e.v).length) : [], noPh = album ? ents.filter(e => !visitPhotos(e.v).length) : [];
  const grid = withPh.length ? `<div class="jr-grid">${withPh.map(e => { const ph = visitPhotos(e.v); return `<button class="jr-tile" data-post="${esc(e.v.id || '')}" style="background-image:url('${ph[0]}')"><span class="ov"><b>${esc(e.p.name)}</b><small>${esc((e.v.date || '').replace(/-/g, '.'))} · ${ph.length}장</small></span>${ph.length > 1 ? '<i>❐</i>' : ''}</button>`; }).join('')}</div>` : '';
  const noPhHtml = noPh.length ? `<h3 class="jr-month">사진 없는 기록 <small>${noPh.length}</small></h3><div class="jr-nolog">${noPh.map(e => `<div class="row-nl">${thumbHtml(e.p, 'tile')}<button class="jr-place" data-post="${esc(e.v.id || '')}"><span><b>${esc(e.p.name)}</b><small>${esc([(e.v.date || '').replace(/-/g, '.'), e.v.memo ? '“' + e.v.memo + '”' : ''].filter(Boolean).join(' · '))}</small></span></button></div>`).join('')}</div>` : '';
  const chip = (k, label, on) => `<button class="chip${on ? ' on' : ''}" ${k}>${label}</button>`;
  const noLog = opts.placeId || t || who ? [] : S.db.places.filter(p => (p.visits || 0) > 0 && !(p.visitLog || []).length && (kind === 'all' || p.type === kind)).sort((a, b) => (b.visits || 0) - (a.visits || 0));   // 다녀왔지만 아직 글·사진 없는 곳
  const noLogHtml = noLog.length ? `<h3 class="jr-month">다녀온 곳 · 아직 기록 없음 <small>${noLog.length}</small></h3><div class="jr-nolog">${noLog.map(p => `<div class="row-nl">${thumbHtml(p, 'tile')}<button class="jr-place" data-go="${p.id}"><span><b>${esc(p.name)}</b><small>${esc([kindLabel(p), areaOf(p), `방문 ${p.visits}회`].join(' · '))}</small></span></button><button class="chip rw" data-addlog="${p.id}">+ 기록</button></div>`).join('')}</div>` : '';
  const box = opts.page ? $('#journal') : null;
  (opts.page ? (h => { box.innerHTML = h; }) : openSheet)(`<div class="jr-sheet${opts.post ? ' post' : ''}"><div class="hd">${opts.page && !opts.post ? '' : '<button class="back" data-act="back">‹</button>'}<div style="flex:1;min-width:0"><p class="cap3">방문 ${ents.length} · 사진 ${nPh}</p><b>${esc(title)}</b></div>${album && opts.page ? jrTabs('album') : ''}${album ? '' : `<div class="sb-tg"><button class="${sb ? '' : 'on'}" data-sbset="0">▦ 인스타</button><button class="${sb ? 'on' : ''}" data-sbset="1">✎ 스크랩북</button></div>`}${t || opts.placeId ? '' : `<button class="chip" data-act="share">공유</button>`}${!album && ents.length ? `<button class="chip" data-act="storykit" title="클로드에 붙일 여행기 재료 복사">✎ 여행기 글 만들기</button>` : ''}</div>
    ${opts.placeId || opts.post ? '' : `<div class="jr-chips">${chip('data-kind="all"', '전체', kind === 'all')}${chip('data-kind="spot"', '휴양지', kind === 'spot')}${chip('data-kind="restaurant"', '식당', kind === 'restaurant')}${chip('data-kind="mine"', '우리 장소', kind === 'mine')}<span class="sep"></span>${familyNames().map(n => chip(`data-who="${esc(n)}"`, esc(n), who === n)).join('')}</div>`}
    <div class="jr-feed">${album && opts.page ? '<section class="tm-card" id="tm-card"><div class="help">여행 지도 불러오는 중…</div></section>' : ''}${album ? grid + noPhHtml : sb ? sbHtml : cards}${album ? noLogHtml : ''}${(album ? grid || noPhHtml : cards) || noLogHtml ? '' : `<div class="empty11"><img src="${asset('assets/mark-stamp.png')}" alt=""><b>아직 기록이 없어요</b><p class="cap">장소 상세 › 「다녀왔어요 · 기록 남기기」로 사진과 한줄평을 남기면 여기에 쌓입니다</p></div>`}</div></div>`);
  if (album && opts.page) drawTravelCard();
  (box || $('#sheet-inner')).onclick = e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.pn) { const phs = [...b.parentElement.querySelectorAll('.jr-ph')], k = phs.findIndex(x => x.classList.contains('on')); phs[k]?.classList.remove('on'); phs[(k + +b.dataset.pn + phs.length) % phs.length].classList.add('on'); return; }   // PC 글 상세 사진 넘김
    if (b.dataset.jtab) return openJournal({ page: opts.page, growth: b.dataset.jtab === 'growth', gwho: S.gwho || '' });
    if (b.dataset.sbset != null) { const on = b.dataset.sbset === '1'; LS.set('jrSb', on); return openJournal({ ...opts, sb: on, pg: 0 }); }
    if (b.dataset.sbpg != null) { openJournal({ ...opts, sb: true, pg: +b.dataset.sbpg, turn: +b.dataset.sbpg > pg ? 'n' : 'p' }); (opts.page ? $('#view-journal') : $('#sheet-inner'))?.scrollTo?.(0, 0); return; }
    if (b.dataset.act === 'storykit') return copyStoryKit(sb ? [ents[pg]] : ents, t);
    if (b.dataset.act === 'back') { if (opts.post) return openJournal({ ...opts, post: null }); opts.placeId ? openDetail(opts.placeId) : closeSheet(); return; }
    if (b.dataset.post) { const r = (box || $('#sheet-inner')); openJournal({ ...opts, post: b.dataset.post }); (opts.page ? $('#view-journal') : $('#sheet-inner'))?.scrollTo?.(0, 0); return; }
    if (b.dataset.kind) return openJournal({ ...opts, kind: b.dataset.kind });
    if (b.dataset.who != null) return openJournal({ ...opts, who: who === b.dataset.who ? '' : b.dataset.who });
    if (b.dataset.go) return openDetail(b.dataset.go);
    if (b.dataset.addlog) return openVisitForm(placeById(b.dataset.addlog));
    if (b.dataset.lb != null) { const en = ents[+b.dataset.lb]; return openLightbox(visitPhotos(en.v), +(b.dataset.k || 0), `${en.p.name} · ${(en.v.date || '').replace(/-/g, '.')}`, { raws: visitRaw(en.v), date: en.v.date }); }
    if (b.dataset.edit != null) { const en = ents[+b.dataset.edit]; return openVisitForm(en.p, en.v, () => { if (opts.page) { closeSheet(); openJournal(opts); } else openJournal(opts); }); }
    if (b.dataset.act === 'share') shareLink('j', 'all', '우리 가족 기록');
  };
}
/* ---------------- 다녀온 곳 지도 · 통계 · 배지 (기록 탭 위쪽, Polarsteps 참고) ----------------
 * 경계: data/geo-world.json (Natural Earth 1:110m via world-atlas, ISC) · data/geo-kr.json (통계청 2013 시·도, southkorea-maps)
 * 모두 기존 데이터(여행 나라·장소 좌표·방문 기록·가고싶다)로 자동 계산 — 따로 입력할 것 없음
 */
const DO_KEYS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종', '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
function doKey(p) {                                               // 장소 → 17개 시·도 짧은 이름
  const d = (p.do || p.address || '').replace(/\s/g, '');
  const pairs = [['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'], ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'], ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'], ['경기', '경기'], ['강원', '강원'], ['제주', '제주'], ['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주광역', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종']];
  for (const [k, v] of pairs) if (d.startsWith(k)) return v;
  if (d === '광주') return '광주';
  if (hasCoord(p) && S.geoKr) { for (const f of S.geoKr.features) if (geoHit(f.geometry, p.lng, p.lat)) return f.properties.k; }
  return null;
}
function geoHit(g, x, y) {                                        // 점이 폴리곤 안에 있는지 (ray casting)
  const inRing = r => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  const poly = p => inRing(p[0]) && !p.slice(1).some(inRing);
  return g.type === 'Polygon' ? poly(g.coordinates) : g.coordinates.some(poly);
}
async function loadGeo() {
  if (S.geoWorld && S.geoKr) return true;
  try { const get = (f, k) => textOf('data/' + f, k).catch(() => textOf(f, k));   // data/ 폴더 우선, 루트에 올라가 있어도 동작
    const [w, k] = await Promise.all([get('geo-world.json', 'EMBED_GEO_WORLD'), get('geo-kr.json', 'EMBED_GEO_KR')]); S.geoWorld = JSON.parse(w); S.geoKr = JSON.parse(k); return true; } catch (e) { console.warn(e); return false; }
}
const OV_PIN = { GU: [13.45, 144.78], SG: [1.35, 103.82], HK: [22.32, 114.17], MO: [22.2, 113.55], MP: [15.18, 145.75] };   // 작은 섬·도시국가 (지도 경계 없음)
function geoCenter(cc) {
  if (OV_PIN[cc]) return { lat: OV_PIN[cc][0], lng: OV_PIN[cc][1] };
  const f = S.geoWorld?.features.find(x => x.properties.cc === cc); if (!f) return null;
  const pts = (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates).sort((a, b) => b[0].length - a[0].length)[0][0];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return { lat: (Math.min(...ys) + Math.max(...ys)) / 2, lng: (Math.min(...xs) + Math.max(...xs)) / 2 };
}
function travelStats() {
  const home = S.db.bases.find(b => b.id === 'b_home') || S.db.bases.find(b => b.country === 'KR');
  const visitedP = S.db.places.filter(p => (p.visitLog || []).length || p.visits > 0);
  const logs = S.db.places.flatMap(p => (p.visitLog || []).map(v => ({ p, v })));
  const ov = new Map();                                            // 해외 나라·지역: cc → { cc, state: 'done'|'plan', trips: [] }
  const tripLoc = t => { if (t.lat != null) return { lat: t.lat, lng: t.lng }; for (const it of t.items || []) { const p = it.place_id && placeById(it.place_id); if (p && hasCoord(p)) return p; } const b = S.db.bases.find(b => b.country === t.country && hasCoord(b)); return b || geoCenter(t.country); };
  for (const t of S.db.trips) { if (!t.country || t.country === 'KR') continue; const dd = dday(t); const st = dd != null && dd >= 0 ? 'plan' : 'done'; const o = ov.get(t.country) || { cc: t.country, state: st, trips: [] }; if (st === 'done') o.state = 'done'; o.trips.push({ t, st, loc: tripLoc(t) }); ov.set(t.country, o); }
  for (const p of visitedP) if (p.country && p.country !== 'KR' && !ov.has(p.country)) ov.set(p.country, { cc: p.country, state: 'done', trips: [] });
  const done = [...ov.values()].filter(o => o.state === 'done'), plan = [...ov.values()].filter(o => o.state === 'plan');
  const doCnt = {}; for (const p of visitedP) if ((p.country || 'KR') === 'KR') { const k = doKey(p); if (k) doCnt[k] = (doCnt[k] || 0) + 1; }
  for (const t of S.db.trips) if (t.country === 'KR' && (dday(t) ?? -1) < 0) for (const it of t.items || []) { const p = it.place_id && placeById(it.place_id); const k = p && doKey(p); if (k && !doCnt[k]) doCnt[k] = 1; }
  const saved = {}; for (const p of S.db.places) if ((p.country || 'KR') === 'KR' && p.type !== 'mine') { const k = doKey(p); if (k) saved[k] = (saved[k] || 0) + 1; }
  let km = 0; if (home && hasCoord(home)) { for (const { p } of logs) if (hasCoord(p)) km += haversine(home, p) * 2; for (const o of done) for (const x of o.trips) if (x.st === 'done' && x.loc) km += haversine(home, x.loc) * 2; }
  const fam = familyNames(), seasons = new Set(logs.map(({ v }) => v.date && seasonNow(new Date(v.date + 'T00:00:00'))).filter(Boolean));
  const txt = p => [p.name, p.desc, p.pros, ...(p.tags || [])].join(' ');
  return { home, visitedP, logs, done, plan, doCnt, saved, km: Math.round(km), seasons, photos: photoCount(),
    sea: visitedP.filter(p => /바다|해변|해수욕장|비치|섬|항구|해안|갯벌/.test(txt(p))).length,
    mount: visitedP.filter(p => /산|숲|수목원|계곡|휴양림|오름/.test(txt(p))).length,
    regular: S.db.places.filter(p => (p.visitLog || []).length >= 3 || p.visits >= 3).length,
    together: logs.filter(({ v }) => fam.length && fam.every(n => (v.who || []).includes(n))).length };
}
function badgeList(s) {
  const nDo = Object.keys(s.doCnt).length, nOv = s.done.length;
  const B = (ico, name, cur, goal, hint) => ({ ico, name, cur: Math.min(cur, goal), goal, ok: cur >= goal, hint });
  return [B('✎', '첫 기록', s.logs.length, 1, '방문 기록 1개'), B('✈', '첫 해외', nOv, 1, '해외 1곳'), B('▦', '사진 10장', s.photos, 10, '기록 사진'),
    B('◔', '도 3곳', nDo, 3, '시·도'), B('◑', '도 9곳', nDo, 9, '시·도'), B('●', '전국 정복', nDo, 17, '17개 시·도 모두'),
    B('🌏', '3개국', nOv, 3, '해외 나라·지역'), B('🌍', '5개국', nOv, 5, '해외 나라·지역'), B('🌎', '10개국', nOv, 10, '해외 나라·지역'),
    B('≈', '바다 5곳', s.sea, 5, '바다·섬·해변'), B('▲', '산·숲 5곳', s.mount, 5, '산·숲·수목원'), B('❀', '사계절', s.seasons.size, 4, '봄·여름·가을·겨울 기록'),
    B('♥', '단골', s.regular, 1, '같은 곳 3번'), B('☺', '온 가족 10번', s.together, 10, '4명 모두 함께 간 기록')];
}
function travelCardHtml(s, mode) {
  const nDo = Object.keys(s.doCnt).length, nOv = s.done.length, pct = (nOv + 1) / 195 * 100;
  const notYet = DO_KEYS.filter(k => !s.doCnt[k]).sort((a, b) => (s.saved[b] || 0) - (s.saved[a] || 0));
  const bs = badgeList(s), got = bs.filter(b => b.ok).length;
  return `<div class="tm-hd"><div><p class="cap3">다녀온 곳</p><b class="serif">우리 가족 여행 지도</b></div>
      <div class="tm-hdr"><button class="tm-lvb" data-act="lived">⌂ 살았던 곳 <b>${(S.db.lived || []).length}</b></button><div class="tm-tg"><button class="${mode === 'kr' ? 'on' : ''}" data-tm="kr">국내</button><button class="${mode === 'world' ? 'on' : ''}" data-tm="world">세계</button><button class="${mode === 'globe' ? 'on' : ''}" data-tm="globe">🌐 지구본</button></div></div></div>
    <div class="tm-body"><div class="tm-map" id="tm-map"></div>
      <div class="tm-side">
        <div class="tm-stats">
          <div><b class="num">${nDo}<small>/17</small></b><span>국내 시·도</span></div>
          <div><b class="num">${nOv}<small>곳</small></b><span>해외 나라·지역</span></div>
          <div><b class="num">${pct.toFixed(1)}<small>%</small></b><span>세계 (한국 포함 ${nOv + 1}/195)</span></div>
          <div><b class="num">${s.km >= 10000 ? (s.km / 1000).toFixed(1) + '<small>천km</small>' : s.km.toLocaleString() + '<small>km</small>'}</b><span>누적 이동 (왕복 직선)</span></div>
        </div>
        <div class="tm-legend"><span><i class="lg-done"></i>가봤음</span><span><i class="lg-plan"></i>계획</span><span><i class="lg-wish"></i>가고싶다</span><span><i class="lg-lv">⌂</i>살았던 곳${(S.db.lived || []).length ? ' ' + (S.db.lived || []).length : ''}</span></div>
        ${s.plan.length ? `<p class="tm-next">✈ 다음 여행 · ${s.plan.map(o => `<b>${esc(o.trips.map(x => tripCity(x.t)).join('·'))}</b>`).join(', ')}</p>` : ''}
        ${notYet.length ? `<div class="tm-notyet"><p class="cap3">아직 안 가본 시·도 ${notYet.length}곳 <span>· 저장한 곳 많은 순</span></p><div>${notYet.slice(0, 8).map(k => `<span class="chip">${k}${s.saved[k] ? ` <small>저장 ${s.saved[k]}</small>` : ''}</span>`).join('')}</div></div>` : '<p class="tm-next">🎉 17개 시·도를 모두 가봤어요!</p>'}
      </div></div>
    <div class="tm-badges"><p class="cap3">배지 ${got}/${bs.length}</p><div>${bs.map(b => `<span class="bdg${b.ok ? ' ok' : ''}" title="${esc(b.hint)}"><i>${b.ico}</i><b>${esc(b.name)}</b><small>${b.ok ? '획득' : `${b.cur}/${b.goal}`}</small></span>`).join('')}</div></div>`;
}
const DO_LABEL = { 서울: [37.56, 126.99], 부산: [35.18, 129.07], 대구: [35.87, 128.6], 인천: [37.45, 126.62], 광주: [35.16, 126.85], 대전: [36.35, 127.38], 울산: [35.55, 129.25], 세종: [36.56, 127.26], 경기: [37.25, 127.45], 강원: [37.7, 128.35], 충북: [36.8, 127.75], 충남: [36.5, 126.85], 전북: [35.72, 127.15], 전남: [34.85, 126.85], 경북: [36.35, 128.75], 경남: [35.3, 128.25], 제주: [33.38, 126.55] };
function tmArc(a, b, bend = .22) {                                // 두 점 사이 비행 항로처럼 휜 곡선
  const [y1, x1] = a, [y2, x2] = b, mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
  const cx = mx - dy * bend, cy = my + dx * bend, pts = [];
  for (let i = 0; i <= 32; i++) { const t = i / 32, u = 1 - t; pts.push([u * u * y1 + 2 * u * t * cy + t * t * y2, u * u * x1 + 2 * u * t * cx + t * t * x2]); }
  return pts;
}
function tmLastPhoto(p) { const v = (p.visitLog || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).find(v => visitPhotos(v).length); return v ? { src: visitPhotos(v)[0], v } : { src: imgOf(p), v: (p.visitLog || []).slice(-1)[0] }; }
function tmPhIcon(src, glyph, color, size = 38, cls = '') {
  return L.divIcon({ className: 'tm-phm', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    html: src ? `<span class="tm-ph ${cls}" style="width:${size}px;height:${size}px;background-image:url('${src}')"></span>` : `<span class="tm-ph none ${cls}" style="width:${size}px;height:${size}px;background:${color}">${glyph}</span>` });
}
/* ---------------- 지구본 (D3 정사영 · 자동 회전 · 끌어서 돌리기 · 휠 확대) ---------------- */
function loadD3() { if (window.d3?.geoOrthographic) return Promise.resolve(true); return new Promise(res => { const sc = document.createElement('script'); sc.src = 'vendor/d3geo.min.js?v=1'; sc.onload = () => res(!!window.d3?.geoOrthographic); sc.onerror = () => res(false); document.head.appendChild(sc); }); }
async function drawGlobe(s, C, st) {
  const box = $('#tm-map'); if (!(await loadD3()) || !box) { if (box) box.innerHTML = '<div class="help">지구본을 불러오지 못했어요</div>'; return; }
  box.innerHTML = ''; box.classList.add('globe');
  const W = box.clientWidth || 800, H = box.clientHeight || 420, R0 = Math.min(W, H) / 2.15, NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'gl-svg'); box.appendChild(svg);
  const mk = (tag, attrs = {}, parent = svg) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); parent.appendChild(e); return e; };
  const hm = s.home && hasCoord(s.home) ? [s.home.lng, s.home.lat] : [127.21, 37.58];
  let rot = [-hm[0] + 10, -hm[1] + 12], scale = R0, drag = null, idleAt = 0;
  const proj = d3.geoOrthographic().translate([W / 2, H / 2]).clipAngle(90), path = d3.geoPath(proj);
  const defs = mk('defs'); defs.innerHTML = `<radialGradient id="gl-sea" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="${isDark() ? '#1b3a46' : '#e9f6fa'}"/><stop offset="1" stop-color="${isDark() ? '#0a171d' : '#bcdbe5'}"/></radialGradient><radialGradient id="gl-glow" cx="50%" cy="50%" r="50%"><stop offset=".85" stop-color="rgba(92,195,209,0)"/><stop offset="1" stop-color="rgba(92,195,209,.35)"/></radialGradient>`;
  const glow = mk('circle', { fill: 'url(#gl-glow)' }), sphere = mk('path', { fill: 'url(#gl-sea)', stroke: isDark() ? '#2a4a55' : '#9cc7d3', 'stroke-width': 1 });
  const grat = mk('path', { fill: 'none', stroke: isDark() ? 'rgba(255,255,255,.06)' : 'rgba(14,58,75,.08)', 'stroke-width': .6 }), gratD = d3.geoGraticule10();
  const stOf = cc => cc === 'KR' ? 'home' : s.done.some(o => o.cc === cc) ? 'done' : s.plan.some(o => o.cc === cc) ? 'plan' : '';
  const gC = mk('g'), countries = S.geoWorld.features.map(f => { const x = stOf(f.properties.cc); const p = mk('path', { fill: x === 'home' ? C.home : x === 'done' ? C.done : x === 'plan' ? C.plan : C.land, 'fill-opacity': x ? .9 : 1, stroke: isDark() ? '#0d1b22' : '#fff', 'stroke-width': .5 }, gC); if (x) { const t = mk('title', {}, p); t.textContent = f.properties.n; } return { f, p }; });
  const gA = mk('g'), arcs = [], planes = [];
  for (const o of [...s.done, ...s.plan]) for (const x of o.trips) { if (!x.loc) continue; const to = [x.loc.lng, x.loc.lat], plan = x.st === 'plan';
    arcs.push({ geo: { type: 'LineString', coordinates: [hm, to] }, p: mk('path', { fill: 'none', stroke: plan ? C.plan : C.done, 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-dasharray': plan ? '2 6' : '', class: plan ? 'tm-arc plan' : '' }, gA) });
    if (!REDUCE()) planes.push({ ip: d3.geoInterpolate(hm, to), off: Math.random(), e: mk('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'gl-plane' }, gA) }); }
  for (const pl of planes) pl.e.textContent = '✈';
  const lv = livedSorted().filter(hasCoord), lvLine = lv.length > 1 ? mk('path', { fill: 'none', stroke: C.wish, 'stroke-width': 2, 'stroke-dasharray': '1 6', 'stroke-linecap': 'round' }, gA) : null;
  const lvGeo = { type: 'LineString', coordinates: lv.map(h => [h.lng, h.lat]) };
  const gP = mk('g'), pins = [];
  let ci = 0; const pinImg = (ll, src, r, ring, onClick, label) => { const g = mk('g', { class: 'gl-pin' }, gP), id = 'glc' + (ci++);
    const cp = mk('clipPath', { id }, defs); mk('circle', { r, cx: 0, cy: 0 }, cp);
    mk('circle', { r: r + 2.5, fill: ring }, g); if (src) mk('image', { href: src, x: -r, y: -r, width: r * 2, height: r * 2, 'clip-path': `url(#${id})`, preserveAspectRatio: 'xMidYMid slice' }, g); else mk('circle', { r, fill: ring }, g);
    if (label) { const t = mk('text', { y: r + 14, 'text-anchor': 'middle', class: 'gl-lbl' }, g); t.textContent = label; }
    g.addEventListener('click', onClick); pins.push({ ll, g }); };
  for (const o of [...s.done, ...s.plan]) for (const x of o.trips) if (x.loc) pinImg([x.loc.lng, x.loc.lat], (tripCoverStyle(x.t).match(/url\('([^']+)'\)/) || [])[1], 15, x.st === 'plan' ? C.plan : '#fff', () => tripTitle(x.t), '');   // 나라 이름표와 겹치지 않게 도시명 생략
  lv.forEach(h => { const ph = (h.photos || []).map(x => photoUrl(x.path)).find(Boolean); pinImg([h.lng, h.lat], ph, 11, C.wish, () => { const parts = String(h.address || h.name || '').split(',').map(x => x.trim()).filter(Boolean); let big = (h.country || 'KR') === 'KR' ? parts[0]?.split(' ')[0] : (parts.find(x => !/\d/.test(x)) || parts[0]); locTitle(CITY_EN[big] || big, [regionEn(h.country), livedYears(h)].filter(Boolean).join(' · '), fmtCoord(h)); }, '⌂ ' + h.name); });
  const gL = mk('g'), labels = [...s.done, ...s.plan, { cc: 'KR', state: 'home' }].map(o => { const f = S.geoWorld.features.find(f => f.properties.cc === o.cc), c = f ? d3.geoCentroid(f) : (OV_PIN[o.cc] ? [OV_PIN[o.cc][1], OV_PIN[o.cc][0]] : null); if (!c) return null;
    const g = mk('g', { class: 'gl-cl ' + (o.state || '') }, gL); const a = mk('text', { 'text-anchor': 'middle', class: 'ko' }, g); a.textContent = f ? f.properties.n : (G_COUNTRY_KO[o.cc] || o.cc); const b = mk('text', { 'text-anchor': 'middle', y: 13, class: 'en' }, g); b.textContent = regionEn(o.cc).toUpperCase(); return { c, g }; }).filter(Boolean);
  const vis = ll => d3.geoDistance(ll, [-rot[0], -rot[1]]) < Math.PI / 2 - .02;
  const render = now => {
    proj.rotate(rot).scale(scale); const d = path({ type: 'Sphere' });
    sphere.setAttribute('d', d); glow.setAttribute('cx', W / 2); glow.setAttribute('cy', H / 2); glow.setAttribute('r', scale * 1.08); grat.setAttribute('d', path(gratD) || '');
    for (const c of countries) c.p.setAttribute('d', path(c.f) || '');
    for (const a of arcs) a.p.setAttribute('d', path(a.geo) || '');
    if (lvLine) lvLine.setAttribute('d', path(lvGeo) || '');
    for (const pl of planes) { const k = ((now / 4200) + pl.off) % 1, a = pl.ip(k), b = pl.ip(Math.min(1, k + .01)); if (!vis(a)) { pl.e.setAttribute('opacity', 0); continue; } const pa = proj(a), pb = proj(b), ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180 / Math.PI; pl.e.setAttribute('opacity', 1); pl.e.setAttribute('transform', `translate(${pa[0]},${pa[1]}) rotate(${ang})`); }
    for (const p of pins) { const on = vis(p.ll); p.g.style.display = on ? '' : 'none'; if (on) { const [x, y] = proj(p.ll); p.g.setAttribute('transform', `translate(${x},${y})`); } }
    for (const l of labels) { const on = vis(l.c); l.g.style.display = on ? '' : 'none'; if (on) { const [x, y] = proj(l.c); l.g.setAttribute('transform', `translate(${x},${y + 4})`); } }
  };
  let last = performance.now();
  const loop = now => { if (!document.body.contains(svg)) return; const dt = now - last; last = now;
    if (!drag && !REDUCE() && now > idleAt) rot[0] += dt * .006;   // 천천히 자동 회전
    render(now); requestAnimationFrame(loop); };
  svg.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, r: rot.slice() }; svg.setPointerCapture(e.pointerId); });
  svg.addEventListener('pointermove', e => { if (!drag) return; const k = 75 / scale; rot = [drag.r[0] + (e.clientX - drag.x) * k * 2, Math.max(-75, Math.min(75, drag.r[1] - (e.clientY - drag.y) * k * 2))]; });
  const up = () => { drag = null; idleAt = performance.now() + 2500; }; svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('wheel', e => { e.preventDefault(); scale = Math.max(R0 * .7, Math.min(R0 * 4, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); idleAt = performance.now() + 2500; }, { passive: false });
  const zb = document.createElement('div'); zb.className = 'gl-zoom'; zb.innerHTML = '<button data-gz="1">+</button><button data-gz="-1">−</button>'; box.appendChild(zb);
  zb.onclick = e => { const b = e.target.closest('[data-gz]'); if (!b) return; scale = Math.max(R0 * .7, Math.min(R0 * 4, scale * (+b.dataset.gz > 0 ? 1.25 : .8))); idleAt = performance.now() + 2500; };
  requestAnimationFrame(loop);
}
async function drawTravelCard(mode) {
  const el = $('#tm-card'); if (!el) return; mode ||= S.tmMode || 'kr'; S.tmMode = mode;
  const ok = await loadGeo(); if (!$('#tm-card')) return;
  const s = travelStats(); el.innerHTML = travelCardHtml(s, mode);
  if (!S.tmAnimated) { countUp(el.querySelector('.tm-stats')); S.tmAnimated = true; }   // 숫자 올라가기 (탭 처음 열 때)
  badgeCheck(badgeList(s)).forEach(n => [...el.querySelectorAll('.bdg')].find(x => x.querySelector('b')?.textContent === n)?.classList.add('new'));
  el.onclick = e => { const b = e.target.closest('[data-tm]'); if (b) return drawTravelCard(b.dataset.tm); if (e.target.closest('[data-act=lived]')) return openLivedList(); };
  if (!ok || !window.L) { $('#tm-map').innerHTML = '<div class="help">지도 경계를 불러오지 못했어요</div>'; return; }
  try { S.tmMap?.remove(); } catch {} S.tmMap = null;
  const cs = getComputedStyle(document.body), v = n => cs.getPropertyValue(n).trim();
  const C = { done: v('--primary-2') || '#288d9d', plan: v('--accent') || '#ffbc00', wish: v('--cat-mine') || '#d6336c', land: isDark() ? '#1c2c33' : '#f4f7f8', line: v('--line-strong') || '#c9d3d8', home: v('--primary') || '#0e3a4b' };
  if (mode === 'globe') return drawGlobe(s, C);
  const map = L.map('tm-map', { zoomControl: true, attributionControl: false, zoomSnap: 0.25, wheelPxPerZoomLevel: 90, minZoom: 1, maxZoom: 14, scrollWheelZoom: true, worldCopyJump: false, center: mode === 'world' ? [22, 125] : [36, 127.8], zoom: mode === 'world' ? 2 : 6 }); S.tmMap = map;
  const tip = (l, t) => l.bindTooltip(t, { sticky: true, className: 'tm-tip' });
  const card = (src, title, sub, btns) => `<div class="tm-pop">${src ? `<div class="im" style="background-image:url('${src}')"></div>` : ''}<b>${esc(title)}</b>${sub ? `<p>${esc(sub)}</p>` : ''}<div class="bt">${btns}</div></div>`;
  if (mode === 'world') {
    const st = cc => cc === 'KR' ? 'home' : s.done.some(o => o.cc === cc) ? 'done' : s.plan.some(o => o.cc === cc) ? 'plan' : '';
    L.geoJSON(S.geoWorld, { style: f => { const x = st(f.properties.cc); return { color: isDark() ? '#0d1b22' : '#ffffff', weight: .7, fillColor: x === 'home' ? C.home : x === 'done' ? C.done : x === 'plan' ? C.plan : C.land, fillOpacity: x ? .85 : 1 }; },
      onEachFeature: (f, l) => { const x = st(f.properties.cc); if (x) tip(l, `${esc(f.properties.n)} · ${x === 'home' ? '우리 집' : x === 'done' ? '가봤음' : '계획'}`); } }).addTo(map);
    const EN = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
    const enName = cc => { try { return (EN && cc && cc.length === 2 && EN.of(cc)) || ''; } catch { return ''; } };
    const faint = L.layerGroup(), strong = L.layerGroup().addTo(map);
    const LPOS = { KR: [35.6, 123.9], VN: [21.2, 105.4], TH: [16.2, 99.4], US: [39.5, -98.5], RU: [61, 96], CA: [58, -100], JP: [37.8, 140.5], AU: [-25, 134], CN: [33, 104], GU: [13.45, 144.78], SG: [1.35, 103.82], HK: [22.32, 114.17], MP: [15.18, 145.75] };   // 겹치지 않게 손본 이름 위치
    const lblStrong = (cc, ko, x) => { const c = LPOS[cc] || (geoCenter(cc) && [geoCenter(cc).lat, geoCenter(cc).lng]); if (!c) return; const pin = OV_PIN[cc];
      L.marker(c, { interactive: false, zIndexOffset: -500, icon: L.divIcon({ className: 'tm-cl ' + x, iconSize: [150, 34], iconAnchor: [75, pin ? -26 : 17], html: `<b>${esc(ko)}</b><small>${esc(enName(cc).toUpperCase())}</small>` }) }).addTo(strong); };
    for (const o of [...s.done, ...s.plan]) if (!S.geoWorld.features.some(f => f.properties.cc === o.cc)) lblStrong(o.cc, G_COUNTRY_KO[o.cc] || COUNTRY_EN[o.cc] || o.cc, o.state);
    for (const f of S.geoWorld.features) { const cc = f.properties.cc, x = st(cc), c = geoCenter(cc); if (!c || !cc) continue;
      const ll = LPOS[cc] || [c.lat, c.lng];
      if (x) lblStrong(cc, f.properties.n, x);
      else L.marker(ll, { interactive: false, zIndexOffset: -900, icon: L.divIcon({ className: 'tm-cl faint', iconSize: [120, 16], iconAnchor: [60, 8], html: `<b>${esc(f.properties.n)}</b>` }) }).addTo(faint); }
    const showFaint = () => { map.getZoom() >= 3.5 ? map.addLayer(faint) : map.removeLayer(faint); }; map.on('zoomend', showFaint);
    const hm = s.home && hasCoord(s.home) ? [s.home.lat, s.home.lng] : [37.58, 127.21];
    for (const o of [...s.done, ...s.plan]) for (const x of o.trips) { if (!x.loc) continue; const ll = [x.loc.lat, x.loc.lng], plan = x.st === 'plan';
      const arc = tmArc(hm, ll); (S.tmArcs ||= []).push(arc);
      L.polyline(arc, { color: plan ? C.plan : C.done, weight: 2.5, opacity: .9, dashArray: plan ? '2 8' : null, lineCap: 'round', className: plan ? 'tm-arc plan' : 'tm-arc', interactive: false }).addTo(map);
      const m = tmPhIcon((tripCoverStyle(x.t).match(/url\('([^']+)'\)/) || [])[1], plan ? '✈' : '●', plan ? C.plan : C.done, 44, plan ? 'plan' : '');
      L.marker(ll, { icon: m }).addTo(map).bindTooltip(`${esc(tripCity(x.t))} · ${x.t.year || ''}${plan ? ' (예정)' : ''}`, { direction: 'top', offset: [0, -20] })
        .bindPopup(card((tripCoverStyle(x.t).match(/url\('([^']+)'\)/) || [])[1], `${tripCity(x.t)} ${x.t.year || ''}`, plan ? '예정된 여행' : '다녀온 여행', ''), { className: 'tm-popw', closeButton: false }).on('click', () => tripTitle(x.t));
    }
    L.marker(hm, { icon: L.divIcon({ className: 'tm-home', html: '⌂', iconSize: [26, 26] }) }).addTo(map).bindTooltip('우리 집');
    planeFx(map, S.tmArcs || []); S.tmArcs = [];
  } else {
    const max = Math.max(1, ...Object.values(s.doCnt));
    const kr = L.geoJSON(S.geoKr, { style: f => { const n = s.doCnt[f.properties.k] || 0; return { color: isDark() ? '#0d1b22' : '#ffffff', weight: 1.4, fillColor: n ? C.done : C.land, fillOpacity: n ? .3 + .55 * Math.min(1, n / Math.max(5, max * .6)) : 1 }; },
      onEachFeature: (f, l) => { const k = f.properties.k, n = s.doCnt[k] || 0; tip(l, `<b>${k}</b> · ${n ? `다녀온 곳 ${n}` : '아직 안 가봄'}${s.saved[k] ? ` · 저장 ${s.saved[k]}` : ''}`); } }).addTo(map);
    S.tmKrB = kr.getBounds();
    if (!REDUCE()) { let i = 0; kr.eachLayer(l => { const k = l.feature.properties.k; if (!s.doCnt[k]) return; const to = l.options.fillOpacity, d0 = 250 + i++ * 140; l.setStyle({ fillOpacity: 0 });   // 가본 도가 하나씩 색칠됨
      setTimeout(() => { const t0 = performance.now(); const st = now => { const q = Math.min(1, (now - t0) / 500); l.setStyle({ fillOpacity: to * q }); if (q < 1) requestAnimationFrame(st); }; requestAnimationFrame(st); }, d0); }); }
    const labels = L.layerGroup().addTo(map);
    for (const [k, ll] of Object.entries(DO_LABEL)) { const n = s.doCnt[k] || 0; if (['서울', '인천', '대전', '광주', '세종', '울산', '대구'].includes(k) && !n) continue;
      L.marker(ll, { interactive: false, icon: L.divIcon({ className: 'tm-lbl' + (n ? ' on' : ''), html: `${k}${n ? `<b>${n}</b>` : ''}`, iconSize: [70, 20], iconAnchor: [35, 10] }) }).addTo(labels); }
    for (const [t, ll] of [['동 해', [37.3, 130.4]], ['서 해', [36.3, 125.25]], ['남 해', [33.95, 127.9]]]) L.marker(ll, { interactive: false, icon: L.divIcon({ className: 'tm-sea', html: t, iconSize: [60, 18], iconAnchor: [30, 9] }) }).addTo(labels);
    const cl = L.markerClusterGroup({ maxClusterRadius: 46, showCoverageOnHover: false, spiderfyOnMaxZoom: true, disableClusteringAtZoom: 11,
      iconCreateFunction: c => { const kids = c.getAllChildMarkers(), src = (kids.find(m => m.options.ph) || {}).options?.ph; const n = c.getChildCount(), sz = n > 20 ? 52 : n > 8 ? 46 : 42;
        return L.divIcon({ className: 'tm-phm', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], html: `<span class="tm-ph cl" style="width:${sz}px;height:${sz}px;${src ? `background-image:url('${src}')` : `background:${C.done}`}"></span><i class="tm-cnt">${n}</i>` }); } });
    for (const p of s.visitedP) if ((p.country || 'KR') === 'KR' && hasCoord(p)) { const { src, v: lv } = tmLastPhoto(p);
      const m = L.marker([p.lat, p.lng], { icon: tmPhIcon(src, p.type === 'spot' ? '휴' : isMine(p) ? '◆' : '식', catColor(p), 36), ph: src || null });
      m.bindTooltip(esc(p.name), { direction: 'top', offset: [0, -18] });
      m.bindPopup(card(src, p.name, [areaOf(p), lv?.date ? lv.date.replace(/-/g, '.') : `방문 ${p.visits || (p.visitLog || []).length}회`].filter(Boolean).join(' · '), `${lv?.id ? `<button data-tmpost="${esc(lv.id)}">글 보기</button>` : ''}<button data-tmgo="${p.id}">상세</button>`), { className: 'tm-popw', closeButton: false });
      cl.addLayer(m); }
    map.addLayer(cl);
    for (const p of S.db.places) if (p.wish && (p.country || 'KR') === 'KR' && hasCoord(p)) tip(L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'tm-wish', html: '★', iconSize: [18, 18] }) }).addTo(map).on('click', () => openDetail(p.id)), `★ ${esc(p.name)} (가고싶다)`);
    map.fitBounds(S.tmKrB, { padding: [10, 10] });
  }
  { const lv = livedSorted().filter(h => hasCoord(h) && (mode === 'world' || (h.country || 'KR') === 'KR'));     // 살았던 곳 ⌂ + 이사 경로
    if (lv.length > 1) { const pts = lv.map(h => [h.lat, h.lng]), line = L.polyline(REDUCE() ? pts : [pts[0]], { color: C.wish, weight: 2.5, opacity: .9, dashArray: '1 7', lineCap: 'round', interactive: false }).addTo(map);
      if (!REDUCE()) { const t0 = performance.now(), D = 600 * (pts.length - 1); const st = now => { const f = Math.min(1, (now - t0) / D) * (pts.length - 1), i = Math.floor(f), r = f - i, a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)]; line.setLatLngs([...pts.slice(0, i + 1), [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r]]); if (f < pts.length - 1) requestAnimationFrame(st); }; setTimeout(() => requestAnimationFrame(st), 500); } }   // 이사 경로가 1→2→3 순서로 그려짐
    lv.forEach((h, i) => { const mk = L.marker([h.lat, h.lng], { zIndexOffset: 400, icon: L.divIcon({ className: 'tm-lvm', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span style="animation-delay:${(.5 + i * .6).toFixed(1)}s">⌂</span><i>${i + 1}</i>` }) }).addTo(map)
      .bindTooltip(`<b>⌂ ${esc(h.name)}</b>${livedYears(h) ? ' · ' + esc(livedYears(h)) : ''}`, { direction: 'top', offset: [0, -14] });
      const phs = (h.photos || []).map(x => photoUrl(x.path)).filter(Boolean);
      if (phs.length) mk.setIcon(L.divIcon({ className: 'tm-lvm ph', iconSize: [40, 40], iconAnchor: [20, 20], html: `<span style="background-image:url('${phs[0]}');animation-delay:${(.5 + i * .6).toFixed(1)}s"></span><b>⌂</b><i>${i + 1}</i>` }));
      mk.bindPopup(`<div class="tm-pop">${phs.length ? `<div class="lvp-strip">${phs.slice(0, 4).map((u, k) => `<button data-lvlb="${h.id}" data-k="${k}" style="background-image:url('${u}')">${k === 3 && phs.length > 4 ? `<b>+${phs.length - 4}</b>` : ''}</button>`).join('')}</div>` : ''}<b>⌂ ${esc(h.name)}</b><p>${esc([livedYears(h), phs.length ? `사진 ${phs.length}장` : ''].filter(Boolean).join(' · '))}</p><div class="bt">${phs.length ? `<button data-lvlb="${h.id}" data-k="0">사진 보기</button>` : ''}<button data-lvedit="${h.id}">${phs.length ? '사진 추가' : '＋ 사진 올리기'}</button></div></div>`, { className: 'tm-popw', closeButton: false });
      mk.on('click', () => { const parts = String(h.address || h.name || '').split(',').map(x => x.trim()).filter(Boolean); let big = (h.country || 'KR') === 'KR' ? parts[0]?.split(' ')[0] : (parts.find(x => !/\d/.test(x)) || parts[0]); big = CITY_EN[big] || big;
        locTitle(big, [(h.country || 'KR') === 'KR' ? h.name : regionEn(h.country), livedYears(h)].filter(Boolean).join(' · '), fmtCoord(h)); }); }); }
  map.getContainer().addEventListener('click', e => {
    const lb = e.target.closest('[data-lvlb]'), le = e.target.closest('[data-lvedit]');
    if (lb) { const h = (S.db.lived || []).find(x => x.id === lb.dataset.lvlb); const ps = (h.photos || []).filter(x => photoUrl(x.path)); return openLightbox(ps.map(x => photoUrl(x.path)), +lb.dataset.k, `⌂ ${h.name}`, { raws: ps.map(x => x.path), date: null }); }
    if (le) return isRO() ? goToken() : openLivedForm((S.db.lived || []).find(x => x.id === le.dataset.lvedit));
    const b = e.target.closest('[data-tmgo],[data-tmpost]'); if (!b) return; if (b.dataset.tmgo) openDetail(b.dataset.tmgo); else openJournal({ page: true, post: b.dataset.tmpost }); });
  const wpts = mode === 'world' ? [[37.58, 127.21], ...[...s.done, ...s.plan].flatMap(o => o.trips.filter(x => x.loc).map(x => [x.loc.lat, x.loc.lng])), ...livedSorted().filter(hasCoord).map(h => [h.lat, h.lng])] : [];   // 여행지 + 살았던 곳 모두 보이게
  const view = mode === 'world' ? () => (wpts.length > 1 ? map.fitBounds(L.latLngBounds(wpts).pad(.35), { maxZoom: 3.5, animate: false }) : map.setView([22, 128], window.innerWidth > 860 ? 2.25 : 1.25, { animate: false })) : () => map.fitBounds(S.tmKrB, { padding: [10, 10], animate: false });
  setTimeout(() => { try { map.invalidateSize(false); view(); } catch {} }, 60);
}
/* ---------------- 여행 일정 파일 가져오기 (여행 탭에 드래그 · 버튼) ----------------
 * 지원: ① 준준 안내서 HTML (trip-guide-html, <script id="trip-data">) ② 준준 여행 JSON ({trip, places, base} 또는 trip 객체)
 * 일정(날짜·시간·활동·메모)·도시·나라·숙소 이름만 가져옴 — 여권·항공권·예약번호 등 개인정보는 가져오지 않음
 */
const CITY_CC = { sydney: 'AU', 시드니: 'AU', melbourne: 'AU', 멜버른: 'AU', 브리즈번: 'AU', tokyo: 'JP', 도쿄: 'JP', osaka: 'JP', 오사카: 'JP', 후쿠오카: 'JP', 삿포로: 'JP', 오키나와: 'JP', 다낭: 'VN', 나트랑: 'VN', 하노이: 'VN', 호치민: 'VN', 푸꾸옥: 'VN', 방콕: 'TH', 치앙마이: 'TH', 푸켓: 'TH', 괌: 'GU', guam: 'GU', 사이판: 'MP', 싱가포르: 'SG', singapore: 'SG', 홍콩: 'HK', 대만: 'TW', 타이베이: 'TW', 세부: 'PH', 보라카이: 'PH', 발리: 'ID', 하와이: 'US', 뉴욕: 'US', 파리: 'FR', 런던: 'GB', 로마: 'IT' };
function tripScrub(s) {                                            // 메모 속 예약·티켓·여권 번호 지우기
  return String(s || '').replace(/(예약\s*번호|예약번호|PNR|티켓\s*번호|e-?ticket|ticket|여권\s*번호|스카이패스|skypass)\s*[:：]?\s*[A-Z0-9*-]{5,}/gi, '$1 (생략)').replace(/\b\d{13}\b/g, '(생략)').replace(/\b[A-Z][0-9]{7,8}\b/g, '(생략)');
}
function tripFromJson(j) {
  const t = j && (j.trip || (Array.isArray(j.items) ? j : null)); if (!t || !Array.isArray(t.items)) return null;
  return { id: t.id, title: t.title, city: t.city, country: (t.country || '').toUpperCase(), year: t.year || +(String(t.start || '').slice(0, 4)) || new Date().getFullYear(),
    items: t.items.map(it => ({ day: it.day || '', time: it.time || '', activity: tripScrub(it.activity), place: it.place || '', place_id: it.place_id || null, note: tripScrub(it.note) })),
    places: Array.isArray(j.places) ? j.places : [], base: j.base && j.base.name ? j.base : null, src: 'JSON' };
}
function tripFromGuide(d) {
  if (!d || !Array.isArray(d.itin)) return null;
  const v = d.view || {}, city = v.heroCity || v.footCity || '', year = +(String(d.start || '').slice(0, 4)) || new Date().getFullYear();
  const items = d.itin.flatMap((dd, i) => (dd.events || []).map(ev => ({ day: (d.labels || [])[i] || `DAY ${i + 1}`, time: ev[0] || '', activity: tripScrub(ev[1]), place: '', place_id: null, note: tripScrub(ev[2] || '') })));
  let cc = CITY_CC[city.toLowerCase()] || CITY_CC[city] || '';
  if (!cc && S.geoWorld) { const pts = [...(d.rest || []), ...(d.guide || []), ...(d.parking || [])].map(x => x && (x.lat != null ? [x.lng, x.lat] : null)).filter(Boolean); for (const [x, y] of pts) { const f = S.geoWorld.features.find(f => geoHit(f.geometry, +x, +y)); if (f) { cc = f.properties.cc; break; } } }
  const title = `${year} ${city} 여행`;
  return { id: d.id, title, city, country: cc, year, items, places: [], base: d.hotel ? { name: d.hotel } : null, src: '안내서 HTML' };
}
async function importTripFile(file) {
  if (!file) return; if (isRO()) return goToken();
  let r = null;
  try { await loadGeo(); const txt = await file.text();
    if (/\.json$/i.test(file.name) || /^\s*[{[]/.test(txt)) r = tripFromJson(JSON.parse(txt));
    else { const m = txt.match(/<script id="trip-data" type="application\/json">([\s\S]*?)<\/script>/); if (m) r = tripFromGuide(JSON.parse(m[1].replace(/<\\\//g, '</'))); }
  } catch (e) { console.warn(e); }
  if (!r || !r.items.length) return toast('여행 일정을 찾지 못했어요 — 준준 안내서 HTML이나 여행 JSON을 넣어주세요', 4000);
  openTripImport(r, file.name);
}
function openTripImport(r, fname) {
  const days = [...new Set(r.items.map(i => i.day))];
  const same = S.db.trips.find(t => (r.id && t.id === r.id) || (t.title && t.title === r.title && t.year === r.year));
  const ccs = [...new Set([r.country, ...Object.keys(G_COUNTRY_KO), ...Object.keys(COUNTRY_EN)].filter(Boolean))];
  const nm = s => String(s || '').replace(/\s/g, '').toLowerCase();
  const newPl = r.places.filter(x => x && x.name && !S.db.places.some(p => nm(p.name) === nm(x.name)));
  const baseHas = r.base && S.db.bases.some(b => nm(b.name) === nm(r.base.name));
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">취소</button><b>여행 가져오기</b><span></span></div><div class="vf-scroll" style="padding:16px">
    <p class="cap3">${esc(fname)} · ${esc(r.src)}</p>
    <div class="ti-f" style="margin-top:10px"><label>제목</label><input id="ti-title" value="${esc(r.title || '')}"></div>
    <div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px"><div class="ti-f"><label>도시</label><input id="ti-city" value="${esc(r.city || '')}"></div>
      <div class="ti-f"><label>나라</label><select id="ti-cc">${r.country ? '' : '<option value="">선택하세요</option>'}${ccs.map(c => `<option value="${c}"${c === r.country ? ' selected' : ''}>${esc(G_COUNTRY_KO[c] || COUNTRY_EN[c] || c)}</option>`).join('')}<option value="__">직접 입력…</option></select></div></div>
    <div class="ti-sum"><div><b class="num">${days.length}</b><span>일</span></div><div><b class="num">${r.items.length}</b><span>일정</span></div><div><b class="num">${esc(days[0] || '')}</b><span>~ ${esc(days[days.length - 1] || '')}</span></div></div>
    <div class="ti-prev">${days.slice(0, 7).map(d => `<p><b>${esc(d)}</b> ${r.items.filter(i => i.day === d).slice(0, 4).map(i => esc(i.activity)).join(' · ')}${r.items.filter(i => i.day === d).length > 4 ? ' …' : ''}</p>`).join('')}</div>
    ${newPl.length ? `<label class="ti-chk"><input type="checkbox" id="ti-places" checked> 장소 ${newPl.length}곳 새로 등록 (일정과 연결)</label>` : ''}
    ${r.base && !baseHas ? `<label class="ti-chk"><input type="checkbox" id="ti-base" ${r.base.lat != null ? 'checked' : ''}> 숙소 「${esc(r.base.name)}」 거점으로 추가${r.base.lat == null ? ' (좌표 없음 · 나중에 위치 지정)' : ''}</label>` : ''}
    ${same ? `<label class="ti-chk warn"><input type="checkbox" id="ti-replace" checked> 같은 여행 「${esc(same.title || tripCity(same))}」이 있어요 — 일정 덮어쓰기 (끄면 새 여행으로 추가)</label>` : ''}
    <p class="cap3" style="margin-top:12px">일정·메모·도시·숙소 이름만 가져옵니다. 여권·항공권·예약번호 같은 개인정보는 가져오지 않고, 메모 속 번호도 지웁니다.</p>
    </div><div class="vf-foot"><button class="btn-pri" data-act="tiok">여행에 추가</button></div></div>`);
  $('#ti-cc').onchange = e => { if (e.target.value === '__') { const c = (prompt('나라 코드 2자리 (예: AU, JP)') || '').trim().toUpperCase(); if (c) { e.target.insertAdjacentHTML('afterbegin', `<option value="${esc(c)}" selected>${esc(c)}</option>`); e.target.value = c; } } };
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'back') return closeSheet();
    if (b.dataset.act !== 'tiok') return;
    const cc = $('#ti-cc').value; if (!cc || cc === '__') return toast('나라를 골라주세요');
    const city = $('#ti-city').value.trim(), title = $('#ti-title').value.trim() || `${r.year} ${city} 여행`;
    const idMap = {};
    if ($('#ti-places')?.checked) for (const x of r.places) { if (!x || !x.name) continue; const ex = S.db.places.find(p => nm(p.name) === nm(x.name)); if (ex) { idMap[x.id] = ex.id; continue; }
      const np = { id: uid('p'), type: x.type === 'restaurant' ? 'restaurant' : 'spot', country: cc, region: nm(city) || 'c:', name: x.name, lat: typeof x.lat === 'number' ? x.lat : null, lng: typeof x.lng === 'number' ? x.lng : null, address: x.addr || x.address || null, tags: [], visitLog: [], visits: 0, wish: false };
      S.db.places.push(np); idMap[x.id] = np.id; }
    else for (const x of r.places) { const ex = x && S.db.places.find(p => nm(p.name) === nm(x.name)); if (ex) idMap[x.id] = ex.id; }
    const items = r.items.map(i => ({ ...i, place_id: i.place_id && idMap[i.place_id] ? idMap[i.place_id] : null, place: i.place || (i.place_id && (r.places.find(x => x.id === i.place_id) || {}).name) || '' }));
    if ($('#ti-base')?.checked && r.base) S.db.bases.push({ id: uid('b'), name: r.base.name, country: cc, lat: typeof r.base.lat === 'number' ? r.base.lat : null, lng: typeof r.base.lng === 'number' ? r.base.lng : null, note: r.base.addr || '' });
    let t = $('#ti-replace')?.checked ? same : null;
    if (t) Object.assign(t, { title, city, country: cc, year: r.year, items });
    else { t = { id: uid('t'), title, city, country: cc, year: r.year, items }; S.db.trips.push(t); }
    markDirty(); closeSheet(); S.trip = t; S.tripDay = 0; showView('trips'); renderTrips(); toast(`여행 추가 · ${tripCity(t)} 일정 ${items.length}개`);
  };
}
function bindTripDrop() {                                          // 여행 탭에 파일을 끌어다 놓으면 가져오기
  const hasFile = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragover', e => { if (S.view !== 'trips' || !hasFile(e)) return; e.preventDefault(); document.body.classList.add('trip-drop'); });
  document.addEventListener('dragleave', e => { if (e.target === document.documentElement || !e.relatedTarget) document.body.classList.remove('trip-drop'); });
  document.addEventListener('drop', e => { if (S.view !== 'trips' || !hasFile(e)) return; e.preventDefault(); document.body.classList.remove('trip-drop'); importTripFile(e.dataTransfer.files[0]); });
}
/* ---------------- 살았던 곳 (지도 ⌂ 핀 · 이사 경로) ---------------- */
function livedSorted() { return (S.db.lived || []).slice().sort((a, b) => (+a.from || 0) - (+b.from || 0)); }
function livedYears(h) { return h.from || h.to ? `${h.from || '?'}~${h.to || '현재'}` : ''; }
async function addrSearch(q, cc) {                                  // 주소·건물명 → 좌표 (국내: 카카오 주소 → 키워드 → OSM)
  q = (q || '').trim(); if (!q) return [];
  if (cc === 'KR') { await loadKakao(); if (window.kakao?.maps?.services?.Geocoder) { const r = await new Promise(res => new kakao.maps.services.Geocoder().addressSearch(q, (d, st) => res(st === kakao.maps.services.Status.OK ? d : []))); if (r.length) return r.slice(0, 6).map(d => ({ name: d.address_name, lat: +d.y, lng: +d.x, address: d.road_address?.address_name || d.address_name, src: '카카오 주소' })); } }
  let r = await osmSearch(q, cc);                                    // 해외: OSM(나라 지정) → 나라 이름 붙여서 → 전 세계
  if (!r.length) r = await osmSearch(`${q}, ${regionEn(cc)}`, ''); if (!r.length) r = await osmSearch(q, '');
  if (!r.length && googleKey()) r = await googleSearch(`${q} ${regionEn(cc)}`, null);
  return r;
}
function openLivedList() {
  const L0 = livedSorted();
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">닫기</button><b>살았던 곳</b><span></span></div><div class="vf-scroll" style="padding:16px">
    <p class="cap3">지도에 ⌂ 핀과 기간이 표시되고, 살았던 순서대로 이사 경로가 이어집니다</p>
    <div class="lv-list">${L0.map(h => `<button class="lv-row" data-lv="${h.id}"><span class="lv-ico"${(h.photos || []).length ? ` style="background:center/cover url('${photoUrl(h.photos[0].path)}')"` : ''}>${(h.photos || []).length ? '' : '⌂'}</span><span class="m"><b>${esc(h.name || '집')}</b><small>${esc([livedYears(h), (h.photos || []).length ? `사진 ${h.photos.length}장` : '', h.address].filter(Boolean).join(' · '))}</small></span><i>›</i></button>`).join('') || '<div class="help">아직 없어요 — 아래에서 추가하세요</div>'}</div>
    <button class="btn-line rw" data-act="lvadd" style="margin-top:12px;width:100%">＋ 살았던 곳 추가</button></div></div>`);
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'back') { closeSheet(); return drawTravelCard(); } if (b.dataset.act === 'lvadd') return isRO() ? goToken() : openLivedForm(); if (b.dataset.lv) return isRO() ? goToken() : openLivedForm((S.db.lived || []).find(x => x.id === b.dataset.lv)); };
}
async function openLivedForm(h) {
  await loadGeo(); const st = { ...(h || { country: 'KR' }) };
  const all = (S.geoWorld?.features || []).map(f => [f.properties.cc, f.properties.n]).filter(([c]) => c && c.length === 2).sort((a, b) => a[1].localeCompare(b[1], 'ko'));
  const top = ['KR', ...Object.keys(G_COUNTRY_KO).filter(c => c !== 'KR')], koName = c => G_COUNTRY_KO[c] || (all.find(x => x[0] === c) || [])[1] || c;
  const yr = new Date().getFullYear();
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">취소</button><b>${h ? '살았던 곳 수정' : '살았던 곳 추가'}</b><button class="lnk pri" data-act="lvsave">저장</button></div><div class="vf-scroll" style="padding:16px">
    <div class="ti-f"><label>이름</label><input id="lv-name" placeholder="예: 신혼집 · 하준이 태어난 집 · 시드니 주재원 시절" value="${esc(st.name || '')}"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:10px">
      <div class="ti-f"><label>나라</label><select id="lv-cc"><optgroup label="자주">${top.map(c => `<option value="${c}"${c === st.country ? ' selected' : ''}>${esc(koName(c))}</option>`).join('')}</optgroup><optgroup label="전체 (가나다)">${all.filter(([c]) => !top.includes(c)).map(([c, n]) => `<option value="${c}"${c === st.country ? ' selected' : ''}>${esc(n)}</option>`).join('')}</optgroup></select></div>
      <div class="ti-f"><label>살기 시작 (년)</label><input id="lv-from" type="number" min="1950" max="${yr}" placeholder="2012" value="${esc(st.from || '')}"></div>
      <div class="ti-f"><label>떠난 해 (비우면 현재)</label><input id="lv-to" type="number" min="1950" max="${yr}" placeholder="2018" value="${esc(st.to || '')}"></div></div>
    <div class="ti-f" style="margin-top:10px"><label>주소 또는 아파트·동네 이름</label><div style="display:flex;gap:8px"><input id="lv-q" placeholder="예: 부산 해운대구 우동 · 송파 헬리오시티" value="${esc(st.address || '')}"><button class="btn-line" data-act="lvfind" style="flex:none;padding:0 14px">검색</button></div></div>
    <div id="lv-hits" class="lv-hits"></div>
    <div id="lv-map" class="lv-map"></div>
    <p class="cap3" id="lv-pos" style="margin-top:8px">${st.lat != null ? `위치 지정됨 · ${(+st.lat).toFixed(4)}, ${(+st.lng).toFixed(4)}` : '검색 결과를 고르거나, 지도를 직접 눌러 위치를 정하세요'}</p>
    <div class="vsec" style="margin-top:14px"><h4>그 집에서의 사진 <span class="cap3">촬영일 자동 · 장수 제한 없음</span></h4>
      <div class="lv-phs" id="lv-phs"></div><button type="button" class="btn-line" data-act="lvpick" style="width:100%;margin-top:8px">＋ 사진 올리기</button><input type="file" id="lv-file" accept="image/*" multiple hidden>
      <div class="lv-gr"><span class="cap3">누구 사진인가요 (선택)</span><div class="chips" id="lv-who">${familyNames().map(n => `<button type="button" class="chip" data-lw="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <label class="ti-chk"><input type="checkbox" id="lv-togr" checked> 고른 사람의 🌱 성장 앨범에도 넣기</label></div></div>
    <p class="cap3" style="margin-top:12px">⚠ 저장소가 공개라 주소가 보일 수 있어요. 동·아파트 이름 정도로만 넣는 것을 권장합니다</p>
    ${h ? '<button class="btn-line" data-act="lvdel" style="margin-top:16px;color:var(--danger)">삭제</button>' : ''}</div></div>`);
  $('#lv-q').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('[data-act=lvfind]').click(); } };
  st.photos = (st.photos || []).slice(); const newPh = [], lwho = new Set();   // 사진: 기존(path) + 새로 고른 것(b64)
  const drawPh = () => { $('#lv-phs').innerHTML = [...st.photos.map((x, i) => `<div class="lv-ph" style="background-image:url('${photoUrl(x.path)}')"><small>${esc((x.date || '').slice(0, 7).replace('-', '.'))}</small><button type="button" data-lvrm="o${i}">✕</button></div>`), ...newPh.map((x, i) => `<div class="lv-ph new" style="background-image:url('${x.url}')"><small>${esc((x.date || '').slice(0, 7).replace('-', '.'))}</small><button type="button" data-lvrm="n${i}">✕</button></div>`)].join(''); };
  drawPh();
  $('#lv-file').onchange = async e => { for (const f of [...e.target.files]) { try { const ex = exifDate(await f.slice(0, 256 * 1024).arrayBuffer()); const b64 = await resizeImage(f); const lm0 = f.lastModified ? new Date(f.lastModified) : null;
      newPh.push({ b64, url: 'data:image/jpeg;base64,' + b64, date: ex || (lm0 ? lm0.toISOString().slice(0, 10) : null) }); } catch { toast('사진을 읽지 못했습니다'); } } drawPh(); e.target.value = ''; };
  let lm = null, mk = null;                                          // 지도에서 직접 찍기
  try { lm = L.map('lv-map', { attributionControl: false, zoomControl: true }); L.tileLayer(tileUrl(), { maxZoom: 18 }).addTo(lm);
    const c0 = st.lat != null ? [st.lat, st.lng] : (() => { const g = geoCenter(st.country || 'KR'); return g ? [g.lat, g.lng] : [36.3, 127.8]; })(); lm.setView(c0, st.lat != null ? 14 : st.country === 'KR' ? 6 : 5);
    const put = (ll, z) => { if (mk) mk.setLatLng(ll); else mk = L.marker(ll, { icon: L.divIcon({ className: 'tm-lvm', iconSize: [30, 30], iconAnchor: [15, 15], html: '<span>⌂</span>' }) }).addTo(lm); if (z) lm.setView(ll, z); };
    if (st.lat != null) put([st.lat, st.lng]);
    lm.on('click', e => { Object.assign(st, { lat: +e.latlng.lat.toFixed(5), lng: +e.latlng.lng.toFixed(5) }); if (!st.address) st.address = $('#lv-q').value.trim() || null; put(e.latlng); $('#lv-pos').textContent = `지도에서 지정 · ${st.lat.toFixed(4)}, ${st.lng.toFixed(4)}`; });
    S.lvPut = put; setTimeout(() => lm.invalidateSize(), 120);
    $('#lv-cc').onchange = e => { const g = geoCenter(e.target.value); if (g && st.lat == null) lm.setView([g.lat, g.lng], e.target.value === 'KR' ? 6 : 5); };
  } catch (e) { console.warn(e); }
  $('#sheet-inner').onclick = async e => { const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
    if (act === 'back') return openLivedList();
    if (act === 'lvpick') return $('#lv-file').click();
    if (b.dataset.lw) { lwho.has(b.dataset.lw) ? lwho.delete(b.dataset.lw) : lwho.add(b.dataset.lw); b.classList.toggle('on'); return; }
    if (b.dataset.lvrm) { const k = b.dataset.lvrm; if (k[0] === 'o') st.photos.splice(+k.slice(1), 1); else newPh.splice(+k.slice(1), 1); return drawPh(); }
    if (act === 'lvfind') { const box = $('#lv-hits'); box.innerHTML = '<div class="help">찾는 중…</div>'; const hits = await addrSearch($('#lv-q').value, $('#lv-cc').value); S.lvHits = hits;
      box.innerHTML = hits.length ? hits.map((x, i) => `<button class="lv-hit" data-hit="${i}"><b>${esc(x.name)}</b><small>${esc(x.address || '')} · ${esc(x.src || '')}</small></button>`).join('') : '<div class="help">못 찾았어요 — 동·구 이름으로 다시 검색해 보세요</div>'; return; }
    if (b.dataset.hit != null) { const x = S.lvHits[+b.dataset.hit]; Object.assign(st, { lat: x.lat, lng: x.lng, address: x.address || x.name }); $('#lv-pos').textContent = `위치 지정됨 · ${x.name}`; S.lvPut?.([x.lat, x.lng], 15); $$('.lv-hit').forEach(y => y.classList.toggle('on', y === b)); return; }
    if (act === 'lvdel') { if (!b.dataset.c) { b.dataset.c = 1; b.textContent = '정말 삭제?'; return; } S.db.lived = (S.db.lived || []).filter(x => x.id !== h.id); markDirty(); toast('삭제'); return openLivedList(); }
    if (act === 'lvsave') {
      if (st.lat == null) return toast('주소를 검색하거나 지도를 눌러 위치를 정해주세요');
      const it = { id: st.id || uid('h'), name: $('#lv-name').value.trim() || '우리 집', country: $('#lv-cc').value, from: +$('#lv-from').value || null, to: +$('#lv-to').value || null, address: st.address || null, lat: st.lat, lng: st.lng, photos: st.photos };
      if (newPh.length) { b.disabled = true; const toGr = $('#lv-togr')?.checked && lwho.size; S.db.growth ||= [];
        for (const [i, x] of newPh.entries()) { b.textContent = `사진 ${i + 1}/${newPh.length}`; let path = null;
          if (S.token && !OFFLINE) { try { path = await ghPutFile(`photos/lived/${it.id}/${x.date || today()}_${Date.now().toString(36)}_${i}.jpg`, x.b64, `jjtrip: lived ${it.name}`); } catch (err) { toast('사진 업로드 실패: ' + err.message, 3500); } }
          if (!path) { const local = LS.get('photos', {}); path = `local:lived:${Date.now().toString(36)}${i}`; local[path] = x.url; try { LS.set('photos', local); } catch { toast('이 기기 저장 공간 부족 — 사진 생략'); path = null; } }
          if (!path) continue; it.photos.push({ path, date: x.date || null, who: [...lwho] });
          if (toGr) S.db.growth.push({ id: uid('g'), who: [...lwho], date: x.date || null, photo: path, memo: it.name, lived: it.id }); }
        it.photos.sort((a, c) => (a.date || '').localeCompare(c.date || '')); }
      S.db.lived ||= []; const i = S.db.lived.findIndex(x => x.id === it.id); if (i >= 0) S.db.lived[i] = it; else S.db.lived.push(it);
      markDirty(); toast('살았던 곳 저장'); return openLivedList(); }
  };
}

/* ---------------- 성장 앨범 (사람별 · 연도별 · 연도순 재생) ---------------- */
function exifDate(buf) {                                          // JPEG EXIF 촬영일(DateTimeOriginal) → 'YYYY-MM-DD'
  try { const v = new DataView(buf); if (v.getUint16(0) !== 0xFFD8) return null; let o = 2;
    while (o < v.byteLength - 4) { const mk = v.getUint16(o), len = v.getUint16(o + 2);
      if (mk === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) { const t = o + 10, le = v.getUint16(t) === 0x4949, g16 = p => v.getUint16(p, le), g32 = p => v.getUint32(p, le);
        const read = (ifd, want) => { const n = g16(t + ifd); for (let i = 0; i < n; i++) { const e = t + ifd + 2 + i * 12, tag = g16(e); if (want.includes(tag)) return { tag, off: g32(e + 8), cnt: g32(e + 4) }; } return null; };
        const ex = read(g32(t + 4), [0x8769]); let d = ex && read(ex.off, [0x9003, 0x9004]); if (!d) d = read(g32(t + 4), [0x0132]);
        if (d) { let s = ''; for (let i = 0; i < 10; i++) s += String.fromCharCode(v.getUint8(t + d.off + i)); const m = s.match(/^(\d{4}):(\d{2}):(\d{2})/); if (m && m[1] > '1900') return `${m[1]}-${m[2]}-${m[3]}`; }
        return null; }
      if ((mk & 0xFF00) !== 0xFF00) break; o += 2 + len; } } catch {} return null;
}
function growthAge(name, date) { const by = ((S.db.meta.family || {}).birthYear || {})[name]; if (!by || !date) return ''; const a = +date.slice(0, 4) - by; return a >= 0 ? `${a + 1}살` : ''; }   // 한국식 나이(연 기준) — 생년만 저장
function growthEnts(who) { return (S.db.growth || []).filter(g => !who || (g.who || []).includes(who)).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '')); }
function growthHtml(who) {
  const fam = familyNames(), list = growthEnts(who), years = [...new Set(list.map(g => (g.date || '').slice(0, 4) || '날짜 없음'))];
  const by = (S.db.meta.family || {}).birthYear || {};
  return `<div class="gr-hd"><div class="gr-people">${['', ...fam].map(n => `<button class="chip${(who || '') === n ? ' on' : ''}" data-grwho="${esc(n)}">${n ? esc(n) + (by[n] ? ` <small>${by[n]}</small>` : '') : '전체'}</button>`).join('')}</div>
      <div class="gr-acts"><button class="btn-pri rw" data-act="grup">＋ 사진 올리기</button><button class="btn-line" data-act="grplay" ${list.length ? '' : 'disabled'}>▶ 연도순 재생</button><button class="btn-line rw" data-act="grbirth" title="나이 표시용 · 생년만 저장">생년 설정</button></div></div>
    ${list.length ? years.map(y => { const ys = list.filter(g => ((g.date || '').slice(0, 4) || '날짜 없음') === y);
      return `<section class="gr-year"><div class="gr-band"><b class="serif">${y}</b><span>${who && growthAge(who, ys[0].date) ? esc(who + ' · ' + growthAge(who, ys[0].date)) : !who ? fam.filter(n => by[n] && y !== '날짜 없음').map(n => `${n} ${+y - by[n] + 1}살`).join(' · ') : ''}</span><small>${ys.length}장</small></div>
        <div class="gr-grid">${ys.map(g => `<button class="gr-ph" data-gr="${g.id}" style="background-image:url('${photoUrl(g.photo)}')"><span>${esc((g.date || '').slice(5).replace('-', '.'))}${!who && (g.who || []).length ? ' · ' + esc(g.who.join('·')) : ''}</span></button>`).join('')}</div></section>`; }).join('')
      : `<div class="empty11"><img src="${asset('assets/mark-stamp.png')}" alt=""><b>성장 앨범이 비어 있어요</b><p class="cap">「＋ 사진 올리기」로 아이·가족 사진을 넣으면 연도별로 쌓입니다. 방문 기록 사진은 크게 보기에서 「🌱 성장 앨범」으로 바로 넣을 수 있어요</p></div>`}`;
}
function openGrowthUpload(who0) {
  const fam = familyNames(); const st = { who: new Set(who0 ? [who0] : []), items: [] };
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">취소</button><b>성장 앨범에 올리기</b><button class="lnk pri" data-act="grsave">저장</button></div><div class="vf-scroll" style="padding:16px">
    <div class="vsec"><h4>누구 사진인가요 <span class="cap3">여러 명 선택 가능</span></h4><div class="chips" id="gr-who">${fam.map(n => `<button type="button" class="chip${st.who.has(n) ? ' on' : ''}" data-w="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>
    <div class="vsec"><h4>사진 <span class="cap3">촬영일은 사진 정보에서 자동 · 없으면 직접 입력</span></h4><div id="gr-items" class="gr-items"></div><button type="button" class="btn-line" data-act="grpick" style="width:100%;margin-top:8px">사진 고르기</button><input type="file" id="gr-file" accept="image/*" multiple hidden></div>
    <div class="vsec"><h4>한 줄 메모 <span class="cap3">선택 · 모든 사진에 적용</span></h4><input id="gr-memo" class="vmemo" style="min-height:0;height:40px" placeholder="예: 첫 자전거"></div></div>
    <div class="vf-foot"><button class="btn-pri" data-act="grsave">성장 앨범에 저장</button></div></div>`);
  const draw = () => { $('#gr-items').innerHTML = st.items.map((x, i) => `<div class="gr-it"><span style="background-image:url('${x.url}')"></span><input type="date" value="${x.date || ''}" data-gd="${i}" max="${today()}"><small>${x.exif ? '사진 정보' : '직접 입력'}</small><button type="button" data-grm="${i}">✕</button></div>`).join(''); };
  $('#gr-file').onchange = async e => { const fs = [...e.target.files]; let k = 0; for (const f of fs) { k++; $('#gr-items').dataset.busy = `사진 읽는 중 ${k}/${fs.length}`;
      try { const ex = exifDate(await f.slice(0, 256 * 1024).arrayBuffer()); const b64 = await resizeImage(f); const lm = f.lastModified ? new Date(f.lastModified) : null;
        st.items.push({ b64, url: 'data:image/jpeg;base64,' + b64, date: ex || (lm ? `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}-${String(lm.getDate()).padStart(2, '0')}` : ''), exif: !!ex }); } catch { toast('사진을 읽지 못했습니다'); } }
    delete $('#gr-items').dataset.busy; draw(); e.target.value = ''; };
  $('#sheet-inner').oninput = e => { if (e.target.dataset.gd != null) st.items[+e.target.dataset.gd].date = e.target.value; };
  $('#sheet-inner').onclick = async e => { const b = e.target.closest('button'); if (!b) return; const act = b.dataset.act;
    if (act === 'back') { closeSheet(); return; }
    if (act === 'grpick') return $('#gr-file').click();
    if (b.dataset.w) { st.who.has(b.dataset.w) ? st.who.delete(b.dataset.w) : st.who.add(b.dataset.w); b.classList.toggle('on'); return; }
    if (b.dataset.grm != null) { st.items.splice(+b.dataset.grm, 1); draw(); return; }
    if (act === 'grsave') {
      if (!st.who.size) return toast('누구 사진인지 골라주세요'); if (!st.items.length) return toast('사진을 골라주세요');
      $$('[data-act=grsave]').forEach(x => { x.disabled = true; }); const memo = $('#gr-memo').value.trim() || null; let n = 0;
      S.db.growth ||= [];
      for (const [i, x] of st.items.entries()) { n++; $('.vf-foot .btn-pri').textContent = `올리는 중 ${n}/${st.items.length}`;
        let path = null; const d = x.date || today();
        if (S.token && !OFFLINE) { try { path = await ghPutFile(`photos/growth/${d.slice(0, 4)}/${d}_${Date.now().toString(36)}_${i}.jpg`, x.b64, `jjtrip: growth ${[...st.who].join(',')}`); } catch (err) { toast('사진 업로드 실패: ' + err.message, 3500); } }
        if (!path) { const local = LS.get('photos', {}); const key = `local:growth:${Date.now().toString(36)}${i}`; local[key] = x.url; try { LS.set('photos', local); path = key; } catch { toast('이 기기 저장 공간 부족 — 사진 생략'); } }
        if (path) S.db.growth.push({ id: uid('g'), who: [...st.who], date: x.date || null, photo: path, memo }); }
      markDirty(); closeSheet(); toast(`성장 앨범 ${n}장 저장`); openJournal({ page: true, growth: true, gwho: st.who.size === 1 ? [...st.who][0] : '' });
    }
  };
}
function openGrowthBirth() {
  const fam = familyNames(), by = (S.db.meta.family || {}).birthYear || {};
  openSheet(`<div class="vf-sheet"><div class="hd"><button class="lnk" data-act="back">취소</button><b>생년 설정</b><button class="lnk pri" data-act="bysave">저장</button></div><div class="vf-scroll" style="padding:16px">
    <p class="cap3">사진 옆에 「○살」을 표시하는 데만 씁니다 · 생일은 저장하지 않고 <b>태어난 해만</b> 저장해요</p>
    ${fam.map(n => `<div class="ti-f" style="margin-top:10px"><label>${esc(n)}</label><input type="number" min="1930" max="${new Date().getFullYear()}" data-by="${esc(n)}" placeholder="예: 2014" value="${esc(by[n] || '')}"></div>`).join('')}</div></div>`);
  $('#sheet-inner').onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.act === 'back') return closeSheet();
    if (b.dataset.act === 'bysave') { const o = {}; $$('[data-by]').forEach(i => { if (+i.value) o[i.dataset.by] = +i.value; }); S.db.meta.family ||= {}; S.db.meta.family.birthYear = o; markDirty(); closeSheet(); toast('생년 저장'); openJournal({ page: true, growth: true, gwho: S.gwho || '' }); } };
}
function growthPlay(who) {                                         // 연도순 재생 (전체 화면 · 자동 넘김)
  const list = growthEnts(who); if (!list.length) return;
  document.getElementById('grplay')?.remove(); const el = document.createElement('div'); el.id = 'grplay'; el.className = 'grplay'; document.body.appendChild(el);
  let i = 0, on = true, tm = null;
  let lastY = null;
  const draw = () => { const g = list[i], y = (g.date || '').slice(0, 4), names = who ? [who] : (g.who || []); const newY = y && y !== lastY && !REDUCE(); lastY = y;
    el.innerHTML = `<div class="gp-img" style="background-image:url('${photoUrl(g.photo)}')"></div><div class="gp-cap"><b class="serif">${esc(y || '')}</b><span>${esc(names.map(n => n + (growthAge(n, g.date) ? ' ' + growthAge(n, g.date) : '')).join(' · '))}</span>${g.memo ? `<em class="hand">${esc(g.memo)}</em>` : ''}<small class="num">${esc((g.date || '').replace(/-/g, '.'))} · ${i + 1}/${list.length}</small></div>
      <div class="gp-bar"><i style="width:${(i + 1) / list.length * 100}%"></i></div>
      ${newY ? `<div class="gp-title"><div class="big">${[...y].map((c, k) => `<span style="animation-delay:${(k * .07).toFixed(2)}s">${c}</span>`).join('')}</div><div class="sub">${esc(names.map(n => (n + (growthAge(n, g.date) ? ' · ' + growthAge(n, g.date) : ''))).join('  '))}</div></div>` : ''}
      <div class="gp-ctl"><button data-gp="-1">‹</button><button data-gp="0">${on ? '❚❚' : '▶'}</button><button data-gp="1">›</button><button data-gp="x">✕</button></div>`;
    const nx = list[i + 1]; if (nx) new Image().src = photoUrl(nx.photo); };
  const go = d => { i = Math.max(0, Math.min(list.length - 1, i + d)); draw(); };
  const tick = () => { clearTimeout(tm); if (!on) return; tm = setTimeout(() => { if (i >= list.length - 1) { on = false; draw(); return; } go(1); tick(); }, el.querySelector('.gp-title') ? 4000 : 2800); };
  const close = () => { clearTimeout(tm); el.remove(); document.removeEventListener('keydown', key); };
  const key = e => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') { go(1); tick(); } else if (e.key === 'ArrowLeft') { go(-1); tick(); } else if (e.key === ' ') { e.preventDefault(); on = !on; draw(); tick(); } };
  document.addEventListener('keydown', key);
  el.onclick = e => { const b = e.target.closest('[data-gp]'); if (!b) return; const a = b.dataset.gp; if (a === 'x') return close(); if (a === '0') { on = !on; draw(); return tick(); } go(+a); tick(); };
  draw(); tick();
}
function growthAddFromVisit(path, date, anchor) {                   // 방문 기록 사진 → 성장 앨범 (같은 파일 재사용, 새로 안 올림)
  if (isRO()) return goToken(); if (!path || /^local:/.test(path)) return toast('이 기기에만 있는 사진은 넣을 수 없어요');
  pickMenu(anchor, familyNames().map(n => [n, n, false]), n => { S.db.growth ||= []; if (S.db.growth.some(g => g.photo === path && (g.who || []).includes(n))) return toast('이미 들어 있어요');
    S.db.growth.push({ id: uid('g'), who: [n], date: date || null, photo: path, memo: null }); markDirty(); toast(`🌱 ${n} 성장 앨범에 추가`); });
}
/* ---------------- 애니메이션 · 장소 타이틀 (11/04) — 「동작 줄이기」 설정이면 모두 끔 ---------------- */
const REDUCE = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const CITY_EN = { 나트랑: 'Nha Trang', 다낭: 'Da Nang', 방콕: 'Bangkok', 괌: 'Guam', 평창: 'Pyeongchang', 시드니: 'Sydney', 도쿄: 'Tokyo', 오사카: 'Osaka', 후쿠오카: 'Fukuoka', 삿포로: 'Sapporo', 오키나와: 'Okinawa', 하노이: 'Hanoi', 호치민: 'Ho Chi Minh', 푸꾸옥: 'Phu Quoc', 치앙마이: 'Chiang Mai', 푸켓: 'Phuket', 싱가포르: 'Singapore', 홍콩: 'Hong Kong', 타이베이: 'Taipei', 세부: 'Cebu', 발리: 'Bali', 사이판: 'Saipan', 하와이: 'Hawaii', 제주: 'Jeju', 부산: 'Busan', 강릉: 'Gangneung', 서울: 'Seoul', 경주: 'Gyeongju', 여수: 'Yeosu', 속초: 'Sokcho', 양평: 'Yangpyeong', 가평: 'Gapyeong', 테마: 'Tema', 아크라: 'Accra' };
function regionEn(cc) { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; } catch { return cc || ''; } }
function fmtCoord(ll) { if (!ll || ll.lat == null) return ''; const a = Math.abs(+ll.lat).toFixed(2) + '°' + (ll.lat >= 0 ? 'N' : 'S'), b = Math.abs(+ll.lng).toFixed(2) + '°' + (ll.lng >= 0 ? 'E' : 'W'); return `${a}  ${b}`; }
function locTitle(big, sub, coord) {                               // 화면 가득 도시 이름 (글자가 차례로 찍힘 → 1.8초 뒤 사라짐)
  if (REDUCE() || !big) return; document.querySelector('.loctitle')?.remove();
  const latin = /^[\x20-\x7E·]+$/.test(big), el = document.createElement('div'); el.className = 'loctitle';
  el.innerHTML = `<div class="big${latin ? '' : ' ko'}">${[...big].map((c, i) => `<span style="animation-delay:${(i * .05).toFixed(2)}s">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('')}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${coord ? `<div class="crd">${esc(coord)}</div>` : ''}`;
  el.onclick = () => el.remove(); document.body.appendChild(el); setTimeout(() => el.remove(), 2400);
}
function tripTitle(t) {
  const c = tripCity(t), en = /[가-힣]/.test(c) ? (CITY_EN[c] || CITY_EN[c.split(' ')[0]] || c) : c;
  const { start, end } = tripDates(t); const d = x => x ? `${x.getFullYear()}.${String(x.getMonth() + 1).padStart(2, '0')}.${String(x.getDate()).padStart(2, '0')}` : '';
  const loc = (t.lat != null ? { lat: t.lat, lng: t.lng } : null) || (t.items || []).map(i => i.place_id && placeById(i.place_id)).find(p => p && hasCoord(p)) || S.db.bases.find(b => b.country === t.country && hasCoord(b)) || (S.geoWorld && geoCenter(t.country));
  locTitle(en, [t.country === 'KR' ? (/[가-힣]/.test(c) ? c : 'KOREA') : regionEn(t.country), start ? d(start) + (end && +end !== +start ? ' — ' + d(end).slice(5) : '') : t.year].filter(Boolean).join(' · '), fmtCoord(loc));
}
function stampFx() { if (REDUCE()) return; const im = document.createElement('img'); im.className = 'stampfx'; im.src = asset('assets/mark-stamp.png'); document.body.appendChild(im); setTimeout(() => im.remove(), 1200); }
function confettiFx() { if (REDUCE()) return; const box = document.createElement('div'); box.className = 'confetti'; const cols = ['#ffbc00', '#288d9d', '#e8913a', '#d6336c', '#5cc3d1', '#7bc67b'];
  box.innerHTML = Array.from({ length: 48 }, (_, i) => `<i style="left:${Math.random() * 100}%;background:${cols[i % cols.length]};--dx:${(Math.random() * 160 - 80).toFixed(0)}px;--r:${(Math.random() * 720 - 360).toFixed(0)}deg;animation-delay:${(Math.random() * .4).toFixed(2)}s"></i>`).join('');
  document.body.appendChild(box); setTimeout(() => box.remove(), 2600); }
function countUp(root) {                                           // 통계 숫자 0 → 값
  if (REDUCE() || !root) return;
  root.querySelectorAll('b.num').forEach(b => { const n = b.firstChild; if (!n || n.nodeType !== 3) return; const target = parseFloat(n.textContent.replace(/,/g, '')); if (!isFinite(target) || target === 0) return;
    const dec = (n.textContent.split('.')[1] || '').length, t0 = performance.now(), D = 900;
    const step = now => { const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3); n.textContent = (target * e).toFixed(dec); if (k < 1) requestAnimationFrame(step); else n.textContent = target.toFixed(dec); }; requestAnimationFrame(step); });
}
function badgeCheck(bs) {                                          // 새로 딴 배지 → 반짝 + 꽃가루 (처음 실행 땐 조용히 기록만)
  const ok = bs.filter(b => b.ok).map(b => b.name), seen = LS.get('badgesSeen', null);
  if (!seen) { LS.set('badgesSeen', ok); return []; }
  const fresh = ok.filter(n => !seen.includes(n)); if (fresh.length) { LS.set('badgesSeen', [...new Set([...seen, ...ok])]); setTimeout(() => { confettiFx(); toast(`🏅 새 배지! ${fresh.join(' · ')}`, 3500); }, 600); }
  return fresh;
}
function planeFx(map, arcs) {                                      // 항로를 따라 ✈ 날기
  if (REDUCE() || !arcs.length) return; const planes = arcs.map(pts => ({ pts, m: L.marker(pts[0], { interactive: false, zIndexOffset: 800, icon: L.divIcon({ className: 'tm-plane', html: '<span>✈</span>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map), off: Math.random() }));
  const t0 = performance.now(), D = 4200;
  const step = now => { if (!map._container || !document.body.contains(map._container)) return;
    for (const p of planes) { const k = (((now - t0) / D) + p.off) % 1, f = k * (p.pts.length - 1), i = Math.floor(f), r = f - i, a = p.pts[i], b = p.pts[Math.min(i + 1, p.pts.length - 1)];
      const ll = [a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r]; p.m.setLatLng(ll);
      const pa = map.latLngToLayerPoint(a), pb = map.latLngToLayerPoint(b), ang = Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180 / Math.PI; const sp = p.m.getElement()?.firstChild; if (sp) sp.style.transform = `rotate(${ang}deg)`; }
    requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function seasonFx(host, season) {                                  // 홈: 계절별 벚꽃·여름 반짝이·낙엽·눈
  if (REDUCE() || !host) return; host.querySelector('.season-fx')?.remove(); const k = SEASON_EN[season] || 'autumn', box = document.createElement('div'); box.className = 'season-fx ' + k;
  box.innerHTML = Array.from({ length: 16 }, () => `<i style="left:${(Math.random() * 100).toFixed(1)}%;--dx:${(Math.random() * 200 - 100).toFixed(0)}px;--r:${(Math.random() * 540).toFixed(0)}deg;animation-duration:${(7 + Math.random() * 7).toFixed(1)}s;animation-delay:-${(Math.random() * 10).toFixed(1)}s;transform:scale(${(.6 + Math.random() * .8).toFixed(2)})"></i>`).join('');
  host.appendChild(box);
}
const FX_SEL = '.jr-tile, .reco-card, .pc-log, .tp-sm, .tp-big, .gr-ph, .dcard, .log-card, .row-nl, .bdg';
let fxIO = null;
function fxObserve() {                                              // 카드가 화면에 들어올 때 살짝 떠오름
  if (REDUCE() || !('IntersectionObserver' in window)) return;
  fxIO ||= new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('fx-in'); fxIO.unobserve(e.target); } }), { threshold: .08 });
  const mark = root => root.querySelectorAll?.(FX_SEL).forEach(el => { if (el.dataset.fx) return; el.dataset.fx = 1; el.classList.add('fx-up'); fxIO.observe(el); });
  mark(document); new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && (n.matches?.(FX_SEL) ? mark(n.parentNode) : mark(n))))).observe(document.body, { childList: true, subtree: true });
}
function visitRaw(v) { return (v.photos && v.photos.length ? v.photos : v.photo ? [v.photo] : []).filter(x => photoUrl(x)); }
function openLightbox(srcs, i = 0, cap = '', meta = null) {        // 사진 크게 보기 (좌우 넘김 · 스와이프) · meta: { raws, date } 있으면 「성장 앨범」 버튼
  document.getElementById('lb')?.remove(); if (!srcs.length) return;
  const el = document.createElement('div'); el.id = 'lb'; el.className = 'lb'; document.body.appendChild(el);
  const draw = () => { el.innerHTML = `<img src="${srcs[i]}" alt=""><button class="x" data-lbx="1">✕</button>${srcs.length > 1 ? `<button class="pv" data-lbp="-1">‹</button><button class="nx" data-lbp="1">›</button>` : ''}<p class="cap">${esc(cap)}${srcs.length > 1 ? ` · ${i + 1}/${srcs.length}` : ''}</p>${meta?.raws?.[i] ? '<button class="lb-gr" data-lbg="1">🌱 성장 앨범에 넣기</button>' : ''}`; };
  draw();
  el.onclick = e => { const b = e.target.closest('button'); if (!b) { if (e.target === el) el.remove(); return; } if (b.dataset.lbg) return growthAddFromVisit(meta.raws[i], meta.date, b); if (b.dataset.lbx) el.remove(); if (b.dataset.lbp) { i = (i + +b.dataset.lbp + srcs.length) % srcs.length; draw(); } };
  let x0 = null; el.ontouchstart = e => { x0 = e.touches[0].clientX; }; el.ontouchend = e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50 && srcs.length > 1) { i = (i + (dx < 0 ? 1 : -1) + srcs.length) % srcs.length; draw(); } x0 = null; };
  document.addEventListener('keydown', function k(ev) { if (!document.getElementById('lb')) return document.removeEventListener('keydown', k); if (ev.key === 'Escape') el.remove(); if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { i = (i + (ev.key === 'ArrowRight' ? 1 : -1) + srcs.length) % srcs.length; draw(); } });
}

/* ---------------- 뷰 전환 ---------------- */
function showView(v) {
  const sheetState = v === 'map' ? 'peek' : v === 'list' ? '' : null;
  if (v === 'map' || v === 'list') v = 'explore';
  S.view = v; S.returnTo = null;
  $$('#tabs button, #mobile-nav button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  const pages = { home: '#view-home', explore: '#main', trips: '#view-trips', journal: '#view-journal', settings: '#view-settings' };
  for (const [k, sel] of Object.entries(pages)) $(sel).classList.toggle('on', k === v);
  document.body.classList.toggle('at-home', v === 'home'); document.body.classList.toggle('at-explore', v === 'explore'); document.body.classList.toggle('at-trips', v === 'trips'); document.body.classList.toggle('at-settings', v === 'settings'); document.body.classList.toggle('at-journal', v === 'journal');
  if (v === 'explore') { setTimeout(() => map.invalidateSize(), 60); if (sheetState != null && $('#panel').setSheet) $('#panel').setSheet(sheetState); }
  if (v === 'home') { renderHome(); S.homeStale = false; } else fitPcHero();
  if (v === 'trips') renderTrips();
  if (v === 'settings') renderSettings();
  if (v === 'journal') openJournal({ page: true });
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
  // 바깥(어두운 영역) 클릭으로 닫기: 누른 곳·뗀 곳이 모두 바깥일 때만 (글자 드래그하다 바깥에서 떼면 안 닫힘) + 입력 중이면 확인
  let downBg = false;
  $('#sheet').addEventListener('pointerdown', e => { downBg = e.target.id === 'sheet'; });
  $('#sheet-inner').addEventListener('input', () => { S.sheetDirty = true; });
  $('#sheet').onclick = e => { const bg = e.target.id === 'sheet' && downBg; downBg = false; if (!bg) return;
    if (S.sheetDirty && !confirm('작성 중인 내용이 있습니다. 창을 닫을까요?')) return; closeSheet(); };
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
  applyTheme(); initMap(); bindOnce(); bindTripDrop(); fxObserve(); setTimeout(() => loadGeo(), 1500);   // 나라 목록·국가 판별용 경계 미리 받기 matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
  window.JJ = { S, get map() { return map; } };   // 콘솔 디버그용
  await load();
  boot(false);
})();
})();
