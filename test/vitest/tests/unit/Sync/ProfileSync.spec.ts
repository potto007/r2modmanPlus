import * as path from 'path';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import InMemoryFsProvider from '../../../stubs/providers/InMemory.FsProvider';
import { TestPathProvider } from '../../../stubs/providers/node/Node.Path.Provider';
import GameManager from '../../../../../src/model/game/GameManager';
import Game from '../../../../../src/model/game/Game';
import ManifestV2 from '../../../../../src/model/ManifestV2';
import Profile, { ImmutableProfile } from '../../../../../src/model/Profile';
import VersionNumber from '../../../../../src/model/VersionNumber';
import { Platform } from '../../../../../src/model/schema/ThunderstoreSchema';
import FsProvider from '../../../../../src/providers/generic/file/FsProvider';
import ZipProvider from '../../../../../src/providers/generic/zip/ZipProvider';
import ZipBuilder from '../../../../../src/providers/generic/zip/ZipBuilder';
import ZipEntryInterface from '../../../../../src/providers/generic/zip/ZipEntryInterface';
import ProfileProvider from '../../../../../src/providers/ror2/model_implementation/ProfileProvider';
import { providePathImplementation } from '../../../../../src/providers/node/path/path';
import { provideBufferImplementation } from '../../../../../src/providers/node/buffer/buffer';
import { updateEcosystemReactives } from '../../../../../src/r2mm/ecosystem/EcosystemSchema';
import GitHubClient, { GitHubContentMeta, GitHubPutResult, GitHubRepositoryRef } from '../../../../../src/r2mm/github/GitHubClient';
import PathResolver from '../../../../../src/r2mm/manager/PathResolver';
import ProfileModList from '../../../../../src/r2mm/mods/ProfileModList';
import ProfileFingerprint from '../../../../../src/r2mm/sync/ProfileFingerprint';
import ProfileSync, { RemoteProfileExistsError, SyncConflictError, SyncStatus } from '../../../../../src/r2mm/sync/ProfileSync';

class ProfileProviderImpl extends ProfileProvider {
    ensureProfileDirectory(directory: string, profile: string): void {
        FsProvider.instance.mkdirs(path.join(directory, profile));
    }
}

/** Writes an empty marker file so lstat and base64FromZip work. */
class FakeZipBuilder extends ZipBuilder {
    public entries: string[] = [];
    async addBuffer(fileName: string): Promise<void> { this.entries.push(fileName); }
    async addFolder(zippedFolderName: string): Promise<void> { this.entries.push(zippedFolderName + '/'); }
    async createZip(outputPath: string): Promise<void> {
        await FsProvider.instance.mkdirs(path.dirname(outputPath));
        await FsProvider.instance.writeFile(outputPath, 'zip:' + this.entries.join(','));
    }
}

class FakeZipProvider extends ZipProvider {
    async extractAllTo(): Promise<void> {}
    async readFile(): Promise<Buffer | null> { return null; }
    async getEntries(): Promise<ZipEntryInterface[]> { return []; }
    async extractEntryTo(): Promise<void> {}
    zipBuilder(): ZipBuilder { return new FakeZipBuilder(); }
}

/** In-memory stand-in for the GitHub Contents API. */
class FakeGitHubClient extends GitHubClient {
    public files = new Map<string, { sha: string, content: string }>();
    private counter = 0;
    public puts: { path: string, sha: string | undefined }[] = [];

    constructor() {
        super(async () => 'token');
    }

    private key(repo: GitHubRepositoryRef, p: string) {
        return `${repo.owner}/${repo.name}:${p}`;
    }

    /** Simulates another client changing the remote. */
    public bump(repo: string, p: string, content = 'changed') {
        const sha = `sha-${++this.counter}`;
        this.files.set(`${repo}:${p}`, { sha, content });
        return sha;
    }

    public remove(repo: string, p: string) {
        this.files.delete(`${repo}:${p}`);
    }

    override async getContentMeta(repo: GitHubRepositoryRef, p: string): Promise<GitHubContentMeta | null> {
        const file = this.files.get(this.key(repo, p));
        if (!file) {
            return null;
        }
        return { type: 'file', name: path.basename(p), path: p, sha: file.sha, size: file.content.length };
    }

    override async listDirectory(repo: GitHubRepositoryRef, p: string): Promise<GitHubContentMeta[]> {
        const prefix = `${repo.owner}/${repo.name}:${p}/`;
        const names = new Set<string>();
        for (const key of this.files.keys()) {
            if (key.startsWith(prefix)) {
                names.add(key.substring(prefix.length).split('/')[0]!);
            }
        }
        return Array.from(names).map((name) => ({ type: 'dir', name, path: `${p}/${name}`, sha: '', size: 0 }));
    }

    override async getRawContent(repo: GitHubRepositoryRef, p: string): Promise<Buffer> {
        const file = this.files.get(this.key(repo, p));
        if (!file) {
            throw new Error('missing');
        }
        return Buffer.from(file.content);
    }

