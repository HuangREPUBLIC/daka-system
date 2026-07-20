"use strict";
/**
 * 数据层：使用 Node 内置的 node:sqlite（Node 22+），无需编译原生依赖。
 * 存储策略（<100 人规模，简单可靠）：
 *   - users     账号（登录、权限判定需要按手机号查，用独立列）
 *   - settings  键值表，存自定义字段(fields) 与工厂下拉(factories) 的 JSON
 *   - orders    每个订单一行，业务数据(values/logs/subs/inspections/followIssues) 存 JSON
 * 时间统一用毫秒时间戳(Date.now())。
 */
const { DatabaseSync } = require("node:sqlite");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// 数据目录可通过环境变量 DATA_DIR 指定（方便部署时挂载到独立磁盘/数据卷）
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "daka.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_active ON users(phone) WHERE deleted = 0;
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_user, to_user, created_at);
  CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(to_user, read_at);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    season TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
`);

const uid = () => crypto.randomBytes(9).toString("base64url");

/* ---------- settings 帮助函数 ---------- */
function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, JSON.stringify(value));
}

/* ---------- 首次运行填充演示数据 ---------- */
function seedIfEmpty() {
  const n = db.prepare("SELECT COUNT(*) c FROM users").get().c;
  if (n > 0) return;

  const now = Date.now();
  const mkUser = (name, phone, role) => {
    const id = uid();
    db.prepare("INSERT INTO users(id,name,phone,password_hash,role,deleted,created_at) VALUES(?,?,?,?,?,0,?)")
      .run(id, name, phone, bcrypt.hashSync("123456", 10), role, now);
    return id;
  };
  const boss = mkUser("老板", "13800000000", "admin");
  const s1 = mkUser("陈晓芳", "13811112222", "sales");
  const s2 = mkUser("林志远", "13833334444", "sales");
  const f1 = mkUser("王建国", "13855556666", "follower");
  const f2 = mkUser("刘敏", "13877778888", "follower");
  const nameOf = { [boss]: "老板", [s1]: "陈晓芳", [s2]: "林志远", [f1]: "王建国", [f2]: "刘敏" };

  // 职位：label 可自由命名，template 决定权限（sales=业务员权限，follower=下厂员权限）
  setSetting("roles", [
    { k: "sales", label: "业务员", template: "sales", core: true },
    { k: "follower", label: "下厂员", template: "follower", core: true }
  ]);
  setSetting("factories", {
    emb: ["锦绣绣花厂", "华艺印花厂", "美达绣印"],
    prod: ["宏发制衣厂", "联诚服装厂", "永盛制衣"],
    proc: ["宏发制衣厂", "联诚服装厂", "永盛制衣", "新星加工厂", "汇丰加工厂"]
  });
  setSetting("fields", {
    order: [
      { k: "sales", label: "业务员", type: "user-sales", core: true },
      { k: "styleNo", label: "货号", type: "text" },
      { k: "img", label: "款式图", type: "image" },
      { k: "styleName", label: "款式名", type: "text" },
      { k: "style", label: "款式", type: "text" },
      { k: "qty", label: "数量", type: "number" },
      { k: "desc", label: "款式描述", type: "textarea" },
      { k: "deadline", label: "订单交期", type: "date" },
      { k: "fabric", label: "面料", type: "text" },
      { k: "fabricProg", label: "面料进度", type: "log" },
      { k: "embProg", label: "绣印进度", type: "log" },
      { k: "embFactory", label: "绣印工厂", type: "factory-emb" }
    ],
    production: [
      { k: "follower", label: "下厂员", type: "user-follower", core: true },
      { k: "factory", label: "生产厂", type: "factory-prod" },
      { k: "preSample", label: "产前样进度", type: "log" },
      { k: "cutting", label: "裁剪进度", type: "log" },
      { k: "ironing", label: "整烫进度", type: "log" },
      { k: "packing", label: "包装进度", type: "log" },
      { k: "shipDate", label: "发货日期", type: "date" }
    ]
  });

  const T = (d, h, m) => new Date(2026, 6, d, h, m).getTime();
  const L = (by, d, h, m, text) => ({ id: uid(), by, byName: nameOf[by], t: T(d, h, m), text });
  const emptyLogs = () => ({ fabricProg: [], embProg: [], preSample: [], cutting: [], ironing: [], packing: [] });
  const insertOrder = (season, createdBy, values, logs, subs, inspections, followIssues) => {
    db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
      .run(uid(), season, createdBy, T(1, 9, 0), now,
        JSON.stringify({ values, logs: Object.assign(emptyLogs(), logs), subs, inspections, followIssues }));
  };

  insertOrder("SS2027", s1,
    { sales: s1, styleNo: "SS27-T012", styleName: "女装印花短袖T恤", style: "圆领短袖", qty: "3200",
      desc: "32支精梳棉，前胸水浆印花，领口撞色包边", deadline: "2026-08-15", fabric: "32支精梳棉汗布 180g",
      embFactory: "华艺印花厂", follower: f1, factory: "宏发制衣厂", shipDate: "" },
    { fabricProg: [L(s1, 8, 10, 20, "面料已下机染色，预计12日到仓"), L(f1, 13, 9, 5, "面料到仓 2860kg，已验布，色差合格")],
      embProg: [L(f1, 15, 14, 30, "印花版已确认，16日上机")],
      preSample: [L(f1, 5, 16, 0, "产前样已寄客户，等确认意见")],
      cutting: [L(f1, 17, 8, 40, "已开裁，2张裁床，预计19日裁完"), L(f1, 19, 17, 10, "裁剪完成，共3250件裁片，含备损")] },
    [ { name: "主厂", factory: "宏发制衣厂", log: [L(f1, 19, 17, 30, "车缝上线2条，日产约400件")] },
      { name: "加工厂2", factory: "新星加工厂", log: [] },
      { name: "加工厂3", factory: "", log: [] },
      { name: "加工厂4", factory: "", log: [] } ],
    [ { id: uid(), date: "2026-07-18", by: f1, byName: "王建国", t: T(18, 15, 0),
        items: [{ problem: "首件肩缝有轻微起皱", fix: "已调整缝纫机张力，返修3件后正常" }] } ],
    [ { id: uid(), by: s1, byName: "陈晓芳", t: T(16, 11, 20), text: "客户要求包装改用平铺装，每箱40件，已通知工厂" } ]
  );

  insertOrder("SS2027", s2,
    { sales: s2, styleNo: "SS27-D031", styleName: "碎花吊带连衣裙", style: "连衣裙", qty: "1800",
      desc: "全棉印花梭织布，腰部松紧，裙摆压褶", deadline: "2026-08-28", fabric: "全棉60支印花梭织布",
      embFactory: "美达绣印", follower: f2, factory: "联诚服装厂", shipDate: "" },
    { fabricProg: [L(s2, 14, 9, 30, "坯布已进印花厂，预计20日出成品布")],
      preSample: [L(f2, 17, 10, 15, "产前样制作中，预计21日完成")] },
    [ { name: "主厂", factory: "联诚服装厂", log: [] },
      { name: "加工厂2", factory: "", log: [] },
      { name: "加工厂3", factory: "", log: [] },
      { name: "加工厂4", factory: "", log: [] } ],
    [], []
  );

  insertOrder("FW2026", s1,
    { sales: s1, styleNo: "FW26-J105", styleName: "男装连帽夹克", style: "夹克外套", qty: "2600",
      desc: "尼龙面料防泼水，前胸绣花logo，双层帽", deadline: "2026-07-30", fabric: "300T尼龙桃皮绒",
      embFactory: "锦绣绣花厂", follower: f1, factory: "永盛制衣", shipDate: "2026-07-28" },
    { fabricProg: [L(s1, 1, 10, 0, "面料6月28日已全部到仓")],
      embProg: [L(f1, 3, 15, 0, "绣花片已回厂，数量核对无误")],
      preSample: [L(f1, 2, 9, 0, "产前样客户已确认")],
      cutting: [L(f1, 6, 8, 30, "裁剪完成")],
      ironing: [L(f1, 16, 14, 0, "大烫进行中，已完成约60%"), L(f1, 19, 16, 40, "整烫全部完成")],
      packing: [L(f1, 19, 18, 0, "开始包装，预计22日完成，每箱30件")] },
    [ { name: "主厂", factory: "永盛制衣", log: [L(f1, 10, 9, 0, "车缝完成，尾查中")] },
      { name: "加工厂2", factory: "汇丰加工厂", log: [L(f1, 8, 9, 0, "加工厂800件已完成回厂")] },
      { name: "加工厂3", factory: "", log: [] },
      { name: "加工厂4", factory: "", log: [] } ],
    [ { id: uid(), date: "2026-07-12", by: f1, byName: "王建国", t: T(12, 14, 0),
        items: [ { problem: "拉链头个别拉合不顺", fix: "供应商已换新拉链头，全检更换" },
                 { problem: "帽绳长短不一约20件", fix: "已返工统一长度" } ] } ],
    [ { id: uid(), by: boss, byName: "老板", t: T(13, 8, 50), text: "此单交期紧，包装完成后立即安排出货，物流已订" } ]
  );

  console.log("[db] 已填充演示数据（管理员 13800000000 / 密码 123456）");
}

module.exports = { db, uid, getSetting, setSetting, seedIfEmpty, DATA_DIR, UPLOAD_DIR };
