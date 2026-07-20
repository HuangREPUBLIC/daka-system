"use strict";
/**
 * 测试入口：npm test
 * 会用一个临时数据目录 + 随机端口启动服务端，依次跑三组测试，最后自动关闭。
 * 不会影响你正式的 data/ 目录。
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE_URL = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "daka-test-"));
const env = Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR, BASE_URL });

const server = spawn(process.execPath, [path.join(__dirname, "..", "server", "index.js")],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", d => serverLog += d);
server.stderr.on("data", d => serverLog += d);

function cleanup() {
  try { server.kill(); } catch (e) {}
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

async function waitForServer(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(BASE_URL + "/api/bootstrap"); return true; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  if (!await waitForServer()) {
    console.error("服务端启动失败：\n" + serverLog);
    process.exit(1);
  }
  const suites = ["api.test.js", "rehire.test.js", "e2e.test.js"];
  let failed = 0;
  for (const s of suites) {
    console.log(`\n===== ${s} =====`);
    const r = spawnSync(process.execPath, [path.join(__dirname, s)], { env, stdio: "inherit" });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `\n✗ 有 ${failed} 组测试未通过` : "\n✓ 全部测试通过");
  process.exit(failed ? 1 : 0);
})();
