import { beforeAll, describe, expect, test } from 'vitest';
import { dump as stringifyYaml } from 'js-yaml';
import { providePathImplementation } from '../../../../../src/providers/node/path/path';
import { TestPathProvider } from '../../../stubs/providers/node/Node.Path.Provider';
import ExportFormat from '../../../../../src/model/exports/ExportFormat';
import ExportMod from '../../../../../src/model/exports/ExportMod';
import GitHubModSource from '../../../../../src/model/github/GitHubModSource';
import ManifestV2 from '../../../../../src/model/ManifestV2';
import VersionNumber from '../../../../../src/model/VersionNumber';
import { parseYamlToExportFormat } from '../../../../../src/utils/ProfileUtils';

describe('ExportMod with GitHub source', () => {

    beforeAll(() => {
        providePathImplementation(() => TestPathProvider);
    });

    test('round-trips through export.r2x YAML', async () => {
        const source = new GitHubModSource('owner/repo', 'v1.2.3', 'Mod.zip');
        const format = new ExportFormat('MyProfile', [
            new ExportMod('Author-TsMod', new VersionNumber('1.0.0'), true),
            new ExportMod('owner-repo', new VersionNumber('1.2.3'), false, source),
        ]);

        const yaml = stringifyYaml(format);
        const parsed = await parseYamlToExportFormat(yaml);

        expect(parsed.getProfileName()).toBe('MyProfile');
        const [tsMod, ghMod] = parsed.getMods();
        expect(tsMod!.isFromGitHub()).toBe(false);
        expect(tsMod!.getGitHubSource()).toBeNull();
        expect(ghMod!.isFromGitHub()).toBe(true);
        expect(ghMod!.isEnabled()).toBe(false);
        expect(ghMod!.getGitHubSource()!.equals(source)).toBe(true);
    });

    test('omits githubSource from YAML for Thunderstore mods', () => {
        const yaml = stringifyYaml(new ExportFormat('P', [new ExportMod('A-B', new VersionNumber('1.0.0'), true)]));
        expect(yaml).not.toContain('githubSource');
    });

    test('ignores malformed githubSource blocks', async () => {
        const yaml = [
            'profileName: P',
            'mods:',
            '  - name: A-B',
            '    version: {major: 1, minor: 0, patch: 0}',
            '    enabled: true',
            '    githubSource: {repository: only}',
        ].join('\n');
        const parsed = await parseYamlToExportFormat(yaml);
        expect(parsed.getMods()[0]!.isFromGitHub()).toBe(false);
    });

    test('ManifestV2 carries the source through mods.yml serialisation', () => {
        const manifest = new ManifestV2();
        manifest.setName('owner-repo');
        manifest.setVersionNumber(new VersionNumber('1.2.3'));
        manifest.setGitHubSource(new GitHubModSource('owner/repo', 'v1.2.3', 'Mod.zip'));

        const restored = new ManifestV2().fromJsObject(JSON.parse(JSON.stringify(manifest)));
        expect(restored.isFromGitHub()).toBe(true);
        expect(restored.getGitHubSource()).toMatchObject({ repository: 'owner/repo', tag: 'v1.2.3', assetName: 'Mod.zip' });

        const exported = ExportMod.fromManifest(restored);
        expect(exported.getGitHubSource()!.tag).toBe('v1.2.3');
    });

    test('ManifestV2 without the field reports no GitHub source', () => {
        const restored = new ManifestV2().fromJsObject({
            name: 'A-B',
            versionNumber: { major: 1, minor: 0, patch: 0 },
            enabled: true,
        });
        expect(restored.isFromGitHub()).toBe(false);
    });
});
