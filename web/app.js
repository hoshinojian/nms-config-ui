// nms-config-ui 前端逻辑（原生 JS，零依赖）。
// API 形状对准 nmsdocs/04-API契约 §一/§八；同源 /api 由本工具反代到 NMS。
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------- 基础 ----------
async function api(path, opts = {}) {
  const r = await fetch("/api/v1" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detail = body.detail ? "：" + JSON.stringify(body.detail) : "";
    const err = new Error(`${r.status} ${body.message || r.statusText}${detail}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = isErr ? "err" : "";
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), isErr ? 6000 : 3000);
}

const short = (s, n = 12) => (s || "").slice(0, n) + "…";
const fmtSize = (n) => (n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KiB");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const badge = (st) => `<span class="badge b-${esc(st)}">${esc(st)}</span>`;

const b64FromBytes = (buf) => {
  const u8 = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64FromText = (t) => btoa(unescape(encodeURIComponent(t)));
const textFromB64 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

// ---------- 全局状态 ----------
const state = {
  nodes: [],
  selected: new Set(),      // 下发向导已选节点 id
  files: [],
  presets: JSON.parse(localStorage.getItem("ncu.presets.v1") || "[]"),
  runParams: null,           // 最近一次下发的参数（重推复用）
};

// ---------- Tab ----------
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $$("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  $$(".tab").forEach((s) => s.classList.toggle("active", s.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "nodes") loadNodes();
  if (b.dataset.tab === "files") loadFiles();
  if (b.dataset.tab === "push") { loadNodes(); refreshWizardFiles(); }
  if (b.dataset.tab === "trace") refreshTraceNodes();
});

// ---------- 连接状态 / SSH 隧道 ----------
async function refreshConn() {
  const c = $("#conn");
  let tun;
  try {
    const r = await fetch("/ctl/status");
    tun = await r.json();
  } catch { /* 工具自身异常，按未连处理 */ }
  try {
    const h = await api("/health");
    const via = tun?.connected ? ` · 隧道 ${tun.host}` : " · 静态上游";
    c.textContent = `NMS ok · nodes=${h.collector?.nodes_total ?? "?"}${via}`;
    c.className = "conn ok";
  } catch (e) {
    c.textContent = tun?.connected
      ? `隧道已建（${tun.host}）但 NMS 不通：${e.message}`
      : "NMS 不可达（点右上 ⚙ 连接，或检查 -upstream）";
    c.className = "conn bad";
  }
}

$("#gear").onclick = () => {
  $("#set-host").value = localStorage.getItem("ncu.host") || "";
  $("#set-user").value = localStorage.getItem("ncu.user") || "root";
  $("#set-target").value = localStorage.getItem("ncu.target") || "127.0.0.1:8080";
  $("#set-pass").value = "";
  $("#set-note").textContent = "";
  $("#settings").classList.remove("hidden");
};
$("#settings").addEventListener("click", (e) => {
  if (e.target === $("#settings") || e.target.closest("[data-close]")) $("#settings").classList.add("hidden");
});
$("#set-connect").onclick = async () => {
  const host = $("#set-host").value.trim();
  const user = $("#set-user").value.trim();
  const pass = $("#set-pass").value;
  const target = $("#set-target").value.trim();
  if (!host || !user || !pass) return $("#set-note").textContent = "宿主机 / 用户 / 密码都要填";
  $("#set-note").textContent = "连接中…";
  $("#set-connect").disabled = true;
  try {
    const r = await fetch("/ctl/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, user, password: pass, target }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message || r.statusText);
    localStorage.setItem("ncu.host", host);
    localStorage.setItem("ncu.user", user);
    localStorage.setItem("ncu.target", target);
    $("#set-note").textContent = "✓ 已连接 " + d.host;
    setTimeout(() => $("#settings").classList.add("hidden"), 600);
    await refreshConn(); loadNodes().then(loadFiles);
  } catch (e) {
    $("#set-note").textContent = "失败：" + e.message;
  } finally {
    $("#set-connect").disabled = false;
  }
};
$("#set-disconnect").onclick = async () => {
  await fetch("/ctl/disconnect", { method: "POST" });
  $("#set-note").textContent = "已断开（回落静态上游）";
  refreshConn();
};

refreshConn();

// ---------- 节点（Tab1 + 向导②共用渲染） ----------
function pushable(n) { return n.device_type === "vps" && n.role === "managed"; }
function unpushReason(n) {
  if (n.device_type === "router") return "router 走 SNMP 任务通道";
  return { idle: "未纳管（idle）", maintenance: "维护中", provisioning: "部署中", retired: "已退役" }[n.role] || "当前角色不可下发";
}

async function loadNodes() {
  try { state.nodes = await api("/nodes"); }
  catch (e) { toast("节点加载失败：" + e.message, true); state.nodes = []; }
  renderNodesTable($("#nodes-table tbody"), true);
  renderNodesTable($("#push-nodes"), false);
  refreshTraceNodes();
  updateSelInfo();
}

function renderNodesTable(tbody, withOps) {
  if (!tbody) return;
  if (withOps) {
    tbody.innerHTML = state.nodes.map((n) => {
      const ok = pushable(n);
      return `<tr class="${ok ? "" : "disabled"}" title="${ok ? "" : esc(unpushReason(n))}">
        <td>${ok ? `<input type="checkbox" data-id="${esc(n.id)}" ${state.selected.has(n.id) ? "checked" : ""}>` : "—"}</td>
        <td class="mono">${esc(n.id)}</td><td>${esc(n.name || "")}</td>
        <td class="mono">${esc(n.management_ip)}:${esc(n.ssh_port ?? 22)}</td>
        <td>${esc(n.device_type)}</td><td>${esc(n.role)}</td>
        <td>${esc(n.status || "-")}</td><td>${esc(n.domain)}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="hint">（无节点）</td></tr>`;
  } else {
    tbody.innerHTML = `<table><thead><tr><th></th><th>ID</th><th>IP</th><th>角色</th><th>状态</th></tr></thead><tbody>` +
      state.nodes.map((n) => {
        const ok = pushable(n);
        return `<tr class="${ok ? "" : "disabled"}" title="${ok ? "" : esc(unpushReason(n))}">
          <td>${ok ? `<input type="checkbox" data-id="${esc(n.id)}" ${state.selected.has(n.id) ? "checked" : ""}>` : "—"}</td>
          <td class="mono">${esc(n.id)}</td><td class="mono">${esc(n.management_ip)}</td>
          <td>${esc(n.role)}</td><td>${esc(n.status || "-")}</td></tr>`;
      }).join("") + `</tbody></table>`;
  }
}

document.addEventListener("change", (e) => {
  if (e.target.matches('#nodes-table input[type=checkbox], #push-nodes input[type=checkbox]')) {
    const id = e.target.dataset.id;
    e.target.checked ? state.selected.add(id) : state.selected.delete(id);
    updateSelInfo();
  }
});

function updateSelInfo() {
  const n = state.selected.size;
  $("#nodes-selected").textContent = n ? `已选 ${n} 台` : "";
  $("#nodes-to-wizard").disabled = !n;
}
$("#nodes-reload").onclick = loadNodes;
$("#nodes-to-wizard").onclick = () => $('#tabs button[data-tab="push"]').click();
$("#push-all-managed").onclick = () => {
  state.nodes.filter(pushable).forEach((n) => state.selected.add(n.id));
  renderNodesTable($("#nodes-table tbody"), true);
  renderNodesTable($("#push-nodes"), false);
  updateSelInfo();
};
$("#push-clear").onclick = () => { state.selected.clear(); loadNodes(); };
$("#push-reload").onclick = loadNodes;

// ---------- 配置文件库（Tab2） ----------
async function loadFiles() {
  try {
    const d = await api("/config-files?limit=200");
    state.files = d.items || [];
  } catch (e) { toast("文件库加载失败：" + e.message, true); state.files = []; }
  $("#files-table tbody").innerHTML = state.files.map((f) => `<tr>
      <td class="mono">${esc(f.name)}</td><td>${esc(f.description || "")}</td>
      <td>v${f.latest_version}</td><td>${fmtSize(f.size_bytes)}</td>
      <td class="mono" title="${esc(f.sha256)}">${short(f.sha256)}</td>
      <td class="mono">${esc((f.updated_at || "").replace("T", " ").slice(0, 19))}</td>
      <td><button class="btn slim" data-versions="${esc(f.name)}">版本史</button>
          <button class="btn slim" data-use="${esc(f.name)}" data-v="${f.latest_version}">下发此版</button></td>
    </tr>`).join("") || `<tr><td colspan="7" class="hint">（空）</td></tr>`;
  refreshWizardFiles();
}

$("#files-reload").onclick = loadFiles;
$("#files-table").addEventListener("click", (e) => {
  const v = e.target.closest("[data-versions]");
  if (v) return showVersions(v.dataset.versions);
  const u = e.target.closest("[data-use]");
  if (u) {
    $('#tabs button[data-tab="push"]').click();
    $("#push-file").value = u.dataset.use;
    onWizardFileChange().then(() => { $("#push-version").value = u.dataset.v; });
  }
});

async function showVersions(name) {
  try {
    const d = await api("/config-files/" + encodeURIComponent(name));
    $("#versions-box").innerHTML = `<h3 class="hint">${esc(name)} · 版本史（新→旧）</h3>
      <table><thead><tr><th>版本</th><th>大小</th><th>sha256</th><th>上传者</th><th>时间</th><th></th></tr></thead><tbody>` +
      d.versions.map((v) => `<tr>
        <td>v${v.version}</td><td>${fmtSize(v.size_bytes)}</td>
        <td class="mono" title="${esc(v.sha256)}">${short(v.sha256)}</td>
        <td>${esc(v.uploaded_by)}</td>
        <td class="mono">${esc((v.created_at || "").replace("T", " ").slice(0, 19))}</td>
        <td><button class="btn slim" data-read="${esc(name)}" data-v="${v.version}">读回 / 编辑</button>
            <button class="btn slim" data-use="${esc(name)}" data-v="${v.version}">下发</button></td></tr>`).join("") +
      `</tbody></table>`;
    $("#versions-box").scrollIntoView({ behavior: "smooth" });
  } catch (e) { toast(e.message, true); }
}
$("#versions-box").addEventListener("click", (e) => {
  const r = e.target.closest("[data-read]");
  if (r) return openEditor(r.dataset.read, +r.dataset.v);
  const u = e.target.closest("[data-use]");
  if (u) {
    $('#tabs button[data-tab="push"]').click();
    $("#push-file").value = u.dataset.use;
    onWizardFileChange().then(() => { $("#push-version").value = u.dataset.v; });
  }
});

// 上传
$("#up-file").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f && !$("#up-name").value) $("#up-name").value = f.name;
});
$("#up-submit").onclick = async () => {
  const f = $("#up-file").files[0];
  const name = $("#up-name").value.trim();
  if (!f || !name) return toast("选文件 + 起 name", true);
  const buf = await f.arrayBuffer();
  try {
    const r = await api("/config-files", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: $("#up-desc").value.trim() || undefined,
        content_base64: b64FromBytes(buf),
      }),
    });
    $("#up-result").innerHTML = `✓ ${esc(r.name)} v${r.version} · ${fmtSize(r.size_bytes)} · sha256 <span class="mono">${short(r.sha256, 16)}</span>`;
    toast(`已上传 ${r.name} v${r.version}`);
    $("#up-file").value = ""; loadFiles();
  } catch (e) { toast("上传失败：" + e.message, true); }
};

// ---------- 编辑器（读回 / 在线编辑升版） ----------
const ed = { name: "", version: 0, sha256: "", dirty: false };
async function openEditor(name, version) {
  try {
    const d = await api(`/config-files/${encodeURIComponent(name)}/content?version=${version}`);
    ed.name = d.name; ed.version = d.version; ed.sha256 = d.sha256; ed.dirty = false;
    $("#ed-title").textContent = `${d.name} · v${d.version}`;
    $("#ed-meta").textContent = `sha256 ${short(d.sha256, 16)}（内容读回是唯一出口，勿外泄）`;
    $("#ed-text").value = textFromB64(d.content_base64);
    $("#ed-save").disabled = true;
    $("#ed-note").textContent = "";
    $("#editor").classList.remove("hidden");
  } catch (e) { toast(e.message, true); }
}
$("#ed-text").addEventListener("input", () => {
  ed.dirty = true;
  $("#ed-save").disabled = false;
  $("#ed-note").textContent = "保存将以同名追加新版本（v" + (ed.version + 1) + "）";
});
$("#ed-save").onclick = async () => {
  try {
    const r = await api("/config-files", {
      method: "POST",
      body: JSON.stringify({ name: ed.name, content_base64: b64FromText($("#ed-text").value) }),
    });
    toast(`已保存 ${r.name} v${r.version}`);
    $("#editor").classList.add("hidden");
    loadFiles();
  } catch (e) { toast("保存失败：" + e.message, true); }
};
$("#ed-download").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([$("#ed-text").value], { type: "text/plain" }));
  a.download = ed.name;
  a.click();
};
$("#editor").addEventListener("click", (e) => {
  if (e.target === $("#editor") || e.target.closest("[data-close]")) $("#editor").classList.add("hidden");
});

// ---------- 下发向导（Tab3） ----------
function refreshWizardFiles() {
  $("#push-file").innerHTML =
    `<option value="">— 选择文件 —</option>` +
    state.files.map((f) => `<option value="${esc(f.name)}">${esc(f.name)}（最新 v${f.latest_version}）</option>`).join("");
  renderPresets();
}
async function onWizardFileChange() {
  const name = $("#push-file").value;
  $("#push-version").innerHTML = `<option value="0">最新（受理时钉死）</option>`;
  if (!name) return;
  try {
    const d = await api("/config-files/" + encodeURIComponent(name));
    $("#push-version").innerHTML += d.versions
      .map((v) => `<option value="${v.version}">v${v.version} · ${short(v.sha256, 10)}</option>`).join("");
  } catch (e) { toast(e.message, true); }
}
$("#push-file").addEventListener("change", onWizardFileChange);

// 预设（localStorage）
function renderPresets() {
  $("#preset-select").innerHTML = `<option value="">— 选择常用组合 —</option>` +
    state.presets.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join("");
}
$("#preset-select").addEventListener("change", (e) => {
  const p = state.presets[e.target.value];
  if (!p) return;
  $("#push-path").value = p.path || "";
  $("#push-apply").value = p.apply || "";
});
$("#preset-save").onclick = () => {
  const label = prompt("预设名：", $("#push-path").value || "预设");
  if (!label) return;
  state.presets.push({ label, path: $("#push-path").value.trim(), apply: $("#push-apply").value.trim() });
  localStorage.setItem("ncu.presets.v1", JSON.stringify(state.presets));
  renderPresets();
  toast("预设已保存（本地）");
};
$("#preset-del").onclick = () => {
  const i = $("#preset-select").value;
  if (i === "") return;
  state.presets.splice(+i, 1);
  localStorage.setItem("ncu.presets.v1", JSON.stringify(state.presets));
  renderPresets();
};

function collectParams() {
  const name = $("#push-file").value;
  const path = $("#push-path").value.trim();
  const apply = $("#push-apply").value.trim();
  const version = +$("#push-version").value;
  if (!name) return { err: "先选文件" };
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) return { err: "目标路径须为绝对路径（白名单字符）" };
  if (apply.length > 1024) return { err: "apply 命令超 1024 字节" };
  if (!state.selected.size) return { err: "先勾选节点" };
  return { name, path, apply, version };
}

$("#push-run").onclick = async () => {
  const p = collectParams();
  if (p.err) return toast(p.err, true);
  // P48：apply 动承载网时提醒单节点执行
  if (state.selected.size > 1 && /wg-quick|wireguard|restart\s+wg/i.test(p.apply)) {
    if (!confirm(`apply 命令疑似影响承载网（wireguard/管理树底座）。\n多节点并发批推可能整体断裂（P48）。\n\n仍要对 ${state.selected.size} 台执行？`))
      return;
  }
  const ids = [...state.selected];
  state.runParams = p;
  runBatch(ids, p);
};

async function runBatch(ids, params) {
  $("#push-results tbody").innerHTML = ids.map((id) => `<tr data-row="${esc(id)}">
      <td class="mono">${esc(id)}</td><td>${badge("pending")}</td>
      <td colspan="3"></td><td class="hint">排队中</td><td></td></tr>`).join("");
  $("#push-summary").textContent = "";
  const results = [];
  let idx = 0;
  const t0 = performance.now();
  const worker = async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      results.push(await pushOne(id, params, t0));
    }
  };
  await Promise.all([worker(), worker()]); // 小并发 2
  const ok = results.filter((r) => r.status === "applied").length;
  $("#push-summary").textContent = `完成：${ok}/${ids.length} applied（${((performance.now() - t0) / 1000).toFixed(1)}s）`;
}

async function pushOne(id, params, t0) {
  const row = $(`#push-results tr[data-row="${CSS.escape(id)}"]`);
  const setCell = (html) => { if (row) row.innerHTML = html; };
  const body = { name: params.name, target_path: params.path };
  if (params.version > 0) body.version = params.version;
  if (params.apply) body.apply_command = params.apply;
  let res;
  try {
    res = await api(`/nodes/${encodeURIComponent(id)}/config-file-push`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    res = { status: "push_failed", error_brief: e.message, version: params.version, sha256: "" };
  }
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1) + "s";
  const unknown = res.status === "unknown_outcome";
  setCell(`<td class="mono">${esc(id)}</td>
    <td>${badge(res.status)}</td>
    <td>v${res.version ?? "?"}</td>
    <td class="mono" title="${esc(res.sha256 || "")}">${short(res.sha256, 8)}</td>
    <td>${elapsed}</td>
    <td class="hint">${esc(res.error_brief || "")}</td>
    <td>${unknown
      ? `<label class="ack"><input type="checkbox" data-ack="${esc(id)}"> 已人工回读</label> <button class="btn slim" data-retry="${esc(id)}" disabled>重推</button>`
      : res.status === "applied" ? "" : `<button class="btn slim" data-retry="${esc(id)}">重推</button>`}</td>`);
  return res;
}

$("#push-results").addEventListener("change", (e) => {
  if (e.target.matches("[data-ack]")) {
    const btn = e.target.closest("tr").querySelector("[data-retry]");
    if (btn) btn.disabled = !e.target.checked; // 护栏：unknown_outcome 须人工回读后才能重推
  }
});
$("#push-results").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-retry]");
  if (!b || !state.runParams) return;
  b.disabled = true;
  await pushOne(b.dataset.retry, state.runParams, performance.now());
});

