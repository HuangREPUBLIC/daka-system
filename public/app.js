"use strict";
/**
 * 前端：单页应用，数据全部来自服务端（多人多设备看到同一份）。
 * 交互取向：移动优先，底部 Tab 栏 + 顶部标题栏；宽屏时 Tab 栏自动移到顶部。
 * 权限在服务端强制校验，这里只负责隐藏没权限的入口。
 */

/* ================= 状态 ================= */
let state = {
  token: localStorage.getItem("daka_token") || null,
  me: null, users: [], fields: { order: [], production: [] },
  factories: { emb: [], prod: [], proc: [] }, orders: [], roles: [],
  chat: { contacts: [], activeId: null, contact: null, messages: [], draft: "", att: null },
  unread: { total: 0, byUser: {} },
  myLogs: null
};
let route = { v: "orders", id: null };
let editingBasic = false, imgDraft = {}, importPreview = null, importRaw = "";
let filt = { season: "", sales: "", follower: "", kw: "" };
let modalState = null;
let deferredInstall = null;   // 安卓/桌面 Chrome 的原生安装事件
// 是否已经是「装到主屏后打开」的状态
const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
  || window.navigator.standalone === true;

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// 时间：今年省略年份 ——「7月20日 17:51」；跨年「2025年7月20日 17:51」
function fmtT(t) {
  const d = new Date(t), p = n => String(n).padStart(2, "0");
  const y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 今天，按本地时区取（toISOString 是 UTC，中国上午 8 点前会算成前一天）
function todayStr() {
  const d = new Date(), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 日期字符串 2026-08-15 -> 2026年8月15日
function fmtDate(v) {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return v;
  return `${m[1]}年${+m[2]}月${+m[3]}日`;
}
function fmtSize(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function toast(s) {
  const m = $("msg"); m.textContent = s; m.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => m.classList.remove("show"), 2400);
}
const userById = id => state.users.find(u => u.id === id);
const uname = id => (userById(id) || {}).name || "";
const me = () => state.me;
const isAdmin = () => me() && me().template === "admin";
const canCreateOrder = () => me() && (me().template === "admin" || me().template === "sales");
const roleLabelOf = u => (u ? (u.roleLabel || (u.role === "admin" ? "管理员" : u.role)) : "");
const labelForRoleKey = k => k === "admin" ? "管理员" : ((state.roles.find(r => r.k === k) || {}).label || k);
const APP_LOGO = `
  <svg viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="lg-bg" x1="60" y1="30" x2="440" y2="490" gradientUnits="userSpaceOnUse">
        <stop stop-color="#4C97DC"/><stop offset=".55" stop-color="#1E63AE"/><stop offset="1" stop-color="#10386C"/>
      </linearGradient>
      <linearGradient id="lg-gloss" x1="90" y1="60" x2="300" y2="300" gradientUnits="userSpaceOnUse">
        <stop stop-color="#FFFFFF" stop-opacity=".26"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="512" height="512" rx="116" fill="url(#lg-bg)"/>
    <path d="M116 0h280a116 116 0 0 1 116 116v70C420 96 300 40 176 40 152 40 128 42 106 46A116 116 0 0 1 116 0Z" fill="url(#lg-gloss)"/>
    <path d="M108 274 L206 372 L344 150" stroke="#FFFFFF" stroke-width="42" stroke-linecap="round"
          stroke-linejoin="round" stroke-dasharray="66 46" opacity=".97"/>
    <path d="M336 164 L424 76" stroke="#FFFFFF" stroke-width="24" stroke-linecap="round"/>
    <ellipse cx="434" cy="66" rx="27" ry="17" transform="rotate(-45 434 66)" fill="none" stroke="#FFFFFF" stroke-width="15"/>
  </svg>`;

/* ================= API ================= */
async function api(method, path, body) {
  const headers = {};
  if (state.token) headers.Authorization = "Bearer " + state.token;
  const opts = { method, headers };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch("/api" + path, opts);
  if (r.status === 401 && state.token) { A.forceLogout(); throw { error: "登录已失效，请重新登录" }; }
  let j = null; try { j = await r.json(); } catch (e) { }
  if (!r.ok) throw (j || { error: "请求失败" });
  return j;
}
async function refresh() {
  const b = await api("GET", "/bootstrap");
  state.me = b.me; state.users = b.users; state.fields = b.fields;
  state.factories = b.factories; state.orders = b.orders; state.roles = b.roles || [];
}
async function run(fn, okMsg) {
  try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); }
  catch (e) { toast((e && e.error) || "操作失败"); }
}

/* ================= 权限（仅用于显示控制） ================= */
function canEditBasic(o) {
  const m = me(); if (!m) return false;
  if (m.template === "admin") return true;
  return m.template === "sales" && (o.createdBy === m.id || o.values.sales === m.id);
}
function canAddLog(o, section) {
  const m = me(); if (!m) return false;
  if (m.template === "admin") return true;
  if (o.values.follower === m.id) return true;
  if (section === "order" && canEditBasic(o)) return true;
  return false;
}
const canTouchEntry = e => { const m = me(); return m && (m.template === "admin" || e.by === m.id); };

/* ================= 字段与下拉 ================= */
function optionsFor(f) {
  if (f.type === "user-sales") return state.users.filter(u => u.template === "sales").map(u => [u.id, u.name]);
  if (f.type === "user-follower") return state.users.filter(u => u.template === "follower").map(u => [u.id, u.name]);
  if (f.type === "factory-emb") return state.factories.emb.map(x => [x, x]);
  if (f.type === "factory-prod") return state.factories.prod.map(x => [x, x]);
  if (f.type === "select") return (f.options || []).map(x => [x, x]);
  return null;
}
function displayVal(o, f) {
  const v = (o.values || {})[f.k];
  if (v == null || v === "") return "";
  if (f.type === "user-sales" || f.type === "user-follower") return uname(v) || v;
  if (f.type === "date") return fmtDate(v);
  return v;
}
function fieldInput(f, val, prefix) {
  prefix = prefix || "nf-";
  const id = prefix + f.k, opts = optionsFor(f);
  if (opts) return `<select class="in" id="${id}"><option value="">请选择</option>${opts.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  if (f.type === "textarea") return `<textarea class="in" id="${id}">${esc(val || "")}</textarea>`;
  if (f.type === "date") return dateFieldHtml(id, val);
  if (f.type === "number") return `<input class="in" type="number" id="${id}" value="${esc(val || "")}">`;
  if (f.type === "image") return fileFieldHtml(id, "image/*", `A.pickImg(this,'${f.k}')`, "选择图片") +
    (val ? `<img src="${esc(val)}" alt="款式图" style="max-width:120px;margin-top:8px;border-radius:10px">` : "");
  return `<input class="in" id="${id}" value="${esc(val || "")}">`;
}
const fieldRow = (f, val, prefix) => `<label class="field"><span>${esc(f.label)}</span>${fieldInput(f, val, prefix)}</label>`;

// 日期：真正的 input[type=date] 藏在下面（手机上仍调起系统日期轮），
// 上面盖一个显示「2026年8月15日」的中文按钮
function dateFieldHtml(id, val) {
  return `<div class="datefield">
    <input type="date" id="${id}" class="date-native" value="${esc(val || "")}" onchange="A.syncDateLabel('${id}')">
    <button type="button" class="in date-btn ${val ? "" : "empty"}" id="${id}--label"
      onclick="A.openDate('${id}')">${val ? esc(fmtDate(val)) : "选择日期"}</button></div>`;
}
// 文件选择：隐藏原生控件（它显示英文 Choose File），用中文按钮代替
function fileFieldHtml(id, accept, onchange, pickText) {
  return `<div class="filefield">
    <input type="file" id="${id}" class="file-native" accept="${accept}" onchange="${onchange}">
    <button type="button" class="in file-btn" onclick="document.getElementById('${id}').click()">
      <span class="file-name" id="${id}--name">未选择文件</span>
      <span class="file-pick">${esc(pickText || "选择文件")}</span></button></div>`;
}

function chinaYear() {
  try { return +new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric" }).format(new Date()); }
  catch (e) { return new Date().getFullYear(); }
}
function seasonOptions(cur) {
  const y = chinaYear(), list = [];
  for (let yy = y - 1; yy <= y + 2; yy++) list.push("SS" + yy, "FW" + yy);
  state.orders.forEach(o => { if (o.season && !list.includes(o.season)) list.unshift(o.season); });
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list;
}
function seasonSelectHtml(cur, prefix) {
  return `<select class="in" id="${(prefix || "nf-")}season"><option value="">请选择季节</option>${
    seasonOptions(cur).map(s => `<option ${s === cur ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>`;
}

/* ================= 弹窗 ================= */
function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) { mask.classList.remove("show"); mask.innerHTML = ""; return; }
  const o = modalState;
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div style="margin-top:14px">${o.html}</div>` : ""}
    ${o.input === "textarea" ? `<textarea class="in" id="m-input" style="margin-top:14px;min-height:110px"></textarea>`
      : o.input ? `<input class="in" id="m-input" style="margin-top:14px" ${o.password ? 'type="password"' : ""}>` : ""}
    <div class="m-actions">
      <button class="btn ghost" onclick="A.modalCancel()">取消</button>
      <button class="btn ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>
    </div></div>`;
  if (o.input) { const i = $("m-input"); i.value = o.value || ""; i.focus(); }
  mask.classList.add("show");
}

