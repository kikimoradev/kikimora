import { describe, expect, it, vi } from "vitest";
import { fetchLatestVersion } from "../../src/update/registry.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("fetchLatestVersion", () => {
  it("returns the version from the latest dist-tag", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: "1.4.2" }));

    const version = await fetchLatestVersion("@kikimoradev/kikimora", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      registryBaseUrl: "https://registry.example",
    });

    expect(version).toBe("1.4.2");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://registry.example/@kikimoradev/kikimora/latest",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false));
    expect(
      await fetchLatestVersion("pkg", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("returns null when the payload lacks a version", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ nope: true }));
    expect(
      await fetchLatestVersion("pkg", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("returns null when fetch throws (network/timeout)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    expect(
      await fetchLatestVersion("pkg", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });

  it("returns null when the body is not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.reject(new Error("bad json")),
    });
    expect(
      await fetchLatestVersion("pkg", {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBeNull();
  });
});
