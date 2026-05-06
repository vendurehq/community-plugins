import { Client } from '@elastic/elasticsearch';
import * as fs from 'fs';
import * as path from 'path';

import { elasticsearchHost, elasticsearchPort } from './constants';

const VOLATILE_FIELDS = new Set(['@timestamp']);

function normalizeDoc(source: any): any {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        if (VOLATILE_FIELDS.has(key)) continue;
        const v = source[key];
        if (typeof v === 'string') {
            const trimmed = v.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    out[key] = JSON.parse(trimmed);
                    continue;
                } catch {
                    /* fall through */
                }
            }
        }
        if (Array.isArray(v)) {
            out[key] = [...v].sort((a, b) => String(a).localeCompare(String(b)));
        } else {
            out[key] = v;
        }
    }
    return out;
}

export async function snapshotIndex(aliasOrIndex: string, outputPath: string): Promise<number> {
    const client = new Client({ node: `${elasticsearchHost}:${elasticsearchPort}` });
    const lines: string[] = [];
    const scroll = '1m';
    let resp: any = await client.search(
        {
            index: aliasOrIndex,
            scroll,
            size: 1000,
            body: {
                sort: [{ _id: 'asc' }],
                query: { match_all: {} },
            },
        },
        { meta: true },
    );
    while (resp.body.hits.hits.length) {
        for (const hit of resp.body.hits.hits) {
            lines.push(JSON.stringify({ _id: hit._id, _source: normalizeDoc(hit._source ?? {}) }));
        }
        resp = await client.scroll({ scroll_id: resp.body._scroll_id, scroll }, { meta: true });
    }
    await client.clearScroll({ scroll_id: resp.body._scroll_id }).catch(() => undefined);
    await client.close();

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, lines.join('\n') + (lines.length ? '\n' : ''));
    return lines.length;
}

export function diffSnapshots(a: string, b: string): { equal: boolean; aLines: number; bLines: number; firstDiffIndex: number | null } {
    const al = fs.existsSync(a) ? fs.readFileSync(a, 'utf8').split('\n').filter(Boolean) : [];
    const bl = fs.existsSync(b) ? fs.readFileSync(b, 'utf8').split('\n').filter(Boolean) : [];
    const len = Math.min(al.length, bl.length);
    let firstDiffIndex: number | null = null;
    for (let i = 0; i < len; i++) {
        if (al[i] !== bl[i]) {
            firstDiffIndex = i;
            break;
        }
    }
    if (firstDiffIndex === null && al.length !== bl.length) firstDiffIndex = len;
    return { equal: firstDiffIndex === null, aLines: al.length, bLines: bl.length, firstDiffIndex };
}
