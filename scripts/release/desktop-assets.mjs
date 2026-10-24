export const desktopAssets = [
  { platform: 'macos-arm64', name: 'pulse-macos-arm64.dmg' },
  { platform: 'macos-x64', name: 'pulse-macos-x64.dmg' },
  { platform: 'windows-x64', name: 'pulse-windows-x64.exe' },
  { platform: 'linux-x64', name: 'pulse-linux-x86_64.AppImage' },
  { platform: 'linux-deb-x64', name: 'pulse-linux-amd64.deb' },
];
export const requiredDesktopFiles = [...desktopAssets.map(item => item.name), 'pulse-macos-arm64.zip', 'pulse-macos-x64.zip', 'pulse-windows-x64.zip'];
/** Only complete, public releases supply public download links. */
export function desktopDownloadManifest(release) {
  const fallback = { version: null, releaseUrl: 'https://github.com/zhuhengtan/Pulse/releases', assets: [] };
  if (!release || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) return fallback;
  const tag = release.tag_name, releaseUrl = `https://github.com/zhuhengtan/Pulse/releases/tag/${tag}`;
  if (release.html_url !== releaseUrl) return fallback;
  const assets = desktopAssets.map(expected => {
    const matches = (release.assets ?? []).filter(item => item.name === expected.name);
    const asset = matches.length === 1 ? matches[0] : undefined;
    const url = `https://github.com/zhuhengtan/Pulse/releases/download/${tag}/${expected.name}`;
    return asset?.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.browser_download_url === url ? { ...expected, size: asset.size, url } : undefined;
  });
  const checksums = (release.assets ?? []).some(item => item.name === 'pulse-desktop-SHA256SUMS.txt' && item.state === 'uploaded' && item.size > 0);
  return assets.every(Boolean) && checksums ? { version: tag.slice(1), releaseUrl, assets } : fallback;
}
