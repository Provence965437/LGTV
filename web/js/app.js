/* ============================================================
   HUANGJU 前端 · 共享逻辑
   - 认证/收藏走后端 API（38.55.194.47:8787），未登录时回退本地
   - 目录数据：data/dramas.json
   ============================================================ */

(function (global) {
  "use strict";

  const state = {
    dramas: [],
    ready: false,
    favs: new Set(),   // 收藏 drama id（字符串）
    user: null,        // 当前登录用户
  };

  /* 后端 API 基址：部署后同源相对路径（IP 的 /hj/ 前缀或域名根路径均由 nginx 反代）；仅本地 file:// 预览指向服务器 */
  const API = location.protocol === "file:" ? "http://38.55.194.47/hj" : ".";

  /* 真实分类（按库内数量降序） */
  const CATS = [
    "经典魔改", "AI魔改", "AI换脸", "都市爱情", "特殊趣味",
    "家庭伦理", "古装玄幻", "异能穿越", "校园记忆", "域外传奇",
    "现代惊悚", "AI演示", "经典动漫", "特殊口味",
  ];

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function heat(n) {
    n = Number(n) || 0;
    return n.toLocaleString("zh-CN");
  }

  /* 展示用评分：库内 rating 为空，按热度确定性派生（占位） */
  function score(d) {
    const h = Math.min(Number(d.heat) || 0, 9999);
    const base = 7.0 + (h / 9999) * 2.2;          // 7.0 ~ 9.2
    const jitter = (((d.id * 2654435761) >>> 0) % 1000) / 1000 * 0.6;
    return Math.min(9.9, base + jitter).toFixed(1);
  }

  function byId(id) {
    return state.dramas.find((d) => String(d.id) === String(id));
  }

  function bySid(sid) {
    return state.dramas.find((d) => String(d.sid) === String(sid));
  }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  /* ---------- 会话 ---------- */
  function token() {
    try { return localStorage.getItem("huangju_token") || ""; } catch { return ""; }
  }
  function getUser() {
    try {
      const raw = localStorage.getItem("huangju_user");
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function setSession(t, u) {
    try {
      localStorage.setItem("huangju_token", t || "");
      localStorage.setItem("huangju_user", JSON.stringify(u));
    } catch {}
  }
  function clearSession() {
    try {
      localStorage.removeItem("huangju_token");
      localStorage.removeItem("huangju_user");
    } catch {}
  }
  function isLoggedIn() { return !!token(); }

  /* ---------- API 调用 ---------- */
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({}, opts.headers || {});
    const t = token();
    if (t) headers["Authorization"] = "Bearer " + t;
    if (opts.body) headers["Content-Type"] = "application/json";
    const res = await fetch(API + path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
  }

  async function refreshAuth() {
    if (!isLoggedIn()) { state.user = null; renderLoginState(); return; }
    try {
      const { status, data } = await api("/api/me");
      if (status === 200 && data && data.ok) {
        state.user = data.user;
        setSession(token(), data.user);
      } else {
        clearSession();
        state.user = null;
      }
    } catch { /* 网络异常时保留本地会话，避免误登出 */ }
    renderLoginState();
  }

  async function logout() {
    try { await api("/api/logout", { method: "POST", body: JSON.stringify({ token: token() }) }); } catch {}
    clearSession();
    state.user = null;
    state.favs = new Set();
    renderLoginState();
    toast("已退出登录");
    const here = location.pathname.split("/").pop() || "index.html";
    setTimeout(() => {
      if (here === "index.html" || here === "") location.reload();
      else location.href = "index.html";
    }, 600);
  }

  /* ---------- 收藏 ---------- */
  async function loadFavs() {
    if (!isLoggedIn()) { state.favs = new Set(); return; }
    try {
      const { status, data } = await api("/api/favs");
      if (status === 200 && data && Array.isArray(data.favs)) {
        state.favs = new Set(data.favs.map(String));
        return;
      }
      if (status === 401) { clearSession(); state.user = null; renderLoginState(); }
    } catch {}
    state.favs = new Set();
  }

  /* 收藏需登录；同步返回新状态，异步持久化到后端 */
  function toggleFav(id) {
    const k = String(id);
    if (!isLoggedIn()) {
      toast("请先登录后再收藏");
      const here = location.pathname.split("/").pop() || "index.html";
      setTimeout(() => {
        location.href = "login.html?next=" + encodeURIComponent(here + location.search);
      }, 700);
      return null;
    }
    const now = !state.favs.has(k);
    if (now) state.favs.add(k); else state.favs.delete(k);
    toast(now ? "已加入我的片单" : "已从片单移除");
    api("/api/favs/" + k, { method: now ? "PUT" : "DELETE" })
      .then(({ status }) => {
        if (status === 401) { clearSession(); state.user = null; renderLoginState(); }
      })
      .catch(() => {});
    document.dispatchEvent(new CustomEvent("favchange", { detail: { id: k } }));
    return now;
  }

  function isFav(id) { return state.favs.has(String(id)); }

  /* ---------- 数据加载 ---------- */
  async function load() {
    if (state.ready) return state.dramas;
    const res = await fetch("data/dramas.json", { cache: "no-store" });
    if (!res.ok) throw new Error("load data failed: " + res.status);
    const list = await res.json();
    const seen = new Set();
    state.dramas = list.filter((d) => {
      const k = String(d.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    state.ready = true;
    return state.dramas;
  }

  /* 启动：加载剧集 + 收藏 + 校验登录态 */
  async function boot() {
    await Promise.all([load(), loadFavs(), refreshAuth()]);
    return state.dramas;
  }

  /* ---------- 海报卡片 ---------- */
  function card(d, opts) {
    opts = opts || {};
    const rating = score(d);
    const h = heat(d.heat);
    const favd = isFav(d.id);
    return `
    <a class="poster-card" href="play.html?id=${d.id}" title="${esc(d.t)}">
      <img src="${esc(d.poster)}" alt="${esc(d.t)}" loading="lazy"
           onerror="window.__posterFallback && window.__posterFallback(this)">
      <span class="corner">${esc(d.cat || "精选")}</span>
      <span class="shade"></span>
      <span class="p-play"><span class="ring"></span></span>
      <button type="button" class="p-fav ${favd ? "on" : ""}" data-id="${d.id}" aria-label="${favd ? "从片单移除" : "加入片单"}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>
      </button>
      <span class="p-meta">
        <span class="p-title">${esc(d.t)}</span>
        <span class="p-sub">
          <span style="color:var(--accent)">★ ${rating}</span>
          <span>·</span><span>${esc(d.ep)}集</span>
          <span>·</span><span>${h}热度</span>
        </span>
      </span>
    </a>`;
  }

  function renderCards(container, list) {
    container.innerHTML = list.map((d) => card(d)).join("");
  }

  /* ---------- 封面兜底（渐变 + 首字） ---------- */
  function posterFallback(img, title) {
    title = title || img.getAttribute("alt") || "剧";
    const ch = (title || "剧").trim().charAt(0) || "剧";
    const seed = Math.abs(img.src.length * 31) % 360;
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='600'>
        <defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
          <stop offset='0' stop-color='hsl(${seed},35%,18%)'/>
          <stop offset='1' stop-color='hsl(${(seed+40)%360},40%,10%)'/>
        </linearGradient></defs>
        <rect width='400' height='600' fill='url(#g)'/>
        <text x='200' y='315' font-size='120' fill='rgba(255,255,255,0.22)'
          font-family='serif' text-anchor='middle'>${ch}</text>
      </svg>`;
    img.onerror = null;
    img.src = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  global.__posterFallback = posterFallback;

  /* ---------- 顶栏 / 登录态 / 搜索 / Toast ---------- */
  function renderLoginState() {
    const na = $(".nav-actions");
    if (!na) return;
    const user = state.user || getUser();
    const box = na.querySelector(".userbox");
    if (box) box.remove();
    const oldLink = na.querySelector('a[href="login.html"]');
    if (oldLink) oldLink.remove();

    if (user) {
      const u = document.createElement("div");
      u.className = "userbox";
      const nm = esc(user.nickname || user.account || "影迷");
      u.innerHTML =
        `<a class="btn btn-ghost btn-sm" href="favorites.html" title="我的片单">👤 ${nm}</a>` +
        `<button type="button" class="btn btn-ghost btn-sm" id="btn-logout">退出</button>`;
      na.appendChild(u);
      u.querySelector("#btn-logout").addEventListener("click", logout);
    } else {
      const a = document.createElement("a");
      a.className = "btn btn-ghost btn-sm";
      a.href = "login.html";
      a.textContent = "登录";
      na.appendChild(a);
    }
  }

  function initHeader() {
    const header = $(".site-header");
    const onScroll = () => header && header.classList.toggle("scrolled", window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    // 当前页高亮
    const page = location.pathname.split("/").pop() || "index.html";
    $$(".nav-links a").forEach((a) => {
      const href = a.getAttribute("href");
      if (href === page) a.classList.add("active");
    });

    // 搜索
    const input = $("#nav-search");
    if (input) {
      const go = () => {
        const v = input.value.trim();
        if (v) location.href = "index.html?q=" + encodeURIComponent(v);
      };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
      const btn = $("#nav-search-btn");
      if (btn) btn.addEventListener("click", go);
    }

    // 登录态（本地会话即时渲染；token 校验由 boot() 异步完成）
    renderLoginState();
  }

  function toast(msg) {
    let el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), 2400);
  }

  /* ---------- 卡片爱心按钮：事件委托 + 状态同步 ---------- */
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".p-fav");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFav(btn.dataset.id);
  });
  document.addEventListener("favchange", (e) => {
    const id = e.detail && e.detail.id;
    $$(".p-fav").forEach((b) => {
      if (id == null || b.dataset.id === String(id)) {
        const on = isFav(b.dataset.id);
        b.classList.toggle("on", on);
        b.setAttribute("aria-label", on ? "从片单移除" : "加入片单");
      }
    });
  });

  global.App = {
    load, boot, esc, heat, score, byId, bySid, qs, CATS,
    card, renderCards, initHeader, toast, toggleFav, isFav,
    api, token, getUser, setSession, clearSession, isLoggedIn, logout, refreshAuth,
    get dramas() { return state.dramas; },
    get favs() { return [...state.favs]; },
    get user() { return state.user; },
    get apiBase() { return API; },
  };
})(window);
