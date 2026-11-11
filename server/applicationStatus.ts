import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import type { AppConfiguration, ApplicationStatus, ImportSource } from '../shared/desktop';
import { inspectLibrary } from './library';

type Issue = ApplicationStatus & { key: string };

// Availability checks only: never enumerate assets, create directories, or open media.
export class ApplicationMonitor {
    private pending?: Promise<ApplicationStatus>;
    private generation = 0;
    private reports = new Map<string, { issue: Issue; order: number }>();
    private order = 0;

    constructor(private configuration: () => Promise<AppConfiguration>, private sources: () => ImportSource[],
        private workError: () => string | undefined) {}

    invalidate() { this.generation++; this.pending = undefined; }

    private summarize(issues: Issue[]): ApplicationStatus {
        const next = new Map<string, { issue: Issue; order: number }>();
        for (const issue of issues) {
            const previous = this.reports.get(issue.key);
            next.set(issue.key, { issue, order: previous && JSON.stringify(previous.issue) === JSON.stringify(issue) ? previous.order : ++this.order });
        }
        this.reports = next;
        const highest = [...next.values()].sort((a, b) =>
            Number(b.issue.level === 'error') - Number(a.issue.level === 'error') || b.order - a.order)[0];
        if (!highest) return { level: 'ready', message: 'Ready' };
        const { key: _key, ...status } = highest.issue;
        return status;
    }

    private async check(generation: number): Promise<ApplicationStatus> {
        const issues: Issue[] = [];
        let configuration: AppConfiguration;
        try { configuration = await this.configuration(); }
        catch (error) {
            issues.push({ key: 'configuration', level: 'error', message: 'Configuration Error', detail: String(error) });
            return generation === this.generation ? this.summarize(issues) : { level: 'warning', message: 'Checking Status' };
        }
        const sources = this.sources();
        if (!configuration.libraryPath || !configuration.libraryMount) {
            issues.push({ key: 'configuration', level: 'error', message: 'Library Not Set', detail: 'Set and save a Library location in Configuration.' });
            return generation === this.generation ? this.summarize(issues) : { level: 'warning', message: 'Checking Status' };
        }
        const roots = sources.map(source => source.path);
        try {
            const location = await inspectLibrary(configuration.libraryPath, roots);
            if (location.mount !== configuration.libraryMount) throw new Error('The configured volume is not mounted at its expected location.');
            await access(location.path, constants.R_OK | constants.W_OK | constants.X_OK);
        } catch (error) {
            issues.push({ key: 'library', level: 'error', message: 'Library Unavailable', detail: error instanceof Error ? error.message : String(error) });
        }
        for (const source of sources) if (!source.available) issues.push({ key: `source:${source.id}`, level: 'warning', message: 'Source Unavailable', detail: `${source.name}: ${source.warning ?? source.path}` });
        const error = this.workError();
        if (error) issues.push({ key: 'work', level: 'warning', message: 'Proxy Unavailable', detail: error });
        return generation === this.generation ? this.summarize(issues) : { level: 'warning', message: 'Checking Status' };
    }

    async status(): Promise<ApplicationStatus> {
        if (!this.pending) {
            const pending = this.check(this.generation);
            this.pending = pending;
            void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([this.pending, new Promise<ApplicationStatus>(resolve => {
                timer = setTimeout(() => resolve({ level: 'warning', message: 'Locations Unverified', detail: 'Location checks are taking longer than expected.' }), 1500);
                timer.unref();
            })]);
        } finally { clearTimeout(timer); }
    }
}
