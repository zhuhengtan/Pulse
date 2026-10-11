export function renderPairHtml(
  qrSvg: string,
  pairUrl: string,
  code: string,
  lanIp: string,
  port: number,
  devices: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string }>
): string {
  const deviceRows = devices.length === 0
    ? `<tr><td colspan="4" style="text-align:center;color:#888;padding:16px;">暂无已配对设备</td></tr>`
    : devices.map((d) => `
      <tr>
        <td style="font-weight:500;">${escapeHtml(d.name)}</td>
        <td style="color:#666;font-size:13px;">${new Date(d.createdAt).toLocaleString()}</td>
        <td style="color:#666;font-size:13px;">${new Date(d.lastUsedAt).toLocaleString()}</td>
        <td>
          <button class="btn btn-danger" onclick="revokeDevice('${d.id}')">吊销</button>
        </td>
      </tr>
    `).join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pulse H5 - 本机扫码配对</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --danger: #ef4444;
    }
    body {
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      justify-content: center;
    }
    .container {
      max-width: 720px;
      width: 100%;
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .header h1 { margin: 0 0 8px 0; font-size: 24px; }
    .header p { margin: 0; color: var(--text-muted); font-size: 14px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    }
    .qr-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
    }
    .qr-svg {
      background: #ffffff;
      padding: 16px;
      border-radius: 12px;
      max-width: 240px;
      max-height: 240px;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.3);
    }
    .qr-svg svg { width: 100%; height: 100%; display: block; }
    .url-text {
      background: #0f172a;
      border: 1px solid var(--border);
      padding: 10px 16px;
      border-radius: 8px;
      font-family: monospace;
      font-size: 14px;
      color: #38bdf8;
      word-break: break-all;
      text-align: center;
    }
    .code-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      background: #2563eb;
      font-weight: 600;
      letter-spacing: 2px;
    }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); color: var(--text-muted); font-size: 13px; }
    td { padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .btn {
      padding: 6px 14px;
      border-radius: 6px;
      border: none;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: opacity 0.2s;
    }
    .btn:hover { opacity: 0.9; }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-secondary { background: var(--border); color: #fff; }
    .footer-tip {
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
      margin-top: 16px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Pulse 个人助理 - 手机扫码配对</h1>
      <p>请确保手机与当前电脑连接至同一 Wi-Fi 局域网</p>
    </div>

    <div class="card">
      <div class="qr-box">
        <div class="qr-svg">${qrSvg}</div>
        <div class="code-badge">配对码: ${code}</div>
        <div class="url-text">${escapeHtml(pairUrl)}</div>
        <div style="font-size: 13px; color: var(--text-muted);">
          当前局域网 IP: <b>${lanIp}</b> (端口 ${port})
        </div>
      </div>
      <div class="footer-tip">
        手机使用相机或自带浏览器扫描上方二维码即可立即打开助理界面。<br>
        配对码 5 分钟内有效，页面将在 <span id="countdown">300</span> 秒后自动刷新配对码。
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 12px 0; font-size:16px;">已配对设备</h3>
      <table>
        <thead>
          <tr>
            <th>设备名称</th>
            <th>配对时间</th>
            <th>最近活动</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${deviceRows}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    let remaining = 300;
    const timer = setInterval(() => {
      remaining--;
      const el = document.getElementById('countdown');
      if (el) el.innerText = remaining;
      if (remaining <= 0) {
        clearInterval(timer);
        location.reload();
      }
    }, 1000);

    async function revokeDevice(id) {
      if (!confirm('确定要吊销该设备的访问授权吗？吊销后该设备需要重新扫码。')) return;
      try {
        const res = await fetch('/api/devices/' + id + '/revoke', { method: 'POST' });
        if (res.ok) {
          location.reload();
        } else {
          alert('吊销失败');
        }
      } catch (err) {
        alert('网络错误: ' + err.message);
      }
    }
  </script>
</body>
</html>`
}

export function renderMobileChatHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Pulse Assistant</title>
  <style>
    :root {
      --bg: #0f172a;
      --chat-bg: #1e293b;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --user-msg: #2563eb;
      --assistant-msg: #1e293b;
      --tool-bg: rgba(51, 65, 85, 0.4);
      --card-warn: rgba(245, 158, 11, 0.15);
      --warn-border: #f59e0b;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f8fafc;
        --chat-bg: #ffffff;
        --card-bg: #ffffff;
        --border: #e2e8f0;
        --text: #0f172a;
        --text-muted: #64748b;
        --primary: #2563eb;
        --primary-hover: #1d4ed8;
        --user-msg: #2563eb;
        --assistant-msg: #f1f5f9;
        --tool-bg: rgba(226, 232, 240, 0.6);
        --card-warn: #fef3c7;
        --warn-border: #f59e0b;
      }
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      height: 100dvh;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    #app {
      display: flex;
      flex-direction: column;
      height: 100%;
      height: 100dvh;
    }
    .navbar {
      height: 52px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      background: var(--card-bg);
      flex-shrink: 0;
      padding-top: env(safe-area-inset-top);
    }
    .navbar-title {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
    }
    .status-dot.offline { background: #ef4444; }
    .icon-btn {
      background: none;
      border: none;
      color: var(--text);
      padding: 8px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .banner {
      background: #f59e0b;
      color: #000;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 12px;
      text-align: center;
      display: none;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      -webkit-overflow-scrolling: touch;
    }
    .msg {
      display: flex;
      flex-direction: column;
      max-width: 88%;
      animation: fadeIn 0.2s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .msg.user {
      align-self: flex-end;
    }
    .msg.assistant {
      align-self: flex-start;
      max-width: 95%;
    }
    .bubble {
      padding: 10px 14px;
      border-radius: 16px;
      font-size: 15px;
      line-height: 1.5;
      word-break: break-word;
    }
    .msg.user .bubble {
      background: var(--user-msg);
      color: #ffffff;
      border-bottom-right-radius: 4px;
    }
    .msg.assistant .bubble {
      background: var(--assistant-msg);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }
    .fast-ack {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 6px;
      font-style: italic;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    /* Collapsed tool details */
    .tools-accordion {
      margin: 8px 0;
      border-radius: 8px;
      background: var(--tool-bg);
      border: 1px solid var(--border);
      overflow: hidden;
      font-size: 12px;
    }
    .tools-header {
      padding: 6px 10px;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      user-select: none;
    }
    .tools-content {
      padding: 8px 10px;
      border-top: 1px solid var(--border);
      display: none;
      font-family: monospace;
      color: var(--text-muted);
      max-height: 150px;
      overflow-y: auto;
    }
    .tools-accordion.open .tools-content { display: block; }
    /* Approval Card */
    .approval-card {
      background: var(--card-warn);
      border: 1px solid var(--warn-border);
      border-radius: 10px;
      padding: 12px;
      margin-top: 8px;
    }
    .approval-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--warn-border);
      margin-bottom: 4px;
    }
    .approval-desc {
      font-size: 13px;
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .approval-actions {
      display: flex;
      gap: 8px;
    }
    .btn-approve {
      background: #10b981;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn-reject {
      background: #ef4444;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
    }
    .chat-bottom {
      padding: 8px 16px;
      background: var(--card-bg);
      border-top: 1px solid var(--border);
      padding-bottom: calc(8px + env(safe-area-inset-bottom));
      flex-shrink: 0;
    }
    .input-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 12px;
    }
    .chat-input {
      flex: 1;
      background: none;
      border: none;
      outline: none;
      color: var(--text);
      font-size: 15px;
      resize: none;
      max-height: 100px;
      padding: 4px 0;
      font-family: inherit;
    }
    .send-btn {
      background: var(--primary);
      color: #ffffff;
      border: none;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      flex-shrink: 0;
      margin-bottom: 2px;
      transition: opacity 0.2s;
    }
    .send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    /* Drawer */
    .drawer-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 100;
      display: none;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    .drawer {
      position: fixed;
      top: 0; left: -280px; width: 280px; bottom: 0;
      background: var(--card-bg);
      z-index: 101;
      transition: left 0.3s ease;
      display: flex;
      flex-direction: column;
      box-shadow: 2px 0 10px rgba(0,0,0,0.3);
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .drawer.open { left: 0; }
    .drawer-overlay.open { display: block; opacity: 1; }
    .drawer-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .conv-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .conv-item {
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
      margin-bottom: 4px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .conv-item.active {
      background: var(--border);
      color: var(--text);
      font-weight: 500;
    }
    pre code {
      background: rgba(0,0,0,0.2);
      padding: 2px 4px;
      border-radius: 4px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="offline-banner" class="banner">
      电脑可能已休眠或离开同一 Wi-Fi，正在尝试重新连接...
    </div>
    <div class="navbar">
      <button class="icon-btn" onclick="toggleDrawer()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
      </button>
      <div class="navbar-title">
        <span id="conn-dot" class="status-dot"></span>
        <span id="chat-title">Pulse Assistant</span>
      </div>
      <button class="icon-btn" onclick="newConversation()">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
    </div>

    <div id="messages" class="chat-messages">
      <div class="msg assistant">
        <div class="bubble">
          您好！我是您的 Pulse 个人助理。请问有什么我可以协助您的吗？
        </div>
      </div>
    </div>

    <div class="chat-bottom">
      <div class="input-row">
        <textarea id="chat-input" class="chat-input" rows="1" placeholder="发送消息..." onkeydown="handleKey(event)" oninput="autoGrow(this)"></textarea>
        <button id="send-btn" class="send-btn" onclick="sendCurrentMessage()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
      </div>
    </div>
  </div>

  <div id="drawer-overlay" class="drawer-overlay" onclick="toggleDrawer()"></div>
  <div id="drawer" class="drawer">
    <div class="drawer-header">
      <b style="font-size:15px;">历史对话</b>
      <button class="icon-btn" onclick="newConversation()">+ 新对话</button>
    </div>
    <div id="conv-list" class="conv-list"></div>
  </div>

  <script>
    let currentConvId = null;
    let currentEventSource = null;
    let isRunning = false;

    // Check pairing query param on initial load
    async function checkPairingParam() {
      const url = new URL(location.href);
      const code = url.searchParams.get('code');
      if (code) {
        try {
          const res = await fetch('/api/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, name: navigator.userAgent.slice(0, 50) })
          });
          if (res.ok) {
            url.searchParams.delete('code');
            window.history.replaceState({}, '', url.pathname);
            console.log('Paired successfully');
          }
        } catch (e) {
          console.error('Pair failed', e);
        }
      }
    }

    function autoGrow(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 100) + 'px';
    }

    function handleKey(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentMessage();
      }
    }

    function toggleDrawer() {
      const drawer = document.getElementById('drawer');
      const overlay = document.getElementById('drawer-overlay');
      drawer.classList.toggle('open');
      overlay.classList.toggle('open');
      if (drawer.classList.contains('open')) loadConversations();
    }

    async function loadConversations() {
      try {
        const res = await fetch('/api/conversations');
        if (!res.ok) return;
        const list = await res.json();
        const container = document.getElementById('conv-list');
        container.replaceChildren();
        for (const c of list) {
          const item = document.createElement('div');
          const title = c.title || '对话';
          item.className = 'conv-item' + (c.id === currentConvId ? ' active' : '');
          item.textContent = title;
          item.addEventListener('click', () => selectConversation(c.id, title));
          container.appendChild(item);
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function selectConversation(id, title) {
      currentConvId = id;
      document.getElementById('chat-title').innerText = title;
      toggleDrawer();
      await loadMessages(id);
    }

    async function newConversation() {
      try {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '新对话' })
        });
        if (res.ok) {
          const c = await res.json();
          currentConvId = c.id;
          document.getElementById('chat-title').innerText = c.title || '新对话';
          document.getElementById('messages').innerHTML = \`
            <div class="msg assistant">
              <div class="bubble">您好！我是您的 Pulse 个人助理。请问有什么我可以协助您的吗？</div>
            </div>
          \`;
          const drawer = document.getElementById('drawer');
          if (drawer.classList.contains('open')) toggleDrawer();
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function loadMessages(id) {
      try {
        const res = await fetch(\`/api/conversations/\${id}/messages\`);
        if (!res.ok) return;
        const messages = await res.json();
        const container = document.getElementById('messages');
        if (messages.length === 0) {
          container.innerHTML = \`<div class="msg assistant"><div class="bubble">对话记录为空。</div></div>\`;
          return;
        }
        container.innerHTML = messages.map(m => \`
          <div class="msg \${m.role === 'user' ? 'user' : 'assistant'}">
            <div class="bubble">\${formatMarkdown(m.text)}</div>
          </div>
        \`).join('');
        container.scrollTop = container.scrollHeight;
      } catch (e) {
        console.error(e);
      }
    }

    async function sendCurrentMessage() {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (!text || isRunning) return;
      input.value = '';
      input.style.height = 'auto';

      if (!currentConvId) {
        const res = await fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: text.slice(0, 30) })
        });
        if (res.ok) {
          const c = await res.json();
          currentConvId = c.id;
        } else {
          alert('无法创建会话');
          return;
        }
      }

      // Append user bubble
      appendUserBubble(text);

      // Append assistant placeholder with instant response container
      const assistantEl = createAssistantContainer();

      isRunning = true;
      document.getElementById('send-btn').disabled = true;

      try {
        const res = await fetch(\`/api/conversations/\${currentConvId}/messages\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!res.ok) {
          throw new Error('发送失败: ' + res.status);
        }
        const data = await res.json();
        const runId = data.runId;
        listenRunEvents(runId, assistantEl);
      } catch (err) {
        isRunning = false;
        document.getElementById('send-btn').disabled = false;
        assistantEl.querySelector('.bubble').innerText = '发送失败: ' + err.message;
      }
    }

    function appendUserBubble(text) {
      const container = document.getElementById('messages');
      const msg = document.createElement('div');
      msg.className = 'msg user';
      msg.innerHTML = \`<div class="bubble">\${escapeHtml(text)}</div>\`;
      container.appendChild(msg);
      container.scrollTop = container.scrollHeight;
    }

    function createAssistantContainer() {
      const container = document.getElementById('messages');
      const msg = document.createElement('div');
      msg.className = 'msg assistant';
      msg.innerHTML = \`
        <div class="fast-ack" style="display:none;"></div>
        <div class="bubble">...</div>
        <div class="tools-accordion" style="display:none;">
          <div class="tools-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="tool-count">▸ 处理细节 (0 步)</span>
            <span>展开/折叠</span>
          </div>
          <div class="tools-content"></div>
        </div>
      \`;
      container.appendChild(msg);
      container.scrollTop = container.scrollHeight;
      return msg;
    }

    function listenRunEvents(runId, containerEl) {
      const fastAckEl = containerEl.querySelector('.fast-ack');
      const bubbleEl = containerEl.querySelector('.bubble');
      const toolsAccordion = containerEl.querySelector('.tools-accordion');
      const toolCountEl = containerEl.querySelector('.tool-count');
      const toolsContent = containerEl.querySelector('.tools-content');
      let toolSteps = 0;
      let accumulatedText = '';

      if (currentEventSource) currentEventSource.close();
      const es = new EventSource(\`/api/runs/\${runId}/events\`);
      currentEventSource = es;

      es.onmessage = (event) => {
        try {
          const item = JSON.parse(event.data);
          if (item.type === 'notice' && item.data?.kind === 'front_ack') {
            fastAckEl.style.display = 'flex';
            fastAckEl.textContent = item.data.text || '';
          }
          if (item.type === 'delta' && typeof item.data?.text === 'string') {
            accumulatedText += item.data.text;
            bubbleEl.innerHTML = formatMarkdown(accumulatedText);
          } else if (item.type === 'text' && typeof item.data === 'string') {
            accumulatedText = item.data;
            bubbleEl.innerHTML = formatMarkdown(accumulatedText);
          }
          if (item.type === 'observation' && typeof item.data?.tool === 'string') {
            toolSteps++;
            toolsAccordion.style.display = 'block';
            toolCountEl.textContent = '▸ 处理细节 (' + toolSteps + ' 步)';
            const logLine = document.createElement('div');
            const status = item.data.status === 'succeeded' ? '完成' : item.data.status === 'failed' ? '失败' : '处理';
            logLine.textContent = '[' + status + '] ' + item.data.tool;
            toolsContent.appendChild(logLine);
          }
          if (item.type === 'waiting' && typeof item.data?.effectId === 'string') {
            renderInteraction(containerEl, runId, item.data.effectId, item.data.input || {});
          }
          if (item.type === 'error' && bubbleEl.textContent === '...') {
            bubbleEl.textContent = '运行失败';
          }
          if (item.type === 'run_finished' || item.type === 'complete' || item.type === 'error') {
            es.close();
            isRunning = false;
            document.getElementById('send-btn').disabled = false;
          }
        } catch (e) {
          console.error(e);
        }
      };

      es.onerror = () => {
        document.getElementById('conn-dot').classList.add('offline');
        document.getElementById('offline-banner').style.display = 'block';
      };

      es.onopen = () => {
        document.getElementById('conn-dot').classList.remove('offline');
        document.getElementById('offline-banner').style.display = 'none';
      };
    }

    function renderInteraction(containerEl, runId, effectId, input) {
      const card = document.createElement('div');
      card.className = 'approval-card';
      const title = document.createElement('div');
      title.className = 'approval-title';
      title.textContent = input.kind === 'ask' ? '需要您的回答' : '需要您的确认';
      const desc = document.createElement('div');
      desc.className = 'approval-desc';
      desc.textContent = interactionSummary(input);
      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      card.append(title, desc, actions);

      const finish = (label) => {
        actions.replaceChildren();
        const done = document.createElement('span');
        done.style.fontSize = '13px';
        done.textContent = label;
        actions.appendChild(done);
      };
      const send = async (payload, label) => {
        finish(label);
        try {
          const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ effectId }, payload))
          });
          if (!res.ok) throw new Error('提交失败');
        } catch (err) {
          actions.textContent = '';
          const retry = document.createElement('span');
          retry.textContent = '提交失败: ' + err.message;
          actions.appendChild(retry);
        }
      };

      if (input.kind === 'ask' && input.type === 'choice' && Array.isArray(input.options)) {
        for (const option of input.options) {
          if (!option || typeof option.value !== 'string') continue;
          const button = document.createElement('button');
          button.className = 'btn-approve';
          button.textContent = option.label || option.value;
          button.addEventListener('click', () => send({ value: option.value }, '已提交'));
          actions.appendChild(button);
        }
      } else if (input.kind === 'ask' && input.type === 'input') {
        const field = document.createElement('input');
        field.type = 'text';
        field.placeholder = input.placeholder || '请输入';
        const button = document.createElement('button');
        button.className = 'btn-approve';
        button.textContent = '提交';
        button.addEventListener('click', () => send({ text: field.value }, '已提交'));
        actions.append(field, button);
      } else if (input.kind === 'ask' && input.type === 'multi' && Array.isArray(input.options)) {
        const selected = new Map();
        for (const option of input.options) {
          if (!option || typeof option.value !== 'string') continue;
          const label = document.createElement('label');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.addEventListener('change', () => {
            if (box.checked) selected.set(option.value, true);
            else selected.delete(option.value);
          });
          label.append(box, document.createTextNode(option.label || option.value));
          actions.appendChild(label);
        }
        const button = document.createElement('button');
        button.className = 'btn-approve';
        button.textContent = '提交';
        button.addEventListener('click', () => send({ values: [...selected.keys()] }, '已提交'));
        actions.appendChild(button);
      } else {
        const allow = document.createElement('button');
        allow.className = 'btn-approve';
        allow.textContent = '允许执行';
        allow.addEventListener('click', () => send({ approved: true }, '已允许'));
        const reject = document.createElement('button');
        reject.className = 'btn-reject';
        reject.textContent = '拒绝';
        reject.addEventListener('click', () => send({ approved: false, reason: '拒绝执行' }, '已拒绝'));
        actions.append(allow, reject);
      }
      containerEl.appendChild(card);
    }

    function interactionSummary(input) {
      const lines = [];
      if (typeof input.prompt === 'string' && input.prompt.trim()) lines.push(input.prompt.trim());
      const tools = Array.isArray(input.tools) ? input.tools : [];
      for (const tool of tools) {
        const name = tool.toolName || tool.name || 'tool';
        let args = '';
        try { args = tool.input ? JSON.stringify(tool.input).slice(0, 240) : ''; } catch (e) { args = ''; }
        lines.push(args ? name + ' ' + args : name);
      }
      return lines.join('\\n') || '请确认是否执行该操作';
    }

    function formatMarkdown(text) {
      if (!text) return '';
      return escapeHtml(text)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<b>$1</b>')
        .replace(/\\*(.+?)\\*/g, '<i>$1</i>')
        .replace(/\\x60\\x60\\x60([\\s\\S]*?)\\x60\\x60\\x60/g, '<pre><code>$1</code></pre>')
        .replace(/\\x60([^\\x60]+)\\x60/g, '<code>$1</code>')
        .replace(/\\n/g, '<br>');
    }

    function escapeHtml(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    checkPairingParam();
  </script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
