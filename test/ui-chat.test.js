/** 前端新功能的端到端测试：聊天、职位、忘记密码弹窗、季节筛选、我的账号打卡记录 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const BASEU = process.env.BASE_URL || "http://localhost:3000";
const ROOT = path.join(__dirname, "..", "public");
const vc = new VirtualConsole(); vc.on("jsdomError", () => {});
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiAs(phone, method, p, body) {
  const lg = await fetch(BASEU + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, password: "123456" }) });
  const { token } = await lg.json();
  const r = await fetch(BASEU + "/api" + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => null) };
}

(async () => {
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: BASEU + "/", virtualConsole: vc });
  const { window } = dom, doc = window.document;
  window.fetch = (u, o) => fetch(new URL(u, BASEU + "/").toString(), o);
  window.FormData = FormData; window.Blob = Blob;
  window.URL.createObjectURL = () => "blob:x"; window.URL.revokeObjectURL = () => {};
  const sc = doc.createElement("script");
  sc.textContent = fs.readFileSync(ROOT + "/app.js", "utf8");
  doc.body.appendChild(sc);
  await sleep(300);
  const app = () => doc.getElementById("app").innerHTML;
  const mask = () => doc.getElementById("mask");
  const A = window.A, st = () => window.eval("state");

  // ---- 忘记密码：弹窗，而不是撑长登录页 ----
  ok(!app().includes("pwbox"), "登录页不再内嵌改密表单");
  A.openForgotPw(); await sleep(150);
  ok(mask().classList.contains("show") && mask().innerHTML.includes("fp-phone"), "点忘记密码弹出弹窗");
  doc.getElementById("fp-phone").value = "13800000000";
  doc.getElementById("fp-p1").value = "abc"; doc.getElementById("fp-p2").value = "xyz";
  await A.modalOk(); await sleep(200);
  ok(mask().classList.contains("show"), "两次密码不一致时弹窗不关闭");
  A.modalCancel(); await sleep(100);
  ok(!mask().classList.contains("show"), "可取消弹窗");

  // ---- 登录 ----
  doc.getElementById("lg-phone").value = "13800000000";
  doc.getElementById("lg-pass").value = "123456";
  await A.login(); await sleep(500);
  ok(app().includes("订单列表"), "管理员登录");

  // ---- 导航：聊天取代我的打卡 ----
  ok(app().includes('data-tab="chat"') && !app().includes('data-tab="mine"'), "Tab 栏有「聊天」，没有「我的打卡」");
  ok(app().includes('class="tabbar"'), "底部 Tab 栏存在");
  ok(app().includes('class="navbar"'), "顶部标题栏存在");

  // ---- 季节筛选用自动生成选项 ----
  const y = new Date().getFullYear();
  const filterSel = doc.querySelector(".filters select");
  const opts = [...filterSel.options].map(o => o.value);
  ok(opts.includes("SS" + (y + 1)) && opts.includes("FW" + (y + 1)), "季节筛选含未来季节(不再锁死在已有订单)");

  // ---- 我的账号：职位 + 打卡记录 ----
  window.go("account"); await sleep(500);
  ok(!app().includes("角色"), "全站不再出现「角色」字样");
  ok(app().includes(st().me.roleLabel), "我的账号显示职位名称");
  ok(app().includes("退出登录"), "我的页面有退出登录入口");
  ok(app().includes("我的打卡记录"), "打卡记录移到我的账号");

  // ---- 管理后台：职位管理 ----
  window.go("admin"); await sleep(400);
  ok(app().includes("职位管理") && app().includes("权限模板"), "管理后台有职位管理");
  ok(app().includes("<th>职位</th>") && !app().includes("<th>角色</th>"), "员工表表头是「职位」");
  doc.getElementById("nr-label").value = "跟单主管";
  doc.getElementById("nr-template").value = "sales";
  await A.addRole(); await sleep(600);
  ok(st().roles.some(r => r.label === "跟单主管"), "新增自定义职位");
  const chen = st().users.find(u => u.name === "陈晓芳");
  const sel = [...doc.querySelectorAll("select")].find(s => s.outerHTML.includes(chen.id));
  ok(sel && [...sel.options].some(o => o.textContent === "跟单主管"), "自定义职位出现在员工职位下拉里");
  ok(app().includes("查看打卡"), "管理员可查看员工打卡");

  // ---- 聊天 ----
  window.go("chat"); await sleep(600);
  ok(app().includes('data-view="chat"') && app().includes("chat-contacts"), "聊天页渲染");
  ok(!app().includes("group-title\">同事") && !app().includes('class="c-role"'), "聊天页不显示「同事」标题和联系人职位");
  ok(st().chat.contacts.length === st().users.length - 1, "联系人=其他同事");
  ok(!st().chat.contacts.some(c => c.id === st().me.id), "联系人不含自己");
  await A.openChat(chen.id); await sleep(500);
  ok(doc.getElementById("chat-text") && app().includes("chat-msgs"), "打开会话界面");
  const before = st().chat.messages.length;   // 同一台测试服务器上可能已有历史消息
  doc.getElementById("chat-text").value = "晓芳，这单交期要提前";
  await A.sendMsg(); await sleep(600);
  ok(app().includes("晓芳，这单交期要提前"), "发出的消息显示在对话里");
  const sent = st().chat.messages;
  ok(sent.length === before + 1 && sent[sent.length - 1].fromMe === true
    && sent[sent.length - 1].text === "晓芳，这单交期要提前", "消息标记为自己发出");

  // 对方回复后，会话轮询能收到
  await apiAs("13811112222", "POST", "/chat/with/" + st().me.id, { text: "收到，我马上联系工厂" });
  await A.loadConversation(); await sleep(300);
  const got = st().chat.messages;
  ok(got.length === before + 2 && got[got.length - 1].fromMe === false
    && got[got.length - 1].text === "收到，我马上联系工厂", "收到对方回复");
  ok(doc.getElementById("chat-msgs").innerHTML.includes("收到，我马上联系工厂"), "回复渲染到气泡区");

  // 未读红点：让第三人发消息给我
  await apiAs("13877778888", "POST", "/chat/with/" + st().me.id, { text: "老板，包装完成了" });
  await A.refreshUnread(); await sleep(300);
  ok(st().unread.total >= 1, "有未读消息计数");
  window.go("chat"); await sleep(500);
  ok(app().includes("badge") || st().unread.total >= 1, "未读显示红点");

  // ---- 日期中文化 / 中文文件选择 / 登录页图标 ----
  window.go("orders"); await sleep(400);
  const listTxt = app();
  ok(/\d{4}年\d{1,2}月\d{1,2}日/.test(listTxt), "订单列表交期是中文年月日");
  ok(!/\d{4}-\d{2}-\d{2}/.test(listTxt), "列表不再出现 2026-08-15 格式");

  const anyOrder = st().orders[0];
  window.go("detail", anyOrder.id); await sleep(500);
  ok(/\d{1,2}月\d{1,2}日 \d{2}:\d{2}/.test(app()), "打卡时间是中文月日");

  window.go("new"); await sleep(500);
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  const todayCn = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  const todayIso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  ok(doc.getElementById("nf-deadline--label").textContent === todayCn, "新建订单日期默认当天且显示中文");
  ok(doc.getElementById("nf-deadline").value === todayIso, "底层日期值就是本地当天（不受 UTC 时差影响）");
  ok(doc.getElementById("nf-shipDate--label").textContent === todayCn, "发货日期同样默认当天");
  ok(!!doc.getElementById("pe-img") && app().includes("加照片"), "款式图是多图相册选择器");
  ok(doc.querySelector("#imp-file--name") && doc.querySelector("#imp-file--name").textContent.includes("未选择文件"), "CSV 文件控件仍显示中文");
  ok(!/Choose File|No file chosen/i.test(app()), "没有英文文件选择文案");
  ok(doc.getElementById("nf-deadline").type === "date", "底层仍是原生日期控件（手机可调系统日期轮）");
  // 多图相册：模拟加两张已上传的照片，能显示缩略图且可点开大图
  window.eval("photoDraft.img = ['/uploads/t1.jpg','/uploads/t2.jpg']");
  const pe = doc.getElementById("pe-img"); pe.innerHTML = window.eval("pickerInner('img')");
  ok(pe.querySelectorAll(".ph-thumb").length === 2, "相册显示两张缩略图");
  pe.querySelector(".ph-thumb img").click();
  await sleep(100);
  ok(!!doc.getElementById("lightbox"), "点缩略图打开大图查看器");
  window.A.lbStep(1); ok(window.eval("lightbox.i") === 1, "大图可切到下一张");
  window.A.closeLightbox(); ok(!doc.getElementById("lightbox"), "大图可关闭");
  window.eval("photoDraft = {}");

  window.go("account"); await sleep(600);
  ok(!app().includes("不点退出的话"), "已移除登录状态说明文字");
  ok(!app().includes("服装生产进度") && !app().includes("一对一私聊")
     && !app().includes("职位可直接下拉修改") && !app().includes("员工离职请用")
     && !app().includes("除内置的业务员"), "多余的说明文案已全部移除");

  A.forceLogout(); await sleep(200);
  ok(app().includes("<svg") && app().includes("login-logo"), "登录页使用 SVG 应用图标");
  ok(app().includes("install-cta") && app().includes("安装到手机"), "登录页有安装入口");
  // 安装引导（jsdom 无 beforeinstallprompt，会走图文引导）
  A.install(); await sleep(150);
  ok(doc.getElementById("mask").classList.contains("show") && doc.getElementById("mask").innerHTML.includes("添加到主屏"),
     "点安装弹出图文引导");
  A.modalCancel(); await sleep(100);

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
