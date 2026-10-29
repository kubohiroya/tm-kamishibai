import {collectDsl4DefinitionReferences, definitionRecord} from './definition-references.js';
import type {Dsl4DefinitionPath} from './definition-references.js';

export class Dsl4ImplicitProjectAssetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path: Dsl4DefinitionPath,
  ) {
    super(message);
    this.name = 'Dsl4ImplicitProjectAssetError';
  }
}

/** Story-level defaults are applied before narrative condition validation. */
export function applyDsl4StoryVariableDefaults(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const story = input as Record<string, unknown>;
  if (
    story.variables !== undefined &&
    (story.variables === null ||
      typeof story.variables !== 'object' ||
      Array.isArray(story.variables))
  )
    return story;
  const variables = definitionRecord(story.variables);
  return Object.hasOwn(variables, 'startSceneIndex')
    ? story
    : {...story, variables: {...variables, startSceneIndex: 1}};
}

function setAt(root: Record<string, unknown>, path: Dsl4DefinitionPath, value: unknown) {
  let current: unknown = root;
  for (const segment of path.slice(0, -1))
    current = (current as Record<string | number, unknown>)[segment];
  (current as Record<string | number, unknown>)[path.at(-1)!] = value;
}

function actorVariable(target: Record<string, unknown>, name: string) {
  return Object.values(definitionRecord(target.variables)).some(
    (value) => Array.isArray(value) && value[0] === 'actorName' && value[1] === name,
  );
}

