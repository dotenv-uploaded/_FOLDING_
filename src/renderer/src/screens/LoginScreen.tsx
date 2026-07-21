import { useState, type FormEvent } from 'react';
import { FileText, Quote, ShieldCheck } from 'lucide-react';
import type { LoginRequest, Session } from '@contracts';
import { Button } from '@/ui/Button';
import { Field, Input } from '@/ui/Input';
import { Logo, MarkWithText } from '@/ui/Wordmark';

/**
 * L4 로그인.
 * Folding 앱 킷의 split-screen 온보딩 구성을 따른다 —
 * 좌: ink 그라디언트 레일(라디얼 블루 글로우), 우: 폼.
 */
export function LoginScreen({ onLogin }: { onLogin: (req: LoginRequest) => Promise<Session> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onLogin({ email, password });
    } catch (err) {
      // 어떤 실패든 사용자 문장으로 (스펙 v1.3 §5 — silent fail 금지)
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full grid-cols-[1.05fr_1fr] overflow-hidden max-[980px]:grid-cols-1">
      {/* ── 좌: 브랜드 레일 ── */}
      <aside
        className="relative flex flex-col justify-between overflow-hidden p-12 max-[980px]:hidden"
        style={{ background: 'var(--gradient-ink)' }}
        data-drag-region
      >
        {/* 라디얼 블루 글로우 — 은은하게, 강하지 않게 */}
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-[420px] w-[420px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(43,93,253,.55) 0%, transparent 68%)' }}
        />
        <div
          className="pointer-events-none absolute -bottom-32 -left-20 h-[380px] w-[380px] rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(92,134,254,.28) 0%, transparent 70%)' }}
        />

        {/* 어두운 면이라 네이비 워드마크 대신 마크 + 흰 텍스트 조판을 쓴다 */}
        <MarkWithText className="relative" markSize={30} fontSize={24} />

        <div className="relative flex flex-col gap-5">
          <span className="fold-eyebrow text-blue-300">LOCAL DOCUMENT WIKI</span>
          <h1 className="text-h1 font-extrabold leading-tight tracking-tighter text-white">
            문서는 그대로,
            <br />
            답은 근거와 함께.
          </h1>
          <p className="max-w-[460px] text-base leading-relaxed text-ink-300">
            등록한 폴더의 문서를 codegate가 읽어 위키로 정리합니다. 질문하면 원문을 짚어 답하고,
            수정은 승인을 거쳐서만 반영됩니다.
          </p>
        </div>

        <ul className="relative flex flex-col gap-3.5">
          <RailPoint icon={<ShieldCheck size={17} />} text="위키는 이 컴퓨터에만 저장됩니다" />
          <RailPoint icon={<Quote size={17} />} text="모든 답변에 문서·리비전·섹션 인용" />
          <RailPoint icon={<FileText size={17} />} text="원본은 백업 후 원자적으로만 수정" />
        </ul>
      </aside>

      {/* ── 우: 폼 ── */}
      <main className="flex items-center justify-center bg-white px-8" data-drag-region>
        <form onSubmit={submit} className="w-full max-w-[380px]" data-drag-region={undefined}>
          <div className="mb-8 hidden max-[980px]:block">
            <Logo height={26} />
          </div>

          <h2 className="text-h3 font-bold tracking-tight text-ink-950">로그인</h2>
          <p className="mt-2 text-sm text-ink-500">
            codegate 계정으로 로그인하면 문서 빌드를 사용할 수 있어요.
          </p>

          <div className="mt-7 flex flex-col gap-4">
            <Field label="이메일">
              <Input
                type="email"
                autoFocus
                required
                autoComplete="username"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="비밀번호">
              <Input
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-md border border-red-100 bg-red-50 px-3.5 py-3 text-xs text-red-600"
            >
              {error}
            </div>
          )}

          <Button type="submit" size="lg" fullWidth loading={busy} className="mt-6">
            {busy ? '확인하는 중…' : '로그인'}
          </Button>

          <p className="mt-5 text-center text-xs leading-relaxed text-ink-400">
            로그인은 빌드에만 필요합니다.
            <br />
            이미 만들어진 위키는 오프라인에서도 검색·질의할 수 있어요.
          </p>
        </form>
      </main>
    </div>
  );
}

function RailPoint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <li className="flex items-center gap-3 text-sm text-ink-200">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/10 text-blue-300">
        {icon}
      </span>
      {text}
    </li>
  );
}
