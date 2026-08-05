import Ajv2020 from 'ajv/dist/2020.js';
import {isAlias, isPair, parseAllDocuments, visit} from 'yaml';

const identifierSections = ['assets', 'actors', 'textStyles', 'variables', 'branches', 'scenes'];

function diagnostic(code, path, message) {
  return {code, path, message};
}

function assetKind(asset) {
  if (typeof asset === 'string') {
    const [kind, target] = asset.split(':');
    return {kind, target};
  }
  return {kind: asset?.kind, target: asset?.target};
}

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
  return namedKey ? value[namedKey] : value;
}

function sceneActions(scene) {
  return Array.isArray(scene) ? scene : scene.actions;
}

function addReferenceError(errors, collection, id, expectedKind, path) {
  if (typeof id !== 'string') return;
  if (!Object.hasOwn(collection, id)) {
    errors.push(diagnostic('K4-REF-001', path, `Unknown reference: ${id}`));
    return;
  }
  if (expectedKind && assetKind(collection[id]).kind !== expectedKind) {
    errors.push(
      diagnostic('K4-REF-002', path, `Reference ${id} must have asset kind ${expectedKind}`),
    );
  }
}

function validateRestrictedYaml(source) {
  const documents = parseAllDocuments(source, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  });
  const errors = documents.flatMap((document) =>
    document.errors.map((error) => diagnostic('K4-YAML-001', '$', error.message)),
  );

  if (documents.length !== 1) {
    errors.push(diagnostic('K4-YAML-002', '$', 'Exactly one YAML document is required'));
  }

  for (const document of documents) {
    visit(document, (_key, node) => {
      if (isAlias(node) || node?.anchor) {
        errors.push(diagnostic('K4-YAML-003', '$', 'YAML aliases and anchors are not supported'));
      }
      if (isPair(node) && node.key?.value === '<<') {
        errors.push(diagnostic('K4-YAML-004', '$', 'YAML merge keys are not supported'));
      }
      if (node?.tag) {
        errors.push(diagnostic('K4-YAML-005', '$', 'Custom YAML tags are not supported'));
      }
    });
  }

  return {document: documents[0], errors};
}

export function compileDsl4Schema(schema) {
  return new Ajv2020({allErrors: true, strict: true}).compile(schema);
}

function normalizeAsset(id, asset) {
  if (typeof asset === 'string') {
    const {kind, target} = assetKind(asset);
    return {id, kind, loading: 'eager', name: id, ...(target ? {target} : {})};
  }
  return {id, loading: 'eager', ...asset};
}

function normalizeAction(action) {
  const [sourceCommand] = Object.keys(action);
  const separator = sourceCommand.lastIndexOf('.');
  const actor = separator === -1 ? undefined : sourceCommand.slice(0, separator);
  const command = separator === -1 ? sourceCommand : sourceCommand.slice(separator + 1);
  const sourceArguments = action[sourceCommand];
  let args;

  if (typeof sourceArguments === 'object' && sourceArguments !== null) {
    const routeCommand =
      command === 'keyInputToChangeScene' || command === 'touchInputToChangeScene';
    args = routeCommand && !sourceArguments.routes ? {routes: sourceArguments} : sourceArguments;
  } else {
    const argumentName = {
      bgm: 'sound',
      branch: 'branch',
      goto: 'scene',
      setSkin: 'skin',
      sound: 'sound',
      stage: 'backdrop',
      wait: 'seconds',
    }[command];
    args = {[argumentName]: sourceArguments};
  }

  return {command, ...(actor ? {actor} : {}), args};
}

export function normalizeDsl4Story(story) {
  return {
    ...story,
    assets: Object.entries(story.assets ?? {}).map(([id, asset]) => normalizeAsset(id, asset)),
    scenes: Object.entries(story.scenes).map(([id, scene]) => ({
      id,
      ...(!Array.isArray(scene) && scene.poseModel ? {poseModel: scene.poseModel} : {}),
      actions: sceneActions(scene).map(normalizeAction),
    })),
  };
}

