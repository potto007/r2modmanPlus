import GameManager from '../../model/game/GameManager';
import SecretStorageProvider from '../../providers/generic/secret/SecretStorageProvider';
import ManagerSettings from '../manager/ManagerSettings';

/**
 * Reads and writes the GitHub personal access token. The token is a global
 * setting, so any game context works for loading it.
 */
async function settings(): Promise<ManagerSettings> {
    return ManagerSettings.getSingleton(GameManager.activeGame ?? GameManager.defaultGame);
}

export async function getGitHubToken(): Promise<string | null> {
    const sealed = (await settings()).getSealedGitHubToken();
    if (!sealed) {
        return null;
    }
    return SecretStorageProvider.instance.open(sealed);
}

export async function setGitHubToken(token: string | null): Promise<void> {
    const trimmed = token ? token.trim() : '';
    const sealed = trimmed.length > 0 ? await SecretStorageProvider.instance.seal(trimmed) : null;
    await (await settings()).setSealedGitHubToken(sealed);
}

export async function hasGitHubToken(): Promise<boolean> {
    return (await settings()).getSealedGitHubToken() !== null;
}
