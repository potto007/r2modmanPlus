import SecretStorageProvider from '../../providers/generic/secret/SecretStorageProvider';

const ENCRYPTED_PREFIX = 'enc:';

/**
 * Uses Electron safeStorage when the OS provides a keychain, otherwise the
 * value is stored unchanged. The prefix lets open() tell the two apart, so a
 * token saved on a machine without a keychain still loads.
 */
export default class ElectronSecretStorage extends SecretStorageProvider {

    public async seal(plaintext: string): Promise<string> {
        if (await window.electron.isSecretStorageAvailable()) {
            return ENCRYPTED_PREFIX + await window.electron.encryptSecret(plaintext);
        }
        return plaintext;
    }

    public async open(sealed: string): Promise<string> {
        if (sealed.startsWith(ENCRYPTED_PREFIX)) {
            return window.electron.decryptSecret(sealed.substring(ENCRYPTED_PREFIX.length));
        }
        return sealed;
    }

}
