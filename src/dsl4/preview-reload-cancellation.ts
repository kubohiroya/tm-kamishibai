/** A closed reload owner cancelled work; driver and cleanup failures keep their own errors. */
export class Dsl4PreviewReloadDisposedError extends TypeError {
  constructor(owner: 'policy' | 'surface' | 'pipeline') {
    super(`reload ${owner} is disposed`);
    this.name = 'Dsl4PreviewReloadDisposedError';
  }
}
