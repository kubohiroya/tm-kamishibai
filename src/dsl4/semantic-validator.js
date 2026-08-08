import {
  dsl4ActorCoreActionNames,
  dsl4EmptyActionRegistrySnapshot,
  validateDsl4ActionRegistrySnapshot,
} from './action-registry.js';

const identifierSections = ['actors', 'textStyles', 'speechStyles', 'variables', 'branches'];
const actorCoreActionNames = new Set(dsl4ActorCoreActionNames);

/** @param {string} value */
function escapedJsonString(value) {
  return JSON.stringify(value).replace(
    /[\u0000-\u001f\u007f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** @param {string} base @param {string} property */
function propertyPath(base, property) {
  return `${base}[${escapedJsonString(property)}]`;
}

/** @param {unknown} value */
function diagnosticValue(value) {
  return escapedJsonString(String(value));
}

/**
 * @typedef {object} SemanticIssue
 * @property {string} code
 * @property {string} path
 * @property {string} message
 */

/**
 * @param {unknown} asset
 * @returns {{kind: string | undefined, target: string | undefined}}
 */
function assetKind(asset) {
  if (typeof asset === 'string') {
    const [kind, target] = asset.split(':');
    return {kind, target};
  }
  if (typeof asset !== 'object' || asset === null) return {kind: undefined, target: undefined};
  const record = /** @type {Record<string, unknown>} */ (asset);
  return {
    kind: typeof record.kind === 'string' ? record.kind : undefined,
    target: typeof record.target === 'string' ? record.target : undefined,
  };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCanonicalRemoteHttpsUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false;
  const authority = value.slice('https://'.length).split(/[/?#]/u, 1)[0];
  if (!authority) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

/**
 * @param {Record<string, unknown>} action
 * @param {string} key
 * @returns {unknown}
 */
function actionArgument(action, key) {
  const value = action[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const namedKey = {
    bgm: 'sound',
    branch: 'branch',
    goto: 'scene',
    sound: 'sound',
    stage: 'backdrop',
  }[key];
  return namedKey ? /** @type {Record<string, unknown>} */ (value)[namedKey] : value;
}

/**
 * @param {unknown} scene
 * @returns {Record<string, unknown>[]}
 */
function sceneActions(scene) {
  if (Array.isArray(scene)) return /** @type {Record<string, unknown>[]} */ (scene);
  return /** @type {Record<string, unknown>[]} */ (
    /** @type {Record<string, unknown>} */ (scene).actions
  );
}

/**
 * @param {SemanticIssue[]} issues
 * @param {Record<string, unknown>} collection
 * @param {unknown} id
 * @param {string | undefined} expectedKind
 * @param {string} path
 */
function addReferenceIssue(issues, collection, id, expectedKind, path) {
  if (typeof id !== 'string') return;
  if (!Object.hasOwn(collection, id)) {
    issues.push({
      code: 'K4-REF-001',
      path,
      message: `Unknown reference: ${diagnosticValue(id)}`,
    });
    return;
  }
  if (expectedKind && assetKind(collection[id]).kind !== expectedKind) {
    issues.push({
      code: 'K4-REF-002',
      path,
      message: `Reference ${diagnosticValue(id)} must have asset kind ${expectedKind}`,
    });
  }
}

/**
 * Validate relationships that JSON Schema cannot express.
 *
 * @param {Record<string, unknown>} story
 * @param {{actionRegistry?: unknown}} [options]
 * @returns {SemanticIssue[]}
 */
export function validateDsl4Semantics(
  story,
  {actionRegistry = dsl4EmptyActionRegistrySnapshot} = {},
) {
  const registry = validateDsl4ActionRegistrySnapshot(actionRegistry);
  const customActions = new Map(registry.actions.map((action) => [action.name, action]));
  /** @type {SemanticIssue[]} */
  const issues = [];
  const assets = /** @type {Record<string, unknown>} */ (story.assets ?? {});
  const actors = /** @type {Record<string, string>} */ (story.actors ?? {});
  const scenes = /** @type {Record<string, unknown>} */ (story.scenes ?? {});
  const branches = /** @type {Record<string, Record<string, string>[]>} */ (story.branches ?? {});
  const textStyles = /** @type {Record<string, unknown>} */ (story.textStyles ?? {});
  const speechStyles = /** @type {Record<string, Record<string, unknown>>} */ (
    story.speechStyles ?? {}
  );
  const stableIds = new Map();
  const storyInputCodes = new Map();

  for (const section of identifierSections) {
    const values = /** @type {Record<string, unknown>} */ (story[section] ?? {});
    for (const id of Object.keys(values)) {
      if (id !== id.normalize('NFC')) {
        issues.push({
          code: 'K4-ID-001',
          path: `$.${section}.${id}`,
          message: 'Identifiers must use Unicode NFC',
        });
      }
    }
  }

  for (const [id, asset] of Object.entries(assets)) {
    if (typeof asset !== 'object' || asset === null) continue;
    const assetRecord = /** @type {Record<string, unknown>} */ (asset);
    const file = assetRecord.file;
    if (assetRecord.delivery === 'remote') {
      const source = /** @type {Record<string, unknown>} */ (assetRecord.source);
      if (!isCanonicalRemoteHttpsUrl(source.url)) {
        issues.push({
          code: 'K4-ASSET-REMOTE-URL-001',
          path: `${propertyPath('$.assets', id)}.source.url`,
          message: 'Remote asset URL must be an absolute HTTPS URL without credentials or fragment',
        });
      }
      if (
        assetRecord.kind === 'image' &&
        (typeof source.contentType !== 'string' || !source.contentType.startsWith('image/'))
      ) {
        issues.push({
          code: 'K4-ASSET-IMAGE-MIME-001',
          path: `${propertyPath('$.assets', id)}.source.contentType`,
          message: 'Target-independent image assets require an image Content-Type',
        });
      }
    }
    if (typeof file !== 'string') continue;
    const components = file.split('/');
    if (
      components.some((component) => component === '.' || component === '..') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)
    ) {
      issues.push({
        code: 'K4-ASSET-001',
        path: `${propertyPath('$.assets', id)}.file`,
        message: 'Asset file must be a local relative path without dot segments',
      });
    }
  }

  for (const [actor, initialCostume] of Object.entries(actors)) {
    addReferenceIssue(issues, assets, initialCostume, 'costume', `$.actors.${actor}`);
    if (
      Object.hasOwn(assets, initialCostume) &&
      assetKind(assets[initialCostume]).target !== actor
    ) {
      issues.push({
        code: 'K4-REF-003',
        path: `$.actors.${actor}`,
        message: `Initial costume ${diagnosticValue(initialCostume)} must target actor ${diagnosticValue(actor)}`,
      });
    }
  }

  for (const [styleId, style] of Object.entries(speechStyles)) {
    addReferenceIssue(
      issues,
      assets,
      style.characterSound,
      'sound',
      `$.speechStyles.${styleId}.characterSound`,
    );
  }

  const cover = /** @type {Record<string, unknown> | undefined} */ (story.cover);
  if (cover) {
    addReferenceIssue(issues, assets, cover.backdrop, 'backdrop', '$.cover.backdrop');
    if (cover.bgm) addReferenceIssue(issues, assets, cover.bgm, 'sound', '$.cover.bgm');
  }

  const loading = /** @type {Record<string, unknown> | undefined} */ (story.loading);
  if (loading) {
    addReferenceIssue(issues, assets, loading.backdrop, 'backdrop', '$.loading.backdrop');
    /** @type {string[]} */ (loading.costumes).forEach((id, index) =>
      addReferenceIssue(issues, assets, id, 'costume', `$.loading.costumes[${index}]`),
    );
  }

  const poseRecognition = /** @type {Record<string, unknown> | undefined} */ (
    story.poseRecognition
  );
  if (poseRecognition) {
    for (const key of ['idleSound', 'chargeSound']) {
      addReferenceIssue(issues, assets, poseRecognition[key], 'sound', `$.poseRecognition.${key}`);
    }
    const preview = /** @type {Record<string, unknown>} */ (poseRecognition.preview ?? {});
    const previewControls = /** @type {Record<string, unknown>} */ (preview.controls ?? {});
    const mirroringControl = /** @type {Record<string, unknown>} */ (
      previewControls.mirroring ?? {}
    );
    const mirroringAssets = /** @type {Record<string, unknown>} */ (mirroringControl.assets ?? {});
    const cameraMenuControl = /** @type {Record<string, unknown>} */ (
      previewControls.cameraMenu ?? {}
    );
    /** @type {Array<[string, unknown]>} */
    const controlAssetReferences = [
      [
        '$.poseRecognition.preview.controls.mirroring.assets.showMirrored',
        mirroringAssets.showMirrored,
      ],
      [
        '$.poseRecognition.preview.controls.mirroring.assets.showUnmirrored',
        mirroringAssets.showUnmirrored,
      ],
      ['$.poseRecognition.preview.controls.cameraMenu.buttonAsset', cameraMenuControl.buttonAsset],
    ];
    for (const [path, id] of controlAssetReferences) {
      if (typeof id !== 'string') continue;
      addReferenceIssue(issues, assets, id, 'image', path);
      const asset = /** @type {Record<string, unknown>} */ (assets[String(id)] ?? {});
      if (asset.loading === 'lazy') {
        issues.push({
          code: 'K4-PREVIEW-CONTROL-ASSET-001',
          path,
          message: `Camera preview control asset ${diagnosticValue(id)} must use eager loading`,
        });
      }
    }
  }

  for (const [branchId, rules] of Object.entries(branches)) {
    if (!Object.hasOwn(rules.at(-1) ?? {}, 'else')) {
      issues.push({
        code: 'K4-BRANCH-001',
        path: `$.branches.${branchId}`,
        message: 'The final branch rule must be else',
      });
    }
    rules.forEach((rule, index) => {
      addReferenceIssue(
        issues,
        scenes,
        rule.goto ?? rule.else,
        undefined,
        `$.branches.${branchId}[${index}]`,
      );
    });
  }

  for (const [sceneId, scene] of Object.entries(scenes)) {
    const sceneRecord = Array.isArray(scene)
      ? null
      : /** @type {Record<string, unknown>} */ (scene);
    const scenePoseModel = sceneRecord?.poseModel;
    if (!Array.isArray(scene)) {
      if (scenePoseModel) {
        addReferenceIssue(
          issues,
          assets,
          scenePoseModel,
          'poseModel',
          `${propertyPath('$.scenes', sceneId)}.poseModel`,
        );
      }
    }

    let usesPoseRecognition = false;
    const scenePath = propertyPath('$.scenes', sceneId);
    const actionBasePath = Array.isArray(scene) ? scenePath : `${scenePath}.actions`;
    sceneActions(scene).forEach((action, actionIndex) => {
      const [key] = Object.keys(action);
      const value = action[key];
      const actionPath = `${actionBasePath}[${actionIndex}][${JSON.stringify(key)}]`;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const stableId = /** @type {Record<string, unknown>} */ (value).stableId;
        if (typeof stableId === 'string') {
          const previousPath = stableIds.get(stableId);
          if (previousPath) {
            issues.push({
              code: 'K4-STABLE-ID-001',
              path: `${actionPath}.stableId`,
              message: `stableId ${stableId} is already used at ${previousPath}`,
            });
          } else {
            stableIds.set(stableId, `${actionPath}.stableId`);
          }
        }
      }

      if (key === 'stage') {
        addReferenceIssue(issues, assets, actionArgument(action, key), 'backdrop', actionPath);
      } else if (key === 'bgm' || key === 'sound') {
        addReferenceIssue(issues, assets, actionArgument(action, key), 'sound', actionPath);
      } else if (key === 'goto') {
        addReferenceIssue(issues, scenes, actionArgument(action, key), undefined, actionPath);
      } else if (key === 'branch') {
        addReferenceIssue(issues, branches, actionArgument(action, key), undefined, actionPath);
      } else if (
        key === 'keyInputToChangeScene' ||
        key === 'touchInputToChangeScene' ||
        key === 'poseInputToChangeScene'
      ) {
        const argumentRecord = /** @type {Record<string, unknown>} */ (value);
        const routes = /** @type {Record<string, string>} */ (
          argumentRecord.routes ?? argumentRecord
        );
        for (const [route, destination] of Object.entries(routes)) {
          if (key === 'keyInputToChangeScene') storyInputCodes.set(route, `${actionPath}.${route}`);
          addReferenceIssue(issues, scenes, destination, undefined, `${actionPath}.${route}`);
        }
        if (key === 'poseInputToChangeScene') usesPoseRecognition = true;
      } else if (key.includes('.')) {
        const separator = key.lastIndexOf('.');
        const actor = key.slice(0, separator);
        const opcode = key.slice(separator + 1);
        if (!Object.hasOwn(actors, actor)) {
          issues.push({code: 'K4-REF-001', path: actionPath, message: `Unknown actor: ${actor}`});
        }
        if (opcode === 'show' || opcode === 'setSkin') {
          const valueRecord = /** @type {Record<string, unknown>} */ (value);
          const skin = opcode === 'show' ? valueRecord.skin : (valueRecord.skin ?? value);
          addReferenceIssue(issues, assets, skin, 'costume', `${actionPath}.skin`);
          if (
            typeof skin === 'string' &&
            Object.hasOwn(assets, skin) &&
            assetKind(assets[skin]).target !== actor
          ) {
            issues.push({
              code: 'K4-REF-003',
              path: `${actionPath}.skin`,
              message: `Costume ${diagnosticValue(skin)} must target actor ${diagnosticValue(actor)}`,
            });
          }
        } else if (opcode === 'loop') {
          const steps = /** @type {{skin: string, seconds: number}[]} */ (
            /** @type {Record<string, unknown>} */ (value).steps
          );
          steps.forEach((step, stepIndex) => {
            addReferenceIssue(
              issues,
              assets,
              step.skin,
              'costume',
              `${actionPath}.steps[${stepIndex}].skin`,
            );
            if (
              typeof step.skin === 'string' &&
              Object.hasOwn(assets, step.skin) &&
              assetKind(assets[step.skin]).target !== actor
            ) {
              issues.push({
                code: 'K4-REF-003',
                path: `${actionPath}.steps[${stepIndex}].skin`,
                message: `Costume ${diagnosticValue(step.skin)} must target actor ${diagnosticValue(actor)}`,
              });
            }
          });
        } else if (opcode === 'setText') {
          const style = /** @type {Record<string, unknown>} */ (value).style;
          addReferenceIssue(issues, textStyles, style, undefined, `${actionPath}.style`);
        } else if (opcode === 'say' || opcode === 'think') {
          const speech = /** @type {Record<string, unknown>} */ (value);
          addReferenceIssue(issues, speechStyles, speech.style, undefined, `${actionPath}.style`);
          for (const field of ['startSound', 'characterSound']) {
            addReferenceIssue(issues, assets, speech[field], 'sound', `${actionPath}.${field}`);
          }
        } else if (opcode === 'pose') {
          usesPoseRecognition = true;
          const steps = /** @type {{pose: string, skin?: string, sound?: string}[]} */ (
            /** @type {Record<string, unknown>} */ (value).steps
          );
          steps.forEach((step, stepIndex) => {
            addReferenceIssue(
              issues,
              assets,
              step.skin,
              'costume',
              `${actionPath}.steps[${stepIndex}].skin`,
            );
            if (
              typeof step.skin === 'string' &&
              Object.hasOwn(assets, step.skin) &&
              assetKind(assets[step.skin]).target !== actor
            ) {
              issues.push({
                code: 'K4-REF-003',
                path: `${actionPath}.steps[${stepIndex}].skin`,
                message: `Costume ${diagnosticValue(step.skin)} must target actor ${diagnosticValue(actor)}`,
              });
            }
            addReferenceIssue(
              issues,
              assets,
              step.sound,
              'sound',
              `${actionPath}.steps[${stepIndex}].sound`,
            );
          });
        } else if (!actorCoreActionNames.has(opcode)) {
          const registration = customActions.get(opcode);
          if (!registration) {
            issues.push({
              code: 'K4-COMMAND-UNSUPPORTED',
              path: actionPath,
              message: `Custom action ${opcode} is not registered`,
            });
            return;
          }
          const customAction = /** @type {Record<string, unknown>} */ (value);
          const customArguments = /** @type {Record<string, unknown>} */ (
            customAction.arguments ?? {}
          );
          const parameters = new Map(
            registration.parameters.map((parameter) => [parameter.name, parameter]),
          );
          for (const [name, argument] of Object.entries(customArguments)) {
            const parameter = parameters.get(name);
            if (!parameter) {
              issues.push({
                code: 'K4-SCHEMA-UNKNOWN-KEY',
                path: `${actionPath}.arguments.${name}`,
                message: `Custom action ${opcode} has no parameter named ${name}`,
              });
            } else if (typeof argument !== parameter.type) {
              issues.push({
                code: 'K4-SCHEMA-001',
                path: `${actionPath}.arguments.${name}`,
                message: `Custom action ${opcode} parameter ${name} must be ${parameter.type}`,
              });
            }
          }
          for (const parameter of registration.parameters) {
            if (parameter.required && !Object.hasOwn(customArguments, parameter.name)) {
              issues.push({
                code: 'K4-SCHEMA-001',
                path: `${actionPath}.arguments`,
                message: `Custom action ${opcode} requires parameter ${parameter.name}`,
              });
            }
          }
        }
      }
    });
    if (usesPoseRecognition && typeof scenePoseModel !== 'string') {
      issues.push({
        code: 'K4-POSE-MODEL-001',
        path: scenePath,
        message: 'A scene with pose actions must use the long form and declare poseModel',
      });
    }
  }

  const controls = /** @type {Record<string, unknown> | undefined} */ (story.controls);
  const keymaps = /** @type {Record<string, Record<string, string>>} */ (
    /** @type {Record<string, unknown> | undefined} */ (controls?.keymaps) ?? {}
  );
  for (const [profile, keymap] of Object.entries(keymaps)) {
    for (const code of Object.keys(keymap)) {
      if (storyInputCodes.has(code)) {
        issues.push({
          code: 'K4-KEY-001',
          path: `$.controls.keymaps.${profile}.${code}`,
          message: `Key ${code} conflicts with story input at ${storyInputCodes.get(code)}`,
        });
      }
    }
  }

  return issues;
}
