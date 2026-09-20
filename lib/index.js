// src/core/yaml.js
function parseScalar(raw) {
  const v = String(raw).trim();
  if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, obj: root, parent: null, key: null, pending: false }];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)[0].length;
    const content = line.slice(indent);
    const isItem = content === "-" || /^-\s/.test(content);
    while (stack.length > 1) {
      const top2 = stack[stack.length - 1];
      if (indent === top2.indent && isItem && (top2.pending || Array.isArray(top2.obj))) break;
      if (indent <= top2.indent) {
        stack.pop();
        continue;
      }
      break;
    }
    const top = stack[stack.length - 1];
    if (isItem) {
      const item = parseScalar(content.replace(/^-\s*/, ""));
      if (Array.isArray(top.obj)) {
        top.obj.push(item);
        continue;
      }
      if (!top.pending || !top.parent) continue;
      const arr = [];
      top.parent[top.key] = arr;
      top.obj = arr;
      top.pending = false;
      arr.push(item);
      continue;
    }
    if (Array.isArray(top.obj)) continue;
    const m = content.match(/^([^:#]+?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (value === "") {
      const child = {};
      top.obj[key] = child;
      top.pending = false;
      stack.push({ indent, obj: child, parent: top.obj, key, pending: true });
    } else {
      top.obj[key] = parseScalar(value);
      top.pending = false;
    }
  }
  return root;
}

