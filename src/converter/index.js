import {readFile} from 'node:fs/promises';
import path from 'node:path';

import {stringify} from 'yaml';

import {installBundleTransactionally} from '../builder/atomic-output.js';

const identifierPattern = /^[\p{L}_][\p{L}\p{N}_-]*$/u;
const dangerousIdentifiers = new Set(['__proto__', 'constructor', 'prototype']);
const supportedKeyCodePattern =
  /^(?:Space|Enter|Escape|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Digit[0-9]|Key[A-Z]|Numpad[0-9]|F(?:[1-9]|1[0-2]))$/u;
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const textDirections = new Set([
  'up',
  'up-up-right',
  'up-right',
  'right-up-right',
  'right',
  'right-down-right',
  'down-right',
  'down-down-right',
  'down',
  'down-down-left',
  'down-left',
  'left-down-left',
  'left',
  'left-up-left',
  'up-left',
  'up-up-left',
]);

/**
 * @typedef {{line: number, column: number}} SourcePosition
 * @typedef {{start: SourcePosition, end: SourcePosition}} SourceRange
 * @typedef {{key: string, value: string, lineNumber: number, columnNumber: number, sourceLine: string}} Dsl32Command
 * @typedef {{code: string, severity: 'error' | 'warning', message: string, sourceId: string, range: SourceRange, command: string | null}} ConversionDiagnostic
 * @typedef {{kind: 'backdrop', name: string, command: Dsl32Command} | {kind: 'sound', name: string, sourceTarget: string, command: Dsl32Command} | {kind: 'costume', name: string, sourceTarget: string, command: Dsl32Command} | {kind: 'poseModel', file: string, loading?: 'eager' | 'lazy', command: Dsl32Command} | {kind: 'poseModel', delivery: 'remote', source: {url: string}, loading: 'lazy', command: Dsl32Command}} ConvertedAsset
 * @typedef {{kind: 'asset' | 'actor' | 'branch' | 'scene' | 'style', id: string, expectedKind?: 'backdrop' | 'costume' | 'sound' | 'poseModel', actor?: string, command: Dsl32Command}} ConversionReference
 * @typedef {{ok: boolean, source: string, document: Record<string, any> | null, yaml: string | null, diagnostics: ConversionDiagnostic[]}} ConversionResult
 * @typedef {{id: string, file: string, loading?: 'eager' | 'lazy'}} PoseModelReplacement
 */

/** @param {Dsl32Command | null | undefined} command */
function sourceRange(command) {
  const line = command?.lineNumber ?? 1;
  const column = command?.columnNumber ?? 1;
  const sourceLine = command?.sourceLine ?? '';
  return {
    start: {line, column},
    end: {line, column: Math.max(column, sourceLine.length + 1)},
  };
}

/**
 * @param {string} sourceId
 * @param {string} code
 * @param {'error' | 'warning'} severity
 * @param {string} message
 * @param {Dsl32Command | null} [command]
 * @returns {ConversionDiagnostic}
 */
function createDiagnostic(sourceId, code, severity, message, command = null) {
  return {
    code,
    severity,
    message,
    sourceId,
    range: sourceRange(command),
    command: command?.key ?? null,
  };
}

/** @param {ConversionDiagnostic} left @param {ConversionDiagnostic} right */
function compareDiagnostics(left, right) {
  return (
    left.range.start.line - right.range.start.line ||
    left.range.start.column - right.range.start.column ||
    (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)
  );
}

/** @param {string | Uint8Array} input */
function decodeSource(input) {
  if (typeof input === 'string') return input;
  if (input instanceof Uint8Array) {
    return new TextDecoder('utf-8', {fatal: true}).decode(input);
  }
  throw new TypeError('DSL 3.1/3.2 source must be a string or Uint8Array.');
}

/** @param {string | Uint8Array} input */
function canonicalizeSource(input) {
  return decodeSource(input)
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?|\n/gu, '\n');
}

/** @param {string} value */
function splitList(value) {
  return value.split(',').map((item) => item.trim());
}

/** @param {Iterable<readonly [string, any]>} entries @returns {Record<string, any>} */
function ownObject(entries) {
  return Object.fromEntries(entries);
}

/** @param {string} file */
function isSafePoseModelFile(file) {
  const components = file.split('/');
  return !(
    !file ||
    file.startsWith('/') ||
    /^[A-Za-z]:[\\/]/u.test(file) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(file) ||
    file.includes('\\') ||
    file.includes('\0') ||
    components.some((component) => component === '.' || component === '..')
  );
}

/** @param {unknown} input @returns {Readonly<Record<string, PoseModelReplacement>>} */
function normalizePoseModels(input) {
  if (input === undefined) return Object.freeze({});
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError(
      'poseModels must be an object keyed by exact DSL 3.1/3.2 TMPoseURL values.',
    );
  }
  const normalized = new Map();
  for (const [sourceUrl, rawReplacement] of Object.entries(input)) {
    if (!sourceUrl) throw new TypeError('poseModels must not contain an empty TMPoseURL key.');
    if (
      typeof rawReplacement !== 'object' ||
      rawReplacement === null ||
      Array.isArray(rawReplacement)
    ) {
      throw new TypeError(`poseModels[${sourceUrl}] must be an object.`);
    }
    const replacement = /** @type {Record<string, unknown>} */ (rawReplacement);
    const unknownKeys = Object.keys(replacement).filter(
      (key) => !['id', 'file', 'loading'].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `poseModels[${sourceUrl}] contains unknown keys: ${unknownKeys.join(', ')}.`,
      );
    }
    if (typeof replacement.id !== 'string' || typeof replacement.file !== 'string') {
      throw new TypeError(`poseModels[${sourceUrl}] requires string id and file fields.`);
    }
    if (replacement.id.length === 0 || dangerousIdentifiers.has(replacement.id)) {
      throw new TypeError(`poseModels[${sourceUrl}].id must be a non-empty safe string.`);
    }
    if (!isSafePoseModelFile(replacement.file)) {
      throw new TypeError(`poseModels[${sourceUrl}].file must be a safe project-relative path.`);
    }
    if (
      replacement.loading !== undefined &&
      replacement.loading !== 'eager' &&
      replacement.loading !== 'lazy'
    ) {
      throw new TypeError(`poseModels[${sourceUrl}].loading must be eager or lazy.`);
    }
    normalized.set(sourceUrl, {
      id: replacement.id,
      file: replacement.file,
      ...(replacement.loading ? {loading: replacement.loading} : {}),
    });
  }
  return Object.freeze(ownObject(normalized));
}

