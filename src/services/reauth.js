const puppeteer = require('puppeteer');
const { getLastUid, fetchVerificationCode } = require('./gmail');

// We use jwt.ms as redirect_uri so the B2C template's bot-check
// (which blocks 'portal-usuario' URIs) never fires.
const REDIRECT_URI = 'https://jwt.ms/';
const B2C_TENANT = process.env.B2C_TENANT ?? '';
const B2C_POLICY = process.env.B2C_POLICY ?? '';
const CLIENT_ID = process.env.B2C_CLIENT_ID ?? '';
const AUTHORIZE_URL = `https://ticketmobile.b2clogin.com/${B2C_TENANT}/oauth2/v2.0/authorize`;

async function reauth() {
  console.log('[Reauth] Iniciando login automático via Puppeteer...');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  const params = new URLSearchParams({
    p: B2C_POLICY,
    client_id: CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: REDIRECT_URI,
    scope: 'openid',
    nonce: 'defaultNonce',
    prompt: 'login',
  });

  let idToken = null;
  let ssoCookie = null;

  try {
    await page.goto(`${AUTHORIZE_URL}?${params}`, { waitUntil: 'networkidle2' });

    // Preenche email no campo customizado do template
    await page.waitForSelector('#login', { timeout: 20000 });
    await page.type('#login', process.env.TICKET_EMAIL ?? '');

    // Preenche senha (injetada pelo B2C no #api)
    await page.waitForSelector('#password', { timeout: 20000 });
    await page.type('#password', process.env.TICKET_PASSWORD ?? '');

    // Clica no botão next (injetado pelo B2C)
    await page.waitForSelector('#next', { timeout: 10000 });
    await page.click('#next');

    // Aguarda ou o botão de seleção de MFA ou o campo de código direto
    const lastUid = await getLastUid();
    const mfaOptionVisible = await Promise.race([
      page.waitForFunction(
        () => Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim().includes('Por e-mail')),
        { timeout: 15000 },
      ).then(() => true),
      page.waitForSelector('#VerificationCode', { timeout: 15000 }).then(() => false),
    ]).catch(async () => {
      const url = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
      console.error(`[Reauth] Nenhum seletor de MFA encontrado. url=${url} body="${bodyText}"`);
      throw new Error('Página de MFA não reconhecida');
    });

    if (mfaOptionVisible) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().includes('Por e-mail'));
        btn?.click();
      });
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
      console.log('[Reauth] MFA por e-mail solicitado, aguardando código no Gmail...');
    } else {
      console.log('[Reauth] Campo de código já visível (MFA enviado automaticamente), aguardando código no Gmail...');
    }

    await page.waitForSelector('#VerificationCode', { timeout: 60000 }).catch(async (err) => {
      const url = page.url();
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) ?? '');
      console.error(`[Reauth] #VerificationCode não apareceu. url=${url} body="${bodyText}"`);
      throw err;
    });

    const code = await fetchVerificationCode(lastUid);
    console.log(`[Reauth] Código recebido: ${code}`);

    await page.type('#VerificationCode', code);

    await page.waitForSelector('#signinEmailVerificationControl_but_verify_code', { timeout: 5000 });
    await page.click('#signinEmailVerificationControl_but_verify_code');

    try {
      await page.waitForSelector('#continue:not(.d-none)', { timeout: 15000 });
      await page.evaluate(() => document.getElementById('continue').click());
    } catch {
      // skipSteps() já clicou ou o redirect aconteceu antes
    }

    // Aguarda redirect para jwt.ms com o token no fragment
    const finalUrl = await page.waitForFunction(
      () => {
        const href = window.location.href;
        if (href.startsWith('https://jwt.ms') && href.includes('id_token')) return href;
        return false;
      },
      { timeout: 30000 },
    ).then((handle) => handle.jsonValue());

    const fragment = finalUrl.split('#')[1] ?? '';
    idToken = new URLSearchParams(fragment).get('id_token');

    if (!idToken) throw new Error('id_token não encontrado na URL de redirect');

    // Extrai o cookie SSO do B2C
    const cookies = await page.cookies('https://ticketmobile.b2clogin.com');
    const sso = cookies.find((c) => c.name.startsWith('x-ms-cpim-sso'));
    if (sso) ssoCookie = `${sso.name}=${sso.value}`;

  } finally {
    await browser.close();
  }

  console.log('[Reauth] Login automático concluído.');
  return { idToken, ssoCookie };
}

module.exports = { reauth };
