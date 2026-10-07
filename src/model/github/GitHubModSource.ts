/**
 * Where a mod installed from a GitHub release came from. Serialised as-is
 * into mods.yml and export.r2x.
 */
export default class GitHubModSource {
    /** "owner/name" */
    public readonly repository: string;
    /** Release tag the asset was taken from, e.g. "v1.2.3". */
    public readonly tag: string;
    /** File name of the release asset that was installed. */
    public readonly assetName: string;

    public constructor(repository: string, tag: string, assetName: string) {
        this.repository = repository;
        this.tag = tag;
        this.assetName = assetName;
    }

    public static fromJsObject(value: any): GitHubModSource | null {
        if (
            !value
            || typeof value.repository !== 'string'
            || typeof value.tag !== 'string'
            || typeof value.assetName !== 'string'
        ) {
            return null;
        }
        return new GitHubModSource(value.repository, value.tag, value.assetName);
    }

    public equals(other: GitHubModSource | null): boolean {
        return other !== null
            && other.repository === this.repository
            && other.tag === this.tag
            && other.assetName === this.assetName;
    }
}
