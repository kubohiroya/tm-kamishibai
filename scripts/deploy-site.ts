import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {restorePagesHistory} from './pages-history.ts';

interface DeploymentOptions {
  repo?: string;
  user?: {name: string; email: string};
}

interface PagesPublisher {
  publish(
    directory: string,
    options: DeploymentOptions & {
      history: boolean;
      beforeAdd: (git: {cwd: string}) => Promise<void>;
    },
    callback: (error?: Error) => void,
  ): Promise<unknown> | undefined;
}

/** Publish fresh site files while retaining the remote's immutable release artifacts. */
export async function deploySite(directory: string, options: DeploymentOptions = {}) {
  const publisher = createRequire(import.meta.url)('gh-pages') as PagesPublisher;
  const sourceDirectory = path.resolve(directory);
  await new Promise<void>((resolve, reject) => {
    const pending = publisher.publish(
      sourceDirectory,
      {
        ...options,
        history: true,
        async beforeAdd(git) {
          const retained = await restorePagesHistory(git.cwd, sourceDirectory);
          console.log(`Retained ${retained.length} published release files.`);
        },
      },
      (error) => (error ? reject(error) : resolve()),
    );
    pending?.catch(reject);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await deploySite(fileURLToPath(new URL('../site-dist/', import.meta.url)));
  console.log('Published GitHub Pages with release history preserved.');
}
