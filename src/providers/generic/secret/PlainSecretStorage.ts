import SecretStorageProvider from './SecretStorageProvider';

/** Stores secrets unchanged. Used in tests and where no keychain exists. */
export default class PlainSecretStorage extends SecretStorageProvider {

    public async seal(plaintext: string): Promise<string> {
        return plaintext;
    }

    public async open(sealed: string): Promise<string> {
        return sealed;
    }

}
