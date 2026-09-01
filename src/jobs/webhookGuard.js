const cron = require('node-cron');
const { ensureWebhook } = require('../services/evolution');

function startWebhookGuardJob() {
  cron.schedule('*/10 * * * *', async () => {
    try {
      await ensureWebhook();
    } catch (err) {
      console.error(`[WebhookGuard] Falha: ${err.message}`);
    }
  });

  console.log('[WebhookGuard] Iniciado — verifica a cada 10 min');
}

module.exports = { startWebhookGuardJob };
