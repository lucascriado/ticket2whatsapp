const axios = require('axios');

const api = axios.create({
  baseURL: process.env.EVOLUTION_URL ?? 'http://localhost:8080',
  headers: { apikey: process.env.EVOLUTION_API_KEY ?? '' },
});

const INSTANCE = () => process.env.EVOLUTION_INSTANCE ?? '';
const EVENTS = ['MESSAGES_UPSERT'];

async function sendMessage(to, text) {
  console.log(`[Evolution] Enviando para ${to}`);
  try {
    await api.post(`/message/sendText/${INSTANCE()}`, { number: to, text });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error('[Evolution] Erro ao enviar:', JSON.stringify(err.response?.data));
    }
    throw err;
  }
}

async function findWebhook() {
  try {
    const { data } = await api.get(`/webhook/find/${INSTANCE()}`);
    return data ?? null;
  } catch (err) {
    // Instância ainda não criada: a Evolution devolve 404 aqui.
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

async function setWebhook(url) {
  await api.post(`/webhook/set/${INSTANCE()}`, {
    webhook: { enabled: true, url, events: EVENTS },
  });
}

// Recriar a instância na Evolution apaga o webhook junto, mesmo mantendo o
// nome. Registrar só no boot deixava o bot mudo até o container reiniciar —
// daí a verificação periódica.
async function ensureWebhook() {
  const url = process.env.WEBHOOK_URL;
  if (!url) return false;

  const atual = await findWebhook();
  const ok =
    atual?.enabled === true &&
    atual.url === url &&
    EVENTS.every((e) => (atual.events ?? []).includes(e));

  if (ok) return false;

  await setWebhook(url);
  console.log(
    atual
      ? `[Evolution] Webhook divergente, reescrito: ${url}`
      : `[Evolution] Webhook ausente, registrado: ${url}`,
  );
  return true;
}

module.exports = { sendMessage, ensureWebhook, findWebhook };
