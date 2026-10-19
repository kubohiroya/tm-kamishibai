interface ErrorBlock {
  type: string;
  inputList: {type?: number; fieldRow: {getText?(): string}[]}[];
  getParent?(): ErrorBlock | null;
  setCollapsed?(collapsed: boolean): void;
  select?(): void;
}

interface ErrorWorkspace {
  getBlockById(id: string): ErrorBlock | null;
  centerOnBlock?(id: string): void;
  isVisible?(): boolean;
  getInjectionDiv?(): HTMLElement;
}

export interface Dsl4ErrorBlockly {
  INPUT_VALUE?: number;
  FieldImage?: new (...args: never[]) => object;
  getMainWorkspace(): ErrorWorkspace | null;
  Workspace?: new () => {
    newBlock(opcode: string): ErrorBlock;
    dispose(): void;
  };
}

interface ErrorTarget {
  id: string;
  isOriginal?: boolean;
  isStage?: boolean;
  getName(): string;
  blocks: {getBlock(id: string): {opcode: string} | null | undefined};
}

export interface Dsl4BlockErrorHost {
  gui?: {getBlockly?(): Promise<Dsl4ErrorBlockly>};
  vm: {
    runtime?: {targets?: readonly ErrorTarget[]};
    editingTarget?: ErrorTarget | null;
    setEditingTarget?(id: string): void;
  };
}

const controlNames: Readonly<Record<string, readonly [string, string]>> = {
  control_if: ['もし（）なら', 'if () then'],
  control_if_else: ['もし（）なら、でなければ', 'if () then, else'],
  control_repeat: ['（）回繰り返す', 'repeat ()'],
  control_forever: ['ずっと', 'forever'],
  control_repeat_until: ['（）まで繰り返す', 'repeat until ()'],
  control_wait: ['（）秒待つ', 'wait () seconds'],
  control_wait_until: ['（）まで待つ', 'wait until ()'],
  control_stop: ['（）を止める', 'stop ()'],
  control_create_clone_of: ['（）のクローンを作る', 'create clone of ()'],
  control_delete_this_clone: ['このクローンを削除する', 'delete this clone'],
};

function blockCaption(block: ErrorBlock, blocks: Dsl4ErrorBlockly) {
  // Read only this block's labels. Never evaluate or include its connected children.
  return block.inputList
    .map((input) => {
      const text = input.fieldRow
        .filter((field) => !blocks.FieldImage || !(field instanceof blocks.FieldImage))
        .map((field) => field.getText?.() ?? '')
        .join(' ');
      return input.type !== undefined && input.type === blocks.INPUT_VALUE ? `${text} （）` : text;
    })
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Resolve a diagnostic to a live target without changing the project or evaluating blocks. */
export function createDsl4BlockErrorLocation(
  host: Dsl4BlockErrorHost,
  failure: {code?: unknown; targetName?: unknown; blockId?: unknown},
  locale: 'ja' | 'en',
  blocks?: Dsl4ErrorBlockly,
) {
  if (
    typeof failure.code !== 'string' ||
    !failure.code.startsWith('K4-BLOCK-SOURCE') ||
    typeof failure.targetName !== 'string' ||
    typeof failure.blockId !== 'string'
  )
    return null;
  const blockId = failure.blockId;
  const target = host.vm.runtime?.targets?.find(
    (candidate) =>
      candidate.isOriginal !== false &&
      candidate.getName() === failure.targetName &&
      candidate.blocks.getBlock(blockId),
  );
  const original = target?.blocks.getBlock(blockId);
  if (!target || !original) return null;
  const opcode = original.opcode;
  let blockName = controlNames[opcode]?.[locale === 'ja' ? 0 : 1] ?? opcode;
  if (blocks) {
    let temporary: InstanceType<NonNullable<Dsl4ErrorBlockly['Workspace']>> | undefined;
    try {
      const liveBlock =
        host.vm.editingTarget === target ? blocks.getMainWorkspace()?.getBlockById(blockId) : null;
      temporary = !liveBlock && blocks.Workspace ? new blocks.Workspace() : undefined;
      const block = liveBlock ?? temporary?.newBlock(opcode);
      const caption = block ? blockCaption(block, blocks) : '';
      if (caption) blockName = caption;
    } catch {
      // Missing extension definitions must not hide the original diagnostic.
    } finally {
      temporary?.dispose();
    }
  }
  const current = () =>
    host.vm.runtime?.targets?.includes(target) && target.blocks.getBlock(blockId) === original;
  return {
    targetName: target.isStage ? (locale === 'ja' ? 'ステージ' : 'Stage') : target.getName(),
    blockName,
    blockId,
    blockOpcode: opcode,
    canLocate: Boolean(blocks?.getMainWorkspace() && host.vm.setEditingTarget),
    async locate(isActive: () => boolean = () => true): Promise<boolean> {
      if (!blocks || !isActive() || !current() || !host.vm.setEditingTarget) return false;
      // React's editor tabs expose their relationship through standard ARIA attributes.
      const panel = blocks.getMainWorkspace()?.getInjectionDiv?.().closest('[role="tabpanel"]');
      const tabId = panel?.getAttribute('aria-labelledby');
      if (tabId) panel?.ownerDocument.getElementById(tabId)?.click();
      host.vm.setEditingTarget(target.id);
      // Switching sprites queues workspace rendering; allow that rendering to finish first.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
        if (!isActive() || !current() || host.vm.editingTarget !== target) return false;
        const workspace = blocks.getMainWorkspace();
        if (!workspace || workspace.isVisible?.() === false) continue;
        const block = workspace.getBlockById(blockId);
        if (!block || block.type !== opcode) continue;
        if (!block.select || !workspace.centerOnBlock) return false;
        for (let parent = block.getParent?.(); parent; parent = parent.getParent?.()) {
          parent.setCollapsed?.(false);
        }
        block.select();
        workspace.centerOnBlock(blockId);
        return true;
      }
      return false;
    },
  };
}
