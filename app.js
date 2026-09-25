/* ==========================================================
   私人导航起始页 · 逻辑（原生 JS，无依赖）
   - 背景：Bing 国际版每日图 → 仓库缓存图兜底 → 渐变兜底
   - 搜索：必应 / Google / GitHub / 站内（localStorage 记住）
   - 导航：nav.json 横向分类 tabs（仿青柠）
   - 监测：普通站点 favicon 探测 + MC 双源 API + Uptime Kuma 预留
   - 所有请求失败一律 silent，不崩页
   ========================================================== */
'use strict';

/* ---------- 可配置项 ---------- */
const CONFIG = {
  navPath: 'nav.json',

  /* ★【Uptime Kuma 直连】在 status.camzy.uno 后台新建「公开状态页」后，
     把它的 slug 填到这里（状态页地址 https://status.camzy.uno/status/{slug}
     末尾那段就是 slug）。留空则使用下方的 favicon 探测法。 */
  kumaBase: 'https://status.camzy.uno',
  kumaSlug: '',

  /* MC 服务器（Java 版 SLP 查询，双源：mcstatus.io → mcsrvstat.us） */
  mcTarget: 'create.liminalily.com:25565',

  bingApi:
    // ensearch=1 强制国际版（en-US）每日图；不带它中国网络会被打回国内版
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US&ensearch=1',
  // 仓库内缓存的每日 Bing 图（bing-bg.yml 每天自动更新）
  fallbackBg: 'assets/bing-today.jpg',

  probeTimeout: 8000,      // 单次探测超时（毫秒）
  refreshEvery: 60000,     // 状态刷新周期（毫秒）
};

/* 搜索引擎（站内 = 过滤本页卡片）
   icon: 青柠 iconfont 码点；svg: 无字体图标时的内联 SVG（如 GitHub octocat） */
const ENGINES = [
  { id: 'bing',   label: '必应',   icon: '\ue608',
    url: 'https://www.bing.com/search?q=%s' },
  { id: 'google', label: 'Google', icon: '\ue624',
    url: 'https://www.google.com/search?q=%s' },
  { id: 'github', label: 'GitHub',
    svg: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/></svg>',
    url: 'https://github.com/search?q=%s' },
  { id: 'local',  label: '站内',   icon: '\ue67e', url: null },
];

/* nav.json 读取失败（file:// 直开）时的内置兜底，与 nav.json 保持一致 */
const NAV_FALLBACK = [
  { id: 'wiki',   name: 'Wiki',      url: 'https://catfix.top',       icon: 'assets/icons/bookstack.webp',   group: '站点' },
  { id: 'blog',   name: '博客',      url: 'https://web.catfix.top',   icon: 'assets/icons/astro.svg',        group: '站点' },
  { id: 'dl',     name: '下载站',    url: 'https://camzy.uno',        icon: 'assets/icons/gopeed.webp',      group: '站点' },
  { id: 'sso',    name: 'MZY SSO',   url: 'https://sso.camzy.uno',    icon: 'assets/icons/logto.webp',       group: '服务' },
  { id: 'api',    name: 'New API',   url: 'https://api.camzy.uno',    icon: 'assets/icons/new-api.webp',     group: '服务' },
  { id: 'status', name: '服务状态',  url: 'https://status.camzy.uno', icon: 'assets/icons/uptime-kuma.webp', group: '服务' },
  { id: 'mc',     name: 'MC 服务器', url: 'mc://create.liminalily.com:25565', icon: 'assets/icons/minecraft.webp', group: '游戏', monitor: 'minecraft' },
];

const $  = (s) => document.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 带超时的 fetch（默认 8s，超时抛错走兜底），可透传额外选项 */
function fetchTimeout(url, ms = CONFIG.probeTimeout, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return fetch(url, { signal: ac.signal, cache: 'no-store', ...opts })
    .finally(() => clearTimeout(t));
}

/* ==========================================================
   一、背景图（Bing 国际版每日一图）
   ========================================================== */

const BG_CACHE_KEY = 'nav.bg';
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

function applyBg(url, canRetryFallback = true) {
  const el = $('#bg');
  const img = new Image();
  // 10s 还没加载出来也走兜底，避免一直卡在灰底过渡态
  const timer = setTimeout(() => { img.src = ''; fail(); }, 10000);
  const fail = () => {
    // 当前图挂了：先退回仓库缓存图（若还没用过它），再退到渐变
    if (canRetryFallback && url !== CONFIG.fallbackBg) applyBg(CONFIG.fallbackBg, false);
    else showBgFallback();
  };
  img.onload = () => {                       // 预加载成功后才淡入
    clearTimeout(timer);
    el.style.backgroundImage = `url("${url}")`;
    el.classList.remove('bg-fallback');
    el.classList.add('is-ready');
  };
  img.onerror = () => { clearTimeout(timer); fail(); };
  img.src = url;
}

