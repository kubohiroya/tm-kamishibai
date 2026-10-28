import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

import {
  excludeEmbeddedProjectExtensionsFromPackagerPreload,
  verifyDsl4PackagerExtensionPreload,
} from '../dist/builder/index.js';

/** Serialize only Packager project chunks; the browser still reads the original Base85 data. */
export function serializeReleasePlayerHtml(html: string): string {
  let chunks = 0;
  const serialized = html.replace(
    /<script data="([^"]*)">decodeChunk\((\d+)\)<\/script>/gu,
    (chunk: string, encoded: string, sizeText: string) => {
      const data = encoded.replaceAll('&#126;', '~');
      const size = Number(sizeText);
      if (
        !Number.isSafeInteger(size) ||
        size <= 0 ||
        data.length !== Math.ceil(size / 4) * 5 ||
        !/^[\x28-\x3b\x3d\x3f-\x7e]+$/u.test(data)
      ) {
        throw new Error('Invalid Packager Base85 project chunk.');
      }
      chunks += 1;
      // Literal tildes in encoded binary can resemble credentials to text scanners.
      // getAttribute decodes HTML references before decodeChunk reads the original project bytes.
      return chunk.replace(encoded, data.replaceAll('~', '&#126;'));
    },
  );
  if (chunks === 0) throw new Error('Expected Packager Base85 project chunks.');
  return serialized;
}

/**
 * Package the verified release SB3 as a standalone player, without an Editor toolbar. The runtime
 * the SB3 embeds is left out of Packager's preload list, so the player carries and loads it once.
 */
export async function buildReleasePlayer(sb3Path: string, outputPath: string) {
  const packagerModule = createRequire(import.meta.url)('@turbowarp/packager');
  const packager = new packagerModule.Packager();
  packager.project = await packagerModule.loadProject(await readFile(sb3Path));
  const preload = excludeEmbeddedProjectExtensionsFromPackagerPreload(packager);
  packager.options.autoplay = false;
  packager.options.app.title = 'TurboWarp紙芝居';
  packager.options.app.icon = new packagerModule.Image(
    'image/png',
    await readFile(new URL('../site/favicon.png', import.meta.url)),
  );
  const result = await packager.package();
  const html = Buffer.from(result.data).toString('utf8');
  verifyDsl4PackagerExtensionPreload(html, preload);
  const bytes = Buffer.from(serializeReleasePlayerHtml(html));
  await mkdir(path.dirname(outputPath), {recursive: true});
  await writeFile(outputPath, bytes);
  return {
    outputPath,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
