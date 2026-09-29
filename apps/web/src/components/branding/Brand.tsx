import Link from "next/link";
import { LogoMark } from "./LogoMark";

export function Brand({ href }: { href: string }) {
  return (
    <Link href={href} className="brand" aria-label="GetException">
      <LogoMark />
      <span>GetException</span>
    </Link>
  );
}
