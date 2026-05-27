/* eslint-disable no-console */
/**
 * Prepares a release for a SINGLE package.
 *
 * Given a package directory name, this script:
 *   1. Finds the last `<package>/v*` git tag (the package's previous release)
 *   2. Collects conventional commits since that tag which touched the package
 *   3. Determines the semver bump (feat! → major, feat → minor, fix/perf/refactor → patch)
 *   4. Bumps the package's package.json version
 *   5. Prepends a grouped section to the package's CHANGELOG.md
 *   6. Commits the change and creates a `<package>/v<version>` tag (locally — never pushed)
 *
 * Usage:
 *   bun run release <package> [--dry-run] [--force] [--first-release] [--prerelease[=<preid>]]
 *
 *   --dry-run            Print what would happen without writing or committing.
 *   --force              Release even if no version-bumping commits are found (patch bump).
 *   --first-release      Allow releasing with no prior `<package>/v*` tag (uses full history).
 *   --prerelease[=rc]    Produce a pre-release version (e.g. 1.1.0-rc.0). Default preid: rc.
 *
 * Baseline tags: every published version should have a matching `<package>/v<version>` tag so
 * the changelog only reflects commits since the last release. If a package was published
 * without one, create it first, e.g. `git tag mollie-plugin/v1.0.0 <commit>`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import semver from 'semver';

const repoRoot = path.join(__dirname, '../../');

/** semver release types — declared locally so we don't need an `@types/semver` dependency. */
type ReleaseType = 'major' | 'minor' | 'patch' | 'premajor' | 'preminor' | 'prepatch' | 'prerelease';

interface ParsedCommit {
    hash: string;
    type: string;
    breaking: boolean;
    description: string;
    pr?: number;
}

/** Categories rendered in the changelog, in display order. Maps a commit type to its heading. */
const CHANGELOG_SECTIONS: Array<{ type: string; heading: string }> = [
    { type: 'feat', heading: 'Features' },
    { type: 'fix', heading: 'Bug Fixes' },
    { type: 'perf', heading: 'Performance Improvements' },
    { type: 'refactor', heading: 'Refactors' },
];

/** Commit types that warrant a patch bump (in the absence of feat/breaking). */
const PATCH_TYPES = new Set(['fix', 'perf', 'refactor']);

/** Conventional types we recognise. An unrecognised type is likely a typo and is surfaced as a warning. */
const KNOWN_TYPES = new Set([
    'feat', 'fix', 'perf', 'refactor', 'docs', 'chore', 'style', 'test', 'build', 'ci', 'revert',
]);

/** Runs git with arguments as an array, so no value is ever interpreted by a shell. */
function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

/** Derives the PR base URL (`.../pull`) from a package.json `repository` field. */
function getPrBaseUrl(repository: { url?: string } | string | undefined): string {
    const url = typeof repository === 'string' ? repository : repository?.url;
    const cleaned = (url ?? 'https://github.com/vendurehq/community-plugins')
        .replace(/^git\+/, '')
        .replace(/\.git$/, '');
    return `${cleaned}/pull`;
}

function fail(message: string): never {
    console.error(`\n✗ ${message}\n`);
    process.exit(1);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const flags = args.filter(a => a.startsWith('--'));
    const positionals = args.filter(a => !a.startsWith('--'));
    const prereleaseFlag = flags.find(f => f === '--prerelease' || f.startsWith('--prerelease='));
    return {
        packageName: positionals[0],
        dryRun: flags.includes('--dry-run'),
        force: flags.includes('--force'),
        firstRelease: flags.includes('--first-release'),
        prerelease: prereleaseFlag ? (prereleaseFlag.split('=')[1] || 'rc') : undefined,
    };
}

/** Returns the highest existing `<packageName>/v*` tag, or null if the package has never been tagged. */
function getLastTag(packageName: string): string | null {
    const tags = git(['tag', '--list', `${packageName}/v*`])
        .split('\n')
        .map(t => t.trim())
        .filter(Boolean);
    if (tags.length === 0) {
        return null;
    }
    const sorted = tags
        .map(tag => ({ tag, version: tag.replace(`${packageName}/v`, '') }))
        .filter(t => semver.valid(t.version))
        .sort((a, b) => semver.rcompare(a.version, b.version));
    return sorted[0]?.tag ?? null;
}

