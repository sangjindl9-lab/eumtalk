import { Inject, Injectable } from '@nestjs/common';
import { ContentFilter } from '../common/content-filter';
import { bad, forbidden, notFound, tooMany } from '../common/errors';
import { isUuid, str } from '../common/validate';
import { Db } from '../db/db';
import { GreetingsService } from '../greetings/greetings.service';
import { MediaService } from '../media/media.service';
import { PointsService } from '../points/points.service';
import { RateLimiter } from '../realtime/redis';
import { PushService } from '../push/push.service';

const BOARD = ['daily', 'question', 'hobby', 'meetup'];
const MARKET = ['sell', 'buy', 'free'];
const CONDITIONS = ['새 상품', '거의 새것', '사용감 있음', '수리 필요'];

@Injectable()
export class PostsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ContentFilter) private readonly filter: ContentFilter,
    @Inject(MediaService) private readonly media: MediaService,
    @Inject(PointsService) private readonly points: PointsService,
    @Inject(GreetingsService) private readonly greetings: GreetingsService,
    @Inject(RateLimiter) private readonly rl: RateLimiter,
    @Inject(PushService) private readonly push: PushService,
  ) {}

  /** $1 = viewer. 숨김·삭제 글, 탈퇴 회원, 차단 관계의 글은 보이지 않는다. */
  private readonly SELECT = `
    SELECT p.*, pr.nickname, pr.avatar_color, pr.photo_media_id AS author_photo, rg.name AS region_name, rg.sido,
           EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
           EXISTS (SELECT 1 FROM post_bookmarks b WHERE b.post_id = p.id AND b.user_id = $1) AS bookmarked
      FROM posts p
      JOIN users u ON u.id = p.author_id AND u.status = 'active'
      JOIN profiles pr ON pr.user_id = p.author_id
      JOIN regions rg ON rg.id = p.region_id
     WHERE p.status = 'visible'
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.author_id) OR (b.blocker_id = p.author_id AND b.blocked_id = $1))`;

  private map(r: any, viewerId: string, pinRegion?: string | null) {
    const pinned = !!r.pinned_until && new Date(r.pinned_until) > new Date();
    return {
      id: r.id,
      kind: r.kind,
      category: r.category,
      regionId: r.region_id,
      regionName: r.region_name,
      title: r.title,
      body: r.body,
      price: r.price,
      itemCondition: r.item_condition,
      marketStatus: r.market_status,
      mediaIds: r.media_ids as string[],
      likeCount: r.like_count,
      commentCount: r.comment_count,
      liked: r.liked,
      bookmarked: r.bookmarked,
      mine: r.author_id === viewerId,
      // 고정은 결제한 지역의 목록에서만 위로 올라간다.
      pinned: pinned && (pinRegion === undefined || pinRegion === r.pinned_region_id),
      pinnedUntil: pinned && r.author_id === viewerId ? new Date(r.pinned_until).toISOString() : null,
      author: { userId: r.author_id, nickname: r.nickname, avatarColor: r.avatar_color, photoMediaId: r.author_photo },
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async create(userId: string, body: any) {
    const kind = body?.kind === 'market' ? 'market' : 'board';
    const category = String(body?.category || '');
    if (!(kind === 'board' ? BOARD : MARKET).includes(category)) throw bad('INVALID_INPUT', '분류를 선택해 주세요.');
    const title = str(body?.title, '제목', 2, 60);
    const text = typeof body?.body === 'string' ? body.body.trim().slice(0, 3000) : '';
    if (kind === 'board' && text.length < 1) throw bad('INVALID_INPUT', '내용을 입력해 주세요.');
    this.filter.assertText(title, text); // 게시 전 필터
    const mediaIds: string[] = [...new Set<string>((Array.isArray(body?.mediaIds) ? body.mediaIds : []).filter(isUuid))].slice(0, 5);
    let price: number | null = null;
    let condition: string | null = null;
    if (kind === 'market') {
      price = category === 'free' ? 0 : Math.trunc(Number(body?.price));
      if (!Number.isFinite(price) || price < 0 || price > 100_000_000) throw bad('INVALID_INPUT', '가격을 확인해 주세요.');
      condition = CONDITIONS.includes(body?.itemCondition) ? body.itemCondition : category === 'buy' ? null : '사용감 있음';
    }
    if (!(await this.rl.hit(`post:${userId}`, 20, 3600))) throw tooMany('글을 너무 자주 올리고 있습니다.');
    const id = await this.db.tx(async (q) => {
      const me = await q.one<{ region_id: string }>('SELECT region_id FROM profiles WHERE user_id = $1', [userId]);
      const regionId = body?.regionId ? String(body.regionId) : me!.region_id;
      if (!(await q.one('SELECT 1 FROM regions WHERE id = $1', [regionId]))) throw bad('INVALID_REGION', '지역을 확인해 주세요.');
      await this.media.assertOwned(q, userId, mediaIds, 'post');
      const row = await q.one<{ id: string }>(
        `INSERT INTO posts (author_id, kind, category, region_id, title, body, price, item_condition, market_status, media_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [userId, kind, category, regionId, title, text, price, condition, kind === 'market' ? 'selling' : null, mediaIds],
      );
      return row!.id;
    });
    return this.get(userId, id);
  }

  async list(userId: string, qy: any) {
    const kind = qy.kind === 'market' ? 'market' : 'board';
    const params: unknown[] = [userId, kind];
    const where: string[] = ['p.kind = $2'];
    const add = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const me = await this.db.one<{ region_id: string; sido: string }>('SELECT p.region_id, r.sido FROM profiles p JOIN regions r ON r.id = p.region_id WHERE p.user_id = $1', [userId]);
    let pinRegion: string | null = null;
    if (qy.mine === 'true') where.push(`p.author_id = $1`);
    else if (qy.bookmarked === 'true') where.push(`EXISTS (SELECT 1 FROM post_bookmarks b WHERE b.post_id = p.id AND b.user_id = $1)`);
    else if (qy.authorId && isUuid(qy.authorId)) where.push(`p.author_id = ${add(qy.authorId)}`);
    else if (qy.scope === 'all') {
      /* 전국 */
    } else if (qy.scope === 'sido') where.push(`rg.sido = ${add(me!.sido)}`);
    else {
      pinRegion = qy.regionId ? String(qy.regionId) : me!.region_id;
      where.push(`p.region_id = ${add(pinRegion)}`);
    }
    if (qy.category) where.push(`p.category = ${add(String(qy.category))}`);
    if (qy.marketStatus) where.push(`p.market_status = ${add(String(qy.marketStatus))}`);
    if (typeof qy.q === 'string' && qy.q.trim()) {
      const k = add(`%${qy.q.trim().replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(p.title ILIKE ${k} OR p.body ILIKE ${k})`);
    }
    if (qy.before) where.push(`p.created_at < ${add(new Date(String(qy.before)))}`);
    const pinOrder = pinRegion ? `COALESCE(p.pinned_until > now() AND p.pinned_region_id = ${add(pinRegion)}, false) DESC, ` : '';
    const rows = await this.db.query<any>(`${this.SELECT} AND ${where.join(' AND ')} ORDER BY ${pinOrder}p.created_at DESC LIMIT 30`, params);
    return { items: rows.map((r) => this.map(r, userId, pinRegion)), regionId: pinRegion };
  }

  async get(userId: string, id: string) {
    const r = await this.db.one<any>(`${this.SELECT} AND p.id = $2`, [userId, id]);
    if (!r) throw notFound('글을 찾을 수 없습니다.');
    const comments = await this.db.query<any>(
      `SELECT c.id, c.author_id, c.body, c.created_at, pr.nickname, pr.avatar_color
         FROM post_comments c JOIN users u ON u.id = c.author_id AND u.status = 'active' JOIN profiles pr ON pr.user_id = c.author_id
        WHERE c.post_id = $2 AND c.status = 'visible'
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = c.author_id) OR (b.blocker_id = c.author_id AND b.blocked_id = $1))
        ORDER BY c.created_at LIMIT 300`,
      [userId, id],
    );
    return {
      ...this.map(r, userId),
      comments: comments.map((c) => ({ id: c.id, body: c.body, mine: c.author_id === userId, author: { userId: c.author_id, nickname: c.nickname, avatarColor: c.avatar_color }, createdAt: new Date(c.created_at).toISOString() })),
    };
  }

  private async own(userId: string, id: string) {
    const p = await this.db.one<any>(`SELECT * FROM posts WHERE id = $1 AND author_id = $2 AND status <> 'deleted'`, [id, userId]);
    if (!p) throw notFound('글을 찾을 수 없습니다.');
    return p;
  }

  async update(userId: string, id: string, body: any) {
    const p = await this.own(userId, id);
    const title = body?.title !== undefined ? str(body.title, '제목', 2, 60) : p.title;
    const text = body?.body !== undefined ? String(body.body).trim().slice(0, 3000) : p.body;
    this.filter.assertText(title, text);
    let price = p.price;
    let status = p.market_status;
    if (p.kind === 'market') {
      if (body?.price !== undefined && p.category !== 'free') {
        price = Math.trunc(Number(body.price));
        if (!Number.isFinite(price) || price < 0) throw bad('INVALID_INPUT', '가격을 확인해 주세요.');
      }
      if (body?.marketStatus !== undefined) {
        if (!['selling', 'reserved', 'done'].includes(body.marketStatus)) throw bad('INVALID_INPUT', '거래 상태가 올바르지 않습니다.');
        status = body.marketStatus;
      }
    }
    const cond = body?.itemCondition !== undefined && CONDITIONS.includes(body.itemCondition) ? body.itemCondition : p.item_condition;
    await this.db.query('UPDATE posts SET title = $2, body = $3, price = $4, market_status = $5, item_condition = $6, updated_at = now() WHERE id = $1', [id, title, text, price, status, cond]);
    return this.get(userId, id);
  }

  async remove(userId: string, id: string) {
    await this.own(userId, id);
    await this.db.query(`UPDATE posts SET status = 'deleted', pinned_until = NULL WHERE id = $1`, [id]);
    return { ok: true };
  }

  async comment(userId: string, id: string, body: any) {
    const text = str(body?.body, '댓글', 1, 500);
    this.filter.assertText(text);
    if (!(await this.db.one(`${this.SELECT} AND p.id = $2`, [userId, id]))) throw notFound('글을 찾을 수 없습니다.');
    if (!(await this.rl.hit(`comment:${userId}`, 30, 600))) throw tooMany('댓글을 너무 자주 쓰고 있습니다.');
    await this.db.tx(async (q) => {
      await q.query('INSERT INTO post_comments (post_id, author_id, body) VALUES ($1, $2, $3)', [id, userId, text]);
      await q.query('UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1', [id]);
    });
    // 글쓴이에게 댓글 알림(자기 글·차단 관계는 제외)
    const p = await this.db.one<{ author_id: string; title: string; nickname: string }>(
      `SELECT po.author_id, po.title, pr.nickname FROM posts po, profiles pr
        WHERE po.id = $1 AND pr.user_id = $2 AND po.author_id <> $2
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = po.author_id AND b.blocked_id = $2) OR (b.blocker_id = $2 AND b.blocked_id = po.author_id))`,
      [id, userId],
    );
    if (p) {
      await this.push
        .send([{ userId: p.author_id, kind: 'comment', title: `${p.nickname} 님의 댓글`, body: `${p.title}: ${text.slice(0, 80)}`, privateBody: '내 글에 새 댓글이 달렸습니다.', data: { postId: id } }])
        .catch(() => undefined);
    }
    return this.get(userId, id);
  }

  async removeComment(userId: string, commentId: string) {
    const c = await this.db.one<any>(`UPDATE post_comments SET status = 'deleted' WHERE id = $1 AND author_id = $2 AND status = 'visible' RETURNING post_id`, [commentId, userId]);
    if (!c) throw notFound('댓글을 찾을 수 없습니다.');
    await this.db.query('UPDATE posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [c.post_id]);
    return { ok: true };
  }

  async toggle(userId: string, id: string, what: 'like' | 'bookmark', on: boolean) {
    if (!(await this.db.one(`${this.SELECT} AND p.id = $2`, [userId, id]))) throw notFound('글을 찾을 수 없습니다.');
    await this.db.tx(async (q) => {
      if (what === 'like') {
        const changed = on
          ? await q.one('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [id, userId])
          : await q.one('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING 1', [id, userId]);
        if (changed) await q.query('UPDATE posts SET like_count = GREATEST(like_count + $2, 0) WHERE id = $1', [id, on ? 1 : -1]);
      } else if (on) {
        await q.query('INSERT INTO post_bookmarks (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, userId]);
      } else {
        await q.query('DELETE FROM post_bookmarks WHERE post_id = $1 AND user_id = $2', [id, userId]);
      }
    });
    const r = await this.db.one<any>(`${this.SELECT} AND p.id = $2`, [userId, id]);
    return { liked: r.liked, bookmarked: r.bookmarked, likeCount: r.like_count };
  }

  // ── 유료 상단 고정 ────────────────────────────────────────────────────

  private pinInput(body: any) {
    const days = Math.trunc(Number(body?.days));
    if (!(days >= 1 && days <= 7)) throw bad('INVALID_INPUT', '고정 기간은 1~7일로 선택해 주세요.');
    return days;
  }

  /** 결제 전 안내: 노출 지역, 기간, 소모 포인트 */
  async pinQuote(userId: string, id: string, body: any) {
    const p = await this.own(userId, id);
    const days = this.pinInput(body);
    const region = await this.db.one<{ name: string }>('SELECT name FROM regions WHERE id = $1', [p.region_id]);
    const from = p.pinned_until && new Date(p.pinned_until) > new Date() ? new Date(p.pinned_until) : new Date();
    return { regionId: p.region_id, regionName: region!.name, days, until: new Date(from.getTime() + days * 86400_000).toISOString(), ...(await this.points.quote(this.db, userId, 'post_pin', days)) };
  }

  /**
   * 고정 실행. 포인트 차감과 고정 처리가 한 트랜잭션이다.
   * 중간에 실패하면(글이 숨겨졌거나 삭제된 경우 포함) 차감도 함께 되돌려져 잔액이 그대로 남는다.
   */
  async pin(userId: string, id: string, body: any) {
    const days = this.pinInput(body);
    return this.db.tx(async (q) => {
      const charged = await this.points.charge(q, userId, 'post_pin', days, { type: 'post', id });
      const row = await q.one<{ pinned_until: Date }>(
        `UPDATE posts SET pinned_region_id = region_id,
                pinned_until = GREATEST(COALESCE(pinned_until, now()), now()) + ($3 || ' days')::interval
          WHERE id = $1 AND author_id = $2 AND status = 'visible' RETURNING pinned_until`,
        [id, userId, String(days)],
      );
      if (!row) throw forbidden('PIN_FAILED', '고정할 수 없는 글입니다. 포인트는 차감되지 않았습니다.');
      return { pinnedUntil: new Date(row.pinned_until).toISOString(), cost: charged.cost, balance: charged.balance };
    });
  }

  /** 거래 문의: 상품명과 사진이 붙은 대화 요청을 연다. */
  async inquire(userId: string, id: string, body: any) {
    const r = await this.db.one<any>(`${this.SELECT} AND p.id = $2 AND p.kind = 'market'`, [userId, id]);
    if (!r) throw notFound('글을 찾을 수 없습니다.');
    if (r.author_id === userId) throw bad('INVALID_INPUT', '내가 올린 글입니다.');
    if (r.market_status === 'done') throw bad('TRADE_DONE', '거래가 끝난 글입니다.');
    const text = typeof body?.text === 'string' && body.text.trim() ? body.text : '안녕하세요, 이 물건 문의드립니다.';
    return this.greetings.send(userId, r.author_id, text, { type: 'market', postId: r.id, title: r.title, price: r.price, category: r.category, thumbMediaId: r.media_ids[0] ?? null });
  }
}
