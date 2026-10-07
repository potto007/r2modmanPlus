import { describe, expect, test } from 'vitest';
import R2Error from '../../../../../src/model/errors/R2Error';
import { parseRepository, repositoryToString, utf8ToBase64 } from '../../../../../src/r2mm/github/GitHubClient';

describe('parseRepository', () => {
    test.each([
        ['owner/name', 'owner', 'name'],
        ['  owner/name  ', 'owner', 'name'],
        ['https://github.com/owner/name', 'owner', 'name'],
        ['https://github.com/owner/name.git', 'owner', 'name'],
        ['https://github.com/owner/name/releases/tag/v1.0.0', 'owner', 'name'],
        ['github.com/owner/name', 'owner', 'name'],
        ['www.github.com/owner/name', 'owner', 'name'],
        ['git@github.com:owner/name.git', 'owner', 'name'],
        ['owner-1/my.mod_name', 'owner-1', 'my.mod_name'],
    ])('parses %s', (input, owner, name) => {
        expect(parseRepository(input)).toStrictEqual({ owner, name });
    });

    test.each([
        [''],
        ['owner'],
        ['owner/'],
        ['/name'],
        ['owner/name with space'],
        ['https://gitlab.com/owner/name'],
    ])('rejects %s', (input) => {
        expect(() => parseRepository(input)).toThrow(R2Error);
    });

    test('round-trips through repositoryToString', () => {
        expect(repositoryToString(parseRepository('https://github.com/A/B'))).toBe('A/B');
    });
});

describe('utf8ToBase64', () => {
    test('encodes ascii', () => {
        expect(utf8ToBase64('profileName: Test')).toBe(Buffer.from('profileName: Test', 'utf8').toString('base64'));
    });

    test('encodes multi-byte characters', () => {
        const input = 'name: Épée ✓ 日本';
        expect(utf8ToBase64(input)).toBe(Buffer.from(input, 'utf8').toString('base64'));
    });

    test('encodes inputs longer than one chunk', () => {
        const input = 'x'.repeat(100000);
        expect(utf8ToBase64(input)).toBe(Buffer.from(input, 'utf8').toString('base64'));
    });
});
