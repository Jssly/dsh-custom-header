window.__ModuleLoader__.load({ id: 'dsh-profile-selector', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/static/client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = __toESM(require("react"), 1);

// src/core/client.js
function clientCore(ctx, opts, deps) {
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  const React2 = deps.React;
  const call = deps.call;
  const insertCss2 = deps.insertCss;
  const css = opts.cssPrefix;
  insertCss2(
    "." + css + "-inline{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);height:26px;}." + css + "-inline select{font-size:11px;padding:1px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;max-width:150px;height:22px;}." + css + "-inline .err{color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24ch;}"
  );
  const autoFired = /* @__PURE__ */ new Set();
  function ProfileSelect(props) {
    const sessionId = props.sessionId;
    const useSessions = props.useSessions;
    const summary = typeof useSessions === "function" ? useSessions((s) => sessionId ? s.byId[sessionId] : void 0) : void 0;
    const cwd = summary ? summary.cwd : void 0;
    const summaryKnown = summary !== void 0;
    const isSubagent = !!(summary && summary.origin === "subagent");
    const [profiles, setProfiles] = React2.useState(null);
    const [active, setActive] = React2.useState(null);
    const [gp, setGp] = React2.useState(null);
    const [tip, setTip] = React2.useState(null);
    const [fatal, setFatal] = React2.useState(null);
    const [error, setError] = React2.useState(null);
    React2.useEffect(() => {
      let alive = true;
      call(opts.rpcPrefix + ".profiles", { sessionId, cwd }).then((r) => {
        if (!alive) return;
        if (r && !r.error) setFatal(null);
        if (r && Array.isArray(r.profiles)) setProfiles(r.profiles);
        if (r && typeof r.globalPrompt === "string" && r.globalPrompt.length > 0) setGp(r.globalPrompt);
        if (r && r.error) setFatal(String(r.error));
        if (r && Array.isArray(r.profiles) && r.profiles.length === 0 && !r.error) setFatal("\u672A\u627E\u5230 .deepseek.yaml \u7684 system_prompts");
      }).catch((err) => {
        if (alive) {
          setProfiles([]);
          setFatal("RPC \u5931\u8D25: " + String(err && err.message || err));
        }
      });
      call(opts.rpcPrefix + ".state", { sessionId }).then((r) => {
        if (alive && r) setActive(r.active || null);
      }).catch(() => {
      });
      return () => {
        alive = false;
      };
    }, [sessionId, cwd]);
    React2.useEffect(() => {
      if (!profiles || profiles.length === 0 || active !== null || autoFired.has(sessionId)) return;
      if (!summaryKnown || isSubagent) return;
      autoFired.add(sessionId);
      const name = profiles.some((p) => p.name === "default") ? "default" : profiles[0].name;
      call(opts.rpcPrefix + ".activate", { sessionId, profile: name, cwd }).then((r) => {
        if (r && r.ok) {
          setActive(r.profile);
          setTip((r.pending ? "\u5DF2\u6392\u961F(\u4F1A\u8BDD\u6FC0\u6D3B\u540E\u751F\u6548): " : "\u9ED8\u8BA4\u52A0\u8F7D: ") + r.profile + (r.temperature != null ? " \xB7 temp " + r.temperature : ""));
        } else if (r && r.error) {
          setError(String(r.error));
        }
      }).catch(() => {
      });
    }, [profiles, active, sessionId, cwd, summaryKnown, isSubagent]);
    const onChange = (e) => {
      const name = e.target.value || null;
      setError(null);
      if (!name) return;
      call(opts.rpcPrefix + ".activate", { sessionId, profile: name, cwd }).then((r) => {
        if (r && r.ok) {
          setActive(r.profile);
          setTip((r.pending ? "\u5DF2\u6392\u961F(\u4F1A\u8BDD\u6FC0\u6D3B\u540E\u751F\u6548): " : "\u5DF2\u5207\u6362: ") + r.profile + (r.temperature != null ? " \xB7 temp " + r.temperature : ""));
          setError(null);
        } else {
          setError(r && r.error || "\u5207\u6362\u5931\u8D25");
        }
      }).catch((err) => setError("\u5931\u8D25: " + String(err && err.message || err)));
    };
    if (profiles === null) return React2.createElement("span", null, "profile\u2026");
    if (fatal) return null;
    if (profiles.length === 0) return null;
    if (profiles.length === 1) {
      const only = profiles[0];
      const shownKey = active || only.name;
      const shownTitle2 = only.title || shownKey;
      const temp = only.parameters && only.parameters.temperature != null ? only.parameters.temperature : null;
      return React2.createElement(
        "span",
        { className: css + "-inline" },
        React2.createElement("span", {
          title: error || tip || "profile-" + shownTitle2 + (temp != null ? " \xB7 temperature " + temp : "") + (isSubagent ? " \xB7 \u5B50\u4EE3\u7406\u4F1A\u8BDD(\u7EE7\u627F\u7236\u4F1A\u8BDD\u6863\u6848)" : "") + (gp ? " \xB7 \u5F00\u573A\u767D\u8986\u76D6: " + gp : "")
        }, "profile-" + shownTitle2),
        error ? React2.createElement("span", { className: "err", title: error }, error) : null
      );
    }
    const shown = active || (profiles.some((p) => p.name === "default") ? "default" : profiles[0].name);
    const shownProfile = profiles.find((p) => p.name === shown);
    const shownTitle = shownProfile ? shownProfile.title || shown : shown;
    return React2.createElement(
      "span",
      null,
      React2.createElement(
        "select",
        {
          value: shown,
          onChange,
          title: error || tip || (shownProfile && shownProfile.parameters && shownProfile.parameters.temperature != null ? "profile-" + shownTitle + " \xB7 temperature " + shownProfile.parameters.temperature + (isSubagent ? " \xB7 \u5B50\u4EE3\u7406\u4F1A\u8BDD(\u7EE7\u627F\u7236\u4F1A\u8BDD\u6863\u6848)" : "") + (gp ? " \xB7 \u5F00\u573A\u767D\u8986\u76D6: " + gp : "") : "\u5207\u6362 .deepseek.yaml profile" + (isSubagent ? "\uFF08\u5B50\u4EE3\u7406\u4F1A\u8BDD\uFF1A\u9ED8\u8BA4\u7EE7\u627F\u7236\u4F1A\u8BDD\u6863\u6848\uFF09" : "") + (gp ? " \xB7 \u5F00\u573A\u767D\u8986\u76D6: " + gp : ""))
        },
        profiles.map((p) => React2.createElement("option", { key: p.name, value: p.name }, "profile-" + (p.title || p.name)))
      ),
      error ? React2.createElement("span", { className: "err", title: error }, error) : null
    );
  }
  slots.inject(opts.slotName, () => slots.register(
    { name: opts.slotName, id: opts.slotId, order: 0, label: () => "profile" },
    (props) => React2.createElement("div", { className: css + "-inline" }, React2.createElement(ProfileSelect, { sessionId: props.sessionId, useSessions: props.useSessions }))
  ));
}

// src/core/settings-client.js
function settingsClientCore(ctx, opts, deps) {
  const slots = ctx.get("slots");
  if (slots === void 0) return;
  const React2 = deps.React;
  const call = deps.call;
  const insertCss2 = deps.insertCss;
  const h = React2.createElement;
  const css = opts.cssPrefix;
  insertCss2(
    "." + css + "{display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f);max-width:640px;}." + css + " h2{margin:0;font-size:15px;font-weight:600;}." + css + "-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b6b);}." + css + "-field{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);}." + css + "-field > label{font-weight:500;display:flex;align-items:center;gap:8px;cursor:pointer;}." + css + "-field > label span.k{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#6b6b6b);}." + css + "-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b6b);}." + css + "-field input[type=text]{width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f1f1f);}." + css + "-field input[type=checkbox]{margin:0;}." + css + "-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}." + css + "-actions button{font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#e0e0e0);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#1f1f1f);cursor:pointer;}." + css + "-actions button[data-kind=primary]{border-color:transparent;background:var(--dsw-alias-label-primary,#1f1f1f);color:var(--dsw-alias-bg-layer-1,#fff);}." + css + "-actions button:disabled{opacity:.5;cursor:default;}." + css + "-status{margin:0;font-size:12px;line-height:1.6;}." + css + "-status[data-tone=error]{color:var(--dsw-alias-state-error-primary,#d03050);}." + css + "-status[data-tone=ok]{color:var(--dsw-alias-label-secondary,#6b6b6b);}." + css + "-meta{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b6b6b);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;}"
  );
  const FIELDS = [
    {
      key: "includeHarnessIdentity",
      kind: "checkbox",
      title: "\u4FDD\u7559 DSH \u7B2C\u4E00\u65B9\u5F00\u573A\u767D",
      desc: "\u7CFB\u7EDF\u63D0\u793A\u8BCD\u7684\u7B2C 1 \u53E5 \u201CYou are an AI agent powered by DeepSeek Harness.\u201D\u3002\u52FE\u9009 = \u4FDD\u7559\u8BE5\u53E5\uFF1B\u4E0D\u52FE\u9009\uFF08\u9ED8\u8BA4\uFF09= \u5173\u6389\u5B83\u3002\u672C\u63D2\u4EF6\u5728\u4F1A\u8BDD\u4F5C\u7528\u57DF\u7528\u540C\u540D\u6BB5\u8986\u76D6\u5B83\uFF0C\u6539\u5B8C\u7ACB\u5373\u751F\u6548\uFF0C\u65E0\u9700\u91CD\u542F\u3002"
    },
    {
      key: "persona_clear",
      kind: "checkbox",
      title: "\u6E05\u7A7A persona \u6BB5",
      desc: "preset \u81EA\u5E26\u7684\u7B2C 2 \u53E5 \u201CYou are a coding agent powered by the {{model}} model.\u201D\u3002\u52FE\u9009 = \u6E05\u7A7A\uFF08\u9ED8\u8BA4\uFF09\uFF1B\u4E0D\u52FE\u9009 = \u4FDD\u7559\u539F\u53E5\u3002"
    },
    {
      key: "global_prompt",
      kind: "textbox",
      title: "\u5F00\u573A\u767D\u8986\u76D6\u6587\u4EF6",
      // 文案里**不写具体路径示例**：面板可能被截图/分享，不该暴露本机目录结构。
      desc: "\u586B\u4E00\u4E2A\u6587\u672C\u6587\u4EF6\u7684\u7EDD\u5BF9\u8DEF\u5F84\u3002\u586B\u4E86\u5C31\u7528\u81EA\u5DF1\u7684\u6587\u4EF6\u6B63\u6587\u66FF\u6362\u7B2C 1 \u53E5\uFF1B\u7559\u7A7A\uFF08\u9ED8\u8BA4\uFF09= \u4E0D\u8986\u76D6\uFF08\u6B64\u65F6\u7531\u4E0A\u9762\u7684\u5F00\u5173\u51B3\u5B9A\u90A3\u53E5\u82F1\u6587\u7684\u53BB\u7559\uFF09\u3002",
      placeholder: "/path/to/your-prompt.md"
    }
  ];
  function SettingsPanel() {
    const [phase, setPhase] = React2.useState("loading");
    const [saved, setSaved] = React2.useState(null);
    const [draft, setDraft] = React2.useState(null);
    const [meta, setMeta] = React2.useState(null);
    const [error, setError] = React2.useState(null);
    const mounted = React2.useRef(true);
    const saving = React2.useRef(false);
    const load = React2.useCallback(async () => {
      setPhase("loading");
      setError(null);
      try {
        const r = await call(opts.rpcPrefix + ".settings", {});
        if (!mounted.current) return;
        if (!r || r.error) {
          setError(r && r.error || "\u8BFB\u53D6\u8BBE\u7F6E\u5931\u8D25");
          setPhase("error");
          return;
        }
        setSaved(r.values);
        setDraft(r.values);
        setMeta(r);
        setPhase("ready");
      } catch (err) {
        if (!mounted.current) return;
        setError("RPC \u5931\u8D25: " + String(err && err.message || err));
        setPhase("error");
      }
    }, []);
    React2.useEffect(() => {
      mounted.current = true;
      load();
      return () => {
        mounted.current = false;
      };
    }, [load]);
    const setField = (key, value) => {
      setDraft((current) => Object.assign({}, current, { [key]: value }));
      setError(null);
    };
    const dirty = !!(draft && saved) && FIELDS.some((f) => draft[f.key] !== saved[f.key]);
    const save = async () => {
      if (!draft || saving.current || phase === "loading") return;
      saving.current = true;
      setPhase("saving");
      setError(null);
      try {
        const r = await call(opts.rpcPrefix + ".settings.set", { values: draft });
        if (!mounted.current) return;
        if (!r || !r.ok) {
          setError(r && r.error || "\u4FDD\u5B58\u5931\u8D25");
          setPhase("ready");
          return;
        }
        setSaved(r.values);
        setDraft(r.values);
        setMeta((current) => Object.assign({}, current, { values: r.values, patchPath: r.patchPath, writable: r.writable }));
        setPhase("ready");
        if (r.warning) setError(r.warning);
      } catch (err) {
        if (!mounted.current) return;
        setError("\u4FDD\u5B58\u5931\u8D25: " + String(err && err.message || err));
        setPhase("ready");
      } finally {
        saving.current = false;
      }
    };
    const restore = () => {
      setDraft((current) => Object.assign({}, current, {
        global_prompt: "",
        persona_clear: true,
        includeHarnessIdentity: false
      }));
      setError(null);
    };
    if (phase === "loading" && !draft) {
      return h("div", { className: css }, h("h2", null, "\u63D0\u793A\u8BCD\u6863\u6848"), h("p", { className: css + "-hint" }, "\u6B63\u5728\u8BFB\u53D6\u8BBE\u7F6E\u2026"));
    }
    if (!draft) {
      return h(
        "div",
        { className: css },
        h("h2", null, "\u63D0\u793A\u8BCD\u6863\u6848"),
        h("p", { className: css + "-status", "data-tone": "error", role: "alert" }, error || "\u8BBE\u7F6E\u4E0D\u53EF\u7528"),
        h("div", { className: css + "-actions" }, h("button", { type: "button", onClick: () => load() }, "\u91CD\u8BD5"))
      );
    }
    const busy = phase === "saving";
    return h(
      "div",
      { className: css },
      h("h2", null, "\u63D0\u793A\u8BCD\u6863\u6848"),
      h(
        "p",
        { className: css + "-hint" },
        "\u8FD9\u91CC\u662F\u672C\u63D2\u4EF6\u7684**\u5168\u5C40\u9ED8\u8BA4\u503C**\uFF08\u5199\u5728\u63D2\u4EF6\u81EA\u5DF1\u7684 cordis.patch.yml \u91CC\uFF09\u3002\u67D0\u4E2A\u5DE5\u4F5C\u533A\u7684 .deepseek.yaml \u82E5\u5199\u4E86\u540C\u540D\u5B57\u6BB5\uFF08workspace \u6BB5\uFF09\uFF0C\u4F1A**\u6309\u5B57\u6BB5\u8986\u76D6**\u8FD9\u91CC\u7684\u503C\uFF1B\u6CA1\u5199\u7684\u5B57\u6BB5\u7EE7\u7EED\u7528\u8FD9\u91CC\u7684\u8BBE\u7F6E\u3002"
      ),
      ...FIELDS.map((field) => h(
        "div",
        { className: css + "-field", key: field.key },
        field.kind === "checkbox" ? h(
          "label",
          null,
          h("input", {
            type: "checkbox",
            checked: draft[field.key] === true,
            disabled: busy,
            onChange: (e) => setField(field.key, e.target.checked)
          }),
          h("span", null, field.title),
          h("span", { className: "k" }, field.key)
        ) : h(
          "label",
          { htmlFor: css + "-global-prompt" },
          h("span", null, field.title),
          h("span", { className: "k" }, field.key)
        ),
        field.kind === "textbox" ? h("input", {
          id: css + "-global-prompt",
          type: "text",
          value: typeof draft[field.key] === "string" ? draft[field.key] : "",
          placeholder: field.placeholder,
          disabled: busy,
          spellCheck: false,
          onChange: (e) => setField(field.key, e.target.value)
        }) : null,
        h("p", { className: css + "-desc" }, field.desc)
      )),
      h(
        "div",
        { className: css + "-actions" },
        h("button", {
          type: "button",
          "data-kind": "primary",
          disabled: busy || !dirty,
          onClick: () => save()
        }, busy ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58"),
        h("button", { type: "button", disabled: busy || !dirty, onClick: restore }, "\u6062\u590D\u9ED8\u8BA4\u503C")
      ),
      error ? h("p", { className: css + "-status", "data-tone": "error", role: "alert" }, error) : null,
      !error && !dirty && phase === "ready" ? h("p", { className: css + "-status", "data-tone": "ok", role: "status" }, "\u5DF2\u4FDD\u5B58") : null,
      meta && meta.patchPath ? h("p", { className: css + "-meta" }, "\u5199\u5165\u4F4D\u7F6E: " + meta.patchPath + (meta.writable === false ? "\uFF08\u5F53\u524D\u8FDB\u7A0B\u4E0D\u53EF\u5199\uFF0C\u4EC5\u5728\u5185\u5B58\u751F\u6548\uFF09" : "")) : meta && meta.writable === false ? h("p", { className: css + "-meta" }, "\u5F53\u524D\u73AF\u5883\u65E0\u53EF\u5199 patch \u6587\u4EF6\uFF08\u4EC5\u5185\u5B58\u751F\u6548\uFF0C\u91CD\u542F\u540E\u5931\u6548\uFF09") : null
    );
  }
  slots.inject("settings.section", () => slots.register(
    { name: "settings.section", id: opts.settingsSlotId, order: 60, label: () => "\u63D0\u793A\u8BCD\u6863\u6848" },
    () => h(SettingsPanel, null)
  ));
}

// src/static/client.js
var inject = ["slots", "connection"];
function insertCss(mark, css) {
  if (typeof document === "undefined") return;
  if (document.querySelector('style[data-plugin-css="' + mark + '"]')) return;
  const el = document.createElement("style");
  el.dataset.pluginCss = mark;
  el.textContent = css;
  document.head.appendChild(el);
}
function apply(ctx) {
  const connection = ctx.get("connection");
  if (connection === void 0) return;
  const deps = {
    React: import_react.default,
    call: async (method, args) => {
      const result = await connection.rpc.call("/rpc", method, args);
      if (result.ok) return result.value;
      throw new Error(result.error && result.error.message || "RPC failed");
    },
    insertCss: (css) => insertCss("dsh-profile-selector", css)
  };
  clientCore(ctx, {
    slotName: "conversation.input.right",
    slotId: "dsh-profile-selector-static",
    rpcPrefix: "dshprofile-static",
    cssPrefix: "dshprofile-static"
  }, deps);
  settingsClientCore(ctx, {
    settingsSlotId: "dsh-profile-selector-static-settings",
    rpcPrefix: "dshprofile-static",
    cssPrefix: "dshprofile-static-settings"
  }, Object.assign({}, deps, { insertCss: (css) => insertCss("dsh-profile-selector-static-settings", css) }));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
