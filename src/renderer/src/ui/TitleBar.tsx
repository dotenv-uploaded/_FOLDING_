import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Logo } from './Wordmark';

/**
 * 앱 상단 타이틀바.
 *
 * 창 전체 폭을 차지하고, 본문 UI는 **전부 이 아래에서** 시작한다.
 * macOS 는 titleBarStyle: 'hiddenInset' 이라 신호등이 창 안에 떠 있으므로
 * 왼쪽 78px 를 비워 둔다. 바 전체가 드래그 영역이고, 안의 버튼만 예외다.
 */
export function TitleBar({ right, className }: { right?: ReactNode; className?: string }) {
  return (
    <header
      data-drag-region
      className={cn(
        'flex h-[var(--spacing-topbar)] shrink-0 items-center gap-3',
        'border-b border-ink-100 bg-white pl-[78px] pr-4',
        className,
      )}
    >
      <Logo height={22} />
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </header>
  );
}