/* ================= 路由 ================= */
function go(v, id) {
  route = { v, id: id || null }; editingBasic = false;
  if (v !== "chat") { state.chat.activeId = null; state.chat.messages = []; state.chat.draft = ""; state.chat.att = null; }
  render(); window.scrollTo(0, 0);
  if (v === "account") A.loadMyLogs(state.me.id);
  if (v === "staffLogs" && id) A.loadMyLogs(id);
  if (v === "chat") { A.loadContacts(); A.refreshUnread(); }
}

/* 每个页面的标题栏配置 */
function pageMeta() {
  const back = (label, fn) => `<button class="nav-btn" onclick="${fn}">‹ ${esc(label)}</button>`;
  switch (route.v) {
    case "orders": return { title: "订单",
      right: canCreateOrder() ? `<button class="nav-btn plus" title="新建订单" onclick="go('new')">＋</button>` : "" };
    case "new": return { title: "新建订单", left: back("订单", "go('orders')") };
    case "detail": return { title: "订单详情", left: back("订单", "go('orders')") };
    case "chat": return state.chat.activeId
      ? { title: (state.chat.contact && state.chat.contact.name) || "聊天", left: back("聊天", "A.closeChat()") }
      : { title: "聊天" };
    case "admin": return { title: "管理后台" };
    case "account": return { title: "我的" };
    case "staffLogs": {
      const u = userById(route.id);
      return { title: (u ? u.name : "") + "的打卡", left: back("管理", "go('admin')") };
    }
    default: return { title: "订单" };
  }
}
const ICONS = {
  orders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2z"/><path d="M9 3h6v3H9z"/><path d="M9.5 11h5M9.5 15h5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a7.5 7.5 0 0 1-7.5 7.5c-1.2 0-2.3-.25-3.3-.7L4.5 20l1.3-4.2A7.4 7.4 0 0 1 5 12a7.5 7.5 0 0 1 15 0z"/></svg>`,
  admin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H4a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V10a1.6 1.6 0 0 0 1.5 1H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>`,
  account: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>`
};
function tabbarHtml() {
  const m = me();
  const tabs = [["orders", "订单", ICONS.orders], ["chat", "聊天", ICONS.chat]];
  if (m.template === "admin") tabs.push(["admin", "管理", ICONS.admin]);
  tabs.push(["account", "我的", ICONS.account]);
  const activeTab = route.v === "new" || route.v === "detail" ? "orders"
    : route.v === "staffLogs" ? "admin" : route.v;
  return `<nav class="tabbar">${tabs.map(([v, label, icon]) => `
    <button class="tab ${activeTab === v ? "on" : ""}" data-tab="${v}" onclick="go('${v}')">
      <span class="ti">${icon}${v === "chat" && state.unread.total
        ? `<span class="badge">${state.unread.total > 99 ? "99+" : state.unread.total}</span>` : ""}</span>
      <span>${label}</span></button>`).join("")}</nav>`;
}

function render() {
  const app = $("app");
  if (!me()) { app.innerHTML = vLogin(); return; }
  const meta = pageMeta();
  const views = { orders: vOrders, new: vNew, detail: vDetail, chat: vChat,
    admin: vAdmin, account: vAccount, staffLogs: vStaffLogs };
  app.innerHTML = `
    <header class="navbar"><div class="navbar-in">
      <div class="nav-slot">${meta.left || ""}</div>
      <h1 class="nav-title">${esc(meta.title)}</h1>
      <div class="nav-slot right">${meta.right || ""}</div>
    </div></header>
    ${tabbarHtml()}
    <main class="page${route.v === "chat" && state.chat.activeId ? " chat-full" : ""}" data-view="${route.v}">${
      (views[route.v] || vOrders)()}</main>`;
}

/* ---------- 登录 ---------- */
function vLogin() {
  return `<div class="login-page"><div class="login-inner">
    <div class="login-brand">
      <div class="login-logo">${APP_LOGO}</div>
      <h1 class="login-title">跟单打卡系统</h1>
    </div>
    <div class="login-card">
      <label class="lg-field"><span>手机号</span>
        <input id="lg-phone" inputmode="tel" autocomplete="username" placeholder="请输入手机号"></label>
      <label class="lg-field"><span>密码</span>
        <input id="lg-pass" type="password" autocomplete="current-password" placeholder="请输入密码"
          onkeydown="if(event.key==='Enter')A.login()"></label>
    </div>
    <button class="btn block login-btn" onclick="A.login()">登 录</button>
    <div class="login-foot"><button class="btn plain" onclick="A.openForgotPw()">忘记密码 / 修改密码</button></div>
    ${isStandalone() ? "" : `<button class="btn ghost block install-cta" onclick="A.install()">📲 安装到手机（像 App 一样用）</button>`}
  </div></div>`;
}

