import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OriginNormalizationService } from "../services/origin-normalization-service.js";

describe("normalizeOriginUrl", () => {
  it("normalizes SSH and HTTPS remotes into the same host/path identity", () => {
    const sshOrigin = OriginNormalizationService.normalizeOriginUrl(
      "git@GitHub.com:Owner/Repo.git",
    );
    const httpsOrigin = OriginNormalizationService.normalizeOriginUrl(
      " https://github.com/Owner/Repo/ ",
    );

    assert.equal(sshOrigin, "github.com/Owner/Repo");
    assert.equal(httpsOrigin, "github.com/Owner/Repo");
  });

  it("strips credentials and preserves nested repository paths", () => {
    const normalizedOrigin = OriginNormalizationService.normalizeOriginUrl(
      "https://oauth2:secret@gitlab.example.com/group/subgroup/repo.git",
    );

    assert.equal(normalizedOrigin, "gitlab.example.com/group/subgroup/repo");
  });

  it("rejects non-repository origins and incomplete paths", () => {
    assert.equal(OriginNormalizationService.normalizeOriginUrl("file:///tmp/repo"), null);
    assert.equal(
      OriginNormalizationService.normalizeOriginUrl("https://github.com/owner"),
      null,
    );
    assert.equal(
      OriginNormalizationService.normalizeOriginUrl("not a git remote"),
      null,
    );
  });
});

describe("hasUsableOrigin", () => {
  it("returns true only when the origin normalizes successfully", () => {
    assert.equal(
      OriginNormalizationService.hasUsableOrigin("ssh://git@github.com/Owner/Repo.git"),
      true,
    );
    assert.equal(OriginNormalizationService.hasUsableOrigin("file:///tmp/repo"), false);
    assert.equal(OriginNormalizationService.hasUsableOrigin(null), false);
  });
});
