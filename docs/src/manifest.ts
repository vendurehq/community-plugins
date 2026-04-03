import {
    createNestedNavigationFromFolder,
    resolveManifest,
    type DocsPackageManifestInput,
} from '@vendure-io/docs-provider';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const manifestInput: DocsPackageManifestInput = {
    id: 'community-plugins',
    name: 'Community Plugins',
    version: '0.0.0',
    vendureVersion: 'v3',
    basePath: packageRoot,
    navigation: createNestedNavigationFromFolder(
        join(packageRoot, 'docs/reference'),
        { extensions: ['.mdx'] },
    ),
    github: {
        repository: 'vendurehq/community-plugins',
        branch: 'main',
        docsPath: 'docs',
    },
};

export const manifest = resolveManifest(manifestInput);
