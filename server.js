const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const XLSX = require("xlsx");

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "store.json");
const PEOPLE_FILE = process.env.PEOPLE_FILE || "C:\\Users\\FANG\\Desktop\\技能比赛\\人员与班组信息.xlsx";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://jade-tiramisu-f2c504.netlify.app,http://127.0.0.1:8765,http://localhost:8765")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const modules = ["安全知识", "手册修订", "新规章", "签派放行", "运行控制"];
const sessions = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPeople() {
  try {
    if (!fs.existsSync(PEOPLE_FILE)) return [];
    const wb = XLSX.readFile(PEOPLE_FILE);
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws).map((row, index) => ({
      id: index + 1,
      name: String(row["姓名"] || "").trim(),
      group: String(row["班组"] || "").trim()
    })).filter(p => p.name && p.group);
  } catch (error) {
    console.warn("人员信息读取失败，使用内置样例。", error.message);
    return [];
  }
}

function fallbackPeople() {
  return [
    { id: 1, name: "田克刚", group: "张陆彬班组" },
    { id: 2, name: "孙宏方", group: "孙宏方班组" },
    { id: 3, name: "刘威", group: "刘威班组" }
  ];
}

function seedQuestions() {
  const base = {
    安全知识: [
      ["单选", "发现运行风险上升且可能影响航班正常执行时，签派员首先应采取的措施是：", "等待航班落地后复盘", "按程序风险提示、协同研判并视情升级", "仅个人记录", "直接取消航班", "B"],
      ["单选", "发现隐患后，正确闭环管理顺序是：", "记录、评估、整改、验证、销号", "口头提醒后结束", "只在班后会讨论", "等检查时再处理", "A"]
    ],
    手册修订: [
      ["单选", "手册新修订内容涉及放行校核要求时，重点考察：", "背诵章节名称", "理解适用场景、接口职责和记录要求", "熟悉办公软件", "完成排版", "B"]
    ],
    新规章: [
      ["单选", "新规章应用题的评分重点应关注：", "条款依据和运行应用是否一致", "文字是否最长", "是否使用固定模板", "是否只选保守答案", "A"]
    ],
    签派放行: [
      ["单选", "签派放行前对备降机场判断，应综合考虑天气、保障能力、运行限制和：", "值机柜台数量", "航路、油量和机组运行条件", "旅客餐食", "宣传要求", "B"]
    ],
    运行控制: [
      ["单选", "多航班同时受流控影响时，运控决策应优先保障：", "安全底线和运行风险可控", "任意航班先走", "减少沟通", "只看单一航班", "A"]
    ]
  };
  return modules.flatMap(module => {
    const rows = [...(base[module] || [])];
    while (rows.length < 10) {
      const i = rows.length + 1;
      rows.push([
        i % 3 === 0 ? "判断" : "单选",
        `${module}模块随机题${i}：处理相关业务时，应优先依据规章手册、风险研判和运行协同要求执行。`,
        "正确", "错误", "部分正确", "与岗位无关", "A"
      ]);
    }
    return rows.slice(0, 10).map((r, index) => ({
      id: `${module}-${index + 1}`,
      module,
      type: r[0],
      title: r[1],
      A: r[2],
      B: r[3],
      C: r[4],
      D: r[5],
      answer: r[6],
      score: 2
    }));
  });
}

function createStore() {
  const people = readPeople();
  const candidates = (people.length ? people : fallbackPeople()).map((p, index) => ({
    id: index + 1,
    name: p.name,
    group: p.group,
    online: false,
    camera: false,
    submitted: false,
    score: 0,
    accuracy: 0,
    timeSec: 0,
    submittedAt: 1000 + index,
    moduleScores: {},
    status: "ok"
  }));
  return {
    nextSeq: 1,
    users: [
      { id: "admin", username: "admin", password: "admin2026", role: "admin", name: "管理员" },
      { id: "monitor", username: "monitor", password: "monitor2026", role: "monitor", name: "监考员" },
      ...candidates.map(c => ({
        id: `u-${c.id}`,
        username: c.name,
        password: "123456",
        role: "candidate",
        name: c.name,
        candidateId: c.id
      }))
    ],
    candidates,
    questions: seedQuestions(),
    exams: {},
    events: []
  };
}

function loadStore() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(DB_FILE)) {
    const fresh = createStore();
    fs.writeFileSync(DB_FILE, JSON.stringify(fresh, null, 2), "utf8");
    return fresh;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

const store = loadStore();

function saveStore() {
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2), "utf8");
}

function publicCandidate(c) {
  return {
    id: c.id,
    name: c.name,
    group: c.group,
    online: c.online,
    camera: c.camera,
    submitted: c.submitted,
    score: c.score,
    accuracy: c.accuracy,
    timeSec: c.timeSec,
    submittedAt: c.submittedAt,
    moduleScores: c.moduleScores,
    status: c.status
  };
}

