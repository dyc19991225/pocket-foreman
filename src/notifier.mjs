import os from 'node:os';

export function getLanAddress() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Dispatches Mobile Decision Cards to Telegram Bot (Inline Keyboard) and/or Generic Feishu/Slack/Discord Webhook.
 */
export class ApprovalNotifier {
  constructor(store, getServerPort) {
    this.store = store;
    this.getServerPort = getServerPort;
  }

  getMobileUrl() {
    const lan = getLanAddress();
    return `http://${lan}:${this.getServerPort()}/mobile`;
  }

  async sendApprovalCard(task) {
    const cfg = this.store.getConfig();
    const mobileUrl = this.getMobileUrl();
    const icon = task.status === 'awaiting_approval' ? '🟡' : '🔴';
    const title =
      task.status === 'awaiting_approval'
        ? `${icon} [拍板待批] ${task.id} (${task.worker.toUpperCase()})`
        : `${icon} [任务异常] ${task.id} (${task.worker.toUpperCase()})`;

    const text = [
      title,
      `目标: ${task.goal}`,
      `分支: ${task.branchName || 'direct'} · 改动: ${(task.changedFiles || []).length} 个文件`,
      `耗时: ${task.durationSec ?? 0}s · 花费: $${(task.costUsd ?? 0).toFixed(4)}`,
      `摘要: ${(task.summary || task.error || '').slice(0, 220)}`,
      `📱 手机一键审阅 Diff 与合并: ${mobileUrl}`,
    ].join('\n');

    const results = [];

    // 1. Telegram Bot API with Inline URL Button
    if (cfg.telegramBotToken && cfg.telegramChatId) {
      try {
        const tgUrl = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
        const resp = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.telegramChatId,
            text,
            reply_markup: {
              inline_keyboard: [[{ text: '📱 打开手机拍板卡片 (Review & Merge)', url: mobileUrl }]],
            },
          }),
        });
        results.push({ channel: 'telegram', ok: resp.ok });
      } catch (err) {
        results.push({ channel: 'telegram', ok: false, error: err.message });
      }
    }

    // 2. Feishu / Discord / Slack Incoming Webhook
    if (cfg.webhookUrl) {
      try {
        const isDiscord = cfg.webhookUrl.includes('discord.com');
        const payload = isDiscord
          ? { content: text }
          : { msg_type: 'text', content: { text }, text };
        const resp = await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        results.push({ channel: 'webhook', ok: resp.ok });
      } catch (err) {
        results.push({ channel: 'webhook', ok: false, error: err.message });
      }
    }

    return { mobileUrl, deliveries: results };
  }
}
