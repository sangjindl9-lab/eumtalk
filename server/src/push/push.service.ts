import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { googleAccessToken } from '../common/google-auth';
import { Db } from '../db/db';

export const NOTIFY_DEFAULTS = { all: true, direct: true, greeting: true, room: true, comment: true, notice: true, recommend: true, marketing: false, quiet: false, quietStart: '23:00', quietEnd: '08:00' };
export type NotifyPrefs = typeof NOTIFY_DEFAULTS;
const KIND_PREF: Record<string, keyof NotifyPrefs> = { message: 'direct', room: 'room', greeting: 'greeting', comment: 'comment', notice: 'notice', recommend: 'recommend', marketing: 'marketing' };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 회원이 보낸 알림 설정 일부를 검사해 기존 값에 합친다. */
export function mergeNotify(current: Partial<NotifyPrefs> | null | undefined, patch: any): NotifyPrefs {
  const out: NotifyPrefs = { ...NOTIFY_DEFAULTS, ...(current || {}) };
  if (!patch || typeof patch !== 'object') return out;
  for (const k of ['all', 'direct', 'greeting', 'room', 'comment', 'notice', 'recommend', 'marketing', 'quiet'] as const) {
    if (typeof patch[k] === 'boolean') (out as any)[k] = patch[k];
  }
  for (const k of ['quietStart', 'quietEnd'] as const) {
    if (typeof patch[k] === 'string' && HHMM.test(patch[k])) out[k] = patch[k];
  }
  return out;
}

/** 한국 시각 기준으로 방해 금지 시간인지. 23:00~08:00 처럼 자정을 넘는 구간도 처리한다. */
export function inQuietHours(p: NotifyPrefs, now = new Date()): boolean {
  if (!p.quiet) return false;
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const toMin = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const a = toMin(p.quietStart);
  const b = toMin(p.quietEnd);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export interface PushItem {
  userId: string;
  kind: 'message' | 'greeting' | 'notice' | 'room' | 'comment' | 'recommend' | 'marketing';
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
    const prefs = await this.db.query<{ user_id: string; push_preview: boolean; notify: Partial<NotifyPrefs> | null }>(
      'SELECT user_id, push_preview, notify FROM profiles WHERE user_id = ANY($1::uuid[])',
      [items.map((i) => i.userId)],
    );
    const preview = new Map(prefs.map((p) => [p.user_id, p.push_preview]));
    const notify = new Map(prefs.map((p) => [p.user_id, mergeNotify(p.notify, null)]));
    for (const item of items) {
      // 회원의 알림 설정: 전체 끔·종류별 끔이면 보내지 않고, 방해 금지 시간에는 기록만 남긴다.
      const n = notify.get(item.userId) ?? NOTIFY_DEFAULTS;
      const skipped = !n.all || !n[KIND_PREF[item.kind] ?? 'direct'] ? 'off' : inQuietHours(n) ? 'quiet' : null;
      // 잠금화면 미리보기를 끈 회원에게는 내용 대신 일반 문구만 보낸다.
      const body = preview.get(item.userId) === false ? item.privateBody : item.body;
      const title = preview.get(item.userId) === false ? this.cfg.brand.appName : item.title;
      await this.db
        .query('INSERT INTO push_log (user_id, kind, title, body, data, provider, skipped) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
          item.userId, item.kind, title, body, JSON.stringify(item.data), this.cfg.push.provider, skipped,
        ])
        .catch(() => undefined);
      if (!skipped && this.cfg.push.provider === 'fcm') {
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
