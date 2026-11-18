/**
 * Zero-NAT Bidirectional Telegram Bot Long-Polling Controller (`getUpdates`).
 * Lets you dispatch coding tasks from your phone (`/projects`, `/status`, `/task <repo> <goal>`)
 * and tap real inline buttons (`[✅ 合并]`, `[📄 Diff]`, `[✕ 丢弃]`) without any public IP or tunnel!
 */
export class TelegramRemoteDaemon {
  constructor({ store, getProjects, dispatchTask, approveById, discardById }) {
    this.store = store;
    this.getProjects = getProjects;
    this.dispatchTask = dispatchTask;
    this.approveById = approveById;
    this.discardById = discardById;

    this.running = false;
    this.offset = 0;
    this.activeToken = '';
    this.pollAbort = null;
  }

  syncWithConfig() {
    const token = (this.store.getConfig().telegramBotToken || '').trim();
    if (!token) {
      this.stop();
      return;
    }
    if (this.running && this.activeToken === token) return;
    this.stop();
    this.activeToken = token;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
    this.activeToken = '';
    try {
      this.pollAbort?.abort();
    } catch {
      // ignore
    }
  }

  async tgCall(method, payload) {
    if (!this.activeToken) return null;
    const res = await fetch(`https://api.telegram.org/bot${this.activeToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  isAuthorizedChat(chatId) {
    const allowed = String(this.store.getConfig().telegramChatId || '').trim();
    if (!allowed) return true;
    return String(chatId) === allowed;
  }

  async loop() {
    while (this.running && this.activeToken) {
      try {
        this.pollAbort = new AbortController();
        const url = `https://api.telegram.org/bot${this.activeToken}/getUpdates?timeout=20&offset=${this.offset}`;
        const resp = await fetch(url, { signal: this.pollAbort.signal });
        const data = await resp.json();
        if (data?.ok && Array.isArray(data.result)) {
          for (const upd of data.result) {
            this.offset = Math.max(this.offset, upd.update_id + 1);
            await this.handleUpdate(upd);
          }
        } else {
          await new Promise((r) => setTimeout(r, 5000));
        }
      } catch {
        if (this.running) await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  async handleUpdate(upd) {
    // 1. Inline button callback (`approve:<id>`, `discard:<id>`, `diff:<id>`)
    if (upd.callback_query) {
      const cb = upd.callback_query;
      const chatId = cb.message?.chat?.id;
      if (!this.isAuthorizedChat(chatId)) return;

      const [action, taskId] = String(cb.data || '').split(':');
      const task = this.store.getTask(taskId);
      if (!task) {
        await this.tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: '找不到该任务' });
        return;
      }

      if (action === 'approve') {
        const res = await this.approveById(taskId);
        await this.tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: '✓ 已合并进主分支!' });
        await this.tgCall('sendMessage', {
          chat_id: chatId,
          text: `✅ 任务 ${taskId} (${task.worker.toUpperCase()}) 已成功合并进主分支！\nCommit: ${res.mergeRes?.commitSha || 'merged'}`,
        });
      } else if (action === 'discard') {
        await this.discardById(taskId);
        await this.tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: '✕ 已丢弃分支' });
        await this.tgCall('sendMessage', {
          chat_id: chatId,
          text: `🗑️ 已丢弃任务 ${taskId} 并清理临时 git worktree。`,
        });
      } else if (action === 'diff') {
        await this.tgCall('answerCallbackQuery', { callback_query_id: cb.id, text: '正在发送 Diff 预览' });
        const snippet = (task.diffPatch || '无文件改动').slice(0, 3400);
        await this.tgCall('sendMessage', {
          chat_id: chatId,
          text: `📄 ${taskId} Git Diff 预览:\n\n${snippet}`,
        });
      }
      return;
    }

    // 2. Text Commands (`/start`, `/projects`, `/status`, `/task <project> <goal>`)
    const msg = upd.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    if (!this.isAuthorizedChat(chatId)) return;

    const text = msg.text.trim();
    if (text === '/start' || text === '/help') {
      await this.tgCall('sendMessage', {
        chat_id: chatId,
        text: [
          '⚡ Pocket Foreman 双向口袋遥控已就绪！',
          '',
          '常用指令：',
          '• /projects — 列出电脑工作盘全部项目仓库',
          '• /status — 查看运行队列、待拍板数与累计花费',
          '• /task <项目名> <需求> — 派发隔离 Worktree + Autoloop 验收 + 异构审查任务',
          '  例: /task qq-speed-3d 给氮气加速加上震屏手感',
        ].join('\n'),
      });
    } else if (text === '/projects') {
      const projs = this.getProjects().slice(0, 18);
      const lines = projs.map(
        (p, i) => `${i + 1}. ${p.name} [${p.kind}${p.branch ? ` · ${p.branch}` : ''}]`
      );
      await this.tgCall('sendMessage', {
        chat_id: chatId,
        text: `📂 已扫描发现项目 (${projs.length}):\n` + (lines.join('\n') || '暂无项目'),
      });
    } else if (text === '/status') {
      const tasks = this.store.getTasks();
      const pending = tasks.filter((t) => t.status === 'awaiting_approval').length;
      const running = tasks.filter((t) => t.status === 'running').length;
      const stats = this.store.getStats();
      await this.tgCall('sendMessage', {
        chat_id: chatId,
        text: [
          `📊 工头实时状态`,
          `• 运行中: ${running} | 待拍板: ${pending}`,
          `• 累计派单: ${stats.totalRuns} 次`,
          `• 累计花费: $${stats.totalCostUsd.toFixed(4)} (${stats.totalTokens.toLocaleString()} toks)`,
        ].join('\n'),
      });
    } else if (text.startsWith('/task ')) {
      const rest = text.slice(6).trim();
      const sp = rest.indexOf(' ');
      if (sp < 1) {
        await this.tgCall('sendMessage', {
          chat_id: chatId,
          text: '用法: /task <项目名> <任务目标>\n例: /task qq-speed-3d 优化漂移镜头跟随',
        });
        return;
      }
      const projKey = rest.slice(0, sp).trim().toLowerCase();
      const goal = rest.slice(sp + 1).trim();
      const projs = this.getProjects();
      const hit = projs.find((p) => p.name.toLowerCase() === projKey || p.name.toLowerCase().includes(projKey));
      if (!hit) {
        await this.tgCall('sendMessage', {
          chat_id: chatId,
          text: `未找到匹配 "${projKey}" 的项目，可先发 /projects 查看列表。`,
        });
        return;
      }

      const created = await this.dispatchTask({
        workers: ['codex'],
        goal,
        prompt: goal,
        workspace: hit.path,
        permission: 'write',
        verifyCmd: hit.suggestedVerifyCmd || '',
        maxRetries: 2,
        reviewer: 'auto',
      });
      await this.tgCall('sendMessage', {
        chat_id: chatId,
        text: `🚀 已派发后台任务 ${created[0].id}\n项目: ${hit.name}\n自动验收: ${hit.suggestedVerifyCmd || '无'}\n跑通后将直接推送拍板按钮卡片给你！`,
      });
    }
  }
}