/** Resolve only missing declarations against a concrete project; explicit definitions always win. */
export function resolveDsl4ImplicitProjectAssets(
  input: Record<string, unknown>,
  project: unknown,
  schema?: unknown,
) {
  const story = structuredClone(input);
  // Preserve malformed authored declarations for the canonical schema validator.
  if (
    ['assets', 'actors'].some(
      (key) =>
        Object.hasOwn(story, key) &&
        (story[key] === null || typeof story[key] !== 'object' || Array.isArray(story[key])),
    )
  )
    return {story, inferred: [] as string[], actors: [] as string[]};
  const targets = definitionRecord(project).targets;
  if (!Array.isArray(targets)) return {story, inferred: [] as string[], actors: [] as string[]};
  const sprites = targets.map(definitionRecord).filter((target) => target.isStage === false);
  const stages = targets.map(definitionRecord).filter((target) => target.isStage === true);
  const assets = {...definitionRecord(story.assets)};
  const actors = {...definitionRecord(story.actors)};
  const inferred: string[] = [];
  const inferredActors: string[] = [];
  function fail(message: string, path: Dsl4DefinitionPath): never {
    throw new Dsl4ImplicitProjectAssetError('K4-PROJECT-REF-001', message, path);
  }
  function sprite(actor: string, path: Dsl4DefinitionPath) {
    const named = sprites.filter((target) => target.name === actor);
    const declaredActor = Object.hasOwn(definitionRecord(input.actors), actor);
    const aliases = declaredActor ? sprites.filter((target) => actorVariable(target, actor)) : [];
    const logical = aliases.length ? aliases : named;
    const candidates =
      logical.length || !declaredActor
        ? logical
        : sprites.filter((target) => actorVariable(target, '_template_'));
    if (candidates.length !== 1)
      fail(`スプライトを一意に解決できません: ${JSON.stringify(actor)}`, path);
    return candidates[0]!;
  }
  function register(
    kind: string,
    target: Record<string, unknown>,
    name: string,
    path: Dsl4DefinitionPath,
    actor?: string,
  ) {
    const collection = kind === 'sound' ? target.sounds : target.costumes;
    const matches = Array.isArray(collection)
      ? collection.map(definitionRecord).filter((asset) => asset.name === name)
      : [];
    if (matches.length !== 1)
      fail(`SB3内の${kind}を一意に解決できません: ${JSON.stringify([target.name, name])}`, path);
    const base = `@project/${kind}/${encodeURIComponent(String(actor ?? target.name ?? ''))}/${encodeURIComponent(name)}`;
    let id = base;
    let suffix = 0;
    while (Object.hasOwn(assets, id) && !inferred.includes(id)) id = `${base}/${++suffix}`;
    if (!Object.hasOwn(assets, id)) {
      assets[id] = {
        kind,
        name,
        ...(kind === 'costume' ? {target: actor} : {}),
        ...(kind === 'sound' && target.isStage !== true ? {target: target.name} : {}),
        ...(kind === 'costume' || kind === 'backdrop'
          ? {bitmapResolution: matches[0]!.bitmapResolution === 2 ? 2 : 1}
          : {}),
      };
      inferred.push(id);
    }
    return id;
  }
  if (!Object.hasOwn(story, 'cover') && stages.length > 1)
    fail('表紙の既定値に使うStageを一意に解決できません', ['cover']);
  if (!Object.hasOwn(story, 'cover') && stages.length === 1) {
    const stage = stages[0]!;
    const backdrop = Array.isArray(stage.costumes)
      ? definitionRecord(stage.costumes[0]).name
      : undefined;
    const sound = Array.isArray(stage.sounds) ? definitionRecord(stage.sounds[0]).name : undefined;
    if (typeof backdrop === 'string')
      story.cover = {
        backdrop: register('backdrop', stage, backdrop, ['cover', 'backdrop']),
        ...(typeof sound === 'string'
          ? {bgm: register('sound', stage, sound, ['cover', 'bgm'])}
          : {}),
      };
  }
  const references =
    schema === undefined ? [] : collectDsl4DefinitionReferences(input, schema).references;
  story.actors = actors;
  function ensureActor(name: string, at: Dsl4DefinitionPath) {
    if (Object.hasOwn(actors, name)) return;
    if (['__proto__', 'constructor', 'prototype'].includes(name))
      fail('予約されたactor名は使えません', at);
    const target = sprite(name, at);
    const costumes = Array.isArray(target.costumes) ? target.costumes.map(definitionRecord) : [];
    const costume = costumes[0];
    if (typeof costume?.name !== 'string')
      fail(`スプライトにコスチュームがありません: ${JSON.stringify(name)}`, at);
    actors[name] = register('costume', target, costume.name, at, name);
    inferredActors.push(name);
  }
  // An actual sprite can be used as an actor without a redundant initial-costume declaration.
  for (const reference of references.filter(
    (entry) => entry.namespace === 'actors' && entry.access !== 'owner',
  ))
    ensureActor(reference.name, reference.path);
  for (const reference of references.filter((entry) => entry.namespace === 'assets')) {
    if (Object.hasOwn(definitionRecord(input.assets), reference.name)) continue;
    const kind = reference.assetKind;
    if (!['costume', 'backdrop', 'sound'].includes(kind ?? '')) continue;
    let target: Record<string, unknown>;
    let actor = reference.actor;
    if (kind === 'costume') {
      if (actor) target = sprite(actor, reference.path);
      else {
        const matches = sprites.filter(
          (candidate) =>
            Array.isArray(candidate.costumes) &&
            candidate.costumes.some((costume) => definitionRecord(costume).name === reference.name),
        );
        if (matches.length !== 1 || typeof matches[0]!.name !== 'string')
          fail('コスチュームの所有スプライトを特定できません', reference.path);
        target = matches[0]!;
        actor = String(target.name);
        ensureActor(actor, reference.path);
      }
    } else if (kind === 'backdrop') {
      if (stages.length !== 1) fail('Stageを一意に解決できません', reference.path);
      target = stages[0]!;
    } else {
      const hasSound = (candidate: Record<string, unknown>) =>
        Array.isArray(candidate.sounds) &&
        candidate.sounds.some((sound) => definitionRecord(sound).name === reference.name);
      const stageMatches = stages.filter(hasSound);
      const matches = stageMatches.length ? stageMatches : sprites.filter(hasSound);
      if (matches.length !== 1)
        fail(
          `音の所有targetを一意に解決できません: ${JSON.stringify(reference.name)}`,
          reference.path,
        );
      target = matches[0]!;
    }
    const id = register(kind!, target, reference.name, reference.path, actor);
    setAt(story, reference.path, id);
  }
  if (inferred.length) story.assets = assets;
  if (!Object.hasOwn(input, 'actors') && !inferredActors.length) delete story.actors;
  return {story, inferred, actors: inferredActors};
}

/** Supplement authenticated compiled IR without reparsing or changing its stored artifact. */
export function applyDsl4CompiledProjectDefaults(
  input: Readonly<Record<string, unknown>>,
  project: unknown,
) {
  const existing = definitionRecord(input.assets);
  const resolved = resolveDsl4ImplicitProjectAssets(
    {
      assets: existing,
      ...(input.cover === undefined || input.cover === null ? {} : {cover: input.cover}),
    },
    project,
  );
  const additions = Object.fromEntries(
    resolved.inferred.map((id) => [
      id,
      {
        id,
        delivery: 'embedded',
        loading: 'eager',
        retention: 'story',
        ...definitionRecord(definitionRecord(resolved.story.assets)[id]),
      },
    ]),
  );
  return {
    story: {
      ...input,
      variables: {startSceneIndex: 1, ...definitionRecord(input.variables)},
      cover: resolved.story.cover ?? input.cover,
      assets: {...existing, ...additions},
    },
    inferred: resolved.inferred,
  };
}
