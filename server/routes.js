"use strict";
/**
 * 全部 API 路由，挂载在 /api 下。
 * 订单业务数据以 JSON 存在 orders.data 里，读出后形状与前端一致：
 *   { id, season, createdBy, createdAt, values, logs, subs, inspections, followIssues }
 * 所有写操作都在服务端做权限校验。
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const XLSX = require("xlsx");
const { db, uid, getSetting, setSetting, UPLOAD_DIR } = require("./db");
const A = require("./auth");

const router = express.Router();

/* ---------- 订单读写帮助 ---------- */
function loadOrder(id) {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  if (!row) return null;
  row.data = JSON.parse(row.data);
  return row;
}
function saveOrder(o) {
  db.prepare("UPDATE orders SET season=?, updated_at=?, data=? WHERE id=?")
    .run(o.season, Date.now(), JSON.stringify(o.data), o.id);
}
function orderPublic(o) {
  return { id: o.id, season: o.season, createdBy: o.created_by, createdAt: o.created_at,
    values: o.data.values || {}, logs: o.data.logs || {}, subs: o.data.subs || [],
    inspections: o.data.inspections || [], followIssues: o.data.followIssues || [] };
}
function allOrdersPublic() {
  return db.prepare("SELECT * FROM orders").all().map(r => { r.data = JSON.parse(r.data); return orderPublic(r); });
}
function logFields() {
  const f = getSetting("fields", { order: [], production: [] });
  return [...f.order, ...f.production].filter(x => x.type === "log");
}
function sectionOfKey(key) {
  if (/^sub\d+$/.test(key)) return "production";
  const f = getSetting("fields", { order: [], production: [] });
  return f.order.some(x => x.k === key) ? "order" : "production";
}
function listForKey(o, key) {
  if (/^sub\d+$/.test(key)) {
    const i = +key.slice(3);
    if (!o.data.subs[i]) return null;
    return o.data.subs[i].log;
  }
  o.data.logs = o.data.logs || {};
  if (!o.data.logs[key]) o.data.logs[key] = [];
  return o.data.logs[key];
}
function emptyOrderData(values) {
  const logs = {};
  logFields().forEach(f => logs[f.k] = []);
  return {
    values: values || {}, logs,
    subs: [{ name: "主厂", factory: (values && values.factory) || "", log: [] },
           { name: "加工厂2", factory: "", log: [] },
           { name: "加工厂3", factory: "", log: [] },
           { name: "加工厂4", factory: "", log: [] }],
    inspections: [], followIssues: []
  };
}

/* =========================================================
 *  认证相关（无需登录）
 * ========================================================= */
router.post("/login", (req, res) => {
  const { phone, password } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u || !A.verifyPassword(password || "", u.password_hash))
    return res.status(400).json({ error: "手机号或密码不正确" });
  res.json({ token: A.signToken(u), user: A.userPublic(u) });
});

// 忘记密码：手机号 + 新密码直接改（按需求不加短信验证码）
router.post("/password/reset", (req, res) => {
  const { phone, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: "新密码至少 4 位" });
  const u = db.prepare("SELECT * FROM users WHERE phone = ? AND deleted = 0").get(String(phone || "").trim());
  if (!u) return res.status(404).json({ error: "找不到该手机号对应的账号" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(newPassword), u.id);
  res.json({ ok: true });
});

/* 以下全部需要登录 */
router.use(A.authRequired);

router.get("/bootstrap", (req, res) => {
  res.json({
    me: A.userPublic(req.user),
    users: db.prepare("SELECT * FROM users WHERE deleted = 0").all().map(A.userPublic),
    fields: getSetting("fields", { order: [], production: [] }),
    factories: getSetting("factories", { emb: [], prod: [], proc: [] }),
    roles: getSetting("roles", []),
    orders: allOrdersPublic()
  });
});