// ---------- 下发留痕（Tab4） ----------
function refreshTraceNodes() {
  $("#trace-node").innerHTML = `<option value="">— 选择节点 —</option>` +
    state.nodes.map((n) => `<option value="${esc(n.id)}">${esc(n.id)}（${esc(n.role)}）</option>`).join("");
}
$("#trace-reload").onclick = async () => {
  const id = $("#trace-node").value;
  if (!id) return toast("先选节点", true);
  try {
    const d = await api(`/config-file-pushes?node_id=${encodeURIComponent(id)}&limit=100`);
    $("#trace-table tbody").innerHTML = (d.items || []).map((p) => `<tr>
        <td>${p.id}</td><td class="mono">${esc(p.name)}</td><td>v${p.version}</td>
        <td>${badge(p.status)}</td><td class="mono">${esc(p.target_path)}</td>
        <td class="mono">${esc(p.apply_command || "")}</td>
        <td class="mono">${esc((p.created_at || "").replace("T", " ").slice(0, 19))}</td>
        <td class="mono">${esc((p.finished_at || "").replace("T", " ").slice(0, 19))}</td>
        <td class="hint" title="${esc(p.error_brief || "")}">${short(p.error_brief || "", 40)}</td></tr>`).join("")
      || `<tr><td colspan="9" class="hint">（无留痕）</td></tr>`;
  } catch (e) { toast(e.message, true); }
};

// ---------- 启动 ----------
loadNodes().then(loadFiles);
