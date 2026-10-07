import R2Error, { throwForR2Error } from '../../model/errors/R2Error';
import ExportMod from '../../model/exports/ExportMod';
import GitHubModSource from '../../model/github/GitHubModSource';
import ManifestV2 from '../../model/ManifestV2';
import { ImmutableProfile } from '../../model/Profile';
import VersionNumber from '../../model/VersionNumber';
import FsProvider from '../../providers/generic/file/FsProvider';
import ZipProvider from '../../providers/generic/zip/ZipProvider';
import path from '../../providers/node/path/path';
import LocalModInstallerProvider from '../../providers/ror2/installing/LocalModInstallerProvider';
import ProfileInstallerProvider from '../../providers/ror2/installing/ProfileInstallerProvider';
import FileUtils from '../../utils/FileUtils';
import PathResolver from '../manager/PathResolver';
import ProfileModList from '../mods/ProfileModList';
import GitHubClient, { GitHubRelease, GitHubReleaseAsset, GitHubRepositoryRef, parseRepository, repositoryToString } from './GitHubClient';

export interface GitHubModInstallPlan {
    repository: GitHubRepositoryRef;
    release: GitHubRelease;
    asset: GitHubReleaseAsset;
}

export type GitHubInstallProgress = (status: string, modName?: string, progress?: number) => void;

const INSTALLABLE_EXTENSIONS = ['.zip', '.dll'];

/**
 * Installs mods from GitHub release assets. The downloaded asset is handed to
 * the existing local mod installer, so the result is a regular local mod with
 * a GitHubModSource attached for exports, sync and update checks.
 */
export default class GitHubModInstaller {

    private static clientFactory: () => GitHubClient = () => new GitHubClient();

    /** Test hook. */
    public static provideClient(factory: () => GitHubClient) {
        this.clientFactory = factory;
    }

    private static client(): GitHubClient {
        return this.clientFactory();
    }

    /** Thunderstore package names allow only [A-Za-z0-9_]. */
    public static sanitizeNamePart(value: string): string {
        const safe = value.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
        return safe.length > 0 ? safe : 'Unknown';
    }

    /** "v1.2.3", "1.2.3", "release-1.2" and "1.2.3-beta" all resolve; else null. */
    public static versionFromTag(tag: string): VersionNumber | null {
        const match = tag.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
        if (!match) {
            return null;
        }
        return new VersionNumber(`${match[1]}.${match[2]}.${match[3] ?? '0'}`);
    }

    public static isInstallableAsset(asset: GitHubReleaseAsset): boolean {
        const lower = asset.name.toLowerCase();
        return INSTALLABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
    }

    /** The asset to preselect: the only installable one, else the first zip. */
    public static pickDefaultAsset(release: GitHubRelease): GitHubReleaseAsset | null {
        const installable = release.assets.filter(this.isInstallableAsset);
        if (installable.length === 1) {
            return installable[0]!;
        }
        return installable.find((a) => a.name.toLowerCase().endsWith('.zip')) ?? installable[0] ?? null;
    }

    public static async listReleases(repositoryInput: string): Promise<{ repository: GitHubRepositoryRef, releases: GitHubRelease[] }> {
        const repository = parseRepository(repositoryInput);
        const releases = (await this.client().listReleases(repository)).filter((r) => !r.draft);
        return { repository, releases };
    }

    /** Re-resolves a recorded source to a concrete release and asset. */
    public static async resolveFromSource(source: GitHubModSource): Promise<GitHubModInstallPlan> {
        const repository = parseRepository(source.repository);
        const release = await this.client().getReleaseByTag(repository, source.tag);
        const asset = release.assets.find((a) => a.name === source.assetName) ?? this.pickDefaultAsset(release);
        if (asset === null) {
            throw new R2Error(
                'GitHub release has no installable asset',
                `Release ${source.tag} of ${source.repository} has no .zip or .dll asset.`,
                'Ask the mod author to attach a package to the release.'
            );
        }
        return { repository, release, asset };
    }

    /** Latest release when its tag differs from the installed one, else null. */
    public static async checkForUpdate(source: GitHubModSource): Promise<GitHubRelease | null> {
        const repository = parseRepository(source.repository);
        const latest = await this.client().getLatestRelease(repository);
        return latest.tagName !== source.tag ? latest : null;
    }

    private static async downloadDestination(plan: GitHubModInstallPlan): Promise<string> {
        const dir = path.join(
            PathResolver.ROOT,
            '_import_cache',
            'github',
            `${this.sanitizeNamePart(plan.repository.owner)}_${this.sanitizeNamePart(plan.repository.name)}`,
            this.sanitizeNamePart(plan.release.tagName)
        );
        await FileUtils.ensureDirectory(dir);
        return path.join(dir, plan.asset.name);
    }