/* 接口/图片失败时的兜底：柔和青柠渐变（CSS 里定义），页面不灰蒙蒙 */
function showBgFallback() {
  $('#bg').classList.add('bg-fallback', 'is-ready');
}

/* 从响应文本中提取第一个完整 JSON 对象（Bing 偶发在尾部粘杂质） */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, escNext = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (escNext) escNext = false;
      else if (c === '\\') escNext = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (!depth) return text.slice(start, i + 1); }
    }
  }
  return null;
}

async function loadBackground(force = false) {
  const today = todayStr();

  // 当天已有缓存 → 直接用，不重复请求
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(BG_CACHE_KEY));
      if (c && c.date === today && c.url) { applyBg(c.url); return; }
    } catch { /* 缓存损坏就当没有 */ }
  }

  try {
    const res = await fetchTimeout(CONFIG.bingApi);
    if (!res.ok) throw 0;
    const json = extractJson(await res.text());
    const data = json ? JSON.parse(json) : null;
    const pic = data && data.images && data.images[0];
    if (!pic || !pic.url) throw 0;
    const url = 'https://www.bing.com' + pic.url;
    localStorage.setItem(BG_CACHE_KEY, JSON.stringify({ date: today, url }));
    applyBg(url);
  } catch {
    /* Bing 接口失败 → 退回仓库内缓存的每日图（同源，基本必成） */
    applyBg(CONFIG.fallbackBg);
  }
}

/* 每天 00:05（本地时间）重拉一次 */
function scheduleBgRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { loadBackground(true); scheduleBgRefresh(); }, next - now);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadBackground(false);
});

/* ==========================================================
   二、搜索（引擎切换 + 快捷键 + 站内过滤）
   ========================================================== */

const ENGINE_KEY = 'nav.engine';
const input = $('#searchInput');
let engine = localStorage.getItem(ENGINE_KEY) || 'bing';
if (!ENGINES.some((e) => e.id === engine)) engine = 'bing';

function renderEngineBar() {
  const bar = $('#engineBar');
  bar.innerHTML = '';
  ENGINES.forEach((e) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.classList.toggle('active', e.id === engine);
    const icon = e.icon
      ? `<span class="engine-icon lime-icon">${e.icon}</span>`
      : `<span class="engine-icon">${e.svg || ''}</span>`;
    btn.innerHTML = `${icon}<span>${esc(e.label)}</span>`;
    btn.addEventListener('click', () => setEngine(e.id));
    bar.appendChild(btn);
  });
}

function setEngine(id) {
  engine = id;
  localStorage.setItem(ENGINE_KEY, id);
  renderEngineBar();
  if (id !== 'local') filterCards('');
}

/* 站内搜索：按 名字/id/网址 实时过滤卡片 */
function filterCards(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#groups .card').forEach((card) => {
    const hit = !q || (card.dataset.keywords || '').includes(q);
    card.style.display = hit ? '' : 'none';
  });
  refreshGroupsVisibility();
}

function doSearch() {
  const q = input.value.trim();
  if (!q) return;
  const eng = ENGINES.find((e) => e.id === engine);
  if (eng && eng.url) {
    location.href = eng.url.replace('%s', encodeURIComponent(q));
    return;
  }
  // 站内：回车打开第一个匹配的卡片
  const first = [...document.querySelectorAll('#groups .card')]
    .find((c) => c.style.display !== 'none');
  if (first) window.open(first.href, '_blank', 'noopener');
}

input.addEventListener('input', () => {
  if (engine === 'local') filterCards(input.value);
});
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  doSearch();
});

/* 快捷键："/" 聚焦搜索框，Esc 清空 */
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
  } else if (e.key === 'Escape' && document.activeElement === input) {
    input.value = '';
    filterCards('');
    input.blur();
  }
});

/* ==========================================================
   三、导航卡片（nav.json → 横向分类 tabs，仿青柠）
   ========================================================== */

const TAB_KEY = 'nav.tab';
let activeTab = localStorage.getItem(TAB_KEY) || 'all';

