import { spawn } from 'node:child_process';

// Compatible with macOS's bundled rsync/openrsync; no shell or source deletion.
export function rsyncFile(source: string, destination: string, signal: AbortSignal, progress: (percent: number) => void, force = false): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/rsync', ['-t', '--progress', ...(force ? ['--ignore-times'] : []), '--', source, destination], {
            stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
        });
        let tail = '';
        let output = '';
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const stop = () => {
            child.kill('SIGTERM');
            escalation = setTimeout(() => child.kill('SIGKILL'), 1500);
            escalation.unref();
        };
        signal.addEventListener('abort', stop, { once: true });
        // Abort may occur between spawn and listener registration.
        if (signal.aborted) stop();
        child.stdout.on('data', chunk => {
            tail = (tail + chunk.toString()).slice(-4096);
            const matches = [...tail.matchAll(/(\d{1,3})%/g)];
            if (matches.length) progress(Math.min(100, Number(matches.at(-1)![1])));
            const boundary = Math.max(tail.lastIndexOf('\r'), tail.lastIndexOf('\n'));
            if (boundary >= 0) tail = tail.slice(boundary + 1);
        });
        child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-8000); });
        child.once('error', error => { signal.removeEventListener('abort', stop); clearTimeout(escalation); reject(error); });
        child.once('close', (code, killedBy) => {
            signal.removeEventListener('abort', stop);
            clearTimeout(escalation);
            if (signal.aborted) reject(new Error('Commit stopped.'));
            else if (code !== 0) reject(new Error(`rsync failed (${code ?? killedBy}). ${output.trim()}`));
            else { progress(100); resolve(); }
        });
    });
}
