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

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
