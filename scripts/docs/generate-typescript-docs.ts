/* eslint-disable no-console */
import fs from 'fs-extra';
import klawSync from 'klaw-sync';
import path, { extname } from 'path';

import { deleteGeneratedDocs, normalizeForUrlPart } from './docgen-utils';
import { docsPackages } from './docs-packages';
import { TypeMap } from './typescript-docgen-types';
import { TypescriptDocsParser } from './typescript-docs-parser';
import { TypescriptDocsRenderer } from './typescript-docs-renderer';

interface DocsSectionConfig {
    sourceDirs: string[];
    exclude?: RegExp[];
    outputPath: string;
}

const STUB_MAX_LINES = 15;
const repoRoot = path.join(__dirname, '../../');
const docsOutputRoot = path.join(repoRoot, 'docs/docs/reference');

const sections: DocsSectionConfig[] = docsPackages.map(pkg => ({
    sourceDirs: [`packages/${pkg.packageDir}/src/`],
    exclude: pkg.exclude,
    outputPath: '',
}));

generateTypescriptDocs(sections);
injectReadmeContent();

const watchMode = !!process.argv.find(arg => arg === '--watch' || arg === '-w');
if (watchMode) {
    console.log(`Watching for changes to source files...`);
    sections.forEach(section => {
        section.sourceDirs.forEach(dir => {
            fs.watch(dir, { recursive: true }, (eventType, file) => {
                if (file && extname(file) === '.ts') {
                    console.log(`Changes detected in ${dir}`);
                    generateTypescriptDocs([section], true);
                }
            });
        });
    });
}

/**
 * Uses the TypeScript compiler API to parse the given files and extract out the documentation
 * into markdown files
 */
function generateTypescriptDocs(config: DocsSectionConfig[], isWatchMode: boolean = false) {
    const timeStart = +new Date();

    const globalTypeMap: TypeMap = new Map();

    if (!isWatchMode) {
        for (const { outputPath, sourceDirs } of config) {
            deleteGeneratedDocs(absOutputPath(outputPath));
        }
    }

    for (const { outputPath, sourceDirs, exclude } of config) {
        const sourceFilePaths = getSourceFilePaths(sourceDirs, exclude);
        const docsPages = new TypescriptDocsParser().parse(sourceFilePaths);
        for (const page of docsPages) {
            const { category, fileName, declarations } = page;
            for (const declaration of declarations) {
                const pathToTypeDoc = `reference/${outputPath ? `${outputPath}/` : ''}${
                    category ? category.map(part => normalizeForUrlPart(part)).join('/') + '/' : ''
                }${fileName === 'index' ? '' : fileName}#${toHash(declaration.title)}`;
                globalTypeMap.set(declaration.title, pathToTypeDoc);
            }
        }
        const docsUrl = ``;
        const generatedCount = new TypescriptDocsRenderer().render(
            docsPages,
            docsUrl,
            absOutputPath(outputPath),
            globalTypeMap,
        );

        if (generatedCount) {
            console.log(
                `Generated ${generatedCount} typescript api docs for "${outputPath || 'community-plugins'}" in ${
                    +new Date() - timeStart
                }ms`,
            );
        }
    }
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

function toHash(title: string): string {
    return title.replace(/\s/g, '').toLowerCase();
}

function absOutputPath(outputPath: string): string {
    return path.join(docsOutputRoot, outputPath);
}

function getSourceFilePaths(sourceDirs: string[], excludePatterns: RegExp[] = []): string[] {
    return sourceDirs
        .map(scanPath =>
            klawSync(path.join(repoRoot, scanPath), {
                nodir: true,
                filter: item => {
                    const ext = path.extname(item.path);
                    if (ext === '.ts' || ext === '.tsx') {
                        for (const pattern of excludePatterns) {
                            if (pattern.test(item.path)) {
                                return false;
                            }
                        }
                        return true;
                    }
                    return false;
                },
                traverseAll: true,
            }),
        )
        .reduce((allFiles, files) => [...allFiles, ...files], [])
        .map(item => item.path);
}
