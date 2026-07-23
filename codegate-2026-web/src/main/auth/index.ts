import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { shell } from 'electron';
import {
  AUTH_ERROR_MESSAGE,
  AuthError,
  type LoginRequest,
  type Session,
  type Subscription,
} from '@contracts';
import { httpJson, httpRequest, joinUrl } from '@main/net/http';
import { UserFacingError, logError } from '@main/util/errors';
import {
  createOAuthLoopbackReceiver,
  OAuthCancelledError,
  type OAuthLoopbackReceiver,
} from './oauth-loopback';
import type { AuthStorage } from './secret-store';

export { MemoryAuthStorage, SafeStorageAuthStorage } from './secret-store';
export type { AuthStorage } from './secret-store';
export { MemoryLlmKeyStore, SafeStorageLlmKeyStore, LLM_PROVIDERS } from './llm-key';
export type { LlmKeyStore } from './llm-key';

interface AuthMeResponse {
  authenticated: true;
  subject_id: string;
  tenant_id: string;
  email: string | null;
  read_access: string[];
  write_scope: 'none' | 'documents' | 'workspace';
  writable_document_ids: string[];
  provisioned: boolean;
  authz_source: string;
}

interface OAuthStartResponse {
  authorization_url: string;
  state: string;
  expires_at: string;
}

interface OAuthSessionResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

interface StoredOAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type AuthMode = 'local' | 'cloud' | 'google';

export interface AuthServiceOptions {
  authMode?: AuthMode;
  cloudApiUrl: string;
  store: AuthStorage;
  onSessionChanged?: (session: Session) => void;
  openExternal?: (url: string) => Promise<void>;
}

const SESSION_STORAGE_KEY = 'codegate.oauth.session.v1';
const LOGGED_OUT: Session = { authenticated: false };
const LOCAL_SESSION: Session = {
  authenticated: true,
  subjectId: 'local-user',
  tenantId: 'local',
  readAccess: ['public', 'internal'],
  writeScope: 'workspace',
  provisioned: true,
  authzSource: 'local-workspace',
};

export class AuthService {
  private session: Session = LOGGED_OUT;
  private credentials: StoredOAuthSession | null = null;
  /** The registered callback port can serve only one active login attempt. */
  private pendingLogin: OAuthLoopbackReceiver | null = null;

  constructor(private readonly options: AuthServiceOptions) {}

  private get local(): boolean {
    return this.options.authMode !== 'cloud' && this.options.authMode !== 'google';
  }

  async restore(): Promise<Session> {
    if (this.local) return this.setSession(LOCAL_SESSION);
    const stored = await this.readStoredSession();
    if (!stored) return this.setSession(LOGGED_OUT);
    try {
      return await this.establishSession(await this.freshSession(stored));
    } catch (error) {
      logError('auth:restore', error);
      await this.clearCredentials();
      return this.setSession(LOGGED_OUT);
    }
  }

  getSession(): Session {
    return this.session;
  }

  async login(request: LoginRequest): Promise<Session> {
    if (this.local) return this.setSession(LOCAL_SESSION);
    if (request.provider !== 'google') {
      throw new UserFacingError('지원하지 않는 로그인 방식입니다.');
    }

    await this.cancelPendingLogin();
    const receiver = await createOAuthLoopbackReceiver();
    this.pendingLogin = receiver;
    const codeVerifier = randomBytes(48).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    try {
      const started = await httpJson<OAuthStartResponse>(
        joinUrl(this.options.cloudApiUrl, 'auth/google/start'),
        {
          method: 'POST',
          json: {
            redirect_uri: receiver.redirectTo,
            code_challenge: codeChallenge,
          },
          failureMessage: 'Google 로그인을 시작하지 못했습니다.',
        },
      );
      this.assertTrustedAuthorizationUrl(started.authorization_url);
      await (this.options.openExternal ?? shell.openExternal)(started.authorization_url);

      const callback = await receiver.waitForCode();
      if (!safeEqual(callback.state, started.state)) {
        throw new Error('OAuth state가 일치하지 않습니다.');
      }

      const issued = await httpJson<OAuthSessionResponse>(
        joinUrl(this.options.cloudApiUrl, 'auth/google/exchange'),
        {
          method: 'POST',
          json: {
            state: started.state,
            code: callback.code,
            code_verifier: codeVerifier,
          },
          failureMessage: 'Google 로그인을 완료하지 못했습니다.',
        },
      );
      return await this.establishSession(await this.persistIssuedSession(issued));
    } catch (error) {
      if (error instanceof OAuthCancelledError) {
        throw new UserFacingError('로그인이 취소되었습니다.', { cause: error });
      }
      throw new UserFacingError('Google 로그인에 실패했습니다. 다시 시도해 주세요.', {
        cause: error,
      });
    } finally {
      if (this.pendingLogin === receiver) this.pendingLogin = null;
      await receiver.close();
    }
  }

