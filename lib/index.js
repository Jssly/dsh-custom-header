// src/static/host.js
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

// src/core/settings.js
var SETTINGS_KEYS = ["global_prompt", "persona_clear", "includeHarnessIdentity"];
var KEY_TYPES = {
  global_prompt: "string",
  persona_clear: "boolean",
  includeHarnessIdentity: "boolean"
};
var DEFAULT_SETTINGS = Object.freeze({
  global_prompt: "",
  persona_clear: true,
  includeHarnessIdentity: false
});
function normalizeLayer(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const key of SETTINGS_KEYS) {
    if (KEY_TYPES[key] === "string") {
      if (typeof raw[key] === "string") out[key] = raw[key].trim();
    } else if (typeof raw[key] === "boolean") {
      out[key] = raw[key];
    }
  }
  return out;
}
function mergeLayers(...layers) {
  const out = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of SETTINGS_KEYS) {
      if (layer[key] !== void 0) out[key] = layer[key];
    }
  }
  return out;
}
function resolveSettings(pluginLayer, workspaceLayer) {
  return mergeLayers(DEFAULT_SETTINGS, pluginLayer, workspaceLayer);
}
function settingsSources(pluginLayer, workspaceLayer) {
  const out = {};
  for (const key of SETTINGS_KEYS) {
    if (workspaceLayer && workspaceLayer[key] !== void 0) out[key] = "workspace";
    else if (pluginLayer && pluginLayer[key] !== void 0) out[key] = "plugin";
    else out[key] = "default";
  }
  return out;
}

// src/core/patch.js
var SETTINGS_BLOCK_BEGIN = "# >>> dsh-profile-selector:settings:begin";
var SETTINGS_BLOCK_END = "# <<< dsh-profile-selector:settings:end";
var MANAGED_ROW_ID = "dsh-profile-selector";
var KEYS = SETTINGS_KEYS;
function isMarkerLine(line, marker) {
  return typeof line === "string" && line.trim() === marker;
}
function locateBlock(lines) {
  let begin = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (begin < 0) {
      if (isMarkerLine(lines[i], SETTINGS_BLOCK_BEGIN)) begin = i;
      continue;
    }
    if (isMarkerLine(lines[i], SETTINGS_BLOCK_END)) {
      end = i;
      break;
    }
  }
  if (begin < 0) {
    if (lines.some((line) => isMarkerLine(line, SETTINGS_BLOCK_END))) {
      throw new Error("cordis.patch.yml \u4E2D dsh-profile-selector \u53D7\u7BA1\u5757\u6807\u8BB0\u4E0D\u5B8C\u6574\uFF08\u53EA\u627E\u5230\u7ED3\u675F\u6807\u8BB0\uFF09");
    }
    return { begin: -1, end: -1 };
  }
  if (end < 0) throw new Error("cordis.patch.yml \u4E2D dsh-profile-selector \u53D7\u7BA1\u5757\u6807\u8BB0\u4E0D\u5B8C\u6574\uFF08\u53EA\u627E\u5230\u8D77\u59CB\u6807\u8BB0\uFF09");
  return { begin, end };
}
function canonicalSettings(values) {
  const v = values && typeof values === "object" ? values : {};
  const out = {};
  for (const key of KEYS) {
    out[key] = key === "global_prompt" ? typeof v[key] === "string" ? v[key] : "" : v[key] === true;
  }
  return out;
}
function requireYaml(yaml) {
  if (!yaml || typeof yaml.parse !== "function" || typeof yaml.stringify !== "function") {
    throw new Error("yaml \u80FD\u529B\u672A\u6CE8\u5165\uFF08\u9759\u6001\u58F3\u5E94\u4F20 import * as YAML from 'yaml' \u7684\u7ED3\u679C\uFF09");
  }
  return yaml;
}
function generateSettingsBlock(values, yaml) {
  const lib = requireYaml(yaml);
  const body = lib.stringify([{ id: MANAGED_ROW_ID, config: canonicalSettings(values) }], { indent: 2, lineWidth: 0 });
  return SETTINGS_BLOCK_BEGIN + "\n" + String(body).replace(/\n+$/, "") + "\n" + SETTINGS_BLOCK_END + "\n";
}
function replaceManagedBlock(raw, block) {
  const text = String(raw);
  const body = typeof block === "string" ? block : "";
  const lines = text.split("\n");
  const { begin, end } = locateBlock(lines);
  const blockLines = body === "" ? [] : body.replace(/\n$/, "").split("\n");
  if (begin >= 0) {
    const next = [...lines.slice(0, begin), ...blockLines, ...lines.slice(end + 1)].join("\n");
    if (blockLines.length > 0) return next;
    const meaningful2 = next.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
    if (meaningful2.length === 0) return next.replace(/\s*$/, "") + "\n[]\n";
    return next;
  }
  if (blockLines.length === 0) return text;
  const meaningful = lines.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (meaningful.length === 1 && meaningful[0] === "[]") {
    const index = lines.findIndex((l) => l.trim() === "[]");
    return [...lines.slice(0, index), ...blockLines, ...lines.slice(index + 1)].join("\n");
  }
  const prefix = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return text + prefix + body;
}
function externalLines(text) {
  const lines = String(text).split("\n");
  const { begin, end } = locateBlock(lines);
  const ext = begin < 0 ? lines : [...lines.slice(0, begin), ...lines.slice(end + 1)];
  while (ext.length > 0 && ext[ext.length - 1].trim() === "") ext.pop();
  return ext;
}
function applySettingsToPatch(raw, values, yaml) {
  const lib = requireYaml(yaml);
  const text = String(raw);
  const next = replaceManagedBlock(text, generateSettingsBlock(values, lib));
  if (JSON.stringify(externalLines(text)) !== JSON.stringify(externalLines(next))) {
    throw new Error("\u5199\u5165\u4E2D\u6B62\uFF1A\u53D7\u7BA1\u5757\u4E4B\u5916\u7684\u5185\u5BB9\u5C06\u88AB\u6539\u52A8\uFF08\u539F\u6587\u4EF6\u672A\u52A8\uFF09");
  }
  return next;
}

