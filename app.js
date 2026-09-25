/* ==========================================================
   私人导航起始页 · 逻辑（原生 JS，无依赖）
   - 背景图：Bing 每日一图，当天缓存，每天 00:05 重拉
   - 搜索：必应 / Google / GitHub / 站内（localStorage 记住）
   - 导航：nav.json 按 group 渲染；状态：status.json（失败静默）
   - 所有外部请求失败一律 silent，不崩页
   ========================================================== */
'use strict';

/* ---------- 可配置项 ---------- */
const CONFIG = {
  navPath: 'nav.json',            // 导航数据，相对路径，本地双击 / 子路径部署都可用
  statusPath: '/status.json',     // 健康数据主路径（可改成任意 URL，如 https://xxx/status.json）
  statusPathAlt: 'status.json',   // 兜底相对路径：子路径部署 / file:// 直开时主路径会 404
  bingApi:
    // ensearch=1 强制国际版（en-US）每日图；不带它中国网络会被打回国内版
    'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US&ensearch=1',
  // 仓库内缓存的每日 Bing 图（.github/workflows/bing-bg.yml 每天自动更新）。
  // Bing 接口失败时用它兜底：同源相对路径，必定加载成功，不会再灰蒙蒙。
  fallbackBg: 'assets/bing-today.jpg',
};

/* 搜索引擎（站内 = 过滤本页卡片） */
const ENGINES = [
  { id: 'bing',   label: '必应',   url: 'https://www.bing.com/search?q=%s' },
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=%s' },
  { id: 'github', label: 'GitHub', url: 'https://github.com/search?q=%s' },
  { id: 'local',  label: '站内',   url: null },
];

/* nav.json 读取失败（file:// 直开会被 CORS 拦）时的内置兜底数据，
   与 nav.json 内容保持一致，保证「打开就能看」 */
const NAV_FALLBACK = [
  { id: 'blog',  name: '博客',      url: 'https://x.pages.dev',        icon: '📝', group: '我的' },
  { id: 'photo', name: '相册',      url: 'https://pic.x.pages.dev',    icon: '📷', group: '我的' },
  { id: 'note',  name: '备忘',      url: 'https://note.x.pages.dev',   icon: '🗒️', group: '我的' },
  { id: 'api',   name: 'API',       url: 'https://api.x.fly.dev',      group: '项目' },
  { id: 'mon',   name: '监控台',    url: 'https://status.x.com',       icon: '📊', group: '项目' },
  { id: 'doc',   name: '文档',      url: 'https://doc.x.com',          icon: '📚', group: '项目' },
  { id: 'mc',    name: 'MC 服务器', url: 'mc://play.x.com',            icon: '⛏️', group: '游戏' },
  { name: 'Steam',      url: 'https://store.steampowered.com', icon: '🎮', group: '游戏' },
  { name: 'GitHub',     url: 'https://github.com',             icon: '🐙', group: '常用' },
  { name: '哔哩哔哩',   url: 'https://www.bilibili.com',       icon: '📺', group: '常用' },
  { name: '天气预报',   url: 'https://www.weather.com.cn/',    icon: '🌤️', group: '常用' },
  { name: '邮箱',       url: 'https://mail.qq.com',            icon: '✉️', group: '常用' },
];

const $  = (s) => document.querySelector(s);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ==========================================================
   一、背景图（Bing 每日一图）
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

/* 从响应文本中提取第一个完整 JSON 对象（Bing 偶发在 JSON 尾部粘杂质，
   直接 res.json() 会炸，这里用括号配平截取，对杂质免疫） */
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
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
    const res = await fetch(CONFIG.bingApi);
    if (!res.ok) throw 0;
    const json = extractJson(await res.text());
    const data = json ? JSON.parse(json) : null;
    const pic = data && data.images && data.images[0];
    if (!pic || !pic.url) throw 0;
    const url = 'https://www.bing.com' + pic.url;
    localStorage.setItem(BG_CACHE_KEY, JSON.stringify({ date: today, url }));
    applyBg(url);
  } catch {
    /* Bing 接口失败 → 退回仓库内 Actions 缓存的每日图（同源，基本必成） */
    applyBg(CONFIG.fallbackBg);
  }
}

/* 每天 00:05（本地时间）重拉一次：算出距下个 00:05 的毫秒数，到点后递归 */
function scheduleBgRefresh() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 5, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => { loadBackground(true); scheduleBgRefresh(); }, next - now);
}

/* 标签页从休眠恢复时校验日期，跨天了就重拉（配合 00:05 定时器双保险） */
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
  ENGINES.forEach((e, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      bar.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = e.label;
    btn.classList.toggle('active', e.id === engine);
    btn.addEventListener('click', () => setEngine(e.id));
    bar.appendChild(btn);
  });
}

function setEngine(id) {
  engine = id;
  localStorage.setItem(ENGINE_KEY, id);
  renderEngineBar();
  if (id !== 'local') filterCards('');       // 切走站内时恢复全部卡片
}

