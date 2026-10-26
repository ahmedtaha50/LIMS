import React from 'react';

/**
 * Buttons (roadmap M24). `Button` is type="button" unless told otherwise, so a button inside a form never submits it by accident,
 * and `busy` disables it and says so to assistive technology. `IconButton` has no visible text, so its `label` is required: it
 * becomes the accessible name (aria-label) and the tooltip.
 */
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  primary: 'bg-blue-700 text-white hover:bg-blue-800 border border-blue-700',
  secondary: 'bg-white text-slate-800 hover:bg-slate-50 border border-slate-300',
  danger: 'bg-red-700 text-white hover:bg-red-800 border border-red-700',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 border border-transparent',
};
const SIZE: Record<Size, string> = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm' };
const BASE = 'ui-control inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50 disabled:cursor-not-allowed';

export interface ButtonProps {
  children?: React.ReactNode;
  variant?: Variant;
  size?: Size;
  type?: 'button' | 'submit' | 'reset';
  busy?: boolean;
  disabled?: boolean;
  className?: string;
  onClick?: (e: any) => void;
  [attr: string]: any;
}

export function Button({ children, variant = 'secondary', size = 'md', type = 'button', busy = false, disabled, className = '', ...rest }: ButtonProps) {
  return (
    <button type={type} disabled={disabled || busy} aria-busy={busy || undefined} className={`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** The accessible name. Required: an icon alone says nothing to a screen reader. */
  label: string;
  icon: React.ReactNode;
}

export function IconButton({ label, icon, variant = 'ghost', size = 'md', className = '', ...rest }: IconButtonProps) {
  return (
    <Button variant={variant} size={size} aria-label={label} title={label} className={`!px-2 ${className}`} {...rest}>
      <span aria-hidden="true" className="inline-flex">{icon}</span>
    </Button>
  );
}
