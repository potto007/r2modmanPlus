import R2Error from '../../model/errors/R2Error';
import Game from '../../model/game/Game';
import { ImmutableProfile } from '../../model/Profile';
import FsProvider from '../../providers/generic/file/FsProvider';
import path from '../../providers/node/path/path';
import FileUtils from '../../utils/FileUtils';
import GitHubClient, { GitHubRepositoryRef, parseRepository, repositoryToString, utf8ToBase64 } from '../github/GitHubClient';
import PathResolver from '../manager/PathResolver';
import ProfileModList from '../mods/ProfileModList';
import ProfileFingerprint from './ProfileFingerprint';

export enum SyncStatus {
    /** Profile is not linked to a remote. */
    OFF = 'OFF',
    SYNCED = 'SYNCED',
    LOCAL_CHANGES = 'LOCAL_CHANGES',
    REMOTE_CHANGES = 'REMOTE_CHANGES',
    CONFLICT = 'CONFLICT',
    /** Linked, but the remote files are gone. */
    MISSING = 'MISSING',
}

export interface SyncState {
    /** "owner/name" */
    repository: string;
    /** Path of profile.r2z inside the repository. */
    remotePath: string;
    /** Blob sha of profile.r2z at the last push or pull. */
    remoteSha: string;
    /** Epoch millis of the last push or pull. */
    syncedAt: number;
    /** ProfileFingerprint at the last push or pull. */
    fingerprint: string;
}

export interface SyncStatusReport {
    status: SyncStatus;
    state: SyncState | null;
    remoteSha: string | null;
    localFingerprint: string | null;
}

export interface RemoteProfileEntry {
    name: string;
    directory: string;
}

/** Thrown by push when linking a profile whose remote already exists. */
export class RemoteProfileExistsError extends R2Error {
    public readonly remoteSha: string;

    constructor(profileName: string, remoteSha: string) {
        super(
            'A synced profile with this name already exists',
            `The repository already contains a profile called "${profileName}" for this game.`,
            'Overwrite the remote profile with this one, or replace this profile with the remote one.'
        );
        this.remoteSha = remoteSha;
        // R2Error pins the prototype to itself; restore ours so instanceof works.
        Object.setPrototypeOf(this, RemoteProfileExistsError.prototype);
    }
}

/** Thrown by push when the remote moved since the last sync. */
export class SyncConflictError extends R2Error {
    constructor() {
        super(
            'Profile changed on both sides',
            'The remote profile was updated since this profile was last synced, and this profile also has local changes.',
            'Push to overwrite the remote with your changes, or pull to replace your changes with the remote.'
        );
        Object.setPrototypeOf(this, SyncConflictError.prototype);
    }
}

const STATE_FILE = 'sync.json';
const ZIP_NAME = 'profile.r2z';
const MANIFEST_NAME = 'export.r2x';

/**
 * Profile sync against a GitHub repository. Pure remote and state handling;
 * applying a pulled snapshot goes through the regular import pipeline in the
 * profileSync store module.
 */
export default class ProfileSync {

    public static readonly MAX_SYNC_SIZE = 50 * 1000 * 1000; // 50 MB, under GitHub's 100 MB raw limit.

    private static clientFactory: () => GitHubClient = () => new GitHubClient();

    /** Test hook. */
    public static provideClient(factory: () => GitHubClient) {
        this.clientFactory = factory;
    }

    private static client(): GitHubClient {
        return this.clientFactory();
    }

    public static remoteDirectory(game: Game, profileName: string): string {
        return `profiles/${game.internalFolderName}/${profileName}`;
    }

    public static remoteZipPath(game: Game, profileName: string): string {
        return `${this.remoteDirectory(game, profileName)}/${ZIP_NAME}`;
    }

    private static remoteManifestPath(zipPath: string): string {
        return zipPath.substring(0, zipPath.length - ZIP_NAME.length) + MANIFEST_NAME;
    }

    private static statePath(profile: ImmutableProfile): string {
        return profile.joinToProfilePath('_state', STATE_FILE);
    }

