/* eslint-disable no-console */
import fs from 'fs-extra';
import path, { extname } from 'path';

import { generateTypescriptDocs, type DocsSectionConfig } from '@vendure-io/docs-generator';

import { docsPackages } from './docs-packages';

const STUB_MAX_LINES = 15;
const repoRoot = path.join(__dirname, '../../');
const docsOutputRoot = path.join(repoRoot, 'docs/docs/reference');

// outputPath is empty because output dirs are derived from @docsCategory in each source file
const sections: DocsSectionConfig[] = docsPackages.map(pkg => ({
    sourceDirs: [`packages/${pkg.packageDir}/src/`],
    exclude: pkg.exclude,
    outputPath: '',
}));

const watchMode = !!process.argv.find(arg => arg === '--watch' || arg === '-w');

generateTypescriptDocs(sections, {
    packagePrefix: '@vendure-community',
    repoRoot,
    outputRoot: docsOutputRoot,
    isWatchMode: watchMode,
});

injectReadmeContent();

if (watchMode) {
    console.log(`Watching for changes to source files...`);
    sections.forEach(section => {
        section.sourceDirs.forEach(dir => {
            fs.watch(path.join(repoRoot, dir), { recursive: true }, (eventType, file) => {
                if (file && extname(file) === '.ts') {
                    console.log(`Changes detected in ${dir}`);
                    generateTypescriptDocs([section], {
                        packagePrefix: '@vendure-community',
                        repoRoot,
                        outputRoot: docsOutputRoot,
                        isWatchMode: true,
                    });
                    injectReadmeContent();
                }
            });
        });
    });
}

/**
 * After generating the TypeScript API docs, inject README content into each
 * plugin's index.mdx before the class signature block.
 */
function injectReadmeContent() {
    const timeStart = +new Date();
    let injectedCount = 0;

    for (const pkg of docsPackages) {
        const readmePath = path.join(repoRoot, 'packages', pkg.packageDir, 'README.md');
        if (!fs.existsSync(readmePath)) {
            continue;
        }

        const readme = fs.readFileSync(readmePath, 'utf-8');
        if (readme.trim().split('\n').length < STUB_MAX_LINES) {
            continue;
        }

        const indexPath = path.join(docsOutputRoot, pkg.docsDir, 'index.mdx');
        if (!fs.existsSync(indexPath)) {
            continue;
        }

        const indexContent = fs.readFileSync(indexPath, 'utf-8');
        const readmeContent = transformReadmeToMdx(readme);
        const merged = injectIntoIndex(indexContent, readmeContent);

        fs.writeFileSync(indexPath, merged);
        injectedCount++;
    }

    console.log(`Injected README content into ${injectedCount} index.mdx files in ${+new Date() - timeStart}ms`);
}

function injectIntoIndex(indexContent: string, readmeContent: string): string {
    const signatureMarker = '```ts title="Signature"';
    const markerIndex = indexContent.indexOf(signatureMarker);

    if (markerIndex === -1) {
        return indexContent.trimEnd() + '\n\n' + readmeContent;
    }

    const before = indexContent.slice(0, markerIndex).trimEnd();
    const after = indexContent.slice(markerIndex);

    return before + '\n\n' + readmeContent.trim() + '\n\n' + after;
}

/**
 * Strips everything before the first ## heading (title + intro paragraph,
 * which duplicates the JSDoc @description) and escapes curly braces
 * outside of code blocks for MDX safety.
 */
function transformReadmeToMdx(markdown: string): string {
    const lines = markdown.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;
    let reachedFirstHeading = false;

    for (const line of lines) {
        if (line.trimStart().startsWith('```')) {
            if (reachedFirstHeading) {
                inCodeBlock = !inCodeBlock;
                result.push(line);
            }
            continue;
        }

        if (!reachedFirstHeading && !inCodeBlock) {
            if (/^#{2,}\s/.test(line)) {
                reachedFirstHeading = true;
            } else {
                continue;
            }
        }

        if (inCodeBlock) {
            result.push(line);
        } else {
            result.push(escapeMdxLine(line));
        }
    }

    return result.join('\n');
}

function escapeMdxLine(line: string): string {
    const parts = line.split(/(`[^`]*`)/);
    return parts
        .map((part, i) => {
            if (i % 2 === 1) return part;
            return part.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
        })
        .join('');
}