class Converter {
  /** @param {string} source @param {string} sourceId @param {Readonly<Record<string, PoseModelReplacement>>} poseModels */
  constructor(source, sourceId, poseModels) {
    this.source = source;
    this.sourceId = sourceId;
    /** @type {ConversionDiagnostic[]} */
    this.diagnostics = [];
    /** @type {Map<string, ConvertedAsset>} */
    this.assets = new Map();
    /** @type {Map<string, string>} */
    this.actors = new Map();
    /** @type {Map<string, Record<string, any>>} */
    this.textStyles = new Map();
    /** @type {Map<string, string | number | boolean>} */
    this.variables = new Map();
    /** @type {Map<string, Dsl32Command>} */
    this.variableCommands = new Map();
    /** @type {Map<string, Record<string, any>[]>} */
    this.scenes = new Map();
    /** @type {Map<string, string>} */
    this.scenePoseModels = new Map();
    /** @type {Map<string, string>} */
    this.remotePoseModels = new Map();
    this.nextRemotePoseModelId = 1;
    /** @type {Map<string, Dsl32Command>} */
    this.scenesUsingPose = new Map();
    /** @type {Map<string, Record<string, any>[]>} */
    this.branches = new Map();
    /** @type {ConversionReference[]} */
    this.references = [];
    /** @type {Map<string, Set<string>>} */
    this.costumeUses = new Map();
    /** @type {Map<string, Dsl32Command>} */
    this.styleReferences = new Map();
    /** @type {Record<string, string> | null} */
    this.cover = null;
    /** @type {{backdrop?: string, costumes?: string[]} | null} */
    this.loading = null;
    /** @type {{idleSound: string, chargeSound: string, sequence?: Record<string, number>} | null} */
    this.poseRecognition = null;
    /** @type {string | null} */
    this.currentScene = null;
    this.poseModels = poseModels;
    this.versionCommands = 0;
  }

  /** @param {string} code @param {string} message @param {Dsl32Command | null} [command] */
  error(code, message, command = null) {
    this.diagnostics.push(createDiagnostic(this.sourceId, code, 'error', message, command));
  }

  /** @param {string} code @param {string} message @param {Dsl32Command | null} [command] */
  warning(code, message, command = null) {
    this.diagnostics.push(createDiagnostic(this.sourceId, code, 'warning', message, command));
  }

