import { mergeNotify } from '../push/push.service';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { bad, conflict, forbidden, notFound } from '../common/errors';
import { intIn, optBool, uuid } from '../common/validate';
import { ContentFilter } from '../common/content-filter';
import { Db } from '../db/db';
import { MediaService } from '../media/media.service';
import { selectPublicProfiles } from './public-profile';

const NICKNAME = /^[가-힣a-zA-Z0-9_]{2,12}$/;
const AGE_BANDS = ['20대', '30대', '40대', '50대', '60대 이상'];

@Controller('v1')
export class ProfileController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ContentFilter) private readonly filter: ContentFilter,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  @Get('regions')
  async regions() {
    const rows = await this.db.query('SELECT id, sido, sigungu, name FROM regions ORDER BY sort');
    return { items: rows };
  }

  @Get('interests')
  async interests() {
    return { items: await this.db.query('SELECT id, name FROM interests ORDER BY sort'), ageBands: AGE_BANDS };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@UserId() userId: string) {
    const r = await this.db.one<any>(
      `SELECT p.*, r.name AS region_name, r.sido, u.status AS user_status, u.suspended_until,
              (SELECT name FROM regions WHERE id = p.browse_region_id) AS browse_region_name,
              (SELECT updated_at FROM user_locations WHERE user_id = p.user_id) AS location_at,
              ARRAY(SELECT interest_id FROM profile_interests WHERE user_id = p.user_id) AS interest_ids
         FROM profiles p JOIN regions r ON r.id = p.region_id JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`,
      [userId],
    );
    if (!r) throw notFound();
    return {
      userId,
      nickname: r.nickname,
      ageBand: r.age_band,
      gender: r.gender,
      genderPublic: r.gender_public,
      regionId: r.region_id,
      regionName: r.region_name,
      sido: r.sido,
      bio: r.bio,
      avatarColor: r.avatar_color,
      photoMediaId: r.photo_media_id,
      interestIds: r.interest_ids,
      settings: { showInNearby: r.show_in_nearby, showLastActive: r.show_last_active, acceptGreetings: r.accept_greetings, pushPreview: r.push_preview },
      notify: mergeNotify(r.notify, null),
      leaveFootprints: r.leave_footprints,
      marketingConsentAt: r.marketing_consent_at ? new Date(r.marketing_consent_at).toISOString() : null,
      boostUntil: r.boost_until && new Date(r.boost_until) > new Date() ? new Date(r.boost_until).toISOString() : null,
      vip: !!(await this.db.one(`SELECT 1 FROM subscriptions WHERE user_id = $1 AND status = 'active' AND expires_at > now()`, [r.user_id])),
      browse: r.browse_until && new Date(r.browse_until) > new Date() ? { regionId: r.browse_region_id, regionName: r.browse_region_name, until: new Date(r.browse_until).toISOString() } : null,
      status: r.user_status,
      suspendedUntil: r.suspended_until ? new Date(r.suspended_until).toISOString() : null,
      locationShared: !!r.location_at,
    };
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  async update(@UserId() userId: string, @Body() body: any) {
    const sets: string[] = [];
    const params: unknown[] = [userId];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body?.nickname !== undefined) {
      const n = String(body.nickname).trim();
      if (!NICKNAME.test(n)) throw bad('INVALID_NICKNAME', '닉네임은 한글·영문·숫자·밑줄 2~12자로 입력해 주세요.');
      if (await this.db.one('SELECT 1 FROM profiles WHERE lower(nickname) = lower($1) AND user_id <> $2', [n, userId])) {
        throw conflict('NICKNAME_TAKEN', '이미 사용 중인 닉네임입니다.');
      }
      set('nickname', n);
    }
    if (body?.bio !== undefined) {
      const bio = String(body.bio).trim().slice(0, 300);
      this.filter.assertText(bio); // 공개 프로필 문구도 게시 전 필터를 거친다
      set('bio', bio);
    }
    if (body?.photoMediaId !== undefined) {
      if (body.photoMediaId) await this.media.assertOwned(this.db, userId, [String(body.photoMediaId)], 'profile');
      set('photo_media_id', body.photoMediaId || null);
    }
    if (body?.gender !== undefined) {
      if (!['male', 'female'].includes(body.gender)) throw bad('GENDER_REQUIRED', '성별(남·여)을 선택해 주세요.');
      set('gender', body.gender);
      set('gender_public', true);
    }
    if (body?.regionId !== undefined) {
      if (!(await this.db.one('SELECT 1 FROM regions WHERE id = $1', [String(body.regionId)]))) throw bad('INVALID_REGION', '활동 지역을 선택해 주세요.');
      set('region_id', String(body.regionId));
    }
    const s = body?.settings || {};
    if (optBool(s.showInNearby) !== undefined) set('show_in_nearby', s.showInNearby);
    if (optBool(s.showLastActive) !== undefined) set('show_last_active', s.showLastActive);
    if (optBool(s.acceptGreetings) !== undefined) set('accept_greetings', s.acceptGreetings);
    if (optBool(s.pushPreview) !== undefined) set('push_preview', s.pushPreview);
    if (optBool(s.leaveFootprints) !== undefined) set('leave_footprints', s.leaveFootprints);
    if (body?.notify && typeof body.notify === 'object') {
      const cur = await this.db.one<{ notify: any }>('SELECT notify FROM profiles WHERE user_id = $1', [userId]);
      const before = mergeNotify(cur?.notify, null);
      const next = mergeNotify(cur?.notify, body.notify);
      set('notify', JSON.stringify(next));
      // 광고성 정보 수신 동의·철회 일시를 남긴다(앱이 동의 사실을 안내).
      if (next.marketing !== before.marketing) set('marketing_consent_at', next.marketing ? new Date() : null);
    }

    await this.db.tx(async (q) => {
      if (body?.nickname !== undefined) {
        const cur = await q.one<{ nickname: string }>('SELECT nickname FROM profiles WHERE user_id = $1', [userId]);
        const n = String(body.nickname).trim();
        if (cur && cur.nickname !== n) {
          // 닉네임 이력: 수사기관 요청 시 사건 당시 닉네임으로 회원을 찾을 수 있게 남긴다.
          await q.query('UPDATE nickname_history SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
          await q.query('INSERT INTO nickname_history (user_id, nickname) VALUES ($1, $2)', [userId, n]);
        }
      }
      if (sets.length) await q.query(`UPDATE profiles SET ${sets.join(', ')}, updated_at = now() WHERE user_id = $1`, params);
      if (Array.isArray(body?.interestIds)) {
        const ids = [...new Set<string>(body.interestIds.map(String))].slice(0, 10);
        await q.query('DELETE FROM profile_interests WHERE user_id = $1', [userId]);
        if (ids.length) {
          await q.query(
            'INSERT INTO profile_interests (user_id, interest_id) SELECT $1, id FROM interests WHERE id = ANY($2::text[])',
            [userId, ids],
          );
        }
      }
    });
    return this.me(userId);
  }

  /** '내 주변 찾기'를 켰을 때만 호출된다. 약 500m 격자로 뭉갠 좌표만 저장한다. */
  @Put('me/location')
  @UseGuards(AuthGuard)
  async setLocation(@UserId() userId: string, @Body() body: any) {
    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 32 || lat > 39.5 || lng < 123.5 || lng > 132.5) {
      throw bad('INVALID_LOCATION', '국내 위치만 사용할 수 있습니다. 활동 지역을 직접 선택해 주세요.');
    }
    const snap = (v: number) => Math.round(v / 0.005) * 0.005;
    await this.db.query(
      `INSERT INTO user_locations (user_id, lat, lng) VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()`,
      [userId, snap(lat), snap(lng)],
    );
    return { ok: true };
  }

  @Delete('me/location')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  async clearLocation(@UserId() userId: string) {
    await this.db.query('DELETE FROM user_locations WHERE user_id = $1', [userId]);
    return { ok: true };
  }

  @Get('nearby')
  @UseGuards(AuthGuard)
  async nearby(@UserId() userId: string, @Query() qy: any) {
    const scope = ['near', 'sido', 'all'].includes(qy.scope) ? qy.scope : 'near';
    const limit = intIn(qy.limit, 30, 1, 50);
    const offset = intIn(qy.offset, 0, 0, 5000);
    let regionId: string | undefined;
    if (qy.regionId) {
      // 무료 범위는 내 시·도 안의 지역까지. 다른 시·도는 '다른 지역 둘러보기' 이용 중인 지역만 열린다.
      const ok = await this.db.one(
        `SELECT 1 FROM regions r JOIN profiles p ON p.user_id = $2 JOIN regions mine ON mine.id = p.region_id
          WHERE r.id = $1 AND (r.sido = mine.sido OR (p.browse_region_id = r.id AND p.browse_until > now()))`,
        [String(qy.regionId), userId],
      );
      if (!ok) throw forbidden('OTHER_REGION_LOCKED', '다른 지역 둘러보기 이용권이 필요합니다.');
      regionId = String(qy.regionId);
    }
    const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').slice(0, 10) : undefined);
    const genders = list(qy.genders)?.filter((g) => g === 'male' || g === 'female');
    const items = await selectPublicProfiles(this.db, {
      viewerId: userId,
      requireVisible: true,
      genders: genders?.length ? genders : undefined,
      scope,
      regionId,
      ageBands: list(qy.ageBands),
      interestIds: list(qy.interestIds),
      sort: qy.sort === 'recent' ? 'recent' : 'near',
      limit: limit + 1,
      offset,
    });
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    // 사람이 적을 때 가짜 회원으로 채우지 않고, 범위를 넓히거나 모임을 찾아보도록 안내만 한다.
    const suggestWiden = offset === 0 && page.length < 5 && scope !== 'all' && !regionId;
    return { items: page, hasMore, scope, suggestWiden };
  }

  @Get('users/:id')
  @UseGuards(AuthGuard)
  async user(@UserId() userId: string, @Param('id') idRaw: string) {
    const id = uuid(idRaw, '회원');
    if (id === userId) throw bad('INVALID_INPUT', '내 프로필은 내 정보에서 확인해 주세요.');
    const [profile] = await selectPublicProfiles(this.db, { viewerId: userId, onlyUserId: id, limit: 1 });
    if (!profile) throw notFound('프로필을 볼 수 없는 회원입니다.');
    // 나를 본 사람: 하루 한 줄(방문 기록 남기기를 끈 회원은 남기지 않는다)
    await this.db
      .query(
        `INSERT INTO profile_views (viewer_id, viewed_id, day)
         SELECT $1, $2, (now() AT TIME ZONE 'Asia/Seoul')::date FROM profiles WHERE user_id = $1 AND leave_footprints
         ON CONFLICT (viewed_id, day, viewer_id) DO UPDATE SET at = now()`,
        [userId, id],
      )
      .catch(() => undefined);
    const [low, high] = userId < id ? [userId, id] : [id, userId];
    const conv = await this.db.one<{ id: string }>(
      `SELECT id FROM conversations WHERE type = 'direct' AND user_low = $1 AND user_high = $2`,
      [low, high],
    );
    const g = await this.db.one<{ id: string; sender_id: string }>(
      `SELECT id, sender_id FROM greeting_requests
        WHERE status = 'pending' AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
        ORDER BY created_at LIMIT 1`,
      [userId, id],
    );
    return {
      profile,
      relation: {
        conversationId: conv?.id ?? null,
        pendingGreeting: g ? (g.sender_id === userId ? 'sent' : 'received') : null,
        greetingId: g?.id ?? null,
      },
    };
  }
}
