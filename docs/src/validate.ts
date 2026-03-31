import { existsSync } from 'fs';
import { validateManifest, getAllFilePaths, ManifestValidationError } from '@vendure-io/docs-provider';
import { manifest } from './manifest';

try {
    validateManifest(manifest);
    console.log('Manifest validation passed.');
} catch (error) {
    if (error instanceof ManifestValidationError) {
        console.error('Manifest validation failed:');
        error.issues.forEach(issue => console.error(`  - ${issue}`));
        process.exit(1);
    }
    throw error;
}

const files = getAllFilePaths(manifest);
const missing = files.filter(file => !existsSync(file));

if (missing.length > 0) {
    console.error(`Missing ${missing.length} file(s):`);
    missing.forEach(file => console.error(`  - ${file}`));
    process.exit(1);
}

console.log(`All ${files.length} documentation files exist.`);
