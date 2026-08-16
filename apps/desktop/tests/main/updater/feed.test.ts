import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SIDECAR_SOURCES } from "@open-design/sidecar-proto";
import { describe, expect, it } from "vitest";

import { resolveDesktopUpdaterConfig } from "../../../src/main/updater/config.js";
import { compareVersions, resolveInstalledOuterVersion, selectUpdateCandidate } from "../../../src/main/updater/feed.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "od-updater-feed-test-"));
}

describe("desktop updater feed", () => {
  it("resolves the installed outer version from the platform bundle layout", async () => {
    const root = makeRoot();
    try {
      const appRoot = join(root, "Open Design.app");
      await mkdir(join(appRoot, "Contents", "Resources"), { recursive: true });
      await writeFile(join(appRoot, "Contents", "Resources", "open-design-config.json"), '{"appVersion":"0.7.0"}\n');
      const macConfig = resolveDesktopUpdaterConfig({
        env: {},
        launcherLaunchPath: appRoot,
        platform: "darwin",
        source: SIDECAR_SOURCES.PACKAGED,
      });
      expect(await resolveInstalledOuterVersion(macConfig)).toBe("0.7.0");

      const winExe = join(root, "win-install", "Open Design Beta.exe");
      await mkdir(join(root, "win-install", "resources"), { recursive: true });
      await writeFile(winExe, "");
      await writeFile(join(root, "win-install", "resources", "open-design-config.json"), '{"appVersion":"0.8.0-beta.2"}\n');
      const winConfig = resolveDesktopUpdaterConfig({
        env: {},
        launcherLaunchPath: winExe,
        platform: "win32",
        source: SIDECAR_SOURCES.PACKAGED,
      });
      expect(await resolveInstalledOuterVersion(winConfig)).toBe("0.8.0-beta.2");

      const malformedExe = join(root, "broken-install", "Open Design.exe");
      await mkdir(join(root, "broken-install", "resources"), { recursive: true });
      await writeFile(malformedExe, "");
      await writeFile(join(root, "broken-install", "resources", "open-design-config.json"), "not json\n");
      const malformedConfig = resolveDesktopUpdaterConfig({
        env: {},
        launcherLaunchPath: malformedExe,
        platform: "win32",
        source: SIDECAR_SOURCES.PACKAGED,
      });
      expect(await resolveInstalledOuterVersion(malformedConfig)).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("compares stable and prerelease versions", () => {
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareVersions("1.0.0-beta-internal.2", "1.0.0-beta-internal.1")).toBe(1);
    expect(compareVersions("1.0.0-prerelease.10", "1.0.0-prerelease.2")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-beta.9")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(-1);
  });
});


/*
 * ПРАВКА ФОРКУ. Стрічка, яку пише `scripts/release-personal.mjs`, мусить
 * прийматись самим апдейтером — інакше реліз виглядає опублікованим, а
 * жодна встановлена копія його не бачить.
 *
 * Це не «схоже на правильне»: фікстура тут — точна форма з того
 * скрипта, і згодовується вона справжньому споживачу. Розійдеться
 * контракт в апстрімі — тест почервоніє, і скрипт треба буде правити.
 */
describe("стрічка особистих релізів", () => {
  const version = "0.18.0";
  const asset = `open-design-${version}-win-x64-setup.exe`;
  const feed = {
    channel: "stable",
    releaseVersion: version,
    stableVersion: version,
    platforms: {
      win: {
        enabled: true,
        arch: "x64",
        artifacts: {
          installer: {
            url: `https://github.com/toper2525ua-eng/open-design-personal/releases/download/v${version}/${asset}`,
            name: asset,
            size: 319_900_518,
            sha256: "2289702ec05eada4cda24fc430cc70c1b73c1eb435ae99015ab217045158547c",
          },
        },
      },
    },
  } as Record<string, unknown>;

  const winConfig = () =>
    resolveDesktopUpdaterConfig({
      appVersion: "0.16.1",
      arch: "x64",
      env: {},
      platform: "win32",
      source: SIDECAR_SOURCES.PACKAGED,
    });

  it("апдейтер бере з неї кандидата на оновлення", () => {
    const picked = selectUpdateCandidate(feed, winConfig());
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.candidate.version).toBe(version);
    expect(picked.candidate.platformKey).toBe("win");
    expect(picked.candidate.artifact.type).toBe("installer");
    expect(picked.candidate.artifact.url).toContain(asset);
    expect(picked.candidate.checksum.algorithm).toBe("sha256");
  });

  it("без `enabled: true` платформа відкидається — і мовчки", () => {
    // Найлегша помилка в стрічці: усе на місці, а оновлення не їде.
    const broken = structuredClone(feed) as typeof feed;
    delete ((broken.platforms as Record<string, Record<string, unknown>>).win).enabled;
    const picked = selectUpdateCandidate(broken, winConfig());
    expect(picked.ok).toBe(false);
    if (picked.ok) return;
    expect(picked.error.code).toBe("no-compatible-artifact");
  });

  it("ключ платформи саме `win`, не `win32-x64`", () => {
    const broken = structuredClone(feed) as typeof feed;
    const platforms = broken.platforms as Record<string, unknown>;
    platforms["win32-x64"] = platforms.win;
    delete platforms.win;
    expect(selectUpdateCandidate(broken, winConfig()).ok).toBe(false);
  });

  it("нова версія вважається новішою за встановлену", () => {
    expect(compareVersions(version, "0.16.1")).toBeGreaterThan(0);
  });
});
