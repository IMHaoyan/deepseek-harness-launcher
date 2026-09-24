// Patch only the bridge-owned client entry. DSH's settings shell has no per-section icon API.
// The headless settings.action companion scopes a phone glyph to our settings nav row.
export const MARKER = 'agentsAnywhereOnboarding.settingsSection.v1'

function once(source, needle, label) {
  const first = source.indexOf(needle)
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`${label}: expected exactly one anchor`)
  }
  return first
}

const NAV_ICON = `
		function PhoneSettingsNavIcon() {
			const marker = (0, react.useRef)(null);
			(0, react.useLayoutEffect)(() => {
				const dialog = marker.current?.closest('[role="dialog"]');
				const nav = dialog?.querySelector('nav');
				if (!nav) return;
				const style = document.createElement('style');
				style.dataset.agentsAnywherePhone = 'settings-nav';
				const glyph = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" fill="none" stroke="black" stroke-width="2"/><path d="M12 18h.01" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"/></svg>';
				const mask = 'url("data:image/svg+xml,' + encodeURIComponent(glyph) + '") center / contain no-repeat';
				style.textContent = 'button[data-agents-anywhere-phone] > svg{display:none}' +
					'button[data-agents-anywhere-phone]::before{content:"";display:block;width:16px;height:16px;flex:none;background:currentColor;-webkit-mask:' + mask + ';mask:' + mask + '}';
				document.head.appendChild(style);
				let tagged = null;
				const tag = () => {
					const row = Array.from(nav.querySelectorAll('button')).find((button) =>
						button.querySelector('span')?.textContent?.trim() === '手机连接');
					if (row === tagged) return;
					tagged?.removeAttribute('data-agents-anywhere-phone');
					tagged = row || null;
					tagged?.setAttribute('data-agents-anywhere-phone', '');
				};
				tag();
				const observer = new MutationObserver(tag);
				observer.observe(nav, { childList: true, subtree: true });
				return () => {
					observer.disconnect();
					tagged?.removeAttribute('data-agents-anywhere-phone');
					style.remove();
				};
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)('span', { ref: marker, hidden: true });
		}
`

export function patchClient(source) {
  if (source.includes(MARKER)) return { source, changed: false }
  const regionStart = once(source, 'function ConnectionEntry({ wide, host }) {', 'old sidebar entry')
  const regionEnd = source.indexOf('\n\t\t//#endregion', regionStart)
  if (regionEnd < 0) throw new Error('entry region end missing')
  const entry = source.slice(regionStart, regionEnd)
  const metadataEnd = once(entry, '\n\t\t\tconst trigger = (0, react.useRef)(null);', 'entry trigger')
  const tabsAnchor = once(entry, 'className: entry_module_css_default.tabs,', 'entry tabs')
  const bodyStart = entry.lastIndexOf('/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {', tabsAnchor)
  if (bodyStart < 0) throw new Error('tab container missing')
  const bodyEnd = once(entry, '\n\t\t\t\t\t]\n\t\t\t\t})\n\t\t\t})] });', 'modal body end')
  const metadata = entry.slice(0, metadataEnd)
    .replace('function ConnectionEntry({ wide, host }) {', 'function ConnectionEntry({ host }) {')
    .replace('const [open, setOpen] = (0, react.useState)(false);\n', '')
    .replace('useOnboardingState(host, open)', 'useOnboardingState(host, true)')
  if (metadata.includes('wide') || metadata.includes('open')) throw new Error('sidebar/modal state leaked into settings section')
  const body = entry.slice(bodyStart, bodyEnd)
  const section = `${metadata}\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsxs)('div', {\n\t\t\t\tclassName: 'aa-settings-section',\n\t\t\t\tchildren: [\n\t\t\t\t\t${body}\n\t\t\t\t]\n\t\t\t});\n\t\t}\n${NAV_ICON}`
  let output = source.slice(0, regionStart) + section + source.slice(regionEnd)
  const registrationStart = once(output, 'ctx.effect(() => services.slots.inject("sidebar.footer.action",', 'sidebar registration')
  const registrationEnd = output.indexOf('\n\t\t}', registrationStart)
  if (registrationEnd < 0) throw new Error('registration end missing')
  const replacement = `ctx.effect(() => services.slots.inject("settings.section", () => services.slots.register({
				name: "settings.section",
				id: "agents-anywhere-mobile",
				order: 16,
				label: () => "手机连接",
				inject: () => ({ host })
			}, ConnectionEntry)), "${MARKER}");
			ctx.effect(() => services.slots.inject("settings.action", () => services.slots.register({
				name: "settings.action", id: "agents-anywhere-phone-icon", order: 100
			}, PhoneSettingsNavIcon)), "agentsAnywhereOnboarding.settingsIcon");`
  output = output.slice(0, registrationStart) + replacement + output.slice(registrationEnd)
  if (output.includes('sidebar.footer.action') || !output.includes(MARKER)) throw new Error('entry was not fully moved')
  return { source: output, changed: true }
}