    override async putContent(repo: GitHubRepositoryRef, p: string, contentBase64: string, _message: string, sha?: string): Promise<GitHubPutResult> {
        const existing = this.files.get(this.key(repo, p));
        if (existing && existing.sha !== sha) {
            throw new Error('409 sha mismatch');
        }
        const newSha = `sha-${++this.counter}`;
        this.files.set(this.key(repo, p), { sha: newSha, content: contentBase64 });
        this.puts.push({ path: p, sha });
        return { contentSha: newSha, commitSha: `commit-${this.counter}` };
    }

    override async deleteContent(repo: GitHubRepositoryRef, p: string): Promise<void> {
        this.files.delete(this.key(repo, p));
    }
}

const REPO = 'me/profiles';
let client: FakeGitHubClient;
let game: Game;
let profile: ImmutableProfile;

function mod(name: string, version = '1.0.0'): ManifestV2 {
    const m = new ManifestV2();
    m.setName(name);
    m.setAuthorName(name.split('-')[0]!);
    m.setDisplayName(name.split('-')[1]!);
    m.setVersionNumber(new VersionNumber(version));
    return m;
}

async function setMods(names: string[]) {
    const err = await ProfileModList.saveModList(profile, names.map((n) => mod(n)));
    expect(err).toBeNull();
}

async function writeConfig(name: string, content: string) {
    const dir = profile.joinToProfilePath('BepInEx', 'config');
    await FsProvider.instance.mkdirs(dir);
    await FsProvider.instance.writeFile(path.join(dir, name), content);
}

