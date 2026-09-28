import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { formatHours, formatMoney, formatRate } from '../engine/money';
import type { PayrollStatus, RuleId, Severity } from '../engine/types';

// ---------------------------------------------------------------------------
// Icons (inline SVG, stroke = currentColor)
// ---------------------------------------------------------------------------

const PATHS: Record<string, string> = {
  overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  payroll: 'M8 3h8l4 4v14H4V3h4zm7 1v4h4M8 12h8M8 16h8M8 8h3',
  import: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3',
  alert: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.5',
  dollar: 'M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  users: 'M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 10a4 4 0 100-8 4 4 0 000 8zm13 10v-2a4 4 0 00-3-3.87M16 2.13a4 4 0 010 7.75',
  book: 'M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3V4zm0 13a3 3 0 013-3h11',
  doc: 'M6 2h9l5 5v15H6V2zm8 0v6h6M9 13h8M9 17h8',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 00-2.2-1.3L14.3 3h-4l-.4 2.4a7.5 7.5 0 00-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.6l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 002.2 1.3l.4 2.4h4l.4-2.4a7.5 7.5 0 002.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z',
  lock: 'M6 11h12v10H6V11zm2 0V7a4 4 0 118 0v4',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  download: 'M12 3v12m0 0l-4-4m4 4l4-4M4 20h16',
  upload: 'M12 21V9m0 0l-4 4m4-4l4 4M4 4h16',
  trash: 'M4 7h16M9 7V4h6v3m-8 0l1 13h8l1-13',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zm10 3l-6-6',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zm0-11v6m0-9v.5',
  file: 'M6 2h9l5 5v15H6V2zm8 0v6h6',
  mail: 'M3 5h18v14H3V5zm0 0l9 8 9-8',
  stamp: 'M8 3h8v5a4 4 0 01-2 3.5V14h5v4H5v-4h5v-2.5A4 4 0 018 8V3zM4 21h16',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zm10-14l4 4',
};

export function Icon({ name, title }: { name: keyof typeof PATHS | string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? PATHS.file} />
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="5" fill="#2f7fb5" />
      <path d="M5 16h14M6 16V9m4 7V7m4 9v-5m4 5V8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Buttons, badges, formatting
// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  icon?: string;
};

export function Button({ variant = 'secondary', size = 'md', icon, className, children, type = 'button', ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'secondary' ? variant : '', size === 'sm' ? 'sm' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function Badge({ tone, children, title }: { tone: 'bad' | 'warn' | 'info' | 'good' | 'neutral' | 'accent'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

export const SEVERITY_TONE: Record<Severity, 'bad' | 'warn' | 'info'> = { violation: 'bad', warning: 'warn', info: 'info' };
export const SEVERITY_LABEL: Record<Severity, string> = { violation: 'Violation', warning: 'Warning', info: 'Note' };

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

export const RULE_LABELS: Record<RuleId, string> = {
  'classification-unmapped': 'Classification not mapped',
  'classification-not-on-wd': 'Classification not on WD',
  'base-rate-below-wd': 'Basic rate below WD',
  'fringe-shortfall': 'Fringe shortfall',
  'overtime-rate': 'Overtime rate',
  'overtime-unreported': 'Overtime paid as straight time',
  'eo-minimum-wage': 'Executive Order minimum',
  'apprentice-unregistered': 'Apprentice not verified',
  'apprentice-rate': 'Apprentice rate',
  'apprentice-ratio': 'Apprentice ratio',
  'hours-arithmetic': 'Hours arithmetic',
  'gross-arithmetic': 'Gross pay arithmetic',
  'net-arithmetic': 'Net pay arithmetic',
  'gross-exceeds-all-work': 'Gross exceeds all work',
  'full-ssn': 'Full SSN shown',
  'soc-missing': 'Statement of Compliance',
  'late-submission': 'Late submission',
  'duplicate-week': 'Duplicate week',
  'payroll-number-gap': 'Payroll number gap',
  'per-day-rate': 'Per-day rate',
  'fringe-footnote': 'Fringe footnote',
  'missing-week': 'Missing payroll',
};

export const PAYROLL_STATUS_LABEL: Record<PayrollStatus, string> = {
  received: 'Not reviewed',
  reviewed: 'Reviewed',
  'correction-requested': 'Correction requested',
  accepted: 'Accepted',
};

export function PayrollStatusBadge({ status }: { status: PayrollStatus }) {
  const tone = status === 'accepted' ? 'good' : status === 'correction-requested' ? 'warn' : status === 'reviewed' ? 'accent' : 'neutral';
  return <Badge tone={tone}>{PAYROLL_STATUS_LABEL[status]}</Badge>;
}

export const Money = ({ value, zero = '—' }: { value: number | null | undefined; zero?: string }) =>
  value === null || value === undefined ? <span className="faint">—</span> : value === 0 && zero !== '$0.00' ? <span className="faint">{zero}</span> : <>{formatMoney(value)}</>;

export const Rate = ({ value }: { value: number | null | undefined }) =>
  value === null || value === undefined ? <span className="faint">—</span> : <>{formatRate(value)}</>;

export const Hours = ({ value }: { value: number }) => (value === 0 ? <span className="faint">0</span> : <>{formatHours(value)}</>);

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="titles">
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, footer, bodyClass = 'panel-body', className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; footer?: ReactNode; bodyClass?: string; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <div className="panel-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
      {footer && <div className="panel-footer">{footer}</div>}
    </section>
  );
}

export function EmptyState({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div>{children}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Alert({ tone, children }: { tone: 'bad' | 'warn' | 'info' | 'good'; children: ReactNode }) {
  return (
    <div className={`alert ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={tone === 'good' ? 'check' : tone === 'info' ? 'info' : 'alert'} />
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <div className="spinner" />
      {label}
    </div>
  );
}

/** A labelled form control. Wrapping the control in the <label> ties the two together for assistive tech. */
export function Field({ label, hint, error, children, className = '' }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Modal (native <dialog>: focus trap, Esc, backdrop handled by the browser)
// ---------------------------------------------------------------------------

export function Modal({ open, title, onClose, children, footer, wide = false }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title}>
      {open && (
        <>
          <div className="modal-header">
            <h2>{title}</h2>
            <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="Close" />
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function ConfirmModal({ open, title, message, confirmLabel = 'Confirm', danger = false, onConfirm, onClose }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'bad';
}

const ToastContext = createContext<(text: string, tone?: 'ok' | 'bad') => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'bad' ? 'bad' : ''}`}>
            <span>{t.text}</span>
            <button onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))} aria-label="Dismiss">✕</button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Trigger a browser download of generated bytes or text. */
export function downloadFile(name: string, data: Uint8Array | Blob | string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : (data as BlobPart)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Open generated bytes (usually a PDF) in a new tab. */
export function openBlob(data: Uint8Array | Blob, type = 'application/pdf'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFileName(s: string): string {
  return s.replace(/[^A-Za-z0-9._ -]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'file';
}

export function FileDrop({ onFiles, accept, children, multiple = true }: { onFiles: (files: File[]) => void; accept?: string; children?: ReactNode; multiple?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone ${over ? 'over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(multiple ? files : files.slice(0, 1));
      }}
    >
      {children}
      <div style={{ marginTop: 12 }}>
        <Button icon="upload" onClick={() => input.current?.click()}>Choose files</Button>
        <input
          ref={input}
          type="file"
          accept={accept}
          multiple={multiple}
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onFiles(files);
          }}
        />
      </div>
    </div>
  );
}
