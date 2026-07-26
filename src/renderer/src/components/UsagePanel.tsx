import { useCallback, useEffect, useState } from 'react';
import { usageBreakdown, type UsageBucket, type UsageStatus } from '@contracts';
import { cn } from '@/lib/cn';

/**
 * 사용량 한 칸(기본 또는 추가 크레딧)을 막대와 숫자로 보여준다.
 *
 * 기본 사용량이 **먼저** 소진되고 그 뒤에 추가 크레딧이 준다. 그 순서를 화면에서도 그대로
 * 보이게 해, "기본이 남았는데 왜 크레딧이 줄지?" 같은 혼란이 없게 한다.
 */
function TierBar({
  label,
  hint,
  bucket,
  blocked,
}: {
  label: string;
  hint?: string;
  bucket: UsageBucket;
  blocked?: boolean;
}) {
  const ratio = bucket.limitKrw > 0 ? Math.min(bucket.usedKrw / bucket.limitKrw, 1) : 0;
  const near = ratio >= 0.8;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold text-ink-700">
          {label}
          {hint && <span className="ml-1.5 font-normal text-ink-400">{hint}</span>}
        </span>
        <span className="font-mono text-2xs text-ink-400 tabular-nums">
          {bucket.usedKrw.toLocaleString()} / {bucket.limitKrw.toLocaleString()}원
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-ink-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={bucket.limitKrw}
        aria-valuenow={bucket.usedKrw}
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
 * 이 화면이 답해야 하는 질문은 하나다 — **"내가 얼마나 썼고 얼마나 남았나."** 그래서 남은
 * 금액을 가장 크게 두고, 쓴 금액과 한도는 그 근거로 아래에 둔다.
 *
 * 막대는 장식이 아니다. 숫자만 있으면 "18,400원"이 많은 건지 적은 건지 한눈에 안 온다.
 * 남은 비율이 줄어드는 걸 색으로도 알리되, 색만으로 알리지는 않는다(색각 이상 고려).
 */
export function UsagePanel() {
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.codegate.usage.status().then((s) => alive && setUsage(s));
    // 채팅을 보낼 때마다 사용량이 바뀐다 — 설정을 다시 열지 않아도 따라가게 한다.
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

  const nearLimit = usage.limitKrw + usage.extraKrw > 0
    ? usage.usedKrw / (usage.limitKrw + usage.extraKrw) >= 0.8
    : false;
  // 총액을 기본 → 추가 크레딧 순으로 나눈다(기본이 먼저 소진).
  const { base, credit } = usageBreakdown(usage);

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
              usage.blocked ? 'text-red-600' : nearLimit ? 'text-amber-600' : 'text-ink-950',
            )}
          >
            {Math.max(usage.remainingKrw, 0).toLocaleString()}
          </span>
          <span className="text-sm text-ink-500">원 남음</span>
        </div>
        <p className="mt-1 font-mono text-2xs text-ink-400 tabular-nums">
          기본 {base.remainingKrw.toLocaleString()}
          {credit.limitKrw > 0 && ` · 크레딧 ${credit.remainingKrw.toLocaleString()}`} 남음
        </p>
      </div>

      {/* 기본 사용량과 추가 크레딧을 나눠서 — 기본이 먼저 소진되는 구조를 그대로 보여준다. */}
      <div className="flex flex-col gap-3">
        <TierBar
          label="기본 사용량"
          hint="구독 포함"
          bucket={base}
          blocked={usage.blocked && credit.limitKrw === 0}
        />
        {credit.limitKrw > 0 && (
          <TierBar
            label="추가 크레딧"
            hint="기본 소진 후 사용"
            bucket={credit}
            blocked={usage.blocked}
          />
        )}
      </div>

      {usage.blocked && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">
          한도를 모두 썼습니다. 크레딧을 추가하기 전까지 새 요청이 처리되지 않습니다.
        </p>
      )}
      {!usage.blocked && nearLimit && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-600">
          한도의 80%를 넘겼습니다.
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
              +{(amount / 10_000).toLocaleString()}만
            </button>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  );
}
