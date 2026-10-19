import assert from 'node:assert/strict';
import {afterEach, test, vi} from 'vitest';
import {installDsl4SectionAppearance} from '../src/dsl4/block-source-section-appearance.js';

class Element {
  attributes = new Map<string, string>();
  children: Element[] = [];
  parent: Element | undefined;
  textContent = '';
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  get firstChild(): Element | null {
    return this.children[0] ?? null;
  }
  appendChild(child: Element) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...children: Element[]) {
    for (const child of children) this.appendChild(child);
  }
  insertBefore(child: Element, before: Element | null) {
    child.parent = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = undefined;
  }
}
class Block {
  node = new Element();
  mode = 'on';
  child: Block | null = null;
  next: Block | null = null;
  values: Block[] = [];
  constructor(public type = 'wait') {}
  getFieldValue() {
    return this.mode;
  }
  getInputTargetBlock() {
    return this.child;
  }
  getNextBlock() {
    return this.next;
  }
  getSvgRoot() {
    return this.node as unknown as SVGElement;
  }
  getRelativeToSurfaceXY() {
    return {x: 24, y: 48};
  }
  getHeightWidth() {
    return {width: 120, height: 40};
  }
  get inputList() {
    return [...(this.child ? [this.child] : []), ...this.values].map((child) => ({
      connection: {targetBlock: () => child},
    }));
  }
}
const section = () => new Block('kubohiroyakamishibaiauthoring4_useSection');
const muted = (block: Block) => block.node.getAttribute('data-kamishibai-section-muted');
function fixture(all: Block[]) {
  const head = new Element(),
    svg = new Element();
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('document', {
    head,
    createElement: () => new Element(),
    createElementNS: () => new Element(),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const listeners = new Set<(event?: {type?: string; isUiEvent?: boolean}) => void>();
  const workspace = {
    id: 'main',
    getAllBlocks: () => all,
    addChangeListener: (listener: (event?: {type?: string; isUiEvent?: boolean}) => void) =>
      listeners.add(listener),
    removeChangeListener: (listener: (event?: {type?: string; isUiEvent?: boolean}) => void) =>
      listeners.delete(listener),
    getParentSvg: () => svg as unknown as SVGElement,
  };
  let active: typeof workspace | null = workspace;
  const events = new Map<string, () => void>();
  const host = {
    gui: {getBlockly: async () => ({getMainWorkspace: () => active})},
    vm: {
      on: (event: string, listener: () => void) => events.set(event, listener),
      removeListener: (event: string) => events.delete(event),
    },
  };
  function flush() {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  }
  return {
    host,
    head,
    svg,
    listeners,
    events,
    flush,
    change() {
      for (const listener of listeners) listener();
      flush();
    },
    leaveWorkspace() {
      active = null;
      events.get('workspaceUpdate')?.();
      flush();
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

test('shades only the off substack, including inputs, without disabling VM blocks', async () => {
  const owner = section(),
    first = new Block(),
    second = new Block(),
    value = new Block();
  const after = new Block();
  owner.mode = 'off';
  owner.child = first;
  owner.next = after;
  first.next = second;
  first.values = [value];
  const f = fixture([owner, first, second, value, after]);
  const dispose = await installDsl4SectionAppearance(f.host);
  f.flush();
  assert.equal(muted(first), 'true');
  assert.equal(muted(second), 'true');
  assert.equal(muted(value), 'true');
  assert.equal(muted(owner), null);
  assert.equal(muted(after), null);
  assert.equal(Object.hasOwn(first, 'disabled'), false);
  assert.equal(owner.node.children.length, 1);
  owner.mode = 'on';
  f.change();
  assert.equal(muted(first), null);
  assert.equal(muted(second), null);
  assert.equal(owner.node.children.length, 0);
  dispose!();
  assert.equal(f.head.children.length, 0);
  assert.equal(f.svg.children.length, 0);
});
test('keeps nested on sections muted under an off parent and restores moved blocks', async () => {
  const outer = section(),
    inner = section(),
    inside = new Block(),
    after = new Block();
  outer.mode = 'off';
  outer.child = inner;
  inner.child = inside;
  outer.next = after;
  const f = fixture([outer, inner, inside, after]);
  const dispose = await installDsl4SectionAppearance(f.host);
  f.flush();
  assert.equal(muted(inner), 'true');
  assert.equal(muted(inside), 'true');
  outer.mode = 'on';
  inner.mode = 'off';
  f.change();
  assert.equal(muted(inner), null);
  assert.equal(muted(inside), 'true');
  inner.child = null;
  inner.next = inside;
  f.change();
  assert.equal(muted(inside), null);
  assert.equal(inner.node.children.length, 0);
  assert.equal(muted(after), null);
  dispose!();
});
test('cleans decorations on target changes and supports repeated disposal', async () => {
  const owner = section(),
    inside = new Block();
  owner.mode = 'off';
  owner.child = inside;
  const f = fixture([owner, inside]);
  const dispose = await installDsl4SectionAppearance(f.host);
  f.flush();
  f.leaveWorkspace();
  assert.equal(muted(inside), null);
  assert.equal(f.listeners.size, 0);
  assert.equal(owner.node.children.length, 0);
  assert.equal(f.svg.children.length, 0);
  dispose!();
  dispose!();
  assert.equal(f.events.size, 0);
  assert.equal(f.head.children.length, 0);
});
test('leaves hosts without the editor API unchanged', async () => {
  assert.equal(await installDsl4SectionAppearance({}), undefined);
});
test('does not install after disposal while the editor API is still loading', async () => {
  const f = fixture([]);
  let disposed = false;
  const installed = installDsl4SectionAppearance(f.host, () => disposed);
  disposed = true;
  assert.equal(await installed, undefined);
  f.flush();
  assert.equal(f.head.children.length, 0);
  assert.equal(f.events.size, 0);
  assert.equal(f.listeners.size, 0);
});
test('replaces an earlier installation without leaving duplicate decorations or listeners', async () => {
  const owner = section(),
    inside = new Block();
  owner.mode = 'off';
  owner.child = inside;
  const f = fixture([owner, inside]);
  const previous = await installDsl4SectionAppearance(f.host);
  f.flush();
  const dispose = await installDsl4SectionAppearance(f.host);
  f.flush();
  assert.equal(f.head.children.length, 1);
  assert.equal(f.listeners.size, 1);
  assert.equal(owner.node.children.length, 1);
  previous!();
  assert.equal(muted(inside), 'true');
  dispose!();
  assert.equal(f.head.children.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(muted(inside), null);
});
