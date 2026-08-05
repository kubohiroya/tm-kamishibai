const identifierSections = ['assets', 'actors', 'textStyles', 'variables', 'branches', 'scenes'];

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
    issues.push({code: 'K4-REF-001', path, message: `Unknown reference: ${id}`});
    return;
  }
  if (expectedKind && assetKind(collection[id]).kind !== expectedKind) {
    issues.push({
      code: 'K4-REF-002',
      path,
      message: `Reference ${id} must have asset kind ${expectedKind}`,
    });
  }
}

/**
 * Validate relationships that JSON Schema cannot express.
 *
 * @param {Record<string, unknown>} story
 * @returns {SemanticIssue[]}
 */
export function validateDsl4Semantics(story) {
  /** @type {SemanticIssue[]} */
  const issues = [];
  const assets = /** @type {Record<string, unknown>} */ (story.assets ?? {});
  const actors = /** @type {Record<string, string>} */ (story.actors ?? {});
  const scenes = /** @type {Record<string, unknown>} */ (story.scenes ?? {});
  const branches = /** @type {Record<string, Record<string, string>[]>} */ (story.branches ?? {});
  const styles = /** @type {Record<string, unknown>} */ (story.textStyles ?? {});
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
    const file = /** @type {Record<string, unknown>} */ (asset).file;
    if (typeof file !== 'string') continue;
    const components = file.split('/');
    if (
      components.some((component) => component === '.' || component === '..') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(file)
    ) {
      issues.push({
        code: 'K4-ASSET-001',
        path: `$.assets.${id}.file`,
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
        message: `Initial costume ${initialCostume} must target actor ${actor}`,
      });
    }
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
    if (!Array.isArray(scene)) {
      const poseModel = /** @type {Record<string, unknown>} */ (scene).poseModel;
      if (poseModel) {
        addReferenceIssue(issues, assets, poseModel, 'poseModel', `$.scenes.${sceneId}.poseModel`);
      }
    }

    const actionBasePath = Array.isArray(scene)
      ? `$.scenes.${sceneId}`
      : `$.scenes.${sceneId}.actions`;
    sceneActions(scene).forEach((action, actionIndex) => {
      const [key] = Object.keys(action);
      const value = action[key];
      const actionPath = `${actionBasePath}[${actionIndex}].${key}`;
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
      } else if (key === 'keyInputToChangeScene' || key === 'touchInputToChangeScene') {
        const argumentRecord = /** @type {Record<string, unknown>} */ (value);
        const routes = /** @type {Record<string, string>} */ (
          argumentRecord.routes ?? argumentRecord
        );
        for (const [route, destination] of Object.entries(routes)) {
          if (route === 'stableId') continue;
          if (key === 'keyInputToChangeScene') storyInputCodes.set(route, `${actionPath}.${route}`);
          addReferenceIssue(issues, scenes, destination, undefined, `${actionPath}.${route}`);
        }
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
              message: `Costume ${skin} must target actor ${actor}`,
            });
          }
        } else if (opcode === 'setText') {
          const style = /** @type {Record<string, unknown>} */ (value).style;
          addReferenceIssue(issues, styles, style, undefined, `${actionPath}.style`);
        } else if (opcode === 'pose') {
          const choices = /** @type {{skin: string, sound: string}[]} */ (
            /** @type {Record<string, unknown>} */ (value).choices
          );
          choices.forEach((choice, choiceIndex) => {
            addReferenceIssue(
              issues,
              assets,
              choice.skin,
              'costume',
              `${actionPath}.choices[${choiceIndex}].skin`,
            );
            if (
              Object.hasOwn(assets, choice.skin) &&
              assetKind(assets[choice.skin]).target !== actor
            ) {
              issues.push({
                code: 'K4-REF-003',
                path: `${actionPath}.choices[${choiceIndex}].skin`,
                message: `Costume ${choice.skin} must target actor ${actor}`,
              });
            }
            addReferenceIssue(
              issues,
              assets,
              choice.sound,
              'sound',
              `${actionPath}.choices[${choiceIndex}].sound`,
            );
          });
        }
      }
    });
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
