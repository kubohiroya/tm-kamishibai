// Name: Kamishibai Runtime
// ID: kubohiroyakamishibairuntime
// Description: Validate kamishibai scripts and show fatal errors on the TurboWarp stage.
// By: Hiroya Kubo
// License: MPL-2.0

/* global Scratch */

(function (Scratch) {
  'use strict';

  const extensionId = 'kubohiroyakamishibairuntime';
  const supportedVersion = '3.1';
  const featureFlagName = 'featureDetailedScriptErrors';
  const errorVariablePrefix = 'kamishibaiError';
  const promptSpriteName = 'prompt';
  const globalActions = new Set([
    'bgm',
    'branch',
    'keyInputToChangeScene',
    'sound',
    'stage',
    'text',
    'touchInputToChangeScene',
    'transition',
    'wait',
  ]);
  const actorActions = new Set([
    'hide',
    'loop',
    'moveTo',
    'pose',
    'say',
    'sequence',
    'setLayer',
    'setPosition',
    'setScale',
    'setSkin',
    'show',
    'think',
  ]);
  const topLevelCommands = new Set([
    'TMPoseURL',
    'action',
    'actor',
    'asset',
    'cover',
    'kamishibai',
    'registerBranch',
    'sceneLabel',
    'setLoadingBackdrop',
    'setLoadingCostume',
    'setPoseRecognitionSound',
    'setRuntimeVariable',
    'text',
  ]);
  const transitionNames = new Set(['fadeFromWhite', 'fadeOut', 'fadeToWhite', 'fadeUp', 'reset']);
  const categoryLabels = {
    'asset-address': 'アセット参照先',
    'expression-syntax': '条件式の文法',
    'invalid-command': 'コマンド形式',
    'undefined-asset': '未定義アセット',
    'undefined-branch': '未定義分岐',
    'undefined-scene': '未定義シーン',
    'unsupported-action': '非対応アクション',
    'unsupported-command': '非対応コマンド',
    'unsupported-version': '非対応バージョン',
  };

  class ScriptValidationError extends Error {
    constructor(category, message, lineNumber, sourceLine) {
      super(message);
      this.name = 'ScriptValidationError';
      this.category = category;
      this.lineNumber = lineNumber;
      this.sourceLine = sourceLine;
    }
  }

  function validationError(category, message, command) {
    return new ScriptValidationError(
      category,
      message,
      command?.lineNumber ?? 0,
      command?.sourceLine ?? '',
    );
  }

  function splitList(value) {
    return String(value ?? '')
      .split(',')
      .map((item) => item.trim());
  }

  function parseCommands(script) {
    const commands = [];
    const lines = String(script ?? '').split(/\r\n|\n|\r/u);
    for (const [index, sourceLine] of lines.entries()) {
      const line = sourceLine.trim();
      if (!line || line.startsWith('#') || line === '---') continue;
      const separatorIndex = line.indexOf('=');
      if (separatorIndex < 1) {
        throw validationError(
          'invalid-command',
          'コマンドは「キー=値」の形式で記述してください。',
          {lineNumber: index + 1, sourceLine},
        );
      }
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      const command = {key, lineNumber: index + 1, sourceLine, value};
      if (!topLevelCommands.has(key)) {
        throw validationError(
          'unsupported-command',
          `コマンド「${key}」には対応していません。`,
          command,
        );
      }
      commands.push(command);
    }
    return commands;
  }

  function findOriginalSprite(runtime, name) {
    return runtime.targets.find(
      (target) => !target.isStage && target.isOriginal && target.sprite?.name === name,
    );
  }

  function findCostume(target, name) {
    return target?.getCostumes?.().find((costume) => costume.name === name);
  }

  function findSound(target, name) {
    return target?.getSounds?.().find((sound) => sound.name === name);
  }

  function validateCostumeAddress(runtime, assetName, payload, command) {
    const parts = payload.split(':').map((part) => part.trim());
    const spriteName = parts[1] || assetName;
    const costumeName = parts[2] || assetName;
    const sprite = findOriginalSprite(runtime, spriteName);
    if (!sprite) {
      throw validationError(
        'asset-address',
        `アセット「${assetName}」のスプライト「${spriteName}」が見つかりません。`,
        command,
      );
    }
    const costumes = sprite.getCostumes?.() ?? [];
    const shorthandCostume = parts.length < 3 && costumes.length === 1 ? costumes[0] : null;
    if (!findCostume(sprite, costumeName) && !shorthandCostume) {
      throw validationError(
        'asset-address',
        `アセット「${assetName}」のコスチューム「${spriteName}/${costumeName}」が見つかりません。`,
        command,
      );
    }
  }

  function validateBackdropAddress(runtime, assetName, payload, command) {
    const backdropName = payload.includes(':')
      ? payload.slice(payload.indexOf(':') + 1).trim()
      : assetName;
    const stage = runtime.getTargetForStage();
    if (!backdropName || !findCostume(stage, backdropName)) {
      throw validationError(
        'asset-address',
        `アセット「${assetName}」の背景「${backdropName || '(空)'}」が見つかりません。`,
        command,
      );
    }
  }

  function validateSoundAddress(runtime, assetName, payload, command) {
    const parts = payload.split(':').map((part) => part.trim());
    const targetName = parts[1] || '@stage';
    const soundName = parts[2] || assetName;
    const target =
      targetName === '@stage'
        ? runtime.getTargetForStage()
        : findOriginalSprite(runtime, targetName);
    if (!target) {
      throw validationError(
        'asset-address',
        `アセット「${assetName}」の音源スプライト「${targetName}」が見つかりません。`,
        command,
      );
    }
    if (!findSound(target, soundName)) {
      throw validationError(
        'asset-address',
        `アセット「${assetName}」の音「${targetName}/${soundName}」が見つかりません。`,
        command,
      );
    }
  }

  function validateAssetAddress(runtime, assetName, address, command) {
    if (!assetName) {
      throw validationError('asset-address', 'アセット名が空です。', command);
    }
    if (!address || /^https?:\/\//iu.test(address)) return;
    const scheme = address.split(':', 1)[0].trim().toLowerCase();
    if (scheme === 'costume') {
      validateCostumeAddress(runtime, assetName, address, command);
      return;
    }
    if (scheme === 'backdrop') {
      validateBackdropAddress(runtime, assetName, address, command);
      return;
    }
    if (scheme === 'sound') {
      validateSoundAddress(runtime, assetName, address, command);
      return;
    }
    if (scheme === 'text') return;
    throw validationError(
      'asset-address',
      `アセット「${assetName}」のリソース識別子「${address}」には対応していません。`,
      command,
    );
  }

  function parseAsset(command, runtime) {
    const separatorIndex = command.value.indexOf(',');
    if (separatorIndex < 0) {
      throw validationError(
        'asset-address',
        'assetにはアセット名とリソース識別子をカンマ区切りで指定してください。',
        command,
      );
    }
    const name = command.value.slice(0, separatorIndex).trim();
    const address = command.value.slice(separatorIndex + 1).trim();
    validateAssetAddress(runtime, name, address, command);
    return name;
  }

  function requireAsset(assets, name, command, usage) {
    const normalizedName = String(name ?? '').trim();
    if (!normalizedName || !assets.has(normalizedName)) {
      throw validationError(
        'undefined-asset',
        `${usage}で参照されたアセット「${normalizedName || '(空)'}」は定義されていません。`,
        command,
      );
    }
  }

  function requireAssets(assets, names, command, usage) {
    for (const name of splitList(names)) {
      if (name) requireAsset(assets, name, command, usage);
    }
  }

  function parseBranch(command) {
    const [name = '', conditions = '', labels = ''] = command.value.split(':');
    return {
      command,
      conditions: splitList(conditions),
      labels: splitList(labels),
      name: name.trim(),
    };
  }

  function validateExpression(runtime, expression, branch) {
    const evaluate = runtime.getOpcodeFunction?.('kubohiroyaruntimeexpression_runtimeCondition');
    if (!evaluate) {
      throw validationError(
        'expression-syntax',
        'Runtime Expression拡張を利用できないため条件式を検証できません。',
        branch.command,
      );
    }
    try {
      evaluate({EXPRESSION: expression}, {runtime, target: runtime.getTargetForStage()});
    } catch (error) {
      const detail = error?.message ? ` ${error.message}` : '';
      throw validationError(
        'expression-syntax',
        `分岐「${branch.name}」の条件式「${expression}」に文法エラーがあります。${detail}`,
        branch.command,
      );
    }
  }

  function validateAction(command, context) {
    const parts = command.value.split(':').map((part) => part.trim());
    const targetOrCommand = parts[0] ?? '';
    if (globalActions.has(targetOrCommand)) {
      if (targetOrCommand === 'stage') {
        requireAsset(context.assets, parts[1], command, 'stage');
      } else if (targetOrCommand === 'bgm' || targetOrCommand === 'sound') {
        requireAsset(context.assets, parts[1], command, targetOrCommand);
      } else if (targetOrCommand === 'text') {
        requireAsset(context.assets, parts[1], command, 'text');
      } else if (targetOrCommand === 'transition' && !transitionNames.has(parts[1])) {
        throw validationError(
          'unsupported-action',
          `トランジション「${parts[1] || '(空)'}」には対応していません。`,
          command,
        );
      } else if (targetOrCommand === 'branch') {
        context.branchReferences.push({command, name: parts[1] ?? ''});
      } else if (targetOrCommand === 'keyInputToChangeScene') {
        context.sceneReferences.push({command, labels: splitList(parts[2])});
      } else if (targetOrCommand === 'touchInputToChangeScene') {
        context.sceneReferences.push({command, labels: splitList(parts[2])});
      }
      return;
    }

    const actorTargets = splitList(targetOrCommand);
    const actionName = parts[1] ?? '';
    const undefinedActor = actorTargets.find((name) => name !== '*' && !context.actors.has(name));
    if (undefinedActor) {
      throw validationError(
        'unsupported-action',
        `アクション対象「${undefinedActor}」はactorで定義されていません。`,
        command,
      );
    }
    if (!actorActions.has(actionName)) {
      throw validationError(
        'unsupported-action',
        `アクションコマンド「${actionName || '(空)'}」には対応していません。`,
        command,
      );
    }
    if (actionName === 'setSkin') {
      requireAsset(context.assets, parts[2], command, 'setSkin');
    } else if (actionName === 'show' && parts.length >= 4) {
      requireAsset(context.assets, parts[2], command, 'show');
    } else if (actionName === 'loop' || actionName === 'sequence') {
      requireAssets(context.assets, parts[2], command, actionName);
    } else if (actionName === 'pose') {
      requireAssets(context.assets, parts[2], command, 'pose');
      requireAssets(context.assets, parts[4], command, 'pose');
    }
  }

  function validateReferences(context) {
    for (const {command, labels} of context.sceneReferences) {
      for (const label of labels) {
        if (label && !context.scenes.has(label)) {
          throw validationError(
            'undefined-scene',
            `遷移先のシーンラベル「${label}」は定義されていません。`,
            command,
          );
        }
      }
    }
    for (const reference of context.branchReferences) {
      if (!context.branches.has(reference.name)) {
        throw validationError(
          'undefined-branch',
          `分岐「${reference.name || '(空)'}」はregisterBranchで定義されていません。`,
          reference.command,
        );
      }
    }
    for (const branch of context.branches.values()) {
      for (const expression of branch.conditions) {
        if (expression) validateExpression(context.runtime, expression, branch);
      }
      for (const label of branch.labels) {
        if (label && !context.scenes.has(label)) {
          throw validationError(
            'undefined-scene',
            `分岐「${branch.name}」の遷移先「${label}」は定義されていません。`,
            branch.command,
          );
        }
      }
    }
  }

  function validateScript(script, runtime) {
    const commands = parseCommands(script);
    const versionCommand = commands.find((command) => command.key === 'kamishibai');
    if (!versionCommand || versionCommand.value !== supportedVersion) {
      const actualVersion = versionCommand?.value || '(指定なし)';
      throw validationError(
        'unsupported-version',
        `kamishibai=${actualVersion} には対応していません。対応バージョンは ${supportedVersion} です。`,
        versionCommand ?? {
          lineNumber: 1,
          sourceLine: String(script ?? '').split(/\r\n|\n|\r/u)[0] ?? '',
        },
      );
    }

    const context = {
      actors: new Set(),
      assets: new Set(),
      branches: new Map(),
      branchReferences: [],
      runtime,
      sceneReferences: [],
      scenes: new Set(),
    };

    for (const command of commands) {
      if (command.key === 'asset') {
        context.assets.add(parseAsset(command, runtime));
      } else if (command.key === 'actor') {
        context.actors.add(splitList(command.value)[0]);
      } else if (command.key === 'sceneLabel') {
        context.scenes.add(command.value);
      } else if (command.key === 'registerBranch') {
        const branch = parseBranch(command);
        context.branches.set(branch.name, branch);
      }
    }

    for (const command of commands) {
      if (command.key === 'actor') {
        requireAsset(context.assets, splitList(command.value)[1], command, 'actor');
      } else if (command.key === 'cover') {
        const [backdrop, sound] = splitList(command.value);
        requireAsset(context.assets, backdrop, command, 'cover');
        if (sound) requireAsset(context.assets, sound, command, 'cover');
      } else if (command.key === 'setLoadingBackdrop') {
        requireAsset(context.assets, command.value, command, 'setLoadingBackdrop');
      } else if (command.key === 'setLoadingCostume') {
        requireAssets(context.assets, command.value, command, 'setLoadingCostume');
      } else if (command.key === 'setPoseRecognitionSound') {
        requireAssets(context.assets, command.value, command, 'setPoseRecognitionSound');
      } else if (command.key === 'text' && !command.value.startsWith('ui.')) {
        requireAsset(context.assets, command.value.split(':', 1)[0], command, 'text');
      } else if (command.key === 'action') {
        validateAction(command, context);
      }
    }
    validateReferences(context);
  }

  function escapeXml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  function wrapText(value, maximumLength = 43) {
    const characters = Array.from(String(value));
    const lines = [];
    while (characters.length > 0) {
      lines.push(characters.splice(0, maximumLength).join(''));
    }
    return lines.length > 0 ? lines : [''];
  }

  function createErrorSvg(error) {
    const lines = [
      `種類: ${categoryLabels[error.category] ?? error.category}`,
      `位置: ${error.lineNumber > 0 ? `${error.lineNumber}行目` : '不明'}`,
      ...wrapText(`内容: ${error.message}`),
      ...wrapText(`該当行: ${error.sourceLine || '(なし)'}`),
    ].slice(0, 11);
    const body = lines
      .map(
        (line, index) =>
          `<text x="28" y="${92 + index * 22}" class="body">${escapeXml(line)}</text>`,
      )
      .join('');
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360">',
      '<rect width="480" height="360" rx="12" fill="#24070d"/>',
      '<rect x="10" y="10" width="460" height="340" rx="8" fill="none" stroke="#ff6b7a" stroke-width="3"/>',
      '<style>.title{font:700 24px sans-serif;fill:#fff}.body{font:16px sans-serif;fill:#ffecef}</style>',
      '<text x="28" y="52" class="title">台本エラー — 処理を中断しました</text>',
      body,
      '</svg>',
    ].join('');
  }

  class KamishibaiRuntimeExtension {
    constructor() {
      this.runtime = Scratch.vm.runtime;
      this.renderer = this.runtime.renderer;
      this.featureEnabled = null;
      this.errorSkinId = null;
    }

    getInfo() {
      return {
        id: extensionId,
        name: 'Kamishibai Runtime',
        color1: '#9B1C31',
        blocks: [
          {
            opcode: 'validateScriptOrStop',
            blockType: Scratch.BlockType.COMMAND,
            text: 'validate kamishibai script or stop',
            hideFromPalette: true,
          },
        ],
      };
    }

    readFeatureFlag() {
      const stage = this.runtime.getTargetForStage();
      const rawValue = stage?.lookupVariableByNameAndType(featureFlagName, '')?.value;
      if (rawValue === true || rawValue === 1) return true;
      return ['1', 'on', 'true'].includes(
        String(rawValue ?? '')
          .trim()
          .toLowerCase(),
      );
    }

    readScript() {
      return this.runtime.ext_lmsTempVars2?.getRuntimeVariable?.({VAR: 'script'}) ?? '';
    }

    setErrorVariable(name, value) {
      this.runtime.ext_lmsTempVars2?.setRuntimeVariable?.({
        VAR: `${errorVariablePrefix}${name}`,
        STRING: value,
      });
    }

    showError(error) {
      const svg = createErrorSvg(error);
      const prompt = this.runtime.targets.find(
        (target) =>
          !target.isStage && target.isOriginal && target.sprite?.name === promptSpriteName,
      );
      this.runtime.stopAll();
      this.setErrorVariable('Category', error.category);
      this.setErrorVariable('Message', error.message);
      this.setErrorVariable('Line', error.lineNumber);
      this.setErrorVariable('Source', error.sourceLine);
      this.setErrorVariable('Svg', svg);
      if (!prompt) return;

      if (this.renderer && prompt.drawableID !== null) {
        const previousSkinId = this.errorSkinId;
        this.errorSkinId = this.renderer.createSVGSkin(svg);
        this.renderer.updateDrawableSkinId(prompt.drawableID, this.errorSkinId);
        if (previousSkinId !== null) this.renderer.destroySkin(previousSkinId);
      } else {
        const setText = this.runtime.getOpcodeFunction?.('text_setText');
        setText?.(
          {TEXT: `台本エラー\n${error.message}\n${error.lineNumber}行目: ${error.sourceLine}`},
          {runtime: this.runtime, target: prompt},
        );
      }
      prompt.setXY(0, 0);
      prompt.setSize(100);
      prompt.setVisible(true);
      prompt.goToFront();
    }

    validateScriptOrStop() {
      if (this.featureEnabled === null) this.featureEnabled = this.readFeatureFlag();
      if (!this.featureEnabled) return;
      try {
        validateScript(this.readScript(), this.runtime);
      } catch (error) {
        if (error instanceof ScriptValidationError) {
          this.showError(error);
          return;
        }
        throw error;
      }
    }
  }

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Kamishibai Runtime must run unsandboxed.');
  }
  Scratch.extensions.register(new KamishibaiRuntimeExtension());
})(Scratch);
