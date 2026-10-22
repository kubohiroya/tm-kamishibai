import assert from 'node:assert/strict';
import {appendFile, mkdir, readFile, writeFile, access, mkdtemp} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {chromium} from 'playwright-core';
import type {Browser, BrowserContext, Page} from 'playwright-core';
import {installAudit} from './video-listening-audit.ts';

/** Reject malformed protocol or saved-result data at the tooling boundary. */
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

/** Check only human reports; native media observations never create a listening answer. */
export function verifySpeakerResult(value: unknown) {
  const result = record(value);
  assert.equal(result.listenerEventTrusted, true);
  assert(
    ['heard-and-stopped', 'failed-listening', 'not-checked', 'end-session'].includes(
      String(result.listenerResult),
    ),
  );
  if (result.listenerResult !== 'heard-and-stopped') return;
  assert.equal(result.outcome, 'completed');
  const start = record(result.startReport);
  assert.equal(start.trusted, true);
  assert.equal(start.activation, true);
  const playing = record(result.playing);
  assert(Array.isArray(playing.videos) && playing.videos.length === 2);
  for (const item of playing.videos) {
    const video = record(item);
    assert.equal(video.width, 160);
    assert(Number(video.currentTime) > 1 && Number(video.frames) > 0);
    assert.equal(video.paused, false);
  }
  const front = record(playing.videos[0]);
  assert.equal(front.muted, false);
  assert.equal(front.volume, 0.35);
  const stopped = record(result.stopped);
  assert(Array.isArray(stopped.videos) && stopped.videos.length === 2);
  for (const item of stopped.videos) {
    assert.equal(record(item).paused, true);
    assert.equal(record(item).src, null);
  }
  assert.deepEqual(result.errors, []);
}