    public static async readState(profile: ImmutableProfile): Promise<SyncState | null> {
        const fs = FsProvider.instance;
        const statePath = this.statePath(profile);
        if (!await fs.exists(statePath)) {
            return null;
        }
        try {
            const parsed = JSON.parse((await fs.readFile(statePath)).toString());
            if (
                typeof parsed.repository !== 'string'
                || typeof parsed.remotePath !== 'string'
                || typeof parsed.remoteSha !== 'string'
                || typeof parsed.fingerprint !== 'string'
            ) {
                return null;
            }
            return {
                repository: parsed.repository,
                remotePath: parsed.remotePath,
                remoteSha: parsed.remoteSha,
                syncedAt: typeof parsed.syncedAt === 'number' ? parsed.syncedAt : 0,
                fingerprint: parsed.fingerprint,
            };
        } catch (e) {
            console.warn(`Ignoring unreadable sync state for ${profile.getProfileName()}`, e);
            return null;
        }
    }

    public static async writeState(profile: ImmutableProfile, state: SyncState): Promise<void> {
        await FileUtils.ensureDirectory(profile.joinToProfilePath('_state'));
        await FsProvider.instance.writeFile(this.statePath(profile), JSON.stringify(state, null, 2));
    }

    public static async clearState(profile: ImmutableProfile): Promise<void> {
        const fs = FsProvider.instance;
        const statePath = this.statePath(profile);
        if (await fs.exists(statePath)) {
            await fs.unlink(statePath);
        }
    }

    public static async getStatus(profile: ImmutableProfile): Promise<SyncStatusReport> {
        const state = await this.readState(profile);
        if (state === null) {
            return { status: SyncStatus.OFF, state: null, remoteSha: null, localFingerprint: null };
        }
        const repository = parseRepository(state.repository);
        const meta = await this.client().getContentMeta(repository, state.remotePath);
        const localFingerprint = await ProfileFingerprint.compute(profile);
        if (meta === null) {
            return { status: SyncStatus.MISSING, state, remoteSha: null, localFingerprint };
        }
        const remoteChanged = meta.sha !== state.remoteSha;
        const localChanged = localFingerprint !== state.fingerprint;
        let status: SyncStatus;
        if (remoteChanged && localChanged) {
            status = SyncStatus.CONFLICT;
        } else if (remoteChanged) {
            status = SyncStatus.REMOTE_CHANGES;
        } else if (localChanged) {
            status = SyncStatus.LOCAL_CHANGES;
        } else {
            status = SyncStatus.SYNCED;
        }
        return { status, state, remoteSha: meta.sha, localFingerprint };
    }

    private static async exportDirectory(): Promise<string> {
        const dir = path.join(PathResolver.MOD_ROOT, 'exports', '_sync');
        await FileUtils.ensureDirectory(dir);
        return dir;
    }

    /**
     * Uploads the profile. Without a prior state (linking), an existing
     * remote raises RemoteProfileExistsError unless force is set. With a
     * state, a moved remote raises SyncConflictError unless force is set.
     */
    public static async push(
        profile: ImmutableProfile,
        game: Game,
        repositoryInput: string,
        force: boolean = false
    ): Promise<SyncState> {
        const repository = parseRepository(repositoryInput);
        const client = this.client();
        const existing = await this.readState(profile);
        const zipPath = existing ? existing.remotePath : this.remoteZipPath(game, profile.getProfileName());
        const manifestPath = this.remoteManifestPath(zipPath);

        const remoteZip = await client.getContentMeta(repository, zipPath);
        if (remoteZip !== null) {
            if (existing === null && !force) {
                throw new RemoteProfileExistsError(profile.getProfileName(), remoteZip.sha);
            }
            if (existing !== null && remoteZip.sha !== existing.remoteSha && !force) {
                throw new SyncConflictError();
            }
        }
        const remoteManifest = await client.getContentMeta(repository, manifestPath);

        const fingerprint = await ProfileFingerprint.compute(profile);
        const manifestYaml = await ProfileModList.createExportManifest(profile);
        if (manifestYaml instanceof R2Error) {
            throw manifestYaml;
        }
        const builder = await ProfileModList.createExport(profile);
        if (builder instanceof R2Error) {
            throw builder;
        }
        const fs = FsProvider.instance;
        const localZip = path.join(await this.exportDirectory(), `${profile.getProfileName()}.r2z`);
        await builder.createZip(localZip);
        const stats = await fs.lstat(localZip);
        if (stats.size > this.MAX_SYNC_SIZE) {
            throw new R2Error(
                'The profile is too large to sync',
                `Exported profile size is ${FileUtils.humanReadableSize(stats.size)} while the maximum supported size is ${FileUtils.humanReadableSize(this.MAX_SYNC_SIZE)}.`,
                'Remove large files from the BepInEx/config folder of the profile.'
            );
        }

        const message = `Sync ${game.internalFolderName}/${profile.getProfileName()} from r2modman`;
        const zipResult = await client.putContent(
            repository,
            zipPath,
            await fs.base64FromZip(localZip),
            message,
            remoteZip ? remoteZip.sha : undefined
        );
        await client.putContent(
            repository,
            manifestPath,
            utf8ToBase64(manifestYaml),
            message,
            remoteManifest ? remoteManifest.sha : undefined
        );

        const state: SyncState = {
            repository: repositoryToString(repository),
            remotePath: zipPath,
            remoteSha: zipResult.contentSha,
            syncedAt: Date.now(),
            fingerprint,
        };
        await this.writeState(profile, state);
        return state;
    }

