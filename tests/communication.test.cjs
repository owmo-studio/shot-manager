// Communication contracts only; no live app data, cards, or Library access.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
(async () => {
    const { build } = await import('vite');
    const entry = 'communication-fixture';
    const bundle = await build({ configFile: false, logLevel: 'silent', plugins: [{
        name: 'communication-fixture', resolveId(id) { if (id === entry) return '\0' + entry; },
        load(id) { if (id === '\0' + entry) return ['desktop/backendRequest.ts', 'shared/errors.ts', 'client/src/desktop.ts', 'client/src/collectionUpdates.ts']
            .map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n'); }
    }], build: { ssr: true, write: false, rollupOptions: { input: entry, output: { format: 'cjs' } } } });
    const loaded = new (require('node:module'))(__filename, module);
    loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
    const { requestBackend, AppError, errorDetails, initializeDesktop, CollectionUpdates } = loaded.exports;
    const request = (options, fetcher) => requestBackend('http://127.0.0.1:1234', 'dummy-token', '/fixture', options, fetcher, 5);
    await assert.rejects(request({method:'PATCH'}, async () => new Response(JSON.stringify({code:'STALE_REVIEW',message:'Review changed.'}), {status:409})),
        error => error instanceof AppError && error.status === 409 && error.code === 'STALE_REVIEW' && error.outcome === 'failed' && error.message === 'Review changed.');
    await assert.rejects(request({method:'PATCH'}, async () => { throw new Error('Connection lost'); }),
        error => error.code === 'MUTATION_OUTCOME_UNKNOWN' && error.outcome === 'unknown');
    await assert.rejects(request({method:'PATCH'}, async () => new Response('{"message":"Disk failure"}', {status:500})),
        error => error.outcome === 'unknown' && error.message.includes('Disk failure'));
    assert.deepEqual(await request({method:'PATCH'}, async (_url, options) => {
        assert.equal(options.signal, undefined, 'Mutations do not use a client deadline');
        assert.equal(options.headers.get('Authorization'), 'Bearer dummy-token');
        await new Promise(resolve => setTimeout(resolve, 20));
        return new Response('{"saved":true}');
    }), {saved:true}, 'A save can outlive the read deadline and still be acknowledged');
    await assert.rejects(request({}, async (_url, options) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('{}')), 50);
        options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, {once:true});
    })), error => error.code === 'READ_TIMEOUT' && error.outcome === 'failed');
    const details = errorDetails(new AppError('Review changed.', 'STALE_REVIEW', 'failed', 409));
    global.window = {desktopBridge: {getBackendStatus: async () => JSON.parse(JSON.stringify({ok:false,error:details}))}};
    try {
        initializeDesktop();
        await assert.rejects(window.desktop.getBackendStatus(), error => error instanceof AppError && error.code === 'STALE_REVIEW' && error.status === 409);
    } finally { delete global.window; }
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    let revision = 0, reads = 0, active = 0, maxActive = 0;
    const updates = new CollectionUpdates(async () => {
        reads++; active++; maxActive = Math.max(maxActive, active);
        const snapshotRevision = reads === 1 ? 100 : 200;
        await sleep(20); active--;
        return {revision:snapshotRevision,shots:[],scans:[]};
    }, collection => { revision = collection.revision; }, () => revision, 5);
    for (let i = 1; i <= 100; i++) updates.notify(i);
    await sleep(10);
    updates.notify(200);
    for (let i = 0; i < 100 && revision < 200; i++) await sleep(5);
    assert.equal(revision,200,'Notices arriving during a snapshot fetch are not lost');
    assert.equal(reads,2,'A burst of 101 notices needs two snapshot reads');
    assert.equal(maxActive,1,'Snapshot requests never overlap');
    revision = 300; updates.notify(300); await sleep(10);
    assert.equal(reads,2,'A mutation response that already supplied the revision needs no extra read');
    updates.notify(400); updates.dispose(); await sleep(10);
    assert.equal(reads,2,'Disposal cancels queued reads');
    console.log('PASS: structured IPC errors, read deadlines, acknowledged slow writes, and unknown mutation outcomes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
