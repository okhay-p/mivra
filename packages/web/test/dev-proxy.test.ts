import { describe, expect, it } from "vitest";
import { forwardingHeaders } from "../dev-proxy.js";

describe("the dev proxy's forwarding headers", () => {
  it("adds none for a browser on this machine", () => {
    expect(forwardingHeaders("localhost:5173", "127.0.0.1")).toEqual({});
    expect(forwardingHeaders("127.0.0.1:5173", "::ffff:127.0.0.1")).toEqual({});
    expect(forwardingHeaders("[::1]:5173", "::1")).toEqual({});
  });

  it("marks a tailnet Host from a local proxy as forwarded", () => {
    expect(forwardingHeaders("prestige.tail52dcb6.ts.net", "127.0.0.1")).toEqual({ "x-forwarded-host": "prestige.tail52dcb6.ts.net" });
  });

  it("marks another machine as forwarded even when it claims a loopback Host", () => {
    expect(forwardingHeaders("localhost", "192.168.1.20")).toEqual({ "x-forwarded-for": "192.168.1.20" });
    expect(forwardingHeaders("localhost", undefined)).toEqual({ "x-forwarded-for": "unknown" });
  });
});