/** Collects commits since `lastTag` (or all history) that changed files within the package. */
function getCommits(packageName: string, lastTag: string | null): ParsedCommit[] {
    const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
    // Record-separated log: hash \x1f subject \x1f body \x1e
    const raw = git([
        'log',
        '--no-merges',
        '--format=%H%x1f%s%x1f%b%x1e',
        range,
        '--',
        `packages/${packageName}`,
    ]);
    if (!raw) {
        return [];
    }
    return raw
        .split('\x1e')
        .map(r => r.trim())
        .filter(Boolean)
        .map(record => {
            const [hash, subject, body] = record.split('\x1f');
            return parseCommit(hash, subject ?? '', body ?? '');
        })
        .filter((c): c is ParsedCommit => c !== null);
}

function parseCommit(hash: string, subject: string, body: string): ParsedCommit | null {
    const match = subject.match(/^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/);
    if (!match) {
        return null;
    }
    const [, type, , bang, rest] = match;
    const breaking = bang === '!' || /BREAKING[ -]CHANGE/.test(body);
    const prMatch = rest.match(/\(#(\d+)\)\s*$/);
    const description = rest.replace(/\s*\(#\d+\)\s*$/, '').trim();
    return {
        hash,
        type,
        breaking,
        description,
        pr: prMatch ? Number(prMatch[1]) : undefined,
    };
}

function determineBump(commits: ParsedCommit[]): ReleaseType | null {
    if (commits.some(c => c.breaking)) {
        return 'major';
    }
    if (commits.some(c => c.type === 'feat')) {
        return 'minor';
    }
    if (commits.some(c => PATCH_TYPES.has(c.type))) {
        return 'patch';
    }
    return null;
}

function buildChangelogSection(
    version: string,
    packageName: string,
    commits: ParsedCommit[],
    prBaseUrl: string,
): string {
    const date = new Date().toISOString().slice(0, 10);
    const lines: string[] = [`## ${version} (${date})`, ''];

    const formatLine = (c: ParsedCommit) => {
        const ref = c.pr ? ` ([#${c.pr}](${prBaseUrl}/${c.pr}))` : '';
        // Scope is normalised to the package name regardless of the original commit scope.
        return `* **${packageName}:** ${c.description}${ref}`;
    };

    // Breaking changes are listed once, in their own prominent section, and omitted from the
    // per-type sections below to avoid duplicating the same entry.
    const breaking = commits.filter(c => c.breaking);
    if (breaking.length > 0) {
        lines.push('### BREAKING CHANGES', '');
        breaking.forEach(c => lines.push(formatLine(c)));
        lines.push('');
    }

    for (const { type, heading } of CHANGELOG_SECTIONS) {
        const matching = commits.filter(c => c.type === type && !c.breaking);
        if (matching.length === 0) {
            continue;
        }
        lines.push(`### ${heading}`, '');
        matching.forEach(c => lines.push(formatLine(c)));
        lines.push('');
    }

    return lines.join('\n').trimEnd() + '\n';
}

/** Inserts the new section after the changelog preamble, before the first existing `## ` entry. */
function updateChangelog(changelogPath: string, section: string): void {
    const existing = fs.existsSync(changelogPath) ? fs.readFileSync(changelogPath, 'utf-8') : '';
    const firstEntryIndex = existing.search(/^## /m);
    if (firstEntryIndex === -1) {
        const preamble = existing.trimEnd();
        const content = preamble ? `${preamble}\n\n${section}` : section;
        fs.writeFileSync(changelogPath, content);
        return;
    }
    const head = existing.slice(0, firstEntryIndex);
    const tail = existing.slice(firstEntryIndex);
    fs.writeFileSync(changelogPath, `${head}${section}\n${tail}`);
}

/** Updates the `version` field in package.json, preserving the file's existing formatting. */
function updatePackageVersion(pkgPath: string, version: string): void {
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const updated = raw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
    fs.writeFileSync(pkgPath, updated);
}

function main(): void {
    const { packageName, dryRun, force, firstRelease, prerelease } = parseArgs();

    if (!packageName) {
        fail(
            'Missing package name.\n' +
                '  Usage: bun run release <package> [--dry-run] [--force] [--first-release] [--prerelease[=<preid>]]',
        );
    }

    const pkgDir = path.join(repoRoot, 'packages', packageName);
    const pkgPath = path.join(pkgDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        fail(`Package not found: packages/${packageName} (no package.json)`);
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
        name: string;
        version: string;
        repository?: { url?: string } | string;
    };
    const currentVersion = pkg.version;
    const lastTag = getLastTag(packageName);

    // A missing baseline tag means we'd treat the entire history as unreleased, producing a noisy,
    // over-inflated changelog. Refuse unless the caller explicitly opts in.
    if (!lastTag && !firstRelease) {
        fail(
            `No baseline tag "${packageName}/v*" found, so the changelog would include the full history.\n` +
                `  The package is currently at v${currentVersion}. If it was already published, tag the\n` +
                `  release commit first, e.g.:\n` +
                `      git tag ${packageName}/v${currentVersion} <commit>\n` +
                `  Otherwise, pass --first-release to intentionally use the full history.`,
        );
    }

    const commits = getCommits(packageName, lastTag);

    console.log(`\nPreparing release for ${pkg.name}`);
    console.log(`  Current version: ${currentVersion}`);
    console.log(`  Last tag:        ${lastTag ?? '(none — using full history)'}`);
    console.log(`  Commits found:   ${commits.length}`);

    const unrecognised = commits.filter(c => !KNOWN_TYPES.has(c.type));
    if (unrecognised.length > 0) {
        console.warn(`\n⚠ Unrecognised commit type(s) — ignored for versioning and changelog (typo?):`);
        unrecognised.forEach(c => console.warn(`    ${c.type}: ${c.description}`));
    }

    let bump = determineBump(commits);
    if (!bump) {
        if (!force) {
            fail(
                `No version-bumping commits (feat/fix/perf/refactor) found since ${lastTag ?? 'the start'}.\n` +
                    `  Use --force to cut a patch release anyway.`,
            );
        }
        bump = 'patch';
    }

    let newVersion: string;
    if (prerelease) {
        // If already on a pre-release, increment just the counter (1.1.0-rc.0 → 1.1.0-rc.1);
        // otherwise start a fresh pre-release for the next <bump> version (1.0.0 → 1.1.0-rc.0).
        const releaseType: ReleaseType = semver.prerelease(currentVersion) ? 'prerelease' : `pre${bump}`;
        newVersion = semver.inc(currentVersion, releaseType, prerelease) as string;
    } else {
        newVersion = semver.inc(currentVersion, bump) as string;
    }
    const tag = `${packageName}/v${newVersion}`;
    const section = buildChangelogSection(newVersion, packageName, commits, getPrBaseUrl(pkg.repository));

    console.log(`  Bump:            ${bump}${prerelease ? ` (prerelease: ${prerelease})` : ''}`);
    console.log(`  New version:     ${newVersion}`);
    console.log(`  Tag:             ${tag}\n`);
    console.log('Changelog section:\n');
    console.log(section);

    if (dryRun) {
        console.log('--dry-run: no files written, no commit, no tag.\n');
        return;
    }

    updatePackageVersion(pkgPath, newVersion);
    updateChangelog(path.join(pkgDir, 'CHANGELOG.md'), section);

    git(['add', `packages/${packageName}/package.json`, `packages/${packageName}/CHANGELOG.md`]);
    git(['commit', '-m', `chore(release): ${pkg.name}@${newVersion}`]);
    // Annotated (not lightweight) so that `git push --follow-tags` actually pushes it.
    git(['tag', '-a', tag, '-m', `${pkg.name}@${newVersion}`]);

    console.log(`✓ Committed and tagged ${tag} (local only).\n`);
    console.log('Next steps:');
    console.log(`  1. Review:  git show HEAD`);
    console.log(`  2. Push:    git push --follow-tags origin main`);
    console.log(`  3. Publish: GitHub → Actions → "Publish to NPM" → Run workflow → package: ${packageName}\n`);
}

main();
