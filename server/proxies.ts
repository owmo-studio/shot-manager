import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setPriority } from 'node:os';
import { lstat, mkdir, readdir, realpath, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfiguration } from '../shared/desktop';
import type { IngestStatus } from '../shared/ingestion';
import type { VideoShot } from '../shared/shots';
import { inspectLibrary, libraryAssetName, libraryFileIdentity } from './library';
import type { LibraryLocation } from './library';
import { ShotScanner } from './scanner';
import { rename } from 'node:fs/promises';
import { inspectProxySource, verifyProxy } from './proxyMedia';
import { listReplacements } from './proxyReplacements';
import { proxyColorFilters } from './proxyColor';

export const scratchFolder = 'Shot Manager Cache';
export const minimumFreeBytes = 512 * 1024 * 1024;
const priorityInterruption = Symbol('commit-priority');
const pauseInterruption = Symbol('pause proxy queue');
export type Scratch = { location: LibraryLocation; directory: string; directoryIdentity: string };
export interface ReplacementJob { taskKey: string; shot: VideoShot; validate: () => Promise<void>; stage: (temporary: string, scratch: Scratch, signal: AbortSignal) => Promise<void> }
export type ProxyAsset = { path: string; identity: string; bytes: number; scratch: Scratch };

export async function inspectScratch(configuration: AppConfiguration, sources: string[], create = true): Promise<Scratch> {
    if (!configuration.scratchPath || !configuration.scratchMount) throw new Error('Managed Cache is unavailable.');
    const location = await inspectLibrary(configuration.scratchPath, [...sources, ...(configuration.libraryPath ? [configuration.libraryPath] : [])]);
    if (location.mount !== configuration.scratchMount) throw new Error('The configured Cache volume is not mounted at its expected location.');
    const root = join(location.path, scratchFolder);
    if (create) await mkdir(root, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(root) !== root) throw new Error('Cache storage must not be a symbolic link.');
    const directory = join(root, 'proxies');
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (await realpath(directory) !== directory) throw new Error('Cache proxy storage must not be a symbolic link.');
    const current = await inspectLibrary(location.path, sources);
    if (JSON.stringify(current) !== JSON.stringify(location)) throw new Error('Managed Cache location changed. Restart the app.');
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error('Cache proxy storage must be a directory.');
    return { location, directory, directoryIdentity: `${info.dev}:${info.ino}` };
}

// No viewing LUT or frame-rate conversion: preserve source timing and color interpretation.
export async function encodeProxy(input: string, output: string, shot: VideoShot, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
    signal.throwIfAborted();
    const source = await inspectProxySource(input, signal);
    signal.throwIfAborted();
    const color = source.color;
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-protocol_whitelist', 'file', '-threads', '2', '-i', input,
        '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-map_metadata:s:v:0', '0:s:v:0',
        '-copyts', '-start_at_zero', '-fps_mode', 'passthrough', '-filter_threads', '1',
        '-vf', proxyColorFilters(color).join(','),
        '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le', '-threads', '2', '-c:a', 'pcm_s24le'];
    args.push('-color_range', 'tv', '-color_primaries', color.primaries ?? 'unknown',
        '-color_trc', color.transfer ?? 'unknown', '-colorspace', color.matrix ?? 'unknown');
    for (const [key, value] of Object.entries(color.captureTags)) args.push('-metadata', `${key}=${value}`);
    if (source.variable) args.push('-enc_time_base:v', 'demux');
    if (source.timecode) args.push('-metadata:s:v:0', `timecode=${source.timecode}`, '-timecode', source.timecode);
    args.push('-write_tmcd', source.timecode ? '1' : '0');
    args.push('-movflags', Object.keys(color.captureTags).length ? '+write_colr+use_metadata_tags' : '+write_colr', '-progress', 'pipe:1', '-nostats', '-f', 'mov', output);
    await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        if (child.pid) { try { setPriority(child.pid, 10); } catch {} }
        let errors = '', tail = '';
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const stop = () => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1500); escalation.unref(); };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
        child.stdout.on('data', chunk => {
            tail += chunk;
            const lines = tail.split(/\r?\n/); tail = lines.pop()!.slice(-4096);
            for (const line of lines) {
                const match = /^out_time_us=(\d+)$/.exec(line);
                if (match && shot.durationSeconds) progress(Math.min(99, Math.floor(Number(match[1]) / (shot.durationSeconds * 1e6) * 100)));
            }
        });
        const finish = () => { signal.removeEventListener('abort', stop); clearTimeout(escalation); };
        child.once('error', error => { finish(); reject(error); });
        child.once('close', code => {
            finish();
            if (signal.aborted) reject(new Error('Proxy generation stopped.'));
            else if (code !== 0) reject(new Error(`Proxy encoding failed (${code}). ${errors.trim()}`));
            else resolve();
        });
    });
    await verifyProxy(output, source, signal);
}

