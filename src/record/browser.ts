import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { RECORD_FPS, type VideoSize } from './options.js';

/**
 * The browser and ffmpeg, loaded only by `record`: puppeteer-core is an optional dependency and
 * imported on demand, ffmpeg comes from the PATH. `run`, `pay`, the MCP server and the CI runs never
 * touch this file, so they work without either.
 *
 * The types below are the slice of puppeteer this harness uses, written out so the build needs no
 * puppeteer either.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (event: never) => void): void;
  detach(): Promise<void>;
}

export interface BrowserPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  click(selector: string): Promise<void>;
  $eval<T>(selector: string, fn: (element: never) => T): Promise<T>;
  evaluate<T>(fn: (...args: never[]) => T, ...args: unknown[]): Promise<Awaited<T>>;
  waitForFunction(fn: (...args: never[]) => unknown, options?: Record<string, unknown>, ...args: unknown[]): Promise<unknown>;
  waitForNavigation(options?: Record<string, unknown>): Promise<unknown>;
  screenshot(options: { path: string; type?: 'png' }): Promise<unknown>;
  createCDPSession(): Promise<CdpSession>;
  emulateMediaFeatures(features: Array<{ name: string; value: string }>): Promise<void>;
  /** Runs the script in every document of the page before its own scripts. */
  evaluateOnNewDocument(script: string): Promise<unknown>;
  mainFrame(): unknown;
  on(event: 'framenavigated', handler: (frame: unknown) => void): void;
}

export interface Browser {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** CHROME as for the plugins' visitor.mjs, else the usual places. */
export function chromePath(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string {
  if (env.CHROME) {
    if (!exists(env.CHROME)) throw new Error(`record: CHROME=${env.CHROME} does not exist`);
    return env.CHROME;
  }
  const found = CHROME_CANDIDATES.find((path) => exists(path));
  if (!found) throw new Error('record: no Chrome found; set CHROME to the browser binary (as for the plugins\' visitor.mjs)');
  return found;
}

/** Fails with what to install when ffmpeg is not on the PATH. */
export async function requireFfmpeg(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = spawn('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    probe.on('error', () => reject(new Error('record: ffmpeg is not on the PATH (macOS: brew install ffmpeg; Debian/Ubuntu: apt-get install ffmpeg)')));
    probe.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`record: ffmpeg -version exited with ${code}`))));
  });
}

/**
 * A headless Chrome showing exactly the chosen size: no browser bar, no mouse pointer,
 * device scale factor 1, no scrollbars.
 */
export async function launchBrowser(size: VideoSize): Promise<Browser> {
  let puppeteer: { launch(options: Record<string, unknown>): Promise<Browser> };
  try {
    const module = (await import('puppeteer-core' as string)) as { default?: typeof puppeteer } & typeof puppeteer;
    puppeteer = module.default ?? module;
  } catch {
    throw new Error('record: puppeteer-core is not installed — it is an optional dependency of the harness; run `npm install` without --omit=optional');
  }
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: [`--window-size=${size.width},${size.height}`, '--hide-scrollbars', '--force-device-scale-factor=1', ...(process.env.CI ? ['--no-sandbox'] : [])],
    defaultViewport: { width: size.width, height: size.height, deviceScaleFactor: 1 },
  });
}

/**
 * The film: Chrome's screencast (a PNG whenever the page changes) fed to ffmpeg at a steady 25
 * frames a second. The latest frame is repeated until the next arrives, and the number of frames
 * written follows the wall clock, so a second in the video is a second in the shop — the moments
 * in recording.json line up with the picture.
 */
export class ScreenRecorder {
  private latest: Buffer | null = null;
  private written = 0;
  private timer: NodeJS.Timeout | null = null;
  private ffmpeg: ChildProcessWithoutNullStreams | null = null;
  private ffmpegError = '';
  private cdp: CdpSession | null = null;
  /** Milliseconds since the epoch of the first frame. */
  startedAt: number | null = null;

  constructor(private readonly page: BrowserPage, private readonly size: VideoSize, private readonly file: string) {}

  async start(): Promise<number> {
    const { width, height } = this.size;
    this.ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(RECORD_FPS), '-i', '-',
      '-vf', `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-r', String(RECORD_FPS),
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', this.file,
    ]);
    this.ffmpeg.stderr.on('data', (chunk: Buffer) => { this.ffmpegError += chunk.toString(); });
    this.ffmpeg.stdin.on('error', () => undefined);

    this.cdp = await this.page.createCDPSession();
    this.cdp.on('Page.screencastFrame', ((event: { data: string; sessionId: number }) => {
      this.latest = Buffer.from(event.data, 'base64');
      void this.cdp?.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
    }) as (event: never) => void);
    await this.cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: width, maxHeight: height });
    // Wait for Chrome's first frame: until then there is nothing to show.
    const deadline = Date.now() + 10_000;
    while (!this.latest) {
      if (Date.now() > deadline) throw new Error('record: the browser sent no frame within 10 s');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.startedAt = Date.now();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000 / RECORD_FPS / 2);
    return this.startedAt;
  }

  private tick(): void {
    if (!this.ffmpeg || !this.latest || this.startedAt === null) return;
    const due = Math.floor(((Date.now() - this.startedAt) * RECORD_FPS) / 1000) + 1;
    while (this.written < due) {
      this.ffmpeg.stdin.write(this.latest);
      this.written++;
    }
  }

  /** Stops filming and waits for ffmpeg to finish the file. Returns the last frame's time. */
  async stop(): Promise<number> {
    this.tick();
    const end = Date.now();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.cdp?.send('Page.stopScreencast').catch(() => undefined);
    await this.cdp?.detach().catch(() => undefined);
    const ffmpeg = this.ffmpeg;
    if (!ffmpeg) return end;
    await new Promise<void>((resolve, reject) => {
      ffmpeg.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`record: ffmpeg exited with ${code}: ${this.ffmpegError.trim().slice(0, 500)}`))));
      ffmpeg.stdin.end();
    });
    return end;
  }
}
