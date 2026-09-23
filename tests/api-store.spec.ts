import { test, expect } from "@playwright/test";
import { looksSecretName, splitSecrets, mergeSecrets, secretRefs, secretKey, hasPlaintextSecrets, type ApiHeader } from "../src/utils/apiStore";

const h = (id: string, name: string, value: string, secret?: boolean): ApiHeader => ({ id, enabled: true, name, value, secret });

test("looksSecretName flags credential headers, not ordinary ones", () => {
  for (const n of ["Authorization", "X-API-Key", "cookie", "X-Auth-Token", "DB_PASSWORD", "client_secret", "apikey"]) {
    expect(looksSecretName(n), n).toBe(true);
  }
  for (const n of ["Content-Type", "Accept", "User-Agent", "BASE_URL", "region"]) {
    expect(looksSecretName(n), n).toBe(false);
  }
});

test("splitSecrets blanks secret values and returns them keyed for the keychain", () => {
  const { stored, secrets } = splitSecrets("host1", [h("a", "Authorization", "Bearer x"), h("b", "Accept", "*/*"), h("c", "X-Custom", "v", true)], (x) => x.name);
  expect(stored.map((s) => s.value)).toEqual(["", "*/*", ""]);
  expect(stored.map((s) => !!s.secret)).toEqual([true, false, true]);
  expect(secrets).toEqual({ [secretKey("host1", "a")]: "Bearer x", [secretKey("host1", "c")]: "v" });
  expect(JSON.stringify(stored)).not.toContain("Bearer x");
});

test("round trip: refs → fetched values → merged", () => {
  const { stored } = splitSecrets("h", [h("a", "Authorization", "Bearer x"), h("b", "Accept", "json")], (x) => x.name);
  expect(secretRefs("h", stored)).toEqual([{ id: "a", key: secretKey("h", "a") }]);
  const merged = mergeSecrets(stored, { a: "Bearer x" });
  expect(merged.map((m) => m.value)).toEqual(["Bearer x", "json"]);
});

test("secretKey only emits keychain-safe characters", () => {
  expect(secretKey("host id/../x", "f.1")).toMatch(/^[A-Za-z0-9:_-]+$/);
});

test("hasPlaintextSecrets detects legacy storage needing migration", () => {
  expect(hasPlaintextSecrets([h("a", "Authorization", "Bearer x")], (x) => x.name)).toBe(true);
  expect(hasPlaintextSecrets([h("a", "Authorization", "", true)], (x) => x.name)).toBe(false);
});