/* ---------- 订单列表 ---------- */
function latestLog(o) {
  let best = null;
  const all = [...state.fields.order, ...state.fields.production].filter(f => f.type === "log");
  for (const f of all) for (const e of (o.logs[f.k] || [])) if (!best || e.t > best.t) best = { ...e, fieldLabel: f.label };
  for (const s of (o.subs || [])) for (const e of s.log) if (!best || e.t > best.t) best = { ...e, fieldLabel: s.name };
  return best;
}
function vOrders() {
  const list = state.orders.filter(o =>
    (!filt.season || o.season === filt.season) &&
    (!filt.sales || o.values.sales === filt.sales) &&
    (!filt.follower || o.values.follower === filt.follower) &&
    (!filt.kw || [o.values.styleNo, o.values.styleName, o.values.style].join(" ").toLowerCase().includes(filt.kw.toLowerCase()))
  ).slice().sort((a, b) => b.createdAt - a.createdAt);
  const opt = (arr, cur) => arr.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  return `<section class="group">
    <div class="card"><div class="filters">
      <select class="in" onchange="A.setF('season',this.value)"><option value="">全部季节</option>${opt(seasonOptions("").map(s => [s, s]), filt.season)}</select>
      <select class="in" onchange="A.setF('sales',this.value)"><option value="">全部业务员</option>${opt(state.users.filter(u => u.template === "sales").map(u => [u.id, u.name]), filt.sales)}</select>
      <select class="in" onchange="A.setF('follower',this.value)"><option value="">全部下厂员</option>${opt(state.users.filter(u => u.template === "follower").map(u => [u.id, u.name]), filt.follower)}</select>
      <input class="in" placeholder="搜货号 / 款式名" value="${esc(filt.kw)}" oninput="A.setFKw(this.value)">
    </div></div></section>
  <section class="group">
    <div class="group-title">订单列表 · 共 ${list.length} 单</div>
    <div class="card">${list.map(o => {
      const latest = latestLog(o);
      return `<div class="ocard" onclick="go('detail','${o.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')go('detail','${o.id}')">
        <div class="thumb">${o.values.img ? `<img src="${esc(o.values.img)}" alt="款式图">` : "款式图"}</div>
        <div class="o-main">
          <div class="o-title"><span class="tag">${esc(o.season)}</span>${esc(o.values.styleNo || "")} ${esc(o.values.styleName || "")}</div>
          <div class="o-meta"><span>业务员 ${esc(uname(o.values.sales)) || "—"}</span><span>下厂员 ${esc(uname(o.values.follower)) || "未指定"}</span>
            <span class="num">数量 ${esc(o.values.qty || "-")}</span><span>交期 ${esc(fmtDate(o.values.deadline)) || "-"}</span></div>
          ${latest ? `<div class="o-latest">最新：${esc(latest.fieldLabel)} · ${esc(latest.text)} <span class="num">(${fmtT(latest.t)})</span></div>` : ""}
        </div><span class="chev">›</span></div>`;
    }).join("") || `<div class="empty">${state.orders.length ? "没有符合条件的订单" : "还没有订单，点右上角 ＋ 新建"}</div>`}</div>
  </section>`;
}