router.post("/password/change", (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: "新密码至少 4 位" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

/* =========================================================
 *  员工账号管理（管理员）
 * ========================================================= */
router.get("/users", A.adminRequired, (req, res) => {
  res.json(db.prepare("SELECT * FROM users WHERE deleted = 0").all().map(A.userPublic));
});

router.post("/users", A.adminRequired, (req, res) => {
  const { name, phone, role, password } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "请填写姓名和手机号" });
  if (!getSetting("roles", []).some(r => r.k === role)) return res.status(400).json({ error: "职位不存在" });
  const exists = db.prepare("SELECT id FROM users WHERE phone = ? AND deleted = 0").get(String(phone).trim());
  if (exists) return res.status(400).json({ error: "该手机号已存在" });
  const id = uid();
  db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
    .run(id, String(name).trim(), String(phone).trim(), A.hashPassword(password || "123456"), role, Date.now());
  res.json(A.userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(id)));
});

// 修改员工：姓名 / 手机号 / 角色（角色可下拉改任何人，但不含自己）
router.patch("/users/:id", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  const { name, phone, role } = req.body || {};
  if (role !== undefined) {
    if (u.id === req.user.id) return res.status(400).json({ error: "不能修改自己的职位" });
    if (u.role === "admin") return res.status(400).json({ error: "不能修改管理员的职位" });
    if (!getSetting("roles", []).some(r => r.k === role)) return res.status(400).json({ error: "职位不存在" });
    db.prepare("UPDATE users SET role=? WHERE id=?").run(role, u.id);
  }
  if (name !== undefined && String(name).trim()) db.prepare("UPDATE users SET name=? WHERE id=?").run(String(name).trim(), u.id);
  if (phone !== undefined && String(phone).trim()) {
    const dup = db.prepare("SELECT id FROM users WHERE phone=? AND id<>? AND deleted=0").get(String(phone).trim(), u.id);
    if (dup) return res.status(400).json({ error: "该手机号已被占用" });
    db.prepare("UPDATE users SET phone=? WHERE id=?").run(String(phone).trim(), u.id);
  }
  res.json(A.userPublic(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.post("/users/:id/reset-password", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  const { password } = req.body || {};
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(A.hashPassword(password || "123456"), u.id);
  res.json({ ok: true });
});

router.delete("/users/:id", A.adminRequired, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u || u.deleted) return res.status(404).json({ error: "员工不存在" });
  if (u.id === req.user.id) return res.status(400).json({ error: "不能删除自己的账号" });
  if (u.role === "admin") return res.status(400).json({ error: "不能删除管理员账号" });
  db.prepare("UPDATE users SET deleted=1 WHERE id=?").run(u.id);
  res.json({ ok: true });
});

/* =========================================================
 *  自定义字段 / 工厂下拉（管理员）
 * ========================================================= */
router.post("/fields", A.adminRequired, (req, res) => {
  const { section, label, type, options } = req.body || {};
  if (!["order", "production"].includes(section)) return res.status(400).json({ error: "板块不对" });
  if (!label) return res.status(400).json({ error: "请填写字段名称" });
  const fields = getSetting("fields", { order: [], production: [] });
  const f = { k: "f" + Date.now(), label: String(label).trim(), type: type || "text" };
  if (type === "select") f.options = (options || []).map(s => String(s).trim()).filter(Boolean);
  fields[section].push(f);
  setSetting("fields", fields);
  if (type === "log") { // 给已有订单补上这个进度字段的空数组
    db.prepare("SELECT id, data FROM orders").all().forEach(r => {
      const d = JSON.parse(r.data); d.logs = d.logs || {}; if (!d.logs[f.k]) d.logs[f.k] = [];
      db.prepare("UPDATE orders SET data=? WHERE id=?").run(JSON.stringify(d), r.id);
    });
  }
  res.json(fields);
});

router.delete("/fields/:section/:key", A.adminRequired, (req, res) => {
  const { section, key } = req.params;
  const fields = getSetting("fields", { order: [], production: [] });
  if (!fields[section]) return res.status(400).json({ error: "板块不对" });
  const f = fields[section].find(x => x.k === key);
  if (!f) return res.status(404).json({ error: "字段不存在" });
  if (f.core) return res.status(400).json({ error: "核心字段不可删除" });
  fields[section] = fields[section].filter(x => x.k !== key);
  setSetting("fields", fields);
  res.json(fields);
});

