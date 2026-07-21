import { shell } from 'electron';
import { createClient, type Session as SupabaseSession, type SupabaseClient } from '@supabase/supabase-js';
import {
  AUTH_ERROR_MESSAGE,
  AuthError,
  type LoginRequest,
  type Session,
  type Subscription,
} from '@contracts';
import { httpJson, joinUrl } from '@main/net/http';
import { UserFacingError, logError } from '@main/util/errors';
import { createOAuthLoopbackReceiver } from './oauth-loopback';
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

export interface AuthServiceOptions {
  authMode?: 'local' | 'supabase';
  cloudApiUrl: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  store: AuthStorage;
  onSessionChanged?: (session: Session) => void;
  openExternal?: (url: string) => Promise<void>;
}

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
  private readonly client: SupabaseClient | null;

  constructor(private readonly options: AuthServiceOptions) {
    this.client =
      options.authMode !== 'local' && options.supabaseUrl && options.supabasePublishableKey
        ? createClient(options.supabaseUrl, options.supabasePublishableKey, {
            auth: {
              flowType: 'pkce',
              autoRefreshToken: true,
              persistSession: true,
              detectSessionInUrl: false,
              storage: options.store,
            },
          })
        : null;
  }

  async restore(): Promise<Session> {
    if (this.options.authMode === 'local') return this.setSession(LOCAL_SESSION);
    if (!this.client) return this.setSession(LOGGED_OUT);
    const { data, error } = await this.client.auth.getSession();
    if (error || !data.session) {
      if (error) logError('auth:restore', error);
      await this.options.store.clear();
      return this.setSession(LOGGED_OUT);
    }
    try {
      return await this.establishSession(await this.freshSession(data.session));
    } catch (error) {
      logError('auth:restore:identity', error);
      await this.options.store.clear();
      return this.setSession(LOGGED_OUT);
    }
  }

  getSession(): Session {
    return this.session;
  }

  async login(request: LoginRequest): Promise<Session> {
    if (this.options.authMode === 'local') return this.setSession(LOCAL_SESSION);
    const client = this.requireClient();
    const receiver = await createOAuthLoopbackReceiver();
    try {
      const { data, error } = await client.auth.signInWithOAuth({
        provider: request.provider,
        options: { redirectTo: receiver.redirectTo, skipBrowserRedirect: true },
      });
      if (error || !data.url) throw error ?? new Error('OAuth authorization URL is missing');
      this.assertTrustedAuthorizationUrl(data.url);
      await (this.options.openExternal ?? shell.openExternal)(data.url);
      const code = await receiver.waitForCode();
      const exchanged = await client.auth.exchangeCodeForSession(code);
      if (exchanged.error || !exchanged.data.session) {
        throw exchanged.error ?? new Error('OAuth session exchange failed');
      }
      return await this.establishSession(exchanged.data.session);
    } catch (error) {
      throw new UserFacingError('Google 로그인에 실패했습니다. 다시 시도해 주세요.', {
        cause: error,
      });
    } finally {
      await receiver.close();
    }
  }

  async logout(): Promise<void> {
    if (this.options.authMode === 'local') {
      this.setSession(LOCAL_SESSION);
      return;
    }
    if (this.client) {
      const { error } = await this.client.auth.signOut({ scope: 'local' });
      if (error) logError('auth:logout', error);
    }
    await this.options.store.clear();
    this.setSession(LOGGED_OUT);
  }

  async getToken(): Promise<string> {
    if (this.options.authMode === 'local') return '';
    const client = this.requireClient();
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) {
      await this.logout();
      throw new AuthError('unauthenticated', AUTH_ERROR_MESSAGE.unauthenticated);
    }
    const session = await this.freshSession(data.session);
    return session.access_token;
  }

  async ensureActiveSubscription(): Promise<Subscription> {
    if (this.options.authMode === 'local') {
      return { plan: 'Local', expiresAt: '', active: true };
    }
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

  private requireClient(): SupabaseClient {
    if (!this.client) {
      throw new UserFacingError(
        'Supabase 연결 정보가 없습니다. CODEGATE_SUPABASE_URL과 CODEGATE_SUPABASE_PUBLISHABLE_KEY를 설정해 주세요.',
      );
    }
    return this.client;
  }

  private async freshSession(session: SupabaseSession): Promise<SupabaseSession> {
    if ((session.expires_at ?? 0) > Math.floor(Date.now() / 1000) + 60) return session;
    const client = this.requireClient();
    const { data, error } = await client.auth.refreshSession({
      refresh_token: session.refresh_token,
    });
    if (error || !data.session) {
      throw new AuthError('unauthenticated', AUTH_ERROR_MESSAGE.unauthenticated);
    }
    return data.session;
  }

  private async establishSession(session: SupabaseSession): Promise<Session> {
    const identity = await httpJson<AuthMeResponse>(joinUrl(this.options.cloudApiUrl, 'auth/me'), {
      token: session.access_token,
      failureMessage: '계정 권한을 확인하지 못했습니다.',
    });
    return this.setSession({
      authenticated: true,
      email: identity.email ?? session.user.email,
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
    const supabaseUrl = new URL(this.options.supabaseUrl ?? '');
    const localHttp =
      authorizationUrl.protocol === 'http:' &&
      ['127.0.0.1', '::1', 'localhost'].includes(authorizationUrl.hostname);
    if (
      authorizationUrl.origin !== supabaseUrl.origin ||
      (!localHttp && authorizationUrl.protocol !== 'https:')
    ) {
      throw new Error('Supabase returned an untrusted authorization URL');
    }
  }

  private setSession(session: Session): Session {
    this.session = session;
    this.options.onSessionChanged?.(session);
    return session;
  }
}
