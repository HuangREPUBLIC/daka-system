const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
const AdmZip = require("adm-zip");
// jsdom 未实现 window.scrollTo 等，属正常现象，静音掉避免干扰测试输出
const vc = new VirtualConsole();
vc.on("jsdomError", () => {});
const BASEU = process.env.BASE_URL || "http://localhost:3000";
const ROOT = require("path").join(__dirname, "..", "public");
let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 构造一个合法的 xlsx(本质是zip)：表头+2行数据，第一行数据(0-based row=1)带一张嵌入图片，
// 模拟 WPS/Excel 表格里直接贴款式图的场景，用来验证 /api/import/parse 能正确把图片按行抠出来
function buildXlsxWithEmbeddedImage() {
  const zip = new AdmZip();
  zip.addFile("[Content_Types].xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
</Types>`));
  zip.addFile("_rels/.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`));
  zip.addFile("xl/workbook.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`));
  zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`));
  zip.addFile("xl/worksheets/sheet1.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>货号</t></is></c><c r="B1" t="inlineStr"><is><t>款式名</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>E2E-IMG1</t></is></c><c r="B2" t="inlineStr"><is><t>带图测试款</t></is></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>E2E-IMG2</t></is></c><c r="B3" t="inlineStr"><is><t>无图测试款</t></is></c></row>
</sheetData>
<drawing r:id="rId1"/>
</worksheet>`));
  zip.addFile("xl/worksheets/_rels/sheet1.xml.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`));
  zip.addFile("xl/drawings/drawing1.xml", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<xdr:twoCellAnchor>
<xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="1" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr>
<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:twoCellAnchor>
</xdr:wsDr>`));
  zip.addFile("xl/drawings/_rels/drawing1.xml.rels", Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`));
  const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  zip.addFile("xl/media/image1.png", png1x1);
  return zip.toBuffer();
}

