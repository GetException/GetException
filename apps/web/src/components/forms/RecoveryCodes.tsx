import { CopyButton } from "./CopyButton";

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="generated-value" data-private>
      <div className="recovery-grid">
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </div>
      <CopyButton value={codes.join("\n")} label="Copy all codes" />
    </div>
  );
}