/** Run an opt-in, interactive audit with caller-supplied fixtures and isolated browser profiles. */
export async function runSpeakerListening(arguments_: string[]) {
  const {values} = parseArgs({
    args: arguments_,
    options: {
      browser: {type: 'string', default: 'chrome'},
      'fixture-dir': {type: 'string'},
      'output-dir': {type: 'string'},
      executable: {type: 'string'},
      'webdriver-url': {type: 'string', default: 'http://127.0.0.1:8861'},
      surfaces: {type: 'string', default: 'editor,player,packager'},
      formats: {type: 'string', default: 'webm,mp4'},
      resume: {type: 'string'},
      skip: {type: 'string', default: ''},
      help: {type: 'boolean'},
    },
  });
  if (values.help) {
    console.log(
      'node scripts/manual/video-listening.ts --browser chrome|edge|firefox --executable PATH --fixture-dir DIR [--output-dir DIR] [--resume RESULTS.json] [--surfaces player] [--formats webm,mp4] [--skip CASE_ID,...]',
    );
    return;
  }
  const name = values.browser;
  assert(['chrome', 'edge', 'firefox'].includes(name));
  assert(values['fixture-dir'], '--fixture-dir is required (see docs/testing/video-listening.md)');
  const executable =
    values.executable ??
    (name === 'chrome'
      ? process.env.CHROME_BIN
      : name === 'edge'
        ? process.env.EDGE_BIN
        : process.env.FIREFOX_BIN);
  assert(executable, '--executable or the corresponding *_BIN environment variable is required');
  const fixtures = path.resolve(values['fixture-dir']);
  const surfaces = values.surfaces.split(',');
  const formats = values.formats.split(',');
  assert(
    surfaces.length > 0 && surfaces.every((s) => ['editor', 'player', 'packager'].includes(s)),
  );
  assert(formats.length > 0 && formats.every((f) => ['webm', 'mp4'].includes(f)));
  assert.equal(new Set(surfaces).size, surfaces.length);
  assert.equal(new Set(formats).size, formats.length);
  // Validate every input before starting a browser or accepting a human answer.
  for (const format of formats) {
    await access(path.join(fixtures, `${format}-audible.sb3`));
    if (surfaces.includes('packager')) await access(path.join(fixtures, `${format}-audible.html`));
  }
  await mkdir(path.resolve('tmp'), {recursive: true});
  const output = values['output-dir']
    ? path.resolve(values['output-dir'])
    : await mkdtemp(path.resolve('tmp/video-listening-'));
  await mkdir(output, {recursive: true});
  const resultFile = path.join(output, `${name}-results.json`);
  const results: Record<string, unknown>[] = values.resume
    ? await readFile(path.resolve(values.resume), 'utf8').then((text) => {
        const rows: unknown = JSON.parse(text);
        assert(Array.isArray(rows));
        return rows.map((row) => {
          const r = record(row);
          assert.equal(r.browserName, name);
          verifySpeakerResult(r);
          assert.equal(r.pass, true);
          assert.equal(typeof r.caseId, 'string');
          return r;
        });
      })
    : [];
  // Never overwrite previous reports implicitly, even when resuming into a new output directory.
  await writeFile(resultFile, JSON.stringify(results, null, 2) + '\n', {flag: 'wx'});
  const allowed = new Set(formats.map((f) => `${f}-audible.html`));
  const server = createServer(async (request, response) => {
    try {
      const filename = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
      if (!allowed.has(filename)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(await readFile(path.join(fixtures, filename)));
    } catch {
      response.writeHead(404).end();
    }
  });
  let browser: Browser | undefined;
  let session: string | undefined;
  let socket: WebSocket | undefined;
  let writes = Promise.resolve();
  let writeError: unknown;
  const save = (file: string, payload: unknown) => {
    writes = writes
      .then(() => appendFile(path.join(output, file), JSON.stringify(payload) + '\n'))
      .catch((error) => {
        writeError = error;
      });
    return writes;
  };
  async function wd(method: string, suffix: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${values['webdriver-url']}${suffix}`, {
      method,
      headers: {'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      signal: AbortSignal.timeout(60_000),
    });
    const data = record(await response.json());
    const value = data.value;
    if (!response.ok || (value && typeof value === 'object' && 'error' in value))
      throw new Error(JSON.stringify(value));
    return value;
  }
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    if (name !== 'firefox')
      browser = await chromium.launch({executablePath: executable, headless: false});
    const skipped = new Set(values.skip.split(','));
    const caseIds = surfaces.flatMap((surface) =>
      formats.map((format) => `${name}-${surface}-${format}-audible`),
    );
    cases: for (const surface of surfaces)
      for (const format of formats) {
        const caseId = `${name}-${surface}-${format}-audible`;
        if (skipped.has(caseId) || results.some((row) => row.caseId === caseId)) continue;
        const fixture = await readFile(path.join(fixtures, `${format}-audible.sb3`));
        const fixtureUrl = `https://kubohiroya.github.io/turbowarp-extension-data-editor/__video_audit_fixture__/${format}-audible.sb3`;
        const url =
          surface === 'packager'
            ? `http://127.0.0.1:${address.port}/${format}-audible.html`
            : `https://kubohiroya.github.io/turbowarp-extension-data-editor/${surface}.html?lang=en&project_url=${encodeURIComponent(fixtureUrl)}`;
        const source = `(${installAudit.toString()})(${JSON.stringify({caseId, label: `${name} / ${surface} / ${format}`, index: caseIds.indexOf(caseId) + 1, total: surfaces.length * formats.length})});`;
        const result: Record<string, unknown> = {
          caseId,
          browserName: name,
          surface,
          key: `${format}-audible`,
          headless: false,
          platform: `${os.platform()} ${os.release()} ${os.arch()}`,
          url,
          fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
          fixtureRequests: 0,
        };
        let context: BrowserContext | undefined;
        let page: Page | undefined;
        let done: unknown;
        let protocolError: unknown;
        const receiveLog = (text: string) => {
          if (text.startsWith('VIDEO_LISTENING_INPUT:'))
            void save(
              `${name}-input-events.jsonl`,
              JSON.parse(text.slice('VIDEO_LISTENING_INPUT:'.length)),
            );
          else if (text.startsWith('VIDEO_LISTENING_STAGE:')) console.log(text);
        };
        console.log(`begin ${caseId}; output: ${output}`);
        try {
          if (browser) {
            result.browser = browser.version();
            context = await browser.newContext({
              viewport: {width: 1100, height: 720},
              locale: 'en-US',
              serviceWorkers: 'block',
            });
            await context.route(fixtureUrl, async (route) => {
              result.fixtureRequests = Number(result.fixtureRequests) + 1;
              await route.fulfill({body: fixture, contentType: 'application/octet-stream'});
            });
            await context.exposeBinding(
              '__recordSpeakerOutcome',
              async (_source, payload: unknown) => {
                assert.equal(record(payload).caseId, caseId);
                await save(`${name}-accepted-feedback.jsonl`, payload);
                if (writeError) throw writeError;
                done = payload;
                return {saved: true};
              },
            );
            await context.addInitScript({content: source});
            page = await context.newPage();
            page.on('console', (message) => receiveLog(message.text()));
            page.on('close', () => {
              done ??= {
                caseId,
                listenerResult: 'not-checked',
                listenerEventTrusted: false,
                outcome: 'window-closed',
              };
            });
            await page.goto(url);
          } else {
            const created = record(
              await wd('POST', '/session', {
                capabilities: {
                  alwaysMatch: {
                    browserName: 'firefox',
                    webSocketUrl: true,
                    'moz:firefoxOptions': {binary: executable},
                  },
                },
              }),
            );
            assert(typeof created.sessionId === 'string');
            session = created.sessionId;
            const caps = record(created.capabilities);
            result.browser = caps.browserVersion;
            assert(typeof caps.webSocketUrl === 'string');
            const topContext = await wd('GET', `/session/${session}/window`);
            await wd('POST', `/session/${session}/window/rect`, {width: 1100, height: 720});
            socket = new WebSocket(caps.webSocketUrl);
            const activeSocket = socket;
            await new Promise<void>((resolve, reject) => {
              const timeout = setTimeout(
                () => reject(new Error('Firefox connection timed out')),
                15_000,
              );
              activeSocket.addEventListener(
                'open',
                () => {
                  clearTimeout(timeout);
                  resolve();
                },
                {once: true},
              );
              activeSocket.addEventListener(
                'error',
                (event) => {
                  clearTimeout(timeout);
                  reject(event);
                },
                {once: true},
              );
            });
            let next = 0;
            const pending = new Map<
              number,
              {resolve: (value: unknown) => void; reject: (error: Error) => void}
            >();
            const send = (method: string, params: unknown) =>
              new Promise<unknown>((resolve, reject) => {
                const id = ++next;
                const timeout = setTimeout(() => {
                  pending.delete(id);
                  reject(new Error(`Firefox protocol timeout: ${method}`));
                }, 60_000);
                pending.set(id, {
                  resolve(value) {
                    clearTimeout(timeout);
                    resolve(value);
                  },
                  reject(error) {
                    clearTimeout(timeout);
                    reject(error);
                  },
                });
                activeSocket.send(JSON.stringify({id, method, params}));
              });
            activeSocket.addEventListener('close', () => {
              for (const request of pending.values())
                request.reject(new Error('Firefox connection closed'));
              pending.clear();
              done ??= {
                caseId,
                listenerResult: 'not-checked',
                listenerEventTrusted: false,
                outcome: 'window-closed',
              };
            });
            activeSocket.addEventListener('message', (event) => {
              try {
                const message = record(JSON.parse(String(event.data)));
                if (typeof message.id === 'number') {
                  const request = pending.get(message.id);
                  pending.delete(message.id);
                  if (message.type === 'error') request?.reject(new Error(JSON.stringify(message)));
                  else request?.resolve(message.result);
                  return;
                }
                const params = record(message.params);
                if (message.method === 'log.entryAdded' && typeof params.text === 'string')
                  receiveLog(params.text);
                if (
                  message.method === 'browsingContext.contextDestroyed' &&
                  params.context === topContext
                )
                  done ??= {
                    caseId,
                    listenerResult: 'not-checked',
                    listenerEventTrusted: false,
                    outcome: 'window-closed',
                  };
                if (message.method === 'script.message' && params.channel === caseId) {
                  const payload: unknown = JSON.parse(String(record(params.data).value));
                  assert.equal(record(payload).caseId, caseId);
                  void save(`${name}-accepted-feedback.jsonl`, payload).then(() => {
                    done = payload;
                  });
                }
                if (
                  message.method === 'network.beforeRequestSent' &&
                  params.isBlocked &&
                  record(params.request).url === fixtureUrl
                ) {
                  result.fixtureRequests = Number(result.fixtureRequests) + 1;
                  void send('network.provideResponse', {
                    request: record(params.request).request,
                    statusCode: 200,
                    headers: [
                      {
                        name: 'Content-Type',
                        value: {type: 'string', value: 'application/octet-stream'},
                      },
                    ],
                    body: {type: 'base64', value: fixture.toString('base64')},
                  }).catch((error) => {
                    protocolError = error;
                  });
                }
              } catch (error) {
                protocolError = error;
              }
            });
            await send('session.subscribe', {
              events: [
                'log.entryAdded',
                'network.beforeRequestSent',
                'script.message',
                'browsingContext.contextDestroyed',
              ],
            });
            await send('network.addIntercept', {
              phases: ['beforeRequestSent'],
              urlPatterns: [{type: 'string', pattern: fixtureUrl}],
            });
            await send('script.addPreloadScript', {
              functionDeclaration: `function(report){globalThis.__recordSpeakerOutcome=payload=>{report(JSON.stringify(payload));return Promise.resolve({sent:true});};${source}}`,
              arguments: [{type: 'channel', value: {channel: caseId}}],
            });
            await wd('POST', `/session/${session}/url`, {url});
          }
          // Human input has no timeout. A closed window is recorded as unconfirmed.
          while (done === undefined) {
            if (writeError) throw writeError;
            if (protocolError) throw protocolError;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          if (writeError) throw writeError;
          Object.assign(result, record(done));
          assert.equal(result.fixtureRequests, surface === 'packager' ? 0 : 1);
          verifySpeakerResult(result);
          result.pass = true;
        } catch (error) {
          result.pass = false;
          result.failure = String(error instanceof Error ? error.stack : error);
        } finally {
          if (page)
            await page.screenshot({path: path.join(output, caseId + '.png')}).catch(() => {});
          await context?.close();
          if (session) {
            const png = await wd('GET', `/session/${session}/screenshot`).catch(() => null);
            if (typeof png === 'string')
              await writeFile(path.join(output, caseId + '.png'), Buffer.from(png, 'base64'));
            socket?.close();
            await wd('DELETE', `/session/${session}`).catch(() => {});
            session = undefined;
          }
          await writes;
        }
        results.push(result);
        await writeFile(resultFile, JSON.stringify(results, null, 2) + '\n');
        console.log(
          JSON.stringify({
            caseId,
            pass: result.pass,
            listenerResult: result.listenerResult,
            failure: result.failure,
          }),
        );
        if (!result.pass || result.listenerResult === 'end-session') break cases;
      }
  } finally {
    await browser?.close();
    socket?.close();
    if (session) await wd('DELETE', `/session/${session}`).catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writes;
  }
  if (writeError) throw writeError;
  if (results.some((row) => !row.pass)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSpeakerListening(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
