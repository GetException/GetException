import Link from "next/link";
import { number } from "../../lib/format";

export function Stat({
  label,
  value,
  caption,
  href,
}: {
  label: string;
  value: number | string;
  caption: string;
  href?: string;
}) {
  const content = (
    <>
      <span>
        {label}
        <span aria-hidden="true">{href ? "↗" : ""}</span>
      </span>
      <strong className={typeof value === "string" ? "stat-text" : undefined}>
        {typeof value === "number" ? number(value) : value}
      </strong>
      <small>{caption}</small>
    </>
  );

  return href ? (
    <Link href={href} className="stat-card">
      {content}
    </Link>
  ) : (
    <article className="stat-card">{content}</article>
  );
}
