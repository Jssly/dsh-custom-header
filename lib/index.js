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
  const stack = [{ indent: -1, obj: root }];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)[0].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const content = line.slice(indent);
    const m = content.match(/^([^:#]+?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    const parent = stack[stack.length - 1].obj;
    if (value === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      parent[key] = parseScalar(value);
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
  const rpcPrefix = opts.rpcPrefix;
  const active = /* @__PURE__ */ new Map();
  const cwdCache = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const chains = /* @__PURE__ */ new Map();
  const handles = [];
  function sessionCwd(sessionId, explicitCwd) {
    if (typeof explicitCwd === "string" && explicitCwd.length > 0) {
      if (sessionId) cwdCache.set(sessionId, explicitCwd);
      return explicitCwd;
    }
    if (sessionId && cwdCache.has(sessionId)) return cwdCache.get(sessionId);
    if (sessionId) {
      try {
        const agent = agents.get(sessionId);
        const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd;
        if (typeof cwd === "string" && cwd.length > 0) {
          cwdCache.set(sessionId, cwd);
          return cwd;
        }
      } catch (e) {
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
  function forceCleanSection(sp, agent) {
    let removed = 0;
    try {
      const layers = sp && sp.layers;
      if (!layers) return removed;
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          if (key !== agent) continue;
          const s = layer && layer.sections;
          if (s && s.data && s.data.has(SECTION_NAME)) {
            s.data.delete(SECTION_NAME);
            removed++;
          }
        }
      }
      const g = layers.global && layers.global.sections;
      if (g && g.data && g.data.has(SECTION_NAME)) {
        g.data.delete(SECTION_NAME);
        removed++;
      }
    } catch (e) {
    }
    return removed;
  }
  function sectionDiag(sp, agent) {
    const parts = [];
    try {
      const layers = sp && sp.layers;
      if (!layers) return "no layers";
      let scopedHits = 0;
      let agentKeyHit = 0;
      if (layers.scoped && layers.scoped instanceof Map) {
        for (const [key, layer] of layers.scoped) {
          const s = layer && layer.sections;
          if (s && typeof s.has === "function" && s.has(SECTION_NAME)) {
            scopedHits++;
            if (key === agent) agentKeyHit++;
          }
        }
      }
      parts.push("scopedHits=" + scopedHits);
      parts.push("agentKeyHit=" + agentKeyHit);
      const g = layers.global && layers.global.sections;
      parts.push("globalHit=" + (g && typeof g.has === "function" ? g.has(SECTION_NAME) ? 1 : 0 : "na"));
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
  async function loadProfiles(cwd) {
    const target = await fs.resolve(".deepseek.yaml", { cwd });
    const text = await fs.readText(target);
    const parsed = parseYaml(text);
    const ws = parsed && parsed.workspace;
    const prompts = ws && ws.system_prompts;
    if (!prompts || typeof prompts !== "object") return [];
    return Object.keys(prompts).filter((name2) => prompts[name2] && typeof prompts[name2].file === "string").map((name2) => ({
      name: name2,
      // 显示名：档案子项可选 name 字段；缺省回退为档案 key（下拉框显示 profile-<title>）
      title: typeof prompts[name2].name === "string" && prompts[name2].name.length > 0 ? prompts[name2].name : name2,
      file: prompts[name2].file,
      parameters: prompts[name2].parameters && typeof prompts[name2].parameters === "object" ? prompts[name2].parameters : {}
    }));
  }
  async function profileText(profile, cwd) {
    const target = await fs.resolve(profile.file, { cwd });
    const raw = await fs.readText(target);
    const body = substitute(raw, cwd);
    return "\u3010\u5F53\u524D\u4F1A\u8BDD\u5DF2\u901A\u8FC7\u754C\u9762\u9009\u62E9 .deepseek.yaml \u63D0\u793A\u8BCD\u6863\u6848\u300C" + profile.name + "\u300D\uFF0C\u4EE5\u4E0B\u4E3A\u8BE5\u6863\u6848\u7684\u5B8C\u6574\u6307\u4EE4\uFF0C\u8BF7\u4EE5\u5176\u4E2D\u7684\u89D2\u8272\u8BBE\u5B9A\u4E0E\u4EFB\u52A1\u8981\u6C42\u4E3A\u51C6\u6267\u884C\u3011\n\n" + body;
  }
  async function sessionExists(sessionId) {
    try {
      const sessionsSvc = ctx.get("sessions");
      if (sessionsSvc && sessionsSvc.get(sessionId)) return true;
      const persistence = ctx.get("sessionPersistence");
      if (persistence && typeof persistence.list === "function") {
        const list = await persistence.list();
        return Array.isArray(list) && list.some((h) => h && h.id === sessionId);
      }
      return false;
    } catch (e) {
      return true;
    }
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
    const profiles = await loadProfiles(cwd);
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
    const removed = forceCleanSection(sp, agent);
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
      const cwd = sessionCwd(args && args.sessionId, args && args.cwd);
      if (!cwd) return { profiles: [], error: "\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u672A\u5C31\u7EEA\uFF08\u65E0\u6CD5\u89E3\u6790 cwd\uFF0CsessionId=" + (args && args.sessionId) + "\uFF09", cwd: null };
      const profiles = await loadProfiles(cwd);
      return { profiles, cwd };
    } catch (err) {
      return { profiles: [], error: String(err && err.message || err), cwd: null };
    }
  }));
  handles.push(rpc.handle(rpcPrefix + ".state", async (args) => {
    const sessionId = args && args.sessionId;
    const entry = sessionId ? active.get(sessionId) : void 0;
    const queued = sessionId ? pending.get(sessionId) : void 0;
    return { active: entry ? entry.profileName : queued ? queued.profile : null };
  }));
  const stopCreated = ctx.on("agent/created", ({ agent }) => {
    const sessionId = agent && agent.id;
    const req = sessionId ? pending.get(sessionId) : void 0;
    if (!req) return;
    pending.delete(sessionId);
    enqueue(sessionId, async () => {
      try {
        await applyActivation(agent, sessionId, req.profile, req.cwd);
      } catch (err) {
        try {
          if (ctx.logger && ctx.logger.warn) ctx.logger.warn("[dsh-profile-selector] \u5EF6\u8FDF\u6FC0\u6D3B\u5931\u8D25: " + String(err && err.message || err));
        } catch (e) {
        }
      }
    });
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
          if (!await sessionExists(sessionId)) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u672A\u6FC0\u6D3B" };
          if (name2) pending.set(sessionId, { profile: name2, cwd: explicitCwd });
          else pending.delete(sessionId);
          return { ok: true, profile: name2 || null, pending: true, temperature: null };
        }
        return await applyActivation(agent, sessionId, name2, explicitCwd);
      } catch (err) {
        const msg = String(err && err.message || err);
        let extra = "";
        try {
          const agent = agents.get(sessionId);
          const sp = agent && agent.ctx ? agent.ctx.systemPrompt : void 0;
          extra = " [diag: " + sectionDiag(sp, agent) + "]";
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
        if (entry.sp && entry.agent) forceCleanSection(entry.sp, entry.agent);
      } catch (e) {
      }
    }
    active.clear();
    pending.clear();
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
var inject = ["connection"];
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
      const dispose = connection.rpc.handle("/rpc", async (endpoint, payload) => {
        const route = routes.get(endpoint);
        if (!route) return { ok: false, error: { code: "not-found", message: "\u672A\u77E5\u65B9\u6CD5: " + String(endpoint) } };
        try {
          return { ok: true, value: await route(payload) };
        } catch (error) {
          return { ok: false, error: { code: "internal", message: String(error && error.message || error) } };
        }
      }, { authority: "loopback" });
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
