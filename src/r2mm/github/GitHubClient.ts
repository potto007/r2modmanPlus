import Axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import R2Error from '../../model/errors/R2Error';
import Buffer from '../../providers/node/buffer/buffer';
import { getGitHubToken } from './GitHubAuth';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export interface GitHubRepositoryRef {
    owner: string;
    name: string;
}

export interface GitHubReleaseAsset {
    id: number;
    name: string;
    size: number;
    contentType: string;
}

export interface GitHubRelease {
    id: number;
    tagName: string;
    name: string;
    prerelease: boolean;
    draft: boolean;
    publishedAt: string | null;
    assets: GitHubReleaseAsset[];
}

export interface GitHubContentMeta {
    type: 'file' | 'dir' | 'symlink' | 'submodule';
    name: string;
    path: string;
    sha: string;
    size: number;
}

export interface GitHubPutResult {
    contentSha: string;
    commitSha: string;
}

export class GitHubApiError extends R2Error {
    public readonly status: number;

    constructor(status: number, name: string, message: string, solution: string | null = null) {
        super(name, message, solution);
        this.status = status;
    }
}

/**
 * Accepts "owner/name", "https://github.com/owner/name", "github.com/owner/name"
 * and variants with a trailing ".git" or extra path segments.
 */
export function parseRepository(input: string): GitHubRepositoryRef {
    const trimmed = input.trim().replace(/^git@github\.com:/i, '');
    const withoutScheme = trimmed.replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '');
    const parts = withoutScheme.split('/').filter((p) => p.length > 0);
    const owner = parts[0];
    const name = parts[1] ? parts[1].replace(/\.git$/i, '') : undefined;
    const valid = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/;
    if (!owner || !name || !valid.test(owner) || !valid.test(name)) {
        throw new R2Error(
            'Invalid GitHub repository',
            `"${input}" is not a GitHub repository reference.`,
            'Use the form owner/name or paste the repository URL.'
        );
    }
    return { owner, name };
}

export function repositoryToString(repo: GitHubRepositoryRef): string {
    return `${repo.owner}/${repo.name}`;
}

function toApiError(e: unknown, title: string): R2Error {
    if (Axios.isAxiosError(e)) {
        if (e.response) {
            const status = e.response.status;
            let detail = e.message;
            try {
                detail = e.response.data?.message || e.message;
            } catch {
            }
            switch (status) {
                case 401:
                    return new GitHubApiError(status, title, `401: ${detail}`, 'The GitHub token is missing, invalid or expired. Update it in the settings.');
                case 403:
                    return new GitHubApiError(status, title, `403: ${detail}`, 'The token lacks permission for this repository, or the API rate limit was hit. Check the token scopes and try again later.');
                case 404:
                    return new GitHubApiError(status, title, `404: ${detail}`, 'The repository, release or file does not exist, or the token cannot see it. Private repositories need a token with access.');
                case 409:
                    return new GitHubApiError(status, title, `409: ${detail}`, 'The remote file changed since it was last synced. Refresh the sync status and resolve the conflict.');
                case 422:
                    return new GitHubApiError(status, title, `422: ${detail}`, null);
                default:
                    return new GitHubApiError(status, title, `Failed with code: ${status}.\n${detail}`, null);
            }
        }
        if (e.message === 'Network Error') {
            return new R2Error(title, 'Network error while contacting GitHub.', 'Check your network connection.');
        }
    }
    return R2Error.fromThrownValue(e, title);
}

export default class GitHubClient {

    private readonly tokenProvider: () => Promise<string | null>;

    constructor(tokenProvider: () => Promise<string | null> = getGitHubToken) {
        this.tokenProvider = tokenProvider;
    }

    private async headers(accept: string = 'application/vnd.github+json'): Promise<Record<string, string>> {
        const headers: Record<string, string> = {
            'Accept': accept,
            'X-GitHub-Api-Version': API_VERSION,
        };
        const token = await this.tokenProvider();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        return headers;
    }

    private async request<T>(config: AxiosRequestConfig, title: string, accept?: string): Promise<AxiosResponse<T>> {
        const url = config.url || '';
        const finalConfig: AxiosRequestConfig = {
            method: config.method || 'GET',
            url: url.startsWith('http') ? url : `${API_BASE}${url}`,
            headers: await this.headers(accept),
        };
        if (config.params !== undefined) {
            finalConfig.params = config.params;
        }
        if (config.data !== undefined) {
            finalConfig.data = config.data;
        }
        if (config.responseType !== undefined) {
            finalConfig.responseType = config.responseType;
        }
        if (config.onDownloadProgress !== undefined) {
            finalConfig.onDownloadProgress = config.onDownloadProgress;
        }
        try {
            const response: AxiosResponse<T> = await Axios.request<T>(finalConfig);
            return response;
        } catch (e) {
            throw toApiError(e, title);
        }
    }

    public async getAuthenticatedUser(): Promise<{ login: string }> {
        const response = await this.request<{ login: string }>({ method: 'GET', url: '/user' }, 'Failed to verify GitHub token');
        return { login: response.data.login };
    }

    public async getRepository(repo: GitHubRepositoryRef): Promise<{ fullName: string; private: boolean; defaultBranch: string; permissions?: { push?: boolean } }> {
        const response = await this.request<any>(
            { method: 'GET', url: `/repos/${repo.owner}/${repo.name}` },
            'Failed to read GitHub repository'
        );
        return {
            fullName: response.data.full_name,
            private: Boolean(response.data.private),
            defaultBranch: response.data.default_branch,
            permissions: response.data.permissions,
        };
    }

