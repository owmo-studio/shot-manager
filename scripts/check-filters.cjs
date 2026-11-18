const assert = require('node:assert/strict');
const { resolve } = require('node:path');
(async () => {
    const bundle = await (await import('vite')).build({ configFile: false, logLevel: 'silent', build: {
        ssr: true, write: false, rollupOptions: { input: resolve('client/src/clipFilters.ts'), output: { format: 'cjs' } },
    } });
    const loaded = new (require('node:module'))(__filename, module); loaded.paths = module.paths;
    loaded._compile(bundle.output.find(item => item.type === 'chunk' && item.isEntry).code, __filename);
    const { emptyClipFilters, matchesClipFilters, filterOptions, UNASSIGNED_IDENTITY } = loaded.exports;
    const shot = (name, identity, project, model, tags, notes = '') => ({ filename: name,
        metadata: { device: { manufacturer: 'Sony', model } }, organization: { identity, project, tags, notes, scene: '', group: '', camera: '' } });
    const shots = [shot('Intro.mp4', 'OWMO', 'Tour', 'ILME-FX30', ['talk', 'studio'], 'Bright room'),
        shot('Desk.mp4', 'OWMO', 'Build', 'ILME-FX30', ['studio']),
        shot('Outside.mp4', 'Other', 'Tour', 'ZV-E10M2', ['talk'])];
    const match = filters => shots.filter(shot => matchesClipFilters(shot, { ...emptyClipFilters(), ...filters })).map(shot => shot.filename);
    assert.deepEqual(match({ search: 'INTRO bright' }), ['Intro.mp4']);
    assert.deepEqual(match({ search: 'tour studio' }), ['Intro.mp4'], 'Search matches words across Project and Tags');
    assert.deepEqual(match({ search: 'OWMO' }), [], 'Search does not duplicate Identity filtering');
    assert.deepEqual(match({ identity: 'OWMO', projects: ['Tour'], tags: ['talk'] }), ['Intro.mp4']);
    assert.deepEqual(match({ projects: ['Tour', 'Build'], tags: ['studio'] }), ['Intro.mp4', 'Desk.mp4'], 'Choices within a facet use OR; facets use AND');
    assert.deepEqual(match({ tags: ['talk', 'studio'] }), shots.map(shot => shot.filename));
    const filters = { ...emptyClipFilters(), identity: 'Other', projects: ['Build'] };
    assert.deepEqual(filterOptions(shots, filters, 'projects'), [['Build', 0], ['Tour', 1]], 'Facet options ignore their own restriction and retain selected zero-count choices');
    assert.deepEqual(match(filters), []);
    assert.deepEqual(match(emptyClipFilters()), shots.map(shot => shot.filename), 'Reset restores every clip');
    assert.deepEqual(match({ tags: ['missing'] }), [], 'Typed unknown tags cannot silently broaden results');
    assert.deepEqual(filterOptions(shots, { ...emptyClipFilters(), search: 'no match anywhere' }, 'projects'), [['Build', 1], ['Tour', 2]], 'Search only affects results, never hierarchical options');
    assert.deepEqual(filterOptions(shots, { ...emptyClipFilters(), tags: ['talk'] }, 'tags'), [['studio', 2], ['talk', 2]], 'All workspace tags remain available');
    const unassigned = shot('Unassigned.mp4', null, null, null, []);
    assert.equal(matchesClipFilters(unassigned, { ...emptyClipFilters(), identity: UNASSIGNED_IDENTITY }), true);
    assert.equal(matchesClipFilters(shots[0], { ...emptyClipFilters(), identity: UNASSIGNED_IDENTITY }), false);
    assert.deepEqual(filterOptions(shots, { ...emptyClipFilters(), devices: ['Sony ZV-E10 II'] }, 'projects'), [['Build', 1], ['Tour', 2]], 'Choosing Device first does not restrict earlier Project options');
    assert.deepEqual(filterOptions(shots, { ...emptyClipFilters(), identity: 'Other' }, 'tags'), [['talk', 1]], 'Identity cascades into Tags');
    assert.deepEqual(filterOptions(shots, { ...emptyClipFilters(), projects: ['Build'] }, 'devices'), [['Sony FX30', 1]], 'Project cascades into Device');
    assert.deepEqual(filterOptions(shots, { ...filters, tags: ['studio'] }, 'tags'), [['studio', 0]], 'Incompatible selected values remain removable');
    console.log('PASS: cumulative filters, word search, facet counts, multi-choice matching, empty results and reset.');
})().catch(error => { console.error(error); process.exitCode = 1; });