function leaderboard() {
  const personal = [...store.candidates].sort((a, b) =>
    b.score - a.score ||
    b.accuracy - a.accuracy ||
    (a.timeSec || 999999) - (b.timeSec || 999999) ||
    a.submittedAt - b.submittedAt ||
    a.id - b.id
  ).map(publicCandidate);

  const groups = new Map();
  for (const c of store.candidates) {
    if (!groups.has(c.group)) groups.set(c.group, { name: c.group, members: 0, submitted: 0, total: 0, acc: 0, time: 0 });
    const g = groups.get(c.group);
    g.members += 1;
    if (c.submitted) {
      g.submitted += 1;
      g.total += c.score;
      g.acc += c.accuracy;
      g.time += c.timeSec;
    }
  }
  const teams = [...groups.values()].map(g => ({
    ...g,
    avg: g.submitted ? +(g.total / g.submitted).toFixed(1) : 0,
    avgAcc: g.submitted ? +(g.acc / g.submitted).toFixed(1) : 0,
    avgTime: g.submitted ? Math.round(g.time / g.submitted) : 0
  })).sort((a, b) => b.avg - a.avg || b.avgAcc - a.avgAcc || (a.avgTime || 999999) - (b.avgTime || 999999) || a.name.localeCompare(b.name, "zh-CN"));

  return { personal, teams };
}

function statePayload() {
  return {
    modules,
    candidates: store.candidates.map(publicCandidate),
    questionsCount: store.questions.length,
    leaderboard: leaderboard(),
    events: store.events.slice(-30).reverse()
  };
}

function emitState() {
  io.emit("contest:state", statePayload());
}

function tokenFor(user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { userId: user.id, createdAt: Date.now() });
  return token;
}

function getUserFromToken(token) {
  const row = sessions.get(token);
  if (!row) return null;
  return store.users.find(u => u.id === row.userId) || null;
}

function auth(required = true) {
  return (req, res, next) => {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
    const user = getUserFromToken(token);
    if (!user && required) return res.status(401).json({ error: "未登录或登录已失效" });
    req.user = user;
    next();
  };
}

function drawQuestions() {
  return modules.flatMap(module => {
    const pool = store.questions.filter(q => q.module === module);
    return shuffle(pool).slice(0, 10);
  });
}

function shuffle(list) {
  return [...list].sort(() => Math.random() - 0.5);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error("CORS origin not allowed"));
    },
    credentials: true
  }
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use(express.static(ROOT));

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const user = store.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: "账号或密码错误" });
  const token = tokenFor(user);
  if (user.candidateId) {
    const c = store.candidates.find(x => x.id === user.candidateId);
    if (c) c.online = true;
  }
  saveStore();
  emitState();
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name, candidateId: user.candidateId || null } });
});

app.post("/api/logout", auth(false), (req, res) => {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (req.user?.candidateId) {
    const c = store.candidates.find(x => x.id === req.user.candidateId);
    if (c) { c.online = false; c.camera = false; }
  }
  sessions.delete(token);
  saveStore();
  emitState();
  res.json({ ok: true });
});

app.get("/api/state", auth(false), (req, res) => res.json(statePayload()));

app.get("/api/questions", auth(), (req, res) => res.json({ questions: store.questions }));

app.post("/api/questions", auth(), (req, res) => {
  if (!["admin", "monitor"].includes(req.user.role)) return res.status(403).json({ error: "无权限" });
  const data = Array.isArray(req.body) ? req.body : req.body.questions;
  if (!Array.isArray(data)) return res.status(400).json({ error: "题库格式应为数组" });
  store.questions = data.map((q, index) => ({
    id: q.id || `q-${index + 1}`,
    module: q.module || q["模块"],
    type: q.type || q["题型"] || "单选",
    title: q.title || q["题干"],
    A: q.A,
    B: q.B,
    C: q.C,
    D: q.D,
    answer: q.answer || q["答案"],
    score: Number(q.score || q["分值"] || 2)
  })).filter(q => q.module && q.title);
  saveStore();
  emitState();
  res.json({ ok: true, count: store.questions.length });
});