(async () => {
  const html = fs.readFileSync(ROOT + "/index.html", "utf8");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: BASEU + "/", virtualConsole: vc });
  const { window } = dom, doc = window.document;
  // 注入浏览器 API
  window.fetch = (u, o) => fetch(new URL(u, BASEU + "/").toString(), o);
  window.FormData = FormData; window.Blob = Blob; window.URL.createObjectURL = () => "blob:x";
  window.URL.revokeObjectURL = () => {};
  const sc = doc.createElement("script");
  sc.textContent = fs.readFileSync(ROOT + "/app.js", "utf8");
  doc.body.appendChild(sc);
  await sleep(300);
  const app = () => doc.getElementById("app").innerHTML;
  const A = window.A;

  ok(app().includes("跟单系统") && app().includes("lg-phone") && app().includes("lg-pass"), "未登录显示登录页");

  // 错误密码
  doc.getElementById("lg-phone").value = "13800000000";
  doc.getElementById("lg-pass").value = "wrong";
  await A.login(); A.dismissWelcome(); await sleep(250);
  ok(!app().includes("订单列表"), "错误密码不能登录");

  // 管理员登录
  doc.getElementById("lg-pass").value = "123456";
  await A.login(); A.dismissWelcome(); await sleep(400);
  ok(app().includes("订单列表") && app().includes('data-tab="admin"'), "管理员登录成功（含管理 Tab）");
  ok(app().includes("SS27-T012") && app().includes("女装印花短袖T恤"), "订单列表来自服务端");
  ok(window.localStorage.getItem("daka_token"), "token 已保存");

  // 详情页 + 打卡
  const st = () => window.eval("state");
  const o1 = st().orders.find(o => o.values.styleNo === "SS27-T012");
  window.go("detail", o1.id); await sleep(200);
  ok(app().includes("一、订单明细") && app().includes("二、生产明细") && app().includes("三、验货问题") && app().includes("四、跟单小结"), "详情页四大板块");
  doc.getElementById("txt-cutting").value = "E2E 打卡测试";
  await A.addLog(o1.id, "cutting"); await sleep(400);
  ok(app().includes("E2E 打卡测试"), "打卡后页面显示新记录");
  // 服务端确认已持久化
  const r = await fetch(BASEU + "/api/orders/" + o1.id, { headers: { Authorization: "Bearer " + st().token } });
  const srv = await r.json();
  ok(srv.logs.cutting.some(e => e.text === "E2E 打卡测试" && e.byName === "老板"), "打卡已存到服务端(带姓名)");

  // 跟单问题
  doc.getElementById("txt-follow").value = "E2E 跟单问题";
  await A.addFollow(o1.id); await sleep(400);
  ok(app().includes("E2E 跟单问题"), "跟单问题添加成功");

  // 管理后台：职位下拉
  window.go("admin"); await sleep(250);
  ok(app().includes("员工账号") && app().includes("职位管理"), "管理后台渲染");
  ok(app().includes('data-view="admin"'), "当前页面是管理后台");
  const selCount = (app().match(/A\.changeRole\(/g) || []).length;
  const admins = st().users.filter(u => u.role === "admin").length;
  ok(selCount === st().users.length - admins, "每个非管理员都有职位下拉，管理员没有");
  ok(!app().includes(`A.changeRole('${st().me.id}'`), "自己(管理员)没有职位下拉");
  const wang = st().users.find(u => u.name === "王建国");
  await A.changeRole(wang.id, "sales"); await sleep(400);
  ok(st().users.find(u => u.id === wang.id).role === "sales", "下拉改职位：下厂员→业务员");
  await A.changeRole(wang.id, "follower"); await sleep(400);
  ok(st().users.find(u => u.id === wang.id).role === "follower", "改回下厂员");

  // 删除员工二次确认
  doc.getElementById("nu-name").value = "E2E临时";
  doc.getElementById("nu-phone").value = "13900007777";
  await A.addUser(); await sleep(400);
  const tmp = st().users.find(u => u.phone === "13900007777");
  ok(!!tmp, "创建员工成功");
  A.deleteUser(tmp.id); await sleep(100);
  ok(doc.getElementById("mask").classList.contains("show"), "删除弹出二次确认");
  A.modalCancel(); await sleep(200);
  ok(st().users.some(u => u.id === tmp.id), "取消则未删除");
  A.deleteUser(tmp.id); await sleep(100);
  await A.modalOk(); await sleep(500);
  ok(!st().users.some(u => u.id === tmp.id), "确认后员工已删除");

  // 新建订单（季节下拉）
  window.go("new"); await sleep(200);
  const seasonSel = doc.getElementById("nf-season");
  ok(seasonSel && seasonSel.tagName === "SELECT", "季节是下拉");
  const y = new Date().getFullYear();
  const opts = [...seasonSel.options].map(o => o.value);
  ok(opts.includes("SS" + y) && opts.includes("FW" + (y + 1)), "季节按当前年份自动生成");
  seasonSel.value = "SS" + (y + 1);
  doc.getElementById("nf-styleNo").value = "E2E-001";
  doc.getElementById("nf-styleName").value = "E2E新款";
  await A.createOrder(); await sleep(500);
  ok(st().orders.some(o => o.values.styleNo === "E2E-001"), "新建订单成功");

  // 批量导入：识别→可编辑→确认
  window.go("new"); await sleep(200);
  doc.getElementById("imp-text").value = "季节,货号,款式名,数量,业务员,下厂员\nSS2027,E2E-IMP1,导入甲,500,陈晓芳,王建国\nSS2027,E2E-IMP2,导入乙,800,查无此人,刘敏";
  const beforeN = st().orders.length;
  A.importText(); await sleep(250);
  ok(st().orders.length === beforeN, "识别后未直接入库");
  ok(doc.getElementById("imp0-styleNo").value === "E2E-IMP1", "识别结果填入可编辑输入框");
  ok(doc.getElementById("imp1-sales").value === "", "查不到的业务员留空待选");
  doc.getElementById("imp0-styleName").value = "导入甲改名";
  A.removeImportRow(1); await sleep(200);
  ok(doc.getElementById("imp0-styleName").value === "导入甲改名", "移除一单后其它修改保留");
  await A.confirmImport(); await sleep(600);
  ok(st().orders.some(o => o.values.styleName === "导入甲改名"), "导入时用户的修改被保存");
  ok(!st().orders.some(o => o.values.styleNo === "E2E-IMP2"), "被移除的单未导入");

  // 批量导入：WPS/Excel 表格里嵌入的款式图，能自动抠出来配对到对应行
  window.go("new"); await sleep(200);
  const xlsxBuf = buildXlsxWithEmbeddedImage();
  const parseRes = await fetch(BASEU + "/api/import/parse", {
    method: "POST", headers: { Authorization: "Bearer " + window.localStorage.getItem("daka_token") },
    body: (() => { const fd = new FormData(); fd.append("file", new Blob([xlsxBuf]), "test.xlsx"); return fd; })()
  });
  const parseJson = await parseRes.json();
  ok(parseRes.ok && parseJson.rowImages && parseJson.rowImages["1"], "服务端正确识别出嵌入图片并按行号配对(第1行，即带图那单)");
  ok(!parseJson.rowImages["2"], "没贴图的那一行没有被错误配对上图片");
  window.eval(`A.showPreview(A.rowsToPreview(${JSON.stringify(parseJson.rows)}, ${JSON.stringify(parseJson.rowImages)}))`);
  await sleep(200);
  ok(!!doc.getElementById("pe-imp0-img") && doc.getElementById("pe-imp0-img").querySelectorAll(".ph-thumb").length === 1,
    "导入预览里带图的那单已经自动填好款式图缩略图");
  await A.confirmImport(); await sleep(500);
  const importedWithImg = st().orders.find(o => o.values.styleNo === "E2E-IMG1");
  ok(!!importedWithImg && Array.isArray(importedWithImg.values.img) && importedWithImg.values.img.length === 1,
    "确认导入后，订单确实带上了表格里嵌入的款式图");
  const importedNoImg = st().orders.find(o => o.values.styleNo === "E2E-IMG2");
  ok(!!importedNoImg && !(importedNoImg.values.img && importedNoImg.values.img.length), "没贴图的那单没有被错误地带上图片");

  // 权限：下厂员视角
  A.forceLogout(); await sleep(150);
  doc.getElementById("lg-phone").value = "13877778888"; // 刘敏
  doc.getElementById("lg-pass").value = "123456";
  await A.login(); A.dismissWelcome(); await sleep(400);
  ok(!app().includes('data-tab="admin"'), "下厂员看不到管理 Tab");
  ok(app().includes("go('new')"), "权限统一后，下厂员也能看到新建订单入口");
  window.go("detail", o1.id); await sleep(250); // o1 归王建国
  ok(app().includes("txt-cutting"), "权限统一后，下厂员在别人订单上也有打卡框");

  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERROR", e); process.exit(1); });
