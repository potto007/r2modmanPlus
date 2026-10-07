import { beforeAll, describe, expect, test } from 'vitest';
import GitHubModInstaller, { GitHubModInstallPlan } from '../../../../../src/r2mm/github/GitHubModInstaller';
import { GitHubRelease } from '../../../../../src/r2mm/github/GitHubClient';
import ZipProvider from '../../../../../src/providers/generic/zip/ZipProvider';
import ZipBuilder from '../../../../../src/providers/generic/zip/ZipBuilder';
import ZipEntryInterface from '../../../../../src/providers/generic/zip/ZipEntryInterface';
import R2Error from '../../../../../src/model/errors/R2Error';

/** Serves manifest.json content keyed by zip path. */
class FakeZipProvider extends ZipProvider {
    public manifests: Record<string, string | null> = {};

    async extractAllTo(): Promise<void> {}
    async readFile(zip: string | Buffer, file: string): Promise<Buffer | null> {
        if (file !== 'manifest.json') {
            return null;
        }
        const content = this.manifests[zip.toString()];
        return content === undefined || content === null ? null : Buffer.from(content);
    }
    async getEntries(): Promise<ZipEntryInterface[]> { return []; }
    async extractEntryTo(): Promise<void> {}
    zipBuilder(): ZipBuilder { throw new Error('not used'); }
}

const zipProvider = new FakeZipProvider();

function release(tag: string, assets: string[], extra: Partial<GitHubRelease> = {}): GitHubRelease {
    return {
        id: 1,
        tagName: tag,
        name: tag,
        prerelease: false,
        draft: false,
        publishedAt: null,
        assets: assets.map((name, index) => ({ id: index + 1, name, size: 10, contentType: 'application/zip' })),
        ...extra,
    };
}

function plan(tag: string, assetName: string, owner = 'Some-Owner', name = 'cool.mod'): GitHubModInstallPlan {
    const rel = release(tag, [assetName]);
    return { repository: { owner, name }, release: rel, asset: rel.assets[0]! };
}

describe('GitHubModInstaller', () => {

    beforeAll(() => {
        ZipProvider.provide(() => zipProvider);
    });

    test('sanitizeNamePart keeps Thunderstore-safe characters only', () => {
        expect(GitHubModInstaller.sanitizeNamePart('Some-Owner')).toBe('Some_Owner');
        expect(GitHubModInstaller.sanitizeNamePart('cool.mod')).toBe('cool_mod');
        expect(GitHubModInstaller.sanitizeNamePart('__already_ok__')).toBe('already_ok');
        expect(GitHubModInstaller.sanitizeNamePart('---')).toBe('Unknown');
    });

    test.each([
        ['v1.2.3', '1.2.3'],
        ['1.2.3', '1.2.3'],
        ['release-2.0', '2.0.0'],
        ['1.2.3-beta.1', '1.2.3'],
        ['MyMod_v10.0.1', '10.0.1'],
    ])('versionFromTag %s -> %s', (tag, expected) => {
        expect(GitHubModInstaller.versionFromTag(tag)!.toString()).toBe(expected);
    });

    test('versionFromTag returns null without a version', () => {
        expect(GitHubModInstaller.versionFromTag('latest')).toBeNull();
        expect(GitHubModInstaller.versionFromTag('v1')).toBeNull();
    });

    test('pickDefaultAsset prefers the only installable asset', () => {
        const rel = release('v1.0.0', ['README.md', 'Mod.zip', 'source.tar.gz']);
        expect(GitHubModInstaller.pickDefaultAsset(rel)!.name).toBe('Mod.zip');
    });

    test('pickDefaultAsset prefers a zip over a dll when both exist', () => {
        const rel = release('v1.0.0', ['Mod.dll', 'Mod.zip']);
        expect(GitHubModInstaller.pickDefaultAsset(rel)!.name).toBe('Mod.zip');
    });

    test('pickDefaultAsset falls back to a dll', () => {
        const rel = release('v1.0.0', ['Mod.dll', 'notes.txt']);
        expect(GitHubModInstaller.pickDefaultAsset(rel)!.name).toBe('Mod.dll');
    });

    test('pickDefaultAsset returns null without installable assets', () => {
        expect(GitHubModInstaller.pickDefaultAsset(release('v1.0.0', ['notes.txt']))).toBeNull();
    });

    test('buildManifest uses manifest.json when present and the tag for the version', async () => {
        zipProvider.manifests['/cache/Mod.zip'] = JSON.stringify({
            name: 'CoolMod',
            description: 'Does cool things',
            version_number: '9.9.9',
            dependencies: ['BepInEx-BepInExPack-5.4.2100'],
        });
        const manifest = await GitHubModInstaller.buildManifest(plan('v1.2.3', 'Mod.zip'), '/cache/Mod.zip');

        expect(manifest.getName()).toBe('Some_Owner-CoolMod');
        expect(manifest.getAuthorName()).toBe('Some_Owner');
        expect(manifest.getDisplayName()).toBe('CoolMod');
        expect(manifest.getDescription()).toBe('Does cool things');
        expect(manifest.getDependencies()).toStrictEqual(['BepInEx-BepInExPack-5.4.2100']);
        expect(manifest.getVersionNumber().toString()).toBe('1.2.3');
        expect(manifest.getWebsiteUrl()).toBe('https://github.com/Some-Owner/cool.mod');
        expect(manifest.getGitHubSource()).toMatchObject({ repository: 'Some-Owner/cool.mod', tag: 'v1.2.3', assetName: 'Mod.zip' });
    });

    test('buildManifest falls back to repository name without manifest.json', async () => {
        zipProvider.manifests['/cache/Plain.zip'] = null;
        const manifest = await GitHubModInstaller.buildManifest(plan('2.0.0', 'Plain.zip'), '/cache/Plain.zip');

        expect(manifest.getName()).toBe('Some_Owner-cool_mod');
        expect(manifest.getVersionNumber().toString()).toBe('2.0.0');
    });

    test('buildManifest uses the manifest version when the tag has none', async () => {
        zipProvider.manifests['/cache/Tagless.zip'] = JSON.stringify({ name: 'X', version_number: '3.1.4' });
        const manifest = await GitHubModInstaller.buildManifest(plan('latest', 'Tagless.zip'), '/cache/Tagless.zip');
        expect(manifest.getVersionNumber().toString()).toBe('3.1.4');
    });

    test('buildManifest rejects when no version can be determined', async () => {
        zipProvider.manifests['/cache/NoVersion.zip'] = JSON.stringify({ name: 'X' });
        await expect(GitHubModInstaller.buildManifest(plan('latest', 'NoVersion.zip'), '/cache/NoVersion.zip')).rejects.toBeInstanceOf(R2Error);
    });

    test('buildManifest handles dll assets without reading a manifest', async () => {
        const manifest = await GitHubModInstaller.buildManifest(plan('v0.1.0', 'Mod.dll'), '/cache/Mod.dll');
        expect(manifest.getName()).toBe('Some_Owner-cool_mod');
        expect(manifest.getVersionNumber().toString()).toBe('0.1.0');
    });
});