/* ---------- 新建订单 / 批量导入 ---------- */
function vNew() {
  const scalars = s => state.fields[s].filter(f => f.type !== "log");
  // 新建时日期默认当天，业务员默认自己
  const defVal = f => f.type === "date" ? todayStr()
    : (f.k === "sales" && me().template === "sales" ? me().id : "");
  return `<section class="group">
    <div class="group-title">订单明细</div>
    <div class="card">
      <label class="field"><span>订单季节</span>${seasonSelectHtml("")}</label>
      <div class="grid2">${scalars("order").map(f => fieldRow(f, defVal(f))).join("")}</div>
    </div></section>
  <section class="group">
    <div class="group-title">生产安排（指定负责打卡的下厂员）</div>
    <div class="card"><div class="grid2">${scalars("production").map(f => fieldRow(f, defVal(f))).join("")}</div></div>
    <div class="btn-row" style="padding-left:0;padding-right:0">
      <button class="btn block" onclick="A.createOrder()">保存订单</button></div>
  </section>
  <section class="group">
    <div class="group-title">表格批量导入</div>
    <div class="card"><div class="card-pad">
      <p style="font-size:13.5px;color:var(--ink-2);margin:0 0 12px">支持 <b>Excel(.xlsx/.xls)</b> 和 <b>CSV(.csv/.txt)</b>，也可以把表格内容直接复制粘贴到下面。第一行为表头，按“货号、款式名、款式、数量、款式描述、订单交期、面料、业务员、下厂员、季节”等列名识别。识别后会<b>填入下方表单</b>，可逐项修改，确认后再导入。</p>
      <div style="margin-bottom:10px">${fileFieldHtml("imp-file", ".xlsx,.xls,.csv,.txt", "A.importFile(this)", "选择表格文件")}</div>
      <textarea class="in" id="imp-text" placeholder="或将 Excel 中选中的区域直接粘贴到这里（含表头）">${esc(importRaw)}</textarea>
      <div style="margin-top:10px"><button class="btn ghost" onclick="A.importText()">识别数据</button></div>
    </div>${importPreview ? importPreviewHtml() : ""}</div>
  </section>`;
}
function importScalars() {
  return [...state.fields.order.filter(f => f.type !== "log" && f.type !== "image"),
          ...state.fields.production.filter(f => f.type !== "log")];
}
function importPreviewHtml() {
  const orderScalars = state.fields.order.filter(f => f.type !== "log" && f.type !== "image");
  const prodScalars = state.fields.production.filter(f => f.type !== "log");
  return `<div style="padding:0 16px 4px;font-size:13.5px;color:var(--ink-2)">
      <b>识别结果</b>：共 ${importPreview.length} 单，<b>尚未保存</b>。可直接修改任意字段，确认后再导入。系统里查不到的姓名会显示“请选择”，请手动选。</div>
    ${importPreview.map((r, i) => `<div class="imp-block">
      <div class="imp-head">第 ${i + 1} 单${importPreview.length > 1 ?
        `<button class="btn plain right" style="color:var(--bad)" onclick="A.removeImportRow(${i})">移除</button>` : ""}</div>
      <label class="field"><span>订单季节</span>${seasonSelectHtml(r.season, "imp" + i + "-")}</label>
      <div class="grid2">${orderScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
      <div class="grid2">${prodScalars.map(f => fieldRow(f, r.values[f.k] || "", "imp" + i + "-")).join("")}</div>
    </div>`).join("")}
    <div class="btn-row">
      <button class="btn" onclick="A.confirmImport()">确认导入 ${importPreview.length} 单</button>
      <button class="btn ghost" onclick="A.cancelImport()">取消</button></div>`;
}

/* ---------- 订单详情 ---------- */
function logFieldHtml(o, f, list, addKey, canAdd) {
  const entries = list.slice().sort((a, b) => b.t - a.t);
  return `<div class="logfield">
    <div class="lf-head"><span>${esc(f.label)}</span><span class="cnt">${entries.length} 条</span>
      ${canAdd ? `<button class="btn mini right" onclick="A.toggleAdd('${addKey}')">＋ 打卡</button>` : ""}</div>
    ${canAdd ? `<div class="addbox" id="add-${addKey}">
      <textarea class="in" id="txt-${addKey}" placeholder="填写当前进度情况，可详细描述…"></textarea>
      <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${o.id}','${addKey}')">提交打卡</button></div></div>` : ""}
    ${entries.length ? `<ul class="log">${entries.map(e => `<li>
      <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>
        ${canTouchEntry(e) ? `<a href="javascript:void(0)" onclick="A.editLog('${o.id}','${addKey}','${e.id}')">改</a>
        <a href="javascript:void(0)" onclick="A.delLog('${o.id}','${addKey}','${e.id}')">删</a>` : ""}</div>
      <div class="txt">${esc(e.text)}</div></li>`).join("")}</ul>` : `<div class="empty" style="padding:10px 0">暂无打卡记录</div>`}</div>`;
}
function vDetail() {
  const o = state.orders.find(x => x.id === route.id);
  if (!o) return `<div class="card"><div class="empty">订单不存在</div></div>`;
  const scalars = s => state.fields[s].filter(f => f.type !== "log");
  const logsOf = s => state.fields[s].filter(f => f.type === "log");
  const kv = fs => fs.map(f => `<div class="row-item"><div class="row-main"><div class="row-label">${esc(f.label)}</div></div>
    <div class="row-value">${f.type === "image" ? (o.values.img ? `<img src="${esc(o.values.img)}" alt="款式图" style="max-width:130px;border-radius:10px">` : "—")
      : (esc(displayVal(o, f)) || "—")}</div></div>`).join("");
  const canB = canEditBasic(o), canOrdLog = canAddLog(o, "order"), canProdLog = canAddLog(o, "production");
  const editForm = s => `<div class="grid2">${scalars(s).map(f => fieldRow(f, o.values[f.k] || "")).join("")}</div>`;

  return `<section class="group">
    <div class="card"><div class="card-pad" style="text-align:center">
      <div style="font-size:20px;font-weight:700;letter-spacing:-.02em">${esc(o.values.styleNo || "")}</div>
      <div style="color:var(--ink-2);margin-top:2px">${esc(o.values.styleName || "")}</div>
      <div style="margin-top:8px"><span class="tag">${esc(o.season)}</span></div>
    </div></div></section>

  <section class="group">
    <div class="group-title">一、订单明细${canB ? `<button class="btn plain right" onclick="A.toggleBasic()">${editingBasic ? "取消" : "编辑"}</button>` : ""}</div>
    <div class="card">${editingBasic && canB
      ? `<label class="field"><span>订单季节</span>${seasonSelectHtml(o.season)}</label>${editForm("order")}
         <div class="group-title" style="padding-top:12px">生产安排字段</div>${editForm("production")}
         <div class="btn-row"><button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button></div>`
      : kv(scalars("order"))}</div>
    <div class="card" style="margin-top:14px">${logsOf("order").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canOrdLog)).join("")}</div>
  </section>

  <section class="group">
    <div class="group-title">二、生产明细${o.values.follower ? ` · 负责人 ${esc(uname(o.values.follower))}` : " · 未指定下厂员"}</div>
    <div class="card">${kv(scalars("production"))}</div>
    <div class="card" style="margin-top:14px">
      ${logsOf("production").filter(f => ["preSample", "cutting"].includes(f.k)).map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog)).join("")}
      <div class="logfield"><div class="lf-head"><span>加工厂明细</span></div>
        ${(o.subs || []).map((s, i) => `<div style="margin-top:10px;border-top:.5px solid var(--line);padding-top:10px">
          <div class="lf-head" style="font-size:14.5px"><span>${esc(s.name)}</span>
            ${canProdLog ? `<select class="in" style="width:auto;min-height:34px;padding:4px 30px 4px 10px;font-size:14px" onchange="A.setSubFactory('${o.id}',${i},this.value)">
              <option value="">选择工厂</option>${state.factories.proc.map(x => `<option ${x === s.factory ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`
              : `<span class="tag role">${esc(s.factory) || "未指定"}</span>`}
            ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('sub${i}')">＋ 打卡</button>` : ""}</div>
          ${canProdLog ? `<div class="addbox" id="add-sub${i}"><textarea class="in" id="txt-sub${i}" placeholder="该加工厂的进度情况…"></textarea>
            <div style="margin-top:8px"><button class="btn mini" onclick="A.addLog('${o.id}','sub${i}')">提交打卡</button></div></div>` : ""}
          ${s.log.length ? `<ul class="log">${s.log.slice().sort((a, b) => b.t - a.t).map(e => `<li>
            <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>${canTouchEntry(e) ?
              `<a href="javascript:void(0)" onclick="A.editLog('${o.id}','sub${i}','${e.id}')">改</a>
               <a href="javascript:void(0)" onclick="A.delLog('${o.id}','sub${i}','${e.id}')">删</a>` : ""}</div>
            <div class="txt">${esc(e.text)}</div></li>`).join("")}</ul>` : `<div class="empty" style="padding:8px 0">暂无打卡记录</div>`}</div>`).join("")}
      </div>
      ${logsOf("production").filter(f => !["preSample", "cutting"].includes(f.k)).map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog)).join("")}
    </div>
  </section>

  <section class="group">
    <div class="group-title">三、验货问题<button class="btn plain right" onclick="A.toggleAdd('insp')">＋ 新增</button></div>
    <div class="card">
      <div class="addbox" id="add-insp">
        <label class="field"><span>验货日期</span>${dateFieldHtml("insp-date", todayStr())}</label>
        <div id="insp-items"><div class="grid2 insp-row">
          <label class="field"><span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea></label>
          <label class="field"><span>整改情况</span><textarea class="in insp-f" style="min-height:62px"></textarea></label></div></div>
        <div class="btn-row"><button class="btn mini ghost" onclick="A.inspAddRow()">＋ 再加一条</button>
          <button class="btn mini" onclick="A.saveInsp('${o.id}')">保存验货记录</button></div></div>
      ${o.inspections.length ? o.inspections.slice().sort((a, b) => (b.date < a.date ? -1 : 1)).map(g => `<div class="insp-day">
        <div class="lf-head"><span class="d">${esc(fmtDate(g.date))}</span>
          <span style="font-size:12.5px;color:var(--ink-2);font-weight:400">${esc(g.byName)} · <span class="num">${fmtT(g.t)}</span></span>
          ${(isAdmin() || g.by === me().id) ? `<button class="btn plain right" style="color:var(--bad)" onclick="A.delInsp('${o.id}','${g.id}')">删除</button>` : ""}</div>
        ${g.items.map(it => `<div class="insp-item"><div><span class="lbl p">发现问题</span>${esc(it.problem)}</div>
          <div style="margin-top:4px"><span class="lbl f2">整改情况</span>${esc(it.fix) || "—"}</div></div>`).join("")}</div>`).join("")
        : `<div class="empty">暂无验货记录</div>`}</div>
  </section>

  <section class="group">
    <div class="group-title">四、跟单问题<button class="btn plain right" onclick="A.toggleAdd('follow')">＋ 添加</button></div>
    <div class="card">
      <div class="addbox" id="add-follow" style="padding:12px 16px">
        <textarea class="in" id="txt-follow" placeholder="填写跟单过程中的问题、沟通事项…"></textarea>
        <div style="margin-top:8px"><button class="btn mini" onclick="A.addFollow('${o.id}')">提交</button></div></div>
      ${o.followIssues.length ? `<ul class="log" style="padding:4px 16px 12px">${o.followIssues.slice().sort((a, b) => b.t - a.t).map(e => `<li>
        <div class="meta"><b>${esc(e.byName)}</b><span class="num">${fmtT(e.t)}</span>${canTouchEntry(e) ?
          `<a href="javascript:void(0)" onclick="A.delFollow('${o.id}','${e.id}')">删</a>` : ""}</div>
        <div class="txt">${esc(e.text)}</div></li>`).join("")}</ul>` : `<div class="empty">暂无记录</div>`}</div>
  </section>
  ${isAdmin() ? `<section class="group"><div class="btn-row" style="padding-left:0;padding-right:0">
    <button class="btn danger ghost block" onclick="A.delOrder('${o.id}')">删除此订单</button></div></section>` : ""}`;
}

/* ---------- 打卡记录（简洁列表） ---------- */
function logListHtml(rows) {
  if (!rows) return `<div class="empty">加载中…</div>`;
  if (!rows.length) return `<div class="empty">还没有打卡记录</div>`;
  return `<div class="loglist">${rows.map(r => `<div class="logrow">
    <div class="lr-top">
      <a href="javascript:void(0)" onclick="go('detail','${r.orderId}')">${esc(r.styleNo || r.styleName || "订单")}</a>
      <span>${esc(r.label)}</span><span class="num right">${fmtT(r.t)}</span></div>
    <div class="lr-text">${esc(r.text)}</div></div>`).join("")}</div>`;
}

/* ---------- 聊天 ---------- */
const avatarHtml = (name, cls) => `<span class="avatar ${cls || ""}">${esc((name || "?").slice(0, 1))}</span>`;
function contactsHtml() {
  const list = state.chat.contacts;
  if (!list.length) return `<div class="empty">还没有其他同事，先到「管理后台」创建员工账号</div>`;
  return list.map(c => `<div class="contact" onclick="A.openChat('${c.id}')">
    ${avatarHtml(c.name)}
    <div class="c-main">
      <div class="c-top"><b>${esc(c.name)}</b>
        ${c.last ? `<span class="c-time num">${fmtT(c.last.t)}</span>` : ""}</div>
      <div class="c-last">${c.last ? (c.last.fromMe ? "我：" : "") + esc(c.last.text) : "打个招呼吧"}</div>
    </div>
    ${c.unread ? `<span class="badge">${c.unread > 99 ? "99+" : c.unread}</span>` : `<span class="chev">›</span>`}
  </div>`).join("");
}
function attachmentHtml(a, mine) {
  if (!a) return "";
  if (a.isImage) return `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="b-img" src="${esc(a.url)}" alt="${esc(a.name)}"></a>`;
  return `<a class="b-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.name)}"
    style="${mine ? "color:#fff" : ""}"><span class="fi">📄</span>
    <span><span class="fn">${esc(a.name)}</span><br><span class="fs num">${fmtSize(a.size)}</span></span></a>`;
}
// 时间只在间隔超过 5 分钟时单独显示一行，不再每条气泡都挂时间
function chatTimeLabel(t) {
  const d = new Date(t), n = new Date(), p = x => String(x).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return hm;
  const y = d.getFullYear() === n.getFullYear() ? "" : d.getFullYear() + "年";
  return `${y}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}
function messagesHtml() {
  const ms = state.chat.messages;
  if (!ms.length) return `<div class="empty" style="padding:30px 0">还没有聊天记录，发第一条消息吧</div>`;
  let lastT = 0;
  return ms.map(m => {
    let sep = "";
    if (m.t - lastT > 5 * 60 * 1000) sep = `<div class="day-sep">${chatTimeLabel(m.t)}</div>`;
    lastT = m.t;
    return sep + `<div class="bubble-row ${m.fromMe ? "mine" : ""}">
      ${m.fromMe ? "" : avatarHtml(state.chat.contact && state.chat.contact.name, "sm")}
      <div class="bubble" title="${esc(fmtT(m.t))}">${attachmentHtml(m.attachment, m.fromMe)}${m.text ? esc(m.text) : ""}</div></div>`;
  }).join("");
}
function vChat() {
  if (!state.chat.activeId) {
    return `<section class="group" style="margin-top:4px">
      <div class="card" id="chat-contacts">${contactsHtml()}</div></section>`;
  }
  const a = state.chat.att;
  return `<div class="chat-card">
    <div class="chat-msgs" id="chat-msgs">${messagesHtml()}</div>
    ${a ? `<div class="att-bar">${a.isImage ? "🖼" : "📄"} ${esc(a.name)} <span class="num" style="color:var(--ink-2)">${fmtSize(a.size)}</span>
      <span class="x" onclick="A.clearAtt()">✕</span></div>` : ""}
    <div class="chat-input">
      <input type="file" id="chat-file" style="display:none"
        accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.pdf,.xlsx,.xls,.csv,.doc,.docx,.ppt,.pptx,.txt,.zip"
        onchange="A.pickAtt(this)">
      <button class="icon-btn" title="发送图片或文件" onclick="document.getElementById('chat-file').click()">＋</button>
      <textarea class="in" id="chat-text" rows="1" placeholder="输入消息…"
        oninput="A.onDraft(this.value)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();A.sendMsg();}">${esc(state.chat.draft)}</textarea>
      <button class="btn chat-send" onclick="A.sendMsg()">发送</button>
    </div></div>`;
}

/* ---------- 管理员查看某员工打卡 ---------- */
function vStaffLogs() {
  const u = userById(route.id);
  return `<section class="group">
    <div class="group-title">${esc(u ? u.name : "")} 的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="card">${logListHtml(state.myLogs)}</div></section>`;
}

/* ---------- 管理后台 ---------- */
function vAdmin() {
  if (!isAdmin()) return `<div class="card"><div class="empty">仅管理员可访问</div></div>`;
  const roleCell = u => u.role === "admin"
    ? `<span class="tag role">管理员</span>`
    : `<select class="in" style="width:auto;min-height:34px;padding:4px 30px 4px 10px;font-size:14px" onchange="A.changeRole('${u.id}',this.value)">
        ${state.roles.map(r => `<option value="${esc(r.k)}" ${u.role === r.k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>`;
  return `<section class="group">
    <div class="group-title">员工账号</div>
    <div class="card"><div class="tbl-wrap"><table class="tbl">
      <tr><th>姓名</th><th>手机号</th><th>职位</th><th>操作</th></tr>
      ${state.users.map(u => `<tr>
        <td>${esc(u.name)}${u.id === me().id ? ` <span class="tag">我</span>` : ""}</td>
        <td class="num">${esc(u.phone)}</td><td>${roleCell(u)}</td>
        <td style="white-space:nowrap"><button class="btn mini ghost" onclick="A.viewStaffLogs('${u.id}')">查看打卡</button>${
          u.role === "admin" ? "" : ` <button class="btn mini ghost" onclick="A.resetUserPw('${u.id}')">重置密码</button>
          <button class="btn mini danger ghost" onclick="A.deleteUser('${u.id}')">删除</button>`}</td></tr>`).join("")}
    </table></div></div>
  </section>

  <section class="group">
    <div class="group-title">新增员工</div>
    <div class="card">
      <label class="field"><span>姓名</span><input class="in" id="nu-name"></label>
      <label class="field"><span>手机号</span><input class="in" id="nu-phone" inputmode="tel"></label>
      <label class="field"><span>职位</span><select class="in" id="nu-role">${
        state.roles.map(r => `<option value="${esc(r.k)}">${esc(r.label)}</option>`).join("")}</select></label>
      <label class="field"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label>
      <div class="btn-row"><button class="btn" onclick="A.addUser()">创建账号</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">职位管理</div>
    <div class="card"><div class="card-pad">
      <div style="display:flex;gap:8px;flex-wrap:wrap">${state.roles.map(r => `<span class="tag role">${esc(r.label)}
        · ${r.template === "sales" ? "业务员权限" : "下厂员权限"}${r.core ? "" :
          ` <a href="javascript:void(0)" onclick="A.delRole('${r.k}')" style="margin-left:4px">✕</a>`}</span>`).join("")}</div></div>
      <label class="field"><span>新职位名称</span><input class="in" id="nr-label" placeholder="例：跟单主管"></label>
      <label class="field"><span>权限模板</span><select class="in" id="nr-template">
        <option value="sales">业务员权限（可建单、改自己录入的订单）</option>
        <option value="follower">下厂员权限（只能给自己负责的订单打卡）</option></select></label>
      <div class="btn-row"><button class="btn" onclick="A.addRole()">添加职位</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">自定义字段</div>
    <div class="card">
      ${["order", "production"].map(s => `<div class="card-pad" style="padding-bottom:6px">
        <div class="row-sub" style="margin-bottom:6px">${s === "order" ? "一、订单明细" : "二、生产明细"}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${state.fields[s].map(f => `<span class="tag role">${esc(f.label)}${
          f.core ? "" : ` <a href="javascript:void(0)" onclick="A.delField('${s}','${f.k}')" style="margin-left:4px">✕</a>`}</span>`).join("")}</div></div>`).join("")}
      <label class="field"><span>添加到板块</span><select class="in" id="cf-sec"><option value="order">一、订单明细</option><option value="production">二、生产明细</option></select></label>
      <label class="field"><span>字段名称</span><input class="in" id="cf-label" placeholder="例：吊牌进度"></label>
      <label class="field"><span>字段类型</span><select class="in" id="cf-type" onchange="document.getElementById('cf-opts-wrap').style.display=this.value==='select'?'':'none'">
        <option value="text">文本</option><option value="log">进度打卡（保留历史）</option><option value="date">日期</option>
        <option value="number">数字</option><option value="select">下拉菜单</option></select></label>
      <label class="field" id="cf-opts-wrap" style="display:none"><span>下拉选项（逗号分隔）</span><input class="in" id="cf-opts" placeholder="例：选项A,选项B"></label>
      <div class="btn-row"><button class="btn" onclick="A.addField()">添加字段</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">工厂下拉选项</div>
    <div class="card">${[["emb", "绣印工厂"], ["prod", "生产厂"], ["proc", "加工厂"]].map(([k, t]) => `
      <div class="card-pad" style="padding-bottom:10px">
        <div class="row-sub" style="margin-bottom:6px">${t}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${state.factories[k].map(x =>
          `<span class="tag role">${esc(x)} <a href="javascript:void(0)" onclick="A.delFactory('${k}','${encodeURIComponent(x)}')" style="margin-left:4px">✕</a></span>`).join("")}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <input class="in" id="fac-${k}" placeholder="新工厂名"><button class="btn mini ghost" onclick="A.addFactory('${k}')">添加</button></div></div>`).join("")}</div>
  </section>

  <section class="group">
    <div class="group-title">数据导出</div>
    <div class="card"><div class="card-pad">
      <p style="font-size:13.5px;color:var(--ink-2);margin:0 0 12px">导出全部订单为 Excel(.xlsx) 文件</p>
      <button class="btn" onclick="A.exportData()">导出订单数据</button></div></div>
  </section>`;
}

/* ---------- 我的 ---------- */
function vAccount() {
  const m = me();
  return `<section class="group">
    <div class="card">
      <div class="card-pad" style="display:flex;align-items:center;gap:14px">
        ${avatarHtml(m.name)}
        <div><div style="font-size:19px;font-weight:600">${esc(m.name)}</div>
          <div class="row-sub">${esc(roleLabelOf(m))} · <span class="num">${esc(m.phone)}</span></div></div></div>
    </div></section>

  <section class="group">
    <div class="group-title">修改密码</div>
    <div class="card">
      <label class="field"><span>新密码</span><input class="in" type="password" id="my-p1"></label>
      <label class="field"><span>确认新密码</span><input class="in" type="password" id="my-p2"></label>
      <div class="btn-row"><button class="btn" onclick="A.changeMyPw()">确认修改</button></div></div>
  </section>

  <section class="group">
    <div class="group-title">我的打卡记录${state.myLogs ? ` · 共 ${state.myLogs.length} 条` : ""}</div>
    <div class="card">${logListHtml(state.myLogs)}</div>
  </section>

  <section class="group">
    <div class="btn-row" style="padding-left:0;padding-right:0">
      ${isStandalone() ? "" : `<button class="btn ghost block" style="margin-bottom:10px" onclick="A.install()">📲 安装到手机</button>`}
      <button class="btn danger ghost block" onclick="A.logout()">退出登录</button></div>
  </section>`;
}

/* ================= 动作 ================= */
const A = {
  modalOk() {
    const st = modalState; if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.keepOpenOnOk) { if (st.onOk) st.onOk(v); return; }
    modalState = null; renderModal();
    if (st.onOk) st.onOk(v);
  },
  modalCancel() { modalState = null; renderModal(); },

  async login() {
    const phone = $("lg-phone").value.trim(), password = $("lg-pass").value;
    try {
      const r = await api("POST", "/login", { phone, password });
      state.token = r.token; localStorage.setItem("daka_token", r.token);
      await refresh(); go("orders"); toast("欢迎，" + r.user.name);
    } catch (e) { toast((e && e.error) || "登录失败"); }
  },
  async install() {
    if (isStandalone()) return toast("已经是从主屏打开的了");
    if (deferredInstall) {                      // 安卓 / 桌面 Chrome：直接弹系统安装框
      deferredInstall.prompt();
      try { await deferredInstall.userChoice; } catch (e) {}
      deferredInstall = null;
      return;
    }
    A.installGuide();                           // iOS 等：给图文步骤
  },
  installGuide() {
    const ua = navigator.userAgent || "";
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    const isWeixin = /MicroMessenger/i.test(ua);
    let steps;
    if (isWeixin) {
      steps = `<div class="guide-step"><b>1.</b> 点右上角 <b>···</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选「在浏览器打开」（Safari 或 Chrome）</div>
        <div class="guide-step"><b>3.</b> 再按下面的步骤添加到主屏</div>
        <div class="guide-note">微信内置浏览器不能直接装，要先用系统浏览器打开</div>`;
    } else if (isIOS) {
      steps = `<div class="guide-step"><b>1.</b> 点底部中间的 <span class="ios-share"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg></span> 分享按钮
          （方框加向上箭头）</div>
        <div class="guide-step"><b>2.</b> 在菜单里找到 <b>「添加到主屏幕」</b></div>
        <div class="guide-step"><b>3.</b> 右上角点「添加」，桌面就出现图标了</div>`;
    } else {
      steps = `<div class="guide-step"><b>1.</b> 点浏览器右上角 <b>⋮</b> 菜单</div>
        <div class="guide-step"><b>2.</b> 选 <b>「安装应用」</b> 或「添加到主屏幕」</div>
        <div class="guide-step"><b>3.</b> 确认，桌面就出现图标了</div>`;
    }
    modal({ title: "装到手机主屏", html: `<div class="guide">${steps}</div>`,
      okText: "知道了", onOk: () => A.modalCancel() });
  },
  logout() {
    modal({ title: "退出登录？", body: "下次需要重新输入手机号和密码。", danger: true, okText: "退出",
      onOk: () => A.forceLogout() });
  },
  forceLogout() {
    state.token = null; state.me = null; localStorage.removeItem("daka_token");
    route = { v: "orders", id: null }; render();
  },
  openForgotPw() {
    modal({
      title: "忘记密码 / 修改密码", okText: "确认修改",
      html: `<label class="field" style="border:0;padding:0 0 10px"><span>手机号</span><input class="in" id="fp-phone" inputmode="tel"></label>
        <label class="field" style="border:0;padding:0 0 10px"><span>新密码</span><input class="in" id="fp-p1" type="password"></label>
        <label class="field" style="border:0;padding:0"><span>确认新密码</span><input class="in" id="fp-p2" type="password"></label>`,
      keepOpenOnOk: true,
      onOk: async () => {
        const phone = ($("fp-phone").value || "").trim(), p1 = $("fp-p1").value, p2 = $("fp-p2").value;
        if (!phone) return toast("请填写手机号");
        if (!p1 || p1 !== p2) return toast("两次输入的新密码不一致");
        try {
          await api("POST", "/password/reset", { phone, newPassword: p1 });
          A.modalCancel(); toast("密码已修改，请用新密码登录");
        } catch (e) { toast((e && e.error) || "修改失败"); }
      }
    });
  },
  async changeMyPw() {
    const p1 = $("my-p1").value, p2 = $("my-p2").value;
    if (!p1 || p1 !== p2) return toast("两次输入的新密码不一致");
    try { await api("POST", "/password/change", { newPassword: p1 }); $("my-p1").value = ""; $("my-p2").value = ""; toast("密码修改成功"); }
    catch (e) { toast((e && e.error) || "修改失败"); }
  },

  openDate(id) {
    const el = $(id); if (!el) return;
    try { if (el.showPicker) return el.showPicker(); } catch (e) { }
    el.focus(); el.click();
  },
  syncDateLabel(id) {
    const el = $(id), lab = $(id + "--label"); if (!el || !lab) return;
    lab.textContent = el.value ? fmtDate(el.value) : "选择日期";
    lab.classList.toggle("empty", !el.value);
  },
  syncFileName(id, name) {
    const el = $(id + "--name"); if (el) el.textContent = name || "未选择文件";
  },

  setF(k, v) { filt[k] = v; render(); },
  setFKw(v) {
    filt.kw = v; clearTimeout(A._kwT);
    A._kwT = setTimeout(() => {
      render();
      const inp = document.querySelector(".filters input");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 300);
  },

  async pickImg(input, key) {
    const file = input.files && input.files[0]; if (!file) return;
    A.syncFileName(input.id, file.name);
    const fd = new FormData(); fd.append("image", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", headers: { Authorization: "Bearer " + state.token }, body: fd });
      const j = await r.json(); if (!r.ok) throw j;
      imgDraft[key] = j.url; toast("图片已上传");
    } catch (e) { toast((e && e.error) || "图片上传失败"); }
  },
  collectScalars(section, into) {
    for (const f of state.fields[section].filter(f => f.type !== "log")) {
      if (f.type === "image") { if (imgDraft[f.k]) into[f.k] = imgDraft[f.k]; continue; }
      const el = $("nf-" + f.k); if (el) into[f.k] = el.value.trim();
    }
  },
  async createOrder() {
    const season = ($("nf-season").value || "").trim();
    if (!season) return toast("请选择订单季节");
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    if (!values.styleNo && !values.styleName) return toast("请至少填写货号或款式名");
    try { await api("POST", "/orders", { season, values }); imgDraft = {}; await refresh(); go("orders"); toast("订单已创建"); }
    catch (e) { toast((e && e.error) || "创建失败"); }
  },
  toggleBasic() { editingBasic = !editingBasic; imgDraft = {}; render(); },
  async saveBasic(oid) {
    const season = ($("nf-season") || {}).value || "";
    const values = {}; A.collectScalars("order", values); A.collectScalars("production", values);
    await run(() => api("PATCH", "/orders/" + oid, { season, values }).then(() => { editingBasic = false; imgDraft = {}; }), "已保存修改");
  },
  delOrder(oid) {
    modal({ title: "删除此订单？", body: "删除后不可恢复，订单下的全部打卡记录一并删除。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", "/orders/" + oid).then(() => go("orders")), "订单已删除") });
  },

  toggleAdd(key) { const b = $("add-" + key); if (b) b.classList.toggle("show"); },
  async addLog(oid, key) {
    const el = $("txt-" + key), text = ((el && el.value) || "").trim();
    if (!text) return toast("请填写打卡内容");
    await run(() => api("POST", `/orders/${oid}/logs`, { key, text }), "打卡成功");
  },
  editLog(oid, key, eid) {
    const o = state.orders.find(x => x.id === oid);
    const list = /^sub\d+$/.test(key) ? o.subs[+key.slice(3)].log : (o.logs[key] || []);
    const e = list.find(x => x.id === eid); if (!e) return;
    modal({ title: "修改打卡内容", input: "textarea", value: e.text, okText: "保存",
      onOk: v => { if (v && v.trim()) run(() => api("PATCH", `/orders/${oid}/logs/${key}/${eid}`, { text: v.trim() }), "已修改"); } });
  },
  delLog(oid, key, eid) {
    modal({ title: "删除这条打卡记录？", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/logs/${key}/${eid}`), "已删除") });
  },
  async setSubFactory(oid, i, factory) {
    await run(() => api("PATCH", `/orders/${oid}/subs/${i}`, { factory }), "已更新加工厂");
  },

  inspAddRow() {
    const d = document.createElement("div"); d.className = "grid2 insp-row";
    d.innerHTML = `<label class="field"><span>发现问题</span><textarea class="in insp-p" style="min-height:62px"></textarea></label>
      <label class="field"><span>整改情况</span><textarea class="in insp-f" style="min-height:62px"></textarea></label>`;
    $("insp-items").appendChild(d);
  },
  async saveInsp(oid) {
    const date = $("insp-date").value; if (!date) return toast("请选择验货日期");
    const items = [...document.querySelectorAll(".insp-row")].map(r => ({
      problem: r.querySelector(".insp-p").value.trim(), fix: r.querySelector(".insp-f").value.trim()
    })).filter(x => x.problem || x.fix);
    if (!items.length) return toast("请至少填写一条问题");
    await run(() => api("POST", `/orders/${oid}/inspections`, { date, items }), "验货记录已保存");
  },
  delInsp(oid, gid) {
    modal({ title: "删除这组验货记录？", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/inspections/${gid}`), "已删除") });
  },
  async addFollow(oid) {
    const text = ($("txt-follow").value || "").trim(); if (!text) return toast("请填写内容");
    await run(() => api("POST", `/orders/${oid}/follow`, { text }), "已添加");
  },
  delFollow(oid, eid) {
    modal({ title: "删除这条记录？", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/orders/${oid}/follow/${eid}`), "已删除") });
  },

  /* ---- 管理后台 ---- */
  async addUser() {
    const name = $("nu-name").value.trim(), phone = $("nu-phone").value.trim(),
      role = $("nu-role").value, password = $("nu-pass").value || "123456";
    if (!name || !phone) return toast("请填写姓名和手机号");
    await run(() => api("POST", "/users", { name, phone, role, password }), "账号已创建：" + name);
  },
  async changeRole(id, role) {
    const u = userById(id);
    await run(() => api("PATCH", "/users/" + id, { role }), `已把 ${u ? u.name : ""} 的职位改为${labelForRoleKey(role)}`);
  },
  deleteUser(id) {
    const u = userById(id); if (!u) return;
    modal({ title: `删除员工「${u.name}」？`, body: "删除后该账号无法登录；历史打卡记录仍会保留。此操作不可恢复。",
      danger: true, okText: "确认删除", onOk: () => run(() => api("DELETE", "/users/" + id), "已删除员工：" + u.name) });
  },
  resetUserPw(id) {
    const u = userById(id); if (!u) return;
    modal({ title: `为 ${u.name} 设置新密码`, input: "text", value: "123456", okText: "重置",
      onOk: v => { if (v && v.trim()) run(() => api("POST", `/users/${id}/reset-password`, { password: v.trim() }), "密码已重置"); } });
  },
  async addRole() {
    const label = $("nr-label").value.trim(), template = $("nr-template").value;
    if (!label) return toast("请填写职位名称");
    await run(() => api("POST", "/roles", { label, template }), "职位已添加：" + label);
  },
  delRole(k) {
    const r = state.roles.find(x => x.k === k); if (!r) return;
    modal({ title: `删除职位「${r.label}」？`, body: "只有没人担任该职位时才能删除。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", "/roles/" + k), "职位已删除") });
  },
  async addField() {
    const section = $("cf-sec").value, label = $("cf-label").value.trim(), type = $("cf-type").value;
    if (!label) return toast("请填写字段名称");
    const options = type === "select" ? $("cf-opts").value.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined;
    await run(() => api("POST", "/fields", { section, label, type, options }), "字段已添加：" + label);
  },
  delField(section, key) {
    const f = state.fields[section].find(x => x.k === key); if (!f) return;
    modal({ title: `删除字段「${f.label}」？`, body: "已填写的数据将不再显示。", danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", `/fields/${section}/${key}`), "字段已删除") });
  },
  async addFactory(kind) {
    const name = $("fac-" + kind).value.trim(); if (!name) return;
    await run(() => api("POST", "/factories", { kind, name }), "已添加");
  },
  async delFactory(kind, encName) { await run(() => api("DELETE", `/factories/${kind}/${encName}`), "已删除"); },

  async loadMyLogs(userId) {
    state.myLogs = null;
    try { state.myLogs = await api("GET", `/users/${userId}/logs`); }
    catch (e) { state.myLogs = []; toast((e && e.error) || "读取失败"); }
    render();
  },
  viewStaffLogs(id) { go("staffLogs", id); },

  /* ---- 聊天 ---- */
  async loadContacts(silent) {
    try {
      const list = await api("GET", "/chat/contacts");
      const changed = JSON.stringify(list) !== JSON.stringify(state.chat.contacts);
      state.chat.contacts = list;
      if (changed && !silent && route.v === "chat" && !state.chat.activeId) {
        const box = $("chat-contacts"); if (box) box.innerHTML = contactsHtml(); else render();
      }
    } catch (e) { }
  },
  async openChat(userId) {
    state.chat.activeId = userId; state.chat.messages = []; state.chat.contact = userById(userId) || null;
    state.chat.draft = ""; state.chat.att = null;
    render();
    await A.loadConversation();
    await A.refreshUnread();
  },
  closeChat() {
    state.chat.activeId = null; state.chat.messages = []; state.chat.contact = null;
    state.chat.draft = ""; state.chat.att = null;
    render(); A.loadContacts(true).then(render);
  },
  onDraft(v) { state.chat.draft = v; },
  async pickAtt(input) {
    const file = input.files && input.files[0]; if (!file) return;
    const fd = new FormData(); fd.append("file", file);
    toast("正在上传…");
    try {
      const r = await fetch("/api/chat/upload", { method: "POST", headers: { Authorization: "Bearer " + state.token }, body: fd });
      const j = await r.json(); if (!r.ok) throw j;
      state.chat.att = j; input.value = ""; render();
      const box = $("chat-msgs"); if (box) box.scrollTop = box.scrollHeight;
      toast("附件已就绪，点发送");
    } catch (e) { toast((e && e.error) || "上传失败"); }
  },
  clearAtt() { state.chat.att = null; render(); },
  async loadConversation() {
    if (!state.chat.activeId) return;
    try {
      const r = await api("GET", "/chat/with/" + state.chat.activeId);
      const changed = JSON.stringify(r.messages) !== JSON.stringify(state.chat.messages);
      state.chat.contact = r.contact; state.chat.messages = r.messages;
      if (changed) {
        const box = $("chat-msgs");
        if (box) { box.innerHTML = messagesHtml(); box.scrollTop = box.scrollHeight; }
        else render();
      }
    } catch (e) { }
  },
  async sendMsg() {
    const el = $("chat-text"); if (!el) return;
    const text = (el.value || "").trim(), att = state.chat.att;
    if (!text && !att) return;
    el.value = ""; state.chat.draft = ""; state.chat.att = null;
    if (att) render();
    try {
      await api("POST", "/chat/with/" + state.chat.activeId, { text, attachment: att });
      await A.loadConversation();
      A.loadContacts(true);
    } catch (e) {
      const back = $("chat-text"); if (back) back.value = text;
      state.chat.draft = text; state.chat.att = att;
      toast((e && e.error) || "发送失败"); render();
    }
  },
  async refreshUnread() {
    try {
      const u = await api("GET", "/chat/unread");
      const changed = u.total !== state.unread.total;
      state.unread = u;
      if (changed && document.querySelector(".tabbar")) render();
    } catch (e) { }
  },

  async exportData() {
    if (!isAdmin()) return toast("仅管理员可导出");
    try {
      const r = await fetch("/api/export", { headers: { Authorization: "Bearer " + state.token } });
      if (!r.ok) throw await r.json().catch(() => ({ error: "导出失败" }));
      const blob = await r.blob(), url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `订单导出-${todayStr()}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast("已开始下载");
    } catch (e) { toast((e && e.error) || "导出失败"); }
  },

  /* ---- 批量导入 ---- */
  async importFile(input) {
    const f = input.files && input.files[0]; if (!f) return;
    A.syncFileName(input.id, f.name);
    const fd = new FormData(); fd.append("file", f);
    toast("正在解析文件…");
    try {
      const r = await fetch("/api/import/parse", {
        method: "POST", headers: { Authorization: "Bearer " + state.token }, body: fd });
      const j = await r.json(); if (!r.ok) throw j;
      importRaw = "";
      A.showPreview(A.rowsToPreview(j.rows), j.encoding === "GBK" ? "（已按 GBK 编码读取）" : "");
    } catch (e) { toast((e && e.error) || "文件解析失败"); }
  },
  // 表头列名 -> 字段
  importMap() {
    return { "货号": "styleNo", "款式名": "styleName", "款式": "style", "数量": "qty", "款式描述": "desc",
      "订单交期": "deadline", "交期": "deadline", "面料": "fabric", "业务员": "sales", "下厂员": "follower",
      "季节": "_season", "订单季节": "_season", "绣印工厂": "embFactory", "生产厂": "factory" };
  },
  // 二维数组（首行表头）-> 待确认的订单列表
  rowsToPreview(grid) {
    const MAP = A.importMap();
    const heads = (grid[0] || []).map(h => String(h == null ? "" : h).trim().replace(/^\uFEFF/, ""));
    const out = [];
    for (let i = 1; i < grid.length; i++) {
      const cells = grid[i] || [];
      if (!cells.some(c => String(c == null ? "" : c).trim())) continue;
      const values = {}; let season = "";
      heads.forEach((h, j) => {
        const key = MAP[h], v = String(cells[j] == null ? "" : cells[j]).trim();
        if (!v || !key) return;
        if (key === "_season") season = v;
        else if (key === "sales" || key === "follower") {
          const u = state.users.find(x => x.name === v);
          if (u) values[key] = u.id;
        } else values[key] = v;
      });
      if (!values.styleNo && !values.styleName) continue;
      if (me().template === "sales" && !values.sales) values.sales = me().id;
      out.push({ season: season || "", values });
    }
    return out;
  },
  showPreview(rows, extra) {
    if (!rows.length) return toast("未识别到有效数据，请检查表头列名");
    importPreview = rows; render();
    toast(`识别到 ${rows.length} 单${extra || ""}，已填入下方表单，可修改后确认导入`);
  },
  importText() {
    const raw = ($("imp-text").value || "").trim();
    importRaw = raw;
    if (!raw) return toast("请先粘贴表格内容或选择文件");
    const lines = raw.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return toast("至少需要表头和一行数据");
    const sep = lines[0].includes("\t") ? "\t" : ",";
    const split = l => {
      if (sep === "\t") return l.split("\t");
      const out = []; let cur = "", q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
        else if (c === '"') q = true;
        else if (c === ",") { out.push(cur); cur = ""; }
        else cur += c;
      }
      out.push(cur); return out;
    };
    A.showPreview(A.rowsToPreview(lines.map(split)));
  },
  syncImportInputs() {
    if (!importPreview) return;
    const scal = importScalars();
    importPreview.forEach((r, i) => {
      const se = $("imp" + i + "-season"); if (se) r.season = se.value || "";
      scal.forEach(f => {
        const el = $("imp" + i + "-" + f.k);
        if (el) { const v = (el.value || "").trim(); if (v) r.values[f.k] = v; else delete r.values[f.k]; }
      });
    });
  },
  removeImportRow(i) {
    A.syncImportInputs(); if (!importPreview) return;
    importPreview.splice(i, 1); if (!importPreview.length) importPreview = null;
    render();
  },
  cancelImport() { importPreview = null; render(); toast("已取消，未导入任何数据"); },
  async confirmImport() {
    if (!importPreview || !importPreview.length) return;
    A.syncImportInputs();
    const built = importPreview.filter(r => r.values.styleNo || r.values.styleName)
      .map(r => ({ season: r.season || "未分季", values: r.values }));
    if (!built.length) return toast("每一单请至少填写货号或款式名");
    try {
      const r = await api("POST", "/orders/import", { orders: built });
      importPreview = null; importRaw = "";
      await refresh(); go("orders"); toast(`成功导入 ${r.imported} 个订单`);
    } catch (e) { toast((e && e.error) || "导入失败"); }
  }
};

/* ================= 启动 ================= */
window.go = go; window.A = A;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); deferredInstall = e;      // 存起来，等用户点「安装到手机」再弹
  if (state.me || !$("app").innerHTML) { /* 下次渲染时按钮自然出现 */ }
});
window.addEventListener("appinstalled", () => { deferredInstall = null; toast("已添加到手机主屏"); });

(async function boot() {
  if (state.token) {
    try { await refresh(); }
    catch (e) { state.token = null; localStorage.removeItem("daka_token"); }
  }
  render();
  if (state.me) { A.refreshUnread(); A.loadContacts(true); }
  setInterval(() => { if (state.me) A.refreshUnread(); }, 10000);
  setInterval(() => {
    if (!state.me) return;
    if (route.v === "chat") { if (state.chat.activeId) A.loadConversation(); else A.loadContacts(); }
  }, 4000);
})();
