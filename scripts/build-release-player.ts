import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

/** Package the verified release SB3 as a standalone player, without an Editor toolbar. */
export async function buildReleasePlayer(sb3Path: string, outputPath: string) {
  const packagerModule = createRequire(import.meta.url)('@turbowarp/packager');
  const packager = new packagerModule.Packager();
  packager.project = await packagerModule.loadProject(await readFile(sb3Path));
  packager.options.autoplay = false;
  packager.options.app.title = 'TurboWarp紙芝居';
  const result = await packager.package();
  const bytes = Buffer.from(result.data);
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, bytes);
  return {
    outputPath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