function applyTab() {
  document.querySelectorAll('.group-tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === activeTab));
  $('#groups').dataset.all = activeTab === 'all' ? '1' : '0';
  refreshGroupsVisibility();
}

/* 分组可见性 = tab 匹配 && 组内有（符合过滤条件的）卡片；站内搜索时跨全部分类 */
function refreshGroupsVisibility() {
  const q = (engine === 'local' ? input.value : '').trim().toLowerCase();
  document.querySelectorAll('#groups .group').forEach((sec) => {
    const hasVisible = [...sec.querySelectorAll('.card')].some((c) =>
      c.style.display !== 'none' && (!q || (c.dataset.keywords || '').includes(q)));
    const tabOk = q || activeTab === 'all' || sec.dataset.group === activeTab;
    sec.style.display = (tabOk && hasVisible) ? '' : 'none';
  });
}

async function loadNav() {
  try {
    const res = await fetch(CONFIG.navPath);
    if (!res.ok) throw 0;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw 0;
    return data;
  } catch {
    console.info('[nav] nav.json 读取失败，已使用内置数据。');
    return NAV_FALLBACK;
  }
}

function renderNav(items) {
  const groups = new Map();
  items.forEach((it) => {
    const g = it.group || '其他';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  });

  const wrap = $('#groups');

  /* 分类 tabs */
  const tabBar = document.createElement('div');
  tabBar.className = 'group-tabs';
  const mkTab = (label, key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'group-tab';
    b.textContent = label;
    b.dataset.tab = key;
    b.addEventListener('click', () => {
      activeTab = key;
      localStorage.setItem(TAB_KEY, key);
      applyTab();
    });
    return b;
  };
  tabBar.appendChild(mkTab('全部', 'all'));
  for (const g of groups.keys()) tabBar.appendChild(mkTab(g, g));
  wrap.appendChild(tabBar);

  /* 各分组卡片面板 */
  for (const [g, list] of groups) {
    const sec = document.createElement('section');
    sec.className = 'group';
    sec.dataset.group = g;
    sec.innerHTML = `<h2 class="group-title">${esc(g)}</h2>`;

    const box = document.createElement('div');
    box.className = 'group-cards';

    list.forEach((it) => {
      const a = document.createElement('a');
      a.className = 'card';
      a.href = it.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.dataset.id = String(it.id || it.name || '');
      a.dataset.monitor = it.monitor || '';     // minecraft → 走 MC 双源查询
      a.dataset.url = it.url || '';
      a.dataset.keywords =
        `${it.name || ''} ${it.id || ''} ${it.url || ''}`.toLowerCase();

      // 图标：路径（含 /，如 assets/icons/xx.webp）→ <img>；否则当作 emoji/文本
      const iconHtml = /\//.test(it.icon || '')
        ? `<img class="card-img" src="${esc(it.icon)}" alt="" loading="lazy">`
        : esc(it.icon || '');
      a.innerHTML =
        `<span class="card-icon">${iconHtml}</span>` +
        `<span class="card-name">${esc(it.name)}</span>` +
        `<span class="dot" style="background:var(--dot-none)"></span>` +
        `<span class="card-status">检测中…</span>`;
      box.appendChild(a);
    });

    sec.appendChild(box);
    wrap.appendChild(sec);
  }

  applyTab();
}

/* ==========================================================
   四、实时监测
   ----------------------------------------------------------
   ★【Uptime Kuma 直连】status.camzy.uno 当前是登录后的私有面板，
     前端拿不到数据。在 Kuma 后台新建一个「公开状态页」后，
     把 CONFIG.kumaSlug 填上即可自动启用：每张卡片按「名称」
     匹配 Kuma 监控项，显示 在线/离线 + 延迟（比探测法更准）。
     未启用时用下面的 favicon 探测法。
   ★【MC 服务器】双源查询 mcstatus.io → mcsrvstat.us（均允许跨域）。
     注意：这两个公共 API 的探测节点在国外，若你的服务器只对国内
     放行 SLP 响应，会查不到——此时显示「探测超时」而不是误报离线。
     建议同时在 Kuma 里加一条 Minecraft 监控（国内探测是通的），
     并启用公开状态页，数据最准。
   ========================================================== */

/* 普通站点探测：先加载 favicon（onload=可达），失败再用 no-cors fetch 复核 */
function probeSite(url) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => fin('timeout'), CONFIG.probeTimeout);

    const origin = url.match(/^https?:\/\/[^/]+/);
    const img = new Image();
    img.onload = () => { clearTimeout(timer); fin('up'); };
    img.onerror = async () => {
      // favicon 404 ≠ 站点挂了：no-cors fetch 收到任何响应（含 4xx/5xx）都算活着
      try {
        await fetchTimeout(url, CONFIG.probeTimeout, { mode: 'no-cors' });
        clearTimeout(timer); fin('up');
      } catch {
        clearTimeout(timer); fin('down');
      }
    };
    img.src = (origin ? origin[0] : url) + '/favicon.ico?_=' + Date.now();
  });
}

