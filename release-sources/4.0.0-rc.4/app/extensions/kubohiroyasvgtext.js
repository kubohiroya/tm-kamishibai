// Name: SVG Text
// ID: kubohiroyasvgtext
// Description: Responsive named-style SVG text actors for TurboWarp.
// By: Hiroya Kubo
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  //#region src/config.ts
  var extensionConfig = {
  	id: "kubohiroyasvgtext",
  	slug: "svg-text",
  	name: "SVG Text",
  	description: "Responsive named-style SVG text actors for TurboWarp.",
  	author: "Hiroya Kubo",
  	license: "MPL-2.0",
  	unsandboxed: true
  };
  var block_definitions_default = {
  	extensionName: "SVG Text",
  	blocks: [{
  		"opcode": "defineStyle",
  		"blockType": "COMMAND",
  		"text": "define text style [STYLE] background [BACKGROUND] text [TEXT_COLOR] font [FONT] size [SIZE] align [ALIGN]",
  		"description": "Defines or replaces a named text style for SVG text actors. Bubble shape and placement are owned by the host Bubble layer.",
  		"arguments": {
  			"STYLE": {
  				"type": "STRING",
  				"defaultValue": "default"
  			},
  			"BACKGROUND": {
  				"type": "COLOR",
  				"defaultValue": "#ffffff"
  			},
  			"TEXT_COLOR": {
  				"type": "COLOR",
  				"defaultValue": "#575e75"
  			},
  			"FONT": {
  				"type": "STRING",
  				"defaultValue": "Helvetica"
  			},
  			"SIZE": {
  				"type": "NUMBER",
  				"defaultValue": 100
  			},
  			"ALIGN": {
  				"type": "STRING",
  				"defaultValue": "left",
  				"menu": "alignment"
  			}
  		}
  	}, {
  		"opcode": "setText",
  		"blockType": "COMMAND",
  		"text": "set this sprite text [TEXT] with style [STYLE]",
  		"description": "Replaces this sprite's skin with responsive styled SVG text.",
  		"arguments": {
  			"TEXT": {
  				"type": "STRING",
  				"defaultValue": "Title\\nSubtitle"
  			},
  			"STYLE": {
  				"type": "STRING",
  				"defaultValue": "default"
  			}
  		}
  	}],
  	menus: { "alignment": {
  		"acceptReporters": true,
  		"items": [
  			"left",
  			"center",
  			"right"
  		]
  	} }
  };
  //#endregion
  //#region src/extension.ts
  var blockDefinitions = block_definitions_default.blocks;
  var definitionMenus = block_definitions_default.menus;
  var EXTENSION_DOCS_URI = "https://kubohiroya.github.io/turbowarp-svg-text/";
  var defaultStyleName = "default";
  var defaultFontPercent = 100;
  var minimumFontPercent = 1;
  var maximumFontPercent = 1e3;
  var maximumFontNameLength = 128;
  var baseStageWidth = 480;
  var baseStageHeight = 360;
  var textStyle = {
  	fontSize: 14,
  	lineHeight: 16,
  	padding: 12,
  	cornerRadius: 8
  };
  var initialDefaultStyle = {
  	alignment: "left",
  	backgroundColor: "#ffffff",
  	font: "Helvetica",
  	fontPercent: defaultFontPercent,
  	textColor: "#575e75"
  };
  var BLOCK_ICON_URI = `data:image/svg+xml,${encodeURIComponent("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"><g fill=\"none\" stroke=\"#fff\" stroke-width=\"5\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M13 23V12h11M40 12h11v11M13 41v11h11M40 52h11V41M22 23h20M32 23v23\"/></g></svg>")}`;
  var SvgTextExtension = class {
  	constructor(runtime = Scratch.vm?.runtime, options = {}) {
  		this.styles = /* @__PURE__ */ new Map([[defaultStyleName, initialDefaultStyle]]);
  		this.textActors = /* @__PURE__ */ new Map();
  		if (!runtime) throw new Error("SVG Text requires the TurboWarp VM.");
  		this.runtime = runtime;
  		this.castToString = options.castToString ?? Scratch.Cast.toString;
  		if (options.listenForRuntimeEvents ?? true) this.runtime.on("STAGE_SIZE_CHANGED", () => {
  			this.restyleTextActors();
  		});
  	}
  	getInfo() {
  		return {
  			id: extensionConfig.id,
  			name: Scratch.translate(block_definitions_default.extensionName),
  			docsURI: EXTENSION_DOCS_URI,
  			blockIconURI: BLOCK_ICON_URI,
  			color1: "#9966ff",
  			blocks: blockDefinitions.map((block) => this.toScratchBlock(block)),
  			menus: definitionMenus
  		};
  	}
  	defineStyle(args) {
  		const styleName = this.normalizeStyleName(args.STYLE);
  		this.styles.set(styleName, {
  			alignment: this.normalizeAlignment(args.ALIGN),
  			backgroundColor: this.normalizeColor(args.BACKGROUND, initialDefaultStyle.backgroundColor),
  			font: this.normalizeFont(args.FONT),
  			fontPercent: this.normalizeFontPercent(args.SIZE),
  			textColor: this.normalizeColor(args.TEXT_COLOR, initialDefaultStyle.textColor)
  		});
  		this.restyleTextActors(styleName);
  	}
  	setText(args, util) {
  		this.applyTextActor(util.target, this.normalizeMessage(args.TEXT), this.resolveStyle(args.STYLE));
  	}
  	measureText(styleName, text) {
  		const selection = this.resolveStyle(styleName);
  		const normalizedText = this.normalizeMessage(text);
  		const stageScale = this.getStageScale();
  		const fontSize = textStyle.fontSize * stageScale * (selection.definition.fontPercent / defaultFontPercent);
  		return Math.max(0, ...normalizedText.split("\n").map((line) => this.measureTextWidth(line, fontSize)));
  	}
  	releaseTextActor(target) {
  		const state = this.textActors.get(target);
  		if (!state) return false;
  		this.textActors.delete(target);
  		this.runtime.renderer?.destroySkin?.(state.skinId);
  		this.runtime.requestRedraw?.();
  		return true;
  	}
  	toScratchBlock(block) {
  		return {
  			opcode: block.opcode,
  			blockType: Scratch.BlockType[block.blockType],
  			text: Scratch.translate(block.text),
  			hideFromPalette: block.hideFromPalette ?? false,
  			arguments: Object.fromEntries(Object.entries(block.arguments).map(([name, argument]) => [name, {
  				type: Scratch.ArgumentType[argument.type],
  				defaultValue: argument.defaultValue,
  				...argument.menu === void 0 ? {} : { menu: argument.menu }
  			}]))
  		};
  	}
  	normalizeStyleName(value) {
  		return this.castToString(value).trim() || defaultStyleName;
  	}
  	normalizeFontPercent(value) {
  		if (typeof value === "string" && value.trim() === "") return defaultFontPercent;
  		const numericValue = Number(value);
  		if (!Number.isFinite(numericValue)) return defaultFontPercent;
  		return Math.min(maximumFontPercent, Math.max(minimumFontPercent, numericValue));
  	}
  	normalizeMessage(value) {
  		return this.castToString(value).replace(/\\r\\n|\\n|\\r/gu, "\n");
  	}
  	normalizeAlignment(value) {
  		const alignment = this.castToString(value).trim().toLowerCase();
  		if (alignment === "center" || alignment === "right") return alignment;
  		return "left";
  	}
  	normalizeColor(value, fallback) {
  		const color = this.castToString(value).trim();
  		if (color === "") return fallback;
  		if (color.toLowerCase() === "transparent") return color;
  		if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(color)) return color;
  		if (globalThis.CSS?.supports?.("color", color)) return color;
  		return fallback;
  	}
  	normalizeFont(value) {
  		const font = this.castToString(value).trim();
  		const hasUnsafeCharacter = [...font].some((character) => {
  			const codePoint = character.codePointAt(0) ?? 0;
  			return codePoint <= 31 || codePoint === 127 || ",;{}".includes(character);
  		});
  		if (font === "" || font.length > maximumFontNameLength || hasUnsafeCharacter) return initialDefaultStyle.font;
  		return font;
  	}
  	getStageScale() {
  		const nativeSize = this.runtime.renderer?.getNativeSize?.();
  		if (!Array.isArray(nativeSize) || nativeSize.length < 2) return 1;
  		const width = Number(nativeSize[0]);
  		const height = Number(nativeSize[1]);
  		if (!(width > 0) || !(height > 0)) return 1;
  		return Math.min(width / baseStageWidth, height / baseStageHeight);
  	}
  	createTextActorSvg(text, definition) {
  		const stageScale = this.getStageScale();
  		const fontScale = stageScale * (definition.fontPercent / defaultFontPercent);
  		const fontSize = textStyle.fontSize * fontScale;
  		const lineHeight = textStyle.lineHeight * fontScale;
  		const padding = textStyle.padding * stageScale;
  		const cornerRadius = textStyle.cornerRadius * stageScale;
  		const lines = text.split("\n");
  		const contentWidth = Math.max(1, ...lines.map((line) => this.measureTextWidth(line, fontSize)));
  		const width = Math.max(1, Math.ceil(contentWidth + padding * 2));
  		const height = Math.max(1, Math.ceil(lineHeight * lines.length + padding * 2));
  		const textAnchor = definition.alignment === "center" ? "middle" : definition.alignment === "right" ? "end" : "start";
  		const x = definition.alignment === "center" ? width / 2 : definition.alignment === "right" ? width - padding : padding;
  		const title = this.escapeXml(text);
  		const tspans = lines.map((line, index) => {
  			const y = padding + fontSize + lineHeight * index;
  			return `<tspan x="${this.formatSvgNumber(x)}" y="${this.formatSvgNumber(y)}">${this.escapeXml(line)}</tspan>`;
  		}).join("");
  		return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${title}</title><rect width="${width}" height="${height}" rx="${this.formatSvgNumber(cornerRadius)}" fill="${this.escapeXml(definition.backgroundColor)}"/><text xml:space="preserve" fill="${this.escapeXml(definition.textColor)}" font-family="${this.escapeXml(definition.font)}" font-size="${this.formatSvgNumber(fontSize)}" text-anchor="${textAnchor}">${tspans}</text></svg>`;
  	}
  	measureTextWidth(text, fontSize) {
  		let units = 0;
  		for (const character of text) {
  			if (/\p{Mark}/u.test(character)) continue;
  			if (/\s/u.test(character)) {
  				units += .35;
  				continue;
  			}
  			const codePoint = character.codePointAt(0) ?? 0;
  			units += codePoint <= 127 ? .62 : 1;
  		}
  		return units * fontSize;
  	}
  	escapeXml(value) {
  		return value.replace(/[&<>"']/gu, (character) => {
  			switch (character) {
  				case "&": return "&amp;";
  				case "<": return "&lt;";
  				case ">": return "&gt;";
  				case "\"": return "&quot;";
  				default: return "&apos;";
  			}
  		});
  	}
  	formatSvgNumber(value) {
  		return String(Math.round(value * 1e3) / 1e3);
  	}
  	applyTextActor(target, text, selection) {
  		const renderer = this.runtime.renderer;
  		if (typeof target.drawableID !== "number" || typeof renderer?.createSVGSkin !== "function" || typeof renderer.updateDrawableSkinId !== "function") throw new Error("SVG Text requires SVG skin APIs from TurboWarp.");
  		const skinId = renderer.createSVGSkin(this.createTextActorSvg(text, selection.definition));
  		if (!Number.isInteger(skinId) || skinId < 0) throw new Error("TurboWarp did not create an SVG text skin.");
  		try {
  			renderer.updateDrawableSkinId(target.drawableID, skinId);
  		} catch (error) {
  			renderer.destroySkin?.(skinId);
  			throw error;
  		}
  		const previous = this.textActors.get(target);
  		this.textActors.set(target, {
  			skinId,
  			styleName: selection.styleName,
  			text
  		});
  		if (previous && previous.skinId !== skinId) renderer.destroySkin?.(previous.skinId);
  		this.runtime.requestRedraw?.();
  	}
  	resolveStyle(value) {
  		const requestedName = this.normalizeStyleName(value);
  		const definition = this.styles.get(requestedName);
  		if (definition) return {
  			definition,
  			styleName: requestedName
  		};
  		return {
  			definition: this.styles.get(defaultStyleName) ?? initialDefaultStyle,
  			styleName: defaultStyleName
  		};
  	}
  	restyleTextActors(styleName) {
  		for (const [target, state] of [...this.textActors]) {
  			if (styleName !== void 0 && state.styleName !== styleName) continue;
  			this.applyTextActor(target, state.text, this.resolveStyle(state.styleName));
  		}
  	}
  };
  //#endregion
  //#region src/index.ts
  if (extensionConfig.unsandboxed && !Scratch.extensions.unsandboxed) throw new Error(`${extensionConfig.name} must run unsandboxed.`);
  Scratch.extensions.register(new SvgTextExtension());
  //#endregion

})(Scratch);
