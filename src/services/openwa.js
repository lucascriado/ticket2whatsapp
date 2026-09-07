const axios = require('axios');

// Provider OpenWA. Mesma interface do provider evolution: sendMessage,
// ensureWebhook, parseIncoming.
const api = axios.create({
  baseURL: process.env.OPENWA_URL ?? 'http://localhost:2785',
  headers: { 'X-API-Key': process.env.OPENWA_API_KEY ?? '' },
});

const SESSION = () => process.env.OPENWA_SESSION ?? '';

// A Evolution entregava mensagem recebida E mensagem própria no mesmo evento
// (MESSAGES_UPSERT). O OpenWA separa: message.received é só inbound e
// message.sent é o que a própria sessão envia. O dono consulta o bot de dentro
// do WhatsApp da instância, então SEM message.sent ele fica mudo para o dono —
// por isso os dois eventos, e não só o primeiro.
const EVENTS = ['message.received', 'message.sent'];

async function sendMessage(to, text) {
  console.log(`[OpenWA] Enviando para ${to}`);
  try {
    await api.post(`/api/sessions/${SESSION()}/messages/send-text`, {
      chatId: toChatId(to),
      text,
    });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error('[OpenWA] Erro ao enviar:', JSON.stringify(err.response?.data));
    }
    throw err;
  }
}

// A Evolution aceitava número cru; o OpenWA quer o WhatsApp ID completo.
// Um JID que já vem completo passa intacto.
function toChatId(destino) {
  const v = String(destino ?? '').trim();
  if (v.includes('@')) return v;
  const digits = v.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : v;
}

async function findWebhook() {
  try {
    const { data } = await api.get(`/api/sessions/${SESSION()}/webhooks`);
    const lista = Array.isArray(data) ? data : (data?.data ?? []);
    const url = process.env.WEBHOOK_URL;
    return lista.find((w) => w?.url === url) ?? lista[0] ?? null;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

async function setWebhook(url) {
  const body = { url, events: EVENTS };
  // O OpenWA assina a entrega com HMAC quando há secret. A Evolution não
  // tinha isso: o webhook era aberto a quem soubesse a URL.
  if (process.env.OPENWA_WEBHOOK_SECRET) body.secret = process.env.OPENWA_WEBHOOK_SECRET;
  await api.post(`/api/sessions/${SESSION()}/webhooks`, body);
}

async function ensureWebhook() {
  const url = process.env.WEBHOOK_URL;
  if (!url) return false;

  const atual = await findWebhook();
  const ok =
    atual?.url === url && EVENTS.every((e) => (atual.events ?? []).includes(e));

  if (ok) return false;

  await setWebhook(url);
  console.log(
    atual
      ? `[OpenWA] Webhook divergente, reescrito: ${url}`
      : `[OpenWA] Webhook ausente, registrado: ${url}`,
  );
  return true;
}

// Normaliza o evento do OpenWA para a forma que a rota consome.
// Devolve null quando o evento não interessa.
function parseIncoming(event) {
  const nome = event?.event;
  if (!EVENTS.includes(nome)) return null;

  const d = event?.data ?? {};
  const fromMe = nome === 'message.sent' || d.fromMe === true;

  // Numa mensagem própria a thread é o destinatário; numa recebida, o remetente.
  const chatJid = String(d.chatId ?? (fromMe ? d.to : d.from) ?? '').trim();
  // Só serve para o ALLOWED_NUMBERS. Em grupo o autor vem em author/senderId.
  const senderJid = String(d.author ?? d.senderId ?? d.from ?? chatJid ?? '').trim();

  return {
    messageId: d.id ?? d.messageId,
    chatJid,
    senderJid,
    text: String(d.body ?? '').trim().toLowerCase(),
    fromMe,
  };
}

module.exports = { sendMessage, ensureWebhook, findWebhook, parseIncoming, toChatId, EVENTS };