    private static mapRelease(data: any): GitHubRelease {
        return {
            id: data.id,
            tagName: data.tag_name,
            name: data.name || data.tag_name,
            prerelease: Boolean(data.prerelease),
            draft: Boolean(data.draft),
            publishedAt: data.published_at || null,
            assets: (data.assets || []).map((asset: any): GitHubReleaseAsset => ({
                id: asset.id,
                name: asset.name,
                size: asset.size,
                contentType: asset.content_type,
            })),
        };
    }

    public async listReleases(repo: GitHubRepositoryRef, perPage: number = 30): Promise<GitHubRelease[]> {
        const response = await this.request<any[]>(
            { method: 'GET', url: `/repos/${repo.owner}/${repo.name}/releases`, params: { per_page: perPage } },
            'Failed to list GitHub releases'
        );
        return response.data.map(GitHubClient.mapRelease);
    }

    public async getLatestRelease(repo: GitHubRepositoryRef): Promise<GitHubRelease> {
        const response = await this.request<any>(
            { method: 'GET', url: `/repos/${repo.owner}/${repo.name}/releases/latest` },
            'Failed to read latest GitHub release'
        );
        return GitHubClient.mapRelease(response.data);
    }

    public async getReleaseByTag(repo: GitHubRepositoryRef, tag: string): Promise<GitHubRelease> {
        const response = await this.request<any>(
            { method: 'GET', url: `/repos/${repo.owner}/${repo.name}/releases/tags/${encodeURIComponent(tag)}` },
            'Failed to read GitHub release'
        );
        return GitHubClient.mapRelease(response.data);
    }

    /**
     * Downloads a release asset through the API so private assets work with
     * the token. GitHub answers with a redirect to signed storage; the
     * browser follows it and drops the Authorization header on the way.
     */
    public async downloadReleaseAsset(
        repo: GitHubRepositoryRef,
        assetId: number,
        onProgress?: (loadedBytes: number) => void
    ): Promise<Buffer> {
        const response = await this.request<ArrayBuffer>(
            {
                method: 'GET',
                url: `/repos/${repo.owner}/${repo.name}/releases/assets/${assetId}`,
                responseType: 'arraybuffer',
                onDownloadProgress: (progress) => onProgress && onProgress(progress.loaded),
            },
            'Failed to download GitHub release asset',
            'application/octet-stream'
        );
        return Buffer.from(response.data);
    }

    /** Returns null when the path does not exist. */
    public async getContentMeta(repo: GitHubRepositoryRef, path: string): Promise<GitHubContentMeta | null> {
        try {
            const response = await this.request<any>(
                { method: 'GET', url: `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}` },
                'Failed to read file from GitHub',
                'application/vnd.github.object+json'
            );
            return {
                type: response.data.type,
                name: response.data.name,
                path: response.data.path,
                sha: response.data.sha,
                size: response.data.size,
            };
        } catch (e) {
            if (e instanceof GitHubApiError && e.status === 404) {
                return null;
            }
            throw e;
        }
    }

    /** Returns an empty list when the directory does not exist. */
    public async listDirectory(repo: GitHubRepositoryRef, path: string): Promise<GitHubContentMeta[]> {
        try {
            const response = await this.request<any>(
                { method: 'GET', url: `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}` },
                'Failed to list directory on GitHub',
                'application/vnd.github.object+json'
            );
            if (response.data.type !== 'dir') {
                return [];
            }
            return (response.data.entries || []).map((entry: any): GitHubContentMeta => ({
                type: entry.type,
                name: entry.name,
                path: entry.path,
                sha: entry.sha,
                size: entry.size,
            }));
        } catch (e) {
            if (e instanceof GitHubApiError && e.status === 404) {
                return [];
            }
            throw e;
        }
    }

    /** Raw bytes of a file, up to GitHub's 100 MB raw limit. */
    public async getRawContent(repo: GitHubRepositoryRef, path: string, onProgress?: (loadedBytes: number) => void): Promise<Buffer> {
        const response = await this.request<ArrayBuffer>(
            {
                method: 'GET',
                url: `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}`,
                responseType: 'arraybuffer',
                onDownloadProgress: (progress) => onProgress && onProgress(progress.loaded),
            },
            'Failed to download file from GitHub',
            'application/vnd.github.raw+json'
        );
        return Buffer.from(response.data);
    }

    /**
     * Creates or updates a file. Pass the current blob sha to update; GitHub
     * rejects the write with 409 or 422 when the sha no longer matches.
     * Content is base64 because Buffers lose their methods when they cross
     * the preload bridge; use FsProvider.base64FromZip or utf8ToBase64.
     */
    public async putContent(
        repo: GitHubRepositoryRef,
        path: string,
        contentBase64: string,
        message: string,
        sha?: string
    ): Promise<GitHubPutResult> {
        const body: Record<string, string> = {
            message,
            content: contentBase64,
        };
        if (sha) {
            body['sha'] = sha;
        }
        const response = await this.request<any>(
            { method: 'PUT', url: `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}`, data: body },
            'Failed to upload file to GitHub'
        );
        return {
            contentSha: response.data.content.sha,
            commitSha: response.data.commit.sha,
        };
    }

    public async deleteContent(repo: GitHubRepositoryRef, path: string, message: string, sha: string): Promise<void> {
        await this.request<any>(
            { method: 'DELETE', url: `/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}`, data: { message, sha } },
            'Failed to delete file from GitHub'
        );
    }
}

function encodePath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

/** Base64 of a UTF-8 string without relying on Node Buffer methods. */
export function utf8ToBase64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
