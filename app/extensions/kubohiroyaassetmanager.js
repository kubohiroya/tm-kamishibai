// Name: Asset Manager
// ID: kubohiroyaassetmanager
// Description: Register, cache, display, and play image, audio, and runtime text assets in TurboWarp.
// By: Hiroya Kubo
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  const extensionName = "Asset Manager";
  const blocks = [{ "opcode": "registerAsset", "blockType": "COMMAND", "text": "register resource [RESOURCE_ID] as asset [NAME]", "description": "Registers an external URL, cached asset, sprite costume, stage backdrop, project sound, or runtime text variable under one asset name.", "arguments": { "RESOURCE_ID": { "type": "STRING", "defaultValue": "https://example.com/asset.png" }, "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "assetErrorType", "blockType": "REPORTER", "text": "asset registration error type", "description": "Returns the stable type token for the most recent asset registration error, or an empty string when the latest registration succeeded.", "arguments": {} }, { "opcode": "assetErrorLabel", "blockType": "REPORTER", "text": "asset registration error label", "description": "Returns the missing or invalid name associated with the most recent asset registration error, or an empty string when the latest registration succeeded.", "arguments": {} }, { "opcode": "loadAsset", "blockType": "COMMAND", "text": "load asset from URL [URL] or cache as [NAME]", "description": "Legacy compatibility block. Loads an external image or audio asset from the supplied URL, or from IndexedDB when the URL is empty.", "arguments": { "URL": { "type": "STRING", "defaultValue": "https://example.com/asset.png" }, "NAME": { "type": "STRING", "defaultValue": "asset1" } }, "hideFromPalette": true }, { "opcode": "deleteMemoryAsset", "blockType": "COMMAND", "text": "delete asset [NAME] from memory", "description": "Unregisters one asset. Owned external renderer skins are released; project costumes, sounds, and runtime variables are left unchanged.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "deleteAllMemoryAssets", "blockType": "COMMAND", "text": "delete all assets from memory", "description": "Unregisters all assets, releases owned external renderer skins, stops actor animations, and stops tracked external audio playback.", "arguments": {} }, { "opcode": "deleteCachedAsset", "blockType": "COMMAND", "text": "delete asset [NAME] from cache", "description": "Deletes one named external asset from the IndexedDB cache.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "deleteAllCachedAssets", "blockType": "COMMAND", "text": "delete all assets from cache", "description": "Clears all external assets from the IndexedDB cache.", "arguments": {} }, { "opcode": "isLoaded", "blockType": "BOOLEAN", "text": "asset [NAME] is loaded", "description": "Returns whether the named external, project-local, or runtime text asset is currently registered.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "setTextValue", "blockType": "COMMAND", "text": "set text asset [NAME] to [VALUE]", "description": "Sets the runtime text value for a text asset using Asset Manager's internal namespace.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "Narration" }, "VALUE": { "type": "STRING", "defaultValue": "Once upon a time..." } } }, { "opcode": "setTextStyle", "blockType": "COMMAND", "text": "set text asset [NAME] style [PROPERTY] to [VALUE]", "description": "Sets one runtime style property for a text asset. Supported properties are animation, font, color, width, and align. An empty value restores the default.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "Narration" }, "PROPERTY": { "type": "STRING", "defaultValue": "font" }, "VALUE": { "type": "STRING", "defaultValue": "Sans Serif" } } }, { "opcode": "setThisSpriteSkin", "blockType": "COMMAND", "text": "show asset [NAME] on this sprite", "description": "Applies a registered image asset or displays a registered runtime text asset on the current sprite or clone.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "setSpriteSkin", "blockType": "COMMAND", "text": "show asset [NAME] on [SPRITE] (compatibility)", "description": "Stops any actor animation and applies a registered image asset or displays a registered runtime text asset on a named sprite. This block is retained for compatibility.", "arguments": { "SPRITE": { "type": "STRING", "defaultValue": "Sprite1" }, "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "startActorLoop", "blockType": "COMMAND", "text": "loop actor [ACTOR] through assets [ASSETS] for seconds [DURATIONS]", "description": "Starts or replaces a background loop. ASSETS contains registered image or audio asset names. DURATIONS must have the same number of items; each item is the interval before the next asset, including the last-to-first interval. A zero makes the next asset start together with the preceding asset. If a simultaneous group has multiple image assets, only its last image is applied. Empty ASSETS and DURATIONS stop the actor animation.", "arguments": { "ACTOR": { "type": "STRING", "defaultValue": "Sprite1" }, "ASSETS": { "type": "STRING", "defaultValue": "asset1,asset2" }, "DURATIONS": { "type": "STRING", "defaultValue": "0.5,0.5" } } }, { "opcode": "startActorSequence", "blockType": "COMMAND", "text": "play actor [ACTOR] through assets [ASSETS] for seconds [DURATIONS] once in background", "description": "Starts or replaces a one-shot background sequence and returns immediately. ASSETS contains registered image or audio asset names. DURATIONS must have exactly one fewer item; each item is the interval before the next asset. A zero makes the next asset start together with the preceding asset. If a simultaneous group has multiple image assets, only its last image is applied.", "arguments": { "ACTOR": { "type": "STRING", "defaultValue": "Sprite1" }, "ASSETS": { "type": "STRING", "defaultValue": "asset1,asset2" }, "DURATIONS": { "type": "STRING", "defaultValue": "0.5" } } }, { "opcode": "stopActorAnimation", "blockType": "COMMAND", "text": "stop animation of actor [ACTOR]", "description": "Stops the actor's current loop or sequence and leaves the currently displayed skin unchanged.", "arguments": { "ACTOR": { "type": "STRING", "defaultValue": "Sprite1" } } }, { "opcode": "finishAllActorSequences", "blockType": "COMMAND", "text": "finish all actor sequences", "description": "Finishes every one-shot actor sequence on its final image without stopping loops.", "arguments": {} }, { "opcode": "setStageSkin", "blockType": "COMMAND", "text": "set stage backdrop to asset [NAME]", "description": "Applies a registered external image, sprite costume, or stage backdrop to the stage drawable.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "backdrop1" } } }, { "opcode": "playSound", "blockType": "COMMAND", "text": "play asset [NAME] as sound", "description": "Starts playback of a registered external audio asset or project sound without waiting for completion.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "sound1" } } }, { "opcode": "playSoundUntilDone", "blockType": "COMMAND", "text": "play asset [NAME] as sound until done", "description": "Plays a registered external audio asset or project sound and waits until playback ends or fails.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "sound1" } } }, { "opcode": "stopSound", "blockType": "COMMAND", "text": "stop asset sound [NAME]", "description": "Stops every active playback of one registered external or project sound asset without stopping other sounds.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "sound1" } } }, { "opcode": "stopAllSounds", "blockType": "COMMAND", "text": "stop all asset sounds", "description": "Stops all external and project sounds currently tracked by Asset Manager.", "arguments": {} }, { "opcode": "getAssetMimeType", "blockType": "REPORTER", "text": "MIME type of asset [NAME]", "description": "Returns the normalized MIME type of a registered external, project-local, or runtime text asset.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "getVersion", "blockType": "REPORTER", "text": "Asset Manager version", "description": "Returns the Asset Manager implementation version.", "arguments": {} }];
  const definitions = {
    extensionName,
    blocks
  };
  const TEXT_RUNTIME_NAMESPACE = "text";
  const TEXT_STYLE_RUNTIME_NAMESPACE = "textStyle";
  const TEXT_STYLE_PROPERTIES = [
    "animation",
    "font",
    "color",
    "width",
    "align"
  ];
  const DEFAULT_STAGE_WIDTH = 480;
  const DEFAULT_FONT = "Handwriting";
  const DEFAULT_COLOR = "#ffffff";
  const DEFAULT_ALIGNMENT = "center";
  const DEFAULT_OUTLINE_WIDTH = 2;
  const DEFAULT_OUTLINE_COLOR = "#000000";
  function textRuntimeVariableName(name) {
    return `${TEXT_RUNTIME_NAMESPACE}:${name}`;
  }
  function textStyleRuntimeVariableName(name, property) {
    return `${TEXT_STYLE_RUNTIME_NAMESPACE}:${name}:${property}`;
  }
  function normalizeTextStyleProperty(value) {
    const property = String(value ?? "").trim().toLowerCase();
    if (TEXT_STYLE_PROPERTIES.includes(property)) {
      return property;
    }
    throw new Error(`Unknown text style property: ${property || "(empty)"}`);
  }
  function normalizeTextStyleValue(property, value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    switch (property) {
      case "animation": {
        const animation = raw.toLowerCase() === "typing" ? "type" : raw.toLowerCase();
        if (animation === "none" || animation === "type" || animation === "rainbow" || animation === "zoom" || animation === "shake") {
          return animation;
        }
        throw new Error(`Invalid text animation: ${raw}`);
      }
      case "font":
        return raw;
      case "color": {
        if (/^#[0-9a-f]{6}$/i.test(raw)) return raw.toLowerCase();
        const shortColor = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(raw);
        if (shortColor) {
          return `#${shortColor[1]}${shortColor[1]}${shortColor[2]}${shortColor[2]}${shortColor[3]}${shortColor[3]}`.toLowerCase();
        }
        throw new Error(`Invalid text color: ${raw}`);
      }
      case "width": {
        const width = Number(raw);
        if (!Number.isFinite(width) || width <= 0) {
          throw new Error(`Text width must be a positive number: ${raw}`);
        }
        return String(width);
      }
      case "align": {
        const align = raw.toLowerCase();
        if (align === "left" || align === "center" || align === "right") return align;
        throw new Error(`Invalid text alignment: ${raw}`);
      }
    }
  }
  function resolveTextStyle(name, stageWidth, getRuntimeVariable) {
    const width = Number(stageWidth);
    const defaults = {
      animation: "none",
      font: DEFAULT_FONT,
      color: DEFAULT_COLOR,
      width: Number.isFinite(width) && width > 0 ? width : DEFAULT_STAGE_WIDTH,
      align: DEFAULT_ALIGNMENT
    };
    const read = (property) => normalizeTextStyleValue(
      property,
      getRuntimeVariable(textStyleRuntimeVariableName(name, property))
    );
    const animation = read("animation");
    const font = read("font");
    const color = read("color");
    const configuredWidth = read("width");
    const align = read("align");
    return {
      animation: animation ? animation : defaults.animation,
      font: font || defaults.font,
      color: color || defaults.color,
      width: configuredWidth ? Number(configuredWidth) : defaults.width,
      align: align ? align : defaults.align
    };
  }
  const EXTENSION_ID = "kubohiroyaassetmanager";
  const EXTENSION_VERSION = "2026-07-26";
  const DB_NAME = "tw-asset-manager";
  const DB_VERSION = 1;
  const STORE_NAME = "assets";
  const STAGE_RESOURCE_NAME = "@stage";
  const blockDefinitions = definitions.blocks;
  blockDefinitions.unshift(
    {
      opcode: "setLoadingBackdrop",
      blockType: "COMMAND",
      text: "set loading backdrop asset to [NAME]",
      description: "Configures the image asset shown behind the loading indicator.",
      arguments: {
        NAME: {
          type: "STRING",
          defaultValue: "loadingBackdrop"
        }
      },
      hideFromPalette: true
    },
    {
      opcode: "setLoadingCostumes",
      blockType: "COMMAND",
      text: "set loading costume assets to [NAMES]",
      description: "Configures the comma-separated image assets used by the loading indicator.",
      arguments: {
        NAMES: {
          type: "STRING",
          defaultValue: "loading1,loading2"
        }
      },
      hideFromPalette: true
    },
    {
      opcode: "prepareLoadingAssets",
      blockType: "COMMAND",
      text: "prioritize loading assets in list [LIST]",
      description: "Moves configured loading assets to the front of the named asset definition list.",
      arguments: {
        LIST: {
          type: "STRING",
          defaultValue: "assetList"
        }
      },
      hideFromPalette: true
    },
    {
      opcode: "loadingAssetCount",
      blockType: "REPORTER",
      text: "loading asset count",
      description: "Returns the number of configured loading assets present in the prepared asset list.",
      arguments: {},
      hideFromPalette: true
    },
    {
      opcode: "loadingBackdrop",
      blockType: "REPORTER",
      text: "loading backdrop asset",
      description: "Returns the configured loading backdrop asset name.",
      arguments: {},
      hideFromPalette: true
    },
    {
      opcode: "loadingCostumeAt",
      blockType: "REPORTER",
      text: "loading costume for asset number [INDEX]",
      description: "Returns the configured loading costume asset for a one-based regular asset number.",
      arguments: {
        INDEX: {
          type: "NUMBER",
          defaultValue: "1"
        }
      },
      hideFromPalette: true
    }
  );
  class AssetRegistrationError extends Error {
    constructor(assetErrorType, assetErrorLabel, message) {
      super(message);
      __publicField(this, "assetErrorType");
      __publicField(this, "assetErrorLabel");
      this.assetErrorType = assetErrorType;
      this.assetErrorLabel = assetErrorLabel;
      this.name = "AssetRegistrationError";
    }
  }
  function normalizeName(value) {
    return String(value ?? "").trim();
  }
  function guessMimeType(value) {
    const name = String(value ?? "").toLowerCase().split("?")[0]?.split("#")[0] ?? "";
    const types = [
      [[".svg"], "image/svg+xml"],
      [[".png"], "image/png"],
      [[".jpg", ".jpeg"], "image/jpeg"],
      [[".webp"], "image/webp"],
      [[".gif"], "image/gif"],
      [[".mp3"], "audio/mpeg"],
      [[".wav"], "audio/wav"],
      [[".ogg"], "audio/ogg"],
      [[".m4a"], "audio/mp4"],
      [[".aac"], "audio/aac"]
    ];
    return types.find(([extensions]) => extensions.some((extension) => name.endsWith(extension)))?.[1] ?? "application/octet-stream";
  }
  function normalizeMimeType(mimeType, urlOrName) {
    const raw = String(mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    return !raw || raw === "application/octet-stream" || raw === "binary/octet-stream" ? guessMimeType(urlOrName) : raw;
  }
  function parseResourceIdentifier(value, fallbackAssetName) {
    const resourceId = normalizeName(value);
    if (!resourceId) return { kind: "cache" };
    if (/^https?:\/\//i.test(resourceId)) return { kind: "external", url: resourceId };
    const separatorIndex = resourceId.indexOf(":");
    if (separatorIndex < 0) {
      const fallbackName = normalizeName(fallbackAssetName);
      const bareScheme = resourceId.toLowerCase();
      if (bareScheme === "costume" && fallbackName) {
        return { kind: "costume", spriteName: fallbackName, costumeName: null };
      }
      if (bareScheme === "backdrop" && fallbackName) {
        return { kind: "backdrop", backdropName: fallbackName };
      }
      if (bareScheme === "sound" && fallbackName) {
        return { kind: "sound", spriteName: STAGE_RESOURCE_NAME, soundName: fallbackName };
      }
      if (bareScheme === "text" && fallbackName) {
        const name = parseLocalResourceName(fallbackName, "Text variable");
        return { kind: "text", runtimeVariableName: textRuntimeVariableName(name) };
      }
      throw new Error(`Unsupported resource identifier: ${resourceId}`);
    }
    const scheme = resourceId.slice(0, separatorIndex).trim().toLowerCase();
    const payload = resourceId.slice(separatorIndex + 1).trim();
    switch (scheme) {
      case "costume": {
        const [spriteName, costumeName] = splitLocalResourcePair(payload, "costume", fallbackAssetName);
        return { kind: "costume", spriteName, costumeName };
      }
      case "backdrop": {
        return { kind: "backdrop", backdropName: parseLocalResourceName(payload, "Backdrop") };
      }
      case "sound": {
        const [spriteName, soundName] = splitLocalResourcePair(payload, "sound", fallbackAssetName);
        return { kind: "sound", spriteName, soundName };
      }
      case "text": {
        const name = parseLocalResourceName(payload, "Text variable");
        return { kind: "text", runtimeVariableName: textRuntimeVariableName(name) };
      }
      default:
        throw new Error(`Unsupported resource scheme: ${scheme}`);
    }
  }
  function splitLocalResourcePair(payload, scheme, fallbackAssetName) {
    if (!payload.includes(":") && fallbackAssetName !== void 0) {
      const spriteName = payload.trim();
      const assetName2 = normalizeName(fallbackAssetName);
      if (!spriteName) throw new Error(`${scheme} source name is empty.`);
      if (!assetName2) throw new Error(`${scheme} asset name is empty.`);
      return [spriteName, assetName2];
    }
    const parts = payload.split(":");
    if (parts.length !== 2) {
      throw new Error(`${scheme} resource must specify a source and asset name separated by exactly one colon.`);
    }
    const sourceName = parts[0]?.trim() ?? "";
    const assetName = parts[1]?.trim() ?? "";
    if (!sourceName) throw new Error(`${scheme} source name is empty.`);
    if (!assetName) throw new Error(`${scheme} asset name is empty.`);
    return [sourceName, assetName];
  }
  function parseLocalResourceName(payload, label) {
    const name = payload.trim();
    if (!name) throw new Error(`${label} name is empty.`);
    if (name.includes(":")) throw new Error(`${label} name must not contain a colon.`);
    return name;
  }
  class AssetManagerExtension {
    constructor() {
      __publicField(this, "runtime", Scratch.vm.runtime);
      __publicField(this, "renderer", this.runtime.renderer);
      __publicField(this, "externalAssets", /* @__PURE__ */ new Map());
      __publicField(this, "costumeAssets", /* @__PURE__ */ new Map());
      __publicField(this, "soundAssets", /* @__PURE__ */ new Map());
      __publicField(this, "textAssets", /* @__PURE__ */ new Map());
      __publicField(this, "assetRegistry", /* @__PURE__ */ new Map());
      __publicField(this, "displayedAssets", /* @__PURE__ */ new Map());
      __publicField(this, "playingAudio", /* @__PURE__ */ new Map());
      __publicField(this, "registrationVersions", /* @__PURE__ */ new Map());
      __publicField(this, "loadingBackdropName", "");
      __publicField(this, "lastAssetErrorType", "");
      __publicField(this, "lastAssetErrorLabel", "");
      __publicField(this, "assetErrorVersion", 0);
    }
    setLoadingBackdrop(args) {
      this.loadingBackdropName = normalizeName(args.NAME);
      this.loadingAssetCountValue = 0;
    }
    setLoadingCostumes(args) {
      const seen = /* @__PURE__ */ new Set();
      this.loadingCostumes = String(args.NAMES ?? "").split(",").map((name) => normalizeName(name)).filter((name) => {
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
      this.loadingAssetCountValue = 0;
    }
    prepareLoadingAssets(args, util) {
      const listName = normalizeName(args.LIST);
      const list = util.target?.lookupVariableByNameAndType?.(listName, "list");
      if (!list || !Array.isArray(list.value)) {
        throw new Error(`Loading asset list not found: ${listName || "(empty)"}`);
      }
      const loadingBackdrop = this.loadingBackdropName;
      const loadingCostumes = this.loadingCostumes ?? [];
      const loadingCostumeNames = new Set(loadingCostumes);
      const loadingNames = new Set(
        [loadingBackdrop, ...loadingCostumes].filter((name) => name.length > 0)
      );
      const entries = list.value.map((entry) => String(entry));
      const declaredNames = new Set(entries.map((entry) => {
        const separatorIndex = entry.indexOf(",");
        return normalizeName(separatorIndex < 0 ? entry : entry.slice(0, separatorIndex));
      }));
      const missingNames = [...loadingNames].filter((name) => !declaredNames.has(name));
      if (missingNames.length > 0) {
        throw new Error(`Loading asset is not declared: ${missingNames.join(", ")}`);
      }
      const backdropEntries = [];
      const prioritized = [];
      const regular = [];
      for (const entry of entries) {
        const separatorIndex = entry.indexOf(",");
        const assetName = normalizeName(separatorIndex < 0 ? entry : entry.slice(0, separatorIndex));
        if (loadingBackdrop && assetName === loadingBackdrop) {
          backdropEntries.push(entry);
        } else {
          (loadingCostumeNames.has(assetName) ? prioritized : regular).push(entry);
        }
      }
      list.value.splice(0, list.value.length, ...backdropEntries, ...prioritized, ...regular);
      this.loadingAssetCountValue = backdropEntries.length + prioritized.length;
    }
    loadingAssetCount() {
      return this.loadingAssetCountValue ?? 0;
    }
    loadingBackdrop() {
      return this.loadingBackdropName;
    }
    loadingCostumeAt(args) {
      const loadingCostumes = this.loadingCostumes ?? [];
      if (loadingCostumes.length === 0) return "";
      const numericIndex = Number(args.INDEX);
      const index = Number.isFinite(numericIndex) ? Math.max(1, Math.trunc(numericIndex)) : 1;
      return loadingCostumes[(index - 1) % loadingCostumes.length];
    }
    getInfo() {
      return {
        id: EXTENSION_ID,
        name: Scratch.translate(definitions.extensionName),
        color1: "#5b7cfa",
        color2: "#425ed8",
        color3: "#2f46aa",
        blocks: blockDefinitions.map((block) => this.toScratchBlock(block))
      };
    }
    async registerAsset(args) {
      const errorVersion = ++this.assetErrorVersion;
      this.clearAssetError();
      let fallbackType = "asset-name";
      let fallbackLabel = normalizeName(args.NAME);
      try {
        const name = this.requireAssetName(args.NAME);
        const resourceId = normalizeName(args.RESOURCE_ID);
        if (resourceId === "text" || resourceId.startsWith("text:")) {
          this.requireTextAssetName(name);
        }
        fallbackType = "resource-id";
        fallbackLabel = resourceId;
        const resource = parseResourceIdentifier(args.RESOURCE_ID, name);
        switch (resource.kind) {
          case "cache":
            fallbackType = "cache";
            fallbackLabel = name;
            await this.registerExternalAsset("", name);
            return;
          case "external":
            fallbackType = "external";
            fallbackLabel = resource.url;
            await this.registerExternalAsset(resource.url, name);
            return;
          case "costume":
            fallbackType = "costume";
            fallbackLabel = resource.costumeName ?? name;
            this.registerCostumeReference(name, resource.spriteName, resource.costumeName);
            return;
          case "backdrop":
            fallbackType = "backdrop";
            fallbackLabel = resource.backdropName;
            this.registerBackdropReference(name, resource.backdropName);
            return;
          case "sound":
            fallbackType = "sound";
            fallbackLabel = resource.soundName;
            this.registerSoundReference(name, resource.spriteName, resource.soundName);
            return;
          case "text":
            fallbackType = "text";
            fallbackLabel = resource.runtimeVariableName;
            this.registerTextReference(name, resource.runtimeVariableName);
            return;
        }
      } catch (error) {
        if (this.assetErrorVersion === errorVersion) {
          if (error instanceof AssetRegistrationError) {
            this.lastAssetErrorType = error.assetErrorType;
            this.lastAssetErrorLabel = error.assetErrorLabel;
          } else {
            this.lastAssetErrorType = fallbackType;
            this.lastAssetErrorLabel = fallbackLabel;
          }
        }
        throw error;
      }
    }
    assetErrorType() {
      return this.lastAssetErrorType;
    }
    assetErrorLabel() {
      return this.lastAssetErrorLabel;
    }
    /** Legacy opcode retained for existing projects. */
    async loadAsset(args) {
      const name = this.requireAssetName(args.NAME);
      await this.registerExternalAsset(normalizeName(args.URL), name);
    }
    deleteMemoryAsset(args) {
      this.unregisterAsset(normalizeName(args.NAME));
    }
    deleteAllMemoryAssets() {
      for (const name of this.registrationVersions.keys()) {
        this.registrationVersions.set(name, (this.registrationVersions.get(name) ?? 0) + 1);
      }
      for (const asset of this.externalAssets.values()) this.deleteOwnedSkinIfExists(asset);
      this.externalAssets.clear();
      this.costumeAssets.clear();
      this.soundAssets.clear();
      this.textAssets.clear();
      this.assetRegistry.clear();
      this.displayedAssets.clear();
      for (const audio of [...this.playingAudio.keys()]) this.stopExternalAudio(audio);
      this.playingAudio.clear();
    }
    async deleteCachedAsset(args) {
      await this.cacheDelete(normalizeName(args.NAME));
    }
    async deleteAllCachedAssets() {
      await this.cacheClear();
    }
    isLoaded(args) {
      return this.assetRegistry.has(normalizeName(args.NAME));
    }
    async setThisSpriteSkin(args, util) {
      if (!util.target || util.target.isStage) throw new Error("This block must be used on a sprite or its clone.");
      await this.applyAssetToTarget(util.target, args.NAME, util);
    }
    async setSpriteSkin(args, util) {
      const name = normalizeName(args.SPRITE);
      const target = this.findTargetByName(name);
      if (!target) throw new Error(`Sprite not found: ${name}`);
      await this.applyAssetToTarget(target, args.NAME, util);
    }
    async setStageSkin(args) {
      const stage = this.getStageTarget();
      this.applySkinToTarget(stage, await this.resolveSkin(args.NAME));
    }
    async playSound(args) {
      await this.playResolvedSound(args.NAME, false);
    }
    async playSoundUntilDone(args) {
      await this.playResolvedSound(args.NAME, true);
    }
    stopSound(args) {
      const name = normalizeName(args.NAME);
      const kind = this.assetRegistry.get(name);
      if (!kind) throw new Error(`Asset is not loaded: ${name}`);
      if (kind === "external") {
        const asset = this.externalAssets.get(name);
        if (!asset) throw new Error(`External asset is not loaded: ${name}`);
        asset.mimeType = normalizeMimeType(asset.mimeType, asset.url || name);
        if (!asset.mimeType.startsWith("audio/")) {
          throw new Error(`Asset is not audio: ${name} (${asset.mimeType})`);
        }
        for (const [audio, assetName] of [...this.playingAudio]) {
          if (assetName === name) this.stopExternalAudio(audio);
        }
        return;
      }
      if (kind === "sound") {
        const { target, sound } = this.resolveSoundReference(name);
        target.sprite.soundBank.stop(target, sound.soundId);
        return;
      }
      throw new Error(`Asset is not audio: ${name}`);
    }
    stopAllSounds() {
      for (const audio of [...this.playingAudio.keys()]) this.stopExternalAudio(audio);
      this.playingAudio.clear();
      for (const target of this.runtime.targets) {
        target.sprite?.soundBank?.stopAllSounds(target);
      }
    }
    getAssetMimeType(args) {
      const name = normalizeName(args.NAME);
      const kind = this.assetRegistry.get(name);
      if (!kind) return "";
      switch (kind) {
        case "external": {
          const asset = this.externalAssets.get(name);
          return asset ? normalizeMimeType(asset.mimeType, asset.url || name) : "";
        }
        case "costume": {
          const { costume } = this.resolveCostumeReference(name);
          return this.projectAssetMimeType(costume.dataFormat, "image");
        }
        case "sound": {
          const { sound } = this.resolveSoundReference(name);
          return this.projectAssetMimeType(sound.dataFormat, "audio");
        }
        case "text": {
          return "text/plain";
        }
      }
    }
    getVersion() {
      return EXTENSION_VERSION;
    }
    async setTextValue(args) {
      const name = this.requireTextAssetName(args.NAME);
      const kind = this.assetRegistry.get(name);
      if (kind !== void 0 && kind !== "text") {
        throw new Error(`Asset is not text: ${name}`);
      }
      const reference = this.textAssets.get(name);
      this.setRuntimeVariable(
        reference?.runtimeVariableName ?? textRuntimeVariableName(name),
        String(args.VALUE ?? "")
      );
      const targets = this.runtime.targets.filter(
        (target) => this.displayedAssets.get(target.id) === name
      );
      await Promise.all(
        targets.map((target) => this.applyTextToTarget(target, name, {
          runtime: this.runtime,
          target
        }))
      );
    }
    setTextStyle(args) {
      const name = this.requireTextAssetName(args.NAME);
      const kind = this.assetRegistry.get(name);
      if (kind !== void 0 && kind !== "text") {
        throw new Error(`Asset is not text: ${name}`);
      }
      const property = normalizeTextStyleProperty(args.PROPERTY);
      const value = normalizeTextStyleValue(property, args.VALUE);
      this.setRuntimeVariable(textStyleRuntimeVariableName(name, property), value);
    }
    toScratchBlock(block) {
      return {
        opcode: block.opcode,
        blockType: Scratch.BlockType[block.blockType],
        text: Scratch.translate(block.text),
        ...block.hideFromPalette ? { hideFromPalette: true } : {},
        ...Object.keys(block.arguments).length > 0 ? {
          arguments: Object.fromEntries(
            Object.entries(block.arguments).map(([name, argument]) => [
              name,
              {
                type: Scratch.ArgumentType[argument.type],
                defaultValue: argument.defaultValue
              }
            ])
          )
        } : {}
      };
    }
    requireAssetName(value) {
      const name = normalizeName(value);
      if (!name) throw new Error("Asset name is empty.");
      return name;
    }
    requireTextAssetName(value) {
      const name = this.requireAssetName(value);
      if (name.includes(":")) {
        throw new AssetRegistrationError(
          "asset-name",
          name,
          "Text asset name must not contain a colon."
        );
      }
      return name;
    }
    clearAssetError() {
      this.lastAssetErrorType = "";
      this.lastAssetErrorLabel = "";
    }
    nextRegistrationVersion(name) {
      const version = (this.registrationVersions.get(name) ?? 0) + 1;
      this.registrationVersions.set(name, version);
      return version;
    }
    async registerExternalAsset(url, name) {
      const version = this.nextRegistrationVersion(name);
      const record = url ? await this.fetchAndCache(url, name) : await this.cacheGet(name);
      if (this.registrationVersions.get(name) !== version) return;
      if (!record) throw new Error(`Asset is not cached and URL is empty: ${name}`);
      this.unregisterAsset(name);
      this.externalAssets.set(name, {
        ...record,
        kind: "external",
        mimeType: normalizeMimeType(record.mimeType, record.url || name),
        skinId: null
      });
      this.assetRegistry.set(name, "external");
    }
    registerCostumeReference(name, spriteName, costumeName) {
      const target = this.findTargetByName(spriteName);
      if (!target) {
        throw new AssetRegistrationError("sprite", spriteName, `Sprite not found: ${spriteName}`);
      }
      const costumes = target.sprite?.costumes ?? [];
      const costume = costumeName === null ? costumes.find((candidate) => candidate.name === name) ?? (costumes.length === 1 ? costumes[0] : null) : this.findCostume(target, costumeName, null);
      if (!costume && costumeName === null && costumes.length > 1) {
        throw new AssetRegistrationError(
          "costume",
          name,
          `Costume shorthand is ambiguous: ${spriteName} has multiple costumes and none is named ${name}.`
        );
      }
      const resolvedCostumeName = costume?.name ?? costumeName ?? name;
      if (!costume) {
        throw new AssetRegistrationError(
          "costume",
          resolvedCostumeName,
          `Costume not found: ${spriteName}/${resolvedCostumeName}`
        );
      }
      this.unregisterAsset(name);
      this.costumeAssets.set(name, {
        kind: "costume",
        name,
        targetId: target.id,
        targetName: spriteName,
        isStage: false,
        costumeName: resolvedCostumeName,
        assetId: costume.assetId ?? null
      });
      this.assetRegistry.set(name, "costume");
    }
    registerBackdropReference(name, backdropName) {
      const stage = this.getStageTarget();
      const costume = this.findCostume(stage, backdropName, null);
      if (!costume) {
        throw new AssetRegistrationError("backdrop", backdropName, `Backdrop not found: ${backdropName}`);
      }
      this.unregisterAsset(name);
      this.costumeAssets.set(name, {
        kind: "costume",
        name,
        targetId: stage.id,
        targetName: STAGE_RESOURCE_NAME,
        isStage: true,
        costumeName: backdropName,
        assetId: costume.assetId ?? null
      });
      this.assetRegistry.set(name, "costume");
    }
    registerSoundReference(name, spriteName, soundName) {
      const isStage = spriteName.toLowerCase() === STAGE_RESOURCE_NAME;
      const target = isStage ? this.getStageTarget() : this.findTargetByName(spriteName);
      if (!target) {
        throw new AssetRegistrationError("sprite", spriteName, `Sound source not found: ${spriteName}`);
      }
      const sound = this.findSound(target, soundName, null);
      if (!sound) {
        throw new AssetRegistrationError("sound", soundName, `Sound not found: ${spriteName}/${soundName}`);
      }
      this.unregisterAsset(name);
      this.soundAssets.set(name, {
        kind: "sound",
        name,
        targetId: target.id,
        targetName: isStage ? STAGE_RESOURCE_NAME : spriteName,
        isStage,
        soundName,
        assetId: sound.assetId ?? null
      });
      this.assetRegistry.set(name, "sound");
    }
    registerTextReference(name, runtimeVariableName) {
      this.requireTextAssetName(name);
      this.unregisterAsset(name);
      this.textAssets.set(name, {
        kind: "text",
        name,
        runtimeVariableName
      });
      this.assetRegistry.set(name, "text");
    }
    unregisterAsset(name) {
      this.nextRegistrationVersion(name);
      const kind = this.assetRegistry.get(name);
      if (!kind) return;
      if (kind === "external") {
        this.deleteOwnedSkinIfExists(this.externalAssets.get(name));
        this.externalAssets.delete(name);
      } else if (kind === "costume") {
        this.costumeAssets.delete(name);
      } else if (kind === "sound") {
        this.soundAssets.delete(name);
      } else if (kind === "text") {
        this.textAssets.delete(name);
      }
      this.assetRegistry.delete(name);
      for (const [targetId, displayedName] of this.displayedAssets) {
        if (displayedName === name) this.displayedAssets.delete(targetId);
      }
    }
    openDatabase() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: "name" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async transaction(mode, action) {
      const database = await this.openDatabase();
      return new Promise((resolve, reject) => {
        const request = action(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async cacheGet(name) {
      return await this.transaction("readonly", (store) => store.get(name)) ?? null;
    }
    async cachePut(record) {
      await this.transaction("readwrite", (store) => store.put(record));
    }
    async cacheDelete(name) {
      await this.transaction("readwrite", (store) => store.delete(name));
    }
    async cacheClear() {
      await this.transaction("readwrite", (store) => store.clear());
    }
    async fetchAndCache(url, name) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch asset "${name}": ${response.status} ${response.statusText}`);
      const blob = await response.blob();
      const record = {
        name,
        url,
        mimeType: normalizeMimeType(blob.type || response.headers.get("Content-Type"), url),
        data: await blob.arrayBuffer(),
        cachedAt: Date.now()
      };
      await this.cachePut(record);
      return record;
    }
    getStageTarget() {
      const stage = this.runtime.targets.find((target) => target.isStage);
      if (!stage) throw new Error("Stage not found.");
      return stage;
    }
    findTargetByName(name) {
      const targets = this.runtime.targets;
      return targets.find((target) => !target.isStage && target.isOriginal && target.sprite?.name === name) ?? targets.find((target) => !target.isStage && target.sprite?.name === name) ?? null;
    }
    resolveReferencedTarget(targetId, targetName, isStage) {
      const byId = this.runtime.targets.find((target) => target.id === targetId);
      if (byId) return byId;
      if (isStage) return this.getStageTarget();
      const byName = this.findTargetByName(targetName);
      if (!byName) throw new Error(`Asset source target no longer exists: ${targetName}`);
      return byName;
    }
    findCostume(target, costumeName, assetId) {
      const costumes = target.sprite?.costumes ?? [];
      return (assetId ? costumes.find((costume) => costume.assetId === assetId) : void 0) ?? costumes.find((costume) => costume.name === costumeName) ?? null;
    }
    findSound(target, soundName, assetId) {
      const sounds = target.sprite?.sounds ?? [];
      return (assetId ? sounds.find((sound) => sound.assetId === assetId) : void 0) ?? sounds.find((sound) => sound.name === soundName) ?? null;
    }
    async resolveSkin(value) {
      const name = normalizeName(value);
      const kind = this.assetRegistry.get(name);
      if (!kind) throw new Error(`Asset is not loaded: ${name}`);
      if (kind === "external") {
        return { skinId: await this.ensureExternalSkin(name), sourceSize: null };
      }
      if (kind === "costume") {
        const { target, costume } = this.resolveCostumeReference(name);
        return {
          skinId: costume.skinId,
          sourceSize: target.isStage || !Number.isFinite(target.size) ? null : target.size
        };
      }
      throw new Error(`Asset is not an image: ${name}`);
    }
    async applyAssetToTarget(target, value, util) {
      const name = normalizeName(value);
      const kind = this.assetRegistry.get(name);
      if (!kind) throw new Error(`Asset is not loaded: ${name}`);
      if (kind === "text") {
        await this.applyTextToTarget(target, name, util);
      } else {
        this.applySkinToTarget(target, await this.resolveSkin(name));
      }
      this.displayedAssets.set(target.id, name);
    }
    async applyTextToTarget(target, name, util) {
      if (target.isStage) throw new Error(`Text asset can only be shown on a sprite: ${name}`);
      const reference = this.textAssets.get(name);
      if (!reference) throw new Error(`Text asset is not registered: ${name}`);
      const temporaryVariables = this.requireTemporaryVariables();
      const getRuntimeVariable = (variableName) => temporaryVariables.getRuntimeVariable({ VAR: variableName });
      const style = resolveTextStyle(name, this.runtime.stageWidth, getRuntimeVariable);
      const setFont = this.requireAnimatedTextOpcode("text_setFont");
      const setColor = this.requireAnimatedTextOpcode("text_setColor");
      const setWidth = this.requireAnimatedTextOpcode("text_setWidth");
      const setOutlineWidth = this.runtime.getOpcodeFunction?.("text_setOutlineWidth");
      const setOutlineColor = this.runtime.getOpcodeFunction?.("text_setOutlineColor");
      const displayText = this.requireAnimatedTextOpcode(
        style.animation === "none" ? "text_setText" : "text_animateText"
      );
      const blockUtility = { ...util, target, runtime: util?.runtime ?? this.runtime };
      const text = getRuntimeVariable(reference.runtimeVariableName);
      await Promise.resolve(setFont({ FONT: style.font }, blockUtility));
      await Promise.resolve(setColor({ COLOR: style.color }, blockUtility));
      await Promise.resolve(setWidth({ WIDTH: style.width, ALIGN: style.align }, blockUtility));
      if (setOutlineWidth) {
        await Promise.resolve(setOutlineWidth({ WIDTH: DEFAULT_OUTLINE_WIDTH }, blockUtility));
      }
      if (setOutlineColor) {
        await Promise.resolve(setOutlineColor({ COLOR: DEFAULT_OUTLINE_COLOR }, blockUtility));
      }
      const displayResult = displayText(
        style.animation === "none" ? { TEXT: String(text ?? "") } : { ANIMATE: style.animation, TEXT: String(text ?? "") },
        blockUtility
      );
      if (style.animation === "none") {
        await Promise.resolve(displayResult);
      } else {
        void Promise.resolve(displayResult).catch((error) => {
          console.warn(`Animated Text failed for asset "${name}"`, error);
        });
      }
    }
    requireTemporaryVariables() {
      const temporaryVariables = this.runtime.ext_lmsTempVars2;
      if (!temporaryVariables?.getRuntimeVariable) {
        throw new Error("Temporary Variables extension is not loaded.");
      }
      return temporaryVariables;
    }
    setRuntimeVariable(name, value) {
      const temporaryVariables = this.requireTemporaryVariables();
      if (!temporaryVariables.setRuntimeVariable) {
        throw new Error("Temporary Variables extension does not support setting runtime variables.");
      }
      temporaryVariables.setRuntimeVariable({ VAR: name, STRING: value });
    }
    requireAnimatedTextOpcode(opcode) {
      const implementation = this.runtime.getOpcodeFunction?.(opcode);
      if (!implementation) {
        throw new Error(`Animated Text extension is not loaded or does not provide ${opcode}.`);
      }
      return implementation;
    }
    async ensureExternalSkin(name) {
      const asset = this.externalAssets.get(name);
      if (!asset) throw new Error(`External asset is not loaded: ${name}`);
      asset.mimeType = normalizeMimeType(asset.mimeType, asset.url || name);
      if (!asset.mimeType.startsWith("image/")) throw new Error(`Asset is not an image: ${name} (${asset.mimeType})`);
      if (asset.skinId !== null) return asset.skinId;
      const blob = new Blob([asset.data], { type: asset.mimeType });
      asset.skinId = asset.mimeType === "image/svg+xml" ? this.renderer.createSVGSkin(await blob.text()) : this.renderer.createBitmapSkin(await createImageBitmap(blob), 1);
      return asset.skinId;
    }
    resolveCostumeReference(name) {
      const reference = this.costumeAssets.get(name);
      if (!reference) throw new Error(`Costume asset is not registered: ${name}`);
      const target = this.resolveReferencedTarget(reference.targetId, reference.targetName, reference.isStage);
      const costume = this.findCostume(target, reference.costumeName, reference.assetId);
      if (!costume) throw new Error(`Costume no longer exists: ${reference.targetName}/${reference.costumeName}`);
      if (typeof costume.skinId !== "number") {
        throw new Error(`Costume skin is not available: ${reference.targetName}/${reference.costumeName}`);
      }
      return { target, costume };
    }
    resolveSoundReference(name) {
      const reference = this.soundAssets.get(name);
      if (!reference) throw new Error(`Sound asset is not registered: ${name}`);
      const target = this.resolveReferencedTarget(reference.targetId, reference.targetName, reference.isStage);
      const sound = this.findSound(target, reference.soundName, reference.assetId);
      if (!sound) throw new Error(`Sound no longer exists: ${reference.targetName}/${reference.soundName}`);
      if (!sound.soundId) throw new Error(`Sound ID is not available: ${reference.targetName}/${reference.soundName}`);
      if (!target.sprite?.soundBank) throw new Error(`Sound bank is not available: ${reference.targetName}`);
      return { target, sound };
    }
    deleteOwnedSkinIfExists(asset) {
      if (!asset || asset.skinId === null) return;
      try {
        this.renderer.destroySkin(asset.skinId);
      } catch (error) {
        console.warn("Failed to destroy skin", error);
      }
      asset.skinId = null;
    }
    applySkinToTarget(target, skin) {
      if (target.drawableID === void 0 || target.drawableID === null) {
        throw new Error(`Target drawable not found: ${target.sprite?.name ?? "unknown"}`);
      }
      this.renderer.updateDrawableSkinId(target.drawableID, skin.skinId);
      if (!target.isStage && skin.sourceSize !== null && target.size !== skin.sourceSize) {
        target.setSize(skin.sourceSize);
      }
      target.emitVisualChange?.();
      this.runtime.requestRedraw?.();
    }
    async playResolvedSound(value, waitUntilDone) {
      const name = normalizeName(value);
      const kind = this.assetRegistry.get(name);
      if (!kind) throw new Error(`Asset is not loaded: ${name}`);
      if (kind === "external") {
        await this.playExternalSound(name, waitUntilDone);
        return;
      }
      if (kind === "sound") {
        await this.playProjectSound(name, waitUntilDone);
        return;
      }
      throw new Error(`Asset is not audio: ${name}`);
    }
    async playExternalSound(name, waitUntilDone) {
      const asset = this.externalAssets.get(name);
      if (!asset) throw new Error(`External asset is not loaded: ${name}`);
      asset.mimeType = normalizeMimeType(asset.mimeType, asset.url || name);
      if (!asset.mimeType.startsWith("audio/")) throw new Error(`Asset is not audio: ${name} (${asset.mimeType})`);
      const objectUrl = URL.createObjectURL(new Blob([asset.data], { type: asset.mimeType }));
      const audio = new Audio(objectUrl);
      this.playingAudio.set(audio, name);
      let resolvePlayback;
      const playbackFinished = new Promise((resolve) => {
        resolvePlayback = resolve;
      });
      const cleanup = () => {
        this.playingAudio.delete(audio);
        URL.revokeObjectURL(objectUrl);
        resolvePlayback();
      };
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      const playPromise = audio.play();
      if (!waitUntilDone) {
        void playPromise.catch((error) => {
          console.warn(`Failed to play audio asset "${name}"`, error);
          cleanup();
        });
        return;
      }
      try {
        await playPromise;
      } catch (error) {
        cleanup();
        throw error;
      }
      await playbackFinished;
    }
    stopExternalAudio(audio) {
      try {
        audio.pause();
        audio.currentTime = 0;
        audio.dispatchEvent(new Event("ended"));
      } catch {
      } finally {
        this.playingAudio.delete(audio);
      }
    }
    async playProjectSound(name, waitUntilDone) {
      const { target, sound } = this.resolveSoundReference(name);
      const playResult = target.sprite?.soundBank?.playSound(target, sound.soundId);
      const playPromise = Promise.resolve(playResult);
      if (!waitUntilDone) {
        void playPromise.catch((error) => console.warn(`Failed to play project sound asset "${name}"`, error));
        return;
      }
      await playPromise;
    }
    projectAssetMimeType(dataFormat, kind) {
      if (dataFormat) {
        const guessed = guessMimeType(`asset.${dataFormat}`);
        if (guessed !== "application/octet-stream") return guessed;
      }
      return kind === "image" ? "image/x-scratch-costume" : "audio/x-scratch-sound";
    }
  }
  class AnimatedAssetManagerExtension extends AssetManagerExtension {
    constructor() {
      super();
      __publicField(this, "actorAnimations", /* @__PURE__ */ new Map());
      __publicField(this, "animationGeneration", 0);
      const stopAll = () => this.stopAllActorAnimations();
      const stopTarget = (target) => {
        if (target) this.stopTarget(target);
      };
      Scratch.vm.runtime.on?.("PROJECT_STOP_ALL", stopAll);
      Scratch.vm.runtime.on?.("PROJECT_START", stopAll);
      Scratch.vm.runtime.on?.("STOP_FOR_TARGET", stopTarget);
      Scratch.vm.runtime.on?.("RUNTIME_DISPOSED", stopAll);
    }
    async setThisSpriteSkin(args, util) {
      this.stopTarget(util.target);
      await super.setThisSpriteSkin(args, util);
    }
    async setSpriteSkin(args, util) {
      const actor = this.requireActorName(args.ACTOR ?? args.SPRITE);
      const target = this.resolveActorTarget(actor, util);
      this.stopActor(actor);
      await this.applyAssetToTarget(target, args.NAME, util);
    }
    startActorLoop(args, util) {
      const actor = this.requireActorName(args.ACTOR);
      const target = this.resolveActorTarget(actor, util);
      const assets = this.getAnimationAssetsInput(args);
      if (!assets.text) {
        if (normalizeName(args.DURATIONS)) {
          throw new Error(`DURATIONS must be empty when ${assets.argumentName} is empty.`);
        }
        this.stopActor(actor);
        return;
      }
      this.startActorAnimation(
        actor,
        target,
        this.parseAnimation(assets.text, args.DURATIONS, assets.argumentName, "loop")
      );
    }
    startActorSequence(args, util) {
      const actor = this.requireActorName(args.ACTOR);
      const target = this.resolveActorTarget(actor, util);
      const assets = this.getAnimationAssetsInput(args);
      if (!assets.text) throw new Error(`${assets.argumentName} is empty.`);
      this.startActorAnimation(
        actor,
        target,
        this.parseAnimation(assets.text, args.DURATIONS, assets.argumentName, "sequence")
      );
    }
    stopActorAnimation(args, util) {
      const actor = this.requireActorName(args.ACTOR);
      this.resolveActorTarget(actor, util);
      this.stopActor(actor);
    }
    async finishAllActorSequences() {
      const pending = [];
      for (const [actor, state] of [...this.actorAnimations]) {
        if (state.mode !== "sequence") continue;
        const finalImage = [...state.actions].reverse().find((action) => action.kind === "image");
        this.stopActor(actor);
        if (!finalImage || !this.runtime.targets.includes(state.target)) continue;
        pending.push(this.resolveSkin(finalImage.assetName).then((skin) => {
          if (this.runtime.targets.includes(state.target)) this.applySkinToTarget(state.target, skin);
        }));
      }
      await Promise.all(pending);
    }
    deleteAllMemoryAssets() {
      this.stopAllActorAnimations();
      super.deleteAllMemoryAssets();
    }
    getAnimationAssetsInput(args) {
      if (args.ASSETS !== void 0) {
        return { text: normalizeName(args.ASSETS), argumentName: "ASSETS" };
      }
      return { text: normalizeName(args.COSTUMES), argumentName: "COSTUMES" };
    }
    requireActorName(value) {
      const actor = normalizeName(value);
      if (!actor) throw new Error("Actor name is empty.");
      return actor;
    }
    resolveActorTarget(actor, util) {
      const matches = this.runtime.targets.filter(
        (target2) => !target2.isStage && target2.sprite?.name === actor
      );
      if (matches.length > 1) {
        throw new Error(`Actor name is not unique: ${actor}`);
      }
      const invokingTarget = util?.target;
      if (invokingTarget && !invokingTarget.isStage && invokingTarget.sprite?.name === actor) {
        return invokingTarget;
      }
      const target = matches[0] ?? this.findTargetByName(actor);
      if (!target) throw new Error(`Actor not found: ${actor}`);
      return target;
    }
    parseAnimation(assetsValue, durationsValue, argumentName, mode) {
      const assetNames = String(assetsValue ?? "").split(",").map((value) => value.trim());
      const durationsText = normalizeName(durationsValue);
      const durationTexts = durationsText ? durationsText.split(",").map((value) => value.trim()) : [];
      if (assetNames.some((name) => !name)) {
        throw new Error(`${argumentName} contains an empty item.`);
      }
      if (durationTexts.some((duration) => !duration)) {
        throw new Error("DURATIONS contains an empty item.");
      }
      const expectedDurationCount = mode === "loop" ? assetNames.length : assetNames.length - 1;
      if (durationTexts.length !== expectedDurationCount) {
        throw new Error(
          `${mode} requires ${expectedDurationCount} DURATIONS items for ${assetNames.length} ${argumentName} items, but received ${durationTexts.length}.`
        );
      }
      const intervalsMs = durationTexts.map((duration, index) => {
        const seconds = Number(duration);
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`DURATIONS item ${index + 1} must be a non-negative number: ${duration}`);
        }
        return seconds * 1e3;
      });
      if (mode === "loop" && !intervalsMs.some((durationMs) => durationMs > 0)) {
        throw new Error("DURATIONS for loop must contain at least one positive number.");
      }
      return {
        actions: assetNames.map((assetName) => this.createAnimationAction(assetName)),
        intervalsMs,
        mode
      };
    }
    startActorAnimation(actor, target, definition) {
      this.stopActor(actor);
      const state = {
        ...definition,
        actor,
        target,
        actionIndex: 0,
        deadline: performance.now(),
        timer: null,
        generation: ++this.animationGeneration
      };
      this.actorAnimations.set(actor, state);
      void this.showCurrentStep(actor, state);
    }
    createAnimationAction(assetName) {
      if (!this.isLoaded({ NAME: assetName })) {
        throw new Error(`Asset is not registered: ${assetName}`);
      }
      const mimeType = this.getAssetMimeType({ NAME: assetName });
      if (mimeType.startsWith("image/")) return { assetName, kind: "image" };
      if (mimeType.startsWith("audio/")) return { assetName, kind: "audio" };
      throw new Error(`Asset is neither image nor audio: ${assetName} (${mimeType || "unknown MIME type"})`);
    }
    async showCurrentStep(actor, state) {
      if (!this.isCurrent(actor, state)) return;
      const target = state.target;
      if (!this.runtime.targets.includes(target)) {
        this.stopActor(actor);
        return;
      }
      const batch = this.getCurrentBatch(state);
      if (!batch) {
        this.stopActor(actor);
        return;
      }
      try {
        let selectedImageIndex = -1;
        for (let index = 0; index < batch.actions.length; index += 1) {
          if (batch.actions[index]?.kind === "image") {
            selectedImageIndex = index;
          }
        }
        const selectedImage = batch.actions[selectedImageIndex];
        const selectedSkin = await (selectedImage ? this.resolveSkin(selectedImage.assetName) : Promise.resolve(null));
        if (!this.isCurrent(actor, state)) return;
        if (!this.runtime.targets.includes(target)) {
          this.stopActor(actor);
          return;
        }
        const soundStarts = [];
        for (let index = 0; index < batch.actions.length; index += 1) {
          const action = batch.actions[index];
          if (!action) continue;
          if (action.kind === "audio") {
            soundStarts.push(this.playResolvedSound(action.assetName, false));
          } else if (index === selectedImageIndex && selectedSkin) {
            this.applySkinToTarget(target, selectedSkin);
          }
        }
        await Promise.all(soundStarts);
      } catch (error) {
        this.stopActor(actor);
        const assetNames = batch.actions.map((action) => action.assetName).join(", ");
        console.error(
          `Failed to run actor "${target.sprite?.name ?? target.id}" actions "${assetNames}".`,
          error
        );
        return;
      }
      if (!this.isCurrent(actor, state)) return;
      const intervalMs = batch.intervalMs;
      const nextActionIndex = batch.nextActionIndex;
      if (intervalMs === null || nextActionIndex === null) {
        this.actorAnimations.delete(actor);
        return;
      }
      state.deadline += intervalMs;
      const now = performance.now();
      if (state.deadline <= now) {
        state.deadline = now + intervalMs;
      }
      const delay = state.deadline - now;
      state.timer = setTimeout(() => this.advance(actor, state, nextActionIndex), delay);
    }
    getCurrentBatch(state) {
      if (!state.actions[state.actionIndex]) return null;
      const actions = [];
      let actionIndex = state.actionIndex;
      for (let count = 0; count < state.actions.length; count += 1) {
        const action = state.actions[actionIndex];
        if (!action) return null;
        actions.push(action);
        const intervalMs = state.intervalsMs[actionIndex];
        if (intervalMs === void 0) {
          return { actions, intervalMs: null, nextActionIndex: null };
        }
        const nextActionIndex = (actionIndex + 1) % state.actions.length;
        if (intervalMs > 0) {
          return { actions, intervalMs, nextActionIndex };
        }
        actionIndex = nextActionIndex;
      }
      return null;
    }
    advance(actor, state, nextActionIndex) {
      if (!this.isCurrent(actor, state)) return;
      state.timer = null;
      state.actionIndex = nextActionIndex;
      void this.showCurrentStep(actor, state);
    }
    isCurrent(actor, state) {
      return this.actorAnimations.get(actor)?.generation === state.generation;
    }
    stopActor(actor) {
      const state = this.actorAnimations.get(actor);
      if (!state) return;
      this.actorAnimations.delete(actor);
      if (state.timer !== null) clearTimeout(state.timer);
    }
    stopTarget(target) {
      for (const [actor, state] of this.actorAnimations) {
        if (state.target === target) this.stopActor(actor);
      }
    }
    stopAllActorAnimations() {
      for (const actor of [...this.actorAnimations.keys()]) this.stopActor(actor);
    }
  }
  if (!Scratch.extensions.unsandboxed) {
    throw new Error("Asset Manager must run unsandboxed.");
  }
  Scratch.extensions.register(new AnimatedAssetManagerExtension());

})(Scratch);
