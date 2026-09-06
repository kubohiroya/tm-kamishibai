/**
 * The DOM surface the builder's preview shells take by injection.
 *
 * The shells build their own UI, but they are handed a document rather than reaching for the global
 * one, so the suites can drive them with a fake and the local preview host can mount them into a
 * page it controls. Each shell validates the document it is given before use; these types say what
 * that validation is checking for.
 *
 * They are narrower than the platform's `Document` and `HTMLElement` on purpose. A fake only has to
 * provide what is listed here, and listing it keeps the shells from drifting onto DOM APIs the
 * fakes do not implement.
 */
export interface Dsl4PreviewElement {
  id: string;
  textContent: string | null;
  hidden: boolean;
  tabIndex: number;
  /** Written a property at a time, the way the shells set inline layout. */
  style: Record<string, string>;
  /** Set on the input and button nodes the shells create, absent on the rest. */
  type?: string;
  disabled?: boolean;
  setAttribute(name: string, value: string): void;
  appendChild(child: Dsl4PreviewElement): unknown;
  append(...children: Dsl4PreviewElement[]): unknown;
  remove(): void;
  focus(): void;
  contains(other: unknown): boolean;
  /** The reload overlay's drag handle keeps the pointer while the panel is being moved. */
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
  addEventListener(type: string, listener: (event: never) => unknown, options?: unknown): unknown;
  removeEventListener(
    type: string,
    listener: (event: never) => unknown,
    options?: unknown,
  ): unknown;
}

export interface Dsl4PreviewDocument {
  createElement(tag: string): Dsl4PreviewElement;
  addEventListener(type: string, listener: (event: never) => unknown, options?: unknown): unknown;
  removeEventListener(
    type: string,
    listener: (event: never) => unknown,
    options?: unknown,
  ): unknown;
  readonly activeElement?: Dsl4PreviewElement | null;
}
