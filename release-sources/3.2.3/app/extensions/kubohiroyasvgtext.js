// Name: SVG Text
// ID: kubohiroyasvgtext
// Description: Responsive named-style bubbles and SVG text actors for TurboWarp.
// By: Hiroya Kubo
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  //#region src/config.ts
  var extensionConfig = {
  	id: "kubohiroyasvgtext",
  	slug: "svg-text",
  	name: "SVG Text",
  	description: "Responsive named-style bubbles and SVG text actors for TurboWarp.",
  	author: "Hiroya Kubo",
  	license: "MPL-2.0",
  	unsandboxed: true
  };
  var block_definitions_default = {
  	extensionName: "SVG Text",
  	blocks: [
  		{
  			"opcode": "defineStyle",
  			"blockType": "COMMAND",
  			"text": "define text style [STYLE] background [BACKGROUND] text [TEXT_COLOR] font [FONT] size [SIZE] align [ALIGN] bubble direction [DIRECTION]",
  			"description": "Defines or replaces a named responsive text style. Bubble direction is measured from the actor center to the bubble body center and accepts names, compass aliases, or Scratch-style degrees from 0 to 360.",
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
  				},
  				"DIRECTION": {
  					"type": "STRING",
  					"defaultValue": "up-right",
  					"menu": "direction"
  				}
  			}
  		},
  		{
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
  		},
  		{
  			"opcode": "sayWithStyle",
  			"blockType": "COMMAND",
  			"text": "say [MESSAGE] with style [STYLE]",
  			"description": "Shows a responsive say bubble using a named style.",
  			"arguments": {
  				"MESSAGE": {
  					"type": "STRING",
  					"defaultValue": "Hello!\\nHow are you?"
  				},
  				"STYLE": {
  					"type": "STRING",
  					"defaultValue": "default"
  				}
  			}
  		},
  		{
  			"opcode": "thinkWithStyle",
  			"blockType": "COMMAND",
  			"text": "think [MESSAGE] with style [STYLE]",
  			"description": "Shows a responsive think bubble using a named style.",
  			"arguments": {
  				"MESSAGE": {
  					"type": "STRING",
  					"defaultValue": "Hmm...\\nI wonder."
  				},
  				"STYLE": {
  					"type": "STRING",
  					"defaultValue": "default"
  				}
  			}
  		},
  		{
  			"opcode": "say",
  			"blockType": "COMMAND",
  			"text": "say [MESSAGE] with font size [SIZE]",
  			"description": "Legacy size-based say bubble kept for saved-project compatibility.",
  			"hideFromPalette": true,
  			"arguments": {
  				"MESSAGE": {
  					"type": "STRING",
  					"defaultValue": "Hello!\\nHow are you?"
  				},
  				"SIZE": {
  					"type": "NUMBER",
  					"defaultValue": 100
  				}
  			}
  		},
  		{
  			"opcode": "think",
  			"blockType": "COMMAND",
  			"text": "think [MESSAGE] with font size [SIZE]",
  			"description": "Legacy size-based think bubble kept for saved-project compatibility.",
  			"hideFromPalette": true,
  			"arguments": {
  				"MESSAGE": {
  					"type": "STRING",
  					"defaultValue": "Hmm...\\nI wonder."
  				},
  				"SIZE": {
  					"type": "NUMBER",
  					"defaultValue": 100
  				}
  			}
  		}
  	],
  	menus: {
  		"alignment": {
  			"acceptReporters": true,
  			"items": [
  				"left",
  				"center",
  				"right"
  			]
  		},
  		"direction": {
  			"acceptReporters": true,
  			"items": [
  				"up",
  				"up-up-right",
  				"up-right",
  				"right-up-right",
  				"right",
  				"right-down-right",
  				"down-right",
  				"down-down-right",
  				"down",
  				"down-down-left",
  				"down-left",
  				"left-down-left",
  				"left",
  				"left-up-left",
  				"up-left",
  				"up-up-left"
  			]
  		}
  	}
  };
  //#endregion
  //#region src/extension.ts
  var bubbleDirections = [
  	"up",
  	"up-up-right",
  	"up-right",
  	"right-up-right",
  	"right",
  	"right-down-right",
  	"down-right",
  	"down-down-right",
  	"down",
  	"down-down-left",
  	"down-left",
  	"left-down-left",
  	"left",
  	"left-up-left",
  	"up-left",
  	"up-up-left"
  ];
  var bubbleDirectionAliases = /* @__PURE__ */ new Map([
  	["east", "right"],
  	["east-northeast", "right-up-right"],
  	["east-southeast", "right-down-right"],
  	["north", "up"],
  	["northeast", "up-right"],
  	["north-northeast", "up-up-right"],
  	["northwest", "up-left"],
  	["north-northwest", "up-up-left"],
  	["south", "down"],
  	["southeast", "down-right"],
  	["south-southeast", "down-down-right"],
  	["southwest", "down-left"],
  	["south-southwest", "down-down-left"],
  	["west", "left"],
  	["west-northwest", "left-up-left"],
  	["west-southwest", "left-down-left"]
  ]);
  var intermediateDirectionOffset = Math.SQRT2 - 1;
  var bubbleDirectionVectors = {
  	down: {
  		x: 0,
  		y: -1
  	},
  	"down-down-left": {
  		x: -intermediateDirectionOffset,
  		y: -1
  	},
  	"down-down-right": {
  		x: intermediateDirectionOffset,
  		y: -1
  	},
  	"down-left": {
  		x: -1,
  		y: -1
  	},
  	"down-right": {
  		x: 1,
  		y: -1
  	},
  	left: {
  		x: -1,
  		y: 0
  	},
  	"left-down-left": {
  		x: -1,
  		y: -intermediateDirectionOffset
  	},
  	"left-up-left": {
  		x: -1,
  		y: intermediateDirectionOffset
  	},
  	right: {
  		x: 1,
  		y: 0
  	},
  	"right-down-right": {
  		x: 1,
  		y: -intermediateDirectionOffset
  	},
  	"right-up-right": {
  		x: 1,
  		y: intermediateDirectionOffset
  	},
  	up: {
  		x: 0,
  		y: 1
  	},
  	"up-left": {
  		x: -1,
  		y: 1
  	},
  	"up-right": {
  		x: 1,
  		y: 1
  	},
  	"up-up-left": {
  		x: -intermediateDirectionOffset,
  		y: 1
  	},
  	"up-up-right": {
  		x: intermediateDirectionOffset,
  		y: 1
  	}
  };
  function normalizeVectorComponent(value) {
  	if (Math.abs(value) < 1e-12) return 0;
  	if (Math.abs(1 - Math.abs(value)) < 1e-12) return Math.sign(value);
  	return value;
  }
  function directionVector(direction) {
  	if (typeof direction === "string") return bubbleDirectionVectors[direction];
  	const radians = direction * Math.PI / 180;
  	const rawX = Math.sin(radians);
  	const rawY = Math.cos(radians);
  	return {
  		x: normalizeVectorComponent(rawX),
  		y: normalizeVectorComponent(rawY)
  	};
  }
  var blockDefinitions = block_definitions_default.blocks;
  var definitionMenus = block_definitions_default.menus;
  var EXTENSION_DOCS_URI = "https://kubohiroya.github.io/turbowarp-svg-text/";
  var bubbleStateKey = "Scratch.looks";
  var defaultStyleName = "default";
  var defaultFontPercent = 100;
  var minimumFontPercent = 1;
  var maximumFontPercent = 1e3;
  var maximumFontNameLength = 128;
  var baseStageWidth = 480;
  var baseStageHeight = 360;
  var baseStyle = {
  	maxLineWidth: 170,
  	minWidth: 50,
  	strokeWidth: 4,
  	padding: 10,
  	cornerRadius: 16,
  	tailHeight: 12,
  	fontSize: 14,
  	fontHeightRatio: .9,
  	lineHeight: 16
  };
  var actorStyle = {
  	minimumWidth: 1,
  	padding: 12,
  	cornerRadius: 8
  };
  var initialDefaultStyle = {
  	alignment: "left",
  	backgroundColor: "#ffffff",
  	direction: "up-right",
  	font: "Helvetica",
  	fontPercent: defaultFontPercent,
  	textColor: "#575e75"
  };
  var SvgTextExtension = class {
  	constructor(runtime = Scratch.vm?.runtime) {
  		this.styles = /* @__PURE__ */ new Map([[defaultStyleName, initialDefaultStyle]]);
  		this.activeStyles = /* @__PURE__ */ new WeakMap();
  		this.textActors = /* @__PURE__ */ new Map();
  		this.pendingStyles = /* @__PURE__ */ new WeakMap();
  		this.alignedSkins = /* @__PURE__ */ new WeakSet();
  		this.targetPositionHooks = /* @__PURE__ */ new WeakMap();
  		if (!runtime) throw new Error("SVG Text requires the TurboWarp VM.");
  		this.runtime = runtime;
  		this.handleSayOrThink = this.handleSayOrThink.bind(this);
  		this.handleStageSizeChanged = this.handleStageSizeChanged.bind(this);
  		this.runtime.on("SAY", this.handleSayOrThink);
  		this.runtime.on("STAGE_SIZE_CHANGED", this.handleStageSizeChanged);
  	}
  	getInfo() {
  		return {
  			id: extensionConfig.id,
  			name: Scratch.translate(block_definitions_default.extensionName),
  			docsURI: EXTENSION_DOCS_URI,
  			color1: "#9966ff",
  			blocks: blockDefinitions.map((block) => this.toScratchBlock(block)),
  			menus: definitionMenus
  		};
  	}
  	defineStyle(args) {
  		const styleName = this.normalizeStyleName(args.STYLE);
  		const definition = {
  			alignment: this.normalizeAlignment(args.ALIGN),
  			backgroundColor: this.normalizeColor(args.BACKGROUND, initialDefaultStyle.backgroundColor),
  			direction: this.normalizeDirection(args.DIRECTION),
  			font: this.normalizeFont(args.FONT),
  			fontPercent: this.normalizeFontPercent(args.SIZE),
  			textColor: this.normalizeColor(args.TEXT_COLOR, initialDefaultStyle.textColor)
  		};
  		this.styles.set(styleName, definition);
  		this.restyleVisibleBubbles(styleName, definition);
  		this.restyleTextActors(styleName);
  	}
  	setText(args, util) {
  		const selection = this.resolveStyle(args.STYLE);
  		this.applyTextActor(util.target, this.normalizeMessage(args.TEXT), selection);
  	}
  	sayWithStyle(args, util) {
  		this.showStyledBubble("say", args, util);
  	}
  	thinkWithStyle(args, util) {
  		this.showStyledBubble("think", args, util);
  	}
  	say(args, util) {
  		this.showLegacyBubble("say", args, util);
  	}
  	think(args, util) {
  		this.showLegacyBubble("think", args, util);
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
  		return Scratch.Cast.toString(value).trim() || defaultStyleName;
  	}
  	normalizeFontPercent(value) {
  		if (typeof value === "string" && value.trim() === "") return defaultFontPercent;
  		const numericValue = Number(value);
  		if (!Number.isFinite(numericValue)) return defaultFontPercent;
  		return Math.min(maximumFontPercent, Math.max(minimumFontPercent, numericValue));
  	}
  	normalizeMessage(value) {
  		return Scratch.Cast.toString(value).replace(/\\r\\n|\\n|\\r/gu, "\n");
  	}
  	normalizeAlignment(value) {
  		const alignment = Scratch.Cast.toString(value).trim().toLowerCase();
  		if (alignment === "center" || alignment === "right") return alignment;
  		return "left";
  	}
  	normalizeDirection(value) {
  		const direction = Scratch.Cast.toString(value).trim().toLowerCase();
  		if (bubbleDirections.includes(direction)) return direction;
  		const alias = bubbleDirectionAliases.get(direction);
  		if (alias) return alias;
  		if (direction !== "") {
  			const degrees = Number(direction);
  			if (Number.isFinite(degrees) && degrees >= 0 && degrees <= 360) return degrees === 360 ? 0 : degrees;
  		}
  		return initialDefaultStyle.direction;
  	}
  	normalizeColor(value, fallback) {
  		const color = Scratch.Cast.toString(value).trim();
  		if (color === "") return fallback;
  		if (/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(color)) return color;
  		if (globalThis.CSS?.supports?.("color", color)) return color;
  		return fallback;
  	}
  	normalizeFont(value) {
  		const font = Scratch.Cast.toString(value).trim();
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
  	createRenderStyle(definition) {
  		const stageScale = this.getStageScale();
  		const fontScale = stageScale * (definition.fontPercent / defaultFontPercent);
  		return {
  			maxLineWidth: baseStyle.maxLineWidth * stageScale,
  			minWidth: baseStyle.minWidth * stageScale,
  			strokeWidth: baseStyle.strokeWidth * stageScale,
  			padding: baseStyle.padding * stageScale,
  			cornerRadius: baseStyle.cornerRadius * stageScale,
  			tailHeight: baseStyle.tailHeight * stageScale,
  			font: definition.font,
  			fontSize: baseStyle.fontSize * fontScale,
  			fontHeightRatio: baseStyle.fontHeightRatio,
  			lineHeight: baseStyle.lineHeight * fontScale,
  			bubbleFill: definition.backgroundColor,
  			textFill: definition.textColor,
  			textAlign: definition.alignment
  		};
  	}
  	createTextActorSvg(text, definition) {
  		const stageScale = this.getStageScale();
  		const fontScale = stageScale * (definition.fontPercent / defaultFontPercent);
  		const fontSize = baseStyle.fontSize * fontScale;
  		const lineHeight = baseStyle.lineHeight * fontScale;
  		const padding = actorStyle.padding * stageScale;
  		const cornerRadius = actorStyle.cornerRadius * stageScale;
  		const lines = text.split("\n");
  		const contentWidth = Math.max(actorStyle.minimumWidth, ...lines.map((line) => this.measureTextWidth(line, fontSize)));
  		const width = Math.max(1, Math.ceil(contentWidth + padding * 2));
  		const height = Math.max(1, Math.ceil(lineHeight * lines.length + padding * 2));
  		const alignment = definition.alignment;
  		const textAnchor = alignment === "center" ? "middle" : alignment === "right" ? "end" : "start";
  		const x = alignment === "center" ? width / 2 : alignment === "right" ? width - padding : padding;
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
  		if (typeof skinId !== "number") throw new Error("TurboWarp did not create an SVG text skin.");
  		try {
  			renderer.updateDrawableSkinId(target.drawableID, skinId);
  		} catch (error) {
  			renderer.destroySkin?.(skinId);
  			throw error;
  		}
  		const previous = this.textActors.get(target);
  		this.textActors.set(target, {
  			skinId,
  			styleName: selection.styleName ?? defaultStyleName,
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
  	getBubbleState(target) {
  		const state = target.getCustomState?.(bubbleStateKey);
  		if (!state || typeof state !== "object") return null;
  		return state;
  	}
  	getTextBubbleSkin(skinId) {
  		const skins = this.runtime.renderer?._allSkins;
  		if (!skins) return null;
  		return (skins instanceof Map ? skins.get(skinId) : skins[skinId]) ?? null;
  	}
  	installAlignmentRenderer(skin) {
  		if (this.alignedSkins.has(skin)) return;
  		const originalRender = skin._renderTextBubble;
  		if (typeof originalRender !== "function") return;
  		skin._renderTextBubble = function renderAlignedTextBubble(scale) {
  			const style = this._style;
  			const alignment = style?.textAlign;
  			const textFill = style?.textFill;
  			if (!style || alignment !== "center" && alignment !== "right" || typeof textFill !== "string") {
  				originalRender.call(this, scale);
  				return;
  			}
  			style.textFill = "transparent";
  			try {
  				originalRender.call(this, scale);
  			} finally {
  				style.textFill = textFill;
  			}
  			const context = this._canvas?.getContext("2d");
  			const lines = this._lines;
  			const width = this._textAreaSize?.width;
  			const padding = style.padding;
  			const lineHeight = style.lineHeight;
  			const fontHeightRatio = style.fontHeightRatio;
  			const fontSize = style.fontSize;
  			if (!context || !lines || typeof width !== "number" || typeof padding !== "number" || typeof lineHeight !== "number" || typeof fontHeightRatio !== "number" || typeof fontSize !== "number") return;
  			context.save();
  			context.fillStyle = textFill;
  			context.textAlign = alignment;
  			const x = alignment === "center" ? width / 2 : width - padding;
  			for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
  				const line = lines[lineNumber];
  				if (line === void 0) continue;
  				context.fillText(line, x, padding + lineHeight * lineNumber + fontHeightRatio * fontSize);
  			}
  			context.restore();
  		};
  		this.alignedSkins.add(skin);
  	}
  	installTargetPositionHook(target) {
  		const currentHook = target.onTargetVisualChange;
  		if (currentHook === this.targetPositionHooks.get(target)) return;
  		const originalHook = typeof currentHook === "function" ? currentHook : void 0;
  		const positionHook = (changedTarget) => {
  			originalHook?.(changedTarget);
  			this.positionBubble(target);
  		};
  		this.targetPositionHooks.set(target, positionHook);
  		target.onTargetVisualChange = positionHook;
  	}
  	positionBubble(target) {
  		if (target.visible === false) return;
  		const bubbleState = this.getBubbleState(target);
  		const renderer = this.runtime.renderer;
  		if (!bubbleState || typeof bubbleState.drawableId !== "number" || typeof renderer?.getCurrentSkinSize !== "function" || typeof renderer.updateDrawablePosition !== "function") return;
  		const size = renderer.getCurrentSkinSize(bubbleState.drawableId);
  		if (!Array.isArray(size) || size.length < 2) return;
  		const bubbleWidth = Number(size[0]);
  		const bubbleHeight = Number(size[1]);
  		if (!(bubbleWidth > 0) || !(bubbleHeight > 0)) return;
  		let targetBounds;
  		try {
  			targetBounds = target.getBoundsForBubble?.() ?? {
  				bottom: target.y ?? 0,
  				left: target.x ?? 0,
  				right: target.x ?? 0,
  				top: target.y ?? 0
  			};
  		} catch {
  			targetBounds = {
  				bottom: target.y ?? 0,
  				left: target.x ?? 0,
  				right: target.x ?? 0,
  				top: target.y ?? 0
  			};
  		}
  		const nativeSize = renderer.getNativeSize?.();
  		if (!Array.isArray(nativeSize) || nativeSize.length < 2) return;
  		const stageWidth = Number(nativeSize[0]);
  		const stageHeight = Number(nativeSize[1]);
  		if (!(stageWidth > 0) || !(stageHeight > 0)) return;
  		const direction = this.activeStyles.get(target)?.definition.direction ?? initialDefaultStyle.direction;
  		const centerX = (targetBounds.left + targetBounds.right) / 2;
  		const centerY = (targetBounds.top + targetBounds.bottom) / 2;
  		const gap = baseStyle.tailHeight * this.getStageScale();
  		const centeredBubbleX = centerX - bubbleWidth / 2;
  		const centeredBubbleY = centerY + bubbleHeight / 2;
  		const leftBubbleX = targetBounds.left - gap - bubbleWidth;
  		const rightBubbleX = targetBounds.right + gap;
  		const upperBubbleY = targetBounds.top + gap + bubbleHeight;
  		const lowerBubbleY = targetBounds.bottom - gap;
  		const vector = directionVector(direction);
  		const horizontalDistance = vector.x < 0 ? centeredBubbleX - leftBubbleX : rightBubbleX - centeredBubbleX;
  		const verticalDistance = vector.y < 0 ? centeredBubbleY - lowerBubbleY : upperBubbleY - centeredBubbleY;
  		const placementScale = Math.min(vector.x === 0 ? Number.POSITIVE_INFINITY : horizontalDistance / Math.abs(vector.x), vector.y === 0 ? Number.POSITIVE_INFINITY : verticalDistance / Math.abs(vector.y));
  		let x = centeredBubbleX + vector.x * placementScale;
  		let y = centeredBubbleY + vector.y * placementScale;
  		if (vector.x > 0 && !bubbleState.onSpriteRight) {
  			bubbleState.onSpriteRight = true;
  			this.updateTextSkin(bubbleState);
  		} else if (vector.x < 0 && bubbleState.onSpriteRight) {
  			bubbleState.onSpriteRight = false;
  			this.updateTextSkin(bubbleState);
  		}
  		const stageLeft = -stageWidth / 2;
  		const stageRight = stageWidth / 2;
  		const stageTop = stageHeight / 2;
  		const stageBottom = -stageHeight / 2;
  		x = this.clampPosition(x, stageLeft, stageRight - bubbleWidth);
  		y = this.clampPosition(y, stageBottom + bubbleHeight, stageTop);
  		renderer.updateDrawablePosition(bubbleState.drawableId, [x, y]);
  	}
  	updateTextSkin(bubbleState) {
  		if (typeof bubbleState.skinId !== "number") return;
  		this.runtime.renderer?.updateTextSkin?.(bubbleState.skinId, bubbleState.type, bubbleState.text, bubbleState.onSpriteRight, [0, 0]);
  	}
  	clampPosition(value, minimum, maximum) {
  		if (maximum < minimum) return minimum;
  		return Math.min(maximum, Math.max(minimum, value));
  	}
  	applyBubbleStyle(target, type, text, selection) {
  		const bubbleState = this.getBubbleState(target);
  		if (!bubbleState || typeof bubbleState.skinId !== "number") return;
  		const normalizedText = this.normalizeMessage(text);
  		if (bubbleState.text !== normalizedText) {
  			bubbleState.text = normalizedText;
  			this.runtime.renderer?.updateTextSkin?.(bubbleState.skinId, type, normalizedText, bubbleState.onSpriteRight, [0, 0]);
  		}
  		const skin = this.getTextBubbleSkin(bubbleState.skinId);
  		if (typeof skin?.setStyle === "function") {
  			this.installAlignmentRenderer(skin);
  			skin.setStyle(this.createRenderStyle(selection.definition));
  		}
  		this.installTargetPositionHook(target);
  		target.onTargetVisualChange?.(target);
  		this.runtime.requestRedraw?.();
  	}
  	handleSayOrThink(target, type, text) {
  		const selection = this.pendingStyles.get(target) ?? this.resolveStyle(defaultStyleName);
  		this.pendingStyles.delete(target);
  		const normalizedText = this.normalizeMessage(this.getBubbleState(target)?.text ?? text);
  		if (normalizedText === "") {
  			this.activeStyles.delete(target);
  			return;
  		}
  		this.activeStyles.set(target, selection);
  		this.applyBubbleStyle(target, type, normalizedText, selection);
  	}
  	handleStageSizeChanged() {
  		for (const target of this.runtime.targets ?? []) {
  			const bubbleState = this.getBubbleState(target);
  			if (!bubbleState?.text) continue;
  			const selection = this.activeStyles.get(target) ?? this.resolveStyle(defaultStyleName);
  			this.applyBubbleStyle(target, bubbleState.type, bubbleState.text, selection);
  		}
  		for (const [target, state] of [...this.textActors]) this.applyTextActor(target, state.text, this.resolveStyle(state.styleName));
  	}
  	restyleVisibleBubbles(styleName, definition) {
  		for (const target of this.runtime.targets ?? []) {
  			const selection = this.activeStyles.get(target);
  			const bubbleState = this.getBubbleState(target);
  			if (selection?.styleName !== styleName || !bubbleState?.text) continue;
  			const nextSelection = {
  				definition,
  				styleName
  			};
  			this.activeStyles.set(target, nextSelection);
  			this.applyBubbleStyle(target, bubbleState.type, bubbleState.text, nextSelection);
  		}
  	}
  	restyleTextActors(styleName) {
  		const definition = this.styles.get(styleName);
  		if (!definition) return;
  		for (const [target, state] of [...this.textActors]) {
  			if (state.styleName !== styleName) continue;
  			this.applyTextActor(target, state.text, {
  				definition,
  				styleName
  			});
  		}
  	}
  	showStyledBubble(type, args, util) {
  		this.showBubble(type, args.MESSAGE, this.resolveStyle(args.STYLE), util);
  	}
  	showLegacyBubble(type, args, util) {
  		const defaultDefinition = this.styles.get(defaultStyleName) ?? initialDefaultStyle;
  		this.showBubble(type, args.MESSAGE, {
  			definition: {
  				...defaultDefinition,
  				fontPercent: this.normalizeFontPercent(args.SIZE)
  			},
  			styleName: null
  		}, util);
  	}
  	showBubble(type, messageValue, selection, util) {
  		const message = this.normalizeMessage(messageValue);
  		this.pendingStyles.set(util.target, selection);
  		try {
  			this.runtime.emit("SAY", util.target, type, message);
  		} finally {
  			this.pendingStyles.delete(util.target);
  		}
  	}
  };
  //#endregion
  //#region src/index.ts
  if (extensionConfig.unsandboxed && !Scratch.extensions.unsandboxed) throw new Error(`${extensionConfig.name} must run unsandboxed.`);
  Scratch.extensions.register(new SvgTextExtension());
  //#endregion

})(Scratch);
