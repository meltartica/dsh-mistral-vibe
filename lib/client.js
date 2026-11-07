/**
 * dsh-mistral-vibe client: the "Mistral Vibe" settings page.
 *
 * Shipped as a built lazy-CJS half: the loader registers this factory and calls
 * it at materialization, so every import resolves from the shell's module table.
 * The page owns no Harness schema form — it talks to the Host half over the
 * loopback routes that half registers (`/mistral-vibe/config`,
 * `/mistral-vibe/discover`), exactly like the MCP Servers settings page.
 */
window.__ModuleLoader__.load({
	id: "dsh-mistral-vibe",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const CONFIG_URL = "/mistral-vibe/config";
		const DISCOVER_URL = "/mistral-vibe/discover";

		const card = {
			background: "var(--dsw-alias-bg-layer-1)",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 12,
			padding: "12px 14px",
			display: "flex",
			flexDirection: "column",
			gap: 8,
			minWidth: 0,
		};
		const fieldStyle = {
			boxSizing: "border-box",
			width: "100%",
			padding: "6px 8px",
			font: "inherit",
			fontSize: 13,
			lineHeight: "20px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-primary)",
		};
		const labelStyle = {
			marginBottom: 2,
			fontSize: 12,
			color: "var(--dsw-alias-label-tertiary)",
		};
		const hintStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)",
		};
		const buttonStyle = {
			font: "inherit",
			fontSize: 13,
			padding: "5px 12px",
			borderRadius: 6,
			cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l1)",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
		};
		const primaryButtonStyle = {
			...buttonStyle,
			border: "1px solid var(--dsw-alias-state-accent-primary, #4d6bfe)",
			background: "var(--dsw-alias-state-accent-primary, #4d6bfe)",
			color: "#fff",
		};
		const rowStyle = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };
		const modelRowStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			padding: "3px 0",
			fontSize: 13,
			color: "var(--dsw-alias-label-primary)",
		};
		const metaStyle = {
  fontSize: 11,
  lineHeight: "16px",
  color: "var(--dsw-alias-label-tertiary)",
};

const monoStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 11,
			color: "var(--dsw-alias-label-tertiary)",
		};

		function Field(props) {
			return h(
				"div",
				{ style: { margin: "2px 0" } },
				h("div", { style: labelStyle }, props.label),
				props.children,
			);
		}

		function EyeIcon(props) {
			const open = props.open === true;
			const common = {
				width: 16,
				height: 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
			};
			const outline = h("path", {
				key: "outline",
				d: "M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z",
			});
			const pupil = h("circle", { key: "pupil", cx: 12, cy: 12, r: 2.7 });
			const slash = h("path", { key: "slash", d: "M4 4.5 20 19.5" });
			return h("svg", common, ...(open ? [outline, pupil] : [outline, slash]));
		}

		/**
		 * A password input with its own open/close eye control: the glyph sits
		 * inside the field, so the row keeps no separate Show/Hide button and
		 * no stored/fallback badge beside it.
		 */
		function SecretField(props) {
			const open = props.open === true;
			return h(
				"div",
				{ style: { position: "relative", display: "flex", alignItems: "center" } },
				h("input", {
					type: open ? "text" : "password",
					value: props.value,
					placeholder: props.placeholder,
					autoComplete: "off",
					spellCheck: false,
					onChange: props.onChange,
					style: { ...fieldStyle, paddingRight: 34 },
				}),
				h(
					"button",
					{
						type: "button",
						onClick: props.onToggle,
						title: open ? "Hide key" : "Show key",
						"aria-label": open ? "Hide key" : "Show key",
						"aria-pressed": open,
						style: {
							position: "absolute",
							right: 3,
							top: "50%",
							transform: "translateY(-50%)",
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							width: 26,
							height: 26,
							padding: 0,
							border: "none",
							borderRadius: 5,
							background: "transparent",
							cursor: "pointer",
							color: "var(--dsw-alias-label-tertiary)",
						},
					},
					h(EyeIcon, { open }),
				),
			);
		}

		async function requestJson(url, init) {
			const response = await fetch(url, {
				cache: "no-store",
				headers: { "content-type": "application/json" },
				...init,
			});
			const text = await response.text();
			let payload;
			try {
				payload = text.length === 0 ? {} : JSON.parse(text);
			} catch {
				throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
			}
			if (!response.ok) {
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			return payload;
		}

		/** What a model can do, in one line: thinking ladder, modality, window. */
function modelMeta(model) {
  const levels = Array.isArray(model.levels) ? model.levels : [];
  const thinking =
    levels.length > 0
      ? levels.join(" · ")
      : model.reasoning === true
        ? "thinking (levels unknown)"
        : "no thinking";
  const vision =
    Array.isArray(model.inputModalities) && model.inputModalities.includes("image")
      ? "text + image"
      : "text";
  const window =
    typeof model.contextWindow === "number" && model.contextWindow > 0
      ? `${Math.round(model.contextWindow / 1024)}K ctx`
      : "";
  return [thinking, vision, window].filter((part) => part.length > 0).join("  ·  ");
}

/** One model row: name and badges on top, capabilities beneath. */
function ModelCell(props) {
  const model = props.model;
  return h(
    "span",
    { style: { flex: 1, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 } },
    h(
      "span",
      { style: { display: "flex", alignItems: "center", gap: 6 } },
      h("span", { style: { fontSize: 13, lineHeight: "18px" } }, model.name ?? model.id),
      model.discovered === true
        ? h(
            "span",
            {
              style: {
                ...monoStyle,
                color: "var(--dsw-alias-label-primary)",
                border: "1px solid var(--dsw-alias-border-secondary)",
                borderRadius: 4,
                padding: "0 4px",
              },
            },
            "new",
          )
        : null,
    ),
    h("span", { style: metaStyle }, modelMeta(model)),
  );
}

function MistralVibeSection() {
			const [state, setState] = React.useState(null);
			const [error, setError] = React.useState("");
			const [notice, setNotice] = React.useState("");
			const [busy, setBusy] = React.useState(false);
			const [keyDraft, setKeyDraft] = React.useState("");
			const [studioDraft, setStudioDraft] = React.useState("");
			const [reveal, setReveal] = React.useState(false);
			const [revealStudio, setRevealStudio] = React.useState(false);
			const [endpointDraft, setEndpointDraft] = React.useState("");

			const apply = React.useCallback((payload) => {
				setState(payload);
				setEndpointDraft(typeof payload?.baseURL === "string" ? payload.baseURL : "");
			}, []);

			const reload = React.useCallback(async () => {
				try {
					apply(await requestJson(CONFIG_URL, { method: "GET" }));
				} catch (err) {
					setError(String(err instanceof Error ? err.message : err));
				}
			}, [apply]);

			React.useEffect(() => {
				void reload();
			}, [reload]);

			const save = React.useCallback(
				async (patch, done) => {
					setBusy(true);
					setError("");
					setNotice("");
					try {
						await requestJson(CONFIG_URL, { method: "POST", body: JSON.stringify(patch) });
						await reload();
						setNotice(done);
					} catch (err) {
						setError(String(err instanceof Error ? err.message : err));
					} finally {
						setBusy(false);
					}
				},
				[reload],
			);

			const saveKey = React.useCallback(() => {
				const key = keyDraft.trim();
				if (key.length === 0) {
					setError("Paste a Mistral API key first.");
					return;
				}
				void save({ apiKey: key }, "Key saved.").then(() => setKeyDraft(""));
			}, [keyDraft, save]);

			const saveStudioKey = React.useCallback(() => {
				const key = studioDraft.trim();
				if (key.length === 0) {
					setError("Paste the Studio API key first.");
					return;
				}
				void save({ studioApiKey: key }, "Studio key saved.").then(() => setStudioDraft(""));
			}, [studioDraft, save]);

			const saveEndpoint = React.useCallback(() => {
				void save({ baseURL: endpointDraft.trim() }, "Endpoint saved.");
			}, [endpointDraft, save]);

			const toggleModel = React.useCallback(
				(id) => {
					const disabled = Array.isArray(state?.disabledModels) ? state.disabledModels : [];
					const next = disabled.includes(id)
						? disabled.filter((entry) => entry !== id)
						: [...disabled, id];
					void save({ disabledModels: next }, "Model list updated.");
				},
				[save, state],
			);

			const fetchModels = React.useCallback(async () => {
				setBusy(true);
				setError("");
				setNotice("");
				try {
					const draft = keyDraft.trim();
					const payload = await requestJson(DISCOVER_URL, {
						method: "POST",
						body: JSON.stringify(draft.length > 0 ? { apiKey: draft } : {}),
					});
					await reload();
					// The list is one stored document now. If the row could not write
					// it, say so: otherwise the next reload looks like the fetch was
					// simply forgotten and the user fetches again and again.
					if (payload?.persisted === false) {
						setError(
							`Fetched ${payload?.models?.length ?? 0} models, but the list could not be saved: ${
								typeof payload?.persistError === "string" && payload.persistError.length > 0
									? payload.persistError
									: "the settings row rejected the write"
							}`,
						);
					} else {
						setNotice(
							typeof payload?.notice === "string" && payload.notice.length > 0
								? payload.notice
								: `${payload?.models?.length ?? 0} models reported by Mistral.`,
						);
					}
				} catch (err) {
					setError(String(err instanceof Error ? err.message : err));
				} finally {
					setBusy(false);
				}
			}, [keyDraft, reload]);

			if (state === null) {
				return h(
					"div",
					{ style: { padding: 12, ...hintStyle } },
					error.length > 0 ? error : "Loading the Mistral Vibe route…",
				);
			}

			const models = Array.isArray(state.models) ? state.models : [];
			const disabled = Array.isArray(state.disabledModels) ? state.disabledModels : [];

			return h(
				"div",
				{
					className: "dshmv-section",
					style: { height: "100%", display: "flex", flexDirection: "column", minWidth: 0 },
				},
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 4px 8px" } },
					h(
						"h3",
						{
							style: {
								margin: 0,
								fontSize: 16,
								lineHeight: "24px",
								fontWeight: 500,
								color: "var(--dsw-alias-label-primary)",
							},
						},
						"Mistral Vibe",
					),
					h("span", { style: { flex: 1 } }),
					notice.length > 0
						? h(
								"span",
								{ style: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)" } },
								notice,
							)
						: null,
					error.length > 0
						? h(
								"span",
								{ style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } },
								error,
							)
						: null,
				),
				h(
					"div",
					{
						style: {
							flex: 1,
							overflowY: "auto",
							overflowX: "hidden",
							padding: "12px 4px 24px",
							display: "flex",
							flexDirection: "column",
							gap: 12,
							maxWidth: 760,
						},
					},
					h(
						"div",
						{ style: card },
						h(
							"div",
							{ style: { fontWeight: 500, fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
							"API keys",
						),
						h(Field, {
							label: "Vibe Code API key",
							children: h(SecretField, {
								open: reveal,
								value: keyDraft,
								placeholder: state.hasKey ? "••••••••" : "msk-…",
								onChange: (event) => setKeyDraft(event.target.value),
								onToggle: () => setReveal(!reveal),
							}),
						}),
						h(
							"div",
							{ style: rowStyle },
							h(
								"button",
								{ type: "button", disabled: busy, onClick: saveKey, style: primaryButtonStyle },
								"Save key",
							),
						),
						h(Field, {
							label: "Studio API key",
							children: h(SecretField, {
								open: revealStudio,
								value: studioDraft,
								placeholder: state.hasStudioKey ? "••••••••" : "optional",
								onChange: (event) => setStudioDraft(event.target.value),
								onToggle: () => setRevealStudio(!revealStudio),
							}),
						}),
						h(
							"div",
							{ style: rowStyle },
							h(
								"button",
								{ type: "button", disabled: busy, onClick: saveStudioKey, style: primaryButtonStyle },
								"Save Studio key",
							),
						),
					),
					h(
						"div",
						{ style: card },
						h(
							"div",
							{ style: { fontWeight: 500, fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
							"Endpoint",
						),
						h(Field, {
							label: "Base URL",
							children: h("input", {
								type: "text",
								value: endpointDraft,
								placeholder: "https://api.mistral.ai/v1",
								spellCheck: false,
								onChange: (event) => setEndpointDraft(event.target.value),
								style: fieldStyle,
							}),
						}),
						h(
							"div",
							{ style: rowStyle },
							h(
								"button",
								{ type: "button", disabled: busy, onClick: saveEndpoint, style: buttonStyle },
								"Save endpoint",
							),
						),
					),
					h(
						"div",
						{ style: card },
						h(
							"div",
							{
								style: {
									display: "flex",
									alignItems: "center",
									gap: 8,
									fontSize: 13,
									fontWeight: 500,
									color: "var(--dsw-alias-label-primary)",
								},
							},
							"Models",
							h("span", { style: { flex: 1 } }),
							h(
								"button",
								{ type: "button", disabled: busy, onClick: fetchModels, style: buttonStyle },
								"Fetch available models",
							),
						),
						models.length === 0
							? h("div", { style: hintStyle }, "No models known yet.")
							: h(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: 0 } },
									...models.map((model) =>
										h(
											"label",
											{ key: model.id, style: modelRowStyle },
											h("input", {
												type: "checkbox",
												checked: !disabled.includes(model.id),
												disabled: busy,
												onChange: () => toggleModel(model.id),
											}),
											h(ModelCell, { model }),
											h("span", { style: monoStyle }, model.id),
										),
									),
								),
					),
				),
			);
		}

		class SectionBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error !== null) {
					return h(
						"div",
						{
							style: {
								padding: 12,
								fontSize: 12,
								whiteSpace: "pre-wrap",
								color: "var(--dsw-alias-state-error-primary)",
							},
						},
						`Mistral Vibe crashed: ${String(
							this.state.error.stack ?? this.state.error,
						)}`,
					);
				}
				return this.props.children;
			}
		}

		const name = "dsh-mistral-vibe";
		/**
		 * `slots` is the only service the page needs, and the shell always
		 * declares it, so waiting for it can never wedge the renderer boot.
		 */
		const inject = ["slots"];

		/**
		 * The sidebar glyph, registered in `settings.section.icon` under the
		 * same id as the page.
		 *
		 * The package `icon` is only the Plugins-page artwork; the settings nav
		 * goes through this slot, addressed by `id`. The shell owns the button
		 * and keeps its own default glyph when no icon is registered for the
		 * id, so an unmatched id simply never renders.
		 *
		 * Drawn inline in `currentColor` rather than as a bitmap data URI: the
		 * nav sits on a themed surface, and an `<img>` cannot follow it.
		 */
		function MistralVibeMark(props) {
			const edge = typeof props?.size === "number" && props.size > 0 ? props.size : 16;
			const dim = props?.active === false ? 0.72 : 1;
			// The artwork is icon.svg, verbatim: the same viewBox, the same
			// three-stop gradient and the same two glyph paths. A nav glyph
			// drawn by hand from memory is not the product's mark.
			return h(
				"svg",
				{
					width: edge,
					height: edge,
					viewBox: "0 0 64 64",
					role: "img",
					"aria-hidden": "true",
					style: { display: "block", opacity: dim },
				},
				h(
					"defs",
					null,
					h(
						"linearGradient",
						{ id: "dsh-mistral-vibe-mark", x1: "0", y1: "0", x2: "1", y2: "1" },
						h("stop", { offset: "0", stopColor: "#FF7A00" }),
						h("stop", { offset: "0.55", stopColor: "#FF3D00" }),
						h("stop", { offset: "1", stopColor: "#B1004B" }),
					),
				),
				h("rect", { x: 2, y: 2, width: 60, height: 60, rx: 14, fill: "url(#dsh-mistral-vibe-mark)" }),
				h(
					"g",
					{
						fill: "none",
						stroke: "#FFFFFF",
						strokeLinecap: "round",
						strokeWidth: 4,
					},
					h("path", { d: "M14 44V22l9 12 9-12v22" }),
					h("path", { d: "M38 22l12 22" }),
					h("path", { d: "M50 22L38 44" }),
				),
			);
		}

		function apply(ctx) {
			const slots = ctx?.slots ?? (typeof ctx?.get === "function" ? ctx.get("slots") : undefined);
			if (slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				return;
			}
			try {
				slots.inject("settings.section", () =>
					slots.register(
						{
							name: "settings.section",
							id: "mistral-vibe",
							order: 56,
							label: () => "Mistral Vibe",
						},
						() => h(SectionBoundary, null, h(MistralVibeSection, null)),
					),
				);
			} catch {
				// A shell without a settings sidebar keeps running with no page.
			}
			// The glyph is only addressable while the page's id exists, so it is
			// registered from its own inject callback and fails independently.
			try {
				slots.inject("settings.section.icon", () =>
					slots.register({ name: "settings.section.icon", id: "mistral-vibe", order: 56 }, MistralVibeMark),
				);
			} catch {
				// A shell that declares no icon slot still shows its default glyph.
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		exports.MistralVibeSection = MistralVibeSection;
		exports.MistralVibeMark = MistralVibeMark;
		return module.exports;
	},
});
