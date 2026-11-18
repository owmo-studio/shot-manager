// Session task ledger checks; no media or filesystem access is required.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');

(async () => {
    const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
        ssr: true, write: false, rollupOptions: { input: resolve('server/queueProgress.ts'), output: { format: 'cjs' } },
    } });
    const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
    loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
    const { reconcileQueueTasks, summarizeQueueTasks } = loaded.exports;
    const previous = new Map([
        ['proxy:a', { kind: 'proxy', percent: 40 }],
        ['transfer:b', { kind: 'transfer', percent: 100 }],
    ]);
    const next = reconcileQueueTasks(previous, new Map([['proxy:a', { kind: 'proxy', percent: 60 }], ['sync:c', { kind: 'sync', percent: 25 }]]), new Set());
    assert.equal(next.get('proxy:a').percent, 60);
    assert.equal(next.has('transfer:b'), true, 'Completed work remains visible in the active session');
    assert.equal(next.get('sync:c').kind, 'sync');
    const completed = reconcileQueueTasks(next, new Map([['proxy:a', { kind: 'proxy', percent: 60 }], ['sync:c', { kind: 'sync', percent: 25 }]]), new Set(['proxy:a']));
    assert.equal(completed.get('proxy:a').percent, 100, 'Ready proxy publication completes the task');
    const summary = summarizeQueueTasks(completed);
    assert.deepEqual({ proxies: summary.proxiesRemaining, transfers: summary.transfersRemaining, syncs: summary.syncsRemaining }, { proxies: 0, transfers: 0, syncs: 1 });
    const finished = reconcileQueueTasks(completed, new Map([['proxy:a', { kind: 'proxy', percent: 100 }], ['sync:c', { kind: 'sync', percent: 100 }]]), new Set());
    const idle = reconcileQueueTasks(finished, new Map([['proxy:d', { kind: 'proxy', percent: 0 }]]), new Set());
    assert.deepEqual([...idle.keys()], ['proxy:d'], 'New work after an idle session starts a clean task list');
    console.log('PASS: queue task reconciliation, completion retention and summary counts.');
})().catch(error => { console.error(error); process.exitCode = 1; });