  parseCommands() {
    /** @type {Dsl32Command[]} */
    const commands = [];
    for (const [index, sourceLine] of this.source.split('\n').entries()) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line === '---') {
        commands.push({
          key: '---',
          value: '',
          lineNumber: index + 1,
          columnNumber: sourceLine.indexOf(line) + 1,
          sourceLine,
        });
        continue;
      }
      const separator = line.indexOf('=');
      if (separator < 1) {
        this.error('K4-CONVERT-COMMAND-001', 'DSL 3.1/3.2 commands must use key=value syntax.', {
          key: '',
          value: '',
          lineNumber: index + 1,
          columnNumber: sourceLine.search(/\S/u) + 1,
          sourceLine,
        });
        continue;
      }
      commands.push({
        key: line.slice(0, separator).trim(),
        value: line.slice(separator + 1).trim(),
        lineNumber: index + 1,
        columnNumber: sourceLine.indexOf(line) + 1,
        sourceLine,
      });
    }
    return commands;
  }

  /** @param {string} id @param {string} label @param {Dsl32Command} command */
  validateIdentifier(id, label, command) {
    if (id !== id.normalize('NFC')) {
      this.error('K4-CONVERT-ID-NFC', `${label} must use Unicode NFC: ${id}`, command);
      return false;
    }
    if (!identifierPattern.test(id) || dangerousIdentifiers.has(id)) {
      this.error(
        'K4-CONVERT-ID-INVALID',
        `${label} is not a valid DSL 4.0 identifier: ${id}`,
        command,
      );
      return false;
    }
    return true;
  }

  /** @param {string} id @param {string} label @param {Dsl32Command} command */
  validateLiteralId(id, label, command) {
    if (id.length === 0 || dangerousIdentifiers.has(id)) {
      this.error('K4-CONVERT-ID-INVALID', `${label} must be a non-empty safe string.`, command);
      return false;
    }
    return true;
  }

  /** @param {Map<string, any>} collection @param {string} id @param {string} label @param {Dsl32Command} command */
  rejectDuplicate(collection, id, label, command) {
    if (!collection.has(id)) return false;
    this.error('K4-CONVERT-DUPLICATE', `${label} is declared more than once: ${id}`, command);
    return true;
  }

  /** @param {Dsl32Command} command */
  parseVersion(command) {
    this.versionCommands += 1;
    if (this.versionCommands > 1) {
      this.error('K4-CONVERT-VERSION-DUPLICATE', 'kamishibai is declared more than once.', command);
    }
    if (command.value !== '3.1' && command.value !== '3.2') {
      this.error(
        'K4-CONVERT-VERSION-001',
        `convert-dsl4 only accepts kamishibai=3.1 or kamishibai=3.2, received ${command.value || '(empty)'}.`,
        command,
      );
      return;
    }
    if (command.value === '3.1') {
      this.warning(
        'K4-CONVERT-VERSION-31-COMPAT',
        'DSL 3.1 is interpreted through the maintained DSL 3.2 compatibility grammar; review every conversion warning before replacing the original work.',
        command,
      );
    }
  }

  /** @param {Dsl32Command} command */
  parseAsset(command) {
    const separator = command.value.indexOf(',');
    if (separator < 1) {
      this.error('K4-CONVERT-ASSET-001', 'asset requires NAME,RESOURCE_ID.', command);
      return;
    }
    const id = command.value.slice(0, separator).trim();
    const address = command.value.slice(separator + 1).trim();
    if (!this.validateLiteralId(id, 'Asset ID', command)) return;
    if (this.rejectDuplicate(this.assets, id, 'Asset', command)) return;
    const asset = this.parseAssetAddress(id, address, command);
    if (asset) this.assets.set(id, asset);
  }

  /** @param {string} id @param {string} address @param {Dsl32Command} command @returns {ConvertedAsset | null} */
  parseAssetAddress(id, address, command) {
    if (/^https?:\/\//iu.test(address) || !address) {
      this.error(
        'K4-CONVERT-ASSET-REMOTE',
        `Asset ${id} must be embedded into the SB3 before conversion; remote and cache addresses cannot be represented by DSL 4.0: ${address || '(empty)'}`,
        command,
      );
      return null;
    }
    const separator = address.indexOf(':');
    const scheme = (separator < 0 ? address : address.slice(0, separator)).trim().toLowerCase();
    const payload = separator < 0 ? '' : address.slice(separator + 1).trim();
    if (scheme === 'text') {
      this.error(
        'K4-CONVERT-LEGACY-TEXT',
        `Legacy Text Asset ${id} has no automatic DSL 4.0 conversion. Add an SVG Text actor and replace legacy text, textStyle, show, and setSkin usage with textStyles and Actor.setText.`,
        command,
      );
      return null;
    }
    if (scheme === 'backdrop') {
      if (payload.includes(':')) {
        this.error(
          'K4-CONVERT-ASSET-ADDRESS',
          `Backdrop address is ambiguous: ${address}`,
          command,
        );
        return null;
      }
      return {kind: 'backdrop', name: payload || id, command};
    }
    if (scheme === 'costume' || scheme === 'sound') {
      const parts = payload ? payload.split(':').map((part) => part.trim()) : [];
      if (parts.length > 2 || parts.some((part) => !part)) {
        this.error('K4-CONVERT-ASSET-ADDRESS', `Invalid ${scheme} address: ${address}`, command);
        return null;
      }
      const sourceTarget = parts[0] || (scheme === 'sound' ? 'Stage' : id);
      const name = parts[1] || id;
      return scheme === 'costume'
        ? {kind: 'costume', sourceTarget, name, command}
        : {kind: 'sound', sourceTarget, name, command};
    }
    this.error(
      'K4-CONVERT-ASSET-ADDRESS',
      `Unsupported DSL 3.1/3.2 asset address: ${address}`,
      command,
    );
    return null;
  }

  /** @param {Dsl32Command} command */
  parseActor(command) {
    const parts = splitList(command.value);
    if (parts.length !== 2 || parts.some((part) => !part)) {
      this.error('K4-CONVERT-ACTOR-001', 'actor requires ACTOR,INITIAL_COSTUME.', command);
      return;
    }
    const [actor, costume] = parts;
    if (!this.validateIdentifier(actor, 'Actor ID', command)) return;
    if (!this.validateLiteralId(costume, 'Costume asset ID', command)) return;
    if (this.rejectDuplicate(this.actors, actor, 'Actor', command)) return;
    this.actors.set(actor, costume);
    this.addReference('asset', costume, command, {expectedKind: 'costume', actor});
    this.addCostumeUse(costume, actor);
  }

  /** @param {Dsl32Command} command */
  parseCover(command) {
    const parts = splitList(command.value);
    if (parts.length !== 2 || !parts[0]) {
      this.error('K4-CONVERT-COVER-001', 'cover requires BACKDROP,BGM; BGM may be empty.', command);
      return;
    }
    if (this.cover) {
      this.error('K4-CONVERT-DUPLICATE', 'cover is declared more than once.', command);
      return;
    }
    this.cover = {backdrop: parts[0]};
    this.addReference('asset', parts[0], command, {expectedKind: 'backdrop'});
    if (parts[1]) {
      this.cover.bgm = parts[1];
      this.addReference('asset', parts[1], command, {expectedKind: 'sound'});
    }
  }

  /** @param {Dsl32Command} command */
  parseVariable(command) {
    if (this.currentScene) {
      this.error(
        'K4-CONVERT-SCENE-VARIABLE',
        `Scene-local setRuntimeVariable in ${this.currentScene} has no DSL 4.0 core action equivalent and cannot be hoisted safely.`,
        command,
      );
      return;
    }
    const separator = command.value.indexOf(':');
    if (separator < 1) {
      this.error('K4-CONVERT-VARIABLE-001', 'setRuntimeVariable requires NAME:VALUE.', command);
      return;
    }
    const id = command.value.slice(0, separator).trim();
    const raw = command.value.slice(separator + 1).trim();
    if (!this.validateIdentifier(id, 'Variable ID', command)) return;
    if (this.rejectDuplicate(this.variables, id, 'Variable', command)) return;
    /** @type {string | number | boolean} */
    let value = raw;
    if (raw === 'true' || raw === 'false') {
      value = raw === 'true';
      this.warning(
        'K4-CONVERT-VARIABLE-TYPE',
        `Variable ${id} was a DSL 3.1/3.2 string and is emitted as a DSL 4.0 boolean. Review expression semantics.`,
        command,
      );
    } else if (numberPattern.test(raw) && Number.isFinite(Number(raw))) {
      value = Number(raw);
      this.warning(
        'K4-CONVERT-VARIABLE-TYPE',
        `Variable ${id} was a DSL 3.1/3.2 string and is emitted as a DSL 4.0 number. Review expression semantics.`,
        command,
      );
    }
    this.variables.set(id, value);
    this.variableCommands.set(id, command);
  }

  validateRuntimeCompatibility() {
    if (this.variables.has('startSceneIndex') && this.variables.get('startSceneIndex') !== 1) {
      this.error(
        'K4-CONVERT-START-SCENE',
        'DSL 4.0 starts from the first declared scene. startSceneIndex can only be converted when its value is 1.',
        this.variableCommands.get('startSceneIndex') ?? null,
      );
    }
  }

  applyPoseRuntimeConfiguration() {
    if (this.scenesUsingPose.size === 0) return;
    const configuredNames = ['poseRecog', 'poseCharge', 'poseIdle'].filter((name) =>
      this.variables.has(name),
    );
    if (configuredNames.length === 0) return;

    /** @param {string} name @param {number} fallback */
    const valueFor = (name, fallback) =>
      this.variables.has(name) ? this.variables.get(name) : fallback;
    const confidenceThreshold = valueFor('poseRecog', 0.5);
    const poseCharge = valueFor('poseCharge', 10);
    const poseIdle = valueFor('poseIdle', 0);
    let valid = true;
    if (
      typeof confidenceThreshold !== 'number' ||
      confidenceThreshold < 0 ||
      confidenceThreshold > 1
    ) {
      this.error(
        'K4-CONVERT-POSE-CONFIG',
        'poseRecog must be a number from 0 through 1 for DSL 4.0 conversion.',
        this.variableCommands.get('poseRecog') ?? null,
      );
      valid = false;
    }
    if (typeof poseCharge !== 'number' || poseCharge <= 0 || !Number.isFinite(10 / poseCharge)) {
      this.error(
        'K4-CONVERT-POSE-CONFIG',
        'poseCharge must produce a finite elapsed-time hold duration greater than 0.',
        this.variableCommands.get('poseCharge') ?? null,
      );
      valid = false;
    }
    if (typeof poseIdle !== 'number' || poseIdle !== 0) {
      this.error(
        'K4-CONVERT-POSE-CONFIG',
        'A non-zero poseIdle multiplies confidence in DSL 3.1/3.2 and has no exact DSL 4.0 sequence equivalent. Migrate it manually.',
        this.variableCommands.get('poseIdle') ?? null,
      );
      valid = false;
    }
    if (!valid) return;

    const differsFromDefaults = confidenceThreshold !== 0.5 || poseCharge !== 10 || poseIdle !== 0;
    if (!this.poseRecognition) {
      if (differsFromDefaults) {
        this.error(
          'K4-CONVERT-POSE-CONFIG',
          'Custom pose recognition values require setPoseRecognitionSound with both sounds so DSL 4.0 can carry sequence configuration.',
          this.variableCommands.get(configuredNames[0]) ?? null,
        );
      }
      return;
    }

    /** @type {Record<string, number>} */
    const sequence = {};
    if (this.variables.has('poseRecog')) {
      sequence.confidenceThreshold = /** @type {number} */ (confidenceThreshold);
    }
    if (this.variables.has('poseCharge')) {
      sequence.fullConfidenceHoldSeconds = 10 / /** @type {number} */ (poseCharge);
    }
    if (this.variables.has('poseIdle')) sequence.idleChargePerSecond = 0;
    this.poseRecognition.sequence = sequence;
  }

  /** @param {Dsl32Command} command */
  parseLoadingBackdrop(command) {
    const id = command.value.trim();
    if (!id) {
      this.error('K4-CONVERT-LOADING-001', 'setLoadingBackdrop requires one asset ID.', command);
      return;
    }
    this.loading ??= {};
    if (this.loading.backdrop) {
      this.error('K4-CONVERT-DUPLICATE', 'setLoadingBackdrop is declared more than once.', command);
      return;
    }
    this.loading.backdrop = id;
    this.addReference('asset', id, command, {expectedKind: 'backdrop'});
  }

  /** @param {Dsl32Command} command */
  parseLoadingCostumes(command) {
    const ids = splitList(command.value);
    if (ids.length === 0 || ids.some((id) => !id)) {
      this.error(
        'K4-CONVERT-LOADING-001',
        'setLoadingCostume requires non-empty asset IDs.',
        command,
      );
      return;
    }
    this.loading ??= {};
    if (this.loading.costumes) {
      this.error('K4-CONVERT-DUPLICATE', 'setLoadingCostume is declared more than once.', command);
      return;
    }
    this.loading.costumes = ids;
    for (const id of ids) this.addReference('asset', id, command, {expectedKind: 'costume'});
  }

  /** @param {Dsl32Command} command */
  parsePoseRecognition(command) {
    const ids = splitList(command.value);
    if (ids.length !== 2 || ids.some((id) => !id)) {
      this.error(
        'K4-CONVERT-POSE-SOUND-001',
        'DSL 4.0 requires both idle and charge sounds; setPoseRecognitionSound must contain exactly two asset IDs.',
        command,
      );
      return;
    }
    if (this.poseRecognition) {
      this.error(
        'K4-CONVERT-DUPLICATE',
        'setPoseRecognitionSound is declared more than once.',
        command,
      );
      return;
    }
    this.poseRecognition = {idleSound: ids[0], chargeSound: ids[1]};
    for (const id of ids) this.addReference('asset', id, command, {expectedKind: 'sound'});
  }

  /** @param {Dsl32Command} command */
  parseSvgTextStyle(command) {
    const parts = command.value.split(':').map((part) => part.trim());
    if (parts.length !== 7) {
      this.error(
        'K4-CONVERT-STYLE-001',
        'svgTextStyle requires STYLE:BACKGROUND:COLOR:FONT:SIZE:ALIGN:DIRECTION.',
        command,
      );
      return;
    }
    const [id, background, color, font, rawSize, align, direction] = parts;
    if (!this.validateIdentifier(id, 'Text style ID', command)) return;
    if (this.rejectDuplicate(this.textStyles, id, 'Text style', command)) return;
    const size = this.parseNumber(rawSize, 'Text style size', command, {exclusiveMinimum: 0});
    if (!['left', 'center', 'right'].includes(align)) {
      this.error('K4-CONVERT-STYLE-ALIGN', `Unsupported DSL 4.0 text alignment: ${align}`, command);
    }
    if (!font) {
      this.error('K4-CONVERT-STYLE-FONT', 'SVG Text style font must not be empty.', command);
    }
    if (!textDirections.has(direction)) {
      this.error(
        'K4-CONVERT-STYLE-DIRECTION',
        `Unsupported DSL 4.0 text direction: ${direction}.`,
        command,
      );
    }
    if (size === null || !font) return;
    this.textStyles.set(id, {background, color, font, size, align, direction});
  }

  /** @param {Dsl32Command} command */
  parseLegacyText(command) {
    if (command.value.startsWith('ui.')) {
      this.warning(
        'K4-CONVERT-APP-SHELL-TEXT',
        `${command.key} is an app-shell setting and is omitted from the DSL 4.0 story source.`,
        command,
      );
      return;
    }
    this.error(
      'K4-CONVERT-LEGACY-TEXT',
      `${command.key} uses the legacy Text Asset API and requires manual migration to an SVG Text actor.`,
      command,
    );
  }

  /** @param {Dsl32Command} command */
  parseBranch(command) {
    const parts = command.value.split(':').map((part) => part.trim());
    if (parts.length !== 3) {
      this.error(
        'K4-CONVERT-BRANCH-001',
        'registerBranch requires NAME:CONDITION_LIST:SCENE_LIST without colon characters in values.',
        command,
      );
      return;
    }
    const [id, rawConditions, rawScenes] = parts;
    if (!this.validateIdentifier(id, 'Branch ID', command)) return;
    if (this.rejectDuplicate(this.branches, id, 'Branch', command)) return;
    const conditions = splitList(rawConditions);
    const destinations = splitList(rawScenes);
    if (
      conditions.length !== destinations.length ||
      conditions.length === 0 ||
      destinations.some((destination) => !destination)
    ) {
      this.error(
        'K4-CONVERT-BRANCH-LENGTH',
        'registerBranch condition and scene lists must have the same non-zero length.',
        command,
      );
      return;
    }
    const finalCondition = conditions.at(-1);
    if (finalCondition !== '' && finalCondition !== 'true') {
      this.error(
        'K4-CONVERT-BRANCH-ELSE',
        'DSL 4.0 branches require an unconditional final route. End the DSL 3.1/3.2 condition list with an empty item or true.',
        command,
      );
      return;
    }
    if (conditions.slice(0, -1).some((condition) => !condition)) {
      this.error(
        'K4-CONVERT-BRANCH-ELSE',
        'Only the final branch condition may be empty.',
        command,
      );
      return;
    }
    const rules = conditions.slice(0, -1).map((condition, index) => ({
      if: condition,
      goto: destinations[index],
    }));
    rules.push(/** @type {any} */ ({else: destinations.at(-1)}));
    this.branches.set(id, rules);
    for (const destination of destinations) this.addReference('scene', destination, command);
  }

  /** @param {Dsl32Command} command */
  parseScene(command) {
    const id = command.value.trim();
    if (!this.validateLiteralId(id, 'Scene ID', command)) {
      this.currentScene = null;
      return;
    }
    if (this.rejectDuplicate(this.scenes, id, 'Scene', command)) {
      this.currentScene = null;
      return;
    }
    this.scenes.set(id, []);
    this.currentScene = id;
  }

  /** @param {Dsl32Command} command */
  parsePoseModel(command) {
    if (!this.currentScene) {
      this.error(
        'K4-CONVERT-POSE-MODEL-SCENE',
        'TMPoseURL must follow a sceneLabel command.',
        command,
      );
      return;
    }
    if (this.scenePoseModels.has(this.currentScene)) {
      this.error(
        'K4-CONVERT-DUPLICATE',
        `TMPoseURL is declared more than once in scene ${this.currentScene}.`,
        command,
      );
      return;
    }
    const sourceUrl = command.value.trim();
    const replacement = Object.hasOwn(this.poseModels, sourceUrl)
      ? this.poseModels[sourceUrl]
      : undefined;
    if (!replacement) {
      let parsedUrl;
      try {
        parsedUrl = new URL(sourceUrl);
      } catch {
        this.error(
          'K4-CONVERT-POSE-MODEL',
          `TMPoseURL must be an absolute HTTPS URL or have an exact --pose-models replacement: ${sourceUrl || '(empty)'}`,
          command,
        );
        return;
      }
      if (
        parsedUrl.protocol !== 'https:' ||
        !parsedUrl.hostname ||
        parsedUrl.username ||
        parsedUrl.password ||
        parsedUrl.hash
      ) {
        this.error(
          'K4-CONVERT-POSE-MODEL',
          `TMPoseURL must be an absolute HTTPS URL without credentials or fragment, or have an exact --pose-models replacement: ${sourceUrl}`,
          command,
        );
        return;
      }
      const normalizedUrl = sourceUrl.endsWith('/') ? sourceUrl : `${sourceUrl}/`;
      let assetId = this.remotePoseModels.get(normalizedUrl);
      if (!assetId) {
        do {
          assetId = `PoseModel${this.nextRemotePoseModelId}`;
          this.nextRemotePoseModelId += 1;
        } while (this.assets.has(assetId));
        this.assets.set(assetId, {
          kind: 'poseModel',
          delivery: 'remote',
          source: {url: normalizedUrl},
          loading: 'lazy',
          command,
        });
        this.remotePoseModels.set(normalizedUrl, assetId);
      }
      this.scenePoseModels.set(this.currentScene, assetId);
      return;
    }
    if (!this.validateLiteralId(replacement.id, 'Pose model asset ID', command)) return;
    if (!this.validatePoseModelFile(replacement.file, command)) return;
    if (replacement.loading !== undefined && !['eager', 'lazy'].includes(replacement.loading)) {
      this.error(
        'K4-CONVERT-POSE-MODEL-MAP',
        `Pose model ${replacement.id} loading must be eager or lazy.`,
        command,
      );
      return;
    }
    const existing = this.assets.get(replacement.id);
    if (existing) {
      if (
        existing.kind !== 'poseModel' ||
        !('file' in existing) ||
        existing.file !== replacement.file ||
        (existing.loading ?? 'eager') !== (replacement.loading ?? 'eager')
      ) {
        this.error(
          'K4-CONVERT-DUPLICATE',
          `Pose model replacement conflicts with asset ${replacement.id}.`,
          command,
        );
        return;
      }
    } else {
      this.assets.set(replacement.id, {
        kind: 'poseModel',
        file: replacement.file,
        ...(replacement.loading ? {loading: replacement.loading} : {}),
        command,
      });
    }
    this.scenePoseModels.set(this.currentScene, replacement.id);
  }

  /** @param {string} file @param {Dsl32Command} command */
  validatePoseModelFile(file, command) {
    if (!isSafePoseModelFile(file)) {
      this.error(
        'K4-CONVERT-POSE-MODEL-MAP',
        `Pose model file must be a safe project-relative path: ${file || '(empty)'}`,
        command,
      );
      return false;
    }
    return true;
  }

  /** @param {Dsl32Command} command */
  parseAction(command) {
    if (!this.currentScene) {
      this.error('K4-CONVERT-ACTION-SCENE', 'action must follow a sceneLabel command.', command);
      return;
    }
    const parts = command.value.split(':').map((part) => part.trim());
    const targetOrCommand = parts[0] ?? '';
    if (
      [
        'stage',
        'bgm',
        'sound',
        'wait',
        'transition',
        'branch',
        'keyInputToChangeScene',
        'touchInputToChangeScene',
      ].includes(targetOrCommand)
    ) {
      const action = this.parseGlobalAction(targetOrCommand, parts, command);
      if (action) this.scenes.get(this.currentScene)?.push(action);
      return;
    }
    const action = this.parseActorAction(targetOrCommand, parts, command);
    if (action) this.scenes.get(this.currentScene)?.push(action);
  }

  /** @param {string} actionName @param {string[]} parts @param {Dsl32Command} command @returns {Record<string, any> | null} */
  parseGlobalAction(actionName, parts, command) {
    if (['stage', 'bgm', 'sound', 'branch'].includes(actionName)) {
      if (parts.length !== 2 || !parts[1]) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          `${actionName} requires exactly one argument.`,
          command,
        );
        return null;
      }
      if (actionName === 'stage') {
        this.addReference('asset', parts[1], command, {expectedKind: 'backdrop'});
      } else if (actionName === 'bgm' || actionName === 'sound') {
        this.addReference('asset', parts[1], command, {expectedKind: 'sound'});
      } else {
        this.addReference('branch', parts[1], command);
      }
      return {[actionName]: parts[1]};
    }
    if (actionName === 'wait') {
      if (parts.length !== 2) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          'wait requires exactly one seconds argument.',
          command,
        );
        return null;
      }
      const seconds = this.parseNumber(parts[1], 'wait seconds', command, {minimum: 0});
      return seconds === null ? null : {wait: seconds};
    }
    if (actionName === 'transition') {
      if (parts.length !== 2 || !parts[1]) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          'transition requires exactly one effect argument.',
          command,
        );
        return null;
      }
      this.warning(
        'K4-CONVERT-TRANSITION-DURATION',
        'DSL 3.1/3.2 transition has no duration argument; the DSL 4.0 transition duration is set to 0 seconds.',
        command,
      );
      this.validateIdentifier(parts[1], 'Transition effect', command);
      return {transition: {effect: parts[1], seconds: 0}};
    }
    if (actionName === 'keyInputToChangeScene' || actionName === 'touchInputToChangeScene') {
      if (parts.length !== 3) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          `${actionName} requires ROUTE_LIST:SCENE_LIST.`,
          command,
        );
        return null;
      }
      const routes = splitList(parts[1]);
      const destinations = splitList(parts[2]);
      if (
        routes.length !== destinations.length ||
        routes.length === 0 ||
        routes.some((route) => !route) ||
        destinations.some((destination) => !destination)
      ) {
        this.error(
          'K4-CONVERT-ROUTE-LENGTH',
          `${actionName} route and scene lists must have the same non-zero length.`,
          command,
        );
        return null;
      }
      /** @type {Map<string, string>} */
      const mappedRoutes = new Map();
      for (const [index, route] of routes.entries()) {
        if (mappedRoutes.has(route)) {
          this.error('K4-CONVERT-ROUTE-DUPLICATE', `Duplicate input route: ${route}`, command);
          continue;
        }
        if (actionName === 'keyInputToChangeScene' && !supportedKeyCodePattern.test(route)) {
          this.error(
            'K4-CONVERT-KEY-UNSUPPORTED',
            `Unsupported DSL 4.0 key code: ${route}`,
            command,
          );
        }
        if (actionName === 'touchInputToChangeScene') {
          this.validateIdentifier(route, 'Touch route actor ID', command);
          this.addReference('actor', route, command);
        }
        mappedRoutes.set(route, destinations[index]);
        this.addReference('scene', destinations[index], command);
      }
      return {[actionName]: ownObject(mappedRoutes)};
    }
    return null;
  }

  /** @param {string} target @param {string[]} parts @param {Dsl32Command} command @returns {Record<string, any> | null} */
  parseActorAction(target, parts, command) {
    if (!target || target === '*' || target.includes(',')) {
      this.error(
        'K4-CONVERT-ACTOR-TARGET',
        'DSL 4.0 actions require exactly one explicit actor target; wildcard and actor lists need manual migration.',
        command,
      );
      return null;
    }
    if (!this.validateIdentifier(target, 'Action actor ID', command)) return null;
    const actionName = parts[1] ?? '';
    this.addReference('actor', target, command);
    const key = `${target}.${actionName}`;
    if (actionName === 'show') {
      if (parts.length !== 4 || !parts[2]) {
        this.error('K4-CONVERT-ACTION-ARGS', 'show requires SKIN:X,Y,SCALE.', command);
        return null;
      }
      const coordinates = this.parseNumberList(parts[3], 3, 'show coordinates', command);
      if (!coordinates || coordinates[2] <= 0) {
        if (coordinates)
          this.error('K4-CONVERT-ACTION-ARGS', 'show scale must be greater than 0.', command);
        return null;
      }
      this.addReference('asset', parts[2], command, {expectedKind: 'costume', actor: target});
      this.addCostumeUse(parts[2], target);
      return {[key]: {skin: parts[2], x: coordinates[0], y: coordinates[1], scale: coordinates[2]}};
    }
    if (actionName === 'moveTo') {
      if (parts.length !== 3) {
        this.error('K4-CONVERT-ACTION-ARGS', 'moveTo requires X,Y,SECONDS.', command);
        return null;
      }
      const coordinates = this.parseNumberList(parts[2], 3, 'moveTo arguments', command);
      if (!coordinates || coordinates[2] < 0) {
        if (coordinates)
          this.error('K4-CONVERT-ACTION-ARGS', 'moveTo seconds must be at least 0.', command);
        return null;
      }
      return {[key]: {x: coordinates[0], y: coordinates[1], seconds: coordinates[2]}};
    }
    if (actionName === 'say' || actionName === 'think') {
      if (parts.length === 3) {
        if (parts[2] === '') {
          return {[key]: {text: '', seconds: 0}};
        }
        this.error(
          'K4-CONVERT-PERSISTENT-SPEECH',
          `A DSL 3.1/3.2 ${actionName} action without seconds is persistent and has no equivalent DSL 4.0 core action.`,
          command,
        );
        return null;
      }
      if (parts.length === 5) {
        this.error(
          'K4-CONVERT-SPEECH-STYLE',
          `Styled ${actionName} is not part of the DSL 4.0 core schema and requires manual migration.`,
          command,
        );
        return null;
      }
      if (parts.length !== 4) {
        this.error('K4-CONVERT-ACTION-ARGS', `${actionName} requires TEXT:SECONDS.`, command);
        return null;
      }
      const seconds = this.parseNumber(parts[3], `${actionName} seconds`, command, {minimum: 0});
      return seconds === null ? null : {[key]: {text: parts[2].replaceAll('\\n', '\n'), seconds}};
    }
    if (actionName === 'setSkin') {
      if ((parts.length !== 3 && parts.length !== 4) || !parts[2]) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          'setSkin requires SKIN with an optional positive SCALE.',
          command,
        );
        return null;
      }
      const scale =
        parts.length === 4
          ? this.parseNumber(parts[3], 'setSkin scale', command, {exclusiveMinimum: 0})
          : null;
      if (parts.length === 4 && scale === null) return null;
      this.addReference('asset', parts[2], command, {expectedKind: 'costume', actor: target});
      this.addCostumeUse(parts[2], target);
      return {[key]: scale === null ? parts[2] : {skin: parts[2], scale}};
    }
    if (actionName === 'hide') {
      if (parts.length !== 2) {
        this.error('K4-CONVERT-ACTION-ARGS', 'hide does not accept arguments.', command);
        return null;
      }
      return {[key]: {}};
    }
    if (actionName === 'setLayer') {
      if (parts.length !== 3 || !parts[2]) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          'setLayer requires front, back, or a finite relative layer count.',
          command,
        );
        return null;
      }
      if (parts[2] === 'front' || parts[2] === 'back') return {[key]: parts[2]};
      const layer = this.parseNumber(parts[2], 'setLayer count', command);
      return layer === null ? null : {[key]: layer};
    }
    if (actionName === 'loop') {
      if (parts.length !== 4) {
        this.error('K4-CONVERT-ACTION-ARGS', 'loop requires SKINS:DURATIONS.', command);
        return null;
      }
      const skins = splitList(parts[2]);
      const rawDurations = splitList(parts[3]);
      if (
        skins.length === 0 ||
        skins.length !== rawDurations.length ||
        skins.some((skin) => !skin)
      ) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          'loop skin and duration lists must have the same non-zero length.',
          command,
        );
        return null;
      }
      const durations = rawDurations.map((raw) =>
        this.parseNumber(raw, 'loop duration', command, {minimum: 0}),
      );
      if (durations.some((duration) => duration === null)) return null;
      if (!durations.some((duration) => /** @type {number} */ (duration) > 0)) {
        this.error(
          'K4-CONVERT-ACTION-ARGS',
          'loop requires at least one positive duration.',
          command,
        );
        return null;
      }
      for (const skin of skins) {
        this.addReference('asset', skin, command, {expectedKind: 'costume', actor: target});
        this.addCostumeUse(skin, target);
      }
      return {
        [key]: {
          steps: skins.map((skin, index) => ({
            skin,
            seconds: /** @type {number} */ (durations[index]),
          })),
        },
      };
    }
    if (actionName === 'setText') {
      if (parts.length !== 4 || !parts[3]) {
        this.error('K4-CONVERT-ACTION-ARGS', 'setText requires TEXT:STYLE.', command);
        return null;
      }
      this.styleReferences.set(parts[3], command);
      this.addReference('style', parts[3], command);
      return {[key]: {text: parts[2].replaceAll('\\n', '\n'), style: parts[3]}};
    }
    if (actionName === 'pose') {
      if (parts.length !== 5) {
        this.error('K4-CONVERT-ACTION-ARGS', 'pose requires SKINS:POSES:SOUNDS.', command);
        return null;
      }
      const skins = splitList(parts[2]);
      const poses = splitList(parts[3]);
      const sounds = splitList(parts[4]);
      if (poses.length === 0 || poses.some((id) => !id)) {
        this.error(
          'K4-CONVERT-POSE-STEPS',
          'pose requires one or more non-empty pose names.',
          command,
        );
        return null;
      }
      const steps = poses.map((pose, index) => ({
        pose,
        ...(skins[index] ? {skin: skins[index]} : {}),
        ...(sounds[index] ? {sound: sounds[index]} : {}),
      }));
      if (skins.length > poses.length || sounds.length > poses.length) {
        this.warning(
          'K4-CONVERT-POSE-EXTRA',
          'DSL 3.1/3.2 ignores skin or sound entries after the final pose; the converter omitted those extra entries.',
          command,
        );
      }
      for (const step of steps) {
        this.validateIdentifier(step.pose, 'Pose ID', command);
        if (step.skin) {
          this.addReference('asset', step.skin, command, {
            expectedKind: 'costume',
            actor: target,
          });
          this.addCostumeUse(step.skin, target);
        }
        if (step.sound) this.addReference('asset', step.sound, command, {expectedKind: 'sound'});
      }
      this.scenesUsingPose.set(/** @type {string} */ (this.currentScene), command);
      return {[key]: {steps}};
    }
    this.error(
      'K4-CONVERT-ACTION-UNSUPPORTED',
      `DSL 3.1/3.2 actor action ${actionName || '(empty)'} has no DSL 4.0 core equivalent.`,
      command,
    );
    return null;
  }

  /** @param {string} value @param {string} label @param {Dsl32Command} command @param {{minimum?: number, exclusiveMinimum?: number}} [limits] */
  parseNumber(value, label, command, limits = {}) {
    if (!numberPattern.test(value) || !Number.isFinite(Number(value))) {
      this.error(
        'K4-CONVERT-NUMBER',
        `${label} must be a finite number: ${value || '(empty)'}`,
        command,
      );
      return null;
    }
    const number = Number(value);
    if (limits.minimum !== undefined && number < limits.minimum) {
      this.error('K4-CONVERT-NUMBER', `${label} must be at least ${limits.minimum}.`, command);
      return null;
    }
    if (limits.exclusiveMinimum !== undefined && number <= limits.exclusiveMinimum) {
      this.error(
        'K4-CONVERT-NUMBER',
        `${label} must be greater than ${limits.exclusiveMinimum}.`,
        command,
      );
      return null;
    }
    return number;
  }

  /** @param {string} value @param {number} length @param {string} label @param {Dsl32Command} command */
  parseNumberList(value, length, label, command) {
    const parts = splitList(value);
    if (parts.length !== length) {
      this.error(
        'K4-CONVERT-ACTION-ARGS',
        `${label} must contain exactly ${length} numbers.`,
        command,
      );
      return null;
    }
    const numbers = parts.map((part) => this.parseNumber(part, label, command));
    return numbers.some((number) => number === null) ? null : /** @type {number[]} */ (numbers);
  }

  /** @param {ConversionReference['kind']} kind @param {string} id @param {Dsl32Command} command @param {Partial<ConversionReference>} [details] */
  addReference(kind, id, command, details = {}) {
    this.references.push({kind, id, command, ...details});
  }

  /** @param {string} asset @param {string} actor */
  addCostumeUse(asset, actor) {
    const actors = this.costumeUses.get(asset) ?? new Set();
    actors.add(actor);
    this.costumeUses.set(asset, actors);
  }

  validateReferences() {
    for (const reference of this.references) {
      if (reference.kind === 'asset') {
        const asset = this.assets.get(reference.id);
        if (!asset) {
          this.error(
            'K4-CONVERT-REF-001',
            `Unknown asset reference: ${reference.id}`,
            reference.command,
          );
        } else if (reference.expectedKind && asset.kind !== reference.expectedKind) {
          this.error(
            'K4-CONVERT-REF-002',
            `Asset ${reference.id} must have kind ${reference.expectedKind}, received ${asset.kind}.`,
            reference.command,
          );
        }
      } else if (reference.kind === 'actor' && !this.actors.has(reference.id)) {
        this.error(
          'K4-CONVERT-REF-001',
          `Unknown actor reference: ${reference.id}`,
          reference.command,
        );
      } else if (reference.kind === 'branch' && !this.branches.has(reference.id)) {
        this.error(
          'K4-CONVERT-REF-001',
          `Unknown branch reference: ${reference.id}`,
          reference.command,
        );
      } else if (reference.kind === 'scene' && !this.scenes.has(reference.id)) {
        this.error(
          'K4-CONVERT-REF-001',
          `Unknown scene reference: ${reference.id}`,
          reference.command,
        );
      } else if (reference.kind === 'style' && !this.textStyles.has(reference.id)) {
        if (reference.id === 'default') {
          this.textStyles.set('default', {});
          this.warning(
            'K4-CONVERT-DEFAULT-STYLE',
            'The built-in DSL 3.2 default SVG Text style is emitted as an empty DSL 4.0 style for review.',
            reference.command,
          );
        } else {
          this.error(
            'K4-CONVERT-REF-001',
            `Unknown text style reference: ${reference.id}`,
            reference.command,
          );
        }
      }
    }
    for (const [assetId, actors] of this.costumeUses) {
      if (actors.size > 1) {
        const command = this.assets.get(assetId)?.command ?? null;
        this.error(
          'K4-CONVERT-COSTUME-TARGET',
          `Costume ${assetId} is used by multiple actors (${[...actors].join(', ')}); DSL 4.0 requires a separate targeted asset for each actor.`,
          command,
        );
      }
    }
  }

  renderAssets() {
    /** @type {Map<string, any>} */
    const rendered = new Map();
    for (const [id, asset] of this.assets) {
      if (asset.kind === 'poseModel') {
        if ('delivery' in asset && asset.delivery === 'remote') {
          rendered.set(id, {
            kind: 'poseModel',
            delivery: 'remote',
            source: asset.source,
            loading: asset.loading,
          });
        } else if ('file' in asset) {
          rendered.set(id, {
            kind: 'poseModel',
            file: asset.file,
            ...(asset.loading ? {loading: asset.loading} : {}),
          });
        }
      } else if (asset.kind === 'backdrop') {
        rendered.set(id, asset.name === id ? 'backdrop' : {kind: 'backdrop', name: asset.name});
      } else if (asset.kind === 'sound') {
        if (asset.sourceTarget !== 'Stage') {
          this.warning(
            'K4-CONVERT-SOUND-TARGET',
            `DSL 4.0 sound assets do not retain the DSL 3.1/3.2 source sprite ${asset.sourceTarget}; verify that sound name ${asset.name} is unique.`,
            asset.command,
          );
        }
        rendered.set(id, asset.name === id ? 'sound' : {kind: 'sound', name: asset.name});
      } else {
        const actors = this.costumeUses.get(id) ?? new Set();
        const target = actors.size === 1 ? [...actors][0] : asset.sourceTarget;
        this.validateIdentifier(target, `Costume ${id} target`, asset.command);
        if (target !== asset.sourceTarget) {
          this.warning(
            'K4-CONVERT-COSTUME-RETARGETED',
            `Costume ${id} is retargeted from its DSL 3.1/3.2 source sprite ${asset.sourceTarget} to logical actor ${target}.`,
            asset.command,
          );
        }
        rendered.set(
          id,
          asset.name === id ? `costume:${target}` : {kind: 'costume', target, name: asset.name},
        );
      }
    }
    return ownObject(rendered);
  }

  renderScenes() {
    return ownObject(
      [...this.scenes].map(([sceneId, actions]) => {
        const poseModel = this.scenePoseModels.get(sceneId);
        return [sceneId, poseModel ? {poseModel, actions} : actions];
      }),
    );
  }

  buildDocument() {
    /** @type {Record<string, any>} */
    const document = {
      kamishibai: '4.0',
      controls: {keymaps: {production: {Space: 'navigation.nextAction'}}},
    };
    if (this.assets.size > 0) document.assets = this.renderAssets();
    if (this.actors.size > 0) document.actors = ownObject(this.actors);
    if (this.cover) document.cover = this.cover;
    if (this.textStyles.size > 0) document.textStyles = ownObject(this.textStyles);
    if (this.variables.size > 0) document.variables = ownObject(this.variables);
    if (this.loading?.backdrop && this.loading.costumes) {
      document.loading = {backdrop: this.loading.backdrop, costumes: this.loading.costumes};
    }
    if (this.poseRecognition) document.poseRecognition = this.poseRecognition;
    if (this.branches.size > 0) document.branches = ownObject(this.branches);
    document.scenes = this.renderScenes();
    return document;
  }

  run() {
    const commands = this.parseCommands();
    for (const command of commands) {
      switch (command.key) {
        case '---':
          this.currentScene = null;
          break;
        case 'kamishibai':
          this.parseVersion(command);
          break;
        case 'asset':
          this.parseAsset(command);
          break;
        case 'actor':
          this.parseActor(command);
          break;
        case 'cover':
          this.parseCover(command);
          break;
        case 'setRuntimeVariable':
          this.parseVariable(command);
          break;
        case 'setLoadingBackdrop':
          this.parseLoadingBackdrop(command);
          break;
        case 'setLoadingCostume':
          this.parseLoadingCostumes(command);
          break;
        case 'setPoseRecognitionSound':
          this.parsePoseRecognition(command);
          break;
        case 'svgTextStyle':
          this.parseSvgTextStyle(command);
          break;
        case 'text':
        case 'textStyle':
          this.parseLegacyText(command);
          break;
        case 'registerBranch':
          this.parseBranch(command);
          break;
        case 'sceneLabel':
          this.parseScene(command);
          break;
        case 'action':
          this.parseAction(command);
          break;
        case 'TMPoseURL':
          this.parsePoseModel(command);
          break;
        default:
          this.error(
            'K4-CONVERT-COMMAND-UNSUPPORTED',
            `Unsupported DSL 3.1/3.2 command: ${command.key}`,
            command,
          );
      }
    }
    if (this.versionCommands === 0) {
      this.error(
        'K4-CONVERT-VERSION-001',
        'The source must declare kamishibai=3.1 or kamishibai=3.2.',
      );
    }
    if (this.scenes.size === 0) {
      this.error('K4-CONVERT-SCENE-001', 'The source must declare at least one sceneLabel.');
    }
    if (this.loading && (!this.loading.backdrop || !this.loading.costumes)) {
      this.error(
        'K4-CONVERT-LOADING-001',
        'DSL 4.0 loading configuration requires both setLoadingBackdrop and setLoadingCostume.',
      );
    }
    this.validateRuntimeCompatibility();
    this.applyPoseRuntimeConfiguration();
    for (const [sceneId, command] of this.scenesUsingPose) {
      if (!this.scenePoseModels.has(sceneId)) {
        this.error(
          'K4-CONVERT-POSE-MODEL',
          `Scene ${sceneId} uses Actor.pose but has no convertible TMPoseURL. Add a TMPoseURL or an exact --pose-models replacement.`,
          command,
        );
      }
    }
    this.validateReferences();
    this.diagnostics.sort(compareDiagnostics);
    if (this.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return /** @type {ConversionResult} */ ({
        ok: false,
        source: this.source,
        document: null,
        yaml: null,
        diagnostics: this.diagnostics,
      });
    }
    const document = this.buildDocument();
    this.diagnostics.sort(compareDiagnostics);
    if (this.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
      return /** @type {ConversionResult} */ ({
        ok: false,
        source: this.source,
        document: null,
        yaml: null,
        diagnostics: this.diagnostics,
      });
    }
    const yaml = stringify(document, {lineWidth: 0});
    return /** @type {ConversionResult} */ ({
      ok: true,
      source: this.source,
      document,
      yaml,
      diagnostics: this.diagnostics,
    });
  }
}

