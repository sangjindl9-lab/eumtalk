import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { googleAccessToken } from '../common/google-auth';
import { Db } from '../db/db';

export interface PushItem {
  userId: string;
  kind: 'message' | 'greeting' | 'notice' | 'room';
  title: string;
  body: string;
  /** 미리보기를 끈 회원에게 대신 보여줄 문구 */
  privateBody: string;
  data: Record<string, string>;
}

/**
 * 푸시 발송. 대상 선정(차단·알림 끄기 제외)은 호출하는 쪽에서 끝내고 들어온다.
 * 모든 발송은 push_log 에 남고, FCM 설정이 있으면 실제로도 보낸다.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('Push');
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig, @Inject(Db) private readonly db: Db) {}

  async register(userId: string, token: string, platform: string) {
    await this.db.query(
      `INSERT INTO device_tokens (token, user_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
      [token, userId, platform],
    );
  }

  async unregister(userId: string, token?: string) {
    if (token) await this.db.query('DELETE FROM device_tokens WHERE token = $1 AND user_id = $2', [token, userId]);
    else await this.db.query('DELETE FROM device_tokens WHERE user_id = $1', [userId]);
  }

  async send(items: PushItem[]) {
    if (items.length === 0) return;
    const prefs = await this.db.query<{ user_id: string; push_preview: boolean }>(
      'SELECT user_id, push_preview FROM profiles WHERE user_id = ANY($1::uuid[])',
      [items.map((i) => i.userId)],
    );
    const preview = new Map(prefs.map((p) => [p.user_id, p.push_preview]));
    for (const item of items) {
      // 잠금화면 미리보기를 끈 회원에게는 내용 대신 일반 문구만 보낸다.
      const body = preview.get(item.userId) === false ? item.privateBody : item.body;
      const title = preview.get(item.userId) === false ? this.cfg.brand.appName : item.title;
      await this.db
        .query('INSERT INTO push_log (user_id, kind, title, body, data, provider) VALUES ($1, $2, $3, $4, $5, $6)', [
          item.userId, item.kind, title, body, JSON.stringify(item.data), this.cfg.push.provider,
        ])
        .catch(() => undefined);
      if (this.cfg.push.provider === 'fcm') {
        this.sendFcm(item.userId, title, body, { ...item.data, kind: item.kind }).catch((e) => this.log.warn(`FCM 실패: ${e.message}`));
      }
    }
  }

  // ── FCM HTTP v1 ──────────────────────────────────────────────────────
  private async sendFcm(userId: string, title: string, body: string, data: Record<string, string>) {
    const tokens = await this.db.query<{ token: string }>('SELECT token FROM device_tokens WHERE user_id = $1', [userId]);
    if (tokens.length === 0) return;
    const { token: access, projectId } = await googleAccessToken(this.cfg.push.fcmServiceAccount!, 'https://www.googleapis.com/auth/firebase.messaging', this.cfg.fcm.tokenUrl);
    for (const t of tokens) {
      const res = await fetch(`${this.cfg.fcm.apiBase}/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: t.token, notification: { title, body }, data, android: { priority: 'high' }, apns: { payload: { aps: { sound: 'default' } } } } }),
      });
      // 더 이상 유효하지 않은 토큰은 지운다.
      if (res.status === 404 || res.status === 400) await this.db.query('DELETE FROM device_tokens WHERE token = $1', [t.token]);
    }
  }
}