router.post("/factories", A.adminRequired, (req, res) => {
  const { kind, name } = req.body || {};
  const factories = getSetting("factories", { emb: [], prod: [], proc: [] });
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  const v = String(name || "").trim();
  if (v && !factories[kind].includes(v)) factories[kind].push(v);
  setSetting("factories", factories);
  res.json(factories);
});

router.delete("/factories/:kind/:name", A.adminRequired, (req, res) => {
  const { kind, name } = req.params;
  const factories = getSetting("factories", { emb: [], prod: [], proc: [] });
  if (!factories[kind]) return res.status(400).json({ error: "类型不对" });
  factories[kind] = factories[kind].filter(x => x !== decodeURIComponent(name));
  setSetting("factories", factories);
  res.json(factories);
});

/* =========================================================
 *  订单
 * ========================================================= */
function canCreateOrder(u) { const t = A.templateOf(u); return t === "admin" || t === "sales"; }

router.get("/orders", (req, res) => res.json(allOrdersPublic()));
router.get("/orders/:id", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  res.json(orderPublic(o));
});

router.post("/orders", (req, res) => {
  if (!canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以新建订单" });
  const { season, values } = req.body || {};
  const v = values || {};
  if (!v.styleNo && !v.styleName) return res.status(400).json({ error: "请至少填写货号或款式名" });
  if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
  const id = uid(), now = Date.now();
  db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run(id, season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
  res.json(orderPublic(loadOrder(id)));
});

router.post("/orders/import", (req, res) => {
  if (!canCreateOrder(req.user)) return res.status(403).json({ error: "只有业务员或管理员可以导入" });
  const rows = (req.body && req.body.orders) || [];
  let n = 0; const now = Date.now();
  for (const r of rows) {
    const v = r.values || {};
    if (!v.styleNo && !v.styleName) continue;
    if (req.user.role === "sales" && !v.sales) v.sales = req.user.id;
    db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
      .run(uid(), r.season || "未分季", req.user.id, now, now, JSON.stringify(emptyOrderData(v)));
    n++;
  }
  if (!n) return res.status(400).json({ error: "没有可导入的订单（每单至少要有货号或款式名）" });
  res.json({ imported: n });
});

router.patch("/orders/:id", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canEditBasic(req.user, o)) return res.status(403).json({ error: "无权修改此订单的基本信息" });
  const { season, values } = req.body || {};
  if (season !== undefined && String(season).trim()) o.season = String(season).trim();
  if (values && typeof values === "object") o.data.values = Object.assign({}, o.data.values, values);
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id", A.adminRequired, (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  db.prepare("DELETE FROM orders WHERE id=?").run(o.id);
  res.json({ ok: true });
});

