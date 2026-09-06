import {spawn} from 'node:child_process';

import {Sb3BuilderError} from './errors.js';

export const defaultRsyncSshPort = 22;

const maximumProcessDiagnosticBytes = 16 * 1024;

function fail(message: string, code: string, cause?: unknown): never {
  throw new Sb3BuilderError(message, {stage: 'dsl4-asset-convert', code, cause});
}

export function normalizeRsyncDestination(value: unknown) {
  if (typeof value !== 'string') {
    fail('rsyncDestination must be a string', 'K4-ASSET-CONVERT-RSYNC-CONFIG-001');
  }
  const match =
    /^(?:(?<user>[A-Za-z0-9][A-Za-z0-9._-]*)@)?(?<host>[A-Za-z0-9][A-Za-z0-9._-]*):(?<remotePath>\/[A-Za-z0-9._/-]*)$/u.exec(
      value,
    );
  if (!match?.groups) {
    fail(
      'rsyncDestination must use the safe [user@]host:/absolute/path form',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  const remotePath = match.groups.remotePath ?? '';
  if (
    remotePath.includes('//') ||
    remotePath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    fail(
      'rsyncDestination path must not contain empty, dot, or parent segments',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  return value.endsWith('/') ? value : `${value}/`;
}

export function normalizeRemoteBaseUrl(value: unknown) {
  if (typeof value !== 'string') {
    fail('remoteBaseUrl must be a string', 'K4-ASSET-CONVERT-RSYNC-CONFIG-001');
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    fail('remoteBaseUrl is invalid', 'K4-ASSET-CONVERT-RSYNC-CONFIG-001', error);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/') ||
    url.href !== value
  ) {
    fail(
      'remoteBaseUrl must be a canonical HTTPS directory URL without credentials, query, or fragment',
      'K4-ASSET-CONVERT-RSYNC-CONFIG-001',
    );
  }
  return url;
}

export async function runRsyncProcess(command: {
  executable: string;
  arguments: string[];
  timeoutMs: number;
}) {
  await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let diagnostic = '';
    const child = spawn(command.executable, command.arguments, {
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(undefined);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, command.timeoutMs);
    timer.unref();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < maximumProcessDiagnosticBytes) {
        diagnostic += chunk.slice(0, maximumProcessDiagnosticBytes - diagnostic.length);
      }
    });
    child.once('error', (error) => {
      finish(
        new Sb3BuilderError('Cannot start rsync', {
          stage: 'dsl4-asset-convert',
          code: 'K4-ASSET-CONVERT-RSYNC-001',
          cause: error,
        }),
      );
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(
          new Sb3BuilderError('rsync timed out', {
            stage: 'dsl4-asset-convert',
            code: 'K4-ASSET-CONVERT-RSYNC-TIMEOUT-001',
          }),
        );
      } else if (code !== 0) {
        const suffix = diagnostic.trim() ? `: ${diagnostic.trim()}` : '';
        finish(
          new Sb3BuilderError(
            `rsync failed with ${signal ? `signal ${signal}` : `exit ${code}`}${suffix}`,
            {
              stage: 'dsl4-asset-convert',
              code: 'K4-ASSET-CONVERT-RSYNC-001',
            },
          ),
        );
      } else {
        finish();
      }
    });
  });
}
