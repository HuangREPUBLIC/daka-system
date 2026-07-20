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
  if (!["sales", "follower"].includes(role)) return res.status(400).json({ error: "角色只能是业务员或下厂员" });
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
    if (!["sales", "follower"].includes(role)) return res.status(400).json({ error: "角色只能是业务员或下厂员" });
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
function canCreateOrder(u) { return u.role === "admin" || u.role === "sales"; }

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