/* ---------- 打卡记录 ---------- */
router.post("/orders/:id/logs", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const { key, text } = req.body || {};
  const section = sectionOfKey(key);
  if (!A.canAddLog(req.user, o, section)) return res.status(403).json({ error: "你没有权限在此订单打卡" });
  const list = listForKey(o, key);
  if (!list) return res.status(400).json({ error: "字段不存在" });
  const t = String(text || "").trim();
  if (!t) return res.status(400).json({ error: "请填写打卡内容" });
  list.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.patch("/orders/:id/logs/:key/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const list = listForKey(o, req.params.key);
  const e = list && list.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, e)) return res.status(403).json({ error: "只能修改自己的打卡记录" });
  const t = String((req.body || {}).text || "").trim();
  if (!t) return res.status(400).json({ error: "内容不能为空" });
  e.text = t; saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/logs/:key/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const list = listForKey(o, req.params.key);
  const e = list && list.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, e)) return res.status(403).json({ error: "只能删除自己的打卡记录" });
  list.splice(list.indexOf(e), 1); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.patch("/orders/:id/subs/:index", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  if (!A.canAddLog(req.user, o, "production")) return res.status(403).json({ error: "无权修改" });
  const i = +req.params.index;
  if (!o.data.subs[i]) return res.status(400).json({ error: "加工厂不存在" });
  o.data.subs[i].factory = String((req.body || {}).factory || "");
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* ---------- 验货问题 ---------- */
router.post("/orders/:id/inspections", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const { date, items } = req.body || {};
  if (!date) return res.status(400).json({ error: "请选择验货日期" });
  const clean = (items || []).map(x => ({ problem: String(x.problem || "").trim(), fix: String(x.fix || "").trim() }))
    .filter(x => x.problem || x.fix);
  if (!clean.length) return res.status(400).json({ error: "请至少填写一条问题" });
  o.data.inspections.push({ id: uid(), date, by: req.user.id, byName: req.user.name, t: Date.now(), items: clean });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/inspections/:inspId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const g = o.data.inspections.find(x => x.id === req.params.inspId);
  if (!g) return res.status(404).json({ error: "记录不存在" });
  if (!(req.user.role === "admin" || g.by === req.user.id)) return res.status(403).json({ error: "只能删除自己的验货记录" });
  o.data.inspections = o.data.inspections.filter(x => x.id !== g.id); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* ---------- 跟单问题 ---------- */
router.post("/orders/:id/follow", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const t = String((req.body || {}).text || "").trim();
  if (!t) return res.status(400).json({ error: "请填写内容" });
  o.data.followIssues.push({ id: uid(), by: req.user.id, byName: req.user.name, t: Date.now(), text: t });
  saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

router.delete("/orders/:id/follow/:entryId", (req, res) => {
  const o = loadOrder(req.params.id);
  if (!o) return res.status(404).json({ error: "订单不存在" });
  const e = o.data.followIssues.find(x => x.id === req.params.entryId);
  if (!e) return res.status(404).json({ error: "记录不存在" });
  if (!A.canTouchEntry(req.user, e)) return res.status(403).json({ error: "只能删除自己的记录" });
  o.data.followIssues = o.data.followIssues.filter(x => x.id !== e.id); saveOrder(o);
  res.json(orderPublic(loadOrder(o.id)));
});

/* =========================================================
 *  职位管理（管理员）：名称自由，权限从两套模板里选
 * ========================================================= */
router.get("/roles", (req, res) => res.json(getSetting("roles", [])));

router.post("/roles", A.adminRequired, (req, res) => {
  const { label, template } = req.body || {};
  const name = String(label || "").trim();
  if (!name) return res.status(400).json({ error: "请填写职位名称" });
  if (!["sales", "follower"].includes(template))
    return res.status(400).json({ error: "请选择权限模板（业务员权限 / 下厂员权限）" });
  const roles = getSetting("roles", []);
  if (roles.some(r => r.label === name)) return res.status(400).json({ error: "已有同名职位" });
  roles.push({ k: "r" + Date.now(), label: name, template });
  setSetting("roles", roles);
  res.json(roles);
});

router.delete("/roles/:k", A.adminRequired, (req, res) => {
  const roles = getSetting("roles", []);
  const r = roles.find(x => x.k === req.params.k);
  if (!r) return res.status(404).json({ error: "职位不存在" });
  if (r.core) return res.status(400).json({ error: "内置职位不可删除" });
  const used = db.prepare("SELECT COUNT(*) c FROM users WHERE role = ? AND deleted = 0").get(r.k).c;
  if (used) return res.status(400).json({ error: `还有 ${used} 位员工是「${r.label}」，请先把他们改成其它职位` });
  setSetting("roles", roles.filter(x => x.k !== r.k));
  res.json(roles.filter(x => x.k !== r.k));
});

/* =========================================================
 *  私人聊天（所有人可用，一对一）
 * ========================================================= */
// 联系人列表：除自己外的所有在职同事 + 最后一条消息 + 未读数
router.get("/chat/contacts", (req, res) => {
  const meId = req.user.id;
  const others = db.prepare("SELECT * FROM users WHERE deleted = 0 AND id <> ?").all(meId);
  const lastStmt = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at DESC LIMIT 1`);
  const unreadStmt = db.prepare("SELECT COUNT(*) c FROM messages WHERE from_user = ? AND to_user = ? AND read_at IS NULL");
  const list = others.map(u => {
    const last = lastStmt.get(meId, u.id, u.id, meId);
    return Object.assign(A.userPublic(u), {
      unread: unreadStmt.get(u.id, meId).c,
      last: last ? { text: last.text || (last.attachment ? "[附件]" : ""), t: last.created_at,
        fromMe: last.from_user === meId } : null
    });
  });
  // 有聊天记录的按最后消息时间排前面，其余按姓名
  list.sort((a, b) => {
    if (a.last && b.last) return b.last.t - a.last.t;
    if (a.last) return -1;
    if (b.last) return 1;
    return a.name.localeCompare(b.name, "zh");
  });
  res.json(list);
});

// 未读总数（用于导航红点轮询）
router.get("/chat/unread", (req, res) => {
  const rows = db.prepare("SELECT from_user, COUNT(*) c FROM messages WHERE to_user = ? AND read_at IS NULL GROUP BY from_user")
    .all(req.user.id);
  const byUser = {};
  let total = 0;
  rows.forEach(r => { byUser[r.from_user] = r.c; total += r.c; });
  res.json({ total, byUser });
});

// 与某人的对话（打开即把对方发来的消息标记为已读）
router.get("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  const other = db.prepare("SELECT * FROM users WHERE id = ? AND deleted = 0").get(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  db.prepare("UPDATE messages SET read_at = ? WHERE from_user = ? AND to_user = ? AND read_at IS NULL")
    .run(Date.now(), otherId, meId);
  const msgs = db.prepare(`SELECT * FROM messages
      WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
      ORDER BY created_at ASC`).all(meId, otherId, otherId, meId);
  res.json({
    contact: A.userPublic(other),
    messages: msgs.map(m => ({ id: m.id, text: m.text, t: m.created_at, fromMe: m.from_user === meId,
      attachment: m.attachment ? JSON.parse(m.attachment) : null }))
  });
});

router.post("/chat/with/:userId", (req, res) => {
  const meId = req.user.id, otherId = req.params.userId;
  if (otherId === meId) return res.status(400).json({ error: "不能给自己发消息" });
  const other = db.prepare("SELECT id FROM users WHERE id = ? AND deleted = 0").get(otherId);
  if (!other) return res.status(404).json({ error: "该同事不存在或已离职" });
  const text = String((req.body || {}).text || "").trim();
  const att = (req.body || {}).attachment || null;
  if (!text && !att) return res.status(400).json({ error: "消息不能为空" });
  if (text.length > 2000) return res.status(400).json({ error: "消息太长了" });
  db.prepare("INSERT INTO messages(id,from_user,to_user,text,attachment,created_at,read_at) VALUES(?,?,?,?,?,?,NULL)")
    .run(uid(), meId, otherId, text, att ? JSON.stringify(att) : null, Date.now());
  res.json({ ok: true });
});

/* ---------- 某员工的历史打卡（本人或管理员可看） ---------- */
router.get("/users/:id/logs", (req, res) => {
  const targetId = req.params.id;
  if (targetId !== req.user.id && req.user.role !== "admin")
    return res.status(403).json({ error: "只能查看自己的打卡记录" });
  const fields = getSetting("fields", { order: [], production: [] });
  const logFs = [...fields.order, ...fields.production].filter(f => f.type === "log");
  const rows = [];
  allOrdersPublic().forEach(o => {
    const tag = { styleNo: o.values.styleNo || "", styleName: o.values.styleName || "", orderId: o.id };
    logFs.forEach(f => (o.logs[f.k] || []).forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: f.label, text: e.text, t: e.t }, tag));
    }));
    (o.subs || []).forEach(sub => sub.log.forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: "加工厂·" + (sub.factory || sub.name), text: e.text, t: e.t }, tag));
    }));
    o.followIssues.forEach(e => {
      if (e.by === targetId) rows.push(Object.assign({ label: "跟单问题", text: e.text, t: e.t }, tag));
    });
    o.inspections.forEach(g => {
      if (g.by === targetId) rows.push(Object.assign({ label: "验货记录", text: g.items.map(i => i.problem).join("；"), t: g.t }, tag));
    });
  });
  rows.sort((a, b) => b.t - a.t);
  res.json(rows);
});

/* ---------- 款式图上传 ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, uid() + (path.extname(file.originalname || "").toLowerCase() || ".jpg"))
});
const upload = multer({
  storage, limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});
router.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择图片文件" });
  res.json({ url: "/uploads/" + req.file.filename });
});

/* ---------- 聊天附件：图片和常见办公文件 ---------- */
const OK_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic",
  ".pdf", ".xlsx", ".xls", ".csv", ".doc", ".docx", ".ppt", ".pptx", ".txt", ".zip"];
const chatUpload = multer({
  storage, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, OK_EXT.includes(path.extname(file.originalname || "").toLowerCase()))
});
router.post("/chat/upload", chatUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "不支持的文件类型，或文件超过 20MB" });
  const name = Buffer.from(req.file.originalname || "文件", "latin1").toString("utf8");
  res.json({
    url: "/uploads/" + req.file.filename,
    name, size: req.file.size,
    isImage: /^image\//.test(req.file.mimetype)
  });
});

/* ---------- 导入：解析上传的 Excel / CSV ----------
 * 直接支持 .xlsx/.xls，不用再另存为 CSV；
 * CSV 先按 UTF-8 解，出现乱码字符时自动改用 GBK
 *（Windows 版 Excel「另存为 CSV」默认就是 GBK，不处理会中文全乱码）。
 */
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const IMPORT_EXT = [".xlsx", ".xls", ".csv", ".txt"];

router.post("/import/parse", memUpload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "请选择文件" });
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  if (!IMPORT_EXT.includes(ext))
    return res.status(400).json({ error: "只支持 Excel(.xlsx/.xls) 和 CSV(.csv/.txt) 文件" });

  let wb, encoding = "UTF-8";
  try {
    if (ext === ".xlsx" || ext === ".xls") {
      wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true, dateNF: "yyyy-mm-dd" });
      encoding = "Excel";
    } else {
      let text = new TextDecoder("utf-8").decode(req.file.buffer);
      if (text.includes("\uFFFD")) {                       // 有乱码字符 -> 多半是 GBK
        try { text = new TextDecoder("gbk").decode(req.file.buffer); encoding = "GBK"; } catch (e) { }
      }
      wb = XLSX.read(text, { type: "string", cellDates: true, dateNF: "yyyy-mm-dd" });
    }
  } catch (e) {
    return res.status(400).json({ error: "文件解析失败，请确认是有效的 Excel 或 CSV" });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ error: "表格里没有内容" });
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" })
    .map(r => r.map(c => (c == null ? "" : String(c).trim())))
    .filter(r => r.some(c => c !== ""));
  if (rows.length < 2) return res.status(400).json({ error: "至少需要表头和一行数据" });
  res.json({ rows, sheet: wb.SheetNames[0], encoding });
});

/* ---------- 导出 Excel（管理员）---------- */
router.get("/export", A.adminRequired, (req, res) => {
  const fields = getSetting("fields", { order: [], production: [] });
  const users = db.prepare("SELECT id,name FROM users").all();
  const nameOf = id => (users.find(u => u.id === id) || {}).name || id || "";
  const cols = [...fields.order, ...fields.production];
  const header = ["季节", ...cols.map(f => f.label)];
  const rows = allOrdersPublic().map(o => [o.season, ...cols.map(f => {
    if (f.type === "log") {
      const arr = (o.logs[f.k] || []).slice().sort((a, b) => b.t - a.t);
      const l = arr[0];
      return l ? `${l.text}（${l.byName} ${new Date(l.t).toLocaleString("zh-CN")}）` : "";
    }
    if (f.type === "image") return o.values.img ? "（有图）" : "";
    if (f.type === "user-sales" || f.type === "user-follower") return nameOf(o.values[f.k]);
    return o.values[f.k] || "";
  })]);
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "订单");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fname = `订单导出-${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

module.exports = router;