// src/core/host.js
function hostCore(ctx, opts, rpc) {
  const fs = ctx.get("fs");
  const sandboxPolicy = ctx.get("sandboxPolicy");
  const agents = ctx.get("agents");
  if (fs === void 0 || sandboxPolicy === void 0 || agents === void 0) return;
  const SECTION_NAME = opts.sectionName;
  const SECTION_ORDER = -50;
  const IDENTITY_SECTION = "harness:identity";
  const IDENTITY_ORDER = -1e3;
  const rpcPrefix = opts.rpcPrefix;
  const active = /* @__PURE__ */ new Map();
  const identity = /* @__PURE__ */ new Map();
  const cwdCache = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const chains = /* @__PURE__ */ new Map();
  const handles = [];
  function warn(message) {
    try {
      if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn("[dsh-profile-selector] " + message);
    } catch (e) {
    }
  }
  function agentCwd(agent) {
    try {
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
      return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
    } catch (e) {
      return null;
    }
  }
  function sessionCwd(sessionId, explicitCwd) {
    if (typeof explicitCwd === "string" && explicitCwd.length > 0) {
      if (sessionId) cwdCache.set(sessionId, explicitCwd);
      return explicitCwd;
    }
    if (sessionId && cwdCache.has(sessionId)) return cwdCache.get(sessionId);
    if (sessionId) {
      const cwd = agentCwd(agents.get(sessionId));
      if (cwd) {
        cwdCache.set(sessionId, cwd);
        return cwd;
      }
    }
    return null;
  }
  function enqueue(sessionId, fn) {
    const prev = chains.get(sessionId) || Promise.resolve();
    const tail = prev.then(fn, fn);
    const slot = tail.catch(() => {
    });
    chains.set(sessionId, slot);
    slot.then(() => {
      if (chains.get(sessionId) === slot) chains.delete(sessionId);
    });
    return tail;
  }
  function forceCleanSection(sp, agent, name2) {
    const sectionName = name2 || SECTION_NAME;
    let removed = 0;
    try {
      const layers = sp && sp.layers;
      if (!layers) return removed;
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          if (key !== agent) continue;
          const s = layer && layer.sections;
          if (s && s.data && s.data.has(sectionName)) {
            s.data.delete(sectionName);
            removed++;
          }
        }
      }
      if (sectionName !== IDENTITY_SECTION) {
        const g = layers.global && layers.global.sections;
        if (g && g.data && g.data.has(sectionName)) {
          g.data.delete(sectionName);
          removed++;
        }
      }
    } catch (e) {
    }
    return removed;
  }
  function sectionDiag(sp, agent, name2) {
    const sectionName = name2 || SECTION_NAME;
    const parts = [];
    try {
      const layers = sp && sp.layers;
      if (!layers) return "no layers";
      let scopedHits = 0;
      let agentKeyHit = 0;
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          const s = layer && layer.sections;
          if (s && typeof s.has === "function" && s.has(sectionName)) {
            scopedHits++;
            if (key === agent) agentKeyHit++;
          }
        }
      }
      parts.push("scopedHits=" + scopedHits);
      parts.push("agentKeyHit=" + agentKeyHit);
      const g = layers.global && layers.global.sections;
      parts.push("globalHit=" + (g && typeof g.has === "function" ? g.has(sectionName) ? 1 : 0 : "na"));
    } catch (e) {
      parts.push("diagErr=" + String(e && e.message || e));
    }
    return parts.join("; ");
  }
  function localDate() {
    const d = /* @__PURE__ */ new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }
  function substitute(text, cwd) {
    let out = String(text);
    out = out.replace(/\{\{\s*date\s*\}\}/g, localDate());
    out = out.replace(/\{workspace\}/g, cwd);
    out = out.replace(/\{dataDir\}/g, cwd + "/output");
    out = out.replace(/\{fileDir\}/g, cwd + "/doc/ai");
    return out;
  }
  function normalizeFiles(raw) {
    if (typeof raw === "string") {
      const one = raw.trim();
      return one.length > 0 ? [one] : [];
    }
    if (Array.isArray(raw)) {
      const out = [];
      for (const item of raw) {
        if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
      }
      return out;
    }
    return [];
  }
  async function loadWorkspace(cwd) {
    const target = await fs.resolve(".deepseek.yaml", { cwd });
    const text = await fs.readText(target);
    const parsed = parseYaml(text);
    const ws = parsed && parsed.workspace && typeof parsed.workspace === "object" ? parsed.workspace : {};
    const prompts = ws.system_prompts && typeof ws.system_prompts === "object" ? ws.system_prompts : null;
    const profiles = prompts === null ? [] : Object.keys(prompts).map((name2) => {
      const entry = prompts[name2];
      if (!entry || typeof entry !== "object") return null;
      const files = normalizeFiles(entry.file);
      if (files.length === 0) return null;
      return {
        name: name2,
        // 显示名：档案子项可选 name 字段；缺省回退为档案 key（下拉框显示 profile-<title>）
        title: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : name2,
        // file 向后兼容旧消费者：单文件=字符串，多文件=数组
        file: files.length === 1 ? files[0] : files,
        // files 恒为字符串数组：多文件档案按此顺序合并
        files,
        parameters: entry.parameters && typeof entry.parameters === "object" ? entry.parameters : {}
      };
    }).filter((p) => p !== null);
    const raw = ws.global_prompt;
    const globalPrompt = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
    return { profiles, globalPrompt };
  }
  async function profileText(profile, cwd) {
    const files = profile.files;
    const parts = [];
    for (let i = 0; i < files.length; i++) {
      let raw;
      try {
        const target = await fs.resolve(files[i], { cwd });
        raw = await fs.readText(target);
      } catch (err) {
        throw new Error("\u6863\u6848\u300C" + profile.name + "\u300D\u7684\u7B2C " + (i + 1) + "/" + files.length + " \u4E2A\u63D0\u793A\u8BCD\u6587\u4EF6\u8BFB\u53D6\u5931\u8D25: " + files[i] + "\uFF08\u5DE5\u4F5C\u533A " + cwd + "\uFF09: " + String(err && err.message || err));
      }
      parts.push(substitute(raw, cwd));
    }
    const body = parts.join("\n\n");
    return "\u3010\u5F53\u524D\u4F1A\u8BDD\u5DF2\u901A\u8FC7\u754C\u9762\u9009\u62E9 .deepseek.yaml \u63D0\u793A\u8BCD\u6863\u6848\u300C" + profile.name + "\u300D\uFF0C\u4EE5\u4E0B\u4E3A\u8BE5\u6863\u6848\u7684\u5B8C\u6574\u6307\u4EE4\uFF0C\u8BF7\u4EE5\u5176\u4E2D\u7684\u89D2\u8272\u8BBE\u5B9A\u4E0E\u4EFB\u52A1\u8981\u6C42\u4E3A\u51C6\u6267\u884C\u3011\n\n" + body;
  }
  function unapplyIdentity(sessionId) {
    const prev = identity.get(sessionId);
    if (!prev) return 0;
    let cleaned = 0;
    try {
      prev.disposer();
    } catch (e) {
    }
    try {
      if (prev.sp && prev.agent) cleaned = forceCleanSection(prev.sp, prev.agent, IDENTITY_SECTION);
    } catch (e) {
    }
    identity.delete(sessionId);
    return cleaned;
  }
  async function applyIdentity(agent, sessionId, explicitCwd) {
    const cwd = agentCwd(agent) || sessionCwd(sessionId, explicitCwd);
    if (!cwd) return { applied: false, file: null, cleaned: 0, error: "\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u672A\u5C31\u7EEA\uFF08\u65E0\u6CD5\u89E3\u6790 cwd\uFF09" };
    let rel;
    try {
      rel = (await loadWorkspace(cwd)).globalPrompt;
    } catch (err) {
      const cleaned2 = unapplyIdentity(sessionId);
      return { applied: false, file: null, cleaned: cleaned2, error: "\u8BFB\u53D6 .deepseek.yaml \u5931\u8D25: " + String(err && err.message || err) };
    }
    if (!rel) return { applied: false, file: null, cleaned: unapplyIdentity(sessionId), error: null };
    let text;
    try {
      const target = await fs.resolve(rel, { cwd });
      text = substitute(await fs.readText(target), cwd).trim();
    } catch (err) {
      const cleaned2 = unapplyIdentity(sessionId);
      const msg = "global_prompt \u6587\u4EF6\u8BFB\u53D6\u5931\u8D25: " + rel + "\uFF08\u5DE5\u4F5C\u533A " + cwd + "\uFF09";
      warn(msg + " \u2014 " + String(err && err.message || err));
      return { applied: false, file: rel, cleaned: cleaned2, error: msg };
    }
    if (text.length === 0) {
      return { applied: false, file: rel, cleaned: unapplyIdentity(sessionId), error: "global_prompt \u6587\u4EF6\u4E3A\u7A7A\uFF0C\u4FDD\u7559 DSH \u9ED8\u8BA4\u5F00\u573A\u767D" };
    }
    let sp;
    try {
      sp = agent.ctx.systemPrompt;
    } catch (e) {
      return { applied: false, file: rel, cleaned: 0, error: String(e && e.message || e) };
    }
    if (!sp) return { applied: false, file: rel, cleaned: 0, error: "\u76EE\u6807\u4F1A\u8BDD\u65E0 systemPrompt \u670D\u52A1" };
    const cleaned = unapplyIdentity(sessionId) + forceCleanSection(sp, agent, IDENTITY_SECTION);
    try {
      const disposer = sp.section({ name: IDENTITY_SECTION, order: IDENTITY_ORDER, text });
      identity.set(sessionId, { disposer, sp, agent, file: rel });
      return { applied: true, file: rel, cleaned, error: null };
    } catch (err) {
      const msg = "\u6CE8\u518C " + IDENTITY_SECTION + " \u8986\u76D6\u5931\u8D25: " + String(err && err.message || err) + " [diag: " + sectionDiag(sp, agent, IDENTITY_SECTION) + "]";
      warn(msg);
      return { applied: false, file: rel, cleaned, error: msg };
    }
  }
  async function sessionExists(sessionId) {
    try {
      const sessionsSvc = ctx.get("sessions");
      if (sessionsSvc && sessionsSvc.get(sessionId)) return true;
      const persistence = ctx.get("sessionPersistence");
      if (persistence && typeof persistence.list === "function") {
        const list = await persistence.list();
        return Array.isArray(list) && list.some((s) => {
          const id = s && s.header ? s.header.id : s && s.id;
          return id === sessionId;
        });
      }
      return false;
    } catch (e) {
      return true;
    }
  }
  async function persistedCwd(sessionId) {
    try {
      const persistence = ctx.get("sessionPersistence");
      if (!persistence || typeof persistence.list !== "function") return null;
      const list = await persistence.list();
      if (!Array.isArray(list)) return null;
      const hit = list.find((s) => {
        const id = s && s.header ? s.header.id : s && s.id;
        return id === sessionId;
      });
      const cwd = hit && hit.header ? hit.header.cwd : null;
      return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
    } catch (e) {
      return null;
    }
  }
  async function resolveCwd(sessionId, explicitCwd) {
    const direct = sessionCwd(sessionId, explicitCwd);
    if (direct) return direct;
    const stored = sessionId ? await persistedCwd(sessionId) : null;
    if (stored) {
      cwdCache.set(sessionId, stored);
      return stored;
    }
    return null;
  }
  function isSubagentSession(agent) {
    try {
      const header = agent && agent.session && agent.session.header;
      return !!(header && header.origin === "subagent");
    } catch (e) {
      return false;
    }
  }
  function parentSessionOf(agent) {
    try {
      const header = agent && agent.session && agent.session.header;
      const parent = header && header.parentSession;
      return typeof parent === "string" && parent.length > 0 ? parent : null;
    } catch (e) {
      return null;
    }
  }
  async function inheritedProfile(parentSessionId, cwd) {
    const parentChoice = (parentSessionId ? active.get(parentSessionId) : void 0) || (parentSessionId ? pending.get(parentSessionId) : void 0);
    const chosen = parentChoice ? parentChoice.profileName || parentChoice.profile : null;
    if (chosen) return { name: chosen, source: "parent" };
    const profiles = (await loadWorkspace(cwd)).profiles;
    if (profiles.length === 0) return { name: null, source: "none" };
    const fallback = profiles.some((p) => p.name === "default") ? "default" : profiles[0].name;
    return { name: fallback, source: "default" };
  }
  async function applyActivation(agent, sessionId, name2, explicitCwd) {
    const cwd = sessionCwd(sessionId, explicitCwd);
    if (!cwd) return { ok: false, error: "\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u672A\u5C31\u7EEA\uFF08\u65E0\u6CD5\u89E3\u6790 cwd\uFF09" };
    const existing = active.get(sessionId);
    if (existing && existing.profileName === name2) {
      return { ok: true, profile: name2, temperature: existing.temperature };
    }
    if (existing) {
      try {
        existing.disposer();
      } catch (e) {
      }
      try {
        if (existing.disposeTemp) existing.disposeTemp();
      } catch (e) {
      }
      active.delete(sessionId);
    }
    if (!name2) return { ok: true, profile: null };
    const profiles = (await loadWorkspace(cwd)).profiles;
    const profile = profiles.find((p) => p.name === name2);
    if (!profile) return { ok: false, error: "\u672A\u77E5\u6863\u6848: " + name2 + "\uFF08\u5DE5\u4F5C\u533A " + cwd + "\uFF09" };
    const text = await profileText(profile, cwd);
    let sp;
    try {
      sp = agent.ctx.systemPrompt;
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
    if (!sp) return { ok: false, error: "\u76EE\u6807\u4F1A\u8BDD\u65E0 systemPrompt \u670D\u52A1" };
    const removed = forceCleanSection(sp, agent, SECTION_NAME);
    const disposer = sp.section({ name: SECTION_NAME, order: SECTION_ORDER, text });
    const params = profile.parameters && typeof profile.parameters === "object" ? profile.parameters : {};
    const hasTemp = typeof params.temperature === "number" && Number.isFinite(params.temperature);
    let disposeTemp = null;
    if (agent.ctx && typeof agent.ctx.on === "function") {
      disposeTemp = agent.ctx.on("agent/request", async (_payload, next) => {
        const resolved = await next();
        if (!resolved || typeof resolved !== "object") return resolved;
        if (hasTemp) return Object.assign({}, resolved, { temperature: params.temperature });
        const rest = Object.assign({}, resolved);
        delete rest.temperature;
        return rest;
      });
    }
    active.set(sessionId, { profileName: name2, disposer, disposeTemp, temperature: hasTemp ? params.temperature : null, sp, agent });
    return { ok: true, profile: name2, temperature: hasTemp ? params.temperature : null, cleaned: removed };
  }
  handles.push(rpc.handle(rpcPrefix + ".profiles", async (args) => {
    try {
      const cwd = await resolveCwd(args && args.sessionId, args && args.cwd);
      if (!cwd) return { profiles: [], globalPrompt: null, error: "\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u672A\u5C31\u7EEA\uFF08\u65E0\u6CD5\u89E3\u6790 cwd\uFF0CsessionId=" + (args && args.sessionId) + "\uFF09", cwd: null };
      const ws = await loadWorkspace(cwd);
      return { profiles: ws.profiles, globalPrompt: ws.globalPrompt, cwd };
    } catch (err) {
      return { profiles: [], globalPrompt: null, error: String(err && err.message || err), cwd: null };
    }
  }));
  handles.push(rpc.handle(rpcPrefix + ".state", async (args) => {
    const sessionId = args && args.sessionId;
    const entry = sessionId ? active.get(sessionId) : void 0;
    const queued = sessionId ? pending.get(sessionId) : void 0;
    const ident = sessionId ? identity.get(sessionId) : void 0;
    return {
      active: entry ? entry.profileName : queued ? queued.profile : null,
      globalPrompt: ident ? ident.file : null
    };
  }));
  const stopCreated = ctx.on("agent/created", async ({ agent }) => {
    const sessionId = agent && agent.id;
    if (!sessionId) return;
    try {
      const applied = await applyIdentity(agent, sessionId);
      if (applied && applied.error) warn("\u4F1A\u8BDD " + sessionId + " \u5F00\u573A\u767D\u8986\u76D6\u672A\u751F\u6548: " + applied.error);
    } catch (err) {
      warn("\u4F1A\u8BDD " + sessionId + " \u5F00\u573A\u767D\u8986\u76D6\u5F02\u5E38: " + String(err && err.message || err));
    }
    const req = pending.get(sessionId);
    if (req) {
      pending.delete(sessionId);
      return enqueue(sessionId, async () => {
        try {
          await applyActivation(agent, sessionId, req.profile, req.cwd);
        } catch (err) {
          warn("\u5EF6\u8FDF\u6FC0\u6D3B\u5931\u8D25: " + String(err && err.message || err));
        }
      });
    }
    if (!isSubagentSession(agent)) return;
    try {
      const cwd = agentCwd(agent) || sessionCwd(sessionId);
      if (!cwd) return;
      cwdCache.set(sessionId, cwd);
      const pick = await inheritedProfile(parentSessionOf(agent), cwd);
      if (!pick.name) return;
      await enqueue(sessionId, async () => {
        try {
          const applied = await applyActivation(agent, sessionId, pick.name, cwd);
          if (!applied.ok) warn("\u5B50\u4EE3\u7406\u4F1A\u8BDD " + sessionId + " \u6863\u6848\u7EE7\u627F\u5931\u8D25: " + applied.error);
        } catch (err) {
          warn("\u5B50\u4EE3\u7406\u4F1A\u8BDD " + sessionId + " \u6863\u6848\u7EE7\u627F\u5F02\u5E38: " + String(err && err.message || err));
        }
      });
    } catch (err) {
      warn("\u5B50\u4EE3\u7406\u4F1A\u8BDD " + sessionId + " \u6863\u6848\u7EE7\u627F\u5F02\u5E38: " + String(err && err.message || err));
    }
  });
  handles.push(stopCreated);
  handles.push(rpc.handle(rpcPrefix + ".activate", async (args) => {
    const sessionId = args && args.sessionId;
    if (!sessionId) return { ok: false, error: "missing sessionId" };
    const name2 = args.profile;
    const explicitCwd = args && args.cwd;
    return enqueue(sessionId, async () => {
      try {
        const agent = agents.get(sessionId);
        if (!agent) {
          if (name2) pending.set(sessionId, { profile: name2, cwd: explicitCwd });
          else pending.delete(sessionId);
          if (!await sessionExists(sessionId)) {
            warn("\u4F1A\u8BDD " + sessionId + " \u672A\u6FC0\u6D3B\u4E14\u67E5\u4E0D\u5230\u6301\u4E45\u5316\u8BB0\u5F55\uFF1A\u6863\u6848\u300C" + (name2 || "\u7A7A") + "\u300D\u5DF2\u6392\u961F\uFF0C\u5F85 agent \u521B\u5EFA\u540E\u5E94\u7528");
          }
          return { ok: true, profile: name2 || null, pending: true, temperature: null };
        }
        const ident = await applyIdentity(agent, sessionId, explicitCwd);
        const result = await applyActivation(agent, sessionId, name2, explicitCwd);
        return Object.assign({}, result, { globalPrompt: ident && ident.applied ? ident.file : null });
      } catch (err) {
        const msg = String(err && err.message || err);
        let extra = "";
        try {
          const agent = agents.get(sessionId);
          const sp = agent && agent.ctx ? agent.ctx.systemPrompt : void 0;
          extra = " [diag: " + sectionDiag(sp, agent, SECTION_NAME) + "]";
        } catch (e) {
        }
        return { ok: false, error: msg + extra };
      }
    });
  }));
  ctx.on("dispose", () => {
    for (const entry of active.values()) {
      try {
        entry.disposer();
      } catch (e) {
      }
      try {
        if (entry.disposeTemp) entry.disposeTemp();
      } catch (e) {
      }
      try {
        if (entry.sp && entry.agent) forceCleanSection(entry.sp, entry.agent, SECTION_NAME);
      } catch (e) {
      }
    }
    active.clear();
    pending.clear();
    for (const entry of identity.values()) {
      try {
        entry.disposer();
      } catch (e) {
      }
      try {
        if (entry.sp && entry.agent) forceCleanSection(entry.sp, entry.agent, IDENTITY_SECTION);
      } catch (e) {
      }
    }
    identity.clear();
    for (const d of handles) {
      try {
        d();
      } catch (e) {
      }
    }
  });
}

// src/static/host.js
var name = "dsh-profile-selector";
var inject = ["connection", "webServer"];
function apply(ctx) {
  const connection = ctx.get("connection");
  if (connection === void 0) return;
  const routes = /* @__PURE__ */ new Map();
  let registered = false;
  hostCore(ctx, {
    sectionName: "dsh-profile:profile-static",
    rpcPrefix: "dshprofile-static"
  }, {
    // 适配器：登记 method，并在首次登记时注册 /rpc 通道（幂等）
    handle: (method, handler) => {
      routes.set(method, handler);
      if (registered) return () => {
        routes.delete(method);
      };
      registered = true;
      const dispose = connection.register(ctx, "/rpc", async (endpoint, payload) => {
        const route = routes.get(endpoint);
        if (!route) return { ok: false, error: { code: "not-found", message: "\u672A\u77E5\u65B9\u6CD5: " + String(endpoint) } };
        try {
          return { ok: true, value: await route(payload) };
        } catch (error) {
          return { ok: false, error: { code: "internal", message: String(error && error.message || error) } };
        }
      });
      return () => {
        routes.delete(method);
        if (routes.size === 0 && registered) {
          registered = false;
          try {
            dispose();
          } catch (e) {
          }
        }
      };
    }
  });
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
