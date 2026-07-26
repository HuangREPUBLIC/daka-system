const BASE = (process.env.BASE_URL || "http://localhost:3000") + "/api";
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
async function call(method, path, token, body) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, j };
}
(async () => {
  // login wrong
  ok((await call("POST", "/login", null, { phone: "13800000000", password: "x" })).status === 400, "错误密码拒绝");
  // admin login
  const adm = await call("POST", "/login", null, { phone: "13800000000", password: "123456" });
  ok(adm.status === 200 && adm.j.token, "管理员登录");
  const aT = adm.j.token, aId = adm.j.user.id;
  // bootstrap
  const boot = await call("GET", "/bootstrap", aT);
  ok(boot.status === 200 && boot.j.orders.length === 3 && boot.j.users.length === 5, "bootstrap 返回订单与用户");
  ok(boot.j.me.role === "admin", "me 是管理员");
  const orders = boot.j.orders, users = boot.j.users;
  const o1 = orders.find(o => o.values.styleNo === "SS27-T012");
  const wang = users.find(u => u.name === "王建国"), liu = users.find(u => u.name === "刘敏"), chen = users.find(u => u.name === "陈晓芳");

  // sales / follower login
  const sT = (await call("POST", "/login", null, { phone: "13811112222", password: "123456" })).j.token; // 陈晓芳
  const fT = (await call("POST", "/login", null, { phone: "13877778888", password: "123456" })).j.token; // 刘敏(负责 o2)

  // follower cannot log on o1 (归王建国)
  ok((await call("POST", `/orders/${o1.id}/logs`, fT, { key: "cutting", text: "非法" })).status === 403, "下厂员无权在别人订单打卡");
  // admin can log
  const al = await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "管理员打卡测试" });
  ok(al.status === 200 && al.j.logs.cutting.some(e => e.text === "管理员打卡测试" && e.byName === "老板"), "管理员打卡并自动记名");
  // sales(陈晓芳 创建 o1) can update order-section progress, but not production
  ok((await call("POST", `/orders/${o1.id}/logs`, sT, { key: "fabricProg", text: "业务员更新面料" })).status === 200, "业务员更新订单明细进度");
  ok((await call("POST", `/orders/${o1.id}/logs`, sT, { key: "ironing", text: "越权" })).status === 403, "业务员不能在生产明细打卡");
  // sales edit basic ok; follower cannot
  ok((await call("PATCH", `/orders/${o1.id}`, sT, { values: { fabric: "改过的面料" } })).status === 200, "业务员改自己订单基本信息");
  ok((await call("PATCH", `/orders/${o1.id}`, fT, { values: { fabric: "x" } })).status === 403, "下厂员不能改基本信息");

  // create order: follower forbidden, sales ok
  ok((await call("POST", "/orders", fT, { season: "SS2027", values: { styleNo: "X" } })).status === 403, "下厂员不能建单");
  const co = await call("POST", "/orders", sT, { season: "SS2027", values: { styleNo: "NEW-1", styleName: "新单" } });
  ok(co.status === 200 && co.j.values.sales === chen.id, "业务员建单并自动带上自己");

  // import
  const imp = await call("POST", "/orders/import", sT, { orders: [
    { season: "SS2027", values: { styleNo: "IMP-1", styleName: "导入甲", follower: wang.id } },
    { season: "SS2027", values: {} } ] });
  ok(imp.status === 200 && imp.j.imported === 1, "批量导入跳过空单");

  // ROLE CHANGE: admin can change others (王建国 follower -> sales), NOT self
  ok((await call("PATCH", `/users/${aId}`, aT, { role: "follower" })).status === 400, "不能改自己的职位");
  const rc = await call("PATCH", `/users/${wang.id}`, aT, { role: "sales" });
  ok(rc.status === 200 && rc.j.role === "sales", "管理员下拉改他人职位(下厂员→业务员)");
  await call("PATCH", `/users/${wang.id}`, aT, { role: "follower" }); // 改回
  // non-admin cannot change roles
  ok((await call("PATCH", `/users/${liu.id}`, sT, { role: "sales" })).status === 403, "业务员不能改职位");

  // user delete: cannot self, cannot admin; can others
  ok((await call("DELETE", `/users/${aId}`, aT)).status === 400, "不能删除自己");
  const newU = await call("POST", "/users", aT, { name: "临时工", phone: "13900008888", role: "follower" });
  ok(newU.status === 200, "创建员工");
  ok((await call("DELETE", `/users/${newU.j.id}`, aT)).status === 200, "删除员工(软删)");
  ok((await call("POST", "/login", null, { phone: "13900008888", password: "123456" })).status === 400, "被删员工无法登录");

  // custom field
  const cf = await call("POST", "/fields", aT, { section: "production", label: "吊牌进度", type: "log" });
  ok(cf.status === 200 && cf.j.production.some(f => f.label === "吊牌进度"), "新增自定义打卡字段");
  ok((await call("POST", "/fields", aT, { section: "production", label: "吊牌进度", type: "log" })).status === 400, "同名字段不能重复添加");

  // inspection + follow
  ok((await call("POST", `/orders/${o1.id}/inspections`, aT, { problems: ["P"] })).status === 200, "新增验货记录(业务员/管理员创建)");
  ok((await call("POST", `/orders/${o1.id}/follow`, aT, { text: "跟单问题测试" })).status === 200, "新增跟单问题");

  // ---- 照片 ----
  // 打卡带照片，且恶意/外部 URL 被过滤，只留 /uploads/ 路径
  const lp = await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "带图打卡",
    photos: ["/uploads/a1.jpg", "javascript:alert(1)", "https://evil.com/x.jpg", "/uploads/a2.jpg"] });
  const cutE = lp.j.logs.cutting.find(e => e.text === "带图打卡");
  ok(lp.status === 200 && cutE.photos.length === 2 && cutE.photos[0] === "/uploads/a1.jpg", "打卡照片保存且只留 /uploads/ 路径");
  // 只发照片、不写字也可以
  ok((await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "", photos: ["/uploads/only.jpg"] })).status === 200, "只发照片也能打卡");
  // 文字和照片都空则拒绝
  ok((await call("POST", `/orders/${o1.id}/logs`, aT, { key: "cutting", text: "", photos: [] })).status === 400, "文字照片都空被拒");
  // 编辑打卡只改文字，照片保留
  const eid = cutE.id;
  const ed = await call("PATCH", `/orders/${o1.id}/logs/cutting/${eid}`, aT, { text: "改了字" });
  const cutE2 = ed.j.logs.cutting.find(e => e.id === eid);
  ok(ed.status === 200 && cutE2.text === "改了字" && cutE2.photos.length === 2, "编辑打卡改字不丢照片");
  // 验货带照片；只发照片、不写发现问题也行
  ok((await call("POST", `/orders/${o1.id}/inspections`, aT, { problems: [], photos: ["/uploads/insp.jpg"] })).status === 200, "验货只加照片也能存");
  const ins = await call("GET", `/orders/${o1.id}`, aT);
  ok(ins.j.inspections.some(g => (g.photos || []).includes("/uploads/insp.jpg") && g.items.length === 0), "验货照片已保存(无问题条目)");
  // 跟单带照片
  const fl = await call("POST", `/orders/${o1.id}/follow`, aT, { text: "带图跟单", photos: ["/uploads/f1.jpg"] });
  ok(fl.status === 200 && fl.j.followIssues.some(e => e.text === "带图跟单" && (e.photos || []).includes("/uploads/f1.jpg")), "跟单照片已保存");
  // 款式图多图相册
  const alb = await call("POST", "/orders", aT, { season: "SS2027", values: { styleNo: "ALB-1", img: ["/uploads/p1.jpg", "/uploads/p2.jpg", "/uploads/p3.jpg"] } });
  ok(alb.status === 200 && Array.isArray(alb.j.values.img) && alb.j.values.img.length === 3, "款式图可存多张");

  // export xlsx (admin only)
  const exp = await fetch(BASE + "/export", { headers: { Authorization: "Bearer " + aT } });
  const buf = Buffer.from(await exp.arrayBuffer());
  ok(exp.status === 200 && buf.slice(0, 2).toString() === "PK" && buf.length > 500, "导出真实 .xlsx (PK 头)");
  ok((await fetch(BASE + "/export", { headers: { Authorization: "Bearer " + sT } })).status === 403, "非管理员不能导出");

  // no-token blocked
  ok((await call("GET", "/bootstrap", null)).status === 401, "未登录被拦截");
  // 安全：公网"凭手机号自助改密"已移除（原来可盗号）
  ok((await call("POST", "/password/reset", null, { phone: "13800000000", newPassword: "x" })).status >= 400, "自助改密接口已下线（未登录无法改密）");

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})();
