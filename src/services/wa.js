// Seletor de provider de WhatsApp.
//
// Os dois caminhos ficam vivos de propósito durante a migração: enquanto o
// número não trocar de lado, WA_PROVIDER=evolution mantém o comportamento
// exatamente como sempre foi. Depois da troca, WA_PROVIDER=openwa. Voltar é
// mudar esta env — a única parte do rollback que não custa reparear.
const PROVIDERS = {
  evolution: () => require('./evolution'),
  openwa: () => require('./openwa'),
};

const nome = (process.env.WA_PROVIDER ?? 'evolution').trim().toLowerCase();
const carregar = PROVIDERS[nome];

if (!carregar) {
  throw new Error(
    `WA_PROVIDER inválido: "${nome}". Use ${Object.keys(PROVIDERS).join(' ou ')}.`,
  );
}

console.log(`[WA] Provider ativo: ${nome}`);

const provider = carregar();

module.exports = {
  provider: nome,
  sendMessage: provider.sendMessage,
  ensureWebhook: provider.ensureWebhook,
  findWebhook: provider.findWebhook,
  parseIncoming: provider.parseIncoming,
};
