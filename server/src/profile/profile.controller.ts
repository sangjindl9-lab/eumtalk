import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, UserId } from '../common/auth.guard';
import { bad, conflict, forbidden, notFound } from '../common/errors';
import { intIn, optBool, uuid } from '../common/validate';
import { Db } from '../db/db';
import { selectPublicProfiles } from './public-profile';

const NICKNAME = /^[가-힣a-zA-Z0-9_]{2,12}$/;
const AGE_BANDS = ['20대', '30대', '40대', '50대', '60대 이상'];

@Controller('v1')
export class ProfileController {
  constructor(@Inject(Db) private readonly db: Db) {}

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
      `SELECT p.*, r.name AS region_name, r.sido,
              (SELECT updated_at FROM user_locations WHERE user_id = p.user_id) AS location_at,
              ARRAY(SELECT interest_id FROM profile_interests WHERE user_id = p.user_id) AS interest_ids
         FROM profiles p JOIN regions r ON r.id = p.region_id WHERE p.user_id = $1`,
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
      interestIds: r.interest_ids,
      settings: { showInNearby: r.show_in_nearby, showLastActive: r.show_last_active, acceptGreetings: r.accept_greetings },
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
    if (body?.bio !== undefined) set('bio', String(body.bio).trim().slice(0, 300));
    if (body?.gender !== undefined) set('gender', ['male', 'female', 'other'].includes(body.gender) ? body.gender : null);
    if (optBool(body?.genderPublic) !== undefined) set('gender_public', body.genderPublic);
    if (body?.regionId !== undefined) {
      if (!(await this.db.one('SELECT 1 FROM regions WHERE id = $1', [String(body.regionId)]))) throw bad('INVALID_REGION', '활동 지역을 선택해 주세요.');
      set('region_id', String(body.regionId));
    }
    const s = body?.settings || {};
    if (optBool(s.showInNearby) !== undefined) set('show_in_nearby', s.showInNearby);
    if (optBool(s.showLastActive) !== undefined) set('show_last_active', s.showLastActive);
    if (optBool(s.acceptGreetings) !== undefined) set('accept_greetings', s.acceptGreetings);

    await this.db.tx(async (q) => {
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
      // 무료 범위는 내 시·도 안의 지역까지. 다른 시·도 둘러보기는 5단계(포인트·프리미엄)에서 연다.
      const ok = await this.db.one(
        `SELECT 1 FROM regions r JOIN profiles p ON p.user_id = $2 JOIN regions mine ON mine.id = p.region_id
          WHERE r.id = $1 AND r.sido = mine.sido`,
        [String(qy.regionId), userId],
      );
      if (!ok) throw forbidden('OTHER_REGION_LOCKED', '다른 시·도 둘러보기는 준비 중인 기능입니다.');
      regionId = String(qy.regionId);
    }
    const list = (v: unknown) => (typeof v === 'string' && v ? v.split(',').slice(0, 10) : undefined);
    const items = await selectPublicProfiles(this.db, {
      viewerId: userId,
      requireVisible: true,
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
