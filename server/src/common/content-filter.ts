import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { bad } from './errors';

/**
 * 공개 글·프로필에 게시 전 적용하는 텍스트 필터.
 * 성매매·조건만남 유도, 불법 거래, 연락처 노출을 막는다. 금칙어는 BLOCKED_WORDS 환경변수로 추가한다.
 * 사진 자동 판별은 외부 사업자 연동이 필요하므로 어댑터 자리만 둔다(checkImage).
 */
const BASE_WORDS = ['조건만남', '조건 만남', '성매매', '원나잇', '오피', '출장안마', '출장 마사지', '대포통장', '불법촬영', '몰카 판매', '마약', '필로폰', '토토사이트', '성인방', '애인대행'];
const PHONE = /01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/;
const MESSENGER = /(카톡|카카오톡|텔레그램|텔레|라인)\s*(아이디|id|ID)?\s*[:：]?\s*[A-Za-z0-9_.-]{4,}/;

@Injectable()
export class ContentFilter {
  private readonly words: string[];
  constructor(@Inject(CONFIG) cfg: AppConfig) {
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

  /** 사진 유해성 판별. 사업자 연동 전에는 통과시키고, 신고·관리자 숨김으로 대응한다. */
  async checkImage(_bytes: Buffer): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }
}
