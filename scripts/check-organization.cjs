// Local drafts and authenticated API checks against temporary dummy sources only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

(async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'shot-organize-check-')));
    let server;
    try {
        const entry = join(root, 'fixture.ts');
        await fs.writeFile(entry, [
            `export * from ${JSON.stringify(join(__dirname, '../server/organization.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../shared/organization.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../server/app.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../server/thumbnails.ts'))};`,
            `export * from ${JSON.stringify(join(__dirname, '../desktop/writeQueue.ts'))};`,
        ].join('\n'));
        const { build } = await import('vite');
        const bundle = await build({ configFile: false, logLevel: 'silent', build: { ssr: true, write: false,
            rollupOptions: { input: entry, external: ['fastify'], output: { format: 'cjs' } } } });
        const Module = require('node:module');
        const loaded = new Module(__filename, module); loaded.paths = module.paths;
        loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
        const { OrganizationStore, normalizeTag, organizationKey, emptyOrganization, emptyVocabulary, normalizeOption, createServer, pruneThumbnailCache, DEFAULT_THUMBNAIL_CACHE_EXPIRY_DAYS, WriteQueue, DebouncedWrites } = loaded.exports;
        const file = join(root, 'state', 'organization.json');
        let now = Date.now();
        const day = 86400000;
        const fp = value => ({ algorithm: 'sha256', scheme: 'sampled-sha256-v1', value: value.repeat(64), fileSize: 10, sampleBytes: 262144, sampledBytes: 10 });
        const a = fp('a'), b = fp('b'), c = fp('c');
        const signal = new AbortController().signal;
        const store = new OrganizationStore(file, () => now);
        const edit = (targets, field, operation, value, valid = () => true) => store.update(targets, { field, operation, value }, valid);
        assert.equal(normalizeTag('MuSiC/EDM'), 'music/edm');
        for (const invalid of ['music//rock', '/music', 'music/', 'two words', 'a'.repeat(65), '']) assert.throws(() => normalizeTag(invalid));
        await Promise.all([store.scanned(a, signal), store.scanned(b, signal), store.scanned(c, signal)]);
        await edit([a], 'projects', 'add', 'ALPHA');
        await edit([b], 'projects', 'add', 'beta');
        let result = await edit([a, b], 'projects', 'add', 'shared');
        assert.deepEqual(result.drafts[organizationKey(a)].projects, ['shared']);
        assert.deepEqual(result.drafts[organizationKey(b)].projects, ['shared']);
        result = await edit([a, b], 'projects', 'remove', 'shared');
        assert.deepEqual(result.drafts[organizationKey(a)].projects, []);
        assert.deepEqual(result.drafts[organizationKey(b)].projects, []);
        assert.ok(result.vocabulary.projects.includes('shared'), 'Removing a chip never deletes vocabulary');
        await edit([a], 'identity', 'add', 'owmo');
        result = await edit([a, b], 'identity', 'add', 'CMSH');
        assert.equal(result.drafts[organizationKey(a)].identity, 'CMSH');
        assert.equal(result.drafts[organizationKey(b)].identity, 'CMSH');
        await Promise.all([edit([a], 'context', 'add', 'music/rock'), edit([a], 'context', 'add', 'studio')]);
        await edit([a], 'notes', 'set', 'Keep this take');
        const restored = await new OrganizationStore(file, () => now).scanned(a, signal);
        assert.deepEqual(restored.context, ['music/rock', 'studio']);
        assert.equal(restored.notes, 'Keep this take');
        assert.equal(normalizeOption('  World   Building  '), 'World Building');
        await edit([b], 'identity', 'add', 'Client Name');
        await edit([b], 'projects', 'add', 'World Building');
        assert.equal((await store.scanned(b, signal)).identity, 'Client Name');
        assert.deepEqual((await store.scanned(b, signal)).projects, ['World Building']);
        await edit([a], 'context', 'add', 'accidental');
        await edit([a], 'context', 'remove', 'accidental');
        const draftsBeforeRemoval = JSON.parse(await fs.readFile(file, 'utf8')).drafts;
        await store.removeOptions({identity:['CMSH'],projects:['shared'],context:['music/rock','accidental']});
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).drafts, draftsBeforeRemoval, 'Removing options preserves records and retention timestamps');
        assert.ok(!(await store.vocabulary()).context.includes('music/rock'));
        await store.scanned(a, signal);
        assert.ok((await store.vocabulary()).context.includes('music/rock'), 'Used options return on scan');
        assert.ok(!(await store.vocabulary()).context.includes('accidental'), 'Unused accidental options stay removed');
        const beforeInvalidRemoval = await fs.readFile(file, 'utf8');
        await assert.rejects(store.removeOptions({identity:[],projects:[],context:['bad//tag']}));
        assert.equal(await fs.readFile(file, 'utf8'), beforeInvalidRemoval);
        const beforeOptionsClear = JSON.parse(await fs.readFile(file, 'utf8')).drafts;
        await store.clearOptions();
        assert.deepEqual(await store.vocabulary(), emptyVocabulary());
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).drafts, beforeOptionsClear, 'Local list clearing preserves every saved clip record');
        await store.scanned(a, signal);
        assert.ok((await store.vocabulary()).context.includes('music/rock'), 'Scan rebuilds Context from retained clip information');
        await store.scanned(b, signal);
        assert.ok((await store.vocabulary()).identity.includes('Client Name'));
        assert.ok((await store.vocabulary()).projects.includes('World Building'));
        const oldFile = join(root, 'legacy-organization.json');
        await fs.writeFile(oldFile, JSON.stringify({ version: 1, vocabulary: { identity: [], projects: ['alpha', 'beta'], context: [], colors: { alpha: 20, beta: 20.001 } },
            drafts: { [organizationKey(a)]: { data: { ...emptyOrganization(), projects: ['alpha', 'beta'] }, lastScannedAt: now, lastEditedAt: now } } }));
        assert.deepEqual((await new OrganizationStore(oldFile, () => now).scanned(a, signal)).projects, ['alpha']);
        const migrated = JSON.parse(await fs.readFile(oldFile, 'utf8'));
        assert.equal(migrated.version, 3);
        assert.equal(Object.hasOwn(migrated.vocabulary, 'colors'), false);
        assert.equal(Object.hasOwn(migrated.vocabulary, 'colorVersion'), false);
        assert.deepEqual(migrated.drafts[organizationKey(a)].previousProjects, ['alpha', 'beta'], 'Migration preserves prior project assignments in retained record');
        const acceptedWrites = new WriteQueue();
        const saves = ['K', 'Keep', 'Keep this take'].map(value => acceptedWrites.run(async () => {
            await new Promise(resolve => setTimeout(resolve, 2));
            return edit([a], 'notes', 'set', value);
        }));
        await acceptedWrites.drain();
        await Promise.all(saves);
        assert.equal((await new OrganizationStore(file, () => now).scanned(a, signal)).notes, 'Keep this take', 'Accepted keystrokes drain in order independently of the renderer');
        const debounced = new DebouncedWrites(acceptedWrites, 25);
        let noteSaves = 0;
        const bursts = ['K', 'Keep', 'Keep this take'].map(value => debounced.schedule('clip-a', async () => {
            noteSaves++;
            await edit([a], 'notes', 'set', value);
            return value;
        }));
        assert.equal(noteSaves, 0);
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.deepEqual(await Promise.all(bursts), ['Keep this take','Keep this take','Keep this take']);
        assert.equal(noteSaves, 1, 'A typing burst produces one durable Notes save');
        const order = [];
        const firstSelection = debounced.schedule('clip-a', async () => { order.push('a'); return 1; });
        const secondSelection = debounced.schedule('clip-b', async () => { order.push('b'); return 2; });
        await debounced.flush();
        await Promise.all([firstSelection, secondSelection]);
        assert.deepEqual(order, ['a','b'], 'Selection changes and explicit flush retain pending notes in order');
        const failed = debounced.schedule('clip-a', async () => { throw new Error('Synthetic note write failure'); });
        const rejected = assert.rejects(failed, /Synthetic note write failure/);
        await debounced.flush(); await rejected;
        const retry = debounced.schedule('clip-a', async () => 'retried');
        await debounced.flush(); assert.equal(await retry, 'retried');
        let validationCalls = 0;
        const beforeFailure = await fs.readFile(file, 'utf8');
        await assert.rejects(edit([a, b], 'context', 'add', 'must-not-save', () => ++validationCalls < 3), /locked/);
        assert.equal(await fs.readFile(file, 'utf8'), beforeFailure, 'Failed batch preserves all drafts and vocabulary');
        assert.deepEqual(await fs.readdir(join(root, 'state')), ['organization.json']);
        await assert.rejects(store.scanned(a, AbortSignal.abort()));
        assert.equal(await fs.readFile(file, 'utf8'), beforeFailure);
        now += 89 * day;
        await store.scanned(a, signal);
        now += 2 * day;
        await store.scanned(c, signal); // An expired returning source renews before cleanup.
        assert.equal(await store.prune(), 1);
        assert.equal((await store.scanned(a, signal)).notes, 'Keep this take');
        assert.deepEqual(await store.scanned(b, signal), emptyOrganization(), 'Unrenewed expired draft is removed');
        assert.ok((await store.vocabulary()).projects.includes('World Building'), 'Options do not expire with clip drafts');
        const corruptPath = join(root, 'broken.json');
        await fs.writeFile(corruptPath, '{broken');
        await assert.rejects(new OrganizationStore(corruptPath).scanned(a, signal), /preserved/);
        assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken');

        const cache = join(root, 'thumbnails');
        await fs.mkdir(cache);
        const thumbnail = join(cache, `${'a'.repeat(64)}.jpg`);
        await fs.writeFile(thumbnail, 'image');
        const aged = new Date(Date.now() - 91 * day); await fs.utimes(thumbnail, aged, aged);
        assert.equal(DEFAULT_THUMBNAIL_CACHE_EXPIRY_DAYS, 90);
        assert.equal((await pruneThumbnailCache(cache)).removed, 1);

        const source = join(root, 'source'); await fs.mkdir(source);
        await fs.writeFile(join(source, 'clip.mp4'), 'synthetic unreadable video');
        const apiFile = join(root, 'api-organization.json');
        const headers = { authorization: 'Bearer test-token' };
        server = createServer('test-token', undefined, cache, join(root, 'fingerprints'), apiFile);
        assert.equal((await server.inject({ method: 'PATCH', url: '/api/organization', payload: { shotIds: ['a'.repeat(64)], action: { field: 'identity', operation: 'add', value: 'owmo' } } })).statusCode, 401);
        async function scan(serverInstance, path) {
            assert.equal((await serverInstance.inject({ method: 'POST', url: '/api/sources', headers, payload: { path } })).statusCode, 200);
            for (let i = 0; i < 250; i++) {
                const collection = (await serverInstance.inject({ method: 'GET', url: '/api/shots', headers })).json();
                if (collection.shots.length && collection.scans.every(scan => scan.state === 'complete')) return collection.shots[0];
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error('Fixture scan did not finish');
        }
        const shot = await scan(server, source);
        assert.deepEqual(shot.organization, emptyOrganization());
        const invalid = await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [shot.id], action: { field: 'context', operation: 'add', value: 'music//rock' } } });
        assert.equal(invalid.statusCode, 400);
        const moved = join(root, 'source-moved'); await fs.rename(source, moved);
        await server.inject({ method: 'GET', url: '/api/sources', headers });
        const response = await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [shot.id], action: { field: 'context', operation: 'add', value: 'Music/Rock' } } });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().collection.shots[0].organization.context, ['music/rock']);
        await server.close();
        server = createServer('test-token', undefined, cache, join(root, 'fingerprints'), apiFile);
        const rescanned = await scan(server, moved);
        assert.notEqual(rescanned.id, shot.id);
        assert.equal(rescanned.fingerprint.value, shot.fingerprint.value);
        assert.deepEqual(rescanned.organization.context, ['music/rock'], 'Fingerprint restores drafts after source/session changes');
        await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [rescanned.id], action: { field: 'identity', operation: 'add', value: 'OWMO Name' } } });
        await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [rescanned.id], action: { field: 'projects', operation: 'add', value: 'Test Project' } } });
        const beforeClear = await fs.readFile(apiFile, 'utf8');
        await server.inject({ method: 'DELETE', url: '/api/cache', headers });
        assert.equal(await fs.readFile(apiFile, 'utf8'), beforeClear, 'Clear Cache never removes organization drafts');
        await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [rescanned.id], action: { field: 'context', operation: 'add', value: 'unused-option' } } });
        await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [rescanned.id], action: { field: 'context', operation: 'remove', value: 'unused-option' } } });
        const optionRemoval = {identity:['OWMO Name'],projects:['Test Project'],context:['music/rock','unused-option']};
        assert.equal((await server.inject({method:'PATCH',url:'/api/organization/vocabulary',payload:optionRemoval})).statusCode,401);
        assert.equal((await server.inject({method:'PATCH',url:'/api/organization/vocabulary',headers,payload:{...optionRemoval,context:['bad//tag']}})).statusCode,400);
        const beforeOptionSave = JSON.parse(await fs.readFile(apiFile,'utf8')).drafts;
        const optionResponse = await server.inject({method:'PATCH',url:'/api/organization/vocabulary',headers,payload:optionRemoval});
        assert.equal(optionResponse.statusCode,200);
        assert.equal(optionResponse.json().collection.shots[0].editable,false,'Save queues a source rescan');
        for (let i=0;i<250;i++) {
            const current=(await server.inject({method:'GET',url:'/api/shots',headers})).json();
            if (current.scans.every(scan=>scan.state==='complete')) break;
            await new Promise(resolve=>setTimeout(resolve,20));
        }
        const afterOptionSave=JSON.parse(await fs.readFile(apiFile,'utf8')).drafts;
        for(const [key,record] of Object.entries(beforeOptionSave)) assert.deepEqual(afterOptionSave[key].data,record.data);
        const savedOptions=(await server.inject({method:'GET',url:'/api/organization/vocabulary',headers})).json();
        assert.deepEqual(savedOptions,{identity:['OWMO Name'],projects:['Test Project'],context:['music/rock']},'Rescans restore used values only');
        const retainedDrafts = JSON.parse(await fs.readFile(apiFile, 'utf8')).drafts;
        const cachedFile = join(cache, `${'f'.repeat(64)}.jpg`);
        await fs.writeFile(cachedFile, 'temporary thumbnail');
        assert.equal((await server.inject({ method: 'DELETE', url: '/api/local-data' })).statusCode, 401);
        assert.equal((await server.inject({ method: 'DELETE', url: '/api/local-data', headers })).statusCode, 200);
        await assert.rejects(fs.stat(cachedFile), {code:'ENOENT'});
        const scanning = (await server.inject({ method: 'GET', url: '/api/shots', headers })).json();
        assert.equal(scanning.shots[0].editable, false, 'Local Data clear automatically queues a rescan');
        const currentDrafts = JSON.parse(await fs.readFile(apiFile, 'utf8')).drafts;
        for (const [key, record] of Object.entries(retainedDrafts)) assert.deepEqual(currentDrafts[key].data, record.data);
        assert.equal((await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: {
            shotIds: [rescanned.id], action: { field: 'all', operation: 'clear', value: '' }
        } })).statusCode, 409, 'Clip Clear respects rescan locks');
        for (let i = 0; i < 250; i++) {
            const collection = (await server.inject({ method: 'GET', url: '/api/shots', headers })).json();
            if (collection.scans.every(scan => scan.state === 'complete')) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const rebuilt = (await server.inject({ method: 'GET', url: '/api/organization/vocabulary', headers })).json();
        assert.deepEqual(rebuilt, { identity: ['OWMO Name'], projects: ['Test Project'], context: ['music/rock'] });
        const cleared = await server.inject({ method: 'PATCH', url: '/api/organization', headers, payload: { shotIds: [rescanned.id], action: { field: 'all', operation: 'clear', value: '' } } });
        assert.equal(cleared.statusCode, 200);
        assert.deepEqual(cleared.json().collection.shots[0].organization, emptyOrganization());
        assert.deepEqual(cleared.json().vocabulary, rebuilt, 'Clip Clear leaves saved options intact');
        assert.equal(await fs.readFile(join(moved, 'clip.mp4'), 'utf8'), 'synthetic unreadable video');
        console.log('PASS: immediate atomic tag edits, bulk preservation/removal, lowercase hierarchy, permanent vocabularies, restart/offline restoration, 90-day scan renewal/expiry, corruption and lock recovery.');
    } finally { await server?.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