/**
 * Convert one DSL 3.1 or DSL 3.2 source string into deterministic DSL 4.0 YAML without I/O.
 *
 * @param {string | Uint8Array} input
 * @param {{sourceId?: string, poseModels?: Readonly<Record<string, PoseModelReplacement>>}} [options]
 * @returns {ConversionResult}
 */
export function convertDsl32ToDsl4(input, options = {}) {
  const sourceId = options.sourceId ?? 'main';
  if (!(typeof input === 'string' || input instanceof Uint8Array)) {
    return {
      ok: false,
      source: '',
      document: null,
      yaml: null,
      diagnostics: [
        createDiagnostic(
          sourceId,
          'K4-CONVERT-INPUT-001',
          'error',
          'DSL 3.1/3.2 source must be a string or Uint8Array.',
        ),
      ],
    };
  }
  let source;
  try {
    source = canonicalizeSource(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source: '',
      document: null,
      yaml: null,
      diagnostics: [createDiagnostic(sourceId, 'K4-CONVERT-UTF8-001', 'error', message)],
    };
  }
  let poseModels;
  try {
    poseModels = normalizePoseModels(options.poseModels);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source,
      document: null,
      yaml: null,
      diagnostics: [createDiagnostic(sourceId, 'K4-CONVERT-POSE-MODEL-MAP', 'error', message)],
    };
  }
  try {
    return new Converter(source, sourceId, poseModels).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      source,
      document: null,
      yaml: null,
      diagnostics: [createDiagnostic(sourceId, 'K4-CONVERT-INTERNAL-001', 'error', message)],
    };
  }
}

