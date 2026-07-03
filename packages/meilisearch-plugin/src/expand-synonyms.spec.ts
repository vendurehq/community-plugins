import { describe, expect, it } from 'vitest';

import { expandSynonymsBidirectional } from './indexing/indexing-utils';

describe('expandSynonymsBidirectional()', () => {
    it('expands a single synonym pair bidirectionally', () => {
        const result = expandSynonymsBidirectional({
            laptop: ['notebook'],
        });
        expect(result).toEqual({
            laptop: ['notebook'],
            notebook: ['laptop'],
        });
    });

    it('expands a group of 3 words', () => {
        const result = expandSynonymsBidirectional({
            laptop: ['notebook', 'portable computer'],
        });
        expect(result.laptop).toEqual(expect.arrayContaining(['notebook', 'portable computer']));
        expect(result.notebook).toEqual(expect.arrayContaining(['laptop', 'portable computer']));
        expect(result['portable computer']).toEqual(expect.arrayContaining(['laptop', 'notebook']));
        expect(Object.keys(result)).toHaveLength(3);
    });

    it('a word never maps to itself', () => {
        const result = expandSynonymsBidirectional({
            laptop: ['notebook'],
        });
        expect(result.laptop).not.toContain('laptop');
        expect(result.notebook).not.toContain('notebook');
    });

    it('merges overlapping groups', () => {
        const result = expandSynonymsBidirectional({
            phone: ['mobile'],
            mobile: ['cell'],
        });
        // "phone" should know about "mobile" and "cell"
        expect(result.phone).toEqual(expect.arrayContaining(['mobile']));
        // "mobile" should know about "phone" and "cell"
        expect(result.mobile).toEqual(expect.arrayContaining(['phone', 'cell']));
        // "cell" should know about "mobile"
        expect(result.cell).toEqual(expect.arrayContaining(['mobile']));
    });

    it('deduplicates values', () => {
        const result = expandSynonymsBidirectional({
            laptop: ['notebook'],
            notebook: ['laptop'],
        });
        // Should not have duplicates
        expect(result.laptop).toEqual(['notebook']);
        expect(result.notebook).toEqual(['laptop']);
    });

    it('handles multiple independent groups', () => {
        const result = expandSynonymsBidirectional({
            laptop: ['notebook'],
            shoe: ['sneaker'],
        });
        expect(result.laptop).toEqual(['notebook']);
        expect(result.notebook).toEqual(['laptop']);
        expect(result.shoe).toEqual(['sneaker']);
        expect(result.sneaker).toEqual(['shoe']);
        expect(Object.keys(result)).toHaveLength(4);
    });

    it('handles empty input', () => {
        const result = expandSynonymsBidirectional({});
        expect(result).toEqual({});
    });

    it('handles single word with empty synonyms array', () => {
        const result = expandSynonymsBidirectional({
            laptop: [],
        });
        // "laptop" has no synonyms, so it maps to an empty array
        expect(result).toEqual({ laptop: [] });
    });

    it('handles large synonym group', () => {
        const result = expandSynonymsBidirectional({
            phone: ['mobile', 'smartphone', 'cellphone', 'handset'],
        });
        expect(Object.keys(result)).toHaveLength(5);
        // Each word should map to all 4 others
        for (const [word, synonyms] of Object.entries(result)) {
            expect(synonyms).toHaveLength(4);
            expect(synonyms).not.toContain(word);
        }
    });
});
