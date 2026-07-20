"use strict";
/**
 * 前端：单页应用，所有数据来自服务端 API（多人多设备看到同一份数据）。
 * 权限在服务端强制校验，这里只负责隐藏没权限的按钮，改善使用体验。
 */
// 职位名称由服务端下发（管理员可自定义职位），这里只做展示
const roleLabelOf = u => (u ? (u.roleLabel || (u.role === "admin" ? "管理员" : u.role)) : "");
const labelForRoleKey = k => k === "admin" ? "管理员"
  : ((state.roles.find(r => r.k === k) || {}).label || k);

let state = {
  token: localStorage.getItem("daka_token") || null,
  me: null, users: [], fields: { order: [], production: [] },
  factories: { emb: [], prod: [], proc: [] }, orders: [], roles: [],
  // 聊天
  chat: { contacts: [], activeId: null, contact: null, messages: [], draft: "" },
  unread: { total: 0, byUser: {} },
  myLogs: null
};
let route = { v: "orders", id: null };
let editingBasic = false, imgDraft = {}, importPreview = null, importRaw = "";
let filt = { season: "", sales: "", follower: "", kw: "" };
let modalState = null;

/* ================= 工具 ================= */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmtT(t) {
  const d = new Date(t), p = n => String(n).padStart(2, "0");
  const y = d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear() + "-";
  return `${y}${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function toast(s) {
  const m = $("msg"); m.textContent = s; m.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => m.classList.remove("show"), 2400);
}
const userById = id => state.users.find(u => u.id === id);
const uname = id => (userById(id) || {}).name || "";
const me = () => state.me;
const isAdmin = () => me() && me().role === "admin";

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
// 统一的“执行 -> 刷新 -> 重绘”包装，出错弹提示
async function run(fn, okMsg) {
  try { await fn(); await refresh(); render(); if (okMsg) toast(okMsg); }
  catch (e) { toast((e && e.error) || "操作失败"); }
}

/* ================= 权限（前端仅用于显示控制） ================= */
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
  return v;
}
function fieldInput(f, val, prefix) {
  prefix = prefix || "nf-";
  const id = prefix + f.k;
  const opts = optionsFor(f);
  if (opts) return `<select class="in" id="${id}"><option value="">请选择</option>${opts.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === val ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
  if (f.type === "textarea") return `<textarea class="in" id="${id}">${esc(val || "")}</textarea>`;
  if (f.type === "date") return `<input class="in" type="date" id="${id}" value="${esc(val || "")}">`;
  if (f.type === "number") return `<input class="in" type="number" id="${id}" value="${esc(val || "")}">`;
  if (f.type === "image") return `<input class="in" type="file" accept="image/*" id="${id}" onchange="A.pickImg(this,'${f.k}')">${
    val ? `<img src="${esc(val)}" alt="款式图" style="max-width:120px;margin-top:6px;border-radius:8px">` : ""}`;
  return `<input class="in" id="${id}" value="${esc(val || "")}">`;
}
/* 季节：按中国时间自动生成上一年~后两年的 SS/FW，并保留已有季节 */
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

/* ================= 弹窗（替代原生 confirm/prompt） ================= */
function modal(opts) { modalState = opts; renderModal(); }
function renderModal() {
  const mask = $("mask");
  if (!modalState) { mask.classList.remove("show"); mask.innerHTML = ""; return; }
  const o = modalState;
  mask.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <div class="m-title">${esc(o.title)}</div>
    ${o.body ? `<div class="m-body">${esc(o.body)}</div>` : ""}
    ${o.html ? `<div style="margin-top:12px">${o.html}</div>` : ""}
    ${o.input === "textarea" ? `<textarea class="in" id="m-input" style="margin-top:10px;min-height:110px"></textarea>`
      : o.input ? `<input class="in" id="m-input" style="margin-top:10px" ${o.password ? 'type="password"' : ""}>` : ""}
    <div class="row" style="margin-top:14px;justify-content:flex-end">
      <button class="btn ghost mini" onclick="A.modalCancel()">取消</button>
      <button class="btn mini ${o.danger ? "danger" : ""}" onclick="A.modalOk()">${esc(o.okText || "确定")}</button>
    </div></div>`;
  if (o.input) { const i = $("m-input"); i.value = o.value || ""; i.focus(); }
  mask.classList.add("show");
}

/* ================= 路由 / 渲染 ================= */
function go(v, id) {
  route = { v, id: id || null }; editingBasic = false;
  if (v !== "chat") { state.chat.activeId = null; state.chat.messages = []; state.chat.draft = ""; }
  render(); window.scrollTo(0, 0);
  if (v === "account") A.loadMyLogs(state.me.id);
  if (v === "staffLogs" && id) A.loadMyLogs(id);
  if (v === "chat") { A.loadContacts(); A.refreshUnread(); }
}

function render() {
  const app = $("app");
  if (!me()) { app.innerHTML = vLogin(); return; }
  const m = me();
  const navs = [["orders", "订单列表"]];
  if (m.template === "admin" || m.template === "sales") navs.push(["new", "新建订单"]);
  navs.push(["chat", "聊天"]);
  if (m.template === "admin") navs.push(["admin", "管理后台"]);
  navs.push(["account", "我的账号"]);
  const views = { orders: vOrders, new: vNew, detail: vDetail, chat: vChat, admin: vAdmin, account: vAccount, staffLogs: vStaffLogs };
  app.innerHTML = `
  <header class="topbar"><div class="topbar-in">
    <span class="brand"><span class="dot"></span>跟单打卡系统</span>
    <nav class="nav">${navs.map(([v, t]) =>
      `<button class="${route.v === v ? "on" : ""}" onclick="go('${v}')">${t}${
        v === "chat" && state.unread.total ? `<span class="badge">${state.unread.total > 99 ? "99+" : state.unread.total}</span>` : ""}</button>`).join("")}
      <button onclick="A.logout()">退出</button></nav>
    <span class="who">${esc(m.name)} · ${esc(roleLabelOf(m))}</span>
  </div></header>
  <main class="wrap">${(views[route.v] || vOrders)()}</main>`;
}

/* ---------- 登录 ---------- */
function vLogin() {
  return `<div class="login-wrap">
    <div class="login-hero"><h1>跟单打卡系统</h1><p>服装生产进度 · 现场打卡 · 实时同步</p></div>
    <div class="login-body">
      <label class="f"><span>手机号</span><input class="in" id="lg-phone" inputmode="tel" placeholder="请输入手机号"></label>
      <label class="f"><span>密码</span><input class="in" id="lg-pass" type="password" placeholder="请输入密码"
        onkeydown="if(event.key==='Enter')A.login()"></label>
      <button class="btn" style="width:100%;justify-content:center" onclick="A.login()">登 录</button>
      <div style="text-align:center;margin-top:10px"><a href="javascript:void(0)" style="font-size:13px" onclick="A.openForgotPw()">忘记密码 / 修改密码</a></div>
      <div class="demo"><b>演示账号</b>（密码均为 123456）<br>
        管理员：13800000000　业务员：13811112222<br>下厂员：13855556666</div>
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
  const seasons = seasonOptions("");
  const list = state.orders.filter(o =>
    (!filt.season || o.season === filt.season) &&
    (!filt.sales || o.values.sales === filt.sales) &&
    (!filt.follower || o.values.follower === filt.follower) &&
    (!filt.kw || [o.values.styleNo, o.values.styleName, o.values.style].join(" ").toLowerCase().includes(filt.kw.toLowerCase()))
  ).slice().sort((a, b) => b.createdAt - a.createdAt);
  const opt = (arr, cur) => arr.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(t)}</option>`).join("");
  return `<div class="card"><h2><span class="bar"></span>订单列表 <span style="font-weight:400;font-size:13px;color:var(--ink-2)">共 ${list.length} 单</span></h2>
    <div class="filters">
      <select class="in" onchange="A.setF('season',this.value)"><option value="">全部季节</option>${opt(seasons.map(s => [s, s]), filt.season)}</select>
      <select class="in" onchange="A.setF('sales',this.value)"><option value="">全部业务员</option>${opt(state.users.filter(u => u.role === "sales").map(u => [u.id, u.name]), filt.sales)}</select>
      <select class="in" onchange="A.setF('follower',this.value)"><option value="">全部下厂员</option>${opt(state.users.filter(u => u.role === "follower").map(u => [u.id, u.name]), filt.follower)}</select>
      <input class="in" placeholder="搜货号 / 款式名" value="${esc(filt.kw)}" oninput="A.setFKw(this.value)">
      ${isAdmin() ? `<button class="btn ghost mini" onclick="A.exportData()">导出 Excel</button>` : ""}
    </div></div>
  <div class="olist">${list.map(o => {
    const latest = latestLog(o);
    return `<div class="ocard" onclick="go('detail','${o.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')go('detail','${o.id}')">
      <div class="thumb">${o.values.img ? `<img src="${esc(o.values.img)}" alt="款式图">` : "款式图"}</div>
      <div class="main">
        <div class="t1"><span class="tag">${esc(o.season)}</span>${esc(o.values.styleNo || "")} · ${esc(o.values.styleName || "")}</div>
        <div class="t2"><span>业务员 ${esc(uname(o.values.sales))}</span><span>下厂员 ${esc(uname(o.values.follower)) || "未指定"}</span>
          <span class="num">数量 ${esc(o.values.qty || "-")}</span><span class="num">交期 ${esc(o.values.deadline || "-")}</span></div>
        ${latest ? `<div class="t2" style="margin-top:2px"><span>最新：${esc(latest.fieldLabel)} · ${esc(latest.text.slice(0, 40))}${latest.text.length > 40 ? "…" : ""} <span class="num">(${fmtT(latest.t)})</span></span></div>` : ""}
      </div></div>`;
  }).join("") || `<div class="card empty">没有符合条件的订单</div>`}</div>`;
}

/* ---------- 新建订单 / 批量导入 ---------- */
function vNew() {
  const scalars = s => state.fields[s].filter(f => f.type !== "log");
  return `<div class="card"><h2><span class="bar"></span>新建订单</h2>
    <p class="sub">由业务员录入订单基本信息；也可以在下方用表格批量导入。</p>
    <label class="f"><span>订单季节</span>${seasonSelectHtml("")}</label>
    <div class="grid2">${scalars("order").map(f => `<label class="f"><span>${esc(f.label)}</span>${
      fieldInput(f, f.k === "sales" && me().role === "sales" ? me().id : "")}</label>`).join("")}</div>
    <hr class="hr"><p class="sub" style="margin-bottom:8px"><b>生产安排</b>（指定负责打卡的下厂员）</p>
    <div class="grid2">${scalars("production").map(f => `<label class="f"><span>${esc(f.label)}</span>${fieldInput(f, "")}</label>`).join("")}</div>
    <button class="btn" onclick="A.createOrder()">保存订单</button></div>
  <div class="card"><h2><span class="bar"></span>表格批量导入</h2>
    <p class="sub">把 Excel 表格另存为 CSV 后上传，或直接把表格内容复制粘贴到下方。第一行为表头，按“货号、款式名、款式、数量、款式描述、订单交期、面料、业务员、下厂员、季节”等列名自动识别。识别后会<b>填入下方表单</b>，可逐项修改，确认后再导入。</p>
    <input class="in" type="file" accept=".csv,.txt" onchange="A.importFile(this)" style="margin-bottom:8px">
    <textarea class="in" id="imp-text" placeholder="或将 Excel 中选中的区域直接粘贴到这里（含表头）">${esc(importRaw)}</textarea>
    <div class="row" style="margin-top:8px"><button class="btn ghost" onclick="A.importText()">识别数据</button></div>
    ${importPreview ? importPreviewHtml() : ""}</div>`;
}
function importScalars() {
  return [...state.fields.order.filter(f => f.type !== "log" && f.type !== "image"),
          ...state.fields.production.filter(f => f.type !== "log")];
}
function importPreviewHtml() {
  const orderScalars = state.fields.order.filter(f => f.type !== "log" && f.type !== "image");
  const prodScalars = state.fields.production.filter(f => f.type !== "log");
  return `<hr class="hr"><p class="sub"><b>识别结果</b>（共 ${importPreview.length} 单，已填入下方表单，<b>尚未保存</b>。可直接修改任意字段，确认后再导入。姓名在系统里查不到的会显示“请选择”，请手动选一下。）</p>
  ${importPreview.map((r, i) => `<div class="imp-block">
    <div class="row" style="margin-bottom:4px"><b>第 ${i + 1} 单</b>${importPreview.length > 1 ?
      `<a class="right" href="javascript:void(0)" onclick="A.removeImportRow(${i})">移除此单</a>` : ""}</div>
    <label class="f"><span>订单季节</span>${seasonSelectHtml(r.season, "imp" + i + "-")}</label>
    <div class="grid2">${orderScalars.map(f => `<label class="f"><span>${esc(f.label)}</span>${fieldInput(f, r.values[f.k] || "", "imp" + i + "-")}</label>`).join("")}</div>
    <div class="grid2">${prodScalars.map(f => `<label class="f"><span>${esc(f.label)}</span>${fieldInput(f, r.values[f.k] || "", "imp" + i + "-")}</label>`).join("")}</div>
  </div>`).join("")}
  <div class="row" style="margin-top:12px"><button class="btn" onclick="A.confirmImport()">确认导入 ${importPreview.length} 单</button>
    <button class="btn ghost" onclick="A.cancelImport()">取消</button></div>`;
}

/* ---------- 订单详情 ---------- */
function logFieldHtml(o, f, list, addKey, canAdd) {
  const entries = list.slice().sort((a, b) => b.t - a.t);
  return `<div class="logfield">
    <div class="lf-head"><span>${esc(f.label)}</span><span class="cnt">${entries.length} 条记录</span>
      ${canAdd ? `<button class="btn mini right" onclick="A.toggleAdd('${addKey}')">＋ 打卡</button>` : ""}</div>
    ${canAdd ? `<div class="addbox" id="add-${addKey}">
      <textarea class="in" id="txt-${addKey}" placeholder="填写当前进度情况，可详细描述…"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn mini" onclick="A.addLog('${o.id}','${addKey}')">提交打卡</button></div></div>` : ""}
    ${entries.length ? `<ul class="log">${entries.map(e => `<li>
        <div class="meta"><b>${esc(e.byName)}</b> · <span class="num">${fmtT(e.t)}</span>
        ${canTouchEntry(e) ? ` · <a href="javascript:void(0)" onclick="A.editLog('${o.id}','${addKey}','${e.id}')">改</a> <a href="javascript:void(0)" onclick="A.delLog('${o.id}','${addKey}','${e.id}')">删</a>` : ""}</div>
        <div class="txt">${esc(e.text)}</div></li>`).join("")}</ul>` : `<div class="empty">暂无打卡记录</div>`}</div>`;
}
function vDetail() {
  const o = state.orders.find(x => x.id === route.id);
  if (!o) return `<div class="card">订单不存在</div>`;
  const scalars = s => state.fields[s].filter(f => f.type !== "log");
  const logsOf = s => state.fields[s].filter(f => f.type === "log");
  const kv = fs => `<div class="kv">${fs.map(f => `<span class="k">${esc(f.label)}</span><span class="v">${
    f.type === "image" ? (o.values.img ? `<img src="${esc(o.values.img)}" alt="款式图">` : "—")
      : (esc(displayVal(o, f)) || "—")}</span>`).join("")}</div>`;
  const canB = canEditBasic(o), canOrdLog = canAddLog(o, "order"), canProdLog = canAddLog(o, "production");
  const editForm = s => `<div class="grid2" style="margin-top:8px">${scalars(s).map(f =>
    `<label class="f"><span>${esc(f.label)}</span>${fieldInput(f, o.values[f.k] || "")}</label>`).join("")}</div>`;

  return `<button class="back" onclick="go('orders')">← 返回订单列表</button>
  <div class="card"><div class="row"><h2 style="margin:0"><span class="bar"></span>${esc(o.values.styleNo || "")} · ${esc(o.values.styleName || "")}</h2>
    <span class="tag right">订单季节：${esc(o.season)}</span></div></div>

  <div class="card"><div class="row"><h2><span class="bar"></span>一、订单明细</h2>
    ${canB ? `<button class="btn mini ghost right" onclick="A.toggleBasic()">${editingBasic ? "取消" : "编辑"}</button>` : ""}</div>
    <p class="sub">业务员录入，录入人可自行修改${isAdmin() ? "；管理员可修改全部" : ""}</p>
    ${editingBasic && canB
      ? `<label class="f"><span>订单季节</span>${seasonSelectHtml(o.season)}</label>` + editForm("order")
        + `<hr class="hr"><p class="sub"><b>生产安排字段</b></p>` + editForm("production")
        + `<button class="btn" onclick="A.saveBasic('${o.id}')">保存修改</button>`
      : kv(scalars("order"))}
    <hr class="hr">${logsOf("order").map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canOrdLog)).join("")}</div>

  <div class="card"><h2><span class="bar"></span>二、生产明细</h2>
    <p class="sub">由负责本单的下厂员现场打卡${o.values.follower ? `（负责人：${esc(uname(o.values.follower))}）` : "（未指定下厂员）"}，打卡人和时间自动记录</p>
    ${kv(scalars("production"))}
    <hr class="hr">
    ${logsOf("production").filter(f => ["preSample", "cutting"].includes(f.k)).map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog)).join("")}
    <div class="logfield"><div class="lf-head"><span>加工厂明细</span></div>
      ${(o.subs || []).map((s, i) => `<div style="margin-top:10px;border-top:1px dashed var(--line);padding-top:8px">
        <div class="row" style="font-size:14px"><b>${esc(s.name)}</b>
          ${canProdLog ? `<select class="in" style="width:auto;padding:3px 8px;font-size:13px" onchange="A.setSubFactory('${o.id}',${i},this.value)">
            <option value="">选择工厂</option>${state.factories.proc.map(x => `<option ${x === s.factory ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`
            : `<span class="tag role">${esc(s.factory) || "未指定"}</span>`}
          ${canProdLog ? `<button class="btn mini right" onclick="A.toggleAdd('sub${i}')">＋ 打卡</button>` : ""}</div>
        ${canProdLog ? `<div class="addbox" id="add-sub${i}"><textarea class="in" id="txt-sub${i}" placeholder="该加工厂的进度情况…"></textarea>
          <div class="row" style="margin-top:6px"><button class="btn mini" onclick="A.addLog('${o.id}','sub${i}')">提交打卡</button></div></div>` : ""}
        ${s.log.length ? `<ul class="log">${s.log.slice().sort((a, b) => b.t - a.t).map(e => `<li>
          <div class="meta"><b>${esc(e.byName)}</b> · <span class="num">${fmtT(e.t)}</span>${canTouchEntry(e) ?
            ` · <a href="javascript:void(0)" onclick="A.editLog('${o.id}','sub${i}','${e.id}')">改</a> <a href="javascript:void(0)" onclick="A.delLog('${o.id}','sub${i}','${e.id}')">删</a>` : ""}</div>
          <div class="txt">${esc(e.text)}</div></li>`).join("")}</ul>` : `<div class="empty">暂无打卡记录</div>`}</div>`).join("")}
    </div>
    ${logsOf("production").filter(f => !["preSample", "cutting"].includes(f.k)).map(f => logFieldHtml(o, f, o.logs[f.k] || [], f.k, canProdLog)).join("")}</div>

  <div class="card"><div class="row"><h2><span class="bar"></span>三、验货问题</h2>
    <button class="btn mini ghost right" onclick="A.toggleAdd('insp')">＋ 新增验货记录</button></div>
    <div class="addbox" id="add-insp">
      <label class="f"><span>验货日期</span><input class="in" type="date" id="insp-date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <div id="insp-items"><div class="grid2 insp-row">
        <label class="f"><span>发现问题</span><textarea class="in insp-p" style="min-height:64px"></textarea></label>
        <label class="f"><span>整改情况</span><textarea class="in insp-f" style="min-height:64px"></textarea></label></div></div>
      <div class="row"><button class="btn mini ghost" onclick="A.inspAddRow()">＋ 再加一条问题</button>
        <button class="btn mini" onclick="A.saveInsp('${o.id}')">保存验货记录</button></div></div>
    ${o.inspections.length ? o.inspections.slice().sort((a, b) => (b.date < a.date ? -1 : 1)).map(g => `<div class="insp-day">
      <div class="row"><span class="d num">${esc(g.date)}</span>
        <span style="font-size:12.5px;color:var(--ink-2)">记录人 ${esc(g.byName)} · <span class="num">${fmtT(g.t)}</span></span>
        ${(isAdmin() || g.by === me().id) ? `<a class="right" style="font-size:13px" href="javascript:void(0)" onclick="A.delInsp('${o.id}','${g.id}')">删除</a>` : ""}</div>
      ${g.items.map(it => `<div class="insp-item"><div><span class="lbl p">发现问题</span>${esc(it.problem)}</div>
        <div style="margin-top:3px"><span class="lbl f2">整改情况</span>${esc(it.fix) || "—"}</div></div>`).join("")}</div>`).join("")
      : `<div class="empty">暂无验货记录</div>`}</div>

  <div class="card"><div class="row"><h2><span class="bar"></span>四、跟单问题</h2>
    <button class="btn mini ghost right" onclick="A.toggleAdd('follow')">＋ 添加</button></div>
    <p class="sub">自由填写，自动记录填写人和时间</p>
    <div class="addbox" id="add-follow"><textarea class="in" id="txt-follow" placeholder="填写跟单过程中的问题、沟通事项…"></textarea>
      <div class="row" style="margin-top:6px"><button class="btn mini" onclick="A.addFollow('${o.id}')">提交</button></div></div>
    ${o.followIssues.length ? `<ul class="log">${o.followIssues.slice().sort((a, b) => b.t - a.t).map(e => `<li>
      <div class="meta"><b>${esc(e.byName)}</b> · <span class="num">${fmtT(e.t)}</span>${canTouchEntry(e) ?
        ` · <a href="javascript:void(0)" onclick="A.delFollow('${o.id}','${e.id}')">删</a>` : ""}</div>
      <div class="txt">${esc(e.text)}</div></li>`).join("")}</ul>` : `<div class="empty">暂无记录</div>`}</div>
  ${isAdmin() ? `<div class="card"><div class="row"><span class="sub" style="margin:0">管理员操作</span>
    <button class="btn mini danger right" onclick="A.delOrder('${o.id}')">删除此订单</button></div></div>` : ""}`;
}

/* ---------- 打卡记录（简洁列表，用于「我的账号」和管理员查看员工） ---------- */
function logListHtml(rows) {
  if (!rows) return `<div class="empty">加载中…</div>`;
  if (!rows.length) return `<div class="empty">还没有打卡记录</div>`;
  return `<div class="loglist">${rows.map(r => `<div class="logrow">
    <div class="lr-top">
      <a href="javascript:void(0)" onclick="go('detail','${r.orderId}')">${esc(r.styleNo || r.styleName || "订单")}</a>
      <span class="tag">${esc(r.label)}</span>
      <span class="num right">${fmtT(r.t)}</span>
    </div>
    <div class="lr-text">${esc(r.text)}</div></div>`).join("")}</div>`;
}

/* ---------- 聊天（一对一私聊） ---------- */
function avatarHtml(name) {
  return `<span class="avatar">${esc((name || "?").slice(0, 1))}</span>`;
}
function contactsHtml() {
  const list = state.chat.contacts;
  if (!list.length) return `<div class="empty">暂无同事</div>`;
  return list.map(c => `<div class="contact" onclick="A.openChat('${c.id}')">
    ${avatarHtml(c.name)}
    <div class="c-main">
      <div class="c-top"><b>${esc(c.name)}</b><span class="c-role">${esc(c.roleLabel || "")}</span>
        ${c.last ? `<span class="num right c-time">${fmtT(c.last.t)}</span>` : ""}</div>
      <div class="c-last">${c.last ? (c.last.fromMe ? "我：" : "") + esc(c.last.text) : "打个招呼吧"}</div>
    </div>
    ${c.unread ? `<span class="badge">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}
  </div>`).join("");
}
function messagesHtml() {
  const ms = state.chat.messages;
  if (!ms.length) return `<div class="empty" style="text-align:center;padding:24px 0">还没有聊天记录，发第一条消息吧</div>`;
  let lastDay = "";
  return ms.map(m => {
    const d = new Date(m.t), day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    let sep = "";
    if (day !== lastDay) { lastDay = day; sep = `<div class="day-sep">${fmtT(m.t).replace(/ \d{2}:\d{2}$/, "")}</div>`; }
    return sep + `<div class="bubble-row ${m.fromMe ? "mine" : ""}">
      <div class="bubble">${esc(m.text)}<span class="b-time num">${fmtT(m.t).slice(-5)}</span></div></div>`;
  }).join("");
}
function vChat() {
  if (!state.chat.activeId) {
    return `<div class="card"><h2><span class="bar"></span>聊天</h2>
      <p class="sub">和同事一对一私聊，只有你们两个人能看到</p>
      <div id="chat-contacts" class="contacts">${contactsHtml()}</div></div>`;
  }
  const c = state.chat.contact;
  return `<div class="card chat-card">
    <div class="chat-head">
      <button class="back" style="margin:0" onclick="A.closeChat()">← 返回</button>
      ${avatarHtml(c && c.name)}<b>${esc(c ? c.name : "")}</b>
      <span class="c-role">${esc(c ? c.roleLabel : "")}</span>
    </div>
    <div class="chat-msgs" id="chat-msgs">${messagesHtml()}</div>
    <div class="chat-input">
      <textarea class="in" id="chat-text" rows="1" placeholder="输入消息…"
        oninput="A.onDraft(this.value)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();A.sendMsg();}">${esc(state.chat.draft)}</textarea>
      <button class="btn" onclick="A.sendMsg()">发送</button>
    </div></div>`;
}

/* ---------- 管理员查看某员工的打卡记录 ---------- */
function vStaffLogs() {
  const u = userById(route.id);
  return `<button class="back" onclick="go('admin')">← 返回管理后台</button>
    <div class="card"><h2><span class="bar"></span>${esc(u ? u.name : "")} 的打卡记录
      <span style="font-weight:400;font-size:13px;color:var(--ink-2)">${state.myLogs ? `共 ${state.myLogs.length} 条` : ""}</span></h2>
      ${logListHtml(state.myLogs)}</div>`;
}

/* ---------- 管理后台 ---------- */
function vAdmin() {
  if (!isAdmin()) return `<div class="card">仅管理员可访问</div>`;
  const roleCell = u => u.role === "admin"
    ? `<span class="tag role">管理员</span>`
    : `<select class="in" style="width:auto;padding:3px 8px;font-size:13px" onchange="A.changeRole('${u.id}',this.value)">
        ${state.roles.map(r => `<option value="${esc(r.k)}" ${u.role === r.k ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>`;
  return `<div class="card"><h2><span class="bar"></span>员工账号管理</h2>
    <p class="sub">员工账号统一由管理员创建。<b>职位可直接下拉修改</b>（自己的职位不可改）；员工离职可删除账号（需二次确认，其历史打卡记录仍保留）</p>
    <div class="tbl-wrap"><table class="tbl"><tr><th>姓名</th><th>手机号</th><th>职位</th><th>操作</th></tr>
    ${state.users.map(u => `<tr><td>${esc(u.name)}${u.id === me().id ? `<span class="tag" style="margin-left:6px">我</span>` : ""}</td>
      <td class="num">${esc(u.phone)}</td><td>${roleCell(u)}</td>
      <td><button class="btn mini ghost" onclick="A.viewStaffLogs('${u.id}')">查看打卡</button>${
        u.role === "admin" ? "" : ` <button class="btn mini ghost" onclick="A.resetUserPw('${u.id}')">重置密码</button>
        <button class="btn mini danger" onclick="A.deleteUser('${u.id}')">删除</button>`}</td></tr>`).join("")}</table></div>
    <hr class="hr"><p class="sub"><b>新增员工</b></p>
    <div class="grid2">
      <label class="f"><span>姓名</span><input class="in" id="nu-name"></label>
      <label class="f"><span>手机号</span><input class="in" id="nu-phone" inputmode="tel"></label>
      <label class="f"><span>职位</span><select class="in" id="nu-role">${state.roles.map(r => `<option value="${esc(r.k)}">${esc(r.label)}</option>`).join("")}</select></label>
      <label class="f"><span>初始密码</span><input class="in" id="nu-pass" value="123456"></label></div>
    <button class="btn" onclick="A.addUser()">创建账号</button></div>

  <div class="card"><h2><span class="bar"></span>职位管理</h2>
    <p class="sub">除内置的业务员、下厂员外，可以自己加职位（例如「跟单主管」「质检员」）。新职位要选一套权限：
      <b>业务员权限</b>=可建单、可改自己录入的订单；<b>下厂员权限</b>=只能给自己负责的订单打卡。</p>
    <div class="row" style="gap:6px">${state.roles.map(r => `<span class="tag role">${esc(r.label)}
      <span style="opacity:.7">(${r.template === "sales" ? "业务员权限" : "下厂员权限"})</span>${
        r.core ? "" : ` <a href="javascript:void(0)" title="删除职位" onclick="A.delRole('${r.k}')" style="text-decoration:none">✕</a>`}</span>`).join("")}</div>
    <hr class="hr"><div class="grid2">
      <label class="f"><span>新职位名称</span><input class="in" id="nr-label" placeholder="例：跟单主管"></label>
      <label class="f"><span>权限模板</span><select class="in" id="nr-template">
        <option value="sales">业务员权限（可建单、改自己录入的订单）</option>
        <option value="follower">下厂员权限（只能给自己负责的订单打卡）</option></select></label></div>
    <button class="btn" onclick="A.addRole()">添加职位</button></div>

  <div class="card"><h2><span class="bar"></span>自定义字段</h2>
    <p class="sub">“订单明细”和“生产明细”板块的字段可以增减，不是写死的固定表单</p>
    ${["order", "production"].map(s => `<p class="sub" style="margin:8px 0 4px"><b>${s === "order" ? "一、订单明细" : "二、生产明细"}</b></p>
      <div class="row" style="gap:6px">${state.fields[s].map(f => `<span class="tag role">${esc(f.label)}${
        f.core ? "" : ` <a href="javascript:void(0)" title="删除字段" onclick="A.delField('${s}','${f.k}')" style="text-decoration:none">✕</a>`}</span>`).join("")}</div>`).join("")}
    <hr class="hr"><div class="grid2">
      <label class="f"><span>添加到板块</span><select class="in" id="cf-sec"><option value="order">一、订单明细</option><option value="production">二、生产明细</option></select></label>
      <label class="f"><span>字段名称</span><input class="in" id="cf-label" placeholder="例：吊牌进度"></label>
      <label class="f"><span>字段类型</span><select class="in" id="cf-type" onchange="document.getElementById('cf-opts-wrap').style.display=this.value==='select'?'':'none'">
        <option value="text">文本</option><option value="log">进度打卡（保留历史）</option><option value="date">日期</option><option value="number">数字</option><option value="select">下拉菜单</option></select></label>
      <label class="f" id="cf-opts-wrap" style="display:none"><span>下拉选项（用逗号分隔）</span><input class="in" id="cf-opts" placeholder="例：选项A,选项B"></label></div>
    <button class="btn" onclick="A.addField()">添加字段</button></div>

  <div class="card"><h2><span class="bar"></span>工厂下拉选项</h2>
    ${[["emb", "绣印工厂"], ["prod", "生产厂"], ["proc", "加工厂"]].map(([k, t]) => `
      <p class="sub" style="margin:8px 0 4px"><b>${t}</b></p>
      <div class="row" style="gap:6px">${state.factories[k].map(x => `<span class="tag role">${esc(x)} <a href="javascript:void(0)" onclick="A.delFactory('${k}','${encodeURIComponent(x)}')" style="text-decoration:none">✕</a></span>`).join("")}
      <input class="in" style="width:150px;padding:4px 9px" id="fac-${k}" placeholder="新工厂名">
      <button class="btn mini ghost" onclick="A.addFactory('${k}')">添加</button></div>`).join("")}</div>

  <div class="card"><h2><span class="bar"></span>数据导出</h2>
    <p class="sub">导出全部订单为 Excel(.xlsx) 文件</p>
    <button class="btn" onclick="A.exportData()">导出订单数据</button></div>`;
}

/* ---------- 我的账号 ---------- */
function vAccount() {
  const m = me();
  return `<div class="card"><h2><span class="bar"></span>我的账号</h2>
    <div class="kv" style="margin-bottom:14px"><span class="k">姓名</span><span class="v">${esc(m.name)}</span>
      <span class="k">手机号</span><span class="v num">${esc(m.phone)}</span>
      <span class="k">职位</span><span class="v">${esc(roleLabelOf(m))}</span></div>
    <hr class="hr"><p class="sub"><b>修改密码</b></p>
    <div class="grid2">
      <label class="f"><span>新密码</span><input class="in" type="password" id="my-p1"></label>
      <label class="f"><span>确认新密码</span><input class="in" type="password" id="my-p2"></label></div>
    <button class="btn" onclick="A.changeMyPw()">确认修改</button></div>
  <div class="card"><h2><span class="bar"></span>我的打卡记录
    <span style="font-weight:400;font-size:13px;color:var(--ink-2)">${state.myLogs ? `共 ${state.myLogs.length} 条` : ""}</span></h2>
    ${logListHtml(state.myLogs)}</div>`;
}

/* ================= 动作 ================= */
const A = {
  modalOk() {
    const st = modalState;
    if (!st) return;
    const v = st.input ? ($("m-input") ? $("m-input").value : "") : null;
    if (st.keepOpenOnOk) { if (st.onOk) st.onOk(v); return; }  // 由 onOk 自己决定何时关闭
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
  logout() { A.forceLogout(); },
  forceLogout() {
    state.token = null; state.me = null; localStorage.removeItem("daka_token");
    route = { v: "orders", id: null }; render();
  },
  // 忘记密码 / 修改密码：弹窗形式，不再撑长登录页
  openForgotPw() {
    modal({
      title: "忘记密码 / 修改密码", okText: "确认修改",
      body: "输入手机号和新密码即可重置（公司内部系统，不需要短信验证码）。",
      html: `<label class="f"><span>手机号</span><input class="in" id="fp-phone" inputmode="tel"></label>
        <label class="f"><span>新密码</span><input class="in" id="fp-p1" type="password"></label>
        <label class="f" style="margin-bottom:0"><span>确认新密码</span><input class="in" id="fp-p2" type="password"></label>`,
      keepOpenOnOk: true,
      onOk: async () => {
        const phone = ($("fp-phone").value || "").trim();
        const p1 = $("fp-p1").value, p2 = $("fp-p2").value;
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
    try { await api("POST", "/password/change", { newPassword: p1 }); toast("密码修改成功"); }
    catch (e) { toast((e && e.error) || "修改失败"); }
  },

  setF(k, v) { filt[k] = v; render(); },
  setFKw(v) {
    filt.kw = v;
    clearTimeout(A._kwT);
    A._kwT = setTimeout(() => {
      render();
      const inp = document.querySelector(".filters input");
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 300);
  },

  async pickImg(input, key) {
    const file = input.files && input.files[0]; if (!file) return;
    const fd = new FormData(); fd.append("image", file);
    try {
      const r = await fetch("/api/upload", { method: "POST", headers: { Authorization: "Bearer " + state.token }, body: fd });
      const j = await r.json();
      if (!r.ok) throw j;
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
    d.innerHTML = `<label class="f"><span>发现问题</span><textarea class="in insp-p" style="min-height:64px"></textarea></label>
      <label class="f"><span>整改情况</span><textarea class="in insp-f" style="min-height:64px"></textarea></label>`;
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
    modal({ title: `删除员工「${u.name}」？`, body: "删除后该账号无法登录；其历史打卡记录和订单数据仍会保留。此操作不可恢复。",
      danger: true, okText: "确认删除",
      onOk: () => run(() => api("DELETE", "/users/" + id), "已删除员工：" + u.name) });
  },
  resetUserPw(id) {
    const u = userById(id); if (!u) return;
    modal({ title: `为 ${u.name} 设置新密码`, input: "text", value: "123456", okText: "重置",
      onOk: v => { if (v && v.trim()) run(() => api("POST", `/users/${id}/reset-password`, { password: v.trim() }), "密码已重置"); } });
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
  async delFactory(kind, encName) {
    await run(() => api("DELETE", `/factories/${kind}/${encName}`), "已删除");
  },

  /* ---- 职位管理 ---- */
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

  /* ---- 打卡记录 ---- */
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
    state.chat.draft = "";
    render();
    await A.loadConversation();
    await A.refreshUnread();
  },
  closeChat() {
    state.chat.activeId = null; state.chat.messages = []; state.chat.contact = null; state.chat.draft = "";
    A.loadContacts(true).then(render);
    render();
  },
  onDraft(v) { state.chat.draft = v; },
  async loadConversation() {
    if (!state.chat.activeId) return;
    try {
      const r = await api("GET", "/chat/with/" + state.chat.activeId);
      const changed = JSON.stringify(r.messages) !== JSON.stringify(state.chat.messages);
      state.chat.contact = r.contact; state.chat.messages = r.messages;
      if (changed) {
        // 只更新消息区，避免打断正在输入的内容
        const box = $("chat-msgs");
        if (box) { box.innerHTML = messagesHtml(); box.scrollTop = box.scrollHeight; }
        else render();
      }
    } catch (e) { }
  },
  async sendMsg() {
    const el = $("chat-text"); if (!el) return;
    const text = (el.value || "").trim();
    if (!text) return;
    el.value = ""; state.chat.draft = "";
    try {
      await api("POST", "/chat/with/" + state.chat.activeId, { text });
      await A.loadConversation();
      A.loadContacts(true);
    } catch (e) { el.value = text; state.chat.draft = text; toast((e && e.error) || "发送失败"); }
  },
  async refreshUnread() {
    try {
      const u = await api("GET", "/chat/unread");
      const changed = u.total !== state.unread.total;
      state.unread = u;
      if (changed) {
        const nav = document.querySelector(".nav");
        if (nav) render();
      }
    } catch (e) { }
  },

  async exportData() {
    if (!isAdmin()) return toast("仅管理员可导出");
    try {
      const r = await fetch("/api/export", { headers: { Authorization: "Bearer " + state.token } });
      if (!r.ok) throw await r.json().catch(() => ({ error: "导出失败" }));
      const blob = await r.blob(), url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `订单导出-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast("已开始下载");
    } catch (e) { toast((e && e.error) || "导出失败"); }
  },

  /* ---- 批量导入：识别 -> 填入可编辑表单 -> 确认导入 ---- */
  importFile(input) {
    const f = input.files && input.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { importRaw = rd.result; render(); A.importText(); };
    rd.readAsText(f, "utf-8");
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
    const heads = split(lines[0]).map(h => h.trim().replace(/^﻿/, ""));
    const MAP = { "货号": "styleNo", "款式名": "styleName", "款式": "style", "数量": "qty", "款式描述": "desc",
      "订单交期": "deadline", "交期": "deadline", "面料": "fabric", "业务员": "sales", "下厂员": "follower",
      "季节": "_season", "订单季节": "_season", "绣印工厂": "embFactory", "生产厂": "factory" };
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = split(lines[i]); if (!cells.some(c => c && c.trim())) continue;
      const values = {}; let season = "";
      heads.forEach((h, j) => {
        const key = MAP[h], v = (cells[j] || "").trim(); if (!v) return;
        if (key === "_season") season = v;
        else if (key === "sales" || key === "follower") {
          const u = state.users.find(x => x.name === v);
          if (u) values[key] = u.id;
        } else if (key) values[key] = v;
      });
      if (!values.styleNo && !values.styleName) continue;
      if (me().role === "sales" && !values.sales) values.sales = me().id;
      rows.push({ season: season || "", values });
    }
    if (!rows.length) return toast("未识别到有效数据，请检查表头列名");
    importPreview = rows; render();
    toast(`识别到 ${rows.length} 单，已填入下方表单，可修改后确认导入`);
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
(async function boot() {
  if (state.token) {
    try { await refresh(); }
    catch (e) { state.token = null; localStorage.removeItem("daka_token"); }
  }
  render();
  if (state.me) { A.refreshUnread(); A.loadContacts(true); }

  // 轮询：未读数每 10 秒；正在看的会话每 4 秒（规模小，轮询足够，无需 WebSocket）
  setInterval(() => { if (state.me) A.refreshUnread(); }, 10000);
  setInterval(() => {
    if (!state.me) return;
    if (route.v === "chat") {
      if (state.chat.activeId) A.loadConversation();
      else A.loadContacts();
    }
  }, 4000);
})();
