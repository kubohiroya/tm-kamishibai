/** The document the fake DOM hands back: element factory, event dispatch, and the body. */
export interface FakeDocument {
  activeElement: FakeElement | null;
  body: FakeElement;
  createElement(tagName: string): FakeElement;
  createElementNS(namespace: string | null, tagName: string): FakeElement;
  addEventListener(
    type: string,
    listener: FakeEventListener,
    options?: boolean | FakeListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: FakeEventListener,
    options?: boolean | FakeListenerOptions,
  ): void;
  dispatchKey(code: string, options?: FakeEventOptions): FakeEvent;
  dispatchPointer(pointerId: number, options?: FakeEventOptions): FakeEvent;
  dispatchPointerEvent(type: string, pointerId: number, options?: FakeEventOptions): FakeEvent;
  listenerCount(type: string): number;
  /** Set by the suites that drive browser geometry through a fake window. */
  defaultView?: unknown;
  /** Set by the suites that drive fullscreen geometry. */
  fullscreenElement?: unknown;
  /** Set by the suites that drive a packaged runtime through page visibility. */
  visibilityState?: string;
}

/** A keyboard, pointer, or click event as the fake DOM dispatches it. */
export interface FakeEvent {
  readonly code: string;
  readonly target: FakeElement | null;
  pointerId?: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

export type FakeEventListener = (event: FakeEvent) => void;

/** What a test hands `setBoundingClientRect`; the getter fills in the edges it leaves out. */
export interface FakeRect {
  x?: number;
  y?: number;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  width: number;
  height: number;
}

interface FakeEventOptions {
  code?: string;
  target?: FakeElement | null;
  shiftKey?: boolean;
  modifiers?: {altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean};
  pointerId?: number;
}

interface FakeListenerOptions {
  capture?: boolean;
}

export class FakeElement {
  declare readonly ownerDocument: FakeDocument;
  declare readonly tagName: string;
  declare parentNode: FakeElement | null;
  declare children: FakeElement[];
  declare readonly attributes: Map<string, string>;
  declare readonly listeners: Map<string, FakeEventListener[]>;
  declare id: string;
  declare textContent: string;
  declare hidden: boolean;
  declare disabled: boolean;
  declare tabIndex: number;
  declare type: string;
  declare value: string;
  /** `<progress>` carries its own ceiling, and the pose feedback presenter sets it. */
  declare max: number;
  declare src: string;
  declare alt: string;
  /** `<input type="file">` members the open flow sets and the suites read back. */
  declare accept: string;
  declare multiple: boolean;
  declare webkitdirectory: unknown;
  declare files: unknown[];
  declare readonly style: Record<string, string>;
  declare readonly dataset: Record<string, string>;
  declare readonly pointerCaptures: Set<number>;
  declare boundingClientRect: FakeRect | null;

  constructor(document: FakeDocument, tagName: string) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.id = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.type = '';
    this.value = '';
    this.max = 0;
    this.src = '';
    this.alt = '';
    this.accept = '';
    this.multiple = false;
    this.files = [];
    this.style = {};
    this.dataset = {};
    this.pointerCaptures = new Set();
    this.boundingClientRect = null;
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children: FakeElement[]) {
    for (const child of children) this.appendChild(child);
  }