    /**
     * Downloads the remote snapshot into the import cache. Returns the local
     * zip path and the blob sha it corresponds to.
     */
    public static async fetchSnapshot(
        repositoryInput: string,
        remoteZipPath: string,
        onProgress?: (loadedBytes: number) => void
    ): Promise<{ zipPath: string, remoteSha: string }> {
        const repository = parseRepository(repositoryInput);
        const client = this.client();
        const meta = await client.getContentMeta(repository, remoteZipPath);
        if (meta === null) {
            throw new R2Error(
                'Synced profile not found',
                `${remoteZipPath} does not exist in ${repositoryToString(repository)}.`,
                'The remote profile may have been deleted. Unlink the profile or push it again.'
            );
        }
        if (meta.size > this.MAX_SYNC_SIZE) {
            throw new R2Error(
                'The remote profile is too large to download',
                `Remote size is ${FileUtils.humanReadableSize(meta.size)}; the maximum is ${FileUtils.humanReadableSize(this.MAX_SYNC_SIZE)}.`,
                null
            );
        }
        const bytes = await client.getRawContent(repository, remoteZipPath, onProgress);
        const cacheDir = path.join(PathResolver.ROOT, '_import_cache', 'sync');
        await FileUtils.ensureDirectory(cacheDir);
        const zipPath = path.join(cacheDir, `${meta.sha}.r2z`);
        await FsProvider.instance.writeFile(zipPath, bytes);
        return { zipPath, remoteSha: meta.sha };
    }

    /** Records that the local profile now mirrors the given remote blob. */
    public static async markSynced(
        profile: ImmutableProfile,
        repositoryInput: string,
        remoteZipPath: string,
        remoteSha: string
    ): Promise<SyncState> {
        const state: SyncState = {
            repository: repositoryToString(parseRepository(repositoryInput)),
            remotePath: remoteZipPath,
            remoteSha,
            syncedAt: Date.now(),
            fingerprint: await ProfileFingerprint.compute(profile),
        };
        await this.writeState(profile, state);
        return state;
    }

    public static async listRemoteProfiles(repositoryInput: string, game: Game): Promise<RemoteProfileEntry[]> {
        const repository = parseRepository(repositoryInput);
        const entries = await this.client().listDirectory(repository, `profiles/${game.internalFolderName}`);
        return entries
            .filter((entry) => entry.type === 'dir')
            .map((entry) => ({ name: entry.name, directory: entry.path }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Reads the remote manifest without downloading the snapshot. */
    public static async fetchRemoteManifest(repositoryInput: string, directory: string): Promise<string | null> {
        const repository = parseRepository(repositoryInput);
        const meta = await this.client().getContentMeta(repository, `${directory}/${MANIFEST_NAME}`);
        if (meta === null) {
            return null;
        }
        const bytes = await this.client().getRawContent(repository, `${directory}/${MANIFEST_NAME}`);
        return new TextDecoder().decode(bytes);
    }

    public static async unlink(profile: ImmutableProfile, deleteRemote: boolean): Promise<void> {
        const state = await this.readState(profile);
        if (state !== null && deleteRemote) {
            const repository = parseRepository(state.repository);
            const client = this.client();
            const message = `Remove synced profile ${profile.getProfileName()} from r2modman`;
            for (const remotePath of [state.remotePath, this.remoteManifestPath(state.remotePath)]) {
                const meta = await client.getContentMeta(repository, remotePath);
                if (meta !== null) {
                    await client.deleteContent(repository, remotePath, message, meta.sha);
                }
            }
        }
        await this.clearState(profile);
    }

    public static describeRepository(repository: GitHubRepositoryRef): string {
        return repositoryToString(repository);
    }
}
