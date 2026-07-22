const shipVersionPattern = /^(\d+\.\d+\.\d+)-ship\.(\d+)$/;

export function formatMobileReleaseVersion(appVersion: string, releaseVersion: string) {
  const shipVersion = shipVersionPattern.exec(releaseVersion);
  if (!shipVersion || shipVersion[1] !== appVersion) {
    return appVersion;
  }

  return `${appVersion} · Ship ${Number(shipVersion[2])}`;
}
