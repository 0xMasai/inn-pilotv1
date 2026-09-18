/**
 * adminDb() with a malformed FIREBASE_SERVICE_ACCOUNT: the error names what
 * is wrong with the value's shape, and never echoes the value (a private
 * key). Parsing fails before any Firebase app is created, so no emulator,
 * key or network is needed.
 */
import { describe, expect, it } from "vitest";
import { adminDb } from "../../server/admin";

const SECRET = "SECRETSECRETSECRET";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function messageFor(value: string): string {
  try {
    adminDb({ FIREBASE_SERVICE_ACCOUNT: value });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("adminDb() accepted a malformed service account.");
}

describe("adminDb() with a malformed FIREBASE_SERVICE_ACCOUNT", () => {
  it.each([
    ["JSON cut off at its first line", "{", /cut off at its first line/],
    ["quoted", `'${SECRET}`, /starts with a quote/],
    ["neither JSON nor base64", `${SECRET} ${SECRET}`, /neither JSON nor base64/],
    ["base64 of something other than JSON", b64(SECRET), /not of a JSON file/],
    ["base64 of truncated JSON", b64(`{"private_key":"${SECRET}`), /JSON inside is incomplete/],
    ["JSON that is not a service account", b64(`{"secret":"${SECRET}"}`), /no private_key or client_email/],
  ])("explains a value that is %s, without echoing it", (_, value, reason) => {
    const message = messageFor(value);
    expect(message).toMatch(reason);
    expect(message).not.toContain(SECRET);
  });
});