export class ProxyQueue {
    onChange?: () => void;
    onError?: (shot: VideoShot, message: string) => void;
    private paused = false;
    private retainPending = false;
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private reconciling = false;
    private again = false;
    private scratch?: Scratch;
    private scratchKey = '';
    private reloadScratch = false;
    private ready = new Map<string, string>();
    private failed = new Map<string, string>();
    private replacements = new Map<string, ReplacementJob>();
    lastCompletedReplacement?: string;
    onReplacementChanged?: () => void;
    private priority = new Set<string>();
    private current?: { id: string; controller: AbortController; run: Promise<void>; percent: number; finishing: boolean };
    private listeners = new Set<() => void>();
    private queued = 0;
    private error?: string;
    private statusKey = '';

    constructor(private scanner: ShotScanner, private configuration: () => Promise<AppConfiguration>, private encode = encodeProxy) {
        scanner.requireProxy = true;
    }
    status(): NonNullable<IngestStatus['work']> {
        return { paused: this.paused, busy: !!this.current || this.queued > 0 || this.scanner.thumbnailsBusy(), encoding: !!this.current,
            queued: this.queued, scratchPath: this.scratch?.location.path ?? null, error: this.error,
            current: this.current ? { id: this.current.id, percent: this.current.percent } : undefined };
    }
    private changed() {
        for (const listener of [...this.listeners]) listener();
        const key = JSON.stringify(this.status());
        if (key !== this.statusKey) { this.statusKey = key; this.onChange?.(); }
    }
    schedule() {
        if (this.closed) return;
        if (this.reconciling) { this.again = true; return; }
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = undefined; void this.reconcile(); }, 50);
        this.timer.unref();
    }
    async validateScratch(expected: Scratch) {
        const current = await inspectScratch(await this.configuration(), this.scanner.mediaDirectories(), false);
        if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Cache location changed during proxy generation.');
    }
    async replacementInventory(location: LibraryLocation) {
        const configuration = await this.configuration();
        if (!configuration.scratchPath) return new Map<string, string>();
        const scratch = await inspectScratch(configuration, this.scanner.mediaDirectories());
        return listReplacements(scratch.directory, location);
    }
    async replacementScratch() {
        return inspectScratch(await this.configuration(), this.scanner.mediaDirectories());
    }
    enqueueReplacements(jobs: ReplacementJob[]) {
        if (this.closed || jobs.some(job => this.replacements.has(job.shot.id) || this.current?.id === job.shot.id)) {
            throw new Error('Selected clips are already encoding or the proxy queue is closing.');
        }
        this.scanner.lockLibraryCommit(jobs.map(job => job.shot.id), 'proxy');
        for (const job of jobs) this.replacements.set(job.shot.id, job);
        this.queued += jobs.length;
        this.onReplacementChanged?.(); this.changed(); this.schedule();
    }
    replacementProgress() {
        return [...this.replacements.values()].map(job => ({ key: job.taskKey, percent: this.current?.id === job.shot.id ? this.current.percent : 0 }));
    }
    private releaseReplacement(id: string) {
        if (this.replacements.delete(id)) this.scanner.unlockIngest([id]);
        this.onReplacementChanged?.();
    }
    private async reconcile() {
        this.reconciling = true;
        try {
            const configuration = await this.configuration();
            const key = JSON.stringify([configuration.scratchPath, configuration.scratchMount, configuration.libraryPath]);
            if (key !== this.scratchKey || this.reloadScratch) {
                if (this.current && key !== this.scratchKey) { this.current.controller.abort(); return; }
                // Keep completed outputs available to a concurrent Commit while refreshing.
                // An active encoder also publishes into this directory, so defer its rescan.
                if (!this.current) {
                    let nextScratch: Scratch | undefined;
                    const nextReady = new Map<string, string>();
                    if (configuration.scratchPath) {
                        nextScratch = await inspectScratch(configuration, this.scanner.mediaDirectories());
                        for (const entry of await readdir(nextScratch.directory, { withFileTypes: true })) {
                            const match = /^([a-f0-9]{64})\.proxy\.mov$/.exec(entry.name);
                            if (match && entry.isFile()) nextReady.set(match[1], join(nextScratch.directory, entry.name));
                        }
                    }
                    this.scratch = nextScratch; this.ready = nextReady; this.failed.clear();
                    this.scratchKey = key; this.reloadScratch = false; this.error = undefined;
                }
            }
            if (!this.scratch && this.replacements.size) throw new Error('Managed Cache is unavailable.');
            const shots = [...new Map(this.scanner.snapshot().shots.map(shot => [shot.id, shot])).values()];
            if (this.current && !this.replacements.has(this.current.id) && !shots.some(shot => shot.id === this.current!.id && !this.scanner.isEjecting(shot.id) && shot.available && (!shot.organization?.skipped || this.priority.has(shot.id)))) this.current.controller.abort();
            const candidates: VideoShot[] = [];
            for (const shot of shots) {
                if (this.scanner.isEjecting(shot.id)) continue;
                if (this.current?.id === shot.id || this.replacements.has(shot.id)) continue;
                const library = this.scanner.libraryProxy(shot.id);
                if (library === true) this.scanner.setProxy(shot.id, 'ready', undefined, undefined, 'library');
                else if (this.ready.has(shot.id)) this.scanner.setProxy(shot.id, 'ready', undefined, undefined, 'cache');
                else if (this.failed.has(shot.id)) this.scanner.setProxy(shot.id, 'failed', undefined, this.failed.get(shot.id));
                else if (library === null) this.scanner.setProxy(shot.id, 'unverified');
                else if ((this.paused && !this.retainPending) || !this.scratch || !shot.available || (shot.organization?.skipped && !this.priority.has(shot.id))) this.scanner.setProxy(shot.id, 'missing');
                else { this.scanner.setProxy(shot.id, 'queued'); candidates.push(shot); }
            }
            this.queued = candidates.length + this.replacements.size - Number(!!this.current && this.replacements.has(this.current.id));
            this.preemptBackground(candidates);
            if (!this.paused && !this.current && this.scratch && !this.scanner.thumbnailsBusy()) {
                const priority = candidates.find(shot => this.priority.has(shot.id) && shot.hasThumbnail);
                const replacement = priority ? undefined : this.replacements.values().next().value;
                const shot = priority ?? replacement?.shot ?? candidates.find(shot => shot.hasThumbnail);
                if (shot) {
                    const controller = new AbortController();
                    const current = { id: shot.id, controller, run: Promise.resolve(), percent: 0, finishing: false };
                    this.current = current;
                    if (replacement) this.onReplacementChanged?.();
                    else this.scanner.setProxy(shot.id, 'encoding', 0);
                    current.run = this.generate(shot, this.scratch, controller, replacement).finally(() => {
                        if (this.current === current) this.current = undefined;
                        this.changed(); this.schedule();
                    });
                }
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : 'Cache storage is unavailable.';
            this.queued = 0;
            for (const { shot } of this.replacements.values()) {
                if (shot.id === this.current?.id) continue;
                this.releaseReplacement(shot.id); this.onError?.(shot, this.error);
            }
        }
        finally { this.reconciling = false; this.changed(); if (this.again) { this.again = false; this.schedule(); } }
    }
    private async generate(shot: VideoShot, scratch: Scratch, controller: AbortController, replacement?: ReplacementJob) {
        const { signal } = controller;
        const temporary = join(scratch.directory, `${shot.id}.proxy.${randomUUID()}.partial`);
        const destination = join(scratch.directory, libraryAssetName(shot.id, 'proxy', 'mov'));
        let monitor: ReturnType<typeof setInterval> | undefined;
        let spaceError = false;
        try {
            await this.validateScratch(scratch);
            const free = await statfs(scratch.directory);
            if (free.bavail * free.bsize < minimumFreeBytes) throw new Error('Cache drive is low on free space. Free space, then resume Proxies.');
            if (replacement) await replacement.validate();
            const input = replacement ? { path: shot.filePath, shot, fileIdentity: '' } : await this.scanner.proxyInput(shot.id);
            signal.throwIfAborted();
            if (!replacement && await libraryFileIdentity(destination)) { this.ready.set(shot.id, destination); return; }
            monitor = setInterval(() => { void statfs(scratch.directory).then(info => {
                if (info.bavail * info.bsize < minimumFreeBytes) { spaceError = true; controller.abort(); }
            }).catch(() => controller.abort()); }, 1000);
            monitor.unref();
            await this.encode(input.path, temporary, input.shot, signal, percent => {
                if (signal.aborted || this.current?.controller !== controller) return;
                this.current.percent = Math.max(this.current.percent, Math.max(0, Math.min(99, percent)));
                if (replacement) { this.onReplacementChanged?.(); this.changed(); }
                else this.scanner.setProxy(shot.id, 'encoding', this.current.percent);
            });
            if (this.current?.controller === controller) this.current.finishing = true;
            if (replacement) {
                await replacement.stage(temporary, scratch, signal);
                this.lastCompletedReplacement = replacement.taskKey;
                return;
            }
            await this.scanner.validateIngest(shot.id, input.path, input.fileIdentity);
            await this.validateScratch(scratch);
            signal.throwIfAborted();
            if (await libraryFileIdentity(destination)) throw new Error('Cache proxy appeared during generation. Resume work to reuse it.');
            await rename(temporary, destination);
            this.ready.set(shot.id, destination);
            this.scanner.setProxy(shot.id, 'ready', undefined, undefined, 'cache');
        } catch (error) {
            if (!signal.aborted || spaceError) {
                const message = spaceError ? 'Cache drive is low on free space. Free space, then resume Proxies.' : error instanceof Error ? error.message : 'Proxy generation failed.';
                if (spaceError || message.includes('low on free space')) { this.paused = true; this.error = message; }
                if (!replacement) { this.failed.set(shot.id, message); this.scanner.setProxy(shot.id, 'failed', undefined, message); }
                this.onError?.(shot, message);
            } else if (!replacement) {
                const retry = signal.reason === pauseInterruption || signal.reason === priorityInterruption && !this.paused && !this.closed;
                this.scanner.setProxy(shot.id, retry ? 'queued' : 'missing', retry ? 0 : undefined);
            }
        } finally {
            if (replacement && !(signal.aborted && signal.reason === pauseInterruption && this.retainPending)) this.releaseReplacement(shot.id);
            clearInterval(monitor);
            // Never unlink through a missing/replaced mount or directory.
            await this.validateScratch(scratch).then(() => unlink(temporary)).catch(() => undefined);
        }
    }
    private preemptBackground(shots = this.scanner.snapshot().shots) {
        const current = this.current;
        if (!current || current.controller.signal.aborted || current.finishing || current.percent >= 20 ||
            this.replacements.has(current.id) || this.priority.has(current.id) || this.paused || this.closed || !this.scratch) return;
        const waiting = shots.some(shot => shot.id !== current.id && this.priority.has(shot.id) && shot.available &&
            shot.hasThumbnail && !this.scanner.isEjecting(shot.id) && this.scanner.libraryProxy(shot.id) === false &&
            !this.ready.has(shot.id) && !this.failed.has(shot.id));
        if (waiting) current.controller.abort(priorityInterruption);
    }
    prioritize(ids: string[]) { this.priority = new Set(ids); this.preemptBackground(); this.schedule(); }
    refresh() { this.reloadScratch = true; this.schedule(); }
    retry(ids: string[]) { ids.forEach(id => this.failed.delete(id)); this.schedule(); }
    async checkConfiguration(ids: string[]) {
        if (ids.some(id => this.scanner.libraryProxy(id) !== true)) await inspectScratch(await this.configuration(), this.scanner.mediaDirectories());
    }
    readyFor(id: string) {
        return this.scanner.libraryProxy(id) === true || this.ready.has(id) ||
            (!this.retainPending && (this.failed.has(id) || !!this.error));
    }
    async asset(id: string): Promise<ProxyAsset | null> {
        if (this.scanner.libraryProxy(id) === true) return null;
        if (this.failed.has(id)) throw new Error(this.failed.get(id));
        const path = this.ready.get(id);
        if (!path || !this.scratch) throw new Error(this.error ?? 'Managed Cache is unavailable.');
        await this.validateScratch(this.scratch);
        const identity = await libraryFileIdentity(path);
        if (!identity) { this.ready.delete(id); this.schedule(); throw new Error('Cache proxy was removed. Try Commit again.'); }
        return { path, identity, bytes: Number(identity.split(':')[2]), scratch: this.scratch };
    }
    async published(id: string, asset: ProxyAsset | null, libraryPath: string) {
        this.priority.delete(id);
        const path = asset?.path ?? this.ready.get(id);
        const scratch = asset?.scratch ?? this.scratch;
        if (path && scratch) {
            try {
                await this.validateScratch(scratch);
                const identity = await libraryFileIdentity(path);
                // Nested locations may put the managed scratch folder at the Library itself.
                // In that case this file is already the published Library asset.
                if (path !== join(libraryPath, libraryAssetName(id, 'proxy', 'mov')) && identity && (!asset || identity === asset.identity)) await unlink(path);
                this.ready.delete(id);
            } catch (error) { this.error = `Clip synced; Cache cleanup failed: ${error instanceof Error ? error.message : 'unknown error'}`; }
        }
        this.scanner.setProxy(id, 'ready', undefined, undefined, 'library'); this.changed(); this.schedule();
    }
    wait(signal: AbortSignal) {
        signal.throwIfAborted();
        return new Promise<void>((resolve, reject) => {
            const done = () => { this.listeners.delete(changed); signal.removeEventListener('abort', abort); };
            const changed = () => { done(); resolve(); };
            const abort = () => { done(); reject(new Error('Commit stopped.')); };
            this.listeners.add(changed); signal.addEventListener('abort', abort, { once: true });
        });
    }
    async stop(retainPending = false) {
        this.paused = true;
        this.retainPending ||= retainPending;
        if (!retainPending) { this.retainPending = false; this.priority.clear(); this.queued = 0;
            for (const id of this.replacements.keys()) if (id !== this.current?.id) this.releaseReplacement(id);
        }
        if (!this.current?.finishing) this.current?.controller.abort(retainPending ? pauseInterruption : undefined);
        await this.current?.run;
        this.schedule(); this.changed();
    }
    async cancel(ids: string[]) {
        for (const id of ids) { this.priority.delete(id); this.failed.delete(id); if (id !== this.current?.id && this.replacements.has(id)) this.releaseReplacement(id); }
        const current = this.current && ids.includes(this.current.id) ? this.current : undefined;
        current?.controller.abort();
        this.changed(); this.schedule();
        await current?.run;
        this.changed(); this.schedule();
    }
    resume() { this.paused = false; this.retainPending = false; this.failed.clear(); this.error = undefined; this.reloadScratch = true; this.schedule(); this.changed(); }
    async close() { await this.stop(); this.closed = true; clearTimeout(this.timer); }
}
