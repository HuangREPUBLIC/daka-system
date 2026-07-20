const BASE=(process.env.BASE_URL || "http://localhost:3000")+"/api"; let pass=0,fail=0;
const ok=(c,n)=>{if(c){pass++;console.log("PASS "+n);}else{fail++;console.log("FAIL "+n);}};
async function call(m,p,t,b){const h={"Content-Type":"application/json"};if(t)h.Authorization="Bearer "+t;
  const r=await fetch(BASE+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});
  let j=null;try{j=await r.json();}catch(e){} return {status:r.status,j};}
(async()=>{
  const aT=(await call("POST","/login",null,{phone:"13800000000",password:"123456"})).j.token;
  const boot=(await call("GET","/bootstrap",aT)).j;
  ok(Array.isArray(boot.roles)&&boot.roles.length===2,"bootstrap 带职位表");
  const chen=boot.users.find(u=>u.name==="陈晓芳"), wang=boot.users.find(u=>u.name==="王建国");
  ok(chen.roleLabel==="业务员"&&wang.roleLabel==="下厂员","用户带职位名称");

  // 自定义职位
  const nr=await call("POST","/roles",aT,{label:"跟单主管",template:"sales"});
  ok(nr.status===200&&nr.j.some(r=>r.label==="跟单主管"),"新增自定义职位");
  ok((await call("POST","/roles",aT,{label:"X",template:"boss"})).status===400,"权限模板必须合法");
  ok((await call("DELETE","/roles/sales",aT)).status===400,"内置职位不可删");
  const rk=nr.j.find(r=>r.label==="跟单主管").k;
  // 把王建国改成跟单主管 -> 应获得业务员权限（可建单）
  ok((await call("PATCH","/users/"+wang.id,aT,{role:rk})).status===200,"把员工改成自定义职位");
  const wT=(await call("POST","/login",null,{phone:"13855556666",password:"123456"})).j.token;
  ok((await call("POST","/orders",wT,{season:"SS2027",values:{styleNo:"ROLE-1"}})).status===200,"自定义职位继承业务员权限(可建单)");
  ok((await call("DELETE","/roles/"+rk,aT)).status===400,"职位使用中不可删除");
  await call("PATCH","/users/"+wang.id,aT,{role:"follower"});
  ok((await call("DELETE","/roles/"+rk,aT)).status===200,"无人使用后可删除职位");

  // 聊天
  const cT=(await call("POST","/login",null,{phone:"13811112222",password:"123456"})).j.token; // 陈晓芳
  let contacts=(await call("GET","/chat/contacts",aT)).j;
  ok(contacts.length===boot.users.length-1&&!contacts.some(c=>c.id===boot.me.id),"联系人列表不含自己");
  ok(contacts.every(c=>c.unread===0&&c.last===null),"初始无未读无消息");
  ok((await call("POST","/chat/with/"+boot.me.id,aT,{text:"自己"})).status===400,"不能给自己发消息");
  ok((await call("POST","/chat/with/"+chen.id,aT,{text:""})).status===400,"空消息被拒");
  ok((await call("POST","/chat/with/"+chen.id,aT,{text:"晓芳，SS27-T012 面料到了吗？"})).status===200,"老板发消息给陈晓芳");
  // 陈晓芳看到未读
  const un=(await call("GET","/chat/unread",cT)).j;
  ok(un.total===1&&un.byUser[boot.me.id]===1,"收件人有 1 条未读");
  contacts=(await call("GET","/chat/contacts",cT)).j;
  ok(contacts[0].name==="老板"&&contacts[0].unread===1&&contacts[0].last.fromMe===false,"联系人列表按最新消息排序且标未读");
  // 打开会话 -> 已读
  const conv=(await call("GET","/chat/with/"+boot.me.id,cT)).j;
  ok(conv.messages.length===1&&conv.messages[0].fromMe===false&&conv.contact.name==="老板","会话内容正确");
  ok((await call("GET","/chat/unread",cT)).j.total===0,"打开会话后已读清零");
  // 回复
  await call("POST","/chat/with/"+boot.me.id,cT,{text:"到了，2860kg"});
  const conv2=(await call("GET","/chat/with/"+chen.id,aT)).j;
  ok(conv2.messages.length===2&&conv2.messages[1].fromMe===false&&conv2.messages[1].text==="到了，2860kg","双向会话正确");
  // 第三方看不到别人的私聊
  const fT=(await call("POST","/login",null,{phone:"13877778888",password:"123456"})).j.token;
  ok((await call("GET","/chat/with/"+chen.id,fT)).j.messages.length===0,"第三方看不到别人的私聊");
  ok((await call("GET","/chat/contacts",null)).status===401,"未登录不能用聊天");

  // ---- 聊天附件 ----
  async function upload(token, filename, bytes, type) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type }), filename);
    const r = await fetch(BASE + "/chat/upload", { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
    return { status: r.status, j: await r.json().catch(() => null) };
  }
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
    "0000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082", "hex");
  const up = await upload(aT, "工艺单.png", png, "image/png");
  ok(up.status === 200 && up.j.url.startsWith("/uploads/") && up.j.isImage === true, "上传图片附件");
  ok(up.j.name === "工艺单.png", "中文文件名不乱码");
  const bad = await upload(aT, "病毒.exe", Buffer.from("MZ"), "application/octet-stream");
  ok(bad.status === 400, "不支持的文件类型被拒绝");

  ok((await call("POST", "/chat/with/" + chen.id, aT, { attachment: up.j })).status === 200, "只发附件不带文字也可以");
  const withAtt = (await call("GET", "/chat/with/" + chen.id, aT)).j;
  const lastMsg = withAtt.messages[withAtt.messages.length - 1];
  ok(lastMsg.attachment && lastMsg.attachment.name === "工艺单.png" && lastMsg.attachment.isImage, "会话里带回附件信息");
  const cc = (await call("GET", "/chat/contacts", cT)).j.find(c => c.name === "老板");
  ok(cc && cc.last.text === "[附件]", "联系人预览显示 [附件]");
  ok((await call("POST", "/chat/with/" + chen.id, aT, {})).status === 400, "既无文字又无附件被拒");
  const dl = await fetch(BASE.replace("/api", "") + up.j.url);
  ok(dl.status === 200, "附件可以下载");

  // 员工打卡记录
  ok((await call("GET","/users/"+chen.id+"/logs",aT)).status===200,"管理员可查员工打卡");
  ok((await call("GET","/users/"+chen.id+"/logs",fT)).status===403,"他人不可查别人打卡");
  ok((await call("GET","/users/"+boot.me.id+"/logs",aT)).status===200,"本人可查自己打卡");
  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`); process.exit(fail?1:0);
})();