app.get("/api/questions/export", auth(), (req, res) => {
  const headers = ["模块", "题型", "题干", "A", "B", "C", "D", "答案", "分值"];
  const rows = store.questions.map(q => [q.module, q.type, q.title, q.A, q.B, q.C, q.D, q.answer, q.score]);
  const csv = [headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", encodeURI('attachment; filename="运行控制部比赛题库.csv"'));
  res.send(`\ufeff${csv}`);
});

app.post("/api/exam/draw", auth(), (req, res) => {
  const user = req.user;
  const candidateId = user.role === "candidate" ? user.candidateId : Number(req.body?.candidateId || 0);
  const candidate = store.candidates.find(c => c.id === candidateId);
  if (!candidate) return res.status(400).json({ error: "未找到考生" });
  const questions = drawQuestions();
  const exam = {
    id: crypto.randomUUID(),
    candidateId,
    questionIds: questions.map(q => q.id),
    answers: {},
    startedAt: Date.now(),
    submittedAt: null,
    status: "doing"
  };
  store.exams[candidateId] = exam;
  store.events.push({ time: Date.now(), type: "exam", text: `${candidate.name} 已抽取试卷，共${questions.length}题。` });
  saveStore();
  emitState();
  res.json({ examId: exam.id, questions: questions.map(q => ({ ...q, answer: undefined })), total: questions.length });
});

app.get("/api/exam/current", auth(), (req, res) => {
  const candidateId = req.user.role === "candidate" ? req.user.candidateId : Number(req.query.candidateId || 0);
  const exam = store.exams[candidateId];
  if (!exam) return res.json({ exam: null });
  const questions = exam.questionIds.map(id => store.questions.find(q => q.id === id)).filter(Boolean);
  res.json({ exam: { ...exam, questions: questions.map(q => ({ ...q, answer: undefined })) } });
});

app.post("/api/exam/answer", auth(), (req, res) => {
  const candidateId = req.user.role === "candidate" ? req.user.candidateId : Number(req.body?.candidateId || 0);
  const exam = store.exams[candidateId];
  if (!exam || exam.status !== "doing") return res.status(400).json({ error: "当前没有进行中的考试" });
  const index = Number(req.body.index);
  const answer = String(req.body.answer || "").toUpperCase();
  if (!Number.isInteger(index) || index < 0 || !["A", "B", "C", "D"].includes(answer)) return res.status(400).json({ error: "答案参数错误" });
  exam.answers[index] = answer;
  saveStore();
  res.json({ ok: true });
});

app.post("/api/exam/submit", auth(), (req, res) => {
  const candidateId = req.user.role === "candidate" ? req.user.candidateId : Number(req.body?.candidateId || 0);
  const candidate = store.candidates.find(c => c.id === candidateId);
  const exam = store.exams[candidateId];
  if (!candidate || !exam) return res.status(400).json({ error: "未找到考试" });
  if (req.body?.answers && typeof req.body.answers === "object") exam.answers = req.body.answers;
  const questions = exam.questionIds.map(id => store.questions.find(q => q.id === id)).filter(Boolean);
  let earned = 0;
  let total = 0;
  const byModule = new Map();
  questions.forEach((q, index) => {
    const points = Number(q.score || 2);
    total += points;
    if (!byModule.has(q.module)) byModule.set(q.module, { earned: 0, total: 0 });
    byModule.get(q.module).total += points;
    if (String(exam.answers[index] || "").toUpperCase() === q.answer) {
      earned += points;
      byModule.get(q.module).earned += points;
    }
  });
  const score = total ? Math.round((earned / total) * 100) : 0;
  modules.forEach(module => {
    const row = byModule.get(module);
    candidate.moduleScores[module] = row?.total ? Math.round((row.earned / row.total) * 100) : 0;
  });
  candidate.score = score;
  candidate.accuracy = score;
  candidate.timeSec = Math.max(1, Math.round((Date.now() - exam.startedAt) / 1000));
  candidate.submitted = true;
  candidate.submittedAt = store.nextSeq++;
  candidate.camera = false;
  exam.status = "submitted";
  exam.submittedAt = Date.now();
  store.events.push({ time: Date.now(), type: "submit", text: `${candidate.name} 提交试卷，得分${score}。` });
  saveStore();
  emitState();
  res.json({ ok: true, score, timeSec: candidate.timeSec, moduleScores: candidate.moduleScores, leaderboard: leaderboard() });
});

app.post("/api/proctor/event", auth(), (req, res) => {
  const candidateId = Number(req.body?.candidateId || req.user.candidateId || 0);
  const candidate = store.candidates.find(c => c.id === candidateId);
  if (!candidate) return res.status(400).json({ error: "未找到考生" });
  const type = String(req.body.type || "event");
  const message = String(req.body.message || "");
  if (type === "camera-on") candidate.camera = true;
  if (type === "camera-off") candidate.camera = false;
  if (type === "warn") candidate.status = "warn";
  if (type === "danger") candidate.status = "danger";
  if (type === "ok") candidate.status = "ok";
  store.events.push({ time: Date.now(), type, text: `${candidate.name}：${message || type}` });
  saveStore();
  emitState();
  res.json({ ok: true });
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  socket.user = getUserFromToken(token);
  next();
});

io.on("connection", socket => {
  socket.emit("contest:state", statePayload());
  socket.on("video:join", payload => {
    const room = `candidate:${payload?.candidateId}`;
    socket.join(room);
  });
  socket.on("video:offer", payload => socket.to(`candidate:${payload?.candidateId}`).emit("video:offer", { ...payload, from: socket.id }));
  socket.on("video:answer", payload => socket.to(`candidate:${payload?.candidateId}`).emit("video:answer", { ...payload, from: socket.id }));
  socket.on("video:ice", payload => socket.to(`candidate:${payload?.candidateId}`).emit("video:ice", { ...payload, from: socket.id }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`运行控制部比赛系统已启动：http://127.0.0.1:${PORT}/index.html`);
  console.log("默认账号：admin/admin2026，monitor/monitor2026，考生姓名/123456");
});
