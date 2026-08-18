/**
 * The binding degrades, and it degrades in one direction.
 *
 * An engine installed from an npm tarball has no `node_modules`, so
 * `@napi-rs/keyring` is simply not there. Everything that does not touch a
 * keychain key must still run; a command that does gets a refusal naming the
 * module and what to do — never a `MODULE_NOT_FOUND` stack.
 */

import { createKeychainKeySource, PenvError } from "@penvhq/core";
import { describe, expect, it, vi } from "vitest";
import { createKeychain, KEYRING_MODULE } from "./keychain.js";

class FakeEntry {
  static readonly store = new Map<string, string>();

  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  private get key(): string {
    return `${this.service}:${this.account}`;
  }

  getPassword(): string | null {
    return FakeEntry.store.get(this.key) ?? null;
  }

  setPassword(password: string): void {
    FakeEntry.store.set(this.key, password);
  }
}

const missing = () => {
  throw new Error(`Cannot find module '${KEYRING_MODULE}'`);
};

describe("the keychain binding, when the native module resolves", () => {
  it("reads and writes through it", () => {
    const keychain = createKeychain(() => ({ Entry: FakeEntry }));

    expect(keychain.getPassword("penv", "prod")).toBeNull();
    keychain.setPassword("penv", "prod", "c2VjcmV0");
    expect(keychain.getPassword("penv", "prod")).toBe("c2VjcmV0");
  });

  it("loads it once, at first use and not before", () => {
    const load = vi.fn(() => ({ Entry: FakeEntry }));
    const keychain = createKeychain(load);
    expect(load).not.toHaveBeenCalled();

    keychain.getPassword("penv", "cached");
    keychain.getPassword("penv", "cached");
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("the keychain binding, when the native module is absent", () => {
  it("refuses a read by naming the module and a remedy", () => {
    const keychain = createKeychain(missing);

    expect(() => keychain.getPassword("penv", "prod")).toThrowError(PenvError);
    try {
      keychain.getPassword("penv", "prod");
      expect.unreachable("the missing binding must refuse");
    } catch (error) {
      const refusal = error as PenvError;
      expect(refusal.code).toBe("KEYCHAIN_BINDING_MISSING");
      expect(refusal.message).toContain(KEYRING_MODULE);
      expect(refusal.remedy).toContain("npm install -g @penvhq/launcher");
      expect(refusal.remedy).toContain('source: "env"');
    }
  });

  it("refuses a write the same way", () => {
    const keychain = createKeychain(missing);

    expect(() => {
      keychain.setPassword("penv", "prod", "c2VjcmV0");
    }).toThrowError(/KEYCHAIN|could not load/);
  });

  /** Invariant 15: penv could not consult the source, which is not "no such key". */
  it("makes a keychain key source unavailable, never absent", () => {
    const source = createKeychainKeySource(
      { source: "keychain", id: "prod" },
      createKeychain(missing),
    );
    const lookup = source.current();

    expect(lookup.kind).toBe("unavailable");
    expect(lookup.kind === "unavailable" && lookup.detail).toContain(KEYRING_MODULE);
    expect(lookup.kind === "unavailable" && lookup.detail).toContain(
      "npm install -g @penvhq/launcher",
    );
  });
});
