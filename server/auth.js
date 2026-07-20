"use strict";
/**
 * 认证与权限：
 *  - 密码用 bcrypt 加盐哈希（不存明文）
 *  - 登录后签发 JWT，前端每次请求带 Authorization: Bearer <token>
 *  - 权限在服务端强制校验（前端只是隐藏按钮，真正的拦截在这里）
 */
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { db, getSetting, DATA_DIR } = require("./db");

// JWT 密钥：优先环境变量，否则在 data 目录生成并持久化（重启后 token 不失效）
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const p = path.join(DATA_DIR, ".jwt_secret");
  try { return fs.readFileSync(p, "utf8"); }
  catch (e) {
    const s = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(p, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const hashPassword = (pw) => bcrypt.hashSync(String(pw), 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(String(pw), hash);
// 不设过期时间：只要用户不主动退出，登录状态一直保持。
// 账号被管理员删除时 authRequired 会当场拦下，所以不会留下"删了还能用"的口子。
const signToken = (user) => jwt.sign({ id: user.id }, SECRET);

/**
 * 职位 -> 权限模板。管理员固定为 admin；其余职位（含管理员自定义的）
 * 由 settings.roles 里的 template 决定用「业务员」还是「下厂员」那套权限。
 * 查不到的职位一律按最小权限(follower)处理，避免权限真空。
 */
function roleTemplate(roleKey) {
  if (roleKey === "admin") return "admin";
  const r = getSetting("roles", []).find(x => x.k === roleKey);
  return r ? r.template : "follower";
}
const templateOf = u => (u ? roleTemplate(u.role) : null);
function roleLabel(roleKey) {
  if (roleKey === "admin") return "管理员";
  const r = getSetting("roles", []).find(x => x.k === roleKey);
  return r ? r.label : roleKey;
}

function userPublic(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, role: u.role,
    roleLabel: roleLabel(u.role), template: roleTemplate(u.role), deleted: !!u.deleted };
}
const userById = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);

// 中间件：要求已登录，把当前用户挂到 req.user
function authRequired(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "未登录" });
  try {
    const payload = jwt.verify(token, SECRET);
    const u = userById(payload.id);
    if (!u || u.deleted) return res.status(401).json({ error: "账号不存在或已被删除" });
    req.user = u;
    next();
  } catch (e) {
    return res.status(401).json({ error: "登录已失效，请重新登录" });
  }
}

// 中间件：要求管理员
function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "仅管理员可操作" });
  next();
}

/* ---------- 权限判定（与前端保持一致，但以此处为准） ---------- */
const isAdmin = (u) => u && u.role === "admin";
// 能否编辑订单基本信息：管理员，或（业务员且是本单创建人/所属业务员）
function canEditBasic(u, order) {
  if (!u) return false;
  if (u.role === "admin") return true;
  return templateOf(u) === "sales" && (order.created_by === u.id || (order.data.values || {}).sales === u.id);
}
// 能否在某板块打卡：管理员；本单负责下厂员；订单明细板块业务员本人也可更新进度
function canAddLog(u, order, section) {
  if (!u) return false;
  if (u.role === "admin") return true;
  if ((order.data.values || {}).follower === u.id) return true;
  if (section === "order" && canEditBasic(u, order)) return true;
  return false;
}
// 能否修改/删除某条记录：管理员或本人
const canTouchEntry = (u, entry) => u && (u.role === "admin" || entry.by === u.id);

module.exports = {
  hashPassword, verifyPassword, signToken, userPublic, userById,
  authRequired, adminRequired, isAdmin, canEditBasic, canAddLog, canTouchEntry,
  roleTemplate, templateOf, roleLabel
};
