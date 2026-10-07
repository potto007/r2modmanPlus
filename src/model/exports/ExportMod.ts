import VersionNumber from '../VersionNumber';
import ManifestV2 from '../ManifestV2';
import GitHubModSource from '../github/GitHubModSource';

export default class ExportMod {
    private readonly name: string = '';
    private readonly version: VersionNumber = new VersionNumber('0.0.0');
    private readonly enabled: boolean = false;
    // Omitted from YAML when undefined, which keeps exports readable by
    // managers that predate GitHub-sourced mods.
    private readonly githubSource?: GitHubModSource;

    public constructor(name: string, versionNumber: VersionNumber, enabled: boolean, githubSource?: GitHubModSource | null) {
        this.name = name;
        this.version = versionNumber;
        this.enabled = enabled;
        if (githubSource) {
            this.githubSource = githubSource;
        }
    }

    public static fromManifest(mod: ManifestV2): ExportMod {
        const exportFormat = new ExportMod(mod.getName(), mod.getVersionNumber(), mod.isEnabled(), mod.getGitHubSource());
        return exportFormat;
    }

    public static fromFullString(modStr: string): ExportMod {
        const name = modStr.match(new RegExp("(.+)-\\d+\\.\\d+\\.\\d+$"));
        let resolvedName: string;
        if (name !== null) {
            resolvedName = name[1]!;
        } else {
            resolvedName = "";
        }
        const version = modStr.match(new RegExp("\\d+\\.\\d+\\.\\d+$"));
        let resolvedVersion: VersionNumber;
        if (version !== null) {
            resolvedVersion = new VersionNumber(version[0]);
        } else {
            resolvedVersion = new VersionNumber("0.0.0");
        }
        return new ExportMod(resolvedName, resolvedVersion, true);
    }

    public getName(): string {
        return this.name;
    }

    public getVersionNumber(): VersionNumber {
        return this.version;
    }

    public getDependencyString(): string {
        return `${this.name}-${this.version}`;
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public getGitHubSource(): GitHubModSource | null {
        return this.githubSource ?? null;
    }

    public isFromGitHub(): boolean {
        return this.githubSource !== undefined;
    }
}