    /** Downloads the asset into the import cache and returns its path. */
    public static async download(plan: GitHubModInstallPlan, onProgress?: (loadedBytes: number) => void): Promise<string> {
        const destination = await this.downloadDestination(plan);
        const fs = FsProvider.instance;
        if (await fs.exists(destination)) {
            return destination;
        }
        const bytes = await this.client().downloadReleaseAsset(plan.repository, plan.asset.id, onProgress);
        await fs.writeFile(destination, bytes);
        return destination;
    }

    /**
     * Builds the manifest from manifest.json inside the zip when present,
     * falling back to the repository owner and name. The release tag wins
     * over the manifest version so updates are detectable per release.
     */
    public static async buildManifest(plan: GitHubModInstallPlan, filePath: string): Promise<ManifestV2> {
        const manifest = new ManifestV2();
        const author = this.sanitizeNamePart(plan.repository.owner);
        let displayName = this.sanitizeNamePart(plan.repository.name);
        let description = plan.release.name || '';
        let dependencies: string[] = [];
        let manifestVersion: VersionNumber | null = null;

        if (filePath.toLowerCase().endsWith('.zip')) {
            try {
                const raw = await ZipProvider.instance.readFile(filePath, 'manifest.json');
                if (raw !== null) {
                    const parsed: any = JSON.parse(raw.toString().trim());
                    if (typeof parsed.name === 'string' && parsed.name.length > 0) {
                        displayName = this.sanitizeNamePart(parsed.name);
                    }
                    if (typeof parsed.description === 'string') {
                        description = parsed.description;
                    }
                    if (Array.isArray(parsed.dependencies)) {
                        dependencies = parsed.dependencies.filter((d: unknown) => typeof d === 'string');
                    }
                    if (typeof parsed.version_number === 'string') {
                        manifestVersion = this.versionFromTag(parsed.version_number);
                    }
                }
            } catch (e) {
                // A broken manifest.json is not fatal; the fallbacks apply.
                console.warn(`Could not read manifest.json from ${filePath}`, e);
            }
        }

        const version = this.versionFromTag(plan.release.tagName) ?? manifestVersion;
        if (version === null) {
            throw new R2Error(
                'Could not determine mod version',
                `Neither the release tag "${plan.release.tagName}" nor manifest.json contain a version like 1.2.3.`,
                'Ask the mod author to tag releases with a semantic version.'
            );
        }

        manifest.setAuthorName(author);
        manifest.setDisplayName(displayName);
        manifest.setName(`${author}-${displayName}`);
        manifest.setDescription(description);
        manifest.setDependencies(dependencies);
        manifest.setVersionNumber(version);
        manifest.setWebsiteUrl(`https://github.com/${plan.repository.owner}/${plan.repository.name}`);
        manifest.setGitHubSource(new GitHubModSource(repositoryToString(plan.repository), plan.release.tagName, plan.asset.name));
        return manifest;
    }

    /** Downloads and installs one release asset into the profile. */
    public static async install(
        plan: GitHubModInstallPlan,
        profile: ImmutableProfile,
        onProgress?: (loadedBytes: number) => void
    ): Promise<ManifestV2> {
        const filePath = await this.download(plan, onProgress);
        const manifest = await this.buildManifest(plan, filePath);
        if (filePath.toLowerCase().endsWith('.zip')) {
            await LocalModInstallerProvider.instance.extractToCacheWithManifestData(profile, filePath, manifest);
        } else {
            await LocalModInstallerProvider.instance.placeFileInCache(profile, filePath, manifest);
        }
        return manifest;
    }

    /** Installs GitHub-sourced entries of an export, honouring enabled state. */
    public static async installExportMods(
        mods: ExportMod[],
        profile: ImmutableProfile,
        progressCallback?: GitHubInstallProgress
    ): Promise<void> {
        for (const [index, exportMod] of mods.entries()) {
            const source = exportMod.getGitHubSource();
            if (source === null) {
                continue;
            }
            if (progressCallback) {
                progressCallback('installingGithubMods', exportMod.getName(), Math.floor((index / mods.length) * 100));
            }
            let manifest: ManifestV2;
            try {
                const plan = await this.resolveFromSource(source);
                manifest = await this.install(plan, profile);
            } catch (e) {
                const original = R2Error.fromThrownValue(e);
                throw new R2Error(
                    `Failed to install ${exportMod.getName()} from GitHub`,
                    `${original.name}: ${original.message}`,
                    original.solution || 'Check that the GitHub token in the settings can access the repository.'
                );
            }
            if (!exportMod.isEnabled()) {
                throwForR2Error(await ProfileModList.updateMod(manifest, profile, async (mod) => {
                    throwForR2Error(await ProfileInstallerProvider.instance.disableMod(mod, profile));
                    mod.disable();
                }));
            }
        }
        if (progressCallback) {
            progressCallback('installingGithubMods', undefined, 100);
        }
    }
}
