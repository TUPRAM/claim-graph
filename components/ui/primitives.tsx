import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  TextareaHTMLAttributes
} from "react";

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "subtle";
type ButtonSize = "md" | "sm";

interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

function buildButtonClassName({
  variant = "primary",
  size = "md",
  className
}: ButtonClassOptions) {
  return cx(
    "button",
    variant === "primary" && "button--primary",
    variant === "secondary" && "button--secondary",
    variant === "ghost" && "button--ghost",
    variant === "subtle" && "button--subtle",
    size === "sm" && "button--small",
    className
  );
}

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    ButtonClassOptions {}

export function Button({
  variant,
  size,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      className={buildButtonClassName({ variant, size, className })}
      {...props}
    >
      {children}
    </button>
  );
}

export interface ButtonLinkProps
  extends AnchorHTMLAttributes<HTMLAnchorElement>,
    ButtonClassOptions {
  href: string;
}

export function ButtonLink({
  href,
  variant,
  size,
  className,
  children,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      href={href}
      className={buildButtonClassName({ variant, size, className })}
      {...props}
    >
      {children}
    </Link>
  );
}

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "article" | "div";
  surface?: "default" | "soft" | "flat";
}

export function Card({
  as: Component = "section",
  surface = "default",
  className,
  children,
  ...props
}: PropsWithChildren<CardProps>) {
  return (
    <Component
      className={cx(
        "content-card",
        "ui-card",
        surface === "soft" && "ui-card--soft",
        surface === "flat" && "ui-card--flat",
        className
      )}
      {...props}
    >
      {children}
    </Component>
  );
}

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
}

export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cx("pill", "ui-badge", `ui-badge--${tone}`, className)}
      {...props}
    >
      {children}
    </span>
  );
}

export const StatusPill = Badge;

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("field", className)}>
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx("input", className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("textarea", className)} {...props} />;
}

export function EmptyState({
  title,
  body,
  action,
  className
}: {
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("empty-state", className)}>
      <h2>{title}</h2>
      <p>{body}</p>
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
