import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "./security.js";

describe("private address detection", () => {
  it.each(["127.0.0.1", "10.0.0.8", "172.16.2.3", "192.168.1.1", "169.254.1.2", "::1", "fd00::1"])(
    "blocks %s",
    (address) => expect(isPrivateAddress(address)).toBe(true)
  );

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => expect(isPrivateAddress(address)).toBe(false)
  );
});
