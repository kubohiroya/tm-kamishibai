import {access} from 'node:fs/promises';

/**
 * Resolve one repository module path the way TypeScript does: a `.js` path also names the `.ts`
 * module that compiles to it. Contract tests identify modules, not source languages, so they keep
 * working while `src/` migrates file by file.
 *
 * @param {string} candidate
 * @returns {Promise<string>}
 */
export async function resolveModulePath(candidate) {
  try {
    await access(candidate);
    return candidate;
  } catch {
    const typescriptCandidate = candidate.replace(/\.js$/u, '.ts');
    await access(typescriptCandidate);
    return typescriptCandidate;
  }
}
