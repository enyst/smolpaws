import { z } from 'zod';
export declare const OPENHANDS_KEYRING_SERVICE = "openhands";
export declare const secretRefSchema: z.ZodObject<{
    service: z.ZodDefault<z.ZodString>;
    account: z.ZodString;
}, z.core.$strict>;
export type SecretRef = z.infer<typeof secretRefSchema>;
export interface SecretStore {
    get(ref: SecretRef): Promise<string | null>;
    set(ref: SecretRef, value: string): Promise<void>;
    delete(ref: SecretRef): Promise<void>;
    has(ref: SecretRef): Promise<boolean>;
}
export interface LlmApiKeyLookup {
    readonly providerId: string;
    readonly profileId?: string;
    readonly useProfileKeyOverride?: boolean;
}
export declare function llmProviderSecretRef(providerId: string): SecretRef;
export declare function llmProfileSecretRef(profileId: string): SecretRef;
export declare function resolveLlmApiKeyRef(lookup: LlmApiKeyLookup, store: SecretStore): Promise<SecretRef | null>;
export declare function getLlmApiKey(lookup: LlmApiKeyLookup, store: SecretStore): Promise<string | null>;
export declare class InMemorySecretStore implements SecretStore {
    private readonly secrets;
    constructor(entries?: Iterable<readonly [SecretRef, string]>);
    get(ref: SecretRef): Promise<string | null>;
    set(ref: SecretRef, value: string): Promise<void>;
    delete(ref: SecretRef): Promise<void>;
    has(ref: SecretRef): Promise<boolean>;
}
export declare class MacOSKeychainSecretStore implements SecretStore {
    get(ref: SecretRef): Promise<string | null>;
    set(ref: SecretRef, value: string): Promise<void>;
    delete(ref: SecretRef): Promise<void>;
    has(ref: SecretRef): Promise<boolean>;
}