describe('ProfileSync', () => {

    beforeAll(async () => {
        providePathImplementation(() => TestPathProvider);
        provideBufferImplementation(() => ({ from: (data, encoding) => Buffer.from(data, encoding) }));
        FsProvider.provide(() => new InMemoryFsProvider());
        ProfileProvider.provide(() => new ProfileProviderImpl());
        ZipProvider.provide(() => new FakeZipProvider());
        await updateEcosystemReactives();
        game = GameManager.gameList.find((g) => g.internalFolderName === 'RiskOfRain2')!;
        PathResolver.ROOT = path.join('root');
        await GameManager.activate(game, Platform.STEAM);
    });

    beforeEach(async () => {
        InMemoryFsProvider.clear();
        await FsProvider.instance.mkdirs(PathResolver.MOD_ROOT);
        client = new FakeGitHubClient();
        ProfileSync.provideClient(() => client);
        profile = new Profile('Synced').asImmutableProfile();
        await FsProvider.instance.mkdirs(profile.getProfilePath());
        await setMods(['Author-ModA']);
        await writeConfig('a.cfg', 'x=1');
    });

    test('remote paths follow the game and profile name', () => {
        expect(ProfileSync.remoteZipPath(game, 'Synced')).toBe('profiles/RiskOfRain2/Synced/profile.r2z');
    });

    test('fingerprint is stable and changes with mods or config', async () => {
        const first = await ProfileFingerprint.compute(profile);
        expect(await ProfileFingerprint.compute(profile)).toBe(first);

        await setMods(['Author-ModA', 'Author-ModB']);
        const withMod = await ProfileFingerprint.compute(profile);
        expect(withMod).not.toBe(first);

        await writeConfig('a.cfg', 'x=2');
        expect(await ProfileFingerprint.compute(profile)).not.toBe(withMod);
    });

    test('fingerprint ignores _state and mods.yml ordering of unrelated files', async () => {
        const first = await ProfileFingerprint.compute(profile);
        await FsProvider.instance.mkdirs(profile.joinToProfilePath('_state'));
        await FsProvider.instance.writeFile(profile.joinToProfilePath('_state', 'sync.json'), '{}');
        expect(await ProfileFingerprint.compute(profile)).toBe(first);
    });

    test('status is OFF before linking', async () => {
        const report = await ProfileSync.getStatus(profile);
        expect(report.status).toBe(SyncStatus.OFF);
        expect(report.state).toBeNull();
    });

    test('push links the profile and uploads zip and manifest', async () => {
        const state = await ProfileSync.push(profile, game, REPO);

        expect(state.repository).toBe(REPO);
        expect(state.remotePath).toBe('profiles/RiskOfRain2/Synced/profile.r2z');
        expect(client.files.has(`${REPO}:profiles/RiskOfRain2/Synced/profile.r2z`)).toBe(true);
        expect(client.files.has(`${REPO}:profiles/RiskOfRain2/Synced/export.r2x`)).toBe(true);
        expect(client.puts.every((p) => p.sha === undefined)).toBe(true);

        const stored = await ProfileSync.readState(profile);
        expect(stored).toStrictEqual(state);
        expect((await ProfileSync.getStatus(profile)).status).toBe(SyncStatus.SYNCED);
    });

    test('push accepts a repository URL', async () => {
        const state = await ProfileSync.push(profile, game, 'https://github.com/me/profiles');
        expect(state.repository).toBe(REPO);
    });

    test('status matrix', async () => {
        await ProfileSync.push(profile, game, REPO);

        await setMods(['Author-ModA', 'Author-ModB']);
        expect((await ProfileSync.getStatus(profile)).status).toBe(SyncStatus.LOCAL_CHANGES);

        await setMods(['Author-ModA']);
        client.bump(REPO, 'profiles/RiskOfRain2/Synced/profile.r2z');
        expect((await ProfileSync.getStatus(profile)).status).toBe(SyncStatus.REMOTE_CHANGES);

        await setMods(['Author-ModA', 'Author-ModB']);
        expect((await ProfileSync.getStatus(profile)).status).toBe(SyncStatus.CONFLICT);

        client.remove(REPO, 'profiles/RiskOfRain2/Synced/profile.r2z');
        expect((await ProfileSync.getStatus(profile)).status).toBe(SyncStatus.MISSING);
    });

    test('second push sends the stored sha and refreshes it', async () => {
        const first = await ProfileSync.push(profile, game, REPO);
        await setMods(['Author-ModA', 'Author-ModB']);
        const second = await ProfileSync.push(profile, game, REPO);

        expect(client.puts[2]!.sha).toBe(first.remoteSha);
        expect(second.remoteSha).not.toBe(first.remoteSha);
        expect((await ProfileSync.getStatus(profile)).status).toBe(SyncStatus.SYNCED);
    });

    test('push refuses to clobber a moved remote unless forced', async () => {
        await ProfileSync.push(profile, game, REPO);
        const movedSha = client.bump(REPO, 'profiles/RiskOfRain2/Synced/profile.r2z');

        await expect(ProfileSync.push(profile, game, REPO)).rejects.toBeInstanceOf(SyncConflictError);

        const forced = await ProfileSync.push(profile, game, REPO, true);
        expect(client.puts[client.puts.length - 2]!.sha).toBe(movedSha);
        expect(forced.remoteSha).not.toBe(movedSha);
    });

    test('linking over an existing remote profile is refused unless forced', async () => {
        client.bump(REPO, 'profiles/RiskOfRain2/Synced/profile.r2z');

        await expect(ProfileSync.push(profile, game, REPO)).rejects.toBeInstanceOf(RemoteProfileExistsError);
        const state = await ProfileSync.push(profile, game, REPO, true);
        expect(state.remoteSha).toMatch(/^sha-/);
    });

    test('push rejects oversized exports', async () => {
        const original = ProfileSync.MAX_SYNC_SIZE;
        (ProfileSync as any).MAX_SYNC_SIZE = 1;
        try {
            await expect(ProfileSync.push(profile, game, REPO)).rejects.toThrow(/maximum supported size/);
        } finally {
            (ProfileSync as any).MAX_SYNC_SIZE = original;
        }
    });

    test('markSynced records the remote sha and current fingerprint', async () => {
        const state = await ProfileSync.markSynced(profile, REPO, 'profiles/RiskOfRain2/Synced/profile.r2z', 'abc');
        expect(state.remoteSha).toBe('abc');
        expect(state.fingerprint).toBe(await ProfileFingerprint.compute(profile));
    });

    test('fetchSnapshot writes the remote zip to the import cache', async () => {
        const sha = client.bump(REPO, 'profiles/RiskOfRain2/Synced/profile.r2z', 'zipbytes');
        const result = await ProfileSync.fetchSnapshot(REPO, 'profiles/RiskOfRain2/Synced/profile.r2z');

        expect(result.remoteSha).toBe(sha);
        expect(result.zipPath).toContain('_import_cache');
        expect((await FsProvider.instance.readFile(result.zipPath)).toString()).toBe('zipbytes');
    });

    test('fetchSnapshot fails clearly when the remote is gone', async () => {
        await expect(ProfileSync.fetchSnapshot(REPO, 'profiles/RiskOfRain2/Nope/profile.r2z')).rejects.toThrow(/does not exist/);
    });

    test('listRemoteProfiles returns directory names for the active game', async () => {
        client.bump(REPO, 'profiles/RiskOfRain2/Beta/profile.r2z');
        client.bump(REPO, 'profiles/RiskOfRain2/Alpha/profile.r2z');
        client.bump(REPO, 'profiles/Valheim/Other/profile.r2z');

        const remote = await ProfileSync.listRemoteProfiles(REPO, game);
        expect(remote.map((r) => r.name)).toStrictEqual(['Alpha', 'Beta']);
    });

    test('unlink clears state and optionally deletes the remote', async () => {
        await ProfileSync.push(profile, game, REPO);
        await ProfileSync.unlink(profile, false);
        expect(await ProfileSync.readState(profile)).toBeNull();
        expect(client.files.size).toBe(2);

        await ProfileSync.push(profile, game, REPO, true);
        await ProfileSync.unlink(profile, true);
        expect(client.files.size).toBe(0);
    });

    test('unreadable state is treated as unlinked', async () => {
        await FsProvider.instance.mkdirs(profile.joinToProfilePath('_state'));
        await FsProvider.instance.writeFile(profile.joinToProfilePath('_state', 'sync.json'), 'not json');
        expect(await ProfileSync.readState(profile)).toBeNull();
    });
});
