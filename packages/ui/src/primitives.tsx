import { forwardRef } from "react";
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  isLoading?: boolean;
  size?: ButtonSize;
  variant?: ButtonVariant;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      children,
      className,
      disabled,
      isLoading = false,
      size = "medium",
      type = "button",
      variant = "primary",
      ...props
    },
    ref,
  ) {
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        className={classNames("asi-button", className)}
        data-size={size}
        data-variant={variant}
        aria-busy={isLoading || undefined}
        disabled={disabled || isLoading}
      >
        {isLoading ? (
          <span className="asi-button__spinner" aria-hidden="true" />
        ) : null}
        <span className="asi-button__content">{children}</span>
      </button>
    );
  },
);

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, tone = "neutral", ...props },
  ref,
) {
  return (
    <span
      {...props}
      ref={ref}
      className={classNames("asi-badge", className)}
      data-tone={tone}
    />
  );
});

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return (
    <input
      {...props}
      ref={ref}
      type={type}
      className={classNames("asi-input", className)}
    />
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ className, ...props }, ref) {
    return (
      <select
        {...props}
        ref={ref}
        className={classNames("asi-select", className)}
      />
    );
  },
);

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  containerClassName?: string;
}

export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, containerClassName, ...props },
  ref,
) {
  return (
    <div
      className={classNames("asi-table-shell", containerClassName)}
      tabIndex={0}
    >
      <table
        {...props}
        ref={ref}
        className={classNames("asi-table", className)}
      />
    </div>
  );
});

export type TableHeaderProps = HTMLAttributes<HTMLTableSectionElement>;

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  TableHeaderProps
>(function TableHeader({ className, ...props }, ref) {
  return (
    <thead
      {...props}
      ref={ref}
      className={classNames("asi-table__header", className)}
    />
  );
});

export type TableBodyProps = HTMLAttributes<HTMLTableSectionElement>;

export const TableBody = forwardRef<HTMLTableSectionElement, TableBodyProps>(
  function TableBody({ className, ...props }, ref) {
    return (
      <tbody
        {...props}
        ref={ref}
        className={classNames("asi-table__body", className)}
      />
    );
  },
);

export type TableRowProps = HTMLAttributes<HTMLTableRowElement>;

export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(
  function TableRow({ className, ...props }, ref) {
    return (
      <tr
        {...props}
        ref={ref}
        className={classNames("asi-table__row", className)}
      />
    );
  },
);

export interface TableHeadProps extends ThHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(
  function TableHead(
    { className, numeric = false, scope = "col", ...props },
    ref,
  ) {
    return (
      <th
        {...props}
        ref={ref}
        scope={scope}
        className={classNames("asi-table__head", className)}
        data-numeric={numeric || undefined}
      />
    );
  },
);

export interface TableCellProps extends TdHTMLAttributes<HTMLTableCellElement> {
  numeric?: boolean;
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(
  function TableCell({ className, numeric = false, ...props }, ref) {
    return (
      <td
        {...props}
        ref={ref}
        className={classNames("asi-table__cell", className)}
        data-numeric={numeric || undefined}
      />
    );
  },
);

export type TableCaptionProps = HTMLAttributes<HTMLTableCaptionElement>;

export const TableCaption = forwardRef<
  HTMLTableCaptionElement,
  TableCaptionProps
>(function TableCaption({ className, ...props }, ref) {
  return (
    <caption
      {...props}
      ref={ref}
      className={classNames("asi-table__caption", className)}
    />
  );
});

export interface EmptyStateProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  action?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}

export const EmptyState = forwardRef<HTMLElement, EmptyStateProps>(
  function EmptyState(
    { action, className, description, title, ...props },
    ref,
  ) {
    return (
      <section
        {...props}
        ref={ref}
        className={classNames("asi-empty-state", className)}
      >
        <h2 className="asi-empty-state__title">{title}</h2>
        {description ? (
          <div className="asi-empty-state__description">{description}</div>
        ) : null}
        {action ? (
          <div className="asi-empty-state__action">{action}</div>
        ) : null}
      </section>
    );
  },
);

export interface MetricProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  detail?: ReactNode;
  label: ReactNode;
  value: ReactNode;
}

export const Metric = forwardRef<HTMLDivElement, MetricProps>(function Metric(
  { className, detail, label, value, ...props },
  ref,
) {
  return (
    <div {...props} ref={ref} className={classNames("asi-metric", className)}>
      <div className="asi-metric__label">{label}</div>
      <div className="asi-metric__value">{value}</div>
      {detail ? <div className="asi-metric__detail">{detail}</div> : null}
    </div>
  );
});

export interface EvidenceConfidenceProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  label?: ReactNode;
  value: number | null | undefined;
}

function getConfidenceState(value: number | null | undefined): {
  normalized: number | null;
  state: "not-assessed" | "low" | "medium" | "high";
} {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 1) {
    return { normalized: null, state: "not-assessed" };
  }
  if (value < 0.4) return { normalized: value, state: "low" };
  if (value < 0.75) return { normalized: value, state: "medium" };
  return { normalized: value, state: "high" };
}

export const EvidenceConfidence = forwardRef<
  HTMLDivElement,
  EvidenceConfidenceProps
>(function EvidenceConfidence(
  { className, label = "Evidence confidence", value, ...props },
  ref,
) {
  const confidence = getConfidenceState(value);
  const displayValue =
    confidence.normalized == null
      ? "Not assessed"
      : `${Math.round(confidence.normalized * 100)}%`;
  const meterLabel = typeof label === "string" ? label : "Evidence confidence";

  return (
    <div
      {...props}
      ref={ref}
      className={classNames("asi-confidence", className)}
      data-confidence={confidence.state}
    >
      <div className="asi-confidence__header">
        <span className="asi-confidence__label">{label}</span>
        <span className="asi-confidence__value">{displayValue}</span>
      </div>
      {confidence.normalized == null ? (
        <div className="asi-confidence__track" aria-hidden="true" />
      ) : (
        <meter
          className="asi-confidence__meter"
          aria-label={meterLabel}
          min={0}
          max={1}
          low={0.4}
          high={0.75}
          optimum={1}
          value={confidence.normalized}
        />
      )}
    </div>
  );
});

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  label: string;
  showLabel?: boolean;
  tone?: StatusTone;
}

export const StatusDot = forwardRef<HTMLSpanElement, StatusDotProps>(
  function StatusDot(
    { className, label, showLabel = true, tone = "neutral", ...props },
    ref,
  ) {
    return (
      <span
        {...props}
        ref={ref}
        className={classNames("asi-status", className)}
        data-tone={tone}
      >
        <span className="asi-status__dot" aria-hidden="true" />
        <span className={showLabel ? "asi-status__label" : "asi-sr-only"}>
          {label}
        </span>
      </span>
    );
  },
);

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  "aria-label": string;
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  { className, ...props },
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      role="tablist"
      className={classNames("asi-tabs", className)}
    />
  );
});

export interface TabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const Tab = forwardRef<HTMLButtonElement, TabProps>(function Tab(
  { active = false, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      role="tab"
      className={classNames("asi-tab", className)}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
    />
  );
});

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean;
}

export const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(
  function TabPanel({ active = false, className, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        role="tabpanel"
        className={classNames("asi-tab-panel", className)}
        hidden={!active}
        tabIndex={0}
      />
    );
  },
);
