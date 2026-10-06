import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegItem<V> {
  value: V;
  label: ReactNode;
  title?: string;
  /** 준비 중(aria-disabled, 클릭·방향키에서 건너뜀). */
  disabled?: boolean;
}

/**
 * 세그먼트 버튼(DESIGN_SYSTEM §4.3): role=radiogroup 안 role=radio.
 * 포커스는 선택된 항목 하나만 받고(roving tabindex), ←→로 값을 옮긴다.
 */
export function Seg<V extends string | number>({
  items,
  value,
  onChange,
  label,
  className = '',
  disabled = false,
}: {
  items: SegItem<V>[];
  value: V;
  onChange: (v: V) => void;
  label: string;
  className?: string;
  /** 묶음 전체 비활성(예: 실행 중 설정 잠금). */
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cur = Math.max(
    0,
    items.findIndex((it) => it.value === value),
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    const n = items.length;
    const d = e.key === 'ArrowRight' ? 1 : -1;
    let i = cur;
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (!items[i]!.disabled) break;
    }
    onChange(items[i]!.value);
    ref.current?.querySelectorAll<HTMLButtonElement>('button')[i]?.focus();
  };
  return (
    <div
      ref={ref}
      className={`seg ${className}`.trim()}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKey}
    >
      {items.map((it, i) => (
        <button
          key={String(it.value)}
          type="button"
          role="radio"
          aria-checked={i === cur}
          aria-disabled={it.disabled || undefined}
          disabled={disabled}
          tabIndex={i === cur ? 0 : -1}
          title={it.title}
          onClick={() => !disabled && !it.disabled && onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
