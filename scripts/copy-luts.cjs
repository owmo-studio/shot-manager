const { copyFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const source = join(__dirname, '..', 'resources', 'luts')
const destination = join(__dirname, '..', 'out', 'resources', 'luts')
const files = ['sony-s709.cube', 'apple-log-rec709.cube', 'apple-resource.sha256']

mkdirSync(destination, { recursive: true })
for (const file of files) copyFileSync(join(source, file), join(destination, file))
