import type { Citation } from '@contracts';
import { formatCitation } from '@contracts';

/**
 * 인용 칩 — 클릭하면 원본을 연다 (스펙 v1.3 §1 L1).
 * 표기 형식은 계약의 formatCitation 하나만 쓴다: 【DOC-ID rev.N §섹션】
 */
export function CitationChip({ citation }: { citation: Citation }) {
  const openable = Boolean(citation.sourcePath);

  return (
    <button
      disabled={!openable}
      onClick={() => citation.sourcePath && window.codegate.shell.openOriginal(citation.sourcePath)}
      title={
        openable
          ? `원본 열기 — ${citation.sourcePath}\ngraph ${citation.graphVersion ?? '-'}\nchunk ${citation.chunkId ?? '-'}`
          : '원본 경로를 알 수 없습니다'
      }
      className={
        'inline-flex items-center rounded-full bg-blue-50 px-2.5 py-1 font-mono text-2xs text-blue-600 ' +
        'transition-colors duration-[--dur-fast] ease-[--ease-standard] fold-focus ' +
        (openable
          ? 'cursor-pointer hover:bg-blue-100 active:bg-blue-200'
          : 'cursor-default opacity-70')
      }
    >
      {formatCitation(citation)}
    </button>
  );
}
