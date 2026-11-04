/**
 * One-time helper to obtain a Zoho refresh token for your own Developer org.
 *
 *   npm run zoho:bootstrap
 *
 * It starts a tiny local server on the port in ZOHO_REDIRECT_URI, prints a
 * consent URL, and exchanges the code Zoho sends back for a long-lived refresh
 * token. Nothing is written to disk: paste the printed line into .env.
 */
import http from 'node:http';
import { URL } from 'node:url';

import { loadEnv } from '../env.js';

const env = loadEnv();
const redirect = new URL(env.zohoRedirectUri);
const port = Number(redirect.port || 80);
const callbackPath = redirect.pathname;

// Deals need read+write; users.READ is what the token exchange uses to confirm
// the grant. Narrow this further if your org policy requires it.
const SCOPE = 'ZohoCRM.modules.deals.ALL,ZohoCRM.users.READ';

const consentUrl =
  `${env.zohoAccountsUrl}/oauth/v2/user_authorization?` +
  new URLSearchParams({
    response_type: 'code',
    client_id: env.zohoClientId,
    redirect_uri: env.zohoRedirectUri,
    scope: SCOPE,
    prompt: 'consent',
  }).toString();

async function main(): Promise<void> {
  process.stdout.write(
    [
      'Open this URL in a browser where you are logged in to your Zoho CRM org:',
      '',
      `  ${consentUrl}`,
      '',
      `Waiting for Zoho to redirect back to ${env.zohoRedirectUri} ...`,
      ''
    ].join('\n')
  );

  const code = await waitForCode();
  const tokens = await exchangeCode(code);

  process.stdout.write(
    [
      '',
      'Got the token. Add this line to .env:',
      '',
      `  ZOHO_REFRESH_TOKEN=${tokens.refreshToken}`,
      '',
      tokens.apiDomain
        ? `Your API domain is ${tokens.apiDomain}, so:`
        : 'Your API domain depends on the data centre of your org, so:',
      `  ZOHO_ACCOUNTS_URL=${env.zohoAccountsUrl}`,
      '  ZOHO_API_URL=https://' + (tokens.apiDomain ?? 'www.zohoapis.com') + '/crm/v2/<YOUR_ZOHO_ORG_ID>',
      '',
      'The org id is NOT part of the token response. Copy it from Zoho CRM:',
      '  Setup > Developer Hub > API > API Explorer - the URL shown there ends',
      '  with the number you need. (If your org has several entities, pick the',
      '  one whose Deals hold the two sample records.)',
      ''
    ].join('\n')
  );
}

function waitForCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (requestUrl.pathname !== callbackPath) {
        res.writeHead(404).end('not found');
        return;
      }
      const code = requestUrl.searchParams.get('code');
      const problem = requestUrl.searchParams.get('error');
      if (problem) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end(`Zoho refused the grant: ${problem}`);
        server.close();
        reject(new Error(`zoho oauth error: ${problem}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('no code in the callback');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        '<p>Zoho grant received. You can close this tab and check the terminal.</p>'
      );
      server.close();
      resolve(code);
    });

    server.listen(port, () => {
      process.stdout.write(`(listening on port ${port}; it closes automatically after 5 minutes)\n`);
    });
    server.on('error', (err: Error) => reject(new Error(`cannot listen on ${port}: ${err.message}`)));
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for the Zoho redirect'));
    }, 5 * 60_000);
    timer.unref();
  });
}

async function exchangeCode(code: string): Promise<{ refreshToken: string; apiDomain: string | null }> {
  const response = await fetch(`${env.zohoAccountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.zohoClientId,
      client_secret: env.zohoClientSecret,
      redirect_uri: env.zohoRedirectUri,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    api_domain?: string;
    tokens?: Array<{ refresh_token?: string; api_domain?: string }>;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok) {
    throw new Error(`token exchange failed (http ${response.status}): ${json?.error ?? ''} ${json?.error_description ?? ''}`.trim());
  }

  // Multi-entity orgs return a `tokens` array, one entry per CRM org.
  const chosen = json?.refresh_token ? json : json?.tokens?.[0];
  if (!chosen?.refresh_token) throw new Error('token response contained no refresh_token');
  return { refreshToken: chosen.refresh_token, apiDomain: json?.api_domain ?? null };
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
