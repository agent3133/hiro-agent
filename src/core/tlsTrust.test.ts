// The certificates the model and MCP requests trust (#113): Node's and the system's, as requestUrl does.
import * as tls from "node:tls";
import { describe, expect, it } from "vitest";

import { certificateAuthorities, trustedCertificates } from "./tlsTrust";

describe("trustedCertificates", () => {
  it("is Node's list and the system's together, each certificate once", () => {
    const lists = { default: ["A", "B"], system: ["B", "C"] };
    expect(trustedCertificates((type) => lists[type])).toEqual(["A", "B", "C"]);
  });

  it("leaves Node's default in place where the system's store cannot be listed or read", () => {
    expect(trustedCertificates(null as never)).toBeUndefined();  // an older Node without getCACertificates
    expect(trustedCertificates(() => { throw new Error("no store"); })).toBeUndefined();
  });

  it("on this Node, holds at least Node's own list", () => {
    const own = tls.getCACertificates("default");
    const trusted = certificateAuthorities();
    expect(trusted).toBeDefined();
    expect(own.every((certificate) => trusted!.includes(certificate))).toBe(true);
    expect(certificateAuthorities()).toBe(trusted);  // read once
  });
});
