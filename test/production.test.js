/** 生产进度(主厂/动态加工点) + 验货问题(发现问题/整改情况分权限) 的后端测试 */
const BASE = (process.env.BASE_URL || "http://localhost:3000") + "/api";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
async function call(m, p, t, b) {
  const h = { "Content-Type": "application/json" }; if (t) h.Authorization = "Bearer " + t;
  const r = await fetch(BASE + p, { method: m, headers: h, body: b ? JSON.stringify(b) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { }
  return { status: r.status, j };
}
(async () => {
  const aT = (await call("POST", "/login", null, { phone: "13800000000", password: "123456" })).j.token;
  const sT = (await call("POST", "/login", null, { phone: "13811112222", password: "123456" })).j.token; // 陈晓芳 sales
  const fT = (await call("POST", "/login", null, { phone: "13855556666", password: "123456" })).j.token; // 王建国 follower(负责 o1)
  const f2T = (await call("POST", "/login", null, { phone: "13877778888", password: "123456" })).j.token; // 刘敏 follower(负责 o2，与 o1 无关)

  const boot = (await call("GET", "/bootstrap", aT)).j;
  ok(boot.fields.order.some(f => f.k === "fabricFactory" && f.type === "factory-fabric"), "订单字段含面料工厂(fabricFactory)");
  ok(!boot.fields.order.some(f => f.k === "fabric"), "旧「面料」文本字段已移除");
  ok(boot.factories.fabric && boot.factories.fabric.length >= 1, "factories.fabric 存在");
  const o1 = boot.orders.find(o => o.values.styleNo === "SS27-T012");
  ok(Array.isArray(o1.mainLog) && o1.mainLog.length === 1, "种子数据: 主厂(mainLog)有历史打卡");
  ok(Array.isArray(o1.subs) && o1.subs.length === 1 && o1.subs[0].name.includes("加工点1"), "种子数据: 动态加工点已生成");
  ok(o1.inspections[0].items[0].fix && o1.inspections[0].items[0].fixBy, "种子数据: 验货记录已含 problem+fix");

  // ---- 主厂打卡(mainLog)：权限与生产明细打卡一致 ----
  ok((await call("POST", `/orders/${o1.id}/logs`, fT, { key: "mainLog", text: "主厂新打卡" })).status === 200, "本单下厂员在主厂(mainLog)打卡");
  ok((await call("POST", `/orders/${o1.id}/logs`, sT, { key: "mainLog", text: "越权" })).status === 403, "业务员不能在主厂打卡");
  ok((await call("POST", `/orders/${o1.id}/logs`, f2T, { key: "mainLog", text: "越权2" })).status === 403, "非本单下厂员不能在主厂打卡");

  // ---- 加工点：下厂员自己决定加/改名/打卡，只有管理员能删 ----
  const addSub = await call("POST", `/orders/${o1.id}/subs`, fT, { name: "加工点2（临时外发）" });
  ok(addSub.status === 200 && addSub.j.subs.length === 2, "下厂员新增加工点，无需管理员预配置");
  ok((await call("POST", `/orders/${o1.id}/subs`, sT, { name: "业务员想加" })).status === 403, "非本单下厂员/业务员不能加加工点");
  const subId = addSub.j.subs[1].id;
  ok((await call("PATCH", `/orders/${o1.id}/subs/${subId}`, fT, { name: "改名后的加工点" })).status === 200, "下厂员改加工点名称");
  ok((await call("POST", `/orders/${o1.id}/logs`, fT, { key: "sub:" + subId, text: "在动态加工点打卡" })).status === 200, "在新加的加工点打卡");
  ok((await call("DELETE", `/orders/${o1.id}/subs/${subId}`, fT)).status === 403, "非管理员不能删加工点");
  ok((await call("DELETE", `/orders/${o1.id}/subs/${subId}`, aT)).status === 200, "管理员可以删加工点");

  // ---- 验货：发现问题(业务员/管理员) vs 整改情况(本单负责下厂员/管理员) 严格分离 ----
  const cp = await call("POST", `/orders/${o1.id}/inspections`, sT, { problems: ["新验货问题A", "新验货问题B"] });
  ok(cp.status === 200, "业务员一次创建验货批次(可含多条发现问题)");
  const batch = cp.j.inspections[cp.j.inspections.length - 1];
  ok(batch.items.length === 2 && !batch.items[0].fix, "批次含2条item，整改情况留空待填");
  ok(cp.j.inspections.every(g => g.date === undefined), "验货批次不再有手动日期字段，靠服务器时间 t");
  ok((await call("POST", `/orders/${o1.id}/inspections`, fT, { problems: ["下厂员想写"] })).status === 403, "下厂员不能创建「发现问题」");
  const itemId = batch.items[0].id;
  ok((await call("PATCH", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}`, sT, { problem: "改过的问题" })).status === 200, "业务员可修改发现的问题");
  ok((await call("PATCH", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}`, fT, { problem: "下厂员想改" })).status === 403, "下厂员不能改「发现问题」");
  ok((await call("PATCH", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}`, fT, { fix: "整改好了" })).status === 200, "本单下厂员可填「整改情况」");
  ok((await call("PATCH", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}`, sT, { fix: "业务员想写fix" })).status === 403, "业务员不能填「整改情况」");
  ok((await call("PATCH", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}`, f2T, { fix: "无关下厂员" })).status === 403, "非本单下厂员不能填「整改情况」");

  // ---- 补充说明：双方都能加，累积不覆盖 ----
  ok((await call("POST", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}/notes`, sT, { text: "补充说明1" })).status === 200, "业务员可加补充说明");
  ok((await call("POST", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}/notes`, fT, { text: "补充说明2" })).status === 200, "下厂员可加补充说明");
  ok((await call("POST", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}/notes`, f2T, { text: "无关下厂员" })).status === 403, "无关下厂员不能加补充说明");
  const after = (await call("GET", `/orders/${o1.id}`, aT)).j;
  const finalItem = after.inspections.find(b => b.id === batch.id).items.find(i => i.id === itemId);
  ok(finalItem.notes.length === 2, "补充说明累计2条，互不覆盖");
  ok(finalItem.problem === "改过的问题" && finalItem.fix === "整改好了", "problem/fix 各自的修改都正确保存");

  // ---- 边界 ----
  ok((await call("POST", `/orders/${o1.id}/inspections`, sT, {})).status === 400, "空提交仍报错(无问题也无照片)");
  ok((await call("PATCH", `/orders/${o1.id}/inspections/${batch.id}/items/${itemId}`, sT, {})).status === 400, "PATCH 不传字段报错");

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
