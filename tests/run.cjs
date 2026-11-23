const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { dirname, join } = require('node:path');

const requested = process.argv.slice(2);
const ui = requested[0] === '--ui';
if (ui) requested.shift();
const directory = ui ? join(__dirname, 'ui') : __dirname;
const suffix = '.test.cjs';
const available = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => entry.name.slice(0, -suffix.length))
    .sort();
const selected = requested.length ? [...new Set(requested)] : available;
const unknown = selected.filter(name => !available.includes(name));
if (!available.length || unknown.length) {
    console.error(unknown.length ? `Unknown test: ${unknown.join(', ')}` : 'No tests found.');
    console.error(`Available tests: ${available.join(', ')}`);
    process.exit(1);
}

// Each check owns its fixtures and process state. Run them in isolation and in order.
for (const name of selected) {
    console.log(`\nRunning ${name}`);
    const result = spawnSync(process.execPath, [join(directory, name + suffix)], {
        cwd: dirname(__dirname), stdio: 'inherit',
    });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) {
        console.error(`Failed: ${name}`);
        process.exit(result.status ?? 1);
    }
}
console.log(`\nPassed ${selected.length} ${selected.length === 1 ? 'test' : 'tests'}.`);
