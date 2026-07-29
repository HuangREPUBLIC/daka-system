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

// 4) 老库的「面料」文本字段要能自动链式换成「面料工厂1」「面料工厂2」，且不影响管理员自己加的字段
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  const fields = d.getSetting("fields", { order: [], production: [] });
  fields.order = fields.order.filter(f => f.k !== "fabricFactory1" && f.k !== "fabricFactory2");
  fields.order.splice(fields.order.findIndex(f => f.k === "embFactory"), 0, { k: "fabric", label: "面料", type: "text" });
  fields.order.push({ k: "custom1", label: "管理员自定义字段", type: "text" });
  d.setSetting("fields", fields);
  d.ensureDefaults();
  const after = d.getSetting("fields", { order: [] }).order;
  console.log(JSON.stringify(after.map(f => f.k)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
const migrated = (r.stdout.trim().split("\n").pop() || "");
ok(r.status === 0 && migrated.includes('"fabricFactory1"') && migrated.includes('"fabricFactory2"') && !migrated.includes('"fabric"') && !migrated.includes('"fabricFactory"'),
  "老库「面料」自动链式换成「面料工厂1」「面料工厂2」，不残留旧的单一 fabricFactory");
ok(migrated.includes("custom1"), "迁移过程不影响管理员自己加的字段");
const keys = JSON.parse(migrated);
ok(keys.indexOf("fabricFactory1") < keys.indexOf("embFactory"), "面料工厂1排在绣印工厂前面");

// 4b) 已经在用单一「面料工厂」字段(本次拆分前的真实老库状态) 的库，升级后要能正确拆分成 面料工厂1/2，
//     绣印工厂改名绣花工厂+新增印花工厂，生产厂改名服装工厂；已有订单数据不丢，且可重复运行(幂等)
const preSplitFields = { order: [
  { k: "sales", label: "业务员", type: "user-sales", core: true },
  { k: "styleNo", label: "货号", type: "text" },
  { k: "factory", label: "生产厂", type: "factory-prod" },
  { k: "fabricFactory", label: "面料工厂", type: "factory-fabric" },
  { k: "embFactory", label: "绣印工厂", type: "factory-emb" }
], production: [] };
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  d.setSetting("fields", ${JSON.stringify(preSplitFields)});
  d.db.prepare("DELETE FROM orders").run();
  d.db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run("presplit1", "SS2026", "u1", 1, 1, JSON.stringify({
      values: { styleNo: "PS-1", factory: "宏发制衣厂", fabricFactory: ["恒信面料行"], embFactory: ["华艺印花厂"] },
      logs: {}, mainLog: [], subs: [], inspections: [], followIssues: [] }));
  d.ensureDefaults();
  d.ensureDefaults();
  const fo = d.getSetting("fields", { order: [] }).order;
  const row = JSON.parse(d.db.prepare("SELECT data FROM orders WHERE id='presplit1'").get().data);
  console.log(JSON.stringify({ fieldKeys: fo.map(f => f.k), factoryLabel: fo.find(f=>f.k==="factory").label,
    embLabel: fo.find(f=>f.k==="embFactory").label, values: row.values }));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
ok(r.status === 0, "老库(单一fabricFactory字段)升级两次都不报错(幂等)");
const presplitOut = JSON.parse((r.stdout.trim().split("\n").pop() || "{}"));
ok(presplitOut.fieldKeys.includes("fabricFactory1") && presplitOut.fieldKeys.includes("fabricFactory2") && !presplitOut.fieldKeys.includes("fabricFactory"),
  "已有的单一「面料工厂」字段升级后拆分为「面料工厂1」「面料工厂2」");
ok(presplitOut.fieldKeys.includes("printFactory"), "升级后新增「印花工厂」字段");
ok(presplitOut.factoryLabel === "服装工厂", "「生产厂」标签升级后改名「服装工厂」");
ok(presplitOut.embLabel === "绣花工厂", "「绣印工厂」标签升级后改名「绣花工厂」");
ok(Array.isArray(presplitOut.values.fabricFactory1) && presplitOut.values.fabricFactory1[0] === "恒信面料行" && presplitOut.values.fabricFactory === undefined,
  "已有订单的面料工厂数据整体搬进 fabricFactory1，不丢失");
ok(Array.isArray(presplitOut.values.embFactory) && presplitOut.values.embFactory[0] === "华艺印花厂",
  "已有订单的绣印工厂数据保留在 embFactory(现「绣花工厂」)，不受影响");

// 4c) 撤回实验：已经部署过"服装工厂旁边加生产工序/车工人数/预计下车时间"这一版的库(生产服务器的真实状态)，
//     升级后要能把这三个字段从 fields.order 里清掉，恢复成没有这三项的样子，且可重复运行(幂等)
const withMainFields = { order: [
  { k: "sales", label: "业务员", type: "user-sales", core: true },
  { k: "styleNo", label: "货号", type: "text" },
  { k: "factory", label: "服装工厂", type: "factory-prod" },
  { k: "mainProcess", label: "生产工序", type: "text" },
  { k: "mainWorkers", label: "车工人数", type: "number" },
  { k: "mainEstDone", label: "预计下车时间", type: "date" }
], production: [] };
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  d.setSetting("fields", ${JSON.stringify(withMainFields)});
  d.ensureDefaults();
  d.ensureDefaults();
  console.log(JSON.stringify(d.getSetting("fields", { order: [] }).order.map(f => f.k)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
ok(r.status === 0, "撤回「服装工厂旁边三项字段」升级两次都不报错(幂等)");
const revertKeys = JSON.parse((r.stdout.trim().split("\n").pop() || "[]"));
ok(!revertKeys.includes("mainProcess") && !revertKeys.includes("mainWorkers") && !revertKeys.includes("mainEstDone"),
  "已部署的「服装工厂旁边」三项字段升级后被清除，恢复成本厂打卡时才填");
ok(revertKeys.includes("factory"), "服装工厂字段本身还在");

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

// 6) 老库没有季节配置：升级后要自动补齐，且把订单里实际用过、但不在默认年份区间内的季节也保留住
r = spawnSync(process.execPath, ["-e", `
  process.env.DATA_DIR = ${JSON.stringify(DATA_DIR)};
  const d = require(${JSON.stringify(dbPath)});
  d.seedIfEmpty();
  d.db.prepare("DELETE FROM settings WHERE key = 'seasons'").run();
  d.db.prepare("INSERT INTO orders(id,season,created_by,created_at,updated_at,data) VALUES(?,?,?,?,?,?)")
    .run("oldseason1", "SS2099", "u1", 1, 1, JSON.stringify({values:{},logs:{},mainLog:[],subs:[],inspections:[],followIssues:[]}));
  d.ensureDefaults();
  console.log(JSON.stringify(d.getSetting("seasons", null)));
`], { encoding: "utf8", env: Object.assign({}, process.env, { DATA_DIR }) });
const seasonsOut = JSON.parse((r.stdout.trim().split("\n").pop() || "null"));
ok(r.status === 0 && Array.isArray(seasonsOut) && seasonsOut.length > 0, "老库升级后自动补齐季节配置");
ok(seasonsOut.includes("SS2099"), "老订单实际用到的季节即使不在默认年份区间也被保留");

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
