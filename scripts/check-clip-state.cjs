// Pure comparison rules used by Import, Library, and persisted draft state.
const assert = require('node:assert/strict');
const { resolve } = require('node:path');

(async () => {
    const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
        ssr: true, write: false, rollupOptions: { input: resolve('shared/clipState.ts'), output: { format: 'cjs' } },
    } });
    const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
    loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
    const { attributesEqual, attributesChanged, thumbnailChanged, thumbnailDraftChanged, descriptiveStateChanged, publishedClipState } = loaded.exports;
    const base = { identity: 'OWMO', project: 'Tour', scene: 'Intro', notes: 'Keep', tags: ['talk'], group: 'TH-01', camera: 'A', rating: 'usable' };
    assert.equal(attributesEqual(base, { ...base }), true);
    assert.equal(attributesEqual(base, { ...base, skipped: true }), true, 'Skip is excluded from descriptive state');
    assert.equal(attributesChanged(base, { ...base, notes: 'Changed' }), true);
    assert.equal(attributesChanged(undefined, base), true, 'Missing baseline is a change');
    assert.equal(attributesChanged(undefined, undefined), false);
    assert.equal(thumbnailChanged('a', 'a'), false);
    assert.equal(thumbnailChanged('a', 'b'), true);
    assert.equal(thumbnailChanged(undefined, 'b'), false, 'Unknown thumbnail evidence is not a diff');
    assert.equal(thumbnailDraftChanged('a', true, 'a'), false);
    assert.equal(thumbnailDraftChanged('a', true, 'b'), true);
    assert.equal(thumbnailDraftChanged('a', false, 'a'), true, 'A draft cannot be trusted without a published asset');
    assert.equal(descriptiveStateChanged({ ...base, notes: 'Changed' }, base), true);
    assert.equal(descriptiveStateChanged(base, base, 'a', 'a'), false);
    const evidence = { libraryConfigured: true, presenceKnown: true, existing: true, complete: true, proxyRequired: true, proxyPresent: true, receiptMatches: true, signatureMatches: true };
    assert.equal(publishedClipState(evidence), 'synced');
    assert.equal(publishedClipState({ ...evidence, signatureMatches: false }), 'changes-pending');
    assert.equal(publishedClipState({ ...evidence, existing: false }), 'new');
    assert.equal(publishedClipState({ ...evidence, presenceKnown: false }), 'unverified', 'Known receipt plus unavailable presence is unverified');
    assert.equal(publishedClipState({ ...evidence, presenceKnown: false, receiptMatches: false }), undefined);
    console.log('PASS: shared descriptive and thumbnail comparison rules.');
})().catch(error => { console.error(error); process.exitCode = 1; });
