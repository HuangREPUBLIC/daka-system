/** 升级测试：老版本建的数据库（没有职位配置）升级后要能自动补齐 */
const { spawnSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "daka-migrate-"));
const dbPath = path.join(__dirname, "..", "server", "db.js");

// 1) 先建一个库（模拟已经在用的老库），然后把 roles 配置删掉
let r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  d.db.prepare("DELETE FROM settings WHERE key = 'roles'").run();
  console.log(JSON.stringify(d.getSetting("roles", null)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
ok(r.status === 0 && r.stdout.trim().endsWith("null"), "模拟出缺少职位配置的老库");

// 2) 再次启动（走 ensureDefaults）应自动补齐
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  d.ensureDefaults();
  const roles = d.getSetting("roles", null);
  console.log(JSON.stringify(roles && roles.map(x => x.k)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
const out = (r.stdout.trim().split("\n").pop() || "");
ok(r.status === 0 && out.includes("sales") && out.includes("follower"), "升级后自动补齐内置职位");

// 3) 已有数据不能被覆盖
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.setSetting("roles", [{k:"sales",label:"业务员",template:"sales",core:true},
                         {k:"r1",label:"跟单主管",template:"sales"}]);
  d.ensureDefaults();
  console.log(JSON.stringify(d.getSetting("roles", []).map(x => x.label)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
ok(r.stdout.includes("跟单主管"), "已有职位配置不会被覆盖");

// 4) 老库的「面料」文本字段要能自动换成「面料工厂」下拉，且不影响管理员自己加的字段
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  const fields = d.getSetting("fields", { order: [], production: [] });
  fields.order = fields.order.filter(f => f.k !== "fabricFactory");
  fields.order.splice(fields.order.findIndex(f => f.k === "embFactory"), 0, { k: "fabric", label: "面料", type: "text" });
  fields.order.push({ k: "custom1", label: "管理员自定义字段", type: "text" });
  d.setSetting("fields", fields);
  d.ensureDefaults();
  const after = d.getSetting("fields", { order: [] }).order;
  console.log(JSON.stringify(after.map(f => f.k)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
const migrated = (r.stdout.trim().split("\n").pop() || "");
ok(r.status === 0 && migrated.includes("fabricFactory") && !migrated.includes('"fabric"'), "老库「面料」自动换成「面料工厂」");
ok(migrated.includes("custom1"), "迁移过程不影响管理员自己加的字段");
const keys = JSON.parse(migrated);
ok(keys.indexOf("fabricFactory") < keys.indexOf("embFactory"), "面料工厂排在绣印工厂前面");

// 5) 老结构的订单（subs 是固定4条、无 id；inspections 用 date+items 无 id）
//    要能安全迁移到新的"生产进度(mainLog+动态加工点)"/"验货问题(id化)"结构，且可重复运行
const legacyOrder = {
  values: { styleNo: "FA9926", styleName: "MACU", factory: "滨州英氏" },
  logs: {},
  subs: [
    { name: "主厂", factory: "", log: [{ id: "e1", by: "u1", byName: "老板", t: 1785053131921, text: "上衣下500，裤子下车200条", photos: [] }] },
    { name: "加工厂2", factory: "", log: [{ id: "e2", by: "u1", byName: "老板", t: 1785054735481, text: "", photos: ["/uploads/x.jpg"] }] },
    { name: "加工厂3", factory: "", log: [] },
    { name: "加工厂4", factory: "", log: [] }
  ],
  inspections: [{ id: "g1", date: "2026-07-26", by: "u1", byName: "老板", t: 1785057640886,
    items: [{ problem: "裤腰吃抻不匀", fix: "" }], photos: ["/uploads/y.jpg"] }],
  followIssues: []
};
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  d.db.prepare("DELETE FROM orders").run();
  d.db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run("legacy1", "SS2026", "u1", 1, 1, JSON.stringify(${JSON.stringify(legacyOrder)}));
  d.ensureDefaults();
  d.ensureDefaults();
  console.log(d.db.prepare("SELECT data FROM orders WHERE id='legacy1'").get().data);
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
ok(r.status === 0, "老结构订单迁移两次都不报错(幂等)");
const migratedOrder = JSON.parse((r.stdout.trim().split("\n").pop() || "{}"));
ok(Array.isArray(migratedOrder.mainLog) && migratedOrder.mainLog.length === 1
  && migratedOrder.mainLog[0].text.includes("上衣下500"), "老「主厂」打卡记录挪进 mainLog，内容不丢");
ok(!migratedOrder.subs.some(s => s.name === "主厂"), "subs 里不再重复出现「主厂」");
ok(migratedOrder.subs.length === 1 && migratedOrder.subs[0].name === "加工厂2" && !!migratedOrder.subs[0].id, "有真实打卡的加工点保留且补上 id");
ok(!migratedOrder.subs.some(s => s.name === "加工厂3" || s.name === "加工厂4"), "从未使用的默认占位加工点被清掉");
const migratedItem = migratedOrder.inspections[0].items[0];
ok(migratedOrder.inspections[0].date === undefined, "验货记录不再有 date 字段");
ok(!!migratedItem.id && migratedItem.problemBy === "u1" && Array.isArray(migratedItem.notes), "验货 item 补上 id/问题作者/补充说明数组");

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
