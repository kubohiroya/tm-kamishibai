class FakeElement {
  constructor(document, tagName) {
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
    this.src = '';
    this.alt = '';
    this.style = {};
    this.dataset = {};
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    for (const child of children) this.appendChild(child);
  }

  after(child) {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, child);
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((value) => value !== listener),
    );
  }

  dispatch(type) {
    const event = createFakeEvent({code: '', target: this});
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return event;
  }

  contains(candidate) {
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

function createFakeEvent({code, target = null, shiftKey = false, modifiers = {}}) {
  return {
    code,
    target,
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
  const listeners = new Map();
  const document = {
    activeElement: null,
    createElement(tagName) {
      return new FakeElement(document, tagName);
    },
    addEventListener(type, listener) {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((value) => value !== listener),
      );
    },
    dispatchKey(code, options = {}) {
      const event = createFakeEvent({code, target: document.activeElement, ...options});
      for (const listener of listeners.get('keydown') ?? []) listener(event);
      return event;
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
  document.body = document.createElement('body');
  return document;
}

export function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findById(child, id);
    if (match) return match;
  }
  return null;
}

export function findByAttribute(root, name, value) {
  const matches = [];
  if (root.getAttribute(name) === value) matches.push(root);
  for (const child of root.children) matches.push(...findByAttribute(child, name, value));
  return matches;
}
