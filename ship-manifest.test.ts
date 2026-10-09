import { describe, expect, it } from "vitest";
import { verifyShipManifest } from "./test/ship-manifest.js";

describe("publish manifest", () => {
	it("`package.json` `files` array covers every production .ts module across the tree", () => {
		expect(verifyShipManifest(import.meta.url).missing).toEqual([]);
	});
});
