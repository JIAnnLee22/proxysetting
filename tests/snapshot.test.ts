import { it, expect } from "vitest";
import { validateSnapshot } from "../src/worker/routes/agent";
import { calendar } from "../src/worker/core";
const snapshot = {
  schema: 1,
  sequence: 1,
  revision: 1,
  ...calendar(),
  version: "v0.1.0",
  status: "ready",
  error: "",
  users: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      uplink: 1,
      downlink: 2,
      disabled: false,
    },
  ],
};
it("rejects malformed calendars, overflow, repeated users and wrong schemas", () => {
  for (const patch of [
    { schema: 2 },
    { sequence: 0 },
    { day: snapshot.month + "-99" },
    { version: "latest" },
    { users: [snapshot.users[0], snapshot.users[0]] },
    { users: [{ ...snapshot.users[0], uplink: Number.MAX_SAFE_INTEGER }] },
    { status: "unknown" },
  ])
    expect(() => validateSnapshot({ ...snapshot, ...patch })).toThrow();
  expect(validateSnapshot(snapshot)).toEqual(snapshot);
});
