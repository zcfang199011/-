(function () {
  const app = window.contestApp;
  if (!app) return;

  const API_BASE = (window.CONTEST_API_BASE || "").replace(/\/$/, "");
  const api = {
    token: sessionStorage.getItem("contestToken") || "",
    user: JSON.parse(sessionStorage.getItem("contestUser") || "null"),
    socket: null
  };

  const style = document.createElement("style");
  style.textContent = `
    .login-mask{position:fixed;inset:0;z-index:99;background:rgba(4,7,10,.76);backdrop-filter:blur(16px);display:grid;place-items:center;padding:20px}
    .login-card{width:min(440px,100%);background:linear-gradient(180deg,rgba(22,30,36,.98),rgba(12,18,22,.98));border:1px solid rgba(255,255,255,.12);border-radius:8px;box-shadow:0 28px 80px rgba(0,0,0,.42);padding:24px;color:#f6fafc}
    .login-card h2{margin:0 0 8px;font-size:24px}
    .login-card p{margin:0 0 18px;color:#9fb0ba;line-height:1.55}
    .login-card label{display:grid;gap:7px;margin:12px 0;color:#cbd8de;font-weight:800;font-size:13px}
    .login-card input{min-height:42px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#0d1418;color:#f6fafc;padding:0 12px;font:inherit}
    .login-row{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-top:16px}
    .login-error{min-height:20px;color:#ffb7bc;font-size:13px}
    .login-badge{position:fixed;left:18px;right:auto;bottom:18px;z-index:4;display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:rgba(13,20,24,.82);color:#dce6ea;box-shadow:0 12px 34px rgba(0,0,0,.22)}
    .login-badge button{min-height:30px;padding:0 10px}
  `;
  document.head.appendChild(style);

  function authHeaders(extra = {}) {
    return api.token ? { ...extra, Authorization: `Bearer ${api.token}` } : extra;
  }

  async function request(url, options = {}) {
    let res;
    try {
      res = await fetch(`${API_BASE}${url}`, {
        ...options,
        headers: authHeaders({
          ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        })
      });
    } catch {
      throw new Error("网络连接失败，请稍后重试");
    }
    if (!res.ok) {
      let message = `请求失败：${res.status}`;
      try { message = (await res.json()).error || message; } catch {}
      throw new Error(message);
    }
    return res.json();
  }

  function renderLogin() {
  if (api.user && api.token) {
    renderBadge();
    return;
  }
    const mask = document.createElement("div");
    mask.className = "login-mask";
    mask.innerHTML = `
      <form class="login-card" id="backendLoginForm">
        <h2>比赛系统登录</h2>
        <p>请使用活动组织方发放的账号登录。考生账号通常为本人姓名，密码以现场通知为准。</p>
        <label>账号<input id="backendUsername" autocomplete="username" placeholder="请输入账号或姓名"></label>
        <label>密码<input id="backendPassword" type="password" autocomplete="current-password" placeholder="请输入密码"></label>
        <div class="login-error" id="backendLoginError"></div>
        <div class="login-row">
          <button type="button" id="offlineMode">继续单机演示</button>
          <button class="primary" type="submit">登录比赛系统</button>
        </div>
      </form>`;
    document.body.appendChild(mask);
    document.getElementById("offlineMode").onclick = () => mask.remove();
    document.getElementById("backendLoginForm").onsubmit = async event => {
      event.preventDefault();
      const username = document.getElementById("backendUsername").value.trim();
      const password = document.getElementById("backendPassword").value;
      try {
        const data = await request("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
        api.token = data.token;
        api.user = data.user;
        sessionStorage.setItem("contestToken", api.token);
        sessionStorage.setItem("contestUser", JSON.stringify(api.user));
        mask.remove();
        renderBadge();
        applyRoleAccess();
        connectSocket();
        await syncState();
        app.toast(`登录成功：${api.user.name}`);
      } catch (error) {
        document.getElementById("backendLoginError").textContent = error.message;
      }
    };
  }

  function renderBadge() {
    let badge = document.querySelector(".login-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "login-badge";
      document.body.appendChild(badge);
    }
    badge.innerHTML = `<strong>${api.user.name}</strong><span>${roleName(api.user.role)}</span><button id="backendLogout">退出</button>`;
    document.getElementById("backendLogout").onclick = logout;
  }

  function roleName(role) {
    return role === "admin" ? "管理员" : role === "monitor" ? "监考员" : "考生";
  }

  async function logout() {
    try { await request("/api/logout", { method: "POST" }); } catch {}
    sessionStorage.removeItem("contestToken");
    sessionStorage.removeItem("contestUser");
    api.token = "";
    api.user = null;
    if (api.socket) api.socket.disconnect();
    document.querySelector(".login-badge")?.remove();
    resetRoleAccess();
    renderLogin();
  }

  function connectSocket() {
    if (!api.token) return;
    loadSocketClient().then(() => {
      if (!window.io) return;
      if (api.socket) api.socket.disconnect();
      api.socket = io(API_BASE || undefined, { auth: { token: api.token } });
      api.socket.on("contest:state", payload => applyState(payload));
    }).catch(() => {});
  }

  function loadSocketClient() {
    if (window.io) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `${API_BASE}/socket.io/socket.io.js`;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

async function syncState() {
  const payload = await request("/api/state", { method: "GET" });
  applyState(payload);
  await syncQuestions();
}
  
async function syncQuestions() {
  try {
    const data = await request("/api/questions", { method: "GET" });
    if (Array.isArray(data.questions)) {
      app.state.bank = data.questions;
      app.render();
    }
  } catch (error) {
    console.warn("后端题库同步失败：", error.message);
  }
}
  function applyState(payload) {
  if (!payload) return;

  if (Array.isArray(payload.candidates)) {
    app.state.candidates = payload.candidates.map(c => ({
      ...c,
      moduleScores: c.moduleScores || {},
      wrongQuestions: c.wrongQuestions || []
    }));
  }

  if (api.user?.candidateId) {
    const index = app.state.candidates.findIndex(c => c.id === api.user.candidateId);
    if (index >= 0) app.state.selected = index;
  }

  if (payload.questionsCount !== undefined) {
    const metric = document.getElementById("metricBank");
    if (metric) metric.textContent = payload.questionsCount;
  }

  app.render();
}
  function applyRoleAccess() {
    if (!api.user) return;
    const isCandidate = api.user.role === "candidate";
    const hiddenViews = isCandidate ? ["dashboard", "monitor", "bank", "settings"] : [];
    document.querySelectorAll(".nav [data-view]").forEach(button => {
      const hide = hiddenViews.includes(button.dataset.view);
      button.hidden = hide;
      button.disabled = hide;
    });
    const candidateSelect = document.getElementById("candidateSelect");
    if (candidateSelect) candidateSelect.disabled = isCandidate;
    if (isCandidate && app.state.view !== "exam") {
      app.state.view = "exam";
      app.render();
    }
  }

  function resetRoleAccess() {
    document.querySelectorAll(".nav [data-view]").forEach(button => {
      button.hidden = false;
      button.disabled = false;
    });
    const candidateSelect = document.getElementById("candidateSelect");
    if (candidateSelect) candidateSelect.disabled = false;
  }

async function backendDrawExam() {
  requireLogin();

  const candidateId = app.state.candidates[app.state.selected]?.id;

  const data = await request("/api/exam/draw", {
    method: "POST",
    body: JSON.stringify({ candidateId })
  });

  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    app.state.examPaper = [];
    app.state.currentQuestion = 0;
    app.toast("后端题库为空或题目模块不匹配，请先导入有效题库");
    return;
  }

  app.state.examPaper = data.questions;
  app.state.paperSeq = (app.state.paperSeq || 0) + 1;
  app.state.currentQuestion = 0;
  app.state.answers = {};

  app.toast(`后端已抽题：共${data.total}题`);
  app.render();
}

  async function backendSubmitExam() {
    requireLogin();
    const candidateId = app.state.candidates[app.state.selected]?.id;
    const qs = app.state.examPaper || [];
    const answers = {};
    qs.forEach((_, index) => { answers[index] = app.state.answers[app.answerKey(index)] || ""; });
    const data = await request("/api/exam/submit", { method: "POST", body: JSON.stringify({ candidateId, answers }) });
    const candidate = app.state.candidates[app.state.selected];
    if (candidate) {
      candidate.score = data.score;
      candidate.accuracy = data.score;
      candidate.timeSec = data.timeSec;
      candidate.submitted = true;
      candidate.moduleScores = data.moduleScores || {};
      candidate.camera = false;
    }
    app.stopCamera();
    app.toast(`交卷成功：${data.score}分`);
    app.render();
  }

  async function backendExportBank() {
    requireLogin();
    const res = await fetch(`${API_BASE}/api/questions/export`, { headers: authHeaders() });
    if (!res.ok) throw new Error("题库导出失败");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "运行控制部比赛题库.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

async function backendUploadBank() {
  requireLogin();
  const file = document.getElementById("bankFile")?.files?.[0];
  if (!file) throw new Error("请选择题库文件");

  const text = await file.text();
  const questions = file.name.toLowerCase().endsWith(".json")
    ? JSON.parse(text)
    : parseCsv(text);

  const result = await request("/api/questions", {
    method: "POST",
    body: JSON.stringify({ questions })
  });

  app.toast(`后端题库上传成功：${result.count}题`);

  await syncQuestions();
  await syncState();
}
async function backendScheduleReset() {
  requireLogin();

  if (!api.user || api.user.role !== "admin") {
    app.toast("只有管理员可以设置重置时间");
    return;
  }

  const input = document.getElementById("resetAtInput");
  const value = input?.value;

  if (!value) {
    app.toast("请选择重置时间");
    return;
  }

  const resetAt = new Date(value).toISOString();

  const data = await request("/api/admin/reset-schedule", {
    method: "POST",
    body: JSON.stringify({ resetAt })
  });

  app.toast(`已设置重置时间：${new Date(data.resetAt).toLocaleString()}`);
  await syncState();
}

async function backendResetNow() {
  requireLogin();

  if (!api.user || api.user.role !== "admin") {
    app.toast("只有管理员可以立即重置");
    return;
  }

  if (!confirm("确定要立即清空所有人成绩、答题记录和考试记录吗？")) {
    return;
  }

  await request("/api/admin/reset-now", {
    method: "POST",
    body: JSON.stringify({})
  });

  app.toast("已重置所有考试数据，每名考生只能考试一次");
  await syncState();
}
  
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = "", quoted = false;
    const source = text.replace(/^\ufeff/, "");
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];
      if (quoted && ch === '"' && next === '"') { cell += '"'; i++; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (!quoted && ch === ",") { row.push(cell); cell = ""; continue; }
      if (!quoted && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && next === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = ""; continue;
      }
      cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const headers = rows.shift() || [];
    return rows.filter(r => r.some(Boolean)).map((r, index) => {
      const obj = Object.fromEntries(headers.map((h, i) => [h.trim(), (r[i] || "").trim()]));
      return {
        id: obj.id || `upload-${index + 1}`,
        module: obj["模块"] || obj.module,
        type: obj["题型"] || obj.type || "单选",
        title: obj["题干"] || obj.title,
        A: obj.A,
        B: obj.B,
        C: obj.C,
        D: obj.D,
        answer: obj["答案"] || obj.answer,
        score: Number(obj["分值"] || obj.score || 2)
      };
    }).filter(q => q.module && q.title);
  }

  function requireLogin() {
    if (!api.token) {
      renderLogin();
      throw new Error("请先登录比赛系统");
    }
  }

  document.addEventListener("click", event => {
  const id = event.target?.id;
  const backendActions = {
    startExam: backendDrawExam,
    submitExam: backendSubmitExam,
    exportBank: backendExportBank,
    uploadBank: backendUploadBank,
    scheduleResetBtn: backendScheduleReset,
    resetNowBtn: backendResetNow
  };

  if (!backendActions[id]) return;
  if (!api.token) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  backendActions[id]().catch(error => app.toast(error.message));
}, true);

  document.addEventListener("change", event => {
    if (!api.token || event.target?.name !== "answer") return;
    const index = app.state.currentQuestion;
    request("/api/exam/answer", { method: "POST", body: JSON.stringify({ index, answer: event.target.value }) }).catch(() => {});
  }, true);

  document.addEventListener("click", event => {
    if (event.target?.id !== "startCamera" || !api.token) return;
    setTimeout(() => request("/api/proctor/event", {
      method: "POST",
      body: JSON.stringify({ candidateId: app.state.candidates[app.state.selected]?.id, type: "camera-on", message: "摄像头接入" })
    }).catch(() => {}), 900);
  });

  document.addEventListener("visibilitychange", () => {
    if (!api.token || !api.user?.candidateId || document.visibilityState === "visible") return;
    request("/api/proctor/event", {
      method: "POST",
      body: JSON.stringify({ type: "warn", message: "考试页面离开可见状态" })
    }).catch(() => {});
  });

 if (api.user && api.token) {
  renderBadge();
  applyRoleAccess();
  connectSocket();
  syncState().catch(() => {
    sessionStorage.removeItem("contestToken");
    sessionStorage.removeItem("contestUser");
    api.token = "";
    api.user = null;
    document.querySelector(".login-badge")?.remove();
    renderLogin();
  });
} else {
  renderLogin();
}
})();
}
})();