  private async cancelPendingLogin(): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) return;
    this.pendingLogin = null;
    await pending.close().catch((error: unknown) => logError('auth:cancel-pending', error));
  }

  async logout(): Promise<void> {
    if (this.local) {
      this.setSession(LOCAL_SESSION);
      return;
    }
    const stored = this.credentials ?? (await this.readStoredSession());
    if (stored?.accessToken) {
      try {
        await httpRequest(joinUrl(this.options.cloudApiUrl, 'auth/logout'), {
          method: 'POST',
          token: stored.accessToken,
          failureMessage: '로그아웃 요청을 완료하지 못했습니다.',
        });
      } catch (error) {
        logError('auth:logout', error);
      }
    }
    await this.clearCredentials();
    this.setSession(LOGGED_OUT);
  }

  async getToken(): Promise<string> {
    if (this.local) return '';
    const stored = this.credentials ?? (await this.readStoredSession());
    if (!stored) throw new AuthError('unauthenticated', AUTH_ERROR_MESSAGE.unauthenticated);
    try {
      return (await this.freshSession(stored)).accessToken;
    } catch (error) {
      logError('auth:refresh', error);
      await this.clearCredentials();
      this.setSession(LOGGED_OUT);
      throw new AuthError('unauthenticated', AUTH_ERROR_MESSAGE.unauthenticated);
    }
  }

  async ensureActiveSubscription(): Promise<Subscription> {
    if (this.local) return { plan: 'Local', expiresAt: '', active: true };
    await this.getToken();
    if (!this.session.provisioned) {
      throw new AuthError('not_provisioned', AUTH_ERROR_MESSAGE.not_provisioned);
    }
    return { plan: 'CODEGATE', expiresAt: '', active: true };
  }

  async handleAuthError(error: AuthError): Promise<void> {
    if (error.kind === 'unauthenticated') {
      await this.logout();
      return;
    }
    if (error.kind === 'not_provisioned') {
      this.setSession({ ...this.session, provisioned: false, writeScope: 'none' });
    }
  }

  private async freshSession(session: StoredOAuthSession): Promise<StoredOAuthSession> {
    if (session.expiresAt > Date.now() + 60_000) return session;
    const issued = await httpJson<OAuthSessionResponse>(
      joinUrl(this.options.cloudApiUrl, 'auth/refresh'),
      {
        method: 'POST',
        json: { refresh_token: session.refreshToken },
        failureMessage: '로그인 세션을 갱신하지 못했습니다.',
      },
    );
    return this.persistIssuedSession(issued);
  }

  private async persistIssuedSession(issued: OAuthSessionResponse): Promise<StoredOAuthSession> {
    const session = {
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
      expiresAt: Date.now() + issued.expires_in * 1000,
    } satisfies StoredOAuthSession;
    this.credentials = session;
    await this.options.store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    return session;
  }

  private async readStoredSession(): Promise<StoredOAuthSession | null> {
    const value = await this.options.store.getItem(SESSION_STORAGE_KEY);
    if (!value) return null;
    try {
      const parsed = JSON.parse(value) as Partial<StoredOAuthSession>;
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.refreshToken !== 'string' ||
        typeof parsed.expiresAt !== 'number'
      ) {
        throw new Error('Stored OAuth session is invalid');
      }
      this.credentials = parsed as StoredOAuthSession;
      return this.credentials;
    } catch {
      await this.clearCredentials();
      return null;
    }
  }

  private async clearCredentials(): Promise<void> {
    this.credentials = null;
    await this.options.store.clear();
  }

  private async establishSession(session: StoredOAuthSession): Promise<Session> {
    const identity = await httpJson<AuthMeResponse>(joinUrl(this.options.cloudApiUrl, 'auth/me'), {
      token: session.accessToken,
      failureMessage: '계정 권한을 확인하지 못했습니다.',
    });
    return this.setSession({
      authenticated: true,
      email: identity.email ?? undefined,
      subjectId: identity.subject_id,
      tenantId: identity.tenant_id,
      readAccess: identity.read_access,
      writeScope: identity.write_scope,
      writableDocumentIds: identity.writable_document_ids,
      provisioned: identity.provisioned,
      authzSource: identity.authz_source,
    });
  }

  private assertTrustedAuthorizationUrl(value: string): void {
    const authorizationUrl = new URL(value);
    if (
      authorizationUrl.protocol !== 'https:' ||
      authorizationUrl.hostname !== 'accounts.google.com' ||
      authorizationUrl.username ||
      authorizationUrl.password
    ) {
      throw new Error('신뢰할 수 없는 Google authorization URL입니다.');
    }
  }

  private setSession(session: Session): Session {
    this.session = session;
    this.options.onSessionChanged?.(session);
    return session;
  }
}

function safeEqual(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}