/* 站内搜索：按 名字/id/网址 实时过滤卡片 */
function filterCards(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('#groups .card').forEach((card) => {
    const hit = !q || (card.dataset.keywords || '').includes(q);
    card.style.display = hit ? '' : 'none';
  });
  document.querySelectorAll('#groups .group').forEach((sec) => {
    const any = [...sec.querySelectorAll('.card')].some((c) => c.style.display !== 'none');
    sec.style.display = any ? '' : 'none';
  });
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
   三、导航卡片（nav.json → 按 group 分区渲染）
   ========================================================== */

async function loadNav() {
  try {
    const res = await fetch(CONFIG.navPath);
    if (!res.ok) throw 0;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw 0;
    return data;
  } catch {
    // file:// 直开 fetch 会被浏览器拦，这里静默降级到内置数据
    console.info('[nav] nav.json 读取失败，已使用内置示例数据（部署后正常）。');
    return NAV_FALLBACK;
  }
}

function renderNav(items) {
  // 按首次出现的顺序分组，无 group 的归「其他」
  const groups = new Map();
  items.forEach((it) => {
    const g = it.group || '其他';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  });

  const wrap = $('#groups');
  for (const [g, list] of groups) {
    const sec = document.createElement('section');
    sec.className = 'group';
    sec.innerHTML = `<h2 class="group-title">${esc(g)}</h2>`;

    const box = document.createElement('div');
    box.className = 'group-cards';

    list.forEach((it) => {
      const a = document.createElement('a');
      a.className = 'card';
      a.href = it.url;
      a.target = '_blank';                    // 新标签页打开
      a.rel = 'noopener';
      // 状态匹配键：优先 id，其次 name —— 需与 status.json 的 key 一致
      a.dataset.id = String(it.id || it.name || '');
      a.dataset.keywords =
        `${it.name || ''} ${it.id || ''} ${it.url || ''}`.toLowerCase();

      const icon = it.icon || (it.name || '?').trim().charAt(0) || '?';
      a.innerHTML =
        `<span class="card-icon">${esc(icon)}</span>` +
        `<span class="card-name">${esc(it.name)}</span>` +
        `<span class="dot" style="background:var(--dot-none)"></span>` +
        `<span class="card-status">暂无数据</span>`;
      box.appendChild(a);
    });

    sec.appendChild(box);
    wrap.appendChild(sec);
  }
}

/* ==========================================================
   四、健康状态（status.json）
   ----------------------------------------------------------
   ★【以后接 Uptime Kuma】看这里：
     静态页自己不会轮询 Kuma，推荐两种接法（前端零改动）：
     A. 定时生成静态文件（推荐）：
        GitHub Actions / Serv00 cron 每 5 分钟请求 Kuma 的 API
        （/api/statusPage/xxx 或 heartbeat 接口），把结果转成
        本文件约定的结构，写入 status.json 提交仓库或上传站点。
     B. 直接改 CONFIG.statusPath 指向你的 Kuma 暴露接口 /
        Worker 代理（需要带 Key 时放代理层）。
     数据结构约定（key = nav.json 的 id，没写 id 则用 name）：
       { "blog": { "ok": true, "ping": 38 },
         "api":  { "ok": false },
         "mc":   { "online": 7, "max": 40, "version": "1.21.1", "accurate": true } }
   ========================================================== */

async function loadStatus() {
  // 主路径失败再试相对路径（file:// / 子路径部署时绝对路径会 404）
  for (const p of [CONFIG.statusPath, CONFIG.statusPathAlt]) {
    try {
      const res = await fetch(p, { cache: 'no-store' });
      if (!res.ok) continue;
      const data = await res.json();
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch { /* silent，试下一个 */ }
  }
  return null;   // 拿不到 → 所有圆点变灰，页面照常
}

/* 单项状态判定：返回 [圆点颜色变量名, 气泡文案] */
function judge(s) {
  if (!s) return ['--dot-unknown', '未知'];
  const hasMc = typeof s.online === 'number' && typeof s.max === 'number';

  if (s.ok === false && !hasMc) return ['--dot-down', '离线'];

  if (s.ok === true || hasMc) {
    if (hasMc) {
      // MC：accurate=true 才显示人数，否则显示「MC ?」
      // ★【以后接 MC RCON / Server List Ping】看这里：
      //   浏览器开不了 TCP，无法直接 RCON/SLP，所以在线人数由外部
      //   定时任务（Serv00 cron / GitHub Actions + python mcstatus，
      //   或 MCSManager API）查好后写进 status.json 的 mc 字段。
      //   以后若自建了 HTTP 查询服务，可在这里改成 fetch 你的接口。
      if (s.accurate) {
        const ver = s.version ? ` · ${s.version}` : '';
        return ['--dot-up', `在线 ${s.online}/${s.max}${ver}`];
      }
      return ['--dot-up', 'MC ?'];
    }
    return ['--dot-up', typeof s.ping === 'number' ? `正常 · ${s.ping}ms` : '正常'];
  }
  return ['--dot-unknown', '未知'];
}

function applyStatus(status) {
  document.querySelectorAll('#groups .card').forEach((card) => {
    const dot = card.querySelector('.dot');
    const tip = card.querySelector('.card-status');
    if (!status) {                            // status.json 拿不到 → 全灰，不报错
      dot.style.background = 'var(--dot-none)';
      tip.textContent = '暂无数据';
      return;
    }
    const [color, text] = judge(status[card.dataset.id]);
    dot.style.background = `var(${color})`;
    tip.textContent = text;
  });
}

/* ==========================================================
   五、时钟（每秒刷新，只显示 时:分，克制不加秒）
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
  loadBackground(false);          // 背景先拉（有当天缓存就不发请求）
  scheduleBgRefresh();            // 每天 00:05 重拉

  renderNav(await loadNav());     // 先渲染卡片
  applyStatus(await loadStatus());// 再套健康状态（拿不到就全灰）
})();
