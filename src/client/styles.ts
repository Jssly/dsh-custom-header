/**
 * Injected stylesheet for the Settings → Plugins "请求头修改 / Custom Header"
 * tab. Official CSS tokens first, local fallbacks second — nothing overrides
 * the official theme. Same shape as dsh-hub-* settings tabs, prefixed
 * `dsh-ch-`.
 */
const CSS = `
.dsh-ch-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  line-height: 1.5;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, inherit);
  max-width: 680px;
}
.dsh-ch-settings * { box-sizing: border-box; }
.dsh-ch-settings-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-ch-settings-intro {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, #8b90a0);
  max-width: 660px;
}
.dsh-ch-settings-error {
  padding: 8px 10px;
  border-radius: 8px;
  color: var(--dsw-alias-color-danger, #d92d20);
  background: color-mix(in srgb, var(--dsw-alias-color-danger, #d92d20) 10%, transparent);
  font-size: 12px;
}
.dsh-ch-settings-muted {
  margin: 0;
  color: var(--dsw-alias-label-secondary, #8b90a0);
  font-size: 12px;
}
.dsh-ch-settings-result {
  color: var(--dsw-alias-color-success, #079455);
  font-size: 12px;
}
.dsh-ch-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border-radius: 12px;
  background: var(--dsw-alias-surface-raised, rgba(255, 255, 255, 0.03));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-border-primary, #2a2f3a) 60%, transparent);
}
.dsh-ch-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dsh-ch-row--two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
@media (max-width: 560px) {
  .dsh-ch-row--two { grid-template-columns: 1fr; }
}
.dsh-ch-row-title {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-ch-row-hint {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #8b90a0);
}
.dsh-ch-field input[type="text"],
.dsh-ch-field input[type="number"],
.dsh-ch-field select,
.dsh-ch-field textarea {
  width: 100%;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-primary, #2a2f3a);
  background: var(--dsw-alias-surface-input, rgba(0, 0, 0, 0.2));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  font-family: inherit;
}
.dsh-ch-field textarea {
  resize: vertical;
  line-height: 1.5;
}
.dsh-ch-field select:disabled,
.dsh-ch-field input:disabled,
.dsh-ch-field textarea:disabled {
  opacity: 0.55;
}
.dsh-ch-modes {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.dsh-ch-mode {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-primary, #2a2f3a);
  cursor: pointer;
  font-size: 13px;
}
.dsh-ch-mode.active {
  border-color: var(--dsw-alias-color-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-color-primary, #4d6bfe) 12%, transparent);
}
.dsh-ch-settings-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.dsh-ch-btn {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-primary, #2a2f3a);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  cursor: pointer;
}
.dsh-ch-btn.primary {
  background: var(--dsw-alias-color-primary, #4d6bfe);
  border-color: transparent;
  color: #fff;
}
.dsh-ch-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
`

let adopted = false

/** Inject the stylesheet once (idempotent). */
export function adoptCustomHeaderStyles(): void {
  if (adopted || typeof document === 'undefined') return
  adopted = true
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
}