import { createSign } from 'crypto';
import { AppConfig } from '../config';
import { AppError, bad } from '../common/errors';
import { googleAccessToken } from '../common/google-auth';

/** 스토어가 확인해 준 거래 한 건. 앱이 보낸 값이 아니라 스토어 응답에서 만든다. */
export interface VerifiedTransaction {
  store: 'google' | 'apple' | 'dev';
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  expiresAt: Date | null; // 구독만
  revoked: boolean; // 환불·취소
  autoRenew: boolean;
  raw: unknown;
}

export interface StoreVerifier {
  verify(input: { productId: string; token: string; subscription: boolean }): Promise<VerifiedTransaction>;
}

/**
 * 개발·스토어 테스트 전 단계용. 토큰 형식: dev|<거래ID>[|<원거래ID>[|<만료 ISO>[|revoked]]]
 * 운영 환경에서는 생성 자체를 거부한다.
 */
class DevVerifier implements StoreVerifier {
  async verify(input: { productId: string; token: string; subscription: boolean }): Promise<VerifiedTransaction> {
    const [tag, tx, orig, exp, flag] = input.token.split('|');
    if (tag !== 'dev' || !tx) throw bad('INVALID_RECEIPT', '영수증을 확인할 수 없습니다.');
    return {
      store: 'dev',
      productId: input.productId,
      transactionId: tx,
      originalTransactionId: orig || tx,
      expiresAt: input.subscription ? new Date(exp || Date.now() + 30 * 86400_000) : null,
      revoked: flag === 'revoked',
      autoRenew: true,
      raw: { dev: true },
    };
  }
}

/** Google Play Developer API (구매 토큰 검증). */
class GoogleVerifier implements StoreVerifier {
  constructor(private readonly cfg: AppConfig) {}
  async verify(input: { productId: string; token: string; subscription: boolean }): Promise<VerifiedTransaction> {
    const { token } = await googleAccessToken(this.cfg.iap.googleServiceAccount!, 'https://www.googleapis.com/auth/androidpublisher');
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${this.cfg.iap.googlePackage}`;
    const headers = { authorization: `Bearer ${token}` };
    if (input.subscription) {
      const res = await fetch(`${base}/purchases/subscriptionsv2/tokens/${encodeURIComponent(input.token)}`, { headers });
      const j: any = await res.json();
      if (!res.ok) throw bad('INVALID_RECEIPT', '구독 영수증을 확인할 수 없습니다.');
      const line = j.lineItems?.[0] ?? {};
      return {
        store: 'google',
        productId: line.productId ?? input.productId,
        transactionId: j.latestOrderId,
        originalTransactionId: String(j.latestOrderId || '').split('..')[0],
        expiresAt: line.expiryTime ? new Date(line.expiryTime) : new Date(),
        revoked: ['SUBSCRIPTION_STATE_REVOKED', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'].includes(j.subscriptionState) || !!j.revocationContext,
        autoRenew: !!line.autoRenewingPlan?.autoRenewEnabled,
        raw: j,
      };
    }
    const res = await fetch(`${base}/purchases/products/${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(input.token)}`, { headers });
    const j: any = await res.json();
    if (!res.ok || j.purchaseState === 2) throw bad('INVALID_RECEIPT', '구매 영수증을 확인할 수 없습니다.');
    // 포인트 상품은 다시 살 수 있도록 소비 처리한다.
    if (j.purchaseState === 0 && j.consumptionState === 0) {
      await fetch(`${base}/purchases/products/${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(input.token)}:consume`, { method: 'POST', headers }).catch(() => undefined);
    }
    return { store: 'google', productId: input.productId, transactionId: j.orderId, originalTransactionId: j.orderId, expiresAt: null, revoked: j.purchaseState === 1, autoRenew: false, raw: j };
  }
}

/** App Store Server API (거래 ID로 서버가 직접 조회). */
class AppleVerifier implements StoreVerifier {
  constructor(private readonly cfg: AppConfig) {}
  private jwt() {
    const { appleIssuerId, appleKeyId, applePrivateKey, appleBundleId } = this.cfg.iap;
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'ES256', kid: appleKeyId, typ: 'JWT' })}.${enc({ iss: appleIssuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1', bid: appleBundleId })}`;
    const sig = createSign('SHA256').update(unsigned).sign({ key: applePrivateKey!.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
    return `${unsigned}.${sig.toString('base64url')}`;
  }
  async verify(input: { productId: string; token: string; subscription: boolean }): Promise<VerifiedTransaction> {
    const host = this.cfg.iap.appleSandbox ? 'api.storekit-sandbox.itunes.apple.com' : 'api.storekit.itunes.apple.com';
    const res = await fetch(`https://${host}/inApps/v1/transactions/${encodeURIComponent(input.token)}`, { headers: { authorization: `Bearer ${this.jwt()}` } });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.signedTransactionInfo) throw bad('INVALID_RECEIPT', '구매 영수증을 확인할 수 없습니다.');
    // Apple 서버에서 TLS로 직접 받은 응답이므로 JWS 본문을 그대로 읽는다.
    const t = JSON.parse(Buffer.from(String(j.signedTransactionInfo).split('.')[1], 'base64url').toString());
    if (t.bundleId !== this.cfg.iap.appleBundleId) throw bad('INVALID_RECEIPT', '다른 앱의 영수증입니다.');
    return {
      store: 'apple',
      productId: t.productId,
      transactionId: String(t.transactionId),
      originalTransactionId: String(t.originalTransactionId),
      expiresAt: t.expiresDate ? new Date(t.expiresDate) : null,
      revoked: !!t.revocationDate,
      autoRenew: true,
      raw: t,
    };
  }
}

export function resolveVerifier(cfg: AppConfig, store: string): StoreVerifier {
  if (cfg.iap.mode === 'dev') {
    if (cfg.appEnv === 'production') throw new AppError(503, 'IAP_NOT_CONFIGURED', '지금은 구매를 처리할 수 없습니다.');
    if (store === 'dev') return new DevVerifier();
    throw new AppError(503, 'IAP_NOT_CONFIGURED', '시험 서버에서는 스토어 결제 검증이 설정되지 않았습니다.');
  }
  if (store === 'google' && cfg.iap.googleServiceAccount && cfg.iap.googlePackage) return new GoogleVerifier(cfg);
  if (store === 'apple' && cfg.iap.applePrivateKey) return new AppleVerifier(cfg);
  throw new AppError(503, 'IAP_NOT_CONFIGURED', '지금은 구매를 처리할 수 없습니다.');
}