export class Dsl32ConversionError extends Error {
  /** @param {string} message @param {ConversionDiagnostic[]} diagnostics @param {{reported?: boolean}} [options] */
  constructor(message, diagnostics, options = {}) {
    super(message);
    this.name = 'Dsl32ConversionError';
    this.code = 'ERR_DSL32_CONVERSION';
    this.diagnostics = diagnostics;
    this.reported = options.reported ?? false;
  }
}

/** @param {ConversionDiagnostic} diagnostic @param {string} [displaySource] */
export function formatConversionDiagnostic(diagnostic, displaySource) {
  const source = displaySource ?? diagnostic.sourceId;
  const {line, column} = diagnostic.range.start;
  return `${source}:${line}:${column}: ${diagnostic.severity} [${diagnostic.code}] ${diagnostic.message}`;
}

/**
 * Convert a file and install the output as a one-file transaction.
 *
 * @param {{inputPath: string, outputPath: string, poseModelMapPath?: string}} options
 */
export async function convertDsl32File(options) {
  const inputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath);
  if (inputPath === outputPath) {
    const diagnostic = createDiagnostic(
      inputPath,
      'K4-CONVERT-OUTPUT-SOURCE',
      'error',
      'Input and output paths must be different; the DSL 3.1/3.2 source is never modified.',
    );
    return {ok: false, outputPath: null, diagnostics: [diagnostic], yaml: null, document: null};
  }
  let poseModels;
  if (options.poseModelMapPath) {
    const poseModelMapPath = path.resolve(options.poseModelMapPath);
    try {
      poseModels = normalizePoseModels(JSON.parse(await readFile(poseModelMapPath, 'utf8')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = createDiagnostic(
        poseModelMapPath,
        'K4-CONVERT-POSE-MODEL-MAP',
        'error',
        `Cannot read or validate the pose model replacement manifest: ${message}`,
      );
      return {ok: false, outputPath: null, diagnostics: [diagnostic], yaml: null, document: null};
    }
  }
  const source = await readFile(inputPath);
  const result = convertDsl32ToDsl4(source, {sourceId: inputPath, poseModels});
  if (!result.ok || !result.yaml) {
    return {...result, outputPath: null};
  }
  const outputDirectory = path.dirname(outputPath);
  const outputName = path.basename(outputPath);
  const outputBytes = Buffer.from(result.yaml, 'utf8');
  await installBundleTransactionally({
    outputDirectory,
    outputName,
    files: new Map([[outputName, outputBytes]]),
    validateCandidate: async (candidateDirectory) => {
      const candidate = await readFile(path.join(candidateDirectory, outputName));
      if (!candidate.equals(outputBytes)) {
        throw new Dsl32ConversionError('Generated DSL 4.0 candidate changed before commit.', []);
      }
    },
  });
  return {...result, outputPath};
}
