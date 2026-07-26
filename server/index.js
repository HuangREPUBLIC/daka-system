"use strict";
const express = require("express");
const path = require("path");
const { seedIfEmpty, ensureDefaults, UPLOAD_DIR } = require("./db");
const api = require("./routes");

seedIfEmpty();
ensureDefaults();   // 老库升级时补齐新增配置

const app = express();
app.use(express.json({ limit: "2mb" }));

// API
app.use("/api", api);

// 上传的款式图
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));

// 前端静态资源
const PUBLIC = path.join(__dirname, "..", "public");
// Service Worker 和 manifest 不能被缓存，否则前端更新推不下去
app.get(["/sw.js", "/manifest.webmanifest"], (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});
app.use(express.static(PUBLIC));
// 单页应用兜底：非 /api、非 /uploads 的路径都回 index.html
app.get(/^\/(?!api|uploads).*/, (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));

// 统一错误处理（含 multer 文件过大等）
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "服务器出错" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`跟单系统已启动： http://localhost:${PORT}`));
