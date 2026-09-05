import type {Dirent, Stats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';

/**
 * The `node:fs/promises` surface the builder takes by injection.
 *
 * Every builder entry point accepts a `fileSystem` so the suites can substitute a fake, and the
 * production callers pass `node:fs/promises` itself. Only these four operations are used, and the
 * options each one is called with are fixed, so the signatures are narrower than the platform's
 * overloaded ones. Sites that need fewer operations name them with `Pick`, which keeps the
 * validation each entry point performs and its declared type in step.
 */
export interface Dsl4FileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: string): Promise<FileHandle>;
  readdir(path: string, options: {withFileTypes: true}): Promise<Dirent[]>;
}

/**
 * The `fs.watch` handle surface the preview watchers take by injection.
 *
 * Every change event reaches the watchers through the listener passed to the watch factory, so the
 * handle itself is only used to observe failures and to close the watch.
 */
export interface Dsl4FileWatcher {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  close(): void;
}
