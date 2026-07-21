/**
 * L4 — 로그인·구독 (스펙 v1.3 §1 L4).
 * `POST /auth/login` → 토큰을 safeStorage 에 보관, `GET /me/subscription` 으로 플랜·만료 표시.
 * 401/402 는 `AuthError` 로 위로 올려 사용자 문장으로 노출한다 (스펙 v1.3 §5).
 */
import {
  AUTH_ERROR_MESSAGE,
  AuthError,
  type LoginRequest,
  type LoginResponse,
  type Session,
  type Subscription,
  type SubscriptionResponse,
} from '@contracts';
import { httpJson, joinUrl } from '@main/net/http';
import { logError } from '@main/util/errors';
import type { SecretStore } from './secret-store';

export { MemorySecretStore, SafeStorageSecretStore } from './secret-store';
export type { SecretStore, StoredCredentials } from './secret-store';
export { MemoryLlmKeyStore, SafeStorageLlmKeyStore, LLM_PROVIDERS } from './llm-key';
export type { LlmKeyStore } from './llm-key';

export interface AuthServiceOptions {
  backendUrl: string;
  store: SecretStore;
  /** 세션이 바뀌면 렌더러에 `IPC_EVENTS.sessionChanged` 로 알린다. */
  onSessionChanged?: (session: Session) => void;
}

const LOGGED_OUT: Session = { authenticated: false };

export class AuthService {
  private session: Session = LOGGED_OUT;
  private token: string | null = null;

  constructor(private readonly options: AuthServiceOptions) {}

  /** 앱 부팅 시 1회 — 저장된 토큰을 복원하고 구독 상태를 갱신한다. */
  async restore(): Promise<Session> {
    const stored = await this.options.store.read();
    if (!stored) return this.setSession(LOGGED_OUT);
    this.token = stored.token;
    try {
      const subscription = await this.fetchSubscription(stored.token);
      return this.setSession({ authenticated: true, email: stored.email, subscription });
    } catch (err) {
      if (err instanceof AuthError && err.kind === 'unauthenticated') {
        // 토큰이 죽었다 — 조용히 로그인 화면으로 되돌린다
        await this.logout();
        return this.getSession();
      }
      // 구독 조회 실패(네트워크 등)는 로그인 자체를 무효화하지 않는다
      logError('auth:restore', err);
      return this.setSession({ authenticated: true, email: stored.email });
    }
  }

  getSession(): Session {
    return this.session;
  }

  async login(request: LoginRequest): Promise<Session> {
    const response = await httpJson<LoginResponse>(joinUrl(this.options.backendUrl, 'auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      failureMessage: '로그인에 실패했습니다.',
    }).catch((err: unknown) => {
      // 로그인 단계의 401 은 "만료"가 아니라 "자격 불일치"다
      if (err instanceof AuthError && err.kind === 'unauthenticated') {
        throw new AuthError('unauthenticated', '이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      throw err;
    });

    this.token = response.token;
    await this.options.store.write({ token: response.token, email: response.email });

    let subscription: Subscription | undefined;
    try {
      subscription = await this.fetchSubscription(response.token);
    } catch (err) {
      if (err instanceof AuthError && err.kind === 'subscription_expired') {
        // 로그인은 성공했으나 구독이 만료 — 화면에 만료로 표시한다
        subscription = { plan: '만료됨', expiresAt: '', active: false };
      } else {
        logError('auth:login:subscription', err);
      }
    }
    return this.setSession({ authenticated: true, email: response.email, subscription });
  }

  async logout(): Promise<void> {
    this.token = null;
    await this.options.store.clear();
    this.setSession(LOGGED_OUT);
  }

  /** `AgentDeps.auth.getToken` 에 그대로 주입된다. */
  async getToken(): Promise<string> {
    if (this.token) return this.token;
    const stored = await this.options.store.read();
    if (stored?.token) {
      this.token = stored.token;
      return stored.token;
    }
    throw new AuthError('unauthenticated', AUTH_ERROR_MESSAGE.unauthenticated);
  }

  /**
   * 구독이 유효한지 확인한다 (스펙 v1.4 §5 — "구독 검사 시점: 빌드 시작 전 + 앱 시작 시").
   *
   * v1.4 에서 서버와의 통신은 로그인·구독 확인 둘뿐이므로, 여기가 백엔드를 부르는 마지막 지점이다.
   * 실패는 전부 `AuthError` 로 올라가 `AUTH_ERROR_MESSAGE` 한국어 문장으로 노출된다 —
   * 조용히 넘어가면 사용자는 "빌드가 왜 안 되지"만 겪게 된다.
   */
  async ensureActiveSubscription(): Promise<Subscription> {
    const token = await this.getToken(); // 토큰이 없으면 여기서 unauthenticated
    const subscription = await this.fetchSubscription(token);
    this.setSession({ ...this.session, subscription });
    if (!subscription.active) {
      throw new AuthError('subscription_expired', AUTH_ERROR_MESSAGE.subscription_expired);
    }
    return subscription;
  }

  /** 401 을 만나면 세션을 즉시 로그아웃 상태로 되돌린다 (렌더러가 로그인 화면을 띄우도록). */
  async handleAuthError(error: AuthError): Promise<void> {
    if (error.kind === 'unauthenticated') {
      await this.logout();
      return;
    }
    const subscription: Subscription = { plan: '만료됨', expiresAt: '', active: false };
    this.setSession({ ...this.session, subscription });
  }

  private async fetchSubscription(token: string): Promise<Subscription> {
    const res = await httpJson<SubscriptionResponse>(
      joinUrl(this.options.backendUrl, 'me/subscription'),
      { token, failureMessage: '구독 정보를 불러오지 못했습니다.' },
    );
    return { plan: res.plan, expiresAt: res.expiresAt, active: res.active };
  }

  private setSession(session: Session): Session {
    this.session = session;
    this.options.onSessionChanged?.(session);
    return session;
  }
}
