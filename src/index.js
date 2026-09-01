require('dotenv/config');
const app = require('./app');
const { init: initToken } = require('./services/token');
const { startTokenRefreshJob } = require('./jobs/tokenRefresh');
const { startMidnightReauthJob } = require('./jobs/midnightReauth');
const { startWebhookGuardJob } = require('./jobs/webhookGuard');
const { ensureWebhook } = require('./services/evolution');
const PORT = process.env.PORT ?? 3000;

initToken();
startTokenRefreshJob();
startMidnightReauthJob();
startWebhookGuardJob();

app.listen(PORT, async () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  try {
    await ensureWebhook();
  } catch (err) {
    console.warn('[Evolution] Webhook não verificado:', err.message);
  }
});
