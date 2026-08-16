import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP_UPDATE_CHANNELS, SIDECAR_SOURCES } from "@open-design/sidecar-proto";
import { describe, expect, it } from "vitest";

import { DESKTOP_UPDATE_ENV, resolveDesktopUpdaterConfig } from "../../../src/main/updater/config.js";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "od-updater-config-test-"));
}

describe("desktop updater config", () => {
  /*
   * ПРАВКА ФОРКУ. Стрічка оновлень веде на наші релізи GitHub, а не на
   * сервер розробників. Перевіряємо саме це: типове значення мусить
   * бути ЗАПЕЧЕНЕ у збірку, бо на чужій машині змінну оточення ніхто
   * не виставить, а оновлення потрібне саме там.
   */
  it("типово дивиться на наш GitHub, а не на сервер розробників", () => {
    const config = resolveDesktopUpdaterConfig({
      appVersion: "0.16.1",
      env: { [DESKTOP_UPDATE_ENV.ENABLED]: "1" },
      source: SIDECAR_SOURCES.PACKAGED,
    });
    expect(config.metadataUrl).toBe(
      "https://github.com/toper2525ua-eng/open-design-personal/releases/latest/download/metadata.json",
    );
    expect(config.metadataUrl).not.toContain("releases.open-design.ai");
  });

  it("змінна оточення й далі перебиває типове значення", () => {
    const config = resolveDesktopUpdaterConfig({
      appVersion: "0.16.1",
      env: {
        [DESKTOP_UPDATE_ENV.ENABLED]: "1",
        [DESKTOP_UPDATE_ENV.METADATA_URL]: "https://example.test/feed.json",
      },
      source: SIDECAR_SOURCES.PACKAGED,
    });
    expect(config.metadataUrl).toBe("https://example.test/feed.json");
  });

  it("defaults counted beta internal builds to the beta update channel", () => {
    const root = makeRoot();
    try {
      const config = resolveDesktopUpdaterConfig({
        currentVersion: "1.2.3-beta-internal.4",
        downloadRoot: root,
        env: {
          [DESKTOP_UPDATE_ENV.ENABLED]: "1",
        },
        source: SIDECAR_SOURCES.PACKAGED,
      });

      expect(config.channel).toBe(DESKTOP_UPDATE_CHANNELS.BETA);
      expect(config.metadataUrl).toContain("/releases/latest/download/metadata-beta.json");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects a zero recurring update interval", () => {
    const root = makeRoot();
    try {
      expect(() =>
        resolveDesktopUpdaterConfig({
          currentVersion: "1.2.3-beta.4",
          downloadRoot: root,
          env: {
            [DESKTOP_UPDATE_ENV.CHECK_INTERVAL_MS]: "0",
            [DESKTOP_UPDATE_ENV.ENABLED]: "1",
          },
          source: SIDECAR_SOURCES.PACKAGED,
        }),
      ).toThrow(`${DESKTOP_UPDATE_ENV.CHECK_INTERVAL_MS} must be greater than 0 milliseconds`);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("defaults prerelease builds to the prerelease update channel", () => {
    const root = makeRoot();
    try {
      const config = resolveDesktopUpdaterConfig({
        currentVersion: "1.2.3-prerelease.4",
        downloadRoot: root,
        env: {
          [DESKTOP_UPDATE_ENV.ENABLED]: "1",
        },
        source: SIDECAR_SOURCES.PACKAGED,
      });

      expect(config.channel).toBe(DESKTOP_UPDATE_CHANNELS.PRERELEASE);
      expect(config.metadataUrl).toContain("/releases/latest/download/metadata-prerelease.json");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("defaults preview builds to the preview update channel", () => {
    const root = makeRoot();
    try {
      const config = resolveDesktopUpdaterConfig({
        currentVersion: "1.2.3-preview.4",
        downloadRoot: root,
        env: {
          [DESKTOP_UPDATE_ENV.ENABLED]: "1",
        },
        source: SIDECAR_SOURCES.PACKAGED,
      });

      expect(config.channel).toBe(DESKTOP_UPDATE_CHANNELS.PREVIEW);
      expect(config.metadataUrl).toContain("/releases/latest/download/metadata-preview.json");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