export function validateDsl4Semantics(story) {
  const errors = [];
  const assets = story.assets ?? {};
  const actors = story.actors ?? {};
  const scenes = story.scenes ?? {};
  const branches = story.branches ?? {};
  const styles = story.textStyles ?? {};
  const stableIds = new Map();
  const storyInputCodes = new Map();

  for (const section of identifierSections) {
    for (const id of Object.keys(story[section] ?? {})) {
      if (id !== id.normalize('NFC')) {
        errors.push(
          diagnostic('K4-ID-001', `$.${section}.${id}`, 'Identifiers must use Unicode NFC'),
        );
      }
    }
  }

  for (const [id, asset] of Object.entries(assets)) {
    if (typeof asset !== 'object' || asset === null || !asset.file) continue;
    const components = asset.file.split('/');
    if (
      components.some((component) => component === '.' || component === '..') ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(asset.file)
    ) {
      errors.push(
        diagnostic(
          'K4-ASSET-001',
          `$.assets.${id}.file`,
          'Asset file must be a local relative path without dot segments',
        ),
      );
    }
  }

  for (const [actor, initialCostume] of Object.entries(actors)) {
    addReferenceError(errors, assets, initialCostume, 'costume', `$.actors.${actor}`);
    if (
      Object.hasOwn(assets, initialCostume) &&
      assetKind(assets[initialCostume]).target !== actor
    ) {
      errors.push(
        diagnostic(
          'K4-REF-003',
          `$.actors.${actor}`,
          `Initial costume ${initialCostume} must target actor ${actor}`,
        ),
      );
    }
  }

  if (story.cover) {
    addReferenceError(errors, assets, story.cover.backdrop, 'backdrop', '$.cover.backdrop');
    if (story.cover.bgm) {
      addReferenceError(errors, assets, story.cover.bgm, 'sound', '$.cover.bgm');
    }
  }
  if (story.loading) {
    addReferenceError(errors, assets, story.loading.backdrop, 'backdrop', '$.loading.backdrop');
    story.loading.costumes.forEach((id, index) =>
      addReferenceError(errors, assets, id, 'costume', `$.loading.costumes[${index}]`),
    );
  }
  if (story.poseRecognition) {
    for (const key of ['idleSound', 'chargeSound']) {
      addReferenceError(
        errors,
        assets,
        story.poseRecognition[key],
        'sound',
        `$.poseRecognition.${key}`,
      );
    }
  }

  for (const [branchId, rules] of Object.entries(branches)) {
    if (!Object.hasOwn(rules.at(-1), 'else')) {
      errors.push(
        diagnostic('K4-BRANCH-001', `$.branches.${branchId}`, 'The final branch rule must be else'),
      );
    }
    rules.forEach((rule, index) => {
      const destination = rule.goto ?? rule.else;
      addReferenceError(errors, scenes, destination, undefined, `$.branches.${branchId}[${index}]`);
    });
  }

  for (const [sceneId, scene] of Object.entries(scenes)) {
    if (!Array.isArray(scene) && scene.poseModel) {
      addReferenceError(
        errors,
        assets,
        scene.poseModel,
        'poseModel',
        `$.scenes.${sceneId}.poseModel`,
      );
    }

    const actionBasePath = Array.isArray(scene)
      ? `$.scenes.${sceneId}`
      : `$.scenes.${sceneId}.actions`;
    sceneActions(scene).forEach((action, actionIndex) => {
      const [key] = Object.keys(action);
      const value = action[key];
      const actionPath = `${actionBasePath}[${actionIndex}].${key}`;
      if (value && typeof value === 'object' && !Array.isArray(value) && value.stableId) {
        const previousPath = stableIds.get(value.stableId);
        if (previousPath) {
          errors.push(
            diagnostic(
              'K4-STABLE-ID-001',
              `${actionPath}.stableId`,
              `stableId ${value.stableId} is already used at ${previousPath}`,
            ),
          );
        } else {
          stableIds.set(value.stableId, `${actionPath}.stableId`);
        }
      }

      if (key === 'stage') {
        addReferenceError(errors, assets, actionArgument(action, key), 'backdrop', actionPath);
      } else if (key === 'bgm' || key === 'sound') {
        addReferenceError(errors, assets, actionArgument(action, key), 'sound', actionPath);
      } else if (key === 'goto') {
        addReferenceError(errors, scenes, actionArgument(action, key), undefined, actionPath);
      } else if (key === 'branch') {
        addReferenceError(errors, branches, actionArgument(action, key), undefined, actionPath);
      } else if (key === 'keyInputToChangeScene' || key === 'touchInputToChangeScene') {
        const routes = value.routes ?? value;
        for (const [route, destination] of Object.entries(routes)) {
          if (route === 'stableId') continue;
          if (key === 'keyInputToChangeScene') storyInputCodes.set(route, `${actionPath}.${route}`);
          addReferenceError(errors, scenes, destination, undefined, `${actionPath}.${route}`);
        }
      } else if (key.includes('.')) {
        const separator = key.lastIndexOf('.');
        const actor = key.slice(0, separator);
        const opcode = key.slice(separator + 1);
        if (!Object.hasOwn(actors, actor)) {
          errors.push(diagnostic('K4-REF-001', actionPath, `Unknown actor: ${actor}`));
        }
        if (opcode === 'show' || opcode === 'setSkin') {
          const skin = opcode === 'show' ? value.skin : (value.skin ?? value);
          addReferenceError(errors, assets, skin, 'costume', `${actionPath}.skin`);
          if (Object.hasOwn(assets, skin) && assetKind(assets[skin]).target !== actor) {
            errors.push(
              diagnostic(
                'K4-REF-003',
                `${actionPath}.skin`,
                `Costume ${skin} must target actor ${actor}`,
              ),
            );
          }
        } else if (opcode === 'setText') {
          addReferenceError(errors, styles, value.style, undefined, `${actionPath}.style`);
        } else if (opcode === 'pose') {
          value.choices.forEach((choice, choiceIndex) => {
            addReferenceError(
              errors,
              assets,
              choice.skin,
              'costume',
              `${actionPath}.choices[${choiceIndex}].skin`,
            );
            if (
              Object.hasOwn(assets, choice.skin) &&
              assetKind(assets[choice.skin]).target !== actor
            ) {
              errors.push(
                diagnostic(
                  'K4-REF-003',
                  `${actionPath}.choices[${choiceIndex}].skin`,
                  `Costume ${choice.skin} must target actor ${actor}`,
                ),
              );
            }
            addReferenceError(
              errors,
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

  for (const [profile, keymap] of Object.entries(story.controls?.keymaps ?? {})) {
    for (const code of Object.keys(keymap)) {
      if (storyInputCodes.has(code)) {
        errors.push(
          diagnostic(
            'K4-KEY-001',
            `$.controls.keymaps.${profile}.${code}`,
            `Key ${code} conflicts with story input at ${storyInputCodes.get(code)}`,
          ),
        );
      }
    }
  }

  return errors;
}

export function validateDsl4Source(source, validateSchema) {
  const {document, errors} = validateRestrictedYaml(source);
  if (errors.length > 0 || !document) return {errors};
  const story = document.toJS({maxAliasCount: 0});
  if (!validateSchema(story)) {
    return {
      errors: validateSchema.errors.map((error) =>
        diagnostic(schemaDiagnosticCode(error), error.instancePath || '$', error.message),
      ),
    };
  }
  return {errors: validateDsl4Semantics(story), story};
}

function schemaDiagnosticCode(error) {
  if (error.instancePath === '/kamishibai' && error.keyword === 'const') {
    return 'K4-VERSION-001';
  }
  if (error.keyword === 'additionalProperties') return 'K4-SCHEMA-UNKNOWN-KEY';
  if (error.keyword === 'propertyNames') return 'K4-ID-INVALID';
  if (error.schemaPath.endsWith('/keyCode/pattern')) return 'K4-KEY-UNSUPPORTED';
  return 'K4-SCHEMA-001';
}
