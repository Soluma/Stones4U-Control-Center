import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, isPasswordStrongEnough } from "@/platform/auth/password";

describe("password hashing", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("a-very-secure-password");
    expect(await verifyPassword(hash, "a-very-secure-password")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("a-very-secure-password");
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });

  it("never throws on a malformed hash — treats it as non-matching", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });

  it("enforces a minimum password length", () => {
    expect(isPasswordStrongEnough("short")).toBe(false);
    expect(isPasswordStrongEnough("longenoughpassword")).toBe(true);
  });
});