  after(child: FakeElement) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, child);
  }

  /** Detach one mounted child, refusing an element that is not mounted here, as the DOM does. */
  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index < 0) throw new TypeError('child is not mounted');
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...children: FakeElement[]) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: FakeEventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeEventListener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== listener),
    );
  }

  dispatch(type: string, options: FakeEventOptions = {}) {
    const event = createFakeEvent({code: '', target: this, ...options});
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  setPointerCapture(pointerId: number) {
    this.pointerCaptures.add(pointerId);
  }

  hasPointerCapture(pointerId: number) {
    return this.pointerCaptures.has(pointerId);
  }

  releasePointerCapture(pointerId: number) {
    this.pointerCaptures.delete(pointerId);
  }

  setBoundingClientRect(rect: FakeRect) {
    this.boundingClientRect = {...rect};
  }

  getBoundingClientRect() {
    const rect = this.boundingClientRect ?? {x: 0, y: 0, width: 0, height: 0};
    return {
      ...rect,
      left: rect.left ?? rect.x,
      top: rect.top ?? rect.y,
      right: rect.right ?? Number(rect.x ?? rect.left) + rect.width,
      bottom: rect.bottom ?? Number(rect.y ?? rect.top) + rect.height,
    };
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus() {
    if (!this.disabled) this.ownerDocument.activeElement = this;
  }

  click() {
    if (this.disabled) return;
    this.dispatch('click');
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
}

function createFakeEvent({
  code = '',
  target = null,
  shiftKey = false,
  modifiers = {},
  pointerId,
}: FakeEventOptions): FakeEvent {
  return {
    code,
    target,
    ...(pointerId === undefined ? {} : {pointerId}),
    shiftKey,
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
  };
}

export function createFakeDocument() {
  const listeners = new Map<string, {listener: FakeEventListener; capture: boolean}[]>();
  const document: FakeDocument = {
    activeElement: null as FakeElement | null,
    createElement(tagName: string) {
      return new FakeElement(document, tagName);
    },
    createElementNS(_namespace: string | null, tagName: string) {
      return new FakeElement(document, tagName);
    },
    addEventListener(
      type: string,
      listener: FakeEventListener,
      options: boolean | FakeListenerOptions = false,
    ) {
      const values = listeners.get(type) ?? [];
      values.push({
        listener,
        capture: options === true || (options as FakeListenerOptions | null)?.capture === true,
      });
      listeners.set(type, values);
    },
    removeEventListener(
      type: string,
      listener: FakeEventListener,
      options: boolean | FakeListenerOptions = false,
    ) {
      const capture = options === true || (options as FakeListenerOptions | null)?.capture === true;
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter(
          (value) => value.listener !== listener || value.capture !== capture,
        ),
      );
    },
    dispatchKey(code: string, options: FakeEventOptions = {}) {
      const event = createFakeEvent({
        code,
        target: document.activeElement ?? document.body,
        ...options,
      });
      const keyListeners = listeners.get('keydown') ?? [];
      for (const {listener} of keyListeners.filter(({capture}) => capture)) listener(event);
      if (!event.propagationStopped) {
        for (const {listener} of keyListeners.filter(({capture}) => !capture)) listener(event);
      }
      return event;
    },
    dispatchPointer(pointerId: number, options: FakeEventOptions = {}) {
      return document.dispatchPointerEvent('pointerdown', pointerId, options);
    },
    dispatchPointerEvent(type: string, pointerId: number, options: FakeEventOptions = {}) {
      const event = createFakeEvent({code: '', target: document.activeElement, ...options});
      event.pointerId = pointerId;
      const pointerListeners = listeners.get(type) ?? [];
      for (const {listener} of pointerListeners.filter(({capture}) => capture)) listener(event);
      if (!event.propagationStopped) {
        for (const {listener} of pointerListeners.filter(({capture}) => !capture)) listener(event);
      }
      return event;
    },
    listenerCount(type: string) {
      return (listeners.get(type) ?? []).length;
    },
    // `body` is created below, once the document itself exists to own it.
  } as unknown as FakeDocument;
  document.body = document.createElement('body');
  return document;
}

export function findById(root: FakeElement, id: string): FakeElement | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findById(child, id);
    if (match) return match;
  }
  return null;
}

/**
 * Take the one element a query was meant to find.
 *
 * Suites reached for `findByAttribute(...)[0]` and drove it straight away, so a query that matched
 * nothing failed as `cannot read property click of undefined`, several lines from the cause. This
 * says which query came up empty, and refuses a query that matched more than one.
 */
export function requireOne(elements: readonly FakeElement[], description: string): FakeElement {
  const [first, ...rest] = elements;
  if (!first || rest.length > 0) {
    throw new Error(`Expected exactly one ${description}, found ${elements.length}`);
  }
  return first;
}

/**
 * Take the first of a list a suite expects to be non-empty.
 *
 * Use this where the suite means "the first child"; use `requireOne` where it means "the only
 * match". Both fail by name instead of leaving `undefined` to surface a line or two later.
 */
export function requireFirst(elements: readonly FakeElement[], description: string): FakeElement {
  const [first] = elements;
  if (!first) throw new Error(`Expected at least one ${description}, found none`);
  return first;
}

/** Take the one element carrying `name="value"`, by the same rule as `requireOne`. */
export function requireByAttribute(root: FakeElement, name: string, value: string): FakeElement {
  return requireOne(findByAttribute(root, name, value), `[${name}="${value}"]`);
}

/** Take the element carrying `id`, failing by name when the tree does not have one. */
export function requireById(root: FakeElement, id: string): FakeElement {
  const found = findById(root, id);
  if (!found) throw new Error(`Expected an element with id ${JSON.stringify(id)}`);
  return found;
}

export function findByAttribute(root: FakeElement, name: string, value: string): FakeElement[] {
  const matches: FakeElement[] = [];
  if (root.getAttribute(name) === value) matches.push(root);
  for (const child of root.children) matches.push(...findByAttribute(child, name, value));
  return matches;
}

/**
 * Read one element back as the fake the suite mounted.
 *
 * A port declares only the members the code under test writes -- `setAttribute` without
 * `getAttribute`, for instance -- so a case that reads back what was written needs the fake it
 * actually passed in. This narrows to it rather than casting.
 */
export function requireFakeElement(element: unknown, description: string): FakeElement {
  if (!(element instanceof FakeElement)) {
    throw new TypeError(`Expected ${description} to be a fake DOM element`);
  }
  return element;
}
