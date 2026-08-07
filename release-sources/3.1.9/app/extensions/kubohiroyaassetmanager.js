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
  const blocks = [{ "opcode": "registerAsset", "blockType": "COMMAND", "text": "register resource [RESOURCE_ID] as asset [NAME]", "description": "Registers an external URL, cached asset, sprite costume, stage backdrop, project sound, or runtime text variable under one asset name.", "arguments": { "RESOURCE_ID": { "type": "STRING", "defaultValue": "https://example.com/asset.png" }, "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "assetErrorType", "blockType": "REPORTER", "text": "asset registration error type", "description": "Returns the stable error code for the most recent asset registration failure, or an empty string when the latest registration succeeded.", "arguments": {} }, { "opcode": "assetErrorLabel", "blockType": "REPORTER", "text": "asset registration error label", "description": "Returns the relevant asset, resource, or actor name for the most recent registration failure, or an empty string when the latest registration succeeded.", "arguments": {} }, { "opcode": "loadAsset", "blockType": "COMMAND", "text": "load asset from URL [URL] or cache as [NAME]", "description": "Legacy compatibility block. Loads an external image or audio asset from the supplied URL, or from IndexedDB when the URL is empty.", "arguments": { "URL": { "type": "STRING", "defaultValue": "https://example.com/asset.png" }, "NAME": { "type": "STRING", "defaultValue": "asset1" } }, "hideFromPalette": true }, { "opcode": "deleteMemoryAsset", "blockType": "COMMAND", "text": "delete asset [NAME] from memory", "description": "Unregisters one asset. Owned external renderer skins are released; project costumes, sounds, and runtime variables are left unchanged.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "deleteAllMemoryAssets", "blockType": "COMMAND", "text": "delete all assets from memory", "description": "Unregisters all assets, releases owned external renderer skins, stops actor animations, and stops tracked external audio playback.", "arguments": {} }, { "opcode": "deleteCachedAsset", "blockType": "COMMAND", "text": "delete asset [NAME] from cache", "description": "Deletes one named external asset from the IndexedDB cache.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "deleteAllCachedAssets", "blockType": "COMMAND", "text": "delete all assets from cache", "description": "Clears all external assets from the IndexedDB cache.", "arguments": {} }, { "opcode": "isLoaded", "blockType": "BOOLEAN", "text": "asset [NAME] is loaded", "description": "Returns whether the named external, project-local, or runtime text asset is currently registered.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "setTextValue", "blockType": "COMMAND", "text": "set text asset [NAME] to [VALUE]", "description": "Sets the runtime text value for a text asset using Asset Manager's internal namespace.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "Narration" }, "VALUE": { "type": "STRING", "defaultValue": "Once upon a time..." } } }, { "opcode": "setTextStyle", "blockType": "COMMAND", "text": "set text asset [NAME] style [PROPERTY] to [VALUE]", "description": "Sets one runtime style property for a text asset. Supported properties are animation, font, color, width, and align. An empty value restores the default.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "Narration" }, "PROPERTY": { "type": "STRING", "defaultValue": "font" }, "VALUE": { "type": "STRING", "defaultValue": "Sans Serif" } } }, { "opcode": "setThisSpriteSkin", "blockType": "COMMAND", "text": "show asset [NAME] on this sprite", "description": "Applies a registered image asset or displays a registered runtime text asset on the current sprite or clone.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "setSpriteSkin", "blockType": "COMMAND", "text": "show asset [NAME] on [SPRITE] (compatibility)", "description": "Stops any actor animation and applies a registered image asset or displays a registered runtime text asset on a named sprite. This block is retained for compatibility.", "arguments": { "SPRITE": { "type": "STRING", "defaultValue": "Sprite1" }, "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "startActorLoop", "blockType": "COMMAND", "text": "loop actor [ACTOR] through assets [ASSETS] for seconds [DURATIONS]", "description": "Starts or replaces a background loop. ASSETS contains registered image or audio asset names. DURATIONS must have the same number of items; each item is the interval before the next asset, including the last-to-first interval. A zero makes the next asset start together with the preceding asset. If a simultaneous group has multiple image assets, only its last image is applied. Empty ASSETS and DURATIONS stop the actor animation.", "arguments": { "ACTOR": { "type": "STRING", "defaultValue": "Sprite1" }, "ASSETS": { "type": "STRING", "defaultValue": "asset1,asset2" }, "DURATIONS": { "type": "STRING", "defaultValue": "0.5,0.5" } } }, { "opcode": "startActorSequence", "blockType": "COMMAND", "text": "play actor [ACTOR] through assets [ASSETS] for seconds [DURATIONS] once in background", "description": "Starts or replaces a one-shot background sequence and returns immediately. ASSETS contains registered image or audio asset names. DURATIONS must have exactly one fewer item; each item is the interval before the next asset. A zero makes the next asset start together with the preceding asset. If a simultaneous group has multiple image assets, only its last image is applied.", "arguments": { "ACTOR": { "type": "STRING", "defaultValue": "Sprite1" }, "ASSETS": { "type": "STRING", "defaultValue": "asset1,asset2" }, "DURATIONS": { "type": "STRING", "defaultValue": "0.5" } } }, { "opcode": "stopActorAnimation", "blockType": "COMMAND", "text": "stop animation of actor [ACTOR]", "description": "Stops the actor's current loop or sequence and leaves the currently displayed skin unchanged.", "arguments": { "ACTOR": { "type": "STRING", "defaultValue": "Sprite1" } } }, { "opcode": "finishAllActorSequences", "blockType": "COMMAND", "text": "finish all actor sequences", "description": "Finishes every one-shot actor sequence on its final image without stopping loops.", "arguments": {} }, { "opcode": "setStageSkin", "blockType": "COMMAND", "text": "set stage backdrop to asset [NAME]", "description": "Applies a registered external image, sprite costume, or stage backdrop to the stage drawable.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "backdrop1" } } }, { "opcode": "playSound", "blockType": "COMMAND", "text": "play asset [NAME] as sound", "description": "Starts playback of a registered external audio asset or project sound without waiting for completion.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "sound1" } } }, { "opcode": "playSoundUntilDone", "blockType": "COMMAND", "text": "play asset [NAME] as sound until done", "description": "Plays a registered external audio asset or project sound and waits until playback ends or fails.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "sound1" } } }, { "opcode": "stopSound", "blockType": "COMMAND", "text": "stop asset sound [NAME]", "description": "Stops every active playback of one registered external or project sound asset without stopping other sounds.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "sound1" } } }, { "opcode": "stopAllSounds", "blockType": "COMMAND", "text": "stop all asset sounds", "description": "Stops all external and project sounds currently tracked by Asset Manager.", "arguments": {} }, { "opcode": "getAssetMimeType", "blockType": "REPORTER", "text": "MIME type of asset [NAME]", "description": "Returns the normalized MIME type of a registered external, project-local, or runtime text asset.", "arguments": { "NAME": { "type": "STRING", "defaultValue": "asset1" } } }, { "opcode": "getVersion", "blockType": "REPORTER", "text": "Asset Manager version", "description": "Returns the Asset Manager implementation version.", "arguments": {} }];
  const definitions = {
    extensionName,
    blocks
  };
  class AssetManagerError extends Error {
    constructor(code, message, context) {
      const hintText = context.hint ? ` ${context.hint}` : "";
      super(`[Asset Manager][${code}] ${message}${hintText}`, { cause: context.cause });
      __publicField(this, "code");
      __publicField(this, "operation");
      __publicField(this, "assetName");
      __publicField(this, "resourceId");
      __publicField(this, "actorName");
      __publicField(this, "expectedKind");
      __publicField(this, "actualKind");
      __publicField(this, "hint");
      __publicField(this, "candidates");
      this.name = "AssetManagerError";
      this.code = code;
      this.operation = context.operation;
      this.assetName = context.assetName;
      this.resourceId = context.resourceId;
      this.actorName = context.actorName;
      this.expectedKind = context.expectedKind;
      this.actualKind = context.actualKind;
      this.hint = context.hint;
      this.candidates = context.candidates ?? [];
    }
  }
  function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        current[rightIndex] = Math.min(
          (current[rightIndex - 1] ?? 0) + 1,
          (previous[rightIndex] ?? 0) + 1,
          (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
        );
      }
      previous.splice(0, previous.length, ...current);
    }
    return previous[right.length] ?? 0;
  }
  function suggestNames(value, choices, limit = 3) {
    const input = String(value ?? "").trim();
    if (!input || limit <= 0) return [];
    const normalizedInput = input.toLocaleLowerCase();
    const unique = [...new Set([...choices].map((choice) => choice.trim()).filter(Boolean))];
    return unique.map((choice, index) => ({
      choice,
      index,
      exactCaseInsensitive: choice.toLocaleLowerCase() === normalizedInput,
      distance: editDistance(normalizedInput, choice.toLocaleLowerCase())
    })).sort(
      (left, right) => Number(right.exactCaseInsensitive) - Number(left.exactCaseInsensitive) || left.distance - right.distance || left.index - right.index
    ).slice(0, limit).map(({ choice }) => choice);
  }
  function suggestionHint(candidates) {
    if (candidates.length === 0) return void 0;
    if (candidates.length === 1) return `Did you mean "${candidates[0]}"?`;
    return `Did you mean one of: ${candidates.map((candidate) => `"${candidate}"`).join(", ")}?`;
  }
  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }
  function configuredFlag(name) {
    const configured = globalThis.__TW_ASSET_MANAGER_FEATURE_FLAGS__?.[name];
    return configured === true || configured === "true";
  }
  const FEATURE_FLAGS = Object.freeze({
    ENABLE_LIVE_ASSET_REPLACEMENT: configuredFlag("ENABLE_LIVE_ASSET_REPLACEMENT"),
    ENABLE_STRICT_ASSET_KIND_REPLACEMENT: configuredFlag("ENABLE_STRICT_ASSET_KIND_REPLACEMENT")
  });
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
  const EXTENSION_VERSION = "0.4.1";
  const EXTENSION_DOCS_URI = "https://kubohiroya.github.io/turbowarp-asset-manager/";
  const DB_NAME = "tw-asset-manager";
  const DB_VERSION = 1;
  const STORE_NAME = "assets";
  const STAGE_RESOURCE_NAME = "@stage";
  const blockDefinitions = definitions.blocks;
  blockDefinitions.unshift(
    {
      opcode: "validateProjectAssetAddress",
      blockType: "REPORTER",
      text: "validate project asset address [RESOURCE_ID] for [NAME]",
      description: "Returns a JSON validation result without fetching, caching, registering, or rendering the asset.",
      arguments: {
        RESOURCE_ID: {
          type: "STRING",
          defaultValue: "costume:Sprite1:costume1"
        },
        NAME: {
          type: "STRING",
          defaultValue: "asset1"
        }
      },
      hideFromPalette: true
    },
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
  function requireAssetNameValue(value, operation = "registerAsset") {
    const name = normalizeName(value);
    if (!name) {
      throw new AssetManagerError("INVALID_ASSET_NAME", "Asset name is empty.", {
        operation,
        assetName: name,
        hint: "Provide a non-empty asset name."
      });
    }
    return name;
  }
  function requireTextAssetNameValue(value, operation = "registerAsset") {
    const name = requireAssetNameValue(value, operation);
    if (name.includes(":")) {
      throw new AssetManagerError(
        "INVALID_ASSET_NAME",
        `Text asset name "${name}" must not contain a colon.`,
        { operation, assetName: name, hint: "Use a logical name without a colon." }
      );
    }
    return name;
  }
  function findStageTarget(runtime) {
    const stage = runtime.targets.find((target) => target.isStage);
    if (!stage) {
      throw new AssetManagerError("SPRITE_NOT_FOUND", "Stage target was not found.", {
        operation: "resolveStage",
        actorName: STAGE_RESOURCE_NAME,
        hint: "Load a project with a valid stage target."
      });
    }
    return stage;
  }
  function findProjectTargetByName(runtime, name) {
    return runtime.targets.find(
      (target) => !target.isStage && target.isOriginal && target.sprite?.name === name
    ) ?? runtime.targets.find(
      (target) => !target.isStage && target.sprite?.name === name
    ) ?? null;
  }
  function findProjectCostume(target, costumeName, assetId) {
    const costumes = target.sprite?.costumes ?? [];
    return (assetId ? costumes.find((costume) => costume.assetId === assetId) : void 0) ?? costumes.find((costume) => costume.name === costumeName) ?? null;
  }
  function findProjectSound(target, soundName, assetId) {
    const sounds = target.sprite?.sounds ?? [];
    return (assetId ? sounds.find((sound) => sound.assetId === assetId) : void 0) ?? sounds.find((sound) => sound.name === soundName) ?? null;
  }
  function resolveCostumeAddress(runtime, name, spriteName, costumeName) {
    const target = findProjectTargetByName(runtime, spriteName);
    if (!target) {
      const candidates = suggestNames(
        spriteName,
        runtime.targets.flatMap(
          (candidate) => !candidate.isStage && candidate.sprite?.name ? [candidate.sprite.name] : []
        )
      );
      throw new AssetManagerError("SPRITE_NOT_FOUND", `Sprite not found: ${spriteName}.`, {
        operation: "registerAsset",
        assetName: name,
        actorName: spriteName,
        candidates,
        hint: suggestionHint(candidates)
      });
    }
    const costumes = target.sprite?.costumes ?? [];
    const costume = costumeName === null ? costumes.find((candidate) => candidate.name === name) ?? (costumes.length === 1 ? costumes[0] : null) : findProjectCostume(target, costumeName, null);
    if (!costume && costumeName === null && costumes.length > 1) {
      const candidates = suggestNames(name, costumes.map((candidate) => candidate.name));
      throw new AssetManagerError(
        "SOURCE_ASSET_NOT_FOUND",
        `Costume shorthand is ambiguous: ${spriteName} has multiple costumes and none is named ${name}.`,
        {
          operation: "registerAsset",
          assetName: name,
          actorName: spriteName,
          candidates,
          hint: suggestionHint(candidates) ?? "Specify the costume name explicitly."
        }
      );
    }
    const resolvedCostumeName = costume?.name ?? costumeName ?? name;
    if (!costume) {
      const candidates = suggestNames(
        resolvedCostumeName,
        costumes.map((candidate) => candidate.name)
      );
      throw new AssetManagerError(
        "SOURCE_ASSET_NOT_FOUND",
        `Costume not found: ${spriteName}/${resolvedCostumeName}.`,
        {
          operation: "registerAsset",
          assetName: name,
          actorName: spriteName,
          candidates,
          hint: suggestionHint(candidates)
        }
      );
    }
    return { target, costume, costumeName: resolvedCostumeName };
  }
  function resolveBackdropAddress(runtime, backdropName) {
    const target = findStageTarget(runtime);
    const costume = findProjectCostume(target, backdropName, null);
    if (!costume) {
      const candidates = suggestNames(
        backdropName,
        (target.sprite?.costumes ?? []).map((candidate) => candidate.name)
      );
      throw new AssetManagerError("SOURCE_ASSET_NOT_FOUND", `Backdrop not found: ${backdropName}.`, {
        operation: "registerAsset",
        assetName: backdropName,
        actorName: STAGE_RESOURCE_NAME,
        candidates,
        hint: suggestionHint(candidates)
      });
    }
    return { target, costume };
  }
  function resolveSoundAddress(runtime, spriteName, soundName, assetName = soundName) {
    const isStage = spriteName.toLowerCase() === STAGE_RESOURCE_NAME;
    const target = isStage ? findStageTarget(runtime) : findProjectTargetByName(runtime, spriteName);
    if (!target) {
      const candidates = suggestNames(
        spriteName,
        runtime.targets.flatMap((candidate) => candidate.sprite?.name ? [candidate.sprite.name] : [])
      );
      throw new AssetManagerError("SPRITE_NOT_FOUND", `Sound source not found: ${spriteName}.`, {
        operation: "registerAsset",
        assetName,
        actorName: spriteName,
        candidates,
        hint: suggestionHint(candidates)
      });
    }
    const sound = findProjectSound(target, soundName, null);
    if (!sound) {
      const candidates = suggestNames(
        soundName,
        (target.sprite?.sounds ?? []).map((candidate) => candidate.name)
      );
      throw new AssetManagerError("SOURCE_ASSET_NOT_FOUND", `Sound not found: ${spriteName}/${soundName}.`, {
        operation: "registerAsset",
        assetName,
        actorName: spriteName,
        candidates,
        hint: suggestionHint(candidates)
      });
    }
    return { target, sound, isStage };
  }
  function validateProjectAssetAddress(runtime, assetName, resourceIdentifier) {
    let fallbackType = "asset-name";
    let fallbackLabel = normalizeName(assetName);
    try {
      const name = requireAssetNameValue(assetName);
      const resourceId = normalizeName(resourceIdentifier);
      if (resourceId === "text" || resourceId.startsWith("text:")) {
        requireTextAssetNameValue(name);
      }
      fallbackType = "resource-id";
      fallbackLabel = resourceId;
      const resource = parseResourceIdentifier(resourceIdentifier, name);
      switch (resource.kind) {
        case "costume":
          resolveCostumeAddress(runtime, name, resource.spriteName, resource.costumeName);
          break;
        case "backdrop":
          resolveBackdropAddress(runtime, resource.backdropName);
          break;
        case "sound":
          resolveSoundAddress(runtime, resource.spriteName, resource.soundName, name);
          break;
        case "text":
          requireTextAssetNameValue(name);
          break;
      }
      return {
        ok: true,
        kind: resource.kind,
        projectLocal: resource.kind !== "cache" && resource.kind !== "external"
      };
    } catch (error) {
      return {
        ok: false,
        type: error instanceof AssetManagerError ? error.code : fallbackType === "asset-name" ? "INVALID_ASSET_NAME" : "RESOURCE_ID_INVALID",
        label: error instanceof AssetManagerError ? error.code === "SPRITE_NOT_FOUND" ? error.actorName ?? error.assetName ?? fallbackLabel : error.code === "RESOURCE_ID_INVALID" ? error.resourceId ?? error.assetName ?? fallbackLabel : error.assetName ?? error.actorName ?? error.resourceId ?? fallbackLabel : fallbackLabel,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
  class AssetManagerExtension {
    constructor(featureFlags = FEATURE_FLAGS) {
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
      __publicField(this, "successfulRegistrationVersions", /* @__PURE__ */ new Map());
      __publicField(this, "registrationCancellationVersions", /* @__PURE__ */ new Map());
      __publicField(this, "registrationCommits", /* @__PURE__ */ new Map());
      __publicField(this, "committedCacheRecords", /* @__PURE__ */ new Map());
      __publicField(this, "featureFlags");
      __publicField(this, "loadingBackdropName", "");
      __publicField(this, "lastAssetErrorType", "");
      __publicField(this, "lastAssetErrorLabel", "");
      __publicField(this, "assetErrorVersion", 0);
      this.featureFlags = Object.freeze({ ...featureFlags });
      this.runtime.on?.("STOP_FOR_TARGET", (target) => {
        if (target && !this.runtime.targets.includes(target)) {
          this.displayedAssets.delete(target.id);
        }
      });
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
        docsURI: EXTENSION_DOCS_URI,
        color1: "#5b7cfa",
        color2: "#425ed8",
        color3: "#2f46aa",
        blocks: blockDefinitions.map((block) => this.toScratchBlock(block))
      };
    }
    validateProjectAssetAddress(args) {
      return JSON.stringify(
        validateProjectAssetAddress(this.runtime, args.NAME, args.RESOURCE_ID)
      );
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
        let resource;
        try {
          resource = parseResourceIdentifier(args.RESOURCE_ID, name);
        } catch (error) {
          throw new AssetManagerError("RESOURCE_ID_INVALID", errorMessage(error), {
            operation: "registerAsset",
            assetName: name,
            resourceId,
            hint: "Use an HTTP(S) URL or a supported costume, backdrop, sound, or text resource ID.",
            cause: error
          });
        }
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
            await this.registerCostumeReference(name, resource.spriteName, resource.costumeName);
            return;
          case "backdrop":
            fallbackType = "backdrop";
            fallbackLabel = resource.backdropName;
            await this.registerBackdropReference(name, resource.backdropName);
            return;
          case "sound":
            fallbackType = "sound";
            fallbackLabel = resource.soundName;
            await this.registerSoundReference(name, resource.spriteName, resource.soundName);
            return;
          case "text":
            fallbackType = "text";
            fallbackLabel = resource.runtimeVariableName;
            await this.registerTextReference(name, resource.runtimeVariableName);
            return;
        }
      } catch (error) {
        const diagnostic = error instanceof AssetManagerError ? error : new AssetManagerError("REPLACEMENT_FAILED", errorMessage(error), {
          operation: "registerAsset",
          assetName: fallbackType === "asset-name" ? fallbackLabel : normalizeName(args.NAME),
          resourceId: normalizeName(args.RESOURCE_ID),
          hint: "The previous registration and display were kept. Check the resource and try again.",
          cause: error
        });
        if (this.assetErrorVersion === errorVersion) {
          if (diagnostic instanceof AssetManagerError) {
            this.lastAssetErrorType = diagnostic.code;
            this.lastAssetErrorLabel = diagnostic.code === "SPRITE_NOT_FOUND" ? diagnostic.actorName ?? diagnostic.assetName ?? fallbackLabel : diagnostic.code === "RESOURCE_ID_INVALID" ? diagnostic.resourceId ?? diagnostic.assetName ?? fallbackLabel : diagnostic.assetName ?? diagnostic.actorName ?? diagnostic.resourceId ?? fallbackLabel;
          }
        }
        throw diagnostic;
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
      const name = this.requireAssetName(args.NAME, "loadAsset");
      const resourceId = normalizeName(args.URL);
      try {
        await this.registerExternalAsset(resourceId, name);
      } catch (error) {
        if (error instanceof AssetManagerError) throw error;
        throw new AssetManagerError("REPLACEMENT_FAILED", errorMessage(error), {
          operation: "loadAsset",
          assetName: name,
          resourceId,
          hint: "The previous registration and display were kept. Check the URL or cache.",
          cause: error
        });
      }
    }
    deleteMemoryAsset(args) {
      this.unregisterAsset(normalizeName(args.NAME));
    }
    deleteAllMemoryAssets() {
      for (const name of this.registrationVersions.keys()) {
        this.cancelRegistrations(name);
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
      const name = normalizeName(args.NAME);
      await this.cacheDelete(name);
      this.committedCacheRecords.set(name, null);
    }
    async deleteAllCachedAssets() {
      await this.cacheClear();
      this.committedCacheRecords.clear();
    }
    isLoaded(args) {
      return this.assetRegistry.has(normalizeName(args.NAME));
    }
    async setThisSpriteSkin(args, util) {
      if (!util.target || util.target.isStage) {
        throw new AssetManagerError(
          "SPRITE_NOT_FOUND",
          "This block must be used on a sprite or its clone.",
          { operation: "setThisSpriteSkin", hint: "Run this block from a sprite target." }
        );
      }
      await this.applyAssetToTarget(util.target, args.NAME, util);
    }
    async setSpriteSkin(args, util) {
      const name = normalizeName(args.SPRITE);
      const target = this.findTargetByName(name);
      if (!target) {
        const candidates = suggestNames(
          name,
          this.runtime.targets.flatMap(
            (candidate) => !candidate.isStage && candidate.sprite?.name ? [candidate.sprite.name] : []
          )
        );
        throw new AssetManagerError("SPRITE_NOT_FOUND", `Sprite not found: ${name}.`, {
          operation: "setSpriteSkin",
          actorName: name,
          candidates,
          hint: suggestionHint(candidates)
        });
      }
      await this.applyAssetToTarget(target, args.NAME, util);
    }
    async setStageSkin(args) {
      await this.applyAssetToTarget(this.getStageTarget(), args.NAME);
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
      if (!kind) throw this.assetNotRegistered("stopSound", name);
      if (kind === "external") {
        const asset = this.externalAssets.get(name);
        if (!asset) throw this.assetNotRegistered("stopSound", name);
        asset.mimeType = normalizeMimeType(asset.mimeType, asset.url || name);
        if (!asset.mimeType.startsWith("audio/")) {
          throw this.assetTypeMismatch("stopSound", name, "audio", `external/${this.externalMediaKind(asset)}`);
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
      throw this.assetTypeMismatch("stopSound", name, "audio", kind);
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
        case "costume":
        case "backdrop": {
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
      const name = this.requireTextAssetName(args.NAME, "setTextValue");
      const kind = this.assetRegistry.get(name);
      if (kind !== void 0 && kind !== "text") {
        throw this.assetTypeMismatch("setTextValue", name, "text", kind);
      }
      const reference = this.textAssets.get(name);
      this.setRuntimeVariable(
        reference?.runtimeVariableName ?? textRuntimeVariableName(name),
        String(args.VALUE ?? "")
      );
      const targets = this.runtime.targets.filter(
        (target) => this.displayedAssets.get(target.id)?.assetName === name
      );
      await Promise.all(
        targets.map(async (target) => {
          await this.applyTextToTarget(target, name, { runtime: this.runtime, target });
          this.setDisplayBinding(target, name, "text");
        })
      );
    }
    setTextStyle(args) {
      const name = this.requireTextAssetName(args.NAME, "setTextStyle");
      const kind = this.assetRegistry.get(name);
      if (kind !== void 0 && kind !== "text") {
        throw this.assetTypeMismatch("setTextStyle", name, "text", kind);
      }
      let property;
      try {
        property = normalizeTextStyleProperty(args.PROPERTY);
      } catch (error) {
        throw new AssetManagerError("STYLE_PROPERTY_INVALID", errorMessage(error), {
          operation: "setTextStyle",
          assetName: name,
          hint: "Use animation, font, color, width, or align.",
          cause: error
        });
      }
      let value;
      try {
        value = normalizeTextStyleValue(property, args.VALUE);
      } catch (error) {
        throw new AssetManagerError("STYLE_VALUE_INVALID", errorMessage(error), {
          operation: "setTextStyle",
          assetName: name,
          hint: `Provide a valid ${property} value.`,
          cause: error
        });
      }
      this.setRuntimeVariable(textStyleRuntimeVariableName(name, property), value);
    }
    assetNotRegistered(operation, name) {
      const candidates = suggestNames(name, this.assetRegistry.keys());
      return new AssetManagerError(
        "ASSET_NOT_REGISTERED",
        `Cannot ${operation} asset "${name}": no registered asset has that name.`,
        {
          operation,
          assetName: name,
          candidates,
          hint: suggestionHint(candidates) ?? "Register the asset before using it."
        }
      );
    }
    assetTypeMismatch(operation, name, expectedKind, actualKind) {
      return new AssetManagerError(
        "ASSET_TYPE_MISMATCH",
        `Cannot ${operation} asset "${name}": expected ${expectedKind}, but it is ${actualKind}.`,
        {
          operation,
          assetName: name,
          expectedKind,
          actualKind,
          hint: `Use an asset registered as ${expectedKind}.`
        }
      );
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
    requireAssetName(value, operation = "registerAsset") {
      return requireAssetNameValue(value, operation);
    }
    requireTextAssetName(value, operation = "registerAsset") {
      return requireTextAssetNameValue(value, operation);
    }
    clearAssetError() {
      this.lastAssetErrorType = "";
      this.lastAssetErrorLabel = "";
    }
    beginRegistration(name) {
      const version = (this.registrationVersions.get(name) ?? 0) + 1;
      this.registrationVersions.set(name, version);
      return {
        version,
        cancellationVersion: this.registrationCancellationVersions.get(name) ?? 0
      };
    }
    cancelRegistrations(name) {
      const cancellationVersion = (this.registrationCancellationVersions.get(name) ?? 0) + 1;
      this.registrationCancellationVersions.set(name, cancellationVersion);
    }
    isRegistrationCancellationCurrent(name, token) {
      return (this.registrationCancellationVersions.get(name) ?? 0) === token.cancellationVersion;
    }
    async registerExternalAsset(url, name) {
      const token = this.beginRegistration(name);
      const record = url ? await this.fetchExternalAsset(url, name) : this.committedCacheRecords.has(name) ? this.committedCacheRecords.get(name) ?? null : await this.cacheGet(name);
      if (!this.isRegistrationCancellationCurrent(name, token)) return;
      if (!record) {
        const candidates = suggestNames(name, this.assetRegistry.keys());
        throw new AssetManagerError(
          "ASSET_NOT_REGISTERED",
          `Asset "${name}" is not cached and no URL was provided.`,
          {
            operation: "registerAsset",
            assetName: name,
            candidates,
            hint: suggestionHint(candidates) ?? "Register an HTTP(S) URL before loading from cache."
          }
        );
      }
      const prepared = {
        ...record,
        kind: "external",
        mimeType: normalizeMimeType(record.mimeType, record.url || name),
        skinId: null
      };
      await this.commitPreparedAsset(name, "external", prepared, token, url ? record : void 0);
    }
    async registerCostumeReference(name, spriteName, costumeName) {
      const token = this.beginRegistration(name);
      const { target, costume, costumeName: resolvedCostumeName } = resolveCostumeAddress(this.runtime, name, spriteName, costumeName);
      if (!this.isRegistrationCancellationCurrent(name, token)) return;
      await this.commitPreparedAsset(name, "costume", {
        kind: "costume",
        name,
        targetId: target.id,
        targetName: spriteName,
        isStage: false,
        costumeName: resolvedCostumeName,
        assetId: costume.assetId ?? null
      }, token);
    }
    async registerBackdropReference(name, backdropName) {
      const token = this.beginRegistration(name);
      const { target: stage, costume } = resolveBackdropAddress(this.runtime, backdropName);
      if (!this.isRegistrationCancellationCurrent(name, token)) return;
      await this.commitPreparedAsset(name, "backdrop", {
        kind: "backdrop",
        name,
        targetId: stage.id,
        targetName: STAGE_RESOURCE_NAME,
        isStage: true,
        costumeName: backdropName,
        assetId: costume.assetId ?? null
      }, token);
    }
    async registerSoundReference(name, spriteName, soundName) {
      const token = this.beginRegistration(name);
      const { target, sound, isStage } = resolveSoundAddress(
        this.runtime,
        spriteName,
        soundName,
        name
      );
      if (!this.isRegistrationCancellationCurrent(name, token)) return;
      await this.commitPreparedAsset(name, "sound", {
        kind: "sound",
        name,
        targetId: target.id,
        targetName: isStage ? STAGE_RESOURCE_NAME : spriteName,
        isStage,
        soundName,
        assetId: sound.assetId ?? null
      }, token);
    }
    async registerTextReference(name, runtimeVariableName) {
      const token = this.beginRegistration(name);
      this.requireTextAssetName(name);
      if (!this.isRegistrationCancellationCurrent(name, token)) return;
      await this.commitPreparedAsset(name, "text", {
        kind: "text",
        name,
        runtimeVariableName
      }, token);
    }
    unregisterAsset(name) {
      this.cancelRegistrations(name);
      const kind = this.assetRegistry.get(name);
      if (!kind) return;
      const asset = this.getRegisteredAsset(name, kind);
      this.removeRegisteredAsset(name, kind);
      this.disposeRegisteredAsset(asset);
      this.assetRegistry.delete(name);
      for (const [targetId, binding] of this.displayedAssets) {
        if (binding.assetName === name) this.displayedAssets.delete(targetId);
      }
    }
    async commitPreparedAsset(name, kind, prepared, token, cacheRecord) {
      const previousCommit = this.registrationCommits.get(name) ?? Promise.resolve();
      const commit = previousCommit.catch(() => void 0).then(async () => {
        if (!this.isRegistrationCancellationCurrent(name, token) || token.version < (this.successfulRegistrationVersions.get(name) ?? 0)) {
          this.disposeRegisteredAsset(prepared);
          return;
        }
        const currentKind = this.assetRegistry.get(name);
        const current = currentKind ? this.getRegisteredAsset(name, currentKind) : void 0;
        this.assertReplacementKind(name, currentKind, current, kind, prepared);
        let previousCached;
        let nextCached;
        if (cacheRecord) {
          previousCached = this.committedCacheRecords.has(name) ? this.committedCacheRecords.get(name) ?? null : await this.cacheGet(name);
          if (!this.isRegistrationCancellationCurrent(name, token)) {
            this.disposeRegisteredAsset(prepared);
            return;
          }
          nextCached = { ...cacheRecord, generation: token.version };
          await this.cachePut(nextCached);
          if (!this.isRegistrationCancellationCurrent(name, token)) {
            await this.restoreCacheIfGeneration(name, token.version, previousCached);
            this.disposeRegisteredAsset(prepared);
            return;
          }
        }
        try {
          await this.commitPreparedAssetNow(name, kind, prepared, token);
        } catch (error) {
          if (cacheRecord) {
            await this.restoreCacheIfGeneration(name, token.version, previousCached ?? null);
          }
          throw error;
        }
        if (!this.isRegistrationCancellationCurrent(name, token)) {
          if (cacheRecord) {
            await this.restoreCacheIfGeneration(name, token.version, previousCached ?? null);
          }
          return;
        }
        this.successfulRegistrationVersions.set(name, token.version);
        if (nextCached) this.committedCacheRecords.set(name, nextCached);
      });
      this.registrationCommits.set(name, commit);
      try {
        await commit;
      } finally {
        if (this.registrationCommits.get(name) === commit) this.registrationCommits.delete(name);
      }
    }
    async commitPreparedAssetNow(name, kind, prepared, token) {
      const currentKind = this.assetRegistry.get(name);
      const current = currentKind ? this.getRegisteredAsset(name, currentKind) : void 0;
      this.assertReplacementKind(name, currentKind, current, kind, prepared);
      if (currentKind === kind && current && this.featureFlags.ENABLE_LIVE_ASSET_REPLACEMENT) {
        await this.replaceRegisteredAsset(name, kind, current, prepared, token);
        return;
      }
      if (currentKind) this.removeRegisteredAsset(name, currentKind);
      this.installRegisteredAsset(name, kind, prepared);
      this.disposeRegisteredAsset(current);
      for (const [targetId, binding] of this.displayedAssets) {
        if (binding.assetName === name) this.displayedAssets.delete(targetId);
      }
    }
    assertReplacementKind(name, currentKind, current, nextKind, next) {
      if (!currentKind || !this.featureFlags.ENABLE_STRICT_ASSET_KIND_REPLACEMENT) return;
      let expectedKind = currentKind;
      let actualKind = nextKind;
      if (currentKind === "external" && nextKind === "external" && current?.kind === "external" && next.kind === "external") {
        const currentMedia = this.externalMediaKind(current);
        const nextMedia = this.externalMediaKind(next);
        if (currentMedia === nextMedia || currentMedia === "unknown" || nextMedia === "unknown") return;
        expectedKind = `external/${currentMedia}`;
        actualKind = `external/${nextMedia}`;
      } else if (currentKind === nextKind) {
        return;
      }
      throw new AssetManagerError(
        "ASSET_TYPE_CHANGE",
        `Cannot replace asset "${name}": it is currently registered as ${expectedKind}, but the new resource is ${actualKind}.`,
        {
          operation: "registerAsset",
          assetName: name,
          expectedKind,
          actualKind,
          hint: "Delete the existing asset first if this type change is intentional."
        }
      );
    }
    async replaceRegisteredAsset(name, kind, current, prepared, token) {
      const managedDisplays = [...this.displayedAssets].filter(
        ([, binding]) => binding.assetName === name && binding.assetKind === kind
      ).flatMap(([targetId, binding]) => {
        const target = this.runtime.targets.find((candidate) => candidate.id === targetId);
        if (target && this.isDisplayBindingCurrent(target, binding)) {
          return [{ target, binding }];
        }
        this.displayedAssets.delete(targetId);
        return [];
      });
      let preparedDisplays;
      try {
        const skin = kind === "text" || managedDisplays.length === 0 ? null : await this.resolveSkinFromAsset(name, kind, prepared);
        preparedDisplays = managedDisplays.map(({ target, binding }) => ({ target, binding, skin }));
      } catch (error) {
        this.disposeRegisteredAsset(prepared);
        throw new AssetManagerError(
          "REPLACEMENT_FAILED",
          `Cannot prepare replacement asset "${name}": ${errorMessage(error)}`,
          {
            operation: "registerAsset",
            assetName: name,
            hint: "The old registration and display were kept.",
            cause: error
          }
        );
      }
      if (!this.isRegistrationCancellationCurrent(name, token)) {
        this.disposeRegisteredAsset(prepared);
        return;
      }
      this.installRegisteredAsset(name, kind, prepared);
      const attemptedTargets = [];
      try {
        for (const display of preparedDisplays) {
          if (!this.isRegistrationCancellationCurrent(name, token)) break;
          if (!this.runtime.targets.includes(display.target)) {
            this.displayedAssets.delete(display.target.id);
            continue;
          }
          if (this.displayedAssets.get(display.target.id) !== display.binding) continue;
          if (!this.isDisplayBindingCurrent(display.target, display.binding)) {
            this.displayedAssets.delete(display.target.id);
            continue;
          }
          attemptedTargets.push(display.target);
          if (kind === "text") {
            await this.applyTextReferenceToTarget(
              display.target,
              name,
              prepared,
              { runtime: this.runtime, target: display.target }
            );
          } else if (display.skin) {
            this.applySkinToTarget(display.target, display.skin);
          }
          if (this.isRegistrationCancellationCurrent(name, token)) {
            this.setDisplayBinding(display.target, name, kind, display.skin?.skinId);
          }
        }
      } catch (error) {
        if (!this.isRegistrationCancellationCurrent(name, token)) {
          this.disposeRegisteredAsset(current);
          return;
        }
        this.installRegisteredAsset(name, kind, current);
        let rollbackError;
        for (const target of attemptedTargets) {
          if (!this.runtime.targets.includes(target)) continue;
          try {
            if (kind === "text") {
              await this.applyTextReferenceToTarget(
                target,
                name,
                current,
                { runtime: this.runtime, target }
              );
            } else {
              const currentSkin = await this.resolveSkinFromAsset(name, kind, current);
              this.applySkinToTarget(target, currentSkin);
              this.setDisplayBinding(target, name, kind, currentSkin.skinId);
              continue;
            }
            this.setDisplayBinding(target, name, kind);
          } catch (rollbackFailure) {
            rollbackError ?? (rollbackError = rollbackFailure);
          }
        }
        this.disposeRegisteredAsset(prepared);
        throw new AssetManagerError(
          "REPLACEMENT_FAILED",
          `Cannot replace asset "${name}": ${errorMessage(error)}`,
          {
            operation: "registerAsset",
            assetName: name,
            hint: rollbackError ? `The old registration was restored, but its display could not be reapplied: ${errorMessage(rollbackError)}` : "The old registration and display were restored.",
            cause: error
          }
        );
      }
      this.disposeRegisteredAsset(current);
    }
    getRegisteredAsset(name, kind) {
      if (kind === "external") return this.externalAssets.get(name);
      if (kind === "costume" || kind === "backdrop") return this.costumeAssets.get(name);
      if (kind === "sound") return this.soundAssets.get(name);
      return this.textAssets.get(name);
    }
    installRegisteredAsset(name, kind, asset) {
      if (kind === "external") this.externalAssets.set(name, asset);
      else if (kind === "costume" || kind === "backdrop") {
        this.costumeAssets.set(name, asset);
      } else if (kind === "sound") this.soundAssets.set(name, asset);
      else this.textAssets.set(name, asset);
      this.assetRegistry.set(name, kind);
    }
    removeRegisteredAsset(name, kind) {
      if (kind === "external") this.externalAssets.delete(name);
      else if (kind === "costume" || kind === "backdrop") this.costumeAssets.delete(name);
      else if (kind === "sound") this.soundAssets.delete(name);
      else this.textAssets.delete(name);
    }
    disposeRegisteredAsset(asset) {
      if (asset?.kind === "external") this.deleteOwnedSkinIfExists(asset);
    }
    externalMediaKind(asset) {
      const mimeType = normalizeMimeType(asset.mimeType, asset.url || asset.name);
      if (mimeType.startsWith("image/")) return "image";
      if (mimeType.startsWith("audio/")) return "audio";
      return "unknown";
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
    async restoreCacheIfGeneration(name, generation, previous) {
      const database = await this.openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const current = request.result;
          if (current?.generation !== generation) return;
          if (previous) store.put(previous);
          else store.delete(name);
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
    async fetchExternalAsset(url, name) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch asset "${name}": ${response.status} ${response.statusText}`);
      const blob = await response.blob();
      return {
        name,
        url,
        mimeType: normalizeMimeType(blob.type || response.headers.get("Content-Type"), url),
        data: await blob.arrayBuffer(),
        cachedAt: Date.now()
      };
    }
    getStageTarget() {
      return findStageTarget(this.runtime);
    }
    findTargetByName(name) {
      return findProjectTargetByName(this.runtime, name);
    }
    resolveReferencedTarget(targetId, targetName, isStage) {
      const byId = this.runtime.targets.find((target) => target.id === targetId);
      if (byId) return byId;
      if (isStage) return this.getStageTarget();
      const byName = this.findTargetByName(targetName);
      if (!byName) {
        const candidates = suggestNames(
          targetName,
          this.runtime.targets.flatMap((target) => target.sprite?.name ? [target.sprite.name] : [])
        );
        throw new AssetManagerError(
          "SPRITE_NOT_FOUND",
          `Asset source target no longer exists: ${targetName}.`,
          {
            operation: "resolveAsset",
            actorName: targetName,
            candidates,
            hint: suggestionHint(candidates)
          }
        );
      }
      return byName;
    }
    findCostume(target, costumeName, assetId) {
      return findProjectCostume(target, costumeName, assetId);
    }
    findSound(target, soundName, assetId) {
      return findProjectSound(target, soundName, assetId);
    }
    async resolveSkin(value) {
      const name = normalizeName(value);
      const kind = this.assetRegistry.get(name);
      if (!kind) throw this.assetNotRegistered("show", name);
      const asset = this.getRegisteredAsset(name, kind);
      if (!asset) throw this.assetNotRegistered("show", name);
      return this.resolveSkinFromAsset(name, kind, asset);
    }
    async applyAssetToTarget(target, value, util) {
      const name = normalizeName(value);
      const kind = this.assetRegistry.get(name);
      let skinId;
      if (!kind) throw this.assetNotRegistered("show", name);
      if (!this.runtime.targets.includes(target)) return;
      if (kind === "text") {
        await this.applyTextToTarget(target, name, util);
      } else if (kind === "external" || kind === "costume" || kind === "backdrop") {
        const skin = await this.resolveSkin(name);
        if (!this.runtime.targets.includes(target)) return;
        this.applySkinToTarget(target, skin);
        skinId = skin.skinId;
      } else {
        throw this.assetTypeMismatch("show", name, "image or text", kind);
      }
      if (!this.runtime.targets.includes(target)) return;
      this.setDisplayBinding(target, name, kind, skinId);
    }
    setDisplayBinding(target, name, kind, skinId) {
      if (kind === "sound") {
        this.displayedAssets.delete(target.id);
        return;
      }
      this.displayedAssets.set(target.id, {
        assetName: name,
        assetKind: kind,
        skinId: skinId ?? null
      });
    }
    isDisplayBindingCurrent(target, binding) {
      if (binding.assetKind === "text") return true;
      if (binding.skinId === null || target.drawableID === void 0 || target.drawableID === null) {
        return false;
      }
      return this.renderer._allDrawables?.[target.drawableID]?.skin?.id === binding.skinId;
    }
    applyResolvedSkinToTarget(target, name, skin) {
      const kind = this.assetRegistry.get(name);
      if (!kind) throw this.assetNotRegistered("show", name);
      if (kind !== "external" && kind !== "costume" && kind !== "backdrop") {
        throw this.assetTypeMismatch("show", name, "image", kind);
      }
      this.applySkinToTarget(target, skin);
      this.setDisplayBinding(target, name, kind, skin.skinId);
    }
    async applyTextToTarget(target, name, util) {
      if (target.isStage) throw this.assetTypeMismatch("show on stage", name, "image", "text");
      const reference = this.textAssets.get(name);
      if (!reference) throw this.assetNotRegistered("show", name);
      await this.applyTextReferenceToTarget(target, name, reference, util);
    }
    async applyTextReferenceToTarget(target, name, reference, util) {
      if (target.isStage) throw this.assetTypeMismatch("show on stage", name, "image", "text");
      const temporaryVariables = this.requireTemporaryVariables("show", name);
      const getRuntimeVariable = (variableName) => temporaryVariables.getRuntimeVariable({ VAR: variableName });
      let style;
      try {
        style = resolveTextStyle(name, this.runtime.stageWidth, getRuntimeVariable);
      } catch (error) {
        throw new AssetManagerError("STYLE_VALUE_INVALID", errorMessage(error), {
          operation: "show",
          assetName: name,
          hint: "Correct the stored text style value before showing this asset.",
          cause: error
        });
      }
      const setFont = this.requireAnimatedTextOpcode("text_setFont", name);
      const setColor = this.requireAnimatedTextOpcode("text_setColor", name);
      const setWidth = this.requireAnimatedTextOpcode("text_setWidth", name);
      const setOutlineWidth = this.runtime.getOpcodeFunction?.("text_setOutlineWidth");
      const setOutlineColor = this.runtime.getOpcodeFunction?.("text_setOutlineColor");
      const displayText = this.requireAnimatedTextOpcode(
        style.animation === "none" ? "text_setText" : "text_animateText",
        name
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
          console.error(new AssetManagerError(
            "ANIMATION_FAILED",
            `Animated Text failed for asset "${name}": ${errorMessage(error)}`,
            {
              operation: "animateText",
              assetName: name,
              hint: "Check the Animated Text extension and animation value.",
              cause: error
            }
          ));
        });
      }
    }
    requireTemporaryVariables(operation = "setTextValue", assetName) {
      const temporaryVariables = this.runtime.ext_lmsTempVars2;
      if (!temporaryVariables?.getRuntimeVariable) {
        throw new AssetManagerError(
          "DEPENDENCY_MISSING",
          "Temporary Variables extension is not loaded.",
          {
            operation,
            assetName,
            hint: "Load the lmsTempVars2 extension before using runtime text assets."
          }
        );
      }
      return temporaryVariables;
    }
    setRuntimeVariable(name, value) {
      const assetName = name.split(":")[1];
      const temporaryVariables = this.requireTemporaryVariables("setRuntimeVariable", assetName);
      if (!temporaryVariables.setRuntimeVariable) {
        throw new AssetManagerError(
          "DEPENDENCY_MISSING",
          "Temporary Variables extension does not support setting runtime variables.",
          {
            operation: "setRuntimeVariable",
            assetName,
            hint: "Load a Temporary Variables version that provides setRuntimeVariable."
          }
        );
      }
      temporaryVariables.setRuntimeVariable({ VAR: name, STRING: value });
    }
    requireAnimatedTextOpcode(opcode, assetName) {
      const implementation = this.runtime.getOpcodeFunction?.(opcode);
      if (!implementation) {
        throw new AssetManagerError(
          "DEPENDENCY_MISSING",
          `Animated Text extension is not loaded or does not provide ${opcode}.`,
          {
            operation: "show",
            assetName,
            hint: "Load a compatible Animated Text extension before showing text assets."
          }
        );
      }
      return implementation;
    }
    async ensureExternalSkin(name) {
      const asset = this.externalAssets.get(name);
      if (!asset) throw this.assetNotRegistered("show", name);
      return this.ensureExternalAssetSkin(asset, name);
    }
    async ensureExternalAssetSkin(asset, name) {
      asset.mimeType = normalizeMimeType(asset.mimeType, asset.url || name);
      if (!asset.mimeType.startsWith("image/")) {
        throw this.assetTypeMismatch("show", name, "image", `external/${this.externalMediaKind(asset)}`);
      }
      if (asset.skinId !== null) return asset.skinId;
      const blob = new Blob([asset.data], { type: asset.mimeType });
      asset.skinId = asset.mimeType === "image/svg+xml" ? this.renderer.createSVGSkin(await blob.text()) : this.renderer.createBitmapSkin(await createImageBitmap(blob), 1);
      return asset.skinId;
    }
    async resolveSkinFromAsset(name, kind, asset) {
      if (kind === "external" && asset.kind === "external") {
        return { skinId: await this.ensureExternalAssetSkin(asset, name), sourceSize: null };
      }
      if ((kind === "costume" || kind === "backdrop") && (asset.kind === "costume" || asset.kind === "backdrop")) {
        const { target, costume } = this.resolveCostumeAssetReference(name, asset);
        return {
          skinId: costume.skinId,
          sourceSize: target.isStage || !Number.isFinite(target.size) ? null : target.size
        };
      }
      throw this.assetTypeMismatch("show", name, "image", kind);
    }
    resolveCostumeReference(name) {
      const reference = this.costumeAssets.get(name);
      if (!reference) throw this.assetNotRegistered("show", name);
      return this.resolveCostumeAssetReference(name, reference);
    }
    resolveCostumeAssetReference(name, reference) {
      const target = this.resolveReferencedTarget(reference.targetId, reference.targetName, reference.isStage);
      const costume = this.findCostume(target, reference.costumeName, reference.assetId);
      if (!costume) {
        const candidates = suggestNames(
          reference.costumeName,
          (target.sprite?.costumes ?? []).map((candidate) => candidate.name)
        );
        throw new AssetManagerError(
          "SOURCE_ASSET_NOT_FOUND",
          `Costume no longer exists: ${reference.targetName}/${reference.costumeName}.`,
          {
            operation: "show",
            assetName: name,
            actorName: reference.targetName,
            candidates,
            hint: suggestionHint(candidates)
          }
        );
      }
      if (typeof costume.skinId !== "number") {
        throw new AssetManagerError(
          "SOURCE_ASSET_NOT_FOUND",
          `Costume skin is not available: ${reference.targetName}/${reference.costumeName}.`,
          {
            operation: "show",
            assetName: name,
            actorName: reference.targetName,
            hint: "Wait for the project costume to finish loading and try again."
          }
        );
      }
      return { target, costume };
    }
    resolveSoundReference(name) {
      const reference = this.soundAssets.get(name);
      if (!reference) throw this.assetNotRegistered("playSound", name);
      const target = this.resolveReferencedTarget(reference.targetId, reference.targetName, reference.isStage);
      const sound = this.findSound(target, reference.soundName, reference.assetId);
      if (!sound) {
        const candidates = suggestNames(
          reference.soundName,
          (target.sprite?.sounds ?? []).map((candidate) => candidate.name)
        );
        throw new AssetManagerError(
          "SOURCE_ASSET_NOT_FOUND",
          `Sound no longer exists: ${reference.targetName}/${reference.soundName}.`,
          {
            operation: "playSound",
            assetName: name,
            actorName: reference.targetName,
            candidates,
            hint: suggestionHint(candidates)
          }
        );
      }
      if (!sound.soundId) {
        throw new AssetManagerError(
          "SOURCE_ASSET_NOT_FOUND",
          `Sound ID is not available: ${reference.targetName}/${reference.soundName}.`,
          {
            operation: "playSound",
            assetName: name,
            actorName: reference.targetName,
            hint: "Wait for the project sound to finish loading and try again."
          }
        );
      }
      if (!target.sprite?.soundBank) {
        throw new AssetManagerError(
          "DEPENDENCY_MISSING",
          `Sound bank is not available: ${reference.targetName}.`,
          {
            operation: "playSound",
            assetName: name,
            actorName: reference.targetName,
            hint: "Use a TurboWarp runtime with sound support."
          }
        );
      }
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
        throw new AssetManagerError(
          "SPRITE_NOT_FOUND",
          `Target drawable not found: ${target.sprite?.name ?? "unknown"}.`,
          {
            operation: "show",
            actorName: target.sprite?.name ?? target.id,
            hint: "Use a live target with an initialized renderer drawable."
          }
        );
      }
      this.renderer.updateDrawableSkinId(target.drawableID, skin.skinId);
      if (!target.isStage && target.isOriginal && skin.sourceSize !== null && target.size !== skin.sourceSize) {
        target.setSize(skin.sourceSize);
      }
      target.emitVisualChange?.();
      this.runtime.requestRedraw?.();
    }
    async playResolvedSound(value, waitUntilDone) {
      const name = normalizeName(value);
      const kind = this.assetRegistry.get(name);
      if (!kind) throw this.assetNotRegistered("playSound", name);
      if (kind === "external") {
        await this.playExternalSound(name, waitUntilDone);
        return;
      }
      if (kind === "sound") {
        await this.playProjectSound(name, waitUntilDone);
        return;
      }
      throw this.assetTypeMismatch("playSound", name, "audio", kind);
    }
    async playExternalSound(name, waitUntilDone) {
      const asset = this.externalAssets.get(name);
      if (!asset) throw this.assetNotRegistered("playSound", name);
      asset.mimeType = normalizeMimeType(asset.mimeType, asset.url || name);
      if (!asset.mimeType.startsWith("audio/")) {
        throw this.assetTypeMismatch(
          "playSound",
          name,
          "audio",
          `external/${this.externalMediaKind(asset)}`
        );
      }
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
          cleanup();
          console.error(this.playbackError(name, error));
        });
        return;
      }
      try {
        await playPromise;
      } catch (error) {
        cleanup();
        throw this.playbackError(name, error);
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
        void playPromise.catch((error) => console.error(this.playbackError(name, error)));
        return;
      }
      try {
        await playPromise;
      } catch (error) {
        throw this.playbackError(name, error);
      }
    }
    playbackError(name, cause) {
      return new AssetManagerError(
        "PLAYBACK_FAILED",
        `Failed to play audio asset "${name}": ${errorMessage(cause)}`,
        {
          operation: "playSound",
          assetName: name,
          hint: "Check browser audio permissions and the registered audio resource.",
          cause
        }
      );
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
    constructor(featureFlags = FEATURE_FLAGS) {
      super(featureFlags);
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
          if (this.runtime.targets.includes(state.target)) {
            this.applyResolvedSkinToTarget(state.target, finalImage.assetName, skin);
          }
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
      if (!actor) {
        throw new AssetManagerError("SPRITE_NOT_FOUND", "Actor name is empty.", {
          operation: "resolveActor",
          actorName: actor,
          hint: "Provide the name of a project sprite or actor clone."
        });
      }
      return actor;
    }
    actorNameOf(target) {
      return normalizeName(target.lookupVariableByNameAndType?.("actorName", "")?.value);
    }
    resolveActorTarget(actor, util) {
      const invokingTarget = util?.target;
      if (invokingTarget && !invokingTarget.isStage && (this.actorNameOf(invokingTarget) === actor || invokingTarget.sprite?.name === actor)) {
        return invokingTarget;
      }
      const actorNameMatches = this.runtime.targets.filter(
        (target2) => !target2.isStage && this.actorNameOf(target2) === actor
      );
      const matches = actorNameMatches.length > 0 ? actorNameMatches : this.runtime.targets.filter(
        (target2) => !target2.isStage && target2.sprite?.name === actor
      );
      if (matches.length > 1) {
        throw new AssetManagerError(
          "SPRITE_NAME_AMBIGUOUS",
          `Actor name is not unique: ${actor}.`,
          {
            operation: "resolveActor",
            actorName: actor,
            hint: "Give every actor target a unique name."
          }
        );
      }
      const target = matches[0] ?? this.findTargetByName(actor);
      if (!target) {
        const candidates = suggestNames(
          actor,
          [
            ...new Set(
              this.runtime.targets.flatMap((candidate) => {
                if (candidate.isStage) return [];
                return [this.actorNameOf(candidate), candidate.sprite?.name ?? ""].filter(Boolean);
              })
            )
          ]
        );
        throw new AssetManagerError("SPRITE_NOT_FOUND", `Actor not found: ${actor}.`, {
          operation: "resolveActor",
          actorName: actor,
          candidates,
          hint: suggestionHint(candidates)
        });
      }
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
        throw this.assetNotRegistered("animate", assetName);
      }
      const mimeType = this.getAssetMimeType({ NAME: assetName });
      if (mimeType.startsWith("image/")) return { assetName, kind: "image" };
      if (mimeType.startsWith("audio/")) return { assetName, kind: "audio" };
      throw this.assetTypeMismatch(
        "animate",
        assetName,
        "image or audio",
        mimeType || "unknown MIME type"
      );
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
            this.applyResolvedSkinToTarget(target, action.assetName, selectedSkin);
          }
        }
        await Promise.all(soundStarts);
      } catch (error) {
        this.stopActor(actor);
        const assetNames = batch.actions.map((action) => action.assetName).join(", ");
        console.error(new AssetManagerError(
          "ANIMATION_FAILED",
          `Failed to run actor "${target.sprite?.name ?? target.id}" actions "${assetNames}": ${errorMessage(error)}`,
          {
            operation: "animateActor",
            actorName: target.sprite?.name ?? target.id,
            hint: "Check that every animation asset is still registered and usable.",
            cause: error
          }
        ));
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
