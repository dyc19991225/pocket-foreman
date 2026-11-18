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
 * Dispatches Mobile Decision Cards to Telegram Bot (with 1-tap callback_data buttons — zero NAT needed!)
 * and/or Feishu/Slack/Discord Webhooks.
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
        ? `${icon} [待你拍板] ${task.id} (${task.worker.toUpperCase()})`
        : `${icon} [任务异常] ${task.id} (${task.worker.toUpperCase()})`;

    const verifyBadge =
      task.verifyStatus === 'passed'
        ? `✓ Autoloop 验收全绿 (${task.verifyAttempts || 1}轮)`
        : task.verifyStatus === 'failed'
          ? `✕ 验收未过`
          : '免命令验收';

    const reviewBadge = task.reviewScore
      ? `🛡️ ${task.reviewWorker?.toUpperCase()} 交叉审查: ${task.reviewScore}/100`
      : '';

    const text = [
      title,
      `目标: ${task.goal}`,
      `分支: ${task.branchName || 'direct'} · 改动: ${(task.changedFiles || []).length} 个文件`,
      `质量: ${verifyBadge}${reviewBadge ? ` · ${reviewBadge}` : ''}`,
      `耗时: ${task.durationSec ?? 0}s · 花费: $${(task.costUsd ?? 0).toFixed(4)}`,
      `摘要: ${(task.summary || task.error || '').slice(0, 220)}`,
      task.reviewSummary ? `审查意见: ${task.reviewSummary.slice(0, 180)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const results = [];

    // 1. Telegram Bot API with Zero-NAT Callback Buttons + LAN URL Button
    if (cfg.telegramBotToken && cfg.telegramChatId) {
      try {
        const tgUrl = `https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`;
        const inlineKeyboard =
          task.status === 'awaiting_approval'
            ? [
                [
                  { text: '✅ 批准并合并进主分支', callback_data: `approve:${task.id}` },
                  { text: '✕ 丢弃', callback_data: `discard:${task.id}` },
                ],
                [
                  { text: '📄 在 TG 查看 Diff', callback_data: `diff:${task.id}` },
                  { text: '📱 局域网卡片页', url: mobileUrl },
                ],
              ]
            : [[{ text: '📱 打开局域网看板', url: mobileUrl }]];

        const resp = await fetch(tgUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.telegramChatId,
            text,
            reply_markup: { inline_keyboard: inlineKeyboard },
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
        const fullText = `${text}\n📱 局域网拍板页: ${mobileUrl}`;
        const isDiscord = cfg.webhookUrl.includes('discord.com');
        const payload = isDiscord
          ? { content: fullText }
          : { msg_type: 'text', content: { text: fullText }, text: fullText };
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