/* MC 双源查询：mcstatus.io 优先，mcsrvstat.us 兜底 */
async function fetchMc() {
  const t = CONFIG.mcTarget;                       // host:port
  // 源 1：mcstatus.io
  try {
    const r = await fetchTimeout(`https://api.mcstatus.io/v2/status/java/${t}`);
    if (r.ok) {
      const d = await r.json();
      if (d.online) {
        return {
          up: true,
          players: d.players ? `${d.players.online}/${d.players.max}` : null,
          version: d.version ? d.version.name_clean : null,
        };
      }
      return { up: false };
    }
  } catch { /* 落到源 2 */ }
  // 源 2：mcsrvstat.us
  try {
    const r = await fetchTimeout(`https://api.mcsrvstat.us/3/${t}`);
    if (r.ok) {
      const d = await r.json();
      if (d && d.online) {
        return {
          up: true,
          players: d.players ? `${d.players.online}/${d.players.max}` : null,
          version: d.version || null,
        };
      }
      return { up: false };
    }
  } catch { /* 双源都超时 */ }
  return null;                                     // null = 探测超时/未知
}

/* Uptime Kuma 公开状态页（CONFIG.kumaSlug 填了才启用）
   返回映射：{ 监控项名称: { up: bool, ping: 毫秒 } } */
async function loadKuma() {
  if (!CONFIG.kumaSlug) return null;
  try {
    const [confR, hbR] = await Promise.all([
      fetchTimeout(`${CONFIG.kumaBase}/api/status-page/${CONFIG.kumaSlug}`),
      fetchTimeout(`${CONFIG.kumaBase}/api/status-page/heartbeat/${CONFIG.kumaSlug}`),
    ]);
    if (!confR.ok || !hbR.ok) return null;
    const conf = await confR.json();
    const hb = await hbR.json();
    const map = {};
    const monitors = (conf.data && conf.data.monitorList) || {};
    const beats = (hb.heartbeatList) || {};
    for (const [mid, m] of Object.entries(monitors)) {
      const list = beats[mid] || [];
      const last = list[list.length - 1];
      if (m.name) {
        map[m.name] = {
          up: last ? last.status === 1 : false,
          ping: last && typeof last.ping === 'number' ? last.ping : null,
        };
      }
    }
    return map;
  } catch {
    return null;
  }
}

/* 单张卡片状态写入：dot 颜色 + hover 气泡文案 */
function setCardState(card, dot, text) {
  card.querySelector('.dot').style.background = `var(${dot})`;
  card.querySelector('.card-status').textContent = text;
}

/* 刷新全部卡片状态：Kuma 优先 → MC 双源 → favicon 探测 */
async function refreshStatus() {
  const kuma = await loadKuma();

  document.querySelectorAll('#groups .card').forEach(async (card) => {
    if (card.dataset.monitor === 'minecraft') {
      const mc = await fetchMc();
      if (mc === null) setCardState(card, '--dot-unknown', '探测超时');
      else if (!mc.up) setCardState(card, '--dot-down', '离线');
      else {
        const parts = [];
        if (mc.players) parts.push(mc.players);
        if (mc.version) parts.push(mc.version);
        setCardState(card, '--dot-up',
          '在线' + (parts.length ? ' · ' + parts.join(' · ') : ''));
      }
      return;
    }

    // Kuma 心跳优先（按卡片名称匹配监控项）
    if (kuma) {
      const name = card.querySelector('.card-name').textContent;
      const s = kuma[name] || kuma[card.dataset.id];
      if (s) {
        setCardState(card, s.up ? '--dot-up' : '--dot-down',
          (s.up ? '正常' : '离线') + (s.ping ? ` · ${s.ping}ms` : ''));
        return;
      }
    }

    // 普通站点：favicon 探测
    const r = await probeSite(card.dataset.url);
    if (r === 'up') setCardState(card, '--dot-up', '可达');
    else if (r === 'down') setCardState(card, '--dot-down', '无响应');
    else setCardState(card, '--dot-unknown', '探测超时');
  });
}

/* ==========================================================
   五、时钟（每秒刷新，只显示 时:分）
   ========================================================== */

function tickClock() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  $('#clockTime').innerHTML = `${hh}<span class="colon">:</span>${mm}`;
  const weeks = ['日', '一', '二', '三', '四', '五', '六'];
  $('#clockDate').textContent =
    `${d.getMonth() + 1}月${d.getDate()}日 · 星期${weeks[d.getDay()]}`;
}

/* ==========================================================
   六、启动
   ========================================================== */

(async function init() {
  tickClock();
  setInterval(tickClock, 1000);

  renderEngineBar();
  loadBackground(false);
  scheduleBgRefresh();

  renderNav(await loadNav());   // 先渲染卡片
  refreshStatus();              // 再做实时监测
  setInterval(refreshStatus, CONFIG.refreshEvery);  // 每分钟自动刷新
})();
