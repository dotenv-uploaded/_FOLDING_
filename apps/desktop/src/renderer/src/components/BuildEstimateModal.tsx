import { useEffect, useState } from 'react';
import type { BuildEstimate, BuildEstimateEnvelope } from '@contracts';

/**
 * 문서 분석을 시작하기 전에 규모와 예상 크레딧을 보이고 묻는 창.
 *
 * 폴더를 등록하면 그 안의 문서 수만큼 분석이 돈다. **시작한 뒤에 알려주면 이미 늦다** —
 * 크레딧은 그때 다 나가 있다. 그래서 시작 전에 한 번 세우고, 사용자가 정하게 한다.
 *
 * 크레딧은 문서 수로 정해지므로 **어림이 아니라 정확한 값**이다. 문서가 길든 짧든 같은
 * 값이다 — 우리 원가의 출렁임을 사용자에게 떠넘기지 않기 위해서다.
 */
export function BuildEstimateModal() {
  const [pending, setPending] = useState<BuildEstimateEnvelope | null>(null);

  useEffect(() => window.codegate.buildEstimate.onRequest(setPending), []);

  if (!pending) return null;

  const answer = (approved: boolean): void => {
    setPending(null);
    void window.codegate.buildEstimate.respond(pending.id, approved);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/30 px-6">
      <div className="w-full max-w-md rounded-lg border border-ink-150 bg-white p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-ink-900">문서를 분석할까요?</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
          분석해야 내용을 찾고 문서끼리 이어 줄 수 있습니다. 한 번 분석한 문서는 내용이 바뀌지
          않는 한 다시 분석하지 않습니다.
        </p>

        <EstimateRows estimate={pending.estimate} />

        {pending.estimate.credits > pending.estimate.remainingCredits && (
          /* 모자랄 수 있다는 사실을 시작 전에 말한다 — 중간에 멈추는 것보다 낫다. */
          <p className="mt-3 rounded-sm bg-amber-50 px-2.5 py-2 text-2xs leading-relaxed text-amber-700">
            남은 크레딧보다 많이 들 수 있습니다. 모자라면 분석이 중간에 멈추고, 거기까지는
            그대로 남습니다.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => answer(false)}
            className="rounded-md border border-ink-150 px-3 py-1.5 text-xs font-semibold text-ink-600 hover:text-ink-900"
          >
            지금은 안 함
          </button>
          <button
            onClick={() => answer(true)}
            className="rounded-md bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600"
          >
            분석 시작
          </button>
        </div>
      </div>
    </div>
  );
}

function EstimateRows({ estimate }: { estimate: BuildEstimate }) {
  return (
    <dl className="mt-3.5 flex flex-col gap-1.5 rounded-md bg-ink-50 px-3 py-2.5">
      <Row label="이번에 분석할 문서" value={`${estimate.documents.toLocaleString()}개`} />
      {estimate.reused > 0 && (
        // 왜 숫자가 폴더의 문서 수보다 적은지 스스로 설명한다.
        <Row
          label="이미 분석해 건너뜀"
          value={`${estimate.reused.toLocaleString()}개`}
          muted
        />
      )}
      <Row label="드는 크레딧" value={`${estimate.credits}`} strong />
      <Row label="남은 문서 크레딧" value={`${estimate.remainingCredits}`} muted />
    </dl>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={muted ? 'text-2xs text-ink-400' : 'text-2xs text-ink-500'}>{label}</dt>
      <dd
        className={
          strong
            ? 'font-mono text-sm font-semibold text-ink-900'
            : muted
              ? 'font-mono text-2xs text-ink-400'
              : 'font-mono text-xs text-ink-700'
        }
      >
        {value}
      </dd>
    </div>
  );
}
