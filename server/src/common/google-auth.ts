import { createSign } from 'crypto';

const cache = new Map<string, { token: string; exp: number }>();

/** 서비스 계정 JSON으로 Google API 접근 토큰을 받는다(FCM, Play Developer API 공용). */
export async function googleAccessToken(serviceAccountJson: string, scope: string, tokenUrl = 'https://oauth2.googleapis.com/token'): Promise<{ token: string; projectId: string }> {
  const sa = JSON.parse(serviceAccountJson);
  const key = `${sa.client_email}:${scope}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now() + 60_000) return { token: hit.token, projectId: sa.project_id };
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: sa.client_email, scope, aud: tokenUrl, iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url')}`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(json.error_description || 'Google 인증 실패');
  cache.set(key, { token: json.access_token, exp: Date.now() + json.expires_in * 1000 });
  return { token: json.access_token, projectId: sa.project_id };
}
