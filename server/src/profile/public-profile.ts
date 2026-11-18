import { Q } from '../db/db';

/**
 * 다른 회원에게 보여줄 프로필 조립.
 * 좌표·정밀 거리·휴대폰 번호·실명·생년은 여기서 SELECT 하지 않으므로 API 응답에 섞일 수 없다.
 * 거리는 SQL 안에서 넓은 구간(proximity)으로만 바꿔 내보낸다.
 */
export interface PublicProfile {
  userId: string;
  nickname: string;
  ageBand: string;
  gender: string | null;
  regionName: string;
  bio: string;
  avatarColor: number;
  photoMediaId: string | null;
  interests: string[];
  commonInterests: string[];
  /** visiting = 다른 지역 회원이 이 지역을 둘러보는 중(실제 위치처럼 표시하지 않는다) */
  proximity: 'same_neighborhood' | 'nearby' | 'same_region' | 'same_province' | 'far' | 'visiting';
  activity: 'now' | 'today' | 'week' | 'earlier' | null;
  acceptsGreetings: boolean;
}

export interface ListFilter {
  viewerId: string;
  onlyUserId?: string;
  requireVisible?: boolean;
  scope?: 'near' | 'sido' | 'all';
  regionId?: string;
  ageBands?: string[];
  interestIds?: string[];
  sort?: 'near' | 'recent';
  limit?: number;
  offset?: number;
}

const DIST_KM = `(6371 * 2 * asin(sqrt(
    power(sin(radians(ul.lat - vl.lat) / 2), 2) +
    cos(radians(vl.lat)) * cos(radians(ul.lat)) * power(sin(radians(ul.lng - vl.lng) / 2), 2))))`;

export async function selectPublicProfiles(q: Q, f: ListFilter): Promise<PublicProfile[]> {
  const params: unknown[] = [f.viewerId];
  const where: string[] = [
    `u.status = 'active'`,
    `NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = $1 AND b.blocked_id = p.user_id) OR (b.blocker_id = p.user_id AND b.blocked_id = $1))`,
  ];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.onlyUserId) where.push(`p.user_id = ${add(f.onlyUserId)}`);
  else where.push(`p.user_id <> $1`);
  if (f.requireVisible) where.push(`p.show_in_nearby`);
  if (f.regionId) where.push(`(p.region_id = ${add(f.regionId)} OR (p.browse_until > now() AND p.browse_region_id = $${params.length}))`);
  if (f.ageBands?.length) where.push(`p.age_band = ANY(${add(f.ageBands)}::text[])`);
  if (f.interestIds?.length) {
    where.push(`EXISTS (SELECT 1 FROM profile_interests fi WHERE fi.user_id = p.user_id AND fi.interest_id = ANY(${add(f.interestIds)}::text[]))`);
  }

  // rank: 0 같은 동네, 1 가까운 지역/같은 지역, 2 같은 시·도, 3 그 외
  const inner = `
    SELECT p.user_id, p.nickname, p.age_band, p.bio, p.avatar_color, p.accept_greetings, p.photo_media_id,
           (p.browse_until > now() AND p.browse_region_id = vr.id AND r.id <> vr.id) AS visiting,
           CASE WHEN p.gender_public THEN p.gender END AS gender,
           r.name AS region_name,
           CASE WHEN p.show_last_active THEN p.last_active_at END AS seen_at,
           (r.id = vr.id) AS same_region, (r.sido = vr.sido) AS same_sido,
           CASE WHEN ul.lat IS NOT NULL AND vl.lat IS NOT NULL AND p.show_in_nearby THEN ${DIST_KM} END AS dist
      FROM profiles p
      JOIN users u ON u.id = p.user_id
      JOIN regions r ON r.id = p.region_id
      JOIN profiles vp ON vp.user_id = $1
      JOIN regions vr ON vr.id = vp.region_id
      LEFT JOIN user_locations ul ON ul.user_id = p.user_id
      LEFT JOIN user_locations vl ON vl.user_id = $1
     WHERE ${where.join(' AND ')}`;

  const ranked = `
    SELECT x.*, CASE
        WHEN x.visiting THEN 2
        WHEN x.dist IS NOT NULL AND x.dist < 3 THEN 0
        WHEN x.dist IS NOT NULL AND x.dist < 15 THEN 1
        WHEN x.dist IS NULL AND x.same_region THEN 1
        WHEN x.same_sido THEN 2
        ELSE 3 END AS rank
      FROM (${inner}) x`;

  let scopeWhere = '';
  if (!f.onlyUserId && !f.regionId) {
    if (f.scope === 'near' || !f.scope) scopeWhere = 'WHERE y.rank <= 1 OR y.same_region OR y.visiting';
    else if (f.scope === 'sido') scopeWhere = 'WHERE y.rank <= 2';
  }
  const order =
    f.sort === 'recent'
      ? `ORDER BY y.seen_at DESC NULLS LAST, y.user_id`
      : `ORDER BY y.rank, y.seen_at DESC NULLS LAST, y.user_id`;
  const limit = add(f.limit ?? 30);
  const offset = add(f.offset ?? 0);

  const rows = await q.query<any>(
    `SELECT y.user_id, y.nickname, y.age_band, y.bio, y.avatar_color, y.accept_greetings, y.gender, y.region_name, y.photo_media_id, y.visiting,
            y.rank, (y.dist IS NOT NULL) AS has_dist, y.same_region,
            CASE WHEN y.seen_at IS NULL THEN NULL
                 WHEN y.seen_at > now() - interval '10 minutes' THEN 'now'
                 WHEN y.seen_at > now() - interval '1 day' THEN 'today'
                 WHEN y.seen_at > now() - interval '7 days' THEN 'week'
                 ELSE 'earlier' END AS activity,
            ARRAY(SELECT i.name FROM profile_interests pi JOIN interests i ON i.id = pi.interest_id
                   WHERE pi.user_id = y.user_id ORDER BY i.sort) AS interests,
            ARRAY(SELECT i.name FROM profile_interests pi JOIN interests i ON i.id = pi.interest_id
                   WHERE pi.user_id = y.user_id
                     AND pi.interest_id IN (SELECT interest_id FROM profile_interests WHERE user_id = $1)
                   ORDER BY i.sort) AS common_interests
       FROM (${ranked}) y ${scopeWhere} ${order} LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return rows.map((r) => ({
    userId: r.user_id,
    nickname: r.nickname,
    ageBand: r.age_band,
    gender: r.gender,
    regionName: r.region_name,
    bio: r.bio,
    avatarColor: r.avatar_color,
    photoMediaId: r.photo_media_id,
    interests: r.interests,
    commonInterests: r.common_interests,
    proximity: r.visiting
      ? 'visiting'
      : r.rank === 0 ? 'same_neighborhood' : r.rank === 1 ? (r.has_dist ? 'nearby' : 'same_region') : r.rank === 2 ? 'same_province' : 'far',
    activity: r.activity,
    acceptsGreetings: r.accept_greetings,
  }));
}
