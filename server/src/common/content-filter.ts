import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { bad } from './errors';

/**
 * 공개 글·프로필에 게시 전 적용하는 텍스트 필터.
 * 성매매·조건만남 유도, 불법 거래, 연락처 노출을 막는다. 금칙어는 BLOCKED_WORDS 환경변수로 추가한다.
 * 공개 사진(프로필·게시글·방 대표 이미지)은 Google Cloud Vision SafeSearch로 게시 전에 판별한다(checkImage).
 */
const BASE_WORDS = ['조건만남', '조건 만남', '성매매', '원나잇', '오피', '출장안마', '출장 마사지', '대포통장', '불법촬영', '몰카 판매', '마약', '필로폰', '토토사이트', '성인방', '애인대행'];
const PHONE = /01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/;
const MESSENGER = /(카톡|카카오톡|텔레그램|텔레|라인)\s*(아이디|id|ID)?\s*[:：]?\s*[A-Za-z0-9_.-]{4,}/;

@Injectable()
export class ContentFilter {
  private readonly words: string[];
  constructor(@Inject(CONFIG) private readonly cfg: AppConfig) {
    this.words = [...BASE_WORDS, ...cfg.blockedWords].map((w) => w.toLowerCase());
  }

  /** 문제가 있으면 사유를, 없으면 null 을 돌려준다. */
  inspectText(...texts: (string | null | undefined)[]): string | null {
    const joined = texts.filter(Boolean).join('\n');
    const lower = joined.toLowerCase();
    const compact = lower.replace(/[\s.\-_*]/g, '');
    for (const w of this.words) {
      if (lower.includes(w) || compact.includes(w.replace(/\s/g, ''))) return '운영 규칙에 어긋나는 표현이 포함되어 있습니다.';
    }
    if (PHONE.test(joined) || MESSENGER.test(joined)) return '공개 글에는 전화번호·메신저 아이디를 적을 수 없습니다.';
    return null;
  }

  assertText(...texts: (string | null | undefined)[]) {
    const reason = this.inspectText(...texts);
    if (reason) throw bad('CONTENT_BLOCKED', reason);
  }

  /**
   * 사진 유해성 판별(Google Cloud Vision SafeSearch).
   *  - 선정성(adult) 가능성 높음 이상, 폭력(violence)·노출(racy) 매우 높음이면 게시를 막는다.
   *  - 판별 서비스에 닿지 못하면 게시를 막는다(운영 중 판별 없이 공개 사진이 올라가는 일이 없도록).
   *  - 키가 없으면 판별 없이 통과하고, 관리자 화면에 설정 누락이 표시된다.
   */
  async checkImage(bytes: Buffer): Promise<{ ok: boolean; reason?: string; result?: Record<string, string> }> {
    const key = this.cfg.vision.apiKey;
    if (!key) return { ok: true };
    let json: any;
    try {
      const res = await fetch(`${this.cfg.vision.apiBase}/v1/images:annotate?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: bytes.toString('base64') }, features: [{ type: 'SAFE_SEARCH_DETECTION' }] }] }),
        signal: AbortSignal.timeout(15000),
      });
      json = await res.json();
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      return { ok: false, reason: '사진 검사를 하지 못했습니다. 잠시 후 다시 올려 주세요.' };
    }
    const a = json?.responses?.[0]?.safeSearchAnnotation;
    if (!a) return { ok: false, reason: '사진 검사를 하지 못했습니다. 잠시 후 다시 올려 주세요.' };
    const level = (v: string) => ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'].indexOf(v);
    const result = { adult: a.adult, violence: a.violence, racy: a.racy, medical: a.medical, spoof: a.spoof };
    if (level(a.adult) >= 4 || level(a.racy) >= 5) return { ok: false, reason: '선정적인 사진은 올릴 수 없습니다.', result };
    if (level(a.violence) >= 5) return { ok: false, reason: '폭력적인 사진은 올릴 수 없습니다.', result };
    return { ok: true, result };
  }
}
