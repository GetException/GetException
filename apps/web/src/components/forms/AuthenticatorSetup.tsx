"use client";

import { QRCodeSVG } from "qrcode.react";
import { CopyButton } from "./CopyButton";

export function AuthenticatorSetup({
  secret,
  uri,
}: {
  secret: string;
  uri: string;
}) {
  return (
    <div className="authenticator-setup" data-private>
      <div className="authenticator-qr">
        <QRCodeSVG
          value={uri}
          size={176}
          level="M"
          marginSize={2}
          bgColor="#ffffff"
          fgColor="#0b0c10"
          title="GetException authenticator QR code"
        />
      </div>
      <div className="authenticator-key">
        <span className="muted small">Manual setup key</span>
        <code className="secret">{secret}</code>
        <CopyButton value={secret} label="Copy key" />
      </div>
    </div>
  );
}
