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
  default: () => client_default,
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
  const insertCss = deps.insertCss;
  const css = opts.cssPrefix;
  insertCss(
    "." + css + "-inline{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);height:26px;}." + css + "-inline select{font-size:11px;padding:1px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;max-width:150px;height:22px;}." + css + "-inline .err{color:var(--dsw-alias-state-error-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:24ch;}"
  );
  const autoFired = /* @__PURE__ */ new Set();
  function ProfileSelect(props) {
    const sessionId = props.sessionId;
    const useSessions = props.useSessions;
    const cwd = typeof useSessions === "function" ? useSessions((s) => sessionId ? s.byId[sessionId]?.cwd : void 0) : void 0;
    const [profiles, setProfiles] = React2.useState(null);
    const [active, setActive] = React2.useState(null);
    const [tip, setTip] = React2.useState(null);
    const [fatal, setFatal] = React2.useState(null);
    const [error, setError] = React2.useState(null);
    React2.useEffect(() => {
      let alive = true;
      call(opts.rpcPrefix + ".profiles", { sessionId, cwd }).then((r) => {
        if (!alive) return;
        if (r && Array.isArray(r.profiles)) setProfiles(r.profiles);
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
    }, [profiles, active, sessionId, cwd]);
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
    if (fatal) return React2.createElement("span", { className: "err", title: String(fatal) }, "profile:" + String(fatal));
    if (profiles.length === 0) return React2.createElement("span", { title: "\u672A\u627E\u5230 .deepseek.yaml \u7684 system_prompts \u914D\u7F6E" }, "profile:\u2014");
    if (profiles.length === 1) {
      const only = profiles[0];
      const shownKey = active || only.name;
      const shownTitle2 = only.title || shownKey;
      const temp = only.parameters && only.parameters.temperature != null ? only.parameters.temperature : null;
      return React2.createElement(
        "span",
        { className: css + "-inline" },
        React2.createElement("span", {
          title: error || tip || "profile-" + shownTitle2 + (temp != null ? " \xB7 temperature " + temp : "")
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
          title: error || tip || (shownProfile && shownProfile.parameters && shownProfile.parameters.temperature != null ? "profile-" + shownTitle + " \xB7 temperature " + shownProfile.parameters.temperature : "\u5207\u6362 .deepseek.yaml profile")
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

// src/static/client.js
var inject = ["slots", "connection"];
function apply(ctx) {
  const connection = ctx.get("connection");
  if (connection === void 0) return;
  clientCore(ctx, {
    slotName: "conversation.input.right",
    slotId: "dsh-profile-selector-static",
    rpcPrefix: "dshprofile-static",
    cssPrefix: "dshprofile-static"
  }, {
    React: import_react.default,
    call: async (method, args) => {
      const result = await connection.rpc.call("/rpc", method, args);
      if (result.ok) return result.value;
      throw new Error(result.error && result.error.message || "RPC failed");
    },
    insertCss: (css) => {
      if (typeof document === "undefined") return;
      const el = document.createElement("style");
      el.textContent = css;
      document.head.appendChild(el);
    }
  });
}
var client_default = apply;
return module.exports; } });
//# sourceMappingURL=client.js.map
