const releases = 'https://github.com/zhuhengtan/Pulse/releases';
const labels = { 'macos-arm64': ['下载 DMG', 'Apple Silicon', 'pulse-macos-arm64.dmg'], 'windows-x64': ['下载安装程序', 'x64', 'pulse-windows-x64.exe'], 'linux-x64': ['下载 AppImage', 'x64', 'pulse-linux-x86_64.AppImage'], 'linux-deb-x64': ['下载 DEB', 'x64', 'pulse-linux-amd64.deb'] };
const status = document.querySelector('#release-status');
async function showDownloads() {
  try {
    const response = await fetch(new URL('downloads.json', document.baseURI));
    if (!response.ok) throw new Error('Manifest unavailable');
    const manifest = await response.json();
    const tag = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? '') ? `v${manifest.version}` : null;
    let available = 0;
    for (const link of document.querySelectorAll('[data-download]')) {
      const key = link.dataset.download, asset = manifest.assets?.find(item => item.platform === key);
      if (!tag || !asset || !labels[key] || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.name !== labels[key][2]) continue;
      const expected = `${releases}/download/${tag}/${asset.name}`;
      if (asset.url !== expected) continue;
      link.href = expected; link.classList.remove('unavailable'); link.textContent = labels[key][0];
      if (link.classList.contains('download-button')) { const detail = document.createElement('span'); detail.textContent = labels[key][1]; link.append(detail); }
      else link.textContent += ` · ${labels[key][1]}`;
      const size = document.querySelector(`[data-size="${key}"]`); if (size) size.textContent = `${(asset.size / 1024 / 1024).toFixed(0)} MB · ${tag}`;
      available++;
    }
    if (available) { status.textContent = `当前客户端版本 ${tag} · 从 GitHub Releases 下载`; document.querySelector('#checksums-link').href = `${releases}/tag/${tag}`; }
    else status.textContent = '桌面客户端正在准备发布。下载将随正式 Release 开放。';
  } catch { status.textContent = '暂时无法读取下载信息，请前往 GitHub Releases 查看。'; }
}
showDownloads();