// src/core/host.js
function hostCore(ctx, opts, rpc, deps) {
  const env = deps || {};
  const fs = ctx.get("fs");
  const sandboxPolicy = ctx.get("sandboxPolicy");
  const agents = ctx.get("agents");
  if (fs === void 0 || sandboxPolicy === void 0 || agents === void 0) return;
  const SECTION_NAME = opts.sectionName;
  const SECTION_ORDER = -50;
  const IDENTITY_SECTION = "harness:identity";
  const IDENTITY_ORDER = -1e3;
  const PERSONA_SECTION = "deployment:persona-prefix";
  const rpcPrefix = opts.rpcPrefix;
  const active = /* @__PURE__ */ new Map();
  const identity = /* @__PURE__ */ new Map();
  const persona = /* @__PURE__ */ new Map();
  const warnedOnce = /* @__PURE__ */ new Set();
  const cwdCache = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const chains = /* @__PURE__ */ new Map();
  const handles = [];
  const yamlLib = env.yaml && typeof env.yaml.parse === "function" && typeof env.yaml.stringify === "function" ? env.yaml : null;
  const patchPath = typeof env.patchPath === "string" && env.patchPath.length > 0 ? env.patchPath : null;
  let pluginLayer = normalizeLayer(env.config);
  let saveChain = Promise.resolve();
  function warn(message) {
    try {
      if (ctx.logger && typeof ctx.logger.warn === "function") ctx.logger.warn("[dsh-profile-selector] " + message);
    } catch (e) {
    }
  }
  function warnOnce(key, message) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    warn(message);
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
  function parseWorkspaceYaml(text, target) {
    if (yamlLib === null) throw new Error("yaml \u5E93\u4E0D\u53EF\u7528\uFF08\u672A\u6CE8\u5165\uFF09\uFF0C\u65E0\u6CD5\u89E3\u6790 " + target);
    try {
      return yamlLib.parse(String(text)) ?? {};
    } catch (err) {
      throw new Error("YAML \u89E3\u6790\u5931\u8D25: " + target + " \u2014 " + String(err && err.message || err));
    }
  }
  async function loadWorkspace(cwd) {
    const target = await fs.resolve(".deepseek.yaml", { cwd });
    const text = await fs.readText(target);
    const parsed = parseWorkspaceYaml(text, target);
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
    const settings = normalizeLayer(ws);
    const rawPersona = ws.persona_prompt;
    const personaPrompt = typeof rawPersona === "string" && rawPersona.trim().length > 0 ? rawPersona.trim() : null;
    return { profiles, settings, personaPrompt };
  }
  function effectiveSettingsFrom(workspaceLayer) {
    return {
      values: resolveSettings(pluginLayer, workspaceLayer),
      sources: settingsSources(pluginLayer, workspaceLayer)
    };
  }
  async function effectiveSettings(cwd) {
    let workspaceLayer = null;
    try {
      workspaceLayer = (await loadWorkspace(cwd)).settings;
    } catch (err) {
      workspaceLayer = null;
    }
    return effectiveSettingsFrom(workspaceLayer);
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
  async function resolveIdentity(cwd) {
    let values = resolveSettings(pluginLayer, null);
    try {
      values = (await effectiveSettings(cwd)).values;
    } catch (e) {
    }
    const configured = typeof values.global_prompt === "string" ? values.global_prompt.trim() : "";
    let warnText = null;
    let file = null;
    if (configured.length > 0) {
      file = configured;
      try {
        const target = await fs.resolve(configured, { cwd });
        const text = substitute(await fs.readText(target), cwd).trim();
        if (text.length > 0) return { text, file, warn: null };
        warnText = "global_prompt \u6587\u4EF6\u4E3A\u7A7A: " + configured + "\uFF08\u5DE5\u4F5C\u533A " + cwd + "\uFF09\u2014\u2014 \u6309 includeHarnessIdentity \u5F00\u5173\u5904\u7406";
      } catch (err) {
        warnText = "global_prompt \u6587\u4EF6\u8BFB\u53D6\u5931\u8D25: " + configured + "\uFF08\u5DE5\u4F5C\u533A " + cwd + "\uFF09\u2014 " + String(err && err.message || err) + " \u2014\u2014 \u6309 includeHarnessIdentity \u5F00\u5173\u5904\u7406";
      }
    }
    if (values.includeHarnessIdentity === false) return { text: "", file, warn: warnText };
    return { text: null, file, warn: warnText };
  }
  async function applyIdentity(agent, sessionId, explicitCwd) {
    const cwd = agentCwd(agent) || sessionCwd(sessionId, explicitCwd);
    if (!cwd) return { applied: false, mode: "keep", file: null, cleaned: 0, error: "\u4F1A\u8BDD\u5DE5\u4F5C\u533A\u672A\u5C31\u7EEA\uFF08\u65E0\u6CD5\u89E3\u6790 cwd\uFF09" };
    let resolved;
    try {
      resolved = await resolveIdentity(cwd);
    } catch (err) {
      const cleaned2 = unapplyIdentity(sessionId);
      return { applied: false, mode: "keep", file: null, cleaned: cleaned2, error: "\u8BFB\u53D6 .deepseek.yaml \u5931\u8D25: " + String(err && err.message || err) };
    }
    if (resolved.warn) warnOnce("identity:" + cwd + ":" + String(resolved.file), resolved.warn);
    if (resolved.text === null) {
      return { applied: false, mode: "keep", file: resolved.file, cleaned: unapplyIdentity(sessionId), error: null };
    }
    let sp;
    try {
      sp = agent.ctx.systemPrompt;
    } catch (e) {
      return { applied: false, mode: "keep", file: resolved.file, cleaned: 0, error: String(e && e.message || e) };
    }
    if (!sp) return { applied: false, mode: "keep", file: resolved.file, cleaned: 0, error: "\u76EE\u6807\u4F1A\u8BDD\u65E0 systemPrompt \u670D\u52A1" };
    const cleaned = unapplyIdentity(sessionId) + forceCleanSection(sp, agent, IDENTITY_SECTION);
    const mode = resolved.text.length > 0 ? "text" : "blank";
    try {
      const disposer = sp.section({ name: IDENTITY_SECTION, order: IDENTITY_ORDER, text: resolved.text });
      identity.set(sessionId, { disposer, sp, agent, file: resolved.file, mode });
      return { applied: true, mode, file: resolved.file, cleaned, error: null };
    } catch (err) {
      const msg = "\u6CE8\u518C " + IDENTITY_SECTION + " \u8986\u76D6\u5931\u8D25: " + String(err && err.message || err) + " [diag: " + sectionDiag(sp, agent, IDENTITY_SECTION) + "]";
      warn(msg);
      return { applied: false, mode: "keep", file: resolved.file, cleaned, error: msg };
    }
  }
  async function refreshSessions() {
    let list = [];
    try {
      if (typeof agents.list === "function") list = agents.list() || [];
    } catch (e) {
      list = [];
    }
    for (const agent of list) {
      const sessionId = agent && agent.id;
      if (!sessionId) continue;
      try {
        await applyIdentity(agent, sessionId);
      } catch (err) {
        warn("\u4F1A\u8BDD " + sessionId + " \u8BBE\u7F6E\u53D8\u66F4\u540E\u91CD\u7B97\u5F00\u573A\u767D\u5931\u8D25: " + String(err && err.message || err));
      }
    }
  }
  async function resolvePromptOverrides(cwd) {
    let ws = null;
    try {
      ws = await loadWorkspace(cwd);
    } catch (err) {
      ws = null;
    }
    const workspaceLayer = ws ? ws.settings : null;
    const values = resolveSettings(pluginLayer, workspaceLayer);
    const out = {};
    if (workspaceLayer && workspaceLayer.persona_clear === true) {
      out[PERSONA_SECTION] = "";
    } else if (ws && ws.personaPrompt) {
      try {
        const target = await fs.resolve(ws.personaPrompt, { cwd });
        out[PERSONA_SECTION] = substitute(await fs.readText(target), cwd).trim();
      } catch (err) {
        warnOnce("prompt:" + cwd + ":" + ws.personaPrompt, "persona_prompt \u6587\u4EF6\u8BFB\u53D6\u5931\u8D25\uFF08\u672C\u6B21\u4E0D\u6539\u5199\uFF0C\u4FDD\u7559 preset \u539F\u6709 persona\uFF09: " + ws.personaPrompt + "\uFF08\u5DE5\u4F5C\u533A " + cwd + "\uFF09: " + String(err && err.message || err));
      }
    } else if (values.persona_clear !== false) {
      out[PERSONA_SECTION] = "";
    }
    return out;
  }
  function installPromptOverride(agent, sessionId) {
    let agentCtx;
    try {
      agentCtx = agent && agent.ctx;
    } catch (e) {
      return null;
    }
    if (!agentCtx || typeof agentCtx.on !== "function") return null;
    const missedReported = /* @__PURE__ */ new Set();
    return agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      const assembled = await next();
      let cwd;
      try {
        cwd = agentCwd(agent) || sessionCwd(sessionId);
      } catch (e) {
        cwd = null;
      }
      if (!cwd) return assembled;
      const overrides = await resolvePromptOverrides(cwd);
      const names = Object.keys(overrides);
      if (names.length === 0 || !assembled || !Array.isArray(assembled.sections)) return assembled;
      const hit = /* @__PURE__ */ new Set();
      const sections = assembled.sections.map((section) => {
        if (!section || !Object.prototype.hasOwnProperty.call(overrides, section.name)) return section;
        hit.add(section.name);
        return { ...section, text: overrides[section.name] };
      });
      for (const name2 of names) {
        if (hit.has(name2) || missedReported.has(name2)) continue;
        missedReported.add(name2);
        warnOnce("miss:" + sessionId + ":" + name2, "\u88C5\u914D\u7ED3\u679C\u91CC\u6CA1\u6709 " + name2 + " \u6BB5\uFF08DSH \u6BB5\u540D\u53D8\u66F4\uFF0C\u6216\u8BE5 preset \u672A\u6302\u8BE5\u884C\uFF09\u2014\u2014 \u4E0E\u5B83\u76F8\u5173\u7684\u8BBE\u7F6E\u672C\u6B21\u672A\u751F\u6548\uFF0C\u4F1A\u8BDD " + sessionId);
      }
      return hit.size === 0 ? assembled : { ...assembled, sections };
    });
  }
  function applyPersona(agent, sessionId) {
    unapplyPersona(sessionId);
    let disposer;
    try {
      disposer = installPromptOverride(agent, sessionId);
    } catch (err) {
      const msg = "\u6302 " + PERSONA_SECTION + " \u88C5\u914D\u76D1\u542C\u5668\u5931\u8D25: " + String(err && err.message || err);
      warn(msg);
      return { installed: false, error: msg };
    }
    if (!disposer) return { installed: false, error: "\u76EE\u6807\u4F1A\u8BDD\u65E0 agent.ctx\uFF08\u65E0\u6CD5\u6302\u88C5\u914D\u76D1\u542C\u5668\uFF09" };
    persona.set(sessionId, { disposer, agent });
    return { installed: true, error: null };
  }
  function unapplyPersona(sessionId) {
    const prev = persona.get(sessionId);
    if (!prev) return;
    try {
      prev.disposer();
    } catch (e) {
    }
    persona.delete(sessionId);
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
      const merged = effectiveSettingsFrom(ws.settings);
      const globalPrompt = merged.values.global_prompt.length > 0 ? merged.values.global_prompt : null;
      return { profiles: ws.profiles, globalPrompt, sources: merged.sources, cwd };
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
      globalPrompt: ident ? ident.file : null,
      identityMode: ident ? ident.mode : "keep"
    };
  }));
  handles.push(rpc.handle(rpcPrefix + ".settings", async () => ({
    values: resolveSettings(pluginLayer, null),
    defaults: Object.assign({}, DEFAULT_SETTINGS),
    keys: SETTINGS_KEYS.slice(),
    patchPath,
    writable: patchPath !== null && typeof env.writeText === "function"
  })));
  handles.push(rpc.handle(rpcPrefix + ".settings.set", async (args) => {
    const raw = args && args.values;
    if (!raw || typeof raw !== "object") return { ok: false, error: "missing values" };
    const next = normalizeLayer(raw);
    for (const key of SETTINGS_KEYS) {
      if (next[key] === void 0) return { ok: false, error: "\u5B57\u6BB5 " + key + " \u7F3A\u5931\u6216\u7C7B\u578B\u4E0D\u6B63\u786E" };
    }
    pluginLayer = next;
    const values = resolveSettings(pluginLayer, null);
    let warning = null;
    let written = false;
    if (patchPath !== null && typeof env.writeText === "function") {
      const task = saveChain.then(async () => {
        const before = typeof env.readText === "function" ? await env.readText(patchPath) : "";
        const after = applySettingsToPatch(before, pluginLayer, yamlLib);
        await env.writeText(patchPath, after);
      });
      saveChain = task.catch(() => {
      });
      try {
        await task;
        written = true;
      } catch (err) {
        warning = "\u8BBE\u7F6E\u5DF2\u5728\u672C\u6B21\u8FD0\u884C\u751F\u6548\uFF0C\u4F46\u5199\u5165 " + patchPath + " \u5931\u8D25\uFF08\u91CD\u542F\u540E\u4F1A\u56DE\u9000\uFF09: " + String(err && err.message || err);
        warn(warning);
      }
    } else {
      warning = "\u5F53\u524D\u73AF\u5883\u6CA1\u6709\u53EF\u5199\u7684 patch \u6587\u4EF6\uFF0C\u8BBE\u7F6E\u53EA\u5728\u672C\u6B21\u8FD0\u884C\u751F\u6548\uFF08\u91CD\u542F\u540E\u56DE\u9000\uFF09";
    }
    try {
      await refreshSessions();
    } catch (err) {
      warn("\u8BBE\u7F6E\u53D8\u66F4\u540E\u5237\u65B0\u4F1A\u8BDD\u5931\u8D25: " + String(err && err.message || err));
    }
    return { ok: true, values, patchPath, writable: written, warning };
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
    try {
      const pinned = applyPersona(agent, sessionId);
      if (!pinned.installed) warn("\u4F1A\u8BDD " + sessionId + " persona \u6BB5\u8986\u76D6\u672A\u6302\u8F7D: " + pinned.error);
    } catch (err) {
      warn("\u4F1A\u8BDD " + sessionId + " persona \u6BB5\u8986\u76D6\u5F02\u5E38: " + String(err && err.message || err));
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
        return Object.assign({}, result, {
          globalPrompt: ident && ident.file ? ident.file : null,
          identityMode: ident ? ident.mode : "keep"
        });
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
    for (const entry of persona.values()) {
      try {
        entry.disposer();
      } catch (e) {
      }
    }
    persona.clear();
    warnedOnce.clear();
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
var PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
var PATCH_PATH = join(PACKAGE_DIR, "cordis.patch.yml");
async function readPatchText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return "";
    throw error;
  }
}
async function writePatchText(path, text) {
  const temp = join(dirname(path), "." + basename(path) + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8));
  try {
    await writeFile(temp, text, "utf8");
    try {
      await rename(temp, path);
    } catch (error) {
      const code = error && error.code;
      if (code !== "EPERM" && code !== "EEXIST" && code !== "EACCES") throw error;
      await rm(path, { force: true });
      await rename(temp, path);
    }
  } finally {
    await rm(temp, { force: true }).catch(() => {
    });
  }
}
function apply(ctx, config) {
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
  }, {
    config,
    patchPath: PATCH_PATH,
    readText: readPatchText,
    writeText: writePatchText,
    // YAML 能力：核心不做任何手写 YAML 语法处理，读写全部交给 yaml 库
    yaml: YAML
  });
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
