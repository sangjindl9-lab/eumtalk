import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { AppConfig, CONFIG } from '../config';
import { ContentFilter } from '../common/content-filter';
import { bad, forbidden, notFound, tooMany } from '../common/errors';
import { Db, Q } from '../db/db';
import { RateLimiter } from '../realtime/redis';
import { createStorage, Storage } from './storage';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_EDGE = 2048;
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'heif']);
export type MediaPurpose = 'profile' | 'chat' | 'post' | 'room';

@Injectable()
export class MediaService {
  readonly storage: Storage;
  constructor(
    @Inject(CONFIG) private readonly cfg: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
    @Inject(ContentFilter) private readonly filter: ContentFilter,
  ) {
    this.storage = createStorage(cfg);
  }

  /**
   * 업로드: 실제 바이트를 열어 이미지 형식·크기를 검사하고, 다시 인코딩해서 저장한다.
   * 다시 인코딩하는 과정에서 EXIF(촬영 위치·기기 정보)가 모두 제거된다.
   */
  async upload(userId: string, purposeRaw: string, conversationId: string | null, body: Buffer) {
    const purpose = purposeRaw as MediaPurpose;
    if (!['profile', 'chat', 'post', 'room'].includes(purpose)) throw bad('INVALID_INPUT', '사진 용도가 올바르지 않습니다.');
    if (!Buffer.isBuffer(body) || body.length === 0) throw bad('INVALID_IMAGE', '사진 파일을 확인해 주세요.');
    if (body.length > MAX_BYTES) throw bad('IMAGE_TOO_LARGE', '사진은 10MB 이하만 올릴 수 있습니다.');
    if (!(await this.rl.hit(`media:${userId}`, 60, 3600))) throw tooMany('사진을 너무 많이 올렸습니다. 잠시 후 다시 시도해 주세요.');

    if (purpose === 'chat') {
      // 대화 첨부는 수락된 대화방의 참여자만 올릴 수 있다(수락 전에는 사진을 보낼 수 없다).
      const ok = conversationId && (await this.db.one('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL', [conversationId, userId]));
      if (!ok) throw forbidden('NOT_PARTICIPANT', '이 대화방에 사진을 보낼 수 없습니다.');
    }

    let out: Buffer;
    let width: number | undefined;
    let height: number | undefined;
    try {
      const img = sharp(body, { failOn: 'error', limitInputPixels: 50_000_000 });
      const meta = await img.metadata();
      if (!meta.format || !ALLOWED.has(meta.format)) throw new Error('format');
      const result = await img
        .rotate() // EXIF 방향을 픽셀에 반영한 뒤 메타데이터는 버린다
        .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 84, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      out = result.data;
      width = result.info.width;
      height = result.info.height;
    } catch {
      throw bad('INVALID_IMAGE', 'JPG·PNG·WEBP·HEIC 사진만 올릴 수 있습니다.');
    }
    if (purpose !== 'chat') {
      const verdict = await this.filter.checkImage(out);
      if (!verdict.ok) throw bad('CONTENT_BLOCKED', verdict.reason || '게시할 수 없는 사진입니다.');
    }

    const id = randomUUID();
    const key = `${purpose}/${id}.jpg`;
    await this.storage.put(key, out, 'image/jpeg');
    await this.db.query(
      `INSERT INTO media (id, owner_id, purpose, conversation_id, storage_key, mime, bytes, width, height)
       VALUES ($1, $2, $3, $4, $5, 'image/jpeg', $6, $7, $8)`,
      [id, userId, purpose, purpose === 'chat' ? conversationId : null, key, out.length, width, height],
    );
    return { id, width, height, bytes: out.length };
  }

  /**
   * 열람 권한 확인 후 제한 시간 링크 발급.
   *  - 대화 첨부: 그 대화방의 현재 참여자만
   *  - 프로필·게시글·방 대표 사진: 로그인한 회원(차단 관계 제외)
   */
  async urlFor(userId: string, mediaId: string) {
    const m = await this.db.one<any>('SELECT * FROM media WHERE id = $1', [mediaId]);
    if (!m || m.status !== 'ready') throw notFound('사진을 찾을 수 없습니다.');
    if (m.purpose === 'chat') {
      const ok = await this.db.one('SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL', [m.conversation_id, userId]);
      if (!ok) throw notFound('사진을 찾을 수 없습니다.');
    } else if (m.owner_id !== userId) {
      const blocked = await this.db.one(
        'SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
        [userId, m.owner_id],
      );
      if (blocked) throw notFound('사진을 찾을 수 없습니다.');
    }
    return { url: this.storage.signedUrl(m.storage_key, this.cfg.storage.urlTtlSec), expiresInSec: this.cfg.storage.urlTtlSec, width: m.width, height: m.height };
  }

  /** 관리자 증거 열람용(권한 확인은 호출한 쪽에서 한다). */
  async adminUrl(mediaId: string) {
    const m = await this.db.one<any>('SELECT storage_key FROM media WHERE id = $1', [mediaId]);
    return m ? this.storage.signedUrl(m.storage_key, 120) : null;
  }

  /** 내가 올린, 지정한 용도의 사진인지 확인한다. */
  async assertOwned(q: Q, userId: string, mediaIds: string[], purpose: MediaPurpose, conversationId?: string) {
    if (mediaIds.length === 0) return;
    const rows = await q.query<any>(`SELECT id, conversation_id FROM media WHERE id = ANY($1::uuid[]) AND owner_id = $2 AND purpose = $3 AND status = 'ready'`, [mediaIds, userId, purpose]);
    if (rows.length !== new Set(mediaIds).size) throw bad('INVALID_MEDIA', '첨부한 사진을 확인해 주세요.');
    if (purpose === 'chat' && rows.some((r) => r.conversation_id !== conversationId)) throw bad('INVALID_MEDIA', '첨부한 사진을 확인해 주세요.');
  }

  async removeAllOf(q: Q, userId: string, purposes: MediaPurpose[]) {
    const rows = await q.query<{ storage_key: string }>(`UPDATE media SET status = 'deleted' WHERE owner_id = $1 AND purpose = ANY($2::text[]) AND status <> 'deleted' RETURNING storage_key`, [userId, purposes]);
    for (const r of rows) await this.storage.remove(r.storage_key);
    return rows.length;
  }
}
