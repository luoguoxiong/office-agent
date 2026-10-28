/** 自定义下拉框(替代原生 <select>,统一样式 + 键盘导航 + 点击外部关闭)。
 * - 单选:传 options + value + onChange
 * - placeholder:options 里 value="" 的项作为占位提示
 * - 支持 disabled / error 边框态
 * - 键盘:Enter/Space 展开,↑↓ 导航,Enter 选中,Esc 关闭 */
import { useEffect, useRef, useState, KeyboardEvent } from 'react';

export interface DropdownOption {
  value: string;
  label: string;
  /** 可选:标记(如「缺Key」),显示在标签右侧 */
  badge?: string;
  /** 可选:badge 颜色 */
  badgeClass?: string;
}

export function Dropdown({
  options,
  value,
  onChange,
  placeholder,
  disabled,
  error,
  className = '',
  title,
}: {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  error?: boolean;
  className?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 当前选中项的 label
  const selected = options.find((o) => o.value === value);
  const displayLabel = selected?.label ?? placeholder ?? '';

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // 打开时高亮当前选中项
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlightIdx(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  // 高亮项滚动进入可视区
  useEffect(() => {
    if (!open || highlightIdx < 0) return;
    const el = listRef.current?.children[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx, open]);

  const selectOption = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightIdx >= 0) selectOption(options[highlightIdx].value);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={`relative ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'} ${className}`}
      title={title}
    >
      {/* 触发器 */}
      <div
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={open}
        onKeyDown={onKeyDown}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={`w-full flex items-center justify-between gap-1.5 text-xs bg-neutral-900/80 text-neutral-100 border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500/30 transition-colors ${
          error
            ? 'border-red-500/50'
            : open
              ? 'border-blue-500'
              : 'border-white/10 hover:border-white/20'
        }`}
      >
        <span className={`truncate ${selected ? 'text-neutral-100' : 'text-neutral-500'}`}>
          {displayLabel || '\u00A0'}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* 下拉列表 */}
      {open && !disabled && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-50 left-0 right-0 top-full mt-1 max-h-60 overflow-y-auto no-scrollbar rounded-md border border-white/10 bg-neutral-800 shadow-xl shadow-black/40 py-1 animate-fade-in"
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightIdx;
            return (
              <div
                key={opt.value || `empty-${idx}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => selectOption(opt.value)}
                onMouseEnter={() => setHighlightIdx(idx)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs cursor-default transition-colors ${
                  isHighlighted ? 'bg-blue-600/80 text-white' : isSelected ? 'text-blue-300 bg-blue-500/10' : 'text-neutral-200'
                }`}
              >
                <span className="flex-1 truncate">{opt.label}</span>
                {isSelected && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
                {opt.badge && (
                  <span className={`text-[10px] px-1 rounded shrink-0 ${opt.badgeClass ?? 'text-neutral-500'}`}>
                    {opt.badge}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
