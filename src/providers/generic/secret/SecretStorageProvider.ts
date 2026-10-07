import ProviderUtils from '../ProviderUtils';

/**
 * Wraps small secrets (API tokens) for storage at rest. Implementations may
 * store the value unchanged when no OS keychain is available, so callers must
 * treat the sealed string as opaque.
 */
export default abstract class SecretStorageProvider {

    private static provider: () => SecretStorageProvider;

    static provide(provided: () => SecretStorageProvider): void {
        this.provider = provided;
    }

    public static get instance(): SecretStorageProvider {
        if (SecretStorageProvider.provider === undefined) {
            ProviderUtils.throwNotProvidedError("SecretStorageProvider");
        }
        return SecretStorageProvider.provider();
    }

    /** Wrap a plaintext secret for storage. */
    public abstract seal(plaintext: string): Promise<string>;

    /** Unwrap a value produced by {@link seal}. */
    public abstract open(sealed: string): Promise<string>;

}
