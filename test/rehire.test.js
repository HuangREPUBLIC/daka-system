const BASE=(process.env.BASE_URL || "http://localhost:3000")+"/api"; let pass=0,fail=0;
const ok=(c,n)=>{if(c){pass++;console.log("PASS "+n);}else{fail++;console.log("FAIL "+n);}};
async function call(m,p,t,b){const h={"Content-Type":"application/json"};if(t)h.Authorization="Bearer "+t;
  const r=await fetch(BASE+p,{method:m,headers:h,body:b?JSON.stringify(b):undefined});
  let j=null;try{j=await r.json();}catch(e){} return {status:r.status,j};}
(async()=>{
  const aT=(await call("POST","/login",null,{phone:"13800000000",password:"123456"})).j.token;
  const u1=await call("POST","/users",aT,{name:"离职员工",phone:"13911112222",role:"follower"});
  ok(u1.status===200,"创建员工");
  ok((await call("POST","/users",aT,{name:"重复",phone:"13911112222",role:"sales"})).status===400,"在职时手机号不可重复");
  ok((await call("DELETE","/users/"+u1.j.id,aT)).status===200,"删除(离职)");
  const u2=await call("POST","/users",aT,{name:"返聘员工",phone:"13911112222",role:"sales"});
  ok(u2.status===200,"同一手机号可重新创建账号(返聘)");
  const lg=await call("POST","/login",null,{phone:"13911112222",password:"123456"});
  ok(lg.status===200&&lg.j.user.name==="返聘员工"&&lg.j.user.role==="sales","新账号能正常登录(不会命中已删除的旧账号)");
  console.log(`\n结果：PASS ${pass}, FAIL ${fail}`); process.exit(fail?1:0);
})();
