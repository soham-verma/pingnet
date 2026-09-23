// Persistence for the API client (saved requests + environment variables).
//
// Credential-bearing values (Authorization headers, tokens, passwords, …, or
// anything the user marks secret) are stored in the OS keychain via the
// backend; localStorage only ever holds a reference (audit SEC-005).
// The split/merge logic is pure so it can be unit-tested.

export interface SecretField { id: string; enabled: boolean; secret?: boolean }
export interface ApiHeader extends SecretField { name: string; value: string }
export interface ApiEnvVar extends SecretField { key: string; value: string }

const SECRET_NAME = /(authori[sz]ation|cookie|token|secret|passw(or)?d|pass$|api[-_]?key|apikey|auth|bearer|session|private|credential|signature)/i;

/** Heuristic: does a header / variable name usually carry a credential? */
export function looksSecretName(name: string): boolean {
  return SECRET_NAME.test(name.trim());
}

export function isSecret(f: { secret?: boolean }, name: string): boolean {
  return f.secret === true || looksSecretName(name);
}

/** Keychain account name for one field. Only [A-Za-z0-9:_-] — validated backend-side too. */
export function secretKey(hostId: string, fieldId: string): string {
  return `api:${hostId}:${fieldId}`.replace(/[^A-Za-z0-9:_-]/g, "_");
}

export interface SplitResult<T> {
  /** Safe to write to localStorage — secret values blanked, `secret: true` set */
  stored: T[];
  /** keychain account → value for every non-empty secret */
  secrets: Record<string, string>;
}

/** Separate secret values from a list of headers / env vars. */
export function splitSecrets<T extends SecretField & { value: string }>(
  hostId: string,
  items: T[],
  nameOf: (t: T) => string,
): SplitResult<T> {
  const secrets: Record<string, string> = {};
  const stored = items.map((it) => {
    if (!isSecret(it, nameOf(it))) return it;
    if (it.value) secrets[secretKey(hostId, it.id)] = it.value;
    return { ...it, secret: true, value: "" };
  });
  return { stored, secrets };
}

/** Fields in `items` that were stored as secrets and need their value fetched. */
export function secretRefs<T extends SecretField>(hostId: string, items: T[]): { id: string; key: string }[] {
  return items.filter((i) => i.secret).map((i) => ({ id: i.id, key: secretKey(hostId, i.id) }));
}

/** Put fetched secret values back into items (by id). */
export function mergeSecrets<T extends SecretField & { value: string }>(items: T[], values: Record<string, string | null>): T[] {
  return items.map((i) => (i.secret && values[i.id] != null ? { ...i, value: values[i.id]! } : i));
}

/** Plaintext values that are sitting in localStorage but should be secret (needs migration). */
export function hasPlaintextSecrets<T extends SecretField & { value: string }>(items: T[], nameOf: (t: T) => string): boolean {
  return items.some((i) => i.value !== "" && isSecret(i, nameOf(i)));
}
