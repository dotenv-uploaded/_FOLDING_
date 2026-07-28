import { useCallback, useEffect, useState } from 'react';
import { KRW_PER_CREDIT, USAGE_KIND_LABEL, type UsagePool, type UsageStatus } from '@contracts';
import { cn } from '@/lib/cn';

/**
 * 지갑 하나를 막대와 숫자로 보여준다.
 *
 * 단위는 **크레딧**이다. 토큰은 사용자의 언어가 아니고("12,400 토큰"이 비싼지 알 수 없다),
 * 원화를 그대로 띄우면 우리 원가가 노출된다. 게다가 모델 단가가 바뀌면 같은 금액이 조용히
 * 더 적은 사용량이 되어 사용자에게는 설명 없는 다운그레이드로 보인다.
 */
function PoolBar({
  label,
  hint,
  used,
  limit,
  blocked,
}: {
  label: string;
  hint?: string;
  used: number;
  limit: number;
  blocked?: boolean;
}) {
  const ratio = limit > 0 ? Math.min(used / limit, 1) : 0;
  const near = ratio >= 0.8;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-ink-700">
          {label}
          {hint && <span className="ml-1.5 font-normal text-ink-400">{hint}</span>}
        </span>
        <span className="font-mono text-2xs text-ink-400 tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-label={label}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-[--dur-base] ease-[--ease-standard]',
            blocked ? 'bg-red-500' : near ? 'bg-amber-500' : 'bg-blue-500',
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * 구독 사용량.
 *
 * 이 화면이 답해야 하는 질문은 하나다 — **"내가 얼마나 썼고 얼마나 남았나."**
 *
 * 지갑은 둘이다. 대화와 문서 분석이 서로의 몫을 갉아먹지 않아야, 폴더를 크게 등록한 날에도
 * 대화가 되고 대화를 많이 한 달에도 새 문서를 넣을 수 있다.
 */
export function UsagePanel() {
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.codegate.usage.status().then((s) => alive && setUsage(s));
    // 대화를 보내거나 문서를 분석할 때마다 바뀐다 — 설정을 다시 열지 않아도 따라가게 한다.
    const off = window.codegate.usage.onChanged((s) => setUsage(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const purchase = useCallback(async (amountKrw: number) => {
    setBusy(true);
    setError(null);
    try {
      setUsage(await window.codegate.usage.purchase(amountKrw));
    } catch (err) {
      setError(err instanceof Error ? err.message : '크레딧을 추가하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!usage) {
    return <p className="text-xs text-ink-400">사용량을 불러오는 중…</p>;
  }

  const pools: UsagePool[] = [usage.pools.chat, usage.pools.build];
  const baseRemaining = pools.reduce((sum, pool) => sum + pool.remainingCredits, 0);
  const remaining = baseRemaining + usage.extraCredits;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-ink-700">이번 달 사용량</span>
        <span className="font-mono text-2xs text-ink-400">{usage.calls.toLocaleString()}회 호출</span>
      </div>

      <div>
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'font-mono text-h3 font-bold tabular-nums',
              usage.blocked ? 'text-red-600' : remaining <= 20 ? 'text-amber-600' : 'text-ink-950',
            )}
          >
            {remaining.toLocaleString()}
          </span>
          <span className="text-sm text-ink-500">크레딧 남음</span>
        </div>
        <p className="mt-1 font-mono text-2xs text-ink-400 tabular-nums">
          {USAGE_KIND_LABEL.chat} {usage.pools.chat.remainingCredits} ·{' '}
          {USAGE_KIND_LABEL.build} {usage.pools.build.remainingCredits}
          {usage.extraCredits > 0 && ` · 추가 ${usage.extraCredits}`} 남음
        </p>
      </div>

      {/*
        지갑을 나눠서 보여준다 — 어느 쪽이 비어 가는지 알아야 무엇을 아낄지 정할 수 있다.
        추가 크레딧은 어느 쪽이든 기본이 떨어진 뒤에 쓰이므로 따로 둔다.
      */}
      <div className="flex flex-col gap-3">
        {pools.map((pool) => (
          <PoolBar
            key={pool.kind}
            label={USAGE_KIND_LABEL[pool.kind]}
            hint={pool.kind === 'build' ? '문서 등록·재분석' : '질문과 답변'}
            used={pool.usedCredits}
            limit={pool.limitCredits}
            blocked={pool.remainingCredits === 0 && usage.extraCredits === 0}
          />
        ))}
        {usage.extraCredits > 0 && (
          <PoolBar
            label="추가 크레딧"
            hint="기본 소진 후 사용"
            used={0}
            limit={usage.extraCredits}
          />
        )}
      </div>

      {usage.blocked && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          대화 크레딧을 모두 썼습니다. 크레딧을 추가하기 전까지 새 질문이 처리되지 않습니다.
        </p>
      )}

      <div className="border-t border-ink-100 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-ink-700">크레딧 추가</span>
          {/*
           * 결제가 아직 없다는 사실을 숨기지 않는다. 이 배지가 없으면 사용자는 카드가
           * 청구된 줄 알게 되고, 그건 화면이 거짓말을 하는 것이다.
           */}
          <span className="rounded-full bg-ink-100 px-2 py-0.5 font-mono text-2xs text-ink-500">
            결제 연동 전
          </span>
        </div>
        <div className="mt-2.5 flex gap-2">
          {[10_000, 20_000, 50_000].map((amount) => (
            <button
              key={amount}
              disabled={busy}
              onClick={() => void purchase(amount)}
              className={cn(
                'flex-1 rounded-md border border-ink-200 bg-white px-3 py-2',
                'font-mono text-xs font-semibold text-ink-800 tabular-nums',
                'transition-colors duration-[--dur-fast] ease-[--ease-standard]',
                'hover:bg-ink-50 active:bg-ink-100 disabled:opacity-55 fold-focus',
              )}
            >
              +{(amount / KRW_PER_CREDIT).toLocaleString()}
            </button>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}
